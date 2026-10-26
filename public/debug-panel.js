// The point-and-click face of the 调试台 (public/debug-console.js), for administrators at the table. Every button,
// menu and field writes one console command, shows it, and runs it the same way as a typed command, so the panel and
// the command line can never disagree and the record shows exactly what was done.
//   mountDebugPanel({ state: () => ({snapshot, catalog, matchId} | null), run: async (text) → {lines} (throws), imageOf })
//   → {toggle(), refresh(), close()}
import { COMMANDS, zonesOf } from './debug-console.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const WHO = ['你', '小茂'], SIDE = ['me', 'opp'];
const ZONES = [['hand', '手牌'], ['deck', '牌库（上方在前）'], ['prizes', '奖赏卡'], ['discard', '弃牌区'], ['lost', '放逐区']];
const MOVES = [['top', '放到牌库顶（下一张抽到）'], ['hand', '加入手牌'], ['bottom', '放到牌库底'], ['deck', '洗入牌库（随机位置）'],
  ['discard', '放入弃牌区'], ['prizes', '放入奖赏卡'], ['lost', '放入放逐区']];
const FLAGS = [['energy', '已从手牌附着能量'], ['supporter', '已使用支援者'], ['retreat', '已撤退'], ['stadium', '已使出竞技场']];
const STATUS = [['none', '无'], ['asleep', '睡眠'], ['paralyzed', '麻痹'], ['confused', '混乱']];
const quote = (x) => (/\s/.test(x) ? `"${x}"` : x);

export function mountDebugPanel({ state, run, imageOf }) {
  const el = document.createElement('aside');
  el.className = 'debug-panel';
  el.hidden = true;
  el.innerHTML = `<header><b>调试台</b><span class="dbg-sub"></span><button class="dbg-close" title="关闭">×</button></header>
    <nav class="dbg-tabs">${[['cards', '卡牌'], ['mons', '宝可梦'], ['turn', '回合'], ['help', '命令']]
      .map(([k, l]) => `<button data-tab="${k}">${l}</button>`).join('')}</nav>
    <div class="dbg-note" hidden></div>
    <div class="dbg-body"></div>
    <div class="dbg-out" aria-live="polite"></div>
    <div class="dbg-hint"></div>
    <form class="dbg-cmd"><input placeholder="输入命令，例如 /nextcard 老大的指令（/help 查看全部）" autocomplete="off" spellcheck="false"><button class="primary">执行</button></form>`;
  document.body.append(el);
  const body = el.querySelector('.dbg-body'), out = el.querySelector('.dbg-out'), input = el.querySelector('.dbg-cmd input');
  const hint = el.querySelector('.dbg-hint');
  let tab = 'cards', side = 0, menu = null, lastRevision = null;
  const history = [];
  let back = 0;

  // ---------------- Running a command ----------------
  function say(text, cls) {
    const line = document.createElement('div');
    line.className = cls;
    line.textContent = text;
    out.append(line);
    while (out.childElementCount > 200) out.firstElementChild.remove();
    out.scrollTop = out.scrollHeight;
  }
  async function exec(text) {
    text = text.trim();
    if (!text) return;
    if (!text.startsWith('/')) text = `/${text}`;
    closeMenu();
    say(`› ${text}`, 'cmd');
    if (history.at(-1) !== text) history.push(text);
    back = 0;
    try {
      for (const line of (await run(text)).lines ?? []) say(line, 'ok');
    } catch (error) {
      say(error.message, 'err');
    }
    lastRevision = null;
    setTimeout(refresh, 0);
  }
  el.querySelector('.dbg-cmd').onsubmit = (e) => { e.preventDefault(); exec(input.value); input.value = ''; showHint(); };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      back = Math.max(0, Math.min(history.length, back + (e.key === 'ArrowUp' ? 1 : -1)));
      input.value = back ? history[history.length - back] : '';
    } else if (e.key === 'Tab') {
      const word = input.value.trim().replace(/^\//, '');
      const match = COMMANDS.find((c) => !word.includes(' ') && c.name.startsWith(word));
      if (match) { e.preventDefault(); input.value = `/${match.name} `; showHint(); }
    } else if (e.key === 'Escape') toggle(false);
  };
  input.oninput = showHint;
  function showHint() {
    const word = input.value.trim().replace(/^\//, '').split(/\s+/)[0];
    const found = word ? COMMANDS.filter((c) => c.name.startsWith(word.toLowerCase()) || c.aliases?.some((a) => a.startsWith(word))) : [];
    hint.textContent = found.slice(0, 3).map((c) => c.usage).join('　');
  }
  el.querySelector('.dbg-close').onclick = () => toggle(false);
  el.querySelectorAll('.dbg-tabs button').forEach((b) => (b.onclick = () => { tab = b.dataset.tab; lastRevision = null; refresh(); }));
  // A control that runs a command: data-cmd="…"; a <select> runs data-cmd with {v} replaced by its value.
  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cmd]');
    if (b && b.tagName !== 'SELECT' && b.tagName !== 'INPUT') { exec(b.dataset.cmd); return; }
    const card = e.target.closest('.dbg-card');
    if (card) { openMenu(card); return; }
    const pick = e.target.closest('[data-side]');
    if (pick) { side = Number(pick.dataset.side); lastRevision = null; refresh(); }
    const fill = e.target.closest('[data-fill]');
    if (fill) { input.value = fill.dataset.fill; input.focus(); showHint(); }
  });
  body.addEventListener('change', (e) => {
    const c = e.target.closest('[data-cmd]');
    if (!c) return;
    if (c.type === 'checkbox') exec(c.dataset.cmd.replace('{v}', c.checked ? c.dataset.on ?? '1' : c.dataset.off ?? '0'));
    else if (c.tagName === 'SELECT' && c.value) exec(c.dataset.cmd.replace('{v}', quote(c.value)));
  });
  body.addEventListener('keydown', (e) => {
    const f = e.target.closest('input[data-cmd]');
    if (f && f.type !== 'checkbox' && e.key === 'Enter') exec(f.dataset.cmd.replace('{v}', f.value));
  });

  // ---------------- A card's menu ----------------
  function closeMenu() { menu?.remove(); menu = null; }
  function openMenu(chip) {
    closeMenu();
    const st = state();
    if (!st) return;
    const { snapshot: s, catalog } = st, id = chip.dataset.id, owner = s.cards[id].owner, zone = chip.dataset.zone;
    const d = catalog.definition(s.cards[id].definitionId), mons = [s.players[owner].active, ...s.players[owner].bench].filter(Boolean);
    const monName = (m) => catalog.definition(s.cards[m.stack.at(-1)].definitionId).name;
    const items = MOVES.filter(([to]) => !(to === zone || (zone === 'deck' && to === 'top' && s.players[owner].deck.at(-1) === id)))
      .map(([to, label]) => [to === 'top' ? `/nextcard ${id} ${SIDE[owner]}` : `/move ${id} ${to}`, label]);
    if (d.kind === 'pokemon' && d.mechanics.stage === 'basic') items.push([`/bench ${id} ${SIDE[owner]}`, '放到备战区']);
    if (d.kind === 'pokemon') mons.forEach((m) => items.push([`/evolve ${m.id} ${id}`, `叠放到「${monName(m)}」上（进化）`]));
    if (d.kind === 'energy' || d.mechanics.category === 'tool') mons.forEach((m) => items.push([`/attach ${id} ${m.id}`, `附着到「${monName(m)}」`]));
    if (d.mechanics.category === 'stadium') items.push([`/stadium ${id}`, '放到场上（竞技场）']);
    menu = document.createElement('div');
    menu.className = 'dbg-menu';
    menu.innerHTML = `<div class="dbg-menu-title">${esc(d.name)} <small>${esc(id)} · ${esc(s.cards[id].printingId.replace(/^zh-Hans:/, ''))}</small></div>
      ${items.map(([cmd, label]) => `<button data-run="${esc(cmd)}">${esc(label)}</button>`).join('')}
      <label>变成另一张卡：<select data-transform="${id}"><option value="">选择…</option>${printingOptions(catalog)}</select></label>`;
    el.append(menu);
    const r = chip.getBoundingClientRect(), pr = el.getBoundingClientRect();
    menu.style.top = `${Math.min(r.bottom - pr.top + 4, el.clientHeight - menu.offsetHeight - 8)}px`;
    menu.style.left = `${Math.max(8, Math.min(r.left - pr.left, el.clientWidth - menu.offsetWidth - 8))}px`;
    menu.onclick = (e) => { const b = e.target.closest('[data-run]'); if (b) exec(b.dataset.run); };
    menu.querySelector('select').onchange = (e) => e.target.value && exec(`/transform ${id} ${e.target.value}`);
  }
  document.addEventListener('pointerdown', (e) => { if (menu && !menu.contains(e.target) && !e.target.closest('.dbg-card')) closeMenu(); });

  let printingHtml = null;
  function printingOptions(catalog) {
    if (printingHtml) return printingHtml;
    const groups = { pokemon: [], trainer: [], energy: [] };
    for (const p of catalog.printings()) {
      const d = catalog.definitionFor(p.printingId), id = p.printingId.replace(/^zh-Hans:/, '');
      groups[d.kind]?.push([id, `${d.name}（${id}）`]);
    }
    printingHtml = Object.entries({ pokemon: '宝可梦', trainer: '训练家', energy: '能量' }).map(([k, l]) =>
      `<optgroup label="${l}">${groups[k].sort((a, b) => a[1].localeCompare(b[1], 'zh')).map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('')}</optgroup>`).join('');
    return printingHtml;
  }

  // ---------------- Tabs ----------------
  const chip = (c, zone, i) => `<button class="dbg-card" data-id="${c.id}" data-zone="${zone}" title="${esc(`${c.name} · ${c.id} · ${c.printingId.replace(/^zh-Hans:/, '')}`)}">
    ${zone === 'deck' ? `<i>${i + 1}</i>` : ''}<img src="${esc(imageOf(c.printingId))}" alt="" loading="lazy"><span>${esc(c.name)}</span></button>`;
  const sideTabs = () => `<div class="dbg-sides">${WHO.map((w, i) => `<button data-side="${i}" class="${i === side ? 'on' : ''}">${w}</button>`).join('')}</div>`;
  const options = (list, none = '选择…') => `<option value="">${none}</option>${list.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('')}`;

  function cardsTab({ snapshot: s, catalog }) {
    const z = zonesOf(s, catalog, side), who = SIDE[side];
    return `${sideTabs()}
      <div class="dbg-row"><button data-cmd="/shuffle ${side + 1}">洗牌库</button><button data-cmd="/draw 1 ${who}">抽 1 张</button>
        <label>奖赏卡 <select data-cmd="/prizes ${who} {v}">${[0, 1, 2, 3, 4, 5, 6].map((n) => `<option ${n === z.prizes.length ? 'selected' : ''}>${n}</option>`).join('')}</select></label></div>
      <p class="dbg-tip">点卡牌：放到牌库顶、加入手牌、附着、变成另一张卡……</p>
      ${ZONES.map(([k, label]) => `<section><h4>${label} <small>${z[k].length}</small></h4>
        <div class="dbg-cards">${z[k].map((c, i) => chip(c, k, i)).join('') || '<span class="dbg-empty">—</span>'}</div></section>`).join('')}`;
  }

  function monsTab({ snapshot: s, catalog }, view) {
    const name = (id) => catalog.definition(s.cards[id].definitionId).name;
    return [0, 1].map((owner) => {
      const p = s.players[owner], v = view(owner).players[owner], z = zonesOf(s, catalog, owner);
      const spare = [...z.hand, ...z.deck, ...z.discard, ...z.prizes, ...z.lost];
      const named = (test) => [...new Map(spare.filter(test).map((c) => [c.name, [c.name, c.name]])).values()];
      const basics = named((c) => c.kind === 'pokemon' && catalog.definition(s.cards[c.id].definitionId).mechanics.stage === 'basic');
      const attachable = named((c) => c.kind === 'energy' || c.category === 'tool');
      const evolutions = named((c) => c.kind === 'pokemon');
      const box = (m, i) => {
        const e = (i === 0 ? v.active : v.bench[i - 1]).effective, top = m.stack.at(-1), active = i === 0;
        const c = m.conditions;
        return `<div class="dbg-mon ${active ? 'active' : ''}">
          <div class="dbg-mon-head"><img src="${esc(imageOf(s.cards[top].printingId))}" alt=""><div><b>${esc(name(top))}</b>
            <small>${active ? '战斗宝可梦' : `备战${i}`} · ${m.id}${m.stack.length > 1 ? ` · 由${esc(m.stack.slice(0, -1).map(name).join('→'))}进化` : ''}</small></div></div>
          <div class="dbg-row"><label>HP <input type="number" min="10" max="${e.maxHp}" step="10" value="${e.currentHp}" data-cmd="/mon ${m.id} hp={v}"> / ${e.maxHp}</label>
            <button data-cmd="/mon ${m.id} heal">回复</button><button data-cmd="/mon ${m.id} ready">可进化</button></div>
          ${active ? `<div class="dbg-row"><label>状态 <select data-cmd="/mon ${m.id} status={v}">${STATUS.map(([k, l]) =>
              `<option value="${k}" ${(c.rotation ?? 'none') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
            <label><input type="checkbox" ${c.poison ? 'checked' : ''} data-cmd="/mon ${m.id} poison={v}" data-on="1" data-off="off"> 中毒</label>
            <label><input type="checkbox" ${c.burned ? 'checked' : ''} data-cmd="/mon ${m.id} burn={v}" data-on="on" data-off="off"> 灼伤</label></div>` : ''}
          <div class="dbg-row dbg-attached">${[...m.energy, ...m.tools].map((id) => `<span class="dbg-tag">${esc(name(id))}<button title="放入弃牌区" data-cmd="/detach ${id}">×</button></span>`).join('')}
            <select data-cmd="/attach {v} ${m.id}">${options(attachable, '+ 附着能量／道具')}</select></div>
          <div class="dbg-row">${active ? '' : `<button data-cmd="/switch ${m.id}">换到战斗场</button>`}
            <select data-cmd="/evolve ${m.id} {v}">${options(evolutions, '叠放进化卡…')}</select>
            ${m.stack.length > 1 ? `<button data-cmd="/devolve ${m.id}">退化</button>` : ''}
            <select data-cmd="/mon ${m.id} card={v}">${options(printingsOf(catalog, 'pokemon'), '换成…')}</select>
            <button class="danger" data-cmd="/remove ${m.id}">移除</button></div>
        </div>`;
      };
      return `<section><h4>${WHO[owner]}的宝可梦 <small>备战 ${p.bench.length}/${v.benchLimit}</small></h4>
        ${[p.active, ...p.bench].map((m, i) => (m ? box(m, i) : '')).join('')}
        <div class="dbg-row"><select data-cmd="/bench {v} ${SIDE[owner]}">${options(basics, '+ 放一只基础宝可梦到备战区')}</select></div></section>`;
    }).join('');
  }

  const printingsOf = (catalog, kind) => [...new Map(catalog.printings().map((p) => catalog.definitionFor(p.printingId))
    .filter((d) => d.kind === kind).map((d) => [d.name, [d.name, d.name]])).values()].sort((a, b) => a[0].localeCompare(b[0], 'zh'));

  function turnTab({ snapshot: s, catalog }) {
    const name = (id) => catalog.definition(s.cards[id].definitionId).name;
    const stadiums = Object.keys(s.cards).filter((id) => id !== s.stadium && catalog.definition(s.cards[id].definitionId).mechanics.category === 'stadium')
      .map((id) => [id, `${name(id)}（${WHO[s.cards[id].owner]}，${id}）`]);
    const effects = (owner) => {
      const ids = new Set([s.players[owner].active, ...s.players[owner].bench].filter(Boolean).map((m) => m.id));
      return [...s.ongoing.filter((e) => ids.has(e.targetId)), ...s.playerOngoing.filter((e) => e.player === owner)];
    };
    return `<p class="dbg-tip">第 ${s.turn} 回合 · ${s.current === null ? '准备阶段' : `${WHO[s.current]}的回合`} · revision ${s.revision}</p>
      ${[0, 1].map((owner) => `<section><h4>${WHO[owner]}</h4>
        <div class="dbg-row">${FLAGS.map(([k, l]) => `<label><input type="checkbox" ${s.players[owner].flags[k] ? 'checked' : ''} data-cmd="/flags ${SIDE[owner]} ${k}={v}"> ${l}</label>`).join('')}</div>
        <div class="dbg-row"><button data-cmd="/reset-turn ${SIDE[owner]}">清空本回合次数限制</button>
          ${effects(owner).length ? `<span>${effects(owner).length} 个持续效果</span><button data-cmd="/effects ${SIDE[owner]}">查看</button><button data-cmd="/effects ${SIDE[owner]} clear">清除</button>` : '<span class="dbg-empty">没有持续效果</span>'}</div>
      </section>`).join('')}
      <section><h4>竞技场 <small>${s.stadium ? esc(name(s.stadium)) : '无'}</small></h4>
        <div class="dbg-row"><select data-cmd="/stadium {v}">${options(stadiums, '换成…')}</select>${s.stadium ? '<button data-cmd="/stadium none">移除</button>' : ''}</div></section>
      <section><h4>掷硬币</h4><div class="dbg-row"><button data-cmd="/coin heads">下一次正面</button><button data-cmd="/coin tails">下一次反面</button>
        <button data-fill="/coin heads heads tails">指定多次…</button></div></section>
      <section><h4>修改记录</h4><div class="dbg-row"><button data-cmd="/revert">撤销上一次修改</button><button data-cmd="/export">导出内核快照</button></div></section>`;
  }

  function helpTab() {
    return `<p class="dbg-tip">玩家：me / opp / all（或 1 / 2 / 3）。卡牌：编号（p0c12）、卡号（CSV6C:121/128）或卡名，名字@区域 限定区域（巢穴球@discard）。
      宝可梦：active、bench1、opp.active、编号（m12）或场上宝可梦的名字。点用法或例子填入命令行。</p>
      ${COMMANDS.map((c) => `<div class="dbg-help"><button class="linkish" data-fill="${esc(c.usage.split(' ')[0])} ">${esc(c.usage)}</button>
        <p>${esc(c.text)}</p>${(c.examples ?? []).map((x) => `<button class="dbg-example" data-fill="${esc(x)}">${esc(x)}</button>`).join('')}</div>`).join('')}`;
  }

  // ---------------- Drawing ----------------
  function refresh() {
    if (el.hidden) return;
    const st = state();
    el.querySelectorAll('.dbg-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    if (!st) { body.innerHTML = '<p class="dbg-empty">没有进行中的对局。</p>'; return; }
    const { snapshot: s } = st;
    el.querySelector('.dbg-sub').textContent = `对局 #${st.matchId ?? '—'}`;
    const note = el.querySelector('.dbg-note');
    note.hidden = !(s.pending || s.result || s.phase !== 'main');
    note.textContent = s.result ? '对局已经结束，只能查看。' : '现在有选择未完成或效果正在结算：完成当前操作后才能修改。';
    const key = `${tab}:${side}:${s.revision}`;
    if (key === lastRevision) return;
    lastRevision = key;
    const scroll = body.scrollTop;
    body.innerHTML = tab === 'cards' ? cardsTab(st) : tab === 'mons' ? monsTab(st, st.view) : tab === 'turn' ? turnTab(st) : helpTab();
    body.scrollTop = scroll;
  }
  function toggle(on = el.hidden) {
    el.hidden = !on;
    document.body.classList.toggle('debug-on', on);
    window.dispatchEvent(new Event('resize')); // the table is narrower or wider now: lay the hand out again
    closeMenu();
    lastRevision = null;
    if (on) { refresh(); input.focus(); }
  }
  return { toggle, refresh, close: () => toggle(false), exec };
}
