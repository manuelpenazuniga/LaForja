/**
 * LA FORJA — discipline IDENTIFIER validation + display labels.
 *
 * OWNER: Claude (contracts/structure). The allowed values live in
 * src/core/types.ts (Zod-free, the single source of truth for the String
 * columns); this module is the ONE place they gain a Zod validator.
 */
import { z } from 'zod';
import { DISCIPLINES } from './types';
import type { DisciplineId } from './types';

/**
 * NAME IS LOAD-BEARING: `DisciplineIdSchema` validates the discipline
 * IDENTIFIER. Do NOT call it `DisciplineSchema` — that name is already the
 * reviewer VERDICT contract in src/reviewers/schemas.ts, and colliding the two
 * is the single most likely merge break.
 */
export const DisciplineIdSchema = z.enum(DISCIPLINES);

export type { DisciplineId };

/**
 * Human-readable label. Only `triangle-similarity` differs from its id (the
 * hyphen is a code/data spelling, not a display one); every other discipline
 * reads the same either way.
 */
export function disciplineLabel(discipline: DisciplineId): string {
  return discipline === 'triangle-similarity' ? 'triangle similarity' : discipline;
}
