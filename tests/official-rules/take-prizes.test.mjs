// Synthetic definitions only. 「拿取1张自己的奖赏卡」 (prizes.take-effect) and 「这只宝可梦所使用的招式，给对手战斗宝可梦造成的伤害，会因为每张
// 自己已获取的奖赏卡而「+20」」 (perPrizesTaken, II.D-17). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, board, command, answer, settle, hand, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const handlers = createCoreHandlers();
const take = (count) => fixture((defs) => {
  defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.takePrizes@1', { count }, 'take')];
});
const play = (f, mutate = () => {}) => {
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); mutate(s); });
  command(g, { type: 'playTrainer', cardId: card });
  return g;
};

test('「拿取N张自己的奖赏卡」: schema and leaf', () => {
  assert(handlers.get('cn.takePrizes@1').validateParameters({ count: 2 }));
  for (const bad of [{ count: 0 }, { count: 7 }, {}]) assert(!handlers.get('cn.takePrizes@1').validateParameters(bad));
  assert(handlers.get('cn.when@1').validateParameters({ condition: { kind: 'compare', left: { kind: 'zoneCount', side: 'own', zone: 'hand' },
    relation: 'eq', right: { kind: 'literal', value: 30 } }, effect: { handlerId: 'cn.takePrizes@1', parameters: { count: 2 } } }));
});

test('the user picks each Prize card; taking the last one wins after the effect', async () => {
  const f = await take(2);
  let g = play(f);
  const q = g.snapshot().pending;
  assert.equal(q.kind, 'prize'); assert.equal(q.player, 0);
  assert.deepEqual(OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog }).view(0), g.view(0));
  const before = g.snapshot().players[0].hand.length;
  settle(g);
  let s = g.snapshot();
  assert.equal(s.players[0].prizes.length, 4); assert.equal(s.players[0].hand.length, before + 2);
  assert(s.events.some((e) => e.ruleId === 'prizes.take-effect'));
  g = play(f, (s) => { s.players[0].hand.push(...s.players[0].prizes.splice(0, 5)); });
  settle(g);
  s = g.snapshot();
  assert.equal(s.players[0].prizes.length, 0);
  assert.equal(s.result.winner, 0, 'Its user took all of their Prize cards.');
  const none = await take(1);
  g = board(none, (s) => { hand(s, 0, 'potion'); s.players[0].hand.push(...s.players[0].prizes.splice(0)); });
  assert(!g.view(0).legalActions.some((a) => a.type === 'playTrainer' && g.snapshot().cards[a.cardId]?.definitionId === 'potion'),
    'Nothing to take: the Item would change nothing.');
});

test('「会因为每张自己已获取的奖赏卡而「+20」」', async () => {
  const boost = { field: 'attackDamage', amount: 20, scope: 'self', perPrizesTaken: 'own' };
  assert(handlers.get('cn.modifier@1').validateParameters(clone(boost)));
  assert(!handlers.get('cn.modifier@1').validateParameters({ ...boost, field: 'retreat' }));
  const f = await fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.weakness = null;
    defs.find((d) => d.definitionId === 'base').mechanics.effects = [binding('cn.modifier@1', boost, 'boost')];
  });
  const hit = (taken) => {
    const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); s.players[0].hand.push(...s.players[0].prizes.splice(0, taken)); });
    command(g, { type: 'attack', attackId: 'base:strike' });
    return g.snapshot().players[1].active.counters;
  };
  assert.equal(hit(0), 2);
  assert.equal(hit(2), 6, '20 + 2 × 20.');
});
