import { validateOngoingEffect, validatePlayerOngoingEffect } from './schema-validators.js';
import { assertFailureCoin } from './attack-failure.js';

export const ONGOING_RULE_IDS = Object.freeze(['effects.duration.turn-only', 'effects.duration.until-end', 'status.clear']);

/** This scheduler is CN-specific: turn-only effects do NOT cover checkup. */
function clock(source, duration, state) {
  const own = ['nextOwnTurn', 'untilNextOwnTurnEnd'].includes(duration);
  const untilEnd = ['untilNextOwnTurnEnd', 'untilNextOpponentTurnEnd'].includes(duration);
  const player = own ? source.owner : 1 - source.owner;
  return { deadline: { player, ownerTurn: state.players[player].turns + 1, boundary: untilEnd ? 'checkup-end' : 'turn-end' },
    ruleId: untilEnd ? 'effects.duration.until-end' : 'effects.duration.turn-only' };
}
export function createOngoingEffect({ id, targetId, source, effect, duration, clearOnBench, clearOnEvolution, ownedAttackLockId }, state) {
  const entry = { id, targetId, source: structuredClone(source), effect: structuredClone(effect), duration,
    clearOnBench, clearOnEvolution, ...clock(source, duration, state),
    ...(ownedAttackLockId === undefined ? {} : { ownedAttackLockId }) };
  assertOngoingEffect(entry, state);
  return entry;
}

export function assertOngoingEffect(entry, state) {
  if (!validateOngoingEffect(entry)) throw new TypeError('Invalid ongoing effect.');
  if (entry.effect.op === 'attackCheck') assertFailureCoin(entry.effect.coin);
  return assertClock(entry, state);
}
function assertClock(entry, state) {
  const own = ['nextOwnTurn', 'untilNextOwnTurnEnd'].includes(entry.duration);
  const untilEnd = ['untilNextOwnTurnEnd', 'untilNextOpponentTurnEnd'].includes(entry.duration);
  if (entry.deadline.player !== (own ? entry.source.owner : 1 - entry.source.owner) ||
      entry.deadline.boundary !== (untilEnd ? 'checkup-end' : 'turn-end') ||
      entry.ruleId !== (untilEnd ? 'effects.duration.until-end' : 'effects.duration.turn-only') ||
      entry.deadline.ownerTurn < state.players[entry.deadline.player].turns)
    throw new TypeError('Ongoing duration/deadline mismatch.');
  return entry;
}
export function createPlayerOngoingEffect({ id, player, source, effect, duration }, state) {
  const entry = { id, player, source: structuredClone(source), effect: structuredClone(effect), duration,
    ...clock(source, duration, state) };
  return assertPlayerOngoingEffect(entry, state);
}
export function assertPlayerOngoingEffect(entry, state) {
  if (!validatePlayerOngoingEffect(entry)) throw new TypeError('Invalid player ongoing effect.');
  return assertClock(entry, state);
}

export function ongoingIsActive(entry, state) {
  const { player, ownerTurn, boundary } = entry.deadline;
  if (boundary === 'checkup-end') return state.players[player].turns <= ownerTurn;
  return state.current === player && state.phase !== 'checkup' && state.players[player].turns === ownerTurn;
}

export function expireOngoing(effects, state, player, boundary) {
  if (![0, 1].includes(player) || !['turn-end', 'checkup-end'].includes(boundary))
    throw new TypeError('An explicit turn/checkup expiration boundary is required.');
  return effects.filter((entry) => !(entry.deadline.player === player && entry.deadline.boundary === boundary &&
    entry.deadline.ownerTurn <= state.players[player].turns));
}
