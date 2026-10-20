/**
 * CN/V20261019 II.D-17: card-effect "already obtained Prize cards".
 *
 * This is NOT a KO/award history count, a win condition, or the number actually
 * laid out at setup. The reviewed bases are fixed by original deck size.
 * I.E's one-Prize tiebreak setup does not settle D-17's effect-count scope.
 * Likewise, no reviewed text here settles a result below zero: do not clamp it
 * or declare that the underlying game state is officially illegal.
 *
 * The parent supplies a trusted original deck size and validated battle state.
 * No command, card or imported approval flag may choose the counting policy.
 */
import { deepFreeze } from './registry.js';

export const PRIZE_COUNT_RULE_IDS = Object.freeze(['prizes.effects-count', 'win.tiebreak']);
export const PRIZE_COUNT_BASES = Object.freeze({ 30: 3, 40: 4, 60: 6 });
export const PRIZE_COUNT_SOURCES = deepFreeze({
  effectsCount: { documentId: 'CN-advanced-3.1.0', section: 'II.D-17', pdfPages: [50, 51] },
  tiebreakSetup: { documentId: 'CN-advanced-3.1.0', section: 'I.E 抢分赛', pdfPages: [16] },
  tournamentScope: { documentId: 'CN-tournament-3.1.0', section: '5.1; 第12章', pdfPages: [5, 17] },
});

export class PrizeCountError extends TypeError {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'PrizeCountError';
    this.code = code;
    this.needsRuling = code === 'needs-ruling';
    this.details = details;
  }
}
const fail = (code, message) => { throw new PrizeCountError(code, message); };
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v));

// Validate property descriptors before reading values; never invoke getters.
function record(value, keys, code) {
  if (!plain(value)) fail(code, 'Prize-count parameters must be a plain data record.');
  for (const key of Reflect.ownKeys(value)) {
    const p = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !keys.includes(key) || !p.enumerable || !Object.hasOwn(p, 'value'))
      fail(code, 'Unknown, hidden or executable prize-count parameter.');
  }
  if (keys.some((key) => !Object.hasOwn(value, key))) fail(code, 'Prize-count parameters must be explicit.');
}

/** Strict standalone gate matching prize-count.schema.json; no defaults. */
export function assertPrizeCountQuery(query) {
  const code = 'invalid-prize-count-query';
  record(query, ['ruleset', 'deckSize', 'matchMode', 'remainingPrizes'], code);
  record(query.ruleset, ['region', 'version'], code);
  if (query.ruleset.region !== 'CN' || query.ruleset.version !== 'V20261019')
    fail(code, 'This prize-count query implements CN/V20261019 only.');
  if (![30, 40, 60].includes(query.deckSize) || !['normal', 'tiebreak'].includes(query.matchMode) ||
      !Number.isSafeInteger(query.remainingPrizes) || query.remainingPrizes < 0)
    fail(code, 'Use an explicit reviewed deck size, match mode and nonnegative safe remaining count.');
  return query;
}

/**
 * Returns a detached immutable value. reasons have canonical serialization
 * order, NOT gameplay timing priority. needsRuling never carries a number.
 */
export function queryPrizesTaken(query) {
  assertPrizeCountQuery(query);
  const basis = PRIZE_COUNT_BASES[query.deckSize], reasons = [];
  const sourceOfTruth = [PRIZE_COUNT_SOURCES.effectsCount];
  if (query.matchMode === 'tiebreak') {
    reasons.push('tiebreak-scope-unresolved');
    sourceOfTruth.push(PRIZE_COUNT_SOURCES.tiebreakSetup, PRIZE_COUNT_SOURCES.tournamentScope);
  }
  if (query.remainingPrizes > basis) reasons.push('remaining-exceeds-basis');
  return deepFreeze({
    status: reasons.length ? 'needsRuling' : 'resolved',
    basis, count: reasons.length ? null : basis - query.remainingPrizes, reasons, sourceOfTruth,
  });
}

/** Numeric formula/permission bridge: unresolved counting can never become 0. */
export function requirePrizesTaken(query) {
  const result = queryPrizesTaken(query);
  if (result.status !== 'resolved')
    throw new PrizeCountError('needs-ruling', 'A reviewed CN prize-count ruling is required for this scope.', result);
  return result.count;
}

// An effect context contains many unrelated fields. Read only required own data
// fields, without inspecting/fingerprinting hidden cards or the unselected side.
function field(value, key) {
  const code = 'invalid-prize-count-context';
  if (!plain(value)) fail(code, 'Prize-count hooks require an explicit plain effect context.');
  const p = Object.getOwnPropertyDescriptor(value, key);
  if (!p || !p.enumerable || !Object.hasOwn(p, 'value'))
    fail(code, 'A prize-count context field is missing, inherited, hidden or executable.');
  return p.value;
}
function array(value) {
  const code = 'invalid-prize-count-context';
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1)
    fail(code, 'Prize-count hooks require dense plain data arrays.');
  for (let i = 0; i < value.length; i++) {
    const p = Object.getOwnPropertyDescriptor(value, String(i));
    if (!p || !p.enumerable || !Object.hasOwn(p, 'value'))
      fail(code, 'Prize-count arrays cannot contain getters, hidden items or holes.');
  }
  return value;
}

/**
 * Parent-installed hook for normal battle formulas/handlers. `player` is an
 * explicit absolute owner, not ctx.current/source.owner or a translated name.
 * `deckSize` is trusted MATCH CONFIGURATION, not current deck.length.
 *
 * Read the private physical Prize IDs only for their public cardinality.
 * Full catalog/state validation and original deck-size admission remain the
 * parent's responsibility. This does not install a handler or approve a card.
 */
export function prizesTakenForPlayer(ctx, parameters) {
  const code = 'invalid-prize-count-context';
  record(parameters, ['player', 'deckSize'], code);
  if (parameters.player !== 0 && parameters.player !== 1)
    fail(code, 'An explicit Prize holder (0 or 1) is required.');
  const state = field(ctx, 'state'), phase = field(state, 'phase');
  if (!['main', 'resolving', 'checkup', 'over'].includes(phase))
    fail(code, 'This effect-time hook is unavailable before Prize setup or in an unknown phase.');
  const players = array(field(state, 'players'));
  if (players.length !== 2) fail(code, 'Exactly two explicit player slots are required.');
  const prizes = array(field(players[parameters.player], 'prizes'));
  if (prizes.some((id) => typeof id !== 'string' || !id.length) || new Set(prizes).size !== prizes.length)
    fail(code, 'Remaining Prizes need unique nonempty physical card IDs.');
  return requirePrizesTaken({
    ruleset: field(state, 'ruleset'), deckSize: parameters.deckSize,
    matchMode: field(state, 'matchMode'), remainingPrizes: prizes.length,
  });
}
