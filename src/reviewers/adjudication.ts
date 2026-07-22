/**
 * LA FORJA — separate adjudication step (doc §6.2, §7.1).
 *
 * OWNER: Codex. This IS a model call site: §7.1 shows adjudication as its own
 * stage, and it runs on the adjudicator model (Sol) or on Terra depending on the
 * eval config. That is why the signature is async and why `adjudicatorModel` is
 * a real parameter and not decoration.
 *
 * NOT called "independent": §6.2 declares the correlated-error risk between the
 * reviewer model and the adjudicator model — they may share a family, a training
 * corpus and therefore a blind spot. The word is "separate", always. A separate
 * stage buys a second pass with a different prompt and a different job; it does
 * not buy statistical independence, and the project must never claim it does.
 *
 * The adjudicator:
 *  - validates each finding's contract completeness (schema-valid + semantics),
 *  - deduplicates findings,
 *  - assigns a verification kind, a class and a status to each check,
 *  - ABSTAINS on the unverifiable ("the model said so" is never final evidence).
 */
import { z } from 'zod';
import { CHECK_CLASS_BY_VERIFICATION } from '../core/checks';
import {
  CHECK_STATUS,
  REVIEWER_TYPES,
  VERIFICATION_KINDS,
  type CheckClass,
  type CheckStatus,
  type ItemState,
  type ReviewerType,
  type VerificationKind,
} from '../core/types';
import {
  ITEM_CLOSE,
  ITEM_OPEN,
  callModel,
  delimitItem,
  stripDelimiters,
  type ModelCallArgs,
  type ModelCallResult,
} from '../openai/client';
import { DELIMITER_NOTE, GUARDRAIL_PREAMBLE } from './guardrails';
import type { OrchestrationResult, ReviewerOutcome } from './orchestrator';
import {
  AmbiguitySchema,
  DisciplineSchema,
  DistractorSchema,
  ItemProbeSchema,
  REVIEWER_SCHEMAS,
} from './schemas';

/**
 * One adjudicated finding — the PRODUCER of the recorded-check shape.
 *
 * Adjudication is the only stage that knows how a finding was verified, because
 * assigning the class and the status IS deciding the verification kind. These
 * fields therefore originate here, are persisted verbatim on the `Check` row
 * (prisma/schema.prisma) and are read back by the history re-run engine
 * (RecordedCheck, src/core/checks.ts). One shape, three places — see the
 * field-for-field table in src/core/checks.ts.
 */
export interface AdjudicatedCheck {
  reviewerType: string;
  /**
   * HOW the finding was verified. Together with `reviewerType` this FIXES
   * `checkClass` through CHECK_CLASS_BY_VERIFICATION (src/core/checks.ts); the
   * two fields are never assigned independently.
   */
  verificationKind: VerificationKind;
  checkClass: CheckClass;
  status: CheckStatus;
  contract: unknown;
  schemaValid: boolean;
  /**
   * RE-EXECUTION IDENTITY. Required when checkClass is 'deterministic' or
   * 'counterexample'; omitted for 'semantic', which has no executor to name.
   * Without them the recorded check cannot be rebuilt on a later version and
   * strict non-regression is unimplementable (doc §5).
   */
  invariantId?: string;
  /** Version of the solver/probe that produced the recorded result. */
  executorVersion?: string;
  /** Version of the threshold table in force when the check was recorded. */
  thresholdVersion?: string;
  /** Reason for abstain/reject, for the passport trail. */
  note?: string;
}

export interface AdjudicationResult {
  checks: AdjudicatedCheck[];
  /** Next item state implied by the accepted checks (CHALLENGED vs clean). */
  nextState: Extract<ItemState, 'CHALLENGED' | 'DEFENSE'>;
  abstained: number;
  /**
   * The EXACT adjudicator model id that ruled on this run — compliance evidence
   * (doc §7.1, hard constraint 4). Take it from `ModelCallResult.modelId`, i.e.
   * the id the provider reports, not the id that was requested: a request for an
   * alias must record the resolved snapshot, or the audit trail asserts a model
   * that never ran.
   */
  adjudicatorModelId: string;
  /**
   * COMPLETENESS, and the reason this field exists at all.
   *
   * `nextState === 'DEFENSE'` means only "no finding was accepted". That is the
   * same sentence for "the item is clean" and for "the reviewers all timed out
   * and nobody objected because nobody ran". Those must never be one boolean.
   *
   * true ONLY when `OrchestrationResult.complete` is true (every expected
   * reviewer AND the deterministic item_probe produced a result) AND this
   * adjudication pass itself completed. It COMPOSES the upstream flag rather
   * than recomputing it: the orchestrator owns what "every reviewer ran" means,
   * adjudication owns "and then it was ruled on". The caller may dispatch
   * GAUNTLET_CLEAN (src/core/types.ts) only when this is true — `nextState`
   * alone never authorizes it.
   *
   * Findings that were all REJECTED or all ABSTAINED do NOT make a run
   * incomplete: rejecting and abstaining are reviews that happened. What makes a
   * run incomplete is a stage that did not run.
   */
  gauntletComplete: boolean;
  /** REQUIRED when `gauntletComplete` is false: which stage did not complete. */
  incompleteReason?: string;
}

/**
 * INJECTABLE TRANSPORT SEAM at the network boundary.
 *
 * There is no runtime API key, so the adjudication stage would otherwise be
 * unverifiable end to end. Everything on THIS side of the seam — contract
 * re-validation, dedup, class assignment, abstention, the completeness gate —
 * is pure and is driven by fakes in tests/adjudication.test.ts. Production
 * passes nothing and gets `callModel` (src/openai/client.ts).
 */
export type AdjudicatorTransport = <T>(args: ModelCallArgs<T>) => Promise<ModelCallResult<T>>;

export interface AdjudicationOptions {
  /** Defaults to `callModel` from src/openai/client.ts. */
  callModel?: AdjudicatorTransport;
  /**
   * The item text, ALREADY wrapped by `toDelimitedItem` at the orchestrator
   * boundary (hard constraint 1). Do NOT call `delimitItem` on it again here:
   * one wrap, one boundary. The reviewer CONTRACTS are a different payload and
   * are untrusted too — those adjudication wraps itself, since nothing wrapped
   * them earlier.
   */
  delimitedItem?: string;
  /** Injectable clock so recorded instants are reproducible under test. */
  now?: () => string;
}

/**
 * Response contract for the one separate adjudicator call. It is kept at this
 * network boundary because these rulings are not reviewer evidence contracts;
 * reviewer contracts themselves are re-validated through REVIEWER_SCHEMAS.
 */
export const AdjudicationSchema = z.array(
  z.object({
    finding_ref: z.string().trim().min(1),
    verification_kind: z.enum(VERIFICATION_KINDS),
    status: z.enum(CHECK_STATUS),
    note: z.string().trim().min(1),
  }),
);
export type AdjudicatorRuling = z.infer<typeof AdjudicationSchema>[number];

/**
 * WIRE envelope for the adjudicator call. OpenAI structured output (like the
 * distractor reviewer's, src/reviewers/distractors.ts) requires a JSON OBJECT at
 * the root — a bare array is rejected with `invalid_json_schema` ("schema must be
 * of type object, got type array"). The rulings array is therefore wrapped under
 * a `rulings` key on the wire and unwrapped below; the domain contract stays
 * `AdjudicationSchema`.
 */
export const AdjudicationEnvelopeSchema = z.object({ rulings: AdjudicationSchema });

export const ADJUDICATION_PROMPT_VERSION = 'adjudication-v1';

export const ADJUDICATION_SYSTEM = [
  GUARDRAIL_PREAMBLE,
  DELIMITER_NOTE,
  '',
  'TASK: Rule only on the reviewer findings supplied in the untrusted block.',
  'Never author an item, solution, citation, solver result, or new finding.',
  'Return a JSON object { "rulings": [ ... ] } whose "rulings" is an array of',
  'rulings, each with finding_ref, verification_kind, status, and note.',
  'The stable finding reference is reviewerType#index, using the displayed index.',
  'You may refuse evidence, but you may never manufacture evidence or promote an',
  'unverified assertion. The model said so is never final evidence.',
].join('\n');

const PROBE_EXECUTOR_VERSION = 'probe@1.0.0';
const THRESHOLD_VERSION = 'thresholds@1.0.0';

interface CandidateCheck {
  findingRef: string;
  check: AdjudicatedCheck;
  dedupeKey?: string;
  evidenceRank: number;
}

/**
 * Runs one separate model ruling pass, then applies the non-overridable code
 * gates: contract re-validation, evidence-based abstention, taxonomy lookup,
 * distractor deduplication, and upstream completeness composition.
 *
 * A transport or response-contract failure is deliberately allowed to reject;
 * returning DEFENSE after adjudication failed would make an incomplete run look
 * clean. Reference: doc §6.2, §7.1; hard constraints 1-3.
 */
export async function adjudicate(
  orchestration: OrchestrationResult,
  adjudicatorModel: string,
  options: AdjudicationOptions = {},
): Promise<AdjudicationResult> {
  // The distractor reviewer emits ONE outcome carrying the whole DistractorMap
  // (an array), but the rest of adjudication is written per single finding (§6.2:
  // one Check per distractor entry). Expand that outcome into one distractor
  // outcome per entry BEFORE anything reads `outcomes`, so buildCallPayload, the
  // finding_ref indices and the candidate loop all see the same expanded list and
  // stay consistent. Without this the whole lane is rejected as
  // "Expected object, received array".
  const outcomes = expandDistractorOutcomes(orchestration.outcomes ?? []);
  const callPayload = buildCallPayload(outcomes, options.delimitedItem);
  const invoke = options.callModel ?? callModel;
  const callResult = await invoke<z.infer<typeof AdjudicationEnvelopeSchema>>({
    model: adjudicatorModel,
    system: ADJUDICATION_SYSTEM,
    delimitedItem: callPayload,
    schema: AdjudicationEnvelopeSchema,
    promptVersion: ADJUDICATION_PROMPT_VERSION,
    callSite: 'adjudication',
  });

  // The production caller validates this at the network boundary. Re-checking
  // also keeps an injected transport from bypassing the response contract. The
  // rulings array is unwrapped from the object envelope required by structured
  // output (see AdjudicationEnvelopeSchema).
  const parsedEnvelope = AdjudicationEnvelopeSchema.safeParse(callResult.data);
  if (!parsedEnvelope.success) {
    throw new Error(
      `Adjudicator returned an invalid ruling contract: ${JSON.stringify(parsedEnvelope.error.issues)}`,
    );
  }
  const parsedRulings = { data: parsedEnvelope.data.rulings };

  const knownRefs = new Set(
    outcomes
      .map((outcome, index) =>
        outcome.ok && isReviewerType(outcome.reviewerType)
          ? findingRef(outcome.reviewerType, index)
          : undefined,
      )
      .filter((value): value is string => value !== undefined),
  );
  const rulings = new Map<string, AdjudicatorRuling>();
  for (const ruling of parsedRulings.data) {
    if (knownRefs.has(ruling.finding_ref) && !rulings.has(ruling.finding_ref)) {
      rulings.set(ruling.finding_ref, ruling);
    }
  }

  const candidates: CandidateCheck[] = [];
  outcomes.forEach((outcome, index) => {
    if (!outcome.ok || !isReviewerType(outcome.reviewerType)) return;
    candidates.push(
      makeCandidate(outcome, index, rulings.get(findingRef(outcome.reviewerType, index)), callResult.modelId),
    );
  });

  const checks = deduplicate(candidates).map((candidate) => candidate.check);
  const accepted = checks.some((check) => check.status === 'accepted');
  const gauntletComplete = orchestration.complete === true;

  return {
    checks,
    nextState: accepted ? 'CHALLENGED' : 'DEFENSE',
    abstained: checks.filter((check) => check.status === 'abstained').length,
    adjudicatorModelId: callResult.modelId,
    gauntletComplete,
    ...(gauntletComplete ? {} : { incompleteReason: incompleteReason(orchestration) }),
  };
}

/**
 * Expand a distractor outcome whose contract is a DistractorMap (array) into one
 * distractor outcome per entry, so the per-finding adjudication logic (§6.2: one
 * Check per distractor entry) runs on each. Order is preserved so finding_ref
 * indices stay stable. Any other outcome passes through unchanged — including a
 * distractor outcome whose contract is NOT a non-empty array (a malformed or
 * empty contract), which is left intact so classifyOutcome can reject it and the
 * lane keeps a recorded (rejected) row rather than silently vanishing.
 */
function expandDistractorOutcomes(outcomes: ReviewerOutcome[]): ReviewerOutcome[] {
  const expanded: ReviewerOutcome[] = [];
  for (const outcome of outcomes) {
    if (
      outcome.ok &&
      outcome.reviewerType === 'distractor' &&
      Array.isArray(outcome.contract) &&
      outcome.contract.length > 0
    ) {
      for (const finding of outcome.contract) {
        expanded.push({ ...outcome, contract: finding });
      }
      continue;
    }
    expanded.push(outcome);
  }
  return expanded;
}

function buildCallPayload(outcomes: ReviewerOutcome[], delimitedItem: string | undefined): string {
  const findings = outcomes
    .map((outcome, index) => ({
      finding_ref: `${outcome.reviewerType}#${index}`,
      reviewer_type: outcome.reviewerType,
      outcome: outcome.ok ? 'produced' : 'failed',
      ...(outcome.ok ? { contract: outcome.contract } : { error: outcome.error }),
    }));
  const serialized = stripDelimiters(JSON.stringify(findings));
  const supplied = delimitedItem ?? delimitItem('No item text was supplied.');

  if (supplied.startsWith(ITEM_OPEN) && supplied.endsWith(ITEM_CLOSE)) {
    const withoutClose = supplied.slice(0, -ITEM_CLOSE.length);
    return `${withoutClose}\nREVIEWER FINDINGS (UNTRUSTED):\n${serialized}\n${ITEM_CLOSE}`;
  }

  return delimitItem(`${stripDelimiters(supplied)}\nREVIEWER FINDINGS (UNTRUSTED):\n${serialized}`);
}

function isReviewerType(value: string): value is ReviewerType {
  return (REVIEWER_TYPES as readonly string[]).includes(value);
}

function findingRef(reviewerType: ReviewerType, index: number): string {
  return `${reviewerType}#${index}`;
}

function makeCandidate(
  outcome: ReviewerOutcome,
  index: number,
  ruling: AdjudicatorRuling | undefined,
  adjudicatorModelId: string,
): CandidateCheck {
  const reviewerType = outcome.reviewerType as ReviewerType;
  const contract = outcome.contract;
  const ref = findingRef(reviewerType, index);

  switch (reviewerType) {
    case 'ambiguity': {
      const parsed = AmbiguitySchema.safeParse(contract);
      const check = createCheck(
        reviewerType,
        'interpretation',
        contract,
        parsed.success,
        parsed.success ? 'accepted' : 'rejected',
        parsed.success ? undefined : schemaFailureNote(reviewerType, parsed.error.issues),
        ruling,
        {
          invariantId: 'ambiguity_two_readings_disagree',
          executorVersion: adjudicatorModelId,
          thresholdVersion: THRESHOLD_VERSION,
        },
      );
      return { findingRef: ref, check, evidenceRank: parsed.success ? 2 : 0 };
    }
    case 'discipline': {
      const parsed = DisciplineSchema.safeParse(contract);
      const hasSolver = parsed.success && parsed.data.solver_proof != null;
      const hasCitation = parsed.success && parsed.data.citation != null;
      const verificationKind: VerificationKind = hasSolver ? 'solver' : 'citation';
      const status: CheckStatus = !parsed.success
        ? 'rejected'
        : hasSolver || hasCitation
          ? 'accepted'
          : 'abstained';
      const note = !parsed.success
        ? schemaFailureNote(reviewerType, parsed.error.issues)
        : status === 'abstained'
          ? 'Abstained: the discipline claim has no citation, source, or recorded solver proof to verify it.'
          : undefined;
      const identity = hasSolver
        ? {
            invariantId: 'solver_key_matches',
            executorVersion: parsed.data.solver_proof?.solver_version ?? 'missing-solver-version',
            thresholdVersion: THRESHOLD_VERSION,
          }
        : undefined;
      const check = createCheck(
        reviewerType,
        verificationKind,
        contract,
        parsed.success,
        status,
        note,
        ruling,
        identity,
      );
      return { findingRef: ref, check, evidenceRank: hasSolver || hasCitation ? 3 : 1 };
    }
    case 'distractor': {
      const parsed = DistractorSchema.safeParse(contract);
      const evidenced = parsed.success && parsed.data.label === 'evidenced' && Boolean(parsed.data.evidence);
      const verificationKind: VerificationKind = evidenced ? 'citation' : 'interpretation';
      const status: CheckStatus = !parsed.success ? 'rejected' : evidenced ? 'accepted' : 'hypothesis';
      const note = parsed.success ? undefined : schemaFailureNote(reviewerType, parsed.error.issues);
      const check = createCheck(
        reviewerType,
        verificationKind,
        contract,
        parsed.success,
        status,
        note,
        ruling,
      );
      const raw = isRecord(contract) ? contract : undefined;
      const distractor = typeof raw?.distractor === 'string' ? normalize(raw.distractor) : undefined;
      const error = typeof raw?.hypothesized_error === 'string'
        ? normalize(raw.hypothesized_error)
        : undefined;
      return {
        findingRef: ref,
        check,
        ...(distractor && error ? { dedupeKey: `${distractor}\u0000${error}` } : {}),
        evidenceRank: evidenced ? 3 : parsed.success ? 2 : 0,
      };
    }
    case 'item_probe': {
      const parsed = ItemProbeSchema.safeParse(contract);
      const flagged = parsed.success && (parsed.data.answer_length_flag || parsed.data.lexical_overlap_flag);
      const invariantId = parsed.success && !parsed.data.answer_length_flag && parsed.data.lexical_overlap_flag
        ? 'lexical_overlap_flag'
        : 'answer_length_flag';
      const check = createCheck(
        reviewerType,
        'heuristic',
        contract,
        parsed.success,
        !parsed.success || !flagged ? 'rejected' : 'accepted',
        !parsed.success
          ? schemaFailureNote(reviewerType, parsed.error.issues)
          : flagged
            ? undefined
            : 'Rejected: the deterministic item probe completed and neither published cue threshold was flagged.',
        ruling,
        {
          invariantId,
          executorVersion: PROBE_EXECUTOR_VERSION,
          thresholdVersion: THRESHOLD_VERSION,
        },
      );
      return { findingRef: ref, check, evidenceRank: flagged ? 3 : 2 };
    }
  }
}

function createCheck(
  reviewerType: ReviewerType,
  verificationKind: VerificationKind,
  contract: unknown,
  schemaValid: boolean,
  protectedStatus: CheckStatus,
  protectedNote: string | undefined,
  ruling: AdjudicatorRuling | undefined,
  identity?: Pick<AdjudicatedCheck, 'invariantId' | 'executorVersion' | 'thresholdVersion'>,
): AdjudicatedCheck {
  const checkClass = CHECK_CLASS_BY_VERIFICATION[reviewerType][verificationKind];
  if (checkClass === null) {
    throw new Error(`Illegal adjudication taxonomy pair: ${reviewerType}/${verificationKind}`);
  }

  let status = protectedStatus;
  let note = protectedNote;
  const codeProtected =
    !schemaValid || protectedStatus === 'abstained' || protectedStatus === 'hypothesis' ||
    (reviewerType === 'item_probe' && protectedStatus === 'rejected');

  if (!codeProtected && ruling !== undefined) {
    if (ruling.verification_kind !== verificationKind) {
      status = 'rejected';
      note =
        `Rejected: the adjudicator proposed verification kind '${ruling.verification_kind}', ` +
        `but the recorded contract requires '${verificationKind}'.`;
    } else if (ruling.status === 'accepted') {
      status = 'accepted';
      note = ruling.note;
    } else if (ruling.status === 'rejected') {
      status = 'rejected';
      note = `Rejected by the separate adjudicator: ${ruling.note}`;
    } else if (ruling.status === 'abstained' || ruling.status === 'proposed') {
      status = 'abstained';
      note = `Abstained by the separate adjudicator: ${ruling.note}`;
    }
  }

  if ((status === 'rejected' || status === 'abstained') && !note?.trim()) {
    note = `The ${reviewerType} finding was ${status} because its required verification did not complete.`;
  }

  return {
    reviewerType,
    verificationKind,
    checkClass,
    status,
    contract,
    schemaValid,
    ...(identity ?? {}),
    ...(note === undefined ? {} : { note }),
  };
}

function deduplicate(candidates: CandidateCheck[]): CandidateCheck[] {
  const result: CandidateCheck[] = [];
  const distractorPositions = new Map<string, number>();

  for (const candidate of candidates) {
    if (candidate.dedupeKey === undefined) {
      result.push(candidate);
      continue;
    }
    const existingPosition = distractorPositions.get(candidate.dedupeKey);
    if (existingPosition === undefined) {
      distractorPositions.set(candidate.dedupeKey, result.length);
      result.push(candidate);
      continue;
    }

    const existing = result[existingPosition];
    if (existing === undefined) continue;
    const kept = candidate.evidenceRank > existing.evidenceRank ? candidate : existing;
    kept.check.note = appendNote(
      kept.check.note,
      'Merged a duplicate distractor finding with the same hypothesized error.',
    );
    result[existingPosition] = kept;
  }

  return result;
}

function schemaFailureNote(reviewerType: ReviewerType, issues: z.ZodIssue[]): string {
  const detail = issues[0]?.message ?? 'the evidence contract was malformed';
  return `Rejected: the ${reviewerType} finding failed contract re-validation (${detail}).`;
}

function incompleteReason(orchestration: OrchestrationResult): string {
  const outcomes = orchestration.outcomes ?? [];
  const expected = orchestration.expectedReviewers ?? [];
  for (const reviewer of expected) {
    const outcome = outcomes.find((candidate) => candidate.reviewerType === reviewer && candidate.ok);
    if (outcome === undefined) {
      const failure = outcomes.find((candidate) => candidate.reviewerType === reviewer && !candidate.ok);
      return `${reviewer} did not complete${failure?.error ? `: ${failure.error}` : '.'}`;
    }
  }
  if (!outcomes.some((outcome) => outcome.reviewerType === 'item_probe' && outcome.ok)) {
    return 'item_probe did not complete.';
  }
  return 'The upstream orchestration run was marked incomplete.';
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function appendNote(existing: string | undefined, addition: string): string {
  return existing?.trim() ? `${existing} ${addition}` : addition;
}
