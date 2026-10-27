// The difficulty levels, from 新手 to 宝可梦大师, and the other players the arena can seat. Every agent decides only from
// what its player could know (see play.mjs).
import { readFileSync } from 'node:fs';
import { policyAgent, legacyAgent } from './play.mjs';
import { createSearch } from './search.mjs';
import { kevAgent } from './kev.mjs';
import { planAgent } from './plan.mjs';
import { planFor } from './deck-plan.mjs';

// Each level was measured against the one below in the arena (scripts/ai-arena.mjs, docs/ai/STATUS.md).
export const LEVELS = Object.freeze([
  { level: 1, name: '新手', policy: { noise: 1 } },
  { level: 2, name: '训练家', policy: { noise: 0.3 } },
  { level: 3, name: '道馆馆主', policy: { noise: 0 } },
  { level: 4, name: '四天王', search: { worlds: 4, horizon: 'turn', shortlist: 8, margin: 0.015 } },
  { level: 5, name: '宝可梦大师', search: { worlds: 6, horizon: 'next', shortlist: 10, margin: 0.015 } },
]);

/**
 * A search as a player: it searches the moves of its own turn and the requests worth comparing; the rest is policy.
 * `last` keeps its latest analysis (self-play records it).
 */
export function searchAgent(catalog, options = {}, name = `search(${options.worlds ?? 8},${options.horizon ?? 'reply'})`) {
  const analyse = createSearch(catalog, options);
  const agent = { name, last: null, decide: (sim, me) => (agent.last = analyse(sim.state, me)).best };
  return agent;
}

/**
 * A search level that plays its own turns with the whole-turn planner when its deck's tuning says so (deck-plan.mjs
 * `planner`, e.g. { budget: 3000 }); otherwise the search alone.
 */
export function withPlanner(search, catalog, seed, name = search.name) {
  const planners = new Map();
  const agent = { name, last: null, decide: (sim, me, steps) => {
    const options = planFor(catalog, sim.state, me)?.planner;
    if (!options) { const move = search.decide(sim, me, steps); agent.last = search.last; return move; }
    const key = JSON.stringify(options);
    if (!planners.has(key)) planners.set(key, planAgent(catalog, { ...options, seed }, `${name}+plan`));
    return planners.get(key).decide(sim, me, steps);
  } };
  return agent;
}

/**
 * `spec`: 'level:1'…'level:5', 'legacy', 'policy:<noise>', 'search:<option>=<value>,…' (createSearch's options) or
 * 'kev:<server url>' (kev.mjs, to measure Kev). A search that guesses from the metagame (opponent=meta) uses
 * `metaCatalog` (the game's printings and metaPrintings) and leaves out the list keys `exclude` (an arena: the
 * opponent's own list).
 */
export function makeAgent(spec, catalog, seed = [1, 2, 3, 4], { metaCatalog = null, exclude = [] } = {}) {
  const search = (options) => (options.opponent === 'meta'
    ? searchAgent(metaCatalog ?? catalog, { ...options, exclude, seed }, spec) : searchAgent(catalog, { ...options, seed }, spec));
  const at = spec.indexOf(':'), kind = at < 0 ? spec : spec.slice(0, at), a = at < 0 ? undefined : spec.slice(at + 1);
  if (kind === 'kev') return kevAgent(catalog, { url: a, seed, name: spec });
  // 'plan:<option>=<value>,…' (plan.mjs createPlanner's options): whole-turn planning.
  if (kind === 'plan') {
    const options = Object.fromEntries((a ?? '').split(',').filter(Boolean).map((kv) => kv.split('='))
      .map(([k, v]) => [k, Number.isNaN(Number(v)) ? v : Number(v)]));
    return planAgent(catalog, { ...options, seed }, spec);
  }
  if (kind === 'legacy') return legacyAgent(catalog);
  if (kind === 'policy') {
    // 'policy:<noise>[,weights=<JSON file of POLICY_WEIGHTS to change>]'
    const [noise, ...rest] = (a ?? '0').split(','), file = rest.find((x) => x.startsWith('weights='))?.slice(8);
    return policyAgent(catalog, { noise: Number(noise), seed, name: spec, weights: file ? JSON.parse(readFileSync(file, 'utf8')) : {} });
  }
  if (kind === 'search') {
    const options = Object.fromEntries((a ?? '').split(',').filter(Boolean).map((kv) => kv.split('='))
      .map(([k, v]) => [k, Number.isNaN(Number(v)) ? v : Number(v)]));
    return search(options);
  }
  if (kind === 'level') {
    const level = LEVELS.find((l) => l.level === Number(a));
    if (!level) throw new RangeError(`No difficulty level ${a}.`);
    return level.policy ? policyAgent(catalog, { ...level.policy, seed, name: spec }) : withPlanner(search(level.search), catalog, seed, spec);
  }
  throw new RangeError(`Unknown agent: ${spec}`);
}
