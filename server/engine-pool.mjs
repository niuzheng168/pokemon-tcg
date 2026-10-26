// The engine hosts behind the website (docs/ENGINE-PROTOCOL.md): matches spread over worker threads
// (server/engine-worker.mjs), each staying on the worker that opened it, so a long move in one game never holds up the
// server or the games on other workers. With workers: 0 the host runs in this thread (tests, small setups); requests
// and replies are copied either way, as they would be over any transport. call(op, params) resolves with the result or
// throws an EngineCallError {code, message, ruleId?}. A worker that dies takes its matches with it: calls for them answer
// unknown-match, and the server opens them again from their records (open with the moves played so far).
import { Worker } from 'node:worker_threads';
import { createEngineHost } from './engine-host.mjs';

export class EngineCallError extends Error {
  constructor({ code, message, ruleId }) {
    super(message); this.name = 'EngineCallError'; this.code = code;
    if (ruleId) this.ruleId = ruleId;
  }
}

/**
 * `workers`: threads (0: in this thread, with `release`). `releaseOptions`: what each worker passes to loadRelease.
 * A call slower than `slowMs` is logged (`log.warn`).
 */
export function createEnginePool({ workers = 1, release = null, releaseOptions = {}, slowMs = 1000, log = console } = {}) {
  let next = 0, closed = false;
  const owner = new Map(), slots = [];
  const local = workers === 0 ? createEngineHost({ release }) : null;

  function spawn(index) {
    const worker = new Worker(new URL('./engine-worker.mjs', import.meta.url), { workerData: { release: releaseOptions } });
    const slot = { index, worker, waiting: new Map(), matches: new Set() };
    worker.on('message', (reply) => {
      const job = slot.waiting.get(reply.id);
      if (!job) return; // {ready: true}
      slot.waiting.delete(reply.id);
      job(reply);
    });
    const lost = (message) => {
      if (slots[index] !== slot) return;
      for (const match of slot.matches) owner.delete(match);
      for (const job of slot.waiting.values()) job({ ok: false, error: { code: 'engine-crashed', message } });
      slot.waiting.clear();
      if (!closed) slots[index] = spawn(index);
    };
    worker.on('error', (error) => { log.error(`Engine worker ${index}: ${error.stack ?? error}`); lost(String(error.message ?? error)); });
    worker.on('exit', (code) => lost(`Engine worker ${index} stopped (exit code ${code}).`));
    slot.lost = lost;
    return slot;
  }
  for (let i = 0; i < workers; i++) slots.push(spawn(i));

  function post(slot, request) {
    return new Promise((resolve) => {
      slot.waiting.set(request.id, resolve);
      slot.worker.postMessage(request);
    });
  }

  async function send(request) {
    if (local) return structuredClone(await local.handle(structuredClone(request)));
    const { op, match } = request;
    if (typeof match !== 'string') return post(slots[0], request);
    let slot = owner.get(match);
    if (!slot && op === 'open') {
      slot = slots.reduce((a, b) => (b.matches.size < a.matches.size ? b : a));
      owner.set(match, slot); slot.matches.add(match);
    }
    if (!slot) return { id: request.id, ok: false, error: { code: 'unknown-match', message: `No match ${match} is open.` } };
    const reply = await post(slot, request);
    if ((op === 'open' && !reply.ok && reply.error.code !== 'match-exists') || (op === 'close' && reply.ok)) {
      owner.delete(match); slot.matches.delete(match);
    }
    return reply;
  }

  return {
    async call(op, params = {}) {
      if (closed) throw new EngineCallError({ code: 'closed', message: 'The engine pool is closed.' });
      const started = performance.now();
      const reply = await send({ ...params, id: ++next, op });
      const ms = performance.now() - started;
      if (ms > slowMs) log.warn(`[slow engine] ${op} ${params.match ?? ''} ${Math.round(ms)} ms`);
      if (!reply.ok) throw new EngineCallError(reply.error);
      return reply.result;
    },
    /** Open matches per worker (in-process: one entry). */
    load: () => (local ? [local.matches] : slots.map((s) => s.matches.size)),
    /** Stops worker `index` and starts a fresh one; its matches are lost, as when a worker dies. */
    async restart(index) {
      const slot = slots[index];
      await slot.worker.terminate();
      slot.lost(`Engine worker ${index} was restarted.`);
    },
    async close() {
      closed = true;
      await Promise.all(slots.map((s) => s.worker.terminate()));
    },
  };
}
