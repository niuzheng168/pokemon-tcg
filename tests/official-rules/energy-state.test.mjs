// Synthetic definitions only. 「身上附有（【X】／特殊）能量的宝可梦」 as an in-play state: at least one attached Energy card matching
// the printed kind, or currently providing the printed type (II.D-08 FAQ). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { assertBattleValue } from '../../public/rules/battle-value.js';
import { matchesPokemonState } from '../../public/rules/in-play-selection.js';
import { fixture, binding, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();
const water = { energy: { providedTypes: ['Water'] } }, special = { energy: { selector: { kind: 'energy', category: 'special' } } };
const count = (state) => ({ kind: 'pokemonCount', side: 'own', zone: 'field', state });
function putStadium(s, owner) { const id = hand(s, owner, 'stadium'); s.players[owner].hand.pop(); s.stadium = id; }

test('schema and validators: an Energy filter as a state', () => {
  for (const state of [water, special, { damaged: true, energy: { selector: { kind: 'energy' }, providedTypes: ['Fire'] } }]) {
    assert(handlers.get('cn.drawValue@1').validateParameters({ count: count(state) }), JSON.stringify(state));
    assert.doesNotThrow(() => assertBattleValue(clone(count(state))));
  }
  for (const state of [{ energy: {} }, { energy: { selector: { kind: 'pokemon' } } }, { energy: { providedTypes: ['Dragon'] } }, { energy: true }]) {
    assert(!handlers.get('cn.drawValue@1').validateParameters({ count: count(state) }), JSON.stringify(state));
    assert.throws(() => assertBattleValue(clone(count(state))));
  }
  const mon = { conditions: { rotation: null, poison: null, burned: false, paralysisRecoverTurn: null }, counters: 0, tools: [] };
  assert.throws(() => matchesPokemonState(mon, { abilities: [], energies: [{ instanceId: 'e', units: [['Water']] }] }, special), TypeError);
  assert.equal(matchesPokemonState(mon, { abilities: [], energies: [{ instanceId: 'e', units: [['Water']] }] }, water), true);
});

test('「选择对手的1只身上附有特殊能量的备战宝可梦」, a count of Pokémon with 【水】能量, and a Stadium for them', async () => {
  const f = await fixture((defs) => {
    def(defs, 'potion').mechanics.effects = [binding('cn.switch@1', { side: 'opponent', chooser: 'self', affected: 'selected', state: special }, 'catch')];
    def(defs, 'research').mechanics.effects = [binding('cn.drawValue@1', { count: count(water) }, 'count')];
    def(defs, 'stadium').mechanics.effects = [binding('cn.modifier@1', { field: 'defenseDamage', amount: -20, scope: 'all', targetState: water }, 'guard')];
  });
  let card, one, two;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); one = bench(s, 1, 'other'); attached(s, 1, one, 'double');
    two = bench(s, 1, 'base'); attached(s, 1, two, 'water'); });
  // The handler's own eligibility test reads the same state (with the attached cards' definitions).
  const s0 = g.snapshot(), definitions = Object.fromEntries(f.definitions.map((d) => [d.definitionId, d]));
  const effective = (m) => ({ types: ['Water'], abilities: [], energies: m.energy.map((id) => ({ instanceId: id,
    units: definitions[s0.cards[id].definitionId].mechanics.baseUnits })) });
  const ctx = (bench) => ({ state: { ...s0, players: s0.players.map((p, i) => i === 1 ? { ...p, bench } : p) }, definitions,
    source: { owner: 0 }, effectivePokemon: Object.fromEntries(s0.players[1].bench.map((m) => [m.id, effective(m)])) });
  const params = { side: 'opponent', chooser: 'self', affected: 'selected', state: special };
  assert.equal(handlers.get('cn.switch@1').canUse(ctx(s0.players[1].bench), params), true);
  assert.equal(handlers.get('cn.switch@1').canUse(ctx(s0.players[1].bench.filter((m) => m.id !== one.id)), params), false);
  command(g, { type: 'playTrainer', cardId: card });
  assert.deepEqual(g.view(0).pending.options, [one.id]);
  answer(g, [one.id]); settle(g);
  const h = board(f, (s) => { card = hand(s, 0, 'research'); attached(s, 0, s.players[0].active, 'water');
    attached(s, 0, bench(s, 0, 'other'), 'water'); bench(s, 0, 'base'); });
  const before = h.snapshot().players[0].hand.length;
  command(h, { type: 'playTrainer', cardId: card }); settle(h);
  assert.equal(h.snapshot().players[0].hand.length, before - 1 + 2);
  for (const shielded of [false, true]) {
    const k = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); putStadium(s, 1);
      if (shielded) attached(s, 1, s.players[1].active, 'water'); });
    const from = k.snapshot().events.length;
    command(k, { type: 'attack', attackId: 'base:strike' }); settle(k);
    assert.equal(k.snapshot().events.slice(from).find((e) => e.ruleId === 'attack.order' && Object.hasOwn(e.data, 'damage')).data.damage,
      shielded ? 0 : 20);
  }
});
