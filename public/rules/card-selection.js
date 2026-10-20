import { validateCardSelector } from './schema-validators.js';

export const CARD_SELECTION_RULE_IDS = Object.freeze(['selection.hidden', 'selection.hand', 'effects.search', 'effects.shuffle', 'effects.return', 'effects.deploy']);

function matches(definition, selector) {
  if (selector.kind === 'any') return true;
  if (selector.anyOf) return selector.anyOf.some((s) => matches(definition, s));
  if (definition.kind !== selector.kind) return false;
  const m = definition.mechanics;
  if (selector.nameKeys && !selector.nameKeys.includes(definition.nameKey)) return false;
  if (selector.kind === 'pokemon') {
    return (!selector.stages || selector.stages.includes(m.stage)) &&
      (!selector.types || selector.types.some((t) => m.types.includes(t))) &&
      (!Object.hasOwn(selector, 'printedHpAtMost') || m.hp <= selector.printedHpAtMost) &&
      (!Object.hasOwn(selector, 'ruleBox') || m.ruleBox === selector.ruleBox) &&
      (!selector.tagsAll || selector.tagsAll.every((t) => m.tags.includes(t))) &&
      (!selector.attackIds || m.attacks.some((a) => selector.attackIds.includes(a.attackId))) &&
      (!selector.abilityIds || m.abilities.some((a) => selector.abilityIds.includes(a.abilityId)));
  }
  if (selector.kind === 'trainer')
    return (!selector.categories || selector.categories.includes(m.category)) &&
      (!selector.nameContains || definition.name.includes(selector.nameContains));
  return (!selector.category || selector.category === m.category) &&
    (!selector.types || selector.types.some((t) => m.baseUnits.some((u) => u.includes(t))));
}

export function matchesCardSelector(definition, selector) {
  if (!validateCardSelector(selector)) throw new TypeError('Invalid reviewed card selector.');
  return matches(definition, selector);
}

export function selectorQuantityClass(selector) {
  if (!validateCardSelector(selector)) throw new TypeError('Invalid reviewed card selector.');
  // Named categories remain specific even when this particular deck happens
  // to contain only that category. Do not infer a public "any card" instruction.
  return selector.kind === 'any' ? 'anyCard' : 'specific';
}
