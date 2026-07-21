/**
 * LA FORJA — bounded OpenAI Responses API wrapper.
 *
 * OWNER: Codex (this is a model call site). Claude provides the typed contract,
 * the untrusted-input delimiters, and the telemetry shape; Codex implements the
 * actual API call + Zod-validate + retry-once (hard constraint 3).
 *
 * Hard constraints enforced here:
 *  1. Untrusted item text MUST be wrapped by the caller and passed as
 *     `delimitedItem`; the model gets NO tools and NO network (constraint 1).
 *  2. The model must NEVER be asked to author an item or a canonical solution
 *     (constraint 2) — that is enforced in the reviewer prompt templates.
 *  3. Validate output against `schema`; retry ONCE on parse/validation failure;
 *     then fail readable. Record model, latency, tokens, promptVersion, promptHash.
 */
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { isCompliantModel } from '../config/models';

/** Wrap untrusted item text in unambiguous delimiters (constraint 1). */
export const ITEM_OPEN = '<<<UNTRUSTED_ITEM>>>';
export const ITEM_CLOSE = '<<<END_UNTRUSTED_ITEM>>>';

/** What a delimiter token is replaced by when it appears inside item text. */
export const DELIMITER_REPLACEMENT = '[delimiter token removed]';

/**
 * Anything delimiter-SHAPED, not just the two exact tokens: extra angle
 * brackets, a closing slash, lower case, spacing, `END-` instead of `END_`.
 * A student pasting the real token is the expected case; an attacker probing
 * with near-misses is the reason this is a shape and not two string literals.
 */
const DELIMITER_SHAPED = /<{2,}\s*\/?\s*(?:END[_\s-]*)?UNTRUSTED[_\s-]*ITEM\s*>{2,}/gi;

/**
 * Strips every delimiter token from untrusted text.
 *
 * Exported so tests can assert the guarantee directly, and so a future caller
 * that builds its own payload cannot forget it.
 */
export function stripDelimiters(rawItemText: string): string {
  return rawItemText
    .replace(DELIMITER_SHAPED, DELIMITER_REPLACEMENT)
    // Belt and braces. Whatever the shape regex above may have missed, the two
    // EXACT tokens can never survive this, and it is the exact tokens that the
    // system prompt tells the model to trust as the boundary.
    .split(ITEM_OPEN)
    .join(DELIMITER_REPLACEMENT)
    .split(ITEM_CLOSE)
    .join(DELIMITER_REPLACEMENT);
}

/**
 * Wraps UNTRUSTED item text in the boundary the reviewer prompts describe
 * (hard constraint 1).
 *
 * TOTAL BY CONSTRUCTION. The payload is stripped of delimiter tokens BEFORE it
 * is wrapped, so the returned string always contains exactly one ITEM_OPEN (at
 * offset 0) and exactly one ITEM_CLOSE (at the end). A stem containing the
 * literal close token therefore cannot terminate the block early and have the
 * remainder read as trusted instruction — which is the single most obvious way
 * to attack a delimiter scheme, and a copy-paste away.
 *
 * NOT sanitization of the item's MEANING: "ignore previous instructions" is
 * passed through verbatim, because the reviewers must see exactly what the
 * student wrote and the guardrail preamble already tells the model to treat the
 * block as data. Only the boundary tokens themselves are neutralized.
 *
 * WHY NO PER-CALL NONCE: a random suffix would make the token unpredictable,
 * but it only helps if a token can leak through in the first place — and after
 * the strip above none can. A nonce would also desynchronize the exported
 * constants from the prompt text that names them (see DELIMITER_NOTE in
 * src/reviewers/guardrails.ts) and make prompt hashes unstable per call, which
 * hard constraint 3 logs for auditability. A deterministic, provable strip beats
 * an unpredictable token here.
 */
export function delimitItem(rawItemText: string): string {
  return `${ITEM_OPEN}\n${stripDelimiters(rawItemText)}\n${ITEM_CLOSE}`;
}

/** Stable hash of the exact system prompt sent, logged per call (constraint 3). */
export function promptHash(system: string): string {
  return createHash('sha256').update(system).digest('hex').slice(0, 16);
}

export interface ModelCallArgs<T> {
  model: string;
  system: string;
  /** Untrusted item text, already wrapped with `delimitItem`. */
  delimitedItem: string;
  schema: z.ZodType<T>;
  promptVersion: string;
  callSite: 'orchestrator' | 'adjudication' | 'viva';
  reviewerType?: string;
  timeoutMs?: number;
}

export interface ModelCallResult<T> {
  data: T;
  raw: string;
  modelId: string;
  modelFamilyOk: boolean;
  latencyMs: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  promptVersion: string;
  promptHash: string;
  schemaValid: boolean;
}

/**
 * Perform one bounded, schema-validated model call.
 *
 * TODO(codex): implement using the OpenAI SDK Responses API.
 *  - Build the request from { model, system, delimitedItem }; NO tools, response
 *    constrained to JSON that matches `schema` (use structured output / json_schema).
 *  - Measure latency; capture usage tokens and estimated cost if available.
 *  - Parse + `schema.safeParse`. On failure, retry EXACTLY once with a terse
 *    "your previous output was invalid JSON for the contract" nudge; on a second
 *    failure, throw a readable error including the raw text (do not swallow).
 *  - Set modelFamilyOk = isCompliantModel(model). Return ModelCallResult<T>.
 * Reference: doc §7.1, hard constraint 3.
 */
export async function callModel<T>(args: ModelCallArgs<T>): Promise<ModelCallResult<T>> {
  void isCompliantModel; // used by the Codex implementation
  void promptHash;
  throw new Error(
    'TODO(codex): implement bounded Responses API call with Zod-validate + retry-once',
  );
}
