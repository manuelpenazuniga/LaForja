/**
 * POST /api/repair — submit a repair, creating a NEW ItemVersion and re-running
 * the FULL check history against it (doc §5, slice items 4 and 5).
 *
 * OWNER SPLIT:
 *  - Claude (this file, done): session resolution, rate limit, input size, Zod
 *    validation, the immutability guard, typed errors, and the by-class response
 *    grouping helper.
 *  - Codex: `applyRepair` below — new version, diff, reRunHistory, state event.
 *
 * IMMUTABILITY (doc §5): a published version is immutable. A repair is ALWAYS a
 * new version; nothing here may ever mutate an existing one.
 *
 * AUTHORIZED GUARANTEE TEXT (doc §5, do not paraphrase in UI copy):
 *  "Every repair re-runs all recorded counterexamples and checks. The system
 *   guarantees history execution and the non-regression of deterministic
 *   invariants; semantic judgments are re-adjudicated and shown in the passport."
 */
import { z } from 'zod';
import {
  ApiError,
  assertInputSizes,
  assertRateLimit,
  errorResponse,
  getOrCreateSession,
  jsonResponse,
  loadIsolationConfig,
  notFound,
  parseBody,
  readJsonBody,
} from '@/demo/isolation';
import { prisma } from '@/db/client';
import { reRunHistory, type ReRunOutcome } from '@/core/checks';
import type { CheckClass, ItemState } from '@/core/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const OPTION_KEYS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;

const RepairRequestSchema = z
  .object({
    itemId: z.string().min(1).max(64),
    stem: z.string().min(1),
    options: z.array(z.string().min(1)).min(2).max(OPTION_KEYS.length),
    correctKey: z.enum(OPTION_KEYS),
    authorRationale: z.string().min(1),
  })
  .strict()
  .refine((v) => OPTION_KEYS.indexOf(v.correctKey) < v.options.length, {
    message: 'correctKey must point at one of the supplied options',
    path: ['correctKey'],
  });

type RepairRequest = z.infer<typeof RepairRequestSchema>;

interface RepairResponse {
  itemId: string;
  /** The NEW version. The previous version is never modified. */
  newVersionId: string;
  versionNumber: number;
  /** Human-readable diff vs the previous version. */
  diff: string | null;
  reRun: {
    /** Every recorded check re-run, grouped by the class that fixes its promise. */
    byClass: Record<CheckClass, ReRunOutcome[]>;
    /** true when a deterministic/counterexample check regressed: no publish. */
    blocksPublish: boolean;
    total: number;
  };
  /** Item state after the history re-run (CHALLENGED on regression, else DEFENSE). */
  state: ItemState;
}

/**
 * Groups re-run outcomes by check class so the UI can show the three different
 * promises separately (doc §5). Pure — every class key is always present, even
 * when empty, so the UI never has to guard on undefined.
 */
function groupOutcomesByClass(outcomes: ReRunOutcome[]): Record<CheckClass, ReRunOutcome[]> {
  // Written out rather than derived so adding a check class to CHECK_CLASSES is
  // a COMPILE ERROR here instead of a silently missing group.
  const grouped: Record<CheckClass, ReRunOutcome[]> = {
    deterministic: [],
    counterexample: [],
    semantic: [],
  };
  for (const outcome of outcomes) {
    grouped[outcome.checkClass].push(outcome);
  }
  return grouped;
}

/**
 * TODO(codex): apply the repair.
 *
 *  1. Create a NEW ItemVersion (versionNumber = previous + 1) from `body`.
 *     NEVER mutate the previous version — the envelope has already rejected a
 *     repair aimed at an immutable version outside the dispute path.
 *  2. Compute the diff vs the previous version and store it in `diffJson`.
 *  3. Load the FULL recorded check history for this item (every accepted check
 *     from every earlier version) and call
 *     `reRunHistory(history, newVersion)` — the whole history, not just the
 *     latest run (doc §5).
 *  4. Persist one HistoryReRun row per outcome (itemVersionId = the NEW version,
 *     originalCheckId, checkClass, result, detailsJson).
 *  5. Dispatch through src/core/stateMachine: SUBMIT_REPAIR (or DISPUTE_REPAIR
 *     when the item is DISPUTED) to reach REGRESSION, then HISTORY_REGRESSED
 *     when `blocksPublish` is true, else HISTORY_CLEAN. Update Item.state and
 *     Item.currentVersionId.
 *  6. Return the outcomes; the envelope groups them with groupOutcomesByClass.
 *
 * Reference: doc §5, gate §13.3 (the exact check that broke v1 and passes v2).
 */
async function applyRepair(
  _body: RepairRequest,
  _previousVersionId: string,
): Promise<{
  newVersionId: string;
  versionNumber: number;
  diff: string | null;
  outcomes: ReRunOutcome[];
  blocksPublish: boolean;
  state: ItemState;
}> {
  void reRunHistory;
  throw new Error(
    'TODO(codex): implement repair (new ItemVersion -> diff -> reRunHistory -> state event)',
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

    const body = parseBody(RepairRequestSchema, await readJsonBody(req, config));

    // UNTRUSTED text (hard constraint 1): size-limit every field before it can
    // reach a prompt.
    assertInputSizes(
      {
        stem: body.stem,
        authorRationale: body.authorRationale,
        ...Object.fromEntries(
          body.options.map((opt, i): [string, string] => [`options[${i}]`, opt]),
        ),
      },
      config,
    );

    const item = await prisma.item.findFirst({
      where: { id: body.itemId, sessionId: resolution.session.id },
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
    });
    if (!item) throw notFound('Item not found in this session.');

    const previous = item.versions[0];
    if (!previous) throw notFound('Item has no version to repair.');

    // Published versions are IMMUTABLE. Repairing on top of one is legal only
    // through the dispute path (DISPUTED --DISPUTE_REPAIR--> REGRESSION), which
    // still produces a new version. Anything else is rejected here.
    if (previous.immutable && item.state !== 'DISPUTED') {
      throw new ApiError(
        400,
        'immutable_version',
        'This version is published and immutable. Open a dispute before repairing it.',
        { itemVersionId: previous.id, state: item.state },
      );
    }

    const result = await applyRepair(body, previous.id);

    const payload: RepairResponse = {
      itemId: item.id,
      newVersionId: result.newVersionId,
      versionNumber: result.versionNumber,
      diff: result.diff,
      reRun: {
        byClass: groupOutcomesByClass(result.outcomes),
        blocksPublish: result.blocksPublish,
        total: result.outcomes.length,
      },
      state: result.state,
    };
    return jsonResponse(payload, 200, cookie);
  } catch (err) {
    return errorResponse(err, cookie);
  }
}
