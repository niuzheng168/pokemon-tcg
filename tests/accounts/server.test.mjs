// The account server (server/app.mjs): sign-up and sign-in, the login gate in front of every page and file,
// the card library and its images, saved decks checked against the library and the reviewed release, the table's
// match records (also as files, with the bug reports: server/record-files.mjs), and the administrator's user management.
// The table's games are played and recorded by the server (server/play.mjs: tests/accounts/play.test.mjs); here a record
// is posted by an administrator (an import) or made in the store, and a player only adds the browser's errors to it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/app.mjs';
import { openStore } from '../../server/store.mjs';
import { loadRelease, ROOT } from '../../server/catalog.mjs';
import { loadLibrary } from '../../server/library.mjs';
import { matchFiles, bugReports, matchFileName } from '../../server/record-files.mjs';
import { catalogReleaseReceipt } from '../../public/rules/catalog-release.js';
import { releaseIdentity } from '../../public/release-identity.js';
import { newGame } from '../../public/replay.js';

const meta = JSON.parse(await readFile(join(ROOT, 'public/data/cn/V20261019/decks.json'), 'utf8'));
const FIXTURE = join(ROOT, 'tests/fixtures/card-library');
const preset = (id) => meta.decks.find((d) => d.id === id);
let server, base, store, site, records, replays, reports, catalog;
const releaseManifest = JSON.parse(await readFile(join(ROOT, 'public/data/cn/V20261019/manifest.json'), 'utf8'));

before(async () => {
  site = await mkdtemp(join(tmpdir(), 'cn-site-'));
  await mkdir(join(site, 'play', 'vendor'), { recursive: true });
  for (const [f, text] of [['play/index.html', '<p>table</p>'], ['play/login.html', '<p>login</p>'], ['play/style.css', 'body{}'],
    ['play/vendor/fonts.css', '/* fonts */'], ['play/secret.json', '{"a":1}'], ['404.html', '<p>404</p>'],
    ['play/build.json', '{"commit":"0123abc","dirty":false}']])
    await writeFile(join(site, f), text);
  await mkdir(join(site, 'play/data/cn/V20261019/shards'), { recursive: true });
  for (const file of ['manifest.json', releaseManifest.index.file, releaseManifest.shards[0].file])
    await cp(join(ROOT, 'public/data/cn/V20261019', file), join(site, 'play/data/cn/V20261019', file));
  store = openStore(':memory:');
  await store.createUser({ username: 'boss', password: 'admin-pass-1', role: 'admin' });
  const release = await loadRelease(), index = await release.index();
  const library = await loadLibrary({ dir: FIXTURE, index, presentation: meta.cards });
  catalog = { release, index, library };
  records = await mkdtemp(join(tmpdir(), 'cn-records-'));
  replays = matchFiles({ dir: join(records, 'replays'), store });
  reports = bugReports({ dir: join(records, 'bug-reports') });
  server = createServer(createApp({ store, site, release, index, library, matchFiles: replays, bugReports: reports }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  store.close();
  await rm(site, { recursive: true, force: true });
  await rm(records, { recursive: true, force: true });
});

// A tiny browser: keeps the session cookie between requests.
function client(root = base) {
  let cookie = '';
  const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const r = await fetch(root + path, { method, redirect: 'manual',
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
  const reg = await c.call('/api/auth/register', { method: 'POST', body: { username: '小智', password: 'pikachu-123',
    role: 'admin', coachEnabled: true, pvpCoachEnabled: true } });
  assert.equal(reg.status, 201);
  assert.deepEqual([reg.data.user.username, reg.data.user.role], ['小智', 'user']);
  assert.equal(reg.data.user.coachEnabled, false, 'Registration cannot grant coach permission.');
  assert.equal(reg.data.user.pvpCoachEnabled, false, 'Registration cannot grant PvP coach permission.');
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

test('with registration closed the login page is told so and sign-up is refused; existing accounts still sign in', async () => {
  assert.deepEqual((await client().call('/api/auth/options')).data, { registration: true });
  const closedStore = openStore(':memory:');
  await closedStore.createUser({ username: 'boss', password: 'admin-pass-1', role: 'admin' });
  const closed = createServer(createApp({ store: closedStore, site, ...catalog, registration: false }));
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  try {
    const c = client(`http://127.0.0.1:${closed.address().port}`);
    assert.deepEqual((await c.call('/api/auth/options')).data, { registration: false });
    const reg = await c.call('/api/auth/register', { method: 'POST', body: { username: 'newcomer', password: 'long-enough-1' } });
    assert.deepEqual([reg.status, reg.data.code], [403, 'registration-closed']);
    assert.ok(!closedStore.userByName('newcomer'));
    assert.equal((await c.call('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'admin-pass-1' } })).status, 200);
  } finally {
    await new Promise((r) => closed.close(r));
    closedStore.close();
  }
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
  const thievul = [...pika.cards.slice(1), ['zh-Hans:CS6bC:103/131', pika.cards[0][1]]];
  const lib = await c.call('/api/decks', { method: 'POST', body: { name: '狐大盗', format: 'open', cards: thievul } });
  assert.equal(lib.status, 201);
  assert.deepEqual([lib.data.deck.count, lib.data.deck.legal, lib.data.deck.issues], [60, false, ['「狐大盗」还没有实现对战规则，暂时不能用于对战。']]);
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

test('administrators list users, manage coach permissions, change roles, reset passwords and delete accounts; players cannot', async () => {
  const admin = client(), player = client();
  await admin.call('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'admin-pass-1' } });
  const reg = await player.call('/api/auth/register', { method: 'POST', body: { username: 'jessie', password: 'meowth-123' } });
  const id = reg.data.user.id;
  assert.equal((await player.call('/api/admin/users')).status, 403);
  assert.equal((await player.call(`/api/admin/users/${id}`, { method: 'PATCH', body: { coachEnabled: true } })).status, 403);
  assert.equal((await player.call(`/api/admin/users/${id}`, { method: 'PATCH', body: { pvpCoachEnabled: true } })).status, 403);
  assert.equal((await player.call('/api/play/1/coach', { method: 'POST', body: {} })).status, 403);

  const users = (await admin.call('/api/admin/users')).data.users;
  assert.ok(users.some((u) => u.username === 'jessie' && u.role === 'user' && u.decks === 0));
  assert.ok(!JSON.stringify(users).includes('scrypt'));
  assert.equal(users.find((u) => u.id === id).coachEnabled, false);
  const grant = await admin.call(`/api/admin/users/${id}`, { method: 'PATCH', body: { coachEnabled: true } });
  assert.deepEqual([grant.status, grant.data.user.role, grant.data.user.coachEnabled], [200, 'user', true]);
  assert.equal((await player.call('/api/auth/me')).data.user.coachEnabled, true, 'An existing session gets its new permission.');
  assert.equal((await player.call('/api/engine')).data.coach, false, 'A permission alone cannot enable an unconfigured model.');
  for (const coachEnabled of ['true', 1, null, {}, []]) {
    assert.equal((await admin.call(`/api/admin/users/${id}`, { method: 'PATCH', body: { coachEnabled, role: 'admin' } })).status, 400);
    assert.equal(store.userById(id).role, 'user', 'An invalid permission patch changes no field.');
    assert.equal(store.userById(id).coachEnabled, true);
  }
  await admin.call(`/api/admin/users/${id}`, { method: 'PATCH', body: { coachEnabled: false } });
  assert.equal((await player.call('/api/auth/me')).data.user.coachEnabled, false);
  assert.equal(users.find((u) => u.id === id).pvpCoachEnabled, false);
  const pvpGrant = await admin.call(`/api/admin/users/${id}`, { method: 'PATCH', body: { pvpCoachEnabled: true } });
  assert.deepEqual([pvpGrant.status, pvpGrant.data.user.coachEnabled, pvpGrant.data.user.pvpCoachEnabled], [200, false, true]);
  assert.equal((await player.call('/api/auth/me')).data.user.pvpCoachEnabled, true);
  assert.equal((await player.call('/api/engine')).data.pvpCoach, false, 'PvP coaching also requires a configured model.');
  for (const pvpCoachEnabled of ['true', 1, null, {}, []]) {
    assert.equal((await admin.call(`/api/admin/users/${id}`, { method: 'PATCH', body: { pvpCoachEnabled, coachEnabled: true, role: 'admin' } })).status, 400);
    assert.deepEqual([store.userById(id).role, store.userById(id).coachEnabled, store.userById(id).pvpCoachEnabled], ['user', false, true]);
  }
  await admin.call(`/api/admin/users/${id}`, { method: 'PATCH', body: { pvpCoachEnabled: false } });
  assert.equal((await player.call('/api/auth/me')).data.user.pvpCoachEnabled, false);

  assert.equal((await admin.call(`/api/admin/users/${id}`, { method: 'PATCH', body: { role: 'admin' } })).data.user.role, 'admin');
  assert.equal((await player.call('/api/admin/users')).status, 200);
  assert.equal((await player.call('/api/auth/me')).data.user.coachEnabled, false, 'Promotion does not grant coach access.');
  assert.equal((await player.call('/api/auth/me')).data.user.pvpCoachEnabled, false, 'Promotion does not grant PvP coach access.');
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
  const c = client(), other = client(), admin = client(), step = (key, s) => ({ key, step: s });
  await c.call('/api/auth/register', { method: 'POST', body: { username: 'tracey', password: 'scyther-123' } });
  await other.call('/api/auth/register', { method: 'POST', body: { username: 'ritchie', password: 'sparky-123' } });
  await admin.call('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'admin-pass-1' } });
  const bolt = preset('raging-bolt-679141'), pult = preset('dragapult-676815');
  const deckList = (d) => d.cards.flatMap(([id, n]) => Array(n).fill(id));
  const setup = { releaseId: meta.releaseId, seed: [1, 2, 3, 4294967295], format: bolt.format, matchMode: 'normal',
    decks: [bolt, pult].map((d) => ({ id: d.id, name: d.name, cards: deckList(d) })) };

  assert.equal((await client().call('/api/matches', { method: 'POST', body: { setup } })).status, 401);
  assert.equal((await c.call('/api/matches', { method: 'POST', body: { setup } })).status, 403, 'A player\'s games are recorded by the server.');
  const made = await admin.call('/api/matches', { method: 'POST', body: { setup }, headers: { 'user-agent': 'test-browser' } });
  assert.equal(made.status, 201);
  const { id } = made.data.match;
  assert.deepEqual([made.data.match.status, made.data.match.steps, made.data.match.build.commit, made.data.match.userAgent],
    ['playing', 0, '0123abc', 'test-browser']);

  const first = [step('a.1', { type: 'action', player: 0, revision: 0, action: { type: 'answer', requestId: 'q1', selected: ['first'] }, hash: '00ff00ff' }),
    step('a.2', { type: 'rejected', player: 0, revision: 1, action: { type: 'endTurn' }, error: { message: 'no' } })];
  assert.deepEqual((await admin.call(`/api/matches/${id}/steps`, { method: 'POST', body: { steps: first, turn: 1 } })).data, { added: 2, steps: 2 });
  // A resend (the answer was lost, or the page closed mid-request) adds only what is new.
  const again = await admin.call(`/api/matches/${id}/steps`, { method: 'POST', body: { steps: [...first, step('b.1', { type: 'rewind', revision: 0, reason: 'reload' })] } });
  assert.deepEqual(again.data, { added: 1, steps: 3 });
  const end = await admin.call(`/api/matches/${id}/steps`, { method: 'POST',
    body: { steps: [step('b.2', { type: 'end', result: { winner: 0, reason: 'ordinary' } })], status: 'over', result: { winner: 0, reason: 'ordinary' }, turn: 7 } });
  assert.equal(end.status, 200);

  const read = await admin.call(`/api/matches/${id}`);
  const { approval, clientApproval, compatibility, ...storedSetup } = read.data.match.setup;
  assert.deepEqual(storedSetup, { ...setup,
    implementation: { tiers: ['reviewed'], machinePrintings: [], unimplementedPrintings: [] } });
  assert.equal(clientApproval, null); assert.equal(compatibility, null);
  const verified = await (await loadRelease()).catalogFor(setup.decks.flatMap((d) => d.cards));
  assert.equal(approval.catalogId, verified.id);
  assert.equal(approval.schemaVersion, '2.0.0');
  assert.equal(approval.manifestSha256.length, 64);
  assert.deepEqual([read.data.match.status, read.data.match.turn, read.data.match.result], ['over', 7, { winner: 0, reason: 'ordinary' }]);
  assert.deepEqual(read.data.steps.map((s) => [s.seq, s.key, s.type]), [[1, 'a.1', 'action'], [2, 'a.2', 'rejected'], [3, 'b.1', 'rewind'], [4, 'b.2', 'end']]);
  assert.equal(read.data.steps[0].hash, '00ff00ff');

  // The list leaves out the cards; everyone sees only their own games, an administrator may ask for all of them.
  const theirs = store.createMatch(store.userByName('tracey').id, { setup }).id; // a player's game, as the server records it
  const mine = (await c.call('/api/matches')).data.matches;
  assert.deepEqual(mine.map((m) => [m.id, m.username, m.steps, m.setup.decks]), [[theirs, 'tracey', 0, [{ id: bolt.id, name: bolt.name }, { id: pult.id, name: pult.name }]]]);
  assert.deepEqual((await other.call('/api/matches')).data.matches, []);
  assert.equal((await other.call('/api/matches?all=1')).status, 403);
  assert.ok((await admin.call('/api/matches?all=1')).data.matches.some((m) => m.id === theirs && m.username === 'tracey'));
  assert.equal((await other.call(`/api/matches/${theirs}`)).status, 404);
  assert.equal((await admin.call(`/api/matches/${theirs}`)).status, 200);
  assert.equal((await other.call(`/api/matches/${theirs}/steps`, { method: 'POST', body: { steps: [] } })).status, 404);
  assert.equal((await admin.call(`/api/matches/${theirs}/steps`, { method: 'POST', body: { steps: [] } })).status, 404, 'an administrator reads, never writes');
  // The player adds the browser's errors to their game, nothing else: its moves, its end and its result are the server's.
  const error = step('e.1', { type: 'error', message: 'TypeError: x is undefined', stack: '' });
  assert.deepEqual((await c.call(`/api/matches/${theirs}/steps`, { method: 'POST', body: { steps: [error] } })).data, { added: 1, steps: 1 });
  for (const body of [{ steps: first }, { steps: [step('e.2', { type: 'end', result: { winner: 0 } })] }, { steps: [], status: 'over' },
    { steps: [], turn: 9 }, { steps: [], result: { winner: 0, reason: 'ordinary' } }])
    assert.equal((await c.call(`/api/matches/${theirs}/steps`, { method: 'POST', body })).status, 403, JSON.stringify(body).slice(0, 80));

  for (const body of [{}, { setup: { ...setup, seed: [1, 2, 3] } }, { setup: { ...setup, seed: [1, 2, 3, -1] } }, { setup: { ...setup, decks: [setup.decks[0]] } },
    { setup: { ...setup, decks: [{ ...setup.decks[0], cards: [...setup.decks[0].cards, 'x'] }, setup.decks[1]] } }, { setup: { ...setup, format: 'standard' } }])
    assert.equal((await admin.call('/api/matches', { method: 'POST', body })).status, 400, JSON.stringify(body).slice(0, 80));
  for (const body of [{ steps: [step('k', { type: 'nope' })] }, { steps: [{ key: '', step: { type: 'action' } }] }, { steps: 'x' },
    { steps: [], status: 'won' }, { steps: [], turn: -1 }, { steps: [], result: 'x' }])
    assert.equal((await admin.call(`/api/matches/${id}/steps`, { method: 'POST', body })).status, 400, JSON.stringify(body));
  // 调试台 edits: only in an administrator's own game; the list counts them.
  const edit = step('d.1', { type: 'edit', revision: 1, command: '/draw', lines: [], state: { revision: 2 }, hash: '00000000' });
  assert.equal((await c.call(`/api/matches/${theirs}/steps`, { method: 'POST', body: { steps: [edit] } })).status, 403);
  const own = (await admin.call('/api/matches', { method: 'POST', body: { setup } })).data.match.id;
  assert.deepEqual((await admin.call(`/api/matches/${own}/steps`, { method: 'POST', body: { steps: [edit] } })).data, { added: 1, steps: 1 });
  assert.equal((await admin.call('/api/matches')).data.matches.find((m) => m.id === own).edits, 1);
  assert.equal((await c.call('/api/matches')).data.matches[0].edits, 0);
  // A batch may carry a full kernel snapshot, far over the usual 64 KB.
  const big = await admin.call(`/api/matches/${id}/steps`, { method: 'POST', body: { steps: [step('c.1', { type: 'snapshot', revision: 1, state: { blob: 'x'.repeat(300_000) } })] } });
  assert.deepEqual(big.data, { added: 1, steps: 5 });
  assert.equal((await c.call('/api/decks', { method: 'POST', body: { name: 'x'.repeat(70_000), format: 'open', cards: [] } })).status, 413);
});

test('match quality is derived from pinned printings, not a client claim about machine/reviewed cards', async () => {
  const c = client();
  await c.call('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'admin-pass-1' } });
  const bolt = preset('raging-bolt-679141'), cards = bolt.cards.flatMap(([id, n]) => Array(n).fill(id));
  cards[0] = 'zh-Hans:151C:013/151';
  const setup = { releaseId: meta.releaseId, seed: [1, 2, 3, 4], format: { ...bolt.format, id: 'open' }, matchMode: 'normal',
    decks: [0, 1].map((i) => ({ id: `quality-${i}`, name: `层级测试${i}`, cards })),
    implementation: { tiers: ['reviewed'], machinePrintings: [], unimplementedPrintings: [] } };
  const made = await c.call('/api/matches', { method: 'POST', body: { setup } });
  assert.equal(made.status, 201);
  assert.deepEqual(made.data.match.setup.implementation, {
    tiers: ['reviewed', 'machine'], machinePrintings: ['zh-Hans:151C:013/151'], unimplementedPrintings: [],
  });
  const listed = (await c.call('/api/matches')).data.matches.find((m) => m.id === made.data.match.id);
  assert.deepEqual(listed.setup.implementation, made.data.match.setup.implementation);
  assert.ok(listed.setup.decks.every((d) => !('cards' in d)));
  setup.decks[0] = { ...setup.decks[0], cards: ['zh-Hans:NOPE:001/001'] };
  const diagnostic = await c.call('/api/matches', { method: 'POST', body: { setup } });
  assert.equal(diagnostic.status, 201);
  assert.deepEqual(diagnostic.data.match.setup.implementation.unimplementedPrintings, ['zh-Hans:NOPE:001/001']);
  assert.equal(diagnostic.data.match.setup.approval, null);
});

test('match subset identity is independently derived; forged client receipts stay diagnostic and cannot silently replay', async () => {
  const c = client();
  await c.call('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'admin-pass-1' } });
  const bolt = preset('raging-bolt-679141'), cards = bolt.cards.flatMap(([id, n]) => Array(n).fill(id));
  const release = await loadRelease(), actual = releaseIdentity(catalogReleaseReceipt(await release.catalogFor(cards)));
  const fake = { ...actual, catalogId: 'f'.repeat(64), manifestSha256: 'a'.repeat(64), tiers: ['machine'] };
  const setup = { releaseId: meta.releaseId, seed: [1, 2, 3, 4], format: bolt.format, matchMode: 'normal',
    decks: [0, 1].map((i) => ({ id: `receipt-${i}`, name: '凭据回归测试', cards })), approval: fake };
  const made = await c.call('/api/matches', { method: 'POST', body: { setup } });
  assert.equal(made.status, 201);
  const stored = made.data.match.setup;
  assert.deepEqual(stored.approval, actual);
  assert.equal(stored.clientApproval.catalogId, fake.catalogId);
  assert.deepEqual(stored.compatibility, { catalogMatches: false, manifestMatches: false });
  assert.deepEqual(stored.implementation.tiers, ['reviewed']);
  assert.equal('reviews' in stored.approval, false, 'record identity does not duplicate manifest review prose');
  await assert.rejects(newGame({ release, setup: stored }), /Recorded catalogId differs/);
  for (const approval of [null, {}, { ...actual, catalogId: 1 }])
    assert.equal((await c.call('/api/matches', { method: 'POST', body: { setup: { ...setup, approval } } })).status, 400);
});

// A player of its own for each test below (sign-ups per address are limited, and this file uses most of them).
async function signedIn(username) {
  await store.createUser({ username, password: `${username}-pass-1` });
  const c = client();
  await c.call('/api/auth/login', { method: 'POST', body: { username, password: `${username}-pass-1` } });
  return c;
}
function gameSetup(extra = {}) {
  const bolt = preset('raging-bolt-679141'), pult = preset('dragapult-676815');
  const deckList = (d) => d.cards.flatMap(([id, n]) => Array(n).fill(id));
  return { releaseId: meta.releaseId, seed: [5, 6, 7, 8], format: bolt.format, matchMode: 'normal',
    decks: [bolt, pult].map((d) => ({ id: d.id, name: d.name, cards: deckList(d) })), ...extra };
}
const readJSONFile = async (file) => JSON.parse(await readFile(file, 'utf8'));

test('every match record is also a file in the replay directory, kept up to date; earlier games get theirs on start', async () => {
  const c = await signedIn('replay-keeper'), admin = client();
  await admin.call('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'admin-pass-1' } });
  const { match } = (await admin.call('/api/matches', { method: 'POST', body: { setup: gameSetup() } })).data;
  assert.match(matchFileName(match), new RegExp(`^match-${match.id}-\\d{8}T\\d{6}Z\\.json$`));
  const file = join(replays.dir, matchFileName(match));
  assert.deepEqual(await readJSONFile(file), { match, steps: [] });
  const steps = [{ key: 'm.1', step: { type: 'action', player: 0, revision: 0, action: { type: 'endTurn' }, hash: '12345678' } }];
  await admin.call(`/api/matches/${match.id}/steps`, { method: 'POST', body: { steps, turn: 2 } });
  const written = await readJSONFile(file);
  assert.deepEqual(written, (await admin.call(`/api/matches/${match.id}`)).data, 'the file is what GET /api/matches/:id returns');
  assert.deepEqual([written.match.turn, written.steps.map((s) => s.key)], [2, ['m.1']]);
  // A player's error steps reach the file too.
  const theirs = store.createMatch(store.userByName('replay-keeper').id, { setup: gameSetup() });
  await c.call(`/api/matches/${theirs.id}/steps`, { method: 'POST', body: { steps: [{ key: 'e.1', step: { type: 'error', message: 'x' } }] } });
  assert.deepEqual((await readJSONFile(join(replays.dir, matchFileName(theirs)))).steps.map((s) => s.type), ['error']);
  // A game recorded while no directory was set gets its file when the server starts (server/main.mjs), once.
  const earlier = store.createMatch(store.userByName('replay-keeper').id, { setup: gameSetup() });
  assert.equal(await replays.backfill(), 1);
  assert.equal((await readJSONFile(join(replays.dir, matchFileName(earlier)))).match.id, earlier.id);
  assert.equal(await replays.backfill(), 0);
  assert.ok(!(await readdir(replays.dir)).some((f) => f.endsWith('.tmp')));
});

test('a record posted as taken over from a replay notes the game and move it came from (players take over on the server)', async () => {
  const c = client(), other = await signedIn('bystander');
  await c.call('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'admin-pass-1' } });
  const source = (await c.call('/api/matches', { method: 'POST', body: { setup: gameSetup() } })).data.match.id;
  const made = await c.call('/api/matches', { method: 'POST', body: { setup: gameSetup({ takeover: { match: source, move: 12 } }) } });
  assert.equal(made.status, 201);
  assert.notEqual(made.data.match.id, source);
  assert.deepEqual(made.data.match.setup.takeover, { match: source, move: 12 });
  assert.deepEqual((await c.call('/api/matches')).data.matches.find((m) => m.id === made.data.match.id).setup.takeover, { match: source, move: 12 });
  assert.equal('takeover' in (await c.call(`/api/matches/${source}`)).data.match.setup, false);
  assert.equal((await other.call('/api/matches', { method: 'POST', body: { setup: gameSetup({ takeover: { match: source, move: 1 } }) } })).status, 403);
  for (const takeover of [{ match: source }, { match: 0, move: 1 }, { match: source, move: -1 }, { match: String(source), move: 1 }, 'x'])
    assert.equal((await c.call('/api/matches', { method: 'POST', body: { setup: gameSetup({ takeover }) } })).status, 400, JSON.stringify(takeover));
});

test('bug reports: a file each, with the record of the game they name (one the player may replay); checked and limited', async () => {
  const c = await signedIn('reporter'), other = await signedIn('onlooker'), admin = client();
  await admin.call('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'admin-pass-1' } });
  const match = store.createMatch(store.userByName('reporter').id, { setup: gameSetup() });
  store.appendSteps(match.id, [{ key: 'r.1', step: { type: 'action', player: 0, revision: 0, action: { type: 'endTurn' } } }]);
  const body = { description: '  小茂的招式伤害不对。\n应该是 120。  ', matchId: match.id, replay: false, move: 1, turn: 2,
    page: 'https://example.test/play/', log: ['你使用了招式「X」。', '小茂的回合。'], state: { revision: 1, players: [] } };
  assert.equal((await client().call('/api/bug-reports', { method: 'POST', body })).status, 401);
  const sent = await c.call('/api/bug-reports', { method: 'POST', body, headers: { 'user-agent': 'test-browser' } });
  assert.equal(sent.status, 201);
  const { id } = sent.data.report;
  assert.match(id, new RegExp(`^bug-\\d{8}T\\d{6}Z-match-${match.id}$`));
  const text = await readFile(join(reports.dir, `${id}.json`), 'utf8'), report = JSON.parse(text);
  assert.deepEqual(Object.keys(report), ['id', 'createdAt', 'user', 'description', 'matchId', 'replay', 'move', 'turn', 'page', 'build',
    'userAgent', 'log', 'state', 'match', 'steps']);
  assert.deepEqual([report.user.username, report.description, report.matchId, report.replay, report.move, report.turn, report.build.commit, report.userAgent],
    ['reporter', '小茂的招式伤害不对。\n应该是 120。', match.id, false, 1, 2, '0123abc', 'test-browser']);
  assert.deepEqual([report.log, report.state], [body.log, body.state]);
  assert.deepEqual({ match: report.match, steps: report.steps }, (await c.call(`/api/matches/${match.id}`)).data,
    'the record as GET /api/matches/:id returns it: npm run match -- show --file replays the report');
  assert.match(text, /^\{\n {2}"id": "bug-/); // one field per line: the file reads as the report from the top
  assert.match(text, /\n {2}"log": \[\n {4}"你使用了招式「X」。",\n/);

  // Watching someone's replay, an administrator may report on it; another player may not name it.
  assert.equal((await admin.call('/api/bug-reports', { method: 'POST', body: { ...body, replay: true } })).status, 201);
  assert.equal((await other.call('/api/bug-reports', { method: 'POST', body })).status, 404);
  // Without a game record, what the table had.
  const loose = await other.call('/api/bug-reports', { method: 'POST', body: { description: '卡组页面打不开' } });
  assert.match(loose.data.report.id, /-no-match$/);
  const looseReport = await readJSONFile(join(reports.dir, `${loose.data.report.id}.json`));
  assert.deepEqual([looseReport.matchId, looseReport.move, looseReport.log, looseReport.state, 'match' in looseReport], [null, null, [], null, false]);
  for (const bad of [{}, { description: '   ' }, { description: 'x'.repeat(4001) }, { ...body, move: -1 }, { ...body, matchId: 'x' },
    { ...body, log: 'x' }, { ...body, log: [1] }, { ...body, state: [] }])
    assert.equal((await c.call('/api/bug-reports', { method: 'POST', body: bad })).status, 400, JSON.stringify(bad).slice(0, 60));
  // Two reports in the same second get two files.
  const at = '2020-01-02T03:04:05.678Z';
  assert.equal(await reports.save({ createdAt: at, matchId: null, description: 'a' }), 'bug-20200102T030405Z-no-match');
  assert.equal(await reports.save({ createdAt: at, matchId: null, description: 'b' }), 'bug-20200102T030405Z-no-match-2');
  // Once dealt with, the report keeps everything and gains its resolution after the description; a later one replaces it.
  for (const rootCause of ['first', 'second']) await reports.resolve(id, { status: 'fixed', commit: 'abc1234', rootCause, repro: ['a', 'b'] });
  const resolvedText = await readFile(join(reports.dir, `${id}.json`), 'utf8'), resolved = JSON.parse(resolvedText);
  assert.deepEqual(Object.keys(resolved), ['id', 'createdAt', 'user', 'description', 'resolution', 'matchId', 'replay', 'move', 'turn', 'page',
    'build', 'userAgent', 'log', 'state', 'match', 'steps']);
  assert.deepEqual(resolved.resolution, { status: 'fixed', commit: 'abc1234', rootCause: 'second', repro: ['a', 'b'] });
  const { resolution: _r, ...unchanged } = resolved;
  assert.deepEqual(unchanged, report);
  assert.match(resolvedText, /\n {2}"resolution": \{\n {4}"status": "fixed",\n/);
  assert.match(resolvedText, /\n {2}"log": \[\n {4}"你使用了招式「X」。",\n/);
  // At most 30 an hour from one player.
  let status, sentOk = 1; // the report without a record above
  for (let i = 0; i < 40 && status !== 429; i++) {
    status = (await other.call('/api/bug-reports', { method: 'POST', body: { description: `第 ${i} 次` } })).status;
    if (status === 201) sentOk++;
  }
  assert.deepEqual([status, sentOk], [429, 30]);
});

test('release shards/index are private immutable compressed files; manifests revalidate and auth precedes cache/304', async () => {
  const c = client();
  await c.call('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'admin-pass-1' } });
  const prefix = '/play/data/cn/V20261019/';
  for (const file of ['manifest.json', releaseManifest.index.file, releaseManifest.shards[0].file]) {
    const r = await fetch(base + prefix + file, { headers: { cookie: c.cookie(), 'accept-encoding': 'br' } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('cache-control'), file === 'manifest.json' ? /^private, no-cache$/ : /^private, .*immutable$/);
    assert.equal(r.headers.get('content-encoding'), 'br');
    assert.equal(r.headers.get('vary'), 'Accept-Encoding');
    const bytes = Buffer.from(await r.arrayBuffer());
    assert.deepEqual(bytes, await readFile(join(ROOT, 'public/data/cn/V20261019', file)), 'decoded bytes match the signed file');
    const etag = r.headers.get('etag');
    assert.match(etag, /^W\/"[a-f0-9]{64}"$/);
    const conditional = await fetch(base + prefix + file, { headers: { cookie: c.cookie(), 'if-none-match': etag } });
    assert.equal(conditional.status, 304); assert.equal((await conditional.text()).length, 0);
    const anon = await fetch(base + prefix + file, { redirect: 'manual', headers: { 'if-none-match': etag } });
    assert.equal(anon.status, 401, 'a cached digest is not authorization');
    const noCompression = await fetch(base + prefix + file, { method: 'HEAD', headers: {
      cookie: c.cookie(), 'accept-encoding': 'br;q=0,gzip;q=0',
    } });
    assert.equal(noCompression.status, 200);
    assert.equal(noCompression.headers.get('content-encoding'), null);
    assert.equal((await noCompression.text()).length, 0);
    const gzip = await fetch(base + prefix + file, { headers: { cookie: c.cookie(), 'accept-encoding': 'gzip' } });
    assert.equal(gzip.headers.get('content-encoding'), 'gzip');
    assert.deepEqual(Buffer.from(await gzip.arrayBuffer()), bytes);
  }
  const manifestPath = join(site, 'play/data/cn/V20261019/manifest.json');
  await writeFile(manifestPath, '{"fixture":"updated"}');
  const updated = await fetch(base + prefix + 'manifest.json', { headers: { cookie: c.cookie() } });
  assert.deepEqual(await updated.json(), { fixture: 'updated' });
  assert.notEqual(updated.headers.get('etag'), null);
  // Missing content-addressed files remain ordinary 404s, not cached success.
  assert.equal((await c.call(prefix + 'shards/MISSING.aaaaaaaaaaaaaaaa.json')).status, 404);
});

// Card images are kept by the browser for a day, so a game does not fetch a card it has shown before; other files are
// revalidated (304 by ETag), pages never cached; the login gate still comes first.
test('a card image is cached for a day; other files revalidate by ETag; pages are never cached', async () => {
  const c = client();
  await c.call('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'admin-pass-1' } });
  await mkdir(join(site, 'play/img/cn-cards/TEST'), { recursive: true });
  await writeFile(join(site, 'play/img/cn-cards/TEST/001-001.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const get = (path, headers = {}) => fetch(base + path, { redirect: 'manual', headers: { cookie: c.cookie(), ...headers } });
  const image = await get('/play/img/cn-cards/TEST/001-001.png');
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('cache-control'), 'private, max-age=86400');
  assert.equal(Buffer.from(await image.arrayBuffer()).length, 4);
  const again = await get('/play/img/cn-cards/TEST/001-001.png', { 'if-none-match': image.headers.get('etag') });
  assert.equal(again.status, 304);
  const css = await get('/play/style.css');
  assert.equal(css.headers.get('cache-control'), 'private, no-cache');
  assert.equal((await get('/play/style.css', { 'if-none-match': css.headers.get('etag') })).status, 304);
  await writeFile(join(site, 'play/style.css'), 'body{color:red}');
  const changed = await get('/play/style.css', { 'if-none-match': css.headers.get('etag') });
  assert.deepEqual([changed.status, await changed.text()], [200, 'body{color:red}'], 'a changed file is sent again');
  const page = await get('/play/');
  assert.deepEqual([page.status, page.headers.get('cache-control'), page.headers.get('etag')], [200, 'no-store', null]);
  const anon = await fetch(base + '/play/img/cn-cards/TEST/001-001.png', { redirect: 'manual', headers: { 'if-none-match': image.headers.get('etag') } });
  assert.equal(anon.status, 401, 'a cached image is not authorization');
});

test('encoded dot-segment aliases cannot bypass release authentication through a public vendor prefix', async () => {
  for (const path of [
    '/play/vendor/..%2fdata/cn/V20261019/manifest.json',
    '/play/vendor/%2e%2e%2fsecret.json',
    '/play/vendor/..%2f..%2fplay/data/cn/V20261019/' + releaseManifest.index.file,
    '/play/vendor/%5c..%5cdata/cn/V20261019/manifest.json',
  ]) {
    const r = await fetch(base + path, { redirect: 'manual', headers: { 'if-none-match': 'W/"fake"' } });
    assert.equal(r.status, 403, path);
    assert.notEqual(r.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  }
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

  for (const path of ['/play/library/thumb/0123456789abcdef', '/play/library/image/'])
    assert.equal((await c.call(path)).status, 404, path);
  assert.equal((await c.call('/play/library/image/..%2F..%2Fetc')).status, 403, 'decoded traversal is refused before image routing');
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

test('without the AI the engine is the built-in CPU; other /api/ paths answer like a static host', async () => {
  const c = client();
  await c.call('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'admin-pass-1' } });
  const engine = await c.call('/api/engine');
  assert.deepEqual([engine.status, engine.data.engine, engine.data.ready], [200, 'cpu', false]);
  const r = await c.call('/api/engine/stop', { method: 'POST', body: {} });
  assert.equal(r.status, 404);
  assert.ok(!r.headers.get('content-type').includes('json'));
});
