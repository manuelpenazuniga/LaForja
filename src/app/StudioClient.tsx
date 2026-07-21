'use client';

/**
 * LA FORJA — the studio, one single end-to-end route.
 *
 * OWNER: Claude (presentation + local state shapes only).
 *
 * This file contains no review or publication policy. The `api` boundary calls
 * the five real routes, validates every response, and streams reviewer lanes as
 * they settle. The state machine itself is called through `reduce()` from
 * src/core/stateMachine.ts — this component never decides which transition is
 * legal, it only renders the recorded result.
 *
 * Flow order on screen (doc §3 winning slice):
 *   01 item + editable form        05 history re-run by check class
 *   02 gauntlet lanes              06 written defense + rubric
 *   03 accepted counterexample     07 item passport
 *   04 repair v1 -> v2 + diff
 *
 * THE ROUTES ARE THE SOURCE OF TRUTH. Exactly five exist, and the client calls
 * these and nothing else:
 *   POST /api/session            -> loadDemoChallenge
 *   POST /api/gauntlet           -> runGauntlet        (ndjson stream)
 *   POST /api/repair             -> submitRepair       (slice elements 4 AND 5)
 *   POST /api/defense            -> startDefense + submitDefense (two phases,
 *                                   selected by the presence of `answers`)
 *   GET  /api/passport/[itemId]  -> loadPassport       (path segment, not ?itemId)
 *
 * Do NOT add a standalone re-run endpoint, and do NOT split the defense route
 * into question/score sub-routes. Screen 05 is fed by the `reRun` payload the
 * repair route already returns — a second re-run call would execute the whole
 * history twice and write duplicate HistoryReRun rows. Inventing a route also
 * bypasses the doc §10 isolation envelope (session resolution, rate limit,
 * input size caps, Zod validation) that the five routes above implement.
 *
 * tests/studioRoutes.test.ts enforces this: every /api path named in this file
 * must resolve to a route.ts on disk.
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';

import { reduce } from '@/core/stateMachine';
import OnboardingDrawer from './OnboardingDrawer';
import {
  RUBRIC_DIMENSIONS,
  type AmbiguityContract,
  type CheckClass,
  type CheckStatus,
  type DefenseRubric,
  type DisciplineContract,
  type DistractorContract,
  type ItemProbeResult,
  type ItemState,
  type ReviewerType,
  type RubricDimensionKey,
  type StateEvent,
} from '@/core/types';
import type { ReRunOutcome } from '@/core/checks';
import type { Passport } from '@/passport/passport';
import { LENGTH_HIGH, LENGTH_LOW, OVERLAP_HIGH } from '@/probe/itemProbe';
import {
  AmbiguitySchema,
  DefenseQuestionsSchema,
  DefenseRubricSchema,
  DisciplineSchema,
  DistractorMapSchema,
  ItemProbeSchema,
} from '@/reviewers/schemas';

// ---------------------------------------------------------------------------
// Local state shapes (typed from src/core/types.ts — never re-declared by hand)
// ---------------------------------------------------------------------------

/** One version of an item as the UI needs it. Zero PII by construction. */
export interface StudioItem {
  id: string;
  versionNumber: number;
  stem: string;
  options: string[];
  correctKey: string;
  authorRationale: string;
  /** Display-only anchor supplied by the demo seed; arbitrary items omit it. */
  stemSplit?: { before: string; ambiguous: string; after: string };
}

/** The editable form buffer. Same fields as StudioItem, minus identity. */
type ItemDraft = Omit<StudioItem, 'id' | 'versionNumber' | 'stemSplit'>;

/** A reviewer's parsed evidence contract, discriminated by reviewer. */
type LaneContract =
  | { kind: 'ambiguity'; value: AmbiguityContract }
  | { kind: 'discipline'; value: DisciplineContract }
  | { kind: 'distractor'; value: DistractorContract[] }
  | { kind: 'item_probe'; value: ItemProbeResult };

type LaneStatus = 'idle' | 'running' | 'done' | 'degraded';

interface LaneState {
  status: LaneStatus;
  contract: LaneContract | null;
  latencyMs: number | null;
  schemaValid: boolean | null;
  promptVersion: string | null;
  model: string | null;
  /** Set when the reviewer failed. The lane degrades; the page keeps working. */
  error: string | null;
}

type LaneMap = Record<ReviewerType, LaneState>;

/** A check after the separate adjudication step. */
export interface AdjudicatedCheckView {
  id: string;
  reviewerType: ReviewerType;
  checkClass: CheckClass;
  status: CheckStatus;
  contract: LaneContract;
  note?: string;
}

export interface GauntletResult {
  checks: AdjudicatedCheckView[];
  abstained: number;
  adjudicatorModel: string;
  /** The transition the server decided; the UI only applies it. */
  event: Extract<StateEvent, 'CHECKS_ACCEPTED' | 'GAUNTLET_CLEAN'>;
}

/**
 * The FULL response of POST /api/repair. The history re-run happens inside that
 * same request, so its payload arrives here — there is no second endpoint and no
 * second execution of the history.
 */
export interface RepairResult {
  itemId: string;
  newVersionId: string;
  versionNumber: number;
  /** Recorded diff vs the previous version, as the route computed it. */
  diff: string | null;
  reRun: {
    /** Every class key is always present, so the UI never guards on undefined. */
    byClass: Record<CheckClass, ReRunOutcome[]>;
    /** true when a deterministic/counterexample check regressed: no publish. */
    blocksPublish: boolean;
    total: number;
  };
  /** Item state AFTER the server dispatched the re-run transition. */
  state: ItemState;
}

export interface DefenseQuestion {
  id: string;
  prompt: string;
}

/**
 * The `phase: 'scored'` response of POST /api/defense.
 *
 * `rubric` is nullable because an evaluator failure is a normal 200 with
 * outcome 'inconclusive' and no rubric — never an error and never an auto-reject
 * (doc §6.3). Making it non-nullable would leave the DEFENSE_EVALUATOR_FAILED
 * case unrepresentable by this very type.
 */
export interface DefenseResult {
  rubric: DefenseRubric | null;
  outcome: 'passed' | 'failed' | 'inconclusive';
  /** Item state AFTER the server dispatched the defense transition. */
  state: ItemState;
  /** Derived from `outcome` at the client boundary; the route sends outcome + state. */
  event: Extract<
    StateEvent,
    'DEFENSE_PASSED' | 'DEFENSE_FAILED' | 'DEFENSE_EVALUATOR_FAILED'
  >;
}

export interface SessionInfo {
  pseudonym: string;
  ttlMinutes: number;
  item: StudioItem;
}

interface Notice {
  tone: 'info' | 'warn';
  label: string;
  text: string;
}

interface TrailStep {
  from: ItemState;
  event: StateEvent;
  to: ItemState;
}

export interface StudioClientProps {
  /** Model IDs resolved from env on the server (never hardcoded). */
  reviewerModel: string;
  adjudicatorModel: string;
  modelCompliant: boolean;
  /** False when no server-side API key is configured; model controls stay inert. */
  modelCallsAvailable: boolean;
  /**
   * The seeded demo challenge, mirrored from prisma/seed.ts so the studio has
   * something to render before the session route answers.
   */
  demoFixture: StudioItem;
}

// ---------------------------------------------------------------------------
// Data access. Every boundary is response-validated before it reaches state.
// ---------------------------------------------------------------------------

const ItemStateSchema = z.enum([
  'DRAFT',
  'GAUNTLET',
  'CHALLENGED',
  'REGRESSION',
  'DEFENSE',
  'DEFENSE_INCONCLUSIVE',
  'PUBLISHED',
  'DISPUTED',
]);
const ReviewerTypeSchema = z.enum(['ambiguity', 'discipline', 'distractor', 'item_probe']);
const CheckClassSchema = z.enum(['deterministic', 'counterexample', 'semantic']);
const CheckStatusSchema = z.enum(['proposed', 'accepted', 'rejected', 'abstained', 'hypothesis']);

const SessionWireSchema = z.object({
  pseudonym: z.string().min(1),
  expiresAt: z.string().datetime(),
  demoItem: z
    .object({
      itemId: z.string().min(1),
      versionNumber: z.number().int().positive(),
      stem: z.string().min(1),
      options: z.array(z.string().min(1)).min(2),
      correctKey: z.string().min(1),
      authorRationale: z.string().min(1),
    })
    .nullable(),
});

const ExecutableReRunSchema = z.object({
  originalCheckId: z.string().min(1),
  checkClass: z.enum(['deterministic', 'counterexample']),
  result: z.enum(['pass', 'regressed', 'inconclusive']),
  blocksPublish: z.boolean(),
  detail: z.string().optional(),
});
const SemanticReRunSchema = z.object({
  originalCheckId: z.string().min(1),
  checkClass: z.literal('semantic'),
  result: z.enum(['readjudicated', 'inconclusive']),
  blocksPublish: z.literal(false),
  verdict: z
    .object({
      status: z.enum(['upheld', 'withdrawn', 'modified']),
      rationale: z.string().min(1),
      adjudicatedAt: z.string(),
    })
    .optional(),
  detail: z.string().optional(),
});
const ReRunSchema = z.union([ExecutableReRunSchema, SemanticReRunSchema]);
const RepairWireSchema = z.object({
  itemId: z.string().min(1),
  newVersionId: z.string().min(1),
  versionNumber: z.number().int().positive(),
  diff: z.string().nullable(),
  reRun: z.object({
    byClass: z.object({
      deterministic: z.array(ReRunSchema),
      counterexample: z.array(ReRunSchema),
      semantic: z.array(ReRunSchema),
    }),
    blocksPublish: z.boolean(),
    total: z.number().int().nonnegative(),
  }),
  state: ItemStateSchema,
});

const QuestionsWireSchema = z.object({
  phase: z.literal('questions'),
  questions: DefenseQuestionsSchema,
  state: ItemStateSchema,
});
const ScoredWireSchema = z.object({
  phase: z.literal('scored'),
  rubric: DefenseRubricSchema.nullable(),
  outcome: z.enum(['passed', 'failed', 'inconclusive']),
  state: ItemStateSchema,
});

const PassportWireSchema = z.object({
  itemId: z.string().min(1),
  itemVersionId: z.string().min(1),
  authorPseudonym: z.string().min(1),
  provenance: z.string().min(1),
  license: z.string().min(1),
  discipline: z.string().min(1),
  acceptedAttacks: z.array(
    z.object({ reviewerType: z.string(), checkClass: CheckClassSchema, contract: z.unknown() }),
  ),
  historyReRun: z.array(
    z.object({
      checkClass: CheckClassSchema,
      result: z.enum(['pass', 'regressed', 'readjudicated', 'inconclusive']),
      detail: z.string().optional(),
      verdict: z.unknown().optional(),
    }),
  ),
  disciplineVerdict: z.object({
    verdict: z.enum(['correct', 'incorrect', 'unverified']),
    citation: z
      .object({
        source_id: z.string(),
        version_date: z.string(),
        license: z.string(),
        excerpt: z.string(),
        relevance: z.string(),
      })
      .nullable(),
  }),
  defense: z.union([DefenseRubricSchema, z.object({ outcome: z.literal('inconclusive') })]),
  versions: z.array(
    z.object({ versionNumber: z.number().int().positive(), diff: z.string().optional() }),
  ),
  publishedAt: z.string(),
});

const GauntletEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('run_started'),
    reviewerModel: z.string(),
    adjudicatorModel: z.string(),
    compliance: z.boolean(),
  }).passthrough(),
  z.object({
    type: z.literal('reviewer_result'),
    reviewerType: ReviewerTypeSchema,
    ok: z.boolean(),
    degraded: z.boolean(),
    schemaValid: z.boolean(),
    latencyMs: z.number().nonnegative(),
    contract: z.unknown().optional(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal('adjudication'),
    checks: z.array(
      z.object({
        reviewerType: ReviewerTypeSchema,
        checkClass: CheckClassSchema,
        status: CheckStatusSchema,
        contract: z.unknown(),
        schemaValid: z.boolean(),
        note: z.string().optional(),
      }),
    ),
    abstained: z.number().int().nonnegative(),
  }).passthrough(),
  z.object({
    type: z.literal('run_completed'),
    dispatchedEvent: z.enum(['CHECKS_ACCEPTED', 'GAUNTLET_CLEAN']).nullable(),
  }).passthrough(),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);

async function responseJson(response: Response): Promise<unknown> {
  const data: unknown = await response.json();
  if (!response.ok) {
    const parsed = z
      .object({ error: z.object({ message: z.string() }) })
      .safeParse(data);
    throw new Error(parsed.success ? parsed.data.error.message : `Request failed (${response.status})`);
  }
  return data;
}

function parseLaneContract(reviewerType: ReviewerType, value: unknown): LaneContract {
  switch (reviewerType) {
    case 'ambiguity':
      return { kind: 'ambiguity', value: AmbiguitySchema.parse(value) };
    case 'discipline':
      return { kind: 'discipline', value: DisciplineSchema.parse(value) };
    case 'distractor':
      return { kind: 'distractor', value: DistractorMapSchema.parse(value) };
    case 'item_probe':
      return { kind: 'item_probe', value: ItemProbeSchema.parse(value) };
  }
}

const api = {
  async loadDemoChallenge(): Promise<SessionInfo> {
    const response = await fetch('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const parsed = SessionWireSchema.parse(await responseJson(response));
    if (parsed.demoItem === null) throw new Error('The demo database has not been seeded.');
    const expiresAt = Date.parse(parsed.expiresAt);
    return {
      pseudonym: parsed.pseudonym,
      ttlMinutes: Number.isFinite(expiresAt)
        ? Math.max(0, Math.round((expiresAt - Date.now()) / 60_000))
        : 0,
      item: {
        id: parsed.demoItem.itemId,
        versionNumber: parsed.demoItem.versionNumber,
        stem: parsed.demoItem.stem,
        options: parsed.demoItem.options,
        correctKey: parsed.demoItem.correctKey,
        authorRationale: parsed.demoItem.authorRationale,
      },
    };
  },

  async runGauntlet(
    itemId: string,
    onLane: (reviewerType: ReviewerType, patch: Partial<LaneState>) => void,
  ): Promise<GauntletResult> {
    const response = await fetch('/api/gauntlet', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemId }),
    });
    if (!response.ok) await responseJson(response);
    if (response.body === null) throw new Error('The gauntlet stream did not open.');

    let reviewerModel: string | null = null;
    let checks: AdjudicatedCheckView[] | null = null;
    let abstained = 0;
    let event: GauntletResult['event'] | null = null;
    let buffer = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    const consume = (line: string): void => {
      if (line.trim().length === 0) return;
      const parsed = GauntletEventSchema.parse(JSON.parse(line));
      if (parsed.type === 'run_started') {
        reviewerModel = parsed.reviewerModel;
        return;
      }
      if (parsed.type === 'reviewer_result') {
        const contract =
          parsed.ok && parsed.contract !== undefined
            ? parseLaneContract(parsed.reviewerType, parsed.contract)
            : null;
        onLane(parsed.reviewerType, {
          status: parsed.degraded ? 'degraded' : 'done',
          contract,
          latencyMs: parsed.latencyMs,
          schemaValid: parsed.schemaValid,
          model: reviewerModel,
          error: parsed.error ?? null,
        });
        return;
      }
      if (parsed.type === 'adjudication') {
        checks = parsed.checks.map((check, index) => ({
          id: `${check.reviewerType}-${index}`,
          reviewerType: check.reviewerType,
          checkClass: check.checkClass,
          status: check.status,
          contract: parseLaneContract(check.reviewerType, check.contract),
          ...(check.note === undefined ? {} : { note: check.note }),
        }));
        abstained = parsed.abstained;
        return;
      }
      if (parsed.type === 'run_completed') {
        event = parsed.dispatchedEvent;
        return;
      }
      throw new Error(parsed.message);
    };

    while (true) {
      const part = await reader.read();
      buffer += decoder.decode(part.value, { stream: !part.done });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) consume(line);
      if (part.done) break;
    }
    consume(buffer);

    if (checks === null || event === null) {
      throw new Error('The gauntlet ended without a complete adjudicated result.');
    }
    return { checks, abstained, adjudicatorModel: '', event };
  },

  async submitRepair(itemId: string, draft: ItemDraft): Promise<RepairResult> {
    const response = await fetch('/api/repair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemId, ...draft }),
    });
    return RepairWireSchema.parse(await responseJson(response)) as RepairResult;
  },

  async startDefense(itemId: string): Promise<DefenseQuestion[]> {
    const response = await fetch('/api/defense', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemId }),
    });
    return QuestionsWireSchema.parse(await responseJson(response)).questions;
  },

  async submitDefense(itemId: string, answers: string[]): Promise<DefenseResult> {
    const response = await fetch('/api/defense', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemId, answers }),
    });
    const parsed = ScoredWireSchema.parse(await responseJson(response));
    const events = {
      passed: 'DEFENSE_PASSED',
      failed: 'DEFENSE_FAILED',
      inconclusive: 'DEFENSE_EVALUATOR_FAILED',
    } as const;
    return { ...parsed, event: events[parsed.outcome] };
  },

  async loadPassport(itemId: string): Promise<Passport> {
    const response = await fetch(`/api/passport/${itemId}`);
    return PassportWireSchema.parse(await responseJson(response)) as Passport;
  },
};

// ---------------------------------------------------------------------------
// Copy tables. Record<ItemState, …> makes state coverage compile-checked:
// all eight lifecycle states must appear here.
// ---------------------------------------------------------------------------

const STATE_COPY: Record<ItemState, { note: string }> = {
  DRAFT: { note: 'Item is editable' },
  GAUNTLET: { note: 'Four lanes under review' },
  CHALLENGED: { note: 'A check was accepted' },
  REGRESSION: { note: 'History re-runs on the new version' },
  DEFENSE: { note: 'Two written questions' },
  DEFENSE_INCONCLUSIVE: { note: 'Evaluator failed — retry, never a reject' },
  PUBLISHED: { note: 'Passport frozen' },
  DISPUTED: { note: 'A published item is challenged again' },
};

const RAIL_STATES = [
  'DRAFT',
  'GAUNTLET',
  'CHALLENGED',
  'REGRESSION',
  'DEFENSE',
  'PUBLISHED',
] as const satisfies readonly ItemState[];

const BRANCH_STATES = ['DEFENSE_INCONCLUSIVE', 'DISPUTED'] as const satisfies readonly ItemState[];

const CLASS_PROMISE: Record<CheckClass, { title: string; promise: string }> = {
  deterministic: {
    title: 'Deterministic',
    promise: 'cannot regress',
  },
  counterexample: {
    title: 'Counterexample',
    promise: 're-executed; blocks while it holds',
  },
  semantic: {
    title: 'Semantic',
    promise: 're-adjudicated; never a guarantee',
  },
};

interface LaneSpec {
  reviewerType: ReviewerType;
  name: string;
  source: string;
  /** Plain-English job description shown on the card; the raw contract fields
   * appear only inside the expandable evidence view. */
  mission: string;
  rule: string;
}

const LANE_SPECS: LaneSpec[] = [
  {
    reviewerType: 'ambiguity',
    name: 'Ambiguity',
    source: 'AI reviewer',
    mission: 'Hunts for stems that can be honestly read in two different ways.',
    rule: 'A claim counts only when the two readings force two different answers.',
  },
  {
    reviewerType: 'discipline',
    name: 'Mathematics · probability',
    source: 'AI reviewer + exact solver',
    mission: 'Checks the mathematics itself: is the marked key actually right?',
    rule: 'A "correct" verdict requires a full citation — no sufficient source means unverified.',
  },
  {
    reviewerType: 'distractor',
    name: 'Distractors',
    source: 'AI reviewer',
    mission: 'Asks whether each wrong option captures a mistake a real student would make.',
    rule: 'A finding without evidence is labeled a hypothesis, never a defect.',
  },
  {
    reviewerType: 'item_probe',
    name: 'Cue probe',
    source: 'Deterministic · no AI',
    mission: 'Flags options that give the answer away by length or by word overlap with the stem.',
    rule: `Published thresholds: length ≥ ${LENGTH_HIGH} or ≤ ${LENGTH_LOW}, overlap ≥ ${OVERLAP_HIGH}.`,
  },
];

const DIMENSION_COPY: Record<RubricDimensionKey, string> = {
  identifies_error: 'Identifies the conceptual error the flagged distractor captures',
  explains_uniqueness: 'Explains why the correct alternative is unique',
  answers_variation: 'Answers a variation of the stem correctly',
};

const ROADMAP: string[] = [
  'Appeals',
  'Third-party attacks',
  'Reputation and credits',
  'Mutable commons',
  'Accounts',
  'Audio viva',
  'Multi-agent (measured eval variant only)',
  'Rankings',
  'bank_probe',
];

const OPTION_KEYS = ['A', 'B', 'C', 'D', 'E'];

/** The seven numbered surfaces of the assay sheet, in on-screen order. */
type SheetPanel =
  | 'item'
  | 'gauntlet'
  | 'counterexample'
  | 'repair'
  | 'rerun'
  | 'defense'
  | 'passport';

/** Where a surface sits relative to the visitor's current move. */
type SheetPhase = 'done' | 'now' | 'later';

const PHASE_LABEL: Record<SheetPhase, string> = {
  done: 'done',
  now: 'you are here',
  later: 'later',
};

// The single authorized guarantee rendering (doc §5) — never paraphrased.
const GUARANTEE_TEXT =
  'Every accepted check is re-run on each new version. The system guarantees ' +
  'execution of the history and non-regression of deterministic invariants; ' +
  'semantic judgments are re-adjudicated and remain visible in the passport.';

/** localStorage flag so the onboarding drawer opens only on the first visit. */
const ONBOARDING_SEEN_KEY = 'la-forja-onboarding-v1';

// ---------------------------------------------------------------------------
// Small pure helpers (presentation only)
// ---------------------------------------------------------------------------

function emptyLane(): LaneState {
  return {
    status: 'idle',
    contract: null,
    latencyMs: null,
    schemaValid: null,
    promptVersion: null,
    model: null,
    error: null,
  };
}

function emptyLaneMap(): LaneMap {
  return {
    ambiguity: emptyLane(),
    discipline: emptyLane(),
    distractor: emptyLane(),
    item_probe: emptyLane(),
  };
}

function optionKey(index: number): string {
  return OPTION_KEYS[index] ?? String(index + 1);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type DiffKind = 'same' | 'add' | 'del';
interface DiffOp {
  kind: DiffKind;
  text: string;
}

function tokenize(value: string): string[] {
  return value.split(/(\s+)/).filter((token) => token.length > 0);
}

/** Word-level diff (LCS). Presentation only — the recorded diff comes from the API. */
function tokenDiff(before: string, after: string): DiffOp[] {
  const a = tokenize(before);
  const b = tokenize(after);
  const n = a.length;
  const m = b.length;

  const lcs: number[][] = [];
  for (let i = 0; i <= n; i += 1) lcs.push(new Array<number>(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i -= 1) {
    const row = lcs[i];
    const next = lcs[i + 1];
    if (!row || !next) continue;
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const left = a[i];
    const right = b[j];
    if (left === undefined || right === undefined) break;
    if (left === right) {
      ops.push({ kind: 'same', text: left });
      i += 1;
      j += 1;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      ops.push({ kind: 'del', text: left });
      i += 1;
    } else {
      ops.push({ kind: 'add', text: right });
      j += 1;
    }
  }
  while (i < n) {
    const left = a[i];
    if (left !== undefined) ops.push({ kind: 'del', text: left });
    i += 1;
  }
  while (j < m) {
    const right = b[j];
    if (right !== undefined) ops.push({ kind: 'add', text: right });
    j += 1;
  }
  return ops;
}

function draftOf(item: StudioItem): ItemDraft {
  return {
    stem: item.stem,
    options: [...item.options],
    correctKey: item.correctKey,
    authorRationale: item.authorRationale,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function StudioClient({
  reviewerModel,
  adjudicatorModel,
  modelCompliant,
  modelCallsAvailable,
  demoFixture,
}: StudioClientProps) {
  const [state, setState] = useState<ItemState>('DRAFT');
  const stateRef = useRef<ItemState>('DRAFT');
  const [trail, setTrail] = useState<TrailStep[]>([]);
  const [reachedBranches, setReachedBranches] = useState<ItemState[]>([]);

  const [session, setSession] = useState<SessionInfo | null>(null);
  const [item, setItem] = useState<StudioItem | null>(null);
  const [previousVersion, setPreviousVersion] = useState<StudioItem | null>(null);
  const [draft, setDraft] = useState<ItemDraft | null>(null);

  const [lanes, setLanes] = useState<LaneMap>(emptyLaneMap);
  const [checks, setChecks] = useState<AdjudicatedCheckView[]>([]);
  const [abstained, setAbstained] = useState<number>(0);
  // Grouped by class exactly as /api/repair returns it: every class key present.
  const [reRunByClass, setReRunByClass] = useState<Record<CheckClass, ReRunOutcome[]> | null>(null);

  const [questions, setQuestions] = useState<DefenseQuestion[]>([]);
  // Positional, to match the route's `z.array(z.string().min(1)).length(2)`.
  const [answers, setAnswers] = useState<string[]>([]);
  const [rubric, setRubric] = useState<DefenseRubric | null>(null);
  const [passport, setPassport] = useState<Passport | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [timeToCounterexampleMs, setTimeToCounterexampleMs] = useState<number | null>(null);
  const gauntletStartedRef = useRef<number | null>(null);
  const counterexampleRef = useRef<HTMLElement | null>(null);

  // First-visit onboarding. Presentation state only: a dismissed drawer is
  // remembered in localStorage — a UI flag, never data about the visitor.
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  useEffect(() => {
    try {
      if (window.localStorage.getItem(ONBOARDING_SEEN_KEY) === null) {
        setOnboardingOpen(true);
      }
    } catch {
      // Storage unavailable (private mode): skip the drawer rather than error.
    }
  }, []);
  const dismissOnboarding = useCallback((open: boolean) => {
    setOnboardingOpen(open);
    if (!open) {
      try {
        window.localStorage.setItem(ONBOARDING_SEEN_KEY, 'seen');
      } catch {
        // Best effort only.
      }
    }
  }, []);

  // -- state machine bridge -------------------------------------------------
  // The UI never decides a transition; it asks the Codex-owned reducer.
  const applyEvent = useCallback((event: StateEvent): ItemState | null => {
    try {
      const from = stateRef.current;
      const to = reduce(from, event);
      stateRef.current = to;
      setState(to);
      setTrail((prev) => [...prev, { from, event, to }]);
      if (to === 'DEFENSE_INCONCLUSIVE' || to === 'DISPUTED') {
        setReachedBranches((prev) => (prev.includes(to) ? prev : [...prev, to]));
      }
      return to;
    } catch (err) {
      setNotice({
        tone: 'warn',
        label: 'Transition',
        text: `The state machine rejected ${event} from ${stateRef.current}: ${errorText(err)}`,
      });
      return null;
    }
  }, []);

  const patchLane = useCallback((reviewerType: ReviewerType, patch: Partial<LaneState>) => {
    setLanes((prev) => {
      const next: LaneMap = { ...prev };
      next[reviewerType] = { ...prev[reviewerType], ...patch };
      return next;
    });
  }, []);

  // -- handlers -------------------------------------------------------------

  const handleLoadDemo = useCallback(async () => {
    setBusy('load');
    setNotice(null);
    try {
      const info = await api.loadDemoChallenge();
      const loadedItem: StudioItem = {
        ...info.item,
        ...(info.item.stem === demoFixture.stem && demoFixture.stemSplit
          ? { stemSplit: demoFixture.stemSplit }
          : {}),
      };
      setSession({ ...info, item: loadedItem });
      setItem(loadedItem);
      setDraft(draftOf(loadedItem));
      toast.success('Demo challenge loaded', {
        description: `Signed in as ${info.pseudonym}. Version 1 is on the sheet — find the defect.`,
      });
    } catch (err) {
      // Keep the sheet inspectable if local persistence has not been seeded,
      // while explicitly marking the fallback as unrecorded.
      setItem(demoFixture);
      setDraft(draftOf(demoFixture));
      setNotice({
        tone: 'warn',
        label: 'Local fixture',
        text: `The isolated session could not be created, so this unrecorded local fixture is shown instead: ${errorText(err)}.`,
      });
    } finally {
      setBusy(null);
    }
  }, [demoFixture]);

  const handleSubmitToGauntlet = useCallback(async () => {
    if (!item || !draft || !modelCallsAvailable) return;
    setBusy('gauntlet');
    setNotice(null);
    setChecks([]);
    setTimeToCounterexampleMs(null);
    gauntletStartedRef.current =
      typeof performance !== 'undefined' ? performance.now() : Date.now();

    const running: LaneMap = emptyLaneMap();
    for (const spec of LANE_SPECS) {
      running[spec.reviewerType] = { ...emptyLane(), status: 'running' };
    }
    setLanes(running);

    if (!applyEvent('SUBMIT_TO_GAUNTLET')) {
      setBusy(null);
      return;
    }

    try {
      const result = await api.runGauntlet(item.id, patchLane);
      setChecks(result.checks);
      setAbstained(result.abstained);

      const hasCounterexample = result.checks.some(
        (check) => check.status === 'accepted' && check.checkClass === 'counterexample',
      );
      const startedAt = gauntletStartedRef.current;
      if (hasCounterexample && startedAt !== null) {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const elapsed = Math.round(now - startedAt);
        setTimeToCounterexampleMs(elapsed);
        toast.warning('Counterexample accepted', {
          description: `First useful counterexample in ${(elapsed / 1000).toFixed(1)}s. The item is now CHALLENGED.`,
        });
      }

      applyEvent(result.event);
    } catch (err) {
      // A whole-run failure degrades the lanes; the page keeps working.
      setLanes((prev) => {
        const next: LaneMap = { ...prev };
        for (const spec of LANE_SPECS) {
          const lane = next[spec.reviewerType];
          if (lane.status === 'running') {
            next[spec.reviewerType] = { ...lane, status: 'degraded', error: errorText(err) };
          }
        }
        return next;
      });
      setNotice({
        tone: 'warn',
        label: 'Gauntlet',
        text: `The gauntlet did not return findings: ${errorText(err)}`,
      });
    } finally {
      setBusy(null);
    }
  }, [applyEvent, draft, item, modelCallsAvailable, patchLane]);

  const handleSubmitRepair = useCallback(async () => {
    if (!item || !draft) return;
    setBusy('repair');
    setNotice(null);
    try {
      // ONE request: /api/repair creates the new version AND re-runs the full
      // check history. There is no second call — a separate re-run endpoint
      // would execute the history twice and duplicate its recorded rows.
      const repair = await api.submitRepair(item.id, draft);
      const repaired: StudioItem = { ...draft, id: repair.itemId, versionNumber: repair.versionNumber };
      setPreviousVersion(item);
      setItem(repaired);
      setReRunByClass(repair.reRun.byClass);

      // Both transitions are applied back to back with NO await between them:
      // the re-run payload already arrived with the repair response, so there is
      // no window in which the item can be left stuck in REGRESSION.
      if (!applyEvent('SUBMIT_REPAIR')) return;
      applyEvent(repair.reRun.blocksPublish ? 'HISTORY_REGRESSED' : 'HISTORY_CLEAN');
      if (repair.reRun.blocksPublish) {
        toast.warning(`Version ${repair.versionNumber} recorded — a check still holds`, {
          description: 'The re-run found a regression, so publication stays blocked.',
        });
      } else {
        toast.success(`Version ${repair.versionNumber} recorded — history clean`, {
          description: `${repair.reRun.total} check(s) re-ran against the new version. The defense is open.`,
        });
      }
    } catch (err) {
      setNotice({
        tone: 'warn',
        label: 'Repair',
        text: `The repair did not complete: ${errorText(err)}`,
      });
    } finally {
      setBusy(null);
    }
  }, [applyEvent, draft, item]);

  const handleStartDefense = useCallback(async () => {
    if (!item || !modelCallsAvailable) return;
    setBusy('defense-questions');
    setNotice(null);
    try {
      const next = await api.startDefense(item.id);
      setQuestions(next);
      setAnswers(next.map(() => ''));
      setRubric(null);
    } catch (err) {
      setNotice({
        tone: 'warn',
        label: 'Defense',
        text: `The defense questions did not arrive: ${errorText(err)}`,
      });
    } finally {
      setBusy(null);
    }
  }, [item, modelCallsAvailable]);

  const handleSubmitDefense = useCallback(async () => {
    if (!item) return;
    setBusy('defense-score');
    setNotice(null);
    try {
      // Positional array, ordered to match `questions`.
      const result = await api.submitDefense(item.id, answers);
      // null on an evaluator failure; the rubric card renders its empty state.
      setRubric(result.rubric);
      const next = applyEvent(result.event);
      if (result.outcome === 'passed') {
        toast.success('Defense passed', {
          description: 'The rubric threshold is met. Publishing with a passport.',
        });
      } else if (result.outcome === 'failed') {
        toast.warning('Defense not passed', {
          description: 'The item returns to CHALLENGED. Read the rubric evidence and try again.',
        });
      } else {
        toast.info('Evaluator failed — no verdict recorded', {
          description: 'Inconclusive is a retry, never an automatic reject.',
        });
      }
      if (next === 'PUBLISHED') {
        const built = await api.loadPassport(item.id);
        setPassport(built);
      }
    } catch (err) {
      setNotice({
        tone: 'warn',
        label: 'Defense',
        text: `The defense was not scored: ${errorText(err)}`,
      });
    } finally {
      setBusy(null);
    }
  }, [answers, applyEvent, item]);

  const handleRetryDefense = useCallback(() => {
    applyEvent('DEFENSE_RETRY');
  }, [applyEvent]);

  // -- derived --------------------------------------------------------------

  const railIndex = useMemo(() => {
    const direct = RAIL_STATES.indexOf(state as (typeof RAIL_STATES)[number]);
    if (direct >= 0) return direct;
    if (state === 'DEFENSE_INCONCLUSIVE') return RAIL_STATES.indexOf('DEFENSE');
    return RAIL_STATES.indexOf('PUBLISHED');
  }, [state]);

  const acceptedChecks = useMemo(
    () => checks.filter((check) => check.status === 'accepted'),
    [checks],
  );

  const counterexample = useMemo(() => {
    for (const check of acceptedChecks) {
      if (check.contract.kind === 'ambiguity') {
        return { check, contract: check.contract.value };
      }
    }
    return null;
  }, [acceptedChecks]);

  const defensibleKeys = useMemo(() => {
    if (counterexample === null || draft === null) return new Set<string>();
    const answers = [counterexample.contract.answer_a, counterexample.contract.answer_b];
    return new Set(
      draft.options.flatMap((option, index) =>
        answers.some((answer) => answer.trim() === option.trim()) ? [optionKey(index)] : [],
      ),
    );
  }, [counterexample, draft]);

  useEffect(() => {
    if (counterexample === null || counterexampleRef.current === null) return;
    const frame = requestAnimationFrame(() => {
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      counterexampleRef.current?.scrollIntoView({
        behavior: reduced ? 'auto' : 'smooth',
        block: 'start',
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [counterexample]);

  // The route requires exactly 2 non-empty answers
  // (`z.array(z.string().min(1)).length(2)`), so an incomplete defense is
  // blocked here instead of being sent to a guaranteed 400.
  const answersComplete = useMemo(
    () =>
      questions.length > 0 &&
      answers.length === questions.length &&
      answers.every((answer) => answer.trim().length > 0),
    [answers, questions.length],
  );

  const formEditable = state === 'DRAFT' && item !== null;
  // CHALLENGED only. DISPUTED is deliberately excluded: post-publication disputes
  // are outside the winning slice, so no control on this page may open the
  // NEW_DISPUTE / DISPUTE_REPAIR path (src/core/types.ts SCOPE NOTE).
  const repairEditable = state === 'CHALLENGED' && item !== null;

  // -- step guidance ---------------------------------------------------------
  // Purely derived presentation state: which surface is the current move, which
  // are settled, which come later. No transition is decided here — the phases
  // are read off the recorded state exactly as the reducer left it.

  const panelPhase = useMemo<Record<SheetPanel, SheetPhase>>(() => {
    return {
      item: state === 'DRAFT' ? 'now' : 'done',
      gauntlet: state === 'GAUNTLET' ? 'now' : state === 'DRAFT' ? 'later' : 'done',
      counterexample:
        counterexample === null
          ? acceptedChecks.length > 0
            ? 'done'
            : 'later'
          : state === 'CHALLENGED'
            ? 'now'
            : 'done',
      repair: state === 'CHALLENGED' ? 'now' : previousVersion !== null ? 'done' : 'later',
      rerun: state === 'REGRESSION' ? 'now' : reRunByClass !== null ? 'done' : 'later',
      defense:
        state === 'DEFENSE' || state === 'DEFENSE_INCONCLUSIVE'
          ? 'now'
          : state === 'PUBLISHED'
            ? 'done'
            : 'later',
      passport: state === 'PUBLISHED' ? 'now' : 'later',
    };
  }, [state, counterexample, acceptedChecks.length, previousVersion, reRunByClass]);

  const scrollToPanel = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  }, []);

  interface NextMove {
    step: string;
    text: string;
    action: { kind: 'load' | 'gauntlet' | 'retry' | 'goto'; label: string; target?: string } | null;
    note?: string;
  }

  const nextMove = useMemo<NextMove>(() => {
    if (!item) {
      return {
        step: 'start here',
        text: 'Load the demo challenge — a broken problem is your starting point.',
        action: { kind: 'load', label: 'Load demo challenge' },
      };
    }
    switch (state) {
      case 'DRAFT':
        return {
          step: 'step 01',
          text: 'Read the item and hunt for the defect, then send it into review.',
          action: { kind: 'gauntlet', label: 'Run the gauntlet' },
          ...(modelCallsAvailable ? {} : { note: 'next · needs a server API key' }),
        };
      case 'GAUNTLET':
        return { step: 'step 02', text: 'The reviewers are examining your item…', action: null };
      case 'CHALLENGED':
        return {
          step: 'steps 03–04',
          text: 'A counterexample was accepted. Read it, then repair the stem.',
          action: { kind: 'goto', target: 'repair', label: 'Go to the repair' },
        };
      case 'REGRESSION':
        return {
          step: 'step 05',
          text: 'The full check history is re-running against your new version…',
          action: null,
        };
      case 'DEFENSE':
        return {
          step: 'step 06',
          text: 'The history is clean. Now defend your repair in writing.',
          action: { kind: 'goto', target: 'defense', label: 'Go to the defense' },
        };
      case 'DEFENSE_INCONCLUSIVE':
        return {
          step: 'step 06',
          text: 'The evaluator failed — no verdict was recorded. Retry when ready.',
          action: { kind: 'retry', label: 'Retry the defense' },
        };
      case 'PUBLISHED':
        return {
          step: 'step 07',
          text: 'Published. The passport is the auditable record of the whole fight.',
          action: { kind: 'goto', target: 'passport', label: 'Read the passport' },
        };
      default:
        return { step: 'state', text: STATE_COPY[state].note, action: null };
    }
  }, [item, state, modelCallsAvailable]);

  const runNextMove = useCallback(() => {
    const action = nextMove.action;
    if (!action) return;
    if (action.kind === 'load') void handleLoadDemo();
    else if (action.kind === 'gauntlet') void handleSubmitToGauntlet();
    else if (action.kind === 'retry') handleRetryDefense();
    else if (action.target) scrollToPanel(action.target);
  }, [nextMove, handleLoadDemo, handleSubmitToGauntlet, handleRetryDefense, scrollToPanel]);

  const workingDiff = useMemo(() => {
    if (!item || !draft) return [];
    return tokenDiff(item.stem, draft.stem);
  }, [draft, item]);

  const recordedDiff = useMemo(() => {
    if (!previousVersion || !item) return [];
    return tokenDiff(previousVersion.stem, item.stem);
  }, [item, previousVersion]);

  const updateDraft = useCallback((patch: Partial<ItemDraft>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const setDraftOption = useCallback((index: number, value: string) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const options = [...prev.options];
      options[index] = value;
      return { ...prev, options };
    });
  }, []);

  // -----------------------------------------------------------------------

  return (
    <main className="shell">
      <OnboardingDrawer
        open={onboardingOpen}
        onOpenChange={dismissOnboarding}
        onStart={() => {
          dismissOnboarding(false);
          if (item === null && busy === null) void handleLoadDemo();
        }}
        demoLoaded={item !== null}
        modelCallsAvailable={modelCallsAvailable}
      />

      <header className="masthead">
        <div className="masthead__claim">
          <Link className="masthead__home" href="/">
            <h1 className="wordmark">LA FORJA</h1>
          </Link>
          <p className="tagline">
            Getting the right answer is not enough. Forge it, attack it, defend it.
          </p>
          <p className="masthead__descriptor">
            An adversarial learning studio for high-school and college mathematics.
          </p>
        </div>
        <div className="masthead__meta">
          <div className="meta-row"><span>reviewer model</span><b>{reviewerModel}</b></div>
          <div className="meta-row"><span>adjudicator model</span><b>{adjudicatorModel}</b></div>
          <div className="meta-row"><span>session</span><b>{session?.pseudonym ?? 'UNASSIGNED'}</b></div>
          <div className="meta-row"><span>privacy</span><b>ZERO PII</b></div>
          <div className="meta-row">
            <span>model calls</span>
            <b>{modelCallsAvailable && modelCompliant ? 'AVAILABLE' : 'NEXT · NOT CONFIGURED'}</b>
          </div>
          {timeToCounterexampleMs !== null ? (
            <div className="meta-row">
              <span>time to first counterexample</span>
              <b>{(timeToCounterexampleMs / 1000).toFixed(1)}s</b>
            </div>
          ) : null}
        </div>
      </header>

      {/* ---------------------------------------------------------------- rail */}
      <section className="rail-block" aria-label="Item lifecycle">
        <div className="rail-scroll">
          <ol className="rail">
            {RAIL_STATES.map((railState, index) => {
              const phase =
                index < railIndex ? 'past' : index === railIndex ? 'current' : 'future';
              return (
                <li
                  key={railState}
                  className="rail__node"
                  data-phase={phase}
                  aria-current={phase === 'current' ? 'step' : undefined}
                >
                  <span className="rail__notch" aria-hidden="true">
                    {phase === 'past' ? '✱' : ''}
                  </span>
                  <span className="rail__label">{railState}</span>
                  <span className="rail__note">{STATE_COPY[railState].note}</span>
                </li>
              );
            })}
          </ol>
        </div>

        <div className="branches">
          <span className="branches__caption">Exceptions</span>
          {BRANCH_STATES.map((branch) => (
            <span
              key={branch}
              className="branch"
              data-reached={reachedBranches.includes(branch) ? 'true' : 'false'}
              data-current={state === branch ? 'true' : 'false'}
              aria-disabled={branch === 'DISPUTED' ? 'true' : undefined}
              tabIndex={branch === 'DISPUTED' ? -1 : undefined}
            >
              {branch}
              <span className="muted">· {STATE_COPY[branch].note}</span>
              {branch === 'DISPUTED' ? (
                <span className="tag tag--next" aria-disabled="true">next</span>
              ) : null}
            </span>
          ))}
        </div>

        {trail.length > 0 ? (
          <ol className="trail">
            {trail.map((step, index) => (
              <li key={`${step.event}-${index}`} className="trail__step">
                {step.from} <em>--{step.event}--&gt;</em> {step.to}
              </li>
            ))}
          </ol>
        ) : null}
      </section>

      {notice ? (
        <div className={notice.tone === 'warn' ? 'notice notice--warn' : 'notice'} role="status">
          <span className="notice__label">{notice.label}</span>
          <span>{notice.text}</span>
        </div>
      ) : null}

      {/* ---------------------------------------------------------- onboarding */}
      <section className="onboard">
        <div className="onboard__primary">
          <h2 className="onboard__title">Start with a broken item</h2>
          <p className="onboard__copy">
            {item
              ? 'The challenge is loaded. Everything below is one long worksheet — the assay sheet — that follows your item through its seven numbered steps: review, counterexample, repair, re-run, defense and the final passport. The bar at the bottom of the screen always tells you your next move.'
              : 'Load the team-authored probability challenge — a real multiple-choice problem with one deliberate defect hidden in it, and no personal data. Your job across this page: find the flaw, survive the review, repair it and defend it.'}
          </p>
          <div className="onboard__actions">
            <button
              type="button"
              className="btn btn--forge btn--lg"
              onClick={() => void handleLoadDemo()}
              disabled={busy !== null || item !== null}
            >
              {busy === 'load' ? 'Loading…' : 'Load demo challenge'}
            </button>
            <button
              type="button"
              className="btn btn--quiet"
              onClick={() => setOnboardingOpen(true)}
            >
              Replay the intro
            </button>
            <span className="btn-note">Team-authored original · CC-BY · probability</span>
          </div>
        </div>

        <div className="onboard__secondary" aria-disabled="true">
          <h3 className="onboard__locked-title">Author your own item</h3>
          <p className="lane__rule" style={{ marginTop: 'var(--s3)' }}>
            Repair first. Creating an item from scratch stays locked while you work through
            the demo cycle.
          </p>
          <div className="onboard__actions">
            <button type="button" className="btn btn--locked" disabled aria-disabled="true" tabIndex={-1}>
              Author your own item
            </button>
            <span className="tag tag--next">next</span>
          </div>
          <p className="btn-note" style={{ marginTop: 'var(--s3)' }}>
            {state === 'PUBLISHED'
              ? 'Demo cycle complete. Authoring from scratch is next.'
              : 'Unlocks after the demo cycle reaches PUBLISHED.'}
          </p>
        </div>
      </section>

      {item && draft ? (
        <>
          {/* ------------------------------------------------ 01 item + form */}
          <section className="panel" id="item" data-step={panelPhase.item}>
            <div className="panel__head">
              <span className="panel__step">01</span>
              <h2 className="panel__title">The item</h2>
              <span className="panel__aside">
                <span className="panel__phase" data-phase={panelPhase.item}>
                  {PHASE_LABEL[panelPhase.item]}
                </span>
                <span className="station">BILLET</span>
                v{item.versionNumber} · {formEditable ? 'editable' : 'read only'}
              </span>
            </div>
            <p className="panel__lede">
              This is the problem on trial: its question (the stem), four options, the
              key the author marked as correct, and the author&rsquo;s reasoning. Somewhere
              in here hides a defect — read it closely, edit anything while it is a
              draft, then send it into review below.
            </p>

            <div className="panel__body form-grid">
              <div>
                <label className="field">
                  <span className="field__label">
                    <span>Stem</span>
                    <span>untrusted input · delimited in every prompt</span>
                  </span>
                  <textarea
                    className="textarea"
                    value={draft.stem}
                    disabled={!formEditable}
                    onChange={(event) => updateDraft({ stem: event.target.value })}
                  />
                </label>

                <div className="field">
                  <span className="field__label">
                    <span>Options</span>
                    <span>select the key you defend</span>
                  </span>
                  <div className="options">
                    {draft.options.map((option, index) => {
                      const key = optionKey(index);
                      return (
                        <div
                          className="option"
                          key={key}
                          data-correct={draft.correctKey === key ? 'true' : 'false'}
                          data-defensible={defensibleKeys.has(key) ? 'true' : 'false'}
                        >
                          <input
                            type="radio"
                            name="correctKey"
                            value={key}
                            checked={draft.correctKey === key}
                            disabled={!formEditable && !repairEditable}
                            onChange={() => updateDraft({ correctKey: key })}
                            aria-label={`Mark option ${key} as the correct answer`}
                          />
                          <span className="option__key">{key}</span>
                          <input
                            className="input"
                            value={option}
                            disabled={!formEditable && !repairEditable}
                            onChange={(event) => setDraftOption(index, event.target.value)}
                            aria-label={`Option ${key}`}
                          />
                          {draft.correctKey === key ? <span className="option__tag">KEY</span> : null}
                          {defensibleKeys.has(key) ? (
                            <span className="option__note">defensible under a reading</span>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div>
                <label className="field">
                  <span className="field__label">
                    <span>Author rationale</span>
                    <span>why this key, why these distractors</span>
                  </span>
                  <textarea
                    className="textarea"
                    style={{ minHeight: '220px' }}
                    value={draft.authorRationale}
                    disabled={!formEditable}
                    onChange={(event) => updateDraft({ authorRationale: event.target.value })}
                  />
                </label>
                <p className="privacy-note">
                  The item is the only thing this studio stores. There is no name, email,
                  school, city or age field anywhere in the schema.
                </p>
              </div>
            </div>

            <div className="form-footer">
              <button
                type="button"
                className="btn btn--forge"
                onClick={() => void handleSubmitToGauntlet()}
                disabled={busy !== null || state !== 'DRAFT' || !modelCallsAvailable}
                aria-disabled={!modelCallsAvailable}
                tabIndex={!modelCallsAvailable ? -1 : undefined}
              >
                {busy === 'gauntlet' ? 'Running the gauntlet…' : 'Run the gauntlet'}
              </button>
              <span className="btn-note">
                {modelCallsAvailable
                  ? 'Three concurrent reviewers and one deterministic probe.'
                  : 'next · model transport requires a server API key'}
              </span>
            </div>
          </section>

          {/* ---------------------------------------------------- 02 gauntlet */}
          <section className="panel" id="gauntlet" data-step={panelPhase.gauntlet}>
            <div className="panel__head">
              <span className="panel__step">02</span>
              <h2 className="panel__title">The gauntlet</h2>
              <span className="panel__aside">
                <span className="panel__phase" data-phase={panelPhase.gauntlet}>
                  {PHASE_LABEL[panelPhase.gauntlet]}
                </span>
                <span className="station">HEAT</span>
                {abstained > 0 ? `${abstained} abstained` : 'four independent lanes'}
              </span>
            </div>
            <p className="panel__lede">
              The review stage: four independent examiners attack your item at the same
              time — three AI reviewers and one fixed calculation that needs no AI. Each
              must attach evidence to anything it claims; each card below shows what its
              examiner hunts for and settles on its own as results arrive.
            </p>

            <div className="panel__body lanes">
              {LANE_SPECS.map((spec) => (
                <LanePanel
                  key={spec.reviewerType}
                  spec={spec}
                  lane={lanes[spec.reviewerType]}
                  available={modelCallsAvailable || spec.reviewerType === 'item_probe'}
                />
              ))}
            </div>
          </section>

          {/* -------------------------------------------- 03 counterexample */}
          <section
            className="panel panel--fracture"
            id="counterexample"
            ref={counterexampleRef}
            data-populated={counterexample ? 'true' : 'false'}
            data-step={panelPhase.counterexample}
          >
            <div className="panel__head">
              <span className="panel__step">03</span>
              <h2 className="panel__title">Accepted counterexample</h2>
              <span className="panel__aside">
                <span className="panel__phase" data-phase={panelPhase.counterexample}>
                  {PHASE_LABEL[panelPhase.counterexample]}
                </span>
                <span className="station">FRACTURE</span>
                separate adjudication
              </span>
            </div>
            <p className="panel__lede">
              The strongest kind of finding a reviewer can land: not an opinion but a
              demonstration that the item is broken — two honest readings of your stem
              that lead to two different answers, shown so you can re-execute them
              yourself. When one is accepted here, the item is officially challenged and
              the repair below unlocks.
            </p>

            <div className="panel__body">
              {counterexample ? (
                <CounterexampleCard
                  contract={counterexample.contract}
                  checkClass={counterexample.check.checkClass}
                  stem={item.stem}
                  stemSplit={item.stemSplit}
                  note={counterexample.check.note}
                />
              ) : (
                <div className="pending-surface" aria-disabled="true">
                  <p className="lane__empty">
                    Empty for now — a counterexample appears here only if a reviewer proves
                    one and the adjudication step accepts it.
                  </p>
                </div>
              )}

              {acceptedChecks.length > 0 ? (
                <ul className="classes" style={{ marginTop: 'var(--s5)' }}>
                  {acceptedChecks.map((check) => (
                    <li key={check.id} className="class-group" data-class={check.checkClass}>
                      <div className="row">
                        <span className={`tag tag--${check.checkClass}`}>{check.checkClass}</span>
                        <span className="lane__source">{check.reviewerType}</span>
                      </div>
                      <p className="class-group__promise">{CLASS_PROMISE[check.checkClass].promise}</p>
                      {check.note ? <p className="rerun__detail">{check.note}</p> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </section>

          {/* ------------------------------------------------------ 04 repair */}
          <section className="panel" id="repair" data-step={panelPhase.repair}>
            <div className="panel__head">
              <span className="panel__step">04</span>
              <h2 className="panel__title">Repair</h2>
              <span className="panel__aside">
                <span className="panel__phase" data-phase={panelPhase.repair}>
                  {PHASE_LABEL[panelPhase.repair]}
                </span>
                <span className="station">HAMMER</span>
                {previousVersion
                  ? `v${previousVersion.versionNumber} → v${item.versionNumber}`
                  : `v${item.versionNumber} → v${item.versionNumber + 1}`}
              </span>
            </div>
            <p className="panel__lede">
              Your move: rewrite the stem so only one reading survives. Submitting never
              overwrites version 1 — it creates version 2 and immediately re-runs every
              recorded check against it. The diff below shows exactly what you changed.
            </p>

            <div className="panel__body">
              <label className="field">
                <span className="field__label">
                  <span>Repaired stem</span>
                  <span>{repairEditable ? 'editable' : 'unlocks when a check is accepted'}</span>
                </span>
                <textarea
                  className="textarea"
                  value={draft.stem}
                  disabled={!repairEditable}
                  onChange={(event) => updateDraft({ stem: event.target.value })}
                />
              </label>

              <div style={{ marginTop: 'var(--s5)' }}>
                <div className="row">
                  <span className="version-chip">
                    {previousVersion
                      ? `recorded diff · v${previousVersion.versionNumber} → v${item.versionNumber}`
                      : `working diff · v${item.versionNumber} → draft`}
                  </span>
                </div>
                <div className="diff" style={{ marginTop: 'var(--s3)' }}>
                  <DiffView ops={previousVersion ? recordedDiff : workingDiff} />
                </div>
                <div className="diff__legend">
                  <span>
                    <span className="diff__del">removed</span>
                  </span>
                  <span>
                    <span className="diff__add">added</span>
                  </span>
                </div>
              </div>

              <div className="form-footer">
                <button
                  type="button"
                  className="btn btn--forge"
                  onClick={() => void handleSubmitRepair()}
                  disabled={busy !== null || !repairEditable}
                >
                  {busy === 'repair' ? 'Recording the new version…' : 'Submit repair'}
                </button>
                <span className="btn-note">
                  One request will create the new version and re-run the full recorded history.
                </span>
              </div>
            </div>
          </section>

          {/* ------------------------------------------------- 05 history re-run */}
          <section className="panel" id="rerun" data-step={panelPhase.rerun}>
            <div className="panel__head">
              <span className="panel__step">05</span>
              <h2 className="panel__title">History re-run</h2>
              <span className="panel__aside">
                <span className="panel__phase" data-phase={panelPhase.rerun}>
                  {PHASE_LABEL[panelPhase.rerun]}
                </span>
                <span className="station">QUENCH</span>
                grouped by check class
              </span>
            </div>
            <p className="panel__lede">
              Did your fix hold? Every check the item ever faced runs again on the new
              version, grouped by the promise each class keeps.
            </p>
            <p className="guarantee">{GUARANTEE_TEXT}</p>

            <div className="panel__body classes">
              {(Object.keys(CLASS_PROMISE) as CheckClass[]).map((checkClass) => {
                const outcomes = reRunByClass?.[checkClass] ?? [];
                const copy = CLASS_PROMISE[checkClass];
                return (
                  <div className="class-group" data-class={checkClass} key={checkClass}>
                    <div className="row">
                      <span className={`tag tag--${checkClass}`}>{checkClass}</span>
                      <span className="lane__source">{outcomes.length} check(s)</span>
                    </div>
                    <h3 className="lane__name" style={{ marginTop: 'var(--s3)' }}>
                      {copy.title}
                    </h3>
                    <p className="class-group__promise">{copy.promise}</p>
                    <div className="class-group__list">
                      {outcomes.length === 0 ? (
                        <p className="lane__empty">
                          No result is recorded in this class for the current version.
                        </p>
                      ) : (
                        outcomes.map((outcome) => (
                          <div className="rerun" key={outcome.originalCheckId}>
                            <div className="rerun__top">
                              <span>{outcome.originalCheckId}</span>
                              <span className={`rerun__result rerun__result--${outcome.result}`}>
                                {outcome.checkClass === 'counterexample' && outcome.result === 'regressed'
                                  ? 'STILL HOLDS · BLOCKS PUBLICATION'
                                  : outcome.result}
                              </span>
                            </div>
                            {outcome.detail ? (
                              <p className="rerun__detail">{outcome.detail}</p>
                            ) : null}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* ----------------------------------------------------- 06 defense */}
          <section className="panel" id="defense" data-step={panelPhase.defense}>
            <div className="panel__head">
              <span className="panel__step">06</span>
              <h2 className="panel__title">Written defense</h2>
              <span className="panel__aside">
                <span className="panel__phase" data-phase={panelPhase.defense}>
                  {PHASE_LABEL[panelPhase.defense]}
                </span>
                <span className="station">PROOF</span>
                2 questions · 3 dimensions
              </span>
            </div>
            <p className="panel__lede">
              Fixing it is not enough — you also show you understand why it was broken.
              Two short written questions, scored against the three-part rubric on the
              right; every score comes with the quoted evidence it was based on. If the
              evaluator itself fails, the result is inconclusive — a retry, never an
              automatic reject. Question generation and scoring need the server API key.
            </p>

            <div className="panel__body viva">
              <div>
                {state === 'DEFENSE_INCONCLUSIVE' ? (
                  <div className="defense-exception" role="status">
                    <b>EVALUATOR FAILED — NO VERDICT RECORDED</b>
                    <button type="button" className="btn" onClick={handleRetryDefense}>
                      Retry
                    </button>
                  </div>
                ) : null}
                {questions.length === 0 ? (
                  <div className="card">
                    <p className="lane__empty">
                      No questions. The defense opens after a clean history re-run; generating
                      the two questions is next.
                    </p>
                    <div className="form-footer">
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void handleStartDefense()}
                        disabled={busy !== null || state !== 'DEFENSE' || !modelCallsAvailable}
                        aria-disabled={!modelCallsAvailable}
                        tabIndex={!modelCallsAvailable ? -1 : undefined}
                      >
                        {busy === 'defense-questions' ? 'Preparing…' : 'Open the defense'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {questions.map((question, index) => (
                      <div className="question" key={question.id}>
                        <p className="question__index">Question {index + 1} of 2</p>
                        <p className="question__prompt">{question.prompt}</p>
                        <textarea
                          className="textarea"
                          value={answers[index] ?? ''}
                          disabled={state !== 'DEFENSE'}
                          placeholder="Write your answer"
                          onChange={(event) =>
                            setAnswers((prev) => {
                              const next = [...prev];
                              next[index] = event.target.value;
                              return next;
                            })
                          }
                          aria-label={`Answer to question ${index + 1}`}
                        />
                      </div>
                    ))}
                    <div className="form-footer">
                      <button
                        type="button"
                        className="btn btn--forge"
                        onClick={() => void handleSubmitDefense()}
                        disabled={busy !== null || state !== 'DEFENSE' || !answersComplete}
                      >
                        {busy === 'defense-score' ? 'Scoring…' : 'Submit defense'}
                      </button>
                    </div>
                  </>
                )}
              </div>

              <RubricCard rubric={rubric} />
            </div>
          </section>

          {/* --------------------------------------------------- 07 passport */}
          <section className="panel" id="passport" data-step={panelPhase.passport}>
            <div className="panel__head">
              <span className="panel__step">07</span>
              <h2 className="panel__title">Item passport</h2>
              <span className="panel__aside">
                <span className="panel__phase" data-phase={panelPhase.passport}>
                  {PHASE_LABEL[panelPhase.passport]}
                </span>
                <span className="station">STAMP</span>
                item level · pseudonym only
              </span>
            </div>
            <p className="panel__lede">
              The item&rsquo;s diploma: every attack it survived, every re-run, the defense
              scores and every version, assembled at publication and frozen.
            </p>

            <div className="panel__body">
              {passport ? (
                <PassportCard passport={passport} />
              ) : (
                <div className="pending-surface" aria-disabled="true">
                  <p className="lane__empty">
                    Empty until a defense passes — nothing publishes without one.
                  </p>
                </div>
              )}
            </div>
          </section>
        </>
      ) : null}

      {/* ------------------------------------------------------------ roadmap */}
      <section className="panel" id="roadmap">
        <div className="panel__head">
          <span className="panel__step">NXT</span>
          <h2 className="panel__title">Next</h2>
          <span className="panel__aside">not built · no controls</span>
        </div>
        <div className="roadmap">
          <p className="lane__rule">
            These are on the roadmap. They are listed so the boundary of what runs today is
            explicit, and none of them is a live control.
          </p>
          <ul className="roadmap__list">
            {ROADMAP.map((entry) => (
              <li className="roadmap__item" key={entry} aria-disabled="true">
                <span>{entry}</span>
                <span className="tag tag--next">next</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <footer className="colophon">
        <p>
          <b>Scope.</b> High-school and college mathematics; the demo discipline is
          probability. The mechanism is exam-agnostic — it was designed against the
          constraints of a real high-stakes exam, which is where the domain expertise comes
          from, not the boundary of where it applies.
        </p>
        <p>
          <b>Provenance.</b> Every item in this studio is team-authored and published under
          CC-BY. All content is original to the team, full stop.
        </p>
        <p>
          <b>Privacy.</b> Sessions are isolated and expire on their own. Authors appear as a
          random pseudonym. No name, email, school, city or age exists in any schema, form or
          column.
        </p>
        <p>
          <b>Models.</b> The configured reviewer id is {reviewerModel}; the configured
          adjudicator id is {adjudicatorModel}.{' '}
          {modelCallsAvailable
            ? 'Completed calls carry model id, latency, tokens and prompt version.'
            : 'Model calls are next until a server API key is configured.'}
        </p>
      </footer>

      {/* Always-visible guidance: where you are and what to do next. */}
      <aside className="next-bar" aria-live="polite" aria-label="Your next move">
        <span className="next-bar__step">{nextMove.step}</span>
        <p className="next-bar__text">{nextMove.text}</p>
        {nextMove.note ? <span className="next-bar__note">{nextMove.note}</span> : null}
        {nextMove.action ? (
          <button
            type="button"
            className="btn btn--forge"
            disabled={
              busy !== null || (nextMove.action.kind === 'gauntlet' && !modelCallsAvailable)
            }
            onClick={runNextMove}
          >
            {busy !== null ? 'Working…' : nextMove.action.label}
          </button>
        ) : null}
      </aside>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Presentational sub-components
// ---------------------------------------------------------------------------

function LanePanel({
  spec,
  lane,
  available,
}: {
  spec: LaneSpec;
  lane: LaneState;
  available: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <article className="lane" data-status={lane.status} role="status">
      <div className="lane__top">
        <h3 className="lane__name">{spec.name}</h3>
        <StatusTag status={lane.status} />
      </div>
      <p className="lane__source">{spec.source}</p>
      <p className="lane__mission">{spec.mission}</p>
      <p className="lane__rule">{spec.rule}</p>

      <div className="lane__state">
        {lane.status === 'running' ? (
          <p className="lane__empty">Awaiting a recorded result…</p>
        ) : null}

        {lane.status === 'degraded' ? (
          <div className="lane__degraded">
            <b>DEGRADED — NO RESULT RECORDED</b>
            <span>{lane.error ?? 'The reviewer did not answer in time.'}</span>
          </div>
        ) : null}

        {lane.status === 'idle' ? (
          <p className="lane__empty">
            {available ? 'Idle — no result recorded.' : 'NEXT — model transport not configured.'}
          </p>
        ) : null}

        {lane.contract ? (
          <div className="contract-shell">
            <div className="contract-summary">
              <span>{contractSummary(lane.contract)}</span>
              <button
                type="button"
                className="contract-toggle"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? 'Collapse contract' : 'Expand contract'}
              </button>
            </div>
            {expanded ? <ContractView contract={lane.contract} /> : null}
          </div>
        ) : null}
      </div>

      <div className="lane__foot">
        {lane.model ? <span>{lane.model}</span> : null}
        {lane.promptVersion ? <span>prompt {lane.promptVersion}</span> : null}
        {lane.latencyMs !== null ? <span>{lane.latencyMs} ms</span> : null}
        {lane.schemaValid !== null ? (
          <span>{lane.schemaValid ? 'schema valid' : 'schema invalid'}</span>
        ) : null}
      </div>
    </article>
  );
}

function contractSummary(contract: LaneContract): string {
  if (contract.kind === 'ambiguity') {
    return `${contract.value.answer_a} ≠ ${contract.value.answer_b}`;
  }
  if (contract.kind === 'discipline') return `verdict · ${contract.value.verdict}`;
  if (contract.kind === 'distractor') return `${contract.value.length} distractor finding(s)`;
  return `length ${contract.value.answer_length_ratio.toFixed(2)} · overlap ${contract.value.lexical_overlap_score.toFixed(2)}`;
}

function StatusTag({ status }: { status: LaneStatus }) {
  if (status === 'done') return <span className="tag">recorded</span>;
  if (status === 'degraded') return <span className="tag">degraded</span>;
  if (status === 'running') return <span className="tag">running</span>;
  return <span className="tag">idle</span>;
}

function ContractView({ contract }: { contract: LaneContract }) {
  if (contract.kind === 'ambiguity') {
    const value = contract.value;
    return (
      <div className="contract">
        <dl>
          <dt>interpretation_a</dt>
          <dd>{value.interpretation_a}</dd>
          <dt>answer_a</dt>
          <dd>{value.answer_a}</dd>
          <dt>interpretation_b</dt>
          <dd>{value.interpretation_b}</dd>
          <dt>answer_b</dt>
          <dd>{value.answer_b}</dd>
          <dt>evidence</dt>
          <dd>{value.evidence}</dd>
        </dl>
      </div>
    );
  }

  if (contract.kind === 'discipline') {
    const value = contract.value;
    return (
      <div className="contract">
        <dl>
          <dt>claim</dt>
          <dd>{value.claim}</dd>
          <dt>verdict</dt>
          <dd className={`verdict verdict--${value.verdict}`}>{value.verdict}</dd>
        </dl>
        {value.citation ? (
          <div className="contract-block">
            {`source_id     ${value.citation.source_id}\n` +
              `version_date  ${value.citation.version_date}\n` +
              `license       ${value.citation.license}\n` +
              `excerpt       ${value.citation.excerpt}\n` +
              `relevance     ${value.citation.relevance}`}
          </div>
        ) : (
          <p className="lane__rule">
            No citation attached, so the verdict cannot be correct.
          </p>
        )}
      </div>
    );
  }

  if (contract.kind === 'distractor') {
    return (
      <div className="contract">
        {contract.value.map((finding, index) => (
          <div
            className={
              finding.label === 'hypothesis'
                ? 'contract-block contract-block--hypothesis'
                : 'contract-block'
            }
            key={`${finding.distractor}-${index}`}
          >
            {`distractor          ${finding.distractor}\n` +
              `hypothesized_error  ${finding.hypothesized_error}\n` +
              `confidence          ${finding.confidence.toFixed(2)}\n` +
              `label               ${finding.label}` +
              (finding.evidence ? `\nevidence            ${finding.evidence}` : '')}
          </div>
        ))}
      </div>
    );
  }

  const probe = contract.value;
  return (
    <div className="contract">
      <div className={probe.answer_length_flag ? 'metric metric--flag' : 'metric'}>
        <span>answer_length_ratio</span>
        <b>
          {probe.answer_length_ratio.toFixed(2)}
          {probe.answer_length_flag ? ' · flagged' : ''}
        </b>
      </div>
      <div className={probe.lexical_overlap_flag ? 'metric metric--flag' : 'metric'}>
        <span>lexical_overlap_score</span>
        <b>
          {probe.lexical_overlap_score.toFixed(2)}
          {probe.lexical_overlap_flag ? ' · flagged' : ''}
        </b>
      </div>
    </div>
  );
}

function CounterexampleCard({
  contract,
  checkClass,
  stem,
  stemSplit,
  note,
}: {
  contract: AmbiguityContract;
  checkClass: CheckClass;
  stem: string;
  stemSplit?: StudioItem['stemSplit'];
  note?: string;
}) {
  const split = stemSplit ?? { before: '', ambiguous: stem, after: '' };
  return (
    <div className="counterexample fork-animate">
      <div className="fork__stem" aria-label={stem}>
        <span>{split.before}</span>
        <span className="fork__ambiguous">{split.ambiguous}</span>
        <span>{split.after}</span>
      </div>

      <div className="fork__geometry" aria-hidden="true">
        <span className="fork__drop" />
        <span className="fork__arm fork__arm--left" />
        <span className="fork__arm fork__arm--right" />
      </div>

      <div className="readings">
        <div className="reading reading--a">
          <p className="reading__label">Reading A</p>
          <p className="reading__text">{contract.interpretation_a}</p>
          <div className="sample-space" aria-label="Sample space BB, BG, GB; BB favourable">
            <span data-favourable="true">BB</span><span>BG</span><span>GB</span>
          </div>
        </div>
        <div className="reading reading--b">
          <p className="reading__label">Reading B</p>
          <p className="reading__text">{contract.interpretation_b}</p>
          <div className="sample-space" aria-label="Sample space BB, BG; BB favourable">
            <span data-favourable="true">BB</span><span>BG</span>
          </div>
        </div>
      </div>

      <div className="collision" aria-label={`${contract.answer_a} is not equal to ${contract.answer_b}`}>
        <div className="collision__answer"><b>{contract.answer_a}</b><span>option B</span></div>
        <span className="collision__neq" aria-hidden="true">≠</span>
        <div className="collision__answer"><b>{contract.answer_b}</b><span>option C</span></div>
      </div>

      <p className="counterexample__finding">
        Two of the four options are defensible. The item has two correct answers.
      </p>

      <div className="counterexample__audit">
        <div>
          <span className={`class-mark class-mark--${checkClass}`}>{checkClass}</span>
          <p>re-executed against every version; while it holds, the item does not publish.</p>
        </div>
        <div className="contract-block">{contract.evidence}{note ? `\n${note}` : ''}</div>
      </div>
    </div>
  );
}

function DiffView({ ops }: { ops: DiffOp[] }) {
  if (ops.length === 0) {
    return <span className="muted">No change recorded yet.</span>;
  }
  return (
    <>
      {ops.map((op, index) => {
        if (op.kind === 'same') return <span key={index}>{op.text}</span>;
        return (
          <span key={index} className={op.kind === 'add' ? 'diff__add' : 'diff__del'}>
            {op.text}
          </span>
        );
      })}
    </>
  );
}

function RubricCard({ rubric }: { rubric: DefenseRubric | null }) {
  return (
    <div className="rubric">
      <div className="rubric__head">
        <div>
          <h3 className="rubric__title">Defense rubric</h3>
          <p className="lane__source">3 dimensions · 0-2 each · textual evidence</p>
        </div>
        <p className="rubric__total">
          {rubric ? rubric.total : '—'}
          <small>/6</small>
        </p>
      </div>

      {RUBRIC_DIMENSIONS.map((key) => {
        const scored = rubric?.dimensions.find((dimension) => dimension.dimension === key);
        const score = scored?.score ?? null;
        return (
          <div
            className="dim"
            key={key}
            data-zero={score === 0 ? 'true' : 'false'}
            data-score={score ?? 'unscored'}
          >
            <div className="dim__top">
              <div>
                <p className="dim__name">{DIMENSION_COPY[key]}</p>
                <span className="dim__key">{key}</span>
              </div>
              <div className="scale" role="img" aria-label={`Score ${score ?? 0} of 2`}>
                <span className="scale__pip" data-on={String(score !== null && score >= 1)} />
                <span className="scale__pip" data-on={String(score !== null && score >= 2)} />
              </div>
            </div>
            <p className="dim__evidence">
              {scored
                ? scored.evidence
                : 'NEXT — no quoted rubric evidence is recorded.'}
            </p>
          </div>
        );
      })}

      <p className="rubric__gate">
        total ≥ 4 and no dimension at 0
        {rubric ? ` Outcome: ${rubric.outcome}.` : ''}
      </p>
    </div>
  );
}

function PassportCard({ passport }: { passport: Passport }) {
  const historyByClass = Object.fromEntries(
    (Object.keys(CLASS_PROMISE) as CheckClass[]).map((checkClass) => [
      checkClass,
      passport.historyReRun.filter((entry) => entry.checkClass === checkClass),
    ]),
  ) as Record<CheckClass, Passport['historyReRun']>;
  return (
    <div className="passport">
      <div className="passport__head">
        <div>
          <h3 className="passport__title">Passport · item {passport.itemId}</h3>
          <p className="lane__source">
            version {passport.itemVersionId} · {passport.discipline}
          </p>
        </div>
        <span className="tag">PUBLISHED</span>
      </div>

      <div className="passport__grid">
        <section>
          <p className="passport__section-title">Provenance and license</p>
          <div className="passport__section-body">
            <dl className="kv">
              <dt>pseudonym</dt>
              <dd>{passport.authorPseudonym}</dd>
              <dt>provenance</dt>
              <dd>{passport.provenance}</dd>
              <dt>license</dt>
              <dd>{passport.license}</dd>
              <dt>published</dt>
              <dd>{passport.publishedAt}</dd>
            </dl>
          </div>
        </section>

        <section>
          <p className="passport__section-title">Accepted attacks</p>
          <div className="passport__section-body">
            {passport.acceptedAttacks.length === 0 ? (
              <p className="lane__empty">None recorded.</p>
            ) : (
              <ul className="stack-3">
                {passport.acceptedAttacks.map((attack, index) => (
                  <li key={`${attack.reviewerType}-${index}`}>
                    <span className={`tag tag--${attack.checkClass}`}>{attack.checkClass}</span>{' '}
                    <b>{attack.reviewerType}</b>
                    <div className="contract-block">
                      {JSON.stringify(attack.contract, null, 2)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section>
          <p className="passport__section-title">History re-run by class</p>
          <div className="passport__section-body">
            <div className="passport-history">
              {(Object.keys(CLASS_PROMISE) as CheckClass[]).map((checkClass) => (
                <div className="passport-history__class" data-class={checkClass} key={checkClass}>
                  <span className={`class-mark class-mark--${checkClass}`}>{checkClass}</span>
                  <p className="class-group__promise">{CLASS_PROMISE[checkClass].promise}</p>
                  {historyByClass[checkClass].length === 0 ? (
                    <p className="lane__empty">None recorded.</p>
                  ) : (
                    historyByClass[checkClass].map((entry, index) => (
                      <div key={`${entry.checkClass}-${index}`} className="rerun">
                        <div className="rerun__top">
                          <span>{entry.checkClass}</span>
                          <span className={`rerun__result rerun__result--${entry.result}`}>
                            {entry.checkClass === 'counterexample' && entry.result === 'regressed'
                              ? 'STILL HOLDS · BLOCKS PUBLICATION'
                              : entry.result}
                          </span>
                        </div>
                        {entry.detail ? <p className="rerun__detail">{entry.detail}</p> : null}
                      </div>
                    ))
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section>
          <p className="passport__section-title">Discipline verdict</p>
          <div className="passport__section-body">
            <p className={`verdict verdict--${passport.disciplineVerdict.verdict}`}>
              {passport.disciplineVerdict.verdict}
            </p>
            {passport.disciplineVerdict.citation ? (
              <dl className="kv" style={{ marginTop: 'var(--s3)' }}>
                <dt>source_id</dt>
                <dd>{passport.disciplineVerdict.citation.source_id}</dd>
                <dt>version</dt>
                <dd>{passport.disciplineVerdict.citation.version_date}</dd>
                <dt>license</dt>
                <dd>{passport.disciplineVerdict.citation.license}</dd>
                <dt>excerpt</dt>
                <dd>{passport.disciplineVerdict.citation.excerpt}</dd>
                <dt>relevance</dt>
                <dd>{passport.disciplineVerdict.citation.relevance}</dd>
              </dl>
            ) : (
              <p className="lane__rule">No sufficient source, so the verdict stays unverified.</p>
            )}
          </div>
        </section>

        <section>
          <p className="passport__section-title">Defense</p>
          <div className="passport__section-body">
            {'dimensions' in passport.defense ? (
              <ul className="stack-3">
                {passport.defense.dimensions.map((dimension) => (
                  <li key={dimension.dimension}>
                    <b>
                      {dimension.score}/2 · {DIMENSION_COPY[dimension.dimension]}
                    </b>
                    <p className="dim__evidence">{dimension.evidence}</p>
                  </li>
                ))}
                <li>
                  <b>
                    Total {passport.defense.total}/6 · {passport.defense.outcome}
                  </b>
                </li>
              </ul>
            ) : (
              <p className="lane__rule">
                Outcome inconclusive: the evaluator failed, which is never an automatic
                reject.
              </p>
            )}
          </div>
        </section>

        <section>
          <p className="passport__section-title">Versions</p>
          <div className="passport__section-body">
            <ul className="stack-3">
              {passport.versions.map((version) => (
                <li key={version.versionNumber}>
                  <span className="version-chip">v{version.versionNumber}</span>
                  {version.diff ? <div className="contract-block">{version.diff}</div> : null}
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}
