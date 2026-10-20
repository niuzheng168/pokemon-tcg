import test from 'node:test';
import assert from 'node:assert/strict';
import { assertActivationCosts, costCardCount, findCostPayment, readCostPayment, paymentOptionId,
  ACTIVATION_COST_RULE_IDS } from '../../public/rules/activation-cost.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { OfficialGame } from '../../public/rules/game.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, board, start, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const cost = (count = 1, selector = { kind: 'any' }, costId = 'fee') => ({
  costId, kind: 'discardHand', count, selector, sourceOfTruth: EVIDENCE,
});
const ability = (effects, costs = [cost()], extra = {}) => ({
  abilityId: 'paid', name: '测试使用条件', mode: 'activated',
  usage: { period: 'turn', scope: 'pokemon', key: 'paid', limit: 1 }, costs, effects, sourceOfTruth: EVIDENCE, ...extra,
});
const use = (g) => command(g, { type: 'useAbility', abilityId: 'paid', pokemonId: g.snapshot().players[0].active.id });
const restore = (g, f) => OfficialGame.restore(JSON.parse(JSON.stringify(g.snapshot())), { catalog: f.catalog });
const end = (g) => { command(g, { type: 'endTurn' }); settle(g); };
const pay = (g, ids) => answer(g, ids.map((id, i) => paymentOptionId(g.view(g.snapshot().pending.player).pending.payment.groups[i]?.costId ?? 'fee', id)));
const setHand = (s, owner, definitions) => {
  const p = s.players[owner]; p.discard.push(...p.hand.splice(0));
  const ids = [];
  for (const d of definitions) {
    const id = hand(s, owner, d); p.hand.pop(); p.resolving.push(id); ids.push(id);
  }
  for (const id of ids) { p.resolving.splice(p.resolving.indexOf(id), 1); p.hand.push(id); }
  return ids;
};
const put = (s, owner, id, zone) => {
  const card = hand(s, owner, id); s.players[owner].hand.pop(); s.players[owner][zone].push(card); return card;
};

test('exact hand costs match an independent exhaustive assignment oracle, including reserved and required cards', async () => {
  for (const id of ACTIVATION_COST_RULE_IDS) assert(requireRule(CN_V20261019, id).sourceOfTruth.length);
  const f = await fixture(), kinds = ['energy', 'pokemon', 'trainer', 'energy'];
  const defs = { energy: f.catalog.definition('water'), pokemon: f.catalog.definition('base'), trainer: f.catalog.definition('potion') };
  let checked = 0;
  for (let n = 0; n <= 4; n++) for (const a of ['any', 'energy', 'pokemon', 'trainer']) for (const b of ['any', 'energy', 'pokemon', 'trainer'])
    for (const counts of [[1, 1], [1, 2], [2, 1]]) for (const restrictions of [
      {}, { reserveIds: ['c0'] }, { requiredIds: ['c0'] }, { reserveIds: ['c0'], requiredIds: ['c0'] }, { requiredIds: ['c0', 'c1'] },
    ]) {
      const cards = Array.from({ length: n }, (_, i) => ({ instanceId: `c${i}`, definition: defs[kinds[i]] }));
      const costs = [cost(counts[0], { kind: a }, 'a'), cost(counts[1], { kind: b }, 'b')];
      const expected = (function visit(i, groups) {
        if (i === n) {
          const paid = groups.flat();
          return groups.every((g, j) => g.length === counts[j]) &&
            (restrictions.requiredIds ?? []).every((id) => paid.includes(id));
        }
        if (visit(i + 1, groups)) return true;
        if ((restrictions.reserveIds ?? []).includes(`c${i}`)) return false;
        for (const [j, kind] of [a, b].entries()) if (groups[j].length < counts[j] && (kind === 'any' || kind === kinds[i])) {
          const next = groups.map((g) => [...g]); next[j].push(`c${i}`);
          if (visit(i + 1, next)) return true;
        }
        return false;
      })(0, [[], []]);
      const result = findCostPayment(costs, cards, restrictions);
      assert.equal(result !== null, expected, JSON.stringify({ n, a, b, counts, restrictions }));
      if (result) assert.deepEqual(readCostPayment(costs, cards, result.flatMap((g) =>
        g.cardIds.map((id) => paymentOptionId(g.costId, id)))), result);
      checked++;
    }
  assert.equal(checked, 1200);
});

test('costs count physical cards, reject overlapping payment/different group counts and fail closed on malformed data', async () => {
  const f = await fixture(), water = f.catalog.definition('water'), double = f.catalog.definition('double');
  const cards = [{ instanceId: 'a', definition: water }, { instanceId: 'b', definition: double }];
  const costs = [cost(1, { kind: 'any' }, 'any'), cost(1, { kind: 'energy' }, 'energy')];
  assert(findCostPayment(costs, cards));
  assert.equal(findCostPayment([cost(2)], [cards[1]]), null, 'Two provided Energy units are not two discarded hand cards.');
  for (const selected of [[], ['not-json'], ['not-json', paymentOptionId('energy', 'b')], ['{}', '[]'], ['["any"]', '["energy","b"]'],
    [paymentOptionId('any', 'a'), paymentOptionId('energy', 'a')],
    [paymentOptionId('any', 'a'), paymentOptionId('any', 'b')],
    [paymentOptionId('wrong', 'a'), paymentOptionId('energy', 'b')],
    [paymentOptionId('any', 'missing'), paymentOptionId('energy', 'b')]]) assert.equal(readCostPayment(costs, cards, selected), null);
  assert.equal(readCostPayment([cost(1, { kind: 'pokemon' })], cards, [paymentOptionId('fee', 'a')]), null);
  for (const invalid of [[], [cost(0)], [cost(1), cost(1)], [{ ...cost(), sourceOfTruth: [] }]])
    assert.throws(() => assertActivationCosts(invalid), /Activation costs/);
  assert.throws(() => costCardCount([cost(Number.MAX_SAFE_INTEGER), cost(1, { kind: 'any' }, 'b')]), /Unsafe/);
  for (const pool of [null, [null], [cards[0], cards[0]], [{ instanceId: '', definition: water }], [{ instanceId: 'a' }],
    [{ instanceId: {}, definition: water }], [{ instanceId: 'a', definition: [] }]])
    assert.throws(() => findCostPayment([cost()], pool), /Cost candidates/);
  assert.equal(costCardCount(costs), 2);
});

test('E-30 draw-until uses post-payment hand size; failed answers neither discard nor consume a use or RNG', async () => {
  const f = await fixture((defs) => defs[0].mechanics.abilities = [
    ability([binding('cn.drawUntil@1', { count: 6 })], [cost(1, { kind: 'energy' })]),
  ]);
  let ids;
  let g = board(f, (s) => { ids = setHand(s, 0, ['water', 'water', 'water', 'water', 'water', 'research']); });
  assert.equal(g.snapshot().players[0].hand.length, 6);
  use(g); const before = g.snapshot();
  assert.equal(before.pending.kind, 'activation-cost'); assert.equal(before.pending.minimum, 1);
  assert.equal(g.view(1).pending, null); assert.equal(before.players[0].active.used.paid, undefined);
  assert.throws(() => answer(g, []), /Invalid selection/);
  assert.throws(() => answer(g, [paymentOptionId('fee', ids.at(-1))]), /Invalid selection/);
  assert.deepEqual(g.snapshot(), before);
  g = restore(g, f); pay(g, [ids[0]]); settle(g);
  assert.equal(g.snapshot().players[0].hand.length, 6);
  assert(g.snapshot().players[0].discard.includes(ids[0]));
  assert.equal(g.snapshot().players[0].active.used.paid.length, 1);
  assert.equal(g.snapshot().events.filter((e) => e.ruleId === 'effects.activation-cost').length, 1);
  assert.deepEqual(g.snapshot().rng, before.rng);
});

test('known impossible payment or no usable post-cost result cannot declare, even though paying alone would change the hand', async () => {
  for (const mode of ['short', 'full-after-cost', 'empty-deck']) {
    const f = await fixture((defs) => defs[0].mechanics.abilities = [ability(
      [binding('cn.drawUntil@1', { count: 6 })], [cost(mode === 'short' ? 2 : 1, { kind: 'energy' })])]);
    const g = board(f, (s) => {
      setHand(s, 0, mode === 'full-after-cost' ? Array(7).fill('water') : ['water']);
      if (mode === 'empty-deck') s.players[0].discard.push(...s.players[0].deck.splice(0));
    });
    assert(!g.view(0).legalActions.some((a) => a.abilityId === 'paid'));
    const before = g.snapshot(); assert.throws(() => use(g), /not legal/); assert.deepEqual(g.snapshot(), before);
  }
});

test('multiple overlapping cost groups are selected explicitly and cannot spend one hand card twice', async () => {
  const f = await fixture((defs) => defs[0].mechanics.abilities = [ability([binding('cn.draw@1', { count: 1 })], [
    cost(1, { kind: 'any' }, 'a'), cost(1, { kind: 'energy' }, 'b'),
  ])]);
  let ids;
  const g = board(f, (s) => { ids = setHand(s, 0, ['water', 'other']); });
  use(g); const before = g.snapshot();
  assert.throws(() => answer(g, [paymentOptionId('a', ids[0]), paymentOptionId('b', ids[0])]), /no card paid twice/);
  assert.deepEqual(g.snapshot(), before);
  answer(g, [paymentOptionId('a', ids[1]), paymentOptionId('b', ids[0])]); settle(g);
  const receipt = g.snapshot().events.find((e) => e.ruleId === 'effects.activation-cost').data.payment;
  assert.deepEqual(receipt.groups, [{ costId: 'a', cardIds: [ids[1]] }, { costId: 'b', cardIds: [ids[0]] }]);
});

test('a valid cost choice must preserve a usable hand target; a rejected choice does not partially pay', async () => {
  const p = { from: 'hand', to: 'bench', selector: { kind: 'pokemon' }, quantity: { kind: 'exact', count: 1 },
    reveal: true, lookTop: null, shuffleAfter: false };
  const f = await fixture((defs) => defs[0].mechanics.abilities = [ability([binding('cn.cards@1', p)])]);
  let ids;
  let g = board(f, (s) => { ids = setHand(s, 0, ['other', 'water']); });
  use(g); const before = g.snapshot();
  assert.throws(() => pay(g, [ids[0]]), /no usable subsequent effect/);
  assert.deepEqual(g.snapshot(), before);
  g = restore(g, f); pay(g, [ids[1]]);
  assert.equal(g.snapshot().pending.kind, 'select-cards');
  const saved = g.snapshot(), bad = structuredClone(saved); bad.pending.data.payment.groups[0].cardIds[0] = ids[0];
  assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }), /journaled receipt/);
  g = restore(g, f); answer(g, [ids[0]]); settle(g);
  assert(g.snapshot().players[0].bench.some((m) => m.stack[0] === ids[0]));
});

test('Trainer play costs exclude that Trainer, commit before effects, and do not prematurely discard the resolving card', async () => {
  const params = { from: 'deck', to: 'hand', selector: { kind: 'pokemon' }, quantity: { kind: 'exact', count: 1 },
    reveal: true, lookTop: null, shuffleAfter: true };
  const f = await fixture((defs) => {
    const d = defs.find((d) => d.definitionId === 'potion'); d.mechanics.playCosts = [cost(2)];
    d.mechanics.effects = [binding('cn.cards@1', params)];
  });
  const short = board(f, (s) => setHand(s, 0, ['potion', 'water']));
  assert(!short.view(0).legalActions.some((a) => a.type === 'playTrainer' && short.snapshot().cards[a.cardId].definitionId === 'potion'));
  let ids;
  let g = board(f, (s) => { ids = setHand(s, 0, ['potion', 'water', 'water']); });
  command(g, { type: 'playTrainer', cardId: ids[0] }); const before = g.snapshot();
  assert(before.players[0].hand.includes(ids[0])); assert(!before.players[0].resolving.includes(ids[0]));
  assert(!g.snapshot().pending.options.includes(paymentOptionId('fee', ids[0])));
  assert.throws(() => answer(g, [paymentOptionId('fee', ids[1])]), /Invalid selection/);
  assert.deepEqual(g.snapshot(), before);
  g = restore(g, f); answer(g, ids.slice(1).map((id) => paymentOptionId('fee', id)));
  assert.equal(g.snapshot().pending.kind, 'select-cards'); assert(g.snapshot().players[0].resolving.includes(ids[0]));
  assert(!g.snapshot().players[0].discard.includes(ids[0]));
  g = restore(g, f); answer(g, []); settle(g);
  assert(g.snapshot().players[0].discard.includes(ids[0]));
});

test('Supporter and VSTAR limits are consumed only after a complete accepted payment', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'research').mechanics.playCosts = [cost()];
    defs[0].mechanics.abilities = [ability([binding('cn.draw@1', { count: 1 })], [cost()], { specialRule: 'VSTAR' })];
  });
  let ids;
  const g = board(f, (s) => { ids = setHand(s, 0, ['research', 'water', 'water']); });
  command(g, { type: 'playTrainer', cardId: ids[0] }); assert.equal(g.snapshot().players[0].flags.supporter, false);
  pay(g, [ids[1]]); settle(g); assert.equal(g.snapshot().players[0].flags.supporter, true);
  use(g); assert.equal(g.snapshot().players[0].vstarUsed, false);
  pay(g, [g.snapshot().players[0].hand[0]]); settle(g);
  assert.equal(g.snapshot().players[0].vstarUsed, true);
});

test('a cost may create a discard target, and recovery of that paid card does not invalidate the historical receipt', async () => {
  const params = { from: 'discard', to: 'hand', selector: { kind: 'energy' }, quantity: { kind: 'exact', count: 1 },
    reveal: true, lookTop: null, shuffleAfter: false };
  const f = await fixture((defs) => defs[0].mechanics.abilities = [ability([
    binding('cn.cards@1', params), binding('cn.draw@1', { count: 1 }),
  ], [cost(1, { kind: 'energy' })])]);
  let id;
  let g = board(f, (s) => {
    id = setHand(s, 0, ['water'])[0];
    for (const card of [...s.players[0].discard]) if (s.cards[card].definitionId === 'water') {
      s.players[0].discard.splice(s.players[0].discard.indexOf(card), 1); s.players[0].deck.push(card);
    }
  });
  use(g); pay(g, [id]); assert.equal(g.snapshot().pending.kind, 'select-cards');
  g = restore(g, f); answer(g, [id]); settle(g);
  assert(g.snapshot().players[0].hand.includes(id)); assert.equal(g.snapshot().players[0].active.used.paid.length, 1);
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
});

test('paying before a nested before-hand window survives restore and never charges or records the use twice', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.abilities = [ability([binding('cn.draw@1', { count: 1 })])];
    defs[2].mechanics.abilities = [{
      abilityId: 'incoming', name: '测试入场', mode: 'triggered', usage: null, sourceOfTruth: EVIDENCE,
      trigger: { event: 'beforeHand', origin: 'draw', turn: 'own', drawReason: 'effect', optional: true, afterUse: 'hand' },
      effects: [binding('cn.deployIncoming@1', {})],
    }];
  });
  let fee;
  let g = board(f, (s) => { fee = setHand(s, 0, ['water'])[0]; put(s, 0, 'evolution', 'deck'); });
  use(g); pay(g, [fee]); assert.equal(g.snapshot().pending.kind, 'before-hand-optional');
  g = restore(g, f); answer(g, ['perform']); settle(g);
  assert.equal(g.snapshot().players[0].active.used.paid.length, 1);
  assert.equal(g.snapshot().events.filter((e) => e.ruleId === 'effects.activation-cost').length, 1);
});

test('shared Stadium user pays their own cost and receives their effects, independent of the card printing holder', async () => {
  const core = createCoreHandlers().get('cn.draw@1'), h = { ...core, timing: 'onUse',
    usage: { period: 'turn', scope: 'player', key: 'stadium-use', limit: 1 } };
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [
      { ...binding('fixture:stadium', { count: 1 }, 'one'), activationCosts: [cost(1, { kind: 'energy' })] },
      binding('fixture:stadium', { count: 1 }, 'two'),
    ];
    defs[2].mechanics.abilities = [{
      abilityId: 'incoming', name: '测试入场', mode: 'triggered', usage: null, sourceOfTruth: EVIDENCE,
      trigger: { event: 'beforeHand', origin: 'draw', turn: 'own', drawReason: 'effect', optional: true, afterUse: 'hand' },
      effects: [binding('cn.deployIncoming@1', {})],
    }];
  }, new Map([['fixture:stadium', h]]));
  let fee;
  let g = board(f, (s) => {
    s.stadium = put(s, 0, 'stadium', 'resolving'); s.players[0].resolving.pop();
    fee = setHand(s, 1, ['water'])[0]; put(s, 1, 'evolution', 'deck'); put(s, 1, 'water', 'deck');
  });
  end(g); const before = g.snapshot(), hand0 = [...before.players[0].hand], n = before.players[1].hand.length;
  command(g, { type: 'useStadium' }); assert.equal(g.snapshot().pending.player, 1);
  g = restore(g, f); pay(g, [fee]);
  assert.equal(g.snapshot().pending.kind, 'before-hand-optional');
  const saved = g.snapshot(), effect = saved.queue.find((t) => t.op === 'effect');
  assert.equal(effect.data.source.owner, 1); assert.equal(effect.data.source.cardOwner, 0);
  const bad = structuredClone(saved); bad.queue.find((t) => t.op === 'effect').data.source.owner = 0;
  assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }), /actual activator/);
  g = restore(g, f); answer(g, ['skip']); settle(g);
  assert.deepEqual(g.snapshot().players[0].hand, hand0);
  assert.equal(g.snapshot().players[1].hand.length, n + 1);
  assert.equal(g.snapshot().players[1].used['stadium-use'].length, 1, 'Two written effects are still one shared use.');
  assert(!g.view(1).legalActions.some((a) => a.type === 'useStadium'));
});

test('a Prize-only Trainer can pay its own activation condition while its card remains outside hand', async () => {
  const f = await fixture((defs) => defs.find((d) => d.definitionId === 'potion').mechanics.effects = [{
    ...binding('cn.cards@1', { from: 'deck', to: 'hand', selector: { kind: 'pokemon' },
      quantity: { kind: 'exact', count: 1 }, reveal: true, lookTop: null, shuffleAfter: true }),
    activationCosts: [cost()], trigger: { event: 'beforeHand', origin: 'prizes', turn: 'own',
      drawReason: 'any', optional: true, afterUse: 'discard' },
  }]);
  let fee, item;
  let g = board(f, (s) => {
    item = hand(s, 0, 'potion'); s.players[0].hand.pop();
    s.players[0].hand.push(s.players[0].prizes[0]); s.players[0].prizes[0] = item;
    fee = setHand(s, 0, ['water'])[0];
    attached(s, 0, s.players[0].active, 'water'); s.players[1].active.counters = 8; bench(s, 1, 'other');
  });
  command(g, { type: 'attack', attackId: 'base:strike' }); answer(g, ['0']); answer(g, ['perform']);
  assert.equal(g.snapshot().pending.kind, 'activation-cost'); assert(g.snapshot().players[0].resolving.includes(item));
  g = restore(g, f); pay(g, [fee]); assert.equal(g.snapshot().pending.kind, 'select-cards');
  g = restore(g, f); answer(g, []); settle(g);
  assert(g.snapshot().players[0].discard.includes(item)); assert(g.snapshot().players[0].discard.includes(fee));
});

test('attachment condition and triggered condition have distinct receipts; restoring the second payment cannot forge the first', async () => {
  const core = createCoreHandlers().get('cn.draw@1');
  const h = { ...core, execute: (ctx, p) => {
    assert.equal(ctx.event.payment.groups[0].costId, 'attach');
    assert.equal(ctx.payment.groups[0].costId, 'react');
    return core.execute(ctx, p);
  } };
  const f = await fixture((defs) => {
    const d = defs.find((d) => d.definitionId === 'double');
    d.mechanics.attachCosts = [cost(1, { kind: 'any' }, 'attach')];
    d.mechanics.effects = [{
      ...binding('fixture:two-receipts', { count: 1 }), activationCosts: [cost(1, { kind: 'any' }, 'react')],
      trigger: { event: 'energyAttached', origin: 'hand', subject: 'self', cardIsSource: true,
        optional: true, scope: 'global', choiceOwner: 'source' },
    }];
  }, new Map([['fixture:two-receipts', h]]));
  let ids;
  let g = board(f, (s) => { ids = setHand(s, 0, ['double', 'water', 'water']); });
  command(g, { type: 'attachEnergy', cardId: ids[0], pokemonId: g.snapshot().players[0].active.id }); pay(g, [ids[1]]);
  assert.equal(g.snapshot().pending.kind, 'trigger-optional'); answer(g, ['perform']);
  assert.equal(g.snapshot().pending.kind, 'activation-cost');
  const bad = g.snapshot(); bad.pending.data.activation.unit.event.payment.groups[0].cardIds[0] = ids[2];
  assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }), /journaled receipt/);
  g = restore(g, f); pay(g, [ids[2]]); settle(g);
  assert.equal(g.snapshot().events.filter((e) => e.ruleId === 'effects.activation-cost').length, 2);
});

test('pending fee snapshots cannot change payer, exact quantity, eligible groups or the original source card', async () => {
  const f = await fixture((defs) => defs[0].mechanics.abilities = [ability([binding('cn.draw@1', { count: 1 })])]);
  const g = board(f, (s) => setHand(s, 0, ['water']));
  use(g); const original = g.snapshot();
  for (const mutate of [
    (s) => { s.pending.player = 1; }, (s) => { s.pending.minimum = 0; }, (s) => { s.pending.allowZero = true; },
    (s) => { s.pending.options = []; s.pending.minimum = s.pending.maximum = 0; },
    (s) => { s.pending.data.activation.sourceId = 'missing'; },
    (s) => { s.pending.data.activation.abilityId = 'missing'; },
  ]) {
    const s = structuredClone(original); mutate(s);
    assert.throws(() => OfficialGame.restore(s, { catalog: f.catalog }), /Pending fee|pending payment|Invalid activation|Corrupt pending/);
  }
});

test('from-hand Special Energy attachment costs precede attachment/turn flags; Prize-origin attachment is exempt', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'double').mechanics.attachCosts = [cost()];
  });
  let ids;
  let g = board(f, (s) => { ids = setHand(s, 0, ['double', 'water']); });
  command(g, { type: 'attachEnergy', cardId: ids[0], pokemonId: g.snapshot().players[0].active.id });
  assert.equal(g.snapshot().players[0].flags.energy, false);
  assert(!g.snapshot().players[0].active.energy.includes(ids[0]));
  g = restore(g, f); pay(g, [ids[1]]); settle(g);
  assert(g.snapshot().players[0].active.energy.includes(ids[0])); assert(g.snapshot().players[0].flags.energy);
  const poor = board(f, (s) => setHand(s, 0, ['double']));
  assert(!poor.view(0).legalActions.some((a) => a.type === 'attachEnergy'));
});

test('an optional native trigger pays after acceptance, not when offered or skipped', async () => {
  const f = await fixture((defs) => defs[1].mechanics.abilities = [ability([binding('cn.draw@1', { count: 1 })], [cost()], {
    mode: 'triggered', trigger: { event: 'bench', origin: 'hand', subject: 'self', scope: 'global',
      choiceOwner: 'source', optional: true },
  })]);
  for (const accept of [false, true]) {
    let ids;
    let g = board(f, (s) => { ids = setHand(s, 0, ['other', 'water']); });
    command(g, { type: 'bench', cardId: ids[0] }); assert.equal(g.snapshot().pending.kind, 'trigger-optional');
    answer(g, [accept ? 'perform' : 'skip']);
    if (accept) {
      assert.equal(g.snapshot().pending.kind, 'activation-cost');
      assert.equal(g.snapshot().players[0].bench[0].used.paid, undefined);
      g = restore(g, f); pay(g, [ids[1]]); settle(g);
      assert.equal(g.snapshot().players[0].bench[0].used.paid.length, 1);
    } else {
      assert(g.snapshot().players[0].hand.includes(ids[1]));
      assert.equal(g.snapshot().players[0].bench[0].used.paid, undefined);
    }
  }
});

test('before-hand Ability costs are paid from the holder hand, with the original receipt/window retained', async () => {
  const f = await fixture((defs) => {
    defs[2].mechanics.abilities = [ability([binding('cn.deployIncoming@1', {})], [cost()], {
      abilityId: 'incoming', mode: 'triggered', usage: null,
      trigger: { event: 'beforeHand', origin: 'draw', turn: 'own', drawReason: 'turnStart', optional: true, afterUse: 'hand' },
    })];
  });
  let fee, incoming;
  let g = board(f, (s) => {
    fee = setHand(s, 0, ['water'])[0]; incoming = put(s, 0, 'evolution', 'deck'); put(s, 1, 'water', 'deck');
  });
  end(g); command(g, { type: 'endTurn' }); assert.equal(g.snapshot().pending.kind, 'before-hand-optional');
  answer(g, ['perform']); assert.equal(g.snapshot().pending.kind, 'activation-cost');
  assert(!g.snapshot().pending.options.includes(paymentOptionId('fee', incoming)));
  g = restore(g, f); pay(g, [fee]); settle(g);
  assert(g.snapshot().players[0].bench.some((m) => m.stack[0] === incoming));
  assert(g.snapshot().players[0].discard.includes(fee));
});

test('a paid hand attachment exposes its immutable fee receipt to the attachment event without paying it again', async () => {
  const core = createCoreHandlers().get('cn.draw@1');
  const inspect = { ...core, execute: (ctx, p) => {
    assert.equal(ctx.event.payment.kind, 'energy');
    assert.equal(ctx.event.payment.groups[0].cardIds.length, 1);
    return core.execute(ctx, p);
  } };
  const f = await fixture((defs) => {
    const d = defs.find((d) => d.definitionId === 'double');
    d.mechanics.attachCosts = [cost()]; d.mechanics.effects = [{
      ...binding('fixture:inspect-attachment', { count: 1 }), trigger: {
        event: 'energyAttached', origin: 'hand', subject: 'self', cardIsSource: true,
        scope: 'global', choiceOwner: 'source', optional: false,
      },
    }];
  }, new Map([['fixture:inspect-attachment', inspect]]));
  let ids;
  const g = board(f, (s) => { ids = setHand(s, 0, ['double', 'water']); });
  command(g, { type: 'attachEnergy', cardId: ids[0], pokemonId: g.snapshot().players[0].active.id });
  pay(g, [ids[1]]); settle(g);
  assert.equal(g.snapshot().events.filter((e) => e.ruleId === 'effects.activation-cost').length, 1);
});

test('normal Tool/Stadium placement can pay a physical placement fee without misusing continuous effect predicates', async () => {
  const f = await fixture((defs) => {
    for (const id of ['tool', 'stadium']) defs.find((d) => d.definitionId === id).mechanics.playCosts = [cost()];
  });
  for (const definitionId of ['tool', 'stadium']) {
    let ids;
    const g = board(f, (s) => { ids = setHand(s, 0, [definitionId, 'water']); });
    command(g, { type: 'playTrainer', cardId: ids[0] }); pay(g, [ids[1]]); settle(g);
    assert(g.snapshot().players[0].discard.includes(ids[1]));
    if (definitionId === 'tool') assert(g.snapshot().players[0].active.tools.includes(ids[0]));
    else assert.equal(g.snapshot().stadium, ids[0]);
  }
});

test('cost-aware hand/discard attachment and shuffle proofs use the post-payment resources', async () => {
  for (const op of ['cn.attachHand@1', 'cn.attachDiscard@1']) {
    const f = await fixture((defs) => defs[0].mechanics.abilities = [ability([
      binding(op, { type: 'Water', count: 1, benchOnly: false, optional: false }),
    ])]);
    let ids;
    let g = board(f, (s) => {
      ids = setHand(s, 0, op === 'cn.attachHand@1' ? ['water', 'water'] : ['water']);
      for (const id of [...s.players[0].discard]) if (s.cards[id].definitionId === 'water') {
        s.players[0].discard.splice(s.players[0].discard.indexOf(id), 1); s.players[0].deck.push(id);
      }
    });
    use(g); pay(g, [ids[0]]);
    assert.equal(g.snapshot().pending.kind, op === 'cn.attachHand@1' ? 'hand-energy' : 'discard-energy');
    g = restore(g, f); answer(g, [op === 'cn.attachHand@1' ? ids[1] : ids[0]]); settle(g);
    assert.equal(g.snapshot().players[0].active.energy.length, 1);
    assert.equal(g.snapshot().players[0].flags.energy, false);
  }
  for (const side of ['own', 'opponent']) for (const zone of ['hand', 'deck', 'prizes']) {
    const f = await fixture((defs) => defs[0].mechanics.abilities = [ability([binding('cn.shuffle@1', { side, zone })])]);
    let ids;
    const g = board(f, (s) => { ids = setHand(s, 0, ['water', 'water']); });
    use(g); pay(g, [ids[0]]); settle(g);
    assert(g.snapshot().events.some((e) => e.ruleId === 'effects.shuffle'));
  }
});

test('activation cost admission rejects misplaced, duplicated and unreviewed proofs instead of ignoring the cost field', async () => {
  for (const mode of ['continuous', 'nested', 'misplaced', 'unsupported-proof', 'duplicate', 'generic-evidence']) {
    await assert.rejects(async () => {
      const f = await fixture((defs) => {
        if (mode === 'continuous') defs[0].mechanics.abilities = [ability([binding('cn.modifier@1', { field: 'hp', amount: 50, scope: 'self' })],
          [cost()], { mode: 'continuous', usage: null })];
        else if (mode === 'nested') defs[0].mechanics.abilities = [ability([{ ...binding('cn.draw@1', { count: 1 }), activationCosts: [cost()] }])];
        else if (mode === 'misplaced') defs[0].mechanics.attacks[0].effects = [{ ...binding('cn.draw@1', { count: 1 }), activationCosts: [cost()] }];
        else if (mode === 'unsupported-proof') defs[0].mechanics.abilities = [ability([binding('cn.condition@1', { side: 'opponent', condition: 'poisoned' })])];
        else if (mode === 'generic-evidence') defs[0].mechanics.abilities = [ability([binding('cn.draw@1', { count: 1 })], [{
          ...cost(), sourceOfTruth: [{ ...EVIDENCE[0], kind: 'official-rule' }],
        }])];
        else defs[0].mechanics.abilities = [ability([binding('cn.draw@1', { count: 1 })], [cost(), cost()])];
      });
      start(f);
    }, /Continuous Abilities|whole Ability|Binding costs|reviewed post-cost|unique IDs|card-specific evidence/);
  }
});

test('effect discard can execute the closest available count; an activation condition cannot use that partial-payment exception', async () => {
  for (const isCost of [false, true]) {
    const f = await fixture((defs) => {
      const a = ability(isCost ? [binding('cn.draw@1', { count: 1 })] : [
        binding('cn.cards@1', { from: 'hand', to: 'discard', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 2 },
          reveal: true, lookTop: null, shuffleAfter: false }),
      ], [cost(2)]);
      if (!isCost) delete a.costs;
      defs[0].mechanics.abilities = [a];
    });
    let id;
    const g = board(f, (s) => { id = setHand(s, 0, ['water'])[0]; });
    if (isCost) assert(!g.view(0).legalActions.some((a) => a.abilityId === 'paid'));
    else {
      use(g); assert.equal(g.snapshot().pending.minimum, 1); answer(g, [id]); settle(g);
      assert(g.snapshot().players[0].discard.includes(id));
      assert(!g.snapshot().events.some((e) => e.ruleId === 'effects.activation-cost'));
    }
  }
});

test('Prize-origin Special Energy attaches without the from-hand cost, even with an empty hand', async () => {
  const f = await fixture((defs) => {
    const d = defs.find((d) => d.definitionId === 'double');
    d.mechanics.attachCosts = [cost()];
    d.mechanics.effects = [{ ...binding('cn.attachIncoming@1', { target: 'any' }), trigger: {
      event: 'beforeHand', origin: 'prizes', turn: 'own', drawReason: 'any', optional: true, afterUse: 'hand',
    } }];
  });
  let energy;
  const g = board(f, (s) => {
    energy = hand(s, 0, 'double'); s.players[0].hand.pop();
    s.players[0].hand.push(s.players[0].prizes[0]); s.players[0].prizes[0] = energy;
    setHand(s, 0, []); attached(s, 0, s.players[0].active, 'water');
    s.players[1].active.counters = 8; bench(s, 1, 'other');
  });
  command(g, { type: 'attack', attackId: 'base:strike' }); answer(g, ['0']); answer(g, ['perform']);
  assert.equal(g.snapshot().pending.kind, 'incoming-energy-recipient');
  answer(g, [g.snapshot().players[0].active.id]); settle(g);
  assert(g.snapshot().players[0].active.energy.includes(energy));
  assert(!g.snapshot().events.some((e) => e.ruleId === 'effects.activation-cost'));
  assert.equal(g.snapshot().players[0].flags.energy, false);
});

test('a grouped Stadium activation rejects contradictory or invalid usage declarations before any game or fee', async () => {
  const core = createCoreHandlers().get('cn.draw@1');
  for (const wrong of [
    { period: 'year', scope: 'player', key: 'shared', limit: 1 },
    { period: 'turn', scope: 'player', key: 'shared', limit: null },
    { period: 'unlimited', scope: 'player', key: 'shared', limit: 1 },
    { period: 'turn', scope: 'player', key: 'shared', limit: 2 },
  ]) {
    const handlers = new Map([
      ['fixture:a', { ...core, timing: 'onUse', usage: { period: 'turn', scope: 'player', key: 'shared', limit: 1 } }],
      ['fixture:b', { ...core, timing: 'onUse', usage: wrong }],
    ]);
    const f = await fixture((defs) => defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [
      binding('fixture:a', { count: 1 }, 'a'), binding('fixture:b', { count: 1 }, 'b'),
    ], handlers);
    assert.throws(() => start(f), /valid usage|consistent limit/);
  }
});

test('reviewed cost checks still reject nonboolean/async results, before making any payment', async () => {
  const core = createCoreHandlers().get('cn.draw@1');
  for (const result of [undefined, {}, Promise.resolve(false)]) {
    const h = { ...core, canUseWithCosts: () => result };
    const f = await fixture((defs) => defs[0].mechanics.abilities = [ability([binding('fixture:bad-proof', { count: 1 })])],
      new Map([['fixture:bad-proof', h]]));
    assert.throws(() => board(f).view(0), /synchronous boolean/);
  }
  const h = { ...core, canUseWithCosts: () => true, canUse: (ctx) => ctx.payment ? {} : true };
  const f = await fixture((defs) => defs[0].mechanics.abilities = [ability([binding('fixture:bad-post-proof', { count: 1 })])],
    new Map([['fixture:bad-post-proof', h]]));
  let id;
  const g = board(f, (s) => { id = setHand(s, 0, ['water'])[0]; });
  use(g); const before = g.snapshot();
  assert.throws(() => pay(g, [id]), /synchronous boolean/);
  assert.deepEqual(g.snapshot(), before);
});
