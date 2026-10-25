// Simulation mode (trust.js): the same seed played checked (OfficialGame) and trusted (Simulation) must give the same
// snapshot after every command. Forks share the logged events, frozen, and never change their parent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, Simulation, EngineError } from '../../public/rules/game.js';
import { checking, trusted } from '../../public/rules/trust.js';
import { fixture, RULESET } from './fixtures.mjs';

// A fixed pseudo-random player: any legal move but conceding, and the first options a request allows.
function chooser(seed) {
  let x = seed;
  const next = (k) => { x = (x * 1103515245 + 12345) % 2 ** 31; return x % k; };
  return (view, player) => {
    const q = view.pending;
    if (q) return { type: 'answer', requestId: q.id, selected: q.allowZero && next(2) ? [] : q.options.slice(0, q.minimum) };
    const moves = view.legalActions.filter((a) => a.type !== 'concede');
    return moves[next(moves.length)];
  };
}
const actorOf = (s) => s.pending ? s.pending.player : s.current;
const withoutEvents = (view) => ({ ...view, events: [] });

test('checked and trusted play of the same seed agree on every snapshot, view and legal move list', async () => {
  const f = await fixture();
  for (const seed of [[123, 456, 789, 10], [5, 6, 7, 8]]) {
    const game = new OfficialGame({ ruleset: RULESET, catalog: f.catalog, decks: [f.deck, f.deck], seed });
    const sim = new Simulation(game.snapshot(), f.catalog), choose = chooser(seed[0]);
    for (let step = 0; step < 300 && !game.snapshot().result; step++) {
      const player = actorOf(game.snapshot()), view = game.view(player);
      assert.equal(sim.actor, player);
      assert.deepEqual(sim.view(player), withoutEvents(view));
      if (!view.pending) assert.deepEqual(sim.legalActions(player), view.legalActions);
      const action = choose(view, player);
      game.dispatch({ player, expectedRevision: view.revision, action });
      sim.play(player, action);
      assert.deepEqual(sim.snapshot(), game.snapshot(), `seed ${seed} step ${step}`);
    }
    assert.ok(game.snapshot().turn > 4, 'The fixture game gets past its opening turns.');
  }
});

test('a fork plays on alone: its parent keeps its state and the logged events stay frozen', async () => {
  const f = await fixture();
  const game = new OfficialGame({ ruleset: RULESET, catalog: f.catalog, decks: [f.deck, f.deck], seed: f.seed });
  const sim = new Simulation(game.snapshot(), f.catalog), choose = chooser(7);
  for (let step = 0; step < 12; step++) { const p = sim.actor; sim.play(p, choose(sim.view(p), p)); }
  const before = sim.snapshot(), fork = sim.fork();
  assert.deepEqual(fork.snapshot(), before);
  assert.equal(fork.state.events[0], sim.state.events[0], 'Forks share the logged events.');
  for (let step = 0; step < 60 && fork.actor !== null; step++) { const p = fork.actor; fork.play(p, choose(fork.view(p), p)); }
  assert.ok(fork.state.events.length > before.events.length);
  assert.deepEqual(sim.snapshot(), before, 'Playing the fork leaves its parent unchanged.');
  assert.ok(fork.state.events.every((e) => Object.isFrozen(e) && Object.isFrozen(e.data)));
  assert.throws(() => { sim.state.events[0].data.kind = 'changed'; }, TypeError);
});

test('a simulation starts from a checked snapshot, ends with the game and restores the checks after a throw', async () => {
  const f = await fixture();
  const game = new OfficialGame({ ruleset: RULESET, catalog: f.catalog, decks: [f.deck, f.deck], seed: f.seed });
  assert.throws(() => new Simulation({ ...game.snapshot(), revision: -1 }, f.catalog), EngineError);
  assert.deepEqual(new Simulation(game.snapshot(), f.catalog, { checked: false }).snapshot(), game.snapshot(),
    'A search starts its own derived positions unchecked.');
  const sim = new Simulation(game.snapshot(), f.catalog);
  assert.throws(() => sim.play(1 - sim.actor, { type: 'endTurn' }), EngineError);
  assert.equal(checking(), true, 'A throwing command still turns the checks back on.');
  assert.equal(trusted(() => checking()), false);
  sim.play(sim.actor, { type: 'concede' });
  assert.ok(sim.state.result);
  assert.equal(sim.actor, null);
});

test('attempt plays a command, or leaves the position exactly as it was when the rules refuse it', async () => {
  const f = await fixture();
  const game = new OfficialGame({ ruleset: RULESET, catalog: f.catalog, decks: [f.deck, f.deck], seed: f.seed });
  const sim = new Simulation(game.snapshot(), f.catalog), choose = chooser(3);
  for (let step = 0; step < 8; step++) { const p = sim.actor; sim.play(p, choose(sim.view(p), p)); }
  const before = sim.snapshot(), p = sim.actor;
  assert.ok(sim.attempt(1 - p, { type: 'endTurn' }) instanceof EngineError);
  assert.deepEqual(sim.snapshot(), before);
  assert.equal(sim.attempt(p, choose(sim.view(p), p)), null);
  assert.equal(sim.state.revision, before.revision + 1);
});
