// Synthetic definitions only. 「在这个回合」 (II.E-20 turn end; II.D-17 文例2): a player's own attack boost for the rest of
// this turn, and a Pokémon's own boost for this turn, ending before the checkup. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { createPlayerOngoingEffect } from '../../public/rules/ongoing.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, board, command, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();
const valid = (id, p) => handlers.get(id).validateParameters(clone(p));
const boost = (amount, extra = {}) => ({ op: 'modifier', field: 'attackDamage', amount, scope: 'own', targetSide: 'opponent',
  targetPosition: 'active', ...extra });
const thisTurn = (effect, side = 'own') => ({ side, effect, duration: 'thisTurn' });
const sturdy = (defs) => { for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 500; d.mechanics.weakness = null; d.mechanics.resistance = null; } };
function dealt(g) {
  const from = g.snapshot().events.length;
  command(g, { type: 'attack', attackId: `${g.snapshot().cards[g.snapshot().players[0].active.stack.at(-1)].definitionId}:strike` });
  settle(g);
  return g.snapshot().events.slice(from).filter((e) => e.ruleId === 'attack.order' && Object.hasOwn(e.data, 'damage'))
    .reduce((n, e) => n + e.data.damage, 0);
}

test('schemas: a player\'s own boost; 「在这个回合」 for players and Pokémon; the rule cites II.E-20', () => {
  assert(requireRule(CN_V20261019, 'effects.duration.this-turn').sourceOfTruth.some((s) => s.section.includes('II.E-20')));
  for (const p of [thisTurn(boost(30, { targetSelector: { kind: 'pokemon', types: ['Water'] } })), thisTurn(boost(40, { otherSelector: { kind: 'pokemon', tagsAll: ['ex'] } })),
    { side: 'opponent', duration: 'thisTurn', effect: { op: 'playerRestriction', scope: 'all', actions: ['playItem'] } }])
    assert(valid('cn.lastingPlayer@1', p), JSON.stringify(p));
  for (const p of [thisTurn(boost(30), 'opponent'), thisTurn({ ...boost(30), field: 'hp' }), thisTurn(boost(25)), thisTurn({ ...boost(30), scope: 'all' })])
    assert(!valid('cn.lastingPlayer@1', p), JSON.stringify(p));
  assert(valid('cn.lasting@1', { side: 'own', target: 'self', duration: 'thisTurn', clearOnBench: true, clearOnEvolution: false,
    effect: { op: 'modifier', field: 'attackDamage', amount: 120, scope: 'all', targetSide: 'opponent', targetPosition: 'active' } }));
});

test('「在这个回合，自己的【水】宝可梦所使用的招式，给对手战斗宝可梦造成的伤害「+30」」 until this turn ends', async () => {
  const f = await fixture((defs) => { sturdy(defs);
    def(defs, 'potion').mechanics.effects = [binding('cn.lastingPlayer@1', thisTurn(boost(30, { targetSelector: { kind: 'pokemon', types: ['Water'] } })), 'boost')]; });
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); attached(s, 0, s.players[0].active, 'water'); });
  assert(g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card));
  command(g, { type: 'playTrainer', cardId: card }); settle(g);
  const v = g.view(0).playerOngoing;
  assert.deepEqual([v.length, v[0].active, v[0].rule.ruleId], [1, true, 'effects.duration.this-turn']);
  OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.equal(dealt(g), 50);
  assert.equal(g.snapshot().playerOngoing.length, 0, 'Gone at the end of this turn, before the checkup.');
  const fire = await fixture((defs) => { sturdy(defs);
    def(defs, 'potion').mechanics.effects = [binding('cn.lastingPlayer@1', thisTurn(boost(30, { targetSelector: { kind: 'pokemon', types: ['Fire'] } })), 'boost')]; });
  const h = board(fire, (s) => { card = hand(s, 0, 'potion'); attached(s, 0, s.players[0].active, 'water'); });
  command(h, { type: 'playTrainer', cardId: card }); settle(h);
  assert.equal(dealt(h), 20, 'Only the printed kind of Pokémon.');
});

test('an Ability with a discard cost gives the boost; a Pokémon\'s own boost for this turn after counters on itself', async () => {
  const built = await fixture((defs) => { sturdy(defs);
    def(defs, 'other').mechanics.abilities = [{ abilityId: 'fixture:roar', name: '测试咆哮', mode: 'activated', sourceOfTruth: EVIDENCE,
      usage: { period: 'turn', scope: 'pokemon', key: 'fixture:roar', limit: 1 },
      costs: [{ costId: 'fixture:roar:cost', kind: 'discardHand', count: 1, selector: { kind: 'energy', category: 'basic', types: ['Fire'] }, sourceOfTruth: EVIDENCE }],
      effects: [binding('cn.lastingPlayer@1', thisTurn(boost(60)), 'roar')] }];
    def(defs, 'base').mechanics.abilities = [{ abilityId: 'fixture:rage', name: '测试蓄力', mode: 'activated', sourceOfTruth: EVIDENCE,
      usage: { period: 'turn', scope: 'pokemon', key: 'fixture:rage', limit: 1 },
      effects: [binding('cn.then@1', { first: { handlerId: 'cn.counters@1', parameters: { side: 'own', target: 'self', count: 5 } },
        next: { handlerId: 'cn.lasting@1', parameters: { side: 'own', target: 'self', duration: 'thisTurn', clearOnBench: true, clearOnEvolution: false,
          effect: { op: 'modifier', field: 'attackDamage', amount: 120, scope: 'all', targetSide: 'opponent', targetPosition: 'active' } } } }, 'rage')] }];
  });
  const f = { ...built, deck: [...built.deck.slice(0, 59), 'printing:fire'] };
  let mon;
  const usable = (g) => g.view(0).legalActions.some((a) => a.type === 'useAbility' && a.abilityId === 'fixture:roar');
  assert(!usable(board(f, (s) => { mon = bench(s, 0, 'other'); })));
  const g = board(f, (s) => { mon = bench(s, 0, 'other'); hand(s, 0, 'fire'); attached(s, 0, s.players[0].active, 'water'); });
  assert(usable(g));
  command(g, { type: 'useAbility', pokemonId: mon.id, abilityId: 'fixture:roar' }); settle(g);
  assert.equal(dealt(g), 80);
  const h = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); });
  command(h, { type: 'useAbility', pokemonId: h.snapshot().players[0].active.id, abilityId: 'fixture:rage' }); settle(h);
  assert.equal(h.snapshot().players[0].active.counters, 5);
  assert.equal(dealt(h), 140);
  assert.equal(h.snapshot().ongoing.length, 0);
});

test('a this-turn effect starts only on its user\'s own turn; a forged deadline cannot be restored', async () => {
  const source = { instanceId: 'x', owner: 1, cardOwner: 1, category: 'trainer', pokemonId: null, attackId: null, effectId: 'fixture:x',
    sourceOfTruth: EVIDENCE, origin: 'hand' };
  const state = { current: 0, players: [{ turns: 3 }, { turns: 2 }] };
  assert.throws(() => createPlayerOngoingEffect({ id: 'e1', player: 1, source, effect: boost(30), duration: 'thisTurn' }, state), /own turn/);
  const f = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.lastingPlayer@1', thisTurn(boost(30)), 'boost')]; });
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); });
  command(g, { type: 'playTrainer', cardId: card }); settle(g);
  for (const mutate of [(e) => { e.deadline.player = 1; }, (e) => { e.deadline.boundary = 'checkup-end'; }, (e) => { e.ruleId = 'effects.duration.turn-only'; },
    (e) => { e.deadline.ownerTurn -= 1; }]) {
    const s = clone(g.snapshot()); mutate(s.playerOngoing[0]);
    assert.throws(() => OfficialGame.restore(s, { catalog: f.catalog }));
  }
});
