// Synthetic definitions only. 「选择自己牌库中最多2张【基础】宝可梦或1张进化宝可梦，在给对手看过之后加入手牌。并重洗牌库。」 and
// 「选择自己弃牌区中最多2张宝可梦，和最多2张基本能量，在给对手看过之后，放回牌库并重洗牌库。（可只选择宝可梦或只选择基本能量。）」
// (II.D-04, II.D-05). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { matchesAlternativeLimits, matchesCardSelector } from '../../public/rules/card-selection.js';
import { fixture, binding, board, command, answer, settle, hand } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const set = (id, mechanics) => (defs) => { Object.assign(defs.find((d) => d.definitionId === id).mechanics, mechanics); };
const basicOrEvolution = { anyOf: [{ kind: 'pokemon', stages: ['basic'] }, { kind: 'pokemon', stages: ['stage1', 'stage2'] }] };
const pokemonAndEnergy = { anyOf: [{ kind: 'pokemon' }, { kind: 'energy', category: 'basic' }] };
const search = { from: 'deck', to: 'hand', selector: basicOrEvolution, quantity: { kind: 'upTo', count: 2 },
  alternativeLimits: [2, 1], exclusiveAlternatives: true, reveal: true, lookTop: null, shuffleAfter: true };
const recover = { from: 'discard', to: 'deck', selector: pokemonAndEnergy, quantity: { kind: 'upTo', count: 4 },
  alternativeLimits: [2, 2], reveal: true, lookTop: null, shuffleAfter: true };
const into = (s, zone, keys) => {
  const ids = keys.map((key) => hand(s, 0, key)), p = s.players[0];
  for (const id of ids) { p.hand.splice(p.hand.indexOf(id), 1); p[zone].unshift(id); }
  return ids;
};

test('schema: one limit per alternative; the total is the sum, or the largest limit when exclusive', () => {
  const valid = (p) => createCoreHandlers().get('cn.cards@1').validateParameters(p);
  assert(valid(search)); assert(valid(recover));
  for (const p of [{ ...search, quantity: { kind: 'upTo', count: 3 } }, { ...recover, quantity: { kind: 'upTo', count: 2 } },
    { ...search, alternativeLimits: [2, 1, 1] }, { ...search, selector: { kind: 'pokemon' } }, { ...recover, quantity: { kind: 'exact', count: 4 } },
    { ...recover, alternativeLimits: undefined, exclusiveAlternatives: true }, { ...recover, onePerAlternative: true }])
    assert(!valid(JSON.parse(JSON.stringify(p))), JSON.stringify(p));
  assert.throws(() => matchesAlternativeLimits([], basicOrEvolution, [1, 1, 1]), TypeError);
});

test('「「连击」卡」: an Energy selector reads a Special Energy\'s printed tags', async () => {
  const f = await fixture();
  const energy = (tags) => ({ ...f.definitions.find((d) => d.definitionId === 'double'), mechanics: { ...f.definitions.find((d) => d.definitionId === 'double').mechanics, ...(tags ? { tags } : {}) } });
  const rapid = { kind: 'energy', tagsAll: ['Rapid Strike'] };
  assert.equal(matchesCardSelector(energy(['Rapid Strike']), rapid), true);
  assert.equal(matchesCardSelector(energy(['Single Strike']), rapid), false);
  assert.equal(matchesCardSelector(energy(null), rapid), false);
});

test('「最多2张【基础】宝可梦或1张进化宝可梦」: two Basics, or one Evolution, never a mix', async () => {
  const f = await fixture(set('potion', { effects: [binding('cn.cards@1', search, 'dig')] }));
  let card, ids;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); ids = into(s, 'deck', ['other', 'other', 'evolution']); });
  command(g, { type: 'playTrainer', cardId: card });
  const [b1, b2, e1] = ids, mid = g.snapshot();
  assert.throws(() => answer(OfficialGame.restore(clone(mid), { catalog: f.catalog }), [b1, e1]), (e) => e.code === 'invalid-card-selection');
  assert.throws(() => answer(OfficialGame.restore(clone(mid), { catalog: f.catalog }), [b1, b2, e1]), 'Three is over the largest limit.');
  answer(g, [e1]); settle(g);
  assert(g.snapshot().players[0].hand.includes(e1));
  const h = OfficialGame.restore(clone(mid), { catalog: f.catalog });
  answer(h, [b1, b2]); settle(h);
  assert([b1, b2].every((id) => h.snapshot().players[0].hand.includes(id)));
});

test('「最多2张宝可梦，和最多2张基本能量」 from the discard pile: up to two of each, at least one card', async () => {
  const f = await fixture(set('potion', { effects: [binding('cn.cards@1', recover, 'rod')] }));
  let card, ids;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); ids = into(s, 'discard', ['other', 'other', 'evolution', 'water', 'water']); });
  command(g, { type: 'playTrainer', cardId: card });
  const [p1, p2, p3, w1, w2] = ids, mid = g.snapshot();
  assert.equal(mid.pending.minimum, 1); assert.equal(mid.pending.maximum, 4);
  assert.throws(() => answer(OfficialGame.restore(clone(mid), { catalog: f.catalog }), [p1, p2, p3]), (e) => e.code === 'invalid-card-selection');
  answer(g, [p1, p3, w1, w2]); settle(g);
  assert.deepEqual(g.snapshot().players[0].discard.filter((id) => ids.includes(id)), [p2]);
  const broken = clone(mid); broken.pending.data.action = { ...broken.pending.data.action, quantity: { kind: 'upTo', count: 3 } };
  assert.throws(() => answer(OfficialGame.restore(broken, { catalog: f.catalog }), [p1]));
});

test('「选择自己的1张手牌，将剩余的手牌全部放于弃牌区。然后，从牌库上方抽取4张卡牌」: keep one; with only that one, still draw', async () => {
  const keep = { from: 'hand', to: 'discard', selector: { kind: 'any' }, quantity: { kind: 'leave', count: 1 }, reveal: false, lookTop: null, shuffleAfter: false };
  const valid = (p) => createCoreHandlers().get('cn.cards@1').validateParameters(clone(p));
  assert(valid(keep));
  for (const p of [{ ...keep, from: 'deck', lookTop: 3 }, { ...keep, selector: { kind: 'pokemon' } }, { ...keep, to: 'hand' }]) assert(!valid(p), JSON.stringify(p));
  const f = await fixture(set('potion', { effects: [binding('cn.then@1', { first: { handlerId: 'cn.cards@1', parameters: keep },
    next: { handlerId: 'cn.draw@1', parameters: { count: 4 } } }, 'mallow')] }));
  let card, kept;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); [kept] = into(s, 'hand', ['other']); into(s, 'hand', ['water', 'tool']); });
  const before = g.snapshot().players[0].hand.length;
  command(g, { type: 'playTrainer', cardId: card });
  const q = g.snapshot().pending;
  assert.equal(q.minimum, before - 2); assert.equal(q.maximum, before - 2, 'All but one of the other hand cards.');
  answer(g, q.options.filter((id) => id !== kept)); settle(g);
  assert.equal(g.snapshot().players[0].hand.length, 5); assert(g.snapshot().players[0].hand.includes(kept));
  const k = board(f, (s) => { const p = s.players[0]; p.deck.push(...p.hand.splice(0)); card = hand(s, 0, 'potion'); [kept] = into(s, 'hand', ['other']); });
  command(k, { type: 'playTrainer', cardId: card }); settle(k);
  assert.equal(k.snapshot().players[0].hand.length, 5, 'Kept the only other card, then drew 4 (II.E-19).');
});
