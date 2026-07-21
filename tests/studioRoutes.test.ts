/**
 * LA FORJA — the client/route contract.
 *
 * OWNER: Claude (API envelopes + the client stubs that call them).
 *
 * The studio's data access is a set of `TODO(codex)` stubs. A stub that names an
 * endpoint which does not exist is worse than an unimplemented one: a Codex
 * session follows the comment, builds the wrong route, and either stalls or
 * ships a handler with no isolation envelope (doc §10 session resolution, rate
 * limit, input size caps, Zod validation). This suite makes that class of drift
 * a test failure instead of a discovery made at wiring time.
 *
 * Three guards, all executable:
 *  1. Every /api path named in src/app/** resolves to a route file on disk.
 *  2. The four endpoints that never existed stay dead.
 *  3. The result types can represent the states the UI claims to handle.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DefenseResult, RepairResult } from '@/app/StudioClient';
import type { ReRunOutcome } from '@/core/checks';
import type { CheckClass } from '@/core/types';

const APP_DIR = fileURLToPath(new URL('../src/app', import.meta.url));

function read(relative: string): string {
  return readFileSync(join(APP_DIR, relative), 'utf8');
}

/**
 * Walks src/app/api and derives the endpoints that actually exist from the
 * route files themselves, so the expectation cannot drift from the filesystem.
 * A `[param]` directory becomes a `:param` segment.
 */
function discoverRoutes(dir: string, prefix = '/api'): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      const segment = entry.startsWith('[') ? `:${entry.slice(1, -1)}` : entry;
      found.push(...discoverRoutes(full, `${prefix}/${segment}`));
    } else if (entry === 'route.ts') {
      found.push(prefix);
    }
  }
  return found;
}

const REAL_ROUTES = discoverRoutes(join(APP_DIR, 'api')).sort();

/**
 * Reduces a path to the shape used for comparison. A dynamic segment collapses
 * to `:param` however it was written — `${itemId}` in a template literal,
 * `[itemId]` in prose, or `:itemId` from the directory name — so the guard tests
 * the ROUTE, not the spelling of its parameter.
 */
function canonical(path: string): string {
  return path
    .replace(/\/\$\{[^}]+\}/g, '/:param') // GET /api/passport/${itemId}
    .replace(/\/\[[^\]]+\]/g, '/:param') // GET /api/passport/[itemId]
    .replace(/\/:[A-Za-z0-9_]+/g, '/:param') // /api/passport/:itemId
    .replace(/[?#].*$/, '') // strip any query string
    .replace(/\/+$/, '');
}

const CANONICAL_ROUTES = REAL_ROUTES.map(canonical);

describe('the five routes that exist', () => {
  it('is exactly the set the studio is allowed to call', () => {
    expect(REAL_ROUTES).toEqual([
      '/api/defense',
      '/api/gauntlet',
      '/api/passport/:itemId',
      '/api/repair',
      '/api/session',
    ]);
  });
});

describe('client stubs point at routes that exist', () => {
  /**
   * The studio lives at /studio (the landing page owns /). StudioClient.tsx and
   * studio/page.tsx are the files that talk about endpoints; the landing page
   * (page.tsx) and the onboarding drawer are presentation-only, so they are
   * scanned for drift but not required to name any endpoint.
   */
  const sources = ['StudioClient.tsx', 'studio/page.tsx'];
  const presentationOnly = ['page.tsx', 'OnboardingDrawer.tsx'];

  for (const file of [...sources, ...presentationOnly]) {
    it(`${file} names no endpoint without a route file`, () => {
      const text = read(file);
      const referenced = new Set<string>();
      // Every /api/... occurrence, including template literals and [param] forms.
      for (const match of text.matchAll(/\/api\/[A-Za-z0-9_\-/[\]$${}]*/g)) {
        const path = canonical(match[0]);
        if (path.length > '/api'.length) referenced.add(path);
      }

      if (sources.includes(file)) expect(referenced.size).toBeGreaterThan(0);
      for (const path of referenced) {
        expect(
          CANONICAL_ROUTES.includes(path),
          `${file} references ${path}, which has no route.ts. The routes are the ` +
            `source of truth: ${REAL_ROUTES.join(', ')}.`,
        ).toBe(true);
      }
    });
  }

  /**
   * These four were named by the stubs but never implemented. /api/rerun is the
   * dangerous one: the history re-run already happens inside /api/repair, so a
   * second endpoint would execute the whole history twice and write duplicate
   * HistoryReRun rows.
   */
  const PHANTOM_ENDPOINTS = [
    '/api/rerun',
    '/api/defense/questions',
    '/api/defense/score',
    '/api/passport?itemId',
  ];

  for (const endpoint of PHANTOM_ENDPOINTS) {
    it(`never resurrects ${endpoint}`, () => {
      for (const file of [...sources, ...presentationOnly]) {
        expect(read(file), `${file} still references ${endpoint}`).not.toContain(endpoint);
      }
      // And it must not quietly appear as a real route either.
      expect(CANONICAL_ROUTES).not.toContain(canonical(endpoint));
    });
  }
});

describe('no affordance opens the out-of-slice dispute path', () => {
  /**
   * DISPUTED / NEW_DISPUTE / DISPUTE_REPAIR are outside the winning slice
   * (src/core/types.ts SCOPE NOTE). DISPUTED may be NAMED — it is rendered as a
   * non-interactive branch label tagged "next" — but no control may dispatch a
   * transition into it.
   */
  it('dispatches neither NEW_DISPUTE nor DISPUTE_REPAIR', () => {
    const text = read('StudioClient.tsx');
    for (const event of ['NEW_DISPUTE', 'DISPUTE_REPAIR']) {
      expect(text, `StudioClient dispatches ${event}, which is out of slice`).not.toContain(
        `applyEvent('${event}')`,
      );
      expect(text).not.toContain(`'${event}'`);
    }
  });
});

describe('result types can represent what the UI handles', () => {
  /**
   * The repair response carries the history re-run, because /api/repair performs
   * it. A RepairResult that discarded this payload would leave screen 05 with no
   * source of data and invite a second re-run call.
   */
  it('RepairResult carries the re-run payload and the resulting state', () => {
    const byClass: Record<CheckClass, ReRunOutcome[]> = {
      deterministic: [
        {
          originalCheckId: 'chk_1',
          checkClass: 'deterministic',
          result: 'pass',
          blocksPublish: false,
        },
      ],
      counterexample: [],
      semantic: [],
    };
    const repaired: RepairResult = {
      itemId: 'item_1',
      newVersionId: 'ver_2',
      versionNumber: 2,
      diff: '- one of them is a boy\n+ the elder is a boy',
      reRun: { byClass, blocksPublish: false, total: 1 },
      state: 'DEFENSE',
    };

    expect(repaired.reRun.byClass.deterministic).toHaveLength(1);
    expect(repaired.reRun.blocksPublish).toBe(false);
    expect(repaired.state).toBe('DEFENSE');
  });

  /**
   * THE DEFECT THIS FILE WAS ADDED FOR: an evaluator failure is a 200 with
   * outcome 'inconclusive' and NO rubric — never an error, never an auto-reject
   * (doc §6.3). A non-nullable `rubric` made the DEFENSE_EVALUATOR_FAILED case
   * unrepresentable by the very type whose event union claimed to handle it.
   */
  it('DefenseResult can represent an evaluator failure', () => {
    const inconclusive: DefenseResult = {
      rubric: null,
      outcome: 'inconclusive',
      state: 'DEFENSE_INCONCLUSIVE',
      event: 'DEFENSE_EVALUATOR_FAILED',
    };

    expect(inconclusive.rubric).toBeNull();
    expect(inconclusive.outcome).toBe('inconclusive');
    // Inconclusive is a retryable branch, never a rejection.
    expect(inconclusive.state).toBe('DEFENSE_INCONCLUSIVE');
    expect(inconclusive.event).not.toBe('DEFENSE_FAILED');
  });

  it('DefenseResult still represents a pass', () => {
    const passed: DefenseResult = {
      rubric: {
        dimensions: [
          { dimension: 'identifies_error', score: 2, evidence: 'quotes the answer' },
          { dimension: 'explains_uniqueness', score: 1, evidence: 'partial' },
          { dimension: 'answers_variation', score: 2, evidence: 'correct' },
        ],
        total: 5,
        outcome: 'passed',
      },
      outcome: 'passed',
      state: 'PUBLISHED',
      event: 'DEFENSE_PASSED',
    };

    expect(passed.rubric?.total).toBe(5);
    expect(passed.state).toBe('PUBLISHED');
  });
});
