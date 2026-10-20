/**
 * CN/V20261019 II.A p19 / II.E-19 p62–63: deterministic partial/then
 * execution. This PRIVATE journal is a software protocol, not card approval,
 * catalog/source authorization or cryptographic authentication.
 *
 * Host anchors scheduled/opened contexts and handler output to its catalog,
 * enforces unique identities, and compares replayed action/frames to state.
 * This module only validates plain data and walks the existing effect machine;
 * it never performs effects, moves cards, consumes RNG or authenticates a host.
 */
import { validateEffectExecutionEvent } from './schema-validators.js';
import {
  assertEffectProgram, assertEffectStep, beginEffectProgram, expandEffectStep, completeEffectStep,
} from './effects.js';

export const EFFECT_EXECUTION_RULE_IDS = Object.freeze(['effects.execution']);
export const EFFECT_EXECUTION_SOURCES = Object.freeze([
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.A', pdfPages: Object.freeze([19]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.E-19', pdfPages: Object.freeze([62, 63]) }),
]);

export class EffectExecutionError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'EffectExecutionError'; this.code = code; this.ruleId = 'effects.execution';
  }
}
const fail = (code, message) => { throw new EffectExecutionError(code, message); };
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value) => typeof value === 'string' && value.length > 0;
const natural = (value) => Number.isSafeInteger(value) && value >= 0;

function array(value, code) {
  if (Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1)
    fail(code, 'Execution arrays must be ordinary dense JSON without extra fields.');
  for (let i = 0; i < value.length; i++) {
    const p = Object.getOwnPropertyDescriptor(value, String(i));
    if (!p || !p.enumerable || !Object.hasOwn(p, 'value'))
      fail(code, 'Execution arrays cannot contain holes, hidden items or accessors.');
  }
  return value;
}

// Descriptor-based copying never invokes getters/toJSON, including in skipped
// branches or opaque binding parameters. Null-prototype copies prevent inherited
// schema defaults; aliases are legal JSON trees, ancestor cycles are not.
function data(value, code, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || (!Array.isArray(value) && !plain(value)) || ancestors.has(value))
    fail(code, 'Execution descriptions require finite, acyclic plain JSON.');
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    const items = array(value, code);
    result = [];
    for (let i = 0; i < items.length; i++)
      result.push(data(Object.getOwnPropertyDescriptor(items, String(i)).value, code, ancestors));
  } else {
    result = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      const p = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !p.enumerable || !Object.hasOwn(p, 'value'))
        fail(code, 'Execution JSON fields must be enumerable own string data.');
      result[key] = data(p.value, code, ancestors);
    }
  }
  ancestors.delete(value);
  return result;
}

function eventData(event) {
  const copy = data(event, 'invalid-execution-event');
  if (!validateEffectExecutionEvent(copy))
    fail('invalid-execution-event', 'Invalid private scheduled/opened/advance execution event.');
  return copy.data;
}

/** Shape only: scheduled is accepted here, but cannot start/replay a program. */
export function assertEffectExecutionEvent(event) {
  eventData(event);
  return event;
}

function operationsList(operations) {
  const copy = data(operations, 'invalid-execution-operations');
  if (!Array.isArray(copy) || copy.some((op) => !text(op)))
    fail('invalid-execution-operations', 'Declare operations as a dense array of nonempty strings.');
  return copy;
}

/** Validate EVERY static branch, including embedded effects and discard flags. */
export function beginEffectExecution(openEvent, operations, embeddedOperations = []) {
  const opened = eventData(openEvent);
  if (opened.kind !== 'opened')
    fail('invalid-execution-transition', 'Only an opened event can begin an effect program.');
  const declared = operationsList(operations), embedded = operationsList(embeddedOperations);
  assertEffectProgram(opened.program, declared, embedded);
  return { id: opened.id, step: beginEffectProgram(opened.program), index: 0 };
}

function cursorData(cursor) {
  const copy = data(cursor, 'invalid-execution-cursor');
  if (!plain(copy) || Object.keys(copy).length !== 3 ||
      !['id', 'step', 'index'].every((key) => Object.hasOwn(copy, key)) ||
      !text(copy.id) || !natural(copy.index))
    fail('invalid-execution-cursor', 'A cursor requires exactly id, step and a safe nonnegative index.');
  if (copy.step !== null) assertEffectStep(copy.step);
  return copy;
}

/** One exact transition. Untrusted saved cursors must be compared with replay. */
export function advanceEffectExecution(cursor, event) {
  const current = cursorData(cursor), next = eventData(event);
  if (next.kind !== 'advance' || next.id !== current.id || next.index !== current.index ||
      current.step === null || current.index === Number.MAX_SAFE_INTEGER)
    fail('invalid-execution-transition', 'Advance requires the same live program and exact next safe index.');
  const { action, frames } = current.step;
  const control = ['sequence', 'then', 'orElse'].includes(action.op), gated = ['optional', 'coin'].includes(action.op);
  let step;
  if (next.mode === 'expand') {
    if (!control) fail('invalid-execution-transition', 'Only sequence/then/orElse nodes can expand.');
    step = expandEffectStep(current.step);
  } else if (next.mode === 'optional') {
    // A player's optional acceptance or the printed coin result opens the nested instruction.
    if (!gated) fail('invalid-execution-transition', 'Only optional/coin nodes can be accepted.');
    step = structuredClone({ action: action.effect, frames });
  } else {
    if (control || gated && next.performed)
      fail('invalid-execution-transition', 'Control nodes must expand; optional/coin completion can only decline.');
    step = completeEffectStep(current.step, next.performed);
  }
  return { id: current.id, step, index: current.index + 1 };
}

/** Ordered replay consumes no actual game/RNG facts and never repairs history. */
export function replayEffectExecution(openEvent, advanceEvents, operations, embeddedOperations = []) {
  let cursor = beginEffectExecution(openEvent, operations, embeddedOperations);
  const events = data(advanceEvents, 'invalid-execution-events');
  if (!Array.isArray(events))
    fail('invalid-execution-events', 'Replay requires an ordered dense array of advance events.');
  for (const event of events) cursor = advanceEffectExecution(cursor, event);
  return cursor;
}
