import type { NextConfig } from 'next';

/** The sign-in cookie (src/server/auth/session.ts). */
const SESSION_COOKIE = 'rcm_session';
const LANDING_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

const config: NextConfig = {
  // These run only on the server and ship native/WASM assets or large parsers
  // that must not be bundled.
  serverExternalPackages: ['@electric-sql/pglite', 'pg', 'pdfjs-dist', 'pdf-lib', '@anthropic-ai/sdk'],
  experimental: {
    serverActions: { bodySizeLimit: '30mb' },
  },
  // SQL migrations are read from disk at boot.
  outputFileTracingIncludes: { '/**': ['./drizzle/**/*'] },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'same-origin' },
        ],
      },
      // The public website: its own files only, nothing from elsewhere, never framed.
      { source: '/landing/:path*', headers: [{ key: 'Content-Security-Policy', value: LANDING_CSP }] },
      { source: '/', missing: [{ type: 'cookie', key: SESSION_COOKIE }], headers: [{ key: 'Content-Security-Policy', value: LANDING_CSP }] },
    ];
  },
  async redirects() {
    // The overview is the dashboard; people (and old bookmarks) try this name first.
    return [{ source: '/dashboard', destination: '/overview', permanent: false }];
  },
  async rewrites() {
    return {
      // Someone who is not signed in sees the public website at the root; a member goes on to the app (src/app/page.tsx).
      beforeFiles: [{ source: '/', missing: [{ type: 'cookie', key: SESSION_COOKIE }], destination: '/landing/index.html' }],
    };
  },
};

export default config;
