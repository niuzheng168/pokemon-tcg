// Synthetic definitions only. 「将这只宝可梦身上放置的全部伤害指示物，转放于对手的战斗宝可梦身上」, 「选择自己的1只（「古代」）备战宝可梦，
// 将被选择的宝可梦身上放置的所有伤害指示物，转放于…」 and 「将自己所有宝可梦身上放置的全部伤害指示物，转放于…」. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, EVIDENCE, board, command, settle, attached, bench } from './fixtures.mjs';

const move = (extra) => ({ side: 'opponent', target: 'active', quantity: 'all', ...extra });

test('transferCounters quantity all: schema', () => {
  const valid = (p) => createCoreHandlers().get('cn.transferCounters@1').validateParameters(p);
  assert(valid(move({ from: 'self' }))); assert(valid(move({ from: 'every' })));
  assert(valid(move({ from: 'bench', originSelector: { kind: 'pokemon', tagsAll: ['Ancient'] } })));
  assert(!valid(move({ from: 'self', count: 3 })), 'All counters: no count.');
  assert(!valid({ from: 'self', side: 'opponent', target: 'active' }), 'A count, or all.');
  assert(!valid(move({ from: 'every', quantity: 'upTo', count: 2 })));
});

test('all counters from this Pokémon, from a chosen Benched Pokémon, or from every own Pokémon', async () => {
  const run = async (parameters, counters) => {
    const f = await fixture((defs) => {
      defs.find((d) => d.definitionId === 'base').mechanics.attacks.push({ attackId: 'base:pass', name: '测试转移', cost: ['Water'],
        printedDamage: null, effects: [binding('cn.transferCounters@1', parameters, 'pass')], sourceOfTruth: EVIDENCE });
    });
    const g = board(f, (s) => {
      attached(s, 0, s.players[0].active, 'water'); s.players[0].active.counters = counters[0];
      for (const c of counters.slice(1)) bench(s, 0, 'other').counters = c;
    });
    command(g, { type: 'attack', attackId: 'base:pass' }); settle(g);
    const p = g.snapshot().players;
    return { own: [p[0].active, ...p[0].bench].map((m) => m.counters), opponent: p[1].active.counters };
  };
  assert.deepEqual(await run(move({ from: 'self' }), [4, 2]), { own: [0, 2], opponent: 4 });
  assert.deepEqual(await run(move({ from: 'bench' }), [4, 3]), { own: [4, 0], opponent: 3 });
  assert.deepEqual(await run(move({ from: 'every' }), [4, 3, 1]), { own: [0, 0, 0], opponent: 8 });
  assert.deepEqual(await run(move({ from: 'every' }), [0, 0]), { own: [0, 0], opponent: 0 });
  assert.deepEqual(await run(move({ from: 'bench', originSelector: { kind: 'pokemon', nameKeys: ['base'] } }), [4, 3]),
    { own: [4, 3], opponent: 0 }, 'No Benched 「测试宝可梦base」.');
});
