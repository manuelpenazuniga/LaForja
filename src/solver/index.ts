/**
 * LA FORJA — bounded-solver dispatcher (doc §5, §7.2).
 *
 * `solve` is the ONE entry point the check re-run engine calls. It is pure,
 * total, and REFUSING: an unknown discipline, an unknown kind, an oversize or
 * malformed problem all resolve to { supported: false } (never a guess, never a
 * throw), which the history engine reports as 'inconclusive' → fail-closed.
 *
 * probability stays byte-for-byte on its own hot path; the other three route to
 * their discipline's bounded solver by the tagged `Problem.discipline`.
 */
import type { Problem, SolverResult } from './types';
import { solveProbability } from './probability';
import { solveStatistics } from './statistics';
import { solveTriangleSimilarity } from './triangleSimilarity';
import { solveGeometry } from './geometry';

export type { ExactFraction, SolverResult, Problem, SolverParams } from './types';

export function solve(problem: Problem): SolverResult {
  switch (problem.discipline) {
    case 'probability':
      return solveProbability(problem);
    case 'statistics':
      return solveStatistics(problem);
    case 'triangle-similarity':
      return solveTriangleSimilarity(problem);
    case 'geometry':
      return solveGeometry(problem);
    default:
      return { supported: false };
  }
}
