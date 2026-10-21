// Runs the website with accounts: the built site/ (npm run web:build) plus the account API (server/app.mjs).
//   node server/main.mjs [--port 8790] [--host 127.0.0.1] [--site site] [--db .data/accounts.db] [--cert c.pem --key k.pem]
// With --cert/--key it serves HTTPS (needed off localhost: the game checks its release with WebCrypto, which browsers
// only expose in secure contexts) and marks the session cookie Secure.
// Accounts: npm run user -- add <name> --admin (scripts/user-admin.mjs).
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createApp } from './app.mjs';
import { openStore } from './store.mjs';
import { loadCatalog, ROOT } from './catalog.mjs';

const { values: opt } = parseArgs({ options: {
  port: { type: 'string', default: process.env.PORT || '8790' },
  host: { type: 'string', default: process.env.HOST || '127.0.0.1' },
  site: { type: 'string', default: process.env.SITE_DIR || join(ROOT, 'site') },
  db: { type: 'string', default: process.env.DB_PATH || join(ROOT, '.data', 'accounts.db') },
  cert: { type: 'string', default: process.env.TLS_CERT },
  key: { type: 'string', default: process.env.TLS_KEY },
} });

const store = openStore(opt.db);
const secure = !!(opt.cert && opt.key);
const app = createApp({ store, site: opt.site, catalog: await loadCatalog(), secure });
const server = secure
  ? createHttpsServer({ cert: await readFile(opt.cert), key: await readFile(opt.key) }, app)
  : createHttpServer(app);
server.listen(Number(opt.port), opt.host, () => {
  console.log(`Website: ${secure ? 'https' : 'http'}://${opt.host}:${opt.port}/  (site ${opt.site}, accounts ${opt.db})`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { store.close(); process.exit(0); }));
