import test from 'node:test';
import assert from 'node:assert/strict';
import { fieldReturnTargets, FIELD_RETURN_RULE_IDS } from '../../public/rules/field-return.js';
import { validateFieldReturnParameters, validateAttachedEnergyParameters } from '../../public/rules/schema-validators.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { OfficialGame } from '../../public/rules/game.js';
import { createOngoingEffect, createPlayerOngoingEffect } from '../../public/rules/ongoing.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, EVIDENCE, board, start, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

// A Bench-only return never vacates the Active, so it has no promotion schedule.
const returning = (extra = {}) => {
  const p = { op: 'returnPokemon', side: 'own', target: 'self', selector: { kind: 'pokemon' },
    quantity: { kind: 'exact', count: 1 }, to: 'hand', attachments: 'return', chooser: 'source',
    promotion: { timing: 'afterRelatedResolution', sourceOfTruth: EVIDENCE }, ...extra };
  if (p.target === 'bench') delete p.promotion;
  return p;
};
const energyReturn = (extra = {}) => ({ op: 'returnEnergy', side: 'own', from: 'self', selector: { kind: 'energy' },
  providedTypes: null, measure: 'units', quantity: { kind: 'exact', count: 1 }, chooser: 'source', to: 'hand', ...extra });
const ability = (id, effects, extra = {}) => ({ abilityId: id, name: `测试返回${id}`, mode: 'activated',
  usage: { period: 'unlimited', scope: 'pokemon', key: id, limit: null }, effects, sourceOfTruth: EVIDENCE, ...extra });
const use = (g, id = 'return', pokemonId = g.snapshot().players[0].active.id) => command(g, { type: 'useAbility', pokemonId, abilityId: id });
const restore = (g, f) => OfficialGame.restore(JSON.parse(JSON.stringify(g.snapshot())), { catalog: f.catalog });
const has = (g, abilityId) => g.view(0).legalActions.some((a) => a.abilityId === abilityId);
const put = (s, owner, id, zone) => {
  const card = hand(s, owner, id); s.players[owner].hand.pop(); s.players[owner][zone].push(card); return card;
};
const stack = (s, owner, m) => {
  const card = hand(s, owner, 'evolution'); s.players[owner].hand.pop(); m.stack.push(card); return card;
};
const tool = (s, owner, m, id = 'tool') => {
  const card = hand(s, owner, id); s.players[owner].hand.pop(); m.tools.push(card); return card;
};
const reviewed = (extra) => ({ rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE,
  validateParameters: (p) => Object.keys(p).length === 0, ...extra });
const installLocks = (s, m) => {
  const source = { instanceId: m.stack[0], owner: 0, cardOwner: 0, category: 'attack', pokemonId: m.id,
    attackId: 'base:strike', effectId: 'fixture:return-lock', sourceOfTruth: EVIDENCE, origin: 'field' };
  s.ongoing.push(createOngoingEffect({
    id: `e${++s.serial}`, targetId: m.id, source, effect: { op: 'restriction', scope: 'all', actions: ['retreat'] },
    duration: 'untilNextOwnTurnEnd', clearOnBench: false, clearOnEvolution: false,
  }, s));
  s.playerOngoing.push(createPlayerOngoingEffect({
    id: `e${++s.serial}`, player: 1, source, effect: { op: 'playerRestriction', scope: 'all', actions: ['playItem'] },
    duration: 'untilNextOwnTurnEnd',
  }, s));
};

test('field return has CN sources and strict, separate Pokémon-bundle and attached-Energy schemas', () => {
  for (const id of FIELD_RETURN_RULE_IDS) assert(requireRule(CN_V20261019, id).sourceOfTruth.length);
  assert(validateFieldReturnParameters(returning())); assert(validateAttachedEnergyParameters(energyReturn()));
  for (const a of [returning({ to: 'deck' }), returning({ selector: { kind: 'any' } }), returning({ attachments: null }),
    returning({ keepDamage: true }), returning({ quantity: { kind: 'exact', count: 0 } })])
    assert(!validateFieldReturnParameters(a));
  const missingDestination = energyReturn(); delete missingDestination.to;
  for (const a of [missingDestination, energyReturn({ to: 'opponentHand' }),
    energyReturn({ recipient: { position: 'any', selector: { kind: 'pokemon' } } }),
    energyReturn({ op: 'discardEnergy' })]) assert(!validateAttachedEnergyParameters(a));
});

test('C-02 returns the entire evolution stack and every attachment, retires battle facts, and preserves player effects', async () => {
  const f = await fixture((defs) => defs[2].mechanics.abilities = [ability('return', [binding('cn.fieldReturn@1', returning())])]);
  let evolution, water, heldTool;
  const g = board(f, (s) => {
    evolution = stack(s, 0, s.players[0].active); water = attached(s, 0, s.players[0].active, 'water');
    heldTool = tool(s, 0, s.players[0].active); bench(s, 0, 'other');
    s.players[0].active.counters = 4; s.players[0].active.conditions.poison = 1;
    s.players[0].active.facts.healedTurn = s.turn; s.players[0].active.used.once = [s.turn]; installLocks(s, s.players[0].active);
  });
  const before = g.snapshot(), old = before.players[0].active, printed = structuredClone(f.catalog.definition('evolution'));
  use(g); assert.equal(g.snapshot().pending.kind, 'return-pokemon');
  assert.deepEqual(restore(g, f).view(0), g.view(0)); answer(g, [old.id]); settle(g);
  const after = g.snapshot();
  for (const id of [old.stack[0], evolution, water, heldTool]) assert(after.players[0].hand.includes(id));
  assert.notEqual(after.players[0].active.id, old.id); assert.equal(after.ongoing.length, 0);
  assert.equal(after.playerOngoing.length, 1); assert.deepEqual(after.playerOngoing, before.playerOngoing);
  assert.equal(after.players[1].prizes.length, 6, 'Returning is not a Knock Out.');
  assert.deepEqual(f.catalog.definition('evolution'), printed);
  for (const id of old.stack) for (const key of ['counters', 'conditions', 'used', 'currentHp'])
    assert(!Object.hasOwn(after.cards[id], key), 'Retired battle state is never written into a physical card.');
});

test('a Pokémon-only return discards attachments explicitly, but never discards the lower evolution cards', async () => {
  for (const to of ['hand', 'deckShuffle']) {
    const f = await fixture((defs) => defs[0].mechanics.abilities = [ability('return', [binding('cn.fieldReturn@1',
      returning({ target: 'bench', to, attachments: 'discard' }))])]);
    let target, evolution, energy, heldTool, basic;
    const g = board(f, (s) => {
      const m = bench(s, 0, 'base'); target = m.id; basic = m.stack[0]; evolution = stack(s, 0, m);
      energy = attached(s, 0, m, 'double'); heldTool = tool(s, 0, m);
    });
    const rng = g.snapshot().rng; use(g); answer(g, [target]); settle(g);
    const s = g.snapshot(), zone = to === 'hand' ? 'hand' : 'deck';
    assert(s.players[0][zone].includes(basic) && s.players[0][zone].includes(evolution));
    assert(s.players[0].discard.includes(energy) && s.players[0].discard.includes(heldTool));
    assert(!s.players[0].discard.includes(basic) && !s.players[0].discard.includes(evolution));
    assert.equal(s.players[0].bench.length, 0);
    if (to === 'hand') assert.deepEqual(s.rng, rng); else assert.notDeepEqual(s.rng, rng);
  }
});

test('opponent returns use its holder zones and holder choice, not the source player’s hand', async () => {
  const f = await fixture((defs) => defs[0].mechanics.abilities = [ability('return', [binding('cn.fieldReturn@1',
    returning({ side: 'opponent', target: 'bench', chooser: 'holder' }))])]);
  let target, card;
  const g = board(f, (s) => { const m = bench(s, 1, 'other'); target = m.id; card = m.stack[0]; });
  use(g); assert.equal(g.snapshot().pending.player, 1); assert.equal(g.view(0).pending, null);
  answer(g, [target]); settle(g);
  assert(g.snapshot().players[1].hand.includes(card)); assert(!g.snapshot().players[0].hand.includes(card));
});

test('a self-returning attack finishes its following draw, reactions, KO awards and turn without substituting the new Active as attacker', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.attacks[0].effects = [binding('cn.fieldReturn@1', returning({
      promotion: { timing: 'afterAction', sourceOfTruth: EVIDENCE },
    })), binding('cn.draw@1', { count: 1 })];
    defs[0].mechanics.effects.push({ ...binding('cn.counters@1', { side: 'opponent', target: 'attacker', count: 1 }),
      trigger: { event: 'attackDamage', subject: 'self', optional: false, choiceOwner: 'source', scope: 'global' } });
  });
  let energy;
  const g = board(f, (s) => {
    energy = attached(s, 0, s.players[0].active, 'water'); bench(s, 0, 'other');
    s.players[1].active.counters = 8; bench(s, 1, 'other');
  });
  const before = g.snapshot(), old = before.players[0].active;
  command(g, { type: 'attack', attackId: 'base:strike' }); answer(g, [old.id]);
  assert.equal(g.snapshot().pending.kind, 'promote'); answer(g, [g.snapshot().players[0].bench[0].id]);
  assert.equal(g.snapshot().pending.kind, 'prize', 'Returning the attacker must not cancel its already-caused KO.');
  const r = restore(g, f); settle(g); settle(r); assert.deepEqual(r.snapshot(), g.snapshot());
  const s = g.snapshot();
  assert.equal(s.current, 1); assert.equal(s.players[0].prizes.length, 5);
  assert(s.players[0].hand.includes(old.stack[0]) && s.players[0].hand.includes(energy));
  assert.equal(s.players[0].hand.length, before.players[0].hand.length + 4, 'Two returned cards, one draw, one Prize.');
  assert.equal(s.players[0].active.counters, 0, 'The old-attacker reaction cannot hit the replacement Active.');
});

test('I.E waits for all related attack work: both last Pokémon leaving through return and KO can still produce the CN draw', async () => {
  const f = await fixture((defs) => defs[0].mechanics.attacks[0].effects = [binding('cn.fieldReturn@1', returning())]);
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); s.players[1].active.counters = 8; });
  command(g, { type: 'attack', attackId: 'base:strike' }); answer(g, [g.snapshot().players[0].active.id]);
  assert.equal(g.snapshot().result, null); assert.equal(g.snapshot().pending.kind, 'prize');
  settle(g); assert.equal(g.snapshot().result.winner, null); assert.equal(g.snapshot().result.reason, 'simultaneous');
  assert.equal(g.snapshot().players[0].prizes.length, 5);
});

test('returning the last Pokémon without another related victory condition loses only after the effect has completed', async () => {
  const f = await fixture((defs) => defs[0].mechanics.abilities = [ability('return', [
    binding('cn.fieldReturn@1', returning()), binding('cn.draw@1', { count: 1 }),
  ])]);
  const g = board(f), before = g.snapshot().players[0].hand.length;
  use(g); answer(g, [g.snapshot().players[0].active.id]); settle(g);
  assert.equal(g.snapshot().players[0].hand.length, before + 2); assert.equal(g.snapshot().result.winner, 1);
});

test('I.E allows a related before-hand deployment to rescue the position after the last Pokémon returned', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.abilities = [ability('return', [binding('cn.fieldReturn@1', returning()), binding('cn.draw@1', { count: 1 })])];
    defs[1].mechanics.effects = [{ ...binding('cn.deployIncoming@1', {}), trigger: {
      event: 'beforeHand', origin: 'draw', turn: 'own', drawReason: 'effect', optional: false, afterUse: 'hand',
    } }];
  });
  let incoming;
  const g = board(f, (s) => { incoming = put(s, 0, 'other', 'deck'); }), old = g.snapshot().players[0].active;
  use(g); answer(g, [old.id]); settle(g);
  assert.equal(g.snapshot().result, null); assert.equal(g.snapshot().players[0].active.stack[0], incoming);
  assert(g.snapshot().players[0].hand.includes(old.stack[0])); assert.deepEqual(g.snapshot().vacancies, [null, null]);
});

test('non-KO promotion timing must be explicit; a return before a Knock Out is replaced first (effects.field-return-promotion)', async () => {
  const unresolved = await fixture((defs) => defs[0].mechanics.abilities = [ability('return', [binding('cn.fieldReturn@1', returning({
    promotion: { timing: 'needsRuling', sourceOfTruth: EVIDENCE },
  }))])]);
  const g = board(unresolved, (s) => bench(s, 0, 'other')); use(g); const before = g.snapshot();
  assert.throws(() => answer(g, [before.players[0].active.id]), (e) => e.code === 'unresolved-field-promotion');
  assert.deepEqual(g.snapshot(), before);
  const mixed = await fixture((defs) => defs[0].mechanics.attacks[0].effects = [binding('cn.fieldReturn@1', returning())]);
  const h = board(mixed, (s) => {
    attached(s, 0, s.players[0].active, 'water'); bench(s, 0, 'other'); bench(s, 1, 'other'); s.players[1].active.counters = 8;
  });
  command(h, { type: 'attack', attackId: 'base:strike' }); answer(h, [h.snapshot().players[0].active.id]);
  // ブロロロームex「スピードブレイク」: 自分がバトルポケモンを出した後、相手のバトルポケモンのきぜつ処理をおこないます。
  let q = h.snapshot().pending;
  assert.equal(q.kind, 'promote'); assert.equal(q.player, 0); assert.equal(q.ruleId, 'effects.field-return');
  assert.equal(h.snapshot().players[1].discard.length, 0, 'Knock Out processing waits for the replacement.');
  assert.deepEqual(restore(h, mixed).view(0), h.view(0));
  answer(h, q.options);
  assert.equal(h.snapshot().pending.kind, 'prize'); answer(h, ['0']);
  q = h.snapshot().pending; assert.equal(q.kind, 'promote'); assert.equal(q.player, 1); assert.equal(q.ruleId, 'ko.promote');
  answer(h, q.options); settle(h);
  assert(h.snapshot().events.some((e) => e.ruleId === 'effects.field-return' && e.data.promotion?.timing === 'afterRelatedResolution'));
  const late = await fixture((defs) => {
    defs[0].mechanics.abilities = [ability('return', [
      binding('cn.fieldReturn@1', returning({ promotion: { timing: 'needsRuling', sourceOfTruth: EVIDENCE } })),
      binding('cn.draw@1', { count: 1 }),
    ])];
    defs[1].mechanics.effects = [{ ...binding('cn.deployIncoming@1', {}), trigger: {
      event: 'beforeHand', origin: 'draw', turn: 'own', drawReason: 'effect', optional: false, afterUse: 'hand',
    } }];
  });
  const l = board(late, (s) => put(s, 0, 'other', 'deck')); use(l); const pending = l.snapshot();
  assert.throws(() => answer(l, [pending.players[0].active.id]), (e) => e.code === 'unresolved-field-promotion');
  assert.deepEqual(l.snapshot(), pending);
});

test('「将双方的战斗宝可梦…放于弃牌区。［由自己先将下一只宝可梦放于战斗场。］」: the user replaces first', async () => {
  const both = (to) => [binding('cn.fieldReturn@1', returning({ target: 'active', to, attachments: 'discard' }), 'own'),
    binding('cn.fieldReturn@1', returning({ side: 'opponent', target: 'active', to, attachments: 'discard' }), 'opponent')];
  const f = await fixture((defs) => defs[0].mechanics.attacks[0].effects = both('discard'));
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); bench(s, 0, 'other'); bench(s, 1, 'other'); });
  const actives = [0, 1].map((i) => g.snapshot().players[i].active.id);
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  const s = g.snapshot();
  assert(actives.every((id, i) => s.players[i].discard.length && !s.players[i].bench.some((m) => m.id === id)));
  assert.deepEqual(s.events.filter((e) => e.ruleId === 'effects.field-return' && e.data.promotion).map((e) => e.data.player), [0, 1]);
  assert.equal(s.players[0].prizes.length, 6, 'Not a Knock Out.');
});

test('vacancy and promotion continuations retain the departed source, reviewed schedule, holder and empty Active position on restore', async () => {
  const f = await fixture((defs) => defs[0].mechanics.abilities = [ability('return', [binding('cn.fieldReturn@1', returning())])]);
  const g = board(f, (s) => bench(s, 0, 'other')); use(g); answer(g, [g.snapshot().players[0].active.id]);
  assert.equal(g.snapshot().pending.kind, 'promote'); assert(g.snapshot().vacancies[0]); assert.deepEqual(restore(g, f).view(0), g.view(0));
  for (const mutate of [
    (s) => { s.vacancies[0] = null; }, (s) => { s.vacancies[0].source.instanceId = 'missing'; },
    (s) => { s.players[0].active = s.players[0].bench.pop(); },
    (s) => { delete s.pending.data.promotion; }, (s) => { s.pending.data.player = 1; },
    (s) => { s.pending.data.source.instanceId = s.players[0].bench[0].stack[0]; },
    (s) => { s.pending.options = [s.players[1].active.id]; }, (s) => { s.pending.minimum = 0; },
    (s) => { s.pending.player = 1; }, (s) => { s.pending.allowZero = true; },
    (s) => { delete s.pending.data.reason; delete s.pending.data.source; delete s.pending.data.promotion; },
  ]) {
    const s = g.snapshot(); mutate(s); assert.throws(() => OfficialGame.restore(s, { catalog: f.catalog }), /vacancy|promotion|Corrupt/);
  }
  const promoted = g.snapshot().players[0].bench[0].id; answer(g, [promoted]); settle(g);
  assert.deepEqual(g.snapshot().vacancies, [null, null]);
  assert.equal(g.snapshot().players[0].active.facts.movedActiveTurn, g.snapshot().turn);
});

test('E-12 new entry gets a fresh Pokémon identity and personal use count, while E-14 player-shared usage remains spent', async () => {
  for (const scope of ['pokemon', 'player']) {
    const f = await fixture((defs) => defs[0].mechanics.abilities = [
      ability('draw', [binding('cn.draw@1', { count: 1 })], { usage: { period: 'turn', scope, key: 'once', limit: 1 } }),
      ability('return', [binding('cn.fieldReturn@1', returning())]),
    ]);
    const g = board(f, (s) => { bench(s, 0, 'other'); });
    use(g, 'draw'); settle(g); const old = g.snapshot().players[0].active;
    use(g); answer(g, [old.id]); settle(g);
    command(g, { type: 'bench', cardId: old.stack[0] }); settle(g);
    const fresh = g.snapshot().players[0].bench.find((m) => m.stack[0] === old.stack[0]);
    assert.notEqual(fresh.id, old.id); assert.deepEqual(fresh.used, {}); assert.deepEqual(fresh.facts, {});
    assert.equal(fresh.counters, 0); assert.equal(fresh.conditions.poison, null);
    assert.equal(g.view(0).legalActions.some((a) => a.abilityId === 'draw' && a.pokemonId === fresh.id), scope === 'pokemon');
    if (scope === 'pokemon') { use(g, 'draw', fresh.id); settle(g); }
    else assert.deepEqual(g.snapshot().players[0].used.once, [g.snapshot().turn]);
  }
});

test('return/re-entry cannot revive another undeclared native trigger window from the old Pokémon identity', async () => {
  const trigger = { event: 'energyAttached', subject: 'self', origin: 'hand', optional: false, choiceOwner: 'source', scope: 'global' };
  const f = await fixture((defs) => defs[0].mechanics.abilities = [
    ability('bounce', [
      binding('cn.fieldReturn@1', returning()),
      binding('cn.cards@1', { from: 'hand', to: 'bench', selector: { kind: 'pokemon', nameKeys: ['base'] },
        quantity: { kind: 'exact', count: 1 }, reveal: true, lookTop: null, shuffleAfter: false }),
    ], { mode: 'triggered', trigger, usage: null }),
    ability('old-draw', [binding('cn.draw@1', { count: 1 })], { mode: 'triggered', trigger,
      usage: { period: 'turn', scope: 'pokemon', key: 'old-draw', limit: 1 } }),
  ]);
  let energy;
  const g = board(f, (s) => { bench(s, 0, 'other'); energy = hand(s, 0, 'water'); });
  const old = g.snapshot().players[0].active, deck = g.snapshot().players[0].deck;
  command(g, { type: 'attachEnergy', cardId: energy, pokemonId: old.id });
  answer(g, [g.view(0).pending.triggers.find((t) => t.abilityId === 'bounce').id]);
  answer(g, [old.id]); assert.equal(g.snapshot().pending.kind, 'select-cards');
  const r = restore(g, f);
  for (const h of [g, r]) { answer(h, [old.stack[0]]); settle(h); }
  assert.deepEqual(g.snapshot(), r.snapshot());
  const fresh = [g.snapshot().players[0].active, ...g.snapshot().players[0].bench].find((m) => m.stack[0] === old.stack[0]);
  assert.notEqual(fresh.id, old.id); assert.deepEqual(fresh.used, {});
  assert.deepEqual(g.snapshot().players[0].deck, deck, 'The retired identity must not draw or consume a new identity’s use.');
  assert(!g.snapshot().events.some((e) => e.data.abilityId === 'old-draw' && e.data.performed));
});

test('returning a target clears an undeclared delayed reaction, without cancelling already-declared effect programs', async () => {
  const trigger = { event: 'attackDamage', subject: 'self', optional: false, choiceOwner: 'source', scope: 'global' };
  const parameters = { side: 'own', target: 'self', trigger, program: [{ op: 'draw', count: 1 }],
    duration: 'untilNextOwnTurnEnd', clearOnBench: true, clearOnEvolution: true };
  const f = await fixture((defs) => {
    defs[0].mechanics.abilities = [ability('bounce', [
      binding('cn.fieldReturn@1', returning()), binding('cn.draw@1', { count: 1 }),
    ], { mode: 'triggered', trigger, usage: null })];
    defs[0].mechanics.attacks[0].effects = [binding('cn.delayedReaction@1', parameters, 'delayed-draw')];
  });
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water'); bench(s, 1, 'other');
    const m = s.players[1].active;
    s.ongoing.push(createOngoingEffect({ id: `e${++s.serial}`, targetId: m.id, source: {
      instanceId: m.stack[0], owner: 1, cardOwner: 1, category: 'attack', pokemonId: m.id, attackId: 'base:strike',
      effectId: 'fixture:delayed-draw', sourceOfTruth: EVIDENCE, origin: 'field',
    }, effect: { op: 'reaction', scope: 'all', trigger, program: [{ op: 'draw', count: 1 }], priorEventIds: [] },
    duration: 'untilNextOwnTurnEnd', clearOnBench: true, clearOnEvolution: true }, s));
  });
  const before = g.snapshot().players[1].deck.length;
  command(g, { type: 'attack', attackId: 'base:strike' });
  assert.equal(g.snapshot().pending.kind, 'effect-target'); answer(g, [g.snapshot().players[0].active.id]);
  answer(g, [g.view(1).pending.triggers.find((t) => t.abilityId === 'bounce').id]);
  answer(g, [g.snapshot().players[1].active.id]); settle(g);
  assert.equal(g.snapshot().players[1].deck.length, before - 2, 'Declared follow-up draw and next-turn draw occur, but the cleared reaction does not.');
  assert(!g.snapshot().ongoing.some((e) => e.targetId === g.snapshot().events.find((e) => e.ruleId === 'effects.field-return' && e.data.pokemonId)?.data.pokemonId));
});

test('return protection does not prevent target selection and does not unlock a dependent then', async () => {
  const a = returning({ side: 'opponent', target: 'active' });
  const f = await fixture((defs) => {
    defs[0].mechanics.abilities = [ability('return', [binding('fixture:protected-return', {})])];
    defs[0].mechanics.effects.push(binding('cn.protection@1', { effect: {
      op: 'protection', useRule: 'ordinary', scope: 'self', from: 'opponent', channel: 'effects', categories: ['ability'],
    } }));
  }, new Map([['fixture:protected-return', reviewed({ operations: ['then', 'returnPokemon', 'draw'],
    execute: () => [{ op: 'then', first: a, next: { op: 'draw', count: 1 } }] })]]));
  const g = board(f), s = g.snapshot(); use(g);
  assert(g.snapshot().pending.options.includes(s.players[1].active.id)); answer(g, [s.players[1].active.id]); settle(g);
  assert.equal(g.snapshot().players[1].active.id, s.players[1].active.id);
  assert.equal(g.snapshot().players[0].hand.length, s.players[0].hand.length);
});

test('a simultaneous return batch uses pre-return protection, not a protection that appears only after removing its first target', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.abilities = [ability('return', [binding('cn.fieldReturn@1', returning({
      side: 'opponent', target: 'bench', quantity: { kind: 'all' },
    }))])];
    defs[1].mechanics.effects = [binding('fixture:remaining-shield', {})];
  }, new Map([['fixture:remaining-shield', reviewed({ timing: 'continuous', operations: ['protection'], execute: (ctx) =>
    ctx.state.players[ctx.source.owner].bench.length === 1 ?
      [{ op: 'protection', useRule: 'ordinary', scope: 'own', from: 'opponent', channel: 'effects', categories: ['ability'] }] : [] })]]));
  const g = board(f, (s) => { bench(s, 1, 'other'); bench(s, 1, 'other'); });
  use(g); settle(g); assert.equal(g.snapshot().players[1].bench.length, 0);
});

test('returning an HP-granting continuous source can cause a later real KO without awarding a Prize for the returned source', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.abilities = [ability('return', [binding('cn.fieldReturn@1', returning({
      target: 'bench', selector: { kind: 'pokemon', nameKeys: ['other'] },
    }))])];
    defs[1].mechanics.effects = [binding('cn.modifier@1', { field: 'hp', amount: 50, scope: 'own' })];
  });
  let source;
  const g = board(f, (s) => {
    source = bench(s, 0, 'other').stack[0]; bench(s, 0, 'base'); s.players[0].active.counters = 12;
  });
  use(g); answer(g, [g.snapshot().players[0].bench.find((m) => m.stack[0] === source).id]); settle(g);
  assert(g.snapshot().players[0].hand.includes(source)); assert.equal(g.snapshot().players[1].prizes.length, 5);
  assert.equal(g.snapshot().players[0].active.counters, 0);
});

test('empty selection, no targets, and invalid answers preserve public quantity semantics and never invent a return', async () => {
  for (const quantity of [{ kind: 'any' }, { kind: 'upTo', count: 2 }, { kind: 'exact', count: 3 }]) {
    const f = await fixture((defs) => defs[0].mechanics.abilities = [ability('return', [binding('cn.fieldReturn@1', returning({
      target: 'bench', quantity,
    }))])]);
    const g = board(f, (s) => bench(s, 0, 'other')); use(g);
    if (quantity.kind === 'any') { answer(g, []); settle(g); assert.equal(g.snapshot().players[0].bench.length, 1); }
    else {
      const before = g.snapshot(); assert.throws(() => answer(g, []), /quantity/); assert.deepEqual(g.snapshot(), before);
      answer(g, g.snapshot().pending.options); settle(g); assert.equal(g.snapshot().players[0].bench.length, 0);
    }
    assert(!has(board(f), 'return'));
  }
  const f = await fixture((defs) => {
    defs[0].mechanics.attacks[0].cost = []; defs[0].mechanics.attacks[0].effects = [binding('cn.fieldReturn@1', returning({ target: 'bench' }))];
  });
  const g = board(f); command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 2);
});

test('attached multi-unit Energy returns as one whole card to its holder, with no attachment/movement trigger or quota reset', async () => {
  for (const to of ['hand', 'deckShuffle']) {
    const f = await fixture((defs) => defs[0].mechanics.abilities = [ability('return', [binding('cn.attachedEnergy@1', energyReturn({ to }))])]);
    let energy;
    const g = board(f, (s) => { energy = attached(s, 0, s.players[0].active, 'double'); s.players[0].flags.energy = true; });
    const before = g.snapshot(); use(g); assert.equal(g.snapshot().pending.kind, 'attached-energy');
    assert.equal(g.view(0).pending.energy[0].amount, 2); assert.deepEqual(restore(g, f).view(0), g.view(0));
    answer(g, [energy]); settle(g);
    const s = g.snapshot(); assert.equal(s.players[0].active.energy.length, 0);
    assert(s.players[0][to === 'hand' ? 'hand' : 'deck'].includes(energy)); assert.equal(s.players[0].flags.energy, true);
    assert.equal(s.players[1].prizes.length, 6);
    assert.equal(s.events.filter((e) => ['trigger.energy', 'energy.move'].includes(e.ruleId)).length,
      before.events.filter((e) => ['trigger.energy', 'energy.move'].includes(e.ruleId)).length);
    assert(s.events.some((e) => e.ruleId === 'energy.return' && e.data.discarded === false));
    assert.equal(f.catalog.definition('double').mechanics.baseUnits.length, 2);
  }
});

test('returning an opponent’s Energy respects holder choice and shuffles only that holder’s deck', async () => {
  const f = await fixture((defs) => defs[0].mechanics.abilities = [ability('return', [binding('cn.attachedEnergy@1',
    energyReturn({ side: 'opponent', from: 'active', to: 'deckShuffle', chooser: 'holder' }))])]);
  let energy;
  const g = board(f, (s) => { energy = attached(s, 1, s.players[1].active, 'water'); });
  const ownDeck = g.snapshot().players[0].deck; use(g); assert.equal(g.snapshot().pending.player, 1);
  answer(g, [energy]); settle(g);
  assert(g.snapshot().players[1].deck.includes(energy)); assert.deepEqual(g.snapshot().players[0].deck, ownDeck);
});

test('protected Energy return performs no shuffle or following then, while an actual return removing a HP boost reaches KO', async () => {
  const p = energyReturn({ side: 'opponent', from: 'active', to: 'deckShuffle' });
  const f = await fixture((defs) => {
    defs[0].mechanics.abilities = [ability('return', [binding('fixture:energy-return-then', {})])];
    defs[0].mechanics.effects.push(binding('cn.protection@1', { effect: {
      op: 'protection', useRule: 'ordinary', scope: 'self', from: 'opponent', categories: ['ability'], channel: 'effects',
    } }));
  }, new Map([['fixture:energy-return-then', reviewed({ operations: ['then', 'returnEnergy', 'draw'],
    execute: () => [{ op: 'then', first: p, next: { op: 'draw', count: 1 } }] })]]));
  let energy;
  const g = board(f, (s) => { energy = attached(s, 1, s.players[1].active, 'water'); });
  use(g); const before = g.snapshot(); answer(g, [energy]); settle(g);
  assert.deepEqual(g.snapshot().rng, before.rng); assert(g.snapshot().players[1].active.energy.includes(energy));
  assert.equal(g.snapshot().players[0].hand.length, before.players[0].hand.length);
  const hp = await fixture((defs) => {
    defs[0].mechanics.abilities = [ability('return', [binding('cn.attachedEnergy@1', energyReturn())])];
    defs.find((d) => d.definitionId === 'double').mechanics.effects = [binding('cn.modifier@1', { field: 'hp', amount: 50, scope: 'self' })];
  });
  const h = board(hp, (s) => { energy = attached(s, 0, s.players[0].active, 'double'); s.players[0].active.counters = 12; bench(s, 0, 'other'); });
  use(h); answer(h, [energy]); settle(h);
  assert(h.snapshot().players[0].hand.includes(energy)); assert.equal(h.snapshot().players[1].prizes.length, 5);
});

test('returning declaration Energy during the before-damage phase does not retroactively invalidate a declared attack', async () => {
  const f = await fixture((defs) => defs[0].mechanics.attacks[0].effects = [binding('fixture:energy-before-damage', {})],
    new Map([['fixture:energy-before-damage', reviewed({ timing: 'beforeDamage', operations: ['returnEnergy'],
      execute: () => [energyReturn()] })]]));
  let energy;
  const g = board(f, (s) => { energy = attached(s, 0, s.players[0].active, 'water'); });
  command(g, { type: 'attack', attackId: 'base:strike' }); answer(g, [energy]); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 2); assert(g.snapshot().players[0].hand.includes(energy));
});

test('unsupported before-damage Pokémon departure and latched-KO zone replacement fail closed, not as silent success', async () => {
  const f = await fixture((defs) => defs[0].mechanics.attacks[0].effects = [binding('fixture:early-return', {})],
    new Map([['fixture:early-return', reviewed({ timing: 'beforeDamage', operations: ['returnPokemon'], execute: () => [returning()] })]]));
  assert.throws(() => start(f), /Unimplemented or undeclared/);
  const k = await fixture((defs) => {
    defs[0].mechanics.abilities = [ability('ko-return', [binding('cn.fieldReturn@1', returning())], {
      mode: 'triggered', usage: null, trigger: { event: 'knockout', subject: 'self', optional: false, choiceOwner: 'source', scope: 'global' },
    })];
  });
  const g = board(k, (s) => { attached(s, 0, s.players[0].active, 'water'); s.players[1].active.counters = 8; bench(s, 1, 'other'); });
  command(g, { type: 'attack', attackId: 'base:strike' });
  assert.equal(g.snapshot().pending.kind, 'return-pokemon'); const before = g.snapshot();
  assert.throws(() => answer(g, [before.players[1].active.id]), (e) => e.code === 'unsupported-ko-zone-replacement');
  assert.deepEqual(g.snapshot(), before);
});

test('a native attachment reaction cannot bypass the unsupported pre-damage Pokémon-departure guard', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.attacks[0].effects = [binding('fixture:attach-before', {})];
    defs[0].mechanics.abilities = [ability('bounce', [binding('cn.fieldReturn@1', returning())], {
      mode: 'triggered', usage: null, trigger: { event: 'energyAttached', subject: 'self', origin: 'hand',
        optional: false, choiceOwner: 'source', scope: 'global' },
    })];
  }, new Map([['fixture:attach-before', reviewed({ timing: 'beforeDamage', operations: ['attachHand'], execute: () => [
    { op: 'attachHand', type: 'Water', count: 1, benchOnly: false, optional: false },
  ] })]]));
  let card;
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); card = hand(s, 0, 'water'); });
  command(g, { type: 'attack', attackId: 'base:strike' }); answer(g, [card]);
  const before = g.snapshot(); assert.equal(before.pending.kind, 'energy-recipient');
  assert.throws(() => answer(g, [before.players[0].active.id]), (e) => e.code === 'unsupported-attack-transition');
  assert.deepEqual(g.snapshot(), before);
});
test('field-target predicates use real subject/attacker identities and positions, never substitute another Active after departure', async () => {
  const f = await fixture(), definitions = Object.fromEntries(f.definitions.map((d) => [d.definitionId, d]));
  const ctx = { source: { owner: 0, pokemonId: 'a' }, event: { subjectId: 'b', cause: { source: { pokemonId: 'a' } } }, definitions,
    effectivePokemon: { a: { types: ['Water'] }, b: { types: ['Water'] } },
    state: { cards: { ca: { definitionId: 'base' }, cb: { definitionId: 'other' } },
      players: [{ active: { id: 'a', stack: ['ca'] }, bench: [{ id: 'b', stack: ['cb'] }] }, { active: null, bench: [] }] } };
  for (const [target, ids] of [['active', ['a']], ['bench', ['b']], ['self', ['a']], ['event', ['b']], ['attacker', ['a']], ['any', ['a', 'b']]])
    assert.deepEqual(fieldReturnTargets(ctx, returning({ target })).map((m) => m.id), ids);
  assert.deepEqual(fieldReturnTargets(ctx, returning({ side: 'opponent', target: 'any' })), []);
  assert.deepEqual(fieldReturnTargets({ ...ctx, event: null }, returning({ target: 'event' })), []);
  assert.deepEqual(fieldReturnTargets({ ...ctx, event: null }, returning({ target: 'attacker' })), []);
  const departed = structuredClone(ctx); departed.state.players[0].active = null;
  assert.deepEqual(fieldReturnTargets(departed, returning({ target: 'self' })), []);
});

test('field-return CardSelectors use each actual recipient’s effective types, not printed or source types', async () => {
  const f = await fixture(), definitions = Object.fromEntries(f.definitions.map((d) => [d.definitionId, d]));
  const ctx = {
    source: { owner: 0, pokemonId: 'a' }, definitions,
    state: { cards: { ca: { definitionId: 'base' }, cb: { definitionId: 'other' }, co: { definitionId: 'base' } },
      players: [{ active: { id: 'a', stack: ['ca'] }, bench: [{ id: 'b', stack: ['cb'] }] },
        { active: { id: 'o', stack: ['co'] }, bench: [] }] },
    effectivePokemon: { a: { types: ['Lightning', 'Metal'], hp: 10 }, b: { types: ['Fire'] }, o: { types: ['Dragon'] } },
  };
  const before = structuredClone(ctx);
  for (const [side, types, expected] of [
    ['own', ['Water'], []], ['own', ['Lightning'], ['a']], ['own', ['Fire'], ['b']],
    ['own', ['Metal', 'Fire'], ['a', 'b']], ['opponent', ['Dragon'], ['o']], ['opponent', ['Water'], []],
  ]) assert.deepEqual(fieldReturnTargets(ctx, returning({ side, target: 'any', selector: { kind: 'pokemon', types } }))
    .map((m) => m.id), expected);
  assert.deepEqual(fieldReturnTargets(ctx, returning({ selector: { kind: 'pokemon', types: ['Lightning'], nameKeys: ['base'] } }))
    .map((m) => m.id), ['a']);
  assert.deepEqual(fieldReturnTargets(ctx, returning({ selector: { kind: 'pokemon', types: ['Lightning'], nameKeys: ['other'] } })), []);
  assert.deepEqual(fieldReturnTargets(ctx, returning({ selector: { kind: 'pokemon', types: ['Lightning'], printedHpAtMost: 10 } })), [],
    'Only types are effective: printed HP is not the current HP or effective maximum.');
  assert.deepEqual(ctx, before);
  for (const mutate of [
    (c) => { delete c.effectivePokemon; }, (c) => { c.effectivePokemon = {}; },
    (c) => { delete c.effectivePokemon.a.types; }, (c) => { c.effectivePokemon.a.types = null; },
    (c) => { c.effectivePokemon.a.types = []; }, (c) => { c.effectivePokemon.a.types = ['Fake']; },
    (c) => { c.effectivePokemon.a.types = ['Water', 'Water']; },
  ]) {
    const invalid = structuredClone(ctx); mutate(invalid);
    assert.throws(() => fieldReturnTargets(invalid, returning()), TypeError, 'No implicit printed Water fallback.');
  }
});

test('a Bench-only return has no promotion schedule; any return that may vacate the Active needs one', () => {
  const valid = (p) => createCoreHandlers().get('cn.fieldReturn@1').validateParameters(p);
  const schedule = { timing: 'afterAction', sourceOfTruth: EVIDENCE };
  assert.equal(valid(returning({ target: 'bench' })), true);
  assert.equal(valid({ ...returning({ target: 'bench' }), promotion: schedule }), false);
  for (const target of ['self', 'active', 'any']) {
    assert.equal(valid(returning({ target, promotion: schedule })), true, target);
    const { promotion: _p, ...without } = returning({ target });
    assert.equal(valid(without), false, target);
  }
});

test('a schedule cites this card\'s own evidence: a card-library record only on a machine definition', async () => {
  const library = [{ sourceId: 'library:TEST/001_010', kind: 'card-library', url: 'https://tcg.mik.moe/cards/TEST/001',
    locator: 'TEST ONLY: fictitious library record' }];
  assert(validateFieldReturnParameters(returning({ promotion: { timing: 'afterRelatedResolution', sourceOfTruth: library } })));
  await assert.rejects(fixture((defs) => defs[0].mechanics.attacks[0].effects = [binding('cn.fieldReturn@1',
    returning({ promotion: { timing: 'afterRelatedResolution', sourceOfTruth: library } }))]), /Only a machine definition/);
});

test('「身上放置有伤害指示物的1只…宝可梦」: only Pokémon in the stated condition may be chosen, read when choosing', async () => {
  const f = await fixture(), definitions = Object.fromEntries(f.definitions.map((d) => [d.definitionId, d]));
  const calm = { rotation: null, poison: null, burned: false };
  const mon = (id, counters) => ({ id, stack: [`c${id}`], counters, tools: [], conditions: calm });
  const ctx = { source: { owner: 0, pokemonId: 'a' }, event: null, definitions,
    effectivePokemon: { a: { types: ['Water'], abilities: [], energies: [] }, b: { types: ['Water'], abilities: [], energies: [] } },
    state: { cards: { ca: { definitionId: 'base' }, cb: { definitionId: 'other' } },
      players: [{ active: mon('a', 0), bench: [mon('b', 2)] }, { active: null, bench: [] }] } };
  assert.deepEqual(fieldReturnTargets(ctx, returning({ target: 'any', state: { damaged: true } })).map((m) => m.id), ['b']);
  assert.deepEqual(fieldReturnTargets(ctx, returning({ target: 'any', state: { damaged: true }, selector: { kind: 'pokemon', nameKeys: ['base'] } })), []);
  const charged = structuredClone(ctx);
  charged.effectivePokemon.a.energies = [{ instanceId: 'cw', units: [['Water']] }]; charged.state.cards.cw = { definitionId: 'water' };
  assert.deepEqual(fieldReturnTargets(charged, returning({ target: 'any', state: { energy: { selector: { kind: 'energy', category: 'basic' } } } })).map((m) => m.id), ['a']);
  assert.deepEqual(fieldReturnTargets(ctx, returning({ target: 'any', state: { undamaged: true } })).map((m) => m.id), ['a']);
  assert(validateFieldReturnParameters(returning({ target: 'any', state: { damaged: true } })));
  assert(!validateFieldReturnParameters(returning({ target: 'any', state: { remainingHpAtMost: 30 } })));
  assert(!validateFieldReturnParameters(returning({ target: 'any', state: {} })));
  const g = await fixture((defs) => { defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.fieldReturn@1',
    returning({ target: 'any', state: { damaged: true }, promotion: { timing: 'afterAction', sourceOfTruth: EVIDENCE } }), 'scoop')]; });
  let card, hurt;
  const k = board(g, (s) => { bench(s, 0, 'other'); hurt = bench(s, 0, 'other'); hurt.counters = 3; card = hand(s, 0, 'potion'); });
  command(k, { type: 'playTrainer', cardId: card });
  assert.deepEqual(k.snapshot().pending.options, [hurt.id]);
  answer(k, [hurt.id]); settle(k);
  assert.equal(k.snapshot().players[0].bench.length, 1);
});
