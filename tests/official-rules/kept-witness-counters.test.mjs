// Synthetic definitions only. 「只要这只宝可梦在战斗场上，即使自己使用了「X」，自己的回合也不会结束」 (effects.turn-kept);
// 「在自己的回合，如果从手牌使出宝可梦使自己的其他「X」进行进化了的话，则可使用1次」 (II.E-23, historyFact otherEvolvedFromHand);
// 「不会因为对手的…招式的效果，而被放置伤害指示物」 (protection channel counters; JP official Q&A: moved counters are not placed either);
// 「选择自己手牌中的1张「X」，附着于…」 (attachHand nameKeys). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, EVIDENCE, board, command, settle, hand, bench } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();
const continuous = (abilityId, effects) => ({ abilityId, name: '测试特性', mode: 'continuous', usage: null, effects, sourceOfTruth: EVIDENCE });
const activated = (abilityId, effects, extra = {}) => ({ abilityId, name: '测试特性', mode: 'activated',
  usage: { period: 'turn', scope: 'pokemon', key: abilityId, limit: 1 }, effects, sourceOfTruth: EVIDENCE, ...extra });
const usable = (g, pokemonId) => g.view(g.snapshot().current).legalActions.some((a) => a.type === 'useAbility' && a.pokemonId === pokemonId);

test('「即使自己使用了「X」，自己的回合也不会结束」: judged while the holder is Active when the card is played', async () => {
  const kept = { op: 'turnKept', scope: 'own', sourceActive: true, trainer: { kind: 'trainer', nameKeys: ['research'] } };
  assert(handlers.get('cn.turnKept@1').validateParameters({ effect: kept }));
  assert(!handlers.get('cn.turnKept@1').validateParameters({ effect: { ...kept, scope: 'all' } }));
  const f = await fixture((defs) => {
    const r = def(defs, 'research'); r.mechanics.effects = [binding('cn.draw@1', { count: 1 }, 'draw')]; r.mechanics.endsTurn = true;
    def(defs, 'other').mechanics.abilities = [continuous('other:order', [binding('cn.turnKept@1', { effect: kept }, 'order')])];
  });
  for (const active of [true, false]) {
    let card;
    const g = board(f, (s) => {
      card = hand(s, 0, 'research'); const p = s.players[0];
      const other = bench(s, 0, 'other');
      if (active) { p.bench = [p.active]; p.active = other; }
    });
    command(g, { type: 'playTrainer', cardId: card }); settle(g);
    const s = g.snapshot();
    assert.equal(s.current, active ? 0 : 1);
    assert.equal(s.events.some((e) => e.ruleId === 'effects.turn-kept'), active);
    if (active) assert.deepEqual(restore(g, f).snapshot(), s);
  }
});

test('「如果从手牌使出宝可梦使自己的其他「X」进行进化了的话」: only a Pokémon in play when another one evolved from the hand, that turn', async () => {
  const witnessed = { kind: 'historyFact', fact: 'otherEvolvedFromHand', selector: { kind: 'pokemon', nameKeys: ['base'] } };
  const f = await fixture((defs) => {
    for (const id of ['base', 'other'])
      def(defs, id).mechanics.abilities = [activated(`${id}:resonance`, [binding('cn.draw@1', { count: 1 }, 'draw')], { condition: { predicate: witnessed } })];
  });
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'evolution'); bench(s, 0, 'base'); });
  const [a, b] = [g.snapshot().players[0].active.id, g.snapshot().players[0].bench[0].id];
  assert(!usable(g, a));
  command(g, { type: 'evolve', cardId: card, pokemonId: b }); settle(g);
  assert(usable(g, a));
  const s = g.snapshot();
  assert.deepEqual(s.players[0].active.facts.witnessedEvolutions, { turn: s.turn, fromCardIds: [s.players[0].bench[0].stack[0]] });
  assert.deepEqual(restore(g, f).snapshot(), s);
  // A Pokémon put into play afterwards saw nothing.
  const s2 = clone(s), late = bench(s2, 0, 'other');
  assert(!usable(OfficialGame.restore(s2, { catalog: f.catalog }), late.id));
  command(g, { type: 'useAbility', pokemonId: a, abilityId: 'base:resonance' }); settle(g);
  assert(!usable(g, a), 'Once per turn.');
  for (let i = 0; i < 2; i++) { command(g, { type: 'endTurn' }); settle(g); }
  assert(!usable(g, a), 'Not in a later turn.');
  // A Trainer cannot read it.
  const trainer = await fixture((defs) => { def(defs, 'potion').mechanics.condition = { predicate: witnessed }; });
  assert.throws(() => board(trainer), /facts that exist/);
});

test('「不会因为对手的【基础】宝可梦所使用的招式的效果，而被放置伤害指示物」: counters, not damage; also when moved', async () => {
  const shield = { op: 'protection', channel: 'counters', useRule: 'ordinary', scope: 'own', from: 'opponent', categories: ['attack'],
    benchOnly: true, otherSelector: { kind: 'pokemon', stages: ['basic'] } };
  const f = await fixture((defs) => {
    def(defs, 'other').mechanics.abilities = [continuous('other:veil', [binding('cn.protection@1', { effect: shield }, 'veil')])];
    const a = def(defs, 'base').mechanics.attacks[0];
    a.effects = [binding('cn.counters@1', { side: 'opponent', target: 'bench', count: 2, all: true }, 'spread'),
      binding('cn.transferCounters@1', { side: 'opponent', from: 'active', originSide: 'opponent', target: 'any', count: 1 }, 'move')];
  });
  const water = (s) => { const p = s.players[0], i = p.deck.findIndex((id) => s.cards[id].definitionId === 'water'); p.active.energy.push(p.deck.splice(i, 1)[0]); };
  const g = board(f, (s) => { water(s); bench(s, 1, 'other'); bench(s, 1, 'base'); s.players[1].active.counters = 3; });
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  const foe = g.snapshot().players[1];
  assert.deepEqual(foe.bench.map((m) => m.counters).sort(), [0, 0], 'Both Benched Pokémon are shielded by the Ability on the field.');
  assert.equal(foe.active.counters, 3 + 2 - 1, 'Attack damage still counts; the moved counter leaves the Active and is not placed.');
  assert(g.snapshot().events.some((e) => e.ruleId === 'effects.protection'));
  // An activated Ability that places a counter cannot be used when every target is shielded from it.
  const self = { ...shield, scope: 'self', categories: ['ability'] };
  delete self.benchOnly; delete self.otherSelector;
  const blocked = await fixture((defs) => {
    def(defs, 'other').mechanics.abilities = [continuous('other:self', [binding('cn.protection@1', { effect: self }, 'self')])];
    def(defs, 'base').mechanics.abilities = [activated('base:poke', [binding('cn.counters@1', { side: 'opponent', target: 'active', count: 1 }, 'poke')])];
  });
  const h = board(blocked, (s) => { const o = bench(s, 1, 'other'), p = s.players[1]; p.bench = [p.active]; p.active = o; });
  assert(!usable(h, h.snapshot().players[0].active.id));
  assert(usable(board(blocked), board(blocked).snapshot().players[0].active.id));
});

test('「选择自己手牌中的1张「X」，附着于…」: only Energy of that name', async () => {
  const attach = (nameKeys) => ({ type: null, category: 'special', nameKeys, count: 1, benchOnly: false, optional: false });
  const valid = handlers.get('cn.attachHand@1').validateParameters;
  assert(valid(attach(['double'])));
  assert(!valid({ ...attach(['double']), category: undefined }));
  for (const [name, ok] of [['double', true], ['water', false]]) {
    const f = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.attachHand@1', attach([name]), 'attach')]; });
    let card;
    const g = board(f, (s) => { card = hand(s, 0, 'potion'); hand(s, 0, 'double'); });
    assert.equal(g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card), ok);
  }
});
