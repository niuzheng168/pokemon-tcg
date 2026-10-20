import { matchesCardSelector } from './card-selection.js';
import { POKEMON_TYPES } from './damage.js';

function checkedTypes(effectiveTypes) {
  if (!Array.isArray(effectiveTypes) || Object.getPrototypeOf(effectiveTypes) !== Array.prototype ||
      !effectiveTypes.length || Reflect.ownKeys(effectiveTypes).length !== effectiveTypes.length + 1)
    throw new TypeError('Explicit nonempty, unique effective Pokémon types are required.');
  const types = [];
  for (let index = 0; index < effectiveTypes.length; index++) {
    const entry = Object.getOwnPropertyDescriptor(effectiveTypes, String(index));
    if (!entry || !entry.enumerable || !Object.hasOwn(entry, 'value') ||
        !POKEMON_TYPES.includes(entry.value) || types.includes(entry.value))
      throw new TypeError('Effective Pokémon types must be plain normalized values, not holes, accessors or duplicates.');
    types.push(entry.value);
  }
  return Object.freeze(types);
}

/**
 * Adapt the EXISTING CardSelector for an in-play subject. The host supplies
 * actual derived/event-snapshot types; this does not compute a type effect.
 *
 * effectiveTypes is mandatory and checked even when a selector does not use a
 * Pokémon-type predicate. There is never an implicit printed-types fallback.
 * Only a Pokémon definition's matching view has mechanics.types replaced.
 * Names, stage, printed HP, Rule Box/tags and printed attack/Ability identities
 * retain their existing meanings, including inside anyOf branches.
 *
 * Non-Pokémon definitions still use their unchanged printed mechanics. In
 * particular Basic Energy identity/provision is never a Pokémon's current type.
 * Do NOT replace matchesCardSelector for deck/hand/discard/printing queries.
 *
 * Only detached view objects and a detached types array are frozen. Neither
 * the original catalog definition, selector nor caller-owned type array is
 * changed/frozen; no wrapper or mutable alias escapes to a caller.
 */
export function matchesInPlaySelector(definition, selector, effectiveTypes) {
  const types = checkedTypes(effectiveTypes);
  if (!definition || typeof definition !== 'object' || Array.isArray(definition) ||
      !['pokemon', 'trainer', 'energy'].includes(definition.kind) ||
      !definition.mechanics || typeof definition.mechanics !== 'object' || Array.isArray(definition.mechanics))
    throw new TypeError('An in-play selector needs the original normalized card definition.');
  if (definition.kind !== 'pokemon') return matchesCardSelector(definition, selector);
  const view = Object.freeze({
    ...definition,
    mechanics: Object.freeze({ ...definition.mechanics, types }),
  });
  return matchesCardSelector(view, selector);
}
