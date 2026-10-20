// Synthetic definitions only. Shapes follow printed CN Ability conditions
// (最初的自己的回合 / 在战斗场上 / 上一个对手的回合己方宝可梦昏厥 / 同名特性锁)
// and the 「放于这只宝可梦原先的位置」 replacement; no actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, EngineError } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { matchesCardSelector } from '../../public/rules/card-selection.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, bench, attached, hand, fixtureClock } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const ability = (key, effects, extra = {}) => ({
  abilityId: `fixture:${key}`, name: `测试${key}`, mode: 'activated',
  usage: { period: 'turn', scope: 'pokemon', key: `fixture:${key}`, limit: 1 }, effects, sourceOfTruth: EVIDENCE, ...extra,
});
const withAbility = (id, a) => (defs) => { defs.find((d) => d.definitionId === id).mechanics.abilities = [a]; };
const uses = (g, player = 0) => g.view(player).legalActions.filter((a) => a.type === 'useAbility');
const use = (g, pokemonId, abilityId) => command(g, { type: 'useAbility', pokemonId, abilityId });
const draw = (key) => [binding('cn.draw@1', { count: 1 }, key)];

test('ability conditions carry CN sources and only activated Abilities may print them', async () => {
  for (const id of ['ability.condition', 'effects.replace', 'effects.deck-top-discard', 'bench.limit'])
    assert(requireRule(CN_V20261019, id).sourceOfTruth.length > 0);
  await assert.rejects(fixture(withAbility('base', ability('bad', draw('bad'), {
    mode: 'continuous', usage: null, condition: { firstOwnTurn: true },
    effects: [binding('cn.modifier@1', { field: 'hp', amount: 10, scope: 'self' }, 'bad')],
  }))));
  await assert.rejects(fixture(withAbility('base', ability('empty', draw('empty'), { condition: {} }))));
});

test('I.A-05 / E-14: first own turn means each player\'s own first turn; a player-scope name lock survives the user leaving', async () => {
  const f = await fixture(withAbility('base', ability('first', draw('first'), {
    usage: { period: 'turn', scope: 'player', key: 'fixture:first', limit: 1 }, condition: { firstOwnTurn: true },
  })));
  // Player 0 goes second here: turn 2 is still that player's first own turn.
  let second;
  const g = board(f, (s) => { fixtureClock(s, [1, 0]); second = bench(s, 0, 'base'); });
  const active = g.snapshot().players[0].active.id;
  assert.deepEqual(uses(g).map((a) => a.pokemonId).sort(), [active, second.id].sort());
  use(g, second.id, 'fixture:first'); settle(g);
  assert.deepEqual(uses(g), [], 'Another copy cannot use the same-name Ability this turn.');
  restore(g, f);
  const later = board(f, (s) => { bench(s, 0, 'base'); });
  assert.deepEqual(uses(later), [], 'Turn 5 is player 0\'s third own turn.');
  assert.throws(() => use(later, later.snapshot().players[0].active.id, 'fixture:first'), (e) => e.code === 'illegal-action');
});

test('「如果这只宝可梦在战斗场上的话」 checks the current position, not where the Pokémon entered', async () => {
  const f = await fixture(withAbility('other', ability('active', draw('active'), { condition: { sourceActive: true } })));
  let benched;
  const g = board(f, (s) => { benched = bench(s, 0, 'other'); });
  assert.deepEqual(uses(g), []);
  command(g, { type: 'attachEnergy', cardId: g.snapshot().players[0].hand.find((id) => g.snapshot().cards[id].definitionId === 'water'),
    pokemonId: g.snapshot().players[0].active.id });
  command(g, { type: 'retreat' });
  settle(g, (q) => q.kind === 'promote' || q.kind === 'switch-target' ? [benched.id] : q.options.slice(0, q.minimum));
  assert.equal(g.snapshot().players[0].active.id, benched.id);
  assert.deepEqual(uses(g).map((a) => a.pokemonId), [benched.id]);
});

test('II.E-11: a Knock Out of one of the holder\'s Pokémon during the opponent\'s last turn enables the Ability once', async () => {
  const f = await fixture(withAbility('other', ability('ko', draw('ko'), {
    usage: { period: 'turn', scope: 'player', key: 'fixture:ko', limit: 1 }, condition: { previousOpponentKnockout: true },
  })));
  let waiting;
  const g = board(f, (s) => {
    fixtureClock(s, [0, 1, 0, 1]);
    s.players[0].active.counters = 9; waiting = bench(s, 0, 'other'); bench(s, 0, 'base');
    attached(s, 1, s.players[1].active, 'water');
  });
  assert.deepEqual(uses(g, 1), [], 'The opponent\'s condition is about its own Knock Outs.');
  command(g, { type: 'attack', attackId: 'base:strike' }, 1);
  settle(g, (q) => q.kind === 'promote' ? [waiting.id] : q.options.slice(0, q.minimum));
  assert.equal(g.snapshot().current, 0);
  assert.deepEqual(uses(g).map((a) => a.pokemonId), [waiting.id]);
  use(g, waiting.id, 'fixture:ko'); settle(g);
  assert.deepEqual(uses(g), []);
  const quiet = board(f, (s) => { bench(s, 0, 'other'); });
  assert.deepEqual(uses(quiet), [], 'No Knock Out in the previous opponent turn.');
});

test('「除「X」外」 excludes that name identity from Pokémon, Trainer and Energy selectors', async () => {
  const f = await fixture();
  const def = (id) => f.definitions.find((d) => d.definitionId === id);
  assert.equal(matchesCardSelector(def('base'), { kind: 'pokemon', stages: ['basic'], excludeNameKeys: ['base'] }), false);
  assert.equal(matchesCardSelector(def('other'), { kind: 'pokemon', stages: ['basic'], excludeNameKeys: ['base'] }), true);
  assert.equal(matchesCardSelector(def('potion'), { kind: 'trainer', excludeNameKeys: ['potion'] }), false);
  assert.equal(matchesCardSelector(def('water'), { kind: 'energy', excludeNameKeys: ['fire'] }), true);
  assert.throws(() => matchesCardSelector(def('water'), { kind: 'energy', excludeNameKeys: [] }), /selector/);
});

const transform = (defs) => withAbility('base', ability('transform', [binding('cn.replacePokemon@1', {
  op: 'replacePokemon', target: 'self', from: 'deck', shuffleAfter: true,
  selector: { kind: 'pokemon', stages: ['basic'], excludeNameKeys: ['base'] },
}, 'transform')], { condition: { firstOwnTurn: true, sourceActive: true } }))(defs);

test('replacement: the chosen deck Basic becomes a new Pokémon in the same spot; old cards are discarded without a Knock Out', async () => {
  const f = await fixture(transform);
  let energy, tool;
  const g = board(f, (s) => {
    fixtureClock(s, [0]);
    const m = s.players[0].active; m.counters = 3; m.conditions.burned = true;
    energy = attached(s, 0, m, 'water');
    tool = hand(s, 0, 'tool'); s.players[0].hand.pop(); m.tools.push(tool);
  });
  const before = g.snapshot(), old = before.players[0].active, prizes = before.players[1].prizes.length;
  assert.deepEqual(uses(g).map((a) => a.pokemonId), [old.id]);
  use(g, old.id, 'fixture:transform');
  const q = g.view(0).pending;
  assert.equal(q.kind, 'select-cards'); assert.equal(q.minimum, 0, 'A hidden deck search may fail to find.');
  const others = before.players[0].deck.filter((id) => before.cards[id].definitionId === 'other');
  assert.deepEqual([...q.options].sort(), others.sort(), 'Only Basic Pokémon other than the excluded name.');
  const r = restore(g, f);
  for (const game of [g, r]) { answer(game, [others[0]]); settle(game); }
  assert.deepEqual(r.snapshot(), g.snapshot());
  const s = g.snapshot(), fresh = s.players[0].active;
  assert.notEqual(fresh.id, old.id);
  assert.deepEqual([fresh.stack, fresh.energy, fresh.tools, fresh.counters, fresh.enteredTurn], [[others[0]], [], [], 0, s.turn]);
  assert.equal(fresh.conditions.burned, false);
  for (const id of [...old.stack, energy, tool]) assert(s.players[0].discard.includes(id));
  assert.equal(s.players[1].prizes.length, prizes, 'Not a Knock Out: no Prize is taken.');
  assert(s.events.some((e) => e.ruleId === 'effects.replace' && e.data.newPokemonId === fresh.id));
  assert(s.events.some((e) => e.ruleId === 'effects.shuffle' && e.data.player === 0));
  assert.deepEqual(uses(g), [], 'The new Pokémon is not the Pokémon that could use the old Ability.');
});

test('replacement may find nothing, still shuffles, and rejects changed decks or Bench use', async () => {
  const f = await fixture(transform);
  const g = board(f, (s) => fixtureClock(s, [0]));
  const old = g.snapshot().players[0].active;
  use(g, old.id, 'fixture:transform'); answer(g, []); settle(g);
  assert.equal(g.snapshot().players[0].active.id, old.id);
  assert(g.snapshot().events.some((e) => e.ruleId === 'effects.shuffle' && e.data.player === 0));
  // No eligible card: the searched deck is still viewed, then shuffled.
  const none = board(f, (s) => {
    fixtureClock(s, [0]);
    const p = s.players[0];
    for (const id of p.deck.filter((id) => s.cards[id].definitionId === 'other')) { p.deck.splice(p.deck.indexOf(id), 1); p.discard.push(id); }
  });
  use(none, none.snapshot().players[0].active.id, 'fixture:transform');
  assert.equal(none.view(0).pending.kind, 'view-cards');
  answer(none, ['confirm']); settle(none);
  assert(none.snapshot().events.some((e) => e.ruleId === 'effects.shuffle' && e.data.player === 0));
  // A forged deck order between the search and the answer is rejected.
  const h = board(f, (s) => fixtureClock(s, [0]));
  use(h, h.snapshot().players[0].active.id, 'fixture:transform');
  const forged = clone(h.snapshot());
  forged.players[0].deck.reverse();
  const replay = OfficialGame.restore(forged, { catalog: f.catalog });
  assert.throws(() => answer(replay, [replay.view(0).pending.options[0]]), (e) => e instanceof EngineError &&
    ['invalid-pokemon-replacement', 'invalid-selection-request'].includes(e.code));
  // A Benched copy, or a later own turn, cannot use it.
  const benched = board(f, (s) => { fixtureClock(s, [0]); bench(s, 0, 'base'); });
  assert.deepEqual(uses(benched).map((a) => a.pokemonId), [benched.snapshot().players[0].active.id]);
});

test('replacement handler: CN sources, an empty deck or a departed source cannot be used', async () => {
  const h = createCoreHandlers().get('cn.replacePokemon@1');
  for (const source of requireRule(CN_V20261019, 'effects.replace').sourceOfTruth) assert(h.sourceOfTruth.includes(source));
  const p = { op: 'replacePokemon', target: 'self', from: 'deck', shuffleAfter: true, selector: { kind: 'pokemon' } };
  assert(h.validateParameters(p));
  for (const bad of [{ ...p, from: 'hand' }, { ...p, target: 'any' }, { ...p, shuffleAfter: false }, { ...p, extra: 1 }])
    assert(!h.validateParameters(bad));
  const f = await fixture(transform);
  const g = board(f, (s) => { fixtureClock(s, [0]); s.players[0].discard.push(...s.players[0].deck.splice(0)); });
  assert.deepEqual(uses(g), [], 'An empty deck cannot change anything (I.A-02).');
  const ctx = { source: { owner: 0, pokemonId: 'gone' }, state: g.snapshot() };
  assert.equal(h.canUse(ctx, p), false);
});
