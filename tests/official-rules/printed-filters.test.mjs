// Synthetic definitions only. Printed filters on extra damage targets and switch-in Pokémon, Trainer turn conditions
// (「只能在自己最初的回合使用」「只有在后攻玩家的最初回合才可使用」) and the Supporter first-turn exception (I.B-03; II.E-27).
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { matchesCardSelector } from '../../public/rules/card-selection.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, board, command, answer, settle, hand, bench, attached, fixtureClock } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const playable = (g, card) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card);
const withAttack = (effects) => (defs) => {
  for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 500; d.mechanics.weakness = null; d.mechanics.resistance = null; }
  defs[0].mechanics.attacks[0].effects = effects;
};
const attack = (g) => command(g, { type: 'attack', attackId: 'base:strike' });
const packet = (extra) => binding('cn.damage@1', { side: 'opponent', target: 'bench', amount: 100, selection: { kind: 'exact', count: 1 },
  options: {}, ...extra }, 'packet');

test('extra damage only to printed targets: damaged ones, or a kind of Pokémon, chosen on the board at that time', async () => {
  const h = createCoreHandlers().get('cn.damage@1');
  assert(h.validateParameters(packet({ targetState: { damaged: true } }).parameters));
  assert(!h.validateParameters(packet({ targetState: { damaged: false } }).parameters));
  const f = await fixture(withAttack([packet({ targetState: { damaged: true } })]));
  let hurt, fresh;
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); hurt = bench(s, 1, 'other'); hurt.counters = 1; fresh = bench(s, 1, 'base'); });
  attack(g); settle(g, (q) => { assert.deepEqual(q.options, [hurt.id]); return [hurt.id]; });
  const bench1 = g.snapshot().players[1].bench;
  assert.deepEqual(bench1.map((m) => m.counters), [11, 0]);
  OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  const quiet = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); bench(s, 1, 'other'); });
  attack(quiet); settle(quiet);
  assert.deepEqual(quiet.snapshot().players[1].bench.map((m) => m.counters), [0], 'No damaged Benched Pokémon: no extra damage.');
  const all = await fixture(withAttack([packet({ target: 'any', selection: { kind: 'all' }, amount: 30,
    targetSelector: { kind: 'pokemon', stages: ['stage1'] } })]));
  const e = board(all, (s) => { attached(s, 0, s.players[0].active, 'water'); bench(s, 1, 'evolution'); bench(s, 1, 'other'); });
  attack(e); settle(e);
  assert.deepEqual(e.snapshot().players[1].bench.map((m) => m.counters), [3, 0]);
});

test('switching in only a printed kind of Benched Pokémon; an Item needs one to be playable', async () => {
  const sw = { side: 'own', chooser: 'self', affected: 'active', selector: { kind: 'pokemon', nameKeys: ['other'] } };
  const h = createCoreHandlers().get('cn.switch@1');
  assert(h.validateParameters(sw));
  assert(!h.validateParameters({ side: 'own', chooser: 'self', affected: 'source', state: { damaged: true } }));
  const f = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.switch@1', sw, 'switch')]; });
  let card, wanted;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); bench(s, 0, 'base'); wanted = bench(s, 0, 'other'); });
  assert(playable(g, card));
  command(g, { type: 'playTrainer', cardId: card });
  assert.deepEqual(g.view(0).pending.options, [wanted.id]);
  answer(g, [wanted.id]); settle(g);
  assert.equal(g.snapshot().players[0].active.id, wanted.id);
  const none = board(f, (s) => { card = hand(s, 0, 'potion'); bench(s, 0, 'base'); });
  assert(!playable(none, card));
  const stateful = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.switch@1',
    { side: 'own', chooser: 'self', affected: 'active', state: { damaged: true } }, 'switch')]; });
  assert(!playable(board(stateful, (s) => { card = hand(s, 0, 'potion'); bench(s, 0, 'base'); }), card));
  assert(playable(board(stateful, (s) => { card = hand(s, 0, 'potion'); bench(s, 0, 'base').counters = 1; }), card));
  // The handler's own eligibility (used where no native proof runs) reads the same filters.
  const mon = (id, counters) => ({ id, stack: [`c-${id}`], counters, tools: [], conditions: { rotation: null, poison: null, burned: false } });
  const ctx = (bench) => ({ source: { owner: 0 }, definitions: Object.fromEntries(f.definitions.map((d) => [d.definitionId, d])),
    state: { cards: { 'c-a': { definitionId: 'base' }, 'c-b': { definitionId: 'other' } }, players: [{ active: mon('x', 0), bench }, { active: null, bench: [] }] },
    effectivePokemon: { a: { types: ['Water'], abilities: [] }, b: { types: ['Water'], abilities: [] } } });
  assert.deepEqual([h.canUse(ctx([mon('a', 0)]), sw), h.canUse(ctx([mon('a', 0), mon('b', 0)]), sw)], [false, true]);
  const hurt = { side: 'own', chooser: 'self', affected: 'active', state: { damaged: true } };
  assert.deepEqual([h.canUse(ctx([mon('a', 0)]), hurt), h.canUse(ctx([mon('a', 2)]), hurt)], [false, true]);
});

test('Trainer turn conditions: the player\'s own first turn, and the second player\'s first turn', async () => {
  for (const [condition, clocks] of [[{ firstOwnTurn: true }, [[[0], true], [[1, 0], true], [[0, 1, 0], false]]],
    [{ secondPlayerFirstTurn: true }, [[[0], false], [[1, 0], true], [[1, 0, 1, 0], false]]]]) {
    const f = await fixture((defs) => { def(defs, 'potion').mechanics.condition = condition; });
    for (const [players, expected] of clocks) {
      let card;
      const g = board(f, (s) => { card = hand(s, 0, 'potion'); s.players[0].active.counters = 1; fixtureClock(s, players); });
      assert.equal(playable(g, card), expected, `${JSON.stringify(condition)} ${players}`);
    }
  }
});

test('I.B-03 / II.E-27: a Supporter printed 「即使是先攻玩家的最初回合也可以使用」 may be played then; others may not', async () => {
  assert(requireRule(CN_V20261019, 'trainer.first-turn-use').sourceOfTruth.some((s) => s.section.includes('II.E-27')));
  for (const [firstTurnUse, expected] of [[false, false], [true, true]]) {
    const f = await fixture((defs) => { if (firstTurnUse) def(defs, 'research').mechanics.firstTurnUse = true; });
    let card;
    const g = board(f, (s) => { card = hand(s, 0, 'research'); fixtureClock(s, [0]); });
    assert.equal(playable(g, card), expected);
    if (expected) { command(g, { type: 'playTrainer', cardId: card }); settle(g); assert.equal(g.snapshot().players[0].hand.length, 7); }
  }
  await assert.rejects(fixture((defs) => { def(defs, 'potion').mechanics.firstTurnUse = true; }), /definition/i);
});

test('「（除「宝可梦V・GX」外）」 excludes Pokémon having any of those tags', async () => {
  const f = await fixture((defs) => { def(defs, 'other').mechanics.tags = ['GX']; });
  const sel = { kind: 'pokemon', excludeTags: ['V', 'GX'] };
  assert.equal(matchesCardSelector(def(f.definitions, 'other'), sel), false);
  assert.equal(matchesCardSelector(def(f.definitions, 'base'), sel), true);
});
