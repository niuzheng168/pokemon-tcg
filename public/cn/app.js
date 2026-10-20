// CN/V20261019 official-rules mode. Isolated from the teaching engine (public/ui.js):
// it loads only the reviewed release through the installed trust pin, drives the
// official kernel through view()/dispatch(), and saves under its own storage key.
import { createReviewedGame, restoreReviewedGame } from '../rules/engine.js';
import { TRUSTED_RELEASES, CN_RELEASE_ID } from './trusted-releases.js';
import { createAI } from './ai.js';

const DATA = '../data/cn/V20261019/';
const SAVE_KEY = 'pokemon-tcg:cn-official:V20261019:save';
const params = new URLSearchParams(location.search);
const FAST = params.get('speed') === 'fast';
const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v !== null && v !== undefined) node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false)
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  return node;
};

const fill = (node, ...children) => node.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));

const app = {
  json: null, meta: null, game: null, catalog: null, ai: null, me: 0, decks: null, timer: null,
  known: new Map(), monNames: new Map(), selected: [], log: [], seen: 0, images: true, auto: false, view: null,
};

const GLYPH = { Lightning: '雷', Colorless: '无', Fighting: '斗', Grass: '草', Fire: '火', Water: '水', Psychic: '超', Darkness: '恶', Metal: '钢', Fairy: '妖', Dragon: '龙' };
const STAGE = { basic: '基础', stage1: '1阶进化', stage2: '2阶进化' };
const CATEGORY = { item: '物品', supporter: '支援者', tool: '宝可梦道具', stadium: '竞技场' };
const CONDITION = { asleep: '睡眠', paralyzed: '麻痹', confused: '混乱' };
const REASON = { ordinary: '奖赏卡已全部拿取，或对手场上已没有宝可梦。', deckout: '回合开始时牌库无牌可抽。', concede: '一方认输。', simultaneous: '双方同时满足胜利条件。' };
const OPTION_TEXT = { first: '先攻', second: '后攻', perform: '执行', skip: '不执行', confirm: '确认', before: '在状态检查之前', after: '在状态检查之后' };
const PROMPT_TITLE = {
  'choose-order': '你获得了决定权：选择先攻或后攻', 'setup-active': '选择战斗宝可梦（反面放置）',
  'setup-bench': '选择放于备战区的基础宝可梦（可以不选）', 'mulligan-bonus': '对手重抽了：选择额外抽取的张数',
  prize: '拿取1张奖赏卡', promote: '选择新的战斗宝可梦', 'retreat-energy': '选择撤退时放于弃牌区的能量',
  'retreat-target': '选择换到战斗场的备战宝可梦', 'tool-target': '选择放置宝可梦道具的宝可梦',
  'activation-cost': '使用条件：选择要放于弃牌区的手牌', 'effect-target': '选择效果的对象', 'select-cards': '选择卡牌',
  'view-cards': '已查看，确认后继续', 'inspect-deck': '选择要附着的基本【雷】能量', 'deck-energy-recipient': '选择附着能量的宝可梦',
  'hand-energy': '选择手牌中的能量', 'discard-energy': '选择弃牌区中的能量', 'energy-recipient': '选择附着能量的宝可梦',
  'attached-energy': '选择宝可梦身上的能量', 'optional-effect': '是否执行这项效果？', 'trigger-optional': '是否使用这项效果？',
};

const definitionOf = (card) => app.catalog.definition(card.definitionId);
const presentation = (printingId) => app.meta.cards[printingId] ?? null;
const cardName = (id) => {
  const card = app.known.get(id);
  return card ? definitionOf(card).name : '一张卡';
};
const who = (player) => player === app.me ? '你' : '对手';
function remember(card) { if (card?.instanceId) app.known.set(card.instanceId, card); }

function indexView(view) {
  for (const [owner, p] of view.players.entries()) {
    if (Array.isArray(p.hand)) p.hand.forEach(remember);
    p.discard.forEach(remember); p.lost.forEach(remember);
    [p.active, ...p.bench].forEach((mon, i) => {
      if (!mon || mon.faceDown) return;
      [...mon.stack, ...mon.energy, ...mon.tools].forEach(remember);
      app.monNames.set(mon.id, { name: definitionOf(mon.stack.at(-1)).name, owner, position: i === 0 ? '战斗' : `备战${i}` });
    });
  }
  if (view.stadium) remember(view.stadium);
  const q = view.pending;
  if (q) {
    [...(q.cards ?? []), ...(q.lookedAt ?? []), ...(q.energy ?? []).map((e) => e.card)].forEach(remember);
    q.payment?.groups.forEach((g) => g.choices.forEach((c) => remember(c.card)));
  }
  for (const e of view.events) for (const card of e.data?.revealed ?? []) remember(card);
}
const monLabel = (id) => {
  const mon = app.monNames.get(id);
  return mon ? `${mon.name}（${mon.owner === app.me ? '我方' : '对手'}${mon.position}）` : '宝可梦';
};

function image(card, cls = '') {
  if (!app.images) return null;
  const info = presentation(card.printingId);
  if (!info) return null;
  const img = el('img', { src: `../${info.image}`, alt: info.name, class: cls, loading: 'lazy' });
  img.addEventListener('error', () => { app.images = false; img.remove(); });
  return img;
}

function showDetail(card) {
  const d = definitionOf(card), info = presentation(card.printingId), texts = info?.texts ?? {}, m = d.mechanics;
  const body = [el('h3', { text: d.name }), image(card)];
  if (info) body.push(el('p', { class: 'cn-muted', text: `${info.setCode} ${info.number}${info.mark ? ` · 赛制标记 ${info.mark}` : ''}` }));
  if (d.kind === 'pokemon') {
    body.push(el('p', { text: `${STAGE[m.stage] ?? m.stage}${m.evolvesFrom ? `（从${app.catalog.definitions().find((x) => x.nameKey === m.evolvesFrom)?.name ?? m.evolvesFrom}进化）` : ''} · HP${m.hp} · ${m.types.map((t) => GLYPH[t]).join('')}` }));
    for (const a of m.abilities) body.push(el('p', {}, el('b', { text: `特性「${a.name}」` }), ` ${texts[a.abilityId.split(':').at(-1)] ?? ''}`));
    for (const a of m.attacks) {
      const key = a.attackId.split(':').at(-1);
      body.push(el('p', {}, el('b', { text: `${a.name} [${a.cost.map((t) => GLYPH[t]).join('')}] ${a.printedDamage?.value ?? ''}` }), ` ${texts[key] ?? ''}`));
    }
    body.push(el('p', { class: 'cn-muted', text: `弱点 ${m.weakness ? `${GLYPH[m.weakness.type]}×${m.weakness.value}` : '—'} · 抗性 ${m.resistance ? `${GLYPH[m.resistance.type]}-${m.resistance.value}` : '—'} · 撤退 ${m.retreatCost}` }));
    if (texts.rule) body.push(el('p', { class: 'cn-muted', text: texts.rule }));
  } else if (d.kind === 'trainer') {
    body.push(el('p', { class: 'cn-muted', text: `训练家 · ${CATEGORY[m.category]}` }), el('p', { text: texts.card ?? '' }));
  } else body.push(el('p', { class: 'cn-muted', text: m.category === 'basic' ? '基本能量' : '特殊能量' }));
  fill($('cn-detail'), body);
}

function monTile(mon, owner, active) {
  if (!mon) return el('div', { class: 'cn-mon empty', text: active ? '（空）' : '' });
  if (mon.faceDown) return el('div', { class: 'cn-facedown', title: '反面朝上' });
  const topCard = mon.stack.at(-1), d = definitionOf(topCard), e = mon.effective;
  const energy = {};
  for (const card of mon.energy) energy[cardName(card.instanceId)] = (energy[cardName(card.instanceId)] ?? 0) + 1;
  const conditions = [mon.conditions.rotation && CONDITION[mon.conditions.rotation],
    mon.conditions.poison && '中毒', mon.conditions.burned && '灼伤'].filter(Boolean);
  return el('button', { class: `cn-mon${active ? ' active' : ''}`, type: 'button', 'data-id': mon.id, 'data-owner': owner,
    onclick: () => showDetail(topCard) },
  el('div', { class: 'cn-name', text: d.name }),
  image(topCard),
  el('div', {}, el('span', { class: `cn-hp${e.currentHp * 3 <= e.maxHp ? ' low' : ''}`, text: `HP ${e.currentHp}/${e.maxHp}` })),
  el('div', {}, Object.entries(energy).map(([name, n]) => el('span', { class: 'cn-tag energy', text: `${name.replace('基本', '').replace('能量', '')}×${n}` })),
    mon.tools.map((t) => el('span', { class: 'cn-tag tool', text: cardName(t.instanceId) })),
    conditions.map((c) => el('span', { class: 'cn-tag cond', text: c }))),
  mon.stack.length > 1 ? el('div', { class: 'cn-muted', text: `进化自 ${mon.stack.slice(0, -1).map((c) => definitionOf(c).name).join('→')}` }) : null);
}

function renderSide(target, view, owner) {
  const p = view.players[owner];
  const handCount = Array.isArray(p.hand) ? p.hand.length : p.hand.count;
  fill(target,
    el('div', { class: 'cn-info' },
      el('span', {}, `${owner === app.me ? '我方' : '对手（电脑）'}`),
      el('span', {}, '奖赏卡 ', el('b', { text: String(p.prizes.count) })),
      el('span', {}, '牌库 ', el('b', { text: String(p.deckCount) })),
      el('span', {}, '手牌 ', el('b', { text: String(handCount) })),
      el('span', {}, '弃牌区 ', el('b', { text: String(p.discard.length) }))),
    el('div', { class: 'cn-row' }, el('div', { class: 'cn-slot-label', text: '战斗场' }), monTile(p.active, owner, true)),
    el('div', { class: 'cn-row' }, el('div', { class: 'cn-slot-label', text: `备战区（${p.bench.length}/5）` }),
      p.bench.map((m) => monTile(m, owner, false))));
}

function actionLabel(a, view) {
  const mine = view.players[app.me];
  switch (a.type) {
    case 'endTurn': return '结束回合';
    case 'bench': return `放置备战：${cardName(a.cardId)}`;
    case 'evolve': return `进化：${cardName(a.cardId)} → ${monLabel(a.pokemonId)}`;
    case 'attachEnergy': return `附着能量：${cardName(a.cardId)} → ${monLabel(a.pokemonId)}`;
    case 'playTrainer': return `使用：${cardName(a.cardId)}`;
    case 'retreat': return `撤退（需${mine.active.effective.retreatCost}个能量）`;
    case 'useStadium': return '使用竞技场';
    case 'useAbility': {
      const mon = [mine.active, ...mine.bench].find((m) => m?.id === a.pokemonId);
      const ability = definitionOf(mon.stack.at(-1)).mechanics.abilities.find((x) => x.abilityId === a.abilityId);
      return `特性「${ability.name}」：${monLabel(a.pokemonId)}`;
    }
    case 'attack': {
      const attack = definitionOf(mine.active.stack.at(-1)).mechanics.attacks.find((x) => x.attackId === a.attackId);
      return `招式「${attack.name}」${attack.printedDamage ? `（${attack.printedDamage.value}）` : ''}`;
    }
    default: return a.type;
  }
}

function optionLabel(id, q) {
  const pay = q.payment?.groups.flatMap((g) => g.choices).find((c) => c.optionId === id);
  if (pay) return cardName(pay.card.instanceId);
  if (app.monNames.has(id)) return monLabel(id);
  if (app.known.has(id)) return cardName(id);
  if (q.kind === 'prize') return `第${Number(id) + 1}张奖赏卡`;
  if (q.kind === 'mulligan-bonus') return `${id}张`;
  return OPTION_TEXT[id] ?? id;
}

function renderPrompt(view) {
  const q = view.pending, box = $('cn-prompt');
  if (!q || app.auto) { box.hidden = true; fill(box); return; }
  box.hidden = false;
  const single = q.minimum === 1 && q.maximum === 1 && !q.allowZero;
  const valid = () => app.selected.length === 0 ? q.allowZero || q.minimum === 0 :
    app.selected.length >= q.minimum && app.selected.length <= q.maximum;
  const confirm = el('button', { id: 'cn-confirm', class: 'cn-primary', type: 'button', onclick: () => answer(q, [...app.selected]) },
    app.selected.length ? `确认（已选${app.selected.length}）` : (q.allowZero || q.minimum === 0 ? '不选择，继续' : '确认'));
  confirm.disabled = !valid();
  const options = q.options.map((id) => el('button', {
    class: `cn-option${app.selected.includes(id) ? ' selected' : ''}`, type: 'button', 'data-option': id,
    onclick: () => {
      if (single) { answer(q, [id]); return; }
      app.selected = app.selected.includes(id) ? app.selected.filter((x) => x !== id) :
        app.selected.length < q.maximum ? [...app.selected, id] : app.selected;
      renderPrompt(view);
    },
  }, optionLabel(id, q)));
  const looked = q.lookedAt?.length ? el('p', { class: 'cn-looked', text: `查看的卡牌：${q.lookedAt.map((c) => cardName(c.instanceId)).join('、')}` }) : null;
  const range = q.minimum === q.maximum ? `选择${q.maximum}项` : `选择${q.minimum}～${q.maximum}项`;
  fill(box, el('h2', { text: PROMPT_TITLE[q.kind] ?? '请选择' }), el('p', { class: 'cn-muted', text: `${range} · 规则 ${q.rule.ruleId}` }),
    looked, el('div', { class: 'cn-options' }, options), single ? null : confirm);
}

function renderActions(view) {
  const box = $('cn-actions');
  const status = view.result ? '对局结束' : view.pending ? '请先完成上方的选择' :
    view.legalActions.length ? `第${view.turn}回合 · 你的回合` : `第${view.turn}回合 · 对手行动中…`;
  $('cn-status').textContent = status;
  if (view.pending || app.auto) { fill(box); return; }
  fill(box, view.legalActions.map((a) => el('button', { type: 'button', 'data-type': a.type,
    'data-action': JSON.stringify(a), onclick: () => act(a) }, actionLabel(a, view))));
}

function renderHand(view) {
  const playable = new Set(view.legalActions.map((a) => a.cardId).filter(Boolean));
  fill($('cn-hand'), view.players[app.me].hand.map((card) => {
    const d = definitionOf(card);
    return el('button', { class: `cn-card${playable.has(card.instanceId) ? ' playable' : ''}`, type: 'button',
      'data-instance': card.instanceId, onclick: () => showDetail(card) },
    image(card), el('div', { class: 'cn-name', text: d.name }),
    el('div', { class: 'cn-kind', text: d.kind === 'pokemon' ? `${STAGE[d.mechanics.stage] ?? ''}宝可梦` : d.kind === 'trainer' ? CATEGORY[d.mechanics.category] : '能量' }));
  }));
}

function eventLine(e) {
  const d = e.data ?? {};
  switch (e.ruleId) {
    case 'setup.order': return d.first === undefined ? null : `${who(d.first)}先攻。`;
    case 'effects.draw': return d.count ? `${who(d.player)}抽了${d.count}张牌。` : null;
    case 'turn.trainer': return d.kind === 'trainer-open' ? `${who(d.player)}使用了「${cardName(d.cardId)}」。` : null;
    case 'turn.bench': return `${who(d.player)}将「${cardName(d.cardId)}」放于备战区。`;
    case 'turn.evolve': return `${who(d.player)}将「${cardName(d.fromCardId)}」进化为「${cardName(d.cardId)}」。`;
    case 'turn.energy': return `${who(d.player)}为「${monLabel(d.pokemonId)}」附着了「${cardName(d.cardId)}」${d.byEffect ? '（效果）' : ''}。`;
    case 'turn.tool': return `${who(d.player)}为「${monLabel(d.pokemonId)}」放置了「${cardName(d.cardId)}」。`;
    case 'ability.usage': return `${who(d.player)}使用了「${monLabel(d.pokemonId)}」的特性。`;
    case 'attack.used': return d.kind === 'used' ? `${who(d.player)}的「${monLabel(d.source.pokemonId)}」使用了招式。` : null;
    case 'attack.order': return `造成${d.damage}点伤害 → 「${monLabel(d.targetId)}」。`;
    case 'effects.coin': return `掷币：${d.result === 'heads' ? '正面' : '反面'}${d.result === d.required ? '，执行后续效果' : '，不执行后续效果'}。`;
    case 'attack.failure.imposed': return `招式判定掷币：${d.receipt.results.map((r) => r === 'heads' ? '正面' : '反面').join('、')} → ${d.receipt.passed ? '招式照常使用' : '招式失败'}。`;
    case 'ko.boundary': return d.kind === 'latched' ? `「${cardName(d.item.topCardId)}」昏厥了。` : null;
    case 'ko.promote': return `${who(d.player)}将「${monLabel(d.pokemonId)}」放到战斗场。`;
    case 'turn.end': return `${who(d.player)}的回合结束。`;
    case 'effects.switch': return `「${monLabel(d.targetId)}」被换到战斗场。`;
    case 'effects.hand-deck': return `${who(d.player)}将${d.count}张手牌放回牌库并重洗牌库。`;
    case 'effects.discard': return d.effectId ? `${who(d.player)}将手牌放于弃牌区。` : null;
    case 'effects.deploy': return d.cardId ? `${who(d.player)}将「${cardName(d.cardId)}」放于备战区。` : null;
    case 'effects.attach': return d.energyId ? `「${cardName(d.energyId)}」附着于「${monLabel(d.pokemonId)}」。` : null;
    case 'energy.attached-selection': return d.discarded ? `「${cardName(d.energyId)}」被放于弃牌区。` : null;
    case 'effects.search': return d.revealed ? `${who(d.player)}展示并加入手牌：${d.revealed.map((c) => cardName(c.instanceId)).join('、')}。` : null;
    case 'win.simultaneous': case 'win.concede': return '对局结束。';
    default: return null;
  }
}

function renderLog(view) {
  for (const e of view.events.slice(app.seen)) { const line = eventLine(e); if (line) app.log.push(line); }
  app.seen = view.events.length;
  const list = $('cn-log');
  fill(list, app.log.slice(-200).map((line) => el('li', { text: line })));
  list.scrollTop = list.scrollHeight;
}

function render() {
  const view = app.game.view(app.me);
  app.view = view;
  indexView(view);
  $('cn-board').hidden = false;
  renderSide($('cn-opp'), view, 1 - app.me);
  renderSide($('cn-you'), view, app.me);
  fill($('cn-mid'), el('span', { text: `第${view.turn}回合 · ${view.current === app.me ? '我的回合' : view.current === null ? '准备阶段' : '对手的回合'}` }),
    el('span', { text: `${view.formatRule ? '开放赛制' : ''} · 规则版本 ${view.ruleset.region}/${view.ruleset.version}` }));
  renderHand(view); renderPrompt(view); renderActions(view); renderLog(view);
  if (view.result) showResult(view.result);
}

function showResult(result) {
  $('cn-result').hidden = false;
  $('cn-result-title').textContent = result.winner === null ? '平局' : result.winner === app.me ? '你获胜了！' : '对手获胜';
  let reason = REASON[result.reason] ?? result.reason;
  if (result.reason === 'ordinary' && result.winner !== null) {
    const loser = app.view.players[1 - result.winner], winner = app.view.players[result.winner];
    reason = !loser.active && !loser.bench.length ? `${who(1 - result.winner)}的场上已没有宝可梦。` :
      winner.prizes.count === 0 ? `${who(result.winner)}拿取了全部奖赏卡。` : reason;
  }
  $('cn-result-text').textContent = reason;
  localStorage.removeItem(SAVE_KEY);
}

function toast(text) {
  const t = $('cn-toast'); t.textContent = text; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
}

function save() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ releaseId: CN_RELEASE_ID, decks: app.decks, snapshot: app.game.snapshot() }));
  } catch { /* Storage is optional; a full quota only disables resume. */ }
}

function dispatch(player, revision, action) {
  try {
    app.game.dispatch({ player, expectedRevision: revision, action });
  } catch (error) {
    toast(`操作未被规则接受：${error.message}`);
  }
  app.selected = [];
  save(); render(); schedule();
}
const act = (action) => dispatch(app.me, app.view.revision, action);
const answer = (q, selected) => act({ type: 'answer', requestId: q.id, selected });

function schedule() {
  clearTimeout(app.timer);
  const view = app.view;
  if (!view || view.result) return;
  const humanTurn = !!view.pending || view.legalActions.length > 0;
  if (humanTurn && !app.auto) return;
  const actor = humanTurn ? app.me : 1 - app.me;
  app.timer = setTimeout(() => {
    const own = app.game.view(actor), action = app.ai(own, actor);
    if (!action) { toast('电脑无法行动，请检查对局状态。'); return; }
    dispatch(actor, own.revision, action);
  }, FAST ? 5 : actor === app.me ? 250 : 450);
}

function begin(game, catalog, decks) {
  Object.assign(app, { game, catalog, decks, ai: createAI(catalog), known: new Map(), monNames: new Map(), log: [], seen: 0, selected: [] });
  $('cn-start').hidden = true; $('cn-result').hidden = true;
  render(); save(); schedule();
}

async function start() {
  const mine = app.meta.decks.find((d) => d.id === $('cn-deck-me').value);
  const opponent = app.meta.decks.find((d) => d.id === $('cn-deck-opp').value);
  const list = (deck) => deck.cards.flatMap(([id, n]) => Array(n).fill(id));
  const seedParam = params.get('seed');
  const seed = seedParam ? seedParam.split(',').map(Number) : [...crypto.getRandomValues(new Uint32Array(4))];
  const { game, catalog } = await createReviewedGame({ json: app.json, trustedReleases: TRUSTED_RELEASES,
    decks: [list(mine), list(opponent)], seed, format: mine.format, matchMode: 'normal' });
  begin(game, catalog, [mine.id, opponent.id]);
}

async function resume() {
  const saved = JSON.parse(localStorage.getItem(SAVE_KEY));
  const { game, catalog } = await restoreReviewedGame({ json: app.json, trustedReleases: TRUSTED_RELEASES, snapshot: saved.snapshot });
  begin(game, catalog, saved.decks);
}

function deckInfo() {
  const deck = app.meta.decks.find((d) => d.id === $('cn-deck-me').value);
  if (!deck) return;
  fill($('cn-deck-info'), el('p', { text: deck.description }),
    el('p', {}, '卡表来源：', ...deck.sources.map((s, i) => el('span', {}, i ? '；' : '',
      s.url ? el('a', { href: s.url, target: '_blank', rel: 'noopener', text: '简中官方商品页' }) : `${s.title}（百科修订 ${s.revision}）`))));
}

async function load() {
  try {
    const [json, meta] = await Promise.all([fetch(`${DATA}release.json`).then((r) => r.text()), fetch(`${DATA}decks.json`).then((r) => r.json())]);
    if (meta.releaseId !== CN_RELEASE_ID) throw new Error('卡组数据与已安装的审核发布不一致。');
    Object.assign(app, { json, meta });
    for (const select of [$('cn-deck-me'), $('cn-deck-opp')])
      fill(select, meta.decks.map((d) => el('option', { value: d.id, text: d.name })));
    deckInfo();
    $('cn-start-btn').disabled = false;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch { saved = null; }
    $('cn-resume-btn').hidden = !(saved && saved.releaseId === CN_RELEASE_ID && saved.snapshot);
  } catch (error) {
    $('cn-load-error').hidden = false;
    $('cn-load-error').textContent = `无法载入审核卡池：${error.message}`;
  }
}

$('cn-start-btn').addEventListener('click', () => start().catch((e) => toast(`无法开始对局：${e.message}`)));
$('cn-resume-btn').addEventListener('click', () => resume().catch((e) => {
  localStorage.removeItem(SAVE_KEY); $('cn-resume-btn').hidden = true; toast(`存档无法恢复：${e.message}`);
}));
$('cn-deck-me').addEventListener('change', deckInfo);
$('cn-new').addEventListener('click', () => { clearTimeout(app.timer); $('cn-result').hidden = true; $('cn-start').hidden = false; load(); });
$('cn-again').addEventListener('click', () => { $('cn-result').hidden = true; $('cn-start').hidden = false; load(); });
$('cn-auto').addEventListener('change', (e) => { app.auto = e.target.checked; if (app.game) { render(); schedule(); } });
window.__cnOfficial = { view: (player = app.me) => app.game?.view(player) ?? null };
load();
