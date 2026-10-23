import { CN_OFFICIAL_EVIDENCE_URL_PATTERN, CN_CARD_LIBRARY_EVIDENCE_URL_PATTERN } from './registry.js';

const officialURL = new RegExp(CN_OFFICIAL_EVIDENCE_URL_PATTERN), libraryURL = new RegExp(CN_CARD_LIBRARY_EVIDENCE_URL_PATTERN);
/**
 * CN/V20261019 history semantics, independent of the board/state machine.
 *
 * Integration contract (wired into OfficialGame's private battleHistory ledger):
 * - recordBattleTurn(history, { turn, player }) at the actual start-turn boundary,
 *   including additional turns. Keep the complete ordered turn ledger from 1.
 * - recordBattleEvent(history, event, { turn, during }) for committed facts.
 *   During checkup use during:null, even for a card effect with a real source.
 * - A KO needs the cause latched at its KO boundary, not a later board lookup.
 *   Existing player.history entries without owner/cause cannot be migrated by
 *   guessing. Preserve actual attack users, including copied/granted attacks.
 * - Emit benchToActive only for an actual Bench -> Active transition, heal.amount
 *   as HP actually recovered (not requested), and supporterPlayed at the actual
 *   play action with its original zone. Query the actual user's Pokémon ID,
 *   never a physical card ID or copied attack's content holder.
 * - fieldTransition records a committed evolution/devolution that actually
 *   clears a chosen owned-attack lock: retain the battle Pokémon ID and the
 *   distinct physical top-card IDs before/after. The host decides when to emit;
 *   ordinary untracked transitions need not appear. Inheritance (II.D-19)
 *   retains attached effects and is NOT an evolution/devolution clear fact.
 *   This is a software observed-fact protocol, not an official card-text field
 *   or authorization to perform a transition.
 * - turnEnded is the committed expire-turn boundary for a chosen lock's
 *   retirement, with during === owner (never checkup/null). It has no Pokémon
 *   identity and does not create, revive or change any holder. The host emits
 *   it only when a chosen lock actually expires, not for legacy turn endings.
 * - The host still verifies source/card ownership, approved bindings and copy/
 *   grant receipts against its catalog. Structural history validation is neither
 *   authentication nor proof that an action was legal.
 *
 * The kernel registers battle-history.schema.json and BATTLE_HISTORY_RULES,
 * follows generated shape validation with these temporal/identity assertions,
 * and independently validates catalog sources and historical copy/grant receipts.
 * No board, damage counters, action limits or legacy flags are read here.
 */

const sourced = (id, section, pages) => Object.freeze({
  id, rulesetId: 'CN/V20261019',
  sourceOfTruth: Object.freeze([Object.freeze({
    documentId: 'CN-advanced-3.1.0', section, pdfPages: Object.freeze(pages),
  })]),
});
export const BATTLE_HISTORY_RULES = Object.freeze({
  previousOpponentKO: sourced('history.previous-opponent-ko', 'II.E-11', [58, 59]),
  benchToActive: sourced('history.bench-to-active-this-turn', 'II.E-24', [66, 67]),
  supporterFromHand: sourced('history.supporter-from-hand-this-turn', 'II.E-25', [67]),
  healed: sourced('history.healed-this-turn', 'II.E-26', [67]),
  checkup: sourced('history.checkup-not-a-turn', 'I.F; II.E-20', [16, 64]),
  knockoutCause: sourced('history.knockout-cause', 'I.D; II.C-07—08; II.E-11', [14, 30, 31, 58, 59]),
});
// Separate evidence for this software fact; do not add an unregistered query
// rule or change the existing six history condition/query contracts.
export const FIELD_TRANSITION_HISTORY_SOURCES = Object.freeze([
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.C-15', pdfPages: Object.freeze([36]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'I.A-05', pdfPages: Object.freeze([10]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.C-13', pdfPages: Object.freeze([35]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.D-19', pdfPages: Object.freeze([52, 53]) }),
]);
// 「在上一个自己的回合，如果…使用了（「X」）招式」: an attack counts as used once it passes step 2 of the attack procedure.
export const ATTACK_USED_HISTORY_SOURCES = Object.freeze([
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'I.A-01 使用招式的步骤', pdfPages: Object.freeze([5, 6]) }),
]);
export const TURN_ENDED_HISTORY_SOURCES = Object.freeze([
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'I.A-01', pdfPages: Object.freeze([5]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'I.F', pdfPages: Object.freeze([16]) }),
]);

export class BattleHistoryError extends TypeError {
  constructor(code, message) { super(message); this.name = 'BattleHistoryError'; this.code = code; }
}
const fail = (code, message) => { throw new BattleHistoryError(code, message); };
const player = (value) => value === 0 || value === 1;
const text = (value) => typeof value === 'string' && value.length > 0;
const turnNumber = (value) => Number.isSafeInteger(value) && value >= 1;
const copy = (value) => JSON.parse(JSON.stringify(value));

/** Reject values whose meaning would disappear/change in a JSON round trip. */
function assertJSON(value) {
  const work = [{ value }], ancestors = new Set();
  while (work.length) {
    const item = work.pop(), current = item.value;
    if (item.exit) { ancestors.delete(current); continue; }
    if (current === null || ['string', 'boolean'].includes(typeof current) ||
        typeof current === 'number' && Number.isFinite(current)) continue;
    if (!current || typeof current !== 'object' || ancestors.has(current) ||
        (Array.isArray(current) ? Object.getPrototypeOf(current) !== Array.prototype :
          ![Object.prototype, null].includes(Object.getPrototypeOf(current))))
      fail('invalid-history-json', 'History must be finite, acyclic plain JSON.');
    const array = Array.isArray(current), keys = Reflect.ownKeys(current);
    if (array && keys.length !== current.length + 1)
      fail('invalid-history-json', 'Sparse arrays or extra array properties are not history JSON.');
    ancestors.add(current); work.push({ value: current, exit: true });
    for (const key of keys) {
      if (array && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') ||
          array && (!Number.isSafeInteger(Number(key)) || String(Number(key)) !== key ||
            Number(key) < 0 || Number(key) >= current.length))
        fail('invalid-history-json', 'History cannot contain accessors, symbols or hidden properties.');
      work.push({ value: descriptor.value });
    }
  }
}

function object(value, required, optional = [], code = 'invalid-history-shape') {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      required.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key)))
    fail(code, 'History records need exactly their declared fields.');
}
function assertClock(clock) {
  object(clock, ['turn', 'during']);
  if (!Number.isSafeInteger(clock.turn) || clock.turn < 0 ||
      clock.during !== null && !player(clock.during) || clock.turn === 0 && clock.during !== null)
    fail('invalid-history-time', 'An explicit safe turn and actual player, or null during checkup/setup, are required.');
}
function assertSource(source) {
  const code = 'invalid-history-source';
  object(source, ['instanceId', 'owner', 'category', 'pokemonId', 'attackId', 'effectId', 'sourceOfTruth'],
    ['origin', 'cardOwner', 'contentSource', 'copyId', 'grantId'], code);
  if (!text(source.instanceId) || !player(source.owner) || !text(source.effectId) ||
      !['attack', 'ability', 'trainer', 'energy', 'rule'].includes(source.category) ||
      source.pokemonId !== null && !text(source.pokemonId) || source.attackId !== null && !text(source.attackId) ||
      Object.hasOwn(source, 'origin') && !['hand', 'field', 'draw', 'prizes'].includes(source.origin) ||
      Object.hasOwn(source, 'cardOwner') && !player(source.cardOwner) ||
      source.category === 'attack' && (!text(source.pokemonId) || !text(source.attackId)))
    fail(code, 'A cause must retain its actual runtime source identities, not only a player or a card name.');
  if (!Array.isArray(source.sourceOfTruth) || !source.sourceOfTruth.length)
    fail(code, 'A card source needs its original reviewed evidence.');
  for (const evidence of source.sourceOfTruth) {
    // Official evidence, or a machine-implemented card's library record (the definition's tier was checked on admission).
    const library = evidence?.kind === 'card-library';
    object(evidence, ['sourceId', 'kind', 'url', 'locator'], library ? ['observedOn'] : ['textSha256', 'observedOn'], code);
    if (typeof evidence.sourceId !== 'string' || evidence.sourceId.length > 200 ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(evidence.sourceId) ||
        !library && !['official-card', 'official-erratum', 'official-rule'].includes(evidence.kind) ||
        typeof evidence.url !== 'string' || !(library ? libraryURL : officialURL).test(evidence.url) ||
        !text(evidence.locator) ||
        Object.hasOwn(evidence, 'textSha256') && (typeof evidence.textSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.textSha256)) ||
        Object.hasOwn(evidence, 'observedOn') && (typeof evidence.observedOn !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(evidence.observedOn)))
      fail(code, 'Malformed source evidence.');
  }
  const content = Object.hasOwn(source, 'contentSource'), copied = Object.hasOwn(source, 'copyId'),
    granted = Object.hasOwn(source, 'grantId');
  if (content !== (copied || granted) || copied && granted ||
      content && source.category !== 'attack' ||
      copied && !text(source.copyId) || granted && !text(source.grantId))
    fail(code, 'Copied/granted content must retain exactly one original selection receipt.');
  if (content) {
    object(source.contentSource, ['instanceId', 'attackId'], [], code);
    if (!text(source.contentSource.instanceId) || !text(source.contentSource.attackId))
      fail(code, 'Copied/granted content needs its actual printed attack reference.');
  }
}
const UNTARGETED = ['supporterPlayed', 'turnEnded', 'prizeTaken'];
function assertEvent(event) {
  const common = ['kind', 'turn', 'during', 'owner'], code = 'invalid-history-event';
  const fields = {
    ko: ['pokemonId', 'cause'], benchToActive: ['pokemonId'], heal: ['pokemonId', 'amount'],
    supporterPlayed: ['cardId', 'origin'],
    fieldTransition: ['pokemonId', 'fromCardId', 'toCardId', 'method'],
    turnEnded: [], attackUsed: ['pokemonId', 'cardId', 'attackName'],
    attackDamage: ['pokemonId', 'damage', 'active'], prizeTaken: ['cardId'],
  };
  if (!event || !Object.hasOwn(event, 'kind') || !Object.hasOwn(fields, event.kind))
    fail(code, 'Unknown history event kind.');
  object(event, [...common, ...fields[event.kind]], event.kind === 'attackUsed' ? ['specialRule'] : [], code);
  if (!turnNumber(event.turn) || event.during !== null && !player(event.during) || !player(event.owner) ||
      !UNTARGETED.includes(event.kind) && !text(event.pokemonId))
    fail(code, 'A battle event requires its real turn, affected holder and Pokémon identity.');
  if (event.kind === 'ko') {
    object(event.cause, ['kind', 'source'], [], code);
    const { kind, source } = event.cause;
    if (!['attackDamage', 'effect', 'checkup', 'rule'].includes(kind))
      fail(code, 'Unknown Knock Out cause; legacy missing causes cannot be inferred.');
    if (source !== null) assertSource(source);
    if (['attackDamage', 'effect'].includes(kind) && source === null ||
        kind === 'attackDamage' && (source.category !== 'attack' || event.during === null || source.owner !== event.during) ||
        kind === 'checkup' && (event.during !== null || source !== null))
      fail(code, 'Knock Out cause contradicts its source or actual turn/checkup boundary.');
  } else if (event.kind === 'heal') {
    if (!Number.isSafeInteger(event.amount) || event.amount < 0 || event.amount > 9007199254740990 || event.amount % 10)
      fail(code, 'Recovered HP is an actual, safe multiple of ten; a zero/no-op recovery does not satisfy E-26.');
  } else if (event.kind === 'fieldTransition') {
    if (!text(event.fromCardId) || !text(event.toCardId) || event.fromCardId === event.toCardId ||
        !['evolution', 'devolution'].includes(event.method))
      fail(code, 'A field transition needs distinct physical before/after card IDs and an explicit evolution/devolution method.');
  } else if (event.kind === 'attackUsed') {
    if (event.during !== event.owner || !text(event.cardId) || !text(event.attackName) ||
        Object.hasOwn(event, 'specialRule') && !['GX', 'VSTAR'].includes(event.specialRule))
      fail(code, 'A used attack needs its actual attacking player, top card and printed attack name.');
  } else if (event.kind === 'attackDamage') {
    if (event.during === null || !Number.isSafeInteger(event.damage) || event.damage < 10 || event.damage % 10 ||
        typeof event.active !== 'boolean')
      fail(code, 'Attack damage is an actual positive ten-point amount dealt during a turn, with the Pokémon\'s spot.');
  } else if (event.kind === 'prizeTaken') {
    if (!text(event.cardId)) fail(code, 'A taken Prize card needs its real card.');
  } else if (event.kind === 'turnEnded') {
    if (event.during !== event.owner)
      fail(code, 'A completed turn boundary needs its actual non-checkup ending player as both during and owner.');
  } else if (event.kind === 'supporterPlayed' &&
      (!text(event.cardId) || !['hand', 'deck', 'discard', 'prizes'].includes(event.origin)))
    fail(code, 'A Supporter play needs its real card and original zone.');
}

/** Strict detached canonical KO record. Does not repair or guess legacy events. */
export function normalizeKnockoutEvent(event) {
  assertJSON(event); assertEvent(event);
  if (event.kind !== 'ko') fail('invalid-history-event', 'A Knock Out event is required.');
  return { kind: 'ko', turn: event.turn, during: event.during, owner: event.owner,
    pokemonId: event.pokemonId, cause: copy(event.cause) };
}

export function createBattleHistory() {
  return { schemaVersion: '1.0.0', turns: [], events: [] };
}

/**
 * Full ledger assertion. clock is the actual evaluation boundary, never inferred
 * from a KO's owner. Turn IDs are contiguous from 1; player order may repeat.
 * Events are chronological, with a turn's checkup after all of its turn events.
 */
export function assertBattleHistory(history, clock) {
  assertJSON(history); assertJSON(clock); assertClock(clock);
  object(history, ['schemaVersion', 'turns', 'events']);
  if (history.schemaVersion !== '1.0.0' || !Array.isArray(history.turns) || !Array.isArray(history.events))
    fail('invalid-history-shape', 'Unsupported or malformed battle history ledger.');
  if (history.turns.length !== clock.turn)
    fail('invalid-history-time', 'Complete actual turn history must end at the evaluation turn; no gaps or future turns.');
  for (const [index, entry] of history.turns.entries()) {
    object(entry, ['turn', 'player']);
    if (entry.turn !== index + 1 || !player(entry.player))
      fail('invalid-history-time', 'Turn history must record every real turn exactly once, without assuming alternation.');
  }
  if (clock.during !== null && history.turns.at(-1).player !== clock.during)
    fail('invalid-history-time', 'The evaluation player contradicts the actual current turn.');
  let previousTurn = 0, inCheckup = false;
  const owners = new Map(), knockedOut = new Set();
  const retainOwner = (id, owner) => {
    if (owners.has(id) && owners.get(id) !== owner)
      fail('invalid-history-identity', 'The same battle Pokémon identity cannot change its holder.');
    owners.set(id, owner);
  };
  for (const event of history.events) {
    assertEvent(event);
    if (event.turn > clock.turn ||
        event.during !== null && history.turns[event.turn - 1].player !== event.during ||
        event.turn === clock.turn && clock.during !== null && event.during === null)
      fail('invalid-history-time', 'Event is future, outside a recorded turn, or attributed to the wrong player.');
    if (event.turn < previousTurn || event.turn === previousTurn && inCheckup && event.during !== null)
      fail('invalid-history-order', 'History cannot rewind a turn or return from checkup into that same turn.');
    previousTurn = event.turn; inCheckup = event.during === null;
    if (!UNTARGETED.includes(event.kind)) {
      retainOwner(event.pokemonId, event.owner);
      if (knockedOut.has(event.pokemonId))
        fail('invalid-history-identity', 'An already Knocked Out Pokémon cannot produce new target facts under its retired identity.');
    }
    if (event.kind === 'ko') {
      const source = event.cause.source;
      if (source !== null && source.pokemonId !== null) retainOwner(source.pokemonId, source.owner);
      knockedOut.add(event.pokemonId);
    }
  }
  return history;
}

/** Immutable append at an actual start-turn boundary; consecutive players are valid. */
export function recordBattleTurn(history, entry) {
  assertJSON(history); assertJSON(entry);
  object(history, ['schemaVersion', 'turns', 'events']);
  if (!Array.isArray(history.turns)) fail('invalid-history-shape', 'Turn history must be an array.');
  assertBattleHistory(history, { turn: history.turns.length, during: null });
  object(entry, ['turn', 'player']);
  if (!turnNumber(entry.turn) || entry.turn !== history.turns.length + 1 || !player(entry.player))
    fail('invalid-history-time', 'Append exactly the next actual turn, with its real player.');
  const next = copy(history); next.turns.push(copy(entry));
  return assertBattleHistory(next, { turn: entry.turn, during: entry.player });
}

/** Immutable append of an observed event at this exact boundary, not a backfill. */
export function recordBattleEvent(history, event, clock) {
  assertBattleHistory(history, clock); assertJSON(event); assertEvent(event);
  if (event.turn !== clock.turn || event.during !== clock.during)
    fail('invalid-history-time', 'Only an event at the actual current boundary may be appended.');
  const next = copy(history); next.events.push(event.kind === 'ko' ? normalizeKnockoutEvent(event) : copy(event));
  return assertBattleHistory(next, clock);
}

function assertOwner(owner) {
  if (!player(owner)) fail('invalid-history-query', 'A history query requires an explicit player 0 or 1.');
}
function findPreviousOpponentTurn(history, owner) {
  for (let index = history.turns.length - 2; index >= 0; index--)
    if (history.turns[index].player !== owner) return history.turns[index];
  return null;
}

/** Latest opponent turn strictly before this turn, not turn-1. Detached record or null. */
export function previousOpponentTurn(history, clock, owner) {
  assertBattleHistory(history, clock); assertOwner(owner);
  const previous = findPreviousOpponentTurn(history, owner);
  return previous === null ? null : copy(previous);
}

/**
 * E-11 boolean (never a multiplier). Evaluate on owner's actual turn.
 * options: { owner, cause?:'any'|'attackDamage', attacker?:0|1 }.
 * attacker is meaningful only with cause:'attackDamage'; it refers to the
 * actual user's source.owner, not cardOwner or a copied content provider.
 */
export function hadKnockoutInPreviousOpponentTurn(history, clock, options) {
  assertBattleHistory(history, clock); assertJSON(options);
  object(options, ['owner'], ['cause', 'attacker'], 'invalid-history-query'); assertOwner(options.owner);
  const cause = options.cause ?? 'any';
  if (!['any', 'attackDamage'].includes(cause) ||
      Object.hasOwn(options, 'cause') && options.cause === null ||
      Object.hasOwn(options, 'attacker') && (!player(options.attacker) || cause !== 'attackDamage'))
    fail('invalid-history-query', 'Choose any KO or attack damage, optionally by an explicit actual attacking player.');
  if (clock.during !== options.owner) return false;
  const previous = findPreviousOpponentTurn(history, options.owner);
  return previous !== null && history.events.some((event) => event.kind === 'ko' &&
    event.turn === previous.turn && event.during === previous.player && event.owner === options.owner &&
    (cause === 'any' || event.cause.kind === 'attackDamage') &&
    (!Object.hasOwn(options, 'attacker') || event.cause.source?.owner === options.attacker));
}

/** The attacks the owner's Pokémon used in the owner's previous own turn, judged on the owner's turn. Detached records. */
export function attacksInPreviousOwnTurn(history, clock, owner) {
  assertBattleHistory(history, clock); assertOwner(owner);
  if (clock.during !== owner) return [];
  let previous = null;
  for (let index = history.turns.length - 2; index >= 0 && !previous; index--)
    if (history.turns[index].player === owner) previous = history.turns[index];
  return previous ? copy(history.events.filter((event) => event.kind === 'attackUsed' && event.turn === previous.turn && event.owner === owner)) : [];
}

/** E-11 with a printed kind of Pokémon: the owner's Knock Outs in the previous opponent turn, judged on the owner's turn. */
export function knockoutsInPreviousOpponentTurn(history, clock, owner) {
  assertBattleHistory(history, clock); assertOwner(owner);
  const previous = clock.during === owner ? findPreviousOpponentTurn(history, owner) : null;
  return previous ? copy(history.events.filter((event) => event.kind === 'ko' && event.turn === previous.turn &&
    event.during === previous.player && event.owner === owner)) : [];
}

function thisTurn(history, clock, owner, predicate) {
  assertBattleHistory(history, clock); assertOwner(owner);
  return clock.during === owner && history.events.some((event) =>
    event.turn === clock.turn && event.during === owner && event.owner === owner && predicate(event));
}
function assertPokemonId(pokemonId) {
  if (!text(pokemonId)) fail('invalid-history-query', 'Use the actual in-play Pokémon identity, not a missing/default target.');
}

/** E-24: repeated switches are one boolean fact, retained across Bench visits. */
export function wasMovedFromBenchToActiveThisTurn(history, clock, owner, pokemonId) {
  assertPokemonId(pokemonId);
  return thisTurn(history, clock, owner, (event) => event.kind === 'benchToActive' && event.pokemonId === pokemonId);
}

/**
 * E-25: action history, not the current Supporter limit flag or discard contents.
 * cardMatches optionally narrows to a printed kind of Supporter (the host reads the played card's identity).
 */
export function wasSupporterPlayedFromHandThisTurn(history, clock, owner, cardMatches = () => true) {
  return thisTurn(history, clock, owner, (event) => event.kind === 'supporterPlayed' && event.origin === 'hand' && cardMatches(event.cardId));
}

/**
 * 「在上一个对手的回合，这只宝可梦所受到的招式的伤害」: the attack damage pokemonId (owner's) took during the latest
 * opponent turn (activeOnly: only while in the Active Spot; checkup is not a turn).
 */
export function attackDamageInPreviousOpponentTurn(history, clock, owner, pokemonId, activeOnly = false) {
  assertPokemonId(pokemonId);
  const previous = previousOpponentTurn(history, clock, owner);
  return previous ? history.events.filter((event) => event.kind === 'attackDamage' && event.turn === previous.turn &&
    event.during === previous.player && event.owner === owner && event.pokemonId === pokemonId && (!activeOnly || event.active))
    .reduce((n, event) => n + event.damage, 0) : 0;
}
/** 「在上一个对手的回合，对手所拿取的奖赏卡张数」: Prize cards the opponent took during their latest turn. */
export function prizesTakenInPreviousOpponentTurn(history, clock, owner) {
  const previous = previousOpponentTurn(history, clock, owner);
  return previous ? history.events.filter((event) => event.kind === 'prizeTaken' && event.turn === previous.turn &&
    event.during === previous.player && event.owner === previous.player).length : 0;
}
/** 「在上一个对手的回合，如果对手的宝可梦使用了GX招式」. */
export function specialAttackInPreviousOpponentTurn(history, clock, owner, specialRule) {
  const previous = previousOpponentTurn(history, clock, owner);
  return !!previous && history.events.some((event) => event.kind === 'attackUsed' && event.turn === previous.turn &&
    event.owner === previous.player && event.specialRule === specialRule);
}

/** E-26: actual recovery >=10 HP; no board/counter inference and no stacking. */
export function wasHealedThisTurn(history, clock, owner, pokemonId) {
  assertPokemonId(pokemonId);
  return thisTurn(history, clock, owner, (event) => event.kind === 'heal' && event.pokemonId === pokemonId && event.amount >= 10);
}
