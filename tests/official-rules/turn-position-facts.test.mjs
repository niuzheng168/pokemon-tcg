// Synthetic definitions only. Facts of the user's turn and of 「这只宝可梦」 read by conditions: its position (「如果这只宝可梦在
// 战斗场上／在备战区的话」), each player's own first turn (I.A-05: 「最初的自己的回合」「后攻玩家的最初回合」) and an
// evolution this turn from a named card (II.E-23 文例2, FAQ1). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, assertSupportedDefinition } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { assertBattlePredicate } from '../../public/rules/battle-predicate.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, board, command, settle, hand, bench, attached, fixtureClock } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();
const leaf = (handlerId, parameters) => ({ handlerId, parameters });
const draw = (count) => leaf('cn.draw@1', { count });
const fact = (name, extra = {}) => ({ kind: 'historyFact', fact: name, ...extra });
const sturdy = (defs) => { for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 500; d.mechanics.weakness = null; d.mechanics.resistance = null; } };

test('predicates and rule: a position, the first turns, an evolution this turn from a named card', () => {
  assert(requireRule(CN_V20261019, 'history.first-turn').sourceOfTruth.some((s) => s.section.includes('I.A-05')));
  for (const p of [{ kind: 'pokemonIs', who: 'self', position: 'bench' }, { kind: 'pokemonIs', who: 'self', position: 'active', state: { damaged: true } },
    fact('firstOwnTurn'), fact('secondPlayerFirstTurn'), fact('evolvedThisTurn'), fact('evolvedThisTurn', { selector: { kind: 'pokemon', nameKeys: ['base'] } })])
    assert.doesNotThrow(() => assertBattlePredicate(p), JSON.stringify(p));
  for (const p of [{ kind: 'pokemonIs', who: 'self', position: 'hand' }, fact('firstOwnTurn', { selector: { kind: 'pokemon' } }),
    fact('evolvedThisTurn', { selector: { kind: 'trainer' } }), fact('lastTurn')])
    assert.throws(() => assertBattlePredicate(p), (e) => e.code === 'invalid-battle-predicate', JSON.stringify(p));
  const when = (condition) => handlers.get('cn.when@1').validateParameters({ condition, effect: draw(1) });
  assert(when({ kind: 'pokemonIs', who: 'self', position: 'bench' }) && when(fact('evolvedThisTurn', { selector: { kind: 'pokemon', nameKeys: ['base'] } })));
  assert(!when({ kind: 'pokemonIs', who: 'self', position: 'deck' }));
  // A Trainer has no 「这只宝可梦」 to have evolved.
  const catalog = { handler: (id) => handlers.get(id) };
  const item = { kind: 'trainer', mechanics: { category: 'item', effects: [binding('cn.when@1', { condition: fact('evolvedThisTurn'), effect: draw(1) }, 'if')] } };
  assert.throws(() => assertSupportedDefinition(catalog, item), (e) => e.code === 'unsupported-condition');
  item.mechanics.effects[0].parameters.condition = fact('secondPlayerFirstTurn');
  assert.doesNotThrow(() => assertSupportedDefinition(catalog, item));
});

test('「如果这只宝可梦在备战区的话，则在自己的回合可以使用1次」 and 「…在战斗场上…」', async () => {
  const ability = (position) => async () => fixture((defs) => {
    def(defs, 'other').mechanics.abilities = [{ abilityId: 'fixture:post', name: '测试岗位', mode: 'activated', sourceOfTruth: EVIDENCE,
      usage: { period: 'turn', scope: 'pokemon', key: 'fixture:post', limit: 1 },
      condition: { predicate: { kind: 'pokemonIs', who: 'self', position } }, effects: [binding('cn.draw@1', { count: 1 }, 'draw')] }];
  });
  const usable = (g, mon) => g.view(0).legalActions.some((a) => a.type === 'useAbility' && a.pokemonId === mon.id && a.abilityId === 'fixture:post');
  const benched = await ability('bench')();
  let mon;
  const g = board(benched, (s) => { mon = bench(s, 0, 'other'); });
  assert(usable(g, mon));
  command(g, { type: 'useAbility', pokemonId: mon.id, abilityId: 'fixture:post' }); settle(g);
  assert(!usable(g, mon), 'Once per turn.');
  const front = board(benched, (s) => { mon = bench(s, 0, 'other'); s.players[0].bench.push(s.players[0].active); s.players[0].active = s.players[0].bench.shift(); });
  assert.equal(front.snapshot().players[0].active.id, mon.id);
  assert(!usable(front, mon));
  const active = await ability('active')();
  const h = board(active, (s) => { mon = bench(s, 0, 'other'); s.players[0].bench.push(s.players[0].active); s.players[0].active = s.players[0].bench.shift(); });
  assert(usable(h, mon));
  assert(!usable(board(active, (s) => { mon = bench(s, 0, 'other'); }), mon));
});

test('「从自己的牌库上方抽取2张卡牌。如果是后攻玩家的最初回合的话，则额外抽取3张卡牌。」 and 「最初的自己的回合」', async () => {
  for (const [name, clocks] of [['secondPlayerFirstTurn', [[[1, 0], 5], [[0], 2], [[0, 1, 0], 2]]], ['firstOwnTurn', [[[0], 5], [[1, 0], 5], [[0, 1, 0], 2]]]]) {
    const f = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.draw@1', { count: 2 }, 'draw'),
      binding('cn.when@1', { condition: fact(name), effect: draw(3) }, 'more')]; });
    for (const [players, drawn] of clocks) {
      let card;
      const g = board(f, (s) => { fixtureClock(s, players); card = hand(s, 0, 'potion'); });
      const before = g.snapshot().players[0].hand.length;
      command(g, { type: 'playTrainer', cardId: card }); settle(g);
      assert.equal(g.snapshot().players[0].hand.length - before + 1, drawn, `${name} ${JSON.stringify(players)}`);
    }
  }
});

test('II.E-23: 「在这个回合，如果这只宝可梦从「X」进化而来的话，则…」 reads the card it actually evolved from, this turn only', async () => {
  const f = await fixture((defs) => { sturdy(defs);
    def(defs, 'evolution').mechanics.attacks[0].effects = [binding('cn.when@1', { condition: fact('evolvedThisTurn', { selector: { kind: 'pokemon', nameKeys: ['base'] } }),
      effect: leaf('cn.condition@1', { side: 'opponent', condition: 'paralyzed' }) }, 'shock')]; });
  const attack = (g) => {
    const s = g.snapshot(), id = s.players[0].active.stack.at(-1);
    command(g, { type: 'attack', attackId: `${s.cards[id].definitionId}:strike` }); settle(g);
    return g.snapshot().players[1].active.conditions.rotation;
  };
  let mon, card;
  const g = board(f, (s) => { mon = s.players[0].active; card = hand(s, 0, 'evolution'); attached(s, 0, mon, 'water'); attached(s, 0, mon, 'water'); });
  command(g, { type: 'evolve', cardId: card, pokemonId: mon.id }); settle(g);
  OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.equal(attack(g), 'paralyzed');
  // Evolved in an earlier turn: not this turn.
  const h = board(f, (s) => { mon = s.players[0].active; card = hand(s, 0, 'evolution'); s.players[0].hand.pop(); mon.stack.push(card);
    mon.evolvedTurn = s.turn - 2; mon.facts.evolution = { turn: s.turn - 2, fromCardId: mon.stack[0], toCardId: card, method: 'ordinary', origin: 'hand' };
    attached(s, 0, mon, 'water'); attached(s, 0, mon, 'water'); });
  assert.equal(attack(h), null);
  // From another named card: the printed result does not apply.
  const other = await fixture((defs) => { sturdy(defs);
    def(defs, 'evolution').mechanics.attacks[0].effects = [binding('cn.when@1', { condition: fact('evolvedThisTurn', { selector: { kind: 'pokemon', nameKeys: ['other'] } }),
      effect: leaf('cn.condition@1', { side: 'opponent', condition: 'paralyzed' }) }, 'shock')]; });
  const k = board(other, (s) => { mon = s.players[0].active; card = hand(s, 0, 'evolution'); attached(s, 0, mon, 'water'); attached(s, 0, mon, 'water'); });
  command(k, { type: 'evolve', cardId: card, pokemonId: mon.id }); settle(k);
  assert.equal(attack(k), null);
});
