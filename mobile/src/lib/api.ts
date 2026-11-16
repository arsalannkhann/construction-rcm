/**
 * The Zephric API, as the app sees it (src/app/api/mobile on the server).
 *
 * The session token goes in the Authorization header and nowhere else. A
 * response saying the session has ended signs the app out. Every amount is in
 * cents, computed by the server.
 */
import { fetch } from 'expo/fetch';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string | null,
    public body: Record<string, unknown> | null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The request never reached the server, or no answer came back. */
export class NetworkError extends Error {
  constructor(message = 'Zephric could not be reached. Check your connection and try again.') {
    super(message);
    this.name = 'NetworkError';
  }
}

const version = Constants.expoConfig?.version ?? '1.0.0';
const userAgent = `Zephric Mobile/${version} (${Platform.OS === 'ios' ? 'iOS' : 'Android'} ${Platform.Version})`;

type Config = { server: string; token: string | null; onSignedOut: (reason: string) => void };
let config: Config = { server: '', token: null, onSignedOut: () => undefined };

export function configureApi(next: Partial<Config>): void {
  config = { ...config, ...next };
}

export function currentServer(): string {
  return config.server;
}

/** For native downloads that cannot go through fetch (document preview). */
export function authHeaders(): Record<string, string> {
  return config.token ? { authorization: `Bearer ${config.token}`, 'user-agent': userAgent } : { 'user-agent': userAgent };
}

type Options = { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; timeoutMs?: number; signal?: AbortSignal; token?: string | null; server?: string };

async function send(path: string, opts: Options, body: BodyInit | undefined, contentType: string | undefined): Promise<Response> {
  const token = opts.token === undefined ? config.token : opts.token;
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': userAgent };
  if (contentType) headers['content-type'] = contentType;
  if (token) headers.authorization = `Bearer ${token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  opts.signal?.addEventListener('abort', () => controller.abort());
  try {
    return await fetch(`${opts.server ?? config.server}${path}`, { method: opts.method ?? 'GET', headers, body, signal: controller.signal, credentials: 'omit' });
  } catch {
    throw new NetworkError();
  } finally {
    clearTimeout(timer);
  }
}

async function read<T>(res: Response, sentToken: boolean): Promise<T> {
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  if (res.ok && json) return json as T;
  const code = typeof json?.code === 'string' ? json.code : null;
  const message = typeof json?.error === 'string' ? json.error : res.status >= 500 ? 'Something went wrong on Zephric’s side. Please try again.' : 'That did not work. Please try again.';
  if (res.status === 401 && code === 'signed_out' && sentToken) config.onSignedOut(message);
  throw new ApiError(message, res.status, code, json);
}

export async function api<T>(path: string, opts: Options = {}): Promise<T> {
  const res = await send(path, opts, opts.body === undefined ? undefined : JSON.stringify(opts.body), opts.body === undefined ? undefined : 'application/json');
  return read<T>(res, !!(opts.token === undefined ? config.token : opts.token));
}

/** One part of a staged file (src/server/services/uploads.ts on the server). Sending the same part again replaces it. */
export async function putPart(uploadId: string, part: number, bytes: Uint8Array): Promise<void> {
  // expo/fetch sends typed arrays as they are (normalizeBodyInitAsync); the DOM typing just does not list them.
  const res = await send(`/api/uploads/${uploadId}/parts/${part}`, { method: 'POST', timeoutMs: 120_000 }, bytes as unknown as BodyInit, 'application/octet-stream');
  await read<{ ok: true }>(res, true);
}

/** Whether the server answers at all, for the "Server" setting. */
export async function ping(server: string): Promise<boolean> {
  try {
    const res = await send('/api/health', { server, token: null, timeoutMs: 8_000 }, undefined, undefined);
    return res.status < 500;
  } catch {
    return false;
  }
}

export function messageOf(err: unknown): string {
  if (err instanceof ApiError || err instanceof NetworkError) return err.message;
  return 'Something went wrong. Please try again.';
}

// ── Shapes the server returns (src/server/services/mobile.ts) ─────────────────

export type AppStatus = 'processing' | 'needs_matching' | 'needs_review' | 'pending_approval' | 'on_hold' | 'approved' | 'rejected' | 'void';
export type Permissions = { upload: boolean; review: boolean; approve: boolean };

export type Me = {
  user: { id: string; name: string; email: string; mfaEnabled: boolean };
  organization: { id: string; name: string; isDemo: boolean; role: string; roleLabel: string } | null;
  permissions: Permissions;
  organizations: Array<{ id: string; name: string; isDemo: boolean; role: string; roleLabel: string; requiresMfa: boolean }>;
  mfaRequired: { orgId: string; orgName: string } | null;
};

export type Row = {
  id: string;
  status: AppStatus;
  statusLabel: string;
  number: number | null;
  periodTo: string | null;
  receivedAt: string;
  receivedVia: string;
  project: string | null;
  subcontractor: string | null;
  contractNumber: string | null;
  claimed: number | null;
  verified: number | null;
  approved: number | null;
  openBlocking: number;
  openWarnings: number;
  failed: boolean;
};

export type Home = {
  counts: { pendingApproval: number; needsReview: number; onHold: number; processing: number };
  unread: number;
  attention: Row[];
  attentionTotal: number;
  recentSubmissions: Row[];
  permissions: Permissions;
};

export type Detail = {
  id: string;
  version: number;
  status: AppStatus;
  statusLabel: string;
  number: number | null;
  periodTo: string | null;
  receivedAt: string;
  receivedVia: string;
  processingError: string | null;
  project: { id: string | null; name: string } | null;
  subcontractor: string | null;
  contract: { id: string; number: string; title: string } | null;
  amounts: { claimed: number | null; verified: number | null; approved: number | null; contractSumToDate: number | null; retainage: number | null; balanceToFinish: number | null };
  findings: {
    open: Array<{ id: string; severity: 'blocking' | 'warning' | 'info'; category: string; title: string; detail: string; action: string | null; needsQualifiedReview: boolean }>;
    accepted: Array<{ id: string; severity: string; title: string; note: string | null; by: string | null; at: string | null }>;
    passed: number;
  };
  documents: Array<{ id: string; filename: string; mimeType: string; size: number; pageCount: number | null; status: string }>;
  comments: Array<{ id: string; body: string; at: string; by: string }>;
  messages: Array<{ id: string; kind: string; to: string | null; subject: string; status: string; at: string }>;
  timeline: Array<{ id: string; action: string; summary: string; by: string; at: string }>;
  assignee: string | null;
  decision: { at: string; by: string | null; note: string | null } | null;
  can: { comment: boolean; requestInfo: boolean; approve: boolean };
  desktopReason: string | null;
};

export type ProjectRow = {
  id: string;
  name: string;
  number: string | null;
  city: string | null;
  state: string | null;
  status: string;
  contracts: number;
  committed: number;
  approvedToDate: number;
  inReview: number;
};

export type ProjectDetail = {
  project: { id: string; name: string; number: string | null; city: string | null; state: string | null; status: string };
  totals: { committed: number; approvedToDate: number; retainageHeld: number; balanceToFinish: number };
  contracts: Array<{
    id: string;
    number: string;
    title: string;
    status: string;
    subcontractor: string;
    contractSum: number;
    approvedToDate: number;
    retainageHeld: number;
    balanceToFinish: number;
    latestApplication: { id: string; status: AppStatus; statusLabel: string; applicationNumber: number | null } | null;
  }>;
  applications: Array<{ id: string; status: AppStatus; statusLabel: string; number: number | null; periodTo: string | null; receivedAt: string; claimed: number | null; approved: number | null; subcontractor: string | null; contractNumber: string | null }>;
};

export type ContractOption = { id: string; label: string; group: string };

export type Notification = { id: string; type: string; title: string; body: string | null; at: string; read: boolean; applicationId: string | null };

export type SignInResult =
  | { status: 'signed_in'; token: string; expiresAt: string; deviceToken: string | null; recoveryCodesLeft?: number | null }
  | { status: 'verify'; challenge: string; expiresAt: string };
