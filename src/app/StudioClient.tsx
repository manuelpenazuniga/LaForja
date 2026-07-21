'use client';

/**
 * LA FORJA — the studio, one single end-to-end route.
 *
 * OWNER: Claude (presentation + local state shapes only).
 *
 * This file contains NO business logic. Every piece of behaviour that decides
 * something about an item lives behind the `api` object at the bottom of the
 * imports section, and every one of those functions is a `TODO(codex)` stub that
 * must call the matching /api route, Zod-validate the response and return the
 * typed shape declared here. The state machine itself is called through
 * `reduce()` from src/core/stateMachine.ts — this component never decides which
 * transition is legal, it only renders the result.
 *
 * Flow order on screen (doc §3 winning slice):
 *   01 item + editable form        05 history re-run by check class
 *   02 gauntlet lanes              06 written defense + rubric
 *   03 accepted counterexample     07 item passport
 *   04 repair v1 -> v2 + diff
 */

import { useCallback, useMemo, useRef, useState, type CSSProperties } from 'react';

import { reduce } from '@/core/stateMachine';
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
}

/** The editable form buffer. Same fields as StudioItem, minus identity. */
type ItemDraft = Omit<StudioItem, 'id' | 'versionNumber'>;

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

export interface RepairResult {
  itemId: string;
  versionNumber: number;
}

export interface HistoryReRunResult {
  outcomes: ReRunOutcome[];
  event: Extract<StateEvent, 'HISTORY_CLEAN' | 'HISTORY_REGRESSED'>;
}

export interface DefenseQuestion {
  id: string;
  prompt: string;
}

export interface DefenseResult {
  rubric: DefenseRubric;
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
  /**
   * The seeded demo challenge, mirrored from prisma/seed.ts so the studio has
   * something to render before the session route answers.
   */
  demoFixture: StudioItem;
}

// ---------------------------------------------------------------------------
// Data access. EVERY function below is a Codex implementation point.
// The UI renders what these return and nothing else.
// ---------------------------------------------------------------------------

const api = {
  /**
   * TODO(codex): POST /api/session — create an isolated visitor session
   * (random pseudonym, TTL from SESSION_TTL_MINUTES, rate limited, zero PII,
   * doc §10) and return it together with the seeded demo item's current version
   * (prisma/seed.ts). Zod-validate the response body before returning.
   */
  async loadDemoChallenge(): Promise<SessionInfo> {
    throw new Error('POST /api/session is not wired yet');
  },

  /**
   * TODO(codex): POST /api/gauntlet — run the gauntlet for `itemId`.
   *  - Server side: runGauntlet() (3 concurrent Responses calls + the
   *    deterministic item_probe) then adjudicate() (src/reviewers/adjudication.ts).
   *  - Stream each reviewer's result as it settles (SSE or a chunked JSON stream)
   *    and call `onLane` per reviewer so the four lanes fill independently.
   *  - A reviewer that fails or times out must arrive as
   *    onLane(type, { status: 'degraded', error }) — never as a thrown error.
   *  - Resolve with the adjudicated checks and the transition event the server
   *    decided (CHECKS_ACCEPTED when any check is accepted, else GAUNTLET_CLEAN).
   *  - Persist a ModelCall per call and a GauntletRun for the pass.
   */
  async runGauntlet(
    _itemId: string,
    _onLane: (reviewerType: ReviewerType, patch: Partial<LaneState>) => void,
  ): Promise<GauntletResult> {
    throw new Error('POST /api/gauntlet is not wired yet');
  },

  /**
   * TODO(codex): POST /api/repair — create a NEW ItemVersion from the draft
   * (published versions are immutable; a repair is never a mutation) and return
   * its version number. Validate the body with Zod and enforce the input size
   * limits of doc §10.
   */
  async submitRepair(_itemId: string, _draft: ItemDraft): Promise<RepairResult> {
    throw new Error('POST /api/repair is not wired yet');
  },

  /**
   * TODO(codex): POST /api/rerun — re-run the FULL recorded check history against
   * the new version via reRunHistory() (src/core/checks.ts) and return the
   * per-check outcomes plus the transition event (HISTORY_REGRESSED when any
   * deterministic or counterexample check regressed, else HISTORY_CLEAN).
   */
  async reRunHistory(_itemId: string, _versionNumber: number): Promise<HistoryReRunResult> {
    throw new Error('POST /api/rerun is not wired yet');
  },

  /**
   * TODO(codex): POST /api/defense/questions — generateDefenseQuestions()
   * (src/defense/viva.ts) grounded in the accepted findings. Exactly 2 questions,
   * validated with DefenseQuestionsSchema.
   */
  async startDefense(_itemId: string): Promise<DefenseQuestion[]> {
    throw new Error('POST /api/defense/questions is not wired yet');
  },

  /**
   * TODO(codex): POST /api/defense/score — scoreDefense() against the 3-dimension
   * rubric (0-2 + textual evidence each). Return the rubric and the event:
   * DEFENSE_PASSED when meetsPublishThreshold(), DEFENSE_FAILED when it does not,
   * DEFENSE_EVALUATOR_FAILED when the evaluator call itself failed after the retry
   * (never an auto-reject, doc §6.3).
   */
  async submitDefense(
    _itemId: string,
    _answers: Record<string, string>,
  ): Promise<DefenseResult> {
    throw new Error('POST /api/defense/score is not wired yet');
  },

  /**
   * TODO(codex): GET /api/passport?itemId=… — buildPassport()
   * (src/passport/passport.ts). Returns the frozen item-level snapshot.
   */
  async loadPassport(_itemId: string): Promise<Passport> {
    throw new Error('GET /api/passport is not wired yet');
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
    promise:
      'The promise of this class is strict non-regression: a new version must not reintroduce the failure. Fixed thresholds, recomputed in code.',
  },
  counterexample: {
    title: 'Counterexample',
    promise:
      'The construction is meant to be re-executed against every new version. While it still holds, the item must not publish.',
  },
  semantic: {
    title: 'Semantic judgment',
    promise:
      'Re-adjudicated per version by design. Never stated as an absolute guarantee; the result stays visible in the passport.',
  },
};

interface LaneSpec {
  reviewerType: ReviewerType;
  name: string;
  source: string;
  contractFields: string;
  rule: string;
}

const LANE_SPECS: LaneSpec[] = [
  {
    reviewerType: 'ambiguity',
    name: 'Ambiguity',
    source: 'Responses call',
    contractFields: 'interpretation_a · interpretation_b · answer_a · answer_b · evidence',
    rule: 'Valid only when the two readings produce different answers.',
  },
  {
    reviewerType: 'discipline',
    name: 'Discipline · probability',
    source: 'Responses call + solver',
    contractFields: 'claim · verdict · citation{source_id, version_date, license, excerpt, relevance}',
    rule: 'A correct verdict requires a full citation. No sufficient source means unverified.',
  },
  {
    reviewerType: 'distractor',
    name: 'Distractors',
    source: 'Responses call',
    contractFields: 'distractor · hypothesized_error · confidence · evidence? · label',
    rule: 'A finding without evidence is labeled hypothesis, not a defect.',
  },
  {
    reviewerType: 'item_probe',
    name: 'Item probe',
    source: 'Deterministic · no model',
    contractFields: 'answer_length_ratio · lexical_overlap_score',
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

const GUARANTEE_TEXT =
  'The promise of the design: every repair re-runs all recorded counterexamples and checks, deterministic invariants must not regress, and semantic judgments are re-adjudicated and shown in the passport rather than treated as settled. The re-run engine that executes this is next.';

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
  const [reRun, setReRun] = useState<ReRunOutcome[]>([]);

  const [questions, setQuestions] = useState<DefenseQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [rubric, setRubric] = useState<DefenseRubric | null>(null);
  const [passport, setPassport] = useState<Passport | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [timeToCounterexampleMs, setTimeToCounterexampleMs] = useState<number | null>(null);
  const gauntletStartedRef = useRef<number | null>(null);

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
      setSession(info);
      setItem(info.item);
      setDraft(draftOf(info.item));
    } catch (err) {
      // The route is not wired yet: fall back to the mirrored fixture so the
      // studio stays usable, and say so plainly.
      setItem(demoFixture);
      setDraft(draftOf(demoFixture));
      setNotice({
        tone: 'warn',
        label: 'Local fixture',
        text: `Loaded the demo challenge from the local fixture. The isolated session route is next — ${errorText(err)}.`,
      });
    } finally {
      setBusy(null);
    }
  }, [demoFixture]);

  const handleSubmitToGauntlet = useCallback(async () => {
    if (!item || !draft) return;
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
        setTimeToCounterexampleMs(Math.round(now - startedAt));
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
  }, [applyEvent, draft, item, patchLane]);

  const handleSubmitRepair = useCallback(async () => {
    if (!item || !draft) return;
    setBusy('repair');
    setNotice(null);
    try {
      const repair = await api.submitRepair(item.id, draft);
      const repaired: StudioItem = { ...draft, id: repair.itemId, versionNumber: repair.versionNumber };
      setPreviousVersion(item);
      setItem(repaired);
      if (!applyEvent('SUBMIT_REPAIR')) return;

      const history = await api.reRunHistory(repair.itemId, repair.versionNumber);
      setReRun(history.outcomes);
      applyEvent(history.event);
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
    if (!item) return;
    setBusy('defense-questions');
    setNotice(null);
    try {
      const next = await api.startDefense(item.id);
      setQuestions(next);
      setAnswers({});
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
  }, [item]);

  const handleSubmitDefense = useCallback(async () => {
    if (!item) return;
    setBusy('defense-score');
    setNotice(null);
    try {
      const result = await api.submitDefense(item.id, answers);
      setRubric(result.rubric);
      const next = applyEvent(result.event);
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

  const heat = useMemo(() => {
    const span = RAIL_STATES.length - 1;
    const ratio = span > 0 ? railIndex / span : 0;
    return `${Math.round(ratio * 100)}%`;
  }, [railIndex]);

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

  const formEditable = state === 'DRAFT' && item !== null;
  // CHALLENGED only. DISPUTED is deliberately excluded: post-publication disputes
  // are outside the winning slice, so no control on this page may open the
  // NEW_DISPUTE / DISPUTE_REPAIR path (src/core/types.ts SCOPE NOTE).
  const repairEditable = state === 'CHALLENGED' && item !== null;

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
      <header className="masthead">
        <div>
          <h1 className="wordmark">
            <span>LA</span>
            <span className="wordmark__forja">FORJA</span>
            <span className="wordmark__kind">an adversarial learning studio</span>
          </h1>
          <p className="tagline">
            <strong>Getting the right answer is not enough.</strong> Forge it, attack it,
            defend it. High-school and college mathematics. By design the reviewers return
            challenges and evidence; the item, the repair and the defense stay with the
            student.
          </p>
        </div>
        <div className="masthead__meta">
          <div className="meta-row">
            <span>reviewers</span>
            <b>{reviewerModel}</b>
            <span>·</span>
            <span>adjudication</span>
            <b>{adjudicatorModel}</b>
          </div>
          <div className="meta-row">
            <span className={modelCompliant ? 'tag tag--ok' : 'tag tag--crit'}>
              {modelCompliant ? 'gpt-5.6 family' : 'non-compliant model'}
            </span>
            <span className="tag">
              session · {session ? session.pseudonym : 'not started'}
            </span>
            <span className="tag">zero PII</span>
          </div>
          <div className="meta-row">
            <span>scope</span>
            <b>high-school / college mathematics</b>
            <span>·</span>
            <span>demo discipline</span>
            <b>probability</b>
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
          <ol className="rail" style={{ '--heat': heat } as CSSProperties}>
            {RAIL_STATES.map((railState, index) => {
              const phase =
                index < railIndex ? 'past' : index === railIndex ? 'current' : 'future';
              return (
                <li key={railState} className="rail__node" data-phase={phase}>
                  <span className="rail__notch" aria-hidden="true" />
                  <span className="rail__label">{railState}</span>
                  <span className="rail__note">{STATE_COPY[railState].note}</span>
                </li>
              );
            })}
          </ol>
        </div>

        <div className="branches">
          <span className="branches__caption">Branch states</span>
          {BRANCH_STATES.map((branch) => (
            <span
              key={branch}
              className="branch"
              data-reached={reachedBranches.includes(branch) ? 'true' : 'false'}
              data-current={state === branch ? 'true' : 'false'}
            >
              {branch}
              <span className="muted">· {STATE_COPY[branch].note}</span>
              {branch === 'DISPUTED' ? <span className="tag tag--next">next</span> : null}
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
          <p className="onboard__kicker">First session</p>
          <h2 className="onboard__title">
            {item ? 'Demo challenge loaded' : 'Start with a broken item, not a blank form'}
          </h2>
          <p className="onboard__copy">
            {item
              ? 'The item below is a deliberately defective probability item. The cycle it is built for: send it through the gauntlet, read the counterexample, repair it, defend the repair.'
              : 'You get an original probability item with a real defect in it. The cycle is built to make you find the flaw, repair it, and watch the passport grow with your repair.'}
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
            <span className="btn-note">Team-authored original · CC-BY · probability</span>
          </div>
        </div>

        <div className="onboard__secondary">
          <p className="onboard__kicker">Authoring</p>
          <h3 className="lane__name" style={{ marginTop: 'var(--s3)' }}>
            Author your own item
          </h3>
          <p className="lane__rule" style={{ marginTop: 'var(--s3)' }}>
            Repair first. Creating an item from scratch stays locked while you work through
            the demo cycle.
          </p>
          <div className="onboard__actions">
            <button type="button" className="btn btn--locked" disabled aria-disabled="true">
              <span className="btn__lock" aria-hidden="true">
                ▮
              </span>
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
          <section className="panel" id="item">
            <div className="panel__head">
              <span className="panel__step">01 · Billet</span>
              <h2 className="panel__title">The item</h2>
              <span className="panel__aside">
                v{item.versionNumber} · probability · {formEditable ? 'editable' : 'read only'}
              </span>
            </div>
            <p className="panel__lede">
              One original multiple-choice item and its author rationale. Published versions
              are immutable by design, so a repair creates a new version instead of
              overwriting this one.
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
                disabled={busy !== null || state !== 'DRAFT'}
              >
                {busy === 'gauntlet' ? 'Running the gauntlet…' : 'Start gauntlet'}
              </button>
              <span className="btn-note">
                Three concurrent reviewers and one deterministic probe. Running them is next.
              </span>
            </div>
          </section>

          {/* ---------------------------------------------------- 02 gauntlet */}
          <section className="panel" id="gauntlet">
            <div className="panel__head">
              <span className="panel__step">02 · Heat</span>
              <h2 className="panel__title">The gauntlet</h2>
              <span className="tag tag--next">next</span>
              <span className="panel__aside">
                {abstained > 0 ? `${abstained} abstained` : 'four independent lanes'}
              </span>
            </div>
            <p className="panel__lede">
              Each lane carries its own evidence contract and is built to fail on its own: a
              reviewer that times out degrades its lane while the other lanes still report,
              and nothing is collapsed into a single score. The reviewer calls themselves are
              next, so the lanes below stay empty until they are wired.
            </p>

            <div className="panel__body lanes">
              {LANE_SPECS.map((spec) => (
                <LanePanel key={spec.reviewerType} spec={spec} lane={lanes[spec.reviewerType]} />
              ))}
            </div>
          </section>

          {/* -------------------------------------------- 03 counterexample */}
          <section className="panel" id="counterexample">
            <div className="panel__head">
              <span className="panel__step">03 · Fracture</span>
              <h2 className="panel__title">Accepted counterexample</h2>
              <span className="tag tag--next">next</span>
              <span className="panel__aside">separate adjudication step</span>
            </div>
            <p className="panel__lede">
              What this surface is built to show is not a score but a construction anyone can
              re-execute: two readings of the same stem that produce two different answers.
              The separate adjudication step that accepts one is next.
            </p>

            <div className="panel__body">
              {counterexample ? (
                <CounterexampleCard
                  contract={counterexample.contract}
                  checkClass={counterexample.check.checkClass}
                  note={counterexample.check.note}
                />
              ) : (
                <div className="card card--flat">
                  <p className="lane__empty">
                    No accepted counterexample. Nothing can be accepted until the gauntlet and
                    the adjudication step are wired — both are next.
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
          <section className="panel" id="repair">
            <div className="panel__head">
              <span className="panel__step">04 · Hammer</span>
              <h2 className="panel__title">Repair</h2>
              <span className="tag tag--next">next</span>
              <span className="panel__aside">
                {previousVersion
                  ? `v${previousVersion.versionNumber} → v${item.versionNumber}`
                  : `v${item.versionNumber} → v${item.versionNumber + 1}`}
              </span>
            </div>
            <p className="panel__lede">
              A repair never edits the recorded version; it creates the next one, and the diff
              below is what the passport is built to carry. The word-level diff renders live
              from what you type. Writing the new version is next.
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
                  {busy === 'repair' ? 'Forging the new version…' : 'Submit repair'}
                </button>
                <span className="btn-note">
                  Submitting is designed to create a new version and re-run the full check
                  history. Both are next.
                </span>
              </div>
            </div>
          </section>

          {/* ------------------------------------------------- 05 history re-run */}
          <section className="panel" id="rerun">
            <div className="panel__head">
              <span className="panel__step">05 · Quench</span>
              <h2 className="panel__title">History re-run</h2>
              <span className="tag tag--next">next</span>
              <span className="panel__aside">grouped by check class</span>
            </div>
            <p className="guarantee">{GUARANTEE_TEXT}</p>

            <div className="panel__body classes">
              {(Object.keys(CLASS_PROMISE) as CheckClass[]).map((checkClass) => {
                const outcomes = reRun.filter((outcome) => outcome.checkClass === checkClass);
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
                          Nothing recorded in this class. The re-run that would fill it is
                          next.
                        </p>
                      ) : (
                        outcomes.map((outcome) => (
                          <div className="rerun fade-in" key={outcome.originalCheckId}>
                            <div className="rerun__top">
                              <span>{outcome.originalCheckId}</span>
                              <span className={`rerun__result rerun__result--${outcome.result}`}>
                                {outcome.result}
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
          <section className="panel" id="defense">
            <div className="panel__head">
              <span className="panel__step">06 · Proof</span>
              <h2 className="panel__title">Written defense</h2>
              <span className="tag tag--next">next</span>
              <span className="panel__aside">
                two adaptive questions · rubric 3 × 0-2 · publish at ≥ 4/6
              </span>
            </div>
            <p className="panel__lede">
              The reviewers challenge; the student owns the repair and the defense. Each
              rubric dimension is built to carry the textual evidence it was scored on, and an
              evaluator that fails sends the item to DEFENSE_INCONCLUSIVE rather than to an
              automatic reject. Question generation and rubric scoring are next.
            </p>

            <div className="panel__body viva">
              <div>
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
                        disabled={busy !== null || state !== 'DEFENSE'}
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
                          value={answers[question.id] ?? ''}
                          disabled={state !== 'DEFENSE'}
                          placeholder="Write your answer"
                          onChange={(event) =>
                            setAnswers((prev) => ({ ...prev, [question.id]: event.target.value }))
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
                        disabled={busy !== null || state !== 'DEFENSE'}
                      >
                        {busy === 'defense-score' ? 'Scoring…' : 'Submit defense'}
                      </button>
                      {state === 'DEFENSE_INCONCLUSIVE' ? (
                        <button type="button" className="btn" onClick={handleRetryDefense}>
                          Retry the defense
                        </button>
                      ) : null}
                    </div>
                  </>
                )}
              </div>

              <RubricCard rubric={rubric} />
            </div>
          </section>

          {/* --------------------------------------------------- 07 passport */}
          <section className="panel" id="passport">
            <div className="panel__head">
              <span className="panel__step">07 · Stamp</span>
              <h2 className="panel__title">Item passport</h2>
              <span className="tag tag--next">next</span>
              <span className="panel__aside">item level only, never student level</span>
            </div>
            <p className="panel__lede">
              What publishing is designed to produce is an auditable learning trace:
              provenance and license, accepted attacks, the history re-run by class, the
              discipline verdict with its full citation or marked unverified, the rubric, and
              the version diff. Assembling it is next.
            </p>

            <div className="panel__body">
              {passport ? (
                <PassportCard passport={passport} />
              ) : (
                <div className="card card--flat">
                  <p className="lane__empty">
                    The passport is stamped when the defense passes and the item reaches
                    PUBLISHED. Assembling it is next.
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
          <span className="panel__step">Out of scope</span>
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
          <b>Models.</b> Reviewers run on {reviewerModel}; the separate adjudication step runs
          on {adjudicatorModel}. Every run is recorded with the exact model id, latency,
          tokens and prompt version; the calls that produce those records are next.
        </p>
      </footer>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Presentational sub-components
// ---------------------------------------------------------------------------

function LanePanel({ spec, lane }: { spec: LaneSpec; lane: LaneState }) {
  return (
    <article className="lane" data-status={lane.status}>
      <div className="lane__top">
        <h3 className="lane__name">{spec.name}</h3>
        <StatusTag status={lane.status} />
      </div>
      <p className="lane__source">{spec.source}</p>
      <p className="lane__contract-name">{spec.contractFields}</p>
      <p className="lane__rule">{spec.rule}</p>

      <div className="lane__state">
        {lane.status === 'running' ? (
          <>
            <div className="pulse" aria-hidden="true" />
            <p className="lane__empty" style={{ marginTop: 'var(--s3)' }}>
              Streaming…
            </p>
          </>
        ) : null}

        {lane.status === 'degraded' ? (
          <p className="lane__error">
            Lane degraded. {lane.error ?? 'The reviewer did not answer in time.'} The other
            lanes continue.
          </p>
        ) : null}

        {lane.status === 'idle' ? (
          <p className="lane__empty">Idle. Wiring this lane to its source is next.</p>
        ) : null}

        {lane.contract ? <ContractView contract={lane.contract} /> : null}
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

function StatusTag({ status }: { status: LaneStatus }) {
  if (status === 'done') return <span className="tag tag--ok">done</span>;
  if (status === 'degraded') return <span className="tag tag--warn">degraded</span>;
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
          <div className="contract-block" key={`${finding.distractor}-${index}`}>
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
  note,
}: {
  contract: AmbiguityContract;
  checkClass: CheckClass;
  note?: string;
}) {
  return (
    <div className="counterexample fade-in">
      <div className="counterexample__head">
        <h3 className="counterexample__title">Two readings, two answers</h3>
        <span className={`tag tag--${checkClass}`}>{checkClass}</span>
        <span className="tag tag--ok">accepted</span>
      </div>

      <div className="readings">
        <div className="reading">
          <p className="reading__label">Reading A</p>
          <p className="reading__text">{contract.interpretation_a}</p>
          <p className="reading__answer">
            <span>answer</span>
            <b>{contract.answer_a}</b>
          </p>
        </div>
        <div className="readings__vs" aria-hidden="true">
          ≠
        </div>
        <div className="reading">
          <p className="reading__label">Reading B</p>
          <p className="reading__text">{contract.interpretation_b}</p>
          <p className="reading__answer">
            <span>answer</span>
            <b>{contract.answer_b}</b>
          </p>
        </div>
      </div>

      <div className="counterexample__evidence">
        <p className="passport__section-title">Evidence</p>
        <div className="contract-block">{contract.evidence}</div>
      </div>

      <p className="counterexample__verdict">
        The contract is valid because the two answers differ. This construction is meant to be
        re-executed against every new version: while it still holds, the item must not publish.
        {note ? ` ${note}` : ''}
      </p>
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
          <div className="dim" key={key} data-zero={score === 0 ? 'true' : 'false'}>
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
                : 'Evidence appears here once rubric scoring is wired — that is next.'}
            </p>
          </div>
        );
      })}

      <p className="rubric__gate">
        Publishes at 4 of 6 or higher with no dimension at 0.
        {rubric ? ` Outcome: ${rubric.outcome}.` : ''}
      </p>
    </div>
  );
}

function PassportCard({ passport }: { passport: Passport }) {
  return (
    <div className="passport fade-in">
      <div className="passport__head">
        <div>
          <h3 className="passport__title">Passport · item {passport.itemId}</h3>
          <p className="lane__source">
            version {passport.itemVersionId} · {passport.discipline}
          </p>
        </div>
        <span className="tag tag--ok">published</span>
      </div>

      <div className="passport__grid">
        <section>
          <p className="passport__section-title">Provenance and license</p>
          <div className="passport__section-body">
            <dl className="kv">
              <dt>author</dt>
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
            {passport.historyReRun.length === 0 ? (
              <p className="lane__empty">None recorded.</p>
            ) : (
              <ul className="stack-3">
                {passport.historyReRun.map((entry, index) => (
                  <li key={`${entry.checkClass}-${index}`} className="rerun">
                    <div className="rerun__top">
                      <span className={`tag tag--${entry.checkClass}`}>{entry.checkClass}</span>
                      <span className={`rerun__result rerun__result--${entry.result}`}>
                        {entry.result}
                      </span>
                    </div>
                    {entry.detail ? <p className="rerun__detail">{entry.detail}</p> : null}
                  </li>
                ))}
              </ul>
            )}
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
