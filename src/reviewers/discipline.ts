/**
 * LA FORJA — discipline reviewer (doc §6.2, §7.2).
 *
 * Contract: { claim, verdict ∈ correct|incorrect|unverified, citation }.
 * Verification is grounded by the BOUNDED SOLVER for the item's discipline
 * (src/solver), not by the model's assertion — "the model said so" is never
 * final evidence (§6.2). A `correct` verdict requires a full citation object;
 * no sufficient source ⇒ `unverified`, never `correct`.
 *
 * MULTI-DISCIPLINE: the domain line is per-discipline (`disciplineSystem`), so a
 * geometry item is never reviewed under "DOMAIN: probability only". The domain
 * is TRUSTED author metadata and belongs in the system prompt — never in the
 * delimited untrusted block (that would change the probability promptHash and
 * break hash-pinned tests).
 *
 * OWNER split: Claude owns the prompt template. Codex owns `reviewDiscipline`
 * (which must consult the solver + curated licensed corpus).
 */
import { GUARDRAIL_PREAMBLE, DELIMITER_NOTE } from './guardrails';
import { DisciplineSchema, type Discipline } from './schemas';
import { callModel } from '../openai/client';
import type { DisciplineId } from '../core/types';
import { disciplineLabel } from '../core/disciplines';

export const DISCIPLINE_PROMPT_VERSION = 'discipline-v1';

/**
 * The discipline reviewer system prompt for one math discipline. Everything but
 * the DOMAIN line and the expected `solver_proof.discipline` is identical across
 * disciplines, so a repair never silently loses the citation/solver contract.
 */
export function disciplineSystem(discipline: DisciplineId): string {
  const domain = disciplineLabel(discipline);
  return [
    GUARDRAIL_PREAMBLE,
    DELIMITER_NOTE,
    '',
    `DOMAIN: ${domain} only. Assess whether the item's stated correct answer is`,
    'defensible.',
    '',
    'Fill the contract:',
    '- claim: the single factual/computational claim you are assessing.',
    '- verdict: "correct" | "incorrect" | "unverified".',
    '- citation: for a "correct" verdict you MUST attach a full citation object',
    '  { source_id, version_date, license, excerpt, relevance } from the curated',
    '  licensed corpus. A bare URL is NOT enough. If you lack a sufficient source,',
    '  you MUST return "unverified" with citation = null — NEVER "correct".',
    '- solver_proof: when you falsify the numeric answer, record the bounded-solver',
    `  run. Its "discipline" field MUST be "${discipline}" and its "problem_kind"`,
    '  and "inputs" must be re-executable by that solver.',
    '',
    'The numeric answer itself will be re-checked by a deterministic bounded solver;',
    'do not fabricate computations you cannot ground.',
  ].join('\n');
}

/**
 * Back-compat alias: the probability domain prompt. Existing importers keep
 * compiling; new call sites pass the item's discipline through `disciplineSystem`.
 */
export const DISCIPLINE_SYSTEM = disciplineSystem('probability');

/**
 * IMPLEMENTED. Invariants this call must keep (they are easy to break on edit):
 *  - system = disciplineSystem(discipline); user payload = `delimitedItem` AS
 *    GIVEN. It is ALREADY wrapped by the orchestrator (`toDelimitedItem`); do NOT
 *    call delimitItem on it here — wrapping twice nests the delimiters and breaks
 *    the untrusted-input boundary (hard constraint 1).
 *  - schema = DisciplineSchema (forbids correct-without-citation).
 *  - Cross-check the numeric claim with the bounded solver for `discipline`; if
 *    the solver and the model disagree, prefer the solver and set verdict
 *    accordingly.
 *  - The orchestrator maps the result to a Check: solver-grounded numeric verdicts
 *    are checkClass='deterministic'; source-grounded conceptual verdicts are
 *    'semantic'; missing source ⇒ status='abstained'/'unverified'.
 * Reference: doc §6.2, §7.2.
 */
export async function reviewDiscipline(
  delimitedItem: string,
  model: string,
  discipline: DisciplineId,
  _signal?: AbortSignal,
): Promise<Discipline> {
  const result = await callModel<Discipline>({
    model,
    system: disciplineSystem(discipline),
    delimitedItem,
    schema: DisciplineSchema,
    promptVersion: DISCIPLINE_PROMPT_VERSION,
    callSite: 'orchestrator',
    reviewerType: 'discipline',
  });
  return result.data;
}
