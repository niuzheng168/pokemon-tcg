// The card library: every printing of the reviewed release as one browsable entry — rules data from the verified
// catalog, card-face text and image from decks.json — with the filters and card view shared by the 卡牌库 page
// and the deck builder. Only these printings can be played, so they are the whole pool a deck is built from.
import { loadReviewedCatalogRelease } from './rules/engine.js';
import { TRUSTED_RELEASES, CN_RELEASE_ID } from './cn/trusted-releases.js';
import { damageText } from './match.js';
import { printingLegality, FORMAT_NAMES } from './deck-check.js';
import { t, CARD_BACK } from './i18n.js';
import { esc, dialog } from './account.js';

export const DATA = 'data/cn/V20261019/';
export const KIND_ORDER = ['pokemon', 'trainer', 'energy'];
export const KIND_NAMES = { pokemon: '宝可梦', trainer: '训练家', energy: '能量' };
export const TYPE_ORDER = ['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal', 'Dragon', 'Colorless'];
export const STAGE_NAMES = { basic: '基础', stage1: '1阶进化', stage2: '2阶进化' };
export const CATEGORY_ORDER = ['supporter', 'item', 'tool', 'stadium', 'basic', 'special'];
export const CATEGORY_NAMES = { item: '物品', tool: '宝可梦道具', supporter: '支援者', stadium: '竞技场', basic: '基本能量', special: '特殊能量' };
export const FEATURE_NAMES = { ex: '宝可梦ex', ability: '有特性', Ancient: '古代', Future: '未来', Tera: '太晶', acespec: 'ACE SPEC' };
const SORTS = { default: '默认（种类、属性）', name: '名称', hp: 'HP 从高到低', set: '系列与卡号' };
export const NO_MARK = '-';

export const typeName = (type) => t('type.' + type);
export const energyIcon = (type) => `<span class="ei ei-${type}" style="--c:var(--${type})" title="${esc(typeName(type))}"><i></i></span>`;
export const imageOf = (card) => card?.image || CARD_BACK;
const slug = (id) => id.split(':').at(-1);
const has = (text, needle) => text.toLowerCase().includes(needle.trim().toLowerCase());

// One entry per printing.
export function cardEntries(catalog, presentation) {
  const legality = printingLegality(catalog), defs = catalog.definitions();
  return catalog.printings().map((p) => {
    const d = catalog.definitionFor(p.printingId), m = d.mechanics, info = presentation[p.printingId] ?? {}, texts = info.texts ?? {};
    const c = { id: p.printingId, definitionId: d.definitionId, name: d.name, nameKey: d.nameKey, kind: d.kind, limit: d.deckLimits.sameName,
      setCode: p.setCode, number: p.number, mark: p.regulationMark, releasedOn: p.releasedOn, image: info.image ?? null,
      legal: legality.get(p.printingId), category: null, stage: null, types: [], hp: null, weakness: null, resistance: null, retreat: null,
      evolvesFrom: null, tags: m.tags ?? [], aceSpec: d.deckLimits.groups.some((g) => g.key === 'cn-ace-spec'),
      attacks: [], abilities: [], text: texts.card ?? '', rule: texts.rule ?? '', tera: texts.tera ?? '' };
    const attack = (a) => ({ name: a.name, cost: a.cost, damage: damageText(a.printedDamage), text: texts[slug(a.attackId)] ?? '' });
    if (d.kind === 'pokemon') {
      Object.assign(c, { stage: m.stage, types: m.types, hp: m.hp, weakness: m.weakness, resistance: m.resistance, retreat: m.retreatCost,
        evolvesFrom: m.evolvesFrom ? defs.find((x) => x.nameKey === m.evolvesFrom)?.name ?? m.evolvesFrom : null,
        attacks: m.attacks.map(attack), abilities: m.abilities.map((a) => ({ name: a.name, text: texts[slug(a.abilityId)] ?? '' })) });
    } else if (d.kind === 'trainer') {
      Object.assign(c, { category: m.category, attacks: (m.grantedAttacks ?? []).map(attack) });
    } else {
      Object.assign(c, { category: m.category, types: m.category === 'basic' ? m.baseUnits[0] : [] });
    }
    c.features = [c.tags.includes('ex') && 'ex', c.abilities.length && 'ability', ...['Ancient', 'Future', 'Tera'].filter((x) => c.tags.includes(x)),
      c.aceSpec && 'acespec'].filter(Boolean);
    c.skills = [...c.abilities, ...c.attacks];
    c.search = [c.name, ...c.skills.flatMap((s) => [s.name, s.text]), c.text, c.rule, c.tera, c.setCode, c.number].join('\n');
    return c;
  });
}

// The verified release (WebCrypto: HTTPS or localhost) and its library entries.
export async function loadPool() {
  const [json, meta] = await Promise.all([fetch(DATA + 'release.json').then((r) => r.text()), fetch(DATA + 'decks.json').then((r) => r.json())]);
  if (meta.releaseId !== CN_RELEASE_ID) throw new Error(t('ui.releaseMismatch'));
  const catalog = await loadReviewedCatalogRelease({ json, trustedReleases: TRUSTED_RELEASES });
  const cards = cardEntries(catalog, meta.cards);
  return { catalog, meta, cards, byId: new Map(cards.map((c) => [c.id, c])) };
}

// ---------------- Filtering ----------------
export const emptyFilters = () => ({ q: '', name: '', skill: '', kind: '', types: [], stage: '', category: '', features: [],
  format: '', set: '', mark: '', hpMin: '', hpMax: '', weakness: '', retreat: '', sort: 'default' });

const rank = (list, x) => (list.includes(x) ? list.indexOf(x) : list.length);
const bySet = (a, b) => a.setCode.localeCompare(b.setCode) || a.number.localeCompare(b.number, 'en', { numeric: true });
const SORTERS = {
  default: (a, b) => rank(KIND_ORDER, a.kind) - rank(KIND_ORDER, b.kind) || rank(TYPE_ORDER, a.types[0]) - rank(TYPE_ORDER, b.types[0])
    || rank(CATEGORY_ORDER, a.category) - rank(CATEGORY_ORDER, b.category) || rank(Object.keys(STAGE_NAMES), a.stage) - rank(Object.keys(STAGE_NAMES), b.stage)
    || a.name.localeCompare(b.name, 'zh-Hans-CN') || bySet(a, b),
  name: (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || bySet(a, b),
  hp: (a, b) => (b.hp ?? -1) - (a.hp ?? -1) || SORTERS.default(a, b),
  set: bySet,
};
export const compareCards = SORTERS.default;

export function filterCards(cards, f) {
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const hpMin = num(f.hpMin), hpMax = num(f.hpMax), retreat = num(f.retreat);
  return cards.filter((c) =>
    (!f.q.trim() || has(c.search, f.q))
    && (!f.name.trim() || has(c.name, f.name))
    && (!f.skill.trim() || c.skills.some((s) => has(`${s.name}\n${s.text}`, f.skill)))
    && (!f.kind || c.kind === f.kind)
    && (!f.types.length || c.types.some((x) => f.types.includes(x)))
    && (!f.stage || c.stage === f.stage)
    && (!f.category || c.category === f.category)
    && f.features.every((x) => c.features.includes(x))
    && (!f.format || c.legal[f.format])
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
const sub = (c) => (c.kind === 'pokemon' ? `${STAGE_NAMES[c.stage]} · HP ${c.hp}` : CATEGORY_NAMES[c.category] ?? KIND_NAMES[c.kind]);

export function legalityBadges(c) {
  return Object.keys(FORMAT_NAMES).map((f) => `<span class="legal-badge ${c.legal[f] ? 'ok' : 'no'}" title="${esc(FORMAT_NAMES[f])}${c.legal[f] ? '可用' : '不可用'}">${c.legal[f] ? '' : '非'}${f === 'standard' ? '标准' : '开放'}</span>`).join('');
}

export function cardDetailHTML(c) {
  const head = c.kind === 'pokemon'
    ? `<p class="cd-sub">${esc(STAGE_NAMES[c.stage])}${c.evolvesFrom ? `（由「${esc(c.evolvesFrom)}」进化）` : ''} · HP <b>${c.hp}</b> · ${c.types.map((x) => `${energyIcon(x)} ${esc(typeName(x))}`).join(' ')}</p>`
    : `<p class="cd-sub">${esc(KIND_NAMES[c.kind])} · ${esc(CATEGORY_NAMES[c.category] ?? '')}${c.aceSpec ? ' · ACE SPEC' : ''}${c.types.length ? ` · ${energyIcon(c.types[0])} ${esc(typeName(c.types[0]))}` : ''}</p>`;
  const skills = [
    ...c.abilities.map((a) => `<div class="cd-skill"><div class="cd-skill-head"><span class="ability-tag">特性</span><b>${esc(a.name)}</b></div>${a.text ? `<p>${esc(a.text)}</p>` : ''}</div>`),
    ...c.attacks.map((a) => `<div class="cd-skill"><div class="cd-skill-head"><span class="cost">${costIcons(a.cost)}</span><b>${esc(a.name)}</b><span class="dmg">${esc(a.damage)}</span></div>${a.text ? `<p>${esc(a.text)}</p>` : ''}</div>`),
  ].join('');
  const facts = c.kind === 'pokemon' ? `<dl class="cd-facts">
      <dt>弱点</dt><dd>${c.weakness ? `${energyIcon(c.weakness.type)} ×${c.weakness.value}` : '无'}</dd>
      <dt>抗性</dt><dd>${c.resistance ? `${energyIcon(c.resistance.type)} -${c.resistance.value}` : '无'}</dd>
      <dt>撤退</dt><dd>${c.retreat ? costIcons(Array(c.retreat).fill('Colorless')) : '0'}</dd>
    </dl>` : '';
  return `<div class="card-detail">
    <img class="cd-img" src="${esc(imageOf(c))}" alt="${esc(c.name)}">
    <div class="cd-body">
      <h2>${esc(c.name)}</h2>
      ${head}
      ${skills}
      ${c.text ? `<p class="cd-text">${esc(c.text)}</p>` : ''}
      ${facts}
      ${c.tera ? `<p class="cd-rule">${esc(c.tera)}</p>` : ''}
      ${c.rule ? `<p class="cd-rule">${esc(c.rule)}</p>` : ''}
      <p class="cd-print">${esc(c.setCode)} ${esc(c.number)} · 标记 ${esc(c.mark ?? '无')}${c.releasedOn ? ` · ${esc(c.releasedOn)} 发售` : ''}</p>
      <p class="cd-print">${legalityBadges(c)} ${c.limit === null ? '同名卡张数不限' : `同名卡最多 ${c.limit} 张`}</p>
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
// Filters on the left, matching cards on the right. In the deck builder `deck` adds −/＋ controls:
//   { count(id) → n, canAdd(id) → bool, add(id), remove(id) }
export function mountLibrary(root, pool, { filters = emptyFilters(), deck = null } = {}) {
  const cards = pool.cards, present = (pick) => [...new Set(cards.map(pick).filter((x) => x != null))];
  const types = TYPE_ORDER.filter((x) => cards.some((c) => c.types.includes(x)));
  const option = (v, label, sel) => `<option value="${esc(v)}" ${String(sel) === String(v) ? 'selected' : ''}>${esc(label)}</option>`;
  const select = (name, all, entries) => `<select name="${name}">${option('', all, filters[name])}${entries.map(([v, l]) => option(v, l, filters[name])).join('')}</select>`;
  const sets = present((c) => c.setCode).sort().map((s) => [s, `${s}（${cards.filter((c) => c.setCode === s).length}）`]);
  const marks = present((c) => c.mark ?? NO_MARK).sort().map((m) => [m, m === NO_MARK ? '无标记' : m]);
  const retreats = present((c) => c.retreat).sort().map((r) => [r, `${r} 个能量`]);
  const weak = TYPE_ORDER.filter((x) => cards.some((c) => c.weakness?.type === x)).map((x) => [x, typeName(x)]);

  root.innerHTML = `<form class="lib-filters" autocomplete="off">
      <div class="f-head"><b>筛选</b><button type="button" class="textlink" data-act="reset">重置</button></div>
      <label class="f-row">搜索<input type="search" name="q" placeholder="名称、招式、特性或效果文字" value="${esc(filters.q)}"></label>
      <label class="f-row">卡牌名称<input type="search" name="name" placeholder="如：皮卡丘" value="${esc(filters.name)}"></label>
      <label class="f-row">招式／特性<input type="search" name="skill" placeholder="名称或效果，如：伤害指示物" value="${esc(filters.skill)}"></label>
      <fieldset class="f-row"><legend>卡牌种类</legend><div class="seg">${[['', '全部'], ...KIND_ORDER.map((k) => [k, KIND_NAMES[k]])].map(([v, l]) =>
        `<label><input type="radio" name="kind" value="${v}" ${filters.kind === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></fieldset>
      <fieldset class="f-row"><legend>属性</legend><div class="type-pick">${types.map((x) =>
        `<label title="${esc(typeName(x))}"><input type="checkbox" name="types" value="${x}" ${filters.types.includes(x) ? 'checked' : ''}>${energyIcon(x)}<span>${esc(typeName(x))}</span></label>`).join('')}</div></fieldset>
      <div class="f-pair">
        <label class="f-row">进化阶段${select('stage', '全部', Object.entries(STAGE_NAMES))}</label>
        <label class="f-row">卡牌类别${select('category', '全部', CATEGORY_ORDER.map((k) => [k, CATEGORY_NAMES[k]]))}</label>
      </div>
      <fieldset class="f-row"><legend>特征</legend><div class="checks">${Object.entries(FEATURE_NAMES).map(([v, l]) =>
        `<label><input type="checkbox" name="features" value="${v}" ${filters.features.includes(v) ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></fieldset>
      <div class="f-pair">
        <label class="f-row">HP 最低<input type="number" name="hpMin" min="0" step="10" value="${esc(filters.hpMin)}"></label>
        <label class="f-row">HP 最高<input type="number" name="hpMax" min="0" step="10" value="${esc(filters.hpMax)}"></label>
      </div>
      <div class="f-pair">
        <label class="f-row">弱点${select('weakness', '全部', weak)}</label>
        <label class="f-row">撤退${select('retreat', '全部', retreats)}</label>
      </div>
      <label class="f-row">赛制${select('format', '全部', Object.entries(FORMAT_NAMES).map(([v, l]) => [v, `${l}可用`]))}</label>
      <div class="f-pair">
        <label class="f-row">系列${select('set', '全部', sets)}</label>
        <label class="f-row">标记${select('mark', '全部', marks)}</label>
      </div>
      <label class="f-row">排序<select name="sort">${Object.entries(SORTS).map(([v, l]) => option(v, l, filters.sort)).join('')}</select></label>
    </form>
    <section class="lib-results">
      <p class="lib-count" aria-live="polite"></p>
      <div class="lib-grid"></div>
    </section>`;
  const form = root.querySelector('form'), grid = root.querySelector('.lib-grid'), count = root.querySelector('.lib-count');
  let state = filters;

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
    return `<div class="lib-card ${n ? 'in-deck' : ''}" data-id="${esc(c.id)}">
      <button type="button" class="lib-img" data-act="info" title="查看卡牌详情"><img src="${esc(imageOf(c))}" alt="${esc(c.name)}" loading="lazy"></button>
      <div class="lib-name">${esc(c.name)}</div>
      <div class="lib-sub">${c.types.slice(0, 2).map(energyIcon).join('')}<span>${esc(sub(c))}</span></div>
      <div class="lib-meta"><span>${esc(c.setCode)} ${esc(c.number)}</span>${legalityBadges(c)}</div>
      ${controls}
    </div>`;
  }
  function render() {
    const list = filterCards(cards, state);
    count.textContent = `共 ${list.length} 张（卡池 ${cards.length} 张）`;
    grid.innerHTML = list.length ? list.map(tile).join('') : '<p class="lib-empty">没有符合条件的卡牌。</p>';
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
