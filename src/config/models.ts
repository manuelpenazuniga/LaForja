/**
 * LA FORJA — model configuration + GPT-5.6 compliance guard.
 *
 * OWNER: Claude (compliance tooling). The hackathon REQUIRES the runtime to use
 * only OpenAI gpt-5.6 models. This module makes that enforceable in code, and
 * every gate here FAILS CLOSED — an unrecognised model ID is rejected, never
 * tolerated:
 *  - `isCompliantModel` is exact membership in ALLOWED_MODEL_IDS.
 *  - `loadModelConfig` warns loudly and marks `compliance:false` at startup
 *    (warn-only, so a local checkout with a stale .env can still boot).
 *  - `assertRuntimeCompliance` throws at the MODEL-CALL boundary. Booting is
 *    allowed to be lenient; actually calling a model is not. No model call may
 *    proceed without it.
 *  - `assertEvalCompliance` throws, so the eval runner cannot write results
 *    produced by a non-gpt-5.6 model (those would be invalid submission
 *    evidence). It RECOMPUTES compliance from the model IDs and never trusts
 *    the `compliance` flag on the config object it was handed.
 *
 * Never hardcode model IDs in source — they come from env (doc "Stack"). The
 * allowlist below is not a runtime selection, it is the compliance boundary.
 */
import { z } from 'zod';

export const REQUIRED_MODEL_FAMILY = 'gpt-5.6';

/**
 * The EXACT model IDs this submission is permitted to use. Fail-closed: any ID
 * not literally present here is non-compliant.
 *
 * Why not a prefix match? `startsWith('gpt-5.6')` is unsafe — an arbitrary
 * suffix smuggles a different model past the guard. "gpt-5.60" is a distinct
 * (future) family, "gpt-5.6whatever" is not a real ID, and a hostile or
 * careless value like "gpt-5.6-evil-actually-something-else" would route to
 * something else entirely while reporting compliance:true. Membership in a
 * closed set is the only check that cannot be extended by a suffix.
 */
export const ALLOWED_MODEL_IDS = ['gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-sol'] as const;
export type AllowedModelId = (typeof ALLOWED_MODEL_IDS)[number];

const ALLOWED_MODEL_ID_SET: ReadonlySet<string> = new Set(ALLOWED_MODEL_IDS);

const EnvSchema = z.object({
  REVIEWER_MODEL: z.string().min(1),
  ADJUDICATOR_MODEL: z.string().min(1),
});

/**
 * Env-shaped input accepted by the config readers. The index signature keeps
 * `process.env` (NodeJS.ProcessEnv) assignable while still documenting the two
 * variables that matter.
 */
export interface ModelEnv {
  REVIEWER_MODEL?: string | undefined;
  ADJUDICATOR_MODEL?: string | undefined;
  [key: string]: string | undefined;
}

export interface ModelConfig {
  reviewerModel: string;
  adjudicatorModel: string;
  /** true iff every configured model ID is in the required family. */
  compliance: boolean;
  /** model IDs that are NOT in the required family (empty when compliant). */
  offending: string[];
}

/**
 * A single model ID is compliant iff it is EXACTLY one of ALLOWED_MODEL_IDS.
 * Exact membership, never a prefix test — see the ALLOWED_MODEL_IDS comment.
 */
export function isCompliantModel(id: string): boolean {
  return ALLOWED_MODEL_ID_SET.has(id);
}

/**
 * Pure evaluation of a model config. Defaults to the compliant IDs when unset,
 * so a bare checkout still boots in a compliant state.
 */
export function evaluateModels(env: ModelEnv): ModelConfig {
  const parsed = EnvSchema.parse({
    REVIEWER_MODEL: env.REVIEWER_MODEL ?? 'gpt-5.6-terra',
    ADJUDICATOR_MODEL: env.ADJUDICATOR_MODEL ?? 'gpt-5.6-sol',
  });
  const offending = [parsed.REVIEWER_MODEL, parsed.ADJUDICATOR_MODEL].filter(
    (m) => !isCompliantModel(m),
  );
  return {
    reviewerModel: parsed.REVIEWER_MODEL,
    adjudicatorModel: parsed.ADJUDICATOR_MODEL,
    compliance: offending.length === 0,
    offending,
  };
}

/**
 * Startup guard. Warns loudly on a non-compliant config but does NOT throw, so
 * local development can still boot. The returned `compliance` flag is persisted
 * on every GauntletRun and ModelCall.
 *
 * WARN-ONLY BY DESIGN, AND ONLY SAFE BECAUSE OF THE DOWNSTREAM GATES: booting
 * with a bad .env is tolerable, dispatching a call to a non-allowlisted model is
 * not. Every model call MUST pass through `assertRuntimeCompliance` first, and
 * every eval artifact write MUST pass through `assertEvalCompliance`.
 */
export function loadModelConfig(env: ModelEnv = process.env): ModelConfig {
  const cfg = evaluateModels(env);
  if (!cfg.compliance) {
    // eslint-disable-next-line no-console
    console.warn(
      `[COMPLIANCE] Non-${REQUIRED_MODEL_FAMILY} model(s) configured: ${cfg.offending.join(
        ', ',
      )}. Run logs and eval artifacts will be marked compliance:false and are ` +
        `INVALID as submission evidence. Set REVIEWER_MODEL / ADJUDICATOR_MODEL ` +
        `to ${REQUIRED_MODEL_FAMILY}-* to comply.`,
    );
  }
  return cfg;
}

/**
 * Hard gate for the MODEL-CALL boundary. Throws for any ID outside the
 * allowlist, so a non-allowlisted model can never actually be dispatched.
 *
 * `loadModelConfig` is deliberately warn-only so local dev boots; this is the
 * gate that makes "the runtime uses only gpt-5.6" true rather than aspirational.
 * Call it with the exact ID about to be sent to the provider, immediately before
 * dispatch — not with a config object read earlier, which may have drifted.
 */
export function assertRuntimeCompliance(modelId: string): void {
  if (!isCompliantModel(modelId)) {
    throw new Error(
      `Refusing to call a non-${REQUIRED_MODEL_FAMILY} model: "${modelId}" is not an ` +
        `allowed model ID. Allowed: ${ALLOWED_MODEL_IDS.join(', ')}.`,
    );
  }
}

/**
 * Hard gate for the eval runner. Throws unless EVERY configured model ID is on
 * the allowlist, so non-compliant results can never be written to
 * /eval/results/ (doc §8).
 *
 * DOES NOT TRUST `cfg.compliance` OR `cfg.offending`. Those are plain fields on
 * a plain object; a forged or stale ModelConfig could carry GPT-4 IDs alongside
 * `compliance:true` and would otherwise sail through. Compliance is RECOMPUTED
 * here from the model IDs themselves, which are the only load-bearing fields.
 */
export function assertEvalCompliance(cfg: ModelConfig): void {
  const offending = [cfg.reviewerModel, cfg.adjudicatorModel].filter((m) => !isCompliantModel(m));
  if (offending.length > 0) {
    throw new Error(
      `Refusing to write eval results: model family must be "${REQUIRED_MODEL_FAMILY}". ` +
        `Offending model(s): ${offending.join(', ')}.`,
    );
  }
}
