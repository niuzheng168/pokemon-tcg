// One door to a decision-engine backend. No backend ships yet (the new decision engine comes later); the paths it
// will answer are fixed here so the table UI already speaks them:
//   GET  /api/engine                         → {engine, model, jevKeySet, models[], local{status, model, …}}
//   POST /api/engine {engine, model?, jevKey?} → the same
//   POST /api/engine/stop                    → the same
//   POST /api/decide {view, player}          → {action, confidence?}  the opponent's move, from its own player view
//   POST /api/rate {view, player, actions}   → {ranking: {choice, probabilities}, win: {score}}  the Professor's ratings
// `view` is the kernel's player view and `action` a kernel command, so a backend never sees hidden cards.
// Without a backend (the static site) the built-in CPU engine plays and the Professor's ratings are unavailable.
export const BUILTIN_ENGINE = Object.freeze({ engine: 'cpu', model: null, jevKeySet: false, models: [],
  local: { status: 'stopped', model: null }, builtin: true });

let backend = null; // null: not asked yet; false: none; true: answering

export async function api(path, { method = 'GET', body } = {}) {
  if (backend !== false) {
    try {
      const r = await fetch(path, method === 'GET' ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
      if ((r.headers.get('content-type') ?? '').includes('application/json')) { backend = true; return r; }
      backend = false; // a static host answers with its 404 page
    } catch (error) {
      if (backend) throw error;
      backend = false;
    }
  }
  const [status, data] = path === '/api/engine' || path === '/api/engine/stop'
    ? [200, BUILTIN_ENGINE]
    : [501, { error: 'no decision-engine backend: the built-in CPU engine plays' }];
  return { ok: status === 200, status, json: async () => data };
}

export const hasBackend = () => backend === true;

// A hosted model needs the internet; the CPU engine and local models do not.
export const online = () => typeof navigator === 'undefined' || navigator.onLine !== false;
