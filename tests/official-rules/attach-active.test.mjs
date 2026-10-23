// Synthetic definitions only. 「选择自己手牌中的1张能量，附着于战斗宝可梦身上」: only the user's Active Pokémon receives it.
// No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, board, command, settle, hand, bench } from './fixtures.mjs';

const toActive = { type: null, category: 'any', count: 1, benchOnly: false, optional: false, target: 'active' };

test('「…附着于战斗宝可梦身上」 attaches to the Active Pokémon only', async () => {
  const valid = (p) => createCoreHandlers().get('cn.attachHand@1').validateParameters(p);
  assert(valid(toActive)); assert(!valid({ ...toActive, benchOnly: true })); assert(!valid({ ...toActive, target: 'bench' }));
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.attachHand@1', toActive, 'attach')];
  });
  let card, energy, benched;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); energy = hand(s, 0, 'double'); benched = bench(s, 0, 'other'); });
  command(g, { type: 'playTrainer', cardId: card });
  const q = g.snapshot().pending;
  assert.equal(q.kind, 'hand-energy');
  settle(g, (r) => r.kind === 'hand-energy' ? [energy] : r.options.slice(0, r.minimum));
  const p = g.snapshot().players[0];
  assert(p.active.energy.includes(energy));
  assert.equal(p.bench.find((m) => m.id === benched.id).energy.length, 0);
});
