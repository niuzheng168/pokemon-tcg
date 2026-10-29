// Language models playing each other (ai/llm-player.mjs on both seats), to rank models and reasoning efforts for the AI
// levels (docs/ai/STATUS.md M7; the user asked for both sides to be models). Every pair of players plays every deal
// four times: each player with each deck of the matchup, each deck in each seat, so neither the deck nor the deal nor the
// seat favours one of them. Games run in worker threads, handed out one at a time, the pairs interleaved so the early
// games already cover every pair; the ranking is a Bradley–Terry fit of all games (a draw half a win each).
//   node scripts/ai-llm-duel.mjs --players astra-medium=gpt-6-astra:medium,sol-low=gpt-6.1-sol:low
//     [--matchups raging-bolt-679141:dragapult-676815,charizard-pidgeot-690939:gardevoir-693228] [--seeds 1]
//     [--env ~/.config/codey-machine/copilot.env] [--workers 16] [--out /tmp/llm-duel]
// A player is name=model:effort, or name=model:effort@envfile for one on another service; name=model:effort:alone asks
// every question on its own instead of in one conversation for the game (ai/llm-player.mjs).
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { writeFileSync, mkdirSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { Simulation, createReviewedGame } from '../public/rules/engine.js';
import { loadRelease } from '../server/catalog.mjs';
import { RULESET } from '../catalog/zh-CN/V20261019/index.mjs';
import { DECK_POOL, poolDeckList } from '../ai/decks.mjs';
import { playSafely, stepCounter, TURN_STEP_LIMIT } from '../ai/play.mjs';
import { describer } from '../ai/describe.mjs';
import { llmPlayer } from '../ai/llm-player.mjs';

const FORMAT = Object.freeze({ ...RULESET, id: 'open' });
const short = (deck) => deck.replace(/-\d+$/, '');

async function playOne(release, job) {
  const { decks, players, seed, file } = job;
  writeFileSync(`${file}.live.txt`, '');
  const { game, catalog } = await createReviewedGame({ release, decks: decks.map(poolDeckList), seed: [seed + 1, 3, 5, 7], format: FORMAT, matchMode: 'normal' });
  const sim = new Simulation(game.snapshot(), catalog), say = describer(catalog);
  const seats = players.map((p, i) => llmPlayer(sim, catalog, i, { deck: decks[i], model: p.model, effort: p.effort, env: p.env, session: p.session !== false, seed: seed + 100 * i }));
  const count = stepCounter(), rng = [seed, 9, 9, 9], log = [];
  const note = (line) => { log.push(line); appendFileSync(`${file}.live.txt`, `${line}\n`); };
  let turn = null;
  for (let me, steps = 0; (me = sim.actor) !== null && steps < 4000 && !sim.state.result; steps++) {
    const n = count(sim, me);
    if (n >= TURN_STEP_LIMIT) break;
    if (sim.state.phase !== 'setup' && sim.state.turn !== turn) note(`== 第${(turn = sim.state.turn)}回合（${players[sim.state.current].name}）==`);
    const view = sim.view(me), { action, by, reason } = await seats[me].decide(n);
    const before = JSON.stringify(action), played = playSafely(sim, me, action, rng);
    if (by === 'llm' && JSON.stringify(played) !== before) seats[me].stats.refused++;
    const text = played.type === 'answer' ? say.answer(view, view.pending, played.selected) : say.move(view, me, played);
    seats.forEach((s) => s.played(me, played, view));
    note(`- ${players[me].name}：${text}${by === 'llm' ? `  〔${reason ?? ''}〕` : '  （策略）'}`);
  }
  const r = sim.state.result, prizes = (i) => sim.state.players[i].prizes.length;
  return { winner: r && !r.draw ? r.winner : null, reason: r?.reason ?? 'unfinished', turns: sim.state.turn, prizesLeft: [prizes(0), prizes(1)],
    first: sim.state.first ?? null, stats: seats.map((s) => s.stats), log: log.join('\n') };
}

/** Bradley–Terry strengths (geometric mean 1) from games { a, b, score of a }: the MM iteration. */
function bradleyTerry(names, games) {
  const s = Object.fromEntries(names.map((n) => [n, 1]));
  for (let it = 0; it < 500; it++) {
    for (const n of names) {
      let wins = 0, denom = 0;
      for (const g of games) {
        if (g.a !== n && g.b !== n) continue;
        const o = g.a === n ? g.b : g.a;
        wins += g.a === n ? g.score : 1 - g.score;
        denom += 1 / (s[n] + s[o]);
      }
      // (And one game drawn against a player of strength 1: no player at 0 or ∞ after all wins or all losses.)
      s[n] = (wins + 0.5) / (denom + 1 / (s[n] + 1));
    }
    const g = Math.exp(names.reduce((a, n) => a + Math.log(s[n]), 0) / names.length);
    for (const n of names) s[n] /= g;
  }
  return s;
}

if (isMainThread) {
  const { values } = parseArgs({ options: { players: { type: 'string' },
    matchups: { type: 'string', default: 'raging-bolt-679141:dragapult-676815,charizard-pidgeot-690939:gardevoir-693228' },
    seeds: { type: 'string', default: '1' }, seed: { type: 'string', default: '0' }, workers: { type: 'string', default: '16' },
    env: { type: 'string', default: `${homedir()}/.config/codey-machine/copilot.env` }, out: { type: 'string', default: '/tmp/llm-duel' } } });
  const players = (values.players ?? '').split(',').filter(Boolean).map((spec) => {
    const [, name, model, effort, alone, env] = spec.match(/^([^=]+)=([^:]+):([a-z]+)(:alone)?(?:@(.+))?$/) ?? [];
    if (!name) throw new Error(`Bad player ${spec}: name=model:effort[@envfile]`);
    return { name, model, effort, session: !alone, env: env ?? values.env };
  });
  const matchups = values.matchups.split(',').map((m) => m.split(':'));
  if (players.length < 2 || matchups.some((m) => m.length !== 2 || m.some((d) => !DECK_POOL[d]))) throw new Error('Usage: --players a=model:effort,b=… [--matchups deck:deck,…]');
  mkdirSync(values.out, { recursive: true });
  // Games already in the out directory (a run stopped and started again) are not played again.
  const jobs = [];
  for (let k = 0; k < Number(values.seeds); k++) for (const [x, y] of matchups) for (const decks of [[x, y], [y, x]]) for (const flip of [0, 1])
    for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) {
      const pair = flip ? [players[j], players[i]] : [players[i], players[j]], seed = Number(values.seed) + k;
      const file = `${values.out}/${pair[0].name}-vs-${pair[1].name}_${short(decks[0])}-vs-${short(decks[1])}_${seed}`;
      jobs.push({ decks, players: pair, seed, file });
    }
  const errors = [], results = jobs.filter((j) => existsSync(`${j.file}.json`)).map((j) => JSON.parse(readFileSync(`${j.file}.json`, 'utf8')));
  const queue = jobs.filter((j) => !existsSync(`${j.file}.json`));
  console.log(`${jobs.length} games, ${results.length} already played`);
  const t0 = Date.now();
  const line = (r) => `${r.players[0].name} (${short(r.decks[0])}) vs ${r.players[1].name} (${short(r.decks[1])}) seed ${r.seed}: ` +
    (r.error ? `error ${r.error.split('\n')[0]}` : `${r.winner === null ? 'draw' : `${r.players[r.winner].name} won`} (${r.reason}, Prizes left ${r.prizesLeft.join(':')}, turn ${r.turns}); ` +
      r.stats.map((s, i) => `${r.players[i].name} ${s.asked} asked ${(s.ms / Math.max(1, s.asked) / 1000).toFixed(1)} s`).join(', '));
  await Promise.all(Array.from({ length: Math.min(queue.length, Number(values.workers)) }, () => new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url));
    const next = () => worker.postMessage(queue.shift() ?? null);
    worker.on('message', (r) => {
      if (r !== 'ready') {
        if (r.error) errors.push(r); else { const { log, ...rest } = r; writeFileSync(`${r.file}.txt`, log); writeFileSync(`${r.file}.json`, `${JSON.stringify(rest)}\n`); results.push(rest); }
        console.log(`[${((Date.now() - t0) / 60000).toFixed(0)} min, ${results.length}/${jobs.length}] ${line(r)}`);
      }
      next();
    }).on('error', reject).on('exit', resolve);
  })));
  // Each game once from each player's side: the score of `a` against `b`.
  const names = players.map((p) => p.name), games = results.map((r) => ({ a: r.players[0].name, b: r.players[1].name, score: r.winner === null ? 0.5 : Number(r.winner === 0) }));
  const strength = bradleyTerry(names, games);
  const of = (n) => results.flatMap((r) => r.players.map((p, i) => (p.name === n ? { r, i } : null)).filter(Boolean));
  const table = names.map((n) => {
    const mine = of(n), won = mine.reduce((a, { r, i }) => a + (r.winner === null ? 0.5 : Number(r.winner === i)), 0);
    const sum = (k) => mine.reduce((a, { r, i }) => a + r.stats[i][k], 0), per = (k) => Math.round(sum(k) / Math.max(1, mine.length));
    return { name: n, ...players.find((p) => p.name === n), env: undefined, games: mine.length, won, rate: mine.length ? won / mine.length : null,
      elo: Math.round(400 * Math.log10(strength[n])), sPerAnswer: sum('ms') / Math.max(1, sum('asked')) / 1000,
      perGame: { asked: per('asked'), prompt: per('prompt'), cached: per('cached'), written: per('written'), completion: per('completion'), reasoning: per('reasoning'), policy: per('policy'), bad: per('bad') } };
  }).sort((a, b) => b.elo - a.elo);
  console.log('\nRanking (Bradley–Terry, Elo scale, mean 0):');
  for (const t of table) console.log(`${t.name.padEnd(16)} Elo ${String(t.elo).padStart(5)}  ${t.won}/${t.games} = ${t.rate == null ? '-' : (100 * t.rate).toFixed(1)}%  ` +
    `${t.sPerAnswer.toFixed(1)} s an answer, per game ${t.perGame.asked} questions, prompt ${t.perGame.prompt} (cached ${t.perGame.cached}), completion ${t.perGame.completion} (reasoning ${t.perGame.reasoning})`);
  console.log('\nHead to head (row player\'s wins):');
  for (const a of names) console.log(`${a.padEnd(16)} ${names.map((b) => {
    if (a === b) return '   -  ';
    const gs = games.filter((g) => (g.a === a && g.b === b) || (g.a === b && g.b === a)), w = gs.reduce((x, g) => x + (g.a === a ? g.score : 1 - g.score), 0);
    return `${String(w).padStart(4)}/${gs.length}`;
  }).join(' ')}`);
  writeFileSync(`${values.out}/summary.json`, `${JSON.stringify({ players, matchups, table, games: results.map(({ file, ...r }) => r) }, null, 1)}\n`);
  console.log(`errors ${errors.length} (played again when started again); ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  process.exit(0);
} else {
  const release = await loadRelease();
  parentPort.on('message', async (job) => {
    if (!job) { process.exit(0); }
    try { parentPort.postMessage({ ...job, ...(await playOne(release, job)) }); } catch (error) { parentPort.postMessage({ ...job, error: String(error.stack ?? error).slice(0, 500) }); }
  });
  parentPort.postMessage('ready');
}
