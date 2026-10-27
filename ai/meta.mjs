// Guessing an opponent's unseen cards from the metagame: ai/meta-decks.json (recent tournament top lists,
// scripts/ai-meta-decks.mjs) and the opponent's public cards. Each list is weighed by how likely it would have shown
// those cards (drawing them from its 60: the product over names of C(copies in the list, copies shown), and a small
// factor for every shown copy the list does not have), one list is drawn by weight, and its cards not shown yet are the
// guess. This is knowing the metagame, as a player does, not knowing the opponent's list: the AI never reads that
// (docs/ai/STATUS.md, user decision 2026-10-27), and an arena leaves the opponent's own list out with `exclude`.
import { readFileSync } from 'node:fs';
import { randomIndex } from '../public/rules/random.js';
import { guessCards } from './worlds.mjs';

let meta = null;
const load = () => (meta ??= JSON.parse(readFileSync(new URL('./meta-decks.json', import.meta.url), 'utf8')));
/** Every printing the metagame lists use (a catalog for meta guesses must have them). */
export const metaPrintings = () => load().printings;
/** A list as a key: the same printings in the same numbers are the same list (as ai/decks.mjs compares them). */
export const listKey = (cards) => cards.map(([p, n]) => `${p}×${n}`).sort().join();

// How much less likely a list becomes for each shown copy it does not have (a tech card, another variant).
const MISS = Math.log(0.02);
const logChoose = (n, k) => { let s = 0; for (let i = 0; i < k; i++) s += Math.log((n - i) / (i + 1)); return s; };

/**
 * guess(shown, count, rng): `count` card identities ({ printingId, definitionId }) for the opponent's unseen cards, from
 * their public cards `shown` (identities). `catalog` must have every metagame printing (metaPrintings). `exclude`: list
 * keys left out of the metagame. With no list left, or nothing shown, it guesses as worlds.mjs does without one.
 */
export function metaGuesser(catalog, { exclude = [] } = {}) {
  const m = load(), skip = new Set(exclude), nameOf = (definitionId) => catalog.definition(definitionId).nameKey;
  const lists = m.decks.map((d) => d.cards.map(([i, n]) => [m.printings[i], n])).filter((cards) => !skip.has(listKey(cards))).map((cards) => {
    // Per name: how many copies, and one identity per copy.
    const byName = new Map();
    for (const [printingId, n] of cards) {
      const identity = { printingId, definitionId: catalog.definitionFor(printingId).definitionId }, name = nameOf(identity.definitionId);
      const e = byName.get(name) ?? { count: 0, copies: [] };
      e.count += n; for (let i = 0; i < n; i++) e.copies.push(identity);
      byName.set(name, e);
    }
    return byName;
  });
  return (shown, count, rng) => {
    if (!count) return [];
    if (!lists.length || !shown.length) return guessCards(catalog, shown, count, rng);
    const seen = new Map();
    for (const c of shown) { const name = nameOf(c.definitionId); seen.set(name, (seen.get(name) ?? 0) + 1); }
    const logs = lists.map((list) => {
      let s = 0;
      for (const [name, k] of seen) { const n = list.get(name)?.count ?? 0; s += k <= n ? logChoose(n, k) : logChoose(n, n) + (k - n) * MISS; }
      return s;
    });
    const top = Math.max(...logs), weights = logs.map((l) => Math.exp(l - top)), total = weights.reduce((a, b) => a + b, 0);
    let ticket = (randomIndex(rng, 1 << 30) / (1 << 30)) * total, pick = 0;
    while (pick < lists.length - 1 && (ticket -= weights[pick]) >= 0) pick++;
    // The drawn list's copies not shown yet, in a random order; those beyond `count` (the list's room taken by shown
    // cards it does not have) are left out, and if it has too few the rest is guessed from what was shown.
    const rest = [];
    for (const [name, e] of lists[pick]) rest.push(...e.copies.slice(Math.min(e.count, seen.get(name) ?? 0)));
    for (let i = rest.length - 1; i > 0; i--) { const j = randomIndex(rng, i + 1); [rest[i], rest[j]] = [rest[j], rest[i]]; }
    const out = rest.slice(0, count);
    return out.length < count ? [...out, ...guessCards(catalog, shown, count - out.length, rng)] : out;
  };
}
