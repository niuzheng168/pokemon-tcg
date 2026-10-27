// Hidden information for a search. The AI may use only what its player could know: its own hand, every card in play,
// both discard piles and lost zones, the Stadium and face-up Prize cards. Before a search plays a position it deals
// everything else again — its own deck and face-down Prize cards in a new order, the opponent's hand, deck and Prize
// cards guessed from the opponent's public cards (never their decklist), and a new random state — so no move can
// depend on a hidden card, a deck order or a coin flip still to come.
import { randomIndex } from '../public/rules/random.js';
import { playerView } from '../public/rules/engine.js';

const mons = (p) => [p.active, ...p.bench].filter(Boolean);
const shuffle = (rng, list) => {
  for (let i = list.length - 1; i > 0; i--) { const j = randomIndex(rng, i + 1); [list[i], list[j]] = [list[j], list[i]]; }
  return list;
};
/** A fresh random state from the search's own generator. */
export const randomState = (rng) => {
  const words = [0, 0, 0, 0].map(() => randomIndex(rng, 0x100000000));
  return words.every((w) => w === 0) ? [1, 0, 0, 0] : words;
};

/** The cards of `owner` that `viewer` sees face up: in play, discard, lost zone, resolving, the Stadium, face-up Prizes. */
export function publicCards(s, owner) {
  const p = s.players[owner];
  return [...mons(p).flatMap((m) => [...m.stack, ...m.energy, ...m.tools]), ...p.discard, ...p.lost, ...p.resolving,
    ...(p.faceUpPrizes ?? []), ...(s.stadium && s.cards[s.stadium].owner === owner ? [s.stadium] : [])];
}

/** The cards whose identity the viewer's own view shows (hand, play, discard, a request's cards, logged reveals). An id
 * mentioned without its card (a card drawn by the opponent, say) is not known. */
export function knownIds(view) {
  const ids = new Set();
  (function walk(v) {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (typeof v.instanceId === 'string' && typeof v.definitionId === 'string') ids.add(v.instanceId);
      Object.values(v).forEach(walk);
    }
  })(view);
  return ids;
}

/** The ids of `owner` whose identity the viewer does not know: deck, face-down Prizes and (the opponent's) hand, minus shown ones. */
export function hiddenIds(s, owner, viewer, known) {
  const p = s.players[owner], up = new Set(p.faceUpPrizes ?? []);
  return [...(owner === viewer ? [] : p.hand), ...p.deck, ...p.prizes.filter((id) => !up.has(id))].filter((id) => !known.has(id));
}

/**
 * Guess `count` cards for the opponent from their public cards alone: more copies of what they have shown, up to each
 * name's deck limit, more likely the more often it was seen; when every name is at its limit, more of their Basic
 * Energy (or, with none shown, of anything shown).
 */
export function guessCards(catalog, shown, count, rng) {
  if (!count) return [];
  if (!shown.length) throw new RangeError('Nothing of the opponent is public yet; there is nothing to guess from.');
  const byName = new Map();
  for (const c of shown) {
    const d = catalog.definition(c.definitionId), entry = byName.get(d.nameKey) ?? { cards: [], limit: d.deckLimits.sameName ?? Infinity };
    entry.cards.push(c); byName.set(d.nameKey, entry);
  }
  const room = new Map([...byName].map(([name, e]) => [name, e.limit - e.cards.length]));
  const out = [];
  while (out.length < count) {
    const open = [...byName].filter(([name]) => room.get(name) > 0);
    if (!open.length) break;
    let ticket = randomIndex(rng, open.reduce((n, [, e]) => n + e.cards.length, 0));
    const [name, entry] = open.find(([, e]) => (ticket -= e.cards.length) < 0);
    out.push(entry.cards[randomIndex(rng, entry.cards.length)]);
    room.set(name, room.get(name) - 1);
  }
  const energy = shown.filter((c) => { const d = catalog.definition(c.definitionId); return d.kind === 'energy' && d.mechanics.category === 'basic'; });
  const filler = energy.length ? energy : shown;
  while (out.length < count) out.push(filler[randomIndex(rng, filler.length)]);
  return out;
}

/**
 * One possible world for `viewer`: a copy of the snapshot in which both decks are in an order nobody knows, every card
 * identity the viewer has not seen is dealt again, and the random state is new. The result is a snapshot for
 * `new Simulation(world, catalog)`.
 *
 * The opponent's unseen cards are guessed by `guesser(shown, count, rng)` (meta.mjs: from the metagame's lists), or
 * without one from their public cards alone (guessCards). `opponent: 'oracle'` is a measurement only (docs/ai/STATUS.md),
 * never a player: the opponent's unseen cards are their real ones, dealt again like the viewer's own, as if the
 * opponent's list were known. It tells how much a better guess could gain; no difficulty level or service may use it.
 */
export function sampleWorld(snapshot, catalog, viewer, rng, { opponent: guess = 'guess', guesser = null } = {}) {
  const s = structuredClone(snapshot), opponent = 1 - viewer;
  const known = knownIds(playerView(snapshot, catalog, viewer));
  const identity = (id) => ({ printingId: s.cards[id].printingId, definitionId: s.cards[id].definitionId });
  const assign = (ids, cards) => ids.forEach((id, i) => Object.assign(s.cards[id], cards[i]));
  for (const p of s.players) shuffle(rng, p.deck);
  // Own deck and face-down Prizes: the same cards (the viewer knows its own list), dealt again. They are put in a
  // fixed order first, so the deal does not depend on where they really are.
  const own = hiddenIds(s, viewer, viewer, known), byPrinting = (a, b) => a.printingId < b.printingId ? -1 : a.printingId > b.printingId ? 1 : 0;
  assign(own, shuffle(rng, own.map(identity).sort(byPrinting)));
  // The opponent's unseen cards: guessed only from what they have shown (and the metagame).
  const theirs = hiddenIds(s, opponent, viewer, known), shown = publicCards(s, opponent).map(identity);
  assign(theirs, guess === 'oracle' ? shuffle(rng, theirs.map(identity).sort(byPrinting))
    : (guesser ?? ((...a) => guessCards(catalog, ...a)))(shown, theirs.length, rng));
  s.rng = randomState(rng);
  return s;
}
