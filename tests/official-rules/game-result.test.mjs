// Synthetic definitions only. II.E-38 「使用这个招式时，如果自己的剩余奖赏卡张数为1张的话，则这场对战算作自己的胜利」
// 「…如果自己的手牌张数达到35张以上（包含35张）的话，则这场对战算做自己的胜利」「如果全部为反面，则这场对战己方败北」 (win.effect).
// No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, board, command, settle, EVIDENCE } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const leaf = (handlerId, parameters) => ({ handlerId, parameters });
const lastPrize = { kind: 'compare', left: { kind: 'zoneCount', side: 'own', zone: 'prizes' }, relation: 'eq', right: { kind: 'literal', value: 1 } };
const water = (s) => { const p = s.players[0], i = p.deck.findIndex((id) => s.cards[id].definitionId === 'water'); p.active.energy.push(p.deck.splice(i, 1)[0]); };
const attacking = (...effects) => fixture((defs) => {
  const a = defs.find((d) => d.definitionId === 'base').mechanics.attacks[0];
  a.printedDamage = null; a.effects = effects;
});
const prizesLeft = (s, n) => { const p = s.players[0]; p.deck.push(...p.prizes.splice(n)); };

test('schema', () => {
  const handlers = createCoreHandlers();
  assert(handlers.get('cn.gameResult@1').validateParameters({ result: 'win' }));
  assert(!handlers.get('cn.gameResult@1').validateParameters({ result: 'draw' }));
  assert(handlers.get('cn.when@1').validateParameters({ condition: lastPrize, effect: leaf('cn.gameResult@1', { result: 'win' }) }));
});

test('the attack wins the game when the condition holds; otherwise nothing happens', async () => {
  const f = await attacking(binding('cn.when@1', { condition: lastPrize, effect: leaf('cn.gameResult@1', { result: 'win' }) }, 'symbol'));
  let g = board(f, (s) => { water(s); prizesLeft(s, 1); });
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  let s = g.snapshot();
  assert.deepEqual(s.result, { winner: 0, reason: 'effect' }); assert.equal(s.phase, 'over');
  assert(s.events.some((e) => e.ruleId === 'win.effect' && e.data.result === 'win' && e.data.player === 0));
  assert.deepEqual(restore(g, f).snapshot(), s);
  assert.deepEqual(g.view(0).legalActions, []);
  g = board(f, (s) => { water(s); prizesLeft(s, 2); });
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  s = g.snapshot();
  assert.equal(s.result, null); assert(!s.events.some((e) => e.ruleId === 'win.effect'));
});

test('「己方败北」: the effect user loses', async () => {
  const f = await attacking(binding('cn.gameResult@1', { result: 'lose' }, 'gamble'));
  const g = board(f, water);
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  assert.deepEqual(g.snapshot().result, { winner: 1, reason: 'effect' });
});

test('an Ability that wins on a hand count is usable only when it holds', async () => {
  const big = { kind: 'compare', left: { kind: 'zoneCount', side: 'own', zone: 'hand' }, relation: 'gte', right: { kind: 'literal', value: 35 } };
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'base').mechanics.abilities = [{ abilityId: 'base:hand', name: '手牌', mode: 'activated',
      usage: { key: 'hand', scope: 'pokemon', period: 'turn', limit: 1 },
      effects: [binding('cn.when@1', { condition: big, effect: leaf('cn.gameResult@1', { result: 'win' }) }, 'hand')], sourceOfTruth: EVIDENCE }];
  });
  const usable = (g) => g.view(0).legalActions.some((a) => a.type === 'useAbility');
  assert(!usable(board(f)));
  const g = board(f, (s) => { const p = s.players[0]; p.hand.push(...p.deck.splice(0, 40)); });
  assert(usable(g));
  command(g, { type: 'useAbility', pokemonId: g.snapshot().players[0].active.id, abilityId: 'base:hand' }); settle(g);
  assert.deepEqual(g.snapshot().result, { winner: 0, reason: 'effect' });
});
