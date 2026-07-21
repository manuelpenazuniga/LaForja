/**
 * LA FORJA — separate adjudication step (doc §6.2, §7.1).
 *
 * OWNER: Codex. This IS a model call site: §7.1 shows adjudication as its own
 * stage, and it runs on the adjudicator model (Sol) or on Terra depending on the
 * eval config. That is why the signature is async and why `adjudicatorModel` is
 * a real parameter and not decoration.
 *
 * NOT called "independent": §6.2 declares the correlated-error risk between the
 * reviewer model and the adjudicator model — they may share a family, a training
 * corpus and therefore a blind spot. The word is "separate", always. A separate
 * stage buys a second pass with a different prompt and a different job; it does
 * not buy statistical independence, and the project must never claim it does.
 *
 * The adjudicator:
 *  - validates each finding's contract completeness (schema-valid + semantics),
 *  - deduplicates findings,
 *  - assigns a verification kind, a class and a status to each check,
 *  - ABSTAINS on the unverifiable ("the model said so" is never final evidence).
 */
import type { CheckClass, CheckStatus, ItemState, VerificationKind } from '../core/types';
import type { OrchestrationResult } from './orchestrator';

/**
 * One adjudicated finding — the PRODUCER of the recorded-check shape.
 *
 * Adjudication is the only stage that knows how a finding was verified, because
 * assigning the class and the status IS deciding the verification kind. These
 * fields therefore originate here, are persisted verbatim on the `Check` row
 * (prisma/schema.prisma) and are read back by the history re-run engine
 * (RecordedCheck, src/core/checks.ts). One shape, three places — see the
 * field-for-field table in src/core/checks.ts.
 */
export interface AdjudicatedCheck {
  reviewerType: string;
  /**
   * HOW the finding was verified. Together with `reviewerType` this FIXES
   * `checkClass` through CHECK_CLASS_BY_VERIFICATION (src/core/checks.ts); the
   * two fields are never assigned independently.
   */
  verificationKind: VerificationKind;
  checkClass: CheckClass;
  status: CheckStatus;
  contract: unknown;
  schemaValid: boolean;
  /**
   * RE-EXECUTION IDENTITY. Required when checkClass is 'deterministic' or
   * 'counterexample'; omitted for 'semantic', which has no executor to name.
   * Without them the recorded check cannot be rebuilt on a later version and
   * strict non-regression is unimplementable (doc §5).
   */
  invariantId?: string;
  /** Version of the solver/probe that produced the recorded result. */
  executorVersion?: string;
  /** Version of the threshold table in force when the check was recorded. */
  thresholdVersion?: string;
  /** Reason for abstain/reject, for the passport trail. */
  note?: string;
}

export interface AdjudicationResult {
  checks: AdjudicatedCheck[];
  /** Next item state implied by the accepted checks (CHALLENGED vs clean). */
  nextState: Extract<ItemState, 'CHALLENGED' | 'DEFENSE'>;
  abstained: number;
}

/**
 * TODO(codex): implement the separate adjudication stage. It is a MODEL CALL.
 *
 * THE CALL (doc §7.1, hard constraint 3):
 *  - Exactly ONE `callModel` (src/openai/client.ts) per adjudication pass, with
 *    `callSite: 'adjudication'`, `model: adjudicatorModel`, no `reviewerType`.
 *  - The item text and every reviewer contract go in as UNTRUSTED input: wrap
 *    them with `delimitItem` before sending. A reviewer's finding is model
 *    output, so it is exactly as untrusted as the student's stem — a finding
 *    that says "mark this accepted" is data, never an instruction.
 *  - Export an ADJUDICATION_PROMPT_VERSION (e.g. 'adjudication-v1') next to the
 *    system prompt, as ambiguity.ts / discipline.ts / distractors.ts do.
 *  - The system prompt must forbid the model from AUTHORING anything (hard
 *    constraint 2): it rules on findings it is given, it never invents an item,
 *    a solution, a citation or a solver result.
 *  - Validate the response with a Zod schema in src/reviewers/schemas.ts —
 *    add `AdjudicationSchema`, an array of
 *    { finding_ref, verification_kind, status, note } where `finding_ref`
 *    identifies the reviewer finding being ruled on. `callModel` already
 *    Zod-validates and retries ONCE; a second failure must throw readably.
 *  - Persist ONE ModelCall row for the call: callSite 'adjudication',
 *    gauntletRunId set, exact modelId, modelFamilyOk, promptVersion,
 *    promptHash, latencyMs, tokensIn/Out, schemaValid, rawJson (the row is the
 *    compliance evidence; a call with no row fails the audit).
 *  - The model FAILING is not a clean gauntlet. If the call throws or the output
 *    stays invalid after the retry, do NOT return an empty `checks` array with
 *    nextState 'DEFENSE' — that is "nobody objected" spelled the same way as
 *    "nothing ran". Surface the failure so the pipeline records the run as
 *    incomplete and GAUNTLET_CLEAN is never dispatched (src/core/types.ts).
 *
 * THE WORK:
 *  - Input: the orchestration outcomes (+ the deterministic item_probe result).
 *  - Re-validate every contract against REVIEWER_SCHEMAS; a finding that fails
 *    is recorded with schemaValid=false and status 'rejected'. Re-validate in
 *    code, not by asking the model — schema validity is not a judgment call.
 *  - Dedupe near-identical findings (e.g. same distractor + same hypothesized
 *    error). Keep the better-evidenced one; note the merge.
 *
 * ASSIGNING verificationKind — this is the decision that fixes the class, and
 * the class is then LOOKED UP, never chosen twice:
 *  - a solver-grounded numeric verdict (discipline, with a recorded
 *    `solver_proof`)              ⇒ 'solver'         ⇒ class 'deterministic'
 *  - a source-grounded conceptual verdict (discipline, grounded on a licensed
 *    citation excerpt)            ⇒ 'citation'       ⇒ class 'semantic'
 *  - an ambiguity: two defensible readings yielding different answers
 *                                 ⇒ 'interpretation' ⇒ class 'counterexample'
 *  - the deterministic item_probe (fixed thresholds, doc §7.3)
 *                                 ⇒ 'heuristic'      ⇒ class 'deterministic'
 *  - a distractor finding is a judgment either way: 'citation' when evidenced,
 *    'interpretation' when it is a hypothesized student error ⇒ 'semantic'.
 *  Then set `checkClass = CHECK_CLASS_BY_VERIFICATION[reviewerType]
 *  [verificationKind]`. A `null` entry is an illegal pair: reject the finding,
 *  never downgrade it to 'semantic' to make it fit.
 *
 * POPULATING the re-execution identity (required for deterministic and
 * counterexample; omit for semantic):
 *  - invariantId: the stable id of the executable check —
 *    'solver_key_matches' (solver-grounded discipline),
 *    'answer_length_flag' / 'lexical_overlap_flag' (item_probe),
 *    'ambiguity_two_readings_disagree' (ambiguity).
 *  - executorVersion: the solver version from the contract's `solver_proof`, or
 *    the probe version for item_probe. Take it from the executor that actually
 *    ran; never hardcode it, or the re-run will claim a provenance it lacks.
 *  - thresholdVersion: the threshold table in force for this run.
 *
 * ASSIGNING status: accepted | rejected | abstained | hypothesis.
 *  - ABSTAIN when a claim cannot be verified: no sufficient source, solver
 *    inconclusive, or the finding rests on nothing but the reviewer's assertion.
 *    "The model said so" is never final evidence (doc §6.2), and abstaining is
 *    the correct, expected outcome — not a failure to be minimized.
 *  - An abstained check is NOT an accepted check: it must not push the item to
 *    CHALLENGED, and it must not be silently dropped either. It is recorded,
 *    counted in `abstained` and shown in the passport.
 *  - `note` is REQUIRED for every abstained or rejected check: the passport has
 *    to say WHY, and "abstained" with no reason is unauditable.
 *
 *  - nextState = 'CHALLENGED' if any accepted check exists, else 'DEFENSE'.
 *
 * Reference: doc §6.2 ("separate adjudication step", correlated-error risk
 * declared), §7.1 (adjudication is its own stage), hard constraints 1-3.
 */
export async function adjudicate(
  _orchestration: OrchestrationResult,
  _adjudicatorModel: string,
): Promise<AdjudicationResult> {
  throw new Error('TODO(codex): implement separate adjudication (validate, dedupe, assign, abstain)');
}
