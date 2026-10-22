import { POKEMON_TYPES } from './damage.js';
import { CN_V20261019 } from './zh-CN/V20261019.js';
import { ruleTrace, CN_OFFICIAL_EVIDENCE_URL_PATTERN, CN_CARD_LIBRARY_EVIDENCE_URL_PATTERN } from './registry.js';

export const POKEMON_TYPES_RULE_IDS = Object.freeze(['pokemon.types']);
export const POKEMON_TYPES_SOURCES = Object.freeze([
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.D-07', pdfPages: Object.freeze([45]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.E-13', pdfPages: Object.freeze([59, 60]) }),
]);
const officialURL = new RegExp(CN_OFFICIAL_EVIDENCE_URL_PATTERN), libraryURL = new RegExp(CN_CARD_LIBRARY_EVIDENCE_URL_PATTERN);
const text = (value) => typeof value === 'string' && value.length > 0;
const sourceId = (value) => text(value) && value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(value);

/** Only own, enumerable plain data; inspecting imported values never calls getters. */
function record(value, required, optional, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new TypeError(`Invalid Pokémon types ${label}: expected a plain record.`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(value)) {
    const p = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !allowed.has(key) || !p.enumerable || !Object.hasOwn(p, 'value'))
      throw new TypeError(`Invalid Pokémon types ${label}: hidden, executable or unknown property.`);
  }
  if (required.some((key) => !Object.hasOwn(value, key)))
    throw new TypeError(`Invalid Pokémon types ${label}: missing required property.`);
}
function array(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1)
    throw new TypeError(`Invalid Pokémon types ${label}: expected a dense plain array.`);
  for (let i = 0; i < value.length; i++) {
    const p = Object.getOwnPropertyDescriptor(value, String(i));
    if (!p || !p.enumerable || !Object.hasOwn(p, 'value'))
      throw new TypeError(`Invalid Pokémon types ${label}: expected a dense data array.`);
  }
}
function types(value) {
  array(value, 'set');
  if (!value.length || new Set(value).size !== value.length || value.some((t) => !POKEMON_TYPES.includes(t)))
    throw new TypeError('Pokémon types must be a nonempty unique set of normalized PokémonType names.');
}
const canonicalTypes = (value) => POKEMON_TYPES.filter((t) => value.includes(t));

/**
 * CN Ver.3.1.0 II.D-07 p45 (Hoopa V) and II.E-13 p59–60.
 * This is a COMPLETE effective type-set replacement, never a change to printed
 * CardDefinition.mechanics.types, Energy provision, Weakness or Resistance.
 * No inferred type filter, default type, add/remove mode, grouping or priority.
 */
export function assertPokemonTypesEffect(effect) {
  record(effect, ['op', 'types', 'scope'], ['activeOnly', 'sourceActive'], 'effect');
  if (effect.op !== 'pokemonTypes' || !['self', 'own', 'opponent', 'all'].includes(effect.scope))
    throw new TypeError('Pokémon type effects require an explicit pokemonTypes operation and scope.');
  types(effect.types);
  for (const flag of ['activeOnly', 'sourceActive'])
    if (Object.hasOwn(effect, flag) && typeof effect[flag] !== 'boolean')
      throw new TypeError('Pokémon type position predicates must be explicit booleans.');
  return effect;
}

function evidence(value) {
  array(value, 'evidence');
  if (!value.length) throw new TypeError('Pokémon type replacements require source evidence.');
  for (const item of value) {
    // Official evidence, or a machine-implemented card's library record (the definition's tier was checked on admission).
    const library = item?.kind === 'card-library';
    record(item, ['sourceId', 'kind', 'url', 'locator'], library ? ['observedOn'] : ['textSha256', 'observedOn'], 'evidence');
    if (!sourceId(item.sourceId) || !library && !['official-card', 'official-erratum', 'official-rule'].includes(item.kind) ||
        typeof item.url !== 'string' || !(library ? libraryURL : officialURL).test(item.url) || !text(item.locator) ||
        Object.hasOwn(item, 'textSha256') && (typeof item.textSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.textSha256)) ||
        Object.hasOwn(item, 'observedOn') && (typeof item.observedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.observedOn)))
      throw new TypeError('Pokémon type evidence needs explicit normalized official or card-library source fields.');
  }
}

/**
 * Input replacements are ALREADY APPLICABLE {id,types,sourceOfTruth} entries.
 * Host owns in-play presence, source suppression, positions, targets, duration,
 * and dependencies between effective types and other live effects (II.E-13).
 * Evidence syntax is NOT independent card/catalog approval.
 *
 * No replacements: return a detached copy in printed order. Replacements:
 * compare complete SETS and output the fixed PokémonType enumeration order,
 * never attribute/timestamp priority. Equivalent sets retain every source;
 * different sets require a CN ruling, not first/last-source-wins or a union.
 */
export function resolvePokemonTypes(printedTypes, replacements = []) {
  types(printedTypes);
  array(replacements, 'replacements');
  const ids = new Set(), normalized = [];
  for (const replacement of replacements) {
    record(replacement, ['id', 'types', 'sourceOfTruth'], [], 'replacement');
    if (!text(replacement.id) || ids.has(replacement.id))
      throw new TypeError('Pokémon type replacements need unique nonempty descriptor IDs.');
    types(replacement.types);
    evidence(replacement.sourceOfTruth);
    ids.add(replacement.id);
    normalized.push({ id: replacement.id, types: canonicalTypes(replacement.types), sourceOfTruth: replacement.sourceOfTruth });
  }
  normalized.sort((a, b) => a.id < b.id ? -1 : 1);
  if (new Set(normalized.map((r) => r.types.join('|'))).size > 1) {
    const error = new TypeError('Different Pokémon type replacement sets need a sourced CN ruling, not ordering or a union.');
    error.code = 'needs-ruling'; error.needsRuling = true; error.ruleId = 'pokemon.types';
    error.trace = [ruleTrace(CN_V20261019, 'pokemon.types', { outcome: 'needs-ruling', printedTypes, replacements: normalized })];
    error.sourceOfTruth = error.trace[0].sourceOfTruth;
    throw error;
  }
  const result = normalized.length ? [...normalized[0].types] : [...printedTypes];
  return { types: result, trace: [ruleTrace(CN_V20261019, 'pokemon.types', {
    printedTypes, types: result, usedPrinted: normalized.length === 0, replacements: normalized,
  })] };
}
