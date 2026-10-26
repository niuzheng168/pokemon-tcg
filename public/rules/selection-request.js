/**
 * CN II.A p19 / II.D-04 p43–44 / I.H p18 / II.E-33–34 p73 ground
 * selection/hidden-information semantics, NOT an officially mandated log.
 * This is a private software restoration/projection receipt, not a game action,
 * card approval, source/choice authorization or cryptographic authentication.
 *
 * Host seals after drain/revision update, binds each unique request ID to its
 * exact request+paused-work, and rejects missing/duplicate/substituted receipts.
 * Historical receipts are not compared to CURRENT work. This module only
 * checks data; it does not include events/players or recursively contain itself.
 * The conservative privacy detector recognizes structure, not arbitrary private
 * information re-encoded as strings, different keys, bytes or other semantics.
 */
import { validateSelectionRequestEvent } from './schema-validators.js';
import { checking } from './trust.js';
import { cloneValue } from './registry.js';

export const SELECTION_REQUEST_RULE_IDS = Object.freeze(['selection.request']);
export const SELECTION_REQUEST_SOURCES = Object.freeze([
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.A', pdfPages: Object.freeze([19]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.D-04', pdfPages: Object.freeze([43, 44]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'I.H', pdfPages: Object.freeze([18]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.E-33', pdfPages: Object.freeze([73]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.E-34', pdfPages: Object.freeze([73]) }),
]);

export class SelectionRequestError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'SelectionRequestError'; this.code = 'invalid-selection-request'; this.ruleId = 'selection.request';
  }
}
const fail = (message) => { throw new SelectionRequestError(message); };
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

function array(value) {
  if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1)
    fail('Request arrays must be ordinary dense JSON without extra fields.');
  for (let i = 0; i < value.length; i++) {
    const p = Object.getOwnPropertyDescriptor(value, String(i));
    if (!p || !p.enumerable || !Object.hasOwn(p, 'value'))
      fail('Request arrays cannot contain holes, hidden items or accessors.');
  }
  return value;
}

// Descriptor copying does not invoke getters/toJSON or inherited defaults.
// Null-prototype internal copies isolate downstream validators from prototypes.
// Aliased subtrees are legal; ancestor cycles and executable/hidden JSON are not.
function data(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || (!Array.isArray(value) && !plain(value)) || ancestors.has(value))
    fail('Requests require finite, acyclic plain JSON descriptions.');
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    const items = array(value);
    result = [];
    for (let i = 0; i < items.length; i++)
      result.push(data(Object.getOwnPropertyDescriptor(items, String(i)).value, ancestors));
  } else {
    result = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      const p = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !p.enumerable || !Object.hasOwn(p, 'value'))
        fail('Request fields must be enumerable own string data.');
      result[key] = data(p.value, ancestors);
    }
  }
  ancestors.delete(value);
  return result;
}

/** Strict shape only; full pending/typed-resume rules come from GameState. */
export function assertSelectionRequestEvent(event) {
  const copy = data(event);
  if (!validateSelectionRequestEvent(copy))
    fail('Expected one exact private requested receipt containing complete non-null pending and paused work.');
  return event;
}

/** Detached complete receipt; no live request is frozen, moved or modified. */
export function selectionRequestEvent(request, work) {
  const event = {
    ruleId: 'selection.request', visibility: 'private',
    data: { kind: 'requested', request: cloneValue(checking() ? data(request) : request), work: cloneValue(checking() ? data(work) : work) },
  };
  assertSelectionRequestEvent(event);
  return event;
}

// Walk ONLY the already descriptor-checked detached JSON. Object property
// descriptors, never member access on the caller's object, supply child values.
function containsRequest(value) {
  if (value === null || typeof value !== 'object') return false;
  if (['resume', 'options', 'data'].every((key) => Object.hasOwn(value, key))) return true;
  if (['queue', 'attack', 'serial', 'revision'].every((key) => Object.hasOwn(value, key))) return true;
  for (const key of Object.keys(value)) {
    if (containsRequest(Object.getOwnPropertyDescriptor(value, key).value)) return true;
  }
  return false;
}

/**
 * Privacy-conservative structure test, NOT a receipt validator/authenticator.
 * Labels/visibility are irrelevant. Malformed/executable/nonplain/cyclic input
 * is conservatively private, including reflection failures on revoked proxies.
 * Normal JSON without either own-key signature (resume/options/data or
 * queue/attack/serial/revision) returns false.
 */
export function hasSelectionRequestPayload(value) {
  try { return containsRequest(data(value)); }
  catch { return true; }
}
