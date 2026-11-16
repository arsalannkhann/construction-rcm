/**
 * The mobile app's API (src/app/api/mobile): sign-in on the website's
 * sessions, organisation isolation, duplicate-proof capture, and the narrow
 * set of approvals the phone may make.
 */
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { auditEvents, documents, payApplications } from '@/db/schema';
import { totpCode } from '@/server/auth/totp';
import { submitForApproval } from '@/server/services/review';
import { defects } from '@/server/samples/scenario';
import { enableMfa, PASSWORD } from './helpers/auth';
import { createWorld, dollars as D, getApp, packageFor, stateAfter, submit, type World } from './helpers/world';

// Route handlers read the request's headers through next/headers; give them this request's.
let requestHeaders = new Headers();
vi.mock('next/headers', () => ({
  headers: async () => requestHeaders,
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

const session = await import('@/app/api/mobile/session/route');
const verify = await import('@/app/api/mobile/session/verify/route');
const me = await import('@/app/api/mobile/me/route');
const home = await import('@/app/api/mobile/home/route');
const apps = await import('@/app/api/mobile/applications/route');
const appDetail = await import('@/app/api/mobile/applications/[id]/route');
const approve = await import('@/app/api/mobile/applications/[id]/approve/route');
const comments = await import('@/app/api/mobile/applications/[id]/comments/route');
const projects = await import('@/app/api/mobile/projects/route');
const parts = await import('@/app/api/uploads/[uploadId]/parts/[part]/route');

const BASE = 'https://zephric.example';

function req(path: string, init: { method?: string; token?: string | null; body?: unknown; raw?: Uint8Array } = {}): Request {
  const h = new Headers({ host: 'zephric.example', 'x-forwarded-for': '198.51.100.20', 'user-agent': 'Zephric/1.0 (test)' });
  if (init.token) h.set('authorization', `Bearer ${init.token}`);
  if (init.body !== undefined) h.set('content-type', 'application/json');
  requestHeaders = h;
  return new Request(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: h,
    body: init.raw ? (init.raw as BodyInit) : init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

async function signIn(email: string, password = PASSWORD): Promise<string> {
  const res = await session.POST(req('/api/mobile/session', { method: 'POST', body: { email, password } }));
  const body = (await res.json()) as { status: string; token: string };
  expect(body.status).toBe('signed_in');
  return body.token;
}

/** Stage one file in parts, as the app does, and describe it for the submit request. */
async function stage(token: string, name: string, bytes: Uint8Array, type: string) {
  const uploadId = `up${crypto.randomUUID().replace(/-/g, '')}`;
  const res = await parts.POST(req(`/api/uploads/${uploadId}/parts/0`, { method: 'POST', token, raw: bytes }), { params: Promise.resolve({ uploadId, part: '0' }) });
  expect(res.status).toBe(200);
  return { uploadId, name, type, size: bytes.byteLength };
}

// A 1×1 PNG, as a stand-in for a photo of a page.
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));

describe('signing in from the app', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld();
  });

  it('issues a session token that opens the API, and nothing without it', async () => {
    const token = await signIn(w.controller.userEmail);
    const res = await me.GET();
    expect(res.status).toBe(401); // the last request had no token

    req('/api/mobile/me', { token });
    const ok = await me.GET();
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toContain('no-store');
    expect(await ok.json()).toMatchObject({
      user: { email: w.controller.userEmail },
      organization: { id: w.orgId, role: 'controller' },
      permissions: { upload: true, review: true, approve: true },
    });
  });

  it('refuses a wrong password without saying which part was wrong', async () => {
    const res = await session.POST(req('/api/mobile/session', { method: 'POST', body: { email: w.controller.userEmail, password: 'not the password' } }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'bad_credentials' });
  });

  it('never takes the token from the address', async () => {
    const token = await signIn(w.accountant.userEmail);
    req(`/api/mobile/home?token=${token}`);
    expect((await home.GET()).status).toBe(401);
  });

  it('ends the session on the server at sign-out', async () => {
    const token = await signIn(w.pm.userEmail);
    req('/api/mobile/home', { token });
    expect((await home.GET()).status).toBe(200);
    expect((await session.DELETE()).status).toBe(200);
    req('/api/mobile/home', { token });
    const after = await home.GET();
    expect(after.status).toBe(401);
    expect(await after.json()).toMatchObject({ code: 'signed_out' });
  });

  it('asks for the second step when the account has one, and only then gives a session', async () => {
    const { secret } = await enableMfa(w.db, w.viewer.userId);
    const first = await session.POST(req('/api/mobile/session', { method: 'POST', body: { email: w.viewer.userEmail, password: PASSWORD } }));
    const step = (await first.json()) as { status: string; challenge: string; token?: string };
    expect(step.status).toBe('verify');
    expect(step.token).toBeUndefined();

    const wrong = await verify.POST(req('/api/mobile/session/verify', { method: 'POST', body: { challenge: step.challenge, code: '000000' } }));
    expect(await wrong.json()).toMatchObject({ status: 'wrong_code' });

    const right = await verify.POST(req('/api/mobile/session/verify', { method: 'POST', body: { challenge: step.challenge, code: totpCode(secret, new Date()) } }));
    const done = (await right.json()) as { status: string; token: string };
    expect(done.status).toBe('signed_in');
    req('/api/mobile/me', { token: done.token });
    expect((await me.GET()).status).toBe(200);
  });
});

describe('organisation isolation', () => {
  it('never shows one organisation’s application to a member of another', async () => {
    const a = await createWorld();
    const b = await createWorld();
    const theirs = await submit(b, packageFor(b, 0, null));
    const token = await signIn(a.owner.userEmail);
    const res = await appDetail.GET(req(`/api/mobile/applications/${theirs.id}`, { token }), idParams(theirs.id));
    expect(res.status).toBe(404);

    req('/api/mobile/projects', { token });
    const list = (await (await projects.GET()).json()) as { items: Array<{ id: string }> };
    expect(list.items.map((p) => p.id)).toEqual([a.projectId]);
  });
});

describe('capture from the phone', () => {
  let w: World;
  let token: string;
  beforeAll(async () => {
    w = await createWorld();
    token = await signIn(w.pm.userEmail); // a project manager may upload, and nothing more
  });

  it('creates one application per draft however often the submit is retried', async () => {
    const clientRef = crypto.randomUUID();
    const pdf = await stage(token, 'payapp-1.pdf', new Uint8Array(Buffer.from('%PDF-1.4\n%%EOF\n')), 'application/pdf');
    const body = { clientRef, contractId: w.contractId, staged: [pdf] };

    const first = await apps.POST(req('/api/mobile/applications', { method: 'POST', token, body }));
    expect(first.status).toBe(201);
    const { id, duplicate } = (await first.json()) as { id: string; duplicate: boolean };
    expect(duplicate).toBe(false);

    // The response was lost; the app sends the same draft again. The staged parts are gone by now.
    const again = await apps.POST(req('/api/mobile/applications', { method: 'POST', token, body }));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ id, duplicate: true });

    const received = await w.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.orgId, w.orgId), eq(auditEvents.action, 'application.received')));
    expect(received.filter((e) => (e.data as { clientRef?: string } | null)?.clientRef === clientRef)).toHaveLength(1);
    expect((await getApp(w, id)).submittedBy).toBe(w.pm.userId);
  });

  it('joins photos of a document into one PDF, a page each', async () => {
    const p1 = await stage(token, 'Page 1.png', PNG, 'image/png');
    const p2 = await stage(token, 'Page 2.png', PNG, 'image/png');
    const res = await apps.POST(req('/api/mobile/applications', { method: 'POST', token, body: { clientRef: crypto.randomUUID(), staged: [p1, p2], photosName: 'Pay app 4' } }));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const docs = await w.db.select().from(documents).where(eq(documents.payApplicationId, id));
    expect(docs.map((d) => [d.filename, d.mimeType])).toEqual([['Pay app 4.pdf', 'application/pdf']]);
  });

  it('refuses capture to someone whose role cannot upload', async () => {
    const viewer = await signIn(w.viewer.userEmail);
    const uploadId = `up${crypto.randomUUID().replace(/-/g, '')}`;
    const res = await parts.POST(req(`/api/uploads/${uploadId}/parts/0`, { method: 'POST', token: viewer, raw: PNG }), { params: Promise.resolve({ uploadId, part: '0' }) });
    expect(res.status).toBe(403);
  });
});

describe('approving from the phone', () => {
  let w: World;
  let controller: string;
  beforeAll(async () => {
    w = await createWorld();
    controller = await signIn(w.controller.userEmail);
  });

  const approveReq = (id: string, token: string, body: unknown) => approve.POST(req(`/api/mobile/applications/${id}/approve`, { method: 'POST', token, body }), idParams(id));
  const detail = async (id: string, token: string) =>
    (await (await appDetail.GET(req(`/api/mobile/applications/${id}`, { token }), idParams(id))).json()) as {
      version: number;
      amounts: { verified: number };
      can: { approve: boolean };
      desktopReason: string | null;
    };

  it('sends anything not yet submitted for approval to the desktop', async () => {
    const app = await submit(w, packageFor(w, 0, null));
    expect(app.status).toBe('needs_review');
    const d = await detail(app.id, controller);
    expect(d.can.approve).toBe(false);
    expect(d.desktopReason).toMatch(/not been submitted for approval/);
    const res = await approveReq(app.id, controller, { expectedVersion: d.version, expectedAmount: d.amounts.verified });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'desktop_required' });
    expect((await getApp(w, app.id)).status).toBe('needs_review');
  });

  it('approves a clean application at exactly the amount shown, and only then', async () => {
    const [app] = await w.db.select().from(payApplications).where(eq(payApplications.orgId, w.orgId));
    await submitForApproval(w.db, w.accountant, app!.id, 'Clean');
    const d = await detail(app!.id, controller);
    expect(d.can.approve).toBe(true);
    expect(d.amounts.verified).toBe(D(99000));

    const accountant = await signIn(w.accountant.userEmail);
    expect((await approveReq(app!.id, accountant, { expectedVersion: d.version, expectedAmount: d.amounts.verified })).status).toBe(403);

    const stale = await approveReq(app!.id, controller, { expectedVersion: d.version, expectedAmount: d.amounts.verified + 100 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'conflict' });

    const ok = await approveReq(app!.id, controller, { expectedVersion: d.version, expectedAmount: d.amounts.verified });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ approvedAmount: D(99000) });
    const approved = await getApp(w, app!.id);
    expect(approved.status).toBe('approved');
    expect(approved.decisionNote).toBe('Approved in the Zephric mobile app.');
  });

  it('never approves past an open blocking finding, even once submitted for approval', async () => {
    const app2 = await submit(w, packageFor(w, 1, stateAfter(packageFor(w, 0, null)), (p) => defects.understatePreviousCertificates(p, D(10000))));
    expect(app2.openBlocking).toBeGreaterThan(0);
    await submitForApproval(w.db, w.accountant, app2.id, 'For the controller to decide');
    const d = await detail(app2.id, controller);
    expect(d.can.approve).toBe(false);
    expect(d.desktopReason).toMatch(/blocking finding/);
    const res = await approveReq(app2.id, controller, { expectedVersion: d.version, expectedAmount: d.amounts.verified });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'desktop_required' });
    expect((await getApp(w, app2.id)).status).toBe('pending_approval');
  });

  it('records comments from the phone on the application', async () => {
    const [app] = await w.db.select().from(payApplications).where(eq(payApplications.orgId, w.orgId));
    const res = await comments.POST(req(`/api/mobile/applications/${app!.id}/comments`, { method: 'POST', token: controller, body: { body: 'Checked on site.' } }), idParams(app!.id));
    expect(res.status).toBe(201);
  });
});
