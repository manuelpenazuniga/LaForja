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
import { reviewAmbiguity } from './ambiguity';
import { reviewDiscipline } from './discipline';
import { reviewDistractors } from './distractors';

export interface RawItem {
  stem: string;
  options: string[];
  correctKey: string;
  authorRationale: string;
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
 *  - Serialize `item` to the delimited untrusted text ONCE.
 *  - config 'gauntlet': run reviewAmbiguity/reviewDiscipline/reviewDistractors
 *    concurrently with Promise.allSettled and a per-reviewer timeout
 *    (REVIEWER_TIMEOUT_MS). Also run the deterministic item_probe.
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
