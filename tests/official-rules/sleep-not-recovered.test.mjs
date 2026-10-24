// Synthetic definitions only. 「当这只宝可梦处于【睡眠】状态时，在宝可梦检查中，如果这只宝可梦没有从【睡眠】状态恢复的话，则回复这只宝可梦的全部HP。」
// and 「当这只宝可梦处于【睡眠】状态时，在宝可梦检查中，这只宝可梦没有从【睡眠】状态恢复的话，则给对手的战斗宝可梦身上，放置6个伤害指示物。」
// (trigger.sleep-not-recovered: the result of this checkup's Sleep check, I.F step 1, so such an effect follows that step).
// No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { triggerMatches } from '../../public/rules/triggers.js';
import { validateTriggerDescriptor } from '../../public/rules/schema-validators.js';
import { applyCondition } from '../../public/rules/conditions.js';
import { randomIndex } from '../../public/rules/random.js';
import { requireRule } from '../../public/rules/registry.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { fixture, binding, EVIDENCE, board, command, settle, answer, bench } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const seedFor = (coins) => {
  for (let i = 1; i <= 8192; i++) {
    const seed = [Math.imul(i, 8000009) >>> 0, Math.imul(i, 333333331) >>> 0, Math.imul(i, 17) >>> 0, Math.imul(i, 37) >>> 0], rng = [...seed];
    if (coins.every((heads) => (randomIndex(rng, 2) === 0) === heads)) return seed;
  }
  throw new Error('No fixture seed.');
};
const TRIGGER = { event: 'checkup', subject: 'self', optional: false, choiceOwner: 'source', scope: 'global', sleepNotRecovered: true };
const ability = (id, effects, trigger = TRIGGER) => ({ abilityId: `base:${id}`, name: `测试${id}`, mode: 'triggered', usage: null,
  trigger, effects, sourceOfTruth: EVIDENCE });
const healAll = binding('cn.healPokemon@1', { op: 'healPokemon', side: 'own', target: 'self', selector: { kind: 'pokemon' },
  selection: { kind: 'all' }, amount: 'all', discardHealedEnergy: false }, 'rest');
const nightmare = binding('cn.counters@1', { side: 'opponent', target: 'active', count: 6 }, 'nightmare');
// Player 0's Active 「测试宝可梦base」 (5 damage counters) is Asleep when player 0 ends the turn; the Sleep coin is `heads`.
function checkup(f, heads, mutate = () => {}) {
  const g = board(f, (s) => {
    const m = s.players[0].active;
    m.counters = 5; m.conditions = applyCondition(m.conditions, 'asleep', { ownerTurn: s.players[0].turns }).conditions;
    s.rng = seedFor([heads]);
    mutate(s);
  });
  command(g, { type: 'endTurn' });
  return g;
}

test('schema and rule: sleepNotRecovered is a checkup trigger filter', () => {
  assert(requireRule(CN_V20261019, 'trigger.sleep-not-recovered').sourceOfTruth.some((s) => s.section === 'I.F'));
  assert(validateTriggerDescriptor(TRIGGER));
  assert(!validateTriggerDescriptor({ ...TRIGGER, sleepNotRecovered: false }));
  assert(!validateTriggerDescriptor({ ...TRIGGER, event: 'turnEnd' }));
});

test('「如果这只宝可梦没有从【睡眠】状态恢复的话，则回复这只宝可梦的全部HP」 after the Sleep coin', async () => {
  const f = await fixture((defs) => { def(defs, 'base').mechanics.abilities = [ability('rest', [healAll])]; });
  const tails = checkup(f, false);
  assert.equal(tails.snapshot().pending, null, 'No before/after choice: it can only follow the Sleep check.');
  settle(tails);
  const asleep = tails.snapshot().players[0].active;
  assert.equal(asleep.conditions.rotation, 'asleep');
  assert.equal(asleep.counters, 0, 'Still Asleep: all HP healed.');
  assert.equal(asleep.facts.stayedAsleepTurn, 5);
  restore(tails, f);
  const heads = checkup(f, true); settle(heads);
  assert.equal(heads.snapshot().players[0].active.conditions.rotation, null);
  assert.equal(heads.snapshot().players[0].active.counters, 5, 'Recovered from Sleep: nothing.');
  const awake = checkup(f, false, (s) => { s.players[0].active.conditions.rotation = null; }); settle(awake);
  assert.equal(awake.snapshot().players[0].active.counters, 5, 'Not Asleep at the checkup: no Sleep check to fail.');
});

test('「…没有从【睡眠】状态恢复的话，则给对手的战斗宝可梦身上，放置6个伤害指示物」, with the holder\'s other checkup effects placed freely', async () => {
  const f = await fixture((defs) => {
    def(defs, 'base').mechanics.abilities = [ability('nightmare', [nightmare])];
    def(defs, 'other').mechanics.abilities = [{ ...ability('mend', [binding('cn.heal@1', { target: 'event', amount: 10 }, 'mend')],
      { event: 'checkup', subject: 'self', optional: false, choiceOwner: 'source', scope: 'subject' }), abilityId: 'other:mend' }];
  });
  const g = checkup(f, false);
  settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 6);
  const h = checkup(f, true); settle(h);
  assert.equal(h.snapshot().players[1].active.counters, 0);
  // Another checkup effect of the same holder is still placed before or after step 1 as its holder chooses.
  let mender;
  const both = checkup(f, false, (s) => { mender = bench(s, 0, 'other'); mender.counters = 2; });
  const q = both.snapshot().pending;
  assert.equal(q.kind, 'checkup-placement');
  answer(both, ['before']); settle(both);
  const s = both.snapshot();
  assert.equal(s.players[1].active.counters, 6);
  assert.equal(s.players[0].bench.find((m) => m.id === mender.id).counters, 1);
  restore(both, f);
});

test('the filter reads this checkup\'s recorded Sleep result and the Pokémon still being Asleep', async () => {
  const f = await fixture(), s = board(f).snapshot(), mon = s.players[0].active;
  const source = { instanceId: mon.stack[0], owner: 0, category: 'ability', pokemonId: mon.id, attackId: null, effectId: 'test', sourceOfTruth: EVIDENCE };
  const asleep = { ...clone(mon), conditions: applyCondition(mon.conditions, 'asleep', { ownerTurn: 1 }).conditions, facts: { stayedAsleepTurn: s.turn } };
  const event = { id: 'event', kind: 'checkup', turn: s.turn, during: null, endingPlayer: 0, subjectId: mon.id, owner: 0, wasActive: true,
    origin: null, cardId: null, damage: 0, cause: { kind: 'rule', source: null }, snapshot: asleep, definitionId: 'base', effectiveTypes: ['Water'] };
  const context = { sourceActive: true, definition: f.catalog.definition('base') };
  assert(triggerMatches(TRIGGER, event, source, context));
  assert(!triggerMatches(TRIGGER, { ...event, snapshot: { ...asleep, facts: { stayedAsleepTurn: s.turn - 2 } } }, source, context),
    'An earlier checkup\'s result.');
  assert(!triggerMatches(TRIGGER, { ...event, snapshot: { ...asleep, conditions: mon.conditions } }, source, context),
    'Recovered from Sleep in some other way before this effect.');
});
