// Real OfficialGame integration with SYNTHETIC definitions/printings only. Board, zone and history queries inside
// damage formulas (II.A; II.B-01..03; II.D-13 FAQ2; II.E-11/24/25/26). A fixture approves no card or printing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { assertBattleValue, evaluateBattleValue, battleQueryKey } from '../../public/rules/battle-value.js';
import { assertBattlePredicate, evaluateBattlePredicate } from '../../public/rules/battle-predicate.js';
import { recordBattleEvent } from '../../public/rules/battle-history.js';
import { matchesCardSelector } from '../../public/rules/card-selection.js';
import { fixture, binding, board, command, settle, hand, bench, attached, fixtureClock } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const lit = (value) => ({ kind: 'literal', value });
const mul = (left, right) => ({ kind: 'multiply', left, right });
const choose = (condition, ifTrue, ifFalse) => ({ kind: 'choose', condition, ifTrue, ifFalse });
const tens = (value) => mul(lit(10), value);
const count = (side, zone, extra = {}) => ({ kind: 'pokemonCount', side, zone, ...extra });
const sum = (field, where, energy) => ({ kind: 'pokemonSum', field, ...where, ...(energy ? { energy } : {}) });
const zone = (side, z, selector) => ({ kind: 'zoneCount', side, zone: z, ...(selector ? { selector } : {}) });
const is = (who, extra) => ({ kind: 'pokemonIs', who, ...extra });
const stadium = (owner, selector) => ({ kind: 'stadiumInPlay', owner, ...(selector ? { selector } : {}) });
const history = (fact, extra = {}) => ({ kind: 'historyFact', fact, ...extra });
// A predicate as damage: 90 if true, 10 if false.
const test90 = (condition) => choose(condition, lit(90), lit(10));
const formula = (expression) => binding('cn.damageValue@1', { expression }, 'board-query');
const damageValue = createCoreHandlers().get('cn.damageValue@1');

function hold(s, owner, mon, name = 'tool') { const id = hand(s, owner, name); s.players[owner].hand.pop(); mon.tools.push(id); return id; }
function putStadium(s, owner) { const id = hand(s, owner, 'stadium'); s.players[owner].hand.pop(); s.stadium = id; }
async function make(expression, transform = () => {}) {
  const f = await fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) {
      d.mechanics.hp = 500; d.mechanics.weakness = null; d.mechanics.resistance = null;
    }
    const a = defs[0].mechanics.attacks[0]; a.printedDamage = null; a.effects = [formula(expression)];
    transform(defs);
  });
  f.deck.splice(f.deck.indexOf('printing:water'), 4, ...Array(4).fill('printing:fire'));
  return f;
}
// Attack damage player 0's formula attack deals on the given board (the damage step, not later checkup counters).
async function dealt(expression, mutate = () => {}, transform = () => {}) {
  const f = await make(expression, transform);
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); mutate(s); });
  const from = g.snapshot().events.length;
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  const s = g.snapshot();
  OfficialGame.restore(clone(s), { catalog: f.catalog });
  return s.events.slice(from).filter((e) => e.ruleId === 'attack.order' && Object.hasOwn(e.data, 'damage'))
    .reduce((n, e) => n + e.data.damage, 0);
}

test('static syntax: every query kind validates in the schema and in the runtime reader alike', () => {
  const poke = { kind: 'pokemon', stages: ['stage1'] };
  const good = [
    count('own', 'bench'), count('both', 'field', { selector: poke, state: { damaged: true }, excludeSelf: true }),
    count('opponent', 'field', { state: { hasTool: true, hasAbility: true, conditions: ['poisoned', 'burned'] } }),
    sum('energyUnits', { who: 'self' }, { providedTypes: ['Water'] }), sum('tools', { side: 'own', zone: 'field' }),
    sum('energyCards', { side: 'opponent', zone: 'bench', selector: poke }, { selector: { kind: 'energy', category: 'special' } }),
    sum('damageCounters', { who: 'target' }), zone('own', 'hand', { kind: 'energy' }), zone('opponent', 'hand'),
    { kind: 'pokemonSum', field: 'tools', who: 'self', tool: { kind: 'trainer', nameKeys: ['tool'] } },
    zone('opponent', 'discard', { anyOf: [{ kind: 'pokemon' }, { kind: 'trainer' }] }), zone('own', 'deck'), zone('own', 'prizes'),
    zone('own', 'lostZone', { kind: 'any' }),
    choose(is('opponentActive', { selector: poke }), lit(1), lit(0)), choose(is('self', { state: { damaged: true } }), lit(1), lit(0)),
    choose(stadium('any'), lit(1), lit(0)), choose(stadium('own', { kind: 'trainer', nameKeys: ['stadium'] }), lit(1), lit(0)),
    choose(history('previousOpponentKnockout', { cause: 'attackDamage' }), lit(1), lit(0)),
    choose(history('supporterPlayed', { selector: { kind: 'trainer', tagsAll: ['Ancient'] } }), lit(1), lit(0)),
    choose(history('supporterPlayed'), lit(1), lit(0)), choose(history('movedToActive'), lit(1), lit(0)),
    choose(history('healed'), lit(1), lit(0)),
  ];
  for (const expression of good) {
    assert(damageValue.validateParameters({ expression }), JSON.stringify(expression));
    assert.doesNotThrow(() => assertBattleValue(expression));
  }
  const bad = [
    count('own', 'active'), count('all', 'field'), count('own', 'field', { excludeSelf: false }), count('own', 'field', { extra: 1 }),
    count('own', 'field', { selector: { kind: 'energy' } }), count('own', 'field', { selector: { kind: 'any' } }),
    count('own', 'field', { selector: { anyOf: [poke, poke] } }), count('own', 'field', { state: {} }),
    count('own', 'field', { state: { damaged: false } }), count('own', 'field', { state: { conditions: [] } }),
    count('own', 'field', { state: { conditions: ['poisoned', 'poisoned'] } }), count('own', 'field', { state: { sleepy: true } }),
    count('own', 'field', { state: [] }),
    sum('hp', { who: 'self' }), sum('damageCounters', { who: 'self' }, { providedTypes: ['Water'] }),
    sum('energyUnits', { who: 'nobody' }), sum('energyUnits', { who: 'self', side: 'own' }),
    sum('energyUnits', { who: 'self' }, {}), sum('energyUnits', { who: 'self' }, { providedTypes: ['Dragon'] }),
    sum('energyUnits', { who: 'self' }, { selector: { kind: 'pokemon' } }), sum('energyUnits', { who: 'self' }, { other: 1 }),
    { kind: 'pokemonSum', field: 'energyCards', who: 'self', tool: { kind: 'trainer' } },
    { kind: 'pokemonSum', field: 'tools', who: 'self', tool: { kind: 'pokemon' } },
    zone('both', 'hand'), zone('own', 'stadium'), zone('own', 'deck', { kind: 'any' }), zone('own', 'prizes', { kind: 'any' }),
    zone('opponent', 'hand', { kind: 'any' }), zone('own', 'discard', { kind: 'nonsense' }),
    choose(is('self', {}), lit(1), lit(0)), choose(is('bench', { state: { damaged: true } }), lit(1), lit(0)),
    choose(is('self', { selector: { kind: 'trainer' } }), lit(1), lit(0)), choose(is('self', { state: { hasTool: 1 } }), lit(1), lit(0)),
    choose(stadium('mine'), lit(1), lit(0)), choose(stadium('any', { kind: 'pokemon' }), lit(1), lit(0)),
    choose(history('previousOpponentKnockout'), lit(1), lit(0)), choose(history('previousOpponentKnockout', { cause: 'effect' }), lit(1), lit(0)),
    choose(history('movedToActive', { cause: 'any' }), lit(1), lit(0)), choose(history('healed', { selector: { kind: 'trainer' } }), lit(1), lit(0)),
    choose(history('supporterPlayed', { selector: { kind: 'energy' } }), lit(1), lit(0)), choose(history('evolved'), lit(1), lit(0)),
  ];
  for (const expression of bad) {
    const parsed = JSON.parse(JSON.stringify(expression));
    assert(!damageValue.validateParameters({ expression: parsed }), JSON.stringify(parsed));
    assert.throws(() => assertBattleValue(parsed), /invalid-battle|selector|state|query|side|history|Stadium|holder|Sums|Zone|Energy|trait|In-play|records|fields/i);
  }
});

test('the reader takes only host answers under the exact node key: integers for counts, booleans for tests', () => {
  const q = count('own', 'bench'), p = is('self', { state: { damaged: true } });
  assert.equal(battleQueryKey({ zone: 'bench', kind: 'pokemonCount', side: 'own' }), battleQueryKey(q));
  assert.equal(evaluateBattleValue(q, { queries: { [battleQueryKey(q)]: 3 } }), 3);
  assert.equal(evaluateBattlePredicate(p, { queries: { [battleQueryKey(p)]: true } }), true);
  for (const facts of [{}, { queries: {} }, { queries: { [battleQueryKey(q)]: -1 } }, { queries: { [battleQueryKey(q)]: true } }])
    assert.throws(() => evaluateBattleValue(q, facts), /invalid-battle-facts|safe integers|missing/);
  for (const facts of [{ queries: {} }, { queries: { [battleQueryKey(p)]: 1 } }])
    assert.throws(() => evaluateBattlePredicate(p, facts), (e) => e.code === 'invalid-battle-facts');
  assert.throws(() => assertBattlePredicate(is('self', { state: { damaged: true }, extra: 1 })), (e) => e.code === 'invalid-battle-predicate');
});

test('in-play counts: side, Bench or whole field, current-type selector, excludeSelf and state (II.B-02)', async () => {
  const two = (s) => { bench(s, 0, 'other'); bench(s, 0, 'evolution'); bench(s, 1, 'other'); };
  assert.equal(await dealt(tens(count('own', 'bench')), two), 20);
  assert.equal(await dealt(tens(count('both', 'bench')), two), 30);
  assert.equal(await dealt(tens(count('own', 'field')), two), 30, 'The field includes the Active Pokémon and this Pokémon.');
  assert.equal(await dealt(tens(count('own', 'field', { excludeSelf: true })), two), 20);
  assert.equal(await dealt(tens(count('own', 'field', { selector: { kind: 'pokemon', stages: ['stage1'] } })), two), 10);
  assert.equal(await dealt(tens(count('both', 'field', { selector: { kind: 'pokemon', types: ['Water'] } })), two), 50);
  assert.equal(await dealt(tens(count('both', 'field', { selector: { kind: 'pokemon', types: ['Fire'] } })), two), 0);
  assert.equal(await dealt(tens(count('both', 'field', { state: { damaged: true } })), (s) => {
    two(s); s.players[0].bench[0].counters = 2; s.players[1].active.counters = 1;
  }), 20);
  assert.equal(await dealt(tens(count('own', 'bench', { state: { hasTool: true } })), (s) => {
    two(s); hold(s, 0, s.players[0].bench[1]);
  }), 10);
  assert.equal(await dealt(tens(count('opponent', 'field', { state: { conditions: ['asleep', 'poisoned'] } })), (s) => {
    two(s); s.players[1].active.conditions.poison = 1;
  }), 10);
  assert.equal(await dealt(tens(count('opponent', 'field', { state: { conditions: ['poisoned'] } })), (s) => {
    two(s); s.players[1].active.conditions.burned = true;
  }), 0, 'Only the listed Special Conditions count.');
  for (const rotation of ['asleep', 'paralyzed', 'confused'])
    assert.equal(await dealt(tens(count('opponent', 'field', { state: { conditions: [rotation] } })), (s) => {
      s.players[1].active.conditions.rotation = rotation;
      if (rotation === 'paralyzed') s.players[1].active.conditions.paralysisRecoverTurn = s.turn + 1;
    }), 10);
});

test('II.D-13 FAQ2: only Pokémon whose Ability is in effect count as having an Ability', async () => {
  const withAbility = (defs) => {
    defs.find((d) => d.definitionId === 'other').mechanics.abilities = [{ abilityId: 'other:quiet', name: '测试特性',
      mode: 'continuous', usage: null, sourceOfTruth: defs[0].sourceOfTruth,
      effects: [binding('cn.modifier@1', { field: 'hp', amount: 10, scope: 'self' }, 'quiet')] }];
    defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [binding('cn.suppression@1', {
      effect: { op: 'suppression', channel: 'abilities', scope: 'all' } })];
  };
  const expression = tens(count('opponent', 'field', { state: { hasAbility: true } }));
  assert.equal(await dealt(expression, (s) => { bench(s, 1, 'other'); }, withAbility), 10);
  assert.equal(await dealt(expression, (s) => { bench(s, 1, 'other'); putStadium(s, 1); }, withAbility), 0);
});

test('attached sums: one holder or a set; Energy cards vs provided units, filtered by card and by provided type (II.D-08)', async () => {
  const energy = (s) => {
    const me = s.players[0].active, them = s.players[1];
    attached(s, 0, me, 'water'); attached(s, 0, me, 'fire'); attached(s, 0, me, 'double');
    attached(s, 1, them.active, 'fire'); attached(s, 1, bench(s, 1, 'other'), 'fire');
  };
  // The attack's own cost Water is attached too: self has water ×2, fire, double.
  assert.equal(await dealt(tens(sum('energyUnits', { who: 'self' }, { providedTypes: ['Water'] })), energy), 20);
  assert.equal(await dealt(tens(sum('energyUnits', { who: 'self' })), energy), 50);
  assert.equal(await dealt(tens(sum('energyCards', { who: 'self' })), energy), 40);
  assert.equal(await dealt(tens(sum('energyCards', { who: 'self' }, { selector: { kind: 'energy', category: 'special' } })), energy), 10);
  assert.equal(await dealt(tens(sum('energyUnits', { who: 'self' }, { selector: { kind: 'energy', category: 'special' } })), energy), 20);
  assert.equal(await dealt(tens(sum('energyCards', { who: 'self' }, { providedTypes: ['Fire', 'Water'] })), energy), 30);
  assert.equal(await dealt(tens(sum('energyUnits', { side: 'opponent', zone: 'field' }, { providedTypes: ['Fire'] })), energy), 20);
  assert.equal(await dealt(tens(sum('energyUnits', { side: 'both', zone: 'bench' })), energy), 10);
  assert.equal(await dealt(tens(sum('damageCounters', { side: 'own', zone: 'bench' })), (s) => {
    bench(s, 0, 'other').counters = 3; bench(s, 0, 'evolution').counters = 2; s.players[0].active.counters = 7;
  }), 50);
  assert.equal(await dealt(tens(sum('tools', { side: 'own', zone: 'field' })), (s) => {
    hold(s, 0, s.players[0].active, 'hp-tool'); hold(s, 0, bench(s, 0, 'other'));
  }), 20);
  assert.equal(await dealt(tens(sum('tools', { who: 'opponentActive' })), (s) => { hold(s, 1, s.players[1].active); }), 10);
});

test('zone counts: hand, deck, discard, Lost Zone and remaining Prize cards at damage calculation', async () => {
  const zones = (s) => {
    const p = s.players[0], q = s.players[1];
    p.discard.push(hand(s, 0, 'fire')); p.hand.pop(); p.discard.push(hand(s, 0, 'potion')); p.hand.pop();
    q.lost.push(hand(s, 1, 'fire')); q.hand.pop(); hand(s, 0, 'research');
  };
  let sizes;
  const measured = (s) => { zones(s); sizes = { hand: s.players[0].hand.length, theirs: s.players[1].hand.length,
    deck: s.players[0].deck.length, prizes: s.players[1].prizes.length }; };
  assert.equal(await dealt(tens(zone('own', 'hand')), measured), sizes.hand * 10);
  assert.equal(await dealt(tens(zone('opponent', 'hand')), measured), sizes.theirs * 10);
  assert.equal(await dealt(tens(zone('own', 'deck')), measured), sizes.deck * 10);
  assert.equal(await dealt(tens(zone('opponent', 'prizes')), measured), sizes.prizes * 10);
  assert.equal(await dealt(tens(zone('own', 'discard')), zones), 20);
  assert.equal(await dealt(tens(zone('own', 'discard', { kind: 'energy' })), zones), 10);
  assert.equal(await dealt(tens(zone('opponent', 'lostZone')), zones), 10);
  assert.equal(await dealt(tens(zone('own', 'hand', { kind: 'trainer', categories: ['supporter'] })), zones), 10);
});

test('one Pokémon\'s traits, Stadium ownership and identity as conditions', async () => {
  const evolved = (s) => { const p = s.players[1]; p.hand.push(...p.active.stack); p.active = bench(s, 1, 'evolution'); p.bench.pop(); };
  assert.equal(await dealt(test90(is('opponentActive', { selector: { kind: 'pokemon', stages: ['stage1'] } })), evolved), 90);
  assert.equal(await dealt(test90(is('opponentActive', { selector: { kind: 'pokemon', stages: ['stage1'] } }))), 10);
  assert.equal(await dealt(test90(is('opponentActive', { state: { conditions: ['poisoned'] } })), (s) => {
    s.players[1].active.conditions.poison = 1; }), 90);
  assert.equal(await dealt(test90(is('self', { selector: { kind: 'pokemon', nameKeys: ['base'] }, state: { damaged: true } })), (s) => {
    s.players[0].active.counters = 1; }), 90);
  // A Stadium whose own effect does not touch damage.
  const quiet = (defs) => { defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [
    binding('cn.modifier@1', { field: 'hp', amount: 10, scope: 'all' }, 'quiet-stadium')]; };
  assert.equal(await dealt(test90(stadium('any'))), 10);
  for (const [owner, expected] of [['own', 90], ['opponent', 10], ['any', 90]])
    assert.equal(await dealt(test90(stadium(owner)), (s) => putStadium(s, 0), quiet), expected);
  assert.equal(await dealt(test90(stadium('opponent', { kind: 'trainer', nameKeys: ['stadium'] })), (s) => putStadium(s, 1), quiet), 90);
  assert.equal(await dealt(test90(stadium('any', { kind: 'trainer', nameKeys: ['potion'] })), (s) => putStadium(s, 1), quiet), 10);
});

test('II.E-24 / II.E-26 / II.E-25: this Pokémon moved to the Active Spot or was healed this turn; a (tagged) Supporter was played', async () => {
  const fact = (kind, extra = {}) => (s) => {
    s.battleHistory = recordBattleEvent(s.battleHistory, { kind, turn: s.turn, during: 0, owner: 0, ...extra }, { turn: s.turn, during: 0 });
  };
  const self = (s) => s.players[0].active.id;
  assert.equal(await dealt(test90(history('movedToActive')), (s) => fact('benchToActive', { pokemonId: self(s) })(s)), 90);
  assert.equal(await dealt(test90(history('movedToActive'))), 10);
  assert.equal(await dealt(test90(history('healed')), (s) => fact('heal', { pokemonId: self(s), amount: 30 })(s)), 90);
  assert.equal(await dealt(test90(history('healed')), (s) => fact('heal', { pokemonId: 'm-elsewhere', amount: 30 })(s)), 10);
  const ancient = (defs) => { defs.find((d) => d.definitionId === 'research').mechanics.tags = ['Ancient']; };
  const played = (s) => {
    const id = hand(s, 0, 'research'); s.players[0].hand.pop(); s.players[0].discard.push(id);
    fact('supporterPlayed', { cardId: id, origin: 'hand' })(s);
  };
  assert.equal(await dealt(test90(history('supporterPlayed')), played), 90);
  assert.equal(await dealt(test90(history('supporterPlayed'))), 10);
  assert.equal(await dealt(test90(history('supporterPlayed', { selector: { kind: 'trainer', tagsAll: ['Ancient'] } })), played, ancient), 90);
  assert.equal(await dealt(test90(history('supporterPlayed', { selector: { kind: 'trainer', tagsAll: ['Future'] } })), played, ancient), 10);
});

test('II.E-11: a Knock Out by attack damage during the previous opponent turn, distinct from any Knock Out', async () => {
  for (const [cause, expected] of [['attackDamage', 90], ['any', 90]]) {
    const f = await make(test90(history('previousOpponentKnockout', { cause })));
    let next;
    const g = board(f, (s) => {
      fixtureClock(s, [0, 1, 0, 1]);
      s.players[0].active.counters = 49; next = bench(s, 0, 'base'); attached(s, 0, next, 'water');
      attached(s, 1, s.players[1].active, 'water');
    });
    command(g, { type: 'attack', attackId: 'base:strike' }, 1);
    settle(g, (q) => q.kind === 'promote' ? [next.id] : q.options.slice(0, q.minimum));
    assert.equal(g.snapshot().players[0].active.id, next.id);
    const before = g.snapshot().players[1].active.counters;
    command(g, { type: 'attack', attackId: 'base:strike' }, 0); settle(g);
    assert.equal((g.snapshot().players[1].active.counters - before) * 10, expected);
  }
  assert.equal(await dealt(test90(history('previousOpponentKnockout', { cause: 'any' }))), 10, 'No Knock Out in the previous opponent turn.');
});

test('frozen facts: the stage snapshot keeps every answer per target; an attack without queries has no queries field', async () => {
  const q = count('opponent', 'bench'), t = is('target', { state: { damaged: true } });
  const f = await make(add2(tens(q), test90(t)));
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); bench(s, 1, 'other').counters = 1; });
  command(g, { type: 'attack', attackId: 'base:strike' });
  const snapshot = g.snapshot().events.find((e) => e.ruleId === 'damage.expression' && e.data.kind === 'stage-snapshot');
  for (const model of snapshot.data.models) {
    assert.equal(model.battleValues.queries[battleQueryKey(q)], 1);
    assert.equal(model.battleValues.queries[battleQueryKey(t)], model.owner === 1 && model.targetPosition === 'bench');
  }
  settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 2, '10 for the Bench count, then 10: the Active is undamaged.');
  const plain = await make(lit(30));
  const h = board(plain, (s) => attached(s, 0, s.players[0].active, 'water'));
  command(h, { type: 'attack', attackId: 'base:strike' });
  const models = h.snapshot().events.find((e) => e.data.kind === 'stage-snapshot').data.models;
  assert(models.every((m) => !Object.hasOwn(m.battleValues, 'queries')));
});
function add2(...terms) { return { kind: 'add', terms }; }

test('extra packets: a target query has no answer while rolls are prepared, and each chosen target reads its own', async () => {
  const amount = add2(choose(is('target', { state: { damaged: true } }), lit(50), lit(20)), tens(sum('damageCounters', { who: 'target' })));
  const f = await make(lit(0), (defs) => {
    defs[0].mechanics.attacks[0].effects = [binding('cn.damage@1', { side: 'opponent', target: 'bench', amount,
      selection: { kind: 'exact', count: 1 }, options: {}, rolls: [{ key: 'flip', spec: { kind: 'fixed', count: 1 } }] }, 'packet')];
  });
  let hurt;
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); hurt = bench(s, 1, 'other'); hurt.counters = 2; });
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  assert.equal(g.snapshot().players[1].bench.find((m) => m.id === hurt.id).counters, 2 + 7, '50 for a damaged target plus 2×10.');
});

test('a Trainer CardSelector reads printed Trainer tags; an untagged Trainer has none', async () => {
  const f = await fixture((defs) => { defs.find((d) => d.definitionId === 'research').mechanics.tags = ['Ancient']; });
  const def = (id) => f.definitions.find((d) => d.definitionId === id);
  assert.equal(matchesCardSelector(def('research'), { kind: 'trainer', tagsAll: ['Ancient'] }), true);
  assert.equal(matchesCardSelector(def('stadium'), { kind: 'trainer', tagsAll: ['Ancient'] }), false);
});
