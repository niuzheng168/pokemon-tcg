// I.A-02 p8 / I.B-01 p11 / I.B-03 p12, with C06 p29, C17 and E29 p68–69.
// Real OfficialGame and physical 60-card synthetic decks only; no real-card approvals.
// "ordinary" is an explicitly synthetic general protection policy, not a claim
// about any real hand-immunity card. CN.E29 separately permits using the Trainer
// without making its blocked body perform, heal, discard Energy or unlock then.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { paymentOptionId } from '../../public/rules/activation-cost.js';
import {
  fixture, binding, EVIDENCE, board, fixtureClock, hand, bench, attached, command, answer, settle,
} from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const STYLES = ['legacy', 'batch', 'all'];
const SLOTS = ['item', 'supporter', 'ability'];
const ABILITY = 'no-change-heal';
const mons = (s, owner) => [s.players[owner].active, ...s.players[owner].bench].filter(Boolean);
const cost = () => ({
  costId: 'heal-fee', kind: 'discardHand', count: 1,
  selector: { kind: 'energy', category: 'basic' }, sourceOfTruth: EVIDENCE,
});
function parameters(style, side = 'own', target = 'any') {
  if (style === 'legacy') return { target, amount: 30, ...(side === 'default' ? {} : { side }) };
  return {
    op: 'healPokemon', side, target, selector: { kind: 'pokemon' },
    selection: style === 'all' ? { kind: 'all' } : { kind: 'exact', count: 2 },
    amount: style === 'all' ? 'all' : 30, discardHealedEnergy: true,
  };
}
function normalized(style, p) {
  return style === 'legacy' ? { op: 'heal', side: p.side ?? 'own', target: p.target, count: p.amount / 10 } : p;
}
async function make({
  style = 'legacy', slot = 'item', side = 'own', target = 'any', paid = false,
  protection = 'injured', categories = ['trainer', 'ability', 'attack'],
  useRule = 'ordinary', channel = 'effects', from = 'all', trainerOrigins = null, trainerCategories = null,
  draw = false, dependentDraw = false,
} = {}) {
  const p = parameters(style, side, target), handlerId = style === 'legacy' ? 'cn.heal@1' : 'cn.healPokemon@1';
  const wrapper = {
    rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE,
    operations: ['then', 'draw', ...(style === 'legacy' ? ['heal'] : ['healPokemon', 'discardEnergy'])],
    validateParameters: (v) => JSON.stringify(v) === JSON.stringify(p),
    execute: (_ctx, v) => [{ op: 'then', first: normalized(style, v), next: { op: 'draw', count: 2 } }],
  };
  const f = await fixture((defs) => {
    const effects = [binding(dependentDraw ? 'fixture:no-change-heal-then' : handlerId, p, `no-change:${slot}:heal`)];
    if (draw) effects.push(binding('cn.draw@1', { count: 1 }, `no-change:${slot}:independent-draw`));
    if (slot === 'ability') defs[0].mechanics.abilities.push({
      abilityId: ABILITY, name: '测试无变化回复', mode: 'activated',
      usage: { period: 'turn', scope: 'pokemon', key: ABILITY, limit: 1 },
      effects, sourceOfTruth: EVIDENCE, ...(paid ? { costs: [cost()] } : {}),
    });
    else if (slot === 'attack') defs[0].mechanics.attacks[0].effects = effects;
    else {
      const d = defs.find((d) => d.definitionId === (slot === 'item' ? 'potion' : 'research'));
      d.mechanics.effects = effects;
      if (paid) d.mechanics.playCosts = [cost()];
    }
    const shielded = protection === 'injured' ? ['base', 'other'] : protection === 'mixed' ? ['other'] : [];
    for (const id of shielded) defs.find((d) => d.definitionId === id).mechanics.effects.push(
      binding('cn.protection@1', { effect: {
        op: 'protection', useRule, channel, scope: 'self', from, categories,
        ...(trainerOrigins ? { trainerOrigins } : {}),
        ...(trainerCategories ? { trainerCategories } : {}),
      } }, `no-change:${id}:shield`));
  }, dependentDraw ? new Map([['fixture:no-change-heal-then', wrapper]]) : new Map());
  return { ...f, config: { style, slot, side, target, paid }, params: p };
}
function setup(f, { owner = 0, counters = [4, 3, 2, 0], noBench = false, payable = true } = {}) {
  const { slot, side, paid } = f.config;
  let sourceId, feeId, targetIds, recipient;
  const g = board(f, (s) => {
    if (owner === 1) fixtureClock(s, [0, 1, 0, 1]);
    recipient = side === 'opponent' ? 1 - owner : owner;
    sourceId = ['ability', 'attack'].includes(slot) ? s.players[owner].active.stack.at(-1) :
      hand(s, owner, slot === 'item' ? 'potion' : 'research');
    const targets = [s.players[recipient].active, ...(noBench ? [] : [
      bench(s, recipient, 'other'), bench(s, recipient, 'other'), bench(s, recipient, 'evolution'),
    ])];
    targets.forEach((m, i) => { m.counters = counters[i]; attached(s, recipient, m, 'water'); });
    targetIds = targets.map((m) => m.id);
    if (paid && payable) feeId = hand(s, owner, 'water');
    if (paid && !payable) {
      const p = s.players[owner];
      for (const id of p.hand.filter((id) => ['water', 'fire'].includes(s.cards[id].definitionId))) {
        p.hand.splice(p.hand.indexOf(id), 1); p.discard.push(id);
      }
    }
    if (slot === 'attack' && !s.players[owner].active.energy.length)
      attached(s, owner, s.players[owner].active, 'water');
  });
  const before = g.snapshot(); conservation(before, before.cards);
  return { g, f, owner, recipient, sourceId, feeId, targetIds, before };
}
function declaration(c) {
  if (c.f.config.slot === 'ability') return {
    type: 'useAbility', pokemonId: c.g.snapshot().players[c.owner].active.id, abilityId: ABILITY,
  };
  if (c.f.config.slot === 'attack') return { type: 'attack', attackId: 'base:strike' };
  return { type: 'playTrainer', cardId: c.sourceId };
}
const declare = (c) => command(c.g, declaration(c), c.owner);
const available = (c) => c.g.view(c.owner).legalActions.some((a) =>
  JSON.stringify(a) === JSON.stringify(declaration(c)));
function conservation(s, cards) {
  assert.deepEqual(s.cards, cards);
  const all = [];
  for (const owner of [0, 1]) {
    const p = s.players[owner], ids = ['deck', 'hand', 'discard', 'prizes', 'lost', 'resolving'].flatMap((z) => p[z]);
    ids.push(...mons(s, owner).flatMap((m) => [...m.stack, ...m.energy, ...m.tools]));
    if (s.stadium && s.cards[s.stadium].owner === owner) ids.push(s.stadium);
    assert.equal(ids.length, 60); assert.equal(new Set(ids).size, 60);
    assert.deepEqual(new Set(ids), new Set(Object.keys(cards).filter((id) => cards[id].owner === owner)));
    all.push(...ids);
  }
  assert.equal(new Set(all).size, 120);
}
function restored(g, f) {
  const before = g.snapshot(), r = OfficialGame.restore(clone(before), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), before); assert.deepEqual([r.view(0), r.view(1)], [g.view(0), g.view(1)]);
  conservation(r.snapshot(), before.cards); return r;
}
function atomic(g, run, label) {
  const before = g.snapshot(), views = [g.view(0), g.view(1)];
  assert.throws(run, undefined, label);
  assert.deepEqual(g.snapshot(), before, `${label}: no fees, quota, flags, cards, counters, events, RNG or revision may commit.`);
  assert.deepEqual([g.view(0), g.view(1)], views); conservation(g.snapshot(), before.cards);
}
const healHistory = (s, from = 0) => s.battleHistory.events.slice(from).filter((e) => e.kind === 'heal');
const healResults = (s, from = 0) => s.events.slice(from).filter((e) =>
  e.ruleId === 'effects.heal-results' && e.data.kind === 'resolved');
function assertNoHeal(before, after) {
  for (const owner of [0, 1]) for (const old of mons(before, owner)) {
    const m = mons(after, owner).find((candidate) => candidate.id === old.id); assert(m);
    assert.equal(m.counters, old.counters); assert.deepEqual(m.energy, old.energy);
    assert.deepEqual(m.facts, old.facts);
  }
  assert.deepEqual(healHistory(after, before.battleHistory.events.length), []);
  assert(!after.events.slice(before.events.length).some((e) => e.ruleId === 'effects.heal'));
  assert.deepEqual(after.rng, before.rng); conservation(after, before.cards);
}
function assertFinished(c, s) {
  assert.equal(s.pending, null); assert.equal(s.phase, 'main');
  if (c.f.config.slot === 'ability') assert.equal(s.players[c.owner].active.used[ABILITY].length, 1);
  else {
    assert.equal(s.players[c.owner].discard.filter((id) => id === c.sourceId).length, 1);
    assert(!s.players[c.owner].resolving.includes(c.sourceId));
    assert.equal(s.players[c.owner].flags.supporter, c.f.config.slot === 'supporter');
  }
}
function select(c, g, ids) {
  if (!g.snapshot().pending) {
    assert.equal(c.f.config.style, 'all', 'Nonforced single/batch fixture must retain its real target prompt.');
    return;
  }
  assert.equal(g.snapshot().pending.kind, c.f.config.style === 'legacy' ? 'effect-target' : 'healing-targets');
  answer(g, ids); settle(g);
}
function assertOnlyActiveHealed(c, after) {
  const all = c.f.config.style === 'all', removed = all ? 4 : 3;
  for (const owner of [0, 1]) for (const old of mons(c.before, owner)) {
    const m = mons(after, owner).find((candidate) => candidate.id === old.id); assert(m);
    const healed = owner === c.recipient && old.id === c.targetIds[0];
    assert.equal(m.counters, old.counters - (healed ? removed : 0));
    assert.deepEqual(m.energy, healed && c.f.config.style !== 'legacy' ? [] : old.energy);
    assert.equal(m.facts.healedTurn, healed ? c.before.turn : old.facts.healedTurn);
  }
  assert.deepEqual(healHistory(after, c.before.battleHistory.events.length), [{
    kind: 'heal', owner: c.recipient, pokemonId: c.targetIds[0],
    turn: c.before.turn, during: c.before.current, amount: removed * 10,
  }]);
  assert.deepEqual(after.rng, c.before.rng); conservation(after, c.before.cards);
}

for (const style of STYLES) test(`${style}: ordinary synthetic protection of every injured eligible subject makes a single native Item/Supporter/activated Ability unavailable, even with a healthy unprotected subject`, async () => {
  for (const slot of SLOTS) for (const side of ['own', 'opponent']) for (const paid of [false, true]) {
    const f = await make({ style, slot, side, paid });
    for (const owner of [0, 1]) {
      const c = setup(f, { owner }), before = c.g.snapshot(), label = `${style}/${slot}/${side}/paid=${paid}/owner=${owner}`;
      assert.equal(mons(before, c.recipient).at(-1).counters, 0);
      assert.equal(available(c), false, `${label}: a healthy unprotected Pokémon cannot make a blocked heal useful.`);
      assert.deepEqual(c.g.snapshot(), before, 'The legalActions proof must be read-only, not emit protection events.');
      atomic(c.g, () => declare(c), label);
      assert.equal(before.players[owner].flags.supporter, false);
      assert.equal(before.players[owner].active.used[ABILITY], undefined);
      c.g = restored(c.g, f); assert.equal(available(c), false); atomic(c.g, () => declare(c), `${label}/restored`);
    }
  }
});

test('legacy default own is preserved; target restrictions cannot borrow an unprotected injured Pokémon outside the native healing window', async () => {
  const own = await make({ side: 'default' }), implicit = setup(own, { owner: 1 });
  assert.equal(available(implicit), false); atomic(implicit.g, () => declare(implicit), 'Legacy implicit own');
  for (const style of STYLES) for (const slot of ['item', 'ability']) {
    const f = await make({ style, slot, target: 'bench', protection: 'mixed' }), c = setup(f);
    assert.equal(c.before.players[0].active.counters, 4, 'This injured unprotected Active is not an eligible Bench target.');
    assert.equal(available(c), false, `${style}/${slot}: only the protected injured Bench and healthy unprotected Bench are eligible.`);
    atomic(c.g, () => declare(c), `${style}/${slot}/bench`);
  }
});

test('one actual unprotected heal gives legacy native declarations eligibility while protected injured Pokémon remain legal choices', async () => {
  for (const slot of SLOTS) for (const side of ['own', 'opponent']) {
    const f = await make({ slot, side, protection: 'mixed' });
    for (const owner of [0, 1]) for (const chooseProtected of [false, true]) {
      const c = setup(f, { owner });
      assert(available(c)); assert.deepEqual(c.g.snapshot(), c.before);
      declare(c);
      const q = c.g.snapshot().pending; assert.equal(q.kind, 'effect-target');
      assert.deepEqual(q.options, c.targetIds.slice(0, 3), 'Healthy Pokémon are not fixed single-target heal options; protection does not remove injured ones.');
      const r = restored(c.g, f), selected = [c.targetIds[chooseProtected ? 1 : 0]];
      for (const g of [c.g, r]) select(c, g, selected);
      assert.deepEqual(r.snapshot(), c.g.snapshot());
      if (chooseProtected) assertNoHeal(c.before, r.snapshot()); else assertOnlyActiveHealed(c, r.snapshot());
      assertFinished(c, r.snapshot()); restored(r, f);
    }
  }
});

test('batch native healing can legally select only protected injured subjects after an initially usable declaration; mixed healthy selection heals only the actual unprotected subject', async () => {
  for (const slot of SLOTS) for (const side of ['own', 'opponent']) {
    const f = await make({ style: 'batch', slot, side, protection: 'mixed' });
    for (const chooseProtected of [false, true]) {
      const c = setup(f, { owner: 1 });
      assert(available(c)); declare(c);
      assert.equal(c.g.snapshot().pending.kind, 'healing-targets');
      assert.deepEqual(c.g.snapshot().pending.options, c.targetIds);
      const r = restored(c.g, f), selected = chooseProtected ? c.targetIds.slice(1, 3) : [c.targetIds[0], c.targetIds[3]];
      select(c, r, selected);
      if (chooseProtected) {
        assertNoHeal(c.before, r.snapshot());
        const result = healResults(r.snapshot(), c.before.events.length); assert.equal(result.length, 1);
        assert.deepEqual(result[0].data.healed, []); assert.deepEqual(result[0].data.discarded, []);
        assert.equal(result[0].data.performed, false);
      } else assertOnlyActiveHealed(c, r.snapshot());
      assertFinished(c, r.snapshot()); restored(r, f);
    }
  }
});

test('all-target native healing has eligibility from actual unprotected damage, preserves the blocked/healthy subjects and discards only actually healed Energy', async () => {
  for (const slot of SLOTS) for (const side of ['own', 'opponent']) {
    const f = await make({ style: 'all', slot, side, protection: 'mixed' }), c = setup(f);
    assert(available(c)); declare(c);
    assert.equal(c.g.snapshot().pending, null);
    assertOnlyActiveHealed(c, c.g.snapshot()); assertFinished(c, c.g.snapshot());
    const result = healResults(c.g.snapshot(), c.before.events.length); assert.equal(result.length, 1);
    assert.deepEqual(result[0].data.healed, [c.targetIds[0]]);
    assert.deepEqual(result[0].data.discarded, c.before.players[c.recipient].active.energy);
    restored(c.g, f);
  }
});

test('a separate native draw binding makes the whole use legal, without treating a protected native heal or Trainer disposal as performed healing', async () => {
  for (const style of STYLES) for (const slot of SLOTS) {
    const f = await make({ style, slot, draw: true }), c = setup(f), next = c.before.players[0].deck.at(-1);
    assert(available(c), 'A separate binding that can really draw authorizes the whole use.');
    declare(c); const r = restored(c.g, f);
    select(c, r, style === 'legacy' ? [c.targetIds[0]] : c.targetIds.slice(0, 2));
    settle(r);
    assertNoHeal(c.before, r.snapshot()); assertFinished(c, r.snapshot());
    assert.equal(r.snapshot().players[0].deck.length, c.before.players[0].deck.length - 1);
    assert.deepEqual(r.snapshot().players[0].hand, [
      ...c.before.players[0].hand.filter((id) => slot === 'ability' || id !== c.sourceId), next,
    ]);
    const partial = r.snapshot().events.slice(c.before.events.length).filter((e) =>
      e.ruleId === 'effects.partial' && e.data.operation === (style === 'legacy' ? 'heal' : 'healPokemon'));
    assert.equal(partial.length, 1); assert.equal(partial[0].data.performed, false);
    restored(r, f);
  }
});

test('CN.E29 use permission does not unlock a protected heal’s then draw; only the independent draw runs (ordinary Ability control)', async () => {
  for (const style of STYLES) for (const slot of SLOTS) {
    const f = await make({ style, slot, draw: true, dependentDraw: true,
      ...(slot === 'ability' ? {} : { useRule: 'CN.E29', channel: 'effects', categories: ['trainer'],
        trainerOrigins: ['hand'], trainerCategories: [slot] }),
    }), c = setup(f);
    const next = c.before.players[0].deck.at(-1);
    assert(available(c)); declare(c); const r = restored(c.g, f);
    select(c, r, style === 'legacy' ? [c.targetIds[0]] : c.targetIds.slice(0, 2)); settle(r);
    assertNoHeal(c.before, r.snapshot()); assertFinished(c, r.snapshot());
    assert.equal(r.snapshot().players[0].deck.length, c.before.players[0].deck.length - 1,
      'Exactly the independent one-card draw runs, not the heal-dependent two-card draw.');
    assert.deepEqual(r.snapshot().players[0].hand, [
      ...c.before.players[0].hand.filter((id) => slot === 'ability' || id !== c.sourceId), next,
    ]);
    restored(r, f);
  }
});

test('CN.E29 permits a fully blocked native hand-played Item/Supporter, with complete real payment/finalization but no healing, Energy discard or draw', async () => {
  for (const style of STYLES) for (const slot of ['item', 'supporter']) {
    const f = await make({ style, slot, paid: true,
      useRule: 'CN.E29', channel: 'effects', categories: ['trainer'],
      trainerOrigins: ['hand'], trainerCategories: [slot] });
    const c = setup(f, { owner: 1 }), before = c.before;
    assert.equal(available(c), true, `${style}/${slot}: E29 permits use despite this Trainer's entirely blocked body.`);
    assert.deepEqual(c.g.snapshot(), before, 'Checking the permission cannot pay costs or emit protection events.');
    declare(c);
    const unpaid = c.g.snapshot();
    assert.equal(unpaid.pending.kind, 'activation-cost');
    assert(unpaid.players[1].hand.includes(c.sourceId)); assert(unpaid.players[1].hand.includes(c.feeId));
    assert.equal(unpaid.players[1].flags.supporter, false);
    let r = restored(restored(c.g, f), f);
    answer(r, [paymentOptionId('heal-fee', c.feeId)]);
    r = restored(r, f);
    if (style !== 'all') {
      assert.equal(r.snapshot().pending.data.source.origin, 'hand');
      assert(r.snapshot().players[1].resolving.includes(c.sourceId));
      select(c, r, style === 'legacy' ? [c.targetIds[0]] : c.targetIds.slice(0, 2));
    }
    settle(r);
    const after = r.snapshot();
    assertNoHeal(before, after); assertFinished(c, after);
    assert.equal(after.players[1].discard.filter((id) => id === c.feeId).length, 1);
    assert.deepEqual(after.players[1].hand, before.players[1].hand.filter((id) => ![c.sourceId, c.feeId].includes(id)));
    for (const owner of [0, 1]) assert.deepEqual(after.players[owner].deck, before.players[owner].deck,
      'E29 use permission cannot invent a draw or another successful body result.');
    const added = after.events.slice(before.events.length), operation = style === 'legacy' ? 'heal' : 'healPokemon';
    const partial = added.filter((e) => e.ruleId === 'effects.partial' && e.data.operation === operation);
    assert.equal(partial.length, 1); assert.equal(partial[0].data.performed, false);
    assert(!added.some((e) => e.ruleId === 'effects.partial' && e.data.operation === 'draw'));
    assert.equal(added.filter((e) => e.ruleId === 'effects.activation-cost').length, 1);
    if (style !== 'legacy') {
      const result = healResults(after, before.events.length); assert.equal(result.length, 1);
      assert.equal(result[0].data.performed, false); assert.deepEqual(result[0].data.healed, []);
      assert.deepEqual(result[0].data.discarded, []);
    }
    if (slot === 'supporter') atomic(r, () => declare({ ...c, g: r }), 'The completed Supporter cannot be declared a second time.');
    restored(r, f);
  }
});

test('CN.E29 does not authorize healthy-only, no-target or unpaid healing-only Trainer uses', async () => {
  for (const style of STYLES) for (const slot of ['item', 'supporter'])
    for (const boundary of ['healthy', 'no-target', 'unpayable']) {
      const f = await make({ style, slot, paid: true, target: boundary === 'no-target' ? 'bench' : 'any',
        useRule: 'CN.E29', channel: 'effects', categories: ['trainer'],
        trainerOrigins: ['hand'], trainerCategories: [slot] });
      const c = setup(f, {
        counters: boundary === 'healthy' ? [0, 0, 0, 0] : [4, 3, 2, 0],
        noBench: boundary === 'no-target', payable: boundary !== 'unpayable',
      });
      assert.equal(available(c), false, `${style}/${slot}/${boundary}: the E29 exception is permission despite protection, not permission to invent targets, damage or payment.`);
      atomic(c.g, () => declare(c), `${style}/${slot}/${boundary}`);
      c.g = restored(c.g, f); assert.equal(available(c), false);
      atomic(c.g, () => declare(c), `${style}/${slot}/${boundary}/restored`);
    }
});

test('real payment and repeated JSON restores retain static protection and hand origin after the source leaves hand; selecting only protected targets cannot heal or discard', async () => {
  for (const style of STYLES) for (const slot of SLOTS) {
    const f = await make({ style, slot, paid: true, protection: 'mixed',
      useRule: slot === 'ability' ? 'ordinary' : 'CN.E29',
      categories: slot === 'ability' ? ['ability'] : ['trainer'],
      trainerOrigins: slot === 'ability' ? null : ['hand'],
      trainerCategories: slot === 'ability' ? null : [slot] });
    const c = setup(f, { owner: 1 });
    assert(available(c)); declare(c);
    const unpaid = c.g.snapshot();
    assert.equal(unpaid.pending.kind, 'activation-cost'); assert(unpaid.players[1].hand.includes(c.feeId));
    assert.equal(unpaid.players[1].active.used[ABILITY], undefined); assert.equal(unpaid.players[1].flags.supporter, false);
    if (slot !== 'ability') assert(unpaid.players[1].hand.includes(c.sourceId));
    const a = restored(c.g, f), b = restored(restored(c.g, f), f);
    for (let g of [a, b]) {
      answer(g, [paymentOptionId('heal-fee', c.feeId)]);
      assert.equal(g.snapshot().players[1].discard.filter((id) => id === c.feeId).length, 1);
      if (style !== 'all') {
        assert.equal(g.snapshot().pending.kind, style === 'legacy' ? 'effect-target' : 'healing-targets');
        if (slot !== 'ability') {
          assert(g.snapshot().players[1].resolving.includes(c.sourceId));
          assert(!g.snapshot().players[1].hand.includes(c.sourceId));
          assert.equal(g.snapshot().pending.data.source.origin, 'hand', 'Escrow must not turn the Trainer into a field source.');
        }
        g = restored(restored(g, f), f);
        select(c, g, style === 'legacy' ? [c.targetIds[1]] : c.targetIds.slice(1, 3));
        assertNoHeal(c.before, g.snapshot());
      } else assertOnlyActiveHealed(c, g.snapshot());
      assertFinished(c, g.snapshot());
      assert.equal(g.snapshot().events.slice(c.before.events.length).filter((e) => e.ruleId === 'effects.activation-cost').length, 1);
      conservation(g.snapshot(), c.before.cards); restored(g, f);
    }
  }
});

test('protection eligibility uses the current effect channel, actual source category and own/opponent relation, not the existence of any shield', async () => {
  for (const style of STYLES) for (const control of ['damage-only', 'foreign-category', 'foreign-origin', 'foreign-side']) {
    const slot = control === 'foreign-category' ? 'ability' : 'item', side = control === 'foreign-side' ? 'opponent' : 'own';
    const f = await make({ style, slot, side,
      channel: control === 'damage-only' ? 'damage' : 'effects',
      categories: control === 'foreign-category' ? ['trainer'] : ['trainer', 'ability'],
      trainerOrigins: control === 'foreign-origin' ? ['field'] : null,
      from: control === 'foreign-side' ? 'own' : 'all' });
    const c = setup(f);
    assert(available(c), `${style}/${control}: this shield does not protect against this actual healing source.`);
    declare(c); const r = restored(c.g, f);
    select(c, r, style === 'legacy' ? [c.targetIds[0]] : c.targetIds.slice(0, 2)); settle(r);
    const actual = healHistory(r.snapshot(), c.before.battleHistory.events.length);
    assert(actual.some((e) => e.pokemonId === c.targetIds[0] && e.amount === (style === 'all' ? 40 : 30)));
    assert.equal(r.snapshot().players[c.recipient].active.counters, style === 'all' ? 0 : 1);
    conservation(r.snapshot(), c.before.cards); restored(r, f);
  }
});

test('an attack remains available when its native healing is entirely protected, keeps real damage/use facts and never invents heal history or Energy discard', async () => {
  for (const style of STYLES) for (const side of ['own', 'opponent']) {
    const f = await make({ style, slot: 'attack', side });
    for (const owner of [0, 1]) {
      const c = setup(f, { owner }), before = c.before;
      assert(available(c), 'Voluntary Trainer/Ability no-change qualification is not a ban on attacks with a blocked healing clause.');
      declare(c); c.g = restored(c.g, f); settle(c.g);
      const after = c.g.snapshot(), attacker = after.players[owner].active, defender = after.players[1 - owner].active;
      assert.equal(attacker.counters, before.players[owner].active.counters);
      assert.equal(defender.counters, before.players[1 - owner].active.counters + 2);
      assert.equal(attacker.facts.lastUsedAttack.attackId, 'base:strike');
      assert.deepEqual(healHistory(after, before.battleHistory.events.length), []);
      for (const holder of [0, 1]) for (const old of mons(before, holder)) {
        const m = mons(after, holder).find((candidate) => candidate.id === old.id); assert(m);
        assert.deepEqual(m.energy, old.energy); assert.equal(m.facts.healedTurn, old.facts.healedTurn);
      }
      const partial = after.events.slice(before.events.length).filter((e) =>
        e.ruleId === 'effects.partial' && e.data.operation === (style === 'legacy' ? 'heal' : 'healPokemon'));
      assert.equal(partial.length, 1); assert.equal(partial[0].data.performed, false);
      assert(after.events.slice(before.events.length).some((e) => e.ruleId === 'attack.order'));
      assert.equal(after.pending, null); assert.deepEqual(after.rng, before.rng);
      conservation(after, before.cards); restored(c.g, f);
    }
  }
});
