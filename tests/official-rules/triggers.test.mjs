import test from 'node:test';
import assert from 'node:assert/strict';
import { triggerMatches, triggerRuleId, TRIGGER_RULE_IDS, assertOwnerIndependence, assertSubjectProgram } from '../../public/rules/triggers.js';
import { CN_V20261019 } from '../../public/rules/zh-CN/V20261019.js';
import { requireRule } from '../../public/rules/registry.js';
import { OfficialGame } from '../../public/rules/game.js';
import { fixture, binding, EVIDENCE, board, start, command, answer, settle, hand, attached, bench } from './fixtures.mjs';

const descriptor = (event, extra = {}) => ({
  event, subject: 'self', optional: false, choiceOwner: 'source', scope: 'global', ...extra,
});
const ability = (id, event, effects, extra = {}) => ({
  abilityId: id, name: `测试触发${id}`, mode: 'triggered', usage: null,
  trigger: descriptor(event, extra), effects, sourceOfTruth: EVIDENCE,
});
const counter = (count, target = 'attacker', side = 'opponent', suffix = `${count}-${target}-${side}`) =>
  binding('cn.counters@1', { count, target, side }, suffix);
const heal = (amount = 30) => binding('cn.heal@1', { target: 'event', amount });
const restore = (g, f) => OfficialGame.restore(JSON.parse(JSON.stringify(g.snapshot())), { catalog: f.catalog });
const end = (g) => { command(g, { type: 'endTurn' }); };
function settleRestoring(game, f, policy = (q) => q.options.slice(0, q.minimum)) {
  while (game.snapshot().pending) {
    const before = game.snapshot(), next = restore(game, f);
    const selection = policy(before.pending, before);
    answer(game, selection); answer(next, selection);
    assert.deepEqual(next.snapshot(), game.snapshot(), 'Every timing/choice continuation survives JSON restoration.');
  }
}
const triggers = (g, kind) => g.snapshot().events.filter((e) => e.ruleId === `trigger.${kind}` && e.data.performed);

test('all trigger rules have CN sources, and descriptor filters are explicit rather than text heuristics', async () => {
  for (const id of TRIGGER_RULE_IDS) assert(requireRule(CN_V20261019, id).sourceOfTruth.length);
  const f = await fixture(), s = board(f).snapshot(), mon = s.players[0].active;
  const source = { instanceId: mon.stack[0], owner: 0, category: 'ability', pokemonId: mon.id,
    attackId: null, effectId: 'test', sourceOfTruth: EVIDENCE };
  const opponent = { ...source, owner: 1, pokemonId: s.players[1].active.id };
  const event = { id: 'event', kind: 'energyAttached', turn: s.turn, during: 0, endingPlayer: null,
    subjectId: mon.id, owner: 0, wasActive: true, origin: 'hand', cardId: source.instanceId,
    damage: 0, cause: { kind: 'effect', source }, snapshot: mon, definitionId: 'base', effectiveTypes: ['Water'] };
  const context = { sourceActive: true, definition: f.catalog.definition('base') };
  assert(triggerMatches(descriptor('energyAttached'), event, source, context));
  assert.equal(triggerRuleId(event.kind), 'trigger.energy');
  for (const extra of [
    { event: 'bench' }, { origin: 'discard' }, { turn: 'opponent' }, { endingPlayer: 'own' },
    { endingPlayer: 'opponent' }, { subject: 'opponent' }, { subjectTypes: ['Fire'] },
    { subjectRuleBox: true }, { rotation: 'asleep' }, { cause: 'attackDamage' },
  ]) assert(!triggerMatches(descriptor('energyAttached', extra), event, source, context));
  for (const extra of [
    { subject: 'own' }, { subject: 'all' }, { origin: 'any' }, { turn: 'own' },
    { endingPlayer: 'either' }, { cause: 'any' }, { subjectRuleBox: false }, { rotation: null }, { subjectTypes: ['Fire', 'Water'] },
  ]) assert(triggerMatches(descriptor('energyAttached', extra), event, source, context));
  assert(!triggerMatches(descriptor('energyAttached', { subject: 'own' }), event, opponent, context));
  assert(triggerMatches(descriptor('energyAttached', { subject: 'opponent', turn: 'opponent' }), event, opponent, context));
  assert(!triggerMatches(descriptor('energyAttached', { activeOnly: true }), { ...event, wasActive: false }, source, context));
  assert(!triggerMatches(descriptor('energyAttached', { sourceActive: true }), event, source, { ...context, sourceActive: false }));
  assert(triggerMatches(descriptor('energyAttached', { cardIsSource: true }), event, source, context));
  assert(!triggerMatches(descriptor('energyAttached', { cardIsSource: true }), { ...event, cardId: 'other-card' }, source, context));
  const damageEvent = { ...event, kind: 'attackDamage', damage: 20, cause: { kind: 'attackDamage', source: opponent } };
  assert(triggerMatches(descriptor('attackDamage', { cause: 'opponentAttackDamage' }), damageEvent, source, context));
  assert(!triggerMatches(descriptor('attackDamage'), { ...damageEvent, damage: 0 }, source, context));
  assert(!triggerMatches(descriptor('attackDamage', { cause: 'opponentAttackDamage' }),
    { ...damageEvent, cause: { kind: 'attackDamage', source } }, source, context));
  assert.throws(() => triggerMatches({ event: 'unknown' }, event, source, context), /Invalid trigger/);
  assert.throws(() => triggerMatches(descriptor('energyAttached'), { ...event, owner: 2 }, source, context), /Invalid trigger/);
});

test('E-03 reactions follow the attack effects, even on lethal damage, and the damaged holder chooses their order', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.attacks[0].effects = [counter(1, 'active', 'opponent', 'attack-effect')];
    defs[0].mechanics.abilities = [
      ability('react-a', 'attackDamage', [counter(1)]),
      ability('react-b', 'attackDamage', [counter(2)]),
    ];
  });
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); s.players[1].active.counters = 8; });
  command(g, { type: 'attack', attackId: 'base:strike' });
  assert.equal(g.snapshot().pending.kind, 'effect-target');
  answer(g, [g.snapshot().pending.options[0]]);
  const s = g.snapshot(), q = s.pending;
  assert.equal(q.kind, 'trigger-order'); assert.equal(q.player, 1);
  assert.deepEqual(g.view(1).pending.triggers.map((u) => u.abilityId), ['react-a', 'react-b']);
  assert(g.view(1).pending.triggers.every((u) => !Object.hasOwn(u, 'bindings') && !Object.hasOwn(u, 'parameters')));
  assert.equal(s.players[1].active.counters, 11);
  assert(!s.players[1].discard.includes(s.players[1].active.stack[0]));
  assert.throws(() => command(g, { type: 'answer', requestId: q.id, selected: [q.options[0]] }, 0), /cannot answer/);
  const expectedFirst = q.data.units.find((u) => u.id === q.options[1]).abilityId;
  settleRestoring(g, f, (q) => q.kind === 'trigger-order' ? [q.options.at(-1)] : q.options.slice(0, q.minimum));
  assert.equal(g.snapshot().players[0].active.counters, 3);
  assert.equal(triggers(g, 'damage')[0].data.abilityId, expectedFirst);
  assert.equal(g.snapshot().result.winner, 0);
  const events = g.snapshot().events;
  assert(events.findIndex((e) => e.ruleId === 'effects.partial' && e.data.effectId.includes('attack-effect')) <
    events.findIndex((e) => e.ruleId === 'trigger.damage'));
});

test('damage prevented, zero printed damage and pure counters never fire a damaged-by-attack reaction', async () => {
  for (const mode of ['prevent', 'zero', 'no-damage']) {
    const f = await fixture((defs) => {
      defs[0].mechanics.abilities = [ability('reaction', 'attackDamage', [counter(5)])];
      defs[0].mechanics.attacks[0].effects = [counter(2, 'active', 'opponent', 'pure-counters')];
      if (mode === 'prevent') defs[0].mechanics.effects = [binding('cn.protection@1', { effect: {
        op: 'protection', useRule: 'ordinary', channel: 'damage', scope: 'self', from: 'opponent', categories: ['attack'],
      } })];
      else defs[0].mechanics.attacks[0].printedDamage = mode === 'zero' ? { value: 0, operator: 'fixed' } : null;
    });
    const g = board(f, (s) => attached(s, 0, s.players[0].active, 'water'));
    command(g, { type: 'attack', attackId: 'base:strike' }); settleRestoring(g, f);
    assert.equal(triggers(g, 'damage').length, 0);
    assert.equal(g.snapshot().players[0].active.counters, 0);
    assert.equal(g.snapshot().players[1].active.counters, 2);
  }
});

test('a damage-time heal may avert KO, but a KO-time heal cannot revoke an already latched Knock Out', async () => {
  for (const timing of ['attackDamage', 'knockout']) {
    const f = await fixture((defs) => defs[0].mechanics.abilities.push(
      ability('heal', timing, [heal()], { scope: 'subject' })));
    const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); s.players[1].active.counters = 8; });
    command(g, { type: 'attack', attackId: 'base:strike' }); settleRestoring(g, f);
    if (timing === 'attackDamage') {
      assert.equal(g.snapshot().players[1].active.counters, 7);
      assert.equal(g.snapshot().players[0].prizes.length, 6);
    } else assert.equal(g.snapshot().result.winner, 0);
  }
});

test('E-04 simultaneous own KOs trigger before any discarded cards, then reaction chains award both sides before the draw', async () => {
  const verify = { rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE, operations: ['draw'],
    validateParameters: (p) => Object.keys(p).length === 0, execute: (ctx) => {
      assert(ctx.state.players[1].active); assert.equal(ctx.state.players[1].bench.length, 1);
      return [{ op: 'draw', count: 1 }];
    } };
  const f = await fixture((defs) => defs[0].mechanics.abilities.push(
    ability('ko', 'knockout', [binding('fixture:ko-check', {})])),
  new Map([['fixture:ko-check', verify]]));
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water'); s.players[1].active.counters = 8;
    bench(s, 1, 'base').counters = 10;
  });
  command(g, { type: 'attack', attackId: 'base:strike' });
  assert.equal(g.snapshot().pending.player, 1); assert.equal(g.snapshot().pending.kind, 'trigger-order');
  settleRestoring(g, f);
  assert.equal(triggers(g, 'knockout').length, 2);
  assert.equal(g.snapshot().players[0].prizes.length, 4);
  const chain = await fixture((defs) => defs[0].mechanics.abilities.push(
    ability('bomb', 'knockout', [counter(10)], { cause: 'opponentAttackDamage', activeOnly: true })));
  const cg = board(chain, (s) => { attached(s, 0, s.players[0].active, 'water'); s.players[1].active.counters = 8; });
  command(cg, { type: 'attack', attackId: 'base:strike' }); settleRestoring(cg, chain);
  assert.deepEqual(cg.snapshot().result, { winner: null, reason: 'simultaneous' });
  assert.equal(cg.snapshot().players[0].prizes.length, 5); assert.equal(cg.snapshot().players[1].prizes.length, 5);
  assert.equal(triggers(cg, 'knockout').length, 1, 'The counter-effect KO is not falsely labelled attack damage.');
});

test('a Tool reaction is ordered by the damaged holder and uses the original attacker, not the new Active', async () => {
  const beforeSwitch = { rulesetId: 'CN/V20261019', timing: 'beforeDamage', sourceOfTruth: EVIDENCE,
    operations: ['switch'], validateParameters: () => true, execute: () => [{ op: 'switch', side: 'own' }] };
  const f = await fixture((defs) => {
    defs[0].mechanics.attacks[0].effects = [binding('fixture:switch', {})];
    defs.find((d) => d.definitionId === 'tool').mechanics.effects = [{
      ...counter(3), trigger: descriptor('attackDamage', { activeOnly: true, cause: 'opponentAttackDamage' }),
    }];
  }, new Map([['fixture:switch', beforeSwitch]]));
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water'); bench(s, 0, 'other');
    const id = hand(s, 1, 'tool'); s.players[1].hand.splice(s.players[1].hand.indexOf(id), 1); s.players[1].active.tools.push(id);
  });
  const attacker = g.snapshot().players[0].active.id;
  command(g, { type: 'attack', attackId: 'base:strike' }); settleRestoring(g, f);
  assert.notEqual(g.snapshot().players[0].active.id, attacker);
  assert.equal(g.snapshot().players[0].active.counters, 0);
  assert.equal(g.snapshot().players[0].bench.find((m) => m.id === attacker).counters, 3);
});

test('E-05/06 optional from-hand evolution/bench Abilities have an immediate, non-delayable window; setup is not playing from hand', async () => {
  for (const event of ['bench', 'evolve']) for (const decision of ['perform', 'skip']) {
    const f = await fixture((defs) => {
      const d = defs.find((d) => d.definitionId === (event === 'bench' ? 'base' : 'evolution'));
      d.mechanics.abilities.push(ability('entry', event, [binding('cn.draw@1', { count: 1 })],
        { origin: 'hand', turn: 'own', optional: true }));
    });
    assert.equal(triggers(start(f), event === 'bench' ? 'bench' : 'evolve').length, 0);
    const g = board(f, (s) => hand(s, 0, event === 'bench' ? 'base' : 'evolution'));
    const before = g.snapshot().players[0].hand.length;
    command(g, g.view(0).legalActions.find((a) => a.type === event));
    assert.equal(g.snapshot().pending.kind, 'trigger-optional');
    const saved = g.snapshot(); assert.throws(() => end(g), /cannot answer/); assert.deepEqual(g.snapshot(), saved);
    const r = restore(g, f); answer(r, [decision]);
    assert.equal(r.snapshot().players[0].hand.length, before - 1 + Number(decision === 'perform'));
    assert(!r.view(0).legalActions.some((a) => a.type === 'useAbility' && a.abilityId === 'entry'));
    command(r, r.view(0).legalActions.find((a) => a.type === 'attachEnergy'));
    assert.equal(r.snapshot().pending, null);
  }
});

test('E-07 one multi-unit Energy card triggers once; effect attachment from hand still triggers, discard attachment does not', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.abilities = [
      ability('attach-trigger', 'energyAttached', [counter(1, 'event', 'own')], { subject: 'own', origin: 'hand', scope: 'subject' }),
      { abilityId: 'hand-attach', name: '测试手牌附着', mode: 'activated',
        usage: { period: 'unlimited', scope: 'pokemon', key: 'hand-attach', limit: null },
        effects: [binding('cn.attachHand@1', { type: 'Water', count: 3, benchOnly: true, optional: false })], sourceOfTruth: EVIDENCE },
      { abilityId: 'discard-attach', name: '测试弃牌附着', mode: 'activated',
        usage: { period: 'unlimited', scope: 'pokemon', key: 'discard-attach', limit: null },
        effects: [binding('cn.attachDiscard@1', { type: 'Water', count: 3, benchOnly: true, optional: false })], sourceOfTruth: EVIDENCE },
    ];
  });
  const g = board(f, (s) => {
    hand(s, 0, 'double'); bench(s, 0, 'other');
    for (let i = 0; i < 4; i++) hand(s, 0, 'water');
    const id = hand(s, 0, 'water'); s.players[0].hand.splice(s.players[0].hand.indexOf(id), 1); s.players[0].discard.push(id);
  });
  const s = g.snapshot(), double = s.players[0].hand.find((id) => s.cards[id].definitionId === 'double');
  command(g, { type: 'attachEnergy', cardId: double, pokemonId: s.players[0].active.id });
  assert.equal(triggers(g, 'energy').length, 1); assert.equal(g.snapshot().players[0].active.counters, 1);
  command(g, { type: 'useAbility', abilityId: 'hand-attach', pokemonId: s.players[0].active.id });
  assert.equal(g.snapshot().pending.kind, 'hand-energy');
  assert(g.snapshot().pending.allowZero, 'CN filtered own-hand up-to can choose zero.');
  answer(g, g.snapshot().pending.options.slice(0, 3)); settleRestoring(g, f);
  assert.equal(triggers(g, 'energy').length, 4);
  assert.equal(g.snapshot().players[0].bench[0].counters, 3);
  command(g, { type: 'useAbility', abilityId: 'discard-attach', pokemonId: s.players[0].active.id });
  settleRestoring(g, f);
  assert.equal(triggers(g, 'energy').length, 4); assert.equal(g.snapshot().players[0].bench[0].counters, 3);
});

test('an attached Special Energy can distinguish this card being attached from another card on the same Pokémon', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'double').mechanics.effects = [{
      ...counter(1, 'event', 'own'), trigger: descriptor('energyAttached', { scope: 'subject', cardIsSource: true, origin: 'hand' }),
    }];
    defs[0].mechanics.abilities = [{ abilityId: 'attach', name: '测试能量效果', mode: 'activated',
      usage: { period: 'unlimited', scope: 'pokemon', key: 'attach', limit: null }, sourceOfTruth: EVIDENCE,
      effects: [binding('cn.attachHand@1', { type: 'Water', count: 1, benchOnly: false, optional: false })] }];
  });
  const g = board(f, (s) => { hand(s, 0, 'double'); hand(s, 0, 'water'); });
  command(g, g.view(0).legalActions.find((a) => a.type === 'attachEnergy' && g.snapshot().cards[a.cardId].definitionId === 'double'));
  assert.equal(g.snapshot().players[0].active.counters, 1);
  command(g, { type: 'useAbility', abilityId: 'attach', pokemonId: g.snapshot().players[0].active.id });
  settleRestoring(g, f);
  assert.equal(g.snapshot().players[0].active.counters, 1);
  assert(g.snapshot().players[0].flags.energy);
});

test('end-turn effects precede checkup, and a checkup heal can be chosen before or after the entire status group', async () => {
  const f = await fixture((defs) => defs[0].mechanics.abilities.push(
    ability('end-heal', 'turnEnd', [heal(10)], { scope: 'subject', endingPlayer: 'own' })));
  const g = board(f, (s) => { s.players[0].active.counters = 1; s.players[0].active.conditions.poison = 1; });
  end(g); settleRestoring(g, f);
  assert.equal(g.snapshot().players[0].active.counters, 1);
  const events = g.snapshot().events;
  assert(events.findIndex((e) => e.ruleId === 'trigger.turn-end') < events.findIndex((e) => e.ruleId === 'status.poison'));
  const check = await fixture((defs) => defs[0].mechanics.abilities.push(
    ability('check-heal', 'checkup', [heal(10)], { scope: 'subject' })));
  for (const placement of ['before', 'after']) {
    const h = board(check, (s) => { s.players[0].active.conditions.poison = 1; });
    end(h); settleRestoring(h, check, (q) => q.kind === 'checkup-placement' ? [placement] : q.options.slice(0, q.minimum));
    assert.equal(h.snapshot().players[0].active.counters, placement === 'before' ? 1 : 0);
  }
  const rescue = board(check, (s) => { s.players[0].active.counters = 9; s.players[0].active.conditions.poison = 1; });
  end(rescue); settleRestoring(rescue, check, (q) => q.kind === 'checkup-placement' ? ['after'] : q.options.slice(0, q.minimum));
  assert.equal(rescue.snapshot().players[0].active.counters, 9); assert.equal(rescue.snapshot().result, null);
});

test('checkup eligibility is evaluated in the selected slot, after Sleep recovery when placed after statuses', async () => {
  const f = await fixture((defs) => defs[0].mechanics.abilities.push(
    ability('sleep-counter', 'checkup', [counter(2, 'event', 'own')], { scope: 'subject', rotation: 'asleep' })));
  for (const placement of ['before', 'after']) {
    const g = board(f, (s) => { s.rng = [123, 456, 789, 10]; s.players[0].active.conditions.rotation = 'asleep'; });
    end(g); settleRestoring(g, f, (q) => q.kind === 'checkup-placement' ? [placement] : q.options.slice(0, q.minimum));
    assert.equal(g.snapshot().players[0].active.counters, placement === 'before' ? 2 : 0);
    assert.equal(g.snapshot().players[0].active.conditions.rotation, null);
  }
});

test('two holders independently place local Stadium effects, without imposing current-player order', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [
      { ...counter(1, 'event', 'own', 'own-lane'), trigger: descriptor('checkup', { scope: 'subject', subject: 'own', choiceOwner: 'affected' }) },
      { ...counter(1, 'event', 'opponent', 'opp-lane'), trigger: descriptor('checkup', { scope: 'subject', subject: 'opponent', choiceOwner: 'affected' }) },
    ];
  });
  const g = board(f, (s) => {
    hand(s, 0, 'stadium');
    for (const p of s.players) p.active.conditions.poison = 1;
  });
  command(g, g.view(0).legalActions.find((a) => a.type === 'playTrainer' && g.snapshot().cards[a.cardId].definitionId === 'stadium'));
  end(g);
  const choices = [];
  settleRestoring(g, f, (q) => {
    if (q.kind === 'checkup-placement') { choices.push(q.player); return [q.player === 0 ? 'after' : 'before']; }
    return q.options.slice(0, q.minimum);
  });
  assert.deepEqual(choices, [0, 1]);
  assert(g.snapshot().players.every((p) => p.active.counters === 2));
  const e = g.snapshot().events, checkups = e.filter((x) => x.ruleId === 'trigger.checkup' && x.data.performed);
  assert.deepEqual(checkups.map((x) => x.data.owner), [1, 0]);
  const poisonIndices = e.map((x, i) => x.ruleId === 'status.poison' ? i : -1).filter((i) => i >= 0);
  assert(e.indexOf(checkups[0]) < poisonIndices[0] && e.indexOf(checkups[1]) > poisonIndices.at(-1));
});

test('subject-local handlers have only subject context and cannot smuggle writes to another lane', async () => {
  const h = { rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE, operations: ['counters'],
    validateParameters: () => true, execute: (ctx) => {
      assert(!Object.hasOwn(ctx, 'state')); assert.equal(ctx.subject.pokemon.id, ctx.event.subjectId);
      assert.throws(() => { ctx.subject.pokemon.counters = 0; }, TypeError);
      return [{ op: 'counters', count: 1, side: 'opponent', target: 'active' }];
    } };
  const f = await fixture((defs) => defs[0].mechanics.abilities.push(
    ability('bad-local', 'energyAttached', [binding('fixture:bad-local', {})], { scope: 'subject' })),
  new Map([['fixture:bad-local', h]]));
  const g = board(f), before = g.snapshot();
  assert.throws(() => command(g, g.view(0).legalActions.find((a) => a.type === 'attachEnergy')), /cannot affect another/);
  assert.deepEqual(g.snapshot(), before);
  assertSubjectProgram([{ op: 'sequence', steps: [{ op: 'then',
    first: { op: 'counters', target: 'event', side: 'own', count: 1 },
    next: { op: 'optional', effect: { op: 'heal', target: 'event', side: 'own', count: 1 } },
  }] }], { owner: 0 }, { owner: 0 });
});

test('unresolved cross-holder global interactions fail atomically rather than importing an international priority', async () => {
  assertOwnerIndependence([{ owner: 0, trigger: { scope: 'subject' } }, { owner: 1, trigger: { scope: 'subject' } }]);
  assert.throws(() => assertOwnerIndependence([{ owner: 0, trigger: { scope: 'global' } }, { owner: 1, trigger: { scope: 'subject' } }]), /sourced CN ordering/);
  const f = await fixture((defs) => defs[0].mechanics.abilities.push(
    ability('global-ko', 'knockout', [binding('cn.draw@1', { count: 1 })])));
  const g = board(f, (s) => { for (const p of s.players) p.active.counters = 10; }), before = g.snapshot();
  assert.throws(() => end(g), /sourced CN ordering/);
  assert.deepEqual(g.snapshot(), before);
});

test('trigger records and checkup plans are validated on restore, including duplicate unit identities', async () => {
  const f = await fixture((defs) => defs[0].mechanics.abilities.push(
    ability('a', 'attackDamage', [counter(1)]), ability('b', 'attackDamage', [counter(2)])));
  const g = board(f, (s) => attached(s, 0, s.players[0].active, 'water'));
  command(g, { type: 'attack', attackId: 'base:strike' });
  const original = g.snapshot(); assert.equal(original.pending.kind, 'trigger-order');
  for (const mutate of [
    (s) => { s.protocol = 'CN-game-dev-2'; },
    (s) => { s.pending.data.units[0].owner = 2; },
    (s) => { s.pending.data.units[1].id = s.pending.data.units[0].id; },
    (s) => { s.pending.data.units[0].event.damage = -10; },
    (s) => { s.pending.data.units[0].event.snapshot.counters = '1'; },
    (s) => { s.pending.data.units[0].trigger.unknown = true; },
    (s) => { s.pending.data.units[0].controller = 0; },
    (s) => { s.pending.data.units[0].event.subjectId = 'forged-mon'; },
    (s) => { s.pending.data.units[0].bindings[0].source.instanceId = 'forged-card'; },
    (s) => { s.pending.data.units[0].abilityId = 'forged-ability'; },
    (s) => { s.pending.data.units[0].bindings[0].binding.parameters.count = 99; },
    (s) => { s.pending.data.units[0].bindings[0].source.effectId = 'forged-effect'; },
    (s) => { s.pending.data.units[0].event.cause.source.instanceId = 'forged-cause'; },
  ]) { const s = structuredClone(original); mutate(s); assert.throws(() => OfficialGame.restore(s, { catalog: f.catalog })); }
});

test('triggered shared usage is consumed only on acceptance, and all effects of one Ability retain their written order', async () => {
  const f = await fixture((defs) => {
    const a = ability('shared', 'energyAttached', [
      binding('cn.draw@1', { count: 1 }), counter(1, 'event', 'own'),
    ], { subject: 'own', optional: true });
    a.usage = { period: 'turn', scope: 'player', key: 'shared-trigger', limit: 1 };
    defs[0].mechanics.abilities.push(a);
  });
  for (const firstDecision of ['skip', 'perform']) {
    const g = board(f, (s) => bench(s, 0, 'base'));
    const before = g.snapshot();
    command(g, g.view(0).legalActions.find((a) => a.type === 'attachEnergy' && a.pokemonId === before.players[0].active.id));
    assert.equal(g.snapshot().pending.kind, 'trigger-order');
    let decisions = 0;
    settleRestoring(g, f, (q) => {
      if (q.kind === 'trigger-optional') return [decisions++ === 0 ? firstDecision : 'perform'];
      return q.options.slice(0, q.minimum);
    });
    assert.equal(decisions, firstDecision === 'skip' ? 2 : 1);
    assert.equal(g.snapshot().players[0].active.counters, 1);
    assert.equal(g.snapshot().players[0].used['shared-trigger'].length, 1);
    assert.equal(g.snapshot().players[0].hand.length, before.players[0].hand.length);
    const tail = g.snapshot().events.slice(before.events.length).filter((e) => e.ruleId === 'effects.partial');
    assert.deepEqual(tail.map((e) => e.data.operation), ['draw', 'counters']);
  }
  const damaged = board(f, (s) => bench(s, 0, 'base'));
  command(damaged, damaged.view(0).legalActions.find((a) => a.type === 'attachEnergy'));
  const snap = damaged.snapshot();
  snap.pending.data.units[0].bindings.pop();
  assert.throws(() => OfficialGame.restore(snap, { catalog: f.catalog }), /drop, duplicate or reorder/);
});

test('an automatic Stadium effect may name the affected holder, not the printing owner, as the optional controller', async () => {
  const f = await fixture((defs) => defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [{
    ...counter(1, 'event', 'opponent'),
    trigger: descriptor('attackDamage', { subject: 'opponent', scope: 'subject', choiceOwner: 'affected', optional: true }),
  }]);
  const g = board(f, (s) => { hand(s, 0, 'stadium'); attached(s, 0, s.players[0].active, 'water'); });
  command(g, g.view(0).legalActions.find((a) => a.type === 'playTrainer' && g.snapshot().cards[a.cardId].definitionId === 'stadium'));
  command(g, { type: 'attack', attackId: 'base:strike' });
  assert.equal(g.snapshot().pending.player, 1); assert.equal(g.view(0).pending, null);
  settleRestoring(g, f);
  assert.equal(g.snapshot().players[1].active.counters, 3);
});

test('a continuous HP source leaving play starts a further KO chain before any winner is selected', async () => {
  const f = await fixture((defs) => defs.find((d) => d.definitionId === 'other').mechanics.effects.push(
    binding('cn.modifier@1', { field: 'hp', amount: 50, scope: 'own' })));
  const g = board(f, (s) => {
    s.players[1].active.counters = 12;
    bench(s, 1, 'other').counters = 15;
  });
  command(g, g.view(0).legalActions.find((a) => a.type === 'attachEnergy')); settleRestoring(g, f);
  assert.equal(g.snapshot().players[0].prizes.length, 4);
  assert.equal(g.snapshot().battleHistory.events.filter((x) => x.kind === 'ko' && x.owner === 1).length, 2);
  assert.equal(g.snapshot().result.winner, 0);
});

test('core Active-only healing cannot choose a damaged Bench Pokémon', async () => {
  const f = await fixture((defs) => defs.find((d) => d.definitionId === 'potion').mechanics.effects =
    [binding('cn.heal@1', { target: 'active', amount: 30 })]);
  const g = board(f, (s) => {
    s.players[0].active.counters = 2; bench(s, 0, 'other').counters = 3; hand(s, 0, 'potion');
  });
  command(g, g.view(0).legalActions.find((a) => a.type === 'playTrainer' && g.snapshot().cards[a.cardId].definitionId === 'potion'));
  assert.deepEqual(g.snapshot().pending.options, [g.snapshot().players[0].active.id]);
  settleRestoring(g, f);
  assert.equal(g.snapshot().players[0].active.counters, 0);
  assert.equal(g.snapshot().players[0].bench[0].counters, 3);
});

test('individual checkup effects can be placed on either side of the entire, unsplittable status group', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.abilities = [
      ability('before-counter', 'checkup', [counter(1, 'event', 'own')], { scope: 'subject' }),
      ability('after-heal', 'checkup', [heal(10)], { scope: 'subject' }),
    ];
  });
  const g = board(f, (s) => { s.players[0].active.conditions.poison = 1; });
  end(g);
  settleRestoring(g, f, (q) => {
    if (q.kind === 'checkup-placement') {
      const visible = g.view(q.player).pending.triggers;
      assert.equal(visible.length, 1);
      return [visible[0].abilityId === 'before-counter' ? 'before' : 'after'];
    }
    return q.options.slice(0, q.minimum);
  });
  assert.equal(g.snapshot().players[0].active.counters, 1);
  assert.equal(g.snapshot().players[1].active.counters, 0);
  const e = g.snapshot().events, before = e.findIndex((x) => x.ruleId === 'trigger.checkup' && x.data.abilityId === 'before-counter');
  const status = e.findIndex((x) => x.ruleId === 'status.poison');
  const after = e.findIndex((x) => x.ruleId === 'trigger.checkup' && x.data.abilityId === 'after-heal');
  assert(before < status && status < after);
});

test('trigger context survives then/optional frames; a protected first effect does not unlock the dependent heal', async () => {
  const h = { rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE, operations: ['then', 'optional', 'counters', 'heal'],
    validateParameters: () => true, execute: () => [{
      op: 'then', first: { op: 'counters', count: 1, side: 'opponent', target: 'attacker' },
      next: { op: 'optional', effect: { op: 'heal', count: 3, side: 'own', target: 'event' } },
    }] };
  for (const protectedAttacker of [false, true]) {
    const f = await fixture((defs) => {
      defs[0].mechanics.abilities.push(ability('reaction-program', 'attackDamage', [binding('fixture:reaction-program', {})]));
      if (protectedAttacker) defs[0].mechanics.effects.push(binding('cn.protection@1', { effect: {
        op: 'protection', useRule: 'ordinary', channel: 'effects', scope: 'self', from: 'opponent', categories: ['ability'],
      } }));
    }, new Map([['fixture:reaction-program', h]]));
    const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); s.players[1].active.counters = 8; });
    command(g, { type: 'attack', attackId: 'base:strike' });
    if (!protectedAttacker) {
      assert.equal(g.snapshot().pending.kind, 'optional-effect'); assert.equal(g.snapshot().pending.player, 1);
      settleRestoring(g, f);
      assert.equal(g.snapshot().players[0].active.counters, 1);
      assert.equal(g.snapshot().players[1].active.counters, 7);
    } else {
      settleRestoring(g, f);
      assert.equal(g.snapshot().players[0].active.counters, 0);
      assert.equal(g.snapshot().result.winner, 0);
    }
  }
});
