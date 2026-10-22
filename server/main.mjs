// Runs the website with accounts: the built site/ (npm run web:build) plus the account API (server/app.mjs).
//   node server/main.mjs [--port 8790] [--host 127.0.0.1] [--site site] [--db .data/accounts.db] [--cert c.pem --key k.pem]
//                        [--card-library .data/card-library | none]
// With --cert/--key it serves HTTPS (needed off localhost: the game checks its release with WebCrypto, which browsers
// only expose in secure contexts) and marks the session cookie Secure.
// The card library is the index scripts/build-card-library.mjs builds (default .data/card-library when it exists);
// without one the 卡牌库 offers the reviewed release's printings only.
// Accounts: npm run user -- add <name> --admin (scripts/user-admin.mjs).
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createApp } from './app.mjs';
import { openStore } from './store.mjs';
import { loadRelease, ROOT } from './catalog.mjs';
import { loadLibrary } from './library.mjs';

const { values: opt } = parseArgs({ options: {
  port: { type: 'string', default: process.env.PORT || '8790' },
  host: { type: 'string', default: process.env.HOST || '127.0.0.1' },
  site: { type: 'string', default: process.env.SITE_DIR || join(ROOT, 'site') },
  db: { type: 'string', default: process.env.DB_PATH || join(ROOT, '.data', 'accounts.db') },
  cert: { type: 'string', default: process.env.TLS_CERT },
  key: { type: 'string', default: process.env.TLS_KEY },
  'card-library': { type: 'string', default: process.env.CARD_LIBRARY_DIR || join(ROOT, '.data', 'card-library') },
} });

const store = openStore(opt.db);
const secure = !!(opt.cert && opt.key);
const release = await loadRelease(), index = await release.index();
const libraryDir = opt['card-library'] !== 'none' && existsSync(join(opt['card-library'], 'index.json')) ? opt['card-library'] : null;
const presentation = JSON.parse(await readFile(join(ROOT, 'public/data/cn/V20261019/decks.json'), 'utf8')).cards;
const library = await loadLibrary({ dir: libraryDir, index, presentation });
const app = createApp({ store, site: opt.site, release, index, library, secure });
const server = secure
  ? createHttpsServer({ cert: await readFile(opt.cert), key: await readFile(opt.key) }, app)
  : createHttpServer(app);
server.listen(Number(opt.port), opt.host, () => {
  console.log(`Website: ${secure ? 'https' : 'http'}://${opt.host}:${opt.port}/  (site ${opt.site}, accounts ${opt.db}, `
    + `${library.cards.length} library cards from ${library.source})`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { store.close(); process.exit(0); }));
