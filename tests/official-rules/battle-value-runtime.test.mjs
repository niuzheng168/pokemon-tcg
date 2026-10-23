// Real OfficialGame integration with SYNTHETIC definitions/printings only.
// Neither a Zygarde-shaped formula nor a successful fixture approves a card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import {
  fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached,
} from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const lit = (value) => ({ kind: 'literal', value });
const stat = (field, who = 'self') => ({ kind: 'pokemon', who, field });
const add = (...terms) => ({ kind: 'add', terms });
const sub = (left, right) => ({ kind: 'subtract', left, right });
const mul = (left, right) => ({ kind: 'multiply', left, right });
const formula = (expression, id = 'native-value') => binding('cn.damageValue@1', { expression }, id);
const packet = (amount, extra = {}) => ({
  side: 'opponent', target: 'bench', amount, selection: { kind: 'exact', count: 1 }, options: {}, ...extra,
});
const restore = (game, f) => OfficialGame.restore(clone(game.snapshot()), { catalog: f.catalog });
const attack = (game) => command(game, { type: 'attack', attackId: 'base:strike' });
const damageEvents = (game, from) => game.snapshot().events.slice(from).filter((e) =>
  e.ruleId === 'attack.order' && Object.hasOwn(e.data, 'damage'));
const counters = (s, owner, id) => [s.players[owner].active, ...s.players[owner].bench]
  .find((m) => m.id === id).counters;
function otherActive(s) {
  const p = s.players[1], old = p.active;
  p.hand.push(...old.stack, ...old.energy, ...old.tools);
  p.active = bench(s, 1, 'other'); p.bench.pop();
  return p.active;
}
function hold(s, owner, mon, name = 'tool') {
  const id = hand(s, owner, name); s.players[owner].hand.pop(); mon.tools.push(id); return id;
}
function remaining(s, owner, count) {
  const p = s.players[owner];
  if (p.prizes.length > count) p.hand.push(...p.prizes.splice(count));
  while (p.prizes.length < count) p.prizes.push(p.deck.pop());
}
async function make(transform = () => {}, extraHandlers = new Map()) {
  return fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) {
      d.mechanics.hp = 500; d.mechanics.weakness = null; d.mechanics.resistance = null;
    }
    transform(defs);
  }, extraHandlers);
}
function assertAtomic(game, callback, error = undefined) {
  const before = game.snapshot(), views = [game.view(0), game.view(1)];
  assert.throws(callback, error);
  assert.deepEqual(game.snapshot(), before, 'no damage, facts, quota, events, RNG, work or revision may partially commit');
  assert.deepEqual([game.view(0), game.view(1)], views);
}

test('one explicit native formula executes for null/fixed/plus/minus/times printed damage without forging the printed attack', async () => {
  const h = createCoreHandlers().get('cn.damageValue@1');
  assert(h); assert.equal(h.timing, 'formula');
  assert(h.capabilities.includes('resolve-attack-damage')); assert.deepEqual(h.operations, []);
  assert(h.validateParameters({ expression: lit(60) }));
  assert.deepEqual(h.execute({}, { expression: lit(60) }), []);
  for (const printedDamage of [null, { value: 20, operator: 'fixed' },
    { value: 10, operator: 'plus' }, { value: 80, operator: 'minus' }, { value: 30, operator: 'times' }]) {
    const f = await make((defs) => {
      const a = defs[0].mechanics.attacks[0];
      a.printedDamage = clone(printedDamage); a.effects = [formula(lit(60))];
    });
    const g = board(f, (s) => { otherActive(s); attached(s, 0, s.players[0].active, 'water'); });
    const before = g.snapshot(), printed = clone(f.catalog.definition('base'));
    attack(g); settle(g);
    assert.equal(g.snapshot().players[1].active.counters, 6);
    assert.deepEqual(damageEvents(g, before.events.length).map((e) => e.data.damage), [60]);
    assert.deepEqual(f.catalog.definition('base'), printed);
    assert.deepEqual(printed.mechanics.attacks[0].printedDamage, printedDamage);
    assert.deepEqual(g.snapshot().cards, before.cards);
  }
  // Both native/native and native/legacy ambiguity must reject, even with a
  // fixed printed number. Do not require a particular rejection phase.
  for (const second of [formula(lit(70), 'second-value'),
    binding('cn.prizeDamage@1', { side: 'own', perPrize: 10, base: 10 }, 'second-prize-formula')]) {
    await assert.rejects(async () => {
      const f = await make((defs) => {
        defs[0].mechanics.attacks[0].effects = [formula(lit(60)), second];
      });
      const g = board(f, (s) => attached(s, 0, s.players[0].active, 'water')), before = g.snapshot();
      try { attack(g); } catch (e) { assert.deepEqual(g.snapshot(), before); throw e; }
    }, /formula/i);
  }
});

test('native formula reads current maximum/remaining HP, damage counters, retreat Energy and distinct physical-card/provided-unit counts', async () => {
  const expression = add(
    stat('remainingHp'), stat('maximumHp'), lit(-100),
    mul(stat('damageCounters'), lit(10)), mul(stat('energyCards'), lit(10)),
    mul(stat('energyUnits'), lit(10)), mul(stat('retreatEnergy'), lit(10)),
  );
  const f = await make((defs) => {
    defs[0].mechanics.hp = 100; defs[0].mechanics.retreatCost = 2;
    const a = defs[0].mechanics.attacks[0]; a.cost = ['Colorless']; a.printedDamage = null; a.effects = [formula(expression)];
    defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [
      binding('cn.modifier@1', { field: 'retreat', amount: 1, scope: 'own' }),
    ];
  });
  const g = board(f, (s) => {
    otherActive(s); attached(s, 0, s.players[0].active, 'double'); hold(s, 0, s.players[0].active, 'hp-tool');
    s.players[0].active.counters = 2;
    const id = hand(s, 0, 'stadium'); s.players[0].hand.pop(); s.stadium = id;
  });
  const before = g.snapshot(), effective = g.view(0).players[0].active.effective;
  assert.equal(effective.maxHp, 150); assert.equal(effective.currentHp, 130); assert.equal(effective.retreatCost, 3);
  assert.equal(before.players[0].active.energy.length, 1); assert.equal(effective.energies[0].units.length, 2);
  attack(g); settle(g);
  // Independent oracle, in explicit units: 130 + 150 - 100 + 20 + 10 + 20 + 30.
  assert.equal(g.snapshot().players[1].active.counters, 26);
  assert.deepEqual(damageEvents(g, before.events.length).map((e) => e.data.damage), [260]);
  assert.equal(f.catalog.definition('base').mechanics.hp, 100);
  assert.deepEqual(f.catalog.definition('base').mechanics.attacks[0].printedDamage, null);
  assert.deepEqual(f.catalog.definition('double').mechanics.baseUnits, [['Colorless'], ['Colorless']]);
  assert.deepEqual(g.snapshot().players[0].active.energy, before.players[0].active.energy);
});

test('body ValueExpr evaluates the selected Bench target, not the Active; a restored choice applies only one damage packet', async () => {
  const amount = add(mul(stat('damageCounters', 'target'), lit(10)), lit(10));
  const f = await make((defs) => {
    defs[0].mechanics.attacks[0].printedDamage = null;
    defs[0].mechanics.attacks[0].effects = [binding('cn.damage@1', packet(amount))];
    for (const d of defs.filter((d) => d.kind === 'pokemon'))
      d.mechanics.weakness = { type: 'Water', operation: 'multiply', value: 2 };
  });
  for (const choice of [0, 1]) {
    let ids;
    let g = board(f, (s) => {
      otherActive(s); attached(s, 0, s.players[0].active, 'water');
      const a = bench(s, 1, 'base'), b = bench(s, 1, 'other');
      a.counters = 2; b.counters = 5; ids = [a.id, b.id];
    });
    const before = g.snapshot(); attack(g);
    assert.equal(g.snapshot().pending.kind, 'damage-targets');
    assert(!g.snapshot().pending.options.includes(before.players[1].active.id));
    g = restore(g, f); answer(g, [ids[choice]]); settle(g);
    const after = g.snapshot(), expectedDamage = choice === 0 ? 30 : 60;
    assert.equal(counters(after, 1, ids[choice]), (choice === 0 ? 2 : 5) + expectedDamage / 10);
    assert.equal(counters(after, 1, ids[1 - choice]), choice === 0 ? 5 : 2);
    assert.equal(after.players[1].active.counters, 0);
    assert.deepEqual(damageEvents(g, before.events.length).map((e) => e.data.damage), [0, expectedDamage],
      'Bench Weakness must not double the calculated packet');
    assert.deepEqual(restore(g, f).snapshot(), after);
  }
});

test('all-target recoil expressions are evaluated against the same pre-batch state before any selected Pokémon receives damage', async () => {
  const f = await make((defs) => {
    defs[0].mechanics.attacks[0].printedDamage = null;
    defs[0].mechanics.attacks[0].effects = [binding('cn.recoilDamage@1', packet(
      mul(add(stat('damageCounters'), stat('damageCounters', 'target')), lit(10)),
      { side: 'own', target: 'any', selection: { kind: 'all' } },
    ))];
  });
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water'); s.players[0].active.counters = 1;
    bench(s, 0, 'other').counters = 2; bench(s, 0, 'other').counters = 3;
  });
  const before = g.snapshot(), ownIds = [before.players[0].active, ...before.players[0].bench].map((m) => m.id);
  attack(g); settle(g);
  assert.deepEqual(ownIds.map((id) => counters(g.snapshot(), 0, id)), [3, 5, 7],
    'source counters stay 1 for all evaluations, not 3 after the first recoil packet');
  assert.deepEqual(damageEvents(g, before.events.length).map((e) => e.data.damage), [0, 20, 30, 40]);
});

test('C-18 native formula and body self-value use the actual copier damage/Energy, retaining the foreign attack printed damage and provenance', async () => {
  const f = await make((defs) => {
    const a = defs[0].mechanics.attacks[0]; a.printedDamage = null; a.cost = ['Colorless'];
    a.effects = [binding('cn.copyAttack@1', {
      op: 'copyAttack', origins: [{ side: 'opponent', zone: 'active', selector: { kind: 'pokemon', nameKeys: ['other'] } }],
      excludeUser: false, coin: 'none', energy: 'ignore', special: { mode: 'needsRuling', sourceOfTruth: EVIDENCE },
    })];
    const borrowed = defs[1].mechanics.attacks[0];
    borrowed.printedDamage = { value: 200, operator: 'fixed' }; borrowed.cost = ['Fire', 'Fire', 'Fire'];
    borrowed.effects = [
      formula(mul(add(stat('damageCounters'), stat('energyCards'), stat('energyUnits')), lit(10))),
      binding('cn.recoilDamage@1', packet(mul(stat('damageCounters'), lit(10)),
        { side: 'own', target: 'self', selection: { kind: 'all' } })),
    ];
  });
  let g = board(f, (s) => {
    otherActive(s).counters = 8; attached(s, 0, s.players[0].active, 'double'); s.players[0].active.counters = 2;
  });
  const before = g.snapshot(), actor = before.players[0].active, content = before.players[1].active.stack.at(-1);
  attack(g); assert.equal(g.snapshot().pending.kind, 'copy-attack');
  const option = g.view(0).pending.attacks.find((a) => a.attackId === 'other:strike');
  assert(option); assert.deepEqual(option.printedDamage, { value: 200, operator: 'fixed' });
  g = restore(g, f); answer(g, [option.optionId]); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 13, '(actual counters2 + Energy cards1 + units2) × 10 = 50');
  assert.equal(g.snapshot().players[0].active.counters, 4, '20 recoil belongs to the actual user, not the copied content holder');
  const outgoing = damageEvents(g, before.events.length).find((e) => e.data.damage === 50);
  assert(outgoing); assert.equal(outgoing.data.pokemonId, actor.id);
  assert.equal(outgoing.data.contentSource.instanceId, content); assert.equal(outgoing.data.player, 0);
  assert.equal(g.snapshot().players[0].active.facts.lastUsedAttack.attackId, 'base:strike');
  assert.deepEqual(f.catalog.definition('other').mechanics.attacks[0].printedDamage, { value: 200, operator: 'fixed' });
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
});

test('prize AST uses reviewed effect-time counts for each side and propagates needs-ruling rather than a numeric zero', async () => {
  const expression = add(lit(20),
    mul({ kind: 'prizes', side: 'own' }, lit(30)), mul({ kind: 'prizes', side: 'opponent' }, lit(10)));
  const f = await make((defs) => {
    defs[0].mechanics.attacks[0].effects = [formula(expression)];
    defs[0].mechanics.attacks[0].specialRule = 'VSTAR';
  });
  const resolved = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water'); remaining(s, 0, 4); remaining(s, 1, 5);
  });
  attack(resolved); settle(resolved);
  assert.equal(resolved.snapshot().players[1].active.counters, 9, '20 + 2×30 + 1×10');
  for (const side of [0, 1]) {
    const unresolved = board(f, (s) => {
      attached(s, 0, s.players[0].active, 'water'); remaining(s, side, 1); s.matchMode = 'tiebreak';
    });
    assertAtomic(unresolved, () => attack(unresolved), (e) => e.code === 'needs-ruling' && e.needsRuling === true);
    assert.equal(unresolved.snapshot().players[0].vstarUsed, false);
    // Seven Prizes in a normal game: none taken (JP Q&A), the other side's count unchanged.
    const extra = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); remaining(s, side, 7); remaining(s, 1 - side, 6); });
    attack(extra); settle(extra);
    assert.equal(extra.snapshot().players[1].active.counters, 2, '20 + 0×30 + 0×10');
  }
});

test('only the final expression clamps negative damage to zero; a zero base cannot be resurrected by an attached attack-damage Tool', async () => {
  for (const expression of [lit(0), sub(lit(10), lit(30)), sub(add(lit(-30), lit(50)), lit(20))]) {
    const f = await make((defs) => {
      defs[0].mechanics.attacks[0].effects = [formula(expression)];
    });
    const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); hold(s, 0, s.players[0].active); });
    const before = g.snapshot(); attack(g); settle(g);
    assert.equal(g.snapshot().players[1].active.counters, 0);
    const packets = damageEvents(g, before.events.length);
    assert.deepEqual(packets.map((e) => e.data.damage), [0]);
    assert(packets[0].data.calculation.some((step) => step.ruleId === 'damage.zero'));
    assert.equal(f.catalog.definition('base').mechanics.attacks[0].printedDamage.value, 20);
  }
});

test('fractional syntax, non-ten-point damage and final overflow reject without partial counters, quota, events or RNG, including a batch later-target failure', async () => {
  const h = createCoreHandlers().get('cn.damageValue@1');
  for (const value of [0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert(!h.validateParameters({ expression: lit(value) }));
  for (const expression of [lit(11), mul(lit(Number.MAX_SAFE_INTEGER), lit(10))]) {
    const f = await make((defs) => {
      defs[0].mechanics.attacks[0].effects = [formula(expression)]; defs[0].mechanics.attacks[0].specialRule = 'GX';
    });
    const g = board(f, (s) => attached(s, 0, s.players[0].active, 'water'));
    assertAtomic(g, () => attack(g), (e) => ['invalid-damage-value', 'numeric-overflow'].includes(e.code));
    assert.equal(g.snapshot().players[0].gxUsed, false);
  }
  const f = await make((defs) => {
    defs[0].mechanics.attacks[0].printedDamage = null;
    defs[0].mechanics.attacks[0].effects = [binding('cn.damage@1', packet(
      mul(lit(Number.MAX_SAFE_INTEGER), stat('damageCounters', 'target')), { selection: { kind: 'all' } },
    ))];
  });
  const g = board(f, (s) => {
    otherActive(s); attached(s, 0, s.players[0].active, 'water');
    bench(s, 1, 'base').counters = 0; bench(s, 1, 'other').counters = 2;
  });
  assertAtomic(g, () => attack(g), { code: 'numeric-overflow' });
});

test('restore at a selected-body-damage prompt does not rerun the native primary formula or duplicate any damage packet', async () => {
  const f = await make((defs) => {
    const a = defs[0].mechanics.attacks[0]; a.printedDamage = null;
    a.effects = [formula(lit(40)), binding('cn.damage@1', packet(
      add(lit(20), mul(stat('damageCounters', 'target'), lit(10))),
    ))];
  });
  let selected;
  const g = board(f, (s) => {
    otherActive(s); attached(s, 0, s.players[0].active, 'water'); bench(s, 1, 'base').counters = 1;
    const target = bench(s, 1, 'other'); target.counters = 3; selected = target.id;
  });
  const before = g.snapshot(); attack(g);
  assert.equal(g.snapshot().pending.kind, 'damage-targets');
  assert.equal(g.snapshot().players[1].active.counters, 4, 'primary has already executed before saving the body choice');
  const saved = g.snapshot(), resumed = restore(restore(g, f), f);
  assertAtomic(resumed, () => answer(resumed, []));
  for (const game of [g, resumed]) { answer(game, [selected]); settle(game); }
  assert.deepEqual(resumed.snapshot(), g.snapshot());
  assert.equal(g.snapshot().players[1].active.counters, 4);
  assert.equal(counters(g.snapshot(), 1, selected), 8);
  assert.deepEqual(damageEvents(g, before.events.length).map((e) => e.data.damage), [40, 50]);
  assert.equal(g.snapshot().turn, before.turn + 1);
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  assertAtomic(g, () => command(g, { type: 'answer', requestId: saved.pending.id, selected: [selected] }));
});

test('after before-damage switching, self remains the declared user while ownActive means the new Active Pokémon', async () => {
  const beforeSwitch = {
    rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE, timing: 'beforeDamage', operations: ['switch'],
    validateParameters: (p) => Object.keys(p).length === 0,
    execute: () => [{ op: 'switch', side: 'own', chooser: 'self', affected: 'active' }],
  };
  const f = await make((defs) => {
    defs[0].mechanics.attacks[0].effects = [
      binding('fixture:before-switch', {}),
      formula(mul(add(stat('damageCounters'), stat('damageCounters', 'ownActive')), lit(10))),
    ];
  }, new Map([['fixture:before-switch', beforeSwitch]]));
  let replacement;
  let g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water'); s.players[0].active.counters = 2;
    const m = bench(s, 0, 'other'); m.counters = 5; replacement = m.id;
  });
  const before = g.snapshot(), userId = before.players[0].active.id;
  attack(g); assert.equal(g.snapshot().pending.kind, 'effect-target');
  g = restore(g, f); answer(g, [replacement]); settle(g);
  assert.equal(g.snapshot().players[0].active.id, replacement);
  assert.equal(g.snapshot().players[1].active.counters, 7, '(actual user2 + new Active5) × 10');
  const user = g.snapshot().players[0].bench.find((m) => m.id === userId);
  assert.equal(user.facts.lastUsedAttack.attackId, 'base:strike');
  assert.deepEqual(user.energy, before.players[0].active.energy);
});

test('ordinary Bench damage reads stage-4 pre-primary HP, including across a saved damage-target choice', async () => {
  const amount = add(
    sub(stat('maximumHp', 'opponentActive'), stat('remainingHp', 'opponentActive')),
    mul(stat('damageCounters', 'target'), lit(10)),
  );
  const f = await make((defs) => {
    defs[0].mechanics.attacks[0].effects = [
      formula(lit(40)),
      binding('cn.damage@1', packet(amount)),
    ];
  });
  let chosen;
  const g = board(f, (s) => {
    otherActive(s).counters = 2;
    attached(s, 0, s.players[0].active, 'water');
    bench(s, 1, 'base');
    const m = bench(s, 1, 'other'); m.counters = 3; chosen = m.id;
  });
  const before = g.snapshot();
  attack(g);
  const pending = g.snapshot();
  assert.equal(pending.pending.kind, 'damage-targets');
  assert.equal(pending.players[1].active.counters, 6, 'primary 40 has already been written to the live board');
  assert.equal(g.view(0).players[1].active.effective.currentHp, 440);
  const model = pending.attack.damageModels.find((m) => m.targetId === chosen);
  assert(model);
  assert.equal(model.battleValues.pokemon.opponentActive.remainingHp, 480,
    'ordinary Bench damage belongs to the shared step-4 snapshot, not a post-primary HP query');
  assert.equal(model.battleValues.pokemon.target.damageCounters, 3);
  const resumed = restore(restore(g, f), f);
  for (const game of [g, resumed]) { answer(game, [chosen]); settle(game); }
  assert.deepEqual(resumed.snapshot(), g.snapshot());
  assert.equal(g.snapshot().players[1].active.counters, 6);
  assert.equal(counters(g.snapshot(), 1, chosen), 8, '(500 - pre-primary480) + target3×10 = 50, not live90');
  assert.deepEqual(damageEvents(g, before.events.length).map((e) => e.data.damage), [40, 50]);
});

test('ordinary recoil and later Bench damage share step-4 facts: neither primary damage nor earlier recoil changes their AST bases', async () => {
  const handlers = createCoreHandlers();
  assert.equal(handlers.get('cn.damage@1').timing, 'damage');
  assert.equal(handlers.get('cn.recoilDamage@1').timing, 'damage');
  const f = await make((defs) => {
    defs[0].mechanics.attacks[0].effects = [
      formula(lit(40)),
      binding('cn.recoilDamage@1', packet(
        sub(stat('maximumHp', 'opponentActive'), stat('remainingHp', 'opponentActive')),
        { side: 'own', target: 'self', selection: { kind: 'all' } },
      ), 'stage4-recoil'),
      binding('cn.damage@1', packet(
        mul(stat('damageCounters'), lit(10)), { selection: { kind: 'all' } },
      ), 'stage4-bench'),
    ];
  });
  let target;
  const g = board(f, (s) => {
    otherActive(s).counters = 2;
    attached(s, 0, s.players[0].active, 'water'); s.players[0].active.counters = 1;
    target = bench(s, 1, 'base').id;
  });
  const before = g.snapshot();
  attack(g); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 6);
  assert.equal(g.snapshot().players[0].active.counters, 3, 'recoil is pre-primary20, not post-primary60');
  assert.equal(counters(g.snapshot(), 1, target), 1, 'later Bench base is pre-recoil10, not post-recoil30');
  assert.deepEqual(damageEvents(g, before.events.length).map((e) => e.data.damage), [40, 20, 10]);
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
});
