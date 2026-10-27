// The AI service (ai/service.mjs) on worker threads, its HTTP server (ai/http.mjs) and the website's AI routes: 小茂's
// move is one the rules accept, the advisor rates every move the same as the search run here, and bad requests are
// refused with a status.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Simulation, OfficialGame } from '../../public/rules/engine.js';
import { createAIService, ADVISOR, AIError } from '../../ai/service.mjs';
import { aiHandler, remoteAI } from '../../ai/http.mjs';
import { createSearch } from '../../ai/search.mjs';
import { makeAgent } from '../../ai/agents.mjs';
import { playSafely, stepCounter } from '../../ai/play.mjs';
import { createApp } from '../../server/app.mjs';
import { openStore } from '../../server/store.mjs';
import { reviewed, release, BOLT, DECK, STANDARD_FORMAT } from '../cn-cards/helpers.mjs';

let service, snapshot, catalog, me;
before(async () => {
  const ctx = await reviewed([1, 3, 5, 7], [BOLT, DECK], { ...STANDARD_FORMAT, id: 'open' });
  catalog = ctx.catalog;
  const sim = new Simulation(ctx.game.snapshot(), catalog), legacy = makeAgent('legacy', catalog), count = stepCounter(), rng = [1, 2, 3, 4];
  while (sim.actor !== null && !(sim.state.turn >= 5 && !sim.state.pending)) { const p = sim.actor; playSafely(sim, p, legacy.decide(sim, p, count(sim, p)), rng); }
  me = sim.actor;
  snapshot = sim.snapshot();
  service = createAIService({ release, workers: 2 });
});
after(() => service.close());

const accepted = (action) => {
  const game = OfficialGame.restore(structuredClone(snapshot), { catalog });
  game.dispatch({ player: me, expectedRevision: snapshot.revision, action });
  return true;
};

test('小茂 plays a move the rules accept at every difficulty level', async () => {
  for (const level of [1, 2, 3, 4, 5]) {
    const r = await service.decide({ snapshot, player: me, level });
    assert.equal(r.level, level);
    assert.ok(accepted(r.action), `level ${level}`);
    if (level >= 4) assert.ok(r.value > 0 && r.value < 1);
  }
});

test('a deck tuned to plan its turns (猛雷鼓) plays them with the whole-turn planner at the search levels', async () => {
  const ctx = await reviewed([1, 3, 5, 7], [BOLT, DECK], { ...STANDARD_FORMAT, id: 'open' });
  const sim = new Simulation(ctx.game.snapshot(), ctx.catalog), legacy = makeAgent('legacy', ctx.catalog), count = stepCounter(), rng = [1, 2, 3, 4];
  while (sim.actor !== null && !(sim.state.turn >= 3 && sim.actor === 0 && sim.state.current === 0 && !sim.state.pending)) {
    const p = sim.actor; playSafely(sim, p, legacy.decide(sim, p, count(sim, p)), rng);
  }
  const position = sim.snapshot(), r = await service.decide({ snapshot: position, player: 0, level: 4 });
  assert.equal(r.by, 'plan');
  const game = OfficialGame.restore(structuredClone(position), { catalog: ctx.catalog });
  game.dispatch({ player: 0, expectedRevision: position.revision, action: r.action });
});

test('the advisor rates every move, the same as the search run here, with reasons', async () => {
  const actions = [...new Simulation(snapshot, catalog).view(me).legalActions, { type: 'concede' }].map((action, i) => ({ key: `a${i}`, action }));
  const rated = await service.rate({ snapshot, player: me, actions });
  assert.deepEqual(Object.keys(rated.ranking.probabilities).sort(), actions.map((a) => a.key).sort());
  const here = createSearch(catalog, { ...ADVISOR })(snapshot, me, { prune: false, seed: [snapshot.revision + 1, me + 1, 0, snapshot.rng[0]],
    moves: actions.filter((a) => a.action.type !== 'concede').map((a) => a.action) });
  assert.equal(rated.win.value, here.moves[0].value);
  assert.equal(rated.ranking.probabilities[rated.ranking.choice], here.moves[0].value);
  assert.deepEqual(rated.moves[actions.at(-1).key], { win: 0, se: 0, n: 0, reasons: [{ code: 'concede' }] }, 'Conceding loses.');
  assert.ok(Object.values(rated.moves).every((m) => Array.isArray(m.reasons)));
  assert.ok(Object.values(rated.moves).some((m) => m.reasons.length));
});

test('a request the service cannot answer is refused with a status', async () => {
  const status = (promise) => promise.then(() => null, (e) => (e instanceof AIError ? e.status : e.message));
  assert.equal(await status(service.decide({ snapshot: { cards: {} }, player: me, level: 3 })), 422);
  assert.equal(await status(service.decide({ snapshot: { ...snapshot, revision: -1 }, player: me, level: 3 })), 422);
  assert.equal(await status(service.decide({ snapshot, player: 1 - me, level: 3 })), 409);
  assert.equal(await status(service.decide({ snapshot, player: me, level: 9 })), 422);
  assert.equal(await status(service.rate({ snapshot, player: me, actions: [] })), 422);
});

test('the AI server answers over HTTP (gzip) as the service does, and checks its token', async () => {
  const server = createServer(aiHandler(service, { token: 'secret' }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const remote = remoteAI(url, { token: 'secret' });
    assert.deepEqual((await remote.health()).releaseId, release.releaseId);
    const [there, here] = await Promise.all([remote.decide({ snapshot, player: me, level: 4 }), service.decide({ snapshot, player: me, level: 4 })]);
    assert.deepEqual(there.action, here.action);
    await assert.rejects(remoteAI(url, { token: 'wrong' }).decide({ snapshot, player: me, level: 3 }), (e) => e.status === 401);
    await assert.rejects(remote.decide({ snapshot, player: 1 - me, level: 3 }), (e) => e.status === 409);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('the website: the AI routes need a user, take a state from administrators only, answer 503 without the AI, and pass requests to it', async () => {
  const store = openStore(':memory:');
  await store.createUser({ username: 'ash', password: 'pikachu-123' });
  await store.createUser({ username: 'oak', password: 'professor-123', role: 'admin' });
  const seen = [];
  const stub = { remote: 'http://ai.test', decide: async (b) => (seen.push(b), { action: { type: 'endTurn' }, level: b.level }),
    rate: async (b) => (seen.push(b), { ranking: { choice: 'a0', probabilities: { a0: 0.5 } } }), close: async () => {} };
  for (const ai of [null, stub]) {
    const server = createServer(createApp({ store, site: '/nonexistent', release, index: await release.index(), library: null, ai }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (path, { body, cookie } = {}) => fetch(base + path, { method: body ? 'POST' : 'GET',
      headers: { ...(cookie && { cookie }), ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) });
    try {
      assert.equal((await call('/api/engine')).status, 401);
      const login = await call('/api/auth/login', { body: { username: 'ash', password: 'pikachu-123' } });
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const engine = await (await call('/api/engine', { cookie })).json();
      assert.deepEqual([engine.engine, engine.ready, engine.levels.map((l) => l.name)],
        [ai ? 'search' : 'cpu', !!ai, ['新手', '训练家', '道馆馆主', '四天王', '宝可梦大师']]);
      // A player's table plays on the server (/api/play), which asks the AI with its own state: a state from a browser is
      // an administrator's tool only.
      const rateBody = { snapshot, player: me, actions: [{ key: 'a0', action: { type: 'endTurn' } }] };
      assert.deepEqual([(await call('/api/decide', { cookie, body: { snapshot, player: me, level: 4 } })).status,
        (await call('/api/rate', { cookie, body: rateBody })).status], [403, 403]);
      const admin = (await call('/api/auth/login', { body: { username: 'oak', password: 'professor-123' } })).headers.get('set-cookie').split(';')[0];
      const decide = await call('/api/decide', { cookie: admin, body: { snapshot, player: me, level: 4 } });
      const rate = await call('/api/rate', { cookie: admin, body: rateBody });
      assert.deepEqual([decide.status, rate.status], ai ? [200, 200] : [503, 503]);
      if (ai) {
        assert.deepEqual((await decide.json()).action, { type: 'endTurn' });
        assert.equal(seen[0].level, 4);
        assert.equal(seen[0].snapshot.revision, snapshot.revision, 'A snapshot of a few hundred KB fits the request limit.');
      }
    } finally {
      await new Promise((r) => server.close(r));
    }
  }
  store.close();
});
