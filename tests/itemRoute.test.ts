/**
 * LA FORJA — POST /api/item, the AUTHOR-FROM-SCRATCH path (doc §3/§4).
 *
 * OWNER: Claude, end to end. This route touches no Codex-owned internal, so every
 * suite here is LIVE and must pass today. It resolves a session and writes a
 * DRAFT Item + its v1 ItemVersion, then returns the same payload shape
 * /api/session returns for a demo item so the studio can drop it straight into
 * its existing item state.
 *
 * No network, no database: prisma is mocked and each create/update is captured.
 *
 * What these tests refuse to let slide:
 *  1. A from-scratch item is a DRAFT, non-demo, session-owned original — and it
 *     is NOT publishable and NOT CC-BY (doc §9: visitor contributions are
 *     private/ephemeral, never published).
 *  2. A correctKey that indexes past the options is a silently unanswerable item,
 *     rejected as a typed 400 before any row is written.
 *  3. The discipline is validated; a bad or absent one is a typed 400.
 *  4. The item is owned by the CALLER's session and nothing else (isolation).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Prisma mock. Declared before the route import so the module graph never
// instantiates a real client.
// ---------------------------------------------------------------------------

const sessionCreateMock = vi.fn();
const sessionFindUniqueMock = vi.fn();
const itemCreateMock = vi.fn();
const itemUpdateMock = vi.fn();
const itemVersionCreateMock = vi.fn();

vi.mock('@/db/client', () => ({
  prisma: {
    session: {
      create: (...args: unknown[]) => sessionCreateMock(...args),
      findUnique: (...args: unknown[]) => sessionFindUniqueMock(...args),
    },
    item: {
      create: (...args: unknown[]) => itemCreateMock(...args),
      update: (...args: unknown[]) => itemUpdateMock(...args),
    },
    itemVersion: {
      create: (...args: unknown[]) => itemVersionCreateMock(...args),
    },
  },
  toJson: (value: unknown) => JSON.stringify(value),
  fromJson: (text: string) => JSON.parse(text) as unknown,
}));

const { handleCreateItem } = await import('@/app/api/item/logic');
const { SESSION_COOKIE, resetRateLimiter } = await import('@/demo/isolation');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = 'sess_live';
const ITEM_ID = 'item_scratch_1';
const V1_ID = 'ver_scratch_1';

/** The Prisma schema default license for a non-team-authored item. */
const DEFAULT_LICENSE = 'unlicensed-ephemeral';

const STEM =
  'A fair coin is flipped three times. What is the probability of getting exactly two heads?';
const OPTIONS = ['1/8', '3/8', '1/2', '5/8'];
const CORRECT_KEY = 'B';
const RATIONALE =
  'There are C(3,2)=3 favourable arrangements out of 8 equally likely outcomes, so P = 3/8.';

const VALID_BODY = {
  stem: STEM,
  options: OPTIONS,
  correctKey: CORRECT_KEY,
  authorRationale: RATIONALE,
  discipline: 'probability',
};

const NOW = new Date('2026-07-21T12:00:00.000Z');

function liveSession(id: string) {
  return {
    id,
    pseudonym: 'MoltenCrucible417',
    createdAt: NOW,
    expiresAt: new Date(Date.now() + 20 * 60_000),
  };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

interface RequestOptions {
  cookie?: string | null;
  address?: string;
  raw?: string;
}

function post(body: unknown, options: RequestOptions = {}): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': options.address ?? '203.0.113.7',
  };
  const cookie = options.cookie === undefined ? SESSION_ID : options.cookie;
  if (cookie !== null) headers.cookie = `${SESSION_COOKIE}=${cookie}`;

  return new Request('https://demo.invalid/api/item', {
    method: 'POST',
    headers,
    body: options.raw ?? JSON.stringify(body),
  });
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function errorBody(res: Response): Promise<{ code: string; message: string }> {
  const body = (await res.json()) as { error: { code: string; message: string } };
  return body.error;
}

/** Args captured from the last item.create call. */
function itemCreateData(): Record<string, unknown> {
  const call = itemCreateMock.mock.calls[0]?.[0] as { data: Record<string, unknown> } | undefined;
  return call?.data ?? {};
}

function versionCreateData(): Record<string, unknown> {
  const call = itemVersionCreateMock.mock.calls[0]?.[0] as
    | { data: Record<string, unknown> }
    | undefined;
  return call?.data ?? {};
}

let mintCounter = 0;

beforeEach(() => {
  resetRateLimiter();
  for (const mock of [
    sessionCreateMock,
    sessionFindUniqueMock,
    itemCreateMock,
    itemUpdateMock,
    itemVersionCreateMock,
  ]) {
    mock.mockReset();
  }

  mintCounter = 0;
  sessionFindUniqueMock.mockImplementation((args: { where: { id: string } }) =>
    Promise.resolve(args.where.id === SESSION_ID ? liveSession(SESSION_ID) : null),
  );
  sessionCreateMock.mockImplementation(() => {
    mintCounter += 1;
    return Promise.resolve(liveSession(`sess_minted_${mintCounter}`));
  });

  // item.create echoes its data back with an id and the schema license default
  // (the route omits license so it can inherit that default).
  itemCreateMock.mockImplementation((args: { data: Record<string, unknown> }) =>
    Promise.resolve({
      id: ITEM_ID,
      license: DEFAULT_LICENSE,
      ...args.data,
    }),
  );
  itemVersionCreateMock.mockImplementation((args: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: V1_ID, ...args.data }),
  );
  itemUpdateMock.mockImplementation((args: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: ITEM_ID, ...args.data }),
  );
});

// ===========================================================================
// Happy path
// ===========================================================================

describe('creating a from-scratch item', () => {
  it('creates a DRAFT, non-demo, non-publishable original and returns the studio payload', async () => {
    const res = await handleCreateItem(post(VALID_BODY));

    expect(res.status).toBe(200);
    const payload = await bodyOf(res);

    // The payload the studio drops into its existing item state.
    expect(payload.itemId).toBe(ITEM_ID);
    expect(payload.versionId).toBe(V1_ID);
    expect(payload.versionNumber).toBe(1);
    expect(payload.state).toBe('DRAFT');
    expect(payload.discipline).toBe('probability');
    expect(payload.stem).toBe(STEM);
    expect(payload.options).toEqual(OPTIONS);
    expect(payload.correctKey).toBe(CORRECT_KEY);
    expect(payload.authorRationale).toBe(RATIONALE);
    expect(payload.immutable).toBe(false);

    // Doc §9: a visitor original is private/ephemeral — never CC-BY, never
    // publishable.
    expect(payload.license).toBe(DEFAULT_LICENSE);
    expect(payload.license).not.toMatch(/cc-?by/i);
    expect(payload.provenance).toBeTruthy();

    // The Item row itself: DRAFT, non-demo, not team-authored, not eligible.
    const item = itemCreateData();
    expect(item.state).toBe('DRAFT');
    expect(item.discipline).toBe('probability');
    expect(item.isDemo).toBe(false);
    expect(item.isTeamAuthored).toBe(false);
    expect(item.publicationEligible).toBe(false);
    // License is NOT hard-coded here — it inherits the schema default.
    expect(item.license).toBeUndefined();

    // v1: version 1, mutable, options crossing the JSON boundary via toJson.
    const version = versionCreateData();
    expect(version.itemId).toBe(ITEM_ID);
    expect(version.versionNumber).toBe(1);
    expect(version.immutable).toBe(false);
    expect(version.correctKey).toBe(CORRECT_KEY);
    expect(version.optionsJson).toBe(JSON.stringify(OPTIONS));

    // The current-version pointer is wired so the gauntlet can load this head.
    expect(itemUpdateMock).toHaveBeenCalledTimes(1);
    const update = itemUpdateMock.mock.calls[0]?.[0] as {
      where: { id: string };
      data: { currentVersionId: string };
    };
    expect(update.where.id).toBe(ITEM_ID);
    expect(update.data.currentVersionId).toBe(V1_ID);
  });

  it('does not leak the session id, pseudonym or a model id in the response', async () => {
    const res = await handleCreateItem(post(VALID_BODY));
    const text = JSON.stringify(await bodyOf(res));

    for (const forbidden of [SESSION_ID, 'MoltenCrucible417', 'pseudonym', 'sk-', 'gpt-']) {
      expect(text, `the create response leaked ${forbidden}`).not.toContain(forbidden);
    }
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('set-cookie')).toContain(SESSION_COOKIE);
  });
});

// ===========================================================================
// Session scoping (isolation)
// ===========================================================================

describe('the item is owned by the caller session and nothing else', () => {
  it('stamps the resolved session id on the created item', async () => {
    await handleCreateItem(post(VALID_BODY, { cookie: SESSION_ID }));
    expect(itemCreateData().sessionId).toBe(SESSION_ID);
  });

  it('mints a fresh session for a cookie-less caller and owns the item to it', async () => {
    await handleCreateItem(post(VALID_BODY, { cookie: null }));

    expect(sessionCreateMock).toHaveBeenCalledTimes(1);
    expect(itemCreateData().sessionId).toBe('sess_minted_1');
    // Never the well-known live session — a new visitor gets their own.
    expect(itemCreateData().sessionId).not.toBe(SESSION_ID);
  });

  it('replaces an expired session instead of resurrecting it', async () => {
    sessionFindUniqueMock.mockResolvedValue({
      id: SESSION_ID,
      pseudonym: 'QuietForge321',
      createdAt: new Date(Date.now() - 60 * 60_000),
      expiresAt: new Date(Date.now() - 60_000),
    });

    const res = await handleCreateItem(post(VALID_BODY));
    expect(res.status).toBe(200);
    expect(sessionCreateMock).toHaveBeenCalledTimes(1);
    expect(itemCreateData().sessionId).toBe('sess_minted_1');
  });
});

// ===========================================================================
// Validation — a typed 400 envelope, and no row written
// ===========================================================================

describe('the validation envelope', () => {
  it('rejects a correctKey that points past the supplied options', async () => {
    const res = await handleCreateItem(
      post({ ...VALID_BODY, options: ['1/2', '1/3'], correctKey: 'D' }),
    );

    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe('invalid_body');
    // The detail names the offending field.
    const res2 = await handleCreateItem(
      post({ ...VALID_BODY, options: ['1/2', '1/3'], correctKey: 'D' }),
    );
    expect(JSON.stringify(await bodyOf(res2))).toContain('correctKey');
    // Nothing was written.
    expect(itemCreateMock).not.toHaveBeenCalled();
    expect(itemVersionCreateMock).not.toHaveBeenCalled();
  });

  it('rejects a bad discipline', async () => {
    const res = await handleCreateItem(post({ ...VALID_BODY, discipline: 'astrology' }));
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe('invalid_body');
    expect(itemCreateMock).not.toHaveBeenCalled();
  });

  it('rejects an absent discipline', async () => {
    const noDiscipline = {
      stem: STEM,
      options: OPTIONS,
      correctKey: CORRECT_KEY,
      authorRationale: RATIONALE,
    };
    const res = await handleCreateItem(post(noDiscipline));
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe('invalid_body');
    expect(itemCreateMock).not.toHaveBeenCalled();
  });

  it('rejects too few options', async () => {
    const res = await handleCreateItem(post({ ...VALID_BODY, options: ['only one'] }));
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe('invalid_body');
    expect(itemCreateMock).not.toHaveBeenCalled();
  });

  it('rejects a blank stem, a blank option and a blank rationale', async () => {
    const bodies = [
      { ...VALID_BODY, stem: '' },
      { ...VALID_BODY, options: ['1/2', ''] },
      { ...VALID_BODY, authorRationale: '' },
    ];
    for (const body of bodies) {
      const res = await handleCreateItem(post(body));
      expect(res.status, `body ${JSON.stringify(body).slice(0, 50)} was accepted`).toBe(400);
      expect((await errorBody(res)).code).toBe('invalid_body');
    }
    expect(itemCreateMock).not.toHaveBeenCalled();
  });

  it('rejects unknown fields rather than silently ignoring them', async () => {
    const res = await handleCreateItem(post({ ...VALID_BODY, sessionId: 'sess_other' }));
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe('invalid_body');
    expect(itemCreateMock).not.toHaveBeenCalled();
  });

  it('returns a typed invalid_json envelope on a malformed body', async () => {
    const res = await handleCreateItem(post(null, { raw: '{not json' }));
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe('invalid_json');
    expect(itemCreateMock).not.toHaveBeenCalled();
  });

  it('refuses an oversized stem with 413 before writing a row', async () => {
    const res = await handleCreateItem(post({ ...VALID_BODY, stem: 'x'.repeat(100_000) }));
    expect(res.status).toBe(413);
    expect((await errorBody(res)).code).toBe('input_too_large');
    expect(itemCreateMock).not.toHaveBeenCalled();
  });
});
