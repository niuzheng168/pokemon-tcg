// Deck strategies written by a language model (M7). For each deck, the model (Foundry gpt-6-astra, reasoning effort
// high, as the user chose) reads the list, the printed texts of its cards (our card data, never its own memory of the
// cards), the archetype's tournament statistics and the plan inferred from the card effects, and writes the deck's
// strategy as JSON: roles, opening and bench order, the board to build by turn 2, what to search first, what never to
// discard and what to discard first, where Energy goes, what to promote, the key combos and common mistakes. Every
// name must be one of the list's cards (others are dropped and reported). The strategies go to
// ai/deck-strategies.json; the policy reads their priorities, and the arena decides whether they help.
// The points of online guides for its archetype (ai/deck-guides.json, gathered from the sources it names) go in too, when
// there are any. Any list (a player's own deck) works too: --list names a JSON file of its cards ([[printingId, copies]], or an object
// with `cards` and `name`), and --note adds the player's own description of how the deck plays.
// The model is called through ai/foundry.mjs (its key is never printed).
//   node scripts/ai-deck-strategy.mjs [--decks id,id | --list file --id id [--note text]] [--model gpt-6-astra] [--effort high]
//     [--workers 4] [--show: print the briefs only]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadRelease } from '../server/catalog.mjs';
import { DECK_POOL } from '../ai/decks.mjs';
import { deckPlan, describePlan } from '../ai/deck-plan.mjs';
import { askJSON } from '../ai/foundry.mjs';

const { values } = parseArgs({ options: { decks: { type: 'string' }, model: { type: 'string', default: 'gpt-6-astra' },
  effort: { type: 'string', default: 'high' }, workers: { type: 'string', default: '4' }, show: { type: 'boolean' }, list: { type: 'string' },
  id: { type: 'string' }, note: { type: 'string' } } });
const OUT = new URL('../ai/deck-strategies.json', import.meta.url);
// What the game shows for a card (public/card-facts.js): the facts from our definitions, the printed prose from the
// release's presentation data (transcribed from the card images).
const presentation = JSON.parse(readFileSync(new URL('../public/data/cn/V20261019/decks.json', import.meta.url), 'utf8')).cards;
// The presentation has no text for the attack a Technical Machine gives: the card library snapshot's, by name.
const library = new Map();
for (const line of readFileSync(new URL('../catalog/zh-CN/V20261019/library/snapshot/merged.jsonl', import.meta.url), 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const { view } = JSON.parse(line);
  if (view.id.startsWith('tcg:')) library.set(view.id.slice(4), view.card);
}
const archetypes = JSON.parse(readFileSync(new URL('../ai/archetypes.json', import.meta.url), 'utf8')).archetypes;
const GUIDES = new URL('../ai/deck-guides.json', import.meta.url);
const guides = existsSync(GUIDES) ? Object.values(JSON.parse(readFileSync(GUIDES, 'utf8')).decks) : [];
const GUIDE_PARTS = { plan: '整体打法', opening: '起手', turn1: '第 1 回合', turn2: '第 2 回合', attackers: '攻击手', prizeMap: '拿奖路线',
  resources: '资源管理', combos: '组合技', matchups: '对各卡组', techs: '针对卡', mistakes: '常见失误' };
const TYPES = { Grass: '草', Fire: '火', Water: '水', Lightning: '雷', Psychic: '超', Fighting: '斗', Darkness: '恶', Metal: '钢', Fairy: '妖', Dragon: '龙', Colorless: '无' };
const STAGES = { basic: '基础', stage1: '1阶进化', stage2: '2阶进化' };
const CATEGORIES = { item: '物品卡', supporter: '支援者卡', stadium: '竞技场卡', tool: '宝可梦道具', basic: '基本能量', special: '特殊能量' };
const TAGS = { Ancient: '古代', Future: '未来', 'Single Strike': '一击', 'Rapid Strike': '连击', 'Fusion Strike': '融合', Tera: '太晶', ex: 'ex' };
const DAMAGE = { fixed: '', plus: '+', minus: '-', times: '×' };
const slug = (id) => id.split(':').at(-1);

const SCHEMA = `{
  "summary": "一两句话说明这副卡组怎么赢",
  "attackers": [{ "name": "卡名", "role": "main | secondary | finisher", "when": "什么时候用它攻击" }],
  "engines": [{ "name": "卡名", "kind": "energy | draw | search | other", "how": "怎么用" }],
  "openingActive": ["开局放在战斗场的优先顺序（卡名）"],
  "benchPriority": ["铺备战区的优先顺序（卡名）"],
  "turn2Board": [{ "name": "卡名", "count": 1 }],
  "searchPriority": ["从牌库检索宝可梦或卡牌时的优先顺序（卡名）"],
  "keep": ["不要弃掉的卡（卡名）"],
  "discardFirst": ["需要弃牌时先弃的卡（卡名）"],
  "energy": { "attach": [{ "name": "卡名", "note": "附着给它的原因或时机" }], "ammo": "field | hand | none" },
  "promotePriority": ["换上战斗场的优先顺序（卡名）"],
  "combos": [{ "name": "组合名", "steps": ["第一步", "第二步"] }],
  "mistakes": ["常见失误"]
}`;
const SYSTEM = `你是简体中文宝可梦集换式卡牌游戏（PTCG）的顶尖教练。根据给出的卡表和每张卡的卡面文字，写出这副卡组的打法。
要求：
1. 只根据给出的卡面文字判断卡牌效果，不要凭记忆补充；规则按简体中文官方规则。
2. 所有"卡名"必须完全照抄卡表里的名字；不在卡表里的卡不要写。
3. 只输出一个 JSON 对象，格式如下（字段都要有，没有就给空数组）：
${SCHEMA}
4. 优先顺序从最重要到最不重要排列；turn2Board 是第 2 回合结束时希望场上有的宝可梦（最多 6 只）。
5. 说明文字用简体中文，简洁具体。`;

function brief(deck, catalog, names, note = null) {
  const plan = deckPlan(catalog, deck.cards), lines = [`卡表（${deck.name}，60 张）：`];
  const seen = new Set(), cards = [];
  for (const [printingId, n] of deck.cards) {
    const d = catalog.definitionFor(printingId);
    lines.push(`- ${d.name} ×${n}`);
    if (!seen.has(d.name)) { seen.add(d.name); cards.push([printingId, d]); }
  }
  lines.push('', '卡面文字：');
  for (const [printingId, d] of cards) {
    const m = d.mechanics, texts = presentation[printingId]?.texts ?? {}, tags = (m.tags ?? []).map((t) => TAGS[t] ?? t);
    const facts = d.kind === 'pokemon'
      ? [STAGES[m.stage] ?? m.stage, `HP${m.hp}`, `${m.types.map((t) => TYPES[t]).join('')}属性`, m.evolvesFrom && `由${names.get(m.evolvesFrom) ?? m.evolvesFrom}进化`, ...tags,
        !texts.rule && m.prizeCount > 1 && `被击倒时对手拿${m.prizeCount}张奖赏卡`,
        m.weakness && `弱点${TYPES[m.weakness.type]}${m.weakness.operation === 'multiply' ? '×' : '+'}${m.weakness.value}`,
        m.resistance && `抗性${TYPES[m.resistance.type]}-${m.resistance.value}`, `撤退${m.retreatCost}`]
      : [CATEGORIES[m.category] ?? d.kind, ...tags];
    lines.push(`${d.name}（${facts.filter(Boolean).join('，')}）`);
    for (const a of m.abilities ?? []) lines.push(`  特性「${a.name}」：${texts[slug(a.abilityId)] ?? ''}`);
    const attack = (a, what) => `  ${what}「${a.name}」[${a.cost.map((t) => TYPES[t]).join('') || '无'}]` +
      `${a.printedDamage ? ` ${a.printedDamage.value}${DAMAGE[a.printedDamage.operator] ?? ''}` : ''}：` +
      `${texts[slug(a.attackId)] ?? library.get(printingId)?.attacks?.find((x) => x.name === a.name)?.text ?? ''}`;
    for (const a of m.attacks ?? []) lines.push(attack(a, '招式'));
    for (const a of m.grantedAttacks ?? []) lines.push(attack(a, '放有这张卡的宝可梦可以使用的招式'));
    for (const key of ['card', 'tera', 'rule']) if (texts[key] && !(d.kind === 'energy' && m.category === 'basic')) lines.push(`  ${texts[key]}`);
  }
  const a = plan.archetype && plan.archetype.similarity >= 0.85 && archetypes.find((x) => x.name === plan.archetype.name);
  if (a) lines.push('', `赛事统计：这副卡组属于「${a.name}」套路（${a.lists} 份近期赛事前八卡表）。几乎都带的卡：` +
    a.cards.filter((c) => c.share >= 0.9).map((c) => `${c.name}（平均 ${c.copies} 张）`).join('、'));
  lines.push('', `程序按卡牌效果推断的角色（仅供参考，可能不对）：\n${describePlan(plan)}`);
  // The guide of this pool deck, or of its archetype.
  const guide = guides.find((g) => g.deck === deck.id) ?? (a ? guides.find((g) => g.archetype === a.name) : null);
  if (guide) {
    lines.push('', `网上攻略要点（整理自 ${guide.sources.length} 个来源；卡牌效果仍以上面的卡面文字为准，和这份卡表不符的部分忽略）：`);
    for (const [key, title] of Object.entries(GUIDE_PARTS)) {
      const points = guide.points?.[key] ?? [];
      if (points.length) lines.push(`【${title}】`, ...points.map((x) => `- ${x.opponent ? `${x.opponent}：` : x.card ? `${x.card}：` : ''}${x.text}`));
    }
  }
  if (note) lines.push('', `玩家对这副卡组打法的描述（优先参考；卡牌效果仍以上面的卡面文字为准）：\n${note}`);
  return { text: lines.join('\n'), names: seen, archetype: plan.archetype };
}

const ask = async (text) => { const { json, usage } = await askJSON(SYSTEM, text, { model: values.model, effort: values.effort }); return { strategy: json, usage }; };

// Names not in the list are dropped (and reported).
function clean(strategy, names, dropped) {
  const ok = (n) => { if (names.has(n)) return true; dropped.add(n); return false; };
  const list = (v) => (Array.isArray(v) ? v.filter((n) => typeof n === 'string' && ok(n)) : []);
  const objs = (v, key = 'name') => (Array.isArray(v) ? v.filter((x) => x && typeof x[key] === 'string' && ok(x[key])) : []);
  return {
    summary: String(strategy.summary ?? ''), attackers: objs(strategy.attackers), engines: objs(strategy.engines),
    openingActive: list(strategy.openingActive), benchPriority: list(strategy.benchPriority),
    turn2Board: objs(strategy.turn2Board).map((x) => ({ name: x.name, count: Math.max(1, Math.min(4, Number(x.count) || 1)) })),
    searchPriority: list(strategy.searchPriority), keep: list(strategy.keep), discardFirst: list(strategy.discardFirst),
    energy: { attach: objs(strategy.energy?.attach), ammo: ['field', 'hand', 'none'].includes(strategy.energy?.ammo) ? strategy.energy.ammo : 'none' },
    promotePriority: list(strategy.promotePriority),
    combos: Array.isArray(strategy.combos) ? strategy.combos.map((c) => ({ name: String(c.name ?? ''), steps: [].concat(c.steps ?? []).map(String) })) : [],
    mistakes: [].concat(strategy.mistakes ?? []).map(String),
  };
}

const release = await loadRelease();
// The decks: a list from a file, or pool decks.
const decks = { ...DECK_POOL };
if (values.list) {
  const file = JSON.parse(readFileSync(values.list, 'utf8')), cards = Array.isArray(file) ? file : file.cards;
  if (!values.id || !Array.isArray(cards)) throw new Error('--list needs --id and a file of [[printingId, copies]] (or { cards }).');
  decks[values.id] = { id: values.id, name: file.name ?? values.id, cards };
}
const ids = values.list ? [values.id] : values.decks ? values.decks.split(',') : Object.keys(DECK_POOL);
const names = new Map((await release.index()).entries.map((e) => [e.card.nameKey, e.card.name]));
const out = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { model: values.model, effort: values.effort, decks: {} };
let next = 0;
await Promise.all(Array.from({ length: Number(values.workers) }, async () => {
  while (next < ids.length) {
    const id = ids[next++], deck = { id, ...decks[id] }, catalog = await release.catalogFor(deck.cards.map(([p]) => p));
    const { text, names: listed, archetype } = brief(deck, catalog, names, values.note), started = Date.now();
    if (values.show) { console.log(text); continue; }
    try {
      const { strategy, usage } = await ask(text), dropped = new Set();
      out.decks[id] = { name: deck.name, list: deck.cards.map(([p, n]) => `${p}×${n}`).sort().join(), archetype, generatedOn: new Date().toISOString().slice(0, 10),
        model: values.model, effort: values.effort, ...(values.note ? { note: values.note } : {}), strategy: clean(strategy, listed, dropped), dropped: [...dropped] };
      writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
      console.log(`${id}: ${((Date.now() - started) / 1000).toFixed(0)} s, ${usage?.completion_tokens ?? '?'} tokens${dropped.size ? `, dropped ${[...dropped].join('、')}` : ''}`);
    } catch (error) {
      console.log(`${id}: ${error.message}`);
    }
  }
}));
