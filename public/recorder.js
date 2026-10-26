// The browser's errors during a game, for the game's record on the account server (server/app.mjs
// /api/matches/:id/steps; the step types are in replay.js). The server records the game itself (server/play.mjs); the
// table adds only 'error' steps, sent in batches at each checkpoint. Each step has a key of its own, so sending one
// twice is harmless.
const PAGE = Math.random().toString(36).slice(2, 10); // keys from this page load
const BATCH = 200;
const KEEPALIVE_LIMIT = 60_000; // browsers cap a request sent while the page closes at 64 KB
let counter = 0;

async function post(path, body, { keepalive = false } = {}) {
  const r = await fetch(path, { method: 'POST', credentials: 'same-origin', keepalive,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  return r.json();
}
// Answers that sending the same batch again cannot change: the batch is dropped rather than block the ones after it.
const REFUSED = new Set([400, 403, 404, 413]);

export class MatchRecorder {
  constructor({ id }) {
    Object.assign(this, { id, pending: [], sending: null, again: false });
  }

  add(step) { this.pending.push({ key: `${PAGE}.${++counter}`, step: { ...step, at: Date.now() } }); }

  // Sends the waiting steps, one request at a time.
  flush() {
    if (this.sending) { this.again = true; return this.sending; }
    this.sending = (async () => {
      try {
        do {
          this.again = false;
          const steps = this.pending.slice(0, BATCH);
          if (!steps.length) return;
          try {
            await post(`/api/matches/${this.id}/steps`, { steps });
          } catch (error) {
            if (!REFUSED.has(error.status)) return;
          }
          this.pending.splice(0, steps.length);
        } while (this.again || this.pending.length);
      } finally {
        this.sending = null;
      }
    })();
    return this.sending;
  }

  // The page is closing: send what fits in one last small request.
  flushOnExit() {
    const steps = [];
    let size = 0;
    for (const s of this.pending) {
      size += JSON.stringify(s).length;
      if (size > KEEPALIVE_LIMIT) break;
      steps.push(s);
    }
    if (steps.length) post(`/api/matches/${this.id}/steps`, { steps }, { keepalive: true }).catch(() => {});
  }
}
