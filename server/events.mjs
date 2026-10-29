// The push channel (GET /api/events): Server-Sent Events to every page a signed-in player has open. The lobby hears
// when the rooms change (`rooms`) and when a room of the player's was joined (`match`); a game between two players hears
// each move (`move`) and when the opponent opens or closes the site (`presence`). A player is online while at least one
// page of theirs holds the stream; listeners hear when that changes.
const HEARTBEAT_MS = 25_000;

export function createHub({ heartbeatMs = HEARTBEAT_MS } = {}) {
  const streams = new Map(), listeners = new Set();
  const changed = (userId, online) => { for (const fn of listeners) fn(userId, online); };

  function send(userId, event, data = {}) {
    for (const res of streams.get(userId) ?? []) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  return {
    /** Holds `res` open as the player's stream until the page goes away. */
    subscribe(user, req, res) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      // A comment now and then keeps the connection from looking idle and finds a page that went away.
      const beat = setInterval(() => res.write(':\n\n'), heartbeatMs);
      beat.unref();
      const first = !streams.has(user.id);
      if (first) streams.set(user.id, new Set());
      streams.get(user.id).add(res);
      req.on('close', () => {
        clearInterval(beat);
        const set = streams.get(user.id);
        if (!set?.delete(res) || set.size) return;
        streams.delete(user.id);
        changed(user.id, false);
      });
      if (first) changed(user.id, true);
    },
    send,
    broadcast(event, data = {}) { for (const userId of streams.keys()) send(userId, event, data); },
    online: (userId) => streams.has(userId),
    /** fn(userId, online) when a player's first page opens the stream or the last one closes it. */
    listen(fn) { listeners.add(fn); },
    close() {
      for (const set of streams.values()) for (const res of set) res.end();
      streams.clear();
    },
  };
}
