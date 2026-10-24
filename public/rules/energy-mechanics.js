import { ENERGY_TYPES } from './damage.js';
import { payEnergyCost, validateEnergyUnits } from './energy.js';
import { selectionBounds } from './selection.js';
import { CN_V20261019 } from './zh-CN/V20261019.js';
import { ruleTrace } from './registry.js';

export const ENERGY_MECHANICS_RULE_IDS = Object.freeze([
  'energy.requirement', 'energy.requirement.erase', 'energy.requirement.alternative',
  'energy.provision', 'energy.attached-selection', 'energy.move',
]);
const zero = () => Object.fromEntries(ENERGY_TYPES.map((t) => [t, 0]));
function vector(value) {
  const result = zero();
  if (Array.isArray(value)) {
    for (const t of value) {
      if (!ENERGY_TYPES.includes(t)) throw new TypeError('Unknown required Energy attribute.');
      result[t]++;
    }
  } else {
    if (!value || typeof value !== 'object' || Object.keys(value).some((t) => !ENERGY_TYPES.includes(t)))
      throw new TypeError('Invalid Energy requirement vector.');
    for (const [t, n] of Object.entries(value)) {
      if (!Number.isSafeInteger(n) || n < 0) throw new TypeError('Energy requirement counts must be nonnegative safe integers.');
      result[t] = n;
    }
  }
  return result;
}
function total(counts) {
  const n = Object.values(counts).reduce((s, n) => s + BigInt(n), 0n);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Unsafe effective Energy requirement.');
  return Number(n);
}
function evidence(items) {
  const ids = new Set();
  for (const item of items) {
    if (!item.id || ids.has(item.id) || !item.sourceOfTruth?.length)
      throw new TypeError('Energy changes need unique identities and card evidence.');
    ids.add(item.id);
  }
}

/** Printed requirements are immutable. Add/subtract together; erasure (of the whole cost or of one type) wins over both. */
export function resolveEnergyRequirements({ printed, adjustments = [], erasures = [], alternatives = [], replacement = null }) {
  // 「…所需能量，变为1个【无】能量」: the replaced cost stands in for the printed one.
  const base = vector(replacement ? replacement.cost : printed);
  evidence([...adjustments, ...erasures, ...alternatives, ...(replacement ? [replacement] : [])]);
  const sums = Object.fromEntries(ENERGY_TYPES.map((t) => [t, BigInt(base[t])]));
  for (const a of adjustments) {
    if (!ENERGY_TYPES.includes(a.energyType) || !Number.isSafeInteger(a.amount))
      throw new TypeError('Invalid reviewed Energy requirement adjustment.');
    sums[a.energyType] += BigInt(a.amount);
  }
  // A typed erasure (「使用招式所需的无能量，全部消除」) removes only that type's part; an untyped one the whole cost.
  if (erasures.some((e) => e.energyType !== undefined && !ENERGY_TYPES.includes(e.energyType)))
    throw new TypeError('Invalid reviewed Energy requirement erasure.');
  const whole = erasures.some((e) => e.energyType === undefined), erased = new Set(erasures.map((e) => e.energyType));
  const counts = zero();
  if (!whole) for (const t of ENERGY_TYPES) {
    if (erased.has(t)) continue;
    const n = sums[t] < 0n ? 0n : sums[t];
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Unsafe effective Energy requirement.');
    counts[t] = Number(n);
  }
  const routes = [{
    id: 'normal', counts, total: total(counts),
    trace: [ruleTrace(CN_V20261019, erasures.length ? 'energy.requirement.erase' : 'energy.requirement',
      { printed: base, adjustments: structuredClone(adjustments), erasures: structuredClone(erasures), counts }),
    ...(replacement ? [ruleTrace(CN_V20261019, 'energy.requirement.replace', { replacement: structuredClone(replacement) })] : [])],
  }];
  for (const option of alternatives) {
    const counts = vector(option.cost);
    routes.push({ id: option.id, counts, total: total(counts), trace: [
      ruleTrace(CN_V20261019, 'energy.requirement.alternative', { option: structuredClone(option), counts }),
    ] });
  }
  return routes;
}

export function meetsEnergyRequirement(units, route) {
  validateEnergyUnits(units);
  const counts = vector(route.counts), required = total(counts);
  if (required !== route.total) throw new TypeError('Corrupt effective Energy requirement total.');
  if (required > units.length) return false; // Never allocate a huge expanded cost just to reject it.
  const cost = ENERGY_TYPES.flatMap((t) => Array(counts[t]).fill(t));
  return payEnergyCost(units, cost) !== null;
}

// energy.extra 「如果追加附有N个（【X】）能量的话」: the most attached units able to provide `type` (any unit when null) that
// some payment of the route leaves unpaid. One unit pays the cost or counts as extra, never both.
export function surplusEnergy(units, route, type = null) {
  validateEnergyUnits(units);
  const able = units.flatMap((u, i) => type === null || u.includes(type) ? [i] : []);
  if (able.length > 16) throw new RangeError('Too many attached Energy units to search exactly.');
  const subsets = (from, k) => k === 0 ? [[]] : from.length < k ? [] :
    [...subsets(from.slice(1), k - 1).map((rest) => [from[0], ...rest]), ...subsets(from.slice(1), k)];
  for (let k = able.length; k > 0; k--)
    if (subsets(able, k).some((kept) => meetsEnergyRequirement(units.filter((_, i) => !kept.includes(i)), route))) return k;
  return 0;
}

// 「如果追加附有【火】【水】【雷】能量各1个的话」: 1 when some payment of the route leaves a different unit able to provide each
// listed type at once (one unit never counts for two types), else 0.
export function surplusEachEnergy(units, route, types) {
  validateEnergyUnits(units);
  if (units.length > 16) throw new RangeError('Too many attached Energy units to search exactly.');
  const pick = (i, used) => i === types.length ? meetsEnergyRequirement(units.filter((_, k) => !used.includes(k)), route)
    : units.some((u, k) => !used.includes(k) && u.includes(types[i]) && pick(i + 1, [...used, k]));
  return pick(0, []) ? 1 : 0;
}

function canonicalUnits(units) {
  validateEnergyUnits(units);
  return units.map((u) => [...u].sort((a, b) => ENERGY_TYPES.indexOf(a) - ENERGY_TYPES.indexOf(b)))
    .sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
}
export function resolveEnergyProvision(base, replacements = []) {
  validateEnergyUnits(base); evidence(replacements);
  const variants = replacements.map((r) => canonicalUnits(r.units));
  if (new Set(variants.map((u) => JSON.stringify(u))).size > 1) {
    const e = new TypeError('Conflicting Energy provision replacements require a sourced card-specific priority.');
    e.code = 'unresolved-energy-provision'; throw e;
  }
  return { units: structuredClone(variants[0] ?? base), trace: [
    ruleTrace(CN_V20261019, 'energy.provision', { replacements: structuredClone(replacements) }),
  ] };
}

export function matchingEnergyUnits(units, providedTypes) {
  validateEnergyUnits(units);
  if (providedTypes !== null && (!Array.isArray(providedTypes) || !providedTypes.length ||
      new Set(providedTypes).size !== providedTypes.length || providedTypes.some((t) => !ENERGY_TYPES.includes(t))))
    throw new TypeError('Invalid provided-Energy attribute filter.');
  // An all-attribute unit counts once, not once for every matching attribute.
  return units.filter((u) => providedTypes === null || providedTypes.some((t) => u.includes(t))).length;
}

export function attachedEnergySelection(cards, { measure, quantity, providedTypes }, selected) {
  if (!['cards', 'units'].includes(measure) || !Array.isArray(cards) || cards.some((c) => !c || typeof c.instanceId !== 'string' || !c.instanceId) ||
      new Set(cards.map((c) => c.instanceId)).size !== cards.length) throw new TypeError('Invalid attached-Energy selection context.');
  const pool = cards.map((c) => {
    const matching = matchingEnergyUnits(c.units, providedTypes);
    return { ...c, matching, amount: measure === 'cards' ? 1 : matching };
  }).filter((c) => c.amount > 0 && (providedTypes === null || c.matching > 0));
  const available = pool.reduce((n, c) => n + c.amount, 0);
  const bounds = selectionBounds({ ...quantity, available });
  if (!Array.isArray(selected) || new Set(selected).size !== selected.length || selected.some((id) => !pool.some((c) => c.instanceId === id)))
    return { valid: false, unsupported: false, bounds };
  const chosen = selected.map((id) => pool.find((c) => c.instanceId === id)), amount = chosen.reduce((n, c) => n + c.amount, 0);
  if (measure === 'cards' || quantity.kind === 'any' || quantity.kind === 'all')
    return { valid: quantity.kind === 'all' ? chosen.length === pool.length :
      amount >= bounds.minimum && amount <= bounds.maximum, unsupported: false, bounds };
  const target = quantity.kind === 'exact' ? bounds.minimum : bounds.maximum;
  const excessive = amount > target && chosen.some((c) => amount - c.amount >= target);
  // The CN examples establish indivisible cards, but not arbitrary redundant
  // multi-card over-selection. Keep that missing ruling explicit.
  if (excessive) return { valid: false, unsupported: chosen.some((c) => c.amount > 1), bounds };
  return { valid: quantity.kind === 'exact' ? amount >= target : amount >= bounds.minimum,
    unsupported: false, bounds };
}
