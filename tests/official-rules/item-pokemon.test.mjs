// Synthetic definitions only. 「这张卡牌，可以作为HP为60的【无】属性的【基础】宝可梦，放于场上。这张卡牌，不会陷入特殊状态，也无法撤退。
// 如果在自己的回合的话，则可将处于场上的这张卡牌放于弃牌区。」 and 「…可将处于战斗场上的这张卡牌放回牌库下方。（将放于其身上的卡牌，全部放于弃牌区。）
// …即使这张卡牌【昏厥】，对手也无法拿取奖赏卡。」 (pokemon.item-card). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { validateDeck } from '../../public/rules/catalog.js';
import { matchesCardSelector, matchesCardsMove, distinctCards } from '../../public/rules/card-selection.js';
import { matchesInPlaySelector } from '../../public/rules/in-play-selection.js';
import { evolutionRelation } from '../../public/rules/evolution.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached, fixtureClock } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const fossil = (id, extra = {}) => ({
  schemaVersion: '1.0.0', definitionId: id, ruleset: { region: 'CN', version: 'V20261019' }, name: `测试化石${id}`, nameKey: id, kind: 'pokemon',
  sourceOfTruth: EVIDENCE, implementation: { status: 'verified', testIds: ['fixture:test'] }, deckLimits: { sameName: 4, groups: [] },
  mechanics: { stage: 'basic', evolvesFrom: null, hp: 60, types: ['Colorless'], weakness: null, resistance: null, retreatCost: 0,
    attacks: [], abilities: [], ruleBox: false, prizeCount: 1, tags: [],
    effects: [binding('cn.conditionImmunity@1', { effect: { op: 'conditionImmunity', scope: 'self' } }, `${id}:immune`),
      binding('cn.restriction@1', { effect: { op: 'restriction', scope: 'self', actions: ['retreat'] } }, `${id}:stay`)],
    itemCard: { leave: { from: 'field', to: 'discard' }, sourceOfTruth: EVIDENCE }, ...extra },
});
const items = (defs) => {
  defs.push(fossil('fossil'), fossil('doll', { prizeCount: 0, effects: [], itemCard: { leave: { from: 'active', to: 'deckBottom' }, sourceOfTruth: EVIDENCE } }));
  def(defs, 'evolution').mechanics.evolvesFrom = 'fossil';
};
async function withItems(more = () => {}) {
  const f = await fixture((defs) => { items(defs); more(defs); });
  f.deck.splice(20, 4, 'printing:fossil', 'printing:fossil', 'printing:doll', 'printing:doll');
  return f;
}
const legal = (g, type) => g.view(g.snapshot().current).legalActions.filter((a) => a.type === type);

test('pokemon.item-card: out of play an Item for selectors, deck building and setup; in play a Basic Pokémon', async () => {
  const f = await withItems();
  const card = f.catalog.definition('fossil');
  assert(!matchesCardSelector(card, { kind: 'pokemon' }));
  assert(!matchesCardSelector(card, { kind: 'pokemon', stages: ['basic'] }));
  assert(matchesCardSelector(card, { kind: 'trainer', categories: ['item'] }));
  assert(matchesCardSelector(card, { anyOf: [{ kind: 'energy' }, { kind: 'trainer' }] }));
  assert(!matchesCardsMove(card, { to: 'bench', selector: { kind: 'pokemon', stages: ['basic'] } }), 'No Basic Pokémon search puts it on the Bench.');
  assert(distinctCards([card, f.catalog.definition('base')], 'types'), 'No Pokémon type outside play.');
  assert(matchesInPlaySelector(card, { kind: 'pokemon', stages: ['basic'] }, ['Colorless']), 'In play it is a Basic Pokémon.');
  // A deck needs a real Basic Pokémon card.
  const only = ['printing:fossil', ...Array(59).fill('printing:water')];
  assert.throws(() => validateDeck(f.catalog, only), /Basic Pokémon/);
});

test('pokemon.item-card: benched from the hand as an Item, a 60-HP Colorless Basic that cannot retreat or be affected by Special Conditions', async () => {
  const f = await withItems();
  let card, mon;
  const g = board(f, (s) => { card = hand(s, 0, 'fossil'); attached(s, 0, s.players[0].active, 'water'); });
  assert(legal(g, 'bench').some((a) => a.cardId === card));
  assert(!legal(g, 'playTrainer').some((a) => a.cardId === card));
  command(g, { type: 'bench', cardId: card }); settle(g);
  mon = g.snapshot().players[0].bench[0];
  const v = g.view(0).players[0].bench[0];
  assert.deepEqual([v.effective.maxHp, v.effective.types], [60, ['Colorless']]);
  // As the Active: no Retreat, no Special Condition, no Weakness.
  const h = board(f, (s) => {
    const p = s.players[0]; mon = bench(s, 0, 'fossil'); p.bench = [p.active]; p.active = mon;
    s.players[0].active.conditions.rotation = 'asleep';
  });
  assert.deepEqual(legal(h, 'retreat'), []);
  command(h, { type: 'endTurn' }); settle(h);
  assert.equal(h.snapshot().players[0].active.conditions.rotation, null, 'Recovered at the rule boundary.');
  restore(h, f);
});

test('pokemon.item-card: an Item lock stops it; it gives a Prize card when Knocked Out, the doll none', async () => {
  const f = await withItems((defs) => def(defs, 'other').mechanics.effects.push(binding('cn.playerRestriction@1', {
    effect: { op: 'playerRestriction', scope: 'opponent', actions: ['playItem'], sourceActive: true } }, 'lock')));
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'fossil'); const o = bench(s, 1, 'other'), p = s.players[1]; p.bench = [p.active]; p.active = o; });
  assert(!legal(g, 'bench').some((a) => a.cardId === card));
  assert(legal(g, 'bench').length, 'A Basic Pokémon card is still benched as usual.');
  for (const [id, prizes] of [['fossil', 1], ['doll', 0]]) {
    const k = await withItems((defs) => { def(defs, 'base').mechanics.attacks[0].printedDamage = { value: 60, operator: 'fixed' }; });
    const ko = board(k, (s) => {
      attached(s, 0, s.players[0].active, 'water');
      const m = bench(s, 1, id), p = s.players[1]; p.bench = [p.active]; p.active = m;
    });
    command(ko, { type: 'attack', attackId: 'base:strike' }); settle(ko);
    const s = ko.snapshot();
    assert.equal(s.players[0].prizes.length, 6 - prizes, id);
    restore(ko, k);
  }
});

test('pokemon.item-card: 「可将处于场上的这张卡牌放于弃牌区」 and the doll\'s 「放回牌库下方」; an evolved one is no longer this card', async () => {
  const f = await withItems();
  let mon, energy, doll;
  const g = board(f, (s) => {
    const p = s.players[0]; mon = bench(s, 0, 'fossil'); p.bench = [p.active]; p.active = mon; energy = attached(s, 0, mon, 'water');
    doll = bench(s, 0, 'doll');
  });
  assert.deepEqual(legal(g, 'leavePlay').map((a) => a.pokemonId), [mon.id], 'The doll only from the Active Spot.');
  command(g, { type: 'leavePlay', pokemonId: mon.id }); settle(g);
  let s = g.snapshot();
  assert(s.players[0].discard.includes(mon.stack[0]) && s.players[0].discard.includes(energy));
  assert.notEqual(s.players[0].active?.id, mon.id);
  assert.equal(s.players[1].prizes.length, 6, 'Not a Knock Out.');
  assert(s.events.some((e) => e.ruleId === 'pokemon.item-card'));
  restore(g, f);
  // The doll from the Active Spot: to the bottom of the deck, attached cards discarded.
  const h = board(f, (s) => { const p = s.players[0]; doll = bench(s, 0, 'doll'); p.bench = [p.active]; p.active = doll; energy = attached(s, 0, doll, 'water'); });
  command(h, { type: 'leavePlay', pokemonId: doll.id }); settle(h);
  s = h.snapshot();
  assert.equal(s.players[0].deck[0], doll.stack[0]); assert(s.players[0].discard.includes(energy));
  // Evolving from it: a Stage 1 that names it; then no leave action.
  const e = board(f, (s) => { mon = bench(s, 0, 'fossil'); mon.enteredTurn = 1; hand(s, 0, 'evolution'); });
  const evolve = legal(e, 'evolve').find((a) => a.pokemonId === mon.id);
  assert(evolve); command(e, evolve); settle(e);
  assert.deepEqual(legal(e, 'leavePlay'), []);
});

test('a Stage 2 whose Stage 1 of that name is printed evolving from two Basics (an old and a new fossil): either one', async () => {
  const stage2 = (ancestor) => (defs) => {
    const e = def(defs, 'evolution');
    defs.push({ ...e, definitionId: 'evolution-old', mechanics: { ...e.mechanics, evolvesFrom: 'base' } },
      { ...e, definitionId: 'stage2', name: '测试2阶进化', nameKey: 'stage2', mechanics: { ...e.mechanics, stage: 'stage2', evolvesFrom: 'evolution',
        basicAncestor: { ...ancestor, sourceOfTruth: EVIDENCE } } });
  };
  const f = await withItems(stage2({ nameKey: 'base', otherNameKeys: ['fossil'] }));
  const top = f.catalog.definition('stage2');
  for (const basic of ['base', 'fossil']) assert(evolutionRelation(f.catalog.definition(basic), top, 'skipStage1'), basic);
  assert(!evolutionRelation(f.catalog.definition('other'), top, 'skipStage1'));
  await assert.rejects(withItems(stage2({ nameKey: 'base' })), /Basic ancestry/);
});
