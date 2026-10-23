// Synthetic definitions only. Shapes follow II.D-02 文例1 (雷丘V「强劲电光」:
// discard any number of attached Energy, then damage = that card count × N).
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, EngineError } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { evaluateBattleValue, assertBattleValue } from '../../public/rules/battle-value.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, board, command, answer, settle, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const discard = (from, extra = {}) => ({
  op: 'discardEnergy', side: 'own', from, selector: { kind: 'energy', category: 'basic' }, providedTypes: null,
  measure: 'cards', quantity: { kind: 'any' }, chooser: 'source', ...extra,
});
const cards = (effectId) => ({ kind: 'effectCards', effectId: `fixture:${effectId}` });
const times = (n, ...ids) => ({ kind: 'multiply', left: { kind: 'literal', value: n },
  right: ids.length === 1 ? cards(ids[0]) : { kind: 'add', terms: ids.map(cards) } });
function strike(defs, effects, value = 70) {
  const a = defs[0].mechanics.attacks[0];
  a.printedDamage = { value, operator: 'times' }; a.effects = effects;
}
const attack = (g) => command(g, { type: 'attack', attackId: 'base:strike' });
const counts = (g) => g.snapshot().events.filter((e) => e.ruleId === 'damage.effect-count');

test('counted discard handler: CN source, before-damage timing, cards-only parameters, effectCards expressions', () => {
  const h = createCoreHandlers().get('cn.countedEnergyDiscard@1');
  assert.equal(h.timing, 'beforeDamage'); assert.deepEqual(h.operations, ['discardEnergy']);
  assert.deepEqual(h.capabilities, ['effect-card-count']);
  for (const source of requireRule(CN_V20261019, 'damage.effect-count').sourceOfTruth) assert(h.sourceOfTruth.includes(source));
  assert(h.validateParameters(discard('any')));
  assert(h.validateParameters(discard('active', { side: 'opponent' })), '「在造成伤害前，选择附着于对手战斗宝可梦身上的…能量」');
  for (const bad of [discard('any', { op: 'moveEnergy' }), discard('any', { side: 'both' }), discard('any', { measure: 'units' }),
    { ...discard('any'), extra: 1 }]) assert(!h.validateParameters(bad));
  assert.deepEqual(h.execute({}, discard('self')), [discard('self')]);
  const expr = times(70, 'a', 'b');
  assert.equal(assertBattleValue(expr), expr);
  assert.equal(evaluateBattleValue(expr, { effectCards: { 'fixture:a': 2, 'fixture:b': 0 } }), 140);
  assert.throws(() => evaluateBattleValue(expr, { effectCards: { 'fixture:a': 2 } }), /missing/);
  assert.throws(() => evaluateBattleValue(cards('a'), { effectCards: { 'fixture:a': -1 } }), /safe integers/);
  for (const bad of [{ kind: 'effectCards' }, { kind: 'effectCards', effectId: 'bad id' }, { kind: 'effectCards', effectId: 'x', field: 'cards' },
    { kind: 'effectCards', effectId: 'x'.repeat(201) }, { kind: 'effectCards', effectId: 7 }])
    assert.throws(() => assertBattleValue(bad), /effect identity|exactly/);
});

test('II.D-02 文例1: discard any number of own Basic Energy from any Pokémon; damage is the actual card count × 70', async () => {
  const f = await fixture((defs) => strike(defs, [
    binding('cn.countedEnergyDiscard@1', discard('any'), 'count'),
    binding('cn.damageValue@1', { expression: times(70, 'count') }, 'formula'),
  ]));
  let own, benched, special;
  const g = board(f, (s) => {
    const a = s.players[0].active, b = bench(s, 0, 'other');
    own = [attached(s, 0, a, 'water'), attached(s, 0, a, 'water')]; special = attached(s, 0, a, 'double');
    benched = attached(s, 0, b, 'water'); bench(s, 1, 'other');
  });
  const prizes = g.snapshot().players[0].prizes.length;
  attack(g);
  const q = g.view(0).pending;
  assert.equal(q.kind, 'attached-energy'); assert.equal(q.minimum, 0); assert.equal(q.allowZero, true);
  assert.deepEqual([...q.options].sort(), [...own, benched].sort(), 'Special Energy is not a Basic Energy card.');
  const r = restore(g, f);
  for (const game of [g, r]) { answer(game, [own[0], benched]); settle(game); }
  assert.deepEqual(r.snapshot(), g.snapshot());
  const s = g.snapshot();
  assert.deepEqual(s.events.filter((e) => e.ruleId === 'attack.order').map((e) => e.data.damage), [140]);
  assert.equal(s.players[0].prizes.length, prizes - 1, 'The 100 HP Active was Knocked Out by 2 × 70.');
  assert(s.players[0].discard.includes(own[0]) && s.players[0].discard.includes(benched));
  assert.deepEqual(s.players[0].active.energy.sort(), [own[1], special].sort());
  const [record] = counts(g);
  assert.deepEqual([record.visibility, record.data.effectId, record.data.cards], ['public', 'fixture:count', [own[0], benched]]);
  assert(g.view(1).events.some((e) => e.ruleId === 'damage.effect-count'));
});

test('choosing zero, or having no matching Basic Energy, records an explicit zero and deals no damage', async () => {
  for (const types of [null, ['Fire']]) {
    const selector = { kind: 'energy', category: 'basic', ...(types ? { types } : {}) };
    const f = await fixture((defs) => strike(defs, [
      binding('cn.countedEnergyDiscard@1', discard('self', { selector }), 'count'),
      binding('cn.damageValue@1', { expression: times(70, 'count') }, 'formula'),
    ]));
    const g = board(f, (s) => attached(s, 0, s.players[0].active, 'water'));
    attack(g);
    if (!types) { assert.equal(g.view(0).pending.kind, 'attached-energy'); answer(g, []); }
    else assert.equal(g.view(0).pending, null, 'No eligible card: nothing to choose.');
    settle(g);
    assert.equal(g.snapshot().players[1].active.counters, 0);
    assert.deepEqual(counts(g).map((e) => e.data.cards), [[]]);
    assert.equal(g.snapshot().players[0].active.energy.length, 1);
  }
});

test('two counted effects keep separate results; saved counts, receipts and frozen facts must agree on restore', async () => {
  const f = await fixture((defs) => strike(defs, [
    binding('cn.countedEnergyDiscard@1', discard('self'), 'self'),
    binding('cn.countedEnergyDiscard@1', discard('bench'), 'bench'),
    binding('cn.damageValue@1', { expression: times(70, 'self', 'bench') }, 'formula'),
    binding('cn.damage@1', { side: 'opponent', target: 'bench', amount: 10, selection: { kind: 'exact', count: 1 }, options: {} }, 'snipe'),
  ]));
  let mine, theirs;
  const g = board(f, (s) => {
    mine = attached(s, 0, s.players[0].active, 'water');
    theirs = attached(s, 0, bench(s, 0, 'other'), 'water');
    bench(s, 1, 'other'); bench(s, 1, 'base');
  });
  attack(g); answer(g, [mine]);
  const middle = g.snapshot();
  assert.deepEqual(middle.attack.execution.effectCards, [{ effectId: 'fixture:self', cards: [mine] }]);
  const forged = clone(middle);
  forged.attack.execution.effectCards[0].cards = [];
  assert.throws(() => OfficialGame.restore(forged, { catalog: f.catalog }), (e) => e.code === 'invalid-effect-count');
  const hidden = clone(middle);
  hidden.events = hidden.events.filter((e) => e.ruleId !== 'damage.effect-count');
  assert.throws(() => OfficialGame.restore(hidden, { catalog: f.catalog }), (e) => e.code === 'invalid-effect-count');
  const foreign = clone(middle);
  foreign.attack.execution.effectCards[0].effectId = 'fixture:formula';
  assert.throws(() => OfficialGame.restore(foreign, { catalog: f.catalog }), (e) => e.code === 'invalid-effect-count');
  const stolen = clone(middle);
  const card = Object.keys(stolen.cards).find((id) => stolen.cards[id].owner === 1);
  stolen.attack.execution.effectCards[0].cards = [card];
  stolen.events.find((e) => e.ruleId === 'damage.effect-count').data.cards = [card];
  assert.throws(() => OfficialGame.restore(stolen, { catalog: f.catalog }), (e) => e.code === 'invalid-effect-count');
  // A consistent but premature result for the still-pending effect restores, yet cannot be recorded twice.
  const early = clone(middle), receipt = clone(early.events.find((e) => e.ruleId === 'damage.effect-count'));
  receipt.data = { ...receipt.data, effectId: 'fixture:bench', cards: [] };
  early.attack.execution.effectCards.push({ effectId: 'fixture:bench', cards: [] }); early.events.push(receipt);
  early.events.find((e) => e.ruleId === 'selection.request' && e.data.request.id === early.pending.id)
    .data.work.attack.execution.effectCards = clone(early.attack.execution.effectCards);
  const replay = OfficialGame.restore(early, { catalog: f.catalog });
  assert.throws(() => answer(replay, [theirs]), (e) => e.code === 'invalid-effect-count');
  answer(g, [theirs]);
  const damage = g.snapshot();
  assert.equal(damage.pending.kind, 'damage-targets');
  assert.equal(damage.players[1].active.counters, 14);
  assert(restore(g, f));
  const frozen = clone(damage);
  frozen.attack.damageModels[0].battleValues.effectCards['fixture:self'] = 3;
  frozen.events.find((e) => e.ruleId === 'damage.expression' && e.data.kind === 'stage-snapshot')
    .data.models[0].battleValues.effectCards['fixture:self'] = 3;
  assert.throws(() => OfficialGame.restore(frozen, { catalog: f.catalog }), (e) => e.code === 'invalid-effect-count');
  const dropped = clone(damage);
  dropped.attack.execution.effectCards.pop();
  dropped.events.splice(dropped.events.findLastIndex((e) => e.ruleId === 'damage.effect-count'), 1);
  for (const model of [...dropped.attack.damageModels, ...dropped.events.find((e) => e.ruleId === 'damage.expression' &&
    e.data.kind === 'stage-snapshot').data.models]) delete model.battleValues.effectCards['fixture:bench'];
  assert.throws(() => OfficialGame.restore(dropped, { catalog: f.catalog }), (e) => e.code === 'invalid-effect-count');
  settle(g);
  assert.equal(g.snapshot().attack, null);
});

test('a counted effect cannot record outside its own pre-damage execution, and admission keeps it on attacks before damage', async () => {
  const core = createCoreHandlers().get('cn.countedEnergyDiscard@1');
  for (const [where, h] of [['trainer', core], ['attack', { ...core, timing: 'resolve' }],
    ['attack', { ...core, operations: ['discardEnergy', 'moveEnergy'] }]]) {
    const f = await fixture((defs) => {
      if (where === 'trainer') defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('fixture:counted', discard('any'))];
      else defs[0].mechanics.attacks[0].effects = [binding('fixture:counted', discard('any'))];
    }, new Map([['fixture:counted', h]]));
    assert.throws(() => board(f), (e) => e instanceof EngineError && e.code === 'unsupported-effect-count');
  }
  const f = await fixture((defs) => strike(defs, [
    binding('cn.countedEnergyDiscard@1', discard('self'), 'count'),
    binding('cn.damageValue@1', { expression: times(70, 'count', 'missing') }, 'formula'),
  ]));
  const g = board(f, (s) => attached(s, 0, s.players[0].active, 'water'));
  attack(g);
  const before = g.snapshot();
  assert.throws(() => answer(g, []), /missing/, 'A formula never treats an absent counted effect as zero.');
  assert.deepEqual(g.snapshot(), before);
});
