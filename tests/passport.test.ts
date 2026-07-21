/**
 * LA FORJA — passport ASSEMBLY spec (doc §6.4).
 *
 * The passport is what a judge actually inspects. It is the artifact that has
 * to survive scrutiny, so what matters is not that the object typechecks but
 * that the right data reached the right field.
 *
 * WHY THIS SUITE EXISTS ALONGSIDE tests/passportShape.test.ts. That one guards
 * the TYPE: no `school`, no `city`, no `email`, anywhere in the schema or in
 * prisma/schema.prisma. It cannot catch the failure mode this file is about — a
 * perfectly clean type filled with the wrong content:
 *   · an ABSTENTION quietly promoted to an accepted attack, which claims the
 *     system proved something it explicitly declined to judge;
 *   · a SEMANTIC re-adjudication flattened into the deterministic list, which
 *     lends it a guarantee doc §5 never made;
 *   · a `correct` discipline verdict rendered with no citation;
 *   · an INCONCLUSIVE defense rendered as a pass or a fail;
 *   · a snapshot that silently rewrites itself when an upstream row changes.
 * Every one of those produces a shape-valid passport and a false record.
 *
 * OWNER SPLIT: `buildPassport` is CODEX-owned. This suite drives
 * the completed assembly through its injected dependencies.
 *
 * THE SEAM. Assembly reads the database, and a passport that can only be built
 * against a live Postgres/SQLite file is a passport nobody verifies. It
 * therefore takes `PassportDeps` — the same injection pattern as `VivaDeps`
 * (src/defense/viva.ts) — and every test below drives it with in-memory
 * fixtures and a fake store.
 */
import { describe, expect, it, vi } from 'vitest';

import type {
  Citation,
  DefenseRubric,
  ItemState,
  RubricDimension,
} from '@/core/types';
import { ITEM_STATES, RUBRIC_DIMENSIONS } from '@/core/types';
import type { HistoryRunBatch, ReRunOutcome } from '@/core/checks';
import {
  buildPassport,
  PASSPORT_CLASS_ORDER,
  type Passport,
  type PassportDeps,
  type PassportSourceCheck,
  type PassportSourceRecord,
} from '@/passport/passport';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ITEM_ID = 'itm_two_children';
const V1 = 'ver_two_children_v1';
const V2 = 'ver_two_children_v2';
const PUBLISHED_AT = '2025-07-21T12:00:00.000Z';
const ADJUDICATED_AT = '2025-07-21T11:59:00.000Z';

const CITATION: Citation = {
  source_id: 'forja-corpus/conditional-probability',
  version_date: '2025-07-18',
  license: 'CC-BY-4.0',
  excerpt: 'P(A|B) = P(A and B) / P(B), with P(B) > 0.',
  relevance: 'Fixes the conditional reading the marked key depends on.',
};

/** The ACCEPTED ambiguity counterexample that forced v1 -> v2. */
const ACCEPTED_AMBIGUITY: PassportSourceCheck = {
  id: 'chk_ambiguity_accepted',
  reviewerType: 'ambiguity',
  checkClass: 'counterexample',
  status: 'accepted',
  contract: {
    interpretation_a: 'At least one of the two children is a boy.',
    interpretation_b: 'A specific child is a boy.',
    answer_a: '1/3',
    answer_b: '1/2',
    evidence: 'The stem admits both readings and each fixes a different answer.',
  },
};

/** ACCEPTED, deterministic: the solver disagreed with the marked key on v1. */
const ACCEPTED_SOLVER: PassportSourceCheck = {
  id: 'chk_solver_accepted',
  reviewerType: 'discipline',
  checkClass: 'deterministic',
  status: 'accepted',
  contract: { invariant: 'solver_key_matches', solverAnswer: '1/3', failingKey: 'B' },
};

/**
 * The three that must NEVER surface as attacks. Each is a different way of
 * saying "the system did not establish this".
 */
const REJECTED_CHECK: PassportSourceCheck = {
  id: 'chk_rejected',
  reviewerType: 'ambiguity',
  checkClass: 'counterexample',
  status: 'rejected',
  contract: {
    interpretation_a: 'The children are ordered by age.',
    interpretation_b: 'The children are unordered.',
    answer_a: '1/2',
    answer_b: '1/2',
    evidence: 'REJECTED: both readings agree, so this is not a counterexample.',
  },
};

const ABSTAINED_CHECK: PassportSourceCheck = {
  id: 'chk_abstained',
  reviewerType: 'discipline',
  checkClass: 'semantic',
  status: 'abstained',
  contract: {
    claim: 'ABSTAINED: the adjudicator could not verify this conceptual claim.',
  },
};

const HYPOTHESIS_CHECK: PassportSourceCheck = {
  id: 'chk_hypothesis',
  reviewerType: 'distractor',
  checkClass: 'semantic',
  status: 'hypothesis',
  contract: {
    distractor: '1/2',
    hypothesized_error: 'HYPOTHESIS: unevidenced guess at a student misconception.',
    label: 'hypothesis',
  },
};

const PROPOSED_CHECK: PassportSourceCheck = {
  id: 'chk_proposed',
  reviewerType: 'distractor',
  checkClass: 'semantic',
  status: 'proposed',
  contract: { distractor: '2/3', hypothesized_error: 'Never adjudicated.' },
};

const NON_ACCEPTED_CHECKS = [
  REJECTED_CHECK,
  ABSTAINED_CHECK,
  HYPOTHESIS_CHECK,
  PROPOSED_CHECK,
] as const;

const DETERMINISTIC_PASS: ReRunOutcome = {
  originalCheckId: ACCEPTED_SOLVER.id,
  checkClass: 'deterministic',
  result: 'pass',
  blocksPublish: false,
  detail: 'Re-executed: the solver now reproduces the marked key on v2.',
};

const COUNTEREXAMPLE_PASS: ReRunOutcome = {
  originalCheckId: ACCEPTED_AMBIGUITY.id,
  checkClass: 'counterexample',
  result: 'pass',
  blocksPublish: false,
  detail: 'Re-executed: both recorded readings now resolve to 1/3.',
};

const SEMANTIC_READJUDICATED: ReRunOutcome = {
  originalCheckId: 'chk_semantic_distractor',
  checkClass: 'semantic',
  result: 'readjudicated',
  verdict: {
    status: 'upheld',
    rationale: "The recorded distractor '1/2' remains in v2 and its judgment is upheld.",
    adjudicatedAt: ADJUDICATED_AT,
  },
  blocksPublish: false,
};

const SEMANTIC_INCONCLUSIVE: ReRunOutcome = {
  originalCheckId: 'chk_semantic_conceptual',
  checkClass: 'semantic',
  result: 'inconclusive',
  blocksPublish: false,
  detail: 'No adjudicator recognised the recorded contract.',
};

function cleanBatch(outcomes: ReRunOutcome[] = [
  DETERMINISTIC_PASS,
  COUNTEREXAMPLE_PASS,
  SEMANTIC_READJUDICATED,
  SEMANTIC_INCONCLUSIVE,
]): HistoryRunBatch {
  return {
    targetVersionId: V2,
    expectedCheckCount: outcomes.length,
    completedCheckCount: outcomes.length,
    startedAt: '2025-07-21T11:58:00.000Z',
    completedAt: '2025-07-21T11:59:30.000Z',
    status: 'complete',
    blocksPublish: false,
    outcomes,
  };
}

const PASSING_RUBRIC: DefenseRubric = {
  dimensions: RUBRIC_DIMENSIONS.map((dimension, index) => ({
    dimension,
    score: index === 1 ? 1 : 2,
    evidence: `the student wrote "..." which scores on ${dimension}`,
  })) as unknown as [RubricDimension, RubricDimension, RubricDimension],
  total: 5,
  outcome: 'passed',
};

const INCONCLUSIVE_RUBRIC: DefenseRubric = {
  dimensions: RUBRIC_DIMENSIONS.map((dimension) => ({
    dimension,
    score: 0 as const,
    evidence:
      'Evaluator failure: the defense could not be scored; this zero is not a judgment of the student.',
  })) as unknown as [RubricDimension, RubricDimension, RubricDimension],
  total: 0,
  outcome: 'inconclusive',
};

function sourceRecord(overrides: Partial<PassportSourceRecord> = {}): PassportSourceRecord {
  return {
    itemId: ITEM_ID,
    itemState: 'PUBLISHED',
    publishedVersionId: V2,
    publishedAt: PUBLISHED_AT,
    authorPseudonym: 'herrero-azul-31',
    provenance: 'Team-authored original item (LA FORJA), no third-party content.',
    license: 'CC-BY-4.0',
    discipline: 'probability',
    checks: [ACCEPTED_AMBIGUITY, ACCEPTED_SOLVER, ...NON_ACCEPTED_CHECKS],
    historyBatch: cleanBatch(),
    disciplineVerdict: { verdict: 'correct', citation: CITATION },
    defense: PASSING_RUBRIC,
    versions: [
      { id: V1, versionNumber: 1 },
      {
        id: V2,
        versionNumber: 2,
        diff: 'stem: "one of them is a boy" -> "at least one of them is a boy"',
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The fake store. A mutable source + a write-once snapshot shelf, which is
// exactly the pair the freeze invariant is about.
// ---------------------------------------------------------------------------

interface FakeStore extends PassportDeps {
  source: PassportSourceRecord | null;
  saved: Passport[];
  loadPassportSource: ReturnType<typeof vi.fn>;
  loadStoredPassport: ReturnType<typeof vi.fn>;
  saveSnapshot: ReturnType<typeof vi.fn>;
}

function fakeStore(source: PassportSourceRecord | null = sourceRecord()): FakeStore {
  const store = {
    source,
    saved: [] as Passport[],
    loadPassportSource: vi.fn(
      async (itemId: string): Promise<PassportSourceRecord | null> =>
        store.source !== null && store.source.itemId === itemId ? store.source : null,
    ),
    loadStoredPassport: vi.fn(
      async (itemId: string): Promise<Passport | null> =>
        store.saved.find((passport) => passport.itemId === itemId) ?? null,
    ),
    saveSnapshot: vi.fn(async (passport: Passport): Promise<void> => {
      // Deep-copied on the way in: a snapshot that shares references with the
      // assembled object is not frozen, it is merely unread.
      store.saved.push(JSON.parse(JSON.stringify(passport)) as Passport);
    }),
  };
  return store as unknown as FakeStore;
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

const PASSPORT_KEYS = [
  'acceptedAttacks',
  'authorPseudonym',
  'defense',
  'discipline',
  'disciplineVerdict',
  'historyReRun',
  'itemId',
  'itemVersionId',
  'license',
  'provenance',
  'publishedAt',
  'versions',
] as const;

// ---------------------------------------------------------------------------
// CODEX-OWNED — buildPassport.
// ---------------------------------------------------------------------------

describe('buildPassport — provenance, license and identity (doc §6.4)', () => {
  it('carries provenance, license and discipline through from the item', async () => {
    const deps = fakeStore();
    const passport = await buildPassport(ITEM_ID, deps);

    expect(passport.provenance).toBe(
      'Team-authored original item (LA FORJA), no third-party content.',
    );
    expect(passport.license).toBe('CC-BY-4.0');
    expect(passport.discipline).toBe('probability');
  });

  it('is keyed to the item and to the PUBLISHED version, not to the latest draft', async () => {
    const deps = fakeStore();
    const passport = await buildPassport(ITEM_ID, deps);

    expect(passport.itemId).toBe(ITEM_ID);
    expect(passport.itemVersionId).toBe(V2);
  });

  it('stamps publishedAt from the source, never from the clock', async () => {
    const deps = fakeStore();
    const passport = await buildPassport(ITEM_ID, deps);

    expect(passport.publishedAt).toBe(PUBLISHED_AT);
  });

  it('rejects an item the source does not know', async () => {
    const deps = fakeStore(null);
    await expect(buildPassport('itm_missing', deps)).rejects.toThrow();
    expect(deps.saveSnapshot).not.toHaveBeenCalled();
  });
});

describe('buildPassport — ITEM-LEVEL, never student-level (doc §6.4, §9)', () => {
  it('emits no field beyond the Passport contract', async () => {
    const deps = fakeStore();
    const passport = await buildPassport(ITEM_ID, deps);

    expect(Object.keys(passport).sort()).toEqual([...PASSPORT_KEYS]);
  });

  it('carries authorPseudonym as the ONLY author-bearing field', async () => {
    const deps = fakeStore();
    const passport = await buildPassport(ITEM_ID, deps);

    const authorFields = Object.keys(passport).filter((key) =>
      /author|student|person|owner|user|session/i.test(key),
    );
    expect(authorFields).toEqual(['authorPseudonym']);
    expect(passport.authorPseudonym).toBe('herrero-azul-31');
  });

  it('exposes no identifying key anywhere in the assembled snapshot', async () => {
    const deps = fakeStore();
    const passport = await buildPassport(ITEM_ID, deps);

    const forbidden = [
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
    ];
    const keys = [...collectKeys(JSON.parse(JSON.stringify(passport)))];
    const violations = keys.filter((key) =>
      forbidden.some((token) => key.toLowerCase().includes(token)),
    );
    expect(violations).toEqual([]);
  });

  it('never carries the session id, which is a per-visitor identifier', async () => {
    const deps = fakeStore();
    const passport = await buildPassport(ITEM_ID, deps);

    const serialized = JSON.stringify(passport);
    expect(serialized).not.toContain('sessionId');
  });
});

describe('buildPassport — ACCEPTED attacks only (doc §6.2, §6.4)', () => {
  it('presents every accepted check with its counterexample contract', async () => {
    const deps = fakeStore();
    const passport = await buildPassport(ITEM_ID, deps);

    expect(passport.acceptedAttacks).toHaveLength(2);
    const ambiguity = passport.acceptedAttacks.find(
      (attack) => attack.reviewerType === 'ambiguity',
    );
    expect(ambiguity?.checkClass).toBe('counterexample');
    expect(ambiguity?.contract).toEqual(ACCEPTED_AMBIGUITY.contract);
  });

  it('never presents a REJECTED check as a finding', async () => {
    const deps = fakeStore();
    const passport = await buildPassport(ITEM_ID, deps);

    const serialized = JSON.stringify(passport.acceptedAttacks);
    expect(serialized).not.toContain('REJECTED');
  });

  it('never promotes an ABSTENTION to an accepted attack', async () => {
    // The load-bearing one. An abstention is the adjudicator saying "I could
    // not judge this"; showing it as a finding claims the system proved
    // something it explicitly declined to decide.
    const deps = fakeStore();
    const passport = await buildPassport(ITEM_ID, deps);

    expect(JSON.stringify(passport.acceptedAttacks)).not.toContain('ABSTAINED');
  });

  it('never presents a HYPOTHESIS-status distractor finding as evidence', async () => {
    const deps = fakeStore();
    const passport = await buildPassport(ITEM_ID, deps);

    expect(JSON.stringify(passport.acceptedAttacks)).not.toContain('HYPOTHESIS');
  });

  it('drops every non-accepted status, including never-adjudicated proposals', async () => {
    const deps = fakeStore({
      ...sourceRecord(),
      checks: [...NON_ACCEPTED_CHECKS],
    });
    const passport = await buildPassport(ITEM_ID, deps);

    expect(passport.acceptedAttacks).toEqual([]);
  });

  it('shows an item that survived untouched as having no attacks, not as unchecked', async () => {
    const deps = fakeStore({ ...sourceRecord(), checks: [] });
    const passport = await buildPassport(ITEM_ID, deps);

    expect(passport.acceptedAttacks).toEqual([]);
  });
});

describe('buildPassport — history re-run GROUPED BY CHECK CLASS (doc §5)', () => {
  it('reports one entry per re-run outcome', async () => {
    const deps = fakeStore();
    const passport = await buildPassport(ITEM_ID, deps);

    expect(passport.historyReRun).toHaveLength(4);
  });

  it('groups the entries by class, so the three promises never interleave', async () => {
    // Flattening the classes into one undifferentiated list is what erases the
    // distinction the whole §5 guarantee rests on: a reader scanning a mixed
    // list applies the deterministic promise to a semantic row.
    const deps = fakeStore({
      ...sourceRecord(),
      historyBatch: cleanBatch([
        SEMANTIC_READJUDICATED,
        DETERMINISTIC_PASS,
        SEMANTIC_INCONCLUSIVE,
        COUNTEREXAMPLE_PASS,
      ]),
    });
    const passport = await buildPassport(ITEM_ID, deps);

    const classes = passport.historyReRun.map((entry) => entry.checkClass);
    const firstIndexes = classes.map((klass) => classes.indexOf(klass));
    const lastIndexes = classes.map((klass) => classes.lastIndexOf(klass));
    // Contiguity: every occurrence of a class sits between that class's first
    // and last index, i.e. no class is split by another.
    classes.forEach((klass, index) => {
      const first = firstIndexes[index] ?? -1;
      const last = lastIndexes[index] ?? -1;
      expect(index).toBeGreaterThanOrEqual(first);
      expect(index).toBeLessThanOrEqual(last);
      expect(classes.slice(first, last + 1).every((entry) => entry === klass)).toBe(true);
    });
  });

  it('orders the groups deterministic, counterexample, semantic', async () => {
    const deps = fakeStore({
      ...sourceRecord(),
      historyBatch: cleanBatch([
        SEMANTIC_INCONCLUSIVE,
        COUNTEREXAMPLE_PASS,
        DETERMINISTIC_PASS,
      ]),
    });
    const passport = await buildPassport(ITEM_ID, deps);

    const seen = passport.historyReRun.map((entry) => entry.checkClass);
    const groupOrder = seen.filter((klass, index) => seen.indexOf(klass) === index);
    expect(groupOrder).toEqual(
      PASSPORT_CLASS_ORDER.filter((klass) => seen.includes(klass)),
    );
  });

  it('reports deterministic and counterexample results strictly', async () => {
    const deps = fakeStore();
    const passport = await buildPassport(ITEM_ID, deps);

    const deterministic = passport.historyReRun.filter(
      (entry) => entry.checkClass === 'deterministic',
    );
    const counterexample = passport.historyReRun.filter(
      (entry) => entry.checkClass === 'counterexample',
    );
    expect(deterministic.map((entry) => entry.result)).toEqual(['pass']);
    expect(counterexample.map((entry) => entry.result)).toEqual(['pass']);
  });

  it('shows a semantic outcome AS re-adjudicated, never as a guaranteed pass', async () => {
    const deps = fakeStore();
    const passport = await buildPassport(ITEM_ID, deps);

    const semantic = passport.historyReRun.filter((entry) => entry.checkClass === 'semantic');
    expect(semantic.length).toBeGreaterThan(0);
    for (const entry of semantic) {
      expect(entry.result).not.toBe('pass');
      expect(['readjudicated', 'inconclusive']).toContain(entry.result);
    }
  });

  it('renders the structured verdict of a re-adjudicated semantic check', async () => {
    const deps = fakeStore();
    const passport = await buildPassport(ITEM_ID, deps);

    const readjudicated = passport.historyReRun.find(
      (entry) => entry.checkClass === 'semantic' && entry.result === 'readjudicated',
    );
    expect(readjudicated?.verdict).toEqual({
      status: 'upheld',
      rationale: "The recorded distractor '1/2' remains in v2 and its judgment is upheld.",
      adjudicatedAt: ADJUDICATED_AT,
    });
  });

  it('carries no verdict on a semantic check nobody managed to re-adjudicate', async () => {
    // A verdict here would record a re-adjudication that never ran.
    const deps = fakeStore();
    const passport = await buildPassport(ITEM_ID, deps);

    const inconclusive = passport.historyReRun.find(
      (entry) => entry.checkClass === 'semantic' && entry.result === 'inconclusive',
    );
    expect(inconclusive).toBeDefined();
    expect(inconclusive?.verdict).toBeUndefined();
  });

  it('shows an empty history for a first version that was never repaired', async () => {
    const deps = fakeStore({
      ...sourceRecord(),
      publishedVersionId: V1,
      historyBatch: null,
      versions: [{ id: V1, versionNumber: 1 }],
    });
    const passport = await buildPassport(ITEM_ID, deps);

    expect(passport.historyReRun).toEqual([]);
  });
});

describe('buildPassport — discipline verdict WITH its citation (doc §6.2)', () => {
  it('shows the verdict together with the full citation', async () => {
    const deps = fakeStore();
    const passport = await buildPassport(ITEM_ID, deps);

    expect(passport.disciplineVerdict.verdict).toBe('correct');
    expect(passport.disciplineVerdict.citation).toEqual(CITATION);
  });

  it('shows `unverified` with a null citation when the source has no verdict', async () => {
    const deps = fakeStore({ ...sourceRecord(), disciplineVerdict: null });
    const passport = await buildPassport(ITEM_ID, deps);

    expect(passport.disciplineVerdict).toEqual({ verdict: 'unverified', citation: null });
  });

  it('keeps an `incorrect` verdict as-is; only `correct` needs the citation', async () => {
    const deps = fakeStore({
      ...sourceRecord(),
      disciplineVerdict: { verdict: 'incorrect', citation: null },
    });
    const passport = await buildPassport(ITEM_ID, deps);

    expect(passport.disciplineVerdict).toEqual({ verdict: 'incorrect', citation: null });
  });

  it('REFUSES to render `correct` without a citation', async () => {
    // Doc §6.2 forbids the row from existing at all. Reaching assembly with one
    // is a recording bug, and printing it would publish an unevidenced claim of
    // correctness under the project's own seal.
    const deps = fakeStore({
      ...sourceRecord(),
      disciplineVerdict: { verdict: 'correct', citation: null },
    });

    await expect(buildPassport(ITEM_ID, deps)).rejects.toThrow();
    expect(deps.saveSnapshot).not.toHaveBeenCalled();
  });
});

describe('buildPassport — the defense rubric, or `inconclusive` (doc §6.3)', () => {
  it('carries the full rubric when the defense was scored', async () => {
    const deps = fakeStore();
    const passport = await buildPassport(ITEM_ID, deps);

    expect(passport.defense).toEqual(PASSING_RUBRIC);
  });

  it('shows an INCONCLUSIVE defense as inconclusive, never as a pass or a fail', async () => {
    // An evaluator failure is not a judgment of the student (doc §6.3). Showing
    // it as `failed` publishes a verdict nobody reached; showing it as `passed`
    // publishes a grade nobody gave.
    const deps = fakeStore({ ...sourceRecord(), defense: INCONCLUSIVE_RUBRIC });
    const passport = await buildPassport(ITEM_ID, deps);

    expect(passport.defense.outcome).toBe('inconclusive');
    expect(passport.defense.outcome).not.toBe('passed');
    expect(passport.defense.outcome).not.toBe('failed');
  });

  it('does not dress an inconclusive defense up with its placeholder zeros', async () => {
    const deps = fakeStore({ ...sourceRecord(), defense: INCONCLUSIVE_RUBRIC });
    const passport = await buildPassport(ITEM_ID, deps);

    expect(passport.defense).toEqual({ outcome: 'inconclusive' });
  });

  it('shows a missing defense record as inconclusive', async () => {
    const deps = fakeStore({ ...sourceRecord(), defense: null });
    const passport = await buildPassport(ITEM_ID, deps);

    expect(passport.defense).toEqual({ outcome: 'inconclusive' });
  });
});

describe('buildPassport — version history WITH the diff (doc §5, §6.4)', () => {
  it('lists every version in order', async () => {
    const deps = fakeStore();
    const passport = await buildPassport(ITEM_ID, deps);

    expect(passport.versions.map((version) => version.versionNumber)).toEqual([1, 2]);
  });

  it('carries the recorded diff so a reader can see what the repair changed', async () => {
    const deps = fakeStore();
    const passport = await buildPassport(ITEM_ID, deps);

    const repaired = passport.versions.find((version) => version.versionNumber === 2);
    expect(repaired?.diff).toBe(
      'stem: "one of them is a boy" -> "at least one of them is a boy"',
    );
  });

  it('leaves the first version without a diff rather than inventing one', async () => {
    const deps = fakeStore();
    const passport = await buildPassport(ITEM_ID, deps);

    const first = passport.versions.find((version) => version.versionNumber === 1);
    expect(first?.diff).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// THE REFUSALS. These matter as much as the contents: a passport that exists
// when it should not is a false certificate, and a false certificate is worse
// than no certificate at all.
// ---------------------------------------------------------------------------

describe('buildPassport — refuses what was never published (doc §6.4)', () => {
  const unpublished = ITEM_STATES.filter((state) => state !== 'PUBLISHED');

  for (const state of unpublished) {
    it(`refuses to build a passport for an item in ${state}`, async () => {
      const deps = fakeStore({ ...sourceRecord(), itemState: state as ItemState });
      await expect(buildPassport(ITEM_ID, deps)).rejects.toThrow();
    });
  }

  it('persists nothing when it refuses', async () => {
    const deps = fakeStore({ ...sourceRecord(), itemState: 'CHALLENGED' });

    await expect(buildPassport(ITEM_ID, deps)).rejects.toThrow();
    expect(deps.saveSnapshot).not.toHaveBeenCalled();
    expect(deps.saved).toEqual([]);
  });

  it('refuses DISPUTED specifically: a challenged item is not a certified one', async () => {
    const deps = fakeStore({ ...sourceRecord(), itemState: 'DISPUTED' });
    await expect(buildPassport(ITEM_ID, deps)).rejects.toThrow();
  });
});

describe('buildPassport — refuses while the history batch blocks publication (doc §5)', () => {
  it('refuses when blocksPublish is true', async () => {
    // If the batch blocks, there is no publication to certify — whatever the
    // item's state column happens to say.
    const deps = fakeStore({
      ...sourceRecord(),
      historyBatch: { ...cleanBatch(), blocksPublish: true },
    });

    await expect(buildPassport(ITEM_ID, deps)).rejects.toThrow();
    expect(deps.saveSnapshot).not.toHaveBeenCalled();
  });

  it('refuses when a deterministic check regressed, even if the aggregate looks clean', async () => {
    const regressed: ReRunOutcome = {
      originalCheckId: ACCEPTED_SOLVER.id,
      checkClass: 'deterministic',
      result: 'regressed',
      blocksPublish: true,
      detail: 'The solver disagrees with the marked key again on v2.',
    };
    const deps = fakeStore({
      ...sourceRecord(),
      historyBatch: { ...cleanBatch([regressed]), blocksPublish: true },
    });

    await expect(buildPassport(ITEM_ID, deps)).rejects.toThrow();
  });

  it('refuses an INCOMPLETE batch: it is indistinguishable from nothing being checked', async () => {
    const deps = fakeStore({
      ...sourceRecord(),
      historyBatch: {
        ...cleanBatch(),
        status: 'incomplete',
        completedCheckCount: 1,
        blocksPublish: true,
      },
    });

    await expect(buildPassport(ITEM_ID, deps)).rejects.toThrow();
  });

  it('refuses a FAILED batch', async () => {
    const deps = fakeStore({
      ...sourceRecord(),
      historyBatch: {
        ...cleanBatch(),
        status: 'failed',
        completedAt: null,
        blocksPublish: true,
      },
    });

    await expect(buildPassport(ITEM_ID, deps)).rejects.toThrow();
  });

  it('refuses a repaired item whose history batch is missing entirely', async () => {
    // Two versions means a repair happened, and doc §5 requires the FULL
    // recorded history to have been re-run against the repair. No batch is not
    // an absence of work to prove — it is the proof being absent.
    const deps = fakeStore({ ...sourceRecord(), historyBatch: null });
    await expect(buildPassport(ITEM_ID, deps)).rejects.toThrow();
  });

  it('accepts a complete, non-blocking batch', async () => {
    const deps = fakeStore();
    await expect(buildPassport(ITEM_ID, deps)).resolves.toBeDefined();
  });
});

describe('buildPassport — the snapshot is FROZEN at publish time (doc §6.4)', () => {
  it('persists the snapshot exactly once', async () => {
    const deps = fakeStore();
    await buildPassport(ITEM_ID, deps);

    expect(deps.saveSnapshot).toHaveBeenCalledTimes(1);
    expect(deps.saved).toHaveLength(1);
  });

  it('returns the stored snapshot on a rebuild instead of re-assembling', async () => {
    const deps = fakeStore();
    const first = await buildPassport(ITEM_ID, deps);
    deps.loadPassportSource.mockClear();

    const second = await buildPassport(ITEM_ID, deps);
    expect(second).toEqual(first);
    expect(deps.saveSnapshot).toHaveBeenCalledTimes(1);
  });

  it('does not let a LATER upstream edit rewrite an already-published passport', async () => {
    // This is the whole reason the passport is stored rather than computed on
    // read. A judge inspected a specific document; changing an upstream row
    // must not change what they inspected.
    const deps = fakeStore();
    const published = await buildPassport(ITEM_ID, deps);

    deps.source = {
      ...sourceRecord(),
      license: 'all-rights-reserved',
      provenance: 'REWRITTEN AFTER PUBLICATION',
      disciplineVerdict: { verdict: 'unverified', citation: null },
      defense: INCONCLUSIVE_RUBRIC,
      checks: [ACCEPTED_AMBIGUITY, ACCEPTED_SOLVER, ...NON_ACCEPTED_CHECKS, PROPOSED_CHECK],
      versions: [
        { id: V1, versionNumber: 1 },
        { id: V2, versionNumber: 2, diff: 'REWRITTEN AFTER PUBLICATION' },
        { id: 'ver_v3', versionNumber: 3, diff: 'a third version added later' },
      ],
    };

    const reread = await buildPassport(ITEM_ID, deps);
    expect(reread).toEqual(published);
    expect(reread.license).toBe('CC-BY-4.0');
    expect(reread.provenance).not.toContain('REWRITTEN');
    expect(reread.versions).toHaveLength(2);
    expect(JSON.stringify(reread)).not.toContain('REWRITTEN AFTER PUBLICATION');
  });

  it('does not re-freeze when a later edit would have made the item unpublishable', async () => {
    const deps = fakeStore();
    const published = await buildPassport(ITEM_ID, deps);

    deps.source = {
      ...sourceRecord(),
      itemState: 'DISPUTED',
      historyBatch: { ...cleanBatch(), blocksPublish: true },
    };

    // The refusals guard ASSEMBLY. An already-frozen snapshot is a historical
    // record and is still readable after the item is challenged again.
    await expect(buildPassport(ITEM_ID, deps)).resolves.toEqual(published);
    expect(deps.saveSnapshot).toHaveBeenCalledTimes(1);
  });

  it('the stored snapshot does not share mutable references with the returned object', async () => {
    const deps = fakeStore();
    const passport = await buildPassport(ITEM_ID, deps);

    passport.acceptedAttacks.push({
      reviewerType: 'ambiguity',
      checkClass: 'counterexample',
      contract: { injected: 'after the freeze' },
    });

    const reread = await buildPassport(ITEM_ID, deps);
    expect(reread.acceptedAttacks).toHaveLength(2);
    expect(JSON.stringify(reread)).not.toContain('after the freeze');
  });
});
