// The table's game record on the account server (server/app.mjs /api/matches; the step types are in replay.js):
// the setup when a game starts, then every dispatch, rewind, refused move and browser error, sent in batches at each
// checkpoint. Steps the server has not taken yet stay here (and in the saved game) and go with the next batch; each
// step has a key of its own, so sending one twice is harmless.
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
const REFUSED = new Set([400, 404, 413]);

export class MatchRecorder {
  // `pending`: steps not yet taken by the server (from a saved game).
  constructor({ id, pending = [] }) {
    Object.assign(this, { id, pending: [...pending], meta: {}, sending: null, again: false });
  }

  // A new record for a game about to start, or null when the server cannot keep one (the game goes on without).
  static async start(setup) {
    try {
      const { match } = await post('/api/matches', { setup });
      return new MatchRecorder({ id: match.id });
    } catch {
      return null;
    }
  }

  add(step) { this.pending.push({ key: `${PAGE}.${++counter}`, step: { ...step, at: Date.now() } }); }

  // Sends the waiting steps with the latest `meta` {status, result, turn}; one request at a time.
  flush(meta = {}) {
    Object.assign(this.meta, meta);
    if (this.sending) { this.again = true; return this.sending; }
    this.sending = (async () => {
      try {
        do {
          this.again = false;
          const steps = this.pending.slice(0, BATCH), sent = this.meta;
          this.meta = {};
          try {
            await post(`/api/matches/${this.id}/steps`, { steps, ...sent });
          } catch (error) {
            if (!REFUSED.has(error.status)) {
              this.meta = { ...sent, ...this.meta };
              return;
            }
          }
          this.pending.splice(0, steps.length);
        } while (this.again || this.pending.length);
      } finally {
        this.sending = null;
      }
    })();
    return this.sending;
  }

  // The page is closing: send what fits in one last small request (snapshots wait for the saved game).
  flushOnExit() {
    const steps = [];
    let size = 0;
    for (const s of this.pending) {
      size += JSON.stringify(s).length;
      if (s.step.type === 'snapshot' || size > KEEPALIVE_LIMIT) break;
      steps.push(s);
    }
    if (steps.length || Object.keys(this.meta).length)
      post(`/api/matches/${this.id}/steps`, { steps, ...this.meta }, { keepalive: true }).catch(() => {});
  }

  // What the saved game keeps: the record's id and the steps still to send (without snapshots, which are large).
  saved() { return { id: this.id, pending: this.pending.filter((s) => s.step.type !== 'snapshot') }; }
}
