// Games between two players (server/play.mjs): the lobby's rooms, a game with each player in their own seat seeing
// their own view, the push channel (server/events.mjs) telling each of the other's moves and coming and going, the
// decks and the record kept from the opponent until the game is over, conceding, and the clocks: a player whose time
// runs out loses, also after the server started again.
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
  // A page holding the push channel: every event it was sent, in order; `until` waits for one.
  async function listen() {
    const stop = new AbortController(), got = [], waiting = new Set();
    const r = await fetch(s.base + '/api/events', { headers: { cookie }, signal: stop.signal });
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
  const s = await serve(), red = await signedIn(s, 'red3'), blue = await signedIn(s, 'blue3'), boss = client(s);
  await boss.call('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'admin-pass-1' } });
  const redPage = await red.listen();
  const [a, b] = await meet(s, red, blue);
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
  for (const op of ['cpu', 'undo', 'coach']) assert.equal((await a.post(op, { revision: a.status.revision, actions: [{ key: 'x', action: {} }] })).data.code, 'pvp', op);

  // While it is on, neither player sees the other's deck, the record or the seed; an administrator watching does.
  const record = (await red.call(`/api/matches/${a.id}`)).data;
  assert.deepEqual(record.match.setup.decks.map((d) => d.cards.length), [60, 0]);
  assert.deepEqual([record.match.setup.decks[1].name, record.match.setup.seed, record.match.setup.approval, record.steps], [null, null, null, []]);
  assert.equal((await blue.call(`/api/matches/${a.id}`)).data.match.setup.decks[1].id, DRAGAPULT);
  const listed = (await blue.call('/api/matches')).data.matches.find((m) => m.id === a.id);
  assert.deepEqual([listed.pvp, listed.opponent.username, listed.setup.decks[0].name], [true, 'blue3', null]);
  const watched = (await boss.call(`/api/matches/${a.id}`)).data;
  assert.equal(watched.match.setup.decks[1].cards.length, 60);
  assert.ok(watched.steps.length > 0);
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
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(store.getMatch(g.id).result, { winner: 1 - g.status.actor, reason: 'timeout' });
  await stop(again);
});
