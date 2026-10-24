// Source-reviewed reusable primitives, not a text parser and not card approvals.
import * as validators from './schema-validators.js';
import { CN_V20261019 } from './zh-CN/V20261019.js';
import { requireRule } from './registry.js';
import { matchesCardSelector, matchesCardsMove, alternativeTotal } from './card-selection.js';
import { matchesInPlaySelector, matchesPokemonState, enterLocked } from './in-play-selection.js';
import { costCardCount, findCostPayment, HAND_COST_KINDS, DECK_COST_KINDS } from './activation-cost.js';
import { canUseAttachedEnergy, effectAttachable } from './energy-selection.js';
import { canUsePokemonTransition } from './evolution.js';
import { fieldReturnTargets, attachedReturnHolders } from './field-return.js';
import { deckEnergyRecipients } from './deck-energy.js';
import { prizesTakenForPlayer } from './prize-count.js';
import { evaluateDamageValue, evaluateBattleValue } from './battle-value.js';
import { evaluateBattlePredicate } from './battle-predicate.js';
import { presentConditions } from './conditions.js';
import { canUsePokemonHealing } from './healing.js';
import { canUseCounterDistribution } from './counter-distribution.js';
import { canUseDiscardStadium } from './field-cards.js';
import { discardDestination } from './discard-policy.js';
import jsonEqual from './json-equal.js';
import { ongoingIsActive } from './ongoing.js';

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
  (costs.length && ctx.activation.player === ctx.source.owner ? costCardCount(costs, HAND_COST_KINDS) : 0);
// 「如果将自己的1张手牌放回牌库下方的话」: the paid cards are in the deck before the effect draws.
const deckAfterCosts = (ctx, costs) => ctx.state.players[ctx.source.owner].deck.length +
  (costs.length && ctx.activation.player === ctx.source.owner ? costCardCount(costs, DECK_COST_KINDS) : 0);
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
// 「然后，（双方玩家各）抛掷1次硬币，如果为正面则抽取N张，如果为反面，则抽取M张」: the drawing player's own coin, flipped
// when its draw is reached (after the hands went back).
const drawStep = (ctx, player, spec) => spec?.kind === 'flip'
  ? { op: 'coin', outcome: 'heads', ...(player === ctx.source.owner ? {} : { player }),
    effect: { op: 'draw', player, count: spec.heads }, otherwise: { op: 'draw', player, count: spec.tails } }
  : { op: 'draw', player, count: drawCount(ctx, player, spec) };
// One player's part of a both-players draw: until N in hand, up to N (upTo), shown to both (reveal); with 「若希望，可各…」
// (optional) that player decides whether to draw at all, the opponent for itself (II.E-10).
const drawFor = (ctx, p, player, n) => {
  const draw = { op: 'draw', player, ...(p.until ? { untilHand: n } : { count: n }), ...(p.upTo ? { upTo: true } : {}), ...(p.reveal ? { reveal: true } : {}) };
  return p.optional ? { op: 'optional', ...(player === ctx.source.owner ? {} : { chooser: 'opponent' }), effect: draw } : draw;
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
// Alternative limits fix the total: their sum, or the largest limit when the alternatives exclude each other.
const validCards = (p) => validators.validateCardsParameters(p) &&
  (!p.alternativeLimits || p.quantity.count === alternativeTotal(p.alternativeLimits, p.exclusiveAlternatives));
const benchRoom = (ctx) => ctx.state.players[ctx.source.owner].bench.length < ctx.benchLimits[ctx.source.owner];
// effects.enter-lock: a Pokémon card its holder may put into play now; ctx.enterLocks are each player's actual current locks.
const enterable = (ctx, holder, definition) => !enterLocked(definition, ctx.enterLocks[holder]);
// The cards a cn.cards@1 move may take: the printed kind (II.C-11 for the Bench), and onto a Bench only what may enter it.
const movable = (ctx, p, holder, definition) => matchesCardsMove(definition, p) && (p.to !== 'bench' || enterable(ctx, holder, definition));
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
// A counted placement is on one Pokémon (no all/targets), so the record is the number placed on it.
const validCountedCounters = (p) => validators.validateCountedCountersParameters(p) && !p.all && !p.targets;
// 「与…数量相同数量」: a leaf written for a count of one; the host puts the resolution-time value in that field.
// 「将与…数量相同数量的伤害指示物从选择的宝可梦身上移除」: a heal of 10 per counter (II.C-06: 回复HP = removing damage counters).
const VALUE_FIELDS = Object.freeze({ 'cn.counters@1': 'count', 'cn.distributeCounters@1': 'count', 'cn.discardDeckTop@1': 'count',
  'cn.attachDiscard@1': 'count', 'cn.attachHand@1': 'count', 'cn.cards@1': 'quantity', 'cn.opponentHand@1': 'quantity', 'cn.heal@1': 'amount' });
const resolvedCount = (ctx, p) => Math.max(0, evaluateBattleValue(p.count, ctx.battleValues));
const resolvedFlips = (ctx, p) => Math.max(0, evaluateBattleValue(p.flips.value, ctx.battleValues));
const withCount = (n, value) => VALUE_FIELDS[n.handlerId] === 'count' ? { ...n.parameters, count: value }
  : VALUE_FIELDS[n.handlerId] === 'amount' ? { ...n.parameters, amount: value * 10 }
    : { ...n.parameters, quantity: { ...n.parameters.quantity, count: value } };
// The leaf a computed count resolves to, or null when there is nothing to do: 「查看对手的手牌，选择其中最多与…相同数量的…」
// still looks at the hand when the count is 0 (II.C-20 文例1: the look itself is an action).
const valuedLeaf = (ctx, p) => {
  const n = resolvedCount(ctx, p);
  return n > 0 ? withCount(p.effect, n) : p.effect.handlerId === 'cn.opponentHand@1' && p.effect.parameters.mode === 'look' ? { mode: 'look' } : null;
};
// Control handlers compose these reviewed static leaves only. Each leaf keeps
// its own validator; module-level functions keep native identity stable. A leaf's
// program is fixed when the control handler runs, so every leaf here must build it
// from its parameters alone: a leaf that reads the board while compiling
// (drawPokemonCount) would see the board before an earlier step of a then changed it.
// drawUntil's hand size is read by its draw operation itself; 「最多N张」 (upTo) belongs to cn.draw@1 only.
const fixedDraw = (p) => validators.validateDrawParameters(p) && !p.upTo;
const NESTED_VALIDATORS = Object.freeze({
  'cn.drawUntil@1': fixedDraw,
  'cn.switch@1': validators.validateSwitchParameters, 'cn.condition@1': validators.validateConditionParameters,
  'cn.attachedEnergy@1': validators.validateAttachedEnergyParameters, 'cn.cards@1': validCards,
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
  'cn.prizeZone@1': validators.validatePrizeZoneParameters,
  'cn.handDeckSwap@1': validators.validateEmptyParameters, 'cn.returnSelf@1': validators.validateReturnSelfParameters,
  'cn.discardSelf@1': validators.validateEmptyParameters,
  'cn.gameResult@1': validators.validateGameResultParameters,
  // 「…则双方玩家各从牌库上方抽取卡牌，直到手牌变为7张为止」: each draw reads its player's hand itself; 「若希望」 only as an entry of its own.
  'cn.drawPlayers@1': (p) => validators.validateDrawPlayersParameters(p) && !p.optional,
  // 「然后，将双方战斗宝可梦身上放置的伤害指示物，全部互换」: the counts are read when the swap happens.
  'cn.swapCounters@1': validators.validateEmptyParameters,
});
// A then's parts are single leaves; a nested then (cardsThenDraw) and both players' draws (a sequence) stay outside.
const THEN_NESTED = Object.freeze(Object.keys(NESTED_VALIDATORS).filter((id) => !['cn.cardsThenDraw@1', 'cn.drawPlayers@1'].includes(id)));
const LEAF_OPERATIONS = Object.freeze(['switch', 'condition', 'discardEnergy', 'moveEnergy', 'returnEnergy', 'cards', 'draw',
  'lasting', 'lastingPlayer', 'heal', 'healPokemon', 'counters', 'discardStadium', 'returnPokemon', 'returnAttached', 'attachDeckEnergy',
  'attachHand', 'attachDiscard', 'discardDeckTop', 'evolvePokemon', 'devolvePokemon', 'inheritPokemon', 'discardTools', 'opponentHand', 'arrangeDeck',
  'cure', 'knockOut', 'takePrizes', 'lookPrizes', 'flipPrizes', 'swapPrizeDeck', 'resetPrizes', 'prizeHandSwap', 'deckTopToPrizes',
  'swapHandDeckTop', 'returnSelf', 'gameResult', 'discardSelf', 'swapCounters', 'discardPrizes']);
const NESTED_OPERATIONS = Object.freeze([...LEAF_OPERATIONS, 'then']);
// Whole-hand and deck shuffles an optional may offer (「若希望，可令对手重洗其牌库」).
const HAND_SHUFFLES = Object.freeze(['cn.handDeckDraw@1', 'cn.shuffle@1']);
// 「反面朝上的奖赏卡」 (prizes.face-up): Prizes not turned face up by an effect.
const facedownPrizes = (p) => p.prizes.filter((id) => !(p.faceUpPrizes ?? []).includes(id));
const nestedValid = (n) => NESTED_VALIDATORS[n.handlerId](n.parameters);
// A whole-hand pair inside another instruction: printed counts only (its program is fixed when the outer one starts).
const fixedHandDeck = (p) => validators.validateHandDeckDrawParameters(p) && typeof p.ownDraw === 'number' && typeof p.opponentDraw === 'number' &&
  !p.optional;
// A counted number of targets belongs to packets for the opponent's Pokémon, never 「给这只宝可梦也造成」.
const validRecoil = (p) => validators.validateDamageParameters(p) && typeof p.selection.count !== 'object';
export function validateHandSupporterEffect(p) {
  return validators.validateHandSupporterEffectParameters(p) && nestedValid(p.effect.replacement);
}
export function validateCoinEffect(p) {
  return validators.validateCoinParameters(p) && [...(p.effects ?? [p.effect]), ...(p.otherwise ? [p.otherwise] : [])]
    .every((n) => n.handlerId === 'cn.chooseOne@1' ? validateChooseOneEffect(n.parameters) :
      n.handlerId === 'cn.handDeckDraw@1' ? fixedHandDeck(n.parameters) : nestedValid(n));
}
// 「与出现正面次数相同数量」: a leaf written for one such flip; the host multiplies this field.
const SCALED_FIELDS = Object.freeze({
  'cn.draw@1': 'count', 'cn.counters@1': 'count', 'cn.discardDeckTop@1': 'count', 'cn.attachDiscard@1': 'count', 'cn.heal@1': 'count',
  'cn.cards@1': 'quantity', 'cn.attachedEnergy@1': 'quantity', 'cn.attachDeckEnergy@1': 'quantity', 'cn.opponentHand@1': 'quantity',
});
export function validateCoinsEffect(p) {
  // 「如果至少出现1次「正面」的话，则从…中选择1个」: all/atLeast may lead to one choice (nothing to scale).
  return validators.validateCoinsParameters(p) && (p.effect.handlerId === 'cn.chooseOne@1' ? validateChooseOneEffect(p.effect.parameters)
    : nestedValid(p.effect)) && (p.apply.kind !== 'scale' ||
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
  // 「若希望，可将自己牌库上方最多5张卡牌放于弃牌区」; 「若希望，可以在造成伤害前，选择自己手牌中任意数量的…，附着于这只宝可梦身上」.
  return handlerId === 'cn.attachedEnergy@1' ? ['discardEnergy', 'returnEnergy'].includes(e.op) && e.side === 'own' :
    handlerId === 'cn.cards@1' ? ['hand', 'deck'].includes(e.from) && e.to === 'discard' :
    handlerId === 'cn.prizeZone@1' ? e.op === 'flipPrizes' && e.count === 1 :
    handlerId === 'cn.discardTools@1' || handlerId === 'cn.discardDeckTop@1' ? !e.stadium && !e.to :
    ['cn.discardStadium@1', 'cn.attachHand@1'].includes(handlerId);
}
export function validateCoinResultEffect(p) {
  return validators.validateCoinResultParameters(p) && coinFactsOnly(p.condition) &&
    [...(p.effects ?? [p.effect]), ...(p.otherwise ? [p.otherwise] : [])].every(nestedValid);
}
// 「若…，则改为多获得3张」: in an attack the extra Prize cards themselves may depend on the condition (placement keeps it to attacks).
const whenLeafValid = (n) => n.handlerId === 'cn.extraPrizes@1' ? validators.validateExtraPrizesParameters(n.parameters) : nestedValid(n);
export function validateJankenEffect(p) {
  return validators.validateJankenParameters(p) && (p.effects ?? [p.effect]).every(nestedValid);
}
export function validateWhenEffect(p) {
  return validators.validateWhenParameters(p) && [...(p.effects ?? [p.effect]), ...(p.otherwise ? [p.otherwise] : [])].every(whenLeafValid);
}
export function validateOptionalEffect(p) {
  return validators.validateOptionalParameters(p) && (p.effect.handlerId === 'cn.then@1' ? nestedThenValid(p.effect.parameters) :
    p.effect.handlerId === 'cn.handDeckDraw@1' ? fixedHandDeck(p.effect.parameters) :
    p.effect.handlerId === 'cn.shuffle@1' ? validators.validateShuffleParameters(p.effect.parameters) : nestedValid(p.effect));
}
// 「将这张卡牌放回牌库下方／放于放逐区」 (to): the card never becomes a Pokémon, so nothing after it reads 「这只宝可梦」.
const readsSelf = (n) => /"(target|from|position)":"self"/.test(JSON.stringify(n));
export function validateDeploySelfEffect(p) {
  return validators.validateDeploySelfParameters(p) && (!p.next || !(p.to && readsSelf(p.next)) &&
    (p.next.handlerId === 'cn.coin@1' ? validateCoinEffect(p.next.parameters) : nestedValid(p.next)));
}
export function validateDeployIncomingThenEffect(p) {
  return validators.validateDeployIncomingThenParameters(p) && (p.next.handlerId === 'cn.coin@1' ? validateCoinEffect(p.next.parameters) : nestedValid(p.next));
}
export function validateOrElseEffect(p) {
  return validators.validateOrElseParameters(p) && nestedValid(p.first) && nestedValid(p.otherwise);
}
const thenOrLeafValid = (n) => n.handlerId === 'cn.then@1' ? nestedThenValid(n.parameters) : nestedValid(n);
// 「可将自己的手牌全部放回牌库并重洗牌库。在这种情况下，可从…抽取5张」, 「可抛掷1次硬币。如果为正面，则…」,
// 「在这个回合，从手牌使出了支援者的玩家，可…」: a whole-hand pair with printed counts, one coin or one condition.
const STADIUM_CONTROLS = Object.freeze({
  'cn.handDeckDraw@1': (p) => fixedHandDeck(p),
  'cn.coin@1': (p) => validateCoinEffect(p), 'cn.when@1': (p) => validateWhenEffect(p),
});
export function validateStadiumUseEffect(p) {
  return validators.validateStadiumUseParameters(p) &&
    (Object.hasOwn(STADIUM_CONTROLS, p.effect.handlerId) ? STADIUM_CONTROLS[p.effect.handlerId](p.effect.parameters) : thenOrLeafValid(p.effect));
}
// A ◆ option may also be a whole-hand pair with printed counts (「将自己的所有手牌放回牌库并重洗牌库。然后，从牌库上方抽取5张卡牌」)
// or 「将自己所有的手牌放于弃牌区」 followed by more entries.
const choiceEntryValid = (n) => n.handlerId === 'cn.discardHand@1' ? validators.validateEmptyParameters(n.parameters) :
  ['cn.handDeckDraw@1', 'cn.handBottomDraw@1'].includes(n.handlerId) ?
    (n.handlerId === 'cn.handDeckDraw@1' ? validators.validateHandDeckDrawParameters : validators.validateHandBottomDrawParameters)(n.parameters) &&
    typeof n.parameters.ownDraw === 'number' && typeof n.parameters.opponentDraw === 'number' && !n.parameters.optional : thenOrLeafValid(n);
export function validateChooseOneEffect(p) {
  return validators.validateChooseOneParameters(p) && p.options.every((o) => (Array.isArray(o) ? o : [o]).every(choiceEntryValid)) &&
    new Set(p.options.map((n) => JSON.stringify(n))).size === p.options.length;
}
// A then inside another instruction (optional, a ◆ option, a Stadium use).
function nestedThenValid(p) {
  // 「…。然后，抛掷1次硬币如果为正面，则…」: the next part may be one coin.
  if (!Array.isArray(p.next) && p.next?.handlerId === 'cn.coin@1')
    return validators.validateThenParameters(p) && THEN_NESTED.includes(p.first.handlerId) && nestedValid(p.first) && validateCoinEffect(p.next.parameters);
  return validators.validateThenParameters(p) && [p.first, ...[p.next].flat()].every((n) => THEN_NESTED.includes(n.handlerId) && nestedValid(n));
}
export function validateThenEffect(p) {
  // 「…。然后，从2个效果中选择1个效果使用」: an entry's own then may end in one choice, made when it is reached (effects.choose-one).
  if (!Array.isArray(p.next) && p.next?.handlerId === 'cn.chooseOne@1')
    return validators.validateThenParameters(p) && THEN_NESTED.includes(p.first.handlerId) && nestedValid(p.first) && validateChooseOneEffect(p.next.parameters);
  return nestedThenValid(p);
}
// The zone the cards a thenMoved's first part moved end up in (only its user's own cards), or null.
function movedZone({ handlerId, parameters: e }) {
  if (handlerId === 'cn.cards@1') return ['hand', 'discard', 'deck'].includes(e.to) ? e.to : null;
  if (handlerId === 'cn.discardDeckTop@1') return e.side === 'own' && !e.to ? 'discard' : null;
  // 「将自己的1张奖赏卡放于弃牌区，如果该奖赏卡是能量的话，则…」.
  if (handlerId === 'cn.prizeZone@1') return 'discard';
  return e.side !== 'own' ? null : e.op === 'discardEnergy' ? 'discard' : e.to === 'hand' ? 'hand' : null;
}
// The first part may also report a count of the opponent's cards (「将对手牌库上方…放于弃牌区…其张数」).
const MOVED_COUNT_FIRST = ['cn.cards@1', 'cn.discardDeckTop@1', 'cn.attachedEnergy@1', 'cn.prizeZone@1'];
// 「…放于备战区。然后，…该宝可梦」: the first parts that report the Pokémon they affected, and the next parts that can act on them.
// A switch reports the Pokémon it moved to the Bench (「被换入备战区的宝可梦」), whose Energy the next part moves.
const POKEMON_FIRST = (n) => n.handlerId === 'cn.cards@1' ? n.parameters.to === 'bench' :
  n.handlerId === 'cn.opponentHand@1' ? n.parameters.to === 'bench' : n.handlerId === 'cn.attachedEnergy@1' ? n.parameters.op === 'moveEnergy' :
  ['cn.attachHand@1', 'cn.attachDiscard@1', 'cn.attachDeckEnergy@1', 'cn.heal@1', 'cn.switch@1'].includes(n.handlerId) ||
  n.handlerId === 'cn.healPokemon@1' && !n.parameters.discardHealedEnergy;
const POKEMON_NEXT = ['cn.counters@1', 'cn.countersUntil@1', 'cn.heal@1', 'cn.healPokemon@1', 'cn.condition@1', 'cn.switch@1', 'cn.attachHand@1',
  'cn.attachDiscard@1', 'cn.attachedEnergy@1'];
// Whose discard pile the cards a first part moved go to ('own'/'opponent'), or null.
const movedPile = ({ handlerId, parameters: e }) => handlerId === 'cn.discardDeckTop@1' ? e.to ? null : e.side :
  handlerId === 'cn.cards@1' ? e.to === 'discard' ? e.side ?? 'own' : null : handlerId === 'cn.opponentHand@1' && e.to === 'discard' ? 'opponent' : null;
// 「如果那张卡牌是宝可梦…的话，则选择那只宝可梦所拥有的1个招式，作为这个招式使用」: a copy among the discarded cards only.
const copiesMoved = (p) => {
  const { first, next: { parameters: copy } } = p, pile = first && movedPile(first);
  return p.use === 'cards' && !!pile && !p.optional && !p.condition && !p.ifMoved && validators.validateCopyAttackParameters(copy) && !copy.chooser &&
    copy.origins.every((o) => o.zone === 'discard' && o.side === pile);
};
export function validateThenMovedEffect(p) {
  if (!validators.validateThenMovedParameters(p) || p.first && !nestedValid(p.first) || p.ifMoved && !nestedValid(p.ifMoved.effect)) return false;
  if (p.next.handlerId === 'cn.copyAttack@1') return copiesMoved(p);
  const { first, next } = p;
  if (!nestedValid(next) || p.ifMoved && p.use === 'pokemon') return false;
  if (p.use === 'pokemon') return !p.counted && POKEMON_FIRST(first) && (first.handlerId !== 'cn.switch@1' ? POKEMON_NEXT.includes(next.handlerId) :
    next.handlerId === 'cn.attachedEnergy@1' && next.parameters.op === 'moveEnergy' && next.parameters.side === first.parameters.side);
  if (p.optional && p.use !== 'none') return false;
  // The cards this attack's counted entry put into the user's discard pile (checked against that entry when the card is loaded).
  if (p.counted) return p.use === 'cards' && (next.handlerId === 'cn.cards@1' ?
    next.parameters.from === 'discard' && next.parameters.lookTop === null && !next.parameters.side : next.handlerId === 'cn.attachDiscard@1');
  if (!MOVED_COUNT_FIRST.includes(first.handlerId) || first.handlerId === 'cn.cards@1' && first.parameters.remainder ||
      first.handlerId === 'cn.attachedEnergy@1' && !['discardEnergy', 'returnEnergy'].includes(first.parameters.op) ||
      first.handlerId === 'cn.prizeZone@1' && first.parameters.op !== 'discardPrizes') return false;
  // 「当成功把卡牌放于备战区时，（若希望，可）…」: B only needs a moved card and is not bound to them.
  if (p.use === 'none') return THEN_NESTED.includes(next.handlerId);
  if (p.use === 'count') return Object.hasOwn(SCALED_FIELDS, next.handlerId) &&
    (SCALED_FIELDS[next.handlerId] === 'count' || ['exact', 'upTo'].includes(next.parameters.quantity.kind));
  const zone = movedZone(first);
  return zone !== null && (next.handlerId === 'cn.cards@1' ? next.parameters.from === zone && next.parameters.lookTop === null :
    next.handlerId === 'cn.attachDiscard@1' ? zone === 'discard' : next.handlerId === 'cn.attachHand@1' && zone === 'hand');
}
// The Mallow & Lana form: the same switch, healing the Pokémon switched to the Bench only when paid.
export function validateIfPaidEffect(p) {
  if (!validators.validateIfPaidParameters(p) || !(p.effects ?? [p.effect]).every(nestedValid)) return false;
  if (!p.otherwise) return true;
  const { outgoingHeal, ...rest } = p.effect.parameters;
  return p.effect.handlerId === 'cn.switch@1' && outgoingHeal !== undefined && p.otherwise.handlerId === 'cn.switch@1' &&
    jsonEqual(rest, p.otherwise.parameters);
}
// 「将手牌放回牌库，直到手牌剩余2张为止并重洗牌库」: the player keeps N hand cards of their choice.
const TURN_END_LEAVES = Object.freeze({ 'cn.draw@1': fixedDraw, 'cn.drawUntil@1': fixedDraw,
  'cn.discardHand@1': validators.validateEmptyParameters, 'cn.cards@1': (p) => validCards(p) && p.quantity.kind === 'leave' });
export function validateTurnEndEffect(p) {
  return validators.validateTurnEndEffectParameters(p) && TURN_END_LEAVES[p.effect.handlerId](p.effect.parameters);
}
export function validateCountValueEffect(p) {
  if (!validators.validateCountValueParameters(p)) return false;
  const { handlerId, parameters: e } = p.effect;
  const valid = handlerId === 'cn.distributeCounters@1' ? validators.validateCounterDistributionParameters : NESTED_VALIDATORS[handlerId];
  return valid(e) && (VALUE_FIELDS[handlerId] === 'count' ? e.count === 1 : VALUE_FIELDS[handlerId] === 'amount' ? e.amount === 10 && !e.cureAll :
    ['exact', 'upTo'].includes(e.quantity?.kind) && e.quantity.count === 1) &&
    (!p.next || THEN_NESTED.includes(p.next.handlerId) && nestedValid(p.next));
}
// countersValue: who target is the one Pokémon the count is read for — each one receiving counters (all), or the one chosen first (countFrom).
const readsTarget = (value) => JSON.stringify(value).includes('"who":"target"');
export function validateCountersValueEffect(p) {
  return validators.validateCountersValueParameters(p) && readsTarget(p.count) === Boolean(p.all || p.countFrom);
}
// I.B-03 「如果在使用前就可以判断…不会发生任何情况变化」: a raised limit changes nothing when the player already has it this turn,
// and 「即使自己已经使用过GX招式」 nothing before the player used one (attack.special-rule-reuse).
function playerLimitChanges(ctx, effect) {
  const owner = ctx.source.owner;
  if (effect.action === 'gxAttack' && !ctx.state.players[owner].gxUsed) return false;
  return !ctx.state.playerOngoing.some((e) => e.player === owner && e.effect.op === 'playerLimit' && e.effect.action === effect.action &&
    ongoingIsActive(e, ctx.state) && (e.effect.count ?? 0) >= (effect.count ?? 0) &&
    (!e.effect.targetSelector || jsonEqual(e.effect.targetSelector, effect.targetSelector)));
}
function handler(id, ruleId, validateParameters, execute, extra = {}) {
  const operations = {
    'cn.draw@1': ['draw'], 'cn.drawPlayers@1': ['sequence', 'draw', 'optional'], 'cn.attackChoice@1': ['attackChoice'], 'cn.evolutionPermission@1': ['evolutionPermission'], 'cn.discardHand@1': ['discardHand'], 'cn.counters@1': ['counters'], 'cn.countersUntil@1': ['counters'], 'cn.countersValue@1': ['counters'],
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
    'cn.fieldReturn@1': ['returnPokemon', 'returnAttached'],
    'cn.copyAttack@1': ['copyAttack'],
    'cn.attackGrant@1': ['attackGrant'],
    'cn.burnCounters@1': ['burnCounters'], 'cn.conditionRule@1': ['conditionRule'], 'cn.attackTwice@1': ['attackTwice'], 'cn.koSurvive@1': ['koSurvive'],
    'cn.inspectDeck@1': ['inspectDeck'], 'cn.attachDeckEnergy@1': ['attachDeckEnergy'],
    'cn.pokemonTypes@1': ['pokemonTypes'],
    'cn.prizeDamage@1': [],
    'cn.damageValue@1': [],
    'cn.prizeExchange@1': ['exchangePrizes'],
    'cn.shuffleHandToBottom@1': ['shuffleHandToBottom'],
    'cn.handBottomDraw@1': ['then', 'shuffleHandToBottom', 'sequence', 'draw', 'coin'],
    'cn.healPokemon@1': ['healPokemon', 'discardEnergy'],
    'cn.distributeCounters@1': ['distributeCounters'],
    'cn.discardStadium@1': ['discardStadium'], 'cn.stadiumProtection@1': ['stadiumProtection'],
    'cn.disableOwnedAttack@1': ['disableOwnedAttack'],
    'cn.handDeckDraw@1': ['then', 'shuffleHandIntoDeck', 'sequence', 'draw', 'coin', 'optional'],
    'cn.drawPokemonCount@1': ['draw'], 'cn.drawValue@1': ['draw'], 'cn.drainHeal@1': ['heal'], 'cn.countersFromDamage@1': ['counters'],
    'cn.cardsThenDraw@1': ['then', 'cards', 'draw'],
    'cn.countedEnergyDiscard@1': ['discardEnergy', 'moveEnergy'], 'cn.discardTools@1': ['discardTools'], 'cn.countedToolDiscard@1': ['discardTools'],
    'cn.countedCards@1': ['cards'], 'cn.opponentHand@1': ['opponentHand'], 'cn.copySupporter@1': ['copySupporter'],
    'cn.optionalCounted@1': ['optional', 'sequence', 'discardEnergy', 'returnEnergy', 'discardTools', 'cards', 'discardStadium', 'flipPrizes', 'discardDeckTop', 'attachHand'],
    'cn.countedHandLook@1': ['opponentHand'],
    'cn.arrangeDeck@1': ['arrangeDeck'],
    'cn.coin@1': ['coin', 'sequence', 'choose', ...NESTED_OPERATIONS, 'discardHand', 'shuffleHandIntoDeck', 'shuffleHandToBottom'],
    'cn.coins@1': ['coins', 'sequence', ...NESTED_OPERATIONS, 'choose', 'discardHand', 'shuffleHandIntoDeck', 'shuffleHandToBottom'], 'cn.coinResult@1': ['coinResult', 'sequence', ...NESTED_OPERATIONS],
    'cn.janken@1': ['janken', 'sequence', ...NESTED_OPERATIONS], 'cn.countedJanken@1': ['janken'], 'cn.coinReflip@1': ['coinReflip'],
    'cn.when@1': ['when', 'sequence', ...NESTED_OPERATIONS, 'extraPrizes'],
    'cn.optional@1': ['optional', 'sequence', ...NESTED_OPERATIONS, 'shuffleHandIntoDeck', 'shuffle'],
    'cn.orElse@1': ['orElse', 'sequence', ...NESTED_OPERATIONS],
    'cn.then@1': ['then', 'sequence', ...LEAF_OPERATIONS, 'coin', 'choose', 'discardHand', 'shuffleHandIntoDeck', 'shuffleHandToBottom'],
    'cn.thenMoved@1': ['thenMoved', 'bound', 'optional', ...LEAF_OPERATIONS, 'recordedCards', 'when', 'ifMoved', 'sequence', 'copyAttack'],
    'cn.discardDeckTop@1': ['discardDeckTop'],
    'cn.attachThenDraw@1': ['then', 'attachHand', 'attachDiscard', 'draw'],
    'cn.replacePokemon@1': ['replacePokemon'],
    'cn.benchLimit@1': ['benchLimit'], 'cn.toolCapacity@1': ['toolCapacity'],
    'cn.knockOut@1': ['knockOut'], 'cn.countedKnockOut@1': ['knockOut'], 'cn.countedFieldReturn@1': ['returnPokemon'],
    'cn.stadiumUse@1': ['sequence', ...NESTED_OPERATIONS, 'shuffleHandIntoDeck', 'coin', 'when'],
    'cn.chooseOne@1': ['choose', 'sequence', ...NESTED_OPERATIONS, 'discardHand', 'shuffleHandIntoDeck', 'shuffleHandToBottom'],
    'cn.countedReveal@1': ['revealCards'], 'cn.revealedCards@1': ['revealedCards'], 'cn.countedDeckTop@1': ['discardDeckTop'],
    'cn.countedSelfCounters@1': ['selfCounters'], 'cn.revealHands@1': ['revealHands'],
    'cn.countValue@1': ['distributeCounters', 'then', 'sequence', ...LEAF_OPERATIONS],
    'cn.extraTurn@1': ['extraTurn'],
    'cn.prizeZone@1': ['lookPrizes', 'flipPrizes', 'swapPrizeDeck', 'resetPrizes', 'prizeHandSwap', 'deckTopToPrizes', 'discardPrizes'],
    'cn.countedPrizes@1': ['flipPrizes'], 'cn.prizeDestination@1': ['prizeDestination'],
    'cn.deployIncomingThen@1': ['then', 'deployIncoming', 'coin', 'choose', 'sequence', ...NESTED_OPERATIONS, 'discardHand', 'shuffleHandIntoDeck', 'shuffleHandToBottom'],
    'cn.deploySelf@1': ['then', 'deploySelf', 'coin', 'choose', 'sequence', ...NESTED_OPERATIONS, 'discardHand', 'shuffleHandIntoDeck', 'shuffleHandToBottom'],
    'cn.handDeckSwap@1': ['swapHandDeckTop'], 'cn.returnSelf@1': ['returnSelf'],
    'cn.gameResult@1': ['gameResult'], 'cn.turnEndEffect@1': ['turnEndEffect'], 'cn.retreatRule@1': ['retreatRule'],
    'cn.ifPaid@1': ['ifPaid', 'sequence', ...NESTED_OPERATIONS], 'cn.turnKept@1': ['turnKept'], 'cn.handSupporterEffect@1': ['handSupporterEffect'], 'cn.knockoutZone@1': ['knockoutZone'],
    'cn.opponentMayDraw@1': ['optional', 'then', 'draw'], 'cn.swapCounters@1': ['swapCounters'], 'cn.discardToHand@1': ['discardToHand'], 'cn.discardSelf@1': ['discardSelf'], 'cn.enterOnlyBy@1': [],
    'cn.countedCounters@1': ['counters'], 'cn.damageRedirect@1': ['damageRedirect'], 'cn.attackKnockoutZone@1': ['attackKnockoutZone'],
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
    'cn.burnCounters@1': 'burnCounters', 'cn.conditionRule@1': 'conditionRule', 'cn.attackTwice@1': 'attackTwice', 'cn.koSurvive@1': 'koSurvive',
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
    'cn.janken@1': 'janken', 'cn.countedJanken@1': 'empty', 'cn.coinReflip@1': 'coinReflip',
    'cn.countedEnergyDiscard@1': 'countedEnergyDiscard', 'cn.discardTools@1': 'discardTools', 'cn.countedToolDiscard@1': 'discardTools',
    'cn.countedCards@1': 'countedCards', 'cn.opponentHand@1': 'opponentHand', 'cn.copySupporter@1': 'copySupporter', 'cn.countedHandLook@1': 'opponentHandLook', 'cn.arrangeDeck@1': 'arrangeDeck', 'cn.optionalCounted@1': 'optionalCounted',
    'cn.then@1': 'then', 'cn.thenMoved@1': 'thenMoved', 'cn.discardDeckTop@1': 'discardDeckTop', 'cn.attachThenDraw@1': 'attachThenDraw',
    'cn.replacePokemon@1': 'replacePokemon', 'cn.benchLimit@1': 'benchLimit', 'cn.toolCapacity@1': 'toolCapacity', 'cn.knockOut@1': 'knockOut', 'cn.countedKnockOut@1': 'knockOut',
    'cn.countedFieldReturn@1': 'countedFieldReturn',
    'cn.stadiumUse@1': 'stadiumUse', 'cn.chooseOne@1': 'chooseOne',
    'cn.countedReveal@1': 'countedReveal', 'cn.revealedCards@1': 'revealedCards', 'cn.countedDeckTop@1': 'countedDeckTop',
    'cn.countedSelfCounters@1': 'countedSelfCounters', 'cn.revealHands@1': 'revealHands', 'cn.countValue@1': 'countValue',
    'cn.extraTurn@1': 'extraTurn', 'cn.prizeZone@1': 'prizeZone', 'cn.deployIncomingThen@1': 'deployIncomingThen', 'cn.deploySelf@1': 'deploySelf',
    'cn.countedPrizes@1': 'countedPrizes', 'cn.prizeDestination@1': 'prizeDestination',
    'cn.handDeckSwap@1': 'empty', 'cn.returnSelf@1': 'returnSelf',
    'cn.gameResult@1': 'gameResult', 'cn.turnEndEffect@1': 'turnEndEffect', 'cn.retreatRule@1': 'retreatRule',
    'cn.ifPaid@1': 'ifPaid', 'cn.turnKept@1': 'turnKept', 'cn.handSupporterEffect@1': 'handSupporterEffect', 'cn.knockoutZone@1': 'knockoutZone',
    'cn.opponentMayDraw@1': 'opponentMayDraw', 'cn.swapCounters@1': 'empty', 'cn.discardToHand@1': 'empty', 'cn.discardSelf@1': 'empty', 'cn.enterOnlyBy@1': 'enterOnlyBy',
    'cn.countedCounters@1': 'countedCounters', 'cn.damageRedirect@1': 'damageRedirect', 'cn.attackKnockoutZone@1': 'empty',
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
      { canUse: (ctx) => facedownPrizes(ctx.state.players[ctx.source.owner]).length > 0 }),
    handler('cn.prizeZone@1', 'prizes.zone', v.validatePrizeZoneParameters, (_ctx, p) => [p], {
      canUse: (ctx, p) => {
        const q = ctx.state.players[p.side === 'opponent' ? 1 - ctx.source.owner : ctx.source.owner];
        return p.op === 'resetPrizes' ? p.side === 'both' || q.prizes.length > 0 : ['prizeHandSwap', 'discardPrizes'].includes(p.op) ? q.prizes.length > 0 :
          p.op === 'deckTopToPrizes' ? q.deck.length > 0 : facedownPrizes(q).length > 0 && (p.op !== 'swapPrizeDeck' || q.deck.length > 0);
      },
      sourceOfTruth: ['prizes.zone', 'prizes.face-up'].flatMap((key) => requireRule(CN_V20261019, key).sourceOfTruth) }),
    handler('cn.shuffleHandToBottom@1', 'effects.hand-bottom', v.validateShuffleHandToBottomParameters,
      (_ctx, p) => [{ op: 'shuffleHandToBottom', ...p }], { canUse: (ctx, p) => handBottomAvailable(ctx, p) }),
    handler('cn.handBottomDraw@1', 'effects.hand-bottom', v.validateHandBottomDrawParameters, (ctx, p) => [{
      op: 'then', first: { op: 'shuffleHandToBottom', side: p.side },
      next: { op: 'sequence', steps: [
        drawStep(ctx, ctx.source.owner, p.ownDraw), drawStep(ctx, 1 - ctx.source.owner, p.opponentDraw),
      ] },
    }], { capabilities: ['battle-values'], canUse: (ctx, p) => handBottomAvailable(ctx, p),
      sourceOfTruth: ['effects.hand-bottom', 'effects.draw', 'prizes.remaining'].flatMap((key) => requireRule(CN_V20261019, key).sourceOfTruth) }),
    handler('cn.damageValue@1', 'damage.expression', v.validateDamageValueParameters, () => [], {
      timing: 'formula', capabilities: ['resolve-attack-damage', 'damage-rolls'], damageRollVersion: '1',
      sourceOfTruth: ['damage.expression', 'damage.counted-types'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth),
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
    handler('cn.conditionRule@1', 'status.rules', v.validateConditionRuleParameters, (_ctx, p) => [p.effect],
      { timing: 'continuous' }),
    handler('cn.attackTwice@1', 'attack.twice', v.validateAttackTwiceParameters, (_ctx, p) => [p.effect],
      { timing: 'continuous' }),
    handler('cn.koSurvive@1', 'damage.survive', v.validateKoSurviveParameters, (_ctx, p) => [p.effect],
      { timing: 'continuous' }),
    handler('cn.attackGrant@1', 'attack.grant', v.validateAttackGrantParameters, (_ctx, p) => [p], { timing: 'attackGrant' }),
    handler('cn.copyAttack@1', 'attack.copy', v.validateCopyAttackParameters, (_ctx, p) => [p]),
    handler('cn.fieldReturn@1', 'effects.field-return', v.validateFieldReturnParameters, (_ctx, p) => [p],
      { canUse: (ctx, p) => p.op === 'returnAttached' ? attachedReturnHolders(ctx, p).length > 0 :
        fieldReturnTargets(ctx, p).length > (p.quantity.kind === 'leave' ? p.quantity.count : 0),
      sourceOfTruth: ['effects.field-return', 'effects.field-return-deck', 'effects.attached-return']
        .flatMap((key) => requireRule(CN_V20261019, key).sourceOfTruth) }),
    handler('cn.pokemonTransition@1', 'effects.evolve', v.validatePokemonTransitionParameters, (_ctx, p) => [p],
      { canUse: (ctx, p) => canUsePokemonTransition(ctx, p),
        sourceOfTruth: ['effects.evolve', 'effects.devolve', 'effects.inherit'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth) }),
    handler('cn.energyRequirement@1', 'energy.requirement', v.validateEnergyRequirementParameters, (_ctx, p) => [p.effect],
      { timing: 'continuous', sourceOfTruth: ['energy.requirement', 'energy.requirement.erase-type', 'energy.requirement.reduce-any'].flatMap((key) => requireRule(CN_V20261019, key).sourceOfTruth) }),
    handler('cn.energyProvision@1', 'energy.provision', v.validateEnergyProvisionParameters, (_ctx, p) => [p.effect],
      { timing: 'energyProvision', sourceOfTruth: ['energy.provision', 'energy.provision-conditions'].flatMap((key) => requireRule(CN_V20261019, key).sourceOfTruth) }),
    handler('cn.energyOptions@1', 'energy.requirement.alternative', v.validateEnergyOptionsParameters, () => [],
      { timing: 'energyOptions', energyOptions: (_ctx, p) => ({ cost: p.cost }) }),
    // Runs before damage so the attack's own formula can read the actual count.
    handler('cn.countedEnergyDiscard@1', 'damage.effect-count', v.validateCountedEnergyDiscardParameters, (_ctx, p) => [p], {
      timing: 'beforeDamage', capabilities: ['effect-card-count'],
      sourceOfTruth: ['damage.effect-count', 'energy.attached-selection', 'selection.any', 'damage.counted-picks', 'damage.counted-attach']
        .flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth),
    }),
    handler('cn.discardTools@1', 'effects.tool-discard', v.validateDiscardToolsParameters, (_ctx, p) => [{ op: 'discardTools', ...p }],
      { canUse: (ctx, p) => toolsFor(ctx, p).length > 0 || !!p.stadium && ctx.state.stadium !== null,
        sourceOfTruth: ['effects.tool-discard', 'effects.stadium-discard', 'zones.lost-zone'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth) }),
    // 「在造成伤害前，将…「宝可梦道具」放于弃牌区（，追加造成其张数×N／如果成功…则…）」: counted so the damage can read it.
    handler('cn.countedToolDiscard@1', 'damage.effect-count', (p) => v.validateDiscardToolsParameters(p) && !p.stadium && !p.to, (_ctx, p) => [{ op: 'discardTools', ...p }], {
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
    // 「查看对手的手牌。若希望，可选择其中1张支援者，将该支援者的效果，作为这张卡牌的效果使用」: a Trainer copies only from the
    // opponent's hand (the load guard), so it is usable while that hand holds a card to look at (JP Q&A ナツメの暗示).
    handler('cn.copySupporter@1', 'effects.copy-supporter', v.validateCopySupporterParameters, (_ctx, p) => [{ op: 'copySupporter', ...p }],
      { canUse: (ctx) => ctx.state.players[1 - ctx.source.owner].hand.length > 0,
        sourceOfTruth: ['effects.copy-supporter', 'effects.opponent-hand'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth) }),
    // 「查看对手的手牌，造成其中训练家张数×N伤害」: the look runs before damage so the formula reads the looked-at cards.
    handler('cn.countedHandLook@1', 'damage.effect-count', v.validateOpponentHandLookParameters, (_ctx, p) => [{ op: 'opponentHand', ...p }], {
      timing: 'beforeDamage', capabilities: ['effect-card-count'],
      sourceOfTruth: ['damage.effect-count', 'effects.opponent-hand'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth),
    }),
    // 「将牌库上方N张卡牌翻到正面，造成其中X张数×N」「将弃牌区中的所有X给对手查看，造成其张数×N」: shown before damage, nothing moves.
    handler('cn.countedReveal@1', 'effects.reveal', v.validateCountedRevealParameters, (_ctx, p) => [{ op: 'revealCards', ...p }], {
      timing: 'beforeDamage', capabilities: ['effect-card-count'],
      sourceOfTruth: ['effects.reveal', 'damage.effect-count', 'damage.counted-types'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth),
    }),
    // 「将正面朝上的X放于弃牌区，剩余的卡牌放回牌库并重洗牌库」「然后，将给对手查看过的…放回牌库并重洗牌库」.
    handler('cn.revealedCards@1', 'effects.reveal', v.validateRevealedCardsParameters, (_ctx, p) => [{ op: 'revealedCards', ...p }]),
    // 「（双方各）将牌库上方N张卡牌放于弃牌区，追加造成其中能量张数×N」.
    handler('cn.countedDeckTop@1', 'damage.effect-count', v.validateCountedDeckTopParameters, (_ctx, p) => [{ op: 'discardDeckTop', ...p }], {
      timing: 'beforeDamage', capabilities: ['effect-card-count'],
      sourceOfTruth: ['damage.effect-count', 'effects.deck-top-discard', 'effects.deck-top-count'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth),
    }),
    // 「将自己的1张反面朝上的奖赏卡翻为正面。如果该卡牌是【火】能量的话，则追加造成50点伤害」: flipped before damage, the flipped card recorded.
    handler('cn.countedPrizes@1', 'damage.effect-count', v.validateCountedPrizesParameters, (_ctx, p) => [p], {
      timing: 'beforeDamage', capabilities: ['effect-card-count'],
      sourceOfTruth: ['damage.effect-count', 'prizes.zone', 'prizes.face-up'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth),
    }),
    // 「给这只宝可梦身上放置最多N个伤害指示物，造成放置的伤害指示物数量×M伤害」.
    handler('cn.countedSelfCounters@1', 'damage.effect-count', v.validateCountedSelfCountersParameters,
      (_ctx, p) => [{ op: 'selfCounters', maximum: p.maximum }], {
        timing: 'beforeDamage', capabilities: ['effect-card-count'],
        sourceOfTruth: ['damage.effect-count', 'damage.counters', 'selection.up-to'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth),
      }),
    // 「当这个回合结束时，自己的回合会再开始1次」: only on its user's own turn.
    // 「选择自己的1张手牌，将其与牌库上方的卡牌互换」: another hand card and a deck to swap with.
    handler('cn.handDeckSwap@1', 'effects.hand-deck-swap', v.validateEmptyParameters, () => [{ op: 'swapHandDeckTop' }],
      { canUse: (ctx) => { const p = ctx.state.players[ctx.source.owner]; return p.deck.length > 0 && p.hand.some((id) => id !== ctx.source.instanceId); } }),
    // 「不将这张「X」放于弃牌区，而是放回手牌」: the Item/Supporter in use goes back to its user's hand.
    handler('cn.returnSelf@1', 'effects.return-self', v.validateReturnSelfParameters, (_ctx, p) => [{ op: 'returnSelf', ...p }],
      { canUse: (ctx) => ctx.source.category === 'trainer' }),
    // 「然后，将这张卡牌放于弃牌区」 on an attached Tool or Special Energy.
    handler('cn.discardSelf@1', 'effects.discard-self', v.validateEmptyParameters, () => [{ op: 'discardSelf' }]),
    handler('cn.extraTurn@1', 'turn.extra', v.validateExtraTurnParameters, (_ctx, p) => [{ op: 'extraTurn', ...p }],
      { canUse: (ctx) => ctx.state.current === ctx.source.owner }),
    // 「双方玩家，各将自己的手牌翻到正面，互相展示」.
    handler('cn.revealHands@1', 'effects.reveal', v.validateRevealHandsParameters, (_ctx, p) => [{ op: 'revealHands', ...p }],
      { canUse: (ctx) => ctx.state.players.some((player, i) => player.hand.some((id) => i !== ctx.source.owner || id !== ctx.source.instanceId)) }),
    handler('cn.attachedEnergy@1', 'energy.attached-selection', v.validateAttachedEnergyParameters, (_ctx, p) => [p],
      { canUse: (ctx, p) => canUseAttachedEnergy(ctx, p),
        sourceOfTruth: ['energy.attached-selection', 'energy.return'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth) }),
    handler('cn.deployIncoming@1', 'trigger.before-hand', v.validateEmptyParameters, () => [{ op: 'deployIncoming' }],
      { canUse: (ctx) => !!ctx.entry && def(ctx, ctx.entry.cardId).kind === 'pokemon' && benchRoom(ctx) &&
        enterable(ctx, ctx.source.owner, def(ctx, ctx.entry.cardId)) }),
    handler('cn.attachIncoming@1', 'trigger.before-hand', v.validateAttachIncomingParameters, (_ctx, p) => [{ op: 'attachIncoming', ...p }],
      { canUse: (ctx, p) => !!ctx.entry && def(ctx, ctx.entry.cardId).kind === 'energy' && subjects(ctx, ctx.source.owner).some((m) =>
        p.target === 'bench' ? !active(ctx, ctx.source.owner, m) : matches(ctx, p.target, ctx.source.owner, m)) }),
    handler('cn.cards@1', 'effects.search', validCards, (_ctx, p) => [{ op: 'cards', ...p }],
      { canUse: (ctx, p) => {
        const holder = p.side === 'opponent' ? 1 - ctx.source.owner : ctx.source.owner, player = ctx.state.players[holder];
        if (p.to === 'bench' && player.bench.length >= ctx.benchLimits[holder]) return false;
        const pool = (p.from === 'deck' && p.lookBottom ? player.deck.slice(0, p.lookBottom) :
          p.from === 'deck' && p.lookTop !== null ? player.deck.slice(-p.lookTop) : player[p.from])
          .filter((id) => p.from !== 'hand' || ctx.source.category !== 'trainer' || id !== ctx.source.instanceId)
          .filter((id) => !p.excludePaid || !paidIds(ctx).includes(id));
        // Full deck inspection is a legitimate hidden-information action;
        // public/known zones cannot be used when there is no eligible card.
        return p.from === 'deck' ? pool.length > 0 : pool.some((id) => movable(ctx, p, holder, def(ctx, id)));
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
    // 「令对手的战斗宝可梦【昏厥】。然后，给这只宝可梦造成N伤害」: the Knock Out is recorded so the self damage reads whether it happened.
    handler('cn.countedKnockOut@1', 'damage.effect-count', (p) => v.validateKnockOutParameters(p) && p.target !== 'self',
      (_ctx, p) => [{ op: 'knockOut', ...p }], { timing: 'beforeDamage', capabilities: ['effect-card-count'],
        sourceOfTruth: ['damage.effect-count', 'effects.knockout', 'effects.partial'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth) }),
    // 「在对手战斗宝可梦身上放置伤害指示物，直到其剩余HP变为「10」为止。然后，给这只宝可梦造成120伤害」: the number placed is recorded.
    handler('cn.countedCounters@1', 'damage.effect-count', validCountedCounters, (_ctx, p) => [Object.hasOwn(p, 'remainingHp')
      ? { op: 'counters', side: p.side, target: p.target, untilRemainingHp: p.remainingHp } : { op: 'counters', ...p }], {
      timing: 'beforeDamage', capabilities: ['effect-card-count'],
      sourceOfTruth: ['damage.effect-count', 'damage.counters', 'effects.partial'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth) }),
    handler('cn.countedSwitch@1', 'damage.after-switch', v.validateCountedSwitchParameters, (_ctx, p) => [{ op: 'switch', ...p }], {
      timing: 'beforeDamage', capabilities: ['effect-card-count'],
      sourceOfTruth: ['damage.after-switch', 'damage.effect-count', 'effects.switch'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth),
    }),
    // 「将任意数量的自己的备战宝可梦放于弃牌区，追加造成被放于弃牌区的备战宝可梦数量×N点伤害」: before damage, counting the Pokémon that left.
    // 「最多与对手场上宝可梦数量相同数量的…」: that maximum is read when it resolves; none leaves at 0.
    handler('cn.countedFieldReturn@1', 'damage.bench-count', v.validateCountedFieldReturnParameters, (ctx, p) => {
      if (typeof p.quantity.count !== 'object') return [p];
      const count = Math.max(0, evaluateBattleValue(p.quantity.count, ctx.battleValues));
      return count ? [{ ...p, quantity: { kind: 'upTo', count } }] : [];
    }, { timing: 'beforeDamage', capabilities: ['effect-card-count', 'battle-values'],
        sourceOfTruth: ['damage.bench-count', 'damage.effect-count', 'effects.field-return'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth) }),
    // 「抽取最多N张」 (upTo): one card at a time, its drawer may stop after each (II.D-05).
    handler('cn.draw@1', 'effects.draw', v.validateDrawParameters, (ctx, p) => [{ op: 'draw', count: p.count, ...(p.bottom ? { bottom: true } : {}),
      ...(p.upTo ? { upTo: true } : {}) }],
      { canUse: (ctx) => ctx.state.players[ctx.source.owner].deck.length > 0 }),
    // 「双方玩家，各从牌库上方抽取N张卡牌」「对手从牌库上方抽取N张卡牌」: the user first, then the opponent.
    // 「双方玩家，若希望，可各…抽取最多N张（从自己开始）」: each player decides its own draw; 「互相展示过正面后加入手牌」: shown first.
    handler('cn.drawPlayers@1', 'effects.draw', v.validateDrawPlayersParameters, (ctx, p) => [{ op: 'sequence', steps: [
      ...(p.own ? [drawFor(ctx, p, ctx.source.owner, p.own)] : []), drawFor(ctx, p, 1 - ctx.source.owner, p.opponent),
    ] }], { canUse: (ctx, p) => {
      // 「…直到手牌变为N张为止」: a player already holding N draws nothing.
      const hand = (player) => player === ctx.source.owner ? handAfterCosts(ctx, []) : ctx.state.players[player].hand.length;
      const can = (player, n) => n > 0 && ctx.state.players[player].deck.length > 0 && (!p.until || hand(player) < n);
      return can(ctx.source.owner, p.own) || can(1 - ctx.source.owner, p.opponent);
    } }),
    // 「对手若希望，可从牌库上方抽取N张卡牌（。在这种情况下，自己额外从牌库上方抽取M张卡牌）」: the opponent decides (II.E-10).
    handler('cn.opponentMayDraw@1', 'selection.opponent-optional', v.validateOpponentMayDrawParameters, (ctx, p) => {
      const draw = { op: 'draw', player: 1 - ctx.source.owner, count: p.count };
      return [{ op: 'optional', chooser: 'opponent',
        effect: p.ownDraw ? { op: 'then', first: draw, next: { op: 'draw', player: ctx.source.owner, count: p.ownDraw } } : draw }];
    }, { canUse: (ctx) => ctx.state.players[1 - ctx.source.owner].deck.length > 0,
      sourceOfTruth: ['selection.opponent-optional', 'effects.draw', 'effects.partial'].flatMap((key) => requireRule(CN_V20261019, key).sourceOfTruth) }),
    // 「若希望，可追加造成N伤害。在这种情况下，…」: decided before damage; the formula and later entries read the recorded choice.
    handler('cn.attackChoice@1', 'damage.optional-choice', v.validateEmptyParameters, () => [{ op: 'attackChoice' }], {
      timing: 'beforeDamage', capabilities: ['effect-card-count'],
      sourceOfTruth: ['damage.optional-choice', 'selection.optional'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth) }),
    // 「若希望，可将这个招式的伤害，给予对手的1只备战宝可梦而不是战斗宝可梦」: chosen just before damage; the damage step reads the record.
    handler('cn.damageRedirect@1', 'damage.redirect', v.validateDamageRedirectParameters, (_ctx, p) => [{ op: 'damageRedirect', ...p }], {
      timing: 'beforeDamage', capabilities: ['effect-card-count', 'board-condition', 'damage-redirect'],
      sourceOfTruth: ['damage.redirect', 'damage.bench', 'selection.optional'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth) }),
    // 「将受到这个招式的伤害而昏厥的宝可梦以及放于其身上的所有卡牌放于放逐区」: read when this attack's Knock Outs are processed.
    handler('cn.attackKnockoutZone@1', 'ko.attack-lost-zone', v.validateEmptyParameters, () => [{ op: 'attackKnockoutZone' }], {
      sourceOfTruth: ['ko.attack-lost-zone', 'ko.lost-zone'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth) }),
    // 「与对手玩家猜拳，如果自己赢了则追加造成N点伤害」: played before damage; the formula and later entries read the recorded win.
    handler('cn.countedJanken@1', 'effects.janken', v.validateEmptyParameters, () => [{ op: 'janken' }], {
      timing: 'beforeDamage', capabilities: ['effect-card-count'],
      sourceOfTruth: ['effects.janken', 'damage.effect-count'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth) }),
    // 「…因自己宝可梦的招式而抛掷硬币时，可无视这次抛掷硬币的所有结果，重新抛掷硬币」: offered by the host after such flips.
    handler('cn.coinReflip@1', 'effects.coin-reflip', v.validateCoinReflipParameters, (_ctx, p) => [{ op: 'coinReflip', scope: p.scope, key: p.key }],
      { timing: 'continuous' }),
    // 「抽取卡牌，直到自己的手牌变为N张为止」: the hand when the draw happens, after any earlier part of the effect.
    handler('cn.drawUntil@1', 'effects.draw', fixedDraw, (_ctx, p) => [{ op: 'draw', untilHand: p.count }], { canUse: (ctx, p) => ctx.state.players[ctx.source.owner].deck.length > 0 && handAfterCosts(ctx, []) < p.count }),
    handler('cn.discardHand@1', 'effects.discard', v.validateEmptyParameters, () => [{ op: 'discardHand' }],
      { canUse: (ctx) => ctx.state.players[ctx.source.owner].hand.some((id) => id !== ctx.source.instanceId) }),
    handler('cn.counters@1', 'damage.counters', v.validateCountersParameters, (_ctx, p) => [{ op: 'counters', ...p }],
      { canUse: countersTarget }),
    // 「放置伤害指示物，直到其剩余HP变为「N」」: the counters op reads the remaining HP (II.D-16) when it places them.
    handler('cn.countersUntil@1', 'damage.counters', v.validateCountersUntilParameters,
      (_ctx, p) => [{ op: 'counters', side: p.side, target: p.target, untilRemainingHp: p.remainingHp, ...(p.all ? { all: true } : {}) }], { canUse: countersTarget }),
    // 「将与…数量相同数量的伤害指示物，放置于…」: the count when the counters are placed; none when it is 0 or less.
    // 「其各自身上」「被选择的宝可梦身上」: the host reads the count for each receiving Pokémon (all) or the one chosen first (countFrom).
    handler('cn.countersValue@1', 'damage.counters', validateCountersValueEffect, (ctx, p) => {
      if (p.all || p.countFrom) { const { count, ...rest } = p; return [{ op: 'counters', ...rest, value: count }]; }
      const count = countersValue(ctx, p);
      return count ? [{ op: 'counters', side: p.side, target: p.target, count }] : [];
    }, { capabilities: ['battle-values'], canUse: (ctx, p) => (p.all || p.countFrom || countersValue(ctx, p) > 0) && countersTarget(ctx, p),
      sourceOfTruth: ['damage.counters', 'effects.activation-change', 'effects.count-value-target'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth) }),
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
      { timing: 'continuous', sourceOfTruth: ['effects.protection', 'effects.trainer-hand-use', 'damage.prevention-threshold', 'damage.prevention-values']
        .flatMap((key) => requireRule(CN_V20261019, key).sourceOfTruth) }),
    handler('cn.property@1', 'damage.ignore-defender', v.validatePropertyParameters, (_ctx, p) => [p.effect],
      { timing: 'continuous' }),
    handler('cn.conditionImmunity@1', 'status.immunity', v.validateConditionImmunityParameters, (_ctx, p) => [p.effect],
      { timing: 'continuous' }),
    handler('cn.attackDamageOptions@1', 'damage.ignore-defender', v.validateAttackDamageOptionsParameters, (_ctx, p) => [p.effect],
      { timing: 'continuous' }),
    handler('cn.damageOptions@1', 'damage.ignore-defender', v.validateDamageOptionsParameters, () => [],
      // 「在这种情况下，这个招式的伤害不计算…」: the host applies the flags only while the printed condition holds.
      { timing: 'damageOptions', damageOptions: (_ctx, { condition: _condition, ...flags }) => flags }),
    handler('cn.lasting@1', 'effects.duration.turn-only', v.validateLastingParameters, (_ctx, p) => [{ op: 'lasting', ...p }],
      { canUse: (ctx, p) => subjects(ctx, p.side === 'own' ? ctx.source.owner : 1 - ctx.source.owner).some((m) =>
        matches(ctx, p.target, p.side === 'own' ? ctx.source.owner : 1 - ctx.source.owner, m)) }),
    // 「选择与其相同数量的对手的宝可梦（同1只宝可梦可以选择多次）」「选择与放于弃牌区数量相同数量的对手宝可梦」: the number of picks or
    // targets is read when the damage step starts; none at 0 deals nothing.
    handler('cn.damage@1', 'attack.order', v.validateDamageParameters, (ctx, p) => {
      if (typeof p.selection.count !== 'object') return [{ op: 'damage', ...p }];
      const count = Math.max(0, evaluateBattleValue(p.selection.count, ctx.battleValues));
      return count ? [{ op: 'damage', ...p, selection: { ...p.selection, count } }] : [];
    }, {
      timing: 'damage', capabilities: ['damage-rolls', 'battle-values'], damageRollVersion: '1', damageRolls: (_ctx, p) => p.rolls ?? [],
      sourceOfTruth: ['attack.order', 'damage.counted-picks', 'damage.bench-count', 'attack.opponent-target'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth),
    }),
    handler('cn.recoilDamage@1', 'damage.self', validRecoil, (_ctx, p) => [{ op: 'damage', ...p }], {
      timing: 'damage', capabilities: ['damage-rolls'], damageRollVersion: '1', damageRolls: (_ctx, p) => p.rolls ?? [],
    }),
    handler('cn.restriction@1', 'effects.pokemon-lock', v.validateRestrictionParameters, (_ctx, p) => [p.effect], { timing: 'continuous' }),
    handler('cn.prizeModifier@1', 'ko.prize-modifier', v.validatePrizeModifierParameters, (_ctx, p) => [p.effect], { timing: 'continuous' }),
    handler('cn.extraPrizes@1', 'ko.prize-modifier', v.validateExtraPrizesParameters, (_ctx, p) => [{ op: 'extraPrizes', ...p }]),
    handler('cn.playerRestriction@1', 'effects.player-lock', v.validatePlayerRestrictionParameters, (_ctx, p) => [p.effect], { timing: 'continuous',
      sourceOfTruth: ['effects.player-lock', 'effects.enter-lock'].flatMap((key) => requireRule(CN_V20261019, key).sourceOfTruth) }),
    handler('cn.suppression@1', 'effects.remove-content', v.validateSuppressionParameters, (_ctx, p) => [p.effect], { timing: 'suppression' }),
    // A player effect always adds something to the game, so it is always a change, except a raised limit the player already has.
    handler('cn.lastingPlayer@1', 'effects.player-lock', v.validateLastingPlayerParameters, (_ctx, p) => [{ op: 'lastingPlayer', ...p }],
      { canUse: (ctx, p) => p.effect.op !== 'playerLimit' || playerLimitChanges(ctx, p.effect) }),
    handler('cn.delayedReaction@1', 'trigger.damage', v.validateDelayedReactionParameters, (_ctx, p) => [{ op: 'delayedReaction', ...p }],
      { embeddedOperations: REACTION_OPERATIONS }),
    handler('cn.transferCounters@1', 'damage.counters', v.validateTransferCountersParameters, (_ctx, p) => [{ op: 'transferCounters', ...p }],
      { canUse: (ctx, p) => {
        const owner = ctx.source.owner, sides = (side) => side === 'both' ? [owner, 1 - owner] : [side === 'opponent' ? 1 - owner : owner];
        const kind = (m, selector) => !selector || matchesInPlaySelector(def(ctx, m.stack.at(-1)), selector, ctx.effectivePokemon[m.id].types);
        return sides(p.originSide ?? 'own').some((o) => subjects(ctx, o).some((m) => m.counters > 0 &&
          (p.from !== 'self' || m.id === ctx.source.pokemonId) && (p.from !== 'active' || active(ctx, o, m)) &&
          (p.from !== 'bench' || !active(ctx, o, m)) && kind(m, p.originSelector) &&
          sides(p.side).some((t) => subjects(ctx, t).some((target) => target.id !== m.id && (p.target !== 'active' || active(ctx, t, target)) &&
            (p.target !== 'self' || target.id === ctx.source.pokemonId) && kind(target, p.targetSelector)))));
      } }),
    handler('cn.attackPermissions@1', 'attack.first-turn', v.validatePermissionsParameters, () => [],
      { timing: 'permission', permissions: (_ctx, p) => p.permissions }),
    handler('cn.attachDiscard@1', 'effects.attach', v.validateAttachDiscardParameters, (_ctx, p) => [{ op: 'attachDiscard', ...p }],
      { canUse: (ctx, p) => attachTargets(ctx, p).length > 0 &&
        ctx.state.players[ctx.source.owner].discard.some((id) => effectAttachable(def(ctx, id), p, 'discard')) }),
    handler('cn.attachHand@1', 'effects.attach', v.validateAttachDiscardParameters, (_ctx, p) => [{ op: 'attachHand', ...p }],
      { canUse: (ctx, p) => attachTargets(ctx, p).length > 0 &&
        ctx.state.players[ctx.source.owner].hand.some((id) => effectAttachable(def(ctx, id), p, 'hand')) }),
    handler('cn.discardDeckTop@1', 'effects.deck-top-discard', v.validateDiscardDeckTopParameters, (_ctx, p) => [{ op: 'discardDeckTop', ...p }],
      { canUse: (ctx, p) => ctx.state.players[p.side === 'own' ? ctx.source.owner : 1 - ctx.source.owner].deck.length > 0,
        sourceOfTruth: ['effects.deck-top-discard', 'effects.deck-bottom-discard', 'effects.deck-top-count'].flatMap((key) => requireRule(CN_V20261019, key).sourceOfTruth) }),
    // effects.replace-zones 「选择自己弃牌区中的1张…」: the public discard pile needs a matching card.
    handler('cn.replacePokemon@1', 'effects.replace', v.validateReplacePokemonParameters, (_ctx, p) => [p],
      { canUse: (ctx, p) => (p.from === 'deck' ? ctx.state.players[ctx.source.owner].deck.length > 0
        : ctx.state.players[ctx.source.owner].discard.some((id) => matchesCardSelector(def(ctx, id), p.selector))) &&
        subjects(ctx, ctx.source.owner).some((m) => m.id === ctx.source.pokemonId),
        sourceOfTruth: ['effects.replace', 'effects.replace-zones', 'effects.search', 'effects.shuffle'].flatMap((key) => requireRule(CN_V20261019, key).sourceOfTruth) }),
    handler('cn.benchLimit@1', 'bench.limit', v.validateBenchLimitParameters, (_ctx, p) => [p.effect], { timing: 'continuous',
      sourceOfTruth: ['bench.limit', 'bench.limit-own'].flatMap((key) => requireRule(CN_V20261019, key).sourceOfTruth) }),
    handler('cn.toolCapacity@1', 'tools.capacity', v.validateToolCapacityParameters, (_ctx, p) => [p.effect], { timing: 'continuous' }),
    handler('cn.retreatRule@1', 'retreat.rules', v.validateRetreatRuleParameters, (_ctx, p) => [p.effect], { timing: 'continuous' }),
    handler('cn.turnKept@1', 'effects.turn-kept', v.validateTurnKeptParameters, (_ctx, p) => [p.effect], { timing: 'continuous' }),
    // 「对手手牌里的支援者的效果，都会变为「从自己的牌库上方抽取3张卡牌。」」: the replacement is one approved leaf.
    handler('cn.handSupporterEffect@1', 'effects.supporter-replacement', validateHandSupporterEffect, (_ctx, p) => [p.effect], { timing: 'continuous' }),
    handler('cn.knockoutZone@1', 'ko.lost-zone', v.validateKnockoutZoneParameters, (_ctx, p) => [p.effect], { timing: 'continuous' }),
    handler('cn.prizeDestination@1', 'ko.prize-destination', v.validatePrizeDestinationParameters, (_ctx, p) => [p.effect], { timing: 'continuous' }),
    handler('cn.swapCounters@1', 'damage.counters-swap', v.validateEmptyParameters, () => [{ op: 'swapCounters' }]),
    handler('cn.discardToHand@1', 'effects.discard-to-hand', v.validateEmptyParameters, () => [{ op: 'discardToHand' }], { timing: 'continuous' }),
    // 「这张卡牌，只有通过「X」的特性「Y」的效果才能被放于场上」: read from the printed card wherever it would be put into play; nothing in play.
    handler('cn.enterOnlyBy@1', 'pokemon.enter-only-by', v.validateEnterOnlyByParameters, () => [], { timing: 'continuous' }),
    // II.E-38 「这场对战（算作）自己的胜利／己方败北」: the game ends here, outside the I.E checks.
    handler('cn.gameResult@1', 'win.effect', v.validateGameResultParameters, (_ctx, p) => [{ op: 'gameResult', result: p.result }]),
    handler('cn.takePrizes@1', 'prizes.take-effect', v.validateTakePrizesParameters, (_ctx, p) => [{ op: 'takePrizes', ...p }],
      { canUse: (ctx) => ctx.state.players[ctx.source.owner].prizes.length > 0 }),
    // 「从双方场上所有宝可梦中，选择1只剩余HP最少的宝可梦」: usable while any matching Pokémon (one of them has the least) is there.
    handler('cn.knockOut@1', 'effects.knockout', v.validateKnockOutParameters, (_ctx, p) => [{ op: 'knockOut', ...p }],
      { canUse: (ctx, p) => (p.side === 'both' ? [ctx.source.owner, 1 - ctx.source.owner] : [p.side === 'opponent' ? 1 - ctx.source.owner : ctx.source.owner])
        .some((owner) => subjects(ctx, owner).some((m) => matches(ctx, p.target, owner, m) && switchCandidate(ctx, m, p) &&
          !(p.excludeSelf && m.id === ctx.source.pokemonId))),
      sourceOfTruth: ['effects.knockout', 'effects.knockout-lowest'].flatMap((key) => requireRule(CN_V20261019, key).sourceOfTruth) }),
  ];
  const leaves = new Map(h.map((entry) => [entry.id, entry]));
  // Any registered handler a validator admits nested (a choice, a whole-hand pair), compiled with its own program.
  const nested = (n) => leaves.get(n.handlerId) ?? h.find((x) => x.id === n.handlerId);
  const program = (ctx, n) => ({ op: 'sequence', steps: nested(n).execute(ctx, n.parameters) });
  const usable = (ctx, n) => !nested(n).canUse || nested(n).canUse(ctx, n.parameters);
  const thenProgram = (ctx, p) => ({ op: 'then', first: program(ctx, p.first), next: Array.isArray(p.next)
    ? { op: 'sequence', steps: p.next.flatMap((n) => nested(n).execute(ctx, n.parameters)) }
    : p.next.handlerId === 'cn.coin@1' ? { op: 'sequence', steps: h.find((x) => x.id === 'cn.coin@1').execute(ctx, p.next.parameters) }
      : program(ctx, p.next) });
  // A nested leaf, or one 「A。在这种情况下，B」 pair.
  const thenOrLeaf = (ctx, n) => n.handlerId === 'cn.then@1' ? { op: 'sequence', steps: [thenProgram(ctx, n.parameters)] } : program(ctx, n);
  const thenOrLeafUsable = (ctx, n) => usable(ctx, n.handlerId === 'cn.then@1' ? n.parameters.first : n);
  // A coin's printed result may lead to one choice (cn.chooseOne@1, registered below).
  const chooser = () => h.find((x) => x.id === 'cn.chooseOne@1');
  const coinBranch = (ctx, n) => n.handlerId === 'cn.chooseOne@1' ? { op: 'sequence', steps: chooser().execute(ctx, n.parameters) } : program(ctx, n);
  const coinBranchUsable = (ctx, n) => n.handlerId === 'cn.chooseOne@1' ? chooser().canUse(ctx, n.parameters) : usable(ctx, n);
  const coinParts = (p) => [...(p.effects ?? [p.effect]), ...(p.otherwise ? [p.otherwise] : [])];
  // effects.optional-cost: the paid parts; the Mallow & Lana form changes something more only when the Pokémon switched to the Bench has damage.
  const paidParts = (p) => p.effects ?? [p.effect];
  const healsMore = (ctx, p) => !p.otherwise || (ctx.state.players[ctx.source.owner].active?.counters ?? 0) > 0;
  h.push(
    // 「另外，当使用这张卡牌时，可将N张自己的手牌放于弃牌区。在这种情况下，…」: only when that optional play cost was paid.
    handler('cn.ifPaid@1', 'effects.optional-cost', validateIfPaidEffect, (ctx, p) => [{ op: 'ifPaid',
      effect: p.effects ? { op: 'sequence', steps: p.effects.flatMap((n) => nested(n).execute(ctx, n.parameters)) } : program(ctx, p.effect),
      ...(p.otherwise ? { otherwise: program(ctx, p.otherwise) } : {}) }],
    { canUse: (ctx, p) => ctx.payment ? paidParts(p).some((n) => usable(ctx, n)) && healsMore(ctx, p) : Boolean(p.otherwise) && usable(ctx, p.otherwise),
      paidUsable: (ctx, p, costs, withCosts) => paidParts(p).some((n) => withCosts(n.handlerId).canUseWithCosts(ctx, n.parameters, costs)) &&
        healsMore(ctx, p) }),
    // II.E-20 「使用了这张卡牌的回合结束时，（如果…，则）…」: recorded now, performed when this turn ends, before the checkup.
    handler('cn.turnEndEffect@1', 'effects.turn-end', validateTurnEndEffect, (ctx, p) => [{ op: 'turnEndEffect',
      program: [p.condition ? { op: 'when', condition: p.condition, effect: program(ctx, p.effect) } : program(ctx, p.effect)] }],
    { capabilities: ['board-condition'], embeddedOperations: ['when', 'sequence', 'draw', 'discardHand', 'cards'] }),
    // 「若希望，可让对手…放回牌库并重洗牌库。在这种情况下，…抽取与放回的张数相同数量」 (optional): the counts are read now,
    // before the user decides; nothing happens in between (II.E-10).
    handler('cn.handDeckDraw@1', 'effects.hand-deck', v.validateHandDeckDrawParameters, (ctx, p) => {
      const pair = { op: 'then', first: { op: 'shuffleHandIntoDeck', side: p.side },
        next: { op: 'sequence', steps: [
          drawStep(ctx, ctx.source.owner, p.ownDraw), drawStep(ctx, 1 - ctx.source.owner, p.opponentDraw),
        ] } };
      return [p.optional ? { op: 'optional', effect: { op: 'sequence', steps: [pair] } } : pair];
    }, { capabilities: ['battle-values'], canUse: (ctx, p) => handDeckAvailable(ctx, p),
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
        ? { op: 'sequence', steps: p.effects.flatMap((n) => nested(n).execute(ctx, n.parameters)) } : coinBranch(ctx, p.effect),
      ...(p.otherwise ? { otherwise: program(ctx, p.otherwise) } : {}),
    }], { canUse: (ctx, p) => [...(p.effects ?? [p.effect]), ...(p.otherwise ? [p.otherwise] : [])].some((n) => coinBranchUsable(ctx, n)) }),
    // 「与对手玩家猜拳，如果自己赢了，则…」: only the user's win runs the printed result.
    handler('cn.janken@1', 'effects.janken', validateJankenEffect, (ctx, p) => [{
      op: 'janken', effect: p.effects
        ? { op: 'sequence', steps: p.effects.flatMap((n) => nested(n).execute(ctx, n.parameters)) } : program(ctx, p.effect),
    }], { canUse: (ctx, p) => (p.effects ?? [p.effect]).some((n) => usable(ctx, n)) }),
    // 「抛掷与自己场上的「X」数量相同次数的硬币」: the count is read when the flips start; none flips nothing.
    handler('cn.coins@1', 'effects.coin-count', validateCoinsEffect, (ctx, p) => {
      const flips = p.flips.kind === 'count' ? Math.min(60, resolvedFlips(ctx, p)) : null;
      return flips === 0 ? [] : [{
        op: 'coins', flips: flips === null ? p.flips : { kind: 'fixed', count: flips }, face: p.face, effect: program(ctx, p.effect),
        apply: p.apply.kind === 'scale' ? { kind: 'scale', path: SCALED_FIELDS[p.effect.handlerId] } : p.apply,
      }];
    }, { capabilities: ['battle-values'], canUse: (ctx, p) => (p.flips.kind !== 'count' || resolvedFlips(ctx, p) > 0) && usable(ctx, p.effect) }),
    // 「将这只宝可梦放于自己的备战区。然后，…」 in a beforeHand Ability (II.E-19): the next part only once it was placed.
    handler('cn.deployIncomingThen@1', 'trigger.before-hand', validateDeployIncomingThenEffect, (ctx, p) => [{
      op: 'then', first: { op: 'deployIncoming' }, next: p.next.handlerId === 'cn.coin@1'
        ? { op: 'sequence', steps: h.find((x) => x.id === 'cn.coin@1').execute(ctx, p.next.parameters) } : program(ctx, p.next),
    }], { canUse: (ctx) => leaves.get('cn.deployIncoming@1').canUse(ctx, {}),
      sourceOfTruth: ['trigger.before-hand', 'effects.partial'].flatMap((key) => requireRule(CN_V20261019, key).sourceOfTruth) }),
    // 「将这张卡牌放于备战区。然后，…」 from hand or the discard pile: the next part acts on the Pokémon this card became.
    // 「将这张卡牌放回牌库下方／放于放逐区。（然后，…）」 (to): the card goes there instead; the next part follows once it did.
    handler('cn.deploySelf@1', 'ability.zone', validateDeploySelfEffect, (ctx, p) => {
      const first = { op: 'deploySelf', ...(p.to ? { to: p.to } : {}) };
      return p.next ? [{ op: 'then', first, next: p.next.handlerId === 'cn.coin@1'
        ? { op: 'sequence', steps: h.find((x) => x.id === 'cn.coin@1').execute(ctx, p.next.parameters) } : program(ctx, p.next) }] : [first];
    }, { canUse: (ctx, p) => ['hand', 'discard'].includes(ctx.source.origin) &&
      ctx.state.players[ctx.source.owner][ctx.source.origin].includes(ctx.source.instanceId) && (!!p.to || benchRoom(ctx) &&
      enterable(ctx, ctx.source.owner, def(ctx, ctx.source.instanceId))),
      sourceOfTruth: ['ability.zone', 'effects.deploy', 'effects.partial'].flatMap((key) => requireRule(CN_V20261019, key).sourceOfTruth) }),
    // 「若希望，可…。在这种情况下，追加造成N伤害」: before damage; declining records no moved card.
    handler('cn.optionalCounted@1', 'damage.effect-count', validateOptionalCountedEffect, (ctx, p) => [{
      op: 'optional', effect: program(ctx, p.effect),
    }], { timing: 'beforeDamage', capabilities: ['effect-card-count'],
      sourceOfTruth: ['damage.effect-count', 'selection.optional', 'damage.counted-attach', 'effects.deck-top-count']
        .flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth) }),
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
        ? (p.effects ?? [p.effect]).some((n) => usable(ctx, n)) : Boolean(p.otherwise) && usable(ctx, p.otherwise),
      sourceOfTruth: ['effects.condition', 'effects.counted-condition'].flatMap((key) => requireRule(CN_V20261019, key).sourceOfTruth) }),
    // II.E-10: the user may decline the whole effect; declining performs nothing (and so unlocks no then).
    // 「若希望，可A。在这种情况下，B」: declining A performs nothing, and B needs A performed (cn.then@1).
    handler('cn.optional@1', 'selection.optional', validateOptionalEffect, (ctx, p) => [{
      op: 'optional', effect: p.effect.handlerId === 'cn.then@1' ? { op: 'sequence', steps: [thenProgram(ctx, p.effect.parameters)] } :
        HAND_SHUFFLES.includes(p.effect.handlerId) ? { op: 'sequence', steps: h.find((x) => x.id === p.effect.handlerId).execute(ctx, p.effect.parameters) } :
          program(ctx, p.effect),
    }], { canUse: (ctx, p) => HAND_SHUFFLES.includes(p.effect.handlerId) ? h.find((x) => x.id === p.effect.handlerId).canUse(ctx, p.effect.parameters) :
      usable(ctx, p.effect.handlerId === 'cn.then@1' ? p.effect.parameters.first : p.effect) }),
    handler('cn.orElse@1', 'effects.or-else', validateOrElseEffect, (ctx, p) => [{
      op: 'orElse', first: program(ctx, p.first), otherwise: program(ctx, p.otherwise),
    }], { canUse: (ctx, p) => usable(ctx, p.first) || usable(ctx, p.otherwise) }),
    // II.E-19 FAQ2: if the part before 然后 cannot be performed at all, the whole instruction changes nothing.
    // I.B-04: declared by the current player, once per own turn for this card's key.
    handler('cn.stadiumUse@1', 'stadium.use', validateStadiumUseEffect, (ctx, p) => [Object.hasOwn(STADIUM_CONTROLS, p.effect.handlerId)
      ? { op: 'sequence', steps: h.find((x) => x.id === p.effect.handlerId).execute(ctx, p.effect.parameters) } : thenOrLeaf(ctx, p.effect)], {
      timing: 'onUse', usageFor: (p) => ({ period: 'turn', scope: 'player', key: p.key, limit: 1 }), capabilities: ['battle-values'],
      canUse: (ctx, p) => Object.hasOwn(STADIUM_CONTROLS, p.effect.handlerId)
        ? h.find((x) => x.id === p.effect.handlerId).canUse(ctx, p.effect.parameters) : thenOrLeafUsable(ctx, p.effect),
      sourceOfTruth: ['stadium.use', 'effects.search', 'effects.deploy'].flatMap((key) => requireRule(CN_V20261019, key).sourceOfTruth) }),
    handler('cn.then@1', 'effects.partial', validateThenEffect, (ctx, p) => [thenProgram(ctx, p)], { canUse: (ctx, p) => usable(ctx, p.first),
      sourceOfTruth: ['effects.partial', 'effects.switch', 'energy.move'].flatMap((key) => requireRule(CN_V20261019, key).sourceOfTruth) }),
    // 「从2个效果中选择1个使用」: the user picks one printed option that could change something now (effects.choose-one).
    // 「…。然后，B」 (next): read first, B only if the counted part was performed (II.E-19); nothing at all at 0.
    handler('cn.countValue@1', 'effects.count-value', validateCountValueEffect, (ctx, p) => {
      const parameters = valuedLeaf(ctx, p);
      if (!parameters) return [];
      const steps = leaves.get(p.effect.handlerId).execute(ctx, parameters);
      return p.next ? [{ op: 'then', first: { op: 'sequence', steps }, next: program(ctx, p.next) }] : steps;
    }, { capabilities: ['battle-values'], canUse: (ctx, p) => {
      const parameters = valuedLeaf(ctx, p), leaf = leaves.get(p.effect.handlerId);
      return parameters !== null && (!leaf.canUse || leaf.canUse(ctx, parameters));
    }, sourceOfTruth: ['effects.count-value', 'effects.count-value-target'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth) }),
    handler('cn.chooseOne@1', 'effects.choose-one', validateChooseOneEffect, (ctx, p) => [{ op: 'choose',
      options: p.options.map((o) => (Array.isArray(o) ? o : [o])).map((entries) => ({
        entries: entries.map((n) => ({ handlerId: n.handlerId, parameters: n.parameters })),
        effect: { op: 'sequence', steps: entries.flatMap((n) => n.handlerId === 'cn.then@1' ? [thenProgram(ctx, n.parameters)] :
          h.find((x) => x.id === n.handlerId).execute(ctx, n.parameters)) } })), ...(p.chooser ? { chooser: p.chooser } : {}) }],
    { canUse: (ctx, p) => p.options.some((o) => (Array.isArray(o) ? o : [o]).some((n) => {
      const entry = h.find((x) => x.id === n.handlerId);
      return !entry.canUse || entry.canUse(ctx, n.parameters);
    })), sourceOfTruth: ['effects.choose-one', 'effects.choose-one-opponent'].flatMap((key) => requireRule(CN_V20261019, key).sourceOfTruth) }),
    // 「其张数」「与其相同张数」「其中的…」: B is bound to the cards A actually moved (effects.moved-cards).
    // counted: A is this attack's own counted before-damage entry; condition: 「如果…的话，则B」 judged when B is reached;
    // ifMoved: 「如果被放于弃牌区的卡牌是X的话，则再…」 after B.
    handler('cn.thenMoved@1', 'effects.moved-cards', validateThenMovedEffect, (ctx, p) => {
      const leaf = (n) => {
        const steps = nested(n).execute(ctx, n.parameters);
        if (steps.length !== 1) throw new TypeError('A moved-card instruction composes single leaves.');
        return steps[0];
      };
      const bound = p.use === 'cards' ? { ...leaf(p.next), among: 'moved' } : leaf(p.next);
      return [{ op: 'thenMoved', first: p.counted ? { op: 'recordedCards', effectId: p.counted } : leaf(p.first),
        next: p.condition ? { op: 'when', condition: p.condition, effect: bound } : bound, use: p.use,
        ...(p.use === 'count' ? { path: SCALED_FIELDS[p.next.handlerId] } : {}), ...(p.optional ? { optional: true } : {}),
        ...(p.first?.handlerId === 'cn.switch@1' ? { origin: true } : {}),
        ...(p.ifMoved ? { ifMoved: { op: 'ifMoved', among: 'moved', selector: p.ifMoved.selector, effect: leaf(p.ifMoved.effect) } } : {}) }];
    }, { canUse: (ctx, p) => !p.first || usable(ctx, p.first), capabilities: ['board-condition'],
      sourceOfTruth: ['effects.partial', 'effects.moved-cards'].flatMap((key) => requireRule(CN_V20261019, key).sourceOfTruth) }),
  );
  // Candidate-count checks for hand-only costs. The host separately proves a
  // possible actual change with the real source/protection, never merely that
  // an Active/Bench or damaged target exists. Cross-source cost dependencies
  // cannot be inferred from this local candidate predicate alone.
  const independent = new Set(['cn.draw@1', 'cn.counters@1', 'cn.countersUntil@1', 'cn.heal@1', 'cn.lasting@1', 'cn.transferCounters@1', 'cn.switch@1',
    'cn.deployIncoming@1', 'cn.attachIncoming@1', 'cn.inspectDeck@1', 'cn.attachDeckEnergy@1', 'cn.prizeExchange@1', 'cn.healPokemon@1',
    'cn.distributeCounters@1', 'cn.discardStadium@1', 'cn.drawPokemonCount@1', 'cn.discardTools@1', 'cn.opponentHand@1',
    'cn.lastingPlayer@1', 'cn.arrangeDeck@1', 'cn.cure@1', 'cn.knockOut@1', 'cn.drawPlayers@1', 'cn.condition@1', 'cn.attachedEnergy@1',
    'cn.opponentMayDraw@1']);
  // A computed draw count that reads no hand or discard pile is the same before and after a hand cost is paid.
  const handFree = (value) => !/"zone":"(hand|discard)"/.test(JSON.stringify(value));
  const wrapped = new Map(h.map((entry) => {
    let canUseWithCosts;
    if (independent.has(entry.id)) canUseWithCosts = (ctx, p) => entry.canUse(ctx, p);
    if (['cn.shuffleHandToBottom@1', 'cn.handBottomDraw@1'].includes(entry.id))
      canUseWithCosts = (ctx, p, costs) => handBottomAvailable(ctx, p, costs);
    if (entry.id === 'cn.handDeckDraw@1') canUseWithCosts = (ctx, p, costs) => handDeckAvailable(ctx, p, costs);
    if (entry.id === 'cn.drawUntil@1') canUseWithCosts = (ctx, p, costs) => deckAfterCosts(ctx, costs) > 0 && handAfterCosts(ctx, costs) < p.count;
    if (entry.id === 'cn.draw@1') canUseWithCosts = (ctx, _p, costs) => deckAfterCosts(ctx, costs) > 0;
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
      if (p.from === 'hand') return pool.some((card) => movable(ctx, p, ctx.source.owner, card.definition) &&
        findCostPayment(costs, pool, { reserveIds: [card.instanceId] }) !== null);
      // A card paid into the Lost Zone (lostHand) is never in the discard pile afterwards.
      return entry.canUse(ctx, p) || costs.every((c) => c.kind === 'discardHand') && pool.some((card) => discardDestination(card.definition) === 'discard' &&
        movable(ctx, p, ctx.source.owner, card.definition) &&
        findCostPayment(costs, pool, { requiredIds: [card.instanceId] }) !== null);
    };
    if (['cn.attachHand@1', 'cn.attachDiscard@1'].includes(entry.id)) canUseWithCosts = (ctx, p, costs) => {
      const owner = ctx.source.owner;
      if (!attachTargets(ctx, p).length) return false;
      if (ctx.activation.player !== owner) return entry.canUse(ctx, p);
      const pool = costCards(ctx), zone = entry.id === 'cn.attachHand@1' ? 'hand' : 'discard';
      if (entry.id === 'cn.attachDiscard@1' && !costs.every((c) => c.kind === 'discardHand')) return entry.canUse(ctx, p);
      return (entry.id === 'cn.attachDiscard@1' && entry.canUse(ctx, p)) || pool.some((card) =>
        effectAttachable(card.definition, p, zone) && findCostPayment(costs, pool,
          entry.id === 'cn.attachHand@1' ? { reserveIds: [card.instanceId] } : { requiredIds: [card.instanceId] }) !== null);
    };
    // costCheckApplies: the parameters for which the post-cost proof holds (else a paid activation is unsupported).
    // effects.optional-cost: the paid parts' own post-cost proofs.
    if (entry.id === 'cn.ifPaid@1') canUseWithCosts = (ctx, p, costs) => entry.paidUsable(ctx, p, costs, (id) => wrapped.get(id));
    // 「只有将…放于弃牌区后才可使用。抛掷1次硬币如果为正面，则…」: a printed result that could change something after the payment.
    if (entry.id === 'cn.coin@1') canUseWithCosts = (ctx, p, costs) => coinParts(p).some((n) => wrapped.get(n.handlerId).canUseWithCosts(ctx, n.parameters, costs));
    const costCheckApplies = entry.id === 'cn.drawValue@1' ? (p) => handFree(p.count) :
      entry.id === 'cn.ifPaid@1' ? (p) => (p.effects ?? [p.effect]).every((n) => typeof wrapped.get(n.handlerId).canUseWithCosts === 'function') :
      entry.id === 'cn.coin@1' ? (p) => coinParts(p).every((n) => typeof wrapped.get(n.handlerId).canUseWithCosts === 'function') : null;
    return [entry.id, canUseWithCosts ? Object.freeze({ ...entry, costCheckVersion: '1', canUseWithCosts,
      ...(costCheckApplies ? { costCheckApplies } : {}) }) : entry];
  }));
  return wrapped;
}
