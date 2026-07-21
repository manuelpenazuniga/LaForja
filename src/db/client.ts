/**
 * LA FORJA — Prisma client singleton + JSON boundary helpers.
 *
 * OWNER: Claude (infrastructure). JSON columns are stored as stringified text
 * (see prisma/schema.prisma). Always cross the boundary through `toJson`/`fromJson`
 * so serialization is consistent and greppable.
 *
 * NOTE: `@prisma/client` is generated — run `npm run db:generate` before typecheck.
 */
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.prisma ?? new PrismaClient();

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
