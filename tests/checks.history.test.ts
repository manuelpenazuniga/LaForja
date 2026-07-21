/**
 * LA FORJA — history re-run / non-regression spec (doc §5; gate §13.3).
 *
 * CONVENTION (Claude/Codex split): reRunCheck() and reRunHistory() in
 * src/core/checks.ts are CODEX-owned and currently throw, so every suite here is
 * `describe.skip` with a REAL, fully written body — the assertions ARE the
 * specification, they typecheck today, and they run the moment Codex removes the
 * `.skip`. Nothing here is a placeholder; the skipped suites are the punch-list.
 *
 * This file is the proof behind the only guarantee text the project is allowed to
 * use (doc §5):
 *   "Every repair re-runs all recorded counterexamples and checks. The system
 *    guarantees history execution and the non-regression of deterministic
 *    invariants; semantic judgments are re-adjudicated and shown in the passport."
 *
 * Three classes, three different promises:
 *   deterministic  -> STRICT non-regression: v2 cannot reintroduce the failure.
 *   counterexample -> the construction is RE-EXECUTED on v2; if it still holds, no publish.
 *   semantic       -> RE-ADJUDICATED every version; never an absolute guarantee.
 *
 * NEW-VERSION CONTRACT (this file defines the shape reRunCheck receives as its
 * `newVersion: unknown` argument — it mirrors the ItemVersion columns):
 *   { versionNumber, stem, options, correctKey, authorRationale }
 *
 * Each recorded check below stays bound to the item it was raised on: the dice
 * fixtures exercise the solver invariant, the cue-leak fixtures the probe
 * invariant, and the seeded demo item (two children) the ambiguity counterexample
 * plus the semantic judgment and the item's own deterministic invariants.
 */
import { describe, expect, it } from 'vitest';

import { CHECK_CLASS_BY_VERIFICATION, reRunCheck, reRunHistory } from '@/core/checks';
import type {
  HistoryRunBatch,
  RecordedCheck,
  ReRunOutcome,
  SemanticReadjudicatedOutcome,
} from '@/core/checks';
import type { AmbiguityContract, DistractorContract } from '@/core/types';
import type { ProbabilityProblem } from '@/solver/probability';
import { LENGTH_HIGH, OVERLAP_HIGH } from '@/probe/itemProbe';

// ---------------------------------------------------------------------------
// Fixture shapes
// ---------------------------------------------------------------------------
interface VersionUnderTest {
  versionNumber: number;
  stem: string;
  options: string[];
  correctKey: string;
  authorRationale: string;
}

/**
 * Executable checks record the identity of the code that produced them, so the
 * SAME check can be re-executed identically on a later version.
 */
const EXECUTOR_VERSION = 'solver@1.0.0';
const PROBE_EXECUTOR_VERSION = 'probe@1.0.0';
const THRESHOLD_VERSION = 'thresholds@1.0.0';

/** Narrow a re-run outcome to the semantic/re-adjudicated member. */
function asReadjudicated(outcome: ReRunOutcome): SemanticReadjudicatedOutcome {
  if (outcome.checkClass !== 'semantic' || outcome.result !== 'readjudicated') {
    throw new Error(
      `expected a re-adjudicated semantic outcome, got ${outcome.checkClass}/${outcome.result}`,
    );
  }
  return outcome;
}

/** Deterministic invariant re-computed by the bounded solver. */
interface SolverInvariantContract {
  invariant: 'solver_key_matches';
  /** The bounded solver re-runs THIS problem and compares it with the marked key. */
  problem: ProbabilityProblem;
  /** The exact answer the solver produced when the check was recorded. */
  solverAnswer: string;
  /** The key that made the invariant FAIL on the earlier version. */
  failingKey: string;
}

/** Deterministic invariant re-computed by the item probe (fixed thresholds). */
interface ProbeInvariantContract {
  invariant: 'answer_length_flag' | 'lexical_overlap_flag';
  threshold: number;
  /** The value observed when the check was recorded. */
  observedValue: number;
}

// ---------------------------------------------------------------------------
// factual-error-001 — the solver invariant: marked key must equal the solver answer
// ---------------------------------------------------------------------------
const SOLVER_PROBLEM: ProbabilityProblem = {
  kind: 'conditional',
  params: {
    experiment: 'two_fair_dice',
    event: 'both_six',
    given: 'at_least_one_six',
  },
};

const DICE_STEM =
  'Se lanzan dos dados justos de seis caras. Se sabe que al menos uno de ellos muestra un 6. ¿Cuál es la probabilidad de que ambos muestren un 6?';
const DICE_OPTIONS = ['1/6', '1/11', '1/36', '1/12'];

/** v1 marked A = 1/6. The bounded solver computes 1/11 ⇒ the invariant FAILED on v1. */
const DICE_V1: VersionUnderTest = {
  versionNumber: 1,
  stem: DICE_STEM,
  options: DICE_OPTIONS,
  correctKey: 'A',
  authorRationale: 'El otro dado debe salir 6, y eso ocurre con probabilidad 1/6.',
};

/** v2 marks B = 1/11 ⇒ the invariant holds again. */
const DICE_V2_REPAIRED: VersionUnderTest = {
  versionNumber: 2,
  stem: DICE_STEM,
  options: DICE_OPTIONS,
  correctKey: 'B',
  authorRationale:
    'El evento condicionante "al menos un 6" tiene 11 resultados de 36; solo uno tiene ambos dados en 6, de modo que P = 1/11.',
};

/** v2' silently reverts the key ⇒ the SAME deterministic failure is back. */
const DICE_V2_REGRESSED: VersionUnderTest = {
  versionNumber: 2,
  stem: DICE_STEM,
  options: DICE_OPTIONS,
  correctKey: 'A',
  authorRationale: 'Vuelvo a mi razonamiento original: el otro dado sale 6 con probabilidad 1/6.',
};

const SOLVER_CHECK: RecordedCheck = {
  id: 'chk-solver-001',
  reviewerType: 'discipline',
  verificationKind: 'solver',
  checkClass: 'deterministic',
  invariantId: 'solver_key_matches',
  executorVersion: EXECUTOR_VERSION,
  thresholdVersion: THRESHOLD_VERSION,
  contract: {
    invariant: 'solver_key_matches',
    problem: SOLVER_PROBLEM,
    solverAnswer: '1/11',
    failingKey: 'A',
  } satisfies SolverInvariantContract,
};

// ---------------------------------------------------------------------------
// cue-leak-001 — the probe invariant: the answer-length cue must not come back
// ---------------------------------------------------------------------------
const CUE_STEM =
  'En un experimento aleatorio con espacio muestral equiprobable, ¿qué expresa la probabilidad de un evento A?';

const CUE_V1: VersionUnderTest = {
  versionNumber: 1,
  stem: CUE_STEM,
  options: [
    'Es siempre 1/2',
    'Es el cociente entre el número de casos favorables al evento A y el número total de casos posibles del espacio muestral equiprobable',
    'Es un número negativo',
    'Es el total de casos',
  ],
  correctKey: 'B',
  authorRationale: 'La definición de Laplace.',
};

/** v2 balances the option lengths ⇒ the length flag no longer fires. */
const CUE_V2_REPAIRED: VersionUnderTest = {
  versionNumber: 2,
  stem: CUE_STEM,
  options: [
    'El cociente entre casos favorables y casos totales',
    'Un valor fijo de un medio en todo experimento',
    'La suma de todos los resultados observados',
    'El total de resultados del experimento',
  ],
  correctKey: 'A',
  authorRationale: 'Las cuatro alternativas tienen ahora una extensión comparable.',
};

const CUE_LENGTH_CHECK: RecordedCheck = {
  id: 'chk-probe-length-001',
  reviewerType: 'item_probe',
  verificationKind: 'heuristic',
  checkClass: 'deterministic',
  invariantId: 'answer_length_flag',
  executorVersion: PROBE_EXECUTOR_VERSION,
  thresholdVersion: THRESHOLD_VERSION,
  contract: {
    invariant: 'answer_length_flag',
    threshold: LENGTH_HIGH,
    observedValue: 23 / 8.75, // 2.629 on v1
  } satisfies ProbeInvariantContract,
};

// ---------------------------------------------------------------------------
// The seeded demo item (two children) — the on-stage history
// ---------------------------------------------------------------------------
const DEMO_OPTIONS = ['1/4', '1/3', '1/2', '2/3'];

/** v1 — the stem does not disambiguate: 1/3 under one reading, 1/2 under the other. */
const DEMO_V1: VersionUnderTest = {
  versionNumber: 1,
  stem: 'Una familia tiene dos hijos. Se sabe que uno de ellos es varón. ¿Cuál es la probabilidad de que ambos sean varones?',
  options: DEMO_OPTIONS,
  correctKey: 'B',
  authorRationale:
    'Con la lectura "al menos uno es varón", el espacio se reduce a {VV, VM, MV} y solo VV es favorable, de modo que P = 1/3.',
};

/** v2 that only reshuffles words — BOTH readings survive ⇒ the attack still holds. */
const DEMO_V2_STILL_AMBIGUOUS: VersionUnderTest = {
  versionNumber: 2,
  stem: 'Una familia tiene dos hijos y se sabe que uno de ellos es varón. ¿Cuál es la probabilidad de que los dos sean varones?',
  options: DEMO_OPTIONS,
  correctKey: 'B',
  authorRationale: 'Reformulé la redacción para que se entienda mejor.',
};

/** v2 that actually disambiguates ⇒ only one reading remains, the attack dies. */
const DEMO_V2_REPAIRED: VersionUnderTest = {
  versionNumber: 2,
  stem: 'Una familia tiene dos hijos. Se sabe que AL MENOS uno de ellos es varón, sin identificar cuál. ¿Cuál es la probabilidad de que ambos sean varones?',
  options: DEMO_OPTIONS,
  correctKey: 'B',
  authorRationale:
    'El enunciado fija ahora la lectura "al menos uno": el espacio condicionado es {VV, VM, MV} y P = 1/3. La lectura "un hijo concreto es varón" queda excluida explícitamente.',
};

/**
 * v2 that disambiguates the stem but INTRODUCES a new deterministic failure: the
 * correct option is now far longer than the others (11 tokens vs 1, ratio 3.14).
 * Strict non-regression is not only "do not reintroduce" — a recorded deterministic
 * invariant must still hold on every later version.
 */
const DEMO_V2_NEW_CUE_LEAK: VersionUnderTest = {
  versionNumber: 2,
  stem: DEMO_V2_REPAIRED.stem,
  options: [
    '1/4',
    'un tercio de las familias con al menos un hijo varón',
    '1/2',
    '2/3',
  ],
  correctKey: 'B',
  authorRationale: 'Quise explicar la alternativa correcta dentro de la propia alternativa.',
};

const AMBIGUITY_CHECK: RecordedCheck = {
  id: 'chk-ambiguity-001',
  reviewerType: 'ambiguity',
  verificationKind: 'interpretation',
  checkClass: 'counterexample',
  invariantId: 'ambiguity_two_readings_disagree',
  executorVersion: EXECUTOR_VERSION,
  thresholdVersion: THRESHOLD_VERSION,
  contract: {
    interpretation_a: 'Al menos uno de los dos hijos es varón.',
    interpretation_b: 'Un hijo concreto y previamente identificado es varón.',
    answer_a: '1/3',
    answer_b: '1/2',
    evidence:
      'El enunciado no declara si la información distingue a un hijo concreto. Bajo A el espacio condicionado es {VV, VM, MV} y P = 1/3; bajo B es {VV, VM} y P = 1/2. Las respuestas difieren.',
  } satisfies AmbiguityContract,
};

const DEMO_LENGTH_CHECK: RecordedCheck = {
  id: 'chk-demo-length-001',
  reviewerType: 'item_probe',
  verificationKind: 'heuristic',
  checkClass: 'deterministic',
  invariantId: 'answer_length_flag',
  executorVersion: PROBE_EXECUTOR_VERSION,
  thresholdVersion: THRESHOLD_VERSION,
  contract: {
    invariant: 'answer_length_flag',
    threshold: LENGTH_HIGH,
    observedValue: 1, // four single-token fractions on v1
  } satisfies ProbeInvariantContract,
};

const DEMO_OVERLAP_CHECK: RecordedCheck = {
  id: 'chk-demo-overlap-001',
  reviewerType: 'item_probe',
  verificationKind: 'heuristic',
  checkClass: 'deterministic',
  invariantId: 'lexical_overlap_flag',
  executorVersion: PROBE_EXECUTOR_VERSION,
  thresholdVersion: THRESHOLD_VERSION,
  contract: {
    invariant: 'lexical_overlap_flag',
    threshold: OVERLAP_HIGH,
    observedValue: 0, // the correct option "1/3" echoes nothing in the stem
  } satisfies ProbeInvariantContract,
};

const SEMANTIC_CHECK: RecordedCheck = {
  id: 'chk-distractor-001',
  reviewerType: 'distractor',
  verificationKind: 'interpretation',
  checkClass: 'semantic',
  contract: {
    distractor: '2/3',
    hypothesized_error: 'El estudiante invierte el cociente del espacio condicionado.',
    confidence: 0.6,
    label: 'hypothesis',
  } satisfies DistractorContract,
};

/** The demo item's recorded history — one check of every class, same item. */
const DEMO_HISTORY: RecordedCheck[] = [
  DEMO_LENGTH_CHECK,
  DEMO_OVERLAP_CHECK,
  AMBIGUITY_CHECK,
  SEMANTIC_CHECK,
];

// ---------------------------------------------------------------------------
// The taxonomy is ENCODED, not described — this runs today (Claude-owned data).
// ---------------------------------------------------------------------------
const ALL_FIXTURE_CHECKS: RecordedCheck[] = [
  SOLVER_CHECK,
  CUE_LENGTH_CHECK,
  AMBIGUITY_CHECK,
  DEMO_LENGTH_CHECK,
  DEMO_OVERLAP_CHECK,
  SEMANTIC_CHECK,
];

describe('check taxonomy — (reviewerType, verificationKind) fixes the class', () => {
  it('every recorded fixture agrees with CHECK_CLASS_BY_VERIFICATION', () => {
    // Reviewer type alone is not enough: the discipline reviewer is deterministic
    // when the solver grounds it and semantic when a citation does. The pair is
    // what decides, and the mapping lives in exactly one place.
    for (const check of ALL_FIXTURE_CHECKS) {
      expect(CHECK_CLASS_BY_VERIFICATION[check.reviewerType][check.verificationKind]).toBe(
        check.checkClass,
      );
    }
  });

  it('splits the discipline reviewer across two classes', () => {
    expect(CHECK_CLASS_BY_VERIFICATION.discipline.solver).toBe('deterministic');
    expect(CHECK_CLASS_BY_VERIFICATION.discipline.citation).toBe('semantic');
  });

  it('marks illegal (reviewer, verification) pairs as null rather than defaulting', () => {
    // A null entry is a recording bug. Silently defaulting to 'semantic' would
    // turn a missing deterministic guarantee into an unnoticed downgrade.
    expect(CHECK_CLASS_BY_VERIFICATION.item_probe.solver).toBeNull();
    expect(CHECK_CLASS_BY_VERIFICATION.ambiguity.citation).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE headline test — deterministic checks cannot regress (doc §5, gate §13.3).
// ---------------------------------------------------------------------------
describe.skip('reRunCheck — deterministic class: STRICT non-regression', () => {
  it('passes on the v2 that fixes the invariant that broke v1', () => {
    // v1 marked 1/6; the bounded solver recomputes 1/11 ⇒ the check was recorded.
    // v2 marks 1/11 ⇒ re-running the SAME invariant now passes.
    const outcome = reRunCheck(SOLVER_CHECK, DICE_V2_REPAIRED);

    expect(outcome.originalCheckId).toBe(SOLVER_CHECK.id);
    expect(outcome.checkClass).toBe('deterministic');
    expect(outcome.result).toBe('pass');
  });

  it('reports "regressed" when v2 REINTRODUCES the failure', () => {
    const outcome = reRunCheck(SOLVER_CHECK, DICE_V2_REGRESSED);

    expect(outcome.originalCheckId).toBe(SOLVER_CHECK.id);
    expect(outcome.checkClass).toBe('deterministic');
    expect(outcome.result).toBe('regressed');
  });

  it('still reports "regressed" when re-run against the untouched v1', () => {
    // Re-running the recorded check on the version that produced it must reproduce
    // the failure — that is what makes the check deterministic in the first place.
    expect(reRunCheck(SOLVER_CHECK, DICE_V1).result).toBe('regressed');
  });

  it('is deterministic: the same (check, version) pair re-runs identically', () => {
    expect(reRunCheck(SOLVER_CHECK, DICE_V2_REPAIRED)).toEqual(
      reRunCheck(SOLVER_CHECK, DICE_V2_REPAIRED),
    );
    expect(reRunCheck(SOLVER_CHECK, DICE_V2_REGRESSED)).toEqual(
      reRunCheck(SOLVER_CHECK, DICE_V2_REGRESSED),
    );
  });

  it('blocks publish when a deterministic check regresses, and only then', () => {
    const clean = reRunHistory([SOLVER_CHECK], DICE_V2_REPAIRED);
    expect(clean.outcomes).toHaveLength(1);
    expect(clean.outcomes[0]?.result).toBe('pass');
    expect(clean.blocksPublish).toBe(false);

    const regressed = reRunHistory([SOLVER_CHECK], DICE_V2_REGRESSED);
    expect(regressed.outcomes).toHaveLength(1);
    expect(regressed.outcomes[0]?.result).toBe('regressed');
    expect(regressed.blocksPublish).toBe(true);
  });

  it('re-runs the probe invariant too: the length cue cannot come back', () => {
    expect(reRunCheck(CUE_LENGTH_CHECK, CUE_V1).result).toBe('regressed');
    expect(reRunCheck(CUE_LENGTH_CHECK, CUE_V2_REPAIRED).result).toBe('pass');
    expect(reRunHistory([CUE_LENGTH_CHECK], CUE_V1).blocksPublish).toBe(true);
    expect(reRunHistory([CUE_LENGTH_CHECK], CUE_V2_REPAIRED).blocksPublish).toBe(false);
  });

  it('also fails a repair that INTRODUCES a new deterministic failure', () => {
    // The demo item's length invariant held on v1 (ratio 1). This v2 disambiguates
    // the stem but blows the ratio to 11 / 3.5 = 3.14 ⇒ the recorded invariant no
    // longer holds, so the version does not publish.
    const outcome = reRunCheck(DEMO_LENGTH_CHECK, DEMO_V2_NEW_CUE_LEAK);

    expect(outcome.checkClass).toBe('deterministic');
    expect(outcome.result).toBe('regressed');
    expect(reRunHistory([DEMO_LENGTH_CHECK], DEMO_V2_NEW_CUE_LEAK).blocksPublish).toBe(true);

    // ...and it still holds on the clean repair.
    expect(reRunCheck(DEMO_LENGTH_CHECK, DEMO_V2_REPAIRED).result).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// Counterexample class — the construction is RE-EXECUTED on v2.
// ---------------------------------------------------------------------------
describe.skip('reRunCheck — counterexample class: the construction is re-executed', () => {
  it('regresses while both readings still yield different answers (the demo item v1)', () => {
    const outcome = reRunCheck(AMBIGUITY_CHECK, DEMO_V1);

    expect(outcome.originalCheckId).toBe(AMBIGUITY_CHECK.id);
    expect(outcome.checkClass).toBe('counterexample');
    expect(outcome.result).toBe('regressed');
  });

  it('regresses on a cosmetic v2 that leaves both readings available', () => {
    // Rewording without disambiguating is not a repair: 1/3 and 1/2 both still hold.
    expect(reRunCheck(AMBIGUITY_CHECK, DEMO_V2_STILL_AMBIGUOUS).result).toBe('regressed');
    expect(reRunHistory([AMBIGUITY_CHECK], DEMO_V2_STILL_AMBIGUOUS).blocksPublish).toBe(true);
  });

  it('passes once the repair disambiguates the stem (only one reading survives)', () => {
    const outcome = reRunCheck(AMBIGUITY_CHECK, DEMO_V2_REPAIRED);

    expect(outcome.checkClass).toBe('counterexample');
    expect(outcome.result).toBe('pass');
    expect(reRunHistory([AMBIGUITY_CHECK], DEMO_V2_REPAIRED).blocksPublish).toBe(false);
  });

  it('is deterministic: re-executing the same construction twice gives the same verdict', () => {
    expect(reRunCheck(AMBIGUITY_CHECK, DEMO_V2_REPAIRED)).toEqual(
      reRunCheck(AMBIGUITY_CHECK, DEMO_V2_REPAIRED),
    );
    expect(reRunCheck(AMBIGUITY_CHECK, DEMO_V1)).toEqual(reRunCheck(AMBIGUITY_CHECK, DEMO_V1));
  });

  it('never resolves to "readjudicated" — a counterexample is executed, not judged', () => {
    for (const version of [DEMO_V1, DEMO_V2_STILL_AMBIGUOUS, DEMO_V2_REPAIRED]) {
      expect(reRunCheck(AMBIGUITY_CHECK, version).result).not.toBe('readjudicated');
    }
  });
});

// ---------------------------------------------------------------------------
// Semantic class — re-adjudicated, NEVER an absolute guarantee.
// ---------------------------------------------------------------------------
describe.skip('reRunCheck — semantic class: re-adjudicated, never a hard guarantee', () => {
  it('always returns "readjudicated", whatever the new version looks like', () => {
    for (const version of [DEMO_V1, DEMO_V2_STILL_AMBIGUOUS, DEMO_V2_REPAIRED]) {
      const outcome = reRunCheck(SEMANTIC_CHECK, version);
      expect(outcome.originalCheckId).toBe(SEMANTIC_CHECK.id);
      expect(outcome.checkClass).toBe('semantic');
      expect(outcome.result).toBe('readjudicated');
    }
  });

  it('never claims a hard pass and never claims a regression', () => {
    // The authorized guarantee text covers deterministic invariants only. A semantic
    // judgment may not be reported as 'pass' (which would read as an absolute
    // guarantee) nor as 'regressed' (a hard block): it is re-adjudicated and shown
    // in the passport (doc §5, §6.4).
    const outcome = reRunCheck(SEMANTIC_CHECK, DEMO_V2_REPAIRED);
    expect(outcome.result).not.toBe('pass');
    expect(outcome.result).not.toBe('regressed');
  });

  it('carries a STRUCTURED re-adjudicated verdict for the passport (doc §6.4)', () => {
    // The verdict is a required field, not an optional free-text `detail`: the
    // passport renders it, so it has to be readable without parsing prose.
    const outcome = asReadjudicated(reRunCheck(SEMANTIC_CHECK, DEMO_V2_REPAIRED));

    expect(['upheld', 'withdrawn', 'modified']).toContain(outcome.verdict.status);
    expect(outcome.verdict.rationale.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(outcome.verdict.adjudicatedAt))).toBe(false);
    expect(outcome.blocksPublish).toBe(false);
  });

  it('re-adjudicates to a DIFFERENT structured verdict when the repair earns it', () => {
    // The distractor 2/3 was recorded as a hypothesis on v1. On the repaired
    // version the adjudicator may withdraw or restate it — either way the new
    // status is carried in the verdict, never inferred from the absence of a row.
    const onV1 = asReadjudicated(reRunCheck(SEMANTIC_CHECK, DEMO_V1));
    const onRepair = asReadjudicated(reRunCheck(SEMANTIC_CHECK, DEMO_V2_REPAIRED));

    expect(onV1.originalCheckId).toBe(SEMANTIC_CHECK.id);
    expect(onRepair.originalCheckId).toBe(SEMANTIC_CHECK.id);
    // Both are complete verdicts; neither blocks publication.
    expect(onV1.blocksPublish).toBe(false);
    expect(onRepair.blocksPublish).toBe(false);
  });

  it('does not block publish on its own', () => {
    const summary = reRunHistory([SEMANTIC_CHECK], DEMO_V2_REPAIRED);
    expect(summary.outcomes).toHaveLength(1);
    expect(summary.outcomes[0]?.result).toBe('readjudicated');
    expect(summary.blocksPublish).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reRunHistory — the FULL history, every version, nothing silently dropped.
// ---------------------------------------------------------------------------
describe.skip('reRunHistory — the full history is executed on every version', () => {
  it('produces exactly one outcome per recorded check, in order', () => {
    const summary = reRunHistory(DEMO_HISTORY, DEMO_V2_REPAIRED);

    expect(summary.outcomes).toHaveLength(DEMO_HISTORY.length);
    expect(summary.outcomes.map((o) => o.originalCheckId)).toEqual(DEMO_HISTORY.map((c) => c.id));
  });

  it('drops nothing: every outcome carries its class and a legal result', () => {
    const summary = reRunHistory(DEMO_HISTORY, DEMO_V2_STILL_AMBIGUOUS);

    expect(summary.outcomes.map((o) => o.checkClass)).toEqual(
      DEMO_HISTORY.map((c) => c.checkClass),
    );
    for (const outcome of summary.outcomes) {
      expect(['pass', 'regressed', 'readjudicated', 'inconclusive']).toContain(outcome.result);
    }
  });

  it('clears the whole history on the real repair: nothing regressed, publish is not blocked', () => {
    const summary = reRunHistory(DEMO_HISTORY, DEMO_V2_REPAIRED);

    const byId = new Map(summary.outcomes.map((o) => [o.originalCheckId, o.result] as const));
    expect(byId.get(DEMO_LENGTH_CHECK.id)).toBe('pass');
    expect(byId.get(DEMO_OVERLAP_CHECK.id)).toBe('pass');
    expect(byId.get(AMBIGUITY_CHECK.id)).toBe('pass');
    expect(byId.get(SEMANTIC_CHECK.id)).toBe('readjudicated');
    expect(summary.blocksPublish).toBe(false);
  });

  it('blocks publish when ANY deterministic or counterexample check regressed', () => {
    // The ambiguity counterexample still holds on the cosmetic v2.
    const summary = reRunHistory(DEMO_HISTORY, DEMO_V2_STILL_AMBIGUOUS);
    const regressed = summary.outcomes.filter((o) => o.result === 'regressed');

    expect(regressed.map((o) => o.originalCheckId)).toContain(AMBIGUITY_CHECK.id);
    expect(summary.blocksPublish).toBe(true);
  });

  it('blocks publish when the repair introduces a new deterministic failure', () => {
    const summary = reRunHistory(DEMO_HISTORY, DEMO_V2_NEW_CUE_LEAK);
    const byId = new Map(summary.outcomes.map((o) => [o.originalCheckId, o.result] as const));

    expect(summary.outcomes).toHaveLength(DEMO_HISTORY.length);
    expect(byId.get(DEMO_LENGTH_CHECK.id)).toBe('regressed');
    expect(summary.blocksPublish).toBe(true);
  });

  it('handles an empty history without blocking publish', () => {
    const summary = reRunHistory([], DEMO_V2_REPAIRED);
    expect(summary.outcomes).toEqual([]);
    expect(summary.blocksPublish).toBe(false);
  });

  it('is deterministic across repeated runs of the same history', () => {
    expect(reRunHistory(DEMO_HISTORY, DEMO_V2_REPAIRED)).toEqual(
      reRunHistory(DEMO_HISTORY, DEMO_V2_REPAIRED),
    );
  });

  it('reports a COMPLETE batch when every expected check produced an outcome', () => {
    const batch: HistoryRunBatch = reRunHistory(DEMO_HISTORY, DEMO_V2_REPAIRED);

    expect(batch.expectedCheckCount).toBe(DEMO_HISTORY.length);
    expect(batch.completedCheckCount).toBe(DEMO_HISTORY.length);
    expect(batch.status).toBe('complete');
    expect(batch.completedAt).not.toBeNull();
    expect(batch.blocksPublish).toBe(false);
  });

  it('re-runs the FULL history again on a THIRD version (every version re-runs everything)', () => {
    const v3: VersionUnderTest = {
      ...DEMO_V2_REPAIRED,
      versionNumber: 3,
      authorRationale: `${DEMO_V2_REPAIRED.authorRationale} Se aclara además que los nacimientos son independientes.`,
    };

    const summary = reRunHistory(DEMO_HISTORY, v3);

    expect(summary.outcomes).toHaveLength(DEMO_HISTORY.length);
    expect(summary.outcomes.map((o) => o.originalCheckId)).toEqual(DEMO_HISTORY.map((c) => c.id));
    expect(summary.blocksPublish).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FAIL-CLOSED — an inconclusive re-run is not a pass (doc §5).
//
// The bug this suite exists to prevent: blocksPublish computed only from
// 'regressed'. A deterministic check whose executor crashed then returns
// 'inconclusive', nothing blocks, and the item publishes with an unverified
// invariant — the exact opposite of "strict non-regression".
// ---------------------------------------------------------------------------

/** A deterministic check pinned to an executor build that no longer exists. */
const UNRUNNABLE_SOLVER_CHECK: RecordedCheck = {
  ...SOLVER_CHECK,
  id: 'chk-solver-unrunnable-001',
  executorVersion: 'solver@0.0.0-removed',
  thresholdVersion: 'thresholds@0.0.0-removed',
};

/** A deterministic check naming an invariant the executor does not implement. */
const UNKNOWN_INVARIANT_CHECK: RecordedCheck = {
  ...DEMO_LENGTH_CHECK,
  id: 'chk-probe-unknown-001',
  invariantId: 'invariant_that_does_not_exist',
};

describe.skip('fail-closed — inconclusive deterministic/counterexample re-runs block publish', () => {
  it('returns "inconclusive" when the recorded executor cannot be re-run', () => {
    const outcome = reRunCheck(UNRUNNABLE_SOLVER_CHECK, DICE_V2_REPAIRED);

    expect(outcome.checkClass).toBe('deterministic');
    expect(outcome.result).toBe('inconclusive');
  });

  it('BLOCKS publish on an inconclusive deterministic re-run', () => {
    // Not verified is not verified. The repaired version may well be fine —
    // the system simply may not claim so.
    const outcome = reRunCheck(UNRUNNABLE_SOLVER_CHECK, DICE_V2_REPAIRED);
    expect(outcome.blocksPublish).toBe(true);

    const batch = reRunHistory([UNRUNNABLE_SOLVER_CHECK], DICE_V2_REPAIRED);
    expect(batch.blocksPublish).toBe(true);
  });

  it('BLOCKS publish when a recorded invariant is no longer implemented', () => {
    const outcome = reRunCheck(UNKNOWN_INVARIANT_CHECK, DEMO_V2_REPAIRED);

    expect(outcome.result).toBe('inconclusive');
    expect(outcome.blocksPublish).toBe(true);
    expect(reRunHistory([UNKNOWN_INVARIANT_CHECK], DEMO_V2_REPAIRED).blocksPublish).toBe(true);
  });

  it('BLOCKS publish on an inconclusive counterexample re-execution', () => {
    // Re-applying two natural-language readings to a repaired stem can fail to
    // resolve. §5 guarantees the EXECUTION and the BLOCKING, not a deterministic
    // adjudication — so an unresolved re-execution keeps the version unpublished.
    const unrunnable: RecordedCheck = {
      ...AMBIGUITY_CHECK,
      id: 'chk-ambiguity-unrunnable-001',
      executorVersion: 'solver@0.0.0-removed',
    };
    const outcome = reRunCheck(unrunnable, DEMO_V2_REPAIRED);

    expect(outcome.checkClass).toBe('counterexample');
    expect(outcome.result).toBe('inconclusive');
    expect(outcome.blocksPublish).toBe(true);
  });

  it('is the general rule: executable outcomes pass ONLY on a conclusive "pass"', () => {
    const executable = [SOLVER_CHECK, CUE_LENGTH_CHECK, AMBIGUITY_CHECK, UNRUNNABLE_SOLVER_CHECK];
    const versions = [DICE_V1, DICE_V2_REPAIRED, DEMO_V1, DEMO_V2_REPAIRED];

    for (const check of executable) {
      for (const version of versions) {
        const outcome = reRunCheck(check, version);
        if (outcome.checkClass === 'semantic') continue;
        expect(outcome.blocksPublish).toBe(outcome.result !== 'pass');
      }
    }
  });

  it('lets ONLY semantic checks end without blocking on a non-pass result', () => {
    // 'readjudicated' is legal exclusively for the semantic class, and it is the
    // only non-'pass' result that leaves publication open.
    const semantic = reRunCheck(SEMANTIC_CHECK, DEMO_V2_REPAIRED);
    expect(semantic.result).toBe('readjudicated');
    expect(semantic.blocksPublish).toBe(false);

    const deterministic = reRunCheck(SOLVER_CHECK, DICE_V2_REGRESSED);
    expect(deterministic.result).not.toBe('readjudicated');
    expect(deterministic.blocksPublish).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HistoryRunBatch — "the full history ran" must be PROVABLE, not inferred.
//
// Per-check rows alone cannot tell "this item had no prior checks" from "the
// re-run crashed after two checks": both produce a short outcome list and no
// regression. The batch record is what answers doc §5 and gate question 3.
// ---------------------------------------------------------------------------
describe.skip('HistoryRunBatch — completeness gates HISTORY_CLEAN', () => {
  it('an empty history is COMPLETE and does not block', () => {
    const batch = reRunHistory([], DEMO_V2_REPAIRED);

    expect(batch.expectedCheckCount).toBe(0);
    expect(batch.completedCheckCount).toBe(0);
    expect(batch.status).toBe('complete');
    expect(batch.blocksPublish).toBe(false);
  });

  it('records the target version and a closed time window', () => {
    const batch = reRunHistory(DEMO_HISTORY, DEMO_V2_REPAIRED);

    expect(batch.targetVersionId.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(batch.startedAt))).toBe(false);
    expect(batch.completedAt).not.toBeNull();
    expect(Date.parse(batch.completedAt ?? '')).toBeGreaterThanOrEqual(Date.parse(batch.startedAt));
  });

  it('an INCOMPLETE batch refuses HISTORY_CLEAN even with zero regressions', () => {
    // This is the shape a crashed re-run leaves behind: two clean outcomes and
    // two checks that never ran. Nothing regressed, and yet the history was not
    // executed — so the version may not advance to DEFENSE.
    const partial: HistoryRunBatch = {
      targetVersionId: 'ver-demo-2',
      expectedCheckCount: DEMO_HISTORY.length,
      completedCheckCount: 2,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:03.000Z',
      status: 'incomplete',
      blocksPublish: true,
      outcomes: [],
    };

    expect(partial.completedCheckCount).toBeLessThan(partial.expectedCheckCount);
    expect(canDispatchHistoryClean(partial)).toBe(false);
  });

  it('a FAILED batch refuses HISTORY_CLEAN', () => {
    const failed: HistoryRunBatch = {
      targetVersionId: 'ver-demo-2',
      expectedCheckCount: DEMO_HISTORY.length,
      completedCheckCount: 0,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: null,
      status: 'failed',
      blocksPublish: true,
      outcomes: [],
    };

    expect(canDispatchHistoryClean(failed)).toBe(false);
  });

  it('allows HISTORY_CLEAN only on a complete, fully accounted, non-blocking batch', () => {
    const batch = reRunHistory(DEMO_HISTORY, DEMO_V2_REPAIRED);

    expect(batch.status).toBe('complete');
    expect(batch.outcomes).toHaveLength(batch.expectedCheckCount);
    expect(batch.completedCheckCount).toBe(batch.expectedCheckCount);
    expect(batch.blocksPublish).toBe(false);
    expect(canDispatchHistoryClean(batch)).toBe(true);
  });

  it('marks the batch as blocking when the repair is cosmetic', () => {
    const batch = reRunHistory(DEMO_HISTORY, DEMO_V2_STILL_AMBIGUOUS);

    expect(batch.status).toBe('complete'); // it RAN — it just did not pass
    expect(batch.blocksPublish).toBe(true);
    expect(canDispatchHistoryClean(batch)).toBe(false);
  });
});

/**
 * The dispatch rule the state machine must honour, written once so the suites
 * above assert the same thing the TODO(codex) spec in src/core/checks.ts states:
 * HISTORY_CLEAN needs a complete batch, every expected check accounted for, and
 * no blocking outcome.
 */
function canDispatchHistoryClean(batch: HistoryRunBatch): boolean {
  return (
    batch.status === 'complete' &&
    batch.completedCheckCount === batch.expectedCheckCount &&
    batch.outcomes.length === batch.expectedCheckCount &&
    !batch.blocksPublish
  );
}
