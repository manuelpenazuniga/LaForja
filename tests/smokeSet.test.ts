/**
 * LA FORJA — labeled smoke set composition (doc §8).
 *
 * OWNER: Claude (fixtures + structure). This suite reads the ACTUAL JSON files
 * from disk, not an in-memory fixture, because its job is to keep the claim in
 * doc §8 honest: 16 author-labeled items, 4 per category, split 8 dev / 8
 * holdout, every factual_error backed by a licensed source.
 *
 * Those numbers get quoted in the README and the submission. If someone adds,
 * drops or miscategorises an item, this suite fails — that is the point.
 *
 * NAMING RULE: "labeled smoke set", never a "gold set". The labels are authored
 * by the same team that designed the defects, and every file declares it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SMOKE_CATEGORIES, SmokeItemSchema, type SmokeCategory } from '@/eval/types';

const SMOKE_DIR = fileURLToPath(new URL('../src/eval/smoke', import.meta.url));
const SPLITS = ['dev', 'holdout'] as const;

const EXPECTED_TOTAL = 16;
const EXPECTED_PER_CATEGORY = 4;
const EXPECTED_PER_SPLIT = 8;

interface LoadedFile {
  split: (typeof SPLITS)[number];
  file: string;
  path: string;
  json: unknown;
}

/** Read every smoke JSON file off disk, unvalidated. */
function loadRawFiles(): LoadedFile[] {
  const loaded: LoadedFile[] = [];
  for (const split of SPLITS) {
    const dir = join(SMOKE_DIR, split);
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      const path = join(dir, file);
      loaded.push({ split, file, path, json: JSON.parse(readFileSync(path, 'utf8')) });
    }
  }
  return loaded;
}

const rawFiles = loadRawFiles();

/**
 * Parse once, up front. Every later assertion works on validated items, so a
 * schema break surfaces as a parse failure naming the file rather than as a
 * confusing downstream count mismatch.
 */
const items = rawFiles.map(({ file, json }) => {
  const parsed = SmokeItemSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${file} does not satisfy SmokeItemSchema: ${parsed.error.message}`);
  }
  return { file, item: parsed.data };
});

function countByCategory(category: SmokeCategory): number {
  return items.filter(({ item }) => item.category === category).length;
}

describe('smoke set — file integrity', () => {
  it('every file on disk parses against SmokeItemSchema', () => {
    for (const { file, json } of rawFiles) {
      const parsed = SmokeItemSchema.safeParse(json);
      expect(parsed.success, `${file}: ${parsed.success ? '' : parsed.error.message}`).toBe(true);
    }
  });

  it('the filename matches the item id, so a file is findable from a report', () => {
    for (const { file, item } of items) {
      expect(`${item.id}.json`).toBe(file);
    }
  });
});

describe('smoke set — composition (doc §8)', () => {
  it(`contains exactly ${EXPECTED_TOTAL} items`, () => {
    expect(items).toHaveLength(EXPECTED_TOTAL);
  });

  it(`contains exactly ${EXPECTED_PER_CATEGORY} items in each of the 4 categories`, () => {
    for (const category of SMOKE_CATEGORIES) {
      expect(countByCategory(category), `category ${category}`).toBe(EXPECTED_PER_CATEGORY);
    }
  });

  it('covers every declared category and no undeclared one', () => {
    const present = new Set(items.map(({ item }) => item.category));
    expect([...present].sort()).toEqual([...SMOKE_CATEGORIES].sort());
  });

  it(`splits ${EXPECTED_PER_SPLIT}/${EXPECTED_PER_SPLIT} between dev and holdout`, () => {
    for (const split of SPLITS) {
      expect(items.filter(({ item }) => item.split === split), `split ${split}`).toHaveLength(
        EXPECTED_PER_SPLIT,
      );
    }
  });

  it('records each item in the directory matching its declared split', () => {
    for (const { split, file, json } of rawFiles) {
      expect((json as { split: string }).split, file).toBe(split);
    }
  });

  it('gives every item a unique id', () => {
    const ids = items.map(({ item }) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('smoke set — licensing and labeling (doc §8, §9)', () => {
  it('carries a CC-BY _license on every file', () => {
    for (const { file, item } of items) {
      expect(item._license, file).toMatch(/^CC-BY/);
    }
  });

  it('carries a non-empty _attribution on every file', () => {
    for (const { file, item } of items) {
      expect(item._attribution.length, file).toBeGreaterThan(0);
    }
  });

  it('declares author_labeled: true everywhere — these are NOT gold labels', () => {
    for (const { file, item } of items) {
      expect(item.author_labeled, file).toBe(true);
    }
  });
});

describe('smoke set — per-category invariants', () => {
  it('gives every clean item intended_defect === null (it measures false positives)', () => {
    for (const { file, item } of items.filter(({ item: i }) => i.category === 'clean')) {
      expect(item.intended_defect, file).toBeNull();
    }
  });

  it('gives every NON-clean item a non-null intended_defect', () => {
    for (const { file, item } of items.filter(({ item: i }) => i.category !== 'clean')) {
      expect(item.intended_defect, file).not.toBeNull();
    }
  });

  it('backs every factual_error item with a full 5-field licensed source', () => {
    for (const { file, item } of items.filter(({ item: i }) => i.category === 'factual_error')) {
      expect(item.source, file).not.toBeNull();
      // Non-null narrowing for the field-level assertions below.
      const source = item.source;
      if (source === null) continue;
      expect(Object.keys(source).sort(), file).toEqual(
        ['excerpt', 'license', 'relevance', 'source_id', 'version_date'].sort(),
      );
      for (const [field, value] of Object.entries(source)) {
        expect(value.trim().length, `${file}: ${field}`).toBeGreaterThan(0);
      }
    }
  });

  it('gives every factual_error item a true_answer for the bounded solver', () => {
    for (const { file, item } of items.filter(({ item: i }) => i.category === 'factual_error')) {
      expect(item.intended_defect?.true_answer, file).toBeTruthy();
    }
  });

  it('offers every item at least 3 options and a marked correct_key', () => {
    for (const { file, item } of items) {
      expect(item.options.length, file).toBeGreaterThanOrEqual(3);
      expect(item.correct_key.length, file).toBeGreaterThan(0);
    }
  });
});

/**
 * The invariants above pass today. These prove the SCHEMA enforces them, so a
 * future malformed item is rejected at parse time rather than only when someone
 * happens to re-read this suite.
 */
describe('SmokeItemSchema — composition refinements are enforced', () => {
  const cleanFixture = rawFiles.find((f) => f.file === 'clean-001.json')?.json as Record<
    string,
    unknown
  >;
  const factualFixture = rawFiles.find((f) => f.file === 'factual-error-001.json')?.json as Record<
    string,
    unknown
  >;

  const rejects = (label: string, override: Record<string, unknown>, base = factualFixture) => {
    it(label, () => {
      expect(SmokeItemSchema.safeParse({ ...base, ...override }).success).toBe(false);
    });
  };

  it('accepts the unmodified fixtures (the negatives below are meaningful)', () => {
    expect(SmokeItemSchema.safeParse(cleanFixture).success).toBe(true);
    expect(SmokeItemSchema.safeParse(factualFixture).success).toBe(true);
  });

  rejects(
    'rejects a clean item carrying an intended_defect',
    {
      intended_defect: { type: 'ambiguity', description: 'x', expected_finding: 'y' },
    },
    cleanFixture,
  );

  rejects('rejects a factual_error with source: null', { source: null });

  rejects('rejects a factual_error with no true_answer', {
    intended_defect: {
      type: 'factual_error',
      description: 'x',
      expected_finding: 'y',
    },
  });

  rejects('rejects a factual_error with a null true_answer', {
    intended_defect: {
      type: 'factual_error',
      description: 'x',
      expected_finding: 'y',
      true_answer: null,
    },
  });

  rejects('rejects an ambiguous item with a null intended_defect', {
    category: 'ambiguous',
    intended_defect: null,
    source: null,
  });

  rejects('rejects a cue_leak item with a null intended_defect', {
    category: 'cue_leak',
    intended_defect: null,
    source: null,
  });

  rejects('rejects a whitespace-only stem', { stem: '   ' });
  rejects('rejects a whitespace-only author_rationale', { author_rationale: '\t\n ' });
  rejects('rejects a whitespace-only _attribution', { _attribution: ' ' });
  rejects('rejects a whitespace-only source excerpt', {
    source: { ...(factualFixture.source as Record<string, unknown>), excerpt: '  ' },
  });
  rejects('rejects author_labeled: false — the label is a declaration, not a choice', {
    author_labeled: false,
  });
});
