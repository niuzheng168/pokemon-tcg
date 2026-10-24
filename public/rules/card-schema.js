import { validateCardDefinition, validateCardPrinting } from './schema-validators.js';
import { getRuleset } from './index.js';
import { deepFreeze } from './registry.js';
import { assertActivationCosts } from './activation-cost.js';
import { assertFailureCoin, FAILURE_DISCARDS } from './attack-failure.js';
import { assertAttackCommitment } from './attack-commitments.js';
import { assertBattlePredicate } from './battle-predicate.js';
import jsonEqual from './json-equal.js';

export class CardSchemaError extends TypeError {
  constructor(message, errors = []) {
    super(message);
    this.name = 'CardSchemaError';
    this.errors = structuredClone(errors);
  }
}

// These are SHAPE checks, not assertions that a card has official/implemented semantics.
export function assertDefinitionShape(definition) {
  // Equality with itself also checks strict JSON descriptors. Optional
  // undefined/hidden/executable fields must not disappear from an approval pin
  // while remaining present in the definition that is frozen and executed.
  if (!jsonEqual(definition, definition) || !validateCardDefinition(definition))
    throw new CardSchemaError('Invalid normalized card definition.', validateCardDefinition.errors);
  return definition;
}

export function assertPrintingShape(printing) {
  if (!jsonEqual(printing, printing) || !validateCardPrinting(printing))
    throw new CardSchemaError('Invalid card printing.', validateCardPrinting.errors);
  return printing;
}

// Comparison only, not an official content fingerprint. Release approval records
// must be created from reviewed code/data, never populated from a downloaded claim.
function canonicalValue(value) {
  const sort = (value) => Array.isArray(value) ? value.map(sort) :
    value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, sort(value[k])])) : value;
  return JSON.stringify(sort(value));
}
export function canonicalDefinition(definition) {
  assertDefinitionShape(definition);
  return canonicalValue(definition);
}
export function canonicalPrinting(printing) {
  assertPrintingShape(printing);
  return canonicalValue(printing);
}
export function assertPrintingApproval(printing, approvedPrintings = new Map()) {
  if (approvedPrintings.get(printing.printingId) !== canonicalPrinting(printing))
    throw new CardSchemaError('Printing has no independent approval, or identity/binding changed since review.');
  return printing;
}

// Card-specific evidence: the official card face or erratum; a machine-implemented definition (implementation tier
// 'machine') rests on its card-library record instead, and is labelled as such wherever it is shown.
const OFFICIAL_CARD = Object.freeze(['official-card', 'official-erratum']);
const MACHINE_CARD = Object.freeze([...OFFICIAL_CARD, 'card-library']);
export const isMachineDefinition = (definition) => definition.implementation.tier === 'machine';
const cardEvidence = (definition) => (isMachineDefinition(definition) ? MACHINE_CARD : OFFICIAL_CARD);
const hasCardEvidence = (definition, list) => list.some((s) => cardEvidence(definition).includes(s.kind));

function bindings(definition) {
  const m = definition.mechanics;
  for (const list of [m.attacks || [], m.grantedAttacks || [], m.abilities || [], m.grantedAbilities || []]) {
    const ids = list.map((item) => item.attackId ?? item.abilityId);
    if (new Set(ids).size !== ids.length) throw new CardSchemaError('Duplicate attack/Ability identity.');
  }
  return [
    ...(m.effects || []),
    ...(m.attacks || []).flatMap((a) => a.effects),
    ...(m.grantedAttacks || []).flatMap((a) => a.effects),
    ...(m.abilities || []).flatMap((a) => a.effects),
    ...(m.grantedAbilities || []).flatMap((a) => a.effects),
  ];
}

/**
 * Fail-closed bridge from schema to execution. A `verified` property in imported
 * data is NOT approval. The application supplies an independent reviewed catalog,
 * pinned definitions, tests and a trusted handler registry for this ruleset.
 */
export function assertExecutableDefinition(definition, {
  ruleset,
  approvedDefinitions = new Map(),
  handlers = new Map(),
} = {}) {
  assertDefinitionShape(definition);
  const selected = getRuleset(ruleset);
  if (`${definition.ruleset.region}/${definition.ruleset.version}` !== selected.id)
    throw new CardSchemaError('Card definition belongs to a different region/version.');
  if (definition.implementation.status !== 'verified')
    throw new CardSchemaError('Unimplemented/partial cards cannot enter official-mode execution.');
  if (approvedDefinitions.get(definition.definitionId) !== canonicalDefinition(definition))
    throw new CardSchemaError('Definition has no independent approval, or changed since review.');
  if (!hasCardEvidence(definition, definition.sourceOfTruth))
    throw new CardSchemaError('General game rules do not prove a particular card definition.');
  if (definition.prismStar && !hasCardEvidence(definition, definition.prismStar.sourceOfTruth))
    throw new CardSchemaError('A particular Prism Star classification needs card-specific evidence, not just the general rule.');
  const effectIds = new Set();
  for (const binding of bindings(definition)) {
    if (effectIds.has(binding.effectId)) throw new CardSchemaError(`Duplicate effect ID: ${binding.effectId}`);
    effectIds.add(binding.effectId);
    const handler = handlers.get(binding.handlerId);
    if (!handler || handler.rulesetId !== selected.id || !handler.sourceOfTruth?.length ||
        typeof handler.execute !== 'function' || typeof handler.validateParameters !== 'function')
      throw new CardSchemaError(`Unknown, unsourced or wrong-version handler: ${binding.handlerId}`);
    if (!handler.validateParameters(binding.parameters))
      throw new CardSchemaError(`Invalid parameters for handler: ${binding.handlerId}`);
    // A schedule or copy treatment cites this card's own evidence: a card-library record only on a machine definition.
    if (!isMachineDefinition(definition) && JSON.stringify(binding.parameters).includes('"kind":"card-library"'))
      throw new CardSchemaError(`Only a machine definition cites its card-library record: ${binding.effectId}`);
    if (binding.handlerId === 'cn.lasting@1' && binding.parameters.effect?.op === 'attackCheck')
      assertFailureCoin(binding.parameters.effect.coin);
  }
  const m = definition.mechanics;
  const checkCosts = (costs) => {
    if (!costs) return;
    assertActivationCosts(costs);
    if (costs.some((c) => !hasCardEvidence(definition, c.sourceOfTruth)))
      throw new CardSchemaError('Exact card costs need card-specific evidence, not general activation rules alone.');
  };
  checkCosts(m.playCosts); checkCosts(m.attachCosts);
  for (const b of bindings(definition)) checkCosts(b.activationCosts);
  if (definition.kind === 'pokemon') {
    if (m.basicAncestor && !hasCardEvidence(definition, m.basicAncestor.sourceOfTruth))
      throw new CardSchemaError('Stage 2 ancestry needs reviewed card-specific evidence.');
    for (const ability of m.abilities) {
      checkCosts(ability.costs);
      if (ability.mode === 'continuous' && ability.costs)
        throw new CardSchemaError('Continuous Abilities cannot have declaration costs.');
      if ((ability.mode === 'triggered') !== Object.hasOwn(ability, 'trigger'))
        throw new CardSchemaError('A triggered Ability needs an explicit trigger descriptor; other Ability modes cannot have one.');
      if (ability.effects.some((b) => Object.hasOwn(b, 'trigger')))
        throw new CardSchemaError('Ability effects use their Ability trigger, not nested binding triggers.');
      if (ability.effects.some((b) => b.activationCosts))
        throw new CardSchemaError('Ability costs belong to the whole Ability, not its individual effect bindings.');
      if (ability.mode === 'activated' && !ability.usage)
        throw new CardSchemaError('An activated Ability needs explicit usage semantics.');
      if (ability.mode === 'continuous' && ability.usage !== null)
        throw new CardSchemaError('Continuous Abilities do not consume activation limits.');
      if (ability.trigger?.event === 'beforeHand' && (ability.usage !== null || ability.specialRule))
        throw new CardSchemaError('Before-hand windows have per-acquisition eligibility, not in-play usage/VSTAR state.');
      if (ability.usage && (ability.usage.period === 'unlimited' ? ability.usage.limit !== null : ability.usage.limit === null))
        throw new CardSchemaError('Limited/unlimited Ability usage must have a matching explicit limit.');
    }
    if (m.stage === 'basic' && m.evolvesFrom !== null)
      throw new CardSchemaError('A Basic Pokémon cannot have an ordinary evolution prerequisite.');
    if (['stage1', 'stage2', 'VSTAR', 'VMAX'].includes(m.stage) && !m.evolvesFrom)
      throw new CardSchemaError('An Evolution needs a reviewed evolution-name identity.');
    // pokemon.v-union: the kernel's own assembly from the discard pile (the schema requires its vUnion piece).
    if (m.stage === 'special' && !m.effects.some((e) =>
      handlers.get(e.handlerId).capabilities?.includes('special-evolution')))
      throw new CardSchemaError('Special deployment/evolution needs an explicit implementation.');
    if (m.prizeCount > 1 && !m.ruleBox)
      throw new CardSchemaError('Multi-Prize Pokémon need their printed Rule Box.');
  }
  // tools.granted-ability: the Ability printed on a Tool is an activated one (schema) with the same explicit usage.
  for (const ability of m.grantedAbilities || [])
    if (ability.usage.period === 'unlimited' ? ability.usage.limit !== null : ability.usage.limit === null)
      throw new CardSchemaError('Limited/unlimited Ability usage must have a matching explicit limit.');
  if (definition.kind === 'energy' && m.category === 'basic' && definition.deckLimits.sameName !== null)
    throw new CardSchemaError('Basic Energy is not subject to the ordinary four-per-name limit.');
  for (const attack of [...(m.attacks || []), ...(m.grantedAttacks || [])]) {
    if (attack.failureCheck) {
      if (attack.failureCheck.coin) assertFailureCoin(attack.failureCheck.coin);
      else if (attack.failureCheck.handPayment) assertAttackCommitment(attack.failureCheck.handPayment);
      // attack.failure.discard: the required discard is one of this attack's own Stadium/Tool discard entries.
      else if (attack.failureCheck.requires) {
        if (!attack.effects.some((e) => e.effectId === attack.failureCheck.requires && FAILURE_DISCARDS.includes(e.handlerId)))
          throw new CardSchemaError('A failure check requires one of its own attack\'s Stadium or Tool discard entries.');
      } else assertBattlePredicate(attack.failureCheck.predicate);
      if (!hasCardEvidence(definition, attack.failureCheck.sourceOfTruth))
        throw new CardSchemaError('A printed self-failure condition needs card-specific evidence.');
    }
    if (attack.printedDamage && attack.printedDamage.operator !== 'fixed' && !attack.effects.some((e) =>
      handlers.get(e.handlerId).capabilities?.includes('resolve-attack-damage')))
      throw new CardSchemaError('Non-fixed printed damage needs an implemented formula.');
  }
  // Freeze an isolated copy, not the caller's metadata objects.
  return deepFreeze(structuredClone(definition));
}

export function assertPrintingBinding(printing, definition, ruleset) {
  assertPrintingShape(printing);
  const selected = getRuleset(ruleset);
  // A printing's identity is checked by hand against the card face (verified, official evidence) or by machine image
  // reading against the card library (machine, its library record): the binding cites what checked it.
  if (printing.game !== 'tcg' || printing.language !== 'zh-Hans' || !['verified', 'machine'].includes(printing.identityReview))
    throw new CardSchemaError('CN official play needs a checked physical-TCG simplified-Chinese printing.');
  const matches = printing.definitionBindings.filter((b) =>
    `${b.ruleset.region}/${b.ruleset.version}` === selected.id);
  if (matches.length !== 1 || matches[0].definitionId !== definition.definitionId ||
      `${definition.ruleset.region}/${definition.ruleset.version}` !== selected.id)
    throw new CardSchemaError('Missing, ambiguous or conflicting printing-to-rules-version binding.');
  const kinds = printing.identityReview === 'machine' ? MACHINE_CARD : OFFICIAL_CARD;
  if (!matches[0].sourceOfTruth.some((s) => kinds.includes(s.kind)))
    throw new CardSchemaError('An exact printing-to-definition binding needs card-specific evidence.');
  return matches[0];
}
