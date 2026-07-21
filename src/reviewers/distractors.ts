/**
 * LA FORJA — distractor reviewer (doc §6.2).
 *
 * Contract: distractor -> hypothesized_error + confidence. Without evidence a
 * finding is labeled "hypothesis" (never presented as fact). Distractor findings
 * are `semantic`-class checks (re-adjudicated each version, doc §5).
 *
 * OWNER split: Claude owns the prompt template. Codex owns `reviewDistractors`.
 */
import { GUARDRAIL_PREAMBLE, DELIMITER_NOTE } from './guardrails';
import { DistractorSchema, type Distractor } from './schemas';
import { callModel, delimitItem } from '../openai/client';

export const DISTRACTOR_PROMPT_VERSION = 'distractor-v1';

export const DISTRACTOR_SYSTEM = [
  GUARDRAIL_PREAMBLE,
  DELIMITER_NOTE,
  '',
  'TASK: For a weak or leaky distractor, hypothesize the misconception it is meant',
  'to capture and judge whether it actually plausibly captures it.',
  '',
  'Fill the contract:',
  '- distractor: the option (key or text) you are analyzing.',
  '- hypothesized_error: the student misconception this distractor targets.',
  '- confidence: 0..1.',
  '- label: "evidenced" ONLY if you can point to concrete textual evidence',
  '  (then set the evidence field); otherwise "hypothesis" (and omit evidence).',
  '',
  'Never present a hypothesis as an established fact.',
].join('\n');

/**
 * TODO(codex): implement the distractor reviewer.
 *  - system = DISTRACTOR_SYSTEM; user payload = delimitItem(rawItemText).
 *  - schema = DistractorSchema (forces label='hypothesis' when evidence absent).
 *  - The orchestrator maps the result to a Check (reviewerType='distractor',
 *    checkClass='semantic'); label='hypothesis' ⇒ status stays 'hypothesis'.
 * Reference: doc §6.2.
 */
export async function reviewDistractors(rawItemText: string, model: string): Promise<Distractor> {
  const result = await callModel<Distractor>({
    model,
    system: DISTRACTOR_SYSTEM,
    delimitedItem: delimitItem(rawItemText),
    schema: DistractorSchema,
    promptVersion: DISTRACTOR_PROMPT_VERSION,
    callSite: 'orchestrator',
    reviewerType: 'distractor',
  });
  return result.data;
}
