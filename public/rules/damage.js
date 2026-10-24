import { CN_V20261019 } from './zh-CN/V20261019.js';
import { ruleTrace } from './registry.js';

export const DAMAGE_RULE_IDS = Object.freeze([
  'damage.base', 'damage.zero', 'damage.attacker', 'damage.weakness', 'damage.resistance',
  'damage.defender', 'damage.prevention', 'damage.ignore-wr', 'damage.ignore-defender',
  'damage.bench', 'damage.self', 'damage.record',
]);

export const POKEMON_TYPES = Object.freeze([
  'Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting',
  'Darkness', 'Metal', 'Fairy', 'Dragon', 'Colorless',
]);
// I.C / II.D-08 distinguish 11 Pokémon types from the 10 Energy attributes.
// Dragon is a Pokémon type, not an attribute supplied by "all types of Energy".
export const ENERGY_TYPES = Object.freeze(POKEMON_TYPES.filter((t) => t !== 'Dragon'));

function integer(value, field, { signed = false, tens = false } = {}) {
  if (!Number.isSafeInteger(value) || (!signed && value < 0) || (tens && value % 10 !== 0))
    throw new TypeError(`${field} must be a ${signed ? '' : 'nonnegative '}safe integer${tens ? ' in units of 10' : ''}.`);
  return value;
}

function type(value) {
  if (!POKEMON_TYPES.includes(value)) throw new TypeError(`Unknown normalized type: ${value}`);
  return value;
}

function checkedSum(values, field) {
  return values.reduce((sum, value) => integer(sum + value, field, { signed: true, tens: true }), 0);
}

function modifiers(values, field) {
  if (!Array.isArray(values)) throw new TypeError(`${field} must be an array.`);
  const ids = new Set();
  return values.map((modifier) => {
    if (!modifier.id || ids.has(modifier.id) || !modifier.sourceOfTruth?.length)
      throw new TypeError(`${field} must have unique effect IDs and card evidence.`);
    ids.add(modifier.id);
    integer(modifier.amount, `${field}.${modifier.id}`, { signed: true, tens: true });
    return modifier;
  });
}

/**
 * Pure damage sub-pipeline (not the whole attack). The effect interpreter must resolve
 * choices, coin flips, attack arithmetic, applicable modifiers and effective W/R first.
 * In particular, never pass printed W/R when a live effect has changed or removed it.
 *
 * The caller supplies only modifiers applicable to THIS target and source. For example,
 * "opponent's Active Pokémon" bonuses must not be supplied for recoil or a Bench target.
 * A modifier retains its card evidence; pipeline steps retain their official rule evidence.
 * This module never asks an AI, mutates a board, or infers rules from display text.
 */
export function calculateAttackDamage(packet, ruleset = CN_V20261019) {
  if (ruleset.id !== CN_V20261019.id) throw new RangeError('This implementation is pinned to CN/V20261019.');
  const {
    amount,
    attackerTypes,
    targetPosition = 'active',
    targetRelation = 'opponent',
    weakness = null,
    resistance = null,
    attackerModifiers = [],
    defenderModifiers = [],
    preventions = [],
    ignoreWeakness = false,
    ignoreResistance = false,
    ignoreDefenderEffects = false,
    applyBenchWeaknessResistance = false,
  } = packet;
  if (amount !== null) integer(amount, 'amount', { tens: true });
  if (!Array.isArray(attackerTypes) || !attackerTypes.length ||
      new Set(attackerTypes).size !== attackerTypes.length) throw new TypeError('Unique attacker types are required.');
  attackerTypes.forEach(type);
  if (!['active', 'bench'].includes(targetPosition) || !['opponent', 'self'].includes(targetRelation))
    throw new TypeError('An explicit target position/relation is required.');
  for (const flag of [ignoreWeakness, ignoreResistance, ignoreDefenderEffects, applyBenchWeaknessResistance])
    if (typeof flag !== 'boolean') throw new TypeError('Damage flags must be booleans.');
  if (weakness) {
    type(weakness.type);
    if (!['multiply', 'add'].includes(weakness.operation)) throw new TypeError('Unknown Weakness operation.');
    integer(weakness.value, 'weakness.value', { tens: weakness.operation === 'add' });
    if (weakness.operation === 'multiply' && weakness.value < 1) throw new TypeError('Invalid Weakness multiplier.');
  }
  if (resistance) {
    type(resistance.type);
    integer(resistance.value, 'resistance.value', { tens: true });
  }
  const attackMods = modifiers(attackerModifiers, 'attackerModifiers');
  const defendMods = modifiers(defenderModifiers, 'defenderModifiers');
  if (!Array.isArray(preventions) || preventions.some((p) => !p.id || !p.sourceOfTruth?.length))
    throw new TypeError('Damage prevention needs an effect ID and card evidence.');
  for (const p of preventions) for (const [field, value] of [['atMost', p.atMost], ['atLeast', p.atLeast], ...(p.values ?? []).map((v) => ['values', v])])
    if (value !== undefined) integer(value, `prevention.${field}`, { tens: true });
  const trace = [];
  let damage = amount ?? 0;
  const step = (id, before, after, extra = {}) => trace.push(
    ruleTrace(ruleset, id, { before, after, ...extra }),
  );
  const finish = (stoppedAt = null) => ({
    rulesetId: ruleset.id,
    damage,
    counters: damage / 10,
    stoppedAt,
    trace,
  });
  const stopAtZero = (stage) => {
    if (damage > 0) return false;
    const before = damage;
    damage = 0;
    step('damage.zero', before, 0, { stage });
    return true;
  };
  step('damage.base', amount, damage, { hasDamage: amount !== null });
  if (stopAtZero('base')) return finish('base');

  let before = damage;
  damage = integer(damage + checkedSum(attackMods.map((m) => m.amount), 'attacker sum'), 'attacker result', { signed: true, tens: true });
  step('damage.attacker', before, damage, { modifiers: attackMods });
  if (stopAtZero('attacker')) return finish('attacker');

  const skipWR = targetPosition === 'bench' && !applyBenchWeaknessResistance;
  if (targetPosition === 'bench') step('damage.bench', damage, damage, { applyBenchWeaknessResistance });
  if (targetRelation === 'self') step('damage.self', damage, damage);
  if (ignoreWeakness || ignoreResistance) step('damage.ignore-wr', damage, damage, { ignoreWeakness, ignoreResistance });
  // II.B-07: a removed Weakness remains removed even when this attack ignores
  // effects on the defending Pokémon. Do not "restore" printed W/R here.
  if (ignoreDefenderEffects) step('damage.ignore-defender', damage, damage);
  before = damage;
  if (!skipWR && !ignoreWeakness && weakness && attackerTypes.includes(weakness.type)) {
    damage = weakness.operation === 'multiply' ? damage * weakness.value : damage + weakness.value;
    integer(damage, 'weakness result', { tens: true });
  }
  step('damage.weakness', before, damage, { weakness, skipped: skipWR || ignoreWeakness });

  before = damage;
  if (!skipWR && !ignoreResistance && resistance && attackerTypes.includes(resistance.type)) damage -= resistance.value;
  step('damage.resistance', before, damage, { resistance, skipped: skipWR || ignoreResistance });
  if (stopAtZero('resistance')) return finish('resistance');

  before = damage;
  if (!ignoreDefenderEffects) {
    damage = integer(damage + checkedSum(defendMods.map((m) => m.amount), 'defender sum'), 'defender result', { signed: true, tens: true });
  }
  step('damage.defender', before, damage, { modifiers: defendMods, skipped: ignoreDefenderEffects });
  if (stopAtZero('defender')) return finish('defender');

  // 「不会受到「N」点以下（包含N点）的招式的伤害」 (atMost) prevents only damage of at most N here; 「「200」及以上」 (atLeast)
  // only damage of at least N; 「伤害为「20、40…」」 (values) only damage of exactly one of them (damage.prevention-values).
  const applied = preventions.filter((p) => (p.atMost === undefined || damage <= p.atMost) &&
    (p.atLeast === undefined || damage >= p.atLeast) && (!p.values || p.values.includes(damage)));
  if (applied.length && !ignoreDefenderEffects) {
    before = damage;
    damage = 0;
    step('damage.prevention', before, 0, { effects: applied });
    return finish('prevention');
  }
  step('damage.record', damage, damage, { counters: damage / 10 });
  return finish();
}
