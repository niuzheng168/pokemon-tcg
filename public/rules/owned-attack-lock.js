/**
 * CN advanced II.C-15 p36 / II.C-17 p38 / II.D-04 p43 /
 * II.D-06 p44–45 / II.E-37 p74–75: choose ONE attack owned by the
 * opponent's current Active, not an extra attack it is permitted to use.
 *
 * Pure window/selection plan only. Read the actual source user, public Active
 * stack/top physical card and its printed attack IDs; never query Energy,
 * legality, used quotas, effective traits, grants, protection or hidden zones.
 * This is not a whole-state/catalog approval, authorization, ongoing ledger,
 * expiry/name-matching policy, move or RNG operation. Host authenticates the
 * original window, supplies blocked and commits any resulting restriction.
 */
export const OWNED_ATTACK_LOCK_RULE_IDS = Object.freeze([
  'effects.pokemon-lock', 'attack.owned', 'selection.exact',
]);
export const OWNED_ATTACK_LOCK_SOURCES = Object.freeze([
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.C-15', pdfPages: Object.freeze([36]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.C-17', pdfPages: Object.freeze([38]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.D-04', pdfPages: Object.freeze([43]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.D-06', pdfPages: Object.freeze([44, 45]) }),
  Object.freeze({ documentId: 'CN-advanced-3.1.0', section: 'II.E-37', pdfPages: Object.freeze([74, 75]) }),
]);
const ACTION = 'invalid-owned-attack-lock-action';
const CONTEXT = 'invalid-owned-attack-lock-context';
const SELECTION = 'invalid-owned-attack-lock-selection';
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value) => typeof value === 'string' && value.length > 0;

export class OwnedAttackLockError extends TypeError {
  constructor(code, message) {
    super(message); this.name = 'OwnedAttackLockError'; this.code = code;
  }
}
const fail = (code, message) => { throw new OwnedAttackLockError(code, message); };

function array(value, code) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1)
    fail(code, 'Owned-attack arrays must be ordinary dense JSON without extra fields.');
  for (let i = 0; i < value.length; i++) {
    const p = Object.getOwnPropertyDescriptor(value, String(i));
    if (!p || !p.enumerable || !Object.hasOwn(p, 'value'))
      fail(code, 'Owned-attack arrays cannot contain holes, hidden items or accessors.');
  }
  return value;
}
function data(value, code, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || (!Array.isArray(value) && !plain(value)) || ancestors.has(value))
    fail(code, 'Owned-attack descriptions require finite, acyclic plain JSON.');
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
        fail(code, 'Owned-attack JSON fields must be enumerable own string data.');
      result[key] = data(p.value, code, ancestors);
    }
  }
  ancestors.delete(value);
  return result;
}
function record(value, keys, code) {
  if (!plain(value) || keys.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !keys.includes(key)))
    fail(code, 'Owned-attack records require exactly their declared own fields.');
}
function field(value, key) {
  if (!plain(value)) fail(CONTEXT, 'Requested owned-attack context records must be plain data.');
  const p = Object.getOwnPropertyDescriptor(value, key);
  if (!p || !p.enumerable || !Object.hasOwn(p, 'value'))
    fail(CONTEXT, 'Requested owned-attack values cannot be missing, inherited, hidden or executable.');
  return p.value;
}

/** Exact six-field action. No caller-supplied attack IDs, targets or defaults. */
export function assertOwnedAttackLockAction(action) {
  const a = data(action, ACTION);
  record(a, ['op', 'side', 'target', 'duration', 'clearOnBench', 'clearOnEvolution'], ACTION);
  if (a.op !== 'disableOwnedAttack' || a.side !== 'opponent' || a.target !== 'active' ||
      a.duration !== 'nextOpponentTurn' || a.clearOnBench !== true || a.clearOnEvolution !== true)
    fail(ACTION, 'Use the fixed opponent-Active, next-opponent-turn owned-attack lock action.');
  return action;
}

/** Ownership is printed membership, NOT current declaration legality. */
export function ownedAttackLockWindow(ctx, action) {
  assertOwnedAttackLockAction(action);
  const sourceOwner = field(field(ctx, 'source'), 'owner');
  if (sourceOwner !== 0 && sourceOwner !== 1)
    fail(CONTEXT, 'Use the actual source user, not current player or physical source holder.');
  const owner = 1 - sourceOwner, state = field(ctx, 'state');
  const players = array(field(state, 'players'), CONTEXT);
  if (players.length !== 2) fail(CONTEXT, 'An owned-attack window needs exactly two players.');
  const active = field(Object.getOwnPropertyDescriptor(players, String(owner)).value, 'active');
  if (active === null) return { owner, target: null, candidates: [] };
  const pokemonId = field(active, 'id'), stack = data(field(active, 'stack'), CONTEXT);
  array(stack, CONTEXT);
  if (!text(pokemonId) || !stack.length || stack.some((id) => !text(id)) || new Set(stack).size !== stack.length)
    fail(CONTEXT, 'An Active target needs an actual Pokemon ID and nonempty unique physical stack IDs.');
  const topCardId = stack.at(-1), card = field(field(state, 'cards'), topCardId);
  const definitionId = field(card, 'definitionId');
  if (field(card, 'instanceId') !== topCardId || field(card, 'owner') !== owner || !text(definitionId))
    fail(CONTEXT, 'The top physical card must retain its own identity, opponent owner and printed definition.');
  const definition = field(field(ctx, 'definitions'), definitionId);
  if (field(definition, 'definitionId') !== definitionId || field(definition, 'kind') !== 'pokemon')
    fail(CONTEXT, 'Owned attacks come only from that physical top card’s printed Pokemon definition.');
  const attacks = array(field(field(definition, 'mechanics'), 'attacks'), CONTEXT);
  const seen = new Set(), candidates = [];
  for (let i = 0; i < attacks.length; i++) {
    const attackId = field(Object.getOwnPropertyDescriptor(attacks, String(i)).value, 'attackId');
    if (!text(attackId) || seen.has(attackId))
      fail(CONTEXT, 'Printed attacks need unique nonempty IDs on this top card.');
    seen.add(attackId); candidates.push({ instanceId: topCardId, attackId });
  }
  return { owner, target: { pokemonId, topCardId }, candidates };
}

/** blocked is the host's Boolean decision, never a client permission or lookup. */
export function planOwnedAttackLock(ctx, action, selectedRefs, blocked = false) {
  if (typeof blocked !== 'boolean') fail(SELECTION, 'The host blocked flag must be Boolean.');
  const window = ownedAttackLockWindow(ctx, action), selected = data(selectedRefs, SELECTION);
  array(selected, SELECTION);
  for (const ref of selected) {
    record(ref, ['instanceId', 'attackId'], SELECTION);
    if (!text(ref.instanceId) || !text(ref.attackId))
      fail(SELECTION, 'A selected printed attack needs its physical card and attack IDs.');
  }
  if (selected.length !== Math.min(1, window.candidates.length))
    fail(SELECTION, 'Select exactly one owned printed attack if available; otherwise select none.');
  if (selected.some((ref) => !window.candidates.some((candidate) =>
    candidate.instanceId === ref.instanceId && candidate.attackId === ref.attackId)))
    fail(SELECTION, 'Only an attack from the actual opponent Active top card may be selected.');
  return {
    owner: window.owner, target: window.target,
    selected: selected.map(({ instanceId, attackId }) => ({ instanceId, attackId })),
    performed: selected.length === 1 && !blocked,
  };
}
