// Synthetic definitions only. 「这个招式，只有在……时才可使用」 (I.A-01 step 1-a): judged whenever the attack could be declared;
// unmet, it cannot be declared at all (unlike 「这个招式失败」). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSupportedDefinition } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, bench, attached, fixtureClock } from './fixtures.mjs';

const def = (defs, id) => defs.find((d) => d.definitionId === id);
const lit = (value) => ({ kind: 'literal', value });
const handlers = createCoreHandlers();
const sturdy = (defs) => { for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 500; d.mechanics.weakness = null; d.mechanics.resistance = null; } };
const withCondition = (predicate) => (defs) => { sturdy(defs); def(defs, 'base').mechanics.attacks[0].condition = { predicate }; };
const canAttack = (g) => g.view(0).legalActions.some((a) => a.type === 'attack' && a.attackId === 'base:strike');
const secondFirst = { kind: 'historyFact', fact: 'secondPlayerFirstTurn' };
const damaged = { kind: 'pokemonIs', who: 'self', state: { damaged: true } };

test('schema, rule and load guard: facts of the moment the attack could be declared', async () => {
  assert(requireRule(CN_V20261019, 'attack.condition').sourceOfTruth.some((s) => s.section.includes('I.A-01.1-a')));
  const f = await fixture();
  const catalog = { handler: (id) => handlers.get(id) }, mon = structuredClone(def(f.definitions, 'base'));
  mon.mechanics.attacks[0].condition = { predicate: damaged };
  assert.doesNotThrow(() => assertSupportedDefinition(catalog, mon));
  for (const predicate of [{ kind: 'compare', left: { kind: 'prizes', side: 'own' }, relation: 'gt', right: lit(1) },
    { kind: 'compare', left: { kind: 'coin', key: 'flip', field: 'heads' }, relation: 'gt', right: lit(0) }]) {
    mon.mechanics.attacks[0].condition = { predicate };
    assert.throws(() => assertSupportedDefinition(catalog, mon), (e) => e.code === 'unsupported-condition');
  }
  await assert.rejects(fixture((defs) => { def(defs, 'base').mechanics.attacks[0].condition = {}; }));
});

test('「这个招式，只有在后攻玩家的最初回合才可使用」 and 「只有在这只宝可梦身上放置有伤害指示物时才可使用」', async () => {
  const first = await fixture(withCondition(secondFirst));
  const water = (s) => attached(s, 0, s.players[0].active, 'water');
  assert(canAttack(board(first, (s) => { water(s); fixtureClock(s, [1, 0]); })), 'The second player\'s first turn.');
  assert(!canAttack(board(first, (s) => { water(s); fixtureClock(s, [1, 0, 1, 0]); })));
  assert(!canAttack(board(first, (s) => { water(s); fixtureClock(s, [0, 1, 0]); })));
  const hurt = await fixture(withCondition(damaged));
  const g = board(hurt, (s) => { water(s); });
  assert(!canAttack(g));
  assert.throws(() => command(g, { type: 'attack', attackId: 'base:strike' }));
  const h = board(hurt, (s) => { water(s); s.players[0].active.counters = 2; });
  assert(canAttack(h));
  const from = h.snapshot().events.length;
  command(h, { type: 'attack', attackId: 'base:strike' }); settle(h);
  assert(h.snapshot().events.slice(from).some((e) => e.ruleId === 'attack.order' && e.data.damage === 20));
});

test('a copied attack\'s own use condition is not guessed', async () => {
  const f = await fixture((defs) => {
    const a = def(defs, 'base').mechanics.attacks[0]; a.printedDamage = null;
    a.effects = [binding('cn.copyAttack@1', { op: 'copyAttack', origins: [{ side: 'opponent', zone: 'field', selector: { kind: 'pokemon', nameKeys: ['other'] } }],
      excludeUser: false, coin: 'none', energy: 'ignore', special: { mode: 'needsRuling', sourceOfTruth: EVIDENCE } })];
    def(defs, 'other').mechanics.attacks[0].condition = { predicate: damaged };
  });
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water');
    const p = s.players[1], m = bench(s, 1, 'other'); p.bench.pop(); p.bench.push(p.active); p.active = m;
  });
  command(g, { type: 'attack', attackId: 'base:strike' });
  const option = g.view(0).pending.attacks.find((a) => a.attackId === 'other:strike');
  const before = g.snapshot();
  assert.throws(() => answer(g, [option.optionId]), (e) => e.code === 'unresolved-copy-condition');
  assert.deepEqual(g.snapshot(), before);
});
