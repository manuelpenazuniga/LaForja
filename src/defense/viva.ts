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
import {
  callModel,
  type ModelCallArgs,
  type ModelCallResult,
} from '../openai/client';
import type { DefenseQuestions } from '../reviewers/schemas';

/**
 * THE TRANSPORT SEAM (this pass exists for it).
 *
 * There is no runtime API key, so the network boundary is the one thing that
 * cannot be exercised. Everything on THIS side of it — grounding the questions
 * in the accepted findings, keeping the student's answer delimited, validating
 * the rubric, and above all turning an evaluator failure into
 * DEFENSE_INCONCLUSIVE rather than a rejection — is verifiable offline as long
 * as the call itself is injectable. `VivaDeps` is that injection point, and
 * tests/viva.test.ts drives both functions through it with fakes.
 */
export type ModelCaller = <T>(args: ModelCallArgs<T>) => Promise<ModelCallResult<T>>;

export interface VivaDeps {
  callModel: ModelCaller;
}

/** Production wiring: the real bounded Responses call. */
export const DEFAULT_VIVA_DEPS: VivaDeps = { callModel };

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
  /**
   * Answers already written by the student, in order. Present ⇒ this is the
   * ADAPTIVE pass: question 2 must respond to what the student actually argued
   * in answer 1 (doc §6.3). Untrusted text — it is delimited like the item.
   */
  priorAnswers?: string[];
}

/**
 * TODO(codex): generate 2 adaptive written questions grounded in the accepted
 * findings (schema = DefenseQuestionsSchema). Second question adapts to
 * `ctx.priorAnswers[0]` when present. Untrusted student text stays delimited;
 * the model authors questions, not item content.
 *
 * Call it through `deps.callModel`, never the imported `callModel` directly:
 * the parameter IS the seam that makes this testable without a key.
 * Reference: doc §6.3.
 */
export async function generateDefenseQuestions(
  _ctx: VivaContext,
  _model: string,
  _deps: VivaDeps = DEFAULT_VIVA_DEPS,
): Promise<DefenseQuestions> {
  throw new Error('TODO(codex): implement adaptive question generation');
}

/**
 * TODO(codex): score the two answers against the rubric (schema = DefenseRubricSchema).
 *  - Each dimension gets a 0-2 score WITH textual evidence quoting the answer.
 *  - Compute total; outcome = meetsPublishThreshold ? 'passed' : 'failed'.
 *  - If the evaluator model call fails/invalid after retry ⇒ CATCH it and RETURN
 *    outcome='inconclusive' (three dimensions at 0, evidence naming the
 *    evaluator failure, total 0). Do NOT rethrow and do NOT return 'failed':
 *    the caller dispatches DEFENSE_EVALUATOR_FAILED ⇒ DEFENSE_INCONCLUSIVE, and
 *    a student must never be failed because the grader broke.
 *
 * Call it through `deps.callModel`, never the imported `callModel` directly.
 * Reference: doc §6.3.
 */
export async function scoreDefense(
  _ctx: VivaContext,
  _answers: string[],
  _model: string,
  _deps: VivaDeps = DEFAULT_VIVA_DEPS,
): Promise<DefenseRubric> {
  throw new Error('TODO(codex): implement rubric scoring with evidence per dimension');
}
