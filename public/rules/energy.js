import { ENERGY_TYPES } from './damage.js';

export const ENERGY_RULE_IDS = Object.freeze(['energy.units', 'energy.types', 'energy.payment', 'retreat.payment']);

export function validateEnergyUnits(units) {
  if (!Array.isArray(units)) throw new TypeError('Energy units must be an array.');
  for (const unit of units) {
    if (!Array.isArray(unit) || !unit.length || new Set(unit).size !== unit.length ||
        unit.some((t) => !ENERGY_TYPES.includes(t))) throw new TypeError('Invalid Energy unit choices.');
  }
}

/**
 * An Energy unit has one or more alternative types, NOT simultaneous payments.
 * A two-unit Energy card supplies two such units. This is bipartite matching,
 * not a greedy first-match algorithm: overlapping choices must not cause false negatives.
 * Return one valid unit assignment, or null. Empty cost is payable with no Energy.
 */
export function payEnergyCost(units, cost) {
  validateEnergyUnits(units);
  if (!Array.isArray(cost) || cost.some((t) => !ENERGY_TYPES.includes(t))) throw new TypeError('Invalid attack Energy cost.');
  const typed = cost.map((t, index) => ({ type: t, index })).filter((c) => c.type !== 'Colorless');
  if (units.length < cost.length) return null;
  const owner = Array(units.length).fill(-1);
  const assign = (costIndex, visited) => {
    for (let i = 0; i < units.length; i++) {
      if (visited.has(i) || !units[i].includes(typed[costIndex].type)) continue;
      visited.add(i);
      if (owner[i] === -1 || assign(owner[i], visited)) {
        owner[i] = costIndex;
        return true;
      }
    }
    return false;
  };
  for (let c = 0; c < typed.length; c++) if (!assign(c, new Set())) return null;
  const assignments = Array(cost.length).fill(null);
  const spare = [];
  owner.forEach((c, unit) => {
    if (c === -1) spare.push(unit);
    else assignments[typed[c].index] = unit;
  });
  cost.forEach((t, index) => { if (t === 'Colorless') assignments[index] = spare.shift(); });
  return assignments;
}

/** I.A-03 / II.C-01: discard entire cards, not individual Energy units. */
export function validateRetreatPayment(cards, selectedIds, cost) {
  if (!Number.isSafeInteger(cost) || cost < 0) throw new TypeError('Invalid Retreat Cost.');
  if (!Array.isArray(cards) || new Set(cards.map((c) => c.instanceId)).size !== cards.length)
    throw new TypeError('Attached Energy needs unique instance IDs.');
  for (const card of cards) {
    if (!card.instanceId) throw new TypeError('Missing Energy instance ID.');
    validateEnergyUnits(card.units);
  }
  if (!Array.isArray(selectedIds) || new Set(selectedIds).size !== selectedIds.length) return false;
  const selected = selectedIds.map((id) => cards.find((c) => c.instanceId === id));
  if (selected.some((c) => !c)) return false;
  const paid = selected.reduce((n, c) => n + c.units.length, 0);
  // Overpayment may only result from an indivisible multi-unit card; no redundant
  // card is discarded to pay a cost that is already fully paid by the other cards.
  return paid >= cost && selected.every((c) => paid - c.units.length < cost);
}
