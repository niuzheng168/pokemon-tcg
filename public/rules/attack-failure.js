import { validateFailureCoin, validateFailureReceipt } from './schema-validators.js';

export const ATTACK_FAILURE_RULE_IDS = Object.freeze(['attack.failure.imposed', 'attack.failure.self', 'attack.order']);
// attack.failure.discard 「…放于弃牌区。如果无法将卡牌放于弃牌区的话，则这个招式失败」: the discard entries such a check may name.
export const FAILURE_DISCARDS = Object.freeze(['cn.discardStadium@1', 'cn.countedToolDiscard@1']);
const coinSignature = (c) => JSON.stringify([c.mode, c.count ?? null, c.minimumHeads]);

export function assertFailureCoin(coin) {
  if (!validateFailureCoin(coin) || coin.mode === 'fixed' && coin.minimumHeads > coin.count)
    throw new TypeError('An attack failure check needs an explicit, attainable reviewed coin condition.');
  return coin;
}

/** No client-selected outcomes, no artificial "twenty flips" rule. */
export function rollFailureCoin(coin, flip) {
  assertFailureCoin(coin);
  if (typeof flip !== 'function') throw new TypeError('An authoritative coin-flip source is required.');
  const results = [];
  do {
    const heads = flip();
    if (typeof heads !== 'boolean') throw new TypeError('A coin-flip source must return a boolean.');
    results.push(heads ? 'heads' : 'tails');
  } while (coin.mode === 'fixed' ? results.length < coin.count : results.at(-1) !== 'tails');
  const heads = results.filter((r) => r === 'heads').length;
  return { results, heads, tails: results.length - heads, passed: heads >= coin.minimumHeads };
}

/** Recheck saved content against the exact approved attack, without rerolling. */
export function assertFailureReceipt(coin, receipt, mustPass = false) {
  if (typeof mustPass !== 'boolean') throw new TypeError('Receipt validation requires an explicit boolean pass policy.');
  if (coin === undefined) {
    if (receipt !== null) throw new TypeError('An attack without a self-failure condition cannot carry a failure receipt.');
    return;
  }
  assertFailureCoin(coin);
  if (!validateFailureReceipt(receipt)) throw new TypeError('Invalid attack failure receipt.');
  const heads = receipt.results.filter((r) => r === 'heads').length, tails = receipt.results.length - heads;
  if (receipt.heads !== heads || receipt.tails !== tails || receipt.passed !== (heads >= coin.minimumHeads) ||
      mustPass && !receipt.passed ||
      (coin.mode === 'fixed' ? receipt.results.length !== coin.count :
        receipt.results.at(-1) !== 'tails' || receipt.results.slice(0, -1).some((r) => r !== 'heads')))
    throw new TypeError('Saved attack failure receipt contradicts its reviewed condition or actual outcomes.');
}

/** Multiple distinct imposed checks need CN ordering evidence; never choose an arbitrary order. */
export function groupImposedChecks(entries) {
  const groups = new Map();
  for (const entry of entries) {
    assertFailureCoin(entry.spec.coin);
    const id = entry.spec.group === undefined ? Symbol('unreviewed-group') : `group:${entry.spec.group}`;
    if (groups.has(id) && coinSignature(groups.get(id)[0].spec.coin) !== coinSignature(entry.spec.coin))
      throw new TypeError('Conflicting imposed coin checks cannot share a reviewed nonstacking group.');
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(entry);
  }
  if (groups.size > 1) throw new TypeError('Multiple distinct imposed attack checks need reviewed CN ordering semantics.');
  return groups.size ? [...groups.values()][0] : [];
}
