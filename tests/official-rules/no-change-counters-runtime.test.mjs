import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { paymentOptionId } from '../../public/rules/activation-cost.js';
import {
  fixture, binding, EVIDENCE, board, fixtureClock, hand, bench, attached, command, answer, settle,
} from './fixtures.mjs';

// Synthetic fixed-count native instructions only. CN advanced I.A-02 p8,
// I.B-01 p11 and I.B-03 p12 prohibit a knowingly unchanged voluntary use;
// CN E-29 p68–69 separately permits the specified hand Trainer use despite
// prevention. An ordinary synthetic shield is not that special permission.
// C-07 protection still does not remove an otherwise selectable subject.
const clone = (value) => JSON.parse(JSON.stringify(value));
const slots = ['item', 'supporter', 'ability'];
const mons = (s, owner) => [s.players[owner].active, ...s.players[owner].bench].filter(Boolean);
const fee = () => ({
  costId: 'fee', kind: 'discardHand', count: 1,
  selector: { kind: 'energy' }, sourceOfTruth: EVIDENCE,
});
const trainerId = (slot) => slot === 'supporter' ? 'research' : 'potion';
const sourceCategory = (slot) => slot === 'attack' ? 'attack' : slot === 'ability' ? 'ability' : 'trainer';

function shield(slot, side, extra = {}) {
  return {
    op: 'protection', useRule: 'ordinary', channel: 'effects', scope: 'self',
    from: side === 'own' ? 'own' : 'opponent', categories: [sourceCategory(slot)],
    ...(['item', 'supporter'].includes(slot) ? {
      trainerCategories: [slot], trainerOrigins: ['hand'],
    } : {}),
    ...extra,
  };
}

async function fixed({
  slot = 'item', side = 'opponent', target = 'any', count = 2, paid = false, draw = false,
  protection = null, protectedDefinitions = ['base', 'other'], mutate = () => {}, extraHandlers = new Map(),
} = {}) {
  return fixture((definitions) => {
    const effects = [binding('cn.counters@1', { side, target, count }, 'no-change-fixed-counters')];
    if (draw) effects.push(binding('cn.draw@1', { count: 1 }, 'independent-draw'));
    if (slot === 'ability') {
      definitions[0].mechanics.abilities.push({
        abilityId: 'fixed-counter', name: '测试固定指示物', mode: 'activated',
        usage: { period: 'turn', scope: 'pokemon', key: 'fixed-counter', limit: 1 },
        ...(paid ? { costs: [fee()] } : {}), effects, sourceOfTruth: EVIDENCE,
      });
    } else if (slot === 'attack') {
      definitions[0].mechanics.attacks[0].effects = effects;
    } else {
      const definition = definitions.find((d) => d.definitionId === trainerId(slot));
      definition.mechanics.effects = effects;
      if (paid) definition.mechanics.playCosts = [fee()];
    }
    if (protection) for (const definition of definitions.filter((d) =>
      protectedDefinitions.includes(d.definitionId))) {
      definition.mechanics.effects.push(binding('cn.protection@1',
        { effect: protection }, `shield-${definition.definitionId}`));
    }
    mutate(definitions);
  }, extraHandlers);
}

function exactHand(s, owner, definitions) {
  const p = s.players[owner], result = [];
  p.discard.push(...p.hand.splice(0));
  for (const definitionId of definitions) {
    const id = hand(s, owner, definitionId);
    p.hand.pop(); p.resolving.push(id); result.push(id);
  }
  for (const id of result) {
    p.resolving.splice(p.resolving.indexOf(id), 1); p.hand.push(id);
  }
  return result;
}

function prepare(f, {
  slot = 'item', owner = 0, side = 'opponent', paid = false, benches = 1, mutate = () => {},
} = {}) {
  let sourceId, fees, targets;
  const recipient = side === 'own' ? owner : 1 - owner;
  const g = board(f, (s) => {
    if (owner === 1) fixtureClock(s, [0, 1, 0, 1]);
    const ids = exactHand(s, owner, [
      ...(['item', 'supporter'].includes(slot) ? [trainerId(slot)] : []),
      ...(paid ? ['water'] : []),
    ]);
    sourceId = ['item', 'supporter'].includes(slot) ? ids[0] : s.players[owner].active.stack.at(-1);
    fees = paid ? [ids.at(-1)] : [];
    if (slot === 'attack') attached(s, owner, s.players[owner].active, 'water');
    for (let i = 0; i < benches; i++) bench(s, recipient, 'other');
    targets = mons(s, recipient).map((m) => m.id);
    mutate(s, { sourceId, fees, targets, recipient });
  });
  const action = slot === 'ability' ?
    { type: 'useAbility', pokemonId: g.snapshot().players[owner].active.id, abilityId: 'fixed-counter' } :
    slot === 'attack' ? { type: 'attack', attackId: 'base:strike' } :
      { type: 'playTrainer', cardId: sourceId };
  return { g, sourceId, fees, targets, recipient, owner, slot, action };
}

function offered(g, setup) {
  return g.view(setup.owner).legalActions.some((action) =>
    Object.keys(action).length === Object.keys(setup.action).length &&
    Object.entries(setup.action).every(([key, value]) => action[key] === value));
}

function restored(g, f) {
  const saved = g.snapshot(), result = OfficialGame.restore(clone(saved), { catalog: f.catalog });
  assert.deepEqual(result.snapshot(), saved);
  assert.deepEqual([result.view(0), result.view(1)], [g.view(0), g.view(1)]);
  assert.deepEqual(g.snapshot(), saved, 'Reading eligibility/projections must not log protection checks.');
  assert.deepEqual(result.snapshot(), saved);
  return result;
}

function atomic(g, perform, code = undefined) {
  const saved = g.snapshot();
  const views = [g.view(0), g.view(1)];
  assert.deepEqual(g.snapshot(), saved);
  assert.throws(perform, code ? { code } : undefined);
  assert.deepEqual(g.snapshot(), saved, 'Rejected work must leave cards, use limits, RNG, logs and revision intact.');
  assert.deepEqual([g.view(0), g.view(1)], views);
  assert.deepEqual(g.snapshot(), saved);
}

function unusable(setup, f) {
  const { g, action, owner } = setup, before = g.snapshot();
  for (const viewer of [owner, 1 - owner, owner]) g.view(viewer);
  assert.deepEqual(g.snapshot(), before, 'Qualification is read-only, even with a known effects shield.');
  assert.equal(offered(g, setup), false);
  atomic(g, () => command(g, action, owner), 'illegal-action');
  assert.deepEqual(g.snapshot(), before);
  restored(g, f);
}

function conservation(before, after) {
  assert.deepEqual(after.cards, before.cards);
  const physical = [];
  for (const [owner, p] of after.players.entries()) {
    const owned = ['hand', 'deck', 'prizes', 'discard', 'lost', 'resolving'].flatMap((zone) => p[zone]);
    for (const m of mons(after, owner)) owned.push(...m.stack, ...m.energy, ...m.tools);
    assert(owned.every((id) => after.cards[id].owner === owner));
    physical.push(...owned);
  }
  if (after.stadium) physical.push(after.stadium);
  assert.deepEqual(physical.sort(), Object.keys(before.cards).sort(), 'All original physical cards occur exactly once.');
  assert.deepEqual(after.rng, before.rng);
}

function consumed(setup, before, after) {
  const { owner, slot, sourceId, fees } = setup, p = after.players[owner];
  for (const id of fees) assert.equal(p.discard.filter((card) => card === id).length, 1);
  const costs = (s) => s.events.filter((event) => event.ruleId === 'effects.activation-cost').length;
  assert.equal(costs(after) - costs(before), Number(fees.length > 0));
  if (slot === 'ability') assert.equal(p.active.used['fixed-counter'].length, 1);
  else {
    assert.equal(p.discard.filter((card) => card === sourceId).length, 1);
    assert.equal(p.flags.supporter, slot === 'supporter' || before.players[owner].flags.supporter);
  }
  conservation(before, after);
}

test('zero counters fail the native parameter and catalog contracts, rather than creating an invalid runtime Item, Supporter or Ability', async () => {
  const native = createCoreHandlers().get('cn.counters@1');
  const parameters = { side: 'opponent', target: 'any', count: 0 }, before = clone(parameters);
  assert.equal(native.validateParameters(parameters), false);
  assert.deepEqual(parameters, before);
  for (const slot of slots) {
    await assert.rejects(fixed({ slot, count: 0, paid: true }), /Invalid parameters for handler: cn\.counters@1/);
  }
});

test('an absent Bench candidate prevents native fixed counters for both actors and relative sides, even with a payable fee', async () => {
  for (const slot of slots) for (const side of ['own', 'opponent']) {
    const f = await fixed({ slot, side, target: 'bench', paid: true });
    for (const owner of [0, 1]) {
      const setup = prepare(f, { slot, owner, side, paid: true, benches: 0 });
      assert.equal(setup.g.snapshot().players[setup.recipient].bench.length, 0);
      unusable(setup, f);
    }
  }
});

test('ordinary synthetic shields without the CN.E29 use permission make a wholly protected lone native counter binding unusable without qualification logs', async () => {
  for (const slot of slots) for (const side of ['own', 'opponent']) {
    const f = await fixed({ slot, side, paid: true, protection: shield(slot, side) });
    for (const owner of [0, 1]) {
      const setup = prepare(f, { slot, owner, side, paid: true });
      assert.equal(setup.targets.length, 2);
      unusable(setup, f);
    }
  }
});

test('one unprotected candidate permits paid use but protected candidates remain selectable and can legitimately produce a no-op after restore', async () => {
  for (const slot of slots) for (const owner of [0, 1]) {
    const side = owner === 0 ? 'opponent' : 'own';
    const f = await fixed({ slot, side, paid: true,
      protection: shield(slot, side), protectedDefinitions: ['other'] });
    const setup = prepare(f, { slot, owner, side, paid: true }), before = setup.g.snapshot();
    let g = setup.g;
    assert(offered(g, setup));
    assert.deepEqual(g.snapshot(), before);
    command(g, setup.action, owner);
    assert.equal(g.snapshot().pending.kind, 'activation-cost');
    assert.deepEqual(g.snapshot().players[owner].active.used, before.players[owner].active.used);
    assert.equal(g.snapshot().players[owner].flags.supporter, false);
    atomic(g, () => answer(g, []));
    g = restored(g, f);
    answer(g, setup.fees.map((id) => paymentOptionId('fee', id)));
    const pending = g.snapshot().pending;
    assert.equal(pending.kind, 'effect-target');
    assert.equal(pending.player, owner);
    assert.deepEqual(pending.options, setup.targets, 'Eligibility must not turn protection into a selection prohibition.');
    assert.equal(pending.data.source.owner, owner);
    assert.equal(pending.data.source.cardOwner, owner);
    assert.equal(pending.data.source.category, sourceCategory(slot));
    assert.equal(pending.data.source.origin, slot === 'ability' ? 'field' : 'hand');
    atomic(g, () => answer(g, ['not-a-live-subject']));
    const checkpoint = restored(g, f);
    for (const [index, expectedCounters] of [[0, 2], [1, 0]]) {
      const branch = restored(checkpoint, f);
      answer(branch, [setup.targets[index]]); settle(branch);
      const after = branch.snapshot();
      assert.deepEqual(mons(after, setup.recipient).map((m) => m.counters),
        index === 0 ? [expectedCounters, 0] : [0, expectedCounters]);
      const placements = after.events.slice(before.events.length).filter((event) =>
        event.ruleId === 'damage.counters' && event.data.operation === 'counters');
      assert.equal(placements.length, Number(index === 0));
      const blocks = after.events.slice(before.events.length).filter((event) => event.ruleId === 'effects.protection');
      assert.equal(blocks.length, Number(index === 1));
      consumed(setup, before, after); restored(branch, f);
    }
  }
});

test('damage-only shields and mismatching hand-origin/category/relation filters do not deny counter effects', async () => {
  for (const slot of slots) {
    const side = 'opponent', actual = shield(slot, side);
    const variants = [
      { ...actual, channel: 'damage' },
      { ...actual, from: 'own' },
      ...(['item', 'supporter'].includes(slot) ? [
        { ...actual, trainerOrigins: ['field'] },
        { ...actual, trainerCategories: [slot === 'item' ? 'supporter' : 'item'] },
      ] : [{ ...actual, categories: ['attack'] }]),
    ];
    for (const [i, protection] of variants.entries()) {
      assert.equal(protection.useRule, 'ordinary', 'Mismatching/field-origin shields are not the CN.E29 hand permission.');
      const owner = i % 2, f = await fixed({ slot, side, protection });
      const setup = prepare(f, { slot, side, owner }), before = setup.g.snapshot();
      let g = setup.g;
      assert(offered(g, setup));
      assert.deepEqual(g.snapshot(), before);
      command(g, setup.action, owner);
      assert.equal(g.snapshot().pending.kind, 'effect-target');
      assert.deepEqual(g.snapshot().pending.options, setup.targets);
      g = restored(g, f); answer(g, [setup.targets[1]]); settle(g);
      assert.deepEqual(mons(g.snapshot(), setup.recipient).map((m) => m.counters), [0, 2]);
      assert(!g.snapshot().events.slice(before.events.length).some((event) => event.ruleId === 'effects.protection'));
      consumed(setup, before, g.snapshot()); restored(g, f);
    }
  }
});

test('an independent draw binding keeps paid Item, Supporter and Ability use legal when this fixed counter leaf is entirely protected', async () => {
  for (const slot of slots) for (const owner of [0, 1]) {
    const side = owner === 0 ? 'opponent' : 'own';
    const f = await fixed({ slot, side, paid: true, draw: true, protection: shield(slot, side) });
    const setup = prepare(f, { slot, owner, side, paid: true }), before = setup.g.snapshot();
    let g = setup.g;
    assert(offered(g, setup));
    command(g, setup.action, owner);
    assert.equal(g.snapshot().pending.kind, 'activation-cost');
    g = restored(g, f); answer(g, setup.fees.map((id) => paymentOptionId('fee', id)));
    assert.equal(g.snapshot().pending.kind, 'effect-target');
    assert.deepEqual(g.snapshot().pending.options, setup.targets);
    g = restored(g, f); answer(g, [setup.targets[1]]); settle(g);
    const after = g.snapshot();
    assert.deepEqual(mons(after, setup.recipient).map((m) => m.counters), [0, 0]);
    assert.equal(after.players[owner].deck.length, before.players[owner].deck.length - 1);
    assert.equal(after.players[owner].hand.length, before.players[owner].hand.length -
      setup.fees.length - Number(slot !== 'ability') + 1);
    assert(after.events.slice(before.events.length).some((event) => event.ruleId === 'effects.draw' &&
      event.data.player === owner && event.data.count === 1));
    consumed(setup, before, after); restored(g, f);
  }
});

test('an attack retains its printed damage and independent draw when its fixed counter leaf has only protected targets or no Bench candidates', async () => {
  for (const owner of [0, 1]) for (const empty of [false, true]) {
    const slot = 'attack', side = 'own';
    const f = await fixed({ slot, side, target: empty ? 'bench' : 'any', draw: true,
      protection: empty ? null : shield(slot, side) });
    const setup = prepare(f, { slot, owner, side, benches: empty ? 0 : 1 }), before = setup.g.snapshot();
    let g = setup.g;
    assert(offered(g, setup));
    command(g, setup.action, owner);
    if (!empty) {
      assert.equal(g.snapshot().pending.kind, 'effect-target');
      assert.deepEqual(g.snapshot().pending.options, setup.targets);
      g = restored(g, f); answer(g, [setup.targets[1]]);
    }
    settle(g);
    const after = g.snapshot();
    assert.equal(after.players[1 - owner].active.counters, 2, 'The printed 20 damage is not the counter effect.');
    assert(mons(after, owner).every((m) => m.counters === 0));
    assert.equal(after.players[owner].deck.length, before.players[owner].deck.length - 1);
    assert(after.events.some((event) => event.ruleId === 'attack.used' && event.data.player === owner));
    assert.equal(after.attack, null);
    assert.equal(f.catalog.definition('base').mechanics.attacks[0].printedDamage.value, 20);
    conservation(before, after); restored(g, f);
  }
});

test('a fixed count exceeding the exact counter-storage limit is atomically rejected, never clipped to remaining HP', async () => {
  const slot = 'ability', owner = 1, side = 'own', limit = 900719925474099;
  const f = await fixed({ slot, side, target: 'active', count: 2, mutate: (definitions) => {
    definitions[0].mechanics.hp = 9007199254740990;
  } });
  const setup = prepare(f, { slot, owner, side, benches: 0, mutate: (s) => {
    s.players[owner].active.counters = limit - 1;
  } });
  let g = setup.g;
  assert(offered(g, setup));
  command(g, setup.action, owner);
  assert.equal(g.snapshot().pending.kind, 'effect-target');
  g = restored(g, f);
  const beforeAnswer = g.snapshot();
  atomic(g, () => answer(g, [setup.targets[0]]), 'numeric-overflow');
  assert.equal(g.snapshot().players[owner].active.counters, limit - 1);
  assert.deepEqual(g.snapshot(), beforeAnswer);
  conservation(beforeAnswer, g.snapshot()); restored(g, f);
});

test('CN.E29 explicitly permits the actual hand Item or Supporter despite all candidates preventing its counter effects, and still consumes the Trainer', async () => {
  for (const slot of ['item', 'supporter']) for (const owner of [0, 1]) {
    const side = 'opponent';
    const protection = shield(slot, side, {
      useRule: 'CN.E29', trainerCategories: ['item', 'supporter'],
    });
    assert.deepEqual(protection.categories, ['trainer']);
    assert.deepEqual(protection.trainerOrigins, ['hand']);
    const f = await fixed({ slot, side, protection });
    const setup = prepare(f, { slot, owner, side }), before = setup.g.snapshot();
    let g = setup.g;
    assert(offered(g, setup), 'CN.E29 is a specific permission to play, not proof that counters can bypass prevention.');
    assert.deepEqual(g.snapshot(), before);
    command(g, setup.action, owner);
    assert.equal(g.snapshot().pending.kind, 'effect-target');
    assert.deepEqual(g.snapshot().pending.options, setup.targets);
    assert.equal(g.snapshot().pending.data.source.origin, 'hand');
    assert.equal(g.snapshot().pending.data.source.owner, owner);
    assert.equal(g.snapshot().players[owner].flags.supporter, slot === 'supporter');
    g = restored(g, f); answer(g, [setup.targets[1]]); settle(g);
    const after = g.snapshot(), events = after.events.slice(before.events.length);
    assert.deepEqual(mons(after, setup.recipient).map((m) => m.counters), [0, 0]);
    assert(!events.some((event) => event.ruleId === 'damage.counters' && event.data.operation === 'counters'));
    assert(events.some((event) => event.ruleId === 'effects.protection' && event.data.targetId === setup.targets[1]));
    consumed(setup, before, after); restored(g, f);
  }
});

test('CN.E29 permission is not performed: blocked counter text cannot unlock then, while the identical unprotected text can', async () => {
  const program = [{
    op: 'then', first: { op: 'counters', side: 'opponent', target: 'any', count: 2 },
    next: { op: 'draw', count: 1 },
  }];
  const handlerId = 'fixture:cn-e29-counter-then';
  const handler = {
    rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE, operations: ['then', 'counters', 'draw'],
    validateParameters: (parameters) => Object.keys(parameters).length === 0,
    execute: () => clone(program), canUse: () => true,
  };
  for (const slot of ['item', 'supporter']) for (const blocked of [false, true]) {
    const owner = 1, side = 'opponent';
    const f = await fixed({
      slot, side,
      protection: blocked ? shield(slot, side, { useRule: 'CN.E29' }) : null,
      extraHandlers: new Map([[handlerId, handler]]),
      mutate: (definitions) => {
        definitions.find((d) => d.definitionId === trainerId(slot)).mechanics.effects = [
          binding(handlerId, {}, 'cn-e29-counter-then'),
        ];
      },
    });
    const setup = prepare(f, { slot, owner, side }), before = setup.g.snapshot();
    let g = setup.g;
    assert(offered(g, setup));
    command(g, setup.action, owner);
    assert.equal(g.snapshot().pending.kind, 'effect-target');
    assert.equal(g.snapshot().pending.data.source.origin, 'hand');
    assert(g.snapshot().pending.data.frames.some((frame) => frame.kind === 'then'));
    g = restored(g, f); answer(g, [setup.targets[1]]); settle(g);
    const after = g.snapshot(), drew = Number(!blocked);
    assert.deepEqual(mons(after, setup.recipient).map((m) => m.counters), [0, blocked ? 0 : 2]);
    assert.equal(after.players[owner].deck.length, before.players[owner].deck.length - drew);
    assert.equal(after.players[owner].hand.length, before.players[owner].hand.length - 1 + drew);
    assert.equal(after.events.slice(before.events.length).filter((event) =>
      event.ruleId === 'effects.draw' && event.data.player === owner).length, drew);
    consumed(setup, before, after); restored(g, f);
  }
});

test('CN.E29 does not waive a full activation fee, permit partial payment, or grant the same exception to an ordinary synthetic shield', async () => {
  for (const slot of ['item', 'supporter']) {
    const owner = 0, side = 'opponent';
    const options = (useRule) => ({
      slot, side, paid: true, protection: shield(slot, side, { useRule }),
      mutate: (definitions) => {
        definitions.find((d) => d.definitionId === trainerId(slot)).mechanics.playCosts = [
          { ...fee(), count: 2 },
        ];
      },
    });
    const f = await fixed(options('CN.E29'));
    const short = prepare(f, { slot, owner, side, paid: true });
    assert.equal(short.fees.length, 1);
    unusable(short, f);
    const addSecondFee = (s, { fees }) => { fees.push(hand(s, owner, 'water')); };
    const setup = prepare(f, { slot, owner, side, paid: true, mutate: addSecondFee });
    const before = setup.g.snapshot();
    let g = setup.g;
    assert(offered(g, setup));
    command(g, setup.action, owner);
    assert.equal(g.snapshot().pending.kind, 'activation-cost');
    assert.equal(g.snapshot().pending.minimum, 2);
    assert(g.snapshot().players[owner].hand.includes(setup.sourceId));
    assert.equal(g.snapshot().players[owner].flags.supporter, false);
    const payment = setup.fees.map((id) => paymentOptionId('fee', id));
    atomic(g, () => answer(g, []));
    atomic(g, () => answer(g, payment.slice(0, 1)));
    atomic(g, () => answer(g, [payment[0], payment[0]]));
    g = restored(g, f); answer(g, payment);
    assert.equal(g.snapshot().pending.kind, 'effect-target');
    assert.equal(g.snapshot().players[owner].flags.supporter, slot === 'supporter');
    assert.equal(g.snapshot().pending.data.source.origin, 'hand');
    g = restored(g, f); answer(g, [setup.targets[0]]); settle(g);
    assert.deepEqual(mons(g.snapshot(), setup.recipient).map((m) => m.counters), [0, 0]);
    consumed(setup, before, g.snapshot()); restored(g, f);
    const ordinary = await fixed(options('ordinary'));
    unusable(prepare(ordinary, { slot, owner, side, paid: true, mutate: addSecondFee }), ordinary);
  }
});
