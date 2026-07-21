/**
 * POST /api/repair — submit a repair, creating a NEW ItemVersion and re-running
 * the FULL check history against it (doc §5, slice items 4 and 5).
 *
 * OWNER SPLIT:
 *  - Claude (this file, done): session resolution, rate limit, input size, Zod
 *    validation, the immutability guard, typed errors, the by-class response
 *    grouping helper, and the PURE lifecycle resolution
 *    (`repairEntryEventFor` / `historyEventFor` / `resolveRepairState`).
 *  - Codex: `applyRepair` below — new version, diff, reRunHistory, persistence.
 *
 * IMMUTABILITY (doc §5): a published version is immutable. A repair is ALWAYS a
 * new version; nothing here may ever mutate an existing one.
 *
 * AUTHORIZED GUARANTEE TEXT (doc §5, do not paraphrase in UI copy):
 *  "Every repair re-runs all recorded counterexamples and checks. The system
 *   guarantees history execution and the non-regression of deterministic
 *   invariants; semantic judgments are re-adjudicated and shown in the passport."
 *
 * ---------------------------------------------------------------------------
 * THE FAIL-OPEN THIS ROUTE MUST NOT REINTRODUCE
 * ---------------------------------------------------------------------------
 * `reRunHistory` takes `expectedCheckCount` as a REQUIRED parameter precisely so
 * the count cannot be derived from the array the loop iterates. A truncated or
 * failed load then arrives as a short array, the loop produces exactly as many
 * outcomes as it was handed, and the batch would report 'complete' — authorising
 * HISTORY_CLEAN on a history that was never read. The count therefore comes from
 * `RepairDeps.countRecordedChecks`, an INDEPENDENT count query, and is passed
 * through untouched. Never `history.length`.
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
import { reduce } from '@/core/stateMachine';
import {
  RecordedCheckRowSchema,
  reRunHistory,
  type HistoryRunBatch,
  type RecordedCheck,
  type ReRunOutcome,
} from '@/core/checks';
import type { CheckClass, ItemState, StateEvent } from '@/core/types';

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

export type RepairRequest = z.infer<typeof RepairRequestSchema>;

export interface RepairResponse {
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
 * NOTHING IDENTIFYING MAY BE ADDED TO THIS TYPE.
 *
 * No session id, no pseudonym, no model id, no raw model output, no prompt text
 * (doc §10 + hard constraint 8). The only author-facing field in the system is a
 * random pseudonym, and it belongs to /api/session.
 */

/**
 * Groups re-run outcomes by check class so the UI can show the three different
 * promises separately (doc §5). Pure — every class key is always present, even
 * when empty, so the UI never has to guard on undefined.
 */
export function groupOutcomesByClass(outcomes: ReRunOutcome[]): Record<CheckClass, ReRunOutcome[]> {
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

// ---------------------------------------------------------------------------
// Pure lifecycle resolution (Claude-owned; cross-checked against reduce())
// ---------------------------------------------------------------------------

/**
 * How this item reaches REGRESSION. A CHALLENGED item repairs normally; a
 * DISPUTED one takes the post-publication path — which still produces a NEW
 * version, never a mutation. Every other state has no repair to apply and is a
 * 400, not a 500.
 */
export function repairEntryEventFor(current: ItemState): Extract<StateEvent, 'SUBMIT_REPAIR' | 'DISPUTE_REPAIR'> {
  if (current === 'CHALLENGED') return 'SUBMIT_REPAIR';
  if (current === 'DISPUTED') return 'DISPUTE_REPAIR';
  throw badRequest('This item has nothing to repair.', { state: current });
}

/**
 * The batch gate, stated once.
 *
 * HISTORY_CLEAN requires a COMPLETE batch in which every expected check produced
 * an outcome AND nothing blocks. Anything else — incomplete, failed, or a single
 * blocking outcome — is HISTORY_REGRESSED. An incomplete batch is
 * indistinguishable from "nothing was checked", and §5 forbids treating that as
 * clean, so it must NOT fall through to the publishing branch.
 */
export function historyEventFor(
  batch: HistoryRunBatch,
): Extract<StateEvent, 'HISTORY_CLEAN' | 'HISTORY_REGRESSED'> {
  const complete =
    batch.status === 'complete' &&
    batch.completedCheckCount === batch.expectedCheckCount &&
    batch.outcomes.length === batch.expectedCheckCount;
  return complete && !batch.blocksPublish ? 'HISTORY_CLEAN' : 'HISTORY_REGRESSED';
}

/**
 * Full transition for a repair: enter REGRESSION, then apply the batch verdict.
 * Every state returned comes out of `reduce`, so the route can never report a
 * state the machine would refuse.
 */
export function resolveRepairState(
  current: ItemState,
  batch: HistoryRunBatch,
): { state: ItemState; events: StateEvent[] } {
  const entry = repairEntryEventFor(current);
  const regression = reduce(current, entry);
  const verdict = historyEventFor(batch);
  return { state: reduce(regression, verdict), events: [entry, verdict] };
}

// ---------------------------------------------------------------------------
// Dependencies (the seam that makes this route testable without a database)
// ---------------------------------------------------------------------------

/** The version being repaired. Read-only here — it is never written again. */
export interface PreviousVersion {
  id: string;
  versionNumber: number;
  stem: string;
  optionsJson: string;
  correctKey: string;
  authorRationale: string;
  immutable: boolean;
}

export interface NewVersionRecord {
  itemId: string;
  /**
   * STORED, not inferred. The diff base is a real foreign key
   * (ItemVersion.previousVersionId); deriving it from `versionNumber - 1` breaks
   * the moment a version is skipped, withdrawn, or created out of order, and the
   * passport would then show a diff against the wrong text.
   */
  previousVersionId: string;
  versionNumber: number;
  stem: string;
  options: string[];
  correctKey: string;
  authorRationale: string;
  /** Recorded alongside the base, in ItemVersion.diffJson. */
  diff: string;
}

export interface CreatedVersion {
  id: string;
  versionNumber: number;
}

export interface HistoryRunRecord {
  itemId: string;
  /** The NEW version the history was re-run against. */
  newVersionId: string;
  /** Persisted whole: the batch row AND one HistoryReRun row per outcome. */
  batch: HistoryRunBatch;
  /** The state AFTER `events` were applied; already validated through reduce(). */
  state: ItemState;
  events: StateEvent[];
}

export interface RepairDeps {
  /** Creates the NEW ItemVersion. MUST NOT touch the previous row. */
  createVersion(record: NewVersionRecord): Promise<CreatedVersion>;
  /**
   * The FULL recorded check history for the item — every accepted check from
   * every earlier version, not just the latest run (doc §5).
   */
  loadRecordedHistory(itemId: string): Promise<RecordedCheck[]>;
  /**
   * An INDEPENDENT count of those same rows (a COUNT query), used as
   * `reRunHistory`'s `expectedCheckCount`. It exists to disagree with a
   * truncated load. Deriving it from `loadRecordedHistory(...).length` recreates
   * the fail-open the parameter was added to close.
   */
  countRecordedChecks(itemId: string): Promise<number>;
  /** Writes HistoryRunBatch + HistoryReRun rows, Item.state and Item.currentVersionId. */
  recordHistoryRun(record: HistoryRunRecord): Promise<void>;
}

/** Create a new immutable-lineage child without ever updating its diff base. */
async function createVersion(record: NewVersionRecord): Promise<CreatedVersion> {
  const version = await prisma.itemVersion.create({
    data: {
      itemId: record.itemId,
      previousVersionId: record.previousVersionId,
      versionNumber: record.versionNumber,
      stem: record.stem,
      optionsJson: toJson(record.options),
      correctKey: record.correctKey,
      authorRationale: record.authorRationale,
      diffJson: toJson(record.diff),
      immutable: false,
    },
    select: { id: true, versionNumber: true },
  });
  return version;
}

/**
 * Load every accepted check across the item's full lineage and validate the
 * persisted taxonomy and executable identity before rebuilding domain records.
 */
async function loadRecordedHistory(itemId: string): Promise<RecordedCheck[]> {
  const rows = await prisma.check.findMany({
    where: { status: 'accepted', itemVersion: { itemId } },
    orderBy: { createdAt: 'asc' },
  });

  return rows.map((row): RecordedCheck => {
    const parsed = RecordedCheckRowSchema.parse(row);
    const base = {
      id: parsed.id,
      reviewerType: parsed.reviewerType,
      verificationKind: parsed.verificationKind,
      contract: fromJson<unknown>(row.contractJson),
    };
    if (parsed.checkClass === 'semantic') {
      return { ...base, checkClass: 'semantic' };
    }
    if (
      parsed.invariantId === null || parsed.invariantId === undefined ||
      parsed.executorVersion === null || parsed.executorVersion === undefined ||
      parsed.thresholdVersion === null || parsed.thresholdVersion === undefined
    ) {
      throw new Error(`Executable check '${parsed.id}' has incomplete identity`);
    }
    return {
      ...base,
      checkClass: parsed.checkClass,
      invariantId: parsed.invariantId,
      executorVersion: parsed.executorVersion,
      thresholdVersion: parsed.thresholdVersion,
    };
  });
}

/**
 * Count the same accepted rows with an independent database aggregate so a
 * truncated object load remains observable by the history gate.
 */
function countRecordedChecks(itemId: string): Promise<number> {
  return prisma.check.count({ where: { status: 'accepted', itemVersion: { itemId } } });
}

/**
 * Persist the batch evidence, every per-check outcome, and the resolved item
 * pointer/state atomically. Batch counts and status are copied verbatim from the
 * fail-closed engine rather than recomputed at the storage boundary.
 */
async function recordHistoryRun(record: HistoryRunRecord): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const batch = await tx.historyRunBatch.create({
      data: {
        itemVersionId: record.newVersionId,
        expectedCheckCount: record.batch.expectedCheckCount,
        completedCheckCount: record.batch.completedCheckCount,
        status: record.batch.status,
        blocksPublish: record.batch.blocksPublish,
        startedAt: new Date(record.batch.startedAt),
        completedAt:
          record.batch.completedAt === null ? null : new Date(record.batch.completedAt),
      },
    });

    for (const outcome of record.batch.outcomes) {
      const detailsJson =
        'verdict' in outcome
          ? toJson({
              verdict: outcome.verdict,
              ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
            })
          : outcome.detail === undefined
            ? null
            : toJson(outcome.detail);
      await tx.historyReRun.create({
        data: {
          batchId: batch.id,
          itemVersionId: record.newVersionId,
          originalCheckId: outcome.originalCheckId,
          checkClass: outcome.checkClass,
          result: outcome.result,
          detailsJson,
        },
      });
    }

    await tx.item.update({
      where: { id: record.itemId },
      data: { state: record.state, currentVersionId: record.newVersionId },
    });
  });
}

/** Production wiring. Tests inject fakes through `handleRepair`'s second argument. */
export function productionDeps(): RepairDeps {
  return { createVersion, loadRecordedHistory, countRecordedChecks, recordHistoryRun };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface RepairOutcome {
  newVersionId: string;
  versionNumber: number;
  diff: string | null;
  batch: HistoryRunBatch;
  state: ItemState;
  events: StateEvent[];
}

/**
 * Create the repaired child version, execute the independently counted full
 * history against it, and persist the state selected by the canonical history
 * gate. The previous version is only read while constructing the recorded diff.
 */
async function applyRepair(
  body: RepairRequest,
  previous: PreviousVersion,
  itemState: ItemState,
  deps: RepairDeps,
): Promise<RepairOutcome> {
  const previousOptions = fromJson<string[]>(previous.optionsJson);
  const changes: string[] = [];
  if (previous.stem !== body.stem) {
    changes.push(`stem: ${JSON.stringify(previous.stem)} -> ${JSON.stringify(body.stem)}`);
  }
  if (JSON.stringify(previousOptions) !== JSON.stringify(body.options)) {
    changes.push(
      `options: ${JSON.stringify(previousOptions)} -> ${JSON.stringify(body.options)}`,
    );
  }
  if (previous.correctKey !== body.correctKey) {
    changes.push(`correctKey: ${previous.correctKey} -> ${body.correctKey}`);
  }
  if (previous.authorRationale !== body.authorRationale) {
    changes.push(
      `authorRationale: ${JSON.stringify(previous.authorRationale)} -> ${JSON.stringify(body.authorRationale)}`,
    );
  }
  const diff = changes.length === 0 ? 'No content changes.' : changes.join('\n');

  const created = await deps.createVersion({
    itemId: body.itemId,
    previousVersionId: previous.id,
    versionNumber: previous.versionNumber + 1,
    stem: body.stem,
    options: body.options,
    correctKey: body.correctKey,
    authorRationale: body.authorRationale,
    diff,
  });

  const [history, expectedCheckCount] = await Promise.all([
    deps.loadRecordedHistory(body.itemId),
    deps.countRecordedChecks(body.itemId),
  ]);
  const batch = reRunHistory(
    history,
    {
      id: created.id,
      versionNumber: created.versionNumber,
      stem: body.stem,
      options: body.options,
      correctKey: body.correctKey,
      authorRationale: body.authorRationale,
    },
    expectedCheckCount,
  );
  const resolved = resolveRepairState(itemState, batch);

  await deps.recordHistoryRun({
    itemId: body.itemId,
    newVersionId: created.id,
    batch,
    state: resolved.state,
    events: resolved.events,
  });

  return {
    newVersionId: created.id,
    versionNumber: created.versionNumber,
    diff,
    batch,
    state: resolved.state,
    events: resolved.events,
  };
}

/**
 * The real handler. `POST` is a thin wrapper so Next.js gets the signature it
 * expects while tests can inject `RepairDeps`.
 */
export async function handleRepair(
  req: Request,
  deps: RepairDeps = productionDeps(),
): Promise<Response> {
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

    const itemState = item.state as ItemState;

    // Published versions are IMMUTABLE. Repairing on top of one is legal only
    // through the dispute path (DISPUTED --DISPUTE_REPAIR--> REGRESSION), which
    // still produces a new version. Anything else is rejected here.
    if (previous.immutable && itemState !== 'DISPUTED') {
      throw new ApiError(
        400,
        'immutable_version',
        'This version is published and immutable. Open a dispute before repairing it.',
        { itemVersionId: previous.id, state: itemState },
      );
    }

    // Validate the transition BEFORE any row is written, so an item with nothing
    // to repair never creates an orphan version.
    repairEntryEventFor(itemState);

    let result: RepairOutcome;
    try {
      result = await applyRepair(
        body,
        {
          id: previous.id,
          versionNumber: previous.versionNumber,
          stem: previous.stem,
          optionsJson: previous.optionsJson,
          correctKey: previous.correctKey,
          authorRationale: previous.authorRationale,
          immutable: previous.immutable,
        },
        itemState,
        deps,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[api/repair] pipeline failed', err);
      throw new ApiError(
        500,
        'internal_error',
        'The repair could not be saved. Retry in a moment.',
      );
    }

    const payload: RepairResponse = {
      itemId: item.id,
      newVersionId: result.newVersionId,
      versionNumber: result.versionNumber,
      diff: result.diff,
      reRun: {
        byClass: groupOutcomesByClass(result.batch.outcomes),
        blocksPublish: result.batch.blocksPublish,
        total: result.batch.outcomes.length,
      },
      state: result.state,
    };
    return jsonResponse(payload, 200, cookie);
  } catch (err) {
    return errorResponse(err, cookie);
  }
}
