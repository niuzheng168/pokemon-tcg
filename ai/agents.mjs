// The difficulty levels, from 新手 to 宝可梦大师, and the other players the arena can seat. Every agent decides only from
// what its player could know (see play.mjs).
import { policyAgent, legacyAgent } from './play.mjs';
import { createSearch } from './search.mjs';

// Each level was measured against the one below in the arena (scripts/ai-arena.mjs, docs/ai/STATUS.md).
export const LEVELS = Object.freeze([
  { level: 1, name: '新手', policy: { noise: 1 } },
  { level: 2, name: '训练家', policy: { noise: 0.3 } },
  { level: 3, name: '道馆馆主', policy: { noise: 0 } },
  { level: 4, name: '四天王', search: { worlds: 4, horizon: 'turn', shortlist: 8, margin: 0.015 } },
  { level: 5, name: '宝可梦大师', search: { worlds: 6, horizon: 'reply', shortlist: 10, margin: 0.015 } },
]);

/** A search as a player: it searches the moves of its own turn and the requests worth comparing; the rest is policy. */
export function searchAgent(catalog, options = {}, name = `search(${options.worlds ?? 8},${options.horizon ?? 'reply'})`) {
  const analyse = createSearch(catalog, options);
  return { name, decide: (sim, me) => analyse(sim.state, me).best };
}

/** `spec`: 'level:1'…'level:5', 'legacy', 'policy:<noise>' or 'search:<option>=<value>,…' (createSearch's options). */
export function makeAgent(spec, catalog, seed = [1, 2, 3, 4]) {
  const [kind, a] = spec.split(':');
  if (kind === 'legacy') return legacyAgent(catalog);
  if (kind === 'policy') return policyAgent(catalog, { noise: Number(a ?? 0), seed, name: spec });
  if (kind === 'search') {
    const options = Object.fromEntries((a ?? '').split(',').filter(Boolean).map((kv) => kv.split('='))
      .map(([k, v]) => [k, Number.isNaN(Number(v)) ? v : Number(v)]));
    return searchAgent(catalog, { ...options, seed }, spec);
  }
  if (kind === 'level') {
    const level = LEVELS.find((l) => l.level === Number(a));
    if (!level) throw new RangeError(`No difficulty level ${a}.`);
    return level.policy ? policyAgent(catalog, { ...level.policy, seed, name: spec }) : searchAgent(catalog, { ...level.search, seed }, spec);
  }
  throw new RangeError(`Unknown agent: ${spec}`);
}
