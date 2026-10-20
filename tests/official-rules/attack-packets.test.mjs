import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { assertEffectProgram } from '../../public/rules/effects.js';
import { REACTION_OPERATIONS } from '../../public/rules/handlers.js';
import { validateDamageParameters, validateDelayedReactionParameters } from '../../public/rules/schema-validators.js';
import { assertSubjectProgram } from '../../public/rules/triggers.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const packet = (extra = {}) => ({
  side: 'opponent', target: 'bench', amount: 30, selection: { kind: 'all' }, options: {}, ...extra,
});
const descriptor = (extra = {}) => ({
  event: 'attackDamage', subject: 'self', optional: false, choiceOwner: 'source', scope: 'global',
  cause: 'opponentAttackDamage', ...extra,
});
const reaction = (extra = {}) => ({
  side: 'own', target: 'self', trigger: descriptor(), duration: 'nextOpponentTurn',
  clearOnBench: true, clearOnEvolution: true,
  program: [{ op: 'counters', side: 'opponent', target: 'attacker', count: 8 }], ...extra,
});
const ability = (id, effects) => ({
  abilityId: id, name: `测试${id}`, mode: 'activated',
  usage: { period: 'unlimited', scope: 'pokemon', key: id, limit: null }, effects, sourceOfTruth: EVIDENCE,
});
const restore = (g, f) => OfficialGame.restore(JSON.parse(JSON.stringify(g.snapshot())), { catalog: f.catalog });
const attack = (g, id = 'base:strike') => command(g, { type: 'attack', attackId: id });
const end = (g) => { command(g, { type: 'endTurn' }); settle(g); };
const activate = (g, id) => command(g, { type: 'useAbility', pokemonId: g.snapshot().players[0].active.id, abilityId: id });
const activeOther = (s, owner) => {
  const p = s.players[owner], old = p.active;
  p.hand.push(...old.stack, ...old.energy, ...old.tools);
  p.active = bench(s, owner, 'other'); p.bench.pop();
};
const protection = (channel, extra = {}) => binding('cn.protection@1', { effect: {
  op: 'protection', useRule: 'ordinary', channel, scope: 'self', from: 'opponent', categories: ['attack'], ...extra,
} }, `protect-${channel}-${JSON.stringify(extra).replace(/[^a-zA-Z]/g, '')}`);

test('Bench attack damage follows its own modifiers/protection and normally skips W/R, not the counter-effect channel', async () => {
  for (const apply of [false, true]) for (const channel of ['effects', 'damage']) {
    const f = await fixture((defs) => {
      defs[0].mechanics.attacks[0].effects = [binding('cn.damage@1', packet({
        options: apply ? { applyBenchWeaknessResistance: true } : {},
      }))];
      defs[1].mechanics.weakness = { type: 'Water', operation: 'multiply', value: 2 };
      defs[1].mechanics.resistance = { type: 'Water', value: 20 };
      defs[1].mechanics.effects.push(protection(channel));
    });
    const g = board(f, (s) => {
      attached(s, 0, s.players[0].active, 'water'); bench(s, 1, 'other');
    });
    attack(g); settle(g);
    assert.equal(g.snapshot().players[1].active.counters, 2);
    assert.equal(g.snapshot().players[1].bench[0].counters, channel === 'damage' ? 0 : apply ? 4 : 3);
    const trace = g.snapshot().events.filter((e) => e.ruleId === 'attack.order').at(-1).data.calculation;
    assert.equal(trace.find((t) => t.ruleId === 'damage.bench').applyBenchWeaknessResistance, apply);
    assert.equal(g.snapshot().events.filter((e) => e.ruleId === 'damage.counters').length, 0);
  }
});

test('recoil is real attack damage with applicable own W/R; opponent-only buffs and primary ignore flags do not leak to it', async () => {
  const f = await fixture((defs) => {
    const m = defs[0].mechanics;
    m.weakness = { type: 'Water', operation: 'multiply', value: 2 };
    m.effects.push(
      binding('cn.modifier@1', { field: 'attackDamage', amount: 30, scope: 'self', targetSide: 'opponent', targetPosition: 'active' }, 'opponent-bonus'),
      binding('cn.modifier@1', { field: 'defenseDamage', amount: -10, scope: 'self', damageFrom: 'opponent' }, 'opponent-reduction'),
      binding('cn.modifier@1', { field: 'defenseDamage', amount: -10, scope: 'self', damageFrom: 'own' }, 'own-reduction'),
    );
    m.attacks[0].effects = [
      binding('cn.damageOptions@1', { ignoreWeakness: true, ignoreDefenderEffects: true }),
      binding('cn.recoilDamage@1', packet({ side: 'own', target: 'self', amount: 20 })),
    ];
  });
  const g = board(f, (s) => attached(s, 0, s.players[0].active, 'water'));
  attack(g); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 5, 'Primary gets only opponent Active +30, ignoring its defense.');
  assert.equal(g.snapshot().players[0].active.counters, 3, 'Recoil: 20 × own Weakness 2 − own-only reduction 10.');
  const packets = g.snapshot().events.filter((e) => e.ruleId === 'attack.order');
  assert(packets[1].data.calculation.some((t) => t.ruleId === 'damage.self'));
  assert(!packets[1].data.calculation.some((t) => t.ruleId === 'damage.ignore-defender'));
});

test('ordinary damage packets including recoil share stage-four models, not a later live-board effect phase', async () => {
  const shield = {
    rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE, timing: 'continuous', operations: ['protection'],
    validateParameters: (p) => Object.keys(p).length === 0,
    execute: (ctx) => ctx.state.players[ctx.source.owner].active.counters === 0 ? [{
      op: 'protection', useRule: 'ordinary', channel: 'damage', from: 'opponent', categories: ['attack'], scope: 'own', type: 'Fire',
    }] : [],
  };
  const f = await fixture((defs) => {
    defs[0].mechanics.effects.push(binding('fixture:undamaged-shield', {}));
    defs[0].mechanics.attacks[0].effects = [
      binding('cn.damage@1', packet()), binding('cn.recoilDamage@1', packet(), 'text-damage'),
    ];
    defs[1].mechanics.types = ['Fire'];
  }, new Map([['fixture:undamaged-shield', shield]]));
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); bench(s, 1, 'other'); });
  attack(g); settle(g);
  const values = g.snapshot().events.filter((e) => e.ruleId === 'attack.order').map((e) => e.data.damage);
  assert.deepEqual(values, [20, 0, 0], 'B-08/B-09 damage is not an ordinary later effect; primary damage cannot remove the simultaneous protection.');
  assert.equal(g.snapshot().players[1].bench[0].counters, 0);
});

test('multi-target exact/up-to/all selection uses CN bounds and preserves the attack frame on every restore', async () => {
  for (const selection of [{ kind: 'exact', count: 2 }, { kind: 'upTo', count: 2 }, { kind: 'all' }, { kind: 'exact', count: 5 }]) {
    const f = await fixture((defs) => defs[0].mechanics.attacks[0].effects = [binding('cn.damage@1', packet({ selection }))]);
    let g = board(f, (s) => {
      attached(s, 0, s.players[0].active, 'water');
      bench(s, 1, 'base'); bench(s, 1, 'other'); bench(s, 1, 'other');
    });
    const ids = g.snapshot().players[1].bench.map((m) => m.id);
    attack(g);
    if (['all'].includes(selection.kind) || selection.count === 5) assert.equal(g.snapshot().pending, null);
    else {
      const s = g.snapshot(), q = s.pending;
      assert.equal(q.kind, 'damage-targets'); assert.equal(q.minimum, selection.kind === 'exact' ? 2 : 1);
      assert.equal(q.maximum, 2); assert.equal(q.allowZero, false);
      assert(s.attack.damageModels.length === 5);
      for (const key of ['attack', 'queue', 'rng']) assert(!Object.hasOwn(g.view(0), key));
      for (const mutate of [
        (s) => { s.attack.source.pokemonId = 'corrupt'; },
        (s) => { s.attack.sourceId = s.players[1].active.stack[0]; },
        (s) => { s.attack.player = 1; },
        (s) => { s.phase = 'main'; },
      ]) { const bad = structuredClone(s); mutate(bad); assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog })); }
      assert.throws(() => answer(g, []), /Invalid selection/);
      if (selection.kind === 'exact') assert.throws(() => answer(g, [ids[0]]), /Invalid selection/);
      g = restore(g, f);
      const selected = ids.slice(0, selection.kind === 'exact' ? 2 : 1);
      const next = restore(g, f); answer(g, selected); answer(next, selected);
      assert.deepEqual(next.snapshot(), g.snapshot());
      for (const mutate of [
        (s) => { s.pending.data.action.target = 'active'; },
        (s) => { s.pending.data.source.category = 'ability'; },
      ]) {
        const bad = structuredClone(s); mutate(bad);
        const before = structuredClone(bad), live = g.snapshot();
        assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }),
          'Changed damage actors/targets are rejected before a corrupt continuation can become usable.');
        assert.deepEqual(bad, before); assert.deepEqual(g.snapshot(), live);
      }
    }
    const count = selection.kind === 'all' || selection.count === 5 ? 3 : selection.kind === 'exact' ? 2 : 1;
    assert.deepEqual(g.snapshot().players[1].bench.map((m) => m.counters), ids.map((_, i) => i < count ? 3 : 0));
    assert.equal(g.snapshot().attack, null);
  }
});

test('extra packets can target the Active or any Pokémon; own-Bench bonuses are not opponent-Active bonuses', async () => {
  for (const target of ['active', 'any']) {
    const f = await fixture((defs) => defs[0].mechanics.attacks[0].effects = [binding('cn.damage@1', packet({
      target, selection: { kind: 'exact', count: 1 },
    }))]);
    const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); bench(s, 1, 'other'); });
    attack(g);
    if (target === 'any') {
      assert.equal(g.snapshot().pending.options.length, 2);
      answer(g, [g.snapshot().players[1].bench[0].id]);
    }
    assert.equal(g.snapshot().players[1].active.counters, target === 'active' ? 5 : 2);
    assert.equal(g.snapshot().players[1].bench[0].counters, target === 'active' ? 0 : 3);
  }
  const f = await fixture((defs) => {
    defs[0].mechanics.effects.push(binding('cn.modifier@1', {
      field: 'attackDamage', amount: 10, scope: 'self', targetSide: 'own', targetPosition: 'bench',
    }));
    defs[0].mechanics.attacks[0].effects = [binding('cn.damage@1', packet({ side: 'own' }))];
  });
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); bench(s, 0, 'other'); });
  attack(g); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 2);
  assert.equal(g.snapshot().players[0].bench[0].counters, 4);
});

test('zero or absent extra damage cannot unlock dependent text or produce a damage reaction', async () => {
  for (const target of ['bench', 'self', 'event', 'attacker']) {
    const h = {
      rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE, timing: 'damage', operations: ['damage', 'then'],
      validateParameters: (p) => Object.keys(p).length === 0,
      execute: () => [{ op: 'then', first: { op: 'damage', ...packet({ target, side: 'own', amount: 0 }) },
        next: { op: 'damage', ...packet({ target: 'active', amount: 90 }) } }],
    };
    const f = await fixture((defs) => defs[0].mechanics.attacks[0].effects = [binding('fixture:zero-damage', {})],
      new Map([['fixture:zero-damage', h]]));
    const g = board(f, (s) => attached(s, 0, s.players[0].active, 'water'));
    attack(g); settle(g);
    assert.equal(g.snapshot().players[1].active.counters, 2);
    assert.equal(g.snapshot().players[0].active.counters, 0);
    assert.equal(g.snapshot().events.filter((e) => e.ruleId === 'trigger.damage').length, 0);
  }
});

test('delayed attack reaction retains original source and attacker, runs after text effects and before lethal KOs', async () => {
  for (const bothLethal of [false, true]) {
    const f = await fixture((defs) => {
      defs[0].mechanics.attacks[0].printedDamage = null;
      defs[0].mechanics.attacks[0].effects = [binding('cn.delayedReaction@1', reaction())];
      defs[1].mechanics.attacks[0].effects = [binding('cn.counters@1', { side: 'own', target: 'self', count: 1 })];
    });
    let g = board(f, (s) => {
      attached(s, 0, s.players[0].active, 'water'); activeOther(s, 1);
      attached(s, 1, s.players[1].active, 'water'); s.players[1].active.counters = 2;
      if (bothLethal) s.players[0].active.counters = 8;
    });
    const source = g.snapshot().players[0].active.stack[0];
    attack(g); settle(g);
    assert.equal(g.snapshot().current, 1);
    assert(g.view(1).ongoing[0].active);
    assert.equal(g.view(1).ongoing[0].effect.op, 'reaction');
    assert(!Object.hasOwn(g.view(1).ongoing[0].effect, 'program'));
    g = restore(g, f); attack(g, 'other:strike');
    assert.equal(g.snapshot().pending.kind, 'effect-target');
    settle(g);
    const events = g.snapshot().events, text = events.findIndex((e) => e.ruleId === 'damage.counters' && e.data.sourceOfTruth),
      react = events.findIndex((e) => e.ruleId === 'trigger.damage' && e.data.performed),
      ko = events.findIndex((e) => e.ruleId === 'ko.boundary' && e.data.owner !== undefined);
    assert(text < react && react < ko);
    assert.equal(events[react].data.sourceId, source, 'Reaction is from the original trap attack, not a new Ability.');
    assert.deepEqual(g.snapshot().result, { winner: bothLethal ? null : 0, reason: bothLethal ? 'simultaneous' : 'ordinary' });
    assert.equal(g.snapshot().ongoing.length, bothLethal ? 0 : 1,
      'A terminal victory stops resolution immediately, before surviving effects reach their expiry.');
  }
});

test('delayed retaliation is an attack effect, not fresh attack damage; immunity blocks counters, not selection', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.attacks[0].printedDamage = null;
    defs[0].mechanics.attacks[0].effects = [binding('cn.delayedReaction@1', reaction())];
    defs[1].mechanics.effects.push(protection('effects'));
  });
  const g = board(f, (s) => {
    activeOther(s, 1); attached(s, 0, s.players[0].active, 'water'); attached(s, 1, s.players[1].active, 'water');
  });
  attack(g); settle(g); attack(g, 'other:strike'); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 0);
  assert.equal(g.snapshot().players[0].active.counters, 2);
  assert.equal(g.snapshot().events.filter((e) => e.ruleId === 'trigger.damage' && e.data.performed).length, 1);
  assert(g.snapshot().events.some((e) => e.ruleId === 'effects.protection'));
  assert.equal(g.snapshot().ongoing.length, 0, 'Next-turn-only expires before checkup.');
});

test('a delayed reaction established after damage cannot retroactively react to that earlier packet', async () => {
  const f = await fixture((defs) => defs[0].mechanics.attacks[0].effects = [
    binding('cn.delayedReaction@1', reaction({
      side: 'opponent', target: 'active', duration: 'untilNextOpponentTurnEnd',
      program: [{ op: 'counters', side: 'own', target: 'attacker', count: 8 }],
    })),
  ]);
  const g = board(f, (s) => attached(s, 0, s.players[0].active, 'water'));
  attack(g); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 2);
  assert.equal(g.snapshot().players[0].active.counters, 0);
  assert.equal(g.snapshot().ongoing[0].effect.priorEventIds.length, 1);
  assert(!g.snapshot().events.some((e) => e.ruleId === 'trigger.damage' && e.data.performed));
});

test('delayed reaction can be optional and restores without native bindings; invalid causes and source bindings are rejected', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.attacks[0].printedDamage = null;
    defs[0].mechanics.attacks[0].effects = [binding('cn.delayedReaction@1', reaction({ trigger: descriptor({ optional: true }) }))];
    defs[0].mechanics.abilities.push(ability('unrelated', [binding('cn.draw@1', { count: 1 })]));
  });
  for (const decision of ['perform', 'skip']) {
    let g = board(f, (s) => {
      activeOther(s, 1); attached(s, 0, s.players[0].active, 'water'); attached(s, 1, s.players[1].active, 'water');
    });
    attack(g); settle(g); attack(g, 'other:strike');
    assert.equal(g.snapshot().pending.kind, 'trigger-optional');
    assert.equal(g.snapshot().pending.player, 0, 'Optional controller is separate from the damaged holder.');
    assert.equal(g.snapshot().pending.data.unit.bindings.length, 0);
    assert.equal(g.view(0).pending.triggers[0].sourceCategory, 'attack');
    const original = g.snapshot();
    for (const mutate of [
      (u) => { u.event.cause.source.owner = 0; },
      (u) => { u.reaction.targetId = 'wrong-target'; },
      (u) => { u.reaction.source.effectId = 'unapproved'; },
      (u) => { u.trigger.optional = false; },
    ]) {
      const s = structuredClone(original); mutate(s.pending.data.unit);
      assert.throws(() => OfficialGame.restore(s, { catalog: f.catalog }));
    }
    g = restore(g, f); answer(g, [decision]); settle(g);
    assert.equal(g.snapshot().players[1].active.counters, decision === 'perform' ? 8 : 0);
  }
});

test('fixed-target delayed effects clear on Bench/evolution when declared, and do not move with their source', async () => {
  const f = await fixture((defs) => defs[0].mechanics.abilities.push(ability('reaction', [
    binding('cn.delayedReaction@1', reaction({ duration: 'untilNextOwnTurnEnd' })),
  ])));
  for (const transition of ['retreat', 'evolve']) {
    const g = board(f, (s) => {
      attached(s, 0, s.players[0].active, 'water'); bench(s, 0, 'other'); hand(s, 0, 'evolution');
    });
    activate(g, 'reaction'); settle(g); assert.equal(g.snapshot().ongoing.length, 1);
    if (transition === 'evolve') command(g, g.view(0).legalActions.find((a) => a.type === 'evolve'));
    else { command(g, { type: 'retreat' }); settle(g); }
    assert.equal(g.snapshot().ongoing.length, 0);
  }
  const f2 = await fixture((defs) => defs[0].mechanics.abilities.push(ability('reaction', [
    binding('cn.delayedReaction@1', reaction({ target: 'bench', clearOnBench: false, clearOnEvolution: false })),
  ])));
  const g = board(f2, (s) => { bench(s, 0, 'base'); bench(s, 0, 'other'); activeOther(s, 1); });
  activate(g, 'reaction'); answer(g, [g.snapshot().players[0].bench[1].id]);
  const s = g.snapshot(), p = s.players[0], source = p.active;
  p.discard.push(...source.stack); p.active = p.bench.shift();
  const departed = OfficialGame.restore(s, { catalog: f2.catalog });
  assert.equal(departed.snapshot().ongoing[0].targetId, p.bench[0].id);
  assert.equal(departed.snapshot().ongoing[0].source.instanceId, source.stack[0]);
  assert.equal(departed.snapshot().ongoing[0].source.pokemonId, source.id);
});

test('subject-local delayed program uses the future event subject, not the original caster', async () => {
  const f = await fixture((defs) => defs[0].mechanics.abilities.push(ability('local-reaction', [
    binding('cn.delayedReaction@1', reaction({
      side: 'opponent', target: 'active', duration: 'untilNextOpponentTurnEnd',
      trigger: descriptor({ event: 'turnEnd', scope: 'subject', choiceOwner: 'affected', cause: 'any' }),
      program: [{ op: 'counters', side: 'opponent', target: 'event', count: 1 }],
    })),
  ])));
  const g = board(f);
  activate(g, 'local-reaction'); settle(g); end(g);
  assert.equal(g.snapshot().players[1].active.counters, 1);
  const event = { subjectId: g.snapshot().players[1].active.id, owner: 1 }, source = { owner: 0 };
  assertSubjectProgram([{ op: 'delayedReaction', ...reaction({ side: 'opponent', target: 'event' }) }], event, source);
  assert.throws(() => assertSubjectProgram([{ op: 'delayedReaction', ...reaction() }], event, source), /subject-local/);
});

test('schemas and capabilities validate deferred programs even when their branch is never executed', async () => {
  assert(validateDamageParameters(packet()));
  assert(validateDelayedReactionParameters(reaction()));
  for (const bad of [packet({ amount: 25 }), packet({ options: { ignoreWeakness: false } }),
    packet({ selection: { kind: 'any' } }), packet({ selection: { kind: 'upTo', count: 0 } })])
    assert(!validateDamageParameters(bad));
  assert(!validateDelayedReactionParameters(reaction({ trigger: descriptor({ subject: 'own' }) })));
  const program = [{ op: 'optional', effect: { op: 'delayedReaction', ...reaction() } }];
  assertEffectProgram(program, ['optional', 'delayedReaction'], REACTION_OPERATIONS);
  assert.throws(() => assertEffectProgram(program, ['optional', 'delayedReaction']), /Undeclared effect operation: counters/);
  assert.throws(() => assertEffectProgram([{ op: 'delayedReaction', ...reaction({
    program: [{ op: 'damage', ...packet() }],
  }) }], ['delayedReaction'], REACTION_OPERATIONS), /Undeclared effect operation: damage/);
  for (const bad of [
    { timing: 'resolve', operations: ['damage'] },
    { timing: 'damage', operations: ['draw'] },
    { timing: 'resolve', operations: ['delayedReaction'], embeddedOperations: ['damage'] },
  ]) {
    const h = { rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE,
      validateParameters: (p) => Object.keys(p).length === 0, execute: () => [], ...bad };
    const f = await fixture((defs) => defs[0].mechanics.abilities.push(ability('invalid', [binding('fixture:invalid', {})])),
      new Map([['fixture:invalid', h]]));
    assert.throws(() => board(f), /Unimplemented or undeclared handler timing/);
  }
});
