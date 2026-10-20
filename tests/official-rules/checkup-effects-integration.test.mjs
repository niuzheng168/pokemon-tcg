import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { randomIndex } from '../../public/rules/random.js';
import { MAX_BURN_COUNTERS } from '../../public/rules/checkup-effects.js';
import {
  fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached,
} from './fixtures.mjs';

// Synthetic specification fixtures only, NOT approvals of the official examples.
// Contract: cn.burnCounters@1 takes { effect: descriptor }, timing continuous.
const burn = (count = 6, extra = {}) => ({ op: 'burnCounters', scope: 'opponent', count, ...extra });
const burning = (count = 6, extra = {}, id = `burn:${count}`) =>
  binding('cn.burnCounters@1', { effect: burn(count, extra) }, id);
const ability = (id, effects, extra = {}) => ({
  abilityId: id, name: `测试灼伤特性${id}`, mode: 'continuous', usage: null,
  effects, sourceOfTruth: EVIDENCE, ...extra,
});
const aura = (count = 6, extra = {}, id = `aura:${count}`) => ability(id, [burning(count, extra, id)]);
const activated = (id, effects) => ability(id, effects, {
  mode: 'activated', usage: { period: 'unlimited', scope: 'pokemon', key: id, limit: null },
});
const lasting = (count = 6, extra = {}) => ({
  side: 'own', target: 'self', effect: burn(count, { scope: 'all' }),
  duration: 'untilNextOwnTurnEnd', clearOnBench: true, clearOnEvolution: true, ...extra,
});
const remove = (extra = {}) => binding('cn.suppression@1', {
  effect: { op: 'suppression', channel: 'abilities', scope: 'all', ...extra },
}, 'remove');
const TAILS_FIRST = [1, 33554432, 2, 3];
const HEADS_FIRST = [123, 456, 789, 10];
const restore = (g, f) => OfficialGame.restore(JSON.parse(JSON.stringify(g.snapshot())), { catalog: f.catalog });
const use = (g, id) => command(g, {
  type: 'useAbility', abilityId: id, pokemonId: g.snapshot().players[g.snapshot().current].active.id,
});
const putStadium = (s, owner = 0, definitionId = 'stadium') => {
  const id = hand(s, owner, definitionId); s.players[owner].hand.pop(); s.stadium = id; return id;
};
const putTool = (s, owner, definitionId = 'tool') => {
  const id = hand(s, owner, definitionId); s.players[owner].hand.pop(); s.players[owner].active.tools.push(id); return id;
};
const makeActive = (s, owner, mon) => {
  const p = s.players[owner], index = p.bench.findIndex((m) => m.id === mon.id);
  assert(index >= 0);
  p.bench.splice(index, 1); p.bench.push(p.active); p.active = mon;
};
const end = (g) => {
  const before = g.snapshot();
  command(g, { type: 'endTurn' }); settle(g);
  const after = g.snapshot();
  return { before, after, events: after.events.slice(before.events.length) };
};
const aggregation = (events, pokemonId) => events.filter((e) =>
  e.ruleId === 'status.burn' && e.data.pokemonId === pokemonId &&
  e.data.aggregation === 'maximum' && e.data.unit === 'damageCounters');
const burnStatus = (events, pokemonId) => events.filter((e) =>
  e.ruleId === 'status.burn' && e.data.pokemonId === pokemonId && typeof e.data.heads === 'boolean');
const assertBurn = ({ before, after, events }, owner, expected, replacementCount) => {
  const id = before.players[owner].active.id;
  const summaries = aggregation(events, id), statuses = burnStatus(events, id);
  assert.equal(summaries.length, 1, 'One source-aware aggregation record per actually burned Active.');
  assert.equal(statuses.length, 1, 'One recovery coin, not a second status action per source.');
  assert.equal(summaries[0].data.count, expected);
  assert.equal(summaries[0].data.replacements.length, replacementCount);
  assert.equal(summaries[0].data.usedDefault, replacementCount === 0);
  assert.equal(statuses[0].data.counters, expected);
  assert(events.indexOf(summaries[0]) < events.indexOf(statuses[0]), 'Record count derivation before recovery.');
  assert(summaries[0].data.sourceOfTruth.some((s) =>
    s.documentId === 'CN-advanced-3.1.0' && s.section === 'II.E-28' && s.pdfPages.includes(68)));
  const mon = [after.players[owner].active, ...after.players[owner].bench].find((m) => m?.id === id);
  if (mon) assert.equal(mon.counters - before.players[owner].active.counters, expected);
  return summaries[0].data;
};

test('integrated E-28 handler accepts only the reviewed {effect} wrapper and keeps a continuous, source-backed contract', () => {
  const h = createCoreHandlers().get('cn.burnCounters@1');
  assert(h, 'Main integration must register cn.burnCounters@1.');
  assert.equal(h.timing, 'continuous');
  assert.deepEqual(h.operations, ['burnCounters']);
  assert(h.sourceOfTruth.some((s) => s.documentId === 'CN-advanced-3.1.0' &&
    s.section === 'II.E-28' && s.pdfPages.includes(68)));
  for (const count of [0, 1, 4, 6, MAX_BURN_COUNTERS]) {
    const parameters = { effect: burn(count) }, before = structuredClone(parameters);
    assert(h.validateParameters(parameters));
    assert.deepEqual(h.execute({}, parameters), [parameters.effect]);
    assert.deepEqual(parameters, before);
  }
  for (const parameters of [burn(), {}, { effect: burn(), silent: true },
    { effect: burn(MAX_BURN_COUNTERS + 1) }, { effect: burn(-1) }, { effect: burn(6, { group: 'sum' }) }])
    assert(!h.validateParameters(parameters));
});

test('integrated E-28 takes six over four once across multiple Pokémon and records every source without card-count multiplication', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.hp = 1000;
    defs[1].mechanics.abilities = [aura(6), aura(4)];
  });
  const g = board(f, (s) => {
    bench(s, 0, 'other'); bench(s, 0, 'other');
    s.players[1].active.conditions.burned = true; s.rng = [...TAILS_FIRST];
  });
  const snapshot = g.snapshot(), outcome = end(g), summary = assertBurn(outcome, 1, 6, 4);
  assert.equal(summary.selectedIds.length, 2, 'Both six-counter sources remain tied, with no arbitrary winner.');
  assert(summary.replacements.every((r) => r.sourceOfTruth.length));
  assert.equal(outcome.after.players[0].active.counters, 0);
  assert.equal(outcome.after.players[1].active.conditions.burned, true);
  assert.deepEqual(f.catalog.definition('base').mechanics.hp, 1000);
  const replay = OfficialGame.restore(snapshot, { catalog: f.catalog }); end(replay);
  assert.deepEqual(replay.snapshot(), g.snapshot());
});

test('integrated E-28 zero and one are literal replacements, do not apply/cure Burn, and still consume exactly one recovery coin', async () => {
  for (const count of [0, 1]) for (const seed of [TAILS_FIRST, HEADS_FIRST]) {
    const f = await fixture((defs) => { defs[1].mechanics.abilities = [aura(count)]; });
    const g = board(f, (s) => {
      bench(s, 0, 'other'); s.players[1].active.conditions.burned = true; s.rng = [...seed];
    });
    const rng = [...g.snapshot().rng], heads = randomIndex(rng, 2) === 0;
    const outcome = end(g); assertBurn(outcome, 1, count, 1);
    assert.deepEqual(outcome.after.rng, rng);
    assert.equal(outcome.after.players[1].active.conditions.burned, !heads);
    assert.equal(outcome.after.players[0].active.conditions.burned, false);
    assert.equal(aggregation(outcome.events, outcome.before.players[0].active.id).length, 0);
  }
});

test('integrated E-28 no changes means the normal two, while an unburned board does not derive a count or consume RNG', async () => {
  const f = await fixture((defs) => { defs[1].mechanics.abilities = [aura(6)]; });
  const ordinary = board(f, (s) => { s.players[0].active.conditions.burned = true; s.rng = [...TAILS_FIRST]; });
  assertBurn(end(ordinary), 0, 2, 0);
  const unburned = board(f, (s) => { bench(s, 0, 'other'); s.rng = [...TAILS_FIRST]; });
  const outcome = end(unburned);
  assert.deepEqual(outcome.after.rng, outcome.before.rng);
  assert(!outcome.events.some((e) => e.ruleId === 'status.burn'));
});

test('integrated E-28 scopes and Pokémon type filters use actual source ownership, not the ending player', async () => {
  const cases = [
    { sourceOwner: 0, scope: 'own', expected: [6, 2] },
    { sourceOwner: 0, scope: 'opponent', expected: [2, 6] },
    { sourceOwner: 1, scope: 'opponent', expected: [6, 2] },
    { sourceOwner: 1, scope: 'own', expected: [2, 6] },
    { sourceOwner: 0, scope: 'all', expected: [6, 6] },
    { sourceOwner: 0, scope: 'self', expected: [2, 2] },
    { sourceOwner: 0, scope: 'self', sourceIsActive: true, expected: [6, 2] },
    { sourceOwner: 0, scope: 'all', type: 'Fire', expected: [2, 2] },
    { sourceOwner: 0, scope: 'all', type: 'Water', expected: [6, 6] },
  ];
  for (const c of cases) {
    const f = await fixture((defs) => {
      defs[1].mechanics.abilities = [aura(6, { scope: c.scope, activeOnly: true, ...(c.type ? { type: c.type } : {}) })];
    });
    const g = board(f, (s) => {
      const source = bench(s, c.sourceOwner, 'other');
      if (c.sourceIsActive) makeActive(s, c.sourceOwner, source);
      for (const p of s.players) p.active.conditions.burned = true;
      s.rng = [...TAILS_FIRST];
    });
    const outcome = end(g), rng = [...outcome.before.rng];
    randomIndex(rng, 2); randomIndex(rng, 2);
    for (const owner of [0, 1]) assertBurn(outcome, owner, c.expected[owner], Number(c.expected[owner] === 6));
    assert.deepEqual(outcome.after.rng, rng);
  }
});

test('integrated E-28 sourceActive is live: a real Retreat to the Bench removes the aura without deleting or using its Ability', async () => {
  const f = await fixture((defs) => { defs[1].mechanics.abilities = [aura(6, { sourceActive: true, activeOnly: true })]; });
  const g = board(f, (s) => {
    makeActive(s, 0, bench(s, 0, 'other'));
    attached(s, 0, s.players[0].active, 'water');
    s.players[1].active.conditions.burned = true; s.rng = [...TAILS_FIRST];
  });
  const activeBranch = restore(g, f); assertBurn(end(activeBranch), 1, 6, 1);
  const sourceId = g.snapshot().players[0].active.id;
  command(g, { type: 'retreat' }); settle(g);
  assert(g.snapshot().players[0].bench.some((m) => m.id === sourceId));
  const outcome = end(g); assertBurn(outcome, 1, 2, 0);
  const source = outcome.after.players[0].bench.find((m) => m.id === sourceId);
  assert(source);
  assert.deepEqual(source.used, {});
});

test('integrated E-28 suppression removes only live Ability sources, and replacing the suppression Stadium restores the count', async () => {
  const f = await fixture((defs) => {
    defs[1].mechanics.abilities = [aura(6)];
    defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [remove()];
    defs.find((d) => d.definitionId === 'potion').mechanics = { category: 'stadium', effects: [] };
  });
  const g = board(f, (s) => {
    bench(s, 0, 'other'); putStadium(s); hand(s, 0, 'potion');
    s.players[1].active.conditions.burned = true; s.rng = [...TAILS_FIRST];
  });
  const blocked = restore(g, f); assertBurn(end(blocked), 1, 2, 0);
  const play = g.view(0).legalActions.find((a) => a.type === 'playTrainer' &&
    g.snapshot().cards[a.cardId].definitionId === 'potion');
  assert(play); command(g, play); settle(g);
  assertBurn(end(g), 1, 6, 1);
});

test('integrated E-28 Ability and Tool sources have independent suppression channels; discarded source Pokémon stop contributing', async () => {
  for (const channel of ['abilities', 'tools']) {
    const f = await fixture((defs) => {
      defs[1].mechanics.abilities = [aura(6)];
      defs.find((d) => d.definitionId === 'tool').mechanics.effects = [burning(4)];
      defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [remove({ channel })];
    });
    const g = board(f, (s) => {
      bench(s, 0, 'other'); putTool(s, 0); putStadium(s);
      s.players[1].active.conditions.burned = true; s.rng = [...TAILS_FIRST];
    });
    assertBurn(end(g), 1, channel === 'abilities' ? 4 : 6, 1);
  }
  const f = await fixture((defs) => {
    defs[1].mechanics.abilities = [aura(6)];
    defs[0].mechanics.abilities = [activated('remove-source', [
      binding('cn.counters@1', { side: 'own', target: 'any', count: 10 }, 'remove-source'),
    ])];
  });
  const g = board(f, (s) => {
    bench(s, 0, 'other'); s.players[1].active.conditions.burned = true; s.rng = [...TAILS_FIRST];
  });
  const source = g.snapshot().players[0].bench[0];
  use(g, 'remove-source'); answer(g, [source.id]); settle(g);
  assert(g.snapshot().players[0].discard.includes(source.stack.at(-1)));
  assertBurn(end(g), 1, 2, 0);
});

test('integrated E-28 also accepts intrinsic, attached Energy, Tool and shared Stadium continuous sources', async () => {
  for (const kind of ['rule', 'energy', 'tool', 'stadium']) {
    const f = await fixture((defs) => {
      const definitionId = { rule: 'other', energy: 'double', tool: 'tool', stadium: 'stadium' }[kind];
      defs.find((d) => d.definitionId === definitionId).mechanics.effects = [burning(6)];
    });
    const g = board(f, (s) => {
      if (kind === 'rule') bench(s, 0, 'other');
      if (kind === 'energy') attached(s, 0, s.players[0].active, 'double');
      if (kind === 'tool') putTool(s, 0);
      if (kind === 'stadium') putStadium(s);
      s.players[1].active.conditions.burned = true; s.rng = [...TAILS_FIRST];
    });
    assertBurn(end(g), 1, 6, 1);
  }
});

test('integrated E-28 fixed-target lasting effects survive source Retreat/suppression and resume an actual pending target choice', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.abilities = [activated('lasting-burn', [
      binding('cn.lasting@1', lasting(6, { side: 'opponent', target: 'active' }), 'lasting-burn'),
    ])];
    defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [remove()];
  });
  let g = board(f, (s) => {
    bench(s, 0, 'other'); attached(s, 0, s.players[0].active, 'water'); hand(s, 0, 'stadium');
    s.players[1].active.conditions.burned = true; s.rng = [...TAILS_FIRST];
  });
  const sourceId = g.snapshot().players[0].active.id, targetId = g.snapshot().players[1].active.id;
  use(g, 'lasting-burn'); assert(g.snapshot().pending);
  g = restore(g, f); settle(g);
  const entry = g.snapshot().ongoing[0]; assert.equal(entry.targetId, targetId);
  command(g, { type: 'retreat' }); settle(g);
  assert(g.snapshot().players[0].bench.some((m) => m.id === sourceId));
  command(g, g.view(0).legalActions.find((a) => a.type === 'playTrainer' &&
    g.snapshot().cards[a.cardId].definitionId === 'stadium')); settle(g);
  assert.equal(g.snapshot().ongoing[0].targetId, targetId);
  assert.equal(g.snapshot().ongoing[0].source.pokemonId, sourceId);
  assertBurn(end(g), 1, 6, 1);
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
});

test('integrated E-28 timed counter replacements include only until-end checkups, not next-turn-only windows', async () => {
  for (const duration of ['nextOwnTurn', 'nextOpponentTurn', 'untilNextOwnTurnEnd', 'untilNextOpponentTurnEnd']) {
    const f = await fixture((defs) => {
      defs[0].mechanics.hp = 1000;
      defs[0].mechanics.abilities = [activated('lasting-burn', [
        binding('cn.lasting@1', lasting(6, { duration }), 'lasting-burn'),
      ])];
    });
    let g = board(f, (s) => { s.players[0].active.conditions.burned = true; s.rng = [...TAILS_FIRST]; });
    use(g, 'lasting-burn'); settle(g);
    const untilEnd = duration.startsWith('until');
    for (let i = 0; i < 3; i++) {
      const expected = untilEnd && (duration === 'untilNextOwnTurnEnd' || i < 2) ? 6 : 2;
      const outcome = end(g); assertBurn(outcome, 0, expected, Number(expected === 6));
      g = restore(g, f);
    }
    assert.equal(g.snapshot().ongoing.length, 0);
  }
});

test('integrated E-28 target evolution and Retreat clear only the declared lasting effect and never persist a mutable Burn count on the card', async () => {
  for (const transition of ['retreat', 'evolve']) {
    const f = await fixture((defs) => {
      defs[0].mechanics.abilities = [activated('lasting-burn', [
        binding('cn.lasting@1', lasting(6), 'lasting-burn'),
      ])];
    });
    let g = board(f, (s) => {
      bench(s, 0, 'other'); attached(s, 0, s.players[0].active, 'water'); hand(s, 0, 'evolution');
      s.players[0].active.conditions.burned = true; s.rng = [...TAILS_FIRST];
    });
    use(g, 'lasting-burn'); settle(g);
    assert.equal(g.snapshot().ongoing.length, 1);
    if (transition === 'retreat') { command(g, { type: 'retreat' }); settle(g); }
    else command(g, g.view(0).legalActions.find((a) => a.type === 'evolve'));
    assert.equal(g.snapshot().ongoing.length, 0);
    assert.equal(g.snapshot().players[0].active.conditions.burned, false);
    const s = g.snapshot(); s.players[0].active.conditions.burned = true;
    g = OfficialGame.restore(s, { catalog: f.catalog });
    assertBurn(end(g), 0, 2, 0);
    assert(!Object.hasOwn(f.catalog.definition('base').mechanics, 'burnCounters'));
    assert(!Object.hasOwn(g.snapshot().players[0].active, 'burnCounters'));
  }
});

test('integrated E-28 Burn replacement is independent of existing attack damage/effect immunity and adds no attack-damage reaction', async () => {
  const f = await fixture((defs) => {
    defs[1].mechanics.abilities = [aura(6)];
    defs[0].mechanics.effects = ['damage', 'effects'].map((channel) => binding('cn.protection@1', {
      effect: { op: 'protection', useRule: 'ordinary', channel, scope: 'self', from: 'all', categories: ['attack'] },
    }, `protect:${channel}`));
  });
  const g = board(f, (s) => {
    bench(s, 0, 'other'); s.players[1].active.conditions.burned = true; s.rng = [...TAILS_FIRST];
  });
  const outcome = end(g); assertBurn(outcome, 1, 6, 1);
  assert(!outcome.events.some((e) => e.ruleId === 'trigger.damage'));
  assert(!outcome.events.some((e) => e.ruleId === 'effects.protection'));
});

test('integrated E-28 both lethal Burns and both Sleep coins finish before KO/victory; a recovering Pokémon still received the full count', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [burning(6, { scope: 'all' })];
  });
  const g = board(f, (s) => {
    putStadium(s);
    for (const p of s.players) {
      p.active.counters = 4; p.active.conditions.burned = true; p.active.conditions.rotation = 'asleep';
    }
    s.rng = [...HEADS_FIRST];
  });
  const before = g.snapshot(), rng = [...before.rng];
  const burnCoins = [randomIndex(rng, 2) === 0, randomIndex(rng, 2) === 0];
  const sleepCoins = [randomIndex(rng, 2) === 0, randomIndex(rng, 2) === 0];
  const outcome = end(g);
  for (const owner of [0, 1]) {
    assertBurn(outcome, owner, 6, 1);
    assert.equal(burnStatus(outcome.events, before.players[owner].active.id)[0].data.heads, burnCoins[owner]);
  }
  const statusEvents = outcome.events.filter((e) =>
    (e.ruleId === 'status.burn' || e.ruleId === 'status.sleep') && typeof e.data.heads === 'boolean');
  assert.deepEqual(statusEvents.map((e) => [e.ruleId, e.data.pokemonId]), [
    ...[0, 1].map((p) => ['status.burn', before.players[p].active.id]),
    ...[0, 1].map((p) => ['status.sleep', before.players[p].active.id]),
  ]);
  assert.deepEqual(statusEvents.slice(2).map((e) => e.data.heads), sleepCoins);
  const firstKO = outcome.events.findIndex((e) => e.ruleId === 'ko.boundary' && e.data.kind === 'latched');
  assert(firstKO > outcome.events.indexOf(statusEvents.at(-1)));
  assert.deepEqual(outcome.after.rng, rng);
  assert.deepEqual(outcome.after.result, { winner: null, reason: 'simultaneous' });
});
