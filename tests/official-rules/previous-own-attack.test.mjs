// Synthetic definitions only. 「在上一个自己的回合，如果这只宝可梦使用了「X」的话，则追加造成N伤害」 and the like: the attacks the
// user's Pokémon actually used in the user's previous own turn (I.A-01; a confused attack that fails is not used). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { createBattleHistory, recordBattleTurn, recordBattleEvent, attacksInPreviousOwnTurn } from '../../public/rules/battle-history.js';
import { fixture, binding, EVIDENCE, board, command, settle, attached, bench } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const lit = (value) => ({ kind: 'literal', value });
const used = (extra) => ({ kind: 'historyFact', fact: 'previousOwnAttack', ...extra });
const bonus = (condition) => ({ kind: 'choose', condition, ifTrue: lit(90), ifFalse: lit(10) });
const damageValue = createCoreHandlers().get('cn.damageValue@1');

async function make(condition) {
  return fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 500; d.mechanics.weakness = null; }
    const base = defs.find((d) => d.definitionId === 'base');
    base.mechanics.attacks.push({ attackId: 'base:combo', name: '测试连招', cost: ['Water'], printedDamage: null,
      effects: [binding('cn.damageValue@1', { expression: bonus(condition) }, 'combo')], sourceOfTruth: EVIDENCE });
  });
}
const dealt = (g, from) => g.snapshot().events.slice(from).filter((e) => e.ruleId === 'attack.order' && Object.hasOwn(e.data, 'damage'))
  .reduce((n, e) => n + e.data.damage, 0);
// Player 0 uses `first` (or nothing), player 1 ends its turn, then player 0 uses the combo attack; returns the combo's damage.
function play(f, first, mutate = () => {}) {
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); mutate(s); });
  if (first) command(g, { type: 'attack', attackId: first }); else command(g, { type: 'endTurn' });
  settle(g); command(g, { type: 'endTurn' }); settle(g);
  OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  const from = g.snapshot().events.length;
  command(g, { type: 'attack', attackId: 'base:combo' }); settle(g);
  return dealt(g, from);
}

test('previousOwnAttack: schema, rule and the pure ledger query', () => {
  assert(requireRule(CN_V20261019, 'history.previous-own-attack').sourceOfTruth.some((s) => s.section.includes('I.A-01')));
  for (const node of [used({ by: 'self', attackNames: ['X'] }), used({ by: 'other', selector: { kind: 'pokemon', tagsAll: ['Rapid Strike'] } }), used({ by: 'any' })])
    assert(damageValue.validateParameters({ expression: bonus(node) }), JSON.stringify(node));
  for (const node of [used({}), used({ by: 'opponent' }), used({ by: 'self', attackNames: [] }), used({ by: 'self', attackNames: ['X', 'X'] }),
    used({ by: 'any', selector: { kind: 'trainer' } })])
    assert(!damageValue.validateParameters({ expression: bonus(node) }), JSON.stringify(node));
  let h = createBattleHistory();
  h = recordBattleTurn(h, { turn: 1, player: 0 });
  h = recordBattleEvent(h, { kind: 'attackUsed', turn: 1, during: 0, owner: 0, pokemonId: 'm1', cardId: 'c1', attackName: 'X' }, { turn: 1, during: 0 });
  assert.throws(() => recordBattleEvent(h, { kind: 'attackUsed', turn: 1, during: 1, owner: 0, pokemonId: 'm1', cardId: 'c1', attackName: 'X' },
    { turn: 1, during: 1 }));
  h = recordBattleTurn(recordBattleTurn(h, { turn: 2, player: 1 }), { turn: 3, player: 0 });
  assert.deepEqual(attacksInPreviousOwnTurn(h, { turn: 3, during: 0 }, 0).map((e) => e.attackName), ['X']);
  assert.deepEqual(attacksInPreviousOwnTurn(h, { turn: 3, during: 0 }, 1), [], 'Judged on the owner\'s own turn only.');
  assert.deepEqual(attacksInPreviousOwnTurn(recordBattleTurn(h, { turn: 4, player: 0 }), { turn: 4, during: 0 }, 0), [],
    'Only the immediately previous own turn.');
});

test('「在上一个自己的回合，如果这只宝可梦使用了「测试撞击」的话」 reads the attack this Pokémon actually used', async () => {
  const f = await make(used({ by: 'self', attackNames: ['测试撞击'] }));
  assert.equal(play(f, 'base:strike'), 90);
  assert.equal(play(f, null), 10, 'No attack in the previous own turn.');
  assert.equal(play(f, 'base:combo'), 10, 'Another attack.');
  const other = await make(used({ by: 'other' }));
  assert.equal(play(other, 'base:strike'), 10, 'This Pokémon, not another one, attacked.');
  const any = await make(used({ by: 'any', selector: { kind: 'pokemon', nameKeys: ['base'] }, attackNames: ['测试撞击'] }));
  assert.equal(play(any, 'base:strike'), 90);
});

test('II.E-11 with a printed kind: 「在上一个对手的回合，如果因为招式的伤害，而导致自己的【水】宝可梦【昏厥】的话」', async () => {
  const ko = (selector) => ({ kind: 'historyFact', fact: 'previousOpponentKnockout', cause: 'attackDamage', selector });
  assert(damageValue.validateParameters({ expression: bonus(ko({ kind: 'pokemon', types: ['Water'] })) }));
  assert(!damageValue.validateParameters({ expression: bonus(ko({ kind: 'trainer' })) }));
  // Player 0's Active 「测试宝可梦base」 is Knocked Out by player 1's attack; player 0's new Active then uses the revenge attack.
  const revenge = async (selector) => {
    const f = await fixture((defs) => {
      for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.weakness = null;
      defs.find((d) => d.definitionId === 'other').mechanics.attacks.push({ attackId: 'other:revenge', name: '测试复仇', cost: ['Water'],
        printedDamage: null, effects: [binding('cn.damageValue@1', { expression: bonus(ko(selector)) }, 'revenge')], sourceOfTruth: EVIDENCE });
    });
    const g = board(f, (s) => {
      s.players[0].active.counters = 9;
      const m = bench(s, 0, 'other'); attached(s, 0, m, 'water');
      attached(s, 1, s.players[1].active, 'water');
    });
    command(g, { type: 'endTurn' }); settle(g);
    command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
    assert.equal(g.snapshot().current, 0); assert.equal(f.catalog.definition(g.snapshot().cards[g.snapshot().players[0].active.stack[0]].definitionId).definitionId, 'other');
    OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
    const from = g.snapshot().events.length;
    command(g, { type: 'attack', attackId: 'other:revenge' }); settle(g);
    return dealt(g, from);
  };
  assert.equal(await revenge({ kind: 'pokemon', types: ['Water'] }), 90);
  assert.equal(await revenge({ kind: 'pokemon', nameKeys: ['base'] }), 90);
  assert.equal(await revenge({ kind: 'pokemon', types: ['Fire'] }), 10, 'The Knocked Out Pokémon was not a Fire Pokémon.');
});
