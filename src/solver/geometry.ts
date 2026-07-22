/**
 * LA FORJA — deterministic bounded geometry solver (doc §5, §7.2).
 *
 * OWNER: Codex. Reproducible computation of item answers for elementary plane
 * geometry (lengths, areas, perimeters, angle sums, coordinate distance). Like
 * probability.ts this is GROUND TRUTH the discipline reviewer is checked
 * against — "the model said so" is never final evidence. Golden-tested with
 * fixtures (tests/geometry.test.ts).
 *
 * BOUNDED and TOTAL: only the shapes below are supported. Anything else — an
 * out-of-scope kind, a missing/non-numeric/degenerate parameter, or a value
 * beyond the published magnitude bounds — returns { supported: false }. The
 * solver REFUSES rather than crash, and REFUSES rather than answer, in that
 * order. It NEVER throws.
 *
 * EXACT vs DECIMAL. A perfectly rational answer (including a perfect-square
 * root) is returned as an exact `value` (ExactFraction, lowest terms) with its
 * `decimal` and NO tolerance. An irrational answer (a non-perfect-square root,
 * or any π-based answer) is returned as `decimal` + an ABSOLUTE `tolerance`
 * and NO `value`. The tolerance is derived deterministically from the params
 * (`round_places` when supplied), never guessed.
 */
export type { ExactFraction, SolverResult, GeometryProblem } from './types';
import type { ExactFraction, SolverResult, GeometryProblem, SolverParams } from './types';
import { reduceFraction } from './probability';

/** π at full IEEE-754 precision. */
const PI = Math.PI;

/**
 * PUBLISHED MAGNITUDE BOUNDS (part of the spec; the solver REFUSES beyond
 * them). Lengths/coordinates keep exact products inside the safe-integer range;
 * the polygon bound keeps `(n-2)*180` a safe integer.
 */
export const MAX_LENGTH = 1_000_000;
export const MAX_COORDINATE = 1_000_000;
export const MAX_POLYGON_SIDES = 1_000_000;

/** Reusable exact constants. */
const HALF: ExactFraction = { numerator: 1, denominator: 2 };
const TWO: ExactFraction = { numerator: 2, denominator: 1 };

export function solveGeometry(problem: GeometryProblem): SolverResult {
  const params = problem.params;

  // round_places (optional) is validated once, up front. If present it must be a
  // non-negative safe integer; a malformed value makes the whole call refuse so
  // the derived tolerance can never be non-deterministic.
  const roundPlaces = readRoundPlaces(params);
  if (roundPlaces === INVALID) return unsupported();

  switch (problem.kind) {
    case 'pythagoras':
      return solvePythagoras(params, roundPlaces);
    case 'area_rectangle':
      return solveAreaRectangle(params);
    case 'perimeter_rectangle':
      return solvePerimeterRectangle(params);
    case 'area_triangle':
      return solveAreaTriangle(params, roundPlaces);
    case 'perimeter_triangle':
      return solvePerimeterTriangle(params);
    case 'area_circle':
      return solveAreaCircle(params, roundPlaces);
    case 'circumference':
      return solveCircumference(params, roundPlaces);
    case 'polygon_angle_sum':
      return solvePolygonAngleSum(params);
    case 'missing_angle':
      return solveMissingAngle(params);
    case 'distance':
      return solveDistance(params, roundPlaces);
    default:
      return unsupported();
  }
}

// ─── kinds ──────────────────────────────────────────────────────────────────

function solvePythagoras(params: SolverParams, roundPlaces: RoundPlaces): SolverResult {
  const hasA = params.legA !== undefined;
  const hasB = params.legB !== undefined;
  const hasH = params.hyp !== undefined;
  if (Number(hasA) + Number(hasB) + Number(hasH) !== 2) return unsupported();

  if (hasA && hasB) {
    const a = getLength(params, 'legA');
    const b = getLength(params, 'legB');
    if (a === undefined || b === undefined) return unsupported();
    const a2 = square(a);
    const b2 = square(b);
    if (a2 === undefined || b2 === undefined) return unsupported();
    const radicand = fracAdd(a2, b2);
    if (radicand === undefined) return unsupported();
    return sqrtResult(radicand, roundPlaces, [
      'Right triangle: hypotenuse = sqrt(legA^2 + legB^2).',
      `Computed legA^2 + legB^2 = ${fracStr(radicand)}.`,
    ]);
  }

  // One leg + hypotenuse: leg = sqrt(hyp^2 - leg^2), which requires hyp > leg.
  const h = getLength(params, 'hyp');
  const legKey = hasA ? 'legA' : 'legB';
  const leg = getLength(params, legKey);
  if (h === undefined || leg === undefined) return unsupported();
  const h2 = square(h);
  const leg2 = square(leg);
  if (h2 === undefined || leg2 === undefined) return unsupported();
  const radicand = fracSub(h2, leg2);
  if (radicand === undefined || radicand.numerator <= 0) return unsupported();
  return sqrtResult(radicand, roundPlaces, [
    `Right triangle: missing leg = sqrt(hyp^2 - ${legKey}^2).`,
    `Computed hyp^2 - ${legKey}^2 = ${fracStr(radicand)}.`,
  ]);
}

function solveAreaRectangle(params: SolverParams): SolverResult {
  const l = getLength(params, 'length');
  const w = getLength(params, 'width');
  if (l === undefined || w === undefined) return unsupported();
  const area = fracMul(l, w);
  if (area === undefined) return unsupported();
  return exactResult(area, [
    'Rectangle area = length * width.',
    `Computed ${fracStr(l)} * ${fracStr(w)} = ${fracStr(area)}.`,
  ]);
}

function solvePerimeterRectangle(params: SolverParams): SolverResult {
  const l = getLength(params, 'length');
  const w = getLength(params, 'width');
  if (l === undefined || w === undefined) return unsupported();
  const sum = fracAdd(l, w);
  if (sum === undefined) return unsupported();
  const perimeter = fracMul(TWO, sum);
  if (perimeter === undefined) return unsupported();
  return exactResult(perimeter, [
    'Rectangle perimeter = 2 * (length + width).',
    `Computed 2 * (${fracStr(l)} + ${fracStr(w)}) = ${fracStr(perimeter)}.`,
  ]);
}

function solveAreaTriangle(params: SolverParams, roundPlaces: RoundPlaces): SolverResult {
  if (params.base !== undefined && params.height !== undefined) {
    const base = getLength(params, 'base');
    const height = getLength(params, 'height');
    if (base === undefined || height === undefined) return unsupported();
    const bh = fracMul(base, height);
    if (bh === undefined) return unsupported();
    const area = fracMul(HALF, bh);
    if (area === undefined) return unsupported();
    return exactResult(area, [
      'Triangle area = 0.5 * base * height.',
      `Computed 0.5 * ${fracStr(base)} * ${fracStr(height)} = ${fracStr(area)}.`,
    ]);
  }

  if (params.a !== undefined && params.b !== undefined && params.c !== undefined) {
    const a = getLength(params, 'a');
    const b = getLength(params, 'b');
    const c = getLength(params, 'c');
    if (a === undefined || b === undefined || c === undefined) return unsupported();
    if (!triangleInequalityHolds(a, b, c)) return unsupported();

    // Heron: s = (a+b+c)/2; area = sqrt(s(s-a)(s-b)(s-c)). Each fracMul reduces,
    // keeping intermediates small; oversize triangles overflow the safe-integer
    // guard and refuse rather than crash.
    const ab = fracAdd(a, b);
    if (ab === undefined) return unsupported();
    const perimeter = fracAdd(ab, c);
    if (perimeter === undefined) return unsupported();
    const s = fracMul(HALF, perimeter);
    if (s === undefined) return unsupported();
    const sa = fracSub(s, a);
    const sb = fracSub(s, b);
    const sc = fracSub(s, c);
    if (sa === undefined || sb === undefined || sc === undefined) return unsupported();
    const p1 = fracMul(s, sa);
    if (p1 === undefined) return unsupported();
    const p2 = fracMul(p1, sb);
    if (p2 === undefined) return unsupported();
    const radicand = fracMul(p2, sc);
    if (radicand === undefined || radicand.numerator <= 0) return unsupported();
    return sqrtResult(radicand, roundPlaces, [
      "Heron's formula: area = sqrt(s(s-a)(s-b)(s-c)), s = (a+b+c)/2.",
      `Computed s = ${fracStr(s)}, radicand = ${fracStr(radicand)}.`,
    ]);
  }

  return unsupported();
}

function solvePerimeterTriangle(params: SolverParams): SolverResult {
  const a = getLength(params, 'a');
  const b = getLength(params, 'b');
  const c = getLength(params, 'c');
  if (a === undefined || b === undefined || c === undefined) return unsupported();
  const ab = fracAdd(a, b);
  if (ab === undefined) return unsupported();
  const perimeter = fracAdd(ab, c);
  if (perimeter === undefined) return unsupported();
  return exactResult(perimeter, [
    'Triangle perimeter = a + b + c.',
    `Computed ${fracStr(a)} + ${fracStr(b)} + ${fracStr(c)} = ${fracStr(perimeter)}.`,
  ]);
}

function solveAreaCircle(params: SolverParams, roundPlaces: RoundPlaces): SolverResult {
  const r = radiusFrom(params);
  if (r === undefined) return unsupported();
  const rSquared = square(r);
  if (rSquared === undefined) return unsupported();
  const decimal = PI * (rSquared.numerator / rSquared.denominator);
  return decimalResult(decimal, toleranceFor(decimal, roundPlaces), [
    'Circle area = π * r^2.',
    `Computed r = ${fracStr(r)}, π * r^2 = ${decimal}.`,
  ]);
}

function solveCircumference(params: SolverParams, roundPlaces: RoundPlaces): SolverResult {
  const r = radiusFrom(params);
  if (r === undefined) return unsupported();
  const decimal = 2 * PI * (r.numerator / r.denominator);
  return decimalResult(decimal, toleranceFor(decimal, roundPlaces), [
    'Circle circumference = 2 * π * r.',
    `Computed r = ${fracStr(r)}, 2 * π * r = ${decimal}.`,
  ]);
}

function solvePolygonAngleSum(params: SolverParams): SolverResult {
  const n = getInteger(params, 'n', 3, MAX_POLYGON_SIDES);
  if (n === undefined) return unsupported();
  const degrees = (n - 2) * 180;
  if (!Number.isSafeInteger(degrees)) return unsupported();
  return exactResult(reduceFraction(degrees, 1), [
    'Sum of interior angles of a convex n-gon = (n - 2) * 180 degrees.',
    `Computed (${n} - 2) * 180 = ${degrees} degrees.`,
  ]);
}

function solveMissingAngle(params: SolverParams): SolverResult {
  if (params.n !== undefined) {
    const n = getInteger(params, 'n', 3, MAX_POLYGON_SIDES);
    const sumKnown = getPositive(params, 'sum_known');
    if (n === undefined || sumKnown === undefined) return unsupported();
    const totalDeg = (n - 2) * 180;
    if (!Number.isSafeInteger(totalDeg)) return unsupported();
    const total = reduceFraction(totalDeg, 1);
    const missing = fracSub(total, sumKnown);
    // Refuse a non-positive remainder, or one >= the total (sum_known <= 0 — the
    // getPositive guard already excludes 0, this is belt-and-braces).
    if (missing === undefined || missing.numerator <= 0) return unsupported();
    if (compareFrac(missing, total) >= 0) return unsupported();
    return exactResult(missing, [
      'Missing polygon angle = (n - 2) * 180 - sum_known.',
      `Computed ${totalDeg} - ${fracStr(sumKnown)} = ${fracStr(missing)} degrees.`,
    ]);
  }

  if (params.a !== undefined && params.b !== undefined) {
    const a = getPositive(params, 'a');
    const b = getPositive(params, 'b');
    if (a === undefined || b === undefined) return unsupported();
    const total = reduceFraction(180, 1);
    const ab = fracAdd(a, b);
    if (ab === undefined) return unsupported();
    const missing = fracSub(total, ab);
    if (missing === undefined || missing.numerator <= 0) return unsupported();
    return exactResult(missing, [
      'Third triangle angle = 180 - a - b degrees.',
      `Computed 180 - ${fracStr(a)} - ${fracStr(b)} = ${fracStr(missing)} degrees.`,
    ]);
  }

  return unsupported();
}

function solveDistance(params: SolverParams, roundPlaces: RoundPlaces): SolverResult {
  const x1 = getCoordinate(params, 'x1');
  const y1 = getCoordinate(params, 'y1');
  const x2 = getCoordinate(params, 'x2');
  const y2 = getCoordinate(params, 'y2');
  if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
    return unsupported();
  }
  const dx = fracSub(x2, x1);
  const dy = fracSub(y2, y1);
  if (dx === undefined || dy === undefined) return unsupported();
  const dx2 = square(dx);
  const dy2 = square(dy);
  if (dx2 === undefined || dy2 === undefined) return unsupported();
  const radicand = fracAdd(dx2, dy2);
  if (radicand === undefined || radicand.numerator < 0) return unsupported();
  return sqrtResult(radicand, roundPlaces, [
    'Distance = sqrt((x2 - x1)^2 + (y2 - y1)^2).',
    `Computed (dx)^2 + (dy)^2 = ${fracStr(radicand)}.`,
  ]);
}

// ─── result builders ─────────────────────────────────────────────────────────

function unsupported(): SolverResult {
  return { supported: false };
}

/** Exact rational answer: value + decimal + steps, and NEVER a tolerance. */
function exactResult(value: ExactFraction, steps: string[]): SolverResult {
  return {
    supported: true,
    value,
    decimal: value.numerator / value.denominator,
    steps,
  };
}

/** Irrational answer: decimal + absolute tolerance + steps, and NEVER a value. */
function decimalResult(decimal: number, tolerance: number, steps: string[]): SolverResult {
  if (!Number.isFinite(decimal) || !Number.isFinite(tolerance)) return unsupported();
  return { supported: true, decimal, tolerance, steps };
}

/**
 * Resolve a non-negative rational radicand. If both numerator and denominator
 * are perfect squares the root is rational — return it exactly (no tolerance).
 * Otherwise the root is irrational — return decimal + derived tolerance.
 */
function sqrtResult(radicand: ExactFraction, roundPlaces: RoundPlaces, steps: string[]): SolverResult {
  if (radicand.numerator < 0) return unsupported();
  const exact = fracSqrtExact(radicand);
  if (exact !== undefined) {
    return exactResult(exact, [...steps, `Radicand is a perfect square: root = ${fracStr(exact)}.`]);
  }
  const decimal = Math.sqrt(radicand.numerator / radicand.denominator);
  return decimalResult(decimal, toleranceFor(decimal, roundPlaces), [
    ...steps,
    `Radicand is not a perfect square: root ≈ ${decimal}.`,
  ]);
}

/**
 * Absolute tolerance for a decimal-mode answer, fully determined by the params.
 * With an explicit round_places it is half a unit in the last reported place;
 * otherwise a relative-magnitude default that still floors at 1e-9.
 */
function toleranceFor(decimal: number, roundPlaces: RoundPlaces): number {
  if (roundPlaces !== undefined) return 0.5 * 10 ** -roundPlaces;
  return Math.max(1e-6 * Math.abs(decimal), 1e-9);
}

// ─── parameter reading ───────────────────────────────────────────────────────

/** A length: finite number, strictly positive, within MAX_LENGTH. */
function getLength(params: SolverParams, key: string): ExactFraction | undefined {
  const v = params[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > MAX_LENGTH) return undefined;
  return toFraction(v);
}

/** A positive quantity (angle / known-angle sum): finite, strictly positive. */
function getPositive(params: SolverParams, key: string): ExactFraction | undefined {
  const v = params[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > MAX_LENGTH * 360) {
    return undefined;
  }
  return toFraction(v);
}

/** A coordinate: any finite number within ±MAX_COORDINATE (zero/negatives ok). */
function getCoordinate(params: SolverParams, key: string): ExactFraction | undefined {
  const v = params[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > MAX_COORDINATE) {
    return undefined;
  }
  return toFraction(v);
}

/** An integer count within [min, max]. */
function getInteger(
  params: SolverParams,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const v = params[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) return undefined;
  return v;
}

/** Radius directly, or half the diameter — exactly one of the two is required. */
function radiusFrom(params: SolverParams): ExactFraction | undefined {
  const hasR = params.radius !== undefined;
  const hasD = params.diameter !== undefined;
  if (hasR === hasD) return undefined; // need exactly one, never both, never neither
  if (hasR) return getLength(params, 'radius');
  const d = getLength(params, 'diameter');
  if (d === undefined) return undefined;
  return fracMul(d, HALF);
}

type RoundPlaces = number | undefined;
const INVALID = -1 as const;

/** undefined = absent (use default tolerance); number = places; INVALID = refuse. */
function readRoundPlaces(params: SolverParams): RoundPlaces | typeof INVALID {
  const v = params.round_places;
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > 100) return INVALID;
  return v;
}

// ─── exact rational arithmetic (safe-integer guarded on every intermediate) ───

function safeMul(a: number, b: number): number | undefined {
  const r = a * b;
  return Number.isSafeInteger(r) ? r : undefined;
}

function safeAdd(a: number, b: number): number | undefined {
  const r = a + b;
  return Number.isSafeInteger(r) ? r : undefined;
}

function fracMul(a: ExactFraction, b: ExactFraction): ExactFraction | undefined {
  const n = safeMul(a.numerator, b.numerator);
  const d = safeMul(a.denominator, b.denominator);
  if (n === undefined || d === undefined) return undefined;
  return reduceFraction(n, d);
}

function fracAdd(a: ExactFraction, b: ExactFraction): ExactFraction | undefined {
  const an = safeMul(a.numerator, b.denominator);
  const bn = safeMul(b.numerator, a.denominator);
  const d = safeMul(a.denominator, b.denominator);
  if (an === undefined || bn === undefined || d === undefined) return undefined;
  const n = safeAdd(an, bn);
  if (n === undefined) return undefined;
  return reduceFraction(n, d);
}

function fracSub(a: ExactFraction, b: ExactFraction): ExactFraction | undefined {
  const an = safeMul(a.numerator, b.denominator);
  const bn = safeMul(b.numerator, a.denominator);
  const d = safeMul(a.denominator, b.denominator);
  if (an === undefined || bn === undefined || d === undefined) return undefined;
  const n = safeAdd(an, -bn);
  if (n === undefined) return undefined;
  return reduceFraction(n, d);
}

function square(f: ExactFraction): ExactFraction | undefined {
  return fracMul(f, f);
}

/** Sign of (a - b): -1, 0, or 1. Denominators are positive after reduce. */
function compareFrac(a: ExactFraction, b: ExactFraction): number {
  const diff = fracSub(a, b);
  if (diff === undefined) return NaN; // overflow — callers treat NaN comparisons as "refuse"
  if (diff.numerator > 0) return 1;
  if (diff.numerator < 0) return -1;
  return 0;
}

/** Strict triangle inequality on all three sides. Overflow ⇒ refuse (false). */
function triangleInequalityHolds(a: ExactFraction, b: ExactFraction, c: ExactFraction): boolean {
  const ab = fracAdd(a, b);
  const bc = fracAdd(b, c);
  const ac = fracAdd(a, c);
  if (ab === undefined || bc === undefined || ac === undefined) return false;
  return compareFrac(ab, c) > 0 && compareFrac(bc, a) > 0 && compareFrac(ac, b) > 0;
}

/**
 * Exact rational square root, or undefined when irrational. A reduced fraction
 * p/q is a perfect rational square iff |p| and q are both perfect integer
 * squares; then sqrt(p/q) = sqrt(p)/sqrt(q).
 */
function fracSqrtExact(f: ExactFraction): ExactFraction | undefined {
  if (f.numerator < 0) return undefined;
  const p = perfectIntSqrt(f.numerator);
  const q = perfectIntSqrt(f.denominator);
  if (p === undefined || q === undefined) return undefined;
  return reduceFraction(p, q);
}

/** Integer square root of a perfect square, else undefined. */
function perfectIntSqrt(x: number): number | undefined {
  if (!Number.isSafeInteger(x) || x < 0) return undefined;
  const guess = Math.round(Math.sqrt(x));
  for (const candidate of [guess - 1, guess, guess + 1]) {
    if (candidate >= 0 && candidate * candidate === x) return candidate;
  }
  return undefined;
}

/**
 * Convert a finite number to an exact fraction. Integers map to n/1; finite
 * decimals are read from their plain string form (3.5 → 7/2). Exponential
 * notation or more than 12 fractional digits — inputs an exact bounded solver
 * cannot represent faithfully — refuse (undefined).
 */
function toFraction(x: number): ExactFraction | undefined {
  if (!Number.isFinite(x)) return undefined;
  if (Number.isInteger(x)) {
    return Number.isSafeInteger(x) ? { numerator: x, denominator: 1 } : undefined;
  }
  const s = x.toString();
  if (s.includes('e') || s.includes('E')) return undefined;
  const dot = s.indexOf('.');
  if (dot === -1) return undefined;
  const decimals = s.length - dot - 1;
  if (decimals > 12) return undefined;
  const denominator = 10 ** decimals;
  const numerator = Math.round(x * denominator);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) return undefined;
  return reduceFraction(numerator, denominator);
}

/** Human-readable fraction for the reproducible step trace. */
function fracStr(f: ExactFraction): string {
  return f.denominator === 1 ? `${f.numerator}` : `${f.numerator}/${f.denominator}`;
}
