/**
 * `pnpm ai:key`: paste an Anthropic API key once and it is configured
 * everywhere this system reads it.
 *
 *   pnpm ai:key                  ask for the key (hidden), check it, save it locally and on Vercel
 *   pnpm ai:key --redeploy       ...and rebuild production so it takes effect now
 *   pnpm ai:key --local-only     only the local .env file
 *   pbpaste | pnpm ai:key        read the key from standard input instead of asking
 *
 * Where the key goes:
 *   .env                 read by the dev server, `pnpm eval:extraction` and docker compose
 *   Vercel (Secret)      Production and Preview deployments (--no-preview for Production only)
 *
 * The key is never printed, never put on a command line (the Vercel CLI gets
 * it on standard input), and is checked with Anthropic before anything is
 * written. See docs/operations.md, "AI reading".
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_EXTRACTION_MODEL } from '../src/server/config';
import { KEY_NAME, keyShapeProblem, maskKey, parseEnv, parseKeyArgs, upsertEnv, type KeyArgs } from './ai-key-lib';

/** The Vercel CLI to use when none is installed: pinned, so the flags below keep their meaning. */
const VERCEL_CLI = 'vercel@65.16.0';

const say = (s = '') => process.stderr.write(s + '\n');

async function readHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(question);
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk: string) => {
      // Terminals that bracket pastes wrap them in these markers.
      for (const ch of chunk.replace(/\u001b\[20[01]~/g, '')) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stderr.write('\n');
          resolve(value.trim());
          return;
        }
        if (ch === '\u0003' || ch === '\u0004') {
          cleanup();
          process.stderr.write('\n');
          reject(new Error('Cancelled.'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.resume();
  });
}

async function readKey(): Promise<string> {
  if (!process.stdin.isTTY) {
    let all = '';
    for await (const chunk of process.stdin) all += chunk;
    return all.trim();
  }
  return readHidden('Paste the Anthropic API key and press Enter (nothing is shown): ');
}

/** Checks the key with Anthropic: it is accepted, it may use the model, and the account can be billed. */
async function verifyKey(key: string, model: string): Promise<string | null> {
  const client = new Anthropic({ apiKey: key, authToken: null, maxRetries: 2, timeout: 60_000 });
  try {
    await client.models.retrieve(model);
    // A tiny real request: the only way to know the account has credit.
    await client.messages.create({
      model,
      max_tokens: 256,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
    });
    return null;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return 'Anthropic rejected the key. Check that it was copied whole and has not been revoked.';
    if (err instanceof Anthropic.PermissionDeniedError) return `This key is not allowed to use ${model}.`;
    if (err instanceof Anthropic.NotFoundError) return `The model ${model} was not found for this key. Check RCM_EXTRACTION_MODEL.`;
    if (err instanceof Anthropic.RateLimitError) return 'Anthropic is rate-limiting this key right now. Try again in a minute.';
    // Usually "credit balance is too low"; the API's own words say which.
    if (err instanceof Anthropic.BadRequestError) return `Anthropic refused a test request: ${err.message}`;
    if (err instanceof Anthropic.APIConnectionError) return 'Could not reach api.anthropic.com. Check the network and try again.';
    if (err instanceof Anthropic.APIError) return `Anthropic returned an error (HTTP ${err.status ?? 'unknown'}).`;
    throw err;
  }
}

function saveLocal(file: string, key: string): void {
  const exists = fs.existsSync(file);
  const before = exists ? fs.readFileSync(file, 'utf8') : '';
  const { content, action } = upsertEnv(before, KEY_NAME, key);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  say(`  ✓ ${path.basename(file)}: ${action === 'replaced' ? 'replaced the existing key' : 'added the key'} (file readable only by you)`);
}

function vercelCommand(): { cmd: string; prefix: string[] } {
  const found = spawnSync('vercel', ['--version'], { stdio: 'ignore' });
  if (found.status === 0) return { cmd: 'vercel', prefix: [] };
  return { cmd: 'npx', prefix: ['--yes', VERCEL_CLI] };
}

function run(cmd: string, args: string[], input?: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'] });
    if (input !== undefined) {
      child.stdin!.write(input);
      child.stdin!.end();
    }
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(127));
  });
}

async function saveVercel(a: KeyArgs, key: string): Promise<boolean> {
  const { cmd, prefix } = vercelCommand();
  const scope = ['--scope', a.scope];
  if ((await run(cmd, [...prefix, 'whoami', ...scope])) !== 0) {
    say('  ✗ Not signed in to Vercel. Run `npx vercel login`, then run `pnpm ai:key` again.');
    return false;
  }
  const code = await run(
    cmd,
    [...prefix, 'env', 'add', KEY_NAME, '--environment', a.environments.join(','), '--force', '--sensitive', '--yes', '--project', a.project, ...scope],
    key,
  );
  if (code !== 0) {
    say(`  ✗ Vercel did not save the key (exit code ${code}). Nothing else was changed there.`);
    return false;
  }
  say(`  ✓ Vercel (${a.project}): saved as a Secret for ${a.environments.join(' and ')}`);
  return true;
}

async function redeploy(a: KeyArgs): Promise<boolean> {
  const { cmd, prefix } = vercelCommand();
  say(`\nRebuilding production (${a.productionUrl}) so it picks up the key…`);
  const code = await run(cmd, [...prefix, 'redeploy', a.productionUrl, '--environment', 'production', '--scope', a.scope]);
  if (code !== 0) {
    say(`  ✗ The redeploy did not finish (exit code ${code}). The key is saved; it takes effect on the next production deployment.`);
    return false;
  }
  try {
    const res = await fetch(`https://${a.productionUrl}/api/health`, { headers: { 'cache-control': 'no-cache' } });
    const body = (await res.json()) as { ai?: { configured: boolean; model: string | null } };
    if (!body.ai) say('  · Production is rebuilt. This version does not report AI status on /api/health.');
    else if (body.ai.configured) say(`  ✓ Production reads documents with AI (${body.ai.model}).`);
    else say('  ✗ Production is rebuilt but still reports AI as not configured. Check the variable in Vercel.');
  } catch {
    say('  · Production is rebuilt; /api/health could not be checked.');
  }
  return true;
}

async function main(): Promise<number> {
  const a = parseKeyArgs(process.argv.slice(2), process.env);
  if (typeof a === 'string') {
    const help = a.startsWith('Usage:');
    (help ? process.stdout : process.stderr).write(a + '\n');
    return help ? 0 : 2;
  }
  const envFile = path.resolve(process.cwd(), a.envFile);
  const local = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {};
  const model = process.env.RCM_EXTRACTION_MODEL?.trim() || local.RCM_EXTRACTION_MODEL?.trim() || DEFAULT_EXTRACTION_MODEL;

  const key = await readKey();
  const problem = keyShapeProblem(key);
  if (problem) {
    say(`✗ ${problem} Nothing was changed.`);
    return 2;
  }
  say(`Checking ${maskKey(key)} with Anthropic (model ${model})…`);
  const rejected = await verifyKey(key, model);
  if (rejected) {
    say(`✗ ${rejected} Nothing was changed.`);
    return 1;
  }
  say('  ✓ Key accepted, model available, test request billed');

  say('\nSaving:');
  saveLocal(envFile, key);
  let ok = true;
  if (!a.localOnly) ok = await saveVercel(a, key);
  if (ok && a.redeploy) ok = await redeploy(a);
  else if (ok && !a.localOnly) say(`  · Vercel uses it from the next production deployment (a merge to main), or run \`pnpm ai:key --redeploy\`.`);

  say('\nRestart a running dev server to pick up the new key.');
  return ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    say(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
