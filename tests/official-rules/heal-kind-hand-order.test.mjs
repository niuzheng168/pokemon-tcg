// Synthetic definitions only. 「双方玩家，在自己的回合有1次机会，可回复自己1只【草】宝可梦「60」点HP，并恢复所有特殊状态。」 (a heal of one
// Pokémon of a printed kind, cureAll) and 「抛掷2次硬币。如果出现正面的话，则查看对手的手牌，选择其中与出现正面次数相同数量的卡牌，
// 将选择的卡牌以任意顺序重新排列后，放回对手的牌库下方。」 (effects.opponent-hand, several cards to the deck bottom in the user's order).
// No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();
const GRASS = { kind: 'pokemon', types: ['Grass'] };
const forest = (extra = {}) => ({ target: 'any', amount: 60, cureAll: true, targetSelector: GRASS, ...extra });
const playable = (g, card) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card);

test('schemas: a heal\'s printed kind is a choice among Pokémon; a deck-bottom move of the opponent\'s hand may be several cards', () => {
  const heal = (p) => handlers.get('cn.heal@1').validateParameters(clone(p));
  assert(heal(forest()) && heal(forest({ target: 'bench', cureAll: undefined })));
  for (const bad of [forest({ target: 'self' }), forest({ target: 'attacker' }), forest({ targetSelector: { kind: 'trainer' } })])
    assert(!heal(bad), JSON.stringify(bad));
  const hand = (p) => handlers.get('cn.opponentHand@1').validateParameters(clone(p));
  const bottom = (quantity) => ({ mode: 'look', selector: { kind: 'any' }, quantity, to: 'deckBottom' });
  assert(hand(bottom({ kind: 'exact', count: 2 })) && hand(bottom({ kind: 'upTo', count: 3 })));
  assert(!hand(bottom({ kind: 'all' })) && !hand(bottom({ kind: 'leave', count: 2 })));
  assert(requireRule(CN_V20261019, 'effects.opponent-hand').summary.includes('任意顺序'));
});

test('「回复自己1只【草】宝可梦「60」点HP，并恢复所有特殊状态」: only a Grass Pokémon, damaged or affected by a Special Condition', async () => {
  const f = await fixture((defs) => {
    def(defs, 'other').mechanics.types = ['Grass'];
    def(defs, 'potion').mechanics.effects = [binding('cn.heal@1', forest(), 'forest')];
  });
  let card, grass, poisoned;
  const g = board(f, (s) => {
    card = hand(s, 0, 'potion'); s.players[0].active.counters = 5;
    grass = bench(s, 0, 'other'); grass.counters = 8; bench(s, 0, 'other'); bench(s, 0, 'base').counters = 2;
  });
  assert(!playable(board(f, (s) => { card = hand(s, 0, 'potion'); s.players[0].active.counters = 5; bench(s, 0, 'other'); }), card),
    'Only the Water Pokémon is damaged.');
  command(g, { type: 'playTrainer', cardId: card });
  const q = g.snapshot().pending;
  assert.deepEqual([q.kind, q.options], ['effect-target', [grass.id]]);
  restore(g, f);
  answer(g, [grass.id]); settle(g);
  assert.deepEqual(g.snapshot().players[0].bench.map((m) => m.counters), [2, 0, 2]);
  // A Grass Active not damaged, but Poisoned: it may be chosen, and it recovers.
  const h = board(f, (s) => {
    const p = s.players[0]; card = hand(s, 0, 'potion'); poisoned = bench(s, 0, 'other'); p.bench = [p.active]; p.active = poisoned;
    poisoned.conditions.poison = 1;
  });
  assert(playable(h, card));
  command(h, { type: 'playTrainer', cardId: card }); settle(h);
  assert.deepEqual([h.snapshot().players[0].active.id, h.snapshot().players[0].active.conditions.poison], [poisoned.id, null]);
});

test('「与出现正面次数相同数量的卡牌…以任意顺序…放回对手的牌库下方」: the user orders them, the first chosen uppermost', async () => {
  const flips = { kind: 'fixed', count: 2 };
  const f = await fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.hp = 500;
    Object.assign(defs[0].mechanics.attacks[0], { printedDamage: null, effects: [binding('cn.coins@1', { flips, face: 'heads', apply: { kind: 'scale' },
      effect: { handlerId: 'cn.opponentHand@1', parameters: { mode: 'look', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 1 }, to: 'deckBottom' } } },
    'snatch')] });
  });
  const seen = new Set();
  for (let n = 1; n <= 12 && seen.size < 3; n++) {
    let theirs;
    const g = board({ ...f, seed: [n, n + 1, n + 2, n + 3] }, (s) => {
      attached(s, 0, s.players[0].active, 'water');
      const p = s.players[1]; p.deck.push(...p.hand); p.hand = [];
      theirs = ['research', 'potion', 'water'].map((id) => hand(s, 1, id));
    });
    command(g, { type: 'attack', attackId: 'base:strike' });
    const heads = g.snapshot().events.findLast((e) => e.ruleId === 'effects.coin' && e.data.effectId === 'fixture:snatch').data.receipt.heads;
    seen.add(heads);
    const q = g.snapshot().pending;
    if (heads === 0) {
      assert.equal(q, null, 'No heads: no look.');
      assert(!g.snapshot().events.some((e) => e.ruleId === 'effects.opponent-hand'));
      continue;
    }
    assert.deepEqual([q.kind, q.minimum, q.maximum, [...q.options].sort()], [heads === 2 ? 'order-cards' : 'select-cards', heads, heads, [...theirs].sort()]);
    restore(g, f);
    const order = heads === 2 ? [theirs[2], theirs[0]] : [theirs[1]];
    answer(g, order); settle(g);
    const deck = g.snapshot().players[1].deck;
    assert.deepEqual(deck.slice(0, heads), [...order].reverse(), 'The last chosen lowest.');
    restore(g, f);
  }
  assert.equal(seen.size, 3, 'No, one and two heads all occur among these seeds.');
});
