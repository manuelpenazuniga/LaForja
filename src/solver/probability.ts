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

/**
 * TODO(codex): implement the bounded solver.
 *  - Enumerate the finite sample space for the supported `kind`s and count
 *    favorable outcomes; return an EXACT fraction + decimal + steps.
 *  - conditional: P(A|B) = |A ∩ B| / |B| over the enumerated space.
 *  - Must be pure and deterministic (same input ⇒ same output) for golden tests.
 *  - Unsupported shape ⇒ { supported: false } (the reviewer then returns
 *    'unverified', never 'correct').
 * Reference: doc §5 (deterministic class), §7.2, gate §13.
 */
export function solveProbability(_problem: ProbabilityProblem): SolverResult {
  throw new Error('TODO(codex): implement bounded probability solver');
}
