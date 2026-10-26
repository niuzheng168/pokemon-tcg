// The engine host: the reference implementation of the engine protocol (docs/ENGINE-PROTOCOL.md). It keeps every
// match's whole state and answers JSON requests {id, op, ...params} with {id, ok: true, result} or
// {id, ok: false, error: {code, message, ruleId?}}. What it gives a seat is that seat's player view only; the two
// outputs that carry hidden cards (`snapshot`, and `approval` from `open`) are for the server, never for a table.
// The caller binds seats to players and decides policy (who may rewind, timers, the CPU's moves): the host only
// plays the rules. It runs in a worker thread (server/engine-worker.mjs) or in-process (server/engine-pool.mjs).
import { createReviewedGame, restoreReviewedGame, Simulation, reduceGame, playerView, assertGameState, KERNEL_BUILD }
  from '../public/rules/engine.js';
import { stateHash } from '../public/replay.js';
import { releaseIdentity } from '../public/release-identity.js';

export const PROTOCOL = 'engine/1';
// A preview answers only the target question of a Tool played from the seat's own hand: those targets are the seat's
// Pokémon in play. Any other first question could show hidden cards (a deck search) or the next random result.
const PREVIEW_KINDS = new Set(['tool-target']);
// Saved positions at the start of the latest turns, for `rewind`; older revisions are played again from the base.
const TURN_CHECKPOINTS = 2;

export class HostError extends Error {
  constructor(code, message) { super(message); this.name = 'HostError'; this.code = code; }
}
const fail = (code, message) => { throw new HostError(code, message); };

const isObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const isUint32 = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
const matchId = (m) => (typeof m === 'string' && m.length > 0 && m.length <= 100 ? m : fail('bad-request', 'match must be a short string.'));
const seatOf = (s) => ([0, 1].includes(s) ? s : fail('bad-request', 'seat must be 0 or 1.'));
const revisionOf = (r) => (Number.isInteger(r) && r >= 0 ? r : fail('bad-request', 'revision must be a whole number.'));
const actionOf = (a) => (isObject(a) && typeof a.type === 'string' ? a : fail('bad-request', 'action must be a command object.'));

function setupOf(setup) {
  if (!isObject(setup) || typeof setup.releaseId !== 'string' || typeof setup.matchMode !== 'string' || !isObject(setup.format))
    fail('bad-request', 'setup needs releaseId, format and matchMode.');
  if (!Array.isArray(setup.seed) || setup.seed.length !== 4 || !setup.seed.every(isUint32) || setup.seed.every((n) => n === 0))
    fail('bad-request', 'setup.seed must be four uint32 words, not all zero.');
  if (!Array.isArray(setup.decks) || setup.decks.length !== 2 ||
      !setup.decks.every((d) => Array.isArray(d) && d.every((id) => typeof id === 'string')))
    fail('bad-request', 'setup.decks must be two lists of printing ids.');
  return setup;
}

function errorOf(error) {
  if (typeof error?.code === 'string') return { code: error.code, message: error.message };
  if (error?.name === 'RuleViolation') return { code: 'rule-violation', ruleId: error.ruleId, message: error.message };
  console.error(error);
  return { code: 'internal', message: String(error?.message ?? error) };
}

// Who must act: the player a request waits for, else the turn player; null once the game is over.
const statusOf = (s) => ({ revision: s.revision, turn: s.turn, phase: s.phase,
  actor: s.result ? null : s.pending ? s.pending.player : s.current, result: s.result ?? null });

/** `release`: an opened reviewed release (server/catalog.mjs loadRelease). */
export function createEngineHost({ release }) {
  const matches = new Map(), tails = new Map();

  const matchFor = (id) => matches.get(matchId(id)) ?? fail('unknown-match', `No match ${id} on this host.`);

  // Moves played again on a Simulation (the same rules with the state self-checks off, tests/*/simulation.test.mjs), the
  // position it reaches then checked once: every move was accepted by the checked kernel when it was first played.
  function playOn(snapshot, catalog, moves) {
    const sim = new Simulation(snapshot, catalog, { checked: false });
    moves.forEach(({ seat, action }, i) => {
      try { sim.play(seat, action); } catch (error) {
        fail('replay-refused', `Move ${i} (seat ${seat}, ${action?.type}) is refused: ${error.message}`);
      }
    });
    return assertGameState(sim.snapshot(), catalog);
  }

  // The match's position becomes `s` (a state no one else holds: reduceGame copies, and nothing here changes it).
  function admit(match, s) {
    match.state = s;
    match.status = statusOf(s);
    match.hash = stateHash(s);
  }

  // A seat's events after `cursor` ("epoch.count" of that seat's visible events); a cursor from before a rewind or a
  // restore (another epoch) gets the whole history again with reset: true.
  function eventsAfter(match, events, cursor) {
    const [epoch, count] = typeof cursor === 'string' ? cursor.split('.').map(Number) : [NaN, NaN];
    const fresh = epoch === match.epoch && Number.isInteger(count) && count >= 0 && count <= events.length;
    return { events: events.slice(fresh ? count : 0), cursor: `${match.epoch}.${events.length}`, ...(fresh ? {} : { reset: true }) };
  }

  const ops = {
    hello: () => ({ protocol: PROTOCOL, releaseId: release.releaseId, manifestSha256: release.manifestSha256,
      kernelSha256: KERNEL_BUILD.kernelSha256, matches: matches.size }),

    async open({ match: id, setup, expectedApproval, moves = [] }) {
      if (matches.has(matchId(id))) fail('match-exists', `Match ${id} is already open.`);
      const { releaseId, seed, format, matchMode, decks } = setupOf(setup);
      if (releaseId !== release.releaseId) fail('release-mismatch', `This host plays release ${release.releaseId}, not ${releaseId}.`);
      if (!Array.isArray(moves) || !moves.every((m) => isObject(m) && [0, 1].includes(m.seat) && isObject(m.action)))
        fail('bad-request', 'moves must be a list of {seat, action}.');
      const created = await createReviewedGame({ release, decks, seed, format, matchMode, expectedApproval });
      const base = created.game.snapshot(), catalog = created.catalog;
      // The line of play since the base position: move i was made on revision base.revision + i.
      const match = { catalog, epoch: 0, moves: structuredClone(moves), checkpoints: [],
        base: { revision: base.revision, json: JSON.stringify(base) } };
      admit(match, moves.length ? playOn(base, catalog, moves) : base);
      matches.set(id, match);
      return { status: match.status, hash: match.hash, approval: releaseIdentity(created.approval), compatibility: created.compatibility ?? null };
    },

    status: ({ match: id }) => {
      const match = matchFor(id);
      return { status: match.status, hash: match.hash };
    },

    // The seat comes from the caller (the signed-in player's seat), never from the table's command.
    play({ match: id, seat, revision, action }) {
      const match = matchFor(id), turn = match.status.turn;
      const s = reduceGame(match.state, { player: seatOf(seat), expectedRevision: revisionOf(revision), action: actionOf(action) }, match.catalog);
      admit(match, s);
      match.moves.push({ seat, action: structuredClone(action) });
      if (s.turn !== turn) {
        match.checkpoints.push({ revision: s.revision, json: JSON.stringify(s) });
        if (match.checkpoints.length > TURN_CHECKPOINTS) match.checkpoints.shift();
      }
      return { status: match.status, hash: match.hash };
    },

    view({ match: id, seat, cursor = null }) {
      const match = matchFor(id);
      const { events, ...view } = playerView(match.state, match.catalog, seatOf(seat));
      return { status: match.status, view, ...eventsAfter(match, events, cursor) };
    },

    preview({ match: id, seat, revision, action }) {
      const match = matchFor(id), s = match.state;
      seatOf(seat);
      if (revisionOf(revision) !== s.revision) fail('stale-command', 'A newer game revision exists.');
      const card = actionOf(action).type === 'playTrainer' ? s.cards[action.cardId] : null;
      const tool = card && s.players[seat].hand.includes(action.cardId) && match.catalog.definition(card.definitionId).mechanics.category === 'tool';
      if (!tool) return { pending: null };
      const sim = new Simulation(s, match.catalog, { checked: false });
      if (sim.attempt(seat, action)) return { pending: null };
      const q = sim.view(seat).pending;
      return { pending: q && PREVIEW_KINDS.has(q.kind) ? { kind: q.kind, options: [...q.options], minimum: q.minimum, maximum: q.maximum } : null };
    },

    rewind({ match: id, revision }) {
      const match = matchFor(id), target = revisionOf(revision);
      if (target < match.base.revision || target > match.status.revision)
        fail('bad-request', `revision must be between ${match.base.revision} and ${match.status.revision}.`);
      const from = match.checkpoints.findLast((c) => c.revision <= target) ?? match.base;
      const moves = match.moves.slice(from.revision - match.base.revision, target - match.base.revision);
      admit(match, playOn(JSON.parse(from.json), match.catalog, moves));
      match.moves.length = target - match.base.revision;
      match.checkpoints = match.checkpoints.filter((c) => c.revision <= target);
      match.epoch++;
      return { status: match.status, hash: match.hash };
    },

    snapshot: ({ match: id }) => ({ snapshot: structuredClone(matchFor(id).state) }),

    // A whole new position (an administrator's 调试台 edit): it is checked like any restored game and becomes the base,
    // so the line of play starts again from it.
    async restore({ match: id, snapshot }) {
      const match = matchFor(id);
      if (!isObject(snapshot)) fail('bad-request', 'snapshot must be a game state.');
      const { game, catalog } = await restoreReviewedGame({ release, snapshot });
      const s = game.snapshot();
      admit(match, s);
      Object.assign(match, { catalog, moves: [], checkpoints: [], base: { revision: s.revision, json: JSON.stringify(s) } });
      match.epoch++;
      return { status: match.status, hash: match.hash };
    },

    close: ({ match: id }) => ({ closed: matches.delete(matchId(id)) }),
  };

  return {
    /** One request → its reply. Requests for the same match are answered in the order they arrive. */
    handle(request) {
      const { id = null, op, ...params } = isObject(request) ? request : {};
      const run = async () => {
        try {
          if (!Object.hasOwn(ops, op)) fail('bad-request', `Unknown op ${String(op)}.`);
          return { id, ok: true, result: await ops[op](params) };
        } catch (error) {
          return { id, ok: false, error: errorOf(error) };
        }
      };
      const key = typeof params.match === 'string' ? params.match : null;
      if (key === null) return run();
      const reply = (tails.get(key) ?? Promise.resolve()).then(run);
      tails.set(key, reply);
      reply.then(() => { if (tails.get(key) === reply) tails.delete(key); });
      return reply;
    },
    get matches() { return matches.size; },
  };
}
