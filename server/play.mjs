// The table's games, played on the server (docs/ENGINE-PROTOCOL.md): each game lives in the engine pool, the player in
// seat 0 and 小茂 in seat 1 (a game taken over from a replay seats the player where they chose: setup.seat). A game gets
// its seed and both decks here; 小茂's moves are made here (the AI service at the
// game's level, a language model at a model level, else the CPU engine from his own view); the language-model coach
// beside the player is asked here; the player's undo is allowed or refused here; and the record is
// written here in the step format of public/replay.js. The browser sends its commands and gets its own view only: the
// seed, the order of the decks and 小茂's hand stay on the server while the game is on.
//
// A game's record is the truth: when the pool no longer has a game (a restart, a worker that stopped, a game left idle
// and closed) it is opened again from its setup and its moves (and an administrator's edits) before the request goes on.
//
// Two players play each other from the lobby: one opens a room, another joins it with a deck, and the game is on with
// the room's host in seat 0 and the guest in seat 1 (setup.pvp). Each sees their own seat's view only; neither sees
// the other's deck, the record or the seed until the game is over (server/app.mjs), and the decks go to the engine in
// an order of their own (a card's instance id numbers it in its deck list) so a card shown tells nothing of the list.
// Each player has setup.clock.minutes for the whole game, running while the engine waits for them (status.actor); a
// player whose time runs out concedes, the record saying why. The push channel (server/events.mjs) tells both players of
// each move and of the opponent's coming and going. There is no undo or 调试台; coaching needs separate permission
// and each player's coach reads only that seat's observations. Anyone
// signed in may watch it: a spectator gets what both players see (the engine's view for no seat), and the push channel
// tells the watching pages of each move; the players see how many watch.
import { randomUUID, randomInt } from 'node:crypto';
import { createAI } from '../public/cn/ai.js';
import { deckList } from '../public/deck-check.js';
import { effectiveMoves, stateHash } from '../public/replay.js';
import { QUIET } from '../public/match.js';
import { catalogReleaseReceipt } from '../public/rules/catalog-release.js';
import { releaseIdentity } from '../public/release-identity.js';
import { implementationSummaryFromIndex } from '../public/card-quality.js';
import { Simulation, createGameState } from '../public/rules/engine.js';
import { LEVELS } from '../ai/agents.mjs';
import { RULE_LEVEL } from '../ai/llm-levels.mjs';
import { llmPlayer } from '../ai/llm-player.mjs';
import { describer } from '../ai/describe.mjs';
import { DECK_POOL } from '../ai/decks.mjs';

// The seats of a game against 小茂: the player's (setup.seat: 0 unless a takeover chose 1) and his.
const playerSeat = (m) => m.setup.seat ?? 0, botSeat = (m) => 1 - playerSeat(m);
const coachKey = (seat) => `coach:${seat}`;
// Moves an undo may take back (a learning aid against 小茂): the player's own this turn, and only ones that revealed
// nothing new (match.js QUIET).
const UNDOABLE = new Set(['bench', 'evolve', 'attachEnergy']);
// A game nobody has asked about for this long leaves the pool; its record opens it again when it is needed.
const IDLE_MS = 2 * 3600_000;
// A room's clock choices (each player's minutes for the whole game); a room whose host has had no page open this long
// closes.
export const CLOCK_MINUTES = [10, 20, 30], DEFAULT_MINUTES = 20;
const ROOM_LEFT_MS = 30_000;
// A clock that ran out is called this long after, so a move that reached the server in time is played first.
const CLOCK_GRACE_MS = 1000;
// Rooms a player may open in a minute (each one is pushed to every page in the lobby).
const ROOMS_PER_MINUTE = 10;
const FORMATS = ['standard', 'open'];
const CONCEDE = { type: 'concede' };
// The engine's codes for a game it stopped, or could not open again from its record.
const STOPPED = new Set(['state-invalid', 'replay-refused']);

export class PlayError extends Error {
  constructor(status, message, code = null) { super(message); this.name = 'PlayError'; this.status = status; this.code = code; }
}
const fail = (status, message, code) => { throw new PlayError(status, message, code); };
const isObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
// A player's seat in a game: its owner's (the host's 0 in a game between two players), 1 for the guest of a game
// between two players; null for anyone else.
export const seatOf = (m, user) => (m.userId === user.id ? (m.setup.pvp ? 0 : playerSeat(m)) : m.setup.pvp && m.opponentId === user.id ? 1 : null);
// Each player's time left on a game's clock {left, actor, since} at `at`: the actor's runs from `since`.
export const timeLeft = (clock, at = Date.now()) =>
  clock.left.map((ms, seat) => (seat === clock.actor ? Math.max(0, ms - (at - clock.since)) : ms));
function shuffled(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) { const j = randomInt(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
// A pool deck by its 60 cards: a player's copy of one plays with its checked playbook (ai/deck-playbooks.json).
const listKey = (cards) => [...cards].sort().join('|');
const POOL_BY_LIST = new Map(Object.values(DECK_POOL).map((d) => [listKey(d.cards.flatMap(([p, n]) => Array(n).fill(p))), d.id]));
// Without a push channel (tests of the CPU games): nobody is online and nothing is sent.
const NO_HUB = { send() {}, broadcast() {}, sendWatchers() {}, watchers: () => 0, online: () => false, listen() {}, listenWatch() {} };
// What the language-model seats are told when the player takes a move back.
const UNDONE = { cpu: '（对手撤销了本回合的上一步，以下面的局面为准。）', coach: '（玩家撤销了上一步，以下面的局面为准。）' };

/**
 * `pool`: server/engine-pool.mjs. `presets`: the release's decks (decks.json). `checkDeck(cards, format)`: a saved deck's
 * check (deck-check.js checkIndexedDeck). `ai`: the AI service (ai/service.mjs or its remote client), or null.
 * `llm`: the language-model levels and coach (ai/llm-levels.mjs llmConfig: { levels, coach }; `ask`, `tries` and
 * `timeoutMs` for its calls, ai/foundry.mjs askJSON by default; `log` for each call's time and tokens, console.log by
 * default), or null.
 * `onRecord(id)`: a record changed (its file in the replay directory follows). `anySeed`: any player may fix a game's
 * seed (a test server's browser tests); otherwise only administrators. `hub`: the push channel (server/events.mjs).
 * `minuteMs`: a minute on the clocks (tests run them out quickly).
 */
export function createPlay({ store, release, index, pool, presets, checkDeck, ai = null, aiReady = async () => !!ai, llm = null,
  onRecord = () => {}, anySeed = false, hub = NO_HUB, minuteMs = 60_000 }) {
  const live = new Map(), reopening = new Map(), catalogs = new Map(), rooms = new Map(), clocks = new Map();
  // Moves that reached the server and wait in their game's queue (the clock is not called on a player whose move is in);
  // the rooms each player opened in the last minute.
  const inbound = new Map(), roomsOpened = new Map();
  let nextRoom = 1;
  const key = (id) => `match:${id}`;
  const ruleset = { region: presets[0].format.region, version: presets[0].format.version };

  // Requests for one game run one at a time: a move is several engine calls and a record. (The coach's questions run
  // one at a time in a lane of their own, beside the game's.)
  const lane = (queues = new Map()) => (id, fn) => {
    const run = (queues.get(id) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    queues.set(id, tail);
    tail.then(() => { if (queues.get(id) === tail) queues.delete(id); });
    return run;
  };
  const serial = lane(), coaching = lane();

  // What the server keeps of a game besides its record: each player's view cursor (to tell what a move revealed), the
  // moves an undo may take back, 小茂's moves this turn (a guard against an AI that would not end its turn), the cards
  // of a game an administrator edited (an edit may bring in cards of other decks), and the language-model seats'
  // mirror (and the turn their model failed in, played by the rule AI to its end).
  const fresh = (cards = null) => ({ cursors: [null, null], undo: [], turn: null, turnMoves: 0, cards, mirror: null, llmPause: null, used: Date.now() });
  const state = (id) => {
    if (!live.has(id)) live.set(id, fresh());
    const s = live.get(id);
    s.used = Date.now();
    return s;
  };

  // The cards of both decks: the record's approval and the CPU engine's catalog.
  function catalogFor(decks) {
    const ids = [...new Set(decks.flatMap((d) => d.cards))].sort(), k = ids.join('|');
    if (!catalogs.has(k)) {
      if (catalogs.size >= 64) catalogs.delete(catalogs.keys().next().value);
      catalogs.set(k, release.catalogFor(ids));
    }
    return catalogs.get(k);
  }
  const printingsOf = (snapshot) => Object.values(snapshot.cards).map((c) => c.printingId);
  const hostSetup = (setup) => ({ releaseId: setup.releaseId, seed: setup.seed, format: setup.format, matchMode: setup.matchMode,
    decks: setup.decks.map((d) => d.cards) });
  const steps = (...list) => list.map((step) => ({ key: `srv.${randomUUID()}`, step: { ...step, at: Date.now() } }));
  function record(id, ...list) {
    store.appendSteps(id, steps(...list));
    onRecord(id);
  }

  // A record's moves and edits played into the pool under `k`; onMove(i, hash) after each (a takeover records them).
  async function playInto(k, setup, moves, onMove = null) {
    const firstEdit = onMove ? 0 : moves.findIndex((m) => m.type === 'edit');
    const opening = firstEdit < 0 ? moves : moves.slice(0, firstEdit);
    await pool.call('open', { match: k, setup: hostSetup(setup), moves: opening.map((m) => ({ seat: m.player, action: m.action })) });
    for (const [i, m] of moves.slice(opening.length).entries()) {
      const r = m.type === 'edit' ? await pool.call('restore', { match: k, snapshot: m.state })
        : await pool.call('play', { match: k, seat: m.player, revision: m.revision, action: m.action });
      await onMove?.(opening.length + i, r.hash);
    }
  }

  async function reopen(m) {
    if (!reopening.has(m.id)) reopening.set(m.id, (async () => {
      try {
        const { moves } = effectiveMoves(store.matchSteps(m.id)), edit = moves.findLast((x) => x.type === 'edit');
        live.set(m.id, fresh(edit ? printingsOf(edit.state) : null));
        await playInto(key(m.id), m.setup, moves);
      } catch (error) {
        if (error.code !== 'match-exists') throw error;
      } finally {
        reopening.delete(m.id);
      }
    })());
    return reopening.get(m.id);
  }

  // An engine call for a game, which is opened again from its record when the pool does not have it.
  async function call(m, op, params = {}) {
    try {
      return await pool.call(op, { ...params, match: key(m.id) });
    } catch (error) {
      if (error.code !== 'unknown-match') throw error;
      await reopen(m);
      return pool.call(op, { ...params, match: key(m.id) });
    }
  }

  // The player's own game on the server, still being played, and their seat in it. `over`: a game between two players
  // that is over answers too (the opponent's last move ended it: the player's table asks for the view after it).
  // `alone`: a request only a game against 小茂 has.
  function ownGame(user, id, { over = false, alone = false } = {}) {
    const m = store.getMatch(id), seat = m ? seatOf(m, user) : null;
    if (seat === null) fail(404, '找不到这局对战。');
    if (!m.setup.server) fail(409, '这局不是在服务器上进行的对战。');
    if (m.status !== 'playing' && !(over && m.setup.pvp && m.status === 'over')) fail(409, '这局对战已经结束。', 'game-over');
    if (alone && m.setup.pvp) fail(409, '在线对战没有这项功能。', 'pvp');
    return { m, seat };
  }
  const opponentOf = (m, seat) => (seat === 0 ? m.opponentId : m.userId);
  // The game as its player at `seat` knows it (a spectator's: seat null): in a game between two players the other deck
  // stays hidden until the game is over. `players`: who sits where, null for 小茂.
  const summary = (m, seat = playerSeat(m)) => ({ id: m.id, level: m.setup.level ?? null, seat, takeover: m.setup.takeover ?? null,
    decks: m.setup.decks.map(({ id, name }, i) => (i === seat || !m.setup.pvp || m.status !== 'playing' ? { id, name } : { id: null, name: null })),
    pvp: !!m.setup.pvp, minutes: m.setup.clock?.minutes ?? null,
    players: m.setup.pvp ? [{ id: m.userId, username: m.username }, m.opponentId ? { id: m.opponentId, username: m.opponentName } : null]
      : [0, 1].map((i) => (i === playerSeat(m) ? { id: m.userId, username: m.username } : null)) });
  // A player's game between two players still on, if any.
  const twoPlayerGame = (user) => store.listMatches(user.id, 20).find((x) => x.status === 'playing' && x.setup.pvp && seatOf(x, user) !== null);
  const notInGame = (user) => {
    if (twoPlayerGame(user)) fail(409, '你还有一局在线对战没有结束，请先下完或认输。', 'in-game');
  };

  // The view of the player at `seat` after `cursor`. The server's own cursor (what the player had seen after the last
  // move) tells what a move revealed; the browser's is the one it sent, usually the same, so one view answers both.
  async function playerUpdate(m, s, cursor, seat = playerSeat(m)) {
    const before = s.cursors[seat], mine = await call(m, 'view', { seat, cursor: before });
    s.cursors[seat] = mine.cursor;
    return { mine, update: cursor === before ? mine : await call(m, 'view', { seat, cursor }) };
  }

  // What a reply in a game between two players adds: a result the server gave (time ran out) in place of the engine's
  // concession, both clocks, whether the opponent has the site open and how many watch.
  function reply(id, seat, update) {
    const m = store.getMatch(id);
    if (!m.setup.pvp) return update;
    return { ...ended(m, update), clock: clockOut(m), online: hub.online(opponentOf(m, seat)), watchers: hub.watchers(id) };
  }
  function ended(m, update) {
    const result = m.result?.reason === 'timeout' ? m.result : null, as = (x) => (x?.result && result ? { ...x, result } : x);
    return { ...update, status: as(update.status), view: as(update.view) };
  }
  const clockOut = (m) => m.clock && { left: timeLeft(m.clock), running: m.clock.actor };

  // After every move: the turn reached (in a game between two players, the clock charged and both players told), and at
  // the end the result (`ending` when the server ends it: time ran out), the final state and the game out of the pool.
  // A game between two players stays in the pool after it ends, for the loser's table to see the last move; it leaves
  // with the idle ones.
  async function settle(m, status, ending = null, arrived = Date.now()) {
    const result = status.result ? ending ?? status.result : null;
    const clock = m.setup.pvp ? charge(m.id, m.clock, result ? null : status.actor, arrived) : undefined;
    if (live.has(m.id)) live.get(m.id).spectate = null;
    if (!result) store.updateMatch(m.id, { turn: status.turn, clock });
    else {
      if (live.has(m.id)) lose(live.get(m.id));
      const { snapshot } = await call(m, 'snapshot');
      record(m.id, { type: 'snapshot', revision: status.revision, state: snapshot }, { type: 'end', result });
      store.updateMatch(m.id, { status: 'over', result, turn: status.turn, clock });
      if (!m.setup.pvp) {
        await pool.call('close', { match: key(m.id) }).catch(() => {});
        live.delete(m.id);
      }
    }
    if (!m.setup.pvp) return;
    const moved = { id: m.id, revision: status.revision };
    for (const userId of [m.userId, m.opponentId]) hub.send(userId, 'move', moved);
    hub.sendWatchers(m.id, 'move', moved);
    if (result) hub.broadcast('games');
  }

  // A deck of the player's ('user:<id>') or of the release, checked for `format` (its own when null).
  async function deckFor(user, id, format = null) {
    if (typeof id !== 'string' || !id) fail(400, '请选择卡组。');
    const own = /^user:(\d+)$/.exec(id);
    if (own) {
      const deck = store.getDeck(user.id, Number(own[1])) ?? fail(404, '找不到这套卡组。');
      const check = await checkDeck(deck.cards, format ?? deck.format);
      if (!check.legal) fail(400, `卡组「${deck.name}」还不能用于${format === 'standard' ? '标准赛' : '对战'}：${check.issues[0]}`);
      return { id, name: deck.name, format: { ...ruleset, id: format ?? deck.format }, cards: deckList(deck.cards) };
    }
    const preset = presets.find((d) => d.id === id) ?? fail(404, '找不到这套卡组。');
    if (format && format !== preset.format.id && format !== 'open') fail(400, `卡组「${preset.name}」是开放赛卡组，不能用于标准赛。`);
    return { id, name: preset.name, format: format ? { ...preset.format, id: format } : preset.format, cards: deckList(preset.cards) };
  }

  async function abandon(m) {
    if (live.has(m.id)) lose(live.get(m.id));
    store.updateMatch(m.id, { status: 'abandoned' });
    onRecord(m.id);
    live.delete(m.id);
    await pool.call('close', { match: key(m.id) }).catch(() => {});
  }
  // A player starting a game leaves the games against 小茂 they had on (and their room).
  async function leaveOthers(userId) {
    for (const m of store.listMatches(userId, 20)) if (m.status === 'playing' && m.setup.server && !m.setup.pvp && m.userId === userId) await abandon(m);
    closeRoomOf(userId);
  }

  // ---- The clock of a game between two players: {left: [ms, ms], actor, since} in its record, a timer here ----
  // The time up to `arrived` (when the move that ended it reached the server: the wait in the queue is nobody's) charged
  // to the player it ran for; `actor`'s runs from now. Returns the new clock, timer set.
  function charge(id, clock, actor, arrived = Date.now()) {
    const next = { left: timeLeft(clock, arrived), actor: actor ?? null, since: Date.now() };
    arm(id, next);
    return next;
  }
  function arm(id, clock) {
    clearTimeout(clocks.get(id));
    clocks.delete(id);
    if (clock.actor === null) return;
    const timer = setTimeout(() => flag(id).catch((error) => console.error(`Clock of match #${id}: ${error.message}`)),
      timeLeft(clock)[clock.actor] + CLOCK_GRACE_MS);
    timer.unref();
    clocks.set(id, timer);
  }
  // The actor's time ran out: they concede, the record saying why (unless a move of theirs is in: it is played first, and
  // loses itself if it came in late).
  const flag = (id) => serial(id, async () => {
    const m = store.getMatch(id);
    if (m?.status !== 'playing' || !m.clock || m.clock.actor === null) return;
    if (timeLeft(m.clock)[m.clock.actor] > 0 || inbound.get(id)) { arm(id, m.clock); return; }
    await timeUp(m);
  });
  async function timeUp(m) {
    const seat = m.clock.actor, { status } = await call(m, 'status'), result = { winner: 1 - seat, reason: 'timeout' };
    let r;
    try {
      r = await call(m, 'play', { seat, revision: status.revision, action: CONCEDE });
    } catch (error) {
      if (!STOPPED.has(error.code)) throw error;
      return endStopped(m, result, status.revision);
    }
    record(m.id, { type: 'action', player: seat, revision: status.revision, action: CONCEDE, hash: r.hash, reason: 'timeout' });
    await settle(m, r.status, result);
  }
  // A game between two players the engine stopped (its state failed a check, docs/ENGINE-PROTOCOL.md) still ends when a
  // player concedes or runs out of time, the record ending without the engine's move: neither player is held in it.
  function endStopped(m, result, revision) {
    if (live.has(m.id)) lose(live.get(m.id));
    record(m.id, { type: 'end', result, stopped: true });
    store.updateMatch(m.id, { status: 'over', result, clock: m.clock && charge(m.id, m.clock, null) });
    for (const userId of [m.userId, m.opponentId]) hub.send(userId, 'move', { id: m.id, revision });
    hub.sendWatchers(m.id, 'move', { id: m.id, revision });
    hub.broadcast('games');
  }
  // (The server was down meanwhile: nobody could move, so the clocks start again from now.)
  for (const m of store.playingTwoPlayer()) {
    if (!m.clock) continue;
    const clock = { ...m.clock, since: Date.now() };
    store.updateMatch(m.id, { clock });
    arm(m.id, clock);
  }

  // ---- Rooms: a player waiting in the lobby with a deck for another to join ----
  // {id, host: user, deck: its id, format, minutes, seed, createdAt, left: the timer closing it while its host is away}
  const roomOut = (r, user) => ({ id: r.id, host: { id: r.host.id, username: r.host.username }, format: r.format, minutes: r.minutes,
    createdAt: r.createdAt, mine: r.host.id === user.id });
  function closeRoom(r) {
    clearTimeout(r.left);
    if (rooms.get(r.id) === r) { rooms.delete(r.id); hub.broadcast('rooms'); }
  }
  function closeRoomOf(userId) { for (const r of rooms.values()) if (r.host.id === userId) closeRoom(r); }
  function hostAway(r) {
    clearTimeout(r.left);
    r.left = setTimeout(() => closeRoom(r), ROOM_LEFT_MS);
    r.left.unref();
  }
  // A player's pages opening or closing: their room waits for them a little; the opponents of their games, and those
  // watching, are told.
  hub.listen((userId, online) => {
    for (const r of rooms.values()) if (r.host.id === userId) { if (online) clearTimeout(r.left); else hostAway(r); }
    for (const m of store.listMatches(userId, 20)) if (m.status === 'playing' && m.setup.pvp && m.opponentId) {
      const seat = m.userId === userId ? 0 : 1, data = { id: m.id, seat, online };
      hub.send(opponentOf(m, seat), 'presence', data);
      hub.sendWatchers(m.id, 'presence', data);
    }
  });
  // A page starting or stopping to watch a game: its players and spectators hear how many watch.
  hub.listenWatch((id) => {
    const m = store.getMatch(id);
    if (!m?.setup.pvp) return;
    const data = { id, count: hub.watchers(id) };
    for (const userId of [m.userId, m.opponentId]) hub.send(userId, 'watchers', data);
    hub.sendWatchers(id, 'watchers', data);
  });
  // 小茂's level for a new game: `level` when the AI (or its model) is there to play it, else the CPU engine (null).
  async function levelFor(level) {
    const model = !!llm?.levels.some((l) => l.level === level);
    if (level !== null && !LEVELS.some((l) => l.level === level) && !model) fail(400, '没有这个难度。');
    // (A model level needs no AI service: when its model fails, the rule AI or the CPU engine moves instead.)
    return level !== null && (model || await aiReady()) ? level : null;
  }
  // A seed given for a new game: an administrator's, or anyone's on a test server.
  function seedFor(user, given) {
    const seeds = user.role === 'admin' || anySeed;
    if (given !== null && given !== undefined && (!seeds || !Array.isArray(given) || given.length !== 4 ||
        !given.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff) || given.every((n) => n === 0)))
      fail(seeds ? 400 : 403, seeds ? '随机种子格式不正确。' : '只有管理员可以指定随机种子。');
    return given ?? null;
  }
  function newSeed(given) {
    const seed = given ? [...given] : [...crypto.getRandomValues(new Uint32Array(4))];
    if (seed.every((n) => n === 0)) seed[0] = 1;
    return seed;
  }

  // The CPU engine's move from 小茂's own view.
  async function cpuEngineMove(m, s) {
    const bot = botSeat(m), { view } = await call(m, 'view', { seat: bot });
    return createAI(await catalogFor(s.cards ? [{ cards: s.cards }] : m.setup.decks))(view, bot);
  }

  // ---- The language-model seats (ai/llm-player.mjs): 小茂 at a model level, the coach beside the player ----
  // A game with one keeps a mirror of its position (a Simulation from the engine's snapshot) the seats read: every move
  // the engine plays is played into it too, checked against the engine's hash, and told to the seats. A mirror that
  // differs, or an undo, is made again from a snapshot when next needed, the seats told to look at the whole position;
  // an administrator's edit (other cards, maybe) or the game opened again starts the seats afresh.
  async function mirrorOf(m, s, revision) {
    s.mirror ??= { sim: null, catalog: null, say: null, seats: new Map(), turn: null, steps: [0, 0], judged: null, asking: null, movedAt: null };
    const x = s.mirror;
    if (x.sim && x.sim.state.revision !== revision) lose(s);
    if (!x.sim) {
      const { snapshot } = await call(m, 'snapshot');
      x.catalog ??= await catalogFor(s.cards ? [{ cards: s.cards }] : m.setup.decks);
      x.say ??= describer(x.catalog);
      x.sim = new Simulation(snapshot, x.catalog);
    }
    return x;
  }
  function lose(s, notes = {}) {
    if (!s.mirror) return;
    s.mirror.asking?.controller.abort();
    s.mirror.sim = null;
    s.mirror.judged = null;
    // Restore the coach from the effective record too: an undone move must not leave stale card knowledge behind.
    for (const role of s.mirror.seats.keys()) if (role.startsWith('coach:')) s.mirror.seats.delete(role);
    s.mirror.coachNote = notes.coach ?? null;
    for (const [role, seat] of s.mirror.seats) seat.reset(notes[role] ?? null);
  }
  // A move the engine played (`hash` after it), played into the mirror and told to the seats.
  function follow(s, actor, action, hash) {
    const x = s.mirror;
    if (!x?.sim) return;
    const before = x.sim.view(actor), turn = x.sim.state.turn;
    if (x.sim.attempt(actor, action) || stateHash(x.sim.state) !== hash) { lose(s); return; }
    if (turn !== x.turn) { x.turn = turn; x.steps = [0, 0]; }
    x.steps[actor]++;
    x.movedAt = Date.now();
    for (const seat of x.seats.values()) seat.played(actor, action, before);
    // The coach's question about the position before is dropped: the next one need not wait for it.
    if (x.asking && x.asking.revision !== x.sim.state.revision) x.asking.controller.abort();
  }
  // A line in the server's log for each question a model seat asked (`asked`: its count before; the policy answers
  // some without one): its time and tokens, to see how long the coach and 小茂 take on the site.
  const llmLog = (line) => (llm?.log ?? console.log)(line);
  const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
  function logAsked(who, player, asked, more = '') {
    if (player.stats.asked === asked) return;
    const [ms, prompt, cached, reasoning, out] = player.stats.each.at(-1);
    llmLog(`${who}: ${secs(ms)}${more}; ${(prompt / 1000).toFixed(1)}k tokens in (${Math.round(100 * cached / Math.max(1, prompt))}% cached), ${out} out (${reasoning} reasoning)`);
  }
  // A seat's deck for the model: its checked playbook (a pool deck, or a player's copy of one), or the 打法说明 its
  // author wrote (a player's own deck), else its cards alone.
  function seatDeck(m, seat) {
    const d = m.setup.decks[seat], own = /^user:(\d+)$/.exec(d.id);
    const owner = m.setup.pvp && seat === 1 ? m.opponentId : m.userId;
    const strategy = own ? store.getDeck(owner, Number(own[1]))?.strategy?.trim() || null : null;
    const pooled = DECK_POOL[d.id] ? d.id : POOL_BY_LIST.get(listKey(d.cards));
    return { deck: strategy ? d.id : pooled ?? d.id, name: d.name, strategy };
  }
  // The seat `role` of a game: 'cpu' (小茂 at the game's model level) or 'coach' (the player's), made when first needed.
  async function llmSeat(m, s, role, revision, seat = role === 'cpu' ? botSeat(m) : playerSeat(m)) {
    const x = await mirrorOf(m, s, revision);
    const key = role === 'coach' ? coachKey(seat) : role;
    if (!x.seats.has(key)) {
      const spec = role === 'cpu' ? llm.levels.find((l) => l.level === m.setup.level) : llm.coach;
      let history = null;
      const table = { get state() { return (history ?? x.sim).state; }, get actor() { return (history ?? x.sim).actor; },
        view: (p, o) => (history ?? x.sim).view(p, o) };
      const player = llmPlayer(table, x.catalog, seat, { ...seatDeck(m, seat), model: spec.model, effort: spec.effort, env: spec.env,
        seed: m.id, advisor: role === 'coach', explain: role === 'coach', ask: llm.ask, tries: llm.tries ?? 2, timeoutMs: llm.timeoutMs ?? 90_000 });
      if (role === 'coach') {
        // No model calls while replaying. Feed the same seat-filtered observations as live play, including complete
        // deck inspections, even if coaching was off from the opening (or the server reopened the game).
        const { moves, problems } = effectiveMoves(store.matchSteps(m.id));
        if (problems.length) fail(503, '对战记录不完整，暂时无法恢复教练上下文。');
        // A console edit deliberately starts the seats afresh, like its live counterpart.
        const edit = moves.findLastIndex((a) => a.type === 'edit');
        const base = edit >= 0 ? { ...moves[edit].state, catalogId: x.catalog.id }
          : createGameState({ ruleset, catalog: x.catalog, decks: m.setup.decks.map((d) => d.cards), seed: m.setup.seed,
            format: m.setup.format, matchMode: m.setup.matchMode });
        history = new Simulation(base, x.catalog);
        for (const move of moves.slice(edit + 1)) {
          const before = history.view(move.player);
          history.play(move.player, move.action);
          player.played(move.player, move.action, before);
        }
        if (stateHash(history.state) !== stateHash(x.sim.state)) fail(503, '对战记录与当前局面不一致，暂时无法恢复教练上下文。');
        history = null;
        if (x.coachNote) { player.reset(x.coachNote); x.coachNote = null; }
      }
      x.seats.set(key, player);
    }
    return x.seats.get(key);
  }

  // What the spectators of a game are given, made once a position: however many watch, the engine makes one view a move,
  // and their requests never wait in the game's queue ahead of a player's move. A move drops it (settle).
  function spectate(m, s) {
    s.spectate ??= call(m, 'watch', {}).catch((error) => { s.spectate = null; throw error; });
    return s.spectate;
  }
  // The events of the whole history `full` after a spectator's `cursor` (the engine's "epoch.count"; any other, all again).
  function since(full, cursor) {
    const { reset: _all, ...whole } = full, [epoch] = full.cursor.split('.'), [e, n] = typeof cursor === 'string' ? cursor.split('.') : [];
    const count = Number(n), fresh = e === epoch && Number.isInteger(count) && count >= 0 && count <= full.events.length;
    return { ...whole, events: full.events.slice(fresh ? count : 0), ...(fresh ? {} : { reset: true }) };
  }

  /** The player concedes: the opponent wins (in a game against 小茂 too). */
  const concede = (user, id, { cursor = null } = {}) => serial(id, async () => {
    const { m, seat } = ownGame(user, id), s = state(id);
    const { status } = await call(m, 'status');
    let r;
    try {
      r = await call(m, 'play', { seat, revision: status.revision, action: CONCEDE });
    } catch (error) {
      if (!m.setup.pvp || !STOPPED.has(error.code)) throw error;
      endStopped(m, { winner: 1 - seat, reason: 'concede' }, status.revision);
      fail(409, '这局对战因为引擎出错已经停止，现在按认输结束。', 'game-over');
    }
    record(id, { type: 'action', player: seat, revision: status.revision, action: CONCEDE, hash: r.hash });
    s.undo = [];
    const { update } = await playerUpdate(m, s, cursor, seat);
    await settle(m, r.status);
    return reply(id, seat, { ...update, undo: 0 });
  });

  const sweep = setInterval(() => {
    for (const [id, s] of live) if (Date.now() - s.used > IDLE_MS) {
      live.delete(id);
      pool.call('close', { match: key(id) }).catch(() => {});
    }
  }, 10 * 60_000);
  sweep.unref();

  return {
    /**
     * A new game: the player's deck against `opponent` (a deck id, or 'random' among the release's decks), 小茂 at
     * `level` (1–5, with the AI) or the CPU engine (null). The player's other games still on are abandoned. An
     * administrator may give the `seed` (browser tests, a deal shown again).
     */
    async create(user, { deck, opponent = 'random', level = null, seed: given = null } = {}, { build = null, userAgent = null } = {}) {
      notInGame(user);
      const mine = await deckFor(user, deck);
      const others = presets.filter((d) => d.id !== mine.id);
      const opp = await deckFor(user, opponent && opponent !== 'random' && opponent !== mine.id ? opponent : others[randomInt(others.length)].id);
      const useLevel = await levelFor(level);
      // Both decks must be legal in the pool played: a Standard deck and an Open deck meet in Open.
      const format = mine.format.id === opp.format.id ? mine.format : { ...mine.format, id: 'open' };
      const decks = [mine, opp].map(({ id, name, cards }) => ({ id, name, cards }));
      const seed = newSeed(seedFor(user, given));
      const catalog = await catalogFor(decks);
      const setup = { releaseId: release.releaseId, seed, format, matchMode: 'normal', decks, server: true, level: useLevel,
        approval: releaseIdentity(catalogReleaseReceipt(catalog)), implementation: implementationSummaryFromIndex(index, decks.flatMap((d) => d.cards)) };
      await leaveOthers(user.id);
      const m = store.createMatch(user.id, { setup, build, userAgent });
      onRecord(m.id);
      try {
        await pool.call('open', { match: key(m.id), setup: hostSetup(setup) });
      } catch (error) {
        store.updateMatch(m.id, { status: 'abandoned' });
        throw error;
      }
      return serial(m.id, async () => {
        const s = state(m.id), { update } = await playerUpdate(m, s, null);
        return { match: summary(m), ...update };
      });
    },

    /** The player's game still on (the latest, in either seat), with the whole view: a reload picks it up. */
    async current(user) {
      const m = store.listMatches(user.id, 20).find((x) => x.status === 'playing' && x.setup.server && seatOf(x, user) !== null);
      if (!m) return { match: null };
      const seat = seatOf(m, user);
      return serial(m.id, async () => {
        const s = state(m.id);
        s.cursors[seat] = null;
        const { update } = await playerUpdate(m, s, null, seat);
        return reply(m.id, seat, { match: summary(m, seat), ...update });
      });
    },

    // ---- The lobby ----
    /** The rooms waiting for a player, oldest first. */
    rooms: (user) => [...rooms.values()].map((r) => roomOut(r, user)),

    /**
     * A room of the player's with `deck` (its own format, or `format`) and `minutes` on each player's clock; it takes the
     * place of the player's room before. `seed`: as for a new game (an administrator's, or on a test server).
     */
    async openRoom(user, { deck, format = null, minutes = DEFAULT_MINUTES, seed = null } = {}) {
      notInGame(user);
      if (format !== null && !FORMATS.includes(format)) fail(400, '赛制只能是标准赛或开放赛。');
      if (!CLOCK_MINUTES.includes(minutes)) fail(400, `每方用时只能是 ${CLOCK_MINUTES.join('、')} 分钟。`);
      const minute = (roomsOpened.get(user.id) ?? []).filter((t) => Date.now() - t < 60_000);
      if (minute.length >= ROOMS_PER_MINUTE) fail(429, '开房太频繁，请稍后再试。');
      if (seed !== null && seed !== undefined && !anySeed) fail(403, '在线对战不能指定随机种子。');
      const given = seedFor(user, seed), mine = await deckFor(user, deck, format);
      if (roomsOpened.size > 10_000) roomsOpened.clear();
      roomsOpened.set(user.id, [...minute, Date.now()]);
      closeRoomOf(user.id);
      const r = { id: nextRoom++, host: user, deck, format: mine.format.id, minutes, seed: given, createdAt: new Date().toISOString(), left: null };
      rooms.set(r.id, r);
      if (!hub.online(user.id)) hostAway(r);
      hub.broadcast('rooms');
      return roomOut(r, user);
    },

    closeRoom(user, id) {
      const r = rooms.get(id);
      if (r?.host.id !== user.id) fail(404, '找不到这个房间。');
      closeRoom(r);
    },

    /**
     * The player joins room `id` with `deck`: the game is on, the room's host in seat 0 and the player in seat 1, each
     * deck in an order of its own. Both players leave their games against 小茂; the host hears of the game (`match`).
     */
    async join(user, id, { deck } = {}, { build = null, userAgent = null } = {}) {
      if (!rooms.has(id)) fail(404, '找不到这个房间，它可能已经开始或者取消了。');
      if (rooms.get(id).host.id === user.id) fail(409, '不能加入自己的房间。');
      notInGame(user);
      const guest = await deckFor(user, deck, rooms.get(id).format);
      const r = rooms.get(id) ?? fail(404, '找不到这个房间，它可能已经开始或者取消了。');
      closeRoom(r);
      if (twoPlayerGame(r.host)) fail(409, '房主正在进行另一局在线对战。');
      let host;
      try {
        host = await deckFor(r.host, r.deck, r.format);
      } catch (error) {
        if (error instanceof PlayError) fail(409, `房主的卡组已经不能用于这个赛制，房间已关闭（${error.message}）`);
        throw error;
      }
      const decks = [host, guest].map(({ id: deckId, name, cards }) => ({ id: deckId, name, cards: r.seed ? cards : shuffled(cards) }));
      const catalog = await catalogFor(decks);
      const setup = { releaseId: release.releaseId, seed: newSeed(r.seed), format: host.format, matchMode: 'normal', decks, server: true,
        pvp: true, level: null, clock: { minutes: r.minutes },
        approval: releaseIdentity(catalogReleaseReceipt(catalog)), implementation: implementationSummaryFromIndex(index, decks.flatMap((d) => d.cards)) };
      await leaveOthers(r.host.id);
      await leaveOthers(user.id);
      const full = r.minutes * minuteMs;
      const m = store.createMatch(r.host.id, { setup, build, userAgent, opponentId: user.id, clock: { left: [full, full], actor: null, since: Date.now() } });
      onRecord(m.id);
      let opened;
      try {
        opened = await pool.call('open', { match: key(m.id), setup: hostSetup(setup) });
      } catch (error) {
        store.updateMatch(m.id, { status: 'abandoned' });
        throw error;
      }
      store.updateMatch(m.id, { clock: charge(m.id, m.clock, opened.status.actor) });
      hub.send(r.host.id, 'match', { id: m.id });
      hub.broadcast('games');
      return serial(m.id, async () => {
        const s = state(m.id), { update } = await playerUpdate(m, s, null, 1);
        return reply(m.id, 1, { match: summary(store.getMatch(m.id), 1), ...update });
      });
    },

    // ---- Spectators ----
    /** The games between two players in progress, newest first, for the lobby. */
    games: () => store.playingTwoPlayer().reverse().map((m) => ({ id: m.id, players: summary(m, null).players,
      minutes: m.setup.clock?.minutes ?? null, turn: m.turn, createdAt: m.createdAt, watchers: hub.watchers(m.id) })),

    /**
     * A game between two players as a spectator sees it (on, or over): what both players see and the public events after
     * `cursor`, both clocks, which player has the site open and how many watch.
     */
    async watch(user, id, cursor = null) {
      const m = store.getMatch(id);
      if (!m?.setup.server || !m.setup.pvp || m.status === 'abandoned') fail(404, '找不到这局在线对战。');
      const update = since(await spectate(m, state(id)), cursor);
      return { match: { ...summary(m, null), watching: true }, ...ended(m, update), clock: clockOut(m),
        online: [m.userId, m.opponentId].map((userId) => hub.online(userId)), watchers: hub.watchers(id) };
    },

    view: (user, id, cursor = null) => serial(id, async () => {
      const { m, seat } = ownGame(user, id, { over: true }), s = state(id);
      return reply(id, seat, { ...(await playerUpdate(m, s, cursor, seat)).update, undo: s.undo.length });
    }),

    /**
     * One command of the player's. A refused one is recorded and answered 409 with the engine's code. In a game between
     * two players a command after the player's time ran out ends the game instead.
     */
    move: (user, id, { revision, action, cursor = null } = {}, arrived = Date.now()) => {
      // (Only the move of the player whose time runs holds the clock's call: nobody else may keep it from being called.)
      const waiting = store.getMatch(id), counted = !!waiting?.clock && seatOf(waiting, user) === waiting.clock.actor;
      if (counted) inbound.set(id, (inbound.get(id) ?? 0) + 1);
      return serial(id, async () => {
        if (counted) { if (inbound.get(id) > 1) inbound.set(id, inbound.get(id) - 1); else inbound.delete(id); }
        const { m, seat } = ownGame(user, id), s = state(id);
        if (!isObject(action)) fail(400, '指令格式不正确。');
        if (m.clock?.actor === seat && timeLeft(m.clock, arrived)[seat] === 0) {
          await timeUp(m);
          fail(409, '你的时间已经用完，这局判负。', 'game-over');
        }
        let r;
        try {
          r = await call(m, 'play', { seat, revision, action });
        } catch (error) {
          if (!error.code || error.code === 'internal' || error.code === 'state-invalid') throw error;
          record(id, { type: 'rejected', player: seat, revision, action, error: { code: error.code, message: error.message } });
          fail(409, error.message, error.code);
        }
        record(id, { type: 'action', player: seat, revision, action, hash: r.hash });
        const { mine, update } = await playerUpdate(m, s, cursor, seat);
        const quiet = !m.setup.pvp && UNDOABLE.has(action.type) && !mine.view.pending && mine.events.every((e) => QUIET.has(e.ruleId));
        s.undo = !quiet ? [] : [...s.undo.filter((u) => u.turn === r.status.turn), { revision, turn: r.status.turn }];
        follow(s, seat, action, r.hash);
        await settle(m, r.status, null, arrived);
        return reply(id, seat, { ...update, quiet, undo: s.undo.length });
      });
    },

    concede,

    /**
     * 小茂's move, when it is his: the AI at the game's level (it uses only what he could know; at a model level the
     * language model, the rule AI instead for the rest of a turn its model failed in), else — or when the AI fails or
     * the rules refuse its move — the CPU engine from his own view. `ai`: {value, error} for the table.
     */
    cpu: (user, id, { revision, cursor = null } = {}) => serial(id, async () => {
      const { m, seat } = ownGame(user, id, { alone: true }), s = state(id), bot = 1 - seat;
      const { status } = await call(m, 'status');
      if (status.actor !== bot) fail(409, '现在不是小茂行动。', 'not-cpu');
      if (revision !== undefined && revision !== status.revision) fail(409, 'A newer game revision exists.', 'stale-command');
      if (status.turn !== s.turn) { s.turn = status.turn; s.turnMoves = 0; }
      const info = { value: null, error: null };
      let action = null;
      const model = !!llm?.levels.some((l) => l.level === m.setup.level);
      if (model && s.llmPause !== status.turn) {
        const who = `小茂 (level ${m.setup.level}), match #${id} at revision ${status.revision}`;
        try {
          const player = await llmSeat(m, s, 'cpu', status.revision), asked = player.stats.asked;
          action = (await player.decide(s.turnMoves)).action;
          logAsked(who, player, asked);
        } catch (error) {
          info.error = String(error.message).slice(0, 200);
          s.llmPause = status.turn;
          llmLog(`${who}: ${info.error}`);
        }
      }
      const level = model ? RULE_LEVEL : m.setup.level;
      if (!action && level && ai) {
        try {
          const { snapshot } = await call(m, 'snapshot');
          const answer = await ai.decide({ snapshot, player: bot, level, turnMoves: s.turnMoves });
          action = answer.action;
          info.value = answer.value ?? null;
        } catch (error) {
          info.error = String(error.message).slice(0, 200);
        }
      }
      s.turnMoves++;
      action ??= await cpuEngineMove(m, s);
      let r;
      try {
        r = await call(m, 'play', { seat: bot, revision: status.revision, action });
      } catch (error) {
        if (!error.code || error.code === 'internal' || error.code === 'state-invalid') throw error;
        record(id, { type: 'rejected', player: bot, revision: status.revision, action, error: { code: error.code, message: error.message } });
        action = await cpuEngineMove(m, s);
        r = await call(m, 'play', { seat: bot, revision: status.revision, action });
      }
      record(id, { type: 'action', player: bot, revision: status.revision, action, hash: r.hash });
      s.undo = [];
      follow(s, bot, action, r.hash);
      const { update } = await playerUpdate(m, s, cursor, seat);
      await settle(m, r.status);
      return { ...update, ai: info, undo: 0 };
    }),

    /** The targets a Tool from the player's hand could go on (the engine's preview). */
    preview: (user, id, { revision, action } = {}) => serial(id, async () => {
      const { m, seat } = ownGame(user, id);
      return call(m, 'preview', { seat, revision, action });
    }),

    /** Takes back the player's last quiet move this turn; the view starts again (reset). */
    undo: (user, id) => serial(id, async () => {
      const { m, seat } = ownGame(user, id, { alone: true }), s = state(id);
      const last = s.undo.pop() ?? fail(409, '没有可以撤销的操作。', 'no-undo');
      await call(m, 'rewind', { revision: last.revision });
      record(id, { type: 'rewind', revision: last.revision, reason: 'undo' });
      s.cursors[seat] = null;
      lose(s, UNDONE);
      const { update } = await playerUpdate(m, s, null, seat);
      return { ...update, undo: s.undo.length };
    }),

    /**
     * The language-model coach's word on the player's moves ({ key, action }) at `revision`: { revision, moves: { key:
     * { choose, reason } } }, every move judged (moves alike share a judgement); { stale: true } when the game has moved
     * on. Without `actions`, its word on the request the player answers (going first or second, the Active and Bench in
     * setup, a card's choice): { revision, options: { option id (a target's Pokémon id when counters are placed): { choose,
     * reason, count? } } }, none for a request the model is not asked (llm-player.mjs). Asked beside the game's queue:
     * the player may move meanwhile (the coach is told); a position is judged once.
     */
    async coach(user, id, { revision, actions } = {}) {
      const t0 = Date.now();
      // Re-read the stored permission: an old session/user object or a queued request cannot retain revoked access.
      const needCoach = () => {
        const account = store.userById(user.id), pvp = !!store.getMatch(id)?.setup.pvp;
        if (pvp ? !account?.pvpCoachEnabled : !account?.coachEnabled)
          fail(403, pvp ? '你的账户没有真人对战教练权限，请联系管理员开通。' : '你的账户没有教练权限，请联系管理员开通。',
            pvp ? 'pvp-coach-forbidden' : 'coach-forbidden');
      };
      needCoach();
      if (!llm?.coach) fail(503, '服务器没有启用大模型教练。');
      if (!Number.isInteger(revision) || actions !== undefined && (!Array.isArray(actions) || !actions.length || actions.length > 300
        || actions.some((a) => typeof a?.key !== 'string' || !isObject(a.action)))) fail(400, '请求格式不正确。');
      const asked = await serial(id, async () => {
        needCoach();
        const { m, seat } = ownGame(user, id), { status } = await call(m, 'status'), s = state(id);
        if (status.revision !== revision || status.actor !== seat) return null;
        await llmSeat(m, s, 'coach', revision, seat);
        return { s, seat };
      });
      if (!asked) return { revision, stale: true };
      const { s, seat } = asked;
      return coaching(id, async () => {
        needCoach();
        const x = s.mirror;
        if (live.get(id) !== s || x?.sim?.state.revision !== revision) return { revision, stale: true };
        const view = x.sim.view(seat), q = view.pending;
        if (x.sim.actor !== seat || !q !== !!actions) return { revision, ...(actions ? { moves: {} } : { options: {} }) };
        if (x.judged?.revision !== revision || x.judged.seat !== seat) {
          // Dropped when the player moves on (follow, lose): the next position's question waits for nothing.
          const coach = x.seats.get(coachKey(seat)), asked = coach.stats.asked, asking = { revision, controller: new AbortController() };
          const who = `Coach, match #${id} at revision ${revision}, seat ${seat}`, waited = Date.now() - t0, after = x.movedAt ? t0 - x.movedAt : null;
          x.asking = asking;
          let d;
          try {
            d = await coach.decide(x.steps[seat], { signal: asking.controller.signal });
          } catch (error) {
            if (!asking.controller.signal.aborted) { llmLog(`${who}: ${String(error.message).slice(0, 200)}`); throw error; }
            llmLog(`${who}: dropped after ${secs(Date.now() - t0 - waited)}, the player moved on`);
            return { revision, stale: true };
          } finally {
            if (x.asking === asking) x.asking = null;
          }
          logAsked(who, coach, asked, `, waited ${secs(waited)}${after === null ? '' : `, asked ${secs(after)} after the last move`}`);
          needCoach();
          if (live.get(id) !== s || s.mirror !== x || x.sim?.state.revision !== revision) return { revision, stale: true };
          const word = (o) => ({ choose: o.choose === true || o.choose === 'true', reason: String(o.reason ?? '').slice(0, 400),
            ...(q?.counterAllocation && Number(o.count) > 0 ? { count: Number(o.count) } : {}) });
          // A move's judgement by its text; a request's by its option (the model numbered them in the request's order).
          const ids = q?.counterAllocation ? q.counterAllocation.targets.map((t) => t.pokemonId) : q?.options ?? [];
          x.judged = { revision, seat, moves: new Map(q ? [] : (d.options ?? []).map((o) => [o.text, word(o)])),
            options: Object.fromEntries(q && d.by === 'llm' ? (d.options ?? []).filter((o) => ids[Number(o.option)] !== undefined).map((o) => [ids[Number(o.option)], word(o)]) : []) };
        }
        needCoach();
        if (q) return { revision, options: x.judged.options };
        const moves = {};
        for (const { key, action } of actions) {
          let text = null;
          try { text = x.say.move(view, seat, action); } catch { /* not a move of this position */ }
          if (x.judged.moves.has(text)) moves[key] = x.judged.moves.get(text);
        }
        return { revision, moves };
      });
    },

    /** Leaves a game against 小茂; a game between two players is conceded (the table's concede answers with the view). */
    abandon: async (user, id) => {
      const m = store.getMatch(id);
      if (m?.setup.pvp && seatOf(m, user) !== null) { await concede(user, id); return {}; }
      return serial(id, async () => { await abandon(ownGame(user, id).m); return {}; });
    },

    // ---- administrators (调试台) ----
    /**
     * The whole state of a game still on. Not of a game between two players: the 调试台 is not used while two players
     * play (it would show one of them, or someone telling them, the other's hand).
     */
    async state(admin, id) {
      const m = store.getMatch(id);
      if (!m?.setup.server || m.status !== 'playing') fail(404, '找不到进行中的这局对战。');
      if (m.setup.pvp) fail(403, '在线对战进行中不能使用调试台。');
      return serial(id, async () => call(m, 'snapshot'));
    },
    /**
     * An administrator's edit (or, with revert, the state before one): recorded, and the player's view starts again. The
     * record plays an edit back as the next move, so it must be the next revision; a revert goes back to an earlier one.
     */
    async edit(admin, id, { state: snapshot, command = '', lines = [], revert = false } = {}) {
      const m = store.getMatch(id);
      if (!m?.setup.server || m.status !== 'playing') fail(404, '找不到进行中的这局对战。');
      if (m.setup.pvp) fail(403, '在线对战进行中不能使用调试台。');
      if (!isObject(snapshot) || !Number.isInteger(snapshot.revision) || !isObject(snapshot.cards)) fail(400, '局面格式不正确。');
      return serial(id, async () => {
        const { status } = await call(m, 'status');
        if (revert ? snapshot.revision > status.revision : snapshot.revision !== status.revision + 1)
          fail(409, `对局现在是第 ${status.revision} 步，这次修改是按另一个局面做的，没有生效。`, 'stale-command');
        const r = await call(m, 'restore', { snapshot });
        record(id, revert ? { type: 'rewind', revision: snapshot.revision, reason: 'revert' }
          : { type: 'edit', revision: snapshot.revision - 1, command: String(command).slice(0, 500),
            lines: [].concat(lines).map(String).slice(0, 50), state: snapshot, hash: r.hash });
        const s = state(id);
        Object.assign(s, { undo: [], cursors: [null, null], cards: printingsOf(snapshot), mirror: null });
        if (m.userId !== admin.id) return { status: r.status };
        const { update } = await playerUpdate(m, s, null);
        return update;
      });
    },

    /**
     * 从这一步接管: a game that is over (or any, for an administrator) played again up to `move` as a new game of the
     * player's against 小茂, its record starting with those moves. `seat`: the side the player takes (by default their
     * own in that game, else 0); `level`: 小茂's, as for a new game (by default that game's).
     */
    async takeover(user, { match: fromId, move, seat = null, level } = {}) {
      const from = store.getMatch(fromId);
      // (Anyone may take over a game between two players once it is over: they could watch it and replay it.)
      if (!from || (seatOf(from, user) === null && user.role !== 'admin' && !(from.setup.pvp && from.status === 'over'))) fail(404, '找不到这局对战。');
      // (A game between two players still on would show its taker the other player's cards.)
      if (from.status === 'playing' && from.setup.server && (user.role !== 'admin' || from.setup.pvp)) fail(409, '进行中的对局不能接管。');
      notInGame(user);
      const { moves } = effectiveMoves(store.matchSteps(from.id));
      if (!Number.isInteger(move) || move < 0 || move > moves.length) fail(400, '接管位置不正确。');
      const taken = moves.slice(0, move);
      if (taken.some((x) => x.type === 'edit') && user.role !== 'admin') fail(403, '含有调试修改的对局只有管理员可以接管。');
      const side = seat ?? seatOf(from, user) ?? 0;
      if (![0, 1].includes(side)) fail(400, '座位只能是 0 或 1。');
      const decks = from.setup.decks.map(({ id, name, cards }) => ({ id, name, cards }));
      const setup = { releaseId: from.setup.releaseId, seed: from.setup.seed, format: from.setup.format, matchMode: from.setup.matchMode,
        decks, server: true, seat: side, level: level === undefined ? from.setup.level ?? null : await levelFor(level),
        approval: from.setup.approval ?? null,
        implementation: implementationSummaryFromIndex(index, decks.flatMap((d) => d.cards)), takeover: { match: from.id, move } };
      await leaveOthers(user.id);
      const m = store.createMatch(user.id, { setup });
      const recorded = [];
      try {
        await playInto(key(m.id), setup, taken, (i, hash) => {
          const x = taken[i];
          recorded.push(x.type === 'edit' ? { type: 'edit', revision: i, command: x.command, lines: x.lines, state: x.state, hash }
            : { type: 'action', player: x.player, revision: i, action: x.action, hash });
        });
      } catch (error) {
        store.updateMatch(m.id, { status: 'abandoned' });
        fail(409, `这局对战无法从第 ${move} 步接管：${error.message}`);
      }
      store.appendSteps(m.id, steps(...recorded));
      const { status } = await pool.call('status', { match: key(m.id) });
      store.updateMatch(m.id, { turn: status.turn });
      onRecord(m.id);
      return { match: summary(store.getMatch(m.id)) };
    },

    /** The whole state of the player's game still on, for a bug report. */
    async reportState(user, id) {
      const m = store.getMatch(id);
      if (!m?.setup.server || m.status !== 'playing' || (seatOf(m, user) === null && user.role !== 'admin')) return null;
      return serial(id, async () => (await call(m, 'snapshot')).snapshot).catch(() => null);
    },

    close() {
      clearInterval(sweep);
      for (const timer of clocks.values()) clearTimeout(timer);
      for (const r of rooms.values()) clearTimeout(r.left);
    },
  };
}
