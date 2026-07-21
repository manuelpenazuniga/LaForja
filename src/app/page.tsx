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
 * Team-authored, CC-BY, zero DEMRE content. The two-children problem: the author
 * marks 1/3 reading "at least one is male", but the stem does not disambiguate,
 * so the reading "a specific child is male" yields 1/2. Two readings, two answers.
 *
 * This literal is the render fallback only. TODO(codex): replace it with a real
 * read of the seeded demo item (prisma via src/db/client.ts, or GET /api/session)
 * so the page always renders the row that the rest of the run writes against.
 */
const DEMO_FIXTURE: StudioItem = {
  id: 'demo-local',
  versionNumber: 1,
  stem: 'Una familia tiene dos hijos. Se sabe que uno de ellos es varón. ¿Cuál es la probabilidad de que ambos sean varones?',
  options: ['1/4', '1/3', '1/2', '2/3'],
  correctKey: 'B',
  authorRationale:
    'Con la lectura "al menos uno es varón", el espacio se reduce a {VV, VM, MV} y solo VV es favorable, de modo que P = 1/3. Los distractores capturan errores reales: 1/4 ignora la información dada, 1/2 corresponde a la lectura en que se fija un hijo concreto, 2/3 invierte el cociente.',
};

export default function Page() {
  const models = loadModelConfig();

  return (
    <StudioClient
      reviewerModel={models.reviewerModel}
      adjudicatorModel={models.adjudicatorModel}
      modelCompliant={models.compliance}
      demoFixture={DEMO_FIXTURE}
    />
  );
}
