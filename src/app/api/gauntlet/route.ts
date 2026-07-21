/**
 * POST /api/gauntlet — run the gauntlet over an item's current version and
 * STREAM partial reviewer results back (doc §7.1, slice item 2).
 *
 * OWNER SPLIT:
 *  - Claude (this file, done): session resolution, rate limit, input size, Zod
 *    validation, ownership check, typed errors, the GPT-5.6 compliance record,
 *    the newline-delimited-JSON streaming scaffolding, and the PURE lifecycle
 *    resolution (`enterGauntlet` / `gauntletEventFor` / `resolveGauntletState`)
 *    that decides which state event a run is allowed to dispatch.
 *  - Codex: `runGauntletPipeline` below — orchestration, adjudication and
 *    persistence. Codex only has to push events through `emit` and write rows
 *    through the injected `GauntletRouteDeps`.
 *
 * WIRE FORMAT: newline-delimited JSON (`application/x-ndjson`). One JSON object
 * per line, so the UI can render each reviewer the moment it lands and a partial
 * reviewer failure never breaks the experience (doc §7.1 "fallas parciales no
 * rompen la experiencia").
 *
 * STATUS-CODE NOTE: envelope failures (400/404/413/429) are answered BEFORE the
 * stream opens, with a real status code. Once the stream is open the status is
 * already 200, so a downstream failure arrives as a terminal `error` event.
 *
 * ---------------------------------------------------------------------------
 * THE TRAP THIS FILE EXISTS TO NOT FALL INTO (doc §5, src/core/types.ts)
 * ---------------------------------------------------------------------------
 * "No finding was accepted" and "no reviewer ran" both produce zero accepted
 * checks. Treating the second as the first dispatches GAUNTLET_CLEAN on an item
 * nobody examined, and that item goes on to publish. GAUNTLET_CLEAN is therefore
 * gated on `AdjudicationResult.gauntletComplete` — every mandatory reviewer, the
 * deterministic item_probe AND the adjudication pass — never on an empty finding
 * list. When nothing was accepted and the run did not complete, NO event is
 * dispatched and the item stays in GAUNTLET.
 */
import { z } from 'zod';
import {
  assertRateLimit,
  badRequest,
  errorResponse,
  getOrCreateSession,
  loadIsolationConfig,
  notFound,
  parseBody,
  readJsonBody,
} from '@/demo/isolation';
import { fromJson, prisma, toJson } from '@/db/client';
import { loadModelConfig } from '@/config/models';
import { reduce } from '@/core/stateMachine';
import {
  runGauntlet,
  type OrchestrationResult,
  type RawItem,
  type ReviewerFailureKind,
  type ReviewerOutcome,
} from '@/reviewers/orchestrator';
import {
  adjudicate,
  type AdjudicatedCheck,
  type AdjudicationResult,
} from '@/reviewers/adjudication';
import type { EvalConfig } from '@/eval/types';
import type {
  CheckClass,
  CheckStatus,
  ItemState,
  StateEvent,
  VerificationKind,
} from '@/core/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GauntletRequestSchema = z
  .object({
    itemId: z.string().min(1).max(64),
  })
  .strict();

// ---------------------------------------------------------------------------
// Streamed event protocol (the UI mirrors these shapes)
// ---------------------------------------------------------------------------

export interface RunStartedEvent {
  type: 'run_started';
  itemId: string;
  itemVersionId: string;
  versionNumber: number;
  config: EvalConfig;
  /**
   * EXACT model ids — compliance evidence, recorded on every run.
   *
   * DELIBERATE DIVERGENCE FROM /api/defense, which forbids them: the gauntlet is
   * the stage whose whole claim is "three gpt-5.6 reviewers attacked this item",
   * and the passport shows the exact ids. They are declared here, on the record,
   * rather than inferred. Nothing else identifying may join them: no session id,
   * no pseudonym, no prompt text, no credential.
   */
  reviewerModel: string;
  adjudicatorModel: string;
  /** false when a model id is outside the gpt-5.6 family. */
  compliance: boolean;
}

export interface ReviewerResultEvent {
  type: 'reviewer_result';
  reviewerType: string;
  ok: boolean;
  /**
   * THE DEGRADED LANE. true exactly when this reviewer produced no usable
   * contract. The UI renders the lane greyed with its reason and keeps every
   * other lane live — a partial failure degrades one lane, it never fails a run.
   */
  degraded: boolean;
  schemaValid: boolean;
  latencyMs: number;
  contract?: unknown;
  error?: string;
  /** timeout | error | schema — different facts, and the passport must say which. */
  failureKind?: ReviewerFailureKind;
}

export interface AdjudicationEvent {
  type: 'adjudication';
  checks: {
    reviewerType: string;
    verificationKind: VerificationKind;
    checkClass: CheckClass;
    status: CheckStatus;
    contract: unknown;
    schemaValid: boolean;
    note?: string;
  }[];
  nextState: Extract<ItemState, 'CHALLENGED' | 'DEFENSE'>;
  abstained: number;
  /** Composed from the orchestration; the ONLY thing that authorizes GAUNTLET_CLEAN. */
  gauntletComplete: boolean;
  /** Present exactly when `gauntletComplete` is false. */
  incompleteReason?: string;
}

export interface RunCompletedEvent {
  type: 'run_completed';
  gauntletRunId: string;
  state: ItemState;
  /**
   * null when the run neither accepted a finding NOR completed. That is not a
   * clean item and not a challenged one — it is a run that did not happen, and
   * the wire has to be able to say so rather than defaulting to GAUNTLET_CLEAN.
   */
  dispatchedEvent: StateEvent | null;
  acceptedChecks: number;
  compliance: boolean;
}

export interface ErrorEvent {
  type: 'error';
  code: string;
  message: string;
}

export type GauntletEvent =
  | RunStartedEvent
  | ReviewerResultEvent
  | AdjudicationEvent
  | RunCompletedEvent
  | ErrorEvent;

export type EmitFn = (event: GauntletEvent) => void;

// ---------------------------------------------------------------------------
// Pure lifecycle resolution (Claude-owned; cross-checked against reduce())
// ---------------------------------------------------------------------------

/**
 * Brings an item to GAUNTLET before a run starts. A DRAFT is submitted; an item
 * already in GAUNTLET is a re-run and needs no event. Every other state has no
 * gauntlet to run and is a 400, not a 500 — a CHALLENGED item repairs, it does
 * not re-enter the gauntlet directly (see TRANSITIONS in src/core/stateMachine).
 */
export function enterGauntlet(current: ItemState): { state: ItemState; events: StateEvent[] } {
  if (current === 'GAUNTLET') return { state: 'GAUNTLET', events: [] };
  if (current === 'DRAFT') {
    return { state: reduce(current, 'SUBMIT_TO_GAUNTLET'), events: ['SUBMIT_TO_GAUNTLET'] };
  }
  throw badRequest('This item is not at the gauntlet stage.', { state: current });
}

/** The two facts a dispatch decision is allowed to depend on. */
export interface GauntletCompletion {
  /** true when adjudication accepted at least one finding. */
  accepted: boolean;
  /**
   * `AdjudicationResult.gauntletComplete`: every mandatory reviewer AND the
   * deterministic item_probe AND the adjudication pass completed. NOT "the
   * finding list is empty".
   */
  complete: boolean;
  /** Why the run was incomplete. Carried for the passport, never for a decision. */
  incompleteReason?: string;
}

/**
 * The one function that decides what a gauntlet run may dispatch.
 *
 *   accepted                -> CHECKS_ACCEPTED  (something ran and it objected)
 *   !accepted && complete   -> GAUNTLET_CLEAN   (everything ran and nothing objected)
 *   !accepted && !complete  -> null             (nothing to say; NOT clean)
 *
 * The third row is the whole point. Three reviewers that all timed out accept
 * nothing, and an implementation that reads only `accepted` publishes that item.
 */
export function gauntletEventFor(
  completion: GauntletCompletion,
): Extract<StateEvent, 'CHECKS_ACCEPTED' | 'GAUNTLET_CLEAN'> | null {
  if (completion.accepted) return 'CHECKS_ACCEPTED';
  return completion.complete ? 'GAUNTLET_CLEAN' : null;
}

/**
 * Full transition for a finished run: enter the gauntlet if needed, then apply
 * the completion verdict. Every state returned comes out of `reduce`, so the
 * route can never report a state the machine would refuse.
 */
export function resolveGauntletState(
  current: ItemState,
  completion: GauntletCompletion,
): { state: ItemState; events: StateEvent[]; dispatchedEvent: StateEvent | null } {
  const entered = enterGauntlet(current);
  const event = gauntletEventFor(completion);
  if (event === null) {
    return { state: entered.state, events: entered.events, dispatchedEvent: null };
  }
  return {
    state: reduce(entered.state, event),
    events: [...entered.events, event],
    dispatchedEvent: event,
  };
}

/** Reads a completion verdict off an adjudication result. Never off a count alone. */
export function completionOf(adjudication: AdjudicationResult): GauntletCompletion {
  return {
    accepted: adjudication.checks.some((check) => check.status === 'accepted'),
    complete: adjudication.gauntletComplete,
    ...(adjudication.incompleteReason === undefined
      ? {}
      : { incompleteReason: adjudication.incompleteReason }),
  };
}

// ---------------------------------------------------------------------------
// Dependencies (the seam that makes this route testable without a key or a db)
// ---------------------------------------------------------------------------

/** One model call's compliance evidence (hard constraint 3). */
export interface ModelCallTelemetry {
  reviewerType?: string;
  callSite: 'orchestrator' | 'adjudication';
  /** The id the provider ECHOED, not the id that was requested. */
  modelId: string;
  modelFamilyOk: boolean;
  promptVersion: string;
  promptHash: string;
  latencyMs: number;
  tokensIn?: number;
  tokensOut?: number;
  schemaValid: boolean;
  /** Raw model output, kept as evidence. */
  raw?: string;
}

/**
 * The streaming orchestration seam.
 *
 * `runGauntlet` (src/reviewers/orchestrator.ts) resolves once ALL reviewers have
 * settled, which is correct for its job and useless for a stream. This wrapper
 * is what makes each reviewer visible the instant it lands: `onReviewerSettled`
 * MUST be called from the reviewer's own continuation, not from a loop over the
 * finished result — a route that emits three events after the last reviewer
 * returns is buffering, whatever the content-type says.
 */
export interface StreamingGauntletArgs {
  item: RawItem;
  model: string;
  config: EvalConfig;
  onReviewerSettled: (outcome: ReviewerOutcome, telemetry?: ModelCallTelemetry) => void;
}

export interface RunStartRecord {
  itemId: string;
  itemVersionId: string;
  config: EvalConfig;
  /** Persisted on the GauntletRun row itself — compliance is per run, not global. */
  compliance: boolean;
}

export interface RunCompletionRecord {
  gauntletRunId: string;
  itemId: string;
  itemVersionId: string;
  /** One ModelCall row each: reviewers plus the separate adjudication call. */
  modelCalls: ModelCallTelemetry[];
  /** One Check row each, with its contract stringified through toJson. */
  checks: AdjudicatedCheck[];
  /** `AdjudicationResult.nextState`, recorded as GauntletRun.adjudicationState. */
  adjudicationState: ItemState | null;
  /** The state AFTER `events` were applied; already validated through reduce(). */
  state: ItemState;
  events: StateEvent[];
  compliance: boolean;
}

export interface GauntletRouteDeps {
  /** EXACT reviewer model id. Compliance evidence. */
  reviewerModel: string;
  /** EXACT adjudicator model id. Compliance evidence. */
  adjudicatorModel: string;
  compliance: boolean;
  config: EvalConfig;
  /** Streams each reviewer as it settles; resolves when the batch is done. */
  runGauntlet(args: StreamingGauntletArgs): Promise<OrchestrationResult>;
  /**
   * The separate adjudication stage. Returns null ONLY for
   * `gauntlet-no-adjudication`, which is an eval config and never the product
   * path — a null here can therefore never authorize GAUNTLET_CLEAN.
   */
  adjudicate(
    orchestration: OrchestrationResult,
  ): Promise<{ result: AdjudicationResult; telemetry?: ModelCallTelemetry } | null>;
  /** Creates the GauntletRun row and returns its id. */
  createRun(record: RunStartRecord): Promise<{ gauntletRunId: string }>;
  /** Writes the ModelCall + Check rows, completedAt, and the new Item.state. */
  completeRun(record: RunCompletionRecord): Promise<void>;
}

/**
 * TODO(codex): wrap `runGauntlet` so each reviewer streams.
 *
 * `runGauntlet` awaits every reviewer before resolving. Pass it a `GauntletDeps`
 * bundle whose reviewer functions are the REAL ones wrapped in a `.then`/`.catch`
 * that calls `args.onReviewerSettled` immediately, so a fast reviewer reaches the
 * client while a slow one is still in flight. Emit the deterministic item_probe
 * the same way. Do NOT collect the outcomes and replay them afterwards.
 */
function streamingRunGauntlet(_args: StreamingGauntletArgs): Promise<OrchestrationResult> {
  void runGauntlet;
  throw new Error('TODO(codex): stream each reviewer outcome as it settles (doc §7.1)');
}

/**
 * TODO(codex): run the separate adjudication call and return its telemetry.
 *
 * Call `adjudicate(orchestration, adjudicatorModel, { delimitedItem })` — the
 * item text is ALREADY delimited by the orchestrator, so do not wrap it twice.
 * Return null only for the 'gauntlet-no-adjudication' eval config.
 */
function adjudicateWithTelemetry(
  _orchestration: OrchestrationResult,
): Promise<{ result: AdjudicationResult; telemetry?: ModelCallTelemetry } | null> {
  void adjudicate;
  throw new Error('TODO(codex): run the separate adjudication stage (doc §6.2)');
}

/**
 * TODO(codex): create the GauntletRun row.
 *
 * itemId, itemVersionId, config and `compliance` (already computed from
 * loadModelConfig() by the envelope — persist it, do not recompute it).
 * startedAt defaults; completedAt stays null until `completeRun`.
 */
function createRun(_record: RunStartRecord): Promise<{ gauntletRunId: string }> {
  throw new Error('TODO(codex): persist the GauntletRun row');
}

/**
 * TODO(codex): persist everything the run produced, in one place.
 *
 *  1. One ModelCall row per entry in `record.modelCalls`: exact modelId,
 *     modelFamilyOk, promptVersion, promptHash, latencyMs, tokensIn/Out,
 *     schemaValid, rawJson, callSite and gauntletRunId (hard constraint 3).
 *  2. One Check row per entry in `record.checks`: reviewerType,
 *     verificationKind, checkClass, status, schemaValid, contractJson via
 *     toJson, the invariantId/executorVersion/thresholdVersion identity when the
 *     class is executable, and a Citation row for a discipline finding that
 *     carries one.
 *  3. GauntletRun.adjudicationState = record.adjudicationState,
 *     GauntletRun.completedAt = now. `compliance` was already written by
 *     `createRun`; do not recompute it here.
 *  4. Item.state = record.state when `record.events` is non-empty. The state is
 *     already resolved through reduce(); do not recompute it, and write nothing
 *     when `events` is empty — that is the "nothing was dispatched" case.
 */
function completeRun(_record: RunCompletionRecord): Promise<void> {
  void toJson;
  throw new Error('TODO(codex): persist ModelCall + Check rows and close the GauntletRun');
}

/** Production wiring. Tests inject fakes through `handleGauntlet`'s second argument. */
export function productionDeps(): GauntletRouteDeps {
  const models = loadModelConfig();
  return {
    reviewerModel: models.reviewerModel,
    adjudicatorModel: models.adjudicatorModel,
    compliance: models.compliance,
    config: 'gauntlet',
    runGauntlet: streamingRunGauntlet,
    adjudicate: adjudicateWithTelemetry,
    createRun,
    completeRun,
  };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface PipelineContext {
  itemId: string;
  itemVersionId: string;
  itemState: ItemState;
  item: RawItem;
}

/**
 * TODO(codex): run the gauntlet and stream it.
 *
 *  1. `deps.createRun({ itemId, itemVersionId, config, compliance })`.
 *  2. `deps.runGauntlet({ ..., onReviewerSettled })`, and from INSIDE that
 *     callback `emit({ type: 'reviewer_result', ... })` with `degraded: !ok`.
 *     Do not wait for the batch: a fast reviewer must reach the client while a
 *     slow one is still running. A rejected reviewer emits `ok:false` with its
 *     `failureKind` and the run continues.
 *  3. `deps.adjudicate(orchestration)`, then `emit({ type: 'adjudication', ... })`
 *     carrying `gauntletComplete`.
 *  4. `resolveGauntletState(ctx.itemState, completionOf(adjudication))` — do NOT
 *     decide the event here; that function is the gate, and a null
 *     `dispatchedEvent` means the item stays in GAUNTLET.
 *  5. `deps.completeRun({ ... })` with every ModelCall telemetry collected in
 *     steps 2 and 3, and every adjudicated check.
 *  6. Return the summary for `run_completed`.
 *
 * NOTHING in here may throw for a partial failure: a dead reviewer is a
 * degraded lane, and the run still completes. Reference: doc §7.1, §6.2, §8.
 */
async function runGauntletPipeline(
  _emit: EmitFn,
  _ctx: PipelineContext,
  _deps: GauntletRouteDeps,
): Promise<Omit<RunCompletedEvent, 'type'>> {
  throw new Error(
    'TODO(codex): implement the gauntlet pipeline (runGauntlet -> adjudicate -> persist -> emit)',
  );
}

/**
 * The real handler. `POST` is a thin wrapper so Next.js gets the signature it
 * expects while tests can inject `GauntletRouteDeps`.
 */
export async function handleGauntlet(
  req: Request,
  deps: GauntletRouteDeps = productionDeps(),
): Promise<Response> {
  const config = loadIsolationConfig();
  let cookie: string | undefined;

  try {
    // Order matters: the rate limit gates the body read, not the other way round.
    const resolution = await getOrCreateSession(req, { config });
    cookie = resolution.cookie;
    assertRateLimit(resolution.session.id, { config });

    const body = parseBody(GauntletRequestSchema, await readJsonBody(req, config));

    // Ownership check IS the isolation boundary: another visitor's item is a 404,
    // never a 403, so the endpoint does not confirm that the id exists (doc §10).
    const item = await prisma.item.findFirst({
      where: { id: body.itemId, sessionId: resolution.session.id },
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
    });
    if (!item) throw notFound('Item not found in this session.');

    const version = item.versions[0];
    if (!version) throw notFound('Item has no version to review.');

    // Validate the transition BEFORE the stream opens, so an item at the wrong
    // stage gets a real 400 instead of a 200 carrying an error line.
    enterGauntlet(item.state as ItemState);

    const runStarted: RunStartedEvent = {
      type: 'run_started',
      itemId: item.id,
      itemVersionId: version.id,
      versionNumber: version.versionNumber,
      config: deps.config,
      reviewerModel: deps.reviewerModel,
      adjudicatorModel: deps.adjudicatorModel,
      compliance: deps.compliance,
    };

    const ctx: PipelineContext = {
      itemId: item.id,
      itemVersionId: version.id,
      itemState: item.state as ItemState,
      item: {
        stem: version.stem,
        options: fromJson<string[]>(version.optionsJson),
        correctKey: version.correctKey,
        authorRationale: version.authorRationale,
      },
    };

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit: EmitFn = (event) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };
        try {
          emit(runStarted);
          const summary = await runGauntletPipeline(emit, ctx, deps);
          emit({ type: 'run_completed', ...summary });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[api/gauntlet] pipeline failed', err);
          const detail = err instanceof Error ? err.message : String(err);
          emit({
            type: 'error',
            code: 'gauntlet_failed',
            message:
              process.env.NODE_ENV === 'production'
                ? 'The gauntlet run failed. See server logs.'
                : detail,
          });
        } finally {
          controller.close();
        }
      },
    });

    const headers = new Headers({
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      // Disables proxy buffering so partial reviewer results actually stream.
      'x-accel-buffering': 'no',
    });
    headers.append('set-cookie', cookie);
    return new Response(stream, { status: 200, headers });
  } catch (err) {
    return errorResponse(err, cookie);
  }
}

export async function POST(req: Request): Promise<Response> {
  return handleGauntlet(req);
}
