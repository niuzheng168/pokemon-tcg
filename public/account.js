// Accounts in the browser: who is signed in, calls to the account server (server/app.mjs) and the site navigation
// shared by every page (对战, 卡牌库, 我的卡组, 对局记录 and, for administrators, 用户管理).
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const LOGIN = 'login.html';

export function loginURL(next = location.pathname + location.search) {
  return `${LOGIN}?next=${encodeURIComponent(next)}`;
}

// JSON to and from the account server. A lapsed session goes back to the login page.
export async function apiJSON(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, { method, credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (r.headers.get('content-type') ?? '').includes('json') ? await r.json() : {};
  if (r.status === 401 && !path.startsWith('/api/auth/')) location.href = loginURL();
  if (!r.ok) throw Object.assign(new Error(data.error ?? `请求失败（${r.status}）`), { status: r.status });
  return data;
}

// The signed-in user, or off to the login page (which brings the player back here).
export async function requireUser() {
  try {
    return (await apiJSON('/api/auth/me')).user;
  } catch (error) {
    if (error.status === 401) {
      location.replace(loginURL());
      await new Promise(() => {}); // the page is leaving
    }
    throw error;
  }
}

export async function logout() {
  await apiJSON('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
  location.href = LOGIN;
}

const PAGES = [
  { id: 'play', href: './', label: '对战', icon: 'swords' },
  { id: 'cards', href: 'cards.html', label: '卡牌库', icon: 'layers' },
  { id: 'decks', href: 'decks.html', label: '我的卡组', icon: 'package' },
  { id: 'matches', href: 'matches.html', label: '对局记录', icon: 'history' },
  { id: 'admin', href: 'admin.html', label: '用户管理', icon: 'shield', admin: true },
];

// Fills a <nav> (or any element) with the page links and the user menu.
export function mountNav(el, user, active) {
  el.classList.add('site-nav');
  el.innerHTML = PAGES.filter((p) => !p.admin || user.role === 'admin').map((p) =>
    `<a class="nav-link ${p.id === active ? 'on' : ''}" href="${p.href}" ${p.id === active ? 'aria-current="page"' : ''}><i class="ic ic-${p.icon}"></i><span>${p.label}</span></a>`).join('')
    + `<span class="user-menu">
        <button class="user-btn" aria-haspopup="true" aria-expanded="false"><i class="ic ic-user"></i><span>${esc(user.username)}</span>${user.role === 'admin' ? '<small class="role-tag">管理员</small>' : ''}</button>
        <span class="user-pop" hidden>
          <button data-act="password">修改密码</button>
          <button data-act="logout">退出登录</button>
        </span>
      </span>`;
  const btn = el.querySelector('.user-btn'), pop = el.querySelector('.user-pop');
  const show = (on) => { pop.hidden = !on; btn.setAttribute('aria-expanded', String(on)); };
  btn.onclick = (e) => { e.stopPropagation(); show(pop.hidden); };
  document.addEventListener('click', (e) => { if (!pop.contains(e.target)) show(false); });
  pop.querySelector('[data-act="logout"]').onclick = logout;
  pop.querySelector('[data-act="password"]').onclick = () => { show(false); passwordDialog(); };
}

// A small dialog of its own (the table page has its own modal; this one must not disturb it).
export function dialog(html, bind) {
  const ov = document.createElement('div');
  ov.className = 'overlay acct-overlay';
  ov.innerHTML = `<div class="dialog acct-dialog" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  ov.onclick = (e) => { if (e.target === ov) close(); };
  document.addEventListener('keydown', onKey);
  document.body.append(ov);
  bind(ov.firstElementChild, close);
  ov.querySelector('input, select, textarea, button.primary')?.focus();
  return close;
}

export function confirmDialog(text, { ok = '确定', danger = false } = {}) {
  return new Promise((resolve) => {
    dialog(`<p>${esc(text)}</p><div class="row"><button data-act="no">取消</button><button class="primary ${danger ? 'danger' : ''}" data-act="yes">${esc(ok)}</button></div>`,
      (box, close) => {
        box.querySelector('[data-act="no"]').onclick = () => { close(); resolve(false); };
        box.querySelector('[data-act="yes"]').onclick = () => { close(); resolve(true); };
      });
  });
}

function passwordDialog() {
  dialog(`<h2>修改密码</h2>
    <form class="acct-form">
      <label>当前密码<input type="password" name="current" autocomplete="current-password" required></label>
      <label>新密码<input type="password" name="password" autocomplete="new-password" minlength="8" required></label>
      <label>再输入一次新密码<input type="password" name="again" autocomplete="new-password" minlength="8" required></label>
      <p class="form-error" role="alert"></p>
      <div class="row"><button type="button" data-act="cancel">取消</button><button class="primary" type="submit">保存</button></div>
    </form>`, (box, close) => {
    const form = box.querySelector('form'), error = box.querySelector('.form-error');
    box.querySelector('[data-act="cancel"]').onclick = close;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      if (f.password !== f.again) { error.textContent = '两次输入的新密码不一样。'; return; }
      try {
        await apiJSON('/api/auth/password', { method: 'POST', body: { current: f.current, password: f.password } });
        box.innerHTML = '<h2>修改密码</h2><p>密码已修改。其他设备上的登录已退出。</p><div class="row"><button class="primary">好的</button></div>';
        box.querySelector('button').onclick = close;
      } catch (err) {
        error.textContent = err.message;
      }
    };
  });
}

// Where to go after signing in: only a path on this site.
export function nextPage() {
  const next = new URLSearchParams(location.search).get('next');
  return next && /^\/(?![\\/])/.test(next) && !next.includes(LOGIN) ? next : './';
}
