// A language model playing one seat of a game (ai/foundry.mjs): against an AI level in scripts/ai-llm-games.mjs, against
// another model in scripts/ai-llm-duel.mjs (docs/ai/STATUS.md M7).
// At each of its decisions the model gets: the deck's playbook (or written strategy and guide points) and its own list
// with every card's text (the same in every question, so it goes in the system message, which the service caches whole), then the
// position as its player sees it (describe.mjs; both discard piles; the opponent only by what it has shown), the moves of
// this turn and the opponent's last turn, and the numbered legal moves or a request's options; it answers a number (or
// several, or how many damage counters go on each target). In setup it chooses going first or second, its Active and
// its Bench. Requests with one option or of the kinds the policy answers alone, a turn of more than 30 asks, and any
// answer out of range are the policy's (counted).
import { readFileSync } from 'node:fs';
import { DECK_POOL } from './decks.mjs';
import { createPolicy } from './policy.mjs';
import { planFor } from './deck-plan.mjs';
import { describer } from './describe.mjs';
import { askJSON } from './foundry.mjs';

// Requests the policy answers alone (search.mjs SIMPLE_REQUESTS and the like).
const SIMPLE = new Set(['view-cards', 'guess-answer', 'janken', 'coin-face', 'mulligan-bonus', 'prize']);
// What the model decides during setup: going first or second, its Active, its Bench (mulligan draws stay the policy's).
const SETUP = { 'choose-order': '你赢得了先后攻的选择权。先攻方第1回合不能攻击，也不能使用支援者；后攻方第1回合都可以。选择：',
  'setup-active': '开局：从手牌里选1只基础宝可梦放到战斗场（双方都放好后才翻开）：',
  'setup-bench': '开局：从手牌里选要放到备战区的基础宝可梦（也可以不放）：' };
const ORDER = { first: '先攻', second: '后攻' };

const SYSTEM = `你是简体中文宝可梦集换式卡牌游戏（PTCG）的顶尖选手，正在实战中驾驶一副卡组。每次给你当前局面（你看得到的信息）和可选的走法，你选出最有可能赢下这局的一个。
只根据给出的卡牌说明判断效果；对手的手牌、牌库和奖赏卡你看不到，只能根据对手已经亮出的牌推断。
{flow}
只输出一个 JSON 对象：{"choice": 编号, "reason": "一句话"}；要选多个时 "choice" 是编号数组；分配伤害指示物时 "choice" 是 {"编号": 个数} 对象。`;

// One conversation for the whole game (the default; `session: false` asks every question on its own, as before): the
// first question and the first of each of its turns give the whole position, the others only what happened since the
// last question and the lines of the position that changed.
const CONVERSATION = `这是一整局的连续对话。第一次提问和你的每个回合开始时给你完整局面；之后的提问只给「自上次提问以来」发生的事和「局面变化」（只列有变化的行），没列出的和之前一样。
要把整个回合想清楚（先检索、贴能、进化，最后攻击；攻击会结束回合）。`;
const ALONE = `一个回合里会多次问你，每次只选下一步；"本回合你已经做了"列出了这一回合之前的走法。要把整个回合想清楚（先检索、贴能、进化，最后攻击；攻击会结束回合）。`;
// Above this many characters the oldest of its turns are dropped from the conversation (each turn starts whole).
const KEEP_CHARS = 150000;

// Below this many cards the question reminds the model of its deck: games lost to a model were mostly lost by decking out.
const LOW_DECK = 12;

let docs = null;
const readDocs = () => (docs ??= Object.fromEntries(['strategies', 'guides', 'playbooks'].map((k) => [k,
  JSON.parse(readFileSync(new URL(`./deck-${k}.json`, import.meta.url), 'utf8')).decks])));

/**
 * The model playing `seat` of `sim` with the pool deck `deck`: `model` the deployment, `effort` its reasoning effort,
 * `env` the env file of its service (ai/foundry.mjs). decide(n) → { action, by: 'llm' | 'policy', reason } for the
 * seat's n-th step of the turn; played(actor, action, actorView) tells it a move made (by either player), for its "this
 * turn" and "the opponent's last turn". stats: questions, policy answers, bad answers, time and tokens as the service counts them.
 */
export function llmPlayer(sim, catalog, seat, { deck, model, effort, env, seed = 0, session = true }) {
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
  const system = `${SYSTEM.replace('{flow}', session ? CONVERSATION : ALONE)}\n\n${head}`;
  const stats = { asked: 0, policy: 0, refused: 0, bad: 0, ms: 0, tokens: 0, prompt: 0, cached: 0, written: 0, completion: 0, reasoning: 0 };
  let turn = null, thisTurn = [], lastFoe = [], asksThisTurn = 0;
  const sync = () => {
    if (sim.state.phase === 'setup' || sim.state.turn === turn) return;
    turn = sim.state.turn;
    if (sim.state.current === seat) { asksThisTurn = 0; thisTurn = []; } else lastFoe = [];
  };
  const grouped = (cards) => { const n = new Map(); for (const c of cards) n.set(def(c.definitionId).name, (n.get(def(c.definitionId).name) ?? 0) + 1);
    return [...n].map(([k, v]) => (v > 1 ? `${k}×${v}` : k)).join('、') || '无'; };
  // The position in labelled rows (the label is a row's text before its first 「：」 or 「（」) and the card texts shown.
  const positionOf = (view) => {
    const discard = (i) => grouped(Array.isArray(view.players[i].discard) ? view.players[i].discard : []), left = view.players[seat].deckCount;
    const text = say.state(view, seat).split('\n'), at = text.indexOf('卡牌说明：');
    const rows = [...text.slice(1, at), `你的弃牌区：${discard(seat)}`, `对手的弃牌区：${discard(1 - seat)}`,
      ...(left <= LOW_DECK ? [`注意：你的牌库只剩${left}张。每个回合开始要抽1张，抽不到就输；检索和抽牌会更快抽空牌库。`] : [])];
    return { header: text[0], rows: new Map(rows.map((r) => [r.replace(/[：（].*$/s, ''), r])), cards: text.slice(at + 1) };
  };
  // The conversation: exchanges { block, user, output, chars, cards } (a block is one of its turns, starting whole),
  // what happened since the last question, the position last sent, the card texts sent.
  let exchanges = [], block = 0, since = [], last = null, wholeTurn = null, described = new Set(), chosen = null, rejected = null;
  const say1 = (view, header, options, tail) => {
    const pos = positionOf(view), mine = sim.state.phase !== 'setup' && sim.state.current === seat;
    const whole = !last || (mine && sim.state.turn !== wholeTurn);
    if (whole) { block++; if (mine) wholeTurn = sim.state.turn; }
    const parts = since.length ? [`自上次提问以来：\n${since.map((t) => `- ${t}`).join('\n')}`] : [];
    if (whole) parts.push(`== 当前局面 ==\n${pos.header}\n${[...pos.rows.values()].join('\n')}`);
    else {
      const changed = [...pos.rows].filter(([k, r]) => last.rows.get(k) !== r).map(([, r]) => r);
      parts.push(`== 局面变化 ==\n${pos.header}\n${[...changed, ...[...last.rows.keys()].filter((k) => !pos.rows.has(k)).map((k) => `${k}：无`)].join('\n') || '（没有变化）'}`);
    }
    const cards = pos.cards.filter((c) => !described.has(c));
    if (cards.length) parts.push(`${whole ? '卡牌说明' : '新出现的卡牌说明'}：\n${cards.join('\n')}`);
    parts.push(`${header}\n${options.map((t, i) => `${i}. ${t}`).join('\n')}\n\n${tail}`);
    return { text: parts.join('\n\n'), pos, cards };
  };
  const remember = (m, user, output) => {
    // (Counted in the text the model reads: the encrypted reasoning it gets back is long but only as many tokens as it thought.)
    const said = output.flatMap((o) => o.content ?? []).map((c) => c.text ?? '').join('');
    exchanges.push({ block, user, output, cards: m.cards, chars: user.content.length + said.length });
    last = m.pos; since = []; m.cards.forEach((c) => described.add(c));
    // Too long: drop its oldest turns (the rest still starts with a whole position); the card texts go with them.
    while (exchanges.reduce((a, e) => a + e.chars, 0) > KEEP_CHARS && new Set(exchanges.map((e) => e.block)).size > 1) {
      const first = exchanges[0].block;
      exchanges = exchanges.filter((e) => e.block !== first);
      described = new Set(exchanges.flatMap((e) => e.cards));
    }
  };
  // `tail`: how to answer (one number, several, or counts).
  const ask = async (view, header, options, tail) => {
    let user, m = null;
    if (session) { m = say1(view, header, options, tail); user = [...exchanges.flatMap((e) => [e.user, ...e.output]), { role: 'user', content: m.text }]; }
    else {
      const discard = (i) => grouped(Array.isArray(view.players[i].discard) ? view.players[i].discard : []), left = view.players[seat].deckCount;
      user = `== 当前局面 ==\n${say.state(view, seat)}\n你的弃牌区：${discard(seat)}\n对手的弃牌区：${discard(1 - seat)}\n` +
        (left <= LOW_DECK ? `注意：你的牌库只剩${left}张。每个回合开始要抽1张，抽不到就输；检索和抽牌会更快抽空牌库。\n` : '') +
        `对手上一回合：${lastFoe.join('；') || '（无）'}\n本回合你已经做了：${thisTurn.join('；') || '（还没有）'}\n\n${header}\n` +
        options.map((t, i) => `${i}. ${t}`).join('\n') + `\n\n${tail}`;
    }
    const t0 = Date.now(), { json, usage, items } = await askJSON(system, user, { effort, model, env, tries: 10, cacheKey: `ptcg-${deck}` });
    if (session) remember(m, user.at(-1), items ?? []);
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
    if (sim.state.phase === 'setup' && !SETUP[q?.kind] || asksThisTurn >= 30 || n > 60) return fallback();
    const source = q?.effect?.sourceId && sim.state.cards[q.effect.sourceId] ? `「${def(sim.state.cards[q.effect.sourceId].definitionId).name}」` : '';
    if (q?.kind === 'counter-allocation') {
      // How many of the counters go on each target (幻影潜袭's 6): every one placed, only on the targets offered.
      const { total, targets } = q.counterAllocation;
      asksThisTurn++;
      const json = await ask(view, `现在要把${source}的${total}个伤害指示物放到下面的宝可梦上（1个＝10点伤害，放伤害指示物不计算弱点、抗性）：`,
        targets.map((t) => say.pokemon(view, seat, t.pokemonId)), `"choice" 写成 {"编号": 个数} 的对象，例如 {"0": 4, "2": 2}；个数都是正整数，合计正好 ${total} 个。`);
      const entries = json.choice && typeof json.choice === 'object' && !Array.isArray(json.choice) ? Object.entries(json.choice) : [];
      const allocations = entries.map(([i, k]) => ({ pokemonId: targets[Number(i)]?.pokemonId, count: Number(k) })).filter((a) => a.count !== 0);
      if (!allocations.length || allocations.some((a) => !a.pokemonId || !Number.isInteger(a.count) || a.count < 0)
        || new Set(allocations.map((a) => a.pokemonId)).size !== allocations.length || allocations.reduce((x, a) => x + a.count, 0) !== total) {
        stats.bad++; rejected = `你上次的分配不合规（个数合计要正好${total}个，只能放在列出的宝可梦上）`; return fallback();
      }
      return llm({ type: 'allocateCounters', requestId: q.id, allocations }, json.reason);
    }
    if (q) {
      if (SIMPLE.has(q.kind) || !q.options?.length || q.options.length < 2 && (q.minimum ?? 0) >= 1) return fallback();
      const texts = q.options.map((id) => ORDER[id] ?? say.answer(view, q, [id]).replace(/^（[^）]*）选择：/, ''));
      const max = Math.min(q.maximum ?? q.minimum ?? 1, q.options.length), min = q.minimum ?? 0, multi = max > 1 ? { min, max } : min === 0 ? { min: 0, max: 1 } : null;
      asksThisTurn++;
      const json = await ask(view, SETUP[q.kind] ?? `现在要回答${source}的选择（${q.kind}）：`, texts,
        multi ? `选择 ${multi.min}–${multi.max} 个，"choice" 为编号数组。` : '选择一个编号。');
      const picked = [].concat(json.choice ?? []).map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < q.options.length);
      if (picked.length < min || picked.length > Math.max(max, 1) || new Set(picked).size !== picked.length) { stats.bad++; rejected = '你上次的回答不合规（编号或个数不对）'; return fallback(); }
      return llm({ type: 'answer', requestId: q.id, selected: picked.map((i) => q.options[i]) }, json.reason);
    }
    const moves = new Map();
    for (const a of view.legalActions.filter((x) => x.type !== 'concede')) { const t = say.move(view, seat, a); if (!moves.has(t)) moves.set(t, a); }
    if (moves.size <= 1) return fallback();
    asksThisTurn++;
    const list = [...moves], json = await ask(view, '现在可以走的：', list.map(([t]) => t), '选择一个编号。');
    const i = Number([].concat(json.choice)[0]);
    if (!Number.isInteger(i) || i < 0 || i >= list.length) { stats.bad++; rejected = '你上次的回答不合规（没有这个编号）'; return fallback(); }
    return llm(list[i][1], json.reason);
  }
  // The model's own move (so the conversation need not tell it again, unless the rules refuse it).
  const llm = (action, reason) => { chosen = JSON.stringify(action); return { action, by: 'llm', reason }; };
  // The cards this seat knows after a move: in play, in either discard pile, the Stadium, its own hand, and a card an
  // event of this move showed it face up (a Pokémon searched 「在给对手看过之后」, say). Only this move's events: cards shown
  // earlier (a mulligan hand) were shuffled back and are not known any more.
  let shownUpTo = 0;
  const seen = () => {
    const ids = new Set(), view = sim.view(seat, { withEvents: true }), walk = (x, all) => {
      if (Array.isArray(x)) x.forEach((y) => walk(y, all));
      else if (x && typeof x === 'object') {
        if (x.instanceId && (all || x.definitionId)) ids.add(x.instanceId);
        if (all && x.id) ids.add(x.id);
        Object.values(x).forEach((y) => walk(y, all));
      }
    };
    walk(view.players, true); walk(view.stadium, true); walk(view.events.slice(shownUpTo), false);
    shownUpTo = view.events.length;
    return ids;
  };
  /** A move made, `action` by `actor` in `actorView` (its view before the move): the opponent's is told as this seat saw
   * it, a card it picked that stays hidden (from its deck to its hand, a face-down Prize) only counted. */
  function played(actor, action, actorView) {
    const turnBefore = turn;
    sync();
    const known = seen(), hidden = (id) => actor !== seat && !!sim.state.cards[id] && !known.has(id);
    const text = action.type === 'answer' ? say.answer(actorView, actorView.pending, action.selected, hidden) : say.move(actorView, actor, action);
    if (actor === seat) thisTurn.push(text); else if (sim.state.phase !== 'setup') lastFoe.push(text);
    if (!session) return;
    if (actor === seat) {
      // Its own move: told only when it did not choose it (the rules did, or refused what it chose).
      if (rejected) since.push(`${rejected}，这一步由规则代为选择：${text}`);
      else if (chosen && chosen !== JSON.stringify(action)) since.push(`你选的走法规则不允许，改为：${text}`);
      else if (!chosen) since.push(`（规则自动处理）${text}`);
      chosen = null; rejected = null;
    } else if (sim.state.phase !== 'setup') since.push(`对手：${text}`);
    if (turn !== turnBefore && turn !== null) since.push(`== 第${turn}回合（${sim.state.current === seat ? '你' : '对手'}）开始 ==`);
  }
  return { decide, played, stats };
}
