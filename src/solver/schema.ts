/**
 * LA FORJA — wire-format problem schema (doc §5).
 *
 * The persisted / re-executable problem shape. `discipline` DEFAULTS to
 * 'probability' so every historical Turso contract and existing fixture — which
 * store a probability problem with NO discipline field — still parses and
 * re-runs identically. This default is MANDATORY and has its own test.
 *
 * `kind` validity is intentionally NOT enforced here: an unknown (discipline,
 * kind) pair becomes { supported: false } at solve() time, which the history
 * re-run reports as 'inconclusive' (fail-closed), never as a pass. Enforcing
 * kinds in the schema instead would duplicate the solver's own scope and drift
 * from it.
 */
import { z } from 'zod';
import { DisciplineIdSchema } from '../core/disciplines';
import type { Problem } from './types';

export const ProblemSchema: z.ZodType<Problem> = z.object({
  discipline: DisciplineIdSchema.default('probability'),
  kind: z.string().min(1),
  params: z.record(z.union([z.number(), z.string(), z.boolean()])),
}) as unknown as z.ZodType<Problem>;
