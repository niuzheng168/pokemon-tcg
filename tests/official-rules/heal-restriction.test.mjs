// Synthetic definitions only. 「只要这只宝可梦在场上，双方所有的宝可梦，无法回复HP」 and 「在下一个对手的回合，受到这个招式影响的宝可梦，
// 无法回复HP」: every HP-healing effect leaves the affected Pokémon's damage counters unchanged. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, EVIDENCE, board, command, settle, hand, attached, bench } from './fixtures.mjs';

const noHeal = (extra = {}) => ({ effect: { op: 'restriction', scope: 'all', actions: ['heal'], ...extra } });
const playable = (g, card, player = 0) => g.view(player).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card);

test('an Ability: no Pokémon in play can be healed', async () => {
  assert(createCoreHandlers().get('cn.restriction@1').validateParameters(noHeal({ scope: 'opponent', benchOnly: true })));
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'other').mechanics.abilities = [{ abilityId: 'other:wither', name: '测试枯萎', mode: 'continuous',
      usage: null, effects: [binding('cn.restriction@1', noHeal(), 'wither')], sourceOfTruth: EVIDENCE }];
    defs.find((d) => d.definitionId === 'research').mechanics.effects = [binding('cn.switch@1',
      { side: 'own', chooser: 'self', affected: 'active', outgoingHeal: 30 }, 'switch-heal')];
  });
  let potion, tool;
  const g = board(f, (s) => { potion = hand(s, 0, 'potion'); s.players[0].active.counters = 3; bench(s, 1, 'other'); });
  assert(!playable(g, potion), 'The only damaged Pokémon cannot be healed.');
  const free = board(f, (s) => { potion = hand(s, 0, 'potion'); s.players[0].active.counters = 3; });
  assert(playable(free, potion));
  const h = board(f, (s) => { tool = hand(s, 0, 'research'); s.players[0].active.counters = 3; bench(s, 0, 'base'); bench(s, 1, 'other'); });
  const outgoing = h.snapshot().players[0].active.id;
  command(h, { type: 'playTrainer', cardId: tool }); settle(h);
  assert.equal(h.snapshot().players[0].bench.find((m) => m.id === outgoing).counters, 3, 'Switched, not healed.');
  assert(h.snapshot().events.some((e) => e.ruleId === 'effects.heal' && e.data.prevented === 'restriction'));
});

test('after an attack, the affected Pokémon cannot be healed during the opponent\'s next turn', async () => {
  const wound = { side: 'opponent', target: 'active', effect: { op: 'restriction', scope: 'all', actions: ['heal'] },
    duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true };
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'base').mechanics.attacks.push({ attackId: 'base:wound', name: '测试重伤', cost: ['Water'],
      printedDamage: { value: 30, operator: 'fixed' }, effects: [binding('cn.lasting@1', wound, 'wound')], sourceOfTruth: EVIDENCE });
  });
  let potion;
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); potion = hand(s, 1, 'potion'); });
  command(g, { type: 'attack', attackId: 'base:wound' }); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 3);
  assert(!playable(g, potion, 1));
});

test('「无法从手牌将能量附着于／无法从手牌使出宝可梦放于受到这个招式影响的宝可梦身上进行进化」', async () => {
  const lock = (actions) => ({ side: 'opponent', target: 'active', effect: { op: 'restriction', scope: 'all', actions },
    duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true });
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'base').mechanics.attacks.push({ attackId: 'base:mud', name: '测试泥沼', cost: ['Water'],
      printedDamage: null, effects: [binding('cn.lasting@1', lock(['attachFromHand', 'evolveFromHand']), 'mud')], sourceOfTruth: EVIDENCE });
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.attachHand@1',
      { type: 'Water', count: 1, benchOnly: false, optional: false, target: 'active' }, 'attach')];
  });
  let water, evolution, potion, benched;
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water');
    water = hand(s, 1, 'water'); evolution = hand(s, 1, 'evolution'); potion = hand(s, 1, 'potion'); benched = bench(s, 1, 'base');
    s.players[1].active.enteredTurn = 0; benched.enteredTurn = 0;
  });
  command(g, { type: 'attack', attackId: 'base:mud' }); settle(g);
  const active = g.snapshot().players[1].active.id, legal = g.view(1).legalActions;
  assert(!legal.some((a) => a.type === 'attachEnergy' && a.pokemonId === active));
  assert(legal.some((a) => a.type === 'attachEnergy' && a.cardId === water && a.pokemonId === benched.id));
  assert(!legal.some((a) => a.type === 'evolve' && a.pokemonId === active));
  assert(legal.some((a) => a.type === 'evolve' && a.cardId === evolution && a.pokemonId === benched.id));
  command(g, { type: 'playTrainer', cardId: potion }); settle(g);
  assert.equal(g.snapshot().players[1].active.energy.length, 0, 'An effect attaching from hand cannot use it either.');
});
