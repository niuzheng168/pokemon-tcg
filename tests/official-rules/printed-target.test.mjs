// Synthetic definitions only. 「给对手的1只宝可梦，造成其身上附有的能量数量×20点伤害。这个招式的伤害不计算弱点、抗性。」 printed 「20×」
// (attack.printed-target; II.B-08: such damage is not an effect and takes part in the damage calculation). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, assertSupportedDefinition } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { assertExecutableDefinition, canonicalDefinition } from '../../public/rules/card-schema.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, RULESET, board, command, settle, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const handlers = createCoreHandlers();
const lit = (value) => ({ kind: 'literal', value });
const arrow = (extra = {}) => ({ side: 'opponent', target: 'any', selection: { kind: 'exact', count: 1 },
  amount: { kind: 'multiply', left: lit(20), right: { kind: 'pokemon', who: 'target', field: 'energyUnits' } },
  options: { ignoreWeakness: true, ignoreResistance: true }, printed: true, ...extra });
const latias = (effects = [binding('cn.damage@1', arrow(), 'arrow')]) => (defs) => {
  for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 500; d.mechanics.weakness = { type: 'Water', operation: 'multiply', value: 2 }; }
  Object.assign(defs[0].mechanics.attacks[0], { printedDamage: { value: 20, operator: 'times' }, effects });
};

test('schemas: the printed packet is one chosen opponent\'s Pokémon; the rule cites II.B-08', () => {
  assert(requireRule(CN_V20261019, 'attack.printed-target').sourceOfTruth.some((s) => s.section.includes('II.B-08')));
  const valid = (p) => handlers.get('cn.damage@1').validateParameters(clone(p));
  assert(valid(arrow()));
  for (const bad of [arrow({ printed: false }), arrow({ side: 'own' }), arrow({ selection: { kind: 'exact', count: 2 } }), arrow({ selection: { kind: 'all' } })])
    assert(!valid(bad), JSON.stringify(bad));
});

test('the printed 「20×」 goes to the chosen Pokémon, ×its Energy, without Weakness; nothing to the Active besides', async () => {
  const f = await fixture(latias());
  let target, active;
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water');
    active = s.players[1].active; attached(s, 1, active, 'water');
    target = bench(s, 1, 'other'); attached(s, 1, target, 'water'); attached(s, 1, target, 'double');
  });
  command(g, { type: 'attack', attackId: 'base:strike' });
  assert.equal(g.snapshot().pending.kind, 'damage-targets');
  restore(g, f);
  settle(g, (q) => q.options.includes(target.id) ? [target.id] : []);
  let s = g.snapshot();
  assert.deepEqual([s.players[1].bench[0].counters, s.players[1].active.counters], [6, 0], '20 × 3 Energy units; the Active untouched.');
  // The Active chosen: 20 × 1, Weakness not applied.
  const h = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); attached(s, 1, s.players[1].active, 'water'); bench(s, 1, 'other'); });
  command(h, { type: 'attack', attackId: 'base:strike' });
  settle(h, (q) => [h.snapshot().players[1].active.id]);
  s = h.snapshot();
  assert.deepEqual([s.players[1].active.counters, s.players[1].bench[0].counters], [2, 0]);
});

test('load: one printed packet, with printed damage and no other damage formula; the card schema accepts it as the formula', async () => {
  const f = await fixture(latias());
  const catalog = { handler: (id) => handlers.get(id) };
  const d = clone(f.catalog.definition('base'));
  assert.doesNotThrow(() => assertSupportedDefinition(catalog, d));
  const executable = (x) => assertExecutableDefinition(x, { ruleset: RULESET, handlers, approvedDefinitions: new Map([[x.definitionId, canonicalDefinition(x)]]) });
  assert.doesNotThrow(() => executable(d));
  const with_ = (effects, printedDamage = d.mechanics.attacks[0].printedDamage) => {
    const x = clone(d); Object.assign(x.mechanics.attacks[0], { effects, printedDamage }); return x;
  };
  const packet = binding('cn.damage@1', arrow(), 'arrow');
  for (const bad of [with_([packet, binding('cn.damage@1', arrow(), 'again')]), with_([packet], null),
    with_([packet, binding('cn.damageValue@1', { expression: lit(20) }, 'formula')])])
    assert.throws(() => assertSupportedDefinition(catalog, bad), (e) => e.code === 'unsupported-formula');
  const { printed: _printed, ...plain } = arrow();
  assert.throws(() => executable(with_([binding('cn.damage@1', plain, 'plain')])), /Non-fixed printed damage/);
});
