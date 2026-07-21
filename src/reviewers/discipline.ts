/**
 * LA FORJA — discipline reviewer (PROBABILITY ONLY, doc §6.2, §7.2).
 *
 * Contract: { claim, verdict ∈ correct|incorrect|unverified, citation }.
 * Verification is grounded by the BOUNDED SOLVER (src/solver/probability.ts), not
 * by the model's assertion — "the model said so" is never final evidence (§6.2).
 * A `correct` verdict requires a full citation object; no sufficient source ⇒
 * `unverified`, never `correct`.
 *
 * OWNER split: Claude owns the prompt template. Codex owns `reviewDiscipline`
 * (which must consult the solver + curated licensed corpus).
 */
import { GUARDRAIL_PREAMBLE, DELIMITER_NOTE } from './guardrails';
import { DisciplineSchema, type Discipline } from './schemas';
import { callModel } from '../openai/client';

export const DISCIPLINE_PROMPT_VERSION = 'discipline-v1';

export const DISCIPLINE_SYSTEM = [
  GUARDRAIL_PREAMBLE,
  DELIMITER_NOTE,
  '',
  'DOMAIN: probability only. Assess whether the item\'s stated correct answer is',
  'defensible.',
  '',
  'Fill the contract:',
  '- claim: the single factual/computational claim you are assessing.',
  '- verdict: "correct" | "incorrect" | "unverified".',
  '- citation: for a "correct" verdict you MUST attach a full citation object',
  '  { source_id, version_date, license, excerpt, relevance } from the curated',
  '  licensed corpus. A bare URL is NOT enough. If you lack a sufficient source,',
  '  you MUST return "unverified" with citation = null — NEVER "correct".',
  '',
  'The numeric answer itself will be re-checked by a deterministic bounded solver;',
  'do not fabricate computations you cannot ground.',
].join('\n');

/**
 * TODO(codex): implement the discipline reviewer.
 *  - system = DISCIPLINE_SYSTEM; user payload = `delimitedItem` AS GIVEN. It is
 *    ALREADY wrapped by the orchestrator (`toDelimitedItem`); do NOT call
 *    delimitItem on it here — wrapping twice nests the delimiters and breaks the
 *    untrusted-input boundary (hard constraint 1).
 *  - schema = DisciplineSchema (forbids correct-without-citation).
 *  - Cross-check the numeric claim with src/solver/probability.ts; if the solver
 *    and the model disagree, prefer the solver and set verdict accordingly.
 *  - The orchestrator maps the result to a Check: solver-grounded numeric verdicts
 *    are checkClass='deterministic'; source-grounded conceptual verdicts are
 *    'semantic'; missing source ⇒ status='abstained'/'unverified'.
 * Reference: doc §6.2, §7.2.
 */
export async function reviewDiscipline(delimitedItem: string, model: string): Promise<Discipline> {
  const result = await callModel<Discipline>({
    model,
    system: DISCIPLINE_SYSTEM,
    delimitedItem,
    schema: DisciplineSchema,
    promptVersion: DISCIPLINE_PROMPT_VERSION,
    callSite: 'orchestrator',
    reviewerType: 'discipline',
  });
  return result.data;
}
