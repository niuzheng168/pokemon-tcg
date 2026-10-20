import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { validateSwitchParameters } from '../../public/rules/schema-validators.js';
import { paymentOptionId } from '../../public/rules/activation-cost.js';
import { wasMovedFromBenchToActiveThisTurn } from '../../public/rules/battle-history.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { OfficialGame } from '../../public/rules/game.js';
import { emptyConditions } from '../../public/rules/conditions.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const parameters = (side = 'own', chooser = 'self', affected = 'active') => ({ side, chooser, affected });
const switching = (p = parameters()) => binding('cn.switch@1', p);
const fee = (count = 1) => ({ costId: 'fee', kind: 'discardHand', count,
  selector: { kind: 'energy' }, sourceOfTruth: EVIDENCE });
const ability = (effects, extra = {}) => ({ abilityId: 'switch', name: '测试交换',
  mode: 'activated', usage: { period: 'unlimited', scope: 'pokemon', key: 'switch', limit: null },
  effects, sourceOfTruth: EVIDENCE, ...extra });
const restore = (g, f) => OfficialGame.restore(JSON.parse(JSON.stringify(g.snapshot())), { catalog: f.catalog });
const item = (defs, p = parameters(), costs) => {
  const mechanics = defs.find((d) => d.definitionId === 'potion').mechanics;
  mechanics.effects = [switching(p)]; if (costs) mechanics.playCosts = costs;
};
const play = (g, cardId) => command(g, { type: 'playTrainer', cardId });
const use = (g, pokemonId, abilityId = 'switch') => command(g, { type: 'useAbility', pokemonId, abilityId });
const moves = (s) => s.battleHistory.events.filter((e) => e.kind === 'benchToActive');
const moved = (s, owner, pokemonId) => wasMovedFromBenchToActiveThisTurn(s.battleHistory,
  { turn: s.turn, during: s.current }, owner, pokemonId);
const setHand = (s, owner, definitions) => {
  const p = s.players[owner]; p.discard.push(...p.hand.splice(0));
  const ids = definitions.map((definitionId) => {
    const id = hand(s, owner, definitionId); p.hand.pop(); p.resolving.push(id); return id;
  });
  for (const id of ids) { p.resolving.splice(p.resolving.indexOf(id), 1); p.hand.push(id); }
  return ids;
};
const activeOther = (s, owner) => {
  const p = s.players[owner], old = p.active; p.hand.push(...old.stack, ...old.energy, ...old.tools);
  p.active = bench(s, owner, 'other'); p.bench.pop(); return p.active;
};
const freeze = (value) => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

test('cn.switch@1 has exact source-backed metadata, explicit parameters and one immutable switch instruction', () => {
  const h = createCoreHandlers().get('cn.switch@1');
  assert(h); assert.equal(h.id, 'cn.switch@1'); assert.equal(h.rulesetId, 'CN/V20261019');
  assert.equal(h.implementationVersion, '1'); assert.equal(h.timing, 'resolve');
  assert.deepEqual(h.operations, ['switch']);
  assert.equal(h.parameterSchemaRef, 'urn:pokemon-tcg:core-handler-parameters:1.0.0#/$defs/switch');
  assert.equal(h.validateParameters, validateSwitchParameters); assert.equal(h.costCheckVersion, '1');
  assert.equal(typeof h.canUseWithCosts, 'function');
  assert.deepEqual(h.sourceOfTruth, ['effects.switch', 'effects.activation-cost', 'effects.activation-change']
    .flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth));
  for (const side of ['own', 'opponent']) for (const chooser of ['self', 'opponent']) for (const affected of ['active', 'selected']) {
    const p = freeze(parameters(side, chooser, affected)), before = structuredClone(p);
    assert(h.validateParameters(p)); assert.deepEqual(h.execute({}, p), [{ op: 'switch', ...before }]);
    assert.deepEqual(p, before);
  }
  for (const p of [undefined, null, [], {}, { side: 'own', chooser: 'self' }, { side: 'own', affected: 'active' },
    { chooser: 'self', affected: 'active' }, parameters('self'), parameters('own', 'owner'),
    parameters('own', 'self', 'bench'), { ...parameters(), op: 'switch' }, { ...parameters(), target: 'active' },
    { ...parameters(), optional: true }, { ...parameters(), count: 1 }]) assert.equal(h.validateParameters(p), false);
});

test('switch availability and its post-hand-cost proof use the actual target side’s Active and Bench, not Retreat or protection', () => {
  const h = createCoreHandlers().get('cn.switch@1');
  for (const owner of [0, 1]) for (const side of ['own', 'opponent']) for (const hasActive of [false, true])
    for (const hasBench of [false, true]) {
      const target = side === 'own' ? owner : 1 - owner;
      const player = () => ({ active: { id: 'unrelated-active' }, bench: [{ id: 'unrelated-bench' }], hand: [],
        flags: { retreat: true } });
      const ctx = { source: { owner }, state: { players: [player(), player()] }, subject: {
        owner: 1 - target, active: false, pokemon: { id: 'not-the-actual-target-side' },
      } };
      ctx.state.players[target].active = hasActive ? { id: 'target-active',
        conditions: { ...emptyConditions(), rotation: 'paralyzed', poison: 1, burned: true, paralysisRecoverTurn: 3 } } : null;
      ctx.state.players[target].bench = hasBench ? [{ id: 'target-bench' }] : [];
      const p = freeze(parameters(side)), before = structuredClone(ctx);
      freeze(ctx);
      assert.equal(h.canUse(ctx, p), hasActive && hasBench);
      assert.equal(h.canUseWithCosts(ctx, p, freeze([fee()])), hasActive && hasBench);
      assert.deepEqual(ctx, before);
    }
});

test('catalog admission rejects missing chooser or affected semantics instead of supplying international defaults', async () => {
  for (const p of [{ side: 'own' }, { side: 'opponent', chooser: 'opponent' }, { ...parameters(), op: 'switch' }])
    await assert.rejects(() => fixture((defs) => item(defs, p)), /Invalid parameters/);
});

test('C-03 an Item switches one’s own Pokémon while Asleep/Paralyzed or Retreat-locked, without discarding Energy', async () => {
  for (const rotation of ['asleep', 'paralyzed']) {
    const f = await fixture((defs) => {
      item(defs); defs[0].mechanics.effects.push(binding('cn.restriction@1', { effect: {
        op: 'restriction', scope: 'self', actions: ['retreat'],
      } }));
    });
    let cardId, incoming;
    const g = board(f, (s) => {
      incoming = bench(s, 0, 'other').id; cardId = hand(s, 0, 'potion');
      attached(s, 0, s.players[0].active, 'double'); s.players[0].active.counters = 3;
      s.players[0].active.conditions = { ...emptyConditions(), rotation, poison: 2, burned: true,
        paralysisRecoverTurn: rotation === 'paralyzed' ? s.players[0].turns : null };
    }), before = g.snapshot(), old = before.players[0].active;
    assert(!g.view(0).legalActions.some((a) => a.type === 'retreat'));
    assert(g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === cardId));
    play(g, cardId); assert.equal(g.snapshot().pending.kind, 'effect-target');
    assert.equal(g.snapshot().pending.player, 0); assert.deepEqual(g.snapshot().pending.options, [incoming]);
    assert(g.snapshot().players[0].resolving.includes(cardId), 'The Item is not discarded before choosing its result.');
    const checkpoint = g.snapshot();
    assert.throws(() => answer(g, [old.id])); assert.deepEqual(g.snapshot(), checkpoint);
    const r = restore(g, f); answer(g, [incoming]); answer(r, [incoming]); settle(g); settle(r);
    const s = g.snapshot(), benched = s.players[0].bench.find((m) => m.id === old.id);
    assert.deepEqual(r.snapshot(), s);
    assert.equal(s.players[0].active.id, incoming); assert.deepEqual(benched.conditions, emptyConditions());
    assert.equal(benched.counters, 3); assert.deepEqual(benched.energy, old.energy);
    assert.equal(s.players[0].flags.retreat, false); assert(s.players[0].discard.includes(cardId));
    assert.equal(s.current, 0); assert.equal(s.turn, 5); assert.equal(s.phase, 'main');
    assert.deepEqual(s.rng, before.rng);
    assert.deepEqual(moves(s).slice(moves(before).length), [{ kind: 'benchToActive', turn: 5, during: 0, owner: 0, pokemonId: incoming }]);
    assert.equal(moved(s, 0, incoming), true); assert.equal(moved(s, 0, old.id), false);
  }
});

test('C-04 the opponent chooses their incoming Bench Pokémon; pending state restores with the same choosing player', async () => {
  const f = await fixture((defs) => item(defs, parameters('opponent', 'opponent', 'active')));
  let cardId, choices;
  const g = board(f, (s) => {
    choices = [bench(s, 1, 'other').id, bench(s, 1, 'base').id]; cardId = hand(s, 0, 'potion');
  }), before = g.snapshot();
  play(g, cardId); const checkpoint = g.snapshot(), q = checkpoint.pending;
  assert.equal(q.player, 1); assert.deepEqual(q.options, choices);
  assert.equal(g.view(0).pending, null); assert(g.view(1).pending);
  assert.throws(() => command(g, { type: 'answer', requestId: q.id, selected: [choices[1]] }, 0), /cannot answer/);
  assert.deepEqual(g.snapshot(), checkpoint);
  const r = restore(g, f); answer(g, [choices[1]]); answer(r, [choices[1]]); settle(g); settle(r);
  const s = g.snapshot(); assert.deepEqual(r.snapshot(), s);
  assert.equal(s.players[1].active.id, choices[1]); assert.equal(s.players[0].active.id, before.players[0].active.id);
  assert(s.players[1].bench.some((m) => m.id === before.players[1].active.id));
  assert.deepEqual(moves(s).slice(moves(before).length), [{ kind: 'benchToActive', turn: 5, during: 0, owner: 1, pokemonId: choices[1] }]);
  assert.equal(moved(s, 1, choices[1]), false, 'The real opponent-side move happened during player 0’s turn, not player 1’s own turn.');
  assert.deepEqual(s.rng, before.rng);
});

test('C-05 the effect’s user chooses the opponent’s Bench Pokémon, not the opponent or the current Active', async () => {
  const f = await fixture((defs) => item(defs, parameters('opponent', 'self', 'selected')));
  let cardId, selected;
  const g = board(f, (s) => {
    bench(s, 1, 'base'); selected = bench(s, 1, 'other').id; cardId = hand(s, 0, 'potion');
  }), before = g.snapshot();
  play(g, cardId); assert.equal(g.snapshot().pending.player, 0);
  assert(g.snapshot().pending.options.includes(selected));
  assert(!g.snapshot().pending.options.includes(before.players[1].active.id));
  assert.equal(g.view(1).pending, null);
  const r = restore(g, f); answer(g, [selected]); answer(r, [selected]); settle(g); settle(r);
  assert.deepEqual(r.snapshot(), g.snapshot()); assert.equal(g.snapshot().players[1].active.id, selected);
  assert.deepEqual(g.snapshot().rng, before.rng);
});

test('C-04/05 protection never removes a choice and blocks only the explicitly affected Active or selected Bench Pokémon', async () => {
  for (const affected of ['active', 'selected']) for (const protectedPosition of ['active', 'bench']) {
    const f = await fixture((defs) => {
      defs[0].mechanics.attacks[0].printedDamage = null;
      defs[0].mechanics.attacks[0].effects = [switching(parameters('opponent', affected === 'active' ? 'opponent' : 'self', affected))];
      defs[1].mechanics.effects.push(binding('cn.protection@1', { effect: {
        op: 'protection', useRule: 'ordinary', scope: 'self', channel: 'effects', from: 'opponent', categories: ['attack'],
      } }));
    });
    let selected;
    const g = board(f, (s) => {
      attached(s, 0, s.players[0].active, 'water');
      if (protectedPosition === 'active') activeOther(s, 1);
      selected = bench(s, 1, protectedPosition === 'bench' ? 'other' : 'base').id;
    }), before = g.snapshot(), oldId = before.players[1].active.id;
    command(g, { type: 'attack', attackId: 'base:strike' });
    assert.equal(g.snapshot().pending.player, affected === 'active' ? 1 : 0);
    assert.deepEqual(g.snapshot().pending.options, [selected], 'Even a protected sole Bench Pokémon remains selectable.');
    const r = restore(g, f); answer(g, [selected]); answer(r, [selected]); settle(g); settle(r);
    const s = g.snapshot(), affectedPosition = affected === 'active' ? 'active' : 'bench';
    const blocked = affectedPosition === protectedPosition;
    assert.deepEqual(r.snapshot(), s); assert.equal(s.players[1].active.id, blocked ? oldId : selected);
    assert.equal(moves(s).length - moves(before).length, blocked ? 0 : 1, 'Do not record a Bench-to-Active event for a blocked effect.');
    const protection = s.events.slice(before.events.length).filter((e) => e.ruleId === 'effects.protection');
    assert.equal(protection.length, blocked ? 1 : 0);
    if (blocked) assert.equal(protection[0].data.targetId, affected === 'active' ? oldId : selected);
    assert.deepEqual(s.rng, before.rng);
  }
});

test('a valid switch Item keeps protected choices when another Bench Pokémon permits actual change', async () => {
  const f = await fixture((defs) => {
    item(defs, parameters('opponent', 'self', 'selected'));
    defs[1].mechanics.effects.push(binding('cn.protection@1', { effect: {
      op: 'protection', useRule: 'ordinary', scope: 'self', channel: 'effects', from: 'opponent', categories: ['trainer'],
    } }));
  });
  let cardId, selected, unprotected;
  const g = board(f, (s) => {
    unprotected = bench(s, 1, 'base').id; selected = bench(s, 1, 'other').id; cardId = hand(s, 0, 'potion');
  }), before = g.snapshot();
  assert(g.view(0).legalActions.some((a) => a.cardId === cardId));
  play(g, cardId); assert.deepEqual(g.snapshot().pending.options, [unprotected, selected]); answer(g, [selected]); settle(g);
  assert.equal(g.snapshot().players[1].active.id, before.players[1].active.id);
  assert.equal(moves(g.snapshot()).length, moves(before).length);
  assert(g.snapshot().players[0].discard.includes(cardId), 'The chosen effect was blocked, not undone as an illegal declaration.');
});

test('an empty target Bench forbids a switch-only Item even when the other side has a Bench', async () => {
  for (const side of ['own', 'opponent']) {
    const f = await fixture((defs) => item(defs, parameters(side)));
    let cardId;
    const g = board(f, (s) => { bench(s, side === 'own' ? 1 : 0, 'other'); cardId = hand(s, 0, 'potion'); });
    assert(!g.view(0).legalActions.some((a) => a.cardId === cardId));
    const before = g.snapshot(); assert.throws(() => play(g, cardId), /not legal/); assert.deepEqual(g.snapshot(), before);
  }
});

test('hand-discard costs cannot make a switch with no following board change usable or consume an Ability use', async () => {
  for (const kind of ['item', 'ability']) for (const side of ['own', 'opponent']) {
    const f = await fixture((defs) => {
      if (kind === 'item') item(defs, parameters(side), [fee()]);
      else defs[0].mechanics.abilities = [ability([switching(parameters(side))], { costs: [fee()],
        usage: { period: 'turn', scope: 'pokemon', key: 'switch', limit: 1 } })];
    });
    let cardId;
    const g = board(f, (s) => {
      bench(s, side === 'own' ? 1 : 0, 'other'); hand(s, 0, 'water');
      if (kind === 'item') cardId = hand(s, 0, 'potion');
    }), before = g.snapshot(), sourceId = before.players[0].active.id;
    assert(!g.view(0).legalActions.some((a) => kind === 'item' ? a.cardId === cardId : a.abilityId === 'switch'));
    assert.throws(() => kind === 'item' ? play(g, cardId) : use(g, sourceId), /not legal/);
    assert.deepEqual(g.snapshot(), before, 'Paying alone is not a usable switch effect.');
  }
});

test('a valid switch still cannot declare when its exact hand cost is unaffordable', async () => {
  for (const kind of ['item', 'ability']) {
    const f = await fixture((defs) => {
      if (kind === 'item') item(defs, parameters(), [fee(2)]);
      else defs[0].mechanics.abilities = [ability([switching()], { costs: [fee(2)],
        usage: { period: 'turn', scope: 'pokemon', key: 'switch', limit: 1 } })];
    });
    let ids;
    const g = board(f, (s) => { bench(s, 0, 'other'); ids = setHand(s, 0, kind === 'item' ? ['water', 'potion'] : ['water']); });
    const before = g.snapshot();
    assert(!g.view(0).legalActions.some((a) => kind === 'item' ? a.cardId === ids[1] : a.abilityId === 'switch'));
    assert.throws(() => kind === 'item' ? play(g, ids[1]) : use(g, before.players[0].active.id), /not legal/);
    assert.deepEqual(g.snapshot(), before);
  }
});

test('paid switch Items/Abilities reject invalid payments atomically and restore both payment and opponent-choice continuations', async () => {
  for (const kind of ['item', 'ability']) {
    const p = parameters('opponent', 'opponent', 'active');
    const f = await fixture((defs) => {
      if (kind === 'item') item(defs, p, [fee()]);
      else defs[0].mechanics.abilities = [ability([switching(p)], { costs: [fee()],
        usage: { period: 'turn', scope: 'pokemon', key: 'switch', limit: 1 } })];
    });
    let ids, incoming;
    const g = board(f, (s) => {
      incoming = bench(s, 1, 'other').id; ids = setHand(s, 0, kind === 'item' ? ['water', 'other', 'potion'] : ['water', 'other']);
    }), before = g.snapshot(), sourceId = before.players[0].active.id;
    if (kind === 'item') play(g, ids[2]); else use(g, sourceId);
    assert.equal(g.snapshot().pending.kind, 'activation-cost'); assert.equal(g.snapshot().pending.player, 0);
    const checkpoint = g.snapshot();
    for (const selected of [[], [paymentOptionId('fee', ids[1])], [paymentOptionId('wrong-cost', ids[0])],
      [paymentOptionId('fee', ids[0]), paymentOptionId('fee', ids[1])]]) {
      assert.throws(() => answer(g, selected)); assert.deepEqual(g.snapshot(), checkpoint);
    }
    const r = restore(g, f); answer(g, [paymentOptionId('fee', ids[0])]); answer(r, [paymentOptionId('fee', ids[0])]);
    assert.deepEqual(r.snapshot(), g.snapshot()); assert.equal(g.snapshot().pending.kind, 'effect-target');
    assert.equal(g.snapshot().pending.player, 1); assert.equal(g.view(0).pending, null);
    assert(g.snapshot().players[0].discard.includes(ids[0]));
    if (kind === 'item') {
      assert(g.snapshot().players[0].resolving.includes(ids[2]));
      assert(!g.snapshot().players[0].discard.includes(ids[2]));
    } else assert.deepEqual(g.snapshot().players[0].active.used.switch, [5]);
    const restoredChoice = restore(g, f); answer(g, [incoming]); answer(restoredChoice, [incoming]); settle(g); settle(restoredChoice);
    const s = g.snapshot(); assert.deepEqual(restoredChoice.snapshot(), s);
    assert.equal(s.players[1].active.id, incoming);
    assert.equal(s.events.filter((e) => e.ruleId === 'effects.activation-cost').length, 1);
    assert.deepEqual(s.rng, before.rng);
    if (kind === 'item') assert(s.players[0].discard.includes(ids[2]));
    else {
      assert.deepEqual(s.players[0].active.used.switch, [5]);
      const checkpointUsed = g.snapshot(); assert.throws(() => use(g, sourceId), /not legal/); assert.deepEqual(g.snapshot(), checkpointUsed);
    }
  }
});

test('repeated real switches record actual Pokémon identities and retain E-24 facts across a later Bench visit', async () => {
  const f = await fixture((defs) => { defs[0].mechanics.abilities = [ability([switching()])]; });
  let otherId;
  const g = board(f, (s) => { otherId = bench(s, 0, 'other').id; }), before = g.snapshot(), originalId = before.players[0].active.id;
  use(g, originalId); answer(g, [otherId]); settle(g);
  assert.equal(moved(g.snapshot(), 0, otherId), true);
  use(g, originalId); answer(g, [originalId]); settle(g);
  assert.equal(g.snapshot().players[0].active.id, originalId);
  assert.equal(moved(g.snapshot(), 0, otherId), true, 'Returning to Bench does not erase that earlier real transition.');
  assert.equal(moved(g.snapshot(), 0, originalId), true);
  use(g, originalId); answer(g, [otherId]); settle(g);
  const s = g.snapshot();
  assert.deepEqual(moves(s).slice(moves(before).length), [otherId, originalId, otherId]
    .map((pokemonId) => ({ kind: 'benchToActive', turn: 5, during: 0, owner: 0, pokemonId })));
  assert.equal(moved(s, 0, s.players[0].active.stack[0]), false, 'A physical card ID is not the battle Pokémon ID.');
  assert.deepEqual(s.rng, before.rng); assert.deepEqual(restore(g, f).snapshot(), s);
});

test('a real switch clears flagged attack effects and conditions, but retains counters, attachments and Ability usage', async () => {
  const lasting = (id, clearOnBench) => ability([binding('cn.lasting@1', {
    side: 'own', target: 'self', effect: { op: 'restriction', scope: 'all', actions: ['attack'] },
    duration: 'untilNextOwnTurnEnd', clearOnBench, clearOnEvolution: true,
  }, id)], { abilityId: id, usage: { period: 'turn', scope: 'pokemon', key: id, limit: 1 } });
  const f = await fixture((defs) => { item(defs); defs[0].mechanics.abilities = [lasting('clear', true), lasting('keep', false)]; });
  let cardId, incoming;
  const g = board(f, (s) => {
    incoming = bench(s, 0, 'other').id; attached(s, 0, s.players[0].active, 'water'); cardId = hand(s, 0, 'potion');
    s.players[0].active.counters = 3; s.players[0].active.conditions.rotation = 'asleep';
    const tool = hand(s, 0, 'tool'); s.players[0].hand.pop(); s.players[0].active.tools.push(tool);
  }), oldId = g.snapshot().players[0].active.id;
  use(g, oldId, 'clear'); answer(g, [oldId]); settle(g); use(g, oldId, 'keep'); answer(g, [oldId]); settle(g);
  const before = g.snapshot(); assert.equal(before.ongoing.length, 2);
  play(g, cardId); answer(g, [incoming]); settle(g);
  const s = g.snapshot(), old = s.players[0].bench.find((m) => m.id === oldId);
  assert.equal(s.ongoing.length, 1); assert(s.ongoing[0].source.effectId.endsWith('keep'));
  assert.deepEqual(old.used, before.players[0].active.used); assert.deepEqual(old.energy, before.players[0].active.energy);
  assert.deepEqual(old.tools, before.players[0].active.tools); assert.equal(old.counters, 3);
  assert.deepEqual(old.conditions, emptyConditions()); assert.deepEqual(restore(g, f).snapshot(), s);
});
