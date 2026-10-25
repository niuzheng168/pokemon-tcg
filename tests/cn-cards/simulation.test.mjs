// Simulation mode with the reviewed CN decks: whole CPU games played checked (OfficialGame) and trusted
// (Simulation) side by side agree on every snapshot and view, so a search sees the same rules as the table.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../../public/rules/engine.js';
import { createAI } from '../../public/cn/ai.js';
import { reviewed, BOLT, DECK, DRAGAPULT, STANDARD_FORMAT } from './helpers.mjs';

const OPEN = { ...STANDARD_FORMAT, id: 'open' };

for (const [name, decks, seed] of [['猛雷鼓 vs 皮卡丘', [BOLT, DECK], [1, 7, 1, 8]], ['多龙巴鲁托 vs 猛雷鼓', [DRAGAPULT, BOLT], [2, 7, 1, 8]]]) {
  test(`a whole CPU game (${name}) is the same checked and trusted`, async () => {
    const { game, catalog } = await reviewed(seed, decks, OPEN);
    const sim = new Simulation(game.snapshot(), catalog), ai = createAI(catalog);
    for (let step = 0; !game.snapshot().result; step++) {
      if (step > 2000) assert.fail('The CPU game must terminate.');
      const s = game.snapshot(), player = s.pending ? s.pending.player : s.current, view = game.view(player);
      assert.equal(sim.actor, player);
      assert.deepEqual(sim.view(player), { ...view, events: [] });
      const action = ai(view, player);
      game.dispatch({ player, expectedRevision: view.revision, action });
      sim.play(player, action);
      assert.deepEqual(sim.snapshot(), game.snapshot(), `step ${step}`);
    }
    assert.equal(sim.actor, null);
  });
}
