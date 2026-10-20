// Real OfficialGame execution; all definitions/printings are synthetic.
// Yamy-shaped coverage is not approval of any actual card or printing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import {
  fixture, fixtureClock, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached,
} from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const action = (extra = {}) => ({
  op: 'healPokemon', side: 'own', target: 'any', selector: { kind: 'pokemon' },
  selection: { kind: 'exact', count: 1 }, amount: 'all', discardHealedEnergy: false, ...extra,
});
const heal = (spec, id = 'heal') => binding('cn.healPokemon@1', spec, id);
const ability = (spec) => ({
  abilityId: 'healer', name: '测试回复', mode: 'activated',
  usage: { period: 'turn', scope: 'pokemon', key: 'healer', limit: 1 },
  sourceOfTruth: EVIDENCE, effects: [heal(spec)],
});
const shield = (scope = 'self', channel = 'effects') => ({
  op: 'protection', useRule: 'ordinary', scope, channel, from: 'all', categories: ['trainer'],
});
const mons = (s, owner) => [s.players[owner].active, ...s.players[owner].bench].filter(Boolean);
const mon = (s, owner, id) => {
  const found = mons(s, owner).find((m) => m.id === id); assert(found, `Missing actual subject ${id}`); return found;
};
async function make(spec = action(), extend = () => {}, handlers = new Map()) {
  const f = await fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) {
      d.mechanics.hp = 500; d.mechanics.weakness = null; d.mechanics.resistance = null;
    }
    const second = clone(defs.find((d) => d.definitionId === 'evolution'));
    Object.assign(second, { definitionId: 'stage2', nameKey: 'stage2', name: '测试二阶进化' });
    Object.assign(second.mechanics, { stage: 'stage2', evolvesFrom: 'evolution',
      basicAncestor: { nameKey: 'base', sourceOfTruth: EVIDENCE }, attacks: [], abilities: [], effects: [] });
    defs.push(second);
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [heal(spec)];
    defs.find((d) => d.definitionId === 'research').mechanics.effects = [heal(spec)];
    defs[0].mechanics.abilities = [ability(spec)];
    extend(defs);
  }, handlers);
  f.deck.splice(-2, 2, 'printing:stage2', 'printing:evolution');
  assert.equal(f.deck.length, 60); return f;
}
function hold(s, owner, subject, definitionId) {
  const id = hand(s, owner, definitionId), p = s.players[owner];
  p.hand.splice(p.hand.indexOf(id), 1); subject.tools.push(id); return id;
}
function play(g, sourceId, owner = g.snapshot().current) {
  command(g, { type: 'playTrainer', cardId: sourceId }, owner);
}
function use(g, owner = g.snapshot().current) {
  command(g, { type: 'useAbility', pokemonId: g.snapshot().players[owner].active.id, abilityId: 'healer' }, owner);
}
function conservation(s, originalCards) {
  assert.deepEqual(s.cards, originalCards, 'Healing cannot rewrite any physical identity/owner/definition/printing.');
  const total = [];
  for (const owner of [0, 1]) {
    const p = s.players[owner], ids = ['deck', 'hand', 'discard', 'prizes', 'lost', 'resolving'].flatMap((z) => p[z]);
    ids.push(...mons(s, owner).flatMap((m) => [...m.stack, ...m.energy, ...m.tools]));
    if (s.stadium && s.cards[s.stadium].owner === owner) ids.push(s.stadium);
    assert.equal(ids.length, 60); assert.equal(new Set(ids).size, 60);
    assert.deepEqual(new Set(ids), new Set(Object.keys(originalCards).filter((id) => originalCards[id].owner === owner)));
    total.push(...ids);
  }
  assert.equal(new Set(total).size, 120);
}
function restored(g, f) {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  for (const owner of [0, 1]) assert.deepEqual(r.view(owner), g.view(owner));
  conservation(r.snapshot(), g.snapshot().cards); return r;
}
function respond(g, f, selected) {
  const r = restored(g, f); answer(g, selected); answer(r, selected);
  assert.deepEqual(r.snapshot(), g.snapshot(), 'A restored answer cannot heal/discard twice or change the selected batch.');
}
function atomic(g, run) {
  const before = g.snapshot(), views = [g.view(0), g.view(1)];
  assert.throws(run); assert.deepEqual(g.snapshot(), before);
  assert.deepEqual([g.view(0), g.view(1)], views); conservation(g.snapshot(), before.cards);
}
const results = (s, from = 0) => s.events.slice(from).filter((e) =>
  e.ruleId === 'effects.heal-results' && e.data.kind === 'resolved');

// Independent oracle: only literal test-specified subject IDs and masks are
// used. Do not import the planner/selector/handler to derive expected results.
function oracle(before, owner, selected, amount, discard, blockedHeal = [], blockedEnergy = []) {
  const updates = [], healed = [], discarded = [];
  for (const id of selected) {
    const subject = mon(before, owner, id), old = BigInt(subject.counters);
    const requested = amount === 'all' ? old : BigInt(amount) / 10n;
    const removed = blockedHeal.includes(id) ? 0n : old < requested ? old : requested;
    updates.push({ pokemonId: id, beforeCounters: Number(old), afterCounters: Number(old - removed), removedCounters: Number(removed) });
    if (removed > 0n) {
      healed.push(id);
      if (discard && !blockedEnergy.includes(id)) discarded.push(...subject.energy);
    }
  }
  return { owner, updates, healed, discarded, performed: healed.length > 0 };
}
function outcome(g, before, expected) {
  const s = g.snapshot();
  for (const owner of [0, 1]) for (const old of mons(before, owner)) {
    const current = mon(s, owner, old.id), update = owner === expected.owner ?
      expected.updates.find((u) => u.pokemonId === old.id) : null;
    assert.equal(current.counters, update ? update.afterCounters : old.counters);
    assert.deepEqual(current.energy, old.energy.filter((id) => !expected.discarded.includes(id)));
    assert.deepEqual(current.stack, old.stack); assert.deepEqual(current.tools, old.tools);
    assert.equal(current.facts.healedTurn, owner === expected.owner && expected.healed.includes(old.id) ?
      before.turn : old.facts.healedTurn);
  }
  assert.deepEqual(s.battleHistory.events.slice(before.battleHistory.events.length).filter((e) => e.kind === 'heal'),
    expected.updates.filter((u) => u.removedCounters > 0).map((u) => ({
      kind: 'heal', turn: before.turn, during: before.current, owner: expected.owner,
      pokemonId: u.pokemonId, amount: u.removedCounters * 10,
    })));
  const records = results(s, before.events.length); assert.equal(records.length, 1);
  assert.deepEqual(records[0].data.updates, expected.updates);
  assert.deepEqual(records[0].data.healed, expected.healed);
  assert.deepEqual(records[0].data.discarded, expected.discarded);
  assert.equal(records[0].data.performed, expected.performed);
  for (const id of expected.discarded) assert.equal(s.players[before.cards[id].owner].discard.filter((x) => x === id).length, 1);
  assert.deepEqual(s.rng, before.rng, 'Healing and forced physical-card discard use no RNG.');
  conservation(s, before.cards);
}

test('native healing parameters are the exact explicit action and declare both healing and later physical discard', () => {
  const h = createCoreHandlers().get('cn.healPokemon@1'); assert(h);
  assert.equal(h.timing, 'resolve'); assert.deepEqual(h.operations, ['healPokemon', 'discardEnergy']);
  assert.equal(h.parameterSchemaRef, 'urn:pokemon-tcg:core-handler-parameters:1.0.0#/$defs/pokemonHealing');
  assert(h.sourceOfTruth.some((s) => s.pdfPages.includes(29)));
  assert(h.sourceOfTruth.some((s) => s.pdfPages.includes(63)));
  assert.equal(h.costCheckVersion, '1'); assert.equal(typeof h.canUseWithCosts, 'function');
  const spec = action(); assert.equal(h.validateParameters(spec), true); assert.deepEqual(h.execute({}, spec), [spec]);
  for (const bad of [{ action: spec }, { ...spec, op: 'heal' }, { ...spec, amount: 0 },
    { ...spec, discardHealedEnergy: 'true' }, { ...spec, healed: ['forged'] }])
    assert.equal(h.validateParameters(bad), false);
});

test('single all-HP healing removes all counters under effective HP, preserves printed HP and does not spend Energy', async () => {
  const f = await make(action({ target: 'active' }), (defs) => { defs[0].mechanics.hp = 100; });
  let source;
  const g = board(f, (s) => {
    source = hand(s, 0, 'potion'); hold(s, 0, s.players[0].active, 'hp-tool');
    s.players[0].active.counters = 12; attached(s, 0, s.players[0].active, 'double');
  }), before = g.snapshot(), id = before.players[0].active.id, printed = clone(f.catalog.definition('base'));
  assert.equal(before.protocol, 'CN-game-dev-25');
  assert.equal(g.view(0).players[0].active.effective.maxHp, 150);
  assert.equal(g.view(0).players[0].active.effective.currentHp, 30);
  play(g, source); assert.equal(g.snapshot().pending, null);
  outcome(g, before, oracle(before, 0, [id], 'all', false));
  assert.equal(g.view(0).players[0].active.effective.currentHp, 150);
  assert.deepEqual(f.catalog.definition('base'), printed); assert.equal(printed.mechanics.hp, 100);
  assert(g.snapshot().players[0].discard.includes(source)); restored(g, f);
});

test('fixed HP heals are capped at actual removed counters, not requested HP or the effective maximum', async () => {
  const f = await make(action({ target: 'active', amount: 30 }));
  for (const [counters, after, actualHp] of [[1, 0, 10], [2, 0, 20], [8, 5, 30]]) {
    let source;
    const g = board(f, (s) => { source = hand(s, 0, 'potion'); s.players[0].active.counters = counters; });
    const before = g.snapshot(), id = before.players[0].active.id;
    play(g, source); outcome(g, before, oracle(before, 0, [id], 30, false));
    assert.equal(g.snapshot().players[0].active.counters, after);
    assert.equal(g.snapshot().battleHistory.events.at(-1).amount, actualHp);
    restored(g, f);
  }
});

test('Yamy-shaped all stage1/stage2 heals only those printed stages and discards only this action’s actually healed physical Energy cards', async () => {
  const spec = action({ selector: { kind: 'pokemon', stages: ['stage1', 'stage2'] },
    selection: { kind: 'all' }, discardHealedEnergy: true });
  const f = await make(spec, (defs) => {
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.heal@1', { target: 'any', amount: 10 })];
  });
  for (const energyCount of [0, 1, 2]) {
    let source, prep, hurt, second, healthy, basic;
    const g = board(f, (s) => {
      source = hand(s, 0, 'research'); prep = hand(s, 0, 'potion');
      basic = s.players[0].active; basic.counters = 3; attached(s, 0, basic, 'water');
      hurt = bench(s, 0, 'evolution'); hurt.counters = 2;
      if (energyCount >= 1) attached(s, 0, hurt, 'double');
      if (energyCount === 2) attached(s, 0, hurt, 'water');
      second = bench(s, 0, 'stage2'); second.counters = 4; // No Energy: FAQ3 still permits healing.
      healthy = bench(s, 0, 'evolution'); healthy.counters = 1; attached(s, 0, healthy, 'water');
    });
    const originalCards = g.snapshot().cards;
    play(g, prep); assert.equal(g.snapshot().pending.kind, 'effect-target'); answer(g, [healthy.id]); settle(g);
    const before = g.snapshot();
    assert.equal(mon(before, 0, healthy.id).counters, 0);
    assert.equal(mon(before, 0, healthy.id).facts.healedTurn, before.turn, 'An earlier real heal cannot join this action’s correlated set.');
    assert(before.battleHistory.events.some((e) => e.kind === 'heal' && e.pokemonId === healthy.id));
    const expected = oracle(before, 0, [hurt.id, second.id, healthy.id], 'all', true);
    assert.equal(expected.discarded.length, energyCount);
    if (energyCount >= 1) assert.equal(g.view(0).players[0].bench.find((m) => m.id === hurt.id).effective.energies[0].units.length, 2);
    play(g, source); assert.equal(g.snapshot().pending, null, 'All healing and the correlated discard have no external pause.');
    outcome(g, before, expected);
    assert.equal(mon(g.snapshot(), 0, basic.id).counters, 3);
    assert.equal(mon(g.snapshot(), 0, healthy.id).energy.length, 1);
    assert.deepEqual(g.snapshot().cards, originalCards); assert(g.snapshot().players[0].flags.supporter);
    restored(g, f);
  }
});

test('a damaged evolution with no Energy is usable, performed=true and can enable a following then', async () => {
  const spec = action({ selector: { kind: 'pokemon', stages: ['stage1', 'stage2'] },
    selection: { kind: 'all' }, discardHealedEnergy: true });
  const wrapper = { rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE,
    operations: ['then', 'healPokemon', 'discardEnergy', 'draw'], validateParameters: (p) => Object.keys(p).length === 0,
    execute: () => [{ op: 'then', first: spec, next: { op: 'draw', count: 1 } }],
  };
  const f = await make(spec, (defs) => {
    defs.find((d) => d.definitionId === 'research').mechanics.effects = [binding('fixture:heal-then-draw', {})];
  }, new Map([['fixture:heal-then-draw', wrapper]]));
  let source, id;
  const g = board(f, (s) => {
    source = hand(s, 0, 'research'); const evolved = bench(s, 0, 'evolution'); evolved.counters = 1; id = evolved.id;
  });
  const before = g.snapshot(), next = before.players[0].deck.at(-1);
  play(g, source); settle(g); outcome(g, before, oracle(before, 0, [id], 'all', true));
  assert(g.snapshot().players[0].hand.includes(next));
  assert.equal(g.snapshot().players[0].hand.length, before.players[0].hand.length);
  restored(g, f);
});

test('all-healthy healing-only Trainers and Abilities are unavailable and rejected without use, facts, cards or RNG changes', async () => {
  const f = await make(action({ selection: { kind: 'all' }, discardHealedEnergy: true }));
  let source;
  const g = board(f, (s) => { source = hand(s, 0, 'research'); bench(s, 0, 'evolution'); });
  const s = g.snapshot();
  assert(!g.view(0).legalActions.some((a) => a.cardId === source && a.type === 'playTrainer'));
  assert(!g.view(0).legalActions.some((a) => a.type === 'useAbility' && a.abilityId === 'healer'));
  atomic(g, () => play(g, source)); atomic(g, () => use(g));
  assert.equal(g.snapshot().players[0].flags.supporter, false);
  assert.equal(g.snapshot().players[0].active.used.healer, undefined);
  assert.deepEqual(g.snapshot().battleHistory, s.battleHistory);
});

test('a full-health attack’s healing no-op leaves its printed damage, used fact and remaining contents intact', async () => {
  const spec = action({ target: 'self', discardHealedEnergy: true });
  const f = await make(spec, (defs) => { defs[0].mechanics.attacks[0].effects = [
    heal(spec, 'attack-heal'), binding('cn.draw@1', { count: 1 }, 'independent-following-draw'),
  ]; });
  const g = board(f, (s) => attached(s, 0, s.players[0].active, 'water')), before = g.snapshot();
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  const s = g.snapshot();
  assert.equal(s.players[1].active.counters, 2); assert.equal(s.players[0].active.counters, 0);
  assert.equal(s.players[0].active.facts.lastUsedAttack.attackId, 'base:strike');
  assert.equal(s.players[0].active.facts.healedTurn, undefined);
  assert.equal(s.players[0].hand.length, before.players[0].hand.length + 1, 'The independent later binding is not a dependent then.');
  assert.deepEqual(s.players[0].active.energy, before.players[0].active.energy);
  assert.deepEqual(s.battleHistory.events.filter((e) => e.kind === 'heal'), []);
  assert(s.events.slice(before.events.length).some((e) =>
    e.ruleId === 'effects.partial' && e.data.operation === 'healPokemon' && e.data.performed === false));
  assert.equal(s.pending, null); assert.deepEqual(s.rng, before.rng);
  conservation(s, before.cards); restored(g, f);
});

test('single healing choices exclude healthy subjects, while multi choices include healthy subjects only with actual damage in the chosen set', async () => {
  for (const count of [1, 2]) {
    const spec = action({ selection: { kind: 'exact', count } }), f = await make(spec);
    let source, hurt, healthy;
    const g = board(f, (s) => {
      source = hand(s, 0, 'potion'); s.players[0].active.counters = 2;
      hurt = bench(s, 0, 'other'); hurt.counters = count === 1 ? 3 : 0;
      healthy = bench(s, 0, 'evolution');
    }), before = g.snapshot(), active = before.players[0].active.id;
    play(g, source); const q = g.snapshot().pending;
    assert.equal(q.kind, 'healing-targets'); assert.equal(q.player, 0);
    assert.deepEqual(q.options, count === 1 ? [active, hurt.id] : [active, hurt.id, healthy.id]);
    assert.deepEqual(mons(g.snapshot(), 0).map((m) => m.counters), mons(before, 0).map((m) => m.counters));
    atomic(g, () => answer(g, count === 1 ? [healthy.id] : [hurt.id, healthy.id]));
    const chosen = count === 1 ? [hurt.id] : [healthy.id, active];
    respond(g, f, chosen); outcome(g, before, oracle(before, 0, chosen, 'all', false));
    const after = g.snapshot();
    atomic(g, () => command(g, { type: 'answer', requestId: q.id, selected: chosen }));
    assert.deepEqual(restored(g, f).snapshot(), after);
  }
});

test('upTo uses public CN 1..N bounds, rejects zero, and does not heal an unselected damaged Pokémon', async () => {
  const f = await make(action({ selection: { kind: 'upTo', count: 2 }, amount: 20 }));
  let source, other;
  const g = board(f, (s) => {
    source = hand(s, 0, 'potion'); s.players[0].active.counters = 4;
    other = bench(s, 0, 'other'); other.counters = 3;
  }), before = g.snapshot();
  play(g, source); assert.equal(g.snapshot().pending.minimum, 1); assert.equal(g.snapshot().pending.maximum, 2);
  atomic(g, () => answer(g, [])); respond(g, f, [other.id]);
  outcome(g, before, oracle(before, 0, [other.id], 20, false)); restored(g, f);
});

test('relative own/opponent healing follows the actual source player for both owners, never an absolute default', async () => {
  for (const owner of [0, 1]) for (const side of ['own', 'opponent']) {
    const spec = action({ side, target: 'active', discardHealedEnergy: true }), f = await make(spec);
    let source;
    const g = board(f, (s) => {
      if (owner === 1) fixtureClock(s, [0, 1, 0, 1]);
      source = hand(s, owner, 'potion');
      for (const holder of [0, 1]) { s.players[holder].active.counters = holder + 2; attached(s, holder, s.players[holder].active, 'double'); }
    }), before = g.snapshot(), holder = side === 'own' ? owner : 1 - owner;
    play(g, source, owner);
    outcome(g, before, oracle(before, holder, [before.players[holder].active.id], 'all', true));
    assert.equal(results(g.snapshot(), before.events.length)[0].data.source.owner, owner); restored(g, f);
  }
});

test('a shared Stadium heals its actual activator’s side rather than its physical owner’s side', async () => {
  const spec = action({ target: 'active' }), native = createCoreHandlers().get('cn.healPokemon@1');
  const stadium = { ...native, timing: 'onUse', usage: { period: 'turn', scope: 'player', key: 'stadium-heal', limit: 1 } };
  const f = await make(spec, (defs) => {
    defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [binding('fixture:stadium-heal', spec)];
  }, new Map([['fixture:stadium-heal', stadium]]));
  let source;
  const g = board(f, (s) => {
    source = hand(s, 1, 'stadium'); s.players[1].hand.splice(s.players[1].hand.indexOf(source), 1); s.stadium = source;
    s.players[0].active.counters = 2; s.players[1].active.counters = 5;
  }), before = g.snapshot();
  assert.equal(before.cards[source].owner, 1); command(g, { type: 'useStadium' });
  outcome(g, before, oracle(before, 0, [before.players[0].active.id], 'all', false));
  assert.equal(g.snapshot().players[0].used['stadium-heal'].length, 1);
  assert.equal(g.snapshot().players[1].used['stadium-heal'], undefined); restored(g, f);
});

test('effect-protected subjects remain selectable but a blocked heal causes neither history nor correlated Energy discard', async () => {
  const spec = action({ discardHealedEnergy: true });
  const f = await make(spec, (defs) => { defs[1].mechanics.effects = [binding('cn.protection@1', { effect: shield() })]; });
  let source, protectedId;
  const g = board(f, (s) => {
    source = hand(s, 0, 'potion'); s.players[0].active.counters = 1;
    const other = bench(s, 0, 'other'); other.counters = 3; attached(s, 0, other, 'double'); protectedId = other.id;
  }), before = g.snapshot();
  assert(g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === source));
  play(g, source); assert(g.snapshot().pending.options.includes(protectedId));
  respond(g, f, [protectedId]);
  outcome(g, before, oracle(before, 0, [protectedId], 'all', true, [protectedId]));
  assert.equal(results(g.snapshot(), before.events.length)[0].data.performed, false); restored(g, f);
});

test('partial/all effect shields and damage-only shields distinguish declaration eligibility from actual healing', async () => {
  const spec = action({ selection: { kind: 'all' }, discardHealedEnergy: true });
  for (const [mode, channel] of [['partial', 'effects'], ['all', 'effects'], ['all', 'damage']]) {
    const f = await make(spec, (defs) => {
      const d = mode === 'partial' ? defs[1] : defs[0];
      d.mechanics.effects = [binding('cn.protection@1', { effect: shield(mode === 'partial' ? 'self' : 'own', channel) })];
    });
    let source, other;
    const g = board(f, (s) => {
      source = hand(s, 0, 'potion'); s.players[0].active.counters = 2; attached(s, 0, s.players[0].active, 'water');
      other = bench(s, 0, 'other'); other.counters = 3; attached(s, 0, other, 'double');
    }), before = g.snapshot(), ids = [before.players[0].active.id, other.id];
    const blocked = channel === 'damage' ? [] : mode === 'all' ? ids : [other.id];
    if (mode === 'all' && channel === 'effects') {
      // I.B-01 p11: a wholly protected healing-only Item is known to do
      // nothing; merely playing/discarding that Item is not its effect.
      assert(!g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === source));
      assert.throws(() => play(g, source), { code: 'illegal-action' });
      assert.deepEqual(g.snapshot(), before); restored(g, f);
      continue;
    }
    assert(g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === source));
    play(g, source); assert.equal(g.snapshot().pending, null);
    outcome(g, before, oracle(before, 0, ids, 'all', true, blocked)); restored(g, f);
  }
});

test('the whole heal batch freezes old protection/counters, then the discard stage rechecks protection after all heals', async () => {
  const spec = action({ selection: { kind: 'all' }, discardHealedEnergy: true });
  const conditional = {
    rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE, timing: 'continuous', operations: ['protection'],
    validateParameters: (p) => Object.keys(p).length === 0,
    execute: (ctx) => ctx.state.players[ctx.source.owner].active.counters === 0 ? [shield('own')] : [],
  };
  const f = await make(spec, (defs) => { defs[0].mechanics.effects = [binding('fixture:healthy-shield', {})]; },
    new Map([['fixture:healthy-shield', conditional]]));
  let source, other;
  const g = board(f, (s) => {
    source = hand(s, 0, 'potion'); s.players[0].active.counters = 2; attached(s, 0, s.players[0].active, 'water');
    other = bench(s, 0, 'other'); other.counters = 4; attached(s, 0, other, 'double');
  }), before = g.snapshot(), ids = [before.players[0].active.id, other.id];
  play(g, source); assert.equal(g.snapshot().pending, null);
  outcome(g, before, oracle(before, 0, ids, 'all', true, [], ids));
  assert.deepEqual(results(g.snapshot(), before.events.length)[0].data.healed, ids);
  assert.deepEqual(results(g.snapshot(), before.events.length)[0].data.discarded, []);
  restored(g, f);
});

test('restoring nonforced healing binds source/action/window/counters/turn and the unique public request before any mutation', async () => {
  const f = await make(action()); let source;
  const g = board(f, (s) => {
    source = hand(s, 0, 'potion'); s.players[0].active.counters = 1; bench(s, 0, 'other').counters = 2;
  }), before = g.snapshot();
  play(g, source); const saved = g.snapshot(), q = saved.pending, c = q.data.healingChoice;
  assert.equal(q.kind, 'healing-targets'); assert.equal(c.sourceId, source); assert.equal(c.turn, before.turn);
  const expectedTargets = mons(before, 0).map((m) => ({ pokemonId: m.id, topCardId: m.stack.at(-1), counters: m.counters }));
  assert.deepEqual(c.targets, expectedTargets);
  const requests = saved.events.filter((e) => e.ruleId === 'effects.heal-results' && e.data.kind === 'requested' && e.data.id === c.id);
  assert.equal(requests.length, 1); assert.equal(requests[0].visibility, 'public');
  for (const owner of [0, 1]) assert(g.view(owner).events.some((e) => e.ruleId === 'effects.heal-results' && e.data.id === c.id));
  for (const mutate of [
    (s) => { s.pending.data.healingChoice.id += '-forged'; },
    (s) => { s.pending.data.healingChoice.turn--; },
    (s) => { s.pending.data.healingChoice.sourceId = s.players[1].active.stack.at(-1); },
    (s) => { s.pending.data.healingChoice.targets[0].counters++; },
    (s) => { s.pending.data.healingChoice.targets[0].topCardId = s.players[0].bench[0].stack.at(-1); },
    (s) => { s.pending.data.healingChoice.targets.reverse(); },
    (s) => { s.pending.data.action.amount = 10; },
    (s) => { s.pending.player = 1; },
    (s) => { s.pending.options.reverse(); },
    (s) => { s.pending.minimum = 0; },
    (s) => { s.pending.data.selected = [s.pending.options[0]]; },
    (s) => { s.events.find((e) => e.ruleId === 'effects.heal-results' && e.data.kind === 'requested').visibility = 'private'; },
    (s) => { s.events.push(clone(s.events.find((e) => e.ruleId === 'effects.heal-results' && e.data.kind === 'requested'))); },
  ]) {
    const bad = clone(saved); mutate(bad);
    assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }));
    assert.deepEqual(g.snapshot(), saved);
  }
  for (const chosen of [[], [q.options[0], q.options[0]], [before.players[1].active.id], ['unknown-subject']])
    atomic(g, () => answer(g, chosen));
  respond(g, f, [q.options[1]]);
  outcome(g, before, oracle(before, 0, [q.options[1]], 'all', false)); restored(g, f);
});
