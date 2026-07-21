/**
 * LA FORJA — regression suite for demo isolation rate limiting (doc §10).
 *
 * OWNER: Claude (demo-isolation infrastructure).
 *
 * THE DEFECT THIS PINS: the limiter used to be keyed ONLY on the session id.
 * Every request arriving without a cookie minted a brand new Session row, so the
 * window looked up was always empty and NO REQUEST WAS EVER DENIED — an attacker
 * just never sent a cookie. Doc §10 exists so "a troll cannot spam the bank
 * during judging"; keying on a client-controlled identifier alone defeats it.
 *
 * The fix keys the limiter on the client address as well, with a separate and
 * tighter budget on session CREATION. These tests fail if either budget is
 * removed or if the per-session budget is ever the only one enforced again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createMock = vi.fn();
const findUniqueMock = vi.fn();

vi.mock('@/db/client', () => ({
  prisma: {
    session: {
      create: (...args: unknown[]) => createMock(...args),
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
    },
  },
  toJson: (value: unknown) => JSON.stringify(value),
  fromJson: (text: string) => JSON.parse(text) as unknown,
}));

const {
  ApiError,
  SESSION_COOKIE,
  UNKNOWN_CLIENT_IP,
  clientIp,
  consumeRateLimit,
  getOrCreateSession,
  loadIsolationConfig,
  rateLimitKeys,
  resetRateLimiter,
} = await import('@/demo/isolation');

type Config = ReturnType<typeof loadIsolationConfig>;

const config: Config = {
  sessionTtlMinutes: 30,
  maxInputChars: 4000,
  rateLimitPerMinute: 20,
  ipRateLimitPerMinute: 5,
  sessionCreatePerMinute: 2,
  // Deliberately larger than sessionCreatePerMinute so the per-address budget is
  // what bites in the single-address tests below; the header-rotation test drops
  // it to prove the ceiling is what stops that case.
  globalSessionCreatePerMinute: 8,
};

const NOW = new Date('2026-07-21T12:00:00.000Z');

/** A request from `address`, with no session cookie — the attacker's shape. */
function anonymousRequest(address = '203.0.113.7'): Request {
  return new Request('https://demo.invalid/api/gauntlet', {
    method: 'POST',
    headers: { 'x-forwarded-for': address },
  });
}

let sessionCounter = 0;

beforeEach(() => {
  resetRateLimiter();
  createMock.mockReset();
  findUniqueMock.mockReset();
  sessionCounter = 0;
  createMock.mockImplementation(() => {
    sessionCounter += 1;
    return Promise.resolve({
      id: `sess_${sessionCounter}`,
      pseudonym: `IronAnvil${100 + sessionCounter}`,
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 30 * 60_000),
    });
  });
  findUniqueMock.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// The bypass itself
// ---------------------------------------------------------------------------

describe('cookie-less traffic is rate limited (the bypass)', () => {
  it('denies a flood of requests that never send a cookie', async () => {
    const attempts: string[] = [];

    for (let i = 0; i < 12; i += 1) {
      try {
        await getOrCreateSession(anonymousRequest(), { config, now: NOW });
        attempts.push('allowed');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        attempts.push((err as InstanceType<typeof ApiError>).code);
      }
    }

    // Before the fix this was twelve 'allowed'. Now the address-keyed budgets
    // bite: the run MUST contain denials.
    expect(attempts).toContain('rate_limited');
    expect(attempts.filter((a) => a === 'allowed').length).toBeLessThan(12);
  });

  it('bounds session minting far below the general request budget', async () => {
    let minted = 0;
    for (let i = 0; i < 10; i += 1) {
      try {
        await getOrCreateSession(anonymousRequest(), { config, now: NOW });
        minted += 1;
      } catch {
        /* denied */
      }
    }
    // sessionCreatePerMinute = 2, and it is charged BEFORE the database write.
    expect(minted).toBe(config.sessionCreatePerMinute);
    expect(createMock).toHaveBeenCalledTimes(config.sessionCreatePerMinute);
  });

  it('throws a typed 429 rather than leaking an internal error', async () => {
    for (let i = 0; i < config.sessionCreatePerMinute; i += 1) {
      await getOrCreateSession(anonymousRequest(), { config, now: NOW });
    }
    await expect(getOrCreateSession(anonymousRequest(), { config, now: NOW })).rejects.toMatchObject(
      { status: 429, code: 'rate_limited' },
    );
  });

  it('does not let one address exhaust another address budget', async () => {
    for (let i = 0; i < 8; i += 1) {
      await getOrCreateSession(anonymousRequest('198.51.100.1'), { config, now: NOW }).catch(
        () => undefined,
      );
    }
    // A different address still gets its own fresh window.
    await expect(
      getOrCreateSession(anonymousRequest('198.51.100.2'), { config, now: NOW }),
    ).resolves.toMatchObject({ created: true });
  });

  it('still serves a live cookie-carrying session without charging the create budget', async () => {
    findUniqueMock.mockResolvedValue({
      id: 'sess_live',
      pseudonym: 'QuietForge321',
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 10 * 60_000),
    });
    const req = new Request('https://demo.invalid/api/gauntlet', {
      method: 'POST',
      headers: {
        'x-forwarded-for': '203.0.113.9',
        cookie: `${SESSION_COOKIE}=sess_live`,
      },
    });

    for (let i = 0; i < config.ipRateLimitPerMinute; i += 1) {
      const resolution = await getOrCreateSession(req, { config, now: NOW });
      expect(resolution.created).toBe(false);
    }
    expect(createMock).not.toHaveBeenCalled();
  });

  /**
   * THE SECOND BYPASS, found by running the first fix rather than reading it.
   *
   * `ip:` and `new:` are both keyed on a forwarded header, and a forwarded header
   * is attacker-controlled. Measured against the real getOrCreateSession with the
   * shipped defaults, 60 cookie-less requests that rotated X-Forwarded-For scored
   * allowed=60 denied=0 sessionsMinted=60: every address-keyed budget saw a fresh
   * window, so one Session ROW was written per request with no ceiling at all.
   *
   * `globalSessionCreatePerMinute` is keyed on a constant, so no header the caller
   * sends can move it. This test fails if that ceiling is removed or is ever
   * keyed on the address.
   */
  it('bounds session minting even when the forwarded header rotates every request', async () => {
    const rotating: Config = { ...config, globalSessionCreatePerMinute: 4 };
    let minted = 0;

    for (let i = 0; i < 40; i += 1) {
      // A different claimed address every time — this resets ip: and new: both.
      const req = anonymousRequest(`198.51.100.${i}`);
      try {
        await getOrCreateSession(req, { config: rotating, now: NOW });
        minted += 1;
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as InstanceType<typeof ApiError>).status).toBe(429);
      }
    }

    // Without the global ceiling this was 40. The row write is what is bounded.
    expect(minted).toBe(rotating.globalSessionCreatePerMinute);
    expect(createMock).toHaveBeenCalledTimes(rotating.globalSessionCreatePerMinute);
  });

  it('charges the per-address budget BEFORE the shared ceiling', async () => {
    // One abuser hammering a single address must exhaust its own bucket (2) and
    // must NOT be able to spend the shared ceiling (8) that protects everyone.
    for (let i = 0; i < 30; i += 1) {
      await getOrCreateSession(anonymousRequest('203.0.113.99'), { config, now: NOW }).catch(
        () => undefined,
      );
    }
    expect(createMock).toHaveBeenCalledTimes(config.sessionCreatePerMinute);

    // A fresh address still gets its own allowance: the ceiling was not drained.
    await expect(
      getOrCreateSession(anonymousRequest('203.0.113.100'), { config, now: NOW }),
    ).resolves.toMatchObject({ created: true });
  });

  it('the global ceiling never blocks a visitor who already has a live session', async () => {
    // Minting is denied under flood; established sessions must keep working, or
    // a troll could lock every judge out mid-demo.
    const drained: Config = { ...config, globalSessionCreatePerMinute: 1 };
    await getOrCreateSession(anonymousRequest('192.0.2.1'), { config: drained, now: NOW });
    await expect(
      getOrCreateSession(anonymousRequest('192.0.2.2'), { config: drained, now: NOW }),
    ).rejects.toMatchObject({ status: 429 });

    findUniqueMock.mockResolvedValue({
      id: 'sess_live',
      pseudonym: 'SteadyIngot777',
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 10 * 60_000),
    });
    const withCookie = new Request('https://demo.invalid/api/gauntlet', {
      method: 'POST',
      headers: { 'x-forwarded-for': '192.0.2.3', cookie: `${SESSION_COOKIE}=sess_live` },
    });
    await expect(
      getOrCreateSession(withCookie, { config: drained, now: NOW }),
    ).resolves.toMatchObject({ created: false });
  });

  it('skipRateLimit is test-only and does not silently apply to routes', async () => {
    for (let i = 0; i < 20; i += 1) {
      await getOrCreateSession(anonymousRequest(), { config, now: NOW, skipRateLimit: true });
    }
    expect(createMock).toHaveBeenCalledTimes(20);
  });
});

// ---------------------------------------------------------------------------
// Client address extraction
// ---------------------------------------------------------------------------

describe('clientIp', () => {
  const withHeaders = (headers: Record<string, string>): Request =>
    new Request('https://demo.invalid/', { headers });

  it('uses the left-most X-Forwarded-For entry (the original client)', () => {
    expect(clientIp(withHeaders({ 'x-forwarded-for': '203.0.113.5, 70.41.3.18, 150.172.238.178' }))).toBe(
      '203.0.113.5',
    );
  });

  it('falls back through the other forwarded headers', () => {
    expect(clientIp(withHeaders({ 'x-real-ip': '198.51.100.4' }))).toBe('198.51.100.4');
    expect(clientIp(withHeaders({ 'cf-connecting-ip': '198.51.100.5' }))).toBe('198.51.100.5');
    expect(clientIp(withHeaders({ 'true-client-ip': '198.51.100.6' }))).toBe('198.51.100.6');
  });

  it('fails CLOSED to a shared bucket when no header is present', () => {
    // Not a per-caller free pass: everyone shares one budget. Documented
    // tradeoff in the module header.
    expect(clientIp(withHeaders({}))).toBe(UNKNOWN_CLIENT_IP);
    expect(clientIp(withHeaders({ 'x-forwarded-for': '   ' }))).toBe(UNKNOWN_CLIENT_IP);
  });

  it('bounds the key length so a huge header cannot bloat the limiter map', () => {
    expect(clientIp(withHeaders({ 'x-forwarded-for': 'a'.repeat(5000) })).length).toBeLessThanOrEqual(
      64,
    );
  });
});

// ---------------------------------------------------------------------------
// Key namespacing and per-call budgets
// ---------------------------------------------------------------------------

describe('limiter keys and budgets', () => {
  it('namespaces address keys so they cannot collide with a session key', () => {
    expect(rateLimitKeys.ip('1.2.3.4')).not.toBe(rateLimitKeys.sessionCreate('1.2.3.4'));
    expect(rateLimitKeys.ip('1.2.3.4')).not.toBe('1.2.3.4');
    expect(rateLimitKeys.sessionCreate('1.2.3.4')).not.toBe('1.2.3.4');
  });

  it('the global ceiling key cannot be forged by any client address', () => {
    // `clientIp` truncates to 64 chars and takes the left-most XFF entry, so a
    // caller CAN claim to be the literal string "*". The key must still differ.
    expect(rateLimitKeys.sessionCreate('*')).not.toBe(rateLimitKeys.globalSessionCreate);
    expect(rateLimitKeys.ip('*')).not.toBe(rateLimitKeys.globalSessionCreate);
  });

  it('honours a per-call limit override', () => {
    const opts = { config, now: NOW.getTime(), limit: 2 };
    expect(consumeRateLimit('k', opts).allowed).toBe(true);
    expect(consumeRateLimit('k', opts).allowed).toBe(true);
    expect(consumeRateLimit('k', opts).allowed).toBe(false);
  });

  it('defaults to the per-session budget when no override is given', () => {
    const decision = consumeRateLimit('bare-session-id', { config, now: NOW.getTime() });
    expect(decision.limit).toBe(config.rateLimitPerMinute);
  });
});

describe('loadIsolationConfig exposes the new budgets', () => {
  it('has sane defaults', () => {
    const loaded = loadIsolationConfig({} as NodeJS.ProcessEnv);
    expect(loaded.ipRateLimitPerMinute).toBeGreaterThan(loaded.rateLimitPerMinute);
    expect(loaded.sessionCreatePerMinute).toBeLessThan(loaded.rateLimitPerMinute);
    // The shared ceiling must exceed one address's allowance, or a single
    // visitor could deny session creation to the whole demo.
    expect(loaded.globalSessionCreatePerMinute).toBeGreaterThan(loaded.sessionCreatePerMinute);
  });

  it('reads the env overrides', () => {
    const loaded = loadIsolationConfig({
      IP_RATE_LIMIT_PER_MINUTE: '77',
      SESSION_CREATE_PER_MINUTE: '3',
      GLOBAL_SESSION_CREATE_PER_MINUTE: '41',
    } as unknown as NodeJS.ProcessEnv);
    expect(loaded.ipRateLimitPerMinute).toBe(77);
    expect(loaded.sessionCreatePerMinute).toBe(3);
    expect(loaded.globalSessionCreatePerMinute).toBe(41);
  });
});
