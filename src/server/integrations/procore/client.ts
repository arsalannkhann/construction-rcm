/**
 * Procore REST client: a small typed wrapper over fetch.
 *
 * Built from docs/procore-api-notes.md, where every rule below has its source.
 * It has only been exercised against the emulator in tests/procore.test.ts,
 * never against a live Procore account.
 *
 * - Bearer token on every call. `Procore-Company-Id` on every call except
 *   GET /rest/v1.0/companies and GET /rest/v1.0/me.
 * - A 20 s timeout on every request.
 * - Only GETs are ever repeated. A POST is sent once. If the outcome is unknown
 *   (timeout, network failure, 5xx), the caller decides how to find out. It is
 *   never resent here.
 * - 429: Procore sends no Retry-After. Wait until X-Rate-Limit-Reset, measured
 *   from the response's Date header, plus up to a second of jitter. Waiting out
 *   the 10-second spike window is worth it. Waiting out an hourly window inside
 *   a request is not, so that is reported instead. A spent hourly limit is
 *   remembered, and further requests fail fast instead of spending more quota.
 * - 503: honour Retry-After. 500/502/504 and network failures: bounded
 *   exponential backoff with jitter.
 * - Pagination: page numbers built here. Link's `next`, then `Total`, then a
 *   short page decides whether another page exists. Bounded, and it refuses a
 *   server that keeps returning the same page.
 * - Integers beyond 2^53 are parsed as exact strings, never rounded.
 * - Tokens are never logged and never appear in error messages.
 */

const TIMEOUT_MS = 20_000;
/** Procore's spike window, in seconds. */
const SPIKE_WINDOW_S = 10;
/** The longest wait inside one request: the spike window plus jitter. Longer means the hourly limit. */
const MAX_WAIT_MS = 12_000;
/** First attempt plus three retries, for idempotent requests only. */
const MAX_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 4_000;
const DEFAULT_PER_PAGE = 100;
const MAX_PAGES = 500;
/** The only endpoints that take no Procore-Company-Id header. */
const UNSCOPED_PATHS = new Set(['/rest/v1.0/companies', '/rest/v1.0/me']);

/** 401: the access token was not accepted. */
export class ProcoreAuthError extends Error {
  readonly status = 401;
  constructor(message = 'Procore did not accept the access token.') {
    super(message);
    this.name = 'ProcoreAuthError';
  }
}

/** 429 or 503 that did not clear within the waits we allow ourselves. */
export class ProcoreRateLimitError extends Error {
  constructor(
    public readonly status: number,
    /** How long Procore asked us to wait, when it said. */
    public readonly retryAfterSeconds: number | null,
  ) {
    super(`Procore answered ${status} and asked us to slow down${retryAfterSeconds !== null ? ` for ${retryAfterSeconds}s` : ''}.`);
    this.name = 'ProcoreRateLimitError';
  }
}

/** Any other unsuccessful answer. `status` 0 means no answer at all (timeout or network failure). */
export class ProcoreApiError extends Error {
  constructor(
    public readonly status: number,
    /** A short excerpt of the response body with secrets removed. Safe to show and store. */
    public readonly excerpt: string,
    /** True when the request may have reached Procore but no answer came back. */
    public readonly timedOut = false,
  ) {
    super(status === 0 ? `Procore could not be reached: ${excerpt}` : `Procore answered ${status}${excerpt ? `: ${excerpt}` : ''}`);
    this.name = 'ProcoreApiError';
  }
}

/**
 * Whether a failed write may still have been carried out by Procore. True for a
 * timeout, a dropped connection, a 5xx, or a 503 throttle. False for a definite
 * refusal (4xx, 429).
 */
export function outcomeUnknown(err: unknown): boolean {
  if (err instanceof ProcoreRateLimitError) return err.status !== 429;
  if (err instanceof ProcoreApiError) return err.status === 0 || err.status >= 500;
  return false;
}

function pickMessage(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return typeof parsed === 'string' ? parsed : null;
  const o = parsed as Record<string, unknown>;
  for (const key of ['error_description', 'message', 'error']) {
    if (typeof o[key] === 'string' && o[key]) return o[key] as string;
  }
  if (o.errors !== undefined) return typeof o.errors === 'string' ? o.errors : JSON.stringify(o.errors);
  return JSON.stringify(parsed);
}

/** Reduce a response body to something short that is safe to show: no markup, no secrets. */
export function safeExcerpt(body: string, secrets: Array<string | null | undefined> = []): string {
  let text = body;
  try {
    text = pickMessage(JSON.parse(body)) ?? body;
  } catch {
    /* not JSON; use the text as it is */
  }
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
  text = text
    .replace(/<[^>]*>/g, ' ')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** Procore ids are integers that can exceed 32 bits. We carry them as strings everywhere. */
export function procoreId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return value.trim();
  return null;
}

/**
 * An id as it goes into a JSON request body. The documented bodies use JSON
 * numbers, so that is what we send whenever the id is exactly representable;
 * anything larger stays a string rather than being silently rounded.
 */
export function procoreBodyId(id: string): number | string {
  const n = Number(id);
  return /^\d+$/.test(id) && Number.isSafeInteger(n) ? n : id;
}

/**
 * JSON.parse, except that an integer too large for a JavaScript number comes
 * back as an exact decimal string instead of a rounded number.
 */
export function parseJson(text: string): unknown {
  if (!/\d{16}/.test(text)) return JSON.parse(text);
  let out = '';
  let copied = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c !== '-' && (c < '0' || c > '9')) continue;
    let j = c === '-' ? i + 1 : i;
    while (j < text.length && text[j]! >= '0' && text[j]! <= '9') j++;
    const literal = text.slice(i, j);
    const integer = !['.', 'e', 'E'].includes(text[j] ?? '');
    if (integer && literal.replace('-', '').length >= 16 && !Number.isSafeInteger(Number(literal))) {
      out += `${text.slice(copied, i)}"${literal}"`;
      copied = j;
    }
    while (j < text.length && /[0-9.eE+-]/.test(text[j]!)) j++;
    i = j - 1;
  }
  return JSON.parse(out + text.slice(copied));
}

/** The time on Procore's clock when it answered: the Date header, or ours if it is missing. */
function serverNow(headers: Headers, now: number): number {
  const date = Date.parse(headers.get('date') ?? '');
  return Number.isNaN(date) ? now : date;
}

/**
 * How long until the rate-limit window in these headers resets, and which
 * window it is. A 429 without headers is assumed to be the spike window, as
 * Procore's own sample does.
 */
export function rateLimitWait(headers: Headers, now: number = Date.now()): { ms: number; window: 'spike' | 'hourly' } {
  const reset = Number(headers.get('x-rate-limit-reset'));
  if (!headers.get('x-rate-limit-reset') || !Number.isFinite(reset)) return { ms: SPIKE_WINDOW_S * 1000, window: 'spike' };
  const seconds = Math.max(0, reset - serverNow(headers, now) / 1000);
  return { ms: Math.ceil(seconds * 1000), window: seconds <= SPIKE_WINDOW_S ? 'spike' : 'hourly' };
}

/** Retry-After in milliseconds (seconds or an HTTP date), or null when absent. */
export function retryAfterMs(headers: Headers, now: number = Date.now()): number | null {
  const value = headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - serverNow(headers, now));
}

/** Whether a Link header names a next page. */
export function linkHasNext(link: string): boolean {
  return link.split(',').some((part) => /;\s*rel="?next"?/i.test(part));
}

export type Query = Record<string, string | number | null | undefined>;

export type ProcoreClientOptions = {
  apiBase: string;
  /** Null only while no company has been chosen yet; then only the unscoped endpoints can be called. */
  companyId: string | null;
  /** Supplies a valid access token. Called with `forceRefresh` once after a 401. */
  token: (opts?: { forceRefresh?: boolean }) => Promise<string>;
  /**
   * Requests made under the same key share one rate-limit state in this
   * process. Procore counts per user. We key by organisation, whose connection
   * is one Procore user.
   */
  limiterKey?: string;
  /** Tests only: replace waiting and randomness. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

export type ProcoreClient = {
  get<T>(path: string, query?: Query): Promise<T>;
  /** Every page of a list endpoint. Throws rather than return a list it could not read completely. */
  getAll<T>(path: string, query?: Query, opts?: { perPage?: number }): Promise<T[]>;
  /** Sent exactly once. Never retried, except once after a 401 that a token renewal clears. */
  post<T>(path: string, body: unknown): Promise<T>;
};

type Limiter = { pausedUntil: number; blockedUntil: number };
const limiters = new Map<string, Limiter>();

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createProcoreClient(options: ProcoreClientOptions): ProcoreClient {
  const base = options.apiBase.replace(/\/$/, '');
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;
  const limiter: Limiter = options.limiterKey ? (limiters.get(options.limiterKey) ?? { pausedUntil: 0, blockedUntil: 0 }) : { pausedUntil: 0, blockedUntil: 0 };
  if (options.limiterKey) limiters.set(options.limiterKey, limiter);

  const backoff = (attempt: number) => Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1)) + Math.floor(random() * 250);

  /** Remember what the rate-limit headers say: pause through a spent spike window, refuse through a spent hourly one. */
  function observe(headers: Headers, throttled: boolean): { ms: number; window: 'spike' | 'hourly' } | null {
    const remaining = headers.get('x-rate-limit-remaining');
    if (!throttled && remaining !== '0') return null;
    const wait = rateLimitWait(headers);
    const until = Date.now() + wait.ms + Math.floor(random() * 1000);
    if (wait.window === 'hourly') limiter.blockedUntil = Math.max(limiter.blockedUntil, until);
    else limiter.pausedUntil = Math.max(limiter.pausedUntil, until);
    return wait;
  }

  async function send(method: 'GET' | 'POST', path: string, query: Query | undefined, body: unknown): Promise<{ data: unknown; headers: Headers }> {
    const url = new URL(base + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
    }
    const unscoped = method === 'GET' && UNSCOPED_PATHS.has(path);
    if (!unscoped && !options.companyId) throw new Error('A Procore company must be selected before calling this endpoint.');
    const idempotent = method === 'GET';

    let refreshed = false;
    let forceRefresh = false;
    for (let attempt = 1; ; attempt++) {
      const blocked = limiter.blockedUntil - Date.now();
      if (blocked > 0) throw new ProcoreRateLimitError(429, Math.ceil(blocked / 1000));
      const paused = limiter.pausedUntil - Date.now();
      if (paused > 0) await sleep(paused);

      const accessToken = await options.token(forceRefresh ? { forceRefresh: true } : undefined);
      forceRefresh = false;
      const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
      if (!unscoped) headers['Procore-Company-Id'] = options.companyId!;
      if (body !== undefined) headers['Content-Type'] = 'application/json';

      let response: Response;
      let text: string;
      try {
        response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
        text = await response.text();
      } catch (err) {
        const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        // A dropped connection on a read is worth another try; a timeout already cost 20 seconds.
        if (idempotent && !timedOut && attempt < MAX_ATTEMPTS) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new ProcoreApiError(0, timedOut ? `no response within ${TIMEOUT_MS / 1000} seconds` : 'the connection failed', true);
      }

      if (response.status === 401) {
        // The token may have been revoked or expired early. Renew it once, then give up.
        // A 401 is refused before anything is done, so even a POST may be sent again.
        if (!refreshed) {
          refreshed = true;
          forceRefresh = true;
          attempt -= 1;
          continue;
        }
        throw new ProcoreAuthError();
      }

      if (response.status === 429) {
        const wait = observe(response.headers, true)!;
        if (idempotent && wait.window === 'spike' && wait.ms <= MAX_WAIT_MS && attempt < MAX_ATTEMPTS) continue;
        throw new ProcoreRateLimitError(429, Math.max(1, Math.ceil(wait.ms / 1000)));
      }

      if (response.status === 503) {
        const asked = retryAfterMs(response.headers);
        const wait = asked ?? backoff(attempt);
        if (idempotent && attempt < MAX_ATTEMPTS && wait <= MAX_WAIT_MS) {
          await sleep(wait);
          continue;
        }
        throw new ProcoreRateLimitError(503, asked === null ? null : Math.ceil(asked / 1000));
      }

      if ((response.status === 500 || response.status === 502 || response.status === 504) && idempotent && attempt < MAX_ATTEMPTS) {
        await sleep(backoff(attempt));
        continue;
      }

      if (!response.ok) throw new ProcoreApiError(response.status, safeExcerpt(text, [accessToken]));
      observe(response.headers, false);

      if (!text.trim()) return { data: null, headers: response.headers };
      try {
        return { data: parseJson(text), headers: response.headers };
      } catch {
        throw new ProcoreApiError(response.status, 'the response was not JSON');
      }
    }
  }

  return {
    async get<T>(path: string, query?: Query): Promise<T> {
      return (await send('GET', path, query, undefined)).data as T;
    },

    async getAll<T>(path: string, query?: Query, opts: { perPage?: number } = {}): Promise<T[]> {
      const requested = opts.perPage ?? DEFAULT_PER_PAGE;
      const out: T[] = [];
      let previous: string | null = null;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const { data, headers } = await send('GET', path, { ...query, page, per_page: requested }, undefined);
        if (!Array.isArray(data)) throw new ProcoreApiError(200, 'expected a list');
        if (data.length === 0) return out;
        // A server that ignores `page` would hand back page 1 forever.
        const signature = JSON.stringify([data.length, data[0], data[data.length - 1]]);
        if (signature === previous) throw new ProcoreApiError(200, `page ${page} repeated the previous page; the list was not read completely`);
        previous = signature;
        out.push(...(data as T[]));

        const link = headers.get('link');
        if (link !== null && link.trim()) {
          if (!linkHasNext(link)) return out;
          continue;
        }
        const total = Number(headers.get('total') ?? NaN);
        if (Number.isFinite(total)) {
          if (out.length >= total) return out;
          continue;
        }
        // Procore may cap per_page below what we asked for; its Per-Page header says what a full page is.
        const perPage = Number(headers.get('per-page')) || requested;
        if (data.length < perPage) return out;
      }
      // Refuse to hand back a silently truncated list.
      throw new ProcoreApiError(200, `more than ${MAX_PAGES} pages; the list was not read completely`);
    },

    async post<T>(path: string, body: unknown): Promise<T> {
      return (await send('POST', path, undefined, body)).data as T;
    },
  };
}
