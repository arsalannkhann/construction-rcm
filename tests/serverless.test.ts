/**
 * Serverless hosting (Vercel): nothing runs between requests, and one request
 * carries at most 4.5 MB. Covers how the queue is run there, the scheduled
 * endpoint's secret, the database pool size, and large files arriving in parts.
 */
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { connectionConfig, DatabaseSetupError, missingDatabaseUrl } from '@/db/connection';
import { documents, jobs, uploadParts } from '@/db/schema';
import { PermissionError, UserError } from '@/server/auth/permissions';
import { jobRunnerMode } from '@/server/config';
import { bearerMatches } from '@/server/http';
import { drain, enqueueJob, registerJobHandler, runnerStatus } from '@/server/jobs';
import { createApplication } from '@/server/services/intake';
import { discardStaged, filesFromForm, MAX_PARTS, PART_TTL_MS, parseStaged, readStaged, stagePart, UPLOAD_PART_BYTES } from '@/server/services/uploads';
import { addMember, createWorld, type World } from './helpers/world';

describe('how the queue is run', () => {
  it('runs on request on Vercel and polls elsewhere, unless told otherwise', () => {
    expect(jobRunnerMode({})).toBe('poll');
    expect(jobRunnerMode({ VERCEL: '1' })).toBe('request');
    expect(jobRunnerMode({ VERCEL: '1', RCM_JOB_RUNNER: 'poll' })).toBe('poll');
    expect(jobRunnerMode({ RCM_JOB_RUNNER: 'request' })).toBe('request');
    expect(jobRunnerMode({ RCM_JOB_RUNNER: 'sometimes' })).toBe('poll');
    expect(runnerStatus().mode).toBe('poll');
  });

  it('stops taking new jobs once its time budget is spent, and the next drain finishes them', async () => {
    const db = await getDb();
    const ran: number[] = [];
    registerJobHandler('budget_test', async (_db, _org, payload) => void ran.push(Number(payload.n)));
    for (let n = 0; n < 3; n++) await enqueueJob(db, 'org_budget_test', 'budget_test', { n });

    expect(await drain(db, { deadline: Date.now() - 1 })).toBe(0);
    expect(ran).toEqual([]);
    const queued = await db.select().from(jobs).where(eq(jobs.orgId, 'org_budget_test'));
    expect(queued.every((j) => j.status === 'queued' && j.attempts === 0)).toBe(true);

    expect(await drain(db, { deadline: Date.now() + 60_000 })).toBe(3);
    expect(ran.sort()).toEqual([0, 1, 2]);
  });
});

describe('the scheduled endpoint’s secret', () => {
  it('refuses to run without a configured secret and accepts only the exact bearer token', () => {
    expect(bearerMatches('Bearer anything', undefined)).toBeNull();
    expect(bearerMatches('Bearer anything', '')).toBeNull();
    expect(bearerMatches(null, 's3cret-value')).toBe(false);
    expect(bearerMatches('Bearer s3cret-valuE', 's3cret-value')).toBe(false);
    expect(bearerMatches('Bearer s3cret-value-and-more', 's3cret-value')).toBe(false);
    expect(bearerMatches('s3cret-value', 's3cret-value')).toBe(false);
    expect(bearerMatches('Bearer s3cret-value', 's3cret-value')).toBe(true);
  });
});

describe('database pool on serverless hosting', () => {
  it('keeps each instance’s pool small unless told otherwise', () => {
    expect(connectionConfig('postgres://u:p@db.example.com/app', { VERCEL: '1' }).max).toBe(3);
    expect(connectionConfig('postgres://u:p@db.example.com/app', { VERCEL: '1', DATABASE_POOL_MAX: '5' }).max).toBe(5);
    expect(connectionConfig('postgres://u:p@db.example.com/app', {}).max).toBe(10);
  });

  it('says DATABASE_URL is missing instead of reaching for a local disk it does not have', () => {
    expect(missingDatabaseUrl({ VERCEL: '1' })).toBeInstanceOf(DatabaseSetupError);
    expect(missingDatabaseUrl({ VERCEL: '1' })!.message).toMatch(/DATABASE_URL is not set/);
    expect(missingDatabaseUrl({ VERCEL: '1', DATABASE_URL: 'postgres://u:p@h/db' })).toBeNull();
    expect(missingDatabaseUrl({})).toBeNull(); // local evaluation keeps the embedded database
  });
});

describe('large files in parts', () => {
  let w: World;
  const id = (s: string) => `upl_${s}_${'x'.repeat(16)}`;
  const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill);

  beforeAll(async () => {
    w = await createWorld();
  });

  it('joins the parts in order, checks they add up, and deletes them when told', async () => {
    const u = id('join');
    // Sent out of order, as parallel or retried requests can arrive.
    await stagePart(w.db, w.pm, u, 1, bytes(10, 2));
    await stagePart(w.db, w.pm, u, 0, bytes(UPLOAD_PART_BYTES, 1));
    const [file] = await readStaged(w.db, w.pm, [{ uploadId: u, name: 'scan.pdf', type: 'application/pdf', size: UPLOAD_PART_BYTES + 10 }]);
    expect(file!.bytes.byteLength).toBe(UPLOAD_PART_BYTES + 10);
    expect(file!.bytes[0]).toBe(1);
    expect(file!.bytes[UPLOAD_PART_BYTES]).toBe(2);
    expect(file).toMatchObject({ filename: 'scan.pdf', mimeType: 'application/pdf' });

    await discardStaged(w.db, w.pm, [u]);
    expect(await w.db.select().from(uploadParts).where(eq(uploadParts.uploadId, u))).toHaveLength(0);
  });

  it('replaces a part that is sent twice, so a retried request is harmless', async () => {
    const u = id('retry');
    await stagePart(w.db, w.pm, u, 0, bytes(5, 7));
    await stagePart(w.db, w.pm, u, 0, bytes(5, 8));
    const [file] = await readStaged(w.db, w.pm, [{ uploadId: u, name: 'a.pdf', type: '', size: 5 }]);
    expect([...file!.bytes]).toEqual([8, 8, 8, 8, 8]);
    expect(file!.mimeType).toBeNull();
  });

  it('refuses a file with a missing part or the wrong total size', async () => {
    const gap = id('gap');
    await stagePart(w.db, w.pm, gap, 0, bytes(4, 1));
    await stagePart(w.db, w.pm, gap, 2, bytes(4, 1));
    await expect(readStaged(w.db, w.pm, [{ uploadId: gap, name: 'gap.pdf', type: '', size: 8 }])).rejects.toThrow(/did not arrive completely/);
    await expect(readStaged(w.db, w.pm, [{ uploadId: gap, name: 'gap.pdf', type: '', size: 12 }])).rejects.toThrow(/did not arrive completely/);

    const short = id('short');
    await stagePart(w.db, w.pm, short, 0, bytes(4, 1));
    await expect(readStaged(w.db, w.pm, [{ uploadId: short, name: 'short.pdf', type: '', size: 5 }])).rejects.toThrow(UserError);
    await expect(readStaged(w.db, w.pm, [{ uploadId: id('never'), name: 'none.pdf', type: '', size: 5 }])).rejects.toThrow(UserError);
  });

  it('keeps each member’s parts to that member, in that organisation', async () => {
    const u = id('mine');
    await stagePart(w.db, w.pm, u, 0, bytes(6, 3));
    const file = [{ uploadId: u, name: 'mine.pdf', type: '', size: 6 }];
    // A colleague in the same organisation cannot claim or add to them.
    await expect(readStaged(w.db, w.accountant, file)).rejects.toThrow(/did not arrive completely/);
    await stagePart(w.db, w.accountant, u, 1, bytes(6, 9));
    expect((await readStaged(w.db, w.pm, file))[0]!.bytes.byteLength).toBe(6);
    // Nor can someone in another organisation who learns the id.
    const other = await createWorld();
    await expect(readStaged(other.db, other.owner, file)).rejects.toThrow(/did not arrive completely/);
    await discardStaged(other.db, other.owner, [u]);
    expect((await readStaged(w.db, w.pm, file))[0]!.bytes.byteLength).toBe(6);
    // The same person signed in to a different organisation does not carry them over.
    const elsewhere = { ...w.pm, orgId: other.orgId, orgName: 'Elsewhere' };
    await expect(readStaged(w.db, elsewhere, file)).rejects.toThrow(/did not arrive completely/);
  });

  it('refuses parts from people who cannot upload, and parts that are malformed', async () => {
    await expect(stagePart(w.db, w.viewer, id('viewer'), 0, bytes(3, 1))).rejects.toThrow(PermissionError);
    await expect(readStaged(w.db, w.viewer, [])).rejects.toThrow(PermissionError);
    await expect(stagePart(w.db, w.pm, 'short', 0, bytes(3, 1))).rejects.toThrow(UserError);
    await expect(stagePart(w.db, w.pm, '../../etc/passwd/xxxxxxxxxx', 0, bytes(3, 1))).rejects.toThrow(UserError);
    await expect(stagePart(w.db, w.pm, id('range'), -1, bytes(3, 1))).rejects.toThrow(UserError);
    await expect(stagePart(w.db, w.pm, id('range'), MAX_PARTS, bytes(3, 1))).rejects.toThrow(UserError);
    await expect(stagePart(w.db, w.pm, id('range'), 0.5, bytes(3, 1))).rejects.toThrow(UserError);
    await expect(stagePart(w.db, w.pm, id('empty'), 0, bytes(0, 1))).rejects.toThrow(UserError);
    await expect(stagePart(w.db, w.pm, id('big'), 0, bytes(UPLOAD_PART_BYTES + 1, 1))).rejects.toThrow(UserError);
  });

  it('deletes parts nobody claimed after a few hours', async () => {
    const stale = id('stale');
    const long_ago = new Date(Date.now() - PART_TTL_MS - 60_000);
    await stagePart(w.db, w.pm, stale, 0, bytes(3, 1), long_ago);
    await stagePart(w.db, w.accountant, id('fresh'), 0, bytes(3, 1));
    expect(await w.db.select().from(uploadParts).where(eq(uploadParts.uploadId, stale))).toHaveLength(0);
  });

  it('reads the staged entries of a form strictly', () => {
    const ok = { uploadId: id('form'), name: 'pay app.pdf', type: 'application/pdf', size: 10 };
    expect(parseStaged([JSON.stringify(ok)])).toEqual([ok]);
    expect(parseStaged([JSON.stringify({ ...ok, type: undefined })])[0]!.type).toBe('');
    for (const bad of ['not json', JSON.stringify({ ...ok, uploadId: 'x' }), JSON.stringify({ ...ok, size: 0 }), JSON.stringify({ ...ok, size: 26 * 1024 * 1024 }), JSON.stringify({ ...ok, name: '' })]) {
      expect(() => parseStaged([bad])).toThrow(UserError);
    }
    expect(() => parseStaged([JSON.stringify(ok), JSON.stringify(ok)])).toThrow(UserError);
    expect(() => parseStaged([new File(['x'], 'x.txt')])).toThrow(UserError);
  });

  it('creates an application from a mix of whole and staged files, then deletes the parts', async () => {
    const u = id('mixed');
    const big = new Uint8Array(UPLOAD_PART_BYTES + 100).fill(0x41);
    await stagePart(w.db, w.pm, u, 0, big.subarray(0, UPLOAD_PART_BYTES));
    await stagePart(w.db, w.pm, u, 1, big.subarray(UPLOAD_PART_BYTES));
    const form = new FormData();
    form.append('files', new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'small.pdf', { type: 'application/pdf' }));
    form.append('staged', JSON.stringify({ uploadId: u, name: 'large scan.pdf', type: 'application/pdf', size: big.byteLength }));

    const { files, done } = await filesFromForm(w.db, w.pm, form);
    expect(files.map((f) => [f.filename, f.bytes.byteLength])).toEqual([
      ['small.pdf', 4],
      ['large scan.pdf', big.byteLength],
    ]);
    const { id: appId } = await createApplication(w.db, w.pm, { files, contractId: w.contractId, defer: true });
    await done();
    const docs = await w.db.select().from(documents).where(eq(documents.payApplicationId, appId));
    expect(docs.map((d) => [d.filename, d.size]).sort()).toEqual([
      ['large scan.pdf', big.byteLength],
      ['small.pdf', 4],
    ]);
    expect(await w.db.select().from(uploadParts).where(eq(uploadParts.uploadId, u))).toHaveLength(0);
  });

  it('lets a member in one organisation stage while another member stages the same id', async () => {
    const u = id('shared');
    const pm2 = await addMember(w.db, w.orgId, w.owner.orgName, 'project_manager', 'Second Manager');
    await stagePart(w.db, w.pm, u, 0, bytes(2, 1));
    await stagePart(w.db, pm2, u, 0, bytes(3, 2));
    expect((await readStaged(w.db, w.pm, [{ uploadId: u, name: 'a.pdf', type: '', size: 2 }]))[0]!.bytes[0]).toBe(1);
    expect((await readStaged(w.db, pm2, [{ uploadId: u, name: 'a.pdf', type: '', size: 3 }]))[0]!.bytes[0]).toBe(2);
  });
});
