/**
 * LA FORJA — item lifecycle state machine (doc §5, §7.1).
 *
 * OWNER: Codex (internals). Pure app code — NO model calls here. Exhaustively
 * unit-tested (tests/stateMachine.test.ts, including DEFENSE_INCONCLUSIVE).
 *
 * INVARIANTS (must hold in the implementation):
 *  - PUBLISHED versions are immutable; a repair is a NEW ItemVersion (never a mutate).
 *  - Every repair re-runs the FULL check history before reaching DEFENSE (doc §5).
 *  - An evaluator failure goes to DEFENSE_INCONCLUSIVE, never an auto-reject.
 *
 * Approved transition map (see the design review):
 *   DRAFT       --SUBMIT_TO_GAUNTLET-->      GAUNTLET
 *   GAUNTLET    --CHECKS_ACCEPTED-->         CHALLENGED
 *   GAUNTLET    --GAUNTLET_CLEAN-->          DEFENSE
 *   CHALLENGED  --SUBMIT_REPAIR-->           REGRESSION   (creates a new version)
 *   REGRESSION  --HISTORY_REGRESSED-->       CHALLENGED
 *   REGRESSION  --HISTORY_CLEAN-->           DEFENSE
 *   DEFENSE     --DEFENSE_PASSED-->          PUBLISHED    (>=4/6, no dim at 0)
 *   DEFENSE     --DEFENSE_FAILED-->          CHALLENGED
 *   DEFENSE     --DEFENSE_EVALUATOR_FAILED-->DEFENSE_INCONCLUSIVE
 *   DEFENSE_INCONCLUSIVE --DEFENSE_RETRY-->  DEFENSE
 *   PUBLISHED   --NEW_DISPUTE-->             DISPUTED
 *   DISPUTED    --DISPUTE_REPAIR-->          REGRESSION   (the "-> v2" path)
 */
import type { ItemState, StateEvent, Transition } from './types';

// TODO(codex): populate the full transition table above.
export const TRANSITIONS: Transition[] = [];

export class IllegalTransitionError extends Error {
  constructor(from: ItemState, event: StateEvent) {
    super(`Illegal transition: ${from} --${event}-->`);
    this.name = 'IllegalTransitionError';
  }
}

/**
 * TODO(codex): implement.
 *  - Look up (from, event) in TRANSITIONS; return `to`.
 *  - Throw IllegalTransitionError for any (from, event) not in the table.
 *  - Keep it PURE (no I/O). Guard semantics (e.g. "repair created a new version")
 *    are enforced by the caller before dispatching the event.
 */
export function reduce(_from: ItemState, _event: StateEvent): ItemState {
  throw new Error('TODO(codex): implement reduce() over TRANSITIONS');
}

/** TODO(codex): true iff (from,event) is a legal transition (no throw). */
export function canTransition(_from: ItemState, _event: StateEvent): boolean {
  throw new Error('TODO(codex): implement canTransition()');
}
