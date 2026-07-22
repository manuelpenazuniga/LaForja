/**
 * LA FORJA — labeled smoke eval runner spec (doc §8).
 *
 * THE EVAL CANNOT BE RUN HERE, AND IT DOES NOT NEED TO BE. Running it needs an
 * API key; SPECIFYING it does not, and neither does verifying the part that
 * actually matters. `runConfig` takes an `EvalRunnerDeps` bundle whose members
 * are exactly the things that touch a model or the disk. Everything on this side
 * of that seam — the counting, the dev/holdout guard, the artifact gate — is
 * driven here with canned reviewer results. THERE IS NO NETWORK IN THIS FILE.
 *
 * WHY THE SCORING GETS THIS MUCH ATTENTION: it produces the numbers that go in
 * the submission. Three failure modes are specified separately because each one
 * inflates the headline in a different, invisible way:
 *   1. crediting a finding of the right SHAPE about the WRONG defect;
 *   2. reporting detections without reporting false positives on `clean` items;
 *   3. counting a citation that does not resolve as if it did.
 *
 * AND THE COMPARISON MUST BE FAIR. Doc §8 commits us to "We compared…" — win or
 * lose. A baseline handicapped by a different serialization, a shorter timeout
 * or laxer schema handling would not make the gauntlet better, it would make the
 * whole eval worthless. The baseline-fairness suite is enforceable TODAY through
 * the implemented `runGauntlet`, so it is not skipped.
 *
 * Every suite is live. Model and filesystem boundaries are injected, so the
 * complete runner contract is verified offline without producing submission
 * artifacts or reaching a network transport.
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { Citation, ReviewerType } from '@/core/types';
import type { ModelCallArgs, ModelCallResult } from '@/openai/client';
import type { AdjudicatedCheck } from '@/reviewers/adjudication';
import {
  DEFAULT_EVAL_DEPS,
  DEFAULT_EVAL_SETTINGS,
  DEFECT_TYPE_REVIEWERS,
  RESULTS_DIR,
  assertReportsCompliance,
  assertSplitPurity,
  claimedDefectTypes,
  collectReportModelIds,
  countDefectsFound,
  countFalsePositivesOnClean,
  isDefectHit,
  percentile,
  runConfig,
  tallyCounts,
  writeResults,
  type CitationResolution,
  type EvalRunnerDeps,
  type IntendedDefectType,
  type ItemEvaluation,
} from '@/eval/run';
import {
  EVAL_CONFIGS,
  RUNS_PER_CONFIG,
  SmokeItemSchema,
  type EvalConfig,
  type EvalReport,
  type RunIndex,
  type SmokeItem,
} from '@/eval/types';
import type { Ambiguity, Discipline, DistractorMap } from '@/reviewers/schemas';
import type { ItemProbeResult } from '@/core/types';
import type { ProbeInput } from '@/probe/itemProbe';
import {
  CONFIG_REVIEWERS,
  GENERAL_REVIEWER,
  GENERAL_REVIEWER_TIMEOUT_MS,
  REVIEWER_TIMEOUT_MS,
  runGauntlet,
  toDelimitedItem,
  type DisciplineReviewerFn,
  type GauntletDeps,
  type GeneralReviewerCaller,
  type OrchestratedReviewer,
  type RawItem,
  type ReviewerFn,
  type ReviewerOutcome,
} from '@/reviewers/orchestrator';

const REVIEWER_MODEL = 'gpt-5.6-terra';
const ADJUDICATOR_MODEL = 'gpt-5.6-sol';
const FORBIDDEN_MODEL = 'gpt-4o-mini';

/**
 * Adapt a `ReviewerFn<Discipline>` test fake to the discipline seam type: the
 * orchestrator passes `discipline` at index 2, before the signal, so drop it and
 * forward the signal.
 */
const asDisciplineReviewer =
  (fn: ReviewerFn<Discipline>): DisciplineReviewerFn =>
  (t, m, _discipline, signal) =>
    fn(t, m, signal);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Build a labeled smoke item THROUGH `SmokeItemSchema`, never as a bare object
 * literal. A fixture that the real schema would reject is a fixture that proves
 * nothing about the real runner.
 */
function makeItem(overrides: Partial<SmokeItem> & Pick<SmokeItem, 'id'>): SmokeItem {
  const base = {
    _license: 'CC-BY-4.0',
    _attribution: 'LA FORJA team (test fixture).',
    author_labeled: true as const,
    split: 'holdout' as const,
    category: 'clean' as const,
    discipline: 'probability' as const,
    stem: 'A fair coin is tossed twice. What is the probability of exactly one head?',
    options: ['1/4', '1/2', '3/4'],
    correct_key: 'B',
    author_rationale: 'Two of the four equally likely outcomes contain exactly one head.',
    intended_defect: null,
    source: null,
  };
  return SmokeItemSchema.parse({ ...base, ...overrides });
}

const AMBIGUOUS_ITEM = makeItem({
  id: 'fixture-ambiguous',
  category: 'ambiguous',
  intended_defect: {
    type: 'ambiguity',
    description: '"At least one" admits two readings of the conditioning event.',
    expected_finding: 'The ambiguity reviewer must produce two readings with different answers.',
  },
});

const FACTUAL_ITEM = makeItem({
  id: 'fixture-factual',
  category: 'factual_error',
  intended_defect: {
    type: 'factual_error',
    description: 'The marked key applies replacement where the stem rules it out.',
    expected_finding: 'The bounded solver must compute 2/15 and contradict the marked key.',
    true_answer: '2/15',
  },
  source: {
    source_id: 'forja-corpus/sampling-without-replacement',
    version_date: '2025-07-18',
    license: 'CC-BY-4.0',
    excerpt: 'The probability of the second draw is computed over the reduced set.',
    relevance: 'Fixes the second factor at 3/9, which is the step the author replaced.',
  },
});

const CUE_LEAK_ITEM = makeItem({
  id: 'fixture-cue-leak',
  category: 'cue_leak',
  intended_defect: {
    type: 'cue_leak',
    description: 'The correct option is far longer than the others and echoes the stem.',
    expected_finding: 'item_probe must raise answer_length_flag and lexical_overlap_flag.',
  },
});

const CLEAN_ITEM = makeItem({ id: 'fixture-clean' });

/** One holdout mini-set: 3 planted defects + 1 clean item. */
const HOLDOUT_ITEMS: SmokeItem[] = [AMBIGUOUS_ITEM, FACTUAL_ITEM, CUE_LEAK_ITEM, CLEAN_ITEM];

const DEV_ITEM = makeItem({
  id: 'fixture-dev-leak',
  split: 'dev',
  category: 'ambiguous',
  intended_defect: {
    type: 'ambiguity',
    description: 'A dev item used to develop the prompts.',
    expected_finding: 'Never reported as evaluation.',
  },
});

const RESOLVING_CITATION: Citation = {
  source_id: 'forja-corpus/sampling-without-replacement',
  version_date: '2025-07-18',
  license: 'CC-BY-4.0',
  excerpt: 'The probability of the second draw is computed over the reduced set.',
  relevance: 'Grounds the without-replacement step.',
};

const FABRICATED_CITATION: Citation = {
  source_id: 'forja-corpus/does-not-exist',
  version_date: '2025-07-18',
  license: 'CC-BY-4.0',
  excerpt: 'A passage that appears in no licensed document.',
  relevance: 'Looks exactly like a real citation, which is the whole problem.',
};

/** Offline corpus stand-in: only the fixture source exists, with that excerpt. */
const fakeResolveCitation = (citation: Citation): CitationResolution => {
  const resolved = citation.source_id === RESOLVING_CITATION.source_id;
  return {
    resolved,
    excerptMatches: resolved && citation.excerpt === RESOLVING_CITATION.excerpt,
  };
};

function makeCheck(overrides: Partial<AdjudicatedCheck> = {}): AdjudicatedCheck {
  return {
    reviewerType: 'ambiguity',
    verificationKind: 'interpretation',
    checkClass: 'counterexample',
    status: 'accepted',
    schemaValid: true,
    contract: { evidence: 'two readings disagree' },
    ...overrides,
  };
}

function makeEvaluation(overrides: Partial<ItemEvaluation> & Pick<ItemEvaluation, 'itemId'>): ItemEvaluation {
  return {
    checks: [],
    citations: [],
    latencyMs: 1_000,
    costUsd: 0.01,
    schemaValid: 3,
    schemaTotal: 3,
    modelIds: [REVIEWER_MODEL],
    raw: [],
    ...overrides,
  };
}

function makeReport(overrides: Partial<EvalReport> = {}): EvalReport {
  return {
    config: 'gauntlet',
    runIndex: 1,
    modelIds: { reviewer: REVIEWER_MODEL, adjudicator: ADJUDICATOR_MODEL },
    allModelIds: [REVIEWER_MODEL, ADJUDICATOR_MODEL],
    settings: DEFAULT_EVAL_SETTINGS,
    promptHash: 'sha256:deadbeef',
    timestamp: '2026-07-21T00:00:00.000Z',
    split: 'holdout',
    counts: {
      itemsEvaluated: 16,
      defectsPlanted: 12,
      defectsFound: 11,
      falsePositivesOnClean: 1,
      citationsChecked: 8,
      citationsPrecise: 7,
      schemaValid: 47,
      schemaTotal: 48,
    },
    latencyMs: { p50: 4_200, p95: 9_100 },
    costUsdPerItem: 0.031,
    raw: [],
    ...overrides,
  };
}

function makeEvalDeps(overrides: Partial<EvalRunnerDeps> = {}): EvalRunnerDeps {
  const canned = new Map<string, ItemEvaluation>(
    HOLDOUT_ITEMS.map((item) => [item.id, makeEvaluation({ itemId: item.id })]),
  );
  return {
    loadSmokeItems: async (split) =>
      split === 'holdout' ? [...HOLDOUT_ITEMS] : [DEV_ITEM],
    evaluateItem: async (item) =>
      canned.get(item.id) ?? makeEvaluation({ itemId: item.id }),
    resolveCitation: fakeResolveCitation,
    settings: DEFAULT_EVAL_SETTINGS,
    promptHash: () => 'sha256:deadbeef',
    now: () => '2026-07-21T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator fakes, for the baseline-fairness suite
// ---------------------------------------------------------------------------

const RAW_ITEM: RawItem = {
  stem: 'Two fair dice are rolled. Given that the sum is even, what is the probability that both are odd?',
  options: ['1/2', '1/3', '1/4', '3/4'],
  correctKey: 'A',
  authorRationale: 'Of the 18 even-sum outcomes, 9 have both dice odd.',
  discipline: 'probability',
};

const AMBIGUITY_CONTRACT: Ambiguity = {
  interpretation_a: 'Reading A: the conditioning event is the parity of the sum.',
  interpretation_b: 'Reading B: the conditioning event is the parity of the first die.',
  answer_a: '1/2',
  answer_b: '1/3',
  evidence: 'The two readings of the conditioning event yield different answers.',
};

const DISCIPLINE_CONTRACT: Discipline = {
  claim: 'The marked key is right for the intended reading.',
  verdict: 'correct',
  citation: RESOLVING_CITATION,
};

const DISTRACTOR_CONTRACT: DistractorMap = [
  {
    distractor: '3/4',
    hypothesized_error: 'Adding the two conditional probabilities instead of intersecting them.',
    confidence: 0.6,
    evidence: 'The value exceeds every achievable conditional probability here.',
    label: 'evidenced',
  },
];

const PROBE_RESULT: ItemProbeResult = {
  answer_length_flag: false,
  lexical_overlap_flag: false,
  answer_length_ratio: 1,
  lexical_overlap_score: 0.1,
};

interface Recorder {
  fn: ReviewerFn<unknown>;
  calls: Array<{ delimitedItem: string; model: string; signal?: AbortSignal | undefined }>;
}

/** A reviewer that records exactly what it was handed, then resolves/rejects. */
function recorder(behaviour: () => Promise<unknown>): Recorder {
  const calls: Recorder['calls'] = [];
  return {
    calls,
    fn: async (delimitedItem, model, signal) => {
      calls.push({ delimitedItem, model, signal });
      return behaviour();
    },
  };
}

function makeGauntletDeps(overrides: Partial<GauntletDeps> = {}): GauntletDeps {
  return {
    reviewAmbiguity: async () => AMBIGUITY_CONTRACT,
    reviewDiscipline: async () => DISCIPLINE_CONTRACT,
    reviewDistractors: async () => DISTRACTOR_CONTRACT,
    reviewGeneral: async () => ({ defect_type: 'ambiguity', evidence: 'something is off' }),
    runItemProbe: (_input: ProbeInput) => PROBE_RESULT,
    ...overrides,
  };
}

interface BaselineCallerFake {
  call: GeneralReviewerCaller;
  calls: ModelCallArgs<unknown>[];
}

/** A schema-valid, offline model caller that preserves the production call contract. */
function baselineCallerFake(contract: unknown): BaselineCallerFake {
  const calls: ModelCallArgs<unknown>[] = [];
  const call = (async <T>(args: ModelCallArgs<T>): Promise<ModelCallResult<T>> => {
    calls.push(args as ModelCallArgs<unknown>);
    const data = args.schema.parse(contract);
    return {
      data,
      raw: JSON.stringify(contract),
      modelId: args.model,
      modelFamilyOk: true,
      latencyMs: 12,
      tokensIn: 100,
      tokensOut: 40,
      promptVersion: args.promptVersion,
      promptHash: 'sha256:baseline-fake',
      schemaValid: true,
    };
  }) as GeneralReviewerCaller;
  return { call, calls };
}

function outcomeFor(
  outcomes: readonly ReviewerOutcome[],
  reviewerType: OrchestratedReviewer,
): ReviewerOutcome {
  const found = outcomes.find((outcome) => outcome.reviewerType === reviewerType);
  if (found === undefined) {
    throw new Error(`No outcome recorded for reviewer "${reviewerType}"`);
  }
  return found;
}

// ===========================================================================
// ENABLED SUITES — implemented code, must pass today
// ===========================================================================

/**
 * THE ARTIFACT GATE. Compliance-critical and asymmetric: a FALSE REFUSAL costs a
 * re-run, a FALSE ACCEPTANCE costs the submission, because results produced by
 * another model family are not valid evidence for a competition that requires
 * gpt-5.6. So the gate is fail-closed, unbypassable, and — the part that is easy
 * to get wrong — EXHAUSTIVE: it reads the reports themselves, to any depth, not
 * the ambient environment and not just the tidy top-level summary fields.
 */
describe('eval artifact gate — model compliance is read out of the reports, exhaustively', () => {
  it('collects the declared top-level model IDs', () => {
    const ids = collectReportModelIds([makeReport()]);
    expect(new Set(ids)).toEqual(new Set([REVIEWER_MODEL, ADJUDICATOR_MODEL]));
  });

  it('accepts a fully compliant report set', () => {
    expect(() => assertReportsCompliance([makeReport(), makeReport({ runIndex: 2 })])).not.toThrow();
  });

  /**
   * THE FORGERY THIS GATE EXISTS FOR. Compliant surface, non-compliant nested
   * entry — which is the exact shape of a report produced by a proxy or a
   * provider fallback, where the run was CONFIGURED for gpt-5.6 and partly
   * SERVED by something else. Reading `allModelIds` and `modelIds` alone would
   * wave this through with a clean bill of health.
   */
  it('REFUSES a report whose surface is compliant but whose nested raw entry is not', () => {
    const forged = makeReport({
      raw: [
        {
          callSite: 'orchestrator',
          latencyMs: 900,
          // The id the provider actually reported for this call.
          modelId: FORBIDDEN_MODEL,
        },
      ],
    });

    expect(collectReportModelIds([forged])).toContain(FORBIDDEN_MODEL);
    expect(() => assertReportsCompliance([forged])).toThrow(/non-compliant model ID/i);
    expect(() => assertReportsCompliance([forged])).toThrow(new RegExp(FORBIDDEN_MODEL));
  });

  it('REFUSES a non-compliant id buried several levels deep under a model-bearing key', () => {
    const forged = makeReport({
      raw: [
        {
          attempts: [
            { attempt: 1, models: { primary: REVIEWER_MODEL } },
            { attempt: 2, models: { fallback: { resolved: FORBIDDEN_MODEL } } },
          ],
        },
      ],
    });

    expect(() => assertReportsCompliance([forged])).toThrow(/non-compliant model ID/i);
  });

  it('REFUSES an empty report list — an artifact with nothing to attest to is not compliant', () => {
    expect(() => assertReportsCompliance([])).toThrow(/no reports supplied/i);
  });

  /**
   * "No model IDs found" is not the same sentence as "no model was called". An
   * eval run always calls a model, so an empty walk means the gate found nothing
   * to attest to — which must read as a refusal, never as a pass.
   */
  it('REFUSES a report from which no model ID can be recovered at all', () => {
    const stripped = { ...makeReport(), modelIds: undefined, allModelIds: [] } as unknown as EvalReport;
    expect(() => assertReportsCompliance([stripped])).toThrow(/no model IDs found/i);
  });

  it('writeResults refuses the forged report BEFORE touching the filesystem', async () => {
    const forged = makeReport({ raw: [{ modelId: FORBIDDEN_MODEL }] });
    const destination = await mkdtemp(join(tmpdir(), 'forja-eval-refusal-'));
    try {
      expect(await readdir(destination)).toEqual([]);
      await expect(writeResults([forged], destination)).rejects.toThrow(
        /Refusing to write eval results/i,
      );
      expect(await readdir(destination)).toEqual([]);
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });

  /**
   * The complement, and the reason it is worth a test: it proves the gate is
   * ORDERED first and that a compliant set passes THROUGH it into an injected
   * destination, never the directory that holds measured submission results.
   */
  it('writes a compliant report set to the injected destination', async () => {
    const report = makeReport();
    const destination = await mkdtemp(join(tmpdir(), 'forja-eval-write-'));
    try {
      await expect(writeResults([report], destination)).resolves.toBeUndefined();
      const artifactName = '2026-07-21T00-00-00-000Z-gauntlet-run1.json';
      expect((await readdir(destination)).sort()).toEqual([artifactName, 'summary.md']);
      expect(JSON.parse(await readFile(join(destination, artifactName), 'utf8'))).toEqual(report);
      expect(await readFile(join(destination, 'summary.md'), 'utf8')).toContain(
        '| gauntlet | 1 | 11 | 12 | 1 | 7 | 8 |',
      );
      expect(RESULTS_DIR).toBe('eval/results');
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });
});

/**
 * DEV ITEMS DEVELOPED THE PROMPTS. Reporting one as evaluation measures the
 * prompts against their own development material — and it is invisible after the
 * fact, because a leaked item's numbers look exactly like every other item's.
 */
describe('dev/holdout separation (doc §8)', () => {
  it('accepts a holdout set containing only holdout items', () => {
    expect(() => assertSplitPurity('holdout', HOLDOUT_ITEMS)).not.toThrow();
  });

  it('REFUSES a holdout run that contains a dev item, naming the leak', () => {
    expect(() => assertSplitPurity('holdout', [...HOLDOUT_ITEMS, DEV_ITEM])).toThrow(
      /fixture-dev-leak \(dev\)/,
    );
  });

  it('REFUSES the mirror case — a holdout item inside a dev run', () => {
    expect(() => assertSplitPurity('dev', [DEV_ITEM, CLEAN_ITEM])).toThrow(/fixture-clean \(holdout\)/);
  });

  it('every labeled fixture declares a split, so purity is always decidable', () => {
    for (const item of [...HOLDOUT_ITEMS, DEV_ITEM]) {
      expect(['dev', 'holdout']).toContain(item.split);
    }
  });
});

/**
 * The anti-inflation table itself. It is declarative, so it is checked
 * declaratively: every labeled defect type must be attributable, and no type may
 * be attributable to a reviewer that cannot produce that kind of evidence.
 */
describe('defect-type attribution table', () => {
  it('covers all four labeled defect types', () => {
    expect(Object.keys(DEFECT_TYPE_REVIEWERS).sort()).toEqual([
      'ambiguity',
      'cue_leak',
      'factual_error',
      'weak_distractor',
    ]);
  });

  it('names only real reviewer types', () => {
    const legal: ReviewerType[] = ['ambiguity', 'discipline', 'distractor', 'item_probe'];
    for (const reviewers of Object.values(DEFECT_TYPE_REVIEWERS)) {
      for (const reviewer of reviewers) expect(legal).toContain(reviewer);
    }
  });

  /**
   * The specialists are not interchangeable: an ambiguity contract cannot ground
   * a factual error, and a discipline citation is not evidence of a cue leak.
   * Keeping these entries disjoint is what stops a busy reviewer from being
   * credited with a defect it did not find.
   */
  it('does not let a factual error be claimed by the ambiguity or distractor reviewers', () => {
    expect(DEFECT_TYPE_REVIEWERS.factual_error).toEqual(['discipline']);
    expect(DEFECT_TYPE_REVIEWERS.ambiguity).toEqual(['ambiguity']);
  });

  it('lets a cue leak be claimed by the deterministic probe or the distractor reviewer', () => {
    expect([...DEFECT_TYPE_REVIEWERS.cue_leak].sort()).toEqual(['distractor', 'item_probe']);
  });
});

/**
 * Doc §8 requires the 3 runs of a config to use identical model, reasoning,
 * context and budget — and requires the ARTIFACT to prove it. Three runs that
 * each build their own settings object are three runs that can drift.
 */
describe('run settings are a single shared, frozen constant', () => {
  it('is frozen, so no run can mutate the settings the other runs recorded', () => {
    expect(Object.isFrozen(DEFAULT_EVAL_SETTINGS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_EVAL_SETTINGS.budget)).toBe(true);
  });

  it('declares every field doc §8 requires to be comparable', () => {
    expect(DEFAULT_EVAL_SETTINGS).toMatchObject({
      reasoningEffort: expect.any(String),
      contextMode: expect.any(String),
      budget: { maxTokensPerItem: expect.any(Number), maxCallsPerItem: expect.any(Number) },
    });
  });

  it('is the settings object the default dep bundle hands to every run', () => {
    expect(DEFAULT_EVAL_DEPS.settings).toBe(DEFAULT_EVAL_SETTINGS);
  });

  it('defines exactly three configurations and three runs each', () => {
    expect(EVAL_CONFIGS).toEqual(['general-reviewer', 'gauntlet', 'gauntlet-no-adjudication']);
    expect(RUNS_PER_CONFIG).toBe(3);
  });
});

/**
 * BASELINE FAIRNESS (doc §8). Enforceable today: `runGauntlet` is implemented,
 * and it is the component that decides what the baseline is handed and under
 * what budget. The one permitted difference between the arms is specialization —
 * one general call instead of three specialists. Everything else must be equal,
 * or the comparison measures the handicap instead of the method.
 */
describe('single general-reviewer baseline — the comparison must be fair', () => {
  it('runs exactly ONE reviewer, and it is the general one', async () => {
    expect(CONFIG_REVIEWERS['general-reviewer']).toEqual([GENERAL_REVIEWER]);

    const general = recorder(async () => ({ defect_type: 'ambiguity', evidence: 'x' }));
    const ambiguity = recorder(async () => AMBIGUITY_CONTRACT);
    const discipline = recorder(async () => DISCIPLINE_CONTRACT);
    const distractors = recorder(async () => DISTRACTOR_CONTRACT);

    const result = await runGauntlet(
      RAW_ITEM,
      REVIEWER_MODEL,
      'general-reviewer',
      makeGauntletDeps({
        reviewGeneral: general.fn,
        reviewAmbiguity: ambiguity.fn as ReviewerFn<Ambiguity>,
        reviewDiscipline: asDisciplineReviewer(discipline.fn as ReviewerFn<Discipline>),
        reviewDistractors: distractors.fn as ReviewerFn<DistractorMap>,
      }),
    );

    expect(general.calls).toHaveLength(1);
    expect(ambiguity.calls).toHaveLength(0);
    expect(discipline.calls).toHaveLength(0);
    expect(distractors.calls).toHaveLength(0);
    expect(result.expectedReviewers).toEqual([GENERAL_REVIEWER]);
  });

  /**
   * SAME ITEM SERIALIZATION, byte for byte. A baseline shown a shorter stem, an
   * unlabelled option list or a second delimiter wrap is being asked an easier
   * or a harder question than the specialists were.
   */
  it('receives the SAME serialized, singly-delimited item the specialists receive', async () => {
    const general = recorder(async () => ({ defect_type: 'ambiguity', evidence: 'x' }));
    const ambiguity = recorder(async () => AMBIGUITY_CONTRACT);

    await runGauntlet(
      RAW_ITEM,
      REVIEWER_MODEL,
      'general-reviewer',
      makeGauntletDeps({ reviewGeneral: general.fn }),
    );
    await runGauntlet(
      RAW_ITEM,
      REVIEWER_MODEL,
      'gauntlet',
      makeGauntletDeps({ reviewAmbiguity: ambiguity.fn as ReviewerFn<Ambiguity> }),
    );

    const baselineText = general.calls[0]?.delimitedItem;
    const specialistText = ambiguity.calls[0]?.delimitedItem;

    expect(baselineText).toBe(toDelimitedItem(RAW_ITEM));
    expect(baselineText).toBe(specialistText);
  });

  it('receives the SAME model id as the specialists', async () => {
    const general = recorder(async () => ({ defect_type: 'ambiguity', evidence: 'x' }));
    await runGauntlet(
      RAW_ITEM,
      REVIEWER_MODEL,
      'general-reviewer',
      makeGauntletDeps({ reviewGeneral: general.fn }),
    );
    expect(general.calls[0]?.model).toBe(REVIEWER_MODEL);
  });

  /**
   * SAME BUDGET. Declared as an alias of the specialist constant so the two
   * cannot drift; asserted functionally as well, because a shared constant that
   * is never applied to the baseline call would be decoration.
   */
  it('is held to the SAME per-reviewer timeout, and is cancelled by it', async () => {
    expect(GENERAL_REVIEWER_TIMEOUT_MS).toBe(REVIEWER_TIMEOUT_MS);

    const hang: ReviewerFn<unknown> = () => new Promise(() => {});
    const result = await runGauntlet(
      RAW_ITEM,
      REVIEWER_MODEL,
      'general-reviewer',
      makeGauntletDeps({ reviewGeneral: hang, timeoutMs: 20 }),
    );

    const outcome = outcomeFor(result.outcomes, GENERAL_REVIEWER);
    expect(outcome.ok).toBe(false);
    expect(outcome.failureKind).toBe('timeout');
    expect(result.complete).toBe(false);
  });

  it('is given a cancellation signal, exactly like a specialist', async () => {
    const general = recorder(async () => ({ defect_type: 'ambiguity', evidence: 'x' }));
    await runGauntlet(
      RAW_ITEM,
      REVIEWER_MODEL,
      'general-reviewer',
      makeGauntletDeps({ reviewGeneral: general.fn }),
    );
    expect(general.calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  /**
   * SAME SCHEMA DISCIPLINE. A baseline whose malformed output were quietly
   * discarded, or quietly accepted, would not be comparable: the gauntlet's
   * schema-valid percentage is one of the reported numbers.
   */
  it('records a malformed baseline contract as a schema failure, like a specialist', async () => {
    const invalid = async (): Promise<never> => {
      throw new Error('Zod schema validation failed for the baseline contract');
    };

    const baseline = await runGauntlet(
      RAW_ITEM,
      REVIEWER_MODEL,
      'general-reviewer',
      makeGauntletDeps({ reviewGeneral: invalid }),
    );
    const specialist = await runGauntlet(
      RAW_ITEM,
      REVIEWER_MODEL,
      'gauntlet',
      makeGauntletDeps({ reviewAmbiguity: invalid }),
    );

    const baselineOutcome = outcomeFor(baseline.outcomes, GENERAL_REVIEWER);
    const specialistOutcome = outcomeFor(specialist.outcomes, 'ambiguity');

    expect(baselineOutcome.failureKind).toBe(specialistOutcome.failureKind);
    expect(baselineOutcome.failureKind).toBe('schema');
    expect(baselineOutcome.schemaValid).toBe(false);
  });

  it('marks a schema-valid baseline contract exactly as a specialist contract is marked', async () => {
    const result = await runGauntlet(RAW_ITEM, REVIEWER_MODEL, 'general-reviewer', makeGauntletDeps());
    const outcome = outcomeFor(result.outcomes, GENERAL_REVIEWER);
    expect(outcome.ok).toBe(true);
    expect(outcome.schemaValid).toBe(true);
    expect(result.complete).toBe(true);
  });

  /**
   * A FACT THE EVAL MUST NOT MISREAD. The deterministic item_probe runs in BOTH
   * arms — it needs no model call, so it is not part of the specialization being
   * measured. Any cue_leak the probe catches is therefore caught by the baseline
   * too, and crediting it to the gauntlet would overstate the difference between
   * them. Asserted here so the fact is recorded where the comparison is defined.
   */
  it('gets the deterministic item_probe too, so the probe is not part of the measured difference', async () => {
    const baseline = await runGauntlet(RAW_ITEM, REVIEWER_MODEL, 'general-reviewer', makeGauntletDeps());
    const gauntlet = await runGauntlet(RAW_ITEM, REVIEWER_MODEL, 'gauntlet', makeGauntletDeps());

    expect(outcomeFor(baseline.outcomes, 'item_probe').ok).toBe(true);
    expect(outcomeFor(gauntlet.outcomes, 'item_probe').contract).toEqual(
      outcomeFor(baseline.outcomes, 'item_probe').contract,
    );
  });

  it('a dead baseline is DATA, not an exception — one arm never crashes the eval', async () => {
    const dead: ReviewerFn<unknown> = async () => {
      throw new Error('transport exploded');
    };
    const result = await runGauntlet(
      RAW_ITEM,
      REVIEWER_MODEL,
      'general-reviewer',
      makeGauntletDeps({ reviewGeneral: dead }),
    );
    expect(outcomeFor(result.outcomes, GENERAL_REVIEWER).ok).toBe(false);
    expect(result.anySucceeded).toBe(false);
    expect(result.complete).toBe(false);
  });
});

// ===========================================================================
// IMPLEMENTED EVAL RUNNER SUITES
// ===========================================================================

describe('reviewGeneralBaseline', () => {
  it('is wired as the default general reviewer and performs one call with its own contract', async () => {
    const { reviewGeneralBaseline, DEFAULT_GAUNTLET_DEPS } = await import('@/reviewers/orchestrator');
    expect(DEFAULT_GAUNTLET_DEPS.reviewGeneral).toBe(reviewGeneralBaseline);

    const fake = baselineCallerFake({
      defect_type: 'ambiguity',
      evidence: 'The conditioning clause permits two readings.',
    });
    const delimitedItem = toDelimitedItem(RAW_ITEM);
    const contract = await reviewGeneralBaseline(
      delimitedItem,
      REVIEWER_MODEL,
      undefined,
      fake.call,
    );
    expect(contract).toMatchObject({
      defect_type: expect.any(String),
      evidence: expect.any(String),
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      model: REVIEWER_MODEL,
      delimitedItem,
      reviewerType: GENERAL_REVIEWER,
      timeoutMs: GENERAL_REVIEWER_TIMEOUT_MS,
    });
  });

  it('declares a defect_type drawn from the four labeled types, so it can be scored', async () => {
    const { reviewGeneralBaseline } = await import('@/reviewers/orchestrator');
    const fake = baselineCallerFake({
      defect_type: 'factual_error',
      evidence: 'The marked key conflicts with the calculation.',
    });
    const contract = (await reviewGeneralBaseline(
      toDelimitedItem(RAW_ITEM),
      REVIEWER_MODEL,
      undefined,
      fake.call,
    )) as { defect_type: string };
    expect(Object.keys(DEFECT_TYPE_REVIEWERS)).toContain(contract.defect_type);
    expect(fake.calls).toHaveLength(1);
  });
});

/**
 * ATTRIBUTION. The rule that stops a finding of the right shape about the wrong
 * defect from being counted as a detection.
 */
describe('claimedDefectTypes', () => {
  it('attributes a specialist by its reviewer identity', () => {
    expect(claimedDefectTypes(makeCheck({ reviewerType: 'discipline' }))).toEqual(['factual_error']);
    expect(claimedDefectTypes(makeCheck({ reviewerType: 'ambiguity' }))).toEqual(['ambiguity']);
  });

  it('lets the distractor reviewer claim both distractor-family defects', () => {
    const claimed = claimedDefectTypes(makeCheck({ reviewerType: 'distractor' })).sort();
    expect(claimed).toEqual(['cue_leak', 'weak_distractor']);
  });

  it('attributes the deterministic probe to cue leaks only', () => {
    expect(claimedDefectTypes(makeCheck({ reviewerType: 'item_probe' }))).toEqual(['cue_leak']);
  });

  it('attributes the general baseline by the defect_type its contract DECLARES', () => {
    const check = makeCheck({
      reviewerType: GENERAL_REVIEWER,
      contract: { defect_type: 'factual_error', evidence: 'the marked key is wrong' },
    });
    expect(claimedDefectTypes(check)).toEqual(['factual_error']);
  });

  /**
   * The baseline cannot be attributed by identity, so an undeclared or unknown
   * `defect_type` must claim NOTHING. Falling back to "matches whatever was
   * planted" would score the baseline on generosity rather than on detection —
   * the mirror image of handicapping it, and just as dishonest.
   */
  it('claims NOTHING for a baseline finding with a missing or unrecognised defect_type', () => {
    expect(claimedDefectTypes(makeCheck({ reviewerType: GENERAL_REVIEWER, contract: {} }))).toEqual([]);
    expect(
      claimedDefectTypes(
        makeCheck({ reviewerType: GENERAL_REVIEWER, contract: { defect_type: 'vibes' } }),
      ),
    ).toEqual([]);
    expect(
      claimedDefectTypes(makeCheck({ reviewerType: GENERAL_REVIEWER, contract: null })),
    ).toEqual([]);
  });

  it('claims nothing for an unknown reviewer id', () => {
    expect(claimedDefectTypes(makeCheck({ reviewerType: 'astrologer' }))).toEqual([]);
  });
});

describe('isDefectHit / countDefectsFound', () => {
  it('counts an accepted, schema-valid finding of the RIGHT type as a hit', () => {
    const check = makeCheck({ reviewerType: 'ambiguity', status: 'accepted', schemaValid: true });
    expect(isDefectHit(AMBIGUOUS_ITEM, check)).toBe(true);
    expect(countDefectsFound(AMBIGUOUS_ITEM, [check])).toBe(1);
  });

  /**
   * THE HEADLINE-INFLATING MISTAKE. The distractor reviewer filed a perfectly
   * valid, perfectly accepted finding — about weak distractors — on an item
   * whose planted defect is an AMBIGUITY. It found something; it did not find
   * THIS. Counting it would push "found 13 of 16" upward for work that missed
   * the defect entirely.
   */
  it('does NOT count a valid finding about the WRONG defect', () => {
    const wrongDefect = makeCheck({
      reviewerType: 'distractor',
      verificationKind: 'citation',
      checkClass: 'semantic',
      status: 'accepted',
      schemaValid: true,
    });
    expect(isDefectHit(AMBIGUOUS_ITEM, wrongDefect)).toBe(false);
    expect(countDefectsFound(AMBIGUOUS_ITEM, [wrongDefect])).toBe(0);
  });

  /** No valid evidence contract, no detection — 'the model said so' is not evidence. */
  it('does NOT count a finding of the right type whose contract failed validation', () => {
    const invalid = makeCheck({ reviewerType: 'ambiguity', status: 'rejected', schemaValid: false });
    expect(isDefectHit(AMBIGUOUS_ITEM, invalid)).toBe(false);
  });

  it('does NOT count non-accepted statuses, including hypothesis and abstained', () => {
    for (const status of ['proposed', 'rejected', 'abstained', 'hypothesis'] as const) {
      expect(isDefectHit(AMBIGUOUS_ITEM, makeCheck({ reviewerType: 'ambiguity', status }))).toBe(false);
    }
  });

  it('never reports a hit on a clean item — a clean item has nothing to find', () => {
    expect(isDefectHit(CLEAN_ITEM, makeCheck({ status: 'accepted' }))).toBe(false);
    expect(countDefectsFound(CLEAN_ITEM, [makeCheck({ status: 'accepted' })])).toBe(0);
  });

  /**
   * SATURATES AT ONE PER ITEM. `defectsFound` is compared against
   * `defectsPlanted`, which counts one per item; without saturation "found 13 of
   * 16" can print as "found 31 of 16".
   */
  it('counts ONE hit per item even when several reviewers catch the same defect', () => {
    const probe = makeCheck({
      reviewerType: 'item_probe',
      verificationKind: 'heuristic',
      checkClass: 'deterministic',
      status: 'accepted',
    });
    const distractor = makeCheck({
      reviewerType: 'distractor',
      verificationKind: 'citation',
      checkClass: 'semantic',
      status: 'accepted',
    });
    expect(countDefectsFound(CUE_LEAK_ITEM, [probe, distractor])).toBe(1);
  });

  it('credits a cue leak to either the probe or the distractor reviewer alone', () => {
    const probeOnly = makeCheck({
      reviewerType: 'item_probe',
      verificationKind: 'heuristic',
      checkClass: 'deterministic',
      status: 'accepted',
    });
    expect(countDefectsFound(CUE_LEAK_ITEM, [probeOnly])).toBe(1);
  });

  it('credits a baseline hit through its declared defect_type', () => {
    const baselineHit = makeCheck({
      reviewerType: GENERAL_REVIEWER,
      status: 'accepted',
      schemaValid: true,
      contract: { defect_type: 'factual_error', evidence: 'the solver contradicts the key' },
    });
    expect(countDefectsFound(FACTUAL_ITEM, [baselineHit])).toBe(1);
    expect(countDefectsFound(AMBIGUOUS_ITEM, [baselineHit])).toBe(0);
  });

  it('counts zero when the item was passed with no checks at all', () => {
    expect(countDefectsFound(FACTUAL_ITEM, [])).toBe(0);
  });
});

/**
 * FALSE POSITIVES ON CLEAN ITEMS — the number that keeps the eval honest. An
 * eval that reports only detections is marketing. A gauntlet that flags
 * everything would score a perfect detection rate and be useless to a student,
 * and this counter is the only thing in the report that says so.
 */
describe('countFalsePositivesOnClean', () => {
  it('counts ANY accepted, schema-valid finding on a clean item as a false positive', () => {
    expect(countFalsePositivesOnClean(CLEAN_ITEM, [makeCheck({ status: 'accepted' })])).toBe(1);
  });

  it('counts a false positive regardless of WHICH reviewer produced it', () => {
    for (const reviewerType of ['ambiguity', 'discipline', 'distractor', 'item_probe'] as const) {
      expect(
        countFalsePositivesOnClean(CLEAN_ITEM, [makeCheck({ reviewerType, status: 'accepted' })]),
      ).toBe(1);
    }
  });

  it('counts a false positive from the general baseline too', () => {
    const check = makeCheck({
      reviewerType: GENERAL_REVIEWER,
      status: 'accepted',
      contract: { defect_type: 'ambiguity', evidence: 'looks ambiguous to me' },
    });
    expect(countFalsePositivesOnClean(CLEAN_ITEM, [check])).toBe(1);
  });

  /**
   * Does NOT saturate. Two bogus accepted findings on one clean item are two
   * false alarms, and the student pays for each one separately by having to
   * answer it.
   */
  it('counts every accepted finding, not one per item', () => {
    const checks = [
      makeCheck({ reviewerType: 'ambiguity', status: 'accepted' }),
      makeCheck({ reviewerType: 'distractor', status: 'accepted' }),
    ];
    expect(countFalsePositivesOnClean(CLEAN_ITEM, checks)).toBe(2);
  });

  /** Rejecting and abstaining are the system working, not false alarms. */
  it('does NOT count rejected, abstained, hypothesis or proposed findings', () => {
    for (const status of ['proposed', 'rejected', 'abstained', 'hypothesis'] as const) {
      expect(countFalsePositivesOnClean(CLEAN_ITEM, [makeCheck({ status })])).toBe(0);
    }
  });

  it('does not count schema-invalid findings — an unparseable claim was never accepted', () => {
    expect(
      countFalsePositivesOnClean(CLEAN_ITEM, [makeCheck({ status: 'accepted', schemaValid: false })]),
    ).toBe(0);
  });

  it('returns 0 for a non-clean item — findings there are scored as detections', () => {
    expect(countFalsePositivesOnClean(AMBIGUOUS_ITEM, [makeCheck({ status: 'accepted' })])).toBe(0);
  });
});

describe('percentile', () => {
  const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

  it('computes nearest-rank p50 and p95', () => {
    expect(percentile(samples, 0.5)).toBe(50);
    expect(percentile(samples, 0.95)).toBe(100);
  });

  it('is order-independent — it sorts its input', () => {
    expect(percentile([...samples].reverse(), 0.5)).toBe(50);
  });

  it('returns 0 for an empty sample set instead of NaN', () => {
    expect(percentile([], 0.5)).toBe(0);
  });

  it('handles a single sample', () => {
    expect(percentile([7], 0.5)).toBe(7);
    expect(percentile([7], 0.95)).toBe(7);
  });

  it('is deterministic, so two reports of the same run agree byte for byte', () => {
    expect(percentile(samples, 0.95)).toBe(percentile(samples, 0.95));
  });
});

/**
 * CITATION PRECISION. Of the citations emitted, how many actually land in the
 * licensed corpus with a matching excerpt. A citation that does not resolve
 * counts AGAINST precision — never dropped from the denominator, because that
 * would turn a fabricated source into a free pass.
 */
describe('tallyCounts — citation precision', () => {
  it('counts a resolving citation with a matching excerpt as precise', () => {
    const counts = tallyCounts(
      [FACTUAL_ITEM],
      [makeEvaluation({ itemId: FACTUAL_ITEM.id, citations: [RESOLVING_CITATION] })],
      fakeResolveCitation,
    );
    expect(counts.citationsChecked).toBe(1);
    expect(counts.citationsPrecise).toBe(1);
  });

  it('counts a FABRICATED citation against precision, and keeps it in the denominator', () => {
    const counts = tallyCounts(
      [FACTUAL_ITEM],
      [makeEvaluation({ itemId: FACTUAL_ITEM.id, citations: [FABRICATED_CITATION] })],
      fakeResolveCitation,
    );
    expect(counts.citationsChecked).toBe(1);
    expect(counts.citationsPrecise).toBe(0);
  });

  /** Right document, invented quotation: resolving is not the same as matching. */
  it('counts a citation that resolves but whose excerpt does not match as imprecise', () => {
    const misquoted: Citation = { ...RESOLVING_CITATION, excerpt: 'A sentence never written.' };
    const counts = tallyCounts(
      [FACTUAL_ITEM],
      [makeEvaluation({ itemId: FACTUAL_ITEM.id, citations: [misquoted] })],
      fakeResolveCitation,
    );
    expect(counts.citationsChecked).toBe(1);
    expect(counts.citationsPrecise).toBe(0);
  });

  it('asks the resolver about every emitted citation exactly once', () => {
    const resolver = vi.fn(fakeResolveCitation);
    tallyCounts(
      [FACTUAL_ITEM],
      [
        makeEvaluation({
          itemId: FACTUAL_ITEM.id,
          citations: [RESOLVING_CITATION, FABRICATED_CITATION],
        }),
      ],
      resolver,
    );
    expect(resolver).toHaveBeenCalledTimes(2);
  });
});

describe('tallyCounts — exact counts', () => {
  /**
   * The full mini-set, hand-computed. 3 planted defects, 2 of them found, and 1
   * false positive on the clean item. These are EXACT COUNTS, which is what the
   * report prints: "found 2 of 3", never "66.7%".
   */
  const evaluations: ItemEvaluation[] = [
    makeEvaluation({
      itemId: AMBIGUOUS_ITEM.id,
      checks: [makeCheck({ reviewerType: 'ambiguity', status: 'accepted' })],
      latencyMs: 1_000,
      costUsd: 0.02,
      schemaValid: 3,
      schemaTotal: 3,
    }),
    makeEvaluation({
      itemId: FACTUAL_ITEM.id,
      checks: [
        makeCheck({
          reviewerType: 'discipline',
          verificationKind: 'solver',
          checkClass: 'deterministic',
          status: 'accepted',
        }),
      ],
      citations: [RESOLVING_CITATION],
      latencyMs: 2_000,
      costUsd: 0.04,
      schemaValid: 3,
      schemaTotal: 3,
    }),
    // Missed: the only finding is about the wrong defect.
    makeEvaluation({
      itemId: CUE_LEAK_ITEM.id,
      checks: [
        makeCheck({
          reviewerType: 'discipline',
          verificationKind: 'citation',
          checkClass: 'semantic',
          status: 'accepted',
        }),
      ],
      citations: [FABRICATED_CITATION],
      latencyMs: 3_000,
      costUsd: 0.03,
      schemaValid: 2,
      schemaTotal: 3,
    }),
    // Clean item that was flagged anyway: one false positive.
    makeEvaluation({
      itemId: CLEAN_ITEM.id,
      checks: [makeCheck({ reviewerType: 'ambiguity', status: 'accepted' })],
      latencyMs: 4_000,
      costUsd: 0.03,
      schemaValid: 3,
      schemaTotal: 3,
    }),
  ];

  it('produces the exact hand-computed counts', () => {
    const counts = tallyCounts(HOLDOUT_ITEMS, evaluations, fakeResolveCitation);
    expect(counts).toEqual({
      itemsEvaluated: 4,
      defectsPlanted: 3,
      defectsFound: 2,
      falsePositivesOnClean: 1,
      citationsChecked: 2,
      citationsPrecise: 1,
      schemaValid: 11,
      schemaTotal: 12,
    });
  });

  it('never reports more defects found than planted', () => {
    const counts = tallyCounts(HOLDOUT_ITEMS, evaluations, fakeResolveCitation);
    expect(counts.defectsFound).toBeLessThanOrEqual(counts.defectsPlanted);
    expect(counts.citationsPrecise).toBeLessThanOrEqual(counts.citationsChecked);
    expect(counts.schemaValid).toBeLessThanOrEqual(counts.schemaTotal);
  });

  /**
   * FAIL CLOSED ON A MISMATCH. Silently skipping an unmatched evaluation, or an
   * item with no evaluation, makes the denominator disagree with the set the
   * report claims to cover — and "found 13 of 16" stops meaning what it says.
   */
  it('THROWS when an evaluation names an item that is not in the set', () => {
    expect(() =>
      tallyCounts(
        HOLDOUT_ITEMS,
        [...evaluations, makeEvaluation({ itemId: 'not-in-the-set' })],
        fakeResolveCitation,
      ),
    ).toThrow(/not-in-the-set/);
  });

  it('THROWS when an item in the set has no evaluation', () => {
    expect(() =>
      tallyCounts(HOLDOUT_ITEMS, evaluations.slice(0, 3), fakeResolveCitation),
    ).toThrow(/fixture-clean/);
  });

  it('counts an item with zero checks as evaluated, not as skipped', () => {
    const counts = tallyCounts(
      [CLEAN_ITEM],
      [makeEvaluation({ itemId: CLEAN_ITEM.id })],
      fakeResolveCitation,
    );
    expect(counts.itemsEvaluated).toBe(1);
    expect(counts.defectsPlanted).toBe(0);
    expect(counts.falsePositivesOnClean).toBe(0);
  });
});

describe('runConfig', () => {
  it('returns a report carrying the exact counts for the canned results', async () => {
    const report = await runConfig('gauntlet', 1, 'holdout', makeEvalDeps());
    expect(report.config).toBe('gauntlet');
    expect(report.runIndex).toBe(1);
    expect(report.split).toBe('holdout');
    expect(report.counts.itemsEvaluated).toBe(HOLDOUT_ITEMS.length);
    expect(report.counts.defectsPlanted).toBe(3);
  });

  it('feeds every loaded item through evaluateItem exactly once, with the config and run index', async () => {
    const evaluateItem = vi.fn<EvalRunnerDeps['evaluateItem']>(async (item) =>
      makeEvaluation({ itemId: item.id }),
    );
    await runConfig('gauntlet-no-adjudication', 2, 'holdout', makeEvalDeps({ evaluateItem }));

    expect(evaluateItem).toHaveBeenCalledTimes(HOLDOUT_ITEMS.length);
    for (const call of evaluateItem.mock.calls) {
      expect(call[1]).toBe('gauntlet-no-adjudication');
      expect(call[2]).toBe(2);
    }
  });

  /**
   * THE LEAK THAT MUST BE IMPOSSIBLE. A loader that hands back a dev item for a
   * holdout run is exactly how prompt-development material ends up reported as
   * evaluation. `runConfig` must refuse the run rather than score it.
   */
  it('REFUSES to score a holdout run whose loader returned a dev item', async () => {
    const deps = makeEvalDeps({ loadSmokeItems: async () => [...HOLDOUT_ITEMS, DEV_ITEM] });
    await expect(runConfig('gauntlet', 1, 'holdout', deps)).rejects.toThrow(/fixture-dev-leak/);
  });

  it('refuses BEFORE evaluating anything, so a leaked run produces no partial numbers', async () => {
    const evaluateItem = vi.fn(async (item: SmokeItem) => makeEvaluation({ itemId: item.id }));
    const deps = makeEvalDeps({
      loadSmokeItems: async () => [...HOLDOUT_ITEMS, DEV_ITEM],
      evaluateItem,
    });
    await expect(runConfig('gauntlet', 1, 'holdout', deps)).rejects.toThrow();
    expect(evaluateItem).not.toHaveBeenCalled();
  });

  it('records the settings VERBATIM, so the artifact proves the runs were comparable', async () => {
    const report = await runConfig('gauntlet', 1, 'holdout', makeEvalDeps());
    expect(report.settings).toEqual(DEFAULT_EVAL_SETTINGS);
  });

  /** Doc §8: 3 runs per config, identical model, reasoning, context and budget. */
  it('records IDENTICAL settings and prompt hash across all three runs of a config', async () => {
    const deps = makeEvalDeps();
    const runs: EvalReport[] = [];
    for (const runIndex of [1, 2, 3] as RunIndex[]) {
      runs.push(await runConfig('gauntlet', runIndex, 'holdout', deps));
    }

    expect(runs).toHaveLength(RUNS_PER_CONFIG);
    const first = runs[0]!;
    for (const run of runs.slice(1)) {
      expect(run.settings).toEqual(first.settings);
      expect(run.promptHash).toBe(first.promptHash);
      expect(run.modelIds).toEqual(first.modelIds);
    }
    expect(runs.map((run) => run.runIndex)).toEqual([1, 2, 3]);
  });

  it('produces a comparable report for each of the three configurations', async () => {
    const deps = makeEvalDeps();
    const reports = await Promise.all(
      EVAL_CONFIGS.map((config: EvalConfig) => runConfig(config, 1, 'holdout', deps)),
    );
    expect(reports.map((report) => report.config)).toEqual([...EVAL_CONFIGS]);
    for (const report of reports) {
      expect(report.settings).toEqual(DEFAULT_EVAL_SETTINGS);
      expect(report.counts.itemsEvaluated).toBe(HOLDOUT_ITEMS.length);
    }
  });

  /** Only 'gauntlet' adjudicates, so only 'gauntlet' may record an adjudicator. */
  it('records a null adjudicator for the two configs that never adjudicate', async () => {
    const deps = makeEvalDeps();
    for (const config of ['general-reviewer', 'gauntlet-no-adjudication'] as const) {
      const report = await runConfig(config, 1, 'holdout', deps);
      expect(report.modelIds.adjudicator).toBeNull();
    }
    const gauntlet = await runConfig('gauntlet', 1, 'holdout', deps);
    expect(gauntlet.modelIds.adjudicator).not.toBeNull();
  });

  /**
   * allModelIds is what the artifact gate walks, so it has to carry the WHOLE
   * truth: every id that served a call, deduplicated, including ids that only
   * ever appear on a per-item evaluation.
   */
  it('unions every per-item model id into allModelIds, deduplicated', async () => {
    const deps = makeEvalDeps({
      evaluateItem: async (item) =>
        makeEvaluation({ itemId: item.id, modelIds: [REVIEWER_MODEL, ADJUDICATOR_MODEL] }),
    });
    const report = await runConfig('gauntlet', 1, 'holdout', deps);
    expect([...report.allModelIds].sort()).toEqual([ADJUDICATOR_MODEL, REVIEWER_MODEL].sort());
  });

  it('reports p50/p95 latency and mean cost per item from the canned samples', async () => {
    const latencies = [1_000, 2_000, 3_000, 4_000];
    const deps = makeEvalDeps({
      evaluateItem: async (item) => {
        const index = HOLDOUT_ITEMS.findIndex((candidate) => candidate.id === item.id);
        return makeEvaluation({
          itemId: item.id,
          latencyMs: latencies[index] ?? 0,
          costUsd: 0.02,
        });
      },
    });
    const report = await runConfig('gauntlet', 1, 'holdout', deps);
    expect(report.latencyMs.p50).toBe(2_000);
    expect(report.latencyMs.p95).toBe(4_000);
    expect(report.costUsdPerItem).toBeCloseTo(0.02, 10);
  });

  it('stamps the injected clock and prompt hash onto the report', async () => {
    const report = await runConfig('gauntlet', 1, 'holdout', makeEvalDeps());
    expect(report.timestamp).toBe('2026-07-21T00:00:00.000Z');
    expect(report.promptHash).toBe('sha256:deadbeef');
  });

  /**
   * The report is the artifact, so it must survive its own gate. A run whose
   * output cannot be written is a run that produced nothing.
   */
  it('produces a report that passes the artifact compliance gate', async () => {
    const report = await runConfig('gauntlet', 1, 'holdout', makeEvalDeps());
    expect(() => assertReportsCompliance([report])).not.toThrow();
  });

  /** The eval calls models; the runtime gate must fire on the id being dispatched. */
  it('refuses to run against a non-compliant reviewer model', async () => {
    const deps = makeEvalDeps({
      evaluateItem: async (item) =>
        makeEvaluation({ itemId: item.id, modelIds: [FORBIDDEN_MODEL] }),
    });
    const report = await runConfig('gauntlet', 1, 'holdout', deps);
    expect(() => assertReportsCompliance([report])).toThrow(/non-compliant model ID/i);
  });
});

describe('DEFAULT_EVAL_DEPS', () => {
  it('loads and validates the labeled smoke items off disk', async () => {
    const holdout = await DEFAULT_EVAL_DEPS.loadSmokeItems('holdout');
    expect(holdout).toHaveLength(14);
    for (const item of holdout) {
      expect(item.split).toBe('holdout');
      expect(SmokeItemSchema.safeParse(item).success).toBe(true);
    }
  });

  it('keeps the two splits disjoint', async () => {
    const dev = await DEFAULT_EVAL_DEPS.loadSmokeItems('dev');
    const holdout = await DEFAULT_EVAL_DEPS.loadSmokeItems('holdout');
    const devIds = new Set(dev.map((item) => item.id));
    for (const item of holdout) expect(devIds.has(item.id)).toBe(false);
  });

  it('resolves a citation that exists in the licensed corpus', () => {
    const resolution = DEFAULT_EVAL_DEPS.resolveCitation(RESOLVING_CITATION);
    expect(resolution.resolved).toBe(true);
  });

  it('does not resolve a fabricated source, and never invents one', () => {
    expect(DEFAULT_EVAL_DEPS.resolveCitation(FABRICATED_CITATION)).toEqual({
      resolved: false,
      excerptMatches: false,
    });
  });

  it('produces a stable prompt hash', () => {
    expect(DEFAULT_EVAL_DEPS.promptHash()).toBe(DEFAULT_EVAL_DEPS.promptHash());
  });
});

/** Type-level pin: the defect types the scoring speaks about are the labeled ones. */
const _defectTypes: IntendedDefectType[] = [
  'ambiguity',
  'factual_error',
  'cue_leak',
  'weak_distractor',
];
void _defectTypes;
