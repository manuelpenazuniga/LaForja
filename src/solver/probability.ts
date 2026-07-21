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
 * supported shape, return { supported: false } — NEVER guess. "Outside the
 * supported shape" includes inputs that are merely too large: see the published
 * bounds below (MAX_SAMPLE_SPACE_SIZE, MAX_DRAWS, MAX_FLIPS). The solver must
 * REFUSE rather than crash and rather than answer, in that order of preference.
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

/**
 * Iterative on purpose: the Euclidean algorithm was written recursively, which
 * made its stack depth a function of its (unvalidated, exported) inputs. The
 * loop is exactly equivalent for integers and cannot overflow.
 */
function gcd(a: number, b: number): number {
  // Non-integer or non-finite input has no gcd. The recursive version spun on it
  // (1 % 0.3 never reaches 0 cleanly, NaN % NaN is NaN); refuse to reduce
  // instead of looping, so reduceFraction stays total.
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return 1;

  let left = a;
  let right = b;
  while (right !== 0) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left;
}

/**
 * PUBLISHED BOUNDS (part of the spec; the solver REFUSES beyond them).
 *
 * Two independent limits are required, because they bound different things:
 *  - MAX_SAMPLE_SPACE_SIZE bounds the WIDTH of an enumeration (how many
 *    outcomes are visited);
 *  - MAX_DRAWS / MAX_FLIPS bound the DEPTH of one (how deep the enumeration
 *    recurses or iterates per outcome).
 *
 * The size bound alone is not sufficient. With population = 1 and replacement,
 * the ordered-draw count stays 1 for ANY number of draws, so the size check
 * passes while the enumeration still recurses `draws` frames deep — draws =
 * 50000 overflows the stack and takes down the ground truth the whole eval
 * depends on. Depth is therefore bounded explicitly and up front.
 */

/** Maximum number of equiprobable outcomes the bounded solver will enumerate. */
export const MAX_SAMPLE_SPACE_SIZE = 1_000_000;

/**
 * Maximum sequential draws the urn enumerator will recurse through. Any real
 * item stays far below this: with a population of 2 the sample space already
 * exceeds MAX_SAMPLE_SPACE_SIZE at 20 draws. The bound exists to make the
 * DEGENERATE cases (population 1 with replacement) refuse instead of crash.
 */
export const MAX_DRAWS = 32;

/**
 * Maximum coin flips enumerated per sequence. 2^20 already exceeds
 * MAX_SAMPLE_SPACE_SIZE, so this is a redundant guard kept explicit so the
 * per-outcome inner loop can never be driven by an unbounded parameter.
 */
export const MAX_FLIPS = 32;

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

    // Depth bound. `flips` drives the per-outcome inner loop, and flips = 0 is a
    // degenerate shape whose "probability" is vacuously 1 — refuse both rather
    // than report a number nobody asked for.
    if (flips < 1 || flips > MAX_FLIPS) return unsupported();

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

    // DEPTH bound, checked BEFORE any counting. enumerate() recurses `draws`
    // frames deep and orderedDrawCount() iterates `draws` times, and neither is
    // constrained by the sample-space SIZE check below: with population = 1 and
    // replacement the count stays 1 however many draws are requested. draws = 0
    // is also rejected — it is a degenerate shape that would report a vacuous
    // 1/1 and, worse, would reach `new Array(population)` with a population the
    // size check never got to bound.
    if (draws < 1 || draws > MAX_DRAWS) return unsupported();

    const population = favorableItems + unfavorableItems;
    if (population === 0 || (!replacement && draws > population)) return unsupported();

    // orderedDrawCount also bounds `population` itself, so by the time it
    // returns a size the `used` allocation below cannot be driven by an
    // unbounded parameter.
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
  // A probability outside [0, 1], or over an empty space, means the enumeration
  // above is wrong. Refusing beats publishing a confidently wrong ground truth.
  if (
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    denominator <= 0 ||
    numerator < 0 ||
    numerator > denominator
  ) {
    return unsupported();
  }

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
  // The loop runs `draws` times and, with population = 1 and replacement, never
  // trips the size check — so the helper carries the depth bound itself rather
  // than trusting every caller to have checked it.
  if (!Number.isSafeInteger(draws) || draws < 1 || draws > MAX_DRAWS) return undefined;
  if (!isEnumerableSize(population)) return undefined;

  let count = 1;
  for (let draw = 0; draw < draws; draw += 1) {
    count *= replacement ? population : population - draw;
    if (!isEnumerableSize(count)) return undefined;
  }
  return isEnumerableSize(count) ? count : undefined;
}
