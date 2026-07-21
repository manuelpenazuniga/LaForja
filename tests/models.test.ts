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
