/**
 * LA FORJA — persistence spec (the five Prisma-backed stubs).
 *
 * ---------------------------------------------------------------------------
 * TWO KINDS OF SUITE IN ONE FILE, ON PURPOSE
 * ---------------------------------------------------------------------------
 * The first `describe` is CLAUDE-owned and RUNS TODAY: it proves the throwaway
 * database harness in tests/helpers/testDb.ts actually works. Everything after
 * it is CODEX-owned and `describe.skip`ped, with complete bodies, and becomes
 * the punch-list. A harness nobody verified would make every skipped assertion
 * below worthless the day it is unskipped, so it is verified first.
 *
 * ---------------------------------------------------------------------------
 * WHY A REAL SQLITE FILE AND NOT A FAKE REPOSITORY
 * ---------------------------------------------------------------------------
 * The only thing these five stubs DO is talk to the database. A fake repository
 * would assert that our fake remembers what we handed it; it cannot catch a
 * `where` clause that forgets the version, a `...Json` column returned raw
 * instead of parsed, a relation that was never written, or — the one that
 * matters most here — the composite uniqueness on Passport(itemId,
 * itemVersionId) that the entire frozen-snapshot promise rests on. Those are
 * database facts, so they are checked against a database.
 *
 * ---------------------------------------------------------------------------
 * HOW THE MODULE UNDER TEST IS POINTED AT THE TEMP DATABASE
 * ---------------------------------------------------------------------------
 * The production code reads the `prisma` singleton from src/db/client.ts, which
 * binds to `process.env.DATABASE_URL` AT IMPORT TIME. So the skipped suites set
 * that variable to the temp file, clear the module registry and the
 * cross-module singleton, and only then `await import()` the module under test.
 * Every import of production code below is therefore dynamic; the static
 * imports are type-only and erase at compile time.
 *
 * NOTHING HERE TOUCHES THE NETWORK. No model is called: the two defense
 * recorders are handed telemetry that a call would have produced, which is
 * precisely the seam that keeps hard constraint 3 testable without a key.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';

import {
  createTestDb,
  seedCheck,
  seedDefense,
  seedHistoryBatch,
  seedItem,
  seedPassport,
  seedSession,
  type TestDb,
} from './helpers/testDb';
import { fromJson, toJson } from '@/db/client';

import type { Passport, PassportDeps } from '@/passport/passport';
import type { DefenseDeps, QuestionsRecord, ScoringRecord } from '@/app/api/defense/route';
import type { ModelCallResult } from '@/openai/client';
import type { Citation, DefenseRubric, RubricDimension } from '@/core/types';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const CITATION: Citation = {
  source_id: 'openstax-introductory-statistics',
  version_date: '2023-06-01',
  license: 'CC-BY-4.0',
  excerpt: 'For dependent events, P(A and B) = P(A) · P(B | A).',
  relevance: 'Fixes the multiplication rule the stem depends on.',
};

function rubric(scores: [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2], outcome: DefenseRubric['outcome']): DefenseRubric {
  const dimensions: [RubricDimension, RubricDimension, RubricDimension] = [
    { dimension: 'identifies_error', score: scores[0], evidence: 'Names the conditional-probability slip.' },
    { dimension: 'explains_uniqueness', score: scores[1], evidence: 'Rules out each remaining option.' },
    { dimension: 'answers_variation', score: scores[2], evidence: 'Answers the with-replacement variant.' },
  ];
  return { dimensions, total: scores[0] + scores[1] + scores[2], outcome };
}

/** The rubric scoreDefense returns when the evaluator itself failed. */
function inconclusiveRubric(): DefenseRubric {
  const dimensions: [RubricDimension, RubricDimension, RubricDimension] = [
    { dimension: 'identifies_error', score: 0, evidence: 'Evaluator unavailable — this zero is not a judgment of the student.' },
    { dimension: 'explains_uniqueness', score: 0, evidence: 'Evaluator unavailable — this zero is not a judgment of the student.' },
    { dimension: 'answers_variation', score: 0, evidence: 'Evaluator unavailable — this zero is not a judgment of the student.' },
  ];
  return { dimensions, total: 0, outcome: 'inconclusive' };
}

function telemetry(modelId = 'gpt-5.6-sol'): ModelCallResult<unknown> {
  return {
    data: { ok: true },
    raw: '{"ok":true}',
    modelId,
    modelFamilyOk: true,
    latencyMs: 1234,
    tokensIn: 812,
    tokensOut: 244,
    promptVersion: 'v1',
    promptHash: 'a3f19c8e5b2d4470',
    schemaValid: true,
  };
}

// ===========================================================================
// 1. THE HARNESS ITSELF — Claude-owned, runs today
// ===========================================================================

describe('test database harness', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.reset();
  });

  afterAll(async () => {
    await db.teardown();
  });

  it('creates a real database file on disk', () => {
    expect(db.filePath).toMatch(/\.db$/u);
    expect(existsSync(db.filePath)).toBe(true);
    expect(db.url).toBe(`file:${db.filePath}`);
  });

  it('applies the whole schema, not just the tables the first test happens to touch', async () => {
    // Every model in prisma/schema.prisma. A missing table throws here rather
    // than three suites later inside a skipped-then-unskipped spec.
    await expect(
      Promise.all([
        db.prisma.session.count(),
        db.prisma.item.count(),
        db.prisma.itemVersion.count(),
        db.prisma.gauntletRun.count(),
        db.prisma.check.count(),
        db.prisma.citation.count(),
        db.prisma.historyRunBatch.count(),
        db.prisma.historyReRun.count(),
        db.prisma.defense.count(),
        db.prisma.modelCall.count(),
        db.prisma.passport.count(),
      ]),
    ).resolves.toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('round-trips a row', async () => {
    const session = await seedSession(db, { pseudonym: 'brisk-heron-0091' });
    const found = await db.prisma.session.findUnique({ where: { id: session.id } });

    expect(found).not.toBeNull();
    expect(found?.pseudonym).toBe('brisk-heron-0091');
    expect(found?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('seeds an item with version lineage, a current-version pointer and stringified JSON', async () => {
    const session = await seedSession(db);
    const { item, versions } = await seedItem(db, {
      sessionId: session.id,
      state: 'PUBLISHED',
      versions: [{ options: ['1/5', '2/5'] }, { diff: 'stem: clarified "without replacement"' }],
    });

    expect(versions.map((v) => v.versionNumber)).toEqual([1, 2]);
    expect(versions[0]?.previousVersionId).toBeNull();
    expect(versions[1]?.previousVersionId).toBe(versions[0]?.id);
    expect(item.currentVersionId).toBe(versions[1]?.id);

    // The JSON columns are TEXT, and only `fromJson` gets objects back out.
    expect(typeof versions[0]?.optionsJson).toBe('string');
    expect(fromJson<string[]>(versions[0]!.optionsJson)).toEqual(['1/5', '2/5']);
    expect(fromJson<string>(versions[1]!.diffJson!)).toBe('stem: clarified "without replacement"');
  });

  it('derives a seeded check class from the same map production uses', async () => {
    const session = await seedSession(db);
    const { versions } = await seedItem(db, { sessionId: session.id });
    const versionId = versions[0]!.id;

    const solverCheck = await seedCheck(db, {
      itemVersionId: versionId,
      reviewerType: 'discipline',
      verificationKind: 'solver',
      status: 'accepted',
    });
    const citationCheck = await seedCheck(db, {
      itemVersionId: versionId,
      reviewerType: 'discipline',
      verificationKind: 'citation',
      status: 'rejected',
      citation: CITATION,
    });

    expect(solverCheck.checkClass).toBe('deterministic');
    expect(citationCheck.checkClass).toBe('semantic');

    // Executable identity is what makes strict non-regression provable, so the
    // executable classes get it and semantic — which has no executor to name —
    // does not.
    expect(solverCheck.invariantId).toBe('solver_key_matches');
    expect(solverCheck.executorVersion).not.toBeNull();
    expect(solverCheck.thresholdVersion).not.toBeNull();
    expect(citationCheck.invariantId).toBeNull();
    expect(citationCheck.executorVersion).toBeNull();

    expect(citationCheck.citationId).not.toBeNull();
    const citation = await db.prisma.citation.findUnique({ where: { id: citationCheck.citationId! } });
    expect(citation?.sourceId).toBe(CITATION.source_id);
  });

  it('refuses to seed a check whose (reviewer, verification) pair has no legal class', async () => {
    const session = await seedSession(db);
    const { versions } = await seedItem(db, { sessionId: session.id });

    await expect(
      seedCheck(db, {
        itemVersionId: versions[0]!.id,
        reviewerType: 'ambiguity',
        verificationKind: 'solver',
      }),
    ).rejects.toThrow(/not a legal/u);
  });

  it('seeds a history batch with its re-runs, and a defense', async () => {
    const session = await seedSession(db);
    const { versions } = await seedItem(db, {
      sessionId: session.id,
      versions: [{}, {}],
    });
    const check = await seedCheck(db, {
      itemVersionId: versions[0]!.id,
      reviewerType: 'item_probe',
      verificationKind: 'heuristic',
      status: 'accepted',
    });

    const { batch, reRuns } = await seedHistoryBatch(db, {
      itemVersionId: versions[1]!.id,
      reRuns: [{ originalCheckId: check.id, checkClass: 'deterministic', result: 'pass', details: 'ratio 1.02' }],
    });

    expect(batch.expectedCheckCount).toBe(1);
    expect(batch.completedCheckCount).toBe(1);
    expect(batch.status).toBe('complete');
    expect(batch.blocksPublish).toBe(false);
    expect(reRuns).toHaveLength(1);
    expect(fromJson<string>(reRuns[0]!.detailsJson!)).toBe('ratio 1.02');

    const defense = await seedDefense(db, {
      itemVersionId: versions[1]!.id,
      rubric: rubric([2, 2, 1], 'passed'),
      outcome: 'passed',
    });
    expect(defense.totalScore).toBe(5);
    expect(fromJson<DefenseRubric>(defense.rubricJson!).dimensions).toHaveLength(3);
  });

  it('reset() empties every table without dropping the schema', async () => {
    const session = await seedSession(db);
    const { item, versions } = await seedItem(db, { sessionId: session.id, versions: [{}, {}] });
    await seedCheck(db, {
      itemVersionId: versions[0]!.id,
      reviewerType: 'discipline',
      verificationKind: 'citation',
      citation: CITATION,
    });
    await seedPassport(db, { itemId: item.id, itemVersionId: versions[1]!.id, snapshot: { ok: true } });

    await db.reset();

    // Self-referencing versions and the forward Item -> ItemVersion pointer are
    // the two shapes a naive deleteMany order gets wrong.
    expect(await db.prisma.itemVersion.count()).toBe(0);
    expect(await db.prisma.item.count()).toBe(0);
    expect(await db.prisma.citation.count()).toBe(0);
    expect(await db.prisma.passport.count()).toBe(0);
    expect(await db.prisma.session.count()).toBe(0);

    // The schema survived: a fresh insert still works.
    await expect(seedSession(db)).resolves.toBeTruthy();
  });

  it('teardown disconnects and deletes the database file', async () => {
    const scratch = await createTestDb();
    expect(existsSync(scratch.filePath)).toBe(true);

    await scratch.teardown();

    expect(existsSync(scratch.filePath)).toBe(false);
  });

  it('gives each database its own file, so parallel workers cannot collide', async () => {
    const a = await createTestDb();
    const b = await createTestDb();
    try {
      expect(a.filePath).not.toBe(b.filePath);

      await seedSession(a, { pseudonym: 'only-in-a' });
      expect(await b.prisma.session.count()).toBe(0);
    } finally {
      await a.teardown();
      await b.teardown();
    }
  });
});

// ===========================================================================
// 2. PassportDeps — the three Prisma-backed stubs (CODEX)
// ===========================================================================

describe('PassportDeps (Prisma-backed)', () => {
  let db: TestDb;
  let deps: PassportDeps;

  beforeAll(async () => {
    db = await createTestDb();
    process.env.DATABASE_URL = db.url;
    // src/db/client.ts caches the client on globalThis outside production; the
    // stale one would still point at whatever URL was set when it was built.
    delete (globalThis as { prisma?: unknown }).prisma;
    vi.resetModules();
    ({ DEFAULT_PASSPORT_DEPS: deps } = await import('@/passport/passport'));
  });

  afterEach(async () => {
    await db.reset();
  });

  afterAll(async () => {
    await db.teardown();
  });

  /** A published, once-repaired item with the full spread of check statuses. */
  async function seedPublishedItem(): Promise<{
    itemId: string;
    versionIds: string[];
    acceptedCheckId: string;
  }> {
    const session = await seedSession(db, { pseudonym: 'amber-lynx-7731' });
    const { item, versions } = await seedItem(db, {
      sessionId: session.id,
      state: 'PUBLISHED',
      discipline: 'probability',
      provenance: 'Team-authored, LA FORJA demo corpus.',
      license: 'CC-BY-4.0',
      versions: [{}, { diff: 'stem: added "without replacement"', immutable: true }],
    });

    const accepted = await seedCheck(db, {
      itemVersionId: versions[0]!.id,
      reviewerType: 'ambiguity',
      verificationKind: 'interpretation',
      status: 'accepted',
      contract: {
        interpretation_a: 'with replacement',
        interpretation_b: 'without replacement',
        answer_a: '9/25',
        answer_b: '3/10',
        evidence: 'The stem never states whether the first ball is returned.',
      },
    });
    await seedCheck(db, {
      itemVersionId: versions[0]!.id,
      reviewerType: 'discipline',
      verificationKind: 'citation',
      status: 'rejected',
      citation: CITATION,
      contract: { claim: 'The key is wrong.', verdict: 'incorrect', citation: CITATION },
    });
    await seedCheck(db, {
      itemVersionId: versions[0]!.id,
      reviewerType: 'distractor',
      verificationKind: 'interpretation',
      status: 'abstained',
      contract: { distractor: '1/10', hypothesized_error: 'unclear', confidence: 0.2, label: 'hypothesis' },
    });
    await seedCheck(db, {
      itemVersionId: versions[0]!.id,
      reviewerType: 'distractor',
      verificationKind: 'citation',
      status: 'hypothesis',
      contract: { distractor: '2/5', hypothesized_error: 'adds instead of multiplying', confidence: 0.4, label: 'hypothesis' },
    });

    await seedHistoryBatch(db, {
      itemVersionId: versions[1]!.id,
      reRuns: [
        { originalCheckId: accepted.id, checkClass: 'counterexample', result: 'pass', details: 'both readings now converge on 3/10' },
      ],
    });

    await seedDefense(db, {
      itemVersionId: versions[1]!.id,
      answers: ['It confuses dependent with independent draws.', 'Only 3/10 survives the conditional rule.'],
      rubric: rubric([2, 2, 1], 'passed'),
      outcome: 'passed',
    });

    return {
      itemId: item.id,
      versionIds: versions.map((v) => v.id),
      acceptedCheckId: accepted.id,
    };
  }

  // -- loadPassportSource ---------------------------------------------------

  describe('loadPassportSource', () => {
    it('returns null for an item that does not exist', async () => {
      await expect(deps.loadPassportSource('no-such-item')).resolves.toBeNull();
    });

    it('returns a record matching the rows on disk', async () => {
      const { itemId, versionIds } = await seedPublishedItem();

      const source = await deps.loadPassportSource(itemId);

      expect(source).not.toBeNull();
      expect(source!.itemId).toBe(itemId);
      expect(source!.itemState).toBe('PUBLISHED');
      expect(source!.publishedVersionId).toBe(versionIds[1]);
      expect(source!.authorPseudonym).toBe('amber-lynx-7731');
      expect(source!.provenance).toBe('Team-authored, LA FORJA demo corpus.');
      expect(source!.license).toBe('CC-BY-4.0');
      expect(source!.discipline).toBe('probability');
      expect(new Date(source!.publishedAt).toString()).not.toBe('Invalid Date');

      expect(source!.versions.map((v) => v.versionNumber)).toEqual([1, 2]);
      expect(source!.versions[1]?.diff).toBe('stem: added "without replacement"');
    });

    it('loads checks UNFILTERED — rejected, abstained and hypothesis included', async () => {
      // The filter belongs to buildPassport, which is where "only accepted
      // findings become attacks" is actually decided. Filtering here would move
      // that decision somewhere no test can observe it, and the assertion in
      // tests/passport.test.ts would be checking a fixture instead of a rule.
      const { itemId } = await seedPublishedItem();

      const source = await deps.loadPassportSource(itemId);

      expect(source!.checks).toHaveLength(4);
      expect(source!.checks.map((c) => c.status).sort()).toEqual([
        'abstained',
        'accepted',
        'hypothesis',
        'rejected',
      ]);
    });

    it('parses every ...Json column through fromJson — never a raw string', async () => {
      const { itemId } = await seedPublishedItem();

      const source = await deps.loadPassportSource(itemId);

      const accepted = source!.checks.find((c) => c.status === 'accepted');
      expect(typeof accepted!.contract).toBe('object');
      expect(accepted!.contract).toMatchObject({ answer_a: '9/25', answer_b: '3/10' });

      // A raw column would come back as the string `"stem: added …"` INCLUDING
      // the JSON quotes; a parsed one is the plain text.
      expect(source!.versions[1]?.diff).not.toMatch(/^"/u);

      const outcome = source!.historyBatch!.outcomes[0]!;
      expect(outcome.detail).toBe('both readings now converge on 3/10');

      expect(source!.defense).not.toBeNull();
      expect(source!.defense!.dimensions).toHaveLength(3);
      expect(source!.defense!.total).toBe(5);
    });

    it('rebuilds the history batch from HistoryRunBatch + HistoryReRun', async () => {
      const { itemId, acceptedCheckId, versionIds } = await seedPublishedItem();

      const source = await deps.loadPassportSource(itemId);

      const batch = source!.historyBatch!;
      expect(batch.targetVersionId).toBe(versionIds[1]);
      expect(batch.expectedCheckCount).toBe(1);
      expect(batch.completedCheckCount).toBe(1);
      expect(batch.status).toBe('complete');
      expect(batch.blocksPublish).toBe(false);
      expect(batch.outcomes[0]?.originalCheckId).toBe(acceptedCheckId);
      expect(batch.outcomes[0]?.checkClass).toBe('counterexample');
      expect(batch.outcomes[0]?.result).toBe('pass');
    });

    it('returns a null history batch for a v1 that was never repaired', async () => {
      const session = await seedSession(db);
      const { item } = await seedItem(db, { sessionId: session.id, state: 'PUBLISHED' });

      const source = await deps.loadPassportSource(item.id);

      expect(source!.versions).toHaveLength(1);
      expect(source!.historyBatch).toBeNull();
    });

    it('maps a discipline citation row back to the full citation shape', async () => {
      const session = await seedSession(db);
      const { item, versions } = await seedItem(db, { sessionId: session.id, state: 'PUBLISHED' });
      await seedCheck(db, {
        itemVersionId: versions[0]!.id,
        reviewerType: 'discipline',
        verificationKind: 'citation',
        status: 'accepted',
        citation: CITATION,
        contract: { claim: 'The key is right.', verdict: 'correct', citation: CITATION },
      });

      const source = await deps.loadPassportSource(item.id);

      expect(source!.disciplineVerdict).not.toBeNull();
      expect(source!.disciplineVerdict!.verdict).toBe('correct');
      expect(source!.disciplineVerdict!.citation).toEqual(CITATION);
    });

    it('carries no author-bearing datum beyond the pseudonym', async () => {
      const { itemId } = await seedPublishedItem();

      const source = await deps.loadPassportSource(itemId);

      const serialized = toJson(source);
      for (const forbidden of ['school', 'city', 'email', 'sessionId']) {
        expect(serialized).not.toContain(forbidden);
      }
    });
  });

  // -- loadStoredPassport ---------------------------------------------------

  describe('loadStoredPassport', () => {
    it('returns null when no snapshot was stamped', async () => {
      const { itemId } = await seedPublishedItem();

      await expect(deps.loadStoredPassport(itemId)).resolves.toBeNull();
    });

    it('returns a previously saved snapshot verbatim', async () => {
      const { itemId, versionIds } = await seedPublishedItem();
      const snapshot: Passport = {
        itemId,
        itemVersionId: versionIds[1]!,
        authorPseudonym: 'amber-lynx-7731',
        provenance: 'Team-authored, LA FORJA demo corpus.',
        license: 'CC-BY-4.0',
        discipline: 'probability',
        acceptedAttacks: [{ reviewerType: 'ambiguity', checkClass: 'counterexample', contract: { evidence: 'two readings' } }],
        historyReRun: [{ checkClass: 'counterexample', result: 'pass' }],
        disciplineVerdict: { verdict: 'unverified', citation: null },
        defense: rubric([2, 2, 1], 'passed'),
        versions: [{ versionNumber: 1 }, { versionNumber: 2, diff: 'stem: added "without replacement"' }],
        publishedAt: '2026-03-04T10:15:00.000Z',
      };
      await seedPassport(db, { itemId, itemVersionId: versionIds[1]!, snapshot });

      await expect(deps.loadStoredPassport(itemId)).resolves.toEqual(snapshot);
    });

    it('returns the snapshot for the CURRENT published version after a republish', async () => {
      // Two frozen passports exist; the reader must not hand back the v1 record
      // for an item that has since been republished as v2.
      const { itemId, versionIds } = await seedPublishedItem();
      await seedPassport(db, {
        itemId,
        itemVersionId: versionIds[0]!,
        snapshot: { itemVersionId: versionIds[0], marker: 'v1' },
        publishedAt: new Date('2026-03-01T00:00:00.000Z'),
      });
      await seedPassport(db, {
        itemId,
        itemVersionId: versionIds[1]!,
        snapshot: { itemVersionId: versionIds[1], marker: 'v2' },
        publishedAt: new Date('2026-03-04T00:00:00.000Z'),
      });

      const loaded = await deps.loadStoredPassport(itemId);

      expect(loaded).toMatchObject({ itemVersionId: versionIds[1] });
      expect(await db.prisma.passport.count({ where: { itemId } })).toBe(2);
    });
  });

  // -- saveSnapshot ---------------------------------------------------------

  describe('saveSnapshot', () => {
    function snapshotFor(itemId: string, itemVersionId: string, publishedAt: string): Passport {
      return {
        itemId,
        itemVersionId,
        authorPseudonym: 'amber-lynx-7731',
        provenance: 'Team-authored, LA FORJA demo corpus.',
        license: 'CC-BY-4.0',
        discipline: 'probability',
        acceptedAttacks: [],
        historyReRun: [],
        disciplineVerdict: { verdict: 'unverified', citation: null },
        defense: { outcome: 'inconclusive' },
        versions: [{ versionNumber: 1 }],
        publishedAt,
      };
    }

    it('persists the snapshot as a stringified JSON column', async () => {
      const { itemId, versionIds } = await seedPublishedItem();
      const snapshot = snapshotFor(itemId, versionIds[1]!, '2026-03-04T10:15:00.000Z');

      await deps.saveSnapshot(snapshot);

      const row = await db.prisma.passport.findUnique({
        where: { itemId_itemVersionId: { itemId, itemVersionId: versionIds[1]! } },
      });
      expect(row).not.toBeNull();
      expect(typeof row!.snapshotJson).toBe('string');
      expect(fromJson<Passport>(row!.snapshotJson)).toEqual(snapshot);
    });

    it('stamps exactly ONE row per published version', async () => {
      // The composite uniqueness Passport(itemId, itemVersionId) is the schema
      // half of the freeze. A second publish of the SAME version must not add a
      // row — and must not raise, because the caller is idempotent by design.
      const { itemId, versionIds } = await seedPublishedItem();
      const first = snapshotFor(itemId, versionIds[1]!, '2026-03-04T10:15:00.000Z');

      await deps.saveSnapshot(first);
      await deps.saveSnapshot(first);

      expect(await db.prisma.passport.count({ where: { itemId, itemVersionId: versionIds[1]! } })).toBe(1);
    });

    it('does not let a re-save rewrite the frozen snapshot', async () => {
      // THE WHOLE POINT OF STORING RATHER THAN COMPUTING: what a judge already
      // inspected must not change underneath them. The first freeze stands.
      const { itemId, versionIds } = await seedPublishedItem();
      const original = snapshotFor(itemId, versionIds[1]!, '2026-03-04T10:15:00.000Z');
      const tampered: Passport = { ...original, license: 'unlicensed-ephemeral', publishedAt: '2026-09-09T00:00:00.000Z' };

      await deps.saveSnapshot(original);
      await deps.saveSnapshot(tampered);

      const row = await db.prisma.passport.findUnique({
        where: { itemId_itemVersionId: { itemId, itemVersionId: versionIds[1]! } },
      });
      expect(fromJson<Passport>(row!.snapshotJson)).toEqual(original);
    });

    it('gives a DISPUTED -> v2 -> republish cycle its OWN passport', async () => {
      // Scoping the snapshot to the item alone would overwrite v1's record on
      // republication, and the v1 passport a judge already read would silently
      // become a description of v2.
      const { itemId, versionIds } = await seedPublishedItem();
      const v1 = snapshotFor(itemId, versionIds[0]!, '2026-03-01T00:00:00.000Z');
      const v2 = snapshotFor(itemId, versionIds[1]!, '2026-03-04T00:00:00.000Z');

      await deps.saveSnapshot(v1);
      await deps.saveSnapshot(v2);

      expect(await db.prisma.passport.count({ where: { itemId } })).toBe(2);

      const storedV1 = await db.prisma.passport.findUnique({
        where: { itemId_itemVersionId: { itemId, itemVersionId: versionIds[0]! } },
      });
      const storedV2 = await db.prisma.passport.findUnique({
        where: { itemId_itemVersionId: { itemId, itemVersionId: versionIds[1]! } },
      });
      expect(fromJson<Passport>(storedV1!.snapshotJson)).toEqual(v1);
      expect(fromJson<Passport>(storedV2!.snapshotJson)).toEqual(v2);
    });
  });
});

// ===========================================================================
// 3. Defense persistence — recordQuestions / recordScoring (CODEX)
// ===========================================================================

/**
 * TELEMETRY THREADING. The two recorders must write a ModelCall row carrying
 * the EXACT model id, latency, tokens, prompt version and prompt hash (hard
 * constraint 3), and route.ts is explicit that they must NOT re-call the model
 * to get them: the telemetry travels on the record. `QuestionsRecord` /
 * `ScoringRecord` do not carry that field yet, so the spec names the shape it
 * needs. When Codex adds `telemetry: ModelCallResult<unknown>` to the two
 * interfaces, these aliases collapse into the real types and nothing here moves.
 */
type QuestionsRecordWithTelemetry = QuestionsRecord & { telemetry: ModelCallResult<unknown> };
type ScoringRecordWithTelemetry = ScoringRecord & { telemetry: ModelCallResult<unknown> };

/** Identity builders: they exist only to give an inline literal a name to be
 *  checked against, so `telemetry` is a known property rather than an excess one. */
function questionsRecord(record: QuestionsRecordWithTelemetry): QuestionsRecordWithTelemetry {
  return record;
}
function scoringRecord(record: ScoringRecordWithTelemetry): ScoringRecordWithTelemetry {
  return record;
}

describe('defense persistence (recordQuestions / recordScoring)', () => {
  let db: TestDb;
  let deps: DefenseDeps;

  beforeAll(async () => {
    db = await createTestDb();
    process.env.DATABASE_URL = db.url;
    // productionDeps() resolves the adjudicator model id from the environment.
    process.env.REVIEWER_MODEL ??= 'gpt-5.6-terra';
    process.env.ADJUDICATOR_MODEL ??= 'gpt-5.6-sol';
    delete (globalThis as { prisma?: unknown }).prisma;
    vi.resetModules();
    const routeModule = await import('@/app/api/defense/route');
    deps = routeModule.productionDeps();
  });

  afterEach(async () => {
    await db.reset();
  });

  afterAll(async () => {
    await db.teardown();
  });

  async function seedDefendableItem(state: 'DEFENSE' | 'DEFENSE_INCONCLUSIVE' = 'DEFENSE'): Promise<{
    itemId: string;
    itemVersionId: string;
  }> {
    const session = await seedSession(db);
    const { item, versions } = await seedItem(db, { sessionId: session.id, state });
    return { itemId: item.id, itemVersionId: versions[0]!.id };
  }

  const QUESTIONS = [
    { id: 'q1', prompt: 'Which conceptual error does the flagged distractor capture?' },
    { id: 'q2', prompt: 'Why is the marked key the only correct alternative?' },
  ];

  // -- recordQuestions ------------------------------------------------------

  describe('recordQuestions', () => {
    it('persists the two generated questions', async () => {
      const { itemId, itemVersionId } = await seedDefendableItem();
      const record: QuestionsRecordWithTelemetry = {
        itemId,
        itemVersionId,
        questions: QUESTIONS,
        state: 'DEFENSE',
        events: [],
        telemetry: telemetry(),
      };

      await deps.recordQuestions(record);

      const defense = await db.prisma.defense.findUnique({ where: { itemVersionId } });
      expect(defense).not.toBeNull();
      expect(fromJson<typeof QUESTIONS>(defense!.questionsJson)).toEqual(QUESTIONS);
      // Nothing has been answered yet, so nothing may look graded.
      expect(defense!.outcome).toBe('pending');
      expect(defense!.answersJson).toBeNull();
      expect(defense!.rubricJson).toBeNull();
      expect(defense!.totalScore).toBeNull();
    });

    it('persists the ModelCall telemetry row alongside it', async () => {
      const { itemId, itemVersionId } = await seedDefendableItem();
      const call = telemetry('gpt-5.6-sol');
      const record: QuestionsRecordWithTelemetry = {
        itemId,
        itemVersionId,
        questions: QUESTIONS,
        state: 'DEFENSE',
        events: [],
        telemetry: call,
      };

      await deps.recordQuestions(record);

      const defense = await db.prisma.defense.findUnique({ where: { itemVersionId } });
      const calls = await db.prisma.modelCall.findMany({ where: { defenseId: defense!.id } });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        callSite: 'viva',
        modelId: 'gpt-5.6-sol',
        modelFamilyOk: true,
        promptVersion: call.promptVersion,
        promptHash: call.promptHash,
        latencyMs: call.latencyMs,
        tokensIn: call.tokensIn ?? null,
        tokensOut: call.tokensOut ?? null,
      });
    });

    it('is idempotent for a version that already has a defense row', async () => {
      // Phase 1 can legitimately run twice (DEFENSE_RETRY), and Defense is
      // UNIQUE on itemVersionId: an insert-only recorder would throw here.
      const { itemId, itemVersionId } = await seedDefendableItem();
      await seedDefense(db, { itemVersionId, questions: [{ id: 'old', prompt: 'stale' }] });

      const record: QuestionsRecordWithTelemetry = {
        itemId,
        itemVersionId,
        questions: QUESTIONS,
        state: 'DEFENSE',
        events: [],
        telemetry: telemetry(),
      };
      await deps.recordQuestions(record);

      expect(await db.prisma.defense.count({ where: { itemVersionId } })).toBe(1);
      const defense = await db.prisma.defense.findUnique({ where: { itemVersionId } });
      expect(fromJson<typeof QUESTIONS>(defense!.questionsJson)).toEqual(QUESTIONS);
    });

    it('writes the resolved state when events were dispatched, and leaves it alone otherwise', async () => {
      const retry = await seedDefendableItem('DEFENSE_INCONCLUSIVE');
      await deps.recordQuestions(questionsRecord({
        itemId: retry.itemId,
        itemVersionId: retry.itemVersionId,
        questions: QUESTIONS,
        state: 'DEFENSE',
        events: ['DEFENSE_RETRY'],
        telemetry: telemetry(),
      }));
      expect((await db.prisma.item.findUnique({ where: { id: retry.itemId } }))!.state).toBe('DEFENSE');

      const plain = await seedDefendableItem('DEFENSE');
      await deps.recordQuestions(questionsRecord({
        itemId: plain.itemId,
        itemVersionId: plain.itemVersionId,
        questions: QUESTIONS,
        state: 'DEFENSE',
        events: [],
        telemetry: telemetry(),
      }));
      expect((await db.prisma.item.findUnique({ where: { id: plain.itemId } }))!.state).toBe('DEFENSE');
    });
  });

  // -- recordScoring --------------------------------------------------------

  describe('recordScoring', () => {
    const ANSWERS = [
      'Option C treats the two draws as independent.',
      'Only 3/10 satisfies P(A)·P(B|A) with the ball not returned.',
    ];

    it('persists the rubric, the total, the outcome and the answers', async () => {
      const { itemId, itemVersionId } = await seedDefendableItem();
      await seedDefense(db, { itemVersionId });
      const scored = rubric([2, 2, 1], 'passed');

      const record: ScoringRecordWithTelemetry = {
        itemId,
        itemVersionId,
        answers: ANSWERS,
        rubric: scored,
        outcome: 'passed',
        state: 'PUBLISHED',
        events: ['DEFENSE_PASSED'],
        telemetry: telemetry(),
      };
      await deps.recordScoring(record);

      const defense = await db.prisma.defense.findUnique({ where: { itemVersionId } });
      expect(fromJson<string[]>(defense!.answersJson!)).toEqual(ANSWERS);
      expect(fromJson<DefenseRubric>(defense!.rubricJson!)).toEqual(scored);
      expect(defense!.totalScore).toBe(5);
      expect(defense!.outcome).toBe('passed');

      expect((await db.prisma.item.findUnique({ where: { id: itemId } }))!.state).toBe('PUBLISHED');
    });

    it('persists the ModelCall telemetry row for the scoring call', async () => {
      const { itemId, itemVersionId } = await seedDefendableItem();
      await seedDefense(db, { itemVersionId });
      const call = telemetry('gpt-5.6-sol');

      await deps.recordScoring(scoringRecord({
        itemId,
        itemVersionId,
        answers: ANSWERS,
        rubric: rubric([1, 1, 1], 'failed'),
        outcome: 'failed',
        state: 'CHALLENGED',
        events: ['DEFENSE_FAILED'],
        telemetry: call,
      }));

      const defense = await db.prisma.defense.findUnique({ where: { itemVersionId } });
      const calls = await db.prisma.modelCall.findMany({ where: { defenseId: defense!.id } });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        callSite: 'viva',
        modelId: call.modelId,
        promptVersion: call.promptVersion,
        promptHash: call.promptHash,
        latencyMs: call.latencyMs,
      });
    });

    it('persists an evaluator failure AS inconclusive — never as a zero score that reads as a fail', async () => {
      // Doc §6.3. `failed` is a judgment of the student; `inconclusive` is a
      // statement about the grader. A row that stores totalScore 0 with outcome
      // 'failed' turns a broken evaluator into a bad grade, permanently, in the
      // audit trail — and that distinction is the entire reason the state exists.
      //
      // NOTE ON `rubricJson`: route.ts is explicit that the RECORD keeps the
      // inconclusive rubric even though the RESPONSE nulls it ("the zeros are a
      // placeholder for the audit trail"). So the rubric column may be written —
      // what is forbidden is anything that reads as a grade. Hence: the outcome
      // must be 'inconclusive', the total must be NULL rather than 0, and any
      // stored rubric must itself declare 'inconclusive'.
      const { itemId, itemVersionId } = await seedDefendableItem();
      await seedDefense(db, { itemVersionId });

      await deps.recordScoring(scoringRecord({
        itemId,
        itemVersionId,
        answers: ANSWERS,
        rubric: inconclusiveRubric(),
        outcome: 'inconclusive',
        state: 'DEFENSE_INCONCLUSIVE',
        events: ['DEFENSE_EVALUATOR_FAILED'],
        telemetry: telemetry(),
      }));

      const defense = await db.prisma.defense.findUnique({ where: { itemVersionId } });
      expect(defense!.outcome).toBe('inconclusive');
      expect(defense!.outcome).not.toBe('failed');
      expect(defense!.totalScore).toBeNull();
      if (defense!.rubricJson !== null) {
        expect(fromJson<DefenseRubric>(defense!.rubricJson).outcome).toBe('inconclusive');
      }

      // And it stays recoverable: the item sits in DEFENSE_INCONCLUSIVE, from
      // which DEFENSE_RETRY is a legal transition.
      expect((await db.prisma.item.findUnique({ where: { id: itemId } }))!.state).toBe(
        'DEFENSE_INCONCLUSIVE',
      );
    });
  });

  // -- the audit trail as a whole ------------------------------------------

  it('leaves no ModelCall row without a model id or an owner', async () => {
    // Hard constraint 3 + the compliance audit. A row with no model id proves
    // nothing about which family served the call, and a row with all three
    // foreign keys null is an orphan nothing can be traced back to.
    const { itemId, itemVersionId } = await seedDefendableItem();
    await deps.recordQuestions(questionsRecord({
      itemId,
      itemVersionId,
      questions: QUESTIONS,
      state: 'DEFENSE',
      events: [],
      telemetry: telemetry(),
    }));
    await deps.recordScoring(scoringRecord({
      itemId,
      itemVersionId,
      answers: ['a', 'b'],
      rubric: rubric([2, 2, 2], 'passed'),
      outcome: 'passed',
      state: 'PUBLISHED',
      events: ['DEFENSE_PASSED'],
      telemetry: telemetry(),
    }));

    const calls = await db.prisma.modelCall.findMany();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.modelId).not.toBe('');
      expect(call.modelId.startsWith('gpt-5.6')).toBe(true);
      expect(call.modelFamilyOk).toBe(true);
      expect(call.gauntletRunId ?? call.itemVersionId ?? call.defenseId).not.toBeNull();
    }
  });
});
