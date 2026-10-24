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
    if (a.op === 'then' || a.op === 'thenMoved') { visit(a.first); visit(a.next); }
    if (a.op === 'thenMoved' && a.ifMoved) visit(a.ifMoved);
    if (a.op === 'bound') visit(a.effect);
    if (['optional', 'coin', 'coins', 'coinResult', 'when', 'ifPaid', 'ifMoved'].includes(a.op)) visit(a.effect);
    if (a.op === 'janken' && a.effect) visit(a.effect);
    if (a.op === 'guess') { visit(a.effect); visit(a.otherwise); }
    if (['coin', 'coinResult', 'when', 'ifPaid'].includes(a.op) && a.otherwise) visit(a.otherwise);
    if (a.op === 'orElse') { visit(a.first); visit(a.otherwise); }
    if (a.op === 'delayedReaction') assertEffectProgram(a.program, embeddedOperations);
    if (a.op === 'choose') a.options.forEach((option) => visit(option.effect));
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

// 「其张数」「与其相同张数」「其中的…」: the next instruction of a thenMoved, bound to the cards its first part actually moved.
// A count is written for one such card and multiplied; a card move or attachment takes only those cards.
export function bindMovedEffect(frame, moved) {
  const next = bindMovedNext(frame, moved);
  // 「如果被放于弃牌区的卡牌是能量的话，则再抽取2张卡牌」: after the next part, the kind of a moved card decides one more step.
  return frame.ifMoved ? { op: 'sequence', steps: [next, { ...structuredClone(frame.ifMoved), among: [...moved] }] } : next;
}
function bindMovedNext(frame, moved) {
  // 「如果追加附有1个能量的话，则…」: a printed condition around the next part binds the leaf inside it.
  const leaf = structuredClone(frame.next), inner = leaf.op === 'when' ? leaf.effect : leaf;
  // 「该宝可梦」「被附着能量的宝可梦」「回复了HP的宝可梦」: the next part acts only on the Pokémon the first part affected.
  if (frame.use === 'pokemon') {
    const bound = { op: 'bound', pokemon: [...moved], ...(frame.origin ? { origin: true } : {}), effect: leaf };
    return frame.optional ? { op: 'optional', effect: bound } : bound;
  }
  // 「当成功把卡牌放于备战区时，（若希望，可）…」: the next part only needed a moved card; it is not bound to them.
  if (frame.use === 'none') return frame.optional ? { op: 'optional', effect: leaf } : leaf;
  if (frame.use === 'cards') {
    if (inner.among !== 'moved') throw new EffectProgramError('A moved-card instruction needs its unbound moved-card pool.');
    inner.among = [...moved];
    return leaf;
  }
  const holder = frame.path === 'quantity' ? inner.quantity : inner;
  if (!Number.isSafeInteger(holder?.count)) throw new EffectProgramError('A moved-card count needs one compiled leaf with a count.');
  holder.count *= moved.length;
  return leaf;
}
// The thenMoved this step's completion reaches ('count', 'cards' or 'pokemon'), whose first part must report what it moved.
export function completionMovedUse(step) {
  assertEffectStep(step);
  for (let i = step.frames.length - 1; i >= 0; i--) {
    const frame = step.frames[i];
    if (frame.kind === 'thenMoved') return frame.use;
    if (frame.kind === 'bound') continue;
    if (frame.kind !== 'sequence' || frame.remaining.length) return null;
  }
  return null;
}
export const completionNeedsMoved = (step) => completionMovedUse(step) !== null;

/**
 * `then` depends on some actual execution, NOT on complete execution or selecting a target.
 * `orElse` is its complement: the alternative runs only when the first branch was not performed.
 * `thenMoved` also needs at least one card actually moved, and binds the next part to those cards.
 */
export function completeEffectStep(step, performed, moved = null) {
  assertEffectStep(step);
  if (typeof performed !== 'boolean') throw new EffectProgramError('An effect result must be an explicit performed boolean.');
  if (completionNeedsMoved(step) !== (moved !== null) ||
      moved !== null && (!Array.isArray(moved) || moved.some((id) => typeof id !== 'string' || !id) || new Set(moved).size !== moved.length))
    throw new EffectProgramError('Only the first part of a thenMoved reports the distinct cards it actually moved.');
  const frames = structuredClone(step.frames);
  while (frames.length) {
    const frame = frames.pop();
    if (frame.kind === 'then') {
      if (!performed) continue;
      return { action: frame.next, frames: [...frames, { kind: 'sequence', remaining: [], performed: true }] };
    }
    if (frame.kind === 'thenMoved') {
      if (!performed || !moved.length) continue;
      return { action: bindMovedEffect(frame, moved), frames: [...frames, { kind: 'sequence', remaining: [], performed: true }] };
    }
    if (frame.kind === 'bound') continue;
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
  if (a.op === 'thenMoved') return { action: a.first, frames: [...frames, { kind: 'thenMoved', next: a.next, use: a.use,
    ...(a.use === 'count' ? { path: a.path } : {}), ...(a.optional ? { optional: true } : {}), ...(a.origin ? { origin: true } : {}),
    ...(a.ifMoved ? { ifMoved: a.ifMoved } : {}) }] };
  if (a.op === 'orElse') return { action: a.first, frames: [...frames, { kind: 'orElse', otherwise: a.otherwise }] };
  if (a.op === 'bound') return { action: a.effect, frames: [...frames, { kind: 'bound', pokemon: a.pokemon, ...(a.origin ? { origin: true } : {}) }] };
  return { action: a, frames };
}
