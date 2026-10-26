// The table's games played on the server (server/play.mjs behind /api/play): the browser sends commands and gets its own
// view; the seed stays on the server until the game is over; 小茂's moves, the undo and the record are the server's; a
// game the engine pool lost opens again from its record; reloads, takeovers, the 调试台 and bug reports.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/app.mjs';
import { openStore } from '../../server/store.mjs';
import { loadRelease, ROOT } from '../../server/catalog.mjs';
import { loadLibrary } from '../../server/library.mjs';
import { matchFiles, bugReports } from '../../server/record-files.mjs';
import { createEnginePool } from '../../server/engine-pool.mjs';
import { replayMatch } from '../../public/replay.js';
import { createAI } from '../../public/cn/ai.js';
import { Simulation } from '../../public/rules/engine.js';

const meta = JSON.parse(await readFile(join(ROOT, 'public/data/cn/V20261019/decks.json'), 'utf8'));
let server, base, store, site, records, reports, engines, release;
// The AI here: 小茂's move from the snapshot the server sends, as the CPU engine would make it from his view; told to,
// it fails once (the server then falls back to the CPU engine) or answers a move the rules refuse.
const fakeAI = { calls: [], failNext: false, refuseNext: false, async decide({ snapshot, player, level }) {
  this.calls.push({ level, player, cards: Object.keys(snapshot.cards).length });
  if (this.failNext) { this.failNext = false; throw new Error('AI down'); }
  if (this.refuseNext) { this.refuseNext = false; return { action: { type: 'retreat', pokemonId: 'm999' }, value: 0.5 }; }
  const catalog = await release.catalogFor([...new Set(Object.values(snapshot.cards).map((c) => c.printingId))]);
  return { action: createAI(catalog)(new Simulation(snapshot, catalog).view(player), player), value: 0.42 };
}, async rate({ snapshot, player, actions }) {
  return { ranking: { choice: actions[0].key, probabilities: {} }, win: { score: 2 }, moves: {}, cards: Object.keys(snapshot.cards).length, player };
} };

before(async () => {
  site = await mkdtemp(join(tmpdir(), 'cn-play-site-'));
  await mkdir(join(site, 'play'), { recursive: true });
  for (const [f, text] of [['play/index.html', '<p>table</p>'], ['play/login.html', '<p>login</p>'], ['404.html', '<p>404</p>'],
    ['play/build.json', '{"commit":"0123abc","dirty":false}']]) await writeFile(join(site, f), text);
  store = openStore(':memory:');
  await store.createUser({ username: 'boss', password: 'admin-pass-1', role: 'admin' });
  release = await loadRelease();
  const index = await release.index();
  const library = await loadLibrary({ dir: join(ROOT, 'tests/fixtures/card-library'), index, presentation: meta.cards });
  records = await mkdtemp(join(tmpdir(), 'cn-play-records-'));
  reports = bugReports({ dir: join(records, 'bug-reports') });
  engines = createEnginePool({ workers: 0, release, slowMs: 1e9 });
  server = createServer(createApp({ store, site, release, index, library, matchFiles: matchFiles({ dir: join(records, 'replays'), store }),
    bugReports: reports, ai: fakeAI, engines, presets: meta.decks }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await engines.close();
  store.close();
  await rm(site, { recursive: true, force: true });
  await rm(records, { recursive: true, force: true });
});

function client() {
  let cookie = '';
  const call = async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(base + path, { method, headers: { ...(cookie && { cookie }), ...(body !== undefined && { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  return { call };
}
async function signedIn(username, password = 'long-enough-1') {
  const c = client();
  const r = await c.call('/api/auth/register', { method: 'POST', body: { username, password } });
  if (r.status !== 201) await c.call('/api/auth/login', { method: 'POST', body: { username, password } });
  return c;
}
async function admin() {
  const c = client();
  await c.call('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'admin-pass-1' } });
  return c;
}

// A table: keeps its view and the events it was sent, as the browser does.
function table(c, start) {
  const t = { c, id: start.match.id, events: [], cursor: null, status: null, view: null };
  t.take = (u) => {
    if (u.reset) t.events = [];
    t.events.push(...u.events);
    Object.assign(t, { cursor: u.cursor, status: u.status, view: u.view });
    return u;
  };
  t.take(start);
  t.post = async (op, body = {}) => {
    const r = await c.call(`/api/play/${t.id}/${op}`, { method: 'POST', body: { cursor: t.cursor, ...body } });
    if (r.status === 200 && r.data.view) t.take(r.data);
    return r;
  };
  t.catalog = release.catalogFor(start.match.decks.flatMap((d) => meta.decks.find((x) => x.id === d.id)?.cards.flatMap(([id, n]) => Array(n).fill(id)) ?? []));
  // One move: the player's (the CPU engine from the player's own view, unless `pick` chooses) or 小茂's.
  t.step = async (pick = null) => {
    if (t.status.actor === 1) return t.post('cpu', { revision: t.status.revision });
    const action = pick?.(t.view) ?? createAI(await t.catalog)(t.view, 0);
    return t.post('move', { revision: t.status.revision, action });
  };
  return t;
}
const start = async (c, body = { deck: 'raging-bolt-679141', opponent: 'dragapult-676815' }) => {
  const r = await c.call('/api/play', { method: 'POST', body });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return table(c, r.data);
};

test('a whole game on the server: the player sees only their view, the record replays, the seed shows only once it is over', async () => {
  const c = await signedIn('ash'), t = await start(c);
  assert.deepEqual(t.view.players[1].hand, { count: t.view.players[1].hand.count });
  const during = await c.call(`/api/matches/${t.id}`);
  assert.equal(during.data.match.setup.seed, null, 'The seed stays on the server while the game is on.');
  assert.equal(during.data.match.setup.server, true);
  assert.ok(!JSON.stringify(t.view).includes('"rng"'));
  for (let i = 0; i < 600 && t.status.actor !== null; i++) {
    assert.equal((await t.step()).status, 200, `move ${i}`);
    if (i === 50) assert.deepEqual(t.events, (await c.call(`/api/play/${t.id}`)).data.events, 'The events sent move by move are the whole history.');
  }
  assert.equal(t.status.actor, null, 'The game ends.');
  const { match, steps } = (await c.call(`/api/matches/${t.id}`)).data;
  assert.equal(match.status, 'over');
  assert.equal(match.setup.seed.length, 4, 'Over, the game shows its seed: the replay plays it again.');
  assert.deepEqual(steps.slice(-2).map((s) => s.type), ['snapshot', 'end']);
  assert.ok(steps.filter((s) => s.type === 'action').every((s) => [0, 1].includes(s.player) && /^[0-9a-f]{8}$/.test(s.hash)));
  // The checked kernel plays the record's first moves to the same states.
  const replay = await replayMatch({ release, setup: match.setup, steps, until: 30 });
  assert.equal(replay.failed, null);
  assert.equal(replay.diverged, null);
  assert.equal((await c.call(`/api/play/${t.id}`)).status, 409, 'A game over takes no more requests.');
});

test('commands are checked: the revision, whose move it is, the game and its player', async () => {
  const c = await signedIn('misty'), other = await signedIn('brock'), t = await start(c);
  while (t.status.actor !== 0) await t.step();
  const stale = await t.post('move', { revision: t.status.revision + 3, action: { type: 'endTurn' } });
  assert.deepEqual([stale.status, stale.data.code], [409, 'stale-command']);
  assert.deepEqual([(await t.post('cpu', { revision: t.status.revision })).data.code], ['not-cpu']);
  assert.equal((await t.post('move', { revision: t.status.revision, action: 'endTurn' })).status, 400);
  assert.equal((await other.call(`/api/play/${t.id}`)).status, 404);
  assert.equal((await other.call(`/api/play/${t.id}/move`, { method: 'POST', body: { revision: t.status.revision, action: { type: 'concede' } } })).status, 404);
  const steps = (await c.call(`/api/matches/${t.id}`)).data.steps;
  assert.deepEqual(steps.filter((s) => s.type === 'rejected').map((s) => s.error.code), ['stale-command']);
  const preview = await t.post('preview', { revision: t.status.revision, action: { type: 'endTurn' } });
  assert.deepEqual(preview.data, { pending: null });
  assert.equal((await c.call('/api/play', { method: 'POST', body: { deck: 'no-such-deck' } })).status, 404);
  assert.equal((await c.call('/api/play', { method: 'POST', body: { deck: 'raging-bolt-679141', level: 9 } })).status, 400);
  // Only an administrator fixes the seed (it would tell the player the order of both decks).
  const seeded = { deck: 'raging-bolt-679141', opponent: 'dragapult-676815', seed: [2, 7, 1, 8] };
  assert.equal((await c.call('/api/play', { method: 'POST', body: seeded })).status, 403);
  const boss = await admin(), dealt = await start(boss, seeded);
  assert.deepEqual((await boss.call(`/api/matches/${dealt.id}`)).data.match.setup.seed, [2, 7, 1, 8]);
  assert.equal((await boss.call('/api/play', { method: 'POST', body: { ...seeded, seed: [0, 0, 0, 0] } })).status, 400);
});

test('undo takes back the player\'s quiet moves of this turn, and only those', async () => {
  const c = await signedIn('gary'), t = await start(c);
  let undone = 0;
  for (let i = 0; i < 400 && t.status.actor !== null && !undone; i++) {
    const quietMove = t.status.actor === 0 && !t.view.pending && t.view.legalActions.find((a) => ['bench', 'attachEnergy'].includes(a.type));
    if (!quietMove) { await t.step(); continue; }
    const before = { revision: t.status.revision, events: t.events.length, hand: t.view.players[0].hand.length };
    const r = await t.post('move', { revision: t.status.revision, action: quietMove });
    assert.deepEqual([r.status, r.data.quiet, r.data.undo], [200, true, 1]);
    const back = await t.post('undo');
    assert.equal(back.status, 200);
    assert.equal(back.data.reset, true, 'An undo starts the view again.');
    assert.deepEqual([t.status.revision, t.events.length, t.view.players[0].hand.length], [before.revision, before.events, before.hand]);
    assert.equal((await t.post('undo')).data.code, 'no-undo');
    const rewind = (await c.call(`/api/matches/${t.id}`)).data.steps.at(-1);
    assert.deepEqual([rewind.type, rewind.revision, rewind.reason], ['rewind', before.revision, 'undo']);
    undone++;
  }
  assert.equal(undone, 1, 'The game offered a Bench or Energy move to take back.');
  // A move that is not quiet (ending the turn) leaves nothing to take back.
  while (t.status.actor !== 0 || t.view.pending) await t.step();
  const end = await t.post('move', { revision: t.status.revision, action: { type: 'endTurn' } });
  assert.deepEqual([end.data.quiet, end.data.undo], [false, 0]);
});

test('a game the engine pool lost opens again from its record; a reload gets the game still on; a new one abandons it', async () => {
  const c = await signedIn('dawn'), t = await start(c);
  for (let i = 0; i < 25; i++) await t.step();
  const was = t.status;
  await engines.call('close', { match: `match:${t.id}` });
  const again = await c.call(`/api/play/${t.id}?cursor=${encodeURIComponent(t.cursor)}`);
  assert.equal(again.status, 200);
  assert.deepEqual(again.data.status, was, 'Opened again from the record, at the same move.');
  assert.deepEqual(again.data.events, [], 'The same game: the table\'s cursor still holds and nothing new happened.');
  for (let i = 0; i < 5; i++) assert.equal((await t.step()).status, 200);
  const current = (await c.call('/api/play/current')).data;
  assert.equal(current.match.id, t.id);
  assert.deepEqual(current.status, t.status);
  const next = await start(c);
  assert.equal((await c.call(`/api/matches/${t.id}`)).data.match.status, 'abandoned');
  assert.equal((await c.call('/api/play/current')).data.match.id, next.id);
  assert.equal((await c.call(`/api/play/${next.id}/abandon`, { method: 'POST', body: {} })).status, 200);
  assert.equal((await c.call('/api/play/current')).data.match, null);
});

test('小茂 at a level plays the AI\'s move from the server\'s snapshot, and the CPU engine when the AI fails or is refused', async () => {
  const c = await signedIn('may'), t = await start(c, { deck: 'csvh1c-pikachu', opponent: 'raging-bolt-679141', level: 4 });
  assert.equal((await c.call(`/api/matches/${t.id}`)).data.match.setup.level, 4);
  fakeAI.calls = [];
  const seen = [];
  for (let i = 0; i < 80 && seen.length < 3; i++) {
    if (t.status.actor !== 1) { await t.step(); continue; }
    if (seen.length === 1) fakeAI.failNext = true;
    if (seen.length === 2) fakeAI.refuseNext = true;
    const r = await t.step();
    assert.equal(r.status, 200);
    seen.push(r.data.ai);
  }
  assert.deepEqual(seen.map((a) => [a.value, a.error]), [[0.42, null], [null, 'AI down'], [0.5, null]]);
  assert.ok(fakeAI.calls.every((x) => x.level === 4 && x.player === 1 && x.cards === 120), 'The AI gets the whole state (it deals the hidden cards again itself).');
  const rejected = (await c.call(`/api/matches/${t.id}`)).data.steps.filter((s) => s.type === 'rejected');
  assert.deepEqual(rejected.map((s) => [s.player, s.action.type]), [[1, 'retreat']], 'The refused AI move is recorded; the CPU engine moved instead.');
  while (t.status.actor !== 0 || t.view.pending) await t.step();
  const rate = await t.post('rate', { actions: t.view.legalActions.map((action, i) => ({ key: `a${i}`, action })) });
  assert.deepEqual([rate.status, rate.data.player, rate.data.cards, rate.data.ranking.choice], [200, 0, 120, 'a0']);
});

test('takeover: a game over played again up to a move is a new game of the player\'s, with those moves recorded', async () => {
  const c = await signedIn('serena'), t = await start(c);
  for (let i = 0; i < 30; i++) await t.step();
  const live = await c.call('/api/play/takeover', { method: 'POST', body: { match: t.id, move: 10 } });
  assert.equal(live.status, 409, 'A game still on cannot be taken over (its seed is still secret).');
  assert.equal((await t.post('move', { revision: t.status.revision, action: { type: 'concede' } })).status, 200, 'Either player may concede at any time.');
  assert.equal((await c.call(`/api/matches/${t.id}`)).data.match.status, 'over');
  const taken = await c.call('/api/play/takeover', { method: 'POST', body: { match: t.id, move: 20 } });
  assert.equal(taken.status, 201, JSON.stringify(taken.data));
  const { match, steps } = (await c.call(`/api/matches/${taken.data.match.id}`)).data;
  assert.deepEqual(match.setup.takeover, { match: t.id, move: 20 });
  const original = (await c.call(`/api/matches/${t.id}`)).data.steps.filter((s) => s.type === 'action').slice(0, 20);
  assert.deepEqual(steps.map((s) => [s.player, s.revision, s.hash]), original.map((s) => [s.player, s.revision, s.hash]));
  const current = (await c.call('/api/play/current')).data;
  assert.deepEqual([current.match.id, current.status.revision], [taken.data.match.id, 20]);
  assert.equal((await (await signedIn('rival')).call('/api/play/takeover', { method: 'POST', body: { match: t.id, move: 5 } })).status, 404);
});

test('administrators read and edit a game on the server; a bug report carries the server\'s state, not the browser\'s', async () => {
  const c = await signedIn('clemont'), boss = await admin(), t = await start(c);
  // The 调试台 edits a game between moves: the player's turn, nothing asked.
  for (let i = 0; i < 12 || t.status.actor !== 0 || t.view.pending || t.status.phase !== 'main'; i++) await t.step();
  assert.equal((await c.call(`/api/play/${t.id}/state`)).status, 403);
  const { snapshot } = (await boss.call(`/api/play/${t.id}/state`)).data;
  assert.equal(snapshot.revision, t.status.revision);
  const edited = structuredClone(snapshot);
  edited.revision++;
  const p = edited.players[0], moved = p.deck.pop();
  p.hand.push(moved);
  const r = await boss.call(`/api/play/${t.id}/state`, { method: 'POST', body: { state: edited, command: '/hand p0 1', lines: ['ok'] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const edit = (await c.call(`/api/matches/${t.id}`)).data.steps.at(-1);
  assert.deepEqual([edit.type, edit.revision, edit.command], ['edit', snapshot.revision, '/hand p0 1']);
  const view = (await c.call(`/api/play/${t.id}?cursor=${encodeURIComponent(t.cursor)}`)).data;
  assert.equal(view.reset, true);
  assert.ok(view.view.players[0].hand.some((card) => card.instanceId === moved), 'The player sees the edited hand.');
  // An edit made on an earlier position is refused (the record plays edits back as moves), and so is a broken state.
  const late = await boss.call(`/api/play/${t.id}/state`, { method: 'POST', body: { state: edited, command: '/hand p0 1' } });
  assert.deepEqual([late.status, late.data.code], [409, 'stale-command']);
  const bad = structuredClone(edited);
  bad.revision++;
  bad.players[0].hand.push('p0c999');
  assert.equal((await boss.call(`/api/play/${t.id}/state`, { method: 'POST', body: { state: bad } })).status, 409);

  const sent = await c.call('/api/bug-reports', { method: 'POST',
    body: { description: '手牌不对', matchId: t.id, move: t.status.revision, state: { forged: true } } });
  assert.equal(sent.status, 201);
  const report = JSON.parse(await readFile(join(reports.dir, `${sent.data.report.id}.json`), 'utf8'));
  assert.equal(report.state.forged, undefined);
  assert.equal(report.state.revision, edited.revision);
  assert.ok(report.state.players[1].deck.length > 0, 'The report has the whole state, from the server.');
});

test('an edit may bring in another game\'s cards: 小茂\'s CPU engine plays them, and the game opens again from its record', async () => {
  const c = await signedIn('bonnie'), boss = await admin(), t = await start(c);
  const source = await start(await signedIn('ash'), { deck: 'raging-bolt-679141', opponent: 'csvh1c-pikachu' });
  const between = (x) => x.status.actor === 0 && !x.view.pending && x.status.phase === 'main';
  for (let i = 0; i < 6 || !between(source); i++) await source.step();
  for (let i = 0; i < 6 || !between(t); i++) await t.step();
  const { snapshot } = (await boss.call(`/api/play/${source.id}/state`)).data;
  const r = await boss.call(`/api/play/${t.id}/state`, { method: 'POST',
    body: { state: { ...snapshot, revision: t.status.revision + 1 }, command: '/load', lines: [] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  t.take((await c.call(`/api/play/${t.id}?cursor=${encodeURIComponent(t.cursor)}`)).data);
  t.catalog = source.catalog;
  let cpu = 0;
  for (let i = 0; i < 60 && t.status.actor !== null; i++) {
    if (t.status.actor === 1) cpu++;
    assert.equal((await t.step()).status, 200, `move ${i}`);
  }
  assert.ok(cpu > 0, '小茂 moved after the edit.');
  const was = t.status;
  await engines.call('close', { match: `match:${t.id}` });
  if (was.actor !== null) {
    assert.deepEqual((await c.call(`/api/play/${t.id}`)).data.status, was, 'Opened again from its record, the edit included.');
    for (let i = 0; i < 10 && t.status.actor !== null; i++) assert.equal((await t.step()).status, 200);
  }
});
