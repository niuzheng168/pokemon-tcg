import { validateGameCommand, validateGameState, validateContinuousEffect, validateEffectResolution,
  validateTriggerEvent, validateTriggerWindow, validateTriggerActivation, validateCheckupPlan, validateSuppressionEffect,
  validateEntryContext, validateEntryWindow, validateEntryUse, validateEntryFinish, validateDrawTask } from './schema-validators.js';
import { validateActivationRequest, validateActivationChoice, validatePaymentReceipt, validateAbilityUsage, validatePromotionChoice, validateKnockoutWork } from './schema-validators.js';
import { validateEnergyProvisionEffect, validateEnergyOption, validateAttackGrantEffect } from './schema-validators.js';
import { validateAttackPaymentChoice, validateAttackPaymentReceipt } from './schema-validators.js';
import { validateDiscardWindow, validateDiscardUse } from './schema-validators.js';
import { assertCatalog, canonicalJSON } from './catalog.js';
import { assertMatchFormat, validateFormatDeck, formatTrace } from './formats.js';
import { getRuleset } from './index.js';
import { requireRule, ruleTrace, violation, deepFreeze } from './registry.js';
import { calculateAttackDamage } from './damage.js';
import { emptyConditions, validateConditions, applyCondition, checkConditions, resolveConfusion, presentConditions, cureConditions } from './conditions.js';
import { validateRetreatPayment } from './energy.js';
import { selectionBounds, canSelectCount } from './selection.js';
import { randomIndex, shuffleIds, validateRandomState } from './random.js';
import { assertEffectProgram, assertEffectStep, beginEffectProgram, expandEffectStep, completeEffectStep, completionMovedUse, scaleEffect } from './effects.js';
import { createOngoingEffect, assertOngoingEffect, ongoingIsActive, expireOngoing,
  createPlayerOngoingEffect, assertPlayerOngoingEffect, PLAYER_POKEMON_OPS, attackEffectsOn } from './ongoing.js';
import { triggerMatches, triggerRuleId, assertOwnerIndependence, assertSubjectProgram, causeMatches } from './triggers.js';
import { REACTION_OPERATIONS, createCoreHandlers } from './handlers.js';
import { resolveSuppression, suppressionApplies } from './suppression.js';
import { matchesCardSelector, matchesCardsMove, matchesOnePerAlternative, matchesAlternativeLimits, alternativeTotal, selectorQuantityClass, distinctCards, playedCard, typeCount } from './card-selection.js';
import { acquisitionMatches } from './acquisition.js';
import { assertActivationCosts, costCardCount, findCostPayment, findCostPaymentWitness, readCostPayment, paymentOptionId } from './activation-cost.js';
import { resolveEnergyRequirements, meetsEnergyRequirement, resolveEnergyProvision, surplusEnergy, surplusEachEnergy } from './energy-mechanics.js';
import { attachedEnergyPool, energyRecipients, effectAttachable, attachedEnergyChoice } from './energy-selection.js';
import { evolutionRelation, evolutionTiming, transitionTargets, transitionCards, devolutionDepth, poolCouldEvolve } from './evolution.js';
import { fieldReturnTargets, attachedReturnHolders } from './field-return.js';
import { copyCandidates, attackOptionId } from './attack-copy.js';
import { copyHolder, copyZone, readsOwnHand } from './supporter-copy.js';
import { grantReferences } from './attack-grant.js';
import { assertFailureReceipt, groupImposedChecks } from './attack-failure.js';
import { createBattleHistory, assertBattleHistory, recordBattleTurn, recordBattleEvent, normalizeKnockoutEvent, hadKnockoutInPreviousOpponentTurn,
  wasMovedFromBenchToActiveThisTurn, wasSupporterPlayedFromHandThisTurn, wasHealedThisTurn, BATTLE_HISTORY_RULES, attacksInPreviousOwnTurn,
  knockoutsInPreviousOpponentTurn, attackDamageInPreviousOpponentTurn, prizesTakenInPreviousOpponentTurn,
  specialAttackInPreviousOpponentTurn, movedInPreviousOpponentTurn } from './battle-history.js';
import { resolveBurnCounters } from './checkup-effects.js';
import { attackCommitmentPool, canPayAttackCommitment, resolveAttackCommitment } from './attack-commitments.js';
import { inspectDeckWindow, planDeckInspection, deckInspectionNeedsShuffle } from './deck-window.js';
import { deckEnergyWindow, deckEnergyDestinations, validateDeckEnergyPlan, DECK_ENERGY_HAND } from './deck-energy.js';
import { validatePokemonTypesEffect } from './schema-validators.js';
import { resolveSourceTraits } from './source-traits.js';
import { matchesInPlaySelector, matchesPokemonState, enterLocked } from './in-play-selection.js';
import { hasContextFields, resolveContextSelector, readTypes } from './context-selection.js';
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
  const ruleId = { fieldTransition: 'history.field-transition', turnEnded: 'history.turn-ended', attackUsed: 'history.previous-own-attack',
    attackDamage: 'history.previous-opponent-turn', prizeTaken: 'history.previous-opponent-turn', retreat: 'history.previous-opponent-move' }[event.kind];
  if (ruleId) requireRule(getRuleset(s.ruleset), ruleId);
  s.battleHistory = recordBattleEvent(s.battleHistory, { ...event, turn: s.turn, during: s.current },
    { turn: s.turn, during: s.current });
}
const knockoutFact = (item) => ({
  kind: 'ko', owner: item.owner, pokemonId: item.id, turn: item.turn, during: item.during, cause: clone(item.cause),
});
const monDef = (s, catalog, m) => cardDef(s, catalog, top(m));
const vUnionUsed = (s, player, nameKey) => s.events.some((e) => e.ruleId === 'pokemon.v-union' && e.data.player === player && e.data.nameKey === nameKey);
function grantedAttackHolderOk(s, catalog, model, m, toolId, field = 'grantedAttackHolder') {
  const holder = cardDef(s, catalog, toolId).mechanics[field];
  return !holder || matchesInPlaySelector(monDef(s, catalog, m), holder, model.pokemon[m.id].types);
}
const sourceNodeId = (kind, instanceId, key = null) => canonicalJSON([kind, instanceId, key]);
// tools.granted-ability: 「身上放有这张卡牌的「宝可梦V」，可以使用这个【VSTAR】力量」, the Ability printed on an attached Tool, for the
// printed kind of holder while the Tool's effects apply. It is not the holder's own Ability (JP Q&A): removing the holder's
// Abilities does not stop it, and the holder does not count as a Pokémon with an Ability.
function grantedAbilitiesFor(s, catalog, m, model = sourceModel(s, catalog)) {
  return m.tools.filter((id) => model.availability.get(sourceNodeId('tool', id)).enabled &&
    grantedAttackHolderOk(s, catalog, model, m, id, 'grantedAbilityHolder'))
    .flatMap((toolId) => (cardDef(s, catalog, toolId).mechanics.grantedAbilities ?? []).map((ability) => ({ ability, toolId })));
}
function attacksFor(s, catalog, m, model = sourceModel(s, catalog)) {
  const out = [
    ...monDef(s, catalog, m).mechanics.attacks.map((attack) => ({
      attack, instanceId: top(m), referenceId: canonicalJSON(['native', top(m), attack.attackId]), grant: null,
    })),
    // tools.granted-attack: 「身上放有这张卡牌的（「一击」）宝可梦，可以使用这张卡牌上的招式」, only for the printed kind of holder.
    ...m.tools.filter((id) => model.availability.get(sourceNodeId('tool', id)).enabled && grantedAttackHolderOk(s, catalog, model, m, id))
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
const CONTINUOUS_OPS = new Set(['stadiumReplacement', 'coinReflip', 'handSupporterEffect', 'moveLock',  'knockoutZone', 'discardToHand', 'reattachAfterAttack', 'modifier', 'protection', 'stadiumProtection', 'property', 'restriction', 'playerRestriction', 'energyRequirement', 'burnCounters', 'conditionRule', 'attackTwice', 'koSurvive', 'benchLimit', 'toolCapacity', 'retreatRule', 'turnKept', 'conditionImmunity', 'attackDamageOptions', 'prizeModifier', 'evolutionPermission', 'prizeDestination']);
const LOCAL_EFFECTS = new Set(['counters', 'heal', 'condition', 'lasting', 'delayedReaction', 'sequence', 'then', 'optional']);
const SUPPORTED_EFFECTS = new Set(['draw', 'discardHand', 'counters', 'heal', 'condition', 'switch', 'attachDiscard', 'attachHand',
  'transferCounters', 'lasting', 'lastingPlayer', 'delayedReaction', 'damage', 'suppression', 'cards', 'shuffle',
  'deployIncoming', 'attachIncoming', 'energyProvision', 'discardEnergy', 'moveEnergy', 'returnEnergy', 'returnPokemon', 'returnAttached',
  'evolvePokemon', 'devolvePokemon', 'inheritPokemon', 'copyAttack', 'attackGrant',
  'inspectDeck', 'attachDeckEnergy', 'pokemonTypes', 'exchangePrizes', 'shuffleHandToBottom', 'healPokemon', 'distributeCounters', 'discardStadium', 'disableOwnedAttack',
  'shuffleHandIntoDeck', 'sequence', 'then', 'thenMoved', 'choose', 'optional', 'coin', 'orElse', 'discardDeckTop', 'replacePokemon', 'knockOut', 'discardTools',
  'opponentHand', 'coins', 'coinResult', 'when', 'arrangeDeck', 'cure', 'extraPrizes', 'takePrizes', 'attackChoice', 'janken',
  'revealCards', 'revealedCards', 'selfCounters', 'revealHands', 'extraTurn', 'bound',
  'lookPrizes', 'flipPrizes', 'swapPrizeDeck', 'resetPrizes', 'prizeHandSwap', 'deckTopToPrizes', 'swapHandDeckTop', 'returnSelf', 'deploySelf', 'gameResult', 'turnEndEffect', 'ifPaid', 'swapCounters', 'discardSelf', 'discardPrizes', 'copySupporter',
  'lookPrizeHand',
  'ifMoved', 'recordedCards', 'damageRedirect', 'attackKnockoutZone', 'choosePokemon', 'clearAttackEffects', ...CONTINUOUS_OPS]);
// II.B-02: counted before-damage moves (or a look at the opponent's hand), and the cards each may record.
const COUNTED_OPERATIONS = [['discardEnergy', 'moveEnergy'], ['discardTools'], ['cards'], ['opponentHand'], ['switch'], ['attackChoice'], ['janken'],
  ['revealCards'], ['discardDeckTop'], ['selfCounters'], ['knockOut'], ['flipPrizes'], ['returnPokemon'],
  ['optional', 'sequence', 'discardEnergy', 'returnEnergy', 'discardTools', 'cards', 'discardStadium', 'flipPrizes', 'discardDeckTop', 'attachHand'], ['counters'],
  ['damageRedirect']];
const CHOICE_RESUMES = new Set(['choose-order', 'deal', 'retry', 'setup-active', 'setup-bench', 'bonus', 'award', 'promote',
  'retreat-paid', 'finish-retreat', 'attach-tool', 'effect-choice', 'trigger-window', 'trigger-execute', 'checkup-plan',
  'entry-window', 'entry-use', 'activation-choice', 'attack-payment', 'bench-trim', 'tool-trim', 'second-attack', 'ko-discard', 'draw-cards', 'attack', 'attack-coins',
  'discard-window', 'discard-use']);
const NATIVE_CHANGE_HANDLERS = new Set([
  'cn.distributeCounters@1', 'cn.healPokemon@1', 'cn.switch@1', 'cn.heal@1', 'cn.counters@1', 'cn.discardStadium@1', 'cn.discardTools@1',
]);
// These installed native producers return their constant reviewed parameters.
// A custom field provider is NOT assumed independent of discarded hand cards.
const CONSTANT_FIELD_HANDLERS = new Set([
  'cn.modifier@1', 'cn.protection@1', 'cn.property@1', 'cn.restriction@1', 'cn.playerRestriction@1',
  'cn.burnCounters@1', 'cn.conditionRule@1', 'cn.attackTwice@1', 'cn.koSurvive@1', 'cn.energyRequirement@1', 'cn.energyProvision@1', 'cn.pokemonTypes@1',
  'cn.suppression@1', 'cn.attackGrant@1', 'cn.stadiumProtection@1', 'cn.benchLimit@1', 'cn.toolCapacity@1', 'cn.retreatRule@1', 'cn.turnKept@1',
  'cn.knockoutZone@1', 'cn.discardToHand@1', 'cn.prizeDestination@1', 'cn.handSupporterEffect@1', 'cn.moveLock@1', 'cn.reattachAfterAttack@1',
  'cn.stadiumReplacement@1',
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
// effects.activation-cost: a cost that puts hand cards into the deck (「放回牌库下方」) or takes cards off the using Pokémon
// changes what a post-cost proof must read; only these native draws account for both.
const HAND_PAID_KINDS = Object.freeze(['discardHand', 'lostHand']);
const DECK_PAID_EFFECTS = new Set(['cn.draw@1', 'cn.drawUntil@1']);
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
// counted: an attack's own counted before-damage effects, whose recorded result a later entry of that attack may read.
function assertUseTimeFacts(predicate, trainer, noStats = false, attack = false, counted = []) {
  const holders = trainer ? ['ownActive', 'opponentActive'] : ['self', 'ownActive', 'opponentActive'];
  (function walk(node) {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    // 「查看对手的手牌，如果其中有能量的话，则…」: the cards an attack's own counted entry recorded, like its count (effects.counted-condition).
    if (['coin', 'prizes'].includes(node.kind) || ['effectCards', 'movedCards'].includes(node.kind) && !counted.includes(node.effectId) ||
        !attack && node.kind === 'extraEnergy' ||
        Object.hasOwn(node, 'who') && !holders.includes(node.who) ||
        noStats && (node.kind === 'exists' || node.kind === 'pokemon' && Object.hasOwn(node, 'who') || Object.hasOwn(node, 'maximumHp')) ||
        trainer && (node.excludeSelf || node.kind === 'previousOpponentTurn' && node.fact === 'damageTaken' ||
          node.kind === 'historyFact' && (['movedToActive', 'healed', 'evolvedThisTurn', 'toolFromHand', 'otherEvolvedFromHand'].includes(node.fact) ||
          node.fact === 'previousOwnAttack' && node.by !== 'any')))
      throw new EngineError('unsupported-condition', 'A use condition or non-attack count can read only facts that exist when it is judged.');
    Object.values(node).forEach(walk);
  })(predicate);
}
const PROVISION_FACTS = ['compare', 'all', 'any', 'not', 'literal', 'zoneCount', 'add', 'subtract', 'multiply'];
// 「如果在自己场上有3只以上【2阶进化】宝可梦的话」: a count of in-play Pokémon by their kind only (no state or Retreat Cost, which may read Energy).
const provisionFactsOnly = (node) => Array.isArray(node) ? node.every(provisionFactsOnly) : !node || typeof node !== 'object' ||
  (node.kind === 'pokemonCount' ? !node.state && node.retreatCost === undefined :
    (!Object.hasOwn(node, 'kind') || PROVISION_FACTS.includes(node.kind)) && Object.values(node).every(provisionFactsOnly));
// II.C-20: the opponent's hand faces are known only once a printed look shows them.
// A count of them is read only by a later step of the same Trainer/Ability program;
// an attack counts what its own before-damage look recorded (movedCards).
const coinKeys = (node) => Array.isArray(node) ? node.flatMap(coinKeys) : !node || typeof node !== 'object' ? [] :
  [...(node.kind === 'coin' ? [node.key] : []), ...Object.values(node).flatMap(coinKeys)];
const readsHiddenHand = (node) => node.kind === 'zoneCount' && node.side === 'opponent' && node.zone === 'hand' && Object.hasOwn(node, 'selector');
function assertHiddenHandReads(catalog, m) {
  const looked = new Set();
  // trainer.joint-play: one card played alone and N cards played together run separate programs.
  for (const program of [(m.effects ?? []).filter((b) => !b.playCount), (m.effects ?? []).filter((b) => b.playCount), ...(m.abilities ?? []).map((a) => a.effects)])
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
// selection.context: a selector reads the board only where its host resolves it — the top-level Pokémon selector of a deck search
// (cn.cards@1) or of an evolution from the deck; the attached Energy's type only in an Energy-attachment trigger, and 「这只宝可梦身上
// 附着的基本能量」 only on a Pokémon (pokemonTypes typesFrom alike).
function assertContextReads(definition, m) {
  const check = (node, trigger, allowed) => {
    if (Array.isArray(node)) { node.forEach((x) => check(x, trigger, allowed)); return; }
    if (!node || typeof node !== 'object') return;
    const p = node.parameters;
    if (p?.from === 'deck' && (node.handlerId === 'cn.cards@1' || node.handlerId === 'cn.pokemonTransition@1' && p.op === 'evolvePokemon')) allowed = p.selector;
    if (hasContextFields(node) && (Object.hasOwn(node, 'kind') && node !== allowed ||
        node.typesFrom === 'eventEnergy' && trigger?.event !== 'energyAttached' || node.typesFrom === 'attachedBasicEnergy' && definition.kind !== 'pokemon'))
      throw new EngineError('unsupported-condition', 'A selector or type change reads the board only where its host resolves it.');
    Object.values(node).forEach((x) => check(x, trigger, allowed));
  };
  for (const b of m.effects ?? []) check(b, b.trigger, null);
  for (const a of m.abilities ?? []) check(a.effects, a.trigger, null);
  for (const a of [...(m.attacks ?? []), ...(m.grantedAttacks ?? [])]) check(a.effects, null, null);
}
export function assertSupportedDefinition(catalog, definition) {
  // tools.granted-ability: the Ability printed on a Tool is checked as an Ability (a Trainer has none of its own).
  const m = definition.mechanics.grantedAbilities ? { ...definition.mechanics, abilities: definition.mechanics.grantedAbilities } : definition.mechanics;
  assertContextReads(definition, m);
  // effects.discard-self: only an attached Tool or Special Energy has 「这张卡牌」 in play.
  if (!(m.category === 'tool' || definition.kind === 'energy') && JSON.stringify(m).includes('"cn.discardSelf@1"'))
    throw new EngineError('unsupported-handler', 'Only a Tool or Special Energy discards itself from play.');
  // tools.damage-discard: 「那个伤害「-60」，将这张卡牌放于弃牌区」 only as a Tool's own written damage change about its holder;
  // damage.survive 「…留在场上。然后，将这张卡牌放于弃牌区」 only as a Tool's own survival of its holder.
  if (JSON.stringify(m).split('"discardCard"').length - 1 !==
      (m.category === 'tool' ? m.effects.filter((b) => b.handlerId === 'cn.modifier@1' && b.parameters.discardCard ||
        b.handlerId === 'cn.koSurvive@1' && b.parameters.effect.discardCard && b.parameters.effect.scope === 'self').length : 0))
    throw new EngineError('unsupported-handler', 'Only a Tool discards itself when its holder takes the damage it changes.');
  assertHiddenHandReads(catalog, m);
  if (m.condition?.predicate) assertUseTimeFacts(m.condition.predicate, true);
  for (const a of m.abilities || []) if (a.condition?.predicate) assertUseTimeFacts(a.condition.predicate, false);
  for (const a of [...(m.attacks || []), ...(m.grantedAttacks || [])]) {
    // attack.printed-target: one packet carries the printed damage (「20×」) to the chosen Pokémon; no formula besides it.
    const printed = a.effects.filter((b) => b.handlerId === 'cn.damage@1' && b.parameters.printed);
    if (printed.length && (printed.length > 1 || !a.printedDamage ||
        a.effects.some((b) => catalog.handler(b.handlerId).capabilities?.includes('resolve-attack-damage'))))
      throw new EngineError('unsupported-formula', 'The printed damage of 「给对手的1只宝可梦」 is one packet, without another damage formula.');
    if (a.failureCheck?.predicate) assertUseTimeFacts(a.failureCheck.predicate, false);
    if (a.condition) assertUseTimeFacts(a.condition.predicate, false);
    for (const b of a.effects) if (catalog.handler(b.handlerId).timing === 'energyOptions' && b.parameters.condition)
      assertUseTimeFacts(b.parameters.condition, false);
    // 「在这种情况下，这个招式的伤害不计算…」: read when the damage is calculated, with this attack's own facts.
    for (const b of a.effects) if (catalog.handler(b.handlerId).timing === 'damageOptions' && b.parameters.condition)
      assertUseTimeFacts(b.parameters.condition, false, false, true);
  }
  // 「如果…，则…」 reads the board when reached; only a Pokémon has 「这只宝可梦」, only an attack its extra Energy.
  const attackBindings = new Set([...(m.attacks || []), ...(m.grantedAttacks || [])].flatMap((a) => a.effects));
  // 「在这种情况下」 after an attack's own counted before-damage choice or move: a resolve entry may read that record.
  const countedOf = new Map([...(m.attacks || []), ...(m.grantedAttacks || [])].flatMap((a) => {
    const counted = a.effects.filter((b) => catalog.handler(b.handlerId).capabilities?.includes('effect-card-count')).map((b) => b.effectId);
    return a.effects.filter((b) => (catalog.handler(b.handlerId).timing ?? 'resolve') === 'resolve').map((b) => [b, counted]);
  }));
  for (const b of [...(m.effects || []), ...(m.abilities || []).flatMap((a) => a.effects), ...attackBindings])
    if (catalog.handler(b.handlerId).capabilities?.includes('board-condition'))
      assertUseTimeFacts(b.parameters.condition, definition.kind === 'trainer' && m.category !== 'tool', false, attackBindings.has(b), countedOf.get(b) ?? []);
  for (const b of [...(m.effects || []), ...(m.abilities || []).flatMap((a) => a.effects)]) {
    const h = catalog.handler(b.handlerId), spec = b.parameters.effect ?? b.parameters;
    if (h.capabilities?.includes('battle-values')) assertUseTimeFacts(b.parameters, definition.kind === 'trainer' && m.category !== 'tool');
    // A Stadium has no Pokémon of its own; a Tool or Energy reads its holder as self.
    if (h.timing === 'continuous' && spec.condition) assertUseTimeFacts(spec.condition, m.category === 'stadium', true);
    // An Energy's provision is part of the board model it would read: zone counts only (Prize cards, hands, discard piles).
    if (h.timing === 'energyProvision' && spec.condition && !provisionFactsOnly(spec.condition))
      throw new EngineError('unsupported-condition', 'An Energy provision condition reads only zone counts and Pokémon counts by kind.');
    // effects.coin-reflip: a Stadium for both players, or a Pokémon's Ability for its owner (a holder-only reflip is another mechanism).
    if (b.handlerId === 'cn.coinReflip@1' && !(m.category === 'stadium' || (m.abilities ?? []).some((a) => a.effects.includes(b))))
      throw new EngineError('unsupported-handler', 'A coin reflip belongs to a Stadium or a Pokémon\'s Ability.');
    // retreat.rules 「双方的战斗宝可梦在【撤退】时」: a Stadium's rule covers every Pokémon; a Tool's or Pokémon's its own.
    if (spec.op === 'retreatRule' && (spec.scope === 'all') !== (m.category === 'stadium'))
      throw new EngineError('unsupported-handler', 'A Stadium\'s retreat rule is about both players\' Pokémon; any other about its own Pokémon.');
    if (b.handlerId === 'cn.discardToHand@1' && !(m.category === 'tool' || definition.kind === 'energy' && m.category === 'special'))
      throw new EngineError('unsupported-handler', 'Only a Tool or Special Energy returns itself to the hand from play.');
    // energy.reattach-after-attack 「身上附着了这张卡牌的宝可梦」: an attached Special Energy's own text.
    if (b.handlerId === 'cn.reattachAfterAttack@1' && !(definition.kind === 'energy' && m.category === 'special'))
      throw new EngineError('unsupported-handler', 'Only a Special Energy attaches itself back after its holder\'s attack.');
    if (spec.op === 'knockoutZone' && spec.byOwnAttack && definition.kind !== 'pokemon')
      throw new EngineError('unsupported-condition', 'Only a Pokémon has 「这只宝可梦的招式」.');
    // 「因身上放有这张卡牌的「X」的招式的伤害」: a Pokémon, or the Tool's or Energy's holder; a Stadium has no Pokémon of its own.
    if (spec.op === 'prizeModifier' && spec.byOwnAttack && m.category === 'stadium')
      throw new EngineError('unsupported-condition', 'A Stadium has no Pokémon whose attack it could read.');
    if (/"if(Damage)?KnockedOut":true/.test(JSON.stringify(b)))
      throw new EngineError('unsupported-condition', 'Only an attack has 「因为这个招式…昏厥」.');
    if (['cn.enterOnlyBy@1', 'cn.setupPlacement@1'].includes(b.handlerId) && !(m.abilities ?? []).some((a) => a.mode === 'continuous' && a.effects.includes(b)))
      throw new EngineError('unsupported-handler', 'Only a Pokémon\'s own printed rule limits how it is put into play.');
  }
  // effects.reveal: 「将正面朝上的……」「然后，将给对手查看过的……」 moves this attack's own earlier reveal on, out of where it was shown.
  for (const attack of [...(m.attacks || []), ...(m.grantedAttacks || [])]) for (const b of attack.effects) if (b.handlerId === 'cn.revealedCards@1') {
    const from = attack.effects.find((r) => r.effectId === b.parameters.effectId && r.handlerId === 'cn.countedReveal@1')?.parameters.from;
    const { to, rest } = b.parameters;
    if (!from || from === 'bothHands' || rest && (from !== 'deck' || rest === to) || to === from && !rest)
      throw new EngineError('unsupported-effect-count', 'Revealed cards move on from this attack\'s own reveal, out of the zone they were shown in.');
  }
  // effects.shared-name: same names are compared between the two hands this attack's own both-hands reveal showed.
  for (const attack of [...(m.attacks || []), ...(m.grantedAttacks || [])]) for (const node of queryNodes(attack.effects.map((b) => b.parameters)))
    if (node.sharedName && !attack.effects.some((r) => r.effectId === node.effectId && r.handlerId === 'cn.countedReveal@1' && r.parameters.from === 'bothHands'))
      throw new EngineError('unsupported-effect-count', 'Shared names are read from this attack\'s own reveal of both hands.');
  // A printed failure condition (predicate, or a required discard) is judged when the attack is used, before any before-damage
  // step (damage.bench-count, attack.failure.discard).
  for (const attack of [...(m.attacks || []), ...(m.grantedAttacks || [])]) if (attack.failureCheck && !attack.failureCheck.predicate &&
      !attack.failureCheck.requires &&
      attack.effects.some((b) => catalog.handler(b.handlerId).timing === 'beforeDamage'))
    throw new EngineError('unsupported-failure-timing', 'Combining a self-failure check with before-damage effects needs reviewed CN timing, not speculative rollback.');
  // damage.effect-count: a counted placement goes before the damage step, so nothing of the attack damages the opponent first.
  for (const attack of [...(m.attacks || []), ...(m.grantedAttacks || [])]) if (attack.effects.some((b) => b.handlerId === 'cn.countedCounters@1') &&
      (attack.printedDamage !== null || attack.effects.some((b) => b.handlerId === 'cn.damage@1')))
    throw new EngineError('unsupported-effect-count', 'A counted counter placement needs an attack without printed or extra damage before it.');
  // damage.redirect: the choice is the attack's only step before its printed fixed damage (no formula or damage coins in between).
  for (const attack of [...(m.attacks || []), ...(m.grantedAttacks || [])]) if (attack.effects.some((b) => b.handlerId === 'cn.damageRedirect@1') &&
      (attack.printedDamage?.operator !== 'fixed' || attack.effects.some((b) => b.handlerId !== 'cn.damageRedirect@1' &&
        (['beforeDamage', 'formula'].includes(catalog.handler(b.handlerId).timing) || b.parameters.rolls))))
    throw new EngineError('unsupported-damage-redirect', 'A redirected attack damage is its printed fixed damage, chosen right before it.');
  // 「抛掷2次硬币，将与出现正面次数相同数量的…。如果全是反面，则这个招式失败」: only its own attack's printed coin failure check is read again.
  const failureCoins = new Set([...(m.attacks || []), ...(m.grantedAttacks || [])].filter((a) => a.failureCheck?.coin).flatMap((a) => a.effects));
  for (const b of [...(m.effects || []), ...(m.abilities || []).flatMap((a) => a.effects), ...attackBindings])
    if (b.parameters.flips?.kind === 'failureCheck' && !failureCoins.has(b))
      throw new EngineError('unsupported-condition', 'Only an attack with a printed coin failure check reads those coins again.');
  // II.E-38 文例3: a later effect reads only coins this attack's damage always flips.
  for (const attack of [...(m.attacks || []), ...(m.grantedAttacks || [])]) {
    const rolled = attack.effects.filter((b) => catalog.handler(b.handlerId).capabilities?.includes('damage-rolls'))
      .flatMap((b) => (b.parameters.rolls ?? []).filter((r) => !r.condition).map((r) => r.key));
    for (const b of attack.effects) if (catalog.handler(b.handlerId).capabilities?.includes('damage-roll-results') &&
        coinKeys(b.parameters.condition).some((key) => !rolled.includes(key)))
      throw new EngineError('unsupported-condition', 'A coin result reads only rolls this attack\'s damage flips unconditionally.');
  }
  if (m.stage === 'special')
    throw new EngineError('unsupported-deployment', 'This special deployment mechanism is not implemented yet.');
  const bodyTimings = definition.kind === 'pokemon' ? ['continuous', 'pokemonTypes', 'attackGrant'] : definition.kind === 'energy' ? ['continuous', 'pokemonTypes', 'energyProvision', 'attackGrant'] :
    m.category === 'tool' ? ['continuous', 'suppression', 'pokemonTypes', 'energyProvision', 'attackGrant'] : m.category === 'stadium' ? ['continuous', 'suppression', 'pokemonTypes', 'energyProvision', 'attackGrant', 'onUse'] : ['resolve'];
  if (definition.kind === 'trainer' && !['tool', 'stadium'].includes(m.category) &&
      m.effects.some((b) => b.trigger && b.trigger.event !== 'beforeHand'))
    throw new EngineError('unsupported-trigger-zone', 'A resolving Item/Supporter is not an in-play trigger source.');
  // trigger.discarded: a Pokémon's own Ability, used from the discard pile.
  if (m.effects.some((b) => b.trigger?.event === 'discarded'))
    throw new EngineError('unsupported-trigger-zone', 'Only a Pokémon\'s own Ability is used after its card is discarded.');
  const placements = [
    ...(m.effects || []).map((b) => ({ b, trigger: b.trigger, costs: b.trigger ? b.activationCosts :
      b.activationCosts ?? (definition.kind === 'trainer' && !['tool', 'stadium'].includes(m.category) ?
        m.playCosts ?? (b.handlerId === 'cn.ifPaid@1' ? m.optionalPlayCosts : null) : null),
      allowed: b.trigger && (b.trigger.event === 'beforeHand' || definition.kind !== 'trainer' || ['tool', 'stadium'].includes(m.category)) ||
        b.parameters.on ? ['resolve'] : bodyTimings })),
    ...[...(m.attacks || []), ...(m.grantedAttacks || [])].flatMap((a) =>
      a.effects.map((b) => ({ b, attack: true, allowed: ['resolve', 'beforeDamage', 'damage', 'formula', 'permission', 'damageOptions', 'energyOptions'] }))),
    ...(m.abilities || []).flatMap((a) => a.effects.map((b) =>
      ({ b, trigger: a.trigger, costs: a.costs, zone: a.zone, allowed: a.mode === 'continuous' ? ['continuous', 'suppression', 'pokemonTypes', 'energyProvision', 'attackGrant'] : ['resolve'] }))),
  ];
  // effects.moved-cards: 「然后，将放于弃牌区的能量附着于这只宝可梦身上」 takes the cards this attack's own counted entry put into its user's discard pile.
  for (const { b } of placements) if (b.handlerId === 'cn.thenMoved@1' && b.parameters.counted) {
    const r = [...attackBindings].find((e) => e.effectId === b.parameters.counted);
    if (!countedOf.get(b)?.includes(b.parameters.counted) || !(r.handlerId === 'cn.countedCards@1' ? r.parameters.to === 'discard' :
      r.handlerId === 'cn.countedDeckTop@1' && r.parameters.side === 'own'))
      throw new EngineError('unsupported-effect-count', 'Moved cards are bound from this attack\'s own counted discard into its user\'s discard pile.');
  }
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
  // effects.optional-cost: an Item/Supporter's optional play cost belongs to its own 「在这种情况下」 parts, and they to it.
  const paid = (m.effects ?? []).filter((b) => b.handlerId === 'cn.ifPaid@1');
  if (m.optionalPlayCosts && (definition.kind !== 'trainer' || !['item', 'supporter'].includes(m.category) || !paid.length || m.playCosts))
    throw new EngineError('unsupported-cost-placement', 'An optional play cost needs its own 「在这种情况下」 parts on an Item or Supporter without other costs.');
  if (m.optionalPlayCosts) assertActivationCosts(m.optionalPlayCosts);
  if (m.discardRecall) assertActivationCosts(m.discardRecall.costs);
  // trainer.joint-play 「可以使用1张或者同时使用N张」「必须同时使用N张」: an Item's own resolving entries, one N per card, without costs;
  // the N cards are one use, so none of these entries acts on 「这张卡牌」 alone.
  const joint = (m.effects ?? []).filter((b) => b.playCount);
  if ([...(m.attacks || []), ...(m.grantedAttacks || []), ...(m.abilities || [])].some((a) => a.effects.some((b) => b.playCount)) ||
      joint.length && (definition.kind !== 'trainer' || m.category !== 'item' || m.playCosts || m.optionalPlayCosts ||
        new Set(joint.map((b) => b.playCount)).size > 1 || joint.some((b) => b.trigger || b.activationCosts) ||
        /"cn\.(returnSelf|prizeExchange)@1"/.test(JSON.stringify(joint))))
    throw new EngineError('unsupported-joint-play', 'Cards played together are one use of an Item\'s own entries: one count, no costs or triggers, never 「这张卡牌」 alone.');
  for (const { b, allowed, trigger, attack, costs, zone } of placements) {
    const h = catalog.handler(b.handlerId);
    const timing = h.timing || 'resolve';
    if (h.operations?.includes('ifPaid') && (attack || trigger || b.trigger || !m.optionalPlayCosts))
      throw new EngineError('unsupported-cost-placement', 'A 「在这种情况下」 part needs its Item or Supporter\'s own optional play cost.');
    if (h.embeddedOperations?.includes('disableOwnedAttack') ||
        h.operations?.includes('disableOwnedAttack') && (!attack || timing !== 'resolve' || trigger || b.trigger))
      throw new EngineError('unsupported-owned-attack-lock', 'A chosen owned-attack lock requires an actual attack resolve body, not another activation or reaction.');
    if (h.capabilities?.includes('effect-card-count') && (!attack || timing !== 'beforeDamage' ||
        !COUNTED_OPERATIONS.some((ops) => canonicalJSON(h.operations) === canonicalJSON(ops))))
      throw new EngineError('unsupported-effect-count', 'A counted effect is an attack’s own before-damage discard, look or switch.');
    if (Array.isArray(h.operations) && h.operations.includes('stadiumProtection') &&
        (definition.kind !== 'trainer' || m.category !== 'stadium'))
      throw new EngineError('unsupported-protection-subject', 'A Stadium self-card protection must be provided by that Stadium, not a Pokemon or attachment.');
    if (h.operations?.includes('stadiumReplacement') && (definition.kind !== 'trainer' || m.category !== 'stadium'))
      throw new EngineError('unsupported-handler', 'Replacing an incoming Stadium is that Stadium\'s own effect.');
    if (definition.kind === 'trainer' && m.category === 'stadium' && h.id === 'cn.protection@1' &&
        canonicalNativeExecution(h) && b.parameters.effect.scope === 'self')
      throw new EngineError('unsupported-protection-subject', 'Protecting a Stadium card itself needs a field-card subject, not a Pokemon self scope.');
    if (b.activationCosts && (!trigger && timing !== 'onUse' || attack))
      throw new EngineError('unsupported-cost-placement', 'Binding costs require their own trigger or Stadium activation.');
    if (costs && (typeof h.canUse !== 'function' || typeof h.canUseWithCosts !== 'function' || !h.costCheckVersion ||
        typeof h.costCheckApplies === 'function' && !h.costCheckApplies(clone(b.parameters)) ||
        costs.some((c) => !HAND_PAID_KINDS.includes(c.kind)) && !(DECK_PAID_EFFECTS.has(h.id) && canonicalNativeActivation(h))))
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
        (h.operations.includes('damage') && !attack) || (b.handlerId === 'cn.drainHeal@1' && !attack) ||
        (b.handlerId === 'cn.countersFromDamage@1' && trigger?.event !== 'attackDamage') ||
        // 「…则多拿取N张奖赏卡」, also as a condition's result (cn.when@1): only in an attack's own resolve body.
        (JSON.stringify(b).includes('"cn.extraPrizes@1"') && (!attack || timing !== 'resolve' || trigger || b.trigger)) ||
        (h.operations.includes('attackKnockoutZone') && !attack) ||
        // effects.player-ability-removal: an Item's own effect (the protection it is judged against is from Items).
        (JSON.stringify(b).includes('"cn.lastingPlayer@1"') && JSON.stringify(b).includes('"op":"suppression"') &&
          (definition.kind !== 'trainer' || m.category !== 'item')) ||
        (h.capabilities?.includes('damage-roll-results') && !attack) ||
        ((b.handlerId === 'cn.thenMoved@1' ? b.parameters.next.handlerId === 'cn.copyAttack@1' : h.operations.includes('copyAttack')) &&
          (!attack || timing !== 'resolve')) ||
        // effects.copy-supporter: an attack, or a Trainer that looks at the opponent's hand (ナツメの暗示).
        (h.operations.includes('copySupporter') && !attack && (definition.kind !== 'trainer' || b.parameters.from !== 'opponentHand')) ||
        // effects.supporter-replacement 「只要这只宝可梦在战斗场上」: a Pokémon's own continuous text.
        (h.operations.includes('handSupporterEffect') && definition.kind !== 'pokemon') ||
        (h.operations.includes('exchangePrizes') &&
          (attack || definition.kind !== 'trainer' || !['item', 'supporter'].includes(m.category))) ||
        (h.operations.includes('returnPokemon') && timing === 'beforeDamage' && !h.capabilities?.includes('effect-card-count')) ||
        (h.operations.includes('revealedCards') && !attack) ||
        (h.operations.some((op) => ['deployIncoming', 'attachIncoming'].includes(op)) && trigger?.event !== 'beforeHand') ||
        (h.operations.includes('deployIncoming') && definition.kind !== 'pokemon') ||
        (h.operations.includes('deploySelf') && !zone) ||
        (h.operations.includes('attachIncoming') && definition.kind !== 'energy') ||
        (timing === 'damage' && h.operations.some((op) => !['damage', 'sequence', 'then', 'optional'].includes(op))) ||
        (h.embeddedOperations && h.embeddedOperations.some((op) => !REACTION_OPERATIONS.includes(op) && !(op === 'when' && h.operations.includes('turnEndEffect')))) ||
        // tools.attack-tails: 「当身上放有这张卡牌的宝可梦使用招式时，…出现反面的话」 belongs to a Tool; the card-use form to an Item/Supporter.
        (h.operations.includes('turnEndEffect') && (attack || definition.kind !== 'trainer' ||
          !(b.parameters.on ? m.category === 'tool' : ['item', 'supporter'].includes(m.category)))) ||
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
// effects.discard-to-hand 「当这张卡牌，要被从场上放于弃牌区时，不会被放于弃牌区，而是被放回手牌」: judged while the card is still
// attached, its effect in force (not when it goes to the Lost Zone or the deck).
// source: the effect discarding it, if any. energy.reattach-after-attack: put into the discard pile by an effect of the attack its holder
// is using, its own effect in force then, it is attached back to that Pokémon when the attack ends (finish-attack).
function discardFromPlay(s, catalog, id, source = null) {
  const toHand = cardDef(s, catalog, id).mechanics.effects?.some((b) => b.handlerId === 'cn.discardToHand@1') &&
    continuousEntries(s, catalog).find((e) => e.spec.op === 'discardToHand' && e.source.instanceId === id);
  // effects.move-lock: a card that cannot be put into the hand is discarded after all (JP Q&A バリヤード × スケーターズパーク).
  if (toHand && !keptCards(s, catalog, toHand.source, [id], { zone: 'field', to: 'hand', holder: toHand.source.owner,
    pokemon: findMon(s, toHand.source.pokemonId).m }).length) {
    s.players[s.cards[id].owner].hand.push(id);
    log(s, 'effects.discard-to-hand', { player: s.cards[id].owner, cardId: id });
    return 'hand';
  }
  const holder = source && ownAttackSource(s, source) ? holdersOf(s, [id])[0] : null;
  const back = holder === s.attack?.pokemonId && cardDef(s, catalog, id).mechanics.effects?.some((b) => b.handlerId === 'cn.reattachAfterAttack@1') &&
    continuousEntries(s, catalog).some((e) => e.spec.op === 'reattachAfterAttack' && e.source.instanceId === id);
  if (back) (s.attack.reattach ??= []).push({ cardId: id, pokemonId: holder });
  return discard(s, catalog, id);
}
// zones.lost-zone: public, out of this game; never the discard pile.
function toLost(s, id) { s.players[s.cards[id].owner].lost.push(id); }
const ANY_STADIUM = Object.freeze({ op: 'discardStadium', side: 'either', selector: { kind: 'trainer', categories: ['stadium'] } });
function cardWindow(s, a, source) {
  const zone = s.players[a.side === 'opponent' ? 1 - source.owner : source.owner][a.from];
  // 「查看自己牌库下方N张卡牌」: the deck's first entries are its bottom.
  return a.from === 'deck' && a.lookBottom ? zone.slice(0, a.lookBottom) : a.from === 'deck' && a.lookTop !== null ? zone.slice(-a.lookTop) : [...zone];
}
// 「将剩余的卡牌放于弃牌区／加入手牌／（以任意顺序重新排列）放回牌库上方／下方」: the looked-at cards not chosen, still the
// top of the deck. Several going back to the deck are put in the order the user chooses, the first chosen uppermost.
const cardsRest = (d) => d.lookedAt.filter((id) => !d.chosen.includes(id));
function cardsRemainder(s, catalog, d) {
  const rest = cardsRest(d);
  if (['deckTop', 'deckBottom'].includes(d.action.remainder) && rest.length > 1)
    ask(s, { player: d.source.owner, kind: 'order-cards', options: rest, minimum: rest.length, maximum: rest.length,
      resume: 'effect-choice', data: { ...withoutSelection(d), stage: 'cards-remainder' }, ruleId: 'effects.deck-order' });
  else placeCardsRemainder(s, catalog, d, rest);
}
function placeCardsRemainder(s, catalog, d, order) {
  const a = d.action, owner = d.source.owner, p = s.players[owner], rest = cardsRest(d);
  if (order.length !== rest.length || new Set(order).size !== rest.length || order.some((id) => !rest.includes(id)))
    throw new EngineError('invalid-card-selection', 'The rest of the looked-at cards go back in one order of exactly those cards.');
  for (const id of rest) remove(p.deck, id);
  if (a.remainder === 'discard') {
    for (const id of order) discard(s, catalog, id);
    log(s, 'effects.discard', { player: owner, from: 'deck', cards: order.map((id) => clone(s.cards[id])), effectId: d.source.effectId });
  } else if (a.remainder === 'lost') {
    for (const id of order) toLost(s, id);
    log(s, 'zones.lost-zone', { player: owner, from: 'deck', cards: order.map((id) => clone(s.cards[id])), effectId: d.source.effectId });
  } else if (a.remainder === 'hand') {
    p.hand.push(...order);
    log(s, 'effects.search', { player: owner, from: 'deck', to: 'hand', count: order.length, effectId: d.source.effectId });
    log(s, 'effects.search', { effectId: d.source.effectId, toHand: [...order] }, owner);
  } else {
    const placed = [...order].reverse();
    p.deck = a.remainder === 'deckTop' ? [...p.deck, ...placed] : [...placed, ...p.deck];
    log(s, 'effects.deck-order', { player: owner, from: 'deck', to: a.remainder, count: order.length, effectId: d.source.effectId });
  }
  finishEffect(s, catalog, d, d.performed || rest.length > 0);
}
const deckOperation = (a) => ['inspectDeck', 'attachDeckEnergy'].includes(a.op);
// 「将自己牌库中最多2张基本能量附着于进化后的宝可梦身上」: a thenMoved next part attaches only to its bound Pokémon.
function deckContext(s, catalog, d, source = d.source) {
  const ctx = effectContext(s, catalog, source, d.event ?? null), bound = boundPokemon(d);
  return bound && requireRule(catalog.ruleset, 'effects.moved-cards') ? { ...ctx, boundPokemon: [...bound] } : ctx;
}
function deckWindow(s, catalog, d) {
  const ctx = deckContext(s, catalog, d);
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
  // 「将剩余的卡牌以任意顺序重新排列，放回牌库上方」: every looked-at card not chosen, top first.
  if (d.stage === 'deck-energy-order') {
    const rest = w.window.filter((id) => !d.deckChoice.chosen.includes(id));
    return { options: rest, minimum: rest.length, maximum: rest.length, allowZero: false };
  }
  // 「与附着于自己场上宝可梦身上的1张能量互换」: one Energy card attached to the chosen recipient.
  if (d.stage === 'deck-energy-swap')
    return { options: [...findMon(s, d.deckChoice.assignments[0].targetId).m.energy], minimum: 1, maximum: 1, allowZero: false };
  if (d.stage !== 'deck-energy-destination') return { options: w.eligible, ...w.bounds };
  const options = deckEnergyDestinations(deckContext(s, catalog, d), d.action,
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
  // After every recipient is chosen: the rest's order (deckTop) or the attached card to swap (swap).
  const ordering = ['deck-energy-order', 'deck-energy-swap'].includes(d.stage), w = deckWindow(s, catalog, d),
    selecting = !ordering && d.stage !== 'deck-energy-destination';
  if (c.turn !== s.turn || requested.length !== 1 || requested[0].visibility !== 'private' ||
      s.events.some((e) => e.ruleId === 'effects.search' && e.data.kind === 'resolved' && e.data.id === c.id) ||
      canonicalJSON(requested[0].data) !== canonicalJSON(expected) ||
      canonicalJSON(c.deck) !== canonicalJSON(s.players[d.source.owner].deck) ||
      canonicalJSON(c.window) !== canonicalJSON(w.window) ||
      d.action.op === 'inspectDeck' && d.stage !== 'inspect-select' ||
      d.action.op === 'attachDeckEnergy' && !['deck-energy-select', 'deck-energy-destination', 'deck-energy-order', 'deck-energy-swap'].includes(d.stage) ||
      d.stage === 'deck-energy-order' && d.action.remainder !== 'deckTop' ||
      d.stage === 'deck-energy-swap' && (!d.action.swap || c.chosen.length !== 1) ||
      selecting && (c.chosen.length || c.assignments.length))
    throw new EngineError('invalid-deck-choice', 'Private deck work must retain its exact original request, source, turn and untouched window.');
  const selected = s.events.filter((e) => e.ruleId === 'effects.search' && e.data.kind === 'selected' && e.data.id === c.id);
  const allocated = s.events.filter((e) => e.ruleId === 'effects.attach' && e.data.kind === 'allocated' && e.data.id === c.id);
  if (selecting ? selected.length || allocated.length : selected.length !== 1 ||
      selected[0].visibility !== d.source.owner || canonicalJSON(selected[0].data.selected) !== canonicalJSON(c.chosen) ||
      !canSelectCount(w.bounds, c.chosen.length) || !ordering && !c.chosen.length || c.chosen.some((id) => !w.eligible.includes(id)) ||
      (ordering ? c.assignments.length !== c.chosen.length : c.assignments.length >= c.chosen.length) ||
      d.action.distribution === 'singleRecipient' && new Set(c.assignments.map((a) => a.targetId)).size > (ordering ? 1 : 0) ||
      d.action.distribution === 'distinctRecipients' && new Set(c.assignments.map((a) => a.targetId)).size !== c.assignments.length ||
      allocated.some((e) => e.visibility !== d.source.owner) ||
      canonicalJSON(allocated.flatMap((e) => e.data.assignments)) !== canonicalJSON(c.assignments) ||
      c.assignments.some((a, i) => a.instanceId !== c.chosen[i] ||
        !(w.recipientIds.includes(a.targetId) || d.action.toHand && a.targetId === DECK_ENERGY_HAND)))
    throw new EngineError('invalid-deck-choice', 'Selected cards and recipient allocations must retain their private answer receipts.');
  if (pending) {
    const prompt = deckChoicePrompt(s, catalog, d);
    if (pending.player !== d.source.owner || Object.hasOwn(d, 'selected') ||
        pending.kind !== (d.stage === 'deck-energy-swap' ? 'select-cards' : ordering ? 'order-cards' : selecting ? 'inspect-deck' : 'deck-energy-recipient') ||
        pending.ruleId !== (d.stage === 'deck-energy-swap' ? 'effects.attach' : ordering ? 'effects.deck-order' : selecting ? 'effects.search' : 'effects.attach') ||
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
// 「将其翻到正面…（在对战结束前，一直保持正面朝上状态。）」: the face-up Prize cards, by identity, a subset of the Prizes.
const faceUpPrizes = (p) => p.faceUpPrizes ?? [];
const faceDownPrizes = (p) => p.prizes.filter((id) => !faceUpPrizes(p).includes(id));
function leavePrizes(p, ids) {
  p.prizes = p.prizes.filter((id) => !ids.includes(id));
  const up = faceUpPrizes(p).filter((id) => !ids.includes(id));
  if (up.length) p.faceUpPrizes = up; else delete p.faceUpPrizes;
}
// 「查看所有反面朝上的自己的奖赏卡」 (II.E-34): the face-up Prizes are not part of the window.
function prizeExchangeContext(s, catalog, source) {
  const ctx = effectContext(s, catalog, source);
  return { ...ctx, state: { ...ctx.state, players: ctx.state.players.map((p) => p.faceUpPrizes ? { ...p, prizes: faceDownPrizes(p) } : p) } };
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
  const window = prizeExchangeWindow(prizeExchangeContext(s, catalog, d.source), d.action);
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
  // trainer.joint-play: the cards played together with it stay in its resolution zone until it finishes.
  if (!validateTrainerFinish(d) || s.cards[d.cardId]?.owner !== d.player ||
      !['item', 'supporter'].includes(cardDef(s, catalog, d.cardId).mechanics.category) ||
      (d.jointCardIds ?? []).some((id) => !s.players[d.player].resolving.includes(id)))
    throw new EngineError('invalid-trainer-finish', 'A Trainer finalizer must retain its original owned Item/Supporter.');
  const opened = s.events.filter((e) => e.ruleId === 'turn.trainer' &&
    e.data.kind === 'trainer-open' && e.data.id === d.completionId);
  const latestUse = s.events.filter((e) => e.ruleId === 'turn.trainer' &&
    e.data.kind === 'trainer-open' && e.data.cardId === d.cardId).at(-1);
  if (opened.length !== 1 || opened[0].visibility !== 'public' || canonicalJSON(opened[0].data) !== canonicalJSON({
    kind: 'trainer-open', id: d.completionId, player: d.player, cardId: d.cardId, ...(d.jointCardIds ? { jointCardIds: d.jointCardIds } : {}), turn: s.turn,
  }) || latestUse !== opened[0] ||
      s.events.some((e) => e.ruleId === 'turn.trainer' && e.data.kind === 'trainer-finished' && e.data.id === d.completionId))
    throw new EngineError('invalid-trainer-finish', 'A finalizer cannot borrow an earlier or already completed use of the same physical Trainer.');
  const returned = s.events.filter((e) => e.ruleId === 'effects.return-self' && e.visibility === 'public' && e.data.cardId === d.cardId &&
    e.data.player === d.player && e.data.completion?.kind === 'trainer' && e.data.completion.id === d.completionId);
  if (!s.players[d.player].resolving.includes(d.cardId) && returned.length !== 1) {
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
// The healing context; a thenMoved next part (「然后，回复被附着能量的宝可梦的…HP」) heals only its bound Pokémon.
function healingContext(s, catalog, d) {
  const base = factContext(s, catalog, {}, effectContext(s, catalog, d.source, d.event ?? null), d.source, d.action), bound = boundPokemon(d);
  return bound ? { ...base, boundPokemon: [...bound] } : base;
}
function assertHealingChoice(s, catalog, d, pending = null) {
  if (d.local) throw new EngineError('invalid-healing-choice', 'Batch healing cannot run in a subject-local lane.');
  const choice = d.healingChoice;
  if (!choice) {
    if (pending || Object.hasOwn(d, 'selected'))
      throw new EngineError('invalid-healing-choice', 'Healing answers require their original public target-window receipt.');
    return;
  }
  const window = healingWindow(healingContext(s, catalog, d), d.action);
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
  // effects.clear-attack-effects: removed with the other attack effects on its holder's side, that clearing recorded right after.
  if (reason === 'removed') {
    const after = s.events.slice(index + 1).find((e) => !(e.ruleId === 'attack.owned-lock' && e.data.kind === 'cleared'));
    return event.data.historyIndex === null && after?.ruleId === 'effects.clear-attack-effects' && after.data.effects.includes(entry.id);
  }
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
  clearLeftActive(s);
}
// effects.duration.user-leaves-active 「如果这只宝可梦离开战斗场的话，则这个效果消除」: every move out of the Active Spot and every
// departure from play passes through retainOngoing; a player effect whose user is no longer the Active Pokémon ends for good.
function clearLeftActive(s) {
  const left = s.playerOngoing.filter((e) => e.clearOnLeaveActive && s.players[e.source.owner].active?.id !== e.source.pokemonId);
  for (const entry of left) log(s, 'effects.duration.user-leaves-active', { effectId: entry.id, player: entry.player, pokemonId: entry.source.pokemonId });
  s.playerOngoing = s.playerOngoing.filter((e) => !left.includes(e));
  // 「这个效果，一直持续到这只「X」离开战斗场」: an effect on another Pokémon that ends with its user's leaving.
  const ended = s.ongoing.filter((e) => e.clearOnLeaveActive && s.players[e.source.owner].active?.id !== e.source.pokemonId);
  for (const entry of ended) log(s, 'effects.duration.user-leaves-active', { effectId: entry.id, targetId: entry.targetId, pokemonId: entry.source.pokemonId });
  s.ongoing = s.ongoing.filter((e) => !ended.includes(e));
  // effects.player-ability-removal: a protected Active Pokémon is exempt only while it stays there.
  for (const e of s.playerOngoing) if (e.exemptId && s.players[1 - e.source.owner].active?.id !== e.exemptId) delete e.exemptId;
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
// 「这张卡牌，只有通过「海豚侠」的特性「全能变身」的效果才能被放于场上」 (pokemon.enter-only-by): any other way into play —
// setup, from the hand, or another effect — is closed. source: the effect putting it into play (null: a rule or a player action).
// locks: its owner's current enter locks, when the caller already has them.
function enterAllowed(s, catalog, cardId, source = null, locks = null) {
  // effects.enter-lock: by no action or effect onto its owner's field.
  locks ??= enterLocks(s, catalog, s.cards[cardId].owner, sourceModel(s, catalog));
  if (enterLocked(cardDef(s, catalog, cardId), locks)) {
    requireRule(catalog.ruleset, 'effects.enter-lock'); return false;
  }
  const only = cardDef(s, catalog, cardId).mechanics.abilities?.flatMap((a) => a.effects).find((b) => b.handlerId === 'cn.enterOnlyBy@1');
  if (!only) return true;
  const by = source?.category === 'ability' ? cardDef(s, catalog, source.instanceId) : null;
  return !!by && only.parameters.nameKeys.includes(by.nameKey) &&
    by.mechanics.abilities.some((a) => a.name === only.parameters.abilityName && a.effects.some((b) => b.effectId === source.effectId));
}
const transitionChoices = (s, catalog, ctx, a, m) => transitionCards(ctx, a, m).filter((id) => enterAllowed(s, catalog, id, ctx.source, ctx.enterLocks[ctx.source.owner]));
const setupBasic = (s, catalog, id) => {
  const def = cardDef(s, catalog, id);
  // pokemon.item-card: a card printed as an Item is not put into play during setup.
  return def.kind === 'pokemon' && def.mechanics.stage === 'basic' && !def.mechanics.itemCard && enterAllowed(s, catalog, id);
};
// setup.placement 「在对战准备中要将宝可梦放于战斗场（场上）时，如果这张卡牌在手牌中的话，则可…反面朝上放于…」: a Pokémon's own rule
// (the second player only, when printed 「如果自己是后攻玩家」) or an Item put into play only in setup; position 'active' or 'bench'.
function setupCard(s, catalog, id, position) {
  if (setupBasic(s, catalog, id)) return true;
  const def = cardDef(s, catalog, id);
  if (def.kind !== 'pokemon' || !enterAllowed(s, catalog, id)) return false;
  if (def.mechanics.itemCard) return !!def.mechanics.itemCard.setupOnly;
  const permit = def.mechanics.abilities.flatMap((a) => a.effects).find((b) => b.handlerId === 'cn.setupPlacement@1')?.parameters;
  return !!permit && (permit.position === 'field' || position === 'active') && (!permit.secondPlayer || s.first !== s.cards[id].owner);
}
// A hand with no Basic Pokémon but a card that may be put onto the Active Spot in setup: its holder chooses to put it there or to
// show the hand and draw again (JP Q&A レントラー／ライボルト／カビゴンドール).
const optionalStart = (s, catalog, player) => !s.players[player].hand.some((id) => setupBasic(s, catalog, id)) &&
  s.players[player].hand.some((id) => setupCard(s, catalog, id, 'active'));
const askStart = (s, player, resume, data) => ask(s, { player, kind: 'setup-start', options: ['place', 'mulligan'], resume, data,
  ruleId: 'setup.placement' });
function newMon(s, id) {
  return { id: `m${++s.serial}`, stack: [id], energy: [], tools: [], counters: 0,
    conditions: emptyConditions(), enteredTurn: s.turn, evolvedTurn: 0, used: {}, facts: {} };
}
function finish(s, winner, reason) {
  s.result = { winner, reason }; s.phase = 'over'; s.pending = null; s.queue = []; s.attack = null;
  s.vacancies = [null, null];
  log(s, reason === 'concede' ? 'win.concede' : reason === 'effect' ? 'win.effect' : 'win.simultaneous', { winner, reason });
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
  // attack.copy-previous: an attack printed on a Tool, actually used last turn (JP Q&A ミミッキュ「まねっこ」), is copied too.
  const attack = d?.kind === 'pokemon' ? d.mechanics.attacks.find((a) => a.attackId === reference.attackId) :
    d?.mechanics.category === 'tool' && d.mechanics.grantedAttacks?.find((a) => a.attackId === reference.attackId);
  if (!attack) throw new EngineError('invalid-copy-reference', 'Copied content must be an independently approved printed Pokémon attack.');
  return attack;
}
// effects.supporter-replacement: the binding a changed Supporter runs, the Ability's printed replacement under its own identity.
function replacementBindings(s, catalog, reference) {
  return (cardDef(s, catalog, reference.instanceId).mechanics.abilities ?? []).flatMap((a) => a.effects)
    .filter((b) => b.effectId === reference.effectId && catalog.handler(b.handlerId).operations.includes('handSupporterEffect'))
    .map((b) => ({ effectId: b.effectId, handlerId: b.parameters.effect.replacement.handlerId,
      parameters: clone(b.parameters.effect.replacement.parameters), sourceOfTruth: clone(b.sourceOfTruth) }));
}
// 「只要这只宝可梦在战斗场上，对手手牌里的支援者的效果，都会变为「…」」: a Supporter card used while it is in a hand whose
// holder's opponent has such an Active Pokémon. Judged as it is used; null when its own effect applies.
function supporterReplacement(s, catalog, cardId) {
  const owner = s.cards[cardId].owner;
  if (!s.players[owner].hand.includes(cardId) || cardDef(s, catalog, cardId).mechanics.category !== 'supporter') return null;
  const entries = continuousEntries(s, catalog).filter((e) => e.spec.op === 'handSupporterEffect' && e.source.owner !== owner &&
    s.players[e.source.owner].active?.id === e.source.pokemonId);
  if (!entries.length) return null;
  requireRule(catalog.ruleset, 'effects.supporter-replacement');
  if (entries.length > 1) throw new EngineError('unresolved-supporter-replacement', 'Two effects changing one Supporter need a reviewed ruling.');
  const reference = { instanceId: entries[0].source.instanceId, effectId: entries[0].source.effectId };
  return { reference, binding: replacementBindings(s, catalog, reference)[0] };
}
// The bindings copied or granted content runs: a printed attack's, (effects.copy-supporter) the chosen Supporter card's own,
// or (effects.supporter-replacement) the changed effect.
const copiedEffects = (s, catalog, reference) => Object.hasOwn(reference, 'attackId') ? copiedAttack(s, catalog, reference).effects :
  Object.hasOwn(reference, 'effectId') ? replacementBindings(s, catalog, reference) : cardDef(s, catalog, reference.instanceId).mechanics.effects;
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
    if (!Object.hasOwn(source.contentSource, 'attackId')) {
      // effects.copy-supporter: the chosen Supporter's own binding, run as the copying card's or attack's effect;
      // effects.supporter-replacement: the changed effect, run as the Supporter's or the copy's.
      const record = Object.hasOwn(source.contentSource, 'effectId') ?
        copyRecord(s, source.copyId, 'replaced', 'effects.supporter-replacement') : copyRecord(s, source.copyId, 'selected', 'effects.copy-supporter');
      if (!record || canonicalJSON(record.reference) !== canonicalJSON(source.contentSource) ||
          ['instanceId', 'owner', 'cardOwner', 'category', 'origin', 'pokemonId', 'attackId'].some((k) => record.source[k] !== source[k]) ||
          !copiedEffects(s, catalog, source.contentSource).some((b) => b.effectId === source.effectId &&
            canonicalJSON(b.sourceOfTruth) === canonicalJSON(source.sourceOfTruth))) return false;
      source = record.source; continue;
    }
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
  // A Pokémon's own Ability, or (tools.granted-ability) the one printed on a Tool.
  if (source.category === 'ability') return [...(m.abilities ?? []), ...(m.grantedAbilities ?? [])].some((a) => a.effects.some(sameBinding));
  const category = { pokemon: 'rule', trainer: 'trainer', energy: 'energy' }[d.kind];
  return source.category === category && m.effects.some(sameBinding);
}
function executionBinding(s, catalog, source) {
  if (!validHistorySource(s, catalog, source)) return null;
  const m = cardDef(s, catalog, source.instanceId).mechanics;
  const bindings = source.contentSource ? copiedEffects(s, catalog, source.contentSource) :
    [...m.effects, ...[...(m.abilities ?? []), ...(m.grantedAbilities ?? [])].flatMap((a) => a.effects),
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
  if (origin === 'turnEnd') {
    // effects.turn-end: exactly the program its approved parameters recorded when the card was used.
    if (canonicalJSON(program) !== canonicalJSON(h.execute(deepFreeze({ source: clone(source), event: clone(event) }), clone(binding.parameters))[0].program))
      executionFailure('A turn-end program must retain its exact approved parameters.');
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
  if (h.id === 'cn.countersValue@1' && !binding.parameters.all && !binding.parameters.countFrom) {
    // The computed count is the resolution-time host receipt; the rest is the approved side and target.
    // (A count read for each or a chosen Pokémon stays the approved expression, read when the counters are placed.)
    const { side, target } = binding.parameters;
    if (program.length > 1 || program.length && (canonicalJSON(Object.keys(program[0]).sort()) !== canonicalJSON(['count', 'op', 'side', 'target']) ||
        program[0].op !== 'counters' || program[0].side !== side || program[0].target !== target || !Number.isSafeInteger(program[0].count) || program[0].count < 1))
      executionFailure('A computed counter placement is at most one native placement of a positive count on the approved target.');
    return;
  }
  if (h.id === 'cn.countValue@1') {
    // The computed count is the resolution-time host receipt (nothing at 0, or only the printed look); the rest is the approved leaf
    // written for one (with next, that leaf is the first part of a then).
    const leaf = program[0]?.op === 'then' ? program[0].first.steps?.[0] : program[0];
    const n = program.length === 1 ? leaf?.count ?? leaf?.quantity?.count ?? 0 : 0;
    if (program.length && (!Number.isSafeInteger(n) || n < 0 || canonicalJSON(program) !== canonicalJSON(h.execute(
      deepFreeze({ source: clone(source), event: clone(event) }), { ...clone(binding.parameters), count: { kind: 'literal', value: n } }))))
      executionFailure('A computed count is at most one native leaf of a positive count, otherwise its approved parameters.');
    return;
  }
  // damage.bench-count 「最多与…相同数量的…」「选择与放于弃牌区数量相同数量的…」: the count is the resolution-time host receipt
  // (nothing at 0); the rest is the approved departure or damage packet.
  const counted = { 'cn.countedFieldReturn@1': 'quantity', 'cn.damage@1': 'selection' }[h.id];
  if (counted && typeof binding.parameters[counted].count === 'object') {
    const n = program.length === 1 ? program[0][counted]?.count : 0;
    if (program.length && (!Number.isSafeInteger(n) || n < 1 || canonicalJSON(program) !== canonicalJSON(h.execute(deepFreeze({ source: clone(source),
      event: clone(event) }), { ...clone(binding.parameters), [counted]: { ...binding.parameters[counted], count: { kind: 'literal', value: n } } }))))
      executionFailure('A computed count is at most one native departure or damage packet of a positive count, otherwise its approved parameters.');
    return;
  }
  if (h.id === 'cn.coins@1' && binding.parameters.flips.kind === 'count') {
    // 「抛掷与…数量相同次数的硬币」: the count is the resolution-time host receipt (nothing at 0); the rest is the approved instruction.
    const n = program.length === 1 ? program[0].flips?.count : 0;
    if (program.length && (!Number.isSafeInteger(n) || n < 1 || n > 60 || canonicalJSON(program) !== canonicalJSON(h.execute(
      deepFreeze({ source: clone(source), event: clone(event) }), { ...clone(binding.parameters), flips: { kind: 'count', value: { kind: 'literal', value: n } } }))))
      executionFailure('A counted flip is at most one native flip group of a positive count, otherwise its approved parameters.');
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
  if (['cn.handBottomDraw@1', 'cn.handDeckDraw@1'].includes(h.id)) {
    // Prize-dependent draw counts are resolution-time receipts: the program must
    // match its parameters apart from those counts, and each count must be one
    // the printed instruction allows (at most the 6 Prize cards of II.D-17).
    const specs = [binding.parameters.ownDraw, binding.parameters.opponentDraw];
    // A computed count (kind value) is the resolution-time host receipt, like cn.drawValue@1.
    // A coin's draw (flip) is the native coin step itself, with no count of its own.
    const allowed = (spec, count) => typeof spec === 'number' ? count === spec : spec.kind === 'flip' ? count === undefined :
      spec.kind === 'value' ? Number.isSafeInteger(count) && count >= 0 :
      spec.kind === 'remainingPrizes' ? Number.isSafeInteger(count) && count >= 0 && count <= 6 : count === spec.then || count === spec.otherwise;
    const parameters = clone(binding.parameters);
    for (const key of ['ownDraw', 'opponentDraw']) if (parameters[key]?.kind === 'value') parameters[key] = 0;
    const template = h.execute(deepFreeze({ source: clone(source), event: clone(event),
      state: { players: [{ prizes: [] }, { prizes: [] }] } }), parameters);
    // 「若希望，可让对手…」 (optional): the same pair inside the user's decision.
    const pair = (steps) => binding.parameters.optional ? steps[0]?.effect?.steps?.[0] : steps[0];
    const counts = pair(program)?.next?.steps?.map((step) => step.count) ?? [];
    const normalized = clone(program);
    pair(template).next.steps.forEach((step, i) => { if (pair(normalized)?.next?.steps?.[i]) pair(normalized).next.steps[i].count = step.count; });
    if (canonicalJSON(normalized) !== canonicalJSON(template) || counts.some((count, i) => !allowed(specs[i], count)))
      executionFailure('A Prize-dependent or computed draw cannot change its native program or draw a count its instruction does not allow.');
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
    if (origin === 'turnEnd' && !h.operations.includes('turnEndEffect'))
      executionFailure('Only an explicitly declared turn-end effect can open a turn-end program.');
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
  const nodes = [], sources = [], entries = [], typeEntries = [], typedHolders = [];
  // The type layer reads printed card identities only (it produces the current types).
  const typeTargets = (source, spec) => allMons(s).filter(({ owner, m }) => modifierTargets(s, catalog, source, spec, owner, m) &&
    (!spec.targetCard || matchesCardSelector(playedCard(monDef(s, catalog, m)), spec.targetCard))).map(({ m }) => m.id);
  const add = (kind, instanceId, owner, m, bindings, key = null, granted = false) => {
    const id = sourceNodeId(kind, instanceId, kind === 'ability' ? key : null);
    nodes.push({ id, kind, instanceId, owner, pokemonId: m?.id ?? null, key,
      active: !!m && s.players[owner].active === m, damaged: !!m && m.counters > 0, mechanics: m ? monDef(s, catalog, m).mechanics : null,
      definition: m ? playedCard(monDef(s, catalog, m)) : null, ...(granted ? { granted } : {}),
      ...(kind === 'energy' ? { special: cardDef(s, catalog, instanceId).mechanics.category === 'special' } : {}) });
    const category = kind === 'tool' || kind === 'stadium' ? 'trainer' : kind;
    for (const binding of bindings) sources.push({
      binding, nodeId: id, source: sourceFor(s, catalog, instanceId, owner, category, binding, m?.id ?? null),
    });
  };
  for (const { owner, m } of allMons(s)) {
    const d = monDef(s, catalog, m);
    add('rule', top(m), owner, m, d.mechanics.effects);
    for (const a of d.mechanics.abilities) add('ability', top(m), owner, m, a.effects, a.abilityId);
    // ability.granted 「在离开场上之前都拥有效果为「…」的特性」: one more Ability of this Pokémon, keyed by its effect.
    for (const e of grantedAbilityEntries(s, m)) add('ability', top(m), owner, m, grantedAbilityBindings(e), e.id, true);
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
    for (const [index, described] of specs.entries()) {
      const typeEffect = handler.timing === 'pokemonTypes';
      // selection.context 「变为与这只宝可梦身上附有的基本能量相同的属性」: those cards' types now (none: no change); checked against
      // what they provide once Energy provision, a later layer, is known.
      const read = typeEffect && described.typesFrom ? attachedBasicTypes(s, catalog, source.pokemonId) : null;
      if (read && !read.length) continue;
      if (read) typedHolders.push(source.pokemonId);
      const spec = read ? { op: described.op, types: read, scope: described.scope } : described;
      if (!(typeEffect ? validatePokemonTypesEffect(spec) : validateSuppressionEffect(spec)) || !handler.operations.includes(spec.op))
        throw new EngineError('invalid-handler', 'Invalid or undeclared suppression effect.');
      const entry = { id: canonicalJSON([binding.effectId, source.instanceId, index]), sourceNodeId: nodeId,
        source, spec, sourceOfTruth: binding.sourceOfTruth };
      if (typeEffect) {
        if (!spec.sourceEnergy || findMon(s, source.pokemonId)?.m.energy.some((id) => matchesCardSelector(cardDef(s, catalog, id), spec.sourceEnergy)))
          typeEntries.push({ ...entry, targets: typeTargets(source, spec) });
      }
      // 「如果这只宝可梦身上放有「X」的话」 reads the physical Tool card (I.B-02), never an effect.
      else if (!spec.sourceTool || findMon(s, source.pokemonId)?.m.tools.some((id) => matchesCardSelector(cardDef(s, catalog, id), spec.sourceTool)))
        entries.push(entry);
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
  // effects.player-ability-removal 「在这个回合结束前，对手战斗宝可梦的特性，全部消除。（也包括新被放于战斗场的宝可梦。）」.
  for (const e of s.playerOngoing) if (e.effect.op === 'suppression' && ongoingIsActive(e, s)) {
    const nodeId = sourceNodeId('fixed', e.id);
    nodes.push({ id: nodeId, kind: 'fixed', owner: e.source.owner, pokemonId: null });
    entries.push({ id: e.id, sourceNodeId: nodeId, source: e.source, ...(e.exemptId ? { exemptId: e.exemptId } : {}),
      spec: e.effect, sourceOfTruth: e.source.sourceOfTruth });
  }
  const traits = typeEntries.length ? resolveSourceTraits(nodes, entries, typeEntries,
    allMons(s).map(({ m }) => ({ id: m.id, printedTypes: monDef(s, catalog, m).mechanics.types }))) : null;
  const availability = traits?.availability ?? resolveSuppression(nodes, entries), pokemon = {};
  for (const { m } of allMons(s)) pokemon[m.id] = {
    types: clone(traits?.pokemonTypes.get(m.id).types ?? monDef(s, catalog, m).mechanics.types),
    typeChanges: clone(traits?.pokemonTypes.get(m.id).trace ?? []),
    abilities: [...monDef(s, catalog, m).mechanics.abilities.map((a) => a.abilityId), ...grantedAbilityEntries(s, m).map((e) => e.id)]
      .map((abilityId) => ({ abilityId, present: availability.get(sourceNodeId('ability', top(m), abilityId)).enabled,
        removedBy: availability.get(sourceNodeId('ability', top(m), abilityId)).removedBy })),
    toolEffects: m.tools.map((id) => ({ instanceId: id, ...availability.get(sourceNodeId('tool', id)) })),
  };
  // 「…手牌中、弃牌区中的…特性，全部消除」: the enabled outOfPlay removals, read for a hand or discard card's Ability (ability.zone).
  const zoneSuppressions = entries.filter((e) => e.spec.outOfPlay && availability.get(e.sourceNodeId).enabled)
    .map((entry) => ({ entry, source: nodes.find((n) => n.id === entry.sourceNodeId) }));
  const model = { nodes, sources, availability, pokemon, attackGrants: [], zoneSuppressions }, provisions = [];
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
      (!e.spec.otherAttached || m.energy.some((other) => other !== id && matchesCardSelector(cardDef(s, catalog, other), e.spec.otherAttached))) &&
      (!e.spec.condition || continuousConditionMet(s, catalog, e.source, e.spec.condition, model)))
      .map((e) => ({ id: e.id, units: e.spec.units, sourceOfTruth: e.sourceOfTruth }));
    // 「特殊能量的效果全部消除，被视作1个【无】能量」: a Special Energy whose effects are removed provides 1 Colorless.
    if (!availability.get(sourceNodeId('energy', id)).enabled) return { instanceId: id, ...resolveEnergyProvision([['Colorless']], []) };
    return { instanceId: id, ...resolveEnergyProvision(cardDef(s, catalog, id).mechanics.baseUnits, replacements) };
  });
  // JP Q&A カクレオン「いろいろへんげ」×バクフーン「バーニングエナジー」: a Basic Energy working as another type gives that type. Read
  // before provision, the cards' own types stand only while they provide just that; otherwise the two layers need a CN ruling.
  for (const id of typedHolders) if (pokemon[id].energies.some((e) => {
    const d = cardDef(s, catalog, e.instanceId);
    return d.mechanics.category === 'basic' && e.units.flat().some((t) => t !== d.mechanics.baseUnits[0][0]);
  })) throw new EngineError('unsupported-type-provision', 'A type read from attached Basic Energy that provides another type needs a CN ruling.');
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

// ability.granted: the Abilities an effect gave this Pokémon (「在离开场上之前都拥有…的特性」), and their continuous entries as bindings
// of that effect's own source; each is keyed by its ledger entry, so two grants are two Abilities.
const grantedAbilityEntries = (s, m) => s.ongoing.filter((e) => e.effect.op === 'abilityGrant' && e.targetId === m.id);
const grantedAbilityBindings = (e) => e.effect.effects.map((n, i) => ({ effectId: `${e.id}:${i}`, handlerId: n.handlerId,
  parameters: clone(n.parameters), sourceOfTruth: e.source.sourceOfTruth }));
// selection.context: a selector's board reads made now (null: nothing to read, so no card matches).
function contextSelector(s, catalog, source, event, selector) {
  if (!hasContextFields(selector)) return selector;
  requireRule(catalog.ruleset, 'selection.context');
  return resolveContextSelector(selector, effectContext(s, catalog, source, event));
}
// selection.context: the types of the Basic Energy cards attached to this Pokémon (the type layer reads cards, not provision).
const attachedBasicTypes = (s, catalog, pokemonId) => [...new Set(findMon(s, pokemonId).m.energy.map((id) => cardDef(s, catalog, id))
  .filter((d) => d.mechanics.category === 'basic').map((d) => d.mechanics.baseUnits[0][0]))];
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
    context.enterLocks = [0, 1].map((player) => enterLocks(s, catalog, player, model));
    // 「…「宝可梦道具」，放于这只宝可梦身上」: whether this Pokémon can hold one more Tool now (tools.capacity).
    const self = !local && source.pokemonId ? findMon(s, source.pokemonId) : null;
    if (self) context.sourceToolRoom = self.m.tools.length < toolCapacity(s, catalog, self.m, model);
    context.handLocks = [0, 1].map((player) => handLockSelectors(s, catalog, player, model));
  }
  return deepFreeze(context);
}
function effectTasks(s, catalog, instanceId, owner, category, bindings, timing, pokemonId = null, attackId = null, payment = null, execution = null, origin = null) {
  const out = [];
  for (const binding of bindings) {
    const handler = catalog.handler(binding.handlerId);
    const phase = handler.timing || 'resolve';
    if (phase !== timing || binding.trigger) continue;
    const source = sourceFor(s, catalog, instanceId, owner, category, binding, pokemonId, attackId, origin, execution);
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
    owner: event.owner, definitionId: event.definitionId, types: event.effectiveTypes, ...attackerReceipt(event) });
  return event;
}
// trigger.damage-filters: the attacking Pokémon of an attack-damage event, as it was then.
const attackerReceipt = (event) => event.attacker ? { attacker: clone(event.attacker) } : {};
function collectTriggers(s, catalog, events) {
  const registrations = [], model = sourceModel(s, catalog);
  const add = (trigger, bindings, owner, instanceId, category, pokemonId, ability = null) => {
    if (!trigger || ['beforeHand', 'discarded'].includes(trigger.event)) return;
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
    const source = r.reaction?.source ?? r.bindings[0].source;
    if (r.reaction && event.subjectId !== r.reaction.targetId) continue;
    if (r.reaction?.effect.priorEventIds.includes(event.id)) continue;
    const observer = r.reaction ? { ...source, pokemonId: r.reaction.targetId } : source;
    // trigger.alternatives 「…时，以及…时，各可使用1次」: the first alternative this event matches starts it, once.
    const trigger = [r.trigger].flat().find((t) => {
      // Checkup predicates are evaluated when the holder's chosen before/after
      // slot resolves, not prematurely before status recovery.
      const descriptor = clone(t);
      if (event.kind === 'checkup') delete descriptor.rotation;
      // trigger.sleep-not-recovered: only a Pokémon Asleep as the checkup starts can stay Asleep through its Sleep check.
      if (descriptor.sleepNotRecovered) { delete descriptor.sleepNotRecovered; descriptor.rotation = 'asleep'; }
      return triggerMatches(descriptor, event, observer, {
        sourceActive: s.players[r.reaction ? event.owner : source.owner].active?.id === observer.pokemonId,
        definition: catalog.definition(event.definitionId), ...subjectFacts(s, catalog, event),
      }) && triggerConditionMet(s, catalog, t, source, model);
    });
    if (!trigger) continue;
    units.push({ id: `t${++s.serial}`, owner: event.owner,
      controller: trigger.choiceOwner === 'affected' ? event.owner : source.owner,
      trigger: clone(trigger), abilityId: r.ability?.abilityId ?? null,
      specialRule: r.ability?.specialRule ?? null, usage: clone(r.ability?.usage ?? null),
      bindings: clone(r.bindings), event: clone(event), ...(r.reaction ? { reaction: clone(r.reaction) } : {}) });
  }
  return units;
}
// trigger.condition 「如果自己场上有「X」的话，则能生效」: judged from the source like a continuous condition.
function triggerConditionMet(s, catalog, trigger, source, model = null) {
  return !trigger.condition || continuousConditionMet(s, catalog, source, trigger.condition, model ?? sourceModel(s, catalog));
}
// trigger.group (II.E-15) 「这个效果，无论拥有这个特性的宝可梦有多少只，都不会叠加」: of one player's still available triggers
// of a group, one event starts only the first.
const groupKey = (u) => u.trigger.group ? canonicalJSON([u.trigger.group, u.bindings[0].source.owner, u.event.id]) : null;
function collapseGroups(units) {
  return units.filter((u, i) => !u.trigger.group || units.findIndex((v) => groupKey(v) === groupKey(u)) === i);
}
const endsTurnOnly = (program) => program.every((a) => a.op === 'endTurn');
function triggerWork(s, catalog, events) {
  const units = collectTriggers(s, catalog, events);
  return units.length ? [tasks('trigger-window', { units })] : [];
}
function triggerStillAvailable(s, catalog, unit, model = sourceModel(s, catalog)) {
  // effects.end-turn-reaction: once its event happened, the turn ends even if the Pokémon then left (JP Q&A ワープエネルギー).
  if (unit.reaction) return endsTurnOnly(unit.reaction.effect.program) || s.ongoing.some((e) => e.id === unit.reaction.id && ongoingIsActive(e, s));
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
    definitionId: event.definitionId, types: event.effectiveTypes, ...attackerReceipt(event),
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
    const bindings = first.contentSource ? copiedEffects(s, catalog, first.contentSource) :
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
        ![ability?.trigger ?? item.binding.trigger].flat().some((t) => canonicalJSON(t) === canonicalJSON(unit.trigger)) ||
        item.source.effectId !== item.binding.effectId ||
        canonicalJSON(item.source.sourceOfTruth) !== canonicalJSON(item.binding.sourceOfTruth))
      throw new EngineError('invalid-trigger-binding', 'Pending trigger bindings must match their independently approved source.');
  }
}
function addCounters(s, catalog, owner, mon, count, cause) {
  if (!Number.isSafeInteger(mon.counters + count) || mon.counters + count > 900719925474099)
    throw new EngineError('numeric-overflow', 'Damage counters and their ten-point conversion must both remain exact.');
  const wasLethal = mon.counters * 10 >= hp(s, catalog, owner, mon), fullHp = mon.counters === 0;
  mon.counters += count;
  if (!wasLethal && mon.counters * 10 >= hp(s, catalog, owner, mon)) {
    mon.facts.knockoutCause = clone(cause);
    // trigger.full-hp-knockout 「在HP为全满的状态下，受到…招式的伤害而【昏厥】时」: this lethal attack damage began at full HP (II.D-14).
    if (fullHp && cause.kind === 'attackDamage') mon.facts.knockoutFromFullHp = true; else delete mon.facts.knockoutFromFullHp;
  }
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
  // II.D-16 「剩余HP在「N」以下」: never on an HP modifier (the schema), so reading the maximum HP cannot loop.
  if (spec.targetRemainingHpAtMost !== undefined && hp(s, catalog, owner, m) - m.counters * 10 > spec.targetRemainingHpAtMost) return false;
  // 「【撤退】所需能量为4个的宝可梦」: the current Retreat Cost (never on a retreat modifier, so it cannot read itself).
  if (spec.targetRetreatCost !== undefined && retreatCost(s, catalog, owner, m) !== spec.targetRetreatCost) return false;
  // 「拥有【超】属性弱点的宝可梦」: the current Weakness (never on a property, so it cannot read itself).
  if (spec.targetWeakness && effectiveProperty(s, catalog, owner, m, 'weakness')?.type !== spec.targetWeakness) return false;
  return !spec.type || (model ?? sourceModel(s, catalog)).pokemon[m.id].types.includes(spec.type);
}
// The other Pokémon of an attack (II.A printed filters): the attacker of an attack source.
function otherMatches(s, catalog, spec, other, model) {
  return !(spec.otherSelector || spec.otherState || spec.otherRemainingHpAtMost !== undefined) ||
    !!other && pokemonMatches(s, catalog, model, other.m, { selector: spec.otherSelector, state: spec.otherState }) &&
      (spec.otherRemainingHpAtMost === undefined || hp(s, catalog, other.owner, other.m) - other.m.counters * 10 <= spec.otherRemainingHpAtMost);
}
// 「不会陷入（【X】）特殊状态（，已经处于的…也全部恢复）」 (status.immunity): the immunities covering this Pokémon.
function immunities(s, catalog, owner, m, model = sourceModel(s, catalog), entries = continuousEntries(s, catalog, model)) {
  return entries.filter((entry) => entry.spec.op === 'conditionImmunity' && entryTargets(s, catalog, entry, owner, m, model));
}
const covers = (entry, condition) => !entry.spec.conditions || entry.spec.conditions.includes(condition);
function enforceConditionImmunity(s, catalog) {
  const affected = allMons(s).filter(({ m }) => presentConditions(m.conditions).length);
  if (!affected.length) return;
  const model = sourceModel(s, catalog), entries = continuousEntries(s, catalog, model);
  for (const { owner, m } of affected) {
    const recovering = immunities(s, catalog, owner, m, model, entries).filter((e) => !e.spec.preventOnly);
    const present = presentConditions(m.conditions).filter((c) => recovering.some((e) => covers(e, c)));
    if (!present.length) continue;
    m.conditions = cureConditions(m.conditions, present);
    log(s, 'status.immunity', { player: owner, targetId: m.id, conditions: present });
  }
}
function entryTargets(s, catalog, entry, owner, mon, model = null) {
  return (!entry.targetId || entry.targetId === mon.id) &&
    modifierTargets(s, catalog, entry.source, entry.spec, owner, mon, model);
}
// effects.knockout-condition 「如果因这个招式的伤害，对手的宝可梦【昏厥】的话」: a Knock Out by that attack's damage, recorded after the effect began.
const knockedOutByDamage = (s, { attack, from }) => s.battleHistory.events.slice(from).some((k) => k.kind === 'ko' &&
  k.cause.kind === 'attackDamage' && sameAttack(attack, k.cause.source));
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
  for (const entry of s.ongoing) if (!['reaction', 'suppression', 'pokemonTypes', 'abilityGrant'].includes(entry.effect.op) && ongoingIsActive(entry, s) &&
      (!entry.knockedOutBy || knockedOutByDamage(s, entry.knockedOutBy)))
    result.push({ spec: entry.effect, source: entry.source, targetId: entry.targetId,
      id: entry.id, sourceOfTruth: entry.source.sourceOfTruth });
  // A player's own boost or damage option (「在这个回合，自己的…宝可梦所使用的招式…「+N」／不计算…」) applies to that player's Pokémon;
  // 「（也包括新出场的宝可梦）」 restrictions, damage received, protection and erased costs cover every Pokémon of their scope.
  for (const entry of s.playerOngoing) if (PLAYER_POKEMON_OPS.includes(entry.effect.op) && ongoingIsActive(entry, s))
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
    // 「如果身上放有这张卡牌的宝可梦的弱点的属性，和对手的战斗宝可梦的属性相同的话」 (damage.weakness-type): the damaged Pokémon has a
    // current type of the attacker's current Weakness (属性相同 as in the Weakness step); attackDamage only, so a packet is always there.
    if (spec.otherTypeIsWeakness) {
      requireRule(catalog.ruleset, 'damage.weakness-type');
      if (!model.pokemon[packet.target.m.id].types.includes(effectiveProperty(s, catalog, owner, mon, 'weakness')?.type)) continue;
    }
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
    // 「每附有1个【钢】能量」: the units attached to the affected Pokémon that can provide that type now.
    const per = spec.perPrizesTaken ? prizesTakenCount(s, catalog, entry.source, spec.perPrizesTaken) :
      spec.perEnergyType ? model.pokemon[mon.id].energies.flatMap((e) => e.units).filter((u) => u.includes(spec.perEnergyType)).length : 1;
    result.push({ id: `${id}/${field}`, amount: spec.amount * per, sourceOfTruth,
      ...(spec.discardCard ? { discardCardId: entry.source.instanceId } : {}) });
  }
  return result;
}
function monProhibited(s, catalog, owner, mon, action, attackId = null, route = null) {
  const entries = continuousEntries(s, catalog);
  if (entries.some((entry) => entry.spec.op === 'restriction' &&
      entry.spec.actions.includes(action) && entryTargets(s, catalog, entry, owner, mon) &&
      (action !== 'attack' || (!entry.spec.attackIds || entry.spec.attackIds.includes(attackId)) &&
        (!entry.spec.specialRules || entry.spec.specialRules.includes(route.attack.specialRule))))) return true;
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
// 「无法从手牌使出卡牌」 (effects.player-lock): which of the player's hand cards cannot come into play or be used now — all of them, or with
// a cardSelector (「无法从手牌使出【ACE SPEC】卡牌」「无法从手牌将拥有特性的宝可梦（除「火箭队的宝可梦」外）放于场上」) those matching it as
// printed in the hand (a card printed as an Item is that Item).
function handLock(s, catalog, player) {
  const all = playerProhibited(s, catalog, player, 'playFromHand', (spec) => !spec.cardSelector);
  const selectors = all ? [] : handLockSelectors(s, catalog, player, sourceModel(s, catalog));
  if (selectors.length) requireRule(catalog.ruleset, 'effects.player-lock-cards');
  return { all, card: (id) => all || selectors.some((selector) => matchesCardSelector(cardDef(s, catalog, id), selector)) };
}
const handLocked = (s, catalog, player, cardId) => handLock(s, catalog, player).card(cardId);
// The card selectors of a player's current card locks from the hand (handlers read them as ctx.handLocks).
function handLockSelectors(s, catalog, player, model) {
  if (!model.sources.some(({ binding }) => catalog.handler(binding.handlerId).operations?.includes('playerRestriction'))) return [];
  return playerRestrictions(s, catalog, player, 'playFromHand', model).filter(({ spec }) => spec.cardSelector).map(({ spec }) => spec.cardSelector);
}
// ability.zone: a hand card's own Ability stops under every full hand lock; under a card lock only when it puts that card into play
// (「无法从手牌将…宝可梦放于场上」).
function handAbilityLocked(s, catalog, player, cardId, ability) {
  const lock = handLock(s, catalog, player);
  return lock.all || ability.effects.some((b) => b.handlerId === 'cn.deploySelf@1') && lock.card(cardId);
}
function playerProhibited(s, catalog, player, action, applies = () => true) {
  if (s.playerOngoing.some((e) => e.player === player && ongoingIsActive(e, s) && e.effect.op === 'playerRestriction' &&
      e.effect.actions.includes(action))) return true;
  return playerRestrictions(s, catalog, player, action).some(({ spec }) => applies(spec));
}
const playerRestrictions = (s, catalog, player, action, model = null) => continuousEntries(s, catalog, model).filter(({ spec, source }) =>
  spec.op === 'playerRestriction' && spec.actions.includes(action) && (spec.scope === 'all' || (spec.scope === 'own') === (source.owner === player)) &&
  (!spec.sourceActive || s.players[source.owner].active?.id === source.pokemonId));
// effects.enter-lock 「无法将其他属性的宝可梦放于自己场上」: the kinds of Pokémon card a player cannot put into play now.
function enterLocks(s, catalog, player, model) {
  if (!model.sources.some(({ binding }) => catalog.handler(binding.handlerId).operations?.includes('playerRestriction'))) return [];
  return playerRestrictions(s, catalog, player, 'enterPlay', model).map(({ spec }) => spec.cardSelector);
}
// I.A-04: five Benched Pokémon unless a continuous printed effect changes the
// limit for a player it names who currently satisfies its in-play requirement.
function benchLimit(s, catalog, player, model = null) {
  if (s.phase === 'setup') return 5;
  model ??= sourceModel(s, catalog);
  if (!model.sources.some(({ binding }) => catalog.handler(binding.handlerId).operations?.includes('benchLimit'))) return 5;
  // 「关于变更备战宝可梦的数量的效果，优先执行数量更少的效果」: of the changed limits that apply to this player, the smallest.
  const limits = continuousEntries(s, catalog, model).filter(({ spec, source }) => spec.op === 'benchLimit' &&
    (spec.scope === 'all' || (spec.scope === 'own') === (source.owner === player)) &&
    (!spec.sourceActive || s.players[source.owner].active?.id === source.pokemonId) &&
    (!spec.requires || mons(s.players[player]).some((m) => matchesInPlaySelector(monDef(s, catalog, m), spec.requires, model.pokemon[m.id].types))))
    .map(({ spec }) => spec.limit);
  return limits.length ? Math.min(...limits) : 5;
}
// I.B-02: one Tool per Pokémon unless its own continuous effect allows more (「这只宝可梦身上可以最多放N张「宝可梦道具」」).
function toolCapacity(s, catalog, m, model = null) {
  model ??= sourceModel(s, catalog);
  if (!model.sources.some(({ binding }) => catalog.handler(binding.handlerId).operations?.includes('toolCapacity'))) return 1;
  return Math.max(1, ...continuousEntries(s, catalog, model)
    .filter(({ spec, source }) => spec.op === 'toolCapacity' && source.pokemonId === m.id).map(({ spec }) => spec.count));
}
const toolRoom = (s, catalog, m) => m.tools.length < toolCapacity(s, catalog, m);
// A Tool played from the hand: a Pokémon with room, unless its printed 「（当将这张卡牌从手牌使出放于宝可梦身上时，如果会导致该宝可梦【昏厥】的话，
// 则无法放于该宝可梦身上。）」 names it (tools.hand-attach-except), judged now and as printed (also while Tool effects are removed).
function toolTarget(s, catalog, m, def) {
  if (!toolRoom(s, catalog, m)) return false;
  const except = def.mechanics.handAttachExcept;
  if (!except) return true;
  requireRule(catalog.ruleset, 'tools.hand-attach-except');
  return !pokemonMatches(s, catalog, sourceModel(s, catalog), m, except);
}
function effectiveProperty(s, catalog, owner, mon, field) {
  const values = continuousEntries(s, catalog).filter((entry) =>
    entry.spec.op === 'property' && entry.spec.field === field && entryTargets(s, catalog, entry, owner, mon));
  if (new Set(values.map(({ spec }) => canonicalJSON(spec.value))).size > 1)
    throw new EngineError('unsupported-property-conflict', 'Conflicting property replacements need explicit card ordering.');
  return values.length ? values[0].spec.value : monDef(s, catalog, mon).mechanics[field];
}
// ko.lost-zone 「每当…宝可梦昏厥时，不将该宝可梦放于弃牌区，而是放于放逐区（除宝可梦以外的卡牌，全部放于弃牌区）」 (Pokémon
// cards to the Lost Zone); all = 「该宝可梦以及放于其身上的所有卡牌」; byOwnAttack = 「因这只宝可梦的招式的伤害…昏厥」. Read on the
// board at the Knock Out. When both kinds apply, the Knocked Out Pokémon's owner chooses which comes first (JP Q&A, Lost City ×
// Tyranitar-GX); the Pokémon-only one, which leaves every other card in the discard pile, is taken as that choice.
// ko.hand 「受到对手宝可梦的招式的伤害而【昏厥】时，不放于弃牌区，而是放回手牌」 (to hand, byOpponentAttack): its Pokémon cards to the
// hand instead. When it and a Lost Zone one both apply, the owner chooses which comes first (JP Q&A ギルガルド × ロストシティ): chosen
// is that choice, absent while it is still open ({ choice: true }).
function knockoutZone(s, catalog, item, chosen = null, record = false) {
  const found = findMon(s, item.id);
  if (!found) return null;
  const entries = continuousEntries(s, catalog).filter((e) => e.spec.op === 'knockoutZone' && entryTargets(s, catalog, e, item.owner, found.m) &&
    (!e.spec.byOwnAttack || item.cause.kind === 'attackDamage' && item.cause.source.pokemonId === e.source.pokemonId) &&
    (!e.spec.byOpponentAttack || item.cause.kind === 'attackDamage' && item.cause.source.owner !== item.owner));
  // ko.attack-lost-zone 「将受到这个招式的伤害而昏厥的宝可梦以及放于其身上的所有卡牌放于放逐区」: Knocked Out by that attack's damage.
  const attack = s.playerOngoing.filter((e) => e.effect.op === 'attackKnockoutZone' && ongoingIsActive(e, s) &&
    item.cause.kind === 'attackDamage' && sameAttack(e.effect.attack, item.cause.source)).map((e) => ({ id: e.id, spec: { cards: 'all' } }));
  // effects.move-lock: a hand the Pokémon cannot be put into is no destination (JP Q&A バリヤード × ギルガルド「くちないつるぎ」).
  const hand = entries.filter((e) => e.spec.to === 'hand' && !keptCards(s, catalog, e.source, found.m.stack,
    { zone: 'field', to: 'hand', holder: item.owner, pokemon: found.m }, record).length), lost = [...entries.filter((e) => e.spec.to !== 'hand'), ...attack];
  if (!hand.length && !lost.length) return null;
  if (hand.length && lost.length && !chosen) return { choice: true };
  // Returned to the hand first, its other cards still go to the Lost Zone by the attack (JP Q&A ロストクライシス × レスキューエネルギー).
  if (hand.length && (!lost.length || chosen === 'hand')) return { to: 'hand', cards: 'pokemon', effects: hand.map((e) => e.id),
    ...(attack.length ? { rest: 'lost', restEffects: attack.map((e) => e.id) } : {}) };
  const cards = lost.some((e) => e.spec.cards === 'pokemon') ? 'pokemon' : 'all';
  return { cards, effects: lost.filter((e) => e.spec.cards === cards).map((e) => e.id) };
}
const koZoneOpen = (s, catalog, batch, zones) => batch.find((item) => !zones[item.id] && knockoutZone(s, catalog, item)?.choice);
// 「双方所有宝可梦的弱点，均以「×4」计算伤害」: the same Weakness type, applied with this multiplier instead.
function effectiveWeakness(s, catalog, owner, mon) {
  const weakness = effectiveProperty(s, catalog, owner, mon, 'weakness'), times = effectiveProperty(s, catalog, owner, mon, 'weaknessMultiplier');
  return weakness && times && weakness.operation === 'multiply' ? { ...weakness, value: times } : weakness;
}
function protectionEntries(s, catalog, source, owner, mon, channel) {
  const model = sourceModel(s, catalog);
  return continuousEntries(s, catalog, model).filter((entry) => {
    const { spec } = entry;
    if (spec.op !== 'protection' || spec.channel !== channel ||
        !entryTargets(s, catalog, entry, owner, mon, model) ||
        !spec.categories.includes(source.category) ||
        !otherMatches(s, catalog, spec, source.category === 'attack' ? findMon(s, source.pokemonId) : null, model)) return false;
    // 「不受对手宝可梦所使用的GX招式的伤害和效果影响」: the attack being used, as a GX attack (a copied one too).
    if (spec.specialRules && !(s.attack?.player === source.owner && s.attack.usedSpecialRules.some((r) => spec.specialRules.includes(r)))) return false;
    if ((spec.from === 'own' && source.owner !== owner) || (spec.from === 'opponent' && source.owner === owner)) return false;
    return source.category !== 'trainer' ||
      ((!spec.trainerCategories || spec.trainerCategories.includes(cardDef(s, catalog, source.instanceId).mechanics.category)) &&
       (!spec.trainerOrigins || spec.trainerOrigins.includes(source.origin)));
  });
}
function protections(s, catalog, source, owner, mon, channel) {
  return protectionEntries(s, catalog, source, owner, mon, channel).map(({ id, sourceOfTruth, spec }) => ({
    id, sourceOfTruth, ...(spec.useRule === 'CN.E29' ? { useRule: spec.useRule, ruleId: 'effects.trainer-hand-use' } : {}),
    ...(spec.coin ? { coin: true } : {}), ...(spec.damageAtMost ? { atMost: spec.damageAtMost } : {}),
    ...(spec.damageAtLeast ? { atLeast: spec.damageAtLeast } : {}), ...(spec.damageValues ? { values: spec.damageValues } : {}),
  }));
}
function stadiumProtections(s, catalog, source) {
  return continuousEntries(s, catalog).filter(({ spec, source: provider }) =>
    spec.op === 'stadiumProtection' && matchesStadiumProtection(
      effectContext(s, catalog, provider), spec, source));
}
// counters: 「不会因为…的效果而被放置伤害指示物」 also stops this effect's damage counters.
function effectBlocked(s, catalog, source, owner, mon, counters = false) {
  const effects = [...protections(s, catalog, source, owner, mon, 'effects'), ...(counters ? protections(s, catalog, source, owner, mon, 'counters') : [])];
  if (effects.length) log(s, 'effects.protection', { targetId: mon.id, effectId: source.effectId, effects });
  return effects.length > 0;
}
// effects.move-lock 「对手弃牌区中的卡牌，就无法因为对手的特性或训练家的效果，被加入对手的手牌」「对手场上的宝可梦，以及放于其身上的所有卡牌，
// 都无法被放回手牌」「自己的牌库，就不会受到因对手的…而导致的将牌库的卡牌放于弃牌区的效果影响」: a move is keyed on the zone the card is in
// (discard pile, deck, or on an in-play Pokémon), where it would go (a deck end or shuffle is the deck; never the Lost Zone, Bench or Prizes),
// the card, and the moving effect (source: its player and kind). The effect may still choose the card; it just stays (JP Q&A ホーホー).
const LOCK_DESTINATIONS = { hand: 'hand', deck: 'deck', deckShuffle: 'deck', deckTop: 'deck', deckBottom: 'deck', shuffleBottom: 'deck', discard: 'discard' };
function moveLockEntries(s, catalog, source, move, model) {
  if (!model.sources.some(({ binding }) => catalog.handler(binding.handlerId).operations?.includes('moveLock'))) return [];
  return continuousEntries(s, catalog, model).filter(({ spec, source: lock }) => spec.op === 'moveLock' && spec.zone === move.zone &&
    spec.to.includes(move.to) && (move.zone === 'field' ? modifierTargets(s, catalog, lock, spec, move.holder, move.pokemon, model) :
      (spec.scope === 'all' || (spec.scope === 'own') === (lock.owner === move.holder)) &&
      (!spec.sourceActive || s.players[lock.owner].active?.id === lock.pokemonId)) &&
    (!spec.from || (spec.from === 'own') === (source.owner === lock.owner)) &&
    (!spec.categories || spec.categories.includes(source.category) && (source.category !== 'trainer' || !spec.trainerCategories ||
      spec.trainerCategories.includes(cardDef(s, catalog, source.instanceId).mechanics.category))) &&
    // A Pokémon not affected by the lock's own effects keeps no lock (JP Q&A バリヤード × メガジュカインEX「θストップ」).
    (move.zone !== 'field' || !protectionEntries(s, catalog, lock, move.holder, move.pokemon, 'effects').length));
}
// The cards of ids an applicable lock keeps where they are (also a discard-pile card's own printed lock), logged once unless record is false.
function keptCards(s, catalog, source, ids, move, record = true) {
  const to = LOCK_DESTINATIONS[move.to];
  if (!to || !ids.length) return [];
  const model = sourceModel(s, catalog), entries = moveLockEntries(s, catalog, source, { ...move, to }, model), locks = new Map();
  const kept = ids.filter((id) => {
    const def = cardDef(s, catalog, id), found = [...entries.filter(({ spec }) => !spec.cards || matchesCardSelector(def, spec.cards)),
      ...(move.zone === 'discard' && def.mechanics.discardPileLock?.to.includes(to) ? [{ id: canonicalJSON(['discardPileLock', id]), sourceOfTruth: def.sourceOfTruth }] : [])];
    for (const lock of found) locks.set(lock.id, { id: lock.id, sourceOfTruth: lock.sourceOfTruth });
    return found.length > 0;
  });
  if (record && kept.length) log(s, 'effects.move-lock', { player: move.holder, zone: move.zone, to, cards: [...kept],
    effectId: source.effectId ?? null, locks: [...locks.values()] });
  return kept;
}
// 「…将牌库的卡牌放于弃牌区的效果」: such an effect does nothing to that deck — no look, no shuffle (JP Q&A ビーダル「あんしんダム」).
function deckLocked(s, catalog, source, holder) {
  const locks = moveLockEntries(s, catalog, source, { zone: 'deck', to: 'discard', holder }, sourceModel(s, catalog));
  if (locks.length) log(s, 'effects.move-lock', { player: holder, zone: 'deck', to: 'discard', effectId: source.effectId,
    locks: locks.map(({ id, sourceOfTruth }) => ({ id, sourceOfTruth })) });
  return locks.length > 0;
}
// A whole Pokémon leaving: locked if any of its Pokémon cards is; an attached card it would take along that is locked alone has no ruling.
function pokemonLocked(s, catalog, source, m, holder, to, attachedTo) {
  if (keptCards(s, catalog, source, m.stack, { zone: 'field', to, holder, pokemon: m }).length) return true;
  if (keptCards(s, catalog, source, [...m.energy, ...m.tools], { zone: 'field', to: attachedTo, holder, pokemon: m }, false).length)
    throw new EngineError('unresolved-move-lock', 'A locked attached card of a Pokémon that leaves needs its own CN ruling, not a guessed destination.');
  return false;
}
function targetedPokemon(s, owner, source, event, target) {
  const p = s.players[owner];
  return mons(p).filter((m) =>
    target === 'active' ? m === p.active : target === 'bench' ? m !== p.active :
    target === 'self' ? m.id === source.pokemonId : target === 'event' ? m.id === event?.subjectId :
    target === 'attacker' ? m.id === event?.cause.source?.pokemonId : true);
}
// A trigger's 「拥有特性的宝可梦」: the event Pokémon's current derived view while it is still in play.
function subjectFacts(s, catalog, event) {
  return { subjectEffective: () => findMon(s, event.subjectId) ? sourceModel(s, catalog).pokemon[event.subjectId] ?? null : null,
    definitionOf: (id) => cardDef(s, catalog, id) };
}
// The printed side's holders' attached Tools of the printed kind (and, 「「宝可梦道具」「特殊能量」」, their Special Energy cards).
function toolCards(s, catalog, source, event, a) {
  const owners = a.side === 'both' ? [source.owner, 1 - source.owner] : [a.side === 'opponent' ? 1 - source.owner : source.owner];
  return owners.flatMap((owner) => targetedPokemon(s, owner, source, event, a.target).flatMap((m) => [...m.tools
    .filter((id) => !a.selector || matchesCardSelector(cardDef(s, catalog, id), a.selector)).map((id) => ({ id, owner, m, kind: 'tool' })),
  ...(a.specialEnergy ? m.energy.filter((id) => cardDef(s, catalog, id).mechanics.category === 'special').map((id) => ({ id, owner, m, kind: 'energy' })) : [])]));
}
// 「给身上放置有伤害指示物的对手所有的宝可梦」「拥有特性的宝可梦」: the printed kind and state, read when the counters are placed.
function countersPool(s, catalog, source, a, targetOwner) {
  const pool = targetedPokemon(s, targetOwner, source, null, a.target);
  if (!a.targetSelector && !a.targetState) return pool;
  const model = sourceModel(s, catalog);
  return pool.filter((m) => pokemonMatches(s, catalog, model, m, { selector: a.targetSelector, state: a.targetState }));
}
function damageOptions(s, catalog, source, attack) {
  const options = {};
  for (const b of attack.effects) {
    const h = catalog.handler(b.handlerId);
    if (h.timing === 'damageOptions') {
      const own = { ...source, effectId: b.effectId, sourceOfTruth: b.sourceOfTruth };
      if (b.parameters.condition && !conditionPredicateMet(s, catalog, own, b.parameters.condition)) continue;
      const value = h.damageOptions(effectContext(s, catalog, own), clone(b.parameters));
      if (!value || Object.keys(value).some((key) => !['ignoreWeakness', 'ignoreResistance', 'ignoreDefenderEffects', 'applyBenchWeaknessResistance'].includes(key) || value[key] !== true))
        throw new EngineError('invalid-damage-options', 'Damage options must be explicit supported positive flags.');
      Object.assign(options, value);
    }
  }
  // 「这只宝可梦所使用的招式的伤害，不计算…」: the attacker's continuous option, as if printed on the attack.
  const { owner, m } = findMon(s, source.pokemonId);
  for (const e of continuousEntries(s, catalog)) if (e.spec.op === 'attackDamageOptions' && !e.spec.received && entryTargets(s, catalog, e, owner, m))
    for (const flag of ['ignoreDefenderEffects', 'ignoreWeakness', 'ignoreResistance']) if (e.spec[flag]) options[flag] = true;
  return options;
}
// damage.received-options 「双方场上拥有【超】属性弱点的宝可梦，受到招式的伤害时，不计算弱点」: the damaged Pokémon's own option, whoever
// attacks (JP Q&A ジラーチGX: even an attack ignoring the defender's effects; its Weakness itself stays).
function receivedOptions(s, catalog, owner, target) {
  const options = {};
  for (const e of continuousEntries(s, catalog)) if (e.spec.op === 'attackDamageOptions' && e.spec.received && entryTargets(s, catalog, e, owner, target)) {
    requireRule(catalog.ruleset, 'damage.received-options');
    for (const flag of ['ignoreWeakness', 'ignoreResistance']) if (e.spec[flag]) options[flag] = true;
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
    weakness: effectiveWeakness(s, catalog, owner, target),
    resistance: effectiveProperty(s, catalog, owner, target, 'resistance'),
    attackerModifiers: continuous(s, catalog, source.owner, attacker.m, 'attackDamage', packet),
    defenderModifiers: continuous(s, catalog, owner, target, 'defenseDamage', packet),
    preventions: protections(s, catalog, source, owner, target, 'damage'),
    battleValues: battleValueFacts(s, catalog, source, { owner, m: target }),
    ...receivedOptions(s, catalog, owner, target),
  };
}
/** Transient, read-only numeric facts, never printed-card metadata or a second
 * authoritative HP cache. All targets in a packet read the pre-application board. */
// II.D-17 Prize cards already taken, against the original physical deck size.
function prizesTakenQuery(s, owner) {
  return queryPrizesTaken({ ruleset: s.ruleset, deckSize: Object.values(s.cards).filter((card) => card.owner === owner).length,
    matchMode: s.matchMode, remainingPrizes: s.players[owner].prizes.length });
}
// 「会因为每张…已经获得的奖赏卡而「+N」」: an unresolved count (tiebreak scope) refuses instead of guessing.
function prizesTakenCount(s, catalog, source, side) {
  requireRule(catalog.ruleset, 'prizes.effects-count');
  const taken = prizesTakenQuery(s, side === 'own' ? source.owner : 1 - source.owner);
  if (taken.status !== 'resolved') throw new EngineError('unresolved-prize-count', 'The Prize cards already taken need a CN ruling in this scope.');
  return taken.count;
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
      // I.F: asleep/paralyzed/confused replace one another; poisoned and burned stack with them.
      specialConditions: (m.conditions.rotation ? 1 : 0) + (m.conditions.poison !== null ? 1 : 0) + (m.conditions.burned ? 1 : 0),
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
// host's answers to its own binding's query nodes, at the moment it is asked; a
// 「剩余HP在「N」以下」 choice gets each in-play Pokémon's remaining HP (II.D-16).
function factContext(s, catalog, h, ctx, source, parameters) {
  const values = h.capabilities?.includes('battle-values'), remaining = /"(remainingHpAtMost|spareKnockOut)"/.test(JSON.stringify(parameters));
  if (!values && !remaining) return ctx;
  return deepFreeze({ ...ctx,
    ...(remaining ? { remainingHp: Object.fromEntries(allMons(s).map(({ owner, m }) => [m.id, hp(s, catalog, owner, m) - m.counters * 10])) } : {}),
    ...(values ? { battleValues: battleValueFacts(s, catalog, source, null, sourceModel(s, catalog), queryNodes(parameters)) } : {}) });
}
// effects.count-value 「其各自身上」「被选择的宝可梦身上」: a printed counter count read for one Pokémon (who target); none at 0 or less.
function counterValue(s, catalog, source, value, holder) {
  return Math.max(0, evaluateBattleValue(value, battleValueFacts(s, catalog, source, holder, sourceModel(s, catalog), queryNodes(value))));
}
// II.D-13 FAQ2: an Ability counts only while it is in effect. I.B-02: a Tool is
// a card placed on the Pokémon. I.F: the five Special Conditions.
// II.D-16: a one-time choice's 「剩余HP在「N」以下」 (the schema keeps it out of continuous effects).
function pokemonMatches(s, catalog, model, m, node) {
  return (!node.selector || matchesInPlaySelector(monDef(s, catalog, m), node.selector, model.pokemon[m.id].types)) &&
    (!node.state || matchesPokemonState(m, model.pokemon[m.id], node.state, (id) => cardDef(s, catalog, id))) &&
    (node.state?.remainingHpAtMost === undefined ||
      hp(s, catalog, mons(s.players[0]).includes(m) ? 0 : 1, m) - m.counters * 10 <= node.state.remainingHpAtMost) &&
    (node.retreatCost === undefined || retreatCost(s, catalog, mons(s.players[0]).includes(m) ? 0 : 1, m) === node.retreatCost) &&
    // 「最大HP为「30」的…宝可梦」: the current maximum HP (never in a continuous condition, so an HP change cannot read itself).
    (node.maximumHp === undefined || requireRule(catalog.ruleset, 'pokemon.maximum-hp-count') && hp(s, catalog, mons(s.players[0]).includes(m) ? 0 : 1, m) === node.maximumHp);
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
      if (!entry || Object.hasOwn(entry, 'count')) return null;
      // effects.shared-name 「如果对手手牌中有和自己手牌中同名的卡牌」: the opponent's shown cards whose name one of the user's has.
      if (node.sharedName) requireRule(catalog.ruleset, 'effects.shared-name');
      const own = node.sharedName && new Set(entry.cards.filter((id) => s.cards[id].owner === source.owner).map((id) => cardDef(s, catalog, id).nameKey));
      const cards = entry.cards.filter((id) => !own || s.cards[id].owner !== source.owner && own.has(cardDef(s, catalog, id).nameKey))
        .map((id) => cardDef(s, catalog, id)).filter((d) => matchesCardSelector(d, node.selector));
      // 「放于弃牌区的基本能量的属性种类数量」「给对手查看过的基本能量的属性种类数量」 (II.D-02 文例2): types, not cards.
      return node.distinct ? typeCount(cards) : cards.length;
    }
    case 'sharedType': {
      // 属性相同 as in the Weakness step: some current type in common.
      const spot = (owner, zone) => zone === 'active' ? [s.players[owner].active].filter(Boolean) : mons(s.players[owner]);
      const theirs = spot(1 - source.owner, node.opponent).flatMap((m) => model.pokemon[m.id].types);
      return spot(source.owner, node.own).some((m) => model.pokemon[m.id].types.some((t) => theirs.includes(t)));
    }
    case 'extraEnergy': {
      // energy.extra: the declared attack's current cost, which a copied attack's user paid (not the copied cost).
      const frame = s.attack, user = frame && findMon(s, frame.pokemonId)?.m;
      if (!user || source.category !== 'attack' || source.instanceId !== frame.sourceId || source.pokemonId !== frame.pokemonId) return null;
      requireRule(catalog.ruleset, 'energy.extra');
      const units = energyCards(s, catalog, user).flatMap((c) => c.units);
      const routes = attackRequirements(s, catalog, frame.player, user, frame.attack, frame.sourceId);
      return Math.max(0, ...routes.map((route) => node.energyTypes ? surplusEachEnergy(units, route, node.energyTypes) : surplusEnergy(units, route, node.energyType)));
    }
    case 'stadiumInPlay':
      return !!s.stadium && (node.owner === 'any' || s.cards[s.stadium].owner === side(node.owner)) &&
        (!node.selector || matchesCardSelector(cardDef(s, catalog, s.stadium), node.selector));
    case 'previousOpponentTurn': {
      // II.E-11: the user's latest opponent turn, read on the user's own turn.
      requireRule(catalog.ruleset, 'history.previous-opponent-turn');
      const clock = { turn: s.turn, during: s.current };
      if (node.fact === 'prizesTaken') return prizesTakenInPreviousOpponentTurn(s.battleHistory, clock, source.owner);
      return holders.self ? attackDamageInPreviousOpponentTurn(s.battleHistory, clock, source.owner, holders.self.m.id, node.activeOnly) : null;
    }
  }
  // historyFact: the effect user's own turn (II.E-11, E-24, E-25, E-26).
  const clock = { turn: s.turn, during: s.current }, rules = BATTLE_HISTORY_RULES;
  switch (node.fact) {
    case 'previousOpponentKnockout':
      requireRule(catalog.ruleset, rules.previousOpponentKO.id);
      if (!node.selector) return hadKnockoutInPreviousOpponentTurn(s.battleHistory, clock, { owner: source.owner, cause: node.cause });
      // The printed top card of each Knocked Out Pokémon, from its latched Knock Out receipt.
      return knockoutsInPreviousOpponentTurn(s.battleHistory, clock, source.owner).some((e) =>
        (node.cause === 'any' || e.cause.kind === 'attackDamage') && matchesCardSelector(cardDef(s, catalog,
          s.events.find((x) => x.ruleId === 'ko.boundary' && x.data.kind === 'latched' && x.data.item?.id === e.pokemonId).data.item.topCardId), node.selector));
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
    case 'previousOwnAttack':
      // I.A-01: an attack the user's Pokémon used (past step 2) in the user's previous own turn.
      requireRule(catalog.ruleset, 'history.previous-own-attack');
      return attacksInPreviousOwnTurn(s.battleHistory, clock, source.owner).some((e) =>
        (node.by === 'any' || (e.pokemonId === source.pokemonId) === (node.by === 'self')) &&
        (!node.selector || matchesCardSelector(cardDef(s, catalog, e.cardId), node.selector)) &&
        (!node.attackNames || node.attackNames.includes(e.attackName)));
    case 'specialRuleUsed':
      // 「如果自己／对手已经使用了GX招式／VSTAR力量的话」: that player's once-per-game rule is spent.
      requireRule(catalog.ruleset, 'history.special-rule-used');
      return s.players[side(node.side)][node.rule === 'GX' ? 'gxUsed' : 'vstarUsed'];
    case 'previousOpponentSpecialAttack':
      requireRule(catalog.ruleset, 'history.previous-opponent-turn');
      return specialAttackInPreviousOpponentTurn(s.battleHistory, clock, source.owner, node.rule);
    case 'previousOpponentMove': {
      // 「在上一个对手的回合，如果那只宝可梦从战斗场撤退了／…是从备战区被放于战斗场上」: that Pokémon in its current form.
      requireRule(catalog.ruleset, 'history.previous-opponent-move');
      const holder = holders[node.who];
      if (!holder) return lenient ? false : null;
      return movedInPreviousOpponentTurn(s.battleHistory, clock, source.owner, holder.m.id, node.move, holder.m.facts.formSince ?? 0);
    }
    case 'otherEvolvedFromHand': {
      // II.E-23: another own Pokémon evolved into a card played from the hand this turn, while this one was in play.
      requireRule(catalog.ruleset, 'evolution.history');
      const seen = holders.self?.m.facts.witnessedEvolutions;
      return !!seen && seen.turn === s.turn && seen.fromCardIds.some((id) => !node.selector || matchesCardSelector(cardDef(s, catalog, id), node.selector));
    }
    case 'toolFromHand':
      // 「在这个回合，如果从手牌将「宝可梦道具」放于这只宝可梦身上的话」.
      requireRule(catalog.ruleset, 'history.tool-from-hand-this-turn');
      return holders.self?.m.facts.toolFromHandTurn === s.turn;
    case 'firstOwnTurn': case 'secondPlayerFirstTurn':
      // I.A-05: the user's own first turn, judged during that turn; the second player's is its turn 2.
      requireRule(catalog.ruleset, 'history.first-turn');
      return s.current === source.owner && s.players[source.owner].turns === 1 && (node.fact === 'firstOwnTurn' || s.first !== source.owner);
  }
  requireRule(catalog.ruleset, rules.supporterFromHand.id);
  return wasSupporterPlayedFromHandThisTurn(s.battleHistory, clock, source.owner,
    node.selector ? (cardId) => matchesCardSelector(cardDef(s, catalog, cardId), node.selector) : undefined);
}
const effectCardFacts = (entries = []) => Object.fromEntries(entries.map((e) => [e.effectId, e.count ?? e.cards.length]));
const countedEffect = (catalog, binding) => !!catalog.handler(binding.handlerId).capabilities?.includes('effect-card-count');
// 「将附着于这只宝可梦身上的任意数量的【雷】能量放于弃牌区，选择与其相同数量的…」: a counted discard measured in units records the units
// the discarded cards provided (JP Q&A アローラライチュウ「エレキレイン」: 1 Counter Energy as 2 units → 2 picks), not the cards.
const countsUnits = (b) => b.handlerId === 'cn.countedEnergyDiscard@1' && b.parameters.measure === 'units';
// II.B-02 / II.D-02 文例1: a counted before-damage effect records the cards it
// actually moved for its own execution, including an explicit zero.
function recordEffectCards(s, catalog, d, cards, count = null) {
  const binding = executionBinding(s, catalog, d.source);
  if (!countedEffect(catalog, binding)) return;
  const frame = s.attack, execution = frame?.execution;
  if (!frame || d.source.category !== 'attack' || d.source.instanceId !== frame.sourceId ||
      d.source.pokemonId !== frame.pokemonId || (d.source.copyId ?? null) !== execution.copyId ||
      execution.damageCoins !== null || execution.effectCards.some((e) => e.effectId === d.source.effectId))
    throw new EngineError('invalid-effect-count', 'A counted effect records once, for its own attack execution, before damage calculation.');
  const units = count ?? (countsUnits(binding) ? 0 : null);
  const entry = { effectId: d.source.effectId, cards: [...cards], ...(units === null ? {} : { count: units }) };
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
        canonicalJSON({ effectId: e.data.effectId, cards: e.data.cards, ...(Object.hasOwn(e.data, 'count') ? { count: e.data.count } : {}) }) !==
          canonicalJSON(execution.effectCards[i])) ||
      execution.effectCards.some((e) => {
        const b = attack.effects.find((b) => b.effectId === e.effectId);
        const op = catalog.handler(b.handlerId === 'cn.optionalCounted@1' ? b.parameters.effect.handlerId : b.handlerId).operations[0];
        // Attached Energy and hand/deck cards are the user's own; a discarded Tool or deck-top card may be either player's;
        // a looked-at hand and a Pokémon switched in are the opponent's. Placed counters are a number, not cards; so are discarded units
        // (a counted placement that placed none records no number).
        return (op === 'counters' ? e.cards.length > 0 : Object.hasOwn(e, 'count') !== (op === 'selfCounters' || countsUnits(b))) ||
          op === 'selfCounters' && e.cards.length > 0 ||
          op === 'attachHand' && e.cards.some((id) => cardDef(s, catalog, id).kind !== 'energy') ||
          e.cards.some((id) => !s.cards[id] || !['discardTools', 'opponentHand', 'discardStadium', 'switch', 'discardDeckTop', 'knockOut', 'damageRedirect'].includes(op) && s.cards[id].owner !== frame.player ||
          ['opponentHand', 'switch', 'damageRedirect'].includes(op) && s.cards[id].owner === frame.player ||
          ['switch', 'knockOut', 'damageRedirect'].includes(op) && cardDef(s, catalog, id).kind !== 'pokemon' ||
          op === 'discardStadium' && cardDef(s, catalog, id).mechanics.category !== 'stadium' ||
          op === 'discardEnergy' && cardDef(s, catalog, id).kind !== 'energy' ||
          op === 'discardTools' && cardDef(s, catalog, id).mechanics.category !== 'tool' ||
          ['attackChoice', 'janken'].includes(op) && id !== frame.sourceId);
      }) ||
      models?.some((model) => canonicalJSON(model.battleValues.effectCards) !== canonicalJSON(effectCardFacts(execution.effectCards))))
    throw new EngineError('invalid-effect-count', 'Counted effect results must match their public receipts, own attack bindings and frozen damage facts.');
}
// effects.coin-face 「将对手抛掷的硬币的结果，全部视作反面」: while it lasts, every coin that player flips shows that face; no RNG is read.
function forcedCoinFace(s, player) {
  return s.playerOngoing.find((e) => e.player === player && e.effect.op === 'coinFace' && ongoingIsActive(e, s))?.effect.face ?? null;
}
// One instruction's flips: a forced face, else the first coin's chosen face (effects.coin-choice) once, else the (replayable) RNG.
function coinFlipper(s, player, firstFace = null, rng = s.rng) {
  const forced = forcedCoinFace(s, player);
  let first = firstFace;
  return () => {
    const face = forced ?? first;
    first = null;
    return face === null ? randomIndex(rng, 2) === 0 : face === 'heads';
  };
}
// effects.coin-choice: the player's unspent 「…其第一次的结果，可由自己决定」 of this turn; only flips of attacks (including an attack's
// effect left on a Pokémon), Abilities and Trainers use it, never Confusion or a Checkup.
const coinChoices = (s, player) => s.playerOngoing.filter((e) => e.player === player && e.effect.op === 'coinChoice' && ongoingIsActive(e, s));
const CHOOSABLE_COINS = ['attack', 'ability', 'trainer'];
// A flip inside damage or Knock Out processing, where no player choice can pause it.
function plainFlip(s, player, category) {
  if (CHOOSABLE_COINS.includes(category) && coinChoices(s, player).length)
    throw new EngineError('unsupported-coin-choice', 'Choosing the first coin of a flip inside damage or Knock Out processing needs its own reviewed pause point.');
  return coinFlipper(s, player)();
}
// effects.coin-reflip: the attacking player's once-per-turn reflips still unused (either player's Stadium, or that player's own card).
const reflipUsage = (key) => ({ period: 'turn', scope: 'player', key, limit: 1 });
function reflipSources(s, catalog, player) {
  return Object.fromEntries(continuousEntries(s, catalog).filter(({ spec, source }) => spec.op === 'coinReflip' &&
    (spec.scope === 'all' || source.owner === player)).map(({ spec, source }) => [spec.key, source.instanceId]));
}
const reflipKeys = (s, catalog, player) => Object.keys(reflipSources(s, catalog, player)).filter((key) => usageAllowed(s, player, null, reflipUsage(key)));
// tools.attack-tails: a Tool on the attacking Pokémon records its turn-end program once a turn, while its effects apply.
function recordAttackTails(s, catalog) {
  const frame = s.attack, model = sourceModel(s, catalog);
  for (const { binding, source, nodeId } of model.sources) {
    if (binding.handlerId !== 'cn.turnEndEffect@1' || binding.parameters.on !== 'attackTails' || source.pokemonId !== frame.pokemonId ||
        !model.availability.get(nodeId).enabled ||
        s.playerOngoing.some((e) => e.effect.op === 'turnEndEffect' && e.source.instanceId === source.instanceId)) continue;
    const program = catalog.handler(binding.handlerId).execute(deepFreeze({ source: clone(source), event: null }), clone(binding.parameters))[0].program;
    const entry = createPlayerOngoingEffect({ id: `e${++s.serial}`, player: frame.player, source,
      effect: { op: 'turnEndEffect', program }, duration: 'thisTurn' }, s);
    s.playerOngoing.push(entry);
    log(s, 'tools.attack-tails', { player: frame.player, pokemonId: frame.pokemonId, cardId: source.instanceId, effectId: entry.id,
      sourceOfTruth: source.sourceOfTruth });
  }
}
// One instruction's coin flips (occ: flipper, spec, will = an attack/Ability/Trainer flip, attack = the attacking Pokémon's own attack).
// 一树 picks the first coin before it; a reflip may follow its results; the attacker's own tails then reach tools.attack-tails.
// Returns { occ, ask } when a player decides (answered as `selected`), else the settled { occ }.
function coinOccasion(s, catalog, occ, selected = null) {
  occ = clone(occ);
  const forced = forcedCoinFace(s, occ.flipper), empty = occ.spec.kind === 'fixed' && occ.spec.count === 0;
  if (occ.stage === 'reflip') {
    delete occ.stage;
    if (selected[0] !== 'keep') {
      recordUsage(s, s.attack.player, null, reflipUsage(selected[0]));
      log(s, 'effects.coin-reflip', { player: s.attack.player, flipper: occ.flipper, turn: s.turn, key: selected[0], discarded: [...occ.receipt.results] });
      Object.assign(occ, { discarded: occ.receipt, reflip: selected[0], receipt: rollDamageCoin(occ.spec, coinFlipper(s, occ.flipper)) });
    }
  } else {
    if (occ.stage === 'face') { delete occ.stage; occ.firstFace = selected[0]; }
    const choices = occ.will && !empty ? coinChoices(s, occ.flipper) : [];
    // Under a forced face the choice changes nothing: it is spent without asking.
    if (choices.length && !occ.firstFace && forced === null)
      return { occ: { ...occ, stage: 'face' }, ask: { player: occ.flipper, kind: 'coin-face', options: ['heads', 'tails'], ruleId: 'effects.coin-choice' } };
    if (choices.length) {
      s.playerOngoing = s.playerOngoing.filter((e) => !choices.includes(e));
      log(s, 'effects.coin-choice', { player: occ.flipper, turn: s.turn, face: occ.firstFace ?? null, effectIds: choices.map((e) => e.id) });
    }
    occ.receipt = rollDamageCoin(occ.spec, coinFlipper(s, occ.flipper, occ.firstFace ?? null));
    const keys = occ.attack && !empty && forced === null ? reflipKeys(s, catalog, s.attack.player) : [];
    if (keys.length) return { occ: { ...occ, stage: 'reflip' },
      ask: { player: s.attack.player, kind: 'coin-reflip', options: ['keep', ...keys], ruleId: 'effects.coin-reflip' } };
  }
  if (occ.attack && occ.flipper === s.attack.player && occ.receipt.tails > 0) recordAttackTails(s, catalog);
  return { occ };
}
const failureSpec = (coin) => coin.mode === 'fixed' ? { kind: 'fixed', count: coin.count } : { kind: 'untilTails' };
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
// resume: the answer to a coin choice (effects.coin-choice / effects.coin-reflip) that paused this preparation. Until it completes, its
// rolls so far wait in that private request, never as a half-prepared receipt; returns whether the coins are prepared.
function prepareDamageCoins(s, catalog, resume = null) {
  const frame = s.attack, execution = frame.execution, attack = executingAttack(s, catalog);
  if (execution.damageCoins !== null)
    throw new EngineError('invalid-damage-coins', 'Damage calculation may prepare its coins only once.');
  const data = resume?.coinPrep ?? { entries: [], rngBefore: [...s.rng], rngAfter: [...s.rng] }, keys = new Set(), sources = [];
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
      if (sources.push(source) <= data.entries.length) continue;
      const facts = battleValueFacts(s, catalog, source, target);
      if (plan.condition && !evaluateBattlePredicate(plan.condition, facts)) {
        data.entries.push({ effectId: binding.effectId, key: plan.key, spec: null, receipt: null }); continue;
      }
      const spec = resolveDamageRollSpec(plan, facts);
      const step = coinOccasion(s, catalog, resume?.coinOccasion ?? { flipper: frame.player, spec, will: true, attack: true }, resume?.selected);
      resume = null;
      if (step.ask) {
        execution.damageCoins = null;
        ask(s, { ...step.ask, resume: 'attack-coins', data: { flow: attackFlow(s), stage: 'damage', coinPrep: data, coinOccasion: step.occ } });
        return false;
      }
      const { receipt, firstFace, discarded, reflip } = step.occ;
      data.entries.push({ effectId: binding.effectId, key: plan.key, spec, receipt, ...(firstFace ? { firstFace } : {}),
        ...(discarded ? { discarded, reflip } : {}) });
    }
  }
  for (const [i, entry] of data.entries.entries()) if (entry.receipt) {
    if (entry.receipt.flips > 0) execution.performed = true;
    log(s, 'damage.coins', { kind: 'rolled', frameId: frame.id, copyId: execution.copyId, turn: s.turn,
      effectId: entry.effectId, key: entry.key, source: sources[i], receipt: entry.receipt, ...(entry.discarded ? { discarded: entry.discarded } : {}) });
  }
  data.rngAfter = [...s.rng];
  log(s, 'damage.coins', { kind: 'prepared', frameId: frame.id, copyId: execution.copyId, turn: s.turn,
    source: executingSource(s, catalog), data }, 'private');
  return true;
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
      if (entry.discarded) assertDamageCoinReceipt(spec, entry.discarded);
      // effects.coin-choice / effects.coin-reflip: a chosen first face and ignored results replay from the same private RNG.
      const replay = (firstFace) => rollDamageCoin(spec, coinFlipper(s, frame.player, firstFace, rng));
      const discarded = entry.discarded ? replay(entry.firstFace ?? null) : null;
      const expected = replay(entry.discarded ? null : entry.firstFace ?? null);
      const actualSource = sourceFor(s, catalog, frame.sourceId, frame.player, 'attack', binding,
        frame.pokemonId, frame.attack.attackId, null, execution);
      if (canonicalJSON(entry.spec) !== canonicalJSON(spec) || canonicalJSON(expected) !== canonicalJSON(entry.receipt) ||
          canonicalJSON(discarded) !== canonicalJSON(entry.discarded ?? null) ||
          entry.firstFace && !s.events.some((e) => e.ruleId === 'effects.coin-choice' && e.data.turn === s.turn &&
            e.data.player === frame.player && e.data.face === entry.firstFace) ||
          entry.discarded && !s.events.some((e) => e.ruleId === 'effects.coin-reflip' && e.data.turn === s.turn &&
            e.data.player === frame.player && e.data.key === entry.reflip && canonicalJSON(e.data.discarded) === canonicalJSON(entry.discarded.results)) ||
          events.length !== 1 || events[0].visibility !== 'public' || events[0].data.turn !== s.turn ||
          events[0].data.effectId !== binding.effectId ||
          canonicalJSON(events[0].data.source) !== canonicalJSON(actualSource) ||
          canonicalJSON(events[0].data.receipt) !== canonicalJSON(entry.receipt) ||
          canonicalJSON(events[0].data.discarded ?? null) !== canonicalJSON(entry.discarded ?? null) ||
          entry.receipt.flips > 0 && !execution.performed)
        throw new EngineError('invalid-damage-coins', 'Actual outcome receipts must match the reviewed instruction and replayed private RNG, without rerolling the game.');
      published++;
    }
    prefix.push(entry);
  }
  if (published !== rolled.length || canonicalJSON(rng) !== canonicalJSON(data.rngAfter))
    throw new EngineError('invalid-damage-coins', 'Coin publication or the saved RNG endpoint contradicts the actual preparation.');
}
// 「将与受到的伤害数值相同的伤害指示物，放置于使用了招式的宝可梦身上」: the damage of the attackDamage event that fired the reaction.
function eventDamageCounters(event) {
  if (event?.kind !== 'attackDamage') throw new EngineError('invalid-trigger-event', 'Only an attack-damage reaction knows the damage it received.');
  return event.damage / 10;
}
// 「与给对手战斗宝可梦造成的伤害相同数值」: the damage the resolving attack dealt to the opponent's Active Pokémon (after
// Weakness and Resistance), read by the attack's own later effect.
function attackDamageToOpponentActive(s, source) {
  const frame = s.attack;
  if (!frame || source.category !== 'attack' || source.attackId !== frame.attack.attackId || source.owner !== frame.player)
    throw new EngineError('invalid-damage-source', 'Only the resolving attack reads the damage it dealt.');
  return frame.events.filter((e) => e.kind === 'attackDamage' && e.owner !== frame.player && e.wasActive).reduce((n, e) => n + e.damage, 0);
}
// damage.survive: attack damage that would Knock this Pokémon Out leaves it at 10 HP instead, when an applicable effect
// (from full HP, II.D-14; or on heads; 「受到对手宝可梦的招式的伤害」 only the opponent's) says so. Any one applicable effect is
// enough; coin effects flip until heads. A Tool that then discards itself is one the holder orders against the others (JP Q&A
// サバイブギプス: 「コノヨザルの持ち主が、順番をえらぶことができます」); that order is not a choice offered during damage.
function survivingCounters(s, catalog, owner, m, counters, attacker) {
  const maximum = hp(s, catalog, owner, m);
  if (!counters || (m.counters + counters) * 10 < maximum) return { counters };
  const effects = continuousEntries(s, catalog).filter((e) => e.spec.op === 'koSurvive' && entryTargets(s, catalog, e, owner, m) &&
    (!e.spec.fullHp || m.counters === 0) && (!e.spec.from || attacker !== owner));
  if (effects.length > 1 && effects.some((e) => e.spec.discardCard))
    throw new EngineError('unresolved-survive-order', 'The holder orders a self-discarding survival Tool against another survival effect.');
  const saved = effects.find((e) => !e.spec.coin) ?? effects.find((e) => {
    const face = plainFlip(s, owner, e.source.category) ? 'heads' : 'tails';
    log(s, 'damage.survive', { player: owner, targetId: m.id, effectId: e.id, result: face });
    return face === 'heads';
  });
  if (!saved) return { counters };
  log(s, 'damage.survive', { targetId: m.id, effectId: saved.id, remainingHp: 10, sourceOfTruth: saved.sourceOfTruth });
  return { counters: Math.max(0, maximum / 10 - 1 - m.counters), discard: saved.spec.discardCard ? saved.source.instanceId : null };
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
    // tools.damage-discard: a Tool an earlier packet of this attack already put into the discard pile changes no more damage.
    const defenderModifiers = model.defenderModifiers.filter((x) => !x.discardCardId || m.tools.includes(x.discardCardId));
    const packet = { ...model, defenderModifiers, amount: Array.isArray(amount) ? amount[index] : amount, ...options };
    const coins = model.preventions.filter((p) => p.coin), fixed = model.preventions.filter((p) => !p.coin);
    let result = calculateAttackDamage({ ...packet, preventions: fixed });
    // I.A-01 步骤6: a coin protection's player flips only when this damage reaches 6.最终伤害 (not after it
    // stopped at 0 or was already prevented); an attack ignoring the defender's effects still makes them flip.
    if (coins.length && result.stoppedAt === null) {
      const heads = coins.filter((p) => {
        // Its provider's kind is not in the model: any provider may be a card effect 一树 covers.
        const face = plainFlip(s, owner, 'ability') ? 'heads' : 'tails';
        log(s, 'damage.prevention-coin', { player: owner, targetId: m.id, effectId: p.id, result: face, sourceOfTruth: p.sourceOfTruth });
        return face === 'heads';
      });
      if (heads.length) result = calculateAttackDamage({ ...packet, preventions: [...fixed, ...heads] });
    }
    return { owner, m, result, packet };
  });
  const attacker = top(findMon(s, source.pokemonId).m);
  for (const { owner, m, result, packet } of packets) {
    if (result.damage > 0) battleFact(s, { kind: 'attackDamage', owner, pokemonId: m.id, damage: result.damage, active: s.players[owner].active === m });
    const survived = survivingCounters(s, catalog, owner, m, result.counters, source.owner);
    addCounters(s, catalog, owner, m, survived.counters, { kind: 'attackDamage', source });
    // 「然后，将这张卡牌放于弃牌区」: the Tool that kept its holder in play.
    if (survived.discard) {
      discardFromPlay(s, catalog, survived.discard); remove(m.tools, survived.discard);
      log(s, 'damage.survive', { player: owner, pokemonId: m.id, cardId: survived.discard, discarded: true });
    }
    // tools.damage-discard: this damage reached 5.受到伤害的宝可梦身上附加的效果, so such a Tool goes now — even if the damage
    // was then reduced to 0 or prevented, or the attack did not apply the defender's effects (JP Q&A ウタンのみ／オッカのみ).
    if (!['base', 'attacker', 'resistance'].includes(result.stoppedAt))
      for (const id of packet.defenderModifiers.map((x) => x.discardCardId).filter(Boolean)) {
        discardFromPlay(s, catalog, id); remove(m.tools, id);
        log(s, 'tools.damage-discard', { player: s.cards[id].owner, pokemonId: m.id, cardId: id });
      }
    if (result.damage > 0) frame.events.push(makeTriggerEvent(s, catalog, 'attackDamage', owner, m,
      { damage: result.damage, cause: { kind: 'attackDamage', source }, attacker: { cardId: attacker, types: packet.attackerTypes } }));
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
// pokemon.hp-set 「这只宝可梦的最大HP变为「200」」: the printed maximum HP replaced first, HP changes 「+N」 then on top (JP Q&A
// ソルロック「サンライト」×キッサキしんでん; メタモン「メタモルDNA」).
function hp(s, catalog, owner, m) {
  const base = effectiveProperty(s, catalog, owner, m, 'hp');
  if (base !== monDef(s, catalog, m).mechanics.hp) requireRule(catalog.ruleset, 'pokemon.hp-set');
  const result = continuous(s, catalog, owner, m, 'hp').reduce((n, x) => n + BigInt(x.amount), BigInt(base));
  if (result > 9007199254740990n || result < -9007199254740990n)
    throw new EngineError('numeric-overflow', 'Effective maximum HP must remain an exact, signed ten-point integer.');
  return Number(result);
}
// retreat.rules: the continuous retreat rules that apply to this Pokémon now.
const retreatRules = (s, catalog, owner, m) => continuousEntries(s, catalog).filter((e) => e.spec.op === 'retreatRule' && entryTargets(s, catalog, e, owner, m));
let readingRetreatCost = false;
function retreatCost(s, catalog, owner, m) {
  // A Retreat Cost read while one is being worked out (a retreat change conditioned on Retreat Costs) has no defined answer.
  if (readingRetreatCost) throw new EngineError('unsupported-retreat-cost-loop', 'A Retreat Cost cannot depend on Retreat Costs.');
  readingRetreatCost = true;
  try { return retreatCostNow(s, catalog, owner, m); } finally { readingRetreatCost = false; }
}
function retreatCostNow(s, catalog, owner, m) {
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
      discardFromPlay(s, catalog, id); remove(m.energy, id); changed = true;
      log(s, 'energy.move', { player: owner, energyId: id, pokemonId: m.id, discarded: 'attachment-condition',
        sourceOfTruth: cardDef(s, catalog, id).sourceOfTruth });
    }
  }
}
function recordTransitionKO(s, catalog, owner, m, wasLethal, source) {
  if (!wasLethal && m.counters * 10 >= hp(s, catalog, owner, m))
    m.facts.knockoutCause = { kind: 'effect', source: clone(source) };
}
// 「…所处于的特殊状态不会因为进化、退化而恢复」: only the conditions such a rule keeps remain, read before the change.
function transitionConditions(s, catalog, owner, m) {
  const kept = new Set(continuousEntries(s, catalog).filter((e) => e.spec.op === 'conditionRule' && e.spec.keepOnEvolution &&
    entryTargets(s, catalog, e, owner, m)).flatMap((e) => e.spec.keepOnEvolution));
  const cured = presentConditions(m.conditions).filter((c) => !kept.has(c));
  return cured.length ? cureConditions(m.conditions, cured) : m.conditions;
}
// attack.twice: 「这只宝可梦，可以连续使用2次拥有的招式」 in effect for this Pokémon now.
const attacksTwice = (s, catalog, owner, m) => continuousEntries(s, catalog).some((e) => e.spec.op === 'attackTwice' && entryTargets(s, catalog, e, owner, m));
// status.rules: the continuous Special Condition rules on one Active Pokémon at checkup.
function conditionRules(s, catalog, owner, m) {
  const rules = continuousEntries(s, catalog).filter((e) => e.spec.op === 'conditionRule' && entryTargets(s, catalog, e, owner, m))
    .map((e) => e.spec);
  const added = (status) => rules.filter((r) => r.status === status && r.addCounters).reduce((n, r) => n + r.addCounters, 0);
  return { poisonExtra: added('poisoned'), burnExtra: added('burned'), burnRecovers: !rules.some((r) => r.noRecovery),
    sleepCoins: Math.max(1, ...rules.filter((r) => r.coins).map((r) => r.coins)) };
}
function evolveMon(s, catalog, owner, m, cardId, origin, source = null) {
  const fromCardId = top(m), wasLethal = m.counters * 10 >= hp(s, catalog, owner, m), conditions = transitionConditions(s, catalog, owner, m);
  m.stack.push(cardId); m.evolvedTurn = s.turn; m.conditions = conditions;
  m.facts.evolution = { turn: s.turn, fromCardId, toCardId: cardId, method: source ? 'effect' : 'ordinary', origin };
  m.facts.formSince = s.battleHistory.events.length; // history.previous-opponent-move: later facts are of this new form.
  // 「在自己的回合，如果从手牌使出宝可梦使自己的其他「X」进行进化了的话」: seen by each of the owner's other Pokémon in play now.
  if (origin === 'hand' && s.current === owner) for (const other of mons(s.players[owner])) if (other !== m) {
    const seen = other.facts.witnessedEvolutions;
    other.facts.witnessedEvolutions = { turn: s.turn, fromCardIds: [...(seen?.turn === s.turn ? seen.fromCardIds : []), fromCardId] };
  }
  retainOngoing(s, (e) => !(e.targetId === m.id && e.clearOnEvolution), 'evolution',
    { owner, pokemonId: m.id, fromCardId, toCardId: cardId });
  enforceEnergyRetention(s, catalog);
  if (source) recordTransitionKO(s, catalog, owner, m, wasLethal, source);
  log(s, source ? 'effects.evolve' : 'turn.evolve', { player: owner, cardId, pokemonId: m.id,
    fromCardId, origin, ...(source ? { sourceOfTruth: source.sourceOfTruth } : {}) });
  return makeTriggerEvent(s, catalog, 'evolve', owner, m, { origin, cardId,
    ...(source ? { cause: { kind: 'effect', source } } : {}) });
}
// 「选择自己牌库中从自己所有备战宝可梦进化而来的卡牌各1张，分别放于各只宝可梦身上进行进化。并重洗牌库。」: one hidden
// search per target in field order (each may fail to find, II.C-12); the deck stays untouched until every card is chosen,
// then the Pokémon evolve together and the deck is shuffled once.
function evolveEach(s, catalog, d, ctx, pool) {
  const { source } = d, a = d.action, owner = source.owner, p = s.players[owner];
  if (!d.evolutionPlan) {
    if (pool.some((m) => evolutionTiming(s, owner, m, a.timing).needsRuling))
      throw new EngineError('unresolved-evolution-timing', 'Already-evolved timing needs a sourced card-specific ruling.');
    if (!pool.length || !p.deck.length) { finishEffect(s, catalog, d, false); return; }
    // 「选择自己最多N只备战宝可梦，…各1张」: the user first chooses which of them (1 to N), then searches for each.
    if (a.count && d.stage !== 'evolution-targets') {
      ask(s, { player: owner, kind: 'effect-target', options: pool.map((m) => m.id), minimum: 1, maximum: Math.min(a.count, pool.length),
        resume: 'effect-choice', data: { ...d, stage: 'evolution-targets' }, ruleId: 'effects.evolve' });
      return;
    }
    const targets = a.count ? pool.filter((m) => d.selected.includes(m.id)) : pool;
    if (a.count && (targets.length !== d.selected.length || !targets.length || targets.length > a.count))
      throw new EngineError('invalid-pokemon-transition', 'Choose 1 to N of the printed Pokémon.');
    prepend(s, tasks('effect-choice', { ...withoutSelection(d), stage: 'evolution-card', lookedAt: [...p.deck],
      evolutionPlan: targets.map((m) => ({ pokemonId: m.id, topCardId: top(m) })) }));
    return;
  }
  const plan = clone(d.evolutionPlan), at = (entry) => {
    const m = pool.find((m) => m.id === entry.pokemonId);
    if (!m || top(m) !== entry.topCardId) throw new EngineError('invalid-pokemon-transition', 'Evolution target changed before its card was placed.');
    return m;
  };
  if (d.stage === 'evolution-apply') {
    const events = [];
    for (const entry of plan) {
      const m = at(entry);
      if (entry.cardId && !effectBlocked(s, catalog, source, owner, m)) {
        remove(p.deck, entry.cardId); events.push(evolveMon(s, catalog, owner, m, entry.cardId, 'deck', source));
      }
    }
    const shuffled = shuffleZone(s, owner, 'deck', source);
    finishEffect(s, catalog, d, events.length > 0 || shuffled);
    if (events.length) prepend(s, ...triggerWork(s, catalog, events));
    return;
  }
  const entry = plan.find((e) => !Object.hasOwn(e, 'cardId')), taken = plan.map((e) => e.cardId).filter(Boolean);
  const choices = transitionChoices(s, catalog, ctx, a, at(entry)).filter((id) => !taken.includes(id));
  const bounds = selectionBounds({ kind: 'exact', count: 1, available: choices.length, zone: 'deck', filter: 'specific' });
  if (d.selected) {
    const selected = d.stage === 'evolution-empty' ? [] : d.selected;
    if (!canSelectCount(bounds, selected.length) || selected.some((id) => !choices.includes(id)))
      throw new EngineError('invalid-pokemon-transition', 'Chosen card does not evolve from this Pokémon.');
    entry.cardId = selected[0] ?? null;
    prepend(s, tasks('effect-choice', { ...withoutSelection(d), evolutionPlan: plan,
      stage: plan.some((e) => !Object.hasOwn(e, 'cardId')) ? 'evolution-card' : 'evolution-apply' }));
  } else if (choices.length) ask(s, { player: owner, kind: 'transition-card', options: choices, ...bounds,
    resume: 'effect-choice', data: d, ruleId: 'effects.evolve' });
  else ask(s, { player: owner, kind: 'view-cards', options: ['confirm'],
    resume: 'effect-choice', data: { ...d, stage: 'evolution-empty' }, ruleId: 'effects.evolve' });
}
function assertPokemonTransition(s, catalog, d) {
  const ctx = effectContext(s, catalog, d.source, d.event ?? null), a = d.action;
  if (d.transition) {
    const m = transitionTargets(ctx, a).find((m) => m.id === d.transition.pokemonId);
    if (!m || top(m) !== d.transition.topCardId || !boundTo(d, m) ||
        canonicalJSON(d.lookedAt) !== canonicalJSON(s.players[d.source.owner][a.from]) ||
        a.op === 'evolvePokemon' && !evolutionTiming(s, d.source.owner, m, a.timing).allowed ||
        d.stage === 'transition-empty' && (a.from !== 'deck' || transitionChoices(s, catalog, ctx, a, m).length || !d.lookedAt.length))
      throw new EngineError('invalid-pokemon-transition', 'Saved transition must retain its actual Pokémon, top card, eligibility and inspected zone.');
  }
  if (d.evolutionPlan) {
    const pool = transitionTargets(ctx, a).filter((m) => evolutionTiming(s, d.source.owner, m, a.timing).allowed), plan = d.evolutionPlan;
    const taken = [];
    let open = null;
    const planned = a.count ? pool.filter((m) => plan.some((e) => e.pokemonId === m.id)) : pool;
    if (!a.each || canonicalJSON(plan.map((e) => e.pokemonId)) !== canonicalJSON(planned.map((m) => m.id)) || a.count && plan.length > a.count ||
        canonicalJSON(d.lookedAt) !== canonicalJSON(s.players[d.source.owner].deck))
      throw new EngineError('invalid-pokemon-transition', 'Saved evolutions must cover every actual target and the untouched searched deck.');
    for (const e of plan) {
      const m = pool.find((m) => m.id === e.pokemonId), searched = Object.hasOwn(e, 'cardId');
      if (top(m) !== e.topCardId || searched && open ||
          e.cardId && (taken.includes(e.cardId) || !transitionChoices(s, catalog, ctx, a, m).includes(e.cardId)))
        throw new EngineError('invalid-pokemon-transition', 'Saved evolution cards must be distinct matches chosen in field order.');
      if (e.cardId) taken.push(e.cardId);
      if (!searched) open ??= m;
    }
    if ((d.stage === 'evolution-apply') === !!open ||
        d.stage === 'evolution-empty' && transitionChoices(s, catalog, ctx, a, open).some((id) => !taken.includes(id)))
      throw new EngineError('invalid-pokemon-transition', 'The saved evolution cursor contradicts the searched deck.');
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
const energyChoice = (s, catalog, pool, a, ids) => attachedEnergyChoice(pool, a, ids, (id) => cardDef(s, catalog, id).mechanics.baseUnits[0][0]);
// 「被换入备战区的宝可梦身上附着的…」「转附于新出场的宝可梦身上」: a bound attached-Energy action reads its holders (or, moving, its recipients).
const energyAction = (d) => boundPokemon(d) ? { ...d.action, boundPokemon: boundPokemon(d), ...(d.frames.at(-1).origin ? { boundOrigin: true } : {}) } : d.action;
function assertEnergyPlan(s, catalog, d) {
  const ctx = effectContext(s, catalog, d.source, d.event ?? null), pool = attachedEnergyPool(ctx, energyAction(d));
  const plan = d.energyPlan, ids = plan.chosen.map((c) => c.instanceId);
  if (new Set(ids).size !== ids.length || plan.chosen.some((c) => !pool.some((p) => p.instanceId === c.instanceId && p.originId === c.originId)) ||
      !energyChoice(s, catalog, pool, d.action, ids).valid ||
      new Set(plan.assignments.map((a) => a.instanceId)).size !== plan.assignments.length ||
      plan.assignments.some((a) => !ids.includes(a.instanceId)))
    throw new EngineError('invalid-energy-plan', 'Saved Energy selection must retain its original cards, units and assignments.');
  if (d.action.op !== 'moveEnergy') {
    if (plan.assignments.length || d.stage !== 'energy-apply') throw new EngineError('invalid-energy-plan', 'Discarding has no transfer recipients.');
  } else {
    if (d.action.distribution === 'singleRecipient' && !energyRecipients(ctx, energyAction(d), plan.chosen).length)
      throw new EngineError('invalid-energy-plan', 'Saved Energy cards must still have a common eligible transfer recipient.');
    if (plan.assignments.length > plan.chosen.length ||
        (d.stage === 'energy-apply') !== (plan.assignments.length === plan.chosen.length))
      throw new EngineError('invalid-energy-plan', 'Transfer receipt cursor and recipients must remain complete.');
    for (const a of plan.assignments) {
      const chosen = d.action.distribution === 'singleRecipient' ? plan.chosen : [plan.chosen.find((c) => c.instanceId === a.instanceId)];
      if (!energyRecipients(ctx, energyAction(d), chosen).some((m) => m.id === a.targetId))
        throw new EngineError('invalid-energy-plan', 'Saved recipients must be eligible and belong to the Energy holder.');
    }
    if (d.action.distribution === 'singleRecipient' && new Set(plan.assignments.map((a) => a.targetId)).size > 1)
      throw new EngineError('invalid-energy-plan', 'This effect requires one common recipient, not separate destinations.');
  }
}
function attackRequirements(s, catalog, owner, m, attack, sourceId, execution = null) {
  const adjustments = [], erasures = [], alternatives = [], reductions = [], groups = new Map(), model = sourceModel(s, catalog);
  let replacement = null;
  for (const e of continuousEntries(s, catalog, model)) {
    const { spec } = e;
    if (spec.op !== 'energyRequirement' || spec.action !== 'attack' || !entryTargets(s, catalog, e, owner, m) ||
        spec.attackIds && !spec.attackIds.includes(attack.attackId)) continue;
    let amount = spec.amount ?? null;
    if (spec.perPrizesTaken) {
      const taken = prizesTakenQuery(s, spec.perPrizesTaken === 'own' ? e.source.owner : 1 - e.source.owner);
      // An unresolved count (tiebreak scope) refuses the attack instead of guessing its cost.
      if (taken.status !== 'resolved') return [];
      amount *= taken.count;
    } else if (spec.perCount) amount *= battleQuery(s, catalog, e.source, {}, model, spec.perCount);
    const value = canonicalJSON([spec.mode, spec.energyType ?? null, amount, spec.count ?? null]);
    if (spec.group && groups.has(spec.group)) {
      if (groups.get(spec.group) !== value) throw new EngineError('unsupported-modifier-conflict', 'Conflicting nonstacking Energy requirements need explicit card semantics.');
      continue;
    }
    if (spec.group) groups.set(spec.group, value);
    const change = { id: e.id, sourceOfTruth: e.sourceOfTruth };
    if (spec.mode === 'replace') {
      if (replacement && canonicalJSON(replacement.cost) !== canonicalJSON(spec.cost))
        throw new EngineError('unsupported-modifier-conflict', 'Two different replaced attack costs need explicit card ordering.');
      replacement ??= { ...change, cost: [...spec.cost] };
    } else if (spec.mode === 'erase') erasures.push(spec.energyType ? { ...change, energyType: spec.energyType } : change);
    // 「减少1个。（减少的可以是任意属性的能量。）」 (energy.requirement.reduce-any).
    else if (spec.mode === 'reduceAny') reductions.push({ ...change, count: spec.count });
    else adjustments.push({ ...change, energyType: spec.energyType, amount });
  }
  if (s.phase !== 'setup') for (const binding of attack.effects) {
    const h = catalog.handler(binding.handlerId);
    if (h.timing !== 'energyOptions') continue;
    const source = sourceFor(s, catalog, sourceId, owner, 'attack', binding, m.id,
      execution?.reference ? s.attack.attack.attackId : attack.attackId, null, execution);
    // 「这个招式，如果……的话，则仅需……便可使用」: the printed condition, read when the attack could be declared.
    if (binding.parameters.condition && !conditionPredicateMet(s, catalog, source, binding.parameters.condition)) continue;
    const option = h.energyOptions(effectContext(s, catalog, source), clone(binding.parameters));
    if (option === null) continue;
    if (!validateEnergyOption(option)) throw new EngineError('invalid-energy-option', 'Conditional Energy requirements must return an explicit reviewed cost or null.');
    alternatives.push({ id: canonicalJSON([binding.effectId, sourceId]), cost: option.cost, sourceOfTruth: binding.sourceOfTruth });
  }
  return resolveEnergyRequirements({ printed: attack.cost, adjustments, erasures, alternatives, replacement, reductions });
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
// d: the attack declaration, resumed with `selected` when 一树 lets its player choose the first coin (null = that choice is pending).
function imposedAttackCheck(s, catalog, m, d) {
  const entries = continuousEntries(s, catalog).filter((e) => e.spec.op === 'attackCheck' &&
    entryTargets(s, catalog, e, s.current, m));
  let group;
  try { group = groupImposedChecks(entries); }
  catch (error) {
    throw new EngineError('unsupported-attack-checks', error.message,
      { sourceOfTruth: requireRule(catalog.ruleset, 'attack.failure.imposed').sourceOfTruth });
  }
  if (!group.length) return true;
  // An opponent's attack effect: 一树 may choose its first coin (effects.coin-choice); it is no coin of this attack to reflip.
  const coin = group[0].spec.coin, step = coinOccasion(s, catalog, d.coinOccasion ??
    { flipper: s.current, spec: failureSpec(coin), will: true, attack: false }, d.selected);
  if (step.ask) {
    ask(s, { ...step.ask, resume: 'attack', data: { ...withoutSelection(d), coinOccasion: step.occ } });
    return null;
  }
  const { results, heads, tails } = step.occ.receipt, receipt = { results, heads, tails, passed: heads >= coin.minimumHeads };
  log(s, 'attack.failure.imposed', { pokemonId: m.id, player: s.current, receipt,
    checks: group.map((e) => ({ id: e.id, source: clone(e.source), coin: clone(e.spec.coin) })) });
  return receipt.passed;
}
function assertCopyFailureScope(s, catalog) {
  const frame = s.attack;
  // Ordinary C-18 chains that only copy have no earlier body to undo. More
  // elaborate compositions need a sourced failure scope, not invented rollback.
  // 「将牌库上方1张卡牌放于弃牌区，如果那张卡牌是宝可梦…的话，则选择那只宝可梦所拥有的1个招式，作为这个招式使用」: the discard
  // before the copy stays done and nothing follows it; a copied attack that does not go on ends the attack (attack.copy).
  if (frame.copies.some((saved) => {
    const parent = executingAttack(s, catalog, saved.execution), moved = parent.effects.length === 1 &&
      parent.effects[0].handlerId === 'cn.thenMoved@1' && parent.effects[0].parameters.next.handlerId === 'cn.copyAttack@1';
    return parent.printedDamage !== null && parent.printedDamage.value !== 0 ||
      !moved && (parent.effects.length !== 1 || parent.effects[0].handlerId !== 'cn.copyAttack@1' ||
      canonicalJSON(catalog.handler(parent.effects[0].handlerId).operations) !== canonicalJSON(['copyAttack'])) ||
      saved.continuation.frames.some((f) => f.kind !== 'sequence' || f.remaining.length || f.performed && !moved);
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
// attack.failure.discard 「将场上的竞技场／放于这只宝可梦身上的「宝可梦道具」放于弃牌区。如果无法将卡牌放于弃牌区的话，则这个招式失败」:
// judged when the attack is used — whether that entry of the attack could discard a card now (a card protected from it cannot).
function failureDiscardPossible(s, catalog, attack) {
  requireRule(catalog.ruleset, 'attack.failure.discard');
  const frame = s.attack, b = attack.effects.find((e) => e.effectId === attack.failureCheck.requires), a = b.parameters;
  const source = sourceFor(s, catalog, frame.sourceId, frame.player, 'attack', b, frame.pokemonId, frame.attack.attackId, null, frame.execution);
  if (b.handlerId === 'cn.discardStadium@1')
    return !!stadiumWindow(effectContext(s, catalog, source), a).target && !stadiumProtections(s, catalog, source).length;
  return toolCards(s, catalog, source, null, a).some((c) => !protections(s, catalog, source, c.owner, c.m, 'effects').length);
}
// resume: the answer to a coin choice that paused this check (attack-coins).
function ownAttackCheck(s, catalog, attack, resume = null) {
  const frame = s.attack;
  if (!attack.failureCheck) { frame.execution.phase = 'body'; return true; }
  assertCopyFailureScope(s, catalog);
  if (attack.failureCheck.handPayment) { beginAttackPayment(s, catalog, attack); return false; }
  // 「如果…的话，则这个招式失败」 is judged on the board when the attack is used.
  const predicate = attack.failureCheck.predicate, coin = attack.failureCheck.coin, requires = attack.failureCheck.requires;
  // The attack's own coins: 一树 may choose the first, a reflip may follow (effects.coin-choice / effects.coin-reflip).
  const step = predicate || requires ? null : coinOccasion(s, catalog, resume?.coinOccasion ??
    { flipper: frame.player, spec: failureSpec(coin), will: true, attack: true }, resume?.selected);
  if (step?.ask) {
    ask(s, { ...step.ask, resume: 'attack-coins', data: { flow: attackFlow(s), stage: 'failure', coinOccasion: step.occ } });
    return false;
  }
  const receipt = predicate ? { kind: 'predicate', passed: !evaluateBattlePredicate(predicate, battleValueFacts(s, catalog,
    executingSource(s, catalog), null, sourceModel(s, catalog), queryNodes(predicate))) } :
    requires ? { kind: 'predicate', passed: failureDiscardPossible(s, catalog, attack) } :
    { results: step.occ.receipt.results, heads: step.occ.receipt.heads, tails: step.occ.receipt.tails, passed: step.occ.receipt.heads >= coin.minimumHeads };
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
    // attack.copy-special-rule: a player who already spent the resource cannot choose such an attack (the
    // opponent's use does not matter); the GX/VSTAR attack declared for this very attack already paid it.
    if (attack.specialRule && d.action.special.mode === 'consumeUserQuota' &&
        s.players[frame.player][attack.specialRule === 'GX' ? 'gxUsed' : 'vstarUsed'] &&
        !frame.usedSpecialRules.includes(attack.specialRule) && !(attack.specialRule === 'GX' && gxAgain(s, catalog, frame.player, m))) return false;
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
    if (execution.phase === 'failure-check' && check?.coin) {
      // A coin check paused for a coin choice (attack-coins): its flips wait in that sealed request.
      if (i !== executions.length - 1 || execution.failureReceipt !== null || s.pending?.resume !== 'attack-coins' || s.pending.data.stage !== 'failure')
        throw new EngineError('invalid-attack-failure', 'Only the current coin check can wait for a coin choice before the attack body.');
    } else if (execution.phase === 'failure-check') {
      if (i !== executions.length - 1 || !check?.handPayment || execution.failureReceipt !== null ||
          s.pending?.resume !== 'attack-payment' || s.pending.player !== frame.player)
        throw new EngineError('invalid-attack-payment', 'Only the active unpaid hand check can wait before the attack body.');
      const d = s.pending.data, spec = assertAttackPaymentChoice(s, catalog, d);
      const cards = commitmentCards(s, catalog, d.hand, frame.player), canPay = canPayAttackCommitment(cards, spec);
      if (s.pending.minimum !== 0 || s.pending.maximum !== (canPay ? spec.count : 0) || !s.pending.allowZero ||
          canonicalJSON(s.pending.options) !== canonicalJSON(canPay ? d.eligible : []))
        throw new EngineError('invalid-attack-payment', 'The payment choice must allow only complete payment or deliberate failure.');
    } else if (check?.handPayment) assertAttackPaymentReceipt(s, catalog, execution);
    else if (check?.predicate || check?.requires) {
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
// A printed heal of N HP on a known Pokémon (II.C-06: damage counters removed, never more than it has).
// 「无法回复HP」: a restriction leaves its HP unchanged.
function healBy(s, catalog, owner, m, amount, source, record = true) {
  if (monProhibited(s, catalog, owner, m, 'heal')) {
    log(s, 'effects.heal', { targetId: m.id, effectId: source.effectId, prevented: 'restriction' });
    return;
  }
  const before = m.counters;
  m.counters = Math.max(0, m.counters - amount / 10); m.facts.healedTurn = s.turn;
  battleFact(s, { kind: 'heal', owner, pokemonId: m.id, amount: (before - m.counters) * 10 });
  if (m.counters * 10 < hp(s, catalog, owner, m)) delete m.facts.knockoutCause;
  if (record) log(s, 'effects.heal', { targetId: m.id, effectId: source.effectId, sourceOfTruth: source.sourceOfTruth, operation: 'heal' });
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
// 「当这只宝可梦从战斗场被放回备战区时」 (trigger.moved-to-bench): the Pokémon that went to the Bench by that same move, as it was
// in the Active Spot (left: its Special Conditions there, 「将自己处于【中毒】状态的战斗宝可梦…互换时」).
function becameActiveWork(s, catalog, player, m, cause, outgoing = null, left = null) {
  return triggerWork(s, catalog, [makeTriggerEvent(s, catalog, 'becameActive', player, m, { cause }),
    ...(outgoing ? [makeTriggerEvent(s, catalog, 'movedToBench', player, outgoing, { cause, snapshot: { ...clone(outgoing), conditions: left } })] : [])]);
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
  if (condition.prizesRemaining && s.players[player].prizes.length <= s.players[1 - player].prizes.length) return false;
  if (condition.sourceActive && s.players[player].active !== m) return false;
  if (condition.previousOpponentKnockout) {
    requireRule(catalog.ruleset, BATTLE_HISTORY_RULES.previousOpponentKO.id);
    if (!hadKnockoutInPreviousOpponentTurn(s.battleHistory, { turn: s.turn, during: s.current }, { owner: player })) return false;
  }
  if (condition.attachedEnergyType && !sourceModel(s, catalog).pokemon[m.id].energies
    .some((e) => e.units.some((unit) => unit.includes(condition.attachedEnergyType)))) return false;
  return !condition.predicate || conditionPredicateMet(s, catalog, { owner: player, pokemonId: m?.id ?? null }, condition.predicate);
}
// I.B-03 bars Supporters on the first player's first turn; printed 「即使是先攻玩家的最初回合也可以使用」 lifts it (II.E-27).
function firstTurnUse(catalog, def) {
  if (def.mechanics.firstTurnUse) requireRule(catalog.ruleset, 'trainer.first-turn-use');
  return !!def.mechanics.firstTurnUse;
}
// A player's own turn limit changed by a player effect (playerLimit) while it lasts.
const playerLimits = (s, player, action) => s.playerOngoing.filter((e) => e.player === player && e.effect.op === 'playerLimit' &&
  e.effect.action === action && ongoingIsActive(e, s));
// I.B-03: one Supporter a turn. 「在这个回合，自己可以使用的支援者数量变为3张。（包括这张卡牌。）」: every Supporter the player
// has played from the hand this turn counts, this card included.
function supporterSpent(s, catalog, player) {
  if (!s.players[player].flags.supporter) return false;
  const limits = playerLimits(s, player, 'playSupporter');
  if (!limits.length) return true;
  requireRule(catalog.ruleset, 'trainer.supporter-limit');
  return s.battleHistory.events.filter((e) => e.kind === 'supporterPlayed' && e.origin === 'hand' && e.owner === player && e.turn === s.turn)
    .length >= Math.max(...limits.map((e) => e.effect.count));
}
// I.C: one Energy attached from the hand a turn. 「自己可以从手牌将任意张能量附着于宝可梦身上」: no limit that turn.
function handEnergyRoom(s, catalog, player) {
  if (!s.players[player].flags.energy) return true;
  if (!playerLimits(s, player, 'attachEnergy').length) return false;
  requireRule(catalog.ruleset, 'turn.energy-limit');
  return true;
}
// 「在这个回合，即使自己已经使用过GX招式了，自己的【水】宝可梦，依然可以使用GX招式」: this Pokémon (current types) may use one again.
function gxAgain(s, catalog, player, m) {
  const limits = playerLimits(s, player, 'gxAttack');
  if (!limits.length) return false;
  const model = sourceModel(s, catalog), again = limits.some((e) => !e.effect.targetSelector ||
    matchesInPlaySelector(monDef(s, catalog, m), e.effect.targetSelector, model.pokemon[m.id].types));
  if (again) requireRule(catalog.ruleset, 'attack.special-rule-reuse');
  return again;
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
// trainer.joint-play: a Trainer's entries for one card played alone, or (playCount N) for N cards of its name played together.
const playedEffects = (def, request) => def.mechanics.effects.filter((b) => (b.playCount ?? 1) === (request.jointCardIds?.length ?? 0) + 1);
const jointCount = (def) => def.mechanics.effects.find((b) => b.playCount)?.playCount ?? null;
// 「同时使用N张」: the other N−1 cards of this name in the hand, offered once per name (from its first card in the hand).
function jointCards(s, catalog, player, id) {
  const d = cardDef(s, catalog, id), count = jointCount(d);
  if (!count) return null;
  const same = s.players[player].hand.filter((c) => cardDef(s, catalog, c).nameKey === d.nameKey && jointCount(cardDef(s, catalog, c)) === count);
  return same[0] === id && same.length >= count ? same.slice(1, count) : null;
}
// What the cards played together would change is judged with the other N−1 already out of the hand (as the played card itself is).
function jointProjection(s, request) {
  const state = copyState(s), p = state.players[request.player];
  for (const id of request.jointCardIds) { remove(p.hand, id); p.resolving.push(id); }
  return state;
}
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
  let costs = [], work = [], physical = false, valid = true, optional = [], replaced = null;
  const bindings = (items, category, pokemonId = null, origin = null) => items.map((binding) => ({
    binding, source: sourceFor(s, catalog, sourceId, player, category, binding, pokemonId, null, origin),
  }));
  if (kind === 'trainer') {
    valid = s.current === player && s.cards[sourceId].owner === player && p.hand.includes(sourceId) && def.kind === 'trainer';
    if (valid) {
      const category = def.mechanics.category, action = { item: 'playItem', supporter: 'playSupporter', tool: 'playTool', stadium: 'playStadium' }[category];
      // effects.supporter-replacement: a changed Supporter is still played as itself, with only the replacement as its effect.
      replaced = supporterReplacement(s, catalog, sourceId);
      valid = !playerProhibited(s, catalog, player, action) && !handLocked(s, catalog, player, sourceId) && (replaced || trainerConditionMet(s, catalog, player, def.mechanics.condition)) &&
        !(category === 'supporter' && (supporterSpent(s, catalog, player) || s.turn === 1 && !firstTurnUse(catalog, def))) &&
        !(category === 'stadium' && (p.flags.stadium || s.stadium && cardDef(s, catalog, s.stadium).nameKey === def.nameKey)) &&
        !(category === 'tool' && !mons(p).some((m) => toolTarget(s, catalog, m, def)));
      physical = ['tool', 'stadium'].includes(category); costs = replaced ? [] : def.mechanics.playCosts ?? []; optional = replaced ? [] : def.mechanics.optionalPlayCosts ?? [];
      // tools.attack-tails: a Tool's turn-end program is recorded by its holder's attack, never by playing the card.
      work = bindings(replaced ? [replaced.binding] : playedEffects(def, request).filter((b) => !b.trigger && !b.parameters.on &&
        (catalog.handler(b.handlerId).timing ?? 'resolve') === 'resolve'), 'trainer');
    }
  } else if (kind === 'ability' && def.kind === 'trainer') {
    // tools.granted-ability: the source is the Tool attached to the using Pokémon, not that Pokémon's card.
    requireRule(catalog.ruleset, 'tools.granted-ability');
    const found = findMon(s, request.pokemonId), a = found && grantedAbilitiesFor(s, catalog, found.m)
      .find((g) => g.toolId === sourceId && g.ability.abilityId === request.abilityId)?.ability;
    valid = s.current === player && found?.owner === player && !!a && usageAllowed(s, player, found.m, a.usage) &&
      !(a.specialRule === 'VSTAR' && p.vstarUsed) && abilityConditionMet(s, catalog, player, found.m, a.condition);
    if (valid) work = bindings(a.effects, 'ability', found.m.id);
  } else if (kind === 'ability') {
    const found = findMon(s, request.pokemonId), a = def.mechanics.abilities?.find((a) => a.abilityId === request.abilityId && a.mode === 'activated');
    valid = s.current === player && found?.owner === player && top(found.m) === sourceId && !!a &&
      sourceModel(s, catalog).availability.get(sourceNodeId('ability', sourceId, a.abilityId)).enabled &&
      usageAllowed(s, player, found.m, a.usage) && !(a.specialRule === 'VSTAR' && p.vstarUsed) &&
      abilityConditionMet(s, catalog, player, found.m, a.condition);
    if (valid) { costs = a.costs ?? []; work = bindings(a.effects, 'ability', found.m.id); }
  } else if (kind === 'cardAbility') {
    // ability.zone: 「如果这张卡牌在手牌中／弃牌区的话，则…可以使用」, the card itself still there.
    const a = def.kind === 'pokemon' ? def.mechanics.abilities.find((a) => a.abilityId === request.abilityId && a.zone) : null;
    valid = s.current === player && !!a && s.cards[sourceId].owner === player && p[a.zone].includes(sourceId) &&
      !(a.zone === 'hand' && handAbilityLocked(s, catalog, player, sourceId, a)) && !sourceModel(s, catalog).zoneSuppressions.some(({ entry, source }) =>
        suppressionApplies(entry, source, { kind: 'ability', owner: player, pokemonId: null, key: a.abilityId, mechanics: def.mechanics, definition: def,
          active: false })) &&
      cardUsageAllowed(s, player, sourceId, a.usage) && abilityConditionMet(s, catalog, player, null, a.condition);
    if (valid) work = bindings(a.effects, 'ability', null, a.zone);
  } else if (kind === 'recall') {
    // trainer.discard-recall 「在自己的回合，如果将2张自己的手牌（除「X」外）放于弃牌区的话，则将这张「X」从弃牌区…加入手牌」: not playing it.
    const recall = def.kind === 'trainer' ? def.mechanics.discardRecall : null;
    valid = s.current === player && !!recall && s.cards[sourceId].owner === player && p.discard.includes(sourceId);
    if (valid) { requireRule(catalog.ruleset, 'trainer.discard-recall'); physical = true; costs = recall.costs; }
  } else if (kind === 'stadium') {
    valid = s.current === player && s.stadium === sourceId && !playerProhibited(s, catalog, player, 'useStadium');
    if (valid) {
      const items = def.mechanics.effects.filter((b) => catalog.handler(b.handlerId).timing === 'onUse');
      valid = items.length > 0 && items.every((b) => usageAllowed(s, player, p.active, handlerUsage(catalog, b)));
      costs = items.flatMap((b) => b.activationCosts ?? []); work = bindings(items, 'trainer');
    }
  } else if (kind === 'energy') {
    valid = s.current === player && def.kind === 'energy' && s.cards[sourceId].owner === player && p.hand.includes(sourceId) &&
      handEnergyRoom(s, catalog, player) && findMon(s, request.pokemonId)?.owner === player && !handLocked(s, catalog, player, sourceId) &&
      !(def.mechanics.category === 'special' && playerProhibited(s, catalog, player, 'attachSpecialEnergy'));
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
  } else if (kind === 'copy') {
    // effects.copy-supporter: the chosen Supporter's own use condition, costs and effects, for the copying player, with
    // the copying card or attack as their source (I.B-03 step 1; JP Q&A メロコ／ヒガナの決意／ルミタン).
    // effects.supporter-replacement: a card still in a hand may have the changed effect instead (JP Q&A ナツメの暗示／ポケモンごっこ).
    const record = copyRecord(s, request.copyId, 'selected', 'effects.copy-supporter');
    valid = record?.reference.instanceId === sourceId && record.source.owner === player && !copyRecord(s, request.copyId, 'used', 'effects.copy-supporter');
    replaced = valid ? supporterReplacement(s, catalog, sourceId) : null;
    valid &&= !!replaced || trainerConditionMet(s, catalog, player, def.mechanics.condition);
    if (valid) {
      costs = replaced ? [] : def.mechanics.playCosts ?? []; optional = replaced ? [] : def.mechanics.optionalPlayCosts ?? [];
      const { contentSource: _content, copyId: _copy, grantId: _grant, ...host } = record.source;
      // Its 「当…时」 parts (a beforeHand reaction) are no part of using it.
      work = (replaced ? [replaced.binding] : def.mechanics.effects.filter((b) => !b.trigger)).map((binding) => ({
        binding, source: { ...clone(host), effectId: binding.effectId, sourceOfTruth: clone(binding.sourceOfTruth),
          contentSource: replaced ? clone(replaced.reference) : { instanceId: sourceId }, copyId: request.copyId } }));
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
  return { valid, physical, costs, work, optional, replaced };
}
// 「如果将这只宝可梦身上附着的…放于弃牌区的话」 pays from the using Pokémon's attached cards; every other cost from the hand.
function paymentCards(s, catalog, request, costs) {
  const attached = costs.some((c) => c.kind === 'discardAttached');
  return (attached ? findMon(s, request.pokemonId).m.energy : s.players[request.player].hand.filter((id) => id !== request.sourceId))
    .map((instanceId) => ({ instanceId, definition: cardDef(s, catalog, instanceId) }));
}
function activationUsable(s, catalog, request) {
  if (request.jointCardIds) s = jointProjection(s, request);
  const info = activationInfo(s, catalog, request);
  if (!info.valid) return false;
  if (info.costs.length && !findCostPayment(info.costs, paymentCards(s, catalog, request, info.costs))) return false;
  if (info.optional.length) { const choice = optionalCostChoice(s, catalog, request, info); return choice.unpaid || choice.paid; }
  return activationEffectsUsable(s, catalog, request, info, info.costs.length > 0);
}
// effects.optional-cost 「另外，当使用这张卡牌时，可将N张自己的手牌放于弃牌区。在这种情况下，…」: the card may be played when a part could
// change something without the discard, or with it; the cards may be discarded only when a part that needs them could.
const paidInfo = (info) => ({ ...info, costs: info.optional, work: info.work.filter((d) => d.binding.handlerId === 'cn.ifPaid@1') });
function optionalCostChoice(s, catalog, request, info) {
  return { unpaid: activationEffectsUsable(s, catalog, request, info, false),
    paid: !!findCostPayment(info.optional, paymentCards(s, catalog, request, info.optional)) && activationEffectsUsable(s, catalog, request, paidInfo(info), true) };
}
// Candidate eligibility, use permission and actual execution are separate.
// I.A-02 p8 / I.B-01 p11 / I.B-03 p12 disallow a known wholly unchanged
// voluntary activation, not selecting a protected object during a valid one.
// This source-aware proof covers these native leaves, not arbitrary programs.
function nativeActivationQualifies(s, catalog, d, ctx, handlerId) {
  requireRule(catalog.ruleset, 'effects.activation-change');
  const p = d.binding.parameters, source = d.source;
  const owner = p.side === 'opponent' ? 1 - source.owner : source.owner;
  const placesCounters = ['cn.counters@1', 'cn.distributeCounters@1'].includes(handlerId);
  const qualifies = (pool) => {
    let uncertain = false;
    for (const m of pool) {
      const entries = [...protectionEntries(s, catalog, source, owner, m, 'effects'),
        ...(placesCounters ? protectionEntries(s, catalog, source, owner, m, 'counters') : [])];
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
  const stadiumQualifies = (a) => {
    if (!stadiumWindow(ctx, a).target) return false;
    const entries = stadiumProtections(s, catalog, source);
    if (!entries.length || entries.every((e) => e.spec.useRule === 'CN.E29')) return true;
    return entries.some((e) => e.spec.useRule === 'CN.E29') ? null : false;
  };
  if (handlerId === 'cn.discardStadium@1') return stadiumQualifies(p);
  if (handlerId === 'cn.discardTools@1') {
    const tools = qualifies([...new Set(toolCards(s, catalog, source, d.event ?? null, p).map((c) => c.m))]);
    const field = p.stadium ? stadiumQualifies(ANY_STADIUM) : false;
    return tools || field || (tools === null || field === null ? null : false);
  }
  if (handlerId === 'cn.distributeCounters@1')
    return p.count > 0 && qualifies(counterDistributionWindow(ctx, p).targets.map(({ pokemonId }) => findMon(s, pokemonId).m));
  if (handlerId === 'cn.healPokemon@1')
    return qualifies(healingWindow(ctx, p).targets.filter((t) => t.counters > 0).map(({ pokemonId }) => findMon(s, pokemonId))
      .filter(({ owner: holder, m }) => !monProhibited(s, catalog, holder, m, 'heal')).map(({ m }) => m));
  if (handlerId === 'cn.switch@1') {
    const player = s.players[owner];
    const model = p.selector || p.state || p.activeSelector ? sourceModel(s, catalog) : null;
    const bench = p.affected === 'source' ? player.bench.filter((m) => m.id === source.pokemonId) :
      player.bench.filter((m) => !model || pokemonMatches(s, catalog, model, m, p));
    return !!player.active && bench.length > 0 && qualifies(p.affected === 'active' ? [player.active] : bench) &&
      (!p.activeSelector || pokemonMatches(s, catalog, model, player.active, { selector: p.activeSelector }));
  }
  // 「回复自己1只【草】宝可梦…」: a heal's printed kind narrows its candidates as it does a counter placement's.
  const kind = handlerId === 'cn.counters@1' || handlerId === 'cn.heal@1' && p.targetSelector;
  return qualifies((kind ? countersPool(s, catalog, source, p, owner) : targetedPokemon(s, owner, source, d.event ?? null, p.target))
    .filter((m) => handlerId !== 'cn.heal@1' || m.counters > 0 && !monProhibited(s, catalog, owner, m, 'heal') ||
      p.cureAll && presentConditions(m.conditions).length > 0));
}
// 「只有将自己的N张手牌放于弃牌区／放逐区后才可使用」: each paid group goes where its cost says. 「放回牌库下方」: the last
// chosen lowest; 「将这只宝可梦身上附着的…放于弃牌区」: off the Pokémon that holds it.
function payCostCards(s, catalog, player, costs, groups) {
  for (const g of groups) for (const id of g.cardIds) {
    const kind = costs.find((c) => c.costId === g.costId).kind;
    if (kind === 'discardAttached') {
      const { m } = allMons(s).find(({ m }) => m.energy.includes(id));
      discardFromPlay(s, catalog, id); remove(m.energy, id); continue;
    }
    remove(s.players[player].hand, id);
    if (kind === 'lostHand') toLost(s, id); else if (kind === 'bottomHand') s.players[player].deck.unshift(id); else discard(s, catalog, id);
  }
}
function projectedPayment(s, catalog, request, groups) {
  const state = copyState(s);
  const info = activationInfo(s, catalog, request);
  payCostCards(state, catalog, request.player, info.optional.length ? info.optional : info.costs, groups);
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
  // Likewise the cards played together, projected out of the hand to judge them (jointProjection).
  for (const id of request.jointCardIds ?? []) { remove(player.resolving, id); player.hand.push(id); }
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
    const result = nativeActivationQualifies(s, catalog, d, factContext(s, catalog, {},
      effectContext(s, catalog, d.source, d.event ?? null, false, null, false, d.entry ?? null, payment, request), d.source, d.binding.parameters),
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
  const witness = findCostPaymentWitness(info.costs, paymentCards(s, catalog, request, info.costs), (groups) => {
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
    return [...d.mechanics.effects, ...d.mechanics.abilities.flatMap((a) => a.effects), ...grantedAbilityEntries(s, m).flatMap(grantedAbilityBindings),
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
  const native = ['trainer', 'ability', 'copy'].includes(request.kind) ?
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
  if (info.optional.length) {
    const { unpaid, paid } = optionalCostChoice(s, catalog, request, info), count = costCardCount(info.optional);
    if (!paid) { commitActivation(s, catalog, request, null, info); return; }
    ask(s, { player: request.player, kind: 'activation-cost', options: costOptions(s, catalog, request, info.optional), minimum: count, maximum: count,
      allowZero: unpaid, resume: 'activation-choice', data: { activation: request }, ruleId: 'effects.optional-cost' });
    return;
  }
  if (!info.costs.length) { commitActivation(s, catalog, request, null, info); return; }
  const options = costOptions(s, catalog, request, info.costs);
  const count = costCardCount(info.costs);
  ask(s, { player: request.player, kind: 'activation-cost', options, minimum: count, maximum: count,
    resume: 'activation-choice', data: { activation: request }, ruleId: 'effects.activation-cost' });
}
function costOptions(s, catalog, request, costs) {
  const pool = paymentCards(s, catalog, request, costs);
  return costs.flatMap((cost) => pool.filter((c) => matchesCardSelector(c.definition, cost.selector))
    .map((c) => paymentOptionId(cost.costId, c.instanceId)));
}
function payActivation(s, catalog, request, selected) {
  const info = activationInfo(s, catalog, request), optional = info.optional.length > 0;
  // effects.optional-cost: declining pays nothing; the card is then played without its paid parts.
  if (optional && !selected.length) {
    if (!info.valid || !optionalCostChoice(s, catalog, request, info).unpaid)
      throw new EngineError('invalid-cost-payment', 'Without the optional cost nothing of this card could change anything.');
    log(s, 'effects.optional-cost', { player: request.player, sourceId: request.sourceId, paid: false });
    commitActivation(s, catalog, request, null, info); return;
  }
  const costs = optional ? info.optional : info.costs, groups = readCostPayment(costs, paymentCards(s, catalog, request, costs), selected);
  if (!info.valid || !groups) throw new EngineError('invalid-cost-payment', 'All cost groups must be paid exactly, with no card paid twice.');
  const { state: projected, payment } = projectedPayment(s, catalog, request, groups);
  if (!activationEffectsUsable(projected, catalog, request, optional ? paidInfo(info) : info, false, payment))
    throw new EngineError('invalid-cost-payment', 'This payment leaves no usable subsequent effect.');
  payCostCards(s, catalog, request.player, costs, groups);
  s.serial++;
  log(s, 'effects.activation-cost', { payment, source: clone(s.cards[request.sourceId]), sourceOfTruth: costs.flatMap((c) => c.sourceOfTruth) });
  commitActivation(s, catalog, request, payment, info);
}
// II.E-20 文例3: 「如果使用了，则自己的回合结束」 ends the turn once the card or Ability has resolved.
function endTurnWork(catalog, printed, player) {
  if (!printed.endsTurn) return [];
  requireRule(catalog.ruleset, 'effects.end-turn');
  return [tasks('ko'), tasks('end-turn', { player })];
}
// effects.supporter-replacement: fixed as the card is used. The record ties the run to the changing Ability and to what
// used the card (the played Supporter, or a copy's card or attack).
function replacedWork(s, catalog, cardId, replaced, host) {
  const id = `replaced${++s.serial}`;
  log(s, 'effects.supporter-replacement', { kind: 'replaced', id, cardId, source: clone(host), reference: clone(replaced.reference) });
  const { contentSource: _content, copyId: _copy, grantId: _grant, ...identity } = host;
  const source = { ...clone(identity), effectId: replaced.binding.effectId, sourceOfTruth: clone(replaced.binding.sourceOfTruth),
    contentSource: clone(replaced.reference), copyId: id };
  return [tasks('effect', scheduleTrackedEffect(s, catalog, { binding: replaced.binding, source }))];
}
// trigger.discarded 「当这张卡牌（这只宝可梦）因为「X」的效果而被放于弃牌区时」: the discarded card's own Abilities this Item/Supporter
// effect starts (abilities: those of a Pokémon in play still in effect when it was chosen), latched on that Trainer's finalizer so
// they are used once its whole effect is done (「…的时间点在「X」的效果之后」).
function latchDiscarded(s, catalog, source, cardIds, from, abilities = null) {
  for (const cardId of cardIds) for (const a of abilities?.get(cardId) ?? cardDef(s, catalog, cardId).mechanics.abilities ?? []) {
    if (a.trigger?.event !== 'discarded' || a.trigger.from !== from ||
        !causeMatches(a.trigger.causeSource, { kind: 'effect', source }, s.cards[cardId].owner, (id) => cardDef(s, catalog, id))) continue;
    const finish = s.queue.find((t) => t.op === 'finish-trainer' && t.data.cardId === source.instanceId);
    if (!finish) throw new EngineError('unresolved-discard-trigger', 'A discarded card\'s Ability needs its discarding Trainer\'s own resolution to follow.');
    const unit = { id: `x${++s.serial}`, cardId, abilityId: a.abilityId };
    finish.data.discarded = [...(finish.data.discarded ?? []), unit];
    log(s, 'trigger.discarded', { kind: 'latched', ...unit, player: finish.data.player, from, completionId: finish.data.completionId });
  }
}
// A latched use: its receipt, an owned card and the Ability approved for it.
function discardedAbility(s, catalog, player, unit) {
  const receipt = s.events.filter((e) => e.ruleId === 'trigger.discarded' && e.data.kind === 'latched' && e.data.id === unit.id);
  const ability = cardDef(s, catalog, unit.cardId).mechanics.abilities?.find((a) => a.abilityId === unit.abilityId && a.trigger?.event === 'discarded');
  if (receipt.length !== 1 || receipt[0].data.cardId !== unit.cardId || receipt[0].data.abilityId !== unit.abilityId ||
      receipt[0].data.player !== player || s.cards[unit.cardId].owner !== player || !ability)
    throw new EngineError('invalid-discard-trigger', 'A discarded card\'s Ability must retain its own latched receipt and approved definition.');
  return ability;
}
// effects.stadium-replacement: the leaving Stadium's own effect, while it applies (not while its effects are removed).
function stadiumReplacement(s, catalog, stadiumId) {
  return continuousEntries(s, catalog).find((e) => e.spec.op === 'stadiumReplacement' && e.source.instanceId === stadiumId) ?? null;
}
function commitActivation(s, catalog, request, payment, info) {
  const { player, sourceId, kind } = request, p = s.players[player], def = cardDef(s, catalog, sourceId);
  if (kind === 'trainer') {
    const category = def.mechanics.category, joint = request.jointCardIds ? { jointCardIds: [...request.jointCardIds] } : {};
    remove(p.hand, sourceId); p.resolving.push(sourceId); s.phase = 'resolving';
    // trainer.joint-play: the cards played together leave the hand with it, as one use of an Item.
    for (const id of joint.jointCardIds ?? []) { remove(p.hand, id); p.resolving.push(id); }
    if (joint.jointCardIds) requireRule(catalog.ruleset, 'trainer.joint-play');
    if (category === 'supporter') {
      p.flags.supporter = true;
      battleFact(s, { kind: 'supporterPlayed', owner: player, cardId: sourceId, origin: 'hand' });
    }
    if (category === 'stadium') p.flags.stadium = true;
    if (category === 'tool') prepend(s, tasks('attach-tool', { player, cardId: sourceId }));
    else if (category === 'stadium') {
      const leaving = s.stadium, replaced = leaving && stadiumReplacement(s, catalog, leaving);
      remove(p.resolving, sourceId); if (leaving) discard(s, catalog, leaving); s.stadium = sourceId;
      log(s, 'turn.stadium', { player, cardId: sourceId }); s.phase = 'main';
      // effects.stadium-replacement 「将这张竞技场放于弃牌区之后，那张竞技场也会被放于弃牌区。（新出场的竞技场的效果不产生作用。）」
      if (replaced) {
        discard(s, catalog, sourceId); s.stadium = null;
        log(s, 'effects.stadium-replacement', { player, cardId: sourceId, by: leaving, effectId: replaced.id });
      }
      // The discarded Stadium's holder settles a lowered Bench limit first; a Stadium that itself lowers the limit:
      // 「放于弃牌区的动作由这张卡牌的持有者开始执行」.
      const first = def.mechanics.effects.some((b) => b.handlerId === 'cn.benchLimit@1') || !leaving ? player : s.cards[leaving].owner;
      prepend(s, tasks('bench-trim', { order: [first, 1 - first] }), tasks('ko'));
    } else {
      const completionId = `trainer${++s.serial}`;
      log(s, 'turn.trainer', { kind: 'trainer-open', id: completionId, player, cardId: sourceId, ...joint, turn: s.turn });
      // effects.supporter-replacement: only the replacement; no 「自己的回合结束」 (JP Q&A ダイゴの決断).
      if (info.replaced) {
        prepend(s, ...replacedWork(s, catalog, sourceId, info.replaced, sourceFor(s, catalog, sourceId, player, 'trainer', info.replaced.binding)),
          tasks('finish-trainer', { player, cardId: sourceId, completionId }));
        return;
      }
      // effects.turn-kept 「只要这只宝可梦在战斗场上，即使自己使用了「X」，自己的回合也不会结束」: judged as the card is played.
      const kept = def.mechanics.endsTurn ? continuousEntries(s, catalog).filter((e) => e.spec.op === 'turnKept' && e.source.owner === player &&
        (!e.spec.sourceActive || s.players[player].active?.id === e.source.pokemonId) && matchesCardSelector(def, e.spec.trainer)) : [];
      if (kept.length) log(s, 'effects.turn-kept', { player, cardId: sourceId, effects: kept.map((e) => e.id) });
      prepend(s, ...effectTasks(s, catalog, sourceId, player, 'trainer', playedEffects(def, request), 'resolve', null, null, payment),
        tasks('finish-trainer', { player, cardId: sourceId, ...joint, completionId }), ...(kept.length ? [] : endTurnWork(catalog, def.mechanics, player)));
    }
  } else if (kind === 'energy') {
    const { m } = findMon(s, request.pokemonId);
    remove(p.hand, sourceId); m.energy.push(sourceId); p.flags.energy = true;
    enforceEnergyRetention(s, catalog);
    log(s, 'turn.energy', { player, cardId: sourceId, pokemonId: m.id });
    prepend(s, ...triggerWork(s, catalog, [makeTriggerEvent(s, catalog, 'energyAttached', player, m, { origin: 'hand', cardId: sourceId, payment })]), tasks('ko'));
  } else if (kind === 'ability') {
    // tools.granted-ability: a Trainer source is the Tool whose printed Ability the Pokémon uses.
    const { m } = findMon(s, request.pokemonId), tool = def.kind === 'trainer',
      a = (tool ? def.mechanics.grantedAbilities : def.mechanics.abilities).find((a) => a.abilityId === request.abilityId);
    recordUsage(s, player, m, a.usage); spendSpecialRule(s, catalog, player, a.specialRule);
    log(s, 'ability.usage', { player, pokemonId: m.id, abilityId: a.abilityId, ...(tool ? { toolId: sourceId } : {}) });
    prepend(s, ...effectTasks(s, catalog, sourceId, player, 'ability', a.effects, 'resolve', m.id, null, payment), tasks('ko'),
      ...endTurnWork(catalog, a, player));
  } else if (kind === 'recall') {
    // effects.move-lock: this Trainer's own effect; once paid, a card that cannot be put into the hand stays (JP Q&A リククラゲ × スーパーエネルギー回収).
    if (keptCards(s, catalog, { category: 'trainer', owner: player, instanceId: sourceId }, [sourceId], { zone: 'discard', to: 'hand', holder: player }).length) return;
    remove(p.discard, sourceId); p.hand.push(sourceId);
    log(s, 'trainer.discard-recall', { player, cardId: sourceId, revealed: clone(s.cards[sourceId]) });
  } else if (kind === 'cardAbility') {
    const a = def.mechanics.abilities.find((a) => a.abilityId === request.abilityId);
    recordCardUsage(s, player, sourceId, a.usage);
    log(s, 'ability.usage', { player, cardId: sourceId, zone: a.zone, abilityId: a.abilityId });
    prepend(s, ...effectTasks(s, catalog, sourceId, player, 'ability', a.effects, 'resolve', null, null, payment, null, a.zone), tasks('ko'),
      ...endTurnWork(catalog, a, player));
  } else if (kind === 'copy') {
    // effects.copy-supporter: the copied Supporter's effects run now, as the copying card's or attack's own. Its
    // 「自己的回合结束」 ends a Trainer user's turn once that Trainer has resolved (JP Q&A ナツメの暗示／ダイゴの決断); an attack
    // ends the turn anyway.
    log(s, 'effects.copy-supporter', { kind: 'used', id: request.copyId, player, paid: payment !== null });
    const host = copyRecord(s, request.copyId, 'selected', 'effects.copy-supporter').source;
    if (info.replaced) { prepend(s, ...replacedWork(s, catalog, sourceId, info.replaced, host)); return; }
    prepend(s, ...info.work.map((d) => tasks('effect', scheduleTrackedEffect(s, catalog, { ...d, payment }))));
    const at = s.queue.findIndex((t) => t.op === 'finish-trainer' && t.data.cardId === host.instanceId);
    // A Trainer that itself ends the turn has queued that end already.
    if (at >= 0 && !s.queue.slice(at + 1).some((t) => t.op === 'end-turn')) s.queue.splice(at + 1, 0, ...endTurnWork(catalog, def.mechanics, player));
  } else if (kind === 'stadium') {
    const uses = stadiumUsages(catalog, info.work.map((d) => d.binding));
    for (const usage of uses.values()) recordUsage(s, player, p.active, usage);
    prepend(s, ...effectTasks(s, catalog, sourceId, player, 'trainer', def.mechanics.effects, 'onUse', null, null, payment), tasks('ko'),
      ...endTurnWork(catalog, { endsTurn: info.work.some((d) => d.binding.parameters.endsTurn === true) }, player));
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
    // effects.end-turn-trigger 「当将这张卡牌从手牌使出放于备战区时，可使用1次，如果使用了的话，则自己的回合结束」: the turn ends
    // once the effects this same event triggered are done (the rest of its window).
    const ability = def.mechanics.abilities?.find((a) => a.abilityId === u.abilityId);
    if (ability?.endsTurn) {
      requireRule(catalog.ruleset, 'effects.end-turn-trigger');
      s.queue.splice(s.queue.findIndex((t) => t.op === 'trigger-window') + 1, 0, ...endTurnWork(catalog, ability, source.owner));
    }
  }
}
function assertPayment(s, catalog, payment, source = null) {
  // effects.copy-supporter: a copy pays the copied Supporter card's own cost.
  if (!validatePaymentReceipt(payment) || source && payment.sourceId !== (payment.kind === 'copy' ? source.contentSource?.instanceId : source.instanceId))
    throw new EngineError('invalid-payment-receipt', 'Payment receipt does not match its activation source.');
  if (payment.kind !== 'trigger' && source && payment.player !== source.owner ||
      ['trainer', 'ability', 'energy', 'entry'].includes(payment.kind) && s.cards[payment.sourceId]?.owner !== payment.player)
    throw new EngineError('invalid-payment-receipt', 'A payment must retain its actual activator, independently of the Stadium card holder.');
  const record = s.events.find((e) => e.ruleId === 'effects.activation-cost' && e.data.payment?.id === payment.id);
  if (!record || canonicalJSON(record.data.payment) !== canonicalJSON(payment))
    throw new EngineError('invalid-payment-receipt', 'Payment must retain the committed, journaled receipt.');
  const d = cardDef(s, catalog, payment.sourceId);
  let costs;
  if (['trainer', 'copy'].includes(payment.kind)) costs = d.mechanics.playCosts ?? d.mechanics.optionalPlayCosts;
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
    if (p.faceUpPrizes && (!p.faceUpPrizes.length || new Set(p.faceUpPrizes).size !== p.faceUpPrizes.length ||
        p.faceUpPrizes.some((id) => !p.prizes.includes(id))))
      throw new EngineError('invalid-prizes', 'Face-up Prize cards must be distinct cards among that player’s Prizes.');
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
      if (m.facts.formSince > s.battleHistory.events.length || m.facts.stayedAsleepTurn > s.turn)
        throw new EngineError('invalid-time', 'A Pokémon form or Sleep check cannot come from future history.');
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
    // attack.copy-previous: every used attack keeps the printed attack it actually was.
    if (event.kind === 'attackUsed' && (!event.reference || copiedAttack(s, catalog, event.reference).name !== event.attackName))
      throw new EngineError('invalid-history-source', 'A used attack must retain its actual printed attack.');
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
    // effects.duration.user-leaves-active: an effect on another Pokémon that ends with its user's leaving needs that user there.
    if (entry.clearOnLeaveActive && s.players[entry.source.owner].active?.id !== entry.source.pokemonId)
      throw new EngineError('invalid-ongoing', 'An effect ending when its user leaves the Active Spot needs that user there.');
    // ability.granted: the granted Ability's entries are reviewed continuous leaves, as in the effect that gave it.
    if (entry.effect.op === 'abilityGrant' && !catalog.handler('cn.lasting@1').validateParameters({ side: 'own', target: 'self',
      effect: entry.effect, duration: entry.duration, clearOnBench: false, clearOnEvolution: false }))
      throw new EngineError('invalid-ongoing', 'A granted Ability holds only reviewed continuous entries.');
  }
  for (const entry of s.playerOngoing) {
    assertPlayerOngoingEffect(entry, s);
    if (effectIds.has(entry.id) || !validSource(s, catalog, entry.source))
      throw new EngineError('invalid-player-effect', 'Player effects need a unique identity and their actual original source.');
    // effects.duration.user-leaves-active: such an effect exists only while its user is still the Active Pokémon.
    if (entry.clearOnLeaveActive && s.players[entry.source.owner].active?.id !== entry.source.pokemonId)
      throw new EngineError('invalid-player-effect', 'A player effect ending when its user leaves the Active Spot needs that user there.');
    // effects.player-ability-removal: the protected Active Pokémon is exempt only while it stays in the Active Spot.
    if (entry.exemptId && s.players[1 - entry.source.owner].active?.id !== entry.exemptId)
      throw new EngineError('invalid-player-effect', 'An exempt Pokémon must still be the opponent\'s Active Pokémon.');
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
      'attack-payment': validateAttackPaymentChoice, 'ko-discard': validateKnockoutWork,
      'discard-window': validateDiscardWindow, 'discard-use': validateDiscardUse }[task.op];
    if (validator && !validator(task.data))
      throw new EngineError('invalid-effect-continuation', 'Corrupt effect/trigger resolution.', { errors: validator.errors });
    // trigger.discarded: every latched use keeps its receipt and approved Ability.
    for (const unit of task.op === 'discard-window' ? task.data.units : task.op === 'discard-use' ? [task.data.unit] :
      task.op === 'finish-trainer' ? task.data.discarded ?? [] : []) discardedAbility(s, catalog, task.data.player, unit);
    if (task.op === 'discard-use' && !s.players[task.data.player].discard.includes(task.data.unit.cardId))
      throw new EngineError('invalid-discard-trigger', 'A discarded card\'s Ability is used only while the card is still in the discard pile.');
    if (task.data.event) assertEventTypeReceipt(s, task.data.event);
    if (task.op === 'draw-cards' && task.data.completion?.event) assertEventTypeReceipt(s, task.data.completion.event);
    if (task.op === 'draw-cards') {
      const d = task.data, count = BigInt(d.remaining) + BigInt(d.drawn);
      if (d.reason === 'turnStart' ?
        d.completion !== null || d.source !== null || count !== 1n || d.player !== s.current :
        !d.completion || d.completion.action.op !== 'draw' ||
          // 「直到手牌变为N张」: the budget read from the hand when the draw began, at most N.
          (Object.hasOwn(d.completion.action, 'untilHand') ? count > BigInt(d.completion.action.untilHand)
            : count !== BigInt(d.completion.action.count)) ||
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
    if (s.pending?.resume === 'ko-discard' && taskIndex === s.queue.length) {
      const open = koZoneOpen(s, catalog, task.data.batch, task.data.zones ?? {});
      if (!open || s.pending.player !== open.owner || canonicalJSON(s.pending.options) !== canonicalJSON(['hand', 'lost']))
        throw new EngineError('invalid-ko-zone', 'A Knock Out destination choice belongs to the owner of a Pokémon both replacements apply to.');
    }
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
    // effects.turn-end: a program the card recorded runs when the turn ends, after the card itself has finished.
    if (trainerSource?.category === 'trainer' && trainerSource.origin === 'hand' &&
        ['item', 'supporter'].includes(cardDef(s, catalog, trainerSource.instanceId).mechanics.category) &&
        trainerFinalizers.get(trainerSource.instanceId)?.player !== trainerSource.owner &&
        !s.playerOngoing.some((e) => e.effect.op === 'turnEndEffect' && canonicalJSON(e.source) === canonicalJSON(trainerSource)))
      throw new EngineError('invalid-trainer-finish', 'Normal hand-played Trainer work cannot lose its own outstanding resolution finalizer.');
    if (task.data.payment) assertPayment(s, catalog, task.data.payment, task.data.source);
    if (task.op === 'draw-cards' && task.data.completion?.payment)
      assertPayment(s, catalog, task.data.completion.payment, task.data.completion.source);
    if (task.op === 'activation-choice') {
      const info = activationInfo(s, catalog, task.data.activation);
      const costs = info.optional.length ? info.optional : info.costs;
      if (!info.valid || !costs.length) throw new EngineError('invalid-activation', 'A pending payment needs its actual unpaid activation.');
      if (task.data.activation.unit) {
        assertTriggerUnitState(s, catalog, task.data.activation.unit);
        if (task.data.activation.unit.event.payment) assertPayment(s, catalog, task.data.activation.unit.event.payment);
      }
      if (s.pending?.resume === 'activation-choice' && taskIndex === s.queue.length &&
          (s.pending.player !== task.data.activation.player || s.pending.minimum !== costCardCount(costs) ||
            s.pending.maximum !== costCardCount(costs) ||
            s.pending.allowZero !== (info.optional.length > 0 && optionalCostChoice(s, catalog, task.data.activation, info).unpaid) ||
            canonicalJSON(s.pending.options) !== canonicalJSON(costOptions(s, catalog, task.data.activation, costs))))
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
      if (d.stage === 'cards-remainder' && (cardsRest(d).length < 2 || canonicalJSON(cardsRest(d)) !== canonicalJSON(d.action.lookBottom
        ? s.players[d.source.owner].deck.slice(0, cardsRest(d).length) : s.players[d.source.owner].deck.slice(-cardsRest(d).length))))
        throw new EngineError('invalid-card-selection', 'The rest of the looked-at cards must still be the top of the deck (its bottom, for a bottom look).');
    }
    if (task.op === 'effect-choice' && task.data.action.op === 'arrangeDeck' && task.data.lookedAt &&
        (canonicalJSON(task.data.lookedAt) !== canonicalJSON(arrangeWindow(s, task.data.action, task.data.deckOwner)) ||
          task.data.stage === 'arrange-rest' && (task.data.chosen.length !== task.data.action.choose ||
            task.data.chosen.some((id) => !task.data.lookedAt.includes(id)))))
      throw new EngineError('invalid-card-selection', 'The looked-at deck cards no longer match that end of the deck.');
    // ko.prize-destination: Prize cards already taken wait in the taker's resolution zone until they are sent on.
    if (task.op === 'award' && task.data.taken?.some((id) => !s.players[task.data.player].resolving.includes(id)))
      throw new EngineError('invalid-prize-choice', 'Taken Prize cards must stay in the resolution zone until they are sent on.');
    if (task.op === 'effect-choice' && PRIZE_ZONE_OPS.includes(task.data.action.op) && task.data.stage) {
      const d = task.data, p = s.players[d.action.side === 'opponent' ? 1 - d.source.owner : d.source.owner];
      if (d.stage === 'prize-replace' ? d.chosen.some((id) => !p.hand.includes(id)) : d.lookedAt.some((id) => !p.prizes.includes(id)) ||
          d.action.op === 'lookPrizeHand' && d.stage !== 'prize-slot' && (d.chosen.length !== 1 || !p.hand.includes(d.chosen[0]) ||
            d.lookedAt.some((id) => !faceUpPrizes(p).includes(id))))
        throw new EngineError('invalid-prize-choice', 'The cards of a pending Prize choice must still be where the choice left them.');
    }
    if (task.op === 'effect-choice' && task.data.action.op === 'opponentHand' && task.data.stage &&
        canonicalJSON(task.data.lookedAt) !== canonicalJSON(s.players[1 - task.data.source.owner].hand))
      throw new EngineError('invalid-card-selection', 'The looked-at opponent\'s hand no longer matches that hand.');
    if (task.op === 'effect-choice' && task.data.action.op === 'copySupporter' && task.data.stage &&
        canonicalJSON(task.data.lookedAt) !== canonicalJSON(s.players[copyHolder(task.data.source.owner, task.data.action)][copyZone(task.data.action)]))
      throw new EngineError('invalid-card-selection', 'The looked-at zone of a Supporter copy no longer matches that zone.');
    if (task.op === 'effect-choice' && task.data.action.op === 'transferCounters' && !task.data.action.each &&
        task.data.stage === 'transfer-target' && task.data.removed > (task.data.action.quantity === 'any' ? 1 : task.data.action.count))
      throw new EngineError('invalid-counter-transfer', 'A saved transfer cannot place more counters than its immutable instruction allowed.');
    if (task.op === 'effect-choice' && task.data.stage === 'transfer-count' && !(findMon(s, task.data.originId)?.m.counters > 1))
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
    if (task.op === 'effect-choice' && (task.data.transition || task.data.evolutionPlan || task.data.devolutionPlan)) assertPokemonTransition(s, catalog, task.data);
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
      // E-20 文例2: a delayed reaction's own printed knockOut (raw program step).
      if (node.op === 'knockOut') params.push(node);
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
const sameAttack = (attack, source) => attack.instanceId === source.instanceId && attack.pokemonId === source.pokemonId &&
  attack.attackId === source.attackId && attack.copyId === (source.copyId ?? null);
// 「对战中，自己的「X」的这个效果，只会生效1次」 (ko.prize-modifier-once): that player's record for X's key.
const onceKey = (spec) => `ko.prize-modifier-once:${spec.oncePerGame}`;
// The Pokémon whose attack's damage Knocked this one Out, still in play when the Knock Out is processed.
function prizeAttacker(s, item) {
  const found = item.cause.kind === 'attackDamage' && findMon(s, item.cause.source.pokemonId);
  if (!found) throw new EngineError('unresolved-prize-attacker', 'The attacking Pokémon left play before its Knock Out was processed.');
  return found.m;
}
// The Prize changes in force for one Knocked Out Pokémon, read on the board as it is at the Knock Out (no coin flipped yet).
function prizeModifiers(s, catalog, model, item) {
  const m = findMon(s, item.id).m, taker = 1 - item.owner;
  const byAttack = item.cause.kind === 'attackDamage' ? item.cause.source : null;
  const attacker = () => prizeAttacker(s, item);
  const kind = (selector, mon) => !selector || pokemonMatches(s, catalog, model, mon, { selector });
  const groups = new Set();
  return continuousEntries(s, catalog, model).filter((entry) => entry.spec.op === 'prizeModifier' &&
    entryTargets(s, catalog, entry, item.owner, m, model) &&
    (!entry.spec.byOpponentAttack || byAttack?.owner === taker && kind(entry.spec.attackerSelector, attacker())) &&
    // 「因身上放有这张卡牌的「X」的招式的伤害」: the damage of this effect's own Pokémon's attack.
    (!entry.spec.byOwnAttack || byAttack?.owner === entry.source.owner && byAttack.pokemonId === entry.source.pokemonId &&
      kind(entry.spec.attackerSelector, attacker())) &&
    // 「只会生效1次」: not once already applied in this game, and one per Knock Out.
    !(entry.spec.oncePerGame && (Object.hasOwn(s.players[entry.source.owner].used, onceKey(entry.spec)) ||
      groups.has(`${entry.source.owner}:${onceKey(entry.spec)}`))) &&
    (!entry.spec.oncePerGame || groups.add(`${entry.source.owner}:${onceKey(entry.spec)}`)) &&
    // 「…不会叠加」: one of each group.
    !(entry.spec.group && groups.has(entry.spec.group)) && (!entry.spec.group || groups.add(entry.spec.group)));
}
// ko.prize-modifier (I.D step 4; D-11/D-12): the Knocked Out Pokémon's Prize count plus every increase and decrease on
// it and every bonus of the player taking them, at least 0; 「无法拿取奖赏卡」 takes none at all.
function prizeAward(s, catalog, item, batch) {
  const model = sourceModel(s, catalog), m = findMon(s, item.id).m, taker = 1 - item.owner;
  const kind = (selector, mon) => !selector || pokemonMatches(s, catalog, model, mon, { selector });
  const all = prizeModifiers(s, catalog, model, item);
  // ko.prize-modifier-once: which of two Pokémon Knocked Out at once a once-only reduction applies to is not settled.
  if (all.some((entry) => entry.spec.oncePerGame && batch.some((other) => other !== item && prizeModifiers(s, catalog, model, other)
    .some((e) => e.spec.oncePerGame === entry.spec.oncePerGame && e.source.owner === entry.source.owner))))
    throw new EngineError('unresolved-prize-once', 'A once-per-game Prize change for two Pokémon Knocked Out at once needs a CN ruling.');
  const modifiers = all.filter((entry) => entry.spec.to === undefined)
    // ko.prize-modifier-coin 「自己抛掷1次硬币。如果为正面，则…」: the effect's player flips once at this Knock Out; tails, it does not apply.
    .filter((entry) => {
      if (!entry.spec.coin) return true;
      requireRule(catalog.ruleset, 'ko.prize-modifier-coin');
      const result = plainFlip(s, entry.source.owner, entry.source.category) ? 'heads' : 'tails';
      log(s, 'effects.coin', { effectId: entry.id, player: entry.source.owner, result, required: 'heads', sourceOfTruth: entry.sourceOfTruth });
      return result === 'heads';
    });
  const qualifies = (effect, mon, owner, cause) => cause.kind === 'attackDamage' && cause.source.owner === 1 - owner &&
    (!effect.attack || sameAttack(effect.attack, cause.source)) && (!effect.activeOnly || s.players[owner].active === mon) &&
    kind(effect.targetSelector, mon) && (!effect.attackerSelector || kind(effect.attackerSelector, prizeAttacker(s, item)));
  const bonuses = s.playerOngoing.filter((entry) => entry.player === taker && entry.effect.op === 'prizeBonus' &&
    ongoingIsActive(entry, s) && qualifies(entry.effect, m, item.owner, item.cause));
  // Whether one attack's bonus counts once or for each Pokémon it Knocks Out at once is not settled.
  if (bonuses.some((entry) => entry.effect.attack && batch.filter((other) => other.owner === item.owner &&
      qualifies(entry.effect, findMon(s, other.id).m, other.owner, other.cause)).length > 1))
    throw new EngineError('unresolved-prize-bonus', 'One attack\'s Prize bonus for several simultaneous Knock Outs needs a CN ruling.');
  // Applied, even when another effect leaves the count at 0 (JP Q&A レガシーエネルギー×メガゲンガーex「かげかくし」).
  for (const entry of modifiers.filter((e) => e.spec.oncePerGame)) {
    requireRule(catalog.ruleset, 'ko.prize-modifier-once');
    s.players[entry.source.owner].used[onceKey(entry.spec)] = [s.turn];
    log(s, 'ko.prize-modifier-once', { player: entry.source.owner, key: entry.spec.oncePerGame, effectId: entry.id, sourceOfTruth: entry.sourceOfTruth });
  }
  if (!modifiers.length && !bonuses.length) return item.prizes;
  requireRule(catalog.ruleset, 'ko.prize-modifier');
  if (modifiers.some((entry) => entry.spec.none)) return 0;
  return Math.max(0, item.prizes + modifiers.reduce((n, entry) => n + entry.spec.amount, 0) +
    bonuses.reduce((n, entry) => n + entry.effect.count, 0));
}
// ko.prize-destination 「只要这只宝可梦在场上，对手拿取的奖赏卡，不会被加入手牌，而会被放入放逐区」: read when the Prize cards are taken.
const prizesToLost = (s, catalog, taker) => continuousEntries(s, catalog).some((e) => e.spec.op === 'prizeDestination' && e.source.owner !== taker);
// The taker takes them one at a time (each seen), then — where a card may go either way — chooses, having seen them all, which go to
// the discard pile (JP Q&A ガメノデス×もくもくスモーク); the rest go to the Lost Zone, or to the hand as usual. Still taking them.
function awardElsewhere(s, catalog, d) {
  const p = s.players[d.player], lost = d.lost ?? prizesToLost(s, catalog, d.player);
  if (d.stage === 'prize-destination') { routePrizes(s, catalog, d, d.selected); return; }
  const taken = [...(d.taken ?? [])], faceUp = [...(d.faceUp ?? [])];
  if (d.selected) {
    const id = p.prizes[Number(d.selected[0])];
    if (faceUpPrizes(p).includes(id)) faceUp.push(id);
    leavePrizes(p, [id]); p.resolving.push(id); taken.push(id);
    battleFact(s, { kind: 'prizeTaken', owner: d.player, cardId: id });
    log(s, 'ko.boundary', { player: d.player, taken: 1, remaining: p.prizes.length });
    log(s, 'ko.prize-destination', { player: d.player, cards: [clone(s.cards[id])] }, d.player);
  }
  const next = { player: d.player, count: d.count, ...(d.discard ? { discard: d.discard } : {}), lost, taken, faceUp };
  if (taken.length < d.count && p.prizes.length) {
    ask(s, { player: d.player, kind: 'prize', options: p.prizes.map((_, i) => String(i)), resume: 'award', data: next, ruleId: 'ko.boundary' });
    return;
  }
  // 「因该宝可梦【昏厥】而导致对手拿取的奖赏卡…放于弃牌区」 covers at most `discard` of them; the Lost Zone may take any.
  const minimum = lost ? 0 : Math.max(0, taken.length - (d.count - (d.discard ?? 0))), maximum = Math.min(d.discard ?? 0, taken.length);
  if (minimum === maximum && (minimum === 0 || minimum === taken.length)) routePrizes(s, catalog, next, taken.slice(0, minimum));
  else ask(s, { player: d.player, kind: 'prize-destination', options: taken, minimum, maximum, resume: 'award',
    data: { ...next, stage: 'prize-destination' }, ruleId: 'ko.prize-destination' });
}
function routePrizes(s, catalog, d, discarded) {
  const p = s.players[d.player], rest = d.taken.filter((id) => !discarded.includes(id));
  for (const id of d.taken) remove(p.resolving, id);
  for (const id of discarded) discard(s, catalog, id);
  if (d.lost) for (const id of rest) toLost(s, id);
  log(s, 'ko.prize-destination', { player: d.player, discarded: discarded.map((id) => clone(s.cards[id])),
    lost: d.lost ? rest.map((id) => clone(s.cards[id])) : [] });
  // 「当从反面朝上的自己的奖赏卡中拿取…时」 only for those that do go to the hand, taken face down.
  if (!d.lost) prepend(s, ...rest.flatMap((id) => {
    const work = entryWork(s, catalog, d.player, id, 'prizes', null, null);
    if (d.faceUp.includes(id)) work[0].data.remaining = [];
    return work;
  }));
}
const extraTurnPending = (s, player) => s.playerOngoing.some((e) => e.player === player && e.effect.op === 'extraTurn' && ongoingIsActive(e, s) &&
  (!e.effect.attack || s.battleHistory.events.some((k) => k.kind === 'ko' && k.turn === s.turn && k.owner !== player &&
    k.cause.source && sameAttack(e.effect.attack, k.cause.source))));
// I.D: the player whose turn comes next — the queued next turn, or the current player keeping an extra turn (turn.extra).
function nextTurnPlayer(s) {
  const queued = s.queue.find((t) => t.op === 'start-turn');
  return queued ? queued.data.player : s.current !== null && extraTurnPending(s, s.current) ? s.current : s.nextPlayer;
}
function afterKO(s) {
  const losers = s.players.map((p, i) => (!p.active && !p.bench.length) || !s.players[1 - i].prizes.length);
  if (losers[0] && losers[1]) finish(s, null, 'simultaneous');
  else if (losers.some(Boolean)) finish(s, losers[0] ? 1 : 0, 'ordinary');
  else {
    const next = nextTurnPlayer(s), order = [next, 1 - next];
    const vacant = order.filter((p) => !s.players[p].active);
    // A scheduled non-KO vacancy was already filled before Knock Out processing.
    if (vacant.some((p) => s.vacancies[p]))
      throw new EngineError('unresolved-field-promotion', 'Non-KO Active replacement needs a reviewed schedule.');
    prepend(s, ...vacant.map((player) => tasks('promote', { player })));
  }
}

// The damage step (I.A-01.4—6); resume: the answer to a coin choice that paused its damage coins.
function afterAttack(s, catalog, d, resume = null) {
  if (canonicalJSON(d) !== canonicalJSON(attackFlow(s))) throw new EngineError('invalid-attack-flow', 'Damage phase lost its exact execution scope.');
  const m = findMon(s, d.pokemonId)?.m, attack = executingAttack(s, catalog);
  if (!m) throw new EngineError('unsupported-attack-transition', 'Declared attacker left play before damage.');
  let target = s.players[1 - d.player].active;
  if (!target) throw new EngineError('unsupported-attack-transition', 'An empty opposing Active position needs reviewed replacement timing before further damage.');
  if (!prepareDamageCoins(s, catalog, resume)) return;
  // damage.redirect: the Benched Pokémon its user chose just before (nothing else of the attack comes in between, the load guard).
  const redirect = attack.effects.find((b) => catalog.handler(b.handlerId).capabilities?.includes('damage-redirect'));
  const chosen = redirect && s.attack.execution.effectCards.find((e) => e.effectId === redirect.effectId).cards[0];
  if (chosen) target = s.players[1 - d.player].bench.find((m) => top(m) === chosen);
  // attack.printed-target: the printed damage goes with its own packet to the chosen Pokémon; nothing to the Active here.
  const printedPacket = attack.effects.some((b) => b.handlerId === 'cn.damage@1' && b.parameters.printed);
  if (printedPacket) requireRule(catalog.ruleset, 'attack.printed-target');
  let amount = printedPacket ? null : attack.printedDamage?.value ?? null;
  const formulas = attack.effects.filter((b) => catalog.handler(b.handlerId).capabilities?.includes('resolve-attack-damage'));
  if (formulas.length || attack.printedDamage && attack.printedDamage.operator !== 'fixed' && !printedPacket) {
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
  // damage.base-set 「在下一个自己的回合，这只宝可梦的「X」的伤害变为「100」」: that attack's damage before any other step.
  const set = effectiveProperty(s, catalog, d.player, m, 'attackBaseDamage');
  if (set?.attackIds.includes(attack.attackId) && amount !== null) {
    requireRule(catalog.ruleset, 'damage.base-set');
    log(s, 'damage.base-set', { pokemonId: m.id, attackId: attack.attackId, from: amount, to: set.damage });
    amount = set.damage;
  }
  const currentSource = executingSource(s, catalog);
  s.attack.damageModels = allMons(s).map(({ owner, m }) => damageModel(s, catalog, currentSource, owner, m));
  log(s, 'damage.expression', { kind: 'stage-snapshot', frameId: s.attack.id,
    copyId: s.attack.execution.copyId, models: s.attack.damageModels }, 'private');
  dealAttackDamage(s, catalog, currentSource, [{ owner: 1 - d.player, m: target }], amount, s.attack.options);
  prepend(s, ...effectTasks(s, catalog, d.sourceId, d.player, 'attack', attack.effects, 'damage', m.id,
    s.attack.attack.attackId, null, s.attack.execution),
    tasks('resolve-attack', d));
}
function runTask(s, catalog, { op, data: d }) {
  const p = s.players[d.player];
  switch (op) {
    case 'draw-cards': {
      const action = d.completion?.action;
      // 「抽取最多N张」: one card at a time; once one is drawn, its drawer may stop before each next card (II.D-05; JP Q&A).
      if (action?.upTo && d.drawn > 0 && d.remaining > 0 && p.deck.length && !d.selected) {
        ask(s, { player: d.player, kind: 'draw-more', options: ['continue', 'stop'], resume: 'draw-cards', data: d, ruleId: 'effects.draw-up-to' });
        break;
      }
      if (d.remaining > 0 && p.deck.length && d.selected?.[0] !== 'stop') {
        // 「从自己的牌库下方抽取」: the deck's first entry is its bottom card.
        const cardId = d.bottom ? p.deck.shift() : p.deck.pop();
        // 「互相展示过正面后加入手牌」: both players see the drawn card before it joins the hand.
        if (action?.reveal) log(s, 'effects.reveal', { player: d.player, from: 'deck', cardIds: [cardId], cards: [clone(s.cards[cardId])],
          effectId: d.source.effectId });
        prepend(s, ...entryWork(s, catalog, d.player, cardId, 'draw', d.reason, d.source),
          tasks('draw-cards', { ...withoutSelection(d), remaining: d.remaining - 1, drawn: d.drawn + 1 }));
      } else {
        log(s, 'effects.draw', { player: d.player, count: d.drawn });
        if (d.completion) finishEffect(s, catalog, d.completion, d.drawn > 0);
      }
      break;
    }
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
      if (!d.dealt) for (const player of [0, 1]) draw(s, player, 7);
      // setup.placement: each such player decides in turn, the first player first (I.G.5).
      const starts = { ...(d.starts ?? {}), ...(d.selected ? { [d.player]: d.selected[0] } : {}) };
      const undecided = [s.first, 1 - s.first].find((player) => !Object.hasOwn(starts, player) && optionalStart(s, catalog, player));
      if (undecided !== undefined) {
        // I.G.5: the first player has already told whether it starts (a Basic Pokémon, or such a card put there).
        if (undecided !== s.first) log(s, 'setup.placement', { player: s.first,
          start: starts[s.first] === 'place' || s.players[s.first].hand.some((id) => setupBasic(s, catalog, id)) });
        askStart(s, undecided, 'deal', { dealt: true, starts, player: undecided }); break;
      }
      const failed = s.players.map((p, player) => starts[player] !== 'place' && !p.hand.some((id) => {
        return setupBasic(s, catalog, id);
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
      const options = p.hand.filter((id) => setupCard(s, catalog, id, 'active'));
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
        const options = p.hand.filter((id) => setupCard(s, catalog, id, 'bench'));
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
      if (!d.dealt) {
        log(s, 'setup.mulligan', { player: d.player, revealed: p.hand.map((id) => clone(s.cards[id])), shared: false });
        s.setup.mulligans[d.player]++; s.setup.bonus[d.ready]++;
        p.deck.push(...p.hand.splice(0)); shuffleIds(s.rng, p.deck); draw(s, d.player, 7);
      }
      const retry = { player: d.player, ready: d.ready };
      if (d.selected?.[0] === 'place' || p.hand.some((id) => setupBasic(s, catalog, id))) break;
      if (!d.selected && optionalStart(s, catalog, d.player)) askStart(s, d.player, 'retry', { ...retry, dealt: true });
      else prepend(s, tasks('retry', retry));
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
      // effects.turn-end: the ending player's 「使用了这张卡牌的回合结束时」 effects, in the order the cards were used.
      const recorded = s.playerOngoing.filter((e) => e.player === d.player && e.effect.op === 'turnEndEffect' && ongoingIsActive(e, s))
        .map((e) => tasks('turn-end-effect', { entryId: e.id }));
      prepend(s, ...recorded, ...triggerWork(s, catalog, events), tasks('ko'), tasks('expire-turn', d),
        tasks('ko'), tasks('checkup', d), tasks('ko'), tasks('start-turn', { player: extraTurnPending(s, d.player) ? d.player : 1 - d.player }));
      break;
    }
    case 'turn-end-effect': {
      const entry = s.playerOngoing.find((e) => e.id === d.entryId), program = entry.effect.program;
      log(s, 'effects.turn-end', { player: entry.player, effectId: entry.id, sourceOfTruth: entry.source.sourceOfTruth });
      const data = scheduleTrackedEffect(s, catalog, { source: entry.source, event: null, local: false }, 'turnEnd');
      openTrackedEffect(s, catalog, data, program);
      prepend(s, tasks('effect-choice', { ...beginEffectProgram(program), ...data }));
      break;
    }
    case 'expire-turn': {
      expireAt(s, d.player, 'turn-end');
      // tools.granted-attack: 「放于宝可梦身上的这张卡牌，将在自己的回合结束时被放于弃牌区」; tools.turn-end-discard: 「…将在对手的回合结束时…」
      // on the other player's Pokémon (neither while its effects are removed).
      const model = sourceModel(s, catalog);
      for (const [owner, flag, ruleId] of [[d.player, 'turnEndDiscard', 'tools.granted-attack'], [1 - d.player, 'opponentTurnEndDiscard', 'tools.turn-end-discard']])
        for (const m of mons(s.players[owner])) for (const id of [...m.tools])
          if (cardDef(s, catalog, id).mechanics[flag] && model.availability.get(sourceNodeId('tool', id)).enabled) {
            discardFromPlay(s, catalog, id); remove(m.tools, id);
            log(s, ruleId, { player: owner, pokemonId: m.id, cardId: id });
          }
      break;
    }
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
      // trigger.sleep-not-recovered: an effect on this checkup's Sleep result can only follow the Special Condition step.
      while (d.units[0]?.trigger.sleepNotRecovered) d.after.push(d.units.shift());
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
        const asleep = step === 'sleep' && player.active.conditions.rotation === 'asleep';
        const result = checkConditions(player.active.conditions, {
          ownerTurn: player.turns, ownerIsEndingPlayer: owner !== s.nextPlayer, flip: coinFlipper(s, owner),
          step, burnCounterChanges, rules: conditionRules(s, catalog, owner, player.active),
        });
        player.active.conditions = result.conditions;
        // trigger.sleep-not-recovered: 「没有从【睡眠】状态恢复」 in this checkup's Sleep check.
        if (asleep && result.conditions.rotation === 'asleep') player.active.facts.stayedAsleepTurn = s.turn;
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
      enforceConditionImmunity(s, catalog);
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
      // tools.capacity: a raised Tool capacity that stops applying is settled here too.
      if ([0, 1].some((player) => mons(s.players[player]).some((m) => m.tools.length > toolCapacity(s, catalog, m)))) {
        prepend(s, tasks('tool-trim', { order: [s.current, 1 - s.current] }), tasks('ko', d));
        break;
      }
      if (!d.batch) {
        // effects.field-return-promotion: an Active that left by an effect is replaced at the end of the related
        // processing, before Knock Out processing; when one effect vacated both, its user's side goes first.
        const vacated = [0, 1].filter((player) => s.vacancies[player] && s.vacancies[player].promotion.timing !== 'needsRuling' &&
          !s.players[player].active && s.players[player].bench.length);
        if (vacated.length) {
          const user = s.vacancies[vacated[0]].source.owner;
          // Fail closed, though no supported effect lets both players vacate between two Knock Out checks.
          if (vacated.some((p) => s.vacancies[p].source.owner !== user)) throw new EngineError('unresolved-field-promotion-order', 'Departures by both players.');
          requireRule(catalog.ruleset, 'effects.field-return-promotion');
          prepend(s, ...vacated.sort((a, b) => (a !== user) - (b !== user)).map((player) =>
            tasks('promote', { player, reason: 'fieldReturn', ...clone(s.vacancies[player]) })), tasks('ko', d));
          break;
        }
      }
      const batch = d.batch ?? [], awards = d.awards ?? [0, 0], diverted = d.diverted ? { diverted: d.diverted } : {};
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
        prepend(s, ...triggerWork(s, catalog, events), tasks('ko', { batch: [...batch, ...additional], awards, ...diverted, deferOutcome: d.deferOutcome ?? false }));
      } else if (batch.length) prepend(s, tasks('ko-discard', { batch, awards, ...diverted, deferOutcome: d.deferOutcome ?? false }));
      else if (awards.some((n) => n > 0)) prepend(s,
        ...[nextTurnPlayer(s), 1 - nextTurnPlayer(s)].map((player) => tasks('award', { player, count: awards[player],
          ...(d.diverted?.[player] ? { discard: d.diverted[player] } : {}) })),
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
          for (const card of [...m.stack, ...m.energy, ...m.tools]) discardFromPlay(s, catalog, card);
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
    case 'tool-trim': {
      requireRule(catalog.ruleset, 'tools.capacity');
      if (d.selected) {
        const { owner, m } = findMon(s, d.pokemonId), excess = m.tools.length - toolCapacity(s, catalog, m);
        if (d.selected.length !== excess || d.selected.some((id) => !m.tools.includes(id))) throw new EngineError('invalid-tool-trim', 'Over capacity.');
        for (const id of d.selected) { discardFromPlay(s, catalog, id); remove(m.tools, id); }
        log(s, 'tools.capacity', { player: owner, pokemonId: m.id, discarded: [...d.selected] });
        prepend(s, tasks('tool-trim', { order: d.order }));
        break;
      }
      const player = d.order.find((p) => mons(s.players[p]).some((m) => m.tools.length > toolCapacity(s, catalog, m)));
      if (player === undefined) break;
      const m = mons(s.players[player]).find((m) => m.tools.length > toolCapacity(s, catalog, m)), excess = m.tools.length - toolCapacity(s, catalog, m);
      ask(s, { player, kind: 'tool-trim', options: [...m.tools], minimum: excess, maximum: excess,
        resume: 'tool-trim', data: { order: d.order, pokemonId: m.id }, ruleId: 'tools.capacity' });
      break;
    }
    case 'ko-discard': {
      const awards = [...d.awards], diverted = [...(d.diverted ?? [0, 0])];
      // ko.hand: an open hand-or-Lost-Zone choice is made first, one Knocked Out Pokémon at a time, before anything is read or moved.
      const chosen = { ...d.zones };
      if (d.selected) chosen[koZoneOpen(s, catalog, d.batch, chosen).id] = d.selected[0];
      const open = koZoneOpen(s, catalog, d.batch, chosen);
      if (open) {
        ask(s, { player: open.owner, kind: 'ko-zone', options: ['hand', 'lost'], resume: 'ko-discard',
          data: { ...withoutSelection(d), zones: chosen }, ruleId: 'ko.hand' });
        break;
      }
      // Every Prize change is read on the board as it is at the Knock Out, before any of the batch leaves play.
      const prizes = d.batch.map((item) => prizeAward(s, catalog, item, d.batch)), zones = d.batch.map((item) => knockoutZone(s, catalog, item, chosen[item.id], true));
      // ko.prize-destination 「因该宝可梦【昏厥】而导致对手拿取的奖赏卡…放于弃牌区」: read with the other Prize changes.
      const model = sourceModel(s, catalog), discarded = d.batch.map((item) => prizeModifiers(s, catalog, model, item).some((e) => e.spec.to === 'discard'));
      for (const [index, item] of d.batch.entries()) {
        const player = s.players[item.owner], m = mons(player).find((m) => m.id === item.id), zone = zones[index];
        if (!m) throw new EngineError('invalid-ko', 'Knock Out batch no longer matches the board.');
        // ko.hand: the Pokémon's own cards (a Pokémon card attached as a Tool is not one of them); the rest as usual.
        for (const id of [...m.stack, ...m.energy, ...m.tools])
          if (zone?.to === 'hand' && m.stack.includes(id)) player.hand.push(id);
          else if (zone && (zone.rest === 'lost' || !zone.to && (zone.cards === 'all' || cardDef(s, catalog, id).kind === 'pokemon'))) toLost(s, id);
          else discardFromPlay(s, catalog, id);
        if (zone) log(s, zone.to === 'hand' ? 'ko.hand' : 'ko.lost-zone', { owner: item.owner, pokemonId: item.id, cards: zone.cards, effects: zone.effects,
          ...(zone.rest ? { rest: zone.rest, restEffects: zone.restEffects } : {}) });
        if (player.active === m) player.active = null;
        else player.bench.splice(player.bench.indexOf(m), 1);
        retireTarget(s, m.id, 'knockout');
        awards[1 - item.owner] += prizes[index];
        if (discarded[index]) diverted[1 - item.owner] += prizes[index];
        battleFact(s, { kind: 'ko', owner: item.owner, pokemonId: m.id, cause: item.cause });
        log(s, 'ko.boundary', { owner: item.owner, pokemonId: item.id, prizes: prizes[index] });
      }
      // Losing a continuous source may itself cause another Knock Out.
      // Finish that chain, including its triggers, before awarding/checking wins.
      prepend(s, tasks('ko', { awards, ...(diverted.some(Boolean) ? { diverted } : {}), deferOutcome: d.deferOutcome ?? false }));
      break;
    }
    case 'award':
      // ko.prize-destination: Prize cards some effect sends elsewhere than the hand.
      if (d.lost !== undefined || !d.selected && d.count > 0 && p.prizes.length && (d.discard || prizesToLost(s, catalog, d.player))) awardElsewhere(s, catalog, d);
      else if (d.selected) {
        const slot = Number(d.selected[0]), id = p.prizes[slot], faceUp = faceUpPrizes(p).includes(id);
        if (!id) throw new EngineError('invalid-prize', 'Invalid Prize position.');
        leavePrizes(p, [id]);
        battleFact(s, { kind: 'prizeTaken', owner: d.player, cardId: id });
        log(s, 'ko.boundary', { player: d.player, taken: 1, remaining: p.prizes.length });
        // 「当从反面朝上的自己的奖赏卡中拿取了这张卡牌时」: a face-up Prize taken is not one (prizes.face-up).
        const work = entryWork(s, catalog, d.player, id, 'prizes', null, null);
        if (faceUp) work[0].data.remaining = [];
        prepend(s, ...work,
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
      // retreat.rules 「其【撤退】所需能量不会被放于弃牌区，而是会被放回手牌」: read while the Pokémon still has its Tool.
      // 「放于弃牌区的能量是基本能量的话，则…放回自己的手牌」: only the Energy of that kind.
      const toHand = retreatRules(s, catalog, d.player, p.active).filter((r) => r.spec.energyToHand);
      const eligible = d.selected.filter((id) => toHand.some((r) => !r.spec.energySelector || matchesCardSelector(cardDef(s, catalog, id), r.spec.energySelector)));
      // effects.move-lock: an Energy that cannot be put into the hand is discarded as usual (JP Q&A バリヤード × スケーターズパーク).
      const locked = eligible.length ? keptCards(s, catalog, toHand[0].source, eligible, { zone: 'field', to: 'hand', holder: d.player, pokemon: p.active }) : [];
      const returned = eligible.filter((id) => !locked.includes(id));
      for (const id of d.selected) { if (returned.includes(id)) p.hand.push(id); else discardFromPlay(s, catalog, id); remove(p.active.energy, id); }
      if (returned.length) log(s, 'retreat.rules', { player: d.player, toHand: returned, effects: toHand.map((e) => e.id) });
      prepend(s, tasks('finish-retreat', { player: d.player }));
      break;
    }
    case 'finish-retreat':
      if (d.selected) {
        const outgoing = p.active, left = clone(outgoing.conditions);
        battleFact(s, { kind: 'retreat', owner: d.player, pokemonId: outgoing.id });
        const incoming = switchTo(s, d.player, d.selected[0]); p.flags.retreat = true; s.phase = 'main';
        prepend(s, ...becameActiveWork(s, catalog, d.player, incoming, { kind: 'rule', source: null }, outgoing, left));
      } else ask(s, { player: d.player, kind: 'retreat-target', options: p.bench.map((m) => m.id), resume: 'finish-retreat', data: d, ruleId: 'retreat.limit' });
      break;
    case 'finish-trainer': {
      assertTrainerFinish(s, catalog, d);
      // Stadiums enter play immediately; Tools use attach-tool. Only an
      // Item/Supporter reaches this post-resolution discard continuation.
      if (p.resolving.includes(d.cardId)) { remove(p.resolving, d.cardId); discard(s, catalog, d.cardId); }
      // trainer.joint-play: the cards played together go to the discard pile together.
      for (const id of d.jointCardIds ?? []) { remove(p.resolving, id); discard(s, catalog, id); }
      log(s, 'turn.trainer', { kind: 'trainer-finished', id: d.completionId,
        player: d.player, cardId: d.cardId, turn: s.turn });
      prepend(s, ...(d.discarded ? [tasks('discard-window', { player: d.player, units: d.discarded })] : []), tasks('ko')); s.phase = 'main';
      break;
    }
    case 'discard-window': {
      // trigger.discarded: the discarded cards' Abilities still in the discard pile, in their owner's order.
      const units = d.units.filter((u) => p.discard.includes(u.cardId));
      if (!units.length) break;
      if (units.length > 1 && !d.selected) {
        ask(s, { player: d.player, kind: 'trigger-order', options: units.map((u) => u.id), resume: 'discard-window',
          data: { ...d, units }, ruleId: 'trigger.discarded' });
        break;
      }
      const unit = units.find((u) => u.id === d.selected?.[0]) ?? units[0];
      prepend(s, tasks('discard-use', { player: d.player, unit }), tasks('discard-window', { player: d.player, units: units.filter((u) => u !== unit) }));
      break;
    }
    case 'discard-use': {
      const ability = discardedAbility(s, catalog, d.player, d.unit);
      if (ability.trigger.optional && !d.selected) {
        ask(s, { player: d.player, kind: 'trigger-optional', options: ['perform', 'skip'], resume: 'discard-use', data: d, ruleId: 'trigger.discarded' });
        break;
      }
      const used = d.selected?.[0] !== 'skip';
      log(s, 'trigger.discarded', { kind: 'used', id: d.unit.id, cardId: d.unit.cardId, abilityId: d.unit.abilityId, performed: used });
      if (used) prepend(s, ...effectTasks(s, catalog, d.unit.cardId, d.player, 'ability', ability.effects, 'resolve', null, null, null, null, 'discard'));
      break;
    }
    case 'attach-tool':
      if (d.selected) {
        const m = mons(p).find((m) => m.id === d.selected[0] && toolTarget(s, catalog, m, cardDef(s, catalog, d.cardId)));
        if (!m) fail(s, 'turn.tool', 'This Pokémon cannot receive a Tool.');
        remove(p.resolving, d.cardId); m.tools.push(d.cardId); m.facts.toolFromHandTurn = s.turn;
        log(s, 'turn.tool', { player: d.player, pokemonId: m.id, cardId: d.cardId });
        // trigger.tool 「每当从自己的手牌中将…「宝可梦道具」，放于这只宝可梦身上时」.
        s.phase = 'main'; prepend(s, ...triggerWork(s, catalog, [makeTriggerEvent(s, catalog, 'toolAttached', d.player, m,
          { origin: 'hand', cardId: d.cardId })]), tasks('ko'));
      } else ask(s, { player: d.player, kind: 'tool-target', options: mons(p).filter((m) => toolTarget(s, catalog, m, cardDef(s, catalog, d.cardId))).map((m) => m.id),
        resume: 'attach-tool', data: d, ruleId: 'turn.tool' });
      break;
    case 'attack': {
      const m = findMon(s, d.pokemonId)?.m, attack = d.attack;
      if (!m) throw new EngineError('unsupported-attack-transition', 'Declared attacker left play before resolution.');
      const imposed = imposedAttackCheck(s, catalog, m, d);
      if (imposed === null) break;
      if (!imposed) {
        prepend(s, tasks('ko'), tasks('end-turn', { player: d.player })); break;
      }
      // Confusion is no card effect: only a forced face (effects.coin-face) changes its coin.
      const confusion = resolveConfusion(m.conditions, m.conditions.rotation === 'confused' ? coinFlipper(s, d.player)() : undefined);
      for (const trace of confusion.trace) log(s, trace.ruleId, { pokemonId: m.id, ...trace });
      if (!confusion.succeeded) {
        addCounters(s, catalog, d.player, m, confusion.selfCounters, { kind: 'rule', source: null });
        prepend(s, tasks('ko'), tasks('end-turn', { player: d.player })); break;
      }
      spendSpecialRule(s, catalog, d.player, attack.specialRule);
      m.facts.lastUsedAttack = { turn: s.turn, attackId: attack.attackId };
      battleFact(s, { kind: 'attackUsed', owner: d.player, pokemonId: m.id, cardId: top(m), attackName: attack.name,
        ...(attack.specialRule ? { specialRule: attack.specialRule } : {}),
        reference: d.grant ? clone(d.grant.reference) : { instanceId: d.sourceId, attackId: attack.attackId } });
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
    case 'after-attack': afterAttack(s, catalog, d); break;
    // effects.coin-choice / effects.coin-reflip: the answer resumes the attack's own paused flips.
    case 'attack-coins':
      if (d.stage === 'failure') { if (ownAttackCheck(s, catalog, executingAttack(s, catalog), d)) beginAttackBody(s, catalog); }
      else afterAttack(s, catalog, d.flow, d);
      break;
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
      // energy.reattach-after-attack: after the attack's damage and effects, each such card still in the discard pile is attached back
      // to its Pokémon, if that Pokémon is still in play (attached from the discard pile by the card's own effect).
      for (const { cardId, pokemonId } of s.attack.reattach ?? []) {
        const found = findMon(s, pokemonId), p = s.players[s.cards[cardId].owner];
        if (!found || !p.discard.includes(cardId)) continue;
        remove(p.discard, cardId); found.m.energy.push(cardId);
        const binding = cardDef(s, catalog, cardId).mechanics.effects.find((b) => b.handlerId === 'cn.reattachAfterAttack@1');
        log(s, 'energy.reattach-after-attack', { player: found.owner, cardId, pokemonId, effectId: binding.effectId });
        s.attack.events.push(makeTriggerEvent(s, catalog, 'energyAttached', found.owner, found.m, { origin: 'discard', cardId,
          cause: { kind: 'effect', source: sourceFor(s, catalog, cardId, found.owner, 'energy', binding, pokemonId, null, 'discard') } }));
      }
      const events = s.attack.events, attacker = findMon(s, s.attack.pokemonId);
      // attack.twice: one of its own printed attacks (not copied or granted content) may be followed by a second.
      const twice = !!attacker && s.attack.sourceId === top(attacker.m) && attacksTwice(s, catalog, attacker.owner, attacker.m);
      s.attack = null;
      // effects.end-turn-reaction: an end already queued during the attack ends the turn instead (no second attack).
      const ending = s.queue.some((t) => t.op === 'end-turn');
      prepend(s, ...triggerWork(s, catalog, events), tasks('ko'), ...(ending ? [] :
        [tasks(twice ? 'second-attack' : 'end-turn', twice ? { player: d.player, pokemonId: attacker.m.id } : { player: d.player })]));
      break;
    }
    case 'second-attack': {
      // After the first attack, its Knock Outs and the opponent's new Active Pokémon: the same Active Pokémon, its ability
      // still in effect, may declare one of its own printed attacks it can use now; never a third.
      const m = p.active, used = s.battleHistory.events.filter((e) => e.kind === 'attackUsed' && e.turn === s.turn && e.owner === d.player).length;
      const own = !s.result && m?.id === d.pokemonId && used === 1 && attacksTwice(s, catalog, d.player, m) ?
        attacksFor(s, catalog, m).filter((r) => !r.grant && r.instanceId === top(m) && attackLegal(s, catalog, d.player, r.attack, r.instanceId)) : [];
      if (!own.length || d.selected?.[0] === 'skip') { prepend(s, tasks('end-turn', { player: d.player })); break; }
      if (!d.selected) {
        ask(s, { player: d.player, kind: 'second-attack', options: [...own.map((r) => r.attack.attackId), 'skip'],
          resume: 'second-attack', data: d, ruleId: 'attack.twice' });
        break;
      }
      const record = own.find((r) => r.attack.attackId === d.selected[0]);
      log(s, 'attack.twice', { player: d.player, pokemonId: m.id, attackId: record.attack.attackId });
      prepend(s, tasks('attack', { player: d.player, attackId: record.attack.attackId, pokemonId: m.id, sourceId: record.instanceId,
        attack: clone(record.attack), grant: null }));
      break;
    }
    case 'trigger-window': {
      const model = sourceModel(s, catalog);
      d.units = collapseGroups(d.units.filter((unit) => triggerStillAvailable(s, catalog, unit, model)));
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
        definition: catalog.definition(event.definitionId), ...subjectFacts(s, catalog, event) }) ||
        !triggerConditionMet(s, catalog, u.trigger, source)) break;
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

// 「其中的…」: a card move or attachment bound by a thenMoved takes only the cards its first part moved.
function amongCards(a) {
  if (a.among === 'moved') throw new EngineError('invalid-effect-execution', 'A moved-card pool must be bound to the cards actually moved.');
  return a.among ?? null;
}
// effects.reveal 「…各将自己的手牌翻到正面，互相展示」: each nonempty hand is shown to both players, the user's first; nothing moves.
function showHands(s, owner, source) {
  const shown = [owner, 1 - owner].filter((i) => s.players[i].hand.length);
  for (const i of shown) log(s, 'effects.reveal', { player: i, from: 'hand', cardIds: [...s.players[i].hand],
    cards: s.players[i].hand.map((id) => clone(s.cards[id])), effectId: source.effectId });
  return shown;
}
// moved: the cards a card-moving instruction actually moved; a thenMoved's next part is bound to them.
// The in-play Pokémon now holding these cards (as a Pokémon card or an attachment), in order, once each.
function holdersOf(s, ids) {
  const mons = allMons(s).map(({ m }) => m);
  return [...new Set(ids.map((id) => mons.find((m) => [...m.stack, ...m.energy, ...m.tools].includes(id))?.id).filter(Boolean))];
}
// 「该宝可梦」: the Pokémon a bound next part may act on, or null.
const boundPokemon = (d) => d.frames?.at(-1)?.kind === 'bound' ? d.frames.at(-1).pokemon : null;
const boundTo = (d, m) => !boundPokemon(d) || boundPokemon(d).includes(m.id);
function finishEffect(s, catalog, d, performed, moved = null, affected = null) {
  if (performed && s.attack && d.source.category === 'attack' && d.source.instanceId === s.attack.sourceId &&
      d.source.pokemonId === s.attack.pokemonId && (d.source.copyId ?? null) === s.attack.execution.copyId)
    s.attack.execution.performed = true;
  log(s, 'effects.partial', { effectId: d.source.effectId, operation: d.action.op, performed,
    sourceOfTruth: d.source.sourceOfTruth,
    ...(d.source.contentSource ? { ...(d.source.copyId ? { copyId: d.source.copyId } : { grantId: d.source.grantId }),
      contentSource: clone(d.source.contentSource) } : {}) });
  // use pokemon: the Pokémon the first part affected — given, or those now holding the cards it moved.
  const step = { action: d.action, frames: d.frames }, use = completionMovedUse(step);
  const bound = use === null ? null : use === 'pokemon' ? affected ?? holdersOf(s, moved ?? []) : moved ?? [];
  if (bound !== null && performed && moved === null && affected === null)
    throw new EngineError('invalid-effect-execution', 'The first part of a thenMoved must report the cards it actually moved.');
  advanceTrackedEffect(s, catalog, d, 'complete', performed, bound !== null ? { moved: [...bound] } : {});
  const next = completeEffectStep(step, performed, bound);
  // A counted effect that ends without moving anything (declined, or nothing there) records zero; a counted
  // attachment (「若希望，可以在造成伤害前，选择自己手牌中任意数量的…附着于这只宝可梦身上」) records the cards it attached.
  if (!next && countedEffect(catalog, executionBinding(s, catalog, d.source)) &&
      !s.attack.execution.effectCards.some((e) => e.effectId === d.source.effectId)) recordEffectCards(s, catalog, d, moved ?? []);
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
function opponentHandWindow(s, catalog, a, foe, source = null) {
  const p = s.players[foe];
  if (!a.quantity) return { pool: [], bounds: null };
  const locks = enterLocks(s, catalog, foe, sourceModel(s, catalog));
  const pool = p.hand.filter((id) => matchesCardsMove(cardDef(s, catalog, id), a) && (a.to !== 'bench' || enterAllowed(s, catalog, id, source, locks)));
  const room = a.to === 'bench' ? Math.max(0, benchLimit(s, catalog, foe) - p.bench.length) : pool.length;
  const quantity = a.quantity.kind === 'leave' ? { kind: 'exact', count: Math.max(0, p.hand.length - a.quantity.count) } : a.quantity;
  // 「若希望，将其中的1张…」: having looked, the user may also choose none.
  return { pool, bounds: selectionBounds({ ...quantity, available: Math.min(pool.length, room),
    zone: a.mode === 'opponentChooses' ? 'ownHand' : 'public', filter: selectorQuantityClass(a.selector), optional: a.optional === true }) };
}
function moveFromOpponentHand(s, catalog, d, foe, ids) {
  const { action: a, source } = d, p = s.players[foe], events = [];
  for (const id of ids) {
    remove(p.hand, id);
    if (a.to === 'discard') discard(s, catalog, id);
    else if (a.to === 'deckBottom') p.deck.unshift(id);
    else if (a.to === 'deckShuffle') p.deck.push(id);
    else if (a.to === 'prizes') p.prizes.push(id);
    else if (a.to === 'lost') toLost(s, id);
    else {
      const m = newMon(s, id); p.bench.push(m);
      log(s, 'effects.deploy', { player: foe, from: 'hand', to: 'bench', cardId: id, pokemonId: m.id, effectId: source.effectId });
      events.push(makeTriggerEvent(s, catalog, 'bench', foe, m, { origin: 'hand', cardId: id, cause: { kind: 'effect', source } }));
    }
  }
  // Cards going into the deck stay unknown to anyone the text does not show them to.
  log(s, 'effects.opponent-hand', { effectId: source.effectId, player: foe, mode: a.mode, to: a.to, count: ids.length,
    ...(['deckBottom', 'deckShuffle', 'prizes'].includes(a.to) ? {} : { cards: [...ids] }) });
  if (a.to === 'deckShuffle' && ids.length) shuffleZone(s, foe, 'deck', source);
  // 「将其中的1张宝可梦，放于弃牌区。在这种情况下，…该宝可梦…」: a thenMoved's next part reads the cards actually moved.
  finishEffect(s, catalog, d, ids.length > 0, ids);
  prepend(s, ...triggerWork(s, catalog, events));
}
const PRIZE_ZONE_OPS = Object.freeze(['lookPrizes', 'flipPrizes', 'swapPrizeDeck', 'resetPrizes', 'prizeHandSwap', 'deckTopToPrizes', 'discardPrizes', 'lookPrizeHand']);
// Prize cards as a zone (prizes.zone, prizes.face-up). A face-down Prize is chosen by its position only (its face is not seen);
// a face-up one stays face up until it leaves the Prizes, and Prizes placed later are face down.
function runPrizeZone(s, catalog, d) {
  const { action: a, source } = d, owner = source.owner, holder = a.side === 'opponent' ? 1 - owner : owner, p = s.players[holder];
  const slots = (ids) => ids.map((id) => String(p.prizes.indexOf(id)));
  const chooseSlots = (eligible, minimum, maximum) => ask(s, { player: owner, kind: 'prize-slot', options: slots(eligible), minimum, maximum,
    resume: 'effect-choice', data: { ...d, stage: 'prize-slot', lookedAt: eligible }, ruleId: 'prizes.zone' });
  const picked = () => {
    const ids = d.selected.map((slot) => p.prizes[Number(slot)]);
    if (ids.some((id) => !d.lookedAt.includes(id)) || new Set(ids).size !== ids.length)
      throw new EngineError('invalid-prize-choice', 'Choose among the offered Prize positions.');
    return ids;
  };
  if (a.op === 'lookPrizes') {
    // II.C-20: the user looks at the face-down Prize(s), then puts them back face down.
    if (d.stage === 'prize-view') { finishEffect(s, catalog, d, true); return; }
    const hidden = faceDownPrizes(p);
    if (!hidden.length) { finishEffect(s, catalog, d, false); return; }
    if (a.count === 1 && !d.selected) { chooseSlots(hidden, 1, 1); return; }
    const looked = a.count === 1 ? picked() : hidden;
    log(s, 'prizes.zone', { player: owner, prizeOwner: holder, looked: looked.length, effectId: source.effectId });
    log(s, 'prizes.zone', { effectId: source.effectId, prizeOwner: holder, cards: [...looked] }, owner);
    ask(s, { player: owner, kind: 'view-cards', options: ['confirm'], resume: 'effect-choice',
      data: { ...withoutSelection(d), stage: 'prize-view', lookedAt: looked }, ruleId: 'prizes.zone' });
    return;
  }
  if (a.op === 'flipPrizes') {
    const hidden = faceDownPrizes(p);
    if (!hidden.length) { recordEffectCards(s, catalog, d, []); finishEffect(s, catalog, d, false); return; }
    if (a.count === 1 && !d.selected) { chooseSlots(hidden, 1, 1); return; }
    const flipped = a.count === 1 ? picked() : hidden;
    p.faceUpPrizes = [...faceUpPrizes(p), ...flipped];
    log(s, 'prizes.face-up', { player: holder, cards: flipped.map((id) => clone(s.cards[id])), effectId: source.effectId });
    recordEffectCards(s, catalog, d, flipped);
    finishEffect(s, catalog, d, true); return;
  }
  if (a.op === 'swapPrizeDeck') {
    // 「将其与…牌库最上方的卡牌，在反面朝上的状态下互换」: nobody sees either card.
    const hidden = faceDownPrizes(p);
    if (!hidden.length || !p.deck.length) { finishEffect(s, catalog, d, false); return; }
    if (!d.selected) { chooseSlots(hidden, 1, 1); return; }
    const [id] = picked(), slot = p.prizes.indexOf(id);
    p.prizes[slot] = p.deck.pop(); p.deck.push(id);
    log(s, 'prizes.zone', { player: owner, prizeOwner: holder, swapped: 'deckTop', effectId: source.effectId });
    finishEffect(s, catalog, d, true); return;
  }
  if (a.op === 'resetPrizes') {
    // 「数过自己的奖赏卡后，将其全部放回牌库并重洗牌库（反面朝上重洗，放回牌库下方／全部加入手牌）。然后，从牌库上方，抽取…作为奖赏卡放置」.
    const players = a.side === 'both' ? [owner, 1 - owner] : [owner], counted = [];
    for (const i of players) {
      const q = s.players[i], returned = [...q.prizes];
      counted.push(returned.length); leavePrizes(q, returned);
      if (a.to === 'deckBottom') {
        q.deck = [...shuffleIds(s.rng, returned), ...q.deck];
        if (returned.length) log(s, 'effects.shuffle', { player: i, zone: 'prizes', count: returned.length, placement: 'deck-bottom', effectId: source.effectId });
      } else if (a.to === 'hand') q.hand.push(...returned); // Not taking them (JP Q&A テッカグヤGX「ディスカバリーGX」).
      else { q.deck.push(...returned); shuffleZone(s, i, 'deck', source); }
      log(s, 'prizes.zone', { player: i, returned: returned.length, to: a.to, effectId: source.effectId });
    }
    players.forEach((i, k) => {
      const q = s.players[i], n = Math.min(a.count === 'same' ? counted[k] : a.count, q.deck.length);
      q.prizes = n ? q.deck.splice(-n) : [];
      log(s, 'prizes.zone', { player: i, placed: n, effectId: source.effectId });
    });
    finishEffect(s, catalog, d, true); return;
  }
  if (a.op === 'prizeHandSwap') {
    // 「选择最多3张自己的奖赏卡，加入手牌。然后，选择与加入手牌张数相同张数的手牌，反面朝上作为奖赏卡放置」: at least 1 Prize,
    // face-down ones unseen (JP Q&A シャクヤ); this is not taking a Prize card.
    if (d.stage === 'prize-replace') {
      if (d.selected.length !== d.chosen.length || d.selected.some((id) => !p.hand.includes(id)))
        throw new EngineError('invalid-prize-choice', 'Place exactly as many hand cards as were put into the hand.');
      for (const id of d.selected) { remove(p.hand, id); p.prizes.push(id); }
      log(s, 'prizes.zone', { player: owner, fromHand: d.selected.length, effectId: source.effectId });
      finishEffect(s, catalog, d, true); return;
    }
    if (!p.prizes.length) { finishEffect(s, catalog, d, false); return; }
    if (!d.selected) { chooseSlots([...p.prizes], 1, Math.min(a.count, p.prizes.length)); return; }
    const ids = picked();
    leavePrizes(p, ids); p.hand.push(...ids);
    log(s, 'prizes.zone', { player: owner, toHand: ids.length, effectId: source.effectId });
    ask(s, { player: owner, kind: 'select-cards', options: [...p.hand], minimum: ids.length, maximum: ids.length, resume: 'effect-choice',
      data: { ...withoutSelection(d), stage: 'prize-replace', chosen: ids }, ruleId: 'prizes.zone' });
    return;
  }
  if (a.op === 'lookPrizeHand') {
    // 「选择对手反面朝上的1张奖赏卡，以及在不看正面的前提下选择对手1张手牌，各查看其正面。若希望，可以令对手将被选择的卡牌互换。
    // （在对战结束前，那张奖赏卡一直保持正面朝上状态。）」: the Prize is turned face up for good, the hand card is a random one only the user
    // looks at. No hand card: the Prize is still turned face up; no face-down Prize: the hand card is still looked at, nothing is
    // swapped (JP Q&A ロケット団のおじゃまロボ). Swapped, the hand card takes that Prize's place and is placed face down (prizes.zone).
    if (d.stage === 'prize-swap') {
      const [prize] = d.lookedAt, [card] = d.chosen, slot = p.prizes.indexOf(prize);
      if (d.selected[0] === 'perform') {
        leavePrizes(p, [prize]); p.prizes.splice(slot, 0, card); remove(p.hand, card); p.hand.push(prize);
        log(s, 'prizes.zone', { player: owner, prizeOwner: holder, swapped: 'hand', effectId: source.effectId });
      }
      finishEffect(s, catalog, d, true); return;
    }
    if (d.stage === 'prize-view') { finishEffect(s, catalog, d, true); return; }
    const hidden = faceDownPrizes(p);
    if (hidden.length && !d.selected) { chooseSlots(hidden, 1, 1); return; }
    const [prize] = hidden.length ? picked() : [], card = p.hand.length ? p.hand[randomIndex(s.rng, p.hand.length)] : null;
    if (prize) {
      p.faceUpPrizes = [...faceUpPrizes(p), prize];
      log(s, 'prizes.face-up', { player: holder, cards: [clone(s.cards[prize])], effectId: source.effectId });
    }
    if (!card) { finishEffect(s, catalog, d, true); return; }
    log(s, 'effects.opponent-hand', { effectId: source.effectId, player: holder, looked: 1 });
    log(s, 'effects.opponent-hand', { effectId: source.effectId, picked: [card] }, owner);
    const data = { ...withoutSelection(d), lookedAt: prize ? [prize] : [], chosen: [card] };
    if (prize) ask(s, { player: owner, kind: 'optional-effect', options: ['perform', 'skip'], resume: 'effect-choice',
      data: { ...data, stage: 'prize-swap' }, ruleId: 'prizes.zone' });
    else ask(s, { player: owner, kind: 'view-cards', options: ['confirm'], resume: 'effect-choice', data: { ...data, stage: 'prize-view' }, ruleId: 'prizes.zone' });
    return;
  }
  if (a.op === 'discardPrizes') {
    // 「将自己的1张奖赏卡放于弃牌区」: any of the user's Prizes (a face-down one by position); not taking them, so no 「拿取时」 effect
    // (JP Q&A ズガドーンGX「バーストGX」). Whether discarding the last one takes all Prizes has no source: refused, not guessed.
    if (!d.selected) {
      if (p.prizes.length <= a.count)
        throw new EngineError('unresolved-last-prize', 'Discarding the last Prize card needs a CN ruling on whether all Prizes were taken.');
      chooseSlots([...p.prizes], a.count, a.count); return;
    }
    const ids = picked();
    leavePrizes(p, ids);
    for (const id of ids) discard(s, catalog, id);
    log(s, 'prizes.zone', { player: owner, discarded: ids.length, cards: ids.map((id) => clone(s.cards[id])), effectId: source.effectId });
    finishEffect(s, catalog, d, true, ids); return;
  }
  // 「将对手牌库上方2张卡牌，作为对手的奖赏卡放置」.
  const moved = p.deck.splice(-Math.min(a.count, p.deck.length));
  p.prizes.push(...moved);
  log(s, 'prizes.zone', { player: holder, fromDeck: moved.length, effectId: source.effectId });
  finishEffect(s, catalog, d, moved.length > 0);
}
// ability.zone: once 「将这张卡牌放于备战区」 has placed the card, 「这只宝可梦」 is the Pokémon it became. The scheduled
// source itself never changes (continuations keep d.source).
function zoneSource(s, source) {
  if (source.category !== 'ability' || !['hand', 'discard'].includes(source.origin) || source.pokemonId !== null) return source;
  const m = mons(s.players[source.owner]).find((m) => m.stack[0] === source.instanceId);
  return m ? { ...source, pokemonId: m.id } : source;
}
// The currently executing attack's own content (its damage or effects; copied content included).
const ownAttackSource = (s, source) => !!s.attack && source.category === 'attack' && source.instanceId === s.attack.sourceId &&
  source.pokemonId === s.attack.pokemonId && (source.copyId ?? null) === s.attack.execution.copyId;
function runEffect(s, catalog, d) {
  const { action: a } = d, source = zoneSource(s, d.source), owner = source.owner;
  const step = assertEffectStep({ action: a, frames: d.frames });
  if (['sequence', 'then', 'thenMoved', 'orElse', 'bound'].includes(a.op)) {
    const next = expandEffectStep(step);
    advanceTrackedEffect(s, catalog, d, 'expand', null);
    if (next) prepend(s, tasks('effect-choice', { ...next, source: d.source, event: d.event ?? null, local: d.local ?? false, entry: d.entry ?? null,
      payment: d.payment ?? null, ...(d.programId ? { programId: d.programId } : {}) }));
    return;
  }
  if (a.op === 'revealCards' && a.from === 'bothHands') {
    // 「双方互相展示手牌」: every card of both hands, the user's first, recorded for the formula (effects.shared-name).
    const shown = showHands(s, owner, source).flatMap((i) => s.players[i].hand);
    recordEffectCards(s, catalog, d, shown);
    finishEffect(s, catalog, d, shown.length > 0); return;
  }
  if (a.op === 'revealCards') {
    // effects.reveal: shown cards stay where they are; the attack's formula reads them (II.B-02, II.D-02 文例2).
    const p = s.players[owner], pool = a.from === 'hand' ? p.hand.filter((id) => matchesCardSelector(cardDef(s, catalog, id), a.selector)) : [];
    const bounds = a.from === 'hand' && selectionBounds({ ...a.quantity, available: pool.length, zone: 'ownHand', filter: selectorQuantityClass(a.selector) });
    if (a.from === 'hand' && !d.selected && pool.length) {
      ask(s, { player: owner, kind: 'select-cards', options: pool, ...bounds, resume: 'effect-choice', data: d, ruleId: 'effects.reveal' });
      return;
    }
    const shown = a.from === 'deck' ? p.deck.slice(-a.lookTop).reverse() : a.from === 'discard'
      ? p.discard.filter((id) => matchesCardSelector(cardDef(s, catalog, id), a.selector)) : d.selected ?? [];
    if (a.from === 'hand' && d.selected && (!canSelectCount(bounds, shown.length) || shown.some((id) => !pool.includes(id))))
      throw new EngineError('invalid-card-selection', 'Shown cards must be matching cards of the user\'s hand, in the printed quantity.');
    if (shown.length) log(s, 'effects.reveal', { player: owner, from: a.from, cardIds: [...shown], cards: shown.map((id) => clone(s.cards[id])),
      effectId: source.effectId });
    recordEffectCards(s, catalog, d, shown);
    finishEffect(s, catalog, d, shown.length > 0); return;
  }
  if (a.op === 'recordedCards') {
    // 「…放于弃牌区，…追加造成90点伤害。然后，将放于弃牌区的能量…」: the cards this attack's own counted entry recorded before damage.
    // Only those still in the discard pile: a ◇ card went to the Lost Zone instead and is not 「放于弃牌区的」 (JP Q&A セキタンザンVMAX).
    const cards = s.attack.execution.effectCards.find((e) => e.effectId === a.effectId).cards.filter((id) => s.players[owner].discard.includes(id));
    finishEffect(s, catalog, d, cards.length > 0, cards); return;
  }
  if (a.op === 'choosePokemon') {
    // effects.chosen-pokemon 「选择自己的1只宝可梦，抛掷1次硬币。…该宝可梦…」: chosen before the flip; the coin's results act on it.
    const pool = targetedPokemon(s, a.side === 'opponent' ? 1 - owner : owner, source, null, a.target);
    if (!pool.length) { finishEffect(s, catalog, d, false); return; }
    if (!d.selected) {
      ask(s, { player: owner, kind: 'effect-target', options: pool.map((m) => m.id), resume: 'effect-choice', data: d, ruleId: 'effects.chosen-pokemon' });
      return;
    }
    const m = pool.find((m) => m.id === d.selected[0]);
    if (!m) throw new EngineError('invalid-effect-target', 'Effect target no longer matches.');
    log(s, 'effects.chosen-pokemon', { effectId: source.effectId, player: owner, pokemonId: m.id });
    finishEffect(s, catalog, d, true, null, [m.id]); return;
  }
  if (a.op === 'clearAttackEffects') {
    // effects.clear-attack-effects: whoever's attack made them, on the user and the user's Pokémon; the clearing is recorded right after.
    const ids = attackEffectsOn(s, owner);
    retainOngoing(s, (e) => !ids.includes(e.id), 'removed');
    s.playerOngoing = s.playerOngoing.filter((e) => !ids.includes(e.id));
    log(s, 'effects.clear-attack-effects', { effectId: source.effectId, player: owner, effects: ids });
    finishEffect(s, catalog, d, ids.length > 0); return;
  }
  if (a.op === 'revealedCards') {
    // 「将正面朝上的X放于弃牌区，剩余的卡牌放回牌库并重洗牌库」: the cards this attack's own reveal recorded, still where they were shown.
    const reveal = executingAttack(s, catalog).effects.find((b) => b.effectId === a.effectId);
    const entry = s.attack.execution.effectCards.find((e) => e.effectId === a.effectId), p = s.players[owner], zone = reveal.parameters.from;
    const shown = entry.cards.filter((id) => p[zone].includes(id));
    if (!shown.length) { finishEffect(s, catalog, d, false); return; }
    const picked = a.selector ? shown.filter((id) => matchesCardSelector(cardDef(s, catalog, id), a.selector)) : shown;
    // effects.move-lock: a shown card that cannot go there stays where it was shown (only a deck reveal has a rest).
    const kept = zone === 'discard' ? keptCards(s, catalog, source, picked, { zone, to: a.to, holder: owner }) : [];
    const matched = picked.filter((id) => !kept.includes(id)), rest = a.rest ? shown.filter((id) => !picked.includes(id)) : [];
    for (const id of [...matched, ...rest]) remove(p[zone], id);
    for (const [ids, to] of [[matched, a.to], [rest, a.rest]]) for (const id of ids) if (to === 'discard') discard(s, catalog, id); else p[to].push(id);
    log(s, 'effects.reveal', { player: owner, effectId: source.effectId, moved: [...matched.map((id) => ({ cardId: id, to: a.to })),
      ...rest.map((id) => ({ cardId: id, to: a.rest }))] });
    // II.E-36: 「放回牌库并重洗牌库」 shuffles even when no card went back.
    if (a.to === 'deck' || a.rest === 'deck') shuffleZone(s, owner, 'deck', source);
    finishEffect(s, catalog, d, true); return;
  }
  if (a.op === 'selfCounters') {
    // 「给这只宝可梦身上放置最多N个伤害指示物」: 1 to N (II.D-05) before damage; the number placed feeds the formula.
    const m = findMon(s, source.pokemonId).m;
    if (!d.selected) {
      ask(s, { player: owner, kind: 'counter-place-count', options: Array.from({ length: a.maximum }, (_, i) => String(i + 1)),
        resume: 'effect-choice', data: d, ruleId: 'damage.effect-count' });
      return;
    }
    const count = Number(d.selected[0]);
    addCounters(s, catalog, owner, m, count, { kind: 'effect', source });
    log(s, 'damage.counters', { targetId: m.id, effectId: source.effectId, sourceOfTruth: source.sourceOfTruth, operation: a.op, count });
    recordEffectCards(s, catalog, d, [], count);
    finishEffect(s, catalog, d, true); return;
  }
  if (a.op === 'extraTurn') {
    // turn.extra: recorded for this turn; when it ends (after the checkup) the same player takes the next turn.
    // 「如果因为这个招式对手的宝可梦【昏厥】的话」: pending only once this attack has Knocked Out an opponent's Pokémon.
    const attack = a.ifKnockedOut ? { instanceId: source.instanceId, pokemonId: source.pokemonId, attackId: source.attackId, copyId: source.copyId ?? null } : null;
    const entry = createPlayerOngoingEffect({ id: `e${++s.serial}`, player: owner, source,
      effect: { op: 'extraTurn', ...(attack ? { attack } : {}) }, duration: 'thisTurn' }, s);
    s.playerOngoing.push(entry);
    log(s, 'turn.extra', { player: owner, effectId: entry.id, sourceOfTruth: source.sourceOfTruth });
    finishEffect(s, catalog, d, true); return;
  }
  if (a.op === 'endTurn') {
    // effects.end-turn-reaction 「如果对手从手牌将能量附着于受到这个招式影响的宝可梦身上的话，对手的回合结束」: the turn ends after
    // everything already under way (the effect that attached it, the other effects of that event); nothing if it is already ending.
    const player = a.side === 'own' ? owner : 1 - owner;
    const ends = s.current === player && !s.queue.some((t) => ['end-turn', 'start-turn'].includes(t.op));
    if (ends) enqueue(s, tasks('ko'), tasks('end-turn', { player }));
    log(s, 'effects.end-turn-reaction', { player, effectId: source.effectId, ends });
    finishEffect(s, catalog, d, ends); return;
  }
  if (a.op === 'revealHands') {
    // 「双方玩家，各将自己的手牌翻到正面，互相展示」: both players see both hands; nothing moves.
    finishEffect(s, catalog, d, showHands(s, owner, source).length > 0); return;
  }
  if (a.op === 'attackChoice') {
    // 「若希望，可追加造成N伤害。在这种情况下，…」: the user decides before damage (II.E-10); the record is the attacker's own card or nothing.
    if (!d.selected) {
      ask(s, { player: owner, kind: 'optional-effect', options: ['perform', 'skip'], resume: 'effect-choice', data: d, ruleId: 'damage.optional-choice' });
      return;
    }
    const performed = d.selected[0] === 'perform';
    log(s, 'damage.optional-choice', { effectId: source.effectId, player: owner, performed });
    recordEffectCards(s, catalog, d, performed ? [source.instanceId] : []);
    finishEffect(s, catalog, d, performed); return;
  }
  if (a.op === 'damageRedirect') {
    // damage.redirect 「（当…时，）若希望，可将这个招式的伤害，给予对手的1只备战宝可梦而不是战斗宝可梦」: while the printed condition holds,
    // the user may pick one of the opponent's Benched Pokémon (none = the Active Pokémon); the damage step reads the record.
    const bench = s.players[1 - owner].bench, open = bench.length > 0 && (!a.condition ||
      evaluateBattlePredicate(a.condition, battleValueFacts(s, catalog, source, null, sourceModel(s, catalog), queryNodes(a.condition))));
    if (open && !d.selected) {
      ask(s, { player: owner, kind: 'damage-redirect', options: bench.map((m) => m.id), minimum: 0, maximum: 1, allowZero: true,
        resume: 'effect-choice', data: d, ruleId: 'damage.redirect' });
      return;
    }
    const m = open && d.selected.length ? bench.find((x) => x.id === d.selected[0]) : null;
    if (m === undefined) throw new EngineError('invalid-effect-target', 'The chosen Benched Pokémon no longer matches.');
    log(s, 'damage.redirect', { effectId: source.effectId, player: owner, targetId: m?.id ?? null });
    recordEffectCards(s, catalog, d, m ? [top(m)] : []);
    finishEffect(s, catalog, d, !!m); return;
  }
  if (a.op === 'attackKnockoutZone') {
    // ko.attack-lost-zone: kept for this turn, read for the Pokémon this attack's damage Knocks Out.
    const entry = createPlayerOngoingEffect({ id: `e${++s.serial}`, player: owner, source, duration: 'thisTurn', effect: {
      op: 'attackKnockoutZone', attack: { instanceId: source.instanceId, pokemonId: source.pokemonId, attackId: source.attackId, copyId: source.copyId ?? null } } }, s);
    s.playerOngoing.push(entry);
    log(s, 'ko.attack-lost-zone', { player: owner, effectId: entry.id, sourceOfTruth: source.sourceOfTruth });
    finishEffect(s, catalog, d, true); return;
  }
  if (a.op === 'janken') {
    // effects.janken: the user, then the opponent, choose in secret (the opponent's request never shows the user's hand);
    // a tie is played again until one wins. Only the user's win runs the printed result; a counted one records it.
    const hands = ['rock', 'paper', 'scissors'], round = d.janken ?? { round: 1, user: null }, base = withoutSelection(d);
    if (!d.selected) {
      ask(s, { player: owner, kind: 'janken', options: hands, resume: 'effect-choice', data: { ...base, janken: round }, ruleId: 'effects.janken' });
      return;
    }
    if (round.user === null) {
      ask(s, { player: 1 - owner, kind: 'janken', options: hands, resume: 'effect-choice',
        data: { ...base, janken: { round: round.round, user: d.selected[0] } }, ruleId: 'effects.janken' });
      return;
    }
    const other = d.selected[0], result = other === round.user ? 'tie' : hands[(hands.indexOf(round.user) + 2) % 3] === other ? 'win' : 'lose';
    log(s, 'effects.janken', { kind: 'result', effectId: source.effectId, player: owner, round: round.round,
      hands: { [owner]: round.user, [1 - owner]: other }, result });
    if (result === 'tie') {
      ask(s, { player: owner, kind: 'janken', options: hands, resume: 'effect-choice',
        data: { ...base, janken: { round: round.round + 1, user: null } }, ruleId: 'effects.janken' });
      return;
    }
    if (!a.effect) {
      recordEffectCards(s, catalog, d, result === 'win' ? [source.instanceId] : []);
      finishEffect(s, catalog, d, true); return;
    }
    if (result === 'lose') { finishEffect(s, catalog, d, false); return; }
    advanceTrackedEffect(s, catalog, d, 'optional', true);
    prepend(s, tasks('effect-choice', { action: a.effect, frames: d.frames, source: d.source, event: d.event ?? null, local: d.local ?? false,
      entry: d.entry ?? null, payment: d.payment ?? null, ...(d.programId ? { programId: d.programId } : {}) }));
    return;
  }
  if (a.op === 'choose') {
    // 「从2个效果中选择1个使用」: only an option that could change something now may be chosen (effects.choose-one).
    const open = a.options.map((option, i) => ({ option, i })).filter(({ option }) => option.entries.some((entry) => {
      const h = catalog.handler(entry.handlerId);
      return !h.canUse || h.canUse(factContext(s, catalog, h, effectContext(s, catalog, source, d.event ?? null, d.local ?? false, null, false,
        d.entry ?? null, d.payment ?? null), source, entry.parameters), clone(entry.parameters));
    })).map(({ i }) => String(i));
    if (!open.length) { finishEffect(s, catalog, d, false); return; }
    // 「对手将…。或者，对手选择…」: the opponent picks (effects.choose-one-opponent).
    const chooser = a.chooser === 'opponent' ? 1 - owner : owner;
    if (!d.selected) {
      ask(s, { player: chooser, kind: 'choose-effect', options: open, minimum: 1, maximum: 1, resume: 'effect-choice', data: d,
        ruleId: a.chooser ? 'effects.choose-one-opponent' : 'effects.choose-one' });
      return;
    }
    if (d.selected.length !== 1 || !open.includes(d.selected[0]))
      throw new EngineError('invalid-selection', 'Choose exactly one printed option that could change something now.');
    const option = Number(d.selected[0]);
    log(s, 'effects.choose-one', { effectId: source.effectId, player: chooser, option });
    advanceTrackedEffect(s, catalog, d, 'chosen', true, { option });
    prepend(s, tasks('effect-choice', { action: a.options[option].effect, frames: d.frames, source: d.source, event: d.event ?? null, local: d.local ?? false,
      entry: d.entry ?? null, payment: d.payment ?? null, ...(d.programId ? { programId: d.programId } : {}) }));
    return;
  }
  if (a.op === 'optional') {
    if (d.selected) {
      log(s, 'selection.optional', { effectId: source.effectId, performed: d.selected[0] === 'perform', ...(a.chooser ? { chooser: 1 - owner } : {}) });
      if (d.selected[0] === 'perform') {
        advanceTrackedEffect(s, catalog, d, 'optional', true);
        prepend(s, tasks('effect-choice', { action: a.effect, frames: d.frames, source: d.source, event: d.event ?? null, local: d.local ?? false, entry: d.entry ?? null,
          payment: d.payment ?? null, ...(d.programId ? { programId: d.programId } : {}) }));
      }
      else finishEffect(s, catalog, d, false);
    } else ask(s, { player: a.chooser === 'opponent' ? 1 - owner : owner, kind: 'optional-effect', options: ['perform', 'skip'],
      resume: 'effect-choice', data: d, ruleId: 'selection.optional' });
    return;
  }
  if (a.op === 'coin') {
    // II.C-05/II.D-04 文例: flip first; only the printed result opens the rest.
    const own = ownAttackSource(s, source);
    const step = coinOccasion(s, catalog, d.coinOccasion ?? { flipper: a.player ?? owner, spec: { kind: 'fixed', count: 1 },
      will: CHOOSABLE_COINS.includes(source.category), attack: own }, d.selected);
    if (step.ask) { ask(s, { ...step.ask, resume: 'effect-choice', data: { ...withoutSelection(d), coinOccasion: step.occ } }); return; }
    const result = step.occ.receipt.results[0];
    if (own) s.attack.execution.performed = true;
    log(s, 'effects.coin', { effectId: source.effectId, player: a.player ?? owner, result, required: a.outcome,
      sourceOfTruth: source.sourceOfTruth });
    if (result !== a.outcome && !a.otherwise) { finishEffect(s, catalog, d, false); return; }
    advanceTrackedEffect(s, catalog, d, result === a.outcome ? 'optional' : 'otherwise', true);
    prepend(s, tasks('effect-choice', { action: result === a.outcome ? a.effect : a.otherwise, frames: d.frames, source: d.source,
      event: d.event ?? null, local: d.local ?? false, entry: d.entry ?? null, payment: d.payment ?? null,
      ...(d.programId ? { programId: d.programId } : {}) }));
    return;
  }
  if (['coinResult', 'when', 'ifPaid', 'ifMoved'].includes(a.op)) {
    // II.E-38 文例3: the coins this attack's damage flipped, read once more; nothing is flipped again.
    // 「如果…，则…」: the board as it is when this instruction is reached. effects.optional-cost: whether the card's optional cost was paid.
    // 「如果被放于弃牌区的卡牌是能量的话」: the printed kind of a card the first part moved, wherever it is now.
    const met = a.op === 'ifPaid' ? !!d.payment : a.op === 'ifMoved' ? amongCards(a).some((id) => matchesCardSelector(cardDef(s, catalog, id), a.selector)) :
      evaluateBattlePredicate(a.condition, battleValueFacts(s, catalog, source, null, sourceModel(s, catalog), a.op === 'when' ? queryNodes(a.condition) : []));
    if (a.op === 'when') log(s, 'effects.condition', { effectId: source.effectId, player: owner, met });
    if (a.op === 'ifPaid') log(s, 'effects.optional-cost', { effectId: source.effectId, player: owner, paid: met });
    if (a.op === 'ifMoved') log(s, 'effects.moved-cards', { effectId: source.effectId, player: owner, cards: [...a.among], met });
    if (!met && !a.otherwise) { finishEffect(s, catalog, d, false); return; }
    advanceTrackedEffect(s, catalog, d, met ? 'optional' : 'otherwise', true);
    prepend(s, tasks('effect-choice', { action: met ? a.effect : a.otherwise, frames: d.frames, source: d.source,
      event: d.event ?? null, local: d.local ?? false, entry: d.entry ?? null, payment: d.payment ?? null,
      ...(d.programId ? { programId: d.programId } : {}) }));
    return;
  }
  if (a.op === 'coins') {
    // II.B-02 文例2: the flips are counted; only the printed count or result opens the instruction.
    // 「…将与出现正面次数相同数量的…。如果全是反面，则这个招式失败」: the coins of the attack's own failure check, not new flips.
    const own = ownAttackSource(s, source), checked = a.flips.kind === 'failureCheck' ? s.attack.execution.failureReceipt : null;
    const step = checked ? null : coinOccasion(s, catalog, d.coinOccasion ?? { flipper: owner, spec: a.flips,
      will: CHOOSABLE_COINS.includes(source.category), attack: own }, d.selected);
    if (step?.ask) { ask(s, { ...step.ask, resume: 'effect-choice', data: { ...withoutSelection(d), coinOccasion: step.occ } }); return; }
    const receipt = checked ? { results: checked.results, heads: checked.heads, tails: checked.tails, flips: checked.results.length } :
      step.occ.receipt, shown = receipt[a.face];
    if (own) s.attack.execution.performed = true;
    log(s, 'effects.coin', { effectId: source.effectId, player: owner, receipt, face: a.face, sourceOfTruth: source.sourceOfTruth });
    const scale = a.apply.kind === 'scale';
    if (scale ? shown === 0 : shown < (a.apply.kind === 'all' ? receipt.flips : a.apply.count)) { finishEffect(s, catalog, d, false); return; }
    advanceTrackedEffect(s, catalog, d, scale ? 'scaled' : 'optional', true, scale ? { times: shown } : {});
    prepend(s, tasks('effect-choice', { action: scale ? scaleEffect(a, shown) : a.effect, frames: d.frames, source: d.source,
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
      effectBlocked(s, catalog, source, window.owner, findMon(s, pokemonId).m, true)).map(({ pokemonId }) => pokemonId);
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
    const ctx = healingContext(s, catalog, d), window = healingWindow(ctx, a);
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
    const blocked = selected.filter((id) => effectBlocked(s, catalog, source, window.owner, findMon(s, id).m) ||
      monProhibited(s, catalog, window.owner, findMon(s, id).m, 'heal'));
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
        if (!m.energy.length || effectBlocked(s, catalog, source, plan.owner, m)) return [];
        // effects.move-lock: an Energy that cannot be discarded stays attached.
        const kept = keptCards(s, catalog, source, m.energy, { zone: 'field', to: 'discard', holder: plan.owner, pokemon: m });
        return m.energy.filter((energyId) => !kept.includes(energyId)).map((energyId) => ({ m, energyId }));
      });
      for (const { m, energyId } of changes) {
        discardFromPlay(s, catalog, energyId, source); remove(m.energy, energyId); discarded.push(energyId);
        log(s, 'energy.attached-selection', { energyId, from: m.id, to: null, discarded: true,
          effectId: source.effectId, sourceOfTruth: source.sourceOfTruth });
      }
      settleCounterProperties(s, catalog, beforeEnergy, source);
    }
    log(s, 'effects.heal-results', { kind: 'resolved', id: choice.id, source, selected: plan.selected,
      updates: plan.updates, healed: plan.healed, discarded, performed: plan.performed });
    // 「然后，选择附着于该宝可梦身上的…」: a thenMoved next part acts on the Pokémon actually healed.
    finishEffect(s, catalog, d, plan.performed, null, plan.healed); return;
  }
  if (a.op === 'copyAttack') {
    const frame = s.attack, previous = a.origins.some((o) => o.zone === 'previousTurn');
    amongCards(a);
    if (previous) requireRule(catalog.ruleset, 'attack.copy-previous');
    if (!frame || source.category !== 'attack' || source.instanceId !== frame.sourceId || source.pokemonId !== frame.pokemonId ||
        source.attackId !== frame.attack.attackId || (source.copyId ?? null) !== frame.execution.copyId)
      throw new EngineError('invalid-copy-source', 'Copying is part of its original currently executing attack, not a new declaration.');
    if (!d.copyChoice) {
      const step = a.coin === 'none' ? null : coinOccasion(s, catalog, d.coinOccasion ??
        { flipper: owner, spec: { kind: 'fixed', count: 1 }, will: true, attack: true }, d.selected);
      if (step?.ask) { ask(s, { ...step.ask, resume: 'effect-choice', data: { ...withoutSelection(d), coinOccasion: step.occ } }); return; }
      const coin = step ? step.occ.receipt.results[0] : null;
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
      const { selected: _selected, coinOccasion: _flipped, ...rest } = d;
      prepend(s, tasks('effect-choice', { ...rest, stage: 'copy-select', copyChoice: choice })); return;
    }
    assertCopyChoice(s, catalog, d);
    if (!d.selected) {
      // 「对手选择对手自己场上的宝可梦所拥有的1个招式」: the opponent makes the choice.
      ask(s, { player: a.chooser === 'opponent' ? 1 - owner : owner, kind: 'copy-attack', options: d.copyChoice.candidates.map(attackOptionId),
        resume: 'effect-choice', data: d, ruleId: 'attack.copy' }); return;
    }
    const reference = d.copyChoice.candidates.find((r) => attackOptionId(r) === d.selected[0]);
    if (!reference) throw new EngineError('invalid-copy-choice', 'Selected attack is not an eligible printed source.');
    // attack.copy-previous: the previous turn's attack that this copy chain is already running (「まねっこ」 copying 「まねっこ」)
    // would only start the same choice again; what then happens has no CN ruling.
    if (previous && [frame.source.contentSource ?? { instanceId: frame.sourceId, attackId: frame.attack.attackId },
      ...[...frame.copies.map((c) => c.execution), frame.execution].map((e) => e.reference).filter(Boolean)]
      .some((r) => attackOptionId(r) === attackOptionId(reference)))
      throw new EngineError('unresolved-copy-loop', 'Copying an attack this copy chain is already running needs a CN ruling.');
    const attack = copiedAttack(s, catalog, reference);
    if (attack.condition && !a.among) throw new EngineError('unresolved-copy-condition', 'Whether a copied attack\'s own use condition applies needs card-specific CN evidence.');
    // 「那只宝可梦所拥有的1个招式」 of a moved card: its own use condition is judged now; unmet, nothing of it is performed and
    // the attack ends (attack.copy).
    const unmet = !!attack.condition && !attackConditionMet(s, catalog, owner, attack, findMon(s, frame.pokemonId).m);
    if (attack.specialRule && !unmet) {
      if (a.special.mode === 'needsRuling') throw new EngineError('unresolved-copy-special-rule', 'Copied GX/VSTAR handling needs card-specific CN evidence.');
      if (a.special.mode === 'consumeUserQuota') {
        requireRule(catalog.ruleset, 'attack.copy-special-rule');
        s.players[owner][attack.specialRule === 'GX' ? 'gxUsed' : 'vstarUsed'] = true;
        if (!frame.usedSpecialRules.includes(attack.specialRule)) frame.usedSpecialRules.push(attack.specialRule);
      }
    }
    log(s, 'attack.copy', { kind: 'selected', id: d.copyChoice.id, source, reference, parentCopyId: frame.execution.copyId });
    frame.copies.push({ execution: clone(frame.execution), options: clone(frame.options), damageModels: clone(frame.damageModels),
      continuation: clone(d) });
    frame.execution = { reference: clone(reference), copyId: d.copyChoice.id, performed: false, failureReceipt: null, phase: 'failure-check', damageCoins: null, effectCards: [] };
    if (unmet) { log(s, 'attack.copy', { kind: 'condition', id: d.copyChoice.id, source, met: false }); finishFailedAttack(s, catalog); return; }
    beginAttackContent(s, catalog); return;
  }
  if (a.op === 'returnPokemon') {
    // damage.bench-count: Benched Pokémon leaving before damage vacate no Active Spot.
    if (s.attack && a.target !== 'bench' && s.queue.some((t) => t.op === 'after-attack'))
      throw new EngineError('unsupported-attack-transition', 'A pre-damage departure needs its own reviewed damage/Active-replacement semantics.');
    const ctx = effectContext(s, catalog, source, d.event ?? null), targetOwner = a.side === 'own' ? owner : 1 - owner;
    // 「直到其数量变为3只为止」「将未选择的…」: the Pokémon kept are the ones not chosen.
    const pool = fieldReturnTargets(ctx, a), quantity = a.quantity.kind === 'leave'
      ? { kind: 'exact', count: Math.max(0, pool.length - a.quantity.count) } : a.quantity;
    const bounds = quantity.count === 0 ? null : selectionBounds({ ...quantity, available: pool.length });
    // effects.field-return-deck: while their order is chosen, the Pokémon already chosen wait in chosen.
    const picked = d.stage === 'return-order' ? d.chosen : d.selected;
    if (picked) {
      if (!bounds || !canSelectCount(bounds, picked.length) || picked.some((id) => !pool.some((m) => m.id === id)))
        throw new EngineError('invalid-field-return', 'Returned Pokémon must satisfy the original public predicate and quantity.');
      // Compute protection for the whole batch before removing any continuous source.
      const selected = picked.map((id) => findMon(s, id).m);
      const changes = selected.map((m) => ({ m, blocked: effectBlocked(s, catalog, source, targetOwner, m) ||
        pokemonLocked(s, catalog, source, m, targetOwner, a.to, a.attachments === 'return' ? a.to : 'discard') }));
      const p = s.players[targetOwner], departed = [], tops = [];
      if (changes.some(({ m, blocked }) => !blocked &&
          s.queue.some((t) => ['ko', 'ko-discard'].includes(t.op) && t.data.batch?.some((k) => k.id === m.id))))
        throw new EngineError('unsupported-ko-zone-replacement', 'A latched Knock Out needs its own sourced zone-replacement semantics.');
      const leavingActive = changes.some(({ m, blocked }) => !blocked && p.active === m);
      if (leavingActive && a.promotion.timing === 'needsRuling' &&
          p.bench.some((m) => !changes.some((c) => c.m.id === m.id && !c.blocked)))
        throw new EngineError('unresolved-field-promotion', 'The return movement cannot guess when its holder replaces the Active.');
      // 「放回牌库上方／下方」「以任意顺序重新排列」: several cards go to that end in the order their owner chooses, the first chosen uppermost.
      const toDeck = changes.filter((c) => !c.blocked).flatMap(({ m }) => [...m.stack, ...(a.attachments === 'return' ? [...m.energy, ...m.tools] : [])]);
      if (['deckTop', 'deckBottom'].includes(a.to) && toDeck.length > 1 && d.stage !== 'return-order') {
        ask(s, { player: targetOwner, kind: 'order-cards', options: toDeck, minimum: toDeck.length, maximum: toDeck.length,
          resume: 'effect-choice', data: { ...withoutSelection(d), stage: 'return-order', chosen: picked }, ruleId: 'effects.deck-order' });
        return;
      }
      const order = d.stage === 'return-order' ? d.selected : toDeck;
      if (order.length !== toDeck.length || order.some((id) => !toDeck.includes(id)))
        throw new EngineError('invalid-card-selection', 'The returned cards go back in one order of exactly those cards.');
      // trigger.discarded 「当这只宝可梦…被放于弃牌区时」: its Abilities in effect before any of them leaves.
      const model = a.to === 'discard' ? sourceModel(s, catalog) : null, inEffect = new Map(changes.filter((c) => model && !c.blocked).map(({ m }) =>
        [top(m), monDef(s, catalog, m).mechanics.abilities.filter((x) => model.availability.get(sourceNodeId('ability', top(m), x.abilityId)).enabled)]));
      for (const { m, blocked } of changes) if (!blocked) {
        const attachments = [...m.energy, ...m.tools];
        // II.C-01: put into the discard pile, each card into its owner's; not a Knock Out, so no Prize card.
        if (a.to === 'discard') for (const id of m.stack) discard(s, catalog, id);
        else if (a.to === 'lost' && requireRule(catalog.ruleset, 'zones.lost-zone')) m.stack.forEach((id) => toLost(s, id));
        else (a.to === 'hand' ? p.hand : p.deck).push(...m.stack);
        if (a.attachments === 'return' && a.to === 'lost') attachments.forEach((id) => toLost(s, id));
        else if (a.attachments === 'return') (a.to === 'hand' ? p.hand : p.deck).push(...attachments);
        else for (const id of attachments) discardFromPlay(s, catalog, id);
        if (p.active === m) {
          p.active = null; s.vacancies[targetOwner] = { source: clone(source), promotion: clone(a.promotion) };
        } else p.bench.splice(p.bench.indexOf(m), 1);
        departed.push(m.id); tops.push(top(m));
        log(s, 'effects.field-return', { player: targetOwner, pokemonId: m.id, pokemonCards: [...m.stack],
          attachments, to: a.to, attachmentDestination: a.attachments === 'return' ? a.to : 'discard',
          sourceOfTruth: source.sourceOfTruth });
      }
      latchDiscarded(s, catalog, source, [...inEffect.keys()], 'field', inEffect);
      // effects.field-return-deck: the cards just put into the deck move to its printed end; 「反面朝上重洗」 in a random order (II.E-35).
      if (['deckTop', 'deckBottom', 'shuffleBottom'].includes(a.to) && toDeck.length) {
        const rest = p.deck.filter((id) => !toDeck.includes(id)), placed = a.to === 'shuffleBottom' ? shuffleIds(s.rng, [...toDeck]) : [...order].reverse();
        p.deck = a.to === 'deckTop' ? [...rest, ...placed] : [...placed, ...rest];
        log(s, 'effects.deck-order', { player: targetOwner, to: a.to, count: toDeck.length, effectId: source.effectId });
      }
      retainOngoing(s, (e) => !departed.includes(e.targetId), 'leave');
      if (departed.length && a.to === 'deckShuffle') shuffleZone(s, targetOwner, 'deck', source);
      // damage.bench-count: one record per Pokémon (its top card), however many cards it was.
      recordEffectCards(s, catalog, d, tops);
      finishEffect(s, catalog, d, departed.length > 0);
      if (leavingActive && p.bench.length && a.promotion.timing === 'afterAction')
        prepend(s, tasks('promote', { player: targetOwner, reason: 'fieldReturn', ...clone(s.vacancies[targetOwner]) }));
    } else if (!pool.length || !bounds) { recordEffectCards(s, catalog, d, []); finishEffect(s, catalog, d, false); }
    else if (a.quantity.kind === 'all') prepend(s, tasks('effect-choice', { ...d, selected: pool.map((m) => m.id) }));
    else ask(s, { player: a.chooser === 'holder' ? targetOwner : owner, kind: 'return-pokemon', options: pool.map((m) => m.id),
      ...bounds, resume: 'effect-choice', data: d, ruleId: 'effects.field-return' });
    return;
  }
  if (a.op === 'returnAttached') {
    // effects.attached-return 「将放于双方战斗宝可梦身上的所有卡牌，各放回牌库并重洗牌库」: Energy and Tools, each into its owner's
    // deck (II.C-02); the evolution cards beneath are not attached cards and the Pokémon stays. Protection is read for both first.
    const holders = attachedReturnHolders(effectContext(s, catalog, source, d.event ?? null), a)
      .map(({ owner: holder }) => ({ holder, m: s.players[holder].active }))
      .filter(({ holder, m }) => !effectBlocked(s, catalog, source, holder, m));
    const decks = new Set();
    for (const { holder, m } of holders) {
      // effects.move-lock: an attached card that cannot be put into the deck stays attached.
      const kept = keptCards(s, catalog, source, [...m.energy, ...m.tools], { zone: 'field', to: 'deck', holder, pokemon: m });
      const cards = [...m.energy, ...m.tools].filter((id) => !kept.includes(id));
      m.energy = m.energy.filter((id) => kept.includes(id)); m.tools = m.tools.filter((id) => kept.includes(id));
      for (const id of cards) { s.players[s.cards[id].owner].deck.push(id); decks.add(s.cards[id].owner); }
      log(s, 'effects.attached-return', { player: holder, pokemonId: m.id, cards, effectId: source.effectId, sourceOfTruth: source.sourceOfTruth });
    }
    for (const player of decks) shuffleZone(s, player, 'deck', source);
    enforceEnergyRetention(s, catalog);
    finishEffect(s, catalog, d, holders.length > 0); return;
  }
  if (['evolvePokemon', 'inheritPokemon'].includes(a.op)) {
    const ctx = effectContext(s, catalog, source, d.event ?? null), p = s.players[owner];
    // 「如果进化后该宝可梦为【1阶进化】的话，则可以继续选择1张【2阶进化】使其进化」: a bound next part evolves only that Pokémon.
    if (boundPokemon(d)) requireRule(catalog.ruleset, 'effects.evolve-bound');
    const pool = a.from === 'hand' && handLock(s, catalog, owner).all ? [] : transitionTargets(ctx, a).filter((m) => (a.op !== 'evolvePokemon' ||
      evolutionTiming(s, owner, m, a.timing).allowed || evolutionTiming(s, owner, m, a.timing).needsRuling) && boundTo(d, m) &&
      (!a.evolvableTarget || poolCouldEvolve(ctx, a, m)))
      .map((m) => findMon(s, m.id).m);
    if (a.each) { evolveEach(s, catalog, d, ctx, pool); return; }
    if (d.transition) {
      const m = pool.find((m) => m.id === d.transition.pokemonId);
      if (!m || top(m) !== d.transition.topCardId) throw new EngineError('invalid-pokemon-transition', 'Transition target changed before card selection.');
      const choices = transitionChoices(s, catalog, ctx, a, m), bounds = selectionBounds({
        kind: 'exact', count: 1, available: choices.length,
        zone: a.from === 'deck' ? 'deck' : a.from === 'hand' ? 'ownHand' : 'public', filter: 'specific',
      });
      if (d.selected) {
        const selected = d.stage === 'transition-empty' ? [] : d.selected;
        if (!canSelectCount(bounds, selected.length) || selected.some((id) => !choices.includes(id)))
          throw new EngineError('invalid-pokemon-transition', 'Chosen card does not satisfy the approved evolution or replacement relation.');
        let performed = false, event = null;
        // effects.move-lock: an inherited replacement needs the old top card to go to its printed zone.
        if (selected.length && !effectBlocked(s, catalog, source, owner, m) &&
            !(a.op === 'inheritPokemon' && keptCards(s, catalog, source, [top(m)], { zone: 'field', to: a.to, holder: owner, pokemon: m }).length)) {
          const id = selected[0]; remove(p[a.from], id);
          if (a.op === 'evolvePokemon') event = evolveMon(s, catalog, owner, m, id, a.from, source);
          else {
            const old = m.stack.at(-1), wasLethal = m.counters * 10 >= hp(s, catalog, owner, m);
            m.stack[m.stack.length - 1] = id;
            if (a.to === 'discard') discard(s, catalog, old); else p[a.to === 'deckShuffle' ? 'deck' : a.to].push(old);
            enforceEnergyRetention(s, catalog); recordTransitionKO(s, catalog, owner, m, wasLethal, source);
            log(s, 'effects.inherit', { pokemonId: m.id, fromCardId: old, toCardId: id, sourceOfTruth: source.sourceOfTruth });
          }
          performed = true;
        }
        // 「…放回牌库，并重洗牌库」 / 「并重洗牌库」: a searched deck is shuffled whether or not a card was found.
        const shuffled = (a.op === 'evolvePokemon' ? a.shuffleAfter : a.from === 'deck') && shuffleZone(s, owner, 'deck', source);
        // 「进化后的宝可梦」「该宝可梦」: a thenMoved's next part acts on the Pokémon that actually evolved.
        finishEffect(s, catalog, d, performed || shuffled, null, event ? [m.id] : []);
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
      const eligible = a.from === 'deck' ? pool :
        pool.filter((m) => transitionChoices(s, catalog, ctx, a, m).length > 0);
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
        // effects.move-lock: the evolution cards that would come off are part of the Pokémon.
        return { m, count: entry.count, blocked: entry.count > 0 && (effectBlocked(s, catalog, source, targetOwner, m) ||
          keptCards(s, catalog, source, m.stack.slice(-entry.count), { zone: 'field', to: a.to, holder: targetOwner, pokemon: m }).length > 0),
          wasLethal: m.counters * 10 >= hp(s, catalog, targetOwner, m), conditions: transitionConditions(s, catalog, targetOwner, m) };
      });
      let performed = false;
      for (const { m, count, blocked, conditions } of changes) if (count > 0 && !blocked) {
        const removed = m.stack.splice(-count).reverse();
        p[a.to === 'deckShuffle' ? 'deck' : a.to].push(...removed);
        m.conditions = conditions; m.enteredTurn = s.turn; m.evolvedTurn = 0; delete m.facts.evolution;
        m.facts.formSince = s.battleHistory.events.length; // history.previous-opponent-move
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
      if (p.bench.length >= benchLimit(s, catalog, owner) || !enterAllowed(s, catalog, entry.cardId, source)) { finishEffect(s, catalog, d, false); return; }
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
    // II.C-01: into the deck holder's discard pile; II.A: fewer cards, as many as possible. 「双方各」: each deck, the user's recorded first.
    // effects.move-lock: a deck an effect cannot discard from is left alone (JP Q&A パトロールキャップ × バンギラスV「やまなだれ」).
    const holders = (a.side === 'both' ? [owner, 1 - owner] : [a.side === 'own' ? owner : 1 - owner])
      .filter((holder) => a.to === 'lost' || !deckLocked(s, catalog, source, holder)), moved = [];
    if (!holders.length) { finishEffect(s, catalog, d, false); return; }
    // 「最多N张」: the user first picks how many, 1 to N (II.D-05), at most the deck holds; then they go at once.
    const most = a.upTo ? Math.min(a.count, s.players[holders[0]].deck.length) : 0;
    if (most && !d.selected) {
      ask(s, { player: owner, kind: 'deck-top-count', options: Array.from({ length: most }, (_, i) => String(i + 1)),
        resume: 'effect-choice', data: d, ruleId: 'selection.up-to' });
      return;
    }
    for (const holder of holders) {
      // 「将自己的牌库从上方开始放于弃牌区直到剩余张数变为1张为止」: all but the bottom N, at once (JP Q&A かがやくハガネール「フィニッシュブレイク」).
      const deck = s.players[holder].deck, n = a.leave !== undefined ? deck.length - a.leave : most ? Number(d.selected[0]) : a.count;
      // effects.deck-bottom-discard 「将自己牌库下方N张卡牌放于弃牌区」: the deck's first entries are its bottom.
      const ids = a.from === 'bottom' ? deck.splice(0, n) : deck.splice(Math.max(0, deck.length - n)).reverse();
      for (const id of ids) if (a.to === 'lost') toLost(s, id); else discard(s, catalog, id);
      log(s, a.from === 'bottom' ? 'effects.deck-bottom-discard' : 'effects.deck-top-discard', { player: holder, cards: ids.map((id) => clone(s.cards[id])),
        effectId: source.effectId, sourceOfTruth: source.sourceOfTruth, ...(a.to ? { to: a.to } : {}) });
      moved.push(...ids);
    }
    recordEffectCards(s, catalog, d, moved);
    finishEffect(s, catalog, d, moved.length > 0, moved); return;
  }
  if (a.op === 'replacePokemon') {
    // effects.replace-zones 「选择自己弃牌区中的1张…」: the replacement comes from the public discard pile instead (no shuffle).
    const p = s.players[owner], found = findMon(s, source.pokemonId), zone = p[a.from];
    const locks = enterLocks(s, catalog, owner, sourceModel(s, catalog));
    const pool = zone.filter((id) => matchesCardSelector(cardDef(s, catalog, id), a.selector) && enterAllowed(s, catalog, id, source, locks));
    if (!found || found.owner !== owner || !zone.length || a.from === 'discard' && !pool.length) { finishEffect(s, catalog, d, false); return; }
    const bounds = selectionBounds({ kind: 'exact', count: 1, available: pool.length, zone: a.from === 'deck' ? 'deck' : 'public', filter: 'specific' });
    if (!d.stage) {
      if (pool.length) ask(s, { player: owner, kind: 'select-cards', options: pool, ...bounds, resume: 'effect-choice',
        data: { ...d, stage: 'replace-select', lookedAt: [...zone] }, ruleId: 'effects.replace' });
      else ask(s, { player: owner, kind: 'view-cards', options: ['confirm'], resume: 'effect-choice',
        data: { ...d, stage: 'replace-empty', lookedAt: [...p.deck] }, ruleId: 'effects.replace' });
      return;
    }
    const selected = d.stage === 'replace-empty' ? [] : d.selected;
    if (canonicalJSON(d.lookedAt) !== canonicalJSON(zone) || !canSelectCount(bounds, selected.length) ||
        selected.some((id) => !pool.includes(id)))
      throw new EngineError('invalid-pokemon-replacement', 'The replacement must be one matching card of the unchanged searched deck.');
    let performed = false;
    if (selected.length) {
      // II.E-12 / II.C-13: a new Pokémon in the same spot; nothing carries over and this is not a Knock Out (I.D).
      // 「…放于放逐区」: every card, the evolution cards beneath included, to its owner's Lost Zone (JP Q&A ポポッコ).
      const m = found.m, cards = [...m.stack, ...m.energy, ...m.tools];
      remove(zone, selected[0]);
      for (const id of cards) if (a.to === 'lost') toLost(s, id); else discardFromPlay(s, catalog, id);
      const fresh = newMon(s, selected[0]);
      if (p.active === m) p.active = fresh; else p.bench[p.bench.indexOf(m)] = fresh;
      retireTarget(s, m.id, 'leave');
      log(s, 'effects.replace', { player: owner, pokemonId: m.id, [a.to === 'lost' ? 'lost' : 'discarded']: cards, placed: clone(s.cards[selected[0]]),
        newPokemonId: fresh.id, position: p.active === fresh ? 'active' : 'bench', effectId: source.effectId,
        sourceOfTruth: source.sourceOfTruth });
      performed = true;
    }
    finishEffect(s, catalog, d, a.shuffleAfter && shuffleZone(s, owner, 'deck', source) || performed); return;
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
  if (PRIZE_ZONE_OPS.includes(a.op)) { runPrizeZone(s, catalog, d); return; }
  if (a.op === 'swapHandDeckTop') {
    // effects.hand-deck-swap: the chosen hand card becomes the top of the deck; the old top card joins the hand.
    const p = s.players[owner];
    if (!p.hand.length || !p.deck.length) { finishEffect(s, catalog, d, false); return; }
    if (!d.selected) {
      ask(s, { player: owner, kind: 'select-cards', options: [...p.hand], resume: 'effect-choice', data: d, ruleId: 'effects.hand-deck-swap' });
      return;
    }
    const [id] = d.selected;
    if (!p.hand.includes(id)) throw new EngineError('invalid-card-selection', 'Choose one of your own hand cards.');
    const top = p.deck.pop(); remove(p.hand, id); p.deck.push(id); p.hand.push(top);
    log(s, 'effects.hand-deck-swap', { player: owner, effectId: source.effectId });
    log(s, 'effects.hand-deck-swap', { effectId: source.effectId, toDeck: id, toHand: top }, owner);
    finishEffect(s, catalog, d, true); return;
  }
  if (a.op === 'deploySelf') {
    // ability.zone 「将这张卡牌放于备战区」: from the hand or discard pile it is used in; 「这只宝可梦」 is then the Pokémon it became.
    const p = s.players[owner], zone = source.origin;
    if (!['hand', 'discard'].includes(zone) || !p[zone].includes(source.instanceId) || !a.to && (p.bench.length >= benchLimit(s, catalog, owner) ||
        !enterAllowed(s, catalog, source.instanceId, source))) {
      finishEffect(s, catalog, d, false); return;
    }
    remove(p[zone], source.instanceId);
    if (a.to === 'deckBottom' || a.to === 'lost') {
      // 「将这张卡牌放回牌库下方／放于放逐区」: the card itself leaves that zone, never into play.
      if (a.to === 'lost') toLost(s, source.instanceId); else p.deck.unshift(source.instanceId);
      log(s, 'ability.zone', { player: owner, from: zone, to: a.to, cardId: source.instanceId, effectId: source.effectId });
      finishEffect(s, catalog, d, true); return;
    }
    const m = newMon(s, source.instanceId);
    if (a.to === 'active') {
      // ability.zone-active: this card onto the Active Spot first, then the Active Pokémon back to the Bench (JP Q&A メテノ「ほしふり」),
      // its Special Conditions and attached effects ending as when it is switched (II.C-03).
      requireRule(catalog.ruleset, 'ability.zone-active');
      const old = p.active;
      p.active = m; old.conditions = emptyConditions(); p.bench.push(old);
      retainOngoing(s, (e) => !(e.targetId === old.id && e.clearOnBench), 'bench');
      log(s, 'effects.deploy', { player: owner, from: zone, to: 'active', cardId: source.instanceId, pokemonId: m.id, effectId: source.effectId });
      log(s, 'status.clear', { player: owner, from: old.id, to: m.id });
      prepend(s, ...triggerWork(s, catalog, [makeTriggerEvent(s, catalog, 'movedToBench', owner, old, { cause: { kind: 'effect', source } })]));
      finishEffect(s, catalog, d, true); return;
    }
    p.bench.push(m);
    log(s, 'effects.deploy', { player: owner, from: zone, to: 'bench', cardId: source.instanceId, pokemonId: m.id, effectId: source.effectId });
    prepend(s, ...triggerWork(s, catalog, [makeTriggerEvent(s, catalog, 'bench', owner, m,
      { origin: zone, cardId: source.instanceId, cause: { kind: 'effect', source } })]));
    finishEffect(s, catalog, d, true); return;
  }
  if (a.op === 'swapCounters') {
    // 「将双方战斗宝可梦身上放置的伤害指示物，全部互换」 (damage.counters-swap): an opponent's Active protected from this effect keeps
    // its counters, and this side's counters are removed without being placed anywhere (JP Q&A, ソーナンスV「ふんばりがえし」).
    const mine = s.players[owner].active, theirs = s.players[1 - owner].active, before = [mine.counters, theirs.counters];
    const blocked = effectBlocked(s, catalog, source, 1 - owner, theirs, true);
    const set = (o, m, n) => {
      if (n > m.counters) addCounters(s, catalog, o, m, n - m.counters, { kind: 'effect', source });
      else { m.counters = n; if (m.counters * 10 < hp(s, catalog, o, m)) delete m.facts.knockoutCause; }
    };
    set(owner, mine, blocked ? 0 : before[1]);
    if (!blocked) set(1 - owner, theirs, before[0]);
    log(s, 'damage.counters-swap', { effectId: source.effectId, pokemonIds: [mine.id, theirs.id], before, after: [mine.counters, theirs.counters] });
    finishEffect(s, catalog, d, before[0] + before[1] > 0); return;
  }
  if (a.op === 'gameResult') {
    // win.effect (II.E-38): decided here for the effect user, outside the I.E checks.
    log(s, 'win.effect', { player: owner, result: a.result, effectId: source.effectId, sourceOfTruth: source.sourceOfTruth });
    finishEffect(s, catalog, d, true);
    finish(s, a.result === 'win' ? owner : 1 - owner, 'effect'); return;
  }
  if (a.op === 'turnEndEffect') {
    // effects.turn-end: recorded for this turn; opened when it ends, before the checkup.
    const entry = createPlayerOngoingEffect({ id: `e${++s.serial}`, player: owner, source, effect: { op: 'turnEndEffect', program: a.program },
      duration: 'thisTurn' }, s);
    s.playerOngoing.push(entry);
    log(s, 'effects.turn-end', { player: owner, effectId: entry.id, recorded: true, sourceOfTruth: source.sourceOfTruth });
    finishEffect(s, catalog, d, true); return;
  }
  if (a.op === 'discardSelf') {
    // effects.discard-self 「然后，将这张卡牌放于弃牌区」: this Tool or Special Energy, while it is still attached.
    const found = allMons(s).find(({ m }) => [...m.tools, ...m.energy].includes(source.instanceId));
    if (!found) { finishEffect(s, catalog, d, false); return; }
    discardFromPlay(s, catalog, source.instanceId);
    remove(found.m.tools.includes(source.instanceId) ? found.m.tools : found.m.energy, source.instanceId);
    log(s, 'effects.discard-self', { player: s.cards[source.instanceId].owner, pokemonId: found.m.id, cardId: source.instanceId });
    finishEffect(s, catalog, d, true); return;
  }
  if (a.op === 'returnSelf') {
    // effects.return-self: the Item/Supporter in use goes to its user's hand instead of the discard pile.
    const p = s.players[owner];
    // effects.copy-supporter: a copied 「这张「X」」 is the chosen Supporter, never the copying Trainer (JP Q&A カヒリ).
    const completion = !source.contentSource && p.resolving.includes(source.instanceId) ? prizeCompletion(s, source) : null;
    if (completion?.kind !== 'trainer') { finishEffect(s, catalog, d, false); return; }
    remove(p.resolving, source.instanceId);
    if (a.to === 'deckShuffle') { p.deck.push(source.instanceId); shuffleZone(s, owner, 'deck', source); } else p.hand.push(source.instanceId);
    log(s, 'effects.return-self', { player: owner, cardId: source.instanceId, completion, ...(a.to ? { to: a.to } : {}) });
    finishEffect(s, catalog, d, true); return;
  }
  if (a.op === 'exchangePrizes') {
    // effects.copy-supporter: 「与这张「X」互换」 needs the chosen card itself, so a copy exchanges nothing (JP Q&A グラジオ).
    if (source.contentSource) { finishEffect(s, catalog, d, false); return; }
    assertPrizeChoice(s, catalog, d);
    const ctx = prizeExchangeContext(s, catalog, source), p = s.players[owner];
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
    p.prizes = [...plan.prizesAfter, ...faceUpPrizes(p)];
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
    const ctx = deckContext(s, catalog, d, source), p = s.players[owner], c = d.deckChoice;
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
    const ordering = ['deck-energy-order', 'deck-energy-swap'].includes(d.stage), chosen = d.stage === 'deck-energy-select' ? [] : c.chosen;
    let assignments = [...c.assignments];
    if (chosen.length && !ordering) {
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
    if (a.swap && chosen.length && !ordering) {
      const next = { ...withoutSelection(d), stage: 'deck-energy-swap', deckChoice: { ...c, chosen, assignments } };
      ask(s, { player: owner, kind: 'select-cards', ...deckChoicePrompt(s, catalog, next), resume: 'effect-choice', data: next, ruleId: 'effects.attach' });
      return;
    }
    // 「将剩余的卡牌以任意顺序重新排列，放回牌库上方」: the user orders the rest once every card has its recipient, before anything moves.
    if (a.remainder === 'deckTop' && !ordering && plan.remainder.length > 1) {
      const next = { ...withoutSelection(d), stage: 'deck-energy-order', deckChoice: { ...c, chosen, assignments } };
      ask(s, { player: owner, kind: 'order-cards', ...deckChoicePrompt(s, catalog, next), resume: 'effect-choice', data: next, ruleId: 'effects.deck-order' });
      return;
    }
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
      // 「将被换下的能量放回牌库并重洗牌库」: the swapped card goes into the deck before the shuffle.
      if (d.stage === 'deck-energy-swap') {
        remove(target.m.energy, d.selected[0]); p.deck.push(d.selected[0]);
        log(s, 'energy.return', { energyId: d.selected[0], from: targetId, to: 'deckShuffle', effectId: source.effectId, sourceOfTruth: source.sourceOfTruth });
      }
    }
    enforceEnergyRetention(s, catalog);
    const events = changes.filter((c) => !c.blocked).map(({ instanceId, target }) =>
      makeTriggerEvent(s, catalog, 'energyAttached', owner, target.m, {
        origin: 'deck', cardId: instanceId, cause: { kind: 'effect', source },
      }));
    if (a.reveal) log(s, 'effects.search', { kind: 'revealed', id: c.id,
      revealed: chosen.map((id) => clone(s.cards[id])), effectId: source.effectId });
    const rest = plan.remainder.filter((id) => p.deck.includes(id));
    let didShuffle = false;
    if (a.remainder === 'shuffleDeck') didShuffle = shuffleZone(s, owner, 'deck', source);
    else if (rest.length) {
      // A bounded window's other looked-at cards; the rest of the deck stays in order.
      for (const id of rest) remove(p.deck, id);
      if (a.remainder === 'hand') {
        p.hand.push(...rest);
        log(s, 'effects.search', { kind: 'rest-to-hand', id: c.id, player: owner, count: rest.length, effectId: source.effectId });
        log(s, 'effects.search', { kind: 'rest-to-hand', id: c.id, cards: [...rest] }, owner);
      } else if (a.remainder === 'discard') {
        for (const id of rest) discard(s, catalog, id);
        log(s, 'effects.discard', { player: owner, from: 'deck', cards: rest.map((id) => clone(s.cards[id])), effectId: source.effectId });
      } else if (a.remainder === 'deckTop') {
        // Back on top in the user's order, the first uppermost (one card has one order).
        p.deck.push(...[...(ordering ? d.selected : rest)].reverse());
        log(s, 'effects.deck-order', { player: owner, from: 'deck', to: 'deckTop', count: rest.length, effectId: source.effectId });
      } else {
        p.deck = [...shuffleIds(s.rng, rest)].reverse().concat(p.deck);
        log(s, 'effects.shuffle', { player: owner, zone: 'deck', subset: 'looked-remainder', count: rest.length, placement: 'bottom', effectId: source.effectId });
      }
    }
    // 「并重洗牌库。然后，在被附着的宝可梦身上放置N个伤害指示物」: each attached card's recipient, after the deck instructions.
    if (a.recipientEffect) for (const { target, blocked } of changes) if (!blocked) {
      if (a.recipientEffect.counters) {
        addCounters(s, catalog, owner, target.m, a.recipientEffect.counters, { kind: 'effect', source });
        log(s, 'damage.counters', { targetId: target.m.id, effectId: source.effectId, sourceOfTruth: source.sourceOfTruth, operation: 'counters' });
      } else healBy(s, catalog, owner, target.m, a.recipientEffect.heal, source);
    }
    finishEffect(s, catalog, d, applied > 0 || didShuffle || rest.length > 0, changes.filter((c) => !c.blocked).map((c) => c.instanceId));
    prepend(s, ...triggerWork(s, catalog, events)); return;
  }
  if (a.op === 'cards') {
    // 「对手弃牌区中的…」: the cards are the opponent's; the effect user still chooses.
    const holder = a.side === 'opponent' ? 1 - owner : owner, p = s.players[holder];
    if (d.stage === 'cards-remainder') { placeCardsRemainder(s, catalog, d, d.selected); return; }
    if (d.stage === 'cards-move' && ['deckTop', 'deckBottom'].includes(a.to)) {
      // The rest of a searched deck is shuffled first; the chosen cards then go on the printed end, the first chosen uppermost.
      const shuffled = a.shuffleAfter && shuffleZone(s, holder, 'deck', source), placed = [...d.chosen].reverse();
      for (const id of d.chosen) remove(p.resolving, id);
      p.deck = a.to === 'deckTop' ? [...p.deck, ...placed] : [...placed, ...p.deck];
      log(s, 'effects.deck-order', { player: owner, from: a.from, to: a.to, count: d.chosen.length, effectId: source.effectId });
      recordEffectCards(s, catalog, d, d.chosen);
      finishEffect(s, catalog, d, d.chosen.length > 0 || shuffled, d.chosen); return;
    }
    if (d.stage === 'cards-move') {
      if (d.index < d.chosen.length && a.to === 'bench' && p.bench.length >= benchLimit(s, catalog, holder)) {
        // Earlier entry effects may fill the remaining spaces. Return reserved,
        // unplaced cards instead of losing them or silently exceeding the Bench.
        for (const id of d.chosen.slice(d.index)) { remove(p.resolving, id); p[a.from].push(id); }
        prepend(s, tasks('effect-choice', { ...d, index: d.chosen.length })); return;
      }
      if (d.index >= d.chosen.length) {
        recordEffectCards(s, catalog, d, d.chosen);
        if (a.remainder) { cardsRemainder(s, catalog, d); return; }
        const shuffled = a.shuffleAfter && shuffleZone(s, holder, 'deck', source);
        finishEffect(s, catalog, d, d.performed || shuffled, d.chosen); return;
      }
      const id = d.chosen[d.index]; remove(p.resolving, id);
      const next = tasks('effect-choice', { ...d, index: d.index + 1, performed: true });
      if (a.to === 'active') {
        // effects.deploy-active: the Active Spot the first part vacated is filled now, so no Pokémon is promoted to it.
        const m = newMon(s, id); p.active = m; s.vacancies[holder] = null;
        log(s, 'effects.deploy', { player: holder, from: a.from, to: a.to, cardId: id, pokemonId: m.id, effectId: source.effectId });
        prepend(s, next);
      } else if (a.to === 'bench') {
        const m = newMon(s, id); p.bench.push(m);
        log(s, 'effects.deploy', { player: holder, from: a.from, to: a.to, cardId: id, pokemonId: m.id, effectId: source.effectId });
        prepend(s, ...triggerWork(s, catalog, [makeTriggerEvent(s, catalog, 'bench', holder, m, {
          origin: a.from, cardId: id, cause: { kind: 'effect', source },
        })]), next);
      } else if (a.to === 'self') {
        // Put on this Pokémon by the effect, not played from the hand (no hand-only restriction, no 「从手牌」 fact).
        const m = findMon(s, source.pokemonId).m;
        m.tools.push(id);
        log(s, 'effects.tool-attach', { player: holder, from: a.from, pokemonId: m.id, cardId: id, effectId: source.effectId });
        prepend(s, next);
      } else {
        if (a.to === 'discard') discard(s, catalog, id); else if (a.to === 'lost') toLost(s, id); else p[a.to].push(id);
        if (a.to === 'discard' && a.from === 'hand') latchDiscarded(s, catalog, source, [id], 'hand');
        prepend(s, next);
      }
      return;
    }
    // effects.move-lock 「…不会受到…将牌库的卡牌放于弃牌区的效果影响」: not even a look at that deck (JP Q&A ビーダル × ミルホッグ「しなさだめ」).
    if (a.from === 'deck' && (a.to === 'discard' || a.remainder === 'discard') && deckLocked(s, catalog, source, holder)) {
      finishEffect(s, catalog, d, false); return;
    }
    const locked = ['bench', 'active'].includes(a.to) && a.from === 'hand' ? handLock(s, catalog, holder) : null;
    if (locked?.all) {
      log(s, 'effects.player-lock', { player: holder, skipped: 'hand', effectId: source.effectId });
      finishEffect(s, catalog, d, false); return;
    }
    // 「…「宝可梦道具」，放于这只宝可梦身上」: with no room for a Tool on this Pokémon (tools.capacity) nothing is looked through, as for a full Bench.
    const self = a.to === 'self' ? findMon(s, source.pokemonId) : null;
    if (a.to === 'self' && !(self && toolRoom(s, catalog, self.m))) {
      log(s, 'effects.tool-attach', { player: holder, skipped: 'no-room', effectId: source.effectId });
      finishEffect(s, catalog, d, false); return;
    }
    // effects.deploy-active: only into an empty Active Spot.
    if (a.to === 'active') {
      requireRule(catalog.ruleset, 'effects.deploy-active');
      if (p.active) { finishEffect(s, catalog, d, false); return; }
    }
    // C-11: a full Bench prevents looking through the deck at all.
    const limit = a.to === 'bench' ? benchLimit(s, catalog, holder) : null;
    if (a.to === 'bench' && p.bench.length >= limit) {
      log(s, 'effects.deploy', { player: holder, skipped: 'bench-full', effectId: source.effectId });
      finishEffect(s, catalog, d, false); return;
    }
    if (a.alternativeLimits && a.quantity.count !== alternativeTotal(a.alternativeLimits, a.exclusiveAlternatives))
      throw new EngineError('invalid-card-selection', 'Alternative limits fix the total a cards move may take.');
    const paid = a.excludePaid ? (d.payment?.groups ?? []).flatMap((g) => g.cardIds) : [];
    const entering = ['bench', 'active'].includes(a.to), locks = entering ? enterLocks(s, catalog, holder, sourceModel(s, catalog)) : null;
    // pokemon.item-card: an Item put onto the Active Spot is played as an Item, so an Item lock stops it (JP Q&A ピッピ「にんぎょうへんげ」).
    const itemLocked = (id) => a.to === 'active' && !!cardDef(s, catalog, id).mechanics.itemCard && playerProhibited(s, catalog, holder, 'playItem');
    // selection.context 「与对手场上宝可梦相同属性的」: the types or names read now (nothing to read: no card matches).
    const selector = contextSelector(s, catalog, source, d.event ?? null, a.selector);
    const among = amongCards(a), window = cardWindow(s, a, source), pool = window.filter((id) => !paid.includes(id) && !!selector && !locked?.card(id) &&
      (!among || among.includes(id)) && matchesCardsMove(cardDef(s, catalog, id), { ...a, selector }) && (!entering || enterAllowed(s, catalog, id, source, locks)) &&
      !itemLocked(id));
    const available = a.to === 'bench' ? Math.min(pool.length, limit - p.bench.length) : pool.length;
    // 「选择自己的1张手牌，将剩余的手牌全部放于弃牌区」: the kept cards are the ones not chosen.
    const quantity = a.quantity.kind === 'leave' ? { kind: 'exact', count: Math.max(0, pool.length - a.quantity.count) } : a.quantity;
    // Keeping every card still chose the kept ones (「选择自己的1张手牌」 was done): a following 「然后」 part runs (II.E-19).
    if (!quantity.count && quantity.kind === 'exact' && !d.selected) {
      recordEffectCards(s, catalog, d, []); finishEffect(s, catalog, d, a.quantity.kind === 'leave' && pool.length > 0, []); return;
    }
    const bounds = selectionBounds({ ...quantity, available,
      zone: a.from === 'deck' ? 'deck' : a.from === 'hand' ? 'ownHand' : 'public', filter: selectorQuantityClass(a.selector) });
    // 「将对手牌库上方5张卡牌翻到正面，选择其中…」: both players see every looked-at card before the choice (effects.reveal).
    if (a.revealAll && !d.selected && window.length) log(s, 'effects.reveal', { player: holder, from: 'deck', cardIds: [...window].reverse(),
      cards: [...window].reverse().map((id) => clone(s.cards[id])), effectId: source.effectId });
    if (d.selected) {
      const selected = d.stage === 'cards-empty' ? [] : d.selected;
      if (!canSelectCount(bounds, selected.length) || selected.some((id) => !pool.includes(id)) ||
          a.onePerAlternative && !matchesOnePerAlternative(selected.map((id) => cardDef(s, catalog, id)), a.selector) ||
          a.alternativeLimits && !matchesAlternativeLimits(selected.map((id) => cardDef(s, catalog, id)), a.selector,
            a.alternativeLimits, a.exclusiveAlternatives) ||
          a.distinct && !distinctCards(selected.map((id) => cardDef(s, catalog, id)), a.distinct))
        throw new EngineError('invalid-card-selection', 'Selected cards do not match the reviewed source, predicate or quantity.');
      // effects.move-lock: a chosen card that cannot go there stays in the discard pile (JP Q&A リククラゲ × ネモのリュック).
      const kept = a.from === 'discard' ? keptCards(s, catalog, source, selected, { zone: 'discard', to: a.to, holder }) : [];
      const moving = selected.filter((id) => !kept.includes(id));
      for (const id of moving) { remove(p[a.from], id); p.resolving.push(id); }
      const ruleId = ['bench', 'active'].includes(a.to) ? 'effects.deploy' : a.from === 'deck' ? 'effects.search' : a.to === 'discard' ? 'effects.discard' :
        a.to === 'lost' ? 'zones.lost-zone' : a.to === 'prizes' ? 'prizes.zone' : 'effects.return';
      log(s, ruleId, { player: owner, from: a.from, to: a.to, count: moving.length, effectId: source.effectId,
        ...(a.reveal ? { revealed: moving.map((id) => clone(s.cards[id])) } : {}) });
      if (!a.reveal && moving.length) log(s, ruleId, { effectId: source.effectId, selected: [...moving] }, owner);
      prepend(s, tasks('effect-choice', { ...withoutSelection(d), stage: 'cards-move', lookedAt: window,
        chosen: moving, index: 0, performed: moving.length > 0 }));
    } else if (a.from === 'deck' && window.length && !pool.length)
      ask(s, { player: owner, kind: 'view-cards', options: ['confirm'], resume: 'effect-choice',
        data: { ...d, stage: 'cards-empty', lookedAt: window }, ruleId: 'effects.search' });
    else if (pool.length) {
      const hidden = selectorQuantityClass(a.selector) === 'specific';
      const ruleId = a.from === 'deck' && hidden ? 'selection.hidden' : a.from === 'hand' && hidden ? 'selection.hand' :
        { exact: 'selection.exact', leave: 'selection.exact', upTo: 'selection.up-to', any: 'selection.any', all: 'selection.all' }[a.quantity.kind];
      // 「将自己牌库上方5张卡牌翻成正面，让对手选择其中2张卡牌」: shown to both players; the opponent chooses.
      if (a.chooser) log(s, 'effects.reveal', { player: owner, from: 'deck', cardIds: [...window], cards: window.map((id) => clone(s.cards[id])),
        effectId: source.effectId });
      ask(s, { player: a.chooser ? 1 - owner : owner, kind: ['deckTop', 'deckBottom'].includes(a.to) && bounds.maximum > 1 ? 'order-cards' : 'select-cards',
        options: pool, ...bounds, resume: 'effect-choice', data: { ...d, stage: 'cards-select', lookedAt: window }, ruleId });
    } else {
      recordEffectCards(s, catalog, d, []);
      const shuffled = a.shuffleAfter && shuffleZone(s, holder, 'deck', source);
      finishEffect(s, catalog, d, shuffled, []);
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
    // 「选择其中1张卡牌，放回牌库上方。将剩余的卡牌，放回牌库下方」: the chosen card(s) to one end, the rest (in the user's order) to the other.
    const split = (chosen, rest) => {
      const others = p.deck.filter((id) => !window.includes(id)), up = (ids) => [...ids].reverse();
      p.deck = a.to === 'top' ? [...up(rest), ...others, ...up(chosen)] : [...up(chosen), ...others, ...up(rest)];
      log(s, 'effects.deck-order', { player: deckOwner, from: a.from, count: window.length, effectId: source.effectId, result: a.to, rest: a.rest });
      finishEffect(s, catalog, d, true);
    };
    // The answers are exactly the offered cards (the looked-at cards; then all the rest, in order).
    if (d.stage === 'arrange-split') {
      const rest = window.filter((id) => !d.selected.includes(id));
      if (rest.length > 1) ask(s, { player: owner, kind: 'order-cards', options: rest, minimum: rest.length, maximum: rest.length,
        resume: 'effect-choice', data: { ...data, stage: 'arrange-rest', chosen: [...d.selected] }, ruleId: 'effects.deck-order' });
      else split(d.selected, rest);
      return;
    }
    if (d.stage === 'arrange-rest') { split(d.chosen, d.selected); return; }
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
    if (a.unseen) {
      // 「在不看正面的前提下，将对手牌库上方的1张卡牌，放回对手的牌库下方」: nobody looks; the card goes to the other end.
      const others = p.deck.filter((id) => !window.includes(id));
      p.deck = a.to === 'bottom' ? [...window, ...others] : [...others, ...window];
      log(s, 'effects.deck-order', { player: deckOwner, from: a.from, count: window.length, unseen: true, effectId: source.effectId, result: a.to });
      finishEffect(s, catalog, d, true); return;
    }
    log(s, 'effects.deck-order', { player: deckOwner, from: a.from, looked: window.length, effectId: source.effectId });
    log(s, 'effects.deck-order', { effectId: source.effectId, cards: [...window] }, owner);
    if (a.otherwise) ask(s, { player: owner, kind: 'arrange-choice', options: ['arrange', a.otherwise], resume: 'effect-choice',
      data: { ...data, stage: 'arrange-choice' }, ruleId: 'effects.deck-order' });
    else if (a.choose && window.length > a.choose) ask(s, { player: owner, kind: 'select-cards', options: [...window], minimum: a.choose, maximum: a.choose,
      resume: 'effect-choice', data: { ...data, stage: 'arrange-split' }, ruleId: 'effects.deck-order' });
    else order(data);
    return;
  }
  if (a.op === 'opponentHand') {
    const foe = 1 - owner, hand = [...s.players[foe].hand];
    if (d.stage === 'hand-view') { recordEffectCards(s, catalog, d, d.lookedAt); finishEffect(s, catalog, d, true); return; }
    const { pool, bounds } = opponentHandWindow(s, catalog, a, foe, source);
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
      // 「查看其正面。如果该卡牌是支援者的话，则放于弃牌区。如果不是支援者的话，则放回手牌」: only picked cards of the printed kind move.
      moveFromOpponentHand(s, catalog, d, foe, picked.filter((id) => matchesCardsMove(cardDef(s, catalog, id), a))); return;
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
    // 「将选择的卡牌以任意顺序重新排列后，放回对手的牌库下方」: several go in the order chosen, the first chosen uppermost.
    ask(s, { player: a.mode === 'look' ? owner : foe, kind: a.to === 'deckBottom' && bounds.maximum > 1 ? 'order-cards' : 'select-cards',
      options: pool, ...bounds, resume: 'effect-choice', data: { ...data, stage: 'hand-select' }, ruleId: 'effects.opponent-hand' });
    return;
  }
  if (a.op === 'copySupporter') {
    // effects.copy-supporter: 1 Supporter where the text says (the opponent's hand after a look, if wished; the user's own
    // hand, II.E-33; the opponent's discard pile); then its own use runs as this card's or attack's effect.
    const holder = copyHolder(owner, a), zone = s.players[holder][copyZone(a)];
    const pool = zone.filter((id) => cardDef(s, catalog, id).mechanics.category === 'supporter');
    const bounds = selectionBounds({ kind: 'exact', count: 1, available: pool.length, zone: a.from === 'ownHand' ? 'ownHand' : 'public',
      filter: 'specific', optional: a.from === 'opponentHand' });
    // The JP rulings answer a copied hand-size condition by its printed wording, which the recorded count cannot tell apart;
    // a card left in a hand may have a changed effect without that condition (effects.supporter-replacement).
    const unresolved = (id) => readsOwnHand(cardDef(s, catalog, id).mechanics.condition) && (a.discard || !supporterReplacement(s, catalog, id));
    if (d.stage === 'supporter-view') { finishEffect(s, catalog, d, true); return; }
    if (d.stage === 'supporter-select') {
      if (!canSelectCount(bounds, d.selected.length) || d.selected.some((id) => !pool.includes(id)))
        throw new EngineError('invalid-card-selection', 'The chosen Supporter must be one of that zone\'s Supporters.');
      const [id] = d.selected;
      if (!id) { finishEffect(s, catalog, d, a.from === 'opponentHand'); return; }
      if (unresolved(id)) throw new EngineError('unresolved-copy-condition', 'A copied hand-size use condition needs the card\'s own CN ruling.');
      // 「放于弃牌区。然后／在这种情况下，…」: the card goes to its owner's discard pile first; its effect is used from there.
      if (a.discard) { remove(zone, id); discard(s, catalog, id); }
      const copyId = `supporter${++s.serial}`;
      log(s, 'effects.copy-supporter', { kind: 'selected', id: copyId, source, reference: { instanceId: id }, discarded: a.discard });
      finishEffect(s, catalog, d, true);
      const request = activationRequest('copy', owner, id, { copyId });
      if (activationUsable(s, catalog, request)) beginActivation(s, catalog, request);
      else log(s, 'effects.copy-supporter', { kind: 'unused', id: copyId, player: owner });
      return;
    }
    if (a.from === 'opponentHand') {
      if (!zone.length) { finishEffect(s, catalog, d, false); return; }
      log(s, 'effects.opponent-hand', { effectId: source.effectId, player: holder, looked: zone.length });
      log(s, 'effects.opponent-hand', { effectId: source.effectId, cards: [...zone] }, owner);
    }
    const data = { ...d, lookedAt: [...zone] };
    if (!bounds.maximum) {
      // A look with no Supporter there still shows the hand.
      if (a.from === 'opponentHand') ask(s, { player: owner, kind: 'view-cards', options: ['confirm'], resume: 'effect-choice',
        data: { ...data, stage: 'supporter-view' }, ruleId: 'effects.copy-supporter' });
      else finishEffect(s, catalog, d, false);
      return;
    }
    // A required choice cannot be left without a Supporter whose use can be judged.
    if (!bounds.allowZero && pool.every(unresolved))
      throw new EngineError('unresolved-copy-condition', 'A copied hand-size use condition needs the card\'s own CN ruling.');
    ask(s, { player: owner, kind: 'copy-supporter', options: pool, ...bounds, resume: 'effect-choice',
      data: { ...data, stage: 'supporter-select' }, ruleId: 'effects.copy-supporter' });
    return;
  }
  if (a.op === 'discardTools') {
    // Holders protected from this effect offer no Tools to choose.
    const cards = toolCards(s, catalog, source, d.event ?? null, a)
      .filter((c) => !protections(s, catalog, source, c.owner, c.m, 'effects').length);
    // 「…「宝可梦道具」或「竞技场」」: the Stadium in play is one more card to choose, unless it is protected from this effect.
    const inPlay = a.stadium ? stadiumWindow(effectContext(s, catalog, source, d.event ?? null), ANY_STADIUM).target : null;
    const stadium = inPlay && !stadiumProtections(s, catalog, source).length ? inPlay : null;
    const pool = [...cards.map((c) => c.id), ...(stadium ? [stadium.instanceId] : [])];
    if (!pool.length) { recordEffectCards(s, catalog, d, []); finishEffect(s, catalog, d, false); return; }
    // 「选择对手的1只宝可梦，将…「宝可梦道具」和「特殊能量」各1张」: one to two cards; checked below against that one Pokémon.
    const bounds = selectionBounds(a.singleHolder ? { kind: 'upTo', count: 2, available: pool.length } : { ...a.quantity, available: pool.length });
    if (a.quantity.kind !== 'all' && !d.selected) {
      ask(s, { player: owner, kind: 'select-cards', options: pool, ...bounds, resume: 'effect-choice', data: d,
        ruleId: 'effects.tool-discard' });
      return;
    }
    const selected = a.quantity.kind === 'all' ? pool : d.selected, held = (id) => cards.find((c) => c.id === id);
    // II.D-04 「当要选择数种对象时，各自选择其指定的数量。如果…只有其中1种对象，则只选择…那个对象」: one of each kind that Pokémon holds.
    const eachKind = () => {
      const m = held(selected[0]).m, kinds = new Set(cards.filter((c) => c.m === m).map((c) => c.kind));
      return selected.every((id) => held(id).m === m) && [...kinds].every((kind) => selected.filter((id) => held(id).kind === kind).length === 1);
    };
    if (!canSelectCount(bounds, selected.length) || new Set(selected).size !== selected.length ||
        selected.some((id) => !pool.includes(id)) || a.singleHolder && !eachKind())
      throw new EngineError('invalid-card-selection', 'Selected Tools do not match the printed holders, kind or quantity.');
    const tools = selected.filter((id) => id !== stadium?.instanceId);
    for (const id of tools) {
      const { m, kind } = held(id);
      if (a.to === 'lost') toLost(s, id); else if (a.to === 'hand') s.players[s.cards[id].owner].hand.push(id); else discardFromPlay(s, catalog, id);
      remove(kind === 'tool' ? m.tools : m.energy, id);
    }
    if (tools.length) log(s, a.to === 'hand' ? 'effects.tool-return' : 'effects.tool-discard', { effectId: source.effectId, cards: [...tools], ...(a.to ? { to: a.to } : {}) });
    const chosen = stadium && selected.includes(stadium.instanceId);
    if (chosen) {
      const before = counterLethalFacts(s, catalog);
      s.stadium = null;
      const destination = a.to === 'lost' ? (toLost(s, stadium.instanceId), 'lost') : discard(s, catalog, stadium.instanceId);
      settleCounterProperties(s, catalog, before, source);
      log(s, 'effects.stadium-discard', { subject: stadium, destination, performed: true, effectId: source.effectId, sourceOfTruth: source.sourceOfTruth });
    }
    recordEffectCards(s, catalog, d, selected);
    finishEffect(s, catalog, d, selected.length > 0);
    if (chosen) prepend(s, tasks('bench-trim', { order: [stadium.owner, 1 - stadium.owner] }));
    return;
  }
  if (['discardEnergy', 'moveEnergy', 'returnEnergy'].includes(d.action.op)) {
    const ctx = effectContext(s, catalog, source, d.event ?? null, false, null, false, d.entry ?? null, d.payment ?? null);
    const a = energyAction(d), pool = attachedEnergyPool(ctx, a);
    if (d.stage === 'energy-apply') {
      const plan = d.energyPlan, chosen = plan.chosen.map((c) => pool.find((p) => p.instanceId === c.instanceId && p.originId === c.originId));
      if (chosen.some((c) => !c)) throw new EngineError('invalid-energy-plan', 'Selected Energy no longer belongs to its original Pokémon.');
      const verdict = energyChoice(s, catalog, pool, a, chosen.map((c) => c.instanceId));
      if (!verdict.valid) throw new EngineError(verdict.unsupported ? 'unresolved-energy-quantity' : 'invalid-energy-plan', 'Invalid or unresolved Energy quantity.');
      const changes = chosen.map((c) => {
        const origin = findMon(s, c.originId), targetId = plan.assignments.find((x) => x.instanceId === c.instanceId)?.targetId;
        const target = a.op === 'moveEnergy' ? findMon(s, targetId) : null;
        if (a.op === 'moveEnergy' && (!target || target.owner !== c.owner || !energyRecipients(ctx, a, [c]).some((m) => m.id === targetId)))
          throw new EngineError('invalid-energy-plan', 'Energy must transfer to an eligible different Pokémon of its own holder.');
        // effects.move-lock: an Energy that cannot go there stays attached (JP Q&A ヨクバリス × エール団のしたっぱ).
        const blocked = effectBlocked(s, catalog, source, c.owner, origin.m) ||
          !!target && effectBlocked(s, catalog, source, target.owner, target.m) || !target && keptCards(s, catalog, source, [c.instanceId],
            { zone: 'field', to: a.op === 'discardEnergy' ? 'discard' : a.to, holder: origin.owner, pokemon: origin.m }).length > 0;
        return { c, origin, target, blocked };
      });
      // 「放回牌库上方」: the first chosen ends uppermost; 「下方」: the last chosen ends lowest.
      for (const { c, origin, target, blocked } of a.to === 'deckTop' ? [...changes].reverse() : changes) if (!blocked) {
        if (a.op === 'discardEnergy') discardFromPlay(s, catalog, c.instanceId, source);
        remove(origin.m.energy, c.instanceId);
        if (target) target.m.energy.push(c.instanceId);
        else if (a.op === 'returnEnergy' && a.to === 'deckBottom') s.players[c.owner].deck.unshift(c.instanceId);
        else if (a.op === 'returnEnergy' && a.to === 'lost') toLost(s, c.instanceId);
        else if (a.op === 'returnEnergy') s.players[c.owner][a.to === 'hand' ? 'hand' : 'deck'].push(c.instanceId);
      }
      enforceEnergyRetention(s, catalog);
      const events = [];
      for (const { c, origin, target, blocked } of changes) if (!blocked) {
        log(s, target ? 'energy.move' : a.to === 'lost' ? 'zones.lost-zone' : a.op === 'returnEnergy' ? 'energy.return' : 'energy.attached-selection', { energyId: c.instanceId,
          from: origin.m.id, to: target?.m.id ?? (a.op === 'returnEnergy' ? a.to : null),
          discarded: a.op !== 'returnEnergy' && (!target || !target.m.energy.includes(c.instanceId)),
          effectId: source.effectId, sourceOfTruth: source.sourceOfTruth });
        if (target) events.push(makeTriggerEvent(s, catalog, 'energyMoved', target.owner, target.m, {
          origin: 'field', cardId: c.instanceId, cause: { kind: 'effect', source },
        }));
      }
      if (a.op === 'returnEnergy' && a.to === 'deckShuffle' && changes.some((c) => !c.blocked))
        shuffleZone(s, changes.find((c) => !c.blocked).c.owner, 'deck', source);
      const done = changes.filter((c) => !c.blocked);
      recordEffectCards(s, catalog, d, done.map((c) => c.c.instanceId),
        countsUnits(executionBinding(s, catalog, d.source)) ? done.reduce((n, c) => n + c.c.amount, 0) : null);
      finishEffect(s, catalog, d, changes.some((c) => !c.blocked), changes.filter((c) => !c.blocked).map((c) => c.c.instanceId));
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
      const verdict = energyChoice(s, catalog, pool, a, d.selected);
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
      const available = pool.reduce((n, c) => n + c.amount, 0), holders = new Set(pool.map((c) => c.originId)).size;
      const bounds = selectionBounds({ ...a.quantity, available });
      ask(s, { player: a.chooser === 'holder' ? energyHolder(a, source) : owner, kind: 'attached-energy',
        options: pool.map((c) => c.instanceId), minimum: a.perPokemon ? holders : a.quantity.kind === 'all' ? pool.length : a.measure === 'units' ? Math.min(1, bounds.minimum) : bounds.minimum,
        maximum: a.perPokemon ? holders : a.measure === 'units' ? pool.length : Math.min(pool.length, bounds.maximum), allowZero: bounds.allowZero,
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
    if (a.selection.kind === 'repeat') {
      // 「选择N次对手的宝可梦，…造成被选择次数×X伤害（同1只宝可梦可以选择多次）」: N single picks, then one packet per picked Pokémon.
      const picks = [...(d.picks ?? []), ...(d.selected ?? [])];
      if (picks.some((id) => !pool.some((m) => m.id === id))) throw new EngineError('invalid-damage-target', 'A damage target no longer matches.');
      if (picks.length < a.selection.count) {
        ask(s, { player: owner, kind: 'damage-targets', options: pool.map((m) => m.id), minimum: 1, maximum: 1,
          resume: 'effect-choice', data: { ...withoutSelection(d), ...(picks.length ? { picks } : {}) }, ruleId: 'attack.order' });
        return;
      }
      const ids = [...new Set(picks)];
      finishEffect(s, catalog, d, dealAttackDamage(s, catalog, source, ids.map((id) => ({ owner: targetOwner, m: pool.find((m) => m.id === id) })),
        ids.map((id) => a.amount * picks.filter((x) => x === id).length), a.options));
      return;
    }
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
    // 「对手选择对手自己的1只宝可梦。给该宝可梦造成…伤害」: the opponent picks among their own (attack.opponent-target).
    else ask(s, { player: a.chooser === 'opponent' ? 1 - owner : owner, kind: 'damage-targets', options: pool.map((m) => m.id), ...bounds,
      resume: 'effect-choice', data: d, ruleId: a.chooser === 'opponent' ? 'attack.opponent-target' : 'attack.order' });
    return;
  }
  if (a.op === 'takePrizes') {
    // prizes.take-effect: as many as remain, one choice at a time; the last one wins at the next boundary (I.E).
    const remaining = s.players[owner].prizes.length;
    log(s, 'prizes.take-effect', { player: owner, count: Math.min(a.count, remaining), effectId: source.effectId, sourceOfTruth: source.sourceOfTruth });
    finishEffect(s, catalog, d, remaining > 0);
    if (remaining) prepend(s, tasks('award', { player: owner, count: a.count }));
    return;
  }
  if (a.op === 'extraPrizes') {
    // ko.prize-modifier: a bonus for this attack's own damage, read when its Knock Outs are processed this turn.
    const { op: _op, ...filters } = a;
    const entry = createPlayerOngoingEffect({ id: `e${++s.serial}`, player: owner, source, duration: 'thisTurn', effect: {
      op: 'prizeBonus', ...filters, attack: { instanceId: source.instanceId, pokemonId: source.pokemonId,
        attackId: source.attackId, copyId: source.copyId ?? null } } }, s);
    s.playerOngoing.push(entry);
    log(s, 'ko.prize-modifier', { player: owner, effectId: entry.id, count: a.count, sourceOfTruth: source.sourceOfTruth });
    finishEffect(s, catalog, d, true); return;
  }
  if (a.op === 'lastingPlayer') {
    // 「如果这只宝可梦离开战斗场的话，则这个效果消除」: only an effect begun by the Active Pokémon can end when it leaves.
    if (a.clearOnLeaveActive && s.players[owner].active?.id !== source.pokemonId)
      throw new EngineError('unsupported-leave-active', 'An effect ending when its user leaves the Active Spot needs that user in the Active Spot.');
    // effects.player-ability-removal: the opponent's Active Pokémon protected from this effect now is not affected while it stays there;
    // one that comes into the Active Spot later is (its own protecting Ability is already removed, JP Q&A キャンセルコロン × キバゴ).
    const opposing = s.players[1 - owner].active, exempt = a.effect.op === 'suppression' &&
      effectBlocked(s, catalog, source, 1 - owner, opposing) ? opposing.id : null;
    if (a.effect.op === 'suppression') requireRule(catalog.ruleset, 'effects.player-ability-removal');
    const entry = createPlayerOngoingEffect({ id: `e${++s.serial}`, player: a.side === 'own' ? owner : 1 - owner,
      source, effect: a.effect, duration: a.duration, clearOnLeaveActive: a.clearOnLeaveActive, exemptId: exempt }, s);
    s.playerOngoing.push(entry);
    log(s, entry.effect.op === 'playerRestriction' ? 'effects.player-lock' : entry.ruleId, { player: entry.player, effectId: entry.id,
      sourceOfTruth: source.sourceOfTruth });
    finishEffect(s, catalog, d, true); return;
  }
  if (['attachDiscard', 'attachHand'].includes(a.op)) {
    // 「选择对手弃牌区中最多3张能量，以任意方式附着于对手的宝可梦身上」: the opponent's cards onto the opponent's Pokémon, the user choosing;
    // a Pokémon protected from this effect cannot receive them.
    const holder = a.side === 'opponent' ? 1 - owner : owner, p = s.players[holder];
    const zone = a.op === 'attachHand' ? 'hand' : 'discard', model = sourceModel(s, catalog), locked = zone === 'hand' ? handLock(s, catalog, owner) : null;
    // Printed recipients: this Pokémon only, a tagged/typed predicate, and per-card distribution.
    let targets = (a.benchOnly ? p.bench : mons(p)).filter((m) => (a.target !== 'self' || m.id === source.pokemonId) &&
      (holder === owner || !protections(s, catalog, source, holder, m, 'effects').length) &&
      (a.target !== 'active' || m === p.active) && (zone !== 'hand' || !monProhibited(s, catalog, owner, m, 'attachFromHand') && !locked.all) &&
      (!a.recipient || matchesInPlaySelector(monDef(s, catalog, m), a.recipient, model.pokemon[m.id].types)) &&
      (!a.spareKnockOut || hp(s, catalog, owner, m) - m.counters * 10 > a.recipientEffect.counters * 10) &&
      (!boundPokemon(d) || boundPokemon(d).includes(m.id)));
    if (d.stage === 'target' && a.distribution === 'separateRecipients') targets = targets.filter((m) => !(d.chosen ?? []).includes(m.id));
    if (d.stage === 'target' && a.distribution === 'singleRecipient' && d.chosen?.length) targets = targets.filter((m) => m.id === d.chosen[0]);
    // 「各附着2张」: a recipient that already received count cards of this effect takes no more.
    if (d.stage === 'target' && a.distribution === 'perRecipient') targets = targets.filter((m) => (d.recipients ?? []).filter((id) => id === m.id).length < a.count);
    if (!targets.length) { finishEffect(s, catalog, d, d.performed ?? false, (d.energies ?? []).slice(0, d.index ?? 0)); return; }
    if (d.stage === 'target') {
      const energy = d.energies[d.index];
      if (!energy) { finishEffect(s, catalog, d, d.performed ?? false, d.energies.slice(0, d.index)); return; }
      if (d.selected) {
        const m = targets.find((m) => m.id === d.selected[0]);
        if (!m) throw new EngineError('invalid-target', 'Invalid Energy recipient.');
        remove(p.lost.includes(energy) ? p.lost : p[zone], energy); m.energy.push(energy);
        log(s, 'turn.energy', { player: owner, pokemonId: m.id, cardId: energy, byEffect: source.effectId });
        // 「然后，回复那只宝可梦…HP」／「在被附着的宝可梦身上放置…伤害指示物」: the recipient, right after its card.
        if (a.recipientEffect?.counters) {
          addCounters(s, catalog, owner, m, a.recipientEffect.counters, { kind: 'effect', source });
          log(s, 'damage.counters', { targetId: m.id, effectId: source.effectId, sourceOfTruth: source.sourceOfTruth, operation: 'counters' });
        } else if (a.recipientEffect) healBy(s, catalog, owner, m, a.recipientEffect.heal, source);
        // II.C-10 FAQ2: a Special Energy attached where it cannot stay is put into the discard pile.
        enforceEnergyRetention(s, catalog);
        const event = makeTriggerEvent(s, catalog, 'energyAttached', holder, m,
          { origin: zone, cardId: energy, cause: { kind: 'effect', source } });
        const chosen = a.distribution === 'perRecipient' ? { recipients: [...(d.recipients ?? []), m.id] } :
          a.distribution && !(d.chosen ?? []).includes(m.id) ? { chosen: [...(d.chosen ?? []), m.id] } : {};
        prepend(s, ...triggerWork(s, catalog, [event]),
          tasks('effect-choice', { ...withoutSelection(d), ...chosen, index: d.index + 1, performed: true }));
      } else if (a.target || a.distribution === 'singleRecipient' && d.chosen?.length)
        prepend(s, tasks('effect-choice', { ...d, selected: [targets[0].id] }));
      else ask(s, { player: owner, kind: 'energy-recipient', options: targets.map((m) => m.id), resume: 'effect-choice', data: d, ruleId: 'energy.units' });
    } else if (d.selected) {
      prepend(s, tasks('effect-choice', { ...withoutSelection(d), stage: 'target', energies: d.selected, index: 0 }));
    } else {
      // cards.prism-star: a ◇ card the first part put into the discard pile went to the Lost Zone instead; it is still that card
      // (JP Q&A ズガドーンGX「バーストGX」, サイトウ).
      const among = amongCards(a), options = [...p[zone], ...(among && zone === 'discard' ? p.lost.filter((id) => among.includes(id)) : [])]
        .filter((id) => (!among || among.includes(id)) && effectAttachable(cardDef(s, catalog, id), a, zone) && !locked?.card(id));
      if (!options.length) { finishEffect(s, catalog, d, false); return; }
      // II.D-04 「N张」: exactly N when printed so (`exact`), II.D-02 「任意数量」 none or more, else II.D-05 「最多N张」.
      const bounds = selectionBounds({ kind: a.anyNumber ? 'any' : a.exact ? 'exact' : 'upTo', count: a.distribution === 'separateRecipients' ? Math.min(a.count, targets.length) :
        a.distribution === 'perRecipient' ? a.count * targets.length : a.count,
        available: options.length, optional: a.optional, zone: zone === 'hand' ? 'ownHand' : 'public' });
      ask(s, { player: owner, kind: zone === 'hand' ? 'hand-energy' : 'discard-energy', options, ...bounds,
        resume: 'effect-choice', data: d, ruleId: zone === 'hand' ? 'selection.hand' : a.anyNumber ? 'selection.any' : a.exact ? 'selection.exact' : 'selection.up-to' });
    }
  } else if (a.op === 'transferCounters') {
    const sides = (side) => side === 'both' ? [owner, 1 - owner] : [side === 'opponent' ? 1 - owner : owner];
    const model = a.originSelector || a.targetSelector ? sourceModel(s, catalog) : null;
    const destinations = (originId) => sides(a.side).flatMap((o) => mons(s.players[o]).filter((m) =>
      m.id !== originId && (a.target !== 'active' || m === s.players[o].active) && (a.target !== 'self' || m.id === source.pokemonId) &&
      (!a.targetSelector || pokemonMatches(s, catalog, model, m, { selector: a.targetSelector }))));
    const take = (m, removed) => {
      m.counters -= removed;
      if (m.counters * 10 < hp(s, catalog, findMon(s, m.id).owner, m)) delete m.facts.knockoutCause;
    };
    const removeTransferred = (m, removed) => {
      take(m, removed);
      prepend(s, tasks('effect-choice', { ...withoutSelection(d), stage: 'transfer-target', originId: m.id, removed }));
    };
    // 「任意数量…」: after each counter, the player picks the next origin or stops.
    const again = (moved) => { const { stage, originId, removed, ...rest } = withoutSelection(d);
      prepend(s, tasks('effect-choice', { ...rest, ...(moved ? { performed: true, transferred: (d.transferred ?? 0) + moved } : {}) })); };
    if (d.stage === 'transfer-count') {
      // II.D-05 「最多N个」: any number from 1 to N of the origin's counters.
      const m = findMon(s, d.originId).m, counts = Array.from(
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
        // 「以任意方式」: one counter per destination choice.
        const placed = a.split ? 1 : d.removed, to = findMon(s, m.id).owner;
        if (!effectBlocked(s, catalog, source, to, m, true)) {
          addCounters(s, catalog, to, m, placed, { kind: 'effect', source });
        }
        // II.C-08: protection of the destination does NOT restore the removed counters.
        log(s, 'damage.counters', { effectId: source.effectId, from: d.originId, to: m.id, removed: placed });
        if (placed < d.removed) prepend(s, tasks('effect-choice', { ...withoutSelection(d), removed: d.removed - placed }));
        else if (a.quantity === 'any') again(1);
        else finishEffect(s, catalog, d, true);
      } else ask(s, { player: owner, kind: 'counter-destination', options: pool.map((m) => m.id),
        resume: 'effect-choice', data: d, ruleId: 'damage.counters' });
    } else {
      const pool = sides(a.originSide ?? 'own').flatMap((o) => mons(s.players[o]).filter((m) => m.counters > 0 &&
        (a.from !== 'self' || m.id === source.pokemonId) && (a.from !== 'active' || m === s.players[o].active) &&
        (a.from !== 'bench' || m !== s.players[o].active) &&
        (!a.originSelector || pokemonMatches(s, catalog, model, m, { selector: a.originSelector })) && destinations(m.id).length > 0));
      // 「将自己所有宝可梦身上放置的全部伤害指示物／伤害指示物各N个，转放于…」: every origin at once, then one destination.
      if (a.from === 'every') {
        if (!pool.length) { finishEffect(s, catalog, d, false); return; }
        const amounts = pool.map((m) => a.each ? Math.min(a.count, m.counters) : m.counters);
        pool.forEach((m, i) => take(m, amounts[i]));
        prepend(s, tasks('effect-choice', { ...withoutSelection(d), stage: 'transfer-target', originId: pool[0].id,
          removed: amounts.reduce((n, k) => n + k, 0) }));
        return;
      }
      if (d.selected?.length) {
        const m = pool.find((m) => m.id === d.selected[0]);
        if (!m) throw new EngineError('invalid-target', 'Invalid counter transfer origin.');
        if (effectBlocked(s, catalog, source, findMon(s, m.id).owner, m)) {
          if (a.quantity === 'any') again(0); else finishEffect(s, catalog, d, false);
          return;
        }
        if (a.quantity === 'upTo' && Math.min(a.count, m.counters) > 1) {
          prepend(s, tasks('effect-choice', { ...withoutSelection(d), stage: 'transfer-count', originId: m.id })); return;
        }
        removeTransferred(m, a.quantity === 'all' ? m.counters : a.quantity === 'any' ? 1 : Math.min(a.count, m.counters));
      } else if (pool.length && !d.selected && !(a.quantity === 'any' && a.count <= d.transferred)) ask(s, { player: owner, kind: 'counter-origin', options: pool.map((m) => m.id),
        ...(a.quantity === 'any' ? { minimum: 0 } : {}), resume: 'effect-choice', data: d, ruleId: 'damage.counters' });
      else finishEffect(s, catalog, d, d.performed ?? false);
    }
  } else if (a.op === 'draw') prepend(s, tasks('draw-cards', {
    player: a.player ?? owner, drawn: 0, reason: 'effect', source, completion: d, ...(a.bottom ? { bottom: true } : {}),
    remaining: a.untilHand === undefined ? a.count : Math.max(0, a.untilHand - s.players[a.player ?? owner].hand.length),
  }));
  else if (a.op === 'discardHand') {
    const p = s.players[a.player ?? owner], discarded = p.hand.splice(0);
    for (const id of discarded) discard(s, catalog, id);
    latchDiscarded(s, catalog, source, discarded, 'hand');
    log(s, 'effects.discard', { player: a.player ?? owner, effectId: source.effectId });
    finishEffect(s, catalog, d, discarded.length > 0);
  } else if (a.op === 'knockOut') {
    // I.D: confirmed with every other Knock Out at the end of this effect, not by HP. Another Pokémon protected
    // from this effect is not affected (II.C-17); 「选择…N只」 is the user's choice among the matching ones.
    const targetOwner = a.target === 'self' || a.side !== 'opponent' ? owner : 1 - owner, model = sourceModel(s, catalog);
    // 「从双方场上所有宝可梦中」: either player's Pokémon; 「除这只宝可梦外」: never this one.
    let pool = (a.side === 'both' ? [owner, 1 - owner] : [targetOwner]).flatMap((o) => targetedPokemon(s, o, source, d.event ?? null, a.target))
      .filter((m) => pokemonMatches(s, catalog, model, m, a) && !(a.excludeSelf && m.id === source.pokemonId));
    // effects.knockout-lowest 「选择1只剩余HP最少的宝可梦」 (II.D-16): only those with the least remaining HP; the user picks one of a tie.
    if (a.lowestRemainingHp) {
      const left = pool.map((m) => hp(s, catalog, findMon(s, m.id).owner, m) - m.counters * 10);
      pool = pool.filter((_, i) => left[i] === Math.min(...left));
    }
    const count = Math.min(a.count ?? 1, pool.length);
    if (!d.selected && a.count && count) {
      ask(s, { player: owner, kind: 'effect-target', options: pool.map((m) => m.id), minimum: count, maximum: count,
        resume: 'effect-choice', data: d, ruleId: 'effects.knockout' });
      return;
    }
    const chosen = d.selected ? d.selected.map((id) => pool.find((m) => m.id === id)) : pool.slice(0, count);
    if (chosen.length !== count || chosen.some((m) => !m)) throw new EngineError('invalid-effect-target', 'Effect targets no longer match.');
    const knocked = [];
    for (const m of chosen) if (a.target === 'self' || !effectBlocked(s, catalog, source, findMon(s, m.id).owner, m)) {
      // effects.knockout-after-damage: lethal counters already placed keep their cause (e.g. this attack's damage).
      m.facts.forcedKnockout = clone(m.facts.knockoutCause ?? { kind: 'effect', source }); knocked.push(top(m));
      log(s, 'effects.knockout', { player: findMon(s, m.id).owner, pokemonId: m.id, effectId: source.effectId });
    }
    recordEffectCards(s, catalog, d, knocked);
    finishEffect(s, catalog, d, knocked.length > 0);
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
  } else if (a.op === 'counters' && a.all) {
    // 「给对手所有的（…）宝可梦身上，各放置N个」: every matching Pokémon, no choice; 「…直到其剩余HP均变为「N」为止」: each to its own N.
    const targetOwner = a.side === 'opponent' ? 1 - owner : owner, pool = countersPool(s, catalog, source, a, targetOwner);
    let placed = false;
    // 「直到其各自身上放置有的伤害指示物数量变为原来的2倍为止」: each one's own count, every count read before any is placed.
    const values = a.value === undefined ? null : new Map(pool.map((m) => [m.id, counterValue(s, catalog, source, a.value, { owner: targetOwner, m })]));
    const countFor = (m) => values ? values.get(m.id) : a.untilRemainingHp === undefined ? a.count :
      Math.max(0, (hp(s, catalog, targetOwner, m) - m.counters * 10 - a.untilRemainingHp) / 10);
    for (const m of pool) if (countFor(m) && !effectBlocked(s, catalog, source, targetOwner, m, true)) {
      addCounters(s, catalog, targetOwner, m, countFor(m), { kind: 'effect', source }); placed = true;
      log(s, 'damage.counters', { targetId: m.id, effectId: source.effectId, sourceOfTruth: source.sourceOfTruth, operation: a.op });
    }
    finishEffect(s, catalog, d, placed);
  } else if (a.op === 'counters' && a.targets) {
    const targetOwner = a.side === 'opponent' ? 1 - owner : owner;
    const pool = countersPool(s, catalog, source, a, targetOwner), count = Math.min(a.targets, pool.length);
    if (!d.selected) {
      if (count) ask(s, { player: owner, kind: 'effect-target', options: pool.map((m) => m.id), minimum: count, maximum: count,
        resume: 'effect-choice', data: d, ruleId: 'damage.counters' });
      else finishEffect(s, catalog, d, false);
      return;
    }
    const chosen = d.selected.map((id) => pool.find((m) => m.id === id));
    if (chosen.length !== count || chosen.some((m) => !m)) throw new EngineError('invalid-effect-target', 'Effect targets no longer match.');
    let placed = false;
    for (const m of chosen) if (!effectBlocked(s, catalog, source, targetOwner, m, true)) {
      addCounters(s, catalog, targetOwner, m, a.count, { kind: 'effect', source }); placed = true;
      log(s, 'damage.counters', { targetId: m.id, effectId: source.effectId, sourceOfTruth: source.sourceOfTruth, operation: a.op });
    }
    finishEffect(s, catalog, d, placed);
  } else if (['counters', 'heal', 'condition', 'switch', 'lasting', 'delayedReaction'].includes(a.op)) {
    const targetOwner = a.side === 'event' ? d.event.owner : a.side === 'opponent' ? 1 - owner : owner;
    // 「选择自己的1只备战宝可梦，将与被选择的宝可梦身上放置的伤害指示物数量相同的伤害指示物，放置于…」: that Pokémon is chosen first.
    if (a.countFrom && !d.chosen) {
      const from = targetedPokemon(s, a.countFrom.side === 'opponent' ? 1 - owner : owner, source, null, a.countFrom.target);
      if (d.selected) {
        if (!from.some((m) => m.id === d.selected[0])) throw new EngineError('invalid-effect-target', 'The Pokémon the count is read from no longer matches.');
        prepend(s, tasks('effect-choice', { ...withoutSelection(d), chosen: [...d.selected] }));
      } else if (from.length) ask(s, { player: owner, kind: 'count-source', options: from.map((m) => m.id), resume: 'effect-choice', data: d,
        ruleId: 'effects.count-value' });
      else finishEffect(s, catalog, d, false);
      return;
    }
    let pool = targetedPokemon(s, targetOwner, source, d.event ?? null, a.op === 'switch' ? 'bench' : a.target);
    if (a.op === 'switch' && a.affected === 'source') pool = pool.filter((m) => m.id === source.pokemonId);
    if (a.op === 'switch' && (a.selector || a.state || a.activeSelector)) {
      const model = sourceModel(s, catalog), active = s.players[targetOwner].active;
      pool = pool.filter((m) => pokemonMatches(s, catalog, model, m, a));
      if (a.activeSelector && !(active && pokemonMatches(s, catalog, model, active, { selector: a.activeSelector }))) pool = [];
    }
    if (a.op === 'condition') pool = pool.filter((m) => m === s.players[targetOwner].active);
    // status.inherit 「会继承其【中毒】状态」: only a Poison the event Pokémon had at the event.
    if (a.inherit && d.event.snapshot.conditions.poison === null) pool = [];
    // 「回复自己1只【草】宝可梦…」: a heal's printed kind narrows its choice like a counter placement's.
    if (['counters', 'heal'].includes(a.op) && (a.targetSelector || a.targetState)) pool = countersPool(s, catalog, source, a, targetOwner);
    const bound = boundPokemon(d);
    if (bound) pool = pool.filter((m) => bound.includes(m.id));
    const healed = a.op === 'heal' && a.fromAttackDamage ? attackDamageToOpponentActive(s, source) / 10 : a.count;
    if (a.op === 'heal') pool = pool.filter((m) => healed > 0 && m.counters > 0 || a.cureAll && presentConditions(m.conditions).length > 0);
    if (a.op === 'switch' && !s.players[targetOwner].active) pool = [];
    if (d.selected) {
      const m = pool.find((m) => m.id === d.selected[0]);
      if (!m) throw new EngineError('invalid-effect-target', 'Effect target no longer matches.');
      const affected = a.op === 'switch' && a.affected === 'active' ? s.players[targetOwner].active : m;
      if (effectBlocked(s, catalog, source, targetOwner, affected, a.op === 'counters')) { finishEffect(s, catalog, d, false); return; }
      if (a.op === 'counters') {
        // II.D-16: 「直到其剩余HP变为N」 reads the remaining HP now; none are placed at N or less.
        const count = a.fromEventDamage ? eventDamageCounters(d.event) : a.countFrom ? counterValue(s, catalog, source, a.value, findMon(s, d.chosen[0])) :
          a.untilRemainingHp === undefined ? a.count : Math.max(0, (hp(s, catalog, targetOwner, m) - m.counters * 10 - a.untilRemainingHp) / 10);
        if (!count) { finishEffect(s, catalog, d, false); return; }
        addCounters(s, catalog, targetOwner, m, count, { kind: 'effect', source });
        // damage.effect-count: a counted placement records how many it placed, for this attack's later damage.
        if (source.category === 'attack' && countedEffect(catalog, executionBinding(s, catalog, source))) recordEffectCards(s, catalog, d, [], count);
      }
      if (a.op === 'heal') {
        healBy(s, catalog, targetOwner, m, healed * 10, source, false);
        // 「并恢复其全部特殊状态」: the same Pokémon, every Special Condition it has.
        const present = a.cureAll ? presentConditions(m.conditions) : [];
        if (present.length) {
          m.conditions = cureConditions(m.conditions, present);
          log(s, 'status.cure', { player: targetOwner, targetId: m.id, conditions: present, effectId: source.effectId });
        }
      }
      let conditionRule = 'status.exclusive';
      if (a.op === 'condition' && m === s.players[targetOwner].active &&
          immunities(s, catalog, targetOwner, m).some((e) => covers(e, a.condition))) conditionRule = 'status.immunity';
      else if (a.op === 'condition' && m === s.players[targetOwner].active) {
        const applied = applyCondition(m.conditions, a.condition, { ownerTurn: s.players[targetOwner].turns,
          poisonCounters: a.inherit ? d.event.snapshot.conditions.poison : a.poisonCounters ?? 1,
          ...(a.sleepCoins ? { sleepCoins: a.sleepCoins } : {}), ...(a.confusionCounters !== undefined ? { confusionCounters: a.confusionCounters } : {}) });
        m.conditions = applied.conditions; conditionRule = applied.trace.ruleId;
      }
      const outgoing = a.op === 'switch' ? s.players[targetOwner].active : null, left = outgoing && clone(outgoing.conditions);
      const incoming = a.op === 'switch' ? switchTo(s, targetOwner, m.id) : null;
      // 「然后，回复被换入备战区的宝可梦…HP」: the Pokémon that actually went to the Bench.
      if (a.outgoingHeal && outgoing?.counters) healBy(s, catalog, targetOwner, outgoing, a.outgoingHeal, source);
      if (a.ifDamageKnockedOut) requireRule(catalog.ruleset, 'effects.knockout-condition');
      // 「这个效果，一直持续到这只「X」离开战斗场」: only an effect begun by the Active Pokémon can end when it leaves.
      if (a.clearOnLeaveActive && s.players[owner].active?.id !== source.pokemonId)
        throw new EngineError('unsupported-leave-active', 'An effect ending when its user leaves the Active Spot needs that user in the Active Spot.');
      if (a.effect?.op === 'abilityGrant') requireRule(catalog.ruleset, 'ability.granted');
      // selection.context 「在那个回合结束前，这只宝可梦的属性变为和附着的「基本能量卡」相同」: the types read now; the same effect's
      // earlier change on this Pokémon gives way to the new one.
      const typed = a.op === 'lasting' && a.effect.typesFrom ? readTypes(effectContext(s, catalog, source, d.event ?? null), a.effect.typesFrom) : null;
      if (typed) s.ongoing = s.ongoing.filter((e) => !(e.targetId === m.id && e.source.effectId === source.effectId && e.effect.op === 'pokemonTypes'));
      if (a.op === 'lasting' || a.op === 'delayedReaction') s.ongoing.push(createOngoingEffect({
        id: `e${++s.serial}`, targetId: m.id, source, effect: typed ? { op: 'pokemonTypes', types: typed, scope: 'all' } : a.op === 'lasting' ? a.effect :
          { op: 'reaction', scope: 'all', trigger: a.trigger, program: a.program,
            priorEventIds: s.attack?.events.map((e) => e.id) ?? [] }, duration: a.duration,
        clearOnBench: a.clearOnBench, clearOnEvolution: a.clearOnEvolution, clearOnLeaveActive: a.clearOnLeaveActive,
        // effects.knockout-condition: in force once this attack's damage Knocks Out an opponent's Pokémon, from now on.
        ...(a.ifDamageKnockedOut ? { knockedOutBy: { attack: { instanceId: source.instanceId, pokemonId: source.pokemonId,
          attackId: source.attackId, copyId: source.copyId ?? null }, from: s.battleHistory.events.length } } : {}),
      }, s));
      log(s, a.op === 'counters' ? 'damage.counters' : a.op === 'condition' ? conditionRule : a.op === 'heal' ? 'effects.heal' :
        ['lasting', 'delayedReaction'].includes(a.op) ? s.ongoing.at(-1).ruleId : 'effects.switch',
        { targetId: m.id, effectId: source.effectId, sourceOfTruth: source.sourceOfTruth, operation: a.op });
      // damage.after-switch: the counted switch records the Pokémon that came in.
      if (incoming && source.category === 'attack' && countedEffect(catalog, executionBinding(s, catalog, source)))
        recordEffectCards(s, catalog, d, [top(incoming)]);
      // 「然后，选择被换入备战区的宝可梦身上附着的…」: a switch affected the Pokémon it moved to the Bench.
      finishEffect(s, catalog, d, true, null, [(outgoing ?? m).id]);
      if (incoming) prepend(s, ...becameActiveWork(s, catalog, targetOwner, incoming, { kind: 'effect', source }, outgoing, left));
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
  const current = monDef(s, catalog, m), allows = evolutionAllowances(s, catalog, player, m, current, def);
  return (evolutionRelation(current, def, 'ordinary') || allows.relation) && !monProhibited(s, catalog, player, m, 'evolveFromHand') &&
    (s.players[player].turns > 1 || allows.firstTurn) && (m.enteredTurn < s.turn || allows.sameTurn) && m.evolvedTurn < s.turn;
}
// 「即使是最初的自己的回合以及刚被放出的回合也可进行进化」「可以从手牌使出从「X」进化而来的卡牌，放于其身上进行进化」 (evolution.permission):
// what this Pokémon's own continuous effects allow it, beyond I.A-05.
function evolutionAllowances(s, catalog, player, m, current, def) {
  const out = { relation: false, firstTurn: false, sameTurn: false, heal: null };
  for (const entry of continuousEntries(s, catalog)) {
    const spec = entry.spec;
    if (spec.op !== 'evolutionPermission' || !entryTargets(s, catalog, entry, player, m)) continue;
    requireRule(catalog.ruleset, 'evolution.permission');
    if (spec.fromName && evolutionRelation({ ...current, nameKey: spec.fromName }, def, 'ordinary') &&
        (!spec.cardSelector || matchesCardSelector(def, spec.cardSelector))) { out.relation = true; if (spec.healBefore) out.heal ??= entry; }
    out.firstTurn ||= !!spec.firstTurn; out.sameTurn ||= !!spec.sameTurn;
  }
  return out;
}
function permissions(s, catalog, player, attack, sourceId, grant = null, m = s.players[player].active) {
  const result = new Set();
  for (const binding of attack.effects) {
    const h = catalog.handler(binding.handlerId);
    if (h.permissions) for (const permission of h.permissions(effectContext(s, catalog,
      sourceFor(s, catalog, sourceId, player, 'attack', binding, m.id, attack.attackId, null, grantContext(grant))), clone(binding.parameters)))
      result.add(permission);
  }
  return result;
}
// 「这个招式，只有在……时才可使用」 (I.A-01 step 1-a): unmet, the attack cannot be declared at all.
function attackConditionMet(s, catalog, player, attack, m) {
  if (!attack.condition) return true;
  requireRule(catalog.ruleset, 'attack.condition');
  return conditionPredicateMet(s, catalog, { owner: player, pokemonId: m.id }, attack.condition.predicate);
}
// m: the attacking Pokémon — the Active Pokémon, or a Benched one using its own benchUse attack (attack.bench).
function attackLegal(s, catalog, player, attack, sourceId, grant = null, m = s.players[player].active) {
  const p = s.players[player];
  const allows = permissions(s, catalog, player, attack, sourceId, grant, m);
  return p.turns > 0 && (!(s.turn === 1 && s.first === player) || allows.has('first-turn-attack')) &&
    (!['asleep', 'paralyzed'].includes(m.conditions.rotation) || allows.has(`attack-while-${m.conditions.rotation}`)) &&
    !(attack.specialRule === 'GX' && p.gxUsed && !gxAgain(s, catalog, player, m)) && !(attack.specialRule === 'VSTAR' && p.vstarUsed) &&
    attackRequirements(s, catalog, player, m, attack, sourceId, grantContext(grant)).some((r) =>
      meetsEnergyRequirement(energyCards(s, catalog, m).flatMap((c) => c.units), r)) &&
    !monProhibited(s, catalog, player, m, 'attack', attack.attackId, { attack, sourceId, grant }) &&
    attackConditionMet(s, catalog, player, attack, m);
}
function attackAvailability(s, catalog, player, attack, sourceId, grant, m = s.players[player].active) {
  try { return { legal: attackLegal(s, catalog, player, attack, sourceId, grant, m), unresolved: false }; }
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
// ability.zone: 「在自己的回合可以使用1次」 of a card in hand or the discard pile counts that card (scope pokemon) or the player.
const cardUsageKey = (usage, cardId) => usage.scope === 'player' ? usage.key : `${usage.key}@${cardId}`;
function cardUsageAllowed(s, player, cardId, usage) {
  if (usage.period === 'unlimited') return true;
  const history = s.players[player].used[cardUsageKey(usage, cardId)] ?? [];
  return (usage.period === 'turn' ? history.filter((t) => t === s.turn) : history).length < usage.limit;
}
function recordCardUsage(s, player, cardId, usage) {
  if (usage.period === 'unlimited') return;
  (s.players[player].used[cardUsageKey(usage, cardId)] ??= []).push(s.turn);
}
function recordUsage(s, player, m, usage) {
  if (!usage || usage.period === 'unlimited') return;
  const tracker = usage.scope === 'player' ? s.players[player].used : m.used;
  if (!Object.hasOwn(tracker, usage.key)) tracker[usage.key] = [];
  tracker[usage.key].push(s.turn);
}

function actions(s, catalog, player) {
  if (s.phase !== 'main' || s.pending || s.queue.length || s.current !== player || s.result) return [];
  const p = s.players[player], out = [{ type: 'endTurn' }], model = sourceModel(s, catalog), locked = handLock(s, catalog, player);
  const locks = enterLocks(s, catalog, player, model);
  for (const id of p.hand.filter((id) => !locked.card(id))) {
    const d = cardDef(s, catalog, id);
    if (d.kind === 'pokemon') {
      if (!enterAllowed(s, catalog, id, null, locks)) continue;
      // pokemon.item-card: played from the hand as an Item (I.B-01), so an Item lock stops it.
      if (d.mechanics.itemCard && playerProhibited(s, catalog, player, 'playItem')) continue;
      // setup.placement 「这张卡牌，在对战准备以外无法放于场上」.
      if (d.mechanics.itemCard?.setupOnly) continue;
      if (d.mechanics.stage === 'basic' && p.bench.length < benchLimit(s, catalog, player)) out.push({ type: 'bench', cardId: id });
      for (const m of mons(p)) if (canEvolve(s, catalog, player, m, d)) out.push({ type: 'evolve', cardId: id, pokemonId: m.id });
    } else if (d.kind === 'energy' && handEnergyRoom(s, catalog, player)) {
      for (const m of mons(p)) if (!monProhibited(s, catalog, player, m, 'attachFromHand') &&
        activationUsable(s, catalog, activationRequest('energy', player, id, { pokemonId: m.id })))
        out.push({ type: 'attachEnergy', cardId: id, pokemonId: m.id });
    } else if (d.kind === 'trainer') {
      const category = d.mechanics.category;
      const action = { item: 'playItem', supporter: 'playSupporter', tool: 'playTool', stadium: 'playStadium' }[category];
      if (playerProhibited(s, catalog, player, action)) continue;
      if (category === 'supporter' && (supporterSpent(s, catalog, player) || s.turn === 1 && !firstTurnUse(catalog, d))) continue;
      if (category === 'stadium' && (p.flags.stadium || (s.stadium && cardDef(s, catalog, s.stadium).nameKey === d.nameKey))) continue;
      if (category === 'tool' && !mons(p).some((m) => toolTarget(s, catalog, m, d))) continue;
      // trainer.joint-play 「同时使用N张」: N cards of this name from the hand as one use; one card alone runs only its own entries.
      const joint = jointCards(s, catalog, player, id);
      if (joint && activationUsable(s, catalog, activationRequest('trainer', player, id, { jointCardIds: joint })))
        out.push({ type: 'playTrainer', cardId: id, jointCardIds: joint });
      const bindings = d.mechanics.effects.filter((b) => !b.trigger && !b.playCount && (catalog.handler(b.handlerId).timing || 'resolve') === 'resolve');
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
    // attack.bench 「这个招式，即使这只宝可梦在备战区也能使用」: a Benched Pokémon's own printed attack.
    for (const m of p.bench) for (const { attack, instanceId, grant } of attacksFor(s, catalog, m, model))
      if (attack.benchUse && instanceId === top(m) && attackAvailability(s, catalog, player, attack, instanceId, grant, m).legal)
        out.push({ type: 'attack', attackId: attack.attackId, pokemonId: m.id });
    // pokemon.v-union 「对战中有1次机会，在自己的回合，可将自己弃牌区中的4种X V-UNION 组合起来，放于备战区」: once per game per name.
    if (p.bench.length < benchLimit(s, catalog, player)) for (const nameKey of new Set(p.discard.map((id) => cardDef(s, catalog, id))
      .filter((d) => d.mechanics.vUnion).map((d) => d.nameKey))) {
      const pieces = [1, 2, 3, 4].map((n) => p.discard.find((id) => { const d = cardDef(s, catalog, id); return d.nameKey === nameKey && d.mechanics.vUnion?.piece === n; }));
      if (pieces.every(Boolean) && !vUnionUsed(s, player, nameKey) && enterAllowed(s, catalog, pieces[0], null, locks)) out.push({ type: 'vUnion', cardIds: pieces });
    }
    // pokemon.item-card 「如果在自己的回合的话，则可将处于场上（战斗场上）的这张卡牌放于弃牌区（放回牌库下方）」, while not evolved.
    for (const m of mons(p)) {
      const leave = monDef(s, catalog, m).mechanics.itemCard?.leave;
      if (leave && (leave.from === 'field' || m === p.active)) out.push({ type: 'leavePlay', pokemonId: m.id });
    }
    const cost = retreatCost(s, catalog, player, p.active);
    if (!p.flags.retreat && p.bench.length && !monProhibited(s, catalog, player, p.active, 'retreat') &&
        (!['asleep', 'paralyzed'].includes(p.active.conditions.rotation) || retreatRules(s, catalog, player, p.active).some((r) => r.spec.ignoreConditions)) &&
        energyCards(s, catalog, p.active).reduce((n, c) => n + c.units.length, 0) >= cost) out.push({ type: 'retreat' });
    for (const id of p.discard) if (cardDef(s, catalog, id).mechanics.discardRecall &&
      activationUsable(s, catalog, activationRequest('recall', player, id))) out.push({ type: 'recallCard', cardId: id });
    for (const zone of ['hand', 'discard']) for (const id of zone === 'hand' && locked.all ? [] : p[zone]) {
      const d = cardDef(s, catalog, id);
      if (d.kind === 'pokemon') for (const ability of d.mechanics.abilities.filter((a) => a.zone === zone))
        if (activationUsable(s, catalog, activationRequest('cardAbility', player, id, { abilityId: ability.abilityId })))
          out.push({ type: 'useAbility', cardId: id, abilityId: ability.abilityId });
    }
    for (const m of mons(p)) for (const ability of monDef(s, catalog, m).mechanics.abilities) {
      if (ability.mode !== 'activated' || (ability.specialRule === 'VSTAR' && p.vstarUsed) ||
          !model.availability.get(sourceNodeId('ability', top(m), ability.abilityId)).enabled ||
          !usageAllowed(s, player, m, ability.usage)) continue;
      if (!activationUsable(s, catalog, activationRequest('ability', player, top(m), { pokemonId: m.id, abilityId: ability.abilityId }))) continue;
      out.push({ type: 'useAbility', pokemonId: m.id, abilityId: ability.abilityId });
    }
    // tools.granted-ability: the Ability printed on an attached Tool, named with that Tool.
    for (const m of mons(p)) for (const { ability, toolId } of grantedAbilitiesFor(s, catalog, m, model))
      if (activationUsable(s, catalog, activationRequest('ability', player, toolId, { pokemonId: m.id, abilityId: ability.abilityId })))
        out.push({ type: 'useAbility', pokemonId: m.id, abilityId: ability.abilityId, toolId });
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
    if (cardDef(s, catalog, a.cardId).mechanics.itemCard) requireRule(catalog.ruleset, 'pokemon.item-card');
    remove(p.hand, a.cardId);
    const m = newMon(s, a.cardId); p.bench.push(m);
    log(s, 'turn.bench', { player, cardId: a.cardId });
    enqueue(s, ...triggerWork(s, catalog, [makeTriggerEvent(s, catalog, 'bench', player, m,
      { origin: 'hand', cardId: a.cardId })]), tasks('ko'));
  } else if (a.type === 'evolve') {
    const { m } = findMon(s, a.pokemonId), current = monDef(s, catalog, m), card = cardDef(s, catalog, a.cardId);
    // 「在进化前，将这只宝可梦的HP，全部回复」: only an evolution its own permission made possible.
    const heal = evolutionAllowances(s, catalog, player, m, current, card).heal;
    if (heal && !evolutionRelation(current, card, 'ordinary') && m.counters) healBy(s, catalog, player, m, m.counters * 10, heal.source);
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
    const attacker = a.pokemonId ? p.bench.find((m) => m.id === a.pokemonId) : p.active;
    if (a.pokemonId) requireRule(catalog.ruleset, 'attack.bench');
    const candidates = attacksFor(s, catalog, attacker).filter((r) => r.attack.attackId === a.attackId &&
      (!a.referenceId || r.referenceId === a.referenceId));
    if (candidates.length !== 1) throw new EngineError('ambiguous-attack', 'Granted/native attack identities must be unambiguous.');
    const record = candidates[0];
    const grant = record.grant ? { ...clone(record.grant), id: `grant${++s.serial}` } : null;
    s.phase = 'resolving'; enqueue(s, tasks('attack', { player, attackId: a.attackId,
      pokemonId: attacker.id, sourceId: record.instanceId, attack: clone(record.attack), grant }));
  } else if (a.type === 'endTurn') enqueue(s, tasks('end-turn', { player }));
  else if (a.type === 'useAbility' && a.cardId) beginActivation(s, catalog, activationRequest('cardAbility', player, a.cardId, { abilityId: a.abilityId }));
  else if (a.type === 'useAbility') {
    const { m } = findMon(s, a.pokemonId);
    beginActivation(s, catalog, activationRequest('ability', player, a.toolId ?? top(m), { pokemonId: m.id, abilityId: a.abilityId }));
  } else if (a.type === 'useStadium') {
    beginActivation(s, catalog, activationRequest('stadium', player, s.stadium));
  } else if (a.type === 'playTrainer') {
    beginActivation(s, catalog, activationRequest('trainer', player, a.cardId, a.jointCardIds ? { jointCardIds: [...a.jointCardIds] } : {}));
  } else if (a.type === 'recallCard') beginActivation(s, catalog, activationRequest('recall', player, a.cardId));
  else if (a.type === 'vUnion') {
    requireRule(catalog.ruleset, 'pokemon.v-union');
    a.cardIds.forEach((id) => remove(p.discard, id));
    const m = newMon(s, a.cardIds[0]); m.stack = [...a.cardIds]; p.bench.push(m);
    log(s, 'pokemon.v-union', { player, nameKey: cardDef(s, catalog, a.cardIds[0]).nameKey, cardIds: [...a.cardIds], pokemonId: m.id });
    enqueue(s, ...triggerWork(s, catalog, [makeTriggerEvent(s, catalog, 'bench', player, m, { origin: 'discard', cardId: top(m) })]), tasks('ko'));
  } else if (a.type === 'leavePlay') {
    const { m } = findMon(s, a.pokemonId), { leave } = monDef(s, catalog, m).mechanics.itemCard, attachments = [...m.energy, ...m.tools];
    requireRule(catalog.ruleset, 'pokemon.item-card');
    // Not a Knock Out: no Prize card. The attached cards are discarded; an empty Active Spot is filled as after a Knock Out.
    if (leave.to === 'discard') m.stack.forEach((id) => discard(s, catalog, id)); else p.deck.unshift(...m.stack);
    attachments.forEach((id) => discardFromPlay(s, catalog, id));
    if (p.active === m) p.active = null; else p.bench.splice(p.bench.indexOf(m), 1);
    retireTarget(s, m.id, 'leave');
    log(s, 'pokemon.item-card', { player, pokemonId: m.id, cards: [...m.stack], attachments, to: leave.to });
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
      rule: ruleTrace(catalog.ruleset, { coinFace: 'effects.coin-face', coinChoice: 'effects.coin-choice',
        suppression: 'effects.player-ability-removal' }[entry.effect.op] ??
        (entry.effect.op === 'modifier' ? entry.ruleId : 'effects.player-lock')),
    })),
    players: state.players.map((p, owner) => ({
      deckCount: p.deck.length, hand: owner === viewer ? p.hand.map(card) : { count: p.hand.length },
      prizes: { count: p.prizes.length, ...(p.faceUpPrizes ? { faceUp: p.prizes.flatMap((id, index) =>
        p.faceUpPrizes.includes(id) ? [{ index, card: card(id) }] : []) } : {}) }, discard: p.discard.map(card), lost: p.lost.map(card),
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
        ...(costInfo.optional.length ? { optional: true } : {}),
        groups: (costInfo.optional.length ? costInfo.optional : costInfo.costs).map((cost, _i, costs) => ({
          costId: cost.costId, kind: cost.kind, count: cost.count, selector: clone(cost.selector),
          choices: paymentCards(state, catalog, request.data.activation, costs)
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
      // A Prize position shows its card only when that Prize is face up; a looked-at Prize once it is looked at.
      ...(['prize', 'prize-slot'].includes(request.kind) ? { faceUpSlots: Object.fromEntries(request.options.flatMap((slot) => {
        const q = state.players[request.kind === 'prize' ? request.player : request.data.action.side === 'opponent' ? 1 - request.data.source.owner :
          request.data.source.owner], id = q.prizes[Number(slot)];
        return faceUpPrizes(q).includes(id) ? [[slot, card(id)]] : [];
      })) } : {}),
      ...(request.data.stage === 'prize-view' ? { lookedAt: request.data.lookedAt.map(card) } : {}),
      // 「各查看其正面」: the face-up Prize and the hand card the user looked at.
      ...(request.data.action?.op === 'lookPrizeHand' && request.data.stage !== 'prize-slot' ? { lookedAt: [...request.data.lookedAt, ...request.data.chosen].map(card) } : {}),
      // ko.prize-destination: the Prize cards the taker took and has seen.
      ...(request.kind === 'prize-destination' ? { cards: request.options.map(card) } : {}),
      ...(['cards', 'evolvePokemon', 'inheritPokemon', 'replacePokemon', 'opponentHand', 'arrangeDeck', 'copySupporter'].includes(request.data.action?.op) && request.data.lookedAt ? {
        cards: request.options.filter((id) => Object.hasOwn(state.cards, id)).map(card),
        lookedAt: (request.data.action.op === 'cards' && request.data.action.from === 'deck' && request.data.action.lookTop !== null ?
          [...request.data.lookedAt].reverse() : request.data.action.op === 'arrangeDeck' || request.data.action.lookBottom ? [...request.data.lookedAt] :
            [...request.data.lookedAt].sort()).map(card),
      } : {}),
      ...(['discardEnergy', 'moveEnergy', 'returnEnergy'].includes(request.data.action?.op) ? {
        energy: attachedEnergyPool(effectContext(state, catalog, request.data.source, request.data.event ?? null), energyAction(request.data))
          .map((e) => ({ card: card(e.instanceId), originId: e.originId, units: clone(e.units), amount: e.amount })),
      } : {}),
      ...(request.data.copyChoice || request.data.ownedAttackChoice ? { attacks:
        (request.data.copyChoice ?? request.data.ownedAttackChoice).candidates.map((ref) => {
        const a = copiedAttack(state, catalog, ref);
        return { optionId: attackOptionId(ref), card: card(ref.instanceId), attackId: ref.attackId,
          name: a.name, cost: clone(a.cost), printedDamage: clone(a.printedDamage) };
      }) } : {}),
      // A coin choice shows the flips it is about and the cards offering a reflip; a janken request never shows the other hand.
      ...(request.data.coinOccasion ? { coins: { flipper: request.data.coinOccasion.flipper, results: [...(request.data.coinOccasion.receipt?.results ?? [])],
        ...(request.kind === 'coin-reflip' ? { reflip: reflipSources(state, catalog, request.player) } : {}) } } : {}),
      ...(request.data.janken ? { janken: { round: request.data.janken.round } } : {}),
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
