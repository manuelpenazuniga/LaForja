import { describe, expect, it } from 'vitest';

import {
  solveGeometry,
  MAX_LENGTH,
  MAX_COORDINATE,
  MAX_POLYGON_SIDES,
} from '@/solver/geometry';
import type { GeometryProblem } from '@/solver/types';

/** Build a geometry problem, allowing out-of-scope kinds via a controlled cast. */
function geo(kind: string, params: Record<string, number | string | boolean>): GeometryProblem {
  return { discipline: 'geometry', kind, params } as unknown as GeometryProblem;
}

describe('solveGeometry — exact rational kinds', () => {
  it('pythagoras 3,4 → exact 5 (perfect square, no tolerance)', () => {
    const r = solveGeometry(geo('pythagoras', { legA: 3, legB: 4 }));
    expect(r.supported).toBe(true);
    expect(r.value).toEqual({ numerator: 5, denominator: 1 });
    expect(r.decimal).toBe(5);
    expect(r.tolerance).toBeUndefined();
  });

  it('pythagoras leg+hyp → exact leg (4,5 → 3)', () => {
    const r = solveGeometry(geo('pythagoras', { legA: 4, hyp: 5 }));
    expect(r.value).toEqual({ numerator: 3, denominator: 1 });
    expect(r.decimal).toBe(3);
    expect(r.tolerance).toBeUndefined();
  });

  it('pythagoras with fractional legs 0.6,0.8 → exact 1', () => {
    const r = solveGeometry(geo('pythagoras', { legA: 0.6, legB: 0.8 }));
    expect(r.value).toEqual({ numerator: 1, denominator: 1 });
    expect(r.decimal).toBe(1);
    expect(r.tolerance).toBeUndefined();
  });

  it('area_rectangle 3,4 → 12', () => {
    const r = solveGeometry(geo('area_rectangle', { length: 3, width: 4 }));
    expect(r.value).toEqual({ numerator: 12, denominator: 1 });
    expect(r.decimal).toBe(12);
    expect(r.tolerance).toBeUndefined();
  });

  it('area_rectangle fractional 2.5,4 → 10', () => {
    const r = solveGeometry(geo('area_rectangle', { length: 2.5, width: 4 }));
    expect(r.value).toEqual({ numerator: 10, denominator: 1 });
    expect(r.decimal).toBe(10);
  });

  it('perimeter_rectangle 3,4 → 14', () => {
    const r = solveGeometry(geo('perimeter_rectangle', { length: 3, width: 4 }));
    expect(r.value).toEqual({ numerator: 14, denominator: 1 });
    expect(r.decimal).toBe(14);
  });

  it('area_triangle base/height 10,4 → 20', () => {
    const r = solveGeometry(geo('area_triangle', { base: 10, height: 4 }));
    expect(r.value).toEqual({ numerator: 20, denominator: 1 });
    expect(r.decimal).toBe(20);
    expect(r.tolerance).toBeUndefined();
  });

  it('area_triangle base/height odd product 5,3 → 15/2', () => {
    const r = solveGeometry(geo('area_triangle', { base: 5, height: 3 }));
    expect(r.value).toEqual({ numerator: 15, denominator: 2 });
    expect(r.decimal).toBe(7.5);
  });

  it('area_triangle Heron 3,4,5 (right) → exact 6', () => {
    const r = solveGeometry(geo('area_triangle', { a: 3, b: 4, c: 5 }));
    expect(r.value).toEqual({ numerator: 6, denominator: 1 });
    expect(r.decimal).toBe(6);
    expect(r.tolerance).toBeUndefined();
  });

  it('area_triangle Heron 5,5,6 → exact 12', () => {
    const r = solveGeometry(geo('area_triangle', { a: 5, b: 5, c: 6 }));
    expect(r.value).toEqual({ numerator: 12, denominator: 1 });
    expect(r.decimal).toBe(12);
  });

  it('perimeter_triangle 3,4,5 → 12', () => {
    const r = solveGeometry(geo('perimeter_triangle', { a: 3, b: 4, c: 5 }));
    expect(r.value).toEqual({ numerator: 12, denominator: 1 });
    expect(r.decimal).toBe(12);
  });

  it('polygon_angle_sum n=5 → 540', () => {
    const r = solveGeometry(geo('polygon_angle_sum', { n: 5 }));
    expect(r.value).toEqual({ numerator: 540, denominator: 1 });
    expect(r.decimal).toBe(540);
    expect(r.tolerance).toBeUndefined();
  });

  it('polygon_angle_sum n=3 → 180', () => {
    const r = solveGeometry(geo('polygon_angle_sum', { n: 3 }));
    expect(r.value).toEqual({ numerator: 180, denominator: 1 });
  });

  it('missing_angle triangle a=50,b=60 → 70', () => {
    const r = solveGeometry(geo('missing_angle', { a: 50, b: 60 }));
    expect(r.value).toEqual({ numerator: 70, denominator: 1 });
    expect(r.decimal).toBe(70);
    expect(r.tolerance).toBeUndefined();
  });

  it('missing_angle polygon n=4,sum_known=270 → 90', () => {
    const r = solveGeometry(geo('missing_angle', { n: 4, sum_known: 270 }));
    expect(r.value).toEqual({ numerator: 90, denominator: 1 });
    expect(r.decimal).toBe(90);
  });

  it('distance (0,0)-(3,4) → exact 5', () => {
    const r = solveGeometry(geo('distance', { x1: 0, y1: 0, x2: 3, y2: 4 }));
    expect(r.value).toEqual({ numerator: 5, denominator: 1 });
    expect(r.decimal).toBe(5);
    expect(r.tolerance).toBeUndefined();
  });

  it('distance with negative coordinates (-1,-1)-(2,3) → exact 5', () => {
    const r = solveGeometry(geo('distance', { x1: -1, y1: -1, x2: 2, y2: 3 }));
    expect(r.value).toEqual({ numerator: 5, denominator: 1 });
    expect(r.decimal).toBe(5);
  });
});

describe('solveGeometry — irrational (decimal + tolerance, no value)', () => {
  it('GOLDEN area_circle diameter=14, round_places=0 → π*49, tol 0.5', () => {
    const r = solveGeometry(geo('area_circle', { diameter: 14, round_places: 0 }));
    expect(r.supported).toBe(true);
    expect(r.value).toBeUndefined();
    expect(r.decimal).toBeCloseTo(153.938040, 5);
    expect(r.tolerance).toBe(0.5);
  });

  it('area_circle radius=7 (no round_places) → default relative tolerance', () => {
    const r = solveGeometry(geo('area_circle', { radius: 7 }));
    expect(r.value).toBeUndefined();
    expect(r.decimal).toBeCloseTo(153.938040, 5);
    // default = max(1e-6 * |decimal|, 1e-9)
    expect(r.tolerance).toBeCloseTo(1e-6 * (Math.PI * 49), 12);
  });

  it('circumference radius=7, round_places=2 → 2π·7, tol 0.005', () => {
    const r = solveGeometry(geo('circumference', { radius: 7, round_places: 2 }));
    expect(r.value).toBeUndefined();
    expect(r.decimal).toBeCloseTo(43.982297, 5);
    expect(r.tolerance).toBe(0.005);
  });

  it('circumference diameter=10 → 10π', () => {
    const r = solveGeometry(geo('circumference', { diameter: 10 }));
    expect(r.value).toBeUndefined();
    expect(r.decimal).toBeCloseTo(31.415926, 5);
  });

  it('pythagoras 1,1 → sqrt(2) decimal + tolerance, no value', () => {
    const r = solveGeometry(geo('pythagoras', { legA: 1, legB: 1 }));
    expect(r.value).toBeUndefined();
    expect(r.decimal).toBeCloseTo(Math.SQRT2, 12);
    expect(r.tolerance).toBeDefined();
    expect(r.tolerance).toBeGreaterThan(0);
  });

  it('area_triangle Heron 2,3,4 → irrational (not a perfect square)', () => {
    const r = solveGeometry(geo('area_triangle', { a: 2, b: 3, c: 4, round_places: 4 }));
    expect(r.value).toBeUndefined();
    // s=4.5, product=4.5*2.5*1.5*0.5=8.4375, sqrt=2.9047375...
    expect(r.decimal).toBeCloseTo(2.904738, 5);
    expect(r.tolerance).toBe(0.5 * 10 ** -4);
  });

  it('distance (0,0)-(1,1) → sqrt(2) decimal + tolerance', () => {
    const r = solveGeometry(geo('distance', { x1: 0, y1: 0, x2: 1, y2: 1 }));
    expect(r.value).toBeUndefined();
    expect(r.decimal).toBeCloseTo(Math.SQRT2, 12);
    expect(r.tolerance).toBeDefined();
  });
});

describe('solveGeometry — refusals (out of scope / degenerate / missing)', () => {
  const refuses = (r: { supported: boolean; value?: unknown; decimal?: unknown }) => {
    expect(r.supported).toBe(false);
    expect(r.value).toBeUndefined();
    expect(r.decimal).toBeUndefined();
  };

  it('out-of-scope kind: volume', () => {
    refuses(solveGeometry(geo('volume', { side: 3 })));
  });

  it('out-of-scope kind: trapezoid area', () => {
    refuses(solveGeometry(geo('area_trapezoid', { a: 3, b: 4, height: 5 })));
  });

  it('out-of-scope kind: sector area', () => {
    refuses(solveGeometry(geo('sector_area', { radius: 3, angle: 90 })));
  });

  it('out-of-scope kind: midpoint (explicitly not in this build)', () => {
    refuses(solveGeometry(geo('midpoint', { x1: 0, y1: 0, x2: 2, y2: 2 })));
  });

  it('negative length: area_rectangle', () => {
    refuses(solveGeometry(geo('area_rectangle', { length: -3, width: 4 })));
  });

  it('zero length: perimeter_rectangle', () => {
    refuses(solveGeometry(geo('perimeter_rectangle', { length: 0, width: 4 })));
  });

  it('degenerate triangle (inequality fails): Heron 1,1,5', () => {
    refuses(solveGeometry(geo('area_triangle', { a: 1, b: 1, c: 5 })));
  });

  it('degenerate triangle (equality): Heron 1,2,3', () => {
    refuses(solveGeometry(geo('area_triangle', { a: 1, b: 2, c: 3 })));
  });

  it('pythagoras hyp <= leg refuses', () => {
    refuses(solveGeometry(geo('pythagoras', { legA: 5, hyp: 5 })));
    refuses(solveGeometry(geo('pythagoras', { legA: 6, hyp: 5 })));
  });

  it('pythagoras with all three given refuses (over-specified)', () => {
    refuses(solveGeometry(geo('pythagoras', { legA: 3, legB: 4, hyp: 5 })));
  });

  it('pythagoras with only one given refuses', () => {
    refuses(solveGeometry(geo('pythagoras', { legA: 3 })));
  });

  it('polygon_angle_sum n<3 refuses', () => {
    refuses(solveGeometry(geo('polygon_angle_sum', { n: 2 })));
  });

  it('polygon_angle_sum non-integer n refuses', () => {
    refuses(solveGeometry(geo('polygon_angle_sum', { n: 5.5 })));
  });

  it('missing_angle triangle with a+b >= 180 refuses', () => {
    refuses(solveGeometry(geo('missing_angle', { a: 120, b: 60 })));
    refuses(solveGeometry(geo('missing_angle', { a: 150, b: 60 })));
  });

  it('missing_angle polygon with sum_known >= total refuses', () => {
    // triangle total 180; sum_known 180 leaves 0
    refuses(solveGeometry(geo('missing_angle', { n: 3, sum_known: 180 })));
    refuses(solveGeometry(geo('missing_angle', { n: 3, sum_known: 200 })));
  });

  it('circle with both radius and diameter refuses (ambiguous)', () => {
    refuses(solveGeometry(geo('area_circle', { radius: 3, diameter: 6 })));
  });

  it('circle with neither radius nor diameter refuses', () => {
    refuses(solveGeometry(geo('area_circle', {})));
  });

  it('non-numeric parameter refuses', () => {
    refuses(solveGeometry(geo('area_rectangle', { length: '3', width: 4 })));
    refuses(solveGeometry(geo('area_rectangle', { length: true, width: 4 })));
  });

  it('missing required parameter refuses', () => {
    refuses(solveGeometry(geo('area_rectangle', { length: 3 })));
    refuses(solveGeometry(geo('distance', { x1: 0, y1: 0, x2: 3 })));
  });

  it('invalid round_places refuses the whole call', () => {
    refuses(solveGeometry(geo('area_circle', { diameter: 14, round_places: -1 })));
    refuses(solveGeometry(geo('area_circle', { diameter: 14, round_places: 1.5 })));
    refuses(solveGeometry(geo('area_circle', { diameter: 14, round_places: 'two' })));
  });
});

describe('solveGeometry — magnitude bounds', () => {
  it('length over MAX_LENGTH refuses', () => {
    const r = solveGeometry(geo('area_rectangle', { length: MAX_LENGTH + 1, width: 4 }));
    expect(r.supported).toBe(false);
  });

  it('length exactly MAX_LENGTH is accepted', () => {
    const r = solveGeometry(geo('perimeter_rectangle', { length: MAX_LENGTH, width: MAX_LENGTH }));
    expect(r.supported).toBe(true);
    expect(r.value).toEqual({ numerator: 4 * MAX_LENGTH, denominator: 1 });
  });

  it('coordinate over MAX_COORDINATE refuses', () => {
    const r = solveGeometry(
      geo('distance', { x1: 0, y1: 0, x2: MAX_COORDINATE + 1, y2: 0 }),
    );
    expect(r.supported).toBe(false);
  });

  it('polygon sides over MAX_POLYGON_SIDES refuses', () => {
    const r = solveGeometry(geo('polygon_angle_sum', { n: MAX_POLYGON_SIDES + 1 }));
    expect(r.supported).toBe(false);
  });
});

describe('solveGeometry — never throws on adversarial input', () => {
  const adversarial: Array<Record<string, number | string | boolean>> = [
    {},
    { length: '' },
    { length: 'not-a-number', width: 'xyz' },
    { length: Number.NaN, width: Number.POSITIVE_INFINITY },
    { length: 1e300, width: 1e300 },
    { a: '1,2,3,4', b: 'null' },
    { n: Number.MAX_SAFE_INTEGER },
    { radius: Number.NEGATIVE_INFINITY },
    { x1: Number.NaN, y1: 0, x2: 0, y2: 0 },
    { round_places: Number.NaN },
  ];

  for (const kind of [
    'pythagoras',
    'area_rectangle',
    'perimeter_rectangle',
    'area_triangle',
    'perimeter_triangle',
    'area_circle',
    'circumference',
    'polygon_angle_sum',
    'missing_angle',
    'distance',
    'unknown_kind',
  ]) {
    it(`kind '${kind}' returns a valid SolverResult for every adversarial payload`, () => {
      for (const params of adversarial) {
        const r = solveGeometry(geo(kind, params));
        expect(typeof r.supported).toBe('boolean');
        if (!r.supported) {
          expect(r.value).toBeUndefined();
          expect(r.decimal).toBeUndefined();
        }
      }
    });
  }

  it('exact-mode results never carry a tolerance; decimal-mode never a value', () => {
    const exact = solveGeometry(geo('area_rectangle', { length: 3, width: 4 }));
    expect(exact.value).toBeDefined();
    expect(exact.tolerance).toBeUndefined();

    const decimal = solveGeometry(geo('area_circle', { radius: 2 }));
    expect(decimal.value).toBeUndefined();
    expect(decimal.tolerance).toBeDefined();
  });
});
