/**
 * LA FORJA — deterministic bounded triangle-similarity solver (doc §5, §7.2).
 *
 * OWNER: Codex. Reproducible ground truth for similarity items: it grounds the
 * two NUMERIC questions a similarity item can pose — the scale factor between a
 * confirmed-similar pair, and a missing corresponding side under a known scale.
 * "The model said so" is never final evidence; this is what the discipline
 * reviewer is checked against.
 *
 * BOUNDED and TOTAL. Sides and angles arrive as safe integers (rational sides,
 * degrees for angles); lists arrive as canonical comma-separated STRINGS, never
 * arrays. The solver REFUSES rather than crashes, and REFUSES rather than
 * guesses, in that order:
 *
 *  - A pure yes/no similarity DECISION has no single numeric answer, so it is
 *    out of a numeric solver's scope: similarity_decision returns a value ONLY
 *    when the criterion resolves to a determinable scale factor (SSS or SAS on a
 *    confirmed-similar pair). Not similar, or AA (no side present), => refuse.
 *  - Congruence (ASA/AAS/HL), coordinate-only triangles, undeterminable
 *    correspondence, angle-only asks for a side, degenerate triangles, angle
 *    sets not summing to 180, non-numeric input and over-bound magnitudes all
 *    => { supported: false }.
 *
 * Every similarity answer here is a ratio of integers, hence exactly rational:
 * this solver never produces an irrational (decimal + tolerance) result.
 */
import type { ExactFraction, SolverResult, TriangleProblem } from './types';
import { reduceFraction } from './probability';

export type { ExactFraction, SolverResult, TriangleProblem } from './types';

/**
 * PUBLISHED BOUND (part of the spec; the solver REFUSES beyond it). Every side
 * is a safe integer with magnitude <= this. It keeps every exact intermediate
 * (cross-products a*b, and target*scale numerators) well inside
 * Number.MAX_SAFE_INTEGER: two bounded sides multiply to <= 1e12 << 9.007e15.
 */
export const MAX_SIDE_MAGNITUDE = 1_000_000;

/** Degree measures are strictly interior angles: 0 < angle < 180. */
export const MAX_ANGLE_DEGREES = 180;

/**
 * Ground-truth similarity computation. Reference: doc §5 (deterministic class),
 * §7.2. Refuses everything outside the two supported numeric shapes.
 */
export function solveTriangleSimilarity(problem: TriangleProblem): SolverResult {
  if (problem.kind === 'similarity_decision') {
    return solveDecision(problem.params);
  }
  if (problem.kind === 'similarity_missing_side') {
    return solveMissingSide(problem.params);
  }
  return unsupported();
}

// --- similarity_decision -----------------------------------------------------

function solveDecision(params: TriangleProblem['params']): SolverResult {
  const criterion = params.criterion;

  if (criterion === 'SSS') {
    const t1 = parseSides(params.t1, 3);
    const t2 = parseSides(params.t2, 3);
    if (t1 === undefined || t2 === undefined) return unsupported();

    const s1 = sortAscending(t1);
    const s2 = sortAscending(t2);
    // Degenerate triangles are not triangles; a repeated side makes the sorted
    // correspondence non-unique (which of the equal sides maps where), so both
    // are refused before any similarity judgement.
    if (!isNonDegenerate(s1) || !isNonDegenerate(s2)) return unsupported();
    if (hasRepeatedSide(s1) || hasRepeatedSide(s2)) return unsupported();

    if (!sidesProportional(s1, s2)) return unsupported();

    const k = reduceFraction(s1[0], s2[0]);
    return exactResult(k, [
      `Sorted triangle 1 sides ascending: ${s1.join(', ')}.`,
      `Sorted triangle 2 sides ascending: ${s2.join(', ')}.`,
      'Verified all three side ratios are equal (SSS similarity).',
      `Scale factor k = ${s1[0]}/${s2[0]} = ${fractionText(k)}.`,
    ]);
  }

  if (criterion === 'SAS') {
    const a = parseSas(params.t1);
    const b = parseSas(params.t2);
    if (a === undefined || b === undefined) return unsupported();

    // Included angle must match, and the two enclosing sides must be in
    // proportion, for the pair to be similar under SAS.
    if (a.theta !== b.theta) return unsupported();

    const cross1 = safeMul(a.p, b.q);
    const cross2 = safeMul(b.p, a.q);
    if (cross1 === undefined || cross2 === undefined) return unsupported();
    if (cross1 !== cross2) return unsupported();

    const k = reduceFraction(a.p, b.p);
    return exactResult(k, [
      `Included angle matches: ${a.theta}° in both triangles.`,
      `Verified enclosing sides are proportional: ${a.p}·${b.q} = ${b.p}·${a.q} (SAS similarity).`,
      `Scale factor k = ${a.p}/${b.p} = ${fractionText(k)}.`,
    ]);
  }

  // AA: two angles, no side present, so the scale factor is not determinable —
  // a numeric solver refuses. (Any other criterion, incl. congruence tests such
  // as ASA/AAS/HL, is out of scope.)
  return unsupported();
}

// --- similarity_missing_side -------------------------------------------------

function solveMissingSide(params: TriangleProblem['params']): SolverResult {
  const known1 = asSide(params.known_side_1);
  const known2 = asSide(params.known_side_2);
  const target = asSide(params.target_side_1);
  if (known1 === undefined || known2 === undefined || target === undefined) {
    return unsupported();
  }

  // Optional triangle triples are for degeneracy validation only. If given and
  // malformed or degenerate, refuse.
  if (params.t1 !== undefined) {
    const t1 = parseSides(params.t1, 3);
    if (t1 === undefined || !isNonDegenerate(sortAscending(t1))) return unsupported();
  }
  if (params.t2 !== undefined) {
    const t2 = parseSides(params.t2, 3);
    if (t2 === undefined || !isNonDegenerate(sortAscending(t2))) return unsupported();
  }

  // missing = target * (known2 / known1). Guard the exact numerator before
  // reducing so no intermediate can exceed Number.MAX_SAFE_INTEGER.
  const numerator = safeMul(target, known2);
  if (numerator === undefined) return unsupported();

  const missing = reduceFraction(numerator, known1);
  return exactResult(missing, [
    `Scale factor k = ${known2}/${known1} (corresponding known sides).`,
    `Missing side = ${target} · ${known2}/${known1} = ${fractionText(missing)}.`,
  ]);
}

// --- results -----------------------------------------------------------------

function unsupported(): SolverResult {
  return { supported: false };
}

/**
 * Exact-rational answer. Similarity results are always rational, so `value` is
 * always set and `tolerance` is NEVER set (tolerance is for irrational results
 * this solver cannot produce).
 */
function exactResult(value: ExactFraction, steps: string[]): SolverResult {
  if (!Number.isSafeInteger(value.numerator) || !Number.isSafeInteger(value.denominator)) {
    return unsupported();
  }
  if (value.denominator === 0) return unsupported();
  return {
    supported: true,
    value,
    decimal: value.numerator / value.denominator,
    steps,
  };
}

// --- parsing / validation ----------------------------------------------------

/** A side param: safe integer, strictly positive, within the published bound. */
function asSide(value: number | string | boolean | undefined): number | undefined {
  if (typeof value !== 'number') return undefined;
  if (!Number.isSafeInteger(value)) return undefined;
  if (value <= 0 || value > MAX_SIDE_MAGNITUDE) return undefined;
  return value;
}

/** A degree angle: safe integer, strictly interior (0 < a < 180). */
function asAngle(value: number | string | boolean | undefined): number | undefined {
  if (typeof value !== 'number') return undefined;
  if (!Number.isSafeInteger(value)) return undefined;
  if (value <= 0 || value >= MAX_ANGLE_DEGREES) return undefined;
  return value;
}

/** Parse a single "int" token strictly: optional sign, digits only. */
function parseIntegerToken(token: string): number | undefined {
  const trimmed = token.trim();
  if (!/^-?\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * Parse a canonical comma-separated string into exactly `count` positive
 * integer sides within bound. Any non-numeric token, wrong arity, non-positive
 * or over-bound value => undefined (refuse).
 */
function parseSides(value: number | string | boolean | undefined, count: number): number[] | undefined {
  if (typeof value !== 'string') return undefined;
  const tokens = value.split(',');
  if (tokens.length !== count) return undefined;

  const sides: number[] = [];
  for (const token of tokens) {
    const n = parseIntegerToken(token);
    if (n === undefined || n <= 0 || n > MAX_SIDE_MAGNITUDE) return undefined;
    sides.push(n);
  }
  return sides;
}

/** Parse an SAS triple "p,q,theta" into two sides and an included angle. */
function parseSas(value: number | string | boolean | undefined): { p: number; q: number; theta: number } | undefined {
  if (typeof value !== 'string') return undefined;
  const tokens = value.split(',');
  if (tokens.length !== 3) return undefined;

  const p = parseIntegerToken(tokens[0] ?? '');
  const q = parseIntegerToken(tokens[1] ?? '');
  const rawTheta = parseIntegerToken(tokens[2] ?? '');
  if (p === undefined || q === undefined || rawTheta === undefined) return undefined;
  if (p <= 0 || p > MAX_SIDE_MAGNITUDE || q <= 0 || q > MAX_SIDE_MAGNITUDE) return undefined;

  const theta = asAngle(rawTheta);
  if (theta === undefined) return undefined;
  return { p, q, theta };
}

function sortAscending(sides: number[]): [number, number, number] {
  const s = [...sides].sort((a, b) => a - b);
  return [s[0] ?? 0, s[1] ?? 0, s[2] ?? 0];
}

/** Triangle inequality on sorted sides: the two shortest must exceed the longest. */
function isNonDegenerate(sorted: [number, number, number]): boolean {
  const [a, b, c] = sorted;
  return a > 0 && b > 0 && c > 0 && a + b > c;
}

/** A repeated side length makes the sorted correspondence ambiguous. */
function hasRepeatedSide(sorted: [number, number, number]): boolean {
  const [a, b, c] = sorted;
  return a === b || b === c;
}

/**
 * All three side ratios equal (SSS similarity) via cross-multiplication, guarded
 * against overflow. sorted1 = [a1,b1,c1], sorted2 = [a2,b2,c2] are similar iff
 * a1·b2 = a2·b1 AND b1·c2 = b2·c1 (positivity gives the third ratio).
 */
function sidesProportional(sorted1: [number, number, number], sorted2: [number, number, number]): boolean {
  const [a1, b1, c1] = sorted1;
  const [a2, b2, c2] = sorted2;

  const ab = safeMul(a1, b2);
  const ba = safeMul(a2, b1);
  const bc = safeMul(b1, c2);
  const cb = safeMul(b2, c1);
  if (ab === undefined || ba === undefined || bc === undefined || cb === undefined) return false;

  return ab === ba && bc === cb;
}

/** Integer multiplication that refuses (returns undefined) on overflow. */
function safeMul(a: number, b: number): number | undefined {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return undefined;
  const product = a * b;
  return Number.isSafeInteger(product) ? product : undefined;
}

function fractionText(f: ExactFraction): string {
  return f.denominator === 1 ? `${f.numerator}` : `${f.numerator}/${f.denominator}`;
}
