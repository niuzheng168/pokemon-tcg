// The push channel (GET /api/events): Server-Sent Events to every page a signed-in player has open. The lobby hears
// when the rooms or the games in progress change (`rooms`, `games`) and when a room of the player's was joined
// (`match`); a game between two players hears each move (`move`), when a player opens or closes the site (`presence`)
// and how many watch it (`watchers`). A spectator's page holds a stream for the game it watches (?watch=<id>): it hears
// that game's events too. A player is online while at least one page of theirs holds a stream; listeners hear when that
// changes, and when a game's spectators change.
const HEARTBEAT_MS = 25_000;

export function createHub({ heartbeatMs = HEARTBEAT_MS } = {}) {
  // userId → Set of streams; a stream is {res, watch: the game it watches or null}.
  const streams = new Map(), listeners = new Set(), watchListeners = new Set();
  const changed = (userId, online) => { for (const fn of listeners) fn(userId, online); };
  const write = (stream, event, data) => stream.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  function send(userId, event, data = {}) {
    for (const stream of streams.get(userId) ?? []) write(stream, event, data);
  }
  // The users watching game `id` (a user with two pages on it counts once).
  function watching(id) {
    const users = new Set();
    for (const [userId, set] of streams) for (const s of set) if (s.watch === id) users.add(userId);
    return users;
  }

  return {
    /** Holds `res` open as the player's stream until the page goes away; `watch`: the game the page watches. */
    subscribe(user, req, res, { watch = null } = {}) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      // A comment now and then keeps the connection from looking idle and finds a page that went away.
      const beat = setInterval(() => res.write(':\n\n'), heartbeatMs);
      beat.unref();
      const first = !streams.has(user.id), stream = { res, watch };
      if (first) streams.set(user.id, new Set());
      streams.get(user.id).add(stream);
      req.on('close', () => {
        clearInterval(beat);
        const set = streams.get(user.id);
        if (!set?.delete(stream)) return;
        if (!set.size) { streams.delete(user.id); changed(user.id, false); }
        if (watch !== null) for (const fn of watchListeners) fn(watch);
      });
      if (first) changed(user.id, true);
      if (watch !== null) for (const fn of watchListeners) fn(watch);
    },
    send,
    broadcast(event, data = {}) { for (const userId of streams.keys()) send(userId, event, data); },
    /** To every page watching game `id`. */
    sendWatchers(id, event, data = {}) {
      for (const set of streams.values()) for (const s of set) if (s.watch === id) write(s, event, data);
    },
    watchers: (id) => watching(id).size,
    online: (userId) => streams.has(userId),
    /** How many streams (pages) the user holds open. */
    streams: (userId) => streams.get(userId)?.size ?? 0,
    /** fn(userId, online) when a player's first page opens the stream or the last one closes it. */
    listen(fn) { listeners.add(fn); },
    /** fn(id) when a page starts or stops watching game `id`. */
    listenWatch(fn) { watchListeners.add(fn); },
    close() {
      for (const set of streams.values()) for (const s of set) s.res.end();
      streams.clear();
    },
  };
}
