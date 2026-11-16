// Renders the app icons from the brand mark (src/components/brand.tsx on the web).
// Run from mobile/: node scripts/make-icons.mjs  (uses the sharp that the web project's Next.js installs)
import { readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const store = new URL('../../node_modules/.pnpm/', import.meta.url);
const dir = readdirSync(store).find((d) => /^sharp@\d/.test(d));
if (!dir) throw new Error('sharp not found: run pnpm install in the repository root first');
const sharp = createRequire(new URL(`${dir}/node_modules/sharp/package.json`, store))('sharp');

const mark = (fill1, fill2) => `
  <defs>
    <linearGradient id="b" x2="1" y2="1"><stop stop-color="${fill1[0]}"/><stop offset="1" stop-color="${fill1[1]}"/></linearGradient>
    <linearGradient id="d" x2=".8" y2="1"><stop stop-color="${fill2[0]}"/><stop offset="1" stop-color="${fill2[1]}"/></linearGradient>
  </defs>
  <path fill="url(#b)" d="M18 8h36L38 24H5zM25 40h34L44 56H10z"/>
  <path fill="url(#d)" d="M51 8c9 0 12 10 4 17L18 55c-8 6-16-4-9-11L46 10z"/>`;

const brand = mark(['#2f6bff', '#0b47e0'], ['#00e1ca', '#0095fc']);
const white = mark(['#ffffff', '#ffffff'], ['#ffffff', '#ffffff']);

// Full icon (iOS, legacy Android): navy tile, mark at 60%, a faint ledger glow.
const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs><radialGradient id="g" cx=".3" cy=".2" r=".9"><stop stop-color="#16244a"/><stop offset="1" stop-color="#070d1a"/></radialGradient></defs>
  <rect width="1024" height="1024" fill="url(#g)"/>
  <svg x="205" y="205" width="614" height="614" viewBox="0 0 64 64">${brand}</svg>
</svg>`;

// Adaptive foreground: transparent, mark inside the 66% safe zone.
const fg = (m) => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <svg x="302" y="302" width="420" height="420" viewBox="0 0 64 64">${m}</svg>
</svg>`;

await sharp(Buffer.from(icon)).png({ compressionLevel: 9 }).toFile('assets/icon.png');
await sharp(Buffer.from(fg(brand))).png({ compressionLevel: 9 }).toFile('assets/adaptive-foreground.png');
await sharp(Buffer.from(fg(white))).png({ compressionLevel: 9 }).toFile('assets/adaptive-monochrome.png');
await sharp(Buffer.from(fg(brand))).resize(512, 512).png({ compressionLevel: 9 }).toFile('assets/splash-icon.png');
writeFileSync('assets/.generated', 'by scripts/make-icons.mjs\n');
console.log('icons written');
