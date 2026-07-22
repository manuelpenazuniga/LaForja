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
import { DisciplineIdSchema } from '@/core/disciplines';

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
  /**
   * The visitor's own copy of the PROBABILITY demo — kept for back-compat so the
   * landing "Load demo challenge" works even for a client that ignores the list.
   * null only if the database has not been seeded (`npm run db:seed`).
   */
  demoItem: DemoItemPayload | null;
  /**
   * The visitor's own copy of the demo for EVERY seeded discipline, one per
   * discipline, so the studio's topic selector can switch between them. Ordered
   * to match `DISCIPLINES` (probability first).
   */
  demoItems: DemoItemPayload[];
}

/**
 * A seeded demo TEMPLATE is the team-authored original written by prisma/seed.ts
 * (`isTeamAuthored: true`); a visitor's clone (below) never sets that flag, so it
 * is the unambiguous template signal — robust even after many visitor copies of
 * the same discipline exist. One template per discipline; `createdAt` order keeps
 * the list stable (probability was seeded first).
 */
async function loadDemoTemplates() {
  return prisma.item.findMany({
    where: { isDemo: true, isTeamAuthored: true },
    orderBy: { createdAt: 'asc' },
    include: { versions: { orderBy: { versionNumber: 'asc' }, take: 1 } },
  });
}

/**
 * Returns this session's own copy of each seeded discipline demo, cloning the
 * template on first use (doc §10 "datos precargados" + per-visitor isolation).
 * A visitor repairs their OWN copy, so one judge cannot break another's demo.
 */
async function loadDemoItemsForSession(sessionId: string): Promise<DemoItemPayload[]> {
  const templates = await loadDemoTemplates();
  const payloads: DemoItemPayload[] = [];

  for (const template of templates) {
    const templateVersion = template.versions[0];
    if (!templateVersion) continue;

    const owned = await prisma.item.findFirst({
      where: { sessionId, isDemo: true, discipline: template.discipline },
      orderBy: { createdAt: 'asc' },
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
    });
    if (owned) {
      const ownedVersion = owned.versions[0];
      if (ownedVersion) payloads.push(toPayload(owned, ownedVersion));
      continue;
    }

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
    payloads.push(toPayload(linked, version));
  }

  return payloads;
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
    // Validate at the DB→domain boundary: a demo row with an unknown discipline
    // is a seeding bug, surfaced here rather than shipped to the client.
    discipline: DisciplineIdSchema.parse(item.discipline),
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

    const demoItems = await loadDemoItemsForSession(resolution.session.id);
    const payload: SessionResponse = {
      sessionId: resolution.session.id,
      pseudonym: resolution.session.pseudonym,
      expiresAt: resolution.session.expiresAt.toISOString(),
      created: resolution.created,
      demoItem:
        demoItems.find((item) => item.discipline === 'probability') ?? demoItems[0] ?? null,
      demoItems,
    };
    return jsonResponse(payload, 200, cookie);
  } catch (err) {
    return errorResponse(err, cookie);
  }
}
