// The account server (server/app.mjs): sign-up and sign-in, the login gate in front of every page and file,
// the card library and its images, saved decks checked against the library and the reviewed release, the table's
// match records, and the administrator's user management.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/app.mjs';
import { openStore } from '../../server/store.mjs';
import { loadCatalog, ROOT } from '../../server/catalog.mjs';
import { loadLibrary } from '../../server/library.mjs';

const meta = JSON.parse(await readFile(join(ROOT, 'public/data/cn/V20261019/decks.json'), 'utf8'));
const FIXTURE = join(ROOT, 'tests/fixtures/card-library');
const preset = (id) => meta.decks.find((d) => d.id === id);
let server, base, store, site;

before(async () => {
  site = await mkdtemp(join(tmpdir(), 'cn-site-'));
  await mkdir(join(site, 'play', 'vendor'), { recursive: true });
  for (const [f, text] of [['play/index.html', '<p>table</p>'], ['play/login.html', '<p>login</p>'], ['play/style.css', 'body{}'],
    ['play/vendor/fonts.css', '/* fonts */'], ['play/secret.json', '{"a":1}'], ['404.html', '<p>404</p>'],
    ['play/build.json', '{"commit":"0123abc","dirty":false}']])
    await writeFile(join(site, f), text);
  store = openStore(':memory:');
  await store.createUser({ username: 'boss', password: 'admin-pass-1', role: 'admin' });
  const catalog = await loadCatalog();
  const library = await loadLibrary({ dir: FIXTURE, catalog, presentation: meta.cards });
  server = createServer(createApp({ store, site, catalog, library }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  store.close();
  await rm(site, { recursive: true, force: true });
});

// A tiny browser: keeps the session cookie between requests.
function client() {
  let cookie = '';
  const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const r = await fetch(base + path, { method, redirect: 'manual',
      headers: { ...(cookie && { cookie }), ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    const type = r.headers.get('content-type') ?? '';
    return { status: r.status, headers: r.headers, data: type.includes('json') ? await r.json() : await r.text() };
  };
  return { call, cookie: () => cookie };
}

test('every page and file needs a signed-in user, except the login page and what it loads', async () => {
  const anon = client();
  const page = await anon.call('/play/', { headers: { accept: 'text/html' } });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/play/login.html?next=%2Fplay%2F');
  assert.equal((await anon.call('/play/secret.json')).status, 401);
  assert.equal((await anon.call('/api/decks')).status, 401);
  assert.equal((await anon.call('/api/library')).status, 401);
  assert.equal((await anon.call('/play/library/thumb/0123456789abcdef')).status, 401);
  assert.equal((await anon.call('/api/auth/me')).status, 401);
  for (const f of ['/play/login.html', '/play/style.css', '/play/vendor/fonts.css', '/404.html'])
    assert.equal((await anon.call(f)).status, 200, f);
  // A directory without its slash is redirected (once signed in it is served).
  assert.equal((await anon.call('/play', { headers: { accept: 'text/html' } })).status, 302);
  // Forged or malformed session cookies are just "not signed in".
  for (const cookie of ['sid=%E0%A4%A', 'sid=forged-token', 'sid', '=x'])
    assert.equal((await anon.call('/api/auth/me', { headers: { cookie } })).status, 401, cookie);
});

test('a player registers, is signed in, signs out and back in; wrong passwords are throttled', async () => {
  const c = client();
  for (const [username, password] of [['x', 'long-enough-1'], ['bad name!', 'long-enough-1'], ['ash', 'short']]) {
    const r = await c.call('/api/auth/register', { method: 'POST', body: { username, password } });
    assert.equal(r.status, 400, username);
  }
  const reg = await c.call('/api/auth/register', { method: 'POST', body: { username: '小智', password: 'pikachu-123' } });
  assert.equal(reg.status, 201);
  assert.deepEqual([reg.data.user.username, reg.data.user.role], ['小智', 'user']);
  assert.match(reg.headers.get('set-cookie'), /^sid=[\w-]{20,}; Path=\/; HttpOnly; SameSite=Lax/);
  assert.equal((await c.call('/api/auth/me')).data.user.username, '小智');
  assert.equal((await c.call('/play/', { headers: { accept: 'text/html' } })).status, 200);
  assert.equal((await c.call('/play')).status, 301);
  assert.equal((await c.call('/play/..%2f..%2f..%2fetc%2fpasswd')).status, 403);
  // Names are unique regardless of case.
  assert.equal((await client().call('/api/auth/register', { method: 'POST', body: { username: 'BOSS', password: 'whatever-123' } })).status, 409);

  assert.equal((await c.call('/api/auth/logout', { method: 'POST', body: {} })).status, 200);
  assert.equal((await c.call('/api/auth/me')).status, 401);
  const wrong = await c.call('/api/auth/login', { method: 'POST', body: { username: '小智', password: 'nope-nope' } });
  assert.deepEqual([wrong.status, wrong.data.error], [401, '用户名或密码不正确。']);
  const ok = await c.call('/api/auth/login', { method: 'POST', body: { username: '小智', password: 'pikachu-123' } });
  assert.equal(ok.status, 200);

  const t = client();
  for (let i = 0; i < 5; i++) await t.call('/api/auth/login', { method: 'POST', body: { username: '小智', password: 'guess-' + i } });
  const locked = await t.call('/api/auth/login', { method: 'POST', body: { username: '小智', password: 'pikachu-123' } });
  assert.equal(locked.status, 429);
});

test('changing the password needs the current one and signs out the other sessions', async () => {
  const a = client(), b = client();
  await a.call('/api/auth/register', { method: 'POST', body: { username: 'misty', password: 'staryu-123' } });
  await b.call('/api/auth/login', { method: 'POST', body: { username: 'misty', password: 'staryu-123' } });
  assert.equal((await a.call('/api/auth/password', { method: 'POST', body: { current: 'wrong-123', password: 'starmie-456' } })).status, 400);
  assert.equal((await a.call('/api/auth/password', { method: 'POST', body: { current: 'staryu-123', password: 'starmie-456' } })).status, 200);
  assert.equal((await a.call('/api/auth/me')).status, 200);
  assert.equal((await b.call('/api/auth/me')).status, 401);
});

test('saved decks: drafts are kept with their problems, legal lists are marked playable, and only by their owner', async () => {
  const c = client(), other = client();
  await c.call('/api/auth/register', { method: 'POST', body: { username: 'brock', password: 'onix-onix-1' } });
  await other.call('/api/auth/register', { method: 'POST', body: { username: 'gary', password: 'eevee-123' } });
  const bolt = preset('raging-bolt-679141');

  const draft = await c.call('/api/decks', { method: 'POST', body: { name: '草稿', format: 'standard', cards: bolt.cards.slice(0, 3) } });
  assert.equal(draft.status, 201);
  assert.equal(draft.data.deck.legal, false);
  assert.match(draft.data.deck.issues[0], /正好 60 张/);

  const full = await c.call(`/api/decks/${draft.data.deck.id}`, { method: 'PUT', body: { name: '  猛雷鼓  ', format: 'standard', cards: bolt.cards } });
  assert.deepEqual([full.data.deck.name, full.data.deck.count, full.data.deck.legal, full.data.deck.issues], ['猛雷鼓', 60, true, []]);
  // The 嗨皮组合 list has E/F marks: legal in Open only.
  const pika = preset('csvh1c-pikachu');
  const std = await c.call('/api/decks', { method: 'POST', body: { name: '皮卡丘', format: 'standard', cards: pika.cards } });
  assert.equal(std.data.deck.legal, false);
  assert.ok(std.data.deck.issues.some((i) => /不能在标准赛使用/.test(i)));
  const open = await c.call(`/api/decks/${std.data.deck.id}`, { method: 'PUT', body: { name: '皮卡丘', format: 'open', cards: pika.cards } });
  assert.equal(open.data.deck.legal, true);
  // A card of the library whose rules are not implemented yet can be saved in a list, which then cannot be played.
  const ninetales = [...pika.cards.slice(1), ['zh-Hans:CS6.5C:013/072', pika.cards[0][1]]];
  const lib = await c.call('/api/decks', { method: 'POST', body: { name: '六尾', format: 'open', cards: ninetales } });
  assert.equal(lib.status, 201);
  assert.deepEqual([lib.data.deck.count, lib.data.deck.legal, lib.data.deck.issues], [60, false, ['「阿罗拉 六尾V」还没有实现对战规则，暂时不能用于对战。']]);
  assert.equal((await c.call(`/api/decks/${lib.data.deck.id}`, { method: 'DELETE' })).status, 200);

  const list = await c.call('/api/decks');
  assert.deepEqual(list.data.decks.map((d) => d.name), ['皮卡丘', '猛雷鼓']);
  assert.deepEqual((await other.call('/api/decks')).data.decks, []);
  assert.equal((await other.call(`/api/decks/${draft.data.deck.id}`)).status, 404);
  assert.equal((await other.call(`/api/decks/${draft.data.deck.id}`, { method: 'DELETE' })).status, 404);

  for (const body of [
    { name: '', format: 'standard', cards: [] },
    { name: 'x', format: 'expanded', cards: [] },
    { name: 'x', format: 'open', cards: [['zh-Hans:NOPE:001/001', 1]] },
    { name: 'x', format: 'open', cards: [[bolt.cards[0][0], 0]] },
    { name: 'x', format: 'open', cards: [[bolt.cards.at(-1)[0], 61]] },
  ]) assert.equal((await c.call('/api/decks', { method: 'POST', body })).status, 400, JSON.stringify(body));
  // Changes need a JSON body from this site.
  const form = await fetch(base + '/api/decks', { method: 'POST', headers: { cookie: c.cookie(), 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(form.status, 415);
  const cross = await c.call('/api/decks', { method: 'POST', body: { name: 'x', format: 'open', cards: [] }, headers: { origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);

  assert.equal((await c.call(`/api/decks/${draft.data.deck.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await c.call('/api/decks')).data.decks.length, 1);
});

test('administrators list users, change roles, reset passwords and delete accounts; players cannot', async () => {
  const admin = client(), player = client();
  await admin.call('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'admin-pass-1' } });
  const reg = await player.call('/api/auth/register', { method: 'POST', body: { username: 'jessie', password: 'meowth-123' } });
  const id = reg.data.user.id;
  assert.equal((await player.call('/api/admin/users')).status, 403);

  const users = (await admin.call('/api/admin/users')).data.users;
  assert.ok(users.some((u) => u.username === 'jessie' && u.role === 'user' && u.decks === 0));
  assert.ok(!JSON.stringify(users).includes('scrypt'));

  assert.equal((await admin.call(`/api/admin/users/${id}`, { method: 'PATCH', body: { role: 'admin' } })).data.user.role, 'admin');
  assert.equal((await player.call('/api/admin/users')).status, 200);
  await admin.call(`/api/admin/users/${id}`, { method: 'PATCH', body: { role: 'user' } });
  // A reset password signs the user out.
  assert.equal((await admin.call(`/api/admin/users/${id}`, { method: 'PATCH', body: { password: 'team-rocket-1' } })).status, 200);
  assert.equal((await player.call('/api/auth/me')).status, 401);
  assert.equal((await player.call('/api/auth/login', { method: 'POST', body: { username: 'jessie', password: 'team-rocket-1' } })).status, 200);

  const self = (await admin.call('/api/auth/me')).data.user.id;
  assert.equal((await admin.call(`/api/admin/users/${self}`, { method: 'PATCH', body: { role: 'user' } })).status, 400);
  assert.equal((await admin.call(`/api/admin/users/${self}`, { method: 'DELETE' })).status, 400);
  assert.equal((await admin.call(`/api/admin/users/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await player.call('/api/auth/me')).status, 401);
});

test('match records: the setup and steps of a game, resends kept once, readable by its player and administrators only', async () => {
  const c = client(), other = client(), admin = client();
  await c.call('/api/auth/register', { method: 'POST', body: { username: 'tracey', password: 'scyther-123' } });
  await other.call('/api/auth/register', { method: 'POST', body: { username: 'ritchie', password: 'sparky-123' } });
  await admin.call('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'admin-pass-1' } });
  const bolt = preset('raging-bolt-679141'), pult = preset('dragapult-676815');
  const deckList = (d) => d.cards.flatMap(([id, n]) => Array(n).fill(id));
  const setup = { releaseId: meta.releaseId, seed: [1, 2, 3, 4294967295], format: bolt.format, matchMode: 'normal',
    decks: [bolt, pult].map((d) => ({ id: d.id, name: d.name, cards: deckList(d) })) };

  assert.equal((await client().call('/api/matches', { method: 'POST', body: { setup } })).status, 401);
  const made = await c.call('/api/matches', { method: 'POST', body: { setup }, headers: { 'user-agent': 'test-browser' } });
  assert.equal(made.status, 201);
  const { id } = made.data.match;
  assert.deepEqual([made.data.match.status, made.data.match.steps, made.data.match.build.commit, made.data.match.userAgent],
    ['playing', 0, '0123abc', 'test-browser']);

  const step = (key, s) => ({ key, step: s });
  const first = [step('a.1', { type: 'action', player: 0, revision: 0, action: { type: 'answer', requestId: 'q1', selected: ['first'] }, hash: '00ff00ff' }),
    step('a.2', { type: 'rejected', player: 0, revision: 1, action: { type: 'endTurn' }, error: { message: 'no' } })];
  assert.deepEqual((await c.call(`/api/matches/${id}/steps`, { method: 'POST', body: { steps: first, turn: 1 } })).data, { added: 2, steps: 2 });
  // A resend (the answer was lost, or the page closed mid-request) adds only what is new.
  const again = await c.call(`/api/matches/${id}/steps`, { method: 'POST', body: { steps: [...first, step('b.1', { type: 'rewind', revision: 0, reason: 'reload' })] } });
  assert.deepEqual(again.data, { added: 1, steps: 3 });
  const end = await c.call(`/api/matches/${id}/steps`, { method: 'POST',
    body: { steps: [step('b.2', { type: 'end', result: { winner: 0, reason: 'ordinary' } })], status: 'over', result: { winner: 0, reason: 'ordinary' }, turn: 7 } });
  assert.equal(end.status, 200);

  const read = await c.call(`/api/matches/${id}`);
  assert.deepEqual(read.data.match.setup, setup);
  assert.deepEqual([read.data.match.status, read.data.match.turn, read.data.match.result], ['over', 7, { winner: 0, reason: 'ordinary' }]);
  assert.deepEqual(read.data.steps.map((s) => [s.seq, s.key, s.type]), [[1, 'a.1', 'action'], [2, 'a.2', 'rejected'], [3, 'b.1', 'rewind'], [4, 'b.2', 'end']]);
  assert.equal(read.data.steps[0].hash, '00ff00ff');

  // The list leaves out the cards; everyone sees only their own games, an administrator may ask for all of them.
  const mine = (await c.call('/api/matches')).data.matches;
  assert.deepEqual(mine.map((m) => [m.id, m.username, m.steps, m.setup.decks]), [[id, 'tracey', 4, [{ id: bolt.id, name: bolt.name }, { id: pult.id, name: pult.name }]]]);
  assert.deepEqual((await other.call('/api/matches')).data.matches, []);
  assert.equal((await other.call('/api/matches?all=1')).status, 403);
  assert.ok((await admin.call('/api/matches?all=1')).data.matches.some((m) => m.id === id && m.username === 'tracey'));
  assert.equal((await other.call(`/api/matches/${id}`)).status, 404);
  assert.equal((await admin.call(`/api/matches/${id}`)).status, 200);
  assert.equal((await other.call(`/api/matches/${id}/steps`, { method: 'POST', body: { steps: [] } })).status, 404);
  assert.equal((await admin.call(`/api/matches/${id}/steps`, { method: 'POST', body: { steps: [] } })).status, 404, 'an administrator reads, never writes');

  for (const body of [{}, { setup: { ...setup, seed: [1, 2, 3] } }, { setup: { ...setup, seed: [1, 2, 3, -1] } }, { setup: { ...setup, decks: [setup.decks[0]] } },
    { setup: { ...setup, decks: [{ ...setup.decks[0], cards: [...setup.decks[0].cards, 'x'] }, setup.decks[1]] } }, { setup: { ...setup, format: 'standard' } }])
    assert.equal((await c.call('/api/matches', { method: 'POST', body })).status, 400, JSON.stringify(body).slice(0, 80));
  for (const body of [{ steps: [step('k', { type: 'nope' })] }, { steps: [{ key: '', step: { type: 'action' } }] }, { steps: 'x' },
    { steps: [], status: 'won' }, { steps: [], turn: -1 }, { steps: [], result: 'x' }])
    assert.equal((await c.call(`/api/matches/${id}/steps`, { method: 'POST', body })).status, 400, JSON.stringify(body));
  // 调试台 edits: only in an administrator's own game; the list counts them.
  const edit = step('d.1', { type: 'edit', revision: 1, command: '/draw', lines: [], state: { revision: 2 }, hash: '00000000' });
  assert.equal((await c.call(`/api/matches/${id}/steps`, { method: 'POST', body: { steps: [edit] } })).status, 403);
  const own = (await admin.call('/api/matches', { method: 'POST', body: { setup } })).data.match.id;
  assert.deepEqual((await admin.call(`/api/matches/${own}/steps`, { method: 'POST', body: { steps: [edit] } })).data, { added: 1, steps: 1 });
  assert.equal((await admin.call('/api/matches')).data.matches.find((m) => m.id === own).edits, 1);
  assert.equal((await c.call('/api/matches')).data.matches[0].edits, 0);
  // A batch may carry a full kernel snapshot, far over the usual 64 KB.
  const big = await c.call(`/api/matches/${id}/steps`, { method: 'POST', body: { steps: [step('c.1', { type: 'snapshot', revision: 1, state: { blob: 'x'.repeat(300_000) } })] } });
  assert.deepEqual(big.data, { added: 1, steps: 5 });
  assert.equal((await c.call('/api/decks', { method: 'POST', body: { name: 'x'.repeat(70_000), format: 'open', cards: [] } })).status, 413);
});

test('the card library: every card once, compressed and revalidated; images by content', async () => {
  const c = client();
  await c.call('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'admin-pass-1' } });
  const r = await c.call('/api/library');
  assert.equal(r.status, 200);
  const { cards } = r.data;
  assert.ok(cards.some((x) => x.id === 'zh-Hans:CS6.5C:013/072' && x.name === '阿罗拉 六尾V'));
  assert.ok(cards.some((x) => x.id === 'zh-Hans:CSVH1C:008/059' && x.review === 'reviewed'));
  assert.equal(new Set(cards.map((x) => x.id)).size, cards.length);
  const etag = r.headers.get('etag');
  assert.equal((await c.call('/api/library', { headers: { 'if-none-match': etag } })).status, 304);
  const zipped = await fetch(base + '/api/library', { headers: { cookie: c.cookie(), 'accept-encoding': 'gzip' } });
  assert.equal(zipped.headers.get('content-encoding'), 'gzip');
  assert.deepEqual((await zipped.json()).cards, cards); // fetch decodes it

  for (const path of ['/play/library/thumb/0123456789abcdef', '/play/library/image/..%2F..%2Fetc', '/play/library/image/'])
    assert.equal((await c.call(path)).status, 404, path);
  // The image itself lives in the library on the NAS (when this machine has it).
  const pikachu = cards.find((x) => x.id === 'zh-Hans:CSVH1C:008/059');
  const index = JSON.parse(await readFile(join(FIXTURE, 'index.json'), 'utf8'));
  const record = index.entries.find((e) => e.cardId === pikachu.id);
  if (existsSync(join(index.library, index.language, record.dir, record.image.file))) {
    const img = await fetch(`${base}/play/${pikachu.thumb}`, { headers: { cookie: c.cookie() } });
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png'); // the fixture has no thumbnails: the full image
    assert.match(img.headers.get('cache-control'), /immutable/);
  }
});

test('other /api/ paths answer like a static host, so the table keeps its built-in CPU engine', async () => {
  const c = client();
  await c.call('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'admin-pass-1' } });
  const r = await c.call('/api/engine');
  assert.equal(r.status, 404);
  assert.ok(!r.headers.get('content-type').includes('json'));
});
