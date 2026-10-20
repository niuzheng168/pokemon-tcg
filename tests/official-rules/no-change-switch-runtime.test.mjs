// Real OfficialGame regressions using reviewed SYNTHETIC fixtures only.
// These tests neither approve real cards nor supply defaults from other regions.
// "ordinary" below is an abstract policy without a use permission, NOT a claim
// that every real hand-Trainer immunity forbids playing the Trainer. CN E-29
// p68–69 explicitly permits that use without making the blocked effect perform.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { validateSwitchParameters } from '../../public/rules/schema-validators.js';
import { paymentOptionId } from '../../public/rules/activation-cost.js';
import {
  fixture, binding, EVIDENCE, board, command, answer, hand, bench, attached, fixtureClock,
} from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const parameters = (side = 'opponent', chooser = 'self', affected = 'selected') => ({ side, chooser, affected });
const sourceCases = [['trainer', 'potion'], ['trainer', 'research'], ['ability', 'potion']];
const mons = (s, owner) => [s.players[owner].active, ...s.players[owner].bench].filter(Boolean);
const moves = (s) => s.battleHistory.events.filter((event) => event.kind === 'benchToActive');
const protections = (s) => s.events.filter((event) => event.ruleId === 'effects.protection');
const fee = () => ({
  costId: 'fee', kind: 'discardHand', count: 1,
  selector: { kind: 'energy', category: 'basic' }, sourceOfTruth: EVIDENCE,
});
const ability = (effects, paid) => ({
  abilityId: 'no-change-switch', name: '测试无变化交换', mode: 'activated',
  usage: { period: 'turn', scope: 'pokemon', key: 'no-change-switch', limit: 1 },
  effects, sourceOfTruth: EVIDENCE, ...(paid ? { costs: [fee()] } : {}),
});
function shield(p, slot, trainer, scope, overrides) {
  const effect = {
    op: 'protection', useRule: 'ordinary', channel: 'effects', scope,
    from: p.side === 'own' ? 'own' : 'opponent',
    categories: [slot === 'trainer' ? 'trainer' : slot],
    ...(slot === 'trainer' ? {
      trainerCategories: [trainer === 'research' ? 'supporter' : 'item'],
      trainerOrigins: ['hand'],
    } : {}),
    ...overrides,
  };
  // Trainer-specific filters are invalid without the trainer category.
  if (!effect.categories.includes('trainer')) {
    delete effect.trainerCategories; delete effect.trainerOrigins;
  }
  return effect;
}
async function make(p = parameters(), {
  slot = 'trainer', trainer = 'potion', paid = false, shieldAt = 'none', shieldOverrides = {}, draw = false,
} = {}) {
  return fixture((defs) => {
    const effects = [binding('cn.switch@1', p, 'no-change-switch')];
    if (draw) effects.push(binding('cn.draw@1', { count: 1 }, 'independent-switch-draw'));
    if (slot === 'trainer') {
      const mechanics = defs.find((d) => d.definitionId === trainer).mechanics;
      mechanics.effects = effects;
      if (paid) mechanics.playCosts = [fee()];
    } else if (slot === 'ability') defs[0].mechanics.abilities.push(ability(effects, paid));
    else {
      defs[0].mechanics.attacks[0].printedDamage = { value: 20, operator: 'fixed' };
      defs[0].mechanics.attacks[0].effects = effects;
    }
    if (['active', 'mixed', 'all'].includes(shieldAt)) {
      defs[0].mechanics.effects.push(binding('cn.protection@1', {
        effect: shield(p, slot, trainer, shieldAt === 'all' ? 'own' : 'self', shieldOverrides),
      }, 'active-switch-shield'));
    }
    if (['bench', 'mixed'].includes(shieldAt)) {
      defs[1].mechanics.effects.push(binding('cn.protection@1', {
        effect: shield(p, slot, trainer, 'self', shieldOverrides),
      }, 'bench-switch-shield'));
    }
  });
}
function setHand(s, owner, definitions) {
  const p = s.players[owner], ids = [];
  p.discard.push(...p.hand.splice(0));
  for (const definitionId of definitions) {
    const id = hand(s, owner, definitionId); p.hand.pop(); p.resolving.push(id); ids.push(id);
  }
  for (const id of ids) { p.resolving.splice(p.resolving.indexOf(id), 1); p.hand.push(id); }
  return ids;
}
function setup(f, p, {
  owner = 0, slot = 'trainer', trainer = 'potion', paid = false, names = ['other', 'other'],
  attachedFee = false, mutate = () => {},
} = {}) {
  const context = { owner, slot, trainer, targetOwner: p.side === 'own' ? owner : 1 - owner };
  context.g = board(f, (s) => {
    if (owner === 1) fixtureClock(s, [0, 1, 0, 1]);
    context.sourcePokemonId = s.players[owner].active.id;
    context.oldActiveId = s.players[context.targetOwner].active.id;
    context.choices = names.map((name) => bench(s, context.targetOwner, name).id);
    const ids = setHand(s, owner, [...(slot === 'trainer' ? [trainer] : []), ...(paid ? ['water'] : [])]);
    context.sourceId = slot === 'trainer' ? ids[0] : s.players[owner].active.stack.at(-1);
    context.feeCardId = paid ? ids.at(-1) : null;
    if (slot === 'attack' || attachedFee) attached(s, owner, s.players[owner].active, 'water');
    mutate(s, context);
    s.events = [];
  });
  return context;
}
const use = (g, c) => command(g, c.slot === 'trainer' ? { type: 'playTrainer', cardId: c.sourceId } :
  c.slot === 'ability' ? { type: 'useAbility', pokemonId: c.sourcePokemonId, abilityId: 'no-change-switch' } :
    { type: 'attack', attackId: 'base:strike' }, c.owner);
const isOffered = (g, c) => g.view(c.owner).legalActions.some((a) => c.slot === 'trainer' ?
  a.type === 'playTrainer' && a.cardId === c.sourceId : c.slot === 'ability' ?
    a.type === 'useAbility' && a.pokemonId === c.sourcePokemonId && a.abilityId === 'no-change-switch' :
    a.type === 'attack' && a.attackId === 'base:strike');
function restored(g, f) {
  const saved = g.snapshot(), r = OfficialGame.restore(clone(saved), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), saved);
  assert.deepEqual([r.view(0), r.view(1)], [g.view(0), g.view(1)]);
  return r;
}
function respond(g, f, selected) {
  const r = restored(g, f);
  answer(g, selected); answer(r, selected);
  assert.deepEqual(r.snapshot(), g.snapshot(), 'A restored choice must perform the same switch, finalizer and remaining text once.');
  return restored(g, f);
}
function atomic(g, fn) {
  const saved = g.snapshot(), views = [g.view(0), g.view(1)];
  assert.throws(fn);
  assert.deepEqual(g.snapshot(), saved); assert.deepEqual([g.view(0), g.view(1)], views);
}
function assertPrompt(g, c, p) {
  const q = g.snapshot().pending, chooser = p.chooser === 'self' ? c.owner : 1 - c.owner;
  assert.equal(q.kind, 'effect-target'); assert.equal(q.player, chooser);
  assert.deepEqual(q.options, c.choices);
  assert.equal(q.minimum, 1); assert.equal(q.maximum, 1);
  assert(g.view(chooser).pending); assert.equal(g.view(1 - chooser).pending, null);
  assert(!q.options.includes(c.oldActiveId));
}
function assertFinalized(s, before, c) {
  assert.equal(s.pending, null); assert.deepEqual(s.cards, before.cards); assert.deepEqual(s.rng, before.rng);
  if (c.slot === 'trainer') {
    assert.equal(s.players[c.owner].discard.filter((id) => id === c.sourceId).length, 1);
    assert(!s.players[c.owner].hand.includes(c.sourceId)); assert(!s.players[c.owner].resolving.includes(c.sourceId));
    assert.equal(s.players[c.owner].flags.supporter, c.trainer === 'research');
  } else if (c.slot === 'ability') {
    assert.deepEqual(mons(s, c.owner).find((m) => m.id === c.sourcePokemonId).used['no-change-switch'], [before.turn]);
  }
}
function assertSwitch(s, before, c, incoming, blocked) {
  assert.equal(s.players[c.targetOwner].active.id, blocked ? c.oldActiveId : incoming);
  assert.deepEqual(moves(s).slice(moves(before).length), blocked ? [] : [{
    kind: 'benchToActive', turn: before.turn, during: c.owner, owner: c.targetOwner, pokemonId: incoming,
  }]);
}

test('native switching requires explicit side/chooser/affected, with self (not own) as the source-relative chooser', () => {
  const h = createCoreHandlers().get('cn.switch@1');
  assert.equal(h.validateParameters, validateSwitchParameters);
  for (const side of ['own', 'opponent']) for (const chooser of ['self', 'opponent'])
    for (const affected of ['active', 'selected']) {
      const p = parameters(side, chooser, affected);
      assert(h.validateParameters(p)); assert.deepEqual(h.execute({}, p), [{ op: 'switch', ...p }]);
    }
  for (const p of [
    { side: 'own', affected: 'active' }, { side: 'opponent', chooser: 'self' },
    parameters('opponent', 'own'), { ...parameters(), op: 'switch' }, { ...parameters(), approved: true },
  ]) assert.equal(h.validateParameters(p), false);
});

test('ordinary protection without a use permission forbids a wholly blocked native-only Item/Supporter/activated Ability without any cost, use, card, RNG or events', async () => {
  for (const [slot, trainer] of sourceCases) for (const affected of ['active', 'selected'])
    for (const paid of [false, true]) {
      const p = parameters('opponent', 'self', affected), shieldAt = affected === 'active' ? 'active' : 'bench';
      const f = await make(p, { slot, trainer, paid, shieldAt });
      const c = setup(f, p, { slot, trainer, paid }), g = c.g, before = g.snapshot();
      for (const viewer of [0, 1, 0]) g.view(viewer);
      assert.deepEqual(g.snapshot(), before, 'Readonly qualification must not log a hypothetical protection result.');
      assert.equal(isOffered(g, c), false, `${slot}/${trainer}/${affected}/paid=${paid}`);
      atomic(g, () => use(g, c));
      assert.deepEqual(g.snapshot(), before, 'Paying a fee or discarding a Trainer is not a qualifying body change.');
      assert.deepEqual(g.snapshot().events, []); assert.equal(g.snapshot().pending, null);
      assert.equal(g.snapshot().players[c.owner].flags.supporter, false);
      assert.deepEqual(g.snapshot().players[c.owner].active.used, before.players[c.owner].active.used);
      restored(g, f);
    }
});

test('both owners, both relative sides and both choosers use only the actually affected position for qualification, not shields on an unaffected position', async () => {
  for (const owner of [0, 1]) for (const side of ['own', 'opponent'])
    for (const chooser of ['self', 'opponent']) for (const affected of ['active', 'selected']) {
      const p = parameters(side, chooser, affected);
      // For active, all Bench are protected but Active is not. For selected,
      // Active is protected but the Bench are not.
      const f = await make(p, { shieldAt: affected === 'active' ? 'bench' : 'active' });
      const c = setup(f, p, { owner }), before = c.g.snapshot();
      assert(isOffered(c.g, c), `owner=${owner}/${side}/${chooser}/${affected}`);
      use(c.g, c); assertPrompt(c.g, c, p);
      const g = respond(c.g, f, [c.choices[1]]), after = g.snapshot();
      assertSwitch(after, before, c, c.choices[1], false);
      assert.equal(protections(after).length, 0);
      assert.equal(after.players[1 - c.targetOwner].active.id, before.players[1 - c.targetOwner].active.id);
      assertFinalized(after, before, c);
    }
});

test('one unprotected selected Bench permits ordinary-policy activation while protected choices remain selectable and may legitimately do nothing', async () => {
  for (const [slot, trainer] of sourceCases) for (const chooseBlocked of [false, true]) {
    const p = parameters(), f = await make(p, { slot, trainer, shieldAt: 'mixed' });
    const c = setup(f, p, { slot, trainer, names: ['other', 'evolution'] }), before = c.g.snapshot();
    assert(isOffered(c.g, c)); use(c.g, c); assertPrompt(c.g, c, p);
    const incoming = c.choices[chooseBlocked ? 0 : 1], g = respond(c.g, f, [incoming]), after = g.snapshot();
    assertSwitch(after, before, c, incoming, chooseBlocked);
    assert.equal(protections(after).length, Number(chooseBlocked));
    if (chooseBlocked) assert.equal(protections(after)[0].data.targetId, incoming,
      'Selected semantics do not check or report the shield on the old Active.');
    assertFinalized(after, before, c);
  }
});

test('CN.E29 explicitly permits a hand Item/Supporter despite full prevention, but selecting the protected affected Pokémon remains a no-op', async () => {
  for (const owner of [0, 1]) for (const trainer of ['potion', 'research'])
    for (const affected of ['active', 'selected']) {
      const p = parameters('opponent', 'self', affected), shieldAt = affected === 'active' ? 'active' : 'bench';
      const f = await make(p, { trainer, shieldAt, shieldOverrides: { useRule: 'CN.E29' } });
      const c = setup(f, p, { owner, trainer }), before = c.g.snapshot();
      assert(isOffered(c.g, c), `CN.E29/${trainer}/owner=${owner}/${affected}`);
      assert.deepEqual(c.g.snapshot(), before, 'Permission checks must not consume the card or emit hypothetical protection events.');
      use(c.g, c); assertPrompt(c.g, c, p);
      const q = c.g.snapshot().pending;
      assert.equal(q.data.source.category, 'trainer'); assert.equal(q.data.source.origin, 'hand');
      assert.equal(q.data.source.instanceId, c.sourceId); assert.equal(q.data.source.owner, owner);
      assert(c.g.snapshot().players[owner].resolving.includes(c.sourceId));
      const g = respond(c.g, f, [c.choices[1]]), after = g.snapshot();
      assertSwitch(after, before, c, c.choices[1], true);
      assert.equal(protections(after).length, 1);
      assert.equal(protections(after)[0].data.targetId, affected === 'active' ? c.oldActiveId : c.choices[1]);
      const partial = after.events.filter((e) => e.ruleId === 'effects.partial' &&
        e.data.effectId === 'fixture:no-change-switch' && e.data.operation === 'switch');
      assert.equal(partial.length, 1); assert.equal(partial[0].data.performed, false);
      assert.deepEqual(after.players[owner].deck, before.players[owner].deck);
      assert.deepEqual(after.players[owner].hand, before.players[owner].hand.filter((id) => id !== c.sourceId));
      assert(!after.events.some((e) => e.ruleId === 'effects.draw' || e.ruleId === 'effects.switch'));
      assertFinalized(after, before, c);
      assert.equal(after.events.filter((e) => e.ruleId === 'turn.trainer' &&
        e.data.kind === 'trainer-finished' && e.data.cardId === c.sourceId).length, 1);
    }
});

test('a reviewed synthetic Guzma-shaped whole then program has explicit CN.E29 hand-Supporter permission; its blocked first switch never unlocks the own switch', async () => {
  const p = parameters('opponent', 'self', 'selected'), id = 'fixture:e29-switch-then';
  const first = { op: 'switch', ...p }, next = { op: 'switch', ...parameters('own', 'self', 'active') };
  const program = [{ op: 'then', first, next }];
  const wholeProgram = {
    rulesetId: 'CN/V20261019', implementationVersion: 'synthetic-e29-switch-then-v1',
    timing: 'resolve', sourceOfTruth: EVIDENCE, operations: ['then', 'switch'],
    validateParameters: (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0,
    canUse: (ctx) => {
      const { source, state, definitions } = ctx, own = state.players[source.owner], opponent = state.players[1 - source.owner];
      const sourceDefinition = definitions[state.cards[source.instanceId].definitionId], target = opponent.bench[0];
      const targetDefinition = target && definitions[state.cards[target.stack.at(-1)].definitionId];
      // Explicit reviewed permission for THIS synthetic source/program/window:
      // its sole opposing Bench has the fixed native CN.E29 hand-Supporter
      // immunity. This is not a general proof for arbitrary custom programs,
      // nor a claim that the source is an approved real Guzma printing.
      return source.category === 'trainer' && source.origin === 'hand' &&
        sourceDefinition.definitionId === 'research' && sourceDefinition.mechanics.category === 'supporter' &&
        !!own.active && own.bench.length > 0 && !!opponent.active && opponent.bench.length === 1 &&
        targetDefinition.mechanics.effects.some((b) => {
          const e = b.parameters.effect;
          return b.handlerId === 'cn.protection@1' && e.useRule === 'CN.E29' &&
            e.channel === 'effects' && e.scope === 'self' && e.from === 'opponent' &&
            e.categories.length === 1 && e.categories[0] === 'trainer' &&
            e.trainerOrigins.length === 1 && e.trainerOrigins[0] === 'hand' &&
            e.trainerCategories.includes('supporter');
        });
    },
    execute: () => clone(program),
  };
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'research').mechanics.effects = [binding(id, {}, 'e29-whole-then')];
    defs[1].mechanics.effects.push(binding('cn.protection@1', {
      effect: shield(p, 'trainer', 'research', 'self', { useRule: 'CN.E29' }),
    }, 'e29-sole-bench-shield'));
  }, new Map([[id, wholeProgram]]));
  let ownIncoming;
  const c = setup(f, p, { trainer: 'research', names: ['other'], mutate: (s) => {
    ownIncoming = bench(s, 0, 'evolution').id;
  } }), before = c.g.snapshot();
  assert.deepEqual(f.catalog.definition('research').mechanics.effects.map((b) => b.handlerId), [id],
    'The dependent own switch must remain in the same whole program, not an independent qualifying binding.');
  assert.deepEqual(f.catalog.handler(id).execute({}, {}), program);
  assert(isOffered(c.g, c)); assert.deepEqual(c.g.snapshot(), before);
  use(c.g, c); assertPrompt(c.g, c, p);
  const q = c.g.snapshot().pending;
  assert.deepEqual(q.data.action, first); assert(q.data.frames.some((frame) => frame.kind === 'then' &&
    JSON.stringify(frame.next) === JSON.stringify(next)));
  assert.equal(q.data.source.category, 'trainer'); assert.equal(q.data.source.origin, 'hand');
  assert.equal(q.data.source.instanceId, c.sourceId);
  assert.equal(c.g.snapshot().players[0].flags.supporter, true);
  const g = respond(c.g, f, [c.choices[0]]), after = g.snapshot();
  assertSwitch(after, before, c, c.choices[0], true);
  assert.equal(after.players[0].active.id, before.players[0].active.id);
  assert(after.players[0].bench.some((m) => m.id === ownIncoming));
  for (const owner of [0, 1]) assert.deepEqual(mons(after, owner), mons(before, owner));
  const partial = after.events.filter((e) => e.ruleId === 'effects.partial' && e.data.effectId === 'fixture:e29-whole-then');
  assert.equal(partial.length, 1); assert.equal(partial[0].data.operation, 'switch');
  assert.equal(partial[0].data.performed, false, 'Permission to use and selecting a card do not make the first effect performed.');
  assert.equal(protections(after).length, 1); assert.equal(protections(after)[0].data.targetId, c.choices[0]);
  assert(!after.events.some((e) => e.ruleId === 'effects.switch'));
  assert.deepEqual(after.players[0].deck, before.players[0].deck);
  assertFinalized(after, before, c);
  const lifecycle = after.events.filter((e) => e.ruleId === 'turn.trainer' && e.data.cardId === c.sourceId);
  assert.deepEqual(lifecycle.map((e) => e.data.kind), ['trainer-open', 'trainer-finished']);
  assert.equal(lifecycle[1].data.id, lifecycle[0].data.id);
  assert.equal(after.battleHistory.events.filter((e) => e.kind === 'supporterPlayed' && e.cardId === c.sourceId).length, 1);
  assert.deepEqual(restored(g, f).snapshot(), after);
});

test('damage-only and mismatched source category/from/Trainer origin or category shields do not falsely forbid an actual switch', async () => {
  for (const [slot, trainer] of sourceCases) {
    const variants = [
      { channel: 'damage' }, { categories: ['attack'] }, { from: 'own' },
      ...(slot === 'trainer' ? [
        { trainerOrigins: ['field'] }, { trainerCategories: [trainer === 'research' ? 'item' : 'supporter'] },
      ] : []),
    ];
    for (const shieldOverrides of variants) for (const affected of ['active', 'selected']) {
      const p = parameters('opponent', 'self', affected);
      const f = await make(p, { slot, trainer, shieldAt: 'all', shieldOverrides });
      const c = setup(f, p, { slot, trainer }), before = c.g.snapshot();
      assert(isOffered(c.g, c), `${slot}/${trainer}/${affected}/${JSON.stringify(shieldOverrides)}`);
      use(c.g, c); assertPrompt(c.g, c, p);
      const g = respond(c.g, f, [c.choices[0]]), after = g.snapshot();
      assertSwitch(after, before, c, c.choices[0], false); assert.equal(protections(after).length, 0);
      assertFinalized(after, before, c);
    }
  }
});

test('an independent real draw binding qualifies the whole Trainer/Ability use even though every possible switch is blocked', async () => {
  for (const [slot, trainer] of sourceCases) for (const affected of ['active', 'selected']) {
    const p = parameters('opponent', 'self', affected), f = await make(p, { slot, trainer, shieldAt: 'all', draw: true });
    const c = setup(f, p, { slot, trainer }), before = c.g.snapshot();
    assert(isOffered(c.g, c)); use(c.g, c); assertPrompt(c.g, c, p);
    const g = respond(c.g, f, [c.choices[0]]), after = g.snapshot();
    assertSwitch(after, before, c, c.choices[0], true);
    assert.equal(protections(after).length, 1);
    assert.equal(protections(after)[0].data.targetId, affected === 'active' ? c.oldActiveId : c.choices[0]);
    assert.equal(after.players[c.owner].deck.length, before.players[c.owner].deck.length - 1);
    assert(after.players[c.owner].hand.includes(before.players[c.owner].deck.at(-1)));
    assert.deepEqual(after.players[c.owner].deck, before.players[c.owner].deck.slice(0, -1));
    assert(after.events.some((e) => e.ruleId === 'effects.draw' && e.data.player === c.owner && e.data.count === 1));
    assertFinalized(after, before, c);
  }
});

test('all-blocked attack switching does not prohibit its printed damage or independent remaining draw text', async () => {
  for (const affected of ['active', 'selected']) {
    const p = parameters('opponent', 'opponent', affected);
    const f = await make(p, { slot: 'attack', shieldAt: 'all', draw: true });
    const c = setup(f, p, { slot: 'attack' }), before = c.g.snapshot();
    assert(isOffered(c.g, c)); use(c.g, c); assertPrompt(c.g, c, p);
    const g = respond(c.g, f, [c.choices[1]]), after = g.snapshot();
    assertSwitch(after, before, c, c.choices[1], true);
    assert.equal(after.players[c.targetOwner].active.counters, before.players[c.targetOwner].active.counters + 2);
    assert.equal(after.players[c.owner].deck.length, before.players[c.owner].deck.length - 1);
    assert(after.players[c.owner].hand.includes(before.players[c.owner].deck.at(-1)));
    assert.deepEqual(after.players[c.owner].deck, before.players[c.owner].deck.slice(0, -1));
    assert.equal(protections(after).length, 1); assert.equal(after.attack, null); assert.equal(after.current, 1 - c.owner);
    assertFinalized(after, before, c);
  }
});

test('a static hand cost belongs to the source, restores before payment and the other player’s choice, and is charged only once', async () => {
  for (const [slot, trainer] of [['trainer', 'research'], ['ability', 'potion']]) {
    const p = parameters('opponent', 'opponent', 'selected');
    const f = await make(p, { slot, trainer, paid: true, shieldAt: 'mixed' });
    const c = setup(f, p, {
      owner: 1, slot, trainer, paid: true, names: ['other', 'evolution'], attachedFee: true,
    }), before = c.g.snapshot();
    let g = c.g;
    assert(isOffered(g, c)); use(g, c);
    assert.equal(g.snapshot().pending.kind, 'activation-cost'); assert.equal(g.snapshot().pending.player, c.owner);
    const paid = [paymentOptionId('fee', c.feeCardId)];
    for (const bad of [[], [paymentOptionId('wrong-fee', c.feeCardId)], [paid[0], paid[0]],
      [paymentOptionId('fee', before.players[c.owner].active.energy[0])]]) atomic(g, () => answer(g, bad));
    g = respond(g, f, paid); assertPrompt(g, c, p);
    assert.equal(g.snapshot().pending.player, 0, 'Source owner 1 pays, but chooser opponent means player 0 chooses.');
    assert.equal(g.snapshot().events.filter((e) => e.ruleId === 'effects.activation-cost').length, 1);
    assert.equal(g.snapshot().players[c.owner].discard.filter((id) => id === c.feeCardId).length, 1);
    assert.deepEqual(g.snapshot().players[c.owner].active.energy, before.players[c.owner].active.energy);
    const q = g.snapshot().pending;
    atomic(g, () => command(g, { type: 'answer', requestId: q.id, selected: [c.choices[1]] }, c.owner));
    atomic(g, () => answer(g, [c.oldActiveId]));
    atomic(g, () => answer(g, []));
    g = respond(g, f, [c.choices[1]]);
    const after = g.snapshot();
    assertSwitch(after, before, c, c.choices[1], false);
    assertFinalized(after, before, c); assert.equal(protections(after).length, 0);
    assert.equal(after.events.filter((e) => e.ruleId === 'effects.activation-cost').length, 1);
    assert.equal(after.players[c.owner].discard.filter((id) => id === c.feeCardId).length, 1);
    assert.deepEqual(after.players[c.owner].active.energy, before.players[c.owner].active.energy);
    atomic(g, () => command(g, { type: 'answer', requestId: q.id, selected: [c.choices[1]] }, q.player));
    atomic(g, () => use(g, c));
  }
});
