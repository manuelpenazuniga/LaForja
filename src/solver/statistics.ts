/**
 * LA FORJA — deterministic bounded statistics solver (doc §5, §7.2).
 *
 * OWNER: Codex. Reproducible descriptive statistics over a small explicit
 * dataset — the GROUND TRUTH the discipline reviewer is checked against, never
 * "the model said so". Golden-tested with fixtures (tests/statistics.test.ts).
 *
 * BOUNDED: only descriptive statistics over a finite explicit list of exact
 * rationals — mean, median, mode, range, population/sample variance and
 * standard deviation, quartiles and IQR. Everything else (percentiles other
 * than quartiles, weighted/grouped/frequency data, correlation, regression,
 * covariance, any inferential statistic) is OUT OF SCOPE and returns
 * { supported: false }. The solver REFUSES rather than crash and rather than
 * answer, in that order — every path is TOTAL and pure.
 *
 * All arithmetic is exact rational arithmetic over {numerator, denominator}
 * with a safe-integer guard on every intermediate product/sum. Roots are
 * returned exactly when the radicand is a perfect rational square, otherwise as
 * a decimal with a PUBLISHED absolute tolerance (a float round-off budget,
 * never a fuzzy-match).
 */
import type { ExactFraction, SolverResult, StatisticsProblem } from './types';
import { reduceFraction } from './probability';

export type { ExactFraction, SolverResult, StatisticsProblem } from './types';

/**
 * PUBLISHED BOUNDS (part of the spec; the solver REFUSES beyond them).
 * The dataset size bounds the number of terms folded; the magnitude bounds keep
 * every parsed value small enough that the exact-arithmetic guards below can
 * only ever refuse, never silently lose precision.
 */
export const MAX_DATASET_SIZE = 1000;
/** Maximum |numerator| of any single parsed value (after reduction). */
export const MAX_ABS_NUMERATOR = 1_000_000;
/** Maximum denominator of any single parsed value (after reduction). */
export const MAX_DENOMINATOR = 1_000_000;

type Fraction = ExactFraction;

/**
 * Compute the requested descriptive statistic exactly. Datasets arrive as a
 * canonical comma-separated string of integers or `p/q` rationals; they are
 * parsed strictly. Any out-of-scope kind, oversize dataset, degenerate shape
 * (e.g. sample statistics with n < 2, a non-unique mode), missing required
 * param, or arithmetic that would exceed Number.MAX_SAFE_INTEGER refuses with
 * { supported: false }. Reference: doc §5 (deterministic class), §7.2, gate §13.
 */
export function solveStatistics(problem: StatisticsProblem): SolverResult {
  const data = parseDataset(problem.params.data);
  if (data === undefined) return unsupported();

  const n = data.length; // parseDataset guarantees 1 <= n <= MAX_DATASET_SIZE.

  switch (problem.kind) {
    case 'mean': {
      const s = sumAll(data);
      if (s === undefined) return unsupported();
      const mean = fMul(s, { numerator: 1, denominator: n });
      if (mean === undefined) return unsupported();
      return exact(mean, [
        `Summed ${n} values to S = ${frac(s)}.`,
        `mean = S / n = ${frac(s)} / ${n} = ${frac(mean)}.`,
      ]);
    }

    case 'median': {
      const med = medianOf(sorted(data));
      if (med === undefined) return unsupported();
      return exact(med, [
        `Sorted ${n} values.`,
        `median = ${frac(med)}.`,
      ]);
    }

    case 'mode': {
      const mode = uniqueMode(data);
      if (mode === undefined) return unsupported();
      return exact(mode, [
        `Counted value frequencies over ${n} values.`,
        `Unique strict-maximum-frequency value: mode = ${frac(mode)}.`,
      ]);
    }

    case 'range': {
      const ordered = sorted(data);
      const min = ordered[0];
      const max = ordered[n - 1];
      if (min === undefined || max === undefined) return unsupported();
      const range = fSub(max, min);
      if (range === undefined) return unsupported();
      return exact(range, [
        `Sorted ${n} values; min = ${frac(min)}, max = ${frac(max)}.`,
        `range = max - min = ${frac(range)}.`,
      ]);
    }

    case 'pop_variance': {
      const v = populationVariance(data);
      if (v === undefined) return unsupported();
      return exact(v.value, v.steps);
    }

    case 'sample_variance': {
      const v = sampleVariance(data);
      if (v === undefined) return unsupported();
      return exact(v.value, v.steps);
    }

    case 'pop_stddev': {
      const v = populationVariance(data);
      if (v === undefined) return unsupported();
      return sqrtResult(v.value, [...v.steps, 'pop_stddev = sqrt(pop_variance).']);
    }

    case 'sample_stddev': {
      const v = sampleVariance(data);
      if (v === undefined) return unsupported();
      return sqrtResult(v.value, [...v.steps, 'sample_stddev = sqrt(sample_variance).']);
    }

    case 'quartiles':
    case 'iqr': {
      const method = asMethod(problem.params.method);
      if (method === undefined) return unsupported();
      const q = quartiles(data, method);
      if (q === undefined) return unsupported();
      if (problem.kind === 'iqr') {
        return exact(q.iqr, [
          `Method: ${method}. Q1 = ${frac(q.q1)}, Q3 = ${frac(q.q3)}.`,
          `IQR = Q3 - Q1 = ${frac(q.iqr)}.`,
        ]);
      }
      return exact(q.iqr, [
        `Method: ${method}.`,
        `Q1 = ${frac(q.q1)}.`,
        `Q2 (median) = ${frac(q.q2)}.`,
        `Q3 = ${frac(q.q3)}.`,
        `IQR = Q3 - Q1 = ${frac(q.iqr)}.`,
      ]);
    }

    default:
      return unsupported();
  }
}

// ---------------------------------------------------------------------------
// Statistic builders (exact fraction throughout).
// ---------------------------------------------------------------------------

interface VarianceResult {
  value: Fraction;
  steps: string[];
}

/** pop_variance = (n*Q - S^2) / n^2, n >= 1. */
function populationVariance(data: Fraction[]): VarianceResult | undefined {
  const n = data.length;
  if (n < 1) return undefined;
  const numer = varianceNumerator(data);
  if (numer === undefined) return undefined;
  const n2 = safeProduct(n, n);
  if (n2 === undefined) return undefined;
  const value = fMul(numer, { numerator: 1, denominator: n2 });
  if (value === undefined) return undefined;
  return {
    value,
    steps: [
      `n = ${n}, S = ${frac(numer.__s)}, Q = ${frac(numer.__q)}.`,
      `pop_variance = (n*Q - S^2) / n^2 = ${frac(value)}.`,
    ],
  };
}

/** sample_variance = (n*Q - S^2) / (n*(n-1)), n >= 2. */
function sampleVariance(data: Fraction[]): VarianceResult | undefined {
  const n = data.length;
  if (n < 2) return undefined;
  const numer = varianceNumerator(data);
  if (numer === undefined) return undefined;
  const denom = safeProduct(n, n - 1);
  if (denom === undefined) return undefined;
  const value = fMul(numer, { numerator: 1, denominator: denom });
  if (value === undefined) return undefined;
  return {
    value,
    steps: [
      `n = ${n}, S = ${frac(numer.__s)}, Q = ${frac(numer.__q)}.`,
      `sample_variance = (n*Q - S^2) / (n*(n-1)) = ${frac(value)}.`,
    ],
  };
}

/**
 * Shared numerator (n*Q - S^2) for both variances, carrying S and Q along for
 * the step trace. Returns undefined on any exact-arithmetic overflow.
 */
function varianceNumerator(data: Fraction[]): (Fraction & { __s: Fraction; __q: Fraction }) | undefined {
  const n = data.length;
  const s = sumAll(data);
  const q = sumSquares(data);
  if (s === undefined || q === undefined) return undefined;
  const nQ = fMul({ numerator: n, denominator: 1 }, q);
  const s2 = fMul(s, s);
  if (nQ === undefined || s2 === undefined) return undefined;
  const numer = fSub(nQ, s2);
  if (numer === undefined) return undefined;
  return { ...numer, __s: s, __q: q };
}

interface Quartiles {
  q1: Fraction;
  q2: Fraction;
  q3: Fraction;
  iqr: Fraction;
}

/**
 * Q2 is the median of all data. For ODD n the exclusive method drops the median
 * element from both halves; the inclusive method keeps it in both. For EVEN n
 * the two methods coincide. Q1/Q3 are the medians of the lower/upper halves.
 * A half that comes out empty (e.g. n = 1 exclusive) refuses rather than crash.
 */
function quartiles(data: Fraction[], method: 'exclusive' | 'inclusive'): Quartiles | undefined {
  const ordered = sorted(data);
  const n = ordered.length;
  const q2 = medianOf(ordered);
  if (q2 === undefined) return undefined;

  let lower: Fraction[];
  let upper: Fraction[];
  if (n % 2 === 0) {
    const half = n / 2;
    lower = ordered.slice(0, half);
    upper = ordered.slice(half);
  } else {
    const mid = (n - 1) / 2;
    if (method === 'exclusive') {
      lower = ordered.slice(0, mid);
      upper = ordered.slice(mid + 1);
    } else {
      lower = ordered.slice(0, mid + 1);
      upper = ordered.slice(mid);
    }
  }

  const q1 = medianOf(lower);
  const q3 = medianOf(upper);
  if (q1 === undefined || q3 === undefined) return undefined;
  const iqr = fSub(q3, q1);
  if (iqr === undefined) return undefined;
  return { q1, q2, q3, iqr };
}

/** Median of an already-sorted list; undefined for an empty list or on overflow. */
function medianOf(ordered: Fraction[]): Fraction | undefined {
  const n = ordered.length;
  if (n < 1) return undefined;
  if (n % 2 === 1) {
    return ordered[(n - 1) / 2];
  }
  const a = ordered[n / 2 - 1];
  const b = ordered[n / 2];
  if (a === undefined || b === undefined) return undefined;
  const s = fAdd(a, b);
  if (s === undefined) return undefined;
  return fMul(s, { numerator: 1, denominator: 2 });
}

/** The unique strict-maximum-frequency value, or undefined if it is not unique. */
function uniqueMode(data: Fraction[]): Fraction | undefined {
  const counts: { value: Fraction; count: number }[] = [];
  for (const x of data) {
    const hit = counts.find((c) => c.value.numerator === x.numerator && c.value.denominator === x.denominator);
    if (hit) hit.count += 1;
    else counts.push({ value: x, count: 1 });
  }
  let best: { value: Fraction; count: number } | undefined;
  let tie = false;
  for (const c of counts) {
    if (best === undefined || c.count > best.count) {
      best = c;
      tie = false;
    } else if (c.count === best.count) {
      tie = true;
    }
  }
  if (best === undefined || tie) return undefined;
  return best.value;
}

/** Sum of all values, exact; undefined on overflow. */
function sumAll(data: Fraction[]): Fraction | undefined {
  let acc: Fraction = { numerator: 0, denominator: 1 };
  for (const x of data) {
    const next = fAdd(acc, x);
    if (next === undefined) return undefined;
    acc = next;
  }
  return acc;
}

/** Sum of squares, exact; undefined on overflow. */
function sumSquares(data: Fraction[]): Fraction | undefined {
  let acc: Fraction = { numerator: 0, denominator: 1 };
  for (const x of data) {
    const sq = fMul(x, x);
    if (sq === undefined) return undefined;
    const next = fAdd(acc, sq);
    if (next === undefined) return undefined;
    acc = next;
  }
  return acc;
}

// ---------------------------------------------------------------------------
// sqrt of a rational: exact when a perfect rational square, else decimal + tol.
// ---------------------------------------------------------------------------

function sqrtResult(v: Fraction, steps: string[]): SolverResult {
  // A variance is mathematically non-negative; a negative radicand means the
  // computation is wrong, so refuse rather than publish an imaginary root.
  if (v.numerator < 0) return unsupported();

  const rootN = perfectSqrt(v.numerator);
  const rootD = perfectSqrt(v.denominator);
  if (rootN !== undefined && rootD !== undefined) {
    const value = reduceFraction(rootN, rootD);
    return exact(value, [...steps, `Radicand ${frac(v)} is a perfect rational square: value = ${frac(value)}.`]);
  }

  const decimal = Math.sqrt(v.numerator / v.denominator);
  if (!Number.isFinite(decimal)) return unsupported();
  const tolerance = Math.max(1e-6 * Math.abs(decimal), 1e-9);
  return {
    supported: true,
    decimal,
    tolerance,
    steps: [...steps, `Radicand ${frac(v)} is not a perfect rational square: decimal ${decimal} (±${tolerance}).`],
  };
}

/** Integer square root of a non-negative safe integer, or undefined if not a perfect square. */
function perfectSqrt(k: number): number | undefined {
  if (!Number.isSafeInteger(k) || k < 0) return undefined;
  const r = Math.round(Math.sqrt(k));
  for (const candidate of [r - 1, r, r + 1]) {
    if (candidate >= 0 && candidate * candidate === k) return candidate;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Exact rational arithmetic — private, safe-integer guarded on every product.
// ---------------------------------------------------------------------------

function fAdd(a: Fraction, b: Fraction): Fraction | undefined {
  const n1 = safeProduct(a.numerator, b.denominator);
  const n2 = safeProduct(b.numerator, a.denominator);
  const d = safeProduct(a.denominator, b.denominator);
  if (n1 === undefined || n2 === undefined || d === undefined) return undefined;
  const num = safeSum(n1, n2);
  if (num === undefined) return undefined;
  return reduceFraction(num, d);
}

function fSub(a: Fraction, b: Fraction): Fraction | undefined {
  return fAdd(a, { numerator: -b.numerator, denominator: b.denominator });
}

function fMul(a: Fraction, b: Fraction): Fraction | undefined {
  const num = safeProduct(a.numerator, b.numerator);
  const den = safeProduct(a.denominator, b.denominator);
  if (num === undefined || den === undefined) return undefined;
  return reduceFraction(num, den);
}

/** Sign of a - b: -1, 0 or +1; undefined on overflow. Denominators are positive. */
function fCompare(a: Fraction, b: Fraction): number | undefined {
  const left = safeProduct(a.numerator, b.denominator);
  const right = safeProduct(b.numerator, a.denominator);
  if (left === undefined || right === undefined) return undefined;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function safeProduct(a: number, b: number): number | undefined {
  const p = a * b;
  return Number.isSafeInteger(p) ? p : undefined;
}

function safeSum(a: number, b: number): number | undefined {
  const s = a + b;
  return Number.isSafeInteger(s) ? s : undefined;
}

/** Stable ascending sort of a copy. Raw parsed values stay within the safe range. */
function sorted(data: Fraction[]): Fraction[] {
  return [...data].sort((a, b) => fCompare(a, b) ?? 0);
}

// ---------------------------------------------------------------------------
// Parsing — canonical strings only, strict.
// ---------------------------------------------------------------------------

const INTEGER_RE = /^[+-]?\d+$/;
const FRACTION_RE = /^([+-]?\d+)\/([+-]?\d+)$/;

/**
 * Parse "a, b/c, -d, …" into reduced fractions. Rejects (undefined) an empty
 * dataset, an oversize dataset, an empty/non-rational token, a zero
 * denominator, or any value outside the published magnitude bounds.
 */
function parseDataset(raw: number | string | boolean | undefined): Fraction[] | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  const tokens = trimmed.split(',');
  if (tokens.length > MAX_DATASET_SIZE) return undefined;

  const values: Fraction[] = [];
  for (const token of tokens) {
    const parsed = parseRational(token.trim());
    if (parsed === undefined) return undefined;
    values.push(parsed);
  }
  return values.length >= 1 ? values : undefined;
}

function parseRational(token: string): Fraction | undefined {
  if (token.length === 0) return undefined;

  let numerator: number;
  let denominator: number;
  if (INTEGER_RE.test(token)) {
    numerator = Number(token);
    denominator = 1;
  } else {
    const match = FRACTION_RE.exec(token);
    if (match === null) return undefined;
    numerator = Number(match[1]);
    denominator = Number(match[2]);
  }

  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) return undefined;
  if (denominator === 0) return undefined;

  const reduced = reduceFraction(numerator, denominator);
  if (Math.abs(reduced.numerator) > MAX_ABS_NUMERATOR) return undefined;
  if (reduced.denominator < 1 || reduced.denominator > MAX_DENOMINATOR) return undefined;
  return reduced;
}

function asMethod(value: number | string | boolean | undefined): 'exclusive' | 'inclusive' | undefined {
  return value === 'exclusive' || value === 'inclusive' ? value : undefined;
}

// ---------------------------------------------------------------------------
// Result helpers.
// ---------------------------------------------------------------------------

function unsupported(): SolverResult {
  return { supported: false };
}

function exact(value: Fraction, steps: string[]): SolverResult {
  return {
    supported: true,
    value,
    decimal: value.numerator / value.denominator,
    steps,
  };
}

function frac(f: Fraction): string {
  return f.denominator === 1 ? `${f.numerator}` : `${f.numerator}/${f.denominator}`;
}
