/**
 * LA FORJA — shared bounded-solver primitives (doc §5, §7.2).
 *
 * OWNER: Claude (shared types). Every discipline solver in src/solver returns a
 * `SolverResult` and consumes a member of the tagged `Problem` union. The
 * per-discipline computation lives in its own file (probability.ts,
 * statistics.ts, triangleSimilarity.ts, geometry.ts) and is Codex-owned.
 *
 * probability.ts re-exports `ExactFraction` / `SolverResult` / `ProbabilityProblem`
 * from here so every historical import keeps resolving.
 */
import type { DisciplineId } from '../core/types';

export interface ExactFraction {
  numerator: number;
  denominator: number;
}

export interface SolverResult {
  supported: boolean;
  /** Present iff the answer is exactly rational. Comparison is exact fraction-string equality. */
  value?: ExactFraction;
  /** Decimal (full IEEE-754 precision, computed from exact inputs). Display + tolerance-mode compare. */
  decimal?: number;
  /** Reproducible steps (sample space size, favorable count, formula applied, etc.). */
  steps?: string[];
  /**
   * ABSOLUTE tolerance for a decimal-mode comparison. Present ONLY when `value`
   * is absent (irrational answer, e.g. π or a non-perfect-square root). It is a
   * PUBLISHED CONSTANT the solver derives deterministically from the problem
   * (e.g. from a stated rounding), NEVER model-supplied. It absorbs float
   * round-off / stated-rounding only; it is not a fuzzy-match budget.
   */
  tolerance?: number;
}

/** Problem-specific parameters. Datasets/lists are canonical STRINGS, not arrays. */
export type SolverParams = Record<string, number | string | boolean>;

export interface ProbabilityProblem {
  discipline: 'probability';
  kind: 'conditional' | 'combinatoric' | 'basic';
  params: SolverParams;
}

export interface StatisticsProblem {
  discipline: 'statistics';
  kind:
    | 'mean'
    | 'median'
    | 'mode'
    | 'range'
    | 'pop_variance'
    | 'sample_variance'
    | 'pop_stddev'
    | 'sample_stddev'
    | 'quartiles'
    | 'iqr';
  params: SolverParams;
}

export interface TriangleProblem {
  discipline: 'triangle-similarity';
  kind: 'similarity_decision' | 'similarity_missing_side';
  params: SolverParams;
}

export interface GeometryProblem {
  discipline: 'geometry';
  kind:
    | 'pythagoras'
    | 'area_rectangle'
    | 'perimeter_rectangle'
    | 'area_triangle'
    | 'perimeter_triangle'
    | 'area_circle'
    | 'circumference'
    | 'polygon_angle_sum'
    | 'missing_angle'
    | 'distance';
  params: SolverParams;
}

/** The tagged union the dispatcher `solve()` routes on (by `discipline`). */
export type Problem = ProbabilityProblem | StatisticsProblem | TriangleProblem | GeometryProblem;

/** Compile-time assertion that every `Problem.discipline` is a real DisciplineId. */
export type _AssertDisciplineIds = Problem['discipline'] extends DisciplineId ? true : never;
