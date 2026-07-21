/**
 * LA FORJA — item lifecycle state machine spec (doc §5, §7.1; gate §13.1).
 *
 * CONVENTION (Claude/Codex split): src/core/stateMachine.ts is CODEX-owned and its
 * functions currently throw. Every suite here is therefore `describe.skip` with a
 * REAL, fully written body: the assertions are the specification, they typecheck
 * today, and they run the moment Codex removes the `.skip`. Nothing in this file is
 * a placeholder — Codex's punch-list is exactly the skipped suites below.
 *
 * The approved transition map is duplicated here ON PURPOSE. TRANSITIONS in the
 * source is the implementation; APPROVED below is the independent spec it is
 * checked against. If the two ever diverge, the design review (doc §5) wins.
 */
import { describe, expect, it } from 'vitest';

import { ITEM_STATES, STATE_EVENTS } from '@/core/types';
import type { ItemState, StateEvent } from '@/core/types';
import { IllegalTransitionError, TRANSITIONS, canTransition, reduce } from '@/core/stateMachine';

// ---------------------------------------------------------------------------
// The approved map — the ONLY 12 legal edges.
// ---------------------------------------------------------------------------
const APPROVED: ReadonlyArray<readonly [ItemState, StateEvent, ItemState]> = [
  ['DRAFT', 'SUBMIT_TO_GAUNTLET', 'GAUNTLET'],
  ['GAUNTLET', 'CHECKS_ACCEPTED', 'CHALLENGED'],
  ['GAUNTLET', 'GAUNTLET_CLEAN', 'DEFENSE'],
  ['CHALLENGED', 'SUBMIT_REPAIR', 'REGRESSION'],
  ['REGRESSION', 'HISTORY_REGRESSED', 'CHALLENGED'],
  ['REGRESSION', 'HISTORY_CLEAN', 'DEFENSE'],
  ['DEFENSE', 'DEFENSE_PASSED', 'PUBLISHED'],
  ['DEFENSE', 'DEFENSE_FAILED', 'CHALLENGED'],
  ['DEFENSE', 'DEFENSE_EVALUATOR_FAILED', 'DEFENSE_INCONCLUSIVE'],
  ['DEFENSE_INCONCLUSIVE', 'DEFENSE_RETRY', 'DEFENSE'],
  ['PUBLISHED', 'NEW_DISPUTE', 'DISPUTED'],
  ['DISPUTED', 'DISPUTE_REPAIR', 'REGRESSION'],
];

const edgeKey = (from: ItemState, event: StateEvent): string => `${from}|${event}`;

const APPROVED_TO = new Map<string, ItemState>(
  APPROVED.map(([from, event, to]) => [edgeKey(from, event), to] as const),
);

const isApproved = (from: ItemState, event: StateEvent): boolean =>
  APPROVED_TO.has(edgeKey(from, event));

// ---------------------------------------------------------------------------

describe.skip('stateMachine — the transition table', () => {
  it('contains exactly the 12 approved edges and nothing else', () => {
    expect(TRANSITIONS).toHaveLength(APPROVED.length);

    const actual = TRANSITIONS.map((t) => `${t.from}|${t.event}|${t.to}`).sort();
    const expected = APPROVED.map(([from, event, to]) => `${from}|${event}|${to}`).sort();

    expect(actual).toEqual(expected);
  });

  it('uses every declared StateEvent exactly once', () => {
    const events = TRANSITIONS.map((t) => t.event).sort();
    expect(events).toEqual([...STATE_EVENTS].sort());
  });

  it('never targets a state outside ITEM_STATES', () => {
    for (const transition of TRANSITIONS) {
      expect(ITEM_STATES).toContain(transition.from);
      expect(ITEM_STATES).toContain(transition.to);
    }
  });
});

describe.skip('stateMachine — every legal transition, one assertion each', () => {
  for (const [from, event, to] of APPROVED) {
    it(`${from} --${event}--> ${to}`, () => {
      expect(reduce(from, event)).toBe(to);
      expect(canTransition(from, event)).toBe(true);
    });
  }
});

describe.skip('stateMachine — DEFENSE_INCONCLUSIVE (evaluator failure is never a rejection)', () => {
  it('DEFENSE --DEFENSE_EVALUATOR_FAILED--> DEFENSE_INCONCLUSIVE', () => {
    expect(reduce('DEFENSE', 'DEFENSE_EVALUATOR_FAILED')).toBe('DEFENSE_INCONCLUSIVE');
  });

  it('DEFENSE_INCONCLUSIVE --DEFENSE_RETRY--> DEFENSE', () => {
    expect(reduce('DEFENSE_INCONCLUSIVE', 'DEFENSE_RETRY')).toBe('DEFENSE');
  });

  it('an evaluator failure never lands on the rejection branch (doc §6.3)', () => {
    const landing = reduce('DEFENSE', 'DEFENSE_EVALUATOR_FAILED');

    // DEFENSE_FAILED is the rejection branch; an evaluator failure must NOT reuse it.
    expect(landing).not.toBe(reduce('DEFENSE', 'DEFENSE_FAILED'));
    expect(landing).not.toBe('CHALLENGED');
    expect(landing).not.toBe('PUBLISHED');
  });

  it('DEFENSE_INCONCLUSIVE is recoverable, not terminal', () => {
    const outgoing = STATE_EVENTS.filter((event) => canTransition('DEFENSE_INCONCLUSIVE', event));
    expect(outgoing).toEqual(['DEFENSE_RETRY']);
  });

  it('a retry loop returns to DEFENSE without passing through publish or rejection', () => {
    const afterFailure = reduce('DEFENSE', 'DEFENSE_EVALUATOR_FAILED');
    const afterRetry = reduce(afterFailure, 'DEFENSE_RETRY');
    expect(afterRetry).toBe('DEFENSE');
  });
});

describe.skip('stateMachine — the full cartesian product (ITEM_STATES x STATE_EVENTS)', () => {
  it('accepts exactly the approved pairs and throws IllegalTransitionError on every other pair', () => {
    const actual: string[] = [];
    for (const from of ITEM_STATES) {
      for (const event of STATE_EVENTS) {
        let outcome: string;
        try {
          outcome = reduce(from, event);
        } catch (err: unknown) {
          outcome =
            err instanceof IllegalTransitionError
              ? 'ILLEGAL'
              : `WRONG_ERROR_TYPE:${String(err)}`;
        }
        actual.push(`${from}|${event}|${outcome}`);
      }
    }

    const expected = ITEM_STATES.flatMap((from) =>
      STATE_EVENTS.map(
        (event) => `${from}|${event}|${APPROVED_TO.get(edgeKey(from, event)) ?? 'ILLEGAL'}`,
      ),
    );

    expect(actual).toEqual(expected);
  });

  it('canTransition agrees with reduce for all 96 pairs', () => {
    const actual: string[] = [];
    const expected: string[] = [];
    for (const from of ITEM_STATES) {
      for (const event of STATE_EVENTS) {
        actual.push(`${from}|${event}|${canTransition(from, event)}`);
        expected.push(`${from}|${event}|${isApproved(from, event)}`);
      }
    }
    expect(actual).toEqual(expected);
  });

  it('canTransition never throws, for any pair', () => {
    for (const from of ITEM_STATES) {
      for (const event of STATE_EVENTS) {
        expect(() => canTransition(from, event)).not.toThrow();
      }
    }
  });

  it('the illegal set is exactly 96 - 12 = 84 pairs', () => {
    const illegal = ITEM_STATES.flatMap((from) =>
      STATE_EVENTS.filter((event) => !isApproved(from, event)).map((event) =>
        edgeKey(from, event),
      ),
    );
    expect(illegal).toHaveLength(ITEM_STATES.length * STATE_EVENTS.length - APPROVED.length);

    for (const from of ITEM_STATES) {
      for (const event of STATE_EVENTS) {
        if (isApproved(from, event)) continue;
        expect(() => reduce(from, event)).toThrow(IllegalTransitionError);
      }
    }
  });
});

describe.skip('stateMachine — published immutability and the v2 route back', () => {
  it('PUBLISHED has exactly one outgoing edge: NEW_DISPUTE', () => {
    const outgoing = STATE_EVENTS.filter((event) => canTransition('PUBLISHED', event));
    expect(outgoing).toEqual(['NEW_DISPUTE']);
  });

  it('no event mutates a PUBLISHED version in place — repairs must leave PUBLISHED', () => {
    // A published version is immutable: nothing may transition PUBLISHED -> PUBLISHED,
    // and no repair event is accepted while PUBLISHED.
    for (const event of STATE_EVENTS) {
      if (event === 'NEW_DISPUTE') {
        expect(reduce('PUBLISHED', event)).toBe('DISPUTED');
        continue;
      }
      expect(() => reduce('PUBLISHED', event)).toThrow(IllegalTransitionError);
    }
    expect(canTransition('PUBLISHED', 'SUBMIT_REPAIR')).toBe(false);
    expect(canTransition('PUBLISHED', 'DISPUTE_REPAIR')).toBe(false);
  });

  it('DISPUTED re-enters the cycle only through DISPUTE_REPAIR -> REGRESSION (the v2 path)', () => {
    const outgoing = STATE_EVENTS.filter((event) => canTransition('DISPUTED', event));
    expect(outgoing).toEqual(['DISPUTE_REPAIR']);
    expect(reduce('DISPUTED', 'DISPUTE_REPAIR')).toBe('REGRESSION');
  });

  it('a dispute repair lands in REGRESSION so the FULL history is re-run before publish (doc §5)', () => {
    const afterDispute = reduce('PUBLISHED', 'NEW_DISPUTE');
    const afterRepair = reduce(afterDispute, 'DISPUTE_REPAIR');
    expect(afterRepair).toBe('REGRESSION');

    // From REGRESSION the only two outcomes are the history verdicts — there is no
    // shortcut back to PUBLISHED that skips the re-run.
    const fromRegression = STATE_EVENTS.filter((event) => canTransition('REGRESSION', event));
    expect(fromRegression.sort()).toEqual(['HISTORY_CLEAN', 'HISTORY_REGRESSED']);
    expect(canTransition('REGRESSION', 'DEFENSE_PASSED')).toBe(false);
  });

  it('PUBLISHED is only ever reached from DEFENSE via DEFENSE_PASSED', () => {
    const inbound = APPROVED.filter(([, , to]) => to === 'PUBLISHED');
    expect(inbound).toHaveLength(1);

    for (const from of ITEM_STATES) {
      for (const event of STATE_EVENTS) {
        if (from === 'DEFENSE' && event === 'DEFENSE_PASSED') continue;
        if (!isApproved(from, event)) continue;
        expect(reduce(from, event)).not.toBe('PUBLISHED');
      }
    }
  });
});
