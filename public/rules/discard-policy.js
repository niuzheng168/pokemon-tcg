import { CN_OFFICIAL_EVIDENCE_URL_PATTERN } from './registry.js';

const officialURL = new RegExp(CN_OFFICIAL_EVIDENCE_URL_PATTERN);
// A machine-implemented card's own card-library record (card-definition#/$defs/libraryEvidence); the catalog admits it
// only on a machine-tier definition.
const libraryURL = /^https:\/\/(tcg\.mik\.moe|wiki\.52poke\.com)\//;
const evidenceFields = ['sourceId', 'kind', 'url', 'locator'];
const evidenceOptional = ['textSha256', 'observedOn'];
const invalid = () => new TypeError('Discard policy requires explicit, normalized Prism Star data.');

function plainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid();
}

function data(descriptor) {
  if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid();
  return descriptor.value;
}

function own(value, key) {
  return data(Object.getOwnPropertyDescriptor(value, key));
}

// Only this small rule/evidence shape is enumerated, never the whole definition.
function record(value, required, optional = []) {
  plainRecord(value);
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !required.includes(key) && !optional.includes(key)) throw invalid();
    result[key] = own(value, key);
  }
  if (required.some((key) => !Object.hasOwn(result, key))) throw invalid();
  return result;
}

function plainRecordKind(value) {
  plainRecord(value);
  const kind = Object.getOwnPropertyDescriptor(value, 'kind');
  return kind && kind.enumerable && Object.hasOwn(kind, 'value') ? kind.value : null;
}

function list(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw invalid();
  const length = Object.getOwnPropertyDescriptor(value, 'length').value;
  if (Reflect.ownKeys(value).length !== length + 1) throw invalid();
  const result = [];
  for (let index = 0; index < length; index++) result.push(own(value, String(index)));
  return result;
}

const text = (value) => typeof value === 'string' && value.length > 0;

/**
 * Strict own-data assertion of card-definition#/$defs/prismStarRule/cardEvidenceList.
 * Returns the ORIGINAL rule; does not freeze, approve, or resolve its evidence.
 * Unknown fields and reflection failures reject, never execute getters/toJSON.
 * Shape depth is fixed: no traversal of arbitrary card/runtime objects or cycles.
 */
export function assertPrismStarRule(rule) {
  const fields = record(rule, ['sourceOfTruth']);
  const sources = list(fields.sourceOfTruth);
  if (!sources.length) throw invalid();
  for (const source of sources) {
    const library = plainRecordKind(source) === 'card-library';
    const item = record(source, evidenceFields, library ? ['observedOn'] : evidenceOptional);
    if (!text(item.sourceId) || item.sourceId.length > 200 ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(item.sourceId) ||
        !library && !['official-card', 'official-erratum', 'official-rule'].includes(item.kind) ||
        typeof item.url !== 'string' || !(library ? libraryURL : officialURL).test(item.url) || !text(item.locator))
      throw invalid();
    if (Object.hasOwn(item, 'textSha256') &&
        (typeof item.textSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.textSha256))) throw invalid();
    if (Object.hasOwn(item, 'observedOn') &&
        (typeof item.observedOn !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(item.observedOn))) throw invalid();
  }
  return rule;
}

/**
 * CN-formats-extra, pinned Prism Star section (HTML lines 118–119).
 * Applied ONLY when a physical card would otherwise enter discard, including
 * KO/use-end disposal. The host owns movement, original ownership and approval
 * of the catalog definition; this return value grants none of those authorities.
 *
 * Read an already-normalized STATIC definition, not an in-play Pokémon. Absence
 * of the explicit flag returns immediately; names/symbols, HP, zones, effects,
 * source suppression and mutable battle state are never inspected. With a flag,
 * read only the necessary printed kind/limit/stage/rule-box/Energy category.
 */
export function discardDestination(definition) {
  plainRecord(definition);
  const flag = Object.getOwnPropertyDescriptor(definition, 'prismStar');
  if (!flag) return 'discard';
  assertPrismStarRule(data(flag));
  const kind = own(definition, 'kind');
  if (!['pokemon', 'trainer', 'energy'].includes(kind)) throw invalid();
  const limits = own(definition, 'deckLimits');
  plainRecord(limits);
  if (own(limits, 'sameName') !== 1) throw invalid();
  if (kind !== 'trainer') {
    const mechanics = own(definition, 'mechanics');
    plainRecord(mechanics);
    if (kind === 'pokemon') {
      if (own(mechanics, 'stage') !== 'basic' || own(mechanics, 'ruleBox') !== true) throw invalid();
    } else if (own(mechanics, 'category') !== 'special') throw invalid();
  }
  return 'lost';
}
