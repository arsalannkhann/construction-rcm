/**
 * Where a request came from. The app cannot see the network connection (Next.js
 * does not expose it to server actions), so the address comes from a header,
 * and a header is only as trustworthy as whatever sets it:
 *
 *  - RCM_CLIENT_IP_HEADER names a header the hosting platform sets itself and
 *    replaces if a client sends it (for example `cf-connecting-ip` behind
 *    Cloudflare, `fly-client-ip` on Fly.io, `x-real-ip` on Vercel). When it is
 *    set, only that header is read.
 *  - Otherwise X-Forwarded-For is read from the right. Each proxy in front of
 *    the app appends the address it received the request from, so with
 *    RCM_TRUSTED_PROXY_HOPS proxies (default 1: one load balancer or reverse
 *    proxy) the client's address is that many entries from the end. Anything
 *    further left was sent by the client and is ignored.
 *
 * With nothing in front of the app, a client can send any X-Forwarded-For it
 * likes; see docs/authentication.md ("Client addresses"). The address labels a
 * session in the device list and keys the per-address sign-in limits; nothing
 * is granted on the strength of it.
 */
type HeaderBag = { get(name: string): string | null };
type Env = Record<string, string | undefined>;

const plausibleIp = (value: string) => value.length <= 64 && /^[0-9a-fA-F:.[\]%]+$/.test(value);

export function trustedProxyHops(env: Env = process.env): number {
  const raw = env.RCM_TRUSTED_PROXY_HOPS?.trim();
  if (!raw) return 1;
  const hops = Number(raw);
  return Number.isInteger(hops) && hops >= 0 && hops <= 10 ? hops : 1;
}

export function clientIp(headers: HeaderBag, env: Env = process.env): string | null {
  const platformHeader = env.RCM_CLIENT_IP_HEADER?.trim().toLowerCase();
  if (platformHeader) {
    const value = headers.get(platformHeader)?.split(',')[0]?.trim();
    return value && plausibleIp(value) ? value : null;
  }
  const entries = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  // With no proxy in front (0 hops) Next.js itself fills the header from the connection when it is absent: the last entry.
  const fromEnd = Math.max(trustedProxyHops(env), 1);
  if (entries.length < fromEnd) return null;
  const value = entries[entries.length - fromEnd]!;
  return plausibleIp(value) ? value : null;
}

export function requestMetaFrom(headers: HeaderBag, env: Env = process.env): { userAgent: string | null; ipAddress: string | null } {
  const userAgent = headers.get('user-agent');
  return { userAgent: userAgent ? userAgent.slice(0, 400) : null, ipAddress: clientIp(headers, env) };
}
