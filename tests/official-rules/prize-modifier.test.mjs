// Synthetic definitions only. 「如果因为这个招式的伤害，对手的宝可梦【昏厥】的话，则多拿取1张奖赏卡」, 「当该宝可梦，受到对手宝可梦的招式的
// 伤害而【昏厥】时，对手拿取的奖赏卡将减少1张」, 「即使这只宝可梦【昏厥】，对手也无法拿取奖赏卡」 and 「在这个回合，如果因为自己…宝可梦所使用的
// 招式的伤害，而导致对手战斗宝可梦【昏厥】了的话，则多拿取1张奖赏卡」 (ko.prize-modifier). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, EVIDENCE, board, start, command, settle, attached, bench, hand } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const handlers = createCoreHandlers();
const reduce = (extra = {}) => ({ effect: { op: 'prizeModifier', scope: 'self', amount: -1, byOpponentAttack: true, ...extra } });

async function make({ attack = [binding('cn.extraPrizes@1', { count: 1 }, 'extra')], tool, item, damage = 100 } = {}) {
  return fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.weakness = null;
    defs.find((d) => d.definitionId === 'base').mechanics.attacks.push({ attackId: 'base:bite', name: '测试咬碎', cost: ['Water'],
      printedDamage: damage === null ? null : { value: damage, operator: 'fixed' }, effects: attack, sourceOfTruth: EVIDENCE });
    if (tool) defs.find((d) => d.definitionId === 'tool').mechanics.effects = [binding('cn.prizeModifier@1', tool, 'prize')];
    if (item) defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.lastingPlayer@1', item, 'briar')];
  });
}
function knockOut(f, mutate = () => {}) {
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); bench(s, 1, 'other'); mutate(s); });
  command(g, { type: 'attack', attackId: 'base:bite' });
  return g;
}
const taken = (g) => { settle(g); return 6 - g.snapshot().players[0].prizes.length; };

test('prize modifiers: schemas and placement', async () => {
  assert(handlers.get('cn.extraPrizes@1').validateParameters({ count: 2, activeOnly: true, targetSelector: { kind: 'pokemon', stages: ['basic'] } }));
  for (const bad of [{ count: 0 }, { count: 1, side: 'own' }, {}]) assert(!handlers.get('cn.extraPrizes@1').validateParameters(bad));
  const valid = (p) => handlers.get('cn.prizeModifier@1').validateParameters(clone(p));
  assert(valid(reduce())); assert(valid({ effect: { op: 'prizeModifier', scope: 'self', none: true } }));
  assert(valid(reduce({ attackerSelector: { kind: 'pokemon', tagsAll: ['V'] } })));
  for (const bad of [reduce({ amount: 0 }), reduce({ none: true }), { effect: { op: 'prizeModifier', scope: 'self' } },
    { effect: { op: 'prizeModifier', scope: 'self', amount: 1, attackerSelector: { kind: 'pokemon' } } }])
    assert(!valid(bad), JSON.stringify(bad));
  const lasting = (effect) => handlers.get('cn.lastingPlayer@1').validateParameters({ side: 'own', effect, duration: 'thisTurn' });
  assert(lasting({ op: 'prizeBonus', count: 1, activeOnly: true }));
  assert(!lasting({ op: 'prizeBonus', count: 1, attack: { instanceId: 'c1', pokemonId: 'm1', attackId: 'a', copyId: null } }));
  assert(!handlers.get('cn.lastingPlayer@1').validateParameters({ side: 'opponent', effect: { op: 'prizeBonus', count: 1 }, duration: 'thisTurn' }));
  const trainer = await fixture((defs) => { defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.extraPrizes@1', { count: 1 })]; });
  assert.throws(() => start(trainer), /Unimplemented or undeclared/);
});

test('「多拿取1张奖赏卡」 only for this attack\'s damage, and the printed kind of the Knocked Out Pokémon', async () => {
  const g = knockOut(await make());
  assert.deepEqual(OfficialGame.restore(clone(g.snapshot()), { catalog: (await make()).catalog }).snapshot().playerOngoing.length, 1);
  assert.equal(taken(g), 2);
  assert(g.snapshot().events.some((e) => e.ruleId === 'ko.boundary' && e.data.prizes === 2));
  const basicOnly = await make({ attack: [binding('cn.extraPrizes@1', { count: 1, targetSelector: { kind: 'pokemon', stages: ['stage1'] } })] });
  assert.equal(taken(knockOut(basicOnly)), 1, 'The Knocked Out Pokémon is a Basic Pokémon.');
  const counters = [binding('cn.counters@1', { side: 'opponent', target: 'active', count: 10 }), binding('cn.extraPrizes@1', { count: 2 }, 'extra')];
  assert.equal(taken(knockOut(await make({ attack: counters }))), 3, 'Its damage came first and Knocked it Out.');
  // ブライア×ドラパルトex「ファントムダイブ」: counters placed by an effect are not the attack's damage.
  const g2 = knockOut(await make({ attack: counters, damage: null }));
  assert.equal(taken(g2), 1);
  assert.equal(g2.snapshot().playerOngoing.length, 0, 'The bonus ended with the turn.');
});

test('decreases add up with increases; 「无法拿取奖赏卡」 takes none at all', async () => {
  const withTool = (spec) => make({ tool: spec });
  const equip = (s) => { const id = hand(s, 1, 'tool'); s.players[1].hand.pop(); s.players[1].active.tools.push(id); };
  assert.equal(taken(knockOut(await withTool(reduce()), equip)), 1, '1 + 1 − 1.');
  assert.equal(taken(knockOut(await withTool({ effect: { op: 'prizeModifier', scope: 'self', none: true } }), equip)), 0);
  const plain = await make({ attack: [], tool: reduce({ amount: -2 }) });
  assert.equal(taken(knockOut(plain, equip)), 0, 'Never below zero.');
  const vOnly = await make({ attack: [], tool: reduce({ attackerSelector: { kind: 'pokemon', tagsAll: ['V'] } }) });
  assert.equal(taken(knockOut(vOnly, equip)), 1, 'The attacker is not a 「宝可梦V」.');
});

test('a turn-long bonus of a played card, for the opponent\'s Active Pokémon only', async () => {
  const f = await make({ attack: [], item: { side: 'own', effect: { op: 'prizeBonus', count: 1, activeOnly: true }, duration: 'thisTurn' } });
  let card;
  const g = knockOut(f, (s) => { card = hand(s, 0, 'potion'); });
  settle(g);
  assert.equal(taken(g), 1, 'The attack came before the card was played.');
  const h = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); bench(s, 1, 'other'); card = hand(s, 0, 'potion'); });
  command(h, { type: 'playTrainer', cardId: card }); settle(h);
  command(h, { type: 'attack', attackId: 'base:bite' });
  assert.equal(taken(h), 2);
});

test('one attack\'s bonus for two Pokémon Knocked Out at once is not guessed', async () => {
  const f = await make({ attack: [binding('cn.damage@1', { side: 'opponent', target: 'bench', amount: 100, selection: { kind: 'all' }, options: {} }),
    binding('cn.extraPrizes@1', { count: 1 }, 'extra')] });
  assert.throws(() => knockOut(f), (e) => e.code === 'unresolved-prize-bonus');
  const active = await make({ attack: [binding('cn.damage@1', { side: 'opponent', target: 'bench', amount: 100, selection: { kind: 'all' }, options: {} }),
    binding('cn.extraPrizes@1', { count: 1, activeOnly: true }, 'extra')] });
  const h = knockOut(active, (s) => bench(s, 1, 'other'));
  assert.equal(taken(h), 4, 'Three Knocked Out, the bonus for the Active Pokémon only.');
});

test('lasting: 「在下一个对手的回合，即使这只宝可梦【昏厥】，对手也无法拿取奖赏卡」', async () => {
  const shield = { side: 'own', target: 'self', effect: { op: 'prizeModifier', scope: 'all', none: true }, duration: 'nextOpponentTurn',
    clearOnBench: true, clearOnEvolution: false };
  assert(handlers.get('cn.lasting@1').validateParameters(clone(shield)));
  const f = await make({ attack: [binding('cn.lasting@1', shield, 'shield')], damage: null });
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water'); bench(s, 0, 'other'); attached(s, 1, s.players[1].active, 'water');
    s.players[0].active.counters = 9;
  });
  command(g, { type: 'attack', attackId: 'base:bite' }); settle(g);
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  const s = g.snapshot();
  assert.equal(s.players[1].prizes.length, 6, 'Knocked Out, but no Prize card is taken.');
  assert(s.players[0].discard.some((id) => s.cards[id].definitionId === 'base'));
});
