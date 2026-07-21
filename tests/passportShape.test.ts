/**
 * LA FORJA — the PII invariant (doc §6.4 "item-level, never student-level" and
 * §9 "random pseudonyms; no school/city; zero PII in the system").
 *
 * OWNER: Claude (structure/privacy). Two guards, both executable:
 *  1. A fully populated Passport, serialized, must expose no forbidden key.
 *  2. prisma/schema.prisma must declare no forbidden column.
 *
 * This is the test that keeps PII out of the system. If a future field trips it,
 * the field is wrong — not the test.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Passport } from '@/passport/passport';
import type { DefenseRubric } from '@/core/types';

/**
 * Field names that may never exist in any schema, type, form or column
 * (English + Spanish, since items may be authored in either language).
 */
const FORBIDDEN_PII_TOKENS = [
  'school',
  'colegio',
  'city',
  'ciudad',
  'name',
  'nombre',
  'email',
  'age',
  'edad',
  'rut',
  'phone',
] as const;

/** Split camelCase / snake_case / kebab-case into lowercase word segments. */
function segmentsOf(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((segment) => segment.toLowerCase())
    .filter((segment) => segment.length > 0);
}

/** A key is a violation if any forbidden token is a segment of it or a substring. */
function forbiddenTokensIn(key: string): string[] {
  const lower = key.toLowerCase();
  const segments = segmentsOf(key);
  return FORBIDDEN_PII_TOKENS.filter(
    (token) => segments.includes(token) || lower.includes(token),
  );
}

/** Every key appearing anywhere in a serialized structure. */
function collectKeys(value: unknown, into: Set<string> = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, into);
    return into;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      into.add(key);
      collectKeys(child, into);
    }
  }
  return into;
}

const rubric: DefenseRubric = {
  dimensions: [
    {
      dimension: 'identifies_error',
      score: 2,
      evidence: 'Nombra el condicionamiento que captura el distractor senalado.',
    },
    {
      dimension: 'explains_uniqueness',
      score: 1,
      evidence: 'Explica por que 1/3 es la unica respuesta bajo la lectura fijada.',
    },
    {
      dimension: 'answers_variation',
      score: 2,
      evidence: 'Resuelve la variacion "el hijo mayor es varon" y obtiene 1/2.',
    },
  ],
  total: 5,
  outcome: 'passed',
};

/** A fully populated passport — every optional branch filled, so nothing hides. */
const passport: Passport = {
  itemId: 'itm_demo_two_children',
  itemVersionId: 'ver_demo_v2',
  authorPseudonym: 'herrero-azul-31',
  provenance: 'Team-authored original item (LA FORJA), no third-party content.',
  license: 'CC-BY-4.0',
  discipline: 'probability',
  acceptedAttacks: [
    {
      reviewerType: 'ambiguity',
      checkClass: 'counterexample',
      contract: {
        interpretation_a: 'Al menos uno de los dos hijos es varon.',
        interpretation_b: 'Un hijo especifico es varon.',
        answer_a: '1/3',
        answer_b: '1/2',
        evidence: 'El enunciado admite ambas lecturas y cada una fija otra respuesta.',
      },
    },
  ],
  historyReRun: [
    { checkClass: 'deterministic', result: 'pass', detail: 'Solver re-run on v2.' },
    { checkClass: 'counterexample', result: 'pass', detail: 'Construction no longer holds on v2.' },
    { checkClass: 'semantic', result: 'readjudicated', detail: 'Distractor plausibility re-judged.' },
  ],
  disciplineVerdict: {
    verdict: 'correct',
    citation: {
      source_id: 'forja-corpus/probabilidad-condicional',
      version_date: '2025-07-18',
      license: 'CC-BY-4.0',
      excerpt: 'P(A|B) = P(A ∩ B) / P(B), con P(B) > 0.',
      relevance: 'Fija la lectura condicional usada por la clave.',
    },
  },
  defense: rubric,
  versions: [
    { versionNumber: 1 },
    { versionNumber: 2, diff: 'stem: "uno de ellos" -> "al menos uno de ellos"' },
  ],
  publishedAt: '2025-07-21T12:00:00.000Z',
};

describe('Passport shape (doc §6.4 — item level, never student level)', () => {
  it('exposes no forbidden PII key anywhere in the serialized snapshot', () => {
    const serialized: unknown = JSON.parse(JSON.stringify(passport));
    const violations = [...collectKeys(serialized)]
      .map((key) => ({ key, tokens: forbiddenTokensIn(key) }))
      .filter((entry) => entry.tokens.length > 0);
    expect(violations).toEqual([]);
  });

  it('also exposes no forbidden PII key when the defense is inconclusive', () => {
    const inconclusive: Passport = { ...passport, defense: { outcome: 'inconclusive' } };
    const serialized: unknown = JSON.parse(JSON.stringify(inconclusive));
    const violations = [...collectKeys(serialized)].filter(
      (key) => forbiddenTokensIn(key).length > 0,
    );
    expect(violations).toEqual([]);
  });

  it('carries authorPseudonym as the ONLY author-identifying field', () => {
    const authorFields = Object.keys(passport).filter((key) =>
      /author|student|person|owner|user/i.test(key),
    );
    expect(authorFields).toEqual(['authorPseudonym']);
    expect(passport.authorPseudonym.length).toBeGreaterThan(0);
  });

  it('is keyed to an item and a version, never to a student record', () => {
    expect(passport.itemId.length).toBeGreaterThan(0);
    expect(passport.itemVersionId.length).toBeGreaterThan(0);
  });

  it('reports the history re-run BY CHECK CLASS (doc §5)', () => {
    const classes = passport.historyReRun.map((entry) => entry.checkClass);
    expect(classes).toContain('deterministic');
    expect(classes).toContain('counterexample');
    expect(classes).toContain('semantic');
  });
});

describe('forbidden-key detector', () => {
  it('catches the fields this invariant exists to prevent', () => {
    for (const key of ['school', 'schoolName', 'student_name', 'city', 'email', 'age', 'rut']) {
      expect(forbiddenTokensIn(key).length).toBeGreaterThan(0);
    }
  });

  it('does not flag the legitimate pseudonym field', () => {
    expect(forbiddenTokensIn('authorPseudonym')).toEqual([]);
    expect(forbiddenTokensIn('pseudonym')).toEqual([]);
  });
});

describe('prisma/schema.prisma declares no PII column (doc §9)', () => {
  const schemaPath = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));
  const schemaText = readFileSync(schemaPath, 'utf8');
  /** Comments may legitimately mention "no school/city"; columns may not. */
  const codeOnly = schemaText
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');

  /** First identifier on each declaration line inside a block = the field name. */
  const fieldNames = codeOnly
    .split('\n')
    .map((line) => /^\s{2,}([A-Za-z_][A-Za-z0-9_]*)\s+\S/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1] ?? '');

  it('parses a plausible number of field declarations', () => {
    expect(fieldNames.length).toBeGreaterThan(20);
    expect(fieldNames).toContain('pseudonym');
  });

  it('declares no field whose name contains a forbidden PII token', () => {
    const violations = fieldNames
      .map((field) => ({ field, tokens: forbiddenTokensIn(field) }))
      .filter((entry) => entry.tokens.length > 0);
    expect(violations).toEqual([]);
  });

  it('never uses a forbidden PII token as a whole word outside comments', () => {
    const hits = FORBIDDEN_PII_TOKENS.filter((token) =>
      new RegExp(`\\b${token}\\b`, 'i').test(codeOnly),
    );
    expect(hits).toEqual([]);
  });

  it('keeps the author field a random pseudonym on Session', () => {
    expect(codeOnly).toMatch(/pseudonym\s+String/);
  });
});
