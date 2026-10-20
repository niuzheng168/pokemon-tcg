import test from 'node:test';
import assert from 'node:assert/strict';
import { createOngoingEffect, assertOngoingEffect, ongoingIsActive, expireOngoing, ONGOING_RULE_IDS } from '../../public/rules/ongoing.js';
import { EFFECT_RULE_IDS } from '../../public/rules/effects.js';
import { CN_V20261019 } from '../../public/rules/zh-CN/V20261019.js';
import { requireRule } from '../../public/rules/registry.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { OfficialGame } from '../../public/rules/game.js';
import { randomIndex } from '../../public/rules/random.js';
import { checkConditions, emptyConditions } from '../../public/rules/conditions.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const durations = ['nextOwnTurn', 'nextOpponentTurn', 'untilNextOwnTurnEnd', 'untilNextOpponentTurnEnd'];
const spec = (field = 'attackDamage', amount = 30) => ({ op: 'modifier', field, amount, scope: 'all' });
const params = (effect, duration, extra = {}) => ({ side: 'own', target: 'self', effect, duration,
  clearOnBench: true, clearOnEvolution: true, ...extra });
const ability = (id, parameters) => ({
  abilityId: id, name: `测试持续效果${id}`, mode: 'activated',
  usage: { period: 'unlimited', scope: 'pokemon', key: id, limit: null },
  effects: [binding('cn.lasting@1', parameters, id)], sourceOfTruth: EVIDENCE,
});
const use = (g, id = 'lasting') => command(g, { type: 'useAbility', abilityId: id, pokemonId: g.snapshot().players[0].active.id });
const end = (g) => { command(g, { type: 'endTurn' }); settle(g); };
const restore = (g, f) => OfficialGame.restore(JSON.parse(JSON.stringify(g.snapshot())), { catalog: f.catalog });

test('CN E-01/02 vs E-21/22: four duration clocks, both owners, turn boundaries and checkup', () => {
  for (const id of [...ONGOING_RULE_IDS, ...EFFECT_RULE_IDS]) assert(requireRule(CN_V20261019, id).sourceOfTruth.length);
  for (const owner of [0, 1]) for (const duration of durations) {
    const s = { current: owner, phase: 'main', players: [{ turns: 3 }, { turns: 2 }] };
    const source = { instanceId: 'source', owner, category: 'attack', pokemonId: 'attacker',
      attackId: 'attack', effectId: 'effect', sourceOfTruth: EVIDENCE };
    const entry = createOngoingEffect({ id: 'e1', targetId: 'target', source, effect: spec(), duration,
      clearOnBench: true, clearOnEvolution: true }, s);
    const untilEnd = duration.startsWith('until');
    const whose = duration.includes('Opponent') ? 1 - owner : owner;
    assert.equal(entry.deadline.player, whose);
    assert.equal(ongoingIsActive(entry, s), untilEnd, 'Turn-only effects do not start immediately.');
    s.current = null; s.phase = 'checkup';
    assert.equal(ongoingIsActive(entry, s), untilEnd, 'The checkup before the target turn is excluded for turn-only.');
    const before = structuredClone(entry);
    assert.equal(expireOngoing([entry], s, whose, 'checkup-end').length, 1);
    s.players[whose].turns++; s.current = whose; s.phase = 'main';
    assert(ongoingIsActive(entry, s)); assertOngoingEffect(entry, s);
    assert.equal(expireOngoing([entry], s, whose, 'turn-end').length, untilEnd ? 1 : 0);
    assert.equal(expireOngoing([entry], s, 1 - whose, 'turn-end').length, 1);
    s.current = null; s.phase = 'checkup';
    assert.equal(ongoingIsActive(entry, s), untilEnd);
    assert.equal(expireOngoing([entry], s, whose, 'checkup-end').length, untilEnd ? 0 : 1);
    assert.deepEqual(entry, before, 'Queries/expiration do not mutate the original ledger.');
    s.players[whose].turns++;
    assert.equal(ongoingIsActive(entry, s), false);
    assert.throws(() => assertOngoingEffect(entry, s), /deadline mismatch/);
    for (const mutate of [
      (e) => { e.deadline.player = 1 - e.deadline.player; },
      (e) => { e.deadline.boundary = e.deadline.boundary === 'turn-end' ? 'checkup-end' : 'turn-end'; },
      (e) => { e.ruleId = e.ruleId === 'effects.duration.until-end' ? 'effects.duration.turn-only' : 'effects.duration.until-end'; },
      (e) => { e.effect.scope = 'self'; }, (e) => { e.effect.sourceActive = true; },
    ]) { const bad = structuredClone(before); mutate(bad); assert.throws(() => assertOngoingEffect(bad, s)); }
  }
  assert.throws(() => expireOngoing([], {}, 2, 'turn-end'), /boundary/);
  assert.throws(() => expireOngoing([], {}, 0, 'turn'), /boundary/);
});

test('next-opponent-turn damage prevention activates only for that turn and expires before checkup', async () => {
  const f = await fixture((defs) => defs[0].mechanics.abilities.push(ability('lasting', params({
    op: 'protection', useRule: 'ordinary', channel: 'damage', from: 'opponent', categories: ['attack'], scope: 'all',
  }, 'nextOpponentTurn'))));
  let g = board(f, (s) => attached(s, 1, s.players[1].active, 'water'));
  use(g); assert.equal(g.snapshot().pending.kind, 'effect-target');
  g = restore(g, f); settle(g);
  const entry = g.snapshot().ongoing[0]; assert(entry); assert(!ongoingIsActive(entry, g.snapshot()));
  end(g); assert(ongoingIsActive(g.snapshot().ongoing[0], g.snapshot()));
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  assert.equal(g.snapshot().players[0].active.counters, 0);
  assert.equal(g.snapshot().ongoing.length, 0);
  const events = g.snapshot().events;
  const expiry = events.findIndex((e) => e.data.effectId === entry.id && e.data.expiredAt);
  assert.equal(events[expiry].data.expiredAt, 'turn-end');
  assert(events.slice(expiry + 1).some((e) => e.ruleId === 'checkup.order'));
});

test('next-own-turn bonus is not an immediate bonus and remains bound to the same Pokémon', async () => {
  const f = await fixture((defs) => defs[0].mechanics.abilities.push(ability('lasting', params(spec(), 'nextOwnTurn'))));
  const g = board(f, (s) => attached(s, 0, s.players[0].active, 'water'));
  use(g); settle(g);
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 2);
  end(g);
  assert(ongoingIsActive(g.snapshot().ongoing[0], g.snapshot()));
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 7);
  assert.equal(g.snapshot().ongoing.length, 0);
});

test('until-next-own-turn-end HP lasts through intervening checks; expiry is after the specified checkup, before KO', async () => {
  const f = await fixture((defs) => defs[0].mechanics.abilities.push(ability('lasting', params(spec('hp', 50), 'untilNextOwnTurnEnd'))));
  let g = board(f);
  use(g); settle(g);
  const s = g.snapshot(); s.players[0].active.counters = 11; s.players[0].active.conditions.poison = 1;
  g = OfficialGame.restore(s, { catalog: f.catalog });
  end(g); assert.equal(g.snapshot().result, null); assert.equal(g.snapshot().players[0].active.counters, 12);
  end(g); assert.equal(g.snapshot().result, null); assert.equal(g.snapshot().players[0].active.counters, 13);
  end(g);
  assert.deepEqual(g.snapshot().result, { winner: 1, reason: 'ordinary' });
  const events = g.snapshot().events, expired = events.findIndex((e) => e.data.expiredAt === 'checkup-end');
  const lastPoison = events.findLastIndex((e) => e.ruleId === 'status.poison');
  const ko = events.findIndex((e) => e.ruleId === 'ko.boundary' && e.data.owner === 0);
  assert(lastPoison < expired && expired < ko);
});

test('bench/evolution clearing is explicit, while persistent facts and unaffected effects survive', async () => {
  const f = await fixture((defs) => defs[0].mechanics.abilities.push(
    ability('clear', params(spec('retreat', 1), 'untilNextOwnTurnEnd')),
    ability('keep', params(spec('retreat', 1), 'untilNextOwnTurnEnd', { clearOnBench: false, clearOnEvolution: false })),
  ));
  for (const transition of ['retreat', 'evolve']) {
    let g = board(f, (s) => {
      bench(s, 0, 'other'); attached(s, 0, s.players[0].active, 'double');
      attached(s, 0, s.players[0].active, 'water'); hand(s, 0, 'evolution');
      s.players[0].active.facts.healedTurn = s.turn;
    });
    use(g, 'clear'); settle(g); use(g, 'keep'); settle(g);
    assert.equal(g.snapshot().ongoing.length, 2);
    g = restore(g, f);
    const id = g.snapshot().players[0].active.id;
    if (transition === 'retreat') {
      command(g, { type: 'retreat' }); answer(g, g.snapshot().pending.options); settle(g);
    } else command(g, g.view(0).legalActions.find((a) => a.type === 'evolve'));
    assert.equal(g.snapshot().ongoing.length, 1);
    assert(g.snapshot().ongoing[0].source.effectId.endsWith('keep'));
    const p = g.snapshot().players[0], m = [p.active, ...p.bench].find((m) => m.id === id);
    assert.equal(m.facts.healedTurn, 5);
  }
});

test('KO removes targeted ongoing effects, and malformed/duplicate/orphaned ledgers cannot be restored', async () => {
  const f = await fixture((defs) => defs[0].mechanics.abilities.push(ability('lasting', params(spec(), 'untilNextOpponentTurnEnd'))));
  const g = board(f); use(g); settle(g);
  const original = g.snapshot();
  for (const mutate of [
    (s) => { s.ongoing.push(structuredClone(s.ongoing[0])); },
    (s) => { s.ongoing[0].targetId = 'missing-mon'; },
    (s) => { s.ongoing[0].source.instanceId = 'missing-card'; },
    (s) => { s.ongoing[0].source.owner = 1; },
    (s) => { s.ongoing[0].deadline.ownerTurn = 0; },
    (s) => { s.ongoing[0].unexpected = true; },
  ]) { const s = structuredClone(original); mutate(s); assert.throws(() => OfficialGame.restore(s, { catalog: f.catalog })); }
  const s = structuredClone(original); s.players[0].active.counters = 10;
  const dying = OfficialGame.restore(s, { catalog: f.catalog });
  command(dying, dying.view(0).legalActions.find((a) => a.type === 'attachEnergy')); settle(dying);
  assert.equal(dying.snapshot().ongoing.length, 0); assert.equal(dying.snapshot().result.winner, 1);
});

test('integrated checkup consumes separate burn and sleep coins, before the next draw', async () => {
  const f = await fixture(), g = board(f, (s) => {
    s.players[0].active.conditions.rotation = 'asleep'; s.players[0].active.conditions.burned = true;
  });
  const rng = [...g.snapshot().rng], burned = randomIndex(rng, 2) !== 0, sleeping = randomIndex(rng, 2) !== 0;
  end(g);
  assert.deepEqual(g.snapshot().rng, rng);
  assert.equal(g.snapshot().players[0].active.conditions.burned, burned);
  assert.equal(g.snapshot().players[0].active.conditions.rotation, sleeping ? 'asleep' : null);
  assert.equal(g.snapshot().players[0].active.counters, 2);
});

test('CN I.F checks each status on both sides together, not all of one Pokémon before the other', async () => {
  const f = await fixture(), g = board(f, (s) => {
    s.rng = [1, 33554432, 2, 3];
    for (const p of s.players) {
      p.active.conditions.rotation = 'asleep'; p.active.conditions.burned = true; p.active.conditions.poison = 1;
    }
  });
  const before = g.snapshot(), rng = [...before.rng];
  const burnCoins = [randomIndex(rng, 2) === 0, randomIndex(rng, 2) === 0];
  const sleepCoins = [randomIndex(rng, 2) === 0, randomIndex(rng, 2) === 0];
  assert.notEqual(burnCoins[1], sleepCoins[0], 'This seed must detect the old per-Pokémon loop.');
  end(g);
  assert.deepEqual(g.snapshot().rng, rng);
  for (const owner of [0, 1]) {
    const mon = g.snapshot().players[owner].active;
    assert.equal(mon.conditions.burned, !burnCoins[owner]);
    assert.equal(mon.conditions.rotation, sleepCoins[owner] ? null : 'asleep');
    assert.equal(mon.counters, 3);
  }
  // Aggregation explains the counter replacement; it is not a second Burn tick.
  const traces = g.snapshot().events.slice(before.events.length).filter((e) =>
    ['status.poison', 'status.burn', 'status.sleep'].includes(e.ruleId) && e.data.aggregation === undefined);
  assert.deepEqual(traces.map((e) => [e.ruleId, e.data.pokemonId]), [
    ...['status.poison', 'status.burn', 'status.sleep'].flatMap((id) => [0, 1].map((owner) => [id, before.players[owner].active.id])),
  ]);
  assert.throws(() => checkConditions(emptyConditions(), {
    ownerTurn: 1, ownerIsEndingPlayer: false, flip: () => true, step: 'confusion',
  }), /Invalid checkup context/);
});

test('permission/damage-options handlers have no executable game actions, only their declared semantic hook', () => {
  const h = createCoreHandlers();
  assert.deepEqual(h.get('cn.attackPermissions@1').execute(), []);
  assert.deepEqual(h.get('cn.damageOptions@1').execute(), []);
});

test('public views expose effective stats and duration state, without private work/handler implementation data', async () => {
  const f = await fixture((defs) => defs[0].mechanics.abilities.push(ability('lasting', params(spec('hp', 50), 'untilNextOwnTurnEnd'))));
  const g = board(f); use(g); settle(g);
  for (const player of [0, 1]) {
    const view = g.view(player);
    assert.equal(view.players[0].active.effective.maxHp, 150);
    assert.equal(view.players[0].active.effective.currentHp, 150);
    assert.equal(view.players[1].active.effective.maxHp, 100);
    assert.equal(view.players[1].active.effective.currentHp, 100);
    assert.equal(view.ongoing[0].targetId, view.players[0].active.id);
    assert(view.ongoing[0].active); assert(view.ongoing[0].rule.sourceOfTruth.length);
    for (const key of ['rng', 'queue', 'cards']) assert(!Object.hasOwn(view, key));
    assert(!Object.hasOwn(view.ongoing[0].source, 'handlerId'));
    assert.throws(() => { view.ongoing[0].active = false; }, TypeError);
  }
});
