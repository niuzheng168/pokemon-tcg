// A game played on the server (/api/play, server/play.mjs), from the player's seat: the table's Match drives it the way
// it drives a kernel game (view, dispatch), but the browser holds only its own player view and the events it was sent.
// The player is seat 0; a dispatch for seat 1 asks the server for 小茂's move. The cards the table may describe are its
// own deck's and the ones it has been shown: the catalog grows as cards are revealed (catalogFor), so the browser
// never holds the opponent's list.
import { apiJSON } from './account.js';

const ME = 0;

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
    Object.assign(this, { id: match.id, match, catalogFor, printings: new Set(own(match)), events: [], cursor: null, status: null,
      current: null, undoable: 0, catalog: null });
  }

  // A new game ({deck, opponent, level, seed?}), or the player's game still on (null when there is none).
  static async start(body, options) {
    const r = await apiJSON('/api/play', { method: 'POST', body });
    return new RemoteGame({ ...options, match: r.match }).absorb(r);
  }
  static async current(options) {
    const r = await apiJSON('/api/play/current');
    return r.match ? new RemoteGame({ ...options, match: r.match }).absorb(r) : null;
  }

  // A reply's view: the events after the cursor (all of them again after a reset), and the catalog of every card seen.
  // Each view has its own list of events, as a kernel's does: the table compares the lists before and after a move.
  async absorb(u) {
    this.events = u.reset ? [...u.events] : this.events.concat(u.events);
    Object.assign(this, { cursor: u.cursor, status: u.status, undoable: u.undo ?? this.undoable });
    this.current = { ...u.view, events: this.events };
    const before = this.printings.size;
    printingsIn([u.view, u.events], this.printings);
    if (!this.catalog || this.printings.size !== before) this.catalog = await this.catalogFor([...this.printings].sort());
    return this;
  }

  view(player) {
    if (player !== ME) throw new Error('A game on the server shows the player their own view only.');
    return this.current;
  }

  // The player's command, or (player 1) 小茂's move; the server's answer: {quiet, undo} or {ai: {value, error}}. A refused
  // or lost request leaves the table at the game's latest move (the request may have reached the server).
  async dispatch({ player, expectedRevision, action }) {
    let r;
    try {
      r = player === ME
        ? await apiJSON(`/api/play/${this.id}/move`, { method: 'POST', body: { revision: expectedRevision, action, cursor: this.cursor } })
        : await apiJSON(`/api/play/${this.id}/cpu`, { method: 'POST', body: { revision: expectedRevision, cursor: this.cursor } });
    } catch (error) {
      await this.refresh().catch(() => {});
      throw error;
    }
    await this.absorb(r);
    return r;
  }

  async refresh() { return this.absorb(await apiJSON(`/api/play/${this.id}?cursor=${encodeURIComponent(this.cursor ?? '')}`)); }
  async preview(revision, action) {
    return (await apiJSON(`/api/play/${this.id}/preview`, { method: 'POST', body: { revision, action } })).pending;
  }
  async undo() { return this.absorb(await apiJSON(`/api/play/${this.id}/undo`, { method: 'POST', body: {} })); }
  rate(actions) { return apiJSON(`/api/play/${this.id}/rate`, { method: 'POST', body: { actions } }); }
  abandon() { return apiJSON(`/api/play/${this.id}/abandon`, { method: 'POST', body: {} }); }
  snapshot() { throw new Error('The whole state of a game on the server stays on the server.'); }
}
