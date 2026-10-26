// The table's games, played on the server (docs/ENGINE-PROTOCOL.md): each game lives in the engine pool, the player is
// seat 0 and 小茂 seat 1. A game gets its seed and both decks here; 小茂's moves are made here (the AI service at the
// game's level, else the CPU engine from his own view); the player's undo is allowed or refused here; and the record is
// written here in the step format of public/replay.js. The browser sends its commands and gets its own view only: the
// seed, the order of the decks and 小茂's hand stay on the server while the game is on.
//
// A game's record is the truth: when the pool no longer has a game (a restart, a worker that stopped, a game left idle
// and closed) it is opened again from its setup and its moves (and an administrator's edits) before the request goes on.
import { randomUUID, randomInt } from 'node:crypto';
import { createAI } from '../public/cn/ai.js';
import { deckList } from '../public/deck-check.js';
import { effectiveMoves } from '../public/replay.js';
import { QUIET } from '../public/match.js';
import { catalogReleaseReceipt } from '../public/rules/catalog-release.js';
import { releaseIdentity } from '../public/release-identity.js';
import { implementationSummaryFromIndex } from '../public/card-quality.js';
import { LEVELS } from '../ai/agents.mjs';

export const PLAYER = 0, CPU = 1;
// Moves an undo may take back (a learning aid against 小茂): the player's own this turn, and only ones that revealed
// nothing new (match.js QUIET).
const UNDOABLE = new Set(['bench', 'evolve', 'attachEnergy']);
// A game nobody has asked about for this long leaves the pool; its record opens it again when it is needed.
const IDLE_MS = 2 * 3600_000;

export class PlayError extends Error {
  constructor(status, message, code = null) { super(message); this.name = 'PlayError'; this.status = status; this.code = code; }
}
const fail = (status, message, code) => { throw new PlayError(status, message, code); };
const isObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

/**
 * `pool`: server/engine-pool.mjs. `presets`: the release's decks (decks.json). `checkDeck(cards, format)`: a saved deck's
 * check (deck-check.js checkIndexedDeck). `ai`: the AI service (ai/service.mjs or its remote client), or null.
 * `onRecord(id)`: a record changed (its file in the replay directory follows).
 */
export function createPlay({ store, release, index, pool, presets, checkDeck, ai = null, aiReady = async () => !!ai, onRecord = () => {} }) {
  const live = new Map(), queues = new Map(), reopening = new Map(), catalogs = new Map();
  const key = (id) => `match:${id}`;
  const ruleset = { region: presets[0].format.region, version: presets[0].format.version };

  // Requests for one game run one at a time: a move is several engine calls and a record.
  function serial(id, fn) {
    const run = (queues.get(id) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    queues.set(id, tail);
    tail.then(() => { if (queues.get(id) === tail) queues.delete(id); });
    return run;
  }

  // What the server keeps of a game besides its record: the player's view cursor (to tell what a move revealed), the
  // moves an undo may take back, and 小茂's moves this turn (a guard against an AI that would not end its turn).
  const fresh = () => ({ cursor: null, undo: [], turn: null, turnMoves: 0, used: Date.now() });
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
        live.set(m.id, fresh());
        await playInto(key(m.id), m.setup, effectiveMoves(store.matchSteps(m.id)).moves);
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

  // The player's own game on the server, still being played.
  function ownGame(user, id) {
    const m = store.getMatch(id);
    if (!m || m.userId !== user.id) fail(404, '找不到这局对战。');
    if (!m.setup.server) fail(409, '这局不是在服务器上进行的对战。');
    if (m.status !== 'playing') fail(409, '这局对战已经结束。', 'game-over');
    return m;
  }
  const summary = (m) => ({ id: m.id, level: m.setup.level ?? null, decks: m.setup.decks.map(({ id, name }) => ({ id, name })),
    seat: PLAYER, takeover: m.setup.takeover ?? null });

  // The player's view after `cursor`. The server's own cursor (what the player had seen after the last move) tells what a
  // move revealed; the browser's is the one it sent, usually the same, so one view answers both.
  async function playerUpdate(m, s, cursor) {
    const before = s.cursor, mine = await call(m, 'view', { seat: PLAYER, cursor: before });
    s.cursor = mine.cursor;
    return { mine, update: cursor === before ? mine : await call(m, 'view', { seat: PLAYER, cursor }) };
  }

  // After every move: the turn reached, and at the end the result, the final state and the game out of the pool.
  async function settle(m, status) {
    if (!status.result) { store.updateMatch(m.id, { turn: status.turn }); return; }
    const { snapshot } = await call(m, 'snapshot');
    record(m.id, { type: 'snapshot', revision: status.revision, state: snapshot }, { type: 'end', result: status.result });
    store.updateMatch(m.id, { status: 'over', result: status.result, turn: status.turn });
    await pool.call('close', { match: key(m.id) }).catch(() => {});
    live.delete(m.id);
  }

  async function deckFor(user, id) {
    if (typeof id !== 'string' || !id) fail(400, '请选择卡组。');
    const own = /^user:(\d+)$/.exec(id);
    if (own) {
      const deck = store.getDeck(user.id, Number(own[1])) ?? fail(404, '找不到这套卡组。');
      const check = await checkDeck(deck.cards, deck.format);
      if (!check.legal) fail(400, `卡组「${deck.name}」还不能用于对战：${check.issues[0]}`);
      return { id, name: deck.name, format: { ...ruleset, id: deck.format }, cards: deckList(deck.cards) };
    }
    const preset = presets.find((d) => d.id === id) ?? fail(404, '找不到这套卡组。');
    return { id, name: preset.name, format: preset.format, cards: deckList(preset.cards) };
  }

  async function abandon(m) {
    store.updateMatch(m.id, { status: 'abandoned' });
    onRecord(m.id);
    live.delete(m.id);
    await pool.call('close', { match: key(m.id) }).catch(() => {});
  }

  // The CPU engine's move from 小茂's own view.
  async function cpuEngineMove(m) {
    const { view } = await call(m, 'view', { seat: CPU });
    return createAI(await catalogFor(m.setup.decks))(view, CPU);
  }

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
     * `level` (1–5, with the AI) or the CPU engine (null). The player's other games still on are abandoned.
     */
    async create(user, { deck, opponent = 'random', level = null } = {}, { build = null, userAgent = null } = {}) {
      const mine = await deckFor(user, deck);
      const others = presets.filter((d) => d.id !== mine.id);
      const opp = await deckFor(user, opponent && opponent !== 'random' && opponent !== mine.id ? opponent : others[randomInt(others.length)].id);
      if (level !== null && !LEVELS.some((l) => l.level === level)) fail(400, '难度只能是 1–5。');
      const useLevel = level !== null && await aiReady() ? level : null;
      // Both decks must be legal in the pool played: a Standard deck and an Open deck meet in Open.
      const format = mine.format.id === opp.format.id ? mine.format : { ...mine.format, id: 'open' };
      const decks = [mine, opp].map(({ id, name, cards }) => ({ id, name, cards }));
      const seed = [...crypto.getRandomValues(new Uint32Array(4))];
      if (seed.every((n) => n === 0)) seed[0] = 1;
      const catalog = await catalogFor(decks);
      const setup = { releaseId: release.releaseId, seed, format, matchMode: 'normal', decks, server: true, level: useLevel,
        approval: releaseIdentity(catalogReleaseReceipt(catalog)), implementation: implementationSummaryFromIndex(index, decks.flatMap((d) => d.cards)) };
      for (const m of store.listMatches(user.id, 20)) if (m.status === 'playing' && m.setup.server) await abandon(m);
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

    /** The player's game still on (the latest), with the whole view: a reload picks it up. */
    async current(user) {
      const m = store.listMatches(user.id, 20).find((x) => x.status === 'playing' && x.setup.server);
      if (!m) return { match: null };
      return serial(m.id, async () => {
        const s = state(m.id);
        s.cursor = null;
        const { update } = await playerUpdate(m, s, null);
        return { match: summary(m), ...update };
      });
    },

    view: (user, id, cursor = null) => serial(id, async () => {
      const m = ownGame(user, id), s = state(id);
      return { ...(await playerUpdate(m, s, cursor)).update, undo: s.undo.length };
    }),

    /** One command of the player's. A refused one is recorded and answered 409 with the engine's code. */
    move: (user, id, { revision, action, cursor = null } = {}) => serial(id, async () => {
      const m = ownGame(user, id), s = state(id);
      if (!isObject(action)) fail(400, '指令格式不正确。');
      let r;
      try {
        r = await call(m, 'play', { seat: PLAYER, revision, action });
      } catch (error) {
        if (!error.code || error.code === 'internal' || error.code === 'state-invalid') throw error;
        record(id, { type: 'rejected', player: PLAYER, revision, action, error: { code: error.code, message: error.message } });
        fail(409, error.message, error.code);
      }
      record(id, { type: 'action', player: PLAYER, revision, action, hash: r.hash });
      const { mine, update } = await playerUpdate(m, s, cursor);
      const quiet = UNDOABLE.has(action.type) && !mine.view.pending && mine.events.every((e) => QUIET.has(e.ruleId));
      s.undo = !quiet ? [] : [...s.undo.filter((u) => u.turn === r.status.turn), { revision, turn: r.status.turn }];
      await settle(m, r.status);
      return { ...update, quiet, undo: s.undo.length };
    }),

    /**
     * 小茂's move, when it is his: the AI at the game's level (it uses only what he could know), else — or when the AI
     * fails or the rules refuse its move — the CPU engine from his own view. `ai`: {value, error} for the table.
     */
    cpu: (user, id, { revision, cursor = null } = {}) => serial(id, async () => {
      const m = ownGame(user, id), s = state(id);
      const { status } = await call(m, 'status');
      if (status.actor !== CPU) fail(409, '现在不是小茂行动。', 'not-cpu');
      if (revision !== undefined && revision !== status.revision) fail(409, 'A newer game revision exists.', 'stale-command');
      if (status.turn !== s.turn) { s.turn = status.turn; s.turnMoves = 0; }
      const info = { value: null, error: null };
      let action = null;
      if (m.setup.level && ai) {
        try {
          const { snapshot } = await call(m, 'snapshot');
          const answer = await ai.decide({ snapshot, player: CPU, level: m.setup.level, turnMoves: s.turnMoves });
          action = answer.action;
          info.value = answer.value ?? null;
        } catch (error) {
          info.error = String(error.message).slice(0, 200);
        }
      }
      s.turnMoves++;
      action ??= await cpuEngineMove(m);
      let r;
      try {
        r = await call(m, 'play', { seat: CPU, revision: status.revision, action });
      } catch (error) {
        if (!error.code || error.code === 'internal' || error.code === 'state-invalid') throw error;
        record(id, { type: 'rejected', player: CPU, revision: status.revision, action, error: { code: error.code, message: error.message } });
        action = await cpuEngineMove(m);
        r = await call(m, 'play', { seat: CPU, revision: status.revision, action });
      }
      record(id, { type: 'action', player: CPU, revision: status.revision, action, hash: r.hash });
      s.undo = [];
      const { update } = await playerUpdate(m, s, cursor);
      await settle(m, r.status);
      return { ...update, ai: info, undo: 0 };
    }),

    /** The targets a Tool from the player's hand could go on (the engine's preview). */
    preview: (user, id, { revision, action } = {}) => serial(id, async () => call(ownGame(user, id), 'preview', { seat: PLAYER, revision, action })),

    /** Takes back the player's last quiet move this turn; the view starts again (reset). */
    undo: (user, id) => serial(id, async () => {
      const m = ownGame(user, id), s = state(id);
      const last = s.undo.pop() ?? fail(409, '没有可以撤销的操作。', 'no-undo');
      await call(m, 'rewind', { revision: last.revision });
      record(id, { type: 'rewind', revision: last.revision, reason: 'undo' });
      s.cursor = null;
      const { update } = await playerUpdate(m, s, null);
      return { ...update, undo: s.undo.length };
    }),

    /** The Professor's estimates for the player's moves ({key, action}), from the server's own position. */
    rate: (user, id, { actions } = {}) => serial(id, async () => {
      const m = ownGame(user, id);
      if (!ai) fail(503, '服务器没有启用对战 AI。');
      const { snapshot } = await call(m, 'snapshot');
      return ai.rate({ snapshot, player: PLAYER, actions });
    }),

    abandon: (user, id) => serial(id, async () => { await abandon(ownGame(user, id)); return {}; }),

    // ---- administrators (调试台) ----
    /** The whole state of a game still on. */
    async state(id) {
      const m = store.getMatch(id);
      if (!m?.setup.server || m.status !== 'playing') fail(404, '找不到进行中的这局对战。');
      return serial(id, async () => call(m, 'snapshot'));
    },
    /** An administrator's edit (or, with revert, the state before one): recorded, and the player's view starts again. */
    async edit(admin, id, { state: snapshot, command = '', lines = [], revert = false } = {}) {
      const m = store.getMatch(id);
      if (!m?.setup.server || m.status !== 'playing') fail(404, '找不到进行中的这局对战。');
      if (!isObject(snapshot)) fail(400, '局面格式不正确。');
      return serial(id, async () => {
        const r = await call(m, 'restore', { snapshot });
        record(id, revert ? { type: 'rewind', revision: snapshot.revision, reason: 'revert' }
          : { type: 'edit', revision: snapshot.revision - 1, command: String(command).slice(0, 500),
            lines: [].concat(lines).map(String).slice(0, 50), state: snapshot, hash: r.hash });
        const s = state(id);
        s.undo = [];
        s.cursor = null;
        if (m.userId !== admin.id) return { status: r.status };
        const { update } = await playerUpdate(m, s, null);
        return update;
      });
    },

    /**
     * 从这一步接管: a game that is over (or any, for an administrator) played again up to `move` as a new game of the
     * player's, its record starting with those moves.
     */
    async takeover(user, { match: fromId, move } = {}) {
      const from = store.getMatch(fromId);
      if (!from || (from.userId !== user.id && user.role !== 'admin')) fail(404, '找不到这局对战。');
      if (from.status === 'playing' && from.setup.server && user.role !== 'admin') fail(409, '进行中的对局不能接管。');
      const { moves } = effectiveMoves(store.matchSteps(from.id));
      if (!Number.isInteger(move) || move < 0 || move > moves.length) fail(400, '接管位置不正确。');
      const taken = moves.slice(0, move);
      if (taken.some((x) => x.type === 'edit') && user.role !== 'admin') fail(403, '含有调试修改的对局只有管理员可以接管。');
      const decks = from.setup.decks.map(({ id, name, cards }) => ({ id, name, cards }));
      const setup = { releaseId: from.setup.releaseId, seed: from.setup.seed, format: from.setup.format, matchMode: from.setup.matchMode,
        decks, server: true, level: from.setup.level ?? null, approval: from.setup.approval ?? null,
        implementation: implementationSummaryFromIndex(index, decks.flatMap((d) => d.cards)), takeover: { match: from.id, move } };
      for (const m of store.listMatches(user.id, 20)) if (m.status === 'playing' && m.setup.server) await abandon(m);
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
      if (!m?.setup.server || m.status !== 'playing' || (m.userId !== user.id && user.role !== 'admin')) return null;
      return serial(id, async () => (await call(m, 'snapshot')).snapshot).catch(() => null);
    },

    close() { clearInterval(sweep); },
  };
}
