// Real OfficialGame wiring, using synthetic definitions only; no printing approval.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const pokemonSelector = (type) => ({ kind: 'pokemon', nameKeys: ['base'], types: [type] });
const ability = (id, effects, mode = 'activated') => ({
  abilityId: id, name: `测试场上筛选${id}`, mode,
  usage: mode === 'continuous' ? null : { period: 'unlimited', scope: 'pokemon', key: id, limit: null },
  effects, sourceOfTruth: EVIDENCE,
});
const returning = (selector) => ({
  op: 'returnPokemon', side: 'own', target: 'bench', selector,
  quantity: { kind: 'exact', count: 1 }, to: 'hand', attachments: 'return', chooser: 'source',
  promotion: { timing: 'afterRelatedResolution', sourceOfTruth: EVIDENCE },
});
const evolve = (targetType, cardType = 'Darkness') => ({
  op: 'evolvePokemon', target: 'bench', targetSelector: pokemonSelector(targetType),
  from: 'deck', selector: { kind: 'pokemon', stages: ['stage1'], types: [cardType] }, relation: 'ordinary',
  timing: { firstOwnTurn: 'allow', enteredThisTurn: 'allow', evolvedThisTurn: 'allow' }, shuffleAfter: true,
});
const grant = (targetType, template) => ({
  op: 'attackGrant', scope: 'self', targetSelector: pokemonSelector(targetType),
  origins: [{ side: 'own', zone: 'discard', selector: { kind: 'pokemon', nameKeys: [template] } }],
  excludeUser: false,
});
const attach = (type) => ({
  op: 'attachDeckEnergy', lookTop: 1, selector: { kind: 'energy', category: 'basic', types: ['Water'] },
  quantity: { kind: 'upTo', count: 1 }, recipient: { position: 'bench', selector: pokemonSelector(type) },
  distribution: 'singleRecipient', remainder: 'shuffleDeck', reveal: true,
});

async function make(extend) {
  return fixture((defs) => {
    for (const def of defs.filter((d) => d.kind === 'pokemon')) def.mechanics.types = ['Darkness'];
    // A real Benched provider changes the complete current type set. Returning
    // that provider removes the source, not the target or its printed identity.
    defs[1].mechanics.abilities = [ability('psychic-source', [
      binding('cn.pokemonTypes@1', { effect: { op: 'pokemonTypes', types: ['Psychic'], scope: 'own' } }),
    ], 'continuous')];
    defs[0].mechanics.abilities = [ability('remove-source', [
      binding('cn.fieldReturn@1', returning({ kind: 'pokemon', nameKeys: ['other'] }), 'remove-source'),
    ])];
    extend(defs);
  });
}
function put(s, definitionId, zone) {
  const id = hand(s, 0, definitionId), p = s.players[0];
  p.hand.splice(p.hand.indexOf(id), 1); p[zone].push(id); return id;
}
function setup(s) {
  const provider = bench(s, 0, 'other'), target = bench(s, 0, 'base');
  return { provider: provider.id, providerCard: provider.stack[0], target: target.id, targetCard: target.stack[0] };
}
const legalAbility = (g, id) => g.view(0).legalActions.find((a) => a.type === 'useAbility' &&
  a.pokemonId === g.snapshot().players[0].active.id && a.abilityId === id);
function use(g, id) {
  const action = legalAbility(g, id); assert(action, `Expected usable ${id}`); command(g, action);
}
function restored(g, f) {
  const r = OfficialGame.restore(JSON.parse(JSON.stringify(g.snapshot())), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  for (const viewer of [0, 1]) assert.deepEqual(r.view(viewer), g.view(viewer));
  return r;
}
function respond(g, f, selected) {
  const r = restored(g, f); answer(g, selected); answer(r, selected);
  assert.deepEqual(r.snapshot(), g.snapshot());
}
function currentTypes(g, pokemonId) {
  const p = g.view(0).players[0];
  return [p.active, ...p.bench].find((m) => m.id === pokemonId).effective.types;
}
function removeSource(g, f, ids) {
  use(g, 'remove-source');
  assert.equal(g.snapshot().pending.kind, 'return-pokemon');
  assert.deepEqual(g.snapshot().pending.options, [ids.provider]);
  respond(g, f, [ids.provider]); settle(g);
  assert(!g.snapshot().players[0].bench.some((m) => m.id === ids.provider));
  assert(g.snapshot().players[0].hand.includes(ids.providerCard));
  assert.deepEqual(currentTypes(g, ids.target), ['Darkness']);
  restored(g, f);
}

test('fieldReturn.target uses current Psychic types and changes its actual options when the type provider leaves', async () => {
  const f = await make((defs) => {
    for (const [id, type] of [['psychic-return', 'Psychic'], ['dark-return', 'Darkness']])
      defs[0].mechanics.abilities.push(ability(id, [binding('cn.fieldReturn@1', returning(pokemonSelector(type)), id)]));
  });
  let ids;
  const g = board(f, (s) => { ids = setup(s); });
  assert.deepEqual(currentTypes(g, ids.target), ['Psychic']);
  assert.deepEqual(f.catalog.definition('base').mechanics.types, ['Darkness']);
  assert(legalAbility(g, 'psychic-return')); assert(!legalAbility(g, 'dark-return'));
  const removed = restored(g, f);
  removeSource(removed, f, ids);
  assert(!legalAbility(removed, 'psychic-return')); assert(legalAbility(removed, 'dark-return'));
  use(removed, 'dark-return'); assert.deepEqual(removed.snapshot().pending.options, [ids.target]);
  respond(removed, f, [ids.target]); settle(removed);
  assert(removed.snapshot().players[0].hand.includes(ids.targetCard));
  use(g, 'psychic-return');
  assert.equal(g.snapshot().pending.kind, 'return-pokemon');
  assert.deepEqual(g.snapshot().pending.options, [ids.target], 'Printed-Darkness target is currently Psychic.');
  respond(g, f, [ids.target]); settle(g);
  assert(g.snapshot().players[0].hand.includes(ids.targetCard));
  restored(g, f);
});

test('effect evolution targetSelector is live while its searched evolution card still matches printed Darkness, never Psychic', async () => {
  const f = await make((defs) => {
    for (const [id, targetType, cardType] of [
      ['psychic-target', 'Psychic', 'Darkness'], ['dark-target', 'Darkness', 'Darkness'],
      ['psychic-card', 'Psychic', 'Psychic'],
    ]) defs[0].mechanics.abilities.push(ability(id, [binding('cn.pokemonTransition@1', evolve(targetType, cardType), id)]));
  });
  let ids, evolution;
  const g = board(f, (s) => { ids = setup(s); evolution = put(s, 'evolution', 'deck'); });
  assert(legalAbility(g, 'psychic-target')); assert(!legalAbility(g, 'dark-target'));
  const removed = restored(g, f);
  removeSource(removed, f, ids);
  assert(!legalAbility(removed, 'psychic-target')); assert(legalAbility(removed, 'dark-target'));
  use(removed, 'dark-target'); assert.deepEqual(removed.snapshot().pending.options, [ids.target]);
  respond(removed, f, [ids.target]);
  assert.deepEqual(removed.snapshot().pending.options, [evolution]);
  respond(removed, f, [evolution]); settle(removed);
  assert.deepEqual(currentTypes(removed, ids.target), ['Darkness']);

  use(g, 'psychic-card'); respond(g, f, [ids.target]);
  assert.equal(g.snapshot().pending.kind, 'view-cards');
  assert.deepEqual(g.snapshot().pending.options, ['confirm']);
  assert(g.view(0).pending.lookedAt.some((card) => card.instanceId === evolution));
  respond(g, f, ['confirm']); settle(g);
  assert.deepEqual(g.snapshot().players[0].bench.find((m) => m.id === ids.target).stack, [ids.targetCard]);
  use(g, 'psychic-target');
  assert.equal(g.snapshot().pending.kind, 'transition-target');
  assert.deepEqual(g.snapshot().pending.options, [ids.target]);
  respond(g, f, [ids.target]);
  assert.equal(g.snapshot().pending.kind, 'transition-card');
  assert.deepEqual(g.snapshot().pending.options, [evolution]);
  respond(g, f, [evolution]); settle(g);
  assert.deepEqual(g.snapshot().players[0].bench.find((m) => m.id === ids.target).stack, [ids.targetCard, evolution]);
  assert.deepEqual(currentTypes(g, ids.target), ['Psychic']);
  assert.deepEqual(f.catalog.definition('evolution').mechanics.types, ['Darkness']);
  restored(g, f);
});

test('grant.targetSelector reads the actual user’s current types and swaps usable printed attacks after the provider returns', async () => {
  const f = await make((defs) => {
    for (const [type, template] of [['Psychic', 'other'], ['Darkness', 'evolution']])
      defs[0].mechanics.abilities.push(ability(`grant-${type}`, [
        binding('cn.attackGrant@1', grant(type, template), `grant-${type}`),
      ], 'continuous'));
  });
  let ids;
  const g = board(f, (s) => {
    ids = setup(s); put(s, 'other', 'discard'); put(s, 'evolution', 'discard');
    attached(s, 0, s.players[0].active, 'water');
  });
  const attack = (game, id) => game.view(0).legalActions.find((a) => a.type === 'attack' && a.attackId === id);
  assert.deepEqual(currentTypes(g, g.snapshot().players[0].active.id), ['Psychic']);
  assert(attack(g, 'other:strike')); assert(!attack(g, 'evolution:strike'));
  const removed = restored(g, f);
  removeSource(removed, f, ids);
  assert(!attack(removed, 'other:strike')); assert(attack(removed, 'evolution:strike'));
  command(removed, attack(removed, 'evolution:strike')); settle(removed);
  assert.equal(removed.snapshot().players[1].active.counters, 2);
  restored(removed, f);
  const continuation = restored(g, f);
  command(continuation, attack(continuation, 'other:strike')); settle(continuation);
  assert.equal(continuation.snapshot().players[1].active.counters, 2);
  assert(continuation.snapshot().events.some((e) => e.ruleId === 'attack.grant' && e.data.kind === 'used' &&
    e.data.reference.attackId === 'other:strike'));
  assert.deepEqual(f.catalog.definition('base').mechanics.types, ['Darkness']);
});

test('attachDeckEnergy.recipient uses current Psychic types through selection, allocation and restore, then Darkness after source removal', async () => {
  const f = await make((defs) => {
    for (const [id, type] of [['psychic-attach', 'Psychic'], ['dark-attach', 'Darkness']])
      defs[0].mechanics.abilities.push(ability(id, [binding('cn.attachDeckEnergy@1', attach(type), id)]));
  });
  let ids, energy;
  const g = board(f, (s) => { ids = setup(s); energy = put(s, 'water', 'deck'); });
  assert(legalAbility(g, 'psychic-attach')); assert(!legalAbility(g, 'dark-attach'));
  const removed = restored(g, f);
  removeSource(removed, f, ids);
  assert(!legalAbility(removed, 'psychic-attach')); assert(legalAbility(removed, 'dark-attach'));
  function perform(game, abilityId) {
    use(game, abilityId);
    assert.equal(game.snapshot().pending.kind, 'inspect-deck');
    assert.deepEqual(game.snapshot().pending.options, [energy]);
    respond(game, f, [energy]);
    assert.equal(game.snapshot().pending.kind, 'deck-energy-recipient');
    assert.deepEqual(game.snapshot().pending.options, [ids.target]);
    respond(game, f, [ids.target]); settle(game);
    assert(game.snapshot().players[0].bench.find((m) => m.id === ids.target).energy.includes(energy));
    assert(!game.snapshot().players[0].deck.includes(energy));
    restored(game, f);
  }
  perform(g, 'psychic-attach');
  perform(removed, 'dark-attach');
  assert.deepEqual(currentTypes(g, ids.target), ['Psychic']);
  assert.deepEqual(f.catalog.definition('base').mechanics.types, ['Darkness']);
});
