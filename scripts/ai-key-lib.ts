/**
 * The parts of `pnpm ai:key` that need no network or terminal, kept apart so
 * they can be tested (tests/ai-key.test.ts). See scripts/set-anthropic-key.ts.
 */

export const KEY_NAME = 'ANTHROPIC_API_KEY';

/** Why this does not look like an Anthropic API key, or null when it does. Never echoes the key. */
export function keyShapeProblem(key: string): string | null {
  if (key.length === 0) return 'Nothing was pasted.';
  if (/\s/.test(key)) return 'The key contains spaces or line breaks; paste only the key.';
  if (!key.startsWith('sk-ant-')) return 'That does not look like an Anthropic API key (they start with “sk-ant-”).';
  if (key.startsWith('sk-ant-admin')) return 'That is an Admin API key, which cannot read documents. Use a regular API key.';
  if (key.length < 40) return 'That key is too short; part of it may be missing.';
  if (!/^[A-Za-z0-9_-]+$/.test(key)) return 'The key contains characters an API key never has; paste only the key.';
  return null;
}

/** Enough of the key to recognise it in the Console, and no more. */
export function maskKey(key: string): string {
  const prefix = /^sk-ant-[a-z]+\d*-/.exec(key)?.[0] ?? 'sk-ant-';
  return `${prefix}…${key.slice(-4)}`;
}

const LINE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=)(.*)$/;

/**
 * Sets NAME=value in the text of a .env file: every existing assignment of
 * NAME (with or without `export`, quoted or not) gets the new value, and if
 * there is none a line is added at the end. Everything else is left byte for
 * byte, comments included.
 */
export function upsertEnv(content: string, name: string, value: string): { content: string; action: 'replaced' | 'added' } {
  if (/[\r\n]/.test(value)) throw new Error('An environment value cannot contain a line break.');
  let found = false;
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.length === 0 ? [] : content.split(/\r?\n/);
  // A trailing newline leaves an empty last element; keep it so the file still ends with one.
  const out = lines.map((line) => {
    const m = LINE.exec(line);
    if (!m || m[2] !== name) return line;
    found = true;
    return `${m[1]}${name}${m[3]}${value}`;
  });
  if (found) return { content: out.join(eol), action: 'replaced' };
  const body = out.join(eol);
  const sep = body.length === 0 || body.endsWith(eol) ? '' : eol;
  return { content: `${body}${sep}${name}=${value}${eol}`, action: 'added' };
}

/** A .env file's assignments. The last assignment of a name wins, as in a shell. */
export function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = LINE.exec(line);
    if (!m) continue;
    let v = m[4]!.trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[2]!] = v;
  }
  return out;
}

export type KeyArgs = {
  /** Only write the local .env file. */
  localOnly: boolean;
  /** Also redeploy production so the key takes effect at once. */
  redeploy: boolean;
  /** Vercel environments to set the key in. */
  environments: Array<'production' | 'preview'>;
  project: string;
  scope: string;
  productionUrl: string;
  envFile: string;
};

export const KEY_USAGE = `Usage: pnpm ai:key [--local-only] [--redeploy] [--no-preview] [--project <name>] [--scope <team>] [--production-url <host>] [--env-file <path>]

Asks for an Anthropic API key (input hidden; or pipe it in), checks it with
Anthropic, then saves it everywhere this system reads it:
  - the local .env file (the dev server, scripts, docker compose)
  - Vercel, for Production and Preview deployments (stored as a Secret)
With --redeploy, production is rebuilt so the key takes effect now; otherwise
it takes effect on the next production deployment.`;

export function parseKeyArgs(argv: string[], env: Record<string, string | undefined> = {}): KeyArgs | string {
  const a: KeyArgs = {
    localOnly: false,
    redeploy: false,
    environments: ['production', 'preview'],
    project: env.VERCEL_PROJECT || 'construction-rcm',
    scope: env.VERCEL_SCOPE || 'arsalannkhanns-projects',
    productionUrl: env.VERCEL_PRODUCTION_URL || 'zephric.vercel.app',
    envFile: '.env',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = (): string | null => {
      const v = argv[++i];
      return v === undefined || v.startsWith('--') ? null : v;
    };
    if (arg === '--local-only') a.localOnly = true;
    else if (arg === '--redeploy') a.redeploy = true;
    else if (arg === '--no-preview') a.environments = ['production'];
    else if (arg === '--project' || arg === '--scope' || arg === '--production-url' || arg === '--env-file') {
      const v = value();
      if (!v) return `${arg} needs a value.`;
      if (arg === '--project') a.project = v;
      else if (arg === '--scope') a.scope = v;
      else if (arg === '--production-url') a.productionUrl = v.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      else a.envFile = v;
    } else if (arg === '--help' || arg === '-h') return KEY_USAGE;
    else return `Unknown option ${arg}.\n\n${KEY_USAGE}`;
  }
  if (a.localOnly && a.redeploy) return '--redeploy needs Vercel; it cannot be combined with --local-only.';
  return a;
}
