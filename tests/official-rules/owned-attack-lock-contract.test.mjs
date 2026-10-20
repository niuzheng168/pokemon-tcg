import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  validateOwnedAttackLockAction, validateOwnedAttackLockParameters,
  validateEffectProgram, validateLastingParameters, validateContinuousEffect, validateOngoingEffect,
} from '../../public/rules/schema-validators.js';
import { createCoreHandlers, REACTION_OPERATIONS } from '../../public/rules/handlers.js';
import { assertEffectProgram } from '../../public/rules/effects.js';
import { canonicalDefinition, canonicalPrinting, assertExecutableDefinition, CardSchemaError } from '../../public/rules/card-schema.js';
import { createCardCatalog, canonicalJSON } from '../../public/rules/catalog.js';
import { OfficialGame, EngineError } from '../../public/rules/game.js';
import { CN_V20261019 } from '../../public/rules/zh-CN/V20261019.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, board, RULESET, EVIDENCE } from './fixtures.mjs';

// Synthetic shape/profile/approval contracts only. No real-card approval or I/O writes.
// Actual choice resolution, successful receipt replay and battles belong to the runtime tests.
// The forged-ledger case below checks only that shape is not restoration authority.
const HANDLER = 'cn.disableOwnedAttack@1';
const action = (extra = {}) => ({
  op: 'disableOwnedAttack', side: 'opponent', target: 'active', duration: 'nextOpponentTurn',
  clearOnBench: true, clearOnEvolution: true, ...extra,
});
const without = (value, key) => {
  const result = structuredClone(value); delete result[key]; return result;
};
const checkAction = (value, expected, label) => {
  const before = structuredClone(value);
  assert.equal(validateOwnedAttackLockAction(value), expected, `${label}: action`);
  assert.equal(validateOwnedAttackLockParameters(value), expected, `${label}: parameters`);
  assert.equal(validateEffectProgram([value]), expected, `${label}: program`);
  assert.deepEqual(value, before, `${label}: no inserted defaults or inferred references`);
};
const trigger = () => ({
  event: 'attackDamage', subject: 'self', optional: false, choiceOwner: 'source', scope: 'global',
});
const ledger = () => ({
  id: 'fixture:owned-lock-ledger', targetId: 'fixture:target-pokemon',
  source: {
    instanceId: 'fixture:attacking-card', owner: 0, category: 'attack', pokemonId: 'fixture:attacker',
    attackId: 'fixture:source-attack', effectId: 'fixture:lock-effect', sourceOfTruth: EVIDENCE, origin: 'field',
  },
  effect: {
    op: 'ownedAttackRestriction', scope: 'all',
    reference: { instanceId: 'fixture:target-top', attackId: 'fixture:target-attack' },
  },
  ownedAttackLockId: 'fixture:unbacked-lock', duration: 'nextOpponentTurn',
  deadline: { player: 1, ownerTurn: 2, boundary: 'turn-end' },
  clearOnBench: true, clearOnEvolution: true, ruleId: 'effects.duration.turn-only',
});
const ability = (mode, effect) => ({
  abilityId: 'fixture:owned-lock', name: '测试用虚构封锁', mode,
  usage: mode === 'activated' ? { period: 'unlimited', scope: 'pokemon', key: 'fixture:owned-lock', limit: null } : null,
  ...(mode === 'triggered' ? { trigger: trigger() } : {}),
  effects: [effect], sourceOfTruth: EVIDENCE,
});
function install(definitions, slot, effect) {
  const pokemon = definitions.find((card) => card.definitionId === 'base');
  if (slot === 'attack') pokemon.mechanics.attacks[0].effects = [effect];
  else if (['activated', 'continuous', 'triggered'].includes(slot))
    pokemon.mechanics.abilities = [ability(slot, effect)];
  else if (slot === 'pokemon-body') pokemon.mechanics.effects = [effect];
  else definitions.find((card) => card.definitionId === slot).mechanics.effects = [effect];
}
async function profile(slot = 'attack', handlerId = HANDLER, extraHandlers = new Map()) {
  return fixture((definitions) => install(definitions, slot, binding(handlerId, action())), extraHandlers);
}
const rejectsPlacement = (makeFixture) =>
  assert.rejects(async () => board(await makeFixture()),
    (error) => error instanceof EngineError && error.code === 'unsupported-owned-attack-lock');

test('the standalone owned-attack-lock schema and production validators describe one fixed complete action', async () => {
  const schema = JSON.parse(await readFile(new URL('../../schemas/owned-attack-lock.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.$id, 'urn:pokemon-tcg:owned-attack-lock:1.0.0');
  assert.equal(typeof validateOwnedAttackLockAction, 'function');
  assert.equal(typeof validateOwnedAttackLockParameters, 'function');
  checkAction(action(), true, 'complete fixed action');
});

test('every owned-attack-lock field is required and no omitted field acquires a default', () => {
  for (const key of Object.keys(action()))
    checkAction(without(action(), key), false, `missing ${key}`);
  for (const value of [null, {}, [], 'disableOwnedAttack'])
    checkAction(value, false, `wrong root ${JSON.stringify(value)}`);
});

test('owned-attack-lock rejects other targets, sides, durations and clearing policies', () => {
  for (const [key, values] of [
    ['op', ['restriction', 'disableAttack', 'ownedAttackLock']],
    ['side', ['own', 'either', 'both', 'all', null, 1]],
    ['target', ['self', 'bench', 'any', 'event', null]],
    ['duration', ['nextOwnTurn', 'untilNextOwnTurnEnd', 'untilNextOpponentTurnEnd', null]],
    ['clearOnBench', [false, null, 1, 'true']],
    ['clearOnEvolution', [false, null, 1, 'true']],
  ]) for (const value of values)
    checkAction(action({ [key]: value }), false, `${key}=${JSON.stringify(value)}`);
});

test('client-selected attack IDs/references/names, tops, effective types and result/proof fields are forbidden', () => {
  for (const extra of [
    { attackIds: ['base:strike'] }, { attackId: 'base:strike' }, { ref: { attackId: 'base:strike' } },
    { reference: { instanceId: 'fixture:card', attackId: 'base:strike' } },
    { name: '测试撞击' }, { attackName: '测试撞击' }, { top: 'fixture:card' }, { topCardId: 'fixture:card' },
    { type: 'Water' }, { effectiveTypes: ['Water'] }, { pokemonId: 'fixture:mon' },
    { owner: 1 }, { selected: ['base:strike'] }, { performed: true }, { proof: {} }, { approved: true },
  ]) checkAction(action(extra), false, Object.keys(extra)[0]);
});

test('the native handler is resolve-only, declares exactly disableOwnedAttack and uses the full-action validator', () => {
  const handler = createCoreHandlers().get(HANDLER), parameters = action();
  assert(handler && Object.isFrozen(handler));
  assert.equal(handler.id, HANDLER); assert.equal(handler.rulesetId, 'CN/V20261019');
  assert.equal(handler.timing, 'resolve');
  assert.deepEqual(handler.operations, ['disableOwnedAttack']);
  assert.equal(handler.validateParameters, validateOwnedAttackLockParameters);
  assert.equal(handler.parameterSchemaRef, 'urn:pokemon-tcg:core-handler-parameters:1.0.0#/$defs/ownedAttackLock');
  assert.equal(typeof handler.implementationVersion, 'string'); assert(handler.implementationVersion.length);
  assert(handler.sourceOfTruth.length);
  for (const source of requireRule(CN_V20261019, 'attack.owned-lock').sourceOfTruth)
    assert(handler.sourceOfTruth.some((actual) => canonicalJSON(actual) === canonicalJSON(source)));
  assert.equal(handler.validateParameters(parameters), true);
  assert.deepEqual(handler.execute(null, parameters), [parameters]);
});

test('native parameters cannot wrap, omit op, or carry extra client state', () => {
  const handler = createCoreHandlers().get(HANDLER);
  for (const parameters of [{ action: action() }, { effect: action() },
    without(action(), 'op'), { ...action(), ignored: true }])
    assert.equal(handler.validateParameters(parameters), false);
});

test('an ordinary printed attack resolve body is a supported profile without preselecting the disabled attack', async () => {
  const f = await profile(), before = canonicalDefinition(f.catalog.definition('base'));
  const game = board(f);
  assert.equal(game.snapshot().pending, null);
  assert.equal(canonicalDefinition(f.catalog.definition('base')), before);
  assert.deepEqual(f.catalog.definition('base').mechanics.attacks[0].effects[0].parameters, action());
});

test('native owned-attack locks cannot be placed in Pokemon abilities/bodies, Trainers or Energy', async () => {
  for (const slot of ['activated', 'continuous', 'triggered', 'pokemon-body', 'potion', 'research', 'stadium', 'tool', 'double'])
    await rejectsPlacement(() => profile(slot));
});

test('custom IDs or metadata cannot widen owned-attack-lock timing and source placement', async () => {
  const native = createCoreHandlers().get(HANDLER);
  for (const timing of ['beforeDamage', 'damage', 'continuous', 'onUse']) {
    const id = `fixture:owned-lock:${timing}`;
    const handler = { ...native, id, timing };
    await rejectsPlacement(() => profile('attack', id, new Map([[id, handler]])));
  }
  const id = 'fixture:owned-lock:custom-resolve';
  const custom = { ...native, id, timing: 'resolve', capabilities: ['ordinary-attack-body'] };
  for (const slot of ['activated', 'triggered', 'potion', 'double'])
    await rejectsPlacement(() => profile(slot, id, new Map([[id, custom]])));
});

test('lasting and reaction protocols cannot smuggle an owned-attack lock, even in a skipped nested branch', async () => {
  const parameters = {
    side: 'opponent', target: 'active', effect: action(), duration: 'nextOpponentTurn',
    clearOnBench: true, clearOnEvolution: true,
  };
  assert.equal(validateLastingParameters(parameters), false);
  assert.equal(validateEffectProgram([{ op: 'lasting', ...parameters }]), false);
  assert.equal(REACTION_OPERATIONS.includes('disableOwnedAttack'), false);
  const deferred = {
    op: 'delayedReaction', side: 'own', target: 'self', trigger: trigger(),
    program: [{ op: 'then', first: { op: 'sequence', steps: [] }, next: action() }],
    duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true,
  };
  const reaction = createCoreHandlers().get('cn.delayedReaction@1');
  assert.doesNotThrow(() => assertEffectProgram([{ ...deferred, program: [{ op: 'draw', count: 1 }] }],
    reaction.operations, reaction.embeddedOperations), 'the ordinary deferred-program control is well formed');
  assert.throws(() => assertEffectProgram([deferred], reaction.operations, reaction.embeddedOperations),
    /Undeclared|No silent fallback/);
  const id = 'fixture:owned-lock:forged-reaction';
  const forged = { ...reaction, id, embeddedOperations: [...reaction.embeddedOperations, 'disableOwnedAttack'] };
  await rejectsPlacement(() => fixture((definitions) => {
    definitions[0].mechanics.attacks[0].effects = [binding(id, without(deferred, 'op'))];
  }, new Map([[id, forged]])));
});

test('the dedicated owned-attack ledger needs its receipt ID and is not a continuous/lasting/action description', () => {
  const entry = ledger(), handler = createCoreHandlers().get(HANDLER);
  assert.equal(validateOngoingEffect(entry), true, 'dedicated payload has its own ongoing branch');
  assert.equal(validateOngoingEffect(without(entry, 'ownedAttackLockId')), false);
  assert.equal(validateOngoingEffect({ ...entry, ownedAttackLockId: '' }), false);
  for (const effect of [
    without(entry.effect, 'reference'), { ...entry.effect, scope: 'self' },
    { ...entry.effect, attackIds: ['fixture:target-attack'] },
    { ...entry.effect, reference: without(entry.effect.reference, 'instanceId') },
    { ...entry.effect, reference: { ...entry.effect.reference, name: 'client-selected-name' } },
  ]) assert.equal(validateOngoingEffect({ ...entry, effect }), false);
  assert.equal(validateContinuousEffect(entry.effect), false);
  assert.equal(validateLastingParameters({
    side: 'opponent', target: 'active', effect: entry.effect, duration: entry.duration,
    clearOnBench: true, clearOnEvolution: true,
  }), false);
  assert.equal(validateEffectProgram([entry.effect]), false);
  assert.equal(handler.validateParameters(entry.effect), false);
  assert.deepEqual(handler.execute(null, action()), [action()], 'native output remains the action, never a ledger');
  const ordinary = { ...entry, effect: { op: 'modifier', field: 'defenseDamage', amount: -10, scope: 'all' } };
  assert.equal(validateOngoingEffect(ordinary), false, 'a receipt ID cannot be grafted onto another ledger family');
  assert.equal(validateOngoingEffect(without(ordinary, 'ownedAttackLockId')), true);
});

test('a shape-valid owned-attack ledger cannot authorize restoration without actual choice/applied/program receipts', async () => {
  const f = await profile(), game = board(f), snapshot = game.snapshot();
  const attacker = snapshot.players[0].active, target = snapshot.players[1].active;
  const sourceCard = attacker.stack.at(-1), targetCard = target.stack.at(-1);
  const printed = f.catalog.definition(snapshot.cards[sourceCard].definitionId);
  const sourceAttack = printed.mechanics.attacks[0], effect = sourceAttack.effects[0];
  const entry = ledger();
  Object.assign(entry, {
    targetId: target.id, source: {
      instanceId: sourceCard, owner: 0, cardOwner: 0, category: 'attack', origin: 'field',
      pokemonId: attacker.id, attackId: sourceAttack.attackId, effectId: effect.effectId,
      sourceOfTruth: effect.sourceOfTruth,
    },
    deadline: { player: 1, ownerTurn: snapshot.players[1].turns + 1, boundary: 'turn-end' },
  });
  entry.effect.reference = {
    instanceId: targetCard,
    attackId: f.catalog.definition(snapshot.cards[targetCard].definitionId).mechanics.attacks[0].attackId,
  };
  assert.equal(validateOngoingEffect(entry), true, 'actual source/target identities alone do not prove application');
  assert.deepEqual(OfficialGame.restore(snapshot, { catalog: f.catalog }).snapshot(), snapshot);
  const forged = structuredClone(snapshot); forged.ongoing.push(entry);
  const before = structuredClone(forged);
  assert.throws(() => OfficialGame.restore(forged, { catalog: f.catalog }),
    (error) => error instanceof EngineError && error.code === 'invalid-owned-attack-lock');
  assert.deepEqual(forged, before);
  assert.deepEqual(game.snapshot(), snapshot);
});

test('changing a fixed lock field invalidates old canonical approval; repinning still cannot authorize invalid parameters', async () => {
  const f = await profile(), original = f.definitions.find((card) => card.definitionId === 'base');
  const oldPin = canonicalDefinition(original);
  const context = { ruleset: RULESET, handlers: f.handlers,
    approvedDefinitions: new Map([[original.definitionId, oldPin]]) };
  assertExecutableDefinition(original, context);
  const changed = structuredClone(original);
  changed.mechanics.attacks[0].effects[0].parameters.clearOnBench = false;
  assert.notEqual(canonicalDefinition(changed), oldPin);
  assert.throws(() => assertExecutableDefinition(changed, context),
    (error) => error instanceof CardSchemaError && /independent approval|changed since review/.test(error.message));
  assert.throws(() => assertExecutableDefinition(changed, { ...context,
    approvedDefinitions: new Map([[changed.definitionId, canonicalDefinition(changed)]]) }), /Invalid parameters/);
  assert.equal(context.approvedDefinitions.get(original.definitionId), oldPin);
});

test('a complete catalog cannot reuse old definition pins after adding client attack identity to the lock', async () => {
  const f = await profile(), printings = f.catalog.printings();
  const context = {
    ruleset: RULESET, handlers: f.handlers, printings,
    approvedDefinitions: new Map(f.definitions.map((card) => [card.definitionId, canonicalDefinition(card)])),
    approvedPrintings: new Map(printings.map((printing) => [printing.printingId, canonicalPrinting(printing)])),
  };
  assert.equal((await createCardCatalog({ ...context, definitions: f.definitions })).id, f.catalog.id);
  const definitions = structuredClone(f.definitions);
  definitions.find((card) => card.definitionId === 'base').mechanics.attacks[0].effects[0].parameters.attackIds = ['base:strike'];
  await assert.rejects(createCardCatalog({ ...context, definitions }), /independent approval|changed since review/);
  assert.equal(Object.hasOwn(f.catalog.definition('base').mechanics.attacks[0].effects[0].parameters, 'attackIds'), false);
});
