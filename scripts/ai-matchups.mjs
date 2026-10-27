// Deck against deck, from an arena log where both players are the same AI (scripts/ai-arena.mjs … --decks=…): each
// row deck's win rate against each column deck, with the games played, and the cycles of three (A beats B, B beats C,
// C beats A) the table shows, the clearest first.
//   node scripts/ai-matchups.mjs <arena log> [--min 0.55]
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { min: { type: 'string', default: '0.55' } } });
const wins = new Map(), games = new Map(), decks = new Set();
const add = (m, a, b, x) => m.set(`${a}|${b}`, (m.get(`${a}|${b}`) ?? 0) + x);
for (const line of readFileSync(positionals[0], 'utf8').split('\n')) {
  // game 12: A (ordinary, 136 steps) A 0.0s B 0.0s, first vs second — A sits first in even games.
  const m = line.match(/^game\s+(\d+): ([AB-]) .*, (\S+) vs (\S+)$/);
  if (!m) continue;
  const [, g, winner, first, second] = m;
  decks.add(first); decks.add(second);
  const firstWon = winner === '-' ? 0.5 : Number((winner === 'A') === (Number(g) % 2 === 0));
  add(wins, first, second, firstWon); add(wins, second, first, 1 - firstWon);
  add(games, first, second, 1); add(games, second, first, 1);
}
const ids = [...decks].sort(), rate = (a, b) => (games.get(`${a}|${b}`) ? wins.get(`${a}|${b}`) / games.get(`${a}|${b}`) : null);
const short = (id) => id.replace(/-\d{6}$/, '').slice(0, 10);
console.log(`${''.padEnd(12)}${ids.map((b) => short(b).padStart(11)).join('')}   overall`);
for (const a of ids) {
  const all = ids.filter((b) => b !== a && games.get(`${a}|${b}`));
  const overall = all.reduce((s, b) => s + wins.get(`${a}|${b}`), 0) / all.reduce((s, b) => s + games.get(`${a}|${b}`), 0);
  console.log(`${short(a).padEnd(12)}${ids.map((b) => (a === b || rate(a, b) === null ? '' : `${(100 * rate(a, b)).toFixed(0)}%`).padStart(11)).join('')}   ${(100 * overall).toFixed(1)}%`);
}
// Cycles: each edge at least `min`; the weakest edge decides the order.
const min = Number(values.min), cycles = [];
for (const a of ids) for (const b of ids) for (const c of ids) {
  if (!(a < b && a < c) || b === c) continue;
  const edges = [rate(a, b), rate(b, c), rate(c, a)];
  if (edges.every((x) => x !== null && x >= min)) cycles.push({ cycle: [a, b, c], weakest: Math.min(...edges), edges });
}
cycles.sort((x, y) => y.weakest - x.weakest);
console.log(`\ncycles (every edge ≥ ${min}, n per pairing ≈ ${Math.round([...games.values()].reduce((s, x) => s + x, 0) / games.size)}):`);
for (const c of cycles.slice(0, 10)) console.log(`${c.cycle.map(short).join(' > ')} > ${short(c.cycle[0])}  ${c.edges.map((x) => `${(100 * x).toFixed(0)}%`).join(' / ')}`);
