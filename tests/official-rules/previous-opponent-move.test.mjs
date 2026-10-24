// Synthetic definitions only. 「给对手的1只备战宝可梦，造成30点伤害。在上一个对手的回合，如果那只宝可梦从战斗场撤退了的话，这个招式的伤害变为「120」点。
// [备战宝可梦不计算弱点、抗性。]」 and 「在上一个对手的回合，如果对手的战斗宝可梦，是从备战区被放于战斗场上的话，则追加造成120点伤害。」
// (history.previous-opponent-move: the Retreat action, I.A-03, and a Bench-to-Active move, II.E-24, during the latest opponent turn, of that
// Pokémon in its current form — JP Q&A スカタンクV「おいうちボム」／デカグース「はりこみヘッド」). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { requireRule } from '../../public/rules/registry.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { createBattleHistory, recordBattleTurn, recordBattleEvent, movedInPreviousOpponentTurn, BattleHistoryError } from '../../public/rules/battle-history.js';
import { fixture, binding, EVIDENCE, board, command, settle, answer, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const lit = (value) => ({ kind: 'literal', value });
const moved = (move, who) => ({ kind: 'historyFact', fact: 'previousOpponentMove', move, who });
const choose = (condition, high, low) => ({ kind: 'choose', condition, ifTrue: lit(high), ifFalse: lit(low) });
const handlers = createCoreHandlers();
const attack = (attackId, effects) => ({ attackId, name: `测试${attackId}`, cost: ['Water'], printedDamage: null, effects, sourceOfTruth: EVIDENCE });
async function make() {
  return fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 500; d.mechanics.weakness = null; }
    def(defs, 'base').mechanics.attacks.push(
      attack('base:pursuit', [binding('cn.damage@1', { side: 'opponent', target: 'bench', amount: choose(moved('retreat', 'target'), 120, 30),
        selection: { kind: 'exact', count: 1 }, options: {} }, 'pursuit')]),
      attack('base:stakeout', [binding('cn.damageValue@1', { expression: choose(moved('benchToActive', 'opponentActive'), 150, 30) }, 'stakeout')]));
    // 「将自己的战斗宝可梦与备战宝可梦互换」: a switching effect, not Retreat.
    def(defs, 'potion').mechanics.effects = [binding('cn.switch@1', { side: 'own', chooser: 'self', affected: 'active' }, 'switch')];
  });
}
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const pick = (id) => (q) => q.options.includes(id) ? [id] : q.options.slice(0, q.minimum);
// Turn 5 (player 0) ends; in turn 6 player 1 runs `turn6` with its Active `a` and Benched `x` (both 「测试宝可梦base」) and `y`;
// then, after `between` more turns, player 0 uses `attackId` (bench damage aimed at `target(ids)`) and the damage dealt is returned.
function play(f, turn6, attackId, target = () => null, { between = 0, before = () => {} } = {}) {
  const ids = {};
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water'); attached(s, 1, s.players[1].active, 'water');
    ids.a = s.players[1].active.id; ids.x = bench(s, 1, 'base').id; ids.y = bench(s, 1, 'other').id;
    ids.evolution = hand(s, 1, 'evolution'); ids.switch = hand(s, 1, 'potion');
  });
  command(g, { type: 'endTurn' }); settle(g);
  turn6(g, ids);
  command(g, { type: 'endTurn' }, 1); settle(g);
  for (let i = 0; i < between; i++) { command(g, { type: 'endTurn' }, i % 2); settle(g); }
  const snapshot = restore(g, f).snapshot(); before(snapshot, ids);
  const r = OfficialGame.restore(snapshot, { catalog: f.catalog }), from = r.snapshot().events.length;
  command(r, { type: 'attack', attackId }); settle(r, pick(target(ids)));
  return r.snapshot().events.slice(from).filter((e) => e.ruleId === 'attack.order' && Object.hasOwn(e.data, 'damage'))
    .reduce((n, e) => n + e.data.damage, 0);
}
const retreat = (g, ids) => {
  command(g, { type: 'retreat' }, 1);
  answer(g, g.snapshot().pending.options); answer(g, [ids.x]); settle(g);
  assert.equal(g.snapshot().players[1].active.id, ids.x);
};
const evolve = (g, id, ids) => { command(g, { type: 'evolve', cardId: ids.evolution, pokemonId: id }, 1); settle(g); };

test('schema, rule and the pure ledger: a Retreat is its player\'s own action', () => {
  assert(requireRule(CN_V20261019, 'history.previous-opponent-move').sourceOfTruth.some((s) => s.section === 'II.E-24'));
  const valid = (condition) => handlers.get('cn.damageValue@1').validateParameters({ expression: choose(condition, 150, 30) });
  for (const node of [moved('retreat', 'target'), moved('benchToActive', 'opponentActive')]) assert(valid(node), JSON.stringify(node));
  for (const node of [moved('switch', 'target'), moved('retreat', 'self'), { kind: 'historyFact', fact: 'previousOpponentMove', move: 'retreat' }])
    assert(!valid(node), JSON.stringify(node));
  let h = recordBattleTurn(createBattleHistory(), { turn: 1, player: 1 });
  assert.throws(() => recordBattleEvent(h, { kind: 'retreat', turn: 1, during: 1, owner: 0, pokemonId: 'm1' }, { turn: 1, during: 1 }),
    (e) => e instanceof BattleHistoryError && e.code === 'invalid-history-event');
  h = recordBattleEvent(h, { kind: 'benchToActive', turn: 1, during: 1, owner: 1, pokemonId: 'm2' }, { turn: 1, during: 1 });
  h = recordBattleEvent(h, { kind: 'retreat', turn: 1, during: 1, owner: 1, pokemonId: 'm1' }, { turn: 1, during: 1 });
  h = recordBattleTurn(h, { turn: 2, player: 0 });
  const at = { turn: 2, during: 0 };
  assert(movedInPreviousOpponentTurn(h, at, 0, 'm1', 'retreat'));
  assert(movedInPreviousOpponentTurn(h, at, 0, 'm2', 'benchToActive'));
  assert(!movedInPreviousOpponentTurn(h, at, 0, 'm1', 'benchToActive'));
  assert(!movedInPreviousOpponentTurn(h, at, 0, 'm1', 'retreat', 2), 'Only facts of its current form, recorded from index 2.');
  assert(!movedInPreviousOpponentTurn(h, at, 1, 'm1', 'retreat'), 'Player 1 has no earlier opponent turn.');
  for (const [kind, since] of [['heal', 0], ['retreat', -1], ['retreat', 1.5]])
    assert.throws(() => movedInPreviousOpponentTurn(h, at, 0, 'm1', kind, since), (e) => e.code === 'invalid-history-query');
});

test('「如果那只宝可梦从战斗场撤退了的话，这个招式的伤害变为「120」点」: the Pokémon that retreated, not another', async () => {
  const f = await make();
  assert.equal(play(f, retreat, 'base:pursuit', (ids) => ids.a), 120);
  assert.equal(play(f, retreat, 'base:pursuit', (ids) => ids.y), 30, 'Another Benched Pokémon.');
  assert.equal(play(f, () => {}, 'base:pursuit', (ids) => ids.x), 30, 'No Retreat.');
  // JP Q&A スカタンクV: a switching effect is not a Retreat.
  const switched = (g, ids) => { command(g, { type: 'playTrainer', cardId: ids.switch }, 1); settle(g, pick(ids.x)); };
  assert.equal(play(f, switched, 'base:pursuit', (ids) => ids.a), 30);
  // JP Q&A スカタンクV: it retreated, then evolved — no longer that Pokémon.
  assert.equal(play(f, (g, ids) => { retreat(g, ids); evolve(g, ids.a, ids); }, 'base:pursuit', (ids) => ids.a), 30);
  // Evolved first, then retreated: that Pokémon did retreat.
  assert.equal(play(f, (g, ids) => { evolve(g, ids.a, ids); retreat(g, ids); }, 'base:pursuit', (ids) => ids.a), 120);
  // Only the latest opponent turn counts.
  assert.equal(play(f, retreat, 'base:pursuit', (ids) => ids.a, { between: 2 }), 30);
});

test('「如果对手的战斗宝可梦，是从备战区被放于战斗场上的话，则追加造成120点伤害」', async () => {
  const f = await make();
  assert.equal(play(f, retreat, 'base:stakeout'), 150, 'Brought in by its player\'s Retreat.');
  const switched = (g, ids) => { command(g, { type: 'playTrainer', cardId: ids.switch }, 1); settle(g, pick(ids.x)); };
  assert.equal(play(f, switched, 'base:stakeout'), 150, 'Or by a switching effect.');
  assert.equal(play(f, () => {}, 'base:stakeout'), 30, 'Still the same Active Pokémon.');
  // JP Q&A デカグース: it came in, then evolved — no longer that Pokémon.
  assert.equal(play(f, (g, ids) => { retreat(g, ids); evolve(g, ids.x, ids); }, 'base:stakeout'), 30);
  // A later devolution likewise starts a new form at its history position (devolvePokemon records it as evolution does).
  assert.equal(play(f, retreat, 'base:stakeout', undefined, { before: (s) => { s.players[1].active.facts.formSince = s.battleHistory.events.length; } }), 30);
  const g = board(f), s = g.snapshot();
  s.players[1].active.facts.formSince = s.battleHistory.events.length + 1;
  assert.throws(() => OfficialGame.restore(s, { catalog: f.catalog }), (e) => e.code === 'invalid-time', 'No form from future history.');
});
