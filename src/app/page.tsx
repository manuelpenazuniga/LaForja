/**
 * LA FORJA — the single end-to-end route (doc §3, element 9: one stable link).
 *
 * OWNER: Claude (shell + server-side wiring points only).
 *
 * Server component. It resolves the model IDs from env (never hardcoded, always
 * through src/config/models.ts) and hands the studio the demo challenge. All
 * interaction lives in StudioClient.
 */
import { loadModelConfig } from '@/config/models';

import StudioClient, { type StudioItem } from './StudioClient';

// The model config is read per request, so a changed env is reflected without a
// rebuild and the badge in the masthead always shows what actually ran.
export const dynamic = 'force-dynamic';

/**
 * The seeded demo challenge, mirrored from prisma/seed.ts.
 *
 * Team-authored original, CC-BY. High-school / college probability, the demo
 * discipline for the whole slice. The two-children problem: the author marks 1/3
 * reading "at least one is a boy", but the stem does not disambiguate, so the
 * reading "a specific child is a boy" yields 1/2. Two readings, two answers.
 *
 * This literal is the render fallback used before POST /api/session returns the
 * visitor's isolated database copy. The explicit three-part split is display
 * metadata for the assay-sheet fork; it is never guessed from arbitrary text.
 */
const DEMO_FIXTURE: StudioItem = {
  id: 'demo-local',
  versionNumber: 1,
  stem: 'A family has two children. It is known that one of them is a boy. What is the probability that both children are boys?',
  stemSplit: {
    before: 'A family has two children. It is known that ',
    ambiguous: 'one of them is a boy',
    after: '. What is the probability that both children are boys?',
  },
  options: ['1/4', '1/3', '1/2', '2/3'],
  correctKey: 'B',
  authorRationale:
    'Under the reading "at least one is a boy", the sample space reduces to {BB, BG, GB} and only BB is favourable, so P = 1/3. The distractors capture real errors: 1/4 ignores the given information, 1/2 matches the reading in which one specific child is fixed, 2/3 inverts the ratio.',
};

export default function Page() {
  const models = loadModelConfig();

  return (
    <StudioClient
      reviewerModel={models.reviewerModel}
      adjudicatorModel={models.adjudicatorModel}
      modelCompliant={models.compliance}
      modelCallsAvailable={Boolean(process.env.OPENAI_API_KEY)}
      demoFixture={DEMO_FIXTURE}
    />
  );
}
