// Real reviewed CN cards on hand-built boards. Board surgery only rearranges the
// real physical cards of a started reviewed game; the engine re-validates on restore.
import { readFile } from 'node:fs/promises';
import { OfficialGame, createReviewedGame } from '../../public/rules/engine.js';
import { TRUSTED_RELEASES } from '../../public/cn/trusted-releases.js';
import { randomIndex } from '../../public/rules/random.js';
import { deckList, OPEN_FORMAT, RULESET, DEFINITIONS } from '../../catalog/zh-CN/V20261019/index.mjs';
import { answer, settle, command, hand, bench, attached, fixtureClock } from '../official-rules/fixtures.mjs';

export { answer, settle, command, hand, bench, attached, fixtureClock };
export const json = await readFile(new URL('../../public/data/cn/V20261019/release.json', import.meta.url), 'utf8');
export const DECK = deckList('csvh1c-pikachu');
export const BOLT = deckList('raging-bolt-679141');
export const DRAGAPULT = deckList('dragapult-676815');
export const STANDARD_FORMAT = Object.freeze({ ...RULESET, id: 'standard' });

export async function reviewed(seed = [7, 8, 9, 10], decks = [DECK, DECK], format = OPEN_FORMAT) {
  const { game, catalog, approval } = await createReviewedGame({ json, trustedReleases: TRUSTED_RELEASES,
    decks, seed, format, matchMode: 'normal' });
  // These boards rearrange the reviewed decks. A machine definition of the same name is not the physical card
  // in those decks, so do not let the expanded release overwrite this fixture's reviewed name → definition map.
  const id = Object.fromEntries(DEFINITIONS.map((d) => [d.nameKey, d.definitionId]));
  return { game, catalog, approval, id };
}

export const restore = (game, catalog) => OfficialGame.restore(JSON.parse(JSON.stringify(game.snapshot())), { catalog });

/** Both Actives fixed, everything else back in hand, turn 5 for player 0 (main phase). */
export function board(ctx, actives, mutate = () => {}) {
  settle(ctx.game);
  const s = ctx.game.snapshot();
  for (const [owner, p] of s.players.entries()) {
    for (const m of [p.active, ...p.bench].filter(Boolean)) p.hand.push(...m.stack, ...m.energy, ...m.tools);
    p.active = null; p.bench = [];
    p.active = bench(s, owner, ctx.id[actives[owner]]); p.bench.pop();
    // Park the rest of the hand under the deck so discard piles start empty.
    p.deck.unshift(...p.hand.splice(0));
  }
  fixtureClock(s); s.phase = 'main';
  mutate(s, helpers(ctx, s));
  return OfficialGame.restore(s, { catalog: ctx.catalog });
}

export function helpers(ctx, s) {
  const take = (owner, key) => { const card = hand(s, owner, ctx.id[key]); s.players[owner].hand.pop(); return card; };
  return {
    s,
    hand: (owner, ...keys) => keys.map((key) => hand(s, owner, ctx.id[key])),
    bench: (owner, key) => bench(s, owner, ctx.id[key]),
    energy: (owner, mon, count = 1) => Array.from({ length: count }, () => attached(s, owner, mon, ctx.id['basic-lightning-energy'])),
    attach: (owner, mon, ...keys) => keys.map((key) => attached(s, owner, mon, ctx.id[key])),
    evolve: (owner, mon, key) => { mon.stack.push(take(owner, key)); return mon; },
    tool: (owner, mon, key) => { mon.tools.push(take(owner, key)); return mon; },
    discard: (owner, key, count = 1) => Array.from({ length: count }, () => { const card = take(owner, key); s.players[owner].discard.push(card); return card; }),
    top: (owner, key) => { const card = take(owner, key); s.players[owner].deck.push(card); return card; },
    coin: (result) => forceCoin(s, result),
  };
}

// Pick an RNG state whose next flip is the requested face (test setup only).
export function forceCoin(s, result) {
  for (let k = 1; ; k++) {
    const rng = [k, k * 7 + 1, k * 13 + 2, k * 31 + 3];
    if (randomIndex([...rng], 2) === (result === 'heads' ? 0 : 1)) { s.rng = rng; return; }
  }
}

export const play = (game, cardId) => command(game, { type: 'playTrainer', cardId }, 0);
export const attack = (game, attackId) => command(game, { type: 'attack', attackId });
export const playable = (game, cardId) => game.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === cardId);
export const events = (game, ruleId, from = 0) => game.snapshot().events.slice(from).filter((e) => e.ruleId === ruleId);
