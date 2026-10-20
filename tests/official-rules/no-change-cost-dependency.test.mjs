/**
 * Bounded CN counterexample, not approval of any actual card/custom handler.
 * Pinned CN advanced 3.1.0 SHA256 27bda43d8cb78ed800891c6793e5efd945ac64d94a83ceff8adaed10e8f67419:
 * I.A-02 p8, I.B-01 p11, I.B-03 p12, II.E-30 p69–70 (one-based).
 *
 * Conditions are fulfilled BEFORE the subsequent effect. A unique complete
 * Water-card payment changes a reviewed synthetic continuous provider's input.
 * The following fixed-total effect is statically one counter; it is not a fee,
 * transfer, optional branch, random effect, dynamic amount or whole-card guess.
 * If that post-cost counter can actually be placed, there is a subsequent
 * change. If the unique payment leaves every target protected/ineligible, paying
 * alone must not count as the required effect change.
 *
 * Providers below use existing trusted-handler/canonical-catalog contracts.
 * No core handler is replaced and no source/cost proof is relaxed. Their small,
 * deterministic hand/discard predicates do not claim an international ruling,
 * a real-card interaction, or support for arbitrary custom cost dependencies.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { findCostPayment, paymentOptionId } from '../../public/rules/activation-cost.js';
import { fixture, binding, EVIDENCE, board, command, answer, hand } from './fixtures.mjs';

const FEE_ID = 'water-fee';
const PROVIDER_ID = 'fixture:water-cost-dependent-provider';
const FEE = {
  costId: FEE_ID, kind: 'discardHand', count: 1,
  selector: { kind: 'energy', category: 'basic', types: ['Water'] }, sourceOfTruth: EVIDENCE,
};
const oneCounter = (typed) => ({
  op: 'distributeCounters', side: 'own', target: 'active',
  selector: typed ? { kind: 'pokemon', types: ['Water'] } : { kind: 'pokemon' }, count: 1,
});
const waterIn = (ctx, zone) => ctx.state.players[ctx.source.owner][zone]
  .some((id) => ctx.state.cards[id].definitionId === 'water');
const shield = () => ({
  op: 'protection', useRule: 'ordinary', channel: 'effects', scope: 'own', from: 'own', categories: ['ability', 'trainer'],
});
function provider(mode) {
  const typed = mode.startsWith('types-');
  return {
    rulesetId: 'CN/V20261019', implementationVersion: `synthetic-unique-water-cost:${mode}`,
    sourceOfTruth: EVIDENCE, timing: typed ? 'pokemonTypes' : 'continuous',
    operations: [typed ? 'pokemonTypes' : 'protection'],
    validateParameters: (p) => !!p && !Array.isArray(p) && Object.keys(p).length === 0,
    execute: (ctx) => {
      if (typed) {
        const eligible = mode === 'types-become-eligible' ? !waterIn(ctx, 'hand') : waterIn(ctx, 'hand');
        return [{ op: 'pokemonTypes', scope: 'own', activeOnly: true, types: [eligible ? 'Water' : 'Fire'] }];
      }
      const protectedNow = waterIn(ctx, mode === 'protection-disappears' ? 'hand' : 'discard');
      return protectedNow ? [shield()] : [];
    },
  };
}
const restore = (g, f) => {
  const snapshot = g.snapshot(), restored = OfficialGame.restore(structuredClone(snapshot), { catalog: f.catalog });
  assert.deepEqual(restored.snapshot(), snapshot);
  return restored;
};

async function setup(slot, mode) {
  const typed = mode.startsWith('types-'), h = provider(mode);
  const f = await fixture((defs) => {
    // This printed continuous source remains on the same field Pokemon before
    // and after payment. Only the public effect-context hand/discard facts vary.
    defs[0].mechanics.effects.push(binding(PROVIDER_ID, {}, 'cost-dependent-provider'));
    const effects = [binding('cn.distributeCounters@1', oneCounter(typed), 'paid-one-counter')];
    if (slot === 'ability') defs[0].mechanics.abilities.push({
      abilityId: 'paid', name: '测试唯一水能量费用后放置', mode: 'activated',
      usage: { period: 'turn', scope: 'pokemon', key: 'paid', limit: 1 },
      costs: [FEE], effects, sourceOfTruth: EVIDENCE,
    });
    else Object.assign(defs.find((d) => d.definitionId === 'potion').mechanics, { playCosts: [FEE], effects });
  }, new Map([[PROVIDER_ID, h]]));
  let feeId, sourceId;
  const g = board(f, (s) => {
    const p = s.players[0];
    p.deck.push(...p.hand.splice(0));
    // Existing physical cards only: make the hand's Water payment unique and
    // remove any initial discard Water so the "appears" predicate is precise.
    for (const id of [...p.discard]) if (s.cards[id].definitionId === 'water') {
      p.discard.splice(p.discard.indexOf(id), 1); p.deck.push(id);
    }
    sourceId = slot === 'trainer' ? hand(s, 0, 'potion') : p.active.stack.at(-1);
    feeId = hand(s, 0, 'water'); s.events = [];
  });
  const initial = g.snapshot(), postCost = structuredClone(initial);
  postCost.players[0].hand.splice(postCost.players[0].hand.indexOf(feeId), 1);
  postCost.players[0].discard.push(feeId);
  if (slot === 'trainer') {
    postCost.players[0].hand.splice(postCost.players[0].hand.indexOf(sourceId), 1);
    postCost.players[0].resolving.push(sourceId);
  }
  const pool = initial.players[0].hand.filter((id) => id !== sourceId).map((instanceId) => ({
    instanceId, definition: f.catalog.definition(initial.cards[instanceId].definitionId),
  }));
  assert.equal(pool.length, 1);
  assert.deepEqual(findCostPayment([FEE], pool), [{ costId: FEE_ID, cardIds: [feeId] }]);
  assert.deepEqual(postCost.cards, initial.cards);
  assert.deepEqual(postCost.players[0].active, initial.players[0].active, 'Payment never moves or edits a field Pokemon.');
  assert.deepEqual(postCost.rng, initial.rng);
  const beforeSpec = h.execute({ state: initial, source: { owner: 0 } });
  const afterSpec = h.execute({ state: postCost, source: { owner: 0 } });
  if (typed) {
    assert.deepEqual(beforeSpec[0].types, [mode === 'types-become-eligible' ? 'Fire' : 'Water']);
    assert.deepEqual(afterSpec[0].types, [mode === 'types-become-eligible' ? 'Water' : 'Fire']);
  } else {
    assert.deepEqual(beforeSpec, mode === 'protection-disappears' ? [shield()] : []);
    assert.deepEqual(afterSpec, mode === 'protection-disappears' ? [] : [shield()]);
  }
  const activation = slot === 'trainer' ? { type: 'playTrainer', cardId: sourceId } :
    { type: 'useAbility', pokemonId: initial.players[0].active.id, abilityId: 'paid' };
  const listed = () => g.view(0).legalActions.some((a) => a.type === activation.type &&
    (slot === 'trainer' ? a.cardId === sourceId : a.pokemonId === activation.pokemonId && a.abilityId === 'paid'));
  return { g, f, feeId, sourceId, initial, activation, listed };
}

for (const slot of ['ability', 'trainer']) for (const mode of ['protection-disappears', 'types-become-eligible'])
  test(`${slot}: the sole full Water fee ${mode} and must admit the actual subsequent counter change`, async () => {
    let { g, f, feeId, sourceId, initial, activation, listed } = await setup(slot, mode);
    assert.equal(listed(), true,
      'The unique complete payment makes a following counter placeable; checking unpaid protection/types falsely bans declaration.');
    command(g, activation);
    assert.equal(g.snapshot().pending.kind, 'activation-cost');
    assert.deepEqual(g.snapshot().pending.options, [paymentOptionId(FEE_ID, feeId)]);
    assert(g.snapshot().players[0].hand.includes(feeId), 'Opening a fee prompt cannot prepay.');
    assert.equal(g.snapshot().players[0].active.used.paid, undefined);
    g = restore(g, f);
    answer(g, [paymentOptionId(FEE_ID, feeId)]);
    assert.equal(g.snapshot().pending, null, 'The sole active target receives the fixed total automatically.');
    assert(!g.snapshot().players[0].hand.includes(feeId));
    assert.equal(g.snapshot().players[0].discard.filter((id) => id === feeId).length, 1);
    g = restore(g, f);
    const after = g.snapshot();
    assert.equal(after.players[0].active.counters, initial.players[0].active.counters + 1);
    const receipts = after.events.filter((e) => e.ruleId === 'effects.activation-cost');
    assert.equal(receipts.length, 1);
    assert.deepEqual(receipts[0].data.payment.groups, [{ costId: FEE_ID, cardIds: [feeId] }]);
    const result = after.events.find((e) => e.ruleId === 'damage.counter-distribution' && e.data.kind === 'resolved');
    assert.equal(result.data.placedTotal, 1); assert.equal(result.data.preventedTotal, 0);
    assert.equal(result.data.performed, true);
    if (slot === 'ability') assert.equal(after.players[0].active.used.paid.length, 1);
    else assert.equal(after.players[0].discard.filter((id) => id === sourceId).length, 1);
    assert.deepEqual(after.cards, initial.cards); assert.deepEqual(after.rng, initial.rng);
    restore(g, f);
  });

for (const slot of ['ability', 'trainer']) for (const mode of ['protection-appears', 'types-become-ineligible'])
  test(`${slot}: the sole full Water fee ${mode}; cost disposal alone cannot make declaration usable`, async () => {
    const { g, initial, activation, listed } = await setup(slot, mode);
    assert.equal(listed(), false,
      'Every full payment (exactly one here) leaves zero executable counter change; the fee itself is not the subsequent effect.');
    assert.throws(() => command(g, activation), /not legal|cannot pay|no usable|unsupported.*cost/i);
    assert.deepEqual(g.snapshot(), initial, 'A rejected declaration cannot pay, record a use, move the Trainer or sample RNG.');
  });
