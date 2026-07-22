import { describe, expect, it } from 'vitest';

import {
  MAX_ABS_NUMERATOR,
  MAX_DATASET_SIZE,
  MAX_DENOMINATOR,
  solveStatistics,
} from '@/solver/statistics';
import type { StatisticsProblem } from '@/solver/types';

type Kind = StatisticsProblem['kind'];

function stat(kind: Kind, params: Record<string, number | string | boolean>) {
  return solveStatistics({ discipline: 'statistics', kind, params } as StatisticsProblem);
}

// Escape hatch for adversarial out-of-scope kinds not in the type union.
function bogusKind(kind: string, params: Record<string, number | string | boolean>) {
  return solveStatistics({ discipline: 'statistics', kind, params } as unknown as StatisticsProblem);
}

const GOLDEN = '3,5,7,8,12,13,14,18,21'; // n = 9, sorted, Q2 = 12

describe('solveStatistics — supported kinds with hand-verified goldens', () => {
  it('mean = S/n = 101/9', () => {
    const r = stat('mean', { data: GOLDEN });
    expect(r.supported).toBe(true);
    expect(r.value).toEqual({ numerator: 101, denominator: 9 });
    expect(r.tolerance).toBeUndefined();
    expect(r.decimal).toBeCloseTo(101 / 9, 12);
  });

  it('mean of fractions 1/2, 1/2 = 1/2', () => {
    const r = stat('mean', { data: '1/2,1/2' });
    expect(r.value).toEqual({ numerator: 1, denominator: 2 });
  });

  it('median (odd n) = 12', () => {
    const r = stat('median', { data: GOLDEN });
    expect(r.value).toEqual({ numerator: 12, denominator: 1 });
  });

  it('median (even n) averages the two middle values: [1,2,3,4] -> 5/2', () => {
    const r = stat('median', { data: '4,1,3,2' });
    expect(r.value).toEqual({ numerator: 5, denominator: 2 });
  });

  it('mode = unique strict-max-frequency value: [1,2,2,3] -> 2', () => {
    const r = stat('mode', { data: '1,2,2,3' });
    expect(r.value).toEqual({ numerator: 2, denominator: 1 });
  });

  it('mode of a single value [7] -> 7', () => {
    const r = stat('mode', { data: '7' });
    expect(r.value).toEqual({ numerator: 7, denominator: 1 });
  });

  it('range = max - min = 18', () => {
    const r = stat('range', { data: GOLDEN });
    expect(r.value).toEqual({ numerator: 18, denominator: 1 });
  });

  it('range of fractions 1/2, 3/2 = 1', () => {
    const r = stat('range', { data: '1/2,3/2' });
    expect(r.value).toEqual({ numerator: 1, denominator: 1 });
  });

  it('pop_variance [2,4,6,8] = (4*120 - 400)/16 = 5', () => {
    const r = stat('pop_variance', { data: '2,4,6,8' });
    expect(r.value).toEqual({ numerator: 5, denominator: 1 });
  });

  it('sample_variance [2,4,6,8] = 80/12 = 20/3', () => {
    const r = stat('sample_variance', { data: '2,4,6,8' });
    expect(r.value).toEqual({ numerator: 20, denominator: 3 });
  });

  it('iqr exclusive on the golden set = 10', () => {
    const r = stat('iqr', { data: GOLDEN, method: 'exclusive' });
    expect(r.value).toEqual({ numerator: 10, denominator: 1 });
  });

  it('iqr inclusive on the golden set = 7', () => {
    const r = stat('iqr', { data: GOLDEN, method: 'inclusive' });
    expect(r.value).toEqual({ numerator: 7, denominator: 1 });
  });

  it('quartiles exclusive returns IQR as value and Q1/Q2/Q3 in steps', () => {
    const r = stat('quartiles', { data: GOLDEN, method: 'exclusive' });
    expect(r.value).toEqual({ numerator: 10, denominator: 1 });
    const steps = (r.steps ?? []).join('\n');
    expect(steps).toContain('Q1 = 6');
    expect(steps).toContain('Q2 (median) = 12');
    expect(steps).toContain('Q3 = 16');
  });

  it('iqr inclusive with n=1 collapses both halves to the single value -> 0', () => {
    const r = stat('iqr', { data: '5', method: 'inclusive' });
    expect(r.value).toEqual({ numerator: 0, denominator: 1 });
  });
});

describe('solveStatistics — exact-vs-(decimal+tolerance) stddev distinction', () => {
  it('pop_stddev exact: [1,3] pop_variance = 1 -> sqrt = 1 (value defined, no tolerance)', () => {
    const r = stat('pop_stddev', { data: '1,3' });
    expect(r.supported).toBe(true);
    expect(r.value).toEqual({ numerator: 1, denominator: 1 });
    expect(r.tolerance).toBeUndefined();
  });

  it('pop_stddev exact non-trivial: [0,4] pop_variance = 4 -> sqrt = 2', () => {
    const r = stat('pop_stddev', { data: '0,4' });
    expect(r.value).toEqual({ numerator: 2, denominator: 1 });
    expect(r.tolerance).toBeUndefined();
  });

  it('pop_stddev decimal: [2,4,6,8] pop_variance = 5 -> sqrt(5) irrational (no value, tolerance set)', () => {
    const r = stat('pop_stddev', { data: '2,4,6,8' });
    expect(r.supported).toBe(true);
    expect(r.value).toBeUndefined();
    expect(r.decimal).toBeCloseTo(Math.sqrt(5), 12);
    expect(r.tolerance).toBeCloseTo(Math.max(1e-6 * Math.sqrt(5), 1e-9), 15);
  });

  it('sample_stddev decimal: [2,4,6,8] sample_variance = 20/3 -> sqrt irrational', () => {
    const r = stat('sample_stddev', { data: '2,4,6,8' });
    expect(r.value).toBeUndefined();
    expect(r.decimal).toBeCloseTo(Math.sqrt(20 / 3), 12);
    expect(r.tolerance).toBeCloseTo(1e-6 * Math.sqrt(20 / 3), 15);
  });
});

describe('solveStatistics — refusal on each out-of-scope category', () => {
  const refused = (r: ReturnType<typeof stat>) => {
    expect(r.supported).toBe(false);
    expect(r.value).toBeUndefined();
    expect(r.decimal).toBeUndefined();
  };

  it('empty dataset', () => refused(stat('mean', { data: '' })));
  it('whitespace-only dataset', () => refused(stat('mean', { data: '   ' })));

  it('sample statistics with n < 2', () => {
    refused(stat('sample_variance', { data: '5' }));
    refused(stat('sample_stddev', { data: '5' }));
  });

  it('non-unique mode (tie for max frequency)', () => {
    refused(stat('mode', { data: '1,1,2,2' }));
  });

  it('all-distinct data has no unique mode', () => {
    refused(stat('mode', { data: '1,2,3' }));
  });

  it('quartiles / iqr without a method', () => {
    refused(stat('iqr', { data: '1,2,3' }));
    refused(stat('quartiles', { data: '1,2,3' }));
  });

  it('quartiles / iqr with an invalid method', () => {
    refused(stat('iqr', { data: '1,2,3', method: 'midpoint' }));
  });

  it('iqr exclusive with n=1 (empty halves)', () => {
    refused(stat('iqr', { data: '5', method: 'exclusive' }));
  });

  it('non-rational tokens (decimal, alphabetic, zero denominator)', () => {
    refused(stat('mean', { data: '1.5,2' }));
    refused(stat('mean', { data: 'abc' }));
    refused(stat('mean', { data: '1/0,2' }));
    refused(stat('mean', { data: '3,,4' }));
  });

  it('out-of-scope kinds (percentile, correlation, hypothesis test)', () => {
    refused(bogusKind('percentile', { data: GOLDEN }));
    refused(bogusKind('correlation', { data: GOLDEN }));
    refused(bogusKind('t_test', { data: GOLDEN }));
  });

  it('missing required data param', () => {
    refused(stat('mean', {}));
  });
});

describe('solveStatistics — published bound enforcement', () => {
  it('publishes the bounds as constants', () => {
    expect(MAX_DATASET_SIZE).toBe(1000);
    expect(MAX_ABS_NUMERATOR).toBe(1_000_000);
    expect(MAX_DENOMINATOR).toBe(1_000_000);
  });

  it('refuses a dataset larger than MAX_DATASET_SIZE', () => {
    const big = Array.from({ length: MAX_DATASET_SIZE + 1 }, () => '1').join(',');
    const r = stat('mean', { data: big });
    expect(r.supported).toBe(false);
  });

  it('accepts a dataset exactly at MAX_DATASET_SIZE', () => {
    const atLimit = Array.from({ length: MAX_DATASET_SIZE }, () => '2').join(',');
    const r = stat('mean', { data: atLimit });
    expect(r.value).toEqual({ numerator: 2, denominator: 1 });
  });

  it('refuses a value whose numerator exceeds MAX_ABS_NUMERATOR', () => {
    const r = stat('mean', { data: `${MAX_ABS_NUMERATOR + 1}` });
    expect(r.supported).toBe(false);
  });

  it('refuses a value whose denominator exceeds MAX_DENOMINATOR', () => {
    const r = stat('mean', { data: `1/${MAX_DENOMINATOR + 1}` });
    expect(r.supported).toBe(false);
  });
});

describe('solveStatistics — total on adversarial input (never throws)', () => {
  const inputs: Array<[Kind, Record<string, number | string | boolean>]> = [
    ['mean', { data: '' }],
    ['mean', { data: 'not,a,number' }],
    ['mean', { data: `${Number.MAX_SAFE_INTEGER}` }],
    ['pop_variance', { data: '99999999999999999999' }],
    ['iqr', { data: '1,2,3' }],
    ['mean', {}],
    ['mean', { data: 5 }],
    ['mode', { data: ',,,' }],
    ['median', { data: '1/2/3' }],
    ['sample_stddev', { data: '4' }],
  ];

  for (const [kind, params] of inputs) {
    it(`does not throw for kind=${kind} params=${JSON.stringify(params)}`, () => {
      expect(() => solveStatistics({ discipline: 'statistics', kind, params } as StatisticsProblem)).not.toThrow();
    });
  }
});
