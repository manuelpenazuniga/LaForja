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

export function delimitItem(rawItemText: string): string {
  return `${ITEM_OPEN}\n${rawItemText}\n${ITEM_CLOSE}`;
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
