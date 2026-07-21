/**
 * LA FORJA — bounded OpenAI Responses API wrapper.
 *
 * OWNER: Codex (this is a model call site). Claude provides the typed contract,
 * the untrusted-input delimiters, and the telemetry shape; Codex implements the
 * bounded transport wrapper + Zod-validate + retry-once (hard constraint 3).
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
import { assertRuntimeCompliance, isCompliantModel } from '../config/models';

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

/**
 * Default wall-clock budget for ONE transport attempt (not for the whole
 * `callModel`, which may make two). Overridable per call via
 * `ModelCallArgs.timeoutMs`; three reviewers run concurrently behind this, so
 * the bound is what keeps a stalled provider from wedging a gauntlet run.
 */
export const DEFAULT_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// The transport seam
// ---------------------------------------------------------------------------

/**
 * WHY THIS SEAM EXISTS.
 *
 * `callModel` is two very different jobs welded together: (a) speak HTTP to a
 * provider, and (b) validate/retry/measure/log around whatever came back. Only
 * (a) needs the network and an API key. Splitting them at this type means every
 * behaviour that actually carries risk — retry-exactly-once, schema refusal,
 * timeout, the compliance gate, the delimiter guarantee — is exercisable
 * offline against a fake, and the real transport drops in unchanged the moment
 * a key exists.
 *
 * The seam is placed at the LAST possible point before the wire, deliberately.
 * Everything above it is ours and is tested; the untested surface below it is
 * one function whose only job is to turn this request into an HTTP call.
 */
export interface ModelTransportRequest {
  /**
   * EXACT model ID to dispatch. `callModel` has already passed it through
   * `assertRuntimeCompliance` — and every transport re-checks it anyway, because
   * a transport is exported and callable directly (see `ModelTransport`).
   */
  model: string;
  /** Trusted system prompt (guardrails + task). */
  system: string;
  /**
   * The user payload: UNTRUSTED item text, ALREADY wrapped by `delimitItem`.
   * A transport must send this VERBATIM — no re-wrapping, no trimming, no
   * templating around it. The wrap happens exactly once, upstream.
   */
  delimitedItem: string;
  /**
   * The contract the response must satisfy. The transport is expected to
   * constrain the provider's structured output to this schema rather than
   * merely hope for JSON; `callModel` re-validates regardless, because a
   * provider-side constraint is a convenience, never the guarantee.
   */
  schema: z.ZodTypeAny;
  /** Stable name for the structured-output schema, e.g. "ambiguity-v1". */
  schemaName: string;
  /** 0 for the first attempt, 1 for the single permitted retry. */
  attempt: 0 | 1;
  /**
   * Terse "your previous output was invalid for the contract" nudge. Present
   * ONLY on `attempt: 1`. It is appended by the transport to the system prompt
   * so the retry is a repair request rather than a blind re-roll.
   */
  repairNudge?: string;
  /** Aborted by `callModel` when `timeoutMs` elapses. Honour it. */
  signal: AbortSignal;
  /** Budget for THIS attempt, in ms. Mirrors the deadline behind `signal`. */
  timeoutMs: number;
  /** Telemetry passthrough so a transport can tag/trace the request. */
  promptVersion: string;
  callSite: ModelCallSite;
  reviewerType?: string;
}

/**
 * The RAW result of one network round trip. Deliberately unparsed: validation
 * is `callModel`'s job, above the seam, so a transport can never "helpfully"
 * launder a malformed response into a valid-looking object.
 */
export interface ModelTransportResponse {
  /** Response text exactly as returned. Not trimmed, not JSON.parse'd. */
  text: string;
  /**
   * The model ID the PROVIDER echoed back, when it reports one. This is the
   * ground truth for telemetry and may differ from the requested ID (aliases,
   * dated snapshots). Omit it rather than defaulting to the requested ID —
   * `callModel` falls back, and "we asked for X" must stay distinguishable from
   * "the provider confirmed X".
   *
   * RE-GATED. `callModel` re-asserts compliance on this value and THROWS if it
   * is not allowlisted, so an echoed ID outside ALLOWED_MODEL_IDS aborts the
   * call rather than merely being flagged. That includes dated snapshots: the
   * allowlist is a closed set on purpose, and an ID it does not name is not
   * evidence, whatever it resolves to.
   */
  modelId?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
}

/**
 * The single async function that actually talks to the network. Everything else
 * in this module is pure or fake-driven.
 *
 * A transport MUST: call `assertRuntimeCompliance(req.model)` as its FIRST
 * statement, send `delimitedItem` verbatim, expose no tools to the model,
 * honour `signal`, and reject (never resolve with junk) on transport failure.
 * A transport MUST NOT: retry internally (retry-exactly-once lives in
 * `callModel`, and a hidden inner retry would silently make it three or four
 * calls), parse or repair the response, or substitute a different model ID.
 *
 * WHY THE TRANSPORT RE-CHECKS COMPLIANCE. `callModel` gates the model ID before
 * it builds a request, but transports are exported values: any caller can hold
 * one and invoke it directly, and such a caller bypasses the allowlist entirely.
 * Defence in depth — the guarantee "only gpt-5.6 reaches the wire" must not rest
 * on every future call site remembering to route through `callModel`. The check
 * is idempotent and free, so duplicating it costs nothing and closes the hole.
 */
export type ModelTransport = (req: ModelTransportRequest) => Promise<ModelTransportResponse>;

/**
 * The real OpenAI Responses API transport. Codex-owned: this is the only code
 * in the system that needs a live API key, which is exactly why it is the only
 * code isolated behind a seam.
 *
 * THE COMPLIANCE GUARD BELOW IS ALREADY IMPLEMENTED AND IS NOT CODEX'S TO
 * REMOVE. It must stay the first statement of the function body, ahead of any
 * SDK construction or network work: this transport is an exported value and a
 * direct caller would otherwise never meet the allowlist at all.
 *
 * TODO(codex): implement with the OpenAI SDK (`openai` is already a dependency),
 * BELOW the guard.
 *  - `client.responses.create({ model: req.model, ... })`.
 *  - INPUT: system message = `req.system` plus, when `req.repairNudge` is
 *    present (retry only), that nudge appended as a final system line. User
 *    message = `req.delimitedItem` VERBATIM.
 *  - NO TOOLS. Do not pass `tools`, do not enable web search / code interpreter
 *    / file search (hard constraint 1: reviewers get no tools and no network).
 *  - STRUCTURED OUTPUT: constrain the response to `req.schema` — convert it to
 *    JSON Schema and pass it as `text.format = { type: 'json_schema', name:
 *    req.schemaName, schema, strict: true }`. Use the SDK's zod helper if it
 *    accepts the schema; several of ours are `.refine`/`.superRefine`-wrapped,
 *    whose predicates CANNOT be expressed in JSON Schema — so the structural
 *    part is constrained provider-side and the semantic refinements are caught
 *    by `callModel`'s `safeParse`. That split is intended, not a gap.
 *  - TIMEOUT: pass `req.signal` through to the SDK so an aborted call actually
 *    cancels the socket. `callModel` also races the promise, so a transport that
 *    ignores the signal leaks a request but cannot hang the caller.
 *  - RESPONSE: `text` = the raw output text. `modelId` = the model ID the API
 *    ECHOED BACK on the response body (`response.model`), NOT `req.model` — the
 *    point of the field is to record what actually ran. `tokensIn`/`tokensOut`
 *    from `response.usage`; omit any field the API did not report.
 *  - ERRORS: let SDK errors reject. Do not catch-and-return an empty string;
 *    "the provider 500'd" and "the model returned `''`" are different failures
 *    and `callModel` reports them differently.
 * Reference: doc §7.1, hard constraints 1, 3, 4.
 */
export const openaiTransport: ModelTransport = async (req) => {
  // Defence in depth: enforced HERE, not only in `callModel`, so a direct caller
  // of the exported transport cannot bypass the allowlist. Must stay first.
  assertRuntimeCompliance(req.model);
  throw new Error(
    'TODO(codex): implement the OpenAI Responses API transport (structured output, no tools, abort signal)',
  );
};

export type ModelCallSite = 'orchestrator' | 'adjudication' | 'viva';

export interface ModelCallArgs<T> {
  model: string;
  system: string;
  /** Untrusted item text, already wrapped with `delimitItem`. */
  delimitedItem: string;
  schema: z.ZodType<T>;
  promptVersion: string;
  callSite: ModelCallSite;
  reviewerType?: string;
  /** Per-attempt budget. Defaults to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface ModelCallResult<T> {
  data: T;
  raw: string;
  /** The ID the provider ECHOED — what actually served the call, not what we asked for. */
  modelId: string;
  /**
   * Recomputed from `modelId`. Always `true` on a returned result, because a
   * non-compliant echoed ID makes `callModel` throw; persisted so the evidence
   * states the fact instead of leaving a reader to infer it.
   */
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
 * The existing single-argument call sites (the three reviewers) keep working
 * unchanged; `transport` is an appended optional parameter, so injecting a fake
 * is opt-in and production behaviour is the default.
 *
 * IMPLEMENTATION: validate / retry-once / timeout / telemetry logic AROUND the
 * transport. There is deliberately no HTTP here — the network lives below the
 * seam.
 *  1. COMPLIANCE GATE FIRST. Call `assertRuntimeCompliance(args.model)` BEFORE
 *     constructing a request or touching `transport`. A non-allowlisted model
 *     must never reach the wire, so this throw must be unreachable-past
 *     (hard constraint 4). Nothing may be dispatched ahead of it.
 *  2. Attempt 0: build a ModelTransportRequest (attempt: 0, no repairNudge,
 *     schemaName from promptVersion/reviewerType) with a fresh AbortController;
 *     start a `timeoutMs ?? DEFAULT_TIMEOUT_MS` timer that aborts it. RACE the
 *     transport promise against the deadline — a transport that ignores its
 *     signal must still not hang the caller. Always clear the timer.
 *  3. `JSON.parse` the text, then `args.schema.safeParse`. BOTH failures are the
 *     same failure class: a malformed body and a body that violates a `.refine`
 *     (e.g. an ambiguity payload whose two answers are equal) are each "the
 *     contract was not met" and each get the one retry.
 *  4. On failure, retry EXACTLY ONCE (attempt: 1, `repairNudge` set). Exactly
 *     once — not a backoff loop. Two attempts maximum, per call, always.
 *  5. On a second failure, THROW readable: include the reviewer/callSite, the
 *     promptVersion, the Zod issues, and the RAW response text. Never return a
 *     partially-valid object and never fall back to a default — a silently bad
 *     contract object becomes a Check row and poisons the passport.
 *  6. A transport REJECTION (network error) surfaces as-is, wrapped with call
 *     context. Transport rejections are NOT retried by this layer.
 *  7. COMPLIANCE GATE AGAIN, ON THE ECHOED ID. Resolve
 *     `modelId = response.modelId ?? args.model` (the echoed ID wins), then call
 *     `assertRuntimeCompliance(modelId)` and let it THROW. Requesting a compliant
 *     model is not the same as having been SERVED one: a proxy, an alias or a
 *     provider fallback can echo back `gpt-4o` for a request that passed step 1,
 *     and only the second check is evidence. Recording `modelFamilyOk: false` and
 *     returning the result anyway is a FAIL-OPEN — the caller uses the object as
 *     if it were valid and a non-gpt-5.6 finding lands on the passport. Do this
 *     BEFORE constructing the result, so no non-compliant result object exists.
 *  8. Telemetry on success: latencyMs measured across the attempt(s), tokens and
 *     cost from the response, promptVersion, `promptHash(args.system)`,
 *     schemaValid: true, modelId = the echoed ID resolved in step 7 (keep the
 *     echoed value — it is the honest record of what actually served the call),
 *     modelFamilyOk = `isCompliantModel(modelId)` — recomputed from the ID that
 *     actually ran, not from the one requested. After step 7 this is necessarily
 *     `true` on any returned result; it is kept because the persisted evidence
 *     must state the fact rather than let a reader infer it.
 * Reference: doc §7.1, hard constraints 3 and 4.
 */
export async function callModel<T>(
  args: ModelCallArgs<T>,
  transport: ModelTransport = openaiTransport,
): Promise<ModelCallResult<T>> {
  // This must remain ahead of every possible transport invocation.
  assertRuntimeCompliance(args.model);

  const startedAt = Date.now();
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const callContext = args.reviewerType ?? args.callSite;
  let repairNudge: string | undefined;

  for (const attempt of [0, 1] as const) {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(
          new Error(
            `Model call timed out after ${timeoutMs}ms for ${callContext} ` +
              `(prompt ${args.promptVersion}, attempt ${attempt + 1}/2).`,
          ),
        );
      }, timeoutMs);
      timeout.unref();
    });

    const request: ModelTransportRequest = {
      model: args.model,
      system: args.system,
      delimitedItem: args.delimitedItem,
      schema: args.schema,
      schemaName: args.promptVersion,
      attempt,
      ...(repairNudge === undefined ? {} : { repairNudge }),
      signal: controller.signal,
      timeoutMs,
      promptVersion: args.promptVersion,
      callSite: args.callSite,
      ...(args.reviewerType === undefined ? {} : { reviewerType: args.reviewerType }),
    };

    let response: ModelTransportResponse;
    try {
      response = await Promise.race([transport(request), timeoutPromise]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Model transport failed for ${callContext} ` +
          `(prompt ${args.promptVersion}, attempt ${attempt + 1}/2): ${detail}`,
        { cause: error },
      );
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }

    const modelId = response.modelId ?? args.model;
    // The provider echo is evidence of what ran, so it is a hard post-call gate.
    assertRuntimeCompliance(modelId);

    let parsedJson: unknown;
    let validationDetail: string;
    try {
      parsedJson = JSON.parse(response.text) as unknown;
      const parsedContract = args.schema.safeParse(parsedJson);
      if (parsedContract.success) {
        return {
          data: parsedContract.data,
          raw: response.text,
          modelId,
          modelFamilyOk: isCompliantModel(modelId),
          latencyMs: Date.now() - startedAt,
          tokensIn: response.tokensIn,
          tokensOut: response.tokensOut,
          costUsd: response.costUsd,
          promptVersion: args.promptVersion,
          promptHash: promptHash(args.system),
          schemaValid: true,
        };
      }
      validationDetail = JSON.stringify(parsedContract.error.issues);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      validationDetail = `Invalid JSON: ${detail}`;
    }

    if (attempt === 0) {
      repairNudge =
        `Your previous response did not satisfy the ${args.promptVersion} contract. ` +
        `Return only valid JSON matching the contract. Validation failure: ${validationDetail}`;
      continue;
    }

    throw new Error(
      `Model contract validation failed for ${callContext} ` +
        `(call site ${args.callSite}, prompt ${args.promptVersion}) after 2 attempts. ` +
        `Validation issues: ${validationDetail}. Raw response: ${response.text}`,
    );
  }

  // The fixed tuple above is exhaustive; this protects against future edits.
  throw new Error(`Model call exhausted its attempt budget for prompt ${args.promptVersion}.`);
}
