/**
 * LA FORJA — throwaway SQLite database harness for the persistence suites.
 *
 * OWNER: Claude (test infrastructure). This file is NOT a stub: it must work
 * today, and tests/persistence.test.ts opens with a non-skipped suite that
 * proves it does. Infrastructure nobody verified is infrastructure nobody
 * should trust.
 *
 * ---------------------------------------------------------------------------
 * WHY A REAL DATABASE AND NOT A FAKE REPOSITORY
 * ---------------------------------------------------------------------------
 * Everything the persistence stubs do IS talking to the database. A fake
 * repository would assert that our fake remembers what we told it — it cannot
 * catch a wrong `where` clause, a `...Json` column crossed without
 * `toJson`/`fromJson`, a missing relation, or the composite uniqueness on
 * Passport(itemId, itemVersionId) that the frozen-snapshot promise rests on.
 * Those are exactly the failures this harness exists to expose, and SQLite
 * makes a real database cheap: one file, no server, deleted per run.
 *
 * ---------------------------------------------------------------------------
 * COST (measured, so nobody has to wonder)
 * ---------------------------------------------------------------------------
 * `prisma db push` against an empty SQLite file takes ~0.5s wall clock. That is
 * paid ONCE per worker process: the first `createTestDb()` pushes the schema
 * into a template file, and every database after that is a ~170KB `copyFile`
 * (sub-millisecond). Per-test isolation is `reset()` — ordered `deleteMany`s —
 * not a fresh push, for the same reason.
 *
 * There are no migrations in this repo, so `db push` is the schema source; it
 * reads prisma/schema.prisma directly, needs no network, and the local
 * `node_modules/.bin/prisma` binary is invoked instead of `npx` so no registry
 * lookup can ever happen.
 *
 * ---------------------------------------------------------------------------
 * PARALLEL SAFETY
 * ---------------------------------------------------------------------------
 * Vitest runs test files in separate worker processes. Every path below is
 * keyed by pid AND a random suffix, so two workers — or two runs of the same
 * suite — cannot collide on a file name.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaClient } from '@prisma/client';
import type {
  Check,
  Defense,
  HistoryReRun,
  HistoryRunBatch,
  Item,
  ItemVersion,
  Passport as PassportRow,
  Session,
} from '@prisma/client';

import { toJson } from '@/db/client';
import { CHECK_CLASS_BY_VERIFICATION } from '@/core/checks';
import type {
  CheckClass,
  CheckStatus,
  Citation,
  DefenseRubric,
  ItemState,
  ReviewerType,
  VerificationKind,
} from '@/core/types';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PRISMA_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'prisma');
const SCHEMA_PATH = join(REPO_ROOT, 'prisma', 'schema.prisma');

// ---------------------------------------------------------------------------
// The template database (schema pushed once per process)
// ---------------------------------------------------------------------------

let templatePath: string | undefined;

/**
 * Push prisma/schema.prisma into a single template file, once per process.
 * Synchronous on purpose: `createTestDb` may be called from several `beforeAll`
 * hooks and a lazily-awaited promise would let two of them race the push.
 */
function ensureTemplate(): string {
  if (templatePath !== undefined) return templatePath;

  const dir = mkdtempSync(join(tmpdir(), `forja-testdb-template-${process.pid}-`));
  const file = join(dir, 'template.db');

  execFileSync(PRISMA_BIN, ['db', 'push', '--schema', SCHEMA_PATH, '--skip-generate', '--accept-data-loss'], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: `file:${file}` },
    stdio: 'pipe',
  });

  if (!existsSync(file)) {
    throw new Error(`prisma db push reported success but produced no file at ${file}`);
  }

  // The template outlives individual test databases, so it is reaped when the
  // worker exits rather than by any one teardown.
  process.once('exit', () => {
    rmSync(dir, { recursive: true, force: true });
  });

  templatePath = file;
  return file;
}

// ---------------------------------------------------------------------------
// The handle
// ---------------------------------------------------------------------------

export interface TestDb {
  /** A client bound to THIS database file, not to `process.env.DATABASE_URL`. */
  readonly prisma: PrismaClient;
  /** Connection string, e.g. `file:/var/folders/…/test.db`. */
  readonly url: string;
  /** Absolute path of the database file. */
  readonly filePath: string;
  /** Empty every table, preserving the schema. Per-test isolation. */
  reset(): Promise<void>;
  /** Disconnect and delete the database directory. */
  teardown(): Promise<void>;
}

/**
 * Create a fresh, empty database with the current schema applied.
 *
 * The returned client is bound explicitly through `datasources`, so a test can
 * use this harness without touching `process.env.DATABASE_URL` — and a test
 * that DOES need the app's own `prisma` singleton (which reads the env var) can
 * point it at `db.url` before importing the module under test.
 */
export async function createTestDb(): Promise<TestDb> {
  const template = ensureTemplate();

  const dir = mkdtempSync(join(tmpdir(), `forja-testdb-${process.pid}-`));
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, 'test.db');
  copyFileSync(template, filePath);

  const url = `file:${filePath}`;
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  await prisma.$connect();

  return {
    prisma,
    url,
    filePath,
    async reset(): Promise<void> {
      await resetTestDb(prisma);
    },
    async teardown(): Promise<void> {
      await prisma.$disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Delete every row, child-first.
 *
 * The order is not cosmetic. Prisma emits real foreign keys on SQLite, which
 * enforces them per row, so a table must be emptied before anything it points
 * at. Two cases the order alone cannot cover:
 *  - `Item.currentVersionId` points FORWARD into ItemVersion, so it is nulled
 *    before versions are deleted;
 *  - `ItemVersion.previousVersionId` is a SELF reference, so versions are
 *    deleted newest-first instead of in one statement.
 */
async function resetTestDb(prisma: PrismaClient): Promise<void> {
  await prisma.passport.deleteMany();
  await prisma.historyReRun.deleteMany();
  await prisma.historyRunBatch.deleteMany();
  await prisma.modelCall.deleteMany();
  await prisma.defense.deleteMany();
  await prisma.check.deleteMany();
  await prisma.citation.deleteMany();
  await prisma.gauntletRun.deleteMany();

  await prisma.item.updateMany({ data: { currentVersionId: null } });

  const versions = await prisma.itemVersion.findMany({
    orderBy: { versionNumber: 'desc' },
    select: { id: true },
  });
  for (const version of versions) {
    await prisma.itemVersion.delete({ where: { id: version.id } });
  }

  await prisma.item.deleteMany();
  await prisma.session.deleteMany();
}

// ---------------------------------------------------------------------------
// Seeding helpers
//
// Defaults are chosen so that the COMMON case is one call: a valid, complete,
// publishable-looking row. Every field a test wants to make wrong is
// overridable — a test that seeds a broken row should say so out loud, and a
// test that does not care about a field should not have to name it.
// ---------------------------------------------------------------------------

export interface SeedSessionInput {
  pseudonym?: string;
  /** Minutes from now until `expiresAt`. Negative seeds an EXPIRED session. */
  ttlMinutes?: number;
}

export async function seedSession(db: TestDb, input: SeedSessionInput = {}): Promise<Session> {
  const ttlMinutes = input.ttlMinutes ?? 30;
  return db.prisma.session.create({
    data: {
      pseudonym: input.pseudonym ?? 'quiet-otter-4417',
      expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
    },
  });
}

export interface SeedVersionInput {
  /** Defaults to its 1-based position in the `versions` array. */
  versionNumber?: number;
  stem?: string;
  options?: string[];
  correctKey?: string;
  authorRationale?: string;
  /** Stored through `toJson` into `diffJson`. */
  diff?: unknown;
  /** True once PUBLISHED. */
  immutable?: boolean;
}

export interface SeedItemInput {
  sessionId: string;
  state?: ItemState;
  discipline?: string;
  provenance?: string;
  license?: string;
  isTeamAuthored?: boolean;
  publicationEligible?: boolean;
  isDemo?: boolean;
  /** Defaults to a single v1. Lineage (`previousVersionId`) is wired in order. */
  versions?: SeedVersionInput[];
  /** Which version `Item.currentVersionId` points at. Defaults to the last. */
  currentVersion?: 'last' | 'none';
}

export interface SeededItem {
  item: Item;
  /** In ascending `versionNumber` order. */
  versions: ItemVersion[];
}

export async function seedItem(db: TestDb, input: SeedItemInput): Promise<SeededItem> {
  const specs = input.versions ?? [{}];

  const item = await db.prisma.item.create({
    data: {
      sessionId: input.sessionId,
      discipline: input.discipline ?? 'probability',
      provenance: input.provenance ?? 'Team-authored for the LA FORJA demo corpus.',
      license: input.license ?? 'CC-BY-4.0',
      isTeamAuthored: input.isTeamAuthored ?? true,
      publicationEligible: input.publicationEligible ?? true,
      isDemo: input.isDemo ?? false,
      state: input.state ?? 'DRAFT',
    },
  });

  const versions: ItemVersion[] = [];
  for (const [index, spec] of specs.entries()) {
    const previous = versions[index - 1];
    const created = await db.prisma.itemVersion.create({
      data: {
        itemId: item.id,
        versionNumber: spec.versionNumber ?? index + 1,
        stem: spec.stem ?? 'An urn holds 3 red and 2 blue balls. Two are drawn without replacement.',
        optionsJson: toJson(spec.options ?? ['3/10', '3/5', '1/10', '2/5']),
        correctKey: spec.correctKey ?? 'B',
        authorRationale: spec.authorRationale ?? 'Complementary counting over ordered pairs.',
        diffJson: spec.diff === undefined ? null : toJson(spec.diff),
        previousVersionId: previous ? previous.id : null,
        immutable: spec.immutable ?? false,
      },
    });
    versions.push(created);
  }

  const last = versions[versions.length - 1];
  if ((input.currentVersion ?? 'last') === 'last' && last) {
    const updated = await db.prisma.item.update({
      where: { id: item.id },
      data: { currentVersionId: last.id },
    });
    return { item: updated, versions };
  }

  return { item, versions };
}

export interface SeedCheckInput {
  itemVersionId: string;
  reviewerType: ReviewerType;
  verificationKind: VerificationKind;
  status?: CheckStatus;
  /**
   * Defaults to CHECK_CLASS_BY_VERIFICATION — the same map the runtime uses, so
   * a seeded row cannot quietly disagree with production about its own class.
   * Pass explicitly only to seed a deliberately inconsistent row.
   */
  checkClass?: CheckClass;
  /** Stored through `toJson` into `contractJson`. */
  contract?: unknown;
  gauntletRunId?: string;
  schemaValid?: boolean;
  /**
   * Re-execution identity. Defaulted for the executable classes, because
   * RecordedCheckRowSchema refuses a deterministic/counterexample row without
   * them; left null for semantic, which has no executor to name.
   */
  invariantId?: string;
  executorVersion?: string;
  thresholdVersion?: string;
  /** A discipline `correct` verdict needs one (doc §6.2). */
  citation?: Citation;
}

export async function seedCheck(db: TestDb, input: SeedCheckInput): Promise<Check> {
  const mapped = CHECK_CLASS_BY_VERIFICATION[input.reviewerType][input.verificationKind];
  const checkClass = input.checkClass ?? mapped;
  if (checkClass === null) {
    throw new Error(
      `seedCheck: (${input.reviewerType}, ${input.verificationKind}) is not a legal ` +
        'combination; pass `checkClass` explicitly to seed a deliberately invalid row.',
    );
  }

  const executable = checkClass === 'deterministic' || checkClass === 'counterexample';

  const citationId = input.citation
    ? (
        await db.prisma.citation.create({
          data: {
            sourceId: input.citation.source_id,
            versionDate: input.citation.version_date,
            license: input.citation.license,
            excerpt: input.citation.excerpt,
            relevance: input.citation.relevance,
          },
        })
      ).id
    : null;

  return db.prisma.check.create({
    data: {
      itemVersionId: input.itemVersionId,
      gauntletRunId: input.gauntletRunId ?? null,
      reviewerType: input.reviewerType,
      verificationKind: input.verificationKind,
      checkClass,
      status: input.status ?? 'proposed',
      schemaValid: input.schemaValid ?? true,
      contractJson: toJson(input.contract ?? { evidence: 'seeded evidence contract' }),
      invariantId: input.invariantId ?? (executable ? 'solver_key_matches' : null),
      executorVersion: input.executorVersion ?? (executable ? 'probability-solver-v1' : null),
      thresholdVersion: input.thresholdVersion ?? (executable ? 'thresholds-v1' : null),
      citationId,
    },
  });
}

export interface SeedReRunInput {
  originalCheckId: string;
  checkClass: CheckClass;
  result: 'pass' | 'regressed' | 'readjudicated' | 'inconclusive';
  /** Stored through `toJson` into `detailsJson`. */
  details?: unknown;
}

export interface SeedHistoryBatchInput {
  /** The NEW version being validated. */
  itemVersionId: string;
  reRuns?: SeedReRunInput[];
  /** Defaults to `reRuns.length` — the honest count for a complete batch. */
  expectedCheckCount?: number;
  completedCheckCount?: number;
  status?: 'complete' | 'incomplete' | 'failed';
  blocksPublish?: boolean;
  completedAt?: Date | null;
}

export interface SeededHistoryBatch {
  batch: HistoryRunBatch;
  reRuns: HistoryReRun[];
}

export async function seedHistoryBatch(
  db: TestDb,
  input: SeedHistoryBatchInput,
): Promise<SeededHistoryBatch> {
  const reRunSpecs = input.reRuns ?? [];

  const batch = await db.prisma.historyRunBatch.create({
    data: {
      itemVersionId: input.itemVersionId,
      expectedCheckCount: input.expectedCheckCount ?? reRunSpecs.length,
      completedCheckCount: input.completedCheckCount ?? reRunSpecs.length,
      status: input.status ?? 'complete',
      blocksPublish: input.blocksPublish ?? false,
      completedAt: input.completedAt === undefined ? new Date() : input.completedAt,
    },
  });

  const reRuns: HistoryReRun[] = [];
  for (const spec of reRunSpecs) {
    reRuns.push(
      await db.prisma.historyReRun.create({
        data: {
          batchId: batch.id,
          itemVersionId: input.itemVersionId,
          originalCheckId: spec.originalCheckId,
          checkClass: spec.checkClass,
          result: spec.result,
          detailsJson: spec.details === undefined ? null : toJson(spec.details),
        },
      }),
    );
  }

  return { batch, reRuns };
}

export interface SeedDefenseInput {
  itemVersionId: string;
  /** Stored through `toJson` into `questionsJson`. Defaults to the two questions. */
  questions?: unknown;
  answers?: string[];
  rubric?: DefenseRubric;
  totalScore?: number;
  outcome?: 'pending' | 'passed' | 'failed' | 'inconclusive';
}

export async function seedDefense(db: TestDb, input: SeedDefenseInput): Promise<Defense> {
  return db.prisma.defense.create({
    data: {
      itemVersionId: input.itemVersionId,
      questionsJson: toJson(
        input.questions ?? [
          { id: 'q1', prompt: 'Which conceptual error does option C capture?' },
          { id: 'q2', prompt: 'Why is option B the only correct alternative?' },
        ],
      ),
      answersJson: input.answers === undefined ? null : toJson(input.answers),
      rubricJson: input.rubric === undefined ? null : toJson(input.rubric),
      totalScore: input.totalScore ?? input.rubric?.total ?? null,
      outcome: input.outcome ?? 'pending',
    },
  });
}

export interface SeedPassportInput {
  itemId: string;
  itemVersionId: string;
  /** Stored through `toJson` into `snapshotJson`. */
  snapshot: unknown;
  publishedAt?: Date;
}

export async function seedPassport(db: TestDb, input: SeedPassportInput): Promise<PassportRow> {
  return db.prisma.passport.create({
    data: {
      itemId: input.itemId,
      itemVersionId: input.itemVersionId,
      snapshotJson: toJson(input.snapshot),
      ...(input.publishedAt === undefined ? {} : { publishedAt: input.publishedAt }),
    },
  });
}
