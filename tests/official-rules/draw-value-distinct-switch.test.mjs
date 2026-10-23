// Synthetic definitions only. 「将自己的手牌全部放回牌库并重洗牌库。然后，抽取与对手的手牌相同张数／数过自己的手牌之后…与放回牌库的张数
// 相同数量／如果…的话，则抽取的张数变为N张」 (a computed draw count), 「选择自己最多2只备战宝可梦，各附着1张牌库中的基本能量」 (distinct
// recipients) and 「将自己战斗场上的【基础】宝可梦与备战宝可梦互换。然后，回复被换入备战区的宝可梦「30」点HP」. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, board, command, answer, settle, hand, bench } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const handlers = createCoreHandlers();
const lit = (value) => ({ kind: 'literal', value });
const zone = (side, zone) => ({ kind: 'zoneCount', side, zone });
const item = (handlerId, parameters) => fixture((defs) => {
  defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding(handlerId, parameters, 'item')];
});
const playable = (g, card) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card);

test('handDeckDraw: a computed count, read before the hand goes back', async () => {
  const draw = (value, extra = {}) => ({ side: 'own', ownDraw: { kind: 'value', value }, opponentDraw: 0, ...extra });
  const valid = (p) => handlers.get('cn.handDeckDraw@1').validateParameters(clone(p));
  assert(valid(draw(zone('opponent', 'hand'))));
  assert(handlers.get('cn.handBottomDraw@1').validateParameters(draw(zone('own', 'hand'))));
  assert(!valid({ side: 'own', ownDraw: { kind: 'value' }, opponentDraw: 0 }));
  assert(!valid(draw(zone('opponent', 'hand'), { ownDraw: { kind: 'value', value: lit(3), extra: 1 } })));
  const run = async (parameters, mutate = () => {}) => {
    const f = await item('cn.handDeckDraw@1', parameters);
    let card;
    const g = board(f, (s) => { card = hand(s, 0, 'potion'); mutate(s); });
    const before = g.snapshot();
    OfficialGame.restore(clone(before), { catalog: f.catalog });
    command(g, { type: 'playTrainer', cardId: card }); settle(g);
    return { before, after: g.snapshot() };
  };
  // 「从自己的牌库上方抽取与对手的手牌相同张数的卡牌」
  let { before, after } = await run(draw(zone('opponent', 'hand')));
  assert(before.players[1].hand.length > 0);
  assert.equal(after.players[0].hand.length, before.players[1].hand.length);
  // 「数过自己的手牌之后…抽取与放回牌库的张数相同数量」: the played card is not among them.
  ({ before, after } = await run(draw(zone('own', 'hand'))));
  assert.equal(after.players[0].hand.length, before.players[0].hand.length - 1);
  // 「抽取4张卡牌。如果对手的剩余奖赏卡张数在3张及以下的话，则抽取的张数变为8张」
  const prizes = draw({ kind: 'choose', condition: { kind: 'compare', left: zone('opponent', 'prizes'), relation: 'lte', right: lit(3) },
    ifTrue: lit(8), ifFalse: lit(4) });
  assert.equal((await run(prizes)).after.players[0].hand.length, 4);
  ({ after } = await run(prizes, (s) => { s.players[1].deck.push(...s.players[1].prizes.splice(0, 3)); }));
  assert.equal(after.players[0].hand.length, 8);
  // Both players: each draws what that player returned.
  ({ before, after } = await run(draw(zone('own', 'hand'), { side: 'both', opponentDraw: { kind: 'value', value: zone('opponent', 'hand') } })));
  assert.equal(after.players[1].hand.length, before.players[1].hand.length);
});

test('attachDeckEnergy distinctRecipients: 「选择自己最多2只备战宝可梦，各附着1张」 never two to one Pokémon', async () => {
  const parameters = { op: 'attachDeckEnergy', lookTop: null, selector: { kind: 'energy', category: 'basic', types: ['Water'] },
    quantity: { kind: 'upTo', count: 2 }, recipient: { position: 'bench', selector: { kind: 'pokemon' } },
    distribution: 'distinctRecipients', remainder: 'shuffleDeck', reveal: false };
  assert(handlers.get('cn.attachDeckEnergy@1').validateParameters(parameters));
  assert(!handlers.get('cn.attachDeckEnergy@1').validateParameters({ ...parameters, distribution: 'distinct' }));
  const f = await item('cn.attachDeckEnergy@1', parameters);
  const run = (benched) => {
    let card, mons;
    const g = board(f, (s) => { card = hand(s, 0, 'potion'); mons = benched.map((id) => bench(s, 0, id)); });
    command(g, { type: 'playTrainer', cardId: card });
    return { g, mons };
  };
  let { g, mons } = run(['other', 'other']);
  let q = g.snapshot().pending;
  assert.equal(q.kind, 'inspect-deck'); assert.equal(q.maximum, 2);
  answer(g, q.options.slice(0, 2));
  assert.deepEqual([...g.snapshot().pending.options].sort(), mons.map((m) => m.id).sort());
  answer(g, [mons[0].id]);
  OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(g.snapshot().pending.options, [mons[1].id], 'The second card goes to the other Pokémon.');
  answer(g, [mons[1].id]); settle(g);
  assert(g.snapshot().players[0].bench.every((m) => m.energy.length === 1));
  ({ g } = run(['other']));
  q = g.snapshot().pending;
  assert.equal(q.maximum, 1, 'One Benched Pokémon takes one card.');
});

test('switch: 「将自己战斗场上的【基础】宝可梦与备战宝可梦互换。然后，回复被换入备战区的宝可梦「30」点HP」', async () => {
  const parameters = { side: 'own', chooser: 'self', affected: 'active', activeSelector: { kind: 'pokemon', stages: ['basic'] }, outgoingHeal: 30 };
  const valid = (p) => handlers.get('cn.switch@1').validateParameters(clone(p));
  assert(valid(parameters));
  assert(!valid({ ...parameters, side: 'opponent' }), 'Only the user\'s own Pokémon is healed.');
  assert(!valid({ ...parameters, outgoingHeal: 25 }));
  const f = await item('cn.switch@1', parameters);
  let card, other;
  let g = board(f, (s) => { card = hand(s, 0, 'potion'); other = bench(s, 0, 'other'); s.players[0].active.counters = 5; });
  const outgoing = g.snapshot().players[0].active.id;
  command(g, { type: 'playTrainer', cardId: card }); settle(g);
  let p = g.snapshot().players[0];
  assert.equal(p.active.id, other.id);
  assert.equal(p.bench.find((m) => m.id === outgoing).counters, 2);
  assert(g.snapshot().events.some((e) => e.ruleId === 'effects.heal' && e.data.targetId === outgoing));
  g = board(f, (s) => {
    card = hand(s, 0, 'potion'); bench(s, 0, 'other');
    const evolution = hand(s, 0, 'evolution'); s.players[0].hand.pop(); s.players[0].active.stack.push(evolution);
  });
  assert(!playable(g, card), 'The Active Pokémon is not a Basic Pokémon.');
  const plain = await item('cn.switch@1', { side: 'own', chooser: 'self', affected: 'active', outgoingHeal: 30 });
  g = board(plain, (s) => { card = hand(s, 0, 'potion'); bench(s, 0, 'other'); });
  command(g, { type: 'playTrainer', cardId: card }); settle(g);
  p = g.snapshot().players[0];
  assert.equal(p.bench[0].counters, 0);
  assert(!g.snapshot().events.some((e) => e.ruleId === 'effects.heal'), 'Nothing to heal.');
});
