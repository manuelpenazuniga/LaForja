/**
 * LA FORJA — GPT-5.6 compliance guard (src/config/models.ts).
 *
 * OWNER: Claude. This suite is the executable form of the hackathon's
 * non-negotiable model rule: the runtime uses ONLY OpenAI gpt-5.6 models, model
 * IDs are never hardcoded in source, and the eval runner REFUSES to write
 * results produced by a non-compliant family (doc §8).
 *
 * These tests must genuinely pass — they are the gate that keeps invalid
 * evidence out of eval/results/.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ALLOWED_MODEL_IDS,
  REQUIRED_MODEL_FAMILY,
  assertEvalCompliance,
  assertRuntimeCompliance,
  evaluateModels,
  isCompliantModel,
  loadModelConfig,
  type ModelConfig,
} from '@/config/models';
import { assertReportsCompliance, collectReportModelIds } from '@/eval/run';
import type { EvalReport } from '@/eval/types';

const COMPLIANT_REVIEWER = 'gpt-5.6-terra';
const COMPLIANT_ADJUDICATOR = 'gpt-5.6-sol';

describe('REQUIRED_MODEL_FAMILY', () => {
  it('is the gpt-5.6 family', () => {
    expect(REQUIRED_MODEL_FAMILY).toBe('gpt-5.6');
  });
});

describe('ALLOWED_MODEL_IDS', () => {
  it('is the exact, closed set this submission permits', () => {
    expect([...ALLOWED_MODEL_IDS]).toEqual(['gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-sol']);
  });

  it('contains the two default IDs, so a bare checkout is compliant', () => {
    expect([...ALLOWED_MODEL_IDS]).toContain(COMPLIANT_REVIEWER);
    expect([...ALLOWED_MODEL_IDS]).toContain(COMPLIANT_ADJUDICATOR);
  });

  it('is the single source of truth: every entry passes isCompliantModel', () => {
    for (const id of ALLOWED_MODEL_IDS) {
      expect(isCompliantModel(id)).toBe(true);
    }
  });
});

describe('isCompliantModel', () => {
  it('accepts the two default gpt-5.6 model IDs', () => {
    expect(isCompliantModel(COMPLIANT_REVIEWER)).toBe(true);
    expect(isCompliantModel(COMPLIANT_ADJUDICATOR)).toBe(true);
  });

  it('accepts the bare family alias', () => {
    expect(isCompliantModel(REQUIRED_MODEL_FAMILY)).toBe(true);
  });

  it('rejects an older OpenAI family', () => {
    expect(isCompliantModel('gpt-4o')).toBe(false);
    expect(isCompliantModel('gpt-4o-mini')).toBe(false);
  });

  it('rejects a near-miss family', () => {
    expect(isCompliantModel('gpt-5.5-x')).toBe(false);
    expect(isCompliantModel('gpt-5-terra')).toBe(false);
  });

  it('rejects any non-OpenAI model ID', () => {
    expect(isCompliantModel('claude-anything')).toBe(false);
    expect(isCompliantModel('llama-3-70b')).toBe(false);
  });

  it('rejects an empty-ish ID', () => {
    expect(isCompliantModel('')).toBe(false);
    expect(isCompliantModel('   ')).toBe(false);
  });

  it('rejects an ID that merely CONTAINS the family without starting with it', () => {
    // A proxy/vendor prefix must not smuggle a non-OpenAI route past the guard.
    expect(isCompliantModel('openrouter/gpt-5.6-terra')).toBe(false);
    expect(isCompliantModel('vendor:gpt-5.6-sol')).toBe(false);
    expect(isCompliantModel(' gpt-5.6-terra')).toBe(false);
  });

  it('rejects a DIFFERENT family that merely starts with the same characters', () => {
    // The old prefix guard accepted these. "gpt-5.60" is not "gpt-5.6": a
    // future family would have been silently admitted as compliant evidence.
    expect(isCompliantModel('gpt-5.60')).toBe(false);
    expect(isCompliantModel('gpt-5.61-turbo')).toBe(false);
  });

  it('rejects an arbitrary suffix on the family alias', () => {
    // The core reason the allowlist is exact-match: any suffix could route to
    // something that is not a gpt-5.6 model at all.
    expect(isCompliantModel('gpt-5.6whatever')).toBe(false);
    expect(isCompliantModel('gpt-5.6-evil-actually-something-else')).toBe(false);
    expect(isCompliantModel('gpt-5.6-terra-but-not-really')).toBe(false);
  });

  it('rejects an unknown variant even inside the real family', () => {
    // Fail-closed: a plausible-looking sibling is still not on the allowlist.
    expect(isCompliantModel('gpt-5.6-luna')).toBe(false);
    expect(isCompliantModel('gpt-5.6-mini')).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(isCompliantModel('GPT-5.6-TERRA')).toBe(false);
  });
});

describe('assertRuntimeCompliance', () => {
  it('permits every allowlisted model ID', () => {
    for (const id of ALLOWED_MODEL_IDS) {
      expect(() => assertRuntimeCompliance(id)).not.toThrow();
    }
  });

  it('throws at the model-call boundary for a non-allowlisted ID, naming it', () => {
    expect(() => assertRuntimeCompliance('gpt-4o')).toThrow(/gpt-4o/);
    expect(() => assertRuntimeCompliance('claude-anything')).toThrow(/claude-anything/);
  });

  it('throws for the spoofing IDs the old prefix guard accepted', () => {
    expect(() => assertRuntimeCompliance('gpt-5.60')).toThrow();
    expect(() => assertRuntimeCompliance('gpt-5.6whatever')).toThrow();
    expect(() => assertRuntimeCompliance('gpt-5.6-evil-actually-something-else')).toThrow();
  });

  it('throws for an empty ID rather than treating it as "unset"', () => {
    expect(() => assertRuntimeCompliance('')).toThrow();
  });

  it('lists the allowed IDs in the error, so the fix is obvious', () => {
    expect(() => assertRuntimeCompliance('gpt-4o')).toThrow(/gpt-5\.6-terra/);
  });
});

describe('evaluateModels', () => {
  it('reports compliance with no offenders for a compliant pair', () => {
    const cfg = evaluateModels({
      REVIEWER_MODEL: COMPLIANT_REVIEWER,
      ADJUDICATOR_MODEL: COMPLIANT_ADJUDICATOR,
    });
    expect(cfg.compliance).toBe(true);
    expect(cfg.offending).toEqual([]);
    expect(cfg.reviewerModel).toBe(COMPLIANT_REVIEWER);
    expect(cfg.adjudicatorModel).toBe(COMPLIANT_ADJUDICATOR);
  });

  it('flags a single non-compliant reviewer model and lists exactly that ID', () => {
    const cfg = evaluateModels({
      REVIEWER_MODEL: 'gpt-4o',
      ADJUDICATOR_MODEL: COMPLIANT_ADJUDICATOR,
    });
    expect(cfg.compliance).toBe(false);
    expect(cfg.offending).toEqual(['gpt-4o']);
  });

  it('flags a single non-compliant adjudicator model and lists exactly that ID', () => {
    const cfg = evaluateModels({
      REVIEWER_MODEL: COMPLIANT_REVIEWER,
      ADJUDICATOR_MODEL: 'claude-anything',
    });
    expect(cfg.compliance).toBe(false);
    expect(cfg.offending).toEqual(['claude-anything']);
  });

  it('lists both IDs when both are non-compliant', () => {
    const cfg = evaluateModels({
      REVIEWER_MODEL: 'gpt-5.5-x',
      ADJUDICATOR_MODEL: 'gpt-4o',
    });
    expect(cfg.compliance).toBe(false);
    expect(cfg.offending).toEqual(['gpt-5.5-x', 'gpt-4o']);
  });

  it('falls back to the compliant defaults when the env is missing', () => {
    const cfg = evaluateModels({});
    expect(cfg.reviewerModel).toBe(COMPLIANT_REVIEWER);
    expect(cfg.adjudicatorModel).toBe(COMPLIANT_ADJUDICATOR);
    expect(cfg.compliance).toBe(true);
    expect(cfg.offending).toEqual([]);
  });

  it('falls back per-variable when only one is set', () => {
    const cfg = evaluateModels({ REVIEWER_MODEL: 'gpt-4o' });
    expect(cfg.adjudicatorModel).toBe(COMPLIANT_ADJUDICATOR);
    expect(cfg.offending).toEqual(['gpt-4o']);
  });

  it('rejects an explicitly empty model ID instead of silently defaulting', () => {
    expect(() => evaluateModels({ REVIEWER_MODEL: '' })).toThrow();
  });
});

describe('loadModelConfig', () => {
  it('warns exactly once when the configured models are not gpt-5.6', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const cfg = loadModelConfig({
        REVIEWER_MODEL: 'gpt-4o',
        ADJUDICATOR_MODEL: COMPLIANT_ADJUDICATOR,
      });
      expect(cfg.compliance).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0] ?? '');
      expect(message).toContain('gpt-4o');
      expect(message).toContain(REQUIRED_MODEL_FAMILY);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn when the configured models are compliant', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const cfg = loadModelConfig({
        REVIEWER_MODEL: COMPLIANT_REVIEWER,
        ADJUDICATOR_MODEL: COMPLIANT_ADJUDICATOR,
      });
      expect(cfg.compliance).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('does NOT throw on a non-compliant config, so local dev still boots', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(() =>
        loadModelConfig({
          REVIEWER_MODEL: 'claude-anything',
          ADJUDICATOR_MODEL: 'gpt-4o',
        }),
      ).not.toThrow();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('assertEvalCompliance', () => {
  it('throws for a non-compliant config, naming the offending model', () => {
    const cfg = evaluateModels({
      REVIEWER_MODEL: 'gpt-4o',
      ADJUDICATOR_MODEL: COMPLIANT_ADJUDICATOR,
    });
    expect(() => assertEvalCompliance(cfg)).toThrow(/gpt-4o/);
    expect(() => assertEvalCompliance(cfg)).toThrow(new RegExp(REQUIRED_MODEL_FAMILY));
  });

  it('throws when both models are non-compliant', () => {
    const cfg = evaluateModels({
      REVIEWER_MODEL: 'gpt-5.5-x',
      ADJUDICATOR_MODEL: 'claude-anything',
    });
    expect(() => assertEvalCompliance(cfg)).toThrow(/gpt-5\.5-x/);
    expect(() => assertEvalCompliance(cfg)).toThrow(/claude-anything/);
  });

  it('does not throw for a compliant config', () => {
    const cfg = evaluateModels({
      REVIEWER_MODEL: COMPLIANT_REVIEWER,
      ADJUDICATOR_MODEL: COMPLIANT_ADJUDICATOR,
    });
    expect(() => assertEvalCompliance(cfg)).not.toThrow();
  });

  it('does not throw for the default (unset env) config', () => {
    expect(() => assertEvalCompliance(evaluateModels({}))).not.toThrow();
  });

  // The gate must derive compliance from the model IDs themselves. A ModelConfig
  // is a plain object: anything that can construct one can claim compliance.
  describe('recomputes compliance instead of trusting the flag', () => {
    it('throws for a FORGED config claiming compliance:true with GPT-4 IDs', () => {
      const forged: ModelConfig = {
        reviewerModel: 'gpt-4o',
        adjudicatorModel: 'gpt-4-turbo',
        compliance: true, // the lie
        offending: [], // the lie, corroborated
      };
      expect(() => assertEvalCompliance(forged)).toThrow(/gpt-4o/);
      expect(() => assertEvalCompliance(forged)).toThrow(/gpt-4-turbo/);
    });

    it('throws when only ONE forged ID is non-compliant', () => {
      const forged: ModelConfig = {
        reviewerModel: COMPLIANT_REVIEWER,
        adjudicatorModel: 'claude-anything',
        compliance: true,
        offending: [],
      };
      expect(() => assertEvalCompliance(forged)).toThrow(/claude-anything/);
    });

    it('throws for a forged config using a prefix-spoofed ID', () => {
      const forged: ModelConfig = {
        reviewerModel: 'gpt-5.6-evil-actually-something-else',
        adjudicatorModel: COMPLIANT_ADJUDICATOR,
        compliance: true,
        offending: [],
      };
      expect(() => assertEvalCompliance(forged)).toThrow(/evil-actually-something-else/);
    });

    it('reports the ACTUAL offenders, not the (empty) offending list it was handed', () => {
      const forged: ModelConfig = {
        reviewerModel: 'gpt-4o',
        adjudicatorModel: COMPLIANT_ADJUDICATOR,
        compliance: true,
        offending: ['some-unrelated-model'],
      };
      expect(() => assertEvalCompliance(forged)).toThrow(/gpt-4o/);
      expect(() => assertEvalCompliance(forged)).not.toThrow(/some-unrelated-model/);
    });

    it('passes a genuinely compliant pair even when the flag says otherwise', () => {
      // Recomputation cuts both ways: the IDs are the truth, in both directions.
      const mislabeled: ModelConfig = {
        reviewerModel: COMPLIANT_REVIEWER,
        adjudicatorModel: COMPLIANT_ADJUDICATOR,
        compliance: false,
        offending: [COMPLIANT_REVIEWER],
      };
      expect(() => assertEvalCompliance(mislabeled)).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// The eval-ARTIFACT gate (src/eval/run.ts). Same rule, different boundary: no
// result file may be written unless every model ID the report carries is
// allowlisted. The reports are the evidence, so the whole report is the surface.
// ---------------------------------------------------------------------------

/** A minimally valid, fully compliant report. Overrides forge specific fields. */
function report(overrides: Partial<EvalReport> = {}): EvalReport {
  return {
    config: 'gauntlet',
    runIndex: 1,
    modelIds: { reviewer: COMPLIANT_REVIEWER, adjudicator: COMPLIANT_ADJUDICATOR },
    allModelIds: [COMPLIANT_REVIEWER, COMPLIANT_ADJUDICATOR],
    settings: {
      reasoningEffort: 'medium',
      contextMode: 'item-only',
      budget: { maxTokensPerItem: 8000, maxCallsPerItem: 4 },
    },
    promptHash: 'deadbeefdeadbeef',
    timestamp: '2026-01-01T00:00:00.000Z',
    split: 'holdout',
    counts: {
      itemsEvaluated: 16,
      defectsPlanted: 12,
      defectsFound: 11,
      falsePositivesOnClean: 1,
      citationsChecked: 9,
      citationsPrecise: 8,
      schemaValid: 48,
      schemaTotal: 48,
    },
    latencyMs: { p50: 1200, p95: 3400 },
    costUsdPerItem: 0.014,
    raw: [],
    ...overrides,
  };
}

/** One recorded per-call result, shaped like a `ModelCallResult` entry in `raw`. */
function rawCall(modelId: string): Record<string, unknown> {
  return {
    data: { verdict: 'ok' },
    raw: '{"verdict":"ok"}',
    modelId,
    modelFamilyOk: isCompliantModel(modelId),
    latencyMs: 900,
    promptVersion: 'ambiguity-v1',
    promptHash: 'deadbeefdeadbeef',
    schemaValid: true,
  };
}

describe('collectReportModelIds', () => {
  it('collects the declared top-level IDs', () => {
    const ids = collectReportModelIds([report()]);
    expect(ids).toContain(COMPLIANT_REVIEWER);
    expect(ids).toContain(COMPLIANT_ADJUDICATOR);
  });

  it('collects IDs from the nested raw per-call entries', () => {
    // REGRESSION (D3): `raw` holds the ModelCallResult entries — the record of
    // what ACTUALLY served each call — and the gate never looked at it.
    const ids = collectReportModelIds([report({ raw: [rawCall('gpt-4o'), rawCall('llama-3-70b')] })]);
    expect(ids).toContain('gpt-4o');
    expect(ids).toContain('llama-3-70b');
  });

  it('recurses to arbitrary depth, not just one level into raw', () => {
    const ids = collectReportModelIds([
      report({ raw: [{ attempts: [{ retries: [{ nested: rawCall('gpt-4o') }] }] }] }),
    ]);
    expect(ids).toContain('gpt-4o');
  });

  it('collects from any model-bearing key, including ones this codebase has not defined', () => {
    // Over-collect on purpose: a false refusal costs a re-run, a false
    // acceptance costs the submission. The walk must not need updating when a
    // new field appears.
    const ids = collectReportModelIds([
      report({ raw: [{ fallbackModel: 'gpt-4o', model_name: 'claude-anything' }] }),
    ]);
    expect(ids).toContain('gpt-4o');
    expect(ids).toContain('claude-anything');
  });

  it('collects model IDs nested inside an object under a model key', () => {
    const ids = collectReportModelIds([
      report({ raw: [{ modelRouting: { primary: 'gpt-4o', fallback: 'gpt-4o-mini' } }] }),
    ]);
    expect(ids).toContain('gpt-4o');
    expect(ids).toContain('gpt-4o-mini');
  });

  it('deduplicates', () => {
    const ids = collectReportModelIds([report({ raw: [rawCall(COMPLIANT_REVIEWER)] })]);
    expect(ids.filter((id) => id === COMPLIANT_REVIEWER)).toHaveLength(1);
  });

  it('unions across every report supplied', () => {
    const ids = collectReportModelIds([
      report(),
      report({ runIndex: 2, raw: [rawCall('gpt-4o')] }),
    ]);
    expect(ids).toContain(COMPLIANT_REVIEWER);
    expect(ids).toContain('gpt-4o');
  });

  it('terminates on a self-referential report instead of recursing forever', () => {
    const cyclic: Record<string, unknown> = { modelId: 'gpt-4o' };
    cyclic['self'] = cyclic;
    const ids = collectReportModelIds([report({ raw: [cyclic] })]);
    expect(ids).toContain('gpt-4o');
  });

  it('ignores non-string values under model-bearing keys', () => {
    // `modelFamilyOk` is a boolean, `modelCallCount` a number: neither is an ID.
    const ids = collectReportModelIds([
      report({ raw: [{ modelFamilyOk: false, modelCallCount: 3 }] }),
    ]);
    expect(ids).toEqual([COMPLIANT_REVIEWER, COMPLIANT_ADJUDICATOR]);
  });
});

describe('assertReportsCompliance', () => {
  it('accepts a wholly compliant report', () => {
    expect(() =>
      assertReportsCompliance([report({ raw: [rawCall(COMPLIANT_REVIEWER)] })]),
    ).not.toThrow();
  });

  it('refuses an empty report list', () => {
    expect(() => assertReportsCompliance([])).toThrow(/no reports/i);
  });

  it('refuses a report whose declared top-level ID is non-compliant', () => {
    expect(() =>
      assertReportsCompliance([
        report({
          modelIds: { reviewer: 'gpt-4o', adjudicator: null },
          allModelIds: ['gpt-4o'],
        }),
      ]),
    ).toThrow(/gpt-4o/);
  });

  // The defect this suite exists for: the gate inspected only the SURFACE.
  describe('walks the whole report, not just its top-level ID fields', () => {
    it('REFUSES a forged report with compliant top-level IDs and non-compliant raw entries', () => {
      // REGRESSION (D3). This is the exact shape a proxy or provider fallback
      // produces: the run was CONFIGURED with gpt-5.6, so `modelIds` and
      // `allModelIds` are honest — but the calls were actually served by gpt-4o,
      // and `raw` records it. Under the surface-only gate this sailed through
      // and was written to eval/results/ as submission evidence.
      const forged = report({
        modelIds: { reviewer: COMPLIANT_REVIEWER, adjudicator: COMPLIANT_ADJUDICATOR },
        allModelIds: [COMPLIANT_REVIEWER, COMPLIANT_ADJUDICATOR],
        raw: [rawCall(COMPLIANT_REVIEWER), rawCall('gpt-4o')],
      });

      expect(() => assertReportsCompliance([forged])).toThrow(/Refusing to write eval results/);
      expect(() => assertReportsCompliance([forged])).toThrow(/gpt-4o/);
    });

    it('refuses even when the forged entry admits modelFamilyOk:false', () => {
      // The flag is not the gate. A recorded "we know this was not compliant"
      // is a reason to refuse the write, not a licence to perform it.
      const forged = report({
        raw: [{ ...rawCall('gpt-4o'), modelFamilyOk: false }],
      });
      expect(() => assertReportsCompliance([forged])).toThrow(/gpt-4o/);
    });

    it('refuses a non-compliant ID buried deep inside raw', () => {
      const forged = report({
        raw: [{ attempts: [{ response: { modelId: 'claude-anything' } }] }],
      });
      expect(() => assertReportsCompliance([forged])).toThrow(/claude-anything/);
    });

    it('refuses when only ONE report in the batch is forged', () => {
      expect(() =>
        assertReportsCompliance([
          report({ runIndex: 1 }),
          report({ runIndex: 2, raw: [rawCall('gpt-4o')] }),
          report({ runIndex: 3 }),
        ]),
      ).toThrow(/gpt-4o/);
    });

    it('refuses a suffix-spoofed ID hidden in raw', () => {
      const forged = report({ raw: [rawCall('gpt-5.6-evil-actually-something-else')] });
      expect(() => assertReportsCompliance([forged])).toThrow(/evil-actually-something-else/);
    });

    it('names the allowed IDs in the refusal, so the fix is obvious', () => {
      const forged = report({ raw: [rawCall('gpt-4o')] });
      expect(() => assertReportsCompliance([forged])).toThrow(/gpt-5\.6-terra/);
    });
  });

  describe('treats an empty ID set as a refusal, not a pass', () => {
    it('refuses a report from which no model ID could be collected', () => {
      // "No IDs found" almost always means the walk missed them, not that no
      // model was called. Fail-closed: an artifact the gate cannot attest to is
      // not evidence. Cast, because this shape is invalid by construction —
      // which is precisely why it must not be able to slip past the gate.
      const idless = report({
        modelIds: undefined as unknown as EvalReport['modelIds'],
        allModelIds: [],
      });
      expect(() => assertReportsCompliance([idless])).toThrow(/no model IDs found/i);
    });

    it('does not confuse an empty ID set with an empty report list', () => {
      const idless = report({
        modelIds: undefined as unknown as EvalReport['modelIds'],
        allModelIds: [],
      });
      expect(() => assertReportsCompliance([idless])).not.toThrow(/no reports/i);
    });
  });
});
