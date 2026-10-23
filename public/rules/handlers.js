// Source-reviewed reusable primitives, not a text parser and not card approvals.
import * as validators from './schema-validators.js';
import { CN_V20261019 } from './zh-CN/V20261019.js';
import { requireRule } from './registry.js';
import { matchesCardSelector, matchesCardsMove } from './card-selection.js';
import { matchesInPlaySelector, matchesPokemonState } from './in-play-selection.js';
import { costCardCount, findCostPayment } from './activation-cost.js';
import { canUseAttachedEnergy, effectAttachable } from './energy-selection.js';
import { canUsePokemonTransition } from './evolution.js';
import { fieldReturnTargets } from './field-return.js';
import { deckEnergyRecipients } from './deck-energy.js';
import { prizesTakenForPlayer } from './prize-count.js';
import { evaluateDamageValue, evaluateBattleValue } from './battle-value.js';
import { evaluateBattlePredicate } from './battle-predicate.js';
import { presentConditions } from './conditions.js';
import { canUsePokemonHealing } from './healing.js';
import { canUseCounterDistribution } from './counter-distribution.js';
import { canUseDiscardStadium } from './field-cards.js';
import { discardDestination } from './discard-policy.js';

export const REACTION_OPERATIONS = Object.freeze([
  'draw', 'discardHand', 'counters', 'heal', 'condition', 'switch', 'attachDiscard', 'attachHand',
  'transferCounters', 'lasting', 'lastingPlayer', 'cards', 'shuffle', 'discardEnergy', 'moveEnergy', 'sequence', 'then', 'optional',
  'evolvePokemon', 'devolvePokemon', 'inheritPokemon',
  'returnPokemon', 'returnEnergy',
  'inspectDeck', 'attachDeckEnergy',
  'shuffleHandToBottom',
  'healPokemon', 'distributeCounters',
  'discardStadium', 'knockOut',
]);
const subjects = (ctx, owner) => ctx.subject ? ctx.subject.owner === owner ? [ctx.subject.pokemon] : [] :
  [ctx.state.players[owner].active, ...ctx.state.players[owner].bench].filter(Boolean);
const active = (ctx, owner, m) => ctx.subject ? ctx.subject.owner === owner && ctx.subject.active :
  m === ctx.state.players[owner].active;
const matches = (ctx, target, owner, m) => target === 'self' ? m.id === ctx.source.pokemonId :
  target === 'active' ? active(ctx, owner, m) : target === 'bench' ? !active(ctx, owner, m) : target === 'event' ? m.id === ctx.event?.subjectId :
  target === 'attacker' ? m.id === ctx.event?.cause.source?.pokemonId : true;
const countersTarget = (ctx, p) => {
  const owner = p.side === 'event' ? ctx.event.owner : p.side === 'own' ? ctx.source.owner : 1 - ctx.source.owner;
  return subjects(ctx, owner).some((m) => matches(ctx, p.target, owner, m) &&
    (!p.targetSelector || matchesInPlaySelector(ctx.definitions[ctx.state.cards[m.stack.at(-1)].definitionId], p.targetSelector, ctx.effectivePokemon[m.id].types)) &&
    (!p.targetState || matchesPokemonState(m, ctx.effectivePokemon[m.id], p.targetState, (id) => ctx.definitions[ctx.state.cards[id].definitionId])));
};
const def = (ctx, id) => ctx.definitions[ctx.state.cards[id].definitionId];
const costCards = (ctx) => ctx.state.players[ctx.activation.player].hand
  .filter((id) => id !== ctx.activation.sourceId).map((id) => ({ instanceId: id, definition: def(ctx, id) }));
const handAfterCosts = (ctx, costs) => ctx.state.players[ctx.source.owner].hand.length -
  (ctx.activation?.kind === 'trainer' && ctx.activation.player === ctx.source.owner &&
    ctx.state.players[ctx.source.owner].hand.includes(ctx.source.instanceId) ? 1 : 0) -
  (costs.length && ctx.activation.player === ctx.source.owner ? costCardCount(costs) : 0);
const handBottomAvailable = (ctx, p, costs = []) => {
  const own = ctx.source.owner;
  const holders = p.side === 'both' ? [own, 1 - own] : [p.side === 'own' ? own : 1 - own];
  return holders.some((owner) => {
    const hand = ctx.state.players[owner].hand;
    const count = hand.length -
      (ctx.source.category === 'trainer' && owner === own && hand.includes(ctx.source.instanceId) ? 1 : 0) -
      (costs.length && ctx.activation.player === owner ? costCardCount(costs) : 0);
    return count > 0;
  });
};
// A Prize-dependent draw reads the drawing player's actual Prize cards at resolution (I.G-7, II.D-17).
// A computed count (「数过自己的手牌之后」, 「与对手的手牌相同张数」, 「如果…的话，则抽取的张数变为N张」) is read
// from the effect user's side when the effect starts, before any hand goes back.
const drawCount = (ctx, player, spec) => {
  if (typeof spec === 'number') return spec;
  if (spec.kind === 'value') return Math.max(0, evaluateBattleValue(spec.value, ctx.battleValues));
  const remaining = ctx.state.players[player].prizes.length;
  return spec.kind === 'remainingPrizes' ? remaining : remaining === spec.equals ? spec.then : spec.otherwise;
};
// E-36: a whole hand into its own deck changes something whenever that hand
// or deck holds a card; the played Trainer and paid costs are already gone.
const handDeckAvailable = (ctx, p, costs = []) => {
  const own = ctx.source.owner;
  const holders = p.side === 'both' ? [own, 1 - own] : [p.side === 'own' ? own : 1 - own];
  return holders.some((owner) => {
    const { hand, deck } = ctx.state.players[owner];
    return hand.length + deck.length -
      (ctx.source.category === 'trainer' && owner === own && hand.includes(ctx.source.instanceId) ? 1 : 0) -
      (costs.length && ctx.activation.player === owner ? costCardCount(costs) : 0) > 0;
  });
};
// Printed Energy-attachment recipients and cards; ctx.benchLimits is the actual current limit.
const attachTargets = (ctx, p) => (p.benchOnly ? ctx.state.players[ctx.source.owner].bench : subjects(ctx, ctx.source.owner))
  .filter((m) => (p.target !== 'self' || m.id === ctx.source.pokemonId) && (p.target !== 'active' || m === ctx.state.players[ctx.source.owner].active) &&
    (!p.recipient || matchesInPlaySelector(ctx.definitions[ctx.state.cards[m.stack.at(-1)].definitionId], p.recipient,
      ctx.effectivePokemon[m.id].types)) && (!p.spareKnockOut || remainingHp(ctx, m) > p.recipientEffect.counters * 10));
const paidIds = (ctx) => (ctx.payment?.groups ?? []).flatMap((g) => g.cardIds);
// Attached Tools a tool discard could choose: the printed side and holders, and the printed kind of Tool.
const toolsFor = (ctx, p) => (p.side === 'both' ? [ctx.source.owner, 1 - ctx.source.owner] :
  [p.side === 'opponent' ? 1 - ctx.source.owner : ctx.source.owner]).flatMap((owner) => {
  const pl = ctx.state.players[owner];
  const holders = p.target === 'active' ? [pl.active] : p.target === 'bench' ? pl.bench : [pl.active, ...pl.bench]
    .filter((m) => p.target !== 'self' || m?.id === ctx.source.pokemonId);
  return holders.filter(Boolean).flatMap((m) => m.tools)
    .filter((id) => !p.selector || matchesCardSelector(ctx.definitions[ctx.state.cards[id].definitionId], p.selector));
});
// A printed kind of Benched Pokémon to switch in (current types, current state).
// 「剩余HP在「N」以下」 reads the remaining HP the host supplies with the context (II.D-16).
const switchCandidate = (ctx, m, p) =>
  (!p.selector || matchesInPlaySelector(ctx.definitions[ctx.state.cards[m.stack.at(-1)].definitionId], p.selector, ctx.effectivePokemon[m.id].types)) &&
  (!p.state || matchesPokemonState(m, ctx.effectivePokemon[m.id], p.state, (id) => ctx.definitions[ctx.state.cards[id].definitionId])) &&
  (p.state?.remainingHpAtMost === undefined || remainingHp(ctx, m) <= p.state.remainingHpAtMost);
const remainingHp = (ctx, m) => {
  if (!Object.hasOwn(ctx.remainingHp ?? {}, m.id)) throw new TypeError('A remaining-HP choice needs the host\'s remaining HP.');
  return ctx.remainingHp[m.id];
};
const benchRoom = (ctx) => ctx.state.players[ctx.source.owner].bench.length < ctx.benchLimits[ctx.source.owner];
const inPlayCount = (ctx, side) => {
  const p = ctx.state.players[side === 'own' ? ctx.source.owner : 1 - ctx.source.owner];
  return [p.active, ...p.bench].filter(Boolean).length;
};
// Looking at a held hand is itself an action (II.C-20 文例1); only a hand already at
// the printed 「直到手牌变为N张」 size cannot change. Never reads the hidden faces.
const opponentHandChanges = (ctx, p) => {
  const held = ctx.state.players[1 - ctx.source.owner].hand.length;
  return p.quantity?.kind === 'leave' ? held > p.quantity.count : held > 0;
};
// The host answers the count's board/zone/history queries at resolution (ctx.battleValues).
const drawValue = (ctx, p) => Math.max(0, evaluateBattleValue(p.count, ctx.battleValues));
const countersValue = (ctx, p) => Math.max(0, evaluateBattleValue(p.count, ctx.battleValues));
// 「与…数量相同数量」: a leaf written for a count of one; the host puts the resolution-time value in that field.
const VALUE_FIELDS = Object.freeze({ 'cn.counters@1': 'count', 'cn.distributeCounters@1': 'count', 'cn.discardDeckTop@1': 'count',
  'cn.attachDiscard@1': 'count', 'cn.attachHand@1': 'count', 'cn.cards@1': 'quantity' });
const resolvedCount = (ctx, p) => Math.max(0, evaluateBattleValue(p.count, ctx.battleValues));
const withCount = (n, value) => VALUE_FIELDS[n.handlerId] === 'count' ? { ...n.parameters, count: value }
  : { ...n.parameters, quantity: { ...n.parameters.quantity, count: value } };
// Control handlers compose these reviewed static leaves only. Each leaf keeps
// its own validator; module-level functions keep native identity stable. A leaf's
// program is fixed when the control handler runs, so every leaf here must build it
// from its parameters alone: a leaf that reads the board while compiling
// (drawPokemonCount) would see the board before an earlier step of a then changed it.
// drawUntil's hand size is read by its draw operation itself.
const NESTED_VALIDATORS = Object.freeze({
  'cn.drawUntil@1': validators.validateDrawParameters,
  'cn.switch@1': validators.validateSwitchParameters, 'cn.condition@1': validators.validateConditionParameters,
  'cn.attachedEnergy@1': validators.validateAttachedEnergyParameters, 'cn.cards@1': validators.validateCardsParameters,
  'cn.cardsThenDraw@1': validators.validateCardsThenDrawParameters,
  'cn.lasting@1': validators.validateLastingParameters, 'cn.lastingPlayer@1': validators.validateLastingPlayerParameters,
  'cn.heal@1': validators.validateHealParameters, 'cn.healPokemon@1': validators.validatePokemonHealingParameters,
  'cn.counters@1': validators.validateCountersParameters, 'cn.draw@1': validators.validateDrawParameters,
  'cn.countersUntil@1': validators.validateCountersUntilParameters,
  'cn.discardStadium@1': validators.validateDiscardStadiumParameters, 'cn.fieldReturn@1': validators.validateFieldReturnParameters,
  'cn.attachDeckEnergy@1': validators.validateAttachDeckEnergyParameters, 'cn.attachHand@1': validators.validateAttachDiscardParameters,
  'cn.attachDiscard@1': validators.validateAttachDiscardParameters, 'cn.discardDeckTop@1': validators.validateDiscardDeckTopParameters,
  'cn.pokemonTransition@1': validators.validatePokemonTransitionParameters,
  'cn.discardTools@1': validators.validateDiscardToolsParameters, 'cn.opponentHand@1': validators.validateOpponentHandParameters,
  'cn.arrangeDeck@1': validators.validateArrangeDeckParameters, 'cn.cure@1': validators.validateCureParameters,
  'cn.knockOut@1': validators.validateKnockOutParameters, 'cn.takePrizes@1': validators.validateTakePrizesParameters,
});
// A then's parts are single leaves; a nested then (cardsThenDraw) stays outside.
const THEN_NESTED = Object.freeze(Object.keys(NESTED_VALIDATORS).filter((id) => id !== 'cn.cardsThenDraw@1'));
const LEAF_OPERATIONS = Object.freeze(['switch', 'condition', 'discardEnergy', 'moveEnergy', 'returnEnergy', 'cards', 'draw',
  'lasting', 'lastingPlayer', 'heal', 'healPokemon', 'counters', 'discardStadium', 'returnPokemon', 'attachDeckEnergy',
  'attachHand', 'attachDiscard', 'discardDeckTop', 'evolvePokemon', 'devolvePokemon', 'inheritPokemon', 'discardTools', 'opponentHand', 'arrangeDeck',
  'cure', 'knockOut', 'takePrizes']);
const NESTED_OPERATIONS = Object.freeze([...LEAF_OPERATIONS, 'then']);
const nestedValid = (n) => NESTED_VALIDATORS[n.handlerId](n.parameters);
export function validateCoinEffect(p) {
  return validators.validateCoinParameters(p) && [...(p.effects ?? [p.effect]), ...(p.otherwise ? [p.otherwise] : [])].every(nestedValid);
}
// 「与出现正面次数相同数量」: a leaf written for one such flip; the host multiplies this field.
const SCALED_FIELDS = Object.freeze({
  'cn.draw@1': 'count', 'cn.counters@1': 'count', 'cn.discardDeckTop@1': 'count', 'cn.attachDiscard@1': 'count', 'cn.heal@1': 'count',
  'cn.cards@1': 'quantity', 'cn.attachedEnergy@1': 'quantity', 'cn.attachDeckEnergy@1': 'quantity', 'cn.opponentHand@1': 'quantity',
});
export function validateCoinsEffect(p) {
  return validators.validateCoinsParameters(p) && nestedValid(p.effect) && (p.apply.kind !== 'scale' ||
    Object.hasOwn(SCALED_FIELDS, p.effect.handlerId) &&
      (SCALED_FIELDS[p.effect.handlerId] === 'count' || ['exact', 'upTo'].includes(p.effect.parameters.quantity.kind)));
}
// The condition reads only coin counts of rolls (the game load guard ties them to this attack's own damage rolls).
const COIN_RESULT_KINDS = ['compare', 'all', 'any', 'not', 'literal', 'coin'];
const coinFactsOnly = (node) => Array.isArray(node) ? node.every(coinFactsOnly) : !node || typeof node !== 'object' ||
  (!Object.hasOwn(node, 'kind') || COIN_RESULT_KINDS.includes(node.kind)) && Object.values(node).every(coinFactsOnly);
// The movable things a counted optional cost may name, each recorded by its own operation.
export function validateOptionalCountedEffect(p) {
  if (!validators.validateOptionalCountedParameters(p) || !nestedValid(p.effect)) return false;
  const { handlerId, parameters: e } = p.effect;
  return handlerId === 'cn.attachedEnergy@1' ? ['discardEnergy', 'returnEnergy'].includes(e.op) && e.side === 'own' :
    handlerId === 'cn.cards@1' ? ['hand', 'deck'].includes(e.from) && e.to === 'discard' :
    ['cn.discardTools@1', 'cn.discardStadium@1'].includes(handlerId);
}
export function validateCoinResultEffect(p) {
  return validators.validateCoinResultParameters(p) && coinFactsOnly(p.condition) &&
    [...(p.effects ?? [p.effect]), ...(p.otherwise ? [p.otherwise] : [])].every(nestedValid);
}
export function validateWhenEffect(p) {
  return validators.validateWhenParameters(p) && [...(p.effects ?? [p.effect]), ...(p.otherwise ? [p.otherwise] : [])].every(nestedValid);
}
export function validateOptionalEffect(p) {
  return validators.validateOptionalParameters(p) && (p.effect.handlerId === 'cn.then@1' ? validateThenEffect(p.effect.parameters) : nestedValid(p.effect));
}
export function validateOrElseEffect(p) {
  return validators.validateOrElseParameters(p) && nestedValid(p.first) && nestedValid(p.otherwise);
}
const thenOrLeafValid = (n) => n.handlerId === 'cn.then@1' ? validateThenEffect(n.parameters) : nestedValid(n);
export function validateStadiumUseEffect(p) {
  return validators.validateStadiumUseParameters(p) && thenOrLeafValid(p.effect);
}
// A ◆ option may also be a whole-hand pair with printed counts (「将自己的所有手牌放回牌库并重洗牌库。然后，从牌库上方抽取5张卡牌」)
// or 「将自己所有的手牌放于弃牌区」 followed by more entries.
const choiceEntryValid = (n) => n.handlerId === 'cn.discardHand@1' ? validators.validateEmptyParameters(n.parameters) :
  ['cn.handDeckDraw@1', 'cn.handBottomDraw@1'].includes(n.handlerId) ?
    (n.handlerId === 'cn.handDeckDraw@1' ? validators.validateHandDeckDrawParameters : validators.validateHandBottomDrawParameters)(n.parameters) &&
    typeof n.parameters.ownDraw === 'number' && typeof n.parameters.opponentDraw === 'number' : thenOrLeafValid(n);
export function validateChooseOneEffect(p) {
  return validators.validateChooseOneParameters(p) && p.options.every((o) => (Array.isArray(o) ? o : [o]).every(choiceEntryValid)) &&
    new Set(p.options.map((n) => JSON.stringify(n))).size === p.options.length;
}
export function validateThenEffect(p) {
  return validators.validateThenParameters(p) && [p.first, p.next].every((n) => THEN_NESTED.includes(n.handlerId) && nestedValid(n));
}
// The zone the cards a thenMoved's first part moved end up in (only its user's own cards), or null.
function movedZone({ handlerId, parameters: e }) {
  if (handlerId === 'cn.cards@1') return ['hand', 'discard', 'deck'].includes(e.to) ? e.to : null;
  if (handlerId === 'cn.discardDeckTop@1') return e.side === 'own' ? 'discard' : null;
  return e.side !== 'own' ? null : e.op === 'discardEnergy' ? 'discard' : e.to === 'hand' ? 'hand' : null;
}
// The first part may also report a count of the opponent's cards (「将对手牌库上方…放于弃牌区…其张数」).
const MOVED_COUNT_FIRST = ['cn.cards@1', 'cn.discardDeckTop@1', 'cn.attachedEnergy@1'];
export function validateThenMovedEffect(p) {
  if (!validators.validateThenMovedParameters(p) || ![p.first, p.next].every(nestedValid)) return false;
  const { first, next } = p;
  if (!MOVED_COUNT_FIRST.includes(first.handlerId) || first.handlerId === 'cn.cards@1' && first.parameters.remainder ||
      first.handlerId === 'cn.attachedEnergy@1' && !['discardEnergy', 'returnEnergy'].includes(first.parameters.op)) return false;
  if (p.use === 'count') return Object.hasOwn(SCALED_FIELDS, next.handlerId) &&
    (SCALED_FIELDS[next.handlerId] === 'count' || ['exact', 'upTo'].includes(next.parameters.quantity.kind));
  const zone = movedZone(first);
  return zone !== null && (next.handlerId === 'cn.cards@1' ? next.parameters.from === zone && next.parameters.lookTop === null :
    next.handlerId === 'cn.attachDiscard@1' ? zone === 'discard' : next.handlerId === 'cn.attachHand@1' && zone === 'hand');
}
export function validateCountValueEffect(p) {
  if (!validators.validateCountValueParameters(p)) return false;
  const { handlerId, parameters: e } = p.effect;
  const valid = handlerId === 'cn.distributeCounters@1' ? validators.validateCounterDistributionParameters : NESTED_VALIDATORS[handlerId];
  return valid(e) && (VALUE_FIELDS[handlerId] === 'count' ? e.count === 1 : ['exact', 'upTo'].includes(e.quantity.kind) && e.quantity.count === 1);
}
function handler(id, ruleId, validateParameters, execute, extra = {}) {
  const operations = {
    'cn.draw@1': ['draw'], 'cn.drawPlayers@1': ['sequence', 'draw'], 'cn.attackChoice@1': ['attackChoice'], 'cn.evolutionPermission@1': ['evolutionPermission'], 'cn.discardHand@1': ['discardHand'], 'cn.counters@1': ['counters'], 'cn.countersUntil@1': ['counters'], 'cn.countersValue@1': ['counters'],
    'cn.drawUntil@1': ['draw'], 'cn.switch@1': ['switch'], 'cn.countedSwitch@1': ['switch'],
    'cn.prizeModifier@1': ['prizeModifier'], 'cn.extraPrizes@1': ['extraPrizes'], 'cn.takePrizes@1': ['takePrizes'],
    'cn.heal@1': ['heal'], 'cn.cure@1': ['cure'], 'cn.condition@1': ['condition'], 'cn.modifier@1': ['modifier'],
    'cn.attackPermissions@1': [], 'cn.attachDiscard@1': ['attachDiscard'], 'cn.attachHand@1': ['attachHand'],
    'cn.protection@1': ['protection'], 'cn.property@1': ['property'], 'cn.conditionImmunity@1': ['conditionImmunity'],
    'cn.attackDamageOptions@1': ['attackDamageOptions'], 'cn.damageOptions@1': [], 'cn.transferCounters@1': ['transferCounters'],
    'cn.lasting@1': ['lasting'],
    'cn.damage@1': ['damage'], 'cn.recoilDamage@1': ['damage'], 'cn.restriction@1': ['restriction'],
    'cn.playerRestriction@1': ['playerRestriction'], 'cn.lastingPlayer@1': ['lastingPlayer'],
    'cn.delayedReaction@1': ['delayedReaction'],
    'cn.suppression@1': ['suppression'],
    'cn.cards@1': ['cards'], 'cn.shuffle@1': ['shuffle'],
    'cn.deployIncoming@1': ['deployIncoming'], 'cn.attachIncoming@1': ['attachIncoming'],
    'cn.energyRequirement@1': ['energyRequirement'], 'cn.energyProvision@1': ['energyProvision'],
    'cn.energyOptions@1': [], 'cn.attachedEnergy@1': ['discardEnergy', 'moveEnergy', 'returnEnergy'],
    'cn.pokemonTransition@1': ['evolvePokemon', 'devolvePokemon', 'inheritPokemon'],
    'cn.fieldReturn@1': ['returnPokemon'],
    'cn.copyAttack@1': ['copyAttack'],
    'cn.attackGrant@1': ['attackGrant'],
    'cn.burnCounters@1': ['burnCounters'],
    'cn.inspectDeck@1': ['inspectDeck'], 'cn.attachDeckEnergy@1': ['attachDeckEnergy'],
    'cn.pokemonTypes@1': ['pokemonTypes'],
    'cn.prizeDamage@1': [],
    'cn.damageValue@1': [],
    'cn.prizeExchange@1': ['exchangePrizes'],
    'cn.shuffleHandToBottom@1': ['shuffleHandToBottom'],
    'cn.handBottomDraw@1': ['then', 'shuffleHandToBottom', 'sequence', 'draw'],
    'cn.healPokemon@1': ['healPokemon', 'discardEnergy'],
    'cn.distributeCounters@1': ['distributeCounters'],
    'cn.discardStadium@1': ['discardStadium'], 'cn.stadiumProtection@1': ['stadiumProtection'],
    'cn.disableOwnedAttack@1': ['disableOwnedAttack'],
    'cn.handDeckDraw@1': ['then', 'shuffleHandIntoDeck', 'sequence', 'draw'],
    'cn.drawPokemonCount@1': ['draw'], 'cn.drawValue@1': ['draw'], 'cn.drainHeal@1': ['heal'], 'cn.countersFromDamage@1': ['counters'],
    'cn.cardsThenDraw@1': ['then', 'cards', 'draw'],
    'cn.countedEnergyDiscard@1': ['discardEnergy'], 'cn.discardTools@1': ['discardTools'], 'cn.countedToolDiscard@1': ['discardTools'],
    'cn.countedCards@1': ['cards'], 'cn.opponentHand@1': ['opponentHand'],
    'cn.optionalCounted@1': ['optional', 'sequence', 'discardEnergy', 'returnEnergy', 'discardTools', 'cards', 'discardStadium'], 'cn.countedHandLook@1': ['opponentHand'],
    'cn.arrangeDeck@1': ['arrangeDeck'],
    'cn.coin@1': ['coin', 'sequence', ...NESTED_OPERATIONS],
    'cn.coins@1': ['coins', 'sequence', ...NESTED_OPERATIONS], 'cn.coinResult@1': ['coinResult', 'sequence', ...NESTED_OPERATIONS],
    'cn.when@1': ['when', 'sequence', ...NESTED_OPERATIONS],
    'cn.optional@1': ['optional', 'sequence', ...NESTED_OPERATIONS],
    'cn.orElse@1': ['orElse', 'sequence', ...NESTED_OPERATIONS],
    'cn.then@1': ['then', 'sequence', ...LEAF_OPERATIONS],
    'cn.thenMoved@1': ['thenMoved', ...LEAF_OPERATIONS],
    'cn.discardDeckTop@1': ['discardDeckTop'],
    'cn.attachThenDraw@1': ['then', 'attachHand', 'attachDiscard', 'draw'],
    'cn.replacePokemon@1': ['replacePokemon'],
    'cn.benchLimit@1': ['benchLimit'],
    'cn.knockOut@1': ['knockOut'],
    'cn.stadiumUse@1': ['sequence', ...NESTED_OPERATIONS],
    'cn.chooseOne@1': ['choose', 'sequence', ...NESTED_OPERATIONS, 'discardHand', 'shuffleHandIntoDeck', 'shuffleHandToBottom'],
    'cn.countedReveal@1': ['revealCards'], 'cn.revealedCards@1': ['revealedCards'], 'cn.countedDeckTop@1': ['discardDeckTop'],
    'cn.countedSelfCounters@1': ['selfCounters'], 'cn.revealHands@1': ['revealHands'],
    'cn.countValue@1': ['counters', 'distributeCounters', 'discardDeckTop', 'attachDiscard', 'attachHand', 'cards'],
  }[id];
  const schemaName = {
    'cn.disableOwnedAttack@1': 'ownedAttackLock',
    'cn.draw@1': 'draw', 'cn.drawPlayers@1': 'drawPlayers', 'cn.attackChoice@1': 'empty', 'cn.evolutionPermission@1': 'evolutionPermission', 'cn.discardHand@1': 'empty', 'cn.counters@1': 'counters', 'cn.countersUntil@1': 'countersUntil', 'cn.countersValue@1': 'countersValue', 'cn.heal@1': 'heal',
    'cn.drawUntil@1': 'draw', 'cn.switch@1': 'switch', 'cn.countedSwitch@1': 'countedSwitch',
    'cn.prizeModifier@1': 'prizeModifier', 'cn.extraPrizes@1': 'extraPrizes', 'cn.takePrizes@1': 'takePrizes',
    'cn.condition@1': 'condition', 'cn.cure@1': 'cure', 'cn.modifier@1': 'modifier', 'cn.attackPermissions@1': 'permissions', 'cn.attachDiscard@1': 'attachDiscard',
    'cn.attachHand@1': 'attachDiscard',
    'cn.protection@1': 'protection', 'cn.property@1': 'property', 'cn.conditionImmunity@1': 'conditionImmunity',
    'cn.attackDamageOptions@1': 'attackDamageOptions', 'cn.damageOptions@1': 'damageOptions', 'cn.transferCounters@1': 'transferCounters',
    'cn.lasting@1': 'lasting',
    'cn.damage@1': 'damage', 'cn.recoilDamage@1': 'damage', 'cn.restriction@1': 'restriction',
    'cn.playerRestriction@1': 'playerRestriction', 'cn.lastingPlayer@1': 'lastingPlayer', 'cn.delayedReaction@1': 'delayedReaction',
    'cn.suppression@1': 'suppression',
    'cn.cards@1': 'cards', 'cn.shuffle@1': 'shuffle',
    'cn.deployIncoming@1': 'empty', 'cn.attachIncoming@1': 'attachIncoming',
    'cn.energyRequirement@1': 'energyRequirement', 'cn.energyProvision@1': 'energyProvision',
    'cn.energyOptions@1': 'energyOptions', 'cn.attachedEnergy@1': 'attachedEnergy',
    'cn.pokemonTransition@1': 'pokemonTransition',
    'cn.fieldReturn@1': 'fieldReturn',
    'cn.copyAttack@1': 'copyAttack',
    'cn.attackGrant@1': 'attackGrant',
    'cn.burnCounters@1': 'burnCounters',
    'cn.inspectDeck@1': 'inspectDeck', 'cn.attachDeckEnergy@1': 'attachDeckEnergy',
    'cn.pokemonTypes@1': 'pokemonTypes',
    'cn.prizeDamage@1': 'prizeDamage',
    'cn.damageValue@1': 'damageValue',
    'cn.prizeExchange@1': 'prizeExchange',
    'cn.shuffleHandToBottom@1': 'shuffleHandToBottom',
    'cn.handBottomDraw@1': 'handBottomDraw',
    'cn.healPokemon@1': 'pokemonHealing',
    'cn.distributeCounters@1': 'counterDistribution',
    'cn.discardStadium@1': 'discardStadium', 'cn.stadiumProtection@1': 'stadiumProtection',
    'cn.handDeckDraw@1': 'handDeckDraw', 'cn.drawPokemonCount@1': 'drawPokemonCount', 'cn.drawValue@1': 'drawValue', 'cn.drainHeal@1': 'empty', 'cn.countersFromDamage@1': 'countersFromDamage',
    'cn.cardsThenDraw@1': 'cardsThenDraw', 'cn.coin@1': 'coin', 'cn.coins@1': 'coins', 'cn.coinResult@1': 'coinResult', 'cn.when@1': 'when', 'cn.optional@1': 'optional', 'cn.orElse@1': 'orElse',
    'cn.countedEnergyDiscard@1': 'countedEnergyDiscard', 'cn.discardTools@1': 'discardTools', 'cn.countedToolDiscard@1': 'discardTools',
    'cn.countedCards@1': 'countedCards', 'cn.opponentHand@1': 'opponentHand', 'cn.countedHandLook@1': 'opponentHandLook', 'cn.arrangeDeck@1': 'arrangeDeck', 'cn.optionalCounted@1': 'optionalCounted',
    'cn.then@1': 'then', 'cn.thenMoved@1': 'thenMoved', 'cn.discardDeckTop@1': 'discardDeckTop', 'cn.attachThenDraw@1': 'attachThenDraw',
    'cn.replacePokemon@1': 'replacePokemon', 'cn.benchLimit@1': 'benchLimit', 'cn.knockOut@1': 'knockOut',
    'cn.stadiumUse@1': 'stadiumUse', 'cn.chooseOne@1': 'chooseOne',
    'cn.countedReveal@1': 'countedReveal', 'cn.revealedCards@1': 'revealedCards', 'cn.countedDeckTop@1': 'countedDeckTop',
    'cn.countedSelfCounters@1': 'countedSelfCounters', 'cn.revealHands@1': 'revealHands', 'cn.countValue@1': 'countValue',
  }[id];
  return Object.freeze({
    id, rulesetId: CN_V20261019.id, implementationVersion: '1', timing: 'resolve',
    operations,
    parameterSchemaRef: `urn:pokemon-tcg:core-handler-parameters:1.0.0#/$defs/${schemaName}`,
    sourceOfTruth: [ruleId, ...(['cn.counters@1', 'cn.countersUntil@1', 'cn.countersValue@1', 'cn.heal@1', 'cn.healPokemon@1', 'cn.distributeCounters@1', 'cn.discardStadium@1'].includes(id) ?
      ['effects.activation-change'] : []), ...(['cn.protection@1', 'cn.stadiumProtection@1'].includes(id) ? ['effects.trainer-hand-use'] : [])]
      .flatMap((key) => requireRule(CN_V20261019, key).sourceOfTruth),
    validateParameters, execute, ...extra,
  });
}

export function createCoreHandlers() {
  const v = validators, h = [
    handler('cn.disableOwnedAttack@1', 'attack.owned-lock', v.validateOwnedAttackLockParameters, (_ctx, p) => [p]),
    handler('cn.discardStadium@1', 'effects.stadium-discard', v.validateDiscardStadiumParameters, (_ctx, p) => [p],
      { canUse: (ctx, p) => canUseDiscardStadium(ctx, p) }),
    handler('cn.stadiumProtection@1', 'effects.stadium-discard', v.validateStadiumProtectionParameters, (_ctx, p) => [p.effect],
      { timing: 'continuous' }),
    handler('cn.distributeCounters@1', 'damage.counter-distribution', v.validateCounterDistributionParameters, (_ctx, p) => [p],
      { canUse: (ctx, p) => canUseCounterDistribution(ctx, p) }),
    handler('cn.healPokemon@1', 'effects.heal-results', v.validatePokemonHealingParameters, (_ctx, p) => [p],
      { canUse: (ctx, p) => canUsePokemonHealing(ctx, p) }),
    handler('cn.prizeExchange@1', 'effects.prize-exchange', v.validatePrizeExchangeParameters, (_ctx, p) => [p],
      { canUse: (ctx) => ctx.state.players[ctx.source.owner].prizes.length > 0 }),
    handler('cn.shuffleHandToBottom@1', 'effects.hand-bottom', v.validateShuffleHandToBottomParameters,
      (_ctx, p) => [{ op: 'shuffleHandToBottom', ...p }], { canUse: (ctx, p) => handBottomAvailable(ctx, p) }),
    handler('cn.handBottomDraw@1', 'effects.hand-bottom', v.validateHandBottomDrawParameters, (ctx, p) => [{
      op: 'then', first: { op: 'shuffleHandToBottom', side: p.side },
      next: { op: 'sequence', steps: [
        { op: 'draw', player: ctx.source.owner, count: drawCount(ctx, ctx.source.owner, p.ownDraw) },
        { op: 'draw', player: 1 - ctx.source.owner, count: drawCount(ctx, 1 - ctx.source.owner, p.opponentDraw) },
      ] },
    }], { capabilities: ['battle-values'], canUse: (ctx, p) => handBottomAvailable(ctx, p),
      sourceOfTruth: ['effects.hand-bottom', 'effects.draw', 'prizes.remaining'].flatMap((key) => requireRule(CN_V20261019, key).sourceOfTruth) }),
    handler('cn.damageValue@1', 'damage.expression', v.validateDamageValueParameters, () => [], {
      timing: 'formula', capabilities: ['resolve-attack-damage', 'damage-rolls'], damageRollVersion: '1',
      damageRolls: (_ctx, p) => p.rolls ?? [],
      damageFormula: (ctx, p) => evaluateDamageValue(p.expression, ctx.battleValues),
    }),
    handler('cn.prizeDamage@1', 'prizes.effects-count', v.validatePrizeDamageParameters, () => [], {
      timing: 'formula', capabilities: ['resolve-attack-damage'],
      damageFormula: (ctx, p) => {
        const player = p.side === 'own' ? ctx.source.owner : 1 - ctx.source.owner;
        const deckSize = Object.values(ctx.state.cards).filter((card) => card.owner === player).length;
        const count = prizesTakenForPlayer(ctx, { player, deckSize });
        const amount = BigInt(p.base) + BigInt(count) * BigInt(p.perPrize);
        if (amount > 9007199254740990n) throw new RangeError('Prize-based damage exceeds exact ten-point integer representation.');
        return Number(amount);
      },
    }),
    handler('cn.pokemonTypes@1', 'pokemon.types', v.validatePokemonTypesParameters, (_ctx, p) => [p.effect],
      { timing: 'pokemonTypes' }),
    handler('cn.inspectDeck@1', 'effects.search', v.validateInspectDeckParameters, (_ctx, p) => [p],
      { canUse: (ctx) => ctx.state.players[ctx.source.owner].deck.length > 0,
        sourceOfTruth: ['effects.search', 'effects.shuffle', 'effects.return'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth) }),
    handler('cn.attachDeckEnergy@1', 'effects.attach', v.validateAttachDeckEnergyParameters, (_ctx, p) => [p],
      { canUse: (ctx, p) => ctx.state.players[ctx.source.owner].deck.length > 0 && deckEnergyRecipients(ctx, p).length > 0,
        sourceOfTruth: ['effects.attach', 'effects.search', 'effects.shuffle', 'energy.units'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth) }),
    handler('cn.burnCounters@1', 'status.burn', v.validateBurnCountersParameters, (_ctx, p) => [p.effect],
      { timing: 'continuous' }),
    handler('cn.attackGrant@1', 'attack.grant', v.validateAttackGrantParameters, (_ctx, p) => [p], { timing: 'attackGrant' }),
    handler('cn.copyAttack@1', 'attack.copy', v.validateCopyAttackParameters, (_ctx, p) => [p]),
    handler('cn.fieldReturn@1', 'effects.field-return', v.validateFieldReturnParameters, (_ctx, p) => [p],
      { canUse: (ctx, p) => fieldReturnTargets(ctx, p).length > 0 }),
    handler('cn.pokemonTransition@1', 'effects.evolve', v.validatePokemonTransitionParameters, (_ctx, p) => [p],
      { canUse: (ctx, p) => canUsePokemonTransition(ctx, p),
        sourceOfTruth: ['effects.evolve', 'effects.devolve', 'effects.inherit'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth) }),
    handler('cn.energyRequirement@1', 'energy.requirement', v.validateEnergyRequirementParameters, (_ctx, p) => [p.effect],
      { timing: 'continuous' }),
    handler('cn.energyProvision@1', 'energy.provision', v.validateEnergyProvisionParameters, (_ctx, p) => [p.effect],
      { timing: 'energyProvision' }),
    handler('cn.energyOptions@1', 'energy.requirement.alternative', v.validateEnergyOptionsParameters, () => [],
      { timing: 'energyOptions', energyOptions: (_ctx, p) => p }),
    // Runs before damage so the attack's own formula can read the actual count.
    handler('cn.countedEnergyDiscard@1', 'damage.effect-count', v.validateCountedEnergyDiscardParameters, (_ctx, p) => [p], {
      timing: 'beforeDamage', capabilities: ['effect-card-count'],
      sourceOfTruth: ['damage.effect-count', 'energy.attached-selection', 'selection.any']
        .flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth),
    }),
    handler('cn.discardTools@1', 'effects.tool-discard', v.validateDiscardToolsParameters, (_ctx, p) => [{ op: 'discardTools', ...p }],
      { canUse: (ctx, p) => toolsFor(ctx, p).length > 0 }),
    // 「在造成伤害前，将…「宝可梦道具」放于弃牌区（，追加造成其张数×N／如果成功…则…）」: counted so the damage can read it.
    handler('cn.countedToolDiscard@1', 'damage.effect-count', v.validateDiscardToolsParameters, (_ctx, p) => [{ op: 'discardTools', ...p }], {
      timing: 'beforeDamage', capabilities: ['effect-card-count'],
      sourceOfTruth: ['damage.effect-count', 'effects.tool-discard'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth),
    }),
    handler('cn.countedCards@1', 'damage.effect-count', v.validateCountedCardsParameters, (_ctx, p) => [{ op: 'cards', ...p }], {
      timing: 'beforeDamage', capabilities: ['effect-card-count'],
      sourceOfTruth: ['damage.effect-count', 'effects.discard'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth),
    }),
    handler('cn.arrangeDeck@1', 'effects.deck-order', v.validateArrangeDeckParameters, (_ctx, p) => [{ op: 'arrangeDeck', ...p }],
      { canUse: (ctx, p) => (p.side === 'either' ? [0, 1] : [p.side === 'own' ? ctx.source.owner : 1 - ctx.source.owner])
        .some((player) => ctx.state.players[player].deck.length > 0) }),
    handler('cn.opponentHand@1', 'effects.opponent-hand', v.validateOpponentHandParameters, (_ctx, p) => [{ op: 'opponentHand', ...p }],
      { canUse: (ctx, p) => opponentHandChanges(ctx, p) }),
    // 「查看对手的手牌，造成其中训练家张数×N伤害」: the look runs before damage so the formula reads the looked-at cards.
    handler('cn.countedHandLook@1', 'damage.effect-count', v.validateOpponentHandLookParameters, (_ctx, p) => [{ op: 'opponentHand', ...p }], {
      timing: 'beforeDamage', capabilities: ['effect-card-count'],
      sourceOfTruth: ['damage.effect-count', 'effects.opponent-hand'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth),
    }),
    // 「将牌库上方N张卡牌翻到正面，造成其中X张数×N」「将弃牌区中的所有X给对手查看，造成其张数×N」: shown before damage, nothing moves.
    handler('cn.countedReveal@1', 'effects.reveal', v.validateCountedRevealParameters, (_ctx, p) => [{ op: 'revealCards', ...p }], {
      timing: 'beforeDamage', capabilities: ['effect-card-count'],
      sourceOfTruth: ['effects.reveal', 'damage.effect-count'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth),
    }),
    // 「将正面朝上的X放于弃牌区，剩余的卡牌放回牌库并重洗牌库」「然后，将给对手查看过的…放回牌库并重洗牌库」.
    handler('cn.revealedCards@1', 'effects.reveal', v.validateRevealedCardsParameters, (_ctx, p) => [{ op: 'revealedCards', ...p }]),
    // 「（双方各）将牌库上方N张卡牌放于弃牌区，追加造成其中能量张数×N」.
    handler('cn.countedDeckTop@1', 'damage.effect-count', v.validateCountedDeckTopParameters, (_ctx, p) => [{ op: 'discardDeckTop', ...p }], {
      timing: 'beforeDamage', capabilities: ['effect-card-count'],
      sourceOfTruth: ['damage.effect-count', 'effects.deck-top-discard'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth),
    }),
    // 「给这只宝可梦身上放置最多N个伤害指示物，造成放置的伤害指示物数量×M伤害」.
    handler('cn.countedSelfCounters@1', 'damage.effect-count', v.validateCountedSelfCountersParameters,
      (_ctx, p) => [{ op: 'selfCounters', maximum: p.maximum }], {
        timing: 'beforeDamage', capabilities: ['effect-card-count'],
        sourceOfTruth: ['damage.effect-count', 'damage.counters', 'selection.up-to'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth),
      }),
    // 「双方玩家，各将自己的手牌翻到正面，互相展示」.
    handler('cn.revealHands@1', 'effects.reveal', v.validateRevealHandsParameters, (_ctx, p) => [{ op: 'revealHands', ...p }],
      { canUse: (ctx) => ctx.state.players.some((player, i) => player.hand.some((id) => i !== ctx.source.owner || id !== ctx.source.instanceId)) }),
    handler('cn.attachedEnergy@1', 'energy.attached-selection', v.validateAttachedEnergyParameters, (_ctx, p) => [p],
      { canUse: (ctx, p) => canUseAttachedEnergy(ctx, p),
        sourceOfTruth: ['energy.attached-selection', 'energy.return'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth) }),
    handler('cn.deployIncoming@1', 'trigger.before-hand', v.validateEmptyParameters, () => [{ op: 'deployIncoming' }],
      { canUse: (ctx) => !!ctx.entry && def(ctx, ctx.entry.cardId).kind === 'pokemon' && benchRoom(ctx) }),
    handler('cn.attachIncoming@1', 'trigger.before-hand', v.validateAttachIncomingParameters, (_ctx, p) => [{ op: 'attachIncoming', ...p }],
      { canUse: (ctx, p) => !!ctx.entry && def(ctx, ctx.entry.cardId).kind === 'energy' && subjects(ctx, ctx.source.owner).some((m) =>
        p.target === 'bench' ? !active(ctx, ctx.source.owner, m) : matches(ctx, p.target, ctx.source.owner, m)) }),
    handler('cn.cards@1', 'effects.search', v.validateCardsParameters, (_ctx, p) => [{ op: 'cards', ...p }],
      { canUse: (ctx, p) => {
        const holder = p.side === 'opponent' ? 1 - ctx.source.owner : ctx.source.owner, player = ctx.state.players[holder];
        if (p.to === 'bench' && player.bench.length >= ctx.benchLimits[holder]) return false;
        const pool = (p.from === 'deck' && p.lookTop !== null ? player.deck.slice(-p.lookTop) : player[p.from])
          .filter((id) => p.from !== 'hand' || ctx.source.category !== 'trainer' || id !== ctx.source.instanceId)
          .filter((id) => !p.excludePaid || !paidIds(ctx).includes(id));
        // Full deck inspection is a legitimate hidden-information action;
        // public/known zones cannot be used when there is no eligible card.
        return p.from === 'deck' ? pool.length > 0 : pool.some((id) => matchesCardsMove(def(ctx, id), p));
      } }),
    handler('cn.shuffle@1', 'effects.shuffle', v.validateShuffleParameters, (_ctx, p) => [{ op: 'shuffle', ...p }],
      { canUse: (ctx, p) => ctx.state.players[p.side === 'own' ? ctx.source.owner : 1 - ctx.source.owner][p.zone].length > 0 }),
    handler('cn.switch@1', 'effects.switch', v.validateSwitchParameters, (_ctx, p) => [{ op: 'switch', ...p }],
      { canUse: (ctx, p) => {
        const player = ctx.state.players[p.side === 'own' ? ctx.source.owner : 1 - ctx.source.owner];
        // C-03—05: this is not Retreat. Protection applies to the actual
        // affected Pokémon at resolution, not to selecting a Bench Pokémon.
        // 「将自己战斗场上的【基础】宝可梦与…互换」: the current Active must be of that kind.
        return !!player.active && (!p.activeSelector || matchesInPlaySelector(def(ctx, player.active.stack.at(-1)), p.activeSelector,
          ctx.effectivePokemon[player.active.id].types)) && (p.affected === 'source' ? player.bench.some((m) => m.id === ctx.source.pokemonId)
          : player.bench.some((m) => switchCandidate(ctx, m, p)));
      }, sourceOfTruth: ['effects.switch', 'effects.activation-cost', 'effects.activation-change']
        .flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth) }),
    // 「将其与战斗宝可梦互换。然后，给新出场的宝可梦造成N伤害」: switched before damage, so the formula can require the switch.
    handler('cn.countedSwitch@1', 'damage.after-switch', v.validateCountedSwitchParameters, (_ctx, p) => [{ op: 'switch', ...p }], {
      timing: 'beforeDamage', capabilities: ['effect-card-count'],
      sourceOfTruth: ['damage.after-switch', 'damage.effect-count', 'effects.switch'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth),
    }),
    handler('cn.draw@1', 'effects.draw', v.validateDrawParameters, (ctx, p) => [{ op: 'draw', count: p.count }],
      { canUse: (ctx) => ctx.state.players[ctx.source.owner].deck.length > 0 }),
    // 「双方玩家，各从牌库上方抽取N张卡牌」「对手从牌库上方抽取N张卡牌」: the user first, then the opponent.
    handler('cn.drawPlayers@1', 'effects.draw', v.validateDrawPlayersParameters, (ctx, p) => [{ op: 'sequence', steps: [
      ...(p.own ? [{ op: 'draw', player: ctx.source.owner, count: p.own }] : []),
      { op: 'draw', player: 1 - ctx.source.owner, count: p.opponent },
    ] }], { canUse: (ctx, p) => p.own > 0 && ctx.state.players[ctx.source.owner].deck.length > 0 ||
      ctx.state.players[1 - ctx.source.owner].deck.length > 0 }),
    // 「若希望，可追加造成N伤害。在这种情况下，…」: decided before damage; the formula and later entries read the recorded choice.
    handler('cn.attackChoice@1', 'damage.optional-choice', v.validateEmptyParameters, () => [{ op: 'attackChoice' }], {
      timing: 'beforeDamage', capabilities: ['effect-card-count'],
      sourceOfTruth: ['damage.optional-choice', 'selection.optional'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth) }),
    // 「抽取卡牌，直到自己的手牌变为N张为止」: the hand when the draw happens, after any earlier part of the effect.
    handler('cn.drawUntil@1', 'effects.draw', v.validateDrawParameters, (_ctx, p) => [{ op: 'draw', untilHand: p.count }], { canUse: (ctx, p) => ctx.state.players[ctx.source.owner].deck.length > 0 && handAfterCosts(ctx, []) < p.count }),
    handler('cn.discardHand@1', 'effects.discard', v.validateEmptyParameters, () => [{ op: 'discardHand' }],
      { canUse: (ctx) => ctx.state.players[ctx.source.owner].hand.some((id) => id !== ctx.source.instanceId) }),
    handler('cn.counters@1', 'damage.counters', v.validateCountersParameters, (_ctx, p) => [{ op: 'counters', ...p }],
      { canUse: countersTarget }),
    // 「放置伤害指示物，直到其剩余HP变为「N」」: the counters op reads the remaining HP (II.D-16) when it places them.
    handler('cn.countersUntil@1', 'damage.counters', v.validateCountersUntilParameters,
      (_ctx, p) => [{ op: 'counters', side: p.side, target: p.target, untilRemainingHp: p.remainingHp }], { canUse: countersTarget }),
    // 「将与…数量相同数量的伤害指示物，放置于…」: the count when the counters are placed; none when it is 0 or less.
    handler('cn.countersValue@1', 'damage.counters', v.validateCountersValueParameters, (ctx, p) => {
      const count = countersValue(ctx, p);
      return count ? [{ op: 'counters', side: p.side, target: p.target, count }] : [];
    }, { capabilities: ['battle-values'], canUse: (ctx, p) => countersValue(ctx, p) > 0 && countersTarget(ctx, p) }),
    handler('cn.heal@1', 'effects.heal', v.validateHealParameters, (_ctx, p) => [{ op: 'heal', side: p.side ?? 'own', target: p.target,
      count: p.amount / 10, ...(p.cureAll ? { cureAll: true } : {}) }],
      { canUse: (ctx, p) => {
        const owner = p.side === 'opponent' ? 1 - ctx.source.owner : ctx.source.owner;
        return subjects(ctx, owner).some((m) => (m.counters > 0 || p.cureAll && presentConditions(m.conditions).length > 0) &&
          matches(ctx, p.target, owner, m));
      } }),
    // 「将与受到的伤害数值相同的伤害指示物，放置于使用了招式的宝可梦身上」: the firing attack-damage event's damage.
    handler('cn.countersFromDamage@1', 'damage.counters', v.validateCountersFromDamageParameters,
      (_ctx, p) => [{ op: 'counters', ...p, fromEventDamage: true }], { canUse: countersTarget }),
    // 「回复这只宝可梦与给对手战斗宝可梦造成的伤害相同数值的HP」: an attack's own damage to the opponent's Active (step 5 reads step 4).
    handler('cn.drainHeal@1', 'effects.heal', v.validateEmptyParameters, () => [{ op: 'heal', side: 'own', target: 'self', fromAttackDamage: true }]),
    handler('cn.cure@1', 'status.cure', v.validateCureParameters, (_ctx, p) => [{ op: 'cure', ...p }],
      { canUse: (ctx, p) => {
        const owner = p.side === 'opponent' ? 1 - ctx.source.owner : ctx.source.owner;
        return subjects(ctx, owner).some((m) => matches(ctx, p.target, owner, m) && presentConditions(m.conditions, p.conditions).length > 0);
      } }),
    handler('cn.condition@1', 'status.exclusive', v.validateConditionParameters, (_ctx, p) => [{ op: 'condition', target: p.target ?? 'active', ...p }]),
    handler('cn.modifier@1', 'damage.attacker', v.validateModifierParameters, (_ctx, p) => [{ op: 'modifier', ...p }],
      { timing: 'continuous' }),
    handler('cn.evolutionPermission@1', 'evolution.permission', v.validateEvolutionPermissionParameters,
      (_ctx, p) => [{ op: 'evolutionPermission', scope: 'self', ...p }], { timing: 'continuous' }),
    handler('cn.protection@1', 'effects.protection', v.validateProtectionParameters, (_ctx, p) => [p.effect],
      { timing: 'continuous' }),
    handler('cn.property@1', 'damage.ignore-defender', v.validatePropertyParameters, (_ctx, p) => [p.effect],
      { timing: 'continuous' }),
    handler('cn.conditionImmunity@1', 'status.immunity', v.validateConditionImmunityParameters, (_ctx, p) => [p.effect],
      { timing: 'continuous' }),
    handler('cn.attackDamageOptions@1', 'damage.ignore-defender', v.validateAttackDamageOptionsParameters, (_ctx, p) => [p.effect],
      { timing: 'continuous' }),
    handler('cn.damageOptions@1', 'damage.ignore-defender', v.validateDamageOptionsParameters, () => [],
      { timing: 'damageOptions', damageOptions: (_ctx, p) => p }),
    handler('cn.lasting@1', 'effects.duration.turn-only', v.validateLastingParameters, (_ctx, p) => [{ op: 'lasting', ...p }],
      { canUse: (ctx, p) => subjects(ctx, p.side === 'own' ? ctx.source.owner : 1 - ctx.source.owner).some((m) =>
        matches(ctx, p.target, p.side === 'own' ? ctx.source.owner : 1 - ctx.source.owner, m)) }),
    handler('cn.damage@1', 'attack.order', v.validateDamageParameters, (_ctx, p) => [{ op: 'damage', ...p }], {
      timing: 'damage', capabilities: ['damage-rolls'], damageRollVersion: '1', damageRolls: (_ctx, p) => p.rolls ?? [],
    }),
    handler('cn.recoilDamage@1', 'damage.self', v.validateDamageParameters, (_ctx, p) => [{ op: 'damage', ...p }], {
      timing: 'damage', capabilities: ['damage-rolls'], damageRollVersion: '1', damageRolls: (_ctx, p) => p.rolls ?? [],
    }),
    handler('cn.restriction@1', 'effects.pokemon-lock', v.validateRestrictionParameters, (_ctx, p) => [p.effect], { timing: 'continuous' }),
    handler('cn.prizeModifier@1', 'ko.prize-modifier', v.validatePrizeModifierParameters, (_ctx, p) => [p.effect], { timing: 'continuous' }),
    handler('cn.extraPrizes@1', 'ko.prize-modifier', v.validateExtraPrizesParameters, (_ctx, p) => [{ op: 'extraPrizes', ...p }]),
    handler('cn.playerRestriction@1', 'effects.player-lock', v.validatePlayerRestrictionParameters, (_ctx, p) => [p.effect], { timing: 'continuous' }),
    handler('cn.suppression@1', 'effects.remove-content', v.validateSuppressionParameters, (_ctx, p) => [p.effect], { timing: 'suppression' }),
    // A player effect always adds something to the game, so it is always a change.
    handler('cn.lastingPlayer@1', 'effects.player-lock', v.validateLastingPlayerParameters, (_ctx, p) => [{ op: 'lastingPlayer', ...p }],
      { canUse: () => true }),
    handler('cn.delayedReaction@1', 'trigger.damage', v.validateDelayedReactionParameters, (_ctx, p) => [{ op: 'delayedReaction', ...p }],
      { embeddedOperations: REACTION_OPERATIONS }),
    handler('cn.transferCounters@1', 'damage.counters', v.validateTransferCountersParameters, (_ctx, p) => [{ op: 'transferCounters', ...p }],
      { canUse: (ctx, p) => subjects(ctx, ctx.source.owner).some((m) => m.counters > 0 &&
        (p.from !== 'self' || m.id === ctx.source.pokemonId) && (p.from !== 'active' || active(ctx, ctx.source.owner, m)) &&
        (p.from !== 'bench' || !active(ctx, ctx.source.owner, m)) &&
        (!p.originSelector || matchesInPlaySelector(def(ctx, m.stack.at(-1)), p.originSelector, ctx.effectivePokemon[m.id].types)) &&
        subjects(ctx, p.side === 'own' ? ctx.source.owner : 1 - ctx.source.owner).some((target) =>
          target.id !== m.id && (p.target !== 'active' || target === ctx.state.players[p.side === 'own' ? ctx.source.owner : 1 - ctx.source.owner].active))) }),
    handler('cn.attackPermissions@1', 'attack.first-turn', v.validatePermissionsParameters, () => [],
      { timing: 'permission', permissions: (_ctx, p) => p.permissions }),
    handler('cn.attachDiscard@1', 'effects.attach', v.validateAttachDiscardParameters, (_ctx, p) => [{ op: 'attachDiscard', ...p }],
      { canUse: (ctx, p) => attachTargets(ctx, p).length > 0 &&
        ctx.state.players[ctx.source.owner].discard.some((id) => effectAttachable(def(ctx, id), p, 'discard')) }),
    handler('cn.attachHand@1', 'effects.attach', v.validateAttachDiscardParameters, (_ctx, p) => [{ op: 'attachHand', ...p }],
      { canUse: (ctx, p) => attachTargets(ctx, p).length > 0 &&
        ctx.state.players[ctx.source.owner].hand.some((id) => effectAttachable(def(ctx, id), p, 'hand')) }),
    handler('cn.discardDeckTop@1', 'effects.deck-top-discard', v.validateDiscardDeckTopParameters, (_ctx, p) => [{ op: 'discardDeckTop', ...p }],
      { canUse: (ctx, p) => ctx.state.players[p.side === 'own' ? ctx.source.owner : 1 - ctx.source.owner].deck.length > 0 }),
    handler('cn.replacePokemon@1', 'effects.replace', v.validateReplacePokemonParameters, (_ctx, p) => [p],
      { canUse: (ctx) => ctx.state.players[ctx.source.owner].deck.length > 0 &&
        subjects(ctx, ctx.source.owner).some((m) => m.id === ctx.source.pokemonId),
        sourceOfTruth: ['effects.replace', 'effects.search', 'effects.shuffle'].flatMap((key) => requireRule(CN_V20261019, key).sourceOfTruth) }),
    handler('cn.benchLimit@1', 'bench.limit', v.validateBenchLimitParameters, (_ctx, p) => [p.effect], { timing: 'continuous' }),
    handler('cn.takePrizes@1', 'prizes.take-effect', v.validateTakePrizesParameters, (_ctx, p) => [{ op: 'takePrizes', ...p }],
      { canUse: (ctx) => ctx.state.players[ctx.source.owner].prizes.length > 0 }),
    handler('cn.knockOut@1', 'effects.knockout', v.validateKnockOutParameters, (_ctx, p) => [{ op: 'knockOut', ...p }],
      { canUse: (ctx, p) => {
        const owner = p.side === 'opponent' ? 1 - ctx.source.owner : ctx.source.owner;
        return subjects(ctx, owner).some((m) => matches(ctx, p.target, owner, m) && switchCandidate(ctx, m, p));
      } }),
  ];
  const leaves = new Map(h.map((entry) => [entry.id, entry]));
  const nested = (n) => leaves.get(n.handlerId);
  const program = (ctx, n) => ({ op: 'sequence', steps: nested(n).execute(ctx, n.parameters) });
  const usable = (ctx, n) => !nested(n).canUse || nested(n).canUse(ctx, n.parameters);
  const thenProgram = (ctx, p) => ({ op: 'then', first: program(ctx, p.first), next: program(ctx, p.next) });
  // A nested leaf, or one 「A。在这种情况下，B」 pair.
  const thenOrLeaf = (ctx, n) => n.handlerId === 'cn.then@1' ? { op: 'sequence', steps: [thenProgram(ctx, n.parameters)] } : program(ctx, n);
  const thenOrLeafUsable = (ctx, n) => usable(ctx, n.handlerId === 'cn.then@1' ? n.parameters.first : n);
  h.push(
    handler('cn.handDeckDraw@1', 'effects.hand-deck', v.validateHandDeckDrawParameters, (ctx, p) => [{
      op: 'then', first: { op: 'shuffleHandIntoDeck', side: p.side },
      next: { op: 'sequence', steps: [
        { op: 'draw', player: ctx.source.owner, count: drawCount(ctx, ctx.source.owner, p.ownDraw) },
        { op: 'draw', player: 1 - ctx.source.owner, count: drawCount(ctx, 1 - ctx.source.owner, p.opponentDraw) },
      ] },
    }], { capabilities: ['battle-values'], canUse: (ctx, p) => handDeckAvailable(ctx, p),
      sourceOfTruth: ['effects.hand-deck', 'effects.draw', 'prizes.remaining'].flatMap((key) => requireRule(CN_V20261019, key).sourceOfTruth) }),
    // The count is the actual resolution-time board, like drawUntil's hand size.
    handler('cn.drawPokemonCount@1', 'effects.draw', v.validateDrawPokemonCountParameters, (ctx, p) => [{
      op: 'draw', count: inPlayCount(ctx, p.side),
    }], { canUse: (ctx, p) => ctx.state.players[ctx.source.owner].deck.length > 0 && inPlayCount(ctx, p.side) > 0 }),
    handler('cn.drawValue@1', 'effects.draw', v.validateDrawValueParameters, (ctx, p) => [{ op: 'draw', count: drawValue(ctx, p) }],
      { capabilities: ['battle-values'], canUse: (ctx, p) => ctx.state.players[ctx.source.owner].deck.length > 0 && drawValue(ctx, p) > 0 }),
    handler('cn.cardsThenDraw@1', 'effects.partial', v.validateCardsThenDrawParameters, (_ctx, p) => [{
      op: 'then', first: { op: 'cards', ...p.cards }, next: { op: 'draw', count: p.draw },
    }], { canUse: (ctx, p) => leaves.get('cn.cards@1').canUse(ctx, p.cards),
      sourceOfTruth: ['effects.partial', 'effects.search', 'effects.discard', 'effects.draw']
        .flatMap((key) => requireRule(CN_V20261019, key).sourceOfTruth) }),
    // II.E-19: the draw happens only when at least one card was attached.
    handler('cn.attachThenDraw@1', 'effects.partial', v.validateAttachThenDrawParameters, (_ctx, p) => [{
      op: 'then', first: { op: p.from === 'hand' ? 'attachHand' : 'attachDiscard', ...p.attach }, next: { op: 'draw', count: p.draw },
    }], { canUse: (ctx, p) => leaves.get(p.from === 'hand' ? 'cn.attachHand@1' : 'cn.attachDiscard@1').canUse(ctx, p.attach),
      sourceOfTruth: ['effects.partial', 'effects.attach', 'effects.draw'].flatMap((key) => requireRule(CN_V20261019, key).sourceOfTruth) }),
  );
  leaves.set('cn.cardsThenDraw@1', h.at(-2));
  h.push(
    handler('cn.coin@1', 'effects.coin', validateCoinEffect, (ctx, p) => [{
      op: 'coin', outcome: p.outcome, effect: p.effects
        ? { op: 'sequence', steps: p.effects.flatMap((n) => nested(n).execute(ctx, n.parameters)) } : program(ctx, p.effect),
      ...(p.otherwise ? { otherwise: program(ctx, p.otherwise) } : {}),
    }], { canUse: (ctx, p) => [...(p.effects ?? [p.effect]), ...(p.otherwise ? [p.otherwise] : [])].some((n) => usable(ctx, n)) }),
    handler('cn.coins@1', 'effects.coin-count', validateCoinsEffect, (ctx, p) => [{
      op: 'coins', flips: p.flips, face: p.face, effect: program(ctx, p.effect),
      apply: p.apply.kind === 'scale' ? { kind: 'scale', path: SCALED_FIELDS[p.effect.handlerId] } : p.apply,
    }], { canUse: (ctx, p) => usable(ctx, p.effect) }),
    // 「若希望，可…。在这种情况下，追加造成N伤害」: before damage; declining records no moved card.
    handler('cn.optionalCounted@1', 'damage.effect-count', validateOptionalCountedEffect, (ctx, p) => [{
      op: 'optional', effect: program(ctx, p.effect),
    }], { timing: 'beforeDamage', capabilities: ['effect-card-count'],
      sourceOfTruth: ['damage.effect-count', 'selection.optional'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth) }),
    // II.E-38 文例3: decided by the coins this attack's own damage already flipped.
    handler('cn.coinResult@1', 'effects.coin-result', validateCoinResultEffect, (ctx, p) => [{
      op: 'coinResult', condition: p.condition, effect: p.effects
        ? { op: 'sequence', steps: p.effects.flatMap((n) => nested(n).execute(ctx, n.parameters)) } : program(ctx, p.effect),
      ...(p.otherwise ? { otherwise: program(ctx, p.otherwise) } : {}),
    }], { capabilities: ['damage-roll-results'] }),
    // 「如果…，则…」: judged on the board when this instruction is reached; unmet with no printed other result, nothing changes.
    handler('cn.when@1', 'effects.condition', validateWhenEffect, (ctx, p) => [{
      op: 'when', condition: p.condition, effect: p.effects
        ? { op: 'sequence', steps: p.effects.flatMap((n) => nested(n).execute(ctx, n.parameters)) } : program(ctx, p.effect),
      ...(p.otherwise ? { otherwise: program(ctx, p.otherwise) } : {}),
    }], { capabilities: ['battle-values', 'board-condition'],
      canUse: (ctx, p) => evaluateBattlePredicate(p.condition, ctx.battleValues)
        ? (p.effects ?? [p.effect]).some((n) => usable(ctx, n)) : Boolean(p.otherwise) && usable(ctx, p.otherwise) }),
    // II.E-10: the user may decline the whole effect; declining performs nothing (and so unlocks no then).
    // 「若希望，可A。在这种情况下，B」: declining A performs nothing, and B needs A performed (cn.then@1).
    handler('cn.optional@1', 'selection.optional', validateOptionalEffect, (ctx, p) => [{
      op: 'optional', effect: p.effect.handlerId === 'cn.then@1' ? { op: 'sequence', steps: [thenProgram(ctx, p.effect.parameters)] } : program(ctx, p.effect),
    }], { canUse: (ctx, p) => usable(ctx, p.effect.handlerId === 'cn.then@1' ? p.effect.parameters.first : p.effect) }),
    handler('cn.orElse@1', 'effects.or-else', validateOrElseEffect, (ctx, p) => [{
      op: 'orElse', first: program(ctx, p.first), otherwise: program(ctx, p.otherwise),
    }], { canUse: (ctx, p) => usable(ctx, p.first) || usable(ctx, p.otherwise) }),
    // II.E-19 FAQ2: if the part before 然后 cannot be performed at all, the whole instruction changes nothing.
    // I.B-04: declared by the current player, once per own turn for this card's key.
    handler('cn.stadiumUse@1', 'stadium.use', validateStadiumUseEffect, (ctx, p) => [thenOrLeaf(ctx, p.effect)], {
      timing: 'onUse', usageFor: (p) => ({ period: 'turn', scope: 'player', key: p.key, limit: 1 }),
      canUse: (ctx, p) => thenOrLeafUsable(ctx, p.effect),
      sourceOfTruth: ['stadium.use', 'effects.search', 'effects.deploy'].flatMap((key) => requireRule(CN_V20261019, key).sourceOfTruth) }),
    handler('cn.then@1', 'effects.partial', validateThenEffect, (ctx, p) => [thenProgram(ctx, p)], { canUse: (ctx, p) => usable(ctx, p.first),
      sourceOfTruth: ['effects.partial', 'effects.switch', 'energy.move'].flatMap((key) => requireRule(CN_V20261019, key).sourceOfTruth) }),
    // 「从2个效果中选择1个使用」: the user picks one printed option that could change something now (effects.choose-one).
    handler('cn.countValue@1', 'effects.count-value', validateCountValueEffect, (ctx, p) => {
      const n = resolvedCount(ctx, p);
      return n ? leaves.get(p.effect.handlerId).execute(ctx, withCount(p.effect, n)) : [];
    }, { capabilities: ['battle-values'], canUse: (ctx, p) => {
      const n = resolvedCount(ctx, p), leaf = leaves.get(p.effect.handlerId);
      return n > 0 && (!leaf.canUse || leaf.canUse(ctx, withCount(p.effect, n)));
    } }),
    handler('cn.chooseOne@1', 'effects.choose-one', validateChooseOneEffect, (ctx, p) => [{ op: 'choose',
      options: p.options.map((o) => (Array.isArray(o) ? o : [o])).map((entries) => ({
        entries: entries.map((n) => ({ handlerId: n.handlerId, parameters: n.parameters })),
        effect: { op: 'sequence', steps: entries.flatMap((n) => n.handlerId === 'cn.then@1' ? [thenProgram(ctx, n.parameters)] :
          h.find((x) => x.id === n.handlerId).execute(ctx, n.parameters)) } })) }],
    { canUse: (ctx, p) => p.options.some((o) => (Array.isArray(o) ? o : [o]).some((n) => {
      const entry = h.find((x) => x.id === n.handlerId);
      return !entry.canUse || entry.canUse(ctx, n.parameters);
    })) }),
    // 「其张数」「与其相同张数」「其中的…」: B is bound to the cards A actually moved (effects.moved-cards).
    handler('cn.thenMoved@1', 'effects.moved-cards', validateThenMovedEffect, (ctx, p) => {
      const leaf = (n) => {
        const steps = nested(n).execute(ctx, n.parameters);
        if (steps.length !== 1) throw new TypeError('A moved-card instruction composes single leaves.');
        return steps[0];
      };
      const next = leaf(p.next);
      return [{ op: 'thenMoved', first: leaf(p.first), next: p.use === 'cards' ? { ...next, among: 'moved' } : next, use: p.use,
        ...(p.use === 'count' ? { path: SCALED_FIELDS[p.next.handlerId] } : {}) }];
    }, { canUse: (ctx, p) => usable(ctx, p.first),
      sourceOfTruth: ['effects.partial', 'effects.moved-cards'].flatMap((key) => requireRule(CN_V20261019, key).sourceOfTruth) }),
  );
  // Candidate-count checks for hand-only costs. The host separately proves a
  // possible actual change with the real source/protection, never merely that
  // an Active/Bench or damaged target exists. Cross-source cost dependencies
  // cannot be inferred from this local candidate predicate alone.
  const independent = new Set(['cn.draw@1', 'cn.counters@1', 'cn.countersUntil@1', 'cn.heal@1', 'cn.lasting@1', 'cn.transferCounters@1', 'cn.switch@1',
    'cn.deployIncoming@1', 'cn.attachIncoming@1', 'cn.inspectDeck@1', 'cn.attachDeckEnergy@1', 'cn.prizeExchange@1', 'cn.healPokemon@1',
    'cn.distributeCounters@1', 'cn.discardStadium@1', 'cn.drawPokemonCount@1', 'cn.discardTools@1', 'cn.opponentHand@1',
    'cn.lastingPlayer@1', 'cn.arrangeDeck@1', 'cn.cure@1', 'cn.knockOut@1', 'cn.drawPlayers@1', 'cn.condition@1', 'cn.attachedEnergy@1']);
  // A computed draw count that reads no hand or discard pile is the same before and after a hand cost is paid.
  const handFree = (value) => !/"zone":"(hand|discard)"/.test(JSON.stringify(value));
  return new Map(h.map((entry) => {
    let canUseWithCosts;
    if (independent.has(entry.id)) canUseWithCosts = (ctx, p) => entry.canUse(ctx, p);
    if (['cn.shuffleHandToBottom@1', 'cn.handBottomDraw@1'].includes(entry.id))
      canUseWithCosts = (ctx, p, costs) => handBottomAvailable(ctx, p, costs);
    if (entry.id === 'cn.handDeckDraw@1') canUseWithCosts = (ctx, p, costs) => handDeckAvailable(ctx, p, costs);
    if (entry.id === 'cn.drawUntil@1') canUseWithCosts = (ctx, p, costs) =>
      ctx.state.players[ctx.source.owner].deck.length > 0 && handAfterCosts(ctx, costs) < p.count;
    if (entry.id === 'cn.discardHand@1') canUseWithCosts = (ctx, _p, costs) => handAfterCosts(ctx, costs) > 0;
    if (entry.id === 'cn.drawValue@1') canUseWithCosts = (ctx, p) => entry.canUse(ctx, p);
    if (entry.id === 'cn.shuffle@1') canUseWithCosts = (ctx, p, costs) => p.zone === 'hand' &&
      (p.side === 'own' ? ctx.source.owner : 1 - ctx.source.owner) === ctx.activation.player ?
      handAfterCosts({ ...ctx, source: { ...ctx.source, owner: ctx.activation.player } }, costs) > 0 : entry.canUse(ctx, p);
    if (entry.id === 'cn.cards@1') canUseWithCosts = (ctx, p, costs) => {
      if (p.side) return entry.canUse(ctx, p);
      if (p.to === 'bench' && !benchRoom(ctx)) return false;
      // Cards this activation discards as its cost are never eligible when excluded.
      if (ctx.activation.player !== ctx.source.owner || p.from === 'deck' || p.excludePaid) return entry.canUse(ctx, p);
      const pool = costCards(ctx);
      if (p.from === 'hand') return pool.some((card) => matchesCardsMove(card.definition, p) &&
        findCostPayment(costs, pool, { reserveIds: [card.instanceId] }) !== null);
      return entry.canUse(ctx, p) || pool.some((card) => discardDestination(card.definition) === 'discard' &&
        matchesCardsMove(card.definition, p) &&
        findCostPayment(costs, pool, { requiredIds: [card.instanceId] }) !== null);
    };
    if (['cn.attachHand@1', 'cn.attachDiscard@1'].includes(entry.id)) canUseWithCosts = (ctx, p, costs) => {
      const owner = ctx.source.owner;
      if (!attachTargets(ctx, p).length) return false;
      if (ctx.activation.player !== owner) return entry.canUse(ctx, p);
      const pool = costCards(ctx), zone = entry.id === 'cn.attachHand@1' ? 'hand' : 'discard';
      return (entry.id === 'cn.attachDiscard@1' && entry.canUse(ctx, p)) || pool.some((card) =>
        effectAttachable(card.definition, p, zone) && findCostPayment(costs, pool,
          entry.id === 'cn.attachHand@1' ? { reserveIds: [card.instanceId] } : { requiredIds: [card.instanceId] }) !== null);
    };
    // costCheckApplies: the parameters for which the post-cost proof holds (else a paid activation is unsupported).
    const costCheckApplies = entry.id === 'cn.drawValue@1' ? (p) => handFree(p.count) : null;
    return [entry.id, canUseWithCosts ? Object.freeze({ ...entry, costCheckVersion: '1', canUseWithCosts,
      ...(costCheckApplies ? { costCheckApplies } : {}) }) : entry];
  }));
}
