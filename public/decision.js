// What the table asks a decision engine. The CPU engine (cn/ai.js) is built in and plays the opponent; a backend
// engine (api.js) is used when one answers. The Professor's move ratings and the win estimate need the new
// decision engine, which is not implemented yet: rate() answers null until a backend provides /api/rate.
import { createAI } from './cn/ai.js';
import { api, hasBackend } from './api.js';

export function createDecisions(catalog) {
  const cpu = createAI(catalog);
  return {
    // The opponent's move from its own player view: {action, confidence?}.
    async decide(view, player, engine) {
      if (engine && engine.engine !== 'cpu' && hasBackend()) {
        const r = await api('/api/decide', { method: 'POST', body: { view, player } });
        if (!r.ok) throw Object.assign(new Error((await r.json()).error ?? `HTTP ${r.status}`), { status: r.status });
        return r.json();
      }
      return { action: cpu(view, player) };
    },
    // Your move from your view, for 自动代打.
    cpu: (view, player) => cpu(view, player),
    // The Professor: {ranking: {choice, probabilities}, win: {score}} keyed by the table's move keys, or null.
    async rate(view, player, actions) {
      if (!hasBackend()) return null;
      const r = await api('/api/rate', { method: 'POST', body: { view, player, actions: actions.map((a) => ({ key: a.key, action: a.cmd })) } });
      return r.ok ? r.json() : null;
    },
  };
}
