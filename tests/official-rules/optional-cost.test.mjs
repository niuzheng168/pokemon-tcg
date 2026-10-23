// Synthetic definitions only. 「另外，当使用这张卡牌时，可将N张自己的手牌放于弃牌区。在这种情况下，…」 (effects.optional-cost; JP official Q&A on
// the TAG TEAM Supporters: the discard is chosen when the card is played, before its effects; it may be made only when the paid part could change
// something). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { paymentOptionId } from '../../public/rules/activation-cost.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const leaf = (handlerId, parameters) => ({ handlerId, parameters });
const handlers = createCoreHandlers();
const cost = (count) => ({ costId: 'extra', kind: 'discardHand', count, selector: { kind: 'any' }, sourceOfTruth: EVIDENCE });
const recover = { from: 'discard', to: 'hand', selector: { kind: 'trainer', categories: ['supporter'], excludeNameKeys: ['research'] },
  quantity: { kind: 'exact', count: 1 }, reveal: true, lookTop: null, shuffleAfter: false, excludePaid: true };
const switchOwn = { side: 'own', chooser: 'self', affected: 'active' };
// 'research' is the TAG TEAM Supporter; 'potion' is made a Supporter to be recovered.
const supporter = (effects, count = 1) => fixture((defs) => {
  const d = defs.find((d) => d.definitionId === 'research');
  d.mechanics.effects = effects; d.mechanics.optionalPlayCosts = [cost(count)];
  defs.find((d) => d.definitionId === 'potion').mechanics.category = 'supporter';
});
const setHand = (s, ids) => {
  const p = s.players[0]; p.discard.push(...p.hand.splice(0));
  return ids.map((id) => hand(s, 0, id));
};
const toDiscard = (s, id) => { const card = hand(s, 0, id); s.players[0].hand.pop(); s.players[0].discard.push(card); return card; };
const playable = (g, card) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card);
const caitlin = () => supporter([binding('cn.cards@1', recover, 'recover'), binding('cn.ifPaid@1', { effect: leaf('cn.draw@1', { count: 3 }) }, 'draw')]);

test('schema and placement', async () => {
  const valid = handlers.get('cn.ifPaid@1').validateParameters;
  assert(valid({ effect: leaf('cn.draw@1', { count: 3 }) }));
  assert(valid({ effects: [leaf('cn.draw@1', { count: 1 }), leaf('cn.draw@1', { count: 2 })] }));
  assert(valid({ effect: leaf('cn.switch@1', { ...switchOwn, outgoingHeal: 120 }), otherwise: leaf('cn.switch@1', switchOwn) }));
  assert(!valid({ effect: leaf('cn.switch@1', switchOwn), otherwise: leaf('cn.switch@1', switchOwn) }));
  assert(!valid({ effect: leaf('cn.draw@1', { count: 3 }), otherwise: leaf('cn.draw@1', { count: 1 }) }));
  assert(!valid({ effect: leaf('cn.switch@1', { ...switchOwn, outgoingHeal: 120 }), otherwise: leaf('cn.switch@1', { ...switchOwn, chooser: 'opponent' }) }));
  assert(!valid({ effect: leaf('cn.draw@1', { count: 0 }) }));
  const paid = binding('cn.ifPaid@1', { effect: leaf('cn.draw@1', { count: 3 }) }, 'paid');
  for (const transform of [
    (defs) => { defs.find((d) => d.definitionId === 'potion').mechanics.effects = [paid]; },
    (defs) => { const d = defs.find((d) => d.definitionId === 'potion'); d.mechanics.optionalPlayCosts = [cost(1)]; },
    (defs) => { const d = defs.find((d) => d.definitionId === 'tool'); d.mechanics.effects = [paid]; d.mechanics.optionalPlayCosts = [cost(1)]; },
    (defs) => { const d = defs.find((d) => d.definitionId === 'potion'); d.mechanics.effects = [paid]; d.mechanics.optionalPlayCosts = [cost(1)];
      d.mechanics.playCosts = [cost(1)]; },
    (defs) => { defs.find((d) => d.definitionId === 'base').mechanics.attacks[0].effects = [paid]; },
  ]) {
    const f = await fixture(transform);
    assert.throws(() => board(f), /optional play cost/);
  }
});

test('the optional discard comes first; declining plays only the other part', async () => {
  const f = await caitlin();
  let ids;
  const g = board(f, (s) => { ids = setHand(s, ['research', 'water', 'water']); toDiscard(s, 'potion'); });
  assert(playable(g, ids[0]));
  command(g, { type: 'playTrainer', cardId: ids[0] });
  const q = g.snapshot().pending, view = g.view(0).pending;
  assert.equal(q.kind, 'activation-cost'); assert.equal(q.minimum, 1); assert.equal(q.maximum, 1); assert.equal(q.allowZero, true);
  assert.equal(view.payment.optional, true);
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  const declined = restore(g, f);
  answer(declined, []); settle(declined);
  let p = declined.snapshot().players[0];
  assert.equal(p.hand.length, 3, 'Two waters and the recovered Supporter; nothing drawn.');
  assert(declined.snapshot().events.some((e) => e.ruleId === 'effects.optional-cost' && e.data.paid === false));
  answer(g, [paymentOptionId('extra', ids[1])]); settle(g);
  p = g.snapshot().players[0];
  assert(p.discard.includes(ids[1])); assert.equal(p.hand.length, 1 + 1 + 3, 'One water, the Supporter, three drawn.');
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
});

test('a card discarded for it is not recovered; with nothing else to do the discard is required', async () => {
  const f = await caitlin();
  let ids;
  const g = board(f, (s) => { ids = setHand(s, ['research', 'potion']); });
  command(g, { type: 'playTrainer', cardId: ids[0] });
  const q = g.snapshot().pending;
  assert.equal(q.allowZero, false, 'No Supporter in the discard pile: only the paid draw changes something.');
  assert.throws(() => answer(g, []), /Invalid selection/);
  answer(g, [paymentOptionId('extra', ids[1])]); settle(g);
  const p = g.snapshot().players[0];
  assert(p.discard.includes(ids[1]), 'The discarded Supporter stays in the discard pile.'); assert.equal(p.hand.length, 3);
  // An empty deck: the paid draw could do nothing, so nothing may be discarded and nothing can be played.
  const empty = board(f, (s) => { ids = setHand(s, ['research', 'potion']); s.players[0].discard.push(...s.players[0].deck.splice(0)); });
  assert(!playable(empty, ids[0]));
  // With a Supporter to recover and an empty deck: played at once, without a choice to discard.
  const direct = board(f, (s) => { ids = setHand(s, ['research', 'water']); toDiscard(s, 'potion'); s.players[0].discard.push(...s.players[0].deck.splice(0)); });
  command(direct, { type: 'playTrainer', cardId: ids[0] });
  assert.notEqual(direct.snapshot().pending?.kind, 'activation-cost');
  settle(direct);
  assert(direct.snapshot().players[0].hand.includes(ids[1]));
});

test('「回复被换到备战区的宝可梦」 only when paid, and only a damaged Active makes paying possible', async () => {
  const f = await supporter([binding('cn.ifPaid@1', { effect: leaf('cn.switch@1', { ...switchOwn, outgoingHeal: 120 }),
    otherwise: leaf('cn.switch@1', switchOwn) }, 'switch')], 2);
  let ids;
  const setup = (counters, benched = true) => board(f, (s) => {
    ids = setHand(s, ['research', 'water', 'water']); s.players[0].active.counters = counters; if (benched) bench(s, 0, 'other');
  });
  let g = setup(5);
  const old = g.snapshot().players[0].active.id;
  command(g, { type: 'playTrainer', cardId: ids[0] });
  assert.equal(g.snapshot().pending.allowZero, true);
  answer(g, ids.slice(1).map((id) => paymentOptionId('extra', id))); settle(g);
  let p = g.snapshot().players[0];
  assert.equal(p.bench.find((m) => m.id === old).counters, 0); assert.notEqual(p.active.id, old);
  g = setup(5);
  command(g, { type: 'playTrainer', cardId: ids[0] }); answer(g, []); settle(g);
  p = g.snapshot().players[0];
  assert.equal(p.bench.find((m) => m.id === old).counters, 5, 'Declined: switched, not healed.');
  g = setup(0);
  command(g, { type: 'playTrainer', cardId: ids[0] });
  assert.notEqual(g.snapshot().pending?.kind, 'activation-cost', 'Full HP: no discard offered.');
  assert(!playable(setup(5, false), ids[0]), 'No Benched Pokémon: cannot be played.');
});

test('several paid parts run in order', async () => {
  const f = await supporter([binding('cn.draw@1', { count: 1 }, 'draw'),
    binding('cn.ifPaid@1', { effects: [leaf('cn.draw@1', { count: 1 }), leaf('cn.draw@1', { count: 2 })] }, 'more')], 2);
  let ids;
  const g = board(f, (s) => { ids = setHand(s, ['research', 'water', 'water']); });
  command(g, { type: 'playTrainer', cardId: ids[0] });
  answer(g, ids.slice(1).map((id) => paymentOptionId('extra', id))); settle(g);
  assert.equal(g.snapshot().players[0].hand.length, 1 + 1 + 2);
});
