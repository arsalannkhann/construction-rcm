// Copies pdf.js into /public so the in-browser document viewer can load it
// from our own origin at runtime (no CDN, no bundler involvement, works offline).
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

try {
  const build = join(dirname(require.resolve('pdfjs-dist/package.json')), 'build');
  mkdirSync(join('public', 'pdfjs'), { recursive: true });
  for (const file of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
    const src = join(build, file);
    if (!existsSync(src)) throw new Error(`${file} not found in ${build}`);
    copyFileSync(src, join('public', 'pdfjs', file));
  }
  console.log('[postinstall] copied pdf.js to public/pdfjs');
} catch (err) {
  // Not fatal for the server; the document viewer will report the problem.
  console.warn('[postinstall] could not copy pdf.js:', err.message);
}
