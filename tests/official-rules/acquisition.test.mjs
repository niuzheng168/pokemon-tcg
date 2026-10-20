import test from 'node:test';
import assert from 'node:assert/strict';
import { acquisitionMatches, ACQUISITION_RULE_IDS } from '../../public/rules/acquisition.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { OfficialGame } from '../../public/rules/game.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const descriptor = (origin = 'draw', extra = {}) => ({
  event: 'beforeHand', origin, turn: 'own', drawReason: origin === 'draw' ? 'turnStart' : 'any',
  optional: true, afterUse: 'hand', ...extra,
});
const incoming = (extra = {}, effects = [binding('cn.deployIncoming@1', {})]) => ({
  abilityId: 'incoming', name: '测试首发进场', mode: 'triggered', usage: null,
  trigger: descriptor('draw', extra), effects, sourceOfTruth: EVIDENCE,
});
const put = (s, owner, id, zone) => {
  const card = hand(s, owner, id); s.players[owner].hand.pop(); s.players[owner][zone].push(card); return card;
};
const prize = (s, owner, id, slot = 0) => {
  const card = hand(s, owner, id); s.players[owner].hand.pop();
  s.players[owner].hand.push(s.players[owner].prizes[slot]); s.players[owner].prizes[slot] = card; return card;
};
const restore = (g, f) => OfficialGame.restore(JSON.parse(JSON.stringify(g.snapshot())), { catalog: f.catalog });
const end = (g) => { command(g, { type: 'endTurn' }); settle(g); };
const nextOwn = (g) => { end(g); command(g, { type: 'endTurn' }); };
const cards = (extra = {}) => ({
  from: 'deck', to: 'bench', selector: { kind: 'pokemon' }, quantity: { kind: 'exact', count: 1 },
  reveal: true, lookTop: null, shuffleAfter: true, ...extra,
});

test('E-31 descriptor checks actual origin, turn and draw reason, not merely the resulting hand contents', () => {
  for (const id of ACQUISITION_RULE_IDS) assert(requireRule(CN_V20261019, id).sourceOfTruth.length);
  const entry = { id: 'i1', player: 0, cardId: 'card', origin: 'draw', reason: 'turnStart', turn: 5, during: 0, cause: null };
  assert(acquisitionMatches(descriptor(), entry));
  assert(!acquisitionMatches(descriptor(), { ...entry, reason: 'effect' }));
  assert(!acquisitionMatches(descriptor(), { ...entry, during: 1 }));
  assert(!acquisitionMatches(descriptor(), { ...entry, during: null }));
  assert(acquisitionMatches(descriptor('draw', { turn: 'either', drawReason: 'any' }), { ...entry, during: null, reason: 'effect' }));
  assert(!acquisitionMatches(descriptor('prizes'), entry));
  assert(acquisitionMatches(descriptor('prizes'), { ...entry, origin: 'prizes', reason: null }));
  assert.throws(() => acquisitionMatches(descriptor('prizes', { drawReason: 'effect' }), entry), /Invalid before-hand/);
  assert.throws(() => acquisitionMatches(descriptor(), { ...entry, cardId: null }), /Invalid before-hand/);
});

test('turn-start incoming Evolution card can enter the Bench without passing through hand or triggering from-hand effects', async () => {
  const f = await fixture((defs) => defs[2].mechanics.abilities = [
    incoming(),
    { abilityId: 'hand-only', name: '不应触发', mode: 'triggered', usage: null, sourceOfTruth: EVIDENCE,
      trigger: { event: 'bench', subject: 'self', origin: 'hand', optional: false, choiceOwner: 'source', scope: 'global' },
      effects: [binding('cn.draw@1', { count: 2 })] },
  ]);
  for (const decision of ['perform', 'skip']) {
    let selected;
    let g = board(f, (s) => { selected = put(s, 0, 'evolution', 'deck'); put(s, 1, 'water', 'deck'); });
    const before = g.snapshot(); nextOwn(g);
    assert.equal(g.snapshot().pending.kind, 'before-hand-optional'); assert.equal(g.snapshot().pending.player, 0);
    assert(!g.snapshot().players[0].hand.includes(selected)); assert(g.snapshot().players[0].resolving.includes(selected));
    assert.equal(g.view(0).pending.acquisition.card.instanceId, selected);
    assert.equal(g.view(1).pending, null);
    g = restore(g, f); answer(g, [decision]); settle(g);
    assert.equal(g.snapshot().players[0].bench.some((m) => m.stack[0] === selected), decision === 'perform');
    assert.equal(g.snapshot().players[0].hand.includes(selected), decision === 'skip');
    assert(!g.snapshot().players[0].resolving.includes(selected));
    assert(!g.snapshot().events.slice(before.events.length).some((e) => e.ruleId === 'trigger.bench' && e.data.performed));
    if (decision === 'skip')
      assert(!JSON.stringify(g.view(1).events.slice(before.events.length)).includes(selected), 'Declining must not reveal a hidden draw.');
  }
});

test('full Bench prevents declaring incoming deployment; ordinary effect draws do not satisfy turn-start-only text', async () => {
  const f = await fixture((defs) => {
    defs[2].mechanics.abilities = [incoming()];
    defs[0].mechanics.abilities = [{
      abilityId: 'draw', name: '测试抽牌', mode: 'activated',
      usage: { period: 'unlimited', scope: 'pokemon', key: 'draw', limit: null },
      effects: [binding('cn.draw@1', { count: 1 })], sourceOfTruth: EVIDENCE,
    }];
  });
  f.deck.splice(-4, 4, 'printing:base', 'printing:base', 'printing:other', 'printing:other');
  let card;
  const full = board(f, (s) => {
    for (const id of ['base', 'base', 'other', 'other', 'other']) bench(s, 0, id);
    card = put(s, 0, 'evolution', 'deck'); put(s, 1, 'water', 'deck');
  });
  nextOwn(full); assert.equal(full.snapshot().pending, null); assert(full.snapshot().players[0].hand.includes(card));
  const effect = board(f, (s) => { card = put(s, 0, 'evolution', 'deck'); });
  command(effect, { type: 'useAbility', abilityId: 'draw', pokemonId: effect.snapshot().players[0].active.id });
  assert.equal(effect.snapshot().pending, null); assert(effect.snapshot().players[0].hand.includes(card));
});

test('searching a card into hand is not drawing it and does not create a before-hand draw window', async () => {
  const f = await fixture((defs) => {
    defs[2].mechanics.abilities = [incoming({ drawReason: 'any' })];
    defs[0].mechanics.abilities = [{
      abilityId: 'search', name: '测试检索', mode: 'activated',
      usage: { period: 'unlimited', scope: 'pokemon', key: 'search', limit: null }, sourceOfTruth: EVIDENCE,
      effects: [binding('cn.cards@1', cards({ to: 'hand', selector: { kind: 'pokemon', nameKeys: ['evolution'] } }))],
    }];
  });
  let card;
  const g = board(f, (s) => { card = put(s, 0, 'evolution', 'deck'); });
  command(g, { type: 'useAbility', abilityId: 'search', pokemonId: g.snapshot().players[0].active.id });
  assert.equal(g.snapshot().pending.kind, 'select-cards');
  answer(g, [card]); settle(g);
  assert(g.snapshot().players[0].hand.includes(card));
  assert(!g.snapshot().players[0].bench.some((m) => m.stack[0] === card));
  assert(!g.snapshot().events.some((e) => e.ruleId === 'trigger.before-hand' && e.data.performed));
});

test('Prize Energy attachment occurs before hand, has prizes origin, and consumes neither hand-attachment triggers nor the normal attachment', async () => {
  const f = await fixture((defs) => {
    defs[1].mechanics.ruleBox = true; defs[1].mechanics.prizeCount = 2;
    defs.find((d) => d.definitionId === 'double').mechanics.effects = [{
      ...binding('cn.attachIncoming@1', { target: 'any' }), trigger: descriptor('prizes'),
    }, {
      ...binding('cn.counters@1', { side: 'own', target: 'event', count: 2 }),
      trigger: { event: 'energyAttached', subject: 'self', origin: 'hand', cardIsSource: true,
        optional: false, choiceOwner: 'source', scope: 'global' },
    }];
  });
  let energy;
  let g = board(f, (s) => {
    bench(s, 1, 'other'); const p = s.players[1], old = p.active; p.active = p.bench.pop(); p.bench.push(old);
    p.active.counters = 8; attached(s, 0, s.players[0].active, 'water'); energy = prize(s, 0, 'double');
  });
  command(g, { type: 'attack', attackId: 'base:strike' }); assert.equal(g.snapshot().pending.kind, 'prize');
  answer(g, ['0']); assert.equal(g.snapshot().pending.kind, 'before-hand-optional');
  assert(!g.snapshot().players[0].hand.includes(energy));
  g = restore(g, f); answer(g, ['perform']);
  assert.equal(g.snapshot().pending.kind, 'incoming-energy-recipient');
  assert.equal(g.snapshot().pending.data.source.origin, 'prizes');
  g = restore(g, f); answer(g, [g.snapshot().players[0].active.id]);
  assert.equal(g.snapshot().pending.kind, 'prize', 'Finish the first Prize receipt before choosing the second.');
  assert(g.snapshot().players[0].active.energy.includes(energy));
  assert.equal(g.snapshot().players[0].active.counters, 0);
  assert.equal(g.snapshot().players[0].flags.energy, false);
  assert(!g.snapshot().players[0].hand.includes(energy));
  settle(g);
});

test('two Dream-Ball-like Prizes each finish search/deployment/shuffle/discard before the next Prize is taken', async () => {
  const f = await fixture((defs) => {
    defs[1].mechanics.ruleBox = true; defs[1].mechanics.prizeCount = 2;
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [{
      ...binding('cn.cards@1', cards()),
      trigger: descriptor('prizes', { turn: 'either', afterUse: 'discard' }),
    }];
  });
  f.deck.splice(-1, 1, 'printing:potion');
  let first, second, target;
  let g = board(f, (s) => {
    const m = bench(s, 1, 'other'), p = s.players[1], old = p.active; p.bench.pop(); p.active = m; p.bench.push(old);
    m.counters = 8; attached(s, 0, s.players[0].active, 'water');
    first = prize(s, 0, 'potion'); second = prize(s, 0, 'potion', 1); target = put(s, 0, 'other', 'deck');
  });
  command(g, { type: 'attack', attackId: 'base:strike' }); answer(g, ['0']);
  answer(g, ['perform']); assert.equal(g.snapshot().pending.kind, 'select-cards');
  assert(g.snapshot().players[0].prizes.includes(second));
  assert(g.snapshot().players[0].resolving.includes(first));
  g = restore(g, f); answer(g, [target]); settle(g, (q) => {
    if (q.kind === 'prize') return ['0'];
    if (q.kind === 'before-hand-optional') return ['perform'];
    if (q.kind === 'select-cards') return [];
    return q.options.slice(0, q.minimum);
  });
  assert(g.snapshot().players[0].discard.includes(first) && g.snapshot().players[0].discard.includes(second));
  assert(g.snapshot().players[0].bench.some((m) => m.stack[0] === target));
  assert.equal(g.snapshot().events.filter((e) => e.ruleId === 'trigger.before-hand' && e.data.performed).length, 2);
  const fromHand = board(f, (s) => hand(s, 0, 'potion'));
  assert(!fromHand.view(0).legalActions.some((a) => a.type === 'playTrainer' && fromHand.snapshot().cards[a.cardId].definitionId === 'potion'));
});

test('nested before-hand draws preserve the outer resolution, and hand-only Trainer immunity does not cover Prize-origin effects', async () => {
  const program = [{ op: 'optional', effect: { op: 'then', first: { op: 'draw', count: 2 },
    next: { op: 'counters', side: 'opponent', target: 'any', count: 1 } } }];
  const h = { rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE, operations: ['optional', 'then', 'draw', 'counters'],
    validateParameters: (p) => Object.keys(p).length === 0, execute: () => structuredClone(program) };
  const f = await fixture((defs) => {
    defs[2].mechanics.abilities = [incoming({ drawReason: 'effect' })];
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [{
      ...binding('fixture:nested-entry', {}), trigger: descriptor('prizes', { optional: false, afterUse: 'discard' }),
    }];
    defs[1].mechanics.effects.push(binding('cn.protection@1', { effect: {
      op: 'protection', useRule: 'CN.E29', channel: 'effects', from: 'opponent', scope: 'self', categories: ['trainer'],
      trainerCategories: ['item'], trainerOrigins: ['hand'],
    } }));
  }, new Map([['fixture:nested-entry', h]]));
  let item, incomingCard;
  let g = board(f, (s) => {
    s.players[1].active.counters = 8; bench(s, 1, 'other'); attached(s, 0, s.players[0].active, 'water');
    item = prize(s, 0, 'potion'); put(s, 0, 'water', 'deck'); incomingCard = put(s, 0, 'evolution', 'deck');
  });
  command(g, { type: 'attack', attackId: 'base:strike' }); answer(g, ['0']);
  assert.equal(g.snapshot().pending.kind, 'optional-effect');
  g = restore(g, f); answer(g, ['perform']);
  assert.equal(g.snapshot().pending.kind, 'before-hand-optional');
  assert.equal(g.snapshot().pending.data.entry.cardId, incomingCard);
  assert(g.snapshot().players[0].resolving.includes(item));
  g = restore(g, f); answer(g, ['perform']);
  assert.equal(g.snapshot().pending.kind, 'effect-target');
  assert.equal(g.snapshot().pending.data.source.origin, 'prizes');
  assert.equal(g.snapshot().pending.data.entry.cardId, item);
  const bad = g.snapshot(); bad.pending.data.source.origin = 'hand';
  assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }), /incoming effect/);
  g = restore(g, f); settle(g);
  assert(g.snapshot().players[0].discard.includes(item));
  assert(g.snapshot().players[0].bench.some((m) => m.stack[0] === incomingCard));
  // The opposing Active is already Knocked Out; the effect targets the still
  // protected Bench Pokémon while retaining its Prize, not hand, origin.
  assert(g.snapshot().events.some((e) => e.ruleId === 'damage.counters' && e.data.effectId === 'fixture:fixture:nested-entry'));
});

test('before-hand snapshot validation rejects changed holders/causes/windows/bindings and duplicate finalizers', async () => {
  const f = await fixture((defs) => defs[2].mechanics.abilities = [incoming()]);
  let g = board(f, (s) => { put(s, 0, 'evolution', 'deck'); put(s, 1, 'water', 'deck'); });
  nextOwn(g); const before = g.snapshot();
  for (const mutate of [
    (s) => { s.pending.data.entry.player = 1; },
    (s) => { s.pending.data.entry.turn--; },
    (s) => { s.pending.data.entry.during = 1; },
    (s) => { s.pending.data.unitId = 'not-approved'; },
    (s) => { s.queue = s.queue.filter((t) => t.op !== 'entry-finish'); },
    (s) => { s.queue.push(structuredClone(s.queue.find((t) => t.op === 'entry-finish'))); },
  ]) {
    const s = structuredClone(before); mutate(s);
    assert.throws(() => OfficialGame.restore(s, { catalog: f.catalog }), /Receipt|receipt|before-hand|Corrupt/);
  }
  g = restore(g, f); answer(g, ['skip']); settle(g);
});

test('multiple before-hand effects are ordered by the holder; consuming the incoming card closes its remaining window', async () => {
  const f = await fixture((defs) => defs[2].mechanics.abilities = [
    incoming(),
    { ...incoming(), abilityId: 'other-entry', name: '测试第二项', effects: [binding('cn.draw@1', { count: 1 })] },
  ]);
  let card;
  let g = board(f, (s) => { card = put(s, 0, 'evolution', 'deck'); put(s, 1, 'water', 'deck'); });
  nextOwn(g);
  assert.equal(g.snapshot().pending.kind, 'before-hand-order');
  const saved = g.snapshot(), first = saved.pending.options[0];
  const corrupt = structuredClone(saved); corrupt.pending.data.remaining[0] = 'unapproved-unit';
  assert.throws(() => OfficialGame.restore(corrupt, { catalog: f.catalog }), /Receipt bindings/);
  g = restore(g, f); answer(g, [first]);
  assert.equal(g.snapshot().pending.kind, 'before-hand-optional');
  const before = g.snapshot().players[0].hand.length;
  answer(g, ['perform']); settle(g);
  assert(g.snapshot().players[0].bench.some((m) => m.stack[0] === card));
  assert.equal(g.snapshot().players[0].hand.length, before);
  assert.equal(g.snapshot().events.filter((e) => e.ruleId === 'trigger.before-hand' && e.data.performed).length, 1);
});

test('incoming Energy target filters are explicit for Active and Bench, with unchanged normal-attachment flags', async () => {
  for (const target of ['active', 'bench']) {
    const f = await fixture((defs) => defs.find((d) => d.definitionId === 'double').mechanics.effects = [{
      ...binding('cn.attachIncoming@1', { target }), trigger: descriptor('draw', { drawReason: 'effect' }),
    }]);
    const g = board(f, (s) => {
      bench(s, 0, 'other'); put(s, 0, 'double', 'deck'); hand(s, 0, 'research');
    });
    const before = g.snapshot(), trainer = before.players[0].hand.find((id) => before.cards[id].definitionId === 'research');
    command(g, { type: 'playTrainer', cardId: trainer });
    assert.equal(g.snapshot().pending.kind, 'before-hand-optional');
    answer(g, ['perform']); assert.equal(g.snapshot().pending.kind, 'incoming-energy-recipient');
    assert.deepEqual(g.snapshot().pending.options, [target === 'active' ? before.players[0].active.id : before.players[0].bench[0].id]);
    settle(g); assert.equal(g.snapshot().players[0].flags.energy, false);
  }
});

test('acquisition-only operations cannot be misregistered as ordinary abilities or on the wrong card kind', async () => {
  for (const mode of ['ordinary', 'energy-deploy', 'pokemon-attach', 'usage']) {
    await assert.rejects(async () => {
      const f = await fixture((defs) => {
        if (mode === 'energy-deploy') defs.find((d) => d.definitionId === 'double').mechanics.effects = [{
          ...binding('cn.deployIncoming@1', {}), trigger: descriptor('prizes'),
        }];
        else if (mode === 'pokemon-attach') defs[2].mechanics.abilities = [incoming({}, [binding('cn.attachIncoming@1', { target: 'any' })])];
        else if (mode === 'usage') defs[2].mechanics.abilities = [{ ...incoming(), usage: { period: 'turn', scope: 'pokemon', key: 'entry', limit: 1 } }];
        else {
          const a = { ...incoming(), mode: 'activated',
            usage: { period: 'unlimited', scope: 'pokemon', key: 'entry', limit: null } };
          delete a.trigger; defs[2].mechanics.abilities = [a];
        }
      });
      board(f);
    }, /Unimplemented or undeclared handler|Before-hand windows|Invalid normalized card definition/);
  }
});

test('Prize-card effects settle new Knock Outs and their Prizes without judging victory inside the original award process', async () => {
  const f = await fixture((defs) => defs.find((d) => d.definitionId === 'potion').mechanics.effects = [{
    ...binding('cn.counters@1', { side: 'opponent', target: 'any', count: 10 }),
    trigger: descriptor('prizes', { optional: false, afterUse: 'discard' }),
  }]);
  const g = board(f, (s) => {
    s.players[1].active.counters = 8; bench(s, 1, 'other'); attached(s, 0, s.players[0].active, 'water');
    prize(s, 0, 'potion'); prize(s, 0, 'water', 1);
  });
  command(g, { type: 'attack', attackId: 'base:strike' }); answer(g, ['0']);
  assert.equal(g.snapshot().pending.kind, 'effect-target');
  answer(g, [g.snapshot().players[1].bench[0].id]);
  assert.equal(g.snapshot().players[1].bench.length, 0);
  assert.equal(g.snapshot().result, null, 'New victory conditions must wait for related Prize processing.');
  assert.equal(g.snapshot().pending.kind, 'prize', 'The new Knock Out still awards its Prize.');
  const bad = g.snapshot();
  bad.queue.find((t) => t.op === 'finish-ko').data.deferOutcome = 'silently-true';
  assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }), /Snapshot schema mismatch/);
  answer(g, ['0']); settle(g);
  assert.equal(g.snapshot().players[0].prizes.length, 4);
  assert.equal(g.snapshot().result.winner, 0);
});

test('a turn-start before-hand effect reaches the KO boundary after the entire draw receipt completes', async () => {
  const f = await fixture((defs) => defs[2].mechanics.abilities = [incoming({}, [
    binding('cn.deployIncoming@1', {}), binding('cn.counters@1', { side: 'opponent', target: 'active', count: 10 }),
  ])]);
  const g = board(f, (s) => { put(s, 0, 'evolution', 'deck'); put(s, 1, 'water', 'deck'); });
  nextOwn(g); answer(g, ['perform']);
  assert.equal(g.snapshot().pending.kind, 'effect-target');
  answer(g, [g.snapshot().players[1].active.id]); settle(g);
  assert.equal(g.snapshot().result.winner, 0);
  assert.equal(g.snapshot().players[1].active, null);
});

test('E29 hand-only Trainer immunity permits a normal Item while still blocking its actual effect', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.effects.push(binding('cn.protection@1', { effect: {
      op: 'protection', useRule: 'CN.E29', channel: 'effects', scope: 'self', from: 'opponent', categories: ['trainer'],
      trainerCategories: ['item'], trainerOrigins: ['hand'],
    } }));
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.counters@1', {
      side: 'opponent', target: 'active', count: 1,
    })];
  });
  const g = board(f, (s) => hand(s, 0, 'potion')), s = g.snapshot();
  const cardId = s.players[0].hand.find((id) => s.cards[id].definitionId === 'potion');
  assert(g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === cardId));
  assert.deepEqual(g.snapshot(), s, 'Qualification is read-only even when the guide explicitly permits use.');
  command(g, { type: 'playTrainer', cardId }); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 0);
  assert(g.snapshot().events.some((e) => e.ruleId === 'effects.protection' &&
    e.data.effects.some((entry) => entry.ruleId === 'effects.trainer-hand-use')));
});

test('an unusable Prize-only Item stays unplayed in hand instead of being revealed/discarded as a no-effect use', async () => {
  const f = await fixture((defs) => defs.find((d) => d.definitionId === 'potion').mechanics.effects = [{
    ...binding('cn.counters@1', { side: 'opponent', target: 'any', count: 1 }),
    trigger: descriptor('prizes', { optional: false, afterUse: 'discard' }),
  }]);
  let item;
  const g = board(f, (s) => {
    s.players[1].active.counters = 8; attached(s, 0, s.players[0].active, 'water'); item = prize(s, 0, 'potion');
  });
  command(g, { type: 'attack', attackId: 'base:strike' }); answer(g, ['0']); settle(g);
  assert(g.snapshot().players[0].hand.includes(item));
  assert(!g.snapshot().players[0].discard.includes(item));
  assert(!g.snapshot().events.some((e) => e.ruleId === 'trigger.before-hand' && e.data.performed));
});

test('Ability identities and intrinsic effect identities stay in separate receipt namespaces', async () => {
  const f = await fixture((defs) => {
    defs[2].mechanics.abilities = [{ ...incoming(), abilityId: 'shared:entry' }];
    defs[2].mechanics.effects = [{
      ...binding('cn.draw@1', { count: 1 }), effectId: 'shared:entry', trigger: descriptor('draw', { optional: false }),
    }];
  });
  const g = board(f, (s) => { put(s, 0, 'water', 'deck'); put(s, 0, 'evolution', 'deck'); put(s, 1, 'water', 'deck'); });
  nextOwn(g);
  assert.equal(g.snapshot().pending.kind, 'before-hand-order');
  assert.equal(new Set(g.snapshot().pending.options).size, 2);
  answer(g, [g.snapshot().pending.options.find((id) => JSON.parse(id)[1] === 'effect')]);
  assert.equal(g.snapshot().pending.kind, 'before-hand-optional');
  answer(g, ['perform']); settle(g);
  const used = g.snapshot().events.filter((e) => e.ruleId === 'trigger.before-hand' && e.data.performed);
  assert.deepEqual(used.map((e) => e.data.abilityId), [null, 'shared:entry']);
});

test('taking the last Prize does not bypass its before-hand effects or the CN simultaneous-loss table', async () => {
  const f = await fixture((defs) => defs.find((d) => d.definitionId === 'potion').mechanics.effects = [{
    ...binding('cn.counters@1', { side: 'own', target: 'active', count: 10 }),
    trigger: descriptor('prizes', { optional: false, afterUse: 'discard' }),
  }]);
  const g = board(f, (s) => {
    s.players[0].hand.push(...s.players[0].prizes.splice(1));
    prize(s, 0, 'potion'); prize(s, 1, 'water');
    s.players[1].active.counters = 8; bench(s, 1, 'other');
    attached(s, 0, s.players[0].active, 'water');
  });
  command(g, { type: 'attack', attackId: 'base:strike' }); answer(g, ['0']);
  assert.equal(g.snapshot().players[0].prizes.length, 0);
  assert.equal(g.snapshot().result, null);
  assert.equal(g.snapshot().pending.kind, 'effect-target');
  answer(g, [g.snapshot().players[0].active.id]);
  assert.equal(g.snapshot().pending.kind, 'prize');
  assert.equal(g.snapshot().pending.player, 1);
  assert.equal(g.snapshot().result, null);
  answer(g, ['0']); settle(g);
  assert.deepEqual(g.snapshot().result, { winner: null, reason: 'simultaneous' });
  assert.equal(g.snapshot().players[1].prizes.length, 5);
});
