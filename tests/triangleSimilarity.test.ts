import { describe, expect, it } from 'vitest';
import {
  MAX_SIDE_MAGNITUDE,
  solveTriangleSimilarity,
} from '@/solver/triangleSimilarity';
import type { TriangleProblem } from '@/solver/types';

function missingSide(params: TriangleProblem['params']): TriangleProblem {
  return { discipline: 'triangle-similarity', kind: 'similarity_missing_side', params };
}

function decision(params: TriangleProblem['params']): TriangleProblem {
  return { discipline: 'triangle-similarity', kind: 'similarity_decision', params };
}

describe('solveTriangleSimilarity — similarity_missing_side', () => {
  it('GOLDEN: k = 8/6, missing = 9·(4/3) = 12', () => {
    const result = solveTriangleSimilarity(
      missingSide({ known_side_1: 6, known_side_2: 8, target_side_1: 9 }),
    );
    expect(result.supported).toBe(true);
    expect(result.value).toEqual({ numerator: 12, denominator: 1 });
    expect(result.decimal).toBe(12);
    // Exact mode: value present => tolerance MUST be absent.
    expect(result.tolerance).toBeUndefined();
    expect(result.steps?.length).toBeGreaterThan(0);
  });

  it('produces a reduced non-integer fraction (5·3/2 = 15/2)', () => {
    const result = solveTriangleSimilarity(
      missingSide({ known_side_1: 2, known_side_2: 3, target_side_1: 5 }),
    );
    expect(result.supported).toBe(true);
    expect(result.value).toEqual({ numerator: 15, denominator: 2 });
    expect(result.decimal).toBe(7.5);
    expect(result.tolerance).toBeUndefined();
  });

  it('refuses known_side_1 = 0', () => {
    const result = solveTriangleSimilarity(
      missingSide({ known_side_1: 0, known_side_2: 8, target_side_1: 9 }),
    );
    expect(result.supported).toBe(false);
    expect(result.value).toBeUndefined();
    expect(result.decimal).toBeUndefined();
  });

  it('refuses a negative side', () => {
    const result = solveTriangleSimilarity(
      missingSide({ known_side_1: 6, known_side_2: -8, target_side_1: 9 }),
    );
    expect(result.supported).toBe(false);
  });

  it('refuses a missing required param', () => {
    const result = solveTriangleSimilarity(
      missingSide({ known_side_1: 6, target_side_1: 9 }),
    );
    expect(result.supported).toBe(false);
  });

  it('refuses when an optional degenerate t2 is supplied', () => {
    // 1 + 2 = 3: fails the triangle inequality.
    const result = solveTriangleSimilarity(
      missingSide({ known_side_1: 6, known_side_2: 8, target_side_1: 9, t2: '1,2,3' }),
    );
    expect(result.supported).toBe(false);
  });

  it('accepts a well-formed optional t1/t2 (still 12)', () => {
    const result = solveTriangleSimilarity(
      missingSide({
        known_side_1: 6,
        known_side_2: 8,
        target_side_1: 9,
        t1: '6,9,11',
        t2: '8,12,15',
      }),
    );
    expect(result.supported).toBe(true);
    expect(result.value).toEqual({ numerator: 12, denominator: 1 });
  });

  it('refuses an oversize side (over MAX_SIDE_MAGNITUDE)', () => {
    const result = solveTriangleSimilarity(
      missingSide({
        known_side_1: 6,
        known_side_2: MAX_SIDE_MAGNITUDE + 1,
        target_side_1: 9,
      }),
    );
    expect(result.supported).toBe(false);
  });
});

describe('solveTriangleSimilarity — similarity_decision (SSS)', () => {
  it('GOLDEN: 3,4,5 ~ 6,8,10 => k = 3/6 = 1/2', () => {
    const result = solveTriangleSimilarity(
      decision({ criterion: 'SSS', t1: '3,4,5', t2: '6,8,10' }),
    );
    expect(result.supported).toBe(true);
    expect(result.value).toEqual({ numerator: 1, denominator: 2 });
    expect(result.decimal).toBe(0.5);
    expect(result.tolerance).toBeUndefined();
  });

  it('similar regardless of input order (5,3,4 vs 8,10,6)', () => {
    const result = solveTriangleSimilarity(
      decision({ criterion: 'SSS', t1: '5,3,4', t2: '8,10,6' }),
    );
    expect(result.supported).toBe(true);
    expect(result.value).toEqual({ numerator: 1, denominator: 2 });
  });

  it('refuses a NON-similar pair (2,3,4 vs 4,5,6)', () => {
    const result = solveTriangleSimilarity(
      decision({ criterion: 'SSS', t1: '2,3,4', t2: '4,5,6' }),
    );
    expect(result.supported).toBe(false);
    expect(result.value).toBeUndefined();
  });

  it('refuses a degenerate triangle (1,2,3)', () => {
    const result = solveTriangleSimilarity(
      decision({ criterion: 'SSS', t1: '1,2,3', t2: '2,4,6' }),
    );
    expect(result.supported).toBe(false);
  });

  it('refuses a repeated-side (non-unique correspondence) triangle', () => {
    // Isosceles 5,5,8 ~ 10,10,16 would be similar, but repeated sides make the
    // sorted correspondence ambiguous, so the solver refuses.
    const result = solveTriangleSimilarity(
      decision({ criterion: 'SSS', t1: '5,5,8', t2: '10,10,16' }),
    );
    expect(result.supported).toBe(false);
  });

  it('refuses non-numeric sides', () => {
    const result = solveTriangleSimilarity(
      decision({ criterion: 'SSS', t1: 'a,b,c', t2: '6,8,10' }),
    );
    expect(result.supported).toBe(false);
  });

  it('refuses wrong arity (four sides)', () => {
    const result = solveTriangleSimilarity(
      decision({ criterion: 'SSS', t1: '3,4,5,6', t2: '6,8,10' }),
    );
    expect(result.supported).toBe(false);
  });
});

describe('solveTriangleSimilarity — similarity_decision (SAS)', () => {
  it('similar: matching included angle + proportional sides => k = 4/8 = 1/2', () => {
    const result = solveTriangleSimilarity(
      decision({ criterion: 'SAS', t1: '4,6,50', t2: '8,12,50' }),
    );
    expect(result.supported).toBe(true);
    expect(result.value).toEqual({ numerator: 1, denominator: 2 });
    expect(result.decimal).toBe(0.5);
    expect(result.tolerance).toBeUndefined();
  });

  it('refuses when the included angle differs', () => {
    const result = solveTriangleSimilarity(
      decision({ criterion: 'SAS', t1: '4,6,50', t2: '8,12,60' }),
    );
    expect(result.supported).toBe(false);
  });

  it('refuses when the enclosing sides are not proportional', () => {
    const result = solveTriangleSimilarity(
      decision({ criterion: 'SAS', t1: '4,6,50', t2: '8,13,50' }),
    );
    expect(result.supported).toBe(false);
  });

  it('refuses an out-of-range included angle (>= 180)', () => {
    const result = solveTriangleSimilarity(
      decision({ criterion: 'SAS', t1: '4,6,180', t2: '8,12,180' }),
    );
    expect(result.supported).toBe(false);
  });
});

describe('solveTriangleSimilarity — out of scope => refuse', () => {
  it('AA (angle-only, scale not determinable)', () => {
    const result = solveTriangleSimilarity(
      decision({ criterion: 'AA', t1: '60,80', t2: '60,80' }),
    );
    expect(result.supported).toBe(false);
    expect(result.value).toBeUndefined();
  });

  it('AA with an angle set not summing under 180', () => {
    const result = solveTriangleSimilarity(
      decision({ criterion: 'AA', t1: '90,100', t2: '90,100' }),
    );
    expect(result.supported).toBe(false);
  });

  it('congruence-style criterion (ASA) is out of scope', () => {
    const result = solveTriangleSimilarity(
      decision({ criterion: 'ASA', t1: '3,4,5', t2: '3,4,5' }),
    );
    expect(result.supported).toBe(false);
  });

  it('missing criterion', () => {
    const result = solveTriangleSimilarity(
      decision({ t1: '3,4,5', t2: '6,8,10' }),
    );
    expect(result.supported).toBe(false);
  });

  it('unknown kind (coordinate-only / congruence ask)', () => {
    const problem = {
      discipline: 'triangle-similarity',
      kind: 'are_these_congruent',
      params: { t1: '3,4,5', t2: '3,4,5' },
    } as unknown as TriangleProblem;
    const result = solveTriangleSimilarity(problem);
    expect(result.supported).toBe(false);
  });
});

describe('solveTriangleSimilarity — totality on adversarial input', () => {
  const adversarial: TriangleProblem[] = [
    missingSide({}),
    missingSide({ known_side_1: 'x', known_side_2: 'y', target_side_1: 'z' }),
    missingSide({ known_side_1: 6, known_side_2: 8, target_side_1: 9, t1: '' }),
    missingSide({ known_side_1: Number.NaN, known_side_2: 8, target_side_1: 9 }),
    missingSide({ known_side_1: 1e18, known_side_2: 1e18, target_side_1: 1e18 }),
    decision({}),
    decision({ criterion: 'SSS', t1: '', t2: '' }),
    decision({ criterion: 'SSS', t1: '3,4', t2: '6,8,10' }),
    decision({ criterion: 'SSS', t1: '3,4,5', t2: `${1e18},${1e18},${1e18}` }),
    decision({ criterion: 'SAS', t1: 'p,q,r', t2: '8,12,50' }),
    decision({ criterion: true as unknown as string }),
  ];

  for (const [index, problem] of adversarial.entries()) {
    it(`never throws and refuses on adversarial input #${index}`, () => {
      let result: ReturnType<typeof solveTriangleSimilarity> | undefined;
      expect(() => {
        result = solveTriangleSimilarity(problem);
      }).not.toThrow();
      expect(result?.supported).toBe(false);
      expect(result?.value).toBeUndefined();
      expect(result?.decimal).toBeUndefined();
    });
  }
});
