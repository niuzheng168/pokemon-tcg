// Synthetic definitions only. 「追加造成在上一个对手的回合，这只宝可梦所受到的招式的伤害相同数值的伤害」「追加造成在上一个对手的回合，对手所拿取的
// 奖赏卡张数×50点伤害」「如果自己已经使用了GX招式的话」「在上一个对手的回合，如果对手的宝可梦使用了GX招式」「在这个回合，如果从手牌将「宝可梦道具」
// 放于这只宝可梦身上的话」 (history.previous-opponent-turn, history.special-rule-used, history.tool-from-hand-this-turn). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { assertBattleValue } from '../../public/rules/battle-value.js';
import { assertBattlePredicate } from '../../public/rules/battle-predicate.js';
import { assertSupportedDefinition } from '../../public/rules/game.js';
import { createBattleHistory, recordBattleTurn, recordBattleEvent, attackDamageInPreviousOpponentTurn, prizesTakenInPreviousOpponentTurn,
  specialAttackInPreviousOpponentTurn } from '../../public/rules/battle-history.js';
import { fixture, binding, board, command, settle, hand, bench, fixtureClock } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const lit = (value) => ({ kind: 'literal', value });
const taken = { kind: 'previousOpponentTurn', fact: 'damageTaken' };
const prizes = { kind: 'previousOpponentTurn', fact: 'prizesTaken' };
const fact = (f, extra = {}) => ({ kind: 'historyFact', fact: f, ...extra });
const choose = (condition, ifTrue, ifFalse) => ({ kind: 'choose', condition, ifTrue: lit(ifTrue), ifFalse: lit(ifFalse) });
const formula = (d, expression, operator = 'plus') => {
  const a = d.mechanics.attacks[0];
  a.printedDamage = { value: 10, operator }; a.effects = [binding('cn.damageValue@1', { expression }, 'formula')];
};
const water = (s, owner) => {
  const p = s.players[owner], i = p.deck.findIndex((id) => s.cards[id].definitionId === 'water');
  p.active.energy.push(p.deck.splice(i, 1)[0]);
};
const strike = (g, attackId = 'base:strike') => { command(g, { type: 'attack', attackId }); settle(g); };

test('shapes and load guards', () => {
  for (const v of [taken, { ...taken, activeOnly: true }, prizes]) assert.doesNotThrow(() => assertBattleValue(v));
  for (const v of [{ ...prizes, activeOnly: true }, { ...taken, activeOnly: false }, { kind: 'previousOpponentTurn', fact: 'knockouts' }])
    assert.throws(() => assertBattleValue(v));
  for (const p of [fact('specialRuleUsed', { side: 'opponent', rule: 'VSTAR' }), fact('previousOpponentSpecialAttack', { rule: 'GX' }), fact('toolFromHand')])
    assert.doesNotThrow(() => assertBattlePredicate(p));
  for (const p of [fact('specialRuleUsed', { side: 'both', rule: 'GX' }), fact('specialRuleUsed', { side: 'own' }), fact('previousOpponentSpecialAttack', { rule: 'VSTAR' })])
    assert.throws(() => assertBattlePredicate(p), JSON.stringify(p));
  const handlers = createCoreHandlers(), catalog = { handler: (id) => handlers.get(id) };
  const item = { definitionId: 'x', kind: 'trainer', mechanics: { category: 'item', effects: [] } };
  for (const condition of [{ kind: 'compare', left: taken, relation: 'gt', right: lit(0) }, fact('toolFromHand')]) {
    item.mechanics.effects = [binding('cn.when@1', { condition, effect: { handlerId: 'cn.draw@1', parameters: { count: 1 } } }, 'when')];
    assert.throws(() => assertSupportedDefinition(catalog, item), (e) => e.code === 'unsupported-condition');
  }
});

test('the history ledger: damage taken (while Active), Prize cards taken, a GX attack, all in the latest opponent turn', () => {
  let h = createBattleHistory();
  const at = (turn, during) => ({ turn, during });
  h = recordBattleTurn(h, { turn: 1, player: 0 });
  h = recordBattleTurn(h, { turn: 2, player: 1 });
  for (const [damage, active] of [[30, true], [20, false]])
    h = recordBattleEvent(h, { kind: 'attackDamage', turn: 2, during: 1, owner: 0, pokemonId: 'm1', damage, active }, at(2, 1));
  h = recordBattleEvent(h, { kind: 'prizeTaken', turn: 2, during: 1, owner: 1, cardId: 'c1' }, at(2, 1));
  h = recordBattleEvent(h, { kind: 'attackUsed', turn: 2, during: 1, owner: 1, pokemonId: 'm2', cardId: 'c2', attackName: 'X', specialRule: 'GX' }, at(2, 1));
  const second = h;
  h = recordBattleTurn(h, { turn: 3, player: 0 });
  assert.equal(attackDamageInPreviousOpponentTurn(h, at(3, 0), 0, 'm1'), 50);
  assert.equal(attackDamageInPreviousOpponentTurn(h, at(3, 0), 0, 'm1', true), 30);
  assert.equal(attackDamageInPreviousOpponentTurn(h, at(3, 0), 0, 'm9'), 0);
  assert.equal(prizesTakenInPreviousOpponentTurn(h, at(3, 0), 0), 1);
  assert(specialAttackInPreviousOpponentTurn(h, at(3, 0), 0, 'GX'));
  assert.equal(attackDamageInPreviousOpponentTurn(second, at(2, 1), 0, 'm1'), 0, 'No earlier turn of the other player.');
  assert.equal(prizesTakenInPreviousOpponentTurn(second, at(2, 1), 0), 0);
  assert(!specialAttackInPreviousOpponentTurn(second, at(2, 1), 0, 'GX'));
  for (const bad of [{ kind: 'attackDamage', turn: 3, during: 0, owner: 1, pokemonId: 'm2', damage: 5, active: true },
    { kind: 'attackDamage', turn: 3, during: 0, owner: 1, pokemonId: 'm2', damage: 10, active: 1 },
    { kind: 'prizeTaken', turn: 3, during: 0, owner: 0, cardId: '' },
    { kind: 'attackUsed', turn: 3, during: 0, owner: 0, pokemonId: 'm1', cardId: 'c3', attackName: 'Y', specialRule: 'EX' }])
    assert.throws(() => recordBattleEvent(h, bad, at(3, 0)), JSON.stringify(bad));
});

test('「追加造成在上一个对手的回合，这只宝可梦所受到的招式的伤害相同数值的伤害」', async () => {
  const f = await fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.weakness = null;
    formula(def(defs, 'base'), { kind: 'add', terms: [lit(10), taken] });
  });
  const g = board(f, (s) => { water(s, 0); water(s, 1); });
  strike(g);
  assert.equal(g.snapshot().players[1].active.counters, 1, 'Nothing taken in the opponent\'s previous turn.');
  strike(g);
  assert.equal(g.snapshot().players[0].active.counters, 2, '10 + the 10 it took.');
  strike(g);
  const s = g.snapshot();
  assert.equal(s.players[1].active.counters, 1 + 3, '10 + the 20 it took.');
  assert.deepEqual(s.battleHistory.events.filter((e) => e.kind === 'attackDamage').map((e) => [e.owner, e.damage, e.active]),
    [[1, 10, true], [0, 20, true], [1, 30, true]]);
  assert.deepEqual(restore(g, f).snapshot(), s);
});

test('Prize cards the opponent took, a spent GX rule, a GX attack last turn, a Tool from hand this turn', async () => {
  const f = await fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.weakness = null;
    formula(def(defs, 'other'), { kind: 'multiply', left: lit(50), right: prizes }, 'times');
    formula(def(defs, 'base'), { kind: 'add', terms: [lit(10), choose(fact('specialRuleUsed', { side: 'own', rule: 'GX' }), 60, 0),
      choose(fact('previousOpponentSpecialAttack', { rule: 'GX' }), 100, 0), choose(fact('toolFromHand'), 70, 0)] });
    def(defs, 'evolution').mechanics = { ...def(defs, 'base').mechanics, stage: 'basic', evolvesFrom: null, hp: 200, attacks: [{
      ...def(defs, 'base').mechanics.attacks[0], attackId: 'evolution:gx', name: '测试GX', printedDamage: { value: 10, operator: 'fixed' }, effects: [],
      specialRule: 'GX' }] };
  });
  // Player 1 Knocks Out player 0's Active and takes a Prize card; player 0's 'other' then does 50 × 1.
  const g = board(f, (s) => {
    fixtureClock(s, [0, 1, 0, 1, 0, 1]); s.players[0].active.counters = 9; water(s, 1);
    const p = s.players[0], o = bench(s, 0, 'other'), i = p.deck.findIndex((id) => s.cards[id].definitionId === 'water');
    o.energy.push(p.deck.splice(i, 1)[0]);
  });
  strike(g);
  let s = g.snapshot();
  assert.equal(s.current, 0);
  assert.deepEqual(s.battleHistory.events.filter((e) => e.kind === 'prizeTaken').map((e) => [e.turn, e.owner]), [[6, 1]]);
  const before = s.players[1].active.counters;
  strike(g, 'other:strike');
  assert.equal((g.snapshot().players[1].active.counters - before) * 10, 50);
  // The rest: player 0's base:strike with the three conditions.
  for (const [mutate, damage] of [[() => {}, 10], [(s) => { s.players[0].gxUsed = true; }, 70]]) {
    const k = board(f, (s) => { water(s, 0); mutate(s); });
    strike(k);
    assert.equal(k.snapshot().players[1].active.counters * 10, damage);
  }
  // A Tool attached from hand this turn (not one already attached).
  let tool;
  const k = board(f, (s) => { water(s, 0); tool = hand(s, 0, 'hp-tool'); });
  command(k, { type: 'playTrainer', cardId: tool }); settle(k, (q) => [k.snapshot().players[0].active.id].filter((id) => q.options.includes(id)));
  assert.equal(k.snapshot().players[0].active.facts.toolFromHandTurn, k.snapshot().turn);
  strike(k);
  assert.equal(k.snapshot().players[1].active.counters * 10, 80);
  const held = board(f, (s) => { water(s, 0); const id = hand(s, 0, 'hp-tool'); s.players[0].hand.pop(); s.players[0].active.tools.push(id); });
  strike(held);
  assert.equal(held.snapshot().players[1].active.counters * 10, 10);
  // Player 1 used a GX attack in their turn; player 0's next attack adds 100.
  const y = board(f, (s) => {
    fixtureClock(s, [0, 1, 0, 1, 0, 1]); water(s, 0);
    const p = s.players[1]; p.hand.push(...p.active.stack); p.active.stack = [hand(s, 1, 'evolution')]; p.hand.pop();
    water(s, 1);
  });
  strike(y, 'evolution:gx');
  s = y.snapshot();
  assert.equal(s.players[1].gxUsed, true);
  assert(s.battleHistory.events.some((e) => e.kind === 'attackUsed' && e.specialRule === 'GX'));
  const was = s.players[1].active.counters;
  strike(y);
  assert.equal((y.snapshot().players[1].active.counters - was) * 10, 110);
});
