// Synthetic definitions only. 「若希望，可以追加造成120伤害。在这种情况下，给这只宝可梦也造成50伤害」 and 「若希望，可使对手的战斗宝可梦陷入
// 【麻痹】状态。在这种情况下，给这只宝可梦也造成70点伤害」 (damage.optional-choice): decided before damage; the formula, the recoil and a later
// entry read the recorded choice. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, assertSupportedDefinition } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const chosen = { kind: 'compare', left: { kind: 'effectCards', effectId: 'fixture:choice' }, relation: 'gt', right: { kind: 'literal', value: 0 } };
const choose = (yes, no) => ({ kind: 'choose', condition: chosen, ifTrue: { kind: 'literal', value: yes }, ifFalse: { kind: 'literal', value: no } });
const attack = (effects) => fixture((defs) => {
  for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.weakness = null; d.mechanics.hp = 300; }
  defs.find((d) => d.definitionId === 'base').mechanics.attacks.push({ attackId: 'base:choice', name: '测试选择', cost: [],
    printedDamage: { value: 20, operator: 'plus' }, effects, sourceOfTruth: EVIDENCE });
});
const effects = [
  binding('cn.attackChoice@1', {}, 'choice'),
  binding('cn.damageValue@1', { expression: choose(140, 20) }, 'damage'),
  binding('cn.recoilDamage@1', { side: 'own', target: 'self', amount: choose(50, 0), selection: { kind: 'all' }, options: {} }, 'recoil'),
  binding('cn.when@1', { condition: chosen, effect: { handlerId: 'cn.condition@1', parameters: { side: 'opponent', condition: 'paralyzed' } } }, 'then'),
];

test('「若希望，可追加造成N伤害。在这种情况下，…」', async () => {
  const f = await attack(effects);
  const run = (choice) => {
    const g = board(f);
    command(g, { type: 'attack', attackId: 'base:choice' });
    assert.equal(g.snapshot().pending.kind, 'optional-effect');
    assert.deepEqual(OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog }).view(0), g.view(0));
    answer(g, [choice]); settle(g);
    const s = g.snapshot();
    assert.deepEqual(OfficialGame.restore(clone(s), { catalog: f.catalog }).snapshot(), s);
    return s;
  };
  let s = run('perform');
  assert.equal(s.players[1].active.counters, 14); assert.equal(s.players[0].active.counters, 5);
  assert.equal(s.players[1].active.conditions.rotation, 'paralyzed');
  s = run('skip');
  assert.equal(s.players[1].active.counters, 2); assert.equal(s.players[0].active.counters, 0);
  assert.equal(s.players[1].active.conditions.rotation, null);
});

test('only an attack\'s own counted record, read after it', async () => {
  const handlers = createCoreHandlers(), catalog = { handler: (id) => handlers.get(id) };
  const f = await attack(effects);
  const def = clone(f.definitions.find((d) => d.definitionId === 'base'));
  assertSupportedDefinition(catalog, def);
  const other = clone(def);
  other.mechanics.attacks.at(-1).effects[0] = binding('cn.attackChoice@1', {}, 'elsewhere');
  assert.throws(() => assertSupportedDefinition(catalog, other), (e) => e.code === 'unsupported-condition');
  const trainer = clone(f.definitions.find((d) => d.definitionId === 'potion'));
  trainer.mechanics.effects = [effects[3]];
  assert.throws(() => assertSupportedDefinition(catalog, trainer), (e) => e.code === 'unsupported-condition');
  const outside = clone(f.definitions.find((d) => d.definitionId === 'potion'));
  outside.mechanics.effects = [binding('cn.attackChoice@1', {}, 'choice')];
  assert.throws(() => assertSupportedDefinition(catalog, outside), (e) => e.code === 'unsupported-effect-count');
});
