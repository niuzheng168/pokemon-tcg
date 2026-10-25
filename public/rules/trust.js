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
