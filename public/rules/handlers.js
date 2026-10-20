// Source-reviewed reusable primitives, not a text parser and not card approvals.
import * as validators from './schema-validators.js';
import { CN_V20261019 } from './zh-CN/V20261019.js';
import { requireRule } from './registry.js';
import { matchesCardSelector } from './card-selection.js';
import { costCardCount, findCostPayment } from './activation-cost.js';
import { canUseAttachedEnergy } from './energy-selection.js';
import { canUsePokemonTransition } from './evolution.js';
import { fieldReturnTargets } from './field-return.js';
import { deckEnergyRecipients } from './deck-energy.js';
import { prizesTakenForPlayer } from './prize-count.js';
import { evaluateDamageValue } from './battle-value.js';
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
        { op: 'draw', player: ctx.source.owner, count: p.ownDraw },
        { op: 'draw', player: 1 - ctx.source.owner, count: p.opponentDraw },
      ] },
    }], { canUse: (ctx, p) => handBottomAvailable(ctx, p) }),
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
    handler('cn.attachedEnergy@1', 'energy.attached-selection', v.validateAttachedEnergyParameters, (_ctx, p) => [p],
      { canUse: (ctx, p) => canUseAttachedEnergy(ctx, p),
        sourceOfTruth: ['energy.attached-selection', 'energy.return'].flatMap((id) => requireRule(CN_V20261019, id).sourceOfTruth) }),
    handler('cn.deployIncoming@1', 'trigger.before-hand', v.validateEmptyParameters, () => [{ op: 'deployIncoming' }],
      { canUse: (ctx) => !!ctx.entry && def(ctx, ctx.entry.cardId).kind === 'pokemon' && ctx.state.players[ctx.source.owner].bench.length < 5 }),
    handler('cn.attachIncoming@1', 'trigger.before-hand', v.validateAttachIncomingParameters, (_ctx, p) => [{ op: 'attachIncoming', ...p }],
      { canUse: (ctx, p) => !!ctx.entry && def(ctx, ctx.entry.cardId).kind === 'energy' && subjects(ctx, ctx.source.owner).some((m) =>
        p.target === 'bench' ? !active(ctx, ctx.source.owner, m) : matches(ctx, p.target, ctx.source.owner, m)) }),
    handler('cn.cards@1', 'effects.search', v.validateCardsParameters, (_ctx, p) => [{ op: 'cards', ...p }],
      { canUse: (ctx, p) => {
        const player = ctx.state.players[ctx.source.owner];
        if (p.to === 'bench' && player.bench.length >= 5) return false;
        const pool = (p.from === 'deck' && p.lookTop !== null ? player.deck.slice(-p.lookTop) : player[p.from])
          .filter((id) => p.from !== 'hand' || ctx.source.category !== 'trainer' || id !== ctx.source.instanceId);
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
        return !!player.active && player.bench.length > 0;
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
      { canUse: (ctx, p) => (p.benchOnly ? ctx.state.players[ctx.source.owner].bench : subjects(ctx, ctx.source.owner)).length > 0 &&
        ctx.state.players[ctx.source.owner].discard.some((id) => {
          const d = def(ctx, id);
          return d.kind === 'energy' && d.mechanics.category === 'basic' && d.mechanics.baseUnits[0][0] === p.type;
        }) }),
    handler('cn.attachHand@1', 'effects.attach', v.validateAttachDiscardParameters, (_ctx, p) => [{ op: 'attachHand', ...p }],
      { canUse: (ctx, p) => (p.benchOnly ? ctx.state.players[ctx.source.owner].bench : subjects(ctx, ctx.source.owner)).length > 0 &&
        ctx.state.players[ctx.source.owner].hand.some((id) => {
          const d = def(ctx, id);
          return d.kind === 'energy' && d.mechanics.category === 'basic' && d.mechanics.baseUnits[0][0] === p.type;
        }) }),
  ];
  // Candidate-count checks for hand-only costs. The host separately proves a
  // possible actual change with the real source/protection, never merely that
  // an Active/Bench or damaged target exists. Cross-source cost dependencies
  // cannot be inferred from this local candidate predicate alone.
  const independent = new Set(['cn.draw@1', 'cn.counters@1', 'cn.heal@1', 'cn.lasting@1', 'cn.transferCounters@1', 'cn.switch@1',
    'cn.deployIncoming@1', 'cn.attachIncoming@1', 'cn.inspectDeck@1', 'cn.attachDeckEnergy@1', 'cn.prizeExchange@1', 'cn.healPokemon@1',
    'cn.distributeCounters@1', 'cn.discardStadium@1']);
  return new Map(h.map((entry) => {
    let canUseWithCosts;
    if (independent.has(entry.id)) canUseWithCosts = (ctx, p) => entry.canUse(ctx, p);
    if (['cn.shuffleHandToBottom@1', 'cn.handBottomDraw@1'].includes(entry.id))
      canUseWithCosts = (ctx, p, costs) => handBottomAvailable(ctx, p, costs);
    if (entry.id === 'cn.drawUntil@1') canUseWithCosts = (ctx, p, costs) =>
      ctx.state.players[ctx.source.owner].deck.length > 0 && handAfterCosts(ctx, costs) < p.count;
    if (entry.id === 'cn.discardHand@1') canUseWithCosts = (ctx, _p, costs) => handAfterCosts(ctx, costs) > 0;
    if (entry.id === 'cn.shuffle@1') canUseWithCosts = (ctx, p, costs) => p.zone === 'hand' &&
      (p.side === 'own' ? ctx.source.owner : 1 - ctx.source.owner) === ctx.activation.player ?
      handAfterCosts({ ...ctx, source: { ...ctx.source, owner: ctx.activation.player } }, costs) > 0 : entry.canUse(ctx, p);
    if (entry.id === 'cn.cards@1') canUseWithCosts = (ctx, p, costs) => {
      if (p.to === 'bench' && ctx.state.players[ctx.source.owner].bench.length >= 5) return false;
      if (ctx.activation.player !== ctx.source.owner || p.from === 'deck') return entry.canUse(ctx, p);
      const pool = costCards(ctx);
      if (p.from === 'hand') return pool.some((card) => matchesCardSelector(card.definition, p.selector) &&
        findCostPayment(costs, pool, { reserveIds: [card.instanceId] }) !== null);
      return entry.canUse(ctx, p) || pool.some((card) => discardDestination(card.definition) === 'discard' &&
        matchesCardSelector(card.definition, p.selector) &&
        findCostPayment(costs, pool, { requiredIds: [card.instanceId] }) !== null);
    };
    if (['cn.attachHand@1', 'cn.attachDiscard@1'].includes(entry.id)) canUseWithCosts = (ctx, p, costs) => {
      const owner = ctx.source.owner, player = ctx.state.players[owner];
      if (!(p.benchOnly ? player.bench : subjects(ctx, owner)).length) return false;
      if (ctx.activation.player !== owner) return entry.canUse(ctx, p);
      const pool = costCards(ctx), selector = { kind: 'energy', category: 'basic', types: [p.type] };
      return (entry.id === 'cn.attachDiscard@1' && entry.canUse(ctx, p)) || pool.some((card) =>
        matchesCardSelector(card.definition, selector) && findCostPayment(costs, pool,
          entry.id === 'cn.attachHand@1' ? { reserveIds: [card.instanceId] } : { requiredIds: [card.instanceId] }) !== null);
    };
    return [entry.id, canUseWithCosts ? Object.freeze({ ...entry, costCheckVersion: '1', canUseWithCosts }) : entry];
  }));
}
