import { describe, expect, it } from 'vitest';
import { keyShapeProblem, maskKey, parseEnv, parseKeyArgs, upsertEnv } from '../scripts/ai-key-lib';
import { aiConfig, DEFAULT_EXTRACTION_MODEL } from '@/server/config';

// A made-up key of the right shape. Never a real one.
const FAKE = 'sk-ant-api03-' + 'A1b2C3d4E5f6G7h8I9j0'.repeat(4) + '-xyzQ';

describe('pnpm ai:key helpers', () => {
  it('accepts a key of the right shape and explains anything else without echoing it', () => {
    expect(keyShapeProblem(FAKE)).toBeNull();
    expect(keyShapeProblem('sk-ant-usr-' + 'x'.repeat(60))).toBeNull();
    expect(keyShapeProblem('')).toMatch(/Nothing was pasted/);
    expect(keyShapeProblem(`${FAKE}\n`)).toMatch(/line breaks/);
    expect(keyShapeProblem('sk-proj-' + 'x'.repeat(60))).toMatch(/start with “sk-ant-”/);
    expect(keyShapeProblem('sk-ant-admin01-' + 'x'.repeat(60))).toMatch(/Admin API key/);
    expect(keyShapeProblem('sk-ant-api03-short')).toMatch(/too short/);
    expect(keyShapeProblem('sk-ant-api03-' + 'x'.repeat(40) + '"')).toMatch(/characters/);
    for (const bad of ['', 'sk-proj-' + 'x'.repeat(60), 'sk-ant-api03-short']) expect(keyShapeProblem(bad) ?? '').not.toContain(bad || '\u0000');
  });

  it('masks all but the type and the last four characters', () => {
    expect(maskKey(FAKE)).toBe('sk-ant-api03-…xyzQ');
    expect(maskKey('sk-ant-usr-' + 'q'.repeat(50) + 'WXYZ')).toBe('sk-ant-usr-…WXYZ');
  });

  it('replaces an existing assignment in place and keeps the rest of the file byte for byte', () => {
    const before = '# AI\nAPP_URL=http://localhost:3000\nANTHROPIC_API_KEY=\nRCM_EXTRACTION_MODEL=\n';
    const { content, action } = upsertEnv(before, 'ANTHROPIC_API_KEY', FAKE);
    expect(action).toBe('replaced');
    expect(content).toBe(`# AI\nAPP_URL=http://localhost:3000\nANTHROPIC_API_KEY=${FAKE}\nRCM_EXTRACTION_MODEL=\n`);
  });

  it('handles export, quotes, duplicates and CRLF', () => {
    const before = 'export ANTHROPIC_API_KEY="old"\r\nX=1\r\nANTHROPIC_API_KEY = old2\r\n';
    const { content } = upsertEnv(before, 'ANTHROPIC_API_KEY', FAKE);
    expect(content).toBe(`export ANTHROPIC_API_KEY=${FAKE}\r\nX=1\r\nANTHROPIC_API_KEY =${FAKE}\r\n`);
    // A commented-out line is not an assignment.
    expect(upsertEnv('# ANTHROPIC_API_KEY=old\n', 'ANTHROPIC_API_KEY', FAKE).content).toBe(`# ANTHROPIC_API_KEY=old\nANTHROPIC_API_KEY=${FAKE}\n`);
  });

  it('adds the key at the end when it is absent, with or without a trailing newline', () => {
    expect(upsertEnv('A=1\n', 'ANTHROPIC_API_KEY', FAKE)).toEqual({ content: `A=1\nANTHROPIC_API_KEY=${FAKE}\n`, action: 'added' });
    expect(upsertEnv('A=1', 'ANTHROPIC_API_KEY', FAKE).content).toBe(`A=1\nANTHROPIC_API_KEY=${FAKE}\n`);
    expect(upsertEnv('', 'ANTHROPIC_API_KEY', FAKE).content).toBe(`ANTHROPIC_API_KEY=${FAKE}\n`);
    expect(() => upsertEnv('', 'ANTHROPIC_API_KEY', 'a\nb')).toThrow(/line break/);
  });

  it('parses a .env file the way the harness needs', () => {
    const env = parseEnv('# c\nA=1\nexport B="two words"\nC=3 # note\nD=\nA=last\n');
    expect(env).toEqual({ A: 'last', B: 'two words', C: '3', D: '' });
  });

  it('parses its options, defaulting to Production and Preview on the Zephric project', () => {
    const a = parseKeyArgs([]);
    expect(a).toMatchObject({ localOnly: false, redeploy: false, environments: ['production', 'preview'], project: 'construction-rcm', productionUrl: 'zephric.vercel.app', envFile: '.env' });
    expect(parseKeyArgs(['--no-preview', '--production-url', 'https://example.com/x'])).toMatchObject({ environments: ['production'], productionUrl: 'example.com' });
    expect(parseKeyArgs(['--local-only', '--redeploy'])).toMatch(/cannot be combined/);
    expect(parseKeyArgs(['--project'])).toMatch(/needs a value/);
    expect(parseKeyArgs(['--nope'])).toMatch(/Unknown option/);
    expect(parseKeyArgs(['--help'])).toMatch(/^Usage: pnpm ai:key/);
    expect(parseKeyArgs([], { VERCEL_PROJECT: 'other', VERCEL_SCOPE: 'team' })).toMatchObject({ project: 'other', scope: 'team' });
  });
});

describe('aiConfig', () => {
  it('is off without a key, and ignores a blank one', () => {
    expect(aiConfig({})).toEqual({ configured: false });
    expect(aiConfig({ ANTHROPIC_API_KEY: '  ' })).toEqual({ configured: false });
  });
  it('uses the default model unless one is named', () => {
    expect(aiConfig({ ANTHROPIC_API_KEY: FAKE })).toEqual({ configured: true, apiKey: FAKE, model: DEFAULT_EXTRACTION_MODEL });
    expect(aiConfig({ ANTHROPIC_API_KEY: ` ${FAKE} `, RCM_EXTRACTION_MODEL: 'claude-sonnet-5-5' })).toEqual({ configured: true, apiKey: FAKE, model: 'claude-sonnet-5-5' });
  });
});
