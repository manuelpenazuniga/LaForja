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
import { isCompliantModel, ALLOWED_MODEL_IDS, assertRuntimeCompliance } from '../config/models';
import {
  EVAL_CONFIGS,
  RUNS_PER_CONFIG,
  type EvalConfig,
  type EvalReport,
  type RunIndex,
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

/**
 * TODO(codex): implement one configuration run over the smoke set.
 *  - Load smoke items from src/eval/smoke/{dev,holdout}/*.json, validate with
 *    SmokeItemSchema, and filter by `split`.
 *  - For each item, run the requested config through src/reviewers/orchestrator.ts
 *    (+ adjudication unless config === 'gauntlet-no-adjudication').
 *  - Score against `intended_defect`: a defect counts as FOUND only if the finding
 *    matches the expected type AND carries a valid contract. `clean` items that
 *    receive any accepted finding count as FALSE POSITIVES.
 *  - Citation precision: of the citations emitted, how many resolve to the licensed
 *    corpus with a matching excerpt.
 *  - Collect latency samples for p50/p95 and token cost per item.
 *  - TODO(codex): call assertRuntimeCompliance(model) immediately before
 *    dispatching EACH model call (reviewer and adjudicator alike). loadModelConfig
 *    is warn-only, so this is the gate that makes "the runtime uses only gpt-5.6"
 *    true. Never dispatch on the strength of a config object read at startup.
 *  - Record the settings block (reasoningEffort, contextMode, budget) and use the
 *    IDENTICAL values for all RUNS_PER_CONFIG runs of a config — doc §8 requires
 *    the 3 runs to be comparable, and the artifact must prove it.
 *  - Populate modelIds { reviewer, adjudicator } with the EXACT IDs used
 *    (adjudicator is null for 'general-reviewer' and 'gauntlet-no-adjudication')
 *    and allModelIds with the deduplicated union of them.
 *  - Return an EvalReport with EXACT COUNTS.
 */
export async function runConfig(
  _config: EvalConfig,
  _runIndex: RunIndex,
  _split: 'dev' | 'holdout',
): Promise<EvalReport> {
  void assertRuntimeCompliance; // gate the Codex implementation must call per model call
  throw new Error('TODO(codex): implement single eval config run');
}

/**
 * Persist eval artifacts. The compliance gate below is ALREADY IMPLEMENTED and
 * is not Codex's to relax: it validates the model IDs embedded in the reports
 * themselves, not the ambient environment, and it runs before any filesystem
 * work so a refusal leaves nothing partially written.
 *
 * TODO(codex): implement artifact persistence BELOW the gate.
 *  - Do NOT move, weaken, wrap in a try/catch, or make conditional the
 *    assertReportsCompliance(reports) call — it must stay the first statement
 *    and its throw must propagate. There is no bypass flag by design.
 *  - Write eval/results/<timestamp>-<config>-run<N>.json containing the full
 *    EvalReport including modelIds, allModelIds, settings, promptHash, timestamp
 *    and raw outputs.
 *  - Also write a human-readable summary table with exact counts.
 */
export async function writeResults(reports: readonly EvalReport[]): Promise<void> {
  assertReportsCompliance(reports); // fail-closed: per-report model IDs, not the env
  throw new Error('TODO(codex): implement eval artifact persistence to eval/results/');
}

/**
 * TODO(codex): main entry — run all three configs × 3 runs, then writeResults().
 * Print the exact-count summary to stdout so it can be pasted into the README.
 * Runs are indexed 1..RUNS_PER_CONFIG (RunIndex is 1 | 2 | 3).
 */
export async function main(): Promise<void> {
  void EVAL_CONFIGS;
  void RUNS_PER_CONFIG;
  throw new Error('TODO(codex): implement eval main()');
}

// Executed via `npm run eval` (tsx src/eval/run.ts).
if (process.argv[1] && process.argv[1].endsWith('run.ts')) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
