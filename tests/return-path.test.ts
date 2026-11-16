/**
 * The page to return to after signing in: only a page on this site, so the
 * sign-in link cannot be used to send someone to another one.
 */
import { describe, expect, it } from 'vitest';
import { loginPath, safeReturnPath } from '@/lib/return-path';

describe('the page to return to after signing in', () => {
  it('keeps a page on this site, with its query', () => {
    expect(safeReturnPath('/applications/app_123')).toBe('/applications/app_123');
    expect(safeReturnPath('/applications?status=needs_review')).toBe('/applications?status=needs_review');
    expect(loginPath('/transfers')).toBe('/login?next=%2Ftransfers');
  });

  it('refuses anything that could lead to another site', () => {
    for (const bad of ['https://evil.example/', '//evil.example/x', '/\\evil.example', 'evil.example', 'javascript:alert(1)', '/a\\b', '/x\ny', ' /overview']) {
      expect(safeReturnPath(bad), bad).toBeNull();
    }
  });

  it('skips the home page, the sign-in pages, the API and the public website', () => {
    for (const skip of ['/', '/login', '/login?next=%2Fx', '/login/verify', '/signup', '/invite/abc', '/reset-password', '/forgot-password', '/api/health', '/landing/index.html', '/_next/static/x.js']) {
      expect(safeReturnPath(skip), skip).toBeNull();
    }
    // A page whose name only starts like one of them is a page.
    expect(safeReturnPath('/logins-report')).toBe('/logins-report');
  });

  it('ignores a missing or overlong value', () => {
    expect(safeReturnPath(null)).toBeNull();
    expect(safeReturnPath(undefined)).toBeNull();
    expect(safeReturnPath('')).toBeNull();
    expect(safeReturnPath(`/${'a'.repeat(600)}`)).toBeNull();
    expect(loginPath(null)).toBe('/login');
    expect(loginPath('https://evil.example')).toBe('/login');
  });
});
