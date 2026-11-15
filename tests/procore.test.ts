/**
 * The Procore integration, exercised against a local emulator of the
 * documented endpoints (docs/procore-api-notes.md). No request leaves this
 * machine. This is the only way the integration has been tested: it has not
 * been run against a live Procore account.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditEvents, changeOrders, contracts, integrations, notifications, payApplications, projects, sovLines, subcontractors, transfers } from '@/db/schema';
import { PermissionError } from '@/server/auth/permissions';
import { decryptJson, encryptJson } from '@/server/crypto';
import { createProcoreClient, linkHasNext, outcomeUnknown, parseJson, ProcoreApiError, ProcoreAuthError, ProcoreRateLimitError, rateLimitWait, retryAfterMs } from '@/server/integrations/procore/client';
import { toHundredths } from '@/server/integrations/procore/import';
import {
  beginConnect,
  canPushToProcore,
  completeConnect,
  disconnect,
  importProject,
  listCompanies,
  listProcoreProjects,
  ProcoreConnectFailure,
  procoreStatus,
  pushToProcore,
  selectCompany,
} from '@/server/integrations/procore';
import { refreshTokens, type TokenSet } from '@/server/integrations/procore/oauth';
import { buildPackage, type BillingContract, type Parties, type PeriodInput } from '@/server/samples/scenario';
import { updateProject } from '@/server/services/records';
import { approveApplication } from '@/server/services/review';
import { createWorld, dollars as D, openFindings, packageFor, stateAfter, submit, type World } from './helpers/world';

// ── Emulator ────────────────────────────────────────────────────────────────

const CLIENT_ID = 'emulator-client-id';
const CLIENT_SECRET = 'emulator-client-secret';
const REDIRECT_URI = 'http://localhost:3000/api/integrations/procore/callback';

const COMPANY = { id: 4001, name: 'Northline Constructors', is_active: true };
const SECOND_COMPANY = { id: 4002, name: 'Northline Civil', is_active: true };
const CLOSED_COMPANY = { id: 4003, name: 'Northline Legacy', is_active: false };

// Real Procore ids do not fit in 32 bits.
const PROJECT = 562949953421400;
const LINE = { mobilization: 562949953430001, roughIn: 562949953430002, fixtures: 562949953430003 };
const VENDOR = { loneStar: 8101, gulfCoast: 8102, dormant: 8103 };
const CONTRACT = { electrical: 9201, hvac: 9202, concrete: 9203, painting: 9204 };

type Requisition = { authorization: string | undefined; companyId: string | undefined; body: Record<string, any> };

class ProcoreEmulator {
  url = '';
  private server = http.createServer((req, res) => void this.handle(req, res));
  private seq = 0;

  companies = [COMPANY];
  projects = [
    { id: PROJECT, name: 'Harbor Point Logistics Center', project_number: '9911', active: true },
    { id: PROJECT + 1, name: 'Old Mill Renovation', project_number: null, active: false },
  ];
  vendors = [
    // Same company as the one already entered by hand in the test world, in different capitals.
    { id: VENDOR.loneStar, name: 'LONE STAR ELECTRIC, LLC', email_address: 'billing@lonestarelectric.example', is_active: true },
    { id: VENDOR.gulfCoast, name: 'Gulf Coast Mechanical, Inc.', email_address: 'not-an-email', is_active: true },
    { id: VENDOR.dormant, name: 'Dormant Drywall Co.', email_address: null, is_active: false },
  ];
  contracts: Array<Record<string, any>> = [
    { id: CONTRACT.electrical, number: 'HP-07', title: 'Electrical', status: 'Approved', accounting_method: 'amount', retainage_percent: '10.0', grand_total: '500000.00', vendor: { id: VENDOR.loneStar, name: 'LONE STAR ELECTRIC, LLC' } },
    { id: CONTRACT.hvac, number: 'HP-12', title: 'HVAC', status: 'Complete', accounting_method: 'amount', retainage_percent: null, grand_total: '2254.65', vendor: { id: VENDOR.gulfCoast, name: 'Gulf Coast Mechanical, Inc.' } },
    { id: CONTRACT.concrete, number: 'HP-15', title: 'Site concrete', status: 'Approved', accounting_method: 'unit', retainage_percent: '5.0', grand_total: '80000.00', vendor: { id: VENDOR.gulfCoast, name: 'Gulf Coast Mechanical, Inc.' } },
    { id: CONTRACT.painting, number: 'HP-20', title: 'Painting', status: 'Draft', accounting_method: 'amount', retainage_percent: '10.0', grand_total: '40000.00', vendor: { id: VENDOR.dormant, name: 'Dormant Drywall Co.' } },
  ];
  // Amounts arrive both as decimal strings and as JSON numbers.
  lineItems: Record<number, Array<Record<string, any>>> = {
    [CONTRACT.electrical]: [
      { id: LINE.fixtures, position: 3, description: 'Fixtures and trim', amount: '150000.0' },
      { id: LINE.mobilization, position: 1, description: 'Mobilization', amount: '50000.00' },
      { id: LINE.roughIn, position: 2, description: 'Rough-in, levels 1-3', amount: 300000 },
    ],
    [CONTRACT.hvac]: [
      { id: 7001, position: 1, description: 'Rooftop units', amount: '1234.56' },
      { id: 7002, position: 2, description: 'Ductwork', amount: 1000.1 },
      { id: 7003, position: 3, description: 'Controls', amount: '19.99' },
    ],
    [CONTRACT.concrete]: [{ id: 7101, position: 1, description: 'Slab on grade', amount: '80000.00' }],
    [CONTRACT.painting]: [{ id: 7201, position: 1, description: 'Interior paint', amount: '40000.00' }],
  };
  changeOrders: Array<Record<string, any>> = [
    { id: 9301, contract_id: CONTRACT.electrical, number: '001', title: 'Added receptacles, level 2', status: 'approved', grand_total: '12000.00' },
    { id: 9302, contract_id: CONTRACT.electrical, number: '002', title: 'Lighting controls upgrade', status: 'pending - in review', grand_total: 4500.5 },
    { id: 9303, contract_id: CONTRACT.electrical, number: '003', title: 'Deleted site lighting', status: 'rejected', grand_total: '-3000.00' },
    { id: 9304, contract_id: CONTRACT.electrical, number: '004', title: 'Entered twice', status: 'void', grand_total: '100.00' },
    { id: 9305, contract_id: CONTRACT.hvac, number: '001', title: 'Extra diffusers', status: 'approved', grand_total: '800.00' },
  ];
  billingPeriods = [{ id: 6001, start_date: '2026-09-01', end_date: '2026-09-30', due_date: '2026-10-10', status: 'open' }];

  codes = new Set<string>();
  accessTokens = new Set<string>();
  refreshTokens = new Map<string, 'live' | 'used'>();
  grants: string[] = [];
  revoked: string[] = [];
  requests: Array<{ method: string; path: string; query: Record<string, string>; companyId: string | undefined }> = [];
  requisitions: Requisition[] = [];
  /**
   * Paths that answer 429 a number of times before behaving. As documented, a
   * 429 carries X-Rate-Limit-Reset (Unix seconds, `resetIn` seconds after the
   * Date header) and no Retry-After.
   */
  throttle = new Map<string, { times: number; resetIn: number }>();
  throttled = 0;
  /** Paths that answer with these statuses, in order, before behaving (503 carries Retry-After when given). */
  faults = new Map<string, Array<{ status: number; retryAfter?: string }>>();
  /** How list responses describe their pages: everything documented, or only Per-Page. */
  pagingHeaders: 'all' | 'per-page-only' = 'all';
  /** Simulates a server that ignores `page` and always answers page 1. */
  ignorePage = false;
  rejectNextRequisition: { status: number; body: unknown } | null = null;

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.server.close(resolve));
  }

  requestsTo(path: string) {
    return this.requests.filter((r) => r.path === path);
  }

  private issue() {
    const n = ++this.seq;
    const pair = { access_token: `emu-access-${n}-${'a'.repeat(24)}`, refresh_token: `emu-refresh-${n}-${'r'.repeat(24)}` };
    this.accessTokens.add(pair.access_token);
    this.refreshTokens.set(pair.refresh_token, 'live');
    return { ...pair, token_type: 'Bearer', expires_in: 5400, created_at: Math.floor(Date.now() / 1000) };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://emulator');
    const path = url.pathname;
    const nowSeconds = Math.floor(Date.now() / 1000);
    // Procore measures rate-limit resets against its Date header; second precision, like a real one.
    const dated = { Date: new Date(nowSeconds * 1000).toUTCString() };
    const limits = { 'X-Rate-Limit-Limit': '100', 'X-Rate-Limit-Remaining': '99', 'X-Rate-Limit-Reset': String(nowSeconds + 10) };
    const json = (status: number, data: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...dated, ...headers });
      res.end(JSON.stringify(data));
    };
    /** A documented list response. Per-endpoint default and maximum page sizes come from the reference pages. */
    const page = (rows: unknown[], sizes: { default: number; max: number } = { default: 100, max: 100 }) => {
      const perPage = Math.min(Number(url.searchParams.get('per_page') ?? sizes.default) || sizes.default, sizes.max);
      const n = this.ignorePage ? 1 : Number(url.searchParams.get('page') ?? 1);
      const last = Math.max(1, Math.ceil(rows.length / perPage));
      const headers: Record<string, string> = { ...limits, 'Per-Page': String(perPage) };
      if (this.pagingHeaders === 'all') {
        headers.Total = String(rows.length);
        // Built like the documented example, which leaves the request's other query parameters out.
        const at = (p: number, rel: string) => `<${this.url}${path}?page=${p}&per_page=${perPage}>; rel="${rel}"`;
        const links = [];
        if (n > 1) links.push(at(1, 'first'), at(n - 1, 'prev'));
        if (n < last) links.push(at(last, 'last'), at(n + 1, 'next'));
        if (links.length) headers.Link = links.join(', ');
      }
      json(200, rows.slice((n - 1) * perPage, n * perPage), headers);
    };

    // ── OAuth ──
    if (req.method === 'POST' && (path === '/oauth/token' || path === '/oauth/revoke')) {
      const form = new URLSearchParams(raw);
      if (req.headers['content-type'] !== 'application/x-www-form-urlencoded') return json(400, { error: 'invalid_request', error_description: 'Form fields expected' });
      if (form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== CLIENT_SECRET) return json(401, { error: 'invalid_client', error_description: 'Client authentication failed' });
      if (path === '/oauth/revoke') {
        const token = form.get('token') ?? '';
        this.revoked.push(token);
        this.accessTokens.delete(token);
        if (this.refreshTokens.has(token)) this.refreshTokens.set(token, 'used');
        return json(200, {});
      }
      const grant = form.get('grant_type') ?? '';
      this.grants.push(grant);
      const invalid = () => json(400, { error: 'invalid_grant', error_description: 'The provided authorization grant is invalid, expired, revoked, or does not match the redirection URI' });
      if (form.get('redirect_uri') !== REDIRECT_URI) return invalid();
      if (grant === 'authorization_code') {
        // Codes are single-use.
        if (!this.codes.delete(form.get('code') ?? '')) return invalid();
        return json(200, this.issue());
      }
      if (grant === 'refresh_token') {
        // Refresh tokens rotate: one that was already spent is refused.
        const presented = form.get('refresh_token') ?? '';
        if (this.refreshTokens.get(presented) !== 'live') return invalid();
        this.refreshTokens.set(presented, 'used');
        return json(200, this.issue());
      }
      return json(400, { error: 'unsupported_grant_type' });
    }

    // ── REST ──
    const companyId = req.headers['procore-company-id'] as string | undefined;
    this.requests.push({ method: req.method ?? '', path, query: Object.fromEntries(url.searchParams), companyId });
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token || !this.accessTokens.has(token)) return json(401, { error: 'invalid_token', error_description: 'The access token is invalid' });

    const throttle = this.throttle.get(path);
    if (throttle && throttle.times > 0) {
      throttle.times -= 1;
      this.throttled += 1;
      return json(429, { message: 'Rate limit exceeded' }, { 'X-Rate-Limit-Limit': '100', 'X-Rate-Limit-Remaining': '0', 'X-Rate-Limit-Reset': String(nowSeconds + throttle.resetIn) });
    }
    const fault = this.faults.get(path)?.shift();
    if (fault) return json(fault.status, { message: 'Service unavailable' }, fault.retryAfter ? { 'Retry-After': fault.retryAfter } : {});

    if (req.method === 'GET' && path === '/rest/v1.0/companies') return page(this.companies);
    if (!companyId || !this.companies.some((c) => String(c.id) === companyId)) return json(403, { message: 'Procore-Company-Id header is missing or names a company this user cannot access' });

    const projectParam = url.searchParams.get('project_id');
    let m: RegExpExecArray | null;
    if (req.method === 'GET' && path === '/rest/v1.1/projects') {
      if (url.searchParams.get('company_id') !== companyId) return json(400, { message: 'company_id is required' });
      return page(this.projects, { default: 100, max: 300 });
    }
    if (req.method === 'GET' && (m = /^\/rest\/v1\.1\/projects\/(\d+)\/vendors$/.exec(path))) {
      return Number(m[1]) === PROJECT ? page(this.vendors) : json(404, { message: 'Not found' });
    }
    if (req.method === 'GET' && path === '/rest/v1.0/work_order_contracts') {
      if (projectParam !== String(PROJECT)) return page([]);
      return page(this.contracts.map((c) => ({ id: c.id, number: c.number, title: c.title, status: c.status })));
    }
    if (req.method === 'GET' && (m = /^\/rest\/v1\.0\/work_order_contracts\/(\d+)$/.exec(path))) {
      const contract = this.contracts.find((c) => c.id === Number(m![1]));
      return contract && projectParam === String(PROJECT) ? json(200, contract) : json(404, { message: 'Not found' });
    }
    if (req.method === 'GET' && (m = /^\/rest\/v1\.0\/work_order_contracts\/(\d+)\/line_items$/.exec(path))) {
      const rows = this.lineItems[Number(m[1])];
      return rows && projectParam === String(PROJECT) ? page(rows) : json(404, { message: 'Not found' });
    }
    if (req.method === 'GET' && (m = /^\/rest\/v1\.0\/projects\/(\d+)\/commitment_change_orders$/.exec(path))) {
      const filter = url.searchParams.get('filters[contract_id]');
      return page(this.changeOrders.filter((co) => !filter || String(co.contract_id) === filter));
    }
    if (req.method === 'GET' && (m = /^\/rest\/v1\.0\/projects\/(\d+)\/billing_periods$/.exec(path))) {
      return Number(m[1]) === PROJECT ? page(this.billingPeriods) : json(404, { message: 'Not found' });
    }
    if (req.method === 'POST' && path === '/rest/v1.1/requisitions') {
      if (req.headers['content-type'] !== 'application/json') return json(415, { message: 'JSON expected' });
      const body = JSON.parse(raw) as Record<string, any>;
      if (this.rejectNextRequisition) {
        const { status, body: answer } = this.rejectNextRequisition;
        this.rejectNextRequisition = null;
        return json(status, answer);
      }
      const r = body.requisition ?? {};
      const errors: Record<string, string[]> = {};
      const lines = this.lineItems[body.commitment_id] ?? [];
      if (body.project_id !== PROJECT) errors.project_id = ['is not a project in this company'];
      if (!this.contracts.some((c) => c.id === body.commitment_id)) errors.commitment_id = ['is not a commitment on this project'];
      if (!this.billingPeriods.some((p) => p.id === r.period_id)) errors.period_id = ['is not a billing period on this project'];
      if (r.status !== 'draft') errors.status = ['can only be set by a Commitments admin'];
      if ('origin_id' in body || 'origin_id' in r) errors.origin_id = ['would make this invoice immutable'];
      if (typeof r.invoice_number !== 'string') errors.invoice_number = ['must be a string'];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.billing_date ?? '')) errors.billing_date = ['must be a date'];
      if (!Array.isArray(r.items) || r.items.length === 0) errors.items = ['must not be empty'];
      for (const item of Array.isArray(r.items) ? r.items : []) {
        if (item.item_type !== 'contract_item') errors.item_type = ['is not supported by this emulator'];
        if (!lines.some((l) => l.id === item.line_item_id)) errors.line_item_id = [`${item.line_item_id} is not a line item of this commitment`];
        for (const field of ['work_completed_this_period', 'materials_presently_stored']) {
          if (typeof item[field] !== 'string' || !/^-?\d+\.\d{2}$/.test(item[field])) errors[field] = ['must be a decimal string'];
        }
      }
      if (Object.keys(errors).length > 0) return json(422, { errors });
      this.requisitions.push({ authorization: req.headers.authorization, companyId, body });
      return json(201, { id: 77000 + this.requisitions.length, status: 'draft', invoice_number: r.invoice_number });
    }
    return json(404, { message: 'Not found' });
  }
}

const emu = new ProcoreEmulator();

function configure() {
  process.env.PROCORE_CLIENT_ID = CLIENT_ID;
  process.env.PROCORE_CLIENT_SECRET = CLIENT_SECRET;
  process.env.PROCORE_LOGIN_BASE = emu.url;
  process.env.PROCORE_API_BASE = emu.url;
}

function unconfigure() {
  delete process.env.PROCORE_CLIENT_ID;
  delete process.env.PROCORE_CLIENT_SECRET;
}

async function connect(w: World, code: string) {
  emu.codes.add(code);
  await completeConnect(w.db, w.owner, code);
}

async function integrationOf(w: World) {
  const [row] = await w.db.select().from(integrations).where(and(eq(integrations.orgId, w.orgId), eq(integrations.provider, 'procore')));
  return row;
}

async function storedTokens(w: World): Promise<TokenSet> {
  return decryptJson<TokenSet>((await integrationOf(w))!.credentials!);
}

async function appRow(w: World, id: string) {
  const [app] = await w.db.select().from(payApplications).where(eq(payApplications.id, id));
  return app!;
}

beforeAll(async () => {
  await emu.start();
});

afterAll(async () => {
  await emu.stop();
});

// ── Small pure pieces ───────────────────────────────────────────────────────

describe('reading Procore values', () => {
  it('converts amounts to integer cents without floating-point drift', () => {
    expect(toHundredths('1000.00')).toBe(100000);
    expect(toHundredths('150000.0')).toBe(15000000);
    expect(toHundredths('0.1')).toBe(10);
    expect(toHundredths('19.99')).toBe(1999);
    expect(toHundredths('1234.565')).toBe(123457);
    expect(toHundredths('1234.5649')).toBe(123456);
    expect(toHundredths('-3000.00')).toBe(-300000);
    expect(toHundredths('10')).toBe(1000);
    expect(toHundredths(1000.1)).toBe(100010); // 1000.1 * 100 is 100010.00000000001 in floating point
    expect(toHundredths(0.29)).toBe(29); // 0.29 * 100 is 28.999999999999996
    expect(toHundredths('-0.00')).toBe(0);
    expect(toHundredths('')).toBeNull();
    expect(toHundredths('1e3')).toBeNull();
    expect(toHundredths('twelve')).toBeNull();
    expect(toHundredths(null)).toBeNull();
  });

  it('reads how long a rate-limited response asks us to wait, by Procore’s clock', () => {
    const now = Date.parse('2026-11-15T12:00:00Z');
    const reset = (inSeconds: number, date?: string) => new Headers({ 'X-Rate-Limit-Reset': String(now / 1000 + inSeconds), ...(date ? { Date: date } : {}) });
    expect(rateLimitWait(reset(7), now)).toEqual({ ms: 7000, window: 'spike' });
    expect(rateLimitWait(reset(10), now)).toEqual({ ms: 10_000, window: 'spike' });
    expect(rateLimitWait(reset(1800), now)).toEqual({ ms: 1_800_000, window: 'hourly' });
    // Our clock runs 5 s fast; Procore's Date header is the reference, so the wait is still 7 s.
    expect(rateLimitWait(reset(7, 'Sun, 15 Nov 2026 12:00:00 GMT'), now + 5000)).toEqual({ ms: 7000, window: 'spike' });
    expect(rateLimitWait(reset(-3), now)).toEqual({ ms: 0, window: 'spike' });
    // A 429 with no headers: assume the spike window, as Procore's sample does.
    expect(rateLimitWait(new Headers(), now)).toEqual({ ms: 10_000, window: 'spike' });
    // Retry-After only matters on a 503.
    expect(retryAfterMs(new Headers({ 'Retry-After': '3' }), now)).toBe(3000);
    expect(retryAfterMs(new Headers({ 'Retry-After': 'Sun, 15 Nov 2026 12:00:10 GMT' }), now)).toBe(10_000);
    expect(retryAfterMs(new Headers(), now)).toBeNull();
    expect(linkHasNext('<https://x/a?page=2>; rel="next", <https://x/a?page=9>; rel="last"')).toBe(true);
    expect(linkHasNext('<https://x/a?page=1>; rel="first", <https://x/a?page=8>; rel="prev"')).toBe(false);
  });

  it('parses ids beyond 2^53 exactly instead of rounding them', () => {
    const parsed = parseJson('{"id": 9007199254740993, "small": 562949953421400, "amount": "12.50", "rate": 1.25e2, "note": "id 9007199254740993 in text", "list": [-9007199254740995, 3]}') as Record<string, unknown>;
    expect(parsed).toEqual({ id: '9007199254740993', small: 562949953421400, amount: '12.50', rate: 125, note: 'id 9007199254740993 in text', list: ['-9007199254740995', 3] });
    expect(parseJson('[1, 2.5, "x"]')).toEqual([1, 2.5, 'x']);
  });

  it('knows which failed writes may still have happened', () => {
    expect(outcomeUnknown(new ProcoreApiError(0, 'no response', true))).toBe(true);
    expect(outcomeUnknown(new ProcoreApiError(502, 'bad gateway'))).toBe(true);
    expect(outcomeUnknown(new ProcoreRateLimitError(503, 5))).toBe(true);
    expect(outcomeUnknown(new ProcoreRateLimitError(429, 5))).toBe(false);
    expect(outcomeUnknown(new ProcoreApiError(422, 'invalid'))).toBe(false);
    expect(outcomeUnknown(new Error('bug'))).toBe(false);
  });
});

// ── Not configured ──────────────────────────────────────────────────────────

describe('when Procore is not configured', () => {
  it('says so and offers nothing', async () => {
    unconfigure();
    const w = await createWorld();
    expect(await procoreStatus(w.db, w.owner)).toEqual({
      configured: false,
      env: null,
      connected: false,
      needsCompany: false,
      companyId: null,
      companyName: null,
      lastSyncAt: null,
      lastError: null,
      connectedByName: null,
    });
    expect(() => beginConnect(w.owner)).toThrow(/not configured/);
    await expect(completeConnect(w.db, w.owner, 'any-code')).rejects.toMatchObject({ code: 'not_configured' });
    await expect(listProcoreProjects(w.db, w.owner)).rejects.toThrow(/not configured/);
    expect(await integrationOf(w)).toBeUndefined();
    expect(emu.requests).toHaveLength(0);
    expect(emu.grants).toHaveLength(0);
  });
});

// ── Connecting ──────────────────────────────────────────────────────────────

describe('connecting', () => {
  let w: World;
  beforeAll(async () => {
    configure();
    w = await createWorld();
  });

  it('builds the authorize URL and limits who may connect', async () => {
    const { url, state } = beginConnect(w.owner);
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(`${emu.url}/oauth/authorize`);
    expect(Object.fromEntries(parsed.searchParams)).toEqual({ client_id: CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT_URI, state });
    expect(state.length).toBeGreaterThanOrEqual(24);
    expect(beginConnect(w.owner).state).not.toBe(state);
    expect(url).not.toContain(CLIENT_SECRET);

    expect(() => beginConnect(w.controller)).toThrow(PermissionError);
    await expect(completeConnect(w.db, w.accountant, 'whatever')).rejects.toBeInstanceOf(PermissionError);
    expect(await procoreStatus(w.db, w.owner)).toMatchObject({ configured: true, env: 'sandbox', connected: false });
  });

  it('does not pretend to be connected when Procore refuses the code', async () => {
    const failure = await completeConnect(w.db, w.owner, 'never-issued').catch((e) => e);
    expect(failure).toBeInstanceOf(ProcoreConnectFailure);
    expect(failure.code).toBe('code_rejected');
    expect(await integrationOf(w)).toBeUndefined();
    expect((await procoreStatus(w.db, w.owner)).connected).toBe(false);
  });

  it('stores the tokens encrypted and selects the only company', async () => {
    await connect(w, 'code-one');
    const row = (await integrationOf(w))!;
    const tokens = await storedTokens(w);
    expect(emu.accessTokens.has(tokens.accessToken)).toBe(true);
    expect(emu.refreshTokens.get(tokens.refreshToken)).toBe('live');
    expect(tokens.expiresAt).toBeGreaterThan(Date.now() + 80 * 60_000);

    // Nothing readable at rest.
    expect(row.credentials).toMatch(/^v1\./);
    expect(row.credentials).not.toContain(tokens.accessToken);
    expect(row.credentials).not.toContain(tokens.refreshToken);
    expect(JSON.stringify(row)).not.toContain(tokens.accessToken);
    expect(JSON.stringify(row)).not.toContain(tokens.refreshToken);
    expect(row.config).toEqual({ env: 'sandbox', companyId: String(COMPANY.id), companyName: COMPANY.name });

    expect(await procoreStatus(w.db, w.viewer)).toEqual({
      configured: true,
      env: 'sandbox',
      connected: true,
      needsCompany: false,
      companyId: String(COMPANY.id),
      companyName: COMPANY.name,
      lastSyncAt: null,
      lastError: null,
      connectedByName: 'Olivia Owner',
    });

    // The companies list is the one call made without a company header.
    expect(emu.requestsTo('/rest/v1.0/companies').at(-1)!.companyId).toBeUndefined();
    // The code was single-use.
    await expect(completeConnect(w.db, w.owner, 'code-one')).rejects.toMatchObject({ code: 'code_rejected' });
    expect((await procoreStatus(w.db, w.owner)).connected).toBe(true);

    const events = await w.db.select().from(auditEvents).where(and(eq(auditEvents.orgId, w.orgId), eq(auditEvents.action, 'integration.connected')));
    expect(events).toHaveLength(1);
    expect(events[0]!.summary).toContain(COMPANY.name);
    expect(JSON.stringify(events[0])).not.toContain(tokens.accessToken);
  });

  it('renews a token that is about to expire and keeps the rotated pair', async () => {
    const before = await storedTokens(w);
    const row = (await integrationOf(w))!;
    // 90 seconds left: inside the two-minute margin.
    await w.db.update(integrations).set({ credentials: encryptJson({ ...before, expiresAt: Date.now() + 90_000 }) }).where(eq(integrations.id, row.id));
    const grants = emu.grants.length;

    const listed = await listProcoreProjects(w.db, w.owner);
    expect(listed.map((p) => p.name)).toEqual(['Harbor Point Logistics Center', 'Old Mill Renovation']);
    expect(emu.grants.slice(grants)).toEqual(['refresh_token']);

    const after = await storedTokens(w);
    expect(after.accessToken).not.toBe(before.accessToken);
    expect(after.refreshToken).not.toBe(before.refreshToken);
    expect(after.expiresAt).toBeGreaterThan(Date.now() + 80 * 60_000);
    expect(emu.refreshTokens.get(after.refreshToken)).toBe('live');
    // The old refresh token is spent; presenting it again is refused.
    await expect(refreshTokens(before.refreshToken)).rejects.toBeInstanceOf(ProcoreAuthError);

    // With a fresh token there is nothing to renew.
    await listProcoreProjects(w.db, w.owner);
    expect(emu.grants.length).toBe(grants + 2); // the refusal above was the second attempt; no third
    expect((await procoreStatus(w.db, w.owner)).connected).toBe(true);
  });

  it('renews once when Procore answers 401 for a token that looked valid', async () => {
    const before = await storedTokens(w);
    emu.accessTokens.delete(before.accessToken); // revoked on Procore's side
    const grants = emu.grants.length;
    expect(await listProcoreProjects(w.db, w.owner)).toHaveLength(2);
    expect(emu.grants.slice(grants)).toEqual(['refresh_token']);
    expect((await storedTokens(w)).refreshToken).not.toBe(before.refreshToken);
  });

  it('reports an error and asks to reconnect when the refresh token is no longer good', async () => {
    const other = await createWorld();
    await connect(other, 'code-other');
    const good = await storedTokens(other);
    const row = (await integrationOf(other))!;
    await other.db.update(integrations).set({ credentials: encryptJson({ accessToken: good.accessToken, refreshToken: 'emu-refresh-that-was-already-spent', expiresAt: Date.now() - 1000 }) }).where(eq(integrations.id, row.id));

    await expect(listProcoreProjects(other.db, other.owner)).rejects.toThrow(/Reconnect Procore/);
    const failed = (await integrationOf(other))!;
    expect(failed.status).toBe('error');
    expect(failed.lastError).toMatch(/Reconnect Procore/);
    const status = await procoreStatus(other.db, other.owner);
    expect(status).toMatchObject({ configured: true, connected: false, needsCompany: false, companyName: COMPANY.name });
    expect(status.lastError).toMatch(/Reconnect Procore/);
    // It stays failed without hammering Procore.
    const grants = emu.grants.length;
    await expect(importProject(other.db, other.owner, String(PROJECT))).rejects.toThrow(/Reconnect Procore/);
    expect(emu.grants.length).toBe(grants);

    // Connecting again repairs it and keeps the company.
    await connect(other, 'code-other-again');
    expect(await procoreStatus(other.db, other.owner)).toMatchObject({ connected: true, companyId: String(COMPANY.id), lastError: null });
  });

  it('asks which company to use when the login can see several, and disconnects cleanly', async () => {
    const multi = await createWorld();
    emu.companies = [COMPANY, SECOND_COMPANY, CLOSED_COMPANY];
    try {
      await connect(multi, 'code-multi');
      expect(await procoreStatus(multi.db, multi.owner)).toMatchObject({ connected: true, needsCompany: true, companyId: null, companyName: null });
      await expect(listProcoreProjects(multi.db, multi.owner)).rejects.toThrow(/Choose which Procore company/);

      await expect(listCompanies(multi.db, multi.accountant)).rejects.toBeInstanceOf(PermissionError);
      expect(await listCompanies(multi.db, multi.owner)).toEqual([
        { id: String(SECOND_COMPANY.id), name: SECOND_COMPANY.name },
        { id: String(COMPANY.id), name: COMPANY.name },
      ]);
      await expect(selectCompany(multi.db, multi.owner, '999999')).rejects.toThrow(/not available/);
      await expect(selectCompany(multi.db, multi.owner, String(CLOSED_COMPANY.id))).rejects.toThrow(/not available/);
      await selectCompany(multi.db, multi.owner, String(SECOND_COMPANY.id));
      expect(await procoreStatus(multi.db, multi.owner)).toMatchObject({ connected: true, needsCompany: false, companyId: String(SECOND_COMPANY.id), companyName: SECOND_COMPANY.name });

      await listProcoreProjects(multi.db, multi.owner);
      expect(emu.requestsTo('/rest/v1.1/projects').at(-1)).toMatchObject({ companyId: String(SECOND_COMPANY.id), query: { company_id: String(SECOND_COMPANY.id) } });

      const tokens = await storedTokens(multi);
      await expect(disconnect(multi.db, multi.accountant)).rejects.toBeInstanceOf(PermissionError);
      await disconnect(multi.db, multi.owner);
      expect(await integrationOf(multi)).toBeUndefined();
      expect(await procoreStatus(multi.db, multi.owner)).toMatchObject({ configured: true, connected: false, companyId: null, lastError: null });
      expect(emu.revoked).toEqual(expect.arrayContaining([tokens.accessToken, tokens.refreshToken]));
      expect(emu.accessTokens.has(tokens.accessToken)).toBe(false);
      const [event] = await multi.db.select().from(auditEvents).where(and(eq(auditEvents.orgId, multi.orgId), eq(auditEvents.action, 'integration.disconnected')));
      expect(event!.summary).toContain('Procore confirmed the authorization was revoked');
      await expect(listProcoreProjects(multi.db, multi.owner)).rejects.toThrow(/not connected/);
    } finally {
      emu.companies = [COMPANY];
    }
  });
});

// ── The client ──────────────────────────────────────────────────────────────

describe('the REST client', () => {
  let accessToken: string;
  let client: ReturnType<typeof createProcoreClient>;
  /** A client that records the waits it would make instead of making them. */
  const recording = () => {
    const waits: number[] = [];
    const c = createProcoreClient({ apiBase: emu.url, companyId: String(COMPANY.id), token: async () => accessToken, sleep: async (ms) => void waits.push(ms), random: () => 0 });
    return { client: c, waits };
  };
  beforeAll(async () => {
    configure();
    const w = await createWorld();
    await connect(w, 'code-client');
    accessToken = (await storedTokens(w)).accessToken;
    client = createProcoreClient({ apiBase: emu.url, companyId: String(COMPANY.id), token: async () => accessToken });
  });

  it('follows pagination to the end and stops where Procore says the list ends', async () => {
    const path = `/rest/v1.0/work_order_contracts/${CONTRACT.electrical}/line_items`;
    const seen = emu.requestsTo(path).length;
    const rows = await client.getAll<{ id: number }>(path, { project_id: String(PROJECT) }, { perPage: 2 });
    expect(rows.map((r) => r.id)).toEqual([LINE.fixtures, LINE.mobilization, LINE.roughIn]);
    // Page URLs are built here, keeping project_id; the Link header only says whether there is a next page.
    expect(emu.requestsTo(path).slice(seen).map((r) => [r.query.page, r.query.per_page, r.query.project_id])).toEqual([
      ['1', '2', String(PROJECT)],
      ['2', '2', String(PROJECT)],
    ]);
    // A full last page has no `next` link, so no empty page is requested.
    const again = emu.requestsTo(path).length;
    expect(await client.getAll(path, { project_id: String(PROJECT) }, { perPage: 3 })).toHaveLength(3);
    expect(emu.requestsTo(path).length).toBe(again + 1);
  });

  it('reads every page when Procore caps the page size and only says so in Per-Page', async () => {
    emu.pagingHeaders = 'per-page-only';
    const projectsPath = '/rest/v1.1/projects';
    const extra = Array.from({ length: 301 }, (_, i) => ({ id: PROJECT + 100 + i, name: `Project ${i}`, project_number: null, active: true }));
    const saved = emu.projects;
    emu.projects = [...saved, ...extra];
    try {
      const seen = emu.requestsTo(projectsPath).length;
      // We ask for 500 a page; the emulator, like the reference, caps projects at 300.
      const rows = await client.getAll(projectsPath, { company_id: String(COMPANY.id) }, { perPage: 500 });
      expect(rows).toHaveLength(303);
      expect(emu.requestsTo(projectsPath).length).toBe(seen + 2);
    } finally {
      emu.projects = saved;
      emu.pagingHeaders = 'all';
    }
  });

  it('refuses a server that keeps answering with the same page', async () => {
    emu.ignorePage = true;
    try {
      const path = `/rest/v1.0/work_order_contracts/${CONTRACT.electrical}/line_items`;
      const seen = emu.requestsTo(path).length;
      const err = await client.getAll(path, { project_id: String(PROJECT) }, { perPage: 2 }).catch((e) => e);
      expect(err).toBeInstanceOf(ProcoreApiError);
      expect(err.message).toMatch(/repeated the previous page/);
      expect(emu.requestsTo(path).length).toBe(seen + 2);
    } finally {
      emu.ignorePage = false;
    }
  });

  it('waits out the spike window by X-Rate-Limit-Reset and gives up on the hourly one', async () => {
    const path = `/rest/v1.0/projects/${PROJECT}/billing_periods`;
    // Spike window: reset 3 s after Procore's Date header. No Retry-After is sent, as documented.
    emu.throttle.set(path, { times: 1, resetIn: 3 });
    const spike = recording();
    expect(await spike.client.getAll(path)).toHaveLength(1);
    expect(spike.waits).toHaveLength(1);
    expect(spike.waits[0]).toBeGreaterThan(2000);
    expect(spike.waits[0]).toBeLessThanOrEqual(3000);

    // Hourly window: one request, then a clear error saying how long, and nothing more is sent.
    emu.throttle.set(path, { times: 5, resetIn: 1800 });
    const hourly = recording();
    const before = emu.requestsTo(path).length;
    const err = await hourly.client.getAll(path).catch((e) => e);
    expect(err).toBeInstanceOf(ProcoreRateLimitError);
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBeGreaterThan(1790);
    expect(emu.requestsTo(path).length).toBe(before + 1);
    // The spent hourly limit is remembered: the next call fails fast without spending quota.
    await expect(hourly.client.get(path)).rejects.toBeInstanceOf(ProcoreRateLimitError);
    expect(emu.requestsTo(path).length).toBe(before + 1);
    expect(hourly.waits).toEqual([]);
    emu.throttle.delete(path);

    // Spike limits four times in a row: three retries, then stop.
    emu.throttle.set(path, { times: 5, resetIn: 0 });
    const stubborn = recording();
    const tries = emu.requestsTo(path).length;
    await expect(stubborn.client.getAll(path)).rejects.toBeInstanceOf(ProcoreRateLimitError);
    expect(emu.requestsTo(path).length).toBe(tries + 4);
    emu.throttle.delete(path);

    // Real waiting, once, to show the pause actually happens.
    emu.throttle.set(path, { times: 1, resetIn: 1 });
    const started = Date.now();
    expect(await client.getAll(path)).toHaveLength(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
  });

  it('retries reads through server errors with backoff, and honours Retry-After on a 503', async () => {
    const path = `/rest/v1.0/projects/${PROJECT}/billing_periods`;
    emu.faults.set(path, [{ status: 502 }, { status: 500 }, { status: 503, retryAfter: '2' }]);
    const { client: c, waits } = recording();
    const before = emu.requestsTo(path).length;
    expect(await c.getAll(path)).toHaveLength(1);
    expect(emu.requestsTo(path).length).toBe(before + 4);
    expect(waits).toEqual([500, 1000, 2000]);

    // A 503 asking for longer than a request should wait is reported, with the wait.
    emu.faults.set(path, [{ status: 503, retryAfter: '120' }]);
    await expect(recording().client.get(path)).rejects.toMatchObject({ name: 'ProcoreRateLimitError', status: 503, retryAfterSeconds: 120 });
    // Four 500s: three retries, then the error.
    emu.faults.set(path, [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }]);
    await expect(recording().client.get(path)).rejects.toMatchObject({ name: 'ProcoreApiError', status: 500 });
    expect(emu.faults.get(path)).toEqual([]);
  });

  it('never repeats a write, whatever the answer', async () => {
    const path = '/rest/v1.1/requisitions';
    const posts = () => emu.requests.filter((r) => r.method === 'POST' && r.path === path).length;
    for (const failure of [{ throttle: true }, { status: 500 }, { status: 502 }, { status: 503, retryAfter: '1' }]) {
      if ('throttle' in failure) emu.throttle.set(path, { times: 1, resetIn: 0 });
      else emu.faults.set(path, [failure]);
      const { client: c, waits } = recording();
      const before = posts();
      const err = await c.post(path, { project_id: PROJECT }).catch((e) => e);
      expect(posts()).toBe(before + 1);
      expect(waits).toEqual([]);
      expect(outcomeUnknown(err)).toBe(!('throttle' in failure));
      emu.throttle.delete(path);
      emu.faults.delete(path);
    }
    expect(emu.requisitions).toHaveLength(0);
  });

  it('reports other failures with a short excerpt and never the token', async () => {
    const err = await client.get('/rest/v1.0/work_order_contracts/1', { project_id: String(PROJECT) }).catch((e) => e);
    expect(err).toMatchObject({ name: 'ProcoreApiError', status: 404, excerpt: 'Not found' });
    const stale = createProcoreClient({ apiBase: emu.url, companyId: String(COMPANY.id), token: async () => 'emu-access-not-a-real-token' });
    const denied: Error = await stale.get('/rest/v1.1/projects', { company_id: String(COMPANY.id) }).then(
      () => new Error('expected a 401'),
      (e: Error) => e,
    );
    expect(denied).toBeInstanceOf(ProcoreAuthError);
    expect(denied.message).not.toContain('emu-access');
  });
});

// ── Import and push ─────────────────────────────────────────────────────────

describe('import and push', () => {
  let w: World;
  let outsider: World;
  let projectId: string;
  let electricalId: string;
  let parties: Parties;
  let billing: BillingContract;
  const period = (n: number, periodTo: string, progress: PeriodInput['progress']): PeriodInput => ({ applicationNumber: n, periodTo, applicationDate: periodTo, progress });
  const periods = [
    period(1, '2026-09-30', { '1': { work: D(50000) }, '2': { work: D(60000) }, '3': { stored: D(10000) } }),
    period(2, '2026-10-31', { '2': { work: D(90000.5) } }),
    period(3, '2026-11-30', { '2': { work: D(20000) }, '001': { work: D(12000) } }),
  ];
  const pkg = (index: number) => {
    let prior = null;
    for (let i = 0; i < index; i++) prior = stateAfter(buildPackage(parties, billing, prior, periods[i]!));
    return buildPackage(parties, billing, prior, periods[index]!);
  };
  /** Submit application `index` on the imported electrical subcontract and approve it. */
  const approved = async (index: number) => {
    const app = await submit(w, pkg(index), { contractId: electricalId });
    expect(await openFindings(w, app.id)).toEqual([]);
    await approveApplication(w.db, w.controller, app.id);
    return app.id;
  };

  beforeAll(async () => {
    configure();
    w = await createWorld();
    outsider = await createWorld();
    await connect(w, 'code-main');
  });

  it('imports a project, its vendors, approved subcontracts, schedules and change orders', async () => {
    await expect(importProject(w.db, w.accountant, String(PROJECT))).rejects.toBeInstanceOf(PermissionError);
    await expect(importProject(w.db, w.owner, 'not-an-id')).rejects.toThrow(/Choose a Procore project/);
    await expect(importProject(w.db, w.owner, '12345')).rejects.toThrow(/not found in the connected Procore company/);

    // The vendor list is rate limited once; the import waits and carries on.
    const vendorsPath = `/rest/v1.1/projects/${PROJECT}/vendors`;
    emu.throttle.set(vendorsPath, { times: 1, resetIn: 0 });
    const throttled = emu.throttled;
    const result = await importProject(w.db, w.owner, String(PROJECT));
    expect(emu.throttled).toBe(throttled + 1);
    expect(emu.requestsTo(vendorsPath)).toHaveLength(2);

    expect(result.created).toEqual({ subcontractors: 1, contracts: 2, scheduleLines: 6, changeOrders: 5 });
    expect(result.updated).toEqual({ contracts: 0 });
    projectId = result.projectId;

    const [project] = await w.db.select().from(projects).where(eq(projects.id, projectId));
    expect(project).toMatchObject({ orgId: w.orgId, name: 'Harbor Point Logistics Center', number: '9911', externalSource: 'procore', externalId: String(PROJECT) });

    // The vendor that was already entered by hand is linked, not duplicated.
    const subs = await w.db.select().from(subcontractors).where(eq(subcontractors.orgId, w.orgId));
    expect(subs.map((s) => [s.name, s.externalSource, s.externalId]).sort()).toEqual([
      ['Gulf Coast Mechanical, Inc.', 'procore', String(VENDOR.gulfCoast)],
      ['Lone Star Electric, LLC', 'procore', String(VENDOR.loneStar)],
    ]);
    expect(subs.find((s) => s.externalId === String(VENDOR.loneStar))!.id).toBe(w.subcontractorId);
    expect(subs.find((s) => s.externalId === String(VENDOR.gulfCoast))!.contactEmail).toBeNull(); // Procore's value was not an email address

    const imported = await w.db.select().from(contracts).where(and(eq(contracts.orgId, w.orgId), eq(contracts.projectId, projectId)));
    expect(imported.map((c) => c.number).sort()).toEqual(['HP-07', 'HP-12']);
    const electrical = imported.find((c) => c.number === 'HP-07')!;
    const hvac = imported.find((c) => c.number === 'HP-12')!;
    electricalId = electrical.id;
    expect(electrical).toMatchObject({ title: 'Electrical', originalAmount: D(500000), retainageWorkBps: 1000, retainageStoredBps: 1000, externalSource: 'procore', externalId: String(CONTRACT.electrical), subcontractorId: w.subcontractorId });
    // 1234.56 + 1000.10 + 19.99, to the cent; no retainage in Procore.
    expect(hvac).toMatchObject({ title: 'HVAC', originalAmount: 225465, retainageWorkBps: 0, retainageStoredBps: 0, externalId: String(CONTRACT.hvac) });

    const schedule = (await w.db.select().from(sovLines).where(eq(sovLines.contractId, electrical.id))).sort((a, b) => a.sortOrder - b.sortOrder);
    expect(schedule.map((s) => [s.itemNo, s.description, s.scheduledValue, s.externalId, !!s.changeOrderId])).toEqual([
      ['1', 'Mobilization', D(50000), String(LINE.mobilization), false],
      ['2', 'Rough-in, levels 1-3', D(300000), String(LINE.roughIn), false],
      ['3', 'Fixtures and trim', D(150000), String(LINE.fixtures), false],
      ['001', 'Added receptacles, level 2', D(12000), null, true], // the approved change order's own line
    ]);
    const hvacSchedule = (await w.db.select().from(sovLines).where(eq(sovLines.contractId, hvac.id))).filter((s) => !s.changeOrderId).sort((a, b) => a.sortOrder - b.sortOrder);
    expect(hvacSchedule.map((s) => [s.scheduledValue, s.externalId])).toEqual([
      [123456, '7001'],
      [100010, '7002'],
      [1999, '7003'],
    ]);

    const cos = (await w.db.select().from(changeOrders).where(eq(changeOrders.contractId, electrical.id))).sort((a, b) => a.number.localeCompare(b.number));
    expect(cos.map((c) => [c.number, c.status, c.amount, c.externalId])).toEqual([
      ['001', 'approved', D(12000), '9301'],
      ['002', 'pending', 450050, '9302'],
      ['003', 'rejected', -D(3000), '9303'],
      ['004', 'void', D(100), '9304'],
    ]);

    // Everything left out is named, with the reason.
    expect(result.skipped.map((s) => s.what).sort()).toEqual([
      'Project Harbor Point Logistics Center: state',
      'Subcontract HP-12: retainage',
      'Subcontract HP-15',
      'Subcontract HP-20',
      'Vendor Dormant Drywall Co.',
    ]);
    const reason = (what: string) => result.skipped.find((s) => s.what === what)!.reason;
    expect(reason('Subcontract HP-15')).toMatch(/Unit\/quantity billing is not supported/);
    expect(reason('Subcontract HP-20')).toMatch(/“Draft”.*Only Approved or Complete/);
    expect(reason('Subcontract HP-12: retainage')).toMatch(/Set the retainage on the contract/);
    expect(reason('Vendor Dormant Drywall Co.')).toMatch(/inactive/);
    // Nothing was fetched for contracts that were not going to be imported.
    expect(emu.requestsTo(`/rest/v1.0/work_order_contracts/${CONTRACT.concrete}/line_items`)).toHaveLength(0);
    expect(emu.requestsTo(`/rest/v1.0/work_order_contracts/${CONTRACT.painting}`)).toHaveLength(0);

    const status = await procoreStatus(w.db, w.owner);
    expect(status.lastSyncAt).toBeInstanceOf(Date);
    const [event] = await w.db.select().from(auditEvents).where(and(eq(auditEvents.orgId, w.orgId), eq(auditEvents.action, 'integration.procore_imported')));
    expect(event!.summary).toBe('Imported project Harbor Point Logistics Center from Procore: created 1 subcontractor, 2 subcontracts, 6 schedule lines and 5 change orders; updated 0 subcontracts; 5 items skipped or needing attention');

    expect(await listProcoreProjects(w.db, w.owner)).toEqual([
      { id: String(PROJECT), name: 'Harbor Point Logistics Center', number: '9911', active: true, imported: true },
      { id: String(PROJECT + 1), name: 'Old Mill Renovation', number: null, active: false, imported: false },
    ]);
  });

  it('creates nothing new when the same project is imported again', async () => {
    const count = async () => ({
      projects: (await w.db.select().from(projects).where(eq(projects.orgId, w.orgId))).length,
      subcontractors: (await w.db.select().from(subcontractors).where(eq(subcontractors.orgId, w.orgId))).length,
      contracts: (await w.db.select().from(contracts).where(eq(contracts.orgId, w.orgId))).length,
      lines: (await w.db.select().from(sovLines).where(eq(sovLines.orgId, w.orgId))).length,
      changeOrders: (await w.db.select().from(changeOrders).where(eq(changeOrders.orgId, w.orgId))).length,
    });
    const before = await count();
    const again = await importProject(w.db, w.owner, String(PROJECT));
    expect(again.projectId).toBe(projectId);
    expect(again.created).toEqual({ subcontractors: 0, contracts: 0, scheduleLines: 0, changeOrders: 0 });
    expect(again.updated).toEqual({ contracts: 0 });
    expect(again.skipped).toHaveLength(5);
    expect(await count()).toEqual(before);
  });

  it('picks up changes made in Procore without discarding what was set here', async () => {
    const [hvacBefore] = await w.db.select().from(contracts).where(and(eq(contracts.orgId, w.orgId), eq(contracts.externalId, String(CONTRACT.hvac))));
    // The user followed the note and set retainage by hand; Procore still has none.
    await w.db.update(contracts).set({ retainageWorkBps: 500, retainageStoredBps: 500 }).where(eq(contracts.id, hvacBefore!.id));
    const hvac = emu.contracts.find((c) => c.id === CONTRACT.hvac)!;
    hvac.title = 'HVAC and controls';
    emu.changeOrders.find((co) => co.id === 9305)!.grand_total = '900.00';
    emu.lineItems[CONTRACT.hvac]!.push({ id: 7004, position: 4, description: 'Commissioning', amount: '500.00' });

    const result = await importProject(w.db, w.owner, String(PROJECT));
    expect(result.created).toEqual({ subcontractors: 0, contracts: 0, scheduleLines: 1, changeOrders: 0 });
    expect(result.updated).toEqual({ contracts: 1 });
    expect(result.skipped.map((s) => s.what)).not.toContain('Subcontract HP-12: retainage');

    const [after] = await w.db.select().from(contracts).where(eq(contracts.id, hvacBefore!.id));
    expect(after).toMatchObject({ title: 'HVAC and controls', originalAmount: 225465 + 50000, retainageWorkBps: 500, retainageStoredBps: 500 });
    const lines = (await w.db.select().from(sovLines).where(eq(sovLines.contractId, after!.id))).filter((s) => !s.changeOrderId);
    expect(lines.map((l) => l.externalId).sort()).toEqual(['7001', '7002', '7003', '7004']);
    const [co] = await w.db.select().from(changeOrders).where(eq(changeOrders.contractId, after!.id));
    expect(co).toMatchObject({ amount: D(900), status: 'approved' });
  });

  it('explains exactly why an application cannot be pushed', async () => {
    // Make the imported records usable for billing, as a user would after reading the import notes.
    await updateProject(w.db, w.owner, projectId, { name: 'Harbor Point Logistics Center', number: '9911', state: 'TX' });
    parties = { ...w.parties, project: { name: 'Harbor Point Logistics Center', number: '9911', address: '1 Harbor Way, Houston, TX 77002', state: 'TX' } };
    billing = {
      number: 'HP-07',
      date: '2026-03-02',
      description: 'Electrical',
      originalAmount: D(500000),
      retainageWorkBps: 1000,
      retainageStoredBps: 1000,
      sov: [
        { itemNo: '1', description: 'Mobilization', scheduledValue: D(50000) },
        { itemNo: '2', description: 'Rough-in, levels 1-3', scheduledValue: D(300000) },
        { itemNo: '3', description: 'Fixtures and trim', scheduledValue: D(150000) },
      ],
      changeOrders: [{ number: '001', title: 'Added receptacles, level 2', amount: D(12000) }],
    };

    // Not approved yet.
    const pending = await submit(w, pkg(0), { contractId: electricalId });
    expect(await openFindings(w, pending.id)).toEqual([]);
    expect(await canPushToProcore(w.db, w.controller, pending.id)).toEqual({ available: false, reason: 'Only approved applications can be sent to Procore.' });
    await expect(pushToProcore(w.db, w.controller, pending.id)).rejects.toThrow('Only approved applications can be sent to Procore.');
    await approveApplication(w.db, w.controller, pending.id);
    expect(await canPushToProcore(w.db, w.controller, pending.id)).toEqual({ available: true, reason: null });

    // A role without export rights.
    expect(await canPushToProcore(w.db, w.pm, pending.id)).toMatchObject({ available: false, reason: expect.stringMatching(/role/) });
    await expect(pushToProcore(w.db, w.pm, pending.id)).rejects.toBeInstanceOf(PermissionError);

    // Not configured.
    unconfigure();
    expect(await canPushToProcore(w.db, w.controller, pending.id)).toMatchObject({ available: false, reason: expect.stringMatching(/not configured/) });
    configure();

    // A billed line that has lost its Procore line id.
    const [roughIn] = await w.db.select().from(sovLines).where(and(eq(sovLines.contractId, electricalId), eq(sovLines.externalId, String(LINE.roughIn))));
    await w.db.update(sovLines).set({ externalId: null }).where(eq(sovLines.id, roughIn!.id));
    const unmapped = await canPushToProcore(w.db, w.controller, pending.id);
    expect(unmapped.available).toBe(false);
    expect(unmapped.reason).toMatch(/Line 2 “Rough-in, levels 1-3” has billing this period but no Procore line id/);
    await w.db.update(sovLines).set({ externalId: String(LINE.roughIn) }).where(eq(sovLines.id, roughIn!.id));

    // A subcontract that was created by hand, not imported.
    const manual = await submit(w, packageFor(w, 0, null), { contractId: w.contractId });
    await approveApplication(w.db, w.controller, manual.id);
    const notImported = await canPushToProcore(w.db, w.controller, manual.id);
    expect(notImported.available).toBe(false);
    expect(notImported.reason).toMatch(/was not imported from Procore.*Create or import the subcontract from Procore to enable this, or use file export\./);
    await expect(pushToProcore(w.db, w.controller, manual.id)).rejects.toThrow(/was not imported from Procore/);

    // Not connected: an organisation with no Procore connection of its own.
    const theirs = await submit(outsider, packageFor(outsider, 0, null));
    await approveApplication(outsider.db, outsider.controller, theirs.id);
    expect(await canPushToProcore(outsider.db, outsider.controller, theirs.id)).toEqual({ available: false, reason: 'Procore is not connected. Connect it in Settings → Integrations.' });

    // None of that touched Procore or recorded a transfer.
    expect(emu.requisitions).toHaveLength(0);
    expect(await w.db.select().from(transfers).where(eq(transfers.orgId, w.orgId))).toHaveLength(0);
  });

  it('pushes an approved application as a draft invoice and records exactly that', async () => {
    const [app] = await w.db.select().from(payApplications).where(and(eq(payApplications.contractId, electricalId), eq(payApplications.applicationNumber, 1)));
    const tokens = await storedTokens(w);

    const result = await pushToProcore(w.db, w.controller, app!.id);
    expect(result).toEqual({ transferId: expect.stringMatching(/^trf_/), status: 'completed', externalRef: '77001', error: null });

    expect(emu.requisitions).toHaveLength(1);
    const received = emu.requisitions[0]!;
    expect(received.authorization).toBe(`Bearer ${tokens.accessToken}`);
    expect(received.companyId).toBe(String(COMPANY.id));
    expect(received.body).toEqual({
      project_id: PROJECT,
      commitment_id: CONTRACT.electrical,
      requisition: {
        period_id: 6001,
        requisition_start: '2026-09-01',
        requisition_end: '2026-09-30',
        billing_date: '2026-09-30',
        invoice_number: '1',
        status: 'draft',
        final: false,
        items: [
          { item_type: 'contract_item', line_item_id: LINE.mobilization, work_completed_this_period: '50000.00', materials_presently_stored: '0.00' },
          { item_type: 'contract_item', line_item_id: LINE.roughIn, work_completed_this_period: '60000.00', materials_presently_stored: '0.00' },
          { item_type: 'contract_item', line_item_id: LINE.fixtures, work_completed_this_period: '0.00', materials_presently_stored: '10000.00' },
        ],
      },
    });
    // No origin id, no retainage, anywhere in what was sent.
    expect(JSON.stringify(received.body)).not.toMatch(/origin_id|retainage/);

    const rows = await w.db.select().from(transfers).where(eq(transfers.payApplicationId, app!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: result.transferId, orgId: w.orgId, kind: 'procore', status: 'completed', externalRef: '77001', error: null, createdBy: w.controller.userId });
    expect((await appRow(w, app!.id)).transferStatus).toBe('synced');

    const [event] = await w.db.select().from(auditEvents).where(and(eq(auditEvents.payApplicationId, app!.id), eq(auditEvents.action, 'transfer.procore_pushed')));
    expect(event!.summary).toContain('draft invoice 77001');
    expect(event!.summary).toContain('$110,000.00 work this period and $10,000.00 materials stored');
    expect(JSON.stringify(event)).not.toContain(tokens.accessToken);

    // It cannot be sent twice.
    expect(await canPushToProcore(w.db, w.controller, app!.id)).toEqual({ available: false, reason: 'This application was already sent to Procore (invoice 77001).' });
    await expect(pushToProcore(w.db, w.controller, app!.id)).rejects.toThrow(/already sent to Procore/);
    expect(emu.requisitions).toHaveLength(1);
  });

  it('records a failure honestly when no billing period covers the date, and when Procore refuses', async () => {
    const appId = await approved(1); // period to 2026-10-31; Procore only has September
    const posts = () => emu.requests.filter((r) => r.method === 'POST' && r.path === '/rest/v1.1/requisitions').length;
    const before = posts();

    const failed = await pushToProcore(w.db, w.controller, appId);
    expect(failed).toEqual({ transferId: expect.stringMatching(/^trf_/), status: 'failed', externalRef: null, error: 'No billing period in Procore covers Oct 31, 2026. Create it in Procore and try again.' });
    expect(posts()).toBe(before); // nothing was sent, and no billing period was created
    expect(emu.requests.some((r) => r.method === 'POST' && r.path.endsWith('/billing_periods'))).toBe(false);
    expect(emu.requisitions).toHaveLength(1);

    let rows = await w.db.select().from(transfers).where(eq(transfers.payApplicationId, appId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'procore', status: 'failed', externalRef: null, error: failed.error });
    expect((await appRow(w, appId)).transferStatus).toBe('failed');
    const [event] = await w.db.select().from(auditEvents).where(and(eq(auditEvents.payApplicationId, appId), eq(auditEvents.action, 'transfer.procore_failed')));
    expect(event!.summary).toContain('No billing period in Procore covers Oct 31, 2026');
    // People who manage integrations are told; others are not.
    const notices = await w.db.select().from(notifications).where(and(eq(notifications.orgId, w.orgId), eq(notifications.type, 'integration.failed')));
    expect(notices.map((n) => n.userId)).toEqual([w.owner.userId]);
    expect(notices[0]).toMatchObject({ href: `/applications/${appId}`, body: failed.error });
    // Still available to try again.
    expect(await canPushToProcore(w.db, w.controller, appId)).toEqual({ available: true, reason: null });

    // The period now exists, but Procore refuses the invoice.
    emu.billingPeriods.push({ id: 6002, start_date: '2026-10-01', end_date: '2026-10-31', due_date: '2026-11-10', status: 'open' });
    emu.rejectNextRequisition = { status: 422, body: { errors: { period_id: ['is closed for this commitment'] } } };
    const refused = await pushToProcore(w.db, w.controller, appId);
    expect(refused.status).toBe('failed');
    expect(refused.error).toMatch(/Procore returned an error \(422\)\..*is closed for this commitment/);
    expect(refused.error).not.toContain((await storedTokens(w)).accessToken);
    expect((await appRow(w, appId)).transferStatus).toBe('failed');
    expect(emu.requisitions).toHaveLength(1);

    // Third time it goes through, with the half-dollar intact.
    const sent = await pushToProcore(w.db, w.controller, appId);
    expect(sent).toMatchObject({ status: 'completed', externalRef: '77002', error: null });
    expect(emu.requisitions[1]!.body.requisition).toMatchObject({
      period_id: 6002,
      billing_date: '2026-10-31',
      invoice_number: '2',
      status: 'draft',
      items: [
        { line_item_id: LINE.mobilization, work_completed_this_period: '0.00', materials_presently_stored: '0.00' },
        { line_item_id: LINE.roughIn, work_completed_this_period: '90000.50', materials_presently_stored: '0.00' },
        { line_item_id: LINE.fixtures, work_completed_this_period: '0.00', materials_presently_stored: '0.00' },
      ],
    });
    rows = await w.db.select().from(transfers).where(eq(transfers.payApplicationId, appId));
    expect(rows.map((r) => r.status).sort()).toEqual(['completed', 'failed', 'failed']);
    expect((await appRow(w, appId)).transferStatus).toBe('synced');
  });

  it('does not push billing against change-order lines', async () => {
    const appId = await approved(2); // bills $12,000 on change order 001
    const check = await canPushToProcore(w.db, w.controller, appId);
    expect(check.available).toBe(false);
    expect(check.reason).toMatch(/bills against change-order line 001 “Added receptacles, level 2” this period\. Pushing change-order billing is not supported yet; use file export\./);
    await expect(pushToProcore(w.db, w.controller, appId)).rejects.toThrow(/change-order/);
    expect((await appRow(w, appId)).transferStatus).toBe('none');
    expect(await w.db.select().from(transfers).where(eq(transfers.payApplicationId, appId))).toHaveLength(0);
    expect(emu.requisitions).toHaveLength(2);
  });

  it('never lets a second organisation use the first organisation’s connection', async () => {
    const requests = emu.requests.length;
    const grants = emu.grants.length;
    const [mine] = await w.db.select().from(payApplications).where(and(eq(payApplications.contractId, electricalId), eq(payApplications.applicationNumber, 3)));
    const [theirs] = await outsider.db.select().from(payApplications).where(eq(payApplications.orgId, outsider.orgId));

    expect(await procoreStatus(outsider.db, outsider.owner)).toMatchObject({ configured: true, connected: false, companyId: null, companyName: null, lastSyncAt: null, connectedByName: null });
    await expect(listCompanies(outsider.db, outsider.owner)).rejects.toThrow(/not connected/);
    await expect(listProcoreProjects(outsider.db, outsider.owner)).rejects.toThrow(/not connected/);
    await expect(importProject(outsider.db, outsider.owner, String(PROJECT))).rejects.toThrow(/not connected/);
    await expect(selectCompany(outsider.db, outsider.owner, String(COMPANY.id))).rejects.toThrow(/not connected/);

    // Another organisation's application is invisible, even to its owner role.
    await expect(canPushToProcore(outsider.db, outsider.owner, mine!.id)).rejects.toThrow('Application not found.');
    await expect(pushToProcore(outsider.db, outsider.owner, mine!.id)).rejects.toThrow('Application not found.');
    // Their own approved application cannot ride on our connection.
    await expect(pushToProcore(outsider.db, outsider.owner, theirs!.id)).rejects.toThrow(/not connected/);
    // Disconnecting from the other organisation does nothing to ours.
    await disconnect(outsider.db, outsider.owner);

    expect(emu.requests.length).toBe(requests);
    expect(emu.grants.length).toBe(grants);
    expect(await outsider.db.select().from(transfers).where(eq(transfers.orgId, outsider.orgId))).toHaveLength(0);
    expect(await outsider.db.select().from(projects).where(and(eq(projects.orgId, outsider.orgId), eq(projects.externalSource, 'procore')))).toHaveLength(0);
    expect(await outsider.db.select().from(integrations).where(eq(integrations.orgId, outsider.orgId))).toHaveLength(0);
    expect(await procoreStatus(w.db, w.owner)).toMatchObject({ connected: true, companyId: String(COMPANY.id) });
    expect(await listProcoreProjects(w.db, w.owner)).toHaveLength(2);
  });
});
