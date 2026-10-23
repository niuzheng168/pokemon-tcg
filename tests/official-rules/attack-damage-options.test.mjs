// Synthetic definitions only. 「这只宝可梦所使用的招式的伤害，不计算对手战斗宝可梦身上所附加的效果」: as if cn.damageOptions@1
// ignoreDefenderEffects were printed on each of the affected Pokémon's attacks (damage step 5, I p7). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, EVIDENCE, board, command, settle, attached, bench } from './fixtures.mjs';

const options = (extra = {}) => ({ effect: { op: 'attackDamageOptions', scope: 'self', ignoreDefenderEffects: true, ...extra } });

test('「这只宝可梦所使用的招式的伤害，不计算对手战斗宝可梦身上所附加的效果」 ignores the defender\'s Stadium reduction', async () => {
  const h = createCoreHandlers().get('cn.attackDamageOptions@1');
  assert(h.validateParameters(options({ targetSelector: { kind: 'pokemon', types: ['Water'] } })));
  assert(!h.validateParameters(options({ scope: 'opponent' })));
  assert(!h.validateParameters({ effect: { op: 'attackDamageOptions', scope: 'self' } }));
  const f = await fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.weakness = null;
    defs.find((d) => d.definitionId === 'other').mechanics.abilities = [{ abilityId: 'other:pierce', name: '测试贯穿', mode: 'continuous',
      usage: null, sourceOfTruth: EVIDENCE, effects: [binding('cn.attackDamageOptions@1', options(), 'pierce')] }];
  });
  const run = (withAbility) => {
    const g = board(f, (s) => {
      if (withAbility) { const p = s.players[0], m = bench(s, 0, 'other'); p.bench.pop(); p.bench.push(p.active); p.active = m; }
      attached(s, 0, s.players[0].active, 'water');
      const stadium = s.players[1].deck.findIndex((id) => s.cards[id].definitionId === 'stadium');
      s.stadium = s.players[1].deck.splice(stadium, 1)[0];
    });
    command(g, { type: 'attack', attackId: `${withAbility ? 'other' : 'base'}:strike` }); settle(g);
    return g.snapshot().players[1].active.counters * 10;
  };
  assert.equal(run(false), 0, 'The Stadium\'s 「-20」 applies.');
  assert.equal(run(true), 20);
});
