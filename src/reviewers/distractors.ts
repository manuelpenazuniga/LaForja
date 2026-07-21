/**
 * LA FORJA — distractor reviewer (doc §6.2).
 *
 * Contract: a distractor -> hypothesized_error MAP, not one lone finding. The
 * reviewer analyzes the distractors it can say something about and returns ONE
 * entry per distractor, each carrying its own confidence and label. Without
 * evidence an entry is labeled "hypothesis" (never presented as fact). The
 * orchestrator then maps EACH ENTRY of the map to one Check row; distractor
 * findings are `semantic`-class checks (re-adjudicated each version, doc §5).
 *
 * OWNER split: Claude owns the prompt template. Codex owns `reviewDistractors`.
 */
import { GUARDRAIL_PREAMBLE, DELIMITER_NOTE } from './guardrails';
import { DistractorMapSchema, type DistractorMap } from './schemas';
import { callModel } from '../openai/client';

export const DISTRACTOR_PROMPT_VERSION = 'distractor-v2';

export const DISTRACTOR_SYSTEM = [
  GUARDRAIL_PREAMBLE,
  DELIMITER_NOTE,
  '',
  'TASK: For EACH distractor worth reporting, hypothesize the misconception it is',
  'meant to capture and judge whether it actually plausibly captures it.',
  '',
  'Return a JSON ARRAY: one entry per distractor you analyzed. Do not merge two',
  'options into one entry, and do not report the same option twice — if you have',
  'two competing hypotheses for one option, report the stronger one, with the',
  'confidence you actually have in it.',
  '',
  'Fill the contract for EVERY entry:',
  '- distractor: the option (key or text) this entry is about.',
  '- hypothesized_error: the student misconception this distractor targets.',
  '- confidence: 0..1, judged per entry — entries do not share a confidence.',
  '- label: "evidenced" ONLY if you can point to concrete textual evidence in the',
  '  item (then set the evidence field); otherwise "hypothesis" (and omit evidence).',
  '',
  'Never present a hypothesis as an established fact. A weakly supported entry is',
  'still reportable — label it "hypothesis" and lower its confidence, do not',
  'promote it to "evidenced" and do not silently drop it.',
].join('\n');

/**
 * IMPLEMENTED. Invariants this call must keep (they are easy to break on edit):
 *  - system = DISTRACTOR_SYSTEM; user payload = `delimitedItem` AS GIVEN.
 *    It is ALREADY wrapped by the orchestrator (`toDelimitedItem`); do NOT call
 *    delimitItem on it here — wrapping twice nests the delimiters and breaks the
 *    untrusted-input boundary (hard constraint 1).
 *  - schema = DistractorMapSchema: the whole response is the MAP (a non-empty
 *    array, one entry per distractor, distractor keys unique). Each entry is
 *    itself validated by DistractorSchema, which forces label='hypothesis' when
 *    evidence is absent.
 *  - The orchestrator maps EACH ENTRY to its own Check (reviewerType='distractor',
 *    checkClass='semantic'); an entry with label='hypothesis' ⇒ that Check's
 *    status stays 'hypothesis'. N entries in, N Check rows out.
 * Reference: doc §6.2.
 */
export async function reviewDistractors(
  delimitedItem: string,
  model: string,
): Promise<DistractorMap> {
  const result = await callModel<DistractorMap>({
    model,
    system: DISTRACTOR_SYSTEM,
    delimitedItem,
    schema: DistractorMapSchema,
    promptVersion: DISTRACTOR_PROMPT_VERSION,
    callSite: 'orchestrator',
    reviewerType: 'distractor',
  });
  return result.data;
}
