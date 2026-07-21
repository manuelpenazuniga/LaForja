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

// The complete lifecycle graph. Guard conditions are validated by callers before
// dispatch; this table records only the state reached by each legal event.
export const TRANSITIONS: Transition[] = [
  { from: 'DRAFT', event: 'SUBMIT_TO_GAUNTLET', to: 'GAUNTLET' },
  { from: 'GAUNTLET', event: 'CHECKS_ACCEPTED', to: 'CHALLENGED' },
  { from: 'GAUNTLET', event: 'GAUNTLET_CLEAN', to: 'DEFENSE' },
  { from: 'CHALLENGED', event: 'SUBMIT_REPAIR', to: 'REGRESSION' },
  { from: 'REGRESSION', event: 'HISTORY_REGRESSED', to: 'CHALLENGED' },
  { from: 'REGRESSION', event: 'HISTORY_CLEAN', to: 'DEFENSE' },
  { from: 'DEFENSE', event: 'DEFENSE_PASSED', to: 'PUBLISHED' },
  { from: 'DEFENSE', event: 'DEFENSE_FAILED', to: 'CHALLENGED' },
  {
    from: 'DEFENSE',
    event: 'DEFENSE_EVALUATOR_FAILED',
    to: 'DEFENSE_INCONCLUSIVE',
  },
  { from: 'DEFENSE_INCONCLUSIVE', event: 'DEFENSE_RETRY', to: 'DEFENSE' },
  { from: 'PUBLISHED', event: 'NEW_DISPUTE', to: 'DISPUTED' },
  { from: 'DISPUTED', event: 'DISPUTE_REPAIR', to: 'REGRESSION' },
];

export class IllegalTransitionError extends Error {
  constructor(from: ItemState, event: StateEvent) {
    super(`Illegal transition: ${from} --${event}-->`);
    this.name = 'IllegalTransitionError';
  }
}

/**
 * Resolves a lifecycle event through TRANSITIONS. Guard semantics (for example,
 * ensuring a repair created a new version) are enforced by the caller before
 * dispatching the event.
 */
export function reduce(from: ItemState, event: StateEvent): ItemState {
  const transition = TRANSITIONS.find(
    (candidate) => candidate.from === from && candidate.event === event,
  );

  if (transition === undefined) {
    throw new IllegalTransitionError(from, event);
  }

  return transition.to;
}

/** Returns whether the event is legal from the given state without throwing. */
export function canTransition(from: ItemState, event: StateEvent): boolean {
  return TRANSITIONS.some(
    (transition) => transition.from === from && transition.event === event,
  );
}
