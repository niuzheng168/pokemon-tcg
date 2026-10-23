// Synthetic definitions only. 「将自己的1只剩余HP在「30」及以下的宝可梦的HP，全部回复」
// 「回复自己的1只剩余HP在「30」点以下（包含「30」点）的宝可梦「120」点HP」 (effects.heal-results, II.D-16). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { healingWindow } from '../../public/rules/healing.js';
import { fixture, binding, board, command, settle, hand, bench } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const heal = (amount) => ({ op: 'healPokemon', side: 'own', target: 'any', selector: { kind: 'pokemon' }, selection: { kind: 'exact', count: 1 },
  amount, discardHealedEnergy: false, state: { remainingHpAtMost: 30 } });
const item = (amount) => fixture((defs) => {
  defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.healPokemon@1', heal(amount), 'low-heal')];
});
// Player 0: Active 'base' (100 HP) with active counters, Benched 'other's (100 HP) with the benched counters.
const setup = (f, active, ...benched) => {
  let card;
  const g = board(f, (s) => {
    card = hand(s, 0, 'potion'); s.players[0].active.counters = active;
    for (const counters of benched) bench(s, 0, 'other').counters = counters;
  });
  return { g, card };
};
const playable = (g, card) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card);

test('schema: a healing set may read the remaining HP', () => {
  const valid = createCoreHandlers().get('cn.healPokemon@1').validateParameters;
  assert(valid(heal('all'))); assert(valid(heal(120)));
  assert(!valid({ ...heal('all'), state: { remainingHpAtMost: 35 } }));
});

test('only a Pokémon with 30 or less remaining HP is offered; 「全部回复」 removes every counter', async () => {
  const f = await item('all');
  const { g, card } = setup(f, 8, 5, 9);
  assert(playable(g, card));
  command(g, { type: 'playTrainer', cardId: card });
  const q = g.snapshot().pending, p0 = g.snapshot().players[0];
  assert.deepEqual(q.options, [p0.active.id, p0.bench[1].id], 'The first Benched Pokémon has 50 HP left.');
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  settle(g);
  const p = g.snapshot().players[0];
  assert.equal(p.active.counters, 0); assert.deepEqual(p.bench.map((m) => m.counters), [5, 9]);
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  const none = setup(f, 6, 5);
  assert(!playable(none.g, none.card), 'Nothing has 30 or less HP left.');
});

test('a fixed amount heals only the low Pokémon, never more than its counters', async () => {
  const f = await item(120);
  const { g, card } = setup(f, 3, 9);
  command(g, { type: 'playTrainer', cardId: card }); settle(g);
  const p = g.snapshot().players[0];
  assert.equal(p.active.counters, 3); assert.equal(p.bench[0].counters, 0);
});

test('the healing window needs the host\'s remaining HP', async () => {
  const f = await item('all');
  const { g } = setup(f, 8, 5);
  const s = g.snapshot();
  const ctx = { source: { owner: 0, category: 'trainer' }, state: s, definitions: f.catalog.definitionRecord(),
    effectivePokemon: Object.fromEntries([s.players[0].active, ...s.players[0].bench].map((m) => [m.id, { types: ['Water'] }])) };
  assert.throws(() => healingWindow(ctx, heal('all')), /remaining HP/);
  const remainingHp = { [s.players[0].active.id]: 20, [s.players[0].bench[0].id]: 50 };
  assert.deepEqual(healingWindow({ ...ctx, remainingHp }, heal('all')).targets.map((t) => t.pokemonId), [s.players[0].active.id]);
});
