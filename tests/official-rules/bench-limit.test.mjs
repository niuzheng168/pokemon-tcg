// Synthetic definitions only. Shapes follow a printed Stadium that raises the
// Bench limit for players with a tagged Pokémon, the 太晶 Bench protection
// rule and a Basic-only Retreat erasure; no actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, EngineError } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, bench, attached, hand } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const zero = { op: 'benchLimit', scope: 'all', limit: 8, requires: { kind: 'pokemon', tagsAll: ['Tera'] } };
const tera = (defs) => { defs.find((d) => d.definitionId === 'other').mechanics.tags = ['Tera']; };
// Test-only deck shape: enough Basic Pokémon to fill two eight-Pokémon Benches.
const crowded = async (transform) => {
  const f = await fixture((defs) => { transform(defs); defs.find((d) => d.definitionId === 'base').deckLimits.sameName = null; });
  for (let i = 0; i < 14; i++) f.deck[f.deck.lastIndexOf('printing:water')] = 'printing:base';
  return f;
};
const raise = (defs) => {
  tera(defs);
  defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [binding('cn.benchLimit@1', { effect: zero }, 'zero')];
};
const placeStadium = (s, owner) => { const id = hand(s, owner, 'stadium'); s.players[owner].hand.pop(); s.stadium = id; return id; };
const fill = (s, owner, count, id = 'base') => {
  const out = [];
  for (let i = 0; i < count; i++) out.push(bench(s, owner, id));
  return out;
};
const benchActions = (g, player = 0) => g.view(player).legalActions.filter((a) => a.type === 'bench');
const trims = (g) => g.snapshot().events.filter((e) => e.ruleId === 'bench.limit');

test('bench limit handler: CN sources, schema bounds and the generic eight-Pokémon state ceiling', async () => {
  const h = createCoreHandlers().get('cn.benchLimit@1');
  assert.equal(h.timing, 'continuous'); assert.deepEqual(h.operations, ['benchLimit']);
  for (const source of requireRule(CN_V20261019, 'bench.limit').sourceOfTruth) assert(h.sourceOfTruth.includes(source));
  assert(h.validateParameters({ effect: zero }));
  for (const bad of [{ ...zero, limit: 9 }, { ...zero, limit: 5 }, { ...zero, scope: 'self' }, { ...zero, requires: { kind: 'energy' } }])
    assert(!h.validateParameters({ effect: bad }));
  const f = await crowded(raise);
  assert.throws(() => board(f, (s) => { placeStadium(s, 0); bench(s, 0, 'other'); fill(s, 0, 8); }),
    (e) => e instanceof EngineError && e.code === 'invalid-state');
});

test('a raised limit applies only to the player with a qualifying in-play Pokémon, for hand and effect Bench placement', async () => {
  const f = await crowded((defs) => {
    raise(defs);
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.cards@1', {
      from: 'deck', to: 'bench', selector: { kind: 'pokemon', stages: ['basic'] }, quantity: { kind: 'upTo', count: 2 },
      reveal: false, lookTop: null, shuffleAfter: true }, 'nest')];
  });
  let ball;
  const g = board(f, (s) => {
    placeStadium(s, 1); bench(s, 0, 'other'); fill(s, 0, 5); fill(s, 1, 5);
    ball = hand(s, 0, 'potion');
    for (const owner of [0, 1]) hand(s, owner, 'base');
  });
  assert.equal(benchActions(g).length > 0, true, 'Six Benched with a Tera Pokémon: up to eight.');
  assert.deepEqual(benchActions(g, 1), [], 'The opponent has no Tera Pokémon: five.');
  command(g, { type: 'playTrainer', cardId: ball });
  const q = g.view(0).pending;
  assert.equal(q.kind, 'select-cards'); assert.equal(q.maximum, 2, 'Six Benched: two spaces remain under eight.');
  answer(g, q.options.slice(0, 2)); settle(g);
  assert.equal(g.snapshot().players[0].bench.length, 8);
  assert.deepEqual(benchActions(g), []);
  restore(g, f);
});

test('losing the last qualifying Pokémon trims the Bench to five at the next rule boundary; trimmed Pokémon are not Knocked Out', async () => {
  const f = await crowded((defs) => {
    raise(defs);
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.fieldReturn@1', {
      op: 'returnPokemon', side: 'own', target: 'bench', selector: { kind: 'pokemon', tagsAll: ['Tera'] },
      quantity: { kind: 'exact', count: 1 }, chooser: 'source', to: 'hand', attachments: 'discard' }, 'scoop')];
  });
  let item, teraMon, extra;
  const g = board(f, (s) => {
    placeStadium(s, 0); teraMon = bench(s, 0, 'other'); extra = fill(s, 0, 6);
    attached(s, 0, extra[0], 'water');
    item = hand(s, 0, 'potion');
  });
  const prizes = g.snapshot().players.map((p) => p.prizes.length);
  command(g, { type: 'playTrainer', cardId: item });
  assert.equal(g.view(0).pending.kind, 'return-pokemon');
  answer(g, [teraMon.id]);
  const q = g.view(0).pending;
  assert.equal(q.kind, 'bench-trim'); assert.equal(q.minimum, 1); assert.equal(q.maximum, 1);
  const r = restore(g, f);
  for (const game of [g, r]) answer(game, [extra[0].id]);
  assert.deepEqual(r.snapshot(), g.snapshot());
  const s = g.snapshot();
  assert.equal(s.players[0].bench.length, 5);
  assert(s.players[0].discard.includes(extra[0].stack[0]) && s.players[0].discard.includes(extra[0].energy[0]));
  assert.deepEqual(s.players.map((p) => p.prizes.length), prizes, 'No Prize for a Bench limit discard.');
  assert.deepEqual(trims(g).map((e) => e.data.pokemonId), [extra[0].id]);
});

test('when the Stadium leaves, both players trim and its holder goes first; replacement and effect discard alike', async () => {
  const f = await crowded((defs) => {
    raise(defs);
    defs.push({ ...clone(defs.find((d) => d.definitionId === 'stadium')), definitionId: 'stadium2', nameKey: 'stadium2', name: '测试竞技场二',
      mechanics: { category: 'stadium', effects: [binding('cn.modifier@1', { field: 'hp', amount: 10, scope: 'all' }, 'other-stadium')] } });
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.discardStadium@1', {
      op: 'discardStadium', side: 'either', selector: { kind: 'trainer', categories: ['stadium'] } }, 'drop')];
  });
  f.deck[f.deck.indexOf('printing:hp-tool')] = 'printing:stadium2';
  const setup = (s) => {
    placeStadium(s, 1);
    for (const owner of [0, 1]) { bench(s, owner, 'other'); fill(s, owner, 6); }
  };
  // Replacing the Stadium by playing another one.
  let next;
  const g = board(f, (s) => { setup(s); next = hand(s, 0, 'stadium2'); });
  command(g, { type: 'playTrainer', cardId: next });
  assert.deepEqual([g.view(1).pending?.kind, g.snapshot().pending.player], ['bench-trim', 1], 'The discarded Stadium\'s holder first.');
  assert.equal(g.snapshot().pending.minimum, 2);
  settle(g);
  assert.deepEqual(g.snapshot().players.map((p) => p.bench.length), [5, 5]);
  assert.deepEqual([...new Set(trims(g).map((e) => e.data.player))], [1, 0]);
  // Discarding it by an effect.
  let drop;
  const h = board(f, (s) => { setup(s); drop = hand(s, 0, 'potion'); });
  command(h, { type: 'playTrainer', cardId: drop });
  settle(h, (q) => q.kind === 'bench-trim' ? q.options.slice(0, q.minimum) : q.options.slice(0, q.minimum));
  assert.deepEqual(h.snapshot().players.map((p) => p.bench.length), [5, 5]);
  assert.deepEqual([...new Set(trims(h).map((e) => e.data.player))], [1, 0]);
});

test('an over-limit Bench without its source cannot guess an order; a wrong-size answer is rejected', async () => {
  const f = await crowded(raise);
  const g = board(f, (s) => { for (const owner of [0, 1]) fill(s, owner, 6); });
  assert.throws(() => command(g, { type: 'endTurn' }), (e) => e instanceof EngineError && e.code === 'unresolved-bench-trim-order');
  const one = board(f, (s) => { fill(s, 0, 7); });
  command(one, { type: 'endTurn' });
  const q = one.snapshot().pending;
  assert.equal(q.kind, 'bench-trim'); assert.equal(q.minimum, 2);
  assert.throws(() => answer(one, q.options.slice(0, 1)), (e) => e.code === 'invalid-choice');
  const forged = clone(one.snapshot());
  forged.pending.minimum = 1; forged.pending.maximum = 1;
  assert.throws(() => OfficialGame.restore(forged, { catalog: f.catalog }), EngineError);
});

test('太晶: no damage from attacks while Benched, from either player; Active damage and effects still apply', async () => {
  const f = await fixture((defs) => {
    tera(defs);
    const t = defs.find((d) => d.definitionId === 'other');
    t.mechanics.effects = [binding('cn.protection@1', { effect: { op: 'protection', channel: 'damage', useRule: 'ordinary',
      scope: 'self', from: 'all', categories: ['attack'], benchOnly: true } }, 'tera')];
    defs.find((d) => d.definitionId === 'base').mechanics.attacks[0].effects = [
      binding('cn.damage@1', { side: 'opponent', target: 'bench', amount: 30, selection: { kind: 'all' }, options: {} }, 'spread'),
      binding('cn.damage@1', { side: 'own', target: 'bench', amount: 10, selection: { kind: 'all' }, options: {} }, 'self-spread'),
      binding('cn.counters@1', { side: 'opponent', target: 'bench', count: 1 }, 'counter'),
    ];
  });
  assert.throws(() => createCoreHandlers().get('cn.protection@1').validateParameters({ effect: { op: 'protection', channel: 'damage',
    useRule: 'ordinary', scope: 'self', from: 'all', categories: ['attack'], benchOnly: true, activeOnly: true } }) || (() => { throw new Error('no'); })());
  let theirs, mine, plain;
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water');
    theirs = bench(s, 1, 'other'); plain = bench(s, 1, 'base'); mine = bench(s, 0, 'other');
  });
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  const s = g.snapshot(), counters = (owner, id) => [s.players[owner].active, ...s.players[owner].bench].find((m) => m.id === id).counters;
  assert.equal(counters(1, theirs.id), 1, 'Only the counter effect; the 30 damage was prevented.');
  assert.equal(counters(1, plain.id), 3);
  assert.equal(counters(0, mine.id), 0, 'Own attacks are also prevented.');
  // In the Active Spot the same Pokémon takes attack damage.
  const h = board(f, (s) => {
    const p = s.players[1]; p.hand.push(...p.active.stack); p.active = bench(s, 1, 'other'); p.bench.pop();
    attached(s, 0, s.players[0].active, 'water');
  });
  command(h, { type: 'attack', attackId: 'base:strike' }); settle(h);
  assert.equal(h.snapshot().players[1].active.counters, 2);
});

test('「自己所有【基础】宝可梦【撤退】所需能量，全部消除」 erases only Basic Pokémon\'s Retreat requirement', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'other').mechanics.abilities = [{
      abilityId: 'fixture:sky', name: '测试天际线', mode: 'continuous', usage: null, sourceOfTruth: EVIDENCE,
      effects: [binding('cn.energyRequirement@1', { effect: { op: 'energyRequirement', action: 'retreat', mode: 'erase', scope: 'own',
        stages: ['basic'] } }, 'sky')],
    }];
  });
  let target;
  const g = board(f, (s) => { bench(s, 0, 'other'); target = bench(s, 0, 'base'); });
  command(g, { type: 'retreat' });
  assert.equal(g.view(0).pending.kind, 'retreat-target', 'No Energy payment for a Basic Active.');
  answer(g, [target.id]); settle(g);
  assert.equal(g.snapshot().players[0].active.id, target.id);
  const h = board(f, (s) => {
    bench(s, 0, 'other');
    const p = s.players[0], e = hand(s, 0, 'evolution'); p.hand.pop(); p.active.stack.push(e);
    attached(s, 0, p.active, 'water'); bench(s, 0, 'base');
  });
  command(h, { type: 'retreat' });
  assert.equal(h.view(0).pending.kind, 'retreat-energy', 'A Stage 1 Pokémon still pays.');
});
