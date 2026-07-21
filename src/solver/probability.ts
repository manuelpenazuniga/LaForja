/**
 * LA FORJA — deterministic bounded probability solver (doc §5, §7.2).
 *
 * OWNER: Codex. Reproducible computation of item answers for the demo discipline
 * (combinatorics / conditional probability). This is the GROUND TRUTH the
 * discipline reviewer is checked against — "the model said so" is never final
 * evidence. Golden-tested with fixtures (tests/solver.test.ts).
 *
 * BOUNDED: only the shapes the demo needs (finite equiprobable spaces, simple
 * conditional probability, small combinatorics). If a problem is outside the
 * supported shape, return { supported: false } — NEVER guess.
 */

/** A structured probability problem the solver can evaluate deterministically. */
export interface ProbabilityProblem {
  /** Discriminated by `kind`; Codex defines the full union as fixtures grow. */
  kind: 'conditional' | 'combinatoric' | 'basic';
  /** Problem-specific parameters (documented per kind in the fixtures). */
  params: Record<string, number | string | boolean>;
}

export interface ExactFraction {
  numerator: number;
  denominator: number;
}

export interface SolverResult {
  supported: boolean;
  /** Exact rational answer when supported. */
  value?: ExactFraction;
  /** Decimal approximation for display/compare. */
  decimal?: number;
  /** Reproducible steps (sample space size, favorable count, etc.). */
  steps?: string[];
}

/** Reduce a fraction to lowest terms (helper Codex may reuse). */
export function reduceFraction(n: number, d: number): ExactFraction {
  const g = gcd(Math.abs(n), Math.abs(d)) || 1;
  const sign = d < 0 ? -1 : 1;
  return { numerator: (sign * n) / g, denominator: (sign * d) / g };
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Maximum number of equiprobable outcomes the bounded solver will enumerate. */
const MAX_SAMPLE_SPACE_SIZE = 1_000_000;

type DieEvent = 'at_least_one_six' | 'exactly_one_six' | 'both_six';

/**
 * Enumerate the supported finite, equiprobable sample spaces and count their
 * favorable outcomes. Conditional probabilities count the conditioning subset
 * and its intersection with the requested event. Inputs outside the documented
 * shapes, including oversized spaces, are rejected rather than approximated.
 * Reference: doc §5 (deterministic class), §7.2, gate §13.
 */
export function solveProbability(problem: ProbabilityProblem): SolverResult {
  if (problem.kind === 'basic' && problem.params.experiment === 'two_fair_dice') {
    const event = asDieEvent(problem.params.event);
    if (event === undefined) return unsupported();

    let favorable = 0;
    for (let first = 1; first <= 6; first += 1) {
      for (let second = 1; second <= 6; second += 1) {
        if (matchesDieEvent(event, first, second)) favorable += 1;
      }
    }

    return supportedResult(favorable, 36, [
      'Enumerated 36 ordered outcomes for two fair six-sided dice.',
      `Counted ${favorable} outcomes satisfying ${event}.`,
    ]);
  }

  if (problem.kind === 'basic' && problem.params.experiment === 'fair_coin_flips') {
    const flips = asNonNegativeInteger(problem.params.flips);
    const heads = asNonNegativeInteger(problem.params.k);
    if (
      problem.params.event !== 'exactly_k_heads' ||
      flips === undefined ||
      heads === undefined ||
      heads > flips
    ) {
      return unsupported();
    }

    const sampleSpaceSize = 2 ** flips;
    if (!isEnumerableSize(sampleSpaceSize)) return unsupported();

    let favorable = 0;
    for (let outcome = 0; outcome < sampleSpaceSize; outcome += 1) {
      let encodedFlips = outcome;
      let observedHeads = 0;
      for (let flip = 0; flip < flips; flip += 1) {
        observedHeads += encodedFlips % 2;
        encodedFlips = Math.floor(encodedFlips / 2);
      }
      if (observedHeads === heads) favorable += 1;
    }

    return supportedResult(favorable, sampleSpaceSize, [
      `Enumerated ${sampleSpaceSize} ordered sequences of ${flips} fair coin flips.`,
      `Counted ${favorable} sequences with exactly ${heads} heads.`,
    ]);
  }

  if (problem.kind === 'conditional' && problem.params.experiment === 'two_fair_dice') {
    if (
      problem.params.event !== 'both_six' ||
      problem.params.given !== 'at_least_one_six'
    ) {
      return unsupported();
    }

    let conditioned = 0;
    let favorable = 0;
    for (let first = 1; first <= 6; first += 1) {
      for (let second = 1; second <= 6; second += 1) {
        if (matchesDieEvent('at_least_one_six', first, second)) {
          conditioned += 1;
          if (matchesDieEvent('both_six', first, second)) favorable += 1;
        }
      }
    }

    if (conditioned === 0) return unsupported();
    return supportedResult(favorable, conditioned, [
      'Enumerated 36 ordered outcomes for two fair six-sided dice.',
      `Counted ${conditioned} outcomes satisfying the condition at_least_one_six.`,
      `Counted ${favorable} conditioned outcomes also satisfying both_six.`,
    ]);
  }

  if (problem.kind === 'combinatoric' && problem.params.experiment === 'urn_draws') {
    const favorableItems = asNonNegativeInteger(problem.params.favorable);
    const unfavorableItems = asNonNegativeInteger(problem.params.unfavorable);
    const draws = asNonNegativeInteger(problem.params.draws);
    const replacement = problem.params.replacement;
    if (
      problem.params.event !== 'all_favorable' ||
      favorableItems === undefined ||
      unfavorableItems === undefined ||
      draws === undefined ||
      typeof replacement !== 'boolean'
    ) {
      return unsupported();
    }

    const population = favorableItems + unfavorableItems;
    if (population === 0 || (!replacement && draws > population)) return unsupported();

    const sampleSpaceSize = orderedDrawCount(population, draws, replacement);
    if (sampleSpaceSize === undefined) return unsupported();

    let favorable = 0;
    const used = new Array<boolean>(population).fill(false);

    const enumerate = (depth: number, allFavorable: boolean): void => {
      if (depth === draws) {
        if (allFavorable) favorable += 1;
        return;
      }

      for (let item = 0; item < population; item += 1) {
        if (!replacement && used[item] === true) continue;
        if (!replacement) used[item] = true;
        enumerate(depth + 1, allFavorable && item < favorableItems);
        if (!replacement) used[item] = false;
      }
    };

    enumerate(0, true);
    return supportedResult(favorable, sampleSpaceSize, [
      `Enumerated ${sampleSpaceSize} ordered draw sequences from ${population} distinct items ${replacement ? 'with' : 'without'} replacement.`,
      `Counted ${favorable} sequences in which all ${draws} draws were favorable.`,
    ]);
  }

  return unsupported();
}

function unsupported(): SolverResult {
  return { supported: false };
}

function supportedResult(numerator: number, denominator: number, steps: string[]): SolverResult {
  const value = reduceFraction(numerator, denominator);
  return {
    supported: true,
    value,
    decimal: value.numerator / value.denominator,
    steps,
  };
}

function asNonNegativeInteger(value: number | string | boolean | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function asDieEvent(value: number | string | boolean | undefined): DieEvent | undefined {
  if (value === 'at_least_one_six' || value === 'exactly_one_six' || value === 'both_six') {
    return value;
  }
  return undefined;
}

function matchesDieEvent(event: DieEvent, first: number, second: number): boolean {
  const sixes = Number(first === 6) + Number(second === 6);
  if (event === 'at_least_one_six') return sixes >= 1;
  if (event === 'exactly_one_six') return sixes === 1;
  return sixes === 2;
}

function isEnumerableSize(size: number): boolean {
  return Number.isSafeInteger(size) && size > 0 && size <= MAX_SAMPLE_SPACE_SIZE;
}

function orderedDrawCount(
  population: number,
  draws: number,
  replacement: boolean,
): number | undefined {
  let count = 1;
  for (let draw = 0; draw < draws; draw += 1) {
    count *= replacement ? population : population - draw;
    if (!isEnumerableSize(count)) return undefined;
  }
  return isEnumerableSize(count) ? count : undefined;
}
