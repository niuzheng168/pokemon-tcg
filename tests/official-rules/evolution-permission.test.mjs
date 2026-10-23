// Synthetic definitions only. 「这只宝可梦，即使是最初的自己的回合以及刚被放出的回合也可进行进化」 and 「这只宝可梦，可以从手牌中使出从「X」进化
// 而来的「宝可梦ex」，放于这只宝可梦身上进行进化」 (evolution.permission). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, board, command, hand, bench, fixtureClock } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const valid = (p) => createCoreHandlers().get('cn.evolutionPermission@1').validateParameters(clone(p));
const evolves = (g, card, mon) => g.view(0).legalActions.some((a) => a.type === 'evolve' && a.cardId === card && a.pokemonId === mon);

test('evolution permissions: schema', () => {
  assert(valid({ firstTurn: true, sameTurn: true }));
  assert(valid({ fromName: 'other', cardSelector: { kind: 'pokemon', tagsAll: ['ex'] } }));
  assert(valid({ firstTurn: true, sameTurn: true, condition: { kind: 'historyFact', fact: 'secondPlayerFirstTurn' } }));
  assert(valid({ sameTurn: true, sourceActive: true }));
  for (const bad of [{}, { cardSelector: { kind: 'pokemon' } }, { firstTurn: false }, { firstTurn: true, scope: 'self' }]) assert(!valid(bad), JSON.stringify(bad));
});

test('on the first turn and the turn it was played; only its own permission', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'base').mechanics.effects = [binding('cn.evolutionPermission@1', { firstTurn: true, sameTurn: true }, 'early')];
  });
  let card, fresh;
  const setup = (s) => { fixtureClock(s, [1, 0]); card = hand(s, 0, 'evolution'); fresh = bench(s, 0, 'base'); fresh.enteredTurn = s.turn; };
  let g = board(f, setup);
  assert(evolves(g, card, fresh.id), 'Played this turn, on the first own turn.');
  command(g, { type: 'evolve', cardId: card, pokemonId: fresh.id });
  const s = g.snapshot();
  assert.equal(s.cards[s.players[0].bench.find((m) => m.id === fresh.id).stack.at(-1)].definitionId, 'evolution');
  assert.deepEqual(OfficialGame.restore(clone(s), { catalog: f.catalog }).snapshot(), s);
  const without = await fixture();
  g = board(without, setup);
  assert(!evolves(g, card, fresh.id), 'Without the permission: I.A-05.');
});

test('「从「X」进化而来的「宝可梦ex」」: another name as the evolution source', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'other').mechanics.effects = [binding('cn.evolutionPermission@1',
      { fromName: 'base', cardSelector: { kind: 'pokemon', stages: ['stage1'] } }, 'name')];
  });
  let card, mon;
  const g = board(f, (s) => { card = hand(s, 0, 'evolution'); mon = bench(s, 0, 'other'); mon.enteredTurn = 1; });
  assert(evolves(g, card, mon.id));
  const strict = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'other').mechanics.effects = [binding('cn.evolutionPermission@1',
      { fromName: 'base', cardSelector: { kind: 'pokemon', tagsAll: ['ex'] } }, 'name')];
  });
  assert(!evolves(board(strict, (s) => { card = hand(s, 0, 'evolution'); mon = bench(s, 0, 'other'); mon.enteredTurn = 1; }), card, mon.id),
    'Only the printed kind of evolution card.');
});
