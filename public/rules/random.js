// Deterministic local-simulation RNG, not a claim of cryptographic randomness.
// The private RNG state is never part of a player view. Network tournaments need
// an authoritative server/randomness source, not client-owned seeds or snapshots.
export function validateRandomState(state) {
  if (!Array.isArray(state) || state.length !== 4 || state.every((v) => v === 0) ||
      state.some((v) => !Number.isInteger(v) || v < 0 || v > 0xffffffff))
    throw new TypeError('RNG needs four uint32 words and a nonzero state.');
}

const rotate = (x, k) => ((x << k) | (x >>> (32 - k))) >>> 0;
export function randomUint32(state) {
  validateRandomState(state);
  const result = Math.imul(rotate(Math.imul(state[1], 5), 7), 9) >>> 0;
  const t = state[1] << 9;
  state[2] ^= state[0]; state[3] ^= state[1]; state[1] ^= state[2];
  state[0] ^= state[3]; state[2] ^= t; state[3] = rotate(state[3], 11);
  for (let i = 0; i < 4; i++) state[i] >>>= 0;
  return result;
}

export function randomIndex(state, maximum) {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 0x100000000)
    throw new TypeError('Invalid random index bound.');
  const limit = Math.floor(0x100000000 / maximum) * maximum;
  let value;
  do { value = randomUint32(state); } while (value >= limit);
  return value % maximum;
}

export function shuffleIds(state, ids) {
  for (let i = ids.length - 1; i > 0; i--) {
    const j = randomIndex(state, i + 1);
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids;
}
