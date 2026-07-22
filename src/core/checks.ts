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
import { solve } from '../solver';
import { ProblemSchema } from '../solver/schema';
import { solverProofToProblem } from '../solver/proof';
import { SolverProofSchema } from '../reviewers/schemas';
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
  /**
   * How many recorded checks the history was expected to contain, counted
   * INDEPENDENTLY of the array that was iterated (see reRunHistory).
   */
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
 *  - counterexample: re-execute the recorded construction. For the ambiguity
 *    construction this means RE-SOLVING both recorded readings with the bounded
 *    solver (src/solver/probability.ts). Both readings still yielding DIFFERENT
 *    answers ⇒ the construction still holds ⇒ 'regressed'. The two readings
 *    converging on one answer ⇒ the construction no longer holds ⇒ 'pass'.
 *    A recorded construction that carries no re-executable form — two readings
 *    in natural language and nothing the solver can evaluate — is NOT
 *    re-executable, so the honest result is 'inconclusive', which fails closed
 *    into blocksPublish. The verdict is NEVER inferred from the wording of the
 *    new stem: surface text is not evidence, and guessing 'pass' from it would
 *    turn the one guarantee this engine carries into a false claim.
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

    // D3: a re-adjudication that did not happen must NOT be reported as one.
    // When the adjudicator cannot evaluate the recorded contract it returns
    // null, and the outcome is the distinguishable 'inconclusive' member — the
    // passport can then show "could not be re-adjudicated" instead of a verdict
    // nobody produced. Semantic outcomes still never block (doc §5).
    const verdict = readjudicateSemanticContract(contract.data, parsedVersion.data);
    if (verdict === null) {
      return {
        originalCheckId: _check.id,
        checkClass: 'semantic',
        result: 'inconclusive',
        blocksPublish: false,
        detail:
          'The recorded semantic judgment could not be re-adjudicated against this version: no adjudicator recognised the recorded contract.',
      };
    }

    return {
      originalCheckId: _check.id,
      checkClass: 'semantic',
      result: 'readjudicated',
      verdict,
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
 * WHY `expectedCheckCount` IS A PARAMETER AND NOT `_history.length` (do NOT
 * "simplify" this back): deriving the expected count from the same array the
 * loop iterates makes the count a tautology. A truncated or failed load of the
 * recorded checks then arrives as an empty (or short) array, the loop produces
 * exactly as many outcomes as it was handed, and the batch reports 'complete'
 * with blocksPublish false — authorising HISTORY_CLEAN on a history that was
 * never read. The count must therefore come from OUTSIDE the array: the caller
 * counts the recorded checks independently (e.g. a COUNT query against the
 * Check rows) and passes that number in. A mismatch between it and the array is
 * evidence of a load bug and is reported as 'incomplete', which blocks.
 *
 * This matters most exactly where it is easiest to miss: an item only reaches
 * REGRESSION through SUBMIT_REPAIR or DISPUTE_REPAIR, which means it MUST have
 * had prior checks. An empty history there is a bug, not cleanliness. A
 * genuinely empty history stays legal ONLY when the caller explicitly declares
 * `expectedCheckCount === 0`.
 *
 *  - `expectedCheckCount` is supplied by the caller BEFORE anything runs, and
 *    `completedCheckCount` counts produced outcomes. Stamp `startedAt` before
 *    the first check and `completedAt` when the batch ends.
 *  - `status` is 'complete' ONLY when the supplied count, the array length and
 *    completedCheckCount all agree and every expected check id appears exactly
 *    once in `outcomes`. A batch that aborted is 'failed'; one that simply
 *    produced fewer outcomes, or that was handed a history disagreeing with the
 *    declared count, is 'incomplete'.
 *  - FAIL-CLOSED aggregate: `blocksPublish` is true if ANY outcome has
 *    blocksPublish true, OR status !== 'complete'. An explicitly declared empty
 *    recorded history (expectedCheckCount === 0 AND an empty array) is
 *    'complete' and does not block.
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
export function reRunHistory(
  _history: RecordedCheck[],
  _newVersion: unknown,
  /**
   * REQUIRED. The number of recorded checks the caller counted independently of
   * `_history`. It is not optional and it has no default: a default would be
   * `_history.length`, which is precisely the fail-open this parameter exists to
   * close.
   */
  _expectedCheckCount: number,
): HistoryRunBatch {
  const declaredCount = Number.isSafeInteger(_expectedCheckCount) && _expectedCheckCount >= 0
    ? _expectedCheckCount
    : -1; // an unusable declaration can never equal a real count ⇒ incomplete ⇒ blocks
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
  // The declared count must agree with BOTH the array it was supposed to
  // describe and the outcomes actually produced. Checking it only against
  // `outcomes.length` would let a truncated load through again.
  const complete =
    !aborted &&
    declaredCount === expectedIds.length &&
    completedCheckCount === declaredCount &&
    allIdsAccountedFor;
  const status: HistoryRunBatch['status'] = aborted
    ? 'failed'
    : complete
      ? 'complete'
      : 'incomplete';

  return {
    targetVersionId: targetVersionId(_newVersion),
    expectedCheckCount: _expectedCheckCount,
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

// The re-executable problem shape. `ProblemSchema` (src/solver/schema.ts)
// defaults `discipline` to 'probability', so every historical probability
// contract — recorded before disciplines existed — still parses and re-runs
// identically, while statistics/geometry/triangle contracts carry their own
// discipline and route to the right bounded solver at `solve()`.
const SolverInvariantContractSchema = z.object({
  invariant: z.literal('solver_key_matches'),
  problem: ProblemSchema,
  solverAnswer: z.string().trim().min(1),
  failingKey: z.string().trim().min(1),
});

/**
 * The discipline reviewer records its OWN contract (a Discipline verdict object
 * carrying a `solver_proof`) — the passport displays that contract verbatim, so
 * it must NOT be rewritten into a bare solver contract. This is the minimal
 * lens that pulls the re-executable proof back out of it at re-run time.
 */
const RecordedDisciplineProofSchema = z.object({ solver_proof: SolverProofSchema });

/**
 * The two recorded shapes a `solver_key_matches` check can carry, reduced to the
 * one thing the re-run needs: the re-executable `problem` and the `solverAnswer`
 * the recording claims the solver produced.
 *
 *  1. An explicit `SolverInvariantContract` (test fixtures, and any future
 *     directly-recorded form).
 *  2. The discipline reviewer's Discipline contract, whose `solver_proof` names
 *     the discipline, kind and inputs — carried across the seam by
 *     `solverProofToProblem` so `solve()` routes to the right solver.
 */
function resolveSolverContract(
  raw: unknown,
): { problem: z.infer<typeof ProblemSchema>; solverAnswer: string } | undefined {
  const explicit = SolverInvariantContractSchema.safeParse(raw);
  if (explicit.success) {
    return { problem: explicit.data.problem, solverAnswer: explicit.data.solverAnswer };
  }
  const discipline = RecordedDisciplineProofSchema.safeParse(raw);
  if (discipline.success) {
    const proof = discipline.data.solver_proof;
    return { problem: solverProofToProblem(proof), solverAnswer: proof.computed_value };
  }
  return undefined;
}

/**
 * Strict, no-guess numeric parser for the decimal re-run path. Accepts ONLY the
 * canonical forms the bounded solvers emit — integer, exact fraction, plain
 * decimal — and refuses everything else so an unparseable marked answer becomes
 * 'inconclusive', never a false 'pass'.
 */
function parseBoundedNumber(text: string): number | undefined {
  const trimmed = text.trim();
  if (/^-?\d+$/.test(trimmed)) {
    const value = Number(trimmed);
    return Number.isFinite(value) ? value : undefined;
  }
  const fraction = /^(-?\d+)\/(\d+)$/.exec(trimmed);
  if (fraction) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
      return undefined;
    }
    return numerator / denominator;
  }
  if (/^-?\d+\.\d+$/.test(trimmed)) {
    const value = Number(trimmed);
    return Number.isFinite(value) ? value : undefined;
  }
  return undefined;
}

const ProbeInvariantContractSchema = z.object({
  invariant: z.enum(['answer_length_flag', 'lexical_overlap_flag']),
  threshold: z.number().finite(),
  observedValue: z.number().finite(),
});

/**
 * The recorded ambiguity construction.
 *
 * `interpretation_a` / `interpretation_b` are natural language: they are what
 * the reviewer WROTE, and they are displayed in the passport. They are NOT
 * executable — no amount of pattern matching over them, or over the new stem,
 * re-executes anything.
 *
 * `problem_a` / `problem_b` are the RE-EXECUTABLE form of those two readings:
 * each reading expressed as a bounded-solver problem. They are optional because
 * a reviewer may raise an ambiguity whose readings cannot be reduced to a solver
 * problem — and when they are absent the construction simply cannot be re-run,
 * which is reported as 'inconclusive' (fail-closed), never as a pass.
 */
const AmbiguityInvariantContractSchema = z
  .object({
    interpretation_a: z.string().trim().min(1),
    interpretation_b: z.string().trim().min(1),
    answer_a: z.string().trim().min(1),
    answer_b: z.string().trim().min(1),
    evidence: z.string().trim().min(1),
    problem_a: ProblemSchema.optional(),
    problem_b: ProblemSchema.optional(),
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

  const contract = resolveSolverContract(check.contract);
  if (contract === undefined) {
    return executableOutcome(check, 'inconclusive', 'The solver evidence contract is malformed.');
  }

  const solved = solve(contract.problem);
  if (!solved.supported) {
    return executableOutcome(check, 'inconclusive', 'The recorded problem is outside solver bounds.');
  }

  const markedAnswer = answerForKey(version.options, version.correctKey);
  if (markedAnswer === undefined) {
    return executableOutcome(check, 'inconclusive', 'The marked answer key is not resolvable.');
  }

  // EXACT (rational) mode — unchanged: compare exact fraction strings.
  if (solved.value !== undefined) {
    const solverAnswer = formatFraction(solved.value.numerator, solved.value.denominator);
    if (normalizeAnswer(contract.solverAnswer) !== solverAnswer) {
      return executableOutcome(
        check,
        'inconclusive',
        'The available solver does not reproduce the recorded solver answer.',
      );
    }
    return executableOutcome(
      check,
      normalizeAnswer(markedAnswer) === solverAnswer ? 'pass' : 'regressed',
    );
  }

  // DECIMAL mode — an irrational answer (π, a non-perfect-square root). The
  // solver publishes an ABSOLUTE tolerance derived from the problem itself; the
  // comparison is |marked − computed| ≤ tolerance, never a fuzzy match budget.
  if (solved.decimal !== undefined && solved.tolerance !== undefined) {
    const recorded = parseBoundedNumber(contract.solverAnswer);
    if (recorded === undefined || Math.abs(recorded - solved.decimal) > solved.tolerance) {
      return executableOutcome(
        check,
        'inconclusive',
        'The available solver does not reproduce the recorded solver answer.',
      );
    }
    const marked = parseBoundedNumber(markedAnswer);
    if (marked === undefined) {
      return executableOutcome(check, 'inconclusive', 'The marked answer is not a bounded number.');
    }
    return executableOutcome(
      check,
      Math.abs(marked - solved.decimal) <= solved.tolerance ? 'pass' : 'regressed',
    );
  }

  return executableOutcome(check, 'inconclusive', 'The recorded problem is outside solver bounds.');
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

  // BRANCH 1 — the construction has no re-executable form. There is nothing to
  // run, so there is nothing to pass. Reading the new stem for reassuring
  // phrases ("at least one", "a specific child", ...) is not a re-execution: it
  // is a guess, it fails OPEN on any unrelated item whose stem happens to
  // contain those words, and it would make the §5 guarantee false in general.
  // Refusing to publish an unverifiable counterexample is the honest trade.
  const { problem_a: problemA, problem_b: problemB } = contract.data;
  if (problemA === undefined || problemB === undefined) {
    return executableOutcome(
      check,
      'inconclusive',
      'The recorded ambiguity construction has no re-executable form: its two readings exist only as prose, so they cannot be re-solved against this version.',
    );
  }

  // The version must be a well-formed item before any verdict is claimed about it.
  if (answerForKey(version.options, version.correctKey) === undefined) {
    return executableOutcome(check, 'inconclusive', 'The marked answer key is not resolvable.');
  }

  // BRANCH 2 — a real re-execution: re-solve BOTH readings with the bounded
  // solver at the recorded executor version. `solve` dispatches on the recorded
  // problem's discipline; a reading that resolves to a decimal-only (irrational)
  // answer has no exact fraction to compare and is treated as not re-executable
  // below → 'inconclusive' (fail-closed), matching the pre-multidiscipline path.
  const solvedA = solve(problemA);
  const solvedB = solve(problemB);
  if (
    !solvedA.supported ||
    solvedA.value === undefined ||
    !solvedB.supported ||
    solvedB.value === undefined
  ) {
    return executableOutcome(
      check,
      'inconclusive',
      'At least one recorded reading is outside the bounded solver, so the construction could not be re-executed.',
    );
  }

  const answerA = formatFraction(solvedA.value.numerator, solvedA.value.denominator);
  const answerB = formatFraction(solvedB.value.numerator, solvedB.value.denominator);

  // Two readings that still disagree ARE the counterexample: it still holds.
  // Two readings that converge no longer produce competing answers: it is dead.
  if (answerA !== answerB) {
    return executableOutcome(
      check,
      'regressed',
      `Re-executed: reading A resolves to ${answerA} and reading B to ${answerB}. The two readings still disagree, so the counterexample still holds.`,
    );
  }
  return executableOutcome(
    check,
    'pass',
    `Re-executed: both recorded readings now resolve to ${answerA}, so the construction no longer produces two competing answers.`,
  );
}

/**
 * Re-adjudicate a recorded semantic judgment against the target version.
 *
 * Returns null when no adjudicator recognises the recorded contract. That is
 * NOT a verdict and must not be dressed up as one: emitting a 'modified'
 * verdict with a rationale saying "it was re-adjudicated" would record a
 * re-adjudication that never ran, and the passport would show it as clean.
 */
function readjudicateSemanticContract(
  contract: Record<string, unknown>,
  version: VersionUnderCheck,
): ReadjudicatedVerdict | null {
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

  return null;
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
