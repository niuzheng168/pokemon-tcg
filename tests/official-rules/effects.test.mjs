import test from 'node:test';
import assert from 'node:assert/strict';
import { assertEffectProgram, assertEffectStep, beginEffectProgram, completeEffectStep, expandEffectStep } from '../../public/rules/effects.js';
import { validateContinuousEffect, validateProtectionParameters, validatePropertyParameters, validateDamageOptionsParameters,
  validateTransferCountersParameters } from '../../public/rules/schema-validators.js';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const seq = (...steps) => ({ op: 'sequence', steps });
const then = (first, next) => ({ op: 'then', first, next });
const optional = (effect) => ({ op: 'optional', effect });
const draw = (count) => ({ op: 'draw', count });
const counters = (count, side = 'own') => ({ op: 'counters', count, side, target: 'active' });
const operations = ['sequence', 'then', 'optional', 'draw', 'counters', 'discardHand', 'switch', 'transferCounters', 'attachDiscard'];
const ability = (id, effects, mode = 'activated') => ({
  abilityId: id, name: `测试${id}`, mode, usage: mode === 'continuous' ? null :
    { period: 'unlimited', scope: 'pokemon', key: id, limit: null }, effects, sourceOfTruth: EVIDENCE,
});
const protect = (channel, extra = {}) => binding('cn.protection@1', { effect: {
  op: 'protection', useRule: 'ordinary', channel, scope: 'self', from: 'opponent', categories: ['attack'], ...extra,
} }, `protect-${channel}-${JSON.stringify(extra).replace(/[^a-zA-Z]/g, '')}`);
async function programFixture(program, { slot = 'ability', canUse = () => true, mutate = () => {} } = {}) {
  const h = { rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE, operations,
    validateParameters: (p) => Object.keys(p).length === 0, execute: () => structuredClone(program), canUse };
  return fixture((defs) => {
    const b = binding('fixture:program', {});
    if (slot === 'ability') defs[0].mechanics.abilities.push(ability('program', [b]));
    else if (slot === 'trainer') defs.find((d) => d.definitionId === 'research').mechanics.effects = [b];
    else defs[0].mechanics.attacks[0].effects = [b];
    mutate(defs);
  }, new Map([['fixture:program', h]]));
}
const use = (g) => command(g, { type: 'useAbility', pokemonId: g.snapshot().players[0].active.id, abilityId: 'program' });
const restore = (g, f) => OfficialGame.restore(JSON.parse(JSON.stringify(g.snapshot())), { catalog: f.catalog });

test('effect frames match an independent recursive then/sequence oracle for partial and absent results', () => {
  const nodes = [draw(1), draw(2), seq(), seq(draw(1), draw(2)), then(draw(2), draw(1)), optional(draw(2))];
  let checked = 0;
  for (const first of nodes) for (const second of nodes) for (const third of nodes) for (const accept of [true, false]) {
    const root = then(seq(first, then(second, third)), draw(99));
    const expected = [];
    const evaluate = (a) => {
      if (a.op === 'draw') { expected.push(a.count); return a.count !== 2; }
      if (a.op === 'optional') return accept && evaluate(a.effect);
      if (a.op === 'then') { const did = evaluate(a.first); if (did) evaluate(a.next); return did; }
      const results = a.steps.map(evaluate); return results.some(Boolean);
    };
    evaluate(root);
    const actual = [], original = [root];
    assertEffectProgram(original, operations);
    let step = beginEffectProgram(original);
    for (let i = 0; step; i++) {
      assert(i < 200, 'Pure test interpreter must terminate.');
      const snapshot = structuredClone(step);
      if (['sequence', 'then'].includes(step.action.op)) step = expandEffectStep(step);
      else if (step.action.op === 'optional') step = accept ?
        { action: step.action.effect, frames: step.frames } : completeEffectStep(step, false);
      else { actual.push(step.action.count); step = completeEffectStep(step, step.action.count !== 2); }
      assert.deepEqual(snapshot, JSON.parse(JSON.stringify(snapshot)));
    }
    assert.deepEqual(actual, expected);
    checked++;
  }
  assert.equal(checked, 432);
});

test('program schemas reject unknown instructions, undeclared skipped branches and corrupt frames', () => {
  for (const program of [null, {}, [null], [{ op: 'unknown' }], [{ op: 'draw', count: -1 }],
    [{ op: 'draw', count: 1, ignored: true }], [{ op: 'switch', side: 'all' }],
    [{ op: 'condition', side: 'own', target: 'active', condition: 'frozen' }]]) {
    assert.throws(() => assertEffectProgram(program, operations), /No silent fallback/);
  }
  assert.throws(() => assertEffectProgram([then(seq(), draw(1))], ['sequence', 'then']), /Undeclared/);
  assert.throws(() => assertEffectProgram([optional(draw(1))], ['optional']), /Undeclared/);
  assert.throws(() => assertEffectStep({ action: draw(1), frames: [{ kind: 'wrong' }] }), /resolution frame/);
  assert.throws(() => completeEffectStep(beginEffectProgram([]), 0), /performed boolean/);
  const original = beginEffectProgram([then(draw(1), draw(2))]), before = structuredClone(original);
  expandEffectStep(original);
  assert.deepEqual(original, before);
  assert.deepEqual(expandEffectStep({ action: draw(1), frames: [] }), { action: draw(1), frames: [] });
});

test('new parameter schemas separate damage flags, effects protection, W/R and counter transfer', () => {
  assert(validateProtectionParameters({ effect: { op: 'protection', useRule: 'ordinary', channel: 'effects', scope: 'self', from: 'opponent', categories: ['trainer'] } }));
  assert(!validateProtectionParameters({ effect: { op: 'property', field: 'weakness', value: null, scope: 'self' } }));
  assert(validatePropertyParameters({ effect: { op: 'property', field: 'weakness', value: null, scope: 'self' } }));
  assert(!validatePropertyParameters({ effect: { op: 'property', field: 'weakness', value: { type: 'Fire', value: 2 }, scope: 'self' } }));
  assert(!validatePropertyParameters({ effect: { op: 'property', field: 'resistance', value: { type: 'Fire', value: 15 }, scope: 'self' } }));
  assert(validateDamageOptionsParameters({ ignoreDefenderEffects: true }));
  for (const p of [{}, { ignoreDefenderEffects: false }, { ignoreEffects: true }]) assert(!validateDamageOptionsParameters(p));
  assert(validateTransferCountersParameters({ count: 3, from: 'self', side: 'opponent', target: 'active' }));
  assert(!validateTransferCountersParameters({ count: 0, from: 'self', side: 'opponent', target: 'active' }));
  assert(!validateContinuousEffect({ op: 'modifier', field: 'hp', amount: 5, scope: 'self' }));
});

test('then follows partial execution, but not an empty draw; independent following text still resolves', async () => {
  const f = await programFixture([then(draw(3), counters(1)), counters(2, 'opponent')]);
  for (const remaining of [0, 1, 2]) {
    const g = board(f, (s) => {
      const p = s.players[0]; p.discard.push(...p.deck.splice(0, p.deck.length - remaining));
    });
    const initialHand = g.snapshot().players[0].hand.length;
    use(g);
    while (g.snapshot().pending) { const q = g.snapshot().pending; const r = restore(g, f); answer(r, [q.options[0]]); g.dispatch({
      player: q.player, expectedRevision: g.snapshot().revision, action: { type: 'answer', requestId: q.id, selected: [q.options[0]] },
    }); assert.deepEqual(r.snapshot(), g.snapshot()); }
    assert.equal(g.snapshot().players[0].active.counters, remaining ? 1 : 0);
    assert.equal(g.snapshot().players[1].active.counters, 2);
    assert.equal(g.snapshot().players[0].hand.length, initialHand + remaining);
    assert.equal(g.snapshot().result, null, 'Effect-draw failure is not turn-start deckout.');
  }
});

test('optional is a whole-effect decision; skipping does not unlock then and can be restored', async () => {
  const f = await programFixture([then(optional(counters(3)), counters(2, 'opponent'))]);
  for (const decision of ['skip', 'perform']) {
    let g = board(f);
    use(g);
    assert.equal(g.snapshot().pending.kind, 'optional-effect');
    assert.deepEqual(g.snapshot().pending.options, ['perform', 'skip']);
    g = restore(g, f);
    assert.throws(() => answer(g, []), /Invalid selection/);
    answer(g, [decision]); settle(g);
    assert.equal(g.snapshot().players[0].active.counters, decision === 'perform' ? 3 : 0);
    assert.equal(g.snapshot().players[1].active.counters, decision === 'perform' ? 2 : 0);
  }
});

test('empty/zero instructions do not unlock then; nested aggregate preserves a successful earlier action', async () => {
  const f = await programFixture([
    then(seq(draw(0), seq()), counters(8)),
    then(seq(counters(1), then(draw(0), counters(8))), counters(2, 'opponent')),
  ]);
  const g = board(f);
  use(g); settle(g);
  assert.equal(g.snapshot().players[0].active.counters, 1);
  assert.equal(g.snapshot().players[1].active.counters, 2);
});

test('card-specific activation precondition prevents an all-empty first part from using later draw text', async () => {
  const f = await programFixture([then(seq({ op: 'discardHand', player: 0 }, { op: 'discardHand', player: 1 }), draw(5))], {
    slot: 'trainer', canUse: (ctx) => ctx.state.players.some((p) => p.hand.some((id) => id !== ctx.source.instanceId)),
  });
  const g = board(f, (s) => {
    hand(s, 0, 'research');
    for (const [owner, p] of s.players.entries()) {
      const keep = p.hand.filter((id) => owner === 0 && s.cards[id].definitionId === 'research');
      p.discard.push(...p.hand.filter((id) => !keep.includes(id))); p.hand = keep;
    }
  });
  assert(!g.view(0).legalActions.some((a) => a.type === 'playTrainer'));
  const id = g.snapshot().players[0].hand[0], before = g.snapshot();
  assert.throws(() => command(g, { type: 'playTrainer', cardId: id }), /not legal/);
  assert.deepEqual(g.snapshot(), before);
});

test('CN E-29: protected Bench remains selectable; Guzma then is blocked, Escape Rope affects the Active', async () => {
  for (const affected of ['selected', 'active']) for (const protectedPosition of ['bench', 'active']) {
    const f = await programFixture([then({ op: 'switch', side: 'opponent', chooser: 'self', affected },
      { op: 'switch', side: 'own' })], { slot: 'trainer', mutate: (defs) => {
      defs.find((d) => d.definitionId === (protectedPosition === 'bench' ? 'other' : 'base')).mechanics.abilities.push(
        ability('trainer-protect', [protect('effects', { useRule: 'CN.E29', categories: ['trainer'],
          trainerCategories: ['item', 'supporter'], trainerOrigins: ['hand'] })], 'continuous'));
    } });
    let g = board(f, (s) => { hand(s, 0, 'research'); bench(s, 0, 'other'); bench(s, 1, 'other'); });
    const before = g.snapshot(), id = before.players[0].hand.find((id) => before.cards[id].definitionId === 'research');
    command(g, { type: 'playTrainer', cardId: id });
    const q = g.snapshot().pending;
    assert.equal(q.player, 0); assert(q.options.includes(before.players[1].bench[0].id), 'Protection is not a selection ban.');
    g = restore(g, f); answer(g, [before.players[1].bench[0].id]); settle(g);
    const blocked = (affected === 'selected') === (protectedPosition === 'bench');
    assert.equal(g.snapshot().players[1].active.id === before.players[1].active.id, blocked);
    assert.equal(g.snapshot().players[0].active.id === before.players[0].active.id, blocked, 'Failed first switch cannot unlock then.');
    assert(g.snapshot().players[0].discard.includes(id));
  }
});

test('damage shields and effect shields are independent, and protection does not clear existing poison', async () => {
  for (const channels of [[], ['damage'], ['effects'], ['damage', 'effects']]) {
    const f = await fixture((defs) => {
      defs[0].mechanics.abilities.push(ability('shield', channels.length ? channels.map((c) => protect(c)) :
        [binding('cn.modifier@1', { field: 'retreat', amount: 0, scope: 'self' })], 'continuous'));
      defs[0].mechanics.attacks[0].effects = [
        binding('cn.counters@1', { side: 'opponent', target: 'active', count: 2 }),
        binding('cn.condition@1', { side: 'opponent', condition: 'paralyzed' }),
      ];
    });
    const g = board(f, (s) => {
      attached(s, 0, s.players[0].active, 'water'); s.players[1].active.conditions.poison = 1;
    });
    command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
    assert.equal(g.snapshot().players[1].active.counters, (channels.includes('damage') ? 0 : 2) + (channels.includes('effects') ? 0 : 2) + 1);
    assert.equal(g.snapshot().players[1].active.conditions.rotation, channels.includes('effects') ? null : 'paralyzed');
    assert.equal(g.snapshot().players[1].active.conditions.poison, 1);
  }
});

test('counter transfer removes the source counters even when the selected destination blocks effects', async () => {
  const f = await programFixture([then({ op: 'transferCounters', count: 3, from: 'self', side: 'opponent', target: 'active' }, draw(1))], {
    mutate: (defs) => defs[0].mechanics.abilities.push(ability('shield', [protect('effects', { categories: ['ability'] })], 'continuous')),
  });
  let g = board(f, (s) => { s.players[0].active.counters = 5; });
  const initialHand = g.snapshot().players[0].hand.length;
  use(g); assert.equal(g.snapshot().pending.kind, 'counter-origin');
  g = restore(g, f); answer(g, [g.snapshot().pending.options[0]]);
  assert.equal(g.snapshot().players[0].active.counters, 2);
  assert.equal(g.snapshot().pending.kind, 'counter-destination');
  g = restore(g, f); answer(g, [g.snapshot().pending.options[0]]);
  assert.equal(g.snapshot().players[1].active.counters, 0);
  assert.equal(g.snapshot().players[0].hand.length, initialHand + 1);
});

test('ignore defender effects bypasses damage reduction/protection, not effective removed W/R or effect immunity', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.weakness = { type: 'Water', operation: 'multiply', value: 2 };
    defs[0].mechanics.abilities = [ability('shield', [
      protect('damage'), protect('effects'),
      binding('cn.property@1', { effect: { op: 'property', field: 'weakness', value: null, scope: 'self' } }),
      binding('cn.property@1', { effect: { op: 'property', field: 'resistance', value: null, scope: 'self' } }, 'resistance-property'),
      binding('cn.modifier@1', { field: 'defenseDamage', amount: -20, scope: 'self' }),
    ], 'continuous')];
    defs[0].mechanics.attacks[0].effects = [
      binding('cn.damageOptions@1', { ignoreDefenderEffects: true }),
      binding('cn.counters@1', { side: 'opponent', target: 'active', count: 3 }),
    ];
  });
  const g = board(f, (s) => attached(s, 0, s.players[0].active, 'water'));
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 2);
  const calculation = g.snapshot().events.findLast((e) => e.ruleId === 'attack.order').data.calculation;
  assert.equal(calculation.find((t) => t.ruleId === 'damage.weakness').weakness, null);
  assert(calculation.find((t) => t.ruleId === 'damage.defender').skipped);
});

test('corrupt saved effect frames, stages and sources fail closed; prior development protocol is not migrated silently', async () => {
  const f = await programFixture([then(optional(counters(1)), draw(1))]), g = board(f);
  use(g);
  const original = g.snapshot();
  for (const mutate of [
    (s) => { s.protocol = 'CN-game-dev-1'; },
    (s) => { s.pending.data.frames[0].performed = 'yes'; },
    (s) => { s.pending.data.source.owner = 2; },
    (s) => { s.pending.data.source.ignoreProtection = true; },
    (s) => { s.pending.data.stage = 'transfer-target'; s.pending.data.originId = 'm1'; s.pending.data.removed = 1; },
    (s) => { s.pending.data.action = draw(-1); },
  ]) {
    const s = structuredClone(original); mutate(s);
    assert.throws(() => OfficialGame.restore(s, { catalog: f.catalog }));
  }
});

test('nonstacking groups deduplicate identical modifiers and never pick an arbitrary conflicting amount', async () => {
  for (const conflict of [false, true]) {
    const f = await fixture((defs) => {
      for (const id of ['base', 'other']) defs.find((d) => d.definitionId === id).mechanics.abilities = [ability(`boost-${id}`, [
        binding('cn.modifier@1', { field: 'attackDamage', amount: id === 'other' && conflict ? 20 : 10,
          scope: 'own', group: 'same-nonstacking-effect' }),
      ], 'continuous')];
    });
    const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); bench(s, 0, 'other'); });
    const before = g.snapshot();
    if (conflict) {
      assert.throws(() => command(g, { type: 'attack', attackId: 'base:strike' }), /Conflicting nonstacking/);
      assert.deepEqual(g.snapshot(), before);
    } else {
      command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
      assert.equal(g.snapshot().players[1].active.counters, 3);
    }
  }
});

test('core transfer/attachment legality uses actual available objects, not just printed descriptions', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.abilities = [
      ability('move', [binding('cn.transferCounters@1', { count: 3, from: 'self', side: 'own', target: 'any' })]),
      ability('attach', [binding('cn.attachDiscard@1', { type: 'Water', count: 2, benchOnly: true, optional: true })]),
    ];
  });
  const empty = board(f);
  assert(!empty.view(0).legalActions.some((a) => ['move', 'attach'].includes(a.abilityId)));
  const g = board(f, (s) => {
    const m = s.players[0].active; m.counters = 2; bench(s, 0, 'other');
    const id = hand(s, 0, 'water'); s.players[0].hand.splice(s.players[0].hand.indexOf(id), 1); s.players[0].discard.push(id);
  });
  assert(g.view(0).legalActions.some((a) => a.abilityId === 'move'));
  assert(g.view(0).legalActions.some((a) => a.abilityId === 'attach'));
  command(g, { type: 'useAbility', pokemonId: g.snapshot().players[0].active.id, abilityId: 'move' }); settle(g);
  assert.equal(g.snapshot().players[0].active.counters, 0);
  assert.equal(g.snapshot().players[0].bench[0].counters, 2, 'Insufficient public counters move as many as possible.');
  command(g, { type: 'useAbility', pokemonId: g.snapshot().players[0].active.id, abilityId: 'attach' });
  assert.equal(g.snapshot().pending.kind, 'discard-energy');
  answer(g, []); assert.equal(g.snapshot().players[0].bench[0].energy.length, 0);
  command(g, { type: 'useAbility', pokemonId: g.snapshot().players[0].active.id, abilityId: 'attach' });
  answer(g, [g.snapshot().pending.options[0]]); settle(g);
  assert.equal(g.snapshot().players[0].bench[0].energy.length, 1);
});

test('an activated Stadium uses per-player turn limits, does not end the turn and cannot draw from an empty deck', async () => {
  const drawHandler = createCoreHandlers().get('cn.draw@1');
  const h = { ...drawHandler, timing: 'onUse', implementationVersion: 'fixture-onuse-1',
    usage: { period: 'turn', scope: 'player', key: 'fixture-stadium', limit: 1 } };
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [binding('fixture:stadium-draw', { count: 1 })];
  }, new Map([['fixture:stadium-draw', h]]));
  const g = board(f, (s) => hand(s, 0, 'stadium'));
  command(g, g.view(0).legalActions.find((a) => a.type === 'playTrainer' && g.snapshot().cards[a.cardId].definitionId === 'stadium'));
  const before = g.snapshot();
  command(g, { type: 'useStadium' });
  assert.equal(g.snapshot().current, 0); assert.equal(g.snapshot().players[0].hand.length, before.players[0].hand.length + 1);
  assert(!g.view(0).legalActions.some((a) => a.type === 'useStadium'));
  command(g, { type: 'endTurn' }); settle(g);
  assert(g.view(1).legalActions.some((a) => a.type === 'useStadium'));
  command(g, { type: 'useStadium' }); command(g, { type: 'endTurn' }); settle(g);
  assert(g.view(0).legalActions.some((a) => a.type === 'useStadium'));
  const snapshot = g.snapshot(), p = snapshot.players[0]; p.hand.push(...p.deck.splice(0));
  assert(!OfficialGame.restore(snapshot, { catalog: f.catalog }).view(0).legalActions.some((a) => a.type === 'useStadium'));
});

test('catalog printing lookup returns reviewed identity and rejects unknown IDs', async () => {
  const f = await fixture();
  assert.equal(f.catalog.printing('printing:base').printingId, 'printing:base');
  assert.throws(() => f.catalog.printing('unknown-printing'), /Unknown printing/);
});

test('semantic hooks cannot declare actions that their timing would silently skip', async () => {
  const h = { rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE, timing: 'damageOptions', operations: ['draw'],
    damageOptions: () => ({ ignoreDefenderEffects: true }), validateParameters: () => true,
    execute: () => [draw(1)] };
  const f = await fixture((defs) => defs[0].mechanics.attacks[0].effects.push(binding('fixture:bad-hook', {})),
    new Map([['fixture:bad-hook', h]]));
  assert.throws(() => board(f), /Unimplemented or undeclared/);
});
