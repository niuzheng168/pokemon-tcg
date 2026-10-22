import { validateGameCommand, validateGameState, validateContinuousEffect, validateEffectResolution,
  validateTriggerEvent, validateTriggerWindow, validateTriggerActivation, validateCheckupPlan, validateSuppressionEffect,
  validateEntryContext, validateEntryWindow, validateEntryUse, validateEntryFinish, validateDrawTask } from './schema-validators.js';
import { validateActivationRequest, validateActivationChoice, validatePaymentReceipt, validateAbilityUsage, validatePromotionChoice } from './schema-validators.js';
import { validateEnergyProvisionEffect, validateEnergyOption, validateAttackGrantEffect } from './schema-validators.js';
import { validateAttackPaymentChoice, validateAttackPaymentReceipt } from './schema-validators.js';
import { assertCatalog, canonicalJSON } from './catalog.js';
import { assertMatchFormat, validateFormatDeck, formatTrace } from './formats.js';
import { getRuleset } from './index.js';
import { requireRule, ruleTrace, violation, deepFreeze } from './registry.js';
import { calculateAttackDamage } from './damage.js';
import { emptyConditions, validateConditions, applyCondition, checkConditions, resolveConfusion, presentConditions, cureConditions } from './conditions.js';
import { validateRetreatPayment } from './energy.js';
import { selectionBounds, canSelectCount } from './selection.js';
import { randomIndex, shuffleIds, validateRandomState } from './random.js';
import { assertEffectProgram, assertEffectStep, beginEffectProgram, expandEffectStep, completeEffectStep, scaleEffect } from './effects.js';
import { createOngoingEffect, assertOngoingEffect, ongoingIsActive, expireOngoing,
  createPlayerOngoingEffect, assertPlayerOngoingEffect } from './ongoing.js';
import { triggerMatches, triggerRuleId, assertOwnerIndependence, assertSubjectProgram } from './triggers.js';
import { REACTION_OPERATIONS, createCoreHandlers } from './handlers.js';
import { resolveSuppression } from './suppression.js';
import { matchesCardSelector, matchesOnePerAlternative, selectorQuantityClass } from './card-selection.js';
import { acquisitionMatches } from './acquisition.js';
import { assertActivationCosts, costCardCount, findCostPayment, findCostPaymentWitness, readCostPayment, paymentOptionId } from './activation-cost.js';
import { resolveEnergyRequirements, meetsEnergyRequirement, resolveEnergyProvision, attachedEnergySelection } from './energy-mechanics.js';
import { attachedEnergyPool, energyRecipients } from './energy-selection.js';
import { evolutionRelation, evolutionTiming, transitionTargets, transitionCards, devolutionDepth } from './evolution.js';
import { fieldReturnTargets } from './field-return.js';
import { copyCandidates, attackOptionId } from './attack-copy.js';
import { grantReferences } from './attack-grant.js';
import { rollFailureCoin, assertFailureReceipt, groupImposedChecks } from './attack-failure.js';
import { createBattleHistory, assertBattleHistory, recordBattleTurn, recordBattleEvent, normalizeKnockoutEvent, hadKnockoutInPreviousOpponentTurn,
  wasMovedFromBenchToActiveThisTurn, wasSupporterPlayedFromHandThisTurn, wasHealedThisTurn, BATTLE_HISTORY_RULES } from './battle-history.js';
import { resolveBurnCounters } from './checkup-effects.js';
import { attackCommitmentPool, canPayAttackCommitment, resolveAttackCommitment } from './attack-commitments.js';
import { inspectDeckWindow, planDeckInspection, deckInspectionNeedsShuffle } from './deck-window.js';
import { deckEnergyWindow, deckEnergyDestinations, validateDeckEnergyPlan, DECK_ENERGY_HAND } from './deck-energy.js';
import { validatePokemonTypesEffect } from './schema-validators.js';
import { resolveSourceTraits } from './source-traits.js';
import { matchesInPlaySelector, matchesPokemonState } from './in-play-selection.js';
import { evaluateDamageValue, evaluateBattleValue, battleQueryKey, BATTLE_VALUE_QUERY_KINDS } from './battle-value.js';
import { evaluateBattlePredicate, BATTLE_PREDICATE_QUERY_KINDS } from './battle-predicate.js';
import { queryPrizesTaken } from './prize-count.js';
import { assertDamageCoinSpec, rollDamageCoin, assertDamageCoinReceipt } from './damage-coins.js';
import { validateDamageRollPlans } from './schema-validators.js';
import { validateTrainerFinish, validatePrizeExchangeEvent, validateHealingChoice, validateCounterChoice } from './schema-validators.js';
import { prizeExchangeWindow, planPrizeExchange } from './prize-exchange.js';
import { planHandBottom } from './hand-bottom.js';
import { healingWindow, planPokemonHealing } from './healing.js';
import { counterDistributionWindow, assertCounterDistributionAllocation, planCounterDistribution } from './counter-distribution.js';
import { assertEffectExecutionEvent, beginEffectExecution, advanceEffectExecution,
  replayEffectExecution } from './effect-execution.js';
import { assertSelectionRequestEvent, selectionRequestEvent, hasSelectionRequestPayload } from './selection-request.js';
import { discardDestination } from './discard-policy.js';
import { stadiumWindow, planDiscardStadium, matchesStadiumProtection } from './field-cards.js';
import { ownedAttackLockWindow, planOwnedAttackLock } from './owned-attack-lock.js';
import { validateOwnedAttackChoice, validateOwnedAttackLockEvent, validateOwnedAttackLockClearEvent } from './schema-validators.js';

const PROTOCOL = 'CN-game-dev-25';
const clone = (v) => structuredClone(v);
// Snapshots are a JSON value protocol. Shared JS object references must not
// acquire semantics that disappear after serializing/restoring the same value.
const copyState = (s) => JSON.parse(JSON.stringify(s));
const tasks = (op, data = {}) => ({ op, data });
const flags = () => ({ energy: false, retreat: false, supporter: false, stadium: false });
const mons = (p) => [p.active, ...p.bench].filter(Boolean);
const allMons = (s) => s.players.flatMap((p, owner) => mons(p).map((m) => ({ owner, m })));
const top = (m) => m.stack.at(-1);
const cardDef = (s, catalog, id) => catalog.definition(s.cards[id]?.definitionId);
function battleFact(s, event) {
  const ruleId = { fieldTransition: 'history.field-transition', turnEnded: 'history.turn-ended' }[event.kind];
  if (ruleId) requireRule(getRuleset(s.ruleset), ruleId);
  s.battleHistory = recordBattleEvent(s.battleHistory, { ...event, turn: s.turn, during: s.current },
    { turn: s.turn, during: s.current });
}
const knockoutFact = (item) => ({
  kind: 'ko', owner: item.owner, pokemonId: item.id, turn: item.turn, during: item.during, cause: clone(item.cause),
});
const monDef = (s, catalog, m) => cardDef(s, catalog, top(m));
const sourceNodeId = (kind, instanceId, key = null) => canonicalJSON([kind, instanceId, key]);
function attacksFor(s, catalog, m, model = sourceModel(s, catalog)) {
  const out = [
    ...monDef(s, catalog, m).mechanics.attacks.map((attack) => ({
      attack, instanceId: top(m), referenceId: canonicalJSON(['native', top(m), attack.attackId]), grant: null,
    })),
    ...m.tools.filter((id) => model.availability.get(sourceNodeId('tool', id)).enabled)
      .flatMap((id) => (cardDef(s, catalog, id).mechanics.grantedAttacks || []).map((attack) => ({
        attack, instanceId: id, referenceId: canonicalJSON(['tool', id, attack.attackId]), grant: null,
      }))),
  ];
  const owner = s.cards[top(m)].owner, definitions = catalog.definitionRecord();
  for (const entry of model.attackGrants) {
    const ctx = { state: s, definitions, source: entry.source, effectivePokemon: model.pokemon };
    for (const reference of grantReferences(ctx, entry.spec, owner, m)) {
      const referenceId = canonicalJSON(['grant', entry.id, m.id, reference.instanceId, reference.attackId]);
      out.push({ attack: copiedAttack(s, catalog, reference), instanceId: top(m), referenceId,
        grant: { reference, key: referenceId, provider: {
          source: clone(entry.source), descriptorId: entry.id, specification: clone(entry.spec),
        } } });
    }
  }
  return out;
}
const findMon = (s, id) => allMons(s).find(({ m }) => m.id === id);
const remove = (array, id) => {
  const i = array.indexOf(id);
  if (i < 0) throw new EngineError('invalid-location', `Card not at the required location: ${id}`);
  array.splice(i, 1);
};
const enqueue = (s, ...work) => s.queue.push(...work);
const prepend = (s, ...work) => s.queue.unshift(...work);
const withoutSelection = ({ selected, ...rest }) => rest;
const energyHolder = (action, source) => action.side === 'own' ? source.owner : 1 - source.owner;
const SUPPORTED_TIMINGS = new Set(['resolve', 'beforeDamage', 'damage', 'continuous', 'suppression', 'pokemonTypes', 'energyProvision', 'energyOptions', 'attackGrant', 'permission', 'formula', 'onUse', 'damageOptions']);
const CONTINUOUS_OPS = new Set(['modifier', 'protection', 'stadiumProtection', 'property', 'restriction', 'playerRestriction', 'energyRequirement', 'burnCounters', 'benchLimit']);
const LOCAL_EFFECTS = new Set(['counters', 'heal', 'condition', 'lasting', 'delayedReaction', 'sequence', 'then', 'optional']);
const SUPPORTED_EFFECTS = new Set(['draw', 'discardHand', 'counters', 'heal', 'condition', 'switch', 'attachDiscard', 'attachHand',
  'transferCounters', 'lasting', 'lastingPlayer', 'delayedReaction', 'damage', 'suppression', 'cards', 'shuffle',
  'deployIncoming', 'attachIncoming', 'energyProvision', 'discardEnergy', 'moveEnergy', 'returnEnergy', 'returnPokemon',
  'evolvePokemon', 'devolvePokemon', 'inheritPokemon', 'copyAttack', 'attackGrant',
  'inspectDeck', 'attachDeckEnergy', 'pokemonTypes', 'exchangePrizes', 'shuffleHandToBottom', 'healPokemon', 'distributeCounters', 'discardStadium', 'disableOwnedAttack',
  'shuffleHandIntoDeck', 'sequence', 'then', 'optional', 'coin', 'orElse', 'discardDeckTop', 'replacePokemon', 'knockOut', 'discardTools',
  'opponentHand', 'coins', 'coinResult', 'when', 'arrangeDeck', 'cure', ...CONTINUOUS_OPS]);
// II.B-02: counted before-damage moves (or a look at the opponent's hand), and the cards each may record.
const COUNTED_OPERATIONS = [['discardEnergy'], ['discardTools'], ['cards'], ['opponentHand'],
  ['optional', 'sequence', 'discardEnergy', 'returnEnergy', 'discardTools', 'cards', 'discardStadium']];
const CHOICE_RESUMES = new Set(['choose-order', 'setup-active', 'setup-bench', 'bonus', 'award', 'promote',
  'retreat-paid', 'finish-retreat', 'attach-tool', 'effect-choice', 'trigger-window', 'trigger-execute', 'checkup-plan',
  'entry-window', 'entry-use', 'activation-choice', 'attack-payment', 'bench-trim']);
const NATIVE_CHANGE_HANDLERS = new Set([
  'cn.distributeCounters@1', 'cn.healPokemon@1', 'cn.switch@1', 'cn.heal@1', 'cn.counters@1', 'cn.discardStadium@1', 'cn.discardTools@1',
]);
// These installed native producers return their constant reviewed parameters.
// A custom field provider is NOT assumed independent of discarded hand cards.
const CONSTANT_FIELD_HANDLERS = new Set([
  'cn.modifier@1', 'cn.protection@1', 'cn.property@1', 'cn.restriction@1', 'cn.playerRestriction@1',
  'cn.burnCounters@1', 'cn.energyRequirement@1', 'cn.energyProvision@1', 'cn.pokemonTypes@1',
  'cn.suppression@1', 'cn.attackGrant@1', 'cn.stadiumProtection@1', 'cn.benchLimit@1',
]);
const NATIVE_EXECUTION_CONTRACTS = new Map([...createCoreHandlers()]
  .map(([id, h]) => [id, { timing: h.timing, execute: Function.prototype.toString.call(h.execute),
    validateParameters: h.validateParameters,
    canUse: typeof h.canUse === 'function' ? Function.prototype.toString.call(h.canUse) : null,
    canUseWithCosts: typeof h.canUseWithCosts === 'function' ? Function.prototype.toString.call(h.canUseWithCosts) : null }]));
function canonicalNativeExecution(h) {
  const known = NATIVE_EXECUTION_CONTRACTS.get(h.id);
  return !!known && known.timing === h.timing && known.execute === Function.prototype.toString.call(h.execute);
}
function constantFieldExecution(h) {
  return CONSTANT_FIELD_HANDLERS.has(h.id) && canonicalNativeExecution(h);
}
function canonicalNativeActivation(h) {
  const known = NATIVE_EXECUTION_CONTRACTS.get(h.id);
  return canonicalNativeExecution(h) && known.validateParameters === h.validateParameters &&
    typeof h.canUse === 'function' && known.canUse === Function.prototype.toString.call(h.canUse) &&
    typeof h.canUseWithCosts === 'function' && known.canUseWithCosts === Function.prototype.toString.call(h.canUseWithCosts);
}

// A handler may derive the printed use limit from the card's own reviewed binding.
function handlerUsage(catalog, b) {
  const h = catalog.handler(b.handlerId);
  return typeof h.usageFor === 'function' ? h.usageFor(clone(b.parameters)) : h.usage;
}
function stadiumUsages(catalog, bindings) {
  const uses = new Map();
  for (const b of bindings) {
    const usage = handlerUsage(catalog, b);
    if (usage === undefined || usage === null) continue;
    if (!validateAbilityUsage(usage) || (usage.period === 'unlimited' ? usage.limit !== null : usage.limit === null))
      throw new EngineError('invalid-usage', 'Stadium activation needs explicit, valid usage semantics.');
    if (uses.has(usage.key) && canonicalJSON(uses.get(usage.key)) !== canonicalJSON(usage))
      throw new EngineError('conflicting-usage', 'A shared Stadium use must have one consistent limit.');
    uses.set(usage.key, usage);
  }
  return uses;
}

// Until a mechanism is actually implemented, registration/approval must not
// turn a missing timing into a silently ignored effect. These staging guards
// are removed/expanded together with implementation AND its conformance tests.
// Exported so authoring tools apply the same game-load guard before admitting a card.
// A use condition, or a count outside an attack, is judged with no damaged target,
// coin or counted effect, and without a Prizes-taken query (whose CN count may need
// a ruling); a Trainer has no "this Pokémon".
// A continuous condition (noStats) has only query answers: no HP/Energy stat read or existence test.
function assertUseTimeFacts(predicate, trainer, noStats = false) {
  const holders = trainer ? ['ownActive', 'opponentActive'] : ['self', 'ownActive', 'opponentActive'];
  (function walk(node) {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    if (['coin', 'effectCards', 'movedCards', 'prizes'].includes(node.kind) || Object.hasOwn(node, 'who') && !holders.includes(node.who) ||
        noStats && (node.kind === 'exists' || node.kind === 'pokemon' && Object.hasOwn(node, 'who')) ||
        trainer && (node.excludeSelf || node.kind === 'historyFact' && ['movedToActive', 'healed', 'evolvedThisTurn'].includes(node.fact)))
      throw new EngineError('unsupported-condition', 'A use condition or non-attack count can read only facts that exist when it is judged.');
    Object.values(node).forEach(walk);
  })(predicate);
}
// II.C-20: the opponent's hand faces are known only once a printed look shows them.
// A count of them is read only by a later step of the same Trainer/Ability program;
// an attack counts what its own before-damage look recorded (movedCards).
const coinKeys = (node) => Array.isArray(node) ? node.flatMap(coinKeys) : !node || typeof node !== 'object' ? [] :
  [...(node.kind === 'coin' ? [node.key] : []), ...Object.values(node).flatMap(coinKeys)];
const readsHiddenHand = (node) => node.kind === 'zoneCount' && node.side === 'opponent' && node.zone === 'hand' && Object.hasOwn(node, 'selector');
function assertHiddenHandReads(catalog, m) {
  const looked = new Set();
  for (const program of [m.effects ?? [], ...(m.abilities ?? []).map((a) => a.effects)])
    program.forEach((b, i) => {
      if (catalog.handler(b.handlerId).capabilities?.includes('battle-values') &&
          program.slice(0, i).some((e) => e.handlerId === 'cn.opponentHand@1' && e.parameters.mode === 'look')) looked.add(b);
    });
  (function walk(node) {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object' || looked.has(node)) return;
    if (readsHiddenHand(node))
      throw new EngineError('unsupported-condition', 'The opponent\'s hand faces are counted only after a printed look at them earlier in the same program.');
    Object.values(node).forEach(walk);
  })(m);
}
export function assertSupportedDefinition(catalog, definition) {
  const m = definition.mechanics;
  assertHiddenHandReads(catalog, m);
  if (m.condition?.predicate) assertUseTimeFacts(m.condition.predicate, true);
  for (const a of m.abilities || []) if (a.condition?.predicate) assertUseTimeFacts(a.condition.predicate, false);
  for (const a of [...(m.attacks || []), ...(m.grantedAttacks || [])]) if (a.failureCheck?.predicate) assertUseTimeFacts(a.failureCheck.predicate, false);
  // 「如果…，则…」 reads the board when reached; only a Pokémon has 「这只宝可梦」.
  for (const b of [...(m.effects || []), ...(m.abilities || []).flatMap((a) => a.effects),
    ...[...(m.attacks || []), ...(m.grantedAttacks || [])].flatMap((a) => a.effects)])
    if (catalog.handler(b.handlerId).capabilities?.includes('board-condition')) assertUseTimeFacts(b.parameters.condition, definition.kind !== 'pokemon');
  for (const b of [...(m.effects || []), ...(m.abilities || []).flatMap((a) => a.effects)]) {
    const h = catalog.handler(b.handlerId), spec = b.parameters.effect ?? b.parameters;
    if (h.capabilities?.includes('battle-values')) assertUseTimeFacts(b.parameters, definition.kind === 'trainer');
    // A Stadium has no Pokémon of its own; a Tool or Energy reads its holder as self.
    if (h.timing === 'continuous' && spec.condition) assertUseTimeFacts(spec.condition, m.category === 'stadium', true);
  }
  for (const attack of [...(m.attacks || []), ...(m.grantedAttacks || [])]) if (attack.failureCheck &&
      attack.effects.some((b) => catalog.handler(b.handlerId).timing === 'beforeDamage'))
    throw new EngineError('unsupported-failure-timing', 'Combining a self-failure check with before-damage effects needs reviewed CN timing, not speculative rollback.');
  // II.E-38 文例3: a later effect reads only coins this attack's damage always flips.
  for (const attack of [...(m.attacks || []), ...(m.grantedAttacks || [])]) {
    const rolled = attack.effects.filter((b) => catalog.handler(b.handlerId).capabilities?.includes('damage-rolls'))
      .flatMap((b) => (b.parameters.rolls ?? []).filter((r) => !r.condition).map((r) => r.key));
    for (const b of attack.effects) if (catalog.handler(b.handlerId).capabilities?.includes('damage-roll-results') &&
        coinKeys(b.parameters.condition).some((key) => !rolled.includes(key)))
      throw new EngineError('unsupported-condition', 'A coin result reads only rolls this attack\'s damage flips unconditionally.');
  }
  if (['special', 'V-UNION'].includes(m.stage))
    throw new EngineError('unsupported-deployment', 'This special deployment mechanism is not implemented yet.');
  const bodyTimings = definition.kind === 'pokemon' ? ['continuous', 'pokemonTypes', 'attackGrant'] : definition.kind === 'energy' ? ['continuous', 'pokemonTypes', 'energyProvision', 'attackGrant'] :
    m.category === 'tool' ? ['continuous', 'suppression', 'pokemonTypes', 'energyProvision', 'attackGrant'] : m.category === 'stadium' ? ['continuous', 'suppression', 'pokemonTypes', 'energyProvision', 'attackGrant', 'onUse'] : ['resolve'];
  if (definition.kind === 'trainer' && !['tool', 'stadium'].includes(m.category) &&
      m.effects.some((b) => b.trigger && b.trigger.event !== 'beforeHand'))
    throw new EngineError('unsupported-trigger-zone', 'A resolving Item/Supporter is not an in-play trigger source.');
  const placements = [
    ...(m.effects || []).map((b) => ({ b, trigger: b.trigger, costs: b.trigger ? b.activationCosts :
      b.activationCosts ?? (definition.kind === 'trainer' && !['tool', 'stadium'].includes(m.category) ? m.playCosts : null),
      allowed: b.trigger && (b.trigger.event === 'beforeHand' || definition.kind !== 'trainer' || ['tool', 'stadium'].includes(m.category)) ? ['resolve'] : bodyTimings })),
    ...[...(m.attacks || []), ...(m.grantedAttacks || [])].flatMap((a) =>
      a.effects.map((b) => ({ b, attack: true, allowed: ['resolve', 'beforeDamage', 'damage', 'formula', 'permission', 'damageOptions', 'energyOptions'] }))),
    ...(m.abilities || []).flatMap((a) => a.effects.map((b) =>
      ({ b, trigger: a.trigger, costs: a.costs, allowed: a.mode === 'continuous' ? ['continuous', 'suppression', 'pokemonTypes', 'energyProvision', 'attackGrant'] : ['resolve'] }))),
  ];
  if (definition.kind === 'trainer' && m.category === 'stadium') {
    const onUse = m.effects.filter((b) => catalog.handler(b.handlerId).timing === 'onUse');
    stadiumUsages(catalog, onUse);
    const costs = onUse.flatMap((b) => b.activationCosts ?? []);
    if (costs.length) {
      assertActivationCosts(costs);
      if (onUse.some((b) => {
        const h = catalog.handler(b.handlerId);
        return typeof h.canUseWithCosts !== 'function' || !h.costCheckVersion || typeof h.canUse !== 'function';
      })) throw new EngineError('unsupported-cost-check', 'Every part of a paid Stadium activation needs a reviewed cost eligibility proof.');
    }
  }
  for (const { b, allowed, trigger, attack, costs } of placements) {
    const h = catalog.handler(b.handlerId);
    const timing = h.timing || 'resolve';
    if (h.embeddedOperations?.includes('disableOwnedAttack') ||
        h.operations?.includes('disableOwnedAttack') && (!attack || timing !== 'resolve' || trigger || b.trigger))
      throw new EngineError('unsupported-owned-attack-lock', 'A chosen owned-attack lock requires an actual attack resolve body, not another activation or reaction.');
    if (h.capabilities?.includes('effect-card-count') && (!attack || timing !== 'beforeDamage' ||
        !COUNTED_OPERATIONS.some((ops) => canonicalJSON(h.operations) === canonicalJSON(ops))))
      throw new EngineError('unsupported-effect-count', 'A counted effect is an attack’s own before-damage discard of Energy, Tools or cards.');
    if (Array.isArray(h.operations) && h.operations.includes('stadiumProtection') &&
        (definition.kind !== 'trainer' || m.category !== 'stadium'))
      throw new EngineError('unsupported-protection-subject', 'A Stadium self-card protection must be provided by that Stadium, not a Pokemon or attachment.');
    if (definition.kind === 'trainer' && m.category === 'stadium' && h.id === 'cn.protection@1' &&
        canonicalNativeExecution(h) && b.parameters.effect.scope === 'self')
      throw new EngineError('unsupported-protection-subject', 'Protecting a Stadium card itself needs a field-card subject, not a Pokemon self scope.');
    if (b.activationCosts && (!trigger && timing !== 'onUse' || attack))
      throw new EngineError('unsupported-cost-placement', 'Binding costs require their own trigger or Stadium activation.');
    if (costs && (typeof h.canUse !== 'function' || typeof h.canUseWithCosts !== 'function' || !h.costCheckVersion))
      throw new EngineError('unsupported-cost-check', `A cost-bearing activation needs an explicitly reviewed post-cost eligibility proof: ${b.handlerId}`);
    if (!SUPPORTED_TIMINGS.has(timing) || !allowed.includes(timing) || !Array.isArray(h.operations) || h.operations.some((op) => !SUPPORTED_EFFECTS.has(op)) ||
        (h.operations.some((op) => CONTINUOUS_OPS.has(op)) && timing !== 'continuous') ||
        (timing === 'continuous' && h.operations.some((op) => !CONTINUOUS_OPS.has(op))) ||
        (h.operations.includes('suppression') && timing !== 'suppression') ||
        (timing === 'suppression' && h.operations.some((op) => op !== 'suppression')) ||
        (h.operations.includes('pokemonTypes') && timing !== 'pokemonTypes') ||
        (timing === 'pokemonTypes' && h.operations.some((op) => op !== 'pokemonTypes')) ||
        (h.operations.includes('energyProvision') && timing !== 'energyProvision') ||
        (timing === 'energyProvision' && h.operations.some((op) => op !== 'energyProvision')) ||
        (h.operations.includes('attackGrant') && timing !== 'attackGrant') ||
        (timing === 'attackGrant' && h.operations.some((op) => op !== 'attackGrant')) ||
        (timing === 'energyOptions' && typeof h.energyOptions !== 'function') ||
        (timing === 'permission' && typeof h.permissions !== 'function') ||
        (timing === 'formula' && typeof h.damageFormula !== 'function') ||
        ((h.damageRolls !== undefined || h.capabilities?.includes('damage-rolls')) &&
          (!attack || !['formula', 'damage'].includes(timing) || h.damageRollVersion !== '1' ||
            typeof h.damageRolls !== 'function' || !h.capabilities?.includes('damage-rolls'))) ||
        (timing === 'damageOptions' && typeof h.damageOptions !== 'function') ||
        (['permission', 'formula', 'damageOptions', 'energyOptions'].includes(timing) && h.operations.length > 0) ||
        (h.operations.includes('damage') && !attack) ||
        (h.capabilities?.includes('damage-roll-results') && !attack) ||
        (h.operations.includes('copyAttack') && (!attack || timing !== 'resolve')) ||
        (h.operations.includes('exchangePrizes') &&
          (attack || definition.kind !== 'trainer' || !['item', 'supporter'].includes(m.category))) ||
        (h.operations.includes('returnPokemon') && timing === 'beforeDamage') ||
        (h.operations.some((op) => ['deployIncoming', 'attachIncoming'].includes(op)) && trigger?.event !== 'beforeHand') ||
        (h.operations.includes('deployIncoming') && definition.kind !== 'pokemon') ||
        (h.operations.includes('attachIncoming') && definition.kind !== 'energy') ||
        (timing === 'damage' && h.operations.some((op) => !['damage', 'sequence', 'then', 'optional'].includes(op))) ||
        (h.embeddedOperations && h.embeddedOperations.some((op) => !REACTION_OPERATIONS.includes(op))) ||
        (b.trigger && !trigger) || (trigger && timing !== 'resolve') ||
        (trigger?.scope === 'subject' && h.operations.some((op) => !LOCAL_EFFECTS.has(op))))
      throw new EngineError('unsupported-handler', `Unimplemented or undeclared handler timing/operations: ${b.handlerId}`);
  }
}

function assertJSON(value, path = '$', seen = new Set()) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object' || seen.has(value) ||
      (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))))
    throw new EngineError('non-json-state', `Non-serializable snapshot value: ${path}`);
  seen.add(value);
  for (const [key, child] of Array.isArray(value) ? [...value.entries()] : Object.entries(value))
    assertJSON(child, `${path}/${key}`, seen);
  seen.delete(value);
}

export class EngineError extends Error {
  constructor(code, message, details = {}) {
    super(message); this.name = 'EngineError'; this.code = code; this.details = clone(details);
  }
}

function log(s, ruleId, data = {}, visibility = 'public') {
  requireRule(getRuleset(s.ruleset), ruleId);
  s.events.push({ ruleId, visibility, data: clone(data) });
}
function fail(s, ruleId, message) { throw violation(getRuleset(s.ruleset), ruleId, message); }
function draw(s, player, count) {
  const p = s.players[player], out = [];
  for (let i = 0; i < count && p.deck.length; i++) { const id = p.deck.pop(); p.hand.push(id); out.push(id); }
  log(s, 'effects.draw', { player, count: out.length });
  return out;
}
function discard(s, catalog, id) {
  const owner = s.cards[id].owner, definition = cardDef(s, catalog, id), destination = discardDestination(definition);
  s.players[owner][destination].push(id);
  if (destination === 'lost') log(s, 'cards.prism-star', { kind: 'discard-replaced', cardId: id, owner,
    destination, sourceOfTruth: definition.prismStar.sourceOfTruth });
  return destination;
}
function cardWindow(s, a, source) {
  const zone = s.players[source.owner][a.from];
  return a.from === 'deck' && a.lookTop !== null ? zone.slice(-a.lookTop) : [...zone];
}
const deckOperation = (a) => ['inspectDeck', 'attachDeckEnergy'].includes(a.op);
function deckWindow(s, catalog, d) {
  const ctx = effectContext(s, catalog, d.source, d.event ?? null);
  if (d.action.op === 'inspectDeck') return { ...inspectDeckWindow(ctx, d.action), status: 'ready' };
  const window = deckEnergyWindow(ctx, d.action);
  if (window.status === 'needsRuling')
    throw new EngineError('unresolved-deck-energy-receiver', 'CN evidence is still required for inspecting a nonempty deck without an eligible Energy recipient.');
  return { ...window, window: [...window.lookedAt].reverse(), eligible: window.candidates };
}
function beginDeckChoice(s, catalog, d) {
  const w = deckWindow(s, catalog, d);
  const choice = { id: `deck${++s.serial}`, turn: s.turn, deck: [...s.players[d.source.owner].deck],
    window: [...w.window], chosen: [], assignments: [] };
  log(s, 'effects.search', { kind: 'requested', id: choice.id, turn: s.turn,
    deck: choice.deck, window: choice.window, action: d.action, source: d.source }, 'private');
  return choice;
}
function deckChoicePrompt(s, catalog, d) {
  const w = deckWindow(s, catalog, d);
  if (d.stage !== 'deck-energy-destination') return { options: w.eligible, ...w.bounds };
  const options = deckEnergyDestinations(effectContext(s, catalog, d.source, d.event ?? null), d.action,
    d.deckChoice.chosen, d.deckChoice.assignments);
  return { options, minimum: 1, maximum: 1, allowZero: false };
}
/** The live deck stays untouched during all private choices; no escrow or
 * guessed reconstruction of a partially moved window is needed on restore. */
function assertDeckChoice(s, catalog, d, pending = null) {
  if (d.local) throw new EngineError('invalid-deck-choice', 'Deck work is a global board operation, not a subject-local trigger action.');
  const c = d.deckChoice;
  if (!c) {
    if (pending || d.stage || Object.hasOwn(d, 'selected'))
      throw new EngineError('invalid-deck-choice', 'Unstarted deck work cannot contain a preselected answer or stage.');
    return;
  }
  const requested = s.events.filter((e) => e.ruleId === 'effects.search' && e.data.kind === 'requested' && e.data.id === c.id);
  const expected = { kind: 'requested', id: c.id, turn: s.turn, deck: c.deck, window: c.window, action: d.action, source: d.source };
  const w = deckWindow(s, catalog, d), selecting = d.stage !== 'deck-energy-destination';
  if (c.turn !== s.turn || requested.length !== 1 || requested[0].visibility !== 'private' ||
      s.events.some((e) => e.ruleId === 'effects.search' && e.data.kind === 'resolved' && e.data.id === c.id) ||
      canonicalJSON(requested[0].data) !== canonicalJSON(expected) ||
      canonicalJSON(c.deck) !== canonicalJSON(s.players[d.source.owner].deck) ||
      canonicalJSON(c.window) !== canonicalJSON(w.window) ||
      d.action.op === 'inspectDeck' && d.stage !== 'inspect-select' ||
      d.action.op === 'attachDeckEnergy' && !['deck-energy-select', 'deck-energy-destination'].includes(d.stage) ||
      selecting && (c.chosen.length || c.assignments.length))
    throw new EngineError('invalid-deck-choice', 'Private deck work must retain its exact original request, source, turn and untouched window.');
  const selected = s.events.filter((e) => e.ruleId === 'effects.search' && e.data.kind === 'selected' && e.data.id === c.id);
  const allocated = s.events.filter((e) => e.ruleId === 'effects.attach' && e.data.kind === 'allocated' && e.data.id === c.id);
  if (selecting ? selected.length || allocated.length : selected.length !== 1 ||
      selected[0].visibility !== d.source.owner || canonicalJSON(selected[0].data.selected) !== canonicalJSON(c.chosen) ||
      !canSelectCount(w.bounds, c.chosen.length) || !c.chosen.length || c.chosen.some((id) => !w.eligible.includes(id)) ||
      c.assignments.length >= c.chosen.length ||
      d.action.distribution === 'singleRecipient' && c.assignments.length > 0 ||
      allocated.some((e) => e.visibility !== d.source.owner) ||
      canonicalJSON(allocated.flatMap((e) => e.data.assignments)) !== canonicalJSON(c.assignments) ||
      c.assignments.some((a, i) => a.instanceId !== c.chosen[i] ||
        !(w.recipientIds.includes(a.targetId) || d.action.toHand && a.targetId === DECK_ENERGY_HAND)))
    throw new EngineError('invalid-deck-choice', 'Selected cards and recipient allocations must retain their private answer receipts.');
  if (pending) {
    const prompt = deckChoicePrompt(s, catalog, d);
    if (pending.player !== d.source.owner || Object.hasOwn(d, 'selected') ||
        pending.kind !== (selecting ? 'inspect-deck' : 'deck-energy-recipient') ||
        pending.ruleId !== (selecting ? 'effects.search' : 'effects.attach') ||
        ['options', 'minimum', 'maximum', 'allowZero'].some((key) => canonicalJSON(pending[key]) !== canonicalJSON(prompt[key])))
      throw new EngineError('invalid-deck-choice', 'A deck prompt must retain its actual owner, current choices and CN quantity bounds.');
  }
}
function shuffleZone(s, player, zone, source) {
  const cards = s.players[player][zone];
  if (!cards.length) return false;
  shuffleIds(s.rng, cards);
  log(s, 'effects.shuffle', { player, zone, count: cards.length, effectId: source.effectId });
  return true; // E-36: a single card still counts as shuffled.
}
function prizeCompletion(s, source) {
  const trainers = s.queue.filter((t) => t.op === 'finish-trainer' &&
    t.data.player === source.owner && t.data.cardId === source.instanceId);
  if (trainers.length === 1) return { kind: 'trainer', id: trainers[0].data.completionId };
  const entries = s.queue.filter((t) => t.op === 'entry-finish' &&
    t.data.entry.player === source.owner && t.data.entry.cardId === source.instanceId);
  if (entries.length === 1) return { kind: 'entry', id: entries[0].data.entry.id };
  throw new EngineError('invalid-prize-exchange', 'A self-exchanging Trainer needs its actual outstanding resolution finalizer.');
}
function assertPrizeChoice(s, catalog, d, pending = null) {
  if (d.local) throw new EngineError('invalid-prize-exchange', 'Prize inspection is a global private-zone operation, not a subject-local lane.');
  const choice = d.prizeChoice;
  if (!choice) {
    if (pending || Object.hasOwn(d, 'selected'))
      throw new EngineError('invalid-prize-exchange', 'A prize answer cannot omit its original inspection receipt.');
    return;
  }
  const window = prizeExchangeWindow(effectContext(s, catalog, d.source), d.action);
  const requests = s.events.filter((e) => e.ruleId === 'effects.prize-exchange' &&
    e.data.kind === 'requested' && e.data.id === choice.id);
  if (choice.turn !== s.turn || choice.sourceId !== d.source.instanceId ||
      canonicalJSON(choice.prizes) !== canonicalJSON(window.window) ||
      canonicalJSON(choice.completion) !== canonicalJSON(prizeCompletion(s, d.source)) ||
      requests.length !== 1 || requests[0].visibility !== 'private' ||
      canonicalJSON(requests[0].data) !== canonicalJSON({
        kind: 'requested', id: choice.id, source: d.source, action: d.action, choice,
      }) ||
      s.events.some((e) => e.ruleId === 'effects.prize-exchange' && e.data.kind === 'resolved' && e.data.id === choice.id))
    throw new EngineError('invalid-prize-exchange', 'Inspection must retain its original source, exact Prize zone, turn, finalizer and private request.');
  if (pending && (pending.player !== d.source.owner || pending.kind !== 'prize-exchange' ||
      pending.ruleId !== 'effects.prize-exchange' || Object.hasOwn(d, 'selected') ||
      canonicalJSON(pending.options) !== canonicalJSON(window.eligible) ||
      ['minimum', 'maximum', 'allowZero'].some((key) => pending[key] !== window.bounds[key])))
    throw new EngineError('invalid-prize-exchange', 'The Prize prompt must retain the actual user and CN hidden-selection bounds.');
}
function assertTrainerFinish(s, catalog, d) {
  if (!validateTrainerFinish(d) || s.cards[d.cardId]?.owner !== d.player ||
      !['item', 'supporter'].includes(cardDef(s, catalog, d.cardId).mechanics.category))
    throw new EngineError('invalid-trainer-finish', 'A Trainer finalizer must retain its original owned Item/Supporter.');
  const opened = s.events.filter((e) => e.ruleId === 'turn.trainer' &&
    e.data.kind === 'trainer-open' && e.data.id === d.completionId);
  const latestUse = s.events.filter((e) => e.ruleId === 'turn.trainer' &&
    e.data.kind === 'trainer-open' && e.data.cardId === d.cardId).at(-1);
  if (opened.length !== 1 || opened[0].visibility !== 'public' || canonicalJSON(opened[0].data) !== canonicalJSON({
    kind: 'trainer-open', id: d.completionId, player: d.player, cardId: d.cardId, turn: s.turn,
  }) || latestUse !== opened[0] ||
      s.events.some((e) => e.ruleId === 'turn.trainer' && e.data.kind === 'trainer-finished' && e.data.id === d.completionId))
    throw new EngineError('invalid-trainer-finish', 'A finalizer cannot borrow an earlier or already completed use of the same physical Trainer.');
  if (!s.players[d.player].resolving.includes(d.cardId)) {
    const swaps = s.events.filter((e) => e.ruleId === 'effects.prize-exchange' && e.data.kind === 'resolved' &&
      e.data.sourceId === d.cardId && e.data.player === d.player &&
      e.data.completion?.kind === 'trainer' && e.data.completion.id === d.completionId &&
      Array.isArray(e.data.selected) && e.data.selected.length === 1);
    if (swaps.length !== 1 || swaps[0].visibility !== 'private')
      throw new EngineError('invalid-trainer-finish', 'Only the completed self-exchange may remove this Trainer from its resolution escrow.');
  }
}
// This predicate is also used by raw playerView: unknown/mislabelled history
// cannot gain disclosure permissions simply by changing its event kind.
function prizeSummaryMatches(s, event) {
  if (!validatePrizeExchangeEvent(event) || event.data.kind !== 'finished') return false;
  const records = s.events.filter((e) => e.ruleId === 'effects.prize-exchange' && e.data.id === event.data.id);
  const requests = records.filter((e) => e.data.kind === 'requested');
  const resolutions = records.filter((e) => e.data.kind === 'resolved');
  if (requests.length !== 1 || resolutions.length !== 1 ||
      records.filter((e) => e.data.kind === 'finished').length !== 1 ||
      !validatePrizeExchangeEvent(requests[0]) || !validatePrizeExchangeEvent(resolutions[0])) return false;
  const request = requests[0].data, result = resolutions[0].data;
  if (request.choice.id !== request.id || request.choice.sourceId !== request.source.instanceId ||
      result.player !== request.source.owner || result.sourceId !== request.source.instanceId ||
      canonicalJSON(result.completion) !== canonicalJSON(request.choice.completion) ||
      result.selected.some((id) => !request.choice.prizes.includes(id) || s.cards[id]?.owner !== result.player)) return false;
  return canonicalJSON(event.data) === canonicalJSON({
    kind: 'finished', id: request.id, player: result.player, sourceId: result.sourceId, count: result.selected.length,
    ...(request.action.revealSelected ? { revealed: result.selected.map((id) => s.cards[id]) } : {}),
  });
}
function assertHealingChoice(s, catalog, d, pending = null) {
  if (d.local) throw new EngineError('invalid-healing-choice', 'Batch healing cannot run in a subject-local lane.');
  const choice = d.healingChoice;
  if (!choice) {
    if (pending || Object.hasOwn(d, 'selected'))
      throw new EngineError('invalid-healing-choice', 'Healing answers require their original public target-window receipt.');
    return;
  }
  const window = healingWindow(effectContext(s, catalog, d.source, d.event ?? null), d.action);
  const requests = s.events.filter((e) => e.ruleId === 'effects.heal-results' &&
    e.data.kind === 'requested' && e.data.id === choice.id);
  if (!validateHealingChoice(choice) || choice.turn !== s.turn || choice.sourceId !== d.source.instanceId ||
      canonicalJSON(choice.targets) !== canonicalJSON(window.targets) ||
      requests.length !== 1 || requests[0].visibility !== 'public' ||
      canonicalJSON(requests[0].data) !== canonicalJSON({
        kind: 'requested', id: choice.id, source: d.source, action: d.action, choice,
      }) ||
      s.events.some((e) => e.ruleId === 'effects.heal-results' && e.data.kind === 'resolved' && e.data.id === choice.id))
    throw new EngineError('invalid-healing-choice', 'Healing must retain its original source, public subject facts, turn and unique request.');
  if (pending && (pending.player !== d.source.owner || pending.kind !== 'healing-targets' ||
      pending.ruleId !== 'effects.heal-results' || Object.hasOwn(d, 'selected') ||
      canonicalJSON(pending.options) !== canonicalJSON(window.targets.map((t) => t.pokemonId)) ||
      ['minimum', 'maximum', 'allowZero'].some((key) => pending[key] !== window.bounds[key])))
    throw new EngineError('invalid-healing-choice', 'Healing choices must retain their actual chooser, eligible subjects and quantity bounds.');
}
function assertCounterChoice(s, catalog, d, pending = null) {
  if (d.local || Object.hasOwn(d, 'selected'))
    throw new EngineError('invalid-counter-choice', 'Counter allocation requires its own numeric protocol, never a subject-local/string-ID answer.');
  const choice = d.counterChoice;
  if (!choice) {
    if (pending || Object.hasOwn(d, 'allocations'))
      throw new EngineError('invalid-counter-choice', 'A numeric answer must retain its original public counter window.');
    return;
  }
  const window = counterDistributionWindow(effectContext(s, catalog, d.source, d.event ?? null), d.action);
  const requests = s.events.filter((e) => e.ruleId === 'damage.counter-distribution' &&
    e.data.kind === 'requested' && e.data.id === choice.id);
  if (!validateCounterChoice(choice) || choice.turn !== s.turn || choice.sourceId !== d.source.instanceId ||
      canonicalJSON(choice.targets) !== canonicalJSON(window.targets) ||
      requests.length !== 1 || requests[0].visibility !== 'public' ||
      canonicalJSON(requests[0].data) !== canonicalJSON({
        kind: 'requested', id: choice.id, source: d.source, action: d.action, choice,
      }) || s.events.some((e) => e.ruleId === 'damage.counter-distribution' && e.data.kind === 'resolved' && e.data.id === choice.id))
    throw new EngineError('invalid-counter-choice', 'Allocation must retain its own source, turn, exact counter window and unique unconsumed request.');
  if (pending && (pending.id !== choice.id || pending.player !== d.source.owner || pending.kind !== 'counter-allocation' ||
      pending.ruleId !== 'damage.counter-distribution' || Object.hasOwn(d, 'allocations') ||
      d.action.count === 0 || window.targets.length <= 1 ||
      pending.minimum !== 0 || pending.maximum !== window.targets.length || !pending.allowZero ||
      canonicalJSON(pending.options) !== canonicalJSON(window.targets.map((t) => t.pokemonId))))
    throw new EngineError('invalid-counter-choice', 'The allocation prompt must retain its actual actor and complete original target identities.');
  if (Object.hasOwn(d, 'allocations'))
    assertCounterDistributionAllocation(effectContext(s, catalog, d.source, d.event ?? null), d.action, d.allocations);
}
function ownedAttackFailure(message) { throw new EngineError('invalid-owned-attack-lock', message); }
function ownedAttackRequest(s, id) {
  const records = s.events.filter((e) => e.ruleId === 'attack.owned-lock' &&
    e.data.kind === 'requested' && e.data.id === id);
  if (records.length !== 1) ownedAttackFailure('A chosen attack needs exactly its original request.');
  return records[0].data;
}
function assertOwnedAttackChoice(s, catalog, d, pending = null) {
  if (d.local || d.source.category !== 'attack')
    ownedAttackFailure('Only an actual attack body can establish this lock.');
  const choice = d.ownedAttackChoice;
  if (!choice) {
    if (pending || Object.hasOwn(d, 'selected')) ownedAttackFailure('An answer cannot lose its owned-attack request.');
    return;
  }
  const window = ownedAttackLockWindow(effectContext(s, catalog, d.source), d.action);
  const request = ownedAttackRequest(s, choice.id), execution = requireExecutionReference(s, catalog, d, 'effect-choice');
  if (!validateOwnedAttackChoice(choice) || choice.turn !== s.turn || choice.sourceId !== d.source.instanceId ||
      choice.historyIndex !== s.battleHistory.events.length ||
      canonicalJSON({ owner: choice.owner, target: choice.target, candidates: choice.candidates }) !== canonicalJSON(window) ||
      request.programId !== d.programId || request.programIndex !== execution.cursor.index ||
      canonicalJSON(request.source) !== canonicalJSON(d.source) || canonicalJSON(request.action) !== canonicalJSON(d.action) ||
      canonicalJSON(request.choice) !== canonicalJSON(choice) ||
      s.events.some((e) => e.ruleId === 'attack.owned-lock' && e.data.id === choice.id && e.data.kind === 'applied'))
    ownedAttackFailure('A choice must retain its original live target, printed window, source and unconsumed program step.');
  const answers = s.events.filter((e) => e.ruleId === 'attack.owned-lock' && e.data.kind === 'answered' && e.data.id === choice.id);
  if (Object.hasOwn(d, 'selected') && (answers.length !== 1 ||
      canonicalJSON(answers[0].data.selected.map(attackOptionId)) !== canonicalJSON(d.selected)))
    ownedAttackFailure('Selected attacks must equal the original accepted answer.');
  if (pending && (pending.id !== choice.id || pending.player !== d.source.owner ||
      pending.kind !== 'owned-attack' || pending.ruleId !== 'attack.owned-lock' ||
      pending.minimum !== 1 || pending.maximum !== 1 || pending.allowZero || answers.length ||
      Object.hasOwn(d, 'selected') || !window.candidates.length ||
      canonicalJSON(pending.options) !== canonicalJSON(window.candidates.map(attackOptionId))))
    ownedAttackFailure('The prompt must retain its actual chooser, complete printed options and mandatory one selection.');
}
function ownedAttackEntry(s, request, entryId, reference) {
  const { source, choice, action } = request;
  const ownerTurn = s.battleHistory.turns.filter((t) => t.turn <= choice.turn && t.player === choice.owner).length + 1;
  return { id: entryId, targetId: choice.target.pokemonId, source: clone(source),
    effect: { op: 'ownedAttackRestriction', scope: 'all', reference: clone(reference) },
    ownedAttackLockId: choice.id, duration: action.duration, clearOnBench: true, clearOnEvolution: true,
    deadline: { player: choice.owner, ownerTurn, boundary: 'turn-end' }, ruleId: 'effects.duration.turn-only' };
}
function ownedAttackClearCause(s, event, entry, request) {
  const index = s.events.indexOf(event), reason = event.data.reason, targetId = entry.targetId;
  const fact = s.battleHistory.events[event.data.historyIndex];
  if (reason === 'leave' ? event.data.historyIndex !== null || !!findMon(s, targetId) :
      event.data.historyIndex === null || event.data.historyIndex < request.choice.historyIndex ||
        !fact || fact.turn !== event.data.turn || fact.owner !== request.choice.owner) return false;
  const after = s.events.slice(index + 1).filter((e) => !(e.ruleId === 'attack.owned-lock' && e.data.kind === 'cleared') &&
    !['energy.move', 'cards.prism-star'].includes(e.ruleId))[0];
  if (reason === 'bench') return after?.ruleId === 'status.clear' && after.data.from === targetId &&
    fact.kind === 'benchToActive' && fact.pokemonId === after.data.to;
  if (reason === 'evolution') return ['turn.evolve', 'effects.evolve'].includes(after?.ruleId) && after.data.pokemonId === targetId &&
    fact.kind === 'fieldTransition' && fact.method === reason && fact.pokemonId === targetId &&
    fact.fromCardId === after.data.fromCardId && fact.toCardId === after.data.cardId;
  if (reason === 'devolution') return after?.ruleId === 'effects.devolve' && after.data.pokemonId === targetId &&
    fact.kind === 'fieldTransition' && fact.method === reason && fact.pokemonId === targetId && fact.fromCardId === after.data.removed[0];
  if (reason === 'knockout') return after?.ruleId === 'ko.boundary' && after.data.pokemonId === targetId &&
    fact.kind === 'ko' && fact.pokemonId === targetId;
  if (reason === 'expiry' && fact.kind !== 'turnEnded') return false;
  const preceding = [], allowed = reason === 'leave' ? ['effects.field-return'] :
    ['effects.duration.turn-only', 'effects.duration.until-end'];
  for (const prior of s.events.slice(0, index).reverse()) {
    if (prior.ruleId === 'attack.owned-lock' && prior.data.kind === 'cleared' || prior.ruleId === 'cards.prism-star') continue;
    if (!allowed.includes(prior.ruleId)) break;
    preceding.push(prior);
  }
  return reason === 'leave' ? preceding.some((prior) => prior.data.pokemonId === targetId) :
    preceding.some((prior) => prior.data.effectId === entry.id && prior.data.player === entry.deadline.player &&
      prior.data.expiredAt === entry.deadline.boundary);
}
function assertOwnedAttackHistory(s, catalog) {
  const records = s.events.filter((e) => e.ruleId === 'attack.owned-lock');
  if (!records.length) {
    if (s.ongoing.some((e) => e.effect.op === 'ownedAttackRestriction'))
      ownedAttackFailure('A dynamic lock cannot exist without selection history.');
    return;
  }
  const groups = new Map(), uses = new Set(), entries = new Map(), executions = executionGroups(s, catalog);
  for (const event of records) {
    const data = event.data;
    if (data.kind === 'cleared') {
      if (!validateOwnedAttackLockClearEvent(event)) ownedAttackFailure('A cleared lock needs an exact private lifecycle receipt.');
      const group = groups.get(data.id);
      if (!group?.applied?.performed || group.cleared || group.applied.entryId !== data.entryId ||
          data.turn < group.request.choice.turn || data.turn > s.turn)
        ownedAttackFailure('Clearing cannot precede, duplicate or change its actually established lock.');
      if (!ownedAttackClearCause(s, event, entries.get(data.entryId), group.request))
        ownedAttackFailure('Clearing requires its actual corresponding transition or expiration, not a standalone forged retirement.');
      if (data.reason === 'expiry') {
        const entry = entries.get(data.entryId);
        const turn = s.battleHistory.turns.find((t) => t.turn === data.turn);
        if (turn?.player !== entry.deadline.player ||
            s.battleHistory.turns.filter((t) => t.turn <= data.turn && t.player === turn.player).length !== entry.deadline.ownerTurn)
          ownedAttackFailure('Expiration must occur at the original holder-turn deadline.');
      }
      group.cleared = data; continue;
    }
    if (!validateOwnedAttackLockEvent(event)) ownedAttackFailure('Owned-attack history must retain exact private typed records.');
    if (data.kind === 'requested') {
      const { choice, source, programId, programIndex } = data, g = executions.get(programId);
      const key = canonicalJSON([programId, programIndex]);
      if (groups.has(data.id) || uses.has(key) || data.id !== choice.id || source.category !== 'attack' ||
          choice.sourceId !== source.instanceId || choice.owner !== 1 - source.owner ||
          choice.historyIndex > s.battleHistory.events.length || !g?.opened ||
          g.schedule.data.origin !== 'handler' || (catalog.handler(g.binding.handlerId).timing ?? 'resolve') !== 'resolve' ||
          choice.turn !== g.schedule.data.turn || canonicalJSON(source) !== canonicalJSON(g.schedule.data.source))
        ownedAttackFailure('Every request needs one real attack invocation and a unique original leaf position.');
      const advances = s.events.filter((e) => e.ruleId === 'effects.execution' &&
        e.data.kind === 'advance' && e.data.id === programId && e.data.index < programIndex);
      const handler = catalog.handler(g.binding.handlerId);
      const cursor = replayEffectExecution(g.opened, advances, handler.operations, handler.embeddedOperations ?? []);
      if (cursor.index !== programIndex || canonicalJSON(cursor.step?.action) !== canonicalJSON(data.action))
        ownedAttackFailure('A lock request cannot be moved to a different original program instruction.');
      let expected = [];
      if (choice.target) {
        const card = s.cards[choice.target.topCardId], def = card && cardDef(s, catalog, card.instanceId);
        if (!card || card.owner !== choice.owner || def.kind !== 'pokemon')
          ownedAttackFailure('The original chosen subject must be an actual opponent-owned printed Pokemon card.');
        expected = def.mechanics.attacks.map((attack) => ({ instanceId: card.instanceId, attackId: attack.attackId }));
      }
      if (canonicalJSON(choice.candidates) !== canonicalJSON(expected))
        ownedAttackFailure('History cannot replace printed owned candidates with grants, lower cards or legality-filtered options.');
      if (expected.length) {
        const seals = s.events.filter((e) => e.ruleId === 'selection.request' && e.data.request?.id === choice.id);
        if (seals.length !== 1) ownedAttackFailure('A historical nonempty choice must retain its complete original pause receipt.');
        assertSelectionRequestEvent(seals[0]);
        const q = seals[0].data.request;
        if (q.kind !== 'owned-attack' || q.resume !== 'effect-choice' || q.ruleId !== 'attack.owned-lock' ||
            q.player !== source.owner || q.minimum !== 1 || q.maximum !== 1 || q.allowZero ||
            canonicalJSON(q.options) !== canonicalJSON(expected.map(attackOptionId)) ||
            canonicalJSON(q.data.ownedAttackChoice) !== canonicalJSON(choice) ||
            canonicalJSON(q.data.source) !== canonicalJSON(source) || canonicalJSON(q.data.action) !== canonicalJSON(data.action) ||
            q.data.programId !== programId || canonicalJSON(q.data.frames) !== canonicalJSON(cursor.step.frames) ||
            Object.hasOwn(q.data, 'selected') || seals[0].data.work.turn !== choice.turn)
          ownedAttackFailure('Historical requests cannot detach their source, subject, printed choices or program frames from the original private pause.');
      }
      groups.set(data.id, { request: data }); uses.add(key); continue;
    }
    const group = groups.get(data.id);
    if (!group) ownedAttackFailure('Answers and applications cannot exist without their original request.');
    const { request } = group, { kind, selected, performed, entryId, ...meta } = data;
    const { kind: _kind, ...original } = request;
    if (canonicalJSON(meta) !== canonicalJSON(original) ||
        selected.length !== (request.choice.candidates.length ? 1 : 0) ||
        selected.some((ref) => !request.choice.candidates.some((candidate) => canonicalJSON(ref) === canonicalJSON(candidate))))
      ownedAttackFailure('A result must retain its original window and one actual printed selection.');
    if (kind === 'answered') {
      if (group.answer || group.applied || !selected.length) ownedAttackFailure('An answer cannot be empty, duplicated or replayed after application.');
      group.answer = data; continue;
    }
    if (group.applied || (selected.length ? !group.answer ||
        canonicalJSON(selected) !== canonicalJSON(group.answer.selected) : performed) ||
        performed && entries.has(entryId))
      ownedAttackFailure('Application must consume exactly its accepted answer and a unique resulting effect.');
    const advance = s.events.filter((e) => e.ruleId === 'effects.execution' && e.data.kind === 'advance' &&
      e.data.id === request.programId && e.data.index === request.programIndex);
    if (advance.length !== 1 || advance[0].data.mode !== 'complete' || advance[0].data.performed !== performed)
      ownedAttackFailure('Application must equal the original program leaf completion, not merely a forged ledger.');
    group.applied = data;
    if (performed) entries.set(entryId, ownedAttackEntry(s, request, entryId, selected[0]));
  }
  for (const { request, applied, cleared } of groups.values()) {
    if (!applied) {
      if (!s.result && s.pending?.data.ownedAttackChoice?.id !== request.id)
        ownedAttackFailure('An unfinished selection must remain its original live prompt.');
      continue;
    }
    const live = s.ongoing.filter((e) => e.ownedAttackLockId === request.id || applied.entryId !== null && e.id === applied.entryId);
    if (!applied.performed || cleared) {
      if (live.length) ownedAttackFailure('A prevented or cleared lock cannot reappear in the live ledger.');
    } else {
      if (live.length !== 1 || canonicalJSON(live[0]) !== canonicalJSON(entries.get(applied.entryId)))
        ownedAttackFailure('An unretired lock must retain exactly its original effect, target and deadline.');
      let expectedTop = request.choice.target.topCardId;
      const applicationIndex = s.events.findIndex((e) => e.ruleId === 'attack.owned-lock' &&
        e.data.kind === 'applied' && e.data.id === request.id);
      for (const event of s.events.slice(applicationIndex + 1)) if (event.ruleId === 'effects.inherit' &&
          event.data.pokemonId === live[0].targetId) {
        if (event.data.fromCardId !== expectedTop || s.cards[event.data.toCardId]?.owner !== request.choice.owner ||
            cardDef(s, catalog, event.data.toCardId).kind !== 'pokemon')
          ownedAttackFailure('A retained lock can follow only the actual ordered inherited-replacement chain.');
        expectedTop = event.data.toCardId;
      }
      if (top(findMon(s, live[0].targetId)?.m ?? { stack: [] }) !== expectedTop)
        ownedAttackFailure('A target cannot change its top card without the actual inherited-effect transition.');
    }
  }
  for (const entry of s.ongoing) if (entry.effect.op === 'ownedAttackRestriction' &&
      (!entries.has(entry.id) || !groups.has(entry.ownedAttackLockId)))
    ownedAttackFailure('A dynamic lock cannot be installed without its real completed selection.');
}
function retainOngoing(s, keep, reason, transition = null) {
  const remaining = s.ongoing.filter(keep);
  const retired = s.ongoing.filter((entry) => entry.ownedAttackLockId && !remaining.includes(entry));
  let historyIndex = null;
  if (retired.length) {
    if (reason === 'bench') historyIndex = s.battleHistory.events.length - 1;
    else if (reason === 'knockout') historyIndex = s.battleHistory.events.length; // The real KO fact is committed immediately next.
    else if (reason === 'evolution' || reason === 'devolution') {
      historyIndex = s.battleHistory.events.length;
      battleFact(s, { kind: 'fieldTransition', method: reason, ...transition });
    } else if (reason === 'expiry') historyIndex = transition;
  }
  for (const entry of retired)
    log(s, 'attack.owned-lock', { kind: 'cleared', id: entry.ownedAttackLockId,
      entryId: entry.id, reason, turn: s.turn, historyIndex }, 'private');
  s.ongoing = remaining;
}
// A Pokémon that leaves play loses every effect attached to it (II.C-15).
const retireTarget = (s, pokemonId, reason) => retainOngoing(s, (entry) => entry.targetId !== pokemonId, reason);
function counterLethalFacts(s, catalog) {
  return allMons(s).map(({ owner, m }) => ({ owner, m, lethal: m.counters * 10 >= hp(s, catalog, owner, m) }));
}
function settleCounterProperties(s, catalog, before, source) {
  enforceEnergyRetention(s, catalog);
  for (const { owner, m, lethal } of before) {
    recordTransitionKO(s, catalog, owner, m, lethal, source);
    if (m.counters * 10 < hp(s, catalog, owner, m)) delete m.facts.knockoutCause;
  }
}
function newMon(s, id) {
  return { id: `m${++s.serial}`, stack: [id], energy: [], tools: [], counters: 0,
    conditions: emptyConditions(), enteredTurn: s.turn, evolvedTurn: 0, used: {}, facts: {} };
}
function finish(s, winner, reason) {
  s.result = { winner, reason }; s.phase = 'over'; s.pending = null; s.queue = []; s.attack = null;
  s.vacancies = [null, null];
  log(s, reason === 'concede' ? 'win.concede' : 'win.simultaneous', { winner, reason });
}

function ask(s, { player, kind, options, minimum = 1, maximum = 1, allowZero = false, forcePrompt = false, resume, data = {}, ruleId, requestId = null }) {
  requireRule(getRuleset(s.ruleset), ruleId);
  if (new Set(options).size !== options.length || maximum > options.length || minimum > maximum)
    throw new EngineError('invalid-prompt', 'Impossible selection request.');
  if (!options.length && minimum === 0 && !forcePrompt) { prepend(s, tasks(resume, { ...data, selected: [] })); return; }
  s.pending = { id: requestId ?? `q${++s.serial}`, player, kind, options: [...options], minimum, maximum,
    allowZero, resume, data: clone(data), ruleId };
}
function selectionWork(s) {
  return { queue: s.queue, attack: s.attack, serial: s.serial, revision: s.revision, turn: s.turn,
    current: s.current, phase: s.phase, first: s.first, nextPlayer: s.nextPlayer, vacancies: s.vacancies };
}
function sealSelectionRequest(s) {
  if (!s.pending || s.events.some((e) => e.ruleId === 'selection.request' && e.data.request?.id === s.pending.id)) return;
  const event = selectionRequestEvent(s.pending, selectionWork(s));
  log(s, event.ruleId, event.data, event.visibility);
}
function selectionJournalLike(data) {
  return !!data && typeof data === 'object' &&
    (data.request && typeof data.request === 'object' && Object.hasOwn(data.request, 'resume') &&
      Object.hasOwn(data.request, 'options') && Object.hasOwn(data.request, 'data') ||
     data.work && typeof data.work === 'object' && Object.hasOwn(data.work, 'queue') &&
      Object.hasOwn(data.work, 'attack') && Object.hasOwn(data.work, 'serial') && Object.hasOwn(data.work, 'revision'));
}
function assertSelectionRequests(s) {
  const requests = new Map();
  for (const event of s.events) if (event.ruleId === 'selection.request' || selectionJournalLike(event.data)) {
    assertSelectionRequestEvent(event);
    const id = event.data.request.id;
    if (requests.has(id)) throw new EngineError('invalid-selection-request', 'Every player choice needs one original request receipt, never a duplicate.');
    requests.set(id, event.data);
  }
  if (s.pending) {
    const record = requests.get(s.pending.id);
    if (!record || canonicalJSON(record.request) !== canonicalJSON(s.pending) ||
        canonicalJSON(record.work) !== canonicalJSON(selectionWork(s)))
      throw new EngineError('invalid-selection-request', 'The pending choice and entire paused control flow must retain their original private receipt.');
  }
}

const copiedSourceFields = (execution) => execution?.reference ? { contentSource: clone(execution.reference), copyId: execution.copyId } : {};
function attackSourceFields(s, execution) {
  if (execution?.reference) return copiedSourceFields(execution);
  const grant = execution?.grant ?? (execution && s.attack?.source.grantId ?
    { reference: s.attack.source.contentSource, id: s.attack.source.grantId } : null);
  return grant ? { contentSource: clone(grant.reference), grantId: grant.id ?? `prospective:${grant.key}` } : {};
}
const grantContext = (grant) => grant ? { reference: null, grant } : null;
function sourceFor(s, catalog, id, owner, category, binding, pokemonId = null, attackId = null, origin = null, execution = null) {
  return { instanceId: id, owner, cardOwner: s.cards[id].owner, category, pokemonId, attackId,
    effectId: binding.effectId, sourceOfTruth: binding.sourceOfTruth,
    origin: origin ?? (category === 'trainer' && (s.players[owner].hand.includes(id) || s.players[owner].resolving.includes(id)) ? 'hand' : 'field'),
    ...attackSourceFields(s, execution) };
}
function copiedAttack(s, catalog, reference) {
  const card = s.cards[reference.instanceId], d = card && cardDef(s, catalog, reference.instanceId);
  const attack = d?.kind === 'pokemon' && d.mechanics.attacks.find((a) => a.attackId === reference.attackId);
  if (!attack) throw new EngineError('invalid-copy-reference', 'Copied content must be an independently approved printed Pokémon attack.');
  return attack;
}
function copyRecord(s, id, kind, ruleId = 'attack.copy') {
  const records = s.events.filter((e) => e.ruleId === ruleId && e.data.kind === kind && e.data.id === id);
  return records.length === 1 ? records[0].data : null;
}
function validGrantProvider(s, catalog, provider) {
  if (!provider?.source || provider.source.category === 'attack' || provider.source.contentSource ||
      provider.source.grantId || provider.source.copyId ||
      !validateAttackGrantEffect(provider.specification) || !validSource(s, catalog, provider.source)) return false;
  const def = cardDef(s, catalog, provider.source.instanceId);
  const bindings = [
    ...def.mechanics.effects.map((b) => ({ binding: b, category: def.kind === 'pokemon' ? 'rule' : def.kind === 'energy' ? 'energy' : 'trainer' })),
    ...(def.mechanics.abilities ?? []).flatMap((a) => a.effects.map((b) => ({ binding: b, category: 'ability' }))),
  ];
  return bindings.some(({ binding, category }) => category === provider.source.category &&
    binding.effectId === provider.source.effectId &&
    canonicalJSON(binding.sourceOfTruth) === canonicalJSON(provider.source.sourceOfTruth) &&
    catalog.handler(binding.handlerId).timing === 'attackGrant' &&
    catalog.handler(binding.handlerId).operations.includes('attackGrant'));
}
function validSource(s, catalog, source) {
  const visited = new Set();
  while (true) {
    const card = s.cards[source.instanceId];
    if (!card || card.owner !== (source.cardOwner ?? source.owner)) return false;
    const d = cardDef(s, catalog, source.instanceId);
    // Resolving Items/Supporters are not in-play effect sources. A non-hand
    // origin requires this exact approved before-hand binding, not a coherently
    // relabelled execution/request journal that would evade hand-only shields.
    if (source.category === 'trainer' && ['item', 'supporter'].includes(d.mechanics.category) &&
        source.origin !== 'hand' && !d.mechanics.effects.some((b) =>
          b.effectId === source.effectId && b.trigger?.event === 'beforeHand' && b.trigger.origin === source.origin &&
          canonicalJSON(b.sourceOfTruth) === canonicalJSON(source.sourceOfTruth))) return false;
    if (card.owner !== source.owner) {
      if (!(source.category === 'trainer' && source.origin === 'field' && d.mechanics.category === 'stadium' &&
          d.mechanics.effects.some((b) => b.effectId === source.effectId && catalog.handler(b.handlerId).timing === 'onUse' &&
            canonicalJSON(b.sourceOfTruth) === canonicalJSON(source.sourceOfTruth)))) return false;
    }
    if (!source.contentSource) return true;
    const key = `${source.grantId ? 'grant' : 'copy'}:${source.grantId ?? source.copyId}`;
    if (visited.has(key)) return false; visited.add(key);
    const record = source.grantId ? copyRecord(s, source.grantId, 'used', 'attack.grant') : copyRecord(s, source.copyId, 'selected');
    if (source.category !== 'attack' || record?.source?.category !== 'attack' ||
        canonicalJSON(record.reference) !== canonicalJSON(source.contentSource) ||
        ['instanceId', 'owner', 'pokemonId', 'attackId'].some((k) => record.source[k] !== source[k])) return false;
    const attack = copiedAttack(s, catalog, source.contentSource);
    if (!(source.effectId === `attack:${attack.attackId}` && canonicalJSON(source.sourceOfTruth) === canonicalJSON(attack.sourceOfTruth)) &&
        !attack.effects.some((b) => b.effectId === source.effectId && canonicalJSON(b.sourceOfTruth) === canonicalJSON(source.sourceOfTruth))) return false;
    if (source.grantId) return validGrantProvider(s, catalog, record.provider);
    source = record.source;
  }
}
function validHistorySource(s, catalog, source) {
  if (!validSource(s, catalog, source)) return false;
  if (source.contentSource) return true; // validSource checked the immutable copy/grant receipt.
  const d = cardDef(s, catalog, source.instanceId), m = d.mechanics;
  const sameBinding = (b) => b.effectId === source.effectId &&
    canonicalJSON(b.sourceOfTruth) === canonicalJSON(source.sourceOfTruth);
  if (source.category === 'attack') {
    const attack = [...(m.attacks ?? []), ...(m.grantedAttacks ?? [])].find((a) => a.attackId === source.attackId);
    return !!attack && (source.effectId === `attack:${attack.attackId}` &&
      canonicalJSON(source.sourceOfTruth) === canonicalJSON(attack.sourceOfTruth) || attack.effects.some(sameBinding));
  }
  if (source.category === 'ability') return d.kind === 'pokemon' && m.abilities.some((a) => a.effects.some(sameBinding));
  const category = { pokemon: 'rule', trainer: 'trainer', energy: 'energy' }[d.kind];
  return source.category === category && m.effects.some(sameBinding);
}
function executionBinding(s, catalog, source) {
  if (!validHistorySource(s, catalog, source)) return null;
  const m = cardDef(s, catalog, source.instanceId).mechanics;
  const bindings = source.contentSource ? copiedAttack(s, catalog, source.contentSource).effects :
    [...m.effects, ...(m.abilities ?? []).flatMap((a) => a.effects),
      ...[...(m.attacks ?? []), ...(m.grantedAttacks ?? [])].flatMap((a) => a.effects)];
  return bindings.find((b) => b.effectId === source.effectId &&
    canonicalJSON(b.sourceOfTruth) === canonicalJSON(source.sourceOfTruth)) ?? null;
}
const tracksExecution = (binding) => !!binding;
function executionContext(d) {
  return { source: d.source, event: d.event ?? null, local: d.local ?? false,
    entry: d.entry ?? null, payment: d.payment ?? null };
}
function executionFailure(message) { throw new EngineError('invalid-effect-execution', message); }
function scheduleTrackedEffect(s, catalog, d, origin = 'handler') {
  const binding = executionBinding(s, catalog, d.source);
  if (!tracksExecution(binding))
    executionFailure('Every effect invocation needs its actual approved binding, not an untracked fallback.');
  if (d.binding && canonicalJSON(d.binding) !== canonicalJSON(binding))
    executionFailure('Scheduled effects must retain their independently approved source binding.');
  const programId = `program${++s.serial}`;
  log(s, 'effects.execution', { kind: 'scheduled', id: programId, turn: s.turn, origin,
    binding, ...executionContext(d) }, 'private');
  return { ...d, programId };
}
function assertNativeProgram(binding, h, opened) {
  const { program, origin, source, event } = opened.data;
  const known = NATIVE_EXECUTION_CONTRACTS.get(h.id);
  if (!known || known.validateParameters !== h.validateParameters ||
      known.execute !== Function.prototype.toString.call(h.execute)) return;
  if (origin === 'reaction') {
    if (h.id === 'cn.delayedReaction@1' && canonicalJSON(program) !== canonicalJSON(binding.parameters.program))
      executionFailure('A native deferred program must retain its exact approved embedded parameters.');
    return;
  }
  if (h.id === 'cn.drawValue@1') {
    // A computed count is the original resolution-time host receipt (like the
    // in-play count below); its grammar stays one native draw by the user.
    if (program.length !== 1 || canonicalJSON(Object.keys(program[0]).sort()) !== canonicalJSON(['count', 'op']) ||
        program[0].op !== 'draw' || !Number.isSafeInteger(program[0].count) || program[0].count < 0)
      executionFailure('A computed draw is one native draw of a nonnegative count.');
    return;
  }
  if (h.id === 'cn.drawPokemonCount@1') {
    // The original resolution-time board count is a trusted host receipt. A
    // Pokémon count can never exceed one Active plus the largest Bench (8).
    if (program.length !== 1 || canonicalJSON(Object.keys(program[0]).sort()) !== canonicalJSON(['count', 'op']) ||
        program[0].op !== 'draw' || !Number.isSafeInteger(program[0].count) || program[0].count < 0 || program[0].count > 9)
      executionFailure('An in-play count draw cannot exceed a possible board or change the native operation/actor.');
    return;
  }
  if (h.id === 'cn.drawUntil@1') {
    // Contextual output is an original trusted host receipt, not reconstructible
    // from today's hand after nested acquisitions. Independently enforce the
    // printed target ceiling and exact native single-draw grammar nonetheless.
    if (program.length !== 1 || canonicalJSON(Object.keys(program[0]).sort()) !== canonicalJSON(['count', 'op']) ||
        program[0].op !== 'draw' || !Number.isSafeInteger(program[0].count) ||
        program[0].count < 0 || program[0].count > binding.parameters.count)
      executionFailure('Draw-until output cannot exceed the approved printed target or change the native operation/actor.');
    return;
  }
  if (['cn.handBottomDraw@1', 'cn.handDeckDraw@1'].includes(h.id)) {
    // Prize-dependent draw counts are resolution-time receipts: the program must
    // match its parameters apart from those counts, and each count must be one
    // the printed instruction allows (at most the 6 Prize cards of II.D-17).
    const specs = [binding.parameters.ownDraw, binding.parameters.opponentDraw];
    const allowed = (spec, count) => typeof spec === 'number' ? count === spec : spec.kind === 'remainingPrizes' ?
      Number.isSafeInteger(count) && count >= 0 && count <= 6 : count === spec.then || count === spec.otherwise;
    const template = h.execute(deepFreeze({ source: clone(source), event: clone(event),
      state: { players: [{ prizes: [] }, { prizes: [] }] } }), clone(binding.parameters));
    const counts = program[0]?.next?.steps?.map((step) => step.count) ?? [];
    const normalized = clone(program);
    template[0].next.steps.forEach((step, i) => { if (normalized[0]?.next?.steps?.[i]) normalized[0].next.steps[i].count = step.count; });
    if (canonicalJSON(normalized) !== canonicalJSON(template) || counts.some((count, i) => !allowed(specs[i], count)))
      executionFailure('A Prize-dependent draw cannot change its native program or draw a count its instruction does not allow.');
    return;
  }
  const expected = h.execute(deepFreeze({ source: clone(source), event: clone(event) }), clone(binding.parameters));
  if (canonicalJSON(program) !== canonicalJSON(expected))
    executionFailure('A static native program must still equal its approved parameters and real source, not an edited journal.');
}
function executionGroups(s, catalog) {
  const groups = new Map();
  for (const event of s.events) if (event.ruleId === 'effects.execution') {
    assertEffectExecutionEvent(event);
    const id = event.data.id;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(event);
  }
  const result = new Map();
  for (const [id, records] of groups) {
    const schedule = records[0], binding = executionBinding(s, catalog, schedule.data.source);
    if (schedule.data.kind !== 'scheduled' || schedule.data.turn > s.turn ||
        !tracksExecution(binding) || canonicalJSON(schedule.data.binding) !== canonicalJSON(binding))
      executionFailure('Program scheduling needs its original approved binding, source, turn and first unique receipt.');
    const h = catalog.handler(binding.handlerId), origin = schedule.data.origin;
    if (origin === 'handler' && !['resolve', 'beforeDamage', 'damage', 'onUse'].includes(h.timing ?? 'resolve'))
      executionFailure('A field/formula/permission provider cannot be forged into a queued effect invocation.');
    if (origin === 'reaction' && !h.operations.includes('delayedReaction'))
      executionFailure('Only an explicitly declared deferred reaction can open a reaction program.');
    const opened = records[1];
    if (!opened) { result.set(id, { schedule, cursor: null, binding }); continue; }
    const { kind: _kind, ...scheduled } = schedule.data;
    const { program, kind: _openedKind, ...actual } = opened.data;
    if (opened.data.kind !== 'opened' || canonicalJSON(scheduled) !== canonicalJSON(actual))
      executionFailure('Program opening cannot change or duplicate its scheduled source and invocation context.');
    assertNativeProgram(binding, h, opened);
    const operations = origin === 'handler' ? h.operations : h.embeddedOperations ?? [];
    const embedded = origin === 'handler' ? h.embeddedOperations ?? [] : [];
    const cursor = replayEffectExecution(opened, records.slice(2), operations, embedded);
    result.set(id, { schedule, opened, cursor, binding });
  }
  return result;
}
function requireExecutionReference(s, catalog, d, kind, groups = executionGroups(s, catalog)) {
  const binding = executionBinding(s, catalog, d.source);
  if (!tracksExecution(binding)) executionFailure('An effect continuation cannot lose its approved source binding.');
  const g = groups.get(d.programId);
  if (!g || g.schedule.data.turn !== s.turn ||
      canonicalJSON(executionContext(d)) !== canonicalJSON(executionContext(g.schedule.data)) ||
      canonicalJSON(binding) !== canonicalJSON(g.binding))
    executionFailure('Effect work must retain its own scheduled program identity and exact invocation context.');
  if (kind === 'effect') {
    if (g.opened || canonicalJSON(d.binding) !== canonicalJSON(g.binding))
      executionFailure('A handler invocation cannot be restarted or exchange its approved binding.');
  } else if (!g.cursor?.step || canonicalJSON({ action: d.action, frames: d.frames }) !== canonicalJSON(g.cursor.step))
    executionFailure('Action and continuation frames must equal the original program’s exact current step.');
  return g;
}
function openTrackedEffect(s, catalog, d, program) {
  const binding = executionBinding(s, catalog, d.source);
  const g = requireExecutionReference(s, catalog, { ...d, binding }, 'effect');
  const { kind: _kind, ...meta } = g.schedule.data;
  const event = { ruleId: 'effects.execution', visibility: 'private', data: { kind: 'opened', ...meta, program } };
  const h = catalog.handler(binding.handlerId);
  beginEffectExecution(event, meta.origin === 'handler' ? h.operations : h.embeddedOperations ?? [],
    meta.origin === 'handler' ? h.embeddedOperations ?? [] : []);
  log(s, event.ruleId, event.data, event.visibility);
  return d.programId;
}
function advanceTrackedEffect(s, catalog, d, mode, performed, extra = {}) {
  const g = requireExecutionReference(s, catalog, d, 'effect-choice');
  const event = { ruleId: 'effects.execution', visibility: 'private',
    data: { kind: 'advance', id: d.programId, index: g.cursor.index, mode, performed, ...extra } };
  advanceEffectExecution(g.cursor, event);
  log(s, event.ruleId, event.data, event.visibility);
}
function assertExecutionWork(s, catalog) {
  const groups = executionGroups(s, catalog), references = new Map();
  const add = (d, kind) => {
    requireExecutionReference(s, catalog, d, kind, groups);
    if (references.has(d.programId)) executionFailure('An effect invocation cannot have duplicate active continuations.');
    references.set(d.programId, kind);
  };
  const work = [...s.queue, ...(s.pending ? [{ op: s.pending.resume, data: s.pending.data }] : [])];
  for (const task of work) {
    if (['effect', 'effect-choice'].includes(task.op)) add(task.data, task.op);
    if (task.op === 'draw-cards' && task.data.completion) add(task.data.completion, 'effect-choice');
  }
  for (const saved of s.attack?.copies ?? []) add(saved.continuation, 'effect-choice');
  for (const [id, g] of groups) {
    const active = !g.opened || g.cursor.step !== null;
    if (!s.result && active !== references.has(id) || !active && references.has(id))
      executionFailure('Saved programs must retain exactly their outstanding work, never drop or resurrect a completed invocation.');
  }
}
function acquisitionUnits(s, catalog, entry) {
  const def = cardDef(s, catalog, entry.cardId), result = [];
  const add = (trigger, bindings, abilityId, category, costs) => {
    if (trigger?.event === 'beforeHand' && acquisitionMatches(trigger, entry))
      result.push({ id: canonicalJSON([entry.id, abilityId === null ? 'effect' : 'ability', abilityId ?? bindings[0].effectId]),
        trigger, bindings, abilityId, category, costs: costs ?? [] });
  };
  for (const b of def.mechanics.effects) add(b.trigger, [b], null, def.kind === 'pokemon' ? 'rule' : def.kind === 'energy' ? 'energy' : 'trainer', b.activationCosts);
  for (const a of def.mechanics.abilities ?? []) add(a.trigger, a.effects, a.abilityId, 'ability', a.costs);
  return result;
}
function entryWork(s, catalog, player, cardId, origin, reason, cause) {
  const entry = { id: `i${++s.serial}`, player, cardId, origin, reason, cause,
    turn: s.turn, during: s.current };
  s.players[player].resolving.push(cardId);
  return [tasks('entry-window', { entry, remaining: acquisitionUnits(s, catalog, entry).map((u) => u.id) }),
    tasks('entry-finish', { entry, discard: false })];
}
function sourceModel(s, catalog) {
  const nodes = [], sources = [], entries = [], typeEntries = [];
  const typeTargets = (source, spec) => allMons(s).filter(({ owner, m }) =>
    modifierTargets(s, catalog, source, spec, owner, m)).map(({ m }) => m.id);
  const add = (kind, instanceId, owner, m, bindings, key = null) => {
    const id = sourceNodeId(kind, instanceId, kind === 'ability' ? key : null);
    nodes.push({ id, kind, instanceId, owner, pokemonId: m?.id ?? null, key,
      active: !!m && s.players[owner].active === m, mechanics: m ? monDef(s, catalog, m).mechanics : null });
    const category = kind === 'tool' || kind === 'stadium' ? 'trainer' : kind;
    for (const binding of bindings) sources.push({
      binding, nodeId: id, source: sourceFor(s, catalog, instanceId, owner, category, binding, m?.id ?? null),
    });
  };
  for (const { owner, m } of allMons(s)) {
    const d = monDef(s, catalog, m);
    add('rule', top(m), owner, m, d.mechanics.effects);
    for (const a of d.mechanics.abilities) add('ability', top(m), owner, m, a.effects, a.abilityId);
    for (const id of m.tools) add('tool', id, owner, m, cardDef(s, catalog, id).mechanics.effects, cardDef(s, catalog, id).nameKey);
    for (const id of m.energy) add('energy', id, owner, m, cardDef(s, catalog, id).mechanics.effects);
  }
  if (s.stadium) add('stadium', s.stadium, s.cards[s.stadium].owner, null, cardDef(s, catalog, s.stadium).mechanics.effects);
  if (s.phase !== 'setup') for (const { binding, nodeId, source } of sources) {
    const handler = catalog.handler(binding.handlerId);
    if (!['suppression', 'pokemonTypes'].includes(handler.timing)) continue;
    // Suppression predicates see the raw, read-only facts. They cannot read
    // their own derived output or recursively ask which Abilities are present.
    const specs = handler.execute(constantFieldExecution(handler) ? null :
      effectContext(s, catalog, source, null, false, null, true), clone(binding.parameters));
    if (!Array.isArray(specs)) throw new EngineError('invalid-handler', 'Suppression handlers return descriptions.');
    assertJSON(specs);
    for (const [index, spec] of specs.entries()) {
      const typeEffect = handler.timing === 'pokemonTypes';
      if (!(typeEffect ? validatePokemonTypesEffect(spec) : validateSuppressionEffect(spec)) || !handler.operations.includes(spec.op))
        throw new EngineError('invalid-handler', 'Invalid or undeclared suppression effect.');
      const entry = { id: canonicalJSON([binding.effectId, source.instanceId, index]), sourceNodeId: nodeId,
        source, spec, sourceOfTruth: binding.sourceOfTruth };
      if (typeEffect) typeEntries.push({ ...entry, targets: typeTargets(source, spec) });
      else entries.push(entry);
    }
  }
  for (const e of s.ongoing) if (['suppression', 'pokemonTypes'].includes(e.effect.op) && ongoingIsActive(e, s)) {
    const nodeId = sourceNodeId('fixed', e.id);
    nodes.push({ id: nodeId, kind: 'fixed', owner: e.source.owner, pokemonId: null });
    const entry = { id: e.id, sourceNodeId: nodeId, source: e.source, targetId: e.targetId,
      spec: e.effect, sourceOfTruth: e.source.sourceOfTruth };
    if (e.effect.op === 'pokemonTypes') typeEntries.push({ ...entry,
      targets: typeTargets(e.source, e.effect).filter((id) => id === e.targetId) });
    else entries.push(entry);
  }
  const traits = typeEntries.length ? resolveSourceTraits(nodes, entries, typeEntries,
    allMons(s).map(({ m }) => ({ id: m.id, printedTypes: monDef(s, catalog, m).mechanics.types }))) : null;
  const availability = traits?.availability ?? resolveSuppression(nodes, entries), pokemon = {};
  for (const { m } of allMons(s)) pokemon[m.id] = {
    types: clone(traits?.pokemonTypes.get(m.id).types ?? monDef(s, catalog, m).mechanics.types),
    typeChanges: clone(traits?.pokemonTypes.get(m.id).trace ?? []),
    abilities: monDef(s, catalog, m).mechanics.abilities.map((a) => ({
      abilityId: a.abilityId, present: availability.get(sourceNodeId('ability', top(m), a.abilityId)).enabled,
      removedBy: availability.get(sourceNodeId('ability', top(m), a.abilityId)).removedBy,
    })),
    toolEffects: m.tools.map((id) => ({ instanceId: id, ...availability.get(sourceNodeId('tool', id)) })),
  };
  const model = { nodes, sources, availability, pokemon, attackGrants: [] }, provisions = [];
  if (s.phase !== 'setup') for (const { binding, source, nodeId } of sources) {
    const h = catalog.handler(binding.handlerId);
    if (h.timing !== 'energyProvision' || !availability.get(nodeId).enabled) continue;
    // This stage can read source availability, but not its own derived Energy output.
    const specs = h.execute(constantFieldExecution(h) ? null : effectContext(s, catalog, source, null, false, model), clone(binding.parameters));
    if (!Array.isArray(specs)) throw new EngineError('invalid-handler', 'Energy provision handlers return descriptions.');
    assertJSON(specs);
    for (const [index, spec] of specs.entries()) {
      if (!validateEnergyProvisionEffect(spec) || !h.operations.includes(spec.op))
        throw new EngineError('invalid-handler', 'Invalid or undeclared Energy provision.');
      provisions.push({ spec, source, id: canonicalJSON([binding.effectId, source.instanceId, index]),
        sourceOfTruth: binding.sourceOfTruth });
    }
  }
  for (const { owner, m } of allMons(s)) pokemon[m.id].energies = m.energy.map((id) => {
    const replacements = provisions.filter((e) => entryTargets(s, catalog, e, owner, m, model) &&
      (!e.spec.cardSelf || e.source.instanceId === id) && matchesCardSelector(cardDef(s, catalog, id), e.spec.selector) &&
      (!e.spec.otherAttached || m.energy.some((other) => other !== id && matchesCardSelector(cardDef(s, catalog, other), e.spec.otherAttached))))
      .map((e) => ({ id: e.id, units: e.spec.units, sourceOfTruth: e.sourceOfTruth }));
    return { instanceId: id, ...resolveEnergyProvision(cardDef(s, catalog, id).mechanics.baseUnits, replacements) };
  });
  const grants = [];
  if (s.phase !== 'setup') for (const { binding, source, nodeId } of sources) {
    const h = catalog.handler(binding.handlerId);
    if (h.timing !== 'attackGrant' || !availability.get(nodeId).enabled) continue;
    const specs = h.execute(constantFieldExecution(h) ? null : effectContext(s, catalog, source, null, false, model), clone(binding.parameters));
    if (!Array.isArray(specs)) throw new EngineError('invalid-handler', 'Attack grants return reviewed descriptions.');
    assertJSON(specs);
    for (const [index, spec] of specs.entries()) {
      if (!validateAttackGrantEffect(spec) || !h.operations.includes(spec.op))
        throw new EngineError('invalid-handler', 'Invalid or undeclared attack grant.');
      grants.push({ spec, source, id: canonicalJSON([binding.effectId, source.instanceId, index]) });
    }
  }
  model.attackGrants = grants;
  return model;
}

function effectContext(s, catalog, source, event = null, local = false, model = null, raw = false, entry = null, payment = null, activation = null) {
  // Trusted handlers receive a detached read-only board, never the live transaction.
  const context = { source: clone(source), event: clone(event), entry: clone(entry), payment: clone(payment), activation: clone(activation),
    definitions: catalog.definitionRecord() };
  if (local) {
    const found = findMon(s, event.subjectId);
    context.subject = { owner: event.owner, pokemon: clone(found?.m ?? event.snapshot),
      active: found ? s.players[found.owner].active === found.m : event.wasActive,
      definition: catalog.definition(found ? monDef(s, catalog, found.m).definitionId : event.definitionId) };
  } else context.state = clone(s);
  if (!raw) {
    model ??= sourceModel(s, catalog);
    if (local) context.subject.effective = clone(model.pokemon[event.subjectId] ?? null);
    else context.effectivePokemon = clone(model.pokemon);
    context.benchLimits = [0, 1].map((player) => benchLimit(s, catalog, player, model));
  }
  return deepFreeze(context);
}
function effectTasks(s, catalog, instanceId, owner, category, bindings, timing, pokemonId = null, attackId = null, payment = null, execution = null) {
  const out = [];
  for (const binding of bindings) {
    const handler = catalog.handler(binding.handlerId);
    const phase = handler.timing || 'resolve';
    if (phase !== timing || binding.trigger) continue;
    const source = sourceFor(s, catalog, instanceId, owner, category, binding, pokemonId, attackId, null, execution);
    out.push(tasks('effect', scheduleTrackedEffect(s, catalog, { binding, source, payment })));
  }
  return out;
}
function makeTriggerEvent(s, catalog, kind, owner, mon, details = {}) {
  const event = { id: `v${++s.serial}`, kind, turn: s.turn, during: s.current, endingPlayer: null,
    subjectId: mon.id, owner, wasActive: s.players[owner].active === mon, origin: null, cardId: null,
    damage: 0, cause: { kind: 'rule', source: null }, snapshot: clone(mon),
    definitionId: monDef(s, catalog, mon).definitionId,
    effectiveTypes: clone(sourceModel(s, catalog).pokemon[mon.id].types), ...clone(details) };
  if (!validateTriggerEvent(event)) throw new EngineError('invalid-trigger-event', 'Malformed engine event.', { errors: validateTriggerEvent.errors });
  log(s, 'pokemon.types', { kind: 'event-snapshot', id: event.id, subjectId: event.subjectId,
    owner: event.owner, definitionId: event.definitionId, types: event.effectiveTypes });
  return event;
}
function collectTriggers(s, catalog, events) {
  const registrations = [], model = sourceModel(s, catalog);
  const add = (trigger, bindings, owner, instanceId, category, pokemonId, ability = null) => {
    if (!trigger || trigger.event === 'beforeHand') return;
    registrations.push({ trigger, bindings: bindings.map((binding) => ({
      binding, source: sourceFor(s, catalog, instanceId, owner, category, binding, pokemonId),
    })), ability });
  };
  for (const { owner, m } of allMons(s)) {
    const def = monDef(s, catalog, m);
    for (const b of def.mechanics.effects) add(b.trigger, [b], owner, top(m), 'rule', m.id);
    for (const a of def.mechanics.abilities) if (a.mode === 'triggered' &&
        model.availability.get(sourceNodeId('ability', top(m), a.abilityId)).enabled)
      add(a.trigger, a.effects, owner, top(m), 'ability', m.id, a);
    for (const id of [...m.tools, ...m.energy]) {
      const d = cardDef(s, catalog, id);
      if (d.mechanics.category === 'tool' && !model.availability.get(sourceNodeId('tool', id)).enabled) continue;
      for (const b of d.mechanics.effects) add(b.trigger, [b], owner, id, d.kind === 'energy' ? 'energy' : 'trainer', m.id);
    }
  }
  if (s.stadium) for (const b of cardDef(s, catalog, s.stadium).mechanics.effects)
    add(b.trigger, [b], s.cards[s.stadium].owner, s.stadium, 'trainer', null);
  for (const reaction of s.ongoing) if (reaction.effect.op === 'reaction' && ongoingIsActive(reaction, s))
    registrations.push({ trigger: reaction.effect.trigger, bindings: [], reaction, ability: null });
  const units = [];
  for (const event of events) for (const r of registrations) {
    // Checkup predicates are evaluated when the holder's chosen before/after
    // slot resolves, not prematurely before status recovery.
    const descriptor = clone(r.trigger);
    if (event.kind === 'checkup') delete descriptor.rotation;
    const source = r.reaction?.source ?? r.bindings[0].source;
    if (r.reaction && event.subjectId !== r.reaction.targetId) continue;
    if (r.reaction?.effect.priorEventIds.includes(event.id)) continue;
    const observer = r.reaction ? { ...source, pokemonId: r.reaction.targetId } : source;
    if (!triggerMatches(descriptor, event, observer, {
      sourceActive: s.players[r.reaction ? event.owner : source.owner].active?.id === observer.pokemonId,
      definition: catalog.definition(event.definitionId),
    })) continue;
    units.push({ id: `t${++s.serial}`, owner: event.owner,
      controller: r.trigger.choiceOwner === 'affected' ? event.owner : source.owner,
      trigger: clone(r.trigger), abilityId: r.ability?.abilityId ?? null,
      specialRule: r.ability?.specialRule ?? null, usage: clone(r.ability?.usage ?? null),
      bindings: clone(r.bindings), event: clone(event), ...(r.reaction ? { reaction: clone(r.reaction) } : {}) });
  }
  return units;
}
function triggerWork(s, catalog, events) {
  const units = collectTriggers(s, catalog, events);
  return units.length ? [tasks('trigger-window', { units })] : [];
}
function triggerStillAvailable(s, catalog, unit, model = sourceModel(s, catalog)) {
  if (unit.reaction) return s.ongoing.some((e) => e.id === unit.reaction.id && ongoingIsActive(e, s));
  const source = unit.bindings[0].source, def = cardDef(s, catalog, source.instanceId);
  const kind = source.category === 'trainer' ? def.mechanics.category : source.category;
  const nodeId = sourceNodeId(kind, source.instanceId, source.category === 'ability' ? unit.abilityId : null);
  const node = model.nodes.find((n) => n.id === nodeId);
  // The same physical card can already have re-entered under a NEW Pokémon
  // identity. That does not revive the retired Pokémon's undeclared window.
  return !!node && node.pokemonId === source.pokemonId && model.availability.get(nodeId).enabled;
}
function assertEventTypeReceipt(s, event) {
  const typeReceipts = s.events.filter((e) => e.ruleId === 'pokemon.types' &&
    e.data.kind === 'event-snapshot' && e.data.id === event.id);
  if (typeReceipts.length !== 1 || typeReceipts[0].visibility !== 'public' ||
      canonicalJSON(typeReceipts[0].data) !== canonicalJSON({
    kind: 'event-snapshot', id: event.id, subjectId: event.subjectId, owner: event.owner,
    definitionId: event.definitionId, types: event.effectiveTypes,
  })) throw new EngineError('invalid-trigger-types', 'Trigger type predicates must retain the actual event-time Pokémon type receipt.');
}
function assertTriggerUnitState(s, catalog, unit) {
  const event = unit.event, first = unit.reaction?.source ?? unit.bindings[0].source;
  assertEventTypeReceipt(s, event);
  const card = s.cards[first.instanceId], snapshotTop = s.cards[event.snapshot.stack.at(-1)];
  if (!card || !validSource(s, catalog, first) || !snapshotTop || snapshotTop.owner !== event.owner ||
      snapshotTop.definitionId !== event.definitionId || event.subjectId !== event.snapshot.id ||
      unit.owner !== event.owner || unit.controller !== (unit.trigger.choiceOwner === 'affected' ? event.owner : first.owner))
    throw new EngineError('invalid-trigger-source', 'Trigger source, affected holder or controller does not match the snapshot.');
  const def = catalog.definition(card.definitionId), ability = unit.abilityId === null ? null :
    def.mechanics.abilities?.find((a) => a.abilityId === unit.abilityId && a.mode === 'triggered');
  if ((unit.abilityId !== null && !ability) || canonicalJSON(unit.usage) !== canonicalJSON(ability?.usage ?? null) ||
      unit.specialRule !== (ability?.specialRule ?? null))
    throw new EngineError('invalid-trigger-ability', 'Pending Ability usage cannot change independently of its approved definition.');
  if (event.cause.source && !validSource(s, catalog, event.cause.source))
    throw new EngineError('invalid-trigger-cause', 'An event cause must refer to an original card owned by its actual holder.');
  if (event.kind === 'knockout') {
    const receipt = copyRecord(s, event.id, 'latched', 'ko.boundary')?.item;
    if (!receipt || canonicalJSON(knockoutFact(receipt)) !== canonicalJSON({
      kind: 'ko', owner: event.owner, pokemonId: event.subjectId, turn: event.turn, during: event.during, cause: event.cause,
    })) throw new EngineError('invalid-ko-history', 'A Knock Out trigger must retain its actual latched causal receipt.');
  }
  if (unit.reaction) {
    assertOngoingEffect(unit.reaction, s);
    const bindings = first.contentSource ? copiedAttack(s, catalog, first.contentSource).effects :
      [...def.mechanics.effects, ...(def.mechanics.abilities ?? []).flatMap((a) => a.effects),
        ...[...(def.mechanics.attacks ?? []), ...(def.mechanics.grantedAttacks ?? [])].flatMap((a) => a.effects)];
    if (unit.reaction.targetId !== event.subjectId || canonicalJSON(unit.trigger) !== canonicalJSON(unit.reaction.effect.trigger) ||
        !bindings.some((b) => b.effectId === first.effectId && canonicalJSON(b.sourceOfTruth) === canonicalJSON(first.sourceOfTruth)))
      throw new EngineError('invalid-delayed-reaction', 'Delayed reactions must retain their fixed target and approved original source.');
    assertEffectProgram(unit.reaction.effect.program, REACTION_OPERATIONS);
    return;
  }
  const approved = ability?.effects ?? def.mechanics.effects;
  if ((ability && canonicalJSON(unit.bindings.map((item) => item.binding)) !== canonicalJSON(approved)) ||
      (!ability && unit.bindings.length !== 1))
    throw new EngineError('invalid-trigger-binding', 'A pending trigger cannot drop, duplicate or reorder its own written effects.');
  for (const item of unit.bindings) {
    if (item.source.instanceId !== first.instanceId || item.source.owner !== first.owner ||
        item.source.pokemonId !== first.pokemonId ||
        item.source.category !== (def.kind === 'pokemon' ? ability ? 'ability' : 'rule' : def.kind === 'energy' ? 'energy' : 'trainer') ||
        !approved.some((b) => canonicalJSON(b) === canonicalJSON(item.binding)) ||
        canonicalJSON(ability?.trigger ?? item.binding.trigger) !== canonicalJSON(unit.trigger) ||
        item.source.effectId !== item.binding.effectId ||
        canonicalJSON(item.source.sourceOfTruth) !== canonicalJSON(item.binding.sourceOfTruth))
      throw new EngineError('invalid-trigger-binding', 'Pending trigger bindings must match their independently approved source.');
  }
}
function addCounters(s, catalog, owner, mon, count, cause) {
  if (!Number.isSafeInteger(mon.counters + count) || mon.counters + count > 900719925474099)
    throw new EngineError('numeric-overflow', 'Damage counters and their ten-point conversion must both remain exact.');
  const wasLethal = mon.counters * 10 >= hp(s, catalog, owner, mon);
  mon.counters += count;
  if (!wasLethal && mon.counters * 10 >= hp(s, catalog, owner, mon))
    mon.facts.knockoutCause = clone(cause);
}
function modifierTargets(s, catalog, source, spec, owner, m, model = null) {
  if (spec.scope === 'self' && source.pokemonId !== m.id) return false;
  if (spec.scope === 'own' && source.owner !== owner) return false;
  if (spec.scope === 'opponent' && source.owner === owner) return false;
  if (spec.activeOnly && s.players[owner].active !== m) return false;
  if (spec.sourceActive && s.players[source.owner].active?.id !== source.pokemonId) return false;
  if (spec.benchOnly && s.players[owner].active === m) return false;
  if (spec.stages && !spec.stages.includes(monDef(s, catalog, m).mechanics.stage)) return false;
  if (spec.ruleBox === false && monDef(s, catalog, m).mechanics.ruleBox) return false;
  if ((spec.targetSelector || spec.targetState) &&
      !pokemonMatches(s, catalog, model ??= sourceModel(s, catalog), m, { selector: spec.targetSelector, state: spec.targetState })) return false;
  return !spec.type || (model ?? sourceModel(s, catalog)).pokemon[m.id].types.includes(spec.type);
}
// The other Pokémon of an attack (II.A printed filters): the attacker of an attack source.
function otherMatches(s, catalog, spec, other, model) {
  return !(spec.otherSelector || spec.otherState) ||
    !!other && pokemonMatches(s, catalog, model, other.m, { selector: spec.otherSelector, state: spec.otherState });
}
function entryTargets(s, catalog, entry, owner, mon, model = null) {
  return (!entry.targetId || entry.targetId === mon.id) &&
    modifierTargets(s, catalog, entry.source, entry.spec, owner, mon, model);
}
function continuousEntries(s, catalog, model = null) {
  if (s.phase === 'setup') return [];
  const result = [];
  model ??= sourceModel(s, catalog);
  for (const { binding, source, nodeId } of model.sources) {
      const handler = catalog.handler(binding.handlerId);
      if (handler.timing !== 'continuous' || !model.availability.get(nodeId).enabled) continue;
      const specs = handler.execute(constantFieldExecution(handler) ? null :
        effectContext(s, catalog, source, null, false, model), clone(binding.parameters));
      if (!Array.isArray(specs)) throw new EngineError('invalid-handler', 'Continuous handlers return descriptions.');
      assertJSON(specs);
      for (const [index, spec] of specs.entries()) {
        if (!validateContinuousEffect(spec) || !handler.operations.includes(spec.op))
          throw new EngineError('invalid-handler', 'Invalid or undeclared continuous effect.', { errors: validateContinuousEffect.errors });
        if (spec.op === 'protection' && spec.scope === 'self' && !source.pokemonId)
          throw new EngineError('unsupported-protection-subject', 'A continuous Pokemon self shield cannot silently protect a non-Pokemon field card.');
        if (spec.op === 'stadiumProtection' && (source.instanceId !== s.stadium ||
            cardDef(s, catalog, source.instanceId).mechanics.category !== 'stadium'))
          throw new EngineError('unsupported-protection-subject', 'A card-level Stadium self shield must remain on its actual current Stadium source.');
        if (spec.condition && !continuousConditionMet(s, catalog, source, spec.condition, model)) continue;
        result.push({ spec, source, id: canonicalJSON([binding.effectId, source.instanceId, index]),
          sourceOfTruth: binding.sourceOfTruth });
      }
  }
  for (const entry of s.ongoing) if (!['reaction', 'suppression', 'pokemonTypes'].includes(entry.effect.op) && ongoingIsActive(entry, s))
    result.push({ spec: entry.effect, source: entry.source, targetId: entry.targetId,
      id: entry.id, sourceOfTruth: entry.source.sourceOfTruth });
  // A player's own boost (「在这个回合，自己的…宝可梦所使用的招式…「+N」」) applies to that player's Pokémon.
  for (const entry of s.playerOngoing) if (entry.effect.op === 'modifier' && ongoingIsActive(entry, s))
    result.push({ spec: entry.effect, source: entry.source, id: entry.id, sourceOfTruth: entry.source.sourceOfTruth });
  return result;
}
function continuous(s, catalog, owner, mon, field, packet = null) {
  const result = [], groups = new Map(), model = sourceModel(s, catalog);
  for (const entry of continuousEntries(s, catalog, model)) {
    const { spec, id, sourceOfTruth } = entry;
    if (spec.op !== 'modifier' || spec.field !== field || !entryTargets(s, catalog, entry, owner, mon, model)) continue;
    // An attack's damage: the attacker's modifier reads the damaged Pokémon, the defender's reads the attacker.
    if (!otherMatches(s, catalog, spec, packet && (field === 'attackDamage' ? packet.target : packet.attacker), model) ||
        spec.attackIds && !spec.attackIds.includes(packet?.attackId)) continue;
    if (packet && ((spec.targetSide && spec.targetSide !== 'all' &&
        (spec.targetSide === 'own') !== (packet.owner === owner)) ||
        (spec.targetPosition && spec.targetPosition !== 'all' && spec.targetPosition !== packet.position) ||
        (spec.damageFrom && spec.damageFrom !== 'all' && (spec.damageFrom === 'own') !== (packet.attackerOwner === owner)))) continue;
    if (spec.group && groups.has(spec.group)) {
      // A general "doesn't stack" key cannot decide which DIFFERENT effect wins.
      // Such a card needs an explicit reviewed aggregator, not iteration order.
      if (groups.get(spec.group) !== spec.amount)
        throw new EngineError('unsupported-modifier-conflict', 'Conflicting nonstacking modifiers need explicit card semantics.');
      continue;
    }
    if (spec.group) groups.set(spec.group, spec.amount);
    result.push({ id: `${id}/${field}`, amount: spec.amount, sourceOfTruth });
  }
  return result;
}
function monProhibited(s, catalog, owner, mon, action, attackId = null, route = null) {
  const entries = continuousEntries(s, catalog);
  if (entries.some((entry) => entry.spec.op === 'restriction' &&
      entry.spec.actions.includes(action) && entryTargets(s, catalog, entry, owner, mon) &&
      (action !== 'attack' || !entry.spec.attackIds || entry.spec.attackIds.includes(attackId)))) return true;
  if (action !== 'attack') return false;
  let uncertain = false;
  for (const entry of entries) if (entry.spec.op === 'ownedAttackRestriction' && entryTargets(s, catalog, entry, owner, mon)) {
    const selected = entry.spec.reference, actual = route.grant?.reference ?? { instanceId: route.sourceId, attackId };
    if (selected.attackId === actual.attackId &&
        s.cards[selected.instanceId].definitionId === s.cards[actual.instanceId].definitionId) return true;
    if (copiedAttack(s, catalog, selected).name === route.attack.name) uncertain = true;
  }
  if (uncertain) throw new EngineError('unresolved-owned-attack-identity',
    'A same-name attack from a different direct-use source needs a reviewed CN identity ruling, not an attackId collision or imported name rule.');
  return false;
}
function playerProhibited(s, catalog, player, action) {
  if (s.playerOngoing.some((e) => e.player === player && ongoingIsActive(e, s) && e.effect.op === 'playerRestriction' &&
      e.effect.actions.includes(action))) return true;
  return continuousEntries(s, catalog).some(({ spec, source }) => spec.op === 'playerRestriction' && spec.actions.includes(action) &&
    (spec.scope === 'all' || (spec.scope === 'own') === (source.owner === player)) &&
    (!spec.sourceActive || s.players[source.owner].active?.id === source.pokemonId));
}
// I.A-04: five Benched Pokémon unless a continuous printed effect raises the
// limit for a player who currently satisfies its in-play requirement.
function benchLimit(s, catalog, player, model = null) {
  if (s.phase === 'setup') return 5;
  model ??= sourceModel(s, catalog);
  if (!model.sources.some(({ binding }) => catalog.handler(binding.handlerId).operations?.includes('benchLimit'))) return 5;
  let limit = 5;
  for (const { spec } of continuousEntries(s, catalog, model)) if (spec.op === 'benchLimit' &&
      mons(s.players[player]).some((m) => matchesInPlaySelector(monDef(s, catalog, m), spec.requires, model.pokemon[m.id].types)))
    limit = Math.max(limit, spec.limit);
  return limit;
}
function effectiveProperty(s, catalog, owner, mon, field) {
  const values = continuousEntries(s, catalog).filter((entry) =>
    entry.spec.op === 'property' && entry.spec.field === field && entryTargets(s, catalog, entry, owner, mon));
  if (new Set(values.map(({ spec }) => canonicalJSON(spec.value))).size > 1)
    throw new EngineError('unsupported-property-conflict', 'Conflicting property replacements need explicit card ordering.');
  return values.length ? values[0].spec.value : monDef(s, catalog, mon).mechanics[field];
}
function protectionEntries(s, catalog, source, owner, mon, channel) {
  const model = sourceModel(s, catalog);
  return continuousEntries(s, catalog, model).filter((entry) => {
    const { spec } = entry;
    if (spec.op !== 'protection' || spec.channel !== channel ||
        !entryTargets(s, catalog, entry, owner, mon, model) ||
        !spec.categories.includes(source.category) ||
        !otherMatches(s, catalog, spec, source.category === 'attack' ? findMon(s, source.pokemonId) : null, model)) return false;
    if ((spec.from === 'own' && source.owner !== owner) || (spec.from === 'opponent' && source.owner === owner)) return false;
    return source.category !== 'trainer' ||
      ((!spec.trainerCategories || spec.trainerCategories.includes(cardDef(s, catalog, source.instanceId).mechanics.category)) &&
       (!spec.trainerOrigins || spec.trainerOrigins.includes(source.origin)));
  });
}
function protections(s, catalog, source, owner, mon, channel) {
  return protectionEntries(s, catalog, source, owner, mon, channel).map(({ id, sourceOfTruth, spec }) => ({
    id, sourceOfTruth, ...(spec.useRule === 'CN.E29' ? { useRule: spec.useRule, ruleId: 'effects.trainer-hand-use' } : {}),
  }));
}
function stadiumProtections(s, catalog, source) {
  return continuousEntries(s, catalog).filter(({ spec, source: provider }) =>
    spec.op === 'stadiumProtection' && matchesStadiumProtection(
      effectContext(s, catalog, provider), spec, source));
}
function effectBlocked(s, catalog, source, owner, mon) {
  const effects = protections(s, catalog, source, owner, mon, 'effects');
  if (effects.length) log(s, 'effects.protection', { targetId: mon.id, effectId: source.effectId, effects });
  return effects.length > 0;
}
function targetedPokemon(s, owner, source, event, target) {
  const p = s.players[owner];
  return mons(p).filter((m) =>
    target === 'active' ? m === p.active : target === 'bench' ? m !== p.active :
    target === 'self' ? m.id === source.pokemonId : target === 'event' ? m.id === event?.subjectId :
    target === 'attacker' ? m.id === event?.cause.source?.pokemonId : true);
}
// The printed side's holders' attached Tools of the printed kind.
function toolCards(s, catalog, source, event, a) {
  const owner = a.side === 'opponent' ? 1 - source.owner : source.owner;
  return targetedPokemon(s, owner, source, event, a.target).flatMap((m) => m.tools
    .filter((id) => !a.selector || matchesCardSelector(cardDef(s, catalog, id), a.selector)).map((id) => ({ id, owner, m })));
}
function damageOptions(s, catalog, source, attack) {
  const options = {};
  for (const b of attack.effects) {
    const h = catalog.handler(b.handlerId);
    if (h.timing === 'damageOptions') {
      const value = h.damageOptions(effectContext(s, catalog, { ...source, effectId: b.effectId, sourceOfTruth: b.sourceOfTruth }), clone(b.parameters));
      if (!value || Object.keys(value).some((key) => !['ignoreWeakness', 'ignoreResistance', 'ignoreDefenderEffects', 'applyBenchWeaknessResistance'].includes(key) || value[key] !== true))
        throw new EngineError('invalid-damage-options', 'Damage options must be explicit supported positive flags.');
      Object.assign(options, value);
    }
  }
  return options;
}
function damageModel(s, catalog, source, owner, target) {
  const attacker = findMon(s, source.pokemonId);
  if (!attacker) throw new EngineError('unsupported-attack-transition', 'The declared attacker left play before damage.');
  const position = s.players[owner].active === target ? 'active' : 'bench';
  const packet = { owner, position, attackerOwner: source.owner, attacker, target: { owner, m: target },
    attackId: executingAttack(s, catalog).attackId };
  return {
    targetId: target.id, owner, targetPosition: position, targetRelation: source.owner === owner ? 'self' : 'opponent',
    attackerTypes: sourceModel(s, catalog).pokemon[attacker.m.id].types,
    weakness: effectiveProperty(s, catalog, owner, target, 'weakness'),
    resistance: effectiveProperty(s, catalog, owner, target, 'resistance'),
    attackerModifiers: continuous(s, catalog, source.owner, attacker.m, 'attackDamage', packet),
    defenderModifiers: continuous(s, catalog, owner, target, 'defenseDamage', packet),
    preventions: protections(s, catalog, source, owner, target, 'damage'),
    battleValues: battleValueFacts(s, catalog, source, { owner, m: target }),
  };
}
/** Transient, read-only numeric facts, never printed-card metadata or a second
 * authoritative HP cache. All targets in a packet read the pre-application board. */
// II.D-17 Prize cards already taken, against the original physical deck size.
function prizesTakenQuery(s, owner) {
  return queryPrizesTaken({ ruleset: s.ruleset, deckSize: Object.values(s.cards).filter((card) => card.owner === owner).length,
    matchMode: s.matchMode, remainingPrizes: s.players[owner].prizes.length });
}
function battleValueFacts(s, catalog, source, target = null, model = sourceModel(s, catalog), nodes = attackQueryNodes(s, catalog)) {
  const stat = (found) => {
    if (!found) return null;
    const { owner, m } = found, maximumHp = hp(s, catalog, owner, m);
    const energies = model.pokemon[m.id].energies;
    return {
      damageCounters: m.counters, maximumHp,
      remainingHp: Math.max(0, maximumHp - m.counters * 10),
      retreatEnergy: retreatCost(s, catalog, owner, m),
      energyCards: m.energy.length, energyUnits: energies.reduce((n, e) => n + e.units.length, 0),
    };
  };
  const active = (owner) => s.players[owner].active ? { owner, m: s.players[owner].active } : null;
  const prizes = (owner) => prizesTakenQuery(s, owner);
  const holders = { self: findMon(s, source.pokemonId), ownActive: active(source.owner),
    opponentActive: active(1 - source.owner), target };
  const queries = {};
  for (const node of nodes) {
    const answer = battleQuery(s, catalog, source, holders, model, node);
    if (answer !== null) queries[battleQueryKey(node)] = answer;
  }
  return deepFreeze({
    pokemon: {
      self: stat(holders.self), ownActive: stat(holders.ownActive),
      opponentActive: stat(holders.opponentActive), target: stat(target),
    },
    prizes: { own: prizes(source.owner), opponent: prizes(1 - source.owner) },
    coins: damageCoinFacts(s.attack?.execution.damageCoins),
    effectCards: effectCardFacts(s.attack?.execution.effectCards),
    ...(Object.keys(queries).length ? { queries } : {}),
  });
}
// The executing attack's board/zone/history query nodes, from every binding of
// that attack (formula, extra packets and roll plans read one shared answer set).
// Damage handlers load only on attacks, so these facts exist only inside one.
const QUERY_KINDS = [...BATTLE_VALUE_QUERY_KINDS, ...BATTLE_PREDICATE_QUERY_KINDS];
function queryNodes(root) {
  const nodes = new Map();
  (function walk(value) {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      if (QUERY_KINDS.includes(value.kind)) nodes.set(battleQueryKey(value), value);
      Object.values(value).forEach(walk);
    }
  })(root);
  return [...nodes.values()];
}
const attackQueryNodes = (s, catalog) => queryNodes(executingAttack(s, catalog).effects.map((b) => b.parameters));
// A printed use condition reads the board when the card or Ability could be used.
// The load guard keeps it to facts that exist then (assertConditionPredicate).
function conditionPredicateMet(s, catalog, source, predicate) {
  return evaluateBattlePredicate(predicate, battleValueFacts(s, catalog, source, null, sourceModel(s, catalog), queryNodes(predicate)));
}
// A continuous effect's condition: query answers only, an absent holder reading as false/0.
function continuousConditionMet(s, catalog, source, condition, model) {
  const active = (owner) => s.players[owner].active ? { owner, m: s.players[owner].active } : null;
  const holders = { self: source.pokemonId ? findMon(s, source.pokemonId) ?? null : null,
    ownActive: active(source.owner), opponentActive: active(1 - source.owner), target: null };
  const queries = {};
  for (const node of queryNodes(condition)) queries[battleQueryKey(node)] = battleQuery(s, catalog, source, holders, model, node, true);
  return evaluateBattlePredicate(condition, { queries });
}
// A handler that computes from board facts (capability battle-values) gets the
// host's answers to its own binding's query nodes, at the moment it is asked.
function factContext(s, catalog, h, ctx, source, parameters) {
  return h.capabilities?.includes('battle-values') ? deepFreeze({ ...ctx,
    battleValues: battleValueFacts(s, catalog, source, null, sourceModel(s, catalog), queryNodes(parameters)) }) : ctx;
}
// II.D-13 FAQ2: an Ability counts only while it is in effect. I.B-02: a Tool is
// a card placed on the Pokémon. I.F: the five Special Conditions.
function pokemonMatches(s, catalog, model, m, node) {
  return (!node.selector || matchesInPlaySelector(monDef(s, catalog, m), node.selector, model.pokemon[m.id].types)) &&
    (!node.state || matchesPokemonState(m, model.pokemon[m.id], node.state));
}
function attachedEnergy(s, catalog, model, m, field, filter = {}) {
  const provides = (unit) => !filter.providedTypes || unit.some((t) => filter.providedTypes.includes(t));
  const cards = model.pokemon[m.id].energies.filter((e) => !filter.selector || matchesCardSelector(cardDef(s, catalog, e.instanceId), filter.selector));
  return field === 'energyCards' ? cards.filter((e) => e.units.some(provides)).length
    : cards.reduce((n, e) => n + e.units.filter(provides).length, 0);
}
/** One query's answer for this projection, or null when its holder does not exist. */
function battleQuery(s, catalog, source, holders, model, node, lenient = false) {
  const side = (who) => who === 'own' ? source.owner : 1 - source.owner;
  const set = () => (node.side === 'both' ? [0, 1] : [side(node.side)]).flatMap((owner) =>
    (node.zone === 'bench' ? s.players[owner].bench : mons(s.players[owner])))
    .filter((m) => !(node.excludeSelf && m.id === source.pokemonId) && pokemonMatches(s, catalog, model, m, node));
  switch (node.kind) {
    case 'pokemonCount': return set().length;
    case 'pokemonSum': {
      const group = Object.hasOwn(node, 'who') ? (holders[node.who] ? [holders[node.who].m] : lenient ? [] : null) : set();
      if (!group) return null;
      return group.reduce((n, m) => n + (node.field === 'damageCounters' ? m.counters : node.field === 'tools'
        ? m.tools.filter((id) => !node.tool || matchesCardSelector(cardDef(s, catalog, id), node.tool)).length
        : attachedEnergy(s, catalog, model, m, node.field, node.energy)), 0);
    }
    case 'zoneCount': {
      if (node.zone === 'prizes') requireRule(catalog.ruleset, 'prizes.remaining');
      const p = s.players[side(node.side)], cards = p[node.zone === 'lostZone' ? 'lost' : node.zone];
      return node.selector ? cards.filter((id) => matchesCardSelector(cardDef(s, catalog, id), node.selector)).length : cards.length;
    }
    case 'pokemonIs': {
      const holder = holders[node.who];
      if (!holder) return lenient ? false : null;
      return pokemonMatches(s, catalog, model, holder.m, node) &&
        (!node.position || (s.players[holder.owner].active?.id === holder.m.id) === (node.position === 'active'));
    }
    case 'movedCards': {
      const entry = s.attack?.execution.effectCards.find((e) => e.effectId === node.effectId);
      return entry ? entry.cards.filter((id) => matchesCardSelector(cardDef(s, catalog, id), node.selector)).length : null;
    }
    case 'stadiumInPlay':
      return !!s.stadium && (node.owner === 'any' || s.cards[s.stadium].owner === side(node.owner)) &&
        (!node.selector || matchesCardSelector(cardDef(s, catalog, s.stadium), node.selector));
  }
  // historyFact: the effect user's own turn (II.E-11, E-24, E-25, E-26).
  const clock = { turn: s.turn, during: s.current }, rules = BATTLE_HISTORY_RULES;
  switch (node.fact) {
    case 'previousOpponentKnockout':
      requireRule(catalog.ruleset, rules.previousOpponentKO.id);
      return hadKnockoutInPreviousOpponentTurn(s.battleHistory, clock, { owner: source.owner, cause: node.cause });
    case 'movedToActive':
      requireRule(catalog.ruleset, rules.benchToActive.id);
      return wasMovedFromBenchToActiveThisTurn(s.battleHistory, clock, source.owner, source.pokemonId);
    case 'healed':
      requireRule(catalog.ruleset, rules.healed.id);
      return wasHealedThisTurn(s.battleHistory, clock, source.owner, source.pokemonId);
    case 'evolvedThisTurn': {
      // II.E-23: the actual evolution event of this Pokémon this turn, from the card it was put on.
      requireRule(catalog.ruleset, 'evolution.history');
      const evolution = holders.self?.m.facts.evolution;
      return !!evolution && evolution.turn === s.turn &&
        (!node.selector || matchesCardSelector(cardDef(s, catalog, evolution.fromCardId), node.selector));
    }
    case 'firstOwnTurn': case 'secondPlayerFirstTurn':
      // I.A-05: the user's own first turn, judged during that turn; the second player's is its turn 2.
      requireRule(catalog.ruleset, 'history.first-turn');
      return s.current === source.owner && s.players[source.owner].turns === 1 && (node.fact === 'firstOwnTurn' || s.first !== source.owner);
  }
  requireRule(catalog.ruleset, rules.supporterFromHand.id);
  return wasSupporterPlayedFromHandThisTurn(s.battleHistory, clock, source.owner,
    node.selector ? (cardId) => matchesCardSelector(cardDef(s, catalog, cardId), node.selector) : undefined);
}
const effectCardFacts = (entries = []) => Object.fromEntries(entries.map((e) => [e.effectId, e.cards.length]));
const countedEffect = (catalog, binding) => !!catalog.handler(binding.handlerId).capabilities?.includes('effect-card-count');
// II.B-02 / II.D-02 文例1: a counted before-damage effect records the cards it
// actually moved for its own execution, including an explicit zero.
function recordEffectCards(s, catalog, d, cards) {
  const binding = executionBinding(s, catalog, d.source);
  if (!countedEffect(catalog, binding)) return;
  const frame = s.attack, execution = frame?.execution;
  if (!frame || d.source.category !== 'attack' || d.source.instanceId !== frame.sourceId ||
      d.source.pokemonId !== frame.pokemonId || (d.source.copyId ?? null) !== execution.copyId ||
      execution.damageCoins !== null || execution.effectCards.some((e) => e.effectId === d.source.effectId))
    throw new EngineError('invalid-effect-count', 'A counted effect records once, for its own attack execution, before damage calculation.');
  const entry = { effectId: d.source.effectId, cards: [...cards] };
  execution.effectCards.push(entry);
  log(s, 'damage.effect-count', { frameId: frame.id, copyId: execution.copyId, turn: s.turn, ...clone(entry) });
}
function assertEffectCards(s, catalog, execution, models) {
  const frame = s.attack, attack = executingAttack(s, catalog, execution);
  const counted = attack.effects.filter((b) => countedEffect(catalog, b)).map((b) => b.effectId);
  const records = s.events.filter((e) => e.ruleId === 'damage.effect-count' &&
    e.data.frameId === frame.id && e.data.copyId === execution.copyId);
  const ids = execution.effectCards.map((e) => e.effectId);
  if (new Set(ids).size !== ids.length || ids.some((id) => !counted.includes(id)) ||
      execution.damageCoins !== null && ids.length !== counted.length ||
      records.length !== ids.length || records.some((e, i) => e.visibility !== 'public' || e.data.turn !== s.turn ||
        canonicalJSON({ effectId: e.data.effectId, cards: e.data.cards }) !== canonicalJSON(execution.effectCards[i])) ||
      execution.effectCards.some((e) => {
        const b = attack.effects.find((b) => b.effectId === e.effectId);
        const op = catalog.handler(b.handlerId === 'cn.optionalCounted@1' ? b.parameters.effect.handlerId : b.handlerId).operations[0];
        // Attached Energy and hand/deck cards are the user's own; a discarded Tool may be either player's;
        // a looked-at hand is the opponent's.
        return e.cards.some((id) => !s.cards[id] || !['discardTools', 'opponentHand', 'discardStadium'].includes(op) && s.cards[id].owner !== frame.player ||
          op === 'opponentHand' && s.cards[id].owner === frame.player ||
          op === 'discardStadium' && cardDef(s, catalog, id).mechanics.category !== 'stadium' ||
          op === 'discardEnergy' && cardDef(s, catalog, id).kind !== 'energy' ||
          op === 'discardTools' && cardDef(s, catalog, id).mechanics.category !== 'tool');
      }) ||
      models?.some((model) => canonicalJSON(model.battleValues.effectCards) !== canonicalJSON(effectCardFacts(execution.effectCards))))
    throw new EngineError('invalid-effect-count', 'Counted effect results must match their public receipts, own attack bindings and frozen damage facts.');
}
function damageCoinFacts(preparation) {
  return Object.fromEntries((preparation?.entries ?? []).filter((entry) => entry.receipt !== null).map((entry) =>
    [entry.key, { heads: entry.receipt.heads, tails: entry.receipt.tails, flips: entry.receipt.flips }]));
}
function damageRollBindings(catalog, attack) {
  return attack.effects.filter((b) => catalog.handler(b.handlerId).capabilities?.includes('damage-rolls'));
}
function rollTarget(s, catalog, source, binding) {
  // Only the primary formula has a selected target at preparation time.
  // Extra packets must use explicit self/ownActive/opponentActive queries;
  // do not pretend an as-yet-unselected Bench target is the opposing Active.
  return catalog.handler(binding.handlerId).timing === 'formula' ?
    { owner: 1 - source.owner, m: s.players[1 - source.owner].active } : null;
}
function resolveDamageRollSpec(plan, facts) {
  const spec = clone(plan.spec);
  if (spec.kind === 'fixed' && typeof spec.count !== 'number')
    spec.count = evaluateBattleValue(spec.count, facts);
  assertDamageCoinSpec(spec);
  return spec;
}
function prepareDamageCoins(s, catalog) {
  const frame = s.attack, execution = frame.execution, attack = executingAttack(s, catalog);
  if (execution.damageCoins !== null)
    throw new EngineError('invalid-damage-coins', 'Damage calculation may prepare its coins only once.');
  const data = { entries: [], rngBefore: [...s.rng], rngAfter: [...s.rng] }, keys = new Set();
  execution.damageCoins = data;
  for (const binding of damageRollBindings(catalog, attack)) {
    const h = catalog.handler(binding.handlerId), source = sourceFor(s, catalog, frame.sourceId, frame.player,
      'attack', binding, frame.pokemonId, frame.attack.attackId, null, execution);
    const target = rollTarget(s, catalog, source, binding), ctx = effectContext(s, catalog, source);
    const plans = h.damageRolls(deepFreeze({ ...ctx, battleValues: battleValueFacts(s, catalog, source, target) }), clone(binding.parameters));
    assertJSON(plans);
    if (!validateDamageRollPlans(plans) ||
        canonicalJSON(plans) !== canonicalJSON(binding.parameters.rolls ?? []))
      throw new EngineError('invalid-damage-coins', 'Version-one coin planning must describe the binding’s explicit reviewed rolls exactly.');
    for (const plan of plans) {
      if (keys.has(plan.key)) throw new EngineError('duplicate-damage-coin-key', 'Coin keys must be unique throughout one attack-content execution.');
      keys.add(plan.key);
      const facts = battleValueFacts(s, catalog, source, target);
      if (plan.condition && !evaluateBattlePredicate(plan.condition, facts)) {
        data.entries.push({ effectId: binding.effectId, key: plan.key, spec: null, receipt: null }); continue;
      }
      const spec = resolveDamageRollSpec(plan, facts), receipt = rollDamageCoin(spec, () => randomIndex(s.rng, 2) === 0);
      data.entries.push({ effectId: binding.effectId, key: plan.key, spec, receipt });
      if (receipt.flips > 0) execution.performed = true;
      log(s, 'damage.coins', { kind: 'rolled', frameId: frame.id, copyId: execution.copyId, turn: s.turn,
        effectId: binding.effectId, key: plan.key, source, receipt });
    }
  }
  data.rngAfter = [...s.rng];
  log(s, 'damage.coins', { kind: 'prepared', frameId: frame.id, copyId: execution.copyId, turn: s.turn,
    source: executingSource(s, catalog), data }, 'private');
}
function assertDamageCoins(s, catalog, execution, models) {
  const frame = s.attack, data = execution.damageCoins;
  const records = s.events.filter((e) => e.ruleId === 'damage.coins' && e.data.kind === 'prepared' &&
    e.data.frameId === frame.id && e.data.copyId === execution.copyId);
  const stages = s.events.filter((e) => e.ruleId === 'damage.expression' && e.data.kind === 'stage-snapshot' &&
    e.data.frameId === frame.id && e.data.copyId === execution.copyId);
  const rolled = s.events.filter((e) => e.ruleId === 'damage.coins' && e.data.kind === 'rolled' &&
    e.data.frameId === frame.id && e.data.copyId === execution.copyId);
  if (data === null) {
    if (records.length || stages.length || rolled.length || models !== null)
      throw new EngineError('invalid-damage-coins', 'A calculated execution cannot discard its coin preparation.');
    return;
  }
  const source = executingSource(s, catalog, execution);
  if (records.length !== 1 || records[0].visibility !== 'private' || records[0].data.turn !== s.turn ||
      canonicalJSON(records[0].data.source) !== canonicalJSON(source) ||
      canonicalJSON(records[0].data.data) !== canonicalJSON(data) || stages.length !== 1 ||
      !Array.isArray(stages[0].data.models) || !stages[0].data.models.length ||
      models !== null && canonicalJSON(s.rng) !== canonicalJSON(data.rngAfter))
    throw new EngineError('invalid-damage-coins', 'Prepared rolls must retain their original frame, source, turn, host receipt and RNG boundary.');
  const snapshot = stages[0].data.models, rng = [...data.rngBefore], prefix = [], keys = new Set();
  if (snapshot.some((model) => canonicalJSON(model.battleValues.coins) !== canonicalJSON(damageCoinFacts(data))))
    throw new EngineError('invalid-damage-coins', 'Frozen numeric coin facts must match this execution’s complete actual receipts.');
  const attack = executingAttack(s, catalog, execution);
  const plans = damageRollBindings(catalog, attack).flatMap((binding) =>
    (binding.parameters.rolls ?? []).map((plan) => ({ binding, plan })));
  if (data.entries.length !== plans.length)
    throw new EngineError('invalid-damage-coins', 'Every declared coin plan needs its exact resolved or explicitly skipped entry.');
  let published = 0;
  for (const [index, { binding, plan }] of plans.entries()) {
    const entry = data.entries[index];
    if (entry.effectId !== binding.effectId || entry.key !== plan.key || keys.has(entry.key))
      throw new EngineError('invalid-damage-coins', 'Coin entries cannot change order, borrow keys or duplicate a declaration.');
    keys.add(entry.key);
    const primary = catalog.handler(binding.handlerId).timing === 'formula';
    const stored = primary ? snapshot.find((m) => m.owner === 1 - source.owner && m.targetPosition === 'active') : snapshot[0];
    if (!stored) throw new EngineError('invalid-damage-coins', 'Primary coin queries need their original opposing Active snapshot.');
    const facts = { ...stored.battleValues, pokemon: { ...stored.battleValues.pokemon,
      target: primary ? stored.battleValues.pokemon.target : null }, coins: damageCoinFacts({ entries: prefix }) };
    const skip = plan.condition && !evaluateBattlePredicate(plan.condition, facts);
    const events = rolled.filter((e) => e.data.key === entry.key);
    if (skip) {
      if (entry.spec !== null || entry.receipt !== null || events.length)
        throw new EngineError('invalid-damage-coins', 'A skipped instruction has no flip result or borrowed zero.');
    } else {
      const spec = resolveDamageRollSpec(plan, facts);
      assertDamageCoinReceipt(spec, entry.receipt);
      const expected = rollDamageCoin(spec, () => randomIndex(rng, 2) === 0);
      const actualSource = sourceFor(s, catalog, frame.sourceId, frame.player, 'attack', binding,
        frame.pokemonId, frame.attack.attackId, null, execution);
      if (canonicalJSON(entry.spec) !== canonicalJSON(spec) || canonicalJSON(expected) !== canonicalJSON(entry.receipt) ||
          events.length !== 1 || events[0].visibility !== 'public' || events[0].data.turn !== s.turn ||
          events[0].data.effectId !== binding.effectId ||
          canonicalJSON(events[0].data.source) !== canonicalJSON(actualSource) ||
          canonicalJSON(events[0].data.receipt) !== canonicalJSON(entry.receipt) ||
          entry.receipt.flips > 0 && !execution.performed)
        throw new EngineError('invalid-damage-coins', 'Actual outcome receipts must match the reviewed instruction and replayed private RNG, without rerolling the game.');
      published++;
    }
    prefix.push(entry);
  }
  if (published !== rolled.length || canonicalJSON(rng) !== canonicalJSON(data.rngAfter))
    throw new EngineError('invalid-damage-coins', 'Coin publication or the saved RNG endpoint contradicts the actual preparation.');
}
function dealAttackDamage(s, catalog, source, targets, amount, options) {
  const frame = s.attack;
  if (!frame || source.category !== 'attack' || source.attackId !== frame.attack.attackId ||
      source.owner !== frame.player || source.pokemonId !== frame.pokemonId || source.instanceId !== frame.sourceId ||
      (source.copyId ?? null) !== frame.execution.copyId)
    throw new EngineError('invalid-damage-source', 'Attack damage requires the actual, currently resolving declared attack.');
  // Calculate a whole simultaneous packet batch before recording any counters.
  // During the damage stage, even later packet choices use the pre-damage model.
  const packets = targets.map(({ owner, m }, index) => {
    const model = frame.damageModels?.find((x) => x.targetId === m.id) ?? damageModel(s, catalog, source, owner, m);
    return { owner, m, result: calculateAttackDamage({ ...model, amount: Array.isArray(amount) ? amount[index] : amount, ...options }) };
  });
  for (const { owner, m, result } of packets) {
    addCounters(s, catalog, owner, m, result.counters, { kind: 'attackDamage', source });
    if (result.damage > 0) frame.events.push(makeTriggerEvent(s, catalog, 'attackDamage', owner, m,
      { damage: result.damage, cause: { kind: 'attackDamage', source } }));
    log(s, 'attack.order', { player: source.owner, attackId: source.attackId, pokemonId: source.pokemonId, targetId: m.id,
      damage: result.damage, calculation: result.trace, effectId: source.effectId,
      ...(source.contentSource ? { ...(source.copyId ? { copyId: source.copyId } : { grantId: source.grantId }),
        contentSource: clone(source.contentSource),
        contentSourceOfTruth: clone(source.sourceOfTruth) } : {}) });
  }
  const performed = packets.some((p) => p.result.damage > 0);
  if (performed) frame.execution.performed = true;
  return performed;
}
function hp(s, catalog, owner, m) {
  const result = continuous(s, catalog, owner, m, 'hp')
    .reduce((n, x) => n + BigInt(x.amount), BigInt(monDef(s, catalog, m).mechanics.hp));
  if (result > 9007199254740990n || result < -9007199254740990n)
    throw new EngineError('numeric-overflow', 'Effective maximum HP must remain an exact, signed ten-point integer.');
  return Number(result);
}
function retreatCost(s, catalog, owner, m) {
  const adjustments = continuous(s, catalog, owner, m, 'retreat').map((a) => ({ ...a, energyType: 'Colorless' }));
  const erasures = continuousEntries(s, catalog).filter((e) => e.spec.op === 'energyRequirement' &&
    e.spec.action === 'retreat' && e.spec.mode === 'erase' && entryTargets(s, catalog, e, owner, m))
    .map((e) => ({ id: e.id, sourceOfTruth: e.sourceOfTruth }));
  return resolveEnergyRequirements({ printed: { Colorless: monDef(s, catalog, m).mechanics.retreatCost }, adjustments, erasures })[0].total;
}
function energyCards(s, catalog, m) {
  return sourceModel(s, catalog).pokemon[m.id].energies;
}
function enforceEnergyRetention(s, catalog) {
  let changed = true;
  while (changed) {
    changed = false;
    const model = sourceModel(s, catalog), removals = [];
    for (const { owner, m } of allMons(s)) for (const id of m.energy) {
      const filter = cardDef(s, catalog, id).mechanics.remainOn;
      if (filter && !matchesInPlaySelector(monDef(s, catalog, m), filter, model.pokemon[m.id].types))
        removals.push({ owner, m, id });
    }
    for (const { owner, m, id } of removals) {
      remove(m.energy, id); discard(s, catalog, id); changed = true;
      log(s, 'energy.move', { player: owner, energyId: id, pokemonId: m.id, discarded: 'attachment-condition',
        sourceOfTruth: cardDef(s, catalog, id).sourceOfTruth });
    }
  }
}
function recordTransitionKO(s, catalog, owner, m, wasLethal, source) {
  if (!wasLethal && m.counters * 10 >= hp(s, catalog, owner, m))
    m.facts.knockoutCause = { kind: 'effect', source: clone(source) };
}
function evolveMon(s, catalog, owner, m, cardId, origin, source = null) {
  const fromCardId = top(m), wasLethal = m.counters * 10 >= hp(s, catalog, owner, m);
  m.stack.push(cardId); m.evolvedTurn = s.turn; m.conditions = emptyConditions();
  m.facts.evolution = { turn: s.turn, fromCardId, toCardId: cardId, method: source ? 'effect' : 'ordinary', origin };
  retainOngoing(s, (e) => !(e.targetId === m.id && e.clearOnEvolution), 'evolution',
    { owner, pokemonId: m.id, fromCardId, toCardId: cardId });
  enforceEnergyRetention(s, catalog);
  if (source) recordTransitionKO(s, catalog, owner, m, wasLethal, source);
  log(s, source ? 'effects.evolve' : 'turn.evolve', { player: owner, cardId, pokemonId: m.id,
    fromCardId, origin, ...(source ? { sourceOfTruth: source.sourceOfTruth } : {}) });
  return makeTriggerEvent(s, catalog, 'evolve', owner, m, { origin, cardId,
    ...(source ? { cause: { kind: 'effect', source } } : {}) });
}
function assertPokemonTransition(s, catalog, d) {
  const ctx = effectContext(s, catalog, d.source, d.event ?? null), a = d.action;
  if (d.transition) {
    const m = transitionTargets(ctx, a).find((m) => m.id === d.transition.pokemonId);
    if (!m || top(m) !== d.transition.topCardId ||
        canonicalJSON(d.lookedAt) !== canonicalJSON(s.players[d.source.owner][a.from]) ||
        a.op === 'evolvePokemon' && !evolutionTiming(s, d.source.owner, m, a.timing).allowed ||
        d.stage === 'transition-empty' && (a.from !== 'deck' || transitionCards(ctx, a, m).length || !d.lookedAt.length))
      throw new EngineError('invalid-pokemon-transition', 'Saved transition must retain its actual Pokémon, top card, eligibility and inspected zone.');
  }
  if (d.devolutionPlan) {
    const pool = transitionTargets(ctx, a).filter((m) => devolutionDepth(ctx, m) > 0), plan = d.devolutionPlan;
    const bounds = selectionBounds({ ...a.selection, available: pool.length });
    let sawNull = false;
    if (new Set(plan.map((p) => p.pokemonId)).size !== plan.length || !canSelectCount(bounds, plan.length))
      throw new EngineError('invalid-pokemon-transition', 'Devolution targets must remain unique and satisfy their original quantity.');
    for (const p of plan) {
      const m = pool.find((m) => m.id === p.pokemonId);
      if (!m || top(m) !== p.topCardId ||
          p.count !== null && (sawNull || !canSelectCount(selectionBounds({ ...a.layers, available: devolutionDepth(ctx, m) }), p.count)))
        throw new EngineError('invalid-pokemon-transition', 'Saved devolution layers must remain a top-down prefix with a valid selection cursor.');
      if (p.count === null) sawNull = true;
    }
    if ((d.stage === 'devolution-count') !== sawNull)
      throw new EngineError('invalid-pokemon-transition', 'Devolution application needs every layer count, with no unresolved choice.');
  }
}
function assertEnergyPlan(s, catalog, d) {
  const ctx = effectContext(s, catalog, d.source, d.event ?? null), pool = attachedEnergyPool(ctx, d.action);
  const plan = d.energyPlan, ids = plan.chosen.map((c) => c.instanceId);
  if (new Set(ids).size !== ids.length || plan.chosen.some((c) => !pool.some((p) => p.instanceId === c.instanceId && p.originId === c.originId)) ||
      !attachedEnergySelection(pool, d.action, ids).valid ||
      new Set(plan.assignments.map((a) => a.instanceId)).size !== plan.assignments.length ||
      plan.assignments.some((a) => !ids.includes(a.instanceId)))
    throw new EngineError('invalid-energy-plan', 'Saved Energy selection must retain its original cards, units and assignments.');
  if (d.action.op !== 'moveEnergy') {
    if (plan.assignments.length || d.stage !== 'energy-apply') throw new EngineError('invalid-energy-plan', 'Discarding has no transfer recipients.');
  } else {
    if (d.action.distribution === 'singleRecipient' && !energyRecipients(ctx, d.action, plan.chosen).length)
      throw new EngineError('invalid-energy-plan', 'Saved Energy cards must still have a common eligible transfer recipient.');
    if (plan.assignments.length > plan.chosen.length ||
        (d.stage === 'energy-apply') !== (plan.assignments.length === plan.chosen.length))
      throw new EngineError('invalid-energy-plan', 'Transfer receipt cursor and recipients must remain complete.');
    for (const a of plan.assignments) {
      const chosen = d.action.distribution === 'singleRecipient' ? plan.chosen : [plan.chosen.find((c) => c.instanceId === a.instanceId)];
      if (!energyRecipients(ctx, d.action, chosen).some((m) => m.id === a.targetId))
        throw new EngineError('invalid-energy-plan', 'Saved recipients must be eligible and belong to the Energy holder.');
    }
    if (d.action.distribution === 'singleRecipient' && new Set(plan.assignments.map((a) => a.targetId)).size > 1)
      throw new EngineError('invalid-energy-plan', 'This effect requires one common recipient, not separate destinations.');
  }
}
function attackRequirements(s, catalog, owner, m, attack, sourceId, execution = null) {
  const adjustments = [], erasures = [], alternatives = [], groups = new Map();
  for (const e of continuousEntries(s, catalog)) {
    const { spec } = e;
    if (spec.op !== 'energyRequirement' || spec.action !== 'attack' || !entryTargets(s, catalog, e, owner, m) ||
        spec.attackIds && !spec.attackIds.includes(attack.attackId)) continue;
    let amount = spec.amount ?? null;
    if (spec.perPrizesTaken) {
      const taken = prizesTakenQuery(s, spec.perPrizesTaken === 'own' ? e.source.owner : 1 - e.source.owner);
      // An unresolved count (tiebreak scope) refuses the attack instead of guessing its cost.
      if (taken.status !== 'resolved') return [];
      amount *= taken.count;
    }
    const value = canonicalJSON([spec.mode, spec.energyType ?? null, amount]);
    if (spec.group && groups.has(spec.group)) {
      if (groups.get(spec.group) !== value) throw new EngineError('unsupported-modifier-conflict', 'Conflicting nonstacking Energy requirements need explicit card semantics.');
      continue;
    }
    if (spec.group) groups.set(spec.group, value);
    const change = { id: e.id, sourceOfTruth: e.sourceOfTruth };
    if (spec.mode === 'erase') erasures.push(change);
    else adjustments.push({ ...change, energyType: spec.energyType, amount });
  }
  if (s.phase !== 'setup') for (const binding of attack.effects) {
    const h = catalog.handler(binding.handlerId);
    if (h.timing !== 'energyOptions') continue;
    const source = sourceFor(s, catalog, sourceId, owner, 'attack', binding, m.id,
      execution?.reference ? s.attack.attack.attackId : attack.attackId, null, execution);
    const option = h.energyOptions(effectContext(s, catalog, source), clone(binding.parameters));
    if (option === null) continue;
    if (!validateEnergyOption(option)) throw new EngineError('invalid-energy-option', 'Conditional Energy requirements must return an explicit reviewed cost or null.');
    alternatives.push({ id: canonicalJSON([binding.effectId, sourceId]), cost: option.cost, sourceOfTruth: binding.sourceOfTruth });
  }
  return resolveEnergyRequirements({ printed: attack.cost, adjustments, erasures, alternatives });
}
function executingAttack(s, catalog, execution = s.attack.execution) {
  return execution.reference ? copiedAttack(s, catalog, execution.reference) : s.attack.attack;
}
function executingSource(s, catalog, execution = s.attack.execution) {
  const attack = executingAttack(s, catalog, execution);
  const { contentSource, copyId, grantId, ...actor } = clone(s.attack.source);
  return { ...actor, ...attackSourceFields(s, execution),
    effectId: `attack:${attack.attackId}`, sourceOfTruth: attack.sourceOfTruth };
}
function attackFlow(s) {
  return { frameId: s.attack.id, player: s.attack.player, pokemonId: s.attack.pokemonId, sourceId: s.attack.sourceId, copyId: s.attack.execution.copyId };
}
function imposedAttackCheck(s, catalog, m) {
  const entries = continuousEntries(s, catalog).filter((e) => e.spec.op === 'attackCheck' &&
    entryTargets(s, catalog, e, s.current, m));
  let group;
  try { group = groupImposedChecks(entries); }
  catch (error) {
    throw new EngineError('unsupported-attack-checks', error.message,
      { sourceOfTruth: requireRule(catalog.ruleset, 'attack.failure.imposed').sourceOfTruth });
  }
  if (!group.length) return true;
  const receipt = rollFailureCoin(group[0].spec.coin, () => randomIndex(s.rng, 2) === 0);
  log(s, 'attack.failure.imposed', { pokemonId: m.id, player: s.current, receipt,
    checks: group.map((e) => ({ id: e.id, source: clone(e.source), coin: clone(e.spec.coin) })) });
  return receipt.passed;
}
function assertCopyFailureScope(s, catalog) {
  const frame = s.attack;
  // Ordinary C-18 chains that only copy have no earlier body to undo. More
  // elaborate compositions need a sourced failure scope, not invented rollback.
  if (frame.copies.some((saved) => {
    const parent = executingAttack(s, catalog, saved.execution);
    return parent.printedDamage !== null && parent.printedDamage.value !== 0 ||
      parent.effects.length !== 1 || parent.effects[0].handlerId !== 'cn.copyAttack@1' ||
      canonicalJSON(catalog.handler(parent.effects[0].handlerId).operations) !== canonicalJSON(['copyAttack']) ||
      saved.continuation.frames.some((f) => f.kind !== 'sequence' || f.remaining.length || f.performed);
  })) throw new EngineError('unresolved-copy-failure', 'Failure after an enclosing attack already has other content needs reviewed CN cancellation semantics.');
}
function finishFailedAttack(s, catalog) {
  assertCopyFailureScope(s, catalog);
  // Pure C-18 callers cannot resume after the borrowed self-check fails.
  // Their single copy leaf really completed unsuccessfully; close each exact
  // continuation before removing the stack, rather than orphaning live tokens.
  for (const saved of s.attack.copies) finishEffect(s, catalog, saved.continuation, false);
  const player = s.attack.player;
  s.attack = null; s.queue = [];
  prepend(s, tasks('ko'), tasks('end-turn', { player }));
}
function commitmentCards(s, catalog, ids, owner) {
  if (ids.some((id) => s.cards[id]?.owner !== owner))
    throw new EngineError('invalid-attack-payment', 'The original payment hand must retain actual owned cards.');
  return ids.map((instanceId) => ({ instanceId, definition: cardDef(s, catalog, instanceId) }));
}
function assertAttackPaymentChoice(s, catalog, d, execution = s.attack.execution, live = true) {
  if (!validateAttackPaymentChoice(d))
    throw new EngineError('invalid-attack-payment', 'Invalid self-failure payment choice shape.');
  const frame = s.attack, spec = executingAttack(s, catalog, execution).failureCheck?.handPayment;
  const requested = copyRecord(s, d.id, 'requested', 'attack.failure.hand-payment');
  const { selected, ...choice } = d;
  if (!spec || d.turn !== s.turn ||
      s.events.find((e) => e.data === requested)?.visibility !== frame.player ||
      canonicalJSON(d.flow) !== canonicalJSON({ ...attackFlow(s), copyId: execution.copyId }) ||
      canonicalJSON(requested?.choice) !== canonicalJSON(choice) ||
      canonicalJSON(requested?.source) !== canonicalJSON(executingSource(s, catalog, execution)) ||
      canonicalJSON(attackCommitmentPool(commitmentCards(s, catalog, d.hand, frame.player), spec)) !== canonicalJSON(d.eligible) ||
      live && canonicalJSON(d.hand) !== canonicalJSON(s.players[frame.player].hand))
    throw new EngineError('invalid-attack-payment', 'A self-failure payment must retain its exact declaration, original hand, predicate and private request receipt.');
  return spec;
}
function assertAttackPaymentReceipt(s, catalog, execution) {
  const receipt = execution.failureReceipt;
  if (!validateAttackPaymentReceipt(receipt) || !receipt.passed)
    throw new EngineError('invalid-attack-payment', 'A running attack needs its successful, exact self-failure payment receipt.');
  const requested = copyRecord(s, receipt.id, 'requested', 'attack.failure.hand-payment');
  if (!requested) throw new EngineError('invalid-attack-payment', 'Missing original self-failure payment request.');
  const spec = assertAttackPaymentChoice(s, catalog, requested.choice, execution, false);
  const result = resolveAttackCommitment(commitmentCards(s, catalog, requested.choice.hand, s.attack.player), spec, receipt.selected);
  const resolved = copyRecord(s, receipt.id, 'resolved', 'attack.failure.hand-payment');
  if (!result.passed || canonicalJSON(resolved?.receipt) !== canonicalJSON(receipt) ||
      canonicalJSON(resolved?.source) !== canonicalJSON(executingSource(s, catalog, execution)))
    throw new EngineError('invalid-attack-payment', 'Saved payment results must match the original selected cards and committed receipt.');
}
function beginAttackPayment(s, catalog, attack) {
  const frame = s.attack, hand = [...s.players[frame.player].hand], spec = attack.failureCheck.handPayment;
  const cards = commitmentCards(s, catalog, hand, frame.player), eligible = attackCommitmentPool(cards, spec);
  const choice = { id: `attackpay${++s.serial}`, turn: s.turn, flow: attackFlow(s), hand, eligible };
  log(s, 'attack.failure.hand-payment', { kind: 'requested', id: choice.id, choice,
    source: executingSource(s, catalog) }, frame.player);
  const canPay = canPayAttackCommitment(cards, spec);
  // Always ask, including a zero-only response. The public waiting state must
  // not disclose whether the owner's hidden hand has enough eligible cards.
  ask(s, { player: frame.player, kind: 'attack-payment', options: canPay ? eligible : [],
    minimum: 0, maximum: canPay ? spec.count : 0, allowZero: true, forcePrompt: true,
    resume: 'attack-payment', data: choice, ruleId: 'attack.failure.hand-payment' });
}
function ownAttackCheck(s, catalog, attack) {
  const frame = s.attack;
  if (!attack.failureCheck) { frame.execution.phase = 'body'; return true; }
  assertCopyFailureScope(s, catalog);
  if (attack.failureCheck.handPayment) { beginAttackPayment(s, catalog, attack); return false; }
  // 「如果…的话，则这个招式失败」 is judged on the board when the attack is used.
  const predicate = attack.failureCheck.predicate;
  const receipt = predicate ? { kind: 'predicate', passed: !evaluateBattlePredicate(predicate, battleValueFacts(s, catalog,
    executingSource(s, catalog), null, sourceModel(s, catalog), queryNodes(predicate))) } :
    rollFailureCoin(attack.failureCheck.coin, () => randomIndex(s.rng, 2) === 0);
  frame.execution.failureReceipt = receipt; frame.execution.performed = true;
  log(s, 'attack.failure.self', { player: frame.player, pokemonId: frame.pokemonId, attackId: frame.attack.attackId,
    source: executingSource(s, catalog), receipt, sourceOfTruth: clone(attack.failureCheck.sourceOfTruth) });
  if (receipt.passed) { frame.execution.phase = 'body'; return true; }
  // A failed own-text condition is still a used attack. Nothing in its damage
  // or body can run, including suspended copy callers or damage boosts.
  finishFailedAttack(s, catalog);
  return false;
}
function beginAttackContent(s, catalog) {
  const attack = executingAttack(s, catalog);
  if (!ownAttackCheck(s, catalog, attack)) return;
  beginAttackBody(s, catalog);
}
function beginAttackBody(s, catalog) {
  const frame = s.attack, attack = executingAttack(s, catalog);
  frame.options = damageOptions(s, catalog, executingSource(s, catalog), attack);
  prepend(s, ...effectTasks(s, catalog, frame.sourceId, frame.player, 'attack', attack.effects, 'beforeDamage',
    frame.pokemonId, frame.attack.attackId, null, frame.execution), tasks('after-attack', attackFlow(s)));
}
function copyPool(s, catalog, d, choiceId = null) {
  const frame = s.attack, m = findMon(s, frame.pokemonId)?.m;
  if (!m) throw new EngineError('unsupported-attack-transition', 'Copy selection requires its original, still-in-play user.');
  const ctx = effectContext(s, catalog, d.source);
  const units = energyCards(s, catalog, m).flatMap((c) => c.units);
  return copyCandidates(ctx, d.action).filter((ref) => {
    const attack = copiedAttack(s, catalog, ref);
    if (d.action.energy === 'ignore') return true;
    const routes = d.action.energy === 'printed' ? resolveEnergyRequirements({ printed: attack.cost }) :
      attackRequirements(s, catalog, frame.player, m, attack, frame.sourceId, { reference: ref, copyId: choiceId, performed: false });
    return routes.some((r) => meetsEnergyRequirement(units, r));
  });
}
function assertCopyChoice(s, catalog, d, live = true) {
  const choice = d.copyChoice, gate = copyRecord(s, choice.id, 'gate');
  if (!gate || canonicalJSON(gate.choice) !== canonicalJSON(choice) || canonicalJSON(gate.source) !== canonicalJSON(d.source) ||
      canonicalJSON(gate.action) !== canonicalJSON(d.action) ||
      choice.coin !== (d.action.coin === 'none' ? null : d.action.coin) ||
      live && canonicalJSON(choice.candidates) !== canonicalJSON(copyPool(s, catalog, d, choice.id)))
    throw new EngineError('invalid-copy-choice', 'Copy choices must retain their actual gate, coin result, source and eligible printed attacks.');
  choice.candidates.forEach((r) => copiedAttack(s, catalog, r));
}
function assertAttackExecution(s, catalog) {
  const frame = s.attack;
  const used = copyRecord(s, frame.id, 'used', 'attack.used');
  if (!used || used.turn !== s.turn || used.player !== frame.player ||
      canonicalJSON(used.source) !== canonicalJSON(frame.source))
    throw new EngineError('invalid-attack-frame', 'The execution must retain its original unique used-attack receipt.');
  const rootDef = cardDef(s, catalog, frame.sourceId), roots = [...(rootDef.mechanics.attacks ?? []), ...(rootDef.mechanics.grantedAttacks ?? [])];
  const granted = frame.source.grantId && frame.source.contentSource &&
    canonicalJSON(copiedAttack(s, catalog, frame.source.contentSource)) === canonicalJSON(frame.attack);
  if (!(granted || !frame.source.grantId && roots.some((a) => canonicalJSON(a) === canonicalJSON(frame.attack))) ||
      frame.source.attackId !== frame.attack.attackId ||
      frame.source.category !== 'attack' || frame.source.owner !== frame.player ||
      frame.source.effectId !== `attack:${frame.attack.attackId}` ||
      canonicalJSON(frame.source.sourceOfTruth) !== canonicalJSON(frame.attack.sourceOfTruth) ||
      frame.source.contentSource && !frame.source.grantId || frame.source.copyId ||
      frame.usedSpecialRules.some((r) => !s.players[frame.player][r === 'GX' ? 'gxUsed' : 'vstarUsed']) ||
      frame.attack.specialRule && !frame.usedSpecialRules.includes(frame.attack.specialRule))
    throw new EngineError('invalid-attack-frame', 'Declared attack must retain its approved original content and identity.');
  const executions = [...frame.copies.map((c) => c.execution), frame.execution];
  if (executions[0].reference !== null || new Set(executions.map((e) => e.copyId)).size !== executions.length)
    throw new EngineError('invalid-copy-stack', 'Copied executions form an explicit rooted stack, not duplicate or disconnected scopes.');
  for (const [i, execution] of executions.entries()) {
    const models = i === executions.length - 1 ? frame.damageModels : frame.copies[i].damageModels;
    const inDamageStage = s.queue.some((task) => task.op === 'resolve-attack' &&
      task.data.frameId === frame.id && task.data.copyId === execution.copyId);
    if ((models !== null) !== inDamageStage)
      throw new EngineError('invalid-damage-model', 'Only a live damage-stage continuation can retain its frozen models.');
    if (models !== null) {
      const receipts = s.events.filter((e) => e.ruleId === 'damage.expression' && e.data.kind === 'stage-snapshot' &&
        e.data.frameId === frame.id && e.data.copyId === execution.copyId);
      if (receipts.length !== 1 || receipts[0].visibility !== 'private' ||
          canonicalJSON(receipts[0].data.models) !== canonicalJSON(models))
        throw new EngineError('invalid-damage-model', 'Damage-stage models and numeric facts must retain their original private execution receipt.');
    }
    assertDamageCoins(s, catalog, execution, models);
    assertEffectCards(s, catalog, execution, models);
    const check = executingAttack(s, catalog, execution).failureCheck;
    if (execution.phase === 'failure-check') {
      if (i !== executions.length - 1 || !check?.handPayment || execution.failureReceipt !== null ||
          s.pending?.resume !== 'attack-payment' || s.pending.player !== frame.player)
        throw new EngineError('invalid-attack-payment', 'Only the active unpaid hand check can wait before the attack body.');
      const d = s.pending.data, spec = assertAttackPaymentChoice(s, catalog, d);
      const cards = commitmentCards(s, catalog, d.hand, frame.player), canPay = canPayAttackCommitment(cards, spec);
      if (s.pending.minimum !== 0 || s.pending.maximum !== (canPay ? spec.count : 0) || !s.pending.allowZero ||
          canonicalJSON(s.pending.options) !== canonicalJSON(canPay ? d.eligible : []))
        throw new EngineError('invalid-attack-payment', 'The payment choice must allow only complete payment or deliberate failure.');
    } else if (check?.handPayment) assertAttackPaymentReceipt(s, catalog, execution);
    else if (check?.predicate) {
      if (canonicalJSON(execution.failureReceipt) !== canonicalJSON({ kind: 'predicate', passed: true }))
        throw new EngineError('invalid-attack-failure', 'A running attack needs its passed printed failure condition.');
    } else assertFailureReceipt(check?.coin, execution.failureReceipt, true);
    if (!validSource(s, catalog, executingSource(s, catalog, execution)))
      throw new EngineError('invalid-copy-source', 'Copied content must retain its actual user and approved selection receipt.');
    if (i === 0) continue;
    const saved = frame.copies[i - 1], d = saved.continuation, selected = copyRecord(s, execution.copyId, 'selected');
    assertCopyChoice(s, catalog, d, false);
    if (d.copyChoice.id !== execution.copyId || (d.source.copyId ?? null) !== executions[i - 1].copyId ||
        !d.copyChoice.candidates.some((r) => canonicalJSON(r) === canonicalJSON(execution.reference)) ||
        selected?.parentCopyId !== executions[i - 1].copyId)
      throw new EngineError('invalid-copy-stack', 'A nested copy must resume its exact original caller, selection and declared attack.');
  }
}
function switchTo(s, player, pokemonId) { // Returns the Pokémon that came in.
  const p = s.players[player], i = p.bench.findIndex((m) => m.id === pokemonId);
  if (i < 0) throw new EngineError('invalid-target', 'The selected Pokémon is not on this Bench.');
  const incoming = p.bench.splice(i, 1)[0], old = p.active;
  if (old) { old.conditions = emptyConditions(); p.bench.push(old); }
  p.active = incoming; incoming.facts.movedActiveTurn = s.turn;
  battleFact(s, { kind: 'benchToActive', owner: player, pokemonId: incoming.id });
  // Attack-duration effects are tracked separately from turn facts.
  retainOngoing(s, (e) => !(e.targetId === old?.id && e.clearOnBench), 'bench');
  log(s, 'status.clear', { player, from: old?.id ?? null, to: incoming.id });
  return incoming;
}
// 「当这只宝可梦从备战区被放入战斗场时」: an actual Bench-to-Active move by Retreat or a switching effect (II.E-24),
// opened at once like the other in-play events.
function becameActiveWork(s, catalog, player, m, cause) {
  return triggerWork(s, catalog, [makeTriggerEvent(s, catalog, 'becameActive', player, m, { cause })]);
}
function expireAt(s, player, boundary) {
  for (const key of ['ongoing', 'playerOngoing']) {
    const remaining = expireOngoing(s[key], s, player, boundary);
    let historyIndex = null;
    if (key === 'ongoing' && s[key].some((e) => e.ownedAttackLockId && !remaining.includes(e))) {
      historyIndex = s.battleHistory.events.length;
      battleFact(s, { kind: 'turnEnded', owner: player });
    }
    for (const entry of s[key]) if (!remaining.includes(entry))
      log(s, entry.ruleId, { effectId: entry.id, expiredAt: boundary, player });
    if (key === 'ongoing') retainOngoing(s, (entry) => remaining.includes(entry), 'expiry', historyIndex);
    else s[key] = remaining;
  }
}

// 「对战中，己方的GX招式／【VSTAR】力量只能使用1次」: spent once the attack is actually used (after the
// confusion and imposed checks) or the Ability is used; a self-failure still counts as used (II.D-01).
function spendSpecialRule(s, catalog, player, specialRule) {
  if (!specialRule) return;
  requireRule(catalog.ruleset, 'attack.special-rule');
  s.players[player][specialRule === 'GX' ? 'gxUsed' : 'vstarUsed'] = true;
}
// Printed use conditions are facts of the current board and battle history,
// never inferred from a usage counter or from which cards are in a discard pile.
function abilityConditionMet(s, catalog, player, m, condition) {
  if (!condition) return true;
  requireRule(catalog.ruleset, 'ability.condition');
  if (condition.firstOwnTurn && s.players[player].turns !== 1) return false;
  if (condition.sourceActive && s.players[player].active !== m) return false;
  if (condition.previousOpponentKnockout) {
    requireRule(catalog.ruleset, BATTLE_HISTORY_RULES.previousOpponentKO.id);
    if (!hadKnockoutInPreviousOpponentTurn(s.battleHistory, { turn: s.turn, during: s.current }, { owner: player })) return false;
  }
  if (condition.attachedEnergyType && !sourceModel(s, catalog).pokemon[m.id].energies
    .some((e) => e.units.some((unit) => unit.includes(condition.attachedEnergyType)))) return false;
  return !condition.predicate || conditionPredicateMet(s, catalog, { owner: player, pokemonId: m.id }, condition.predicate);
}
// I.B-03 bars Supporters on the first player's first turn; printed 「即使是先攻玩家的最初回合也可以使用」 lifts it (II.E-27).
function firstTurnUse(catalog, def) {
  if (def.mechanics.firstTurnUse) requireRule(catalog.ruleset, 'trainer.first-turn-use');
  return !!def.mechanics.firstTurnUse;
}
// 「只有在……时才可使用」 (I.B-01/03 step 1): judged on the current board while the card is still in hand.
function trainerConditionMet(s, catalog, player, condition) {
  if (!condition) return true;
  requireRule(catalog.ruleset, 'trainer.condition');
  if (condition.prizesRemaining) {
    requireRule(catalog.ruleset, 'prizes.remaining');
    if (s.players[player].prizes.length <= s.players[1 - player].prizes.length) return false;
  }
  // 「只能在自己最初的回合使用」「只有在后攻玩家的最初回合才可使用」: each player's own first turn (I.A-05).
  if ((condition.firstOwnTurn || condition.secondPlayerFirstTurn) && s.players[player].turns !== 1) return false;
  if (condition.secondPlayerFirstTurn && s.first === player) return false;
  return !condition.predicate || conditionPredicateMet(s, catalog, { owner: player, pokemonId: null }, condition.predicate);
}
const activationRequest = (kind, player, sourceId, extra = {}) => ({
  kind, player, sourceId, pokemonId: null, abilityId: null, unit: null, entry: null, entryUnitId: null, ...extra,
});
function costsForUnit(s, catalog, unit) {
  if (unit.reaction) return [];
  const d = cardDef(s, catalog, unit.bindings[0].source.instanceId);
  return unit.abilityId ? d.mechanics.abilities.find((a) => a.abilityId === unit.abilityId).costs ?? [] :
    unit.bindings[0].binding.activationCosts ?? [];
}
function activationInfo(s, catalog, request) {
  if (!validateActivationRequest(request) || !s.cards[request.sourceId])
    throw new EngineError('invalid-activation', 'Invalid activation identity.');
  const { kind, player, sourceId } = request, p = s.players[player], def = cardDef(s, catalog, sourceId);
  let costs = [], work = [], physical = false, valid = true;
  const bindings = (items, category, pokemonId = null) => items.map((binding) => ({
    binding, source: sourceFor(s, catalog, sourceId, player, category, binding, pokemonId),
  }));
  if (kind === 'trainer') {
    valid = s.current === player && s.cards[sourceId].owner === player && p.hand.includes(sourceId) && def.kind === 'trainer';
    if (valid) {
      const category = def.mechanics.category, action = { item: 'playItem', supporter: 'playSupporter', tool: 'playTool', stadium: 'playStadium' }[category];
      valid = !playerProhibited(s, catalog, player, action) && trainerConditionMet(s, catalog, player, def.mechanics.condition) &&
        !(category === 'supporter' && (p.flags.supporter || s.turn === 1 && !firstTurnUse(catalog, def))) &&
        !(category === 'stadium' && (p.flags.stadium || s.stadium && cardDef(s, catalog, s.stadium).nameKey === def.nameKey)) &&
        !(category === 'tool' && mons(p).every((m) => m.tools.length));
      physical = ['tool', 'stadium'].includes(category); costs = def.mechanics.playCosts ?? [];
      work = bindings(def.mechanics.effects.filter((b) => !b.trigger && (catalog.handler(b.handlerId).timing ?? 'resolve') === 'resolve'), 'trainer');
    }
  } else if (kind === 'ability') {
    const found = findMon(s, request.pokemonId), a = def.mechanics.abilities?.find((a) => a.abilityId === request.abilityId && a.mode === 'activated');
    valid = s.current === player && found?.owner === player && top(found.m) === sourceId && !!a &&
      sourceModel(s, catalog).availability.get(sourceNodeId('ability', sourceId, a.abilityId)).enabled &&
      usageAllowed(s, player, found.m, a.usage) && !(a.specialRule === 'VSTAR' && p.vstarUsed) &&
      abilityConditionMet(s, catalog, player, found.m, a.condition);
    if (valid) { costs = a.costs ?? []; work = bindings(a.effects, 'ability', found.m.id); }
  } else if (kind === 'stadium') {
    valid = s.current === player && s.stadium === sourceId && !playerProhibited(s, catalog, player, 'useStadium');
    if (valid) {
      const items = def.mechanics.effects.filter((b) => catalog.handler(b.handlerId).timing === 'onUse');
      valid = items.length > 0 && items.every((b) => usageAllowed(s, player, p.active, handlerUsage(catalog, b)));
      costs = items.flatMap((b) => b.activationCosts ?? []); work = bindings(items, 'trainer');
    }
  } else if (kind === 'energy') {
    valid = s.current === player && def.kind === 'energy' && s.cards[sourceId].owner === player && p.hand.includes(sourceId) &&
      !p.flags.energy && findMon(s, request.pokemonId)?.owner === player;
    if (valid && def.mechanics.handAttachTo)
      valid = matchesInPlaySelector(monDef(s, catalog, findMon(s, request.pokemonId).m), def.mechanics.handAttachTo,
        sourceModel(s, catalog).pokemon[request.pokemonId].types);
    physical = true; costs = def.mechanics.attachCosts ?? [];
  } else if (kind === 'trigger') {
    const u = request.unit;
    valid = !!u && !u.reaction && u.controller === player && u.bindings[0].source.instanceId === sourceId;
    if (valid) {
      costs = costsForUnit(s, catalog, u);
      work = u.bindings.map((item) => ({ ...item, event: u.event, local: u.trigger.scope === 'subject' }));
    }
  } else {
    const entry = request.entry;
    const unit = entry && acquisitionUnits(s, catalog, entry).find((u) => u.id === request.entryUnitId);
    valid = !!unit && entry.player === player && entry.cardId === sourceId && p.resolving.includes(sourceId);
    if (valid) {
      costs = unit.costs;
      work = unit.bindings.map((binding) => ({ binding, entry,
        source: sourceFor(s, catalog, sourceId, player, unit.category, binding, null, null, entry.origin) }));
    }
  }
  if (costs.length) assertActivationCosts(costs);
  return { valid, physical, costs, work };
}
function paymentCards(s, catalog, request) {
  return s.players[request.player].hand.filter((id) => id !== request.sourceId)
    .map((instanceId) => ({ instanceId, definition: cardDef(s, catalog, instanceId) }));
}
function activationUsable(s, catalog, request) {
  const info = activationInfo(s, catalog, request);
  if (!info.valid) return false;
  if (info.costs.length && !findCostPayment(info.costs, paymentCards(s, catalog, request))) return false;
  return activationEffectsUsable(s, catalog, request, info, info.costs.length > 0);
}
// Candidate eligibility, use permission and actual execution are separate.
// I.A-02 p8 / I.B-01 p11 / I.B-03 p12 disallow a known wholly unchanged
// voluntary activation, not selecting a protected object during a valid one.
// This source-aware proof covers these native leaves, not arbitrary programs.
function nativeActivationQualifies(s, catalog, d, ctx, handlerId) {
  requireRule(catalog.ruleset, 'effects.activation-change');
  const p = d.binding.parameters, source = d.source;
  const owner = p.side === 'opponent' ? 1 - source.owner : source.owner;
  const qualifies = (pool) => {
    let uncertain = false;
    for (const m of pool) {
      const entries = protectionEntries(s, catalog, source, owner, m, 'effects');
      if (!entries.length) return true;
      const permissive = entries.filter((e) => e.spec.useRule === 'CN.E29');
      if (permissive.length) {
        requireRule(catalog.ruleset, 'effects.trainer-hand-use');
        if (permissive.length === entries.length) return true;
        uncertain = true; // Do not invent precedence for an unreviewed overlap.
      }
    }
    return uncertain ? null : false;
  };
  if (handlerId === 'cn.discardStadium@1') {
    if (!stadiumWindow(ctx, p).target) return false;
    const entries = stadiumProtections(s, catalog, source);
    if (!entries.length || entries.every((e) => e.spec.useRule === 'CN.E29')) return true;
    return entries.some((e) => e.spec.useRule === 'CN.E29') ? null : false;
  }
  if (handlerId === 'cn.discardTools@1')
    return qualifies([...new Set(toolCards(s, catalog, source, d.event ?? null, p).map((c) => c.m))]);
  if (handlerId === 'cn.distributeCounters@1')
    return p.count > 0 && qualifies(counterDistributionWindow(ctx, p).targets.map(({ pokemonId }) => findMon(s, pokemonId).m));
  if (handlerId === 'cn.healPokemon@1')
    return qualifies(healingWindow(ctx, p).targets.filter((t) => t.counters > 0).map(({ pokemonId }) => findMon(s, pokemonId).m));
  if (handlerId === 'cn.switch@1') {
    const player = s.players[owner];
    const model = p.selector || p.state ? sourceModel(s, catalog) : null;
    const bench = p.affected === 'source' ? player.bench.filter((m) => m.id === source.pokemonId) :
      player.bench.filter((m) => !model || pokemonMatches(s, catalog, model, m, p));
    return !!player.active && bench.length > 0 && qualifies(p.affected === 'active' ? [player.active] : bench);
  }
  return qualifies(targetedPokemon(s, owner, source, d.event ?? null, p.target)
    .filter((m) => handlerId !== 'cn.heal@1' || m.counters > 0));
}
function projectedPayment(s, catalog, request, groups) {
  const state = copyState(s), ids = groups.flatMap((g) => g.cardIds);
  for (const id of ids) { remove(state.players[request.player].hand, id); discard(state, catalog, id); }
  if (request.kind === 'trainer') {
    remove(state.players[request.player].hand, request.sourceId);
    state.players[request.player].resolving.push(request.sourceId);
  }
  return { state, payment: { id: `pay${s.serial + 1}`, player: request.player, sourceId: request.sourceId,
    kind: request.kind, groups: clone(groups) } };
}
function nativeActivationBody(s, catalog, request, info, payment) {
  const state = copyState(s), player = state.players[request.player];
  if (payment) {
    state.serial++;
    log(state, 'effects.activation-cost', { payment, source: clone(state.cards[request.sourceId]),
      sourceOfTruth: info.costs.flatMap((c) => c.sourceOfTruth) });
  }
  // A specific paid projection has already reserved a normal Trainer. Restore
  // its temporary position in this detached copy so the actual commit path can
  // reproduce flags, usage and the source's hand->resolving transition once.
  if (request.kind === 'trainer' && player.resolving.includes(request.sourceId)) {
    remove(player.resolving, request.sourceId); player.hand.push(request.sourceId);
  }
  commitActivation(state, catalog, request, payment, info);
  // The real drain settles attachment retention before the native effect leaf.
  // A type-changing fee may remove a shielding Energy; the proof must use that
  // same body state, without counting the prefix disposal as the body's result.
  enforceEnergyRetention(state, catalog);
  return state;
}
function nativeWorkQualifies(s, catalog, request, work, payment) {
  let uncertain = false;
  for (const d of work) {
    const result = nativeActivationQualifies(s, catalog, d,
      effectContext(s, catalog, d.source, d.event ?? null, false, null, false, d.entry ?? null, payment, request),
      catalog.handler(d.binding.handlerId).id);
    if (result === true) return true;
    uncertain ||= result === null;
  }
  if (uncertain) throw new EngineError('unresolved-protection-use-overlap',
    'Overlapping ordinary and CN.E29 prevention needs a reviewed CN use ruling, not a guessed precedence.',
    { ruleId: 'effects.trainer-hand-use' });
  return false;
}
function nativePaymentQualifies(s, catalog, request, info, native) {
  let undecided = null;
  const witness = findCostPaymentWitness(info.costs, paymentCards(s, catalog, request), (groups) => {
    const projected = projectedPayment(s, catalog, request, groups);
    const body = nativeActivationBody(projected.state, catalog, request, info, projected.payment);
    try { return nativeWorkQualifies(body, catalog, request, native, projected.payment); }
    catch (error) {
      if (error?.code !== 'unresolved-protection-use-overlap') throw error;
      undecided ??= error; return false; // Search another payment; not proof that this one is forbidden.
    }
  });
  if (witness) return true;
  if (undecided) throw undecided;
  return false;
}
function nativeCostInvariant(s, catalog) {
  // This asks about producer CODE, not their derived values. Collect even
  // currently disabled field bindings conservatively, without executing the
  // whole source model for every candidate action.
  const bindings = allMons(s).flatMap(({ m }) => {
    const d = monDef(s, catalog, m);
    return [...d.mechanics.effects, ...d.mechanics.abilities.flatMap((a) => a.effects),
      ...[...m.tools, ...m.energy].flatMap((id) => cardDef(s, catalog, id).mechanics.effects)];
  });
  if (s.stadium) bindings.push(...cardDef(s, catalog, s.stadium).mechanics.effects);
  return bindings.every((binding) => {
    const h = catalog.handler(binding.handlerId);
    if (!['continuous', 'suppression', 'pokemonTypes', 'energyProvision', 'attackGrant'].includes(h.timing)) return true;
    return constantFieldExecution(h);
  });
}
function activationEffectsUsable(s, catalog, request, info, withCosts, payment = null) {
  if (info.physical) return true;
  const native = ['trainer', 'ability'].includes(request.kind) ?
    info.work.filter((d) => {
      const h = catalog.handler(d.binding.handlerId);
      return NATIVE_CHANGE_HANDLERS.has(h.id) && canonicalNativeActivation(h);
    }) : [];
  let nativeBody = null, nativePaidProof, nativeProof, invariant;
  // Proof order is not execution order. A separate definite effect can
  // establish usability without searching an irrelevant costly native leaf.
  return [...info.work.filter((d) => !native.includes(d)), ...native].some((d) => {
    const h = catalog.handler(d.binding.handlerId);
    if (native.includes(d)) {
      if (withCosts) {
        const hint = h.canUseWithCosts(effectContext(s, catalog, d.source, null, false, null, false, null, null, request),
          d.binding.parameters, info.costs);
        if (typeof hint !== 'boolean')
          throw new EngineError('invalid-cost-check', 'Cost eligibility proofs must return a synchronous boolean.');
        // A local candidate hint cannot decide field dependencies. At least
        // one COMPLETE payment must satisfy subsequent use rules, including
        // an explicitly sourced CN.E29 permission despite actual prevention.
        invariant ??= nativeCostInvariant(s, catalog);
        nativePaidProof ??= invariant ? nativeWorkQualifies(s, catalog, request, native, null) :
          nativePaymentQualifies(s, catalog, request, info, native);
        return nativePaidProof;
      }
      invariant ??= nativeCostInvariant(s, catalog);
      nativeBody ??= invariant ? s : nativeActivationBody(s, catalog, request, info, payment);
      nativeProof ??= nativeWorkQualifies(nativeBody, catalog, request, native, payment);
      return nativeProof;
    }
    const ctx = factContext(s, catalog, h, effectContext(s, catalog, d.source, d.event ?? null, d.local ?? false, null, false,
      d.entry ?? null, payment, request), d.source, d.binding.parameters);
    const result = withCosts ? h.canUseWithCosts(ctx, d.binding.parameters, info.costs) :
      !h.canUse || h.canUse(ctx, d.binding.parameters);
    if (info.costs.length && typeof result !== 'boolean')
      throw new EngineError('invalid-cost-check', 'Cost eligibility proofs must return a synchronous boolean.');
    // A different independent binding (e.g. drawing) can still qualify the
    // whole activation. Never count playing/discarding the Trainer or its fee
    // as successful execution of the protected body.
    return result;
  });
}
function beginActivation(s, catalog, request) {
  const info = activationInfo(s, catalog, request);
  if (!activationUsable(s, catalog, request)) throw new EngineError('illegal-activation', 'The activation cannot pay its costs or use its following effects.');
  if (!info.costs.length) { commitActivation(s, catalog, request, null, info); return; }
  const options = costOptions(s, catalog, request, info.costs);
  const count = costCardCount(info.costs);
  ask(s, { player: request.player, kind: 'activation-cost', options, minimum: count, maximum: count,
    resume: 'activation-choice', data: { activation: request }, ruleId: 'effects.activation-cost' });
}
function costOptions(s, catalog, request, costs) {
  const pool = paymentCards(s, catalog, request);
  return costs.flatMap((cost) => pool.filter((c) => matchesCardSelector(c.definition, cost.selector))
    .map((c) => paymentOptionId(cost.costId, c.instanceId)));
}
function payActivation(s, catalog, request, selected) {
  const info = activationInfo(s, catalog, request), groups = readCostPayment(info.costs, paymentCards(s, catalog, request), selected);
  if (!info.valid || !groups) throw new EngineError('invalid-cost-payment', 'All cost groups must be paid exactly, with no card paid twice.');
  const { state: projected, payment } = projectedPayment(s, catalog, request, groups), ids = groups.flatMap((g) => g.cardIds);
  if (!activationEffectsUsable(projected, catalog, request, info, false, payment))
    throw new EngineError('invalid-cost-payment', 'This payment leaves no usable subsequent effect.');
  for (const id of ids) { remove(s.players[request.player].hand, id); discard(s, catalog, id); }
  s.serial++;
  log(s, 'effects.activation-cost', { payment, source: clone(s.cards[request.sourceId]), sourceOfTruth: info.costs.flatMap((c) => c.sourceOfTruth) });
  commitActivation(s, catalog, request, payment, info);
}
// II.E-20 文例3: 「如果使用了，则自己的回合结束」 ends the turn once the card or Ability has resolved.
function endTurnWork(catalog, printed, player) {
  if (!printed.endsTurn) return [];
  requireRule(catalog.ruleset, 'effects.end-turn');
  return [tasks('ko'), tasks('end-turn', { player })];
}
function commitActivation(s, catalog, request, payment, info) {
  const { player, sourceId, kind } = request, p = s.players[player], def = cardDef(s, catalog, sourceId);
  if (kind === 'trainer') {
    const category = def.mechanics.category;
    remove(p.hand, sourceId); p.resolving.push(sourceId); s.phase = 'resolving';
    if (category === 'supporter') {
      p.flags.supporter = true;
      battleFact(s, { kind: 'supporterPlayed', owner: player, cardId: sourceId, origin: 'hand' });
    }
    if (category === 'stadium') p.flags.stadium = true;
    if (category === 'tool') prepend(s, tasks('attach-tool', { player, cardId: sourceId }));
    else if (category === 'stadium') {
      const leaving = s.stadium;
      remove(p.resolving, sourceId); if (leaving) discard(s, catalog, leaving); s.stadium = sourceId;
      log(s, 'turn.stadium', { player, cardId: sourceId }); s.phase = 'main';
      // The discarded Stadium's holder settles a lowered Bench limit first.
      prepend(s, ...(leaving ? [tasks('bench-trim', { order: [s.cards[leaving].owner, 1 - s.cards[leaving].owner] })] : []), tasks('ko'));
    } else {
      const completionId = `trainer${++s.serial}`;
      log(s, 'turn.trainer', { kind: 'trainer-open', id: completionId, player, cardId: sourceId, turn: s.turn });
      prepend(s, ...effectTasks(s, catalog, sourceId, player, 'trainer', def.mechanics.effects, 'resolve', null, null, payment),
        tasks('finish-trainer', { player, cardId: sourceId, completionId }), ...endTurnWork(catalog, def.mechanics, player));
    }
  } else if (kind === 'energy') {
    const { m } = findMon(s, request.pokemonId);
    remove(p.hand, sourceId); m.energy.push(sourceId); p.flags.energy = true;
    enforceEnergyRetention(s, catalog);
    log(s, 'turn.energy', { player, cardId: sourceId, pokemonId: m.id });
    prepend(s, ...triggerWork(s, catalog, [makeTriggerEvent(s, catalog, 'energyAttached', player, m, { origin: 'hand', cardId: sourceId, payment })]), tasks('ko'));
  } else if (kind === 'ability') {
    const { m } = findMon(s, request.pokemonId), a = def.mechanics.abilities.find((a) => a.abilityId === request.abilityId);
    recordUsage(s, player, m, a.usage); spendSpecialRule(s, catalog, player, a.specialRule);
    log(s, 'ability.usage', { player, pokemonId: m.id, abilityId: a.abilityId });
    prepend(s, ...effectTasks(s, catalog, sourceId, player, 'ability', a.effects, 'resolve', m.id, null, payment), tasks('ko'),
      ...endTurnWork(catalog, a, player));
  } else if (kind === 'stadium') {
    const uses = stadiumUsages(catalog, info.work.map((d) => d.binding));
    for (const usage of uses.values()) recordUsage(s, player, p.active, usage);
    prepend(s, ...effectTasks(s, catalog, sourceId, player, 'trainer', def.mechanics.effects, 'onUse', null, null, payment), tasks('ko'));
  } else if (kind === 'entry') {
    const entry = request.entry, unit = acquisitionUnits(s, catalog, entry).find((u) => u.id === request.entryUnitId);
    if (unit.trigger.afterUse === 'discard') s.queue.find((t) => t.op === 'entry-finish' && t.data.entry.id === entry.id).data.discard = true;
    log(s, 'trigger.before-hand', { entryId: entry.id, performed: true, abilityId: unit.abilityId,
      revealed: clone(s.cards[entry.cardId]), origin: entry.origin, reason: entry.reason });
    prepend(s, ...info.work.map((d) => tasks('effect', scheduleTrackedEffect(s, catalog, { ...d, payment }))));
  } else {
    const u = request.unit, source = u.bindings[0].source, mon = findMon(s, source.pokemonId)?.m;
    recordUsage(s, source.owner, mon, u.usage); spendSpecialRule(s, catalog, source.owner, u.specialRule);
    log(s, triggerRuleId(u.event.kind), { triggerId: u.id, sourceId, subjectId: u.event.subjectId,
      owner: u.owner, controller: u.controller, abilityId: u.abilityId, performed: true });
    prepend(s, ...info.work.map((d) => tasks('effect', scheduleTrackedEffect(s, catalog, { ...d, payment }))));
  }
}
function assertPayment(s, catalog, payment, source = null) {
  if (!validatePaymentReceipt(payment) || source && payment.sourceId !== source.instanceId)
    throw new EngineError('invalid-payment-receipt', 'Payment receipt does not match its activation source.');
  if (payment.kind !== 'trigger' && source && payment.player !== source.owner ||
      ['trainer', 'ability', 'energy', 'entry'].includes(payment.kind) && s.cards[payment.sourceId]?.owner !== payment.player)
    throw new EngineError('invalid-payment-receipt', 'A payment must retain its actual activator, independently of the Stadium card holder.');
  const record = s.events.find((e) => e.ruleId === 'effects.activation-cost' && e.data.payment?.id === payment.id);
  if (!record || canonicalJSON(record.data.payment) !== canonicalJSON(payment))
    throw new EngineError('invalid-payment-receipt', 'Payment must retain the committed, journaled receipt.');
  const d = cardDef(s, catalog, payment.sourceId);
  let costs;
  if (payment.kind === 'trainer') costs = d.mechanics.playCosts;
  else if (payment.kind === 'energy') costs = d.mechanics.attachCosts;
  else if (payment.kind === 'stadium') costs = d.mechanics.effects.filter((b) => catalog.handler(b.handlerId).timing === 'onUse')
    .flatMap((b) => b.activationCosts ?? []);
  else {
    const candidates = [
      ...(d.mechanics.abilities ?? []).map((a) => ({ effects: a.effects, costs: a.costs })),
      ...d.mechanics.effects.map((b) => ({ effects: [b], costs: b.activationCosts })),
    ];
    costs = candidates.find((c) => c.effects.some((b) => b.effectId === source?.effectId))?.costs;
  }
  if (!costs || payment.groups.length !== costs.length)
    throw new EngineError('invalid-payment-receipt', 'Receipt costs must match the original approved declaration.');
  const ids = payment.groups.flatMap((g) => g.cardIds), pool = ids.map((instanceId) => ({
    instanceId, definition: cardDef(s, catalog, instanceId),
  }));
  if (ids.some((id) => s.cards[id]?.owner !== payment.player) ||
      !readCostPayment(costs, pool, payment.groups.flatMap((g) => g.cardIds.map((id) => paymentOptionId(g.costId, id)))))
    throw new EngineError('invalid-payment-receipt', 'Receipt cannot change exact groups, printed predicates or card ownership.');
}

/** Validate full private snapshots, including card conservation; not a network signature. */
export function assertGameState(s, catalog) {
  assertCatalog(catalog);
  assertJSON(s);
  if (!validateGameState(s)) throw new EngineError('invalid-state', 'Snapshot schema mismatch.', { errors: validateGameState.errors });
  if (s.catalogId !== catalog.id || `${s.ruleset.region}/${s.ruleset.version}` !== catalog.ruleset.id)
    throw new EngineError('incompatible-state', 'Snapshot catalog or rules version does not match.');
  if (catalog.ruleset.id !== 'CN/V20261019') throw new EngineError('incompatible-state', 'This kernel implements CN/V20261019 only.');
  assertBattleHistory(s.battleHistory, { turn: s.turn, during: s.current });
  if (s.players.some((p, owner) => p.turns !== s.battleHistory.turns.filter((t) => t.player === owner).length) ||
      s.turn > 0 && s.first !== s.battleHistory.turns[0].player)
    throw new EngineError('invalid-history-clock', 'Actual turn history must agree with first player and both players’ real turn counts.');
  const format = assertMatchFormat(catalog, s.format, s.matchMode);
  validateRandomState(s.rng);
  new Set(Object.values(s.cards).map((c) => c.definitionId)).forEach((id) => assertSupportedDefinition(catalog, catalog.definition(id)));
  const seen = new Set(), monIds = new Set(), owned = [0, 0];
  const card = (id) => {
    if (seen.has(id) || !s.cards[id] || s.cards[id].instanceId !== id) throw new EngineError('card-conservation', 'Duplicate or missing card.');
    seen.add(id);
    const c = s.cards[id], d = catalog.definitionFor(c.printingId);
    if (d.definitionId !== c.definitionId) throw new EngineError('invalid-card', 'Card/printing binding changed.');
    owned[c.owner]++;
  };
  s.players.forEach((p, owner) => {
    const ownCard = (id) => {
      card(id);
      if (s.cards[id].owner !== owner) throw new EngineError('wrong-owner', 'Cards must use their owner’s zones.');
    };
    for (const zone of ['deck', 'hand', 'prizes', 'discard', 'lost', 'resolving']) p[zone].forEach(ownCard);
    if (p.discard.some((id) => cardDef(s, catalog, id).prismStar))
      throw new EngineError('invalid-discard-destination', 'A Prism Star card cannot remain in the discard pile instead of its owner’s Lost Zone.');
    for (const m of mons(p)) {
      if (monIds.has(m.id)) throw new EngineError('invalid-pokemon', 'Duplicate Pokémon identity.');
      monIds.add(m.id); validateConditions(m.conditions);
      if (m !== p.active && (m.conditions.rotation !== null || m.conditions.poison !== null || m.conditions.burned))
        throw new EngineError('invalid-conditions', 'Benched Pokémon cannot retain Special Conditions.');
      if (m.enteredTurn > s.turn || m.evolvedTurn > s.turn || m.facts.healedTurn > s.turn ||
          m.facts.movedActiveTurn > s.turn || m.facts.lastUsedAttack?.turn > s.turn)
        throw new EngineError('invalid-time', 'Future Pokémon history.');
      // A recorded 「令这只宝可梦昏厥」 only waits for the rest of its own effect (I.D).
      if (m.facts.forcedKnockout && (!s.pending || !knockoutAllowed(s, catalog, owner, m, m.facts.forcedKnockout)))
        throw new EngineError('invalid-knockout', 'A pending Knock Out must come from a printed Knock Out of an unfinished effect that allows this Pokémon.');
      if (m.facts.evolution) {
        const e = m.facts.evolution;
        if (e.turn !== m.evolvedTurn || e.turn > s.turn || e.fromCardId === e.toCardId ||
            [e.fromCardId, e.toCardId].some((id) => s.cards[id]?.owner !== owner || cardDef(s, catalog, id).kind !== 'pokemon'))
          throw new EngineError('invalid-evolution-history', 'Evolution facts must retain real, distinct owned Pokémon cards and their actual turn.');
      }
      m.stack.forEach((id) => {
        ownCard(id);
        if (cardDef(s, catalog, id).kind !== 'pokemon') throw new EngineError('invalid-pokemon', 'Evolution stacks contain Pokémon cards.');
      });
      m.energy.forEach((id) => {
        ownCard(id);
        if (cardDef(s, catalog, id).kind !== 'energy') throw new EngineError('invalid-energy', 'Attached Energy must be an Energy card.');
      });
      m.tools.forEach((id) => {
        ownCard(id);
        if (cardDef(s, catalog, id).mechanics.category !== 'tool') throw new EngineError('invalid-tool', 'Attached Tool must be a Tool.');
      });
    }
  });
  if (s.stadium !== null) {
    card(s.stadium);
    if (cardDef(s, catalog, s.stadium).mechanics.category !== 'stadium') throw new EngineError('invalid-stadium', 'Invalid Stadium.');
  }
  if (seen.size !== Object.keys(s.cards).length || owned.some((n) => n !== 60))
    throw new EngineError('card-conservation', 'Every original card must exist in exactly one location.');
  for (const event of s.battleHistory.events) {
    if (event.kind === 'supporterPlayed') {
      const card = s.cards[event.cardId], d = card && cardDef(s, catalog, event.cardId);
      if (!card || card.owner !== event.owner || d.kind !== 'trainer' || d.mechanics.category !== 'supporter')
        throw new EngineError('invalid-history-source', 'A played Supporter fact must retain an actual owned Supporter card.');
    } else if (findMon(s, event.pokemonId)?.owner !== undefined && findMon(s, event.pokemonId).owner !== event.owner)
      throw new EngineError('invalid-history-source', 'A live history subject cannot change its holder.');
    if (event.kind === 'fieldTransition' && [event.fromCardId, event.toCardId].some((id) =>
      s.cards[id]?.owner !== event.owner || cardDef(s, catalog, id).kind !== 'pokemon'))
      throw new EngineError('invalid-history-source', 'Actual evolution/devolution facts need two real Pokemon cards held by the affected player.');
    if (event.kind === 'ko') {
      if (monIds.has(event.pokemonId))
        throw new EngineError('invalid-history-source', 'A Knocked Out Pokémon identity cannot reappear as a live Pokémon.');
      if (event.cause.source && !validHistorySource(s, catalog, event.cause.source))
        throw new EngineError('invalid-history-source', 'Historical Knock Outs must retain their approved actual source and copy/grant receipts.');
      const receipts = s.events.filter((e) => e.ruleId === 'ko.boundary' && e.data.kind === 'latched' && e.data.item?.id === event.pokemonId);
      if (receipts.length !== 1 || canonicalJSON(knockoutFact(receipts[0].data.item)) !== canonicalJSON(event))
        throw new EngineError('invalid-ko-history', 'Historical Knock Outs must match their original locked causal receipt.');
    }
  }
  // Pool admission applies to every original physical card, regardless of its
  // current zone. Restoring a snapshot must not bypass initial deck legality.
  if (format) for (const owner of [0, 1]) validateFormatDeck(catalog,
    Object.values(s.cards).filter((c) => c.owner === owner).map((c) => c.printingId), s.format, s.matchMode);
  for (const event of s.events) {
    requireRule(catalog.ruleset, event.ruleId);
    if (event.ruleId === 'effects.search' && event.data.kind === 'requested' && event.visibility !== 'private')
      throw new EngineError('invalid-deck-choice', 'Original deck-order receipts are host-only, including after an operation finishes.');
    if (event.ruleId === 'damage.expression' && event.data.kind === 'stage-snapshot' && event.visibility !== 'private')
      throw new EngineError('invalid-damage-model', 'Original damage-stage snapshots remain host-only after resolution.');
    if (event.ruleId === 'damage.coins' && event.data.kind === 'prepared' && event.visibility !== 'private')
      throw new EngineError('invalid-damage-coins', 'Private coin-preparation receipts cannot become player-visible history.');
    if (event.ruleId === 'effects.prize-exchange' &&
        (!validatePrizeExchangeEvent(event) || event.data.kind === 'finished' && !prizeSummaryMatches(s, event)))
      throw new EngineError('invalid-prize-exchange', 'Prize history needs exact private receipt shapes and only its authorized public summary.');
  }
  const effectIds = new Set();
  for (const entry of s.ongoing) {
    assertOngoingEffect(entry, s);
    if (effectIds.has(entry.id) || !monIds.has(entry.targetId) || !validSource(s, catalog, entry.source))
      throw new EngineError('invalid-ongoing', 'Ongoing effects need unique identities, a live target and a valid source.');
    effectIds.add(entry.id);
    if (entry.effect.op === 'reaction') assertEffectProgram(entry.effect.program, REACTION_OPERATIONS);
  }
  for (const entry of s.playerOngoing) {
    assertPlayerOngoingEffect(entry, s);
    if (effectIds.has(entry.id) || !validSource(s, catalog, entry.source))
      throw new EngineError('invalid-player-effect', 'Player effects need a unique identity and their actual original source.');
    effectIds.add(entry.id);
  }
  for (const [player, entry] of s.vacancies.entries()) if (entry &&
      (s.players[player].active !== null || !validSource(s, catalog, entry.source)))
    throw new EngineError('invalid-promotion', 'Non-KO vacancy must retain its real departed source and an empty Active position.');
  for (const { owner, m } of allMons(s)) hp(s, catalog, owner, m);
  if (s.attack && (s.phase !== 'resolving' || s.attack.player !== s.current ||
      s.attack.pokemonId !== s.attack.source.pokemonId || s.attack.sourceId !== s.attack.source.instanceId ||
      s.cards[s.attack.sourceId]?.owner !== s.attack.player))
    throw new EngineError('invalid-attack-frame', 'Corrupt declared-attack continuation.');
  if (s.attack) {
    assertAttackExecution(s, catalog);
    for (const event of s.attack.events) assertEventTypeReceipt(s, event);
  }
  if (s.pending) {
    requireRule(catalog.ruleset, s.pending.ruleId);
    if (!CHOICE_RESUMES.has(s.pending.resume) || s.pending.maximum > s.pending.options.length || s.pending.minimum > s.pending.maximum)
      throw new EngineError('invalid-prompt', 'Corrupt pending selection bounds.');
  }
  const finalizers = new Map();
  for (const task of s.queue) if (task.op === 'entry-finish') {
    if (finalizers.has(task.data.entry.id)) throw new EngineError('invalid-acquisition', 'Duplicate receipt finalizer.');
    finalizers.set(task.data.entry.id, task.data.entry);
  }
  const trainerFinalizers = new Map(), completionIds = new Set();
  for (const task of s.queue) if (task.op === 'finish-trainer') {
    const d = task.data;
    if (trainerFinalizers.has(d.cardId) || completionIds.has(d.completionId))
      throw new EngineError('invalid-trainer-finish', 'Each current Trainer use needs exactly one finalizer and a unique completion identity.');
    trainerFinalizers.set(d.cardId, d); completionIds.add(d.completionId);
  }
  for (const [taskIndex, task] of [...s.queue, ...(s.pending ? [{ op: s.pending.resume, data: s.pending.data }] : [])].entries()) {
    if (['ko', 'ko-discard'].includes(task.op) && task.data.batch) {
      if (new Set(task.data.batch.map((item) => item.id)).size !== task.data.batch.length)
        throw new EngineError('invalid-ko-history', 'A Knock Out batch cannot duplicate a Pokémon.');
      if (s.queue.slice(0, taskIndex).some((t) => ['start-turn', 'checkup'].includes(t.op)))
        throw new EngineError('invalid-ko-history', 'Latched Knock Outs must commit before any queued turn/checkup boundary.');
      for (const item of task.data.batch) {
        const m = findMon(s, item.id), card = s.cards[item.topCardId];
        if (!m || m.owner !== item.owner || !card || card.owner !== item.owner ||
            cardDef(s, catalog, item.topCardId).mechanics.prizeCount !== item.prizes ||
            item.turn !== s.turn || item.during !== s.current ||
            canonicalJSON(copyRecord(s, item.receiptId, 'latched', 'ko.boundary')?.item) !== canonicalJSON(item) ||
            item.cause.source && !validHistorySource(s, catalog, item.cause.source))
          throw new EngineError('invalid-ko-history', 'Pending Knock Outs must retain their original target, source, Prize count, boundary and locked receipt.');
        normalizeKnockoutEvent(knockoutFact(item));
      }
    }
    const validator = { 'effect-choice': validateEffectResolution, 'trigger-window': validateTriggerWindow,
      'trigger-execute': validateTriggerActivation, 'checkup-plan': validateCheckupPlan,
      'entry-window': validateEntryWindow, 'entry-use': validateEntryUse, 'entry-finish': validateEntryFinish,
      'draw-cards': validateDrawTask, 'activation-choice': validateActivationChoice, 'promote': validatePromotionChoice,
      'attack-payment': validateAttackPaymentChoice }[task.op];
    if (validator && !validator(task.data))
      throw new EngineError('invalid-effect-continuation', 'Corrupt effect/trigger resolution.', { errors: validator.errors });
    if (task.data.event) assertEventTypeReceipt(s, task.data.event);
    if (task.op === 'draw-cards' && task.data.completion?.event) assertEventTypeReceipt(s, task.data.completion.event);
    if (task.op === 'draw-cards') {
      const d = task.data, count = BigInt(d.remaining) + BigInt(d.drawn);
      if (d.reason === 'turnStart' ?
        d.completion !== null || d.source !== null || count !== 1n || d.player !== s.current :
        !d.completion || d.completion.action.op !== 'draw' ||
          count !== BigInt(d.completion.action.count) ||
          d.player !== (d.completion.action.player ?? d.completion.source.owner) ||
          canonicalJSON(d.source) !== canonicalJSON(d.completion.source))
        throw new EngineError('invalid-draw-task', 'A suspended draw must retain its original instruction, recipient, source and complete count budget.');
    }
    if (['after-attack', 'resolve-attack', 'finish-attack', 'finish-copy'].includes(task.op) &&
        (!s.attack || task.data.frameId !== s.attack.id || task.data.player !== s.attack.player ||
          ![s.attack.execution, ...s.attack.copies.map((c) => c.execution)].some((e) => e.copyId === task.data.copyId && e.phase === 'body') ||
          ['after-attack', 'resolve-attack'].includes(task.op) &&
            (task.data.pokemonId !== s.attack.pokemonId || task.data.sourceId !== s.attack.sourceId)))
      throw new EngineError('invalid-attack-flow', 'Queued attack work must retain its real actor and active/suspended execution scope.');
    if (task.op === 'attack-payment') {
      if (!s.attack || s.attack.execution.phase !== 'failure-check' || taskIndex !== s.queue.length ||
          s.pending?.resume !== 'attack-payment' || Object.hasOwn(task.data, 'selected'))
        throw new EngineError('invalid-attack-payment', 'Only the current unpaid owner choice may resume a self-failure payment.');
      assertAttackPaymentChoice(s, catalog, task.data);
    }
    if (task.op === 'promote' && (s.players[task.data.player].active !== null ||
        Boolean(s.vacancies[task.data.player]) !== (task.data.reason === 'fieldReturn') ||
        s.pending?.resume === 'promote' && taskIndex === s.queue.length &&
          (s.pending.player !== task.data.player || s.pending.minimum !== 1 || s.pending.maximum !== 1 || s.pending.allowZero ||
            canonicalJSON(s.pending.options) !== canonicalJSON(s.players[task.data.player].bench.map((m) => m.id)))))
      throw new EngineError('invalid-promotion', 'Promotion must retain its holder, vacancy kind and exact eligible Bench choices.');
    if (task.op === 'promote' && task.data.reason === 'fieldReturn' &&
        (!validSource(s, catalog, task.data.source) ||
          canonicalJSON(s.vacancies[task.data.player]) !== canonicalJSON({ source: task.data.source, promotion: task.data.promotion })))
      throw new EngineError('invalid-promotion', 'Return promotion must retain the exact vacancy source and reviewed schedule.');
    if (['effect', 'effect-choice'].includes(task.op) && (!task.data.source || !validSource(s, catalog, task.data.source)))
      throw new EngineError('invalid-effect-source', 'An effect must retain its original card and actual holder.');
    if (['effect', 'effect-choice'].includes(task.op) && task.data.entry &&
        (task.data.source.instanceId !== task.data.entry.cardId || task.data.source.owner !== task.data.entry.player ||
          task.data.source.origin !== task.data.entry.origin))
      throw new EngineError('invalid-effect-source', 'An incoming effect must retain the acquired card and its real non-hand origin.');
    const trainerSource = ['effect', 'effect-choice'].includes(task.op) ? task.data.source :
      task.op === 'draw-cards' ? task.data.completion?.source : null;
    if (trainerSource?.category === 'trainer' && trainerSource.origin === 'hand' &&
        ['item', 'supporter'].includes(cardDef(s, catalog, trainerSource.instanceId).mechanics.category) &&
        trainerFinalizers.get(trainerSource.instanceId)?.player !== trainerSource.owner)
      throw new EngineError('invalid-trainer-finish', 'Normal hand-played Trainer work cannot lose its own outstanding resolution finalizer.');
    if (task.data.payment) assertPayment(s, catalog, task.data.payment, task.data.source);
    if (task.op === 'draw-cards' && task.data.completion?.payment)
      assertPayment(s, catalog, task.data.completion.payment, task.data.completion.source);
    if (task.op === 'activation-choice') {
      const info = activationInfo(s, catalog, task.data.activation);
      if (!info.valid || !info.costs.length) throw new EngineError('invalid-activation', 'A pending payment needs its actual unpaid activation.');
      if (task.data.activation.unit) {
        assertTriggerUnitState(s, catalog, task.data.activation.unit);
        if (task.data.activation.unit.event.payment) assertPayment(s, catalog, task.data.activation.unit.event.payment);
      }
      if (s.pending?.resume === 'activation-choice' && taskIndex === s.queue.length &&
          (s.pending.player !== task.data.activation.player || s.pending.minimum !== costCardCount(info.costs) ||
            s.pending.maximum !== costCardCount(info.costs) || s.pending.allowZero ||
            canonicalJSON(s.pending.options) !== canonicalJSON(costOptions(s, catalog, task.data.activation, info.costs))))
        throw new EngineError('invalid-activation', 'Pending fee choices must retain their real payer, exact counts and eligible card groups.');
    }
    const entry = task.data.entry ?? task.data.activation?.entry ?? (task.op === 'draw-cards' ? task.data.completion?.entry : null);
    if (entry) {
      if (!validateEntryContext(entry) || entry.turn !== s.turn || entry.during !== s.current ||
          s.cards[entry.cardId]?.owner !== entry.player ||
          canonicalJSON(finalizers.get(entry.id)) !== canonicalJSON(entry) ||
          entry.cause && !validSource(s, catalog, entry.cause))
        throw new EngineError('invalid-acquisition', 'Receipt must retain its actual card, holder, cause and immediate finalizer.');
      const unitIds = acquisitionUnits(s, catalog, entry).map((u) => u.id);
      if (task.op === 'entry-window' && task.data.remaining.some((id) => !unitIds.includes(id)) ||
          task.op === 'entry-use' && !unitIds.includes(task.data.unitId))
        throw new EngineError('invalid-acquisition', 'Receipt bindings must match the independently approved original card.');
    }
    if (task.op === 'effect-choice' && task.data.action.op === 'cards') {
      const d = task.data;
      if (['cards-select', 'cards-empty'].includes(d.stage) &&
          canonicalJSON(d.lookedAt) !== canonicalJSON(cardWindow(s, d.action, d.source)))
        throw new EngineError('invalid-card-selection', 'The inspected card window no longer matches its source zone.');
      if (d.stage === 'cards-move' && (d.index > d.chosen.length || d.chosen.slice(d.index).some((id) =>
        !s.players[d.source.owner].resolving.includes(id))))
        throw new EngineError('invalid-card-selection', 'Reserved selected cards must remain in their resolution zone.');
    }
    if (task.op === 'effect-choice' && task.data.action.op === 'arrangeDeck' && task.data.lookedAt &&
        canonicalJSON(task.data.lookedAt) !== canonicalJSON(arrangeWindow(s, task.data.action, task.data.deckOwner)))
      throw new EngineError('invalid-card-selection', 'The looked-at deck cards no longer match that end of the deck.');
    if (task.op === 'effect-choice' && task.data.action.op === 'opponentHand' && task.data.stage &&
        canonicalJSON(task.data.lookedAt) !== canonicalJSON(s.players[1 - task.data.source.owner].hand))
      throw new EngineError('invalid-card-selection', 'The looked-at opponent\'s hand no longer matches that hand.');
    if (task.op === 'effect-choice' && task.data.action.op === 'transferCounters' &&
        task.data.stage === 'transfer-target' && task.data.removed > task.data.action.count)
      throw new EngineError('invalid-counter-transfer', 'A saved transfer cannot place more counters than its immutable instruction allowed.');
    if (task.op === 'effect-choice' && task.data.stage === 'transfer-count' &&
        !mons(s.players[task.data.source.owner]).some((m) => m.id === task.data.originId && m.counters > 1))
      throw new EngineError('invalid-counter-transfer', 'A saved transfer count needs its actual origin with counters to choose from.');
    if (task.op === 'effect-choice' && deckOperation(task.data.action)) {
      if (task.data.deckChoice && (taskIndex !== s.queue.length || s.pending?.resume !== 'effect-choice'))
        throw new EngineError('invalid-deck-choice', 'Started private deck work must be the current owner prompt, not replayed queued work.');
      assertDeckChoice(s, catalog, task.data, taskIndex === s.queue.length ? s.pending : null);
    }
    if (task.op === 'effect-choice' && task.data.action.op === 'exchangePrizes') {
      if (task.data.prizeChoice && (taskIndex !== s.queue.length || s.pending?.resume !== 'effect-choice'))
        throw new EngineError('invalid-prize-exchange', 'Started Prize inspection must be the active user choice, not duplicated queued work.');
      assertPrizeChoice(s, catalog, task.data, taskIndex === s.queue.length ? s.pending : null);
    }
    if (task.op === 'effect-choice' && task.data.action.op === 'healPokemon') {
      if (task.data.healingChoice && (taskIndex !== s.queue.length || s.pending?.resume !== 'effect-choice'))
        throw new EngineError('invalid-healing-choice', 'Started healing selection must be the current prompt, not replayed queued work.');
      assertHealingChoice(s, catalog, task.data, taskIndex === s.queue.length ? s.pending : null);
    }
    if (task.op === 'effect-choice' && task.data.action.op === 'distributeCounters') {
      if (task.data.counterChoice && (taskIndex !== s.queue.length || s.pending?.resume !== 'effect-choice'))
        throw new EngineError('invalid-counter-choice', 'A started allocation must remain its active prompt, not duplicated queued work.');
      assertCounterChoice(s, catalog, task.data, taskIndex === s.queue.length ? s.pending : null);
    }
    if (task.op === 'effect-choice' && task.data.action.op === 'disableOwnedAttack') {
      if (task.data.ownedAttackChoice && (taskIndex !== s.queue.length || s.pending?.resume !== 'effect-choice'))
        ownedAttackFailure('A started owned-attack choice must remain the active prompt, not duplicated queued work.');
      assertOwnedAttackChoice(s, catalog, task.data, taskIndex === s.queue.length ? s.pending : null);
    }
    if (task.op === 'finish-trainer') assertTrainerFinish(s, catalog, task.data);
    if (task.op === 'effect-choice' && task.data.energyPlan) assertEnergyPlan(s, catalog, task.data);
    if (task.op === 'effect-choice' && (task.data.transition || task.data.devolutionPlan)) assertPokemonTransition(s, catalog, task.data);
    if (task.op === 'effect-choice' && task.data.copyChoice) {
      if (!s.attack || task.data.source.category !== 'attack' || (task.data.source.copyId ?? null) !== s.attack.execution.copyId)
        throw new EngineError('invalid-copy-choice', 'A pending copy needs its actual currently executing attack.');
      assertCopyChoice(s, catalog, task.data);
    }
    if (task.op === 'trigger-window' && new Set(task.data.units.map((u) => u.id)).size !== task.data.units.length)
      throw new EngineError('invalid-trigger-window', 'Duplicate pending trigger identities.');
    const units = task.op === 'trigger-window' ? task.data.units : task.op === 'trigger-execute' ? [task.data.unit] :
      task.op === 'checkup-plan' ? [...task.data.units, ...task.data.before, ...task.data.after] : [];
    for (const unit of units) assertTriggerUnitState(s, catalog, unit);
    for (const unit of units) if (unit.event.payment) assertPayment(s, catalog, unit.event.payment);
  }
  assertExecutionWork(s, catalog);
  assertOwnedAttackHistory(s, catalog);
  assertSelectionRequests(s);
  if (!s.result && !s.pending && (s.phase !== 'main' || s.queue.length))
    throw new EngineError('incomplete-continuation', 'A non-main snapshot needs a resumable player choice.');
  if ((s.phase === 'over') !== (s.result !== null) || (s.phase === 'over' && (s.pending || s.queue.length)))
    throw new EngineError('invalid-phase', 'Terminal state cannot retain work or a pending choice.');
  return s;
}

// A pending Knock Out by an effect: some printed cn.knockOut of that binding allows this Pokémon
// (this Pokémon itself, or one of the printed side's).
function knockoutAllowed(s, catalog, owner, m, cause) {
  const { source } = cause ?? {};
  if (cause?.kind !== 'effect' || !source) return false;
  const params = [];
  const walk = (node) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      if (node.handlerId === 'cn.knockOut@1' && node.parameters) params.push(node.parameters);
      Object.values(node).forEach(walk);
    }
  };
  for (const definitionId of new Set(Object.values(s.cards).map((c) => c.definitionId))) {
    const d = catalog.definition(definitionId).mechanics;
    walk([...(d.effects ?? []), ...[...(d.attacks ?? []), ...(d.grantedAttacks ?? [])].flatMap((a) => a.effects),
      ...(d.abilities ?? []).flatMap((a) => a.effects)].filter((b) => b.effectId === source.effectId));
  }
  return params.some((p) => p.target === 'self' ? source.pokemonId === m.id : owner === (p.side === 'opponent' ? 1 - source.owner : source.owner));
}
function collectKO(s, catalog) {
  return allMons(s).filter(({ owner, m }) => m.facts.forcedKnockout || m.counters * 10 >= hp(s, catalog, owner, m))
    .map(({ owner, m }) => ({ owner, id: m.id, topCardId: top(m), prizes: monDef(s, catalog, m).mechanics.prizeCount,
      turn: s.turn, during: s.current, cause: clone(m.facts.forcedKnockout ?? m.facts.knockoutCause ?? { kind: 'rule', source: null }) }));
}
function afterKO(s) {
  const losers = s.players.map((p, i) => (!p.active && !p.bench.length) || !s.players[1 - i].prizes.length);
  if (losers[0] && losers[1]) finish(s, null, 'simultaneous');
  else if (losers.some(Boolean)) finish(s, losers[0] ? 1 : 0, 'ordinary');
  else {
    const order = [s.nextPlayer, 1 - s.nextPlayer];
    const vacant = order.filter((p) => !s.players[p].active);
    if (vacant.length > 1 && vacant.some((p) => s.vacancies[p]))
      throw new EngineError('unresolved-field-promotion-order', 'Mixed return/KO or dual-return promotion needs CN ordering evidence, not the simultaneous-KO rule.');
    if (vacant.some((p) => s.vacancies[p]?.promotion.timing === 'needsRuling'))
      throw new EngineError('unresolved-field-promotion', 'Non-KO Active replacement needs a reviewed schedule.');
    prepend(s, ...vacant.map((player) => tasks('promote', { player,
      ...(s.vacancies[player] ? { reason: 'fieldReturn', ...clone(s.vacancies[player]) } : {}) })));
  }
}

function runTask(s, catalog, { op, data: d }) {
  const p = s.players[d.player];
  switch (op) {
    case 'draw-cards':
      if (d.remaining > 0 && p.deck.length) {
        const cardId = p.deck.pop();
        prepend(s, ...entryWork(s, catalog, d.player, cardId, 'draw', d.reason, d.source),
          tasks('draw-cards', { ...d, remaining: d.remaining - 1, drawn: d.drawn + 1 }));
      } else {
        log(s, 'effects.draw', { player: d.player, count: d.drawn });
        if (d.completion) finishEffect(s, catalog, d.completion, d.drawn > 0);
      }
      break;
    case 'entry-window': {
      const { entry } = d;
      if (!s.players[entry.player].resolving.includes(entry.cardId) || !d.remaining.length) break;
      if (d.remaining.length > 1 && !d.selected) {
        ask(s, { player: entry.player, kind: 'before-hand-order', options: d.remaining,
          resume: 'entry-window', data: d, ruleId: 'trigger.before-hand' });
      } else {
        const unitId = d.selected?.[0] ?? d.remaining[0];
        if (!d.remaining.includes(unitId)) throw new EngineError('invalid-acquisition', 'Invalid receipt ordering choice.');
        prepend(s, tasks('entry-use', { entry, unitId }),
          tasks('entry-window', { entry, remaining: d.remaining.filter((id) => id !== unitId) }));
      }
      break;
    }
    case 'entry-use': {
      const { entry } = d, holder = s.players[entry.player];
      if (!holder.resolving.includes(entry.cardId)) break;
      const unit = acquisitionUnits(s, catalog, entry).find((u) => u.id === d.unitId);
      if (!unit) throw new EngineError('invalid-acquisition', 'The before-hand effect is no longer approved.');
      const activation = activationRequest('entry', entry.player, entry.cardId, { entry, entryUnitId: unit.id });
      if (!activationUsable(s, catalog, activation)) break;
      if (unit.trigger.optional && !d.selected) {
        ask(s, { player: entry.player, kind: 'before-hand-optional', options: ['perform', 'skip'],
          resume: 'entry-use', data: d, ruleId: 'trigger.before-hand' }); break;
      }
      if (d.selected?.[0] === 'skip') {
        log(s, 'trigger.before-hand', { entryId: entry.id, performed: false }, entry.player); break;
      }
      beginActivation(s, catalog, activation);
      break;
    }
    case 'activation-choice':
      payActivation(s, catalog, d.activation, d.selected);
      break;
    case 'entry-finish': {
      const holder = s.players[d.entry.player];
      if (holder.resolving.includes(d.entry.cardId)) {
        remove(holder.resolving, d.entry.cardId);
        if (d.discard) discard(s, catalog, d.entry.cardId);
        else holder.hand.push(d.entry.cardId);
      }
      // A Prize-card effect may itself create further Knock Outs. Finish that
      // effect and its new awards before the next Prize, without judging victory
      // in the middle of the original related award processing (I.D / I.E).
      if (d.entry.origin === 'prizes') prepend(s, tasks('ko', { deferOutcome: true }));
      break;
    }
    case 'deal': {
      for (const player of [0, 1]) draw(s, player, 7);
      const failed = s.players.map((p) => !p.hand.some((id) => {
        const def = cardDef(s, catalog, id); return def.kind === 'pokemon' && def.mechanics.stage === 'basic';
      }));
      if (failed.every(Boolean)) {
        for (const player of [0, 1]) {
          log(s, 'setup.mulligan', { player, revealed: s.players[player].hand.map((id) => clone(s.cards[id])), shared: true });
          s.setup.mulligans[player]++;
          s.players[player].deck.push(...s.players[player].hand.splice(0));
          shuffleIds(s.rng, s.players[player].deck);
        }
        prepend(s, tasks('deal'));
      } else if (failed.some(Boolean)) {
        const loser = failed[0] ? 0 : 1, ready = 1 - loser;
        prepend(s, tasks('prepare', { player: ready }), tasks('retry', { player: loser, ready }),
          tasks('prepare', { player: loser }), tasks('bonus', { player: ready }), tasks('finish-setup'));
      } else prepend(s, tasks('prepare', { player: s.first }), tasks('prepare', { player: 1 - s.first }), tasks('finish-setup'));
      break;
    }
    case 'prepare': {
      const options = p.hand.filter((id) => {
        const def = cardDef(s, catalog, id); return def.kind === 'pokemon' && def.mechanics.stage === 'basic';
      });
      ask(s, { player: d.player, kind: 'setup-active', options, resume: 'setup-active', data: d, ruleId: 'setup.active' });
      break;
    }
    case 'setup-active':
      remove(p.hand, d.selected[0]); p.active = newMon(s, d.selected[0]);
      prepend(s, tasks('setup-bench', { player: d.player }), tasks('place-prizes', { player: d.player }));
      break;
    case 'setup-bench': {
      if (d.selected) {
        for (const id of d.selected) { remove(p.hand, id); p.bench.push(newMon(s, id)); }
      } else {
        const options = p.hand.filter((id) => {
          const def = cardDef(s, catalog, id); return def.kind === 'pokemon' && def.mechanics.stage === 'basic';
        });
        if (options.length && p.bench.length < 5)
          ask(s, { player: d.player, kind: 'setup-bench', options, minimum: 0, maximum: Math.min(5 - p.bench.length, options.length),
            allowZero: true, resume: 'setup-bench', data: d, ruleId: 'turn.bench' });
      }
      break;
    }
    case 'place-prizes':
      if (s.setup.prizesPlaced[d.player]) throw new EngineError('invalid-setup', 'Prizes were already placed.');
      p.prizes = p.deck.splice(-(s.matchMode === 'tiebreak' ? 1 : 6));
      s.setup.prizesPlaced[d.player] = true;
      log(s, 'setup.prizes', { player: d.player, count: p.prizes.length });
      break;
    case 'retry': {
      log(s, 'setup.mulligan', { player: d.player, revealed: p.hand.map((id) => clone(s.cards[id])), shared: false });
      s.setup.mulligans[d.player]++; s.setup.bonus[d.ready]++;
      p.deck.push(...p.hand.splice(0)); shuffleIds(s.rng, p.deck); draw(s, d.player, 7);
      if (!p.hand.some((id) => {
        const def = cardDef(s, catalog, id); return def.kind === 'pokemon' && def.mechanics.stage === 'basic';
      })) prepend(s, tasks('retry', d));
      break;
    }
    case 'bonus':
      if (d.selected) {
        draw(s, d.player, Number(d.selected[0]));
      } else if (s.setup.bonus[d.player]) {
        const max = s.setup.bonus[d.player];
        ask(s, { player: d.player, kind: 'mulligan-bonus', options: Array.from({ length: max + 1 }, (_, i) => String(i)),
          resume: 'bonus', data: d, ruleId: 'setup.mulligan' });
      }
      break;
    case 'finish-setup':
      prepend(s, tasks('setup-bench', { player: s.first }), tasks('setup-bench', { player: 1 - s.first }),
        tasks('start-turn', { player: s.first }));
      break;
    case 'start-turn':
      s.current = d.player; s.nextPlayer = 1 - d.player; s.turn++; p.turns++; p.flags = flags(); s.phase = 'main';
      s.battleHistory = recordBattleTurn(s.battleHistory, { turn: s.turn, player: d.player });
      if (!p.deck.length) finish(s, 1 - d.player, 'deckout');
      else prepend(s, tasks('draw-cards', { player: d.player, remaining: 1, drawn: 0, reason: 'turnStart', source: null, completion: null }), tasks('ko'));
      break;
    case 'end-turn': {
      s.phase = 'resolving'; log(s, 'turn.end', { player: d.player });
      const events = allMons(s).map(({ owner, m }) => makeTriggerEvent(s, catalog, 'turnEnd', owner, m, { endingPlayer: d.player }));
      prepend(s, ...triggerWork(s, catalog, events), tasks('ko'), tasks('expire-turn', d),
        tasks('ko'), tasks('checkup', d), tasks('ko'), tasks('start-turn', { player: 1 - d.player }));
      break;
    }
    case 'expire-turn':
      expireAt(s, d.player, 'turn-end');
      break;
    case 'checkup': {
      s.phase = 'checkup'; s.current = null;
      const events = allMons(s).map(({ owner, m }) => makeTriggerEvent(s, catalog, 'checkup', owner, m, { endingPlayer: d.player }));
      const units = collectTriggers(s, catalog, events);
      units.sort((a, b) => a.owner - b.owner);
      prepend(s, tasks('checkup-plan', { units, before: [], after: [] }),
        tasks('finish-checkup', d));
      break;
    }
    case 'checkup-plan': {
      if (d.selected) {
        d[d.selected[0]].push(d.units.shift());
        delete d.selected;
      }
      if (d.units.length) ask(s, { player: d.units[0].owner, kind: 'checkup-placement', options: ['before', 'after'],
        resume: 'checkup-plan', data: d, ruleId: 'trigger.checkup' });
      else prepend(s, tasks('trigger-window', { units: d.before }), tasks('checkup-statuses'),
        tasks('trigger-window', { units: d.after }));
      break;
    }
    case 'checkup-statuses':
      for (const step of ['poison', 'burn', 'sleep', 'paralysis']) for (const [owner, player] of s.players.entries()) if (player.active) {
        const burnCounterChanges = [];
        if (step === 'burn' && player.active.conditions.burned) {
          const changes = continuousEntries(s, catalog).filter((e) => e.spec.op === 'burnCounters' &&
            entryTargets(s, catalog, e, owner, player.active)).map((e) => ({
            id: e.id, count: e.spec.count, sourceOfTruth: e.sourceOfTruth,
          }));
          const burn = resolveBurnCounters(changes); burnCounterChanges.push(burn.count);
          for (const trace of burn.trace) log(s, trace.ruleId, { pokemonId: player.active.id, ...trace });
        }
        const result = checkConditions(player.active.conditions, {
          ownerTurn: player.turns, ownerIsEndingPlayer: owner !== s.nextPlayer, flip: () => randomIndex(s.rng, 2) === 0,
          step, burnCounterChanges,
        });
        player.active.conditions = result.conditions;
        addCounters(s, catalog, owner, player.active, result.counters, { kind: 'checkup', source: null });
        for (const t of result.trace) log(s, t.ruleId, { pokemonId: player.active.id, ...t });
      }
      break;
    case 'finish-checkup':
      log(s, 'checkup.order', { endingPlayer: d.player });
      expireAt(s, d.player, 'checkup-end');
      break;
    case 'ko': {
      enforceEnergyRetention(s, catalog);
      const over = [0, 1].filter((player) => s.players[player].bench.length > benchLimit(s, catalog, player));
      if (over.length) {
        // A raised limit that stops applying is settled at this rule boundary,
        // before Knock Out processing continues (printed Stadium text).
        if (over.length > 1 && !s.stadium)
          throw new EngineError('unresolved-bench-trim-order', 'Both players exceed the limit without its source in play to order them.');
        const holder = s.stadium ? s.cards[s.stadium].owner : over[0];
        prepend(s, tasks('bench-trim', { order: [holder, 1 - holder] }), tasks('ko', d));
        break;
      }
      const batch = d.batch ?? [], awards = d.awards ?? [0, 0];
      const additional = collectKO(s, catalog).filter((item) => !batch.some((x) => x.id === item.id));
      if (additional.length) {
        const events = additional.map((item) => {
          const { m } = findMon(s, item.id);
          const event = makeTriggerEvent(s, catalog, 'knockout', item.owner, m,
            { cause: item.cause });
          item.receiptId = event.id;
          log(s, 'ko.boundary', { kind: 'latched', id: event.id, item: clone(item) });
          return event;
        });
        prepend(s, ...triggerWork(s, catalog, events), tasks('ko', { batch: [...batch, ...additional], awards, deferOutcome: d.deferOutcome ?? false }));
      } else if (batch.length) prepend(s, tasks('ko-discard', { batch, awards, deferOutcome: d.deferOutcome ?? false }));
      else if (awards.some((n) => n > 0)) prepend(s,
        ...[s.nextPlayer, 1 - s.nextPlayer].map((player) => tasks('award', { player, count: awards[player] })),
        tasks('finish-ko', { deferOutcome: d.deferOutcome ?? false }));
      else if (!d.deferOutcome) afterKO(s); // Loss of all Pokémon need not be caused by a Knock Out.
      break;
    }
    case 'bench-trim': {
      requireRule(catalog.ruleset, 'bench.limit');
      if (d.selected) {
        const player = s.players[d.player], excess = player.bench.length - benchLimit(s, catalog, d.player);
        if (d.selected.length !== excess || d.selected.some((id) => !player.bench.some((m) => m.id === id)))
          throw new EngineError('invalid-bench-trim', 'Discard exactly the Benched Pokémon over the current limit.');
        for (const id of d.selected) {
          const m = player.bench.find((x) => x.id === id);
          for (const card of [...m.stack, ...m.energy, ...m.tools]) discard(s, catalog, card);
          player.bench.splice(player.bench.indexOf(m), 1);
          retireTarget(s, m.id, 'leave');
          log(s, 'bench.limit', { player: d.player, pokemonId: m.id, discarded: [...m.stack, ...m.energy, ...m.tools] });
        }
        prepend(s, tasks('bench-trim', { order: d.order }));
        break;
      }
      // Recheck after every discard: losing the last qualifying Pokémon lowers the limit again.
      const next = d.order.find((player) => s.players[player].bench.length > benchLimit(s, catalog, player));
      if (next === undefined) break;
      const excess = s.players[next].bench.length - benchLimit(s, catalog, next);
      ask(s, { player: next, kind: 'bench-trim', options: s.players[next].bench.map((m) => m.id), minimum: excess, maximum: excess,
        resume: 'bench-trim', data: { order: d.order, player: next }, ruleId: 'bench.limit' });
      break;
    }
    case 'ko-discard': {
      const awards = [...d.awards];
      for (const item of d.batch) {
        const player = s.players[item.owner], m = mons(player).find((m) => m.id === item.id);
        if (!m) throw new EngineError('invalid-ko', 'Knock Out batch no longer matches the board.');
        for (const id of [...m.stack, ...m.energy, ...m.tools]) discard(s, catalog, id);
        if (player.active === m) player.active = null;
        else player.bench.splice(player.bench.indexOf(m), 1);
        retireTarget(s, m.id, 'knockout');
        awards[1 - item.owner] += item.prizes;
        battleFact(s, { kind: 'ko', owner: item.owner, pokemonId: m.id, cause: item.cause });
        log(s, 'ko.boundary', { owner: item.owner, pokemonId: item.id, prizes: item.prizes });
      }
      // Losing a continuous source may itself cause another Knock Out.
      // Finish that chain, including its triggers, before awarding/checking wins.
      prepend(s, tasks('ko', { awards, deferOutcome: d.deferOutcome ?? false }));
      break;
    }
    case 'award':
      if (d.selected) {
        const slot = Number(d.selected[0]), id = p.prizes[slot];
        if (!id) throw new EngineError('invalid-prize', 'Invalid Prize position.');
        p.prizes.splice(slot, 1);
        log(s, 'ko.boundary', { player: d.player, taken: 1, remaining: p.prizes.length });
        prepend(s, ...entryWork(s, catalog, d.player, id, 'prizes', null, null),
          ...(d.count > 1 ? [tasks('award', { player: d.player, count: d.count - 1 })] : []));
      } else if (d.count > 0 && p.prizes.length)
        ask(s, { player: d.player, kind: 'prize', options: p.prizes.map((_, i) => String(i)), resume: 'award', data: d, ruleId: 'ko.boundary' });
      break;
    case 'finish-ko':
      if (!d.deferOutcome) prepend(s, tasks('ko'));
      break;
    case 'promote':
      if (d.selected) {
        const i = p.bench.findIndex((m) => m.id === d.selected[0]);
        if (i < 0) throw new EngineError('invalid-target', 'Invalid promotion target.');
        p.active = p.bench.splice(i, 1)[0];
        p.active.facts.movedActiveTurn = s.turn; s.vacancies[d.player] = null;
        battleFact(s, { kind: 'benchToActive', owner: d.player, pokemonId: p.active.id });
        log(s, d.reason === 'fieldReturn' ? 'effects.field-return' : 'ko.promote',
          { player: d.player, pokemonId: p.active.id, ...(d.reason ? { promotion: clone(d.promotion) } : {}) });
      } else ask(s, { player: d.player, kind: 'promote', options: p.bench.map((m) => m.id), resume: 'promote', data: d,
        ruleId: d.reason === 'fieldReturn' ? 'effects.field-return' : 'ko.promote' });
      break;
    case 'retreat-paid': {
      const attached = energyCards(s, catalog, p.active), cost = retreatCost(s, catalog, d.player, p.active);
      if (!validateRetreatPayment(attached, d.selected, cost)) fail(s, 'retreat.payment', 'Invalid Retreat payment.');
      for (const id of d.selected) { remove(p.active.energy, id); discard(s, catalog, id); }
      prepend(s, tasks('finish-retreat', { player: d.player }));
      break;
    }
    case 'finish-retreat':
      if (d.selected) {
        const incoming = switchTo(s, d.player, d.selected[0]); p.flags.retreat = true; s.phase = 'main';
        prepend(s, ...becameActiveWork(s, catalog, d.player, incoming, { kind: 'rule', source: null }));
      } else ask(s, { player: d.player, kind: 'retreat-target', options: p.bench.map((m) => m.id), resume: 'finish-retreat', data: d, ruleId: 'retreat.limit' });
      break;
    case 'finish-trainer': {
      assertTrainerFinish(s, catalog, d);
      // Stadiums enter play immediately; Tools use attach-tool. Only an
      // Item/Supporter reaches this post-resolution discard continuation.
      if (p.resolving.includes(d.cardId)) { remove(p.resolving, d.cardId); discard(s, catalog, d.cardId); }
      log(s, 'turn.trainer', { kind: 'trainer-finished', id: d.completionId,
        player: d.player, cardId: d.cardId, turn: s.turn });
      prepend(s, tasks('ko')); s.phase = 'main';
      break;
    }
    case 'attach-tool':
      if (d.selected) {
        const m = mons(p).find((m) => m.id === d.selected[0] && !m.tools.length);
        if (!m) fail(s, 'turn.tool', 'This Pokémon cannot receive a Tool.');
        remove(p.resolving, d.cardId); m.tools.push(d.cardId);
        log(s, 'turn.tool', { player: d.player, pokemonId: m.id, cardId: d.cardId });
        s.phase = 'main'; prepend(s, tasks('ko'));
      } else ask(s, { player: d.player, kind: 'tool-target', options: mons(p).filter((m) => !m.tools.length).map((m) => m.id),
        resume: 'attach-tool', data: d, ruleId: 'turn.tool' });
      break;
    case 'attack': {
      const m = findMon(s, d.pokemonId)?.m, attack = d.attack;
      if (!m) throw new EngineError('unsupported-attack-transition', 'Declared attacker left play before resolution.');
      if (!imposedAttackCheck(s, catalog, m)) {
        prepend(s, tasks('ko'), tasks('end-turn', { player: d.player })); break;
      }
      const confusion = resolveConfusion(m.conditions, m.conditions.rotation === 'confused' ? randomIndex(s.rng, 2) === 0 : undefined);
      for (const trace of confusion.trace) log(s, trace.ruleId, { pokemonId: m.id, ...trace });
      if (!confusion.succeeded) {
        addCounters(s, catalog, d.player, m, confusion.selfCounters, { kind: 'rule', source: null });
        prepend(s, tasks('ko'), tasks('end-turn', { player: d.player })); break;
      }
      spendSpecialRule(s, catalog, d.player, attack.specialRule);
      m.facts.lastUsedAttack = { turn: s.turn, attackId: attack.attackId };
      log(s, 'energy.requirement', { player: d.player, pokemonId: m.id, attackId: attack.attackId,
        routes: attackRequirements(s, catalog, d.player, m, attack, d.sourceId, grantContext(d.grant)) });
      const source = { instanceId: d.sourceId, owner: d.player, cardOwner: s.cards[d.sourceId].owner,
        category: 'attack', pokemonId: m.id, attackId: attack.attackId,
        effectId: `attack:${attack.attackId}`, sourceOfTruth: attack.sourceOfTruth,
        ...(d.grant ? { contentSource: clone(d.grant.reference), grantId: d.grant.id } : {}) };
      if (d.grant) log(s, 'attack.grant', { kind: 'used', id: d.grant.id, source: clone(source),
        reference: clone(d.grant.reference), provider: clone(d.grant.provider),
        sourceOfTruth: clone(d.grant.provider.source.sourceOfTruth) });
      const id = `attack${++s.serial}`;
      s.attack = { id, player: d.player, pokemonId: m.id, sourceId: d.sourceId, attack: clone(attack), source,
        options: {}, events: [], damageModels: null,
        execution: { reference: null, copyId: null, performed: false, failureReceipt: null, phase: 'failure-check', damageCoins: null, effectCards: [] }, copies: [],
        usedSpecialRules: attack.specialRule ? [attack.specialRule] : [] };
      log(s, 'attack.used', { kind: 'used', id, turn: s.turn, player: d.player, source: clone(source) });
      beginAttackContent(s, catalog);
      break;
    }
    case 'attack-payment': {
      const spec = assertAttackPaymentChoice(s, catalog, d);
      const frame = s.attack, cards = commitmentCards(s, catalog, d.hand, frame.player);
      const result = resolveAttackCommitment(cards, spec, d.selected);
      for (const id of result.selected) { remove(s.players[frame.player].hand, id); discard(s, catalog, id); }
      const receipt = { kind: 'discardHand', id: d.id, selected: [...result.selected], passed: result.passed };
      frame.execution.failureReceipt = receipt;
      log(s, 'attack.failure.hand-payment', { kind: 'resolved', id: d.id, source: executingSource(s, catalog),
        receipt, sourceOfTruth: clone(executingAttack(s, catalog).failureCheck.sourceOfTruth) });
      if (!result.passed) { finishFailedAttack(s, catalog); break; }
      frame.execution.phase = 'body'; frame.execution.performed = true;
      beginAttackBody(s, catalog);
      break;
    }
    case 'after-attack': {
      if (canonicalJSON(d) !== canonicalJSON(attackFlow(s))) throw new EngineError('invalid-attack-flow', 'Damage phase lost its exact execution scope.');
      const m = findMon(s, d.pokemonId)?.m, attack = executingAttack(s, catalog);
      if (!m) throw new EngineError('unsupported-attack-transition', 'Declared attacker left play before damage.');
      const target = s.players[1 - d.player].active;
      if (!target) throw new EngineError('unsupported-attack-transition', 'An empty opposing Active position needs reviewed replacement timing before further damage.');
      prepareDamageCoins(s, catalog);
      let amount = attack.printedDamage?.value ?? null;
      const formulas = attack.effects.filter((b) => catalog.handler(b.handlerId).capabilities?.includes('resolve-attack-damage'));
      if (formulas.length || attack.printedDamage && attack.printedDamage.operator !== 'fixed') {
        if (formulas.length !== 1 || typeof catalog.handler(formulas[0].handlerId).damageFormula !== 'function')
          throw new EngineError('unsupported-formula', 'Exactly one reviewed damage-formula implementation is required.');
        const b = formulas[0], source = sourceFor(s, catalog, d.sourceId, d.player, 'attack', b, m.id,
          s.attack.attack.attackId, null, s.attack.execution);
        const ctx = effectContext(s, catalog, source);
        amount = catalog.handler(b.handlerId).damageFormula(deepFreeze({
          ...ctx, battleValues: battleValueFacts(s, catalog, source, { owner: 1 - d.player, m: target }),
        }), clone(b.parameters));
        log(s, 'damage.expression', { source: clone(source), targetId: target.id,
          expression: clone(b.parameters.expression ?? null), amount });
      }
      const currentSource = executingSource(s, catalog);
      s.attack.damageModels = allMons(s).map(({ owner, m }) => damageModel(s, catalog, currentSource, owner, m));
      log(s, 'damage.expression', { kind: 'stage-snapshot', frameId: s.attack.id,
        copyId: s.attack.execution.copyId, models: s.attack.damageModels }, 'private');
      dealAttackDamage(s, catalog, currentSource, [{ owner: 1 - d.player, m: target }], amount, s.attack.options);
      prepend(s, ...effectTasks(s, catalog, d.sourceId, d.player, 'attack', attack.effects, 'damage', m.id,
        s.attack.attack.attackId, null, s.attack.execution),
        tasks('resolve-attack', d));
      break;
    }
    case 'resolve-attack': {
      if (canonicalJSON(d) !== canonicalJSON(attackFlow(s))) throw new EngineError('invalid-attack-flow', 'Effect phase lost its exact execution scope.');
      s.attack.damageModels = null;
      const attack = executingAttack(s, catalog);
      prepend(s, ...effectTasks(s, catalog, d.sourceId, d.player, 'attack', attack.effects, 'resolve', d.pokemonId,
        s.attack.attack.attackId, null, s.attack.execution),
        tasks(d.copyId === null ? 'finish-attack' : 'finish-copy', { frameId: s.attack.id, player: d.player, copyId: d.copyId }));
      break;
    }
    case 'finish-copy': {
      if (!s.attack || d.frameId !== s.attack.id || d.copyId !== s.attack.execution.copyId || !s.attack.copies.length)
        throw new EngineError('invalid-copy-stack', 'Only the currently executing copied content may return to its caller.');
      const performed = s.attack.execution.performed, saved = s.attack.copies.pop();
      Object.assign(s.attack, { execution: saved.execution, options: saved.options, damageModels: saved.damageModels });
      finishEffect(s, catalog, saved.continuation, performed);
      break;
    }
    case 'finish-attack': {
      if (d.frameId !== s.attack.id || s.attack.execution.copyId !== null || s.attack.copies.length)
        throw new EngineError('invalid-copy-stack', 'The original attack cannot finish before its copied content.');
      const events = s.attack.events;
      s.attack = null;
      prepend(s, ...triggerWork(s, catalog, events), tasks('ko'), tasks('end-turn', { player: d.player }));
      break;
    }
    case 'trigger-window': {
      const model = sourceModel(s, catalog);
      d.units = d.units.filter((unit) => triggerStillAvailable(s, catalog, unit, model));
      if (!d.units.length) break;
      assertOwnerIndependence(d.units.map((u) => costsForUnit(s, catalog, u).length ?
        { ...u, trigger: { ...u.trigger, scope: 'global' } } : u));
      const owner = Math.min(...d.units.map((u) => u.owner)), own = d.units.filter((u) => u.owner === owner);
      if (!d.selected && own.length > 1) ask(s, { player: owner, kind: 'trigger-order', options: own.map((u) => u.id),
        resume: 'trigger-window', data: d, ruleId: triggerRuleId(own[0].event.kind) });
      else {
        const unit = d.selected ? own.find((u) => u.id === d.selected[0]) : own[0];
        if (!unit) throw new EngineError('invalid-trigger-order', 'Only the affected holder may order these triggers.');
        prepend(s, tasks('trigger-execute', { unit }), tasks('trigger-window', { units: d.units.filter((u) => u !== unit) }));
      }
      break;
    }
    case 'trigger-execute': {
      const u = d.unit, source = u.reaction?.source ?? u.bindings[0].source;
      if (!triggerStillAvailable(s, catalog, u)) break;
      const found = source.pokemonId ? findMon(s, source.pokemonId) : null;
      const subject = findMon(s, u.event.subjectId);
      let event = u.event;
      if (['checkup', 'turnEnd'].includes(event.kind) && subject) event = { ...event, snapshot: clone(subject.m),
        definitionId: monDef(s, catalog, subject.m).definitionId, wasActive: s.players[subject.owner].active === subject.m };
      const observer = u.reaction ? { ...source, pokemonId: u.reaction.targetId } : source;
      if (!triggerMatches(u.trigger, event, observer, { sourceActive: s.players[u.reaction ? event.owner : source.owner].active?.id === observer.pokemonId,
        definition: catalog.definition(event.definitionId) })) break;
      if (!usageAllowed(s, source.owner, found?.m, u.usage) || (u.specialRule === 'VSTAR' && s.players[source.owner].vstarUsed)) break;
      const activation = u.reaction ? null : activationRequest('trigger', u.controller, source.instanceId, { unit: { ...u, event } });
      if (activation && !activationUsable(s, catalog, activation)) break;
      if (u.trigger.optional && !d.selected) {
        ask(s, { player: u.controller, kind: 'trigger-optional', options: ['perform', 'skip'],
          resume: 'trigger-execute', data: { unit: u }, ruleId: triggerRuleId(event.kind) });
        break;
      }
      if (d.selected?.[0] === 'skip') {
        log(s, triggerRuleId(event.kind), { triggerId: u.id, performed: false }); break;
      }
      if (activation) { beginActivation(s, catalog, activation); break; }
      recordUsage(s, source.owner, found?.m, u.usage);
      spendSpecialRule(s, catalog, source.owner, u.specialRule);
      log(s, triggerRuleId(event.kind), { triggerId: u.id, sourceId: source.instanceId, subjectId: event.subjectId,
        owner: u.owner, controller: u.controller, abilityId: u.abilityId, performed: true });
      if (u.reaction) {
        const program = u.reaction.effect.program;
        assertEffectProgram(program, REACTION_OPERATIONS);
        if (u.trigger.scope === 'subject') assertSubjectProgram(program, event, source);
        const data = scheduleTrackedEffect(s, catalog, { source, event, local: u.trigger.scope === 'subject' }, 'reaction');
        const programId = openTrackedEffect(s, catalog, data, program);
        prepend(s, tasks('effect-choice', { ...beginEffectProgram(program), ...data,
          ...(programId ? { programId } : {}) }));
      }
      break;
    }
    case 'effect': {
      requireExecutionReference(s, catalog, d, 'effect');
      const handler = catalog.handler(d.binding.handlerId);
      const actions = handler.execute(factContext(s, catalog, handler, effectContext(s, catalog, d.source, d.event ?? null, d.local ?? false,
        null, false, d.entry ?? null, d.payment ?? null), d.source, d.binding.parameters), clone(d.binding.parameters));
      if (!Array.isArray(actions)) throw new EngineError('invalid-handler', 'Handlers must return a serializable effect program.');
      assertJSON(actions);
      assertEffectProgram(actions, handler.operations, handler.embeddedOperations ?? []);
      if (d.local) assertSubjectProgram(actions, d.event, d.source);
      const programId = openTrackedEffect(s, catalog, d, actions);
      prepend(s, tasks('effect-choice', { ...beginEffectProgram(actions), source: d.source,
        event: d.event ?? null, local: d.local ?? false, entry: d.entry ?? null, payment: d.payment ?? null,
        ...(programId ? { programId } : {}) }));
      break;
    }
    case 'effect-choice': runEffect(s, catalog, d); break;
    default: throw new EngineError('unsupported-task', `Unknown internal task: ${op}`);
  }
}

function finishEffect(s, catalog, d, performed) {
  if (performed && s.attack && d.source.category === 'attack' && d.source.instanceId === s.attack.sourceId &&
      d.source.pokemonId === s.attack.pokemonId && (d.source.copyId ?? null) === s.attack.execution.copyId)
    s.attack.execution.performed = true;
  log(s, 'effects.partial', { effectId: d.source.effectId, operation: d.action.op, performed,
    sourceOfTruth: d.source.sourceOfTruth,
    ...(d.source.contentSource ? { ...(d.source.copyId ? { copyId: d.source.copyId } : { grantId: d.source.grantId }),
      contentSource: clone(d.source.contentSource) } : {}) });
  advanceTrackedEffect(s, catalog, d, 'complete', performed);
  const next = completeEffectStep({ action: d.action, frames: d.frames }, performed);
  // A counted effect that ends without moving anything (declined, or nothing there) records zero.
  if (!next && countedEffect(catalog, executionBinding(s, catalog, d.source)) &&
      !s.attack.execution.effectCards.some((e) => e.effectId === d.source.effectId)) recordEffectCards(s, catalog, d, []);
  if (next) prepend(s, tasks('effect-choice', { ...next, source: d.source, event: d.event ?? null,
    local: d.local ?? false, entry: d.entry ?? null, payment: d.payment ?? null,
    ...(d.programId ? { programId: d.programId } : {}) }));
}
// 「牌库上方／下方N张」, both in the deck's own order from the top down.
function arrangeWindow(s, a, deckOwner) {
  const deck = s.players[deckOwner].deck;
  return (a.from === 'top' ? deck.slice(-a.count) : deck.slice(0, a.count)).reverse();
}
// The opponent's hand cards a choice may take: the printed kind, at most the
// Bench spaces; the user's choice is open to the opponent (II.D-04), the
// opponent's own is a hand choice (II.E-33); 「直到手牌变为N张」 is exact.
function opponentHandWindow(s, catalog, a, foe) {
  const p = s.players[foe];
  if (!a.quantity) return { pool: [], bounds: null };
  const pool = p.hand.filter((id) => matchesCardSelector(cardDef(s, catalog, id), a.selector));
  const room = a.to === 'bench' ? Math.max(0, benchLimit(s, catalog, foe) - p.bench.length) : pool.length;
  const quantity = a.quantity.kind === 'leave' ? { kind: 'exact', count: Math.max(0, p.hand.length - a.quantity.count) } : a.quantity;
  return { pool, bounds: selectionBounds({ ...quantity, available: Math.min(pool.length, room),
    zone: a.mode === 'opponentChooses' ? 'ownHand' : 'public', filter: selectorQuantityClass(a.selector) }) };
}
function moveFromOpponentHand(s, catalog, d, foe, ids) {
  const { action: a, source } = d, p = s.players[foe], events = [];
  for (const id of ids) {
    remove(p.hand, id);
    if (a.to === 'discard') discard(s, catalog, id);
    else if (a.to === 'deckBottom') p.deck.unshift(id);
    else if (a.to === 'deckShuffle') p.deck.push(id);
    else {
      const m = newMon(s, id); p.bench.push(m);
      log(s, 'effects.deploy', { player: foe, from: 'hand', to: 'bench', cardId: id, pokemonId: m.id, effectId: source.effectId });
      events.push(makeTriggerEvent(s, catalog, 'bench', foe, m, { origin: 'hand', cardId: id, cause: { kind: 'effect', source } }));
    }
  }
  // Cards going into the deck stay unknown to anyone the text does not show them to.
  log(s, 'effects.opponent-hand', { effectId: source.effectId, player: foe, mode: a.mode, to: a.to, count: ids.length,
    ...(['deckBottom', 'deckShuffle'].includes(a.to) ? {} : { cards: [...ids] }) });
  if (a.to === 'deckShuffle' && ids.length) shuffleZone(s, foe, 'deck', source);
  finishEffect(s, catalog, d, ids.length > 0);
  prepend(s, ...triggerWork(s, catalog, events));
}
function runEffect(s, catalog, d) {
  const { action: a, source } = d, owner = source.owner;
  const step = assertEffectStep({ action: a, frames: d.frames });
  if (['sequence', 'then', 'orElse'].includes(a.op)) {
    const next = expandEffectStep(step);
    advanceTrackedEffect(s, catalog, d, 'expand', null);
    if (next) prepend(s, tasks('effect-choice', { ...next, source, event: d.event ?? null, local: d.local ?? false, entry: d.entry ?? null,
      payment: d.payment ?? null, ...(d.programId ? { programId: d.programId } : {}) }));
    return;
  }
  if (a.op === 'optional') {
    if (d.selected) {
      log(s, 'selection.optional', { effectId: source.effectId, performed: d.selected[0] === 'perform' });
      if (d.selected[0] === 'perform') {
        advanceTrackedEffect(s, catalog, d, 'optional', true);
        prepend(s, tasks('effect-choice', { action: a.effect, frames: d.frames, source, event: d.event ?? null, local: d.local ?? false, entry: d.entry ?? null,
          payment: d.payment ?? null, ...(d.programId ? { programId: d.programId } : {}) }));
      }
      else finishEffect(s, catalog, d, false);
    } else ask(s, { player: owner, kind: 'optional-effect', options: ['perform', 'skip'],
      resume: 'effect-choice', data: d, ruleId: 'selection.optional' });
    return;
  }
  if (a.op === 'coin') {
    // II.C-05/II.D-04 文例: flip first; only the printed result opens the rest.
    const result = randomIndex(s.rng, 2) === 0 ? 'heads' : 'tails';
    if (s.attack && source.category === 'attack' && source.instanceId === s.attack.sourceId &&
        source.pokemonId === s.attack.pokemonId && (source.copyId ?? null) === s.attack.execution.copyId)
      s.attack.execution.performed = true;
    log(s, 'effects.coin', { effectId: source.effectId, player: owner, result, required: a.outcome,
      sourceOfTruth: source.sourceOfTruth });
    if (result !== a.outcome && !a.otherwise) { finishEffect(s, catalog, d, false); return; }
    advanceTrackedEffect(s, catalog, d, result === a.outcome ? 'optional' : 'otherwise', true);
    prepend(s, tasks('effect-choice', { action: result === a.outcome ? a.effect : a.otherwise, frames: d.frames, source,
      event: d.event ?? null, local: d.local ?? false, entry: d.entry ?? null, payment: d.payment ?? null,
      ...(d.programId ? { programId: d.programId } : {}) }));
    return;
  }
  if (a.op === 'coinResult' || a.op === 'when') {
    // II.E-38 文例3: the coins this attack's damage flipped, read once more; nothing is flipped again.
    // 「如果…，则…」: the board as it is when this instruction is reached.
    const met = evaluateBattlePredicate(a.condition, battleValueFacts(s, catalog, source, null, sourceModel(s, catalog),
      a.op === 'when' ? queryNodes(a.condition) : []));
    if (a.op === 'when') log(s, 'effects.condition', { effectId: source.effectId, player: owner, met });
    if (!met && !a.otherwise) { finishEffect(s, catalog, d, false); return; }
    advanceTrackedEffect(s, catalog, d, met ? 'optional' : 'otherwise', true);
    prepend(s, tasks('effect-choice', { action: met ? a.effect : a.otherwise, frames: d.frames, source,
      event: d.event ?? null, local: d.local ?? false, entry: d.entry ?? null, payment: d.payment ?? null,
      ...(d.programId ? { programId: d.programId } : {}) }));
    return;
  }
  if (a.op === 'coins') {
    // II.B-02 文例2: the flips are counted; only the printed count or result opens the instruction.
    const receipt = rollDamageCoin(a.flips, () => randomIndex(s.rng, 2) === 0), shown = receipt[a.face];
    if (s.attack && source.category === 'attack' && source.instanceId === s.attack.sourceId &&
        source.pokemonId === s.attack.pokemonId && (source.copyId ?? null) === s.attack.execution.copyId)
      s.attack.execution.performed = true;
    log(s, 'effects.coin', { effectId: source.effectId, player: owner, receipt, face: a.face, sourceOfTruth: source.sourceOfTruth });
    const scale = a.apply.kind === 'scale';
    if (scale ? shown === 0 : shown < (a.apply.kind === 'all' ? receipt.flips : a.apply.count)) { finishEffect(s, catalog, d, false); return; }
    advanceTrackedEffect(s, catalog, d, scale ? 'scaled' : 'optional', true, scale ? { times: shown } : {});
    prepend(s, tasks('effect-choice', { action: scale ? scaleEffect(a, shown) : a.effect, frames: d.frames, source,
      event: d.event ?? null, local: d.local ?? false, entry: d.entry ?? null, payment: d.payment ?? null,
      ...(d.programId ? { programId: d.programId } : {}) }));
    return;
  }
  // A zero instruction performs nothing, and cannot make a dependent "then" run.
  if (Object.hasOwn(a, 'count') && a.count === 0) { finishEffect(s, catalog, d, false); return; }
  if (a.op === 'disableOwnedAttack') {
    assertOwnedAttackChoice(s, catalog, d);
    const ctx = effectContext(s, catalog, source), window = ownedAttackLockWindow(ctx, a);
    const choice = d.ownedAttackChoice ?? { id: `lock${++s.serial}`, turn: s.turn, sourceId: source.instanceId,
      historyIndex: s.battleHistory.events.length, ...clone(window) };
    const request = d.ownedAttackChoice ? ownedAttackRequest(s, choice.id) : {
      kind: 'requested', id: choice.id, source, action: a, choice, programId: d.programId,
      programIndex: requireExecutionReference(s, catalog, d, 'effect-choice').cursor.index,
    };
    if (!d.ownedAttackChoice) log(s, 'attack.owned-lock', request, 'private');
    if (!Object.hasOwn(d, 'selected') && window.candidates.length) {
      ask(s, { player: owner, kind: 'owned-attack', options: window.candidates.map(attackOptionId),
        resume: 'effect-choice', data: { ...d, ownedAttackChoice: choice },
        ruleId: 'attack.owned-lock', requestId: choice.id });
      return;
    }
    const selected = (d.selected ?? []).map((id) => window.candidates.find((ref) => attackOptionId(ref) === id));
    planOwnedAttackLock(ctx, a, selected);
    const blocked = window.target !== null && effectBlocked(s, catalog, source, window.owner, findMon(s, window.target.pokemonId).m);
    const plan = planOwnedAttackLock(ctx, a, selected, blocked);
    let entryId = null;
    if (plan.performed) {
      entryId = `e${++s.serial}`;
      s.ongoing.push(createOngoingEffect({ id: entryId, targetId: plan.target.pokemonId, source,
        effect: { op: 'ownedAttackRestriction', scope: 'all', reference: plan.selected[0] },
        ownedAttackLockId: choice.id, duration: a.duration, clearOnBench: true, clearOnEvolution: true }, s));
    }
    log(s, 'attack.owned-lock', { ...request, kind: 'applied', selected: plan.selected,
      performed: plan.performed, entryId }, 'private');
    finishEffect(s, catalog, d, plan.performed); return;
  }
  if (a.op === 'discardStadium') {
    const ctx = effectContext(s, catalog, source, d.event ?? null), window = stadiumWindow(ctx, a);
    if (!window.target) { finishEffect(s, catalog, d, false); return; }
    const shields = stadiumProtections(s, catalog, source);
    const plan = planDiscardStadium(ctx, a, shields.length > 0);
    if (shields.length) log(s, 'effects.protection', { subject: plan.target,
      effectId: source.effectId, effects: shields.map(({ id, sourceOfTruth, spec }) => ({
        id, sourceOfTruth, useRule: spec.useRule,
      })) });
    if (plan.performed) {
      const before = counterLethalFacts(s, catalog);
      s.stadium = null;
      const destination = discard(s, catalog, plan.target.instanceId);
      if (destination !== plan.destination)
        throw new EngineError('invalid-field-card-plan', 'The printed discard replacement and field-card plan must agree.');
      settleCounterProperties(s, catalog, before, source);
    }
    log(s, 'effects.stadium-discard', { subject: plan.target, destination: plan.destination,
      performed: plan.performed, effectId: source.effectId, sourceOfTruth: source.sourceOfTruth });
    recordEffectCards(s, catalog, d, plan.performed ? [plan.target.instanceId] : []);
    finishEffect(s, catalog, d, plan.performed);
    if (plan.performed) {
      const holder = s.cards[plan.target.instanceId].owner;
      prepend(s, tasks('bench-trim', { order: [holder, 1 - holder] }));
    }
    return;
  }
  if (a.op === 'distributeCounters') {
    assertCounterChoice(s, catalog, d);
    const ctx = effectContext(s, catalog, source, d.event ?? null), window = counterDistributionWindow(ctx, a);
    if (!window.targets.length) { finishEffect(s, catalog, d, false); return; }
    const choice = d.counterChoice ?? { id: `counter${++s.serial}`, turn: s.turn,
      sourceId: source.instanceId, targets: clone(window.targets) };
    if (!d.counterChoice)
      log(s, 'damage.counter-distribution', { kind: 'requested', id: choice.id, source, action: a, choice });
    const allocations = d.allocations ??
      (window.targets.length === 1 ? [{ pokemonId: window.targets[0].pokemonId, count: a.count }] : null);
    if (!allocations) {
      ask(s, { player: owner, kind: 'counter-allocation', options: window.targets.map((t) => t.pokemonId),
        minimum: 0, maximum: window.targets.length, allowZero: true, resume: 'effect-choice',
        data: { ...d, counterChoice: choice }, ruleId: 'damage.counter-distribution', requestId: choice.id });
      return;
    }
    // A full numeric selection precedes any protection query. Protection is
    // frozen for every allocated target BEFORE any counter/HP/source changes.
    assertCounterDistributionAllocation(ctx, a, allocations);
    const blocked = allocations.filter(({ pokemonId }) =>
      effectBlocked(s, catalog, source, window.owner, findMon(s, pokemonId).m)).map(({ pokemonId }) => pokemonId);
    const plan = planCounterDistribution(ctx, a, allocations, blocked), before = counterLethalFacts(s, catalog);
    for (const update of plan.updates) findMon(s, update.pokemonId).m.counters = update.afterCounters;
    settleCounterProperties(s, catalog, before, source);
    log(s, 'damage.counter-distribution', { kind: 'resolved', id: choice.id, source,
      allocations: plan.allocations, updates: plan.updates, selectedTotal: plan.selectedTotal,
      placedTotal: plan.placedTotal, preventedTotal: plan.preventedTotal, performed: plan.performed });
    finishEffect(s, catalog, d, plan.performed); return;
  }
  if (a.op === 'healPokemon') {
    assertHealingChoice(s, catalog, d);
    const ctx = effectContext(s, catalog, source, d.event ?? null), window = healingWindow(ctx, a);
    if (!window.targets.some((t) => t.counters > 0)) { finishEffect(s, catalog, d, false); return; }
    const choice = d.healingChoice ?? { id: `heal${++s.serial}`, turn: s.turn,
      sourceId: source.instanceId, targets: clone(window.targets) };
    if (!d.healingChoice)
      log(s, 'effects.heal-results', { kind: 'requested', id: choice.id, source, action: a, choice });
    const selected = d.selected ?? (a.selection.kind === 'all' ||
      window.bounds.minimum === window.targets.length && window.bounds.maximum === window.targets.length ?
      window.targets.map((t) => t.pokemonId) : null);
    if (!selected) {
      ask(s, { player: owner, kind: 'healing-targets', options: window.targets.map((t) => t.pokemonId),
        ...window.bounds, resume: 'effect-choice', data: { ...d, healingChoice: choice }, ruleId: 'effects.heal-results' });
      return;
    }
    // Validate the entire selection before querying protections; freeze every
    // heal mask before changing any subject's counters, history or properties.
    planPokemonHealing(ctx, a, selected);
    const blocked = selected.filter((id) => effectBlocked(s, catalog, source, window.owner, findMon(s, id).m));
    const plan = planPokemonHealing(ctx, a, selected, blocked), beforeHeal = counterLethalFacts(s, catalog);
    for (const update of plan.updates) findMon(s, update.pokemonId).m.counters = update.afterCounters;
    for (const update of plan.updates) if (update.removedCounters > 0) {
      const m = findMon(s, update.pokemonId).m;
      m.facts.healedTurn = s.turn;
      battleFact(s, { kind: 'heal', owner: plan.owner, pokemonId: m.id, amount: update.removedCounters * 10 });
      log(s, 'effects.heal', { targetId: m.id, effectId: source.effectId, sourceOfTruth: source.sourceOfTruth,
        operation: a.op, amount: update.removedCounters * 10 });
    }
    settleCounterProperties(s, catalog, beforeHeal, source);
    const discarded = [];
    if (a.discardHealedEnergy && plan.performed) {
      const beforeEnergy = counterLethalFacts(s, catalog);
      // A later clause checks its own current protection/attachments. Do not
      // scan every evolved Pokémon or borrow an earlier turn's healed flag.
      const changes = plan.healed.flatMap((id) => {
        const { m } = findMon(s, id);
        return !m.energy.length || effectBlocked(s, catalog, source, plan.owner, m) ? [] :
          m.energy.map((energyId) => ({ m, energyId }));
      });
      for (const { m, energyId } of changes) {
        remove(m.energy, energyId); discard(s, catalog, energyId); discarded.push(energyId);
        log(s, 'energy.attached-selection', { energyId, from: m.id, to: null, discarded: true,
          effectId: source.effectId, sourceOfTruth: source.sourceOfTruth });
      }
      settleCounterProperties(s, catalog, beforeEnergy, source);
    }
    log(s, 'effects.heal-results', { kind: 'resolved', id: choice.id, source, selected: plan.selected,
      updates: plan.updates, healed: plan.healed, discarded, performed: plan.performed });
    finishEffect(s, catalog, d, plan.performed); return;
  }
  if (a.op === 'copyAttack') {
    const frame = s.attack;
    if (!frame || source.category !== 'attack' || source.instanceId !== frame.sourceId || source.pokemonId !== frame.pokemonId ||
        source.attackId !== frame.attack.attackId || (source.copyId ?? null) !== frame.execution.copyId)
      throw new EngineError('invalid-copy-source', 'Copying is part of its original currently executing attack, not a new declaration.');
    if (!d.copyChoice) {
      const coin = a.coin === 'none' ? null : randomIndex(s.rng, 2) === 0 ? 'heads' : 'tails';
      if (coin !== null) {
        // Flipping is an executed part of this attack's contents, even when it
        // does not enable this particular copy instruction. Keep the local
        // copy result separate from the enclosing copied attack's execution.
        frame.execution.performed = true;
        log(s, 'attack.copy', { kind: 'coin', source, coin });
      }
      if (coin !== null && coin !== a.coin) { finishEffect(s, catalog, d, false); return; }
      const id = `copy${++s.serial}`, candidates = copyPool(s, catalog, d, id);
      if (!candidates.length) { finishEffect(s, catalog, d, false); return; }
      const choice = { id, candidates, coin };
      log(s, 'attack.copy', { kind: 'gate', id, source, action: a, choice });
      prepend(s, tasks('effect-choice', { ...d, stage: 'copy-select', copyChoice: choice })); return;
    }
    assertCopyChoice(s, catalog, d);
    if (!d.selected) {
      ask(s, { player: owner, kind: 'copy-attack', options: d.copyChoice.candidates.map(attackOptionId),
        resume: 'effect-choice', data: d, ruleId: 'attack.copy' }); return;
    }
    const reference = d.copyChoice.candidates.find((r) => attackOptionId(r) === d.selected[0]);
    if (!reference) throw new EngineError('invalid-copy-choice', 'Selected attack is not an eligible printed source.');
    const attack = copiedAttack(s, catalog, reference);
    if (attack.specialRule) {
      if (a.special.mode === 'needsRuling') throw new EngineError('unresolved-copy-special-rule', 'Copied GX/VSTAR handling needs card-specific CN evidence.');
      if (a.special.mode === 'consumeUserQuota') {
        const flag = attack.specialRule === 'GX' ? 'gxUsed' : 'vstarUsed';
        if (s.players[owner][flag] && !frame.usedSpecialRules.includes(attack.specialRule))
          throw new EngineError('copy-special-rule-used', 'The actual user has already spent this game-wide resource.');
        s.players[owner][flag] = true;
        if (!frame.usedSpecialRules.includes(attack.specialRule)) frame.usedSpecialRules.push(attack.specialRule);
      }
    }
    log(s, 'attack.copy', { kind: 'selected', id: d.copyChoice.id, source, reference, parentCopyId: frame.execution.copyId });
    frame.copies.push({ execution: clone(frame.execution), options: clone(frame.options), damageModels: clone(frame.damageModels),
      continuation: clone(d) });
    frame.execution = { reference: clone(reference), copyId: d.copyChoice.id, performed: false, failureReceipt: null, phase: 'failure-check', damageCoins: null, effectCards: [] };
    beginAttackContent(s, catalog); return;
  }
  if (a.op === 'returnPokemon') {
    if (s.attack && s.queue.some((t) => t.op === 'after-attack'))
      throw new EngineError('unsupported-attack-transition', 'A pre-damage departure needs its own reviewed damage/Active-replacement semantics.');
    const ctx = effectContext(s, catalog, source, d.event ?? null), targetOwner = a.side === 'own' ? owner : 1 - owner;
    const pool = fieldReturnTargets(ctx, a), bounds = selectionBounds({ ...a.quantity, available: pool.length });
    if (d.selected) {
      if (!canSelectCount(bounds, d.selected.length) || d.selected.some((id) => !pool.some((m) => m.id === id)))
        throw new EngineError('invalid-field-return', 'Returned Pokémon must satisfy the original public predicate and quantity.');
      // Compute protection for the whole batch before removing any continuous source.
      const selected = d.selected.map((id) => findMon(s, id).m);
      const changes = selected.map((m) => ({ m, blocked: effectBlocked(s, catalog, source, targetOwner, m) }));
      const p = s.players[targetOwner], departed = [];
      if (changes.some(({ m, blocked }) => !blocked &&
          s.queue.some((t) => ['ko', 'ko-discard'].includes(t.op) && t.data.batch?.some((k) => k.id === m.id))))
        throw new EngineError('unsupported-ko-zone-replacement', 'A latched Knock Out needs its own sourced zone-replacement semantics.');
      const leavingActive = changes.some(({ m, blocked }) => !blocked && p.active === m);
      if (leavingActive && a.promotion.timing === 'needsRuling' &&
          p.bench.some((m) => !changes.some((c) => c.m.id === m.id && !c.blocked)))
        throw new EngineError('unresolved-field-promotion', 'The return movement cannot guess when its holder replaces the Active.');
      for (const { m, blocked } of changes) if (!blocked) {
        const destination = a.to === 'hand' ? p.hand : p.deck, attachments = [...m.energy, ...m.tools];
        destination.push(...m.stack);
        if (a.attachments === 'return') destination.push(...attachments);
        else for (const id of attachments) discard(s, catalog, id);
        if (p.active === m) {
          p.active = null; s.vacancies[targetOwner] = { source: clone(source), promotion: clone(a.promotion) };
        } else p.bench.splice(p.bench.indexOf(m), 1);
        departed.push(m.id);
        log(s, 'effects.field-return', { player: targetOwner, pokemonId: m.id, pokemonCards: [...m.stack],
          attachments, to: a.to, attachmentDestination: a.attachments === 'return' ? a.to : 'discard',
          sourceOfTruth: source.sourceOfTruth });
      }
      retainOngoing(s, (e) => !departed.includes(e.targetId), 'leave');
      if (departed.length && a.to === 'deckShuffle') shuffleZone(s, targetOwner, 'deck', source);
      finishEffect(s, catalog, d, departed.length > 0);
      if (leavingActive && p.bench.length && a.promotion.timing === 'afterAction')
        prepend(s, tasks('promote', { player: targetOwner, reason: 'fieldReturn', ...clone(s.vacancies[targetOwner]) }));
    } else if (!pool.length) finishEffect(s, catalog, d, false);
    else if (a.quantity.kind === 'all') prepend(s, tasks('effect-choice', { ...d, selected: pool.map((m) => m.id) }));
    else ask(s, { player: a.chooser === 'holder' ? targetOwner : owner, kind: 'return-pokemon', options: pool.map((m) => m.id),
      ...bounds, resume: 'effect-choice', data: d, ruleId: 'effects.field-return' });
    return;
  }
  if (['evolvePokemon', 'inheritPokemon'].includes(a.op)) {
    const ctx = effectContext(s, catalog, source, d.event ?? null), p = s.players[owner];
    const pool = transitionTargets(ctx, a).filter((m) => a.op !== 'evolvePokemon' ||
      evolutionTiming(s, owner, m, a.timing).allowed || evolutionTiming(s, owner, m, a.timing).needsRuling)
      .map((m) => findMon(s, m.id).m);
    if (d.transition) {
      const m = pool.find((m) => m.id === d.transition.pokemonId);
      if (!m || top(m) !== d.transition.topCardId) throw new EngineError('invalid-pokemon-transition', 'Transition target changed before card selection.');
      const choices = transitionCards(ctx, a, m), bounds = selectionBounds({
        kind: 'exact', count: 1, available: choices.length,
        zone: a.from === 'deck' ? 'deck' : a.from === 'hand' ? 'ownHand' : 'public', filter: 'specific',
      });
      if (d.selected) {
        const selected = d.stage === 'transition-empty' ? [] : d.selected;
        if (!canSelectCount(bounds, selected.length) || selected.some((id) => !choices.includes(id)))
          throw new EngineError('invalid-pokemon-transition', 'Chosen card does not satisfy the approved evolution or replacement relation.');
        let performed = false, event = null;
        if (selected.length && !effectBlocked(s, catalog, source, owner, m)) {
          const id = selected[0]; remove(p[a.from], id);
          if (a.op === 'evolvePokemon') event = evolveMon(s, catalog, owner, m, id, a.from, source);
          else {
            const old = m.stack.at(-1), wasLethal = m.counters * 10 >= hp(s, catalog, owner, m);
            m.stack[m.stack.length - 1] = id;
            if (a.to === 'discard') discard(s, catalog, old); else p[a.to].push(old);
            enforceEnergyRetention(s, catalog); recordTransitionKO(s, catalog, owner, m, wasLethal, source);
            log(s, 'effects.inherit', { pokemonId: m.id, fromCardId: old, toCardId: id, sourceOfTruth: source.sourceOfTruth });
          }
          performed = true;
        }
        const shuffled = a.op === 'evolvePokemon' && a.shuffleAfter && shuffleZone(s, owner, 'deck', source);
        finishEffect(s, catalog, d, performed || shuffled);
        if (event) prepend(s, ...triggerWork(s, catalog, [event]));
      } else if (choices.length) ask(s, { player: owner, kind: 'transition-card', options: choices, ...bounds,
        resume: 'effect-choice', data: d, ruleId: a.op === 'evolvePokemon' ? 'effects.evolve' : 'effects.inherit' });
      else if (a.from === 'deck' && p.deck.length) ask(s, { player: owner, kind: 'view-cards', options: ['confirm'],
        resume: 'effect-choice', data: { ...d, stage: 'transition-empty' }, ruleId: 'effects.evolve' });
      else finishEffect(s, catalog, d, false);
    } else if (d.selected) {
      const m = pool.find((m) => m.id === d.selected[0]);
      if (!m) throw new EngineError('invalid-pokemon-transition', 'Invalid evolution or inherited-replacement target.');
      if (a.op === 'evolvePokemon' && evolutionTiming(s, owner, m, a.timing).needsRuling)
        throw new EngineError('unresolved-evolution-timing', 'Already-evolved timing needs a sourced card-specific ruling.');
      prepend(s, tasks('effect-choice', { ...withoutSelection(d), stage: 'transition-card',
        transition: { pokemonId: m.id, topCardId: top(m) }, lookedAt: [...p[a.from]] }));
    } else {
      const eligible = a.op === 'evolvePokemon' && a.from === 'deck' ? pool :
        pool.filter((m) => transitionCards(ctx, a, m).length > 0);
      if (!eligible.length) { finishEffect(s, catalog, d, false); return; }
      ask(s, { player: owner, kind: 'transition-target', options: eligible.map((m) => m.id),
        resume: 'effect-choice', data: d, ruleId: a.op === 'evolvePokemon' ? 'effects.evolve' : 'effects.inherit' });
    }
    return;
  }
  if (a.op === 'devolvePokemon') {
    const ctx = effectContext(s, catalog, source, d.event ?? null);
    const targetOwner = a.side === 'own' ? owner : 1 - owner, p = s.players[targetOwner];
    const pool = transitionTargets(ctx, a).filter((m) => devolutionDepth(ctx, m) > 0).map((m) => findMon(s, m.id).m);
    if (d.stage === 'devolution-apply') {
      const changes = d.devolutionPlan.map((entry) => {
        const m = pool.find((m) => m.id === entry.pokemonId);
        if (!m || top(m) !== entry.topCardId) throw new EngineError('invalid-pokemon-transition', 'Devolution top card changed.');
        return { m, count: entry.count, blocked: entry.count > 0 && effectBlocked(s, catalog, source, targetOwner, m),
          wasLethal: m.counters * 10 >= hp(s, catalog, targetOwner, m) };
      });
      let performed = false;
      for (const { m, count, blocked } of changes) if (count > 0 && !blocked) {
        const removed = m.stack.splice(-count).reverse();
        p[a.to === 'deckShuffle' ? 'deck' : a.to].push(...removed);
        m.conditions = emptyConditions(); m.enteredTurn = s.turn; m.evolvedTurn = 0; delete m.facts.evolution;
        retainOngoing(s, (e) => e.targetId !== m.id, 'devolution',
          { owner: targetOwner, pokemonId: m.id, fromCardId: removed[0], toCardId: top(m) });
        log(s, 'effects.devolve', { pokemonId: m.id, removed, revealed: top(m), to: a.to, sourceOfTruth: source.sourceOfTruth });
        performed = true;
      }
      enforceEnergyRetention(s, catalog);
      for (const { m, count, blocked, wasLethal } of changes) if (count > 0 && !blocked)
        recordTransitionKO(s, catalog, targetOwner, m, wasLethal, source);
      const shuffled = a.to === 'deckShuffle' && shuffleZone(s, targetOwner, 'deck', source);
      finishEffect(s, catalog, d, performed || shuffled);
    } else if (d.stage === 'devolution-count') {
      const plan = clone(d.devolutionPlan), entry = plan.find((p) => p.count === null);
      const m = pool.find((m) => m.id === entry.pokemonId), depth = devolutionDepth(ctx, m);
      const bounds = selectionBounds({ ...a.layers, available: depth });
      if (d.selected) {
        const count = Number(d.selected[0]);
        if (!canSelectCount(bounds, count)) throw new EngineError('invalid-pokemon-transition', 'Invalid top-down devolution depth.');
        entry.count = count;
        prepend(s, tasks('effect-choice', { ...withoutSelection(d), devolutionPlan: plan,
          stage: plan.some((p) => p.count === null) ? 'devolution-count' : 'devolution-apply' }));
      } else ask(s, { player: a.chooser === 'holder' ? targetOwner : owner, kind: 'devolution-count',
        options: Array.from({ length: bounds.maximum - bounds.minimum + 1 }, (_, i) => String(bounds.minimum + i)),
        resume: 'effect-choice', data: d, ruleId: 'effects.devolve' });
    } else if (d.selected) {
      const bounds = selectionBounds({ ...a.selection, available: pool.length });
      if (!canSelectCount(bounds, d.selected.length) || d.selected.some((id) => !pool.some((m) => m.id === id)))
        throw new EngineError('invalid-pokemon-transition', 'Invalid devolution target selection.');
      const devolutionPlan = d.selected.map((id) => ({ pokemonId: id, topCardId: top(pool.find((m) => m.id === id)), count: null }));
      if (!devolutionPlan.length) { finishEffect(s, catalog, d, false); return; }
      prepend(s, tasks('effect-choice', { ...withoutSelection(d), devolutionPlan, stage: 'devolution-count' }));
    } else if (!pool.length) finishEffect(s, catalog, d, a.to === 'deckShuffle' && shuffleZone(s, targetOwner, 'deck', source) || false);
    else {
      const bounds = selectionBounds({ ...a.selection, available: pool.length });
      if (a.selection.kind === 'all') prepend(s, tasks('effect-choice', { ...d, selected: pool.map((m) => m.id) }));
      else ask(s, { player: a.chooser === 'holder' ? targetOwner : owner, kind: 'devolution-target',
        options: pool.map((m) => m.id), ...bounds, resume: 'effect-choice', data: d, ruleId: 'effects.devolve' });
    }
    return;
  }
  if (['deployIncoming', 'attachIncoming'].includes(a.op)) {
    const entry = d.entry, p = s.players[owner];
    if (!entry || entry.player !== owner || entry.cardId !== source.instanceId ||
        !s.queue.some((t) => t.op === 'entry-finish' && t.data.entry.id === entry.id))
      throw new EngineError('invalid-acquisition', 'Incoming operations require their actual, still-open receipt.');
    if (!p.resolving.includes(entry.cardId)) { finishEffect(s, catalog, d, false); return; }
      if (a.op === 'deployIncoming') {
      if (cardDef(s, catalog, entry.cardId).kind !== 'pokemon') throw new EngineError('invalid-acquisition', 'Only a Pokémon may enter the Bench.');
      if (p.bench.length >= benchLimit(s, catalog, owner)) { finishEffect(s, catalog, d, false); return; }
      remove(p.resolving, entry.cardId);
      const m = newMon(s, entry.cardId); p.bench.push(m);
      log(s, 'trigger.before-hand', { entryId: entry.id, placed: entry.cardId, pokemonId: m.id });
      finishEffect(s, catalog, d, true);
      prepend(s, ...triggerWork(s, catalog, [makeTriggerEvent(s, catalog, 'bench', owner, m, {
        origin: entry.origin === 'draw' ? 'deck' : 'prizes', cardId: entry.cardId, cause: { kind: 'effect', source },
      })]));
    } else {
      if (cardDef(s, catalog, entry.cardId).kind !== 'energy') throw new EngineError('invalid-acquisition', 'Only Energy may use incoming attachment.');
      const pool = a.target === 'bench' ? p.bench : a.target === 'active' ? [p.active].filter(Boolean) : mons(p);
      if (!pool.length) { finishEffect(s, catalog, d, false); return; }
      if (!d.selected) ask(s, { player: owner, kind: 'incoming-energy-recipient', options: pool.map((m) => m.id),
        resume: 'effect-choice', data: d, ruleId: 'trigger.before-hand' });
      else {
        const m = pool.find((m) => m.id === d.selected[0]);
        if (!m) throw new EngineError('invalid-acquisition', 'Incoming Energy target no longer matches.');
        remove(p.resolving, entry.cardId); m.energy.push(entry.cardId);
        enforceEnergyRetention(s, catalog);
        log(s, 'trigger.before-hand', { entryId: entry.id, attached: entry.cardId, pokemonId: m.id });
        finishEffect(s, catalog, d, true);
        prepend(s, ...triggerWork(s, catalog, [makeTriggerEvent(s, catalog, 'energyAttached', owner, m, {
          origin: entry.origin === 'draw' ? 'deck' : 'prizes', cardId: entry.cardId, cause: { kind: 'effect', source },
        })]));
      }
    }
    return;
  }
  if (a.op === 'shuffle') {
    finishEffect(s, catalog, d, shuffleZone(s, a.side === 'own' ? owner : 1 - owner, a.zone, source)); return;
  }
  if (a.op === 'discardDeckTop') {
    // II.C-01: into the deck holder's discard pile; II.A: fewer cards, as many as possible.
    const holder = a.side === 'own' ? owner : 1 - owner, deck = s.players[holder].deck;
    const ids = deck.splice(Math.max(0, deck.length - a.count)).reverse();
    for (const id of ids) discard(s, catalog, id);
    log(s, 'effects.deck-top-discard', { player: holder, cards: ids.map((id) => clone(s.cards[id])), effectId: source.effectId,
      sourceOfTruth: source.sourceOfTruth });
    finishEffect(s, catalog, d, ids.length > 0); return;
  }
  if (a.op === 'replacePokemon') {
    const p = s.players[owner], found = findMon(s, source.pokemonId);
    if (!found || found.owner !== owner || !p.deck.length) { finishEffect(s, catalog, d, false); return; }
    const pool = p.deck.filter((id) => matchesCardSelector(cardDef(s, catalog, id), a.selector));
    const bounds = selectionBounds({ kind: 'exact', count: 1, available: pool.length, zone: 'deck', filter: 'specific' });
    if (!d.stage) {
      if (pool.length) ask(s, { player: owner, kind: 'select-cards', options: pool, ...bounds, resume: 'effect-choice',
        data: { ...d, stage: 'replace-select', lookedAt: [...p.deck] }, ruleId: 'effects.replace' });
      else ask(s, { player: owner, kind: 'view-cards', options: ['confirm'], resume: 'effect-choice',
        data: { ...d, stage: 'replace-empty', lookedAt: [...p.deck] }, ruleId: 'effects.replace' });
      return;
    }
    const selected = d.stage === 'replace-empty' ? [] : d.selected;
    if (canonicalJSON(d.lookedAt) !== canonicalJSON(p.deck) || !canSelectCount(bounds, selected.length) ||
        selected.some((id) => !pool.includes(id)))
      throw new EngineError('invalid-pokemon-replacement', 'The replacement must be one matching card of the unchanged searched deck.');
    let performed = false;
    if (selected.length) {
      // II.E-12 / II.C-13: a new Pokémon in the same spot; nothing carries over and this is not a Knock Out (I.D).
      const m = found.m, cards = [...m.stack, ...m.energy, ...m.tools];
      remove(p.deck, selected[0]);
      for (const id of cards) discard(s, catalog, id);
      const fresh = newMon(s, selected[0]);
      if (p.active === m) p.active = fresh; else p.bench[p.bench.indexOf(m)] = fresh;
      retireTarget(s, m.id, 'leave');
      log(s, 'effects.replace', { player: owner, pokemonId: m.id, discarded: cards, placed: clone(s.cards[selected[0]]),
        newPokemonId: fresh.id, position: p.active === fresh ? 'active' : 'bench', effectId: source.effectId,
        sourceOfTruth: source.sourceOfTruth });
      performed = true;
    }
    finishEffect(s, catalog, d, shuffleZone(s, owner, 'deck', source) || performed); return;
  }
  if (a.op === 'shuffleHandIntoDeck') {
    // E-36: the whole hand joins its owner's deck, then that whole deck is
    // shuffled. An empty hand still shuffles a nonempty deck (Supporter FAQ).
    let performed = false;
    for (const holder of a.side === 'both' ? [owner, 1 - owner] : [a.side === 'own' ? owner : 1 - owner]) {
      const p = s.players[holder], returned = p.hand.splice(0);
      p.deck.push(...returned);
      log(s, 'effects.hand-deck', { player: holder, count: returned.length, effectId: source.effectId });
      performed = shuffleZone(s, holder, 'deck', source) || performed;
    }
    finishEffect(s, catalog, d, performed); return;
  }
  if (a.op === 'shuffleHandToBottom') {
    const plan = planHandBottom(effectContext(s, catalog, source), a);
    for (const window of plan.windows) if (window.hand.length) {
      const p = s.players[window.owner], shuffled = shuffleIds(s.rng, [...window.hand]);
      p.hand = []; p.deck = [...shuffled, ...window.deck];
      log(s, 'effects.hand-bottom', { player: window.owner, count: window.hand.length, effectId: source.effectId });
      log(s, 'effects.shuffle', { player: window.owner, zone: 'hand', count: window.hand.length,
        placement: 'deck-bottom', effectId: source.effectId });
    }
    finishEffect(s, catalog, d, plan.performed); return;
  }
  if (a.op === 'exchangePrizes') {
    assertPrizeChoice(s, catalog, d);
    const ctx = effectContext(s, catalog, source), p = s.players[owner];
    if (!d.prizeChoice) {
      const window = prizeExchangeWindow(ctx, a), choice = { id: `prize${++s.serial}`, turn: s.turn,
        sourceId: source.instanceId, prizes: [...window.window], completion: prizeCompletion(s, source) };
      log(s, 'effects.prize-exchange', { kind: 'requested', id: choice.id, source, action: a, choice }, 'private');
      ask(s, { player: owner, kind: 'prize-exchange', options: window.eligible, ...window.bounds,
        forcePrompt: true, resume: 'effect-choice', data: { ...d, prizeChoice: choice }, ruleId: 'effects.prize-exchange' });
      return;
    }
    const plan = planPrizeExchange(ctx, a, d.selected), selected = plan.selected;
    if (selected.length && acquisitionUnits(s, catalog, {
      id: 'prospective-prize-exchange', player: owner, cardId: selected[0], origin: 'prizes', reason: null,
      turn: s.turn, during: s.current, cause: source,
    }).length)
      throw new EngineError('unresolved-prize-before-hand', 'A CN ruling is still required for self-exchange interacting with before-hand Prize acquisition.');
    if (selected.length) {
      remove(p.resolving, source.instanceId); p.hand.push(selected[0]);
    }
    p.prizes = [...plan.prizesAfter];
    log(s, 'effects.prize-exchange', { kind: 'resolved', id: d.prizeChoice.id, player: owner,
      sourceId: source.instanceId, selected, completion: d.prizeChoice.completion }, 'private');
    log(s, 'effects.prize-exchange', { kind: 'finished', id: d.prizeChoice.id, player: owner, sourceId: source.instanceId,
      count: selected.length, ...(a.revealSelected ? { revealed: selected.map((id) => clone(s.cards[id])) } : {}) });
    const shuffled = shuffleZone(s, owner, 'prizes', source);
    finishEffect(s, catalog, d, plan.window.length > 0 || selected.length > 0 || shuffled); return;
  }
  if (deckOperation(a)) {
    assertDeckChoice(s, catalog, d);
    if (!d.deckChoice) {
      const next = { ...d, deckChoice: beginDeckChoice(s, catalog, d),
        stage: a.op === 'inspectDeck' ? 'inspect-select' : 'deck-energy-select' };
      ask(s, { player: owner, kind: 'inspect-deck', ...deckChoicePrompt(s, catalog, next),
        forcePrompt: true, resume: 'effect-choice', data: next, ruleId: 'effects.search' });
      return;
    }
    const ctx = effectContext(s, catalog, source, d.event ?? null), p = s.players[owner], c = d.deckChoice;
    if (a.op === 'inspectDeck') {
      const plan = planDeckInspection(ctx, a, d.selected);
      const shuffled = shuffleIds(s.rng, [...plan.remainder]);
      const uninspected = p.deck.slice(0, p.deck.length - plan.window.length);
      p.deck = [...shuffled].reverse().concat(uninspected);
      p.hand.push(...plan.selected);
      log(s, 'effects.search', { kind: 'resolved', id: c.id, player: owner,
        count: plan.selected.length, effectId: source.effectId,
        ...(a.revealSelected ? { revealed: plan.selected.map((id) => clone(s.cards[id])) } : {}) });
      if (!a.revealSelected) log(s, 'effects.search', { kind: 'selected', id: c.id, selected: plan.selected }, owner);
      // The owner knew the original window, but neither player may learn the
      // subset's new order. Do not record the resulting permutation in events.
      const didShuffle = deckInspectionNeedsShuffle(plan);
      if (didShuffle) log(s, 'effects.shuffle', { player: owner, zone: 'deck', subset: 'looked-remainder',
        count: plan.remainder.length, placement: 'bottom', effectId: source.effectId });
      finishEffect(s, catalog, d, plan.selected.length > 0 || didShuffle); return;
    }
    if (d.stage === 'deck-energy-select') {
      const w = deckWindow(s, catalog, d);
      if (!canSelectCount(w.bounds, d.selected.length) || d.selected.some((id) => !w.eligible.includes(id)))
        throw new EngineError('invalid-deck-choice', 'Energy selection must match the inspected window and CN physical-card bounds.');
      log(s, 'effects.search', { kind: 'selected', id: c.id, selected: d.selected }, owner);
      if (d.selected.length) {
        const next = { ...withoutSelection(d), stage: 'deck-energy-destination',
          deckChoice: { ...c, chosen: [...d.selected] } };
        ask(s, { player: owner, kind: 'deck-energy-recipient', ...deckChoicePrompt(s, catalog, next),
          resume: 'effect-choice', data: next, ruleId: 'effects.attach' }); return;
      }
    }
    const chosen = d.stage === 'deck-energy-select' ? [] : c.chosen;
    let assignments = [...c.assignments];
    if (chosen.length) {
      const targetId = d.selected[0], eligible = deckEnergyDestinations(ctx, a, chosen, assignments);
      if (!eligible.includes(targetId)) throw new EngineError('invalid-deck-choice', 'The direct Energy recipient must still match the own in-play predicate.');
      const added = a.distribution === 'singleRecipient' ? chosen.map((instanceId) => ({ instanceId, targetId })) :
        [{ instanceId: chosen[assignments.length], targetId }];
      assignments.push(...added);
      log(s, 'effects.attach', { kind: 'allocated', id: c.id, assignments: added }, owner);
      if (assignments.length < chosen.length) {
        const next = { ...withoutSelection(d), deckChoice: { ...c, assignments } };
        ask(s, { player: owner, kind: 'deck-energy-recipient', ...deckChoicePrompt(s, catalog, next),
          resume: 'effect-choice', data: next, ruleId: 'effects.attach' }); return;
      }
    }
    const plan = validateDeckEnergyPlan(ctx, a, chosen, assignments);
    const toHand = plan.assignments.filter((x) => x.targetId === DECK_ENERGY_HAND).map((x) => x.instanceId);
    const changes = plan.assignments.filter((x) => x.targetId !== DECK_ENERGY_HAND).map((assignment) => {
      const target = findMon(s, assignment.targetId);
      return { ...assignment, target, blocked: effectBlocked(s, catalog, source, owner, target.m) };
    });
    let applied = 0;
    for (const id of toHand) {
      remove(p.deck, id); p.hand.push(id); applied++;
      log(s, 'effects.search', { kind: 'to-hand', id: c.id, player: owner, card: clone(s.cards[id]), effectId: source.effectId },
        a.reveal ? 'public' : owner);
    }
    // Commit the allocation as one batch. All required destinations have been
    // chosen before a trigger can alter any Pokémon or deck card.
    for (const { instanceId, targetId, target, blocked } of changes) {
      if (blocked) continue;
      remove(p.deck, instanceId); target.m.energy.push(instanceId); applied++;
      log(s, 'effects.attach', { player: owner, energyId: instanceId, pokemonId: targetId,
        from: 'deck', effectId: source.effectId, sourceOfTruth: source.sourceOfTruth });
    }
    enforceEnergyRetention(s, catalog);
    const events = changes.filter((c) => !c.blocked).map(({ instanceId, target }) =>
      makeTriggerEvent(s, catalog, 'energyAttached', owner, target.m, {
        origin: 'deck', cardId: instanceId, cause: { kind: 'effect', source },
      }));
    if (a.reveal) log(s, 'effects.search', { kind: 'revealed', id: c.id,
      revealed: chosen.map((id) => clone(s.cards[id])), effectId: source.effectId });
    const didShuffle = shuffleZone(s, owner, 'deck', source);
    finishEffect(s, catalog, d, applied > 0 || didShuffle);
    prepend(s, ...triggerWork(s, catalog, events)); return;
  }
  if (a.op === 'cards') {
    const p = s.players[owner];
    if (d.stage === 'cards-move' && ['deckTop', 'deckBottom'].includes(a.to)) {
      // The rest of a searched deck is shuffled first; the chosen cards then go on the printed end, the first chosen uppermost.
      const shuffled = a.shuffleAfter && shuffleZone(s, owner, 'deck', source), placed = [...d.chosen].reverse();
      for (const id of d.chosen) remove(p.resolving, id);
      p.deck = a.to === 'deckTop' ? [...p.deck, ...placed] : [...placed, ...p.deck];
      log(s, 'effects.deck-order', { player: owner, from: a.from, to: a.to, count: d.chosen.length, effectId: source.effectId });
      recordEffectCards(s, catalog, d, d.chosen);
      finishEffect(s, catalog, d, d.chosen.length > 0 || shuffled); return;
    }
    if (d.stage === 'cards-move') {
      if (d.index < d.chosen.length && a.to === 'bench' && p.bench.length >= benchLimit(s, catalog, owner)) {
        // Earlier entry effects may fill the remaining spaces. Return reserved,
        // unplaced cards instead of losing them or silently exceeding the Bench.
        for (const id of d.chosen.slice(d.index)) { remove(p.resolving, id); p[a.from].push(id); }
        prepend(s, tasks('effect-choice', { ...d, index: d.chosen.length })); return;
      }
      if (d.index >= d.chosen.length) {
        recordEffectCards(s, catalog, d, d.chosen);
        const shuffled = a.shuffleAfter && shuffleZone(s, owner, 'deck', source);
        finishEffect(s, catalog, d, d.performed || shuffled); return;
      }
      const id = d.chosen[d.index]; remove(p.resolving, id);
      const next = tasks('effect-choice', { ...d, index: d.index + 1, performed: true });
      if (a.to === 'bench') {
        const m = newMon(s, id); p.bench.push(m);
        log(s, 'effects.deploy', { player: owner, from: a.from, to: a.to, cardId: id, pokemonId: m.id, effectId: source.effectId });
        prepend(s, ...triggerWork(s, catalog, [makeTriggerEvent(s, catalog, 'bench', owner, m, {
          origin: a.from, cardId: id, cause: { kind: 'effect', source },
        })]), next);
      } else {
        if (a.to === 'discard') discard(s, catalog, id); else p[a.to].push(id);
        prepend(s, next);
      }
      return;
    }
    // C-11: a full Bench prevents looking through the deck at all.
    const limit = a.to === 'bench' ? benchLimit(s, catalog, owner) : null;
    if (a.to === 'bench' && p.bench.length >= limit) {
      log(s, 'effects.deploy', { player: owner, skipped: 'bench-full', effectId: source.effectId });
      finishEffect(s, catalog, d, false); return;
    }
    const paid = a.excludePaid ? (d.payment?.groups ?? []).flatMap((g) => g.cardIds) : [];
    const window = cardWindow(s, a, source), pool = window.filter((id) => !paid.includes(id) &&
      matchesCardSelector(cardDef(s, catalog, id), a.selector));
    const available = a.to === 'bench' ? Math.min(pool.length, limit - p.bench.length) : pool.length;
    const bounds = selectionBounds({ ...a.quantity, available,
      zone: a.from === 'deck' ? 'deck' : a.from === 'hand' ? 'ownHand' : 'public', filter: selectorQuantityClass(a.selector) });
    if (d.selected) {
      const selected = d.stage === 'cards-empty' ? [] : d.selected;
      if (!canSelectCount(bounds, selected.length) || selected.some((id) => !pool.includes(id)) ||
          a.onePerAlternative && !matchesOnePerAlternative(selected.map((id) => cardDef(s, catalog, id)), a.selector))
        throw new EngineError('invalid-card-selection', 'Selected cards do not match the reviewed source, predicate or quantity.');
      for (const id of selected) { remove(p[a.from], id); p.resolving.push(id); }
      const ruleId = a.to === 'bench' ? 'effects.deploy' : a.from === 'deck' ? 'effects.search' : a.to === 'discard' ? 'effects.discard' : 'effects.return';
      log(s, ruleId, { player: owner, from: a.from, to: a.to, count: selected.length, effectId: source.effectId,
        ...(a.reveal ? { revealed: selected.map((id) => clone(s.cards[id])) } : {}) });
      if (!a.reveal && selected.length) log(s, ruleId, { effectId: source.effectId, selected: [...selected] }, owner);
      prepend(s, tasks('effect-choice', { ...withoutSelection(d), stage: 'cards-move', lookedAt: window,
        chosen: selected, index: 0, performed: selected.length > 0 }));
    } else if (a.from === 'deck' && window.length && !pool.length)
      ask(s, { player: owner, kind: 'view-cards', options: ['confirm'], resume: 'effect-choice',
        data: { ...d, stage: 'cards-empty', lookedAt: window }, ruleId: 'effects.search' });
    else if (pool.length) {
      const hidden = selectorQuantityClass(a.selector) === 'specific';
      const ruleId = a.from === 'deck' && hidden ? 'selection.hidden' : a.from === 'hand' && hidden ? 'selection.hand' :
        { exact: 'selection.exact', upTo: 'selection.up-to', any: 'selection.any', all: 'selection.all' }[a.quantity.kind];
      ask(s, { player: owner, kind: ['deckTop', 'deckBottom'].includes(a.to) && bounds.maximum > 1 ? 'order-cards' : 'select-cards',
        options: pool, ...bounds, resume: 'effect-choice', data: { ...d, stage: 'cards-select', lookedAt: window }, ruleId });
    } else {
      recordEffectCards(s, catalog, d, []);
      const shuffled = a.shuffleAfter && shuffleZone(s, owner, 'deck', source);
      finishEffect(s, catalog, d, shuffled);
    }
    return;
  }
  if (a.op === 'arrangeDeck') {
    // 「自己或者对手」: the user first picks whose deck.
    if (a.side === 'either' && d.deckOwner === undefined) {
      if (d.selected) { prepend(s, tasks('effect-choice', { ...withoutSelection(d), deckOwner: d.selected[0] === 'own' ? owner : 1 - owner })); return; }
      const sides = ['own', 'opponent'].filter((side) => s.players[side === 'own' ? owner : 1 - owner].deck.length);
      if (!sides.length) { finishEffect(s, catalog, d, false); return; }
      ask(s, { player: owner, kind: 'choose-deck', options: sides, resume: 'effect-choice', data: { ...d, stage: 'deck-side' }, ruleId: 'effects.deck-order' });
      return;
    }
    const deckOwner = d.deckOwner ?? (a.side === 'opponent' ? 1 - owner : owner), p = s.players[deckOwner];
    const window = arrangeWindow(s, a, deckOwner), data = { ...withoutSelection(d), deckOwner, lookedAt: window };
    // 「再放回原处」 and a single card have one order: the user only confirms having looked.
    const order = (rest) => {
      if (a.to === 'same' || window.length === 1) ask(s, { player: owner, kind: 'view-cards', options: ['confirm'], resume: 'effect-choice',
        data: { ...rest, stage: 'arrange-order' }, ruleId: 'effects.deck-order' });
      else ask(s, { player: owner, kind: 'order-cards', options: [...window], minimum: window.length, maximum: window.length,
        resume: 'effect-choice', data: { ...rest, stage: 'arrange-order' }, ruleId: 'effects.deck-order' });
    };
    if (d.stage === 'arrange-choice' && d.selected[0] === 'arrange') { order(data); return; }
    if (d.stage === 'arrange-order' || d.stage === 'arrange-choice') {
      const placed = d.stage === 'arrange-choice' ? null : d.selected[0] === 'confirm' ? window : d.selected;
      if (placed && (placed.length !== window.length || placed.some((id) => !window.includes(id))))
        throw new EngineError('invalid-card-selection', 'The looked-at cards are put back in one complete order.');
      const rest = p.deck.filter((id) => !window.includes(id)), below = [...(placed ?? [])].reverse();
      if (placed && a.to !== 'same') p.deck = a.to === 'top' ? [...rest, ...below] : [...below, ...rest];
      else if (!placed && d.selected[0] === 'shuffle') shuffleZone(s, deckOwner, 'deck', source);
      else if (!placed) p.deck = [...shuffleIds(s.rng, [...window]), ...rest];
      log(s, 'effects.deck-order', { player: deckOwner, from: a.from, count: window.length, effectId: source.effectId,
        result: placed ? a.to : d.selected[0] });
      finishEffect(s, catalog, d, true); return;
    }
    if (!window.length) { finishEffect(s, catalog, d, false); return; }
    log(s, 'effects.deck-order', { player: deckOwner, from: a.from, looked: window.length, effectId: source.effectId });
    log(s, 'effects.deck-order', { effectId: source.effectId, cards: [...window] }, owner);
    if (a.otherwise) ask(s, { player: owner, kind: 'arrange-choice', options: ['arrange', a.otherwise], resume: 'effect-choice',
      data: { ...data, stage: 'arrange-choice' }, ruleId: 'effects.deck-order' });
    else order(data);
    return;
  }
  if (a.op === 'opponentHand') {
    const foe = 1 - owner, hand = [...s.players[foe].hand];
    if (d.stage === 'hand-view') { recordEffectCards(s, catalog, d, d.lookedAt); finishEffect(s, catalog, d, true); return; }
    const { pool, bounds } = opponentHandWindow(s, catalog, a, foe);
    if (d.stage === 'hand-select') {
      if (!canSelectCount(bounds, d.selected.length) || d.selected.some((id) => !pool.includes(id)))
        throw new EngineError('invalid-card-selection', 'Selected cards do not match the printed kind, quantity or the opponent\'s hand.');
      moveFromOpponentHand(s, catalog, d, foe, d.selected); return;
    }
    if (!hand.length) { recordEffectCards(s, catalog, d, []); finishEffect(s, catalog, d, false); return; }
    if (a.mode === 'faceDown') {
      // II.D-04 文例2: the user cannot tell the face-down cards apart.
      const picked = [], count = Math.min(a.quantity.count, hand.length);
      while (picked.length < count) picked.push(...hand.splice(randomIndex(s.rng, hand.length), 1));
      log(s, 'effects.opponent-hand', { effectId: source.effectId, picked: [...picked] }, owner);
      moveFromOpponentHand(s, catalog, d, foe, picked); return;
    }
    const data = { ...d, lookedAt: hand };
    if (a.mode === 'look') {
      log(s, 'effects.opponent-hand', { effectId: source.effectId, player: foe, looked: hand.length });
      log(s, 'effects.opponent-hand', { effectId: source.effectId, cards: [...hand] }, owner);
      if (!bounds?.maximum) {
        ask(s, { player: owner, kind: 'view-cards', options: ['confirm'], resume: 'effect-choice',
          data: { ...data, stage: 'hand-view' }, ruleId: 'effects.opponent-hand' });
        return;
      }
    } else if (!bounds.maximum) { finishEffect(s, catalog, d, false); return; }
    ask(s, { player: a.mode === 'look' ? owner : foe, kind: 'select-cards', options: pool, ...bounds, resume: 'effect-choice',
      data: { ...data, stage: 'hand-select' }, ruleId: 'effects.opponent-hand' });
    return;
  }
  if (a.op === 'discardTools') {
    // Holders protected from this effect offer no Tools to choose.
    const cards = toolCards(s, catalog, source, d.event ?? null, a)
      .filter((c) => !protections(s, catalog, source, c.owner, c.m, 'effects').length);
    if (!cards.length) { recordEffectCards(s, catalog, d, []); finishEffect(s, catalog, d, false); return; }
    const bounds = selectionBounds({ ...a.quantity, available: cards.length });
    if (a.quantity.kind !== 'all' && !d.selected) {
      ask(s, { player: owner, kind: 'select-cards', options: cards.map((c) => c.id), ...bounds, resume: 'effect-choice', data: d,
        ruleId: 'effects.tool-discard' });
      return;
    }
    const selected = a.quantity.kind === 'all' ? cards.map((c) => c.id) : d.selected;
    if (!canSelectCount(bounds, selected.length) || new Set(selected).size !== selected.length ||
        selected.some((id) => !cards.some((c) => c.id === id)))
      throw new EngineError('invalid-card-selection', 'Selected Tools do not match the printed holders, kind or quantity.');
    for (const id of selected) { remove(cards.find((c) => c.id === id).m.tools, id); discard(s, catalog, id); }
    log(s, 'effects.tool-discard', { effectId: source.effectId, cards: [...selected] });
    recordEffectCards(s, catalog, d, selected);
    finishEffect(s, catalog, d, selected.length > 0);
    return;
  }
  if (['discardEnergy', 'moveEnergy', 'returnEnergy'].includes(a.op)) {
    const ctx = effectContext(s, catalog, source, d.event ?? null, false, null, false, d.entry ?? null, d.payment ?? null);
    const pool = attachedEnergyPool(ctx, a);
    if (d.stage === 'energy-apply') {
      const plan = d.energyPlan, chosen = plan.chosen.map((c) => pool.find((p) => p.instanceId === c.instanceId && p.originId === c.originId));
      if (chosen.some((c) => !c)) throw new EngineError('invalid-energy-plan', 'Selected Energy no longer belongs to its original Pokémon.');
      const verdict = attachedEnergySelection(pool, a, chosen.map((c) => c.instanceId));
      if (!verdict.valid) throw new EngineError(verdict.unsupported ? 'unresolved-energy-quantity' : 'invalid-energy-plan', 'Invalid or unresolved Energy quantity.');
      const changes = chosen.map((c) => {
        const origin = findMon(s, c.originId), targetId = plan.assignments.find((x) => x.instanceId === c.instanceId)?.targetId;
        const target = a.op === 'moveEnergy' ? findMon(s, targetId) : null;
        if (a.op === 'moveEnergy' && (!target || target.owner !== c.owner || !energyRecipients(ctx, a, [c]).some((m) => m.id === targetId)))
          throw new EngineError('invalid-energy-plan', 'Energy must transfer to an eligible different Pokémon of its own holder.');
        const blocked = effectBlocked(s, catalog, source, c.owner, origin.m) ||
          !!target && effectBlocked(s, catalog, source, target.owner, target.m);
        return { c, origin, target, blocked };
      });
      // 「放回牌库上方」: the first chosen ends uppermost; 「下方」: the last chosen ends lowest.
      for (const { c, origin, target, blocked } of a.to === 'deckTop' ? [...changes].reverse() : changes) if (!blocked) {
        remove(origin.m.energy, c.instanceId);
        if (target) target.m.energy.push(c.instanceId);
        else if (a.op === 'returnEnergy' && a.to === 'deckBottom') s.players[c.owner].deck.unshift(c.instanceId);
        else if (a.op === 'returnEnergy') s.players[c.owner][a.to === 'hand' ? 'hand' : 'deck'].push(c.instanceId);
        else discard(s, catalog, c.instanceId);
      }
      enforceEnergyRetention(s, catalog);
      const events = [];
      for (const { c, origin, target, blocked } of changes) if (!blocked) {
        log(s, target ? 'energy.move' : a.op === 'returnEnergy' ? 'energy.return' : 'energy.attached-selection', { energyId: c.instanceId,
          from: origin.m.id, to: target?.m.id ?? (a.op === 'returnEnergy' ? a.to : null),
          discarded: a.op !== 'returnEnergy' && (!target || !target.m.energy.includes(c.instanceId)),
          effectId: source.effectId, sourceOfTruth: source.sourceOfTruth });
        if (target) events.push(makeTriggerEvent(s, catalog, 'energyMoved', target.owner, target.m, {
          origin: 'field', cardId: c.instanceId, cause: { kind: 'effect', source },
        }));
      }
      if (a.op === 'returnEnergy' && a.to === 'deckShuffle' && changes.some((c) => !c.blocked))
        shuffleZone(s, changes.find((c) => !c.blocked).c.owner, 'deck', source);
      recordEffectCards(s, catalog, d, changes.filter((c) => !c.blocked).map((c) => c.c.instanceId));
      finishEffect(s, catalog, d, changes.some((c) => !c.blocked));
      prepend(s, ...triggerWork(s, catalog, events)); return;
    }
    if (d.stage === 'energy-destination') {
      const plan = clone(d.energyPlan), next = plan.chosen[plan.assignments.length];
      const entries = a.distribution === 'singleRecipient' ? plan.chosen : [next];
      const targets = energyRecipients(ctx, a, entries);
      if (d.selected) {
        const targetId = d.selected[0];
        if (!targets.some((m) => m.id === targetId)) throw new EngineError('invalid-energy-plan', 'Ineligible Energy transfer recipient.');
        if (a.distribution === 'singleRecipient') plan.assignments = plan.chosen.map((c) => ({ instanceId: c.instanceId, targetId }));
        else plan.assignments.push({ instanceId: next.instanceId, targetId });
        prepend(s, tasks('effect-choice', { ...withoutSelection(d), energyPlan: plan,
          stage: plan.assignments.length === plan.chosen.length ? 'energy-apply' : 'energy-destination' }));
      } else ask(s, { player: a.chooser === 'holder' ? energyHolder(a, source) : owner, kind: 'energy-destination',
        options: targets.map((m) => m.id), resume: 'effect-choice', data: d, ruleId: 'energy.move' });
      return;
    }
    if (!pool.length) { recordEffectCards(s, catalog, d, []); finishEffect(s, catalog, d, false); return; }
    if (d.selected) {
      const verdict = attachedEnergySelection(pool, a, d.selected);
      if (!verdict.valid) throw new EngineError(verdict.unsupported ? 'unresolved-energy-quantity' : 'invalid-energy-selection',
        'Selected Energy must satisfy the stated card/unit quantity without an unsourced over-selection ruling.');
      if (!d.selected.length) { recordEffectCards(s, catalog, d, []); finishEffect(s, catalog, d, false); return; }
      const chosen = d.selected.map((id) => {
        const c = pool.find((c) => c.instanceId === id); return { instanceId: id, originId: c.originId };
      });
      if (a.op === 'moveEnergy' && a.distribution === 'singleRecipient' && !energyRecipients(ctx, a, chosen).length)
        throw new EngineError('invalid-energy-selection', 'These cards have no common eligible transfer recipient.');
      prepend(s, tasks('effect-choice', { ...withoutSelection(d), energyPlan: { chosen, assignments: [] },
        stage: a.op === 'moveEnergy' ? 'energy-destination' : 'energy-apply' }));
    } else {
      const available = pool.reduce((n, c) => n + c.amount, 0);
      const bounds = selectionBounds({ ...a.quantity, available });
      ask(s, { player: a.chooser === 'holder' ? energyHolder(a, source) : owner, kind: 'attached-energy',
        options: pool.map((c) => c.instanceId), minimum: a.quantity.kind === 'all' ? pool.length : a.measure === 'units' ? Math.min(1, bounds.minimum) : bounds.minimum,
        maximum: a.measure === 'units' ? pool.length : Math.min(pool.length, bounds.maximum), allowZero: bounds.allowZero,
        resume: 'effect-choice', data: d, ruleId: 'energy.attached-selection' });
    }
    return;
  }
  if (a.op === 'damage') {
    if (a.rolls !== undefined) {
      const binding = s.attack && executingAttack(s, catalog).effects.find((b) => b.effectId === source.effectId);
      if (!binding || !catalog.handler(binding.handlerId).capabilities?.includes('damage-rolls') ||
          canonicalJSON(a.rolls) !== canonicalJSON(binding.parameters.rolls ?? []))
        throw new EngineError('invalid-damage-coins', 'Damage actions cannot smuggle new coin declarations past the prepared binding.');
    }
    const targetOwner = a.side === 'own' ? owner : 1 - owner;
    let pool = mons(s.players[targetOwner]);
    if (a.target === 'active') pool = pool.filter((m) => m === s.players[targetOwner].active);
    if (a.target === 'bench') pool = s.players[targetOwner].bench;
    if (a.target === 'self') pool = pool.filter((m) => m.id === source.pokemonId);
    if (a.target === 'event') pool = pool.filter((m) => m.id === d.event?.subjectId);
    if (a.target === 'attacker') pool = pool.filter((m) => m.id === d.event?.cause.source?.pokemonId);
    // 「给身上放置有伤害指示物的…」「给对手所有的「宝可梦ex」」: printed filters read the board when targets are chosen.
    if (a.targetSelector || a.targetState) {
      const model = sourceModel(s, catalog);
      pool = pool.filter((m) => pokemonMatches(s, catalog, model, m, { selector: a.targetSelector, state: a.targetState }));
    }
    if (!pool.length) { finishEffect(s, catalog, d, false); return; }
    const bounds = selectionBounds({ ...a.selection, available: pool.length });
    if (d.selected) {
      const targets = d.selected.map((id) => {
        const m = pool.find((m) => m.id === id);
        if (!m) throw new EngineError('invalid-damage-target', 'A damage target no longer matches.');
        return { owner: targetOwner, m };
      });
      const model = typeof a.amount === 'number' ? null : sourceModel(s, catalog);
      const amounts = targets.map((target) => {
        const amount = typeof a.amount === 'number' ? a.amount :
          evaluateDamageValue(a.amount, s.attack?.damageModels?.find((m) => m.targetId === target.m.id)?.battleValues ??
            battleValueFacts(s, catalog, source, target, model));
        if (typeof a.amount !== 'number')
          log(s, 'damage.expression', { source: clone(source), targetId: target.m.id, expression: a.amount, amount });
        return amount;
      });
      finishEffect(s, catalog, d, dealAttackDamage(s, catalog, source, targets, amounts, a.options));
    } else if (a.selection.kind === 'all' || bounds.minimum === pool.length && bounds.maximum === pool.length)
      prepend(s, tasks('effect-choice', { ...d, selected: pool.map((m) => m.id) }));
    else ask(s, { player: owner, kind: 'damage-targets', options: pool.map((m) => m.id), ...bounds,
      resume: 'effect-choice', data: d, ruleId: 'attack.order' });
    return;
  }
  if (a.op === 'lastingPlayer') {
    const entry = createPlayerOngoingEffect({ id: `e${++s.serial}`, player: a.side === 'own' ? owner : 1 - owner,
      source, effect: a.effect, duration: a.duration }, s);
    s.playerOngoing.push(entry);
    log(s, entry.effect.op === 'modifier' ? entry.ruleId : 'effects.player-lock', { player: entry.player, effectId: entry.id,
      sourceOfTruth: source.sourceOfTruth });
    finishEffect(s, catalog, d, true); return;
  }
  if (['attachDiscard', 'attachHand'].includes(a.op)) {
    const p = s.players[owner];
    const zone = a.op === 'attachHand' ? 'hand' : 'discard', model = sourceModel(s, catalog);
    // Printed recipients: this Pokémon only, a tagged/typed predicate, and per-card distribution.
    let targets = (a.benchOnly ? p.bench : mons(p)).filter((m) => (a.target !== 'self' || m.id === source.pokemonId) &&
      (!a.recipient || matchesInPlaySelector(monDef(s, catalog, m), a.recipient, model.pokemon[m.id].types)));
    if (d.stage === 'target' && a.distribution === 'separateRecipients') targets = targets.filter((m) => !(d.chosen ?? []).includes(m.id));
    if (d.stage === 'target' && a.distribution === 'singleRecipient' && d.chosen?.length) targets = targets.filter((m) => m.id === d.chosen[0]);
    if (!targets.length) { finishEffect(s, catalog, d, d.performed ?? false); return; }
    if (d.stage === 'target') {
      const energy = d.energies[d.index];
      if (!energy) { finishEffect(s, catalog, d, d.performed ?? false); return; }
      if (d.selected) {
        const m = targets.find((m) => m.id === d.selected[0]);
        if (!m) throw new EngineError('invalid-target', 'Invalid Energy recipient.');
        remove(p[zone], energy); m.energy.push(energy);
        log(s, 'turn.energy', { player: owner, pokemonId: m.id, cardId: energy, byEffect: source.effectId });
        const event = makeTriggerEvent(s, catalog, 'energyAttached', owner, m,
          { origin: zone, cardId: energy, cause: { kind: 'effect', source } });
        const chosen = a.distribution && !(d.chosen ?? []).includes(m.id) ? { chosen: [...(d.chosen ?? []), m.id] } : {};
        prepend(s, ...triggerWork(s, catalog, [event]),
          tasks('effect-choice', { ...withoutSelection(d), ...chosen, index: d.index + 1, performed: true }));
      } else if (a.target === 'self' || a.distribution === 'singleRecipient' && d.chosen?.length)
        prepend(s, tasks('effect-choice', { ...d, selected: [targets[0].id] }));
      else ask(s, { player: owner, kind: 'energy-recipient', options: targets.map((m) => m.id), resume: 'effect-choice', data: d, ruleId: 'energy.units' });
    } else if (d.selected) {
      prepend(s, tasks('effect-choice', { ...withoutSelection(d), stage: 'target', energies: d.selected, index: 0 }));
    } else {
      const options = p[zone].filter((id) => {
        const def = cardDef(s, catalog, id);
        return def.kind === 'energy' && def.mechanics.category === 'basic' && (a.type === null || def.mechanics.baseUnits[0][0] === a.type);
      });
      if (!options.length) { finishEffect(s, catalog, d, false); return; }
      const bounds = selectionBounds({ kind: 'upTo', count: a.distribution === 'separateRecipients' ? Math.min(a.count, targets.length) : a.count,
        available: options.length, optional: a.optional, zone: zone === 'hand' ? 'ownHand' : 'public' });
      ask(s, { player: owner, kind: zone === 'hand' ? 'hand-energy' : 'discard-energy', options, ...bounds,
        resume: 'effect-choice', data: d, ruleId: zone === 'hand' ? 'selection.hand' : 'selection.up-to' });
    }
  } else if (a.op === 'transferCounters') {
    const targetOwner = a.side === 'own' ? owner : 1 - owner;
    const destinations = (originId) => mons(s.players[targetOwner]).filter((m) =>
      m.id !== originId && (a.target !== 'active' || m === s.players[targetOwner].active));
    const removeTransferred = (m, removed) => {
      m.counters -= removed;
      if (m.counters * 10 < hp(s, catalog, owner, m)) delete m.facts.knockoutCause;
      prepend(s, tasks('effect-choice', { ...withoutSelection(d), stage: 'transfer-target', originId: m.id, removed }));
    };
    if (d.stage === 'transfer-count') {
      // II.D-05 「最多N个」: any number from 1 to N of the origin's counters.
      const m = mons(s.players[owner]).find((m) => m.id === d.originId), counts = Array.from(
        { length: Math.min(a.count, m.counters) }, (_, i) => String(i + 1));
      // The answer is one of these options (checked against the saved request).
      if (!d.selected) ask(s, { player: owner, kind: 'counter-count', options: counts,
        resume: 'effect-choice', data: d, ruleId: 'damage.counters' });
      else removeTransferred(m, Number(d.selected[0]));
    } else if (d.stage === 'transfer-target') {
      const pool = destinations(d.originId);
      if (d.selected) {
        const m = pool.find((m) => m.id === d.selected[0]);
        if (!m) throw new EngineError('invalid-target', 'Invalid counter transfer destination.');
        if (!effectBlocked(s, catalog, source, targetOwner, m)) {
          addCounters(s, catalog, targetOwner, m, d.removed, { kind: 'effect', source });
        }
        // II.C-08: protection of the destination does NOT restore the removed counters.
        log(s, 'damage.counters', { effectId: source.effectId, from: d.originId, to: m.id, removed: d.removed });
        finishEffect(s, catalog, d, d.removed > 0);
      } else ask(s, { player: owner, kind: 'counter-destination', options: pool.map((m) => m.id),
        resume: 'effect-choice', data: d, ruleId: 'damage.counters' });
    } else {
      const pool = mons(s.players[owner]).filter((m) => m.counters > 0 &&
        (a.from !== 'self' || m.id === source.pokemonId) && destinations(m.id).length > 0);
      if (d.selected) {
        const m = pool.find((m) => m.id === d.selected[0]);
        if (!m) throw new EngineError('invalid-target', 'Invalid counter transfer origin.');
        if (effectBlocked(s, catalog, source, owner, m)) { finishEffect(s, catalog, d, false); return; }
        if (a.quantity === 'upTo' && Math.min(a.count, m.counters) > 1) {
          prepend(s, tasks('effect-choice', { ...withoutSelection(d), stage: 'transfer-count', originId: m.id })); return;
        }
        removeTransferred(m, Math.min(a.count, m.counters));
      } else if (pool.length) ask(s, { player: owner, kind: 'counter-origin', options: pool.map((m) => m.id),
        resume: 'effect-choice', data: d, ruleId: 'damage.counters' });
      else finishEffect(s, catalog, d, false);
    }
  } else if (a.op === 'draw') prepend(s, tasks('draw-cards', {
    player: a.player ?? owner, remaining: a.count, drawn: 0, reason: 'effect', source, completion: d,
  }));
  else if (a.op === 'discardHand') {
    const p = s.players[a.player ?? owner], discarded = p.hand.splice(0);
    for (const id of discarded) discard(s, catalog, id);
    log(s, 'effects.discard', { player: a.player ?? owner, effectId: source.effectId });
    finishEffect(s, catalog, d, discarded.length > 0);
  } else if (a.op === 'knockOut') {
    // I.D: confirmed with every other Knock Out at the end of this effect, not by HP. Another Pokémon protected
    // from this effect is not affected (II.C-17); 「选择…N只」 is the user's choice among the matching ones.
    const targetOwner = a.target === 'self' || a.side !== 'opponent' ? owner : 1 - owner, model = sourceModel(s, catalog);
    const pool = targetedPokemon(s, targetOwner, source, d.event ?? null, a.target).filter((m) => pokemonMatches(s, catalog, model, m, a));
    const count = Math.min(a.count ?? 1, pool.length);
    if (!d.selected && a.count && count) {
      ask(s, { player: owner, kind: 'effect-target', options: pool.map((m) => m.id), minimum: count, maximum: count,
        resume: 'effect-choice', data: d, ruleId: 'effects.knockout' });
      return;
    }
    const chosen = d.selected ? d.selected.map((id) => pool.find((m) => m.id === id)) : pool.slice(0, count);
    if (chosen.length !== count || chosen.some((m) => !m)) throw new EngineError('invalid-effect-target', 'Effect targets no longer match.');
    let performed = false;
    for (const m of chosen) if (a.target === 'self' || !effectBlocked(s, catalog, source, targetOwner, m)) {
      m.facts.forcedKnockout = { kind: 'effect', source: clone(source) }; performed = true;
      log(s, 'effects.knockout', { player: targetOwner, pokemonId: m.id, effectId: source.effectId });
    }
    finishEffect(s, catalog, d, performed);
  } else if (a.op === 'cure') {
    // I.F 「使用效果」: only the listed Special Conditions the target has; 「恢复N个」 lets the user choose which of them.
    const targetOwner = a.side === 'opponent' ? 1 - owner : owner;
    const m = targetedPokemon(s, targetOwner, source, d.event ?? null, a.target)[0];
    const present = m ? presentConditions(m.conditions, a.conditions) : [];
    if (d.stage !== 'cure-select' && (!present.length || effectBlocked(s, catalog, source, targetOwner, m))) { finishEffect(s, catalog, d, false); return; }
    if (d.stage !== 'cure-select' && a.count < present.length) {
      ask(s, { player: owner, kind: 'cure-conditions', options: present, minimum: a.count, maximum: a.count,
        resume: 'effect-choice', data: { ...d, stage: 'cure-select' }, ruleId: 'status.cure' });
      return;
    }
    const cured = d.stage === 'cure-select' ? d.selected : present;
    if (!cured.length || cured.length !== Math.min(a.count ?? present.length, present.length) || cured.some((c) => !present.includes(c)))
      throw new EngineError('invalid-effect-target', 'Only the chosen number of Special Conditions the Pokémon has are recovered.');
    m.conditions = cureConditions(m.conditions, cured);
    log(s, 'status.cure', { player: targetOwner, targetId: m.id, conditions: cured, effectId: source.effectId });
    finishEffect(s, catalog, d, true);
  } else if (a.op === 'counters' && a.targets) {
    const targetOwner = a.side === 'opponent' ? 1 - owner : owner;
    const pool = targetedPokemon(s, targetOwner, source, null, a.target), count = Math.min(a.targets, pool.length);
    if (!d.selected) {
      if (count) ask(s, { player: owner, kind: 'effect-target', options: pool.map((m) => m.id), minimum: count, maximum: count,
        resume: 'effect-choice', data: d, ruleId: 'damage.counters' });
      else finishEffect(s, catalog, d, false);
      return;
    }
    const chosen = d.selected.map((id) => pool.find((m) => m.id === id));
    if (chosen.length !== count || chosen.some((m) => !m)) throw new EngineError('invalid-effect-target', 'Effect targets no longer match.');
    let placed = false;
    for (const m of chosen) if (!effectBlocked(s, catalog, source, targetOwner, m)) {
      addCounters(s, catalog, targetOwner, m, a.count, { kind: 'effect', source }); placed = true;
      log(s, 'damage.counters', { targetId: m.id, effectId: source.effectId, sourceOfTruth: source.sourceOfTruth, operation: a.op });
    }
    finishEffect(s, catalog, d, placed);
  } else if (['counters', 'heal', 'condition', 'switch', 'lasting', 'delayedReaction'].includes(a.op)) {
    const targetOwner = a.side === 'opponent' ? 1 - owner : owner;
    let pool = targetedPokemon(s, targetOwner, source, d.event ?? null, a.op === 'switch' ? 'bench' : a.target);
    if (a.op === 'switch' && a.affected === 'source') pool = pool.filter((m) => m.id === source.pokemonId);
    if (a.op === 'switch' && (a.selector || a.state)) {
      const model = sourceModel(s, catalog);
      pool = pool.filter((m) => pokemonMatches(s, catalog, model, m, a));
    }
    if (a.op === 'condition') pool = pool.filter((m) => m === s.players[targetOwner].active);
    if (a.op === 'heal') pool = pool.filter((m) => m.counters > 0);
    if (a.op === 'switch' && !s.players[targetOwner].active) pool = [];
    if (d.selected) {
      const m = pool.find((m) => m.id === d.selected[0]);
      if (!m) throw new EngineError('invalid-effect-target', 'Effect target no longer matches.');
      const affected = a.op === 'switch' && a.affected === 'active' ? s.players[targetOwner].active : m;
      if (effectBlocked(s, catalog, source, targetOwner, affected)) { finishEffect(s, catalog, d, false); return; }
      if (a.op === 'counters') {
        addCounters(s, catalog, targetOwner, m, a.count, { kind: 'effect', source });
      }
      if (a.op === 'heal') {
        const before = m.counters;
        m.counters = Math.max(0, m.counters - a.count);
        m.facts.healedTurn = s.turn;
        battleFact(s, { kind: 'heal', owner: targetOwner, pokemonId: m.id, amount: (before - m.counters) * 10 });
        if (m.counters * 10 < hp(s, catalog, targetOwner, m)) delete m.facts.knockoutCause;
      }
      let conditionRule = 'status.exclusive';
      if (a.op === 'condition' && m === s.players[targetOwner].active) {
        const applied = applyCondition(m.conditions, a.condition, { ownerTurn: s.players[targetOwner].turns, poisonCounters: a.poisonCounters ?? 1 });
        m.conditions = applied.conditions; conditionRule = applied.trace.ruleId;
      }
      const incoming = a.op === 'switch' ? switchTo(s, targetOwner, m.id) : null;
      if (a.op === 'lasting' || a.op === 'delayedReaction') s.ongoing.push(createOngoingEffect({
        id: `e${++s.serial}`, targetId: m.id, source, effect: a.op === 'lasting' ? a.effect :
          { op: 'reaction', scope: 'all', trigger: a.trigger, program: a.program,
            priorEventIds: s.attack?.events.map((e) => e.id) ?? [] }, duration: a.duration,
        clearOnBench: a.clearOnBench, clearOnEvolution: a.clearOnEvolution,
      }, s));
      log(s, a.op === 'counters' ? 'damage.counters' : a.op === 'condition' ? conditionRule : a.op === 'heal' ? 'effects.heal' :
        ['lasting', 'delayedReaction'].includes(a.op) ? s.ongoing.at(-1).ruleId : 'effects.switch',
        { targetId: m.id, effectId: source.effectId, sourceOfTruth: source.sourceOfTruth, operation: a.op });
      finishEffect(s, catalog, d, true);
      if (incoming) prepend(s, ...becameActiveWork(s, catalog, targetOwner, incoming, { kind: 'effect', source }));
    } else if (pool.length) {
      if (['event', 'attacker'].includes(a.target) || a.op === 'switch' && a.affected === 'source') {
        prepend(s, tasks('effect-choice', { ...d, selected: [pool[0].id] })); return;
      }
      const chooser = a.chooser ? a.chooser === 'opponent' ? 1 - owner : owner : a.op === 'switch' ? targetOwner : owner;
      ask(s, { player: chooser, kind: 'effect-target', options: pool.map((m) => m.id),
        resume: 'effect-choice', data: d, ruleId: 'effects.partial' });
    } else finishEffect(s, catalog, d, false);
  } else throw new EngineError('unsupported-effect', `No silent fallback for effect: ${a.op}`);
}

function drain(s, catalog) {
  while (s.queue.length && !s.pending && s.phase !== 'over') {
    runTask(s, catalog, s.queue.shift());
    // A type source can appear/disappear between instructions (not only when
    // attaching/evolving). Settle retention before the next instruction/view.
    if (s.phase !== 'over') enforceEnergyRetention(s, catalog);
  }
}

function canEvolve(s, catalog, player, m, def) {
  return evolutionRelation(monDef(s, catalog, m), def, 'ordinary') &&
    s.players[player].turns > 1 && m.enteredTurn < s.turn && m.evolvedTurn < s.turn;
}
function permissions(s, catalog, player, attack, sourceId, grant = null) {
  const m = s.players[player].active, result = new Set();
  for (const binding of attack.effects) {
    const h = catalog.handler(binding.handlerId);
    if (h.permissions) for (const permission of h.permissions(effectContext(s, catalog,
      sourceFor(s, catalog, sourceId, player, 'attack', binding, m.id, attack.attackId, null, grantContext(grant))), clone(binding.parameters)))
      result.add(permission);
  }
  return result;
}
function attackLegal(s, catalog, player, attack, sourceId, grant = null) {
  const p = s.players[player];
  const allows = permissions(s, catalog, player, attack, sourceId, grant);
  return p.turns > 0 && (!(s.turn === 1 && s.first === player) || allows.has('first-turn-attack')) &&
    (!['asleep', 'paralyzed'].includes(p.active.conditions.rotation) || allows.has(`attack-while-${p.active.conditions.rotation}`)) &&
    !(attack.specialRule === 'GX' && p.gxUsed) && !(attack.specialRule === 'VSTAR' && p.vstarUsed) &&
    attackRequirements(s, catalog, player, p.active, attack, sourceId, grantContext(grant)).some((r) =>
      meetsEnergyRequirement(energyCards(s, catalog, p.active).flatMap((c) => c.units), r)) &&
    !monProhibited(s, catalog, player, p.active, 'attack', attack.attackId, { attack, sourceId, grant });
}
function attackAvailability(s, catalog, player, attack, sourceId, grant) {
  try { return { legal: attackLegal(s, catalog, player, attack, sourceId, grant), unresolved: false }; }
  catch (error) {
    if (error?.code !== 'unresolved-owned-attack-identity') throw error;
    return { legal: false, unresolved: true };
  }
}
function unresolvedAttacks(s, catalog, player) {
  if (s.phase !== 'main' || s.pending || s.result || s.current !== player || !s.players[player].active) return [];
  return attacksFor(s, catalog, s.players[player].active)
    .filter(({ attack, instanceId, grant }) => attackAvailability(s, catalog, player, attack, instanceId, grant).unresolved)
    .map(({ attack, referenceId }) => ({ type: 'attack', attackId: attack.attackId, referenceId,
      ruleId: 'attack.owned-lock', code: 'unresolved-owned-attack-identity' }));
}
function usageAllowed(s, player, m, usage) {
  if (!usage || usage.period === 'unlimited') return true;
  const tracker = usage.scope === 'player' ? s.players[player].used : m.used;
  const history = Object.hasOwn(tracker, usage.key) ? tracker[usage.key] : [];
  return (usage.period === 'turn' ? history.filter((t) => t === s.turn) : history).length < usage.limit;
}
function recordUsage(s, player, m, usage) {
  if (!usage || usage.period === 'unlimited') return;
  const tracker = usage.scope === 'player' ? s.players[player].used : m.used;
  if (!Object.hasOwn(tracker, usage.key)) tracker[usage.key] = [];
  tracker[usage.key].push(s.turn);
}

function actions(s, catalog, player) {
  if (s.phase !== 'main' || s.pending || s.queue.length || s.current !== player || s.result) return [];
  const p = s.players[player], out = [{ type: 'endTurn' }], model = sourceModel(s, catalog);
  for (const id of p.hand) {
    const d = cardDef(s, catalog, id);
    if (d.kind === 'pokemon') {
      if (d.mechanics.stage === 'basic' && p.bench.length < benchLimit(s, catalog, player)) out.push({ type: 'bench', cardId: id });
      for (const m of mons(p)) if (canEvolve(s, catalog, player, m, d)) out.push({ type: 'evolve', cardId: id, pokemonId: m.id });
    } else if (d.kind === 'energy' && !p.flags.energy) {
      for (const m of mons(p)) if (activationUsable(s, catalog, activationRequest('energy', player, id, { pokemonId: m.id })))
        out.push({ type: 'attachEnergy', cardId: id, pokemonId: m.id });
    } else if (d.kind === 'trainer') {
      const category = d.mechanics.category;
      const action = { item: 'playItem', supporter: 'playSupporter', tool: 'playTool', stadium: 'playStadium' }[category];
      if (playerProhibited(s, catalog, player, action)) continue;
      if (category === 'supporter' && (p.flags.supporter || s.turn === 1 && !firstTurnUse(catalog, d))) continue;
      if (category === 'stadium' && (p.flags.stadium || (s.stadium && cardDef(s, catalog, s.stadium).nameKey === d.nameKey))) continue;
      if (category === 'tool' && mons(p).every((m) => m.tools.length >= 1)) continue;
      const bindings = d.mechanics.effects.filter((b) => !b.trigger && (catalog.handler(b.handlerId).timing || 'resolve') === 'resolve');
      if (!['tool', 'stadium'].includes(category) && !bindings.length) continue;
      if (!activationUsable(s, catalog, activationRequest('trainer', player, id))) continue;
      out.push({ type: 'playTrainer', cardId: id });
    }
  }
  if (p.active) {
    const available = attacksFor(s, catalog, p.active, model);
    for (const { attack, instanceId, referenceId, grant } of available)
      if (attackAvailability(s, catalog, player, attack, instanceId, grant).legal) out.push({ type: 'attack', attackId: attack.attackId,
        ...(available.filter((a) => a.attack.attackId === attack.attackId).length > 1 ? { referenceId } : {}) });
    const cost = retreatCost(s, catalog, player, p.active);
    if (!p.flags.retreat && p.bench.length && !monProhibited(s, catalog, player, p.active, 'retreat') &&
        !['asleep', 'paralyzed'].includes(p.active.conditions.rotation) &&
        energyCards(s, catalog, p.active).reduce((n, c) => n + c.units.length, 0) >= cost) out.push({ type: 'retreat' });
    for (const m of mons(p)) for (const ability of monDef(s, catalog, m).mechanics.abilities) {
      if (ability.mode !== 'activated' || (ability.specialRule === 'VSTAR' && p.vstarUsed) ||
          !model.availability.get(sourceNodeId('ability', top(m), ability.abilityId)).enabled ||
          !usageAllowed(s, player, m, ability.usage)) continue;
      if (!activationUsable(s, catalog, activationRequest('ability', player, top(m), { pokemonId: m.id, abilityId: ability.abilityId }))) continue;
      out.push({ type: 'useAbility', pokemonId: m.id, abilityId: ability.abilityId });
    }
    if (s.stadium && !playerProhibited(s, catalog, player, 'useStadium')) {
      const bindings = cardDef(s, catalog, s.stadium).mechanics.effects.filter((b) => catalog.handler(b.handlerId).timing === 'onUse');
      if (bindings.length && activationUsable(s, catalog, activationRequest('stadium', player, s.stadium)))
        out.push({ type: 'useStadium' });
    }
  }
  return out;
}

function dispatch(s, command, catalog) {
  if (!validateGameCommand(command)) throw new EngineError('invalid-command', 'Command schema mismatch.', { errors: validateGameCommand.errors });
  if (command.expectedRevision !== s.revision) throw new EngineError('stale-command', 'A newer game revision exists.');
  if (s.result) throw new EngineError('game-over', 'The game has ended.');
  const { player, action: a } = command, p = s.players[player];
  if (a.type === 'concede') { finish(s, 1 - player, 'concede'); return; }
  if (s.pending) {
    const request = s.pending;
    if (request.kind === 'counter-allocation') {
      if (a.type !== 'allocateCounters' || request.id !== a.requestId || request.player !== player)
        throw new EngineError('wrong-choice', 'Only the allocation holder may answer this numeric request.');
      assertCounterDistributionAllocation(effectContext(s, catalog, request.data.source, request.data.event ?? null),
        request.data.action, a.allocations);
      s.pending = null;
      prepend(s, tasks(request.resume, { ...request.data, allocations: clone(a.allocations) }));
      drain(s, catalog); return;
    }
    if (a.type !== 'answer' || request.id !== a.requestId || request.player !== player)
      throw new EngineError('wrong-choice', 'This player/command cannot answer the current request.');
    if (!canSelectCount(request, a.selected.length) || a.selected.some((id) => !request.options.includes(id)))
      throw new EngineError('invalid-choice', 'Invalid selection or quantity.');
    if (request.resume === 'retreat-paid' && !validateRetreatPayment(
      energyCards(s, catalog, p.active), a.selected, retreatCost(s, catalog, player, p.active),
    )) fail(s, 'retreat.payment', 'Invalid Retreat payment.');
    if (request.kind === 'owned-attack') {
      const original = ownedAttackRequest(s, request.data.ownedAttackChoice.id);
      log(s, 'attack.owned-lock', { ...original, kind: 'answered',
        selected: a.selected.map((id) => original.choice.candidates.find((ref) => attackOptionId(ref) === id)) }, 'private');
    }
    s.pending = null;
    if (request.resume === 'choose-order') {
      s.first = a.selected[0] === 'first' ? player : 1 - player;
      log(s, 'setup.order', { chooser: player, first: s.first });
      prepend(s, tasks('deal'));
    } else prepend(s, tasks(request.resume, { ...request.data, selected: [...a.selected] }));
    drain(s, catalog); return;
  }
  const offered = actions(s, catalog, player);
  const explicitUnambiguousReference = a.type === 'attack' && a.referenceId &&
    offered.some((valid) => canonicalJSON(valid) === canonicalJSON({ type: 'attack', attackId: a.attackId })) &&
    attacksFor(s, catalog, p.active).some((r) => r.attack.attackId === a.attackId && r.referenceId === a.referenceId);
  if (!explicitUnambiguousReference && !offered.some((valid) => canonicalJSON(valid) === canonicalJSON(a))) {
    if (a.type === 'attack' && s.phase === 'main' && s.current === player && p.active)
      for (const route of attacksFor(s, catalog, p.active).filter((r) =>
        r.attack.attackId === a.attackId && (!a.referenceId || r.referenceId === a.referenceId)))
        if (attackAvailability(s, catalog, player, route.attack, route.instanceId, route.grant).unresolved)
          throw new EngineError('unresolved-owned-attack-identity', 'This direct-use attack needs the unresolved same-name identity ruling.');
    throw new EngineError('illegal-action', 'This action is not legal in the current state.');
  }
  if (a.type === 'bench') {
    remove(p.hand, a.cardId);
    const m = newMon(s, a.cardId); p.bench.push(m);
    log(s, 'turn.bench', { player, cardId: a.cardId });
    enqueue(s, ...triggerWork(s, catalog, [makeTriggerEvent(s, catalog, 'bench', player, m,
      { origin: 'hand', cardId: a.cardId })]), tasks('ko'));
  } else if (a.type === 'evolve') {
    const { m } = findMon(s, a.pokemonId);
    remove(p.hand, a.cardId);
    const event = evolveMon(s, catalog, player, m, a.cardId, 'hand');
    enqueue(s, ...triggerWork(s, catalog, [event]), tasks('ko'));
  } else if (a.type === 'attachEnergy') {
    beginActivation(s, catalog, activationRequest('energy', player, a.cardId, { pokemonId: a.pokemonId }));
  } else if (a.type === 'retreat') {
    s.phase = 'resolving';
    const cost = retreatCost(s, catalog, player, p.active);
    if (cost === 0) enqueue(s, tasks('finish-retreat', { player }));
    else ask(s, { player, kind: 'retreat-energy', options: p.active.energy, minimum: 1, maximum: p.active.energy.length,
      resume: 'retreat-paid', data: { player }, ruleId: 'retreat.payment' });
  } else if (a.type === 'attack') {
    const candidates = attacksFor(s, catalog, p.active).filter((r) => r.attack.attackId === a.attackId &&
      (!a.referenceId || r.referenceId === a.referenceId));
    if (candidates.length !== 1) throw new EngineError('ambiguous-attack', 'Granted/native attack identities must be unambiguous.');
    const record = candidates[0];
    const grant = record.grant ? { ...clone(record.grant), id: `grant${++s.serial}` } : null;
    s.phase = 'resolving'; enqueue(s, tasks('attack', { player, attackId: a.attackId,
      pokemonId: p.active.id, sourceId: record.instanceId, attack: clone(record.attack), grant }));
  } else if (a.type === 'endTurn') enqueue(s, tasks('end-turn', { player }));
  else if (a.type === 'useAbility') {
    const { m } = findMon(s, a.pokemonId);
    beginActivation(s, catalog, activationRequest('ability', player, top(m), { pokemonId: m.id, abilityId: a.abilityId }));
  } else if (a.type === 'useStadium') {
    beginActivation(s, catalog, activationRequest('stadium', player, s.stadium));
  } else if (a.type === 'playTrainer') {
    beginActivation(s, catalog, activationRequest('trainer', player, a.cardId));
  }
  if (s.phase === 'main' && !s.queue.length && !s.pending) enqueue(s, tasks('ko'));
  drain(s, catalog);
}

export function createGameState({
  ruleset, catalog, decks, seed, format = 'casual60', matchMode = format === 'tiebreak60' ? 'tiebreak' : 'normal',
}) {
  assertCatalog(catalog);
  const profile = getRuleset(ruleset);
  if (profile.id !== 'CN/V20261019' || profile !== catalog.ruleset)
    throw new EngineError('unsupported-ruleset', 'An explicit compatible ruleset and format are required.');
  assertMatchFormat(catalog, format, matchMode);
  if (!Array.isArray(decks) || decks.length !== 2) throw new EngineError('invalid-decks', 'Two decks are required.');
  decks.forEach((deck) => validateFormatDeck(catalog, deck, format, matchMode)); validateRandomState(seed);
  const state = {
    schemaVersion: '1.0.0', protocol: PROTOCOL, ruleset: clone(ruleset), catalogId: catalog.id,
    vacancies: [null, null], battleHistory: createBattleHistory(),
    format: clone(format), matchMode, revision: 0, phase: 'setup', turn: 0, current: null, first: null, nextPlayer: 0,
    rng: [...seed], serial: 0, cards: {}, players: [], stadium: null, pending: null, queue: [], events: [], result: null,
    setup: { mulligans: [0, 0], bonus: [0, 0], prizesPlaced: [false, false] }, ongoing: [], playerOngoing: [], attack: null,
  };
  state.players = decks.map((deck, owner) => {
    const ids = deck.map((printingId, i) => {
      const id = `p${owner}c${i}`;
      state.cards[id] = { instanceId: id, printingId, definitionId: catalog.definitionFor(printingId).definitionId, owner };
      return id;
    });
    shuffleIds(state.rng, ids);
    return { deck: ids, hand: [], prizes: [], discard: [], lost: [], resolving: [], active: null, bench: [],
      turns: 0, flags: flags(), gxUsed: false, vstarUsed: false, used: {} };
  });
  const winner = randomIndex(state.rng, 2);
  log(state, 'setup.order', { decisionWinner: winner });
  ask(state, { player: winner, kind: 'choose-order', options: ['first', 'second'], resume: 'choose-order', ruleId: 'setup.order' });
  sealSelectionRequest(state);
  return assertGameState(state, catalog);
}

export function reduceGame(state, command, catalog) {
  assertGameState(state, catalog);
  const next = copyState(state);
  dispatch(next, command, catalog);
  next.revision++;
  sealSelectionRequest(next);
  return assertGameState(next, catalog);
}

/** The returned projection intentionally omits RNG, deck/prize identities and work queues. */
export function playerView(state, catalog, viewer) {
  if (![0, 1].includes(viewer)) throw new TypeError('A player identity is required.');
  const model = sourceModel(state, catalog);
  const card = (id) => ({ instanceId: id, printingId: state.cards[id].printingId, definitionId: state.cards[id].definitionId });
  const mon = (m, owner) => {
    if (!m) return null;
    if (state.phase === 'setup' && owner !== viewer) return { faceDown: true };
    const maxHp = hp(state, catalog, owner, m), damage = m.counters * 10;
    return {
      id: m.id, stack: m.stack.map(card), energy: m.energy.map(card), tools: m.tools.map(card),
      counters: m.counters, conditions: clone(m.conditions),
      effective: {
        maxHp,
        currentHp: damage >= maxHp ? 0 : maxHp - damage,
        retreatCost: retreatCost(state, catalog, owner, m),
        weakness: clone(effectiveProperty(state, catalog, owner, m, 'weakness')),
        resistance: clone(effectiveProperty(state, catalog, owner, m, 'resistance')),
        ...clone(model.pokemon[m.id]),
        attackRequirements: attacksFor(state, catalog, m, model).map(({ attack, instanceId, referenceId, grant }) => ({
          attackId: attack.attackId, sourceId: instanceId, referenceId,
          ...(grant ? { contentSource: clone(grant.reference), permissionSource: {
            instanceId: grant.provider.source.instanceId, effectId: grant.provider.source.effectId,
          } } : {}),
          routes: attackRequirements(state, catalog, owner, m, attack, instanceId, grantContext(grant)),
        })),
      },
    };
  };
  const request = state.pending?.player === viewer ? state.pending : null;
  const attackPayment = request?.resume === 'attack-payment' ? executingAttack(state, catalog).failureCheck.handPayment : null;
  const costInfo = request?.resume === 'activation-choice' ? activationInfo(state, catalog, request.data.activation) : null;
  const triggerChoice = (u) => ({ id: u.id, abilityId: u.abilityId, event: u.event.kind,
    sourceId: (u.reaction?.source ?? u.bindings[0].source).instanceId, sourceCategory: (u.reaction?.source ?? u.bindings[0].source).category,
    subjectId: u.event.subjectId, optional: u.trigger.optional });
  const triggerChoices = !request ? [] : request.resume === 'trigger-window' ?
    request.data.units.filter((u) => request.options.includes(u.id)).map(triggerChoice) :
    request.resume === 'trigger-execute' ? [triggerChoice(request.data.unit)] :
    request.resume === 'checkup-plan' ? [triggerChoice(request.data.units[0])] : [];
  const unresolved = unresolvedAttacks(state, catalog, viewer);
  return deepFreeze({
    ruleset: clone(state.ruleset), format: clone(state.format), matchMode: state.matchMode,
    formatRule: formatTrace(catalog, state.format, state.matchMode),
    revision: state.revision, phase: state.phase, turn: state.turn,
    current: state.current, first: state.first, result: clone(state.result),
    stadium: state.stadium ? { ...card(state.stadium), owner: state.cards[state.stadium].owner } : null,
    ongoing: state.ongoing.map((entry) => ({
      id: entry.id, targetId: entry.targetId,
      effect: entry.effect.op === 'reaction' ? { op: 'reaction', trigger: clone(entry.effect.trigger) } : clone(entry.effect),
      duration: entry.duration,
      deadline: clone(entry.deadline), active: ongoingIsActive(entry, state),
      rule: ruleTrace(catalog.ruleset, entry.ruleId),
      source: { instanceId: entry.source.instanceId, owner: entry.source.owner, category: entry.source.category,
        cardOwner: entry.source.cardOwner ?? entry.source.owner,
        pokemonId: entry.source.pokemonId, attackId: entry.source.attackId, effectId: entry.source.effectId },
    })),
    playerOngoing: state.playerOngoing.map((entry) => ({
      id: entry.id, player: entry.player, effect: clone(entry.effect), duration: entry.duration,
      deadline: clone(entry.deadline), active: ongoingIsActive(entry, state),
      rule: ruleTrace(catalog.ruleset, entry.effect.op === 'modifier' ? entry.ruleId : 'effects.player-lock'),
    })),
    players: state.players.map((p, owner) => ({
      deckCount: p.deck.length, hand: owner === viewer ? p.hand.map(card) : { count: p.hand.length },
      prizes: { count: p.prizes.length }, discard: p.discard.map(card), lost: p.lost.map(card),
      active: mon(p.active, owner), bench: p.bench.map((m) => mon(m, owner)), benchLimit: benchLimit(state, catalog, owner, model),
      turns: p.turns, gxUsed: p.gxUsed, vstarUsed: p.vstarUsed,
    })),
    pending: request ? { id: request.id, kind: request.kind, options: [...request.options],
      minimum: request.minimum, maximum: request.maximum, allowZero: request.allowZero,
      triggers: triggerChoices,
      // The public card effect that asked; never its private work data.
      ...(request.resume === 'effect-choice' ? { effect: { sourceId: request.data.source.instanceId,
        effectId: request.data.source.effectId, category: request.data.source.category, op: request.data.action.op } } : {}),
      ...(request.kind === 'counter-allocation' ? { counterAllocation: {
        total: request.data.action.count, targets: clone(request.data.counterChoice.targets),
      } } : {}),
      ...(attackPayment ? { allowedCounts: request.maximum ? [0, attackPayment.count] : [0],
        handPayment: { requiredCount: attackPayment.count, eligible: request.data.eligible.map(card),
          rule: ruleTrace(catalog.ruleset, 'attack.failure.hand-payment') } } : {}),
      ...(costInfo ? { payment: {
        source: card(request.data.activation.sourceId),
        groups: costInfo.costs.map((cost) => ({
          costId: cost.costId, count: cost.count, selector: clone(cost.selector),
          choices: paymentCards(state, catalog, request.data.activation)
            .filter((c) => matchesCardSelector(c.definition, cost.selector))
            .map((c) => ({ optionId: paymentOptionId(cost.costId, c.instanceId), card: card(c.instanceId) })),
        })),
      } } : {}),
      ...(request.data.entry ? { acquisition: {
        card: card(request.data.entry.cardId), origin: request.data.entry.origin, reason: request.data.entry.reason,
      } } : {}),
      ...(request.data.deckChoice ? {
        cards: request.options.filter((id) => Object.hasOwn(state.cards, id)).map(card),
        lookedAt: request.data.deckChoice.window.map(card),
        selected: request.data.deckChoice.chosen.map(card),
        assignments: clone(request.data.deckChoice.assignments),
      } : {}),
      ...(request.data.prizeChoice ? {
        cards: request.options.map(card), lookedAt: request.data.prizeChoice.prizes.map(card),
      } : {}),
      ...(['cards', 'evolvePokemon', 'inheritPokemon', 'replacePokemon', 'opponentHand', 'arrangeDeck'].includes(request.data.action?.op) && request.data.lookedAt ? {
        cards: request.options.filter((id) => Object.hasOwn(state.cards, id)).map(card),
        lookedAt: (request.data.action.op === 'cards' && request.data.action.from === 'deck' && request.data.action.lookTop !== null ?
          [...request.data.lookedAt].reverse() : request.data.action.op === 'arrangeDeck' ? [...request.data.lookedAt] :
            [...request.data.lookedAt].sort()).map(card),
      } : {}),
      ...(['discardEnergy', 'moveEnergy', 'returnEnergy'].includes(request.data.action?.op) ? {
        energy: attachedEnergyPool(effectContext(state, catalog, request.data.source, request.data.event ?? null), request.data.action)
          .map((e) => ({ card: card(e.instanceId), originId: e.originId, units: clone(e.units), amount: e.amount })),
      } : {}),
      ...(request.data.copyChoice || request.data.ownedAttackChoice ? { attacks:
        (request.data.copyChoice ?? request.data.ownedAttackChoice).candidates.map((ref) => {
        const a = copiedAttack(state, catalog, ref);
        return { optionId: attackOptionId(ref), card: card(ref.instanceId), attackId: ref.attackId,
          name: a.name, cost: clone(a.cost), printedDamage: clone(a.printedDamage) };
      }) } : {}),
      rule: ruleTrace(catalog.ruleset, request.ruleId) } : null,
    events: state.events.filter((e) => (e.visibility === 'public' || e.visibility === viewer) &&
      !(e.ruleId === 'effects.search' && e.data.kind === 'requested') &&
      !(e.ruleId === 'damage.expression' && e.data.kind === 'stage-snapshot') &&
      !(e.ruleId === 'damage.coins' && e.data.kind === 'prepared') &&
      e.ruleId !== 'effects.execution' && e.ruleId !== 'selection.request' && e.ruleId !== 'attack.owned-lock' && !hasSelectionRequestPayload(e.data) &&
      (e.ruleId !== 'effects.prize-exchange' || prizeSummaryMatches(state, e))).map(clone),
    legalActions: actions(state, catalog, viewer),
    ...(unresolved.length ? { unresolvedActions: unresolved } : {}),
  });
}

export class OfficialGame {
  #state;
  #catalog;
  constructor(options) {
    this.#catalog = options.catalog;
    this.#state = options._restoring ? copyState(assertGameState(options.restore, this.#catalog)) : createGameState(options);
  }
  static restore(snapshot, { catalog }) {
    return new OfficialGame({ catalog, restore: snapshot, _restoring: true });
  }
  snapshot() { return clone(this.#state); }
  view(player) { return playerView(this.#state, this.#catalog, player); }
  dispatch(command) {
    const next = reduceGame(this.#state, command, this.#catalog);
    const view = playerView(next, this.#catalog, command.player);
    this.#state = next;
    return view;
  }
}
