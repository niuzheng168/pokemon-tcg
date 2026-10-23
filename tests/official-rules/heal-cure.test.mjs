// Synthetic definitions only. 「回复自己的1只宝可梦「60」点HP，并恢复其全部特殊状态」: the chosen Pokémon is healed and recovers from
// every Special Condition it has (I.F); a Pokémon with only a Special Condition may be chosen. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { emptyConditions } from '../../public/rules/conditions.js';
import { fixture, binding, board, command, settle, hand } from './fixtures.mjs';

const handlers = createCoreHandlers();
const playable = (g, card) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card);

test('「回复…HP，并恢复其全部特殊状态」 heals and cures the same Pokémon', async () => {
  assert(handlers.get('cn.heal@1').validateParameters({ target: 'any', amount: 60, cureAll: true }));
  assert(!handlers.get('cn.heal@1').validateParameters({ target: 'any', amount: 60, cureAll: false }));
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.heal@1', { target: 'any', amount: 60, cureAll: true }, 'heal')];
  });
  const run = (counters, conditions) => {
    let card;
    const g = board(f, (s) => { card = hand(s, 0, 'potion'); s.players[0].active.counters = counters; Object.assign(s.players[0].active.conditions, conditions); });
    return { g, card };
  };
  let { g, card } = run(3, { rotation: 'confused', poison: 1 });
  command(g, { type: 'playTrainer', cardId: card }); settle(g);
  let active = g.snapshot().players[0].active;
  assert.equal(active.counters, 0); assert.deepEqual(active.conditions, emptyConditions());
  ({ g, card } = run(0, { burned: true }));
  assert(playable(g, card), 'Undamaged, but burned.');
  command(g, { type: 'playTrainer', cardId: card }); settle(g);
  active = g.snapshot().players[0].active;
  assert.equal(active.conditions.burned, false);
  assert(g.snapshot().events.some((e) => e.ruleId === 'status.cure' && e.data.effectId === 'fixture:heal'));
  ({ g, card } = run(0, {}));
  assert(!playable(g, card), 'Nothing to heal or cure.');
});
