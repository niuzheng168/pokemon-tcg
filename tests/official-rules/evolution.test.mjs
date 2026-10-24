import test from 'node:test';
import assert from 'node:assert/strict';
import { evolutionRelation, evolutionTiming, transitionTargets, transitionCards, devolutionDepth,
  canUsePokemonTransition, EVOLUTION_RULE_IDS } from '../../public/rules/evolution.js';
import { validatePokemonTransitionParameters, validateEffectResolution } from '../../public/rules/schema-validators.js';
import { assertDefinitionShape } from '../../public/rules/card-schema.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { OfficialGame } from '../../public/rules/game.js';
import { createOngoingEffect } from '../../public/rules/ongoing.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, fixtureClock, binding, EVIDENCE, board, start, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const timing = (extra = {}) => ({ firstOwnTurn: 'allow', enteredThisTurn: 'allow', evolvedThisTurn: 'needsRuling', ...extra });
const evolve = (extra = {}) => ({ op: 'evolvePokemon', target: 'self', targetSelector: { kind: 'pokemon' },
  from: 'deck', selector: { kind: 'pokemon' }, relation: 'ordinary', timing: timing(), shuffleAfter: true, ...extra });
const devolve = (extra = {}) => ({ op: 'devolvePokemon', side: 'opponent', target: 'any', targetSelector: { kind: 'pokemon' },
  selection: { kind: 'exact', count: 1 }, layers: { kind: 'exact', count: 1 }, to: 'hand', chooser: 'source', ...extra });
const inherit = (extra = {}) => ({ op: 'inheritPokemon', target: 'self', targetSelector: { kind: 'pokemon' },
  from: 'discard', selector: { kind: 'pokemon', stages: ['basic'] }, relation: 'any', to: 'discard', ...extra });
const ability = (id, effects, extra = {}) => ({ abilityId: id, name: `测试进化${id}`, mode: 'activated',
  usage: { period: 'unlimited', scope: 'pokemon', key: id, limit: null }, effects, sourceOfTruth: EVIDENCE, ...extra });
const use = (g, id = 'transition', owner = 0) => command(g, {
  type: 'useAbility', pokemonId: g.snapshot().players[owner].active.id, abilityId: id,
}, owner);
const restore = (g, f) => OfficialGame.restore(JSON.parse(JSON.stringify(g.snapshot())), { catalog: f.catalog });
const hasAbility = (g, id = 'transition') => g.view(0).legalActions.some((a) => a.abilityId === id);
const put = (s, owner, id, zone) => {
  const card = hand(s, owner, id); s.players[owner].hand.pop(); s.players[owner][zone].push(card); return card;
};
const stack = (s, owner, m, id) => {
  const card = hand(s, owner, id); s.players[owner].hand.pop(); m.stack.push(card); return card;
};
const form = (defs, id, extra = {}) => {
  const d = structuredClone(defs.find((d) => d.definitionId === 'evolution'));
  Object.assign(d, { definitionId: id, nameKey: id, name: `测试形态${id}` });
  Object.assign(d.mechanics, { attacks: [], abilities: [], effects: [], ...extra }); defs.push(d); return d;
};
const stage2 = (defs) => form(defs, 'stage2', {
  stage: 'stage2', evolvesFrom: 'evolution', hp: 200, basicAncestor: { nameKey: 'base', sourceOfTruth: EVIDENCE },
});
const include = (f, ...ids) => { f.deck.splice(-ids.length, ids.length, ...ids.map((id) => `printing:${id}`)); return f; };
const reviewed = (extra) => ({ rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE,
  validateParameters: (p) => Object.keys(p).length === 0, ...extra });
const lock = (s, m, clearOnEvolution = true) => {
  s.ongoing.push(createOngoingEffect({
    id: `e${++s.serial}`, targetId: m.id, source: {
      instanceId: m.stack[0], owner: 0, cardOwner: 0, category: 'attack', pokemonId: m.id,
      attackId: 'base:strike', effectId: 'fixture:lock', sourceOfTruth: EVIDENCE, origin: 'field',
    }, effect: { op: 'restriction', scope: 'all', actions: ['retreat'] }, duration: 'untilNextOwnTurnEnd',
    clearOnBench: true, clearOnEvolution,
  }, s));
};
const chooseEvolution = (g, card) => {
  answer(g, [g.snapshot().players[0].active.id]); answer(g, [card]); settle(g);
};
const activeDef = (g, owner = 0) => {
  const s = g.snapshot(); return s.cards[s.players[owner].active.stack.at(-1)].definitionId;
};

test('C-12/C-13/D-19/E-23 have pinned CN source rules and strictly distinct operations', async () => {
  for (const id of EVOLUTION_RULE_IDS) assert(requireRule(CN_V20261019, id).sourceOfTruth.length);
  const handlerEvidence = createCoreHandlers().get('cn.pokemonTransition@1').sourceOfTruth;
  for (const section of ['C-12', 'C-13', 'D-19']) assert(handlerEvidence.some((s) => s.section.includes(section)));
  for (const a of [evolve(), devolve(), inherit()]) assert(validatePokemonTransitionParameters(a));
  for (const a of [evolve({ shuffleAfter: false }), evolve({ from: 'hand' }), evolve({ relation: 'guess' }),
    evolve({ timing: { firstOwnTurn: 'allow' } }), evolve({ side: 'opponent' }), devolve({ layers: { kind: 'exact', count: 0 } }),
    inherit({ preserveCounters: false }), inherit({ selector: { kind: 'any' } }), inherit({ from: 'deck' })])
    assert(!validatePokemonTransitionParameters(a));
  const f = await fixture((defs) => stage2(defs));
  const d = structuredClone(f.catalog.definition('stage2')); delete d.mechanics.basicAncestor;
  assert.throws(() => assertDefinitionShape(d), /Invalid normalized/);
  const basic = structuredClone(f.catalog.definition('base')); basic.mechanics.basicAncestor = { nameKey: 'base', sourceOfTruth: EVIDENCE };
  assert.throws(() => assertDefinitionShape(basic), /Invalid normalized/);
  await assert.rejects(fixture((defs) => {
    stage2(defs).mechanics.basicAncestor.sourceOfTruth = [{ ...EVIDENCE[0], kind: 'official-rule' }];
  }), /ancestry needs/);
  await assert.rejects(fixture((defs) => { stage2(defs).mechanics.basicAncestor.nameKey = 'other'; }), /ancestry contradicts/);
  const withoutParent = await fixture((defs) => { stage2(defs); defs[2].nameKey = 'unrelated'; defs[2].name = '测试另一个家族'; });
  assert(withoutParent.catalog.definition('stage2'), 'An absent intermediate must not invalidate a reviewed Candy-compatible path.');
});

test('evolution relations use approved actual ancestry, not a global species guess or catalog membership', async () => {
  const f = await fixture((defs) => stage2(defs)), base = f.catalog.definition('base'), first = f.catalog.definition('evolution');
  const second = f.catalog.definition('stage2'), other = f.catalog.definition('other');
  assert(evolutionRelation(base, first, 'ordinary')); assert(!evolutionRelation(other, first, 'ordinary'));
  assert(evolutionRelation(base, second, 'skipStage1')); assert(!evolutionRelation(other, second, 'skipStage1'));
  assert(!evolutionRelation(first, second, 'skipStage1')); assert(!evolutionRelation(base, first, 'skipStage1'));
  assert(evolutionRelation(other, first, 'anyStage1')); assert(!evolutionRelation(first, first, 'anyStage1'));
  assert(!evolutionRelation(base, second, 'anyStage1')); assert(!evolutionRelation(base, base, 'ordinary'));
  assert(!evolutionRelation(f.catalog.definition('water'), first, 'ordinary'));
  assert(!evolutionRelation(base, f.catalog.definition('potion'), 'ordinary'));
  assert.throws(() => evolutionRelation(base, first, 'guess'), /Unknown reviewed/);
});

test('effect timing policies distinguish a first own turn, new entry and already-evolved uncertainty', () => {
  const state = { current: 0, turn: 1, players: [{ turns: 1 }, { turns: 0 }] }, m = { enteredTurn: 1, evolvedTurn: 0 };
  assert(evolutionTiming(state, 0, m, timing()).allowed);
  assert(!evolutionTiming(state, 0, m, timing({ firstOwnTurn: 'forbid' })).allowed);
  assert(!evolutionTiming(state, 0, m, timing({ enteredThisTurn: 'forbid' })).allowed);
  const evolved = { enteredTurn: 0, evolvedTurn: 1 };
  assert(evolutionTiming(state, 0, evolved, timing()).needsRuling);
  assert(!evolutionTiming(state, 0, evolved, timing({ evolvedThisTurn: 'forbid' })).allowed);
  assert(evolutionTiming(state, 0, evolved, timing({ evolvedThisTurn: 'allow' })).allowed);
  assert(evolutionTiming({ ...state, current: 1 }, 0, evolved, timing({ firstOwnTurn: 'forbid', evolvedThisTurn: 'allow' })).allowed);
});

test('C-12 effect evolution can occur on a first own turn and new entry, preserves damage/attachments and records its real deck origin', async () => {
  const f = await fixture((defs) => defs[0].mechanics.abilities = [ability('transition', [binding('cn.pokemonTransition@1', evolve())])]);
  let evolution, energy, tool;
  const g = board(f, (s) => {
    fixtureClock(s, [0]); s.players[0].active.enteredTurn = 1; s.players[0].active.evolvedTurn = 0;
    energy = attached(s, 0, s.players[0].active, 'water');
    tool = hand(s, 0, 'tool'); s.players[0].hand.pop(); s.players[0].active.tools.push(tool);
    s.players[0].active.counters = 3; s.players[0].active.conditions.poison = 1;
    lock(s, s.players[0].active);
    evolution = put(s, 0, 'evolution', 'deck');
  });
  assert(!g.view(0).legalActions.some((a) => a.type === 'evolve'));
  use(g); assert.equal(g.snapshot().pending.kind, 'transition-target');
  answer(g, [g.snapshot().players[0].active.id]);
  assert.equal(g.snapshot().pending.kind, 'transition-card');
  assert(g.view(0).pending.lookedAt.some((c) => c.instanceId === evolution));
  assert.deepEqual(g.view(0).pending.lookedAt.map((c) => c.instanceId), [...g.snapshot().players[0].deck].sort(),
    'Full-deck evolution search reveals card identities, not the hidden deck order.');
  assert.equal(g.view(1).pending, null);
  const r = restore(g, f); answer(g, [evolution]); answer(r, [evolution]); settle(g); settle(r);
  assert.deepEqual(r.snapshot(), g.snapshot());
  const m = g.snapshot().players[0].active;
  assert.equal(m.counters, 3); assert.deepEqual(m.energy, [energy]); assert.deepEqual(m.tools, [tool]);
  assert.equal(m.conditions.poison, null); assert.equal(g.snapshot().ongoing.length, 0);
  assert.equal(m.facts.evolution.method, 'effect'); assert.equal(m.facts.evolution.origin, 'deck');
  assert.equal(m.facts.evolution.fromCardId, m.stack[0]); assert.equal(m.facts.evolution.toCardId, evolution);
  assert.equal(g.view(0).players[0].active.effective.currentHp, 120);
});

test('C-12 Rare-Candy-like paths use reviewed Basic ancestry and enforce the card-specific ordinary timing exclusions', async () => {
  const a = evolve({ from: 'hand', shuffleAfter: false, relation: 'skipStage1', selector: { kind: 'pokemon', stages: ['stage2'] },
    targetSelector: { kind: 'pokemon', stages: ['basic'] },
    timing: timing({ firstOwnTurn: 'forbid', enteredThisTurn: 'forbid', evolvedThisTurn: 'forbid' }) });
  const f = include(await fixture((defs) => {
    stage2(defs); defs[0].mechanics.abilities = [ability('transition', [binding('cn.pokemonTransition@1', a)])];
  }), 'stage2');
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'stage2'); });
  use(g); chooseEvolution(g, card);
  assert.deepEqual(g.snapshot().players[0].active.stack.map((id) => g.snapshot().cards[id].definitionId), ['base', 'stage2']);
  assert.equal(g.snapshot().players[0].active.facts.evolution.fromCardId, g.snapshot().players[0].active.stack[0]);
  for (const kind of ['first', 'new', 'already']) {
    const h = board(f, (s) => {
      hand(s, 0, 'stage2');
      if (kind === 'first') fixtureClock(s, [0]);
      if (kind === 'new') s.players[0].active.enteredTurn = s.turn;
      if (kind === 'already') s.players[0].active.evolvedTurn = s.turn;
    });
    assert(!hasAbility(h), kind);
  }
});

test('a reviewed any-Stage-1 exception records the actual evolved-from card, not the printed usual prerequisite', async () => {
  const f = await fixture((defs) => defs[1].mechanics.abilities = [ability('transition', [
    binding('cn.pokemonTransition@1', evolve({ from: 'hand', shuffleAfter: false, relation: 'anyStage1' })),
  ])]);
  let evolution;
  const g = board(f, (s) => {
    const m = bench(s, 0, 'other'), p = s.players[0]; p.bench.pop(); p.bench.push(p.active); p.active = m;
    evolution = hand(s, 0, 'evolution');
  });
  use(g); chooseEvolution(g, evolution);
  const s = g.snapshot(), history = s.players[0].active.facts.evolution;
  assert.equal(s.cards[history.fromCardId].definitionId, 'other');
  assert.equal(f.catalog.definition('evolution').mechanics.evolvesFrom, 'base');
  assert.notEqual(s.cards[history.fromCardId].definitionId, f.catalog.definition('evolution').mechanics.evolvesFrom);
});

test('an already-evolved effect requiring an unresolved ruling fails atomically instead of importing an international timing exception', async () => {
  const f = include(await fixture((defs) => {
    stage2(defs); defs[0].mechanics.abilities = [ability('transition', [
      binding('cn.pokemonTransition@1', evolve({ target: 'any' })),
    ])];
  }), 'stage2');
  const g = board(f, (s) => {
    const m = bench(s, 0, 'base'); stack(s, 0, m, 'evolution'); m.evolvedTurn = s.turn;
  });
  use(g); const before = g.snapshot(), target = before.players[0].bench[0].id;
  assert.throws(() => answer(g, [target]), (e) => e.code === 'unresolved-evolution-timing');
  assert.deepEqual(g.snapshot(), before);
});

test('deck evolution can fail to find without leaking through legality, still privately reveals the inspected zone and shuffles', async () => {
  const f = await fixture((defs) => defs[0].mechanics.abilities = [ability('transition', [
    binding('cn.pokemonTransition@1', evolve({ selector: { kind: 'pokemon', nameKeys: ['missing'] } })),
  ])]);
  const g = board(f); assert(hasAbility(g)); use(g); answer(g, [g.snapshot().players[0].active.id]);
  assert.equal(g.snapshot().pending.kind, 'view-cards'); assert(g.view(0).pending.lookedAt.length > 0);
  assert.equal(g.view(1).pending, null); assert.deepEqual(restore(g, f).view(0), g.view(0));
  const before = g.snapshot().rng; answer(g, ['confirm']); settle(g);
  assert.notDeepEqual(g.snapshot().rng, before); assert.equal(activeDef(g), 'base');
  const zero = board(f, (s) => s.players[0].discard.push(...s.players[0].deck.splice(0)));
  assert(!hasAbility(zero));
});

test('filtered hand/deck choices may choose zero, whereas an eligible discard evolution must be selected', async () => {
  for (const from of ['hand', 'deck', 'discard']) {
    const f = await fixture((defs) => defs[0].mechanics.abilities = [ability('transition', [
      binding('cn.pokemonTransition@1', evolve({ from, shuffleAfter: from === 'deck' })),
    ])]);
    let card;
    const g = board(f, (s) => { card = from === 'hand' ? hand(s, 0, 'evolution') : put(s, 0, 'evolution', from); });
    use(g); answer(g, [g.snapshot().players[0].active.id]);
    if (from === 'discard') {
      const before = g.snapshot(); assert.throws(() => answer(g, []), /quantity/); assert.deepEqual(g.snapshot(), before);
      answer(g, [card]);
    } else answer(g, []);
    settle(g); assert.equal(activeDef(g), from === 'discard' ? 'evolution' : 'base');
  }
});

test('from-hand evolution reactions recognize effect evolution from hand, not deck evolution or inherited replacement', async () => {
  for (const method of ['hand', 'deck', 'inherit']) {
    const f = await fixture((defs) => {
      defs[0].mechanics.abilities = [ability('transition', [binding('cn.pokemonTransition@1',
        method === 'inherit' ? inherit({ from: 'hand', selector: { kind: 'pokemon', stages: ['stage1'] } }) :
          evolve({ from: method, shuffleAfter: method === 'deck' }))])];
      defs[2].mechanics.abilities = [ability('evolved', [binding('cn.counters@1', { side: 'own', target: 'event', count: 1 })], {
        mode: 'triggered', usage: null, trigger: { event: 'evolve', subject: 'self', optional: false, choiceOwner: 'source', scope: 'subject', origin: 'hand' },
      })];
    });
    let card;
    const g = board(f, (s) => { card = method === 'deck' ? put(s, 0, 'evolution', 'deck') : hand(s, 0, 'evolution'); });
    use(g); chooseEvolution(g, card);
    assert.equal(g.snapshot().players[0].active.counters, method === 'hand' ? 1 : 0);
  }
});

test('ordinary evolution records immutable E-23 provenance and it survives returning to the Bench', async () => {
  const f = await fixture(), g = board(f, (s) => {
    hand(s, 0, 'evolution'); bench(s, 0, 'other'); attached(s, 0, s.players[0].active, 'water');
  });
  command(g, g.view(0).legalActions.find((a) => a.type === 'evolve'));
  const history = g.snapshot().players[0].active.facts.evolution;
  assert.equal(history.method, 'ordinary'); assert.equal(history.origin, 'hand');
  command(g, { type: 'retreat' }); settle(g);
  assert.deepEqual(g.snapshot().players[0].bench[0].facts.evolution, history);
  assert.deepEqual(restore(g, f).view(0), g.view(0));
  for (const mutate of [
    (e) => { e.turn--; }, (e) => { e.fromCardId = e.toCardId; }, (e) => { e.fromCardId = 'missing'; },
    (e, s) => { e.fromCardId = s.players[1].active.stack[0]; },
  ]) {
    const s = g.snapshot(); mutate(s.players[0].bench[0].facts.evolution, s);
    assert.throws(() => OfficialGame.restore(s, { catalog: f.catalog }), /Evolution facts/);
  }
});

test('C-13 removes only the top evolution, retains damage/attachments, clears all attached effects and prevents ordinary same-turn re-evolution', async () => {
  const f = await fixture((defs) => defs[0].mechanics.abilities = [ability('transition', [binding('cn.pokemonTransition@1',
    devolve({ side: 'own', target: 'bench' }))])]);
  let evolved, energy, target;
  const g = board(f, (s) => {
    const m = bench(s, 0, 'base'); target = m.id; evolved = stack(s, 0, m, 'evolution'); energy = attached(s, 0, m, 'water');
    m.counters = 3; lock(s, m, false);
  });
  use(g); answer(g, [target]); assert.equal(g.snapshot().pending.kind, 'devolution-count');
  const r = restore(g, f); answer(g, ['1']); answer(r, ['1']); settle(g); settle(r);
  assert.deepEqual(g.snapshot(), r.snapshot());
  const s = g.snapshot(), m = s.players[0].bench[0];
  assert.equal(m.stack.length, 1); assert.equal(m.counters, 3); assert.deepEqual(m.energy, [energy]);
  assert.equal(s.ongoing.length, 0, 'C-13 clears even an entry not flagged for ordinary-evolution cleanup.');
  assert(s.players[0].hand.includes(evolved)); assert.equal(m.enteredTurn, s.turn);
  assert(!g.view(0).legalActions.some((a) => a.type === 'evolve' && a.pokemonId === target));
});

test('C-13 arbitrary top-down depth returns all selected evolution cards and leaves the underlying Basic, never a directly deployed Stage 2', async () => {
  const f = include(await fixture((defs) => {
    stage2(defs); defs[0].mechanics.abilities = [ability('transition', [binding('cn.pokemonTransition@1',
      devolve({ layers: { kind: 'any' }, to: 'deckShuffle' }))])];
  }), 'stage2', 'stage2');
  let first, second, target;
  const g = board(f, (s) => {
    target = s.players[1].active.id; first = stack(s, 1, s.players[1].active, 'evolution'); second = stack(s, 1, s.players[1].active, 'stage2');
    bench(s, 1, 'stage2');
    s.players[1].active.conditions.poison = 1;
  });
  use(g); assert.deepEqual(g.snapshot().pending.options, [target]); answer(g, [target]);
  assert.deepEqual(g.snapshot().pending.options, ['0', '1', '2']);
  answer(g, ['2']); settle(g);
  const s = g.snapshot(); assert.equal(s.players[1].active.stack.length, 1);
  assert(s.players[1].deck.includes(first) && s.players[1].deck.includes(second));
  assert.equal(s.players[1].active.conditions.poison, null);
  assert.equal(s.players[1].bench[0].stack.length, 1);
  assert(s.events.some((e) => e.ruleId === 'effects.shuffle' && e.data.player === 1));
});

test('a zero-layer choice leaves the Pokémon completely unchanged and does not pretend that a devolution occurred', async () => {
  const f = await fixture((defs) => defs[0].mechanics.abilities = [ability('transition', [binding('cn.pokemonTransition@1',
    devolve({ layers: { kind: 'any' } }))])]);
  const g = board(f, (s) => { stack(s, 1, s.players[1].active, 'evolution'); s.players[1].active.conditions.poison = 1; });
  use(g); answer(g, [g.snapshot().players[1].active.id]);
  const before = g.snapshot().players[1].active; answer(g, ['0']); settle(g);
  assert.deepEqual(g.snapshot().players[1].active, before);
  assert(!g.snapshot().events.some((e) => e.ruleId === 'effects.devolve'));
});

test('devolution protection blocks a selected target without preventing its selection', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.abilities = [ability('transition', [binding('cn.pokemonTransition@1', devolve({ selection: { kind: 'all' } }))])];
    defs[2].mechanics.effects = [binding('cn.protection@1', { effect: {
      op: 'protection', useRule: 'ordinary', scope: 'self', from: 'opponent', categories: ['ability'], channel: 'effects',
    } })];
  });
  const g = board(f, (s) => stack(s, 1, s.players[1].active, 'evolution'));
  use(g); assert.equal(g.snapshot().pending.kind, 'devolution-count'); answer(g, ['1']); settle(g);
  assert.equal(activeDef(g, 1), 'evolution');
  assert(g.snapshot().events.some((e) => e.ruleId === 'effects.protection'));
});

test('all devolution layers are selected before any change, and protections for a simultaneous batch use the same original board', async () => {
  const f = include(await fixture((defs) => {
    defs[0].mechanics.abilities = [ability('transition', [binding('cn.pokemonTransition@1', devolve({
      selection: { kind: 'all' }, chooser: 'holder',
    }))])];
    defs[2].mechanics.abilities = [ability('shield', [binding('fixture:conditional-devolution-shield', {})], { mode: 'continuous', usage: null })];
  }, new Map([['fixture:conditional-devolution-shield', reviewed({ timing: 'continuous', operations: ['protection'],
    execute: (ctx) => {
      const p = ctx.state.players[ctx.source.owner];
      const count = [p.active, ...p.bench].filter(Boolean).filter((m) =>
        ctx.definitions[ctx.state.cards[m.stack.at(-1)].definitionId].mechanics.stage === 'stage1').length;
      return count === 1 ? [{ op: 'protection', useRule: 'ordinary', scope: 'own', from: 'opponent', categories: ['ability'], channel: 'effects' }] : [];
    } })]])), 'evolution');
  let activeEvolution, benchEvolution;
  const g = board(f, (s) => {
    activeEvolution = stack(s, 1, s.players[1].active, 'evolution');
    benchEvolution = stack(s, 1, bench(s, 1, 'other'), 'evolution');
  });
  use(g); assert.equal(g.snapshot().pending.player, 1); answer(g, ['1']);
  assert.equal(g.snapshot().players[1].active.stack.length, 2);
  assert.equal(g.snapshot().players[1].bench[0].stack.length, 2);
  const bad = g.snapshot(); bad.pending.data.devolutionPlan[0].count = null; bad.pending.data.devolutionPlan[1].count = 1;
  assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }), /valid selection cursor/);
  const r = restore(g, f); answer(g, ['1']); answer(r, ['1']); settle(g); settle(r);
  assert.deepEqual(r.snapshot(), g.snapshot());
  assert.equal(g.snapshot().players[1].active.stack.length, 1); assert.equal(g.snapshot().players[1].bench[0].stack.length, 1);
  assert(g.snapshot().players[1].hand.includes(activeEvolution)); assert(g.snapshot().players[1].hand.includes(benchEvolution));
});

test('devolution HP loss is an effect KO, never attack damage; Prizes use the revealed form and related KO work settles normally', async () => {
  const observed = [];
  const f = await fixture((defs) => {
    defs[0].mechanics.attacks[0].cost = []; defs[0].mechanics.attacks[0].printedDamage = null;
    defs[0].mechanics.attacks[0].effects = [binding('cn.pokemonTransition@1', devolve({ target: 'active', to: 'discard' }))];
    defs[2].mechanics.ruleBox = true; defs[2].mechanics.prizeCount = 2;
    defs[0].mechanics.abilities = [ability('ko-proof', [binding('fixture:ko-proof', {})], {
      mode: 'triggered', usage: null, trigger: { event: 'knockout', subject: 'self', optional: false, choiceOwner: 'source', scope: 'subject' },
    })];
  }, new Map([['fixture:ko-proof', reviewed({ operations: [], execute: (ctx) => { observed.push(ctx.event.cause); return []; } })]]));
  let old, energy;
  const g = board(f, (s) => {
    old = stack(s, 1, s.players[1].active, 'evolution'); s.players[1].active.counters = 12;
    energy = attached(s, 1, s.players[1].active, 'water'); bench(s, 1, 'other');
  });
  command(g, { type: 'attack', attackId: 'base:strike' }); answer(g, [g.snapshot().players[1].active.id]);
  answer(g, ['1']); settle(g);
  assert.equal(g.snapshot().players[0].prizes.length, 5, 'Revealed Basic is one Prize, not the removed two-Prize form.');
  assert(g.snapshot().players[1].discard.includes(old)); assert(g.snapshot().players[1].discard.includes(energy));
  assert.equal(activeDef(g, 1), 'other');
  assert(!g.snapshot().events.some((e) => e.ruleId === 'trigger.damage'));
  assert.equal(observed.length, 1); assert.equal(observed[0].kind, 'effect'); assert.equal(observed[0].source.attackId, 'base:strike');
});

test('D-19 inherited replacement retains the complete battle identity and per-Ability use history; a different Ability remains usable', async () => {
  const f = await fixture((defs) => {
    const use = { period: 'turn', scope: 'pokemon', key: 'shared', limit: 1 };
    defs[0].mechanics.abilities = [
      ability('draw', [binding('cn.draw@1', { count: 1 }, 'base-draw')], { usage: use }),
      ability('transition', [binding('cn.pokemonTransition@1', inherit())]),
    ];
    defs[1].mechanics.abilities = [
      ability('same', [binding('cn.draw@1', { count: 1 }, 'same-draw')], { usage: use }),
      ability('different', [binding('cn.draw@1', { count: 1 }, 'different-draw')], {
        usage: { period: 'turn', scope: 'pokemon', key: 'different', limit: 1 },
      }),
    ];
    defs[1].mechanics.abilities[0].name = defs[0].mechanics.abilities[0].name;
  });
  let incoming, energy, tool;
  const g = board(f, (s) => {
    incoming = put(s, 0, 'other', 'discard'); energy = attached(s, 0, s.players[0].active, 'water');
    tool = hand(s, 0, 'tool'); s.players[0].hand.pop(); s.players[0].active.tools.push(tool);
    s.players[0].active.counters = 2; s.players[0].active.conditions.poison = 1; lock(s, s.players[0].active);
    s.players[0].active.facts.healedTurn = s.turn; s.players[0].active.facts.movedActiveTurn = s.turn;
  });
  use(g, 'draw'); settle(g);
  const before = g.snapshot().players[0].active, ongoing = g.snapshot().ongoing;
  use(g); chooseEvolution(g, incoming);
  const after = g.snapshot().players[0].active;
  assert.equal(after.id, before.id); assert.equal(after.counters, before.counters);
  assert.deepEqual(after.conditions, before.conditions); assert.deepEqual(after.facts, before.facts);
  assert.deepEqual(after.used, before.used); assert.deepEqual(after.energy, [energy]); assert.deepEqual(after.tools, [tool]);
  assert.deepEqual(g.snapshot().ongoing, ongoing);
  assert(!hasAbility(g, 'same')); assert(hasAbility(g, 'different'));
  assert(g.snapshot().players[0].discard.includes(before.stack.at(-1)));
  assert.deepEqual(restore(g, f).view(0), g.view(0));
});

test('same-name inherited replacement preserves the underlying evolution stack, while only the old top card returns to hand', async () => {
  const f = include(await fixture((defs) => {
    const other = form(defs, 'other-evolution'); other.name = defs[2].name; other.nameKey = defs[2].nameKey;
    defs[2].mechanics.abilities = [ability('transition', [binding('cn.pokemonTransition@1',
      inherit({ from: 'hand', selector: { kind: 'pokemon', nameKeys: ['evolution'] }, relation: 'sameName', to: 'hand' }))])];
  }), 'other-evolution');
  let incoming, old;
  const g = board(f, (s) => { old = stack(s, 0, s.players[0].active, 'evolution'); incoming = hand(s, 0, 'other-evolution'); });
  const base = g.snapshot().players[0].active.stack[0];
  use(g); chooseEvolution(g, incoming);
  assert.deepEqual(g.snapshot().players[0].active.stack, [base, incoming]); assert(g.snapshot().players[0].hand.includes(old));
  assert.equal(g.snapshot().players[0].active.evolvedTurn, 0, 'Inheritance is not a new evolution event.');
});

test('inherited replacement lowering HP and loss of a retained Special Energy both reach the normal KO boundary', async () => {
  const f = await fixture((defs) => {
    defs[1].mechanics.hp = 20;
    defs[0].mechanics.abilities = [ability('transition', [binding('cn.pokemonTransition@1', inherit())])];
    defs.find((d) => d.definitionId === 'double').mechanics.remainOn = { kind: 'pokemon', nameKeys: ['base'] };
  });
  let incoming, energy;
  const g = board(f, (s) => {
    incoming = put(s, 0, 'other', 'discard'); energy = attached(s, 0, s.players[0].active, 'double');
    s.players[0].active.counters = 2; bench(s, 0, 'base');
  });
  use(g); chooseEvolution(g, incoming);
  assert(g.snapshot().players[0].discard.includes(energy)); assert(g.snapshot().players[0].discard.includes(incoming));
  assert.equal(g.snapshot().players[1].prizes.length, 5); assert.equal(activeDef(g), 'base');
});

test('strict continuation validation rejects modified top cards, inspected zones, devolution depth/cursors and mismatched stages', async () => {
  const f = await fixture((defs) => defs[0].mechanics.abilities = [ability('transition', [binding('cn.pokemonTransition@1', evolve())])]);
  const g = board(f, (s) => put(s, 0, 'evolution', 'deck'));
  use(g); answer(g, [g.snapshot().players[0].active.id]);
  for (const mutate of [
    (d) => { d.transition.topCardId = 'missing'; }, (d) => { d.transition.pokemonId = 'missing'; },
    (d) => { d.lookedAt.pop(); }, (d) => { d.stage = 'transition-empty'; }, (d) => { delete d.stage; },
  ]) {
    const s = g.snapshot(); mutate(s.pending.data);
    assert.throws(() => OfficialGame.restore(s, { catalog: f.catalog }), /Saved transition|Corrupt/);
  }
  const df = await fixture((defs) => defs[0].mechanics.abilities = [ability('transition', [binding('cn.pokemonTransition@1',
    devolve({ selection: { kind: 'all' } }))])]);
  const h = board(df, (s) => stack(s, 1, s.players[1].active, 'evolution')); use(h);
  for (const mutate of [
    (d) => { d.devolutionPlan[0].topCardId = 'missing'; }, (d) => { d.devolutionPlan.push({ ...d.devolutionPlan[0] }); },
    (d) => { d.devolutionPlan[0].count = 4; }, (d) => { d.stage = 'devolution-apply'; }, (d) => { delete d.stage; },
  ]) {
    const s = h.snapshot(); mutate(s.pending.data);
    assert.throws(() => OfficialGame.restore(s, { catalog: df.catalog }), /Saved devolution|Devolution targets|application needs|Corrupt/);
  }
  assert.deepEqual(restore(h, df).view(0), h.view(0));
  assert(!validateEffectResolution({ ...g.snapshot().pending.data, devolutionPlan: h.snapshot().pending.data.devolutionPlan }));
});

test('pure transition contexts use actual positions and relations, distinguish direct deployment and do not use hidden deck matches for declaration', async () => {
  const f = await fixture(), definitions = Object.fromEntries(f.definitions.map((d) => [d.definitionId, d]));
  const m = { id: 'a', stack: ['base'], enteredTurn: 0, evolvedTurn: 0 }, b = { id: 'b', stack: ['other', 'evolution'], enteredTurn: 0, evolvedTurn: 0 };
  const ctx = { source: { owner: 0, pokemonId: 'a' }, event: { subjectId: 'b', cause: { source: { pokemonId: 'a' } } }, definitions,
    effectivePokemon: { a: { types: ['Water'] }, b: { types: ['Water'] } }, enterLocks: [[], []],
    state: { turn: 5, current: 0, players: [{ turns: 3, active: m, bench: [b], deck: ['water'], hand: ['evo2'], discard: [] },
      { turns: 2, active: null, bench: [], deck: [], hand: [], discard: [] }], cards: {
      base: { definitionId: 'base' }, other: { definitionId: 'other' }, evolution: { definitionId: 'evolution' },
      evo2: { definitionId: 'evolution' }, water: { definitionId: 'water' },
    } } };
  for (const [target, ids] of [['active', ['a']], ['bench', ['b']], ['self', ['a']], ['event', ['b']], ['attacker', ['a']], ['any', ['a', 'b']]])
    assert.deepEqual(transitionTargets(ctx, evolve({ target })).map((m) => m.id), ids);
  assert.deepEqual(transitionTargets({ ...ctx, event: null }, evolve({ target: 'event' })), []);
  assert.deepEqual(transitionTargets({ ...ctx, event: null }, evolve({ target: 'attacker' })), []);
  assert.equal(devolutionDepth(ctx, m), 0); assert.equal(devolutionDepth(ctx, b), 1);
  assert.equal(devolutionDepth(ctx, { ...b, stack: ['evolution'] }), 0);
  assert.equal(devolutionDepth(ctx, { ...b, stack: ['evolution', 'base'] }), 0);
  assert(canUsePokemonTransition(ctx, evolve()), 'A deck containing no matching evolution does not hide the search action.');
  assert(canUsePokemonTransition(ctx, devolve({ side: 'own', target: 'bench' })));
  assert(!canUsePokemonTransition(ctx, inherit()));
  assert.deepEqual(transitionCards(ctx, inherit({ from: 'hand', relation: 'sameName', selector: { kind: 'pokemon' } }), m), []);
  assert(!canUsePokemonTransition(ctx, evolve({ from: 'hand', shuffleAfter: false, timing: timing({ enteredThisTurn: 'forbid' }) , target: 'bench' })));
});

test('transition target types are live, but evolution candidates, ancestry and printed identity remain printed', async () => {
  const f = await fixture(), definitions = Object.fromEntries(f.definitions.map((d) => [d.definitionId, d]));
  const mon = { id: 'a', stack: ['base'], enteredTurn: 0, evolvedTurn: 0 };
  const ctx = {
    source: { owner: 0, pokemonId: 'a' }, definitions,
    effectivePokemon: { a: { types: ['Lightning', 'Metal'] }, b: { types: ['Fire'] }, evo2: { types: ['Lightning'] } }, enterLocks: [[], []],
    state: { turn: 5, current: 0, players: [
      { turns: 3, active: mon, bench: [{ id: 'b', stack: ['other', 'evolution'] }], deck: ['evo2'], hand: ['evo2'], discard: [] },
      { turns: 2, active: null, bench: [], deck: [], hand: [], discard: [] },
    ], cards: { base: { definitionId: 'base' }, other: { definitionId: 'other' },
      evolution: { definitionId: 'evolution' }, evo2: { definitionId: 'evolution' } } },
  };
  const before = structuredClone(ctx);
  for (const [types, expected] of [
    [['Water'], []], [['Lightning'], ['a']], [['Metal'], ['a']], [['Fire'], ['b']], [['Fire', 'Metal'], ['a', 'b']],
  ]) for (const op of [evolve({ target: 'any' }), devolve({ side: 'own' })])
    assert.deepEqual(transitionTargets(ctx, { ...op, targetSelector: { kind: 'pokemon', types } }).map((m) => m.id), expected);
  const typed = evolve({ targetSelector: { kind: 'pokemon', types: ['Lightning'], stages: ['basic'], nameKeys: ['base'] },
    selector: { kind: 'pokemon', types: ['Water'], stages: ['stage1'] } });
  assert(canUsePokemonTransition(ctx, typed));
  assert.deepEqual(transitionCards(ctx, typed, mon), ['evo2']);
  assert.deepEqual(transitionCards(ctx, { ...typed, selector: { kind: 'pokemon', types: ['Lightning'] } }, mon), [],
    'A searched evolution card does not inherit the current user’s live type.');
  assert(!canUsePokemonTransition(ctx, { ...typed, targetSelector: { kind: 'pokemon', types: ['Water'] } }));
  assert.deepEqual(transitionTargets(ctx, { ...typed, targetSelector: { kind: 'pokemon', types: ['Lightning'], stages: ['stage1'] } }), []);
  assert.deepEqual(ctx, before);
  for (const mutate of [
    (c) => { delete c.effectivePokemon; }, (c) => { c.effectivePokemon = {}; },
    (c) => { delete c.effectivePokemon.a.types; }, (c) => { c.effectivePokemon.a.types = null; },
    (c) => { c.effectivePokemon.a.types = []; }, (c) => { c.effectivePokemon.a.types = ['Fake']; },
    (c) => { c.effectivePokemon.a.types = ['Water', 'Water']; },
  ]) {
    const invalid = structuredClone(ctx); mutate(invalid);
    assert.throws(() => transitionTargets(invalid, evolve()), TypeError, 'An untyped selector still requires the live model.');
  }
});
