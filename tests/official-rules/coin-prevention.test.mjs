// Synthetic definitions only. 「当这只宝可梦受到招式的伤害时，自己抛掷1次硬币。如果为正面，则这只宝可梦不受到该伤害」 and the attack
// 「在下一个对手的回合，这只宝可梦受到招式的伤害时，自己抛掷1次硬币。如果为正面，则这只宝可梦不受到该伤害影响」 (damage.prevention-coin,
// I.A-01 步骤6). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { randomIndex } from '../../public/rules/random.js';
import { fixture, binding, board, command, settle, bench } from './fixtures.mjs';

const restore = (g, f) => OfficialGame.restore(JSON.parse(JSON.stringify(g.snapshot())), { catalog: f.catalog });
const handlers = createCoreHandlers();
const coin = (extra = {}) => ({ op: 'protection', useRule: 'ordinary', channel: 'damage', scope: 'self', from: 'all', categories: ['attack'], coin: true, ...extra });
const seedFor = (coins) => {
  for (let i = 1; i <= 8192; i++) {
    const seed = [Math.imul(i, 8000009) >>> 0, Math.imul(i, 333333331) >>> 0, Math.imul(i, 17) >>> 0, Math.imul(i, 37) >>> 0], rng = [...seed];
    if (coins.every((heads) => (randomIndex(rng, 2) === 0) === heads)) return seed;
  }
  throw new Error('No fixture seed.');
};
const consumed = (seed, count) => { const rng = [...seed]; for (let i = 0; i < count; i++) randomIndex(rng, 2); return rng; };
// Player 1's Active Pokémon is 'other'; player 0 attacks it with base:strike (20, no Weakness).
const defended = (f, coins, mutate = () => {}) => board(f, (s) => {
  const p = s.players[1]; p.hand.push(...p.active.stack); p.active = bench(s, 1, 'other'); p.bench.pop();
  s.players[0].active.energy.push(s.players[0].deck.splice(s.players[0].deck.findIndex((id) => s.cards[id].definitionId === 'water'), 1)[0]);
  mutate(s); s.rng = seedFor(coins);
});
const flips = (s) => s.events.filter((e) => e.ruleId === 'damage.prevention-coin');

test('schema: a coin protection is attack damage only', () => {
  const valid = (effect) => handlers.get('cn.protection@1').validateParameters({ effect });
  assert(valid(coin()));
  assert(valid(coin({ from: 'opponent', condition: { kind: 'pokemonIs', who: 'self', state: { conditions: ['confused'] } } })));
  assert(!valid(coin({ channel: 'effects' })));
  assert(!valid(coin({ categories: ['attack', 'ability'] })));
  assert(handlers.get('cn.lasting@1').validateParameters({ side: 'own', target: 'self', effect: coin({ scope: 'all', from: 'opponent' }),
    duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true }));
});

test('heads prevents the damage, tails does not; one flip per damage that reaches 6.最终伤害', async () => {
  const f = await fixture((defs) => { defs[1].mechanics.effects.push(binding('cn.protection@1', { effect: coin() }, 'dodge')); });
  for (const heads of [true, false]) {
    const g = defended(f, [heads]), seed = g.snapshot().rng;
    command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
    const s = g.snapshot();
    assert.equal(s.players[1].active.counters, heads ? 0 : 2);
    assert.deepEqual(flips(s).map((e) => [e.data.player, e.data.result]), [[1, heads ? 'heads' : 'tails']], 'Its own player flips.');
    assert.deepEqual(s.rng, consumed(seed, 1));
    assert.deepEqual(restore(g, f).snapshot(), s);
  }
});

test('no flip when the damage already stopped at 0; a flip that cannot prevent an attack ignoring the defender\'s effects', async () => {
  const f = await fixture((defs) => {
    defs[1].mechanics.effects.push(binding('cn.protection@1', { effect: coin() }, 'dodge'),
      binding('cn.modifier@1', { field: 'defenseDamage', amount: -30, scope: 'self' }, 'guard'));
  });
  let g = defended(f, [true]);
  const seed = g.snapshot().rng;
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  assert.equal(flips(g.snapshot()).length, 0);
  assert.deepEqual(g.snapshot().rng, seed);
  const h = await fixture((defs) => {
    defs[1].mechanics.effects.push(binding('cn.protection@1', { effect: coin() }, 'dodge'));
    defs[0].mechanics.attacks[0].effects = [binding('cn.damageOptions@1', { ignoreDefenderEffects: true }, 'pierce')];
  });
  g = defended(h, [true]);
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  const s = g.snapshot();
  assert.deepEqual(flips(s).map((e) => e.data.result), ['heads']);
  assert.equal(s.players[1].active.counters, 2, 'Heads, but the attack ignores it.');
});

test('「在下一个对手的回合，这只宝可梦受到招式的伤害时，自己抛掷1次硬币…」', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.attacks[0].effects = [binding('cn.lasting@1', { side: 'own', target: 'self',
      effect: coin({ scope: 'all', from: 'opponent' }), duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true }, 'blur')];
  });
  const g = board(f, (s) => {
    for (const owner of [0, 1]) s.players[owner].active.energy.push(s.players[owner].deck.splice(
      s.players[owner].deck.findIndex((id) => s.cards[id].definitionId === 'water'), 1)[0]);
  });
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  const mid = g.snapshot();
  assert.equal(mid.current, 1);
  mid.rng = seedFor([true]);
  const k = OfficialGame.restore(mid, { catalog: f.catalog });
  command(k, { type: 'attack', attackId: 'base:strike' }); settle(k);
  const s = k.snapshot();
  assert.deepEqual(flips(s).map((e) => [e.data.player, e.data.result]), [[0, 'heads']]);
  assert.equal(s.players[0].active.counters, 0);
});
