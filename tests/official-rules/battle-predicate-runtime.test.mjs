// Real OfficialGame formula integration with synthetic cards only, not printing approval.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { BattleValueError } from '../../public/rules/battle-value.js';
import * as validators from '../../public/rules/schema-validators.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const literal = (value) => ({ kind: 'literal', value });
const binary = (kind, left, right) => ({ kind, left, right });
const add = (...terms) => ({ kind: 'add', terms });
const subtract = (left, right) => binary('subtract', left, right);
const multiply = (left, right) => binary('multiply', left, right);
const pokemon = (who, field) => ({ kind: 'pokemon', who, field });
const prizes = (side = 'own') => ({ kind: 'prizes', side });
const compare = (left, relation, right) => ({ kind: 'compare', left, right, relation });
const exists = (who) => ({ kind: 'exists', who });
const all = (...conditions) => ({ kind: 'all', conditions });
const any = (...conditions) => ({ kind: 'any', conditions });
const not = (condition) => ({ kind: 'not', condition });
const choose = (condition, ifTrue, ifFalse) => ({ kind: 'choose', condition, ifTrue, ifFalse });
const yes = () => compare(literal(1), 'eq', literal(1));
const no = () => compare(literal(1), 'eq', literal(0));
const parameters = (expression) => ({ expression });
const formula = (expression, id = 'conditional-damage') => binding('cn.damageValue@1', parameters(expression), id);
function install(defs, definitionId, expression, extra = []) {
  const attack = defs.find((d) => d.definitionId === definitionId).mechanics.attacks[0];
  attack.printedDamage = { value: 20, operator: 'plus' };
  attack.effects = [formula(expression), ...extra];
  return attack;
}
async function make(expression, extend = () => {}, handlers = new Map()) {
  return fixture((defs) => {
    defs[0].mechanics.hp = 200; defs[1].mechanics.hp = 500;
    for (const d of defs.filter((d) => d.kind === 'pokemon')) {
      d.mechanics.weakness = null; d.mechanics.resistance = null;
    }
    install(defs, 'base', expression); extend(defs);
  }, handlers);
}
function opponent(s) {
  const p = s.players[1], old = p.active;
  p.hand.push(...old.stack, ...old.energy, ...old.tools);
  p.active = bench(s, 1, 'other'); p.bench.pop();
  return p.active;
}
function battle(f, mutate = () => {}) {
  return board(f, (s) => {
    opponent(s); attached(s, 0, s.players[0].active, 'water'); mutate(s);
  });
}
function held(s, definitionId) {
  const id = hand(s, 0, definitionId), p = s.players[0];
  p.hand.splice(p.hand.indexOf(id), 1); p.active.tools.push(id); return id;
}
function sevenPrizes(s) {
  const p = s.players[0];
  while (p.prizes.length < 7) p.prizes.push(p.deck.pop());
  assert.equal(p.prizes.length, 7);
}
const attack = (g) => command(g, { type: 'attack', attackId: 'base:strike' });
const packets = (g, from) => g.snapshot().events.slice(from).filter((e) =>
  e.ruleId === 'attack.order' && Object.hasOwn(e.data, 'damage'));
function restore(g, f) {
  const r = OfficialGame.restore(JSON.parse(JSON.stringify(g.snapshot())), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  for (const viewer of [0, 1]) assert.deepEqual(r.view(viewer), g.view(viewer));
  return r;
}
function respond(g, f, selected) {
  const r = restore(g, f); answer(g, selected); answer(r, selected);
  assert.deepEqual(r.snapshot(), g.snapshot());
}
function atomic(g, run, predicate) {
  const before = g.snapshot(), views = [g.view(0), g.view(1)];
  assert.throws(run, predicate);
  assert.deepEqual(g.snapshot(), before, 'Failure must roll back damage, counters, facts, quotas, events, RNG, queue and revision.');
  assert.deepEqual([g.view(0), g.view(1)], views);
}
function needsRuling(error) {
  assert(error instanceof BattleValueError);
  assert.equal(error.code, 'needs-ruling');
  assert.equal(error.needsRuling, true);
  assert.equal(error.ruleId, 'damage.expression');
  return true;
}

test('choose adds 110 only when the actual opposing Active already has damage counters; printed damage is immutable', async () => {
  const expression = choose(compare(pokemon('opponentActive', 'damageCounters'), 'gt', literal(0)),
    add(literal(20), literal(110)), literal(20));
  const f = await make(expression), printed = structuredClone(f.catalog.definition('base'));
  for (const [initial, damage] of [[0, 20], [1, 130]]) {
    const g = battle(f, (s) => { s.players[1].active.counters = initial; }), before = g.snapshot();
    attack(g); settle(g);
    assert.equal(g.snapshot().players[1].active.counters, initial + damage / 10);
    assert.deepEqual(packets(g, before.events.length).map((e) => e.data.damage), [damage]);
    assert.deepEqual(f.catalog.definition('base'), printed);
    restore(g, f);
  }
});

test('full-HP comparison uses effective remainingHp == maximumHp, not printed HP or an invented fullness flag', async () => {
  const expression = choose(compare(pokemon('self', 'remainingHp'), 'eq', pokemon('self', 'maximumHp')), literal(80), literal(30));
  const f = await make(expression);
  for (const [counters, damage] of [[0, 80], [1, 30]]) {
    const g = battle(f, (s) => { held(s, 'hp-tool'); s.players[0].active.counters = counters; });
    assert.equal(g.view(0).players[0].active.effective.maxHp, 250);
    assert.equal(g.view(0).players[0].active.effective.currentHp, 250 - counters * 10);
    const before = g.snapshot(); attack(g); settle(g);
    assert.deepEqual(packets(g, before.events.length).map((e) => e.data.damage), [damage]);
    assert.equal(g.snapshot().players[0].active.counters, counters);
    assert.equal(f.catalog.definition('base').mechanics.hp, 200);
  }
});

test('choose distinguishes physical Energy cards from units before multiplying the two actual sides’ total by 20', async () => {
  const cards = add(pokemon('self', 'energyCards'), pokemon('opponentActive', 'energyCards'));
  const units = add(pokemon('ownActive', 'energyUnits'), pokemon('opponentActive', 'energyUnits'));
  const expression = choose(compare(cards, 'neq', units), multiply(units, literal(20)), multiply(cards, literal(20)));
  const f = await make(expression);
  for (const [double, damage] of [[false, 40], [true, 80]]) {
    const g = battle(f, (s) => {
      attached(s, 1, s.players[1].active, 'water');
      if (double) attached(s, 0, s.players[0].active, 'double');
    }), before = g.snapshot();
    attack(g); settle(g);
    assert.deepEqual(packets(g, before.events.length).map((e) => e.data.damage), [damage]);
    assert.deepEqual(g.snapshot().players[0].active.energy, before.players[0].active.energy);
    assert.deepEqual(g.snapshot().players[1].active.energy, before.players[1].active.energy);
    assert.deepEqual(f.catalog.definition('double').mechanics.baseUnits, [['Colorless'], ['Colorless']]);
  }
});

test('all/any/not and choose short-circuit unresolved Prize reads, but executing that branch rejects atomically', async () => {
  const unresolved = compare(prizes(), 'gte', literal(0));
  const condition = all(exists('self'), any(yes(), unresolved), not(all(no(), unresolved)));
  const expression = choose(condition, literal(40), multiply(prizes(), literal(20)));
  const f = await make(expression), g = battle(f, sevenPrizes), before = g.snapshot();
  attack(g); settle(g);
  assert.deepEqual(packets(g, before.events.length).map((e) => e.data.damage), [40]);
  assert.equal(g.snapshot().players[0].prizes.length, 7);
  const bad = await make(choose(no(), literal(40), multiply(prizes(), literal(20))), (defs) => {
    defs[0].mechanics.attacks[0].specialRule = 'GX';
  });
  const rejected = battle(bad, sevenPrizes);
  atomic(rejected, () => attack(rejected), needsRuling);
  assert.equal(rejected.snapshot().players[0].gxUsed, false);
  assert.equal(rejected.snapshot().players[0].active.facts.lastUsedAttack, undefined);
  restore(rejected, bad);
});

test('huge intermediate literal arithmetic cancels exactly with BigInt before choosing a representable ten-point damage result', async () => {
  const huge = literal(Number.MAX_SAFE_INTEGER);
  const square = multiply(huge, huge);
  const exactTwenty = subtract(add(huge, literal(20)), huge);
  const exactForty = subtract(square, subtract(square, literal(40)));
  const expression = choose(compare(exactTwenty, 'eq', literal(20)), exactForty, literal(10));
  const f = await make(expression), g = battle(f), before = g.snapshot();
  attack(g); settle(g);
  assert.deepEqual(packets(g, before.events.length).map((e) => e.data.damage), [40]);
  assert.equal(g.snapshot().players[1].active.counters, 4);
  assert.deepEqual(f.catalog.definition('base').mechanics.attacks[0].printedDamage, { value: 20, operator: 'plus' });
});

test('C-18 predicates and values belong to the actual user/target, with JSON continuation before copy choice and after formula damage', async () => {
  const expression = choose(all(exists('self'), exists('target'),
    compare(pokemon('self', 'damageCounters'), 'eq', literal(2)),
    compare(pokemon('target', 'damageCounters'), 'eq', literal(0)),
    compare(pokemon('self', 'maximumHp'), 'eq', pokemon('ownActive', 'maximumHp')),
    compare(pokemon('target', 'maximumHp'), 'eq', pokemon('opponentActive', 'maximumHp')),
    compare(pokemon('self', 'energyUnits'), 'eq', literal(1))),
  multiply(add(pokemon('self', 'damageCounters'), literal(1)), literal(20)), literal(10));
  const f = await make(literal(0), (defs) => {
    const root = defs[0].mechanics.attacks[0]; root.printedDamage = null;
    root.effects = [binding('cn.copyAttack@1', {
      op: 'copyAttack', origins: [{ side: 'opponent', zone: 'active', selector: { kind: 'pokemon', nameKeys: ['other'] } }],
      excludeUser: false, coin: 'none', energy: 'ignore', special: { mode: 'needsRuling', sourceOfTruth: EVIDENCE },
    })];
    const borrowed = install(defs, 'other', expression, [binding('cn.heal@1', { target: 'self', amount: 10 })]);
    borrowed.cost = ['Fire', 'Fire', 'Fire'];
  });
  const g = battle(f, (s) => { s.players[0].active.counters = 2; }), before = g.snapshot();
  const printed = structuredClone(f.catalog.definition('other'));
  attack(g); assert.equal(g.snapshot().pending.kind, 'copy-attack');
  const option = g.view(0).pending.attacks.find((a) => a.attackId === 'other:strike'); assert(option);
  respond(g, f, [option.optionId]);
  assert.equal(g.snapshot().pending.kind, 'effect-target');
  assert.equal(g.snapshot().players[1].active.counters, 6);
  assert.equal(g.snapshot().players[0].active.counters, 2);
  respond(g, f, [before.players[0].active.id]); settle(g);
  const allPackets = packets(g, before.events.length);
  assert.deepEqual(allPackets.map((e) => e.data.damage), [0, 60], 'The copy declaration has no printed damage; borrowed content deals exactly once.');
  const damage = allPackets.filter((e) => Object.hasOwn(e.data, 'contentSource'));
  assert.equal(damage.length, 1); assert.equal(damage[0].data.damage, 60);
  assert.equal(damage[0].data.pokemonId, before.players[0].active.id);
  assert.equal(damage[0].data.targetId, before.players[1].active.id);
  assert.equal(damage[0].data.contentSource.instanceId, before.players[1].active.stack[0]);
  assert.equal(g.snapshot().players[0].active.counters, 1);
  assert.deepEqual(f.catalog.definition('other'), printed);
  restore(g, f);
});

test('missing target values never coerce null to zero, and a true condition alone does not mark a zero-damage attack performed', async () => {
  const expression = choose(yes(), literal(0), literal(20));
  // Pause before executing any card effect, so the execution flag exposes only
  // the zero damage/true predicate. A full-HP heal correctly creates no prompt.
  const pause = {
    rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE, timing: 'resolve', operations: ['optional', 'draw'],
    validateParameters: (p) => Object.keys(p).length === 0,
    execute: () => [{ op: 'optional', effect: { op: 'draw', count: 1 } }],
  };
  const f = await make(expression, (defs) => install(defs, 'base', expression, [
    binding('fixture:predicate-observation', {}),
  ]), new Map([['fixture:predicate-observation', pause]]));
  const g = battle(f), before = g.snapshot(), handler = f.catalog.handler('cn.damageValue@1');
  // The real formula-handler seam must retain the pure API's explicit-absence
  // contract. Main attack dispatch below supplies an actual opposing target.
  const ctx = { state: before, source: { owner: 0, pokemonId: before.players[0].active.id },
    battleValues: { pokemon: { target: null } } };
  const readMissing = choose(compare(pokemon('target', 'damageCounters'), 'eq', literal(0)), literal(40), literal(20));
  assert.throws(() => handler.damageFormula(ctx, parameters(readMissing)), { code: 'invalid-battle-facts' });
  const guarded = choose(exists('target'), pokemon('target', 'remainingHp'), literal(20));
  assert.equal(handler.damageFormula(ctx, parameters(guarded)), 20);
  assert.throws(() => handler.damageFormula({ ...ctx, battleValues: { pokemon: {} } }, parameters(guarded)),
    { code: 'invalid-battle-facts' }, 'A missing existence fact is not explicit absence.');
  assert.deepEqual(g.snapshot(), before, 'Queries against an absent target cannot change the actual battle.');
  attack(g); assert.equal(g.snapshot().pending.kind, 'optional-effect');
  assert.equal(g.snapshot().attack.execution.performed, false, 'A boolean test is not a performed card effect.');
  assert.deepEqual(packets(g, before.events.length).map((e) => e.data.damage), [0]);
  respond(g, f, ['skip']); settle(g);
  assert.equal(g.snapshot().players[0].active.counters, 0);
  assert.equal(g.snapshot().players[1].active.counters, 0);
  assert.deepEqual(g.snapshot().players[0].hand, before.players[0].hand);
  restore(g, f);
});

test('strict generated schema rejects unknown operations even in skipped branches; invalid final damage rolls back its attack', async () => {
  const handler = createCoreHandlers().get('cn.damageValue@1'); assert(handler);
  assert.equal(handler.timing, 'formula'); assert.deepEqual(handler.operations, []);
  assert.equal(handler.validateParameters, validators.validateDamageValueParameters);
  assert.deepEqual(handler.execute({}, parameters(choose(yes(), literal(20), literal(30)))), []);
  for (const expression of [
    choose(yes(), literal(20), { kind: 'draw', count: 1 }),
    choose(any(yes(), { kind: 'useAbility', abilityId: 'hidden-operation' }), literal(20), literal(30)),
    choose({ kind: 'all', conditions: [] }, literal(20), literal(30)),
    choose({ kind: 'any', conditions: [] }, literal(20), literal(30)),
    choose(compare(literal(0), 'equals', literal(0)), literal(20), literal(30)),
    choose(yes(), literal(20), pokemon('contentSource', 'remainingHp')),
    choose(yes(), literal(20), pokemon('self', 'printedHp')),
    { ...choose(yes(), literal(20), literal(30)), performed: true },
  ]) {
    assert.equal(handler.validateParameters(parameters(expression)), false);
    await assert.rejects(() => make(expression), /Invalid parameters|Invalid normalized card definition/);
  }
  const f = await make(choose(yes(), literal(15), literal(20)), (defs) => {
    defs[0].mechanics.attacks[0].specialRule = 'GX';
  });
  const g = battle(f);
  atomic(g, () => attack(g), (e) => e instanceof TypeError || e instanceof RangeError);
  assert.equal(g.snapshot().players[0].gxUsed, false);
  restore(g, f);
});
