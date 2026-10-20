// Synthetic definitions only. Shapes follow printed CN Trainer text: 「身上放有这张卡牌的【基础】宝可梦的
// 最大HP「+50」」, 「所有【2阶进化】宝可梦的最大HP，各「-30」」, 「选择自己牌库中「物品」和「宝可梦道具」各1张」
// and 「双方玩家，每次在自己的回合有1次机会，可选择……放于备战区」. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers, validateStadiumUseEffect } from '../../public/rules/handlers.js';
import { matchesOnePerAlternative } from '../../public/rules/card-selection.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, board, command, answer, settle, bench, hand } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const set = (id, mechanics) => (defs) => { Object.assign(defs.find((d) => d.definitionId === id).mechanics, mechanics); };
const maxHp = (g, owner, id) => {
  const p = g.view(owner).players[owner];
  return [p.active, ...p.bench].find((m) => m.id === id).effective.maxHp;
};
const deploy = (key) => binding('cn.stadiumUse@1', { key, effect: { handlerId: 'cn.cards@1', parameters: { from: 'deck', to: 'bench',
  selector: { kind: 'pokemon', stages: ['basic'] }, quantity: { kind: 'exact', count: 1 }, reveal: false, lookTop: null, shuffleAfter: true } } }, key);
const canUseStadium = (g, player = g.snapshot().current) => g.view(player).legalActions.some((a) => a.type === 'useStadium');

test('staple Trainer rules carry CN sources; malformed parameters are rejected', async () => {
  assert(requireRule(CN_V20261019, 'stadium.use').sourceOfTruth.length > 0);
  const handlers = createCoreHandlers();
  assert(handlers.get('cn.modifier@1').validateParameters({ field: 'hp', amount: 50, scope: 'self', stages: ['basic'] }));
  assert(!handlers.get('cn.modifier@1').validateParameters({ field: 'hp', amount: 50, scope: 'self', stages: [] }));
  assert(!handlers.get('cn.cards@1').validateParameters({ from: 'deck', to: 'hand', selector: { kind: 'trainer' },
    quantity: { kind: 'exact', count: 2 }, reveal: true, lookTop: null, shuffleAfter: true, onePerAlternative: true }));
  assert(!validateStadiumUseEffect({ key: 'k', effect: { handlerId: 'cn.switch@1', parameters: { side: 'own', chooser: 'self', affected: 'active' } } }));
  assert(!validateStadiumUseEffect({ key: 'k', effect: { handlerId: 'cn.cards@1', parameters: { from: 'deck' } } }));
  assert.throws(() => matchesOnePerAlternative([], { kind: 'trainer' }), TypeError);
});

test('「【基础】宝可梦的最大HP「+50」」 applies only while the holder is Basic; a Stage-wide Stadium -30 can Knock Out', async () => {
  const f = await fixture((defs) => {
    set('hp-tool', { effects: [binding('cn.modifier@1', { field: 'hp', amount: 50, scope: 'self', stages: ['basic'] })] })(defs);
    set('stadium', { effects: [binding('cn.modifier@1', { field: 'hp', amount: -30, scope: 'all', stages: ['stage1'] })] })(defs);
  });
  let mon;
  const g = board(f, (s) => { mon = s.players[0].active; mon.tools.push(hand(s, 0, 'hp-tool')); s.players[0].hand.pop(); hand(s, 0, 'evolution'); });
  assert.equal(maxHp(g, 0, mon.id), 150);
  const card = g.snapshot().players[0].hand.find((id) => g.snapshot().cards[id].definitionId === 'evolution');
  command(g, { type: 'evolve', cardId: card, pokemonId: mon.id }); settle(g);
  assert.equal(maxHp(g, 0, mon.id), 150, 'The Stage 1 printed 150, no +50.');
  // The Stage 1 -30 Stadium: 120 HP with 12 counters is Knocked Out when it is played.
  let damaged, stadium;
  const k = board(f, (s) => {
    damaged = bench(s, 1, 'evolution'); damaged.counters = 12; bench(s, 1, 'other');
    stadium = hand(s, 0, 'stadium');
  });
  assert.equal(maxHp(k, 1, damaged.id), 150);
  command(k, { type: 'playTrainer', cardId: stadium }); settle(k);
  assert(!k.snapshot().players[1].bench.some((m) => m.id === damaged.id));
  assert.equal(k.snapshot().players[0].prizes.length, 5);
});

test('II.D-04 文例4 「各1张」: one card for each alternative, never two of the same kind', async () => {
  const f = await fixture(set('research', { effects: [binding('cn.cards@1', { from: 'deck', to: 'hand',
    selector: { anyOf: [{ kind: 'trainer', categories: ['item'] }, { kind: 'trainer', categories: ['tool'] }] },
    quantity: { kind: 'exact', count: 2 }, onePerAlternative: true, reveal: true, lookTop: null, shuffleAfter: true })] }));
  let card;
  const g = board(f, (s) => {
    card = hand(s, 0, 'research');
    for (const key of ['potion', 'poison', 'tool']) { const id = hand(s, 0, key); s.players[0].hand.pop(); s.players[0].deck.unshift(id); }
  });
  command(g, { type: 'playTrainer', cardId: card });
  const s = g.snapshot(), of = (key) => s.pending.options.find((id) => s.cards[id].definitionId === key);
  assert.throws(() => answer(g, [of('potion'), of('poison')]), (e) => e.code === 'invalid-card-selection');
  const picks = [of('potion'), of('tool')];
  answer(g, picks); settle(g);
  assert(picks.every((id) => g.snapshot().players[0].hand.includes(id)));
  restore(g, f);
});

test('I.B-04 「每次在自己的回合有1次机会」: each player once per own turn, keyed by the Stadium card; a full Bench cannot use it', async () => {
  const f = await fixture((defs) => {
    set('stadium', { effects: [deploy('fixture:stadium-a')] })(defs);
    defs.find((d) => d.definitionId === 'poison').mechanics = { category: 'stadium', effects: [deploy('fixture:stadium-b')] };
  });
  let a, b;
  const g = board(f, (s) => { a = hand(s, 1, 'stadium'); s.players[1].hand.pop(); s.stadium = a; b = hand(s, 0, 'poison'); });
  assert(canUseStadium(g), "The opponent's Stadium can be used by the current player.");
  const take = (q) => q.options.slice(0, q.maximum);
  command(g, { type: 'useStadium' }); settle(g, take);
  assert.equal(g.snapshot().players[0].bench.length, 1);
  assert(!canUseStadium(g), 'Once this turn.');
  // A different Stadium card played afterwards has its own chance this turn.
  command(g, { type: 'playTrainer', cardId: b }); settle(g);
  assert(canUseStadium(g));
  command(g, { type: 'useStadium' }); settle(g, take);
  assert.equal(g.snapshot().players[0].bench.length, 2);
  command(g, { type: 'endTurn' }); settle(g);
  assert(canUseStadium(g, 1), 'The other player has its own chance on its turn.');
  restore(g, f);
  f.deck.splice(20, 2, 'printing:other', 'printing:other');
  const full = board(f, (s) => { s.stadium = hand(s, 1, 'stadium'); s.players[1].hand.pop();
    for (const key of ['base', 'other', 'other', 'other', 'other']) bench(s, 0, key); });
  assert(!canUseStadium(full), 'II.C-11: no Bench space, nothing could change.');
});
