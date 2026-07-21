/**
 * GET /api/passport/[itemId] — the item passport (doc §6.4, slice item 7).
 *
 * READ-ONLY. This endpoint never mutates anything: the passport is the frozen,
 * auditable trace of an item, and the public commons is a read-only snapshot
 * (doc §10). It is therefore readable across sessions — a judge can open a
 * passport link without touching the owner's demo state.
 *
 * ITEM-LEVEL ONLY (doc §6.4): the passport certifies the item's process, never
 * the person. The only author field is a random pseudonym; there is no school,
 * city, name, email or age anywhere in the payload (hard constraint 8).
 *
 * OWNER SPLIT:
 *  - Claude (this file, done): session resolution, rate limit, param validation,
 *    existence check, typed errors.
 *  - Codex: `buildPassport` in src/passport/passport.ts.
 */
import { z } from 'zod';
import {
  assertRateLimit,
  errorResponse,
  getOrCreateSession,
  jsonResponse,
  loadIsolationConfig,
  notFound,
  parseBody,
} from '@/demo/isolation';
import { prisma } from '@/db/client';
import { buildPassport } from '@/passport/passport';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({
  itemId: z.string().min(1).max(64),
});

export async function GET(
  req: Request,
  context: { params: { itemId: string } },
): Promise<Response> {
  const config = loadIsolationConfig();
  let cookie: string | undefined;

  try {
    const params = parseBody(ParamsSchema, context.params);

    // A session is still resolved so the read is rate limited per visitor
    // (doc §10) — it grants no privilege, the passport is public by design.
    const resolution = await getOrCreateSession(req, { config });
    cookie = resolution.cookie;
    assertRateLimit(resolution.session.id, { config });

    const item = await prisma.item.findUnique({
      where: { id: params.itemId },
      select: { id: true },
    });
    if (!item) throw notFound('Item not found.');

    // TODO(codex): assemble and return the passport.
    //  - Call `buildPassport(params.itemId)` (src/passport/passport.ts).
    //  - It reads the Item, its version history with diffs, the ACCEPTED attacks
    //    with their counterexamples, the history re-run results BY CHECK CLASS,
    //    the discipline verdict with its full citation or `unverified`, and the
    //    defense rubric (or `inconclusive`).
    //  - Author = the owning session's pseudonym. No other author field exists.
    //  - Read-only here: if a frozen Passport snapshot row already exists, return
    //    it verbatim (published passports are immutable); only assemble a live
    //    view when the item is not yet published. Never write from this route.
    //  Reference: doc §6.4.
    const passport = await buildPassport(params.itemId);

    return jsonResponse(passport, 200, cookie);
  } catch (err) {
    return errorResponse(err, cookie);
  }
}
