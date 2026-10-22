// Synthetic definitions only. Control handlers composing the wider static leaf set: II.C-05 coin results that open a
// lasting effect or several effects, II.E-10 「若希望」 and II.E-19 「然后」 whose second part reads the board after the
// first. They approve no actual card or printing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers, validateOptionalEffect, validateThenEffect } from '../../public/rules/handlers.js';
import { randomIndex } from '../../public/rules/random.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
function forceCoin(s, result) {
  for (let k = 1; ; k++) {
    const rng = [k, k * 7 + 1, k * 13 + 2, k * 31 + 3];
    if (randomIndex([...rng], 2) === (result === 'heads' ? 0 : 1)) { s.rng = rng; return; }
  }
}
const nested = (handlerId, parameters) => ({ handlerId, parameters });
const guard = () => nested('cn.lasting@1', { side: 'own', target: 'self',
  effect: { op: 'modifier', field: 'defenseDamage', amount: -30, scope: 'all' },
  duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true });
const status = (condition) => nested('cn.condition@1', { side: 'opponent', condition });
const switchSelf = () => nested('cn.switch@1', { side: 'own', chooser: 'self', affected: 'active' });
const gust = () => nested('cn.switch@1', { side: 'opponent', chooser: 'self', affected: 'selected' });
const attack = (g) => command(g, { type: 'attack', attackId: 'base:strike' });
const withAttack = (effects) => (defs) => { defs[0].mechanics.attacks[0].effects = effects; };
const guards = (s) => s.ongoing.filter((e) => e.targetId === s.players[0].active.id && e.effect.field === 'defenseDamage');

test('optional handler: II.E-10 source, the same strict static leaves, and a fixed program', () => {
  const h = createCoreHandlers().get('cn.optional@1');
  for (const source of requireRule(CN_V20261019, 'selection.optional').sourceOfTruth) assert(h.sourceOfTruth.includes(source));
  assert.deepEqual(h.operations.slice(0, 2), ['optional', 'sequence']);
  assert.equal(h.validateParameters, validateOptionalEffect);
  assert(validateOptionalEffect({ effect: guard() }));
  for (const bad of [{}, { effect: nested('cn.drawUntil@1', { count: 6 }) }, { effect: guard(), extra: true },
    { effect: nested('cn.lasting@1', { side: 'own' }) }])
    assert(!validateOptionalEffect(bad));
  assert.deepEqual(h.execute({ source: { owner: 0 } }, { effect: guard() }),
    [{ op: 'optional', effect: { op: 'sequence', steps: [{ op: 'lasting', ...guard().parameters }] } }]);
  // A then's parts may now be any static leaf, e.g. a lasting effect after a switch.
  assert(validateThenEffect({ first: switchSelf(), next: guard() }));
});

test('II.C-05: a coin opens a lasting effect on this Pokémon only on its printed result', async () => {
  const f = await fixture(withAttack([binding('cn.coin@1', { outcome: 'heads', effect: guard() })]));
  for (const result of ['heads', 'tails']) {
    const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); forceCoin(s, result); });
    attack(g); settle(g);
    const s = g.snapshot();
    assert.equal(s.players[1].active.counters, 2, 'The printed damage is independent of the flip.');
    assert.equal(guards(s).length, result === 'heads' ? 1 : 0);
    restore(g, f);
  }
});

test('II.C-05: one flip opens several printed results, each in order', async () => {
  const f = await fixture(withAttack([binding('cn.coin@1', { outcome: 'heads', effects: [status('poisoned'), status('confused')] })]));
  for (const result of ['heads', 'tails']) {
    const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); forceCoin(s, result); });
    attack(g); settle(g);
    const c = g.snapshot().players[1].active.conditions;
    assert.deepEqual([c.poison !== null, c.rotation], result === 'heads' ? [true, 'confused'] : [false, null]);
    assert.equal(g.snapshot().events.filter((e) => e.ruleId === 'effects.coin').length, 1, 'One flip, not one per result.');
  }
  const h = createCoreHandlers().get('cn.coin@1'), ctx = { source: { owner: 0 }, state: { players: [] } };
  assert.deepEqual(h.execute(ctx, { outcome: 'tails', effects: [status('poisoned'), status('confused')] }), [{ op: 'coin', outcome: 'tails',
    effect: { op: 'sequence', steps: [{ op: 'condition', target: 'active', ...status('poisoned').parameters },
      { op: 'condition', target: 'active', ...status('confused').parameters }] } }]);
});

test('II.E-10: the user may decline the whole effect; declining performs nothing', async () => {
  const f = await fixture(withAttack([binding('cn.optional@1', { effect: switchSelf() })]));
  for (const perform of [false, true]) {
    let mine;
    const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); mine = bench(s, 0, 'other'); });
    const before = g.snapshot().players[0].active.id;
    attack(g);
    const q = g.view(0).pending;
    assert.deepEqual([q.kind, q.options, g.snapshot().pending.player], ['optional-effect', ['perform', 'skip'], 0]);
    assert.equal(g.view(1).pending, null, 'The opponent never decides the user\'s 「若希望」.');
    restore(g, f);
    answer(g, [perform ? 'perform' : 'skip']);
    if (perform) { assert.deepEqual(g.view(0).pending.options, [mine.id]); answer(g, [mine.id]); }
    settle(g);
    assert.equal(g.snapshot().players[0].active.id, perform ? mine.id : before);
    assert(g.snapshot().events.some((e) => e.ruleId === 'selection.optional' && e.data.performed === perform));
  }
});

test('II.E-19: the part after 然后 reads the board the first part left, not the board before it', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'potion').mechanics = { category: 'item',
      effects: [binding('cn.then@1', { first: gust(), next: status('confused') })] };
  });
  let card, theirs;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); theirs = bench(s, 1, 'other'); });
  const old = g.snapshot().players[1].active.id;
  command(g, { type: 'playTrainer', cardId: card });
  answer(g, [theirs.id]); settle(g);
  const p = g.snapshot().players[1];
  assert.equal(p.active.id, theirs.id);
  assert.equal(p.active.conditions.rotation, 'confused', 'The new Active Pokémon is the one confused.');
  assert.equal(p.bench.find((m) => m.id === old).conditions.rotation, null);
});

test('II.E-10 on an Item: it can be played only if the optional effect could change something', async () => {
  const heal = nested('cn.heal@1', { target: 'any', amount: 30 });
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'potion').mechanics = { category: 'item', effects: [binding('cn.optional@1', { effect: heal })] };
  });
  let card;
  const healthy = board(f, (s) => { card = hand(s, 0, 'potion'); });
  assert(!healthy.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card));
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); s.players[0].active.counters = 5; });
  command(g, { type: 'playTrainer', cardId: card });
  answer(g, ['perform']); settle(g);
  assert.equal(g.snapshot().players[0].active.counters, 2);
});
