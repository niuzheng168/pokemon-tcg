// The AI server for the A100 box: difficulty levels and the advisor over a pool of search workers (ai/service.mjs).
// Listens on localhost only; the website reaches it through an SSH tunnel (server/main.mjs --ai-url).
//   node scripts/ai-server.mjs [--port 8020] [--host 127.0.0.1] [--workers N]     ($AI_TOKEN: require a Bearer token)
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { loadRelease } from '../server/catalog.mjs';
import { createAIService, defaultWorkers } from '../ai/service.mjs';
import { aiHandler } from '../ai/http.mjs';

const { values: opt } = parseArgs({ options: {
  port: { type: 'string', default: process.env.AI_PORT || '8020' },
  host: { type: 'string', default: process.env.AI_HOST || '127.0.0.1' },
  workers: { type: 'string', default: process.env.AI_WORKERS || String(defaultWorkers()) },
} });
const release = await loadRelease();
const service = createAIService({ release, workers: Number(opt.workers) });
const server = createServer(aiHandler(service, { token: process.env.AI_TOKEN || null }));
server.listen(Number(opt.port), opt.host, () =>
  console.log(`AI server: http://${opt.host}:${server.address().port}/  (release ${release.releaseId}, ${service.workers} workers)`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(async () => { await service.close(); process.exit(0); }));
