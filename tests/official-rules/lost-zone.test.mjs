// Synthetic definitions only. 「查看自己牌库上方4张卡牌，选择其中2张卡牌，加入手牌。将剩余的卡牌放于放逐区。」, 「将自己的1张手牌，放于放逐区。」,
// 「选择附着于自己场上宝可梦身上的2个能量，放于放逐区。」 and 「将对手的战斗宝可梦，以及放于其身上的所有卡牌，放于放逐区。」 (zones.lost-zone):
// each card to its owner's Lost Zone, never the discard pile. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const handlers = createCoreHandlers();
const item = (handlerId, parameters) => fixture((defs) => {
  defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding(handlerId, parameters, 'lost')];
});
const play = (f, mutate = () => {}) => {
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); mutate(s); });
  command(g, { type: 'playTrainer', cardId: card });
  return g;
};
const look = { from: 'deck', to: 'hand', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 2 }, reveal: false,
  lookTop: 4, shuffleAfter: false, remainder: 'lost' };

test('Lost Zone destinations: schemas', () => {
  const cards = (p) => handlers.get('cn.cards@1').validateParameters(clone(p));
  assert(cards(look));
  assert(cards({ from: 'hand', to: 'lost', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 1 }, reveal: false, lookTop: null, shuffleAfter: false }));
  // 「查看对手牌库上方1张卡牌…若希望，则可将其放于放逐区」: a looked-at deck card to the Lost Zone; never with a remainder.
  assert(cards({ from: 'deck', to: 'lost', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 1 }, reveal: false, lookTop: 3, shuffleAfter: false }));
  assert(!cards({ from: 'deck', to: 'lost', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 1 }, reveal: false, lookTop: 3, shuffleAfter: false,
    remainder: 'discard' }));
});

test('「将剩余的卡牌放于放逐区」 and a hand card put in the Lost Zone', async () => {
  let g = play(await item('cn.cards@1', look));
  const top = g.snapshot().players[0].deck.slice(-4);
  answer(g, g.snapshot().pending.options.slice(0, 2)); settle(g);
  let s = g.snapshot();
  assert.equal(s.players[0].lost.length, 2);
  assert(s.players[0].lost.every((id) => top.includes(id)));
  assert.equal(s.players[0].discard.filter((id) => s.cards[id].definitionId !== 'potion').length, 0);
  assert(s.events.some((e) => e.ruleId === 'zones.lost-zone'));
  const f = await item('cn.cards@1', { from: 'hand', to: 'lost', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 1 },
    reveal: false, lookTop: null, shuffleAfter: false });
  g = play(f, (s) => hand(s, 0, 'research'));
  const chosen = g.snapshot().pending.options[0];
  answer(g, [chosen]); settle(g);
  s = g.snapshot();
  assert.deepEqual(s.players[0].lost, [chosen]);
  assert.deepEqual(OfficialGame.restore(clone(s), { catalog: f.catalog }).snapshot(), s);
});

test('attached Energy and a whole Pokémon with its cards go to their owners\' Lost Zones', async () => {
  const energy = { op: 'returnEnergy', side: 'own', from: 'any', selector: { kind: 'energy' }, providedTypes: null, measure: 'units',
    quantity: { kind: 'exact', count: 2 }, chooser: 'source', to: 'lost' };
  assert(handlers.get('cn.attachedEnergy@1').validateParameters(clone(energy)));
  let g = play(await item('cn.attachedEnergy@1', energy), (s) => {
    attached(s, 0, s.players[0].active, 'water'); attached(s, 0, s.players[0].active, 'water');
  });
  settle(g, (q) => q.options.slice(0, 2));
  let s = g.snapshot();
  assert.equal(s.players[0].lost.length, 2); assert.equal(s.players[0].active.energy.length, 0);
  const banish = { op: 'returnPokemon', side: 'opponent', target: 'active', selector: { kind: 'pokemon' }, quantity: { kind: 'exact', count: 1 },
    to: 'lost', attachments: 'return', chooser: 'source', promotion: { timing: 'afterRelatedResolution', sourceOfTruth: EVIDENCE } };
  assert(handlers.get('cn.fieldReturn@1').validateParameters(clone(banish)));
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'base').mechanics.attacks.push({ attackId: 'base:lost', name: '测试放逐', cost: ['Water'],
      printedDamage: null, effects: [binding('cn.fieldReturn@1', banish, 'banish')], sourceOfTruth: EVIDENCE });
  });
  let gone;
  g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water'); attached(s, 1, s.players[1].active, 'water'); bench(s, 1, 'other');
    gone = [...s.players[1].active.stack, ...s.players[1].active.energy];
  });
  command(g, { type: 'attack', attackId: 'base:lost' }); settle(g);
  s = g.snapshot();
  assert.deepEqual([...s.players[1].lost].sort(), [...gone].sort());
  assert.equal(s.players[0].prizes.length, 6, 'Not a Knock Out.');
  assert.notEqual(s.players[1].active, null, 'Its holder replaced it.');
});
