import { CN_V20261019 } from './zh-CN/V20261019.js';
import { ruleTrace } from './registry.js';

export const SELECTION_RULE_IDS = Object.freeze([
  'selection.exact', 'selection.up-to', 'selection.hidden', 'selection.hand',
  'selection.prizes', 'selection.all', 'selection.optional', 'selection.any',
]);

/**
 * Quantities are semantic, not translations: CN "up to" is NOT always 0..N.
 * available is the number of eligible objects (or free Bench slots, if smaller).
 * A separate can-use check rejects a Trainer/Ability whose entire result is known
 * to do nothing; an attack may still execute its other damage/effects.
 */
export function selectionBounds({
  kind, count, available, zone = 'public', filter = 'specific', optional = false,
}, ruleset = CN_V20261019) {
  if (ruleset.id !== CN_V20261019.id) throw new RangeError('Selection semantics are pinned to CN/V20261019.');
  if (!Number.isSafeInteger(available) || available < 0) throw new TypeError('Invalid available count.');
  if (!['exact', 'upTo', 'any', 'all'].includes(kind)) throw new TypeError('Unknown quantity semantics.');
  if (['exact', 'upTo'].includes(kind) && (!Number.isSafeInteger(count) || count < 0))
    throw new TypeError('An exact/upTo quantity needs a nonnegative integer count.');
  if (!['public', 'deck', 'ownHand', 'ownFaceDownPrizes'].includes(zone))
    throw new TypeError('Unknown selection zone.');
  if (!['specific', 'anyCard'].includes(filter) || typeof optional !== 'boolean')
    throw new TypeError('Explicit filter and optional semantics are required.');
  const ruleIds = new Set();
  let minimum, maximum, allowZero = optional;
  if (kind === 'all') {
    minimum = maximum = available;
    ruleIds.add('selection.all');
  } else if (kind === 'any') {
    minimum = 0;
    maximum = available;
    ruleIds.add('selection.any');
  } else {
    maximum = Math.min(count, available);
    minimum = kind === 'exact' ? maximum : Math.min(1, maximum);
    ruleIds.add(kind === 'exact' ? 'selection.exact' : 'selection.up-to');
    if (zone !== 'public' && filter === 'specific') {
      minimum = 0;
      ruleIds.add({ deck: 'selection.hidden', ownHand: 'selection.hand', ownFaceDownPrizes: 'selection.prizes' }[zone]);
    }
  }
  if (optional) ruleIds.add('selection.optional');
  if (minimum === 0) allowZero = true;
  return {
    minimum, maximum, allowZero,
    trace: [...ruleIds].map((id) => ruleTrace(ruleset, id)),
  };
}

export function canSelectCount(bounds, count) {
  return Number.isSafeInteger(count) && count >= 0 &&
    ((count === 0 && bounds.allowZero) || (count >= bounds.minimum && count <= bounds.maximum));
}
