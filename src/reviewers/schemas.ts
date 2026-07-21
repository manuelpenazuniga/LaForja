/**
 * LA FORJA — Zod schemas for every reviewer evidence contract (doc §6.2).
 *
 * OWNER: Claude (contracts/structure). These schemas are the machine-checkable
 * form of the evidence contracts. Every model output is validated against one of
 * them (hard constraint 3). The reviewer CALLS that produce these objects are
 * Codex-owned (see ambiguity.ts / discipline.ts / distractors.ts).
 *
 * Fixture tests (valid + invalid per reviewer) live in tests/schemas.test.ts.
 */
import { z } from 'zod';
import { RUBRIC_DIMENSIONS } from '../core/types';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/**
 * Evidence-bearing text. Whitespace is NOT evidence: a payload carrying " " for
 * an excerpt, an evidence line or a relevance note is an empty claim wearing a
 * string's clothes, and it would pass a bare `.min(1)`. Trimming happens BEFORE
 * the length check, so the parsed output is the trimmed text.
 */
const evidenceText = z.string().trim().min(1);

/**
 * Free text that must be non-blank but whose ORIGINAL spacing is preserved in
 * the parsed output (used where the raw string is compared or displayed
 * verbatim, e.g. the two ambiguity answers).
 */
const nonBlankText = z
  .string()
  .min(1)
  .refine((v) => v.trim().length > 0, { message: 'must not be blank' });

/**
 * Normalization used ONLY for equality comparisons: trim, collapse internal
 * whitespace, case-fold. The original strings are always kept in the output —
 * we normalize to decide whether two payload fields say the same thing, never
 * to rewrite what the reviewer actually produced.
 */
function normalizeForComparison(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

// --- Ambiguity: valid ONLY if answer_a !== answer_b (doc §6.2) --------------
// An ambiguity attack is a counterexample: two defensible readings of the same
// stem that yield DIFFERENT answers. `"A"` vs `" A "` is the same answer typed
// twice, and two identical interpretations are not two readings — both are
// rejected under `normalizeForComparison`.
export const AmbiguitySchema = z
  .object({
    interpretation_a: nonBlankText,
    interpretation_b: nonBlankText,
    answer_a: nonBlankText,
    answer_b: nonBlankText,
    evidence: evidenceText,
  })
  .refine((v) => normalizeForComparison(v.answer_a) !== normalizeForComparison(v.answer_b), {
    message: 'Ambiguity attack is valid only if answer_a !== answer_b (whitespace/case-insensitive)',
    path: ['answer_b'],
  })
  .refine(
    (v) =>
      normalizeForComparison(v.interpretation_a) !== normalizeForComparison(v.interpretation_b),
    {
      message: 'the two interpretations must differ; one reading is not an ambiguity',
      path: ['interpretation_b'],
    },
  );
export type Ambiguity = z.infer<typeof AmbiguitySchema>;

// --- Citation: required for a `correct` discipline verdict (doc §6.2) --------
export const CitationSchema = z.object({
  source_id: nonBlankText,
  version_date: nonBlankText,
  license: nonBlankText,
  excerpt: evidenceText,
  relevance: evidenceText,
});
export type Citation = z.infer<typeof CitationSchema>;

/**
 * Structured artifact of a BOUNDED SOLVER run (doc §6.2: verification by
 * "cálculo reproducible/solver acotado"). `problem_kind` mirrors
 * `ProbabilityProblem['kind']` in src/solver/probability.ts (Codex-owned);
 * `computed_value` is the EXACT rational answer as a string ("1/11", "0", "1"),
 * never a lossy decimal.
 */
export const SolverProofSchema = z.object({
  problem_kind: z.enum(['conditional', 'combinatoric', 'basic']),
  inputs: z.record(z.union([z.string(), z.number(), z.boolean()])),
  computed_value: z
    .string()
    .trim()
    .regex(/^-?\d+(?:\/\d+)?$/, 'computed_value must be an exact fraction, e.g. "1/11"')
    .refine((v) => !/\/0+$/.test(v), { message: 'denominator must not be zero' }),
  steps: z.array(evidenceText).min(1),
  solver_version: nonBlankText,
});
export type SolverProof = z.infer<typeof SolverProofSchema>;

// --- Discipline (probability only): no sufficient source ⇒ never `correct` --
/**
 * Evidence rule, and why it is asymmetric (auditable judgment call):
 *
 *  - `correct`     REQUIRES a complete citation. This is the literal §6.2 rule:
 *                  "sin fuente suficiente → unverified, nunca correct". Asserting
 *                  that an item IS right is a conceptual claim about the domain,
 *                  and only a licensed source can ground it.
 *  - `incorrect`   REQUIRES a citation OR a recorded `solver_proof`. A bounded
 *                  solver CAN falsify a numeric answer without any conceptual
 *                  source — computing 1/11 where the item claims 1/2 is a proof
 *                  of falsity on its own. But that is only true if the proof is
 *                  actually RECORDED and re-executable; an unbacked "incorrect"
 *                  is just "el modelo dijo", which §6.2 says is never final
 *                  evidence. `solver_proof` is what forces the recording.
 *  - `unverified`  permits both to be null: that is exactly what it means.
 */
export const DisciplineSchema = z
  .object({
    claim: evidenceText,
    verdict: z.enum(['correct', 'incorrect', 'unverified']),
    citation: CitationSchema.nullable(),
    /** Recorded bounded-solver run, when the verdict is solver-grounded. */
    solver_proof: SolverProofSchema.nullable().optional(),
  })
  .refine((v) => v.verdict !== 'correct' || v.citation !== null, {
    message: "verdict 'correct' requires a full citation; no source ⇒ 'unverified'",
    path: ['citation'],
  })
  .refine((v) => v.verdict !== 'incorrect' || v.citation !== null || v.solver_proof != null, {
    message:
      "verdict 'incorrect' requires a full citation or a recorded solver_proof; otherwise 'unverified'",
    path: ['solver_proof'],
  });
export type Discipline = z.infer<typeof DisciplineSchema>;

// --- Distractor: no evidence ⇒ label 'hypothesis' (doc §6.2) ----------------
export const DistractorSchema = z
  .object({
    distractor: nonBlankText,
    hypothesized_error: evidenceText,
    confidence: z.number().min(0).max(1),
    evidence: evidenceText.optional(),
    label: z.enum(['evidenced', 'hypothesis']),
  })
  .refine((v) => (v.evidence ? true : v.label === 'hypothesis'), {
    message: "a distractor finding without evidence must be labeled 'hypothesis'",
    path: ['label'],
  })
  .refine((v) => (v.label === 'evidenced' ? Boolean(v.evidence) : true), {
    message: "label 'evidenced' requires an evidence string",
    path: ['evidence'],
  });
export type Distractor = z.infer<typeof DistractorSchema>;

/**
 * §6.2 specifies a distractor -> hypothesized-error MAP, not a lone finding.
 * The map is the reviewer's actual return shape; a distractor may appear at most
 * once in it (two competing hypotheses for the same option are one finding with
 * one confidence, not two rows). The orchestrator then maps each entry of the
 * map to one Check row, which is why the single-finding schema stays exported.
 */
export const DistractorMapSchema = z
  .array(DistractorSchema)
  .min(1)
  .superRefine((findings, ctx) => {
    const seen = new Set<string>();
    findings.forEach((finding, index) => {
      const key = normalizeForComparison(finding.distractor);
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate distractor key: ${finding.distractor}`,
          path: [index, 'distractor'],
        });
      }
      seen.add(key);
    });
  });
export type DistractorMap = z.infer<typeof DistractorMapSchema>;

// --- Deterministic cue probe (doc §7.3) -------------------------------------
export const ItemProbeSchema = z.object({
  answer_length_flag: z.boolean(),
  lexical_overlap_flag: z.boolean(),
  answer_length_ratio: z.number(),
  lexical_overlap_score: z.number().min(0).max(1),
});
export type ItemProbe = z.infer<typeof ItemProbeSchema>;

// --- Defense rubric (doc §6.3): 3 dims × 0-2, textual evidence each ----------
export const RubricDimensionSchema = z.object({
  dimension: z.enum(['identifies_error', 'explains_uniqueness', 'answers_variation']),
  score: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  evidence: evidenceText,
});

/** Publication threshold (doc §6.3): ≥4/6 with no dimension at 0. */
export const RUBRIC_PASS_TOTAL = 4;

/**
 * Rubric integrity (doc §6.3). Without these refinements a forged rubric —
 * three copies of `identifies_error` scoring 0/2/2, total 6, outcome "passed" —
 * is schema-valid while breaking every rule the rubric exists to enforce.
 *
 *  - the three dimensions must be exactly the three observable dimensions, each
 *    present once (exhaustive, no duplicates);
 *  - `total` must equal the sum of the three scores (it is a derived field, not
 *    an independent assertion);
 *  - `outcome` must agree with the threshold: "passed" iff total ≥ 4 AND no
 *    dimension scored 0, otherwise "failed". "inconclusive" is EXEMPT — per
 *    §6.3 it means the EVALUATOR failed, so the scores describe nothing and the
 *    threshold cannot be applied; a run that wants to claim a pass must say
 *    "passed" and satisfy the threshold.
 */
export const DefenseRubricSchema = z
  .object({
    dimensions: z.tuple([RubricDimensionSchema, RubricDimensionSchema, RubricDimensionSchema]),
    total: z.number().int().min(0).max(6),
    outcome: z.enum(['passed', 'failed', 'inconclusive']),
  })
  .superRefine((rubric, ctx) => {
    const keys = rubric.dimensions.map((d) => d.dimension);
    const unique = new Set(keys);
    const coversAll =
      unique.size === keys.length && RUBRIC_DIMENSIONS.every((key) => unique.has(key));
    if (!coversAll) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `dimensions must cover each of ${RUBRIC_DIMENSIONS.join(', ')} exactly once`,
        path: ['dimensions'],
      });
    }

    const sum = rubric.dimensions.reduce((acc, d) => acc + d.score, 0);
    if (rubric.total !== sum) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `total must equal the sum of the dimension scores (${sum})`,
        path: ['total'],
      });
    }

    if (rubric.outcome === 'inconclusive') return;
    const meetsThreshold = sum >= RUBRIC_PASS_TOTAL && rubric.dimensions.every((d) => d.score > 0);
    const expected = meetsThreshold ? 'passed' : 'failed';
    if (rubric.outcome !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `outcome must be '${expected}': threshold is >= ${RUBRIC_PASS_TOTAL}/6 with no dimension at 0`,
        path: ['outcome'],
      });
    }
  });
export type DefenseRubricParsed = z.infer<typeof DefenseRubricSchema>;

// --- Adaptive defense questions (doc §6.3): exactly 2 ------------------------
export const DefenseQuestionsSchema = z
  .array(z.object({ id: nonBlankText, prompt: evidenceText }))
  .length(2);
export type DefenseQuestions = z.infer<typeof DefenseQuestionsSchema>;

/**
 * Registry so the orchestrator/adjudicator can look a schema up by reviewer
 * type. Keyed by ReviewerType and holding the PER-FINDING schemas, because the
 * orchestrator turns one finding into one Check row.
 */
export const REVIEWER_SCHEMAS = {
  ambiguity: AmbiguitySchema,
  discipline: DisciplineSchema,
  distractor: DistractorSchema,
  item_probe: ItemProbeSchema,
} as const;

/**
 * Whole-response schemas for the reviewers whose §6.2 contract is a collection
 * rather than a single finding. Validate the model response with these, then
 * validate/expand each entry through REVIEWER_SCHEMAS.
 */
export const REVIEWER_RESPONSE_SCHEMAS = {
  distractor: DistractorMapSchema,
} as const;
