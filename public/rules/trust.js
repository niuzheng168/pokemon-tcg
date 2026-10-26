// Simulation mode. A search replays positions this engine produced itself, many thousands of times, so the schema
// checks that guard snapshots, effect frames and handler output arriving from outside are skipped while it runs.
// The rules are the same: a check only throws or passes, it never changes the state (simulation.test.mjs plays the
// same seeds checked and trusted and compares every snapshot).
let depth = 0;

/** Whether the outside-input checks run (always, except inside trusted()). */
export const checking = () => depth === 0;

/** Run fn with the checks off. The engine is synchronous, so the scope ends with fn. */
export function trusted(fn) {
  depth++;
  try { return fn(); } finally { depth--; }
}

// A simulation shares the answers of a read (game.js readOnly): the source model, the continuous effects and the
// handlers' board are worked out once while the state stays as it is. With verifyReads(true) checked play shares them
// too and compares every shared answer with a fresh one, so the rules tests (tests/verify-reads.mjs) hold that sharing
// to the checked engine.
let verify = false;
export const verifyingReads = () => verify;
export function verifyReads(on) { verify = on === true; }

/** A shared answer must be the answer a fresh read gives (plain data and Maps). */
export function assertSameRead(shared, fresh, what) {
  const same = (a, b) => {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    if (a instanceof Map || b instanceof Map)
      return a instanceof Map && b instanceof Map && a.size === b.size && [...a].every(([k, v]) => b.has(k) && same(v, b.get(k)));
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
  };
  if (!same(shared, fresh)) throw new Error(`A shared read is stale: the ${what} changed while it was being read.`);
}
