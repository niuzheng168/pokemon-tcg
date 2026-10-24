import { validateOngoingEffect, validatePlayerOngoingEffect } from './schema-validators.js';
import { assertFailureCoin } from './attack-failure.js';

export const ONGOING_RULE_IDS = Object.freeze(['effects.duration.turn-only', 'effects.duration.until-end', 'effects.duration.this-turn', 'effects.duration.game',
  'effects.duration.leave-active', 'effects.duration.leave-play', 'status.clear', 'effects.clear-attack-effects']);

/** This scheduler is CN-specific: turn-only effects do NOT cover checkup. */
function clock(source, duration, state) {
  // 「在这场对战结束前」: a player effect with no expiry.
  if (duration === 'game')
    return { deadline: { player: source.owner, ownerTurn: state.players[source.owner].turns, boundary: 'game' }, ruleId: 'effects.duration.game' };
  // 「在离开战斗场之前」: no turn limit; only leaving the Active Spot (clearOnBench), play, or the stack ends it (II.C-15).
  if (duration === 'untilLeavesActive')
    return { deadline: { player: source.owner, ownerTurn: state.players[source.owner].turns, boundary: 'game' }, ruleId: 'effects.duration.leave-active' };
  // 「在离开场上之前」: no turn limit; only leaving play ends it (a granted Ability, ability.granted).
  if (duration === 'untilLeavesPlay')
    return { deadline: { player: source.owner, ownerTurn: state.players[source.owner].turns, boundary: 'game' }, ruleId: 'effects.duration.leave-play' };
  // 「在这个回合」: the user's own current turn, ending before its checkup (II.E-20).
  if (duration === 'thisTurn') {
    if (state.current !== source.owner) throw new TypeError('A this-turn effect starts on its user\'s own turn.');
    return { deadline: { player: source.owner, ownerTurn: state.players[source.owner].turns, boundary: 'turn-end' },
      ruleId: 'effects.duration.this-turn' };
  }
  const own = ['nextOwnTurn', 'untilNextOwnTurnEnd'].includes(duration);
  const untilEnd = ['untilNextOwnTurnEnd', 'untilNextOpponentTurnEnd'].includes(duration);
  const player = own ? source.owner : 1 - source.owner;
  return { deadline: { player, ownerTurn: state.players[player].turns + 1, boundary: untilEnd ? 'checkup-end' : 'turn-end' },
    ruleId: untilEnd ? 'effects.duration.until-end' : 'effects.duration.turn-only' };
}
export function createOngoingEffect({ id, targetId, source, effect, duration, clearOnBench, clearOnEvolution, ownedAttackLockId, knockedOutBy, clearOnLeaveActive }, state) {
  const entry = { id, targetId, source: structuredClone(source), effect: structuredClone(effect), duration,
    clearOnBench, clearOnEvolution, ...clock(source, duration, state),
    ...(ownedAttackLockId === undefined ? {} : { ownedAttackLockId }), ...(knockedOutBy === undefined ? {} : { knockedOutBy: structuredClone(knockedOutBy) }),
    ...(clearOnLeaveActive ? { clearOnLeaveActive } : {}) };
  assertOngoingEffect(entry, state);
  return entry;
}

export function assertOngoingEffect(entry, state) {
  if (!validateOngoingEffect(entry)) throw new TypeError('Invalid ongoing effect.');
  if (entry.effect.op === 'attackCheck') assertFailureCoin(entry.effect.coin);
  return assertClock(entry, state);
}
const UNLIMITED = Object.freeze({ game: 'effects.duration.game', untilLeavesActive: 'effects.duration.leave-active',
  untilLeavesPlay: 'effects.duration.leave-play' });
function assertClock(entry, state) {
  if (Object.hasOwn(UNLIMITED, entry.duration) || entry.deadline.boundary === 'game') {
    if (entry.deadline.boundary !== 'game' || entry.deadline.player !== entry.source.owner || entry.ruleId !== UNLIMITED[entry.duration])
      throw new TypeError('Ongoing duration/deadline mismatch.');
    return entry;
  }
  if (entry.duration === 'thisTurn') {
    if (entry.deadline.player !== entry.source.owner || entry.deadline.boundary !== 'turn-end' ||
        entry.ruleId !== 'effects.duration.this-turn' || entry.deadline.ownerTurn < state.players[entry.deadline.player].turns)
      throw new TypeError('Ongoing duration/deadline mismatch.');
    return entry;
  }
  const own = ['nextOwnTurn', 'untilNextOwnTurnEnd'].includes(entry.duration);
  const untilEnd = ['untilNextOwnTurnEnd', 'untilNextOpponentTurnEnd'].includes(entry.duration);
  if (entry.deadline.player !== (own ? entry.source.owner : 1 - entry.source.owner) ||
      entry.deadline.boundary !== (untilEnd ? 'checkup-end' : 'turn-end') ||
      entry.ruleId !== (untilEnd ? 'effects.duration.until-end' : 'effects.duration.turn-only') ||
      entry.deadline.ownerTurn < state.players[entry.deadline.player].turns)
    throw new TypeError('Ongoing duration/deadline mismatch.');
  return entry;
}
export function createPlayerOngoingEffect({ id, player, source, effect, duration, clearOnLeaveActive, exemptId, exemptIds }, state) {
  const entry = { id, player, source: structuredClone(source), effect: structuredClone(effect), duration,
    ...clock(source, duration, state), ...(clearOnLeaveActive ? { clearOnLeaveActive } : {}), ...(exemptId ? { exemptId } : {}),
    ...(exemptIds ? { exemptIds: [...exemptIds] } : {}) };
  return assertPlayerOngoingEffect(entry, state);
}
export function assertPlayerOngoingEffect(entry, state) {
  if (!validatePlayerOngoingEffect(entry)) throw new TypeError('Invalid player ongoing effect.');
  return assertClock(entry, state);
}

// A player effect about Pokémon (「自己所有的宝可梦…」「对手的宝可梦…」) covers the Pokémon of its scope, relative to its user; every other
// player effect is on the player it names (the locked player, the player taking more Prizes or flipping, …).
export const PLAYER_POKEMON_OPS = Object.freeze(['modifier', 'attackDamageOptions', 'restriction', 'protection', 'energyRequirement']);
// effects.clear-attack-effects 「这张卡牌的持有者，以及自己所有宝可梦身上招式的效果，全部消除」: the effects of attacks (either player's) on a
// player and on that player's Pokémon in play, in force now or later; Special Conditions and damage counters are no such effects (II.C-03).
export function attackEffectsOn(state, player) {
  const p = state.players[player], mons = new Set([p.active, ...p.bench].filter(Boolean).map((m) => m.id));
  const covers = (e) => PLAYER_POKEMON_OPS.includes(e.effect.op) ? (e.effect.scope === 'own') === (e.source.owner === player) : e.player === player;
  return [...state.ongoing.filter((e) => mons.has(e.targetId)), ...state.playerOngoing.filter(covers)]
    .filter((e) => e.source.category === 'attack').map((e) => e.id);
}

export function ongoingIsActive(entry, state) {
  const { player, ownerTurn, boundary } = entry.deadline;
  if (boundary === 'game') return true;
  if (boundary === 'checkup-end') return state.players[player].turns <= ownerTurn;
  return state.current === player && state.phase !== 'checkup' && state.players[player].turns === ownerTurn;
}

export function expireOngoing(effects, state, player, boundary) {
  if (![0, 1].includes(player) || !['turn-end', 'checkup-end'].includes(boundary))
    throw new TypeError('An explicit turn/checkup expiration boundary is required.');
  return effects.filter((entry) => !(entry.deadline.player === player && entry.deadline.boundary === boundary &&
    entry.deadline.ownerTurn <= state.players[player].turns));
}
