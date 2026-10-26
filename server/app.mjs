// The website server: serves the built site/ and the account API. Every page and file needs a signed-in user,
// except the login page and the few files it loads.
//   GET  /api/auth/options                         → {registration}  (whether new accounts may sign up; the login page asks)
//   POST /api/auth/register {username, password}   → {user}   (also signs in; a 403 when registration is closed)
//   POST /api/auth/login {username, password}      → {user}
//   POST /api/auth/logout                          → {}
//   GET  /api/auth/me                              → {user}
//   POST /api/auth/password {current, password}    → {}       (signs out the user's other sessions)
//   GET  /api/library                              → {cards: [library entry]}  (server/library.mjs; also the card images)
//   GET  /api/decks                                → {decks: [deck]}
//   POST /api/decks {name, format, cards}          → {deck}
//   GET|PUT|DELETE /api/decks/:id                  → {deck} | {deck} | {}
//   GET  /api/admin/users                          → {users}  (admin)
//   PATCH /api/admin/users/:id {role?, password?}  → {user}   (admin)
//   DELETE /api/admin/users/:id                    → {}       (admin)
//   POST /api/matches {setup}                      → {match}  (admin: a record from elsewhere, an import)
//   POST /api/matches/:id/steps {steps, status?, result?, turn?}  → {added, steps}  (its player: 'error' steps only)
//   GET  /api/matches[?all=1]                      → {matches}  (your games, newest first; all=1: everyone's, admin)
//   GET  /api/matches/:id                          → {match, steps}  (its player or an admin)
//   POST /api/bug-reports {description, matchId?, replay?, move?, turn?, page?, log?, state?}  → {report: {id}}
//   /api/play…                                     the table's games played on the server (server/play.mjs; the routes
//                                                  are listed where they are answered below)
// A match record is how a game at the table can be replayed (public/replay.js, scripts/match.mjs): setup
// {releaseId, seed, format, matchMode, decks: [{id, name, cards: [printingId × 60]}, …], takeover?} and steps, each
// {key, step} with step.type one of STEP_TYPES; the server adds the site build (site/play/build.json) and the browser.
// The table's games are played and recorded here (server/play.mjs): a player adds only the browser's errors to the
// record of a game of theirs; its moves, its status and its result are the server's.
// Only an administrator's game may hold 'edit' steps (the 调试台, public/debug-console.js); the list counts them as
// `edits`. takeover {match, move}: the game was taken over from that game's replay at that move (ui.js takeOver), its
// steps starting with that game's first moves. With `matchFiles` every record is also a file in the replay directory,
// kept up to date; a bug report is a file in the bug-report directory, with the record of the game it names
// (server/record-files.mjs).
// A deck is {id, name, format: 'standard'|'open', cards: [[cardId, count], …], count, legal, issues, createdAt,
// updatedAt}, its cards from the card library; drafts and lists with cards not implemented yet may be saved, and only
// a legal deck can be played. Other /api/ paths answer like a static host
// (a non-JSON 404), so the table's decision-engine client (api.js) keeps using its built-in CPU engine.
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { checkIndexedDeck, deckCount, DECK_SIZE, FORMAT_IDS } from '../public/deck-check.js';
import { SESSION_DAYS } from './store.mjs';
import { implementationSummaryFromIndex } from '../public/card-quality.js';
import { catalogReleaseReceipt } from '../public/rules/catalog-release.js';
import { releaseFiles } from './release-files.mjs';
import { releaseIdentity } from '../public/release-identity.js';
import { createPlay, PlayError } from './play.mjs';
import { EngineCallError } from './engine-pool.mjs';
import { LEVELS } from '../ai/agents.mjs';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml' };
// Reachable without signing in: the login page and what it loads.
const PUBLIC_FILES = new Set(['/play/login.html', '/play/account.js', '/play/account.css', '/play/style.css',
  '/play/img/academy-logo.svg', '/robots.txt', '/404.html']);
const PUBLIC_DIRS = ['/play/vendor/'];
export const LOGIN_PAGE = '/play/login.html';

export const USERNAME = /^[\p{L}\p{N}_-]{2,20}$/u;
export const PASSWORD_MIN = 8, PASSWORD_MAX = 128;
const NAME_MAX = 40, MAX_DECKS = 100, BODY_LIMIT = 64 * 1024;
// A batch of match steps may carry a full kernel snapshot (a few hundred KB late in a game).
const STEPS_LIMIT = 8 * 1024 * 1024, STEPS_PER_BATCH = 500, MATCHES_LISTED = 100;
export const STEP_TYPES = ['action', 'rejected', 'rewind', 'error', 'snapshot', 'end', 'edit'];
const MATCH_STATUS = ['playing', 'over', 'abandoned'];
// Bug reports: the player's description, the table's log lines sent with it, and reports per player per hour.
const AI_PER_USER = 2;
const REPORT_TEXT_MAX = 4000, REPORT_LOG_MAX = 1000, REPORT_LINE_MAX = 2000, REPORTS_PER_HOUR = 30;
const COOKIE = 'sid';
// Failed sign-ins per address and name: after LOCK_AFTER failures within LOCK_MS, that pair waits LOCK_MS.
const LOCK_AFTER = 5, LOCK_MS = 15 * 60_000;
// New accounts per address per hour.
const REGISTER_PER_HOUR = 10;

class HttpError extends Error {
  constructor(status, message, code = null) { super(message); this.status = status; this.code = code; }
}
const fail = (status, message, code = null) => { throw new HttpError(status, message, code); };

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); // session tokens are base64url: nothing to decode
  }
  return out;
}

async function readJSON(req, limit = BODY_LIMIT) {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) fail(415, '请求格式需要是 JSON。');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail(413, '请求内容太大。');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch { /* fall through */ }
  fail(400, '请求内容不是有效的 JSON 对象。');
}

function checkUsername(username) {
  if (typeof username !== 'string' || !USERNAME.test(username)) fail(400, '用户名需要 2–20 个字符，只能包含中英文、数字、下划线或连字符。');
  return username;
}
function checkPassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX)
    fail(400, `密码需要 ${PASSWORD_MIN}–${PASSWORD_MAX} 个字符。`);
  return password;
}

const LIBRARY_IMAGE = /^\/play\/library\/(thumb|image)\/([^/]+)$/;

const isObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const shortText = (x, max = 200) => typeof x === 'string' && x.length > 0 && x.length <= max;
const isUint32 = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;

// What a game at the table needs to be played again: the kernel replays it from these and the recorded steps.
function setupIn(body) {
  const s = body.setup;
  if (!isObject(s) || !shortText(s.releaseId) || !shortText(s.matchMode, 40) || !isObject(s.format) || !shortText(s.format.id, 40))
    fail(400, '对局设置格式不正确。');
  if (!Array.isArray(s.seed) || s.seed.length !== 4 || !s.seed.every(isUint32)) fail(400, '随机种子格式不正确。');
  if (!Array.isArray(s.decks) || s.decks.length !== 2) fail(400, '对局需要双方的卡组。');
  const decks = s.decks.map((d) => {
    if (!isObject(d) || !shortText(d.id, 100) || !shortText(d.name, 100) || !Array.isArray(d.cards) || d.cards.length > DECK_SIZE ||
      !d.cards.every((id) => shortText(id, 100))) fail(400, '对局卡组格式不正确。');
    return { id: d.id, name: d.name, cards: d.cards };
  });
  let clientApproval = null;
  if (s.approval !== undefined) {
    const fields = ['releaseId', 'manifestSha256', 'catalogId', 'kernelSha256', 'schemaSha256', 'rulesSha256'];
    if (!isObject(s.approval) || fields.some((key) => !shortText(s.approval[key])))
      fail(400, '对局发布凭据格式不正确。');
    clientApproval = Object.fromEntries(fields.map((key) => [key, s.approval[key]]));
  }
  let takeover = null;
  if (s.takeover !== undefined && s.takeover !== null) {
    const { match, move } = isObject(s.takeover) ? s.takeover : {};
    if (!(Number.isInteger(match) && match > 0 && Number.isInteger(move) && move >= 0)) fail(400, '接管来源格式不正确。');
    takeover = { match, move };
  }
  return { releaseId: s.releaseId, seed: s.seed, format: s.format, matchMode: s.matchMode, decks, clientApproval, ...(takeover && { takeover }) };
}

// A bug report as the table sends it; the server adds who sent it, when, the build and the game's record.
function reportIn(body) {
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (!description || [...description].length > REPORT_TEXT_MAX) fail(400, `请描述遇到的问题（最多 ${REPORT_TEXT_MAX} 字）。`);
  const count = (n) => n === undefined || n === null || (Number.isInteger(n) && n >= 0);
  if (!count(body.move) || !count(body.turn)) fail(400, '对局位置格式不正确。');
  if (body.matchId != null && !(Number.isInteger(body.matchId) && body.matchId > 0)) fail(400, '对局编号格式不正确。');
  if (body.state != null && !isObject(body.state)) fail(400, '局面格式不正确。');
  if (body.log !== undefined && !(Array.isArray(body.log) && body.log.length <= REPORT_LOG_MAX
    && body.log.every((line) => typeof line === 'string' && line.length <= REPORT_LINE_MAX))) fail(400, '日志格式不正确。');
  return { description, matchId: body.matchId ?? null, replay: body.replay === true, move: body.move ?? null, turn: body.turn ?? null,
    page: typeof body.page === 'string' ? body.page.slice(0, 500) : null, log: body.log ?? [], state: body.state ?? null };
}

function stepsIn(body) {
  if (!Array.isArray(body.steps) || body.steps.length > STEPS_PER_BATCH) fail(400, `每次最多上传 ${STEPS_PER_BATCH} 条对局记录。`);
  return body.steps.map((s) => {
    if (!isObject(s) || !shortText(s.key, 80) || !isObject(s.step) || !STEP_TYPES.includes(s.step.type)) fail(400, '对局记录格式不正确。');
    return { key: s.key, step: s.step };
  });
}

// `library`: server/library.mjs loadLibrary over the same `catalog`. `matchFiles` / `bugReports`: the replay and
// bug-report directories (server/record-files.mjs); without them no record files are kept and reports are refused.
// `engines`: the engine pool (server/engine-pool.mjs) the table's games are played in, with `presets` (decks.json's
// decks); without it /api/play answers 503. `registration: false` closes sign-up: accounts are then added with
// npm run user -- add (scripts/user-admin.mjs).
export function createApp({ store, site, release, index, library, secure = false, matchFiles = null, bugReports = null, ai = null,
  engines = null, presets = [], testSeeds = false, registration = true }) {
  const root = resolve(site);
  const failures = new Map(), registrations = new Map(), reports = new Map();
  const thinking = new Map(); // AI requests each user has in flight
  // Whether the AI answers: always here; an AI server (which must run this release and kernel) is asked at most every 15 s.
  let aiChecked = { at: 0, ok: false };
  async function aiAnswers() {
    if (!ai.health) return true;
    if (Date.now() - aiChecked.at < 15_000) return aiChecked.ok;
    const ok = await ai.health().then((h) => h.releaseId === release.releaseId && h.manifestSha256 === release.manifestSha256, () => false);
    aiChecked = { at: Date.now(), ok };
    return ok;
  }

  const deckOut = async (deck) => ({ ...deck, ...await checkIndexedDeck(release, index, deck.cards, deck.format, library.pool) });
  // A game of the server's (server/play.mjs) keeps its seed to itself until it is over: its player sees the moves only.
  const shown = (match, user) => (!match.setup.server || match.status !== 'playing' || user.role === 'admin' ? match
    : { ...match, setup: { ...match.setup, seed: null } });
  // One AI request at a time per user (two in flight at most).
  async function thinkingFor(user, fn) {
    if ((thinking.get(user.id) ?? 0) >= AI_PER_USER) fail(429, 'AI 还在计算上一个请求，请稍候。');
    thinking.set(user.id, (thinking.get(user.id) ?? 0) + 1);
    try { return await fn(); } finally { thinking.set(user.id, thinking.get(user.id) - 1); }
  }
  const sendReleaseFile = releaseFiles();
  // The build the site was made from (scripts/build-web.mjs), stamped on each new match.
  const siteBuild = () => readFile(resolve(root, 'play', 'build.json'), 'utf8').then(JSON.parse).catch(() => null);
  // Your own match, or anyone's for an administrator (who may read, not add to it).
  function matchFor(user, id, { write = false } = {}) {
    const match = store.getMatch(id);
    if (!match || (match.userId !== user.id && (write || user.role !== 'admin'))) fail(404, '找不到这局对战。');
    return match;
  }
  // The match's file in the replay directory follows the database; a failure there is logged and the game goes on.
  const keepFile = (id) => matchFiles?.save(id).catch((error) => console.error(`Replay file of match #${id}: ${error.message}`));
  const play = engines && createPlay({ store, release, index, pool: engines, presets, ai, aiReady: () => !!ai && aiAnswers(),
    checkDeck: (cards, format) => checkIndexedDeck(release, index, cards, format, library.pool), onRecord: keepFile, anySeed: testSeeds });
  const needPlay = () => play ?? fail(503, '服务器没有启用对战引擎。');
  // A play request: the service's refusals keep their status and code; the engine's are a 409 (a stale or refused
  // command), a 503 (a worker that stopped) or a 500.
  async function playCall(fn) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof PlayError) fail(error.status, error.message, error.code);
      if (error instanceof EngineCallError) {
        if (error.code === 'engine-crashed') fail(503, '对战引擎暂时不可用，请重试。', error.code);
        if (error.code === 'internal') throw error;
        fail(error.code === 'bad-request' ? 400 : 409, error.message, error.code);
      }
      throw error;
    }
  }
  function deckIn(body) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || [...name].length > NAME_MAX) fail(400, `卡组名称需要 1–${NAME_MAX} 个字。`);
    if (!FORMAT_IDS.includes(body.format)) fail(400, '赛制只能是标准赛或开放赛。');
    if (!Array.isArray(body.cards)) fail(400, '卡组内容格式不正确。');
    const counts = new Map();
    for (const entry of body.cards) {
      const [id, n] = Array.isArray(entry) ? entry : [];
      if (!library.pool.byId.has(id)) fail(400, `卡牌库里没有这张卡：${String(id)}。`);
      if (!Number.isInteger(n) || n < 1 || n > DECK_SIZE) fail(400, '每张卡的数量需要是 1–60 的整数。');
      counts.set(id, (counts.get(id) ?? 0) + n);
    }
    const cards = [...counts];
    if (deckCount(cards) > DECK_SIZE) fail(400, `卡组最多 ${DECK_SIZE} 张卡。`);
    return { name, format: body.format, cards };
  }

  function sessionCookie(token, maxAge) {
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }
  function signIn(res, user) {
    res.setHeader('Set-Cookie', sessionCookie(store.createSession(user.id), SESSION_DAYS * 86400));
    return { user };
  }

  function lockedOut(key) {
    const f = failures.get(key);
    if (f && Date.now() - f.since > LOCK_MS) { failures.delete(key); return false; }
    return !!f && f.count >= LOCK_AFTER;
  }
  function noteFailure(key) {
    if (failures.size > 10_000) for (const [k, f] of failures) if (Date.now() - f.since > LOCK_MS) failures.delete(k);
    const f = failures.get(key) ?? { count: 0, since: Date.now() };
    f.count++;
    failures.set(key, f);
  }

  // ---------------- API ----------------
  async function api(req, res, path, ctx) {
    const { method } = req;
    const parts = path.split('/').filter(Boolean).slice(1); // after 'api'
    const route = `${method} /${parts.map((p) => (/^\d+$/.test(p) ? ':id' : p)).join('/')}`;
    const id = Number(parts.find((p) => /^\d+$/.test(p)));
    const needUser = () => ctx.user ?? fail(401, '请先登录。');
    const needAdmin = () => (needUser().role === 'admin' ? ctx.user : fail(403, '只有管理员可以这样做。'));

    switch (route) {
      case 'GET /auth/options':
        return { registration };
      case 'POST /auth/register': {
        if (!registration) fail(403, '网站暂不开放注册，请联系管理员开通账号。', 'registration-closed');
        const body = await readJSON(req);
        const username = checkUsername(body.username), password = checkPassword(body.password);
        const hour = registrations.get(ctx.ip)?.filter((t) => Date.now() - t < 3600_000) ?? [];
        if (hour.length >= REGISTER_PER_HOUR) fail(429, '注册太频繁，请稍后再试。');
        if (store.userByName(username)) fail(409, '这个用户名已经被注册了。');
        let user;
        try {
          user = await store.createUser({ username, password });
        } catch (error) {
          if (/UNIQUE/.test(error.message)) fail(409, '这个用户名已经被注册了。');
          throw error;
        }
        if (registrations.size > 10_000) registrations.clear();
        registrations.set(ctx.ip, [...hour, Date.now()]);
        res.statusCode = 201;
        return signIn(res, user);
      }
      case 'POST /auth/login': {
        const body = await readJSON(req);
        if (typeof body.username !== 'string' || typeof body.password !== 'string') fail(400, '请输入用户名和密码。');
        const key = `${ctx.ip}|${body.username.toLowerCase()}`;
        if (lockedOut(key)) fail(429, '登录失败次数太多，请 15 分钟后再试。');
        const user = await store.checkPassword(body.username, body.password);
        if (!user) { noteFailure(key); fail(401, '用户名或密码不正确。'); }
        failures.delete(key);
        return signIn(res, user);
      }
      case 'POST /auth/logout':
        if (ctx.token) store.deleteSession(ctx.token);
        res.setHeader('Set-Cookie', sessionCookie('', 0));
        return {};
      case 'GET /auth/me':
        return { user: needUser() };
      case 'POST /auth/password': {
        const user = needUser(), body = await readJSON(req);
        const password = checkPassword(body.password);
        if (typeof body.current !== 'string' || !(await store.checkPassword(user.username, body.current))) fail(400, '当前密码不正确。');
        await store.setPassword(user.id, password);
        store.deleteUserSessions(user.id, ctx.token);
        return {};
      }

      case 'GET /decks':
        return { decks: await Promise.all(store.listDecks(needUser().id).map(deckOut)) };
      case 'POST /decks': {
        const user = needUser(), deck = deckIn(await readJSON(req));
        if (store.countDecks(user.id) >= MAX_DECKS) fail(400, `每位用户最多保存 ${MAX_DECKS} 套卡组。`);
        res.statusCode = 201;
        return { deck: await deckOut(store.createDeck(user.id, deck)) };
      }
      case 'GET /decks/:id': {
        const deck = store.getDeck(needUser().id, id) ?? fail(404, '找不到这套卡组。');
        return { deck: await deckOut(deck) };
      }
      case 'PUT /decks/:id': {
        const user = needUser(), deck = deckIn(await readJSON(req));
        return { deck: await deckOut(store.updateDeck(user.id, id, deck) ?? fail(404, '找不到这套卡组。')) };
      }
      case 'DELETE /decks/:id':
        if (!store.deleteDeck(needUser().id, id)) fail(404, '找不到这套卡组。');
        return {};

      case 'POST /matches': {
        const user = needAdmin(), setup = setupIn(await readJSON(req));
        if (setup.takeover) matchFor(user, setup.takeover.match); // only a game you may replay can be taken over
        const ids = setup.decks.flatMap((d) => d.cards);
        setup.implementation = implementationSummaryFromIndex(index, ids);
        // Keep diagnostic records for incomplete/unknown decks, but never
        // attach an approval pretending those cards were independently loaded.
        setup.approval = ids.length && !setup.implementation.unimplementedPrintings.length
          ? releaseIdentity(catalogReleaseReceipt(await release.catalogFor(ids))) : null;
        setup.compatibility = !setup.clientApproval || !setup.approval ? null : {
          catalogMatches: setup.clientApproval.catalogId === setup.approval.catalogId,
          manifestMatches: setup.clientApproval.manifestSha256 === setup.approval.manifestSha256,
        };
        const match = store.createMatch(user.id, { setup, build: await siteBuild(), userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300) });
        await keepFile(match.id);
        res.statusCode = 201;
        return { match };
      }
      case 'POST /matches/:id/steps': {
        const user = needUser(), body = await readJSON(req, STEPS_LIMIT);
        matchFor(user, id, { write: true });
        const steps = stepsIn(body);
        if (user.role !== 'admin' && (steps.some((s) => s.step.type !== 'error') || ['status', 'result', 'turn'].some((k) => body[k] !== undefined)))
          fail(403, '对局记录由服务器写，浏览器只能补充报错。');
        if (body.status !== undefined && !MATCH_STATUS.includes(body.status)) fail(400, '对局状态不正确。');
        if (body.result !== undefined && body.result !== null && !isObject(body.result)) fail(400, '对局结果格式不正确。');
        if (body.turn !== undefined && !(Number.isInteger(body.turn) && body.turn >= 0)) fail(400, '回合数不正确。');
        const added = store.appendSteps(id, steps);
        const match = store.updateMatch(id, { status: body.status, result: body.result, turn: body.turn });
        await keepFile(id);
        return { added, steps: match.steps };
      }
      case 'GET /matches': {
        const user = needUser(), all = ctx.url.searchParams.get('all') === '1';
        if (all && user.role !== 'admin') fail(403, '只有管理员可以查看所有人的对局。');
        // The list leaves out the decks' cards; GET /matches/:id has everything.
        const matches = store.listMatches(all ? null : user.id, MATCHES_LISTED).map((m) => shown(m, user))
          .map(({ setup, ...m }) => ({ ...m, setup: { ...setup, decks: setup.decks.map(({ id: deckId, name }) => ({ id: deckId, name })) } }));
        return { matches };
      }
      case 'GET /matches/:id': {
        const user = needUser(), match = matchFor(user, id);
        return { match: shown(match, user), steps: store.matchSteps(id) };
      }

      // 报告问题 at the table: kept as a file with the record of the game it names (one you may replay).
      case 'POST /bug-reports': {
        const user = needUser(), report = reportIn(await readJSON(req, STEPS_LIMIT));
        if (!bugReports) fail(503, '服务器没有设置问题报告目录。');
        const hour = reports.get(user.id)?.filter((t) => Date.now() - t < 3600_000) ?? [];
        if (hour.length >= REPORTS_PER_HOUR) fail(429, '报告太频繁，请稍后再试。');
        const match = report.matchId ? matchFor(user, report.matchId) : null;
        // A game of the server's still on: the state is the server's own, not one the browser sends.
        if (match?.setup.server && match.status === 'playing') report.state = await play?.reportState(user, match.id) ?? null;
        const { log, state, ...about } = report; // the long parts last: the file reads as the report from the top
        const reportId = await bugReports.save({ createdAt: new Date().toISOString(), user: { id: user.id, username: user.username },
          ...about, build: await siteBuild(), userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300), log, state,
          ...(match && { match, steps: store.matchSteps(match.id) }) });
        reports.set(user.id, [...hour, Date.now()]);
        res.statusCode = 201;
        return { report: { id: reportId } };
      }

      // ---- The table's games on the server (server/play.mjs): the browser sends commands and gets its own view ----
      //   POST /api/play {deck, opponent?, level?, seed?}  → {match, status, view, events, cursor}   a new game (seed: admins)
      //   GET  /api/play/current                    → {match | null, …}  the player's game still on (a reload)
      //   GET  /api/play/:id?cursor=                → {status, view, events, cursor, reset?, undo}
      //   POST /api/play/:id/move {revision, action, cursor}  → the view after it, {quiet, undo}
      //   POST /api/play/:id/cpu {revision, cursor}  → 小茂's move and the view after it, {ai: {value, error}}
      //   POST /api/play/:id/preview {revision, action} → {pending}   a Tool's targets
      //   POST /api/play/:id/undo                   → the view again (reset)
      //   POST /api/play/:id/rate {actions}         → the Professor's estimates
      //   POST /api/play/:id/abandon                → {}
      //   POST /api/play/takeover {match, move}     → {match}   a game over, played again up to a move as a new game
      //   GET|POST /api/play/:id/state              → the whole state / an edit (administrators: 调试台)
      case 'POST /play': {
        const user = needUser(), body = await readJSON(req);
        const meta = { build: await siteBuild(), userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300) };
        const out = await playCall(() => needPlay().create(user, { deck: body.deck, opponent: body.opponent, level: body.level ?? null,
          seed: body.seed ?? null }, meta));
        res.statusCode = 201;
        return out;
      }
      case 'GET /play/current':
        return playCall(() => needPlay().current(needUser()));
      case 'GET /play/:id':
        return playCall(() => needPlay().view(needUser(), id, ctx.url.searchParams.get('cursor')));
      case 'POST /play/:id/move': {
        const user = needUser(), body = await readJSON(req);
        return playCall(() => needPlay().move(user, id, body));
      }
      case 'POST /play/:id/cpu': {
        const user = needUser(), body = await readJSON(req);
        return thinkingFor(user, () => playCall(() => needPlay().cpu(user, id, body)));
      }
      case 'POST /play/:id/preview': {
        const user = needUser(), body = await readJSON(req);
        return playCall(() => needPlay().preview(user, id, body));
      }
      case 'POST /play/:id/undo':
        return playCall(() => needPlay().undo(needUser(), id));
      case 'POST /play/:id/rate': {
        const user = needUser(), body = await readJSON(req);
        return thinkingFor(user, () => playCall(() => needPlay().rate(user, id, body)));
      }
      case 'POST /play/:id/abandon':
        return playCall(() => needPlay().abandon(needUser(), id));
      case 'POST /play/takeover': {
        const user = needUser(), body = await readJSON(req);
        res.statusCode = 201;
        return playCall(() => needPlay().takeover(user, { match: body.match, move: body.move }));
      }
      case 'GET /play/:id/state':
        needAdmin();
        return playCall(() => needPlay().state(id));
      case 'POST /play/:id/state': {
        const admin = needAdmin(), body = await readJSON(req, STEPS_LIMIT);
        return playCall(() => needPlay().edit(admin, id, body));
      }

      // 小茂's difficulty levels and the advisor (ai/service.mjs here, or the AI server it forwards to). The table's games
      // ask the AI through /api/play with the server's own state; a state from a browser is an administrator's tool. The
      // search uses only what the deciding player could know.
      case 'GET /engine': {
        needUser();
        const ready = !!ai && await aiAnswers();
        return { engine: ready ? 'search' : 'cpu', ready, where: ai ? (ai.remote ? 'remote' : 'local') : null,
          levels: LEVELS.map(({ level, name }) => ({ level, name })) };
      }
      case 'POST /decide': case 'POST /rate': {
        const user = needAdmin(), body = await readJSON(req, STEPS_LIMIT);
        if (!ai) fail(503, '服务器没有启用对战 AI。');
        if ((thinking.get(user.id) ?? 0) >= AI_PER_USER) fail(429, 'AI 还在计算上一个请求，请稍候。');
        thinking.set(user.id, (thinking.get(user.id) ?? 0) + 1);
        try {
          const { snapshot, player } = body;
          return route === 'POST /decide'
            ? await ai.decide({ snapshot, player, level: Number(body.level ?? 2), turnMoves: Number(body.turnMoves ?? 0) })
            : await ai.rate({ snapshot, player, actions: body.actions });
        } catch (error) {
          if (error instanceof HttpError) throw error;
          fail(error.status ?? 500, error.message);
        } finally {
          thinking.set(user.id, thinking.get(user.id) - 1);
        }
      }

      case 'GET /admin/users':
        needAdmin();
        return { users: store.listUsers() };
      case 'PATCH /admin/users/:id': {
        const admin = needAdmin(), body = await readJSON(req);
        const user = store.userById(id) ?? fail(404, '找不到这个用户。');
        if (body.role !== undefined) {
          if (!['user', 'admin'].includes(body.role)) fail(400, '角色只能是普通用户或管理员。');
          if (user.id === admin.id && body.role !== 'admin') fail(400, '不能取消自己的管理员身份。');
          store.setRole(user.id, body.role);
        }
        if (body.password !== undefined) {
          await store.setPassword(user.id, checkPassword(body.password));
          store.deleteUserSessions(user.id, user.id === admin.id ? ctx.token : '');
        }
        return { user: store.userById(id) };
      }
      case 'DELETE /admin/users/:id': {
        const admin = needAdmin();
        if (id === admin.id) fail(400, '不能删除自己的账户。');
        if (!store.deleteUser(id)) fail(404, '找不到这个用户。');
        return {};
      }
    }
    return undefined;
  }

  // ---------------- Static site ----------------
  async function file(req, res, path, ctx) {
    const isPublic = PUBLIC_FILES.has(path) || PUBLIC_DIRS.some((d) => path.startsWith(d));
    if (!ctx.user && !isPublic) {
      const page = path.endsWith('/') || path.endsWith('.html') || (req.headers.accept ?? '').includes('text/html');
      if (page) {
        res.writeHead(302, { Location: `${LOGIN_PAGE}?next=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`, 'Cache-Control': 'no-store' });
        return res.end();
      }
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('请先登录。');
    }
    const image = LIBRARY_IMAGE.exec(path);
    if (image) return library.sendImage(req, res, image[1], image[2]);
    let target = resolve(root, '.' + path);
    if (target !== root && !target.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    const info = await stat(target).catch(() => null);
    if (info?.isDirectory()) {
      if (!path.endsWith('/')) {
        res.writeHead(301, { Location: path + '/' + ctx.url.search });
        return res.end();
      }
      target = resolve(target, 'index.html');
    }
    if (await sendReleaseFile(req, res, target, path)) return;
    const body = await readFile(target).catch(() => null);
    if (!body) {
      res.writeHead(404, { 'Content-Type': TYPES['.html'] });
      return res.end(await readFile(resolve(root, '404.html')).catch(() => 'Not found'));
    }
    const type = TYPES[extname(target)] ?? 'application/octet-stream';
    // Pages depend on who is signed in: never let a cache answer for the server.
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': type.startsWith('text/html') ? 'no-store' : 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  return async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    try {
      const url = new URL(req.url, 'http://localhost');
      let path;
      try { path = decodeURIComponent(url.pathname); } catch { fail(400, '地址无效。'); }
      // Check the DECODED path before public-prefix admission. An encoded
      // slash in /play/vendor/..%2fdata must not turn protected release files
      // into a public vendor asset after filesystem normalization.
      if (path.includes('\\') || path.includes('\0') || path.split('/').some((part) => part === '.' || part === '..'))
        fail(403, '拒绝非规范文件路径。');
      const token = cookies(req)[COOKIE] || null;
      const ctx = { url, token, user: store.sessionUser(token), ip: req.socket.remoteAddress ?? '' };
      if (path === '/api/library' && ['GET', 'HEAD'].includes(req.method)) {
        if (!ctx.user) fail(401, '请先登录。');
        return library.send(req, res);
      }
      if (path.startsWith('/api/')) {
        // A request that changes something must come from this site: a JSON body (which a cross-site form cannot
        // send) and, when the browser says where it came from, this host.
        if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin && URL.parse(req.headers.origin)?.host !== req.headers.host)
          fail(403, '拒绝跨站请求。');
        const out = await api(req, res, path, ctx);
        if (out === undefined) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('Not found');
        }
        res.writeHead(res.statusCode || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(out));
      }
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
      await file(req, res, path, ctx);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      if (res.headersSent) return res.end();
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: status === 500 ? '服务器出错了，请稍后再试。' : error.message,
        ...(status !== 500 && error.code ? { code: error.code } : {}) }));
    }
  };
}
