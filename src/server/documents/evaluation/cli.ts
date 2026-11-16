/**
 * `pnpm eval:extraction` — see docs/extraction-evaluation.md.
 *
 *   --set synthetic|real|all   which corpus (default: all; each is reported on its own)
 *   --engine text|claude|auto  which reader (default: text)
 *   --json <file>              also write the full results as JSON
 *   --verbose                  list every miss and every note, per file
 *   --case <text>              only cases whose id contains <text> (the gate is skipped)
 *   --real-dir <dir>           where the real corpus lives (default: eval/real)
 *   --dump-synthetic <dir>     write the synthetic corpus to <dir> as files, to look at
 *   --no-gate                  do not apply the synthetic regression gate
 *   --concurrency <n>          read n files at once (default 1; useful with --engine claude)
 *
 * Exit codes: 0 ok · 1 the synthetic regression gate failed · 2 usage error, missing API key, or a broken truth file.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { aiConfig, type AiConfig } from '@/server/config';
import type { ExtractOptions } from '@/server/documents/extract';
import { buildSyntheticCorpus } from '@/server/samples/corpus';
import { loadCorpusDir, writeCorpusDir } from './corpus-dir';
import { renderReport, reportJson } from './report';
import { checkGate, evaluateCorpus, type CorpusResult, type EngineChoice, type GateFile } from './run';

export type CliIo = { out: (s: string) => void; err: (s: string) => void };
export type CliDeps = {
  /** Working directory the default paths are relative to. */
  root?: string;
  /** Defaults to the environment's configuration. */
  ai?: AiConfig;
  claudeClient?: ExtractOptions['claudeClient'];
  now?: Date;
};

const USAGE = 'Usage: pnpm eval:extraction [--set synthetic|real|all] [--engine text|claude|auto] [--json <file>] [--verbose] [--case <text>] [--real-dir <dir>] [--dump-synthetic <dir>] [--no-gate] [--concurrency <n>]';

type Args = { set: 'synthetic' | 'real' | 'all'; engine: EngineChoice; json: string | null; verbose: boolean; filter: string | null; realDir: string | null; dump: string | null; gate: boolean; concurrency: number };

function parseArgs(argv: string[]): Args | string {
  const a: Args = { set: 'all', engine: 'text', json: null, verbose: false, filter: null, realDir: null, dump: null, gate: true, concurrency: 1 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${arg} needs a value.`);
      return v;
    };
    try {
      if (arg === '--set') {
        const v = value();
        if (v !== 'synthetic' && v !== 'real' && v !== 'all') return `--set must be synthetic, real or all (got "${v}").`;
        a.set = v;
      } else if (arg === '--engine') {
        const v = value();
        if (v !== 'text' && v !== 'claude' && v !== 'auto') return `--engine must be text, claude or auto (got "${v}").`;
        a.engine = v;
      } else if (arg === '--json') a.json = value();
      else if (arg === '--verbose') a.verbose = true;
      else if (arg === '--case') a.filter = value();
      else if (arg === '--real-dir') a.realDir = value();
      else if (arg === '--dump-synthetic') a.dump = value();
      else if (arg === '--no-gate') a.gate = false;
      else if (arg === '--concurrency') {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 1 || n > 16) return '--concurrency must be a whole number from 1 to 16.';
        a.concurrency = n;
      }
      else if (arg === '--help' || arg === '-h') return USAGE;
      else return `Unknown option ${arg}.\n${USAGE}`;
    } catch (err) {
      return (err as Error).message;
    }
  }
  return a;
}

function commitOf(root: string): string {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return dirty ? `${sha} (with uncommitted changes)` : sha;
  } catch {
    return 'unknown';
  }
}

export async function runCli(argv: string[], io: CliIo = { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') }, deps: CliDeps = {}): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === 'string') {
    (args === USAGE ? io.out : io.err)(args);
    return args === USAGE ? 0 : 2;
  }
  const root = deps.root ?? process.cwd();
  const ai = deps.ai ?? aiConfig();
  if (args.engine === 'claude' && !ai.configured) {
    io.err(
      '--engine claude needs ANTHROPIC_API_KEY in the environment, and it is not set.\n' +
        'Nothing was evaluated. This harness never invents or simulates a model result.\n' +
        'Set the key to evaluate the Claude engine, or use --engine text for the text-layer reader.',
    );
    return 2;
  }

  const wantSynthetic = args.set !== 'real';
  const wantReal = args.set !== 'synthetic';
  const realDir = path.resolve(root, args.realDir ?? 'eval/real');
  const commit = commitOf(root);
  const now = deps.now ?? new Date();
  const run = { engine: args.engine, ai, claudeClient: deps.claudeClient, concurrency: args.concurrency };

  let synthetic: CorpusResult | undefined;
  if (wantSynthetic) {
    const cases = await buildSyntheticCorpus(args.filter ?? undefined);
    if (args.dump) {
      writeCorpusDir(path.resolve(root, args.dump), cases);
      io.err(`Wrote ${cases.length} synthetic cases to ${args.dump}.`);
    }
    synthetic = await evaluateCorpus('synthetic', cases, run);
  }

  let real: CorpusResult | undefined;
  let realSkipped: string[] = [];
  let realErrors: string[] = [];
  if (wantReal) {
    const loaded = loadCorpusDir(realDir);
    realSkipped = loaded.withoutTruth;
    realErrors = loaded.errors;
    const cases = args.filter ? loaded.cases.filter((c) => c.id.includes(args.filter!)) : loaded.cases;
    if (cases.length > 0) real = await evaluateCorpus('real', cases, run);
  }

  let gate: string[] | undefined;
  if (synthetic && args.gate && !args.filter) {
    const gateFile = path.resolve(root, 'eval/synthetic/gate.json');
    const gates: GateFile = fs.existsSync(gateFile) ? JSON.parse(fs.readFileSync(gateFile, 'utf8')) : {};
    const key = args.engine === 'claude' ? 'claude' : args.engine === 'text' || !ai.configured ? 'text-layer' : 'claude';
    if (gates[key]) gate = checkGate(synthetic, gates[key]);
  }

  const header = `Extraction evaluation · ${now.toISOString().slice(0, 10)} · commit ${commit} · engine ${args.engine}${args.filter ? ` · cases matching "${args.filter}"` : ''}`;
  io.out(renderReport({ synthetic: synthetic ? [synthetic] : [], real: real ? [real] : [], realRequested: wantReal, realDir: path.relative(root, realDir) || realDir, realSkipped, realErrors, gate, header }, { verbose: args.verbose }));

  if (args.json) {
    const json = reportJson({ synthetic: synthetic ? [synthetic] : [], real: real ? [real] : [], realRequested: wantReal, gate, meta: { date: now.toISOString(), commit, engine: args.engine, filter: args.filter } });
    fs.writeFileSync(path.resolve(root, args.json), JSON.stringify(json, null, 2) + '\n');
    io.err(`Wrote ${args.json}.`);
  }

  if (realErrors.length > 0) return 2;
  if (gate && gate.length > 0) return 1;
  return 0;
}
