import type { NextConfig } from 'next';

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
    ];
  },
  async redirects() {
    return [
      // The overview is the dashboard; people (and old bookmarks) try this name first.
      { source: '/dashboard', destination: '/overview', permanent: false },
      // The website used to be static files under /landing; it is the page at / now (src/app/(marketing)).
      { source: '/landing', destination: '/', permanent: true },
      { source: '/landing/:path*', destination: '/', permanent: true },
    ];
  },
};

export default config;
