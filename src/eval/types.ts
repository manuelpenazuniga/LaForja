/**
 * LA FORJA — labeled smoke set types (doc §8).
 *
 * NAMING RULE (mandatory): this is a "labeled smoke set", NEVER a "gold set".
 * "Gold" is reserved for independent labels. These items are AUTHOR-LABELED:
 * the same team designed the defects and the labels. That is declared per file.
 *
 * OWNER: Claude (structure + fixtures format). The runner is Codex.
 */
import { z } from 'zod';

export const SMOKE_CATEGORIES = [
  'clean', // 4 items: no intended defect (measures FALSE POSITIVES)
  'ambiguous', // 4 items: two readings ⇒ two answers
  'factual_error', // 4 items: the marked answer is wrong (has a source)
  'cue_leak', // 4 items: length/lexical cue or weak distractors
] as const;
export type SmokeCategory = (typeof SMOKE_CATEGORIES)[number];

/**
 * Every free-text, evidence-bearing string is trimmed before the length check,
 * so a whitespace-only value cannot masquerade as content. `.trim()` here is a
 * Zod TRANSFORM: the parsed item carries the trimmed string.
 */
const NonBlank = z.string().trim().min(1);

const IntendedDefectSchema = z.object({
  type: z.enum(['ambiguity', 'factual_error', 'cue_leak', 'weak_distractor']),
  description: NonBlank,
  expected_finding: NonBlank,
  /** For factual_error: the answer the bounded solver should produce. */
  true_answer: NonBlank.nullable().optional(),
});

/** Licensed source, required for factual_error items (doc §8). */
const SourceSchema = z.object({
  source_id: NonBlank,
  version_date: NonBlank,
  license: NonBlank,
  excerpt: NonBlank,
  relevance: NonBlank,
});

const SmokeItemBaseSchema = z.object({
  _license: NonBlank, // CC-BY header, per file (doc §9)
  _attribution: NonBlank,
  id: NonBlank,
  author_labeled: z.literal(true), // declared, always (doc §8)
  split: z.enum(['dev', 'holdout']), // dev items are NOT reported as evaluation
  category: z.enum(SMOKE_CATEGORIES),
  discipline: z.literal('probability'),
  stem: NonBlank,
  options: z.array(NonBlank).min(3),
  correct_key: NonBlank, // the key the AUTHOR marked (may be wrong for factual_error)
  author_rationale: NonBlank,
  /** null for `clean`; otherwise what the gauntlet is expected to find. */
  intended_defect: IntendedDefectSchema.nullable(),
  source: SourceSchema.nullable(),
});

/**
 * The labeled-set COMPOSITION is part of the contract, not a convention. Without
 * these refinements the schema accepts items that silently break the eval: a
 * `factual_error` with no source and no true_answer gives the bounded solver
 * nothing to check, and a `clean` item carrying an intended_defect corrupts the
 * false-positive count — the one number the `clean` bucket exists to produce.
 */
export const SmokeItemSchema = SmokeItemBaseSchema.superRefine((item, ctx) => {
  if (item.category === 'clean') {
    if (item.intended_defect !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['intended_defect'],
        message: 'category "clean" requires intended_defect === null (it measures FALSE POSITIVES)',
      });
    }
    return;
  }

  // Every non-clean category must declare what the gauntlet is expected to find.
  if (item.intended_defect === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['intended_defect'],
      message: `category "${item.category}" requires a non-null intended_defect`,
    });
  }

  if (item.category === 'factual_error') {
    if (item.source === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['source'],
        message: 'category "factual_error" requires a non-null licensed source (doc §8)',
      });
    }
    if (item.intended_defect !== null && item.intended_defect.true_answer == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['intended_defect', 'true_answer'],
        message:
          'category "factual_error" requires intended_defect.true_answer (the answer the bounded solver must produce)',
      });
    }
  }
});
export type SmokeItem = z.infer<typeof SmokeItemSchema>;

/** The three eval configurations, each run 3 times with identical settings (doc §8). */
export const EVAL_CONFIGS = ['general-reviewer', 'gauntlet', 'gauntlet-no-adjudication'] as const;
export type EvalConfig = (typeof EVAL_CONFIGS)[number];

export const RUNS_PER_CONFIG = 3;

/** 1..3, constrained at the type level so a 4th run cannot be recorded. */
export type RunIndex = 1 | 2 | 3;

/**
 * Settings doc §8 requires to be IDENTICAL across the 3 runs of a config
 * ("identical model, reasoning, context and budget"). Recording
 * them in every artifact is what lets a reader PROVE the runs were comparable
 * instead of taking our word for it; a diff across the 3 reports of a config
 * must be empty for these fields.
 */
export interface EvalRunSettings {
  /** Reasoning effort passed to the model, identical across the 3 runs. */
  reasoningEffort: 'low' | 'medium' | 'high';
  /** What context the reviewers were given. */
  contextMode: 'item-only' | 'item-plus-corpus';
  /** Per-item budget ceiling the run was held to. */
  budget: {
    maxTokensPerItem: number;
    maxCallsPerItem: number;
  };
}

/**
 * Every distinct model ID actually used in a run — compliance evidence.
 *
 * A single `modelId` was wrong: a `gauntlet` run uses a reviewer model AND an
 * adjudicator model, so one field could only ever record half the truth, and
 * the write gate could only ever check half of it. `adjudicator` is null for
 * the configs that perform no adjudication ('general-reviewer',
 * 'gauntlet-no-adjudication').
 */
export interface EvalModelIds {
  reviewer: string;
  adjudicator: string | null;
}

/**
 * Report shape — EXACT COUNTS, never grandiose percentages (doc §8).
 * "found 13 of 16 defects in run 1, 14 in runs 2 and 3..."
 */
export interface EvalReport {
  config: EvalConfig;
  runIndex: RunIndex;
  /** Exact model IDs used, by role (compliance evidence). */
  modelIds: EvalModelIds;
  /**
   * Flat, deduplicated list of EVERY model ID used in this run. The compliance
   * gate iterates this, so it stays correct if more roles are added later —
   * it must always agree with `modelIds`.
   */
  allModelIds: string[];
  /** Identical across the 3 runs of a config; proves comparability (doc §8). */
  settings: EvalRunSettings;
  promptHash: string;
  timestamp: string;
  split: 'dev' | 'holdout';
  counts: {
    itemsEvaluated: number;
    defectsPlanted: number;
    defectsFound: number; // exact count
    falsePositivesOnClean: number; // findings on `clean` items
    citationsChecked: number;
    citationsPrecise: number; // citation precision numerator
    schemaValid: number;
    schemaTotal: number;
  };
  latencyMs: { p50: number; p95: number };
  costUsdPerItem: number;
  /** Raw model outputs, kept as evidence. */
  raw: unknown[];
}
