/**
 * LA FORJA — separate adjudication step (doc §6.2, §7.1).
 *
 * OWNER: Codex. NOT called "independent": the correlated-error risk between
 * Terra/Sol is documented and accepted. The adjudicator:
 *  - validates each finding's contract completeness (schema-valid + semantics),
 *  - deduplicates findings,
 *  - assigns a state / status to each check,
 *  - ABSTAINS on the unverifiable ("the model said so" is never final evidence).
 *
 * It may run on the adjudicator model (Sol) or Terra depending on the eval config.
 */
import type { CheckClass, CheckStatus, ItemState } from '../core/types';
import type { OrchestrationResult } from './orchestrator';

export interface AdjudicatedCheck {
  reviewerType: string;
  checkClass: CheckClass;
  status: CheckStatus;
  contract: unknown;
  schemaValid: boolean;
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
 * TODO(codex): implement adjudication.
 *  - Input: the orchestration outcomes (+ item_probe result).
 *  - Re-validate every contract; mark schemaValid=false ones as rejected.
 *  - Dedupe near-identical findings (e.g. same distractor + same hypothesized error).
 *  - Assign checkClass: ambiguity(diff answers)=counterexample; solver-grounded
 *    numeric=deterministic; distractor/plausibility=semantic; item_probe=deterministic.
 *  - Assign status: accepted | rejected | abstained | hypothesis. ABSTAIN when a
 *    claim cannot be verified (no sufficient source / solver inconclusive).
 *  - nextState = 'CHALLENGED' if any accepted check exists, else 'DEFENSE'.
 * Reference: doc §6.2 ("separate adjudication step").
 */
export function adjudicate(_orchestration: OrchestrationResult, _adjudicatorModel: string): AdjudicationResult {
  throw new Error('TODO(codex): implement separate adjudication (validate, dedupe, assign, abstain)');
}
