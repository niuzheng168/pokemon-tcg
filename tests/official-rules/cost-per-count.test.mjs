// Synthetic definitions only. 「这只宝可梦使用招式所需能量会减少与自己弃牌区中的「X」张数／对手备战宝可梦数量相同数量的【无】能量」:
// the cost reduction is amount × the count when the cost is checked. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, EVIDENCE, board, bench } from './fixtures.mjs';

const requirement = (perCount) => ({ effect: { op: 'energyRequirement', action: 'attack', mode: 'adjust', scope: 'self',
  energyType: 'Colorless', amount: -1, perCount } });
const valid = (p) => createCoreHandlers().get('cn.energyRequirement@1').validateParameters(p);

test('perCount: in-play Pokémon, or zone cards filtered only in a public zone; never with perPrizesTaken', () => {
  assert(valid(requirement({ kind: 'pokemonCount', side: 'opponent', zone: 'bench' })));
  assert(valid(requirement({ kind: 'zoneCount', side: 'own', zone: 'discard', selector: { kind: 'pokemon', nameKeys: ['other'] } })));
  assert(valid(requirement({ kind: 'zoneCount', side: 'opponent', zone: 'hand' })));
  assert(!valid(requirement({ kind: 'zoneCount', side: 'own', zone: 'hand', selector: { kind: 'pokemon' } })));
  assert(!valid(requirement({ kind: 'literal', value: 2 })));
  assert(!valid({ effect: { ...requirement({ kind: 'pokemonCount', side: 'opponent', zone: 'bench' }).effect, perPrizesTaken: 'opponent' } }));
  assert(!valid({ effect: { op: 'energyRequirement', action: 'retreat', mode: 'erase', scope: 'self',
    perCount: { kind: 'pokemonCount', side: 'opponent', zone: 'bench' } } }));
});

test('「…减少与对手备战宝可梦数量／自己弃牌区中的「测试宝可梦other」张数相同数量的【无】能量」', async () => {
  const make = (perCount) => fixture((defs) => {
    const d = defs.find((d) => d.definitionId === 'base');
    d.mechanics.attacks[0].cost = ['Water', 'Colorless', 'Colorless', 'Colorless'];
    d.mechanics.abilities = [{ abilityId: 'fixture:cheap', name: '测试减费', mode: 'continuous', usage: null, sourceOfTruth: EVIDENCE,
      effects: [binding('cn.energyRequirement@1', requirement(perCount))] }];
  });
  const total = (g) => g.view(0).players[0].active.effective.attackRequirements[0].routes.map((r) => r.total);
  const benched = await make({ kind: 'pokemonCount', side: 'opponent', zone: 'bench' });
  assert.deepEqual(total(board(benched)), [4]);
  assert.deepEqual(total(board(benched, (s) => { bench(s, 1, 'other'); bench(s, 1, 'other'); bench(s, 0, 'other'); })), [2]);
  const discarded = await make({ kind: 'zoneCount', side: 'own', zone: 'discard', selector: { kind: 'pokemon', nameKeys: ['other'] } });
  const discard = (s, owner, id) => { const m = bench(s, owner, id); s.players[owner].bench.pop(); s.players[owner].discard.push(...m.stack); };
  assert.deepEqual(total(board(discarded, (s) => { discard(s, 0, 'other'); discard(s, 0, 'base'); discard(s, 1, 'other'); })), [3]);
  assert.deepEqual(total(board(benched, (s) => { bench(s, 1, 'other'); bench(s, 1, 'other'); bench(s, 1, 'base'); bench(s, 1, 'evolution'); })),
    [1], 'Only the printed Colorless can be removed.');
});
