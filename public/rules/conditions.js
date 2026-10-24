import { CN_V20261019 } from './zh-CN/V20261019.js';
import { ruleTrace } from './registry.js';

export const CONDITION_RULE_IDS = Object.freeze([
  'status.exclusive', 'status.clear', 'status.cure', 'status.poison', 'status.burn',
  'status.sleep', 'status.paralysis', 'status.confusion',
]);

export const emptyConditions = () => ({ rotation: null, poison: null, burned: false, paralysisRecoverTurn: null });

export function validateConditions(c) {
  if (!c || !['asleep', 'paralyzed', 'confused', null].includes(c.rotation) || typeof c.burned !== 'boolean' ||
      (c.poison !== null && (!Number.isSafeInteger(c.poison) || c.poison < 1)) ||
      (c.rotation === 'paralyzed' ? !Number.isSafeInteger(c.paralysisRecoverTurn) || c.paralysisRecoverTurn < 1 : c.paralysisRecoverTurn !== null) ||
      Object.hasOwn(c, 'sleepCoins') && (c.rotation !== 'asleep' || !Number.isSafeInteger(c.sleepCoins) || c.sleepCoins < 2) ||
      Object.hasOwn(c, 'confusionCounters') && (c.rotation !== 'confused' || !Number.isSafeInteger(c.confusionCounters) || c.confusionCounters < 0))
    throw new TypeError('Malformed Special Conditions.');
}
// II.E-16: a special Sleep/Confusion (「因这个【睡眠】／【混乱】…」) lasts only as long as that condition.
const clearRotation = (next) => { next.rotation = null; next.paralysisRecoverTurn = null; delete next.sleepCoins; delete next.confusionCounters; };

export function applyCondition(conditions, name, { ownerTurn = 0, poisonCounters = 1, sleepCoins, confusionCounters } = {}) {
  validateConditions(conditions);
  const next = structuredClone(conditions);
  if (sleepCoins !== undefined && name !== 'asleep' || confusionCounters !== undefined && name !== 'confused')
    throw new TypeError('Only a Sleep has its own coins, only a Confusion its own counters.');
  if (['asleep', 'paralyzed', 'confused'].includes(name)) {
    if (!Number.isSafeInteger(ownerTurn) || ownerTurn < 0 || (name === 'paralyzed' && ownerTurn === Number.MAX_SAFE_INTEGER))
      throw new TypeError('Invalid owner turn.');
    clearRotation(next);
    next.rotation = name;
    next.paralysisRecoverTurn = name === 'paralyzed' ? ownerTurn + 1 : null;
    // 「因这个【睡眠】而抛掷的硬币次数变为2次」「因这个【混乱】而放置的伤害指示物数量变为6个」 (II.E-16).
    if (sleepCoins !== undefined) next.sleepCoins = sleepCoins;
    if (confusionCounters !== undefined) next.confusionCounters = confusionCounters;
    validateConditions(next);
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

// status.no-change 「使对手的战斗宝可梦陷入【灼伤】和【混乱】状态」: whether that printed condition would leave the Pokémon any different —
// not when it already has exactly that condition (the same Poison counters, Sleep coins or Confusion counters; a Paralysis ending then too).
export function conditionChanges(conditions, { condition, poisonCounters = 1, sleepCoins, confusionCounters }, ownerTurn) {
  const next = applyCondition(conditions, condition, { ownerTurn, poisonCounters, sleepCoins, confusionCounters }).conditions;
  return ['rotation', 'poison', 'burned', 'paralysisRecoverTurn', 'sleepCoins', 'confusionCounters'].some((key) => next[key] !== conditions[key]);
}

// The Special Conditions a Pokémon has, by name, among the listed ones.
export function presentConditions(conditions, names = ['asleep', 'paralyzed', 'confused', 'poisoned', 'burned']) {
  validateConditions(conditions);
  const has = { asleep: conditions.rotation === 'asleep', paralyzed: conditions.rotation === 'paralyzed',
    confused: conditions.rotation === 'confused', poisoned: conditions.poison !== null, burned: conditions.burned };
  return names.filter((name) => has[name]);
}
// 「恢复…特殊状态」: only the named conditions it has are recovered.
export function cureConditions(conditions, names) {
  const present = presentConditions(conditions);
  if (!Array.isArray(names) || !names.length || names.some((name) => !present.includes(name)) || new Set(names).size !== names.length)
    throw new TypeError('Only Special Conditions the Pokémon has can be recovered.');
  const next = structuredClone(conditions);
  if (names.includes(next.rotation)) clearRotation(next);
  if (names.includes('poisoned')) next.poison = null;
  if (names.includes('burned')) next.burned = false;
  return next;
}

/** A board checks each status across BOTH Active Pokémon before moving to the next status. Never performs KOs. */
// rules: the continuous condition rules on this Pokémon (II.E-28 JP E-17: increases add up, after a 「变为」 replacement;
// a Sleep flips the most coins any rule or the Sleep itself asks for and recovers only on all heads).
export function checkConditions(conditions, { ownerTurn, ownerIsEndingPlayer, flip, burnCounterChanges = [], step = 'all',
  rules = { poisonExtra: 0, burnExtra: 0, burnRecovers: true, sleepCoins: 1 } }) {
  validateConditions(conditions);
  const { poisonExtra, burnExtra, burnRecovers, sleepCoins } = rules;
  if (!Number.isSafeInteger(ownerTurn) || ownerTurn < 0 || typeof ownerIsEndingPlayer !== 'boolean' ||
      typeof flip !== 'function' || !Array.isArray(burnCounterChanges) ||
      burnCounterChanges.some((n) => !Number.isSafeInteger(n) || n < 0) ||
      [poisonExtra, burnExtra].some((n) => !Number.isSafeInteger(n) || n < 0) || typeof burnRecovers !== 'boolean' ||
      !Number.isSafeInteger(sleepCoins) || sleepCoins < 1 ||
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
    counters += next.poison + poisonExtra;
    trace.push(ruleTrace(CN_V20261019, 'status.poison', { counters: next.poison + poisonExtra }));
  }
  if ((step === 'all' || step === 'burn') && next.burned) {
    const damage = (burnCounterChanges.length ? Math.max(...burnCounterChanges) : 2) + burnExtra, heads = coin();
    counters += damage;
    if (heads && burnRecovers) next.burned = false;
    trace.push(ruleTrace(CN_V20261019, 'status.burn', { counters: damage, heads, ...(burnRecovers ? {} : { recovers: false }) }));
  }
  if ((step === 'all' || step === 'sleep') && next.rotation === 'asleep') {
    const coins = Math.max(sleepCoins, next.sleepCoins ?? 1), flips = Array.from({ length: coins }, coin), heads = flips.every(Boolean);
    if (heads) clearRotation(next);
    trace.push(ruleTrace(CN_V20261019, 'status.sleep', { heads, ...(coins > 1 ? { flips } : {}) }));
  }
  if ((step === 'all' || step === 'paralysis') && next.rotation === 'paralyzed' && ownerIsEndingPlayer && ownerTurn >= next.paralysisRecoverTurn) {
    clearRotation(next);
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
    succeeded: heads, selfCounters: heads ? 0 : conditions.confusionCounters ?? 3,
    trace: [ruleTrace(CN_V20261019, 'status.confusion', { heads, countsAsUsed: heads })],
  };
}
