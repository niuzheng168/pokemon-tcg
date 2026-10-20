/**
 * CN/V20261019 advanced II.B-01, PDF p19 (one flip, conditional +10), and
 * II.B-02, PDF p20 (Eevee: flip until tails, heads ×30). These flips supply
 * printed base-damage arithmetic; they are NOT D-01 attack-failure checks.
 * Host owns dynamic count expressions, attack/source binding and actual RNG.
 */
export const DAMAGE_COIN_RULE_IDS = Object.freeze(['damage.coins']);
export const DAMAGE_COIN_SOURCES = Object.freeze([
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.B-01', pdfPages: Object.freeze([19]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.B-02', pdfPages: Object.freeze([20]) }),
]);

export class DamageCoinError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'DamageCoinError';
    this.code = code;
    this.ruleId = 'damage.coins';
  }
}
const fail = (code, message) => { throw new DamageCoinError(code, message); };
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;

// Inspect descriptors before reading any field, including kind. Missing own
// kind must never fall through to an Object.prototype getter.
function record(value, required, optional, code) {
  if (!plain(value)) fail(code, 'Damage-coin data must be explicit plain JSON records.');
  const keys = [...required, ...optional];
  for (const key of Reflect.ownKeys(value)) {
    const p = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !keys.includes(key) || !p.enumerable || !Object.hasOwn(p, 'value'))
      fail(code, 'Damage-coin records cannot contain unknown, hidden, symbolic or executable fields.');
  }
  if (required.some((key) => !Object.hasOwn(value, key)))
    fail(code, 'Damage-coin records require explicit own data fields.');
}

/** Strict static specification; no countExpr, implicit count, pass or cap. */
export function assertDamageCoinSpec(spec) {
  const code = 'invalid-damage-coin-spec';
  record(spec, ['kind'], ['count'], code);
  if (spec.kind === 'fixed') {
    if (!Object.hasOwn(spec, 'count') || !nonnegative(spec.count))
      fail(code, 'Fixed damage coins require an explicit nonnegative safe flip count.');
  } else if (spec.kind !== 'untilTails' || Object.hasOwn(spec, 'count')) {
    fail(code, 'Use exactly fixed/count or untilTails without additional parameters.');
  }
  return spec;
}

/**
 * Consume ONLY host-supplied Boolean flips. Snapshot the exact specification
 * before the first callback; callbacks cannot change the requested stopping
 * point by mutating the caller's original spec. Output does not alias input.
 * No arbitrary twenty-flip limit and no internal RNG or damage calculation.
 */
export function rollDamageCoin(spec, flipFnBoolean) {
  assertDamageCoinSpec(spec);
  if (typeof flipFnBoolean !== 'function')
    fail('invalid-damage-coin-source', 'A host-supplied Boolean flip function is required.');
  const exactSpec = spec.kind === 'fixed' ? { kind: 'fixed', count: spec.count } : { kind: 'untilTails' };
  const results = [];
  let heads = 0, tails = 0;
  while (exactSpec.kind === 'fixed' ? results.length < exactSpec.count : tails === 0) {
    const result = flipFnBoolean();
    if (typeof result !== 'boolean')
      fail('invalid-damage-coin-source', 'A damage-coin flip must return a Boolean without coercion.');
    results.push(result ? 'heads' : 'tails');
    if (result) heads++;
    else tails++;
  }
  return { spec: exactSpec, results, heads, tails, flips: results.length };
}

function outcomes(results) {
  const code = 'invalid-damage-coin-receipt';
  if (!Array.isArray(results) || Object.getPrototypeOf(results) !== Array.prototype ||
      Reflect.ownKeys(results).length !== results.length + 1)
    fail(code, 'Damage-coin outcomes must be a dense plain JSON array.');
  let heads = 0;
  for (let i = 0; i < results.length; i++) {
    const p = Object.getOwnPropertyDescriptor(results, String(i));
    if (!p || !p.enumerable || !Object.hasOwn(p, 'value'))
      fail(code, 'Damage-coin outcomes cannot have holes, hidden items or accessors.');
    if (p.value !== 'heads' && p.value !== 'tails')
      fail(code, 'Damage-coin outcomes must be normalized heads/tails strings.');
    if (p.value === 'heads') heads++;
  }
  return heads;
}

/**
 * Validate saved results against the exact expected spec, without consuming
 * actual RNG. Shape is necessary but not sufficient: recompute every count and
 * enforce the stopping point. Return the input receipt without mutation/freezing.
 * A valid receipt alone does NOT establish its actor, source, timing or RNG.
 */
export function assertDamageCoinReceipt(spec, receipt) {
  assertDamageCoinSpec(spec);
  const code = 'invalid-damage-coin-receipt';
  record(receipt, ['spec', 'results', 'heads', 'tails', 'flips'], [], code);
  assertDamageCoinSpec(receipt.spec);
  if (receipt.spec.kind !== spec.kind || spec.kind === 'fixed' && receipt.spec.count !== spec.count)
    fail(code, 'Saved damage-coin spec differs from the expected spec.');
  if (!nonnegative(receipt.heads) || !nonnegative(receipt.tails) || !nonnegative(receipt.flips))
    fail(code, 'Saved damage-coin counts must be nonnegative safe integers.');
  const heads = outcomes(receipt.results), flips = receipt.results.length, tails = flips - heads;
  if (receipt.heads !== heads || receipt.tails !== tails || receipt.flips !== flips)
    fail(code, 'Saved damage-coin counts contradict their outcomes.');
  if (spec.kind === 'fixed' ? flips !== spec.count :
      flips === 0 || tails !== 1 || receipt.results[flips - 1] !== 'tails')
    fail(code, 'Saved damage-coin outcomes contradict the requested stopping point.');
  return receipt;
}
