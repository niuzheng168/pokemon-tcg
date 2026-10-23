// Synthetic definitions only. Abilities used while the card itself is in hand or the discard pile (ability.zone):
// 「如果这张卡牌在弃牌区的话，则在自己的回合可以使用1次。将这张卡牌放于备战区。然后，给这只宝可梦身上放置3个伤害指示物」
// 「在自己的回合，如果这张卡牌在手牌中，自己的剩余奖赏卡张数，比对手的剩余奖赏卡张数多的话，则可以使用1次。将这张卡牌放于备战区」.
// No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, EVIDENCE, board, command, settle, hand, bench } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const handlers = createCoreHandlers();
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const leaf = (handlerId, parameters) => ({ handlerId, parameters });
const usage = { period: 'turn', scope: 'pokemon', key: 'rise', limit: 1 };
const ability = (zone, effects, extra = {}) => ({ abilityId: 'other:rise', name: '测试复苏', mode: 'activated', zone, usage, effects,
  sourceOfTruth: EVIDENCE, ...extra });
const withAbility = (...args) => fixture((defs) => { def(defs, 'other').mechanics.abilities = [ability(...args)]; });
const toDiscard = (s, owner, id) => { const card = hand(s, owner, id); s.players[owner].hand.pop(); s.players[owner].discard.push(card); return card; };
const uses = (g, cardId) => g.view(0).legalActions.filter((a) => a.type === 'useAbility' && a.cardId === cardId);

test('schema: a zone Ability is activated, counted, and has no sourceActive, costs or VSTAR', async () => {
  const valid = (p) => handlers.get('cn.deploySelf@1').validateParameters(p);
  assert(valid({})); assert(valid({ next: leaf('cn.draw@1', { count: 3 }) }));
  assert(valid({ next: leaf('cn.coin@1', { outcome: 'heads', effect: leaf('cn.draw@1', { count: 1 }) }) }));
  assert(!valid({ next: leaf('cn.deploySelf@1', {}) })); assert(!valid({ next: leaf('cn.coin@1', { outcome: 'heads' }) }));
  for (const bad of [{ mode: 'continuous' }, { usage: null }, { condition: { sourceActive: true } }, { specialRule: 'VSTAR' }]) {
    await assert.rejects(fixture((defs) => { def(defs, 'other').mechanics.abilities = [ability('discard', [binding('cn.deploySelf@1', {}, 'rise')], bad)]; }),
      undefined, JSON.stringify(bad));
  }
  // deploySelf only in a zone Ability.
  await assert.rejects(fixture((defs) => { def(defs, 'other').mechanics.abilities = [{ ...ability('discard', [binding('cn.deploySelf@1', {}, 'rise')]), zone: undefined }]; }));
});

test('「如果这张卡牌在弃牌区的话…将这张卡牌放于备战区。然后，给这只宝可梦身上放置3个伤害指示物」', async () => {
  const f = await withAbility('discard', [binding('cn.deploySelf@1', { next: leaf('cn.counters@1', { side: 'own', target: 'self', count: 3 }) }, 'rise')]);
  let card;
  const g = board(f, (s) => { card = toDiscard(s, 0, 'other'); });
  assert.deepEqual(uses(g, card), [{ type: 'useAbility', cardId: card, abilityId: 'other:rise' }]);
  command(g, { type: 'useAbility', cardId: card, abilityId: 'other:rise' }); settle(g);
  const s = g.snapshot(), m = s.players[0].bench.find((x) => x.stack[0] === card);
  assert(m, 'On the Bench.'); assert.equal(m.counters, 3, '「这只宝可梦」 is the Pokémon it became.');
  assert(!s.players[0].discard.includes(card));
  assert(s.events.some((e) => e.ruleId === 'effects.deploy' && e.data.from === 'discard' && e.data.pokemonId === m.id));
  assert.deepEqual(restore(g, f).snapshot(), s);
  assert.deepEqual(uses(g, card), [], 'No longer in the discard pile.');
  // A full Bench: nothing to do, so it cannot be used; in hand it is not this Ability.
  const crowded = await fixture((defs) => {
    def(defs, 'other').mechanics.abilities = [ability('discard', [binding('cn.deploySelf@1', {}, 'rise')])];
    def(defs, 'base').deckLimits.sameName = null;
  });
  for (let i = 0; i < 6; i++) crowded.deck[crowded.deck.lastIndexOf('printing:water')] = 'printing:base';
  const full = board(crowded, (s) => { card = toDiscard(s, 0, 'other'); for (let i = 0; i < 5; i++) bench(s, 0, 'base'); });
  assert.deepEqual(uses(full, card), []);
  const held = board(f, (s) => { card = hand(s, 0, 'other'); });
  assert.deepEqual(uses(held, card), []);
});

test('「在自己的回合，如果这张卡牌在手牌中，…剩余奖赏卡…多的话」: the condition, once per turn per card, then 「抽取3张」', async () => {
  const f = await withAbility('hand', [binding('cn.deploySelf@1', { next: leaf('cn.draw@1', { count: 3 }) }, 'rise')],
    { condition: { prizesRemaining: 'moreThanOpponent' } });
  let card;
  const behind = (s) => { const p = s.players[1]; p.discard.push(p.prizes.pop()); };
  let g = board(f, (s) => { card = hand(s, 0, 'other'); });
  assert.deepEqual(uses(g, card), [], 'Equal Prizes.');
  g = board(f, (s) => { card = hand(s, 0, 'other'); behind(s); });
  const before = g.snapshot().players[0].hand.length;
  command(g, { type: 'useAbility', cardId: card, abilityId: 'other:rise' }); settle(g);
  const s = g.snapshot();
  assert(s.players[0].bench.some((m) => m.stack[0] === card));
  assert.equal(s.players[0].hand.length, before - 1 + 3);
  assert(s.events.some((e) => e.ruleId === 'ability.usage' && e.data.cardId === card && e.data.zone === 'hand'));
  assert.deepEqual(Object.keys(s.players[0].used), [`rise@${card}`]);
  // Turn-player only: not on the opponent's turn.
  const other = board(f, (s) => { card = hand(s, 1, 'other'); s.players[0].discard.push(s.players[0].prizes.pop()); });
  assert(!other.view(1).legalActions.some((a) => a.type === 'useAbility'));
});

test('「将这张卡牌放于备战区」 alone, and a player-wide shared limit', async () => {
  const f = await fixture((defs) => {
    def(defs, 'other').mechanics.abilities = [ability('discard', [binding('cn.deploySelf@1', {}, 'rise')],
      { usage: { ...usage, scope: 'player' } })];
    def(defs, 'other').deckLimits.sameName = null;
  });
  f.deck[f.deck.lastIndexOf('printing:water')] = 'printing:other';
  let a, b;
  const g = board(f, (s) => { a = toDiscard(s, 0, 'other'); b = toDiscard(s, 0, 'other'); });
  assert.equal(uses(g, a).length + uses(g, b).length, 2);
  command(g, { type: 'useAbility', cardId: a, abilityId: 'other:rise' }); settle(g);
  assert.deepEqual(uses(g, b), [], 'The same-name limit is the player\'s.');
});

test('「…放于备战区。然后，将自己弃牌区中的1张【水】能量，附着于这张卡牌身上」, and 「如果使用了的话，则自己的回合结束」', async () => {
  const f = await withAbility('discard', [binding('cn.deploySelf@1', { next: leaf('cn.attachDiscard@1',
    { type: 'Water', count: 1, benchOnly: false, optional: false, target: 'self' }) }, 'rise')], { endsTurn: true });
  let card, water;
  const g = board(f, (s) => { card = toDiscard(s, 0, 'other'); water = toDiscard(s, 0, 'water'); });
  command(g, { type: 'useAbility', cardId: card, abilityId: 'other:rise' }); settle(g);
  const s = g.snapshot(), m = s.players[0].bench.find((x) => x.stack[0] === card);
  assert.deepEqual(m.energy, [water]);
  assert.equal(s.current, 1, 'The turn ended.');
  assert.deepEqual(restore(g, f).snapshot(), s);
});

test('「将这张卡牌放于备战区。然后，抛掷1次硬币如果为正面，则…」: the coin only after the card was placed', async () => {
  const f = await withAbility('hand', [binding('cn.deploySelf@1', { next: leaf('cn.coin@1', { outcome: 'heads', effect: leaf('cn.draw@1', { count: 1 }) }) }, 'rise')]);
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'other'); });
  command(g, { type: 'useAbility', cardId: card, abilityId: 'other:rise' }); settle(g);
  const s = g.snapshot();
  assert(s.players[0].bench.some((m) => m.stack[0] === card));
  const flips = s.events.filter((e) => e.ruleId === 'effects.coin');
  assert.equal(flips.length, 1);
  assert(s.events.indexOf(flips[0]) > s.events.findIndex((e) => e.ruleId === 'effects.deploy'), 'Flipped after the placement.');
});
