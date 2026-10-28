// A deck played by a language model (gpt-6-astra, ai/foundry.mjs) against an AI level, to compare with the levels
// (docs/ai/STATUS.md M7; the user asked how 猛雷鼓 does when the model is given the deck's strategy and the position).
// At each of its decisions the model gets: the deck's written strategy and guide points and its own list with every
// card's text (the same in every question), then the position as its player sees it (describe.mjs; both discard piles;
// the opponent only by what it has shown), the moves of this turn and the opponent's last turn, and the numbered legal
// moves or a request's options; it answers a number (or several). Requests with one option or of the kinds the policy
// answers alone, a turn of more than 30 asks, and any answer the rules refuse are the policy's (counted). Games run in
// worker threads, each game's questions one after another.
//   node scripts/ai-llm-games.mjs --deck raging-bolt-679141 --against dragapult-676815,charizard-pidgeot-690939
//     [--opponent level:4] [--games 2] (per opponent, both seats) [--workers 8] [--effort high] [--seed 0] [--out /tmp/llm-games]
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Simulation, createReviewedGame } from '../public/rules/engine.js';
import { loadRelease } from '../server/catalog.mjs';
import { RULESET } from '../catalog/zh-CN/V20261019/index.mjs';
import { DECK_POOL, poolDeckList } from '../ai/decks.mjs';
import { makeAgent } from '../ai/agents.mjs';
import { createPolicy } from '../ai/policy.mjs';
import { planFor } from '../ai/deck-plan.mjs';
import { playSafely, stepCounter, TURN_STEP_LIMIT } from '../ai/play.mjs';
import { describer } from '../ai/describe.mjs';
import { moveKey } from '../ai/search.mjs';
import { askJSON } from '../ai/foundry.mjs';

const FORMAT = Object.freeze({ ...RULESET, id: 'open' });
// Requests the policy answers alone (search.mjs SIMPLE_REQUESTS and the like).
const SIMPLE = new Set(['view-cards', 'counter-allocation', 'guess-answer', 'janken', 'coin-face', 'choose-order', 'mulligan-bonus', 'prize']);

const SYSTEM = `你是简体中文宝可梦集换式卡牌游戏（PTCG）的顶尖选手，正在实战中驾驶一副卡组。每次给你当前局面（你看得到的信息）和可选的走法，你选出最有可能赢下这局的一个。
只根据给出的卡牌说明判断效果；对手的手牌、牌库和奖赏卡你看不到，只能根据对手已经亮出的牌推断。
一个回合里会多次问你，每次只选下一步；"本回合你已经做了"列出了这一回合之前的走法。要把整个回合想清楚（先检索、贴能、进化，最后攻击；攻击会结束回合）。
只输出一个 JSON 对象：{"choice": 编号, "reason": "一句话"}；要选多个时 "choice" 是编号数组。`;

async function playOne(release, job) {
  const { deck, against, opponent, seed, focalFirst, effort, out } = job;
  // (Also written as it goes, to follow a game.)
  const live = `${out}/${against}-${seed}-${focalFirst ? 'first' : 'second'}.live.txt`;
  writeFileSync(live, '');
  const ids = focalFirst ? [deck, against] : [against, deck], focal = focalFirst ? 0 : 1;
  const { game, catalog } = await createReviewedGame({ release, decks: ids.map(poolDeckList), seed: [seed + 1, 3, 5, 7], format: FORMAT, matchMode: 'normal' });
  const sim = new Simulation(game.snapshot(), catalog), say = describer(catalog), def = (id) => catalog.definition(id);
  const foe = makeAgent(opponent, catalog, [seed + 10, 2, 3, 4]);
  const policy = createPolicy(catalog, { seed: [seed, 7, 7, 7], plans: (p) => planFor(catalog, sim.state, p) });
  const strategies = JSON.parse(readFileSync(new URL('../ai/deck-strategies.json', import.meta.url), 'utf8')).decks;
  const guides = JSON.parse(readFileSync(new URL('../ai/deck-guides.json', import.meta.url), 'utf8')).decks;
  // The same at the head of every question (a long shared prefix the service may cache): strategy, guide, own list.
  const own = [...new Map(Object.values(sim.state.cards).filter((c) => c.owner === focal).map((c) => [c.printingId, c])).values()];
  const counts = new Map();
  for (const c of Object.values(sim.state.cards)) if (c.owner === focal) counts.set(def(c.definitionId).name, (counts.get(def(c.definitionId).name) ?? 0) + 1);
  const head = [`你的卡组：「${DECK_POOL[deck].name}」。卡表：${[...counts].map(([n, k]) => `${n}×${k}`).join('、')}`,
    `这副卡组的打法（大模型根据卡面和网上攻略写的）：${JSON.stringify(strategies[deck]?.strategy ?? {})}`,
    guides[deck] ? `网上攻略要点：${JSON.stringify(guides[deck].points)}` : '',
    `你卡组里每张卡的说明：\n${[...new Map(own.map((c) => [def(c.definitionId).name, c])).values()].map((c) => `- ${say.cardText(c)}`).join('\n')}`].filter(Boolean).join('\n\n');
  const count = stepCounter(), rng = [seed, 9, 9, 9], log = [], stats = { asked: 0, policy: 0, refused: 0, bad: 0, ms: 0, tokens: 0 };
  let turn = null, thisTurn = [], lastFoe = [], asksThisTurn = 0;
  const grouped = (cards) => { const n = new Map(); for (const c of cards) n.set(def(c.definitionId).name, (n.get(def(c.definitionId).name) ?? 0) + 1);
    return [...n].map(([k, v]) => (v > 1 ? `${k}×${v}` : k)).join('、') || '无'; };
  const ask = async (view, header, options, multi) => {
    const discard = (i) => grouped(Array.isArray(view.players[i].discard) ? view.players[i].discard : []);
    const user = `${head}\n\n== 当前局面 ==\n${say.state(view, focal)}\n你的弃牌区：${discard(focal)}\n对手的弃牌区：${discard(1 - focal)}\n` +
      `对手上一回合：${lastFoe.join('；') || '（无）'}\n本回合你已经做了：${thisTurn.join('；') || '（还没有）'}\n\n${header}\n` +
      options.map((t, i) => `${i}. ${t}`).join('\n') + `\n\n${multi ? `选择 ${multi.min}–${multi.max} 个，"choice" 为编号数组。` : '选择一个编号。'}`;
    const t0 = Date.now(), { json, usage } = await askJSON(SYSTEM, user, { effort });
    stats.asked++; stats.ms += Date.now() - t0; stats.tokens += usage?.total_tokens ?? 0;
    return json;
  };
  async function decide(me, n) {
    const view = sim.view(me), q = view.pending;
    if (me !== focal) return { action: foe.decide(sim, me, n), by: 'foe' };
    const fallback = () => { stats.policy++; return { action: policy(view, me, n), by: 'policy' }; };
    if (sim.state.phase === 'setup' || asksThisTurn >= 30 || n > 60) return fallback();
    if (q) {
      if (SIMPLE.has(q.kind) || !q.options?.length || q.options.length < 2 && (q.minimum ?? 0) >= 1) return fallback();
      const texts = q.options.map((id) => say.answer(view, q, [id]).replace(/^（[^）]*）选择：/, ''));
      const source = q.effect?.sourceId && sim.state.cards[q.effect.sourceId] ? `「${def(sim.state.cards[q.effect.sourceId].definitionId).name}」` : '';
      const max = Math.min(q.maximum ?? q.minimum ?? 1, q.options.length), min = q.minimum ?? 0, multi = max > 1 ? { min, max } : null;
      asksThisTurn++;
      const json = await ask(view, `现在要回答${source}的选择（${q.kind}）：`, texts, multi ?? (min === 0 ? { min: 0, max: 1 } : null));
      const picked = [].concat(json.choice ?? []).map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < q.options.length);
      if (picked.length < min || picked.length > Math.max(max, 1) || new Set(picked).size !== picked.length) { stats.bad++; return fallback(); }
      return { action: { type: 'answer', requestId: q.id, selected: picked.map((i) => q.options[i]) }, by: 'llm', reason: json.reason };
    }
    const moves = new Map();
    for (const a of view.legalActions.filter((x) => x.type !== 'concede')) { const t = say.move(view, me, a); if (!moves.has(t)) moves.set(t, a); }
    if (moves.size <= 1) return fallback();
    asksThisTurn++;
    const list = [...moves], json = await ask(view, '现在可以走的：', list.map(([t]) => t), null);
    const i = Number([].concat(json.choice)[0]);
    if (!Number.isInteger(i) || i < 0 || i >= list.length) { stats.bad++; return fallback(); }
    return { action: list[i][1], by: 'llm', reason: json.reason };
  }
  for (let me, steps = 0; (me = sim.actor) !== null && steps < 3000 && !sim.state.result; steps++) {
    const n = count(sim, me);
    if (n >= TURN_STEP_LIMIT) break;
    if (sim.state.phase !== 'setup' && sim.state.turn !== turn) {
      turn = sim.state.turn;
      if (sim.state.current === focal) { asksThisTurn = 0; thisTurn = []; } else lastFoe = [];
      log.push(`== 第${turn}回合（${sim.state.current === focal ? '模型' : '对手'}）==`);
      appendFileSync(live, `${log.at(-1)}\n`);
    }
    const view = sim.view(me), { action, by, reason } = await decide(me, n);
    const before = JSON.stringify(action), played = playSafely(sim, me, action, rng);
    if (by === 'llm' && JSON.stringify(played) !== before) stats.refused++;
    const text = played.type === 'answer' ? say.answer(view, view.pending, played.selected) : say.move(view, me, played);
    if (me === focal) thisTurn.push(text); else if (sim.state.phase !== 'setup') lastFoe.push(text);
    log.push(`- ${me === focal ? '模型' : '对手'}：${text}${by === 'llm' ? `  〔${reason ?? ''}〕` : by === 'policy' ? '  （策略）' : ''}`);
    appendFileSync(live, `${log.at(-1)}\n`);
  }
  const r = sim.state.result, won = r ? (r.draw ? 0.5 : Number(r.winner === focal)) : 0.5;
  return { won, reason: r?.reason ?? 'unfinished', stats, log: log.join('\n') };
}

if (isMainThread) {
  const { values } = parseArgs({ options: { deck: { type: 'string' }, against: { type: 'string' }, opponent: { type: 'string', default: 'level:4' },
    games: { type: 'string', default: '2' }, workers: { type: 'string', default: '8' }, effort: { type: 'string', default: 'high' },
    seed: { type: 'string', default: '0' }, out: { type: 'string', default: '/tmp/llm-games' } } });
  const opponents = (values.against ?? '').split(',').filter(Boolean);
  if (!DECK_POOL[values.deck] || !opponents.length || opponents.some((o) => !DECK_POOL[o])) throw new Error('Usage: --deck <pool id> --against <pool id>,…');
  const jobs = opponents.flatMap((against) => Array.from({ length: Number(values.games) }, (_, g) => ({ deck: values.deck, against,
    opponent: values.opponent, effort: values.effort, out: values.out, seed: Number(values.seed) + (g >> 1), focalFirst: g % 2 === 0 })));
  mkdirSync(values.out, { recursive: true });
  const workers = Math.min(jobs.length, Number(values.workers)), results = [];
  const t0 = Date.now();
  await Promise.all(Array.from({ length: workers }, (_, i) => new Promise((resolve, reject) => {
    new Worker(new URL(import.meta.url), { workerData: jobs.filter((_, g) => g % workers === i) })
      .on('message', (r) => {
        results.push(r);
        writeFileSync(`${values.out}/${r.against}-${r.seed}-${r.focalFirst ? 'first' : 'second'}.txt`, r.log ?? r.error ?? '');
        console.log(`${r.against} seed ${r.seed} ${r.focalFirst ? 'first' : 'second'}: ${r.won === 1 ? 'won' : r.won === 0 ? 'lost' : 'draw'} (${r.reason})` +
          (r.stats ? `; asked ${r.stats.asked}, policy ${r.stats.policy}, refused ${r.stats.refused}, bad ${r.stats.bad}, ${(r.stats.ms / Math.max(1, r.stats.asked) / 1000).toFixed(1)} s an answer, ${r.stats.tokens} tokens` : ''));
      }).on('error', reject).on('exit', resolve);
  })));
  for (const against of opponents) {
    const rs = results.filter((r) => r.against === against && !r.error), w = rs.reduce((a, r) => a + r.won, 0);
    console.log(`${values.deck} (gpt-6-astra) vs ${against} (${values.opponent}): ${w}/${rs.length} = ${rs.length ? (100 * w / rs.length).toFixed(1) : '-'}%`);
  }
  console.log(`errors ${results.filter((r) => r.error).length}; ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  process.exit(0);
} else {
  const release = await loadRelease();
  for (const job of workerData) {
    try { parentPort.postMessage({ ...job, ...(await playOne(release, job)) }); } catch (error) { parentPort.postMessage({ ...job, won: 0.5, error: String(error.stack ?? error).slice(0, 500) }); }
  }
}
