// Synthetic definitions only. 「在自己的回合可以使用1次。选择自己的1只宝可梦，抛掷1次硬币。如果为正面，则回复该宝可梦「90」点HP。
// 如果为反面，则给该宝可梦身上放置3个伤害指示物。」 (effects.chosen-pokemon). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, bench } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const handlers = createCoreHandlers();
const valid = (p) => handlers.get('cn.coin@1').validateParameters(clone(p));
const leaf = (handlerId, parameters) => ({ handlerId, parameters });
const MEDICINE = { pokemon: { side: 'own', target: 'any' }, outcome: 'heads', effect: leaf('cn.heal@1', { target: 'any', amount: 90 }),
  otherwise: leaf('cn.counters@1', { side: 'own', target: 'any', count: 3 }) };
const ability = (effects) => ({ abilityId: 'fixture:medicine', name: '测试秘药', mode: 'activated',
  usage: { period: 'turn', scope: 'pokemon', key: 'fixture:medicine', limit: 1 }, effects, sourceOfTruth: EVIDENCE });
const slowking = (defs) => {
  for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.hp = 500;
  defs[0].mechanics.abilities = [ability([binding('cn.coin@1', MEDICINE, 'medicine')])];
};
const use = (g) => command(g, { type: 'useAbility', pokemonId: g.snapshot().players[0].active.id, abilityId: 'fixture:medicine' });

test('schemas: the chosen Pokémon comes with one leaf per printed result that a bound Pokémon can take; the rule cites II.A', () => {
  assert(requireRule(CN_V20261019, 'effects.chosen-pokemon').sourceOfTruth.some((s) => s.section.includes('II.A')));
  assert(valid(MEDICINE));
  assert(valid((({ otherwise: _o, ...rest }) => rest)(MEDICINE)), 'A single printed result.');
  for (const bad of [{ ...MEDICINE, pokemon: { side: 'own' } }, { ...MEDICINE, pokemon: { side: 'both', target: 'any' } },
    { ...MEDICINE, effect: leaf('cn.draw@1', { count: 1 }) }, { ...MEDICINE, otherwise: leaf('cn.draw@1', { count: 1 }) },
    (({ effect: _e, ...rest }) => ({ ...rest, effects: [MEDICINE.effect, MEDICINE.otherwise] }))(MEDICINE)])
    assert(!valid(bad), JSON.stringify(bad));
  // Only an entry's own coin chooses first: not a coin nested in another instruction.
  assert(!handlers.get('cn.then@1').validateParameters({ first: leaf('cn.draw@1', { count: 1 }), next: leaf('cn.coin@1', MEDICINE) }));
  assert.equal(handlers.get('cn.coin@1').execute({}, MEDICINE)[0].op, 'thenMoved');
});

test('the Pokémon is chosen before the flip; heads heals it and tails puts counters on it, never on another', async () => {
  const f = await fixture(slowking);
  const results = new Set();
  for (const seed of [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]]) {
    let chosen;
    const g = board({ ...f, seed }, (s) => { s.players[0].active.counters = 10; chosen = bench(s, 0, 'other'); chosen.counters = 10; });
    use(g);
    const q = g.snapshot().pending;
    assert.deepEqual([q.kind, q.ruleId, q.options.length], ['effect-target', 'effects.chosen-pokemon', 2]);
    assert(!g.snapshot().events.some((e) => e.ruleId === 'effects.coin'), 'No coin before the choice.');
    restore(g, f);
    answer(g, [chosen.id]); settle(g);
    const s = g.snapshot(), heads = s.events.findLast((e) => e.ruleId === 'effects.coin').data.result === 'heads';
    assert.deepEqual([s.players[0].bench[0].counters, s.players[0].active.counters], [heads ? 1 : 13, 10]);
    assert(s.events.some((e) => e.ruleId === 'effects.chosen-pokemon' && e.data.pokemonId === chosen.id));
    results.add(heads);
    restore(g, f);
  }
  assert.equal(results.size, 2, 'Both results occur among these seeds.');
});

test('an undamaged chosen Pokémon: heads heals nothing; the ability is still usable', async () => {
  const f = await fixture(slowking);
  for (const seed of [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]]) {
    const g = board({ ...f, seed }, (s) => { bench(s, 0, 'other').counters = 4; });
    use(g);
    answer(g, [g.snapshot().players[0].active.id]); settle(g);
    const s = g.snapshot(), heads = s.events.findLast((e) => e.ruleId === 'effects.coin').data.result === 'heads';
    assert.deepEqual([s.players[0].active.counters, s.players[0].bench[0].counters], [heads ? 0 : 3, 4]);
  }
});
