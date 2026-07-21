/**
 * LA FORJA — ambiguity reviewer (doc §6.2).
 *
 * Contract: { interpretation_a, interpretation_b, answer_a, answer_b, evidence }.
 * A finding is a valid ATTACK only if answer_a !== answer_b (two readings, two
 * answers). Accepted ambiguity findings are `counterexample`-class checks (doc §5).
 *
 * OWNER split: Claude owns the prompt template (below). Codex owns `reviewAmbiguity`.
 */
import { GUARDRAIL_PREAMBLE, DELIMITER_NOTE } from './guardrails';
import { AmbiguitySchema, type Ambiguity } from './schemas';
import { callModel } from '../openai/client';

export const AMBIGUITY_PROMPT_VERSION = 'ambiguity-v1';

export const AMBIGUITY_SYSTEM = [
  GUARDRAIL_PREAMBLE,
  DELIMITER_NOTE,
  '',
  'TASK: Find a genuine ambiguity in the stem or options — a wording that admits',
  'TWO reasonable interpretations that lead to DIFFERENT correct answers.',
  '',
  'Fill the contract:',
  '- interpretation_a / interpretation_b: the two distinct readings, in the',
  '  student\'s own domain terms.',
  '- answer_a / answer_b: the answer each reading yields. They MUST differ; if you',
  '  cannot make them differ, there is no ambiguity attack — return the schema with',
  '  equal answers only if truly forced (it will be rejected as invalid).',
  '- evidence: why each reading is defensible from the text as written.',
].join('\n');

/**
 * TODO(codex): implement the ambiguity reviewer call.
 *  - system = AMBIGUITY_SYSTEM; user payload = `delimitedItem` AS GIVEN. It is
 *    ALREADY wrapped by the orchestrator (`toDelimitedItem`); do NOT call
 *    delimitItem on it here — wrapping twice nests the delimiters and breaks the
 *    untrusted-input boundary (hard constraint 1).
 *  - schema = AmbiguitySchema (rejects answer_a === answer_b).
 *  - return the parsed contract; the orchestrator maps it to a Check
 *    (reviewerType='ambiguity', checkClass='counterexample').
 * Reference: doc §6.2, §7.1.
 */
export async function reviewAmbiguity(delimitedItem: string, model: string): Promise<Ambiguity> {
  const result = await callModel<Ambiguity>({
    model,
    system: AMBIGUITY_SYSTEM,
    delimitedItem,
    schema: AmbiguitySchema,
    promptVersion: AMBIGUITY_PROMPT_VERSION,
    callSite: 'orchestrator',
    reviewerType: 'ambiguity',
  });
  return result.data;
}
