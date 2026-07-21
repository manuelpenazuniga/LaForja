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
import {
  DEFENSE_PUBLISH_MIN_TOTAL,
  RUBRIC_DIMENSIONS,
  type DefenseRubric,
} from '../core/types';
import {
  callModel,
  delimitItem,
  type ModelCallArgs,
  type ModelCallResult,
} from '../openai/client';
import { DELIMITER_NOTE, GUARDRAIL_PREAMBLE } from '../reviewers/guardrails';
import {
  DefenseQuestionsSchema,
  DefenseRubricSchema,
  type DefenseQuestions,
} from '../reviewers/schemas';

const DEFENSE_QUESTIONS_PROMPT_VERSION = 'defense-questions-v1';
const DEFENSE_SCORING_PROMPT_VERSION = 'defense-scoring-v1';

const DEFENSE_QUESTIONS_SYSTEM = [
  GUARDRAIL_PREAMBLE,
  DELIMITER_NOTE,
  '',
  'TASK: Author exactly two short written-defense QUESTIONS about this item.',
  'Ground both questions in the accepted reviewer findings supplied in the',
  'untrusted block. Do not ask generic questions that ignore those findings.',
  'Question 1 must probe the conceptual error captured by an accepted finding.',
  'Question 2 must probe uniqueness and a variation of the stem. If a prior',
  'answer is supplied, question 2 must respond specifically to what the student',
  'actually argued in that answer.',
  'Return questions only. Never author or rewrite item content, and never provide',
  'a canonical solution or worked answer.',
].join('\n');

const DEFENSE_SCORING_SYSTEM = [
  GUARDRAIL_PREAMBLE,
  DELIMITER_NOTE,
  '',
  'TASK: Evaluate the student\'s two written-defense answers using the explicit',
  'three-dimension rubric below. Return every dimension exactly once:',
  '- identifies_error: identifies the conceptual error captured by the finding',
  '- explains_uniqueness: explains why the correct alternative is unique',
  '- answers_variation: answers the variation of the stem correctly',
  'Score each dimension 0, 1, or 2. Every evidence field must include a direct,',
  'non-empty quotation from the supplied student answers. Set total to the sum',
  'of the three scores. Use passed only when total is at least 4 and no score is',
  'zero; otherwise use failed. Do not use inconclusive: infrastructure failures',
  'are handled by the caller.',
].join('\n');

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
 * Generates two schema-validated written-defense questions grounded in the
 * accepted findings. The second question is instructed to adapt to
 * `ctx.priorAnswers[0]` when present. The complete context is treated as
 * untrusted data and wrapped in exactly one delimiter pair.
 *
 * Call it through `deps.callModel`, never the imported `callModel` directly:
 * the parameter IS the seam that makes this testable without a key.
 * Reference: doc §6.3.
 */
export async function generateDefenseQuestions(
  ctx: VivaContext,
  model: string,
  deps: VivaDeps = DEFAULT_VIVA_DEPS,
): Promise<DefenseQuestions> {
  const priorAnswer = ctx.priorAnswers?.[0];
  const payload = [
    'STUDENT-AUTHORED ITEM:',
    `Stem: ${ctx.stem}`,
    `Options: ${JSON.stringify(ctx.options)}`,
    `Correct key: ${ctx.correctKey}`,
    '',
    'ACCEPTED REVIEWER FINDINGS:',
    JSON.stringify(ctx.acceptedFindings, null, 2),
    '',
    priorAnswer === undefined
      ? 'PRIOR ANSWER 1: Not supplied; author both initial questions.'
      : `PRIOR ANSWER 1: ${priorAnswer}`,
  ].join('\n');

  const result = await deps.callModel<DefenseQuestions>({
    model,
    system: DEFENSE_QUESTIONS_SYSTEM,
    delimitedItem: delimitItem(payload),
    schema: DefenseQuestionsSchema,
    promptVersion: DEFENSE_QUESTIONS_PROMPT_VERSION,
    callSite: 'viva',
  });

  // Keep the contract intact even when a custom injected caller does not
  // perform the validation guaranteed by the production transport.
  return DefenseQuestionsSchema.parse(result.data);
}

/**
 * Scores both answers with the schema-validated three-dimension rubric and
 * verifies that each evidence field quotes the student's actual text. The
 * total is derived from the scores and the outcome is decided only by
 * `meetsPublishThreshold`. Any evaluator or contract failure returns a
 * schema-valid inconclusive rubric whose zeros explicitly are not a judgment
 * of the student.
 *
 * Call it through `deps.callModel`, never the imported `callModel` directly.
 * Reference: doc §6.3.
 */
export async function scoreDefense(
  ctx: VivaContext,
  answers: string[],
  model: string,
  deps: VivaDeps = DEFAULT_VIVA_DEPS,
): Promise<DefenseRubric> {
  try {
    const payload = [
      'STUDENT-AUTHORED ITEM:',
      `Stem: ${ctx.stem}`,
      `Options: ${JSON.stringify(ctx.options)}`,
      `Correct key: ${ctx.correctKey}`,
      '',
      'ACCEPTED REVIEWER FINDINGS:',
      JSON.stringify(ctx.acceptedFindings, null, 2),
      '',
      'STUDENT DEFENSE ANSWERS:',
      ...answers.map((answer, index) => `Answer ${index + 1}: ${answer}`),
    ].join('\n');

    const result = await deps.callModel<DefenseRubric>({
      model,
      system: DEFENSE_SCORING_SYSTEM,
      delimitedItem: delimitItem(payload),
      schema: DefenseRubricSchema,
      promptVersion: DEFENSE_SCORING_PROMPT_VERSION,
      callSite: 'viva',
    });

    // Re-validate at this boundary so an injected caller cannot bypass the
    // rubric contract. A malformed or self-contradictory rubric is an evaluator
    // failure, never a grade.
    const rubric = DefenseRubricSchema.parse(result.data);
    const answerText = answers.join('\n');
    const everyDimensionQuotesStudent = rubric.dimensions.every((dimension) => {
      const straightQuotes = [...dimension.evidence.matchAll(/"([^"\n]+)"/g)].map(
        (match) => match[1],
      );
      const curlyQuotes = [...dimension.evidence.matchAll(/“([^”\n]+)”/g)].map(
        (match) => match[1],
      );
      return [...straightQuotes, ...curlyQuotes].some(
        (quotation) => quotation !== undefined && answerText.includes(quotation),
      );
    });
    if (!everyDimensionQuotesStudent) {
      throw new Error('Evaluator rubric evidence did not quote the student answers');
    }

    const total = rubric.dimensions.reduce((sum, dimension) => sum + dimension.score, 0);
    const graded: DefenseRubric = {
      dimensions: rubric.dimensions,
      total,
      outcome: 'failed',
    };
    graded.outcome = meetsPublishThreshold(graded) ? 'passed' : 'failed';
    return DefenseRubricSchema.parse(graded);
  } catch {
    const evidence =
      'Evaluator failure: the defense could not be scored; this zero is not a judgment of the student.';
    return {
      dimensions: [
        { dimension: RUBRIC_DIMENSIONS[0], score: 0, evidence },
        { dimension: RUBRIC_DIMENSIONS[1], score: 0, evidence },
        { dimension: RUBRIC_DIMENSIONS[2], score: 0, evidence },
      ],
      total: 0,
      outcome: 'inconclusive',
    };
  }
}
