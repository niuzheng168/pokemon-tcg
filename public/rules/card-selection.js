import { validateCardSelector } from './schema-validators.js';
import jsonEqual from './json-equal.js';

export const CARD_SELECTION_RULE_IDS = Object.freeze(['selection.hidden', 'selection.hand', 'effects.search', 'effects.shuffle', 'effects.return', 'effects.deploy']);

// pokemon.item-card: out of play a card printed as an Item is that Item (the Pokémon it can be played as exists only in play).
const itemFaces = new WeakMap();
export function printedCard(definition) {
  if (!definition.mechanics?.itemCard) return definition;
  if (!itemFaces.has(definition))
    itemFaces.set(definition, Object.freeze({ ...definition, kind: 'trainer', mechanics: Object.freeze({ category: 'item', tags: [] }) }));
  return itemFaces.get(definition);
}
// In play it is the Basic Pokémon it was played as.
const playedFaces = new WeakMap();
export function playedCard(definition) {
  if (!definition.mechanics?.itemCard) return definition;
  if (!playedFaces.has(definition)) {
    const mechanics = { ...definition.mechanics };
    delete mechanics.itemCard;
    playedFaces.set(definition, Object.freeze({ ...definition, mechanics: Object.freeze(mechanics) }));
  }
  return playedFaces.get(definition);
}

// The catalog's deck group of the printed 「在1副卡组中只能放入1张ACE SPEC卡」 rule.
export const ACE_SPEC_GROUP = 'cn-ace-spec';
// selection.context: the fields a host replaces with the values it reads when the effect resolves (resolveContextSelector).
export const CONTEXT_FIELDS = Object.freeze(['typesFrom', 'namesFrom']);

function matches(card, selector) {
  const definition = printedCard(card);
  if (selector.kind === 'any') return true;
  if (selector.anyOf) return selector.anyOf.some((s) => matches(definition, s));
  if (CONTEXT_FIELDS.some((k) => Object.hasOwn(selector, k))) throw new TypeError('A context selector is matched only after its host resolves it.');
  if (definition.kind !== selector.kind) return false;
  const m = definition.mechanics;
  if (selector.nameKeys && !selector.nameKeys.includes(definition.nameKey)) return false;
  // Printed 「除「X」外」 excludes that name identity, not its display text.
  if (selector.excludeNameKeys?.includes(definition.nameKey)) return false;
  // 「（除◇（棱镜之星）外）」: the printed Prism Star rule.
  if (Object.hasOwn(selector, 'prismStar') && !!definition.prismStar !== selector.prismStar) return false;
  // 「【ACE SPEC】」: the card's ACE SPEC deck group.
  if (Object.hasOwn(selector, 'aceSpec') && definition.deckLimits.groups.some((g) => g.key === ACE_SPEC_GROUP) !== selector.aceSpec) return false;
  if (selector.kind === 'pokemon') {
    return (!selector.stages || selector.stages.includes(m.stage)) &&
      (!selector.types || selector.types.some((t) => m.types.includes(t))) &&
      (!Object.hasOwn(selector, 'printedHpAtMost') || m.hp <= selector.printedHpAtMost) &&
      (!Object.hasOwn(selector, 'printedRetreatCost') || m.retreatCost === selector.printedRetreatCost) &&
      (!Object.hasOwn(selector, 'ruleBox') || m.ruleBox === selector.ruleBox) &&
      (!selector.tagsAll || selector.tagsAll.every((t) => m.tags.includes(t))) &&
      (!selector.attackIds || m.attacks.some((a) => selector.attackIds.includes(a.attackId))) &&
      (!selector.attackNames || m.attacks.some((a) => selector.attackNames.includes(a.name))) &&
      (!selector.evolvesFromNameKeys || selector.evolvesFromNameKeys.includes(m.evolvesFrom)) &&
      (!selector.abilityIds || m.abilities.some((a) => selector.abilityIds.includes(a.abilityId))) &&
      (!Object.hasOwn(selector, 'printedAbility') || (m.abilities.length > 0) === selector.printedAbility) &&
      (!selector.nameContains || definition.name.includes(selector.nameContains)) &&
      (!selector.excludeTags || !selector.excludeTags.some((t) => m.tags.includes(t))) &&
      (!selector.excludeTypes || !selector.excludeTypes.some((t) => m.types.includes(t))) &&
      (!selector.excludeNameContains || !definition.name.includes(selector.excludeNameContains)) &&
      // JP Q&A マメパト「とりぶえ」: a Pokémon V-UNION card out of play shows only its name and type, never a Resistance.
      (!selector.resistanceTypes || m.stage !== 'V-UNION' && selector.resistanceTypes.includes(m.resistance?.type));
  }
  if (selector.kind === 'trainer')
    return (!selector.categories || selector.categories.includes(m.category)) &&
      (!selector.nameContains || definition.name.includes(selector.nameContains)) &&
      (!selector.tagsAll || selector.tagsAll.every((t) => (m.tags ?? []).includes(t)));
  return (!selector.category || selector.category === m.category) &&
    (!selector.types || selector.types.some((t) => m.baseUnits.some((u) => u.includes(t)))) &&
    (!selector.tagsAll || selector.tagsAll.every((t) => (m.tags ?? []).includes(t)));
}

export function matchesCardSelector(definition, selector) {
  if (!validateCardSelector(selector)) throw new TypeError('Invalid reviewed card selector.');
  return matches(definition, selector);
}

// II.C-11 「放于备战区」 means putting Basic Pokémon from the deck or discard pile onto the Bench (文例2 names only a type):
// an alternative naming neither the card nor its stage admits only Basic Pokémon; a named or staged one is as printed.
export function matchesDeploySelector(definition, selector) {
  if (!validateCardSelector(selector)) throw new TypeError('Invalid reviewed card selector.');
  return printedCard(definition).kind === 'pokemon' && (selector.anyOf ?? [selector]).some((alternative) => matches(definition, alternative) &&
    (alternative.nameKeys || alternative.stages || definition.mechanics.stage === 'basic'));
}
// The cards a cn.cards@1 move may take: II.C-11 for the Bench, else the printed selector.
export const matchesCardsMove = (definition, p) =>
  (p.to === 'bench' ? matchesDeploySelector : matchesCardSelector)(definition, p.selector);

// II.D-04 文例4 「各1张」: the chosen cards match the selector's alternatives one to one.
export function matchesOnePerAlternative(definitions, selector) {
  if (!validateCardSelector(selector) || !selector.anyOf) throw new TypeError('One card per alternative needs reviewed alternatives.');
  const assign = (i, used) => i === definitions.length || selector.anyOf.some((alternative, j) =>
    !used.includes(j) && matches(definitions[i], alternative) && assign(i + 1, [...used, j]));
  return assign(0, []);
}

// 「最多2张宝可梦，和最多2张基本能量」: at most limits[j] cards counted against alternative j. Exclusive
// (「最多2张【基础】宝可梦或1张进化宝可梦」): every card from one alternative, within that alternative's limit.
export function matchesAlternativeLimits(definitions, selector, limits, exclusive = false) {
  if (!validateCardSelector(selector) || selector.anyOf?.length !== limits.length) throw new TypeError('Alternative limits need one limit per reviewed alternative.');
  if (exclusive) return selector.anyOf.some((alternative, j) => definitions.length <= limits[j] && definitions.every((d) => matches(d, alternative)));
  const assign = (i, used) => i === definitions.length || selector.anyOf.some((alternative, j) =>
    used[j] < limits[j] && matches(definitions[i], alternative) && assign(i + 1, used.map((n, k) => k === j ? n + 1 : n)));
  return assign(0, limits.map(() => 0));
}
// The total a cards move with alternative limits may take: their sum, or the largest when exclusive.
export const alternativeTotal = (limits, exclusive = false) => exclusive ? Math.max(...limits) : limits.reduce((a, b) => a + b, 0);

// The printed types a card shows: a Pokémon's types, a Basic Energy's type; other cards none.
const printedTypes = (d) => d.kind === 'pokemon' ? d.mechanics.types : d.kind === 'energy' && d.mechanics.category === 'basic' ? [d.mechanics.baseUnits[0][0]] : [];
// 「属性各不相同的…」: no two cards share a printed type (a Pokémon's types, a Basic Energy's type); 「名字各不同的…」: no two share a name.
export function distinctCards(definitions, by) {
  const keys = definitions.map(printedCard).flatMap((d) => by === 'names' ? [d.nameKey] : printedTypes(d));
  return new Set(keys).size === keys.length;
}
// 「…的属性种类数量」: how many different printed types the cards show together.
export const typeCount = (definitions) => new Set(definitions.map(printedCard).flatMap(printedTypes)).size;

// One card kind: that kind's selector, or distinct printed alternatives all of that kind (「宝可梦GX・EX」).
export function isKindSelector(selector, kind) {
  return !!selector && typeof selector === 'object' && !Array.isArray(selector) && validateCardSelector(selector) &&
    (selector.kind === kind || Array.isArray(selector.anyOf) && selector.anyOf.every((s, i) => s.kind === kind &&
      selector.anyOf.slice(0, i).every((t) => !jsonEqual(s, t))));
}
export function selectorQuantityClass(selector) {
  if (!validateCardSelector(selector)) throw new TypeError('Invalid reviewed card selector.');
  // Named categories remain specific even when this particular deck happens
  // to contain only that category. Do not infer a public "any card" instruction.
  return selector.kind === 'any' ? 'anyCard' : 'specific';
}
