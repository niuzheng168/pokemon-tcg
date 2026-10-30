// The engine protocol (docs/ENGINE-PROTOCOL.md) as server/engine-host.mjs answers it, in this thread and in worker
// threads: the same game as the kernel's, a seat sees only its own view, commands are checked against the seat and the
// revision, events arrive once, rewinding and reopening reach the same positions, and a preview answers a Tool's targets
// only. Any other host of the protocol (a worker in another language) should pass the same checks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadRelease } from '../server/catalog.mjs';
import { createEnginePool, EngineCallError } from '../server/engine-pool.mjs';
import { createEngineHost, previewTool } from '../server/engine-host.mjs';
import { Simulation } from '../public/rules/engine.js';
import { randomIndex } from '../public/rules/random.js';
import { fixture, binding, EVIDENCE, board, command, settle, hand, bench, fixtureClock } from './official-rules/fixtures.mjs';
import { createReviewedGame } from '../public/rules/engine.js';
import { stateHash } from '../public/replay.js';
import { createAI } from '../public/cn/ai.js';
import { deckList, RULESET } from '../catalog/zh-CN/V20261019/index.mjs';

// 活力头带 (a Tool) is in the Pikachu deck; with this seed it can be played on moves 12 and 13.
const DECKS = ['csvh1c-pikachu', 'raging-bolt-679141'].map(deckList);
const STEPS = 24;
let release, catalog, pool, setup;

before(async () => {
  release = await loadRelease();
  catalog = await release.catalogFor(DECKS.flat());
  pool = createEnginePool({ workers: 0, release });
  setup = { releaseId: release.releaseId, seed: [3, 7, 1, 8], format: { ...RULESET, id: 'open' }, matchMode: 'normal', decks: DECKS };
});
after(() => pool.close());

const rejects = (promise, code) => assert.rejects(promise, (e) => e instanceof EngineCallError && (!code || e.code === code));

// The old CPU plays both seats from each seat's own view; `onStep` sees every position before its move.
async function playMoves(on, match, steps, onStep = async () => {}) {
  const ai = createAI(catalog), moves = [];
  for (let i = 0; i < steps; i++) {
    const { status } = await on.call('status', { match });
    if (status.actor === null) break;
    const { view } = await on.call('view', { match, seat: status.actor });
    const action = ai(view, status.actor);
    await onStep({ status, view, action });
    const { hash } = await on.call('play', { match, seat: status.actor, revision: status.revision, action });
    moves.push({ seat: status.actor, revision: status.revision, action, hash });
  }
  return moves;
}

const ids = (p) => [p.active, ...p.bench].filter(Boolean).map((m) => m.id);

test('the protocol plays the kernel’s own game, and every reply is plain JSON', async () => {
  const opened = await pool.call('open', { match: 'kernel', setup });
  const moves = await playMoves(pool, 'kernel', STEPS, async ({ status }) => {
    for (const seat of [0, 1]) {
      const reply = await pool.call('view', { match: 'kernel', seat });
      assert.deepEqual(JSON.parse(JSON.stringify(reply)), reply);
    }
    assert.deepEqual((await pool.call('status', { match: 'kernel' })).status, status);
  });
  assert.equal(moves.length, STEPS);
  const { game } = await createReviewedGame({ release, ...setup });
  assert.equal(opened.hash, stateHash(game.snapshot()));
  for (const { seat, revision, action, hash } of moves) {
    game.dispatch({ player: seat, expectedRevision: revision, action });
    assert.equal(hash, stateHash(game.snapshot()), `move on revision ${revision}`);
  }
  // Records keep the approval; it names both decks' printings, so it is the server's, not a table's.
  assert.deepEqual(new Set(opened.approval.printingIds), new Set(DECKS.flat()));
});

test('a seat’s view holds no card it cannot see, and no request of the other seat', async () => {
  await pool.call('open', { match: 'hidden', setup });
  let checked = 0;
  await playMoves(pool, 'hidden', STEPS, async ({ status }) => {
    const { snapshot: s } = await pool.call('snapshot', { match: 'hidden' });
    for (const seat of [0, 1]) {
      const { view } = await pool.call('view', { match: 'hidden', seat }), text = JSON.stringify(view);
      const facedown = (p) => p.prizes.filter((id) => !(p.faceUpPrizes ?? []).includes(id));
      const theirs = s.players[1 - seat], mine = s.players[seat];
      const unseen = [...theirs.hand, ...theirs.deck, ...facedown(theirs), ...(view.pending ? [] : [...mine.deck, ...facedown(mine)])];
      for (const id of unseen) assert.ok(!text.includes(`"${id}"`), `seat ${seat} sees ${id} on revision ${status.revision}`);
      assert.deepEqual(view.players[1 - seat].hand, { count: theirs.hand.length });
      assert.ok(!('rng' in view) && !('queue' in view) && !('events' in view));
      if (status.actor !== seat) assert.equal(view.pending, null);
      checked++;
    }
  });
  assert.equal(checked, 2 * STEPS);
});

test('a spectator sees no hidden card of either seat, no request and no move; their events arrive once', async () => {
  await pool.call('open', { match: 'watched', setup });
  let cursor = null, seen = [];
  await playMoves(pool, 'watched', STEPS, async ({ status }) => {
    const { snapshot: s } = await pool.call('snapshot', { match: 'watched' });
    const r = await pool.call('watch', { match: 'watched', cursor }), text = JSON.stringify(r.view);
    seen.push(...r.events);
    cursor = r.cursor;
    const facedown = (p) => p.prizes.filter((id) => !(p.faceUpPrizes ?? []).includes(id));
    for (const p of s.players) for (const id of [...p.hand, ...p.deck, ...facedown(p)])
      assert.ok(!text.includes(`"${id}"`), `a spectator sees ${id} on revision ${status.revision}`);
    assert.deepEqual(r.view.players.map((p) => p.hand), s.players.map((p) => ({ count: p.hand.length })));
    assert.deepEqual([r.view.pending, r.view.legalActions, r.status], [null, [], status]);
    assert.ok(r.events.every((e) => e.visibility === 'public'));
  });
  seen.push(...(await pool.call('watch', { match: 'watched', cursor })).events);
  assert.deepEqual(seen, (await pool.call('watch', { match: 'watched' })).events);
  await rejects(pool.call('watch', { match: 'nowhere' }), 'unknown-match');
});

test('a command is checked against the seat, the revision and the match', async () => {
  const { status, hash } = await pool.call('open', { match: 'checks', setup });
  const { view } = await pool.call('view', { match: 'checks', seat: status.actor });
  const action = createAI(catalog)(view, status.actor);
  await rejects(pool.call('play', { match: 'checks', seat: 1 - status.actor, revision: status.revision, action }));
  await rejects(pool.call('play', { match: 'checks', seat: status.actor, revision: status.revision + 1, action }), 'stale-command');
  await rejects(pool.call('play', { match: 'checks', seat: 2, revision: status.revision, action }), 'bad-request');
  await rejects(pool.call('play', { match: 'nowhere', seat: 0, revision: 0, action }), 'unknown-match');
  await rejects(pool.call('open', { match: 'checks', setup }), 'match-exists');
  await rejects(pool.call('open', { match: 'other', setup: { ...setup, releaseId: 'another-release' } }), 'release-mismatch');
  await rejects(pool.call('open', { match: 'other', setup: { ...setup, seed: [0, 0, 0, 0] } }), 'bad-request');
  await rejects(pool.call('shuffle', { match: 'checks' }), 'bad-request');
  assert.deepEqual(await pool.call('status', { match: 'checks' }), { status, hash });
  await pool.call('play', { match: 'checks', seat: status.actor, revision: status.revision, action });
  assert.equal((await pool.call('status', { match: 'checks' })).status.revision, status.revision + 1);
  assert.deepEqual(await pool.call('close', { match: 'checks' }), { closed: true });
  await rejects(pool.call('status', { match: 'checks' }), 'unknown-match');
});

test('each seat gets its events once and in order; a rewind starts its history again', async () => {
  await pool.call('open', { match: 'events', setup });
  const cursors = [null, null], seen = [[], []];
  const catchUp = async (seat) => {
    const r = await pool.call('view', { match: 'events', seat, cursor: cursors[seat] });
    if (r.reset) seen[seat] = [];
    seen[seat].push(...r.events);
    cursors[seat] = r.cursor;
    return r;
  };
  const moves = await playMoves(pool, 'events', STEPS, async () => { await catchUp(0); await catchUp(1); });
  for (const seat of [0, 1]) {
    await catchUp(seat);
    assert.deepEqual(seen[seat], (await pool.call('view', { match: 'events', seat })).events);
    assert.equal((await catchUp(seat)).events.length, 0);
  }
  assert.ok(seen[0].length > 20 && seen[1].length > 20);
  await pool.call('rewind', { match: 'events', revision: moves[5].revision });
  const after = await catchUp(0);
  assert.equal(after.reset, true);
  assert.deepEqual(seen[0], (await pool.call('view', { match: 'events', seat: 0 })).events);
});

test('rewinding, and opening again with the moves played, reach the same positions', async () => {
  const opened = await pool.call('open', { match: 'line', setup });
  const moves = await playMoves(pool, 'line', STEPS), last = moves.at(-1);
  const hashAt = (revision) => (revision === 0 ? opened.hash : moves[revision - 1].hash);
  // The latest revision from the start of its turn, then one well before it (played again from the start of the game).
  for (const revision of [last.revision, 3]) {
    const r = await pool.call('rewind', { match: 'line', revision });
    assert.equal(r.status.revision, revision);
    assert.equal(r.hash, hashAt(revision));
  }
  for (const { seat, revision, action, hash } of moves.slice(3))
    assert.equal((await pool.call('play', { match: 'line', seat, revision, action })).hash, hash);
  await rejects(pool.call('rewind', { match: 'line', revision: last.revision + 2 }), 'bad-request');
  // A server that lost the match (a restart, a worker that died) opens it again from its record.
  const reopened = await pool.call('open', { match: 'line-again', setup, moves: moves.map(({ seat, action }) => ({ seat, action })) });
  assert.equal(reopened.hash, last.hash);
  assert.deepEqual(reopened.status, (await pool.call('status', { match: 'line' })).status);
  const wrong = moves.map(({ seat, action }) => ({ seat: 1 - seat, action }));
  await rejects(pool.call('open', { match: 'line-wrong', setup, moves: wrong }), 'replay-refused');
});

test('a preview answers a Tool’s targets, and nothing for any other card', async () => {
  await pool.call('open', { match: 'preview', setup });
  let tools = 0, others = 0;
  await playMoves(pool, 'preview', STEPS, async ({ status, view }) => {
    for (const action of view.legalActions.filter((a) => a.type === 'playTrainer')) {
      const { pending } = await pool.call('preview', { match: 'preview', seat: status.actor, revision: status.revision, action });
      const card = view.players[status.actor].hand.find((c) => c.instanceId === action.cardId);
      if (catalog.definition(card.definitionId).mechanics.category === 'tool') {
        assert.equal(pending.kind, 'tool-target');
        assert.ok(pending.options.length && pending.options.every((id) => ids(view.players[status.actor]).includes(id)));
        tools++;
      } else {
        assert.equal(pending, null);
        others++;
      }
    }
    assert.deepEqual((await pool.call('status', { match: 'preview' })).status, status);
  });
  assert.ok(tools >= 2 && others >= 5, `${tools} Tool and ${others} other previews`);
});

test('a preview never tells the next random result: a Tool played under a coin before each Trainer answers nothing', async () => {
  // 蟾蜍王's 振动拳 (zh-Hans:30thC:070/103): the opponent flips a coin before each Item, Supporter, Tool or Stadium next
  // turn, and on tails the card does nothing. Were the preview to play it on, heads would ask for a target, tails not.
  const quake = { op: 'useCoin', actions: ['playItem', 'playSupporter', 'playTool', 'playStadium'] };
  const f = await fixture((defs) => defs.find((d) => d.definitionId === 'other').mechanics.attacks.push({ attackId: 'other:quake',
    name: 'quake', cost: [], printedDamage: null, sourceOfTruth: EVIDENCE,
    effects: [binding('cn.lastingPlayer@1', { side: 'opponent', duration: 'nextOpponentTurn', effect: quake }, 'quake')] }));
  const seedFor = (heads) => {
    for (let i = 1; ; i++) {
      const seed = [Math.imul(i, 8000009) >>> 0, Math.imul(i, 333333331) >>> 0, i * 17, i * 37];
      if ((randomIndex([...seed], 2) === 0) === heads) return seed;
    }
  };
  for (const heads of [true, false]) {
    let tool;
    const g = board(f, (s) => {
      fixtureClock(s, [0, 1, 0, 1]);
      const o = bench(s, 1, 'other'), p = s.players[1];
      p.bench = [p.active]; p.active = o;
      s.players[0].discard.push(...s.players[0].hand.splice(0));
      tool = hand(s, 0, 'tool');
    });
    command(g, { type: 'attack', attackId: 'other:quake' }); settle(g);
    const snap = g.snapshot();
    snap.rng = seedFor(heads);
    const sim = new Simulation(snap, f.catalog), before = JSON.stringify(sim.state);
    assert.deepEqual(previewTool(sim, f.catalog, 0, { type: 'playTrainer', cardId: tool }), { pending: null }, `next coin ${heads ? 'heads' : 'tails'}`);
    assert.equal(JSON.stringify(sim.state), before, 'The game itself is untouched.');
    // (The fork really flips: heads would have asked for the Tool's target.)
    const fork = sim.fork();
    fork.attempt(0, { type: 'playTrainer', cardId: tool });
    assert.equal(fork.view(0).pending?.kind === 'tool-target', heads);
  }
});

test('restore replaces the position with a checked one and starts the history again', async () => {
  await pool.call('open', { match: 'restore', setup });
  await playMoves(pool, 'restore', 6);
  const before = await pool.call('status', { match: 'restore' });
  const { cursor } = await pool.call('view', { match: 'restore', seat: 0 });
  const { snapshot } = await pool.call('snapshot', { match: 'restore' });
  assert.deepEqual(await pool.call('restore', { match: 'restore', snapshot }), before);
  assert.equal((await pool.call('view', { match: 'restore', seat: 0, cursor })).reset, true);
  await rejects(pool.call('rewind', { match: 'restore', revision: 0 }), 'bad-request');
  snapshot.players[0].hand.push('p0c999');
  await rejects(pool.call('restore', { match: 'restore', snapshot }));
  assert.deepEqual(await pool.call('status', { match: 'restore' }), before);
});

test('a state that fails the turn-start check stops its match until it is rewound', async () => {
  let failures = 1;
  const host = createEngineHost({ release, checkState: (s) => { if (s.turn === 2 && failures-- > 0) throw new Error('broken on purpose'); } });
  let next = 0;
  const on = { async call(op, params = {}) {
    const reply = await host.handle({ ...structuredClone(params), id: ++next, op });
    if (!reply.ok) throw new EngineCallError(reply.error);
    return reply.result;
  } };
  await on.call('open', { match: 'm', setup });
  let stopped = null;
  await playMoves(on, 'm', 60, async ({ status }) => { if (status.turn >= 2) throw Object.assign(new Error('past turn 2'), { status }); })
    .catch((e) => { stopped = e; });
  assert.equal(stopped?.code, 'state-invalid', 'The move that starts turn 2 reports the failed check.');
  const { status, broken } = await on.call('status', { match: 'm' });
  assert.equal(status.turn, 2);
  assert.match(broken, /broken on purpose/);
  await rejects(on.call('view', { match: 'm', seat: 0 }), 'state-invalid');
  await rejects(on.call('play', { match: 'm', seat: status.actor, revision: status.revision, action: { type: 'concede' } }), 'state-invalid');
  assert.ok((await on.call('snapshot', { match: 'm' })).snapshot.cards, 'The server can still take the position for a report.');
  const back = await on.call('rewind', { match: 'm', revision: status.revision - 1 });
  assert.equal(back.status.turn, 1);
  assert.equal((await on.call('status', { match: 'm' })).broken, undefined);
  await playMoves(on, 'm', 12);
  assert.ok((await on.call('status', { match: 'm' })).status.turn >= 2, 'Played again, the turn starts and passes its check.');
});

test('worker threads: matches spread over the workers and play the same game', async () => {
  const workers = createEnginePool({ workers: 2 });
  try {
    assert.equal((await workers.call('hello')).releaseId, release.releaseId);
    await Promise.all(['w1', 'w2'].map((match) => workers.call('open', { match, setup })));
    assert.deepEqual(workers.load(), [1, 1]);
    const [one, two] = await Promise.all(['w1', 'w2'].map((match) => playMoves(workers, match, 6)));
    await pool.call('open', { match: 'threads', setup });
    const here = await playMoves(pool, 'threads', 6);
    assert.deepEqual(one.map((m) => m.hash), here.map((m) => m.hash));
    assert.deepEqual(two.map((m) => m.hash), here.map((m) => m.hash));
    await workers.call('close', { match: 'w1' });
    assert.deepEqual(workers.load().toSorted(), [0, 1]);
    await rejects(workers.call('status', { match: 'w1' }), 'unknown-match');
    // A worker that stops loses its matches; the server opens them again from their records.
    const index = workers.load().indexOf(1);
    await workers.restart(index);
    assert.deepEqual(workers.load(), [0, 0]);
    await rejects(workers.call('status', { match: 'w2' }), 'unknown-match');
    const reopened = await workers.call('open', { match: 'w2', setup, moves: two.map(({ seat, action }) => ({ seat, action })) });
    assert.equal(reopened.hash, two.at(-1).hash);
    assert.equal((await workers.call('status', { match: 'w2' })).status.revision, two.at(-1).revision + 1);
  } finally {
    await workers.close();
  }
});
