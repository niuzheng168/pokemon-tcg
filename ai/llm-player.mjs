// A language model playing one seat of a game (ai/foundry.mjs): against an AI level in scripts/ai-llm-games.mjs, against
// another model in scripts/ai-llm-duel.mjs (docs/ai/STATUS.md M7).
// At each of its decisions the model gets: the deck's playbook (or written strategy and guide points) and its own list
// with every card's text (the same in every question, so it goes in the system message, which the service caches whole), then the
// position as its player sees it (describe.mjs; both discard piles; the opponent only by what it has shown), the moves of
// this turn and the opponent's last turn, and the numbered legal moves or a request's options; it answers a number (or
// several). Requests with one option or of the kinds the policy answers alone, a turn of more than 30 asks, and any
// answer out of range are the policy's (counted).
import { readFileSync } from 'node:fs';
import { DECK_POOL } from './decks.mjs';
import { createPolicy } from './policy.mjs';
import { planFor } from './deck-plan.mjs';
import { describer } from './describe.mjs';
import { askJSON } from './foundry.mjs';

// Requests the policy answers alone (search.mjs SIMPLE_REQUESTS and the like).
const SIMPLE = new Set(['view-cards', 'counter-allocation', 'guess-answer', 'janken', 'coin-face', 'choose-order', 'mulligan-bonus', 'prize']);

const SYSTEM = `你是简体中文宝可梦集换式卡牌游戏（PTCG）的顶尖选手，正在实战中驾驶一副卡组。每次给你当前局面（你看得到的信息）和可选的走法，你选出最有可能赢下这局的一个。
只根据给出的卡牌说明判断效果；对手的手牌、牌库和奖赏卡你看不到，只能根据对手已经亮出的牌推断。
一个回合里会多次问你，每次只选下一步；"本回合你已经做了"列出了这一回合之前的走法。要把整个回合想清楚（先检索、贴能、进化，最后攻击；攻击会结束回合）。
只输出一个 JSON 对象：{"choice": 编号, "reason": "一句话"}；要选多个时 "choice" 是编号数组。`;

// Below this many cards the question reminds the model of its deck: games lost to a model were mostly lost by decking out.
const LOW_DECK = 12;

let docs = null;
const readDocs = () => (docs ??= Object.fromEntries(['strategies', 'guides', 'playbooks'].map((k) => [k,
  JSON.parse(readFileSync(new URL(`./deck-${k}.json`, import.meta.url), 'utf8')).decks])));

/**
 * The model playing `seat` of `sim` with the pool deck `deck`: `model` the deployment, `effort` its reasoning effort,
 * `env` the env file of its service (ai/foundry.mjs). decide(n) → { action, by: 'llm' | 'policy', reason } for the
 * seat's n-th step of the turn; played(actor, text) tells it a move made (by either player), for its "this turn" and
 * "the opponent's last turn". stats: questions, policy answers, bad answers, time and tokens as the service counts them.
 */
export function llmPlayer(sim, catalog, seat, { deck, model, effort, env, seed = 0 }) {
  const say = describer(catalog), def = (id) => catalog.definition(id), { strategies, guides, playbooks } = readDocs();
  const policy = createPolicy(catalog, { seed: [seed, 7, 7, 7], plans: (p) => planFor(catalog, sim.state, p) });
  const own = [...new Map(Object.values(sim.state.cards).filter((c) => c.owner === seat).map((c) => [c.printingId, c])).values()];
  const counts = new Map();
  for (const c of Object.values(sim.state.cards)) if (c.owner === seat) counts.set(def(c.definitionId).name, (counts.get(def(c.definitionId).name) ?? 0) + 1);
  // A deck's playbook (deck-playbooks.json: guide points checked against its list and card texts) instead of the
  // strategy the model wrote and the raw guide points, which name cards of other lists and contradict each other.
  const book = playbooks[deck];
  const head = [`你的卡组：「${DECK_POOL[deck].name}」。卡表：${[...counts].map(([n, k]) => `${n}×${k}`).join('、')}`,
    ...(book ? [`这副卡组的打法要点（根据网上攻略整理，已和这份卡表、卡面逐条核对）：\n${book.sections.map((x) => `【${x.title}】\n${x.points.map((t) => `- ${t.text}`).join('\n')}`).join('\n')}`]
      : [`这副卡组的打法（大模型根据卡面和网上攻略写的）：${JSON.stringify(strategies[deck]?.strategy ?? {})}`,
        guides[deck] ? `网上攻略要点：${JSON.stringify(guides[deck].points)}` : '']),
    `你卡组里每张卡的说明：\n${[...new Map(own.map((c) => [def(c.definitionId).name, c])).values()].map((c) => `- ${say.cardText(c)}`).join('\n')}`].filter(Boolean).join('\n\n');
  const stats = { asked: 0, policy: 0, refused: 0, bad: 0, ms: 0, tokens: 0, prompt: 0, cached: 0, written: 0, completion: 0, reasoning: 0 };
  let turn = null, thisTurn = [], lastFoe = [], asksThisTurn = 0;
  const sync = () => {
    if (sim.state.phase === 'setup' || sim.state.turn === turn) return;
    turn = sim.state.turn;
    if (sim.state.current === seat) { asksThisTurn = 0; thisTurn = []; } else lastFoe = [];
  };
  const grouped = (cards) => { const n = new Map(); for (const c of cards) n.set(def(c.definitionId).name, (n.get(def(c.definitionId).name) ?? 0) + 1);
    return [...n].map(([k, v]) => (v > 1 ? `${k}×${v}` : k)).join('、') || '无'; };
  const ask = async (view, header, options, multi) => {
    const discard = (i) => grouped(Array.isArray(view.players[i].discard) ? view.players[i].discard : []), left = view.players[seat].deckCount;
    const user = `== 当前局面 ==\n${say.state(view, seat)}\n你的弃牌区：${discard(seat)}\n对手的弃牌区：${discard(1 - seat)}\n` +
      (left <= LOW_DECK ? `注意：你的牌库只剩${left}张。每个回合开始要抽1张，抽不到就输；检索和抽牌会更快抽空牌库。\n` : '') +
      `对手上一回合：${lastFoe.join('；') || '（无）'}\n本回合你已经做了：${thisTurn.join('；') || '（还没有）'}\n\n${header}\n` +
      options.map((t, i) => `${i}. ${t}`).join('\n') + `\n\n${multi ? `选择 ${multi.min}–${multi.max} 个，"choice" 为编号数组。` : '选择一个编号。'}`;
    const t0 = Date.now(), { json, usage } = await askJSON(`${SYSTEM}\n\n${head}`, user, { effort, model, env, tries: 10, cacheKey: `ptcg-${deck}` });
    stats.asked++; stats.ms += Date.now() - t0; stats.tokens += usage?.total_tokens ?? 0;
    stats.prompt += usage?.prompt_tokens ?? 0; stats.cached += usage?.prompt_tokens_details?.cached_tokens ?? 0;
    stats.written += usage?.prompt_tokens_details?.cache_write_tokens ?? 0;
    stats.completion += usage?.completion_tokens ?? 0; stats.reasoning += usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    return json;
  };
  async function decide(n) {
    sync();
    const view = sim.view(seat), q = view.pending;
    const fallback = () => { stats.policy++; return { action: policy(view, seat, n), by: 'policy' }; };
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
    for (const a of view.legalActions.filter((x) => x.type !== 'concede')) { const t = say.move(view, seat, a); if (!moves.has(t)) moves.set(t, a); }
    if (moves.size <= 1) return fallback();
    asksThisTurn++;
    const list = [...moves], json = await ask(view, '现在可以走的：', list.map(([t]) => t), null);
    const i = Number([].concat(json.choice)[0]);
    if (!Number.isInteger(i) || i < 0 || i >= list.length) { stats.bad++; return fallback(); }
    return { action: list[i][1], by: 'llm', reason: json.reason };
  }
  function played(actor, text) {
    sync();
    if (actor === seat) thisTurn.push(text); else if (sim.state.phase !== 'setup') lastFoe.push(text);
  }
  return { decide, played, stats };
}
