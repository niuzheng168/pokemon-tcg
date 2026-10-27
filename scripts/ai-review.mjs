// Lost games reviewed by a language model (the trio work, docs/ai/STATUS.md M7). Plays one deck against another (both
// seats, each deal once), writes the games the deck lost as transcripts — at each of its turns the position it saw
// (ai/describe.mjs) and every move it made, with the opponent's moves between — and, with --review, sends each to
// gpt-6-astra (ai/foundry.mjs) with the deck's written strategy and its guide points, asking for the decisive mistakes
// and the rules that would have avoided them. The answers are suggestions for a person to turn into rules and test.
//   node scripts/ai-review.mjs --deck <pool id> --against <pool id> [--agent policy:0] [--opponent policy:0] [--games 20]
//     [--review 6] [--out /tmp/review]
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Simulation, createReviewedGame } from '../public/rules/engine.js';
import { loadRelease } from '../server/catalog.mjs';
import { RULESET } from '../catalog/zh-CN/V20261019/index.mjs';
import { DECK_POOL, poolDeckList } from '../ai/decks.mjs';
import { makeAgent } from '../ai/agents.mjs';
import { playSafely, stepCounter, TURN_STEP_LIMIT } from '../ai/play.mjs';
import { describer } from '../ai/describe.mjs';

const FORMAT = Object.freeze({ ...RULESET, id: 'open' });

// One game, recorded from `focal`'s side: { won, reason, text }.
async function record(release, { deck, against, agent, opponent, seed, focalFirst }) {
  const ids = focalFirst ? [deck, against] : [against, deck], focal = focalFirst ? 0 : 1;
  const { game, catalog } = await createReviewedGame({ release, decks: ids.map(poolDeckList), seed: [seed + 1, 3, 5, 7], format: FORMAT, matchMode: 'normal' });
  const sim = new Simulation(game.snapshot(), catalog), say = describer(catalog);
  const agents = [0, 1].map((p) => makeAgent(p === focal ? agent : opponent, catalog, [seed + 10 * p, 2, 3, 4]));
  const def = (id) => catalog.definition(id), count = stepCounter(), rng = [seed, 9, 9, 9], lines = [];
  // A request's answer: the names of the cards or Pokémon chosen (other options as they are).
  const answerText = (view, q, selected) => {
    const cards = [...(view.players.flatMap((p) => [...(Array.isArray(p.hand) ? p.hand : []), ...(Array.isArray(p.discard) ? p.discard : [])])),
      ...(q.cards ?? []), ...(q.lookedAt ?? []), ...(q.energy ?? []).map((e) => e.card)];
    const mons = view.players.flatMap((p) => [p.active, ...p.bench].filter(Boolean));
    const paid = new Map((q.payment?.groups ?? []).flatMap((g) => g.choices).map((c) => [c.optionId, c.card]));
    const name = (id) => { const c = paid.get(id) ?? cards.find((x) => x.instanceId === id), m = mons.find((x) => x.id === id);
      return c ? def(c.definitionId).name : m ? def(m.stack.at(-1).definitionId).name : String(id); };
    return `（${q.kind}）选择：${(selected ?? []).map(name).join('、') || '无'}`;
  };
  let turn = null;
  for (let me, steps = 0; (me = sim.actor) !== null && steps < 3000; steps++) {
    const n = count(sim, me);
    if (n >= TURN_STEP_LIMIT) break;
    const view = sim.view(me);
    if (sim.state.phase !== 'setup' && sim.state.turn !== turn) {
      turn = sim.state.turn;
      lines.push('', sim.state.current === focal ? `== 第${turn}回合（你）==\n${say.state(sim.view(focal), focal).split('\n卡牌说明：')[0]}` : `== 第${turn}回合（对手）==`);
    }
    const played = playSafely(sim, me, agents[me].decide(sim, me, n), rng);
    if (sim.state.phase === 'setup' && !turn) continue;
    const who = me === focal ? '你' : '对手';
    lines.push(`- ${who}：${played.type === 'answer' ? answerText(view, view.pending, played.selected) : say.move(view, me, played)}`);
  }
  const r = sim.state.result, won = r ? (r.draw ? 0.5 : Number(r.winner === focal)) : 0.5;
  // The cards of both lists once, at the top.
  const seen = new Map();
  for (const c of Object.values(sim.state.cards)) if (!seen.has(c.printingId)) seen.set(c.printingId, c);
  const head = [`对局：你用「${DECK_POOL[deck].name}」，对手用「${DECK_POOL[against].name}」；你是${focalFirst ? '先攻' : '后攻'}；` +
    `结果：${won === 1 ? '赢' : won === 0 ? '输' : '平'}（${r?.reason ?? '未结束'}）。`, '卡牌说明：', ...[...seen.values()].map((c) => `- ${say.cardText(c).replace(/\s*\n\s*/g, ' ')}`)];
  return { won, reason: r?.reason ?? 'unfinished', text: [...head, ...lines].join('\n') };
}

if (isMainThread) {
  const { values } = parseArgs({ options: { deck: { type: 'string' }, against: { type: 'string' }, agent: { type: 'string', default: 'policy:0' },
    opponent: { type: 'string' }, games: { type: 'string', default: '20' }, review: { type: 'string', default: '0' }, out: { type: 'string', default: '/tmp/review' },
    workers: { type: 'string' }, seed: { type: 'string', default: '0' } } });
  if (!DECK_POOL[values.deck] || !DECK_POOL[values.against]) throw new Error('Usage: --deck <pool id> --against <pool id>');
  const n = Number(values.games), jobs = Array.from({ length: n }, (_, g) => ({ deck: values.deck, against: values.against, agent: values.agent,
    opponent: values.opponent ?? values.agent, seed: Number(values.seed) + (g >> 1), focalFirst: g % 2 === 0 }));
  const workers = Math.min(n, Number(values.workers ?? availableParallelism() - 1)), results = [];
  await Promise.all(Array.from({ length: workers }, (_, i) => new Promise((resolve, reject) => {
    new Worker(new URL(import.meta.url), { workerData: jobs.filter((_, g) => g % workers === i) })
      .on('message', (r) => results.push(r)).on('error', reject).on('exit', resolve);
  })));
  const dir = `${values.out}/${values.deck}--${values.against}`;
  mkdirSync(dir, { recursive: true });
  const lost = results.filter((r) => r.won === 0).sort((a, b) => a.seed - b.seed || a.focalFirst - b.focalFirst);
  for (const r of lost) writeFileSync(`${dir}/lost-${r.seed}-${r.focalFirst ? 'first' : 'second'}.txt`, r.text);
  const score = results.reduce((a, r) => a + r.won, 0) / results.length;
  console.log(`${values.deck} vs ${values.against}: ${(100 * score).toFixed(1)}% over ${results.length} games; ${lost.length} lost, transcripts in ${dir}`);
  const reviews = Number(values.review);
  if (reviews > 0 && lost.length) {
    const { askJSON } = await import('../ai/foundry.mjs');
    const strategies = JSON.parse(readFileSync(new URL('../ai/deck-strategies.json', import.meta.url), 'utf8')).decks;
    const guideFile = new URL('../ai/deck-guides.json', import.meta.url);
    const guide = existsSync(guideFile) ? JSON.parse(readFileSync(guideFile, 'utf8')).decks[values.deck] : null;
    const SYSTEM = `你是简体中文宝可梦集换式卡牌游戏（PTCG）的顶尖教练，正在复盘一个 AI 输掉的对局。AI 按一套通用规则加这副卡组的打法要点出牌。
只根据对局记录里的卡牌说明判断卡牌效果；AI 当时看不到对手的手牌和牌库，评价时只用它当时能知道的信息。
找出决定胜负的 1–3 个错误（具体到回合和走法），说明更好的走法；再给出能避免这类错误的打法规则，写成"在什么情况下 → 怎么做"，尽量通用（不只适用于这一局）。
只输出一个 JSON 对象：{"summary":"一句话说明为什么输","mistakes":[{"turn":3,"move":"当时的走法","better":"更好的走法","why":"原因"}],"rules":[{"when":"情况","do":"做法","kind":"opening|bench|search|discard|energy|attack|switch|prize|other"}],"luck":"如果主要是运气（起手卡手、对手太顺）就说明，否则为空"}`;
    const context = [`这副卡组的打法要点（大模型根据卡面写的）：\n${JSON.stringify(strategies[values.deck]?.strategy ?? {}, null, 0)}`,
      guide ? `网上攻略要点：\n${JSON.stringify(guide.points, null, 0)}` : ''].filter(Boolean).join('\n\n');
    const picked = lost.slice(0, reviews), out = [];
    await Promise.all(picked.map(async (r) => {
      try {
        const { json } = await askJSON(SYSTEM, `${context}\n\n对局记录：\n${r.text}`);
        out.push({ game: `${r.seed}-${r.focalFirst ? 'first' : 'second'}`, ...json });
      } catch (error) { out.push({ game: `${r.seed}`, error: error.message }); }
    }));
    writeFileSync(`${dir}/reviews.json`, `${JSON.stringify(out, null, 1)}\n`);
    for (const r of out) {
      console.log(`\n## ${r.game}: ${r.summary ?? r.error}${r.luck ? `（运气：${r.luck}）` : ''}`);
      for (const m of r.mistakes ?? []) console.log(`  第${m.turn}回合 ${m.move} → ${m.better}：${m.why}`);
      for (const x of r.rules ?? []) console.log(`  [${x.kind}] ${x.when} → ${x.do}`);
    }
  }
  process.exit(0);
} else {
  const release = await loadRelease();
  for (const job of workerData) {
    try { parentPort.postMessage({ ...job, ...(await record(release, job)) }); } catch (error) { parentPort.postMessage({ ...job, won: 0.5, reason: `error: ${error.message}`, text: '' }); }
  }
}
