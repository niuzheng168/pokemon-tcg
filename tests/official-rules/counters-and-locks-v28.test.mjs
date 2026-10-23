// Synthetic definitions only. 「将与自己弃牌区中的宝可梦张数相同数量的伤害指示物，放置于对手的战斗宝可梦身上」 (a counted number
// of counters), 「选择放置于自己战斗宝可梦身上的最多3个伤害指示物，转放于对手的战斗宝可梦身上」 (from the own Active),
// 「在下一个对手的回合，对手无法从手牌使出并附着「特殊能量」」 and 「在这个回合，自己的…宝可梦所使用的招式的伤害，不计算对手战斗
// 宝可梦身上所附加的效果」. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { OfficialGame } from '../../public/rules/game.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, attached, bench } from './fixtures.mjs';

const handlers = createCoreHandlers();
const clone = (value) => JSON.parse(JSON.stringify(value));
const discarded = { kind: 'zoneCount', side: 'own', zone: 'discard', selector: { kind: 'pokemon' } };
const attack = (id, effects, cost = ['Water']) => ({ attackId: id, name: `测试${id}`, cost, printedDamage: null, effects, sourceOfTruth: EVIDENCE });
const toDiscard = (s, owner, id) => { const m = bench(s, owner, id); s.players[owner].bench.pop(); s.players[owner].discard.push(...m.stack); };

test('countersValue: 「将与自己弃牌区中的宝可梦张数相同数量的伤害指示物」 counts when placed; none at 0', async () => {
  const h = handlers.get('cn.countersValue@1');
  assert(h.validateParameters({ side: 'opponent', target: 'active', count: discarded }));
  assert(!h.validateParameters({ side: 'opponent', target: 'active', count: 3 }));
  assert(!h.validateParameters({ side: 'opponent', target: 'event', count: discarded }));
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'base').mechanics.attacks.push(attack('base:curse', [binding('cn.countersValue@1',
      { side: 'opponent', target: 'active', count: { kind: 'multiply', left: discarded, right: { kind: 'literal', value: 2 } } }, 'curse')]));
  });
  const run = (mutate) => {
    const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); mutate(s); });
    command(g, { type: 'attack', attackId: 'base:curse' }); settle(g);
    return g.snapshot().players[1].active.counters;
  };
  assert.equal(run(() => {}), 0);
  assert.equal(run((s) => { toDiscard(s, 0, 'other'); toDiscard(s, 0, 'base'); toDiscard(s, 1, 'other'); }), 4, '2 Pokémon × 2.');
  // Paused at the target choice, the opened program is the resolution-time receipt: one placement on the approved target.
  const any = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'base').mechanics.attacks.push(attack('base:curse', [binding('cn.countersValue@1',
      { side: 'opponent', target: 'any', count: discarded }, 'curse')]));
  });
  const g = board(any, (s) => { attached(s, 0, s.players[0].active, 'water'); toDiscard(s, 0, 'other'); bench(s, 1, 'other'); });
  command(g, { type: 'attack', attackId: 'base:curse' });
  const mid = g.snapshot();
  assert.equal(mid.pending.kind, 'effect-target');
  const forge = (edit) => {
    const s = clone(mid), e = s.events.findLast((e) => e.ruleId === 'effects.execution' && Array.isArray(e.data.program));
    edit(e.data.program);
    return () => OfficialGame.restore(s, { catalog: any.catalog });
  };
  OfficialGame.restore(clone(mid), { catalog: any.catalog });
  // An Item is playable only when the count is positive.
  const item = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.countersValue@1', { side: 'opponent', target: 'active', count: discarded }, 'item')];
  });
  let card;
  const none = board(item, (s) => { card = hand(s, 0, 'potion'); });
  assert(!none.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card));
  const some = board(item, (s) => { card = hand(s, 0, 'potion'); toDiscard(s, 0, 'other'); });
  command(some, { type: 'playTrainer', cardId: card }); settle(some);
  assert.equal(some.snapshot().players[1].active.counters, 1);
  for (const edit of [(p) => { p[0].count = 0; }, (p) => { p[0].target = 'bench'; }, (p) => { p.push(p[0]); }, (p) => { p[0].targets = 2; }])
    assert.throws(forge(edit), /computed counter placement/);
});

test('transferCounters from: 「自己战斗宝可梦身上的」 counters only', async () => {
  assert(handlers.get('cn.transferCounters@1').validateParameters({ count: 3, from: 'active', side: 'opponent', target: 'active', quantity: 'upTo' }));
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.transferCounters@1',
      { count: 3, from: 'active', side: 'opponent', target: 'active', quantity: 'upTo' }, 'move')];
  });
  let card;
  const benchOnly = board(f, (s) => { card = hand(s, 0, 'potion'); bench(s, 0, 'other').counters = 5; });
  assert(!benchOnly.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card), 'Only the Active\'s counters.');
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); s.players[0].active.counters = 5; bench(s, 0, 'other').counters = 5; });
  command(g, { type: 'playTrainer', cardId: card });
  assert.deepEqual(g.snapshot().pending.options, [g.snapshot().players[0].active.id]);
  answer(g, g.snapshot().pending.options); answer(g, ['3']); settle(g);
  assert.deepEqual([g.snapshot().players[0].active.counters, g.snapshot().players[1].active.counters], [2, 3]);
});

test('「在下一个对手的回合，对手无法从手牌使出并附着「特殊能量」」 blocks only Special Energy from hand', async () => {
  const lock = { side: 'opponent', duration: 'nextOpponentTurn', effect: { op: 'playerRestriction', scope: 'all', actions: ['attachSpecialEnergy', 'playStadium'] } };
  assert(handlers.get('cn.lastingPlayer@1').validateParameters(lock));
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'base').mechanics.attacks.push(attack('base:seal', [binding('cn.lastingPlayer@1', lock, 'seal')]));
  });
  let special, basic;
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); special = hand(s, 1, 'double'); basic = hand(s, 1, 'water'); });
  command(g, { type: 'attack', attackId: 'base:seal' }); settle(g);
  const attachable = g.view(1).legalActions.filter((a) => a.type === 'attachEnergy').map((a) => a.cardId);
  assert(attachable.includes(basic)); assert(!attachable.includes(special));
});

test('「在这个回合，自己的【水】宝可梦所使用的招式的伤害，不计算对手战斗宝可梦身上所附加的效果」', async () => {
  const pierce = { side: 'own', duration: 'thisTurn', effect: { op: 'attackDamageOptions', scope: 'own', ignoreDefenderEffects: true,
    targetSelector: { kind: 'pokemon', types: ['Water'] } } };
  const lasting = handlers.get('cn.lastingPlayer@1');
  assert(lasting.validateParameters(pierce));
  assert(!lasting.validateParameters({ ...pierce, side: 'opponent' }));
  assert(!lasting.validateParameters({ ...pierce, effect: { ...pierce.effect, scope: 'self' } }));
  const f = await fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.weakness = null;
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.lastingPlayer@1', pierce, 'pierce')];
  });
  const run = (play) => {
    let card;
    const g = board(f, (s) => {
      attached(s, 0, s.players[0].active, 'water'); card = hand(s, 0, 'potion');
      const stadium = s.players[1].deck.findIndex((id) => s.cards[id].definitionId === 'stadium');
      s.stadium = s.players[1].deck.splice(stadium, 1)[0];
    });
    if (play) { command(g, { type: 'playTrainer', cardId: card }); settle(g); }
    command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
    return g.snapshot().players[1].active.counters * 10;
  };
  assert.equal(run(false), 0, 'The Stadium\'s 「-20」 applies.');
  assert.equal(run(true), 20);
});
