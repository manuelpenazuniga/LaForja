/**
 * LA FORJA — bounded probability solver spec (doc §5 deterministic class, §7.2; gate §13.3).
 *
 * CONVENTION (Claude/Codex split): solveProbability() in src/solver/probability.ts is
 * CODEX-owned and verified by the fully written assertions below. reduceFraction()
 * is Claude-owned and is tested independently before the solver suites.
 *
 * The golden values come from the labeled smoke set (author-labeled, doc §8) and
 * from the seeded demo item; each test names its fixture.
 *
 * PROBLEM ENCODING CONTRACT (this file defines the shapes Codex implements; the
 * `params` bag in ProbabilityProblem is intentionally open, so these are the only
 * shapes the MVP must support — anything else returns { supported: false }):
 *
 *   kind 'basic'        — one enumerated experiment, one event.
 *       experiment 'two_fair_dice'   : event 'at_least_one_six' | 'exactly_one_six' | 'both_six'
 *       experiment 'fair_coin_flips' : flips: n, event 'exactly_k_heads', k: n
 *   kind 'conditional'  — P(event | given) over the same enumerated experiments.
 *       experiment 'two_fair_dice', event 'both_six', given 'at_least_one_six'
 *   kind 'combinatoric' — sequential draws from a two-colour urn.
 *       experiment 'urn_draws', favorable: n, unfavorable: m, draws: d,
 *       replacement: boolean, event 'all_favorable'
 *       ("favorable" = the colour the item asks about.)
 *
 * RESULT CONTRACT: `value` is an EXACT fraction in LOWEST TERMS (reduceFraction),
 * `decimal` is its decimal approximation, `steps` is a non-empty reproducible trace.
 * Unsupported shape ⇒ { supported: false } with no value, no decimal — never a guess.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_DRAWS,
  MAX_FLIPS,
  MAX_SAMPLE_SPACE_SIZE,
  reduceFraction,
  solveProbability,
} from '@/solver/probability';
import type { ProbabilityProblem, SolverResult } from '@/solver/probability';

/** Build an urn problem with only `draws` varying — the depth-bound parameter. */
function urn(draws: number, overrides: Record<string, number | string | boolean> = {}): ProbabilityProblem {
  return {
    discipline: 'probability',
    kind: 'combinatoric',
    params: {
      experiment: 'urn_draws',
      favorable: 1,
      unfavorable: 0,
      draws,
      replacement: true,
      event: 'all_favorable',
      ...overrides,
    },
  };
}

/** Assert an exact rational answer plus its decimal and a reproducible trace. */
function expectFraction(result: SolverResult, numerator: number, denominator: number): void {
  expect(result.supported).toBe(true);
  expect(result.value).toEqual({ numerator, denominator });
  expect(result.decimal ?? Number.NaN).toBeCloseTo(numerator / denominator, 10);
  expect(result.steps ?? []).not.toHaveLength(0);
}

// ---------------------------------------------------------------------------
// Claude-owned helper — NOT skipped. This must pass right now.
// ---------------------------------------------------------------------------
describe('reduceFraction (Claude-owned, must pass today)', () => {
  it('reduces the smoke-set values to lowest terms', () => {
    // factual-error-002: (4/10)·(3/9) = 12/90 = 2/15
    expect(reduceFraction(12, 90)).toEqual({ numerator: 2, denominator: 15 });
    // ambiguous-002 without replacement: (13/52)·(12/51) = 156/2652 = 1/17
    expect(reduceFraction(156, 2652)).toEqual({ numerator: 1, denominator: 17 });
    // ambiguous-002 with replacement: (13/52)² = 169/2704 = 1/16
    expect(reduceFraction(169, 2704)).toEqual({ numerator: 1, denominator: 16 });
    // ambiguous-001 "exactly one 6": 10/36 = 5/18
    expect(reduceFraction(10, 36)).toEqual({ numerator: 5, denominator: 18 });
    // the author's wrong key in factual-error-002: (4/10)² = 16/100 = 4/25
    expect(reduceFraction(16, 100)).toEqual({ numerator: 4, denominator: 25 });
  });

  it('leaves already-reduced fractions untouched', () => {
    expect(reduceFraction(3, 8)).toEqual({ numerator: 3, denominator: 8 });
    expect(reduceFraction(11, 36)).toEqual({ numerator: 11, denominator: 36 });
    expect(reduceFraction(1, 11)).toEqual({ numerator: 1, denominator: 11 });
    expect(reduceFraction(2, 15)).toEqual({ numerator: 2, denominator: 15 });
  });

  it('normalises the sign onto the numerator', () => {
    expect(reduceFraction(1, -2)).toEqual({ numerator: -1, denominator: 2 });
    expect(reduceFraction(-4, 8)).toEqual({ numerator: -1, denominator: 2 });
    expect(reduceFraction(-4, -8)).toEqual({ numerator: 1, denominator: 2 });
  });

  it('reduces zero to 0/1', () => {
    expect(reduceFraction(0, 5)).toEqual({ numerator: 0, denominator: 1 });
  });

  it('is idempotent', () => {
    const once = reduceFraction(12, 90);
    const twice = reduceFraction(once.numerator, once.denominator);
    expect(twice).toEqual(once);
  });
});

// ---------------------------------------------------------------------------
// Codex-owned solver — golden tests against the real smoke-set math.
// ---------------------------------------------------------------------------
describe('solveProbability — factual_error fixtures (the planted defects)', () => {
  it('factual-error-001: P(both 6 | at least one 6) with two fair dice = 1/11, not the marked 1/6', () => {
    const problem: ProbabilityProblem = {
      discipline: 'probability',
      kind: 'conditional',
      params: {
        experiment: 'two_fair_dice',
        event: 'both_six',
        given: 'at_least_one_six',
      },
    };

    const result = solveProbability(problem);

    // |{(6,6)}| / |{at least one 6}| = 1 / 11.
    expectFraction(result, 1, 11);

    // This is exactly why the item is labeled factual_error: the author marked
    // option A = "1/6", and 1/6 !== 1/11.
    expect(result.value).not.toEqual({ numerator: 1, denominator: 6 });
    expect(result.decimal ?? Number.NaN).not.toBeCloseTo(1 / 6, 5);
  });

  it('factual-error-002: two white in a row from 4 white + 6 black WITHOUT replacement = 2/15', () => {
    const problem: ProbabilityProblem = {
      discipline: 'probability',
      kind: 'combinatoric',
      params: {
        experiment: 'urn_draws',
        favorable: 4, // white
        unfavorable: 6, // black
        draws: 2,
        replacement: false,
        event: 'all_favorable',
      },
    };

    // (4/10)·(3/9) = 12/90 = 2/15.
    expectFraction(solveProbability(problem), 2, 15);
  });

  it('factual-error-002: the marked key 4/25 is the WITH-replacement value (the author\'s error)', () => {
    const withReplacement: ProbabilityProblem = {
      discipline: 'probability',
      kind: 'combinatoric',
      params: {
        experiment: 'urn_draws',
        favorable: 4,
        unfavorable: 6,
        draws: 2,
        replacement: true,
        event: 'all_favorable',
      },
    };

    // (4/10)² = 16/100 = 4/25 — correct arithmetic for a reading the stem excludes.
    expectFraction(solveProbability(withReplacement), 4, 25);

    const withoutReplacement: ProbabilityProblem = {
      discipline: 'probability',
      kind: 'combinatoric',
      params: {
        experiment: 'urn_draws',
        favorable: 4,
        unfavorable: 6,
        draws: 2,
        replacement: false,
        event: 'all_favorable',
      },
    };

    // The stem says "sin reposición", so the two values must not coincide: that gap
    // is the reproducible evidence the discipline reviewer cites.
    expect(solveProbability(withoutReplacement).value).not.toEqual(
      solveProbability(withReplacement).value,
    );
  });
});

describe('solveProbability — clean fixtures (no defect; false-positive guard)', () => {
  it('clean-002: exactly two heads in three fair coin flips = 3/8', () => {
    const problem: ProbabilityProblem = {
      discipline: 'probability',
      kind: 'basic',
      params: {
        experiment: 'fair_coin_flips',
        flips: 3,
        event: 'exactly_k_heads',
        k: 2,
      },
    };

    // 8 equiprobable sequences; HHT, HTH, THH are favorable.
    expectFraction(solveProbability(problem), 3, 8);
  });

  it('clean-001: one red from 3 red + 5 blue = 3/8', () => {
    const problem: ProbabilityProblem = {
      discipline: 'probability',
      kind: 'combinatoric',
      params: {
        experiment: 'urn_draws',
        favorable: 3, // red
        unfavorable: 5, // blue
        draws: 1,
        replacement: false,
        event: 'all_favorable',
      },
    };

    expectFraction(solveProbability(problem), 3, 8);
  });

  it('clean fixtures agree with the key the author marked (option A in both)', () => {
    const coin = solveProbability({
      discipline: 'probability',
      kind: 'basic',
      params: { experiment: 'fair_coin_flips', flips: 3, event: 'exactly_k_heads', k: 2 },
    });
    const urn = solveProbability({
      discipline: 'probability',
      kind: 'combinatoric',
      params: {
        experiment: 'urn_draws',
        favorable: 3,
        unfavorable: 5,
        draws: 1,
        replacement: false,
        event: 'all_favorable',
      },
    });

    expect(coin.value).toEqual({ numerator: 3, denominator: 8 });
    expect(urn.value).toEqual({ numerator: 3, denominator: 8 });
  });
});

describe('solveProbability — ambiguity fixtures (two readings must yield DIFFERENT answers)', () => {
  it('ambiguous-001: at least one 6 = 11/36 and exactly one 6 = 10/36, and they differ', () => {
    const atLeastOne = solveProbability({
      discipline: 'probability',
      kind: 'basic',
      params: { experiment: 'two_fair_dice', event: 'at_least_one_six' },
    });
    const exactlyOne = solveProbability({
      discipline: 'probability',
      kind: 'basic',
      params: { experiment: 'two_fair_dice', event: 'exactly_one_six' },
    });

    // Reading A — "al menos un 6": 11 of 36 outcomes. Already in lowest terms.
    expectFraction(atLeastOne, 11, 36);
    // Reading B — "exactamente un 6": 10 of 36 outcomes = 5/18 in lowest terms.
    expectFraction(exactlyOne, 5, 18);
    expect(exactlyOne.decimal ?? Number.NaN).toBeCloseTo(10 / 36, 10);

    // The ambiguity attack is valid ONLY because the answers differ (doc §6.2).
    expect(atLeastOne.value).not.toEqual(exactlyOne.value);
    expect(atLeastOne.decimal ?? Number.NaN).not.toBeCloseTo(exactlyOne.decimal ?? 0, 5);
  });

  it('ambiguous-002: two hearts without replacement = 1/17, with replacement = 1/16, and they differ', () => {
    const withoutReplacement = solveProbability({
      discipline: 'probability',
      kind: 'combinatoric',
      params: {
        experiment: 'urn_draws',
        favorable: 13, // hearts
        unfavorable: 39, // the rest of the 52-card deck
        draws: 2,
        replacement: false,
        event: 'all_favorable',
      },
    });
    const withReplacement = solveProbability({
      discipline: 'probability',
      kind: 'combinatoric',
      params: {
        experiment: 'urn_draws',
        favorable: 13,
        unfavorable: 39,
        draws: 2,
        replacement: true,
        event: 'all_favorable',
      },
    });

    // (13/52)·(12/51) = 1/17 versus (13/52)² = 1/16.
    expectFraction(withoutReplacement, 1, 17);
    expectFraction(withReplacement, 1, 16);
    expect(withoutReplacement.value).not.toEqual(withReplacement.value);
  });
});

describe('solveProbability — determinism and bounded scope', () => {
  it('returns an identical result for the same problem solved twice', () => {
    const problem: ProbabilityProblem = {
      discipline: 'probability',
      kind: 'conditional',
      params: {
        experiment: 'two_fair_dice',
        event: 'both_six',
        given: 'at_least_one_six',
      },
    };

    const first = solveProbability(problem);
    const second = solveProbability(problem);

    expect(second).toEqual(first);
    expect(second.value).toEqual(first.value);
    expect(second.steps).toEqual(first.steps);
  });

  it('is insensitive to key order in params (same problem, same result)', () => {
    const a = solveProbability({
      discipline: 'probability',
      kind: 'combinatoric',
      params: {
        experiment: 'urn_draws',
        favorable: 4,
        unfavorable: 6,
        draws: 2,
        replacement: false,
        event: 'all_favorable',
      },
    });
    const b = solveProbability({
      discipline: 'probability',
      kind: 'combinatoric',
      params: {
        event: 'all_favorable',
        replacement: false,
        draws: 2,
        unfavorable: 6,
        favorable: 4,
        experiment: 'urn_draws',
      },
    });

    expect(b.value).toEqual(a.value);
    expect(b.decimal).toEqual(a.decimal);
  });

  it('returns { supported: false } for an unsupported shape and never guesses', () => {
    const outOfScope: ProbabilityProblem = {
      discipline: 'probability',
      kind: 'basic',
      params: { experiment: 'markov_chain_stationary_distribution', states: 4 },
    };

    const result = solveProbability(outOfScope);

    expect(result.supported).toBe(false);
    expect(result.value).toBeUndefined();
    expect(result.decimal).toBeUndefined();
  });

  it('returns { supported: false } for a known experiment with an unknown event', () => {
    const result = solveProbability({
      discipline: 'probability',
      kind: 'basic',
      params: { experiment: 'two_fair_dice', event: 'sum_is_prime_and_product_is_square' },
    });

    expect(result.supported).toBe(false);
    expect(result.value).toBeUndefined();
  });

  it('returns { supported: false } rather than dividing by an empty conditioning event', () => {
    // P(A|B) is undefined when B is impossible. The bounded verifier abstains here;
    // the discipline reviewer then reports `unverified`, never `correct` (doc §6.2).
    const result = solveProbability({
      discipline: 'probability',
      kind: 'conditional',
      params: { experiment: 'two_fair_dice', event: 'both_six', given: 'impossible_event' },
    });

    expect(result.supported).toBe(false);
    expect(result.value).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// REGRESSION (audit D1): the solver bounded the WIDTH of an enumeration but not
// its DEPTH.
//
// orderedDrawCount() guarded the sample-space SIZE against MAX_SAMPLE_SPACE_SIZE,
// but enumerate() recurses once per DRAW. With population = 1 and replacement the
// ordered-draw count stays 1 for any number of draws, so the size check passed
// while the recursion went `draws` frames deep: draws = 50000 crashed the
// process, taking down the ground truth the entire eval is checked against.
//
// The bound is published (MAX_DRAWS / MAX_FLIPS) and the solver REFUSES beyond
// it. Refusing is the required behaviour: `unverified` is a legitimate verdict,
// a crash and a guess are not.
// ---------------------------------------------------------------------------
describe('solveProbability — published bounds (depth as well as width)', () => {
  it('publishes bounds that are safe integers', () => {
    expect(Number.isSafeInteger(MAX_DRAWS)).toBe(true);
    expect(Number.isSafeInteger(MAX_FLIPS)).toBe(true);
    expect(Number.isSafeInteger(MAX_SAMPLE_SPACE_SIZE)).toBe(true);
    expect(MAX_DRAWS).toBeGreaterThan(0);
    expect(MAX_FLIPS).toBeGreaterThan(0);
  });

  it('does not crash and returns { supported: false } for an absurd draw count', () => {
    // The exact crash from the audit: population 1, with replacement, 50000 draws.
    // Sample-space size is 1, so the width guard never fires.
    const result = solveProbability(urn(50_000));

    expect(result.supported).toBe(false);
    expect(result.value).toBeUndefined();
    expect(result.decimal).toBeUndefined();
  });

  it('refuses just beyond MAX_DRAWS and still answers at MAX_DRAWS (boundary INCLUSIVE)', () => {
    expect(solveProbability(urn(MAX_DRAWS + 1)).supported).toBe(false);

    // Every draw is favorable out of a population of 1, so the answer is 1/1.
    expectFraction(solveProbability(urn(MAX_DRAWS)), 1, 1);
  });

  it('refuses a degenerate zero-draw urn instead of reporting a vacuous 1/1', () => {
    // draws = 0 also reached `new Array(population)` with a population the size
    // check had not bounded, which throws RangeError for a huge population.
    expect(solveProbability(urn(0)).supported).toBe(false);
    expect(solveProbability(urn(0, { favorable: 1e15, unfavorable: 0 })).supported).toBe(false);
  });

  it('refuses a non-integer or negative draw count rather than coercing it', () => {
    expect(solveProbability(urn(2.5)).supported).toBe(false);
    expect(solveProbability(urn(-1)).supported).toBe(false);
    expect(solveProbability(urn(Number.NaN)).supported).toBe(false);
    expect(solveProbability(urn(Number.POSITIVE_INFINITY)).supported).toBe(false);
  });

  it('refuses an oversized sample space (the width bound still holds)', () => {
    // 1000 items, 3 draws with replacement = 10^9 ordered sequences.
    expect(solveProbability(urn(3, { favorable: 1000, unfavorable: 0 })).supported).toBe(false);
  });

  it('refuses an absurd or degenerate flip count instead of enumerating it', () => {
    const flips = (n: number, k: number): ProbabilityProblem => ({
      discipline: 'probability',
      kind: 'basic',
      params: { experiment: 'fair_coin_flips', flips: n, event: 'exactly_k_heads', k },
    });

    expect(solveProbability(flips(50_000, 1)).supported).toBe(false);
    expect(solveProbability(flips(MAX_FLIPS + 1, 1)).supported).toBe(false);
    expect(solveProbability(flips(0, 0)).supported).toBe(false);
    expect(solveProbability(flips(2.5, 1)).supported).toBe(false);
  });

  it('never reports a probability outside [0, 1]', () => {
    // Sweep every supported urn shape that fits the bounds and assert the
    // invariant a "confidently wrong" answer would break.
    for (let population = 1; population <= 6; population += 1) {
      for (let favorable = 0; favorable <= population; favorable += 1) {
        for (let draws = 1; draws <= 4; draws += 1) {
          for (const replacement of [true, false]) {
            const result = solveProbability({
              discipline: 'probability',
              kind: 'combinatoric',
              params: {
                experiment: 'urn_draws',
                favorable,
                unfavorable: population - favorable,
                draws,
                replacement,
                event: 'all_favorable',
              },
            });

            if (result.supported !== true) continue;
            expect(result.decimal ?? Number.NaN).toBeGreaterThanOrEqual(0);
            expect(result.decimal ?? Number.NaN).toBeLessThanOrEqual(1);
            expect(result.value?.denominator ?? 0).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});

describe('reduceFraction — totality (audit D1 sweep)', () => {
  it('terminates on non-integer input instead of recursing forever', () => {
    // gcd() was recursive; 1 % 0.3 never lands cleanly on 0 and NaN % NaN is NaN,
    // so a non-integer argument spun the stack. It now declines to reduce.
    expect(reduceFraction(1, 0.3)).toEqual({ numerator: 1, denominator: 0.3 });
    expect(Number.isNaN(reduceFraction(Number.NaN, 2).numerator)).toBe(true);
  });

  it('still reduces large integer pairs without deep recursion', () => {
    expect(reduceFraction(1_000_000, 2_000_000)).toEqual({ numerator: 1, denominator: 2 });
  });
});
