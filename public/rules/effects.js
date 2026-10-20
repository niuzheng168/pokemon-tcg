import { validateEffectProgram, validateEffectStep } from './schema-validators.js';

export const EFFECT_RULE_IDS = Object.freeze(['effects.partial', 'selection.optional', 'effects.protection', 'damage.counters']);

export class EffectProgramError extends TypeError {
  constructor(message, errors = []) {
    super(message); this.name = 'EffectProgramError'; this.errors = structuredClone(errors);
  }
}

/** Validate even branches that will not run. Data must never smuggle undeclared operations. */
export function assertEffectProgram(program, operations, embeddedOperations = []) {
  if (!validateEffectProgram(program))
    throw new EffectProgramError('No silent fallback for effect/parameters.', validateEffectProgram.errors);
  const visit = (a) => {
    if (!operations.includes(a.op)) throw new EffectProgramError(`Undeclared effect operation: ${a.op}`);
    if (a.op === 'healPokemon' && a.discardHealedEnergy && !operations.includes('discardEnergy'))
      throw new EffectProgramError('Healing with a correlated Energy discard must declare the discardEnergy operation.');
    if (a.op === 'sequence') a.steps.forEach(visit);
    if (a.op === 'then') { visit(a.first); visit(a.next); }
    if (a.op === 'optional') visit(a.effect);
    if (a.op === 'delayedReaction') assertEffectProgram(a.program, embeddedOperations);
  };
  program.forEach(visit);
  return program;
}

export function assertEffectStep(step) {
  if (!validateEffectStep(step))
    throw new EffectProgramError('Invalid serializable effect resolution frame.', validateEffectStep.errors);
  return step;
}

export function beginEffectProgram(program) {
  return assertEffectStep({ action: { op: 'sequence', steps: structuredClone(program) }, frames: [] });
}

/** `then` depends on some actual execution, NOT on complete execution or selecting a target. */
export function completeEffectStep(step, performed) {
  assertEffectStep(step);
  if (typeof performed !== 'boolean') throw new EffectProgramError('An effect result must be an explicit performed boolean.');
  const frames = structuredClone(step.frames);
  while (frames.length) {
    const frame = frames.pop();
    if (frame.kind === 'then') {
      if (!performed) continue;
      return { action: frame.next, frames: [...frames, { kind: 'sequence', remaining: [], performed: true }] };
    }
    performed = frame.performed || performed;
    if (frame.remaining.length) {
      const [action, ...remaining] = frame.remaining;
      return { action, frames: [...frames, { kind: 'sequence', remaining, performed }] };
    }
  }
  return null;
}

/** Expand a control node without mutating the original/saved frame. Optional nodes need a player choice. */
export function expandEffectStep(step) {
  assertEffectStep(step);
  const { action: a, frames } = structuredClone(step);
  if (a.op === 'sequence') {
    if (!a.steps.length) return completeEffectStep(step, false);
    const [action, ...remaining] = a.steps;
    return { action, frames: [...frames, { kind: 'sequence', remaining, performed: false }] };
  }
  if (a.op === 'then') return { action: a.first, frames: [...frames, { kind: 'then', next: a.next }] };
  return { action: a, frames };
}
