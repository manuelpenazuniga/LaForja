/**
 * LA FORJA — Prisma client singleton + JSON boundary helpers.
 *
 * OWNER: Claude (infrastructure). JSON columns are stored as stringified text
 * (see prisma/schema.prisma). Always cross the boundary through `toJson`/`fromJson`
 * so serialization is consistent and greppable.
 *
 * ---------------------------------------------------------------------------
 * TWO CONNECTORS, ONE SELECTOR
 * ---------------------------------------------------------------------------
 * Serverless (Vercel) cannot use a SQLite FILE: its filesystem is read-only and
 * per-instance, so writes are lost or diverge across instances — which would
 * break the demo-isolation guarantee that "a judge cannot break another judge's
 * demo" (doc §10). Production therefore talks to Turso (hosted libSQL) over the
 * network through Prisma's libSQL driver adapter.
 *
 * The selector is the PRESENCE of `TURSO_DATABASE_URL`, and nothing else:
 *   - set   -> the Turso adapter (production, Vercel)
 *   - unset -> the default SQLite-file connector via `DATABASE_URL`
 *              (local development, and every test — the temp-file harness in
 *               tests/helpers/testDb.ts never sets TURSO_*, so it is untouched)
 * The datasource in schema.prisma stays `sqlite` in both cases; only the wire
 * underneath it changes. That is the whole reason Turso was chosen over Postgres.
 *
 * NOTE: `@prisma/client` is generated with the `driverAdapters` preview feature —
 * run `npm run db:generate` before typecheck.
 */
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Build the production Prisma client backed by Turso. Kept in its own function so
 * the libSQL packages are required ONLY when a Turso URL is actually configured —
 * local dev and tests never load them.
 */
function createTursoClient(url: string, authToken: string | undefined): PrismaClient {
  // Local requires so the import cost is paid only on the production path.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PrismaLibSQL } = require('@prisma/adapter-libsql') as typeof import('@prisma/adapter-libsql');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createClient } = require('@libsql/client') as typeof import('@libsql/client');

  const libsql = createClient({ url, authToken });
  const adapter = new PrismaLibSQL(libsql);
  return new PrismaClient({ adapter });
}

function createPrismaClient(): PrismaClient {
  const tursoUrl = process.env.TURSO_DATABASE_URL;
  if (tursoUrl && tursoUrl.length > 0) {
    return createTursoClient(tursoUrl, process.env.TURSO_AUTH_TOKEN);
  }
  // Local / test: the default SQLite-file connector reads DATABASE_URL.
  return new PrismaClient();
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/** Serialize a value for a `...Json` column. */
export function toJson(value: unknown): string {
  return JSON.stringify(value);
}

/** Parse a `...Json` column back into a typed value. Caller supplies T. */
export function fromJson<T>(text: string): T {
  return JSON.parse(text) as T;
}
