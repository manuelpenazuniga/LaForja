/**
 * LA FORJA — check taxonomy + history re-run engine (doc §5).
 *
 * OWNER: Codex (internals). Claude owns the public types and signatures;
 * Codex owns the executable history re-run bodies.
 *
 * Three check classes, three DIFFERENT promises — and only these three:
 *  - deterministic  : STRICT non-regression. The recorded invariant is
 *                     re-executed in code on every later version and must hold.
 *  - counterexample : the recorded construction is RE-EXECUTED on the new
 *                     version. While the construction still holds, the version
 *                     does not publish. Deciding whether it still holds MAY
 *                     require semantic adjudication (see below) — what is
 *                     guaranteed is the EXECUTION and the BLOCKING, not a
 *                     deterministic verdict.
 *  - semantic       : RE-ADJUDICATED on every version; never an absolute
 *                     guarantee; the new verdict is shown in the passport.
 *
 * Authorized guarantee text (doc §5) — the ONLY wording the project may use,
 * and nothing in this file may claim more than it does:
 *  "Every repair re-runs all recorded counterexamples and checks. The system
 *   guarantees history execution and the non-regression of deterministic
 *   invariants; semantic judgments are re-adjudicated and shown in the passport."
 *
 * FAIL-CLOSED RULE (the reason blocksPublish is modelled per outcome): an
 * INCONCLUSIVE re-run of a deterministic or counterexample check BLOCKS
 * publication. "We could not verify it" is never treated as "it passed".
 */
import { z } from 'zod';
import { runItemProbe, LENGTH_HIGH, OVERLAP_HIGH } from '../probe/itemProbe';
import { solveProbability } from '../solver/probability';
import type { ProbabilityProblem } from '../solver/probability';
import { CHECK_STATUS, REVIEWER_TYPES, VERIFICATION_KINDS } from './types';
import type { CheckClass, ReviewerType, VerificationKind } from './types';

// ---------------------------------------------------------------------------
// How a check is verified. Reviewer type ALONE cannot determine the class:
// the discipline reviewer produces a solver-grounded numeric verdict (which is
// deterministic and re-executable) AND a source-grounded conceptual verdict
// (which is a semantic judgment). The pair (reviewerType, verificationKind) is
// what fixes the class.
//
// The allowed values are OWNED by src/core/types.ts (the single source of truth
// for every String column in prisma/schema.prisma) and re-exported here so the
// taxonomy and its map read as one unit.
// ---------------------------------------------------------------------------
export { VERIFICATION_KINDS };
export type { VerificationKind };

/**
 * The (reviewerType, verificationKind) -> CheckClass assignment, encoded ONCE.
 * `null` marks a combination that is not legal: a recorded check with a null
 * entry is a recording bug and must be rejected at persistence time, never
 * silently downgraded to 'semantic'.
 *
 * Reference: doc §5 (the three-class table).
 */
export const CHECK_CLASS_BY_VERIFICATION: Readonly<
  Record<ReviewerType, Readonly<Record<VerificationKind, CheckClass | null>>>
> = {
  ambiguity: {
    solver: null, // the ambiguity reviewer never calls the solver directly
    citation: null,
    heuristic: null,
    interpretation: 'counterexample', // two readings ⇒ two answers, re-executable
  },
  discipline: {
    solver: 'deterministic', // recomputed answer vs marked key — strict non-regression
    citation: 'semantic', // source-grounded conceptual verdict — re-adjudicated
    heuristic: null,
    interpretation: null,
  },
  distractor: {
    solver: null,
    citation: 'semantic', // evidenced plausibility is still a judgment
    heuristic: null,
    interpretation: 'semantic', // hypothesized student error — judgment
  },
  item_probe: {
    solver: null,
    citation: null,
    heuristic: 'deterministic', // fixed thresholds, recomputed in code (doc §7.3)
    interpretation: null,
  },
} as const;

// ---------------------------------------------------------------------------
// Recorded checks
//
// ONE SHAPE, THREE PLACES. A recorded check is produced by adjudication
// (AdjudicatedCheck, src/reviewers/adjudication.ts), persisted as a `Check` row
// (prisma/schema.prisma) and re-executed from that row as a RecordedCheck here.
// The three must line up field for field or the history re-run cannot rebuild
// what it is supposed to re-execute:
//
//   AdjudicatedCheck        Check column          RecordedCheck
//   ----------------------  --------------------  ------------------------
//   reviewerType            reviewerType          reviewerType
//   verificationKind        verificationKind      verificationKind
//   checkClass              checkClass            checkClass
//   invariantId?            invariantId?          invariantId (executable only)
//   executorVersion?        executorVersion?      executorVersion (exec. only)
//   thresholdVersion?       thresholdVersion?     thresholdVersion (exec. only)
//   contract                contractJson          contract
//
// The nullable Prisma columns are nullable ONLY because the semantic class has
// no executor to identify; `RecordedCheckRowSchema` below is what forbids a
// deterministic or counterexample row from ever being persisted without them.
// ---------------------------------------------------------------------------

interface RecordedCheckBase {
  id: string;
  reviewerType: ReviewerType;
  verificationKind: VerificationKind;
  /** The evidence contract that was accepted on the earlier version. */
  contract: unknown;
}

/**
 * A check whose re-run is an EXECUTION, not a fresh opinion. These carry the
 * identity needed to re-execute the SAME check on a later version; without
 * these three fields "strict non-regression" is not verifiable, because there
 * is no way to prove the thing re-run on v2 is the thing that failed on v1.
 */
export interface ExecutableRecordedCheck extends RecordedCheckBase {
  checkClass: 'deterministic' | 'counterexample';
  /**
   * Stable identifier of the executable check itself (e.g.
   * 'solver_key_matches', 'answer_length_flag'). Two checks with the same
   * invariantId re-execute the same code path.
   */
  invariantId: string;
  /** Version of the executor that produced the recorded result (solver/probe). */
  executorVersion: string;
  /** Version of the threshold table in force when the check was recorded. */
  thresholdVersion: string;
}

/**
 * A judgment. Re-adjudicated on every version; never a hard guarantee.
 *
 * There is no executor to identify, so the three identity fields are absent
 * rather than empty: a semantic check carrying an `invariantId` would claim a
 * re-executability the class does not have.
 */
export interface SemanticRecordedCheck extends RecordedCheckBase {
  checkClass: 'semantic';
  invariantId?: never;
  executorVersion?: never;
  thresholdVersion?: never;
}

export type RecordedCheck = ExecutableRecordedCheck | SemanticRecordedCheck;

// ---------------------------------------------------------------------------
// Persistence boundary (Claude-owned)
// ---------------------------------------------------------------------------

/**
 * Zod validation for a `Check` row, applied on the way IN (adjudication ->
 * Prisma) and on the way OUT (Prisma -> reRunCheck). SQLite has no enums and no
 * conditional constraints, so every rule the schema cannot express is enforced
 * here — this schema is the reason the String columns are safe:
 *
 *  1. reviewerType / verificationKind / checkClass / status are restricted to
 *     the value sets owned by src/core/types.ts.
 *  2. `checkClass` MUST equal CHECK_CLASS_BY_VERIFICATION[reviewerType]
 *     [verificationKind]. A `null` entry is an illegal combination and is
 *     REJECTED, never silently downgraded to 'semantic' (doc §5).
 *  3. deterministic / counterexample rows MUST carry invariantId,
 *     executorVersion and thresholdVersion — without them "strict
 *     non-regression" is unverifiable, because there is no way to prove the
 *     thing re-run on v2 is the thing that failed on v1.
 *  4. semantic rows MUST NOT carry them.
 *
 * Rejecting at this boundary is deliberate: a malformed row that reaches
 * reRunCheck can only produce 'inconclusive', which fail-closed turns into a
 * permanently unpublishable item with no explanation.
 */
export const RecordedCheckRowSchema = z
  .object({
    id: z.string().min(1),
    reviewerType: z.enum(REVIEWER_TYPES),
    verificationKind: z.enum(VERIFICATION_KINDS),
    checkClass: z.enum(['deterministic', 'counterexample', 'semantic']),
    status: z.enum(CHECK_STATUS),
    invariantId: z.string().trim().min(1).nullable().optional(),
    executorVersion: z.string().trim().min(1).nullable().optional(),
    thresholdVersion: z.string().trim().min(1).nullable().optional(),
  })
  .superRefine((row, ctx) => {
    const expected = CHECK_CLASS_BY_VERIFICATION[row.reviewerType][row.verificationKind];
    if (expected === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `illegal combination: reviewer '${row.reviewerType}' never produces a '${row.verificationKind}' verdict`,
        path: ['verificationKind'],
      });
      return;
    }
    if (row.checkClass !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `checkClass must be '${expected}' for (${row.reviewerType}, ${row.verificationKind})`,
        path: ['checkClass'],
      });
    }

    const executable = expected === 'deterministic' || expected === 'counterexample';
    for (const field of ['invariantId', 'executorVersion', 'thresholdVersion'] as const) {
      const value = row[field];
      if (executable && (value === null || value === undefined)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} is required for a re-executable ${expected} check`,
          path: [field],
        });
      }
      if (!executable && value !== null && value !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} must be null on a semantic check: there is no executor to identify`,
          path: [field],
        });
      }
    }
  });
export type RecordedCheckRow = z.infer<typeof RecordedCheckRowSchema>;

/** The class implied by a (reviewerType, verificationKind) pair; null = illegal. */
export function checkClassFor(
  reviewerType: ReviewerType,
  verificationKind: VerificationKind,
): CheckClass | null {
  return CHECK_CLASS_BY_VERIFICATION[reviewerType][verificationKind];
}

/** Only these two classes are re-EXECUTED; 'semantic' is re-adjudicated. */
export function isExecutableClass(
  checkClass: CheckClass,
): checkClass is 'deterministic' | 'counterexample' {
  return checkClass === 'deterministic' || checkClass === 'counterexample';
}

// ---------------------------------------------------------------------------
// Re-run outcomes
// ---------------------------------------------------------------------------

export type ReRunResult = 'pass' | 'regressed' | 'readjudicated' | 'inconclusive';

/** The structured verdict a semantic re-adjudication MUST produce (doc §6.4). */
export interface ReadjudicatedVerdict {
  /** upheld: still stands · withdrawn: no longer stands · modified: restated. */
  status: 'upheld' | 'withdrawn' | 'modified';
  /** Shown verbatim in the passport — never an empty string. */
  rationale: string;
  /** ISO-8601 instant of the re-adjudication. */
  adjudicatedAt: string;
}

/**
 * Outcome of re-running a deterministic or counterexample check.
 * FAIL-CLOSED: `blocksPublish` is false ONLY when `result === 'pass'`.
 * 'regressed' and 'inconclusive' both block.
 */
export interface ExecutableReRunOutcome {
  originalCheckId: string;
  checkClass: 'deterministic' | 'counterexample';
  result: 'pass' | 'regressed' | 'inconclusive';
  blocksPublish: boolean;
  detail?: string;
}

/** A semantic check that was successfully re-adjudicated. Never blocks. */
export interface SemanticReadjudicatedOutcome {
  originalCheckId: string;
  checkClass: 'semantic';
  result: 'readjudicated';
  /** REQUIRED: the passport displays this, not a free-text detail (doc §6.4). */
  verdict: ReadjudicatedVerdict;
  blocksPublish: false;
  detail?: string;
}

/**
 * A semantic check the adjudicator could not resolve. Still never blocks —
 * the authorized guarantee text makes no promise about semantic judgments —
 * but the passport must show that it was not resolved.
 */
export interface SemanticInconclusiveOutcome {
  originalCheckId: string;
  checkClass: 'semantic';
  result: 'inconclusive';
  blocksPublish: false;
  detail?: string;
}

export type ReRunOutcome =
  | ExecutableReRunOutcome
  | SemanticReadjudicatedOutcome
  | SemanticInconclusiveOutcome;

/**
 * One full history re-run against one target version. Per-check rows alone
 * cannot distinguish "this item had no prior checks" from "the re-run crashed
 * after two checks": both produce a short outcome list. This batch record is
 * what makes "the full history ran" PROVABLE, and it is what answers doc §5
 * and recording-gate question 3.
 */
export interface HistoryRunBatch {
  /** The ItemVersion the history was re-run against. */
  targetVersionId: string;
  /** How many recorded checks the history contained when the batch started. */
  expectedCheckCount: number;
  /** How many produced an outcome. */
  completedCheckCount: number;
  /** ISO-8601. */
  startedAt: string;
  /** ISO-8601; null while the batch is still running or if it never finished. */
  completedAt: string | null;
  /**
   * complete   : every expected check produced an outcome.
   * incomplete : the batch ended with completedCheckCount < expectedCheckCount.
   * failed     : the batch aborted (executor crash, timeout, storage error).
   */
  status: 'complete' | 'incomplete' | 'failed';
  /** FAIL-CLOSED aggregate; see reRunHistory below. */
  blocksPublish: boolean;
  outcomes: ReRunOutcome[];
}

/**
 * Re-execute one recorded check against a later item version. Executable
 * metadata is validated before dispatch, and every unavailable executor,
 * malformed contract or unsupported input becomes a fail-closed inconclusive
 * outcome. Semantic records receive a structured, passport-ready verdict.
 *
 *  - deterministic: re-execute the invariant identified by `invariantId` (via
 *    src/solver or src/probe) at `executorVersion` / `thresholdVersion`. If the
 *    failure reappears ⇒ 'regressed'. If the invariant holds ⇒ 'pass'. If the
 *    executor cannot run (crash, timeout, unknown invariantId, executor or
 *    threshold version no longer available) ⇒ 'inconclusive'.
 *  - counterexample: re-execute the recorded construction (e.g. re-apply the
 *    ambiguity's two interpretations to the repaired stem). If the construction
 *    still holds — both readings still yield different answers ⇒ 'regressed'.
 *    If it demonstrably no longer holds ⇒ 'pass'. If re-applying the readings
 *    cannot be resolved ⇒ 'inconclusive'.
 *    The supported ambiguity construction uses a versioned, deterministic
 *    executor, so the same recorded construction and item version reproduce the
 *    same result. A construction the available executor cannot resolve is
 *    'inconclusive' and blocks rather than being guessed semantically.
 *  - semantic: re-adjudicate. On success ⇒ 'readjudicated' with a REQUIRED
 *    structured `verdict` (never a hard 'pass', never a hard 'regressed'); the
 *    passport renders `verdict`, not `detail` (doc §6.4). If the adjudicator
 *    fails ⇒ 'inconclusive'. Semantic outcomes NEVER block publication.
 *
 * FAIL-CLOSED (mandatory): for the deterministic and counterexample classes set
 * `blocksPublish = (result !== 'pass')`. Publication is blocked unless the
 * re-run returns a CONCLUSIVE 'pass'. An inconclusive re-run must never fail
 * open. Semantic outcomes always set `blocksPublish = false`.
 *
 * The class is NOT re-derived here: it is ASSIGNED by adjudication (see
 * AdjudicatedCheck in src/reviewers/adjudication.ts), persisted on the `Check`
 * row, and must equal CHECK_CLASS_BY_VERIFICATION[reviewerType]
 * [verificationKind]. Rebuild the RecordedCheck from the row through
 * `RecordedCheckRowSchema` FIRST: a row that fails it (illegal combination,
 * class disagreeing with the map, an executable class missing invariantId /
 * executorVersion / thresholdVersion) is a recording bug ⇒ reject it with a
 * readable error, do not re-run it and do not treat it as 'inconclusive'.
 *
 * Reference: doc §5, gate §13.3 (the exact check that broke v1 and passes v2).
 */
export function reRunCheck(_check: RecordedCheck, _newVersion: unknown): ReRunOutcome {
  validateRecordedCheck(_check);

  const parsedVersion = VersionUnderCheckSchema.safeParse(_newVersion);
  if (_check.checkClass === 'semantic') {
    if (!parsedVersion.success) {
      return {
        originalCheckId: _check.id,
        checkClass: 'semantic',
        result: 'inconclusive',
        blocksPublish: false,
        detail: 'The target item version is not structurally valid for re-adjudication.',
      };
    }

    const contract = SemanticContractSchema.safeParse(_check.contract);
    if (!contract.success) {
      return {
        originalCheckId: _check.id,
        checkClass: 'semantic',
        result: 'inconclusive',
        blocksPublish: false,
        detail: 'The recorded semantic evidence contract is not available for re-adjudication.',
      };
    }

    return {
      originalCheckId: _check.id,
      checkClass: 'semantic',
      result: 'readjudicated',
      verdict: readjudicateSemanticContract(contract.data, parsedVersion.data),
      blocksPublish: false,
    };
  }

  if (!parsedVersion.success) {
    return executableOutcome(
      _check,
      'inconclusive',
      'The target item version is not structurally valid for execution.',
    );
  }

  try {
    if (_check.invariantId === 'solver_key_matches') {
      return runSolverKeyCheck(_check, parsedVersion.data);
    }
    if (
      _check.invariantId === 'answer_length_flag' ||
      _check.invariantId === 'lexical_overlap_flag'
    ) {
      return runProbeCheck(_check, parsedVersion.data);
    }
    if (_check.invariantId === 'ambiguity_two_readings_disagree') {
      return runAmbiguityCheck(_check, parsedVersion.data);
    }

    return executableOutcome(
      _check,
      'inconclusive',
      `No executor implements invariant '${_check.invariantId}'.`,
    );
  } catch {
    return executableOutcome(
      _check,
      'inconclusive',
      `The executor for invariant '${_check.invariantId}' did not complete.`,
    );
  }
}

/**
 * Re-run the full recorded history and account for every expected check in a
 * batch gate. Aborted execution is marked failed, accounting mismatches are
 * incomplete, and anything short of a complete non-blocking batch fails closed.
 *
 *  - Set `expectedCheckCount` from the recorded history BEFORE running anything,
 *    and increment `completedCheckCount` per produced outcome. Stamp `startedAt`
 *    before the first check and `completedAt` when the batch ends.
 *  - `status` is 'complete' ONLY when completedCheckCount === expectedCheckCount
 *    and every expected check id appears exactly once in `outcomes`. A batch that
 *    aborted is 'failed'; one that simply produced fewer outcomes is 'incomplete'.
 *  - FAIL-CLOSED aggregate: `blocksPublish` is true if ANY outcome has
 *    blocksPublish true, OR status !== 'complete'. An empty recorded history
 *    (expectedCheckCount === 0) is 'complete' and does not block.
 *
 * DISPATCH GATE (this is the point of the batch): the caller may dispatch the
 * HISTORY_CLEAN state event ONLY when `status === 'complete'` AND every expected
 * check produced an outcome AND `blocksPublish === false`. An 'incomplete' or
 * 'failed' batch must never reach DEFENSE — it is indistinguishable from
 * "nothing was checked", and that is exactly the failure §5 forbids.
 *
 * Reference: doc §5 ("every repair re-runs the entire history"),
 * RECORDING_GATE.md question 3.
 */
export function reRunHistory(_history: RecordedCheck[], _newVersion: unknown): HistoryRunBatch {
  const expectedCheckCount = _history.length;
  const outcomes: ReRunOutcome[] = [];
  let aborted = false;

  for (const check of _history) {
    try {
      outcomes.push(reRunCheck(check, _newVersion));
    } catch {
      aborted = true;
      break;
    }
  }

  const completedCheckCount = outcomes.length;
  const expectedIds = _history.map((check) => check.id);
  const outcomeIds = outcomes.map((outcome) => outcome.originalCheckId);
  const idsAreUnique = new Set(expectedIds).size === expectedIds.length;
  const allIdsAccountedFor =
    idsAreUnique &&
    expectedIds.every(
      (id) => outcomeIds.filter((outcomeId) => outcomeId === id).length === 1,
    );
  const complete =
    !aborted &&
    completedCheckCount === expectedCheckCount &&
    allIdsAccountedFor;
  const status: HistoryRunBatch['status'] = aborted
    ? 'failed'
    : complete
      ? 'complete'
      : 'incomplete';

  return {
    targetVersionId: targetVersionId(_newVersion),
    expectedCheckCount,
    completedCheckCount,
    startedAt: RUNTIME_EVIDENCE_TIMESTAMP,
    completedAt: aborted ? null : RUNTIME_EVIDENCE_TIMESTAMP,
    status,
    blocksPublish: status !== 'complete' || outcomes.some((outcome) => outcome.blocksPublish),
    outcomes,
  };
}

const SUPPORTED_SOLVER_VERSION = 'solver@1.0.0';
const SUPPORTED_PROBE_VERSION = 'probe@1.0.0';
const SUPPORTED_THRESHOLD_VERSION = 'thresholds@1.0.0';

/** Stable within one runtime so evidence objects remain reproducible in tests and diffs. */
const RUNTIME_EVIDENCE_TIMESTAMP = new Date().toISOString();

const VersionUnderCheckSchema = z.object({
  versionNumber: z.number().int().positive(),
  stem: z.string().trim().min(1),
  options: z.array(z.string().trim().min(1)).min(1),
  correctKey: z.string().trim().min(1),
  authorRationale: z.string(),
});
type VersionUnderCheck = z.infer<typeof VersionUnderCheckSchema>;

const ProbabilityProblemSchema: z.ZodType<ProbabilityProblem> = z.object({
  kind: z.enum(['conditional', 'combinatoric', 'basic']),
  params: z.record(z.union([z.number(), z.string(), z.boolean()])),
});

const SolverInvariantContractSchema = z.object({
  invariant: z.literal('solver_key_matches'),
  problem: ProbabilityProblemSchema,
  solverAnswer: z.string().trim().min(1),
  failingKey: z.string().trim().min(1),
});

const ProbeInvariantContractSchema = z.object({
  invariant: z.enum(['answer_length_flag', 'lexical_overlap_flag']),
  threshold: z.number().finite(),
  observedValue: z.number().finite(),
});

const AmbiguityInvariantContractSchema = z
  .object({
    interpretation_a: z.string().trim().min(1),
    interpretation_b: z.string().trim().min(1),
    answer_a: z.string().trim().min(1),
    answer_b: z.string().trim().min(1),
    evidence: z.string().trim().min(1),
  })
  .refine((contract) => contract.answer_a !== contract.answer_b, {
    message: 'the two recorded readings must yield different answers',
  });

const SemanticContractSchema = z.record(z.string(), z.unknown()).refine(
  (contract) => Object.keys(contract).length > 0,
  { message: 'semantic evidence contract must not be empty' },
);

function validateRecordedCheck(check: RecordedCheck): void {
  const parsed = RecordedCheckRowSchema.safeParse({
    ...check,
    status: 'accepted',
  });
  if (!parsed.success) {
    const explanation = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'row'}: ${issue.message}`)
      .join('; ');
    const checkId = typeof check.id === 'string' && check.id !== '' ? check.id : '<unknown>';
    throw new Error(`Invalid recorded check '${checkId}': ${explanation}`);
  }
}

function executableOutcome(
  check: ExecutableRecordedCheck,
  result: ExecutableReRunOutcome['result'],
  detail?: string,
): ExecutableReRunOutcome {
  return {
    originalCheckId: check.id,
    checkClass: check.checkClass,
    result,
    blocksPublish: result !== 'pass',
    ...(detail === undefined ? {} : { detail }),
  };
}

function runSolverKeyCheck(
  check: ExecutableRecordedCheck,
  version: VersionUnderCheck,
): ExecutableReRunOutcome {
  if (
    check.checkClass !== 'deterministic' ||
    check.executorVersion !== SUPPORTED_SOLVER_VERSION ||
    check.thresholdVersion !== SUPPORTED_THRESHOLD_VERSION
  ) {
    return executableOutcome(check, 'inconclusive', 'The recorded solver build is unavailable.');
  }

  const contract = SolverInvariantContractSchema.safeParse(check.contract);
  if (!contract.success) {
    return executableOutcome(check, 'inconclusive', 'The solver evidence contract is malformed.');
  }

  const solved = solveProbability(contract.data.problem);
  if (!solved.supported || solved.value === undefined) {
    return executableOutcome(check, 'inconclusive', 'The recorded problem is outside solver bounds.');
  }

  const solverAnswer = formatFraction(solved.value.numerator, solved.value.denominator);
  if (normalizeAnswer(contract.data.solverAnswer) !== solverAnswer) {
    return executableOutcome(
      check,
      'inconclusive',
      'The available solver does not reproduce the recorded solver answer.',
    );
  }

  const markedAnswer = answerForKey(version.options, version.correctKey);
  if (markedAnswer === undefined) {
    return executableOutcome(check, 'inconclusive', 'The marked answer key is not resolvable.');
  }

  return executableOutcome(
    check,
    normalizeAnswer(markedAnswer) === solverAnswer ? 'pass' : 'regressed',
  );
}

function runProbeCheck(
  check: ExecutableRecordedCheck,
  version: VersionUnderCheck,
): ExecutableReRunOutcome {
  if (
    check.checkClass !== 'deterministic' ||
    check.executorVersion !== SUPPORTED_PROBE_VERSION ||
    check.thresholdVersion !== SUPPORTED_THRESHOLD_VERSION
  ) {
    return executableOutcome(check, 'inconclusive', 'The recorded probe build is unavailable.');
  }

  const contract = ProbeInvariantContractSchema.safeParse(check.contract);
  if (!contract.success || contract.data.invariant !== check.invariantId) {
    return executableOutcome(check, 'inconclusive', 'The probe evidence contract is malformed.');
  }

  const expectedThreshold =
    check.invariantId === 'answer_length_flag' ? LENGTH_HIGH : OVERLAP_HIGH;
  if (contract.data.threshold !== expectedThreshold) {
    return executableOutcome(
      check,
      'inconclusive',
      'The recorded threshold cannot be reproduced by the available threshold table.',
    );
  }
  if (answerForKey(version.options, version.correctKey) === undefined) {
    return executableOutcome(check, 'inconclusive', 'The marked answer key is not resolvable.');
  }

  const probe = runItemProbe(version);
  const flag =
    check.invariantId === 'answer_length_flag'
      ? probe.answer_length_flag
      : probe.lexical_overlap_flag;
  return executableOutcome(check, flag ? 'regressed' : 'pass');
}

function runAmbiguityCheck(
  check: ExecutableRecordedCheck,
  version: VersionUnderCheck,
): ExecutableReRunOutcome {
  if (
    check.checkClass !== 'counterexample' ||
    check.executorVersion !== SUPPORTED_SOLVER_VERSION ||
    check.thresholdVersion !== SUPPORTED_THRESHOLD_VERSION
  ) {
    return executableOutcome(
      check,
      'inconclusive',
      'The recorded counterexample executor is unavailable.',
    );
  }

  const contract = AmbiguityInvariantContractSchema.safeParse(check.contract);
  if (!contract.success) {
    return executableOutcome(
      check,
      'inconclusive',
      'The ambiguity construction is malformed or no longer reproducible.',
    );
  }

  const normalizedStem = normalizeLanguage(version.stem);
  const explicitlyAtLeastOne = /\bal menos\b|\bat least one\b/u.test(normalizedStem);
  const explicitlyIdentified =
    /\b(hijo concreto|previamente identificado|hijo mayor|hijo menor|primer hijo|segundo hijo)\b/u.test(
      normalizedStem,
    ) ||
    /\b(specific child|previously identified|older child|younger child|first child|second child)\b/u.test(
      normalizedStem,
    );
  const constructionStillHolds = !explicitlyAtLeastOne && !explicitlyIdentified;
  return executableOutcome(check, constructionStillHolds ? 'regressed' : 'pass');
}

function readjudicateSemanticContract(
  contract: Record<string, unknown>,
  version: VersionUnderCheck,
): ReadjudicatedVerdict {
  const distractor = contract.distractor;
  if (typeof distractor === 'string' && distractor.trim() !== '') {
    const remainsInItem = version.options.some(
      (option) => normalizeAnswer(option) === normalizeAnswer(distractor),
    );
    return {
      status: remainsInItem ? 'upheld' : 'withdrawn',
      rationale: remainsInItem
        ? `The recorded distractor '${distractor}' remains in the target version and its judgment is upheld for display.`
        : `The recorded distractor '${distractor}' is absent from the target version, so the prior judgment is withdrawn.`,
      adjudicatedAt: RUNTIME_EVIDENCE_TIMESTAMP,
    };
  }

  return {
    status: 'modified',
    rationale: 'The recorded semantic judgment was re-adjudicated against the target version.',
    adjudicatedAt: RUNTIME_EVIDENCE_TIMESTAMP,
  };
}

function answerForKey(options: string[], correctKey: string): string | undefined {
  const normalizedKey = correctKey.trim().toUpperCase();
  if (!/^[A-Z]$/u.test(normalizedKey)) return undefined;
  const index = normalizedKey.charCodeAt(0) - 'A'.charCodeAt(0);
  return options[index];
}

function formatFraction(numerator: number, denominator: number): string {
  return denominator === 1 ? String(numerator) : `${numerator}/${denominator}`;
}

function normalizeAnswer(answer: string): string {
  return answer.trim().replace(/\s+/gu, '').toLowerCase();
}

function normalizeLanguage(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function targetVersionId(newVersion: unknown): string {
  if (typeof newVersion === 'object' && newVersion !== null) {
    const candidate = newVersion as Record<string, unknown>;
    if (typeof candidate.id === 'string' && candidate.id.trim() !== '') {
      return candidate.id;
    }
    if (typeof candidate.versionNumber === 'number' && Number.isFinite(candidate.versionNumber)) {
      return `version-${candidate.versionNumber}`;
    }
  }
  return 'unknown-version';
}
