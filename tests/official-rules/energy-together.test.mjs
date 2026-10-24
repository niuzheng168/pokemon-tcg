// Synthetic definitions only. Shape follows printed CN text: 西狮海壬 「和声 只要这只宝可梦在场上，当从手牌将能量附着于自己的宝可梦身上时，可以同时
// 最多附着2张。（因招式、「和声」以外的特性、训练家而附着能量的情况除外。）」 (turn.energy-together), with 「当要将这张卡牌，从手牌附着于宝可梦身上时，
// 必须将自己的1张手牌放于弃牌区」 and 「每当对手从手牌将能量附着于宝可梦身上时，给那只宝可梦身上放置2个伤害指示物」. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, assertSupportedDefinition } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const rule = { effect: { op: 'attachRule', scope: 'own', together: 2 } };
const harmony = binding('cn.attachRule@1', rule, 'harmony');
const ability = (abilityId, mode, effects, extra = {}) => ({ abilityId, name: '测试特性', mode, usage: null, effects, sourceOfTruth: EVIDENCE, ...extra });
// 'other' has the Ability; 'double' is a Special Energy.
const singer = (defs) => { def(defs, 'other').mechanics.abilities = [ability('harmony', 'continuous', [harmony])]; };
const joint = (g) => g.view(0).legalActions.filter((a) => a.type === 'attachEnergy' && a.jointCardIds);
// The hand holds only the cards a test puts there (the others go back into the deck).
const empty = (s) => { const p = s.players[0]; p.deck.push(...p.hand); p.hand = []; };
const energyOf = (g, id) => { const p = g.snapshot().players[0]; return [p.active, ...p.bench].find((m) => m.id === id).energy; };

test('turn.energy-together: a continuous Ability of a Pokémon only, attaching exactly 2 together', async () => {
  const v = createCoreHandlers().get('cn.attachRule@1').validateParameters;
  assert(v(rule));
  assert(!v({ effect: { ...rule.effect, together: 3 } })); assert(!v({ effect: { ...rule.effect, scope: 'opponent' } }));
  const f = await fixture((defs) => { singer(defs); def(defs, 'tool').mechanics.effects = [harmony]; });
  assert.doesNotThrow(() => assertSupportedDefinition(f.catalog, f.catalog.definition('other')));
  assert.throws(() => assertSupportedDefinition(f.catalog, f.catalog.definition('tool')), /continuous Ability/);
});

test('「可以同时最多附着2张」: two Energy cards from the hand onto one Pokémon at once, as the turn\'s one attachment', async () => {
  const f = await fixture(singer);
  let me, singerMon, cards, special;
  const plain = board(f, (s) => { hand(s, 0, 'water'); hand(s, 0, 'water'); });
  assert.equal(joint(plain).length, 0, 'Not without the Ability.');
  const g = board(f, (s) => {
    me = s.players[0].active; singerMon = bench(s, 0, 'other');
    empty(s); cards = [hand(s, 0, 'water'), hand(s, 0, 'water'), hand(s, 0, 'water')]; special = hand(s, 0, 'double');
  });
  // One offer per pair of card kinds (the first card of each kind in the hand), on each of the player's Pokémon.
  assert.deepEqual(joint(g).map((a) => [a.cardId, a.jointCardIds[0], a.pokemonId]), [
    [cards[0], cards[1], me.id], [cards[0], cards[1], singerMon.id], [cards[0], special, me.id], [cards[0], special, singerMon.id]]);
  command(g, { type: 'attachEnergy', cardId: cards[0], pokemonId: me.id, jointCardIds: [special] }); settle(g);
  assert.deepEqual(energyOf(g, me.id), [cards[0], special]);
  assert(!g.view(0).legalActions.some((a) => a.type === 'attachEnergy'), 'It was the turn\'s attachment.');
  const log = g.snapshot().events.filter((e) => e.ruleId === 'turn.energy').at(-1).data;
  assert.deepEqual(log.jointCardIds, [special]);
  restore(g, f);
});

test('turn.energy-together: each card is judged as it would be alone, on the board before either is attached (JP Q&A アシレーヌ×カクレオン)', async () => {
  const f = await fixture((defs) => {
    singer(defs);
    def(defs, 'double').mechanics.handAttachTo = { kind: 'pokemon', stages: ['stage1'] };
    def(defs, 'double').mechanics.remainOn = { kind: 'pokemon', stages: ['stage1'] };
  });
  let me, grown, water, special;
  const g = board(f, (s) => {
    me = s.players[0].active; bench(s, 0, 'other'); grown = bench(s, 0, 'evolution');
    empty(s); water = hand(s, 0, 'water'); special = hand(s, 0, 'double');
  });
  const offers = joint(g).filter((a) => a.cardId === water && a.jointCardIds[0] === special).map((a) => a.pokemonId);
  assert.deepEqual(offers, [grown.id], 'Only where the Special Energy may go from the hand.');
  // 「对手无法从手牌使出并附着特殊能量」: not that card, still a pair of Basic Energy.
  const l = await fixture((defs) => {
    singer(defs);
    def(defs, 'base').mechanics.abilities = [ability('lock', 'continuous', [binding('cn.playerRestriction@1',
      { effect: { op: 'playerRestriction', scope: 'opponent', actions: ['attachSpecialEnergy'] } }, 'lock')])];
  });
  const locked = board(l, (s) => {
    bench(s, 0, 'other'); empty(s); hand(s, 0, 'water'); hand(s, 0, 'water'); special = hand(s, 0, 'double');
  });
  assert(!joint(locked).some((a) => a.jointCardIds[0] === special || a.cardId === special));
  assert(joint(locked).length > 0);
});

test('「必须将自己的1张手牌放于弃牌区」 per card and 「每当…附着能量时」 per card (JP Q&A オーロラエネルギー／ガラル サニゴーンV)', async () => {
  const f = await fixture((defs) => {
    singer(defs);
    def(defs, 'double').mechanics.attachCosts = [{ costId: 'double:attach', kind: 'discardHand', count: 1, selector: { kind: 'any' }, sourceOfTruth: EVIDENCE }];
    def(defs, 'base').mechanics.abilities = [ability('curse', 'triggered', [binding('cn.counters@1', { side: 'opponent', target: 'event', count: 2 }, 'curse')],
      { trigger: { event: 'energyAttached', subject: 'opponent', origin: 'hand', optional: false, choiceOwner: 'source', scope: 'subject' } })];
  });
  f.deck.splice(20, 1, 'printing:double');
  let me, pair, fee;
  const g = board(f, (s) => {
    me = s.players[0].active; bench(s, 0, 'other');
    empty(s); pair = [hand(s, 0, 'double'), hand(s, 0, 'double')]; fee = [hand(s, 0, 'potion'), hand(s, 0, 'poison')];
  });
  command(g, { type: 'attachEnergy', cardId: pair[0], pokemonId: me.id, jointCardIds: [pair[1]] });
  const q = g.snapshot().pending;
  assert.equal(q.kind, 'activation-cost'); assert.equal(q.minimum, 2);
  answer(g, [JSON.stringify(['double:attach', fee[0]]), JSON.stringify(['double:attach/together', fee[1]])]);
  settle(g);
  const s = g.snapshot();
  assert.deepEqual(energyOf(g, me.id), pair);
  assert(fee.every((id) => s.players[0].discard.includes(id)));
  const receipts = s.events.filter((e) => e.ruleId === 'effects.activation-cost').slice(-2).map((e) => e.data.payment);
  assert.deepEqual(receipts.map((r) => [r.sourceId, r.groups]), [[pair[0], [{ costId: 'double:attach', cardIds: [fee[0]] }]],
    [pair[1], [{ costId: 'double:attach', cardIds: [fee[1]] }]]]);
  assert.equal(s.players[0].active.counters, 4, 'Two cards attached: the opponent\'s trigger twice.');
  restore(g, f);
  // With a Basic Energy, only the Special Energy pays.
  let water;
  const h = board(f, (s) => {
    me = s.players[0].active; bench(s, 0, 'other');
    empty(s); pair = [hand(s, 0, 'double')]; water = hand(s, 0, 'water'); fee = [hand(s, 0, 'potion')];
  });
  const offer = joint(h).find((a) => a.pokemonId === me.id);
  assert.deepEqual([offer.cardId, offer.jointCardIds], [pair[0], [water]]);
  command(h, offer); answer(h, [JSON.stringify(['double:attach', fee[0]])]); settle(h);
  const paid = h.snapshot().events.filter((e) => e.ruleId === 'effects.activation-cost').at(-1).data.payment;
  assert.deepEqual([paid.sourceId, paid.groups], [pair[0], [{ costId: 'double:attach', cardIds: [fee[0]] }]]);
  assert.equal(h.snapshot().players[0].active.counters, 4);
});
