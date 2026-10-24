// Synthetic definitions only. 「在自己的回合，如果这张卡牌在手牌中，且自己的备战区有空位的话，则可使用1次。将这张卡牌直接从手牌使出放于战斗场。
// 在这种情况下，将战斗宝可梦放回备战区。」 (ability.zone-active; JP Q&A メテノ「ほしふり」: this card goes to the Active Spot first, then the
// Active Pokémon goes back to the Bench). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, EVIDENCE, board, command, settle, hand, bench } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const handlers = createCoreHandlers();
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const leaf = (handlerId, parameters) => ({ handlerId, parameters });
const fall = { abilityId: 'other:fall', name: '测试坠星', mode: 'activated', zone: 'hand', sourceOfTruth: EVIDENCE,
  usage: { period: 'turn', scope: 'pokemon', key: 'fall', limit: 1 }, effects: [binding('cn.deploySelf@1', { to: 'active' }, 'fall')] };
// 「当这只宝可梦从战斗场被放回备战区时，可使用1次」 on the Active Pokémon.
const back = { abilityId: 'base:back', name: '测试回场', mode: 'triggered', usage: { period: 'turn', scope: 'pokemon', key: 'base:back', limit: 1 },
  effects: [binding('cn.draw@1', { count: 1 }, 'back')], sourceOfTruth: EVIDENCE,
  trigger: { event: 'movedToBench', subject: 'self', turn: 'own', scope: 'global', choiceOwner: 'source', optional: true } };
const uses = (g, cardId) => g.view(0).legalActions.filter((a) => a.type === 'useAbility' && a.cardId === cardId);

test('schema: 「直接…放于战斗场」 is a zone Ability\'s own placement', () => {
  const valid = (p) => handlers.get('cn.deploySelf@1').validateParameters(p);
  assert(valid({ to: 'active' })); assert(valid({ to: 'active', next: leaf('cn.draw@1', { count: 1 }) }));
  assert(!valid({ to: 'bench' }));
});

test('「将这张卡牌直接从手牌使出放于战斗场。在这种情况下，将战斗宝可梦放回备战区」: Active first, then the Active Pokémon to the Bench', async () => {
  const f = await fixture((defs) => { def(defs, 'other').mechanics.abilities = [fall]; def(defs, 'base').mechanics.abilities = [back]; });
  let card, old;
  const g = board(f, (s) => { card = hand(s, 0, 'other'); old = s.players[0].active; old.conditions.rotation = 'confused'; old.conditions.poison = 1; });
  assert.equal(uses(g, card).length, 1);
  const before = g.snapshot().players[0].hand.length;
  command(g, { type: 'useAbility', cardId: card, abilityId: 'other:fall' });
  assert.equal(g.snapshot().pending.kind, 'trigger-optional', 'The Active Pokémon was put back onto the Bench.');
  restore(g, f);
  settle(g, (q) => q.kind === 'trigger-optional' ? ['perform'] : q.options.slice(0, q.minimum));
  const s = g.snapshot(), p = s.players[0], benched = p.bench.find((m) => m.id === old.id);
  assert.deepEqual(p.active.stack, [card]);
  assert(benched); assert.deepEqual([benched.conditions.rotation, benched.conditions.poison], [null, null]);
  assert.equal(p.hand.length, before - 1 + 1, 'The card left the hand; the trigger drew 1.');
  const deploy = s.events.find((e) => e.ruleId === 'effects.deploy');
  assert.deepEqual([deploy.data.from, deploy.data.to], ['hand', 'active']);
  assert(!s.events.some((e) => e.ruleId === 'trigger.bench'), 'Not put onto the Bench.');
  restore(g, f);
  assert.equal(uses(g, card).length, 0);
});

test('the Active Pokémon\'s effects that end on the Bench end', async () => {
  const guard = binding('cn.lasting@1', { side: 'own', target: 'active', duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true,
    effect: { op: 'protection', channel: 'damage', useRule: 'ordinary', scope: 'all', from: 'opponent', categories: ['attack'] } }, 'guard');
  const f = await fixture((defs) => { def(defs, 'other').mechanics.abilities = [fall]; def(defs, 'potion').mechanics.effects = [guard]; });
  let card, item, old;
  const g = board(f, (s) => { card = hand(s, 0, 'other'); item = hand(s, 0, 'potion'); old = s.players[0].active; });
  command(g, { type: 'playTrainer', cardId: item }); settle(g);
  assert(g.snapshot().ongoing.some((e) => e.targetId === old.id));
  command(g, { type: 'useAbility', cardId: card, abilityId: 'other:fall' }); settle(g);
  assert(!g.snapshot().ongoing.some((e) => e.targetId === old.id));
  restore(g, f);
});

test('a full Bench: the Active Pokémon has nowhere to go, so it cannot be used', async () => {
  const f = await fixture((defs) => { def(defs, 'other').mechanics.abilities = [fall]; def(defs, 'base').deckLimits.sameName = null; });
  for (let i = 0; i < 6; i++) f.deck[f.deck.lastIndexOf('printing:water')] = 'printing:base';
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'other'); for (let i = 0; i < 5; i++) bench(s, 0, 'base'); });
  assert.deepEqual(uses(g, card), []);
  settle(g);
});
