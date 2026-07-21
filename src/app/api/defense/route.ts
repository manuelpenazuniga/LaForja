/**
 * POST /api/defense — the short WRITTEN defense (viva) and its explicit rubric
 * (doc §6.3, slice item 6).
 *
 * ONE endpoint, two phases, chosen by the presence of `answers`:
 *  - no `answers`   -> issue the 2 adaptive written questions,
 *  - with `answers` -> score them against the rubric (3 dimensions x 0-2, each
 *    with textual evidence). Publish threshold: >= 4/6 AND no dimension at 0.
 *
 * There is deliberately no /api/defense/questions and no /api/defense/score:
 * those were phantom endpoints named by an old client stub, and
 * tests/studioRoutes.test.ts pins them dead.
 *
 * OWNER SPLIT:
 *  - Claude (this file): the isolation envelope (session resolution, rate limit,
 *    input size, Zod validation, typed errors), the VivaContext assembly, the
 *    calls into src/defense/viva.ts, the pure state resolution, and the response
 *    contract. All of it real, all of it exercised by tests/defenseRoute.test.ts.
 *  - Codex: PERSISTENCE ONLY — the two recorder deps at the bottom of
 *    `productionDeps()`. They write the Defense row, the ModelCall row and the
 *    new Item.state. Nothing else in this file is a stub.
 *
 * ---------------------------------------------------------------------------
 * INCONCLUSIVE IS NOT REJECTION (doc §6.3) — the reason this file has a spec
 * ---------------------------------------------------------------------------
 * `scoreDefense` never throws on evaluator failure: it returns a schema-valid
 * rubric whose outcome is 'inconclusive' and whose zeros are explicitly not a
 * judgment of the student. This route MUST NOT undo that guarantee. An evaluator
 * failure is:
 *
 *    HTTP 200  +  outcome 'inconclusive'  +  rubric: null  +  DEFENSE_INCONCLUSIVE
 *
 * never a 4xx, never a 500, and never DEFENSE_FAILED. A student whose grader
 * broke must see "no verdict yet" — an error page reads as a system fault, and
 * a failing grade reads as a judgment; both are lies about what happened.
 * DEFENSE_INCONCLUSIVE is recoverable: the next call dispatches DEFENSE_RETRY
 * and the student is back in DEFENSE with a real chance at a verdict.
 *
 * WHAT IS STILL A 500: a persistence failure, and a failure to GENERATE the two
 * questions (phase 1). Neither is a verdict about the student — phase 1 has no
 * rubric to be inconclusive about and no state event to carry it, and the item
 * stays in DEFENSE, so retrying is safe. That failure is answered with a fixed,
 * sanitized message so nothing from the provider error reaches the client in any
 * environment.
 */
import { z } from 'zod';
import {
  ApiError,
  assertInputSizes,
  assertRateLimit,
  badRequest,
  errorResponse,
  getOrCreateSession,
  jsonResponse,
  loadIsolationConfig,
  notFound,
  parseBody,
  readJsonBody,
} from '@/demo/isolation';
import { fromJson, prisma, toJson } from '@/db/client';
import { loadModelConfig } from '@/config/models';
import { reduce } from '@/core/stateMachine';
import {
  DEFAULT_VIVA_DEPS,
  generateDefenseQuestions,
  meetsPublishThreshold,
  scoreDefense,
  type VivaContext,
  type VivaDeps,
} from '@/defense/viva';
import type { DefenseRubric, ItemState, StateEvent } from '@/core/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DefenseRequestSchema = z
  .object({
    itemId: z.string().min(1).max(64),
    /** Omit to receive the questions; send exactly 2 to be scored. */
    answers: z.array(z.string().min(1)).length(2).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Wire contract
// ---------------------------------------------------------------------------

export interface DefenseQuestion {
  id: string;
  prompt: string;
}

export type DefenseOutcome = 'passed' | 'failed' | 'inconclusive';

export interface QuestionsResponse {
  phase: 'questions';
  itemId: string;
  itemVersionId: string;
  /** Exactly 2, per doc §6.3. */
  questions: DefenseQuestion[];
  state: ItemState;
}

export interface ScoredResponse {
  phase: 'scored';
  itemId: string;
  itemVersionId: string;
  /** null only when the evaluator failed (outcome 'inconclusive'). */
  rubric: DefenseRubric | null;
  outcome: DefenseOutcome;
  state: ItemState;
}

/**
 * NOTHING ELSE MAY BE ADDED TO THESE TWO TYPES.
 *
 * The response carries no model id (the client has no business knowing which
 * gpt-5.6 variant graded it, and it is compliance evidence for the audit trail,
 * not client data), no session id, no pseudonym, and no raw model output. Doc
 * §10 + hard constraint 8: the only author-facing field in the system is a
 * random pseudonym, and it belongs to /api/session, not here.
 */

interface VersionRef {
  itemId: string;
  itemVersionId: string;
  itemState: ItemState;
  stem: string;
  optionsJson: string;
  correctKey: string;
}

// ---------------------------------------------------------------------------
// Pure state resolution (Claude-owned; cross-checked against reduce())
// ---------------------------------------------------------------------------

/**
 * Brings an item to DEFENSE before a defense action runs.
 *
 * DEFENSE_INCONCLUSIVE is a RECOVERABLE branch, not a terminus: a student whose
 * grader broke is entitled to another attempt, so re-entering the defense from
 * there dispatches DEFENSE_RETRY (DEFENSE_INCONCLUSIVE --DEFENSE_RETRY--> DEFENSE
 * in src/core/stateMachine.ts) rather than refusing the request. Any other state
 * has no defense to run and is a 400, not a 500 — the caller asked for something
 * the lifecycle does not offer.
 */
export function enterDefense(current: ItemState): { state: ItemState; events: StateEvent[] } {
  if (current === 'DEFENSE') return { state: 'DEFENSE', events: [] };
  if (current === 'DEFENSE_INCONCLUSIVE') {
    return { state: reduce(current, 'DEFENSE_RETRY'), events: ['DEFENSE_RETRY'] };
  }
  throw badRequest('This item is not at the defense stage.', { state: current });
}

/** Outcome -> lifecycle event. The inconclusive row is what this file exists for. */
export function defenseEventFor(outcome: DefenseOutcome): StateEvent {
  switch (outcome) {
    case 'passed':
      return 'DEFENSE_PASSED';
    case 'failed':
      return 'DEFENSE_FAILED';
    case 'inconclusive':
      // NOT DEFENSE_FAILED. An evaluator failure is not a grade.
      return 'DEFENSE_EVALUATOR_FAILED';
  }
}

/**
 * Full transition for a scored defense: re-enter DEFENSE if needed, then apply
 * the outcome. Every state here comes out of `reduce`, so the route can never
 * report a state the machine would refuse.
 */
export function resolveScoredState(
  current: ItemState,
  outcome: DefenseOutcome,
): { state: ItemState; events: StateEvent[] } {
  const entered = enterDefense(current);
  const event = defenseEventFor(outcome);
  return { state: reduce(entered.state, event), events: [...entered.events, event] };
}

/**
 * Decides the outcome from the rubric, at the route boundary.
 *
 * Deliberately NOT a straight read of `rubric.outcome`: that field is authored
 * by the evaluator, and a rubric claiming 'passed' with a dimension at 0 must
 * still fail the publish gate. Only 'inconclusive' is taken at face value,
 * because scoreDefense — not the model — is what sets it.
 */
export function outcomeFor(rubric: DefenseRubric): DefenseOutcome {
  if (rubric.outcome === 'inconclusive') return 'inconclusive';
  return meetsPublishThreshold(rubric) ? 'passed' : 'failed';
}

// ---------------------------------------------------------------------------
// Dependencies (the seam that makes this route testable without an API key)
// ---------------------------------------------------------------------------

export interface QuestionsRecord {
  itemId: string;
  itemVersionId: string;
  questions: DefenseQuestion[];
  /** Item state after `events` were applied. */
  state: ItemState;
  events: StateEvent[];
}

export interface ScoringRecord {
  itemId: string;
  itemVersionId: string;
  answers: string[];
  /**
   * ALWAYS present, including on an evaluator failure — the inconclusive rubric
   * with its "this zero is not a judgment of the student" evidence is exactly
   * what the audit trail must retain. The RESPONSE nulls it; the record does not.
   */
  rubric: DefenseRubric;
  outcome: DefenseOutcome;
  state: ItemState;
  events: StateEvent[];
}

export interface DefenseDeps {
  /** Transport seam, forwarded to src/defense/viva.ts. */
  viva: VivaDeps;
  /** EXACT evaluator model id. Compliance evidence — never sent to the client. */
  model: string;
  /** Accepted reviewer findings the student must defend against (doc §6.3). */
  loadAcceptedFindings(itemVersionId: string): Promise<unknown[]>;
  recordQuestions(record: QuestionsRecord): Promise<void>;
  recordScoring(record: ScoringRecord): Promise<void>;
}

/**
 * Accepted findings for a version. A plain read: the flagged distractor is what
 * rubric dimension 1 is about, so questions grounded in nothing would make the
 * whole rubric ungradable.
 */
async function loadAcceptedFindings(itemVersionId: string): Promise<unknown[]> {
  const checks = await prisma.check.findMany({
    where: { itemVersionId, status: 'accepted' },
    orderBy: { createdAt: 'asc' },
  });
  return checks.map((check) => ({
    reviewerType: check.reviewerType,
    checkClass: check.checkClass,
    contract: fromJson<unknown>(check.contractJson),
  }));
}

/**
 * TODO(codex): persist the issued questions.
 *
 *  1. Upsert the Defense row for `record.itemVersionId` with
 *     `questionsJson: toJson(record.questions)` and outcome 'pending'.
 *  2. Persist a ModelCall row (callSite 'viva', defenseId = that row) with the
 *     EXACT model id, modelFamilyOk, promptVersion, promptHash, latencyMs and
 *     tokens (hard constraint 3). Thread the ModelCallResult telemetry through
 *     `DefenseDeps` if you need it here — do not re-call the model.
 *  3. Write `record.state` to Item.state when `record.events` is non-empty (the
 *     DEFENSE_RETRY case). The state is already resolved through reduce(); do
 *     not recompute it.
 *
 * Reference: doc §6.3.
 */
async function recordQuestions(_record: QuestionsRecord): Promise<void> {
  void toJson;
  throw new Error('TODO(codex): persist Defense questions + ModelCall row (callSite viva)');
}

/**
 * TODO(codex): persist the scored defense.
 *
 *  1. Update the Defense row for `record.itemVersionId`:
 *     answersJson, rubricJson (via toJson — the FULL rubric, inconclusive
 *     included), totalScore = record.rubric.total, outcome = record.outcome.
 *  2. Persist a ModelCall row (callSite 'viva') exactly as above.
 *  3. Write `record.state` to Item.state. The events in `record.events` are
 *     already validated by reduce(); apply the final state, do not re-derive it.
 *
 * DO NOT special-case 'inconclusive' into a rejection anywhere in here: the row
 * records that no verdict was reached, and the item is retryable.
 *
 * Reference: doc §6.3.
 */
async function recordScoring(_record: ScoringRecord): Promise<void> {
  throw new Error('TODO(codex): persist Defense rubric + ModelCall row (callSite viva)');
}

/** Production wiring. Tests inject fakes through `handleDefense`'s second argument. */
export function productionDeps(): DefenseDeps {
  return {
    viva: DEFAULT_VIVA_DEPS,
    // The adjudicator model grades the defense; it is the same compliance-gated
    // id the gauntlet adjudication uses.
    model: loadModelConfig().adjudicatorModel,
    loadAcceptedFindings,
    recordQuestions,
    recordScoring,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/** Fixed text for a phase-1 evaluator failure. Environment-independent: nothing
 * from the underlying error reaches the client, in dev or in production. */
const QUESTION_GENERATION_FAILED =
  'The defense evaluator is unavailable. Nothing about your item has changed — retry in a moment.';

async function buildContext(ref: VersionRef, deps: DefenseDeps): Promise<VivaContext> {
  return {
    stem: ref.stem,
    options: fromJson<string[]>(ref.optionsJson),
    correctKey: ref.correctKey,
    acceptedFindings: await deps.loadAcceptedFindings(ref.itemVersionId),
  };
}

/**
 * The real handler. `POST` is a thin wrapper so Next.js gets the signature it
 * expects while tests can inject `DefenseDeps`.
 */
export async function handleDefense(
  req: Request,
  deps: DefenseDeps = productionDeps(),
): Promise<Response> {
  const config = loadIsolationConfig();
  let cookie: string | undefined;

  try {
    // Order matters: the rate limit gates the body read, not the other way round.
    const resolution = await getOrCreateSession(req, { config });
    cookie = resolution.cookie;
    assertRateLimit(resolution.session.id, { config });

    const body = parseBody(DefenseRequestSchema, await readJsonBody(req, config));

    // Student answers are UNTRUSTED text (hard constraint 1) and are size-limited
    // HERE — before the item lookup and long before any model call, so an
    // oversized answer can never be paid for.
    if (body.answers) {
      assertInputSizes(
        Object.fromEntries(
          body.answers.map((answer, i): [string, string] => [`answers[${i}]`, answer]),
        ),
        config,
      );
    }

    // Ownership check IS the isolation boundary: another visitor's item is a 404,
    // never a 403, so the endpoint does not confirm that the id exists (doc §10).
    // An expired cookie has already been replaced by a NEW session upstream, so
    // it matches nothing here and also lands on this 404.
    const item = await prisma.item.findFirst({
      where: { id: body.itemId, sessionId: resolution.session.id },
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
    });
    if (!item) throw notFound('Item not found in this session.');

    const version = item.versions[0];
    if (!version) throw notFound('Item has no version to defend.');

    const ref: VersionRef = {
      itemId: item.id,
      itemVersionId: version.id,
      itemState: item.state as ItemState,
      stem: version.stem,
      optionsJson: version.optionsJson,
      correctKey: version.correctKey,
    };

    // -- Phase 1: issue the two adaptive questions ---------------------------
    if (!body.answers) {
      const entered = enterDefense(ref.itemState);
      const ctx = await buildContext(ref, deps);

      let questions: DefenseQuestion[];
      try {
        questions = await generateDefenseQuestions(ctx, deps.model, deps.viva);
      } catch (err) {
        // Not "inconclusive": there is no rubric to be inconclusive about and no
        // event to carry it. The item is untouched and still in DEFENSE.
        // eslint-disable-next-line no-console
        console.error('[api/defense] question generation failed', err);
        throw new ApiError(500, 'internal_error', QUESTION_GENERATION_FAILED);
      }

      await deps.recordQuestions({
        itemId: ref.itemId,
        itemVersionId: ref.itemVersionId,
        questions,
        state: entered.state,
        events: entered.events,
      });

      const payload: QuestionsResponse = {
        phase: 'questions',
        itemId: ref.itemId,
        itemVersionId: ref.itemVersionId,
        questions,
        state: entered.state,
      };
      return jsonResponse(payload, 200, cookie);
    }

    // -- Phase 2: score the two written answers ------------------------------
    // Validate the transition BEFORE spending a model call.
    enterDefense(ref.itemState);
    const ctx = await buildContext(ref, deps);

    // scoreDefense NEVER throws on evaluator failure — it returns the
    // inconclusive rubric. Nothing below may convert that into an HTTP error.
    const rubric = await scoreDefense(ctx, body.answers, deps.model, deps.viva);
    const outcome = outcomeFor(rubric);
    const resolved = resolveScoredState(ref.itemState, outcome);

    await deps.recordScoring({
      itemId: ref.itemId,
      itemVersionId: ref.itemVersionId,
      answers: body.answers,
      rubric,
      outcome,
      state: resolved.state,
      events: resolved.events,
    });

    const payload: ScoredResponse = {
      phase: 'scored',
      itemId: ref.itemId,
      itemVersionId: ref.itemVersionId,
      // No rubric is shown for an evaluator failure: the zeros are a placeholder
      // for the audit trail, and rendering them would read as a grade of 0/6.
      rubric: outcome === 'inconclusive' ? null : rubric,
      outcome,
      state: resolved.state,
    };
    return jsonResponse(payload, 200, cookie);
  } catch (err) {
    return errorResponse(err, cookie);
  }
}

export async function POST(req: Request): Promise<Response> {
  return handleDefense(req);
}
