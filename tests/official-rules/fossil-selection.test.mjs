// Synthetic definitions only. 「选择自己牌库中最多2张「稀有化石」，放于备战区。并重洗牌库。」 (pokemon.item-card: a named Item that can be
// put into play as a Basic Pokémon) and 「从自己牌库中，选择最多2张从名字中带有「化石」的物品进化而来的宝可梦，放于备战区。并重洗牌库。」
// (selection.evolves-from-item: the Items' names listed, Stage 1 Pokémon benched as printed). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { matchesCardSelector, matchesCardsMove, matchesDeploySelector } from '../../public/rules/card-selection.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, RULESET, board, command, settle, hand, bench } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();
const card = (id, name, kind, mechanics) => ({ schemaVersion: '1.0.0', definitionId: id, ruleset: RULESET, name, nameKey: id, kind,
  sourceOfTruth: EVIDENCE, implementation: { status: 'verified', testIds: ['fixture:test'] }, deckLimits: { sameName: 4, groups: [] }, mechanics });
const mon = (id, name, stage, evolvesFrom) => card(id, name, 'pokemon', { stage, evolvesFrom, hp: 100, types: ['Water'], weakness: null,
  resistance: null, retreatCost: 1, attacks: [], abilities: [], ruleBox: false, prizeCount: 1, tags: [], effects: [] });
// An Item played as a 60-HP Colorless Basic Pokémon.
const fossil = (id, name) => card(id, name, 'pokemon', { stage: 'basic', evolvesFrom: null, hp: 60, types: ['Colorless'], weakness: null,
  resistance: null, retreatCost: 0, attacks: [], abilities: [], ruleBox: false, prizeCount: 1, tags: [], effects: [],
  itemCard: { leave: { from: 'field', to: 'discard' }, sourceOfTruth: EVIDENCE } });
const pool = (defs) => {
  defs.push(fossil('rare', '测试稀有化石'), fossil('amber', '测试秘密琥珀'),
    card('relic', '测试化石道具', 'trainer', { category: 'item', effects: [binding('cn.draw@1', { count: 1 }, 'relic')] }),
    mon('helmet', '测试化石盔', 'basic', null), mon('blade', '测试镰刀盔', 'stage1', 'helmet'),
    mon('wing', '测试琥珀翼', 'stage1', 'amber'), mon('tablet', '测试化石兽', 'stage1', 'relic'));
  def(defs, 'evolution').mechanics.evolvesFrom = 'rare';
};
const CARDS = ['rare', 'rare', 'rare', 'amber', 'relic', 'helmet', 'blade', 'wing', 'tablet', 'evolution'];
async function withPool(effects, where = 'research') {
  const f = await fixture((defs) => { pool(defs); def(defs, where).mechanics.effects = effects; });
  f.deck.splice(20, CARDS.length, ...CARDS.map((id) => `printing:${id}`));
  return f;
}
const search = (selector, count = 2) => ({ from: 'deck', to: 'bench', selector, quantity: { kind: 'upTo', count }, reveal: false, lookTop: null, shuffleAfter: true });
// The fixture's Items named with 「化石」: the itemCard 「测试稀有化石」 and the plain Item 「测试化石道具」.
const FOSSILS = { kind: 'pokemon', evolvesFromNameKeys: ['rare', 'relic'] };
const RARE = { kind: 'trainer', nameKeys: ['rare'] };
const named = (s, ids) => ids.map((id) => s.cards[id].definitionId).sort();
// Every copy of these cards in player 0's deck (from the hand or the Prize cards), whatever the shuffle dealt.
function gather(s) {
  const p = s.players[0], ours = (id) => [...CARDS, 'research'].includes(s.cards[id].definitionId);
  p.deck.push(...p.hand.filter((id) => ours(id) && s.cards[id].definitionId !== 'research')); p.hand = p.hand.filter((id) => !ours(id) || s.cards[id].definitionId === 'research');
  p.prizes = p.prizes.map((id) => ours(id) ? (p.deck.push(id), p.deck.splice(p.deck.findIndex((x) => !ours(x)), 1)[0]) : id);
}

test('rules cite II.C-11; a Stage 1 named by what it evolves from, and a named Item played as a Pokémon, go onto the Bench', async () => {
  assert(requireRule(CN_V20261019, 'selection.evolves-from-item').sourceOfTruth.some((s) => s.section.includes('II.C-11')));
  const f = await withPool([]), d = (id) => f.catalog.definition(id);
  assert.deepEqual(['evolution', 'tablet', 'blade', 'wing', 'helmet', 'rare', 'base'].map((id) => matchesCardSelector(d(id), FOSSILS)),
    [true, true, false, false, false, false, false]);
  // Onto the Bench: a Stage 1 found by what it evolves from; the named fossil Item; never another named Item or an unnamed Item.
  assert(matchesCardsMove(d('evolution'), search(FOSSILS)));
  assert(matchesCardsMove(d('evolution'), search({ anyOf: [{ kind: 'pokemon', stages: ['basic'] }, FOSSILS] })));
  assert(matchesCardsMove(d('rare'), search(RARE)));
  assert(!matchesCardsMove(d('relic'), search({ kind: 'trainer', nameKeys: ['relic'] })));
  assert(!matchesDeploySelector(d('rare'), { kind: 'trainer', categories: ['item'] }));
  assert(!matchesDeploySelector(d('evolution'), { kind: 'pokemon', types: ['Water'] }), 'An unnamed Pokémon search benches Basic Pokémon only.');
  const valid = (p) => handlers.get('cn.cards@1').validateParameters(clone(p));
  assert(valid(search(RARE)) && valid(search(FOSSILS)));
  for (const bad of [{ kind: 'trainer', categories: ['item'] }, { kind: 'trainer' }, { kind: 'energy', nameKeys: ['water'] }])
    assert(!valid(search(bad)), JSON.stringify(bad));
});

test('「最多2张「稀有化石」，放于备战区」: each goes onto the Bench as the Basic Pokémon it is played as', async () => {
  const f = await withPool([binding('cn.cards@1', search(RARE), 'fossils')]);
  let supporter;
  const g = board(f, (s) => { supporter = hand(s, 0, 'research'); gather(s); });
  command(g, { type: 'playTrainer', cardId: supporter });
  const q = g.snapshot().pending;
  assert.deepEqual([named(g.snapshot(), q.options), q.maximum], [['rare', 'rare', 'rare'], 2]);
  restore(g, f);
  settle(g, (q) => q.options.slice(0, 2));
  const s = g.snapshot();
  assert.deepEqual(s.players[0].bench.map((m) => s.cards[m.stack[0]].definitionId), ['rare', 'rare']);
  assert.deepEqual(g.view(0).players[0].bench.map((m) => [m.effective.maxHp, m.effective.types]), [[60, ['Colorless']], [60, ['Colorless']]]);
  assert(s.events.some((e) => e.ruleId === 'effects.shuffle' && e.data.player === 0));
  restore(g, f);
  // Four on the Bench: one space left.
  const full = board(f, (s) => { supporter = hand(s, 0, 'research'); gather(s); for (const id of ['base', 'other', 'other', 'helmet']) bench(s, 0, id); });
  command(full, { type: 'playTrainer', cardId: supporter });
  assert.equal(full.snapshot().pending.maximum, 1);
});

test('「从名字中带有「化石」的物品进化而来的宝可梦」: Stage 1 Pokémon of fossil Items onto the Bench; not of a Pokémon or another Item', async () => {
  const f = await withPool([binding('cn.cards@1', search(FOSSILS), 'guide')]);
  let supporter;
  const g = board(f, (s) => { supporter = hand(s, 0, 'research'); gather(s); });
  command(g, { type: 'playTrainer', cardId: supporter });
  const q = g.snapshot().pending;
  assert.deepEqual(named(g.snapshot(), q.options), ['evolution', 'evolution', 'tablet'], 'Both copies of the Stage 1 of the fossil.');
  const of = (id) => g.snapshot().cards[id].definitionId;
  settle(g, (q) => [q.options.find((id) => of(id) === 'tablet'), q.options.find((id) => of(id) === 'evolution')]);
  const s = g.snapshot();
  assert.deepEqual(named(s, s.players[0].bench.map((m) => m.stack[0])), ['evolution', 'tablet']);
  assert(s.events.filter((e) => e.ruleId === 'effects.deploy' || e.ruleId === 'effects.search').length > 0);
  restore(g, f);
});
