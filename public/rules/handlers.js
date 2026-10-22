// Source-reviewed reusable primitives, not a text parser and not card approvals.
import * as validators from './schema-validators.js';
import { CN_V20261019 } from './zh-CN/V20261019.js';
import { requireRule } from './registry.js';
import { matchesCardSelector } from './card-selection.js';
import { matchesInPlaySelector } from './in-play-selection.js';
import { costCardCount, findCostPayment } from './activation-cost.js';
import { canUseAttachedEnergy } from './energy-selection.js';
import { canUsePokemonTransition } from './evolution.js';
import { fieldReturnTargets } from './field-return.js';
import { deckEnergyRecipients } from './deck-energy.js';
import { prizesTakenForPlayer } from './prize-count.js';
import { evaluateDamageValue, evaluateBattleValue } from './battle-value.js';
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
  'discardStadium',
]);
const subjects = (ctx, owner) => ctx.subject ? ctx.subject.owner === owner ? [ctx.subject.pokemon] : [] :
  [ctx.state.players[owner].active, ...ctx.state.players[owner].bench].filter(Boolean);
const active = (ctx, owner, m) => ctx.subject ? ctx.subject.owner === owner && ctx.subject.active :
  m === ctx.state.players[owner].active;
const matches = (ctx, target, owner, m) => target === 'self' ? m.id === ctx.source.pokemonId :
  target === 'active' ? active(ctx, owner, m) : target === 'bench' ? !active(ctx, owner, m) : target === 'event' ? m.id === ctx.event?.subjectId :
  target === 'attacker' ? m.id === ctx.event?.cause.source?.pokemonId : true;
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
const drawCount = (ctx, player, spec) => {
  if (typeof spec === 'number') return spec;
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
  .filter((m) => (p.target !== 'self' || m.id === ctx.source.pokemonId) &&
    (!p.recipient || matchesInPlaySelector(ctx.definitions[ctx.state.cards[m.stack.at(-1)].definitionId], p.recipient,
      ctx.effectivePokemon[m.id].types)));
const attachEnergy = (d, p) => d.kind === 'energy' && d.mechanics.category === 'basic' &&
  (p.type === null || d.mechanics.baseUnits[0][0] === p.type);
const paidIds = (ctx) => (ctx.payment?.groups ?? []).flatMap((g) => g.cardIds);
const benchRoom = (ctx) => ctx.state.players[ctx.source.owner].bench.length < ctx.benchLimits[ctx.source.owner];
const inPlayCount = (ctx, side) => {
  const p = ctx.state.players[side === 'own' ? ctx.source.owner : 1 - ctx.source.owner];
  return [p.active, ...p.bench].filter(Boolean).length;
};
// The host answers the count's board/zone/history queries at resolution (ctx.battleValues).
const drawValue = (ctx, p) => Math.max(0, evaluateBattleValue(p.count, ctx.battleValues));
// Control handlers compose these reviewed static leaves only. Each leaf keeps
// its own validator; module-level functions keep native identity stable. A leaf's
// program is fixed when the control handler runs, so every leaf here must build it
// from its parameters alone: a leaf that reads the board while compiling (drawUntil,
// drawPokemonCount) would see the board before an earlier step of a then changed it.
const NESTED_VALIDATORS = Object.freeze({
  'cn.switch@1': validators.validateSwitchParameters, 'cn.condition@1': validators.validateConditionParameters,
  'cn.attachedEnergy@1': validators.validateAttachedEnergyParameters, 'cn.cards@1': validators.validateCardsParameters,
  'cn.cardsThenDraw@1': validators.validateCardsThenDrawParameters,
  'cn.lasting@1': validators.validateLastingParameters, 'cn.lastingPlayer@1': validators.validateLastingPlayerParameters,
  'cn.heal@1': validators.validateHealParameters, 'cn.healPokemon@1': validators.validatePokemonHealingParameters,
  'cn.counters@1': validators.validateCountersParameters, 'cn.draw@1': validators.validateDrawParameters,
  'cn.discardStadium@1': validators.validateDiscardStadiumParameters, 'cn.fieldReturn@1': validators.validateFieldReturnParameters,
  'cn.attachDeckEnergy@1': validators.validateAttachDeckEnergyParameters, 'cn.attachHand@1': validators.validateAttachDiscardParameters,
  'cn.attachDiscard@1': validators.validateAttachDiscardParameters, 'cn.discardDeckTop@1': validators.validateDiscardDeckTopParameters,
  'cn.pokemonTransition@1': validators.validatePokemonTransitionParameters,
});
// A then's parts are single leaves; a nested then (cardsThenDraw) stays outside.
const THEN_NESTED = Object.freeze(Object.keys(NESTED_VALIDATORS).filter((id) => id !== 'cn.cardsThenDraw@1'));
const LEAF_OPERATIONS = Object.freeze(['switch', 'condition', 'discardEnergy', 'moveEnergy', 'returnEnergy', 'cards', 'draw',
  'lasting', 'lastingPlayer', 'heal', 'healPokemon', 'counters', 'discardStadium', 'returnPokemon', 'attachDeckEnergy',
  'attachHand', 'attachDiscard', 'discardDeckTop', 'evolvePokemon', 'devolvePokemon', 'inheritPokemon']);
const NESTED_OPERATIONS = Object.freeze([...LEAF_OPERATIONS, 'then']);
const nestedValid = (n) => NESTED_VALIDATORS[n.handlerId](n.parameters);
export function validateCoinEffect(p) {
  return validators.validateCoinParameters(p) && (p.effects ?? [p.effect]).every(nestedValid);
}
export function validateOptionalEffect(p) { return validators.validateOptionalParameters(p) && nestedValid(p.effect); }
export function validateOrElseEffect(p) {
  return validators.validateOrElseParameters(p) && nestedValid(p.first) && nestedValid(p.otherwise);
}
export function validateStadiumUseEffect(p) {
  return validators.validateStadiumUseParameters(p) && p.effect.handlerId === 'cn.cards@1' && nestedValid(p.effect);
}
export function validateThenEffect(p) {
  return validators.validateThenParameters(p) && [p.first, p.next].every((n) => THEN_NESTED.includes(n.handlerId) && nestedValid(n));
}
function handler(id, ruleId, validateParameters, execute, extra = {}) {
  const operations = {
    'cn.draw@1': ['draw'], 'cn.discardHand@1': ['discardHand'], 'cn.counters@1': ['counters'],
    'cn.drawUntil@1': ['draw'], 'cn.switch@1': ['switch'],
    'cn.heal@1': ['heal'], 'cn.condition@1': ['condition'], 'cn.modifier@1': ['modifier'],
    'cn.attackPermissions@1': [], 'cn.attachDiscard@1': ['attachDiscard'], 'cn.attachHand@1': ['attachHand'],
    'cn.protection@1': ['protection'], 'cn.property@1': ['property'],
    'cn.damageOptions@1': [], 'cn.transferCounters@1': ['transferCounters'],
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
    'cn.drawPokemonCount@1': ['draw'], 'cn.drawValue@1': ['draw'],
    'cn.cardsThenDraw@1': ['then', 'cards', 'draw'],
    'cn.countedEnergyDiscard@1': ['discardEnergy'],
    'cn.coin@1': ['coin', 'sequence', ...NESTED_OPERATIONS],
    'cn.optional@1': ['optional', 'sequence', ...NESTED_OPERATIONS],
    'cn.orElse@1': ['orElse', 'sequence', ...NESTED_OPERATIONS],
    'cn.then@1': ['then', 'sequence', ...LEAF_OPERATIONS],
    'cn.discardDeckTop@1': ['discardDeckTop'],
    'cn.attachThenDraw@1': ['then', 'attachHand', 'attachDiscard', 'draw'],
    'cn.replacePokemon@1': ['replacePokemon'],
    'cn.benchLimit@1': ['benchLimit'],
    'cn.knockOut@1': ['knockOut'],
    'cn.stadiumUse@1': ['sequence', 'cards'],
  }[id];
  const schemaName = {
    'cn.disableOwnedAttack@1': 'ownedAttackLock',
    'cn.draw@1': 'draw', 'cn.discardHand@1': 'empty', 'cn.counters@1': 'counters', 'cn.heal@1': 'heal',
    'cn.drawUntil@1': 'draw', 'cn.switch@1': 'switch',
    'cn.condition@1': 'condition', 'cn.modifier@1': 'modifier', 'cn.attackPermissions@1': 'permissions', 'cn.attachDiscard@1': 'attachDiscard',
    'cn.attachHand@1': 'attachDiscard',
    'cn.protection@1': 'protection', 'cn.property@1': 'property',
    'cn.damageOptions@1': 'damageOptions', 'cn.transferCounters@1': 'transferCounters',
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
    'cn.handDeckDraw@1': 'handDeckDraw', 'cn.drawPokemonCount@1': 'drawPokemonCount', 'cn.drawValue@1': 'drawValue',
    'cn.cardsThenDraw@1': 'cardsThenDraw', 'cn.coin@1': 'coin', 'cn.optional@1': 'optional', 'cn.orElse@1': 'orElse',
    'cn.countedEnergyDiscard@1': 'countedEnergyDiscard',
    'cn.then@1': 'then', 'cn.discardDeckTop@1': 'discardDeckTop', 'cn.attachThenDraw@1': 'attachThenDraw',
    'cn.replacePokemon@1': 'replacePokemon', 'cn.benchLimit@1': 'benchLimit', 'cn.knockOut@1': 'knockOut',
    'cn.stadiumUse@1': 'stadiumUse',
  }[id];
  return Object.freeze({
    id, rulesetId: CN_V20261019.id, implementationVersion: '1', timing: 'resolve',
    operations,
    parameterSchemaRef: `urn:pokemon-tcg:core-handler-parameters:1.0.0#/$defs/${schemaName}`,
    sourceOfTruth: [ruleId, ...(['cn.counters@1', 'cn.heal@1', 'cn.healPokemon@1', 'cn.distributeCounters@1', 'cn.discardStadium@1'].includes(id) ?
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
    }], { canUse: (ctx, p) => handBottomAvailable(ctx, p),
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
        const player = ctx.state.players[ctx.source.owner];
        if (p.to === 'bench' && !benchRoom(ctx)) return false;
        const pool = (p.from === 'deck' && p.lookTop !== null ? player.deck.slice(-p.lookTop) : player[p.from])
          .filter((id) => p.from !== 'hand' || ctx.source.category !== 'trainer' || id !== ctx.source.instanceId)
          .filter((id) => !p.excludePaid || !paidIds(ctx).includes(id));
        // Full deck inspection is a legitimate hidden-information action;
        // public/known zones cannot be used when there is no eligible card.
        return p.from === 'deck' ? pool.length > 0 : pool.some((id) => matchesCardSelector(def(ctx, id), p.selector));
      } }),
    handler('cn.shuffle@1', 'effects.shuffle', v.validateShuffleParameters, (_ctx, p) => [{ op: 'shuffle', ...p }],
      { canUse: (ctx, p) => ctx.state.players[p.side === 'own' ? ctx.source.owner : 1 - ctx.source.owner][p.zone].length > 0 }),
    handler('cn.switch@1', 'effects.switch', v.validateSwitchParameters, (_ctx, p) => [{ op: 'switch', ...p }],
      { canUse: (ctx, p) => {
        const player = ctx.state.players[p.side === 'own' ? ctx.source.owner : 1 - ctx.source.owner];
        // C-03—05: this is not Retreat. Protection applies to the actual
        // affected Pokémon at resolution, not to selecting a Bench Pokémon.
        return !!player.active && (p.affected === 'source' ? player.bench.some((m) => m.id === ctx.source.pokemonId) : player.bench.length > 0);
      }, sourceOfTruth: ['effects.switch', 'effects.activation-cost', 'effects.activation-change']
        .flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth) }),
    handler('cn.draw@1', 'effects.draw', v.validateDrawParameters, (ctx, p) => [{ op: 'draw', count: p.count }],
      { canUse: (ctx) => ctx.state.players[ctx.source.owner].deck.length > 0 }),
    handler('cn.drawUntil@1', 'effects.draw', v.validateDrawParameters, (ctx, p) => [{
      op: 'draw', count: Math.max(0, p.count - ctx.state.players[ctx.source.owner].hand.length),
    }], { canUse: (ctx, p) => ctx.state.players[ctx.source.owner].deck.length > 0 && handAfterCosts(ctx, []) < p.count }),
    handler('cn.discardHand@1', 'effects.discard', v.validateEmptyParameters, () => [{ op: 'discardHand' }],
      { canUse: (ctx) => ctx.state.players[ctx.source.owner].hand.some((id) => id !== ctx.source.instanceId) }),
    handler('cn.counters@1', 'damage.counters', v.validateCountersParameters, (_ctx, p) => [{ op: 'counters', ...p }],
      { canUse: (ctx, p) => {
        const owner = p.side === 'own' ? ctx.source.owner : 1 - ctx.source.owner;
        return subjects(ctx, owner).some((m) => matches(ctx, p.target, owner, m));
      } }),
    handler('cn.heal@1', 'effects.heal', v.validateHealParameters, (_ctx, p) => [{ op: 'heal', side: p.side ?? 'own', target: p.target, count: p.amount / 10 }],
      { canUse: (ctx, p) => {
        const owner = p.side === 'opponent' ? 1 - ctx.source.owner : ctx.source.owner;
        return subjects(ctx, owner).some((m) => m.counters > 0 && matches(ctx, p.target, owner, m));
      } }),
    handler('cn.condition@1', 'status.exclusive', v.validateConditionParameters, (_ctx, p) => [{ op: 'condition', target: p.target ?? 'active', ...p }]),
    handler('cn.modifier@1', 'damage.attacker', v.validateModifierParameters, (_ctx, p) => [{ op: 'modifier', ...p }],
      { timing: 'continuous' }),
    handler('cn.protection@1', 'effects.protection', v.validateProtectionParameters, (_ctx, p) => [p.effect],
      { timing: 'continuous' }),
    handler('cn.property@1', 'damage.ignore-defender', v.validatePropertyParameters, (_ctx, p) => [p.effect],
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
    handler('cn.playerRestriction@1', 'effects.player-lock', v.validatePlayerRestrictionParameters, (_ctx, p) => [p.effect], { timing: 'continuous' }),
    handler('cn.suppression@1', 'effects.remove-content', v.validateSuppressionParameters, (_ctx, p) => [p.effect], { timing: 'suppression' }),
    handler('cn.lastingPlayer@1', 'effects.player-lock', v.validateLastingPlayerParameters, (_ctx, p) => [{ op: 'lastingPlayer', ...p }]),
    handler('cn.delayedReaction@1', 'trigger.damage', v.validateDelayedReactionParameters, (_ctx, p) => [{ op: 'delayedReaction', ...p }],
      { embeddedOperations: REACTION_OPERATIONS }),
    handler('cn.transferCounters@1', 'damage.counters', v.validateTransferCountersParameters, (_ctx, p) => [{ op: 'transferCounters', ...p }],
      { canUse: (ctx, p) => subjects(ctx, ctx.source.owner).some((m) => m.counters > 0 &&
        (p.from !== 'self' || m.id === ctx.source.pokemonId) &&
        subjects(ctx, p.side === 'own' ? ctx.source.owner : 1 - ctx.source.owner).some((target) =>
          target.id !== m.id && (p.target !== 'active' || target === ctx.state.players[p.side === 'own' ? ctx.source.owner : 1 - ctx.source.owner].active))) }),
    handler('cn.attackPermissions@1', 'attack.first-turn', v.validatePermissionsParameters, () => [],
      { timing: 'permission', permissions: (_ctx, p) => p.permissions }),
    handler('cn.attachDiscard@1', 'effects.attach', v.validateAttachDiscardParameters, (_ctx, p) => [{ op: 'attachDiscard', ...p }],
      { canUse: (ctx, p) => attachTargets(ctx, p).length > 0 &&
        ctx.state.players[ctx.source.owner].discard.some((id) => attachEnergy(def(ctx, id), p)) }),
    handler('cn.attachHand@1', 'effects.attach', v.validateAttachDiscardParameters, (_ctx, p) => [{ op: 'attachHand', ...p }],
      { canUse: (ctx, p) => attachTargets(ctx, p).length > 0 &&
        ctx.state.players[ctx.source.owner].hand.some((id) => attachEnergy(def(ctx, id), p)) }),
    handler('cn.discardDeckTop@1', 'effects.deck-top-discard', v.validateDiscardDeckTopParameters, (_ctx, p) => [{ op: 'discardDeckTop', ...p }],
      { canUse: (ctx, p) => ctx.state.players[p.side === 'own' ? ctx.source.owner : 1 - ctx.source.owner].deck.length > 0 }),
    handler('cn.replacePokemon@1', 'effects.replace', v.validateReplacePokemonParameters, (_ctx, p) => [p],
      { canUse: (ctx) => ctx.state.players[ctx.source.owner].deck.length > 0 &&
        subjects(ctx, ctx.source.owner).some((m) => m.id === ctx.source.pokemonId),
        sourceOfTruth: ['effects.replace', 'effects.search', 'effects.shuffle'].flatMap((key) => requireRule(CN_V20261019, key).sourceOfTruth) }),
    handler('cn.benchLimit@1', 'bench.limit', v.validateBenchLimitParameters, (_ctx, p) => [p.effect], { timing: 'continuous' }),
    handler('cn.knockOut@1', 'effects.knockout', v.validateKnockOutParameters, (_ctx, p) => [{ op: 'knockOut', ...p }],
      { canUse: (ctx) => subjects(ctx, ctx.source.owner).some((m) => m.id === ctx.source.pokemonId) }),
  ];
  const leaves = new Map(h.map((entry) => [entry.id, entry]));
  const nested = (n) => leaves.get(n.handlerId);
  const program = (ctx, n) => ({ op: 'sequence', steps: nested(n).execute(ctx, n.parameters) });
  const usable = (ctx, n) => !nested(n).canUse || nested(n).canUse(ctx, n.parameters);
  h.push(
    handler('cn.handDeckDraw@1', 'effects.hand-deck', v.validateHandDeckDrawParameters, (ctx, p) => [{
      op: 'then', first: { op: 'shuffleHandIntoDeck', side: p.side },
      next: { op: 'sequence', steps: [
        { op: 'draw', player: ctx.source.owner, count: drawCount(ctx, ctx.source.owner, p.ownDraw) },
        { op: 'draw', player: 1 - ctx.source.owner, count: drawCount(ctx, 1 - ctx.source.owner, p.opponentDraw) },
      ] },
    }], { canUse: (ctx, p) => handDeckAvailable(ctx, p),
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
    }], { canUse: (ctx, p) => (p.effects ?? [p.effect]).some((n) => usable(ctx, n)) }),
    // II.E-10: the user may decline the whole effect; declining performs nothing (and so unlocks no then).
    handler('cn.optional@1', 'selection.optional', validateOptionalEffect, (ctx, p) => [{
      op: 'optional', effect: program(ctx, p.effect),
    }], { canUse: (ctx, p) => usable(ctx, p.effect) }),
    handler('cn.orElse@1', 'effects.or-else', validateOrElseEffect, (ctx, p) => [{
      op: 'orElse', first: program(ctx, p.first), otherwise: program(ctx, p.otherwise),
    }], { canUse: (ctx, p) => usable(ctx, p.first) || usable(ctx, p.otherwise) }),
    // II.E-19 FAQ2: if the part before 然后 cannot be performed at all, the whole instruction changes nothing.
    // I.B-04: declared by the current player, once per own turn for this card's key.
    handler('cn.stadiumUse@1', 'stadium.use', validateStadiumUseEffect, (ctx, p) => [program(ctx, p.effect)], {
      timing: 'onUse', usageFor: (p) => ({ period: 'turn', scope: 'player', key: p.key, limit: 1 }),
      canUse: (ctx, p) => usable(ctx, p.effect),
      sourceOfTruth: ['stadium.use', 'effects.search', 'effects.deploy'].flatMap((key) => requireRule(CN_V20261019, key).sourceOfTruth) }),
    handler('cn.then@1', 'effects.partial', validateThenEffect, (ctx, p) => [{
      op: 'then', first: program(ctx, p.first), next: program(ctx, p.next),
    }], { canUse: (ctx, p) => usable(ctx, p.first),
      sourceOfTruth: ['effects.partial', 'effects.switch', 'energy.move'].flatMap((key) => requireRule(CN_V20261019, key).sourceOfTruth) }),
  );
  // Candidate-count checks for hand-only costs. The host separately proves a
  // possible actual change with the real source/protection, never merely that
  // an Active/Bench or damaged target exists. Cross-source cost dependencies
  // cannot be inferred from this local candidate predicate alone.
  const independent = new Set(['cn.draw@1', 'cn.counters@1', 'cn.heal@1', 'cn.lasting@1', 'cn.transferCounters@1', 'cn.switch@1',
    'cn.deployIncoming@1', 'cn.attachIncoming@1', 'cn.inspectDeck@1', 'cn.attachDeckEnergy@1', 'cn.prizeExchange@1', 'cn.healPokemon@1',
    'cn.distributeCounters@1', 'cn.discardStadium@1', 'cn.drawPokemonCount@1']);
  return new Map(h.map((entry) => {
    let canUseWithCosts;
    if (independent.has(entry.id)) canUseWithCosts = (ctx, p) => entry.canUse(ctx, p);
    if (['cn.shuffleHandToBottom@1', 'cn.handBottomDraw@1'].includes(entry.id))
      canUseWithCosts = (ctx, p, costs) => handBottomAvailable(ctx, p, costs);
    if (entry.id === 'cn.handDeckDraw@1') canUseWithCosts = (ctx, p, costs) => handDeckAvailable(ctx, p, costs);
    if (entry.id === 'cn.drawUntil@1') canUseWithCosts = (ctx, p, costs) =>
      ctx.state.players[ctx.source.owner].deck.length > 0 && handAfterCosts(ctx, costs) < p.count;
    if (entry.id === 'cn.discardHand@1') canUseWithCosts = (ctx, _p, costs) => handAfterCosts(ctx, costs) > 0;
    if (entry.id === 'cn.shuffle@1') canUseWithCosts = (ctx, p, costs) => p.zone === 'hand' &&
      (p.side === 'own' ? ctx.source.owner : 1 - ctx.source.owner) === ctx.activation.player ?
      handAfterCosts({ ...ctx, source: { ...ctx.source, owner: ctx.activation.player } }, costs) > 0 : entry.canUse(ctx, p);
    if (entry.id === 'cn.cards@1') canUseWithCosts = (ctx, p, costs) => {
      if (p.to === 'bench' && !benchRoom(ctx)) return false;
      // Cards this activation discards as its cost are never eligible when excluded.
      if (ctx.activation.player !== ctx.source.owner || p.from === 'deck' || p.excludePaid) return entry.canUse(ctx, p);
      const pool = costCards(ctx);
      if (p.from === 'hand') return pool.some((card) => matchesCardSelector(card.definition, p.selector) &&
        findCostPayment(costs, pool, { reserveIds: [card.instanceId] }) !== null);
      return entry.canUse(ctx, p) || pool.some((card) => discardDestination(card.definition) === 'discard' &&
        matchesCardSelector(card.definition, p.selector) &&
        findCostPayment(costs, pool, { requiredIds: [card.instanceId] }) !== null);
    };
    if (['cn.attachHand@1', 'cn.attachDiscard@1'].includes(entry.id)) canUseWithCosts = (ctx, p, costs) => {
      const owner = ctx.source.owner;
      if (!attachTargets(ctx, p).length) return false;
      if (ctx.activation.player !== owner) return entry.canUse(ctx, p);
      const pool = costCards(ctx), selector = { kind: 'energy', category: 'basic', ...(p.type === null ? {} : { types: [p.type] }) };
      return (entry.id === 'cn.attachDiscard@1' && entry.canUse(ctx, p)) || pool.some((card) =>
        matchesCardSelector(card.definition, selector) && findCostPayment(costs, pool,
          entry.id === 'cn.attachHand@1' ? { reserveIds: [card.instanceId] } : { requiredIds: [card.instanceId] }) !== null);
    };
    return [entry.id, canUseWithCosts ? Object.freeze({ ...entry, costCheckVersion: '1', canUseWithCosts }) : entry];
  }));
}
