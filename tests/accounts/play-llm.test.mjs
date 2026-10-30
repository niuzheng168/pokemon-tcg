// The language-model levels of 小茂 and the coach beside the player (server/play.mjs, ai/llm-player.mjs), with a fake
// model: 小茂 at a model level plays the model's moves from a mirror of the game that follows every move (one
// conversation, the later questions giving only what changed), and the rule AI for the rest of a turn its model failed
// in; the coach judges every move of the player's position, once, and hears what the player did, and the options of the
// player's requests (setup's among them); a deck's 打法说明 reaches the model; the levels and the coach are offered only
// with their models.
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
import { createAI } from '../../public/cn/ai.js';
import { Simulation } from '../../public/rules/engine.js';
import { llmConfig, LLM_COACH } from '../../ai/llm-levels.mjs';

const meta = JSON.parse(await readFile(join(ROOT, 'public/data/cn/V20261019/decks.json'), 'utf8'));
let server, base, store, site, engines, release;
// The server's log lines about the models' questions.
const logged = [];

// The rule AI here: the CPU engine's move from the snapshot.
const fakeAI = { calls: [], async decide({ snapshot, player, level }) {
  this.calls.push({ level, player });
  const catalog = await release.catalogFor([...new Set(Object.values(snapshot.cards).map((c) => c.printingId))]);
  return { action: createAI(catalog)(new Simulation(snapshot, catalog).view(player), player), value: 0.42 };
} };

// The model: answers a numbered question at random (a seeded generator), in either form; told to, it fails, or holds
// its answer back `hold` ms unless the question is aborted (`held` meanwhile).
const model = { calls: [], fail: false, hold: 0, held: false, seed: 7 };
const random = () => ((model.seed = (Math.imul(model.seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
async function ask(system, user, options) {
  const text = typeof user === 'string' ? user : user.at(-1).content;
  model.calls.push({ system, user, text, options });
  if (model.fail) throw new Error('model down');
  if (model.hold) {
    model.held = true;
    await new Promise((ok, no) => {
      const t = setTimeout(ok, model.hold);
      options.signal?.addEventListener('abort', () => { clearTimeout(t); no(options.signal.reason); }, { once: true });
    }).finally(() => { model.held = false; });
  }
  const asked = text.slice(text.lastIndexOf('\n\n', text.search(/^0\. /m)));
  const numbers = [...asked.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
  const total = Number(/合计正好 (\d+) 个/.exec(asked)?.[1] ?? 0), range = /(\d+)–(\d+) (?:个|项)/.exec(asked);
  const k = total ? 1 : range ? Number(range[1]) : 1;
  const picked = [...numbers].sort(() => random() - 0.5).slice(0, k);
  const judge = system.includes('"choose"');
  const why = Object.fromEntries(numbers.map((n) => [n, `第${n}项的理由`]));
  const json = judge
    ? { ...(total ? { counts: { [picked[0]]: total } } : { choose: range ? picked : picked[0] }), why }
    : { choice: total ? { [picked[0]]: total } : range ? picked : picked[0], reason: '假模型' };
  return { json, usage: { total_tokens: 1 }, items: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(json) }] }] };
}

before(async () => {
  site = await mkdtemp(join(tmpdir(), 'cn-llm-site-'));
  await mkdir(join(site, 'play'), { recursive: true });
  for (const [f, text] of [['play/index.html', '<p>table</p>'], ['play/login.html', '<p>login</p>'], ['404.html', '<p>404</p>'],
    ['play/build.json', '{"commit":"0123abc","dirty":false}']]) await writeFile(join(site, f), text);
  store = openStore(':memory:');
  // (An administrator may give a game its seed.)
  await store.createUser({ username: 'boss', password: 'admin-pass-1', role: 'admin' });
  release = await loadRelease();
  const index = await release.index();
  const library = await loadLibrary({ dir: join(ROOT, 'tests/fixtures/card-library'), index, presentation: meta.cards });
  engines = createEnginePool({ workers: 0, release, slowMs: 1e9 });
  const llm = { ...llmConfig({ models: { sol: { model: 'fake-sol', env: '/dev/null' }, astra: { model: 'fake-astra', env: '/dev/null' } } }), ask,
    log: (line) => logged.push(line) };
  server = createServer(createApp({ store, site, release, index, library, ai: fakeAI, engines, presets: meta.decks, llm }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await engines.close();
  store.close();
  await rm(site, { recursive: true, force: true });
});

async function signedIn(username, password = 'long-enough-1') {
  let cookie = '';
  const call = async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(base + path, { method, headers: { ...(cookie && { cookie }), ...(body !== undefined && { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  if ((await call('/api/auth/register', { method: 'POST', body: { username, password } })).status !== 201)
    await call('/api/auth/login', { method: 'POST', body: { username, password } });
  return { call };
}
async function start(c, body) {
  const r = await c.call('/api/play', { method: 'POST', body });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const t = { id: r.data.match.id, cursor: null, status: null, view: null };
  t.take = (u) => Object.assign(t, { cursor: u.cursor, status: u.status, view: u.view });
  t.take(r.data);
  t.post = async (op, b = {}) => {
    const x = await c.call(`/api/play/${t.id}/${op}`, { method: 'POST', body: { cursor: t.cursor, ...b } });
    if (x.status === 200 && x.data.view) t.take(x.data);
    return x;
  };
  const catalog = release.catalogFor(meta.decks.flatMap((d) => d.cards.flatMap(([id, n]) => Array(n).fill(id))));
  t.step = async () => (t.status.actor === 1 ? t.post('cpu', { revision: t.status.revision })
    : t.post('move', { revision: t.status.revision, action: createAI(await catalog)(t.view, 0) }));
  return t;
}
const keyed = (view) => view.legalActions.map((action, i) => ({ key: `a${i}`, action }));
// A move after which it is still the player's turn, with nothing to answer.
const quiet = (a) => ['bench', 'attachEnergy'].includes(a.type);

test('the levels and the coach are offered with their models only', async () => {
  const c = await signedIn('lance');
  const e = (await c.call('/api/engine')).data;
  assert.equal(e.coach, true);
  assert.deepEqual(e.levels.filter((l) => l.offered).map((l) => [l.level, l.name, !!l.llm]), [[3, '道馆馆主', false], [6, '冠军', true], [7, '宝可梦大师', true]]);
  assert.ok(e.levels.some((l) => l.level === 5 && !l.offered), 'Every level keeps its name (a game keeps its level).');
  // The coach is gpt-6-astra at medium; a config without that model offers neither it nor level 7.
  assert.deepEqual(LLM_COACH, { model: 'astra', effort: 'medium' });
  const solOnly = llmConfig({ models: { sol: { model: 'fake-sol', env: '/dev/null' } } });
  assert.deepEqual([solOnly.levels.map((l) => l.level), solOnly.coach], [[6], null]);
  assert.deepEqual(llmConfig({ models: { astra: { model: 'a', env: '/x' } }, coach: { effort: 'high' } }).coach, { model: 'a', effort: 'high', env: '/x' });
});

test('小茂 at a model level plays the model\'s moves in one conversation, and the rule AI for the rest of a turn its model failed in', async () => {
  // (A deal whose game lasts past the failure: a random one ended too soon now and then.)
  const c = await signedIn('boss', 'admin-pass-1'), t = await start(c, { deck: 'raging-bolt-679141', opponent: 'dragapult-676815', level: 6,
    seed: [5, 2, 3, 4] });
  model.calls = []; fakeAI.calls = [];
  let failedTurn = null;
  for (let i = 0; i < 600 && t.status.actor !== null && !(failedTurn && t.status.turn > failedTurn + 2); i++) {
    // From the fifth turn on, the model fails once: the rule AI plays that turn out, the model the next.
    const failing = t.status.actor === 1 && t.status.turn >= 5 && failedTurn === null;
    if (failing) { model.fail = true; failedTurn = t.status.turn; }
    const asked = model.calls.length, ruled = fakeAI.calls.length, turn = t.status.turn, cpu = t.status.actor === 1;
    const r = await t.step();
    model.fail = false;
    assert.equal(r.status, 200, JSON.stringify(r.data));
    if (failing) assert.equal(r.data.ai.error, 'model down');
    if (cpu && turn === failedTurn && !failing) assert.equal(model.calls.length, asked, 'Not asked again in the turn it failed in.');
    if (cpu && turn !== failedTurn) assert.equal(fakeAI.calls.length, ruled, 'The rule AI plays only the turn the model failed in.');
  }
  assert.ok(failedTurn && t.status.turn > failedTurn + 2, 'The game went on two turns after the failure.');
  const mine = model.calls.filter((x) => !x.system.includes('现在当教练'));
  assert.ok(mine.length > 8, `The model answered 小茂's questions (${mine.length}).`);
  assert.ok(mine.every((x) => x.options.model === 'fake-sol' && x.options.effort === 'low' && x.options.tries === 2 && x.options.timeoutMs === 90000));
  assert.match(mine[0].system, /「多龙巴鲁托/, 'The instruction names 小茂\'s deck.');
  assert.match(mine[0].system, /已和这份卡表、卡面逐条核对/, 'A pool deck plays with its checked playbook.');
  assert.ok(!mine[0].system.includes('{{'), 'Every part of the template is filled.');
  // One conversation: the earlier questions and answers go with each, and within a turn only what changed.
  assert.ok(mine.at(-1).user.length > 10);
  assert.ok(mine.filter((x) => x.text.includes('== 局面变化 ==')).length > 2, 'The mirror followed the game: the later questions of a turn give what changed.');
  assert.ok(mine.some((x) => /自上次提问以来：(\n- .*)*\n- 对手：/.test(x.text)), 'The player\'s moves are told.');
  if (process.env.DUMP) await writeFile(process.env.DUMP, mine.map((x) => x.text).join('\n\n=========\n\n'));
  assert.ok(fakeAI.calls.length > 0 && fakeAI.calls.every((x) => x.level === 3 && x.player === 1), 'The rule AI played the failed turn.');
  const steps = (await c.call(`/api/matches/${t.id}`)).data.steps;
  assert.deepEqual(steps.filter((s) => s.type === 'rejected' && s.player === 1), [], 'Every move of the model was legal.');
});

test('the coach judges every move of the player\'s position once, hears what the player did, and reads the deck\'s 打法说明', async () => {
  const c = await signedIn('steven');
  const bolt = meta.decks.find((d) => d.id === 'raging-bolt-679141');
  const saved = await c.call('/api/decks', { method: 'POST', body: { name: '我的猛雷鼓', format: 'standard', cards: bolt.cards, strategy: '  先用奥琳博士的气魄贴能，再用猛雷鼓的极雷轰打。  ' } });
  assert.equal(saved.status, 201);
  assert.equal(saved.data.deck.strategy, '先用奥琳博士的气魄贴能，再用猛雷鼓的极雷轰打。');
  assert.equal((await c.call('/api/decks', { method: 'POST', body: { name: 'x', format: 'standard', cards: [], strategy: '长'.repeat(4001) } })).status, 400);
  const t = await start(c, { deck: `user:${saved.data.deck.id}`, opponent: 'dragapult-676815', level: 3 });
  while (t.status.actor !== 0 || t.view.pending || t.status.phase === 'setup' || new Set(t.view.legalActions.map((a) => a.type)).size < 3) await t.step();
  model.calls = [];
  const asked = { revision: t.status.revision, actions: keyed(t.view) };
  const [one, two] = await Promise.all([t.post('coach', asked), t.post('coach', asked)]);
  assert.equal(one.status, 200, JSON.stringify(one.data));
  assert.deepEqual(two.data, one.data, 'Asked twice, the same judgement.');
  assert.equal(model.calls.length, 1, 'A position is judged once.');
  const { system, text } = model.calls[0];
  assert.match(system, /现在当教练/);
  assert.match(system, /这副卡组的打法（卡组作者写的）：\n先用奥琳博士的气魄贴能，再用猛雷鼓的极雷轰打。/);
  assert.match(system, /「我的猛雷鼓」/);
  assert.match(system, /"why"/, 'The coach answers with a reason for every option.');
  assert.deepEqual([model.calls[0].options.model, model.calls[0].options.effort], ['fake-astra', 'medium'], 'The coach is the astra model at medium.');
  const moves = one.data.moves, judged = Object.values(moves);
  assert.equal(one.data.revision, t.status.revision);
  assert.ok(Object.keys(moves).length >= asked.actions.length - 1, 'Every move judged (but conceding).');
  assert.ok(judged.some((j) => j.choose) && judged.every((j) => /^第\d+项的理由$/.test(j.reason)));
  assert.ok(text.includes('== 当前局面 =='));
  // A stale question is not asked.
  assert.deepEqual((await t.post('coach', { ...asked, revision: asked.revision - 1 })).data, { revision: asked.revision - 1, stale: true });
  assert.equal(model.calls.length, 1);
  // The player moves; the next question tells the coach what they chose.
  await t.step();
  while (t.status.actor !== 0 || t.view.pending) await t.step();
  const next = await t.post('coach', { revision: t.status.revision, actions: keyed(t.view) });
  assert.equal(next.status, 200);
  assert.match(model.calls.at(-1).text, /玩家实际选择：/);
  assert.equal((await t.post('coach', { revision: t.status.revision, actions: 'all' })).status, 400);
  // An undo: the coach hears of it and is given the whole position again.
  for (let i = 0; i < 400 && (t.status.actor !== 0 || t.view.pending || !t.view.legalActions.some(quiet)); i++) await t.step();
  const moved = await t.post('move', { revision: t.status.revision, action: t.view.legalActions.find(quiet) });
  assert.equal(moved.data.quiet, true);
  assert.equal((await t.post('coach', { revision: t.status.revision, actions: keyed(t.view) })).status, 200);
  assert.equal((await t.post('undo')).status, 200);
  assert.equal((await t.post('coach', { revision: t.status.revision, actions: keyed(t.view) })).status, 200);
  assert.match(model.calls.at(-1).text, /玩家撤销了上一步[\s\S]*== 当前局面 ==/);
});

test('the coach judges the player\'s requests too: going first or second, the Active and the Bench, a card\'s choice', async () => {
  // (A deal where the player chooses going first or second and has Basic Pokémon to choose from.)
  const c = await signedIn('boss', 'admin-pass-1'), t = await start(c, { deck: 'raging-bolt-679141', opponent: 'dragapult-676815', level: 3, seed: [1, 1, 2, 3] });
  // The model is asked a request of two options or more, or of one it may leave (llm-player.mjs); the others are the
  // policy's and the coach says nothing.
  const asks = (q) => q.options.length >= 2 || (q.options.length === 1 && (q.minimum ?? 0) === 0);
  const seen = new Set();
  for (let i = 0; i < 600 && !(seen.has('play') || t.status.actor === null); i++) {
    const q = t.status.actor === 0 ? t.view.pending : null;
    if (q && !['prize', 'view-cards', 'guess-answer'].includes(q.kind) && (t.status.phase === 'setup' || asks(q))) {
      model.calls = [];
      const r = await t.post('coach', { revision: t.status.revision });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      const judged = t.status.phase === 'setup' ? ['choose-order', 'setup-active', 'setup-bench'].includes(q.kind) && asks(q) : true;
      assert.deepEqual(Object.keys(r.data.options).sort(), judged ? [...q.options].sort() : [], `${q.kind}: every option judged, by its id`);
      assert.equal(model.calls.length, Number(judged));
      if (judged) {
        assert.ok(Object.values(r.data.options).every((o) => /^第\d+项的理由$/.test(o.reason) && typeof o.choose === 'boolean'));
        if (q.kind === 'choose-order') assert.match(model.calls[0].text, /你赢得了先后攻的选择权。[\s\S]*0\. 先攻\n1\. 后攻/);
        if (q.kind === 'setup-active') assert.match(model.calls[0].text, /开局：从手牌里选1只基础宝可梦放到战斗场/);
      }
      seen.add(t.status.phase !== 'setup' ? 'play' : judged ? q.kind : `${q.kind} (the policy's)`);
      // Asked about a move instead, or about a request when there is none: no word.
      assert.deepEqual((await t.post('coach', { revision: t.status.revision, actions: [{ key: 'a0', action: { type: 'endTurn' } }] })).data, { revision: t.status.revision, moves: {} });
    } else if (t.status.actor === 0 && !q && t.status.phase !== 'setup' && !seen.has('none')) {
      assert.deepEqual((await t.post('coach', { revision: t.status.revision })).data, { revision: t.status.revision, options: {} });
      seen.add('none');
    }
    await t.step();
  }
  assert.deepEqual([...seen].filter((k) => !k.endsWith('(the policy\'s)')).sort(), ['choose-order', 'none', 'play', 'setup-active', 'setup-bench']);
});

test('a coach question the player moves on from is dropped, so the next position\'s is asked at once; each question is logged', async () => {
  const c = await signedIn('karen'), t = await start(c, { deck: 'raging-bolt-679141', opponent: 'dragapult-676815', level: 3 });
  while (t.status.actor !== 0 || t.view.pending || t.status.phase === 'setup' || !t.view.legalActions.some(quiet)) await t.step();
  logged.length = 0;
  model.hold = 60_000;
  const before = t.status.revision, first = t.post('coach', { revision: before, actions: keyed(t.view) });
  while (!model.held) await new Promise((ok) => setTimeout(ok, 5));
  const moved = await t.post('move', { revision: before, action: t.view.legalActions.find(quiet) });
  assert.equal(moved.data.quiet, true);
  assert.deepEqual((await first).data, { revision: before, stale: true }, 'The question about the position before is dropped.');
  assert.match(logged[0], new RegExp(`^Coach, match #${t.id} at revision ${before}: dropped after \\d+\\.\\d s, the player moved on$`));
  model.hold = 0;
  const started = Date.now(), next = await t.post('coach', { revision: t.status.revision, actions: keyed(t.view) });
  assert.equal(next.status, 200);
  assert.ok(Object.keys(next.data.moves).length > 0 && Date.now() - started < 10_000, 'The next position is judged without waiting for the one dropped.');
  assert.match(logged.at(-1), new RegExp(`^Coach, match #${t.id} at revision ${t.status.revision}: \\d+\\.\\d s, waited \\d+\\.\\d s, asked \\d+\\.\\d s after the last move; [\\d.]+k tokens in \\(\\d+% cached\\), \\d+ out \\(\\d+ reasoning\\)$`));
});

test('the checked 打法要点 of pool decks are served to signed-in players', async () => {
  const c = await signedIn('karen');
  const { decks } = (await c.call('/api/playbooks')).data;
  assert.ok(decks.includes('raging-bolt-679141') && decks.includes('dragapult-676815'));
  const { playbook } = (await c.call('/api/playbooks?deck=raging-bolt-679141')).data;
  assert.equal(playbook.deck, 'raging-bolt-679141');
  assert.equal(playbook.sections[0].title, '总体思路');
  // (A point worked out from the card texts alone may have no source.)
  assert.ok(playbook.sections.every((s) => s.points.every((x) => x.text && Array.isArray(x.src))));
  assert.ok(playbook.sections.flatMap((s) => s.points).filter((x) => x.src.length).length > 50);
  assert.equal((await c.call('/api/playbooks?deck=no-such-deck')).status, 404);
  assert.equal((await c.call('/api/playbooks?deck=constructor')).status, 404);
  const anonymous = await fetch(`${base}/api/playbooks`);
  assert.equal(anonymous.status, 401);
});

test('a player\'s copy of a pool deck without a 打法说明 plays with the pool deck\'s playbook', async () => {
  const c = await signedIn('wallace');
  const bolt = meta.decks.find((d) => d.id === 'raging-bolt-679141');
  const saved = await c.call('/api/decks', { method: 'POST', body: { name: '猛雷鼓（副本）', format: 'standard', cards: bolt.cards } });
  const t = await start(c, { deck: 'dragapult-676815', opponent: `user:${saved.data.deck.id}`, level: 6 });
  model.calls = [];
  while (!model.calls.length && t.status.actor !== null) await t.step();
  assert.match(model.calls[0].system, /「猛雷鼓（副本）」/);
  assert.match(model.calls[0].system, /已和这份卡表、卡面逐条核对/);
});
