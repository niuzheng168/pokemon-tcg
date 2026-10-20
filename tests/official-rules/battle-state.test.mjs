import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDefinitionShape } from '../../public/rules/card-schema.js';
import { OfficialGame } from '../../public/rules/game.js';
import { createPlayerOngoingEffect, assertPlayerOngoingEffect } from '../../public/rules/ongoing.js';
import { validateRestrictionParameters, validateLastingParameters, validateLastingPlayerParameters,
  validateModifierParameters } from '../../public/rules/schema-validators.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const ability = (id, effects, mode = 'activated') => ({
  abilityId: id, name: `测试${id}`, mode, usage: mode === 'continuous' ? null :
    { period: 'unlimited', scope: 'pokemon', key: id, limit: null }, effects, sourceOfTruth: EVIDENCE,
});
const lasting = (effect, extra = {}) => ({
  side: 'own', target: 'self', effect, duration: 'nextOwnTurn',
  clearOnBench: true, clearOnEvolution: true, ...extra,
});
const restriction = (actions, extra = {}) => ({ op: 'restriction', scope: 'all', actions, ...extra });
const playerLock = (actions, extra = {}) => ({
  side: 'opponent', effect: { op: 'playerRestriction', scope: 'all', actions }, duration: 'nextOpponentTurn', ...extra,
});
const use = (g, id) => {
  command(g, { type: 'useAbility', pokemonId: g.snapshot().players[0].active.id, abilityId: id }); settle(g);
};
const end = (g) => { command(g, { type: 'endTurn' }); settle(g); };
const has = (g, type, player = g.snapshot().current) => g.view(player).legalActions.some((a) => a.type === type);
const restore = (g, f) => OfficialGame.restore(JSON.parse(JSON.stringify(g.snapshot())), { catalog: f.catalog });
const trainer = (g, definitionId) => g.view(g.snapshot().current).legalActions.find((a) =>
  a.type === 'playTrainer' && g.snapshot().cards[a.cardId].definitionId === definitionId);

test('printed HP is immutable; damage, healing, Tools and evolution only change state or derived HP', async () => {
  const f = await fixture(), printed = structuredClone(f.catalog.definition('base'));
  const g = board(f, (s) => {
    s.players[0].active.counters = 3;
    bench(s, 0, 'base'); hand(s, 0, 'hp-tool'); hand(s, 0, 'potion'); hand(s, 0, 'evolution');
  });
  const activeId = g.snapshot().players[0].active.id;
  const { attackRequirements, ...stats } = g.view(0).players[0].active.effective;
  assert.equal(attackRequirements[0].routes[0].counts.Water, 1);
  assert.equal(attackRequirements[0].routes[0].total, 1);
  assert.deepEqual(stats, {
    maxHp: 100, currentHp: 70, retreatCost: 1,
    weakness: { type: 'Fire', operation: 'multiply', value: 2 }, resistance: null,
    types: ['Water'], typeChanges: [], abilities: [], toolEffects: [], energies: [],
  });
  assert.equal(g.view(0).players[0].bench[0].effective.currentHp, 100, 'Same definition, independent damage.');
  assert.equal(g.view(0).players[1].active.effective.currentHp, 100, 'An opponent instance is independent too.');
  command(g, trainer(g, 'hp-tool')); answer(g, [activeId]);
  assert.equal(g.view(0).players[0].active.effective.maxHp, 150);
  assert.equal(g.view(0).players[0].active.effective.currentHp, 120);
  const removed = g.snapshot(), tool = removed.players[0].active.tools.pop();
  removed.players[0].discard.push(tool);
  const withoutTool = OfficialGame.restore(removed, { catalog: f.catalog });
  assert.equal(withoutTool.view(0).players[0].active.effective.currentHp, 70, 'Losing maximum HP is not healing.');
  command(g, g.view(0).legalActions.find((a) => a.type === 'evolve' && a.pokemonId === activeId));
  assert.equal(g.snapshot().players[0].active.counters, 3, 'Evolution carries damage, not a copied remaining HP.');
  assert.equal(g.view(0).players[0].active.effective.maxHp, 200);
  assert.equal(g.view(0).players[0].active.effective.currentHp, 170);
  command(g, trainer(g, 'potion')); answer(g, [activeId]);
  assert.equal(g.snapshot().players[0].active.counters, 0);
  assert.equal(g.view(0).players[0].active.effective.currentHp, 200);
  assert.deepEqual(f.catalog.definition('base'), printed);
  assert.equal(f.catalog.definition('evolution').mechanics.hp, 150);
  assert.throws(() => { f.catalog.definition('base').mechanics.hp = 70; }, TypeError);
  assert.deepEqual(restore(g, f).view(0), g.view(0));
});

test('schema forbids mixing printed attributes, runtime state and derived HP in either direction', async () => {
  const f = await fixture(), g = board(f);
  for (const [key, value] of Object.entries({
    currentHp: 70, maxHp: 100, counters: 3, conditions: { poisoned: true }, cannotAttackNextTurn: true,
  })) {
    const d = structuredClone(f.catalog.definition('base')); d.mechanics[key] = value;
    assert.throws(() => assertDefinitionShape(d), /Invalid normalized card definition/);
  }
  for (const [key, value] of Object.entries({ hp: 100, currentHp: 70, maxHp: 100, types: ['Fire'], attacks: [] })) {
    const s = g.snapshot(); s.players[0].active[key] = value;
    assert.throws(() => OfficialGame.restore(s, { catalog: f.catalog }), /Snapshot schema mismatch/);
    const nested = g.snapshot(); nested.players[0].active.facts[key] = value;
    assert.throws(() => OfficialGame.restore(nested, { catalog: f.catalog }), /Snapshot schema mismatch/);
  }
  const s = g.snapshot(); s.players[0].active.counters = 12;
  const lethal = OfficialGame.restore(s, { catalog: f.catalog });
  assert.equal(lethal.view(0).players[0].active.effective.currentHp, 0, 'Remaining HP does not become negative.');
  assert.equal(lethal.view(0).players[0].active.effective.maxHp, 100);
  for (const key of ['hp', 'maxHp', 'currentHp']) {
    assert(!Object.hasOwn(g.snapshot().players[0].active, key), 'Do not save a second authoritative HP value.');
    assert(!Object.hasOwn(g.snapshot().cards[g.snapshot().players[0].active.stack[0]], key));
  }
});

test('next-own-turn attack restriction has a target, source, expiry and attack identity; Ability is not a招式', async () => {
  const f = await fixture((defs) => {
    const m = defs[0].mechanics;
    m.attacks[0].effects = [binding('cn.lasting@1', lasting(restriction(['attack'], { attackIds: ['base:strike'] })))];
    m.attacks.push({ ...structuredClone(m.attacks[0]), attackId: 'base:other', effects: [] });
    m.abilities.push(ability('draw', [binding('cn.draw@1', { count: 1 })]));
  });
  const g = board(f, (s) => attached(s, 0, s.players[0].active, 'water'));
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  assert(!g.view(0).ongoing[0].active);
  end(g);
  assert(g.view(0).ongoing[0].active);
  assert.equal(g.view(0).ongoing[0].source.attackId, 'base:strike');
  assert(g.view(0).ongoing[0].rule.sourceOfTruth.length);
  const attacks = g.view(0).legalActions.filter((a) => a.type === 'attack').map((a) => a.attackId);
  assert.deepEqual(attacks, ['base:other']);
  const before = g.snapshot();
  assert.throws(() => command(g, { type: 'attack', attackId: 'base:strike' }), /not legal/);
  assert.deepEqual(g.snapshot(), before, 'Reject without consuming RNG, usage or the turn.');
  assert(has(g, 'useAbility')); use(g, 'draw');
  end(g); assert.equal(g.snapshot().ongoing.length, 0);
  end(g); assert(g.view(0).legalActions.some((a) => a.attackId === 'base:strike'));
});

test('Pokémon Retreat lock does not forbid effect switching; Bench/evolution clear only the flagged effects', async () => {
  const h = {
    rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE, operations: ['switch'],
    validateParameters: (p) => Object.keys(p).length === 0, execute: () => [{ op: 'switch', side: 'own' }],
  };
  const f = await fixture((defs) => defs[0].mechanics.abilities.push(
    ability('lock', [binding('cn.lasting@1', lasting(restriction(['retreat']), { duration: 'untilNextOwnTurnEnd' }))]),
    ability('switch', [binding('fixture:switch', {})]),
  ), new Map([['fixture:switch', h]]));
  for (const transition of ['switch', 'evolve']) {
    const g = board(f, (s) => {
      bench(s, 0, 'other'); attached(s, 0, s.players[0].active, 'water'); hand(s, 0, 'evolution');
    });
    assert(has(g, 'retreat')); use(g, 'lock');
    assert(!has(g, 'retreat')); assert(has(g, 'attack'));
    const before = g.snapshot();
    assert.throws(() => command(g, { type: 'retreat' }), /not legal/); assert.deepEqual(g.snapshot(), before);
    if (transition === 'switch') use(g, 'switch');
    else command(g, g.view(0).legalActions.find((a) => a.type === 'evolve'));
    assert.equal(g.snapshot().ongoing.length, 0);
    assert.equal(g.snapshot().players[0].flags.retreat, false, 'Switching is not the once-per-turn Retreat action.');
  }
});

test('live Pokémon restrictions and attack permissions are separate; permissions cannot override an explicit lock', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.effects.push(binding('cn.restriction@1', {
      effect: restriction(['attack', 'retreat'], { scope: 'own', activeOnly: true, type: 'Water' }),
    }));
    defs[0].mechanics.attacks[0].effects.push(binding('cn.attackPermissions@1', {
      permissions: ['first-turn-attack', 'attack-while-asleep'],
    }));
  });
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); bench(s, 0, 'other'); });
  assert(!has(g, 'attack')); assert(!has(g, 'retreat'));
  assert.equal(g.snapshot().players[0].active.conditions.rotation, null);
  assert.equal(g.snapshot().ongoing.length, 0, 'A live aura is not a copy in the timed-effect ledger.');
});

test('an Active-only Tool restriction is attached to its Pokémon identity, not mistaken for an evolution-stack card', async () => {
  const f = await fixture((defs) => defs.find((d) => d.definitionId === 'tool').mechanics.effects = [
    binding('cn.restriction@1', { effect: restriction(['retreat'], { scope: 'self', sourceActive: true }) }),
  ]);
  const g = board(f, (s) => {
    hand(s, 0, 'tool'); bench(s, 0, 'other'); attached(s, 0, s.players[0].active, 'water');
  });
  assert(has(g, 'retreat'));
  command(g, trainer(g, 'tool')); answer(g, [g.snapshot().players[0].active.id]);
  assert(!has(g, 'retreat'));
  assert(has(g, 'attack'));
});

test('C-19 player Trainer lock bypasses Pokémon effect immunity and survives the original source moving or evolving', async () => {
  const actions = ['playItem', 'playSupporter', 'playTool', 'playStadium', 'useStadium'];
  const onUse = { rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE, timing: 'onUse', operations: ['draw'],
    validateParameters: (p) => Object.keys(p).length === 0, execute: () => [{ op: 'draw', count: 1 }] };
  const f = await fixture((defs) => {
    defs[0].mechanics.attacks[0].effects = [binding('cn.lastingPlayer@1', playerLock(actions))];
    defs[0].mechanics.effects.push(binding('cn.protection@1', { effect: {
      op: 'protection', useRule: 'ordinary', scope: 'self', channel: 'effects', from: 'opponent', categories: ['attack'],
    } }));
    defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [binding('fixture:stadium-use', {})];
  }, new Map([['fixture:stadium-use', onUse]]));
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water'); bench(s, 0, 'other'); hand(s, 0, 'evolution');
    for (const id of ['potion', 'research', 'tool', 'stadium']) hand(s, 1, id);
    s.players[1].active.counters = 1;
  });
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  assert.equal(g.snapshot().ongoing.length, 0);
  assert.equal(g.snapshot().playerOngoing.length, 1);
  assert(!has(g, 'playTrainer'));
  assert(has(g, 'attachEnergy'), 'Player Trainer lock is not a ban on all actions.');
  assert.equal(g.view(1).playerOngoing[0].player, 1);
  assert(g.view(1).playerOngoing[0].active);
  assert(g.view(1).playerOngoing[0].rule.sourceOfTruth.length);
  let s = g.snapshot(), p = s.players[0], old = p.active;
  p.active = p.bench.pop(); p.bench.push(old);
  let moved = OfficialGame.restore(s, { catalog: f.catalog });
  assert(!has(moved, 'playTrainer'));
  s = g.snapshot(); p = s.players[0];
  const evolution = p.hand.find((id) => s.cards[id].definitionId === 'evolution');
  p.hand.splice(p.hand.indexOf(evolution), 1); p.active.stack.push(evolution);
  moved = OfficialGame.restore(s, { catalog: f.catalog });
  assert(!has(moved, 'playTrainer'));
  end(g); assert.equal(g.snapshot().playerOngoing.length, 0);
  end(g); assert(has(g, 'playTrainer'));
});

test('live player restrictions distinguish every Trainer category, both scopes, and Active-source conditions', async () => {
  const categories = { playItem: 'potion', playSupporter: 'research', playTool: 'tool', playStadium: 'stadium' };
  for (const [action, locked] of Object.entries(categories)) for (const scope of ['own', 'opponent', 'all']) {
    const f = await fixture((defs) => defs[1].mechanics.effects.push(binding('cn.playerRestriction@1', {
      effect: { op: 'playerRestriction', scope, actions: [action], sourceActive: true },
    })));
    const g = board(f, (s) => {
      bench(s, 1, 'other');
      for (const id of Object.values(categories)) hand(s, 0, id);
      s.players[0].active.counters = 1;
    });
    assert(trainer(g, locked), 'An inactive source does not lock its controller or opponent.');
    const s = g.snapshot(), p = s.players[1], old = p.active;
    p.active = p.bench.pop(); p.bench.push(old);
    const active = OfficialGame.restore(s, { catalog: f.catalog });
    for (const id of Object.values(categories))
      assert.equal(!!trainer(active, id), id !== locked || scope === 'own', `${action}/${scope}/${id}`);
  }
  const onUse = { rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE, timing: 'onUse', operations: ['draw'],
    validateParameters: (p) => Object.keys(p).length === 0, execute: () => [{ op: 'draw', count: 1 }] };
  const f = await fixture((defs) => {
    defs[1].mechanics.effects.push(binding('cn.playerRestriction@1', {
      effect: { op: 'playerRestriction', scope: 'opponent', actions: ['useStadium'] },
    }));
    defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [binding('fixture:stadium-use', {})];
  }, new Map([['fixture:stadium-use', onUse]]));
  const g = board(f, (s) => { bench(s, 1, 'other'); s.stadium = hand(s, 0, 'stadium'); s.players[0].hand.pop(); });
  assert(!has(g, 'useStadium'));
  assert(has(g, 'endTurn'));
});

test('player-effect clock, validation and ownership are independent of a live Pokémon target', async () => {
  const f = await fixture((defs) => defs[0].mechanics.abilities.push(
    ability('lock', [binding('cn.lastingPlayer@1', playerLock(['playItem'], { side: 'own', duration: 'untilNextOwnTurnEnd' }))]),
  ));
  const g = board(f); use(g, 'lock');
  const original = g.snapshot(), entry = original.playerOngoing[0];
  assertPlayerOngoingEffect(entry, original);
  assert.equal(entry.player, 0);
  assert.deepEqual(createPlayerOngoingEffect({
    id: entry.id, player: entry.player, source: entry.source, effect: entry.effect, duration: entry.duration,
  }, original), entry);
  for (const mutate of [
    (s) => { s.playerOngoing.push(structuredClone(s.playerOngoing[0])); },
    (s) => { s.playerOngoing[0].source.instanceId = 'missing'; },
    (s) => { s.playerOngoing[0].source.owner = 1; },
    (s) => { s.playerOngoing[0].targetId = s.players[0].active.id; },
    (s) => { s.playerOngoing[0].deadline.player = 1; },
  ]) { const s = structuredClone(original); mutate(s); assert.throws(() => OfficialGame.restore(s, { catalog: f.catalog })); }
  assert.throws(() => assertPlayerOngoingEffect({ ...entry, unexpected: true }, original), /Invalid player ongoing/);
  const s = g.snapshot(), m = s.players[0].active;
  s.players[0].discard.push(...m.stack); s.players[0].active = null; bench(s, 0, 'other');
  s.players[0].active = s.players[0].bench.pop();
  const gone = OfficialGame.restore(s, { catalog: f.catalog });
  assert.equal(gone.snapshot().playerOngoing.length, 1, 'Source leaving play does not erase a timed player effect.');
});

test('strict effect schemas prevent Pokémon/player lock confusion and meaningless attack filter properties', () => {
  const attack = restriction(['attack']);
  assert(validateRestrictionParameters({ effect: attack }));
  assert(validateLastingParameters(lasting(attack)));
  assert(!validateRestrictionParameters({ effect: restriction(['retreat'], { attackIds: ['strike'] }) }));
  assert(!validateRestrictionParameters({ effect: restriction(['useAbility']) }));
  assert(!validateLastingParameters(lasting({ op: 'playerRestriction', scope: 'all', actions: ['playItem'] })));
  assert(validateLastingPlayerParameters(playerLock(['playItem'])));
  assert(!validateLastingPlayerParameters(playerLock(['playItem'], { target: 'active' })));
  assert(!validateLastingPlayerParameters(playerLock(['playItem'], {
    effect: { op: 'playerRestriction', scope: 'all', sourceActive: false, actions: ['playItem'] },
  })));
  assert(!validateModifierParameters({ field: 'hp', amount: 50, scope: 'self', targetSide: 'opponent' }));
  assert(!validateModifierParameters({ field: 'attackDamage', amount: 30, scope: 'self', damageFrom: 'opponent' }));
});

test('printed HP, counters and their ten-point conversion stay exact; impossible saved values are not rounded or clamped into legality', async () => {
  const f = await fixture(), g = board(f), maximumCounters = 900719925474099;
  const huge = structuredClone(f.catalog.definition('base')); huge.mechanics.hp = 1e20;
  assert.throws(() => assertDefinitionShape(huge), /Invalid normalized card/);
  for (const field of ['counters', 'poison']) {
    const s = g.snapshot();
    if (field === 'counters') s.players[0].active.counters = maximumCounters + 1;
    else s.players[0].active.conditions.poison = maximumCounters + 1;
    assert.throws(() => OfficialGame.restore(s, { catalog: f.catalog }), /schema mismatch/);
  }
  const s = g.snapshot(); s.players[0].active.counters = maximumCounters;
  assert.equal(OfficialGame.restore(s, { catalog: f.catalog }).view(0).players[0].active.effective.currentHp, 0);
});

test('effective HP sums use exact arithmetic before bounds checking, independent of modifier order', async () => {
  const max = 9007199254740990;
  for (const amounts of [[max - 100, max, -max], [-max, max, max - 100]]) {
    const f = await fixture((ds) => {
      ds[0].mechanics.abilities = [ability('hp-sum', amounts.map((amount, i) =>
        binding('cn.modifier@1', { field: 'hp', amount, scope: 'self' }, `hp-sum:${i}`)), 'continuous')];
    });
    const g = board(f);
    assert.equal(g.view(0).players[0].active.effective.maxHp, max);
    assert.equal(g.view(0).players[0].active.effective.currentHp, max);
  }
  for (const amounts of [[max], [-max, -max]]) {
    const f = await fixture((ds) => {
      ds[0].mechanics.abilities = [ability('overflow', amounts.map((amount, i) =>
        binding('cn.modifier@1', { field: 'hp', amount, scope: 'self' }, `overflow:${i}`)), 'continuous')];
    });
    assert.throws(() => board(f), /maximum HP must remain/);
  }
});

test('damage-counter overflow rejects the answering transaction without unsafe multiplication or partial application', async () => {
  const f = await fixture((ds) => {
    ds[0].mechanics.attacks[0].effects = [binding('cn.counters@1', { side: 'own', target: 'self', count: 1 })];
  });
  const g = board(f, (s) => {
    s.players[0].active.counters = 900719925474099;
    attached(s, 0, s.players[0].active, 'water');
  });
  command(g, { type: 'attack', attackId: 'base:strike' });
  const before = g.snapshot();
  assert.equal(before.pending.kind, 'effect-target');
  assert.throws(() => answer(g, [before.players[0].active.id]), /ten-point conversion must both remain exact/);
  assert.deepEqual(g.snapshot(), before);
});

test('runtime HP/use/movement facts cannot claim a future turn or retain the ambiguous old successful-attack field', async () => {
  const f = await fixture(), g = board(f);
  for (const field of ['healedTurn', 'movedActiveTurn', 'lastUsedAttack']) {
    const s = g.snapshot();
    s.players[0].active.facts[field] = field === 'lastUsedAttack' ? { turn: s.turn + 1, attackId: 'base:strike' } : s.turn + 1;
    assert.throws(() => OfficialGame.restore(s, { catalog: f.catalog }), /Future Pokémon history/);
  }
  const s = g.snapshot(); s.players[0].active.facts.lastSuccessfulAttack = { turn: s.turn, attackId: 'base:strike' };
  assert.throws(() => OfficialGame.restore(s, { catalog: f.catalog }), /schema mismatch/);
});
