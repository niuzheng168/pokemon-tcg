// 调试台 (administrators only): commands that rewrite the game in progress, to reach a position quickly and reproduce a
// problem. A command edits a copy of the kernel snapshot; the kernel then restores the copy, so only a state it accepts
// is ever played: each player keeps exactly their own 60 cards and a legal deck, history stays consistent, and so on.
// The table records every edit with the full state it produced (replay.js step 'edit'), so a replay passes through it.
// The commands are listed in COMMANDS (/help); public/debug-panel.js is the point-and-click face of the same commands.
//
// Syntax: /command arg arg key=value. Quote what has spaces ("厄诡椪 碧草面具ex"), or leave the spaces out.
// 你 / me is the player at the table, in whichever seat (`me` of runCommand: 0 unless the player took over seat 1); 小茂
// / opp is the other seat.
//   side     me | opp | all, or 1 | 2 | 3, or 我 | 对手 | 双方            (1 = 你, 2 = 小茂, 3 = 双方)
//   card     an instance id (p0c12), a printing (CSV6C:121/128), or a card name (whole or a unique part); name@zone
//            narrows it to a zone (巢穴球@discard)
//   pokémon  active | bench1…bench8 (or 战斗 | 备战1…), opp.active | opp.bench2 for 小茂's, a Pokémon id (m12), or the
//            name of a Pokémon in play
import { OfficialGame } from './rules/engine.js';
import { randomIndex, shuffleIds } from './rules/random.js';
import { applyCondition, emptyConditions } from './rules/conditions.js';

export class DebugError extends Error {}
const fail = (message) => { throw new DebugError(message); };

// By side, not seat: 0 the player at the table, 1 小茂 (context: seat).
const WHO = ['你', '小茂'];
const ZONES = ['deck', 'hand', 'prizes', 'discard', 'lost'];
export const ZONE_NAMES = { deck: '牌库', hand: '手牌', prizes: '奖赏卡', discard: '弃牌区', lost: '放逐区', stack: '场上',
  energy: '附着的能量', tools: '附着的道具', stadium: '竞技场', resolving: '结算中' };
const SIDES = { me: [0], '我': [0], '你': [0], 1: [0], opp: [1], '对手': [1], '小茂': [1], 2: [1], all: [0, 1], both: [0, 1], '双方': [0, 1], 3: [0, 1] };
// Where /move puts a card: [zone, position].
const DESTINATIONS = { hand: ['hand'], '手牌': ['hand'], top: ['deck', 'top'], 'deck-top': ['deck', 'top'], '牌库顶': ['deck', 'top'],
  bottom: ['deck', 'bottom'], 'deck-bottom': ['deck', 'bottom'], '牌库底': ['deck', 'bottom'], deck: ['deck', 'random'], '牌库': ['deck', 'random'],
  prizes: ['prizes'], prize: ['prizes'], '奖赏卡': ['prizes'], discard: ['discard'], '弃牌区': ['discard'], lost: ['lost'], '放逐区': ['lost'] };
const STATUS = { asleep: 'asleep', sleep: 'asleep', '睡眠': 'asleep', paralyzed: 'paralyzed', paralysis: 'paralyzed', '麻痹': 'paralyzed',
  confused: 'confused', confusion: 'confused', '混乱': 'confused', none: null, '无': null, off: null };
const STATUS_NAMES = { asleep: '睡眠', paralyzed: '麻痹', confused: '混乱' };
const FLAG_NAMES = { energy: '从手牌附着能量', supporter: '使用支援者', retreat: '撤退', stadium: '使出竞技场' };
const ON = new Set(['1', 'on', 'yes', 'true', '是', '开']), OFF = new Set(['0', 'off', 'no', 'false', '否', '关', 'none']);

const squash = (x) => String(x).replace(/\s+/g, '').toLowerCase();
const plainPrinting = (id) => id.replace(/^zh-Hans:/, '');

// "/cmd a "b c" k=v k2="x y"" → {name, args, opts}. id= and card= are the same as the first positional card.
export function parse(text) {
  const tokens = [...String(text).trim().matchAll(/([^\s=]+)="([^"]*)"|"([^"]*)"|(\S+)/g)]
    .map((m) => (m[1] ? `${m[1]}=${m[2]}` : m[3] ?? m[4]));
  const name = (tokens.shift() ?? '').replace(/^[/／]/, '').toLowerCase();
  const args = [], opts = {};
  for (const t of tokens) {
    const i = t.indexOf('=');
    if (i > 0) opts[t.slice(0, i).toLowerCase()] = t.slice(i + 1);
    else args.push(t);
  }
  return { name, args, opts };
}

// ---------------- Looking things up in a snapshot ----------------
// me: the player's seat. seat(side) is a side's seat, and a seat's side (the same swap).
function context(s, catalog, me = 0) {
  const ctx = { s, catalog, me };
  ctx.seat = (x) => (me ? 1 - x : x);
  ctx.who = (owner) => WHO[ctx.seat(owner)];
  ctx.def = (id) => catalog.definition(s.cards[id].definitionId);
  ctx.name = (id) => ctx.def(id).name;
  ctx.mons = (owner) => [s.players[owner].active, ...s.players[owner].bench].filter(Boolean);
  ctx.label = (id) => { const at = where(s, id); return `「${ctx.name(id)}」（${ctx.who(s.cards[id].owner)}的${ZONE_NAMES[at?.zone] ?? '?'}，${id}）`; };
  ctx.monLabel = (owner, m) => `「${ctx.name(m.stack.at(-1))}」（${ctx.who(owner)}的${s.players[owner].active === m ? '战斗宝可梦' : `备战${s.players[owner].bench.indexOf(m) + 1}`}，${m.id}）`;
  return ctx;
}

// Where a card is now: a zone of its owner, part of a Pokémon in play, or the Stadium.
export function where(s, id) {
  for (const [owner, p] of s.players.entries()) {
    for (const zone of [...ZONES, 'resolving']) { const index = p[zone].indexOf(id); if (index >= 0) return { owner, zone, list: p[zone], index }; }
    for (const m of [p.active, ...p.bench].filter(Boolean)) for (const zone of ['stack', 'energy', 'tools']) {
      const index = m[zone].indexOf(id); if (index >= 0) return { owner, zone, mon: m, list: m[zone], index };
    }
  }
  return s.stadium === id ? { owner: s.cards[id].owner, zone: 'stadium' } : null;
}

// The seats a side word names.
function sides(ctx, word, fallback = 'me') {
  return (SIDES[squash(word ?? fallback)] ?? fail(`不认识「${word}」：玩家写 me / opp / all（或 1 / 2 / 3）。`)).map(ctx.seat);
}
function oneSide(ctx, word, fallback = 'me') {
  const list = sides(ctx, word, fallback);
  return list.length === 1 ? list[0] : fail('这里只能选一位玩家：me 或 opp。');
}
const isSide = (word) => word !== undefined && squash(word) in SIDES;
// Where a number is a count (/draw 2, /prizes 3), only the named sides (me, opp…) mean a player.
const isNamedSide = (word) => isSide(word) && !/^\d+$/.test(word);

// The printings a word names: a printing id, or a card name (whole, or a unique part).
function printings(ctx, query) {
  const all = ctx.catalog.printings(), q = squash(query);
  const exact = all.filter((p) => squash(plainPrinting(p.printingId)) === squash(plainPrinting(query)));
  if (exact.length) return exact;
  const named = (test) => all.filter((p) => test(squash(ctx.catalog.definitionFor(p.printingId).name)));
  const byName = named((n) => n === q);
  return byName.length ? byName : named((n) => n.includes(q));
}
// The printings of the one card a word names; a word that fits several cards is refused.
function namedPrintings(ctx, query) {
  const found = printings(ctx, query);
  if (!found.length) fail(`卡池里没有「${query}」。`);
  const names = new Set(found.map((p) => ctx.catalog.definitionFor(p.printingId).name));
  if (names.size > 1) fail(`「${query}」可以指 ${[...names].slice(0, 6).join('、')}${names.size > 6 ? '…' : ''}，请写得更完整。`);
  return found;
}
const onePrinting = (ctx, query) => namedPrintings(ctx, query)[0];

// The physical cards a word names, best first: your own before 小茂's (when no owner is given), zones in `prefer`
// order, deck cards nearest the top first.
function findCards(ctx, query, { owner = null, prefer = ['hand', 'deck', 'discard', 'prizes', 'lost'] } = {}) {
  if (query === undefined || query === '') fail('需要指定一张卡。');
  const [q, zoneWord] = String(query).split('@');
  const zone = zoneWord ? (Object.entries(ZONE_NAMES).find(([k, v]) => k === zoneWord || v === zoneWord)?.[0]
    ?? (DESTINATIONS[zoneWord]?.[0]) ?? fail(`不认识区域「${zoneWord}」。`)) : null;
  const { s } = ctx;
  let ids = Object.keys(s.cards).filter((id) => owner === null || s.cards[id].owner === owner);
  if (/^p[01]c\d+$/.test(q)) ids = ids.filter((id) => id === q);
  else {
    const prints = new Set(namedPrintings(ctx, q).map((p) => p.printingId));
    ids = ids.filter((id) => prints.has(s.cards[id].printingId));
  }
  const located = ids.map((id) => ({ id, at: where(s, id) })).filter((x) => x.at && (!zone || x.at.zone === zone));
  if (!located.length) fail(`${owner === null ? '' : `${ctx.who(owner)}的`}${zone ? ZONE_NAMES[zone] : '卡牌'}里没有「${query}」。`);
  const rank = (at) => { const i = prefer.indexOf(at.zone); return i < 0 ? prefer.length : i; };
  located.sort((a, b) => ctx.seat(s.cards[a.id].owner) - ctx.seat(s.cards[b.id].owner) || rank(a.at) - rank(b.at) ||
    (a.at.zone === 'deck' ? b.at.index - a.at.index : a.at.index - b.at.index));
  return located.map((x) => x.id);
}
const findCard = (ctx, query, options) => findCards(ctx, query, options)[0];

// A Pokémon in play: {owner, m}.
function findMon(ctx, query, defaultOwner = ctx.me) {
  if (!query) fail('需要指定一只场上的宝可梦（active、bench1、opp.active…）。');
  const { s } = ctx;
  const all = [0, 1].flatMap((owner) => ctx.mons(owner).map((m) => ({ owner, m })));
  if (/^m\d+$/.test(query)) return all.find((x) => x.m.id === query) ?? fail(`场上没有宝可梦 ${query}。`);
  let owner = defaultOwner, rest = String(query);
  const prefix = /^(?:(opp|me)[.:：·]|(对手|小茂|我|你)[.:：·的]?)/.exec(rest);
  if (prefix && rest.length > prefix[0].length) { owner = ctx.seat(SIDES[prefix[1] ?? prefix[2]][0]); rest = rest.slice(prefix[0].length); }
  const p = s.players[owner];
  if (/^(active|a|战斗|战斗宝可梦)$/.test(rest)) return p.active ? { owner, m: p.active } : fail(`${ctx.who(owner)}没有战斗宝可梦。`);
  const bench = /^(?:bench|b|备战)(\d)$/.exec(rest);
  if (bench) return p.bench[bench[1] - 1] ? { owner, m: p.bench[bench[1] - 1] } : fail(`${ctx.who(owner)}的备战区没有第 ${bench[1]} 只宝可梦。`);
  const named = all.filter((x) => squash(ctx.name(x.m.stack.at(-1))).includes(squash(rest)));
  const mine = named.filter((x) => x.owner === owner);
  return (mine.length ? mine : named)[0] ?? fail(`场上没有「${query}」。`);
}

// Takes a card from where it is (a zone, a Pokémon, the Stadium). The only card of a Pokémon in play cannot be taken.
function take(ctx, id) {
  const at = where(ctx.s, id) ?? fail(`找不到 ${id}。`);
  if (at.zone === 'stadium') ctx.s.stadium = null;
  else if (at.zone === 'stack' && at.list.length === 1) fail(`${ctx.label(id)}是这只宝可梦唯一的卡，请用 /remove 移除宝可梦。`);
  else if (at.zone === 'resolving') fail(`${ctx.label(id)}正在结算。`);
  else at.list.splice(at.index, 1);
  if (at.zone === 'stack' && at.index === at.list.length) delete at.mon.facts.evolution; // its top card left
  return at;
}
function put(ctx, id, zone, position = 'top') {
  const list = ctx.s.players[ctx.s.cards[id].owner][zone];
  if (zone !== 'deck' || position === 'top') list.push(id);
  else if (position === 'bottom') list.unshift(id);
  else list.splice(randomIndex(ctx.s.rng, list.length + 1), 0, id);
}
function transform(ctx, id, printing) {
  const before = ctx.name(id), card = ctx.s.cards[id];
  card.printingId = printing.printingId;
  card.definitionId = ctx.catalog.definitionFor(printing.printingId).definitionId;
  return `${before}（${id}）变成了「${ctx.name(id)}」（${plainPrinting(printing.printingId)}）`;
}
function maxHp(ctx, owner, m) {
  let game;
  try { game = OfficialGame.restore(structuredClone(ctx.s), { catalog: ctx.catalog }); } catch (e) { fail(`规则内核不接受这一步：${e.message}`); }
  const p = game.view(owner).players[owner];
  return [p.active, ...p.bench].find((x) => x?.id === m.id).effective.maxHp;
}
function natural(word, what) {
  const n = Number(word);
  return Number.isSafeInteger(n) && n >= 0 ? n : fail(`${what}需要是非负整数，不是「${word}」。`);
}
function onOff(word, what) {
  const w = squash(word);
  return ON.has(w) ? true : OFF.has(w) ? false : fail(`${what}写 on 或 off，不是「${word}」。`);
}
function clearStatus(m) { m.conditions = emptyConditions(); }

// ---------------- Commands ----------------
// run(ctx, args, opts) → lines of text. readOnly commands change nothing; ui commands are carried out by the table.
export const COMMANDS = [
  { name: 'help', usage: '/help [命令]', text: '列出全部命令，或某个命令的用法。', readOnly: true,
    run: (ctx, [which]) => {
      const one = which && COMMANDS.find((c) => c.name === which.replace(/^\//, '') || c.aliases?.includes(which.replace(/^\//, '')));
      return one ? [one.usage, one.text, ...(one.examples ?? []).map((e) => `例：${e}`)]
        : ['命令（/help 命令 看用法；玩家：me/opp/all 或 1/2/3；卡牌：编号、卡号或卡名）：', ...COMMANDS.map((c) => `${c.usage} — ${c.text}`)];
    } },
  { name: 'show', usage: '/show [me|opp]', text: '列出一位玩家的手牌、牌库（上方在前）、奖赏卡、弃牌区和放逐区，带卡牌编号。', readOnly: true,
    run: (ctx, [side]) => {
      const owner = oneSide(ctx, side), p = ctx.s.players[owner];
      const list = (ids) => ids.map((id) => `${ctx.name(id)}(${id})`).join('、') || '—';
      return [`${ctx.who(owner)}：`, `手牌 ${p.hand.length}：${list(p.hand)}`, `牌库 ${p.deck.length}（上方在前）：${list([...p.deck].reverse())}`,
        `奖赏卡 ${p.prizes.length}：${list(p.prizes)}`, `弃牌区 ${p.discard.length}：${list(p.discard)}`, `放逐区 ${p.lost.length}：${list(p.lost)}`,
        ...ctx.mons(owner).map((m) => `${ctx.monLabel(owner, m)} 伤害 ${m.counters * 10}，能量 ${list(m.energy)}${m.tools.length ? `，道具 ${list(m.tools)}` : ''}`)];
    } },
  { name: 'nextcard', aliases: ['next'], usage: '/nextcard <卡牌> [me|opp]', examples: ['/nextcard 奥琳博士的气魄', '/nextcard id=CSV6C:121/128 opp'],
    text: '让这张卡成为牌库最上方的卡（下一张抽到）。先从牌库找，再从奖赏卡（与牌库顶的卡交换）、弃牌区、放逐区、手牌找；都没有就把牌库顶的卡变成它（卡组须仍然合法）。',
    run: (ctx, [query, side]) => {
      if (!query) fail('需要指定一张卡。');
      const owner = oneSide(ctx, side), deck = ctx.s.players[owner].deck;
      let id;
      try { id = findCard(ctx, query, { owner, prefer: ['deck', 'prizes', 'discard', 'lost', 'hand'] }); } catch { id = null; }
      const at = id && where(ctx.s, id);
      if (!at || !ZONES.includes(at.zone)) {
        if (!deck.length) fail(`${ctx.who(owner)}的牌库没有卡了。`);
        return [`${transform(ctx, deck.at(-1), onePrinting(ctx, query))}，现在是牌库最上方的卡。`];
      }
      if (at.zone === 'prizes' && deck.length) {
        const top = deck.pop();
        ctx.s.players[owner].prizes[at.index] = top;
        deck.push(id);
        return [`${ctx.name(id)}（${id}）从奖赏卡换到了牌库最上方；原来牌库顶的「${ctx.name(top)}」放进了奖赏卡。`];
      }
      const from = ZONE_NAMES[at.zone];
      take(ctx, id); deck.push(id);
      return [`${ctx.name(id)}（${id}）从${from}放到了${ctx.who(owner)}的牌库最上方。`];
    } },
  { name: 'draw', usage: '/draw [张数] [me|opp]', text: '从牌库上方抽牌加入手牌（默认 1 张）。',
    run: (ctx, args) => {
      const owner = oneSide(ctx, args.find(isNamedSide)), n = natural(args.find((a) => !isNamedSide(a)) ?? 1, '张数');
      const p = ctx.s.players[owner];
      if (p.deck.length < n) fail(`${ctx.who(owner)}的牌库只有 ${p.deck.length} 张。`);
      const drawn = p.deck.splice(p.deck.length - n).reverse();
      p.hand.push(...drawn);
      return [`${ctx.who(owner)}抽了 ${n} 张：${drawn.map(ctx.name).join('、')}。`];
    } },
  { name: 'shuffle', usage: '/shuffle [1|2|3]', examples: ['/shuffle 3'], text: '洗牌库：1 自己，2 对手，3 双方（默认自己）。',
    run: (ctx, [side]) => sides(ctx, side).map((owner) => { shuffleIds(ctx.s.rng, ctx.s.players[owner].deck); return `${ctx.who(owner)}的牌库洗匀了。`; }) },
  { name: 'move', usage: '/move <卡牌> <hand|top|bottom|deck|prizes|discard|lost> [me|opp]',
    examples: ['/move 老大的指令 hand', '/move p1c32 top', '/move 基本雷能量@discard bottom'],
    text: '把一张卡放到它持有者的某个区域：hand 手牌、top 牌库顶、bottom 牌库底、deck 牌库随机位置、prizes 奖赏卡、discard 弃牌区、lost 放逐区。也可以从场上取下能量、道具或进化卡。',
    run: (ctx, [query, dest, side]) => {
      const [zone, position] = DESTINATIONS[dest] ?? fail(`不认识区域「${dest ?? ''}」：写 hand / top / bottom / deck / prizes / discard / lost。`);
      const id = findCard(ctx, query, { owner: side ? oneSide(ctx, side) : null,
        prefer: zone === 'hand' ? ['deck', 'discard', 'prizes', 'lost', 'hand'] : ['hand', 'deck', 'discard', 'prizes', 'lost'] });
      const label = ctx.label(id);
      take(ctx, id); put(ctx, id, zone, position);
      return [`${label} → ${ctx.who(ctx.s.cards[id].owner)}的${ZONE_NAMES[zone]}${zone === 'deck' ? { top: '最上方', bottom: '最下方', random: '（随机位置）' }[position] : ''}。`];
    } },
  { name: 'transform', aliases: ['card'], usage: '/transform <卡牌> <新卡>', examples: ['/transform p0c40 老大的指令'],
    text: '把一张实体卡变成卡池里的另一张卡（位置不变）。双方各自的 60 张卡须仍是合法卡组（同名最多 4 张等）。',
    run: (ctx, [query, to], opts) => {
      const target = to ?? opts.to ?? fail('需要指定变成哪张卡。');
      return [`${transform(ctx, findCard(ctx, query, { prefer: ['hand', 'deck', 'prizes', 'discard', 'lost'] }), onePrinting(ctx, target))}。`];
    } },
  { name: 'mon', aliases: ['pokemon'], usage: '/mon <宝可梦> [card=<卡牌>] [hp=N] [damage=N] [status=asleep|paralyzed|confused|none] [poison=N|off] [burn=on|off] [heal] [ready]',
    examples: ['/mon active hp=60 status=paralyzed', '/mon opp.bench1 damage=120', '/mon bench2 card=铁斑叶ex ready'],
    text: '修改场上宝可梦：card 换成另一张卡（从自己的卡里找，没有就把它变成那张卡）、hp 剩余 HP、damage 伤害、特殊状态（只限战斗宝可梦）、heal 回复全部 HP 并解除状态、ready 视为早已在场（本回合可进化、不算刚放上场）。',
    run: (ctx, [query, ...flags], opts) => editMon(ctx, findMon(ctx, query), flags, opts) },
  { name: 'battle-card', aliases: ['active'], usage: '/battle-card [me|opp] [id=<卡牌>] [hp=N] [status=…] …',
    examples: ['/battle-card id=猛雷鼓ex hp=100', '/battle-card opp status=asleep'],
    text: '修改战斗宝可梦，等于 /mon active（或 opp.active），参数相同；id= 指定换成的卡。',
    run: (ctx, args, opts) => {
      const owner = oneSide(ctx, args.find(isNamedSide));
      return editMon(ctx, findMon(ctx, owner === ctx.me ? 'active' : 'opp.active'), args.filter((a) => !isNamedSide(a)), opts);
    } },
  { name: 'attach', usage: '/attach <能量或道具> <宝可梦>', examples: ['/attach 基本雷能量 active', '/attach 勇气护符@deck opp.bench1'],
    text: '把一张能量或宝可梦道具附着到场上的宝可梦（从持有者的手牌、牌库、弃牌区等找，不占本回合的附着次数）。',
    run: (ctx, [query, target]) => {
      const { owner, m } = findMon(ctx, target);
      const id = findCard(ctx, query, { owner, prefer: ['hand', 'deck', 'discard', 'prizes', 'lost'] }), d = ctx.def(id);
      const part = d.kind === 'energy' ? 'energy' : d.mechanics.category === 'tool' ? 'tools' : fail(`${ctx.label(id)}不是能量或宝可梦道具。`);
      const label = ctx.label(id);
      take(ctx, id); m[part].push(id);
      return [`${label} 附着到 ${ctx.monLabel(owner, m)}。`];
    } },
  { name: 'detach', usage: '/detach <能量或道具>', examples: ['/detach 基本斗能量@energy'], text: '把附着的能量或道具放到持有者的弃牌区。',
    run: (ctx, [query]) => {
      const id = findCard(ctx, query, { prefer: ['energy', 'tools'] }), at = where(ctx.s, id);
      if (!['energy', 'tools'].includes(at.zone)) fail(`${ctx.label(id)}没有附着在宝可梦身上。`);
      const label = ctx.label(id);
      take(ctx, id); put(ctx, id, 'discard');
      return [`${label} 放入弃牌区。`];
    } },
  { name: 'switch', usage: '/switch <备战宝可梦>', examples: ['/switch bench2', '/switch opp.bench1'], text: '把备战宝可梦与同一方的战斗宝可梦互换（换下的战斗宝可梦解除特殊状态）。',
    run: (ctx, [query]) => {
      const { owner, m } = findMon(ctx, query), p = ctx.s.players[owner], i = p.bench.indexOf(m);
      if (i < 0) fail(`${ctx.monLabel(owner, m)}已经是战斗宝可梦。`);
      const old = p.active;
      clearStatus(old); p.bench[i] = old; p.active = m;
      return [`${ctx.monLabel(owner, m)}换到战斗场，「${ctx.name(old.stack.at(-1))}」回到备战区。`];
    } },
  { name: 'bench', usage: '/bench <基础宝可梦> [me|opp]', examples: ['/bench 吉雉鸡ex', '/bench 多龙梅西亚 opp'], text: '把一张基础宝可梦放到备战区（不触发“放于备战区时”的特性）。',
    run: (ctx, [query, side]) => {
      const owner = oneSide(ctx, side), p = ctx.s.players[owner];
      const id = findCard(ctx, query, { owner, prefer: ['hand', 'deck', 'discard', 'prizes', 'lost'] }), d = ctx.def(id);
      if (d.kind !== 'pokemon' || d.mechanics.stage !== 'basic') fail(`${ctx.label(id)}不是基础宝可梦。`);
      const limit = OfficialGame.restore(structuredClone(ctx.s), { catalog: ctx.catalog }).view(owner).players[owner].benchLimit;
      if (p.bench.length >= limit) fail(`${ctx.who(owner)}的备战区已满（${limit} 只）。`);
      const label = ctx.label(id);
      take(ctx, id);
      p.bench.push({ id: `m${++ctx.s.serial}`, stack: [id], energy: [], tools: [], counters: 0, conditions: emptyConditions(),
        enteredTurn: ctx.s.turn, evolvedTurn: 0, used: {}, facts: {} });
      return [`${label} 放到${ctx.who(owner)}的备战区。`];
    } },
  { name: 'evolve', usage: '/evolve <宝可梦> <进化卡>', examples: ['/evolve bench1 多龙奇'], text: '把一张宝可梦卡叠放在场上的宝可梦上（不检查进化条件，不触发进化时的特性）。',
    run: (ctx, [target, query]) => {
      const { owner, m } = findMon(ctx, target);
      const id = findCard(ctx, query, { owner, prefer: ['hand', 'deck', 'discard', 'prizes', 'lost'] });
      if (ctx.def(id).kind !== 'pokemon') fail(`${ctx.label(id)}不是宝可梦卡。`);
      const from = m.stack.at(-1), at = take(ctx, id);
      m.stack.push(id); clearStatus(m); m.evolvedTurn = ctx.s.turn;
      m.facts.evolution = { turn: ctx.s.turn, fromCardId: from, toCardId: id, method: 'effect',
        origin: ['hand', 'deck', 'discard'].includes(at.zone) ? at.zone : 'hand' };
      return [`${ctx.monLabel(owner, m)}由「${ctx.name(from)}」进化而来。`];
    } },
  { name: 'devolve', usage: '/devolve <宝可梦>', text: '把宝可梦最上面的进化卡放回手牌。',
    run: (ctx, [target]) => {
      const { owner, m } = findMon(ctx, target);
      if (m.stack.length < 2) fail(`${ctx.monLabel(owner, m)}没有进化。`);
      const top = m.stack.pop();
      ctx.s.players[owner].hand.push(top); delete m.facts.evolution; clearStatus(m); m.evolvedTurn = 0;
      return [`「${ctx.name(top)}」回到手牌，现在是 ${ctx.monLabel(owner, m)}。`];
    } },
  { name: 'remove', usage: '/remove <宝可梦>', examples: ['/remove opp.bench2'], text: '把宝可梦及附着的卡放入弃牌区（不算昏厥，不拿奖赏卡）。移走战斗宝可梦时，备战区第一只换上场。',
    run: (ctx, [target]) => {
      const { owner, m } = findMon(ctx, target), p = ctx.s.players[owner], label = ctx.monLabel(owner, m);
      if (p.active === m) {
        if (!p.bench.length) fail(`${ctx.who(owner)}没有备战宝可梦可以换上场。`);
        p.active = p.bench.shift();
      } else p.bench.splice(p.bench.indexOf(m), 1);
      p.discard.push(...m.stack, ...m.energy, ...m.tools);
      ctx.s.ongoing = ctx.s.ongoing.filter((e) => e.targetId !== m.id);
      return [`${label}及附着的卡放入弃牌区。`, ...(p.active && !p.bench.includes(p.active) && label.includes('战斗宝可梦')
        ? [`${ctx.monLabel(owner, p.active)}换上了战斗场。`] : [])];
    } },
  { name: 'flags', usage: '/flags [me|opp] [energy=0|1] [supporter=0|1] [retreat=0|1] [stadium=0|1]', examples: ['/flags supporter=0 energy=0'],
    text: '设置本回合是否已经：从手牌附着能量、使用支援者、撤退、使出竞技场（0 = 还没有，可以再做）。',
    run: (ctx, [side], opts) => {
      const owner = oneSide(ctx, side), f = ctx.s.players[owner].flags, keys = Object.keys(opts).filter((k) => k in FLAG_NAMES);
      if (!keys.length) fail('写要改的项：energy、supporter、retreat、stadium。');
      for (const k of keys) f[k] = onOff(opts[k], k);
      return keys.map((k) => `${ctx.who(owner)}本回合${f[k] ? '已经' : '还没有'}${FLAG_NAMES[k]}。`);
    } },
  { name: 'reset-turn', usage: '/reset-turn [me|opp]', text: '本回合的次数限制全部清空：附着能量、支援者、撤退、竞技场，以及特性和效果的“每回合 1 次”。',
    run: (ctx, [side]) => {
      const owner = oneSide(ctx, side), p = ctx.s.players[owner], turn = ctx.s.turn;
      for (const k of Object.keys(p.flags)) p.flags[k] = false;
      for (const used of [p.used, ...ctx.mons(owner).map((m) => m.used)])
        for (const key of Object.keys(used)) { used[key] = used[key].filter((t) => t !== turn); if (!used[key].length) delete used[key]; }
      return [`${ctx.who(owner)}本回合的次数限制已清空。`];
    } },
  { name: 'stadium', usage: '/stadium <竞技场卡>|none', examples: ['/stadium 零之大空洞', '/stadium none'], text: '把一张竞技场放到场上（原来的竞技场放入其持有者的弃牌区），none 移除竞技场。',
    run: (ctx, [query]) => {
      const old = ctx.s.stadium, lines = [];
      if (squash(query) !== 'none' && query !== '无') {
        const id = findCard(ctx, query, { prefer: ['hand', 'deck', 'discard', 'prizes', 'lost'] });
        if (ctx.def(id).mechanics.category !== 'stadium') fail(`${ctx.label(id)}不是竞技场卡。`);
        lines.push(`${ctx.label(id)}放到场上。`);
        take(ctx, id); ctx.s.stadium = id;
      } else ctx.s.stadium = null;
      if (old && old !== ctx.s.stadium) { put(ctx, old, 'discard'); lines.unshift(`原来的竞技场「${ctx.name(old)}」放入弃牌区。`); }
      return lines;
    } },
  { name: 'prizes', usage: '/prizes [me|opp] <张数>', examples: ['/prizes opp 1'], text: '把剩余奖赏卡调成指定张数：多出的放回牌库最下方，不足的从牌库上方补。',
    run: (ctx, args) => {
      const owner = oneSide(ctx, args.find(isNamedSide)), n = natural(args.find((a) => !isNamedSide(a)), '张数'), p = ctx.s.players[owner];
      if (n > 6) fail('奖赏卡最多 6 张。');
      while (p.prizes.length > n) p.deck.unshift(p.prizes.pop());
      while (p.prizes.length < n) { if (!p.deck.length) fail('牌库不够补奖赏卡。'); p.prizes.push(p.deck.pop()); }
      return [`${ctx.who(owner)}剩余奖赏卡 ${n} 张。`];
    } },
  { name: 'coin', usage: '/coin heads|tails …', examples: ['/coin heads', '/coin tails tails heads'],
    text: '指定接下来几次掷硬币的结果（正面 heads、反面 tails，最多 12 次）。只管“下一次用到随机数”，期间若先洗了牌，顺序会被打乱。',
    run: (ctx, args) => {
      const want = args.map((a) => ({ heads: 0, h: 0, '正': 0, '正面': 0, tails: 1, t: 1, '反': 1, '反面': 1 })[squash(a)] ?? fail(`「${a}」不是 heads 或 tails。`));
      if (!want.length || want.length > 12) fail('写 1–12 个 heads / tails。');
      for (let k = 1; ; k++) {
        const rng = [k, (k * 7 + 1) >>> 0, (k * 13 + 2) >>> 0, (k * 31 + 3) >>> 0], probe = [...rng];
        if (want.every((w) => randomIndex(probe, 2) === w)) { ctx.s.rng = rng; break; }
      }
      return [`接下来 ${want.length} 次掷硬币：${want.map((w) => (w ? '反面' : '正面')).join('、')}。`];
    } },
  { name: 'effects', usage: '/effects [me|opp] [clear]', text: '列出作用在一位玩家及其宝可梦上的持续效果（如「痒痒花粉」），clear 全部清除。',
    writes: (args) => args.some((a) => squash(a) === 'clear'),
    run: (ctx, args) => {
      const action = args.find((a) => squash(a) === 'clear'), side = args.find((a) => squash(a) !== 'clear');
      const owner = oneSide(ctx, side), ids = new Set(ctx.mons(owner).map((m) => m.id)), { s } = ctx;
      const mine = [...s.ongoing.filter((e) => ids.has(e.targetId)), ...s.playerOngoing.filter((e) => e.player === owner)];
      const describe = (e) => `${e.source ? `「${ctx.name(e.source.instanceId)}」` : ''}${JSON.stringify(e.effect.actions ?? e.effect.op)}（${e.duration}）`;
      if (!action) return mine.length ? mine.map(describe) : [`${ctx.who(owner)}身上没有持续效果。`];
      s.ongoing = s.ongoing.filter((e) => !ids.has(e.targetId));
      s.playerOngoing = s.playerOngoing.filter((e) => e.player !== owner);
      return [`清除了 ${mine.length} 个持续效果。`];
    } },
  { name: 'revert', usage: '/revert', text: '撤销上一次调试修改。', ui: true },
  { name: 'export', usage: '/export', text: '下载当前对局的完整内核快照（JSON），可用于写回归测试。', ui: true },
];
const BY_NAME = new Map(COMMANDS.flatMap((c) => [[c.name, c], ...(c.aliases ?? []).map((a) => [a, c])]));

function editMon(ctx, { owner, m }, flags, opts) {
  const lines = [], p = ctx.s.players[owner], active = p.active === m;
  const cardQuery = opts.card ?? opts.id;
  const top = m.stack.at(-1);
  if (cardQuery !== undefined && namedPrintings(ctx, cardQuery).some((pr) => pr.printingId === ctx.s.cards[top].printingId))
    lines.push(`已经是「${ctx.name(top)}」。`);
  else if (cardQuery !== undefined) {
    let id;
    try { id = findCard(ctx, cardQuery, { owner, prefer: ['hand', 'deck', 'discard', 'prizes', 'lost'] }); } catch { id = null; }
    const at = id && where(ctx.s, id);
    if (at && ZONES.includes(at.zone)) {
      at.list[at.index] = top; m.stack[m.stack.length - 1] = id;
      lines.push(`换成${ctx.label(id)}；原来的「${ctx.name(top)}」放到了${ZONE_NAMES[at.zone]}。`);
    } else lines.push(`${transform(ctx, top, onePrinting(ctx, cardQuery))}。`);
    if (ctx.def(m.stack.at(-1)).kind !== 'pokemon') fail('宝可梦只能换成宝可梦卡。');
    delete m.facts.evolution;
  }
  const words = new Set(flags.map(squash));
  if (words.has('heal')) { m.counters = 0; clearStatus(m); lines.push('回复了全部 HP，解除了特殊状态。'); }
  if (words.has('ready')) {
    m.enteredTurn = 0; m.evolvedTurn = 0; delete m.facts.evolution;
    lines.push('视为早已在场：本回合可以进化。');
  }
  if (opts.hp !== undefined) {
    const max = maxHp(ctx, owner, m), hp = natural(opts.hp, 'HP');
    if (hp < 10 || hp > max || hp % 10) fail(`HP 需要是 10–${max} 之间 10 的倍数。`);
    m.counters = (max - hp) / 10;
    lines.push(`剩余 HP ${hp}/${max}。`);
  }
  for (const key of ['damage', 'counters']) if (opts[key] !== undefined) {
    const n = natural(opts[key], key === 'damage' ? '伤害' : '伤害指示物');
    if (key === 'damage' && n % 10) fail('伤害需要是 10 的倍数。');
    m.counters = key === 'damage' ? n / 10 : n;
    if (m.counters * 10 >= maxHp(ctx, owner, m)) fail('伤害不能达到或超过最大 HP（想让它离场请用 /remove）。');
    lines.push(`伤害 ${m.counters * 10}。`);
  }
  const conditionChange = ['status', 'poison', 'burn'].some((k) => opts[k] !== undefined);
  if (conditionChange && !active) fail('只有战斗宝可梦可以有特殊状态。');
  if (opts.status !== undefined) {
    const status = STATUS[squash(opts.status)];
    if (status === undefined) fail(`不认识状态「${opts.status}」：写 asleep / paralyzed / confused / none。`);
    if (status === null) { m.conditions.rotation = null; m.conditions.paralysisRecoverTurn = null; lines.push('解除了睡眠、麻痹、混乱。'); }
    else { m.conditions = applyCondition(m.conditions, status, { ownerTurn: p.turns }).conditions; lines.push(`陷入${STATUS_NAMES[status]}。`); }
  }
  if (opts.poison !== undefined) {
    const off = OFF.has(squash(opts.poison));
    m.conditions.poison = off ? null : natural(opts.poison, '中毒指示物') || fail('中毒至少 1 个指示物，解除写 off。');
    lines.push(off ? '解除了中毒。' : `中毒（每次检查 ${m.conditions.poison} 个伤害指示物）。`);
  }
  if (opts.burn !== undefined) { m.conditions.burned = onOff(opts.burn, 'burn'); lines.push(m.conditions.burned ? '陷入灼伤。' : '解除了灼伤。'); }
  if (!lines.length) fail('没有要修改的内容：写 hp=、damage=、status=、card= 等。');
  return [`${ctx.monLabel(owner, m)}：`, ...lines];
}

// Runs one command line on a snapshot. Returns {lines} for a command that only reads, {ui, args, opts} for one the
// table carries out itself (/revert, /export), or {state, lines}: the new snapshot, one revision on, which the kernel
// has already accepted. Throws DebugError with a message for the player otherwise. me: the player's seat (你 / me).
export function runCommand(text, { snapshot, catalog, me = 0 }) {
  const { name, args, opts } = parse(text);
  if (!name) fail('输入命令，例如 /help。');
  const cmd = BY_NAME.get(name) ?? fail(`没有这个命令：/${name}。输入 /help 查看全部命令。`);
  if (cmd.ui) return { ui: cmd.name, args, opts };
  // id= / card= stand for the first argument of the commands that take a card first.
  if (!['mon', 'battle-card'].includes(cmd.name) && (opts.id ?? opts.card) !== undefined) args.unshift(opts.id ?? opts.card);
  const s = structuredClone(snapshot), ctx = context(s, catalog, me === 1 ? 1 : 0), writes = cmd.writes?.(args) ?? !cmd.readOnly;
  if (writes && (s.result || s.pending || s.queue.length || s.phase !== 'main'))
    fail(s.result ? '对局已经结束。' : '现在有选择未完成或效果正在结算：请先完成当前操作，再修改对局。');
  const lines = cmd.run(ctx, args, opts);
  if (!writes) return { lines };
  s.revision++;
  try {
    OfficialGame.restore(structuredClone(s), { catalog });
  } catch (error) {
    fail(`规则内核不接受修改后的对局（${error.code ?? 'error'}）：${error.message}`);
  }
  return { state: s, lines };
}

// For the panel: every card of a player by zone, with names and where they are.
export function zonesOf(snapshot, catalog, owner) {
  const p = snapshot.players[owner], name = (id) => catalog.definition(snapshot.cards[id].definitionId).name;
  const card = (id) => ({ id, name: name(id), printingId: snapshot.cards[id].printingId, kind: catalog.definition(snapshot.cards[id].definitionId).kind,
    category: catalog.definition(snapshot.cards[id].definitionId).mechanics.category ?? null });
  return { hand: p.hand.map(card), deck: [...p.deck].reverse().map(card), prizes: p.prizes.map(card), discard: p.discard.map(card), lost: p.lost.map(card),
    card };
}
