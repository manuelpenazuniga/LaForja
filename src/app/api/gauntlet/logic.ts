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
import { RecordedCheckRowSchema } from '@/core/checks';
import {
  DEFAULT_GAUNTLET_DEPS,
  REVIEWER_TIMEOUT_MS,
  runGauntlet,
  toDelimitedItem,
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
import { AMBIGUITY_PROMPT_VERSION, AMBIGUITY_SYSTEM } from '@/reviewers/ambiguity';
import { DISCIPLINE_PROMPT_VERSION, disciplineSystem } from '@/reviewers/discipline';
import { DisciplineIdSchema } from '@/core/disciplines';
import { reviewDistractorsWithTelemetry } from '@/reviewers/distractors';
import { AmbiguitySchema, DisciplineSchema } from '@/reviewers/schemas';
import { callModel, type ModelCallArgs, type ModelCallResult } from '@/openai/client';
import type { EvalConfig } from '@/eval/types';
import type {
  CheckClass,
  CheckStatus,
  ItemState,
  StateEvent,
  VerificationKind,
} from '@/core/types';

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

const delimitedItemByRun = new WeakMap<OrchestrationResult, string>();

/**
 * Run the existing concurrent orchestrator with call wrappers that report each
 * specialist and the deterministic probe from their own settlement path. Model
 * wrappers retain the exact call result so streaming and persistence share one
 * invocation rather than re-calling a reviewer for telemetry.
 */
async function streamingRunGauntlet(args: StreamingGauntletArgs): Promise<OrchestrationResult> {
  const delimitedItem = toDelimitedItem(args.item);

  const modelReviewer = <T>(
    reviewerType: 'ambiguity' | 'discipline' | 'distractor',
    review: (itemText: string, model: string) => Promise<ModelCallResult<T>>,
  ) => async (itemText: string, model: string): Promise<T> => {
    const startedAt = Date.now();
    try {
      const result = await review(itemText, model);
      args.onReviewerSettled(
        {
          reviewerType,
          ok: true,
          contract: result.data,
          latencyMs: result.latencyMs,
          schemaValid: result.schemaValid,
        },
        {
          reviewerType,
          callSite: 'orchestrator',
          modelId: result.modelId,
          modelFamilyOk: result.modelFamilyOk,
          promptVersion: result.promptVersion,
          promptHash: result.promptHash,
          latencyMs: result.latencyMs,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          schemaValid: result.schemaValid,
          raw: result.raw,
        },
      );
      return result.data;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const failureKind: ReviewerFailureKind = /timed out/iu.test(error)
        ? 'timeout'
        : /contract|schema|validation/iu.test(error)
          ? 'schema'
          : 'error';
      args.onReviewerSettled({
        reviewerType,
        ok: false,
        error,
        failureKind,
        latencyMs: Date.now() - startedAt,
        schemaValid: false,
      });
      throw err;
    }
  };

  const result = await runGauntlet(args.item, args.model, args.config, {
    ...DEFAULT_GAUNTLET_DEPS,
    reviewAmbiguity: modelReviewer(
      'ambiguity',
      (itemText, model) => callModel({
        model,
        system: AMBIGUITY_SYSTEM,
        delimitedItem: itemText,
        schema: AmbiguitySchema,
        promptVersion: AMBIGUITY_PROMPT_VERSION,
        callSite: 'orchestrator',
        reviewerType: 'ambiguity',
        timeoutMs: REVIEWER_TIMEOUT_MS,
      }),
    ),
    reviewDiscipline: modelReviewer(
      'discipline',
      (itemText, model) => callModel({
        model,
        // Per-item DOMAIN: a geometry item is reviewed under "DOMAIN: geometry
        // only", never the probability default.
        system: disciplineSystem(args.item.discipline),
        delimitedItem: itemText,
        schema: DisciplineSchema,
        promptVersion: DISCIPLINE_PROMPT_VERSION,
        callSite: 'orchestrator',
        reviewerType: 'discipline',
        timeoutMs: REVIEWER_TIMEOUT_MS,
      }),
    ),
    reviewDistractors: modelReviewer(
      'distractor',
      (itemText, model) => reviewDistractorsWithTelemetry(
        itemText,
        model,
        REVIEWER_TIMEOUT_MS,
      ),
    ),
    runItemProbe(input) {
      const startedAt = Date.now();
      try {
        const contract = DEFAULT_GAUNTLET_DEPS.runItemProbe(input);
        args.onReviewerSettled({
          reviewerType: 'item_probe',
          ok: true,
          contract,
          latencyMs: Date.now() - startedAt,
          schemaValid: true,
        });
        return contract;
      } catch (err) {
        args.onReviewerSettled({
          reviewerType: 'item_probe',
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          failureKind: 'error',
          latencyMs: Date.now() - startedAt,
          schemaValid: false,
        });
        throw err;
      }
    },
  });
  delimitedItemByRun.set(result, delimitedItem);
  return result;
}

/**
 * Run the separate adjudication with a capturing transport wrapper. The wrapper
 * delegates to the existing bounded call exactly once and exposes its telemetry
 * alongside the adjudication domain result.
 */
async function adjudicateWithTelemetry(
  orchestration: OrchestrationResult,
): Promise<{ result: AdjudicationResult; telemetry?: ModelCallTelemetry } | null> {
  if (orchestration.config === 'gauntlet-no-adjudication') return null;

  let captured: ModelCallResult<unknown> | undefined;
  const capture = async <T>(modelArgs: ModelCallArgs<T>): Promise<ModelCallResult<T>> => {
    const result = await callModel(modelArgs);
    captured = result as ModelCallResult<unknown>;
    return result;
  };
  const models = loadModelConfig();
  const result = await adjudicate(orchestration, models.adjudicatorModel, {
    callModel: capture,
    delimitedItem: delimitedItemByRun.get(orchestration),
  });
  return {
    result,
    ...(captured === undefined
      ? {}
      : {
          telemetry: {
            callSite: 'adjudication',
            modelId: captured.modelId,
            modelFamilyOk: captured.modelFamilyOk,
            promptVersion: captured.promptVersion,
            promptHash: captured.promptHash,
            latencyMs: captured.latencyMs,
            tokensIn: captured.tokensIn,
            tokensOut: captured.tokensOut,
            schemaValid: captured.schemaValid,
            raw: captured.raw,
          },
        }),
  };
}

/** Persist the run envelope before any reviewer result is emitted. */
async function createRun(record: RunStartRecord): Promise<{ gauntletRunId: string }> {
  const run = await prisma.gauntletRun.create({
    data: {
      itemId: record.itemId,
      itemVersionId: record.itemVersionId,
      config: record.config,
      compliance: record.compliance,
    },
    select: { id: true },
  });
  return { gauntletRunId: run.id };
}

/**
 * Atomically persist all call/check evidence, close the run, and apply only the
 * lifecycle state already resolved by the pipeline. Executable checks are
 * validated before storage so an incomplete identity cannot poison later
 * history re-execution.
 */
async function completeRun(record: RunCompletionRecord): Promise<void> {
  await prisma.$transaction(async (tx) => {
    for (const call of record.modelCalls) {
      await tx.modelCall.create({
        data: {
          gauntletRunId: record.gauntletRunId,
          callSite: call.callSite,
          reviewerType: call.reviewerType ?? null,
          modelId: call.modelId,
          modelFamilyOk: call.modelFamilyOk,
          promptVersion: call.promptVersion,
          promptHash: call.promptHash,
          latencyMs: call.latencyMs,
          tokensIn: call.tokensIn ?? null,
          tokensOut: call.tokensOut ?? null,
          schemaValid: call.schemaValid,
          rawJson: call.raw === undefined ? null : toJson(call.raw),
        },
      });
    }

    for (const check of record.checks) {
      RecordedCheckRowSchema.parse({ id: 'pending', ...check });
      const contract =
        check.contract !== null && typeof check.contract === 'object'
          ? (check.contract as { citation?: unknown })
          : undefined;
      const citation =
        contract?.citation !== null && typeof contract?.citation === 'object'
          ? (contract.citation as {
              source_id: string;
              version_date: string;
              license: string;
              excerpt: string;
              relevance: string;
            })
          : undefined;
      const citationRow =
        citation === undefined
          ? null
          : await tx.citation.create({
              data: {
                sourceId: citation.source_id,
                versionDate: citation.version_date,
                license: citation.license,
                excerpt: citation.excerpt,
                relevance: citation.relevance,
              },
              select: { id: true },
            });
      await tx.check.create({
        data: {
          itemVersionId: record.itemVersionId,
          gauntletRunId: record.gauntletRunId,
          reviewerType: check.reviewerType,
          verificationKind: check.verificationKind,
          checkClass: check.checkClass,
          status: check.status,
          schemaValid: check.schemaValid,
          contractJson: toJson(check.contract),
          invariantId: check.invariantId ?? null,
          executorVersion: check.executorVersion ?? null,
          thresholdVersion: check.thresholdVersion ?? null,
          citationId: citationRow?.id ?? null,
        },
      });
    }

    await tx.gauntletRun.update({
      where: { id: record.gauntletRunId },
      data: {
        adjudicationState: record.adjudicationState,
        completedAt: new Date(),
      },
    });
    if (record.events.length > 0) {
      await tx.item.update({
        where: { id: record.itemId },
        data: { state: record.state },
      });
    }
  });
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
 * Run one streamed gauntlet pass. Reviewer events are emitted directly from
 * the settlement callback, then the separate adjudication is gated through the
 * pure lifecycle resolver before the complete audit record is persisted.
 * Partial reviewer failures remain degraded lanes and never abort the pass.
 */
async function runGauntletPipeline(
  emit: EmitFn,
  ctx: PipelineContext,
  deps: GauntletRouteDeps,
): Promise<Omit<RunCompletedEvent, 'type'>> {
  const { gauntletRunId } = await deps.createRun({
    itemId: ctx.itemId,
    itemVersionId: ctx.itemVersionId,
    config: deps.config,
    compliance: deps.compliance,
  });

  const modelCalls: ModelCallTelemetry[] = [];
  const orchestration = await deps.runGauntlet({
    item: ctx.item,
    model: deps.reviewerModel,
    config: deps.config,
    onReviewerSettled(outcome, telemetry) {
      if (telemetry !== undefined) modelCalls.push(telemetry);
      emit({
        type: 'reviewer_result',
        reviewerType: outcome.reviewerType,
        ok: outcome.ok,
        degraded: !outcome.ok,
        schemaValid: outcome.schemaValid,
        latencyMs: outcome.latencyMs,
        ...(outcome.contract === undefined ? {} : { contract: outcome.contract }),
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
        ...(outcome.failureKind === undefined ? {} : { failureKind: outcome.failureKind }),
      });
    },
  });

  const adjudicated = await deps.adjudicate(orchestration);
  const adjudication: AdjudicationResult =
    adjudicated?.result ?? {
      checks: [],
      nextState: 'DEFENSE',
      abstained: 0,
      adjudicatorModelId: deps.adjudicatorModel,
      gauntletComplete: false,
      incompleteReason: 'adjudication did not complete.',
    };
  if (adjudicated?.telemetry !== undefined) modelCalls.push(adjudicated.telemetry);

  emit({
    type: 'adjudication',
    checks: adjudication.checks.map((check) => ({
      reviewerType: check.reviewerType,
      verificationKind: check.verificationKind,
      checkClass: check.checkClass,
      status: check.status,
      contract: check.contract,
      schemaValid: check.schemaValid,
      ...(check.note === undefined ? {} : { note: check.note }),
    })),
    nextState: adjudication.nextState,
    abstained: adjudication.abstained,
    gauntletComplete: adjudication.gauntletComplete,
    ...(adjudication.incompleteReason === undefined
      ? {}
      : { incompleteReason: adjudication.incompleteReason }),
  });

  const resolved = resolveGauntletState(ctx.itemState, completionOf(adjudication));
  await deps.completeRun({
    gauntletRunId,
    itemId: ctx.itemId,
    itemVersionId: ctx.itemVersionId,
    modelCalls,
    checks: adjudication.checks,
    adjudicationState: adjudication.nextState,
    state: resolved.state,
    events: resolved.events,
    compliance: deps.compliance,
  });

  return {
    gauntletRunId,
    state: resolved.state,
    dispatchedEvent: resolved.dispatchedEvent,
    acceptedChecks: adjudication.checks.filter((check) => check.status === 'accepted').length,
    compliance: deps.compliance,
  };
}

/**
 * Map a pipeline failure to a CLIENT-SAFE error event. Provider, database and
 * credential DETAILS never cross this public boundary (the message is authored
 * here, never the raw provider text), but the CATEGORY of a quota / rate-limit
 * failure is safe to name — and "top up billing and retry" is far more
 * actionable to an author than "see server logs". The raw error is still logged
 * server-side by the caller.
 */
export function gauntletErrorEvent(err: unknown): ErrorEvent {
  const text = err instanceof Error ? err.message : String(err);
  if (/insufficient_quota|exceeded your current quota|\bquota\b|billing/i.test(text)) {
    return {
      type: 'error',
      code: 'model_quota_exhausted',
      message:
        'The AI model budget is exhausted — the provider returned an out-of-quota error. Top up the OpenAI billing, then run the gauntlet again.',
    };
  }
  if (/rate.?limit|too many requests|\b429\b/i.test(text)) {
    return {
      type: 'error',
      code: 'model_rate_limited',
      message: 'The AI model is rate-limited right now. Wait a moment, then run the gauntlet again.',
    };
  }
  return { type: 'error', code: 'gauntlet_failed', message: 'The gauntlet run failed. See server logs.' };
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
        // Trusted author metadata from the DB row: selects the bounded solver and
        // the discipline reviewer's DOMAIN. Validated here at the DB→domain edge.
        discipline: DisciplineIdSchema.parse(item.discipline),
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
          emit(gauntletErrorEvent(err));
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
