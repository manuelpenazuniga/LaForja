/**
 * LA FORJA — evidence-contract fixtures: one VALID and one INVALID case per
 * reviewer contract (doc §6.2, §6.3, §7.3; recording gate §13 question 2).
 *
 * OWNER: Claude. Each contract encodes a product promise, so each promise gets a
 * test that fails when the schema is weakened:
 *  - Ambiguity is an attack ONLY if the two readings yield DIFFERENT answers
 *    (and " A " is the same answer as "A"; whitespace is not a second reading).
 *  - Discipline: no sufficient source ⇒ `unverified`, NEVER `correct`; a bare
 *    source_url is never enough (license + excerpt + version_date required); an
 *    `incorrect` verdict must be grounded by a citation OR a recorded
 *    solver_proof — never by the model's bare assertion.
 *  - Distractor: a finding without evidence must be labeled "hypothesis"; the
 *    reviewer response is a MAP with unique distractor keys.
 *  - Defense rubric: exactly 3 UNIQUE dimensions, scale 0-2, textual evidence
 *    each, total = sum of scores, outcome consistent with the §6.3 threshold.
 *  - Whitespace is never evidence: " " is rejected wherever text is evidence.
 */
import { describe, expect, it } from 'vitest';
import type { ZodIssue } from 'zod';
import {
  AmbiguitySchema,
  CitationSchema,
  DefenseQuestionsSchema,
  DefenseRubricSchema,
  DisciplineSchema,
  DistractorMapSchema,
  DistractorSchema,
  ItemProbeSchema,
  REVIEWER_RESPONSE_SCHEMAS,
  REVIEWER_SCHEMAS,
  RubricDimensionSchema,
  SolverProofSchema,
} from '@/reviewers/schemas';
import { REVIEWER_TYPES, RUBRIC_DIMENSIONS } from '@/core/types';

/** Paths of every issue, flattened to dotted strings, for readable assertions. */
function issuePaths(issues: ZodIssue[]): string[] {
  return issues.map((issue) => issue.path.join('.'));
}

/** Drop one field from a fixture to build the "missing field" invalid case. */
function omit(fixture: Record<string, unknown>, field: string): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...fixture };
  delete clone[field];
  return clone;
}

// Content fixtures use the demo discipline (probability), which is universal in
// high-school and introductory college mathematics.
const FULL_CITATION = {
  source_id: 'forja-corpus/conditional-probability',
  version_date: '2025-07-18',
  license: 'CC-BY-4.0',
  excerpt: 'Conditional probability P(A|B) is defined as P(A ∩ B) / P(B), with P(B) > 0.',
  relevance: 'Fixes the reading "at least one is a boy" as conditioning on an event.',
};

/** A recorded bounded-solver run: what makes a solver-grounded verdict provable. */
const SOLVER_PROOF = {
  problem_kind: 'conditional' as const,
  inputs: { space: 'BB,BG,GB,GG', condition: 'al menos uno es varon', target: 'ambos varones' },
  computed_value: '1/3',
  steps: ['|B| = 3 resultados con al menos un varon', '|A ∩ B| = 1', 'P(A|B) = 1/3'],
  solver_version: 'probability-solver-v1',
};

describe('AmbiguitySchema (counterexample contract)', () => {
  const valid = {
    interpretation_a: 'Al menos uno de los dos hijos es varon.',
    interpretation_b: 'Un hijo especifico (el mayor) es varon.',
    answer_a: '1/3',
    answer_b: '1/2',
    evidence: 'El enunciado "se sabe que uno de ellos es varon" admite ambas lecturas.',
  };

  it('accepts a finding whose two readings yield different answers', () => {
    const result = AmbiguitySchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('REJECTS a finding whose two readings yield the SAME answer (not an attack)', () => {
    const result = AmbiguitySchema.safeParse({ ...valid, answer_b: valid.answer_a });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuePaths(result.error.issues)).toContain('answer_b');
  });

  it('REJECTS answers that differ only by surrounding whitespace (" A " vs "A")', () => {
    const result = AmbiguitySchema.safeParse({ ...valid, answer_a: 'A', answer_b: ' A ' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuePaths(result.error.issues)).toContain('answer_b');
  });

  it('REJECTS answers that differ only by internal whitespace or case', () => {
    expect(
      AmbiguitySchema.safeParse({ ...valid, answer_a: '1 / 3', answer_b: '1  /  3' }).success,
    ).toBe(false);
    expect(
      AmbiguitySchema.safeParse({ ...valid, answer_a: 'Ninguna', answer_b: 'ninguna' }).success,
    ).toBe(false);
  });

  it('REJECTS two identical interpretations (one reading is not an ambiguity)', () => {
    const result = AmbiguitySchema.safeParse({
      ...valid,
      interpretation_b: `  ${valid.interpretation_a.toUpperCase()}  `,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuePaths(result.error.issues)).toContain('interpretation_b');
  });

  it('keeps the ORIGINAL answer strings in the parsed output (normalization is compare-only)', () => {
    const result = AmbiguitySchema.safeParse({ ...valid, answer_b: '  1/2  ' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.answer_b).toBe('  1/2  ');
  });

  it('rejects an empty evidence string', () => {
    const result = AmbiguitySchema.safeParse({ ...valid, evidence: '' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuePaths(result.error.issues)).toContain('evidence');
  });

  it('REJECTS whitespace-only evidence (whitespace is not evidence)', () => {
    const result = AmbiguitySchema.safeParse({ ...valid, evidence: '   ' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuePaths(result.error.issues)).toContain('evidence');
  });

  it('rejects a whitespace-only answer', () => {
    expect(AmbiguitySchema.safeParse({ ...valid, answer_a: ' ' }).success).toBe(false);
  });

  it('rejects a missing interpretation', () => {
    const result = AmbiguitySchema.safeParse(omit(valid, 'interpretation_b'));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuePaths(result.error.issues)).toContain('interpretation_b');
  });

  it('rejects a non-string answer', () => {
    expect(AmbiguitySchema.safeParse({ ...valid, answer_a: 1 / 3 }).success).toBe(false);
  });
});

describe('CitationSchema (a bare source_url is never enough)', () => {
  it('accepts a full citation', () => {
    expect(CitationSchema.safeParse(FULL_CITATION).success).toBe(true);
  });

  it('rejects a citation with only a source URL', () => {
    const result = CitationSchema.safeParse({ source_url: 'https://example.org/probabilidad' });
    expect(result.success).toBe(false);
  });

  for (const field of ['license', 'excerpt', 'version_date'] as const) {
    it(`rejects a citation missing ${field}`, () => {
      const result = CitationSchema.safeParse(omit(FULL_CITATION, field));
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(issuePaths(result.error.issues)).toContain(field);
    });

    it(`rejects a citation with an empty ${field}`, () => {
      const result = CitationSchema.safeParse({ ...FULL_CITATION, [field]: '' });
      expect(result.success).toBe(false);
    });
  }

  for (const field of ['excerpt', 'relevance'] as const) {
    it(`REJECTS a whitespace-only ${field}`, () => {
      const result = CitationSchema.safeParse({ ...FULL_CITATION, [field]: '  \t ' });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(issuePaths(result.error.issues)).toContain(field);
    });
  }
});

describe('SolverProofSchema (recorded bounded-solver run, doc §6.2)', () => {
  const proof = {
    problem_kind: 'conditional',
    inputs: { space: 'BB,BG,GB,GG', condition: 'al menos uno es varon', target: 'ambos varones' },
    computed_value: '1/3',
    steps: ['|B| = 3 resultados con al menos un varon', '|A ∩ B| = 1', 'P(A|B) = 1/3'],
    solver_version: 'probability-solver-v1',
  };

  it('accepts a complete proof with an exact fraction', () => {
    expect(SolverProofSchema.safeParse(proof).success).toBe(true);
  });

  it('rejects a decimal computed_value (the answer must stay exact)', () => {
    const result = SolverProofSchema.safeParse({ ...proof, computed_value: '0.333' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuePaths(result.error.issues)).toContain('computed_value');
  });

  it('rejects a zero denominator', () => {
    expect(SolverProofSchema.safeParse({ ...proof, computed_value: '1/0' }).success).toBe(false);
  });

  it('rejects an empty step list and whitespace-only steps', () => {
    expect(SolverProofSchema.safeParse({ ...proof, steps: [] }).success).toBe(false);
    expect(SolverProofSchema.safeParse({ ...proof, steps: ['  '] }).success).toBe(false);
  });

  it('rejects a problem_kind the bounded solver does not support', () => {
    expect(SolverProofSchema.safeParse({ ...proof, problem_kind: 'bayesian_network' }).success).toBe(
      false,
    );
  });

  it('rejects a missing solver_version (the run must be reproducible)', () => {
    const result = SolverProofSchema.safeParse(omit(proof, 'solver_version'));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuePaths(result.error.issues)).toContain('solver_version');
  });
});

describe('DisciplineSchema (no sufficient source ⇒ never `correct`)', () => {
  it('accepts a `correct` verdict WITH a full citation', () => {
    const result = DisciplineSchema.safeParse({
      claim: 'La respuesta marcada 1/3 corresponde a la lectura "al menos uno es varon".',
      verdict: 'correct',
      citation: FULL_CITATION,
    });
    expect(result.success).toBe(true);
  });

  it('REJECTS a `correct` verdict with citation null', () => {
    const result = DisciplineSchema.safeParse({
      claim: 'La respuesta marcada es 1/3.',
      verdict: 'correct',
      citation: null,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuePaths(result.error.issues)).toContain('citation');
  });

  it('accepts an `unverified` verdict with citation null', () => {
    const result = DisciplineSchema.safeParse({
      claim: 'No hay fuente licenciada suficiente para el condicionamiento usado.',
      verdict: 'unverified',
      citation: null,
    });
    expect(result.success).toBe(true);
  });

  it('REJECTS an `incorrect` verdict with NEITHER citation nor solver_proof', () => {
    const result = DisciplineSchema.safeParse({
      claim: 'El calculo del autor asume equiprobabilidad que el enunciado no fija.',
      verdict: 'incorrect',
      citation: null,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuePaths(result.error.issues)).toContain('solver_proof');
  });

  it('accepts an `incorrect` verdict carrying ONLY a solver_proof', () => {
    const result = DisciplineSchema.safeParse({
      claim: 'La clave marcada 1/2 no coincide con el calculo reproducible 1/3.',
      verdict: 'incorrect',
      citation: null,
      solver_proof: SOLVER_PROOF,
    });
    expect(result.success).toBe(true);
  });

  it('accepts an `incorrect` verdict carrying ONLY a citation', () => {
    const result = DisciplineSchema.safeParse({
      claim: 'El condicionamiento usado contradice la definicion citada.',
      verdict: 'incorrect',
      citation: FULL_CITATION,
      solver_proof: null,
    });
    expect(result.success).toBe(true);
  });

  it('REJECTS an `incorrect` verdict whose solver_proof is malformed', () => {
    const result = DisciplineSchema.safeParse({
      claim: 'La clave marcada no coincide con el calculo.',
      verdict: 'incorrect',
      citation: null,
      solver_proof: { ...SOLVER_PROOF, computed_value: '0.333' },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuePaths(result.error.issues)).toContain('solver_proof.computed_value');
  });

  it('accepts a `correct` verdict with a citation AND a solver_proof', () => {
    const result = DisciplineSchema.safeParse({
      claim: 'La clave 1/3 coincide con el calculo reproducible y con la fuente citada.',
      verdict: 'correct',
      citation: FULL_CITATION,
      solver_proof: SOLVER_PROOF,
    });
    expect(result.success).toBe(true);
  });

  it('REJECTS a `correct` verdict backed by a solver_proof but no citation', () => {
    const result = DisciplineSchema.safeParse({
      claim: 'El solver reproduce 1/3, igual que la clave.',
      verdict: 'correct',
      citation: null,
      solver_proof: SOLVER_PROOF,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuePaths(result.error.issues)).toContain('citation');
  });

  it('accepts an `unverified` verdict with both citation and solver_proof null', () => {
    const result = DisciplineSchema.safeParse({
      claim: 'El enunciado queda fuera de la forma soportada por el solver acotado.',
      verdict: 'unverified',
      citation: null,
      solver_proof: null,
    });
    expect(result.success).toBe(true);
  });

  it('REJECTS a whitespace-only claim', () => {
    const result = DisciplineSchema.safeParse({
      claim: '   ',
      verdict: 'unverified',
      citation: null,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuePaths(result.error.issues)).toContain('claim');
  });

  it('rejects a verdict outside the enum', () => {
    const result = DisciplineSchema.safeParse({
      claim: 'Claim.',
      verdict: 'probably_correct',
      citation: null,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuePaths(result.error.issues)).toContain('verdict');
  });

  it('rejects a `correct` verdict whose citation is incomplete', () => {
    const result = DisciplineSchema.safeParse({
      claim: 'Claim.',
      verdict: 'correct',
      citation: omit(FULL_CITATION, 'license'),
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuePaths(result.error.issues)).toContain('citation.license');
  });

  it('rejects a missing claim', () => {
    const result = DisciplineSchema.safeParse({ verdict: 'unverified', citation: null });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuePaths(result.error.issues)).toContain('claim');
  });
});

describe('DistractorSchema (no evidence ⇒ must be labeled `hypothesis`)', () => {
  const evidenced = {
    distractor: 'C) 1/2',
    hypothesized_error: 'El estudiante condiciona sobre un hijo especifico.',
    confidence: 0.8,
    evidence: 'El enunciado nombra "uno de ellos", lo que induce la lectura especifica.',
    label: 'evidenced',
  };

  it('accepts an `evidenced` finding that carries evidence', () => {
    expect(DistractorSchema.safeParse(evidenced).success).toBe(true);
  });

  it('accepts a `hypothesis` finding with no evidence field', () => {
    const result = DistractorSchema.safeParse({
      ...omit(evidenced, 'evidence'),
      label: 'hypothesis',
    });
    expect(result.success).toBe(true);
  });

  it('REJECTS an `evidenced` label when evidence is absent', () => {
    const result = DistractorSchema.safeParse(omit(evidenced, 'evidence'));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuePaths(result.error.issues)).toContain('evidence');
  });

  it('rejects an empty evidence string', () => {
    const result = DistractorSchema.safeParse({ ...evidenced, evidence: '' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuePaths(result.error.issues)).toContain('evidence');
  });

  it('rejects a confidence above 1', () => {
    const result = DistractorSchema.safeParse({ ...evidenced, confidence: 1.5 });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuePaths(result.error.issues)).toContain('confidence');
  });

  it('rejects a negative confidence', () => {
    const result = DistractorSchema.safeParse({ ...evidenced, confidence: -0.1 });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuePaths(result.error.issues)).toContain('confidence');
  });

  it('accepts the confidence bounds 0 and 1', () => {
    expect(DistractorSchema.safeParse({ ...evidenced, confidence: 0 }).success).toBe(true);
    expect(DistractorSchema.safeParse({ ...evidenced, confidence: 1 }).success).toBe(true);
  });

  it('rejects a label outside the enum', () => {
    const result = DistractorSchema.safeParse({ ...evidenced, label: 'proven' });
    expect(result.success).toBe(false);
  });

  it('REJECTS whitespace-only evidence on an `evidenced` finding', () => {
    const result = DistractorSchema.safeParse({ ...evidenced, evidence: '  ' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuePaths(result.error.issues)).toContain('evidence');
  });

  it('REJECTS a whitespace-only hypothesized_error', () => {
    const result = DistractorSchema.safeParse({ ...evidenced, hypothesized_error: ' ' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuePaths(result.error.issues)).toContain('hypothesized_error');
  });

  describe('DistractorMapSchema (the §6.2 contract is a MAP, not one finding)', () => {
    const other = {
      distractor: 'B) 1/4',
      hypothesized_error: 'El estudiante multiplica las probabilidades como si fueran independientes.',
      confidence: 0.5,
      label: 'hypothesis',
    };

    it('accepts a non-empty map with distinct distractor keys', () => {
      expect(DistractorMapSchema.safeParse([evidenced, other]).success).toBe(true);
    });

    it('accepts a map with a single finding', () => {
      expect(DistractorMapSchema.safeParse([evidenced]).success).toBe(true);
    });

    it('REJECTS an empty map', () => {
      expect(DistractorMapSchema.safeParse([]).success).toBe(false);
    });

    it('REJECTS a duplicate distractor key (one option, one finding)', () => {
      const result = DistractorMapSchema.safeParse([
        evidenced,
        { ...other, distractor: evidenced.distractor },
      ]);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(issuePaths(result.error.issues)).toContain('1.distractor');
    });

    it('REJECTS a duplicate key that differs only by whitespace or case', () => {
      const result = DistractorMapSchema.safeParse([
        evidenced,
        { ...other, distractor: ' c)  1/2 ' },
      ]);
      expect(result.success).toBe(false);
    });

    it('REJECTS a map whose entry breaks the per-finding contract', () => {
      const result = DistractorMapSchema.safeParse([omit(evidenced, 'evidence')]);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(issuePaths(result.error.issues)).toContain('0.evidence');
    });
  });
});

describe('ItemProbeSchema (deterministic cue probe)', () => {
  const probe = {
    answer_length_flag: false,
    lexical_overlap_flag: true,
    answer_length_ratio: 1.05,
    lexical_overlap_score: 0.62,
  };

  it('accepts a complete probe result', () => {
    expect(ItemProbeSchema.safeParse(probe).success).toBe(true);
  });

  it('rejects an overlap score outside 0..1', () => {
    expect(ItemProbeSchema.safeParse({ ...probe, lexical_overlap_score: 1.2 }).success).toBe(false);
    expect(ItemProbeSchema.safeParse({ ...probe, lexical_overlap_score: -0.1 }).success).toBe(false);
  });

  it('rejects a missing flag', () => {
    const result = ItemProbeSchema.safeParse(omit(probe, 'answer_length_flag'));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuePaths(result.error.issues)).toContain('answer_length_flag');
  });

  it('rejects a stringified numeric score', () => {
    expect(ItemProbeSchema.safeParse({ ...probe, lexical_overlap_score: '0.62' }).success).toBe(
      false,
    );
  });
});

describe('RubricDimensionSchema / DefenseRubricSchema (doc §6.3)', () => {
  const dimensions = [
    {
      dimension: 'identifies_error',
      score: 2,
      evidence: 'Nombra el condicionamiento incorrecto que captura el distractor C.',
    },
    {
      dimension: 'explains_uniqueness',
      score: 1,
      evidence: 'Explica por que 1/3 es unica bajo la lectura "al menos uno".',
    },
    {
      dimension: 'answers_variation',
      score: 2,
      evidence: 'Resuelve la variacion con "el mayor es varon" y obtiene 1/2.',
    },
  ];
  const rubric = { dimensions, total: 5, outcome: 'passed' };

  it('accepts a full rubric with 3 dimensions, scores 0-2 and textual evidence', () => {
    expect(DefenseRubricSchema.safeParse(rubric).success).toBe(true);
  });

  it('REJECTS a score of 3 (the scale is 0-2)', () => {
    const result = RubricDimensionSchema.safeParse({
      dimension: 'identifies_error',
      score: 3,
      evidence: 'Evidencia textual.',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuePaths(result.error.issues)).toContain('score');
  });

  it('accepts every score on the 0-2 scale', () => {
    for (const score of [0, 1, 2]) {
      const result = RubricDimensionSchema.safeParse({
        dimension: 'answers_variation',
        score,
        evidence: 'Evidencia textual.',
      });
      expect(result.success).toBe(true);
    }
  });

  it('REQUIRES a non-empty evidence string per dimension', () => {
    const result = RubricDimensionSchema.safeParse({
      dimension: 'explains_uniqueness',
      score: 2,
      evidence: '',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuePaths(result.error.issues)).toContain('evidence');
  });

  it('rejects a dimension key outside the three observable dimensions', () => {
    const result = RubricDimensionSchema.safeParse({
      dimension: 'overall_quality',
      score: 2,
      evidence: 'Evidencia textual.',
    });
    expect(result.success).toBe(false);
  });

  it('REQUIRES exactly 3 dimensions', () => {
    expect(DefenseRubricSchema.safeParse({ ...rubric, dimensions: dimensions.slice(0, 2) }).success)
      .toBe(false);
    const firstDimension = dimensions[0];
    expect(firstDimension).toBeDefined();
    expect(
      DefenseRubricSchema.safeParse({ ...rubric, dimensions: [...dimensions, firstDimension] })
        .success,
    ).toBe(false);
  });

  it('rejects a total outside 0..6', () => {
    expect(DefenseRubricSchema.safeParse({ ...rubric, total: 7 }).success).toBe(false);
    expect(DefenseRubricSchema.safeParse({ ...rubric, total: -1 }).success).toBe(false);
  });

  it('rejects an outcome outside passed|failed|inconclusive', () => {
    expect(DefenseRubricSchema.safeParse({ ...rubric, outcome: 'pending' }).success).toBe(false);
  });

  it('REJECTS whitespace-only evidence on a dimension', () => {
    const result = RubricDimensionSchema.safeParse({
      dimension: 'identifies_error',
      score: 2,
      evidence: '   ',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issuePaths(result.error.issues)).toContain('evidence');
  });

  describe('rubric integrity (a forged rubric must not be schema-valid)', () => {
    const first = dimensions[0];
    if (!first) throw new Error('fixture must have three dimensions');

    it('REJECTS three duplicate dimensions scoring 0,2,2 with total 6 and outcome passed', () => {
      const forged = {
        dimensions: [
          { ...first, score: 0 },
          { ...first, score: 2 },
          { ...first, score: 2 },
        ],
        total: 6,
        outcome: 'passed',
      };
      const result = DefenseRubricSchema.safeParse(forged);
      expect(result.success).toBe(false);
      if (result.success) return;
      const paths = issuePaths(result.error.issues);
      expect(paths).toContain('dimensions'); // duplicates
      expect(paths).toContain('total'); // 0+2+2 = 4, not 6
      expect(paths).toContain('outcome'); // a dimension scored 0
    });

    it('REJECTS duplicate dimensions even when the arithmetic is honest', () => {
      const result = DefenseRubricSchema.safeParse({
        dimensions: [
          { ...first, score: 2 },
          { ...first, score: 2 },
          { ...first, score: 1 },
        ],
        total: 5,
        outcome: 'passed',
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(issuePaths(result.error.issues)).toContain('dimensions');
    });

    it('REQUIRES the three dimensions to cover every observable dimension', () => {
      expect(RUBRIC_DIMENSIONS).toHaveLength(3);
      const result = DefenseRubricSchema.safeParse(rubric);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.dimensions.map((d) => d.dimension).sort()).toEqual(
        [...RUBRIC_DIMENSIONS].sort(),
      );
    });

    it('REJECTS a total that does not equal the sum of the scores', () => {
      const result = DefenseRubricSchema.safeParse({ ...rubric, total: 6, outcome: 'passed' });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(issuePaths(result.error.issues)).toContain('total');
    });

    it('REJECTS `passed` when a dimension scored 0 (threshold: >=4/6 AND no zero)', () => {
      const zeroed = dimensions.map((d, i) => (i === 1 ? { ...d, score: 0 } : { ...d, score: 2 }));
      const result = DefenseRubricSchema.safeParse({
        dimensions: zeroed,
        total: 4,
        outcome: 'passed',
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(issuePaths(result.error.issues)).toContain('outcome');
    });

    it('accepts `failed` for the same 2/0/2 rubric', () => {
      const zeroed = dimensions.map((d, i) => (i === 1 ? { ...d, score: 0 } : { ...d, score: 2 }));
      expect(
        DefenseRubricSchema.safeParse({ dimensions: zeroed, total: 4, outcome: 'failed' }).success,
      ).toBe(true);
    });

    it('REJECTS `failed` when the rubric actually meets the threshold', () => {
      const result = DefenseRubricSchema.safeParse({ ...rubric, outcome: 'failed' });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(issuePaths(result.error.issues)).toContain('outcome');
    });

    it('REJECTS `passed` below the 4/6 threshold', () => {
      const low = dimensions.map((d) => ({ ...d, score: 1 }));
      const result = DefenseRubricSchema.safeParse({
        dimensions: low,
        total: 3,
        outcome: 'passed',
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(issuePaths(result.error.issues)).toContain('outcome');
    });

    it('accepts `failed` at exactly 3/6 and `passed` at exactly 4/6 with no zero', () => {
      const three = dimensions.map((d) => ({ ...d, score: 1 }));
      expect(
        DefenseRubricSchema.safeParse({ dimensions: three, total: 3, outcome: 'failed' }).success,
      ).toBe(true);
      const four = dimensions.map((d, i) => ({ ...d, score: i === 0 ? 2 : 1 }));
      expect(
        DefenseRubricSchema.safeParse({ dimensions: four, total: 4, outcome: 'passed' }).success,
      ).toBe(true);
    });

    it('EXEMPTS `inconclusive` from the threshold check (the evaluator failed, §6.3)', () => {
      const low = dimensions.map((d) => ({ ...d, score: 0 }));
      expect(
        DefenseRubricSchema.safeParse({ dimensions: low, total: 0, outcome: 'inconclusive' })
          .success,
      ).toBe(true);
      expect(
        DefenseRubricSchema.safeParse({ ...rubric, outcome: 'inconclusive' }).success,
      ).toBe(true);
    });

    it('still REQUIRES total = sum when the outcome is `inconclusive`', () => {
      const result = DefenseRubricSchema.safeParse({
        ...rubric,
        total: 6,
        outcome: 'inconclusive',
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(issuePaths(result.error.issues)).toContain('total');
    });
  });
});

describe('DefenseQuestionsSchema (exactly 2 adaptive questions)', () => {
  const question = { id: 'q1', prompt: 'Que error conceptual captura el distractor C?' };

  it('accepts exactly 2 questions', () => {
    const result = DefenseQuestionsSchema.safeParse([question, { id: 'q2', prompt: 'Por que 1/3 es unica?' }]);
    expect(result.success).toBe(true);
  });

  it('rejects 1 question', () => {
    expect(DefenseQuestionsSchema.safeParse([question]).success).toBe(false);
  });

  it('rejects 3 questions', () => {
    expect(
      DefenseQuestionsSchema.safeParse([
        question,
        { id: 'q2', prompt: 'Por que 1/3 es unica?' },
        { id: 'q3', prompt: 'Y si el mayor es varon?' },
      ]).success,
    ).toBe(false);
  });

  it('rejects a question with an empty prompt', () => {
    expect(
      DefenseQuestionsSchema.safeParse([question, { id: 'q2', prompt: '' }]).success,
    ).toBe(false);
  });

  it('REJECTS a question with a whitespace-only prompt', () => {
    expect(
      DefenseQuestionsSchema.safeParse([question, { id: 'q2', prompt: '   ' }]).success,
    ).toBe(false);
  });
});

describe('REVIEWER_SCHEMAS registry', () => {
  it('exposes one schema per reviewer type (including the deterministic probe)', () => {
    expect(Object.keys(REVIEWER_SCHEMAS).sort()).toEqual([...REVIEWER_TYPES].sort());
  });

  it('exposes a whole-response schema for every reviewer whose contract is a map', () => {
    for (const key of Object.keys(REVIEWER_RESPONSE_SCHEMAS)) {
      expect(REVIEWER_TYPES).toContain(key);
    }
    expect(REVIEWER_RESPONSE_SCHEMAS.distractor).toBe(DistractorMapSchema);
  });
});
