import { POKEMON_TYPES } from './damage.js';
import { CN_V20261019 } from './zh-CN/V20261019.js';
import { ruleTrace, CN_OFFICIAL_EVIDENCE_URL_PATTERN } from './registry.js';

const officialURL = new RegExp(CN_OFFICIAL_EVIDENCE_URL_PATTERN);

export const CHECKUP_EFFECTS_RULE_IDS = Object.freeze(['status.burn']);
export const DEFAULT_BURN_COUNTERS = 2;
// A counter is ten damage; both its count and its conversion must remain exact.
export const MAX_BURN_COUNTERS = 900719925474099;

const id = (value) => typeof value === 'string' && value.length <= 200 &&
  /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(value);
const text = (value) => typeof value === 'string' && value.length > 0;
const counterCount = (value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_BURN_COUNTERS;

/** Only plain, own, enumerable data properties: never invoke imported getters. */
function record(value, required, optional, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new TypeError(`Invalid ${label}: expected a plain record.`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !allowed.has(key) || !property.enumerable || !Object.hasOwn(property, 'value'))
      throw new TypeError(`Invalid ${label}: unknown, hidden or executable property.`);
  }
  if (required.some((key) => !Object.hasOwn(value, key)))
    throw new TypeError(`Invalid ${label}: missing required property.`);
  return value;
}

/** Sparse arrays and extra properties are not part of this JSON value protocol. */
function array(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1)
    throw new TypeError(`Invalid ${label}: expected a dense data array.`);
  for (let i = 0; i < value.length; i++) {
    const property = Object.getOwnPropertyDescriptor(value, String(i));
    if (!property || !property.enumerable || !Object.hasOwn(property, 'value'))
      throw new TypeError(`Invalid ${label}: expected a dense data array.`);
  }
  return value;
}

/**
 * Standalone strict validation, matching checkup-effects.schema.json.
 * CN advanced Ver.3.1.0, II.E-28 + FAQ1/2, one-based PDF page 68.
 * This replaces the Burn counter count; it does NOT apply, prevent or cure Burn.
 * Availability, ownership/position/type predicates and duration belong to the
 * caller's normal continuous-effect pipeline, not to this value descriptor.
 */
export function assertBurnCountersEffect(effect) {
  record(effect, ['op', 'scope', 'count'], ['sourceActive', 'activeOnly', 'type'], 'Burn counter effect');
  if (effect.op !== 'burnCounters' || !['self', 'own', 'opponent', 'all'].includes(effect.scope) ||
      !counterCount(effect.count))
    throw new TypeError('Invalid Burn counter effect: explicit scope and bounded counter count are required.');
  for (const flag of ['sourceActive', 'activeOnly']) {
    if (Object.hasOwn(effect, flag) && typeof effect[flag] !== 'boolean')
      throw new TypeError('Invalid Burn counter effect: position flags must be booleans.');
  }
  if (Object.hasOwn(effect, 'type') && !POKEMON_TYPES.includes(effect.type))
    throw new TypeError('Invalid Burn counter effect: unknown Pokémon type.');
  return effect;
}

export function validateBurnCountersEffect(effect) {
  try { assertBurnCountersEffect(effect); return true; } catch { return false; }
}

function evidence(value) {
  array(value, 'Burn counter evidence');
  if (!value.length) throw new TypeError('Burn counter changes require source evidence.');
  for (const item of value) {
    record(item, ['sourceId', 'kind', 'url', 'locator'], ['textSha256', 'observedOn'], 'Burn counter evidence');
    if (!id(item.sourceId) || !['official-card', 'official-erratum', 'official-rule'].includes(item.kind) ||
        typeof item.url !== 'string' || !officialURL.test(item.url) ||
        !text(item.locator) ||
        Object.hasOwn(item, 'textSha256') && (typeof item.textSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.textSha256)) ||
        Object.hasOwn(item, 'observedOn') && (typeof item.observedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.observedOn)))
      throw new TypeError('Invalid Burn counter evidence: explicit official source fields are required.');
  }
}

/**
 * Input: ALREADY APPLICABLE { id, count, sourceOfTruth } changes, not raw source
 * nodes. The engine must first use its live source-availability and entryTargets
 * checks, including Active-only/type/scope predicates. Shape/source claims are
 * not independent card approval.
 *
 * II.E-28 FAQ1/2: take the largest replacement ONCE, never add or multiply by
 * card/source count. Default 2 only when there are NO replacements: [0] => 0,
 * [1] => 1. Returning zero does not prevent or cure Burn, or skip its recovery
 * coin. This function does not inspect conditions, use RNG, place counters or
 * perform Knock Outs.
 *
 * All tied largest sources remain in the trace; none receives arbitrary timing
 * priority. Canonical source-ID ordering makes the entire result independent
 * of input enumeration. ruleTrace freezes and detaches the evidence snapshot.
 */
export function resolveBurnCounters(changes = []) {
  array(changes, 'Burn counter changes');
  const ids = new Set();
  let count = changes.length ? 0 : DEFAULT_BURN_COUNTERS;
  for (const change of changes) {
    record(change, ['id', 'count', 'sourceOfTruth'], [], 'Burn counter change');
    // Engine-generated descriptor identities may be canonical JSON, not card IDs.
    if (!text(change.id) || ids.has(change.id) || !counterCount(change.count))
      throw new TypeError('Burn counter changes require unique IDs and bounded counter counts.');
    evidence(change.sourceOfTruth);
    ids.add(change.id);
    if (change.count > count) count = change.count;
  }
  const replacements = [...changes].sort((a, b) => a.id < b.id ? -1 : 1);
  return {
    count,
    trace: [ruleTrace(CN_V20261019, 'status.burn', {
      aggregation: 'maximum', unit: 'damageCounters', count,
      usedDefault: changes.length === 0,
      replacements,
      selectedIds: replacements.filter((change) => change.count === count).map((change) => change.id),
    })],
  };
}
