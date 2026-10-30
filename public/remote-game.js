// A game played on the server (/api/play, server/play.mjs), from the player's seat: the table's Match drives it the way
// it drives a kernel game (view, dispatch), but the browser holds only its own player view and the events it was sent.
// The player's seat is the match's (`match.seat`: 0 in a game against 小茂, either seat against another player). Against
// 小茂 a dispatch for his seat asks the server for his move. Against another player (在线对战, `match.pvp`) their moves
// are made at their own table: the table waits until the game has moved on (moved: a push from the server's event
// stream refreshes it, ui.js, or the poll) and shows what changed. The cards the table may describe are its own deck's
// and the ones it has been shown: the catalog grows as cards are revealed (catalogFor), so the browser never holds the
// opponent's list. A game between two players can also be watched (观战, WatchedGame): the public view of it, with
// neither hand, and no moves.
import { apiJSON } from './account.js';

// While the table waits for the game to move on, it asks the server this often in case a push was lost.
const POLL_MS = 15_000;

// Every card reference ({printingId, …}) in a view or in events.
function printingsIn(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => printingsIn(v, out));
  else if (value && typeof value === 'object') {
    if (typeof value.printingId === 'string') out.add(value.printingId);
    for (const v of Object.values(value)) if (v && typeof v === 'object') printingsIn(v, out);
  }
  return out;
}

export class RemoteGame {
  // `catalogFor(printingIds)`: the reviewed release's catalog of those printings; `own(match)`: the player's deck
  // (printing ids).
  constructor({ match, catalogFor, own = () => [] }) {
    Object.assign(this, { id: match.id, match, seat: match.seat ?? 0, catalogFor, printings: new Set(own(match)), events: [], cursor: null,
      status: null, current: null, undoable: 0, catalog: null, clock: null, clockAt: 0, online: null, watchers: 0, waiting: [], poll: null,
      queue: Promise.resolve() });
  }

  // A game against another player (no 小茂, no undo, no coach).
  get pvp() { return !!this.match.pvp; }

  // A new game ({deck, opponent, level, seed?}), or the player's game still on (null when there is none).
  static async start(body, options) {
    const r = await apiJSON('/api/play', { method: 'POST', body });
    return new RemoteGame({ ...options, match: r.match }).absorb(r);
  }
  static async current(options) {
    const r = await apiJSON('/api/play/current');
    return r.match ? new RemoteGame({ ...options, match: r.match }).absorb(r) : null;
  }
  // Another player's room joined with one of your decks: the game against them starts.
  static async join(room, deck, options) {
    const r = await apiJSON(`/api/rooms/${encodeURIComponent(room)}/join`, { method: 'POST', body: { deck } });
    return new RemoteGame({ ...options, match: r.match }).absorb(r);
  }

  // A reply's view: the events after the cursor (all of them again after a reset), and the catalog of every card seen.
  // Each view has its own list of events, as a kernel's does: the table compares the lists before and after a move. A
  // game against another player also has both clocks as they stood at the reply, whether the opponent is connected (a
  // spectator: each player, [bool, bool]) and how many are watching.
  async absorb(u) {
    this.events = u.reset ? [...u.events] : this.events.concat(u.events);
    Object.assign(this, { cursor: u.cursor, status: u.status, undoable: u.undo ?? this.undoable });
    if (u.clock) Object.assign(this, { clock: u.clock, clockAt: performance.now() });
    if (typeof u.online === 'boolean' || Array.isArray(u.online)) this.online = u.online;
    if (typeof u.watchers === 'number') this.watchers = u.watchers;
    this.current = { ...u.view, events: this.events };
    const before = this.printings.size;
    printingsIn([u.view, u.events], this.printings);
    if (!this.catalog || this.printings.size !== before) this.catalog = await this.catalogFor([...this.printings].sort());
    const moved = this.waiting.filter((w) => w.revision !== this.status.revision);
    this.waiting = this.waiting.filter((w) => !moved.includes(w));
    if (!this.waiting.length) this.stopWaiting();
    moved.forEach((w) => w.resolve());
    return this;
  }

  view(player) {
    if (player !== this.seat) throw new Error('A game on the server shows the player their own view only.');
    return this.current;
  }

  // One request with the cursor at a time: a refresh (a push, the poll) that overtook a move would be handed the same
  // events again.
  serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  // The player's command, or (against 小茂) his move; the server's answer: {quiet, undo} or {ai: {value, error}}. A
  // refused or lost request leaves the table at the game's latest move (the request may have reached the server).
  dispatch({ player, expectedRevision, action }) {
    if (player !== this.seat && this.pvp) return Promise.reject(new Error('The other player moves at their own table.'));
    return this.serial(async () => {
      let r;
      try {
        r = player === this.seat
          ? await apiJSON(`/api/play/${this.id}/move`, { method: 'POST', body: { revision: expectedRevision, action, cursor: this.cursor } })
          : await apiJSON(`/api/play/${this.id}/cpu`, { method: 'POST', body: { revision: expectedRevision, cursor: this.cursor } });
      } catch (error) {
        await this.pull().catch(() => {});
        throw error;
      }
      await this.absorb(r);
      return r;
    });
  }

  refresh() { return this.serial(() => this.pull()); }
  async pull() { return this.absorb(await apiJSON(`/api/play/${this.id}?cursor=${encodeURIComponent(this.cursor ?? '')}`)); }
  async preview(revision, action) {
    return (await apiJSON(`/api/play/${this.id}/preview`, { method: 'POST', body: { revision, action } })).pending;
  }
  undo() { return this.serial(async () => this.absorb(await apiJSON(`/api/play/${this.id}/undo`, { method: 'POST', body: {} }))); }
  // You give up: the opponent wins (status.result {winner, reason: 'concede'}).
  concede() {
    return this.serial(async () => this.absorb(await apiJSON(`/api/play/${this.id}/concede`, { method: 'POST', body: { cursor: this.cursor } })));
  }
  // The language-model coach's word on the moves ({key, action}) of the position at `revision`; without them, on the
  // request answered there ({options}).
  coach(revision, actions) { return apiJSON(`/api/play/${this.id}/coach`, { method: 'POST', body: { revision, actions } }); }
  abandon() { return apiJSON(`/api/play/${this.id}/abandon`, { method: 'POST', body: {} }); }
  snapshot() { throw new Error('The whole state of a game on the server stays on the server.'); }

  // Resolves once the game has moved on from `revision`: the other player's move, a concession, a clock run out. The
  // server pushes each move (ui.js refreshes the game then); while anything waits, a refresh every POLL_MS stands in for
  // a push that was lost.
  moved(revision) {
    if (this.status.revision !== revision) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiting.push({ revision, resolve });
      this.poll ??= setInterval(() => this.refresh().catch(() => {}), POLL_MS);
    });
  }
  // The table that waited is gone (a new table on this game, or another game): nothing waits any more.
  stopWaiting() {
    this.waiting = [];
    clearInterval(this.poll);
    this.poll = null;
  }

  // A seat's time left now (ms), counting down the running side's since the last reply; null without a clock.
  timeLeft(seat, now = performance.now()) {
    if (!this.clock) return null;
    const running = this.clock.running === seat && !this.status?.result;
    return Math.max(0, this.clock.left[seat] - (running ? now - this.clockAt : 0));
  }
}

// 观战: a game between two players seen by someone who sits in neither seat (GET /api/play/:id/watch). Its view is the
// public one, the same for both seats: both hands as counts, the setup Pokémon face down, no choices and no moves. The
// table follows it the way a player follows the other player's moves (moved: the push channel's `move` for the game
// watched, or the poll), drawing either seat at the bottom.
export class WatchedGame extends RemoteGame {
  static async open(id, options) {
    const r = await apiJSON(`/api/play/${encodeURIComponent(id)}/watch`);
    return new WatchedGame({ ...options, match: r.match }).absorb(r);
  }

  get pvp() { return true; }
  get watching() { return true; }

  // Each reply has the match again: its decks are named once the game is over.
  async absorb(u) {
    if (u.match) this.match = u.match;
    return super.absorb(u);
  }

  view() { return this.current; }
  async pull() { return this.absorb(await apiJSON(`/api/play/${this.id}/watch?cursor=${encodeURIComponent(this.cursor ?? '')}`)); }
  dispatch() { return Promise.reject(new Error('A spectator makes no moves.')); }
  preview() { return Promise.resolve(null); }
  undo() { return Promise.reject(new Error('A spectator makes no moves.')); }
  concede() { return Promise.reject(new Error('A spectator makes no moves.')); }
  coach() { return Promise.reject(new Error('A spectator makes no moves.')); }
  // Leaving the table leaves the game to its players.
  abandon() { return Promise.resolve({}); }
}
