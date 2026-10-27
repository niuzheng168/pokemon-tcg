// An arena log by deck: how often player A won with each deck (A plays the first deck of a pairing: the first deck named
// in an even game, the second in an odd one, where the seats are swapped), with a 95% interval, most games first; and
// how often B won with it. With --swap-decks both pilot every deck against the same opponents and deals, so A's rate
// minus B's is what A's way of playing gains with that deck.
//   node scripts/ai-arena-decks.mjs <arena log> [--min 20]
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { min: { type: 'string', default: '20' } } });
const byDeck = new Map();
for (const line of readFileSync(positionals[0], 'utf8').split('\n')) {
  const m = line.match(/^game\s+(\d+): (A|B|-) .*, (\S+) vs (\S+)$/);
  if (!m) continue;
  const g = Number(m[1]), [deck, other] = g % 2 === 0 ? [m[3], m[4]] : [m[4], m[3]];
  const e = byDeck.get(deck) ?? { a: 0, b: 0, n: 0, bn: 0, bw: 0, bl: 0 }, o = byDeck.get(other) ?? { a: 0, b: 0, n: 0, bn: 0, bw: 0, bl: 0 };
  e.n++; if (m[2] === 'A') e.a++; else if (m[2] === 'B') e.b++;
  o.bn++; if (m[2] === 'B') o.bw++; else if (m[2] === 'A') o.bl++;
  byDeck.set(deck, e); byDeck.set(other, o);
}
const wilson = (k, n) => {
  if (!n) return [0, 1];
  const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), w = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - w) / d, (c + w) / d];
};
for (const [deck, e] of [...byDeck].sort((x, y) => y[1].n - x[1].n)) {
  if (e.n < Number(values.min)) continue;
  const [lo, hi] = wilson(e.a, e.a + e.b), aRate = 100 * e.a / Math.max(1, e.a + e.b), bRate = 100 * e.bw / Math.max(1, e.bw + e.bl);
  console.log(`${deck.padEnd(30)} ${String(e.n).padStart(4)} games  A ${aRate.toFixed(1)}%  (${(100 * lo).toFixed(0)}–${(100 * hi).toFixed(0)}%)` +
    `  B ${bRate.toFixed(1)}% (${e.bn})  A−B ${(aRate - bRate).toFixed(1)}`);
}
