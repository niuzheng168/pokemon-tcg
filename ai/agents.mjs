// The difficulty levels, from 新手 to 宝可梦大师, and the other players the arena can seat. Every agent decides only from
// what its player could know (see play.mjs).
import { policyAgent, legacyAgent } from './play.mjs';
import { createSearch } from './search.mjs';

export const LEVELS = Object.freeze([
  { level: 1, name: '新手', policy: { noise: 1 } },
  { level: 2, name: '训练家', policy: { noise: 0 } },
  { level: 3, name: '道馆馆主', search: { worlds: 4, horizon: 'turn', shortlist: 8 } },
  { level: 4, name: '四天王', search: { worlds: 8, horizon: 'reply', shortlist: 12 } },
  { level: 5, name: '宝可梦大师', search: { worlds: 16, horizon: 'reply', shortlist: 20 } },
]);

/** A search as a player: it searches the moves of its own turn and the requests worth comparing; the rest is policy. */
export function searchAgent(catalog, options = {}, name = `search(${options.worlds ?? 8},${options.horizon ?? 'reply'})`) {
  const analyse = createSearch(catalog, options);
  return { name, decide: (sim, me) => analyse(sim.state, me).best };
}

/** `spec`: 'level:1'…'level:5', 'legacy', 'policy:<noise>' or 'search:<worlds>:<turn|reply>'. */
export function makeAgent(spec, catalog, seed = [1, 2, 3, 4]) {
  const [kind, a, b] = spec.split(':');
  if (kind === 'legacy') return legacyAgent(catalog);
  if (kind === 'policy') return policyAgent(catalog, { noise: Number(a ?? 0), seed, name: spec });
  if (kind === 'search') return searchAgent(catalog, { worlds: Number(a ?? 8), horizon: b ?? 'reply', seed }, spec);
  if (kind === 'level') {
    const level = LEVELS.find((l) => l.level === Number(a));
    if (!level) throw new RangeError(`No difficulty level ${a}.`);
    return level.policy ? policyAgent(catalog, { ...level.policy, seed, name: spec }) : searchAgent(catalog, { ...level.search, seed }, spec);
  }
  throw new RangeError(`Unknown agent: ${spec}`);
}
