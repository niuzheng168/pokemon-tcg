// Games between two players (server/play.mjs): the lobby's rooms, a game with each player in their own seat seeing
// their own view, the push channel (server/events.mjs) telling each of the other's moves and coming and going, the
// decks and the record kept from the opponent until the game is over, conceding, and the clocks: a player whose time
// runs out loses, also after the server started again; spectators, and taking a finished game over in either seat.
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
import { createEnginePool } from '../../server/engine-pool.mjs';
import { bugReports } from '../../server/record-files.mjs';
import { replayMatch } from '../../public/replay.js';
import { createAI } from '../../public/cn/ai.js';
import { deckList } from '../../public/deck-check.js';

const meta = JSON.parse(await readFile(join(ROOT, 'public/data/cn/V20261019/decks.json'), 'utf8'));
const BOLT = 'raging-bolt-679141', DRAGAPULT = 'dragapult-676815', PIKACHU = 'csvh1c-pikachu';
const cardsOf = (id) => deckList(meta.decks.find((d) => d.id === id).cards);
let store, site, release, index, library, engines;
const servers = [];

before(async () => {
  site = await mkdtemp(join(tmpdir(), 'cn-pvp-site-'));
  await mkdir(join(site, 'play'), { recursive: true });
  for (const [f, text] of [['play/index.html', '<p>table</p>'], ['play/login.html', '<p>login</p>'], ['404.html', '<p>404</p>']])
    await writeFile(join(site, f), text);
  store = openStore(':memory:');
  await store.createUser({ username: 'boss', password: 'admin-pass-1', role: 'admin' });
  release = await loadRelease();
  index = await release.index();
  library = await loadLibrary({ dir: join(ROOT, 'tests/fixtures/card-library'), index, presentation: meta.cards });
  engines = createEnginePool({ workers: 0, release, slowMs: 1e9 });
});
after(async () => {
  for (const s of [...servers]) await stop(s);
  await engines.close();
  store.close();
  await rm(site, { recursive: true, force: true });
});

// A website on the shared database and engine pool; `minuteMs` shortens the clocks.
async function serve(options = {}) {
  const app = createApp({ store, site, release, index, library, engines, presets: meta.decks, ...options });
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const s = { app, server, base: `http://127.0.0.1:${server.address().port}` };
  servers.push(s);
  return s;
}
async function stop(s) {
  if (!servers.includes(s)) return;
  servers.splice(servers.indexOf(s), 1);
  s.app.close();
  s.server.closeAllConnections();
  await new Promise((r) => s.server.close(r));
}

function client(s) {
  let cookie = '';
  const call = async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(s.base + path, { method, headers: { ...(cookie && { cookie }), ...(body !== undefined && { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  // A page holding the push channel (watching game `watch`): every event it was sent, in order; `until` waits for one.
  async function listen({ watch = null } = {}) {
    const stop = new AbortController(), got = [], waiting = new Set();
    const r = await fetch(s.base + `/api/events${watch ? `?watch=${watch}` : ''}`, { headers: { cookie }, signal: stop.signal });
    assert.equal(r.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    (async () => {
      const text = new TextDecoder();
      let buffer = '';
      try {
        for await (const chunk of r.body) {
          buffer += text.decode(chunk, { stream: true });
          for (let i; (i = buffer.indexOf('\n\n')) >= 0; buffer = buffer.slice(i + 2)) {
            const block = buffer.slice(0, i), event = /^event: (.*)$/m.exec(block)?.[1];
            if (event) got.push({ event, data: JSON.parse(/^data: (.*)$/m.exec(block)[1]) });
          }
          for (const check of waiting) check();
        }
      } catch { /* the page went away */ }
    })();
    const until = (match, ms = 5000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(check); reject(new Error(`No event ${JSON.stringify(match)} in ${JSON.stringify(got)}`)); }, ms);
      function check() {
        const found = got.find((e) => e.event === match.event && Object.entries(match.data ?? {}).every(([k, v]) => e.data[k] === v));
        if (found) { clearTimeout(timer); waiting.delete(check); resolve(found); }
      }
      waiting.add(check);
      check();
    });
    return { got, until, close: () => stop.abort() };
  }
  return { call, listen };
}
async function signedIn(s, username, password = 'long-enough-1') {
  const c = client(s);
  const r = await c.call('/api/auth/register', { method: 'POST', body: { username, password } });
  if (r.status !== 201) await c.call('/api/auth/login', { method: 'POST', body: { username, password } });
  return c;
}

// A player's table: their view and the events they were sent, as the browser keeps them.
function table(c, start) {
  const t = { c, id: start.match.id, seat: start.match.seat, events: [], cursor: null };
  t.take = (u) => {
    if (u.reset) t.events = [];
    t.events.push(...u.events);
    Object.assign(t, { cursor: u.cursor, status: u.status, view: u.view, clock: u.clock, online: u.online });
    return u;
  };
  t.take(start);
  t.post = async (op, body = {}) => {
    const r = await c.call(`/api/play/${t.id}/${op}`, { method: 'POST', body: { cursor: t.cursor, ...body } });
    if (r.status === 200 && r.data.view) t.take(r.data);
    return r;
  };
  t.refresh = async () => {
    const r = await c.call(`/api/play/${t.id}?cursor=${encodeURIComponent(t.cursor)}`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return t.take(r.data);
  };
  return t;
}
// Both decks' cards, for the CPU engine that plays each seat here from that seat's own view.
let both = null;
const catalog = () => (both ??= release.catalogFor([...new Set([BOLT, DRAGAPULT].flatMap(cardsOf))]));
// One move by whoever must act; then the other table catches up.
async function step(tables) {
  const t = tables.find((x) => x.seat === x.status.actor), other = tables.find((x) => x !== t);
  const r = await t.post('move', { revision: t.status.revision, action: createAI(await catalog())(t.view, t.seat) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await other.refresh();
  return r;
}
async function meet(s, host, guest, { hostDeck = BOLT, guestDeck = DRAGAPULT, ...room } = {}) {
  const opened = await host.call('/api/rooms', { method: 'POST', body: { deck: hostDeck, ...room } });
  assert.equal(opened.status, 201, JSON.stringify(opened.data));
  const joined = await guest.call(`/api/rooms/${opened.data.room.id}/join`, { method: 'POST', body: { deck: guestDeck } });
  assert.equal(joined.status, 201, JSON.stringify(joined.data));
  const { id } = joined.data.match, hostView = await host.call(`/api/play/${id}`);
  return [table(host, { match: { id, seat: 0 }, ...hostView.data }), table(guest, joined.data)];
}

test('the lobby: a room waits with its host\'s deck and clock; another player joins it and the game is on', async () => {
  const s = await serve(), red = await signedIn(s, 'red'), blue = await signedIn(s, 'blue'), lobby = await blue.listen();
  assert.equal((await red.call('/api/rooms', { method: 'POST', body: { deck: BOLT, minutes: 7 } })).status, 400);
  assert.equal((await red.call('/api/rooms', { method: 'POST', body: { deck: PIKACHU, format: 'standard' } })).status, 400,
    'An Open deck does not open a Standard room.');
  const redPage = await red.listen();
  const opened = await red.call('/api/rooms', { method: 'POST', body: { deck: BOLT } });
  assert.equal(opened.status, 201);
  const room = opened.data.room;
  assert.deepEqual({ host: room.host.username, format: room.format, minutes: room.minutes, mine: room.mine }, { host: 'red', format: 'standard', minutes: 20, mine: true });
  await lobby.until({ event: 'rooms' });
  const seen = (await blue.call('/api/rooms')).data.rooms;
  assert.deepEqual(seen.map((r) => [r.id, r.mine]), [[room.id, false]]);
  assert.ok(!JSON.stringify(seen).includes(BOLT), 'The lobby does not show the host\'s deck.');
  assert.equal((await red.call(`/api/rooms/${room.id}/join`, { method: 'POST', body: { deck: DRAGAPULT } })).status, 409);
  assert.equal((await blue.call(`/api/rooms/${room.id}/join`, { method: 'POST', body: { deck: PIKACHU } })).status, 400,
    'The guest\'s deck must be legal in the room\'s format.');

  const joined = await blue.call(`/api/rooms/${room.id}/join`, { method: 'POST', body: { deck: DRAGAPULT } });
  assert.equal(joined.status, 201, JSON.stringify(joined.data));
  const { match } = joined.data;
  assert.deepEqual({ seat: match.seat, pvp: match.pvp, minutes: match.minutes, players: match.players.map((p) => p.username) },
    { seat: 1, pvp: true, minutes: 20, players: ['red', 'blue'] });
  assert.deepEqual(match.decks[0], { id: null, name: null }, 'The guest does not see the host\'s deck.');
  assert.equal(match.decks[1].id, DRAGAPULT);
  const { left, running } = joined.data.clock;
  assert.equal(running, joined.data.status.actor, 'The clock runs for the player the engine waits for.');
  assert.equal(left[1 - running], 1_200_000);
  assert.ok(left[running] > 1_190_000 && left[running] <= 1_200_000);
  assert.equal(joined.data.online, true, 'The host has the site open.');
  await redPage.until({ event: 'match', data: { id: match.id } });
  assert.deepEqual((await blue.call('/api/rooms')).data.rooms, [], 'A room joined leaves the lobby.');
  assert.equal((await blue.call(`/api/rooms/${room.id}/join`, { method: 'POST', body: { deck: DRAGAPULT } })).status, 404);

  // The host's table picks the game up; each deck went to the engine in an order of its own.
  const host = (await red.call('/api/play/current')).data;
  assert.deepEqual([host.match.id, host.match.seat, host.match.decks[1]], [match.id, 0, { id: null, name: null }]);
  const record = store.getMatch(match.id);
  assert.deepEqual([record.username, record.opponentName, record.setup.pvp, record.setup.clock], ['red', 'blue', true, { minutes: 20 }]);
  assert.deepEqual([...record.setup.decks[0].cards].sort(), [...cardsOf(BOLT)].sort());
  assert.notDeepEqual(record.setup.decks[0].cards, cardsOf(BOLT));
  // While it is on, neither player opens another game or room.
  assert.equal((await red.call('/api/play', { method: 'POST', body: { deck: BOLT } })).data.code, 'in-game');
  assert.equal((await blue.call('/api/rooms', { method: 'POST', body: { deck: BOLT } })).data.code, 'in-game');
  await red.call(`/api/play/${match.id}/concede`, { method: 'POST', body: {} });
  lobby.close();
  redPage.close();
});

test('a room closes when its host cancels it or starts another game', async () => {
  const s = await serve(), misty = await signedIn(s, 'misty2'), page = await misty.listen();
  const first = (await misty.call('/api/rooms', { method: 'POST', body: { deck: BOLT, minutes: 10 } })).data.room;
  const second = (await misty.call('/api/rooms', { method: 'POST', body: { deck: DRAGAPULT, minutes: 30 } })).data.room;
  assert.deepEqual((await misty.call('/api/rooms')).data.rooms.map((r) => [r.id, r.minutes]), [[second.id, 30]], 'One room per host.');
  assert.equal((await misty.call(`/api/rooms/${second.id}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual((await misty.call('/api/rooms')).data.rooms, []);
  assert.notEqual(first.id, second.id);
  await misty.call('/api/rooms', { method: 'POST', body: { deck: BOLT } });
  assert.equal((await misty.call('/api/play', { method: 'POST', body: { deck: BOLT, opponent: DRAGAPULT } })).status, 201);
  assert.deepEqual((await misty.call('/api/rooms')).data.rooms, [], 'A game against 小茂 closes the room.');
  page.close();
});

test('a game between two players: each plays their own seat and sees their own cards; the other hears of every move', async () => {
  // (A fixed deal, on a test server: the game reaches its third turn every run.)
  const s = await serve({ testSeeds: true }), red = await signedIn(s, 'red3'), blue = await signedIn(s, 'blue3'), boss = client(s);
  await boss.call('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'admin-pass-1' } });
  const redPage = await red.listen();
  const [a, b] = await meet(s, red, blue, { seed: [3, 7, 1, 8] });
  assert.deepEqual([a.seat, b.seat], [0, 1]);
  const bluePage = await blue.listen();
  await redPage.until({ event: 'presence', data: { id: a.id, online: true } });

  for (let i = 0; i < 400 && a.status.actor !== null && a.status.turn < 3; i++) {
    const before = a.status.revision;
    await step([a, b]);
    await redPage.until({ event: 'move', data: { id: a.id, revision: before + 1 } });
    await bluePage.until({ event: 'move', data: { id: a.id, revision: before + 1 } });
  }
  assert.equal(a.status.turn, 3, 'The game got past its setup and first turns.');
  assert.deepEqual(a.status, b.status);
  for (const [t, other] of [[a, b], [b, a]]) {
    assert.ok(Array.isArray(t.view.players[t.seat].hand), 'Each player sees their own hand…');
    assert.deepEqual(t.view.players[other.seat].hand, { count: other.view.players[other.seat].hand.length }, '…and the count of the other\'s.');
  }
  // A player plays their own seat only; the requests of games against 小茂 are refused.
  const waiting = a.status.actor === 0 ? b : a;
  const out = await waiting.post('move', { revision: waiting.status.revision, action: { type: 'endTurn' } });
  assert.equal(out.status, 409);
  assert.equal((await a.post('coach', { revision: a.status.revision })).data.code, 'coach-forbidden');
  store.setCoachEnabled(store.userByName('red3').id, true);
  assert.equal((await a.post('coach', { revision: a.status.revision })).data.code, 'pvp-coach-forbidden');
  for (const op of ['cpu', 'undo']) assert.equal((await a.post(op, { revision: a.status.revision, actions: [{ key: 'x', action: {} }] })).data.code, 'pvp', op);

  // While it is on, neither player sees the other's deck, the record or the seed; an administrator watching does.
  const record = (await red.call(`/api/matches/${a.id}`)).data;
  assert.deepEqual(record.match.setup.decks.map((d) => d.cards.length), [60, 0]);
  assert.deepEqual([record.match.setup.decks[1].name, record.match.setup.seed, record.match.setup.approval, record.steps], [null, null, null, []]);
  assert.equal((await blue.call(`/api/matches/${a.id}`)).data.match.setup.decks[1].id, DRAGAPULT);
  const listed = (await blue.call('/api/matches')).data.matches.find((m) => m.id === a.id);
  assert.deepEqual([listed.pvp, listed.opponent.username, listed.setup.decks[0].name], [true, 'blue3', null]);
  // Nor does an administrator, nor anyone's browser show: what they could see they could tell.
  const watched = (await boss.call(`/api/matches/${a.id}`)).data;
  assert.deepEqual([watched.match.setup.decks.map((d) => d.cards.length), watched.match.setup.seed, watched.steps], [[0, 0], null, []]);
  assert.equal(record.match.userAgent, null);
  assert.equal((await boss.call(`/api/play/${a.id}/state`, { method: 'POST', body: { state: { revision: 1, cards: {} } } })).status, 403);

  // The guest closes the page: the host is told; the guest's table picks the game up again in seat 1.
  bluePage.close();
  await redPage.until({ event: 'presence', data: { id: a.id, online: false } });
  const back = (await blue.call('/api/play/current')).data;
  assert.deepEqual([back.match.id, back.match.seat, back.online], [a.id, 1, true]);

  // Conceding ends it for both: the winner's table sees the end after the other's move.
  const ended = await b.post('concede');
  assert.equal(ended.status, 200);
  assert.deepEqual(ended.data.status.result, { winner: 0, reason: 'concede' });
  await redPage.until({ event: 'move', data: { id: a.id, revision: ended.data.status.revision } });
  await a.refresh();
  assert.deepEqual(a.status.result, { winner: 0, reason: 'concede' });
  assert.equal(a.clock.running, null);
  const over = (await red.call(`/api/matches/${a.id}`)).data;
  assert.equal(over.match.status, 'over');
  assert.equal(over.match.setup.decks[1].cards.length, 60, 'Over, the record shows both decks…');
  assert.deepEqual(over.steps.slice(-3).map((x) => x.type), ['action', 'snapshot', 'end']);
  const replay = await replayMatch({ release, setup: over.match.setup, steps: over.steps });
  assert.deepEqual([replay.failed, replay.diverged], [null, null], '…and replays.');
  assert.equal((await red.call('/api/play', { method: 'POST', body: { deck: BOLT, opponent: DRAGAPULT } })).status, 201, 'Over, the players play on.');
  redPage.close();
});

test('the clock: the player it runs for loses when their time is up, also after the server started again', async () => {
  // Here a minute is 3 ms: the 10 minutes of each player last 30 ms.
  const s = await serve({ minuteMs: 3 }), red = await signedIn(s, 'red4'), blue = await signedIn(s, 'blue4');
  const redPage = await red.listen();
  const [a] = await meet(s, red, blue, { minutes: 10 });
  const loser = a.status.actor;
  await redPage.until({ event: 'move', data: { id: a.id } }, 3000);
  const record = store.getMatch(a.id);
  assert.deepEqual(record.result, { winner: 1 - loser, reason: 'timeout' });
  const steps = store.matchSteps(a.id);
  assert.deepEqual(steps.at(-3).action, { type: 'concede' });
  assert.deepEqual([steps.at(-3).player, steps.at(-3).reason], [loser, 'timeout']);
  await a.refresh();
  assert.deepEqual([a.status.result, a.view.result], [{ winner: 1 - loser, reason: 'timeout' }, { winner: 1 - loser, reason: 'timeout' }]);
  assert.equal(a.clock.left[loser], 0);
  redPage.close();

  // A game on when the server stops: its clock runs again when the server starts, from where it was.
  const slow = await serve({ minuteMs: 60_000 }), green = await signedIn(slow, 'green4'), yellow = await signedIn(slow, 'yellow4');
  const [g] = await meet(slow, green, yellow, { minutes: 10 });
  await stop(slow);
  const left = store.getMatch(g.id).clock.left;
  store.updateMatch(g.id, { clock: { ...store.getMatch(g.id).clock, left: left.map((ms, seat) => (seat === g.status.actor ? 20 : ms)), since: 0 } });
  const again = await serve({ minuteMs: 60_000 });
  // (Called a second late: a move that came in on time would be played first.)
  for (let i = 0; i < 40 && store.getMatch(g.id).status === 'playing'; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(store.getMatch(g.id).result, { winner: 1 - g.status.actor, reason: 'timeout' });
  await stop(again);
});

test('spectators: the lobby lists the games on; a spectator sees what both players see and hears every move; the players hear how many watch', async () => {
  const reports = bugReports({ dir: join(site, 'bug-reports') });
  const s = await serve({ bugReports: reports }), red = await signedIn(s, 'red5'), blue = await signedIn(s, 'blue5'), gray = await signedIn(s, 'gray5');
  const boss = client(s);
  await boss.call('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'admin-pass-1' } });
  const lobby = await gray.listen(), redPage = await red.listen();
  const [a, b] = await meet(s, red, blue);
  await lobby.until({ event: 'games' });
  const listed = (await gray.call('/api/games')).data.games.find((x) => x.id === a.id);
  assert.deepEqual([listed.players.map((p) => p.username), listed.minutes, listed.watchers], [['red5', 'blue5'], 20, 0]);

  const grayPage = await gray.listen({ watch: a.id });
  await redPage.until({ event: 'watchers', data: { id: a.id, count: 1 } });
  const first = await gray.call(`/api/play/${a.id}/watch`);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const w = first.data;
  assert.deepEqual([w.match.seat, w.match.watching, w.match.pvp, w.match.decks], [null, true, true, [{ id: null, name: null }, { id: null, name: null }]]);
  assert.deepEqual([w.online, w.watchers, w.view.pending, w.view.legalActions], [[true, false], 1, null, []]);
  assert.equal(w.clock.running, w.status.actor);
  const bluePage = await blue.listen();
  await grayPage.until({ event: 'presence', data: { id: a.id, seat: 1, online: true } });
  // (A dozen moves: still the setup, whatever the deal.)
  let cursor = w.cursor, seen = [...w.events];
  for (let i = 0; i < 12; i++) {
    const before = a.status.revision;
    await step([a, b]);
    await grayPage.until({ event: 'move', data: { id: a.id, revision: before + 1 } });
    const r = (await gray.call(`/api/play/${a.id}/watch?cursor=${encodeURIComponent(cursor)}`)).data;
    seen.push(...r.events);
    cursor = r.cursor;
    const { snapshot } = await engines.call('snapshot', { match: `match:${a.id}` }), text = JSON.stringify(r.view);
    for (const p of snapshot.players) {
      for (const id of [...p.hand, ...p.deck]) assert.ok(!text.includes(`"${id}"`), `The spectator sees ${id}.`);
      assert.deepEqual(r.view.players[snapshot.players.indexOf(p)].hand, { count: p.hand.length });
    }
  }
  assert.ok(seen.length > 10 && seen.every((e) => e.visibility === 'public'));
  assert.deepEqual(seen, (await gray.call(`/api/play/${a.id}/watch`)).data.events, 'The events sent move by move are the whole public history.');
  assert.equal((await a.refresh()).watchers, 1, 'The players see how many watch.');
  // While it is on, the record stays its players'; a spectator's bug report names the game, its record in the file only.
  assert.equal((await gray.call(`/api/matches/${a.id}`)).status, 404);
  const report = await gray.call('/api/bug-reports', { method: 'POST', body: { description: '观战时看到的问题', matchId: a.id } });
  assert.equal(report.status, 201, JSON.stringify(report.data));
  assert.deepEqual(Object.keys(report.data), ['report']);
  const filed = JSON.parse(await readFile(join(reports.dir, `${report.data.report.id}.json`), 'utf8'));
  assert.deepEqual([filed.matchId, filed.match.id, filed.state], [a.id, a.id, null], 'No whole state for a spectator\'s report.');
  // The 调试台 stays shut while two players play, for an administrator too.
  assert.equal((await boss.call(`/api/play/${a.id}/state`)).status, 403);
  grayPage.close();
  await redPage.until({ event: 'watchers', data: { id: a.id, count: 0 } });

  const ended = await a.post('concede');
  await lobby.until({ event: 'games' });
  assert.ok(!(await gray.call('/api/games')).data.games.some((x) => x.id === a.id), 'A game over leaves the list.');
  const over = (await gray.call(`/api/play/${a.id}/watch`)).data;
  assert.deepEqual(over.status.result, ended.data.status.result);
  assert.deepEqual(over.match.decks.map((d) => d.id), [BOLT, DRAGAPULT], 'Over, the decks are shown.');
  // Over, anyone may read its record (the replay) and take it over.
  const record = await gray.call(`/api/matches/${a.id}`);
  assert.deepEqual([record.status, record.data.match.setup.decks[1].cards.length, record.data.steps.length > 0], [200, 60, true]);
  assert.equal((await gray.call(`/api/matches/${a.id}/steps`, { method: 'POST', body: { steps: [] } })).status, 404, 'Nor written by a spectator.');
  const taken = await gray.call('/api/play/takeover', { method: 'POST', body: { match: a.id, move: 3, seat: 1 } });
  assert.deepEqual([taken.status, taken.data.match?.seat], [201, 1]);
  assert.equal((await gray.call(`/api/play/999999/watch`)).status, 404);
  // A game against 小茂 is not watched.
  const own = await gray.call('/api/play', { method: 'POST', body: { deck: BOLT, opponent: DRAGAPULT } });
  assert.equal((await red.call(`/api/play/${own.data.match.id}/watch`)).status, 404);
  for (const page of [lobby, redPage, bluePage]) page.close();
});

test('a finished game taken over in either seat: the player plays the side they chose, 小茂 the other', async () => {
  // (A fixed deal, on a test server: the same game, and the same moves of 小茂's after it, every run.)
  const s = await serve({ testSeeds: true }), red = await signedIn(s, 'red6'), blue = await signedIn(s, 'blue6');
  const [a, b] = await meet(s, red, blue, { seed: [5, 9, 2, 6] });
  for (let i = 0; i < 30 && a.status.actor !== null; i++) await step([a, b]);
  await a.post('concede');
  const moves = (await blue.call(`/api/matches/${a.id}`)).data.steps.filter((x) => x.type === 'action').length - 1;
  assert.equal((await red.call('/api/play/takeover', { method: 'POST', body: { match: a.id, move: moves, seat: 2 } })).status, 400);
  // The guest takes over in their own seat by default; the host chooses the guest's side.
  const guest = await blue.call('/api/play/takeover', { method: 'POST', body: { match: a.id, move: moves } });
  assert.equal(guest.status, 201, JSON.stringify(guest.data));
  assert.deepEqual([guest.data.match.seat, guest.data.match.pvp, guest.data.match.players[0], guest.data.match.players[1].username], [1, false, null, 'blue6']);
  const host = await red.call('/api/play/takeover', { method: 'POST', body: { match: a.id, move: moves, seat: 1, level: null } });
  assert.equal(host.data.match.seat, 1);

  // Red plays seat 1 against 小茂, whose moves the server makes for seat 0; an undo takes back red's quiet move.
  const current = (await red.call('/api/play/current')).data;
  assert.deepEqual([current.match.id, current.match.seat], [host.data.match.id, 1]);
  const t = table(red, current);
  let undone = 0;
  for (let i = 0; i < 400 && t.status.actor !== null && !undone; i++) {
    if (t.status.actor === 0) { assert.equal((await t.post('cpu', { revision: t.status.revision })).status, 200); continue; }
    assert.ok(Array.isArray(t.view.players[1].hand), 'The player sees seat 1\'s hand.');
    const quiet = !undone && !t.view.pending && t.view.legalActions.find((x) => ['bench', 'attachEnergy'].includes(x.type));
    if (quiet) {
      const revision = t.status.revision;
      assert.deepEqual((await t.post('move', { revision, action: quiet })).data.undo, 1);
      assert.equal((await t.post('undo')).status, 200);
      assert.equal(t.status.revision, revision);
      undone++;
      continue;
    }
    assert.equal((await t.post('move', { revision: t.status.revision, action: createAI(await catalog())(t.view, 1) })).status, 200);
  }
  assert.equal(undone, 1, 'Seat 1 had a quiet move to take back.');
  const steps = store.matchSteps(t.id).filter((x) => x.type === 'action').slice(moves);
  assert.ok(steps.some((x) => x.player === 0) && steps.some((x) => x.player === 1), 'Both seats moved after the takeover.');
  assert.equal(store.getMatch(t.id).setup.seat, 1);
});

// The engine pool as the server sees it, `hook(op, params)` asked before each call (it may wait, or throw).
const hooked = (hook) => ({ call: async (op, params) => { await hook(op, params); return engines.call(op, params); }, close: async () => {} });

test('a crowd of spectators costs one engine view a move, and one account is held to a few requests at a time', async () => {
  // (Each view takes the engine a moment here: the requests pile up while the first is made.)
  let views = 0;
  const s = await serve({ engines: hooked(async (op) => { if (op === 'watch') { views++; await new Promise((r) => setTimeout(r, 200)); } }) });
  const red = await signedIn(s, 'red7'), blue = await signedIn(s, 'blue7'), gray = await signedIn(s, 'gray7');
  const [a, b] = await meet(s, red, blue);
  const flood = await Promise.all(Array.from({ length: 40 }, () => gray.call(`/api/play/${a.id}/watch`)));
  const answered = flood.filter((r) => r.status === 200).length;
  assert.ok(answered >= 8 && flood.every((r) => [200, 429].includes(r.status)), `${answered} answered`);
  assert.ok(flood.some((r) => r.status === 429), 'More than a few at once are refused.');
  assert.equal(views, 1, 'One view of the position served them all.');
  await step([a, b]);
  await gray.call(`/api/play/${a.id}/watch`);
  await gray.call(`/api/play/${a.id}/watch`);
  assert.equal(views, 2, 'A move: one view more.');
  // A player keeps a few pages open at most; a few rooms a minute; no seed for a room on a real server.
  const pages = [];
  for (let i = 0; i < 8; i++) pages.push(await gray.listen());
  const over = await gray.call('/api/events');
  assert.equal(over.status, 429);
  for (const page of pages) page.close();
  assert.equal((await gray.call('/api/rooms', { method: 'POST', body: { deck: BOLT, seed: [1, 2, 3, 4] } })).status, 403);
  const opened = [];
  for (let i = 0; i < 11; i++) opened.push((await gray.call('/api/rooms', { method: 'POST', body: { deck: BOLT } })).status);
  assert.deepEqual([opened.slice(0, 10).every((x) => x === 201), opened[10]], [true, 429]);
  await a.post('concede');
});

test('the clock stops when a move comes in: a move that came in on time counts, however long the queue held it', async () => {
  // The next move is held 1.5 s in the queue, longer than the 0.2 s its player has left and the clock's grace after.
  let hold = 0;
  const slow = hooked(async (op) => { if (op === 'play' && hold) { const ms = hold; hold = 0; await new Promise((r) => setTimeout(r, ms)); } });
  const first = await serve({ engines: slow }), red = await signedIn(first, 'red8'), blue = await signedIn(first, 'blue8');
  const [a] = await meet(first, red, blue, { minutes: 10 });
  await stop(first);
  const actor = a.status.actor, clock = store.getMatch(a.id).clock;
  store.updateMatch(a.id, { clock: { ...clock, left: clock.left.map((ms, seat) => (seat === actor ? 200 : ms)) } });
  const s = await serve({ engines: slow });
  const player = client(s);
  await player.call('/api/auth/login', { method: 'POST', body: { username: actor === 0 ? 'red8' : 'blue8', password: 'long-enough-1' } });
  const t = table(player, { match: { id: a.id, seat: actor }, ...(await player.call(`/api/play/${a.id}`)).data });
  hold = 1500;
  const r = await t.post('move', { revision: t.status.revision, action: createAI(await catalog())(t.view, actor) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await new Promise((done) => setTimeout(done, 400));
  const after = store.getMatch(a.id);
  assert.equal(after.status, 'playing', 'The clock was not called on the move held in the queue.');
  assert.ok(after.clock.left[actor] > 0 && after.clock.left[actor] <= 200, `left ${after.clock.left[actor]}`);
  await stop(s);
});

test('a player\'s record entries are their browser\'s errors only, kept short and few; the browser shows to administrators only', async () => {
  const s = await serve(), red = await signedIn(s, 'red9'), blue = await signedIn(s, 'blue9');
  const [a] = await meet(s, red, blue);
  const sent = await blue.call(`/api/matches/${a.id}/steps`, { method: 'POST', body: { steps: [
    { key: 'e1', step: { type: 'error', message: 'x'.repeat(5000), stack: 'trace', at: '1999-01-01', seq: 999, result: { winner: 1 } } }] } });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const kept = store.matchSteps(a.id).find((x) => x.key === 'e1');
  assert.deepEqual([kept.type, kept.message.length, kept.stack, kept.result, typeof kept.at], ['error', 1000, 'trace', undefined, 'number']);
  assert.notEqual(kept.seq, 999);
  assert.equal((await blue.call(`/api/matches/${a.id}/steps`, { method: 'POST', body: { steps: [{ key: 'a1', step: { type: 'action' } }] } })).status, 403);
  const many = Array.from({ length: 200 }, (_, i) => ({ key: `m${i}`, step: { type: 'error', message: String(i) } }));
  assert.equal((await blue.call(`/api/matches/${a.id}/steps`, { method: 'POST', body: { steps: many } })).status, 413, 'At most 200 a game.');
  // An administrator playing a game between two players adds errors only, like anyone.
  const boss = client(s);
  await boss.call('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'admin-pass-1' } });
  const [g] = await meet(s, boss, await signedIn(s, 'green9'));
  assert.equal((await boss.call(`/api/matches/${g.id}/steps`, { method: 'POST', body: { status: 'over', steps: [] } })).status, 403);
  assert.equal((await red.call(`/api/matches/${a.id}`)).data.match.userAgent, null);
  await a.post('concede');
  await g.post('concede');
});

test('a game the engine stopped still ends when a player concedes: neither player is held in it', async () => {
  let stopped = false;
  const s = await serve({ engines: hooked((op) => {
    if (stopped && op === 'play') throw Object.assign(new Error('Match stopped: the state fails its check'), { code: 'state-invalid' });
  }) });
  const red = await signedIn(s, 'red10'), blue = await signedIn(s, 'blue10'), redPage = await red.listen();
  const [a] = await meet(s, red, blue);
  stopped = true;
  const out = await a.post('concede');
  assert.deepEqual([out.status, out.data.code], [409, 'game-over']);
  assert.deepEqual([store.getMatch(a.id).status, store.getMatch(a.id).result], ['over', { winner: 1, reason: 'concede' }]);
  assert.deepEqual(store.matchSteps(a.id).at(-1), { ...store.matchSteps(a.id).at(-1), type: 'end', stopped: true });
  await redPage.until({ event: 'move', data: { id: a.id } });
  stopped = false;
  assert.equal((await red.call('/api/play', { method: 'POST', body: { deck: BOLT, opponent: DRAGAPULT } })).status, 201, 'Free to play again.');
  redPage.close();
});
