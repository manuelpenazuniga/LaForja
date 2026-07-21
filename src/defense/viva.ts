/**
 * LA FORJA — written defense / viva (doc §6.3).
 *
 * OWNER: Codex. Two ADAPTIVE WRITTEN questions, scored by an EXPLICIT rubric:
 * 3 dimensions × scale 0-2, each with textual evidence.
 *   1. identifies_error     — identifies the conceptual error the flagged distractor captures
 *   2. explains_uniqueness  — explains why the correct alternative is unique
 *   3. answers_variation    — answers a variation of the stem correctly
 *
 * Publish threshold: total >= 4/6 AND no dimension scored 0 (doc §6.3).
 * Evaluator failure ⇒ state DEFENSE_INCONCLUSIVE (NEVER an auto-reject).
 */
import { DEFENSE_PUBLISH_MIN_TOTAL, type DefenseRubric } from '../core/types';

/**
 * Pure publish-gate for a completed rubric (doc §6.3). Deterministic — safe for
 * Claude to provide so the threshold is testable independently of the evaluator.
 */
export function meetsPublishThreshold(rubric: Pick<DefenseRubric, 'dimensions' | 'total'>): boolean {
  const noZero = rubric.dimensions.every((d) => d.score > 0);
  return rubric.total >= DEFENSE_PUBLISH_MIN_TOTAL && noZero;
}

export interface VivaContext {
  stem: string;
  options: string[];
  correctKey: string;
  /** The accepted findings the student must defend against (e.g. flagged distractor). */
  acceptedFindings: unknown[];
}

/**
 * TODO(codex): generate 2 adaptive written questions grounded in the accepted
 * findings (schema = DefenseQuestionsSchema). Second question adapts to the first
 * answer. Untrusted student text stays delimited; the model authors questions, not
 * item content. Reference: doc §6.3.
 */
export async function generateDefenseQuestions(_ctx: VivaContext, _model: string): Promise<unknown> {
  throw new Error('TODO(codex): implement adaptive question generation');
}

/**
 * TODO(codex): score the two answers against the rubric (schema = DefenseRubricSchema).
 *  - Each dimension gets a 0-2 score WITH textual evidence quoting the answer.
 *  - Compute total; outcome = meetsPublishThreshold ? 'passed' : 'failed'.
 *  - If the evaluator model call fails/invalid after retry ⇒ outcome='inconclusive'
 *    and the caller sets state DEFENSE_INCONCLUSIVE (never auto-reject).
 * Reference: doc §6.3.
 */
export async function scoreDefense(
  _ctx: VivaContext,
  _answers: string[],
  _model: string,
): Promise<DefenseRubric> {
  throw new Error('TODO(codex): implement rubric scoring with evidence per dimension');
}
