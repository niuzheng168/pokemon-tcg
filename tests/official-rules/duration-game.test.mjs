// Synthetic definitions only. 「在这场对战结束前，自己的所有宝可梦使用的招式，给对手的战斗宝可梦造成的伤害「+30」」 and
// 「在这场对战结束前，自己的所有【钢】宝可梦，受到对手宝可梦的全部招式的伤害「-30」」 (effects.duration.game). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { createPlayerOngoingEffect, assertPlayerOngoingEffect, ongoingIsActive, expireOngoing } from '../../public/rules/ongoing.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, board, command, settle, EVIDENCE } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const boost = { op: 'modifier', field: 'attackDamage', amount: 30, scope: 'own' };
const water = (s, owner) => {
  const p = s.players[owner], i = p.deck.findIndex((id) => s.cards[id].definitionId === 'water');
  p.active.energy.push(p.deck.splice(i, 1)[0]);
};
const strike = (g) => { command(g, { type: 'attack', attackId: 'base:strike' }); settle(g); };

test('schema and clock: only player effects last for the game', () => {
  assert(requireRule(CN_V20261019, 'effects.duration.game').sourceOfTruth.length > 1);
  const handlers = createCoreHandlers();
  assert(handlers.get('cn.lastingPlayer@1').validateParameters({ side: 'own', effect: boost, duration: 'game' }));
  assert(!handlers.get('cn.lasting@1').validateParameters({ side: 'own', target: 'self', effect: { op: 'modifier', field: 'defenseDamage', amount: -30, scope: 'self' },
    duration: 'game', clearOnBench: true, clearOnEvolution: true }));
  const source = { instanceId: 'c1', owner: 0, cardOwner: 0, category: 'attack', pokemonId: 'p1', attackId: 'base:strike', effectId: 'e',
    sourceOfTruth: EVIDENCE, origin: 'field' };
  const state = { current: 0, phase: 'main', players: [{ turns: 3 }, { turns: 3 }] };
  const entry = createPlayerOngoingEffect({ id: 'e1', player: 0, source, effect: boost, duration: 'game' }, state);
  assert.deepEqual([entry.deadline.boundary, entry.ruleId], ['game', 'effects.duration.game']);
  assert(ongoingIsActive(entry, { ...state, current: 1, players: [{ turns: 40 }, { turns: 40 }] }));
  assert.equal(expireOngoing([entry], state, 0, 'checkup-end').length, 1);
  for (const bad of [{ ...entry, duration: 'thisTurn' }, { ...entry, ruleId: 'effects.duration.this-turn' },
    { ...entry, deadline: { ...entry.deadline, player: 1 } }, { ...entry, duration: 'game', deadline: { ...entry.deadline, boundary: 'turn-end' } }])
    assert.throws(() => assertPlayerOngoingEffect(clone(bad), state), TypeError);
});

test('「在这场对战结束前」: still +30 several turns later', async () => {
  const f = await fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.weakness = null;
    def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.lastingPlayer@1', { side: 'own', effect: boost, duration: 'game' }, 'forever')];
  });
  const g = board(f, (s) => { water(s, 0); water(s, 1); });
  strike(g);
  assert.equal(g.snapshot().players[1].active.counters, 2, 'The bonus starts after this attack\'s damage.');
  const before = g.snapshot().players[0].active.counters;
  strike(g);
  assert.equal(g.snapshot().players[0].active.counters - before, 2, 'The opponent\'s attacks are not boosted.');
  for (let i = 0; i < 2; i++) { command(g, { type: 'endTurn' }); settle(g); command(g, { type: 'endTurn' }); settle(g); }
  const at = g.snapshot().players[1].active.counters;
  strike(g);
  assert.equal(g.snapshot().players[1].active.counters - at, 5, '20 + 30, and the effect stays.');
  assert.deepEqual(OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog }).snapshot(), g.snapshot());
});
