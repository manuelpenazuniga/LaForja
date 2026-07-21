/**
 * LA FORJA — reviewer orchestration (PRIMARY PATH, doc §7.1, §7.4).
 *
 * OWNER: Codex. Three EXPLICIT concurrent Responses calls (ambiguity, discipline,
 * distractor) via Promise.allSettled, with a per-reviewer timeout. A partial
 * failure NEVER breaks the run — a dead reviewer yields a recorded failure, and
 * the surviving reviewers still produce findings.
 *
 * The deterministic item_probe (src/probe/itemProbe.ts) also runs here; it needs
 * no model call.
 *
 * MULTI_AGENT_VARIANT=true is an EVAL-ONLY comparison path (doc §7.4) — it must
 * NEVER be the default.
 */
import type { ReviewerType } from '../core/types';
import type { EvalConfig } from '../eval/types';
import { delimitItem } from '../openai/client';
import { reviewAmbiguity } from './ambiguity';
import { reviewDiscipline } from './discipline';
import { reviewDistractors } from './distractors';

export interface RawItem {
  stem: string;
  options: string[];
  correctKey: string;
  authorRationale: string;
}

/**
 * Label an option by position: A, B, C… falling back to `#27` past the alphabet
 * so the labels stay unique for any option count.
 */
function optionLabel(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : `#${index + 1}`;
}

/**
 * Canonical UNTRUSTED text for an item — the one place a RawItem becomes the
 * string a reviewer sees. Deterministic: the same item always produces the same
 * text, so `promptHash` telemetry and eval reruns stay comparable.
 *
 * Returns the text UNWRAPPED. Delimiting is a separate step (`toDelimitedItem`)
 * precisely so this function can never be the second wrap in a double-wrap.
 *
 * Everything here is author-controlled and therefore hostile: the field labels
 * below are NOT a security boundary (an author can type "CORRECT_KEY:" into a
 * stem), they are only a reading aid. The delimiters are the boundary, and
 * `delimitItem` owns them.
 */
export function serializeItem(item: RawItem): string {
  const options = item.options.map((text, i) => `${optionLabel(i)}) ${text}`).join('\n');
  return [
    'STEM:',
    item.stem,
    '',
    'OPTIONS:',
    options,
    '',
    `CORRECT_KEY (as marked by the author): ${item.correctKey}`,
    '',
    'AUTHOR_RATIONALE:',
    item.authorRationale,
  ].join('\n');
}

/**
 * THE single wrap site for untrusted item text (hard constraint 1).
 *
 * `runGauntlet` calls this ONCE per pass and hands the result to all three
 * reviewers, which pass it to `callModel` verbatim. No reviewer calls
 * `delimitItem` itself: wrapping twice would nest one delimiter pair inside
 * another, and a model reading a nested pair can no longer tell where untrusted
 * text ends — which is exactly how a delimiter guarantee gets quietly broken.
 */
export function toDelimitedItem(item: RawItem): string {
  return delimitItem(serializeItem(item));
}

export interface ReviewerOutcome {
  reviewerType: ReviewerType;
  ok: boolean;
  /** Parsed contract when ok; error message otherwise. */
  contract?: unknown;
  error?: string;
  latencyMs: number;
  schemaValid: boolean;
}

export interface OrchestrationResult {
  /** Canonical names, single source of truth: EVAL_CONFIGS in src/eval/types.ts. */
  config: EvalConfig;
  outcomes: ReviewerOutcome[];
  /** true if at least one reviewer produced a schema-valid contract. */
  anySucceeded: boolean;
}

/**
 * TODO(codex): implement the gauntlet orchestration.
 *  - Call `toDelimitedItem(item)` ONCE and pass that exact string to every
 *    reviewer. The reviewers take ALREADY-DELIMITED text and must not re-wrap it.
 *  - config 'gauntlet': run reviewAmbiguity/reviewDiscipline/reviewDistractors
 *    concurrently with Promise.allSettled and a per-reviewer timeout
 *    (REVIEWER_TIMEOUT_MS). allSettled is load-bearing: Promise.all would let one
 *    rejected reviewer abort the pass, which hard constraint 3 forbids. The
 *    timeout must reject the individual reviewer, never the whole batch.
 *  - reviewDistractors resolves to a DistractorMap (an ARRAY). Fan it out: each
 *    entry becomes its own Check row (checkClass='semantic'), so one distractor
 *    outcome can yield N checks. The other two reviewers yield exactly one each.
 *  - Also run the deterministic item_probe.
 *  - config 'general-reviewer': a SINGLE general reviewer call (eval baseline, doc §8).
 *  - config 'gauntlet-no-adjudication': same as gauntlet but skip adjudication
 *    downstream (the caller decides).
 *  - Never throw on a single reviewer failure: capture it as ReviewerOutcome{ok:false}.
 *  - Persist a ModelCall per call and a GauntletRun for the pass.
 *  - If MULTI_AGENT_VARIANT env flag is set, use the multi-agent variant (eval only).
 * Reference: doc §7.1, §7.4, §8; hard constraint 3.
 */
export async function runGauntlet(
  _item: RawItem,
  _model: string,
  _config: OrchestrationResult['config'] = 'gauntlet',
): Promise<OrchestrationResult> {
  void reviewAmbiguity;
  void reviewDiscipline;
  void reviewDistractors;
  throw new Error('TODO(codex): implement concurrent orchestration with per-reviewer timeout');
}
