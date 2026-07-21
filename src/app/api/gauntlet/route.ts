/**
 * POST /api/gauntlet — run the gauntlet over an item's current version and
 * STREAM partial reviewer results back (doc §7.1, slice item 2).
 *
 * OWNER SPLIT:
 *  - Claude (this file, done): session resolution, rate limit, input size, Zod
 *    validation, ownership check, typed errors, the GPT-5.6 compliance record,
 *    and the newline-delimited-JSON streaming scaffolding.
 *  - Codex: `runGauntletPipeline` below — orchestration, adjudication and
 *    persistence. Codex only has to push events through `emit`.
 *
 * WIRE FORMAT: newline-delimited JSON (`application/x-ndjson`). One JSON object
 * per line, so the UI can render each reviewer the moment it lands and a partial
 * reviewer failure never breaks the experience (doc §7.1 "fallas parciales no
 * rompen la experiencia").
 *
 * STATUS-CODE NOTE: envelope failures (400/404/413/429) are answered BEFORE the
 * stream opens, with a real status code. Once the stream is open the status is
 * already 200, so a downstream failure arrives as a terminal `error` event.
 */
import { z } from 'zod';
import {
  assertRateLimit,
  errorResponse,
  getOrCreateSession,
  loadIsolationConfig,
  notFound,
  parseBody,
  readJsonBody,
} from '@/demo/isolation';
import { fromJson, prisma } from '@/db/client';
import { loadModelConfig } from '@/config/models';
import { runGauntlet, type RawItem } from '@/reviewers/orchestrator';
import { adjudicate } from '@/reviewers/adjudication';
import type { EvalConfig } from '@/eval/types';
import type { CheckClass, CheckStatus, ItemState, ReviewerType } from '@/core/types';

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

interface RunStartedEvent {
  type: 'run_started';
  itemId: string;
  itemVersionId: string;
  versionNumber: number;
  config: EvalConfig;
  /** EXACT model ids — compliance evidence, recorded on every run. */
  reviewerModel: string;
  adjudicatorModel: string;
  /** false when a model id is outside the gpt-5.6 family. */
  compliance: boolean;
}

interface ReviewerResultEvent {
  type: 'reviewer_result';
  reviewerType: ReviewerType;
  ok: boolean;
  schemaValid: boolean;
  latencyMs: number;
  contract?: unknown;
  error?: string;
}

interface AdjudicationEvent {
  type: 'adjudication';
  checks: {
    reviewerType: string;
    checkClass: CheckClass;
    status: CheckStatus;
    contract: unknown;
    schemaValid: boolean;
    note?: string;
  }[];
  nextState: Extract<ItemState, 'CHALLENGED' | 'DEFENSE'>;
  abstained: number;
}

interface RunCompletedEvent {
  type: 'run_completed';
  gauntletRunId: string;
  state: ItemState;
  acceptedChecks: number;
  compliance: boolean;
}

interface ErrorEvent {
  type: 'error';
  code: string;
  message: string;
}

type GauntletEvent =
  | RunStartedEvent
  | ReviewerResultEvent
  | AdjudicationEvent
  | RunCompletedEvent
  | ErrorEvent;

type EmitFn = (event: GauntletEvent) => void;

interface PipelineContext {
  itemId: string;
  itemVersionId: string;
  item: RawItem;
  reviewerModel: string;
  adjudicatorModel: string;
  /** Persisted on the GauntletRun and on every ModelCall row. */
  compliance: boolean;
  config: RunStartedEvent['config'];
}

/**
 * TODO(codex): run the gauntlet and stream it.
 *
 *  1. Create the GauntletRun row for `ctx.itemVersionId` with
 *     `config: ctx.config` and `compliance: ctx.compliance` (already computed
 *     from loadModelConfig() by the envelope — just persist it).
 *  2. Call `runGauntlet(ctx.item, ctx.reviewerModel, ctx.config)` (three
 *     concurrent Responses calls + the deterministic item_probe, doc §7.1).
 *     As EACH reviewer settles, `emit({ type: 'reviewer_result', ... })` — do
 *     not wait for all three. A rejected reviewer emits `ok:false` with its
 *     error and the run continues (partial failure must not break the run).
 *  3. Persist one ModelCall row per call: exact modelId, modelFamilyOk,
 *     promptVersion, promptHash, latencyMs, tokensIn/Out, schemaValid, rawJson
 *     (hard constraint 3).
 *  4. Call `adjudicate(orchestration, ctx.adjudicatorModel)` unless
 *     `ctx.config === 'gauntlet-no-adjudication'`, then
 *     `emit({ type: 'adjudication', ... })`.
 *  5. Persist a Check row per adjudicated finding (reviewerType, checkClass,
 *     status, schemaValid, contractJson via toJson, citation when discipline).
 *  6. Dispatch the state event through src/core/stateMachine: CHECKS_ACCEPTED
 *     when any check is accepted, else GAUNTLET_CLEAN. Update Item.state.
 *  7. Set GauntletRun.completedAt and return the summary for `run_completed`.
 *
 * Reference: doc §7.1, §6.2, §8; hard constraint 3.
 */
async function runGauntletPipeline(
  _emit: EmitFn,
  _ctx: PipelineContext,
): Promise<Omit<RunCompletedEvent, 'type'>> {
  void runGauntlet;
  void adjudicate;
  throw new Error(
    'TODO(codex): implement the gauntlet pipeline (runGauntlet -> adjudicate -> persist -> emit)',
  );
}

export async function POST(req: Request): Promise<Response> {
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

    const models = loadModelConfig();

    const runStarted: RunStartedEvent = {
      type: 'run_started',
      itemId: item.id,
      itemVersionId: version.id,
      versionNumber: version.versionNumber,
      config: 'gauntlet',
      reviewerModel: models.reviewerModel,
      adjudicatorModel: models.adjudicatorModel,
      compliance: models.compliance,
    };

    const ctx: PipelineContext = {
      itemId: item.id,
      itemVersionId: version.id,
      item: {
        stem: version.stem,
        options: fromJson<string[]>(version.optionsJson),
        correctKey: version.correctKey,
        authorRationale: version.authorRationale,
      },
      reviewerModel: models.reviewerModel,
      adjudicatorModel: models.adjudicatorModel,
      compliance: models.compliance,
      config: 'gauntlet',
    };

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit: EmitFn = (event) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };
        try {
          emit(runStarted);
          const summary = await runGauntletPipeline(emit, ctx);
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
