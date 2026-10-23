import { validateTriggerDescriptor, validateTriggerEvent } from './schema-validators.js';

export const TRIGGER_RULE_IDS = Object.freeze([
  'trigger.damage', 'trigger.knockout', 'trigger.evolve', 'trigger.bench',
  'trigger.energy', 'energy.move', 'trigger.checkup', 'trigger.turn-end', 'trigger.became-active',
]);
export const triggerRuleId = (kind) => ({
  attackDamage: 'trigger.damage', knockout: 'trigger.knockout', evolve: 'trigger.evolve',
  bench: 'trigger.bench', energyAttached: 'trigger.energy', energyMoved: 'energy.move', checkup: 'trigger.checkup', turnEnd: 'trigger.turn-end',
  becameActive: 'trigger.became-active',
})[kind];
export class TriggerError extends TypeError {
  constructor(code, message) { super(message); this.name = 'TriggerError'; this.code = code; }
}

export function triggerMatches(trigger, event, source, { sourceActive, definition }) {
  if (!validateTriggerDescriptor(trigger) || !validateTriggerEvent(event))
    throw new TriggerError('invalid-trigger', 'Invalid trigger descriptor/event.');
  if (trigger.event !== event.kind && !(trigger.event === 'energyAttached' && trigger.includeTransfers && event.kind === 'energyMoved') ||
      event.kind === 'attackDamage' && event.damage < 10) return false;
  if ((trigger.subject === 'self' && source.pokemonId !== event.subjectId) ||
      (trigger.subject === 'own' && source.owner !== event.owner) ||
      (trigger.subject === 'opponent' && source.owner === event.owner)) return false;
  if (trigger.origin && trigger.origin !== 'any' && trigger.origin !== event.origin) return false;
  if (trigger.cardIsSource && source.instanceId !== event.cardId) return false;
  if ((trigger.turn === 'own' && event.during !== source.owner) ||
      (trigger.turn === 'opponent' && event.during !== 1 - source.owner)) return false;
  if ((trigger.endingPlayer === 'own' && event.endingPlayer !== source.owner) ||
      (trigger.endingPlayer === 'opponent' && event.endingPlayer !== 1 - source.owner)) return false;
  if (trigger.activeOnly && !event.wasActive || trigger.sourceActive && !sourceActive) return false;
  if (trigger.cause && trigger.cause !== 'any' &&
      (event.cause.kind !== 'attackDamage' || (trigger.cause === 'opponentAttackDamage' && event.cause.source?.owner !== 1 - event.owner))) return false;
  if (trigger.subjectTypes && !trigger.subjectTypes.some((t) => event.effectiveTypes.includes(t))) return false;
  if (Object.hasOwn(trigger, 'subjectRuleBox') && trigger.subjectRuleBox !== definition.mechanics.ruleBox) return false;
  return !Object.hasOwn(trigger, 'rotation') || trigger.rotation === event.snapshot.conditions.rotation;
}

/** Subject-local lanes may commute across holders; arbitrary global effects may not. */
export function assertOwnerIndependence(units) {
  if (new Set(units.map((u) => u.owner)).size > 1 && units.some((u) => u.trigger.scope !== 'subject'))
    throw new TriggerError('unresolved-cross-owner-timing',
      'Cross-owner global trigger interaction needs a sourced CN ordering ruling, not an imported current-player priority.');
}

/** Local programs cannot read the other lane (their context has no whole board), or write outside their subject. */
export function assertSubjectProgram(program, event, source) {
  const visit = (a) => {
    if (a.op === 'sequence') return a.steps.forEach(visit);
    if (a.op === 'then') { visit(a.first); visit(a.next); return; }
    if (a.op === 'optional') { visit(a.effect); return; }
    if (!['counters', 'heal', 'condition', 'lasting', 'delayedReaction', 'knockOut'].includes(a.op) || a.target !== 'event' ||
        (a.side === 'opponent' ? 1 - source.owner : source.owner) !== event.owner ||
        a.op === 'lasting' && a.effect.op === 'pokemonTypes')
      throw new TriggerError('nonlocal-trigger-program', 'A subject-local trigger cannot affect another Pokémon/player.');
  };
  program.forEach(visit);
}
