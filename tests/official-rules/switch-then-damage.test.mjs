// Synthetic definitions only. 「选择对手的1只备战宝可梦，将其与战斗宝可梦互换。然后，给新出场的宝可梦造成40伤害。」 (no printed
// damage): the switch comes first, then the attack's damage to the new Active; nothing switched, no damage (damage.after-switch).
// No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, attached, bench } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const gust = (extra = {}) => ({ side: 'opponent', chooser: 'self', affected: 'selected', ...extra });
const damage = { expression: { kind: 'multiply', left: { kind: 'literal', value: 40 },
  right: { kind: 'effectCards', effectId: 'fixture:gust' } } };

async function make(parameters = gust()) {
  return fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.weakness = null;
    defs.find((d) => d.definitionId === 'base').mechanics.attacks.push({ attackId: 'base:drag', name: '测试拖出', cost: ['Water'],
      printedDamage: null, effects: [binding('cn.countedSwitch@1', parameters, 'gust'), binding('cn.damageValue@1', damage, 'damage')],
      sourceOfTruth: EVIDENCE });
  });
}

test('countedSwitch: schema, CN rule and supplementary rulings', () => {
  const valid = (p) => createCoreHandlers().get('cn.countedSwitch@1').validateParameters(clone(p));
  assert(valid(gust())); assert(valid(gust({ chooser: 'opponent', affected: 'active' })));
  assert(valid(gust({ selector: { kind: 'pokemon', stages: ['basic'] } })));
  for (const bad of [gust({ side: 'own' }), gust({ affected: 'source' }), gust({ outgoingHeal: 30 }), gust({ count: 1 })])
    assert(!valid(bad), JSON.stringify(bad));
  const sources = requireRule(CN_V20261019, 'damage.after-switch').sourceOfTruth.map((r) => r.documentId);
  assert.deepEqual(sources, ['CN-advanced-3.1.0', 'JP-official-qa', 'JP-official-qa']);
});

test('the attack damages the Pokémon that came in, not the one that left', async () => {
  const f = await make();
  let other;
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); other = bench(s, 1, 'other'); });
  const old = g.snapshot().players[1].active.id;
  command(g, { type: 'attack', attackId: 'base:drag' });
  const q = g.snapshot().pending;
  assert.equal(q.player, 0); assert.deepEqual(q.options, [other.id]);
  assert.deepEqual(OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog }).view(0), g.view(0));
  answer(g, [other.id]); settle(g);
  const s = g.snapshot();
  assert.equal(s.players[1].active.id, other.id);
  assert.equal(s.players[1].active.counters, 4);
  assert.equal(s.players[1].bench.find((m) => m.id === old).counters, 0);
  assert.deepEqual(s.events.find((e) => e.ruleId === 'damage.effect-count').data.cards, [other.stack[0]]);
});

test('nothing switched, nothing damaged; the opponent may choose the Pokémon that comes in', async () => {
  let g = board(await make(), (s) => attached(s, 0, s.players[0].active, 'water'));
  command(g, { type: 'attack', attackId: 'base:drag' }); settle(g);
  let s = g.snapshot();
  assert.equal(s.players[1].active.counters, 0);
  assert.deepEqual(s.events.find((e) => e.ruleId === 'damage.effect-count').data.cards, []);
  assert.equal(s.current, 1, 'The attack still ends the turn.');
  let other;
  g = board(await make(gust({ chooser: 'opponent', affected: 'active' })), (s) => {
    attached(s, 0, s.players[0].active, 'water'); other = bench(s, 1, 'other');
  });
  command(g, { type: 'attack', attackId: 'base:drag' });
  assert.equal(g.snapshot().pending.player, 1);
  answer(g, [other.id]); settle(g);
  s = g.snapshot();
  assert.equal(s.players[1].active.counters, 4);
});
