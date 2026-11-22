/**
 * "My uploads": everything this person has sent, or is still sending, in one
 * list they can search. Drafts still on the phone and applications the server
 * has are merged, newest first, and each is titled with the name the person
 * gave it, so "Concrete" is found as "Concrete" whatever Zephric matched it to.
 *
 * Pure functions, so the rules are tested without a phone (tests/mobile-uploads.test.ts).
 */
import { date, money } from './format';

/*
 * The parts of a server row (api.ts `Row`) and a draft (drafts.ts `Draft`)
 * this needs, written out so the file imports nothing that only runs on a
 * phone: the server's tests check these rules too.
 */
type Row = {
  id: string;
  title?: string | null;
  description?: string | null;
  tags?: string[];
  /** The amount the sender typed, in cents. */
  stated?: number | null;
  status: string;
  statusLabel: string;
  number: number | null;
  periodTo: string | null;
  receivedAt: string;
  project: string | null;
  subcontractor: string | null;
  contractNumber: string | null;
  claimed: number | null;
  verified: number | null;
  approved: number | null;
  openBlocking: number;
  failed: boolean;
};
type Draft = {
  id: string;
  title: string;
  description?: string;
  tags?: string[];
  amountCents?: number | null;
  contract: { label: string; group: string } | null;
  files: Array<{ name: string }>;
  status: 'draft' | 'queued' | 'sending' | 'submitted' | 'failed';
  error: string | null;
  applicationId: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
};

export type UploadTone = 'progress' | 'ok' | 'problem' | 'neutral';

export type UploadItem = {
  key: string;
  /** Where tapping it goes: the draft on this phone, or the application on the server. */
  target: { kind: 'draft'; id: string } | { kind: 'application'; id: string };
  title: string;
  /** Company, project and number, as far as they are known. */
  detail: string | null;
  at: string;
  status: string;
  /** One or two words for the rubber stamp on the bill slip: "Received", "Approved", "Problem". */
  stamp: string;
  tone: UploadTone;
  /** The sender's own amount when they typed one, otherwise Zephric's figure. */
  amount: string | null;
  /** True when `amount` is the one the sender typed. */
  amountTyped: boolean;
  description: string | null;
  tags: string[];
  /** Everything a search may match, lower-cased. */
  haystack: string;
};

export type Said = { status: string; stamp: string; tone: UploadTone };

function draftStatus(d: Draft): Said {
  switch (d.status) {
    case 'sending':
      return { status: 'Sending…', stamp: 'Sending', tone: 'progress' };
    case 'queued':
      return { status: d.error ? 'Waiting for internet to send' : 'Waiting to send', stamp: 'Waiting', tone: 'progress' };
    case 'failed':
      return { status: 'Not sent – tap to try again', stamp: 'Not sent', tone: 'problem' };
    default:
      return { status: 'Not sent yet – tap to finish', stamp: 'Not sent', tone: 'neutral' };
  }
}

/** The server's status, in plain words for someone who does not know the billing process. */
/** A server row's status in plain words, with its stamp word and tone. */
export function rowStatus(r: Row): Said {
  if (r.failed) return { status: 'Could not be read – someone will check it', stamp: 'Unreadable', tone: 'problem' };
  switch (r.status) {
    case 'processing':
      return { status: 'Received – being read', stamp: 'Received', tone: 'progress' };
    case 'needs_matching':
    case 'needs_review':
      return r.openBlocking > 0
        ? { status: `Received – ${r.openBlocking === 1 ? '1 problem' : `${r.openBlocking} problems`} found`, stamp: 'Problem', tone: 'problem' }
        : { status: 'Received – being checked', stamp: 'Checking', tone: 'ok' };
    case 'pending_approval':
      return { status: 'Checked – waiting for approval', stamp: 'Checked', tone: 'ok' };
    case 'on_hold':
      return { status: 'On hold – waiting for the subcontractor', stamp: 'On hold', tone: 'problem' };
    case 'approved':
      return { status: 'Approved', stamp: 'Approved', tone: 'ok' };
    case 'rejected':
      return { status: 'Rejected', stamp: 'Rejected', tone: 'problem' };
    case 'void':
      return { status: 'Cancelled', stamp: 'Cancelled', tone: 'neutral' };
    default:
      return { status: r.statusLabel, stamp: r.statusLabel, tone: 'neutral' };
  }
}

/** The stamp for a bare status, where only the status is known (a project's bill list). */
export function statusStamp(status: string, statusLabel: string): Said {
  return rowStatus({ id: '', status, statusLabel, number: null, periodTo: null, receivedAt: '', project: null, subcontractor: null, contractNumber: null, claimed: null, verified: null, approved: null, openBlocking: 0, failed: false });
}

const join = (parts: Array<string | null | undefined>, sep = ' · ') => parts.filter((x): x is string => !!x && x.trim().length > 0).join(sep) || null;

/** An amount as it may be searched: "$12,400.00", "12400.00" and "12400". */
function amountWords(cents: number | null): string[] {
  if (cents === null) return [];
  const m = money(cents);
  const plain = m.replace(/[$,−]/g, '');
  return [m, plain, plain.replace(/\.00$/, '')];
}

function haystack(parts: Array<string | number | null | undefined>): string {
  return parts
    .filter((x) => x !== null && x !== undefined && String(x).trim() !== '')
    .map((x) => String(x))
    .join(' \n ')
    .toLowerCase();
}

export function buildUploads(drafts: Draft[], rows: Row[]): UploadItem[] {
  const onServer = new Set(rows.map((r) => r.id));
  const items: UploadItem[] = [];

  for (const d of drafts) {
    // Sent drafts are shown by the server's row, which knows more; until the list refreshes, the draft stands in.
    if (d.status === 'submitted' && d.applicationId && onServer.has(d.applicationId)) continue;
    if (d.status !== 'submitted' && d.files.length === 0) continue; // an empty draft someone opened and left
    const sent = d.status === 'submitted';
    const { status, stamp, tone } = sent ? { status: 'Received – being read', stamp: 'Received', tone: 'progress' as const } : draftStatus(d);
    const title = d.title.trim() || (d.contract ? d.contract.label.split(' · ')[0] : 'Untitled upload');
    const at = d.submittedAt ?? d.updatedAt ?? d.createdAt;
    const typed = d.amountCents ?? null;
    const tags = d.tags ?? [];
    const description = d.description?.trim() || null;
    items.push({
      key: `draft:${d.id}`,
      target: sent && d.applicationId ? { kind: 'application', id: d.applicationId } : { kind: 'draft', id: d.id },
      title,
      detail: join([d.contract?.label, d.contract?.group]),
      at,
      status,
      stamp,
      tone,
      amount: typed !== null ? money(typed) : null,
      amountTyped: typed !== null,
      description,
      tags,
      haystack: haystack([title, description, ...tags, ...amountWords(typed), d.contract?.label, d.contract?.group, date(at), status, ...d.files.map((f) => f.name)]),
    });
  }

  for (const r of rows) {
    const { status, stamp, tone } = rowStatus(r);
    const typed = r.stated ?? null;
    const cents = typed ?? r.approved ?? r.verified ?? r.claimed;
    const tags = r.tags ?? [];
    const description = r.description?.trim() || null;
    const title = r.title?.trim() || r.subcontractor || 'Upload';
    const number = r.number !== null ? `#${r.number}` : null;
    items.push({
      key: `app:${r.id}`,
      target: { kind: 'application', id: r.id },
      title,
      detail: join([r.title?.trim() ? r.subcontractor : null, r.project, number]),
      at: r.receivedAt,
      status,
      stamp,
      tone,
      amount: cents !== null ? money(cents) : null,
      amountTyped: typed !== null,
      description,
      tags,
      haystack: haystack([
        title,
        description,
        ...tags,
        ...amountWords(cents),
        ...(typed !== null ? amountWords(r.approved ?? r.verified ?? r.claimed) : []),
        r.subcontractor,
        r.project,
        r.contractNumber,
        number,
        r.number,
        date(r.receivedAt),
        r.periodTo ? date(r.periodTo) : null,
        status,
      ]),
    });
  }

  return items.sort((a, b) => +new Date(b.at) - +new Date(a.at));
}

/**
 * Every word typed must appear somewhere in the item, in any order:
 * "concrete nov" finds the Concrete upload from November. Commas and dollar
 * signs in amounts are ignored, so "12400" finds "$12,400.00".
 */
export function searchUploads(items: UploadItem[], query: string): UploadItem[] {
  const words = query
    .toLowerCase()
    .replace(/[$,]/g, '')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return items;
  return items.filter((i) => words.every((w) => i.haystack.includes(w)));
}

export type Period = 'week' | 'month';

/** The tags on these uploads, most used first, for the one-tap filter row. */
export function tagCounts(items: UploadItem[]): Array<{ tag: string; count: number }> {
  const counts = new Map<string, { tag: string; count: number }>();
  for (const i of items) {
    for (const tag of i.tags) {
      const key = tag.toLowerCase();
      const hit = counts.get(key);
      if (hit) hit.count += 1;
      else counts.set(key, { tag, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * Narrow the list the way a person thinks about it: typed words, one tag,
 * and "this week" or "this month" (the last 7 or 30 days, so Monday morning
 * still shows last Friday's receipt).
 */
export function filterUploads(items: UploadItem[], f: { query?: string; tag?: string | null; period?: Period | null; now?: number }): UploadItem[] {
  const now = f.now ?? Date.now();
  const since = f.period === 'week' ? now - 7 * 86_400_000 : f.period === 'month' ? now - 30 * 86_400_000 : null;
  const tag = f.tag?.toLowerCase() ?? null;
  return searchUploads(items, f.query ?? '').filter(
    (i) => (tag === null || i.tags.some((t) => t.toLowerCase() === tag)) && (since === null || +new Date(i.at) >= since),
  );
}
