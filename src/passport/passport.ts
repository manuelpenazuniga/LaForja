/**
 * LA FORJA — item passport (doc §6.4). ITEM-LEVEL ONLY, never student-level.
 *
 * OWNER: Codex (assembly). Claude fixes the shape so "no school/city" and
 * "random pseudonym" are enforced by the type system (tests/passport.test.ts
 * asserts the schema has no such fields).
 *
 * Fields (doc §6.4):
 *  - provenance & license
 *  - accepted attacks with counterexamples
 *  - history re-run result BY CHECK CLASS
 *  - discipline verdict with full citation OR `unverified`
 *  - defense rubric (or `inconclusive`)
 *  - version history with diff
 *  - author: random pseudonym
 */
import type { CheckClass, DefenseRubric, DisciplineVerdict, Citation } from '../core/types';

export interface PassportAttack {
  reviewerType: string;
  checkClass: CheckClass;
  /** The accepted counterexample / evidence contract, for display. */
  contract: unknown;
}

export interface PassportHistoryEntry {
  checkClass: CheckClass;
  result: 'pass' | 'regressed' | 'readjudicated' | 'inconclusive';
  detail?: string;
}

export interface PassportVersion {
  versionNumber: number;
  diff?: string;
}

/**
 * The frozen passport snapshot. INTENTIONALLY has NO school, city, or any
 * student-identifying field (doc §6.4, §9). Author is a random pseudonym only.
 */
export interface Passport {
  itemId: string;
  itemVersionId: string;
  authorPseudonym: string; // random; the ONLY author field
  provenance: string;
  license: string; // team items: CC-BY
  discipline: string;
  acceptedAttacks: PassportAttack[];
  historyReRun: PassportHistoryEntry[]; // by check class
  disciplineVerdict: { verdict: DisciplineVerdict; citation: Citation | null };
  defense: DefenseRubric | { outcome: 'inconclusive' };
  versions: PassportVersion[];
  publishedAt: string; // ISO timestamp, set by the caller (not Date.now in tests)
}

/**
 * TODO(codex): assemble the passport for a published item.
 *  - Read the Item + its versions, accepted checks, history re-runs, discipline
 *    verdict (with citation or unverified), and the defense rubric.
 *  - Populate the Passport above; author = the session pseudonym (no PII).
 *  - Persist a frozen snapshot (Passport model, snapshotJson). Immutable.
 * Reference: doc §6.4.
 */
export async function buildPassport(_itemId: string): Promise<Passport> {
  throw new Error('TODO(codex): implement item passport assembly');
}
