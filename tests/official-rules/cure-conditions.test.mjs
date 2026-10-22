// Synthetic definitions only. 「恢复…特殊状态」 by an effect (I.F 如何恢复特殊状态 「使用效果」): all of them, the printed ones,
// or N of them chosen by the user; Poison and Burn lose their markers. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { presentConditions, cureConditions, emptyConditions } from '../../public/rules/conditions.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();
const valid = (p) => handlers.get('cn.cure@1').validateParameters(clone(p));
const sick = (m, turn = 1) => { m.conditions = { rotation: 'paralyzed', poison: 4, burned: true, paralysisRecoverTurn: turn }; };
const playable = (g, card) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card);
const item = (parameters) => (defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.cure@1', parameters, 'cure')]; };

test('schemas, rule and the condition helpers', () => {
  assert(requireRule(CN_V20261019, 'status.cure').sourceOfTruth.some((s) => s.section === '如何恢复特殊状态'));
  for (const p of [{ side: 'own', target: 'self' }, { side: 'opponent', target: 'active' }, { side: 'own', target: 'active', conditions: ['poisoned'] },
    { side: 'own', target: 'active', count: 1 }])
    assert(valid(p), JSON.stringify(p));
  for (const p of [{ side: 'own', target: 'bench' }, { side: 'own', target: 'active', conditions: [] }, { side: 'own', target: 'active', count: 0 },
    { side: 'own', target: 'active', conditions: ['frozen'] }, { side: 'own' }])
    assert(!valid(p), JSON.stringify(p));
  const c = { rotation: 'asleep', poison: 2, burned: false, paralysisRecoverTurn: null };
  assert.deepEqual(presentConditions(c), ['asleep', 'poisoned']);
  assert.deepEqual(presentConditions(c, ['burned', 'poisoned']), ['poisoned']);
  assert.deepEqual(cureConditions(c, ['asleep', 'poisoned']), emptyConditions());
  for (const names of [[], ['burned'], ['asleep', 'asleep'], 'asleep']) assert.throws(() => cureConditions(c, names), TypeError);
});

test('「将自己战斗宝可梦的特殊状态，全部恢复」: usable only with something to recover; Poison and Burn markers go too', async () => {
  const f = await fixture(item({ side: 'own', target: 'active' }));
  let card;
  assert(!playable(board(f, (s) => { card = hand(s, 0, 'potion'); }), card), 'Nothing would change.');
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); sick(s.players[0].active); });
  assert(playable(g, card));
  command(g, { type: 'playTrainer', cardId: card }); settle(g);
  assert.deepEqual(g.snapshot().players[0].active.conditions, emptyConditions());
  assert.deepEqual(g.snapshot().events.find((e) => e.ruleId === 'status.cure').data.conditions, ['paralyzed', 'poisoned', 'burned']);
  // 「恢复…【中毒】状态」: only the printed one.
  const poison = await fixture(item({ side: 'own', target: 'active', conditions: ['poisoned', 'asleep'] }));
  const h = board(poison, (s) => { card = hand(s, 0, 'potion'); sick(s.players[0].active); });
  command(h, { type: 'playTrainer', cardId: card }); settle(h);
  assert.deepEqual(h.snapshot().players[0].active.conditions, { rotation: 'paralyzed', poison: null, burned: true, paralysisRecoverTurn: 1 });
});

test('「恢复自己战斗宝可梦的1个特殊状态」: the user chooses which; all when it has no more', async () => {
  const f = await fixture(item({ side: 'own', target: 'active', count: 2 }));
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); sick(s.players[0].active); });
  command(g, { type: 'playTrainer', cardId: card });
  const q = g.view(0).pending;
  assert.deepEqual([q.kind, q.options, q.minimum, q.maximum], ['cure-conditions', ['paralyzed', 'poisoned', 'burned'], 2, 2]);
  const r = restore(g, f);
  assert.throws(() => answer(r, ['paralyzed']));
  answer(g, ['burned', 'paralyzed']); settle(g);
  assert.deepEqual(g.snapshot().players[0].active.conditions, { rotation: null, poison: 4, burned: false, paralysisRecoverTurn: null });
  const h = board(f, (s) => { card = hand(s, 0, 'potion'); s.players[0].active.conditions.burned = true; });
  command(h, { type: 'playTrainer', cardId: card });
  assert.equal(h.view(0).pending, null);
  assert.equal(h.snapshot().players[0].active.conditions.burned, false);
});

test('an attack: 「回复这只宝可梦「30」HP，并恢复其所有特殊状态」, then 「恢复对手的战斗宝可梦的所有特殊状态」', async () => {
  const f = await fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 500; d.mechanics.weakness = null; d.mechanics.resistance = null; }
    def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.heal@1', { target: 'self', amount: 30 }, 'heal'),
      binding('cn.cure@1', { side: 'own', target: 'self' }, 'cure'), binding('cn.cure@1', { side: 'opponent', target: 'active' }, 'theirs')];
  });
  const g = board(f, (s) => { const m = s.players[0].active; attached(s, 0, m, 'water'); m.counters = 5;
    m.conditions = { rotation: null, poison: 1, burned: true, paralysisRecoverTurn: null }; s.players[1].active.conditions.burned = true; });
  const from = g.snapshot().events.length;
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  const cures = g.snapshot().events.slice(from).filter((e) => e.ruleId === 'status.cure');
  assert.deepEqual(cures.map((e) => e.data.conditions), [['poisoned', 'burned'], ['burned']]);
  // Cured before the checkup: no Poison counter, no Burn coin for either Active.
  assert.equal(g.snapshot().players[0].active.counters, 2);
  assert(!g.snapshot().events.slice(from).some((e) => ['status.poison', 'status.burn'].includes(e.ruleId) && e.data.counters));
  // A Benched holder has no Special Condition to recover.
  const k = board(f, (s) => { const m = bench(s, 0, 'other'); attached(s, 0, s.players[0].active, 'water'); s.players[1].active.conditions.burned = true; void m; });
  command(k, { type: 'attack', attackId: 'base:strike' }); settle(k);
  assert.deepEqual(k.snapshot().events.filter((e) => e.ruleId === 'status.cure').map((e) => e.data.targetId), [k.snapshot().players[1].active.id]);
});

test('an Ability triggered 「每当从自己的手牌给这只宝可梦附着能量时，就恢复这只宝可梦的所有特殊状态」', async () => {
  const f = await fixture((defs) => {
    def(defs, 'base').mechanics.abilities = [{ abilityId: 'fixture:spring', name: '测试清泉', mode: 'triggered', sourceOfTruth: EVIDENCE,
      trigger: { event: 'energyAttached', subject: 'self', origin: 'hand', optional: false, choiceOwner: 'source', scope: 'global' }, usage: null,
      effects: [binding('cn.cure@1', { side: 'own', target: 'self' }, 'spring')] }];
  });
  let water;
  const g = board(f, (s) => { sick(s.players[0].active); water = hand(s, 0, 'water'); });
  command(g, { type: 'attachEnergy', cardId: water, pokemonId: g.snapshot().players[0].active.id });
  settle(g, (q) => q.options.includes('perform') ? ['perform'] : q.options.slice(0, q.minimum));
  assert.deepEqual(g.snapshot().players[0].active.conditions, emptyConditions());
});
