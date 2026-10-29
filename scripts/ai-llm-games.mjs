// A deck played by a language model (ai/llm-player.mjs: what it is asked and when the policy answers instead) against
// an AI level, to compare with the levels (docs/ai/STATUS.md M7; the user asked how 猛雷鼓 does when the model is given
// the deck's strategy and the position). Games run in worker threads, each game's questions one after another.
// Tokens are counted as the service reports them (prompt, of which cached, and completion, of which reasoning), to cost
// a model and effort: --model is the deployment, --env the env file of its resource (ai/foundry.mjs).
//   node scripts/ai-llm-games.mjs --deck raging-bolt-679141 --against dragapult-676815,charizard-pidgeot-690939
//     [--opponent level:4] [--games 2] (per opponent, both seats) [--workers 8] [--model gpt-6-astra] [--env <file>]
//     [--effort high] [--seed 0] [--out /tmp/llm-games] [--alone] (every question on its own, not one conversation)
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Simulation, createReviewedGame } from '../public/rules/engine.js';
import { loadRelease } from '../server/catalog.mjs';
import { RULESET } from '../catalog/zh-CN/V20261019/index.mjs';
import { DECK_POOL, poolDeckList } from '../ai/decks.mjs';
import { makeAgent } from '../ai/agents.mjs';
import { playSafely, stepCounter, TURN_STEP_LIMIT } from '../ai/play.mjs';
import { describer } from '../ai/describe.mjs';
import { llmPlayer } from '../ai/llm-player.mjs';

const FORMAT = Object.freeze({ ...RULESET, id: 'open' });

async function playOne(release, job) {
  const { deck, against, opponent, seed, focalFirst, effort, out, model, env, alone } = job;
  // (Also written as it goes, to follow a game.)
  const live = `${out}/${against}-${seed}-${focalFirst ? 'first' : 'second'}.live.txt`;
  writeFileSync(live, '');
  const ids = focalFirst ? [deck, against] : [against, deck], focal = focalFirst ? 0 : 1;
  const { game, catalog } = await createReviewedGame({ release, decks: ids.map(poolDeckList), seed: [seed + 1, 3, 5, 7], format: FORMAT, matchMode: 'normal' });
  const sim = new Simulation(game.snapshot(), catalog), say = describer(catalog);
  const foe = makeAgent(opponent, catalog, [seed + 10, 2, 3, 4]);
  const pilot = llmPlayer(sim, catalog, focal, { deck, model, effort, env, seed, session: !alone });
  const count = stepCounter(), rng = [seed, 9, 9, 9], log = [];
  let turn = null;
  for (let me, steps = 0; (me = sim.actor) !== null && steps < 3000 && !sim.state.result; steps++) {
    const n = count(sim, me);
    if (n >= TURN_STEP_LIMIT) break;
    if (sim.state.phase !== 'setup' && sim.state.turn !== turn) {
      turn = sim.state.turn;
      log.push(`== 第${turn}回合（${sim.state.current === focal ? '模型' : '对手'}）==`);
      appendFileSync(live, `${log.at(-1)}\n`);
    }
    const view = sim.view(me), { action, by, reason } = me === focal ? await pilot.decide(n) : { action: foe.decide(sim, me, n), by: 'foe' };
    const before = JSON.stringify(action), played = playSafely(sim, me, action, rng);
    if (by === 'llm' && JSON.stringify(played) !== before) pilot.stats.refused++;
    const text = played.type === 'answer' ? say.answer(view, view.pending, played.selected) : say.move(view, me, played);
    pilot.played(me, played, view);
    log.push(`- ${me === focal ? '模型' : '对手'}：${text}${by === 'llm' ? `  〔${reason ?? ''}〕` : by === 'policy' ? '  （策略）' : ''}`);
    appendFileSync(live, `${log.at(-1)}\n`);
  }
  const r = sim.state.result, won = r ? (r.draw ? 0.5 : Number(r.winner === focal)) : 0.5;
  const prizes = (i) => sim.state.players[i].prizes.length;
  return { won, reason: r?.reason ?? 'unfinished', stats: pilot.stats, turns: sim.state.turn, prizesLeft: [prizes(focal), prizes(1 - focal)], log: log.join('\n') };
}

if (isMainThread) {
  const { values } = parseArgs({ options: { deck: { type: 'string' }, against: { type: 'string' }, opponent: { type: 'string', default: 'level:4' },
    games: { type: 'string', default: '2' }, workers: { type: 'string', default: '8' }, effort: { type: 'string', default: 'high' },
    model: { type: 'string', default: 'gpt-6-astra' }, env: { type: 'string' }, alone: { type: 'boolean', default: false },
    seed: { type: 'string', default: '0' }, out: { type: 'string', default: '/tmp/llm-games' } } });
  const opponents = (values.against ?? '').split(',').filter(Boolean);
  if (!DECK_POOL[values.deck] || !opponents.length || opponents.some((o) => !DECK_POOL[o])) throw new Error('Usage: --deck <pool id> --against <pool id>,…');
  const jobs = opponents.flatMap((against) => Array.from({ length: Number(values.games) }, (_, g) => ({ deck: values.deck, against,
    opponent: values.opponent, effort: values.effort, model: values.model, env: values.env, alone: values.alone, out: values.out, seed: Number(values.seed) + (g >> 1), focalFirst: g % 2 === 0 })));
  mkdirSync(values.out, { recursive: true });
  const workers = Math.min(jobs.length, Number(values.workers)), results = [];
  const t0 = Date.now();
  await Promise.all(Array.from({ length: workers }, (_, i) => new Promise((resolve, reject) => {
    new Worker(new URL(import.meta.url), { workerData: jobs.filter((_, g) => g % workers === i) })
      .on('message', (r) => {
        results.push(r);
        writeFileSync(`${values.out}/${r.against}-${r.seed}-${r.focalFirst ? 'first' : 'second'}.txt`, r.log ?? r.error ?? '');
        console.log(`${r.against} seed ${r.seed} ${r.focalFirst ? 'first' : 'second'}: ${r.won === 1 ? 'won' : r.won === 0 ? 'lost' : 'draw'} (${r.reason}${r.prizesLeft ? `, Prizes left ${r.prizesLeft.join(':')}, turn ${r.turns}` : ''})` +
          (r.stats ? `; asked ${r.stats.asked}, policy ${r.stats.policy}, refused ${r.stats.refused}, bad ${r.stats.bad}, ${(r.stats.ms / Math.max(1, r.stats.asked) / 1000).toFixed(1)} s an answer, ${r.stats.tokens} tokens` : ''));
      }).on('error', reject).on('exit', resolve);
  })));
  for (const against of opponents) {
    const rs = results.filter((r) => r.against === against && !r.error), w = rs.reduce((a, r) => a + r.won, 0);
    console.log(`${values.deck} (${values.model}) vs ${against} (${values.opponent}): ${w}/${rs.length} = ${rs.length ? (100 * w / rs.length).toFixed(1) : '-'}%`);
  }
  const ok = results.filter((r) => r.stats), sum = (k) => ok.reduce((a, r) => a + r.stats[k], 0), per = (k) => Math.round(sum(k) / Math.max(1, ok.length));
  console.log(`${values.model} (${values.effort}): ${ok.reduce((a, r) => a + r.won, 0)}/${ok.length} won; per game ${per('asked')} questions, ` +
    `${(sum('ms') / Math.max(1, sum('asked')) / 1000).toFixed(1)} s an answer, prompt ${per('prompt')} (cached ${per('cached')}, cache writes ${per('written')}), completion ${per('completion')} (reasoning ${per('reasoning')}) tokens; ` +
    `mean Prizes left ${(ok.reduce((a, r) => a + r.prizesLeft[0], 0) / Math.max(1, ok.length)).toFixed(2)}:${(ok.reduce((a, r) => a + r.prizesLeft[1], 0) / Math.max(1, ok.length)).toFixed(2)}`);
  writeFileSync(`${values.out}/summary.json`, `${JSON.stringify({ model: values.model, effort: values.effort, games: ok.map(({ log, ...r }) => r) }, null, 1)}\n`);
  console.log(`errors ${results.filter((r) => r.error).length}; ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  process.exit(0);
} else {
  const release = await loadRelease();
  for (const job of workerData) {
    try { parentPort.postMessage({ ...job, ...(await playOne(release, job)) }); } catch (error) { parentPort.postMessage({ ...job, won: 0.5, error: String(error.stack ?? error).slice(0, 500) }); }
  }
}
