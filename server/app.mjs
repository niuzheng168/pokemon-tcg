// The website server: serves the built site/ and the account API. Every page and file needs a signed-in user,
// except the login page and the few files it loads.
//   POST /api/auth/register {username, password}   → {user}   (also signs in)
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
//   POST /api/matches {setup}                      → {match}  (a game starts at the table)
//   POST /api/matches/:id/steps {steps, status?, result?, turn?}  → {added, steps}  (the game's record so far)
//   GET  /api/matches[?all=1]                      → {matches}  (your games, newest first; all=1: everyone's, admin)
//   GET  /api/matches/:id                          → {match, steps}  (its player or an admin)
// A match record is how a game at the table can be replayed (public/replay.js, scripts/match.mjs): setup
// {releaseId, seed, format, matchMode, decks: [{id, name, cards: [printingId × 60]}, …]} and steps, each {key, step}
// with step.type one of STEP_TYPES; the server adds the site build (site/play/build.json) and the browser. Only an
// administrator's game may hold 'edit' steps (the 调试台, public/debug-console.js); the list counts them as `edits`.
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
const COOKIE = 'sid';
// Failed sign-ins per address and name: after LOCK_AFTER failures within LOCK_MS, that pair waits LOCK_MS.
const LOCK_AFTER = 5, LOCK_MS = 15 * 60_000;
// New accounts per address per hour.
const REGISTER_PER_HOUR = 10;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

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
  return { releaseId: s.releaseId, seed: s.seed, format: s.format, matchMode: s.matchMode, decks, clientApproval };
}

function stepsIn(body) {
  if (!Array.isArray(body.steps) || body.steps.length > STEPS_PER_BATCH) fail(400, `每次最多上传 ${STEPS_PER_BATCH} 条对局记录。`);
  return body.steps.map((s) => {
    if (!isObject(s) || !shortText(s.key, 80) || !isObject(s.step) || !STEP_TYPES.includes(s.step.type)) fail(400, '对局记录格式不正确。');
    return { key: s.key, step: s.step };
  });
}

// `library`: server/library.mjs loadLibrary over the same `catalog`.
export function createApp({ store, site, release, index, library, secure = false }) {
  const root = resolve(site);
  const failures = new Map(), registrations = new Map();

  const deckOut = async (deck) => ({ ...deck, ...await checkIndexedDeck(release, index, deck.cards, deck.format, library.pool) });
  const sendReleaseFile = releaseFiles();
  // The build the site was made from (scripts/build-web.mjs), stamped on each new match.
  const siteBuild = () => readFile(resolve(root, 'play', 'build.json'), 'utf8').then(JSON.parse).catch(() => null);
  // Your own match, or anyone's for an administrator (who may read, not add to it).
  function matchFor(user, id, { write = false } = {}) {
    const match = store.getMatch(id);
    if (!match || (match.userId !== user.id && (write || user.role !== 'admin'))) fail(404, '找不到这局对战。');
    return match;
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
      case 'POST /auth/register': {
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
        const user = needUser(), setup = setupIn(await readJSON(req));
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
        res.statusCode = 201;
        return { match: store.createMatch(user.id, { setup, build: await siteBuild(), userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300) }) };
      }
      case 'POST /matches/:id/steps': {
        const user = needUser(), body = await readJSON(req, STEPS_LIMIT);
        matchFor(user, id, { write: true });
        const steps = stepsIn(body);
        if (user.role !== 'admin' && steps.some((s) => s.step.type === 'edit')) fail(403, '只有管理员可以修改对局。');
        if (body.status !== undefined && !MATCH_STATUS.includes(body.status)) fail(400, '对局状态不正确。');
        if (body.result !== undefined && body.result !== null && !isObject(body.result)) fail(400, '对局结果格式不正确。');
        if (body.turn !== undefined && !(Number.isInteger(body.turn) && body.turn >= 0)) fail(400, '回合数不正确。');
        const added = store.appendSteps(id, steps);
        const match = store.updateMatch(id, { status: body.status, result: body.result, turn: body.turn });
        return { added, steps: match.steps };
      }
      case 'GET /matches': {
        const user = needUser(), all = ctx.url.searchParams.get('all') === '1';
        if (all && user.role !== 'admin') fail(403, '只有管理员可以查看所有人的对局。');
        // The list leaves out the decks' cards; GET /matches/:id has everything.
        const matches = store.listMatches(all ? null : user.id, MATCHES_LISTED)
          .map(({ setup, ...m }) => ({ ...m, setup: { ...setup, decks: setup.decks.map(({ id: deckId, name }) => ({ id: deckId, name })) } }));
        return { matches };
      }
      case 'GET /matches/:id': {
        const match = matchFor(needUser(), id);
        return { match, steps: store.matchSteps(id) };
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
      res.end(JSON.stringify({ error: status === 500 ? '服务器出错了，请稍后再试。' : error.message }));
    }
  };
}
