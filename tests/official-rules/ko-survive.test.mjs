// Synthetic definitions only. 「当这只宝可梦的HP为全满的状态下，这只宝可梦受到招式的伤害而昏厥时，这只宝可梦不会昏厥，而是以剩余HP为「10」的状态留在场上」
// 「…受到招式的伤害而【昏厥】时，自己抛掷1次硬币。如果为正面，则…」「在下一个对手的回合，这只宝可梦受到招式的伤害而【昏厥】时，…」 (damage.survive).
// No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { randomIndex } from '../../public/rules/random.js';
import { fixture, binding, board, command, settle, hand, bench } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const def = (defs, id) => defs.find((d) => d.definitionId === id);
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
const survive = (extra) => binding('cn.koSurvive@1', { effect: { op: 'koSurvive', scope: 'self', ...extra } }, `survive-${Object.keys(extra).join('-')}`);
// Player 1's Active is 'other'; player 0's base:strike does 120.
const defended = (f, mutate = () => {}) => board(f, (s) => {
  const p = s.players[1]; p.hand.push(...p.active.stack); p.active.stack = [hand(s, 1, 'other')]; p.hand.pop(); bench(s, 1, 'base');
  water(s, 0); mutate(s);
});
const big = (defs) => {
  for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.weakness = null;
  def(defs, 'base').mechanics.attacks[0].printedDamage = { value: 120, operator: 'fixed' };
};

test('schema', () => {
  const valid = (effect) => createCoreHandlers().get('cn.koSurvive@1').validateParameters({ effect });
  assert(valid({ op: 'koSurvive', scope: 'self', fullHp: true }));
  assert(valid({ op: 'koSurvive', scope: 'self', coin: true }));
  assert(!valid({ op: 'koSurvive', scope: 'own' }));
  assert(createCoreHandlers().get('cn.lasting@1').validateParameters({ side: 'own', target: 'self', effect: { op: 'koSurvive', scope: 'all', fullHp: true },
    duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true }));
});

test('from full HP it stays at 10 HP; already damaged it is Knocked Out', async () => {
  const f = await fixture((defs) => { big(defs); def(defs, 'other').mechanics.effects.push(survive({ fullHp: true })); });
  let g = defended(f);
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  let s = g.snapshot();
  assert.equal(s.players[1].active.stack.map((id) => s.cards[id].definitionId)[0], 'other');
  assert.equal(s.players[1].active.counters, 9, 'Remaining HP 10.');
  assert(s.events.some((e) => e.ruleId === 'damage.survive' && e.data.remainingHp === 10));
  assert.deepEqual(restore(g, f).snapshot(), s);
  g = defended(f, (s) => { s.players[1].active.counters = 1; });
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  s = g.snapshot();
  assert.equal(s.players[1].active.stack.map((id) => s.cards[id].definitionId)[0], 'base', 'Knocked Out; the Benched Pokémon came in.');
});

test('a coin when it would be Knocked Out; nothing to flip for non-lethal damage; a timed effect', async () => {
  const f = await fixture((defs) => { big(defs); def(defs, 'other').mechanics.effects.push(survive({ coin: true })); });
  for (const heads of [true, false]) {
    const g = defended(f, (s) => { s.rng = seedFor([heads]); });
    command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
    const s = g.snapshot();
    assert.equal(s.players[1].active.stack.map((id) => s.cards[id].definitionId)[0], heads ? 'other' : 'base');
    assert.deepEqual(s.events.filter((e) => e.ruleId === 'damage.survive' && e.data.result).map((e) => [e.data.player, e.data.result]), [[1, heads ? 'heads' : 'tails']]);
  }
  const small = await fixture((defs) => { def(defs, 'other').mechanics.effects.push(survive({ coin: true })); });
  const g = defended(small);
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  assert(!g.snapshot().events.some((e) => e.ruleId === 'damage.survive'));
  const timed = await fixture((defs) => {
    big(defs);
    def(defs, 'other').mechanics.attacks[0].effects = [binding('cn.lasting@1', { side: 'own', target: 'self', effect: { op: 'koSurvive', scope: 'all' },
      duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true }, 'brace')];
  });
  const k = board(timed, (s) => {
    const p = s.players[0]; p.hand.push(...p.active.stack); p.active.stack = [hand(s, 0, 'other')]; p.hand.pop(); water(s, 0); water(s, 1);
  });
  command(k, { type: 'attack', attackId: 'other:strike' }); settle(k);
  command(k, { type: 'attack', attackId: 'base:strike' }); settle(k);
  assert.equal(k.snapshot().players[0].active.counters, 9);
});
