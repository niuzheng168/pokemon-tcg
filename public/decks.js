// 我的卡组: the player's saved decks (account server) and the deck builder.
//   decks.html             the list: play, edit, copy or delete a deck; start a new one, empty or from a preconstructed deck
//   decks.html?id=N        edit saved deck N
//   decks.html?new=1       a new empty deck; ?from=<preset id> a copy of a preconstructed deck
// Cards come from the card library (library.js, every card of the local library); every change is checked with
// deck-check.js, the same check the server and the table use. A list may hold cards whose rules are not implemented
// yet and be saved; a deck can be played once it is legal, which needs every card implemented.
import { requireUser, mountNav, apiJSON, esc, confirmDialog } from './account.js';
import { loadPool, mountLibrary, emptyFilters, showCard, thumbOf, energyIcon, compareCards, playBadge, KIND_ORDER, KIND_NAMES } from './library.js';
import { checkIndexedDeck, indexedDeckHints, deckCount, DECK_SIZE, FORMAT_NAMES } from './deck-check.js';

const main = document.querySelector('#decks-main');
const params = new URLSearchParams(location.search);
const NAME_MAX = 40;
let pool;

const user = await requireUser();
mountNav(document.querySelector('#site-nav'), user, 'decks');
try {
  pool = await loadPool();
} catch (err) {
  const secure = window.isSecureContext && crypto?.subtle;
  main.innerHTML = `<p class="load-error">${esc(secure ? `卡牌数据载入失败：${err.message}` : '需要通过 HTTPS（或本机 localhost）打开，才能校验卡牌数据。')}</p>`;
  throw err;
}

const presets = pool.meta.decks;
const playURL = (id) => `./?deck=user:${id}`;
const shortDate = (iso) => new Date(iso).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const clip = (name) => [...name].slice(0, NAME_MAX).join('');

// The Pokémon a list is built around (rule-box and higher stages first, then the most copies), one per name.
const RULE_BOX = ['ex', 'V', 'GX', 'EX', 'Radiant', 'Prism Star'];
function featured(cards) {
  const rank = (c) => (c.stage === 'basic' ? 0 : c.stage === 'stage1' ? 1 : 2);
  const ruleBox = (c) => +c.features.some((f) => RULE_BOX.includes(f));
  const mons = cards.map(([id, n]) => ({ c: pool.byId.get(id), n })).filter((x) => x.c?.kind === 'pokemon')
    .sort((a, b) => (ruleBox(b.c) - ruleBox(a.c)) * 100 + (rank(b.c) - rank(a.c)) * 10 + b.n - a.n);
  return [...new Map(mons.map((x) => [x.c.name, x.c])).values()].slice(0, 3);
}
function mainTypes(cards) {
  const types = new Map();
  for (const [id, n] of cards) {
    const c = pool.byId.get(id);
    if (c?.kind === 'pokemon') types.set(c.types[0], (types.get(c.types[0]) ?? 0) + n);
  }
  return [...types].sort((a, b) => b[1] - a[1]).map(([x]) => x).slice(0, 2);
}

// ---------------- The list ----------------
async function showList() {
  const { decks } = await apiJSON('/api/decks');
  document.title = '我的卡组 · 宝可梦卡牌学堂';
  main.innerHTML = `<div class="page-title">
      <h1>我的卡组</h1>
      <p>用卡牌库里的卡组建自己的卡组。卡组凑满 ${DECK_SIZE} 张、符合所选赛制的构筑规则，并且每张卡的对战规则都已实现后，就可以在对战页面使用；没完成的卡组也可以先保存。</p>
    </div>
    <div class="deck-toolbar">
      <a class="button primary" href="decks.html?new=1"><i class="ic ic-circle-plus"></i> 新建空白卡组</a>
      <span class="from-preset">
        <label for="preset">以预组为模板：</label>
        <select id="preset">${presets.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}</select>
        <button id="from-preset">复制并编辑</button>
      </span>
    </div>
    <div class="my-decks">${decks.length ? decks.map(deckTile).join('') : '<p class="lib-empty">还没有保存的卡组。新建一套，或从预组复制一套开始改。</p>'}</div>`;
  main.querySelector('#from-preset').onclick = () => { location.href = `decks.html?from=${encodeURIComponent(main.querySelector('#preset').value)}`; };
  main.querySelectorAll('.my-deck').forEach((el) => {
    const deck = decks.find((d) => String(d.id) === el.dataset.id);
    el.querySelector('[data-act="copy"]').onclick = async () => {
      await apiJSON('/api/decks', { method: 'POST', body: { name: clip(`${deck.name}（副本）`), format: deck.format, cards: deck.cards } });
      showList();
    };
    el.querySelector('[data-act="delete"]').onclick = async () => {
      if (!(await confirmDialog(`删除卡组「${deck.name}」？删除后不能恢复。`, { ok: '删除', danger: true }))) return;
      await apiJSON(`/api/decks/${deck.id}`, { method: 'DELETE' });
      showList();
    };
  });
}

function deckTile(d) {
  const [c1, c2 = c1] = mainTypes(d.cards).length ? mainTypes(d.cards) : ['Colorless'];
  const status = d.legal ? '<span class="status ok">可以对战</span>' : '<span class="status no">未完成</span>';
  return `<article class="my-deck" data-id="${d.id}" style="--c1:var(--${c1});--c2:var(--${c2})">
    <div class="deck-art"><div class="fan">${featured(d.cards).map((c) => `<img src="${esc(thumbOf(c))}" alt="" loading="lazy">`).join('')}</div></div>
    <div class="md-body">
      <h3>${esc(d.name)}</h3>
      <p class="md-meta"><span class="chip">${esc(FORMAT_NAMES[d.format])}</span> <b>${d.count}</b> / ${DECK_SIZE} 张 ${status}</p>
      ${d.legal ? '' : `<p class="md-issue">${esc(d.issues[0])}${d.issues.length > 1 ? `（另有 ${d.issues.length - 1} 个问题）` : ''}</p>`}
      <p class="md-date">保存于 ${esc(shortDate(d.updatedAt))}</p>
      <div class="md-actions">
        ${d.legal ? `<a class="button primary" href="${playURL(d.id)}"><i class="ic ic-swords"></i> 对战</a>` : ''}
        <a class="button" href="decks.html?id=${d.id}">编辑</a>
        <button data-act="copy">复制</button>
        <button data-act="delete" class="ghost">删除</button>
      </div>
    </div>
  </article>`;
}

// ---------------- The builder ----------------
function showEditor(deck) {
  const cards = new Map(deck.cards);
  let id = deck.id ?? null;
  let saved = snapshot(); // what the server has (a new deck: what it started as)
  document.title = `${deck.name} · 编辑卡组`;
  main.innerHTML = `<div class="editor">
      <div class="ed-bar">
        <a class="textlink" href="decks.html" id="ed-back">← 我的卡组</a>
        <label class="ed-name">卡组名称<input id="ed-name" maxlength="${NAME_MAX}" value="${esc(deck.name)}"></label>
        <label class="ed-format">赛制<select id="ed-format">${Object.entries(FORMAT_NAMES).map(([v, l]) => `<option value="${v}" ${v === deck.format ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <span class="ed-count" id="ed-count"></span>
        <span class="ed-actions">
          <span class="ed-msg" id="ed-msg" role="status"></span>
          <a class="button" id="ed-play" hidden><i class="ic ic-swords"></i> 去对战</a>
          <button class="primary" id="ed-save">保存</button>
        </span>
      </div>
      <div class="ed-body">
        <div id="ed-library" class="library builder"></div>
        <div class="ed-deck">
          <div class="ed-check" id="ed-check"></div>
          <div id="ed-list"></div>
        </div>
      </div>
    </div>`;
  const $ = (s) => main.querySelector(s);
  const total = () => deckCount([...cards]);
  // A card the library no longer has (it was rebuilt) still shows, and can be taken out.
  const entry = (pid) => pool.byId.get(pid) ?? { id: pid, name: pid, nameKey: pid, kind: 'pokemon', types: [], limit: 4, groups: [],
    legal: {}, features: [], implemented: false, setCode: '', number: '', abilities: [], attacks: [], skills: [] };
  function snapshot() { return JSON.stringify({ name: deck.name.trim(), format: deck.format, cards: [...cards] }); }
  const dirty = () => snapshot() !== saved;

  const counted = (match) => {
    let n = 0;
    for (const [pid, k] of cards) if (match(entry(pid))) n += k;
    return n;
  };
  const builder = {
    count: (pid) => cards.get(pid) ?? 0,
    canAdd(pid) {
      const c = entry(pid);
      return total() < DECK_SIZE && (c.limit === null || counted((x) => x.nameKey === c.nameKey) < c.limit)
        && c.groups.every((g) => counted((x) => x.groups.some((y) => y.key === g.key)) < g.maximum);
    },
    add(pid) { if (builder.canAdd(pid)) { cards.set(pid, builder.count(pid) + 1); changed(); } },
    remove(pid) {
      const n = builder.count(pid) - 1;
      if (n > 0) cards.set(pid, n); else cards.delete(pid);
      changed();
    },
  };
  const lib = mountLibrary($('#ed-library'), pool, { filters: { ...emptyFilters(), format: deck.format }, deck: builder });

  let renderRevision = 0;
  async function renderDeck() {
    const revision = ++renderRevision, selected = [...cards], format = deck.format;
    const list = [...cards].map(([pid, n]) => ({ c: entry(pid), n })).sort((a, b) => compareCards(a.c, b.c));
    const check = indexedDeckHints(pool.index, selected, format, pool);
    $('#ed-count').innerHTML = `<b class="${check.count === DECK_SIZE ? 'full' : ''}">${check.count}</b> / ${DECK_SIZE} 张`;
    $('#ed-check').innerHTML = check.legal
      ? '<p class="status">正在载入所需分片，由规则内核校验卡组…</p>'
      : `<p class="status no"><i class="ic ic-triangle-alert"></i> 还不能对战：</p><ul class="ed-issues">${check.issues.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
    $('#ed-list').innerHTML = KIND_ORDER.map((k) => {
      const rows = list.filter((x) => x.c.kind === k);
      const n = rows.reduce((s, x) => s + x.n, 0);
      return `<section class="ed-group"><h3>${KIND_NAMES[k]} <small>${n}</small></h3>${rows.length ? rows.map(({ c, n: k2 }) => `
        <div class="ed-row" data-id="${esc(c.id)}">
          <button class="ed-thumb" data-act="info" title="查看卡牌详情"><img src="${esc(thumbOf(c))}" alt="" loading="lazy"></button>
          <span class="ed-card">${c.types[0] ? energyIcon(c.types[0]) : ''}<span><b>${esc(c.name)}</b>${playBadge(c)}<small>${esc([c.setCode, c.number].filter(Boolean).join(' '))}${c.legal[deck.format] ? '' : ` · <em>${esc(FORMAT_NAMES[deck.format])}不可用</em>`}</small></span></span>
          <span class="ed-ctl"><button data-act="remove" aria-label="移除 1 张">−</button><b>${k2}</b><button data-act="add" ${builder.canAdd(c.id) ? '' : 'disabled'} aria-label="加入 1 张">＋</button></span>
        </div>`).join('') : '<p class="ed-none">（无）</p>'}</section>`;
    }).join('');
    $('#ed-play').hidden = true;
    $('#ed-save').disabled = (id && !dirty()) || !deck.name.trim();
    const checked = await checkIndexedDeck(pool.release, pool.index, selected, format, pool);
    // A slow earlier request must not re-enable play after the user edits cards
    // or changes format. Shard transport itself is shared/cached by the release.
    if (revision !== renderRevision) return;
    $('#ed-check').innerHTML = checked.legal
      ? `<p class="status ok"><i class="ic ic-circle-check"></i> 符合${esc(FORMAT_NAMES[format])}构筑规则，可以对战。</p>`
      : `<p class="status no"><i class="ic ic-triangle-alert"></i> 还不能对战：</p><ul class="ed-issues">${checked.issues.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
    const playable = id && checked.legal && !dirty();
    $('#ed-play').hidden = !playable;
    if (playable) $('#ed-play').href = playURL(id);
    $('#ed-save').disabled = (id && !dirty()) || !deck.name.trim();
  }
  function changed() {
    $('#ed-msg').textContent = '';
    lib.refresh();
    renderDeck();
  }

  $('#ed-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]'), pid = e.target.closest('.ed-row')?.dataset.id;
    if (!btn || !pid) return;
    if (btn.dataset.act === 'info') showCard(entry(pid));
    else builder[btn.dataset.act](pid);
  });
  $('#ed-name').oninput = (e) => { deck.name = e.target.value; changed(); };
  $('#ed-format').onchange = (e) => {
    deck.format = e.target.value;
    lib.setFilters({ format: deck.format });
    changed();
  };
  $('#ed-save').onclick = async () => {
    const body = { name: deck.name.trim(), format: deck.format, cards: [...cards] };
    $('#ed-save').disabled = true;
    try {
      const out = await apiJSON(id ? `/api/decks/${id}` : '/api/decks', { method: id ? 'PUT' : 'POST', body });
      id = out.deck.id;
      saved = snapshot();
      history.replaceState(null, '', `decks.html?id=${id}`);
      document.title = `${out.deck.name} · 编辑卡组`;
      $('#ed-msg').textContent = out.deck.legal ? '已保存，可以对战。' : '已保存（还不能对战）。';
    } catch (err) {
      $('#ed-msg').textContent = `保存失败：${err.message}`;
    }
    renderDeck();
  };
  $('#ed-back').onclick = async (e) => {
    if (!dirty()) return;
    e.preventDefault();
    if (await confirmDialog('有未保存的修改，确定离开吗？', { ok: '离开', danger: true })) { saved = snapshot(); location.href = 'decks.html'; }
  };
  window.addEventListener('beforeunload', (e) => { if (dirty()) e.preventDefault(); });
  renderDeck();
}

// ---------------- Route ----------------
try {
  if (params.has('id')) {
    const { deck } = await apiJSON(`/api/decks/${encodeURIComponent(params.get('id'))}`);
    showEditor(deck);
  } else if (params.has('from')) {
    const p = presets.find((d) => d.id === params.get('from')) ?? presets[0];
    showEditor({ name: clip(`${p.name}（副本）`), format: p.format.id, cards: p.cards });
  } else if (params.has('new')) {
    showEditor({ name: '新卡组', format: 'standard', cards: [] });
  } else {
    await showList();
  }
} catch (err) {
  main.innerHTML = `<p class="load-error">${esc(err.message)}</p><p><a class="textlink" href="decks.html">← 返回我的卡组</a></p>`;
}
