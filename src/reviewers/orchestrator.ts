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
import type { ItemProbeResult, ReviewerType } from '../core/types';
import type { EvalConfig } from '../eval/types';
import { delimitItem } from '../openai/client';
import { runItemProbe, type ProbeInput } from '../probe/itemProbe';
import { reviewAmbiguity } from './ambiguity';
import { reviewDiscipline } from './discipline';
import { reviewDistractors } from './distractors';
import type { Ambiguity, Discipline, DistractorMap } from './schemas';

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

/**
 * Per-reviewer wall-clock budget. A reviewer that exceeds it is CANCELLED (its
 * AbortSignal fires) and recorded as a timeout — the other reviewers keep
 * running, because a slow reviewer is a partial failure, never a dead pass.
 */
export const REVIEWER_TIMEOUT_MS = 45_000;

/**
 * The eval baseline of doc §8 is a SINGLE "general reviewer" call. It is not a
 * Check `reviewerType` (src/core/types.ts lists only the three specialists plus
 * the deterministic probe), so it is named HERE, at the orchestration layer,
 * where it is the only thing it ever is: one baseline call to compare the
 * gauntlet against.
 */
export const GENERAL_REVIEWER = 'general';
export type OrchestratedReviewer = ReviewerType | typeof GENERAL_REVIEWER;

/**
 * WHY a reviewer produced no contract. `timeout` and `error` are different
 * facts about the run and the passport has to be able to say which happened;
 * `schema` means the model answered but the contract stayed invalid after the
 * single permitted retry (hard constraint 3).
 */
export type ReviewerFailureKind = 'timeout' | 'error' | 'schema';

export interface ReviewerOutcome {
  reviewerType: OrchestratedReviewer;
  ok: boolean;
  /** Parsed contract when ok; error message otherwise. */
  contract?: unknown;
  error?: string;
  /** Set exactly when ok === false. */
  failureKind?: ReviewerFailureKind;
  latencyMs: number;
  schemaValid: boolean;
}

/**
 * The full record of one gauntlet pass: the findings, AND the two facts no
 * finding can carry — what was supposed to run, and whether it did.
 */
export interface OrchestrationResult {
  /** Canonical names, single source of truth: EVAL_CONFIGS in src/eval/types.ts. */
  config: EvalConfig;
  outcomes: ReviewerOutcome[];
  /** true if at least one reviewer produced a schema-valid contract. */
  anySucceeded: boolean;
  /**
   * THE FIELD THAT KEEPS THREE TIMEOUTS FROM LOOKING LIKE A CLEAN ITEM.
   *
   * true ONLY when every reviewer in `expectedReviewers` AND the deterministic
   * item_probe produced a result. "No finding was accepted" and "no reviewer
   * ran" both yield zero findings downstream; without this flag they are
   * indistinguishable, and the second one publishes. GAUNTLET_CLEAN
   * (src/core/types.ts) must never be dispatched when this is false.
   */
  complete: boolean;
  /** What this config was supposed to run — the denominator of `complete`. */
  expectedReviewers: readonly OrchestratedReviewer[];
  /** EVAL-ONLY comparison path (doc §7.4). Always false on the product path. */
  multiAgentVariant: boolean;
}

/**
 * A model reviewer as the orchestrator sees it: already-delimited text in, a
 * parsed contract out, cancellable.
 *
 * `signal` is OPTIONAL so the existing two-parameter reviewer functions remain
 * assignable, but the orchestrator always passes one: a timeout that leaves the
 * underlying request running is a leak, not a cancellation.
 */
export type ReviewerFn<T> = (
  delimitedItem: string,
  model: string,
  signal?: AbortSignal,
) => Promise<T>;

/**
 * THE INJECTABLE SEAM. Everything in this bundle is at or beyond the network
 * boundary; everything else in `runGauntlet` — concurrency, timeouts,
 * partial-failure capture, the single wrap — is on this side of it and is
 * therefore testable offline with fakes.
 */
export interface GauntletDeps {
  reviewAmbiguity: ReviewerFn<Ambiguity>;
  reviewDiscipline: ReviewerFn<Discipline>;
  reviewDistractors: ReviewerFn<DistractorMap>;
  /**
   * The doc §8 baseline: ONE general reviewer call. Its contract shape is
   * whatever that baseline prompt returns, so it is `unknown` here and is
   * validated by its own schema at the call site.
   */
  reviewGeneral: ReviewerFn<unknown>;
  /** Deterministic, no model call — which is why it still runs when every reviewer dies. */
  runItemProbe: (input: ProbeInput) => ItemProbeResult;
  /** Per-reviewer budget; defaults to REVIEWER_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * EXPLICIT opt-in for the eval-only comparison paths (doc §7.4). The
   * MULTI_AGENT_VARIANT env flag is honoured ONLY when the caller also passes
   * this, and only the eval runner does. Two independent switches, because an
   * env var set on a shared machine is one typo away from silently changing
   * what a student's item is reviewed by — and env vars leak between processes
   * in a way an explicit argument cannot.
   */
  allowEvalVariants?: boolean;
}

/**
 * TODO(codex): implement the doc §8 baseline reviewer in src/reviewers/general.ts
 * (one prompt, one call, its own Zod schema) and point this default at it.
 */
const reviewGeneralNotImplemented: ReviewerFn<unknown> = async () => {
  throw new Error('TODO(codex): implement the single general reviewer baseline (doc §8)');
};

/** The real bundle. Tests pass fakes; production passes nothing and gets this. */
export const DEFAULT_GAUNTLET_DEPS: GauntletDeps = {
  reviewAmbiguity,
  reviewDiscipline,
  reviewDistractors,
  reviewGeneral: reviewGeneralNotImplemented,
  runItemProbe,
};

/**
 * Which model reviewers each config runs. 'gauntlet-no-adjudication' differs
 * from 'gauntlet' only DOWNSTREAM (the caller skips adjudication), so at this
 * layer the two are identical by construction rather than by coincidence.
 */
export const CONFIG_REVIEWERS = {
  'general-reviewer': [GENERAL_REVIEWER],
  gauntlet: ['ambiguity', 'discipline', 'distractor'],
  'gauntlet-no-adjudication': ['ambiguity', 'discipline', 'distractor'],
} as const satisfies Record<EvalConfig, readonly OrchestratedReviewer[]>;

/** Env flag that selects the eval-only multi-agent variant (doc §7.4). */
export const MULTI_AGENT_VARIANT_ENV = 'MULTI_AGENT_VARIANT';

/** The product path. Flipping this default would put an eval path in production. */
export const DEFAULT_MULTI_AGENT_VARIANT = false;

/**
 * TODO(codex): implement the gauntlet orchestration.
 *  - Call `toDelimitedItem(item)` ONCE and pass that exact string to every
 *    reviewer. The reviewers take ALREADY-DELIMITED text and must not re-wrap it.
 *  - Call every reviewer through `deps`, never through the module imports
 *    directly: the bundle IS the network seam, and a direct import bypasses it.
 *  - config 'gauntlet': run deps.reviewAmbiguity/reviewDiscipline/reviewDistractors
 *    concurrently with Promise.allSettled and a per-reviewer timeout
 *    (deps.timeoutMs ?? REVIEWER_TIMEOUT_MS). allSettled is load-bearing:
 *    Promise.all would let one rejected reviewer abort the pass, which hard
 *    constraint 3 forbids. The timeout must reject the individual reviewer,
 *    never the whole batch, and must ABORT that reviewer's signal — the run
 *    stops waiting AND the request stops running.
 *  - Concurrency is a requirement, not an optimization: start all three before
 *    awaiting any of them. Sequential awaits would make the pass cost the SUM of
 *    the reviewer latencies and would let a slow first reviewer starve the rest.
 *  - reviewDistractors resolves to a DistractorMap (an ARRAY). Fan it out: each
 *    entry becomes its own Check row (checkClass='semantic'), so one distractor
 *    outcome can yield N checks. The other two reviewers yield exactly one each.
 *  - Also run the deterministic item_probe (deps.runItemProbe) and record it as
 *    an outcome with reviewerType 'item_probe'. It needs no model call, so it
 *    MUST still produce a result when every model reviewer failed.
 *  - config 'general-reviewer': a SINGLE general reviewer call (eval baseline,
 *    doc §8) — deps.reviewGeneral only; the three specialists are not called.
 *    Its outcome is recorded with reviewerType GENERAL_REVIEWER; it is a
 *    baseline measurement, never a Check row.
 *  - config 'gauntlet-no-adjudication': same as gauntlet but skip adjudication
 *    downstream (the caller decides). Identical at THIS layer.
 *  - Use CONFIG_REVIEWERS[config] as the expected set and copy it to
 *    `expectedReviewers`; set `complete` true only when every expected reviewer
 *    AND the probe produced a result. Zero findings from a complete run is a
 *    clean item; zero findings from an incomplete run is nothing at all.
 *  - Never throw on a single reviewer failure — nothing throws out of this
 *    function for a reviewer reason. Capture it as ReviewerOutcome{ok:false}
 *    with `error` (the failure text) and `failureKind`.
 *  - Persist a ModelCall per call and a GauntletRun for the pass.
 *  - `multiAgentVariant`: DEFAULT_MULTI_AGENT_VARIANT unless BOTH
 *    deps.allowEvalVariants is true AND the MULTI_AGENT_VARIANT_ENV flag is set
 *    (doc §7.4). The env flag alone must NEVER be enough — it must never become
 *    the product default.
 * Reference: doc §7.1, §7.4, §8; hard constraint 3.
 */
export async function runGauntlet(
  _item: RawItem,
  _model: string,
  _config: OrchestrationResult['config'] = 'gauntlet',
  _deps: GauntletDeps = DEFAULT_GAUNTLET_DEPS,
): Promise<OrchestrationResult> {
  throw new Error('TODO(codex): implement concurrent orchestration with per-reviewer timeout');
}
