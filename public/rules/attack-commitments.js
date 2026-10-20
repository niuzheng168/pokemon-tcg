import { matchesCardSelector } from './card-selection.js';
import { validateCardDefinition, validateCardSelector } from './schema-validators.js';

// CN advanced Ver.3.1.0, II.E-33 FAQ3, one-based PDF pages 72–73:
// discard the COMPLETE stated number of hand cards or fail this already-used
// attack. Even with enough matching cards, selecting zero may cause failure.
// This is NOT an activation cost and is NOT a declaration eligibility gate.
export const ATTACK_COMMITMENT_RULE_IDS = Object.freeze(['selection.hand', 'attack.failure.self']);

/** Reject executable/hidden/non-JSON properties before calling schema predicates. */
function assertData(value, ancestors = new Set()) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object' || ancestors.has(value) ||
      (Array.isArray(value) ? Object.getPrototypeOf(value) !== Array.prototype :
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))))
    throw new TypeError('Attack commitments require plain, acyclic JSON data.');
  ancestors.add(value);
  const keys = Reflect.ownKeys(value);
  if (Array.isArray(value) && keys.length !== value.length + 1)
    throw new TypeError('Attack commitments do not accept sparse or extended arrays.');
  for (const key of keys) {
    if (Array.isArray(value) && key === 'length') continue;
    const p = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !p.enumerable || !Object.hasOwn(p, 'value') ||
        (Array.isArray(value) && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)))
      throw new TypeError('Attack commitments do not accept hidden, executable or extra array properties.');
    assertData(p.value, ancestors);
  }
  ancestors.delete(value);
}

function exactRecord(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    throw new TypeError(`Invalid attack commitment ${label}.`);
}

/** Source evidence belongs to attack.failureCheck.handPayment's parent wrapper. */
export function assertAttackCommitment(spec) {
  assertData(spec);
  exactRecord(spec, ['op', 'count', 'selector'], 'descriptor');
  if (spec.op !== 'discardHand' || !Number.isSafeInteger(spec.count) || spec.count < 1 ||
      !validateCardSelector(spec.selector))
    throw new TypeError('An attack commitment needs discardHand, a positive safe card count and a reviewed card selector.');
  return spec;
}

/**
 * Candidates are the actor's current hand, projected as {instanceId,definition}.
 * No ownership/zone guessing, runtime Energy provision or live Pokémon fields
 * enter this function. The engine supplies the hand and independently approved
 * definitions; shape checking here does NOT approve card content.
 *
 * Repeated definitions/printings are fine, repeated PHYSICAL IDs are not.
 */
export function attackCommitmentPool(cards, spec) {
  assertAttackCommitment(spec);
  assertData(cards);
  if (!Array.isArray(cards)) throw new TypeError('Attack commitment hand candidates must be an array.');
  const ids = new Set(), pool = [];
  for (const card of cards) {
    exactRecord(card, ['instanceId', 'definition'], 'hand candidate');
    if (typeof card.instanceId !== 'string' || !card.instanceId || ids.has(card.instanceId) ||
        !validateCardDefinition(card.definition))
      throw new TypeError('Attack commitment candidates need unique physical IDs and normalized card definitions.');
    ids.add(card.instanceId);
    if (matchesCardSelector(card.definition, spec.selector)) pool.push(card.instanceId);
  }
  return pool;
}

/** Feasibility for the effect's choice UI, NEVER a requirement to declare. */
export function canPayAttackCommitment(cards, spec) {
  return attackCommitmentPool(cards, spec).length >= spec.count;
}

/**
 * Return a detached result; the parent transaction alone moves cards and records
 * the original hand, committed selection and used-attack/GX/VSTAR/turn outcome.
 * Zero is always a legal FAILURE for a valid descriptor/hand, including when
 * payment is possible. A partial payment is not a legal "as much as possible"
 * result, and an invalid answer must not silently become a voluntary failure.
 */
export function resolveAttackCommitment(cards, spec, selected) {
  const pool = new Set(attackCommitmentPool(cards, spec));
  assertData(selected);
  if (!Array.isArray(selected) || (selected.length !== 0 && selected.length !== spec.count) ||
      new Set(selected).size !== selected.length || selected.some((id) => typeof id !== 'string' || !pool.has(id)))
    throw new TypeError('Attack commitment selection must contain the full matching card count or zero, without duplicate cards.');
  return { passed: selected.length === spec.count, selected: [...selected] };
}
