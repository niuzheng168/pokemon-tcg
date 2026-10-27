// The AI service behind /api/decide and /api/rate: 小茂's move at a difficulty level, and the advisor's estimate for every
// move the player can make, with reasons. It takes a full snapshot (the table runs the game) and validates it once; the
// search itself only uses what the deciding player could know (worlds.mjs). Rollouts run on a pool of worker threads.
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { Simulation } from '../public/rules/engine.js';
import { createSearch, moveKey } from './search.mjs';
import { createPolicy } from './policy.mjs';
import { playSafely } from './play.mjs';
import { LEVELS } from './agents.mjs';
import { reasonsFor } from './reasons.mjs';
import { planFor } from './deck-plan.mjs';

/** The advisor's search: every move kept to the end, through the opponent's reply. */
export const ADVISOR = Object.freeze({ worlds: 8, horizon: 'reply' });
export const defaultWorkers = () => Math.max(1, Math.min(availableParallelism() - 1, 16));
/** The printings a snapshot's cards use: what its catalog is built from. */
export const printingKey = (snapshot) => [...new Set(Object.values(snapshot.cards).map((c) => c.printingId))].sort().join('|');

export class AIError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function createPool(size, workerData) {
  const workers = [], waiting = new Map();
  let next = 0;
  for (let i = 0; i < size; i++) {
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), { workerData });
    const slot = { worker, busy: 0 };
    worker.on('message', (m) => {
      if (m.ready) return;
      const job = waiting.get(m.id);
      waiting.delete(m.id); slot.busy--;
      if (m.error) job.reject(new Error(m.error)); else job.resolve(m.results);
    });
    worker.on('error', (error) => { for (const job of waiting.values()) job.reject(error); waiting.clear(); });
    workers.push(slot);
  }
  return {
    size,
    /** Run the jobs of one position spread over the workers; results in job order. */
    async run(snapshot, me, jobs, options) {
      const parts = Math.min(size, jobs.length), chunk = Math.ceil(jobs.length / parts), sent = [];
      for (let i = 0; i < jobs.length; i += chunk) {
        const slot = [...workers].sort((a, b) => a.busy - b.busy)[0], id = ++next;
        slot.busy++;
        sent.push(new Promise((resolve, reject) => {
          waiting.set(id, { resolve, reject });
          slot.worker.postMessage({ id, snapshot, me, jobs: jobs.slice(i, i + chunk), options });
        }));
      }
      return (await Promise.all(sent)).flat();
    },
    /** A whole-turn plan (plan.mjs) of one position on the least busy worker: { best, moves }. */
    plan(snapshot, me, options) {
      const slot = [...workers].sort((a, b) => a.busy - b.busy)[0], id = ++next;
      slot.busy++;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        slot.worker.postMessage({ id, snapshot, me, plan: options });
      });
    },
    close: () => Promise.all(workers.map((w) => w.worker.terminate())),
  };
}

export function createAIService({ release, workers = defaultWorkers(), releaseOptions = {} }) {
  const pool = createPool(workers, { release: releaseOptions, releaseId: release.releaseId });
  const catalogs = new Map(), searches = new Map();

  async function open(snapshot, player) {
    if (!snapshot || typeof snapshot !== 'object' || !snapshot.cards || typeof snapshot.cards !== 'object')
      throw new AIError(422, 'A full game snapshot is required.');
    if (![0, 1].includes(player)) throw new AIError(422, 'player must be 0 or 1.');
    const key = printingKey(snapshot);
    if (!catalogs.has(key)) {
      if (catalogs.size >= 16) catalogs.delete(catalogs.keys().next().value);
      catalogs.set(key, release.catalogFor(key.split('|')));
    }
    let catalog, sim;
    try {
      catalog = await catalogs.get(key);
      sim = new Simulation(snapshot, catalog);
    } catch (error) {
      catalogs.delete(key);
      throw new AIError(422, `This position cannot be read: ${error.message}`);
    }
    if (sim.actor !== player) throw new AIError(409, 'It is not this player’s move.');
    return { catalog, sim };
  }
  const searchFor = (catalog, options) => {
    const k = JSON.stringify(options);
    let byOptions = searches.get(catalog);
    if (!byOptions) searches.set(catalog, byOptions = new Map());
    if (!byOptions.has(k)) byOptions.set(k, createSearch(catalog, options));
    return byOptions.get(k);
  };
  // A request's own randomness: the same position asks the same question the same way.
  const seedOf = (snapshot, player, salt) => [snapshot.revision + 1, player + 1, salt, snapshot.rng?.[0] ?? 7];

  async function runPlan(search, snapshot, player, options, planOptions) {
    const it = search.plan(snapshot, player, planOptions);
    let step = it.next();
    while (!step.done) step = it.next(step.value.length ? await pool.run(snapshot, player, step.value, options) : []);
    return step.value;
  }

  return {
    workers,
    releaseId: release.releaseId,
    manifestSha256: release.manifestSha256,
    /** 小茂's move: { action, level, value?, by: 'policy' | 'search' | 'plan', ms }. `turnMoves` counts its moves this turn (a guard against loops). */
    async decide({ snapshot, player, level = 2, turnMoves = 0 }) {
      const started = performance.now(), spec = LEVELS.find((l) => l.level === level);
      if (!spec) throw new AIError(422, `No difficulty level ${level}.`);
      const { catalog, sim } = await open(snapshot, player);
      let action, value = null, by = spec.policy ? 'policy' : 'search';
      // A deck tuned to plan its turns (deck-plan.mjs `planner`): the search levels plan its own turn whole.
      const planner = !spec.policy && snapshot.phase !== 'setup' && snapshot.current === player ? planFor(catalog, sim.state, player)?.planner : null;
      if (spec.policy) action = createPolicy(catalog, { ...spec.policy, seed: seedOf(snapshot, player, level) })(sim.view(player), player, turnMoves);
      else {
        const options = { ...spec.search };
        let result;
        if (planner) {
          by = 'plan';
          result = await pool.plan(snapshot, player, { budget: planner.budget, seed: seedOf(snapshot, player, level) });
        } else result = await runPlan(searchFor(catalog, options), snapshot, player, options, { seed: seedOf(snapshot, player, level) });
        // The chosen move, or the best other one the rules accept in the real position (a printed selection rule may refuse one).
        // (A plan comes back from a worker: the same move as a copy.)
        const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
        const chosen = result.moves.find((m) => same(m.action, result.best));
        const accepted = [chosen, ...result.moves].find((m) => m && !sim.fork().attempt(player, m.action));
        action = accepted?.action ?? result.best;
        value = accepted?.value ?? null;
      }
      // Whatever was chosen, what is played is a move the rules accept here.
      const check = sim.fork();
      action = playSafely(check, player, action, seedOf(snapshot, player, 99));
      return { action, level, value, by, ms: Math.round(performance.now() - started) };
    },
    /**
     * The advisor: for each of the player's moves ({ key, action }), the estimated chance to win after it and why.
     * { ranking: { choice, probabilities }, win: { score }, moves: { key: { win, se, n, reasons } }, ms }.
     */
    async rate({ snapshot, player, actions }) {
      const started = performance.now();
      if (!Array.isArray(actions) || !actions.length || actions.some((a) => typeof a?.key !== 'string' || !a.action))
        throw new AIError(422, 'actions must be a list of { key, action }.');
      const { catalog } = await open(snapshot, player);
      const unique = new Map();
      for (const { action } of actions) if (action.type !== 'concede') unique.set(moveKey(snapshot, action), action);
      const options = { ...ADVISOR };
      const result = await runPlan(searchFor(catalog, options), snapshot, player, options,
        { moves: [...unique.values()], prune: false, seed: seedOf(snapshot, player, 0) });
      const byKey = new Map(result.moves.map((m) => [m.key, m])), best = result.moves.find((m) => m.value != null) ?? result.moves[0];
      const moves = {}, probabilities = {};
      for (const { key, action } of actions) {
        const m = action.type === 'concede' ? { value: 0, se: 0, n: 0, facts: null } : byKey.get(moveKey(snapshot, action));
        if (!m) continue; // refused in every world: not a move the advisor can rate
        probabilities[key] = m.value ?? 0.5;
        moves[key] = { win: m.value, se: m.se, n: m.n, reasons: action.type === 'concede' ? [{ code: 'concede' }] : reasonsFor(m, best) };
      }
      const choice = actions.find(({ action }) => best && action.type !== 'concede' && moveKey(snapshot, action) === best.key)?.key ?? null;
      return { ranking: { choice, probabilities }, win: { score: best?.value != null ? best.value * 4 : 2, value: best?.value ?? null },
        moves, ms: Math.round(performance.now() - started) };
    },
    close: () => pool.close(),
  };
}
