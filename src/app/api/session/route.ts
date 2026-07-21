/**
 * POST /api/session — create or reset the per-visitor demo session (doc §10)
 * and hand back the preloaded demo challenge that powers "Load demo challenge"
 * (doc §4: the first screen is NOT an empty form).
 *
 * OWNER: Claude (HTTP envelope + demo isolation, both Claude-owned). This route
 * touches no Codex-owned internal — it only resolves a session and copies the
 * seeded demo item, so it is implemented end to end.
 *
 * Isolation contract enforced here:
 *  - the session id lives in an httpOnly cookie; there are no accounts and no PII,
 *  - an expired session is REPLACED (auto-reset), never resurrected,
 *  - every visitor gets their OWN copy of the demo item, so one judge cannot
 *    break another judge's demo (doc §10).
 */
import { z } from 'zod';
import {
  assertRateLimit,
  errorResponse,
  getOrCreateSession,
  jsonResponse,
  loadIsolationConfig,
  parseBody,
  readJsonBody,
} from '@/demo/isolation';
import { fromJson, prisma } from '@/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** `reset: true` abandons the current session and starts a clean one. */
const SessionRequestSchema = z
  .object({
    reset: z.boolean().optional(),
  })
  .strict();

interface DemoItemPayload {
  itemId: string;
  versionId: string;
  versionNumber: number;
  state: string;
  discipline: string;
  provenance: string;
  license: string;
  stem: string;
  options: string[];
  correctKey: string;
  authorRationale: string;
  immutable: boolean;
}

interface SessionResponse {
  sessionId: string;
  pseudonym: string;
  expiresAt: string;
  created: boolean;
  /** null only if the database has not been seeded (`npm run db:seed`). */
  demoItem: DemoItemPayload | null;
}

/**
 * Returns this session's own demo item, cloning the seeded template on first
 * use (doc §10 "datos precargados" + per-visitor isolation).
 *
 * The template is the OLDEST `isDemo` item, which is the one written by
 * prisma/seed.ts before any visitor exists. Every later `isDemo` item is a
 * visitor copy, so ordering by createdAt keeps the template unambiguous.
 */
async function loadDemoItemForSession(sessionId: string): Promise<DemoItemPayload | null> {
  const owned = await prisma.item.findFirst({
    where: { sessionId, isDemo: true },
    orderBy: { createdAt: 'asc' },
    include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
  });
  if (owned) {
    const version = owned.versions[0];
    return version ? toPayload(owned, version) : null;
  }

  const template = await prisma.item.findFirst({
    where: { isDemo: true },
    orderBy: { createdAt: 'asc' },
    include: { versions: { orderBy: { versionNumber: 'asc' }, take: 1 } },
  });
  const templateVersion = template?.versions[0];
  if (!template || !templateVersion) return null;

  // Clone as a fresh DRAFT at version 1: the visitor repairs their own copy.
  const item = await prisma.item.create({
    data: {
      sessionId,
      discipline: template.discipline,
      provenance: template.provenance,
      license: template.license,
      isDemo: true,
      state: 'DRAFT',
    },
  });
  const version = await prisma.itemVersion.create({
    data: {
      itemId: item.id,
      versionNumber: 1,
      stem: templateVersion.stem,
      optionsJson: templateVersion.optionsJson,
      correctKey: templateVersion.correctKey,
      authorRationale: templateVersion.authorRationale,
      immutable: false,
    },
  });
  const linked = await prisma.item.update({
    where: { id: item.id },
    data: { currentVersionId: version.id },
  });

  return toPayload(linked, version);
}

function toPayload(
  item: { id: string; state: string; discipline: string; provenance: string; license: string },
  version: {
    id: string;
    versionNumber: number;
    stem: string;
    optionsJson: string;
    correctKey: string;
    authorRationale: string;
    immutable: boolean;
  },
): DemoItemPayload {
  return {
    itemId: item.id,
    versionId: version.id,
    versionNumber: version.versionNumber,
    state: item.state,
    discipline: item.discipline,
    provenance: item.provenance,
    license: item.license,
    stem: version.stem,
    options: fromJson<string[]>(version.optionsJson),
    correctKey: version.correctKey,
    authorRationale: version.authorRationale,
    immutable: version.immutable,
  };
}

export async function POST(req: Request): Promise<Response> {
  const config = loadIsolationConfig();
  let cookie: string | undefined;

  try {
    // This is the one route where the body is read BEFORE the session resolves:
    // `reset` decides whether the cookie is honoured at all. The raw body is
    // still size-capped inside readJsonBody, so nothing large is parsed first.
    const body = parseBody(SessionRequestSchema, await readJsonBody(req, config));

    const resolution = await getOrCreateSession(req, { forceReset: body.reset === true, config });
    cookie = resolution.cookie;

    assertRateLimit(resolution.session.id, { config });

    const payload: SessionResponse = {
      sessionId: resolution.session.id,
      pseudonym: resolution.session.pseudonym,
      expiresAt: resolution.session.expiresAt.toISOString(),
      created: resolution.created,
      demoItem: await loadDemoItemForSession(resolution.session.id),
    };
    return jsonResponse(payload, 200, cookie);
  } catch (err) {
    return errorResponse(err, cookie);
  }
}
