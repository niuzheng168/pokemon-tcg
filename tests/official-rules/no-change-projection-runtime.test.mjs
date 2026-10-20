// I.A-02 p8 / I.B-01 p11 / I.B-03 p12 / E-30 p69–70.
// Reviewed synthetic providers exercise prospective state, not real-card approval.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { findCostPayment, paymentOptionId } from '../../public/rules/activation-cost.js';
import { fixture, binding, EVIDENCE, board, hand, bench, attached, command, answer } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const FIELD = 'fixture:qualification-field';
const cost = { costId: 'fee', kind: 'discardHand', count: 1, selector: { kind: 'energy' }, sourceOfTruth: EVIDENCE };
const shield = (categories = ['trainer', 'ability']) => ({
  op: 'protection', useRule: 'ordinary', channel: 'effects', scope: 'own', from: 'own', categories,
});
const counter = () => ({ op: 'distributeCounters', side: 'own', target: 'active', selector: { kind: 'pokemon' }, count: 1 });
const native = {
  counters: () => binding('cn.counters@1', { side: 'own', target: 'active', count: 1 }),
  healing: () => binding('cn.heal@1', { target: 'active', amount: 10 }),
  batchHealing: () => binding('cn.healPokemon@1', {
    op: 'healPokemon', side: 'own', target: 'active', selector: { kind: 'pokemon' },
    selection: { kind: 'all' }, amount: 10, discardHealedEnergy: false,
  }),
  distribution: () => binding('cn.distributeCounters@1', counter()),
  switching: () => binding('cn.switch@1', { side: 'own', chooser: 'self', affected: 'active' }),
};
const restored = (g, f) => {
  const before = g.snapshot(), r = OfficialGame.restore(clone(before), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), before); return r;
};
const provider = (execute, extra = {}) => ({
  rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE, timing: 'continuous', operations: ['protection'],
  validateParameters: (p) => Object.keys(p).length === 0, execute, ...extra,
});
function resetHand(s, names) {
  const p = s.players[0]; p.deck.push(...p.hand.splice(0));
  return names.map((name) => hand(s, 0, name));
}
function resolve(g) {
  while (g.snapshot().pending) {
    const q = g.snapshot().pending;
    assert.equal(q.kind, 'effect-target'); answer(g, [q.options[0]]);
  }
}
const listed = (g, cardId) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === cardId);

for (const kind of Object.keys(native)) for (const disappears of [true, false])
  test(`unpaid ${kind}: qualification sees protection ${disappears ? 'disappear' : 'appear'} after hand play, not the act of playing`, async () => {
    const h = provider((ctx) => {
      const inHand = ctx.state.players[ctx.source.owner].hand.some((id) => ctx.state.cards[id].definitionId === 'potion');
      return inHand === disappears ? [shield()] : [];
    });
    const f = await fixture((defs) => {
      defs[0].mechanics.effects.push(binding(FIELD, {}));
      defs.find((d) => d.definitionId === 'potion').mechanics.effects = [native[kind]()];
    }, new Map([[FIELD, h]]));
    let sourceId, incoming;
    let g = board(f, (s) => {
      [sourceId] = resetHand(s, ['potion']);
      s.players[0].active.counters = 2; incoming = bench(s, 0, 'other').id;
    });
    const before = g.snapshot();
    assert.equal(listed(g, sourceId), disappears);
    assert.deepEqual(g.snapshot(), before, 'Prospective hand movement/finalizer/usage never escapes the read-only proof.');
    if (!disappears) {
      assert.throws(() => command(g, { type: 'playTrainer', cardId: sourceId }), { code: 'illegal-action' });
      assert.deepEqual(g.snapshot(), before); restored(g, f); return;
    }
    command(g, { type: 'playTrainer', cardId: sourceId }); g = restored(g, f); resolve(g);
    const after = g.snapshot();
    if (kind === 'switching') assert.equal(after.players[0].active.id, incoming);
    else assert.equal(after.players[0].active.counters, kind === 'healing' || kind === 'batchHealing' ? 1 : 3);
    assert.equal(after.players[0].discard.filter((id) => id === sourceId).length, 1);
    assert.deepEqual(after.rng, before.rng); assert.deepEqual(after.cards, before.cards); restored(g, f);
  });

for (const disappears of [true, false])
  test(`unpaid ability: its real declared-use fact ${disappears ? 'removes' : 'enables'} protection before the body`, async () => {
    const h = provider((ctx) => {
      const used = (ctx.state.players[ctx.source.owner].active.used.qualification ?? []).length > 0;
      return used !== disappears ? [shield()] : [];
    });
    const f = await fixture((defs) => {
      defs[0].mechanics.effects.push(binding(FIELD, {}));
      defs[0].mechanics.abilities.push({
        abilityId: 'qualification', name: '测试使用事实后放置', mode: 'activated',
        usage: { period: 'turn', scope: 'pokemon', key: 'qualification', limit: 1 }, sourceOfTruth: EVIDENCE,
        effects: [native.distribution()],
      });
    }, new Map([[FIELD, h]]));
    const g = board(f, (s) => { resetHand(s, []); });
    const before = g.snapshot(), a = { type: 'useAbility', pokemonId: before.players[0].active.id, abilityId: 'qualification' };
    assert.equal(g.view(0).legalActions.some((x) => x.type === a.type && x.abilityId === a.abilityId), disappears);
    assert.deepEqual(g.snapshot(), before);
    if (disappears) {
      command(g, a);
      assert.equal(g.snapshot().players[0].active.counters, 1);
      assert.deepEqual(g.snapshot().players[0].active.used.qualification, [before.turn]);
      assert.equal(g.snapshot().events.filter((e) => e.ruleId === 'ability.usage' && e.data.abilityId === a.abilityId).length, 1);
    } else {
      assert.throws(() => command(g, a), { code: 'illegal-action' }); assert.deepEqual(g.snapshot(), before);
    }
    assert.deepEqual(g.snapshot().rng, before.rng); restored(g, f);
  });

for (const spoof of [false, true])
  test(`a later full payment can qualify when the first matching is blocked; provider labels are not invariance proof (spoof=${spoof})`, async () => {
    const h = provider((ctx) => {
      const paidDouble = ctx.state.players[ctx.source.owner].discard.some((id) => ctx.state.cards[id].definitionId === 'double');
      return paidDouble ? [shield()] : [];
    }, spoof ? { id: 'cn.protection@1' } : {});
    const f = await fixture((defs) => {
      defs[0].mechanics.effects.push(binding(FIELD, {}));
      Object.assign(defs.find((d) => d.definitionId === 'potion').mechanics,
        { playCosts: [cost], effects: [native.distribution()] });
    }, new Map([[FIELD, h]]));
    let sourceId, badFee, goodFee;
    let g = board(f, (s) => {
      const p = s.players[0];
      p.deck.push(...p.discard.splice(0));
      [sourceId, badFee, goodFee] = resetHand(s, ['potion', 'double', 'water']);
    });
    const before = g.snapshot(), cards = before.players[0].hand.filter((id) => id !== sourceId).map((instanceId) => ({
      instanceId, definition: f.catalog.definition(before.cards[instanceId].definitionId),
    }));
    assert.deepEqual(findCostPayment([cost], cards), [{ costId: 'fee', cardIds: [badFee] }]);
    assert.equal(listed(g, sourceId), true); assert.deepEqual(g.snapshot(), before);
    command(g, { type: 'playTrainer', cardId: sourceId });
    assert.equal(g.snapshot().pending.kind, 'activation-cost');
    g = restored(g, f);
    const unpaid = g.snapshot();
    assert.throws(() => answer(g, [paymentOptionId('fee', badFee)]), { code: 'invalid-cost-payment' });
    assert.deepEqual(g.snapshot(), unpaid, 'A failed full choice does not prepay or consume its pending request.');
    answer(g, [paymentOptionId('fee', goodFee)]);
    const after = g.snapshot();
    assert.equal(after.players[0].active.counters, 1);
    assert(after.players[0].hand.includes(badFee)); assert(!after.players[0].discard.includes(badFee));
    const fees = after.events.filter((e) => e.ruleId === 'effects.activation-cost');
    assert.equal(fees.length, 1); assert.deepEqual(fees[0].data.payment.groups, [{ costId: 'fee', cardIds: [goodFee] }]);
    assert.equal(after.players[0].discard.filter((id) => id === sourceId).length, 1);
    assert.deepEqual(after.cards, before.cards); assert.deepEqual(after.rng, before.rng); restored(g, f);
  });

test('an independent definite draw qualifies without an irrelevant exponential native-fee search, regardless of execution order', async () => {
  let queries = 0;
  const h = provider(() => { queries++; return [shield()]; });
  const many = { ...cost, count: 4 };
  const f = await fixture((defs) => {
    defs[0].mechanics.effects.push(binding(FIELD, {}));
    Object.assign(defs.find((d) => d.definitionId === 'potion').mechanics, { playCosts: [many],
      effects: [native.distribution(), binding('cn.draw@1', { count: 1 })] });
  }, new Map([[FIELD, h]]));
  let sourceId;
  const g = board(f, (s) => { [sourceId] = resetHand(s, ['potion', ...Array(8).fill('water')]); });
  queries = 0; const before = g.snapshot();
  assert.equal(listed(g, sourceId), true);
  assert(queries < 100, `Only definite body qualification is needed, not all ${8 * 7 * 6 * 5} payments.`);
  assert.deepEqual(g.snapshot(), before);
  command(g, { type: 'playTrainer', cardId: sourceId });
  const q = g.snapshot().pending; answer(g, q.options.slice(0, 4));
  const after = g.snapshot();
  assert.equal(after.players[0].active.counters, 0);
  assert.equal(after.players[0].deck.length, before.players[0].deck.length - 1);
  assert(after.events.some((e) => e.ruleId === 'effects.draw' && e.data.count === 1));
  assert.equal(after.events.filter((e) => e.ruleId === 'effects.activation-cost').length, 1);
  assert.equal(after.players[0].discard.filter((id) => id === sourceId).length, 1);
  assert.deepEqual(after.rng, before.rng); restored(g, f);
});

for (const paid of [false, true])
  test(`a native-looking wrapper's extra printed precondition is not overwritten by the native heuristic (paid=${paid})`, async () => {
    const h = { ...createCoreHandlers().get('cn.distributeCounters@1'), sourceOfTruth: EVIDENCE,
      canUse: () => false, canUseWithCosts: () => false };
    const f = await fixture((defs) => {
      Object.assign(defs.find((d) => d.definitionId === 'potion').mechanics, {
        effects: [binding('fixture:additional-condition', counter())], ...(paid ? { playCosts: [cost] } : {}),
      });
    }, new Map([['fixture:additional-condition', h]]));
    let sourceId;
    const g = board(f, (s) => { [sourceId] = resetHand(s, paid ? ['potion', 'water'] : ['potion']); });
    const before = g.snapshot();
    assert.equal(listed(g, sourceId), false);
    assert.throws(() => command(g, { type: 'playTrainer', cardId: sourceId }), { code: 'illegal-action' });
    assert.deepEqual(g.snapshot(), before);
  });

test('even a native-source-text lookalike cost callback must return an actual Boolean, not a truthy object', async () => {
  const entry = { canUse: () => [] };
  const h = { ...createCoreHandlers().get('cn.distributeCounters@1'), sourceOfTruth: EVIDENCE,
    canUseWithCosts: (ctx, p) => entry.canUse(ctx, p) };
  const f = await fixture((defs) => {
    Object.assign(defs.find((d) => d.definitionId === 'potion').mechanics,
      { playCosts: [cost], effects: [binding('fixture:malformed-native-proof', counter())] });
  }, new Map([['fixture:malformed-native-proof', h]]));
  let sourceId;
  const g = board(f, (s) => { [sourceId] = resetHand(s, ['potion', 'water']); });
  const before = g.snapshot();
  assert.throws(() => listed(g, sourceId), { code: 'invalid-cost-check' });
  assert.deepEqual(g.snapshot(), before);
});

test('a type-changing fee settles real Energy retention before testing the native body, without leaking preview discards', async () => {
  const types = {
    rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE, timing: 'pokemonTypes', operations: ['pokemonTypes'],
    validateParameters: (p) => Object.keys(p).length === 0,
    execute: (ctx) => [{ op: 'pokemonTypes', scope: 'own', activeOnly: true,
      types: [ctx.state.players[ctx.source.owner].hand.some((id) => ctx.state.cards[id].definitionId === 'water') ? 'Water' : 'Fire'] }],
  };
  const shieldIfAttached = provider((ctx) => ctx.state.players[ctx.source.owner].active.energy.length ? [shield()] : []);
  const f = await fixture((defs) => {
    defs[0].mechanics.effects.push(binding('fixture:fee-types', {}), binding('fixture:energy-shield', {}));
    defs.find((d) => d.definitionId === 'double').mechanics.remainOn = { kind: 'pokemon', types: ['Water'] };
    Object.assign(defs.find((d) => d.definitionId === 'potion').mechanics,
      { playCosts: [cost], effects: [native.distribution()] });
  }, new Map([['fixture:fee-types', types], ['fixture:energy-shield', shieldIfAttached]]));
  let sourceId, feeId, retainedId;
  let g = board(f, (s) => {
    [sourceId, feeId] = resetHand(s, ['potion', 'water']);
    retainedId = attached(s, 0, s.players[0].active, 'double');
  });
  const before = g.snapshot(); assert.equal(listed(g, sourceId), true);
  assert.deepEqual(g.snapshot(), before, 'Neither fee nor conditional-retention disposal escapes a query.');
  command(g, { type: 'playTrainer', cardId: sourceId }); g = restored(g, f);
  answer(g, [paymentOptionId('fee', feeId)]);
  const after = g.snapshot();
  assert.equal(after.players[0].active.counters, 1);
  assert.deepEqual(after.players[0].active.energy, []);
  assert.equal(after.players[0].discard.filter((id) => id === retainedId).length, 1);
  assert.equal(after.events.filter((e) => e.ruleId === 'energy.move' && e.data.energyId === retainedId).length, 1);
  assert.equal(after.events.filter((e) => e.ruleId === 'effects.activation-cost').length, 1);
  assert.deepEqual(after.cards, before.cards); assert.deepEqual(after.rng, before.rng); restored(g, f);
});
