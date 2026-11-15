/** Name normalisation and similarity used to match what documents say to our records. */

const STOP = new Set([
  'inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'co', 'corp', 'corporation', 'company', 'the', 'and', 'of',
  'dba', 'pllc', 'pc',
]);

export function normaliseName(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t))
    .join(' ');
}

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  const padded = ` ${s} `;
  for (let i = 0; i < padded.length - 1; i++) {
    const g = padded.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** 0..1 similarity: the better of token overlap and character-bigram Dice. */
export function similarity(a: string | null | undefined, b: string | null | undefined): number {
  const x = normaliseName(a);
  const y = normaliseName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;

  const tx = new Set(x.split(' '));
  const ty = new Set(y.split(' '));
  let shared = 0;
  for (const t of tx) if (ty.has(t)) shared++;
  const tokenScore = (2 * shared) / (tx.size + ty.size);

  const bx = bigrams(x);
  const by = bigrams(y);
  let overlap = 0;
  let total = 0;
  for (const [gram, n] of bx) {
    overlap += Math.min(n, by.get(gram) ?? 0);
    total += n;
  }
  for (const n of by.values()) total += n;
  const dice = (2 * overlap) / total;

  return Math.max(tokenScore, dice);
}

export function normaliseItemNo(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[\s._-]+/g, '')
    .replace(/^0+(?=\d)/, '');
}
