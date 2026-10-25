// What the table asks the AI (api.js): 小茂's move at a difficulty level, and the Professor's estimate for each of your
// moves. The built-in CPU engine (cn/ai.js) plays when the game has no level (the server has no AI) and takes over a
// move the AI could not make; it also makes your moves for 自动代打.
import { createAI } from './cn/ai.js';
import { api, hasBackend } from './api.js';

const failure = async (r) => Object.assign(new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`), { status: r.status });

export function createDecisions(catalog) {
  const cpu = createAI(catalog);
  return {
    // 小茂's move: {action, value?}. With a level the server's AI decides from the snapshot (it uses only what 小茂 could
    // know); without one the CPU engine decides from 小茂's own view.
    async decide(view, player, { snapshot = null, level = null, turnMoves = 0 } = {}) {
      if (!level || !hasBackend()) return { action: cpu(view, player) };
      const r = await api('/api/decide', { method: 'POST', body: { snapshot, player, level, turnMoves } });
      if (!r.ok) throw await failure(r);
      return r.json();
    },
    // Your move from your view, for 自动代打.
    cpu: (view, player) => cpu(view, player),
    // The Professor: {ranking: {choice, probabilities}, win: {score, value}, moves: {key: {win, reasons}}}, or null
    // when the server has no AI.
    async rate(snapshot, player, actions) {
      if (!hasBackend()) return null;
      const r = await api('/api/rate', { method: 'POST', body: { snapshot, player, actions: actions.map((a) => ({ key: a.key, action: a.cmd })) } });
      if (r.status === 503 || r.status === 501) return null;
      if (!r.ok) throw await failure(r);
      return r.json();
    },
  };
}
