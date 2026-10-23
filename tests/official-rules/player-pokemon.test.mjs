// Synthetic definitions only. 「在使用这张卡牌的回合结束前，自己所有的宝可梦，无法使用招式。（也包括新出场的宝可梦。）」「在下一个对手的回合，
// 自己所有的宝可梦，受到对手宝可梦的招式的伤害「-30」。（也包括新出场的宝可梦。）」「在下一个对手的回合，对手所有宝可梦无法使用招式」「在下一个对手的回合，
// 自己的所有宝可梦，都不会受到招式的伤害和效果影响」「在下一个自己的回合，【草】或【火】宝可梦使用招式所需能量，全部消除」 (player effects on every
// Pokémon of a scope). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, board, command, settle, hand, bench } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();
const valid = (p) => handlers.get('cn.lastingPlayer@1').validateParameters(clone(p));
const lock = (scope) => ({ op: 'restriction', scope, actions: ['attack'] });
const shield = { op: 'modifier', field: 'defenseDamage', amount: -10, scope: 'own', damageFrom: 'opponent' };
const guard = (channel) => ({ op: 'protection', channel, useRule: 'ordinary', scope: 'own', from: 'opponent', categories: ['attack'] });
const free = { op: 'energyRequirement', action: 'attack', mode: 'erase', scope: 'own', targetSelector: { kind: 'pokemon', types: ['Grass', 'Water'] } };
const water = (s, owner) => {
  const p = s.players[owner], i = p.deck.findIndex((id) => s.cards[id].definitionId === 'water');
  p.active.energy.push(p.deck.splice(i, 1)[0]);
};
const canAttack = (g, player) => g.view(player).legalActions.some((a) => a.type === 'attack');
const strike = (g) => { command(g, { type: 'attack', attackId: 'base:strike' }); settle(g); };

test('schema', () => {
  for (const p of [{ side: 'own', effect: lock('own'), duration: 'thisTurn' }, { side: 'own', effect: lock('opponent'), duration: 'nextOpponentTurn' },
    { side: 'own', effect: { op: 'restriction', scope: 'opponent', actions: ['evolveFromHand'] }, duration: 'nextOpponentTurn' },
    { side: 'own', effect: { ...shield, otherSelector: { kind: 'pokemon', tagsAll: ['V'] } }, duration: 'nextOpponentTurn' },
    { side: 'own', effect: { ...guard('effects'), targetSelector: { kind: 'pokemon', tagsAll: ['Ultra Beast'] } }, duration: 'nextOpponentTurn' },
    { side: 'own', effect: free, duration: 'nextOwnTurn' }]) assert(valid(p), JSON.stringify(p));
  for (const p of [{ side: 'opponent', effect: lock('own'), duration: 'nextOpponentTurn' },
    { side: 'own', effect: { ...shield, field: 'hp' }, duration: 'nextOpponentTurn' },
    { side: 'own', effect: { ...free, mode: 'adjust', energyType: 'Colorless', amount: 1 }, duration: 'nextOwnTurn' },
    { side: 'own', effect: { ...lock('own'), activeOnly: true }, duration: 'thisTurn' },
    { side: 'own', effect: { ...lock('own'), scope: 'self' }, duration: 'thisTurn' },
    { side: 'own', effect: { ...lock('own'), condition: { kind: 'stadiumInPlay', owner: 'any' } }, duration: 'thisTurn' }])
    assert(!valid(p), JSON.stringify(p));
});

test('「在使用这张卡牌的回合结束前，自己所有的宝可梦，无法使用招式」 and the opponent\'s Pokémon in their next turn', async () => {
  const f = await fixture((defs) => {
    def(defs, 'potion').mechanics.effects = [binding('cn.lastingPlayer@1', { side: 'own', effect: lock('own'), duration: 'thisTurn' }, 'rest')];
    def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.lastingPlayer@1', { side: 'own', effect: lock('opponent'), duration: 'nextOpponentTurn' }, 'stop')];
  });
  let card;
  const g = board(f, (s) => { water(s, 0); card = hand(s, 0, 'potion'); });
  assert(canAttack(g, 0));
  command(g, { type: 'playTrainer', cardId: card }); settle(g);
  assert(!canAttack(g, 0));
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  const h = board(f, (s) => { water(s, 0); water(s, 1); });
  strike(h);
  assert.equal(h.snapshot().current, 1);
  assert(!canAttack(h, 1), 'Every one of their Pokémon, in their next turn.');
  command(h, { type: 'endTurn' }); settle(h);
  assert(canAttack(h, 0));
});

test('damage received 「-10」, protection from attacks, and an erased cost', async () => {
  const f = await fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.weakness = null;
    def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.lastingPlayer@1', { side: 'own', effect: shield, duration: 'nextOpponentTurn' }, 'shield')];
    def(defs, 'other').mechanics.attacks[0].effects = [binding('cn.lastingPlayer@1', { side: 'own', effect: guard('damage'), duration: 'nextOpponentTurn' }, 'guard')];
    def(defs, 'potion').mechanics.effects = [binding('cn.lastingPlayer@1', { side: 'own', effect: free, duration: 'thisTurn' }, 'free')];
  });
  const g = board(f, (s) => { water(s, 0); water(s, 1); });
  strike(g); strike(g);
  assert.equal(g.snapshot().players[0].active.counters, 1, '20 - 10.');
  // 'other' protects every Pokémon of its player from the opponent's attacks in their next turn.
  const k = board(f, (s) => {
    const p = s.players[0]; p.hand.push(...p.active.stack); p.active.stack = [hand(s, 0, 'other')]; p.hand.pop(); water(s, 0); water(s, 1);
    bench(s, 0, 'base');
  });
  command(k, { type: 'attack', attackId: 'other:strike' }); settle(k);
  strike(k);
  assert.equal(k.snapshot().players[0].active.counters, 0);
  let card;
  const free0 = board(f, (s) => { card = hand(s, 0, 'potion'); });
  assert(!canAttack(free0, 0), 'No Energy.');
  command(free0, { type: 'playTrainer', cardId: card }); settle(free0);
  assert(canAttack(free0, 0), 'A Water Pokémon\'s attack costs nothing this turn.');
});
