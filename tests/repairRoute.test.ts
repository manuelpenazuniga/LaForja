/**
 * LA FORJA — POST /api/repair, the v1 -> v2 path and the FULL history re-run
 * (doc §5, slice items 4 and 5).
 *
 * OWNER: Claude owns the isolation envelope, the immutability guard, the
 * by-class grouping and the pure lifecycle resolution — those suites are LIVE
 * and must pass today. Codex owns `applyRepair` and the four `RepairDeps` stubs;
 * the suites that drive them are written in full and marked `describe.skip`, so
 * the skipped bodies are the punch-list.
 *
 * ---------------------------------------------------------------------------
 * THE THREE THINGS THIS FILE REFUSES TO LET SLIDE
 * ---------------------------------------------------------------------------
 * 1. A REPAIR IS A NEW VERSION, NEVER AN EDIT. The passport rests on v1 still
 *    saying what it said when it was attacked. The previous row is frozen here,
 *    so a route that mutates it fails with a TypeError rather than passing.
 *
 * 2. THE DIFF BASE IS STORED, NOT INFERRED. `previousVersionId` is a real
 *    foreign key. Deriving the base from `versionNumber - 1` breaks the instant
 *    a version is skipped or withdrawn, and the passport then diffs against the
 *    wrong text while looking perfectly correct.
 *
 * 3. A TRUNCATED HISTORY BLOCKS. `reRunHistory` takes `expectedCheckCount` as a
 *    required parameter so the count cannot be a tautology over the array the
 *    loop iterates. That fail-open is already closed in the engine; the tests
 *    below assert the ROUTE does not reintroduce it by passing a self-derived
 *    count.
 *
 * No network, no database: prisma is mocked and every dependency is injected
 * through `handleRepair`'s second argument.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Type-only imports are erased at compile time, so they cannot defeat the
// `vi.mock` hoisting that the value imports below depend on.
import type {
  HistoryRunRecord,
  NewVersionRecord,
  RepairDeps,
  RepairResponse,
} from '@/app/api/repair/logic';
import type { HistoryRunBatch, RecordedCheck, ReRunOutcome } from '@/core/checks';
import type { ItemState } from '@/core/types';
import type { ProbabilityProblem } from '@/solver/probability';

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
  groupOutcomesByClass,
  handleRepair,
  historyEventFor,
  repairEntryEventFor,
  resolveRepairState,
} = await import('@/app/api/repair/logic');

const { SESSION_COOKIE, loadIsolationConfig, resetRateLimiter } = await import('@/demo/isolation');
const { reRunHistory } = await import('@/core/checks');
const { reduce } = await import('@/core/stateMachine');
const { LENGTH_HIGH } = await import('@/probe/itemProbe');

// ---------------------------------------------------------------------------
// Fixtures — the seeded demo item, repaired
// ---------------------------------------------------------------------------

const SESSION_ID = 'sess_live';
const OTHER_SESSION_ID = 'sess_other';
const ITEM_ID = 'item_1';
const V1_ID = 'ver_1';
const V2_ID = 'ver_2';

const EXECUTOR_VERSION = 'solver@1.0.0';
const PROBE_EXECUTOR_VERSION = 'probe@1.0.0';
const THRESHOLD_VERSION = 'thresholds@1.0.0';

const V1_STEM =
  'Una familia tiene dos hijos. Se sabe que uno de ellos es varón. ¿Cuál es la probabilidad de que ambos sean varones?';
const V2_STEM =
  'Una familia tiene dos hijos. Se sabe que AL MENOS uno de ellos es varón, sin identificar cuál. ¿Cuál es la probabilidad de que ambos sean varones?';
const OPTIONS = ['1/4', '1/3', '1/2', '2/3'];
const CORRECT_KEY = 'B';
const V1_RATIONALE = 'Con la lectura "al menos uno es varón", el espacio se reduce a {VV, VM, MV}.';
const V2_RATIONALE =
  'El enunciado fija ahora la lectura "al menos uno": el espacio condicionado es {VV, VM, MV} y P = 1/3.';

const REPAIR_BODY = {
  itemId: ITEM_ID,
  stem: V2_STEM,
  options: OPTIONS,
  correctKey: CORRECT_KEY,
  authorRationale: V2_RATIONALE,
};

/** The shape reRunCheck receives, mirroring the ItemVersion columns. */
interface VersionUnderCheck {
  id: string;
  versionNumber: number;
  stem: string;
  options: string[];
  correctKey: string;
  authorRationale: string;
}

const V2: VersionUnderCheck = {
  id: V2_ID,
  versionNumber: 2,
  stem: V2_STEM,
  options: OPTIONS,
  correctKey: CORRECT_KEY,
  authorRationale: V2_RATIONALE,
};

const SOLVER_PROBLEM: ProbabilityProblem = {
  kind: 'conditional',
  params: { experiment: 'two_children', event: 'both_boys', given: 'at_least_one_boy' },
};

const SOLVER_PROBLEM_B: ProbabilityProblem = {
  kind: 'conditional',
  params: { experiment: 'two_children', event: 'both_boys', given: 'elder_is_boy' },
};

/**
 * The counterexample that broke v1: two readings, two answers. Its re-executable
 * form is the pair of solver problems — without them the construction is prose,
 * and prose fails closed to 'inconclusive'.
 */
const AMBIGUITY_CHECK: RecordedCheck = {
  id: 'chk-ambiguity-001',
  reviewerType: 'ambiguity',
  verificationKind: 'interpretation',
  checkClass: 'counterexample',
  invariantId: 'ambiguity_two_readings_disagree',
  executorVersion: EXECUTOR_VERSION,
  thresholdVersion: THRESHOLD_VERSION,
  contract: {
    interpretation_a: 'al menos uno de los dos hijos es varón',
    interpretation_b: 'un hijo concreto (el mayor) es varón',
    answer_a: '1/3',
    answer_b: '1/2',
    evidence: 'el enunciado no distingue entre ambas lecturas',
    problem_a: SOLVER_PROBLEM,
    problem_b: SOLVER_PROBLEM_B,
  },
};

/** A deterministic probe invariant: the answer-length cue must not come back. */
const PROBE_CHECK: RecordedCheck = {
  id: 'chk-probe-001',
  reviewerType: 'item_probe',
  verificationKind: 'heuristic',
  checkClass: 'deterministic',
  invariantId: 'answer_length_flag',
  executorVersion: PROBE_EXECUTOR_VERSION,
  thresholdVersion: THRESHOLD_VERSION,
  contract: { invariant: 'answer_length_flag', threshold: LENGTH_HIGH, observedValue: 2.6 },
};

/** A semantic judgment: re-adjudicated on every version, never a hard guarantee. */
const SEMANTIC_CHECK: RecordedCheck = {
  id: 'chk-distractor-001',
  reviewerType: 'distractor',
  verificationKind: 'interpretation',
  checkClass: 'semantic',
  contract: {
    distractor: '1/2',
    hypothesized_error: 'el estudiante condiciona sobre un hijo concreto en lugar de "al menos uno"',
    confidence: 0.7,
    label: 'hypothesis',
  },
};

const FULL_HISTORY: RecordedCheck[] = [AMBIGUITY_CHECK, PROBE_CHECK, SEMANTIC_CHECK];

// ---------------------------------------------------------------------------
// Harness: every dependency injected, nothing real behind it
// ---------------------------------------------------------------------------

interface Harness {
  deps: RepairDeps;
  created: NewVersionRecord[];
  historyRuns: HistoryRunRecord[];
  loadCalls: string[];
  countCalls: string[];
}

function harness(overrides: Partial<RepairDeps> = {}): Harness {
  const created: NewVersionRecord[] = [];
  const historyRuns: HistoryRunRecord[] = [];
  const loadCalls: string[] = [];
  const countCalls: string[] = [];

  const deps: RepairDeps = {
    createVersion: async (record) => {
      created.push(record);
      return { id: V2_ID, versionNumber: record.versionNumber };
    },
    loadRecordedHistory: async (itemId) => {
      loadCalls.push(itemId);
      return [...FULL_HISTORY];
    },
    countRecordedChecks: async (itemId) => {
      countCalls.push(itemId);
      return FULL_HISTORY.length;
    },
    recordHistoryRun: async (record) => {
      historyRuns.push(record);
    },
    ...overrides,
  };

  return { deps, created, historyRuns, loadCalls, countCalls };
}

// ---------------------------------------------------------------------------
// Requests
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

  return new Request('https://demo.invalid/api/repair', {
    method: 'POST',
    headers,
    body: options.raw ?? JSON.stringify(body),
  });
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
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

/**
 * The v1 row, FROZEN. Any route that tries to mutate the previous version — its
 * stem, its options, its `immutable` flag — throws a TypeError in strict mode
 * instead of quietly rewriting published evidence.
 */
function frozenV1(immutable: boolean) {
  return Object.freeze({
    id: V1_ID,
    versionNumber: 1,
    stem: V1_STEM,
    optionsJson: JSON.stringify(OPTIONS),
    correctKey: CORRECT_KEY,
    authorRationale: V1_RATIONALE,
    immutable,
  });
}

/** Byte-for-byte snapshot of v1, taken before the repair and compared after. */
const V1_SNAPSHOT = JSON.stringify(frozenV1(false));

function serveItem(state: ItemState, options: { immutable?: boolean; withVersion?: boolean } = {}): void {
  const { immutable = false, withVersion = true } = options;
  itemFindFirstMock.mockImplementation((args: { where: { id: string; sessionId: string } }) => {
    if (args.where.sessionId !== SESSION_ID || args.where.id !== ITEM_ID) return Promise.resolve(null);
    return Promise.resolve(
      Object.freeze({
        id: ITEM_ID,
        sessionId: SESSION_ID,
        state,
        versions: withVersion ? [frozenV1(immutable)] : [],
      }),
    );
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
  serveItem('CHALLENGED');
});

// ===========================================================================
// THE FAIL-OPEN — a truncated history must block (Claude-owned, LIVE)
// ===========================================================================

/**
 * These run against the REAL `reRunHistory`, which is implemented. They pin the
 * contract the route has to honour: whatever the route passes as
 * `expectedCheckCount` decides whether a short load is detectable at all.
 */
describe('a history that was not fully read can never be clean', () => {
  it('reports a truncated load as incomplete and blocks publication', () => {
    // Three checks were recorded. Only two came back — a partial page, a failed
    // query, a mid-flight crash. The count comes from OUTSIDE the array.
    const truncated = [AMBIGUITY_CHECK, PROBE_CHECK];
    const batch = reRunHistory(truncated, V2, FULL_HISTORY.length);

    expect(batch.expectedCheckCount).toBe(3);
    expect(batch.completedCheckCount).toBe(2);
    expect(batch.status).toBe('incomplete');
    expect(batch.blocksPublish).toBe(true);

    // And the route's gate must turn that into a regression, never a clean run.
    expect(historyEventFor(batch)).toBe('HISTORY_REGRESSED');
    expect(historyEventFor(batch)).not.toBe('HISTORY_CLEAN');
    expect(resolveRepairState('CHALLENGED', batch).state).toBe('CHALLENGED');
  });

  it('shows exactly what a self-derived count would have concealed', () => {
    const truncated = [AMBIGUITY_CHECK, PROBE_CHECK];

    // What the route must NOT do: expectedCheckCount = history.length.
    const selfDerived = reRunHistory(truncated, V2, truncated.length);
    // The tautology makes a two-thirds read look like a finished job. Whether it
    // publishes then depends only on the outcomes that happened to load — the
    // missing check is invisible.
    expect(selfDerived.status).toBe('complete');
    expect(selfDerived.expectedCheckCount).toBe(2);

    // What the route MUST do.
    const independent = reRunHistory(truncated, V2, FULL_HISTORY.length);
    expect(independent.status).toBe('incomplete');
    expect(independent.blocksPublish).toBe(true);
  });

  it('blocks an empty load that was supposed to carry a history', () => {
    // An item only reaches REGRESSION through a repair, so it MUST have had
    // prior checks. An empty history there is a bug, not cleanliness.
    const batch = reRunHistory([], V2, FULL_HISTORY.length);
    expect(batch.status).toBe('incomplete');
    expect(batch.blocksPublish).toBe(true);
    expect(historyEventFor(batch)).toBe('HISTORY_REGRESSED');
  });

  it('runs the FULL history — every recorded class, not just the last run', () => {
    const batch = reRunHistory(FULL_HISTORY, V2, FULL_HISTORY.length);

    expect(batch.status).toBe('complete');
    expect(batch.completedCheckCount).toBe(3);
    expect(batch.outcomes.map((o) => o.originalCheckId).sort()).toEqual(
      FULL_HISTORY.map((check) => check.id).sort(),
    );

    const byClass = groupOutcomesByClass(batch.outcomes);
    expect(byClass.counterexample).toHaveLength(1);
    expect(byClass.deterministic).toHaveLength(1);
    expect(byClass.semantic).toHaveLength(1);
  });
});

// ===========================================================================
// The lifecycle gate (Claude-owned, LIVE)
// ===========================================================================

/** Builds a batch shape without executing anything, for the gate's edge cases. */
function batchOf(over: Partial<HistoryRunBatch>): HistoryRunBatch {
  return {
    targetVersionId: V2_ID,
    expectedCheckCount: 1,
    completedCheckCount: 1,
    startedAt: NOW.toISOString(),
    completedAt: NOW.toISOString(),
    status: 'complete',
    blocksPublish: false,
    outcomes: [
      {
        originalCheckId: PROBE_CHECK.id,
        checkClass: 'deterministic',
        result: 'pass',
        blocksPublish: false,
      },
    ],
    ...over,
  };
}

describe('the history gate agrees with the state machine', () => {
  it('dispatches HISTORY_CLEAN only on a complete, non-blocking batch', () => {
    const clean = batchOf({});
    expect(historyEventFor(clean)).toBe('HISTORY_CLEAN');

    const resolved = resolveRepairState('CHALLENGED', clean);
    expect(resolved.events).toEqual(['SUBMIT_REPAIR', 'HISTORY_CLEAN']);
    expect(resolved.state).toBe(reduce(reduce('CHALLENGED', 'SUBMIT_REPAIR'), 'HISTORY_CLEAN'));
    expect(resolved.state).toBe('DEFENSE');
  });

  it('dispatches HISTORY_REGRESSED for every non-clean batch', () => {
    const blocking = batchOf({
      blocksPublish: true,
      outcomes: [
        {
          originalCheckId: PROBE_CHECK.id,
          checkClass: 'deterministic',
          result: 'regressed',
          blocksPublish: true,
        },
      ],
    });
    const incomplete = batchOf({ status: 'incomplete', completedCheckCount: 0, outcomes: [] });
    const failed = batchOf({ status: 'failed', completedAt: null, blocksPublish: true });
    const shortCount = batchOf({ expectedCheckCount: 5 });

    for (const batch of [blocking, incomplete, failed, shortCount]) {
      expect(historyEventFor(batch), `batch ${batch.status} was treated as clean`).toBe(
        'HISTORY_REGRESSED',
      );
      expect(resolveRepairState('CHALLENGED', batch).state).toBe('CHALLENGED');
    }
  });

  it('never lets an inconclusive deterministic re-run publish', () => {
    // "We could not verify it" is not "it passed" (doc §5, fail-closed).
    const batch = batchOf({
      blocksPublish: true,
      outcomes: [
        {
          originalCheckId: AMBIGUITY_CHECK.id,
          checkClass: 'counterexample',
          result: 'inconclusive',
          blocksPublish: true,
          detail: 'the recorded construction has no re-executable form',
        },
      ],
    });
    expect(historyEventFor(batch)).toBe('HISTORY_REGRESSED');
  });

  it('lets a semantic inconclusive through — it never blocked in the first place', () => {
    const batch = batchOf({
      outcomes: [
        {
          originalCheckId: SEMANTIC_CHECK.id,
          checkClass: 'semantic',
          result: 'inconclusive',
          blocksPublish: false,
        },
      ],
    });
    expect(historyEventFor(batch)).toBe('HISTORY_CLEAN');
  });

  it('routes a DISPUTED item through the dispute repair, still to REGRESSION', () => {
    expect(repairEntryEventFor('CHALLENGED')).toBe('SUBMIT_REPAIR');
    expect(repairEntryEventFor('DISPUTED')).toBe('DISPUTE_REPAIR');

    const resolved = resolveRepairState('DISPUTED', batchOf({}));
    expect(resolved.events).toEqual(['DISPUTE_REPAIR', 'HISTORY_CLEAN']);
    expect(resolved.state).toBe('DEFENSE');
  });

  it('rejects a state with nothing to repair as a 400, not a 500', () => {
    for (const state of ['DRAFT', 'GAUNTLET', 'REGRESSION', 'DEFENSE', 'DEFENSE_INCONCLUSIVE', 'PUBLISHED'] as const) {
      let status: number | undefined;
      try {
        repairEntryEventFor(state);
      } catch (err) {
        status = (err as { status: number }).status;
      }
      expect(status, `repairEntryEventFor('${state}') did not raise a typed 400`).toBe(400);
    }
  });
});

// ===========================================================================
// Grouping by class (Claude-owned, LIVE)
// ===========================================================================

describe('outcomes are grouped by the class that fixes their promise', () => {
  it('always returns all three keys, even when empty', () => {
    const grouped = groupOutcomesByClass([]);
    expect(Object.keys(grouped).sort()).toEqual(['counterexample', 'deterministic', 'semantic']);
    // The UI renders three sections unconditionally; undefined would crash it.
    expect(grouped.deterministic).toEqual([]);
    expect(grouped.counterexample).toEqual([]);
    expect(grouped.semantic).toEqual([]);
  });

  it('files each outcome under its own class and loses none', () => {
    const outcomes: ReRunOutcome[] = [
      { originalCheckId: 'a', checkClass: 'deterministic', result: 'pass', blocksPublish: false },
      { originalCheckId: 'b', checkClass: 'counterexample', result: 'regressed', blocksPublish: true },
      { originalCheckId: 'c', checkClass: 'semantic', result: 'inconclusive', blocksPublish: false },
      { originalCheckId: 'd', checkClass: 'deterministic', result: 'inconclusive', blocksPublish: true },
    ];
    const grouped = groupOutcomesByClass(outcomes);

    expect(grouped.deterministic.map((o) => o.originalCheckId)).toEqual(['a', 'd']);
    expect(grouped.counterexample.map((o) => o.originalCheckId)).toEqual(['b']);
    expect(grouped.semantic.map((o) => o.originalCheckId)).toEqual(['c']);
    const total = grouped.deterministic.length + grouped.counterexample.length + grouped.semantic.length;
    expect(total).toBe(outcomes.length);
  });
});

// ===========================================================================
// The isolation envelope (Claude-owned, LIVE)
// ===========================================================================

describe('the isolation envelope', () => {
  it('rejects a malformed JSON body with a typed 400', async () => {
    const res = await handleRepair(post(null, { raw: '{not json' }), harness().deps);
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe('invalid_json');
  });

  it('rejects a body that is not a well-formed item', async () => {
    const bodies = [
      { ...REPAIR_BODY, stem: '' },
      { ...REPAIR_BODY, options: ['only one'] },
      { ...REPAIR_BODY, options: OPTIONS.concat(['e', 'f', 'g']) },
      { ...REPAIR_BODY, correctKey: 'Z' },
      { ...REPAIR_BODY, authorRationale: '' },
      { itemId: ITEM_ID },
    ];
    for (const body of bodies) {
      const res = await handleRepair(post(body), harness().deps);
      expect(res.status, `body ${JSON.stringify(body).slice(0, 60)} was accepted`).toBe(400);
      expect((await errorBody(res)).code).toBe('invalid_body');
    }
  });

  it('rejects a correctKey that points past the supplied options', async () => {
    // 'D' with three options is a key nothing answers — a silently unanswerable
    // item, not a repair.
    const res = await handleRepair(
      post({ ...REPAIR_BODY, options: OPTIONS.slice(0, 3), correctKey: 'D' }),
      harness().deps,
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(await bodyOf(res))).toContain('correctKey');
  });

  it('rejects unknown fields rather than silently ignoring them', async () => {
    const res = await handleRepair(
      post({ ...REPAIR_BODY, sessionId: OTHER_SESSION_ID, immutable: false }),
      harness().deps,
    );
    expect(res.status).toBe(400);
  });

  it('refuses an oversized stem with 413 before touching the item', async () => {
    const config = loadIsolationConfig();
    const h = harness();
    const res = await handleRepair(
      post({ ...REPAIR_BODY, stem: 'x'.repeat(config.maxInputChars + 1) }),
      h.deps,
    );

    expect(res.status).toBe(413);
    const error = await errorBody(res);
    expect(error.code).toBe('input_too_large');
    expect(error.message).toContain('stem');
    expect(h.created).toHaveLength(0);
    expect(itemFindFirstMock).not.toHaveBeenCalled();
  });

  it('size-limits every option, not just the stem', async () => {
    const config = loadIsolationConfig();
    const oversized = [...OPTIONS];
    oversized[2] = 'y'.repeat(config.maxInputChars + 1);
    const res = await handleRepair(post({ ...REPAIR_BODY, options: oversized }), harness().deps);

    expect(res.status).toBe(413);
    expect((await errorBody(res)).message).toContain('options[2]');
  });

  it('size-limits the author rationale', async () => {
    const config = loadIsolationConfig();
    const res = await handleRepair(
      post({ ...REPAIR_BODY, authorRationale: 'z'.repeat(config.maxInputChars + 1) }),
      harness().deps,
    );
    expect(res.status).toBe(413);
    expect((await errorBody(res)).message).toContain('authorRationale');
  });

  it('rate limits a cookie-less flood with a typed 429', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 14; i += 1) {
      const res = await handleRepair(
        post(REPAIR_BODY, { cookie: null, address: '198.51.100.9' }),
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
    const res = await handleRepair(post(REPAIR_BODY, { cookie: OTHER_SESSION_ID }), h.deps);

    expect(res.status).toBe(404);
    const text = JSON.stringify(await bodyOf(res));
    expect(text).not.toContain(V1_STEM);
    expect(text).not.toContain(SESSION_ID);
    expect(h.created).toHaveLength(0);
  });

  it('replaces an expired session instead of resurrecting it', async () => {
    sessionFindUniqueMock.mockResolvedValue({
      id: SESSION_ID,
      pseudonym: 'QuietForge321',
      createdAt: new Date(Date.now() - 60 * 60_000),
      expiresAt: new Date(Date.now() - 60_000),
    });
    const res = await handleRepair(post(REPAIR_BODY), harness().deps);

    expect(sessionCreateMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(404);
    expect(res.headers.get('set-cookie') ?? '').toContain('HttpOnly');
    expect(JSON.stringify(await bodyOf(res))).not.toContain(V1_STEM);
  });

  it('404s when the item has no version to repair', async () => {
    serveItem('CHALLENGED', { withVersion: false });
    const res = await handleRepair(post(REPAIR_BODY), harness().deps);
    expect(res.status).toBe(404);
    expect((await errorBody(res)).code).toBe('not_found');
  });
});

// ===========================================================================
// Immutability (Claude-owned guard, LIVE)
// ===========================================================================

describe('a published version is immutable', () => {
  it('refuses a repair aimed at an immutable version with a typed 400', async () => {
    serveItem('PUBLISHED', { immutable: true });
    const h = harness();
    const res = await handleRepair(post(REPAIR_BODY), h.deps);

    expect(res.status).toBe(400);
    const error = await errorBody(res);
    expect(error.code).toBe('immutable_version');
    expect(error.message).toMatch(/immutable/i);
    // Nothing was created, and the frozen row is untouched.
    expect(h.created).toHaveLength(0);
    expect(h.historyRuns).toHaveLength(0);
  });

  it('names the dispute path instead of leaving the author stuck', async () => {
    serveItem('PUBLISHED', { immutable: true });
    const res = await handleRepair(post(REPAIR_BODY), harness().deps);
    expect((await errorBody(res)).message).toMatch(/dispute/i);
  });

  it('refuses a repair on an item with nothing to repair, before writing a row', async () => {
    serveItem('DEFENSE');
    const h = harness();
    const res = await handleRepair(post(REPAIR_BODY), h.deps);

    expect(res.status).toBe(400);
    // No orphan ItemVersion for an item that could not have been repaired.
    expect(h.created).toHaveLength(0);
  });

  it('reveals nothing about another session while refusing', async () => {
    serveItem('PUBLISHED', { immutable: true });
    const res = await handleRepair(post(REPAIR_BODY), harness().deps);
    const text = JSON.stringify(await bodyOf(res));

    for (const forbidden of [SESSION_ID, 'MoltenCrucible417', 'pseudonym', V1_STEM]) {
      expect(text, `the immutable-version error leaked ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// ===========================================================================
// CODEX PUNCH-LIST — applyRepair and the four persistence deps
// ===========================================================================

/**
 * Everything below drives `applyRepair` through injected fakes. Unskip as
 * src/app/api/repair/logic.ts is filled in.
 */
describe('the repair pipeline (Codex)', () => {
  // -------------------------------------------------------------------------
  // 1. A repair is a NEW version, never an edit
  // -------------------------------------------------------------------------

  it('creates version n+1 and leaves the previous row byte-identical', async () => {
    const h = harness();
    const res = await handleRepair(post(REPAIR_BODY), h.deps);

    expect(res.status).toBe(200);
    expect(h.created).toHaveLength(1);
    const created = h.created[0];
    expect(created?.versionNumber).toBe(2);
    expect(created?.stem).toBe(V2_STEM);
    expect(created?.correctKey).toBe(CORRECT_KEY);
    expect(created?.authorRationale).toBe(V2_RATIONALE);

    // THE ASSERTION: v1 is exactly what it was. The row is frozen, so a mutating
    // route would already have thrown; this catches a route that rebuilt it.
    expect(JSON.stringify(frozenV1(false))).toBe(V1_SNAPSHOT);

    const body = (await bodyOf(res)) as unknown as RepairResponse;
    expect(body.newVersionId).toBe(V2_ID);
    expect(body.newVersionId).not.toBe(V1_ID);
    expect(body.versionNumber).toBe(2);
  });

  it('records the diff AND the previousVersionId it was taken against', async () => {
    const h = harness();
    const res = await handleRepair(post(REPAIR_BODY), h.deps);

    const created = h.created[0];
    // The base is a stored foreign key, not `versionNumber - 1`: a skipped or
    // withdrawn version would make the inferred base point at the wrong text.
    expect(created?.previousVersionId).toBe(V1_ID);
    expect(created?.diff).toBeTruthy();
    // The diff has to be about the change the author actually made.
    expect(created?.diff).toContain('AL MENOS');

    expect((await bodyOf(res)).diff).toBeTruthy();
  });

  it('does not carry the author rationale of v1 into v2', async () => {
    const h = harness();
    await handleRepair(post(REPAIR_BODY), h.deps);
    expect(h.created[0]?.authorRationale).not.toBe(V1_RATIONALE);
  });

  // -------------------------------------------------------------------------
  // 2. The full history, counted independently
  // -------------------------------------------------------------------------

  it('re-runs the FULL history against the NEW version', async () => {
    const h = harness();
    await handleRepair(post(REPAIR_BODY), h.deps);

    expect(h.loadCalls).toEqual([ITEM_ID]);
    const record = h.historyRuns[0];
    expect(record?.newVersionId).toBe(V2_ID);
    expect(record?.batch.targetVersionId).toBe(V2_ID);
    expect(record?.batch.completedCheckCount).toBe(FULL_HISTORY.length);
    expect(record?.batch.outcomes.map((o) => o.originalCheckId).sort()).toEqual(
      FULL_HISTORY.map((check) => check.id).sort(),
    );
  });

  it('obtains expectedCheckCount from the COUNT query, not from the loaded array', async () => {
    const h = harness();
    await handleRepair(post(REPAIR_BODY), h.deps);

    // If the route never asks, the count can only have been `history.length` —
    // which is the tautology the parameter exists to prevent.
    expect(h.countCalls, 'the route never ran an independent count').toEqual([ITEM_ID]);
    expect(h.historyRuns[0]?.batch.expectedCheckCount).toBe(FULL_HISTORY.length);
  });

  it('BLOCKS when the load is short of the declared count', async () => {
    const h = harness({
      // Three rows exist; only two come back.
      loadRecordedHistory: async () => [AMBIGUITY_CHECK, PROBE_CHECK],
      countRecordedChecks: async () => FULL_HISTORY.length,
    });
    const res = await handleRepair(post(REPAIR_BODY), h.deps);
    const body = (await bodyOf(res)) as unknown as RepairResponse;

    expect(res.status).toBe(200);
    const batch = h.historyRuns[0]?.batch;
    expect(batch?.expectedCheckCount).toBe(3);
    expect(batch?.completedCheckCount).toBe(2);
    expect(batch?.status).toBe('incomplete');
    expect(batch?.blocksPublish).toBe(true);

    // And it must not reach DEFENSE. An incomplete batch is indistinguishable
    // from "nothing was checked".
    expect(body.reRun.blocksPublish).toBe(true);
    expect(body.state).toBe('CHALLENGED');
    expect(h.historyRuns[0]?.events).toEqual(['SUBMIT_REPAIR', 'HISTORY_REGRESSED']);
  });

  it('blocks an empty load on an item that must have had checks', async () => {
    const h = harness({
      loadRecordedHistory: async () => [],
      countRecordedChecks: async () => FULL_HISTORY.length,
    });
    const body = (await bodyOf(await handleRepair(post(REPAIR_BODY), h.deps))) as unknown as RepairResponse;

    expect(body.reRun.total).toBe(0);
    expect(body.reRun.blocksPublish).toBe(true);
    expect(body.state).toBe('CHALLENGED');
  });

  // -------------------------------------------------------------------------
  // 3. The transition
  // -------------------------------------------------------------------------

  it('reaches DEFENSE on a complete, non-blocking re-run', async () => {
    const h = harness({
      // A repaired v2 on which nothing regresses.
      loadRecordedHistory: async () => [PROBE_CHECK],
      countRecordedChecks: async () => 1,
    });
    const body = (await bodyOf(await handleRepair(post(REPAIR_BODY), h.deps))) as unknown as RepairResponse;

    const batch = h.historyRuns[0]?.batch as HistoryRunBatch;
    expect(batch.status).toBe('complete');
    expect(batch.blocksPublish).toBe(false);
    expect(body.state).toBe(reduce(reduce('CHALLENGED', 'SUBMIT_REPAIR'), 'HISTORY_CLEAN'));
    expect(body.state).toBe('DEFENSE');
    expect(h.historyRuns[0]?.events).toEqual(['SUBMIT_REPAIR', 'HISTORY_CLEAN']);
  });

  it('returns to CHALLENGED when a deterministic invariant regressed', async () => {
    // v2 that reintroduces the answer-length cue: the recorded probe invariant
    // fires again.
    const cueLeaking = {
      ...REPAIR_BODY,
      options: [
        'Un medio',
        'El cociente entre el número de casos favorables al evento y el número total de casos posibles del espacio muestral equiprobable considerado',
        'Cero',
        'Uno',
      ],
      correctKey: 'B' as const,
    };
    const h = harness({
      loadRecordedHistory: async () => [PROBE_CHECK],
      countRecordedChecks: async () => 1,
    });
    const body = (await bodyOf(await handleRepair(post(cueLeaking), h.deps))) as unknown as RepairResponse;

    expect(body.reRun.byClass.deterministic[0]?.result).toBe('regressed');
    expect(body.reRun.blocksPublish).toBe(true);
    expect(body.state).toBe('CHALLENGED');
  });

  it('takes the dispute path from a DISPUTED item and still creates a new version', async () => {
    serveItem('DISPUTED', { immutable: true });
    const h = harness();
    const body = (await bodyOf(await handleRepair(post(REPAIR_BODY), h.deps))) as unknown as RepairResponse;

    expect(h.created[0]?.previousVersionId).toBe(V1_ID);
    expect(h.historyRuns[0]?.events[0]).toBe('DISPUTE_REPAIR');
    expect(JSON.stringify(frozenV1(true))).toContain('"immutable":true');
    expect(body.newVersionId).toBe(V2_ID);
  });

  // -------------------------------------------------------------------------
  // 4. The response
  // -------------------------------------------------------------------------

  it('returns the outcomes GROUPED BY CHECK CLASS', async () => {
    const body = (await bodyOf(await handleRepair(post(REPAIR_BODY), harness().deps))) as unknown as RepairResponse;

    // Three classes, three different promises, three sections in the UI.
    expect(Object.keys(body.reRun.byClass).sort()).toEqual([
      'counterexample',
      'deterministic',
      'semantic',
    ]);
    expect(body.reRun.byClass.counterexample).toHaveLength(1);
    expect(body.reRun.byClass.deterministic).toHaveLength(1);
    expect(body.reRun.byClass.semantic).toHaveLength(1);
    expect(body.reRun.total).toBe(FULL_HISTORY.length);
  });

  it('keeps every class key present even when a class recorded nothing', async () => {
    const h = harness({
      loadRecordedHistory: async () => [PROBE_CHECK],
      countRecordedChecks: async () => 1,
    });
    const body = (await bodyOf(await handleRepair(post(REPAIR_BODY), h.deps))) as unknown as RepairResponse;

    expect(body.reRun.byClass.counterexample).toEqual([]);
    expect(body.reRun.byClass.semantic).toEqual([]);
  });

  it('carries the semantic re-adjudication verdict the passport renders', async () => {
    const body = (await bodyOf(await handleRepair(post(REPAIR_BODY), harness().deps))) as unknown as RepairResponse;
    const semantic = body.reRun.byClass.semantic[0];

    expect(semantic?.result).toBe('readjudicated');
    // The passport shows the structured verdict, not a free-text detail (§6.4).
    expect(semantic && 'verdict' in semantic ? semantic.verdict.status : undefined).toBeTruthy();
    // A semantic judgment never blocks — the guarantee text promises nothing here.
    expect(semantic?.blocksPublish).toBe(false);
  });

  it('has exactly the contracted keys and no telemetry', async () => {
    const body = await bodyOf(await handleRepair(post(REPAIR_BODY), harness().deps));
    expect(Object.keys(body).sort()).toEqual([
      'diff',
      'itemId',
      'newVersionId',
      'reRun',
      'state',
      'versionNumber',
    ]);
  });

  it('exposes no session id, pseudonym, model id or credential', async () => {
    const res = await handleRepair(post(REPAIR_BODY), harness().deps);
    const text = JSON.stringify(await bodyOf(res));

    for (const forbidden of [SESSION_ID, 'MoltenCrucible417', 'pseudonym', 'sk-', 'gpt-']) {
      expect(text, `the repair response leaked ${forbidden}`).not.toContain(forbidden);
    }
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('set-cookie')).toContain(SESSION_COOKIE);
  });

  // -------------------------------------------------------------------------
  // 5. Persistence
  // -------------------------------------------------------------------------

  it('persists the batch and one re-run row per outcome against the NEW version', async () => {
    const h = harness();
    await handleRepair(post(REPAIR_BODY), h.deps);

    const record = h.historyRuns[0];
    expect(record?.itemId).toBe(ITEM_ID);
    expect(record?.newVersionId).toBe(V2_ID);
    expect(record?.batch.outcomes).toHaveLength(FULL_HISTORY.length);
    // The batch row is copied, not recomputed: it is the evidence that the full
    // history ran.
    expect(record?.batch.startedAt).toBeTruthy();
    expect(record?.batch.completedAt).toBeTruthy();
    expect(record?.state).toBe(record?.batch.blocksPublish ? 'CHALLENGED' : 'DEFENSE');
  });

  it('never persists a state it derived itself', async () => {
    const h = harness();
    await handleRepair(post(REPAIR_BODY), h.deps);

    const record = h.historyRuns[0];
    const expected = resolveRepairState('CHALLENGED', record?.batch as HistoryRunBatch);
    expect(record?.state).toBe(expected.state);
    expect(record?.events).toEqual(expected.events);
  });

  it('surfaces a persistence failure as a typed 500 that leaks nothing', async () => {
    const SENTINEL = ['sk', 'live', 'should', 'never', 'surface'].join('-');
    const h = harness({
      recordHistoryRun: async () => {
        throw new Error(`sqlite exploded: key ${SENTINEL}`);
      },
    });
    const res = await handleRepair(post(REPAIR_BODY), h.deps);

    expect(res.status).toBe(500);
    const error = await errorBody(res);
    expect(error.code).toBe('internal_error');
    expect(JSON.stringify(error)).not.toContain(SENTINEL);
  });
});
