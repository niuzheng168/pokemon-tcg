// HTTP in front of an AI service: the A100 box runs this one (scripts/ai-server.mjs), the website forwards to it
// (server/main.mjs --ai-url). Bodies are JSON, gzip-compressed when large (a late snapshot is a few hundred KB).
//   POST /decide { snapshot, player, level, turnMoves? }   POST /rate { snapshot, player, actions }   GET /health
import { gzipSync, gunzipSync } from 'node:zlib';
import { AIError } from './service.mjs';

const LIMIT = 32 * 1024 * 1024;

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > LIMIT) throw new AIError(413, 'Request too large.');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  return JSON.parse((req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw).toString('utf8'));
}

/** A request handler for node:http serving `service`; with `token`, requests must send it as a Bearer token. */
export function aiHandler(service, { token = null } = {}) {
  return async (req, res) => {
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    try {
      if (token && req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'Unauthorized.' });
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/health') return send(200, { ok: true, releaseId: service.releaseId, manifestSha256: service.manifestSha256, workers: service.workers });
      if (req.method === 'POST' && path === '/decide') return send(200, await service.decide(await body(req)));
      if (req.method === 'POST' && path === '/rate') return send(200, await service.rate(await body(req)));
      return send(404, { error: 'Not found.' });
    } catch (error) {
      send(error.status ?? (error instanceof SyntaxError ? 400 : 500), { error: error.message });
    }
  };
}

/** The same interface as createAIService, answered by an AI server at `url`. */
export function remoteAI(url, { token = null, timeout = 120_000 } = {}) {
  const base = url.replace(/\/$/, '');
  async function call(path, data) {
    const headers = { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    let res;
    try {
      res = await fetch(`${base}${path}`, { method: 'POST', headers, body: gzipSync(JSON.stringify(data)), signal: AbortSignal.timeout(timeout) });
    } catch (error) {
      throw new AIError(503, `The AI server does not answer (${error.message}).`);
    }
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new AIError(res.status, out.error ?? `AI server: HTTP ${res.status}`);
    return out;
  }
  return {
    remote: base,
    decide: (data) => call('/decide', data),
    rate: (data) => call('/rate', data),
    async health() {
      const res = await fetch(`${base}/health`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(5000) });
      return res.json();
    },
    close: async () => {},
  };
}
