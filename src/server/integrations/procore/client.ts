/**
 * Procore REST client: a small typed wrapper over fetch.
 *
 * Built from docs/procore-api-notes.md. It has only been exercised against the
 * emulator in tests/procore.test.ts, never against a live Procore account.
 *
 * - Bearer token on every call; `Procore-Company-Id` on every call except
 *   GET /rest/v1.0/companies.
 * - 20 s timeout per request.
 * - 429 / 503: wait as the response asks (Retry-After, then X-Rate-Limit-Reset),
 *   but never longer than MAX_WAIT_MS, and retry at most twice.
 * - Tokens are never logged and never appear in error messages.
 */

const TIMEOUT_MS = 20_000;
const MAX_RETRIES = 2;
const MAX_WAIT_MS = 5_000;
const DEFAULT_PER_PAGE = 100;
const MAX_PAGES = 200;
const COMPANIES_PATH = '/rest/v1.0/companies';

/** 401: the access token was not accepted. */
export class ProcoreAuthError extends Error {
  readonly status = 401;
  constructor(message = 'Procore did not accept the access token.') {
    super(message);
    this.name = 'ProcoreAuthError';
  }
}

/** 429 or 503 that did not clear within the retries we allow ourselves. */
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
  ) {
    super(status === 0 ? `Procore could not be reached: ${excerpt}` : `Procore answered ${status}${excerpt ? `: ${excerpt}` : ''}`);
    this.name = 'ProcoreApiError';
  }
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
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
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

/** How long a 429 / 503 asks us to wait, in milliseconds. Null when it does not say. */
export function requestedWaitMs(headers: Headers, now: number = Date.now()): number | null {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.max(0, at - now);
  }
  const reset = Number(headers.get('x-rate-limit-reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - now);
  return null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type Query = Record<string, string | number | null | undefined>;

export type ProcoreClientOptions = {
  apiBase: string;
  /** Null only while no company has been chosen yet; then only the companies list can be called. */
  companyId: string | null;
  /** Supplies a valid access token. Called with `forceRefresh` once after a 401. */
  token: (opts?: { forceRefresh?: boolean }) => Promise<string>;
};

export type ProcoreClient = {
  get<T>(path: string, query?: Query): Promise<T>;
  /** Follows `page` / `per_page` until a short page or the `Total` header says we have everything. */
  getAll<T>(path: string, query?: Query, opts?: { perPage?: number }): Promise<T[]>;
  post<T>(path: string, body: unknown): Promise<T>;
};

export function createProcoreClient(options: ProcoreClientOptions): ProcoreClient {
  const base = options.apiBase.replace(/\/$/, '');

  async function send(method: 'GET' | 'POST', path: string, query: Query | undefined, body: unknown): Promise<{ data: unknown; headers: Headers }> {
    const url = new URL(base + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
    }
    const isCompanies = method === 'GET' && path === COMPANIES_PATH;
    if (!isCompanies && !options.companyId) throw new Error('A Procore company must be selected before calling this endpoint.');

    let refreshed = false;
    let forceRefresh = false;
    let retries = 0;
    for (;;) {
      const accessToken = await options.token(forceRefresh ? { forceRefresh: true } : undefined);
      forceRefresh = false;
      const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
      if (!isCompanies) headers['Procore-Company-Id'] = options.companyId!;
      if (body !== undefined) headers['Content-Type'] = 'application/json';

      let response: Response;
      let text: string;
      try {
        response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
        text = await response.text();
      } catch (err) {
        const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        throw new ProcoreApiError(0, timedOut ? `no response within ${TIMEOUT_MS / 1000} seconds` : 'the connection failed');
      }

      if (response.status === 401) {
        // The token may have been revoked or expired early. Renew it once, then give up.
        if (!refreshed) {
          refreshed = true;
          forceRefresh = true;
          continue;
        }
        throw new ProcoreAuthError();
      }

      if (response.status === 429 || response.status === 503) {
        const asked = requestedWaitMs(response.headers);
        // A 503 on a write may have reached Procore; repeating it could create a duplicate. Only a 429 is certain not to have.
        const repeatable = method === 'GET' || response.status === 429;
        // Waiting a few seconds is worth it; waiting out an hourly window inside a request is not.
        if (repeatable && retries < MAX_RETRIES && (asked === null || asked <= MAX_WAIT_MS)) {
          retries += 1;
          await sleep(asked ?? 1000 * retries);
          continue;
        }
        throw new ProcoreRateLimitError(response.status, asked === null ? null : Math.ceil(asked / 1000));
      }

      if (!response.ok) throw new ProcoreApiError(response.status, safeExcerpt(text, [accessToken]));

      if (!text.trim()) return { data: null, headers: response.headers };
      try {
        return { data: JSON.parse(text) as unknown, headers: response.headers };
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
      const perPage = opts.perPage ?? DEFAULT_PER_PAGE;
      const out: T[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const { data, headers } = await send('GET', path, { ...query, page, per_page: perPage }, undefined);
        if (!Array.isArray(data)) throw new ProcoreApiError(200, 'expected a list');
        out.push(...(data as T[]));
        if (data.length < perPage) return out;
        const total = headers.get('total');
        if (total !== null && Number.isFinite(Number(total)) && out.length >= Number(total)) return out;
      }
      // Refuse to hand back a silently truncated list.
      throw new ProcoreApiError(200, `more than ${MAX_PAGES * perPage} records; the list was not read completely`);
    },

    async post<T>(path: string, body: unknown): Promise<T> {
      return (await send('POST', path, undefined, body)).data as T;
    },
  };
}
