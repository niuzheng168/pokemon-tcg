// The AI players (ai/): they decide only from what their player could know, a refused move never corrupts a game, and
// the search compares each distinct move once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, playerView } from '../../public/rules/engine.js';
import { sampleWorld, knownIds, publicCards } from '../../ai/worlds.mjs';
import { createSearch, candidates, moveKey } from '../../ai/search.mjs';
import { createPolicy } from '../../ai/policy.mjs';
import { makeAgent, LEVELS } from '../../ai/agents.mjs';
import { playGame, playSafely, stepCounter } from '../../ai/play.mjs';
import { featureReader, FEATURE_NAMES } from '../../ai/features.mjs';
import { compileModel, createLearnedEvaluator } from '../../ai/value-model.mjs';
import { reviewed, board, play, BOLT, DECK, STANDARD_FORMAT } from '../cn-cards/helpers.mjs';

const OPEN = { ...STANDARD_FORMAT, id: 'open' };

// A real game a few turns in, at a main-phase decision of the turn player.
async function midGame(turn = 5) {
  const { game, catalog } = await reviewed([1, 3, 5, 7], [BOLT, DECK], OPEN);
  const sim = new Simulation(game.snapshot(), catalog), legacy = makeAgent('legacy', catalog), count = stepCounter(), rng = [1, 2, 3, 4];
  while (sim.actor !== null && !(sim.state.turn >= turn && !sim.state.pending)) {
    const me = sim.actor;
    playSafely(sim, me, legacy.decide(sim, me, count(sim, me)), rng);
  }
  return { sim, catalog, me: sim.actor };
}
const identity = (s, id) => `${s.cards[id].printingId}`;

test('a world keeps every card the viewer has seen and deals the rest from what it may know', async () => {
  const { sim, catalog, me } = await midGame();
  const s = sim.snapshot(), world = sampleWorld(s, catalog, me, [9, 9, 9, 9]), foe = 1 - me;
  const known = knownIds(playerView(s, catalog, me));
  for (const id of known) if (s.cards[id]) assert.equal(identity(world, id), identity(s, id), `seen card ${id} keeps its identity`);
  for (const p of [0, 1]) for (const zone of ['hand', 'deck', 'prizes', 'discard'])
    assert.equal(world.players[p][zone].length, s.players[p][zone].length);
  const multiset = (st, owner) => [...st.players[owner].deck, ...st.players[owner].prizes].map((id) => identity(st, id)).sort();
  assert.deepEqual(multiset(world, me), multiset(s, me), 'Own deck and Prizes are the same cards, dealt again.');
  const shown = new Set(publicCards(s, foe).map((id) => identity(s, id)));
  const hidden = [...s.players[foe].hand, ...s.players[foe].deck, ...s.players[foe].prizes].filter((id) => !known.has(id));
  assert.ok(hidden.length > 30);
  for (const id of hidden) assert.ok(shown.has(identity(world, id)), 'An unseen opposing card is guessed from their public cards only.');
  assert.notDeepEqual(world.rng, s.rng);
});

// The position, and a copy that differs only in what `me` cannot see: hidden identities swapped (opposing hand ↔ deck
// ↔ Prizes, two of its own unseen deck cards) and the coming coin flips.
function unseenSwapped(sim, catalog, me) {
  const a = sim.snapshot(), b = structuredClone(a), foe = 1 - me;
  const swap = (x, y) => { const cx = b.cards[x], cy = b.cards[y];
    [cx.printingId, cy.printingId, cx.definitionId, cy.definitionId] = [cy.printingId, cx.printingId, cy.definitionId, cx.definitionId]; };
  // Own deck cards it has seen (a search's reveal, say) stay what they are; only unseen ones may differ.
  const known = knownIds(playerView(a, catalog, me)), { hand, deck, prizes } = b.players[foe];
  const own = b.players[me].deck.filter((id) => !known.has(id));
  const differs = (x, y) => b.cards[x].definitionId !== b.cards[y].definitionId;
  const pairs = [[hand[0], deck.find((id) => differs(hand[0], id))], [prizes[0], deck.find((id) => differs(prizes[0], id))],
    [own[0], own.find((id) => differs(own[0], id))]];
  for (const [x, y] of pairs) { assert.ok(x && y); swap(x, y); }
  b.rng = [123, 456, 789, 1011];
  return { a, b };
}

test('the search gives the same answer whatever the cards its player cannot see are', async () => {
  const { sim, catalog, me } = await midGame();
  const { a, b } = unseenSwapped(sim, catalog, me);
  assert.deepEqual(playerView(b, catalog, me), playerView(a, catalog, me), 'The two positions look the same to the searching player.');
  const run = (snapshot) => createSearch(catalog, { worlds: 2, horizon: 'turn', seed: [5, 6, 7, 8] })(snapshot, me);
  assert.deepEqual(run(b), run(a));
});

test('identical moves are searched once, and every candidate is a legal move or answer', async () => {
  const { sim, catalog, me } = await midGame();
  const view = sim.view(me), policy = createPolicy(catalog);
  const list = candidates(view, me, sim.state, policy, [1, 1, 1, 1]);
  const keys = list.map((a) => moveKey(sim.state, a));
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(new Set(view.legalActions.filter((a) => a.type !== 'concede').map((a) => moveKey(sim.state, a))).size, list.length);
  const result = createSearch(catalog, { worlds: 2, horizon: 'turn' })(sim.snapshot(), me);
  assert.ok(result.moves.every((m) => m.value >= 0 && m.value <= 1));
  assert.deepEqual(result.best, result.moves[0].action);
});

test('a refused move leaves the game as it was, and playSafely then plays an allowed one', async () => {
  const { game, catalog } = await reviewed([1, 3, 5, 7], [BOLT, DECK], OPEN);
  const sim = new Simulation(game.snapshot(), catalog), legacy = makeAgent('legacy', catalog), count = stepCounter(), rng = [1, 2, 3, 4];
  const open = () => sim.state.pending && sim.state.phase === 'main' && sim.state.pending.options?.length > 1;
  while (sim.actor !== null && !open()) { const me = sim.actor; playSafely(sim, me, legacy.decide(sim, me, count(sim, me)), rng); }
  const me = sim.actor, q = sim.state.pending, before = sim.snapshot();
  const wrong = { type: 'answer', requestId: q.id, selected: ['not-an-option'] };
  assert.ok(sim.attempt(me, wrong));
  assert.deepEqual(sim.snapshot(), before);
  const played = playSafely(sim, me, wrong, [5, 5, 5, 5]);
  assert.ok(played.selected.every((id) => q.options.includes(id)));
  assert.equal(sim.state.revision, before.revision + 1);
});

test('the policy keeps 「属性各不相同」 (赤松), and a refused selection is played with one card less', async () => {
  const ctx = await reviewed([1, 3, 5, 7], [BOLT, BOLT], STANDARD_FORMAT);
  let crispin;
  // (The Lightning Energy first in the deck: the policy, liking both types as much, would take the first two.)
  const game = board(ctx, ['raging-bolt-ex', 'mew-ex'], (s, h) => {
    [crispin] = h.hand(0, 'crispin');
    const lightning = (id) => Number(s.cards[id].definitionId === ctx.id['basic-lightning-energy']);
    s.players[0].deck.sort((a, b) => lightning(b) - lightning(a));
  });
  play(game, crispin.instanceId ?? crispin);
  const sim = new Simulation(game.snapshot(), ctx.catalog), q = sim.view(0).pending, type = (id) => sim.state.cards[id].definitionId;
  assert.equal(q.kind, 'inspect-deck');
  const chosen = createPolicy(ctx.catalog)(sim.view(0), 0).selected;
  assert.equal(chosen.length, 2);
  assert.notEqual(type(chosen[0]), type(chosen[1]), 'Two Basic Energy of different types.');
  const same = q.options.filter((id) => type(id) === type(q.options[0])).slice(0, 2);
  assert.equal(same.length, 2);
  const played = playSafely(sim, 0, { type: 'answer', requestId: q.id, selected: same }, [1, 1, 1, 1]);
  assert.deepEqual(played.selected, [same[0]], 'Two of one type are refused; one of them is taken.');
});

test('every difficulty level is defined and the policy levels finish whole games', async () => {
  assert.deepEqual(LEVELS.map((l) => l.name), ['新手', '训练家', '道馆馆主', '四天王', '宝可梦大师']);
  for (const spec of ['level:1', 'level:2']) {
    const { game, catalog } = await reviewed([2, 4, 6, 8], [BOLT, DECK], OPEN);
    const end = playGame(new Simulation(game.snapshot(), catalog), [makeAgent(spec, catalog), makeAgent('legacy', catalog)]);
    assert.notEqual(end.reason, 'step-limit', spec);
  }
});

test('the learned value reads only what its player can see, through the model file\'s layers', async () => {
  const { sim, catalog, me } = await midGame();
  const { a, b } = unseenSwapped(sim, catalog, me), features = featureReader(catalog);
  const x = features(playerView(a, catalog, me), me);
  assert.equal(x.length, FEATURE_NAMES.length);
  assert.ok(x.every(Number.isFinite));
  assert.deepEqual(features(playerView(b, catalog, me), me), x);
  // A one-layer model on Prizes left: P(win) = sigmoid(their Prizes left − mine).
  const F = FEATURE_NAMES.length, w = Array(F).fill(0);
  w[FEATURE_NAMES.indexOf('my.prizesLeft')] = -1;
  w[FEATURE_NAMES.indexOf('their.prizesLeft')] = 1;
  const model = { features: FEATURE_NAMES, mean: Array(F).fill(0), std: Array(F).fill(1), layers: [{ inputs: F, outputs: 1, w, b: [0] }] };
  const { evaluate } = createLearnedEvaluator(catalog, compileModel(model)), view = sim.view(me);
  const prizes = (i) => view.players[i].prizes.count ?? view.players[i].prizes.length;
  assert.ok(Math.abs(evaluate(view, me) - 1 / (1 + Math.exp(prizes(me) - prizes(1 - me)))) < 1e-12);
  assert.throws(() => compileModel({ ...model, features: FEATURE_NAMES.slice(1) }), /other features/);
});
