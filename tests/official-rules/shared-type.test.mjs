// Synthetic definitions only. 「如果自己场上，有与对手场上宝可梦相同属性的宝可梦的话」 / 「如果双方的战斗宝可梦为相同属性的话」 (属性相同
// as in the Weakness step, I p7: some current type in common), and 「【基础】宝可梦（除【无】宝可梦外）」 (excludeTypes).
// No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { matchesCardSelector } from '../../public/rules/card-selection.js';
import { validateCardSelector } from '../../public/rules/schema-validators.js';
import { fixture, binding, EVIDENCE, board, command, settle, attached, bench } from './fixtures.mjs';

const lit = (value) => ({ kind: 'literal', value });
const shared = (own, opponent) => ({ kind: 'sharedType', own, opponent });
const bonus = (condition) => ({ kind: 'choose', condition, ifTrue: lit(120), ifFalse: lit(10) });
const damageValue = createCoreHandlers().get('cn.damageValue@1');

test('sharedType: schema and validation', () => {
  assert(damageValue.validateParameters({ expression: bonus(shared('field', 'field')) }));
  assert(damageValue.validateParameters({ expression: bonus(shared('active', 'active')) }));
  for (const node of [shared('bench', 'field'), { kind: 'sharedType', own: 'field' }, { ...shared('field', 'field'), who: 'self' }])
    assert(!damageValue.validateParameters({ expression: bonus(node) }), JSON.stringify(node));
});

test('「如果自己场上，有与对手场上宝可梦相同属性的宝可梦的话，则追加造成120伤害」 reads current types on both fields', async () => {
  const run = async (own, opponent, mutate) => {
    const f = await fixture((defs) => {
      for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.weakness = null;
      defs.find((d) => d.definitionId === 'other').mechanics.types = ['Fire', 'Grass'];
      defs.find((d) => d.definitionId === 'base').mechanics.attacks.push({ attackId: 'base:same', name: '测试同属', cost: ['Water'],
        printedDamage: null, effects: [binding('cn.damageValue@1', { expression: bonus(shared(own, opponent)) }, 'same')], sourceOfTruth: EVIDENCE });
    });
    const g = board(f, (s) => {
      attached(s, 0, s.players[0].active, 'water');
      mutate(s);
    });
    const from = g.snapshot().events.length;
    command(g, { type: 'attack', attackId: 'base:same' }); settle(g);
    return g.snapshot().events.slice(from).filter((e) => e.ruleId === 'attack.order' && Object.hasOwn(e.data, 'damage'))
      .reduce((n, e) => n + e.data.damage, 0);
  };
  // Both Actives are Water by default.
  assert.equal(await run('field', 'field', () => {}), 120);
  const fireOpponent = (s) => { const p = s.players[1], m = bench(s, 1, 'other'); p.bench.pop(); p.discard.push(...p.active.stack); p.active = m; };
  assert.equal(await run('field', 'field', fireOpponent), 10, 'Water vs Fire/Grass.');
  assert.equal(await run('field', 'field', (s) => { fireOpponent(s); bench(s, 0, 'other'); }), 120, 'Own Benched Fire/Grass Pokémon.');
  assert.equal(await run('active', 'active', (s) => { fireOpponent(s); bench(s, 0, 'other'); }), 10, 'Only the Actives.');
  assert.equal(await run('field', 'field', (s) => { fireOpponent(s); bench(s, 1, 'base'); }), 120, 'The opponent\'s Benched Water Pokémon.');
});

test('excludeTypes: 「（除【无】宝可梦外）」 leaves out a Pokémon having that type', () => {
  const def = (types) => ({ kind: 'pokemon', nameKey: 'x', name: 'x', mechanics: { stage: 'basic', types, tags: [], attacks: [], abilities: [] } });
  const selector = { kind: 'pokemon', stages: ['basic'], excludeTypes: ['Colorless'] };
  assert(validateCardSelector(selector));
  assert(!validateCardSelector({ kind: 'pokemon', excludeTypes: [] }));
  assert(matchesCardSelector(def(['Water']), selector));
  assert(!matchesCardSelector(def(['Colorless']), selector));
  assert(!matchesCardSelector(def(['Water', 'Colorless']), selector));
});
