// Synthetic definitions only. 「如果场上有「祭典会场」的话，则这只宝可梦，可以连续使用2次拥有的招式。（如果第1次的招式令对手的战斗宝可梦【昏厥】的话，
// 则在下一只对手的宝可梦被放于战斗场后，继续使用第2次招式。）」 (attack.twice). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, board, command, answer, settle, hand, bench } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const festival = { kind: 'stadiumInPlay', owner: 'any', selector: { kind: 'trainer', nameKeys: ['stadium'] } };
const water = (s, owner) => {
  const p = s.players[owner], i = p.deck.findIndex((id) => s.cards[id].definitionId === 'water');
  p.active.energy.push(p.deck.splice(i, 1)[0]);
};
const stadium = (s) => { const id = hand(s, 0, 'stadium'); s.players[0].hand.pop(); s.stadium = id; };

test('schema', () => {
  const valid = (effect) => createCoreHandlers().get('cn.attackTwice@1').validateParameters({ effect });
  assert(valid({ op: 'attackTwice', scope: 'self', condition: festival }));
  assert(valid({ op: 'attackTwice', scope: 'self' }));
  assert(!valid({ op: 'attackTwice', scope: 'own' }));
});

test('a second attack after the first, by choice, and only while the Stadium is in play', async () => {
  const f = await fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.weakness = null;
    def(defs, 'base').mechanics.effects.push(binding('cn.attackTwice@1', { effect: { op: 'attackTwice', scope: 'self', condition: festival } }, 'festival'));
    def(defs, 'stadium').mechanics.effects = [];
  });
  for (const choice of ['base:strike', 'skip']) {
    const g = board(f, (s) => { water(s, 0); stadium(s); });
    command(g, { type: 'attack', attackId: 'base:strike' });
    const q = g.snapshot().pending;
    assert.equal(q.kind, 'second-attack'); assert.deepEqual(q.options, ['base:strike', 'skip']);
    assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
    answer(g, [choice]); settle(g);
    const s = g.snapshot();
    assert.equal(s.players[1].active.counters, choice === 'skip' ? 2 : 4);
    assert.equal(s.current, 1, 'The turn ends after the second attack (no third).');
    assert.equal(s.events.filter((e) => e.ruleId === 'attack.twice').length, choice === 'skip' ? 0 : 1);
  }
  const g = board(f, (s) => { water(s, 0); });
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  assert.equal(g.snapshot().current, 1, 'No Stadium: one attack.');
});

test('after a Knock Out, the second attack waits for the new Active Pokémon; without the Energy it cannot be declared', async () => {
  const f = await fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.weakness = null;
    def(defs, 'base').mechanics.effects.push(binding('cn.attackTwice@1', { effect: { op: 'attackTwice', scope: 'self' } }, 'twice'));
    def(defs, 'base').mechanics.attacks.push({ ...def(defs, 'base').mechanics.attacks[0], attackId: 'base:spend', name: '测试耗能',
      effects: [binding('cn.attachedEnergy@1', { op: 'discardEnergy', side: 'own', from: 'self', selector: { kind: 'energy' }, providedTypes: null,
        measure: 'cards', quantity: { kind: 'all' }, chooser: 'source' }, 'spend')] });
  });
  let other;
  const g = board(f, (s) => { water(s, 0); s.players[1].active.counters = 9; other = bench(s, 1, 'other'); });
  command(g, { type: 'attack', attackId: 'base:strike' });
  settle(g, (q) => q.kind === 'second-attack' ? ['base:strike'] : q.options.slice(0, Math.max(1, q.minimum)));
  const s = g.snapshot();
  assert.equal(s.players[1].active.id, other.id);
  assert.equal(s.players[1].active.counters, 2, 'The second attack hit the new Active Pokémon.');
  const h = board(f, (s) => { water(s, 0); });
  command(h, { type: 'attack', attackId: 'base:spend' }); settle(h);
  assert.equal(h.snapshot().current, 1, 'No Energy left: no second attack to declare.');
});
