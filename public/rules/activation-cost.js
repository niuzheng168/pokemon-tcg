import { validateActivationCosts } from './schema-validators.js';
import { matchesCardSelector } from './card-selection.js';

export const ACTIVATION_COST_RULE_IDS = Object.freeze(['effects.activation-cost', 'effects.activation-change']);
export const paymentOptionId = (costId, cardId) => JSON.stringify([costId, cardId]);

export function assertActivationCosts(costs) {
  if (!validateActivationCosts(costs) || new Set(costs.map((c) => c.costId)).size !== costs.length)
    throw new TypeError('Activation costs need unique IDs, exact counts, reviewed predicates and card evidence.');
  // 「将这只宝可梦身上附着的…放于弃牌区」 pays from one Pokémon, never together with hand cards (one payment pool).
  if (costs.some((c) => c.kind === 'discardAttached') && costs.some((c) => c.kind !== 'discardAttached'))
    throw new TypeError('Attached-card costs are paid from their Pokémon alone, not together with hand cards.');
  return costs;
}
export function costCardCount(costs, kinds = null) {
  assertActivationCosts(costs);
  const sum = costs.filter((c) => !kinds || kinds.includes(c.kind)).reduce((n, c) => n + c.count, 0);
  if (!Number.isSafeInteger(sum)) throw new TypeError('Unsafe activation-cost count.');
  return sum;
}
// The paid cards that leave the hand, and those that go into the deck (「放回牌库下方」).
export const HAND_COST_KINDS = Object.freeze(['discardHand', 'lostHand', 'bottomHand']);
export const DECK_COST_KINDS = Object.freeze(['bottomHand']);
function validateCards(cards) {
  if (!Array.isArray(cards) || cards.some((c) => !c || typeof c.instanceId !== 'string' || !c.instanceId ||
      !c.definition || typeof c.definition !== 'object' || Array.isArray(c.definition) ||
      !['pokemon', 'trainer', 'energy'].includes(c.definition.kind) || !c.definition.mechanics) ||
      new Set(cards.map((c) => c.instanceId)).size !== cards.length)
    throw new TypeError('Cost candidates need unique physical card identities and approved definitions.');
}

/** Feasibility is matching, not greedy selection or exponential enumeration of hand subsets. */
export function findCostPayment(costs, cards, { reserveIds = [], requiredIds = [] } = {}) {
  const count = costCardCount(costs); validateCards(cards);
  const pool = cards.filter((c) => !reserveIds.includes(c.instanceId));
  if (count > pool.length || requiredIds.length > count ||
      requiredIds.some((id) => !pool.some((c) => c.instanceId === id))) return null;
  const slots = costs.flatMap((c, group) => Array(c.count).fill(group));
  // Requiring particular cards to be paid is a perfect matching with extra
  // "unpaid" slots that cannot take those required cards.
  if (requiredIds.length) slots.push(...Array(pool.length - count).fill(-1));
  const owners = Array(pool.length).fill(-1);
  const assign = (slot, seen) => {
    for (let i = 0; i < pool.length; i++) {
      if (seen.has(i) || (slots[slot] === -1 ? requiredIds.includes(pool[i].instanceId) :
        !matchesCardSelector(pool[i].definition, costs[slots[slot]].selector))) continue;
      seen.add(i);
      if (owners[i] === -1 || assign(owners[i], seen)) { owners[i] = slot; return true; }
    }
    return false;
  };
  for (let i = 0; i < slots.length; i++) if (!assign(i, new Set())) return null;
  return costs.map((c, group) => ({
    costId: c.costId,
    cardIds: pool.filter((_card, i) => owners[i] >= 0 && slots[owners[i]] === group).map((card) => card.instanceId),
  }));
}

export class ActivationProofLimitError extends RangeError {
  constructor(maxCandidates) {
    super(`Activation eligibility needs more than ${maxCandidates} distinct complete payment proofs.`);
    this.name = 'ActivationProofLimitError';
    this.code = 'activation-proof-limit';
    this.ruleId = 'effects.activation-change';
  }
}

/**
 * Existential subsequent-use eligibility, NOT just fee matching (I.A-02 p8,
 * I.B-01 p11, I.B-03 p12, E-29/E-30 p68–70). An explicit CN.E29 permission
 * is not an actual performed result. The trusted, read-only host predicate
 * sees a detached complete receipt; no partial payment can qualify an effect.
 * Group assignments AND order within each group are preserved/enumerated.
 *
 * costInvariant is a trusted host proof about this predicate, never a card or
 * client declaration. Without that proof, a failed first matching is not
 * failure of every payment. A resource limit raises, never guesses "illegal".
 */
export function findCostPaymentWitness(costs, cards, canExecute, { maxCandidates = 4096, costInvariant = false } = {}) {
  if (typeof canExecute !== 'function' || !Number.isSafeInteger(maxCandidates) || maxCandidates < 1 ||
      typeof costInvariant !== 'boolean')
    throw new TypeError('Cost witnesses require a predicate, positive safe proof budget and explicit Boolean invariance.');
  const first = findCostPayment(costs, cards);
  if (!first) return null;
  const seen = new Set();
  const check = (groups) => {
    const key = JSON.stringify(groups);
    if (seen.has(key)) return null;
    if (seen.size >= maxCandidates) throw new ActivationProofLimitError(maxCandidates);
    seen.add(key);
    const detached = groups.map((g) => Object.freeze({ costId: g.costId, cardIds: Object.freeze([...g.cardIds]) }));
    const answer = canExecute(Object.freeze(detached));
    if (typeof answer !== 'boolean')
      throw new TypeError('A subsequent-effect proof must return an explicit synchronous Boolean.');
    return answer ? groups.map((g) => ({ costId: g.costId, cardIds: [...g.cardIds] })) : null;
  };
  const witness = check(first);
  if (witness || costInvariant) return witness;
  const groups = costs.map((c) => ({ costId: c.costId, cardIds: [] })), used = new Set();
  const visit = (group) => {
    if (group === costs.length) return check(groups);
    if (groups[group].cardIds.length === costs[group].count) return visit(group + 1);
    for (const card of cards) {
      if (used.has(card.instanceId) || !matchesCardSelector(card.definition, costs[group].selector)) continue;
      used.add(card.instanceId); groups[group].cardIds.push(card.instanceId);
      const remaining = costs.flatMap((c, i) => {
        const count = c.count - groups[i].cardIds.length;
        return count ? [{ ...c, count }] : [];
      });
      const available = cards.filter((c) => !used.has(c.instanceId));
      const result = !remaining.length || findCostPayment(remaining, available) ? visit(group) : null;
      groups[group].cardIds.pop(); used.delete(card.instanceId);
      if (result) return result;
    }
    return null;
  };
  return visit(0);
}

/** The player chooses assignments explicitly: no double spending across overlapping groups. */
export function readCostPayment(costs, cards, options) {
  const total = costCardCount(costs); validateCards(cards);
  if (!Array.isArray(options) || options.length !== total || new Set(options).size !== options.length) return null;
  const groups = costs.map((c) => ({ costId: c.costId, cardIds: [] })), used = new Set();
  for (const option of options) {
    let pair;
    try { pair = JSON.parse(option); } catch { return null; }
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const index = costs.findIndex((c) => c.costId === pair[0]), card = cards.find((c) => c.instanceId === pair[1]);
    if (index < 0 || !card || used.has(card.instanceId) || !matchesCardSelector(card.definition, costs[index].selector)) return null;
    used.add(card.instanceId); groups[index].cardIds.push(card.instanceId);
  }
  return groups.every((g, i) => g.cardIds.length === costs[i].count) ? groups : null;
}
