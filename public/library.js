// The card library: every card of the local library (~13,700 Simplified Chinese cards, /api/library) joined with the
// verified release (card-pool.js), with the filters and card view shared by the 卡牌库 page and the deck builder.
// Cards the release implements can be played; the others can be browsed and saved in a list, marked 未实现.
import { openCNRelease, DATA } from './cn-release.js';
import { IMPLEMENTATION_NAMES } from './card-quality.js';
import { CN_RELEASE_ID } from './cn/trusted-releases.js';
import { FORMAT_NAMES } from './deck-check.js';
import { buildIndexedPool, FEATURES } from './card-pool.js';
import { overlayIndexedCards } from './card-facts.js';
import { t, CARD_BACK } from './i18n.js';
import { esc, dialog } from './account.js';

export { DATA };
export const KIND_ORDER = ['pokemon', 'trainer', 'energy'];
export const KIND_NAMES = { pokemon: '宝可梦', trainer: '训练家', energy: '能量' };
export const TYPE_ORDER = ['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal', 'Fairy', 'Dragon', 'Colorless'];
export const STAGE_NAMES = { basic: '基础', stage1: '1阶进化', stage2: '2阶进化', vmax: 'VMAX', vstar: 'VSTAR', 'v-union': 'V-UNION',
  break: 'BREAK', mega: 'M进化', legend: '传说', levelup: '升级' };
export const CATEGORY_ORDER = ['supporter', 'item', 'tool', 'stadium', 'basic', 'special'];
export const CATEGORY_NAMES = { item: '物品', tool: '宝可梦道具', supporter: '支援者', stadium: '竞技场', basic: '基本能量', special: '特殊能量' };
export const SERIES_NAMES = { 'scarlet-violet': '朱&紫', 'sword-shield': '剑&盾', 'sun-moon': '太阳&月亮',
  '30th': '30周年', 'anniversary-30': '30周年', mega: '超级进化', other: '其他' };
const REVIEW_NAMES = { reviewed: '人工逐字核对卡图', 'machine-image-checked': '机器采集，已与卡图比对', 'human-fields': '机器采集，部分字段人工确认',
  'machine-reprint': '沿用逐字段一致的已核对重印（本印刷无图）', machine: '机器采集（尚未与卡图核对）' };
const SORTS = { default: '默认（种类、属性）', name: '名称', hp: 'HP 从高到低', new: '发售日从新到旧', set: '系列与卡号' };
export const NO_MARK = '-';
const PAGE = 120;

export const typeName = (type) => t('type.' + type);
export const energyIcon = (type) => `<span class="ei ei-${type}" style="--c:var(--${type})" title="${esc(typeName(type))}"><i></i></span>`;
export const imageOf = (card) => card?.image || CARD_BACK;
export const thumbOf = (card) => card?.thumb || card?.image || CARD_BACK;
const has = (text, needle) => text.toLowerCase().includes(needle.trim().toLowerCase());
const printed = (c) => [c.setCode, c.number].filter(Boolean).join(' ');

// The verified release (WebCrypto: HTTPS or localhost) and the card library joined with it.
export async function loadPool() {
  const get = (url, as) => fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r[as]();
  });
  const [release, meta, library] = await Promise.all([openCNRelease(), get(DATA + 'decks.json', 'json'), get('/api/library', 'json')]);
  if (meta.releaseId !== CN_RELEASE_ID) throw new Error(t('ui.releaseMismatch'));
  const index = await release.index();
  const { cards, byId } = buildIndexedPool(overlayIndexedCards(library.cards, index, meta.cards), index);
  return { release, index, meta, cards, byId, sets: setsOf(cards) };
}

// The sets present, newest first: {code, name, count, releasedOn}.
function setsOf(cards) {
  const sets = new Map();
  for (const c of cards) {
    const s = sets.get(c.setCode) ?? { code: c.setCode, name: c.setName, count: 0, releasedOn: c.releasedOn ?? '' };
    s.count++;
    s.name ??= c.setName;
    if ((c.releasedOn ?? '') > s.releasedOn) s.releasedOn = c.releasedOn;
    sets.set(c.setCode, s);
  }
  return [...sets.values()].sort((a, b) => b.releasedOn.localeCompare(a.releasedOn) || a.code.localeCompare(b.code));
}

// ---------------- Filtering ----------------
export const emptyFilters = () => ({ q: '', name: '', skill: '', kind: '', types: [], stage: '', category: '', features: [],
  play: '', format: '', series: '', set: '', mark: '', hpMin: '', hpMax: '', weakness: '', retreat: '', sort: 'default' });

const rank = (list, x) => (list.includes(x) ? list.indexOf(x) : list.length);
const bySet = (a, b) => a.setCode.localeCompare(b.setCode) || (a.number ?? '').localeCompare(b.number ?? '', 'en', { numeric: true });
const SORTERS = {
  default: (a, b) => rank(KIND_ORDER, a.kind) - rank(KIND_ORDER, b.kind) || rank(TYPE_ORDER, a.types[0]) - rank(TYPE_ORDER, b.types[0])
    || rank(CATEGORY_ORDER, a.category) - rank(CATEGORY_ORDER, b.category) || rank(Object.keys(STAGE_NAMES), a.stage) - rank(Object.keys(STAGE_NAMES), b.stage)
    || a.name.localeCompare(b.name, 'zh-Hans-CN') || bySet(a, b),
  name: (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || bySet(a, b),
  hp: (a, b) => (b.hp ?? -1) - (a.hp ?? -1) || SORTERS.default(a, b),
  new: (a, b) => (b.releasedOn ?? '').localeCompare(a.releasedOn ?? '') || bySet(a, b),
  set: bySet,
};
export const compareCards = SORTERS.default;

export function filterCards(cards, f) {
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const hpMin = num(f.hpMin), hpMax = num(f.hpMax), retreat = num(f.retreat), q = f.q.trim().toLowerCase();
  return cards.filter((c) =>
    (!q || c.search.includes(q))
    && (!f.name.trim() || has(c.name, f.name))
    && (!f.skill.trim() || c.skills.some((s) => has(`${s.name}\n${s.text}`, f.skill)))
    && (!f.kind || c.kind === f.kind)
    && (!f.types.length || c.types.some((x) => f.types.includes(x)))
    && (!f.stage || c.stage === f.stage)
    && (!f.category || c.category === f.category)
    && f.features.every((x) => c.features.includes(x))
    && (!f.play || c.implemented === (f.play === 'yes'))
    && (!f.format || c.legal[f.format])
    && (!f.series || c.series === f.series)
    && (!f.set || c.setCode === f.set)
    && (!f.mark || (c.mark ?? NO_MARK) === f.mark)
    && (hpMin === null || (c.hp !== null && c.hp >= hpMin))
    && (hpMax === null || (c.hp !== null && c.hp <= hpMax))
    && (!f.weakness || c.weakness?.type === f.weakness)
    && (retreat === null || c.retreat === retreat),
  ).sort(SORTERS[f.sort] ?? SORTERS.default);
}

// ---------------- Card view ----------------
const costIcons = (cost) => (cost.length ? cost.map(energyIcon).join('') : '<span class="no-cost">—</span>');
const sub = (c) => (c.kind === 'pokemon' ? `${STAGE_NAMES[c.stage] ?? ''}${c.hp ? ` · HP ${c.hp}` : ''}` : CATEGORY_NAMES[c.category] ?? KIND_NAMES[c.kind]);

export function legalityBadges(c) {
  return Object.keys(FORMAT_NAMES).map((f) => `<span class="legal-badge ${c.legal[f] ? 'ok' : 'no'}" title="${esc(FORMAT_NAMES[f])}${c.legal[f] ? '可用' : '不可用'}">${c.legal[f] ? '' : '非'}${f === 'standard' ? '标准' : '开放'}</span>`).join('');
}
export const playBadge = (c) => c.implemented
  ? `<span class="impl-badge ${c.implementation}" title="${c.implementation === 'machine' ? '机器核对／实现，未经人工逐张审核' : '卡面及实现已经人工审核'}">${IMPLEMENTATION_NAMES[c.implementation]}</span>`
  : '<span class="impl-badge" title="这张卡的对战规则还没有实现，暂时不能用于对战">未实现</span>';

export function cardDetailHTML(c) {
  const head = c.kind === 'pokemon'
    ? `<p class="cd-sub">${esc(STAGE_NAMES[c.stage] ?? '')}${c.evolvesFrom ? `（由「${esc(c.evolvesFrom)}」进化）` : ''}${c.hp ? ` · HP <b>${c.hp}</b>` : ''} · ${c.types.map((x) => `${energyIcon(x)} ${esc(typeName(x))}`).join(' ')}</p>`
    : `<p class="cd-sub">${esc(KIND_NAMES[c.kind])} · ${esc(CATEGORY_NAMES[c.category] ?? '')}${c.features.includes('acespec') ? ' · ACE SPEC' : ''}${c.types.length ? ` · ${energyIcon(c.types[0])} ${esc(typeName(c.types[0]))}` : ''}</p>`;
  const skills = [
    ...c.abilities.map((a) => `<div class="cd-skill"><div class="cd-skill-head"><span class="ability-tag">特性</span><b>${esc(a.name)}</b></div>${a.text ? `<p>${esc(a.text)}</p>` : ''}</div>`),
    ...c.attacks.map((a) => `<div class="cd-skill"><div class="cd-skill-head"><span class="cost">${costIcons(a.cost)}</span><b>${esc(a.name)}</b><span class="dmg">${esc(a.damage)}</span></div>${a.text ? `<p>${esc(a.text)}</p>` : ''}</div>`),
  ].join('');
  const facts = c.kind === 'pokemon' ? `<dl class="cd-facts">
      <dt>弱点</dt><dd>${c.weakness?.type ? `${energyIcon(c.weakness.type)} ${esc(c.weakness.value)}` : '无'}</dd>
      <dt>抗性</dt><dd>${c.resistance?.type ? `${energyIcon(c.resistance.type)} ${esc(c.resistance.value)}` : '无'}</dd>
      <dt>撤退</dt><dd>${c.retreat ? costIcons(Array(c.retreat).fill('Colorless')) : c.retreat === 0 ? '0' : '—'}</dd>
    </dl>` : '';
  const features = c.features.filter((f) => !['ability', 'acespec'].includes(f)).map((f) => `<span class="chip">${esc(FEATURES[f])}</span>`).join(' ');
  return `<div class="card-detail">
    <img class="cd-img" src="${esc(imageOf(c))}" alt="${esc(c.name)}">
    <div class="cd-body">
      <h2>${esc(c.name)}</h2>
      ${head}
      ${features ? `<p class="cd-print">${features}</p>` : ''}
      ${skills}
      ${c.text ? `<p class="cd-text">${esc(c.text)}</p>` : ''}
      ${facts}
      ${c.rule ? `<p class="cd-rule">${esc(c.rule)}</p>` : ''}
      <p class="cd-print">${esc(c.setName ?? '')} ${esc(printed(c))} · 标记 ${esc(c.mark ?? '无')}${c.rarity ? ` · ${esc(c.rarity)}` : ''}${c.releasedOn ? ` · ${esc(c.releasedOn)} 发售` : ''}${c.illustrator ? ` · 插画 ${esc(c.illustrator)}` : ''}</p>
      <p class="cd-print">${legalityBadges(c)} ${c.limit === null ? '同名卡张数不限' : `同名卡最多 ${c.limit} 张`}</p>
      <p class="cd-print ${c.implemented ? 'cd-ok' : 'cd-warn'}">${c.implemented
        ? `可以用于对战：${IMPLEMENTATION_NAMES[c.implementation]}${c.implementation === 'machine' ? '，未经人工逐张审核' : ''}。仍须符合所选赛制与构筑规则。`
        : '对战规则还没有实现：可以放进卡组保存，但暂时不能用于对战。'}</p>
      <p class="cd-print">卡面文字：${esc(REVIEW_NAMES[c.review] ?? c.review ?? '')}</p>
    </div>
  </div>`;
}

export function showCard(c, extra = '') {
  dialog(`<button class="close" data-act="close" aria-label="关闭"><i class="ic ic-x"></i></button>${cardDetailHTML(c)}${extra}`, (box, close) => {
    box.classList.add('wide');
    box.querySelector('[data-act="close"]').onclick = close;
  });
}

// ---------------- The library component ----------------
// Filters on the left, matching cards on the right, PAGE at a time (more as the list scrolls). In the deck builder
// `deck` adds −/＋ controls: { count(id) → n, canAdd(id) → bool, add(id), remove(id) }
export function mountLibrary(root, pool, { filters = emptyFilters(), deck = null } = {}) {
  const cards = pool.cards, present = (pick) => [...new Set(cards.map(pick).filter((x) => x != null))];
  const types = TYPE_ORDER.filter((x) => cards.some((c) => c.types.includes(x)));
  const option = (v, label, sel) => `<option value="${esc(v)}" ${String(sel) === String(v) ? 'selected' : ''}>${esc(label)}</option>`;
  const select = (name, all, entries) => `<select name="${name}">${option('', all, filters[name])}${entries.map(([v, l]) => option(v, l, filters[name])).join('')}</select>`;
  const sets = pool.sets.map((s) => [s.code, `${s.name ? `${s.name} ` : ''}${s.code}（${s.count}）`]);
  const marks = present((c) => c.mark ?? NO_MARK).sort().map((m) => [m, m === NO_MARK ? '无标记' : m]);
  const retreats = present((c) => c.retreat).sort().map((r) => [r, `${r} 个能量`]);
  const weak = TYPE_ORDER.filter((x) => cards.some((c) => c.weakness?.type === x)).map((x) => [x, typeName(x)]);
  const series = Object.entries(SERIES_NAMES).filter(([v]) => cards.some((c) => c.series === v));
  const stages = Object.entries(STAGE_NAMES).filter(([v]) => cards.some((c) => c.stage === v));
  const features = Object.entries(FEATURES).filter(([v]) => cards.some((c) => c.features.includes(v)));
  const playable = cards.filter((c) => c.implemented).length;

  root.innerHTML = `<form class="lib-filters" autocomplete="off">
      <div class="f-head"><b>筛选</b><button type="button" class="textlink" data-act="reset">重置</button></div>
      <label class="f-row">搜索<input type="search" name="q" placeholder="名称、招式、特性、效果文字或卡号" value="${esc(filters.q)}"></label>
      <label class="f-row">卡牌名称<input type="search" name="name" placeholder="如：皮卡丘" value="${esc(filters.name)}"></label>
      <label class="f-row">招式／特性<input type="search" name="skill" placeholder="名称或效果，如：伤害指示物" value="${esc(filters.skill)}"></label>
      <fieldset class="f-row"><legend>卡牌种类</legend><div class="seg">${[['', '全部'], ...KIND_ORDER.map((k) => [k, KIND_NAMES[k]])].map(([v, l]) =>
        `<label><input type="radio" name="kind" value="${v}" ${filters.kind === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></fieldset>
      <fieldset class="f-row"><legend>对战</legend><div class="seg">${[['', '全部'], ['yes', `可对战（${playable}）`], ['no', '未实现']].map(([v, l]) =>
        `<label><input type="radio" name="play" value="${v}" ${filters.play === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></fieldset>
      <fieldset class="f-row"><legend>属性</legend><div class="type-pick">${types.map((x) =>
        `<label title="${esc(typeName(x))}"><input type="checkbox" name="types" value="${x}" ${filters.types.includes(x) ? 'checked' : ''}>${energyIcon(x)}<span>${esc(typeName(x))}</span></label>`).join('')}</div></fieldset>
      <div class="f-pair">
        <label class="f-row">进化阶段${select('stage', '全部', stages)}</label>
        <label class="f-row">卡牌类别${select('category', '全部', CATEGORY_ORDER.map((k) => [k, CATEGORY_NAMES[k]]))}</label>
      </div>
      <fieldset class="f-row"><legend>特征</legend><div class="checks">${features.map(([v, l]) =>
        `<label><input type="checkbox" name="features" value="${esc(v)}" ${filters.features.includes(v) ? 'checked' : ''}><span>${esc(l)}</span></label>`).join('')}</div></fieldset>
      <div class="f-pair">
        <label class="f-row">HP 最低<input type="number" name="hpMin" min="0" step="10" value="${esc(filters.hpMin)}"></label>
        <label class="f-row">HP 最高<input type="number" name="hpMax" min="0" step="10" value="${esc(filters.hpMax)}"></label>
      </div>
      <div class="f-pair">
        <label class="f-row">弱点${select('weakness', '全部', weak)}</label>
        <label class="f-row">撤退${select('retreat', '全部', retreats)}</label>
      </div>
      <div class="f-pair">
        <label class="f-row">赛制${select('format', '全部', Object.entries(FORMAT_NAMES).map(([v, l]) => [v, `${l}可用`]))}</label>
        <label class="f-row">标记${select('mark', '全部', marks)}</label>
      </div>
      <label class="f-row">系列${select('series', '全部', series)}</label>
      <label class="f-row">卡包${select('set', '全部', sets)}</label>
      <label class="f-row">排序<select name="sort">${Object.entries(SORTS).map(([v, l]) => option(v, l, filters.sort)).join('')}</select></label>
    </form>
    <section class="lib-results">
      <p class="lib-count" aria-live="polite"></p>
      <div class="lib-grid"></div>
      <button type="button" class="lib-more" hidden>显示更多</button>
    </section>`;
  const form = root.querySelector('form'), grid = root.querySelector('.lib-grid'), count = root.querySelector('.lib-count');
  const more = root.querySelector('.lib-more');
  let state = filters, list = [], shown = 0;

  function read() {
    const fd = new FormData(form), f = emptyFilters();
    for (const k of Object.keys(f)) f[k] = Array.isArray(f[k]) ? fd.getAll(k) : (fd.get(k) ?? '');
    return f;
  }
  function tile(c) {
    const n = deck?.count(c.id) ?? 0;
    const controls = deck ? `<div class="lib-ctl">
        <button type="button" data-act="remove" ${n ? '' : 'disabled'} aria-label="从卡组移除 1 张">−</button>
        <span class="lib-n ${n ? 'on' : ''}">${n}</span>
        <button type="button" data-act="add" ${deck.canAdd(c.id) ? '' : 'disabled'} aria-label="加入卡组 1 张">＋</button>
      </div>` : '';
    return `<div class="lib-card ${n ? 'in-deck' : ''} ${c.implemented ? '' : 'not-impl'}" data-id="${esc(c.id)}">
      <button type="button" class="lib-img" data-act="info" title="查看卡牌详情"><img src="${esc(thumbOf(c))}" alt="${esc(c.name)}" loading="lazy"></button>
      <div class="lib-name">${esc(c.name)}</div>
      <div class="lib-sub">${c.types.slice(0, 2).map(energyIcon).join('')}<span>${esc(sub(c))}</span></div>
      <div class="lib-meta"><span>${esc(printed(c))}</span>${playBadge(c)}${legalityBadges(c)}</div>
      ${controls}
    </div>`;
  }
  function showMore() {
    grid.insertAdjacentHTML('beforeend', list.slice(shown, shown + PAGE).map(tile).join(''));
    shown = Math.min(list.length, shown + PAGE);
    more.hidden = shown >= list.length;
    more.textContent = `显示更多（还有 ${list.length - shown} 张）`;
  }
  function render() {
    list = filterCards(cards, state);
    shown = 0;
    count.textContent = `共 ${list.length} 张（卡牌库 ${cards.length} 张，其中 ${playable} 张可对战）`;
    grid.innerHTML = list.length ? '' : '<p class="lib-empty">没有符合条件的卡牌。</p>';
    showMore();
  }
  // The deck changed: update the counts in place (re-rendering would reload every image).
  function refresh() {
    for (const el of grid.querySelectorAll('.lib-card')) {
      const id = el.dataset.id, n = deck.count(id);
      el.classList.toggle('in-deck', n > 0);
      el.querySelector('.lib-n').textContent = n;
      el.querySelector('.lib-n').classList.toggle('on', n > 0);
      el.querySelector('[data-act="remove"]').disabled = !n;
      el.querySelector('[data-act="add"]').disabled = !deck.canAdd(id);
    }
  }
  function setFilters(changes) {
    state = { ...state, ...changes };
    for (const el of form.elements) {
      if (!el.name) continue;
      const v = state[el.name];
      if (el.type === 'checkbox') el.checked = v.includes(el.value);
      else if (el.type === 'radio') el.checked = v === el.value;
      else el.value = v;
    }
    render();
  }
  form.addEventListener('input', () => { state = read(); render(); });
  form.addEventListener('submit', (e) => e.preventDefault());
  form.querySelector('[data-act="reset"]').onclick = () => setFilters({ ...emptyFilters(), ...(deck ? { format: state.format } : {}) });
  more.onclick = showMore;
  new IntersectionObserver((seen) => { if (seen.some((x) => x.isIntersecting) && !more.hidden) showMore(); }, { rootMargin: '600px' }).observe(more);
  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]'), id = e.target.closest('.lib-card')?.dataset.id;
    if (!btn || !id) return;
    if (btn.dataset.act === 'info') showCard(pool.byId.get(id));
    else if (btn.dataset.act === 'add') deck.add(id);
    else if (btn.dataset.act === 'remove') deck.remove(id);
  });
  render();
  return { refresh, setFilters, filters: () => state };
}
