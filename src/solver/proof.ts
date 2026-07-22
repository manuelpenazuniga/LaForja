/**
 * LA FORJA — the ONE place a recorded `solver_proof` becomes a re-executable
 * `Problem` (doc §5, §6.2).
 *
 * The discipline reviewer records a `SolverProof` (discipline, problem_kind,
 * inputs, computed_value). When the history engine re-runs a deterministic
 * discipline check it needs that proof back as a `Problem` the dispatcher can
 * route. Carrying `discipline` across this seam is what lets `solve()` reach the
 * right bounded solver at re-run — without it a geometry proof would re-run
 * against the probability solver and fail closed.
 */
import type { Problem } from './types';
import type { SolverProof } from '../reviewers/schemas';

export function solverProofToProblem(proof: SolverProof): Problem {
  return {
    discipline: proof.discipline,
    kind: proof.problem_kind,
    params: proof.inputs,
  } as Problem;
}
