// The decks the AI trains and is measured with (ai/training-decks.json): popular simplified-Chinese tournament lists
// (OmniTCG, the current season's top archetypes) and official starter decks, each with its source; plus the
// release's preset decks (decks.json). Every list is 60 printings of the reviewed release's pool (reviewed or
// machine-implemented); scripts/ai-training-decks.mjs checks that they map and are legal.
import { readFileSync } from 'node:fs';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const presets = read('../public/data/cn/V20261019/decks.json').decks
  .map(({ id, name, format, cards }) => ({ id, name, kind: 'preset', format: format.id, cards }));
const training = read('./training-decks.json').decks;

// A list is the same deck as another when it has the same printings in the same numbers.
const listKey = (cards) => cards.map(([p, n]) => `${p}×${n}`).sort().join();
const presetLists = new Set(presets.map((d) => listKey(d.cards)));
/** Every deck by id: presets first, then the training lists that are not a preset again (by id or by list). */
export const DECK_POOL = Object.freeze(Object.fromEntries([...presets, ...training.filter((d) => !presets.some((p) => p.id === d.id)
  && !presetLists.has(listKey(d.cards)))].map((d) => [d.id, Object.freeze(d)])));
/** The 60 printing ids of a deck. */
export const poolDeckList = (id) => DECK_POOL[id].cards.flatMap(([printingId, n]) => Array(n).fill(printingId));

/** Pairing number `k` for measurements over the whole pool: two decks (the same one possibly twice) by a hash of `k`. */
export function poolPair(k) {
  const ids = Object.keys(DECK_POOL), hash = (i) => {
    let x = Math.imul(k + 1, 0x9e3779b1) ^ Math.imul(i + 1, 0x85ebca77);
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    return (x ^ (x >>> 16)) >>> 0;
  };
  return [ids[hash(0) % ids.length], ids[hash(1) % ids.length]];
}
