import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { fixture, binding, EVIDENCE, board, bench, command, answer, settle } from './fixtures.mjs';

test('a fixed activeOnly type effect remains bound to its original Pokémon but does not follow it onto the Bench', async () => {
  const f = await fixture((ds) => {
    ds[0].mechanics.types = ['Darkness']; ds[0].mechanics.retreatCost = 0; ds[1].mechanics.retreatCost = 0;
    ds[0].mechanics.abilities.push({
      abilityId: 'paint', name: '测试战斗位属性效果', mode: 'activated',
      usage: { period: 'unlimited', scope: 'pokemon', key: 'paint', limit: null }, sourceOfTruth: EVIDENCE,
      effects: [binding('cn.lasting@1', {
        side: 'own', target: 'self', effect: { op: 'pokemonTypes', types: ['Psychic'], scope: 'all', activeOnly: true },
        duration: 'untilNextOwnTurnEnd', clearOnBench: false, clearOnEvolution: false,
      })],
    });
  });
  let incoming;
  let g = board(f, (s) => { incoming = bench(s, 0, 'other').id; });
  const original = g.snapshot().players[0].active.id;
  command(g, { type: 'useAbility', pokemonId: original, abilityId: 'paint' }); settle(g);
  assert.deepEqual(g.view(0).players[0].active.effective.types, ['Psychic']);
  command(g, { type: 'retreat' }); answer(g, [incoming]); settle(g);
  assert.equal(g.snapshot().ongoing.length, 1, 'Not-cleared is different from currently-applicable.');
  assert.deepEqual(g.view(0).players[0].bench.find((m) => m.id === original).effective.types, ['Darkness']);
  assert.deepEqual(g.view(0).players[0].active.effective.types, ['Water'], 'The effect does not target whoever is now Active.');
  g = OfficialGame.restore(JSON.parse(JSON.stringify(g.snapshot())), { catalog: f.catalog });
  command(g, { type: 'endTurn' }); settle(g); command(g, { type: 'endTurn' }); settle(g);
  command(g, { type: 'retreat' }); answer(g, [original]); settle(g);
  assert.deepEqual(g.view(0).players[0].active.effective.types, ['Psychic'], 'The same fixed target is applicable again before its real deadline.');
  assert.deepEqual(f.catalog.definition('base').mechanics.types, ['Darkness']);
  assert.deepEqual(OfficialGame.restore(JSON.parse(JSON.stringify(g.snapshot())), { catalog: f.catalog }).snapshot(), g.snapshot());
});
