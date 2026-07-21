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
 * is what gets checked.
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
 * Pure guard (Claude-owned): every model ID embedded in every report, flattened.
 * Reads both `allModelIds` and the `modelIds` role fields and unions them, so a
 * report whose `allModelIds` was built wrong (or truncated) still cannot hide a
 * model from the gate.
 */
export function collectReportModelIds(reports: readonly EvalReport[]): string[] {
  const ids = new Set<string>();
  for (const report of reports) {
    for (const id of report.allModelIds) ids.add(id);
    ids.add(report.modelIds.reviewer);
    if (report.modelIds.adjudicator !== null) ids.add(report.modelIds.adjudicator);
  }
  return [...ids];
}

/**
 * Pure guard (Claude-owned): throws unless EVERY model ID embedded in EVERY
 * report is allowlisted. Fail-closed and unbypassable — there is no flag, no
 * option and no env var that suppresses it. An empty report list is also
 * refused: writing an artifact with nothing to attest to is not a valid state.
 */
export function assertReportsCompliance(reports: readonly EvalReport[]): void {
  if (reports.length === 0) {
    throw new Error('Refusing to write eval results: no reports supplied.');
  }
  const offending = collectReportModelIds(reports).filter((id) => !isCompliantModel(id));
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
