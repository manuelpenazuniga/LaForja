/**
 * REGRESSION TEST — the recorded-check shape must exist in all THREE places.
 *
 * The defect this locks down: `ExecutableRecordedCheck` declared
 * verificationKind / invariantId / executorVersion / thresholdVersion as the
 * identity that makes a check re-executable, but NOTHING produced them — they
 * were neither a `Check` column nor a field on `AdjudicatedCheck`. The history
 * re-run engine could therefore never rebuild a check to re-execute it, which
 * makes the "strict non-regression" promise of doc §5 unimplementable as
 * specified.
 *
 * A type that only one layer knows about is not a contract, it is a comment. So
 * these tests assert the full loop: adjudication PRODUCES the shape, Prisma
 * PERSISTS it, and the boundary schema REJECTS anything that would break the
 * re-run.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHECK_CLASS_BY_VERIFICATION,
  RecordedCheckRowSchema,
  checkClassFor,
  isExecutableClass,
} from '@/core/checks';
import type { ExecutableRecordedCheck, RecordedCheck } from '@/core/checks';
import { adjudicate } from '@/reviewers/adjudication';
import type { AdjudicatedCheck } from '@/reviewers/adjudication';
import { REVIEWER_TYPES, VERIFICATION_KINDS } from '@/core/types';
import type { OrchestrationResult } from '@/reviewers/orchestrator';

const SCHEMA_SOURCE = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');

/** The `model Check { ... }` block, isolated so a match cannot leak from a neighbour. */
const CHECK_MODEL = (() => {
  const start = SCHEMA_SOURCE.indexOf('model Check {');
  expect(start).toBeGreaterThan(-1);
  const end = SCHEMA_SOURCE.indexOf('\n}', start);
  return SCHEMA_SOURCE.slice(start, end);
})();

const DETERMINISTIC_ROW = {
  id: 'chk_1',
  reviewerType: 'discipline' as const,
  verificationKind: 'solver' as const,
  checkClass: 'deterministic' as const,
  status: 'accepted' as const,
  invariantId: 'solver_key_matches',
  executorVersion: 'solver@1.2.0',
  thresholdVersion: 'thresholds@1.0.0',
};

const SEMANTIC_ROW = {
  id: 'chk_2',
  reviewerType: 'distractor' as const,
  verificationKind: 'interpretation' as const,
  checkClass: 'semantic' as const,
  status: 'hypothesis' as const,
  invariantId: null,
  executorVersion: null,
  thresholdVersion: null,
};

// ---------------------------------------------------------------------------
// 1. PERSISTENCE — the columns exist, so the values survive the version bump.
// ---------------------------------------------------------------------------
describe('prisma Check — the re-execution identity is PERSISTED', () => {
  it.each(['verificationKind', 'invariantId', 'executorVersion', 'thresholdVersion'])(
    'model Check declares a `%s` column',
    (column) => {
      expect(CHECK_MODEL).toMatch(new RegExp(`^\\s*${column}\\s+String`, 'm'));
    },
  );

  it('keeps verificationKind NON-null: every check was verified somehow', () => {
    expect(CHECK_MODEL).toMatch(/^\s*verificationKind\s+String(?!\?)/m);
  });

  it('keeps the executor identity nullable — semantic checks have no executor', () => {
    for (const column of ['invariantId', 'executorVersion', 'thresholdVersion']) {
      expect(CHECK_MODEL).toMatch(new RegExp(`^\\s*${column}\\s+String\\?`, 'm'));
    }
  });

  it('indexes invariantId: the re-run resolves an executor by that id', () => {
    expect(CHECK_MODEL).toMatch(/@@index\(\[invariantId\]\)/);
  });

  it('uses String columns, never a SQLite enum', () => {
    expect(SCHEMA_SOURCE).not.toMatch(/^enum /m);
  });
});

// ---------------------------------------------------------------------------
// 2. PRODUCTION — adjudication is what assigns the kind, so it must carry it.
// ---------------------------------------------------------------------------
describe('AdjudicatedCheck — adjudication PRODUCES the recorded shape', () => {
  it('an adjudicated executable check satisfies the persistence boundary', () => {
    const produced: AdjudicatedCheck = {
      reviewerType: 'discipline',
      verificationKind: 'solver',
      checkClass: 'deterministic',
      status: 'accepted',
      contract: { claim: 'P(A|B) is 1/11, not 1/2' },
      schemaValid: true,
      invariantId: 'solver_key_matches',
      executorVersion: 'solver@1.2.0',
      thresholdVersion: 'thresholds@1.0.0',
    };

    expect(RecordedCheckRowSchema.safeParse({ id: 'chk_1', ...produced }).success).toBe(true);
  });

  it('an adjudicated check maps onto a RecordedCheck field for field', () => {
    const produced: AdjudicatedCheck = {
      reviewerType: 'ambiguity',
      verificationKind: 'interpretation',
      checkClass: 'counterexample',
      status: 'accepted',
      contract: { evidence: 'two readings' },
      schemaValid: true,
      invariantId: 'ambiguity_two_readings_disagree',
      executorVersion: 'solver@1.2.0',
      thresholdVersion: 'thresholds@1.0.0',
    };

    // Compiles ONLY while the two shapes agree — this is the regression guard.
    const recorded: ExecutableRecordedCheck = {
      id: 'chk_3',
      reviewerType: 'ambiguity',
      verificationKind: produced.verificationKind,
      checkClass: 'counterexample',
      contract: produced.contract,
      invariantId: produced.invariantId!,
      executorVersion: produced.executorVersion!,
      thresholdVersion: produced.thresholdVersion!,
    };

    expect(recorded.invariantId).toBe('ambiguity_two_readings_disagree');
    expect(isExecutableClass(recorded.checkClass)).toBe(true);
  });

  it('a semantic recorded check carries NO executor identity', () => {
    const recorded: RecordedCheck = {
      id: 'chk_4',
      reviewerType: 'distractor',
      verificationKind: 'interpretation',
      checkClass: 'semantic',
      contract: {},
    };

    expect(isExecutableClass(recorded.checkClass)).toBe(false);
    expect('invariantId' in recorded).toBe(false);
  });

  it('is a MODEL CALL SITE: adjudicate is async, not synchronous', async () => {
    const result = adjudicate({} as OrchestrationResult, 'gpt-5.6-adjudicator');
    expect(result).toBeInstanceOf(Promise);
    // Still a Codex stub; what is asserted here is the SHAPE of the call site.
    await expect(result).rejects.toThrow(/TODO\(codex\)/);
  });
});

// ---------------------------------------------------------------------------
// 3. THE BOUNDARY — a row that cannot be re-executed must never be stored.
// ---------------------------------------------------------------------------
describe('RecordedCheckRowSchema — fail-closed at the persistence boundary', () => {
  it('accepts a well-formed deterministic row', () => {
    expect(RecordedCheckRowSchema.safeParse(DETERMINISTIC_ROW).success).toBe(true);
  });

  it('accepts a well-formed semantic row', () => {
    expect(RecordedCheckRowSchema.safeParse(SEMANTIC_ROW).success).toBe(true);
  });

  it.each(['invariantId', 'executorVersion', 'thresholdVersion'])(
    'rejects a deterministic row missing %s — non-regression would be unverifiable',
    (field) => {
      const row = { ...DETERMINISTIC_ROW, [field]: null };
      const parsed = RecordedCheckRowSchema.safeParse(row);
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain(field);
    },
  );

  it('rejects a blank invariantId: whitespace is not an identity', () => {
    expect(
      RecordedCheckRowSchema.safeParse({ ...DETERMINISTIC_ROW, invariantId: '   ' }).success,
    ).toBe(false);
  });

  it('rejects a semantic row that claims an executor', () => {
    const parsed = RecordedCheckRowSchema.safeParse({
      ...SEMANTIC_ROW,
      invariantId: 'solver_key_matches',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an illegal (reviewerType, verificationKind) pair instead of downgrading it', () => {
    // The ambiguity reviewer never calls the solver directly.
    const parsed = RecordedCheckRowSchema.safeParse({
      ...DETERMINISTIC_ROW,
      reviewerType: 'ambiguity',
      verificationKind: 'solver',
    });
    expect(parsed.success).toBe(false);
    // The dangerous failure mode is a silent fallback to 'semantic', which
    // would quietly convert a hard block into a judgment that never blocks.
    expect(JSON.stringify(parsed.error?.issues)).not.toContain('"semantic"');
  });

  it('rejects a class that disagrees with CHECK_CLASS_BY_VERIFICATION', () => {
    const parsed = RecordedCheckRowSchema.safeParse({
      ...DETERMINISTIC_ROW,
      checkClass: 'semantic',
      invariantId: null,
      executorVersion: null,
      thresholdVersion: null,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a verificationKind outside the value set owned by core/types', () => {
    expect(
      RecordedCheckRowSchema.safeParse({ ...DETERMINISTIC_ROW, verificationKind: 'vibes' }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. THE MAP — the taxonomy the adjudication TODO spec commits to.
// ---------------------------------------------------------------------------
describe('CHECK_CLASS_BY_VERIFICATION — the assignment adjudication must follow', () => {
  it('covers every (reviewerType, verificationKind) pair exactly once', () => {
    for (const reviewerType of REVIEWER_TYPES) {
      for (const kind of VERIFICATION_KINDS) {
        expect(CHECK_CLASS_BY_VERIFICATION[reviewerType]).toHaveProperty(kind);
      }
    }
  });

  it('assigns the four classes named in the adjudication spec', () => {
    expect(checkClassFor('discipline', 'solver')).toBe('deterministic');
    expect(checkClassFor('discipline', 'citation')).toBe('semantic');
    expect(checkClassFor('ambiguity', 'interpretation')).toBe('counterexample');
    expect(checkClassFor('item_probe', 'heuristic')).toBe('deterministic');
  });

  it('treats only deterministic and counterexample as re-executable', () => {
    expect(isExecutableClass('deterministic')).toBe(true);
    expect(isExecutableClass('counterexample')).toBe(true);
    expect(isExecutableClass('semantic')).toBe(false);
  });
});
