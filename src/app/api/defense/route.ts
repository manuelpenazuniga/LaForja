/**
 * POST /api/defense — the short WRITTEN defense (viva) and its explicit rubric
 * (doc §6.3, slice item 6).
 *
 * Two phases on one endpoint:
 *  - no `answers`  -> issue the 2 adaptive written questions,
 *  - with `answers` -> score them against the rubric (3 dimensions x 0-2, each
 *    with textual evidence). Publish threshold: >= 4/6 AND no dimension at 0.
 *
 * OWNER SPLIT:
 *  - Claude (this file, done): session resolution, rate limit, input size, Zod
 *    validation, typed errors, and the two-phase response contract.
 *  - Codex: `issueDefenseQuestions` and `scoreDefenseAnswers` below.
 *
 * INCONCLUSIVE IS NOT REJECTION (doc §6.3): if the evaluator call fails or
 * returns an invalid rubric after its retry, the outcome is "inconclusive" and
 * the item goes to DEFENSE_INCONCLUSIVE — returned as HTTP 200, never a 500 and
 * NEVER an auto-reject. The student can retry (DEFENSE_RETRY).
 */
import { z } from 'zod';
import {
  assertInputSizes,
  assertRateLimit,
  errorResponse,
  getOrCreateSession,
  jsonResponse,
  loadIsolationConfig,
  notFound,
  parseBody,
  readJsonBody,
} from '@/demo/isolation';
import { prisma } from '@/db/client';
import { generateDefenseQuestions, meetsPublishThreshold, scoreDefense } from '@/defense/viva';
import type { DefenseRubric, ItemState } from '@/core/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DefenseRequestSchema = z
  .object({
    itemId: z.string().min(1).max(64),
    /** Omit to receive the questions; send exactly 2 to be scored. */
    answers: z.array(z.string().min(1)).length(2).optional(),
  })
  .strict();

interface DefenseQuestion {
  id: string;
  prompt: string;
}

interface QuestionsResponse {
  phase: 'questions';
  itemId: string;
  itemVersionId: string;
  /** Exactly 2, per doc §6.3. */
  questions: DefenseQuestion[];
  state: ItemState;
}

interface ScoredResponse {
  phase: 'scored';
  itemId: string;
  itemVersionId: string;
  /** null only when the evaluator failed (outcome 'inconclusive'). */
  rubric: DefenseRubric | null;
  outcome: 'passed' | 'failed' | 'inconclusive';
  state: ItemState;
}

interface VersionRef {
  itemId: string;
  itemVersionId: string;
  stem: string;
  optionsJson: string;
  correctKey: string;
}

/**
 * TODO(codex): issue the 2 adaptive written questions.
 *
 *  1. Build the VivaContext: stem, options (fromJson of optionsJson), correctKey
 *     and the ACCEPTED findings on this version (the flagged distractor is what
 *     dimension 1 is about).
 *  2. Call `generateDefenseQuestions(ctx, ADJUDICATOR_MODEL from loadModelConfig())`
 *     and validate against DefenseQuestionsSchema (exactly 2).
 *  3. Upsert the Defense row for `itemVersionId` with questionsJson (via toJson)
 *     and outcome 'pending'.
 *  4. Persist a ModelCall row (callSite 'viva') with the exact model id,
 *     promptVersion, promptHash, latency and tokens (hard constraint 3).
 *  5. Return the questions and the item state.
 *
 * Untrusted student text stays delimited in the prompt; the model authors
 * questions, never item content. Reference: doc §6.3.
 */
async function issueDefenseQuestions(
  _version: VersionRef,
): Promise<{ questions: DefenseQuestion[]; state: ItemState }> {
  void generateDefenseQuestions;
  throw new Error('TODO(codex): implement defense question generation (generateDefenseQuestions)');
}

/**
 * TODO(codex): score the two written answers.
 *
 *  1. Rebuild the VivaContext and call `scoreDefense(ctx, answers, model)`.
 *  2. Score each of the 3 dimensions 0-2 WITH textual evidence quoting the answer.
 *  3. outcome = `meetsPublishThreshold(rubric)` ? 'passed' : 'failed'.
 *  4. EVALUATOR FAILURE (call throws, or the rubric fails DefenseRubricSchema
 *     after the single retry) => outcome 'inconclusive' and state
 *     DEFENSE_INCONCLUSIVE via the DEFENSE_EVALUATOR_FAILED event. Return it as
 *     a normal 200 response with `rubric: null`. NEVER auto-reject, never throw.
 *  5. Persist the Defense row (answersJson, rubricJson, totalScore, outcome) and
 *     a ModelCall row (callSite 'viva').
 *  6. Dispatch the state event: DEFENSE_PASSED -> PUBLISHED,
 *     DEFENSE_FAILED -> CHALLENGED, DEFENSE_EVALUATOR_FAILED ->
 *     DEFENSE_INCONCLUSIVE. Update Item.state.
 *
 * Reference: doc §6.3.
 */
async function scoreDefenseAnswers(
  _version: VersionRef,
  _answers: string[],
): Promise<{ rubric: DefenseRubric | null; outcome: ScoredResponse['outcome']; state: ItemState }> {
  void scoreDefense;
  void meetsPublishThreshold;
  throw new Error('TODO(codex): implement defense scoring (scoreDefense + rubric persistence)');
}

export async function POST(req: Request): Promise<Response> {
  const config = loadIsolationConfig();
  let cookie: string | undefined;

  try {
    // Order matters: the rate limit gates the body read, not the other way round.
    const resolution = await getOrCreateSession(req, { config });
    cookie = resolution.cookie;
    assertRateLimit(resolution.session.id, { config });

    const body = parseBody(DefenseRequestSchema, await readJsonBody(req, config));

    // Student answers are UNTRUSTED text (hard constraint 1).
    if (body.answers) {
      assertInputSizes(
        Object.fromEntries(
          body.answers.map((answer, i): [string, string] => [`answers[${i}]`, answer]),
        ),
        config,
      );
    }

    const item = await prisma.item.findFirst({
      where: { id: body.itemId, sessionId: resolution.session.id },
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
    });
    if (!item) throw notFound('Item not found in this session.');

    const version = item.versions[0];
    if (!version) throw notFound('Item has no version to defend.');

    const ref: VersionRef = {
      itemId: item.id,
      itemVersionId: version.id,
      stem: version.stem,
      optionsJson: version.optionsJson,
      correctKey: version.correctKey,
    };

    if (!body.answers) {
      const issued = await issueDefenseQuestions(ref);
      const payload: QuestionsResponse = {
        phase: 'questions',
        itemId: ref.itemId,
        itemVersionId: ref.itemVersionId,
        questions: issued.questions,
        state: issued.state,
      };
      return jsonResponse(payload, 200, cookie);
    }

    const scored = await scoreDefenseAnswers(ref, body.answers);
    const payload: ScoredResponse = {
      phase: 'scored',
      itemId: ref.itemId,
      itemVersionId: ref.itemVersionId,
      rubric: scored.rubric,
      outcome: scored.outcome,
      state: scored.state,
    };
    return jsonResponse(payload, 200, cookie);
  } catch (err) {
    return errorResponse(err, cookie);
  }
}
