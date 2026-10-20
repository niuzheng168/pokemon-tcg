import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, assertGameState, createGameState, reduceGame, playerView } from '../../public/rules/game.js';
import { createCardCatalog, validateDeck } from '../../public/rules/catalog.js';
import { canonicalDefinition } from '../../public/rules/card-schema.js';
import { applyCondition } from '../../public/rules/conditions.js';
import { fixture, fixtureClock, binding, RULESET, EVIDENCE, start, settle, answer, command, board, hand, attached, bench } from './fixtures.mjs';

test('game setup honors decision-winner choice, seven cards and prizes-before-compensation', async () => {
  const f = await fixture();
  const game = new OfficialGame({ ruleset: RULESET, catalog: f.catalog, decks: [f.deck, f.deck], seed: f.seed });
  const chooser = game.snapshot().pending.player;
  answer(game, ['second']); settle(game);
  const s = game.snapshot();
  assert.equal(s.first, 1 - chooser); assert.equal(s.current, s.first);
  assert.equal(s.turn, 1);
  assert(s.players.every((p) => p.active && p.prizes.length === 6));
  assertGameState(s, f.catalog);
  for (const [i, event] of s.events.entries()) if (event.ruleId === 'setup.mulligan' && event.data.shared === false) {
    assert(s.events.slice(0, i).some((e) => e.ruleId === 'setup.prizes' && e.data.player === 1 - event.data.player));
  }
});

test('mutual mulligans never become compensation, and compensation may be declined', async () => {
  const f = await fixture();
  let checked = 0;
  for (let seed = 1; seed <= 80; seed++) {
    const game = start(f, [Math.imul(seed, 0x9e3779b9) >>> 0, Math.imul(seed + 1, 0x85ebca6b) >>> 0, seed + 7, seed + 19]), s = game.snapshot();
    const shared = s.events.filter((e) => e.ruleId === 'setup.mulligan' && e.data.shared);
    assert.equal(shared.length % 2, 0);
    const unilateral = s.events.filter((e) => e.ruleId === 'setup.mulligan' && !e.data.shared);
    assert.equal(s.setup.bonus.reduce((a, b) => a + b, 0), unilateral.length);
    for (const p of s.players) assert(p.bench.length === 0);
    checked += shared.length > 0 && unilateral.length > 0 ? 1 : 0;
  }
  assert(checked > 0);
});

test('setup projections hide opposing face-down Pokémon, deck/prize identities, RNG and work', async () => {
  const f = await fixture(), game = new OfficialGame({ ruleset: RULESET, catalog: f.catalog, decks: [f.deck, f.deck], seed: f.seed });
  answer(game, ['first']);
  const s = game.snapshot(), p = s.pending.player, v = game.view(1 - p);
  assert.equal(v.pending, null);
  for (const key of ['rng', 'cards', 'queue', 'catalogId']) assert(!Object.hasOwn(v, key));
  assert.deepEqual(v.players[p].hand, { count: s.players[p].hand.length });
  assert.deepEqual(v.players[p].prizes, { count: s.players[p].prizes.length });
  assert(!Object.hasOwn(v.players[p], 'deck'));
  assert.throws(() => game.view(2), TypeError);
});

test('illegal/stale/foreign commands are atomic and do not consume RNG or clear choices', async () => {
  const f = await fixture(), game = start(f), s = game.snapshot(), player = s.current;
  for (const input of [
    { player, expectedRevision: s.revision - 1, action: { type: 'endTurn' } },
    { player: 1 - player, expectedRevision: s.revision, action: { type: 'endTurn' } },
    { player, expectedRevision: s.revision, action: { type: 'grant-prizes' } },
    { player, expectedRevision: s.revision, action: { type: 'attachEnergy', cardId: 'forged', pokemonId: s.players[player].active.id } },
  ]) {
    assert.throws(() => game.dispatch(input));
    assert.deepEqual(game.snapshot(), s);
  }
  const g = new OfficialGame({ ruleset: RULESET, catalog: f.catalog, decks: [f.deck, f.deck], seed: f.seed }), before = g.snapshot();
  assert.throws(() => g.dispatch({ player: before.pending.player, expectedRevision: 0,
    action: { type: 'answer', requestId: 'wrong-request', selected: ['first'] } }));
  assert.deepEqual(g.snapshot(), before);
});

test('normal attachment once, attack does not spend Energy, turn passes after attack/checkup', async () => {
  const f = await fixture(), game = board(f), initial = game.snapshot(), owner = 0;
  const energy = initial.players[owner].hand.find((id) => initial.cards[id].definitionId === 'water') ||
    (() => { throw new Error('Fixture needs hand Energy.'); })();
  command(game, { pokemonId: initial.players[0].active.id, cardId: energy, type: 'attachEnergy' });
  assert(!game.view(0).legalActions.some((a) => a.type === 'attachEnergy'));
  const attack = game.view(0).legalActions.find((a) => a.type === 'attack'); assert(attack);
  command(game, attack); settle(game);
  const after = game.snapshot();
  assert.equal(after.players[0].active.energy.length, 1); assert.equal(after.players[1].active.counters, 2);
  assert.equal(after.current, 1); assert.equal(after.turn, 6);
});

test('first player cannot attack or use a Supporter on turn one; card exception overrides attack only', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'base').mechanics.attacks[0].effects.push(
      binding('cn.attackPermissions@1', { permissions: ['first-turn-attack'] }));
  });
  const game = board(f, (s) => {
    fixtureClock(s, [0]);
    attached(s, 0, s.players[0].active, 'water'); hand(s, 0, 'research');
  });
  assert(game.view(0).legalActions.some((a) => a.type === 'attack'));
  assert(!game.view(0).legalActions.some((a) => a.type === 'playTrainer' && game.snapshot().cards[a.cardId].definitionId === 'research'));
  const ordinary = await fixture(), blocked = board(ordinary, (s) => {
    fixtureClock(s, [0]); attached(s, 0, s.players[0].active, 'water');
  });
  assert(!blocked.view(0).legalActions.some((a) => a.type === 'attack'));
});

test('evolution keeps attached cards/counters, clears conditions and cannot evolve again that turn', async () => {
  const f = await fixture(), game = board(f, (s) => {
    hand(s, 0, 'evolution'); attached(s, 0, s.players[0].active, 'water');
    s.players[0].active.counters = 3; s.players[0].active.conditions = applyCondition(s.players[0].active.conditions, 'poisoned').conditions;
  });
  const action = game.view(0).legalActions.find((a) => a.type === 'evolve'); assert(action);
  const before = game.snapshot().players[0].active;
  command(game, action);
  const after = game.snapshot().players[0].active;
  assert.equal(after.id, before.id); assert.equal(after.stack.length, 2); assert.equal(after.counters, 3);
  assert.deepEqual(after.energy, before.energy); assert.equal(after.conditions.poison, null);
  assert(!game.view(0).legalActions.some((a) => a.type === 'evolve'));
});

test('Retreat chooses whole Energy cards, no overpay, clears conditions, only once per turn', async () => {
  const f = await fixture(), game = board(f, (s) => {
    bench(s, 0, 'other'); attached(s, 0, s.players[0].active, 'water'); attached(s, 0, s.players[0].active, 'double');
    s.players[0].active.conditions = applyCondition(s.players[0].active.conditions, 'poisoned').conditions;
  });
  const before = game.snapshot(), oldId = before.players[0].active.id;
  command(game, { type: 'retreat' });
  const q = game.snapshot().pending;
  const double = q.options.find((id) => game.snapshot().cards[id].definitionId === 'double');
  assert.throws(() => answer(game, q.options), /Invalid Retreat payment/);
  answer(game, [double]); settle(game);
  const after = game.snapshot();
  assert.notEqual(after.players[0].active.id, oldId);
  const old = after.players[0].bench.find((m) => m.id === oldId);
  assert.equal(old.conditions.poison, null); assert.equal(old.energy.length, 1);
  assert(after.players[0].discard.includes(double));
  assert(!game.view(0).legalActions.some((a) => a.type === 'retreat'));
});

test('Supporter resolves before discarding itself; once per turn and draws as many as remain', async () => {
  const f = await fixture(), game = board(f, (s) => { hand(s, 0, 'research'); });
  const id = game.snapshot().players[0].hand.find((id) => game.snapshot().cards[id].definitionId === 'research');
  command(game, { type: 'playTrainer', cardId: id });
  const s = game.snapshot();
  assert.equal(s.players[0].hand.length, 7);
  assert(s.players[0].discard.includes(id)); assert.equal(s.players[0].resolving.length, 0);
  assert(s.players[0].flags.supporter);
});

test('Tool selection is resumable, cannot be replaced, and actually changes damage/HP', async () => {
  const f = await fixture(), game = board(f, (s) => {
    hand(s, 0, 'tool'); hand(s, 0, 'hp-tool'); attached(s, 0, s.players[0].active, 'water');
  });
  const id = game.snapshot().players[0].hand.find((id) => game.snapshot().cards[id].definitionId === 'tool');
  command(game, { type: 'playTrainer', cardId: id });
  assert.equal(game.snapshot().pending.kind, 'tool-target');
  const restored = OfficialGame.restore(JSON.parse(JSON.stringify(game.snapshot())), { catalog: f.catalog });
  settle(restored);
  assert(!restored.view(0).legalActions.some((a) => a.type === 'playTrainer' && restored.snapshot().cards[a.cardId].definitionId === 'hp-tool'));
  command(restored, restored.view(0).legalActions.find((a) => a.type === 'attack')); settle(restored);
  assert.equal(restored.snapshot().players[1].active.counters, 5);
});

test('Stadium replaces another name immediately, no same-name play and one Stadium per turn', async () => {
  const f = await fixture(), game = board(f, (s) => { hand(s, 0, 'stadium'); });
  const id = game.snapshot().players[0].hand.find((id) => game.snapshot().cards[id].definitionId === 'stadium');
  command(game, { type: 'playTrainer', cardId: id });
  assert.equal(game.snapshot().stadium, id);
  assert(game.snapshot().players[0].flags.stadium);
  assert(!game.snapshot().players[0].discard.includes(id));
});

test('same-time knockouts award all prizes before CN draw and next-player promotion', async () => {
  const f = await fixture();
  const game = board(f, (s) => {
    for (const p of s.players) p.active.counters = 10;
    bench(s, 0, 'other'); bench(s, 1, 'other');
  });
  // A legal non-ending action checks all board KOs at its resolution boundary.
  const energy = game.view(0).legalActions.find((a) => a.type === 'attachEnergy');
  assert(energy); command(game, energy);
  let promotionOrder = [];
  settle(game, (q) => { if (q.kind === 'promote') promotionOrder.push(q.player); return q.options.slice(0, q.minimum); });
  assert.deepEqual(promotionOrder, [1, 0]);
  assert(game.snapshot().players.every((p) => p.prizes.length === 5));
  assert.equal(game.snapshot().result, null);
  const drawGame = board(f, (s) => { for (const p of s.players) p.active.counters = 10; });
  command(drawGame, drawGame.view(0).legalActions.find((a) => a.type === 'attachEnergy')); settle(drawGame);
  assert.deepEqual(drawGame.snapshot().result, { winner: null, reason: 'simultaneous' });
});

test('CN I.E victory table: all 16 combinations, without international victory-condition counting', async () => {
  const f = await fixture();
  // Bits, in order: P0 finished Prizes, P1 finished Prizes, P0 no Pokémon,
  // P1 no Pokémon. Expected outcomes transcribed as a table, not computed by
  // the implementation's Boolean expression. null = draw, "continue" = no loss.
  const expected = ['continue', 0, 1, null, 1, null, 1, null, 0, 0, null, null, null, null, null, null];
  for (let row = 0; row < 16; row++) {
    const bits = [...row.toString(2).padStart(4, '0')].map(Number);
    const g = board(f, (s) => {
      for (let owner = 0; owner < 2; owner++) {
        const p = s.players[owner];
        if (bits[owner]) p.hand.push(...p.prizes.splice(0));
        if (bits[owner + 2]) {
          p.hand.push(...p.active.stack, ...p.active.energy, ...p.active.tools);
          p.active = null;
        }
      }
    });
    command(g, { type: 'endTurn' }); settle(g);
    if (expected[row] === 'continue') assert.equal(g.snapshot().result, null, `row ${row}`);
    else assert.deepEqual(g.snapshot().result,
      { winner: expected[row], reason: expected[row] === null ? 'simultaneous' : 'ordinary' }, `row ${row}`);
  }
});

test('attack effects use separate counter channel and KO waits for effect completion', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'base').mechanics.attacks[0].effects.push(
      binding('cn.counters@1', { side: 'opponent', target: 'active', count: 2 }));
  });
  const game = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); s.players[1].active.counters = 8; });
  command(game, game.view(0).legalActions.find((a) => a.type === 'attack'));
  assert.equal(game.snapshot().pending.kind, 'effect-target', 'Do not remove the target immediately after attack damage.');
  settle(game);
  assert.equal(game.snapshot().result.winner, 0);
});

test('CN up-to discard attach can choose three, cannot choose zero unless optional, and restores every choice', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'base').mechanics.attacks[0].effects.push(binding('cn.attachDiscard@1',
      { type: 'Water', count: 3, benchOnly: true, optional: false }));
  });
  let game = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water'); bench(s, 0, 'other');
    for (let i = 0; i < 3; i++) { const id = hand(s, 0, 'water'); s.players[0].hand.splice(s.players[0].hand.indexOf(id), 1); s.players[0].discard.push(id); }
  });
  command(game, game.view(0).legalActions.find((a) => a.type === 'attack'));
  assert.equal(game.snapshot().pending.kind, 'discard-energy');
  assert.throws(() => answer(game, []), /Invalid selection/);
  answer(game, game.snapshot().pending.options.slice(0, 3));
  while (game.snapshot().pending) {
    const original = game.snapshot();
    game = OfficialGame.restore(JSON.parse(JSON.stringify(game.snapshot())), { catalog: f.catalog });
    assert.deepEqual(game.snapshot(), original);
    answer(game, [game.snapshot().pending.options[0]]);
  }
  assert.equal(game.snapshot().players[0].bench[0].energy.length, 3);
});

test('condition checkup runs before next draw, paralysis survives the opponent turn', async () => {
  const f = await fixture(), game = board(f, (s) => {
    const m = s.players[0].active;
    m.conditions = applyCondition(m.conditions, 'paralyzed', { ownerTurn: s.players[0].turns }).conditions;
    m.conditions = applyCondition(m.conditions, 'poisoned', { poisonCounters: 2 }).conditions;
  });
  assert(!game.view(0).legalActions.some((a) => a.type === 'retreat' || a.type === 'attack'));
  command(game, { type: 'endTurn' }); settle(game);
  assert.equal(game.snapshot().players[0].active.conditions.rotation, 'paralyzed');
  command(game, { type: 'endTurn' }); settle(game);
  assert.equal(game.snapshot().players[0].active.counters, 4);
  command(game, { type: 'endTurn' }); settle(game);
  assert.equal(game.snapshot().players[0].active.conditions.rotation, null);
});

test('catalog/game snapshots bind exact versions and card conservation; rejected restores do not mutate input', async () => {
  const f = await fixture(), g = start(f), s = g.snapshot();
  const copies = [
    (x) => { x.catalogId = '0'.repeat(64); },
    (x) => { x.players[0].hand.push(x.players[0].deck[0]); },
    (x) => { x.rng = [0, 0, 0, 0]; },
    (x) => { x.ruleset.version = 'V20270101'; },
    (x) => { x.queue = [{ op: 'eval', data: {} }]; },
  ];
  for (const mutate of copies) {
    const bad = structuredClone(s); mutate(bad); const before = structuredClone(bad);
    assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }));
    assert.deepEqual(bad, before);
  }
  assert.throws(() => playerView(s, f.catalog, '0'), TypeError);
  const setup = new OfficialGame({ ruleset: RULESET, catalog: f.catalog, decks: [f.deck, f.deck], seed: f.seed }).snapshot();
  setup.pending.resume = 'unimplemented-or-forged-resume';
  assert.throws(() => OfficialGame.restore(setup, { catalog: f.catalog }), /Corrupt pending/);
  const dead = structuredClone(s); dead.phase = 'resolving';
  assert.throws(() => OfficialGame.restore(dead, { catalog: f.catalog }), /resumable player choice/);
});

test('two simultaneous games have no liveGame or global UID/RNG interference, and replay is exact', async () => {
  const f = await fixture(), a = start(f), b = start(f);
  assert.deepEqual(a.snapshot(), b.snapshot());
  const b0 = b.snapshot();
  command(a, { type: 'endTurn' }); settle(a);
  assert.deepEqual(b.snapshot(), b0);
  command(b, { type: 'endTurn' }); settle(b);
  assert.deepEqual(a.snapshot(), b.snapshot());
  const restored = OfficialGame.restore(JSON.parse(JSON.stringify(a.snapshot())), { catalog: f.catalog });
  command(a, { type: 'endTurn' }); command(restored, { type: 'endTurn' });
  settle(a); settle(restored);
  assert.deepEqual(a.snapshot(), restored.snapshot());
});

test('complete seeded games terminate through actual rule conditions; all choices may be saved/restored', async () => {
  const f = await fixture();
  for (let seed = 1; seed <= 6; seed++) {
    let g = start(f, [seed, 9, 8, 7]);
    for (let turn = 0; !g.snapshot().result; turn++) {
      assert(turn < 500, 'Test termination guard is not an engine turn limit.');
      const actions = g.view(g.snapshot().current).legalActions;
      const act = actions.find((a) => a.type === 'attachEnergy' && a.pokemonId === g.snapshot().players[g.snapshot().current].active.id) ||
        actions.find((a) => a.type === 'attack') || actions.find((a) => a.type === 'bench') || { type: 'endTurn' };
      command(g, act);
      while (g.snapshot().pending) {
        const saved = g.snapshot();
        g = OfficialGame.restore(JSON.parse(JSON.stringify(saved)), { catalog: f.catalog });
        assert.deepEqual(g.snapshot(), saved);
        answer(g, g.snapshot().pending.allowZero ? [] : g.snapshot().pending.options.slice(0, g.snapshot().pending.minimum));
      }
    }
    assertGameState(g.snapshot(), f.catalog);
    assert(g.snapshot().events.every((e) => e.ruleId));
  }
});

test('Ability usage is explicit: unlimited, twice per turn, shared, per game and VSTAR', async () => {
  const ability = (id, usage) => ({ abilityId: id, name: `测试${id}`, mode: 'activated', usage,
    effects: [binding('cn.draw@1', { count: 1 }, id)], sourceOfTruth: EVIDENCE });
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'base').mechanics.abilities = [
      ability('unlimited', { period: 'unlimited', scope: 'pokemon', key: 'unlimited', limit: null }),
      ability('twice', { period: 'turn', scope: 'pokemon', key: 'twice', limit: 2 }),
      ability('shared', { period: 'turn', scope: 'player', key: 'shared', limit: 1 }),
      { ...ability('star', { period: 'game', scope: 'player', key: 'star', limit: 1 }), specialRule: 'VSTAR' },
    ];
  });
  const g = board(f, (s) => bench(s, 0, 'base'));
  const use = (id, pokemonId = g.snapshot().players[0].active.id) =>
    command(g, { type: 'useAbility', pokemonId, abilityId: id });
  use('unlimited'); use('unlimited'); use('unlimited');
  assert(g.view(0).legalActions.some((a) => a.abilityId === 'unlimited'));
  use('twice'); use('twice');
  assert(!g.view(0).legalActions.some((a) => a.abilityId === 'twice' && a.pokemonId === g.snapshot().players[0].active.id));
  use('shared');
  assert(!g.view(0).legalActions.some((a) => a.abilityId === 'shared'));
  use('star');
  assert(g.snapshot().players[0].vstarUsed);
  assert(!g.view(0).legalActions.some((a) => a.abilityId === 'star'));
  command(g, { type: 'endTurn' }); settle(g); command(g, { type: 'endTurn' }); settle(g);
  assert(g.view(0).legalActions.some((a) => a.abilityId === 'twice'));
  assert(g.view(0).legalActions.some((a) => a.abilityId === 'shared'));
  assert(!g.view(0).legalActions.some((a) => a.abilityId === 'star'));
});

test('confusion-failed GX is not consumed and successful GX is once per game', async () => {
  const f = await fixture((defs) => { defs[0].mechanics.attacks[0].specialRule = 'GX'; });
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water'); s.rng = [1, 33554432, 2, 3];
    s.players[0].active.conditions = applyCondition(s.players[0].active.conditions, 'confused').conditions;
  });
  command(g, g.view(0).legalActions.find((a) => a.type === 'attack')); settle(g);
  assert.equal(g.snapshot().players[0].active.counters, 3);
  assert(!g.snapshot().players[0].gxUsed);
  assert.equal(g.snapshot().players[1].active.counters, 0);
  const success = board(f, (s) => attached(s, 0, s.players[0].active, 'water'));
  command(success, success.view(0).legalActions.find((a) => a.type === 'attack')); settle(success);
  assert(success.snapshot().players[0].gxUsed);
  command(success, { type: 'endTurn' }); settle(success);
  assert(!success.view(0).legalActions.some((a) => a.type === 'attack'));
});

test('granted Tool attacks are usable but never replace the printed attack identity', async () => {
  const f = await fixture((defs) => {
    const tool = defs.find((d) => d.definitionId === 'tool');
    tool.mechanics.effects = [];
    tool.mechanics.grantedAttacks = [{ attackId: 'tm:attack', name: '测试学习器招式', cost: ['Water'],
      printedDamage: { value: 50, operator: 'fixed' }, effects: [], sourceOfTruth: EVIDENCE }];
  });
  const g = board(f, (s) => { hand(s, 0, 'tool'); attached(s, 0, s.players[0].active, 'water'); });
  command(g, g.view(0).legalActions.find((a) => a.type === 'playTrainer' && g.snapshot().cards[a.cardId].definitionId === 'tool')); settle(g);
  assert(g.view(0).legalActions.some((a) => a.attackId === 'base:strike'));
  assert(g.view(0).legalActions.some((a) => a.attackId === 'tm:attack'));
  command(g, { type: 'attack', attackId: 'tm:attack' }); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 5);
  assert.equal(g.snapshot().players[0].active.facts.lastUsedAttack.attackId, 'tm:attack');
});

test('before-damage switching does not change which Pokémon declared and executes the attack', async () => {
  const h = { rulesetId: 'CN/V20261019', timing: 'beforeDamage', sourceOfTruth: EVIDENCE,
    operations: ['switch'],
    validateParameters: (p) => Object.keys(p).length === 0,
    execute: () => [{ op: 'switch', side: 'own' }] };
  const f = await fixture((defs) => defs[0].mechanics.attacks[0].effects.push(binding('fixture:before-switch', {})),
    new Map([['fixture:before-switch', h]]));
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); bench(s, 0, 'other'); });
  const attacker = g.snapshot().players[0].active.id;
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  assert.notEqual(g.snapshot().players[0].active.id, attacker);
  assert.equal(g.snapshot().players[1].active.counters, 2);
  assert.equal(g.snapshot().players[0].bench.find((m) => m.id === attacker).facts.lastUsedAttack.attackId, 'base:strike');
});

test('reviewed actual formula is used, with explicit rejection rather than plain-damage fallback', async () => {
  const h = { rulesetId: 'CN/V20261019', timing: 'formula', sourceOfTruth: EVIDENCE,
    operations: [],
    capabilities: ['resolve-attack-damage'], validateParameters: (p) => Object.keys(p).length === 0,
    execute: () => [], damageFormula: () => 60 };
  const f = await fixture((defs) => {
    defs[0].mechanics.attacks[0].printedDamage.operator = 'times';
    defs[0].mechanics.attacks[0].effects.push(binding('fixture:formula', {}));
  }, new Map([['fixture:formula', h]]));
  const g = board(f, (s) => attached(s, 0, s.players[0].active, 'water'));
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 6);
});

test('short deck draws, deckout, concede, terminal commands and one-Prize tiebreak are distinct', async () => {
  const f = await fixture(), g = board(f, (s) => {
    const p = s.players[1]; p.hand.push(...p.deck.splice(0));
  });
  command(g, { type: 'endTurn' }); settle(g);
  assert.deepEqual(g.snapshot().result, { winner: 0, reason: 'deckout' });
  assert.throws(() => command(g, { type: 'concede' }, 0), /ended/);
  const conceding = start(f);
  command(conceding, { type: 'concede' }, 0);
  assert.deepEqual(conceding.snapshot().result, { winner: 1, reason: 'concede' });
  const tie = new OfficialGame({ ruleset: RULESET, catalog: f.catalog, decks: [f.deck, f.deck], seed: f.seed, format: 'tiebreak60' });
  settle(tie);
  assert(tie.snapshot().players.every((p) => p.prizes.length === 1));
  assert.throws(() => new OfficialGame({ catalog: f.catalog, decks: [f.deck, f.deck], seed: f.seed }), /Unsupported ruleset/);
  assert.throws(() => createGameState({ ruleset: RULESET, catalog: f.catalog, decks: [f.deck], seed: f.seed }), /Two decks/);
  assert.throws(() => createGameState({ ruleset: RULESET, catalog: f.catalog, decks: [f.deck, f.deck], seed: f.seed, format: 'standard' }), /format/);
});

test('healing requires an actually damaged target and condition Items resolve without spending Energy', async () => {
  const f = await fixture(), g = board(f, (s) => { hand(s, 0, 'potion'); hand(s, 0, 'poison'); s.players[0].active.counters = 4; });
  const potion = g.view(0).legalActions.find((a) => a.type === 'playTrainer' && g.snapshot().cards[a.cardId].definitionId === 'potion');
  command(g, potion); settle(g);
  assert.equal(g.snapshot().players[0].active.counters, 1);
  assert.equal(g.snapshot().players[0].active.facts.healedTurn, g.snapshot().turn);
  command(g, g.view(0).legalActions.find((a) => a.type === 'playTrainer' && g.snapshot().cards[a.cardId].definitionId === 'poison')); settle(g);
  assert.equal(g.snapshot().players[1].active.conditions.poison, 4);
  assert(!g.snapshot().players[0].flags.energy);
});

test('non-JSON and corrupt structural snapshots are rejected, with no silent type coercion', async () => {
  const f = await fixture(), s = start(f).snapshot();
  for (const mutate of [
    (x) => { x.unexpected = 1; }, (x) => { x.serial = '1'; },
    (x) => { x.ongoing = [{ invalid: undefined }]; }, (x) => { x.ongoing = [() => true]; },
    (x) => { x.ongoing = [x]; }, (x) => { x.players[0].active.enteredTurn = x.turn + 1; },
    (x) => { x.players[0].bench.push(structuredClone(x.players[0].active)); },
    (x) => { x.result = { winner: 0, reason: 'corrupt' }; },
    (x) => { x.cards[x.players[0].hand[0]].definitionId = 'wrong'; },
    (x) => { const a = x.players[0].hand.pop(), b = x.players[1].hand.pop(); x.players[0].hand.push(b); x.players[1].hand.push(a); },
  ]) {
    const bad = structuredClone(s); mutate(bad);
    assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }));
  }
});

test('effect draws from a short deck take the remainder and do not cause immediate deckout', async () => {
  const f = await fixture(), g = board(f, (s) => {
    hand(s, 0, 'research');
    const p = s.players[0]; p.discard.push(...p.deck.splice(0, p.deck.length - 3));
  });
  const id = g.snapshot().players[0].hand.find((id) => g.snapshot().cards[id].definitionId === 'research');
  command(g, { type: 'playTrainer', cardId: id });
  assert.equal(g.snapshot().players[0].hand.length, 3);
  assert.equal(g.snapshot().players[0].deck.length, 0);
  assert.equal(g.snapshot().result, null);
  command(g, { type: 'endTurn' }); settle(g); command(g, { type: 'endTurn' }); settle(g);
  assert.deepEqual(g.snapshot().result, { winner: 1, reason: 'deckout' });
});

test('developing engine rejects undescribed triggers and undeclared operations', async () => {
  await assert.rejects(fixture((defs) => {
    defs[0].mechanics.abilities = [{ abilityId: 'trigger', name: '尚未实现的触发', mode: 'triggered', usage: null,
      effects: [binding('cn.draw@1', { count: 1 })], sourceOfTruth: EVIDENCE }];
  }), /explicit trigger descriptor/);
  const h = { rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE, operations: ['not-implemented'],
    validateParameters: (p) => Object.keys(p).length === 0, execute: () => [] };
  const unsupported = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'research').mechanics.effects = [binding('fixture:unsupported', {})];
  }, new Map([['fixture:unsupported', h]]));
  assert.throws(() => start(unsupported), /Unimplemented or undeclared/);
});

test('unknown parameters in handler-generated programs reject the entire transaction', async () => {
  const h = { rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE, operations: ['draw'],
    validateParameters: (p) => Object.keys(p).length === 0,
    execute: () => [{ op: 'draw', count: 1, unimplementedClause: true }] };
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'research').mechanics.effects = [binding('fixture:bad-program', {})];
  }, new Map([['fixture:bad-program', h]]));
  const g = board(f, (s) => hand(s, 0, 'research')), before = g.snapshot();
  const id = before.players[0].hand.find((id) => before.cards[id].definitionId === 'research');
  assert.throws(() => command(g, { type: 'playTrainer', cardId: id }), /No silent fallback/);
  assert.deepEqual(g.snapshot(), before);
});

test('public developing-engine entry point exposes explicit versioned APIs, not the legacy Game', async () => {
  const api = await import('../../public/rules/engine.js');
  assert.equal(api.OfficialGame, OfficialGame);
  assert.equal(api.getRuleset(RULESET).id, 'CN/V20261019');
  assert.equal(api.listRulesets().length, 1);
  assert.equal(typeof api.createCardCatalog, 'function');
  assert.equal(typeof api.createCoreHandlers, 'function');
});

test('snapshot object aliasing cannot change JSON replay semantics or the other player flags', async () => {
  const f = await fixture(), g = board(f), s = g.snapshot();
  s.players[1].flags = s.players[0].flags;
  const fromObjects = OfficialGame.restore(s, { catalog: f.catalog });
  const fromJSON = OfficialGame.restore(JSON.parse(JSON.stringify(s)), { catalog: f.catalog });
  const action = fromObjects.view(0).legalActions.find((a) => a.type === 'attachEnergy');
  command(fromObjects, action); command(fromJSON, action);
  assert.deepEqual(fromObjects.snapshot(), fromJSON.snapshot());
  assert(!fromObjects.snapshot().players[1].flags.energy);
});
