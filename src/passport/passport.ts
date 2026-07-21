/**
 * LA FORJA — item passport (doc §6.4). ITEM-LEVEL ONLY, never student-level.
 *
 * OWNER: Codex (assembly). Claude fixes the shape so "no school/city" and
 * "random pseudonym" are enforced by the type system (tests/passportShape.test.ts
 * asserts the schema has no such fields) and fixes the SEAM so the assembly
 * itself is verifiable offline (tests/passport.test.ts).
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
import type {
  CheckClass,
  CheckStatus,
  Citation,
  DefenseRubric,
  DisciplineVerdict,
  ItemState,
  ReviewerType,
} from '../core/types';
import type { HistoryRunBatch, ReadjudicatedVerdict } from '../core/checks';

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
  /**
   * The structured re-adjudication a SEMANTIC re-run produced (doc §6.4: "the
   * passport renders `verdict`, not `detail`"). Present only on semantic
   * entries whose result is 'readjudicated'; a semantic entry the adjudicator
   * could not resolve carries no verdict, because none was produced.
   */
  verdict?: ReadjudicatedVerdict;
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
 * The canonical order the three classes are presented in. Grouping is not
 * cosmetic: the three classes carry three DIFFERENT promises (doc §5), and a
 * flat interleaved list invites a reader to apply the deterministic promise to
 * a semantic row.
 */
export const PASSPORT_CLASS_ORDER: readonly CheckClass[] = [
  'deterministic',
  'counterexample',
  'semantic',
] as const;

// ---------------------------------------------------------------------------
// THE SEAM
//
// Assembly is the step where a correct TYPE can still be filled with the wrong
// DATA — an abstention shown as an accepted attack, a `correct` verdict with no
// citation, an inconclusive defense rendered as a pass. None of that is
// reachable from the type system, so it has to be exercised. Following the
// pattern used by VivaDeps (src/defense/viva.ts) and the transport seam, the
// data source is a dependency with a production default, and the suite drives
// `buildPassport` with fixtures and no database.
// ---------------------------------------------------------------------------

/** One recorded check as the passport reads it — status included, deliberately. */
export interface PassportSourceCheck {
  id: string;
  reviewerType: ReviewerType;
  checkClass: CheckClass;
  /**
   * Loaded UNFILTERED. The source hands over rejected, abstained and hypothesis
   * checks too, and it is `buildPassport` that must drop them: filtering
   * upstream would make "only accepted findings are presented as attacks"
   * untestable at the point where it is actually decided.
   */
  status: CheckStatus;
  contract: unknown;
}

export interface PassportSourceVersion {
  id: string;
  versionNumber: number;
  diff?: string;
}

/** Everything assembly is allowed to read. Note what is NOT here: any PII. */
export interface PassportSourceRecord {
  itemId: string;
  /** Only PUBLISHED yields a passport (doc §6.4). */
  itemState: ItemState;
  /** The version being certified. */
  publishedVersionId: string;
  /** ISO-8601, supplied by the caller/source — never `Date.now()` in assembly. */
  publishedAt: string;
  /** The session pseudonym. The ONLY author-bearing datum that may be read. */
  authorPseudonym: string;
  provenance: string;
  license: string;
  discipline: string;
  checks: PassportSourceCheck[];
  /**
   * The history re-run batch for the published version, or null when the item
   * was never repaired (a v1 that went GAUNTLET_CLEAN -> DEFENSE -> PUBLISHED
   * has no history to re-run). Null on a MULTI-version item is a missing proof,
   * not an absence of work, and must be refused.
   */
  historyBatch: HistoryRunBatch | null;
  /** Null ⇒ the passport shows `unverified` with no citation. */
  disciplineVerdict: { verdict: DisciplineVerdict; citation: Citation | null } | null;
  /** Null ⇒ the passport shows `inconclusive` (doc §6.3: never an auto-reject). */
  defense: DefenseRubric | null;
  versions: PassportSourceVersion[];
}

export interface PassportDeps {
  /** Load everything needed to assemble; null when the item does not exist. */
  loadPassportSource(itemId: string): Promise<PassportSourceRecord | null>;
  /**
   * The already-frozen snapshot for this item, if one was stamped. THE REASON
   * THE PASSPORT IS STORED AND NOT COMPUTED ON READ: a later edit to an
   * upstream row must not retroactively rewrite what a judge already inspected.
   */
  loadStoredPassport(itemId: string): Promise<Passport | null>;
  /** Persist the frozen snapshot. Called exactly once per published version. */
  saveSnapshot(passport: Passport): Promise<void>;
}

/**
 * TODO(codex): production wiring — read Item / ItemVersion / Check / Citation /
 * HistoryRunBatch / HistoryReRun / Defense / Passport through `prisma`
 * (src/db/client.ts), crossing every `...Json` column with `fromJson`/`toJson`.
 */
export const DEFAULT_PASSPORT_DEPS: PassportDeps = {
  loadPassportSource(): Promise<PassportSourceRecord | null> {
    throw new Error('TODO(codex): implement the Prisma-backed passport source loader');
  },
  loadStoredPassport(): Promise<Passport | null> {
    throw new Error('TODO(codex): implement the frozen-snapshot loader');
  },
  saveSnapshot(): Promise<void> {
    throw new Error('TODO(codex): implement frozen-snapshot persistence');
  },
};

/**
 * TODO(codex): assemble the passport for a published item.
 *
 * THE FREEZE COMES FIRST. If `loadStoredPassport` returns a snapshot, RETURN IT
 * VERBATIM and do not re-assemble and do not save again. Everything below only
 * ever runs on the first build.
 *
 * Then the refusals, before any field is populated — a passport that should not
 * exist must not be assembled and then discarded by a caller:
 *  - `itemState !== 'PUBLISHED'` ⇒ throw. There is no publication to certify.
 *  - `historyBatch.blocksPublish === true`, or `status !== 'complete'` ⇒ throw
 *    (doc §5, fail-closed). A blocking batch means the item did not earn
 *    publication, whatever its state column says.
 *  - `historyBatch === null` with more than one version ⇒ throw: a repair
 *    without a proven full history re-run is exactly the §5 failure.
 *  - a discipline verdict of 'correct' with `citation === null` ⇒ throw. Doc
 *    §6.2 forbids that row from existing; presenting it would publish an
 *    unevidenced claim of correctness.
 *
 * Then assembly:
 *  - provenance / license / discipline / authorPseudonym carried through.
 *  - `acceptedAttacks`: checks with `status === 'accepted'` ONLY. Rejected,
 *    abstained and hypothesis checks are dropped entirely — an abstention shown
 *    as a finding overstates what the system proved.
 *  - `historyReRun`: one entry per outcome, GROUPED BY CHECK CLASS in
 *    PASSPORT_CLASS_ORDER. Deterministic / counterexample outcomes carry their
 *    strict result; semantic outcomes are shown as 'readjudicated' (with the
 *    structured `verdict`) or 'inconclusive' — NEVER as 'pass'.
 *  - `disciplineVerdict`: the verdict with its full citation, or
 *    `{ verdict: 'unverified', citation: null }` when the source has none.
 *  - `defense`: the rubric, or `{ outcome: 'inconclusive' }` when it is absent
 *    or its outcome is 'inconclusive' (doc §6.3).
 *  - `versions`: every version with its recorded diff.
 *  - NO field beyond the `Passport` interface may be emitted (doc §9).
 *
 * Finally: `saveSnapshot` the assembled passport and return it.
 * Reference: doc §6.4.
 */
export async function buildPassport(
  _itemId: string,
  _deps: PassportDeps = DEFAULT_PASSPORT_DEPS,
): Promise<Passport> {
  throw new Error('TODO(codex): implement item passport assembly');
}
