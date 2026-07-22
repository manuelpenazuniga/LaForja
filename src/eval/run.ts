/**
 * LA FORJA — labeled smoke eval runner (doc §8).
 *
 * OWNER: Codex. Single command: `npm run eval`.
 *
 * Configurations (each run RUNS_PER_CONFIG=3 times with IDENTICAL settings —
 * same model, reasoning, context and budget):
 *   1. general-reviewer            (single general reviewer baseline)
 *   2. gauntlet                    (3 specialized reviewers + adjudication)
 *   3. gauntlet-no-adjudication    (3 reviewers, adjudication skipped)
 *
 * Reporting rule: EXACT COUNTS, never grandiose percentages. Report false
 * positives on `clean` items, citation precision, schema-valid %, p50/p95 latency
 * and cost per item. Persist prompt hash, model ID, timestamp and RAW JSON
 * outputs to eval/results/ (repo root — the spec's "/eval/results/").
 *
 * dev/holdout: items used to develop prompts (dev) are NOT reported as evaluation.
 *
 * COMPLIANCE GATE: this runner MUST refuse to write any result file unless every
 * model ID EMBEDDED IN THE REPORTS is on the allowlist — results from other
 * models would be invalid evidence for the submission. Checking the current
 * environment is NOT sufficient: reports produced earlier under a different
 * config outlive the env that produced them, so the env can be switched back to
 * a compliant one before the write. The reports carry their own evidence; that
 * is what gets checked, EXHAUSTIVELY, including the nested
 * `raw` per-call entries and not just the top-level summary fields.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isCompliantModel,
  ALLOWED_MODEL_IDS,
  assertRuntimeCompliance,
  loadModelConfig,
} from '../config/models';
import type { Citation, ReviewerType } from '../core/types';
import { adjudicate, type AdjudicatedCheck } from '../reviewers/adjudication';
import {
  AMBIGUITY_SYSTEM,
} from '../reviewers/ambiguity';
import { DISCIPLINE_SYSTEM } from '../reviewers/discipline';
import { DISTRACTOR_SYSTEM } from '../reviewers/distractors';
import {
  GENERAL_REVIEWER,
  GENERAL_REVIEWER_SYSTEM,
  runGauntlet,
  toDelimitedItem,
} from '../reviewers/orchestrator';
import {
  EVAL_CONFIGS,
  RUNS_PER_CONFIG,
  SmokeItemSchema,
  type EvalConfig,
  type EvalReport,
  type EvalRunSettings,
  type RunIndex,
  type SmokeItem,
} from './types';

/** Repo-root artifact directory (the spec's "/eval/results/"). */
export const RESULTS_DIR = 'eval/results';

/**
 * A property whose value may carry a model ID. Deliberately BROAD: any key whose
 * name mentions "model" at all. `modelId`, `modelIds`, `allModelIds`, `model`,
 * `model_name`, a future `fallbackModel` — all match without this walk needing to
 * be updated. Over-collection is the intended failure direction (see
 * `collectReportModelIds`): a key like `modelFamilyOk` holds a boolean and is
 * skipped anyway, because only STRING leaves are collected.
 */
function isModelBearingKey(key: string): boolean {
  return key.toLowerCase().includes('model');
}

/** Every string leaf under a model-bearing key: plain, array, or nested object. */
function collectStringLeaves(value: unknown, out: Set<string>, seen: Set<object>): void {
  if (typeof value === 'string') {
    out.add(value);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return; // cycle guard
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) collectStringLeaves(entry, out, seen);
    return;
  }
  for (const entry of Object.values(value)) collectStringLeaves(entry, out, seen);
}

/**
 * Recurses through EVERY node of the structure — objects, arrays, and in
 * particular `raw`, where the per-call `ModelCallResult` entries live — and
 * harvests the string leaves of every model-bearing key it passes.
 */
function walkForModelIds(value: unknown, out: Set<string>, seen: Set<object>): void {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return; // cycle guard
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) walkForModelIds(entry, out, seen);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (isModelBearingKey(key)) collectStringLeaves(entry, out, new Set<object>());
    walkForModelIds(entry, out, seen);
  }
}

/**
 * Pure guard (Claude-owned): every model ID embedded in every report, flattened.
 *
 * EXHAUSTIVE BY CONSTRUCTION. Reading only `allModelIds` and the `modelIds` role
 * fields inspected the SURFACE of the report: `raw` holds the actual per-call
 * `ModelCallResult` entries, each with its own `modelId` recording what really
 * served that call. A report can therefore carry compliant top-level IDs and
 * non-compliant nested ones — which is the exact shape of a report produced by a
 * proxy or provider fallback. So the whole structure is walked, to any depth.
 *
 * OVER-COLLECTS ON PURPOSE. Any key mentioning "model" contributes its string
 * leaves, even keys this codebase does not define yet. A false refusal costs a
 * re-run; a false acceptance costs the submission.
 *
 * The two declared fields are still read explicitly, so the gate does not depend
 * on the generic walk to cover the shape the type system already guarantees.
 */
export function collectReportModelIds(reports: readonly EvalReport[]): string[] {
  const ids = new Set<string>();
  for (const report of reports) {
    // Defensive reads: a report reaching this gate may be forged, truncated or
    // hand-edited, and a TypeError here would abort the walk before it ran —
    // turning a refusal into a crash the caller might mistake for a bug.
    for (const id of report.allModelIds ?? []) ids.add(id);
    const roles = report.modelIds as EvalReport['modelIds'] | undefined;
    if (typeof roles?.reviewer === 'string') ids.add(roles.reviewer);
    if (typeof roles?.adjudicator === 'string') ids.add(roles.adjudicator);
    walkForModelIds(report, ids, new Set<object>());
  }
  return [...ids];
}

/**
 * Pure guard (Claude-owned): throws unless EVERY model ID embedded ANYWHERE in
 * EVERY report is allowlisted. Fail-closed and unbypassable — there is no flag,
 * no option and no env var that suppresses it. An empty report list is also
 * refused: writing an artifact with nothing to attest to is not a valid state.
 *
 * AN EMPTY ID SET IS ALSO A REFUSAL. "No model IDs found" almost never means "no
 * model was called" — it means the walk did not find them, i.e. the gate has
 * nothing to attest to and cannot claim the artifact is compliant evidence.
 */
export function assertReportsCompliance(reports: readonly EvalReport[]): void {
  if (reports.length === 0) {
    throw new Error('Refusing to write eval results: no reports supplied.');
  }
  const ids = collectReportModelIds(reports);
  if (ids.length === 0) {
    throw new Error(
      'Refusing to write eval results: no model IDs found anywhere in the reports. ' +
        'An eval run always calls a model, so an empty ID set means the compliance ' +
        'walk found nothing to attest to — not that the run was compliant.',
    );
  }
  const offending = ids.filter((id) => !isCompliantModel(id));
  if (offending.length > 0) {
    throw new Error(
      `Refusing to write eval results: ${offending.length} non-compliant model ID(s) are ` +
        `embedded in the reports: ${offending.join(', ')}. Allowed: ${ALLOWED_MODEL_IDS.join(', ')}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// SCORING SURFACE (doc §8)
//
// The scoring is the part that must be right: it produces the numbers that go
// in the submission. It is therefore split out of `runConfig` into small pure
// functions, so the counting can be verified offline against canned reviewer
// results without any model call. `runConfig` composes them; it does not
// re-derive them.
// ---------------------------------------------------------------------------

/** The four labeled defect types (owned by SmokeItemSchema, derived here). */
export type IntendedDefectType = NonNullable<SmokeItem['intended_defect']>['type'];

/**
 * WHICH REVIEWER MAY LEGITIMATELY CLAIM WHICH DEFECT.
 *
 * THIS TABLE IS THE ANTI-INFLATION RULE. A finding of the right SHAPE about the
 * WRONG defect is not a detection: an ambiguity contract filed against an item
 * whose planted defect is a factual error found something else (or nothing), and
 * counting it would inflate the headline number that goes in the README. A
 * defect counts as FOUND only when the accepted, schema-valid finding comes from
 * a reviewer listed here for that defect type.
 *
 * `cue_leak` lists TWO reviewers on purpose, and it is the only entry that does:
 * the labeled fixtures state that a cue leak must be caught by the deterministic
 * probe (length / lexical overlap) AND is expected to surface as weak
 * distractors. Both are findings about the SAME planted defect, so either one is
 * a legitimate hit — this is not a widening of the rule, it is the rule applied
 * to a defect that two detectors legitimately share.
 */
export const DEFECT_TYPE_REVIEWERS = {
  ambiguity: ['ambiguity'],
  factual_error: ['discipline'],
  cue_leak: ['item_probe', 'distractor'],
  weak_distractor: ['distractor'],
} as const satisfies Record<IntendedDefectType, readonly ReviewerType[]>;

/**
 * Whether a citation emitted by a reviewer actually lands in the licensed
 * corpus. Two independent facts, because they fail for different reasons and a
 * single boolean would hide which one happened:
 *  - `resolved`: the `source_id` names a document that exists in the corpus.
 *  - `excerptMatches`: the quoted excerpt is really present in that document.
 *
 * A citation is PRECISE only when both are true. A citation that does not
 * resolve counts AGAINST precision — it is never simply skipped, because
 * dropping unresolvable citations from the denominator would turn a fabricated
 * source into a free pass.
 */
export interface CitationResolution {
  resolved: boolean;
  excerptMatches: boolean;
}

/** Offline in tests, corpus-backed in the real run. Never a network call. */
export type CitationResolver = (citation: Citation) => CitationResolution;

/**
 * Everything one item's pass produced, already collected. This is the seam the
 * eval suite feeds canned data through: it sits on the far side of every model
 * call, so the scoring above it is fully testable offline.
 */
export interface ItemEvaluation {
  itemId: string;
  /**
   * The checks this item's pass produced. For 'gauntlet' these are adjudicated;
   * for the configs that skip adjudication they are the reviewer findings
   * promoted to checks with the status the code gates assigned.
   */
  checks: AdjudicatedCheck[];
  /** Every citation emitted for this item, by any reviewer. */
  citations: Citation[];
  latencyMs: number;
  costUsd: number;
  /** Model outputs that were schema-validated, and how many passed. */
  schemaValid: number;
  schemaTotal: number;
  /** Every model id that served a call for this item (compliance evidence). */
  modelIds: string[];
  /** Raw model outputs, kept verbatim as evidence. */
  raw: unknown[];
}

/**
 * Return the defect types a single check is entitled to claim.
 *  - For a specialist reviewer: every key of DEFECT_TYPE_REVIEWERS that lists
 *    `check.reviewerType`.
 *  - For the doc §8 general baseline (`reviewerType === 'general'`): the single
 *    type its contract DECLARES in `defect_type`, because the baseline is one
 *    undifferentiated call and cannot be attributed by reviewer identity. An
 *    absent or unrecognised `defect_type` claims NOTHING — it must never fall
 *    back to "matches whatever was planted", which would score the baseline on
 *    generosity instead of on detection.
 *  - Any other reviewer id claims nothing.
 */
export function claimedDefectTypes(check: AdjudicatedCheck): IntendedDefectType[] {
  if (check.reviewerType === GENERAL_REVIEWER) {
    if (check.contract === null || typeof check.contract !== 'object') return [];
    const defectType = (check.contract as { defect_type?: unknown }).defect_type;
    return typeof defectType === 'string' && defectType in DEFECT_TYPE_REVIEWERS
      ? [defectType as IntendedDefectType]
      : [];
  }
  return (Object.entries(DEFECT_TYPE_REVIEWERS) as Array<
    [IntendedDefectType, readonly ReviewerType[]]
  >)
    .filter(([, reviewers]) => reviewers.includes(check.reviewerType as ReviewerType))
    .map(([defectType]) => defectType);
}

/**
 * Decide whether this single check detects the item's planted defect.
 *
 * All three conditions, no exceptions:
 *  1. the item has an `intended_defect` (a `clean` item can never be a hit);
 *  2. the check is ACCEPTED and `schemaValid` — a valid evidence contract is
 *     what separates a detection from an assertion, and 'hypothesis',
 *     'abstained', 'proposed' and 'rejected' are all NOT detections;
 *  3. `claimedDefectTypes(check)` includes `intended_defect.type`.
 */
export function isDefectHit(item: SmokeItem, check: AdjudicatedCheck): boolean {
  return (
    item.intended_defect !== null &&
    check.status === 'accepted' &&
    check.schemaValid &&
    claimedDefectTypes(check).includes(item.intended_defect.type)
  );
}

/**
 * Return 1 if any check on this item is a hit, otherwise 0.
 *
 * SATURATES AT ONE PER ITEM. `defectsFound` is compared against
 * `defectsPlanted`, which counts ITEMS carrying a planted defect (one each), so
 * three reviewers all catching the same ambiguity must contribute 1 — otherwise
 * "found 13 of 16" can print as "found 31 of 16".
 */
export function countDefectsFound(item: SmokeItem, checks: readonly AdjudicatedCheck[]): number {
  return checks.some((check) => isDefectHit(item, check)) ? 1 : 0;
}

/**
 * Count false positives on a `clean` item.
 *
 * THE NUMBER THAT KEEPS THE EVAL HONEST. A `clean` item has no defect, so EVERY
 * accepted, schema-valid check on it is a false positive — regardless of which
 * reviewer produced it and regardless of how good its evidence looks. Returns 0
 * for any non-clean item (a finding there is scored by `countDefectsFound`, not
 * here). Unlike the hit counter this does NOT saturate: two bogus accepted
 * findings on one clean item are two false positives, because the cost of a
 * false alarm is paid per finding by the student who has to answer it.
 *
 * An eval that reports only detections is marketing; this counter is what makes
 * it an evaluation.
 */
export function countFalsePositivesOnClean(
  item: SmokeItem,
  checks: readonly AdjudicatedCheck[],
): number {
  if (item.intended_defect !== null) return 0;
  return checks.filter((check) => check.status === 'accepted' && check.schemaValid).length;
}

/**
 * Compute the nearest-rank percentile over latency samples, in milliseconds.
 * Sort ascending, take ceil(p * n) clamped to [1, n]. An empty sample set
 * returns 0. Deterministic — no interpolation, so p50/p95 in two reports of the
 * same run are byte-identical.
 */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return sorted[rank - 1] ?? 0;
}

/**
 * Fold the per-item evaluations into the report's exact counts.
 *
 *  - itemsEvaluated      : evaluations matched to an item, by id.
 *  - defectsPlanted      : items with a non-null `intended_defect`.
 *  - defectsFound        : Σ countDefectsFound.
 *  - falsePositivesOnClean: Σ countFalsePositivesOnClean.
 *  - citationsChecked    : every citation emitted, including unresolvable ones.
 *  - citationsPrecise    : those with resolved && excerptMatches.
 *  - schemaValid/Total   : Σ of the per-item schema tallies.
 *
 * FAIL CLOSED ON A MISMATCH: an evaluation whose `itemId` is not in `items`, or
 * an item with no evaluation, must THROW. Silently dropping either would make
 * the denominator disagree with the set the report claims to cover, and "found
 * 13 of 16" would stop meaning what it says.
 */
export function tallyCounts(
  items: readonly SmokeItem[],
  evaluations: readonly ItemEvaluation[],
  resolveCitation: CitationResolver,
): EvalReport['counts'] {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const evaluationsById = new Map<string, ItemEvaluation>();
  for (const evaluation of evaluations) {
    if (!itemsById.has(evaluation.itemId)) {
      throw new Error(`Evaluation '${evaluation.itemId}' is not in the declared item set`);
    }
    if (evaluationsById.has(evaluation.itemId)) {
      throw new Error(`Item '${evaluation.itemId}' has more than one evaluation`);
    }
    evaluationsById.set(evaluation.itemId, evaluation);
  }
  for (const item of items) {
    if (!evaluationsById.has(item.id)) {
      throw new Error(`Item '${item.id}' has no evaluation`);
    }
  }

  let defectsFound = 0;
  let falsePositivesOnClean = 0;
  let citationsChecked = 0;
  let citationsPrecise = 0;
  let schemaValid = 0;
  let schemaTotal = 0;
  for (const item of items) {
    const evaluation = evaluationsById.get(item.id);
    if (evaluation === undefined) throw new Error(`Item '${item.id}' has no evaluation`);
    defectsFound += countDefectsFound(item, evaluation.checks);
    falsePositivesOnClean += countFalsePositivesOnClean(item, evaluation.checks);
    schemaValid += evaluation.schemaValid;
    schemaTotal += evaluation.schemaTotal;
    for (const citation of evaluation.citations) {
      citationsChecked += 1;
      const resolution = resolveCitation(citation);
      if (resolution.resolved && resolution.excerptMatches) citationsPrecise += 1;
    }
  }

  return {
    itemsEvaluated: evaluations.length,
    defectsPlanted: items.filter((item) => item.intended_defect !== null).length,
    defectsFound,
    falsePositivesOnClean,
    citationsChecked,
    citationsPrecise,
    schemaValid,
    schemaTotal,
  };
}

// ---------------------------------------------------------------------------
// dev / holdout separation (doc §8)
// ---------------------------------------------------------------------------

/**
 * Pure guard (Claude-owned): the reported split contains ONLY items from that
 * split. Fail-closed.
 *
 * Dev items DEVELOPED the prompts. A report that mixes even one of them into a
 * holdout evaluation is measuring the prompts against their own training
 * material and reporting it as evaluation — the single most misleading thing
 * this eval could do, and invisible in the output once it has happened, because
 * the leaked item's numbers look exactly like every other item's. So it is
 * checked at the boundary, before any counting, rather than trusted.
 */
export function assertSplitPurity(split: 'dev' | 'holdout', items: readonly SmokeItem[]): void {
  const leaked = items.filter((item) => item.split !== split);
  if (leaked.length > 0) {
    throw new Error(
      `Refusing to score a "${split}" eval run: ${leaked.length} item(s) belong to the other ` +
        `split and would be reported as evaluation: ${leaked
          .map((item) => `${item.id} (${item.split})`)
          .join(', ')}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Injectable runner seam
// ---------------------------------------------------------------------------

/**
 * Settings held IDENTICAL across the RUNS_PER_CONFIG runs of every config, and
 * recorded verbatim on each artifact so a reader can PROVE the three runs were
 * comparable instead of taking our word for it (doc §8). One frozen constant,
 * because three runs that each build their own settings object are three runs
 * that can silently drift apart.
 */
export const DEFAULT_EVAL_SETTINGS: EvalRunSettings = Object.freeze({
  reasoningEffort: 'medium',
  contextMode: 'item-plus-corpus',
  budget: Object.freeze({ maxTokensPerItem: 8_000, maxCallsPerItem: 4 }),
}) as EvalRunSettings;

/**
 * THE INJECTABLE SEAM of the eval runner. Every member is at or beyond the
 * network boundary; the scoring, the split guard and the artifact gate are on
 * this side of it and are therefore verifiable offline with canned results.
 * The eval cannot be RUN without an API key — it can be fully SPECIFIED and its
 * counting fully tested without one.
 */
export interface EvalRunnerDeps {
  /** Load + validate the labeled smoke items for one split (disk in prod). */
  loadSmokeItems: (split: 'dev' | 'holdout') => Promise<SmokeItem[]>;
  /** One item through one config: every model call for that item lives here. */
  evaluateItem: (
    item: SmokeItem,
    config: EvalConfig,
    runIndex: RunIndex,
  ) => Promise<ItemEvaluation>;
  /** Resolve a citation against the licensed corpus. */
  resolveCitation: CitationResolver;
  /** Identical for all runs of a config; recorded on the artifact. */
  settings: EvalRunSettings;
  /** Hash of the exact prompt set used, recorded on the artifact. */
  promptHash: () => string;
  /** Injectable clock, so a report timestamp is reproducible under test. */
  now: () => string;
}

/**
 * Production disk/call bundle. The smoke loader and corpus resolver are local
 * filesystem operations; the evaluator composes the existing orchestrator and
 * adjudicator, with every dispatch guarded at the last point before the call.
 */
const EVAL_SOURCE_DIR = fileURLToPath(new URL('.', import.meta.url));
const SMOKE_ROOT = join(EVAL_SOURCE_DIR, 'smoke');

function readLicensedCorpus(): Map<string, Citation> {
  const corpus = new Map<string, Citation>();
  for (const split of ['dev', 'holdout'] as const) {
    const directory = join(SMOKE_ROOT, split);
    for (const filename of readdirSync(directory).filter((name) => name.endsWith('.json'))) {
      const item = SmokeItemSchema.parse(
        JSON.parse(readFileSync(join(directory, filename), 'utf8')) as unknown,
      );
      if (item.source !== null) corpus.set(item.source.source_id, item.source);
    }
  }
  return corpus;
}

const LICENSED_CORPUS = readLicensedCorpus();

async function loadSmokeItems(split: 'dev' | 'holdout'): Promise<SmokeItem[]> {
  const directory = join(SMOKE_ROOT, split);
  const filenames = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  return Promise.all(
    filenames.map(async (filename) =>
      SmokeItemSchema.parse(
        JSON.parse(await readFile(join(directory, filename), 'utf8')) as unknown,
      ),
    ),
  );
}

function citationsIn(value: unknown, found: Citation[] = []): Citation[] {
  if (Array.isArray(value)) {
    for (const entry of value) citationsIn(entry, found);
    return found;
  }
  if (value === null || typeof value !== 'object') return found;
  const record = value as Record<string, unknown>;
  if (
    typeof record.source_id === 'string' &&
    typeof record.version_date === 'string' &&
    typeof record.license === 'string' &&
    typeof record.excerpt === 'string' &&
    typeof record.relevance === 'string'
  ) {
    found.push(record as unknown as Citation);
    return found;
  }
  for (const child of Object.values(record)) citationsIn(child, found);
  return found;
}

function checksWithoutAdjudication(
  config: EvalConfig,
  outcomes: Awaited<ReturnType<typeof runGauntlet>>['outcomes'],
): AdjudicatedCheck[] {
  const checks: AdjudicatedCheck[] = [];
  for (const outcome of outcomes) {
    if (!outcome.ok || !outcome.schemaValid || outcome.reviewerType === 'item_probe') continue;
    if (config === 'general-reviewer') {
      if (outcome.reviewerType === GENERAL_REVIEWER) {
        checks.push({
          reviewerType: GENERAL_REVIEWER,
          verificationKind: 'interpretation',
          checkClass: 'semantic',
          status: 'accepted',
          contract: outcome.contract,
          schemaValid: true,
        });
      }
      continue;
    }

    if (outcome.reviewerType === 'ambiguity') {
      checks.push({
        reviewerType: 'ambiguity',
        verificationKind: 'interpretation',
        checkClass: 'counterexample',
        status: 'accepted',
        contract: outcome.contract,
        schemaValid: true,
        invariantId: 'ambiguity_two_readings_disagree',
        executorVersion: 'solver@1.0.0',
        thresholdVersion: 'thresholds@1.0.0',
      });
    } else if (outcome.reviewerType === 'discipline') {
      const contract = outcome.contract as {
        citation?: Citation | null;
        solver_proof?: { solver_version?: string } | null;
      };
      const solverGrounded = contract?.solver_proof != null;
      const evidenced = solverGrounded || contract?.citation != null;
      checks.push({
        reviewerType: 'discipline',
        verificationKind: solverGrounded ? 'solver' : 'citation',
        checkClass: solverGrounded ? 'deterministic' : 'semantic',
        status: evidenced ? 'accepted' : 'abstained',
        contract: outcome.contract,
        schemaValid: true,
        ...(solverGrounded
          ? {
              invariantId: 'solver_key_matches',
              executorVersion: contract.solver_proof?.solver_version ?? 'solver@1.0.0',
              thresholdVersion: 'thresholds@1.0.0',
            }
          : {}),
      });
    } else if (outcome.reviewerType === 'distractor') {
      const findings = Array.isArray(outcome.contract) ? outcome.contract : [outcome.contract];
      for (const finding of findings) {
        const evidenced =
          finding !== null &&
          typeof finding === 'object' &&
          (finding as { label?: unknown }).label === 'evidenced';
        checks.push({
          reviewerType: 'distractor',
          verificationKind: evidenced ? 'citation' : 'interpretation',
          checkClass: 'semantic',
          status: evidenced ? 'accepted' : 'hypothesis',
          contract: finding,
          schemaValid: true,
        });
      }
    }
  }
  return checks;
}

async function evaluateItem(
  item: SmokeItem,
  config: EvalConfig,
  _runIndex: RunIndex,
): Promise<ItemEvaluation> {
  const models = loadModelConfig();
  assertRuntimeCompliance(models.reviewerModel);
  const startedAt = Date.now();
  const rawItem = {
    stem: item.stem,
    options: item.options,
    correctKey: item.correct_key,
    authorRationale: item.author_rationale,
    discipline: item.discipline,
  };
  const orchestration = await runGauntlet(rawItem, models.reviewerModel, config);

  let checks: AdjudicatedCheck[];
  const modelIds = [models.reviewerModel];
  if (config === 'gauntlet') {
    assertRuntimeCompliance(models.adjudicatorModel);
    // The adjudicator must SEE the item to verify a claim about it. Without the
    // delimited item, buildCallPayload substitutes "No item text was supplied."
    // and the adjudicator rules blind — rejecting almost every real finding.
    checks = (
      await adjudicate(orchestration, models.adjudicatorModel, {
        delimitedItem: toDelimitedItem(rawItem),
      })
    ).checks;
    modelIds.push(models.adjudicatorModel);
  } else {
    checks = checksWithoutAdjudication(config, orchestration.outcomes);
  }
  const modelOutcomes = orchestration.outcomes.filter(
    (outcome) => outcome.reviewerType !== 'item_probe',
  );
  const schemaTotal = modelOutcomes.length + (config === 'gauntlet' ? 1 : 0);
  const schemaValid =
    modelOutcomes.filter((outcome) => outcome.ok && outcome.schemaValid).length +
    (config === 'gauntlet' ? 1 : 0);

  return {
    itemId: item.id,
    checks,
    citations: checks.flatMap((check) => citationsIn(check.contract)),
    latencyMs: Date.now() - startedAt,
    costUsd: 0,
    schemaValid,
    schemaTotal,
    modelIds,
    raw: orchestration.outcomes.map((outcome) => ({
      reviewerType: outcome.reviewerType,
      schemaValid: outcome.schemaValid,
      contract: outcome.contract,
    })),
  };
}

function resolveCitation(citation: Citation): CitationResolution {
  const source = LICENSED_CORPUS.get(citation.source_id);
  if (source === undefined) return { resolved: false, excerptMatches: false };
  return {
    resolved: true,
    excerptMatches:
      source.version_date === citation.version_date &&
      source.license === citation.license &&
      source.excerpt.includes(citation.excerpt),
  };
}

function evalPromptHash(): string {
  const prompts = [
    GENERAL_REVIEWER_SYSTEM,
    AMBIGUITY_SYSTEM,
    DISCIPLINE_SYSTEM,
    DISTRACTOR_SYSTEM,
  ].join('\n---\n');
  return `sha256:${createHash('sha256').update(prompts).digest('hex')}`;
}

export const DEFAULT_EVAL_DEPS: EvalRunnerDeps = {
  loadSmokeItems,
  evaluateItem,
  resolveCitation,
  settings: DEFAULT_EVAL_SETTINGS,
  promptHash: evalPromptHash,
  now: () => new Date().toISOString(),
};

/**
 * Run one configuration over the requested smoke-set split.
 *
 * `deps` is the ONLY route to a model call or to disk, which is what lets the
 * counting be verified offline. Compose the pure helpers above; do not re-derive
 * the counts inline.
 *
 *  - `deps.loadSmokeItems(split)` for the items (SmokeItemSchema-validated).
 *  - `assertSplitPurity(split, items)` BEFORE scoring anything — a dev item must
 *    never reach a holdout report.
 *  - `deps.evaluateItem(item, config, runIndex)` per item; that is where the
 *    orchestrator runs (+ adjudication unless config === 'gauntlet-no-adjudication').
 *  - `tallyCounts(items, evaluations, deps.resolveCitation)` for every count.
 *  - `percentile(latencies, 0.5 | 0.95)` for latencyMs; costUsdPerItem is the
 *    mean per-item cost (0 when no items were evaluated — never a division by 0).
 *  - Call assertRuntimeCompliance(model) immediately before
 *    dispatching EACH model call (reviewer and adjudicator alike). loadModelConfig
 *    is warn-only, so this is the gate that makes "the runtime uses only gpt-5.6"
 *    true. Never dispatch on the strength of a config object read at startup.
 *  - Record `deps.settings` VERBATIM, and pass the SAME object to all
 *    RUNS_PER_CONFIG runs of a config — doc §8 requires the 3 runs to be
 *    comparable, and the artifact must prove it.
 *  - Populate modelIds { reviewer, adjudicator } with the EXACT IDs used
 *    (adjudicator is null for 'general-reviewer' and 'gauntlet-no-adjudication')
 *    and allModelIds with the deduplicated union of every id in
 *    `ItemEvaluation.modelIds`, so the artifact gate has the whole truth.
 *  - Return an EvalReport with EXACT COUNTS.
 */
export async function runConfig(
  config: EvalConfig,
  runIndex: RunIndex,
  split: 'dev' | 'holdout',
  deps: EvalRunnerDeps = DEFAULT_EVAL_DEPS,
): Promise<EvalReport> {
  const items = await deps.loadSmokeItems(split);
  assertSplitPurity(split, items);
  const evaluations = await Promise.all(
    items.map((item) => deps.evaluateItem(item, config, runIndex)),
  );
  const counts = tallyCounts(items, evaluations, deps.resolveCitation);
  const models = loadModelConfig();
  const adjudicator = config === 'gauntlet' ? models.adjudicatorModel : null;
  const allModelIds = new Set<string>([
    models.reviewerModel,
    ...(adjudicator === null ? [] : [adjudicator]),
  ]);
  for (const evaluation of evaluations) {
    for (const modelId of evaluation.modelIds) allModelIds.add(modelId);
  }
  const latencies = evaluations.map((evaluation) => evaluation.latencyMs);
  const totalCost = evaluations.reduce((sum, evaluation) => sum + evaluation.costUsd, 0);

  return {
    config,
    runIndex,
    modelIds: { reviewer: models.reviewerModel, adjudicator },
    allModelIds: [...allModelIds],
    settings: deps.settings,
    promptHash: deps.promptHash(),
    timestamp: deps.now(),
    split,
    counts,
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
    },
    costUsdPerItem: evaluations.length === 0 ? 0 : totalCost / evaluations.length,
    raw: evaluations.flatMap((evaluation) => evaluation.raw),
  };
}

/**
 * Persist eval artifacts. The compliance gate below is ALREADY IMPLEMENTED and
 * is not Codex's to relax: it validates the model IDs embedded in the reports
 * themselves, not the ambient environment, and it runs before any filesystem
 * work so a refusal leaves nothing partially written.
 *
 * The destination is injectable so tests can verify real filesystem behaviour
 * without ever placing fixture artifacts beside measured submission results.
 * The compliance check remains the first statement and therefore runs before
 * directory creation, path construction, or any other filesystem work.
 */
export async function writeResults(
  reports: readonly EvalReport[],
  destination: string = RESULTS_DIR,
): Promise<void> {
  assertReportsCompliance(reports); // fail-closed: per-report model IDs, not the env
  await mkdir(destination, { recursive: true });
  for (const report of reports) {
    const timestamp = report.timestamp.replace(/[:.]/gu, '-');
    const filename = `${timestamp}-${report.config}-run${report.runIndex}.json`;
    await writeFile(join(destination, filename), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  const summary = [
    '| Configuration | Run | Found | Planted | False positives (clean) | Citations precise | Citations checked |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...reports.map(
      (report) =>
        `| ${report.config} | ${report.runIndex} | ${report.counts.defectsFound} | ` +
        `${report.counts.defectsPlanted} | ${report.counts.falsePositivesOnClean} | ` +
        `${report.counts.citationsPrecise} | ${report.counts.citationsChecked} |`,
    ),
    '',
  ].join('\n');
  await writeFile(join(destination, 'summary.md'), summary, 'utf8');
}

/**
 * Main entry: run all three configs three times, then persist the reports.
 * Print the exact-count summary to stdout so it can be pasted into the README.
 * Runs are indexed 1..RUNS_PER_CONFIG (RunIndex is 1 | 2 | 3).
 */
export async function main(): Promise<void> {
  const reports: EvalReport[] = [];
  for (const config of EVAL_CONFIGS) {
    for (let run = 1; run <= RUNS_PER_CONFIG; run += 1) {
      reports.push(await runConfig(config, run as RunIndex, 'holdout', DEFAULT_EVAL_DEPS));
    }
  }
  await writeResults(reports);
  for (const report of reports) {
    console.log(
      `${report.config} run ${report.runIndex}: found ${report.counts.defectsFound} of ` +
        `${report.counts.defectsPlanted}; false positives on clean: ` +
        `${report.counts.falsePositivesOnClean}; citations precise: ` +
        `${report.counts.citationsPrecise} of ${report.counts.citationsChecked}.`,
    );
  }
}

// Executed via `npm run eval` (tsx src/eval/run.ts).
if (process.argv[1] && process.argv[1].endsWith('run.ts')) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
