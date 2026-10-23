// Synthetic definitions only. 「将双方场上宝可梦身上放置的1个伤害指示物，转放于双方场上的其他宝可梦身上」「将对手场上1只宝可梦身上放置的最多3个伤害指示物，
// 转放于对手1只其他宝可梦身上」「选择对手场上宝可梦身上放置的任意数量的伤害指示物，以任意方式转放于对手的场上宝可梦身上」「选择自己场上1只宝可梦身上放置的
// 最多2个伤害指示物，以任意方式转放于自己的其他宝可梦身上」「选择自己场上宝可梦身上放置的1个伤害指示物，转放于这只宝可梦身上」「选择放置于自己场上【超】
// 宝可梦身上的1个伤害指示物，转放于自己其他【超】宝可梦身上」「选择放置于自己所有宝可梦身上的伤害指示物各2个，转放于对手的1只宝可梦身上」 (damage.counters).
// No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, board, command, answer, settle, hand, bench } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();
const valid = (p) => handlers.get('cn.transferCounters@1').validateParameters(clone(p));
const both = { count: 1, from: 'any', side: 'both', target: 'any', originSide: 'both' };
const theirs = { count: 3, from: 'any', side: 'opponent', target: 'any', quantity: 'upTo', originSide: 'opponent' };
const anyWay = { from: 'any', side: 'opponent', target: 'any', quantity: 'any', originSide: 'opponent' };
const spread = { count: 2, from: 'any', side: 'own', target: 'any', quantity: 'upTo', split: true };
const toSelf = { count: 1, from: 'any', side: 'own', target: 'self' };
const fire = { kind: 'pokemon', types: ['Fire'] };
const kind = { count: 1, from: 'any', side: 'own', target: 'any', originSelector: fire, targetSelector: fire };
const each = { count: 2, from: 'every', side: 'opponent', target: 'any', each: true };
const play = (f, card, mutate) => {
  let id;
  const g = board(f, (s) => { id = hand(s, 0, card); mutate(s); });
  command(g, { type: 'playTrainer', cardId: id });
  return g;
};

test('schema', () => {
  for (const p of [both, theirs, anyWay, { ...anyWay, from: 'bench', target: 'active' }, { ...anyWay, count: 2 }, spread, toSelf, kind, each,
    { from: 'every', side: 'opponent', target: 'active', quantity: 'all' }]) assert(valid(p), JSON.stringify(p));
  for (const p of [{ ...both, originSide: undefined }, { ...both, side: 'own' }, { from: 'every', side: 'opponent', target: 'any', quantity: 'all', count: 2 }, { ...anyWay, from: 'self' },
    { ...anyWay, split: true }, { ...spread, quantity: undefined }, { ...toSelf, side: 'opponent' }, { ...each, quantity: 'upTo' },
    { ...each, from: 'any' }, { ...each, count: undefined }, { ...each, originSide: 'opponent' }, { from: 'every', side: 'opponent', target: 'any' }])
    assert(!valid(JSON.parse(JSON.stringify(p))), JSON.stringify(p));
});

test('origins on either side; 「最多3个」 to another of their Pokémon; usability', async () => {
  const f = await fixture((defs) => {
    def(defs, 'potion').mechanics.effects = [binding('cn.transferCounters@1', both, 'both')];
    def(defs, 'poison').mechanics.effects = [binding('cn.transferCounters@1', theirs, 'theirs')];
  });
  let mine;
  const g = play(f, 'potion', (s) => { s.players[1].active.counters = 2; mine = bench(s, 0, 'other'); });
  const q = g.snapshot().pending;
  assert.deepEqual(q.options, [g.snapshot().players[1].active.id], 'Only a Pokémon with counters is an origin.');
  answer(g, q.options);
  assert.equal(g.snapshot().pending.options.length, 2, 'Any other Pokémon on either side.');
  answer(g, [mine.id]); settle(g);
  let s = g.snapshot();
  assert.deepEqual([s.players[1].active.counters, s.players[0].bench[0].counters], [1, 1]);
  assert.deepEqual(restore(g, f).snapshot(), s);
  let card, other;
  const h = board(f, (s) => { card = hand(s, 0, 'poison'); s.players[0].active.counters = 4; bench(s, 1, 'other'); });
  assert(!h.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card), 'Only their counters can move.');
  const k = play(f, 'poison', (s) => { s.players[1].active.counters = 4; other = bench(s, 1, 'other'); });
  answer(k, [k.snapshot().players[1].active.id]);
  assert.deepEqual(k.snapshot().pending.options, ['1', '2', '3']);
  answer(k, ['3']); answer(k, [other.id]); settle(k);
  s = k.snapshot();
  assert.deepEqual([s.players[1].active.counters, s.players[1].bench[0].counters], [1, 3]);
});

test('「任意数量…以任意方式」: one counter at a time until the player stops; 「最多2个」 from any of them', async () => {
  const f = await fixture((defs) => {
    def(defs, 'potion').mechanics.effects = [binding('cn.transferCounters@1', anyWay, 'any')];
    def(defs, 'poison').mechanics.effects = [binding('cn.transferCounters@1', { from: 'any', side: 'opponent', target: 'active', quantity: 'any', count: 2 }, 'two')];
  });
  let p, q;
  const h = play(f, 'poison', (s) => { p = bench(s, 0, 'other'); q = bench(s, 0, 'other'); p.counters = 1; q.counters = 3; });
  for (const from of [p.id, q.id]) {
    assert.equal(h.snapshot().pending.kind, 'counter-origin'); answer(h, [from]);
    answer(h, [h.snapshot().players[1].active.id]);
  }
  assert.equal(h.snapshot().pending, null, 'At most 2 in all.');
  let t = h.snapshot();
  assert.deepEqual([t.players[0].bench[0].counters, t.players[0].bench[1].counters, t.players[1].active.counters], [0, 2, 2]);
  let a, b;
  const g = play(f, 'potion', (s) => { s.players[1].active.counters = 3; a = bench(s, 1, 'other'); b = bench(s, 1, 'other'); a.counters = 1; });
  const active = g.snapshot().players[1].active.id;
  for (const [from, to] of [[active, a.id], [active, b.id], [a.id, b.id]]) {
    const q = g.snapshot().pending;
    assert.equal(q.minimum, 0);
    answer(g, [from]); answer(g, [to]);
  }
  assert.equal(g.snapshot().pending.kind, 'counter-origin');
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  answer(g, []); settle(g);
  const s = g.snapshot(), by = (id) => [s.players[1].active, ...s.players[1].bench].find((m) => m.id === id).counters;
  assert.deepEqual([by(active), by(a.id), by(b.id)], [1, 1, 2]);
  assert.equal(s.events.filter((e) => e.ruleId === 'damage.counters' && e.data.removed === 1).length, 3);
  assert.equal(s.pending, null);
});

test('「最多2个…以任意方式转放于自己的其他宝可梦」, 「转放于这只宝可梦身上」, a destination kind, and 「各2个」', async () => {
  const f = await fixture((defs) => {
    def(defs, 'other').mechanics.types = ['Fire'];
    def(defs, 'potion').mechanics.effects = [binding('cn.transferCounters@1', spread, 'spread')];
    def(defs, 'poison').mechanics.effects = [binding('cn.transferCounters@1', kind, 'kind')];
    def(defs, 'research').mechanics.effects = [binding('cn.transferCounters@1', each, 'each')];
    def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.transferCounters@1', toSelf, 'pull')];
  });
  let x, y;
  const g = play(f, 'potion', (s) => { s.players[0].active.counters = 3; x = bench(s, 0, 'other'); y = bench(s, 0, 'other'); });
  answer(g, [g.snapshot().players[0].active.id]); answer(g, ['2']);
  answer(g, [x.id]);
  assert.equal(g.snapshot().pending.kind, 'counter-destination', 'The second counter has its own destination.');
  answer(g, [y.id]); settle(g);
  let s = g.snapshot();
  assert.deepEqual([s.players[0].active.counters, s.players[0].bench[0].counters, s.players[0].bench[1].counters], [1, 1, 1]);
  assert.deepEqual(restore(g, f).snapshot(), s);
  let flame, flame2;
  const k = play(f, 'poison', (s) => {
    s.players[0].active.counters = 2; flame = bench(s, 0, 'other'); flame.counters = 2; flame2 = bench(s, 0, 'other');
  });
  assert.deepEqual(k.snapshot().pending.options, [flame.id], 'Only a Fire origin.');
  answer(k, [flame.id]);
  assert.deepEqual(k.snapshot().pending.options, [flame2.id], 'Only another Fire destination.');
  answer(k, [flame2.id]); settle(k);
  let mon, them;
  const h = board(f, (s) => {
    const w = s.players[0].deck.findIndex((id) => s.cards[id].definitionId === 'water');
    s.players[0].active.energy.push(s.players[0].deck.splice(w, 1)[0]);
    mon = bench(s, 0, 'other'); mon.counters = 2;
  });
  command(h, { type: 'attack', attackId: 'base:strike' }); settle(h);
  s = h.snapshot();
  assert.deepEqual([s.players[0].active.counters, s.players[0].bench[0].counters], [1, 1], 'Onto the attacking Pokémon.');
  const r = play(f, 'research', (s) => {
    s.players[0].active.counters = 3; bench(s, 0, 'other').counters = 1; bench(s, 0, 'other'); them = bench(s, 1, 'other');
  });
  answer(r, [them.id]); settle(r);
  s = r.snapshot();
  assert.deepEqual([s.players[0].active.counters, ...s.players[0].bench.map((m) => m.counters), s.players[1].bench[0].counters], [1, 0, 0, 3]);
});
