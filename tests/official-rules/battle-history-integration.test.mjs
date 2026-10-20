import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, EngineError } from '../../public/rules/game.js';
import {
  createBattleHistory, assertBattleHistory, previousOpponentTurn,
  hadKnockoutInPreviousOpponentTurn, wasMovedFromBenchToActiveThisTurn,
  wasSupporterPlayedFromHandThisTurn, wasHealedThisTurn,
} from '../../public/rules/battle-history.js';
import { fixture, binding, EVIDENCE, board, command, answer, hand, attached, bench } from './fixtures.mjs';

// Integration tests use real dispatch boundaries. Only board() supplies the
// explicitly synthetic opening ledger [0,1,0,1,0]; no test fabricates an extra
// runtime turn or treats turn-1 as an oracle for "previous opponent turn".
const clock = (s) => ({ turn: s.turn, during: s.current });
const events = (s, kind) => s.battleHistory.events.filter((event) => event.kind === kind);
const restore = (snapshot, f) => OfficialGame.restore(JSON.parse(JSON.stringify(snapshot)), { catalog: f.catalog });
const descriptor = (event) => ({
  event, subject: 'self', optional: false, choiceOwner: 'source', scope: 'subject',
});
const activated = (id, effects) => ({
  abilityId: id, name: `测试历史特性${id}`, mode: 'activated',
  usage: { period: 'unlimited', scope: 'pokemon', key: id, limit: null },
  effects, sourceOfTruth: EVIDENCE,
});
const policy = (q) => q.allowZero ? [] : q.options.slice(0, q.minimum);

/** Check a JSON restore at every actual choice, including unfinished KO work. */
function settleRestoring(game, f, choose = policy) {
  for (let guard = 0; game.snapshot().pending; guard++) {
    assert(guard < 200, 'Test choice guard, not an engine timing/turn limit.');
    const before = game.snapshot(), restored = restore(before, f);
    assert.deepEqual(restored.snapshot(), before);
    const selected = choose(before.pending, before);
    answer(game, selected); answer(restored, selected);
    assert.deepEqual(restored.snapshot(), game.snapshot(), 'The same committed choice survives a JSON round trip.');
  }
  const s = game.snapshot();
  assertBattleHistory(s.battleHistory, clock(s));
  return s;
}

function assertNoLegacyPlayerHistory(s) {
  for (const player of s.players)
    assert.equal(Object.hasOwn(player, 'history'), false, 'The root ledger is the sole authoritative battle history.');
}

function assertPreviousKO(s, { owner, any, attackDamage, attacker }) {
  const before = JSON.stringify(s);
  assert.equal(hadKnockoutInPreviousOpponentTurn(s.battleHistory, clock(s), { owner }), any);
  assert.equal(hadKnockoutInPreviousOpponentTurn(s.battleHistory, clock(s), { owner, cause: 'any' }), any);
  assert.equal(hadKnockoutInPreviousOpponentTurn(s.battleHistory, clock(s), { owner, cause: 'attackDamage' }), attackDamage);
  if (attacker !== undefined)
    assert.equal(hadKnockoutInPreviousOpponentTurn(s.battleHistory, clock(s),
      { owner, cause: 'attackDamage', attacker }), attackDamage);
  assert.equal(JSON.stringify(s), before, 'Queries must not mutate the private snapshot or root ledger.');
}

test('runtime initializes one empty root history, excludes setup placement facts, and appends real start-turn records', async () => {
  const f = await fixture(), g = new OfficialGame({
    ruleset: f.ruleset, catalog: f.catalog, decks: [f.deck, f.deck], seed: f.seed,
  });
  const setup = g.snapshot();
  assert.equal(setup.turn, 0); assert.equal(setup.current, null);
  assert.deepEqual(setup.battleHistory, createBattleHistory());
  assertNoLegacyPlayerHistory(setup);
  const first = settleRestoring(g, f);
  assert.deepEqual(first.battleHistory.turns, [{ turn: first.turn, player: first.first }]);
  assert.equal(first.current, first.first);
  assert.deepEqual(first.battleHistory.events, [], 'Setup Active placement is not a Bench-to-Active action in a player turn.');
  const endingTurn = first.battleHistory.turns.at(-1);
  command(g, { type: 'endTurn' });
  const next = settleRestoring(g, f);
  assert.deepEqual(next.battleHistory.turns, [
    endingTurn, { turn: next.turn, player: next.current },
  ]);
  assert.equal(next.current, 1 - endingTurn.player);
  assert.deepEqual(previousOpponentTurn(next.battleHistory, clock(next), next.current), endingTurn);
  assert.deepEqual(next.battleHistory.events, []);
  assertNoLegacyPlayerHistory(next);
});

test('runtime attack-damage and attack-effect KOs retain distinct real causes and satisfy different E-11 filters', async () => {
  for (const attackingPlayer of [0, 1]) for (const kind of ['attackDamage', 'effect']) {
    const defendingPlayer = 1 - attackingPlayer;
    const f = await fixture((defs) => {
      if (kind === 'effect') {
        defs[0].mechanics.attacks[0].printedDamage = null;
        defs[0].mechanics.attacks[0].effects = [
          binding('cn.counters@1', { side: 'opponent', target: 'active', count: 10 }, 'history-effect-ko'),
        ];
      }
    });
    const g = board(f, (s) => {
      attached(s, attackingPlayer, s.players[attackingPlayer].active, 'water');
      s.players[defendingPlayer].active.counters = kind === 'attackDamage' ? 8 : 0;
      bench(s, defendingPlayer, 'other');
    });
    assert.deepEqual(g.snapshot().battleHistory.turns.map((t) => t.player), [0, 1, 0, 1, 0]);
    if (attackingPlayer === 1) {
      command(g, { type: 'endTurn' }); settleRestoring(g, f);
    }
    const before = g.snapshot(), attacker = before.players[attackingPlayer].active, victim = before.players[defendingPlayer].active;
    assert.equal(before.current, attackingPlayer);
    assert.deepEqual(before.battleHistory.events, []);
    const actualAttackingTurn = before.battleHistory.turns.at(-1);
    command(g, { type: 'attack', attackId: 'base:strike' });
    const after = settleRestoring(g, f), [record] = events(after, 'ko');
    assert.equal(events(after, 'ko').length, 1);
    assert.equal(record.turn, actualAttackingTurn.turn); assert.equal(record.during, actualAttackingTurn.player);
    assert.equal(record.owner, defendingPlayer); assert.equal(record.pokemonId, victim.id);
    assert.equal(record.cause.kind, kind);
    assert.equal(record.cause.source.owner, attackingPlayer);
    assert.equal(record.cause.source.cardOwner, attackingPlayer);
    assert.equal(after.cards[record.cause.source.instanceId].owner, attackingPlayer);
    assert.equal(record.cause.source.instanceId, attacker.stack.at(-1));
    assert.equal(record.cause.source.pokemonId, attacker.id);
    assert.equal(record.cause.source.category, 'attack'); assert.equal(record.cause.source.attackId, 'base:strike');
    assert.deepEqual(record.cause.source.sourceOfTruth, EVIDENCE);
    assert(after.players[defendingPlayer].discard.includes(victim.stack.at(-1)));
    assert.equal(after.current, defendingPlayer);
    assert.deepEqual(previousOpponentTurn(after.battleHistory, clock(after), defendingPlayer), actualAttackingTurn);
    assertPreviousKO(after, { owner: defendingPlayer, any: true, attackDamage: kind === 'attackDamage', attacker: attackingPlayer });
    assert.equal(hadKnockoutInPreviousOpponentTurn(after.battleHistory, clock(after),
      { owner: defendingPlayer, cause: 'attackDamage', attacker: defendingPlayer }), false);
    assertNoLegacyPlayerHistory(after);
    const promotion = events(after, 'benchToActive').find((event) => event.pokemonId === after.players[defendingPlayer].active.id);
    assert(promotion, 'KO promotion from Bench emits its own real movement fact.');
    assert.equal(promotion.turn, actualAttackingTurn.turn); assert.equal(promotion.during, attackingPlayer);
    assert.equal(wasMovedFromBenchToActiveThisTurn(after.battleHistory, clock(after), defendingPlayer, promotion.pokemonId), false,
      'Promotion in the opposing turn is not a movement during the newly started own turn.');
    const reusedIdentity = structuredClone(after);
    reusedIdentity.players[defendingPlayer].active.id = victim.id;
    assert.throws(() => restore(reusedIdentity, f),
      (error) => error instanceof EngineError && error.code === 'invalid-history-source',
      'A live Pokémon cannot reuse a Knocked Out battle identity, even when its physical card holder is unchanged.');
  }
});

test('Poison/checkup KO and its promotion remain during:null and do not satisfy previous-opponent-turn E-11', async () => {
  const f = await fixture(), g = board(f, (s) => {
    s.players[1].active.counters = 9; s.players[1].active.conditions.poison = 1;
    bench(s, 1, 'other');
  });
  const before = g.snapshot(), endedTurn = before.battleHistory.turns.at(-1), victim = before.players[1].active.id;
  command(g, { type: 'endTurn' });
  const after = settleRestoring(g, f), [record] = events(after, 'ko');
  assert.equal(events(after, 'ko').length, 1);
  assert.equal(record.turn, endedTurn.turn); assert.equal(record.during, null);
  assert.equal(record.owner, 1); assert.equal(record.pokemonId, victim);
  assert.deepEqual(record.cause, { kind: 'checkup', source: null });
  assert.equal(after.current, 1);
  assert.deepEqual(previousOpponentTurn(after.battleHistory, clock(after), 1), endedTurn);
  assertPreviousKO(after, { owner: 1, any: false, attackDamage: false, attacker: 0 });
  const [promotion] = events(after, 'benchToActive');
  assert.equal(promotion.owner, 1); assert.equal(promotion.during, null); assert.equal(promotion.turn, endedTurn.turn);
  assert.equal(wasMovedFromBenchToActiveThisTurn(after.battleHistory, clock(after), 1, promotion.pokemonId), false);
});

test('a real card effect during checkup retains its source but is still not an opposing-turn KO', async () => {
  const f = await fixture((defs) => defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [{
    ...binding('cn.counters@1', { side: 'opponent', target: 'event', count: 1 }, 'history-checkup-effect'),
    trigger: { ...descriptor('checkup'), subject: 'opponent' },
  }]);
  let stadiumId;
  const g = board(f, (s) => {
    stadiumId = hand(s, 0, 'stadium'); s.players[1].active.counters = 9; bench(s, 1, 'other');
  });
  const victim = g.snapshot().players[1].active.id;
  command(g, { type: 'playTrainer', cardId: stadiumId }); settleRestoring(g, f);
  const ending = g.snapshot().battleHistory.turns.at(-1);
  command(g, { type: 'endTurn' });
  const after = settleRestoring(g, f), [record] = events(after, 'ko');
  assert.equal(events(after, 'ko').length, 1);
  assert.equal(record.turn, ending.turn); assert.equal(record.during, null);
  assert.equal(record.pokemonId, victim); assert.equal(record.owner, 1);
  assert.equal(record.cause.kind, 'effect', 'Checkup is the timing boundary, not a replacement for a card effect cause.');
  assert.equal(record.cause.source.instanceId, stadiumId);
  assert.equal(record.cause.source.category, 'trainer'); assert.equal(record.cause.source.owner, 0);
  assert.equal(record.cause.source.origin, 'field');
  assertPreviousKO(after, { owner: 1, any: false, attackDamage: false, attacker: 0 });
});

test('multiple real KOs in the same opposing turn produce separate records but E-11 remains a boolean', async () => {
  const f = await fixture((defs) => defs[0].mechanics.attacks[0].effects = [
    binding('cn.counters@1', { side: 'opponent', target: 'bench', count: 10 }, 'history-second-ko'),
  ]);
  let benchVictim;
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water'); s.players[1].active.counters = 8;
    benchVictim = bench(s, 1, 'other').id; bench(s, 1, 'other');
  });
  const before = g.snapshot(), activeVictim = before.players[1].active.id, actualTurn = before.battleHistory.turns.at(-1);
  command(g, { type: 'attack', attackId: 'base:strike' });
  const after = settleRestoring(g, f, (q) => {
    if (q.kind !== 'effect-target') return policy(q);
    assert(q.options.includes(benchVictim));
    assert(!q.options.includes(activeVictim), 'A Bench-only counter effect cannot target the lethally damaged Active.');
    return [benchVictim];
  });
  const records = events(after, 'ko');
  assert.equal(records.length, 2);
  assert.deepEqual(new Set(records.map((event) => event.pokemonId)), new Set([activeVictim, benchVictim]));
  assert(records.every((event) => event.turn === actualTurn.turn && event.during === actualTurn.player && event.owner === 1));
  assert.equal(records.find((event) => event.pokemonId === activeVictim).cause.kind, 'attackDamage');
  assert.equal(records.find((event) => event.pokemonId === benchVictim).cause.kind, 'effect');
  assert.equal(after.players[0].prizes.length, before.players[0].prizes.length - 2);
  assertPreviousKO(after, { owner: 1, any: true, attackDamage: true, attacker: 0 });
  assert.equal(typeof hadKnockoutInPreviousOpponentTurn(after.battleHistory, clock(after), { owner: 1 }), 'boolean');
});

test('loss of a continuous maximum-HP source records the later chain KO as rule, not stale attack damage', async () => {
  const f = await fixture((defs) => defs[0].mechanics.abilities = [{
    abilityId: 'history-hp-provider', name: '测试全队HP来源', mode: 'continuous', usage: null,
    effects: [binding('cn.modifier@1', { field: 'hp', amount: 50, scope: 'own' }, 'history-hp-provider')],
    sourceOfTruth: EVIDENCE,
  }]);
  let fragile;
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water'); s.players[1].active.counters = 13;
    const other = bench(s, 1, 'other'); other.counters = 12; fragile = other.id;
    bench(s, 1, 'other');
  });
  const before = g.snapshot(), provider = before.players[1].active.id;
  assert.equal(g.view(0).players[1].active.effective.maxHp, 150);
  assert.equal(g.view(0).players[1].bench.find((m) => m.id === fragile).effective.maxHp, 150);
  command(g, { type: 'attack', attackId: 'base:strike' });
  const after = settleRestoring(g, f), records = events(after, 'ko');
  assert.equal(records.length, 2);
  assert.equal(records.find((event) => event.pokemonId === provider).cause.kind, 'attackDamage');
  const chain = records.find((event) => event.pokemonId === fragile);
  assert.deepEqual(chain.cause, { kind: 'rule', source: null });
  assert.equal(chain.turn, before.turn); assert.equal(chain.during, before.current); assert.equal(chain.owner, 1);
  assert.equal(after.result, null, 'A surviving backup prevents this test from ending before the next actual turn.');
  assertPreviousKO(after, { owner: 1, any: true, attackDamage: true, attacker: 0 });
});

test('a KO-trigger heal is recorded before KO commit but cannot replace the already latched attack cause', async () => {
  const f = await fixture((defs) => defs.find((d) => d.definitionId === 'base').mechanics.abilities = [{
    abilityId: 'history-ko-heal', name: '测试昏厥时回复', mode: 'triggered', usage: null,
    // Subject-local healing resolves automatically. This real optional-use
    // choice pauses after the KO lock but before accepting/executing recovery.
    trigger: { ...descriptor('knockout'), optional: true },
    effects: [binding('cn.heal@1', { target: 'event', amount: 30 }, 'history-ko-heal')],
    sourceOfTruth: EVIDENCE,
  }]);
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water'); s.players[1].active.counters = 8;
    bench(s, 1, 'other');
  });
  const before = g.snapshot(), victim = before.players[1].active.id;
  assert.equal(before.cards[before.players[1].active.stack.at(-1)].definitionId, 'base');
  assert(f.catalog.definition('base').mechanics.abilities.some((ability) => ability.abilityId === 'history-ko-heal'));
  command(g, { type: 'attack', attackId: 'base:strike' });
  const pending = g.snapshot();
  assert.equal(pending.pending.kind, 'trigger-optional');
  assert.deepEqual(events(pending, 'ko'), [], 'The KO event commits at discard, not at its earlier locking boundary.');
  const batch = pending.queue.flatMap((task) => task.data.batch ?? []);
  const locked = batch.find((item) => item.id === victim);
  assert(locked, 'The pending KO retains its original causal lock across trigger choices.');
  assert.equal(locked.turn, before.turn); assert.equal(locked.during, before.current);
  assert.equal(locked.cause.kind, 'attackDamage');
  assert.equal(locked.topCardId, before.players[1].active.stack.at(-1));
  assert.equal(typeof locked.receiptId, 'string'); assert(locked.receiptId.length > 0);
  const journal = pending.events.filter((entry) => entry.ruleId === 'ko.boundary' &&
    entry.data.kind === 'latched' && entry.data.id === locked.receiptId);
  assert.equal(journal.length, 1, 'The original KO lock has one stable private journal receipt.');
  assert.deepEqual(journal[0].data.item, locked);
  const lockedCause = structuredClone(locked.cause);
  for (const [label, mutate] of [
    ['future lock turn', (item, s) => { item.turn = s.turn + 1; }],
    ['another valid past turn is not this lock boundary', (item, s) => {
      item.turn = s.battleHistory.turns.find((turn) => turn.player === item.during && turn.turn < item.turn).turn;
    }],
    ['changed during boundary', (item) => { item.during = null; }],
    ['missing locked source', (item) => { item.cause.source.instanceId = 'missing-locked-source'; }],
    ['structurally valid replacement cause', (item) => { item.cause = { kind: 'rule', source: null }; }],
    ['changed Prize award', (item) => { item.prizes++; }],
    ['another actual owned top card is not this KO', (item, s) => {
      item.topCardId = s.players[1].bench[0].stack.at(-1);
    }],
    ['changed lock receipt', (item) => { item.receiptId = 'missing-ko-history-receipt'; }],
  ]) {
    const invalid = structuredClone(pending);
    const item = invalid.queue.find((task) => task.data.batch?.some((entry) => entry.id === victim))
      .data.batch.find((entry) => entry.id === victim);
    mutate(item, invalid);
    assert.throws(() => restore(invalid, f),
      (error) => error instanceof EngineError && error.code === 'invalid-ko-history',
      `A restored pending KO must reject ${label} against its saved causal lock.`);
    assert.deepEqual(g.snapshot(), pending, 'Rejected external lock corruption cannot change the pending live choice.');
  }
  for (const [label, mutate] of [
    ['duplicate batch entry for the same victim', (s, index) => {
      const task = s.queue[index];
      task.data.batch.push(structuredClone(task.data.batch.find((item) => item.id === victim)));
    }],
    ['start-turn inserted before the latched batch', (s, index) => {
      s.queue.splice(index, 0, { op: 'start-turn', data: { player: 1 - before.current } });
    }],
    ['checkup inserted before the latched batch', (s, index) => {
      s.queue.splice(index, 0, { op: 'checkup', data: { player: before.current } });
    }],
  ]) {
    const invalid = structuredClone(pending);
    const index = invalid.queue.findIndex((task) => task.data.batch?.some((item) => item.id === victim));
    assert(index >= 0);
    mutate(invalid, index);
    assert.throws(() => restore(invalid, f),
      (error) => error instanceof EngineError && error.code === 'invalid-ko-history',
      `Restore must immediately reject ${label}, without waiting for the next player answer.`);
    assert.deepEqual(g.snapshot(), pending);
  }
  const after = settleRestoring(g, f, (q) => q.kind === 'trigger-optional' ? ['perform'] : policy(q));
  const healing = events(after, 'heal').find((event) => event.pokemonId === victim);
  const knockout = events(after, 'ko').find((event) => event.pokemonId === victim);
  assert(healing); assert(knockout);
  assert.equal(healing.amount, 30); assert.equal(healing.owner, 1); assert.equal(healing.during, 0);
  assert(after.battleHistory.events.indexOf(healing) < after.battleHistory.events.indexOf(knockout));
  assert.deepEqual(knockout.cause, lockedCause);
  assert.equal(knockout.turn, locked.turn); assert.equal(knockout.during, locked.during);
  assertPreviousKO(after, { owner: 1, any: true, attackDamage: true, attacker: 0 });
});

test('Hand Supporter fact commits before resolution/discard and is not inferred from flags or discarded cards', async () => {
  const f = await fixture((defs) => defs.find((d) => d.definitionId === 'research').mechanics.effects = [
    binding('cn.heal@1', { target: 'active', amount: 30 }, 'history-supporter-heal'),
  ]);
  const decoy = board(f, (s) => {
    const cardId = hand(s, 0, 'research'); s.players[0].hand.splice(s.players[0].hand.indexOf(cardId), 1);
    s.players[0].discard.push(cardId); s.players[0].flags.supporter = true;
  }).snapshot();
  assert(decoy.players[0].flags.supporter);
  assert(decoy.players[0].discard.some((id) => decoy.cards[id].definitionId === 'research'));
  assert.deepEqual(decoy.battleHistory.events, []);
  assert.equal(wasSupporterPlayedFromHandThisTurn(decoy.battleHistory, clock(decoy), 0), false);
  let supporterId;
  const g = board(f, (s) => { supporterId = hand(s, 0, 'research'); s.players[0].active.counters = 2; });
  command(g, { type: 'playTrainer', cardId: supporterId });
  const pending = g.snapshot(), [played] = events(pending, 'supporterPlayed');
  assert.equal(pending.pending.kind, 'effect-target');
  assert(pending.players[0].resolving.includes(supporterId)); assert(!pending.players[0].discard.includes(supporterId));
  assert.deepEqual(played, {
    kind: 'supporterPlayed', turn: pending.turn, during: 0, owner: 0, cardId: supporterId, origin: 'hand',
  });
  assert.equal(wasSupporterPlayedFromHandThisTurn(pending.battleHistory, clock(pending), 0), true);
  const after = settleRestoring(g, f);
  assert(after.players[0].discard.includes(supporterId));
  assert.deepEqual(events(after, 'supporterPlayed'), [played], 'Resolution does not append a duplicate play fact.');
  assert.equal(wasSupporterPlayedFromHandThisTurn(after.battleHistory, clock(after), 0), true);
  for (const replacement of [
    'missing-supporter-card',
    Object.values(after.cards).find((card) => card.owner === 1 && card.definitionId === 'research').instanceId,
  ]) {
    const bad = structuredClone(after); events(bad, 'supporterPlayed')[0].cardId = replacement;
    assert.throws(() => restore(bad, f), 'History Supporter IDs must still refer to a real card owned by its actual player.');
  }
  command(g, { type: 'endTurn' }); settleRestoring(g, f);
  command(g, { type: 'endTurn' });
  const later = settleRestoring(g, f);
  assert.equal(later.current, 0);
  assert.equal(wasSupporterPlayedFromHandThisTurn(later.battleHistory, clock(later), 0), false);
});

test('actual healing is capped by removed counters, zero recovery is not recorded, and Bench cycling retains E24/E26 facts', async () => {
  const switchHandler = {
    rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE, operations: ['switch'],
    validateParameters: (p) => Object.keys(p).length === 0,
    canUse: (ctx) => ctx.state.players[ctx.source.owner].bench.length > 0,
    execute: () => [{ op: 'switch', side: 'own' }],
  };
  const f = await fixture((defs) => {
    defs[0].mechanics.abilities = [
      activated('history-switch', [binding('fixture:history-switch', {}, 'history-switch')]),
      activated('history-heal', [binding('cn.heal@1', { target: 'self', amount: 30 }, 'history-heal')]),
    ];
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [
      binding('cn.heal@1', { target: 'active', amount: 30 }, 'history-heal-first'),
      binding('cn.heal@1', { target: 'active', amount: 30 }, 'history-heal-noop'),
    ];
  }, new Map([['fixture:history-switch', switchHandler]]));
  let potionId, incoming;
  const g = board(f, (s) => {
    s.players[0].active.counters = 1; attached(s, 0, s.players[0].active, 'water');
    potionId = hand(s, 0, 'potion'); incoming = bench(s, 0, 'other').id;
  });
  const before = g.snapshot(), original = before.players[0].active.id;
  assert.equal(wasHealedThisTurn(before.battleHistory, clock(before), 0, original), false);
  assert.equal(wasMovedFromBenchToActiveThisTurn(before.battleHistory, clock(before), 0, original), false);
  command(g, { type: 'playTrainer', cardId: potionId });
  const healed = settleRestoring(g, f);
  assert.deepEqual(events(healed, 'heal'), [{
    kind: 'heal', turn: before.turn, during: 0, owner: 0, pokemonId: original, amount: 10,
  }], 'The requested 30 HP is capped to the actual one removed counter; the second heal contributes no event.');
  assert.equal(wasHealedThisTurn(healed.battleHistory, clock(healed), 0, original), true);
  const healthy = g.snapshot();
  assert.throws(() => command(g, { type: 'useAbility', pokemonId: original, abilityId: 'history-heal' }));
  assert.deepEqual(g.snapshot(), healthy, 'A rejected no-op recovery cannot manufacture a history fact.');
  command(g, { type: 'retreat' });
  const retreated = settleRestoring(g, f, (q) =>
    q.kind === 'retreat-target' ? [incoming] : policy(q));
  assert.equal(retreated.players[0].active.id, incoming);
  assert.equal(wasMovedFromBenchToActiveThisTurn(retreated.battleHistory, clock(retreated), 0, incoming), true);
  assert.equal(wasHealedThisTurn(retreated.battleHistory, clock(retreated), 0, original), true,
    'The healed original Pokémon is now on the Bench, but the actual recovery still happened this turn.');
  command(g, { type: 'useAbility', pokemonId: original, abilityId: 'history-switch' });
  const returned = settleRestoring(g, f, (q) => q.kind === 'effect-target' ? [original] : policy(q));
  assert.equal(returned.players[0].active.id, original);
  assert.equal(wasMovedFromBenchToActiveThisTurn(returned.battleHistory, clock(returned), 0, original), true);
  assert.equal(wasHealedThisTurn(returned.battleHistory, clock(returned), 0, original), true);
  assert.deepEqual(events(returned, 'heal'), events(healed, 'heal'));
  assert.deepEqual(events(returned, 'benchToActive').map((event) => event.pokemonId), [incoming, original]);
  const restored = restore(returned, f).snapshot();
  assert.deepEqual(restored.battleHistory, returned.battleHistory);
  assert.equal(wasHealedThisTurn(restored.battleHistory, clock(restored), 0, original), true);
  command(g, { type: 'endTurn' }); settleRestoring(g, f);
  command(g, { type: 'endTurn' });
  const later = settleRestoring(g, f);
  assert.equal(later.current, 0);
  assert.equal(wasHealedThisTurn(later.battleHistory, clock(later), 0, original), false);
  assert.equal(wasMovedFromBenchToActiveThisTurn(later.battleHistory, clock(later), 0, original), false);
});

test('Bench-only healing records the actual Bench recovery and cannot use damage on Active as a substitute target', async () => {
  const f = await fixture((defs) => defs.find((d) => d.definitionId === 'potion').mechanics.effects = [
    binding('cn.heal@1', { target: 'bench', amount: 30 }, 'history-bench-heal'),
  ]);
  let potionId, damagedBench;
  const g = board(f, (s) => {
    s.players[0].active.counters = 3; const other = bench(s, 0, 'other');
    other.counters = 1; damagedBench = other.id; potionId = hand(s, 0, 'potion');
  });
  const activeId = g.snapshot().players[0].active.id;
  command(g, { type: 'playTrainer', cardId: potionId });
  const pending = g.snapshot();
  assert.equal(pending.pending.kind, 'effect-target');
  assert.deepEqual(pending.pending.options, [damagedBench]);
  assert.throws(() => answer(g, [activeId]), 'A damaged Active is not a legal Bench-only healing target.');
  assert.deepEqual(g.snapshot(), pending);
  const after = settleRestoring(g, f);
  assert.equal(after.players[0].active.counters, 3);
  assert.equal(after.players[0].bench.find((m) => m.id === damagedBench).counters, 0);
  assert.deepEqual(events(after, 'heal'), [{
    kind: 'heal', turn: after.turn, during: 0, owner: 0, pokemonId: damagedBench, amount: 10,
  }]);
  assert.equal(wasHealedThisTurn(after.battleHistory, clock(after), 0, damagedBench), true);
  assert.equal(wasHealedThisTurn(after.battleHistory, clock(after), 0, activeId), false);
  const noBenchRecovery = board(f, (s) => {
    s.players[0].active.counters = 3; bench(s, 0, 'other'); potionId = hand(s, 0, 'potion');
  });
  const before = noBenchRecovery.snapshot();
  assert(!noBenchRecovery.view(0).legalActions.some((action) => action.type === 'playTrainer' && action.cardId === potionId));
  assert.throws(() => command(noBenchRecovery, { type: 'playTrainer', cardId: potionId }));
  assert.deepEqual(noBenchRecovery.snapshot(), before);
  assert.deepEqual(events(before, 'heal'), []);
});

test('moved/healed compatibility caches cannot manufacture root facts; real own-turn promotion satisfies E24', async () => {
  const f = await fixture((defs) => defs[0].mechanics.abilities = [
    activated('history-own-ko', [binding('cn.counters@1', { side: 'own', target: 'self', count: 10 }, 'history-own-ko')]),
  ]);
  let incoming;
  const g = board(f, (s) => {
    s.players[0].active.facts.healedTurn = s.turn;
    s.players[0].active.facts.movedActiveTurn = s.turn;
    incoming = bench(s, 0, 'other').id;
  });
  const before = g.snapshot(), original = before.players[0].active.id;
  assert.equal(wasHealedThisTurn(before.battleHistory, clock(before), 0, original), false);
  assert.equal(wasMovedFromBenchToActiveThisTurn(before.battleHistory, clock(before), 0, original), false);
  command(g, { type: 'useAbility', pokemonId: original, abilityId: 'history-own-ko' });
  const after = settleRestoring(g, f);
  assert.equal(after.turn, before.turn); assert.equal(after.current, 0);
  assert.equal(after.players[0].active.id, incoming);
  assert.deepEqual(events(after, 'benchToActive'), [{
    kind: 'benchToActive', turn: before.turn, during: 0, owner: 0, pokemonId: incoming,
  }]);
  assert.equal(wasMovedFromBenchToActiveThisTurn(after.battleHistory, clock(after), 0, incoming), true);
  assert.equal(wasHealedThisTurn(after.battleHistory, clock(after), 0, incoming), false);
  assertPreviousKO(after, { owner: 0, any: false, attackDamage: false });
});

test('restoration preserves root semantics and rejects future timelines, clock/count mismatches and forged original sources', async () => {
  const f = await fixture(), g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water'); s.players[1].active.counters = 8;
    bench(s, 1, 'other');
  });
  command(g, { type: 'attack', attackId: 'base:strike' });
  const good = settleRestoring(g, f), restored = restore(good, f);
  assert.deepEqual(restored.snapshot(), good);
  assert.deepEqual(restored.view(1), g.view(1));
  assertPreviousKO(restored.snapshot(), { owner: 1, any: true, attackDamage: true, attacker: 0 });
  const originalSource = events(good, 'ko')[0].cause.source;
  const otherCard = Object.values(good.cards).find((card) => card.owner === 1 && card.definitionId === 'base').instanceId;
  for (const [label, mutate] of [
    ['missing root history', (s) => { delete s.battleHistory; }],
    ['unsupported history version', (s) => { s.battleHistory.schemaVersion = 'latest'; }],
    ['legacy duplicate player history', (s) => { s.players[0].history = []; }],
    ['future history event', (s) => { events(s, 'ko')[0].turn = s.turn + 1; }],
    ['future recorded turn', (s) => { s.battleHistory.turns.push({ turn: s.turn + 1, player: 0 }); }],
    ['missing actual turn', (s) => { s.battleHistory.turns.pop(); }],
    ['corrupt root clock, not an extra-turn fixture', (s) => { s.turn++; }],
    ['wrong current player', (s) => { s.current = 1 - s.current; }],
    ['wrong per-player turn count', (s) => { s.players[0].turns++; }],
    ['wrong during player', (s) => { events(s, 'ko')[0].during = 1; }],
    ['duplicate committed KO', (s) => { s.battleHistory.events.push(structuredClone(events(s, 'ko')[0])); }],
    ['missing original physical source', (s) => { events(s, 'ko')[0].cause.source.instanceId = 'missing-history-source'; }],
    ['wrong physical source holder', (s) => { events(s, 'ko')[0].cause.source.cardOwner = 1; }],
    ['another player source cannot become this attacker', (s) => {
      Object.assign(events(s, 'ko')[0].cause.source, { instanceId: otherCard, cardOwner: 1 });
    }],
    ['unrecorded copied source', (s) => {
      Object.assign(events(s, 'ko')[0].cause.source, {
        contentSource: { instanceId: originalSource.instanceId, attackId: originalSource.attackId }, copyId: 'missing-copy-receipt',
      });
    }],
    ['unrecorded granted source', (s) => {
      Object.assign(events(s, 'ko')[0].cause.source, {
        contentSource: { instanceId: originalSource.instanceId, attackId: originalSource.attackId }, grantId: 'missing-grant-receipt',
      });
    }],
  ]) {
    const invalid = structuredClone(good); mutate(invalid);
    assert.throws(() => restore(invalid, f), label);
    assert.deepEqual(g.snapshot(), good, 'Rejecting an external corrupt snapshot cannot mutate the running game.');
  }
});
