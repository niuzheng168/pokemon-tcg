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
    if (['optional', 'coin', 'coins', 'coinResult', 'when'].includes(a.op)) visit(a.effect);
    if (['coin', 'coinResult', 'when'].includes(a.op) && a.otherwise) visit(a.otherwise);
    if (a.op === 'orElse') { visit(a.first); visit(a.otherwise); }
    if (a.op === 'delayedReaction') assertEffectProgram(a.program, embeddedOperations);
  };
  program.forEach(visit);
  return program;
}

// 「与出现正面次数相同数量」: a coins instruction's single compiled leaf, written for one
// such flip, with its count (or quantity count) multiplied by how many flips showed it.
export function scaleEffect(coins, times) {
  const leaf = structuredClone(coins.effect.steps?.[0] ?? null);
  const holder = coins.apply.path === 'quantity' ? leaf?.quantity : leaf;
  if (coins.effect.op !== 'sequence' || coins.effect.steps.length !== 1 || !Number.isSafeInteger(holder?.count) ||
      !Number.isSafeInteger(times) || times < 1)
    throw new EffectProgramError('A scaled coin instruction needs one compiled leaf with a count and a positive number of flips.');
  holder.count *= times;
  return { op: 'sequence', steps: [leaf] };
}

export function assertEffectStep(step) {
  if (!validateEffectStep(step))
    throw new EffectProgramError('Invalid serializable effect resolution frame.', validateEffectStep.errors);
  return step;
}

export function beginEffectProgram(program) {
  return assertEffectStep({ action: { op: 'sequence', steps: structuredClone(program) }, frames: [] });
}

/**
 * `then` depends on some actual execution, NOT on complete execution or selecting a target.
 * `orElse` is its complement: the alternative runs only when the first branch was not performed.
 */
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
    if (frame.kind === 'orElse') {
      if (performed) continue;
      return { action: frame.otherwise, frames: [...frames, { kind: 'sequence', remaining: [], performed: false }] };
    }
    performed = frame.performed || performed;
    if (frame.remaining.length) {
      const [action, ...remaining] = frame.remaining;
      return { action, frames: [...frames, { kind: 'sequence', remaining, performed }] };
    }
  }
  return null;
}

/** Expand a control node without mutating the original/saved frame. Optional/coin nodes need a choice or flip. */
export function expandEffectStep(step) {
  assertEffectStep(step);
  const { action: a, frames } = structuredClone(step);
  if (a.op === 'sequence') {
    if (!a.steps.length) return completeEffectStep(step, false);
    const [action, ...remaining] = a.steps;
    return { action, frames: [...frames, { kind: 'sequence', remaining, performed: false }] };
  }
  if (a.op === 'then') return { action: a.first, frames: [...frames, { kind: 'then', next: a.next }] };
  if (a.op === 'orElse') return { action: a.first, frames: [...frames, { kind: 'orElse', otherwise: a.otherwise }] };
  return { action: a, frames };
}
