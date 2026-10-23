// Synthetic definitions only. 「使对手的战斗宝可梦陷入【睡眠】状态。因这个【睡眠】而抛掷的硬币次数变为2次，只要不是全为正面就不会恢复」
// 「…陷入【混乱】状态。因这个【混乱】而放置的伤害指示物数量变为6个」「对手的战斗宝可梦，因【中毒】而放置的伤害指示物数量增加2个」
// 「对手处于【灼伤】状态的宝可梦，在宝可梦检查时抛掷的硬币即使为正面，其【灼伤】状态也不会恢复」「双方处于特殊状态的宝可梦，其所处于的特殊状态不会因为
// 进化、退化而恢复」 (status.rules). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { applyCondition, checkConditions, cureConditions, emptyConditions, resolveConfusion, validateConditions } from '../../public/rules/conditions.js';
import { randomIndex } from '../../public/rules/random.js';
import { fixture, binding, board, command, settle, hand } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();
const seedFor = (coins) => {
  for (let i = 1; i <= 8192; i++) {
    const seed = [Math.imul(i, 8000009) >>> 0, Math.imul(i, 333333331) >>> 0, Math.imul(i, 17) >>> 0, Math.imul(i, 37) >>> 0], rng = [...seed];
    if (coins.every((heads) => (randomIndex(rng, 2) === 0) === heads)) return seed;
  }
  throw new Error('No fixture seed.');
};
const water = (s, owner) => {
  const p = s.players[owner], i = p.deck.findIndex((id) => s.cards[id].definitionId === 'water');
  p.active.energy.push(p.deck.splice(i, 1)[0]);
};
const rule = (effect) => binding('cn.conditionRule@1', { effect: { op: 'conditionRule', ...effect } }, `rule-${Object.keys(effect).join('-')}`);
const base = { poisonExtra: 0, burnExtra: 0, burnRecovers: true, sleepCoins: 1 };

test('the condition record and the checkup arithmetic', () => {
  let c = applyCondition(emptyConditions(), 'asleep', { ownerTurn: 1, sleepCoins: 2 }).conditions;
  assert.equal(c.sleepCoins, 2);
  assert.equal(applyCondition(c, 'confused', { ownerTurn: 1 }).conditions.sleepCoins, undefined, 'A new rotation condition replaces it.');
  assert.equal(cureConditions(c, ['asleep']).sleepCoins, undefined);
  assert.throws(() => applyCondition(emptyConditions(), 'poisoned', { sleepCoins: 2 }));
  assert.throws(() => applyCondition(emptyConditions(), 'asleep', { sleepCoins: 1 }));
  for (const bad of [{ ...emptyConditions(), sleepCoins: 2 }, { ...emptyConditions(), rotation: 'asleep', confusionCounters: 6 }])
    assert.throws(() => validateConditions(bad));
  const flips = (results) => { const queue = [...results]; return () => queue.shift(); };
  let r = checkConditions(c, { ownerTurn: 1, ownerIsEndingPlayer: true, flip: flips([true, false]), rules: base });
  assert.equal(r.conditions.rotation, 'asleep', 'Not all heads.');
  r = checkConditions(c, { ownerTurn: 1, ownerIsEndingPlayer: true, flip: flips([true, true]), rules: base });
  assert.equal(r.conditions.rotation, null); assert.equal(r.conditions.sleepCoins, undefined);
  r = checkConditions(applyCondition(emptyConditions(), 'asleep').conditions, { ownerTurn: 1, ownerIsEndingPlayer: true, flip: flips([true, false]),
    rules: { ...base, sleepCoins: 2 } });
  assert.equal(r.conditions.rotation, 'asleep', 'A continuous rule asks for two coins.');
  c = { ...applyCondition(emptyConditions(), 'poisoned', { poisonCounters: 3 }).conditions, burned: true };
  r = checkConditions(c, { ownerTurn: 1, ownerIsEndingPlayer: true, flip: () => true, burnCounterChanges: [4],
    rules: { ...base, poisonExtra: 2, burnExtra: 3, burnRecovers: false } });
  assert.equal(r.counters, 3 + 2 + 4 + 3, 'Special poison 3 + 2; Burn 「变为4个」 + 3.');
  assert.equal(r.conditions.burned, true, 'Heads, but it does not recover.');
  assert.throws(() => checkConditions(c, { ownerTurn: 1, ownerIsEndingPlayer: true, flip: () => true, rules: { ...base, sleepCoins: 0 } }));
  const confused = applyCondition(emptyConditions(), 'confused', { ownerTurn: 1, confusionCounters: 6 }).conditions;
  assert.equal(resolveConfusion(confused, false).selfCounters, 6);
  const valid = (p) => handlers.get('cn.conditionRule@1').validateParameters({ effect: { op: 'conditionRule', ...p } });
  for (const p of [{ scope: 'opponent', status: 'poisoned', addCounters: 2, activeOnly: true }, { scope: 'all', status: 'asleep', coins: 2 },
    { scope: 'opponent', status: 'burned', noRecovery: true }, { scope: 'all', keepOnEvolution: ['poisoned'] }]) assert(valid(p), JSON.stringify(p));
  for (const p of [{ scope: 'all', status: 'asleep', addCounters: 2 }, { scope: 'all', status: 'poisoned', coins: 2 },
    { scope: 'all', status: 'burned', noRecovery: true, addCounters: 1 }, { scope: 'all', status: 'poisoned', keepOnEvolution: ['poisoned'] }, { scope: 'all' }])
    assert(!valid(p), JSON.stringify(p));
  const condition = (p) => handlers.get('cn.condition@1').validateParameters(p);
  assert(condition({ side: 'opponent', condition: 'asleep', sleepCoins: 2 }));
  assert(condition({ side: 'opponent', condition: 'confused', confusionCounters: 6 }));
  assert(!condition({ side: 'opponent', condition: 'confused', sleepCoins: 2 }));
  assert(!condition({ side: 'opponent', condition: 'asleep', confusionCounters: 6 }));
});

test('「因这个【睡眠】而抛掷的硬币次数变为2次」 and 「因这个【混乱】而放置的伤害指示物数量变为6个」 in play', async () => {
  const f = await fixture((defs) => {
    def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.condition@1', { side: 'opponent', condition: 'asleep', sleepCoins: 2 }, 'nap')];
    def(defs, 'other').mechanics.attacks[0].effects = [binding('cn.condition@1', { side: 'opponent', condition: 'confused', confusionCounters: 6 }, 'daze')];
  });
  for (const [coins, asleep] of [[[true, false], true], [[true, true], false]]) {
    const g = board(f, (s) => { water(s, 0); });
    command(g, { type: 'attack', attackId: 'base:strike' });
    const mid = g.snapshot(); mid.rng = seedFor(coins);
    const h = OfficialGame.restore(mid, { catalog: f.catalog }); settle(h);
    const s = h.snapshot();
    assert.equal(s.players[1].active.conditions.rotation === 'asleep', asleep, JSON.stringify(coins));
    assert.deepEqual(restore(h, f).snapshot(), s);
  }
  const g = board(f, (s) => {
    const p = s.players[0]; p.hand.push(...p.active.stack); p.active.stack = [hand(s, 0, 'other')]; p.hand.pop(); water(s, 0); water(s, 1);
  });
  command(g, { type: 'attack', attackId: 'other:strike' }); settle(g);
  assert.equal(g.snapshot().players[1].active.conditions.confusionCounters, 6);
  const mid = g.snapshot(); mid.rng = seedFor([false]);
  const h = OfficialGame.restore(mid, { catalog: f.catalog });
  const before = h.snapshot().players[1].active.counters;
  command(h, { type: 'attack', attackId: 'base:strike' }); settle(h);
  assert.equal(h.snapshot().players[1].active.counters - before, 6, 'Tails: six counters on itself.');
});

test('continuous rules: more Poison counters, a Burn that stays, two Sleep coins, conditions kept through evolution', async () => {
  const f = await fixture((defs) => {
    def(defs, 'base').mechanics.effects.push(rule({ scope: 'opponent', status: 'poisoned', addCounters: 2 }),
      rule({ scope: 'opponent', status: 'burned', noRecovery: true }));
    def(defs, 'stadium').mechanics.effects = [rule({ scope: 'all', keepOnEvolution: ['asleep', 'paralyzed', 'confused', 'poisoned', 'burned'] }),
      rule({ scope: 'all', status: 'asleep', coins: 2 })];
  });
  const g = board(f, (s) => { const c = s.players[1].active.conditions; c.poison = 1; c.burned = true; s.rng = seedFor([true]); });
  command(g, { type: 'endTurn' }); settle(g);
  let s = g.snapshot();
  assert.equal(s.players[1].active.counters, 1 + 2 + 2, 'Poison 1 + 2, Burn 2.');
  assert.equal(s.players[1].active.conditions.burned, true);
  let card;
  const k = board(f, (s) => {
    const id = hand(s, 0, 'stadium'); s.players[0].hand.pop(); s.stadium = id;
    s.players[0].active.conditions = { ...s.players[0].active.conditions, poison: 1, rotation: 'asleep' };
    card = hand(s, 0, 'evolution');
  });
  command(k, { type: 'evolve', cardId: card, pokemonId: k.snapshot().players[0].active.id }); settle(k);
  s = k.snapshot();
  assert.deepEqual([s.players[0].active.conditions.poison, s.players[0].active.conditions.rotation], [1, 'asleep'], 'Kept.');
  const mid = clone(s); mid.rng = seedFor([true, false]);
  const m = OfficialGame.restore(mid, { catalog: f.catalog });
  command(m, { type: 'endTurn' }); settle(m);
  assert.equal(m.snapshot().players[0].active.conditions.rotation, 'asleep', 'Two Sleep coins, not both heads.');
  const plain = await fixture();
  const n = board(plain, (s) => { s.players[0].active.conditions.poison = 1; card = hand(s, 0, 'evolution'); });
  command(n, { type: 'evolve', cardId: card, pokemonId: n.snapshot().players[0].active.id }); settle(n);
  assert.equal(n.snapshot().players[0].active.conditions.poison, null, 'Ordinarily evolution recovers it.');
});
