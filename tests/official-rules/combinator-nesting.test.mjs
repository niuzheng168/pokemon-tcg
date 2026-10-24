// Synthetic definitions only. Combinators nesting the leaves they need:
// 「查看自己牌库上方1张卡牌，再放回原处。然后，从2个效果中选择1个效果使用。◆将自己所有的手牌放于弃牌区后，从牌库上方抽取5张卡牌。
// ◆将自己所有的手牌放于弃牌区后，从牌库下方抽取5张卡牌。」 (cn.then@1 → cn.chooseOne@1);
// 「抛掷与对手的战斗宝可梦身上附着的「能量」数量相同次数的硬币。如果至少出现1次「正面」的话，则从「中毒、睡眠、混乱」中选择1个，令对手的
// 战斗宝可梦陷入那个状态中。」 (cn.coins@1 → cn.chooseOne@1);
// 「抛掷1次硬币如果为正面，则将自己的所有手牌放回牌库并重洗牌库。然后，从牌库上方抽取6张卡牌。」 (cn.coin@1 → cn.handDeckDraw@1);
// 「将自己牌库中最多3张【基础】宝可梦，放于备战区。并重洗牌库。当成功把卡牌放于备战区时，若希望，可将这只宝可梦与备战宝可梦互换。」
// (cn.thenMoved@1 use none); 「将附着于这只宝可梦身上的1个能量，放于弃牌区。然后，将双方战斗宝可梦身上放置的伤害指示物，全部互换。」
// (cn.swapCounters@1 as a leaf); 「在对手战斗宝可梦身上放置伤害指示物，直到其剩余HP变为「10」为止。然后，给这只宝可梦造成120伤害。」
// (cn.countedCounters@1); 「选择自己手牌中的1张能量，放于弃牌区。然后，从自己牌库上方抽取最多3张卡牌。」 and 「双方玩家，若希望，可各从
// 牌库上方抽取最多3张卡牌。（从自己开始抽取卡牌。)」 (effects.draw-up-to); 「双方玩家，各从自己牌库上方抽取2张卡牌，互相展示过正面后加入
// 手牌。」; 「查看对手的手牌。若希望，可让对手数其手牌，然后将所有手牌放回牌库并重洗牌库。在这种情况下，对手从牌库上方抽取与放回的张数相同
// 数量的卡牌。」; 「将与对手弃牌区中的宝可梦张数相同数量的伤害指示物，以任意方式放置于对手的宝可梦身上。然后，将对手弃牌区中的宝可梦，全部
// 放回对手的牌库并重洗牌库。」 (cn.countValue@1 next). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers, validateThenEffect, validateCoinEffect, validateCoinsEffect, validateOptionalEffect,
  validateChooseOneEffect, validateStadiumUseEffect, validateThenMovedEffect, validateCountValueEffect, validateTurnEndEffect } from '../../public/rules/handlers.js';
import { bindMovedEffect } from '../../public/rules/effects.js';
import { randomIndex } from '../../public/rules/random.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
function forceCoin(s, result) {
  for (let k = 1; ; k++) {
    const rng = [k, k * 7 + 1, k * 13 + 2, k * 31 + 3];
    if (randomIndex([...rng], 2) === (result === 'heads' ? 0 : 1)) { s.rng = rng; return; }
  }
}
const handlers = createCoreHandlers();
const leaf = (handlerId, parameters) => ({ handlerId, parameters });
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const lit = (value) => ({ kind: 'literal', value });
const condition = (c) => leaf('cn.condition@1', { side: 'opponent', condition: c });
const peek = leaf('cn.arrangeDeck@1', { side: 'own', from: 'top', count: 1, to: 'same' });
const juniper = (bottom) => [leaf('cn.discardHand@1', {}), leaf('cn.draw@1', { count: 5, ...(bottom ? { bottom: true } : {}) })];
const choice = leaf('cn.chooseOne@1', { options: [juniper(false), juniper(true)] });
const shuffleDraw = (extra = {}) => leaf('cn.handDeckDraw@1', { side: 'own', ownDraw: 6, opponentDraw: 0, ...extra });
const discardOwnEnergy = leaf('cn.attachedEnergy@1', { op: 'discardEnergy', side: 'own', from: 'self', selector: { kind: 'energy' },
  providedTypes: null, measure: 'units', quantity: { kind: 'exact', count: 1 }, chooser: 'source' });
const benchBasics = leaf('cn.cards@1', { from: 'deck', to: 'bench', selector: { kind: 'pokemon', stages: ['basic'] },
  quantity: { kind: 'upTo', count: 3 }, reveal: false, lookTop: null, shuffleAfter: true });
const switchSelf = leaf('cn.switch@1', { side: 'own', chooser: 'self', affected: 'active' });
const discardEnergyCard = leaf('cn.cards@1', { from: 'hand', to: 'discard', selector: { kind: 'energy' }, quantity: { kind: 'exact', count: 1 },
  reveal: false, lookTop: null, shuffleAfter: false });
const spread = leaf('cn.distributeCounters@1', { op: 'distributeCounters', side: 'opponent', target: 'any', selector: { kind: 'pokemon' }, count: 1 });
const foePokemonInDiscard = { kind: 'zoneCount', side: 'opponent', zone: 'discard', selector: { kind: 'pokemon' } };
const recallFoePokemon = leaf('cn.cards@1', { from: 'discard', to: 'deck', selector: { kind: 'pokemon' }, quantity: { kind: 'all' },
  reveal: false, lookTop: null, shuffleAfter: true, side: 'opponent' });
const ability = (id, effects, extra = {}) => ({ abilityId: id, name: `测试${id}`, mode: 'activated',
  usage: { period: 'turn', scope: 'pokemon', key: `fixture:${id}`, limit: 1 }, effects, sourceOfTruth: EVIDENCE, ...extra });
const useAbility = (g, id) => command(g, { type: 'useAbility', abilityId: id, pokemonId: g.snapshot().players[0].active.id });
const attack = (g) => command(g, { type: 'attack', attackId: 'base:strike' });
const withAttack = (effects, extra = {}) => (defs) => {
  for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 300; d.mechanics.weakness = null; }
  Object.assign(def(defs, 'base').mechanics.attacks[0], { cost: [], printedDamage: null, effects, ...extra });
};
const pendingKind = (g) => g.snapshot().pending?.kind;
const ids = (s, zone, owner = 0) => s.players[owner][zone].map((id) => s.cards[id].definitionId);

test('schemas: which nestings each combinator admits, and why the others stay out', () => {
  const v = (id, p) => handlers.get(id).validateParameters(clone(p));
  // 「然后，从2个效果中选择1个」: only an entry's own then; a then nested in another instruction keeps its single leaves.
  assert(validateThenEffect({ first: peek, next: choice }));
  assert(!validateThenEffect({ first: peek, next: leaf('cn.chooseOne@1', { options: [juniper(false)] }) }));
  assert(!validateThenEffect({ first: choice, next: peek }), 'The choice is never the first part.');
  assert(!validateThenEffect({ first: peek }));
  assert(!validateOptionalEffect({ effect: leaf('cn.then@1', { first: peek, next: choice }) }));
  assert(!validateChooseOneEffect({ options: [leaf('cn.then@1', { first: peek, next: choice }), switchSelf] }));
  assert(!validateStadiumUseEffect({ key: 'fixture:use', effect: leaf('cn.then@1', { first: peek, next: choice }) }));
  // A coin's result may be one whole-hand pair with printed counts.
  assert(validateCoinEffect({ outcome: 'heads', effect: shuffleDraw() }));
  for (const bad of [{ outcome: 'heads', effect: shuffleDraw({ ownDraw: { kind: 'remainingPrizes' } }) },
    { outcome: 'heads', effect: shuffleDraw({ optional: true }) }, { outcome: 'heads', effects: [shuffleDraw(), switchSelf] },
    { outcome: 'heads', effect: switchSelf, otherwise: shuffleDraw() }]) assert(!validateCoinEffect(bad), JSON.stringify(bad));
  assert(validateThenEffect({ first: discardOwnEnergy, next: leaf('cn.coin@1', { outcome: 'heads', effect: shuffleDraw() }) }));
  // Several flips leading to one choice: only when nothing is scaled.
  const coins = (apply, effect) => ({ flips: { kind: 'count', value: { kind: 'pokemon', who: 'opponentActive', field: 'energyUnits' } },
    face: 'heads', apply, effect });
  const pick = leaf('cn.chooseOne@1', { options: ['poisoned', 'asleep', 'confused'].map(condition) });
  assert(validateCoinsEffect(coins({ kind: 'atLeast', count: 1 }, pick)) && validateCoinsEffect(coins({ kind: 'all' }, pick)));
  assert(!validateCoinsEffect(coins({ kind: 'scale' }, pick)));
  assert(!validateCoinsEffect(coins({ kind: 'atLeast', count: 1 }, leaf('cn.chooseOne@1', { options: [condition('asleep')] }))));
  // The counters swap is a static leaf now (its counts are read when it happens).
  assert(validateThenEffect({ first: discardOwnEnergy, next: leaf('cn.swapCounters@1', {}) }));
  assert(validateCoinEffect({ outcome: 'heads', effect: leaf('cn.swapCounters@1', {}) }));
  assert(!validateThenEffect({ first: discardOwnEnergy, next: leaf('cn.swapCounters@1', { all: true }) }));
  // 「最多N张」 belongs to cn.draw@1: never a drawUntil, never a turn-end draw.
  assert(v('cn.draw@1', { count: 3, upTo: true }) && !v('cn.drawUntil@1', { count: 3, upTo: true }));
  assert(!validateTurnEndEffect({ effect: leaf('cn.draw@1', { count: 3, upTo: true }) }));
  assert(validateTurnEndEffect({ effect: leaf('cn.drawUntil@1', { count: 8 }) }));
  assert(v('cn.drawPlayers@1', { own: 3, opponent: 3, upTo: true, optional: true }) && v('cn.drawPlayers@1', { own: 2, opponent: 2, reveal: true }));
  assert(v('cn.drawPlayers@1', { own: 7, opponent: 7, until: true, optional: true }));
  for (const bad of [{ own: 3, opponent: 3, until: true, upTo: true }, { own: 3, opponent: 3, until: true, reveal: true }, { own: 3, opponent: 3, upTo: false }])
    assert(!v('cn.drawPlayers@1', bad), JSON.stringify(bad));
  assert(validateCoinEffect({ outcome: 'heads', effect: leaf('cn.drawPlayers@1', { own: 1, opponent: 1, reveal: true }) }));
  assert(!validateCoinEffect({ outcome: 'heads', effect: leaf('cn.drawPlayers@1', { own: 1, opponent: 1, optional: true }) }),
    '「若希望，可各…」 only as an entry of its own.');
  // A computed whole-hand count under the user's decision: only as the entry itself.
  const peekRed = { side: 'opponent', ownDraw: 0, opponentDraw: { kind: 'value', value: { kind: 'zoneCount', side: 'opponent', zone: 'hand' } }, optional: true };
  assert(v('cn.handDeckDraw@1', peekRed));
  assert(!validateOptionalEffect({ effect: leaf('cn.handDeckDraw@1', { side: 'opponent', ownDraw: 0, opponentDraw: 4, optional: true }) }));
  assert(validateOptionalEffect({ effect: leaf('cn.handDeckDraw@1', { side: 'opponent', ownDraw: 0, opponentDraw: 4 }) }));
  assert(!validateChooseOneEffect({ options: [shuffleDraw({ optional: true }), switchSelf] }));
  assert(!validateStadiumUseEffect({ key: 'fixture:use', effect: shuffleDraw({ optional: true }) }));
  // 「当成功把卡牌放于备战区时」: B needs a moved card, unbound; only first parts that report what they moved.
  assert(validateThenMovedEffect({ first: benchBasics, next: switchSelf, use: 'none', optional: true }));
  assert(validateThenMovedEffect({ first: discardEnergyCard, next: leaf('cn.draw@1', { count: 1 }), use: 'none' }));
  for (const bad of [{ first: leaf('cn.heal@1', { target: 'any', amount: 30 }), next: switchSelf, use: 'none' },
    { first: benchBasics, next: leaf('cn.cardsThenDraw@1', { cards: discardEnergyCard.parameters, draw: 1 }), use: 'none' },
    { first: discardEnergyCard, next: leaf('cn.draw@1', { count: 1 }), use: 'count', optional: true }])
    assert(!validateThenMovedEffect(bad), JSON.stringify(bad));
  // 「…相同数量的…。然后，B」: the count is read before anything of the entry happens; B is a static leaf.
  assert(validateCountValueEffect({ effect: spread, count: foePokemonInDiscard, next: recallFoePokemon }));
  assert(!validateCountValueEffect({ effect: spread, count: foePokemonInDiscard, next: leaf('cn.drawValue@1', { count: lit(1) }) }));
  assert(!validateCountValueEffect({ effect: spread, count: foePokemonInDiscard, next: leaf('cn.cardsThenDraw@1', { cards: discardEnergyCard.parameters, draw: 1 }) }));
  // A counted placement on one Pokémon.
  const counted = handlers.get('cn.countedCounters@1');
  assert.equal(counted.timing, 'beforeDamage'); assert.deepEqual(counted.capabilities, ['effect-card-count']);
  assert(counted.validateParameters({ side: 'opponent', target: 'active', remainingHp: 10 }));
  assert(counted.validateParameters({ side: 'opponent', target: 'any', count: 3 }));
  for (const bad of [{ side: 'opponent', target: 'bench', remainingHp: 10, all: true }, { side: 'opponent', target: 'any', count: 1, all: true },
    { side: 'opponent', target: 'bench', count: 1, targets: 2 }, { side: 'opponent', target: 'active', remainingHp: 10, count: 1 }])
    assert(!counted.validateParameters(bad), JSON.stringify(bad));
  assert.deepEqual(counted.execute({}, { side: 'opponent', target: 'active', remainingHp: 10 }),
    [{ op: 'counters', side: 'opponent', target: 'active', untilRemainingHp: 10 }]);
  assert.deepEqual(counted.execute({}, { side: 'opponent', target: 'any', count: 3 }), [{ op: 'counters', side: 'opponent', target: 'any', count: 3 }]);
  assert.deepEqual(bindMovedEffect({ kind: 'thenMoved', next: { op: 'switch', ...switchSelf.parameters }, use: 'none' }, ['c1']),
    { op: 'switch', ...switchSelf.parameters });
});

test('「…再放回原处。然后，从2个效果中选择1个效果使用」: the choice comes after the look, and resumes mid-choice', async () => {
  const f = await fixture((defs) => { def(defs, 'research').mechanics.effects = [binding('cn.then@1', { first: peek, next: choice }, 'pick')]; });
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'research'); hand(s, 0, 'tool'); });
  const bottom = g.snapshot().players[0].deck.slice(0, 5);
  command(g, { type: 'playTrainer', cardId: card });
  assert.equal(pendingKind(g), 'view-cards', 'The top card is looked at first.');
  answer(g, ['confirm']);
  let q = g.snapshot().pending;
  assert.equal(q.kind, 'choose-effect'); assert.deepEqual(q.options, ['0', '1']);
  const r = restore(g, f);
  answer(r, ['1']); settle(r);
  const s = r.snapshot();
  assert.deepEqual([...s.players[0].hand].sort(), [...bottom].sort(), 'Five cards drawn from the deck bottom.');
  assert(ids(s, 'discard').includes('tool'));
  assert(s.events.some((e) => e.ruleId === 'effects.choose-one' && e.data.option === 1));
  restore(r, f);
  // An empty deck: the look cannot be performed, so the Supporter changes nothing (II.E-19 FAQ2).
  const empty = board(f, (s) => { card = hand(s, 0, 'research'); s.players[0].discard.push(...s.players[0].deck.splice(0)); });
  assert(!empty.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card));
  // Top option: the hand is discarded and 5 cards come from the top.
  const top = board(f, (s) => { card = hand(s, 0, 'research'); });
  const above = top.snapshot().players[0].deck.slice(-5);
  command(top, { type: 'playTrainer', cardId: card }); answer(top, ['confirm']);
  q = top.snapshot().pending; answer(top, ['0']); settle(top);
  assert.deepEqual([...top.snapshot().players[0].hand].sort(), [...above].sort());
});

test('「抛掷与对手的战斗宝可梦身上附着的「能量」数量相同次数的硬币。如果至少出现1次「正面」…选择1个」', async () => {
  const pick = leaf('cn.chooseOne@1', { options: ['poisoned', 'asleep', 'confused'].map(condition) });
  const f = await fixture(withAttack([binding('cn.coins@1', { flips: { kind: 'count', value: { kind: 'pokemon', who: 'opponentActive', field: 'energyUnits' } },
    face: 'heads', apply: { kind: 'atLeast', count: 1 }, effect: pick }, 'flips')]));
  let g = board(f, (s) => { attached(s, 1, s.players[1].active, 'water'); attached(s, 1, s.players[1].active, 'water'); forceCoin(s, 'heads'); });
  attack(g);
  const q = g.snapshot().pending;
  assert.equal(q.kind, 'choose-effect'); assert.deepEqual(q.options, ['0', '1', '2']);
  assert.equal(g.snapshot().events.find((e) => e.ruleId === 'effects.coin').data.receipt.flips, 2, 'One flip per attached Energy.');
  const r = restore(g, f);
  answer(r, ['2']); settle(r);
  assert.equal(r.snapshot().players[1].active.conditions.rotation, 'confused');
  restore(r, f);
  // One Energy and tails: nothing to choose.
  g = board(f, (s) => { attached(s, 1, s.players[1].active, 'water'); forceCoin(s, 'tails'); });
  attack(g); settle(g);
  let s = g.snapshot();
  assert(!s.events.some((e) => e.ruleId === 'effects.choose-one')); assert.equal(s.players[1].active.conditions.rotation, null);
  // No Energy: no flip at all.
  g = board(f);
  attack(g); settle(g);
  s = g.snapshot();
  assert(!s.events.some((e) => e.ruleId === 'effects.coin'));
});

test('「抛掷1次硬币如果为正面，则将自己的所有手牌放回牌库并重洗牌库。然后，从牌库上方抽取6张」 in an Ability that ends the turn', async () => {
  const f = await fixture((defs) => {
    def(defs, 'base').mechanics.abilities.push(ability('lucky', [binding('cn.coin@1', { outcome: 'heads', effect: shuffleDraw() }, 'lucky')],
      { endsTurn: true }));
  });
  let g = board(f, (s) => { hand(s, 0, 'tool'); forceCoin(s, 'heads'); });
  const deck = g.snapshot().players[0].deck.length, held = g.snapshot().players[0].hand.length;
  useAbility(g, 'lucky'); settle(g);
  let s = g.snapshot();
  assert.equal(s.players[0].hand.length, 6); assert.equal(s.players[0].deck.length, deck + held - 6);
  assert(s.events.some((e) => e.ruleId === 'effects.hand-deck' && e.data.count === held));
  assert.equal(s.current, 1, 'The turn ended.');
  restore(g, f);
  g = board(f, (s) => { forceCoin(s, 'tails'); });
  const before = g.snapshot().players[0].hand;
  useAbility(g, 'lucky'); settle(g);
  s = g.snapshot();
  assert.deepEqual(s.players[0].hand, before, 'Tails: the hand stays.'); assert.equal(s.current, 1, 'The Ability was used: the turn still ends.');
  // An empty hand still shuffles the deck and draws (E-36).
  g = board(f, (s) => { s.players[0].deck.push(...s.players[0].hand.splice(0)); forceCoin(s, 'heads'); });
  assert(g.view(0).legalActions.some((a) => a.type === 'useAbility'));
  useAbility(g, 'lucky'); settle(g);
  assert.equal(g.snapshot().players[0].hand.length, 6);
});

test('「…放于备战区。并重洗牌库。当成功把卡牌放于备战区时，若希望，可将这只宝可梦与备战宝可梦互换」', async () => {
  const f = await fixture(withAttack([binding('cn.thenMoved@1', { first: benchBasics, next: switchSelf, use: 'none', optional: true }, 'call')]));
  let g = board(f, (s) => { bench(s, 0, 'evolution'); });
  const old = g.snapshot().players[0].bench[0].id, attacker = g.snapshot().players[0].active.id;
  attack(g);
  let q = g.snapshot().pending;
  assert.equal(q.kind, 'select-cards');
  answer(g, q.options.slice(0, 1));
  q = g.snapshot().pending;
  assert.equal(q.kind, 'optional-effect', 'A Pokémon was benched: the switch is offered.');
  const r = restore(g, f);
  answer(r, ['perform']);
  q = r.snapshot().pending;
  assert.equal(q.kind, 'effect-target'); assert(q.options.includes(old), 'Any Benched Pokémon, not only the one just put there.');
  answer(r, [old]); settle(r);
  let s = r.snapshot();
  assert.equal(s.players[0].active.id, old); assert(s.players[0].bench.some((m) => m.id === attacker));
  restore(r, f);
  // Nothing benched (the deck is still shuffled): no switch is offered.
  g = board(f, (s) => { bench(s, 0, 'evolution'); });
  attack(g);
  answer(g, []); settle(g);
  s = g.snapshot();
  assert(s.events.some((e) => e.ruleId === 'effects.shuffle'));
  assert(!s.events.some((e) => e.ruleId === 'selection.optional')); assert.equal(s.players[0].active.id, attacker);
  // Declined.
  g = board(f);
  attack(g);
  answer(g, g.snapshot().pending.options.slice(0, 2)); answer(g, ['skip']); settle(g);
  s = g.snapshot();
  assert.equal(s.players[0].active.id, attacker); assert.equal(s.players[0].bench.length, 2);
});

test('「将附着于这只宝可梦身上的1个能量，放于弃牌区。然后，将双方战斗宝可梦身上放置的伤害指示物，全部互换」', async () => {
  const f = await fixture(withAttack([binding('cn.then@1', { first: discardOwnEnergy, next: leaf('cn.swapCounters@1', {}) }, 'swap')]));
  let g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); s.players[0].active.counters = 3; s.players[1].active.counters = 5; });
  attack(g); settle(g);
  let s = g.snapshot();
  assert.deepEqual([s.players[0].active.counters, s.players[1].active.counters], [5, 3]);
  assert(ids(s, 'discard').includes('water'));
  restore(g, f);
  // No Energy to discard: the swap does not happen.
  g = board(f, (s) => { s.players[0].active.counters = 3; s.players[1].active.counters = 5; });
  attack(g); settle(g);
  s = g.snapshot();
  assert.deepEqual([s.players[0].active.counters, s.players[1].active.counters], [3, 5]);
});

test('「在对手战斗宝可梦身上放置伤害指示物，直到其剩余HP变为「10」为止。然后，给这只宝可梦造成120伤害」', async () => {
  const recoil = binding('cn.recoilDamage@1', { side: 'own', target: 'self', selection: { kind: 'all' }, options: {}, amount: { kind: 'choose',
    condition: { kind: 'compare', left: { kind: 'effectCards', effectId: 'fixture:counters' }, relation: 'gt', right: lit(0) },
    ifTrue: lit(120), ifFalse: lit(0) } }, 'recoil');
  const f = await fixture(withAttack([binding('cn.countedCounters@1', { side: 'opponent', target: 'active', remainingHp: 10 }, 'counters'), recoil]));
  let g = board(f);
  attack(g); settle(g);
  let s = g.snapshot();
  assert.equal(s.players[1].active.counters, 29); assert.equal(s.players[0].active.counters, 12);
  assert(s.events.some((e) => e.ruleId === 'damage.effect-count' && e.data.effectId === 'fixture:counters' && e.data.count === 29));
  const placed = s.events.findIndex((e) => e.ruleId === 'damage.counters'), damaged = s.events.findIndex((e) => e.ruleId === 'attack.order');
  assert(placed >= 0 && damaged > placed, 'The counters come first, then the damage.');
  restore(g, f);
  // Already at 10 remaining HP: nothing placed, so no self damage.
  g = board(f, (s) => { s.players[1].active.counters = 29; });
  attack(g); settle(g);
  s = g.snapshot();
  assert.equal(s.players[0].active.counters, 0);
  assert(s.events.some((e) => e.ruleId === 'damage.effect-count' && e.data.effectId === 'fixture:counters' && e.data.cards.length === 0 && !('count' in e.data)));
  restore(g, f);
  // Protected from the effect: nothing placed, no self damage.
  const shielded = await fixture((defs) => {
    withAttack([binding('cn.countedCounters@1', { side: 'opponent', target: 'active', remainingHp: 10 }, 'counters'), recoil])(defs);
    def(defs, 'base').mechanics.effects.push(binding('cn.protection@1', { effect: { op: 'protection', useRule: 'ordinary', channel: 'effects',
      from: 'opponent', scope: 'self', categories: ['attack'] } }, 'shield'));
  });
  g = board(shielded);
  attack(g); settle(g);
  s = g.snapshot();
  assert.deepEqual([s.players[0].active.counters, s.players[1].active.counters], [0, 0]);
  // A fixed number of counters on a chosen Pokémon.
  const fixed = await fixture(withAttack([binding('cn.countedCounters@1', { side: 'opponent', target: 'any', count: 3 }, 'counters'), recoil]));
  g = board(fixed, (s) => { bench(s, 1, 'other'); });
  attack(g);
  answer(g, [g.snapshot().players[1].bench[0].id]); settle(g);
  s = g.snapshot();
  assert.equal(s.players[1].bench[0].counters, 3); assert.equal(s.players[0].active.counters, 12);
  restore(g, fixed);
  // Placed before the damage step: never on an attack that damages the opponent too.
  const counted = binding('cn.countedCounters@1', { side: 'opponent', target: 'active', remainingHp: 10 }, 'counters');
  for (const extra of [{ printedDamage: { value: 20, operator: 'fixed' } }, { effects: [counted, binding('cn.damage@1', { side: 'opponent', target: 'bench',
    amount: 20, selection: { kind: 'all' }, options: {} }, 'packet')] }]) {
    const bad = await fixture(withAttack([counted, recoil], extra));
    assert.throws(() => board(bad), (e) => e.code === 'unsupported-effect-count');
  }
});

test('「选择自己手牌中的1张能量，放于弃牌区。然后，从自己牌库上方抽取最多3张卡牌」: one card at a time, stop at will', async () => {
  const f = await fixture((defs) => {
    def(defs, 'base').mechanics.abilities.push(ability('energy-draw', [binding('cn.then@1', { first: discardEnergyCard,
      next: leaf('cn.draw@1', { count: 3, upTo: true }) }, 'draw')], { condition: { predicate: { kind: 'compare',
      left: { kind: 'pokemon', who: 'self', field: 'specialConditions' }, relation: 'eq', right: lit(0) } } }));
  });
  let g = board(f, (s) => { s.players[0].deck.push(...s.players[0].hand.splice(0)); hand(s, 0, 'water'); });
  const top = g.snapshot().players[0].deck.slice(-3).reverse();
  useAbility(g, 'energy-draw');
  answer(g, g.snapshot().pending.options.slice(0, 1));
  let q = g.snapshot().pending;
  assert.equal(q.kind, 'draw-more'); assert.deepEqual(q.options, ['continue', 'stop']);
  assert.deepEqual(g.snapshot().players[0].hand, [top[0]], 'The first card is drawn before the decision.');
  let r = restore(g, f);
  answer(r, ['continue']);
  assert.equal(pendingKind(r), 'draw-more');
  r = restore(r, f);
  answer(r, ['stop']);
  let s = r.snapshot();
  assert.equal(s.pending, null);
  assert.deepEqual(s.players[0].hand, top.slice(0, 2));
  assert(s.events.some((e) => e.ruleId === 'effects.draw' && e.data.count === 2));
  restore(r, f);
  // All three: no question after the third card.
  g = board(f, (s) => { hand(s, 0, 'water'); });
  const held = g.snapshot().players[0].hand.length;
  useAbility(g, 'energy-draw');
  answer(g, [g.snapshot().players[0].hand.find((id) => g.snapshot().cards[id].definitionId === 'water')]);
  answer(g, ['continue']); answer(g, ['continue']);
  s = g.snapshot();
  assert.equal(s.pending, null); assert.equal(s.players[0].hand.length, held - 1 + 3);
  // A one-card deck: that card, nothing to decide.
  g = board(f, (s) => { hand(s, 0, 'water'); s.players[0].discard.push(...s.players[0].deck.splice(1)); });
  useAbility(g, 'energy-draw');
  answer(g, [g.snapshot().players[0].hand.find((id) => g.snapshot().cards[id].definitionId === 'water')]);
  s = g.snapshot();
  assert.equal(s.pending, null); assert.equal(s.players[0].deck.length, 0);
  // 「如果这只宝可梦处于特殊状态的话，则无法使用这个力量」.
  g = board(f, (s) => { hand(s, 0, 'water'); s.players[0].active.conditions.rotation = 'confused'; });
  assert(!g.view(0).legalActions.some((a) => a.type === 'useAbility'));
});

test('「双方玩家，若希望，可各从牌库上方抽取最多3张卡牌。（从自己开始抽取卡牌。)」: each player decides its own draw', async () => {
  const f = await fixture((defs) => { def(defs, 'research').mechanics.effects = [binding('cn.drawPlayers@1',
    { own: 3, opponent: 3, upTo: true, optional: true }, 'both')]; });
  let card;
  let g = board(f, (s) => { card = hand(s, 0, 'research'); });
  const [mine, theirs] = [0, 1].map((i) => g.snapshot().players[i].hand.length);
  command(g, { type: 'playTrainer', cardId: card });
  let q = g.snapshot().pending;
  assert.equal(q.kind, 'optional-effect'); assert.equal(q.player, 0, 'The user decides first.');
  answer(g, ['perform']);
  q = g.snapshot().pending;
  assert.equal(q.kind, 'draw-more'); assert.equal(q.player, 0);
  answer(g, ['stop']);
  q = g.snapshot().pending;
  assert.equal(q.kind, 'optional-effect'); assert.equal(q.player, 1, 'Then the opponent, for its own draw.');
  const r = restore(g, f);
  answer(r, ['perform']);
  q = r.snapshot().pending;
  assert.equal(q.kind, 'draw-more'); assert.equal(q.player, 1);
  answer(r, ['continue']); answer(r, ['continue']); settle(r);
  const s = r.snapshot();
  assert.equal(s.players[0].hand.length, mine - 1 + 1); assert.equal(s.players[1].hand.length, theirs + 3);
  assert(s.events.some((e) => e.ruleId === 'selection.optional' && e.data.chooser === 1 && e.data.performed));
  restore(r, f);
  // The user declines; the opponent may still draw.
  g = board(f, (s) => { card = hand(s, 0, 'research'); });
  command(g, { type: 'playTrainer', cardId: card });
  answer(g, ['skip']);
  assert.equal(g.snapshot().pending.player, 1);
  answer(g, ['skip']); settle(g);
  assert.equal(g.snapshot().players[1].hand.length, theirs);
});

test('「双方玩家，各从自己牌库上方抽取2张卡牌，互相展示过正面后加入手牌」', async () => {
  const f = await fixture(withAttack([binding('cn.drawPlayers@1', { own: 2, opponent: 2, reveal: true }, 'show')]));
  const g = board(f);
  const tops = [0, 1].map((i) => g.snapshot().players[i].deck.slice(-2).reverse());
  attack(g); settle(g);
  const s = g.snapshot();
  const shown = s.events.filter((e) => e.ruleId === 'effects.reveal' && e.visibility === 'public');
  assert.deepEqual(shown.map((e) => [e.data.player, ...e.data.cardIds]), [[0, tops[0][0]], [0, tops[0][1]], [1, tops[1][0]], [1, tops[1][1]]]);
  for (const id of tops[0]) assert(s.players[0].hand.includes(id));
  assert(g.view(1).events.some((e) => e.ruleId === 'effects.reveal' && e.data.cards?.[0]?.instanceId === tops[0][0]),
    "The opponent sees the user's drawn cards.");
  restore(g, f);
});

test('「查看对手的手牌。若希望，可让对手数其手牌，然后将所有手牌放回牌库并重洗牌库。在这种情况下，对手从牌库上方抽取与放回的张数相同数量」', async () => {
  const f = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.opponentHand@1', { mode: 'look' }, 'look'),
    binding('cn.handDeckDraw@1', { side: 'opponent', ownDraw: 0, opponentDraw: { kind: 'value', value: { kind: 'zoneCount', side: 'opponent', zone: 'hand' } },
      optional: true }, 'reset')]; });
  let card;
  let g = board(f, (s) => { card = hand(s, 0, 'potion'); });
  const held = g.snapshot().players[1].hand;
  command(g, { type: 'playTrainer', cardId: card });
  assert.equal(pendingKind(g), 'view-cards');
  answer(g, ['confirm']);
  let q = g.snapshot().pending;
  assert.equal(q.kind, 'optional-effect'); assert.equal(q.player, 0, 'The user decides.');
  const r = restore(g, f);
  answer(r, ['perform']); settle(r);
  let s = r.snapshot();
  assert.equal(s.players[1].hand.length, held.length, 'As many as went back.');
  assert(s.events.some((e) => e.ruleId === 'effects.hand-deck' && e.data.player === 1 && e.data.count === held.length));
  restore(r, f);
  g = board(f, (s) => { card = hand(s, 0, 'potion'); });
  command(g, { type: 'playTrainer', cardId: card }); answer(g, ['confirm']); answer(g, ['skip']); settle(g);
  s = g.snapshot();
  assert.deepEqual(s.players[1].hand, held, 'Declined: the hand stays.');
  assert(!s.events.some((e) => e.ruleId === 'effects.hand-deck'));
});

test('「将与对手弃牌区中的宝可梦张数相同数量的伤害指示物，以任意方式放置于…。然后，将对手弃牌区中的宝可梦，全部放回对手的牌库并重洗牌库」', async () => {
  const f = await fixture(withAttack([binding('cn.countValue@1', { effect: spread, count: foePokemonInDiscard, next: recallFoePokemon }, 'cry')]));
  let g = board(f, (s) => {
    for (const id of ['base', 'other']) { const card = hand(s, 1, id); s.players[1].hand.pop(); s.players[1].discard.push(card); }
    bench(s, 1, 'other');
  });
  const foe = g.snapshot().players[1];
  attack(g);
  let q = g.snapshot().pending;
  assert.equal(q.kind, 'counter-allocation');
  const r = restore(g, f);
  command(r, { type: 'allocateCounters', requestId: q.id, allocations: [{ pokemonId: foe.active.id, count: 1 }, { pokemonId: foe.bench[0].id, count: 1 }] },
    q.player);
  q = r.snapshot().pending;
  assert.equal(q.kind, 'select-cards'); assert.equal(q.options.length, 2);
  answer(r, q.options); settle(r);
  const s = r.snapshot();
  assert.deepEqual([s.players[1].active.counters, s.players[1].bench[0].counters], [1, 1]);
  assert(!s.players[1].discard.some((id) => s.cards[id].definitionId !== 'water' && ['base', 'other'].includes(s.cards[id].definitionId)));
  assert(s.events.some((e) => e.ruleId === 'effects.shuffle' && e.data.player === 1));
  restore(r, f);
  // No Pokémon there: nothing at all, not even a shuffle.
  g = board(f);
  attack(g); settle(g);
  assert(!g.snapshot().events.some((e) => e.ruleId === 'effects.shuffle' && e.data.player === 1));
});
