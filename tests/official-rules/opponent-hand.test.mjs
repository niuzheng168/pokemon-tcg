// Synthetic definitions only. The opponent's hand (II.C-20 查看; II.D-04 文例2 不看正面选择; II.E-33 对手自己选择):
// looking at it and moving printed cards, face-down picks, the opponent's own choice, and counts read after a look.
// No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, assertSupportedDefinition } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const lit = (value) => ({ kind: 'literal', value });
const handlers = createCoreHandlers();
const valid = (id, p) => handlers.get(id).validateParameters(clone(p));
const playable = (g, card) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card);
const ANY = { kind: 'any' };
const hidden = (mode, quantity, to, selector = ANY) => ({ mode, selector, quantity, to });
const look = (selector, quantity, to) => ({ mode: 'look', selector, quantity, to });
const items = { kind: 'trainer', categories: ['item'] };
const basics = { kind: 'pokemon', stages: ['basic'] };
// The opponent's hand holds exactly these fixture cards; the rest go back to their deck.
function setHand(s, owner, ids) { const p = s.players[owner]; p.deck.push(...p.hand); p.hand = []; return ids.map((id) => hand(s, owner, id)); }
const ids = (cards) => cards.map((c) => c.instanceId).sort();
const canonical = (value) => JSON.stringify([...value].sort());
const item = (effects) => (defs) => { def(defs, 'potion').mechanics.effects = effects; };
const withAttack = (effects) => (defs) => {
  for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 500; d.mechanics.weakness = null; d.mechanics.resistance = null; }
  const a = defs[0].mechanics.attacks[0]; a.printedDamage = null; a.effects = effects;
};
const attack = (g) => command(g, { type: 'attack', attackId: 'base:strike' });
// After an attack the opponent's turn begins with a draw: count only the cards set up here.
const kept = (g, cards) => cards.filter((id) => g.snapshot().players[1].hand.includes(id));

test('schemas: look (and choose), face-down picks, the opponent\'s own choice; the rule cites C-20, D-04 文例2 and E-33', () => {
  const sections = requireRule(CN_V20261019, 'effects.opponent-hand').sourceOfTruth.map((s) => s.section).join('; ');
  for (const s of ['II.C-20', 'II.D-04 文例2', 'II.E-33']) assert(sections.includes(s));
  for (const p of [{ mode: 'look' }, look(items, { kind: 'upTo', count: 2 }, 'discard'), look(basics, { kind: 'any' }, 'bench'),
    look(ANY, { kind: 'exact', count: 1 }, 'deckBottom'), look(ANY, { kind: 'exact', count: 2 }, 'deckBottom'), look({ kind: 'trainer' }, { kind: 'all' }, 'discard'),
    look(ANY, { kind: 'leave', count: 3 }, 'deckShuffle'), hidden('faceDown', { kind: 'exact', count: 2 }, 'deckShuffle'),
    hidden('opponentChooses', { kind: 'exact', count: 2 }, 'discard'), hidden('opponentChooses', { kind: 'leave', count: 4 }, 'discard'),
    hidden('opponentChooses', { kind: 'upTo', count: 1 }, 'deckShuffle', { kind: 'energy' })])
    assert(valid('cn.opponentHand@1', p), JSON.stringify(p));
  for (const p of [{ mode: 'peek' }, { mode: 'look', to: 'discard' }, { mode: 'look', selector: ANY }, { mode: 'faceDown' },
    { op: 'opponentHand', mode: 'look' }, hidden('faceDown', { kind: 'exact', count: 1 }, 'discard', items),
    hidden('faceDown', { kind: 'upTo', count: 1 }, 'discard'), hidden('faceDown', { kind: 'exact', count: 1 }, 'deckBottom'),
    look({ kind: 'pokemon' }, { kind: 'upTo', count: 2 }, 'bench'), look(basics, { kind: 'all' }, 'bench'),
    hidden('opponentChooses', { kind: 'exact', count: 1 }, 'deckBottom'), look(ANY, { kind: 'all' }, 'deckBottom'),
    look(items, { kind: 'leave', count: 2 }, 'discard'), look(ANY, { kind: 'leave', count: 61 }, 'discard')])
    assert(!valid('cn.opponentHand@1', p), JSON.stringify(p));
  assert(valid('cn.countedHandLook@1', { mode: 'look' }));
  assert(!valid('cn.countedHandLook@1', look(items, { kind: 'all' }, 'discard')));
  assert(valid('cn.coin@1', { outcome: 'heads', effect: { handlerId: 'cn.opponentHand@1', parameters: hidden('faceDown', { kind: 'exact', count: 1 }, 'discard') } }));
});

test('「查看对手的手牌，选择其中最多2张物品，放于弃牌区」: only the user sees the hand; the chosen Items go to their owner\'s discard', async () => {
  const f = await fixture(item([binding('cn.opponentHand@1', look(items, { kind: 'upTo', count: 2 }, 'discard'), 'pluck')]));
  let card, theirs;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); theirs = setHand(s, 1, ['potion', 'poison', 'research', 'water']); });
  assert(playable(g, card));
  command(g, { type: 'playTrainer', cardId: card });
  const q = g.view(0).pending;
  assert.deepEqual([q.kind, [...q.options].sort(), q.minimum, q.maximum], ['select-cards', [theirs[0], theirs[1]].sort(), 1, 2]);
  assert.deepEqual(ids(q.lookedAt), [...theirs].sort());
  assert.equal(g.view(1).pending, null);
  const seen = (v) => v.events.some((e) => e.ruleId === 'effects.opponent-hand' && Array.isArray(e.data.cards) && e.data.cards.length === 4);
  assert(seen(g.view(0)));
  restore(g, f);
  assert.throws(() => answer(g, [theirs[2]]), (e) => e.code === 'invalid-choice');
  answer(g, [theirs[1]]); settle(g);
  const s = g.snapshot();
  assert(s.players[1].discard.includes(theirs[1]) && !s.players[1].hand.includes(theirs[1]) && s.players[1].hand.length === 3);
  assert(!seen(g.view(1)), 'The looked-at list is the user\'s own record.');
  // No Item there: the user still looks, confirms, and nothing moves.
  const none = board(f, (s) => { card = hand(s, 0, 'potion'); theirs = setHand(s, 1, ['research', 'water']); });
  command(none, { type: 'playTrainer', cardId: card });
  assert.deepEqual([none.view(0).pending.kind, ids(none.view(0).pending.lookedAt)], ['view-cards', [...theirs].sort()]);
  restore(none, f);
  settle(none);
  assert.deepEqual([...none.snapshot().players[1].hand].sort(), [...theirs].sort());
  // An empty hand offers nothing to look at.
  assert(!playable(board(f, (s) => { card = hand(s, 0, 'potion'); setHand(s, 1, []); }), card));
});

test('a look that tampers with the saved hand cannot be restored', async () => {
  const f = await fixture(item([binding('cn.opponentHand@1', { mode: 'look' }, 'peek')]));
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); setHand(s, 1, ['research', 'water']); });
  command(g, { type: 'playTrainer', cardId: card });
  const s = g.snapshot();
  assert.equal(s.pending.kind, 'view-cards');
  s.players[1].hand.reverse();
  assert.throws(() => OfficialGame.restore(s, { catalog: f.catalog }), (e) => e.code === 'invalid-card-selection');
  settle(g);
  assert.equal(g.snapshot().players[1].hand.length, 2);
});

test('Basic Pokémon onto the opponent\'s Bench up to its spaces; one card to the bottom of their deck', async () => {
  const called = await fixture(item([binding('cn.opponentHand@1', look(basics, { kind: 'upTo', count: 2 }, 'bench'), 'call')]));
  // Enough Basic Pokémon for a nearly full Bench besides the hand.
  const f = { ...called, deck: [...called.deck.slice(0, 56), 'printing:base', 'printing:base', 'printing:other', 'printing:other'] };
  let card, theirs;
  const g = board(f, (s) => {
    card = hand(s, 0, 'potion'); theirs = setHand(s, 1, ['base', 'other', 'evolution']);
    for (const id of ['base', 'base', 'other', 'other']) bench(s, 1, id);
  });
  command(g, { type: 'playTrainer', cardId: card });
  const q = g.view(0).pending;
  assert.deepEqual([[...q.options].sort(), q.maximum], [[theirs[0], theirs[1]].sort(), 1]);
  answer(g, [theirs[1]]); settle(g);
  const s = g.snapshot();
  assert.deepEqual([s.players[1].bench.length, s.players[1].bench[4].stack], [5, [theirs[1]]]);
  assert(s.events.some((e) => e.ruleId === 'effects.deploy' && e.data.player === 1 && e.data.cardId === theirs[1]));
  const bottom = await fixture(item([binding('cn.opponentHand@1', look({ kind: 'trainer', categories: ['supporter'] },
    { kind: 'exact', count: 1 }, 'deckBottom'), 'bottom')]));
  const h = board(bottom, (s) => { card = hand(s, 0, 'potion'); theirs = setHand(s, 1, ['research', 'water']); });
  command(h, { type: 'playTrainer', cardId: card });
  settle(h);
  const t = h.snapshot().players[1];
  assert.deepEqual([t.deck[0], t.hand], [theirs[0], [theirs[1]]]);
  const moved = h.snapshot().events.find((e) => e.ruleId === 'effects.opponent-hand' && e.data.to === 'deckBottom');
  assert.deepEqual([moved.data.count, Object.hasOwn(moved.data, 'cards')], [1, false]);
});

test('II.D-04 文例2: face-down picks are random, seen by the user, the closest count when fewer are held', async () => {
  const f = await fixture(withAttack([binding('cn.opponentHand@1', hidden('faceDown', { kind: 'exact', count: 1 }, 'discard'), 'snatch')]));
  let theirs;
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); theirs = setHand(s, 1, ['research', 'potion', 'poison']); });
  attack(g); settle(g);
  const s = g.snapshot(), gone = theirs.filter((id) => s.players[1].discard.includes(id));
  assert.deepEqual([gone.length, kept(g, theirs).length], [1, 2]);
  assert(g.view(0).events.some((e) => e.ruleId === 'effects.opponent-hand' && canonical(e.data.picked) === canonical(gone)));
  assert(!g.view(1).events.some((e) => Object.hasOwn(e.data, 'picked')));
  restore(g, f);
  const shuffle = await fixture(withAttack([binding('cn.opponentHand@1', hidden('faceDown', { kind: 'exact', count: 2 }, 'deckShuffle'), 'scare')]));
  const h = board(shuffle, (s) => { attached(s, 0, s.players[0].active, 'water'); theirs = setHand(s, 1, ['research']); });
  const deck = h.snapshot().players[1].deck.length;
  attack(h); settle(h);
  assert.deepEqual([kept(h, theirs).length, h.snapshot().players[1].deck.length], [0, deck + 1 - 1]);
  assert(h.snapshot().events.some((e) => e.ruleId === 'effects.shuffle' && e.data.player === 1));
  const empty = board(shuffle, (s) => { attached(s, 0, s.players[0].active, 'water'); setHand(s, 1, []); });
  attack(empty); settle(empty);
  assert(!empty.snapshot().events.some((e) => e.ruleId === 'effects.opponent-hand'));
});
test('II.E-33: the opponent chooses from their own hand; 「直到手牌变为N张」 is exact; a named kind may be fewer', async () => {
  const f = await fixture(withAttack([binding('cn.opponentHand@1', hidden('opponentChooses', { kind: 'exact', count: 2 }, 'discard'), 'toss')]));
  let theirs;
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); theirs = setHand(s, 1, ['research', 'potion', 'water']); });
  attack(g);
  assert.equal(g.view(0).pending, null);
  const q = g.view(1).pending;
  assert.deepEqual([q.kind, [...q.options].sort(), q.minimum, q.maximum, q.allowZero], ['select-cards', [...theirs].sort(), 2, 2, false]);
  restore(g, f);
  answer(g, [theirs[0], theirs[2]]); settle(g);
  assert.deepEqual(kept(g, theirs), [theirs[1]]);
  const leave = await fixture(item([binding('cn.opponentHand@1', hidden('opponentChooses', { kind: 'leave', count: 2 }, 'deckShuffle'), 'trim')]));
  let card;
  const h = board(leave, (s) => { card = hand(s, 0, 'potion'); theirs = setHand(s, 1, ['research', 'potion', 'water', 'base', 'other']); });
  assert(playable(h, card));
  command(h, { type: 'playTrainer', cardId: card });
  assert.deepEqual([h.view(1).pending.minimum, h.view(1).pending.maximum], [3, 3]);
  settle(h);
  assert.equal(h.snapshot().players[1].hand.length, 2);
  const shuffled = h.snapshot().events.find((e) => e.ruleId === 'effects.opponent-hand' && e.data.to === 'deckShuffle');
  assert.deepEqual([shuffled.data.count, Object.hasOwn(shuffled.data, 'cards')], [3, false]);
  assert(!playable(board(leave, (s) => { card = hand(s, 0, 'potion'); setHand(s, 1, ['research', 'water']); }), card), 'Already at two: no change.');
  const named = await fixture(withAttack([binding('cn.opponentHand@1', hidden('opponentChooses', { kind: 'exact', count: 1 }, 'discard',
    { kind: 'energy' }), 'named')]));
  const n = board(named, (s) => { attached(s, 0, s.players[0].active, 'water'); theirs = setHand(s, 1, ['water', 'research']); });
  attack(n);
  assert.deepEqual([n.view(1).pending.options, n.view(1).pending.minimum, n.view(1).pending.allowZero], [[theirs[0]], 0, true]);
  settle(n);
  assert.equal(kept(n, theirs).length, 2);
  const nothing = board(named, (s) => { attached(s, 0, s.players[0].active, 'water'); theirs = setHand(s, 1, ['research']); });
  attack(nothing);
  assert.notEqual(nothing.snapshot().pending?.ruleId, 'effects.opponent-hand', 'No energy held: nothing to choose, no prompt.');
  settle(nothing);
  assert.equal(kept(nothing, theirs).length, 1);
});

test('II.B-02: 「查看对手的手牌，造成其中训练家张数×N伤害」 counts the looked-at hand before damage', async () => {
  const counted = (formula) => withAttack([binding('cn.countedHandLook@1', { mode: 'look' }, 'look'),
    binding('cn.damageValue@1', { expression: formula }, 'formula')]);
  const moved = (selector) => ({ kind: 'movedCards', effectId: 'fixture:look', selector });
  const dealt = (f, cards) => {
    const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); setHand(s, 1, cards); });
    const from = g.snapshot().events.length;
    attack(g);
    if (cards.length) assert.equal(g.view(0).pending.kind, 'view-cards');
    settle(g);
    restore(g, f);
    return g.snapshot().events.slice(from).filter((e) => e.ruleId === 'attack.order' && Object.hasOwn(e.data, 'damage'))
      .reduce((n, e) => n + e.data.damage, 0);
  };
  const trainers = await fixture(counted({ kind: 'multiply', left: lit(30), right: moved({ kind: 'trainer' }) }));
  assert.equal(dealt(trainers, ['research', 'potion', 'water']), 60);
  assert.equal(dealt(trainers, []), 0);
  const energy = await fixture(counted({ kind: 'choose', condition: { kind: 'compare', left: moved({ kind: 'energy' }), relation: 'gt', right: lit(0) },
    ifTrue: lit(90), ifFalse: lit(20) }));
  assert.deepEqual([dealt(energy, ['research', 'water']), dealt(energy, ['research'])], [90, 20]);
});

test('load guard: the opponent\'s hand faces are counted only after a printed look earlier in the same program', async () => {
  const catalog = { handler: (id) => handlers.get(id) };
  const supporters = { kind: 'zoneCount', side: 'opponent', zone: 'hand', selector: { kind: 'trainer', categories: ['supporter'] } };
  const draw = binding('cn.drawValue@1', { count: { kind: 'multiply', left: lit(2), right: supporters } }, 'draw');
  const peek = binding('cn.opponentHand@1', { mode: 'look' }, 'peek');
  const f = await fixture(item([peek, draw]));
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); setHand(s, 1, ['research', 'water']); });
  const before = g.snapshot().players[0].hand.length;
  command(g, { type: 'playTrainer', cardId: card }); settle(g);
  assert.equal(g.snapshot().players[0].hand.length, before - 1 + 2);
  const potion = def(f.definitions, 'potion');
  const withEffects = (effects, extra = {}) => ({ ...clone(potion), mechanics: { ...clone(potion.mechanics), effects, ...extra } });
  assert.doesNotThrow(() => assertSupportedDefinition(catalog, withEffects([peek, draw])));
  for (const d of [withEffects([draw, peek]), withEffects([draw]),
    withEffects([peek], { condition: { predicate: { kind: 'compare', left: supporters, relation: 'gt', right: lit(0) } } })])
    assert.throws(() => assertSupportedDefinition(catalog, d), (e) => e.code === 'unsupported-condition');
  const mon = clone(def(f.definitions, 'base'));
  mon.mechanics.attacks[0].effects = [binding('cn.opponentHand@1', { mode: 'look' }, 'peek'),
    binding('cn.damageValue@1', { expression: supporters }, 'formula')];
  assert.throws(() => assertSupportedDefinition(catalog, mon), (e) => e.code === 'unsupported-condition');
  mon.mechanics.attacks[0].effects = [];
  mon.mechanics.abilities = [{ abilityId: 'fixture:peek', name: '测试窥视', mode: 'activated', sourceOfTruth: EVIDENCE,
    usage: { period: 'turn', scope: 'pokemon', key: 'fixture:peek', limit: 1 }, effects: [peek, draw] }];
  assert.doesNotThrow(() => assertSupportedDefinition(catalog, mon));
});

test('nested: a coin opens a face-down discard; 「抽2张。然后，在不看正面的前提下…」 after a draw; the handler\'s own eligibility', async () => {
  const snatch = { handlerId: 'cn.opponentHand@1', parameters: hidden('faceDown', { kind: 'exact', count: 1 }, 'discard') };
  const f = await fixture(item([binding('cn.then@1', { first: { handlerId: 'cn.draw@1', parameters: { count: 2 } }, next: snatch }, 'then')]));
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); setHand(s, 1, ['research', 'water']); });
  command(g, { type: 'playTrainer', cardId: card }); settle(g);
  assert.equal(g.snapshot().players[1].hand.length, 1);
  const coin = await fixture(withAttack([binding('cn.coin@1', { outcome: 'heads', effect: snatch }, 'coin')]));
  const results = new Set();
  for (const seed of [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16]]) {
    let theirs;
    const h = board({ ...coin, seed }, (s) => { attached(s, 0, s.players[0].active, 'water'); theirs = setHand(s, 1, ['research', 'water']); });
    attack(h); settle(h);
    const heads = h.snapshot().events.find((e) => e.ruleId === 'effects.coin').data.result === 'heads';
    assert.equal(kept(h, theirs).length, heads ? 1 : 2);
    results.add(heads);
  }
  assert.equal(results.size, 2, 'Both coin results occur among these seeds.');
  const h = handlers.get('cn.opponentHand@1');
  const ctx = (n) => ({ source: { owner: 0 }, state: { players: [{ hand: [] }, { hand: Array.from({ length: n }, (_, i) => `c${i}`) }] } });
  const trim = hidden('opponentChooses', { kind: 'leave', count: 3 }, 'discard');
  assert.deepEqual([h.canUse(ctx(0), { mode: 'look' }), h.canUse(ctx(1), { mode: 'look' }), h.canUse(ctx(3), trim), h.canUse(ctx(4), trim)],
    [false, true, false, true]);
});
