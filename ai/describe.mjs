// A position and its moves in words (simplified Chinese), for a language model (Kev, docs/ai/STATUS.md): what `me`
// can see — both boards, my hand, what is hidden only as counts — with the printed text of every card shown, then each
// main-phase move as a short line. Names and texts come from the release's card data; nothing here knows a card.
import { readFileSync } from 'node:fs';

const TYPE = { Grass: '草', Fire: '火', Water: '水', Lightning: '雷', Psychic: '超', Fighting: '斗', Darkness: '恶', Metal: '钢',
  Fairy: '妖', Dragon: '龙', Colorless: '无色' };
const STAGE = { basic: '基础', stage1: '1阶进化', stage2: '2阶进化' };
const CATEGORY = { item: '物品', supporter: '支援者', stadium: '竞技场', tool: '宝可梦道具', basic: '基本能量', special: '特殊能量' };
const ROTATION = { asleep: '睡眠', paralyzed: '麻痹', confused: '混乱' };
/** The question Kev answers over the moves (its training records and the arena's Kev player ask the same). */
export const MOVE_QUESTION = '你是正在行动的一方。下面哪个走法最有可能让你赢下这局？';

let printed = null;
/** The printed texts of every printing (public/data/cn/V20261019/decks.json), read once. */
const textsOf = (printingId) =>
  (printed ??= JSON.parse(readFileSync(new URL('../public/data/cn/V20261019/decks.json', import.meta.url), 'utf8')).cards)[printingId]?.texts ?? {};

export function describer(catalog) {
  const def = (id) => catalog.definition(id);
  const nameOf = (card) => def(card.definitionId).name;
  const last = (id) => String(id).split(':').at(-1);
  const types = (list) => (list ?? []).map((t) => TYPE[t] ?? t).join('');
  const damage = (p) => (p?.value ? `${p.value}${{ times: '×', plus: '+', minus: '-' }[p.operator] ?? ''}` : '');
  const grouped = (cards) => {
    const n = new Map();
    for (const c of cards) n.set(nameOf(c), (n.get(nameOf(c)) ?? 0) + 1);
    return [...n].map(([k, v]) => (v > 1 ? `${k}×${v}` : k)).join('、');
  };

  /** A card's printed text in one line. */
  function cardText(card) {
    const d = def(card.definitionId), m = d.mechanics, t = textsOf(card.printingId);
    if (d.kind !== 'pokemon') return `${d.name}（${CATEGORY[m.category] ?? d.kind}）：${t.card || '无效果文字'}`;
    const parts = [`${d.name}（${STAGE[m.stage] ?? m.stage}，HP${m.hp}，${types(m.types)}属性` +
      `${m.weakness ? `，弱点${types([m.weakness.type])}` : ''}${m.resistance ? `，抗性${types([m.resistance.type])}-${m.resistance.value}` : ''}` +
      `，撤退${m.retreatCost}${m.prizeCount > 1 ? `，被击倒时对手拿${m.prizeCount}张奖赏卡` : ''}）`];
    for (const a of m.abilities ?? []) parts.push(`特性「${a.name}」：${t[last(a.abilityId)] ?? ''}`);
    for (const a of m.attacks ?? []) {
      const text = t[last(a.attackId)];
      parts.push(`招式「${a.name}」[${types(a.cost) || '无'}]${damage(a.printedDamage) ? ` ${damage(a.printedDamage)}` : ''}${text ? `：${text}` : ''}`);
    }
    return parts.join('；');
  }

  function mon(m) {
    const c = m.conditions ?? {}, status = [ROTATION[c.rotation], c.poison ? '中毒' : null, c.burned ? '灼伤' : null].filter(Boolean);
    return `${nameOf(m.stack.at(-1))}（HP ${m.effective.currentHp}/${m.effective.maxHp}` +
      `${m.energy.length ? `，能量：${grouped(m.energy)}` : '，无能量'}${m.tools?.length ? `，道具：${grouped(m.tools)}` : ''}` +
      `${status.length ? `，${status.join('、')}` : ''}）`;
  }
  const count = (zone) => (Array.isArray(zone) ? zone.length : zone?.count ?? 0);

  /** The position from `me`'s view. */
  function state(view, me) {
    const lines = [`第${view.turn}回合，轮到${view.current === me ? '你' : '对手'}行动。你是${view.first === me ? '先攻' : '后攻'}。`];
    const shown = new Map(), show = (card) => { if (card && !shown.has(card.printingId)) shown.set(card.printingId, card); };
    for (const [who, i] of [['你', me], ['对手', 1 - me]]) {
      const p = view.players[i], discard = Array.isArray(p.discard) ? p.discard : [];
      lines.push(`${who}：奖赏卡剩${count(p.prizes)}张，牌库${p.deckCount}张，手牌${count(p.hand)}张，弃牌区${discard.length}张` +
        `（能量${discard.filter((c) => def(c.definitionId).kind === 'energy').length}张）${count(p.lost) ? `，放逐区${count(p.lost)}张` : ''}。`);
      const active = p.active && !p.active.faceDown ? p.active : null, bench = p.bench.filter((m) => !m.faceDown);
      lines.push(`${who}的战斗宝可梦：${active ? mon(active) : '无'}`);
      lines.push(`${who}的备战宝可梦（${bench.length}/${p.benchLimit ?? 5}）：${bench.length ? bench.map(mon).join('；') : '无'}`);
      for (const m of [active, ...bench].filter(Boolean)) { show(m.stack.at(-1)); m.tools?.forEach(show); }
    }
    if (view.stadium) { lines.push(`竞技场：${nameOf(view.stadium)}（${view.stadium.owner === me ? '你' : '对手'}的）`); show(view.stadium); }
    const hand = Array.isArray(view.players[me].hand) ? view.players[me].hand : [];
    lines.push(`你的手牌：${hand.length ? grouped(hand) : '无'}`);
    hand.forEach(show);
    lines.push('卡牌说明：', ...[...shown.values()].map((c) => `- ${cardText(c)}`));
    return lines.join('\n');
  }

  function findMon(view, id) {
    for (const p of view.players) for (const [i, m] of [p.active, ...p.bench].entries()) if (m?.id === id) return { m, where: i ? `备战区第${i}只` : '战斗场' };
    return null;
  }

  /** A main-phase move of `me`, in a few words. */
  function move(view, me, action) {
    const hand = Array.isArray(view.players[me].hand) ? view.players[me].hand : [];
    const card = action.cardId && hand.find((c) => c.instanceId === action.cardId), target = action.pokemonId && findMon(view, action.pokemonId);
    const at = (t) => (t ? `${t.where}的「${nameOf(t.m.stack.at(-1))}」` : '宝可梦');
    const active = view.players[me].active;
    switch (action.type) {
      case 'endTurn': return '结束回合';
      case 'playTrainer': return `使用「${card ? nameOf(card) : '训练家'}」`;
      case 'bench': return `将「${card ? nameOf(card) : '宝可梦'}」放到备战区`;
      case 'attachEnergy': return `将「${card ? nameOf(card) : '能量'}」附着于${at(target)}`;
      case 'evolve': return `将${at(target)}进化为「${card ? nameOf(card) : '进化卡'}」`;
      case 'retreat': return `撤退战斗场的「${active ? nameOf(active.stack.at(-1)) : '宝可梦'}」`;
      case 'useStadium': return `使用竞技场「${view.stadium ? nameOf(view.stadium) : ''}」的效果`;
      case 'useAbility': {
        const m = target?.m ?? active, d = m && def(m.stack.at(-1).definitionId);
        const ability = (d?.mechanics.abilities ?? []).find((a) => a.abilityId === action.abilityId);
        return `使用${at(target)}的特性「${ability?.name ?? last(action.abilityId)}」`;
      }
      case 'attack': {
        const attack = active && (def(active.stack.at(-1).definitionId).mechanics.attacks ?? []).find((a) => a.attackId === action.attackId);
        return `攻击：招式「${attack?.name ?? last(action.attackId)}」`;
      }
      default: return `${action.type}${card ? `「${nameOf(card)}」` : ''}`;
    }
  }
  return { state, move, cardText };
}
