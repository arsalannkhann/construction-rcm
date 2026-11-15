/**
 * Environment-derived configuration. Everything optional degrades to an honest
 * "not configured" state rather than a pretend success.
 */
import path from 'node:path';

export function dataDir(): string {
  return process.env.RCM_DATA_DIR || path.join(process.cwd(), '.data');
}

export function isInMemory(): boolean {
  return process.env.RCM_DATA_DIR === ':memory:';
}

export function appUrl(): string {
  return (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

export type AiConfig = { configured: true; apiKey: string; model: string } | { configured: false };

export function aiConfig(): AiConfig {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { configured: false };
  return { configured: true, apiKey, model: process.env.RCM_EXTRACTION_MODEL || 'claude-opus-5-5' };
}

export type ProcoreEnv = 'production' | 'sandbox';
export type ProcoreConfig =
  | { configured: true; clientId: string; clientSecret: string; env: ProcoreEnv; loginBase: string; apiBase: string }
  | { configured: false };

export function procoreConfig(): ProcoreConfig {
  const clientId = process.env.PROCORE_CLIENT_ID;
  const clientSecret = process.env.PROCORE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return { configured: false };
  const env: ProcoreEnv = process.env.PROCORE_ENV === 'production' ? 'production' : 'sandbox';
  // Overridable so tests can point the client at a local emulator.
  const loginBase =
    process.env.PROCORE_LOGIN_BASE || (env === 'production' ? 'https://login.procore.com' : 'https://login-sandbox.procore.com');
  const apiBase =
    process.env.PROCORE_API_BASE || (env === 'production' ? 'https://api.procore.com' : 'https://sandbox.procore.com');
  return { configured: true, clientId, clientSecret, env, loginBase, apiBase };
}

export type EmailConfig = { configured: true; apiKey: string; from: string } | { configured: false };

export function emailConfig(): EmailConfig {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) return { configured: false };
  return { configured: true, apiKey, from };
}

export function inboundEmailSecret(): string | null {
  return process.env.INBOUND_EMAIL_SECRET || null;
}
