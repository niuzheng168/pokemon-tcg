// Synthetic definitions only. Shape follows printed CN text: 念力土偶 「力量平分 选择自己弃牌区中的【超】能量，以任意方式附着于自己的宝可梦身上，直到
// 自己场上宝可梦身上附有的能量数量，与对手场上宝可梦身上附有的能量数量相同为止。」 (effects.count-value; JP Q&A ネンドール「パワーシェア」), with a
// Basic 【火】 Energy standing in for 【超】. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, board, command, settle, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const units = (side) => ({ kind: 'pokemonSum', side, zone: 'field', field: 'energyUnits' });
const share = { effect: { handlerId: 'cn.attachDiscard@1', parameters: { type: 'Fire', count: 1, benchOnly: false, optional: false, exact: true } },
  count: { kind: 'subtract', left: units('opponent'), right: units('own') } };
const field = (g) => { const p = g.snapshot().players[0]; return [p.active, ...p.bench].reduce((n, m) => n + m.energy.length, 0); };
const discard = (s, owner, id, n) => {
  const p = s.players[owner];
  for (let i = 0; i < n; i++) p.discard.push(p.deck.splice(p.deck.findIndex((c) => s.cards[c].definitionId === id), 1)[0]);
};

test('effects.count-value: an attach leaf written for one may be exact (「N张」 without 「最多」, II.D-04)', () => {
  const v = createCoreHandlers().get('cn.countValue@1').validateParameters;
  assert(v(share));
  assert(!v({ ...share, effect: { ...share.effect, parameters: { ...share.effect.parameters, count: 2 } } }), 'Written for one.');
  assert(v({ ...share, effect: { ...share.effect, parameters: { type: 'Fire', count: 1, benchOnly: false, optional: false } } }));
});

test('「…直到自己场上宝可梦身上附有的能量数量，与对手场上宝可梦身上附有的能量数量相同为止」: exactly the difference in Energy units, or all there are', async () => {
  const f = await fixture((defs) => {
    const a = def(defs, 'base').mechanics.attacks[0];
    a.cost = []; a.printedDamage = null; a.effects = [binding('cn.countValue@1', share, 'share')];
  });
  f.deck.splice(20, 6, ...Array(6).fill('printing:fire'));
  f.deck.splice(30, 1, 'printing:double');
  const play = (fire, mine = 0) => {
    const g = board(f, (s) => {
      const me = s.players[0].active, foe = s.players[1].active;
      attached(s, 1, foe, 'water'); attached(s, 1, foe, 'water'); attached(s, 1, foe, 'double'); // 4 Energy (JP Q&A: 「ツインエネルギー」 counts 2)
      for (let i = 0; i < mine; i++) attached(s, 0, me, 'water');
      discard(s, 0, 'fire', fire);
    });
    command(g, { type: 'attack', attackId: 'base:strike' });
    return g;
  };
  // 2 against 4: exactly 2 cards are chosen.
  const g = play(3, 2);
  const q = g.snapshot().pending;
  assert.deepEqual([q.minimum, q.maximum], [2, 2]);
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  settle(g);
  assert.equal(field(g), 4);
  // Only 1 such card in the discard pile: that one.
  const one = play(1, 2);
  assert.deepEqual([one.snapshot().pending.minimum, one.snapshot().pending.maximum], [1, 1]);
  settle(one);
  assert.equal(field(one), 3);
  // Already as many: nothing to attach.
  const none = play(3, 4);
  assert.equal(none.snapshot().pending, null);
  assert.equal(field(none), 4);
});
