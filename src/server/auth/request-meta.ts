/**
 * Where a request came from, as far as the headers say. Best effort: these are
 * only trustworthy when the app runs behind a proxy that sets them itself (see
 * docs/authentication.md). They label a session in the device list and key
 * the per-IP sign-in limit; nothing is granted on the strength of them.
 */
type HeaderBag = { get(name: string): string | null };

const plausibleIp = (value: string) => value.length <= 64 && /^[0-9a-fA-F:.[\]%]+$/.test(value);

/** The first hop of X-Forwarded-For, else X-Real-IP, else null. */
export function clientIp(headers: HeaderBag): string | null {
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded && plausibleIp(forwarded)) return forwarded;
  const real = headers.get('x-real-ip')?.trim();
  if (real && plausibleIp(real)) return real;
  return null;
}

export function requestMetaFrom(headers: HeaderBag): { userAgent: string | null; ipAddress: string | null } {
  const userAgent = headers.get('user-agent');
  return { userAgent: userAgent ? userAgent.slice(0, 400) : null, ipAddress: clientIp(headers) };
}
