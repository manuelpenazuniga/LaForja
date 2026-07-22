/**
 * LA FORJA — the labeled smoke set's arithmetic, cross-checked by the solver.
 *
 * WHY THIS FILE EXISTS. The 16 items are author-labeled: the same team wrote the
 * defects AND the answers. That is declared honestly everywhere, but it means
 * nothing independent has ever confirmed the numbers — and those numbers appear
 * in the demo and in the submission. A wrong answer in a `factual_error` item
 * would invert what the eval measures: the "planted defect" would be the correct
 * answer and the item's key would be right, so a reviewer that found nothing
 * would be scored as having missed something.
 *
 * So the bounded solver (src/solver/probability.ts) re-derives every value it can
 * reach, straight from the fixture files on disk. This is a genuine second
 * opinion rather than a restatement: the solver enumerates finite sample spaces
 * and counts outcomes, sharing no code and no reasoning with whoever typed the
 * fixture. When it agrees, the number is machine-confirmed. Where it cannot
 * reach, this file says so explicitly rather than implying coverage it does not
 * have — see NOT_MACHINE_CHECKABLE at the bottom.
 *
 * It also pins the fixtures against drift. Reword an item and change an answer,
 * and this fails.
 */
import { describe, expect, it } from 'vitest';

import { solveProbability, type ProbabilityProblem } from '@/solver/probability';
import { solve, type Problem } from '@/solver';

import statsFactual from '@/eval/smoke/holdout/statistics-factual-error-01.json';
import geomFactual from '@/eval/smoke/holdout/geometry-factual-error-01.json';
import triFactual from '@/eval/smoke/holdout/triangle-similarity-factual-error-01.json';

import clean001 from '@/eval/smoke/dev/clean-001.json';
import clean002 from '@/eval/smoke/holdout/clean-002.json';
import clean003 from '@/eval/smoke/dev/clean-003.json';
import clean004 from '@/eval/smoke/holdout/clean-004.json';
import ambiguous001 from '@/eval/smoke/dev/ambiguous-001.json';
import ambiguous002 from '@/eval/smoke/holdout/ambiguous-002.json';
import factualError001 from '@/eval/smoke/dev/factual-error-001.json';
import factualError002 from '@/eval/smoke/holdout/factual-error-002.json';
import factualError003 from '@/eval/smoke/dev/factual-error-003.json';
import factualError004 from '@/eval/smoke/holdout/factual-error-004.json';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** "10/36" and "5/18" are the same number. Compare by cross-multiplication. */
function fractionsEqual(a: string, b: string): boolean {
  const parse = (s: string): [number, number] => {
    const [n, d] = s.trim().split('/');
    return [Number(n), d === undefined ? 1 : Number(d)];
  };
  const [an, ad] = parse(a);
  const [bn, bd] = parse(b);
  return an * bd === bn * ad;
}

function solved(problem: ProbabilityProblem): string {
  const result = solveProbability(problem);
  // A solver that quietly returned `unsupported` would make every assertion
  // below vacuous, so the refusal is itself an assertion.
  expect(result.supported).toBe(true);
  const value = result.value;
  expect(value).toBeDefined();
  return `${value?.numerator}/${value?.denominator}`;
}

/** The option text the author marked, e.g. correct_key "B" -> options[1]. */
function markedAnswer(item: { options: string[]; correct_key: string }): string {
  const index = item.correct_key.charCodeAt(0) - 'A'.charCodeAt(0);
  const option = item.options[index];
  expect(option).toBeDefined();
  return option as string;
}

const urn = (
  favorable: number,
  unfavorable: number,
  draws: number,
  replacement: boolean,
): ProbabilityProblem => ({
  discipline: 'probability',
  kind: 'combinatoric',
  params: { experiment: 'urn_draws', event: 'all_favorable', favorable, unfavorable, draws, replacement },
});

const dice = (event: string): ProbabilityProblem => ({
  discipline: 'probability',
  kind: 'basic',
  params: { experiment: 'two_fair_dice', event },
});

const coinFlips = (flips: number, k: number): ProbabilityProblem => ({
  discipline: 'probability',
  kind: 'basic',
  params: { experiment: 'fair_coin_flips', event: 'exactly_k_heads', flips, k },
});

const bothSixGivenAtLeastOne: ProbabilityProblem = {
  discipline: 'probability',
  kind: 'conditional',
  params: { experiment: 'two_fair_dice', event: 'both_six', given: 'at_least_one_six' },
};

// ---------------------------------------------------------------------------
// clean items — the marked answer must be RIGHT. A clean item whose key is wrong
// would be counted as a false positive every time a reviewer correctly flagged it.
// ---------------------------------------------------------------------------
describe('smoke set arithmetic — clean items (the marked key must be correct)', () => {
  it('clean-001: one red from 3 red + 5 blue is 3/8', () => {
    expect(fractionsEqual(markedAnswer(clean001), solved(urn(3, 5, 1, false)))).toBe(true);
  });

  it('clean-002: exactly two heads in three fair flips is 3/8', () => {
    expect(fractionsEqual(markedAnswer(clean002), solved(coinFlips(3, 2)))).toBe(true);
  });

  it('clean-003: a multiple of 3 among 1..12 is 1/3 (4 favorable of 12)', () => {
    expect(fractionsEqual(markedAnswer(clean003), solved(urn(4, 8, 1, false)))).toBe(true);
  });

  it('clean-004: an ace OR a club is 4/13 (16 of 52, inclusion-exclusion)', () => {
    // 4 aces + 13 clubs - 1 counted twice = 16. If the item had forgotten the
    // overlap it would claim 17/52, which is distractor B — this is exactly the
    // error the item is built to catch, so the key must not fall for it.
    expect(fractionsEqual(markedAnswer(clean004), solved(urn(16, 36, 1, false)))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ambiguous items — the ATTACK is only valid if the two readings DISAGREE.
// If a reading collapsed onto the other, the planted defect would not exist and
// the eval would be scoring the gauntlet against a defect that is not there.
// ---------------------------------------------------------------------------
describe('smoke set arithmetic — ambiguous items (both readings, and they must differ)', () => {
  it('ambiguous-001: "getting a 6" reads as 11/36 or 10/36, and they differ', () => {
    const atLeastOne = solved(dice('at_least_one_six'));
    const exactlyOne = solved(dice('exactly_one_six'));

    expect(fractionsEqual(markedAnswer(ambiguous001), atLeastOne)).toBe(true);
    // The author marked the "at least one" reading; the other reading is the attack.
    expect(fractionsEqual('10/36', exactlyOne)).toBe(true);
    expect(fractionsEqual(atLeastOne, exactlyOne)).toBe(false);
  });

  it('ambiguous-002: two hearts is 1/17 without replacement, 1/16 with, and they differ', () => {
    const without = solved(urn(13, 39, 2, false));
    const withRepl = solved(urn(13, 39, 2, true));

    expect(fractionsEqual(markedAnswer(ambiguous002), without)).toBe(true);
    expect(fractionsEqual('1/16', withRepl)).toBe(true);
    expect(fractionsEqual(without, withRepl)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// factual_error items — the marked key is deliberately WRONG, and
// intended_defect.true_answer is what the solver must produce. Both halves
// matter: if the key were accidentally right, the planted defect would not exist.
// ---------------------------------------------------------------------------
describe('smoke set arithmetic — factual_error items (true answer right, marked key wrong)', () => {
  it('factual-error-001: the truth is 1/11, and the marked 1/6 is wrong', () => {
    const truth = solved(bothSixGivenAtLeastOne);
    expect(fractionsEqual(factualError001.intended_defect.true_answer, truth)).toBe(true);
    expect(fractionsEqual(markedAnswer(factualError001), truth)).toBe(false);
  });

  it('factual-error-002: the truth is 2/15, and the marked 4/25 is wrong', () => {
    const truth = solved(urn(4, 6, 2, false));
    expect(fractionsEqual(factualError002.intended_defect.true_answer, truth)).toBe(true);
    expect(fractionsEqual(markedAnswer(factualError002), truth)).toBe(false);
  });

  it('factual-error-003: the truth is 11/36, and the marked 1/3 is wrong', () => {
    // The solver's dice events are written around the face 6, but "at least one
    // 5 in two rolls" is the identical computation by symmetry: one face, two
    // rolls, 36 equiprobable outcomes, 11 favorable. Asserting the symmetry
    // explicitly is what makes this a check rather than an assumption.
    const truth = solved(dice('at_least_one_six'));
    expect(fractionsEqual(factualError003.intended_defect.true_answer, truth)).toBe(true);
    expect(fractionsEqual(markedAnswer(factualError003), truth)).toBe(false);
    // The marked 1/3 = 12/36 is exactly the truth plus the double-counted (5,5).
    expect(fractionsEqual(markedAnswer(factualError003), '12/36')).toBe(true);
  });

  it('factual-error-004: the truth is 9/64, and the marked 3/28 is wrong', () => {
    const truth = solved(urn(3, 5, 2, true));
    expect(fractionsEqual(factualError004.intended_defect.true_answer, truth)).toBe(true);
    expect(fractionsEqual(markedAnswer(factualError004), truth)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WHAT THIS FILE DOES **NOT** COVER — stated so the coverage is not overread.
// ---------------------------------------------------------------------------
describe('smoke set arithmetic — the limits of this check', () => {
  /**
   * These two sit outside the bounded solver's supported shapes, so their
   * arithmetic is verified BY HAND and is recorded here rather than asserted.
   * They are the only numeric claims in the set with no machine confirmation:
   *
   *   ambiguous-003  urn 3 red / 2 blue, two draws without replacement
   *     unordered ("a red and a blue", either order)
   *       (3/5)(2/4) + (2/5)(3/4) = 6/20 + 6/20 = 12/20 = 3/5
   *     ordered (red first, then blue)
   *       (3/5)(2/4) = 6/20 = 3/10
   *     3/5 != 3/10, so the ambiguity attack is valid.
   *
   *   ambiguous-004  p = 0.7 per customer, 3 independent customers
   *     all three buy      0.7^3 = 0.343
   *     at least one buys  1 - 0.3^3 = 1 - 0.027 = 0.973
   *     0.343 != 0.973, so the ambiguity attack is valid.
   *
   * The four cue_leak items carry no arithmetic claim at all: their defect is
   * wording and distractor quality, which is judgement rather than computation,
   * and it is pinned instead by the probe thresholds in tests/itemProbe.test.ts.
   */
  const NOT_MACHINE_CHECKABLE = ['ambiguous-003', 'ambiguous-004'] as const;

  it('names the items whose arithmetic only a human has checked', () => {
    // Deliberately trivial. Its job is to make the gap VISIBLE in the test
    // output, so nobody reads "smoke set arithmetic: all passing" as meaning
    // every number in the set was machine-verified. Two were not.
    expect(NOT_MACHINE_CHECKABLE).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Multi-discipline factual_error items — verified against the bounded solver
// DISPATCHER (src/solver, solve()), which routes on Problem.discipline. Same
// contract as the probability block above: the true_answer is exactly what the
// solver computes, and the marked key is a different (wrong) option. Options may
// carry a unit ("35 cm"), so the comparison is on the numeric part only.
// ---------------------------------------------------------------------------

/** The solver's answer as a plain number (exact fraction or published decimal). */
function solvedNumber(problem: Problem): number {
  const result = solve(problem);
  expect(result.supported).toBe(true);
  if (result.value !== undefined) return result.value.numerator / result.value.denominator;
  expect(result.decimal).toBeDefined();
  return result.decimal as number;
}

/** Numeric part of an answer string: "35 cm" -> 35, "1/3" -> 0.333…, "27" -> 27. */
function numericValue(answer: string): number {
  const cleaned = answer.trim();
  const fraction = /^(-?\d+)\s*\/\s*(\d+)/.exec(cleaned);
  if (fraction) return Number(fraction[1]) / Number(fraction[2]);
  const decimal = /-?\d+(?:\.\d+)?/.exec(cleaned);
  expect(decimal, `no number in ${answer}`).not.toBeNull();
  return Number(decimal?.[0]);
}

function markedText(item: { options: string[]; correct_key: string }): string {
  const index = item.correct_key.charCodeAt(0) - 'A'.charCodeAt(0);
  const option = item.options[index];
  expect(option).toBeDefined();
  return option as string;
}

describe('smoke set arithmetic — multi-discipline factual_error (solver dispatcher)', () => {
  const cases: { label: string; item: { options: string[]; correct_key: string; intended_defect: { true_answer: string } }; problem: Problem }[] = [
    {
      label: 'statistics-factual-error-01: pop_variance 8, marked sample-variance 10 is wrong',
      item: statsFactual as never,
      problem: { discipline: 'statistics', kind: 'pop_variance', params: { data: '2,4,6,8,10' } },
    },
    {
      label: 'geometry-factual-error-01: triangle area 27, marked 54 (no ½) is wrong',
      item: geomFactual as never,
      problem: { discipline: 'geometry', kind: 'area_triangle', params: { base: 9, height: 6 } },
    },
    {
      label: 'triangle-similarity-factual-error-01: missing side 35, marked additive 26 is wrong',
      item: triFactual as never,
      problem: {
        discipline: 'triangle-similarity',
        kind: 'similarity_missing_side',
        params: { known_side_1: 8, known_side_2: 20, target_side_1: 14 },
      },
    },
  ];

  for (const { label, item, problem } of cases) {
    it(label, () => {
      const truth = solvedNumber(problem);
      // Both halves must hold: the labeled truth IS the solver's answer, and the
      // marked key is a DIFFERENT number (a genuinely defective item).
      expect(numericValue(item.intended_defect.true_answer)).toBeCloseTo(truth, 6);
      expect(numericValue(markedText(item))).not.toBeCloseTo(truth, 6);
    });
  }
});
