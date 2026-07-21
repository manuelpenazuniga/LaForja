/**
 * LA FORJA — POST /api/gauntlet, the streaming adversarial run (doc §7.1).
 *
 * OWNER: Claude owns the isolation envelope, the ndjson scaffolding and the pure
 * lifecycle resolution — those suites are LIVE and must pass today. Codex owns
 * `runGauntletPipeline` and the four `GauntletRouteDeps` stubs; the suites that
 * drive them are written in full and marked `describe.skip`, so the skipped
 * bodies are the punch-list.
 *
 * ---------------------------------------------------------------------------
 * THE TWO CLAIMS THIS FILE EXISTS TO KEEP HONEST
 * ---------------------------------------------------------------------------
 * 1. IT REALLY STREAMS. "Three reviewers attack your item and you watch them
 *    land" is the thing on stage. A route that buffers three results and writes
 *    them in one flush has the same content-type and the same bytes, and the
 *    claim is false. So the assertion is temporal, not structural: a fast
 *    reviewer's line must be readable off the wire WHILE the slow one is still
 *    unresolved.
 *
 * 2. ZERO FINDINGS IS NOT A CLEAN ITEM. Three reviewers that all time out accept
 *    nothing, which looks exactly like an item nobody could fault. Dispatching
 *    GAUNTLET_CLEAN there publishes unexamined work. `gauntletEventFor` is the
 *    gate, and the trap is asserted directly rather than inferred.
 *
 * No network, no database, no API key: prisma is mocked and every dependency is
 * injected through `handleGauntlet`'s second argument.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Type-only imports are erased at compile time, so they cannot defeat the
// `vi.mock` hoisting that the value imports below depend on.
import type {
  GauntletEvent,
  GauntletRouteDeps,
  ModelCallTelemetry,
  RunCompletionRecord,
  RunStartRecord,
  RunStartedEvent,
} from '@/app/api/gauntlet/route';
import type { ItemState } from '@/core/types';
import type { AdjudicatedCheck, AdjudicationResult } from '@/reviewers/adjudication';
import type { OrchestrationResult, ReviewerOutcome } from '@/reviewers/orchestrator';

// ---------------------------------------------------------------------------
// Prisma mock. Declared before the route import so the module graph never
// instantiates a real client.
// ---------------------------------------------------------------------------

const itemFindFirstMock = vi.fn();
const sessionCreateMock = vi.fn();
const sessionFindUniqueMock = vi.fn();

vi.mock('@/db/client', () => ({
  prisma: {
    session: {
      create: (...args: unknown[]) => sessionCreateMock(...args),
      findUnique: (...args: unknown[]) => sessionFindUniqueMock(...args),
    },
    item: {
      findFirst: (...args: unknown[]) => itemFindFirstMock(...args),
    },
  },
  toJson: (value: unknown) => JSON.stringify(value),
  fromJson: (text: string) => JSON.parse(text) as unknown,
}));

const {
  completionOf,
  enterGauntlet,
  gauntletEventFor,
  handleGauntlet,
  resolveGauntletState,
} = await import('@/app/api/gauntlet/route');

const { SESSION_COOKIE, loadIsolationConfig, maxBodyChars, resetRateLimiter } = await import(
  '@/demo/isolation'
);
const { canTransition, reduce } = await import('@/core/stateMachine');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Never hardcode a model id (hard constraint 4) — the tests inject one. */
const REVIEWER_MODEL = process.env.OPENAI_MODEL_TERRA ?? 'test-reviewer-model';
const ADJUDICATOR_MODEL = process.env.OPENAI_MODEL_SOL ?? 'test-adjudicator-model';

const SESSION_ID = 'sess_live';
const OTHER_SESSION_ID = 'sess_other';
const ITEM_ID = 'item_1';
const VERSION_ID = 'ver_1';
const RUN_ID = 'run_1';

const STEM =
  'An urn holds 3 red and 2 blue balls. Two are drawn without replacement. What is P(second is red | first is red)?';
const OPTIONS = ['1/2', '2/4', '1/4', '3/5'];
const CORRECT_KEY = 'A';
const RATIONALE = 'conditioning on the removed ball';

const AMBIGUITY_CONTRACT = {
  interpretation_a: 'the two draws are read as independent',
  interpretation_b: 'the second draw is conditioned on the first',
  answer_a: '3/5',
  answer_b: '1/2',
  evidence: 'the stem never says the first ball is kept out of the urn',
};

const PROBE_CONTRACT = {
  answer_length_flag: false,
  lexical_overlap_flag: false,
  answer_length_ratio: 1.02,
  lexical_overlap_score: 0.11,
};

function outcome(over: Partial<ReviewerOutcome> & Pick<ReviewerOutcome, 'reviewerType'>): ReviewerOutcome {
  return {
    ok: true,
    latencyMs: 40,
    schemaValid: true,
    ...over,
  } as ReviewerOutcome;
}

const AMBIGUITY_OK = outcome({
  reviewerType: 'ambiguity',
  contract: AMBIGUITY_CONTRACT,
  latencyMs: 12,
});
const DISCIPLINE_OK = outcome({
  reviewerType: 'discipline',
  contract: { claim: 'the marked key is correct', verdict: 'correct', citation: null },
  latencyMs: 900,
});
const DISTRACTOR_OK = outcome({
  reviewerType: 'distractor',
  contract: [{ distractor: 'B) 2/4', hypothesized_error: 'unreduced fraction', confidence: 0.6, label: 'hypothesis' }],
  latencyMs: 80,
});
const PROBE_OK = outcome({ reviewerType: 'item_probe', contract: PROBE_CONTRACT, latencyMs: 1 });

function failed(reviewerType: string, kind: 'timeout' | 'error' | 'schema', message: string): ReviewerOutcome {
  return {
    reviewerType,
    ok: false,
    error: message,
    failureKind: kind,
    latencyMs: 45_000,
    schemaValid: false,
  } as ReviewerOutcome;
}

function orchestrationOf(outcomes: ReviewerOutcome[], complete: boolean): OrchestrationResult {
  return {
    config: 'gauntlet',
    outcomes,
    anySucceeded: outcomes.some((o) => o.ok && o.schemaValid && o.reviewerType !== 'item_probe'),
    complete,
    expectedReviewers: ['ambiguity', 'discipline', 'distractor'],
    multiAgentVariant: false,
  };
}

const ACCEPTED_CHECK: AdjudicatedCheck = {
  reviewerType: 'ambiguity',
  verificationKind: 'interpretation',
  checkClass: 'counterexample',
  status: 'accepted',
  contract: AMBIGUITY_CONTRACT,
  schemaValid: true,
  invariantId: 'ambiguity_two_readings_disagree',
  executorVersion: 'solver@1.0.0',
  thresholdVersion: 'thresholds@1.0.0',
};

const REJECTED_PROBE_CHECK: AdjudicatedCheck = {
  reviewerType: 'item_probe',
  verificationKind: 'heuristic',
  checkClass: 'deterministic',
  status: 'rejected',
  contract: PROBE_CONTRACT,
  schemaValid: true,
  invariantId: 'answer_length_flag',
  executorVersion: 'probe@1.0.0',
  thresholdVersion: 'thresholds@1.0.0',
  note: 'Rejected: the deterministic item probe completed and neither threshold was flagged.',
};

function adjudicationOf(
  checks: AdjudicatedCheck[],
  gauntletComplete: boolean,
  incompleteReason?: string,
): AdjudicationResult {
  const accepted = checks.some((check) => check.status === 'accepted');
  return {
    checks,
    nextState: accepted ? 'CHALLENGED' : 'DEFENSE',
    abstained: checks.filter((check) => check.status === 'abstained').length,
    adjudicatorModelId: ADJUDICATOR_MODEL,
    gauntletComplete,
    ...(incompleteReason === undefined ? {} : { incompleteReason }),
  };
}

function telemetry(over: Partial<ModelCallTelemetry> = {}): ModelCallTelemetry {
  return {
    callSite: 'orchestrator',
    modelId: REVIEWER_MODEL,
    modelFamilyOk: true,
    promptVersion: 'ambiguity-v1',
    promptHash: 'deadbeefdeadbeef',
    latencyMs: 12,
    tokensIn: 900,
    tokensOut: 120,
    schemaValid: true,
    raw: '{"interpretation_a":"..."}',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Harness: every dependency injected, nothing real behind it
// ---------------------------------------------------------------------------

interface Harness {
  deps: GauntletRouteDeps;
  runStarts: RunStartRecord[];
  completions: RunCompletionRecord[];
  streamed: ReviewerOutcome[];
}

function harness(overrides: Partial<GauntletRouteDeps> = {}): Harness {
  const runStarts: RunStartRecord[] = [];
  const completions: RunCompletionRecord[] = [];
  const streamed: ReviewerOutcome[] = [];

  const deps: GauntletRouteDeps = {
    reviewerModel: REVIEWER_MODEL,
    adjudicatorModel: ADJUDICATOR_MODEL,
    compliance: true,
    config: 'gauntlet',
    runGauntlet: async ({ onReviewerSettled }) => {
      for (const settled of [AMBIGUITY_OK, DISCIPLINE_OK, DISTRACTOR_OK, PROBE_OK]) {
        streamed.push(settled);
        onReviewerSettled(settled, settled.reviewerType === 'item_probe' ? undefined : telemetry());
      }
      return orchestrationOf([AMBIGUITY_OK, DISCIPLINE_OK, DISTRACTOR_OK, PROBE_OK], true);
    },
    adjudicate: async () => ({
      result: adjudicationOf([ACCEPTED_CHECK, REJECTED_PROBE_CHECK], true),
      telemetry: telemetry({ callSite: 'adjudication', modelId: ADJUDICATOR_MODEL }),
    }),
    createRun: async (record) => {
      runStarts.push(record);
      return { gauntletRunId: RUN_ID };
    },
    completeRun: async (record) => {
      completions.push(record);
    },
    ...overrides,
  };

  return { deps, runStarts, completions, streamed };
}

// ---------------------------------------------------------------------------
// Requests + ndjson reading
// ---------------------------------------------------------------------------

interface RequestOptions {
  cookie?: string | null;
  address?: string;
  raw?: string;
}

function post(body: unknown, options: RequestOptions = {}): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': options.address ?? '203.0.113.7',
  };
  const cookie = options.cookie === undefined ? SESSION_ID : options.cookie;
  if (cookie !== null) headers.cookie = `${SESSION_COOKIE}=${cookie}`;

  return new Request('https://demo.invalid/api/gauntlet', {
    method: 'POST',
    headers,
    body: options.raw ?? JSON.stringify(body),
  });
}

/** Drains the whole ndjson body into parsed events. */
async function allEvents(res: Response): Promise<GauntletEvent[]> {
  const text = await res.text();
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as GauntletEvent);
}

/**
 * Reads the ndjson body ONE LINE AT A TIME. This is the difference between
 * asserting the stream and asserting the transcript: `allEvents` cannot tell a
 * stream from a single flush, and this can.
 */
function lineReader(res: Response): { next: () => Promise<GauntletEvent | null> } {
  const body = res.body;
  if (body === null) throw new Error('the gauntlet response carried no stream');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  return {
    async next(): Promise<GauntletEvent | null> {
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim() !== '') return JSON.parse(line) as GauntletEvent;
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) return null;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
  };
}

async function errorBody(res: Response): Promise<{ code: string; message: string }> {
  const body = (await res.json()) as { error: { code: string; message: string } };
  return body.error;
}

const NOW = new Date('2026-07-21T12:00:00.000Z');

function liveSession(id: string) {
  return {
    id,
    pseudonym: 'MoltenCrucible417',
    createdAt: NOW,
    expiresAt: new Date(Date.now() + 20 * 60_000),
  };
}

function itemRow(state: ItemState, withVersion = true) {
  return {
    id: ITEM_ID,
    sessionId: SESSION_ID,
    state,
    versions: withVersion
      ? [
          {
            id: VERSION_ID,
            versionNumber: 1,
            stem: STEM,
            optionsJson: JSON.stringify(OPTIONS),
            correctKey: CORRECT_KEY,
            authorRationale: RATIONALE,
          },
        ]
      : [],
  };
}

/** Route the item through the ownership filter exactly as prisma would. */
function serveItem(state: ItemState, withVersion = true): void {
  itemFindFirstMock.mockImplementation((args: { where: { id: string; sessionId: string } }) => {
    if (args.where.sessionId !== SESSION_ID || args.where.id !== ITEM_ID) return Promise.resolve(null);
    return Promise.resolve(itemRow(state, withVersion));
  });
}

let mintCounter = 0;

beforeEach(() => {
  resetRateLimiter();
  for (const mock of [itemFindFirstMock, sessionCreateMock, sessionFindUniqueMock]) {
    mock.mockReset();
  }
  mintCounter = 0;
  sessionFindUniqueMock.mockImplementation((args: { where: { id: string } }) =>
    Promise.resolve(args.where.id === SESSION_ID ? liveSession(SESSION_ID) : null),
  );
  sessionCreateMock.mockImplementation(() => {
    mintCounter += 1;
    return Promise.resolve(liveSession(`sess_minted_${mintCounter}`));
  });
  serveItem('DRAFT');
});

// ===========================================================================
// THE TRAP — zero findings is not a clean item (Claude-owned, LIVE)
// ===========================================================================

describe('gauntlet dispatch refuses to call an unexamined item clean', () => {
  it('does NOT dispatch GAUNTLET_CLEAN when all three reviewers failed', () => {
    // Every model reviewer dead, the probe alive, adjudication reached but
    // incomplete. Nothing was accepted — which is exactly what a genuinely
    // clean item also produces.
    const orchestration = orchestrationOf(
      [
        failed('ambiguity', 'timeout', 'Reviewer ambiguity timed out after 45000ms'),
        failed('discipline', 'error', 'provider 503'),
        failed('distractor', 'schema', 'contract invalid after retry'),
        PROBE_OK,
      ],
      false,
    );
    const adjudication = adjudicationOf([REJECTED_PROBE_CHECK], false, 'ambiguity did not complete');

    const completion = completionOf(adjudication);
    expect(completion.accepted).toBe(false);
    expect(completion.complete).toBe(false);

    expect(gauntletEventFor(completion)).toBeNull();
    expect(gauntletEventFor(completion)).not.toBe('GAUNTLET_CLEAN');

    const resolved = resolveGauntletState('GAUNTLET', completion);
    expect(resolved.dispatchedEvent).toBeNull();
    expect(resolved.events).toEqual([]);
    // The item stays where it was. It is neither challenged nor cleared.
    expect(resolved.state).toBe('GAUNTLET');
    expect(orchestration.complete).toBe(false);
  });

  it('proves the state machine alone would NOT have stopped it', () => {
    // GAUNTLET --GAUNTLET_CLEAN--> DEFENSE is a perfectly legal edge. The guard
    // has to live in the route, because `reduce` has no idea whether anything
    // ran. This is why `gauntletEventFor` exists at all.
    expect(canTransition('GAUNTLET', 'GAUNTLET_CLEAN')).toBe(true);
    expect(reduce('GAUNTLET', 'GAUNTLET_CLEAN')).toBe('DEFENSE');
  });

  it('dispatches GAUNTLET_CLEAN only when every stage completed', () => {
    const completion = completionOf(adjudicationOf([REJECTED_PROBE_CHECK], true));
    expect(completion.accepted).toBe(false);
    expect(gauntletEventFor(completion)).toBe('GAUNTLET_CLEAN');

    const resolved = resolveGauntletState('GAUNTLET', completion);
    expect(resolved.dispatchedEvent).toBe('GAUNTLET_CLEAN');
    expect(resolved.state).toBe(reduce('GAUNTLET', 'GAUNTLET_CLEAN'));
    expect(resolved.state).toBe('DEFENSE');
  });

  it('dispatches CHECKS_ACCEPTED whenever adjudication accepted anything', () => {
    const completion = completionOf(adjudicationOf([ACCEPTED_CHECK, REJECTED_PROBE_CHECK], true));
    expect(gauntletEventFor(completion)).toBe('CHECKS_ACCEPTED');

    const resolved = resolveGauntletState('GAUNTLET', completion);
    expect(resolved.state).toBe(reduce('GAUNTLET', 'CHECKS_ACCEPTED'));
    expect(resolved.state).toBe('CHALLENGED');
  });

  it('still challenges on an accepted finding from an INCOMPLETE run', () => {
    // An accepted counterexample is evidence something ran and objected. Losing
    // it because a different reviewer timed out would discard a real finding.
    const completion = completionOf(adjudicationOf([ACCEPTED_CHECK], false, 'distractor did not complete'));
    expect(gauntletEventFor(completion)).toBe('CHECKS_ACCEPTED');
    expect(resolveGauntletState('GAUNTLET', completion).state).toBe('CHALLENGED');
  });

  it('carries the incompleteReason without letting it influence the decision', () => {
    const completion = completionOf(adjudicationOf([], false, 'item_probe did not complete.'));
    expect(completion.incompleteReason).toBe('item_probe did not complete.');
    expect(gauntletEventFor(completion)).toBeNull();
  });
});

describe('gauntlet entry agrees with the lifecycle graph', () => {
  it('submits a DRAFT and leaves a re-run alone', () => {
    const entered = enterGauntlet('DRAFT');
    expect(entered.events).toEqual(['SUBMIT_TO_GAUNTLET']);
    expect(entered.state).toBe(reduce('DRAFT', 'SUBMIT_TO_GAUNTLET'));
    expect(entered.state).toBe('GAUNTLET');

    expect(enterGauntlet('GAUNTLET')).toEqual({ state: 'GAUNTLET', events: [] });
  });

  it('composes submission and verdict for a first run', () => {
    const resolved = resolveGauntletState('DRAFT', completionOf(adjudicationOf([ACCEPTED_CHECK], true)));
    expect(resolved.events).toEqual(['SUBMIT_TO_GAUNTLET', 'CHECKS_ACCEPTED']);
    expect(resolved.state).toBe('CHALLENGED');
  });

  it('rejects a state with no gauntlet to run as a 400, not a 500', () => {
    for (const state of ['CHALLENGED', 'REGRESSION', 'DEFENSE', 'DEFENSE_INCONCLUSIVE', 'PUBLISHED', 'DISPUTED'] as const) {
      let status: number | undefined;
      try {
        enterGauntlet(state);
      } catch (err) {
        status = (err as { status: number }).status;
      }
      expect(status, `enterGauntlet('${state}') did not raise a typed 400`).toBe(400);
    }
  });
});

// ===========================================================================
// The isolation envelope (Claude-owned, LIVE)
// ===========================================================================

describe('the isolation envelope', () => {
  it('rejects a malformed JSON body with a typed 400', async () => {
    const res = await handleGauntlet(post(null, { raw: '{not json' }), harness().deps);
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe('invalid_json');
  });

  it('rejects a missing or over-long itemId', async () => {
    for (const body of [{}, { itemId: '' }, { itemId: 'x'.repeat(65) }]) {
      const res = await handleGauntlet(post(body), harness().deps);
      expect(res.status).toBe(400);
      expect((await errorBody(res)).code).toBe('invalid_body');
    }
  });

  it('rejects unknown fields rather than silently ignoring them', async () => {
    // A caller must not be able to smuggle a session id or a model override in.
    const res = await handleGauntlet(
      post({ itemId: ITEM_ID, sessionId: OTHER_SESSION_ID, model: 'gpt-4' }),
      harness().deps,
    );
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe('invalid_body');
  });

  it('refuses an oversized raw body with 413 before parsing it', async () => {
    const cap = maxBodyChars(loadIsolationConfig());
    const h = harness();
    const res = await handleGauntlet(post(null, { raw: 'x'.repeat(cap + 1) }), h.deps);

    expect(res.status).toBe(413);
    expect((await errorBody(res)).code).toBe('input_too_large');
    // Nothing was spent and nothing was looked up.
    expect(h.runStarts).toHaveLength(0);
    expect(itemFindFirstMock).not.toHaveBeenCalled();
  });

  it('rate limits a cookie-less flood with a typed 429', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 14; i += 1) {
      const res = await handleGauntlet(
        post({ itemId: ITEM_ID }, { cookie: null, address: '198.51.100.9' }),
        harness().deps,
      );
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
  });

  it('answers another visitor item with 404 and leaks nothing about it', async () => {
    sessionFindUniqueMock.mockImplementation((args: { where: { id: string } }) =>
      Promise.resolve(args.where.id === OTHER_SESSION_ID ? liveSession(OTHER_SESSION_ID) : null),
    );
    const h = harness();
    const res = await handleGauntlet(post({ itemId: ITEM_ID }, { cookie: OTHER_SESSION_ID }), h.deps);

    expect(res.status).toBe(404);
    const text = JSON.stringify(await res.json());
    // A 404 rather than a 403: the endpoint does not confirm the id exists.
    expect(text).not.toContain(STEM);
    expect(text).not.toContain(SESSION_ID);
    expect(h.runStarts).toHaveLength(0);
  });

  it('replaces an expired session instead of resurrecting it', async () => {
    sessionFindUniqueMock.mockResolvedValue({
      id: SESSION_ID,
      pseudonym: 'QuietForge321',
      createdAt: new Date(Date.now() - 60 * 60_000),
      expiresAt: new Date(Date.now() - 60_000),
    });
    const res = await handleGauntlet(post({ itemId: ITEM_ID }), harness().deps);

    expect(sessionCreateMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(404);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).not.toContain(SESSION_ID);
    expect(JSON.stringify(await res.json())).not.toContain(STEM);
  });

  it('404s when the item has no version to review', async () => {
    serveItem('DRAFT', false);
    const res = await handleGauntlet(post({ itemId: ITEM_ID }), harness().deps);
    expect(res.status).toBe(404);
    expect((await errorBody(res)).code).toBe('not_found');
  });

  it('400s when the item is not at the gauntlet stage, BEFORE opening the stream', async () => {
    serveItem('CHALLENGED');
    const h = harness();
    const res = await handleGauntlet(post({ itemId: ITEM_ID }), h.deps);

    // A real status code, not a 200 carrying an error line: the client can
    // branch on it, and no GauntletRun row was created.
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(h.runStarts).toHaveLength(0);
  });

  it('opens the stream with ndjson, no-store and a session cookie', async () => {
    const res = await handleGauntlet(post({ itemId: ITEM_ID }), harness().deps);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    expect(res.headers.get('cache-control')).toBe('no-store');
    // Proxy buffering would silently turn the stream back into one flush.
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(res.headers.get('set-cookie')).toContain(SESSION_COOKIE);
    await res.text();
  });
});

// ===========================================================================
// The ndjson scaffolding (Claude-owned, LIVE)
// ===========================================================================

describe('the stream is well formed and contained', () => {
  it('emits run_started first, with the compliance record', async () => {
    const events = await allEvents(await handleGauntlet(post({ itemId: ITEM_ID }), harness().deps));
    const first = events[0] as RunStartedEvent | undefined;

    expect(first?.type).toBe('run_started');
    expect(first?.itemId).toBe(ITEM_ID);
    expect(first?.itemVersionId).toBe(VERSION_ID);
    expect(first?.versionNumber).toBe(1);
    expect(first?.config).toBe('gauntlet');
    // The EXACT ids are the compliance evidence this stage exists to show.
    expect(first?.reviewerModel).toBe(REVIEWER_MODEL);
    expect(first?.adjudicatorModel).toBe(ADJUDICATOR_MODEL);
    expect(first?.compliance).toBe(true);
  });

  it('reports a non-compliant model configuration as compliance:false', async () => {
    const h = harness({ compliance: false, reviewerModel: 'gpt-4o-mini' });
    const events = await allEvents(await handleGauntlet(post({ itemId: ITEM_ID }), h.deps));
    expect((events[0] as RunStartedEvent).compliance).toBe(false);
  });

  it('every line is a complete JSON object terminated by a newline', async () => {
    const res = await handleGauntlet(post({ itemId: ITEM_ID }), harness().deps);
    const text = await res.text();

    expect(text.endsWith('\n')).toBe(true);
    for (const line of text.split('\n').filter((l) => l !== '')) {
      expect(() => JSON.parse(line)).not.toThrow();
      expect(line).not.toContain('\n');
    }
  });

  /**
   * NOTHING THROWS OUT OF THIS ROUTE, ever. Today the Codex pipeline stub
   * rejects and the failure arrives as a terminal `error` event; once it is
   * implemented the same run ends in `run_completed`. Both are acceptable
   * terminals — what must never happen is a rejected promise, an unterminated
   * stream, or a status other than 200 after the headers are out.
   */
  it('always terminates the stream and never rejects', async () => {
    const res = await handleGauntlet(post({ itemId: ITEM_ID }), harness().deps);
    const events = await allEvents(res);

    expect(res.status).toBe(200);
    expect(events.length).toBeGreaterThan(0);
    expect(['run_completed', 'error']).toContain(events[events.length - 1]?.type);
  });

  it('leaks no session id, pseudonym or credential onto the wire', async () => {
    const SENTINEL = ['sk', 'live', 'should', 'never', 'surface'].join('-');
    const h = harness({
      createRun: async () => {
        throw new Error(`persistence exploded: key ${SENTINEL}`);
      },
    });
    const text = await (await handleGauntlet(post({ itemId: ITEM_ID }), h.deps)).text();

    for (const forbidden of [SESSION_ID, 'MoltenCrucible417', 'pseudonym', SENTINEL]) {
      expect(text, `the gauntlet stream leaked ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// ===========================================================================
// CODEX PUNCH-LIST — the pipeline and the four persistence deps
// ===========================================================================

/**
 * Everything below drives `runGauntletPipeline` through injected fakes. Unskip
 * as src/app/api/gauntlet/route.ts is filled in.
 */
describe('the streaming pipeline (Codex)', () => {
  // -------------------------------------------------------------------------
  // 1. It really streams
  // -------------------------------------------------------------------------

  it('emits a fast reviewer BEFORE a slow one has resolved', async () => {
    let releaseSlow: () => void = () => {};
    let slowResolved = false;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = () => {
        slowResolved = true;
        resolve();
      };
    });

    const h = harness({
      runGauntlet: async ({ onReviewerSettled }) => {
        // The fast lane lands immediately...
        onReviewerSettled(AMBIGUITY_OK, telemetry());
        // ...and the slow one is still in flight.
        await slow;
        onReviewerSettled(DISCIPLINE_OK, telemetry({ promptVersion: 'discipline-v1' }));
        onReviewerSettled(DISTRACTOR_OK, telemetry({ promptVersion: 'distractor-v1' }));
        onReviewerSettled(PROBE_OK);
        return orchestrationOf([AMBIGUITY_OK, DISCIPLINE_OK, DISTRACTOR_OK, PROBE_OK], true);
      },
    });

    const res = await handleGauntlet(post({ itemId: ITEM_ID }), h.deps);
    const lines = lineReader(res);

    const started = await lines.next();
    expect(started?.type).toBe('run_started');

    // THE ASSERTION. This line must be readable off the wire while the slow
    // reviewer is unresolved. A buffered implementation blocks here forever.
    const fast = await lines.next();
    expect(fast?.type).toBe('reviewer_result');
    expect(fast).toMatchObject({ reviewerType: 'ambiguity', ok: true, degraded: false });
    expect(slowResolved, 'the fast lane was only emitted after the slow one finished').toBe(false);

    releaseSlow();
    const rest: GauntletEvent[] = [];
    for (;;) {
      const event = await lines.next();
      if (event === null) break;
      rest.push(event);
    }
    expect(rest.map((e) => e.type)).toContain('run_completed');
  });

  it('carries the parsed contract and the latency on each lane', async () => {
    const events = await allEvents(await handleGauntlet(post({ itemId: ITEM_ID }), harness().deps));
    const lanes = events.filter((e) => e.type === 'reviewer_result');

    expect(lanes).toHaveLength(4); // three reviewers + the deterministic probe
    expect(lanes.map((lane) => (lane as { reviewerType: string }).reviewerType)).toEqual([
      'ambiguity',
      'discipline',
      'distractor',
      'item_probe',
    ]);
    expect(lanes[0]).toMatchObject({
      contract: AMBIGUITY_CONTRACT,
      schemaValid: true,
      latencyMs: AMBIGUITY_OK.latencyMs,
    });
  });

  // -------------------------------------------------------------------------
  // 2. A partial failure degrades one lane and completes the run
  // -------------------------------------------------------------------------

  it('emits a degraded lane for a dead reviewer and still completes', async () => {
    const dead = failed('discipline', 'timeout', 'Reviewer discipline timed out after 45000ms');
    const h = harness({
      runGauntlet: async ({ onReviewerSettled }) => {
        onReviewerSettled(AMBIGUITY_OK, telemetry());
        onReviewerSettled(dead);
        onReviewerSettled(DISTRACTOR_OK, telemetry({ promptVersion: 'distractor-v1' }));
        onReviewerSettled(PROBE_OK);
        return orchestrationOf([AMBIGUITY_OK, dead, DISTRACTOR_OK, PROBE_OK], false);
      },
      adjudicate: async () => ({
        result: adjudicationOf([ACCEPTED_CHECK], false, 'discipline did not complete'),
        telemetry: telemetry({ callSite: 'adjudication', modelId: ADJUDICATOR_MODEL }),
      }),
    });

    const res = await handleGauntlet(post({ itemId: ITEM_ID }), h.deps);
    const events = await allEvents(res);

    expect(res.status).toBe(200);
    const degraded = events.find(
      (e) => e.type === 'reviewer_result' && (e as { reviewerType: string }).reviewerType === 'discipline',
    );
    expect(degraded).toMatchObject({
      ok: false,
      degraded: true,
      schemaValid: false,
      failureKind: 'timeout',
    });
    expect((degraded as { error?: string }).error).toContain('timed out');

    // The surviving lanes still landed, and the run still finished.
    expect(events.filter((e) => e.type === 'reviewer_result')).toHaveLength(4);
    expect(events[events.length - 1]?.type).toBe('run_completed');
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('never throws out of the route when every reviewer dies', async () => {
    const dead = [
      failed('ambiguity', 'error', 'provider 503'),
      failed('discipline', 'timeout', 'timed out'),
      failed('distractor', 'schema', 'contract invalid after retry'),
    ];
    const h = harness({
      runGauntlet: async ({ onReviewerSettled }) => {
        for (const outcomeOf of [...dead, PROBE_OK]) onReviewerSettled(outcomeOf);
        return orchestrationOf([...dead, PROBE_OK], false);
      },
      adjudicate: async () => ({
        result: adjudicationOf([REJECTED_PROBE_CHECK], false, 'ambiguity did not complete'),
      }),
    });

    const res = await handleGauntlet(post({ itemId: ITEM_ID }), h.deps);
    const events = await allEvents(res);

    expect(res.status).toBe(200);
    const completed = events[events.length - 1] as { type: string; state: ItemState; dispatchedEvent: unknown };
    expect(completed.type).toBe('run_completed');
    // THE TRAP, end to end: no event, and the item did not advance.
    expect(completed.dispatchedEvent).toBeNull();
    expect(completed.state).toBe('GAUNTLET');
  });

  // -------------------------------------------------------------------------
  // 3. Adjudication reaches the wire
  // -------------------------------------------------------------------------

  it('emits the adjudicated checks with their completeness flag', async () => {
    const events = await allEvents(await handleGauntlet(post({ itemId: ITEM_ID }), harness().deps));
    const adjudication = events.find((e) => e.type === 'adjudication') as
      | { checks: unknown[]; nextState: string; abstained: number; gauntletComplete: boolean }
      | undefined;

    expect(adjudication?.checks).toHaveLength(2);
    expect(adjudication?.nextState).toBe('CHALLENGED');
    expect(adjudication?.abstained).toBe(0);
    expect(adjudication?.gauntletComplete).toBe(true);
    expect(adjudication?.checks[0]).toMatchObject({
      reviewerType: 'ambiguity',
      verificationKind: 'interpretation',
      checkClass: 'counterexample',
      status: 'accepted',
      schemaValid: true,
    });
  });

  it('states WHY a run was incomplete instead of leaving it to be inferred', async () => {
    const h = harness({
      adjudicate: async () => ({
        result: adjudicationOf([], false, 'item_probe did not complete.'),
      }),
    });
    const events = await allEvents(await handleGauntlet(post({ itemId: ITEM_ID }), h.deps));
    const adjudication = events.find((e) => e.type === 'adjudication') as
      | { gauntletComplete: boolean; incompleteReason?: string }
      | undefined;

    expect(adjudication?.gauntletComplete).toBe(false);
    expect(adjudication?.incompleteReason).toBe('item_probe did not complete.');
  });

  // -------------------------------------------------------------------------
  // 4. Persistence
  // -------------------------------------------------------------------------

  it('creates the GauntletRun with the compliance flag from the model config', async () => {
    const h = harness();
    await allEvents(await handleGauntlet(post({ itemId: ITEM_ID }), h.deps));

    expect(h.runStarts).toHaveLength(1);
    expect(h.runStarts[0]).toEqual({
      itemId: ITEM_ID,
      itemVersionId: VERSION_ID,
      config: 'gauntlet',
      compliance: true,
    });
  });

  it('records compliance:false on the run when the config is non-compliant', async () => {
    const h = harness({ compliance: false, reviewerModel: 'gpt-4o-mini' });
    await allEvents(await handleGauntlet(post({ itemId: ITEM_ID }), h.deps));
    expect(h.runStarts[0]?.compliance).toBe(false);
    expect(h.completions[0]?.compliance).toBe(false);
  });

  it('persists one ModelCall row per call, including the separate adjudication', async () => {
    const h = harness();
    await allEvents(await handleGauntlet(post({ itemId: ITEM_ID }), h.deps));

    const record = h.completions[0];
    expect(record?.gauntletRunId).toBe(RUN_ID);
    // Three reviewers (the probe makes no model call) + one adjudication call.
    expect(record?.modelCalls).toHaveLength(4);
    expect(record?.modelCalls.filter((call) => call.callSite === 'adjudication')).toHaveLength(1);
    for (const call of record?.modelCalls ?? []) {
      expect(call.modelId, 'a ModelCall row without an exact model id is not evidence').toBeTruthy();
      expect(call.promptVersion).toBeTruthy();
      expect(call.promptHash).toBeTruthy();
      expect(typeof call.latencyMs).toBe('number');
      expect(typeof call.modelFamilyOk).toBe('boolean');
    }
  });

  it('persists one Check row per adjudicated finding, contracts intact', async () => {
    const h = harness();
    await allEvents(await handleGauntlet(post({ itemId: ITEM_ID }), h.deps));

    const checks = h.completions[0]?.checks ?? [];
    expect(checks).toHaveLength(2);
    // Rejected findings are persisted too: the passport shows what was refused.
    expect(checks.map((check) => check.status)).toEqual(['accepted', 'rejected']);
    // The re-execution identity survives, or the history re-run has nothing to run.
    expect(checks[0]).toMatchObject({
      invariantId: 'ambiguity_two_readings_disagree',
      executorVersion: 'solver@1.0.0',
      thresholdVersion: 'thresholds@1.0.0',
    });
    expect(checks[0]?.contract).toEqual(AMBIGUITY_CONTRACT);
  });

  it('records the adjudication state and the resolved item state on the run', async () => {
    const h = harness();
    await allEvents(await handleGauntlet(post({ itemId: ITEM_ID }), h.deps));

    const record = h.completions[0];
    expect(record?.adjudicationState).toBe('CHALLENGED');
    expect(record?.state).toBe('CHALLENGED');
    expect(record?.events).toEqual(['SUBMIT_TO_GAUNTLET', 'CHECKS_ACCEPTED']);
  });

  it('writes NO state event when nothing ran and nothing was accepted', async () => {
    const h = harness({
      runGauntlet: async ({ onReviewerSettled }) => {
        onReviewerSettled(PROBE_OK);
        return orchestrationOf([PROBE_OK], false);
      },
      adjudicate: async () => ({
        result: adjudicationOf([REJECTED_PROBE_CHECK], false, 'ambiguity did not complete'),
      }),
    });
    await allEvents(await handleGauntlet(post({ itemId: ITEM_ID }), h.deps));

    const record = h.completions[0];
    // Entry still happened (DRAFT -> GAUNTLET); the verdict did not.
    expect(record?.events).toEqual(['SUBMIT_TO_GAUNTLET']);
    expect(record?.events).not.toContain('GAUNTLET_CLEAN');
    expect(record?.state).toBe('GAUNTLET');
  });

  // -------------------------------------------------------------------------
  // 5. Failure containment
  // -------------------------------------------------------------------------

  it('turns a persistence failure into a terminal error event, not a rejection', async () => {
    const h = harness({
      completeRun: async () => {
        throw new Error('sqlite is on fire');
      },
    });
    const res = await handleGauntlet(post({ itemId: ITEM_ID }), h.deps);
    const events = await allEvents(res);

    expect(res.status).toBe(200);
    const last = events[events.length - 1] as { type: string; code?: string };
    expect(last.type).toBe('error');
    expect(last.code).toBe('gauntlet_failed');
    // The reviewer lanes the student already saw are not retracted.
    expect(events.some((e) => e.type === 'reviewer_result')).toBe(true);
  });

  it('emits run_completed exactly once', async () => {
    const events = await allEvents(await handleGauntlet(post({ itemId: ITEM_ID }), harness().deps));
    expect(events.filter((e) => e.type === 'run_completed')).toHaveLength(1);
  });

  it('reports the accepted-check count the UI renders', async () => {
    const events = await allEvents(await handleGauntlet(post({ itemId: ITEM_ID }), harness().deps));
    const completed = events[events.length - 1] as { acceptedChecks: number; gauntletRunId: string };
    expect(completed.acceptedChecks).toBe(1);
    expect(completed.gauntletRunId).toBe(RUN_ID);
  });
});
