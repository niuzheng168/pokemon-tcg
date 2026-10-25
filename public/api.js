// One door to the website's AI (server/app.mjs → ai/service.mjs, or the AI server it forwards to):
//   GET  /api/engine                                  → {engine: 'search' | 'cpu', ready, where, levels: [{level, name}]}
//   POST /api/decide {snapshot, player, level, turnMoves} → {action, level, value?, ms}  小茂's move at a difficulty level
//   POST /api/rate {snapshot, player, actions}         → {ranking: {choice, probabilities}, win: {score, value},
//                                                         moves: {key: {win, se, n, reasons}}, ms}  the Professor's estimates
// The table runs the game, so it sends the full snapshot; the search deals everything the deciding player cannot see
// again before it simulates (ai/worlds.mjs), so no hidden card decides a move.
// Without the AI (no server, or the server has it off) the built-in CPU engine plays and the Professor stays quiet.
export const BUILTIN_ENGINE = Object.freeze({ engine: 'cpu', ready: false, where: null, levels: [], builtin: true });

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
  const [status, data] = path === '/api/engine'
    ? [200, BUILTIN_ENGINE]
    : [501, { error: 'no AI server: the built-in CPU engine plays' }];
  return { ok: status === 200, status, json: async () => data };
}

export const hasBackend = () => backend === true;
