import { CN_V20261019 } from './zh-CN/V20261019.js';
import { ruleTrace } from './registry.js';

export const CONDITION_RULE_IDS = Object.freeze([
  'status.exclusive', 'status.clear', 'status.poison', 'status.burn',
  'status.sleep', 'status.paralysis', 'status.confusion',
]);

export const emptyConditions = () => ({ rotation: null, poison: null, burned: false, paralysisRecoverTurn: null });

export function validateConditions(c) {
  if (!c || !['asleep', 'paralyzed', 'confused', null].includes(c.rotation) || typeof c.burned !== 'boolean' ||
      (c.poison !== null && (!Number.isSafeInteger(c.poison) || c.poison < 1)) ||
      (c.rotation === 'paralyzed' ? !Number.isSafeInteger(c.paralysisRecoverTurn) || c.paralysisRecoverTurn < 1 : c.paralysisRecoverTurn !== null))
    throw new TypeError('Malformed Special Conditions.');
}

export function applyCondition(conditions, name, { ownerTurn = 0, poisonCounters = 1 } = {}) {
  validateConditions(conditions);
  const next = structuredClone(conditions);
  if (['asleep', 'paralyzed', 'confused'].includes(name)) {
    if (!Number.isSafeInteger(ownerTurn) || ownerTurn < 0 || (name === 'paralyzed' && ownerTurn === Number.MAX_SAFE_INTEGER))
      throw new TypeError('Invalid owner turn.');
    next.rotation = name;
    next.paralysisRecoverTurn = name === 'paralyzed' ? ownerTurn + 1 : null;
  } else if (name === 'poisoned') {
    if (!Number.isSafeInteger(poisonCounters) || poisonCounters < 1) throw new TypeError('Invalid poison counters.');
    next.poison = poisonCounters;
  } else if (name === 'burned') next.burned = true;
  else throw new TypeError('Unknown Special Condition.');
  return {
    conditions: next,
    trace: ruleTrace(CN_V20261019, name === 'poisoned' ? 'status.poison' : 'status.exclusive', { condition: name }),
  };
}

/** A board checks each status across BOTH Active Pokémon before moving to the next status. Never performs KOs. */
export function checkConditions(conditions, { ownerTurn, ownerIsEndingPlayer, flip, burnCounterChanges = [], step = 'all' }) {
  validateConditions(conditions);
  if (!Number.isSafeInteger(ownerTurn) || ownerTurn < 0 || typeof ownerIsEndingPlayer !== 'boolean' ||
      typeof flip !== 'function' || !Array.isArray(burnCounterChanges) ||
      burnCounterChanges.some((n) => !Number.isSafeInteger(n) || n < 0) ||
      !['all', 'poison', 'burn', 'sleep', 'paralysis'].includes(step))
    throw new TypeError('Invalid checkup context.');
  const next = structuredClone(conditions), trace = [];
  let counters = 0;
  const coin = () => {
    const result = flip();
    if (typeof result !== 'boolean') throw new TypeError('A coin result must be a boolean.');
    return result;
  };
  if ((step === 'all' || step === 'poison') && next.poison !== null) {
    counters += next.poison;
    trace.push(ruleTrace(CN_V20261019, 'status.poison', { counters: next.poison }));
  }
  if ((step === 'all' || step === 'burn') && next.burned) {
    const damage = burnCounterChanges.length ? Math.max(...burnCounterChanges) : 2, heads = coin();
    counters += damage;
    if (heads) next.burned = false;
    trace.push(ruleTrace(CN_V20261019, 'status.burn', { counters: damage, heads }));
  }
  if ((step === 'all' || step === 'sleep') && next.rotation === 'asleep') {
    const heads = coin();
    if (heads) next.rotation = null;
    trace.push(ruleTrace(CN_V20261019, 'status.sleep', { heads }));
  }
  if ((step === 'all' || step === 'paralysis') && next.rotation === 'paralyzed' && ownerIsEndingPlayer && ownerTurn >= next.paralysisRecoverTurn) {
    next.rotation = null; next.paralysisRecoverTurn = null;
    trace.push(ruleTrace(CN_V20261019, 'status.paralysis'));
  }
  if (!Number.isSafeInteger(counters)) throw new TypeError('Unsafe checkup counter count.');
  return { conditions: next, counters, trace };
}

export function resolveConfusion(conditions, heads) {
  validateConditions(conditions);
  if (conditions.rotation !== 'confused') return { succeeded: true, selfCounters: 0, trace: [] };
  if (typeof heads !== 'boolean') throw new TypeError('Confusion needs an actual coin result.');
  return {
    succeeded: heads, selfCounters: heads ? 0 : 3,
    trace: [ruleTrace(CN_V20261019, 'status.confusion', { heads, countsAsUsed: heads })],
  };
}
