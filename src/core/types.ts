/**
 * LA FORJA — core domain types.
 *
 * Single source of truth for the string-column allowed values used across the
 * Prisma schema. Zod schemas (src/reviewers/schemas.ts) derive from these.
 *
 * OWNER: Claude (types only). The state-machine TRANSITIONS table and reducer
 * are Codex-owned — see src/core/stateMachine.ts.
 */

// ---------------------------------------------------------------------------
// Item lifecycle states (doc §5, §7.1)
// ---------------------------------------------------------------------------
/**
 * SCOPE NOTE — DISPUTED / NEW_DISPUTE / DISPUTE_REPAIR.
 *
 * These three exist to MODEL the "-> v2" republication path: a published item
 * can be challenged again and re-enter the cycle through REGRESSION. They were
 * explicitly mandated by the project owner and must not be removed.
 *
 * The tension, recorded here on purpose: post-publication appeals are OUTSIDE
 * the winning slice. The MVP exposes NO live control that can trigger them —
 * no UI affordance, no API route reachable by a user. DISPUTED is a type-level
 * and diagram-level seat only: the state machine can reach it, the product
 * cannot. Anything that changes that (a button, a route, a seeded transition)
 * is scope the slice did not budget for, and must be a deliberate decision
 * rather than a side effect.
 */
export const ITEM_STATES = [
  'DRAFT',
  'GAUNTLET',
  'CHALLENGED',
  'REGRESSION',
  'DEFENSE',
  'DEFENSE_INCONCLUSIVE', // evaluator failure — never auto-reject (doc §6.3)
  'PUBLISHED',
  'DISPUTED',
] as const;
export type ItemState = (typeof ITEM_STATES)[number];

// ---------------------------------------------------------------------------
// Check taxonomy (doc §5). Determines the non-regression promise per class.
// ---------------------------------------------------------------------------
export const CHECK_CLASSES = [
  'deterministic', // strict non-regression: v2 cannot reintroduce the failure
  'counterexample', // re-executable construction; if still possible, no publish
  'semantic', // re-adjudicated each version; never an absolute guarantee
] as const;
export type CheckClass = (typeof CHECK_CLASSES)[number];

export const REVIEWER_TYPES = [
  'ambiguity',
  'discipline',
  'distractor',
  'item_probe', // deterministic probe (not a model reviewer) — doc §7.3
] as const;
export type ReviewerType = (typeof REVIEWER_TYPES)[number];

/**
 * HOW a check was verified — the second half of the pair that fixes its class.
 *
 * Reviewer type ALONE cannot determine the class: the discipline reviewer
 * produces a solver-grounded numeric verdict (deterministic, re-executable) AND
 * a source-grounded conceptual verdict (a semantic judgment). The pair
 * (reviewerType, verificationKind) is what fixes the class, and the mapping is
 * encoded exactly once in CHECK_CLASS_BY_VERIFICATION (src/core/checks.ts).
 *
 * This is the allowed-value set for the `Check.verificationKind` String column.
 * It is ASSIGNED by the adjudication stage (src/reviewers/adjudication.ts) —
 * adjudication is what decides a finding's class and status, so it is the only
 * stage that knows the kind — and Zod-validated at the persistence boundary by
 * RecordedCheckRowSchema (src/core/checks.ts).
 */
export const VERIFICATION_KINDS = [
  'solver', // recomputed by the bounded solver (src/solver) — reproducible
  'citation', // grounded on a licensed source excerpt — judged, not computed
  'heuristic', // fixed-threshold code check (src/probe) — reproducible
  'interpretation', // a natural-language reading applied to the stem — judged
] as const;
export type VerificationKind = (typeof VERIFICATION_KINDS)[number];

export const CHECK_STATUS = [
  'proposed',
  'accepted',
  'rejected',
  'abstained', // adjudicator abstains on the unverifiable (doc §6.2)
  'hypothesis', // distractor finding without evidence (doc §6.2)
] as const;
export type CheckStatus = (typeof CHECK_STATUS)[number];

// ---------------------------------------------------------------------------
// State machine (types only; implementation is Codex-owned)
// ---------------------------------------------------------------------------
/**
 * COMPLETENESS IS PART OF THE GUARD, NOT AN AFTERTHOUGHT.
 *
 * GAUNTLET_CLEAN and HISTORY_CLEAN are the two events that move an item TOWARDS
 * publication, and both are vulnerable to the same failure: the absence of a
 * finding is not evidence that anything ran. Three reviewers that all timed out
 * produce zero accepted checks, which looks identical to a clean item.
 *
 *  - GAUNTLET_CLEAN requires that EVERY mandatory reviewer (ambiguity,
 *    discipline, distractor), the deterministic item_probe, AND the
 *    adjudication stage have all COMPLETED — not merely that no finding was
 *    accepted. A run with any reviewer failed/timed out, or with adjudication
 *    not reached, is NOT clean and must not dispatch this event.
 *  - HISTORY_CLEAN requires a HistoryRunBatch (src/core/checks.ts) with
 *    status === 'complete', every expected check accounted for, and
 *    blocksPublish === false.
 *
 * The guard logic itself lives in the Codex-owned src/core/stateMachine.ts.
 */
export const STATE_EVENTS = [
  'SUBMIT_TO_GAUNTLET', // DRAFT      -> GAUNTLET
  'CHECKS_ACCEPTED', // GAUNTLET   -> CHALLENGED
  // GAUNTLET -> DEFENSE. NOT merely "no accepted checks": every mandatory
  // reviewer + the item_probe + adjudication must have COMPLETED (see above).
  'GAUNTLET_CLEAN',
  'SUBMIT_REPAIR', // CHALLENGED -> REGRESSION (creates a new ItemVersion)
  'HISTORY_REGRESSED', // REGRESSION -> CHALLENGED (a deterministic check regressed)
  // REGRESSION -> DEFENSE. Requires a COMPLETE HistoryRunBatch (see above).
  'HISTORY_CLEAN',
  'DEFENSE_PASSED', // DEFENSE    -> PUBLISHED (>=4/6, no dimension at 0)
  'DEFENSE_FAILED', // DEFENSE    -> CHALLENGED
  'DEFENSE_EVALUATOR_FAILED', // DEFENSE -> DEFENSE_INCONCLUSIVE (never auto-reject)
  'DEFENSE_RETRY', // DEFENSE_INCONCLUSIVE -> DEFENSE
  'NEW_DISPUTE', // PUBLISHED  -> DISPUTED   — see SCOPE NOTE above ITEM_STATES
  'DISPUTE_REPAIR', // DISPUTED   -> REGRESSION (the "-> v2" path)
] as const;
export type StateEvent = (typeof STATE_EVENTS)[number];

export interface Transition {
  from: ItemState;
  event: StateEvent;
  to: ItemState;
  /** Human-readable precondition; Codex implements the guard logic. */
  guard?: string;
}

// ---------------------------------------------------------------------------
// Evidence contracts (doc §6.2). Zod schemas live in src/reviewers/schemas.ts;
// these interfaces are the inferred shapes for use across the app.
// ---------------------------------------------------------------------------

/** Ambiguity — valid ONLY if answer_a !== answer_b. Produces a counterexample. */
export interface AmbiguityContract {
  interpretation_a: string;
  interpretation_b: string;
  answer_a: string;
  answer_b: string;
  evidence: string;
}

export type DisciplineVerdict = 'correct' | 'incorrect' | 'unverified';

/** Full citation — required for a `correct` verdict (doc §6.2). */
export interface Citation {
  source_id: string;
  version_date: string;
  license: string;
  excerpt: string;
  relevance: string;
}

/** Discipline (probability only). `correct` with no citation is forbidden. */
export interface DisciplineContract {
  claim: string;
  verdict: DisciplineVerdict;
  citation: Citation | null; // null ⇒ must be 'unverified', never 'correct'
}

/** Distractor — no evidence ⇒ label 'hypothesis' (doc §6.2). */
export interface DistractorContract {
  distractor: string;
  hypothesized_error: string;
  confidence: number; // 0..1
  evidence?: string;
  label: 'evidenced' | 'hypothesis';
}

/** Deterministic cue probe (doc §7.3). Length + lexical overlap only. */
export interface ItemProbeResult {
  answer_length_flag: boolean; // correct option notably longer/shorter than mean
  lexical_overlap_flag: boolean; // stem <-> correct answer overlap above threshold
  answer_length_ratio: number;
  lexical_overlap_score: number; // 0..1
}

// ---------------------------------------------------------------------------
// Defense rubric (doc §6.3): 3 dims × 0-2, textual evidence each.
// ---------------------------------------------------------------------------
export const RUBRIC_DIMENSIONS = [
  'identifies_error', // identifies the conceptual error the distractor captures
  'explains_uniqueness', // explains why the correct alternative is unique
  'answers_variation', // answers a variation of the stem correctly
] as const;
export type RubricDimensionKey = (typeof RUBRIC_DIMENSIONS)[number];

export interface RubricDimension {
  dimension: RubricDimensionKey;
  score: 0 | 1 | 2;
  evidence: string;
}

export interface DefenseRubric {
  dimensions: [RubricDimension, RubricDimension, RubricDimension];
  total: number; // 0..6
  outcome: 'passed' | 'failed' | 'inconclusive';
}

// Publish threshold: total >= 4 AND no dimension scored 0 (doc §6.3).
export const DEFENSE_PUBLISH_MIN_TOTAL = 4;
