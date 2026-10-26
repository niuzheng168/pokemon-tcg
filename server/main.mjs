// Runs the website with accounts: the built site/ (npm run web:build) plus the account API (server/app.mjs).
//   node server/main.mjs [--port 8790] [--host 127.0.0.1] [--site site] [--db .data/accounts.db] [--cert c.pem --key k.pem]
//                        [--card-library .data/card-library | none]
//                        [--replay-dir .data/replays] [--bug-report-dir .data/bug-reports]
//                        [--ai-url http://127.0.0.1:8020 | --ai-workers N | --ai-workers 0] [--engine-workers N]
//                        [--test-seeds] [--registration open|closed]
// With --cert/--key it serves HTTPS (needed off localhost: the game checks its release with WebCrypto, which browsers
// only expose in secure contexts) and marks the session cookie Secure.
// The card library is the index scripts/build-card-library.mjs builds (default .data/card-library when it exists);
// without one the 卡牌库 offers the reviewed release's printings only.
// Every game's record is also a file in the replay directory ($REPLAY_DIR), and 报告问题 at the table writes its report
// to the bug-report directory ($BUG_REPORT_DIR) (server/record-files.mjs). Games recorded before the replay directory
// was set get their files when the server starts.
// 小茂's difficulty levels and the advisor: with --ai-url ($AI_URL, $AI_TOKEN) the AI server there answers (the A100 box,
// scripts/ai-server.mjs, through an SSH tunnel); otherwise a pool of --ai-workers search threads runs here (0: no AI).
// The table's games are played here (server/play.mjs) in --engine-workers threads of the rules engine ($ENGINE_WORKERS,
// default 2; 0 runs it in this thread), the browser sending its commands only (docs/ENGINE-PROTOCOL.md).
// --test-seeds ($TEST_SEEDS=1) lets any player fix a game's seed (?seed= on the table): for a test server only, since a
// player who knows the seed knows the order of both decks. --port 0 takes a free port (the address is printed).
// Accounts: npm run user -- add <name> --admin (scripts/user-admin.mjs). --registration closed ($REGISTRATION=closed)
// turns sign-up off: the login page offers 登录 only and new accounts are added that way.
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createApp } from './app.mjs';
import { openStore } from './store.mjs';
import { loadRelease, ROOT } from './catalog.mjs';
import { loadLibrary } from './library.mjs';
import { matchFiles, bugReports } from './record-files.mjs';
import { createAIService, defaultWorkers } from '../ai/service.mjs';
import { remoteAI } from '../ai/http.mjs';
import { createEnginePool } from './engine-pool.mjs';

const { values: opt } = parseArgs({ options: {
  port: { type: 'string', default: process.env.PORT || '8790' },
  host: { type: 'string', default: process.env.HOST || '127.0.0.1' },
  site: { type: 'string', default: process.env.SITE_DIR || join(ROOT, 'site') },
  db: { type: 'string', default: process.env.DB_PATH || join(ROOT, '.data', 'accounts.db') },
  cert: { type: 'string', default: process.env.TLS_CERT },
  key: { type: 'string', default: process.env.TLS_KEY },
  'card-library': { type: 'string', default: process.env.CARD_LIBRARY_DIR || join(ROOT, '.data', 'card-library') },
  'replay-dir': { type: 'string', default: process.env.REPLAY_DIR || join(ROOT, '.data', 'replays') },
  'bug-report-dir': { type: 'string', default: process.env.BUG_REPORT_DIR || join(ROOT, '.data', 'bug-reports') },
  'ai-url': { type: 'string', default: process.env.AI_URL },
  'ai-workers': { type: 'string', default: process.env.AI_WORKERS || String(Math.min(defaultWorkers(), 4)) },
  'engine-workers': { type: 'string', default: process.env.ENGINE_WORKERS || '2' },
  'test-seeds': { type: 'boolean', default: process.env.TEST_SEEDS === '1' },
  registration: { type: 'string', default: process.env.REGISTRATION || 'open' },
} });
if (!['open', 'closed'].includes(opt.registration)) {
  console.error(`--registration is open or closed, not ${opt.registration}.`);
  process.exit(2);
}

const store = openStore(opt.db);
const secure = !!(opt.cert && opt.key);
const release = await loadRelease(), index = await release.index();
const libraryDir = opt['card-library'] !== 'none' && existsSync(join(opt['card-library'], 'index.json')) ? opt['card-library'] : null;
const decksJson = JSON.parse(await readFile(join(ROOT, 'public/data/cn/V20261019/decks.json'), 'utf8'));
const presentation = decksJson.cards;
const library = await loadLibrary({ dir: libraryDir, index, presentation });
const replays = matchFiles({ dir: resolve(opt['replay-dir']), store });
const reports = bugReports({ dir: resolve(opt['bug-report-dir']) });
const ai = opt['ai-url'] ? remoteAI(opt['ai-url'], { token: process.env.AI_TOKEN || null })
  : Number(opt['ai-workers']) > 0 ? createAIService({ release, workers: Number(opt['ai-workers']) }) : null;
const engines = createEnginePool({ workers: Number(opt['engine-workers']), release });
const app = createApp({ store, site: opt.site, release, index, library, secure, matchFiles: replays, bugReports: reports, ai,
  engines, presets: decksJson.decks, testSeeds: opt['test-seeds'], registration: opt.registration === 'open' });
const server = secure
  ? createHttpsServer({ cert: await readFile(opt.cert), key: await readFile(opt.key) }, app)
  : createHttpServer(app);
server.listen(Number(opt.port), opt.host, () => {
  console.log(`Website: ${secure ? 'https' : 'http'}://${opt.host}:${server.address().port}/  (site ${opt.site}, accounts ${opt.db}, `
    + `${library.cards.length} library cards from ${library.source})`);
  console.log(`Replays: ${replays.dir}  Bug reports: ${reports.dir}`);
  console.log(`AI: ${!ai ? 'off' : ai.remote ? `AI server ${ai.remote}` : `${ai.workers} search workers here`}`);
  console.log(`Games: played here, ${Number(opt['engine-workers']) || 'no'} engine worker threads${Number(opt['engine-workers']) ? '' : ' (in this thread)'}`);
  if (opt.registration === 'closed') console.log('Registration: closed (npm run user -- add <name> adds accounts).');
  if (opt['test-seeds']) console.log('Seeds: any player may fix a game\'s seed (--test-seeds: a test server only).');
  // The AI server must run this website's release: it rebuilds each game's cards from it.
  ai?.health?.().then((h) => { if (h.releaseId !== release.releaseId || h.manifestSha256 !== release.manifestSha256) console.error(`AI: the AI server runs another release or kernel (${h.releaseId} ${h.manifestSha256?.slice(0, 12)}); update it.`); },
    (error) => console.error(`AI: the AI server does not answer yet (${error.message}); 小茂 plays with the CPU engine until it does.`));
});
replays.backfill().then(
  (n) => { if (n) console.log(`Replays: wrote the files of ${n} earlier games.`); },
  (error) => console.error(`Replays: could not write the earlier games' files: ${error.message}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(async () => { store.close(); await ai?.close(); await engines.close(); process.exit(0); }));
