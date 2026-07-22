/**
 * POST /api/item — create a visitor's OWN blank item to author from scratch
 * (doc §3/§4). Onboarding is repair-first, so this is the second door: after the
 * demo challenge, a visitor unlocks authoring from scratch, and the studio then
 * submits the item they create here to the gauntlet exactly like any other item.
 *
 * OWNER: Claude, end to end. This route touches NO Codex-owned internal — it only
 * resolves a session and writes a DRAFT Item + its v1 ItemVersion, so it is
 * implemented in full (the same shape as POST /api/session).
 *
 * ---------------------------------------------------------------------------
 * PUBLICATION RULES (doc §9, hard constraint 5) — why the defaults matter
 * ---------------------------------------------------------------------------
 * A visitor original is PRIVATE and EPHEMERAL. It must NOT silently inherit
 * CC-BY, and it must NOT be publication-eligible: only team-authored items are
 * ever published under CC-BY. So the Item is created with:
 *   - isTeamAuthored      = false
 *   - publicationEligible = false
 *   - license             = the schema default ("unlicensed-ephemeral")
 * The license is left to the Prisma schema default deliberately — hard-coding
 * "CC-BY" here would be the exact bug the default exists to prevent.
 *
 * ISOLATION (doc §10): the item is owned by the caller's session and by nothing
 * else. Another visitor can never see it — the gauntlet/repair/passport routes
 * all scope their `findFirst` by `sessionId`, so a fresh DRAFT written here is
 * loadable there only within the same session.
 *
 * ZERO PII (hard constraint 8): the only author-facing field in the whole system
 * is the random pseudonym on /api/session. Nothing identifying is read, written
 * or returned here.
 */
import { z } from 'zod';
import {
  assertInputSizes,
  assertRateLimit,
  errorResponse,
  getOrCreateSession,
  jsonResponse,
  loadIsolationConfig,
  parseBody,
  readJsonBody,
} from '@/demo/isolation';
import { prisma, toJson } from '@/db/client';
import { DisciplineIdSchema } from '@/core/disciplines';

/**
 * Option letters, index-aligned: 'A' -> options[0], 'B' -> options[1], … The
 * same set the repair route uses, so a from-scratch item and its repairs share
 * one key convention.
 */
const OPTION_KEYS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;

const CreateItemRequestSchema = z
  .object({
    stem: z.string().min(1),
    options: z.array(z.string().min(1)).min(2).max(OPTION_KEYS.length),
    correctKey: z.enum(OPTION_KEYS),
    authorRationale: z.string().min(1),
    discipline: DisciplineIdSchema,
  })
  .strict()
  // The key must actually index one of the supplied options: 'D' with three
  // options is a silently unanswerable item, not a valid draft. Rejected as a
  // typed 400 before any row is written.
  .refine((v) => OPTION_KEYS.indexOf(v.correctKey) < v.options.length, {
    message: 'correctKey must point at one of the supplied options',
    path: ['correctKey'],
  });

export type CreateItemRequest = z.infer<typeof CreateItemRequestSchema>;

/**
 * Provenance note for a visitor original. Carries NO positioning claim and NO
 * PII — it records only that the item is a from-scratch, ephemeral draft.
 */
const VISITOR_PROVENANCE = 'visitor-authored original (ephemeral, not for publication)';

/**
 * The item payload the studio drops straight into its existing item state — the
 * SAME shape /api/session returns for a demo item, so the "author from scratch"
 * path and the "load demo challenge" path are interchangeable on the client.
 */
export interface CreatedItemPayload {
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

/** Shape the created Item + v1 ItemVersion into the studio's item payload. */
export function toItemPayload(
  item: { id: string; state: string; discipline: string; provenance: string; license: string },
  version: {
    id: string;
    versionNumber: number;
    stem: string;
    correctKey: string;
    authorRationale: string;
    immutable: boolean;
  },
  options: string[],
): CreatedItemPayload {
  return {
    itemId: item.id,
    versionId: version.id,
    versionNumber: version.versionNumber,
    state: item.state,
    // Validate at the DB->domain boundary, exactly as /api/session does: a row
    // with an unknown discipline is surfaced here, never shipped to the client.
    discipline: DisciplineIdSchema.parse(item.discipline),
    provenance: item.provenance,
    license: item.license,
    stem: version.stem,
    options,
    correctKey: version.correctKey,
    authorRationale: version.authorRationale,
    immutable: version.immutable,
  };
}

/**
 * The real handler. `POST` (route.ts) is a thin wrapper so Next.js gets the
 * signature it expects. Prisma is the only external dependency; tests mock it.
 */
export async function handleCreateItem(req: Request): Promise<Response> {
  const config = loadIsolationConfig();
  let cookie: string | undefined;

  try {
    // Order matches every sibling route: resolve the session (which charges the
    // per-address and creation budgets), then the per-session rate limit, then
    // read and validate the body.
    const resolution = await getOrCreateSession(req, { config });
    cookie = resolution.cookie;
    assertRateLimit(resolution.session.id, { config });

    const body = parseBody(CreateItemRequestSchema, await readJsonBody(req, config));

    // UNTRUSTED text (hard constraint 1): size-limit every field before it can
    // ever reach a reviewer prompt.
    assertInputSizes(
      {
        stem: body.stem,
        authorRationale: body.authorRationale,
        ...Object.fromEntries(
          body.options.map((opt, i): [string, string] => [`options[${i}]`, opt]),
        ),
      },
      config,
    );

    // A visitor original: owned by this session, DRAFT, non-demo, and — per the
    // publication rules above — not team-authored, not publication-eligible, and
    // left on the schema's non-committal license default (NOT CC-BY).
    const item = await prisma.item.create({
      data: {
        sessionId: resolution.session.id,
        discipline: body.discipline,
        provenance: VISITOR_PROVENANCE,
        isDemo: false,
        isTeamAuthored: false,
        publicationEligible: false,
        state: 'DRAFT',
      },
    });

    // v1 of a from-scratch item: mutable, so it can still be edited before the
    // gauntlet and repaired after. A repair later creates v2 as a new version.
    const version = await prisma.itemVersion.create({
      data: {
        itemId: item.id,
        versionNumber: 1,
        stem: body.stem,
        optionsJson: toJson(body.options),
        correctKey: body.correctKey,
        authorRationale: body.authorRationale,
        immutable: false,
      },
    });

    // Wire the current-version pointer so the gauntlet/repair routes load this
    // version as the item's head.
    await prisma.item.update({
      where: { id: item.id },
      data: { currentVersionId: version.id },
    });

    const payload = toItemPayload(item, version, body.options);
    return jsonResponse(payload, 200, cookie);
  } catch (err) {
    return errorResponse(err, cookie);
  }
}
