/**
 * LA FORJA — public demo isolation (doc §10).
 *
 * OWNER: Claude (infrastructure — NOT a Codex internal). Doc §10 is a hard
 * requirement and takes priority over any "real commons": one judge must not be
 * able to break another judge's demo, and a troll must not be able to spam the
 * bank during judging.
 *
 * What this module provides:
 *  - a per-visitor session id in an httpOnly, SameSite=Lax cookie (no accounts),
 *  - auto-reset: an EXPIRED session is REPLACED, never resurrected,
 *  - input size limits for UNTRUSTED item text (hard constraint 1),
 *  - a sliding-window rate limiter keyed by session id,
 *  - random pseudonyms (doc §6.4/§9).
 *
 * ZERO PII (hard constraint 8): there is no school, city, name, email or age
 * field here, and none may ever be added. The only author-facing field in the
 * whole system is a random pseudonym.
 *
 * RATE LIMITER SCOPE — read before scaling: the limiter is an IN-MEMORY map, so
 * it is PER-INSTANCE. The public demo is a single instance (doc §3 item 9: "one
 * stable isolated public link"), which is exactly what this is sized for. A
 * multi-instance deployment would need a shared store; that is explicitly not
 * part of the slice.
 */
import { z } from 'zod';
import { prisma } from '../db/client';

// ---------------------------------------------------------------------------
// Configuration (env, with the defaults documented in .env.example)
// ---------------------------------------------------------------------------

/** Cookie name carrying the per-visitor session id. Value is an opaque cuid. */
export const SESSION_COOKIE = 'forja_session';

/** Sliding window length for the rate limiter. */
export const RATE_LIMIT_WINDOW_MS = 60_000;

export interface IsolationConfig {
  /** Auto-reset window for a visitor session. */
  sessionTtlMinutes: number;
  /** Maximum characters accepted for any single UNTRUSTED text field. */
  maxInputChars: number;
  /** Requests allowed per session per RATE_LIMIT_WINDOW_MS. */
  rateLimitPerMinute: number;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** Reads the doc §10 limits from env. Pure apart from the env argument. */
export function loadIsolationConfig(env: NodeJS.ProcessEnv = process.env): IsolationConfig {
  return {
    sessionTtlMinutes: positiveInt(env.SESSION_TTL_MINUTES, 30),
    maxInputChars: positiveInt(env.MAX_INPUT_CHARS, 4000),
    rateLimitPerMinute: positiveInt(env.RATE_LIMIT_PER_MINUTE, 20),
  };
}

/**
 * Hard ceiling on the raw request body, checked BEFORE JSON.parse so a huge
 * payload is rejected without being parsed. Generous multiple of the per-field
 * limit because a repair body carries a stem plus several options.
 */
export function maxBodyChars(config: IsolationConfig = loadIsolationConfig()): number {
  return config.maxInputChars * 4;
}

// ---------------------------------------------------------------------------
// Typed API errors
// ---------------------------------------------------------------------------

/** Error codes the client can branch on. Stable strings, never localized. */
export type ApiErrorCode =
  | 'invalid_json'
  | 'invalid_body'
  | 'input_too_large'
  | 'rate_limited'
  | 'not_found'
  | 'immutable_version'
  | 'internal_error';

/** Wire shape of every error response. */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    /** Structured validation detail. Never contains secrets or stack traces. */
    details?: unknown;
  };
}

/** An error carrying the HTTP status the route should answer with. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details?: unknown;

  constructor(status: number, code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown): ApiError =>
  new ApiError(400, 'invalid_body', message, details);

export const notFound = (message: string): ApiError => new ApiError(404, 'not_found', message);

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/** JSON response with demo-safe caching headers and an optional Set-Cookie. */
export function jsonResponse(body: unknown, status = 200, setCookie?: string): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  if (setCookie) headers.append('set-cookie', setCookie);
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Maps any thrown value to a typed JSON error response.
 *
 * An unexpected error NEVER leaks its message in production: it is logged
 * server-side and answered with a generic 500 (no secrets reach the client,
 * hard constraint 5). In development the message is included to keep the
 * Codex punch-list readable.
 */
export function errorResponse(err: unknown, setCookie?: string): Response {
  if (err instanceof ApiError) {
    const body: ApiErrorBody = {
      error: { code: err.code, message: err.message, details: err.details },
    };
    return jsonResponse(body, err.status, setCookie);
  }

  // eslint-disable-next-line no-console
  console.error('[api] unhandled error', err);
  const detail = err instanceof Error ? err.message : String(err);
  const body: ApiErrorBody = {
    error: {
      code: 'internal_error',
      message:
        process.env.NODE_ENV === 'production'
          ? 'Internal error. See server logs.'
          : `Internal error: ${detail}`,
    },
  };
  return jsonResponse(body, 500, setCookie);
}

// ---------------------------------------------------------------------------
// Pseudonyms (doc §6.4, §9) — the ONLY author field that exists anywhere
// ---------------------------------------------------------------------------

const PSEUDONYM_ADJECTIVES = [
  'Lucid',
  'Quiet',
  'Sharp',
  'Iron',
  'Amber',
  'Swift',
  'Molten',
  'Steady',
] as const;

const PSEUDONYM_NOUNS = [
  'Anvil',
  'Ember',
  'Forge',
  'Quarry',
  'Bellows',
  'Ingot',
  'Hammer',
  'Crucible',
] as const;

/**
 * adjective + noun + 3 digits, e.g. "MoltenCrucible417".
 *
 * NEVER derived from any real-identity input. There is no name, email, school,
 * city or age anywhere in this function or in the Session model.
 */
export function randomPseudonym(): string {
  const adjective = PSEUDONYM_ADJECTIVES[Math.floor(Math.random() * PSEUDONYM_ADJECTIVES.length)] ?? 'Iron';
  const noun = PSEUDONYM_NOUNS[Math.floor(Math.random() * PSEUDONYM_NOUNS.length)] ?? 'Anvil';
  const digits = Math.floor(Math.random() * 900) + 100; // always 3 digits
  return `${adjective}${noun}${digits}`;
}

// ---------------------------------------------------------------------------
// Session cookie
// ---------------------------------------------------------------------------

/** Reads the session id from the request's Cookie header. */
export function readSessionCookie(req: Request): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = decodeURIComponent(part.slice(eq + 1).trim());
    return value === '' ? null : value;
  }
  return null;
}

/**
 * Builds the Set-Cookie value for a visitor session.
 * httpOnly (never readable from the client bundle) + SameSite=Lax + Secure in
 * production. The cookie carries an opaque id, never any visitor attribute.
 */
export function sessionCookieHeader(
  sessionId: string,
  config: IsolationConfig = loadIsolationConfig(),
): string {
  const maxAge = Math.max(60, config.sessionTtlMinutes * 60);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * A visitor session. Deliberately minimal: an id, a random pseudonym and the
 * auto-reset window. Adding any identifying field here would violate hard
 * constraint 8.
 */
export interface DemoSession {
  id: string;
  pseudonym: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface SessionResolution {
  session: DemoSession;
  /** true when a fresh session was created (first visit, or auto-reset). */
  created: boolean;
  /** Set-Cookie value the route must attach to its response. */
  cookie: string;
}

/** A session past its TTL is dead: it is replaced, never resurrected. */
export function isExpired(session: Pick<DemoSession, 'expiresAt'>, now: Date = new Date()): boolean {
  return session.expiresAt.getTime() <= now.getTime();
}

async function createSession(config: IsolationConfig, now: Date): Promise<DemoSession> {
  const row = await prisma.session.create({
    data: {
      pseudonym: randomPseudonym(),
      expiresAt: new Date(now.getTime() + config.sessionTtlMinutes * 60_000),
    },
  });
  return {
    id: row.id,
    pseudonym: row.pseudonym,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

/**
 * Resolves the request's cookie to a live Session row (doc §10).
 *
 * Auto-reset semantics:
 *  - no cookie                  -> create a new session,
 *  - cookie points nowhere      -> create a new session,
 *  - cookie points to an EXPIRED session -> create a NEW session with a NEW id
 *    and a NEW pseudonym. The expired row is left untouched (its items stay with
 *    it) and is never reused, so a stale link cannot resurrect old demo state.
 *
 * `forceReset` powers the explicit "start over" action on POST /api/session.
 */
export async function getOrCreateSession(
  req: Request,
  options: { forceReset?: boolean; config?: IsolationConfig; now?: Date } = {},
): Promise<SessionResolution> {
  const config = options.config ?? loadIsolationConfig();
  const now = options.now ?? new Date();
  const cookieId = options.forceReset === true ? null : readSessionCookie(req);

  if (cookieId !== null) {
    const row = await prisma.session.findUnique({ where: { id: cookieId } });
    if (row !== null) {
      const existing: DemoSession = {
        id: row.id,
        pseudonym: row.pseudonym,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      };
      if (!isExpired(existing, now)) {
        return { session: existing, created: false, cookie: sessionCookieHeader(existing.id, config) };
      }
    }
  }

  const session = await createSession(config, now);
  return { session, created: true, cookie: sessionCookieHeader(session.id, config) };
}

// ---------------------------------------------------------------------------
// Input size limits (doc §10) — item text is UNTRUSTED (hard constraint 1)
// ---------------------------------------------------------------------------

/**
 * Rejects text over MAX_INPUT_CHARS with a 413. Applied to EVERY untrusted text
 * field before it reaches a prompt.
 */
export function assertInputSize(
  text: string,
  field: string,
  config: IsolationConfig = loadIsolationConfig(),
): void {
  if (text.length > config.maxInputChars) {
    throw new ApiError(
      413,
      'input_too_large',
      `Field "${field}" is ${text.length} characters; the demo limit is ${config.maxInputChars}.`,
      { field, length: text.length, limit: config.maxInputChars },
    );
  }
}

/** Applies assertInputSize to several fields at once. */
export function assertInputSizes(
  fields: Record<string, string>,
  config: IsolationConfig = loadIsolationConfig(),
): void {
  for (const [field, text] of Object.entries(fields)) {
    assertInputSize(text, field, config);
  }
}

// ---------------------------------------------------------------------------
// Rate limiting (doc §10) — sliding window, in-memory, per instance
// ---------------------------------------------------------------------------

/**
 * Hit timestamps per session id. Kept on globalThis so Next.js dev HMR does not
 * silently reset the limiter between recompiles (same trick as the Prisma
 * singleton in src/db/client.ts).
 *
 * PER-INSTANCE BY DESIGN — see the module header. Sufficient for the
 * single-instance public demo; not a distributed limiter.
 */
const globalForLimiter = globalThis as unknown as { forjaRateLimiter?: Map<string, number[]> };
const hitLog: Map<string, number[]> = globalForLimiter.forjaRateLimiter ?? new Map<string, number[]>();
globalForLimiter.forjaRateLimiter = hitLog;

/** Keeps the map from growing without bound on a long-lived demo instance. */
function pruneStaleKeys(cutoff: number): void {
  if (hitLog.size < 512) return;
  for (const [key, hits] of hitLog) {
    if (hits.every((t) => t <= cutoff)) hitLog.delete(key);
  }
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  /** Requests still available in the current window. */
  remaining: number;
  /** Seconds until the window frees a slot. 0 when allowed. */
  retryAfterSeconds: number;
}

/**
 * Records a hit for `key` and reports whether it is allowed. Sliding window:
 * hits older than RATE_LIMIT_WINDOW_MS are dropped, the rest are counted. A
 * denied request is NOT recorded, so a client hammering the endpoint cannot
 * push its own window forward indefinitely.
 */
export function consumeRateLimit(
  key: string,
  options: { config?: IsolationConfig; now?: number } = {},
): RateLimitDecision {
  const config = options.config ?? loadIsolationConfig();
  const now = options.now ?? Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const limit = config.rateLimitPerMinute;

  pruneStaleKeys(cutoff);

  const recent = (hitLog.get(key) ?? []).filter((t) => t > cutoff);

  if (recent.length >= limit) {
    hitLog.set(key, recent);
    const oldest = recent[0] ?? now;
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + RATE_LIMIT_WINDOW_MS - now) / 1000));
    return { allowed: false, limit, remaining: 0, retryAfterSeconds };
  }

  recent.push(now);
  hitLog.set(key, recent);
  return { allowed: true, limit, remaining: limit - recent.length, retryAfterSeconds: 0 };
}

/** consumeRateLimit + throw a 429 ApiError. This is what routes call. */
export function assertRateLimit(
  key: string,
  options: { config?: IsolationConfig; now?: number } = {},
): RateLimitDecision {
  const decision = consumeRateLimit(key, options);
  if (!decision.allowed) {
    throw new ApiError(
      429,
      'rate_limited',
      `Rate limit reached (${decision.limit} requests per minute). Retry in ${decision.retryAfterSeconds}s.`,
      { limit: decision.limit, retryAfterSeconds: decision.retryAfterSeconds },
    );
  }
  return decision;
}

/** Clears the limiter. For tests and for a manual demo reset only. */
export function resetRateLimiter(): void {
  hitLog.clear();
}

// ---------------------------------------------------------------------------
// Request body helpers
// ---------------------------------------------------------------------------

/**
 * Reads and JSON-parses a request body, enforcing the raw size cap BEFORE
 * parsing. An empty body parses to `{}` so routes with all-optional fields
 * accept a bodyless POST.
 */
export async function readJsonBody(
  req: Request,
  config: IsolationConfig = loadIsolationConfig(),
): Promise<unknown> {
  const raw = await req.text();
  const cap = maxBodyChars(config);
  if (raw.length > cap) {
    throw new ApiError(413, 'input_too_large', `Request body exceeds the ${cap} character demo limit.`, {
      length: raw.length,
      limit: cap,
    });
  }
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ApiError(400, 'invalid_json', 'Request body must be valid JSON.');
  }
}

/**
 * Validates a parsed body against a Zod schema and converts a failure into a
 * typed 400. Zod issues are surfaced as `details` (field paths + messages only —
 * never a stack trace, never the raw value).
 */
export function parseBody<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data as z.infer<S>;

  throw badRequest(
    'Request body failed validation.',
    result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  );
}
