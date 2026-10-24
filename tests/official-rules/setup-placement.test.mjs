// Synthetic definitions only. setup.placement: 「在对战准备中要将宝可梦放于战斗场时，如果这张卡牌在手牌中的话，则可反面朝上放于战斗场上。」,
// 「如果自己是后攻玩家，则在对战准备中将宝可梦放于场上时，可将这张卡牌从手牌以反面朝上的状态放于场上。」 and the Item 「在对战准备中要将宝可梦
// 放于场上时，如果这张卡牌在手牌中的话，则可将这张卡牌作为HP为120属性为【无】的【基础】宝可梦，反面朝上放于场上。（这张卡牌，在对战准备以外无法
// 放于场上。）」 (JP Q&A レントラー／ライボルト／カビゴンドール: with no Basic Pokémon in hand the player may put it there or redraw). No actual card
// is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, EVIDENCE, RULESET, answer, settle, board, hand } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const handlers = createCoreHandlers();
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const rule = (id, parameters) => ({ abilityId: `${id}:start`, name: '测试出场', mode: 'continuous', usage: null, sourceOfTruth: EVIDENCE,
  effects: [binding('cn.setupPlacement@1', parameters, `${id}:start`)] });
// 'evolution' (a Stage 1): the second player's, anywhere; 'stage2': the Active Spot only; 'doll': the setup-only Item.
async function make() {
  const f = await fixture((defs) => {
    const e = def(defs, 'evolution');
    e.mechanics.abilities = [rule('evolution', { position: 'field', secondPlayer: true })];
    defs.push({ ...e, definitionId: 'stage2', name: '测试2阶进化', nameKey: 'stage2', mechanics: { ...e.mechanics, stage: 'stage2',
      evolvesFrom: 'evolution', basicAncestor: { nameKey: 'base', sourceOfTruth: EVIDENCE }, abilities: [rule('stage2', { position: 'active' })] } });
    defs.push({ ...def(defs, 'base'), definitionId: 'doll', name: '测试娃娃', nameKey: 'doll', mechanics: { ...def(defs, 'base').mechanics,
      hp: 120, types: ['Colorless'], weakness: null, retreatCost: 0, attacks: [], prizeCount: 0,
      itemCard: { leave: { from: 'field', to: 'discard' }, setupOnly: true, sourceOfTruth: EVIDENCE } } });
  });
  for (const id of ['evolution', 'stage2', 'stage2', 'stage2', 'stage2', 'doll', 'doll', 'doll', 'doll'])
    f.deck[f.deck.indexOf('printing:water')] = `printing:${id}`;
  return f;
}
// Player 0 goes first; each player's opening hand is the given cards (then Water).
function begin(f, hands, seed = f.seed) {
  const g = new OfficialGame({ ruleset: RULESET, catalog: f.catalog, decks: [f.deck, f.deck], seed }), s = g.snapshot();
  for (const [owner, ids] of hands.entries()) {
    const p = s.players[owner], top = [];
    for (const id of [...ids, ...Array(7 - ids.length).fill('water')]) top.push(...p.deck.splice(p.deck.findIndex((x) => s.cards[x].definitionId === id && !top.includes(x)), 1));
    p.deck.push(...top);
  }
  const r = OfficialGame.restore(s, { catalog: f.catalog });
  answer(r, [s.pending.player === 0 ? 'first' : 'second']);
  return r;
}
const ids = (g, owner, id) => g.snapshot().players[owner].hand.filter((x) => g.snapshot().cards[x].definitionId === id);
const at = (g) => g.snapshot().pending;
const named = (g, m) => g.snapshot().cards[m.stack[0]].definitionId;

test('schema: a Pokémon\'s own printed rule, read from the hand', async () => {
  const valid = handlers.get('cn.setupPlacement@1').validateParameters;
  assert(valid({ position: 'active' })); assert(valid({ position: 'field', secondPlayer: true }));
  assert(!valid({ position: 'bench' })); assert(!valid({ position: 'active', secondPlayer: false }));
  const f = await fixture((defs) => { def(defs, 'evolution').mechanics.effects = [binding('cn.setupPlacement@1', { position: 'active' })]; });
  assert.throws(() => board(f), /own printed rule/);
});

test('「…则可反面朝上放于战斗场上」: with no Basic Pokémon the player chooses; the Active Spot only, never the Bench', async () => {
  const f = await make();
  const g = begin(f, [['stage2', 'stage2'], ['base']]);
  let q = at(g);
  assert.deepEqual([q.kind, q.player, q.options], ['setup-start', 0, ['place', 'mulligan']]);
  assert.equal(g.view(1).pending, null, 'The opponent does not see the choice.');
  const redraw = restore(g, f);
  answer(g, ['place']);
  q = at(g);
  assert.equal(q.kind, 'setup-active'); assert.deepEqual(q.options, ids(g, 0, 'stage2'));
  restore(g, f);
  answer(g, [q.options[0]]);
  settle(g, (q) => q.kind === 'setup-bench' ? q.options.filter((id) => g.snapshot().cards[id].definitionId !== 'water') : q.options.slice(0, q.minimum));
  let s = g.snapshot();
  assert.equal(named(g, s.players[0].active), 'stage2');
  assert.deepEqual(s.players[0].bench, [], 'Not onto the Bench.');
  assert(!s.events.some((e) => e.ruleId === 'setup.mulligan' && e.data.player === 0));
  // Declined: shown and redrawn, the opponent drawing extra.
  answer(redraw, ['mulligan']);
  settle(redraw, (q) => q.kind === 'setup-start' ? ['mulligan'] : q.options.slice(0, q.minimum));
  s = redraw.snapshot();
  assert(s.events.some((e) => e.ruleId === 'setup.mulligan' && e.data.player === 0 && !e.data.shared));
  assert(s.setup.bonus[1] >= 1);
});

test('「如果自己是后攻玩家…可将这张卡牌…放于场上」: the second player, both spots; the first player redraws', async () => {
  const f = await make();
  const g = begin(f, [['evolution'], ['evolution']]);
  // The first player's only Pokémon may not be put there: a plain redraw, never asked.
  assert.deepEqual([at(g).kind, at(g).player], ['setup-start', 1]);
  assert(g.snapshot().events.some((e) => e.ruleId === 'setup.placement' && e.data.player === 0 && e.data.start === false));
  answer(g, ['place']);
  settle(g, (q) => q.kind === 'setup-active' && q.player === 1 ? ids(g, 1, 'evolution').slice(0, 1) :
    q.kind === 'setup-bench' && q.player === 1 ? ids(g, 1, 'evolution') : q.kind === 'setup-start' ? ['mulligan'] : q.options.slice(0, q.minimum));
  const s = g.snapshot();
  assert.equal(named(g, s.players[1].active), 'evolution');
  assert(s.events.some((e) => e.ruleId === 'setup.mulligan' && e.data.player === 0));
  assert(s.players[1].bench.every((m) => ['evolution', 'base', 'other'].includes(named(g, m))));
  restore(g, f);
});

test('the setup-only Item: Active and Bench in setup, never from the hand afterwards', async () => {
  const f = await make();
  const g = begin(f, [['doll', 'doll'], ['base']]);
  answer(g, ['place']);
  answer(g, [ids(g, 0, 'doll')[0]]);
  assert.deepEqual(at(g).options, ids(g, 0, 'doll'));
  answer(g, at(g).options); settle(g);
  const s = g.snapshot();
  assert.equal(named(g, s.players[0].active), 'doll'); assert.equal(named(g, s.players[0].bench[0]), 'doll');
  restore(g, f);
  let card;
  const later = board(f, (s) => { card = hand(s, 0, 'doll'); });
  assert(!later.view(0).legalActions.some((a) => a.cardId === card), '「在对战准备以外无法放于场上」');
});

test('both players with only such cards decide in turn; both redrawing is a shared mulligan', async () => {
  const f = await make();
  const g = begin(f, [['doll'], ['stage2']]);
  assert.equal(at(g).player, 0); answer(g, ['mulligan']);
  assert.deepEqual([at(g).kind, at(g).player], ['setup-start', 1]);
  const told = g.snapshot().events.filter((e) => e.ruleId === 'setup.placement');
  assert.deepEqual(told.map((e) => [e.visibility, e.data]), [['public', { player: 0, start: false }]], 'I.G.5: the first player told first.');
  restore(g, f);
  answer(g, ['mulligan']);
  const shared = g.snapshot().events.filter((e) => e.ruleId === 'setup.mulligan' && e.data.shared);
  assert.equal(shared.length, 2);
});

test('a redrawn hand with only such a card is asked again', async () => {
  const f = await make();
  let asked = 0, declined = 0;
  for (let seed = 1; seed <= 40 && !(asked && declined); seed++) {
    const g = begin(f, [['water'], ['base']], [seed, seed * 7, seed * 13, seed * 31]);
    settle(g, (q) => {
      if (q.kind !== 'setup-start') return q.options.slice(0, q.minimum);
      assert.equal(q.player, 0);
      if (asked) { declined++; return ['mulligan']; }
      asked++; restore(g, f); return ['place'];
    });
    assert(g.snapshot().players[0].active);
  }
  assert(asked && declined);
});
