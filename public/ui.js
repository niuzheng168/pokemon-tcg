// The table: board, animations, drag and drop, choices and the start screen. The game itself is the CN/V20261019
// official kernel, loaded only from the reviewed release through the installed trust pin and driven by match.js;
// this file draws what the kernel decides and never judges a rule itself.
import { createReviewedGame, restoreReviewedGame, loadReviewedCatalogRelease } from './rules/engine.js';
import { TRUSTED_RELEASES, CN_RELEASE_ID } from './cn/trusted-releases.js';
import { Match, ME, START_SHUFFLE } from './match.js';
import { createDecisions } from './decision.js';
import { RPS_CANCEL, chooseThrow, showdown, rpsReset, rpsClose } from './rps.js';
import { api, online, hasBackend } from './api.js';
import { t, cardName, RULES_HTML, displayText, cardImage, CARD_BACK } from './i18n.js';
import { requireUser, mountNav, apiJSON } from './account.js';
import { formatRef } from './deck-check.js';
import { MatchRecorder } from './recorder.js';
import { stateHash, effectiveMoves, newGame, mergeSteps, replayMatch } from './replay.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const params = new URLSearchParams(location.search);
const FAST = params.get('speed') === 'fast'; // tests: no waiting between moves
const sleep = (ms) => new Promise((r) => setTimeout(r, FAST ? Math.min(ms, 5) : ms));
const pct = (x) => `${Math.round(x * 100)}%`;
const stale = () => new Promise(() => {}); // an abandoned game just stops here
const DATA = 'data/cn/V20261019/';
const PRIZES = 6;

let game = null;                  // the Match being played
let recorder = null;              // the game's record on the server (recorder.js), null when it has none
const REPLAY = params.get('replay'); // ?replay=<match id>: watch a recorded game (replay.js); nothing is saved or recorded
let release = null;               // {json, meta, decks: {id → deck}, catalog, decisions, drafts}
let user = null;                  // the signed-in player (account.js)
let gameId = 0;
let inspectables = new Map(); // element key → card, for the inspector panel
let logEntries = [];
let decision = null;          // current human decision: {actions, ranking, p, pick}
let coachState = { key: 'ui.coachIdle', params: {}, cls: '' };
let oppState = { key: '', params: {}, thinking: false };
let winState = null;
let modalRenderer = null;
let selectedDeck = null;
const lastDamage = new Map(); // mon id → damage at last render, to roll the dice when it changes

// ---------------- Icons ----------------
// Energy symbols use Pokémon type icons; UI icons come from Lucide (both loaded from jsDelivr via style.css).
const icon = (name) => `<i class="ic ic-${name}"></i>`;
const energyIcon = (type) => (type?.includes('|') ? type.split('|').map((x) => energyIcon(x)).join('')
  : `<span class="ei ei-${type}" style="--c:var(--${type})" title="${esc(t('type.' + type))}"><i></i></span>`);
const cardBack = () => CARD_BACK;
const backImg = () => `<img src="${cardBack()}" alt="" draggable="false">`;

// ---------------- Static text ----------------
function applyStaticText() {
  document.documentElement.lang = 'zh-CN';
  document.title = t('ui.pageTitle');
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  const counts = { n: release?.meta.decks.length ?? 0 }; // the reviewed decks, not the player's own
  document.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml, counts); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', t(el.dataset.i18nAria)));
  $('#rules-body').innerHTML = RULES_HTML.replace('{n}', counts.n);
  const slot = $('#rules-body [data-dice-chart]');
  if (slot) slot.innerHTML = diceChart();
  $('#dice-label').textContent = t('ui.diceStyle').replace(/\s*[:：]\s*$/, ''); // a row label, not a prompt
  document.querySelectorAll('input[name="dice"]').forEach((r) => { r.checked = r.value === diceStyle; });
  document.querySelectorAll('input[name="opening"]').forEach((r) => { r.checked = r.value === openingStyle; });
}

// ---------------- Board rendering ----------------
function monTile(m, { active = false, owner }) {
  if (m.facedown || (game.phase === 'setup' && owner.idx === 1)) return `<div class="mon facedown ${active ? 'active' : ''}">${backImg()}</div>`;
  inspectables.set('m' + m.id, m.card);
  const ratio = m.hpLeft / m.maxHp;
  const tags = [
    ...m.conditions().map((s) => `<span class="tag-status">${esc(t('st.' + s))}</span>`),
    ...m.tools.map((x) => `<span class="tag-tool">${esc(cardName(x.card))}</span>`),
  ].join('');
  // Attached Energy and Trainer cards sit tucked under the Pokémon with a strip showing, like on a real table.
  // the opponent's side is mirrored so its tucked cards peek out towards the opponent.
  const under = [...m.energy, ...m.tools.map((x) => x.card)];
  const tucked = under.map((c, i) => {
    inspectables.set('u' + c.uid, c);
    const mark = c.kind === 'energy' ? energyIcon(c.energyType) : `<span class="tool-mark">${esc(cardName(c))}</span>`;
    return `<div class="tucked ${arrivingCards.has(c.uid) ? 'arriving' : ''}" data-cuid="${c.uid}" data-inspect="u${c.uid}" style="--i:${i};z-index:${under.length - i};background-image:url('${cardImage(c)}')">${mark}</div>`;
  }).join('');
  return `<div class="mon ${active ? 'active' : ''} ${owner.idx === 1 ? 'up' : ''} ${arena?.ids.has(m.id) ? 'in-arena' : ''}" data-inspect="m${m.id}" data-mon="${m.id}">
    <div class="pile-under" style="--n:${under.length};--pkf:${Math.min(1, 3 / Math.max(1, under.length)).toFixed(3)}">
      ${tucked}
      <div class="top-card ${arrivingCards.has(m.card.uid) ? 'arriving' : ''}" data-cuid="${m.card.uid}">
        <img class="card-img" src="${cardImage(m.card)}" alt="${esc(cardName(m.card))}" draggable="false">
        ${diceHtml(m)}
        <div class="tags">${tags}</div>
      </div>
    </div>
    <div class="hpbar ${ratio <= 0.3 ? 'low' : ratio <= 0.6 ? 'mid' : ''}"><div style="width:${ratio * 100}%"></div></div>
    <div class="hptext">${m.hpLeft}/${m.maxHp} ${t('ui.hp')}</div>
  </div>`;
}

// Damage counters (each one is 10 damage) shown as pieces, the way players track them on a real table: the 100 / 50 /
// 10 damage-counter markers, fewest pieces first (60 = 50 + 10), or six-sided dice, one die per 6 counters (each pip,
// or the printed number, is a counter). Only the number of counters matters to the rules; the pieces are a choice.
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
const MARKERS = [10, 5, 1]; // counters per marker: the 100, 50 and 10 markers
function pieces(counters, style = diceStyle) {
  const out = [];
  if (style === 'counters') for (const v of MARKERS) for (; counters >= v; counters -= v) out.push(v);
  else for (let c = counters; c > 0; c -= 6) out.push(Math.min(6, c));
  return out;
}
const piecesClass = (style = diceStyle) => (style === 'counters' ? 'markers' : '');

function diceHtml(m) {
  const changed = lastDamage.has(m.id) && lastDamage.get(m.id) !== m.damage;
  lastDamage.set(m.id, m.damage);
  if (!m.damage) return '';
  const roll = changed && $('#opt-anim').checked ? 'roll' : '';
  return `<div class="dice ${piecesClass()} ${roll}" title="${esc(t('ui.diceTitle', { c: m.damage / 10, n: m.damage }))}">
    ${pieces(m.damage / 10).map((v) => dieFace(v)).join('')}
    ${diceStyle === 'counters' ? '' : `<span class="dsum">${m.damage}</span>`}</div>`; // markers print their own values
}

// A piece in the chosen style: a marker (100 / 50 / 10), a die with pips, or a die with a printed number.
let diceStyle = 'counters';
try { diceStyle = localStorage.getItem('diceStyle') || 'counters'; } catch { /* storage unavailable */ }
// How the right to choose first or second is shown: rock-paper-scissors or a coin (I.G.2 「通过猜拳等方式」).
let openingStyle = 'rps';
try { openingStyle = localStorage.getItem('opening') || 'rps'; } catch { /* storage unavailable */ }
function dieFace(v, style = diceStyle) {
  if (style === 'counters') return `<div class="die marker m${v}"><b>${v * 10}</b></div>`;
  if (style === 'numbers') return `<div class="die num"><b>${v}</b></div>`;
  return `<div class="die">${Array.from({ length: 9 }, (_, i) => `<span class="${PIPS[v].includes(i) ? 'p' : ''}"></span>`).join('')}</div>`;
}

// Chart for the rules page: the three markers, every die face in both styles, and 80 damage in the chosen style.
function diceChart() {
  const markers = [...MARKERS].reverse().map((v) => `<div class="dc-col">${dieFace(v, 'counters')}<span>${esc(t('ui.markerCount', { n: v }))}</span></div>`).join('');
  const rows = [1, 2, 3, 4, 5, 6].map((v) => `<div class="dc-col">${dieFace(v, 'pips')}${dieFace(v, 'numbers')}<span>${v * 10}</span></div>`).join('');
  const parts = pieces(8);
  const combo = `<div class="dc-combo ${piecesClass()}">${parts.map((v) => dieFace(v)).join('')}<span>= ${parts.map((v) => v * 10).join(' + ')} = 80</span></div>`;
  return `<div class="dice-chart"><div class="dc-row markers">${markers}</div><div class="dc-cap">${esc(t('ui.markerChart'))}</div>
    <div class="dc-row">${rows}</div><div class="dc-cap">${esc(t('ui.diceChart'))}</div>${combo}</div>`;
}

// ---------------- Attack arena ----------------
// On every attack both Active Pokémon rise from the mat into the middle of the board, face each other and clash.
// Damage is shown as dice tumbling from the attacker onto the defender, with a burst and a floating number.
let arena = null; // { el, cards: Map(monId → wrapper), ids: Set }
const animOn = () => $('#opt-anim').checked && !FAST;
const monById = (id) => game && game.players.flatMap((p) => game.allMons(p)).find((m) => m.id === id);
const centerOf = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

function arenaCard(m, rect) {
  const w = document.createElement('div');
  w.className = 'arena-card';
  // The mat's (already decoded) image first; the large one swaps in once decoded, never mid-animation.
  w.innerHTML = `<img src="${cardImage(m.card)}" alt="${esc(cardName(m.card))}"><i class="a-glow"></i><div class="a-dice"></div><div class="a-hp"></div>`;
  const img = w.querySelector('img'), hi = new Image();
  hi.src = cardImage(m.card, true);
  hi.decode().then(() => { img.src = hi.src; }).catch(() => {});
  Object.assign(w.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px` });
  updateArenaCard(w, m, m.damage);
  return w;
}
function updateArenaCard(w, m, damage) {
  const box = w.querySelector('.a-dice');
  box.className = `a-dice ${piecesClass()}`;
  box.innerHTML = pieces(damage / 10).map((v) => dieFace(v)).join('');
  w.querySelector('.a-hp').textContent = `${Math.max(0, m.maxHp - damage)}/${m.maxHp} ${t('ui.hp')}`;
}

// FLIP: the box takes its final place at once and a transform carries it there, so no frame needs layout.
function moveTo(el, rect, duration, easing = 'cubic-bezier(.3,.7,.3,1)') {
  const from = el.getBoundingClientRect();
  Object.assign(el.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px` });
  const s = from.width / rect.width;
  el.animate([
    { transformOrigin: '0 0', transform: `translate(${from.left - rect.left}px, ${from.top - rect.top}px) scale(${s})` },
    { transformOrigin: '0 0', transform: 'none' },
  ], { duration, easing });
  return sleep(duration);
}

async function arenaOpen({ p, from, to, atk, type }) {
  if (!animOn()) return;
  const att = monById(from), def = monById(to);
  const attEl = document.querySelector(`[data-mon="${from}"] .top-card`), defEl = document.querySelector(`[data-mon="${to}"] .top-card`);
  if (!att || !def || !attEl || !defEl) return;
  // The cut-in covers the whole window, so centre the two cards on the window (not on the board),
  // a little below the title, and shrink them if the window is narrow.
  let h = Math.min(innerHeight * 0.56, 440), w = h * 0.716;
  if (w * 2.45 > innerWidth * 0.92) { w = (innerWidth * 0.92) / 2.45; h = w / 0.716; }
  const gap = w * 0.45;
  const cx = innerWidth / 2, top = innerHeight / 2 - h / 2 + innerHeight * 0.04;
  const mine = p === 0 ? att : def, theirs = p === 0 ? def : att;
  const spot = {
    [mine.id]: { left: cx - gap / 2 - w, top, width: w },
    [theirs.id]: { left: cx + gap / 2, top, width: w },
  };
  // Layers: manga speed lines, two slanted panels in each side's type colour, and the attack title.
  const el = document.createElement('div');
  el.className = 'arena anime';
  el.style.setProperty('--ca', `var(--${type})`);
  el.innerHTML = `
    <div class="panel left" style="--c:var(--${mine.card.type})"></div>
    <div class="panel right" style="--c:var(--${theirs.card.type})"></div>
    <div class="speedlines"></div>
    <div class="arena-title" style="--c:var(--${type})"><span>${esc(displayText(atk))}</span></div>`;
  document.body.append(el);
  document.body.classList.add('arena-on');
  arena = { el, cards: new Map(), ids: new Set([from, to]), attacker: from, side: p, type };
  for (const [m, src] of [[att, attEl], [def, defEl]]) {
    const card = arenaCard(m, src.getBoundingClientRect());
    el.append(card);
    arena.cards.set(m.id, card);
  }
  render(); // hides the originals on the mat while they are in the arena
  el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
  await Promise.all([...arena.cards].map(([id, c]) => moveTo(c, spot[id], 480)));
  el.classList.add('cut-in');
  // Title slams in, then the attacker charges up.
  await sleep(380);
  const ac = arena.cards.get(from);
  ac.classList.add('charging');
  ac.style.setProperty('--c', `var(--${type})`);
  chargeParticles(ac.getBoundingClientRect(), type);
  await sleep(520);
}

// Energy particles converging on the attacker while it charges up.
function chargeParticles(r, type) {
  const c = centerOf(r);
  for (let i = 0; i < 14; i++) {
    const d = document.createElement('div');
    d.className = 'particle';
    d.style.setProperty('--c', `var(--${type})`);
    const ang = (i / 14) * Math.PI * 2, dist = 140 + Math.random() * 60;
    Object.assign(d.style, { left: `${c.x}px`, top: `${c.y}px` });
    document.body.append(d);
    d.animate([
      { transform: `translate(-50%,-50%) translate(${Math.cos(ang) * dist}px, ${Math.sin(ang) * dist}px) scale(1.4)`, opacity: 0 },
      { opacity: 1, offset: 0.3 },
      { transform: 'translate(-50%,-50%) translate(0,0) scale(.3)', opacity: 0 },
    ], { duration: 520 + Math.random() * 160, delay: Math.random() * 120, easing: 'cubic-bezier(.5,0,.8,.5)', fill: 'forwards' });
    setTimeout(() => d.remove(), 900);
  }
}

function floatText(rect, html, cls) {
  const f = document.createElement('div');
  f.className = `float-dmg ${cls}`;
  f.innerHTML = html;
  Object.assign(f.style, { left: `${rect.left + rect.width / 2}px`, top: `${rect.top + rect.height * 0.25}px` });
  document.body.append(f);
  f.animate([
    { transform: 'translate(-50%, 0) scale(.6)', opacity: 0 },
    { transform: 'translate(-50%, -20px) scale(1.25)', opacity: 1, offset: 0.25 },
    { transform: 'translate(-50%, -70px) scale(1)', opacity: 0 },
  ], { duration: 1300, easing: 'ease-out', fill: 'forwards' });
  setTimeout(() => f.remove(), 1350);
}

function burst(rect, type) {
  const b = document.createElement('div');
  b.className = 'burst';
  b.style.setProperty('--c', `var(--${type || 'Colorless'})`);
  const c = centerOf(rect);
  Object.assign(b.style, { left: `${c.x}px`, top: `${c.y}px` });
  document.body.append(b);
  b.animate([{ transform: 'translate(-50%,-50%) scale(.2)', opacity: 1 }, { transform: 'translate(-50%,-50%) scale(2.2)', opacity: 0 }], { duration: 600, easing: 'ease-out', fill: 'forwards' });
  setTimeout(() => b.remove(), 620);
}

function shake(el) {
  el.animate([
    { transform: 'translateX(0)', filter: 'none' },
    { transform: 'translateX(-10px) rotate(-2deg)', filter: 'brightness(1.6) saturate(1.4)' },
    { transform: 'translateX(9px) rotate(2deg)' },
    { transform: 'translateX(-6px)' },
    { transform: 'translateX(4px)' },
    { transform: 'translateX(0)', filter: 'none' },
  ], { duration: 480, easing: 'ease-out' });
}

// Dice tumble from the attacker onto the target, showing the damage just dealt.
async function tumbleDice(fromRect, toRect, n) {
  const faces = pieces(n / 10);
  const start = centerOf(fromRect);
  await Promise.all(faces.map((v, i) => {
    const d = document.createElement('div');
    d.className = 'tumble';
    d.innerHTML = dieFace(v);
    Object.assign(d.style, { left: `${start.x}px`, top: `${start.y}px` });
    document.body.append(d);
    const tx = toRect.left + toRect.width * 0.85 - start.x, ty = toRect.top + toRect.height * (0.2 + i * 0.14) - start.y;
    d.animate([
      { transform: 'translate(-50%,-50%) rotate(0deg) scale(.8)' },
      { transform: `translate(calc(-50% + ${tx * 0.5}px), calc(-50% + ${ty * 0.5 - 70}px)) rotate(400deg) scale(1.3)`, offset: 0.5 },
      { transform: `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) rotate(720deg) scale(1)` },
    ], { duration: 650, delay: i * 120, easing: 'cubic-bezier(.3,.6,.4,1)', fill: 'forwards' });
    return new Promise((r) => setTimeout(() => { d.remove(); r(); }, 650 + i * 120 + 20));
  }));
}

// ---------- Anime attack effects ----------
const fx = (cls, style = {}) => { const d = document.createElement('div'); d.className = `afx ${cls}`; Object.assign(d.style, style); document.body.append(d); return d; };
const gone = (d, ms) => setTimeout(() => d.remove(), ms);

// A type-specific projectile from attacker to defender; resolves when it reaches the target.
async function projectile(type, a, b, dir) {
  const A = centerOf(a), B = centerOf(b), dx = B.x - A.x, dy = B.y - A.y;
  const len = Math.hypot(dx, dy), ang = Math.atan2(dy, dx) * 180 / Math.PI;
  const travel = (el, dur, delay = 0, extra = '') => el.animate([
    { transform: `translate(-50%,-50%) translate(0,0) ${extra}`, opacity: 0 },
    { opacity: 1, offset: 0.1 },
    { transform: `translate(-50%,-50%) translate(${dx}px, ${dy}px) ${extra}`, opacity: 1 },
  ], { duration: dur, delay, easing: 'cubic-bezier(.45,0,.9,.6)', fill: 'forwards' });
  switch (type) {
    case 'Fire':
      for (let i = 0; i < 3; i++) { const f = fx('fireball', { left: `${A.x}px`, top: `${A.y}px` }); travel(f, 380, i * 90); gone(f, 560); }
      await sleep(560); break;
    case 'Water':
      for (let i = 0; i < 10; i++) {
        const s = 10 + Math.random() * 16, off = (Math.random() - 0.5) * 50;
        const bb = fx('bubble', { left: `${A.x}px`, top: `${A.y + off}px`, width: `${s}px`, height: `${s}px` });
        travel(bb, 420, i * 35); gone(bb, 820);
      }
      await sleep(560); break;
    case 'Grass':
      for (let i = 0; i < 6; i++) {
        const l = fx('leaf', { left: `${A.x}px`, top: `${A.y + (Math.random() - 0.5) * 60}px` });
        l.animate([
          { transform: 'translate(-50%,-50%) rotate(0deg)', opacity: 0 }, { opacity: 1, offset: 0.1 },
          { transform: `translate(-50%,-50%) translate(${dx}px, ${dy + (Math.random() - 0.5) * 40}px) rotate(${720 + i * 60}deg)`, opacity: 1 },
        ], { duration: 460, delay: i * 50, easing: 'cubic-bezier(.4,0,.8,.6)', fill: 'forwards' });
        gone(l, 820);
      }
      await sleep(600); break;
    case 'Lightning': {
      // A jagged bolt drawn from attacker to defender, flickering.
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'afx bolt');
      svg.setAttribute('width', innerWidth); svg.setAttribute('height', innerHeight);
      const pts = [[A.x, A.y]];
      for (let i = 1; i < 9; i++) { const t2 = i / 9; pts.push([A.x + dx * t2 + (Math.random() - 0.5) * 50, A.y + dy * t2 + (Math.random() - 0.5) * 70]); }
      pts.push([B.x, B.y]);
      const d = pts.map((q, i) => `${i ? 'L' : 'M'}${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(' ');
      svg.innerHTML = `<path d="${d}" class="glow"/><path d="${d}" class="core"/>`;
      document.body.append(svg);
      svg.querySelectorAll('path').forEach((pth) => { const L = pth.getTotalLength(); pth.style.strokeDasharray = L; pth.animate([{ strokeDashoffset: L }, { strokeDashoffset: 0 }], { duration: 220, easing: 'ease-out', fill: 'forwards' }); });
      svg.animate([{ opacity: 1 }, { opacity: .3 }, { opacity: 1 }, { opacity: .5 }, { opacity: 1 }, { opacity: 0 }], { duration: 640, fill: 'forwards' });
      gone(svg, 660);
      await sleep(260); break;
    }
    case 'Psychic':
      for (let i = 0; i < 4; i++) { const r2 = fx('ring', { left: `${A.x}px`, top: `${A.y}px` }); travel(r2, 520, i * 90, `scale(${1 + i * 0.25})`); gone(r2, 900); }
      await sleep(620); break;
    case 'Fighting':
      await sleep(80); break; // the dash itself is the attack (see the lunge)
    default: {
      const s = fx('slash', { left: `${B.x}px`, top: `${B.y}px`, width: `${b.width * 1.4}px` });
      s.animate([{ transform: 'translate(-50%,-50%) rotate(-28deg) scaleX(0)', opacity: 1 }, { transform: 'translate(-50%,-50%) rotate(-28deg) scaleX(1)', opacity: 1, offset: 0.5 }, { transform: 'translate(-50%,-50%) rotate(-28deg) scaleX(1)', opacity: 0 }], { duration: 360, fill: 'forwards' });
      gone(s, 380);
      await sleep(180);
    }
  }
}

// Impact: hit-stop, white flash, spiky starburst, screen shake and knockback.
async function impact(defEl, type, dir, strong) {
  const r = defEl.getBoundingClientRect(), c = centerOf(r);
  const flash = fx('flash'); flash.animate([{ opacity: 0.85 }, { opacity: 0 }], { duration: 160, fill: 'forwards' }); gone(flash, 170);
  const star = fx('star', { left: `${c.x}px`, top: `${c.y}px`, '--c': `var(--${type || 'Colorless'})` });
  star.style.setProperty('--c', `var(--${type || 'Colorless'})`);
  star.animate([{ transform: 'translate(-50%,-50%) scale(.2) rotate(0deg)', opacity: 1 }, { transform: `translate(-50%,-50%) scale(${strong ? 1.5 : 1.1}) rotate(25deg)`, opacity: 1, offset: 0.35 }, { transform: `translate(-50%,-50%) scale(${strong ? 1.8 : 1.3}) rotate(35deg)`, opacity: 0 }], { duration: 420, fill: 'forwards' });
  gone(star, 440);
  const ring = fx('shock', { left: `${c.x}px`, top: `${c.y}px` });
  ring.animate([{ transform: 'translate(-50%,-50%) scale(.2)', opacity: 1 }, { transform: 'translate(-50%,-50%) scale(2.4)', opacity: 0 }], { duration: 480, easing: 'ease-out', fill: 'forwards' });
  gone(ring, 500);
  // Hit-stop: the defender freezes for a beat, then is knocked back with a red tint.
  defEl.animate([
    { transform: 'none', filter: 'none' },
    { transform: `translateX(${dir * 4}px)`, filter: 'brightness(2.2) saturate(0)', offset: 0.12 },
    { transform: `translateX(${dir * 4}px)`, filter: 'brightness(2.2) saturate(0)', offset: 0.24 },
    { transform: `translateX(${dir * 38}px) rotate(${dir * 7}deg)`, filter: 'sepia(1) saturate(6) hue-rotate(-40deg)', offset: 0.45 },
    { transform: `translateX(${dir * -6}px) rotate(${dir * -2}deg)`, filter: 'none', offset: 0.75 },
    { transform: 'none', filter: 'none' },
  ], { duration: 620, easing: 'ease-out' });
  const shakeEl = arena?.el || $('#board');
  shakeEl.animate([{ transform: 'translate(0,0)' }, { transform: 'translate(-9px,5px)' }, { transform: 'translate(8px,-6px)' }, { transform: 'translate(-6px,-3px)' }, { transform: 'translate(4px,4px)' }, { transform: 'translate(0,0)' }],
    { duration: strong ? 420 : 300, easing: 'linear' });
  await sleep(150);
}

// Dice tumble onto the defender's real dice (rendered first, hidden): each one tracks its die every frame,
// so it lands exactly in place even while the defender is being knocked back, then the real die is revealed.
function tumbleOnto(fromRect, dieEls) {
  const start = centerOf(fromRect);
  return Promise.all(dieEls.map((die, i) => new Promise((resolve) => {
    die.style.visibility = 'hidden';
    const d = document.createElement('div');
    d.className = 'tumble';
    d.innerHTML = die.outerHTML;
    const inner = d.firstChild;
    inner.style.visibility = 'visible';
    const cs = getComputedStyle(die);
    Object.assign(inner.style, { fontSize: cs.fontSize, padding: cs.padding, borderRadius: cs.borderRadius });
    document.body.append(d);
    const D = 650, t0 = performance.now() + i * 120;
    let done = false;
    const finish = () => { if (done) return; done = true; d.remove(); die.style.visibility = ''; resolve(); };
    const frame = (now) => {
      if (done) return;
      const p = Math.min(1, Math.max(0, (now - t0) / D));
      const r = die.getBoundingClientRect(), B = centerOf(r);
      const e = 1 - Math.pow(1 - p, 3), arc = Math.sin(Math.PI * Math.min(1, p * 1.1));
      const x = start.x + (B.x - start.x) * e, y = start.y + (B.y - start.y) * e - 80 * arc;
      Object.assign(inner.style, { width: `${r.width}px`, height: `${r.height}px` });
      d.style.transform = `translate(${x - r.width / 2}px, ${y - r.height / 2}px) rotate(${(1 - e) * 720}deg) scale(${1 + 0.3 * arc})`;
      if (p < 1) requestAnimationFrame(frame); else finish();
    };
    requestAnimationFrame(frame);
    setTimeout(finish, i * 120 + D + 500); // background-tab safety net
  })));
}

// A comic-style stamp (damage numbers, SUPER EFFECTIVE!, MISS!, KO!).
function stamp(rect, html, cls, { dy = 0, dur = 1300 } = {}) {
  const s = fx(`stamp ${cls}`, { left: `${rect.left + rect.width / 2}px`, top: `${rect.top + rect.height * 0.3 + dy}px` });
  s.innerHTML = html;
  s.animate([
    { transform: 'translate(-50%,-50%) scale(2.6) rotate(-14deg)', opacity: 0 },
    { transform: 'translate(-50%,-50%) scale(.92) rotate(-8deg)', opacity: 1, offset: 0.14 },
    { transform: 'translate(-50%,-50%) scale(1.05) rotate(-8deg)', opacity: 1, offset: 0.24 },
    { transform: 'translate(-50%,-80%) scale(1) rotate(-8deg)', opacity: 1, offset: 0.75 },
    { transform: 'translate(-50%,-110%) scale(.95) rotate(-8deg)', opacity: 0 },
  ], { duration: dur, easing: 'ease-out', fill: 'forwards' });
  gone(s, dur + 20);
}

async function onHit({ from, to, n, notes }) {
  if (!animOn()) return;
  const target = monById(to), source = from != null ? monById(from) : null;
  const inArena = arena?.cards.get(to);
  const targetEl = inArena || document.querySelector(`[data-mon="${to}"] .top-card`);
  if (!target || !targetEl) return;
  const attEl = source && (arena?.cards.get(from) || document.querySelector(`[data-mon="${from}"] .top-card`));
  const type = source?.card.type || 'Colorless';
  const clash = inArena && arena.cards.has(from);
  const a = attEl?.getBoundingClientRect(), b = targetEl.getBoundingClientRect();
  const dir = a ? Math.sign(centerOf(b).x - centerOf(a).x) || 1 : 1;

  if (clash) {
    attEl.classList.remove('charging');
    // Dash: the attacker lunges forward (a long dash for Fighting/Colorless, a short step when firing a projectile).
    const melee = type === 'Fighting' || type === 'Colorless';
    const dx = (centerOf(b).x - centerOf(a).x) * (melee ? 0.55 : 0.18);
    attEl.animate([
      { transform: 'none' },
      { transform: `translateX(${-dx * 0.15}px) scale(.97)`, offset: 0.2 },
      { transform: `translateX(${dx}px) rotate(${dir * 6}deg) scale(1.08)`, offset: 0.55, easing: 'cubic-bezier(.2,.8,.3,1)' },
      { transform: 'none' },
    ], { duration: melee ? 620 : 540, easing: 'ease-in-out' });
    await sleep(melee ? 300 : 160);
    if (!notes.includes('miss')) await projectile(type, attEl.getBoundingClientRect(), targetEl.getBoundingClientRect(), dir);
  }
  const rect = targetEl.getBoundingClientRect();
  if (notes.includes('miss')) {
    targetEl.animate([{ transform: 'none' }, { transform: `translateX(${dir * 26}px) rotate(${dir * 4}deg)`, offset: 0.4 }, { transform: 'none' }], { duration: 420, easing: 'ease-out' });
    stamp(rect, esc(t('anim.miss')), 'miss');
    await sleep(900); return;
  }
  if (n === 0) {
    await impact(targetEl, 'Colorless', dir, false);
    stamp(rect, `${icon('shield')} ${esc(t('anim.blocked'))}`, 'blocked');
    await sleep(900); return;
  }
  const strong = notes.includes('weakness') || n >= 60;
  await impact(targetEl, clash ? type : null, dir, strong);
  const extra = notes.filter((x) => ['resistance', 'counters'].includes(x)).map((x) => t('note.' + x)).join(' · ');
  stamp(rect, `−${n}${extra ? `<small>${esc(extra)}</small>` : ''}`, 'dmg-stamp');
  if (notes.includes('weakness')) stamp(rect, esc(t('anim.superEffective')), 'super', { dy: rect.height * 0.42, dur: 1500 });
  const from2 = attEl ? attEl.getBoundingClientRect() : { left: rect.left + rect.width / 2, top: rect.top - 90, width: 0, height: 0 };
  if (inArena) {
    updateArenaCard(inArena, target, target.damage + n);
    await tumbleOnto(from2, [...inArena.querySelectorAll('.a-dice .die')]);
  } else {
    await tumbleDice(from2, rect, n);
  }
  await sleep(clash ? 350 : 150);
}

// Knock Out: a big stamp over the board.
function koStamp() {
  if (!animOn()) return;
  // Centred on the screen (not the board, which the sidebar pushes to the left), like the attack arena.
  stamp({ left: 0, top: innerHeight / 2, width: innerWidth, height: 0 }, esc(t('anim.ko')), 'ko-stamp', { dur: 1500 });
}

async function arenaClose() {
  if (!arena) return;
  const a = arena;
  await sleep(450);
  a.el.classList.remove('cut-in');
  a.el.querySelector('.arena-title')?.classList.remove('show');
  a.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 450, fill: 'forwards' });
  const moves = [...a.cards].map(([id, c]) => {
    const home = document.querySelector(`[data-mon="${id}"] .top-card`);
    return home ? moveTo(c, home.getBoundingClientRect(), 420) : Promise.resolve();
  });
  await Promise.all(moves);
  arena = null;
  a.el.remove();
  document.body.classList.remove('arena-on');
  render(); // originals reappear with their updated dice
}

// ---------------- Guided tour ----------------
// Spotlights each part of the table in turn and explains it. Runs before your first move, and from the Tutorial button.
const TOUR = [
  { id: 'welcome' },
  { id: 'active', sel: '#you-active' },
  { id: 'bench', sel: '#you-bench' },
  { id: 'hand', sel: '#hand-wrap' },
  { id: 'prizes', sel: '#you-prizes' },
  { id: 'piles', sel: '#you-piles' },
  { id: 'opp', sel: '.mat.opp' },
  { id: 'midbar', sel: '#midbar' },
  { id: 'moves', sel: '#actions-panel' },
  { id: 'viewer' },
  { id: 'coach', sel: '#btn-settings' },
  { id: 'log', sel: '#log-panel' },
  { id: 'firstTurn' },
];
let tourRunning = false;
const tourDone = () => { try { return localStorage.getItem('tourDone') === '1'; } catch { return false; } };

function runTour() {
  if (tourRunning || $('#table').hidden) return Promise.resolve();
  tourRunning = true;
  return new Promise((resolve) => {
    let i = 0;
    const el = document.createElement('div');
    el.className = 'tour';
    el.innerHTML = '<div class="tour-hole"></div><div class="tour-tip"></div>';
    document.body.append(el);
    const hole = el.querySelector('.tour-hole'), tip = el.querySelector('.tour-tip');
    const finish = () => {
      try { localStorage.setItem('tourDone', '1'); } catch { /* storage unavailable */ }
      el.remove();
      window.removeEventListener('resize', show);
      tourRunning = false;
      resolve();
    };
    function show() {
      const step = TOUR[i], last = i === TOUR.length - 1;
      const target = step.sel && document.querySelector(step.sel);
      el.classList.toggle('no-target', !target);
      tip.innerHTML = `<div class="tour-step">${i + 1} / ${TOUR.length}</div>
        <h3>${esc(t(`tour.${step.id}.t`))}</h3><div class="tour-body">${t(`tour.${step.id}.b`)}</div>
        <div class="row"><button class="ghost" data-a="skip">${esc(t('ui.skip'))}</button>
        <button data-a="back" ${i ? '' : 'disabled'}>${esc(t('ui.back'))}</button>
        <button class="primary" data-a="next">${esc(t(last ? 'ui.letsPlay' : 'ui.next'))}</button></div>`;
      tip.querySelector('[data-a="skip"]').onclick = finish;
      tip.querySelector('[data-a="back"]').onclick = () => { i--; show(); };
      tip.querySelector('[data-a="next"]').onclick = () => { if (last) finish(); else { i++; show(); } };
      if (!target) {
        hole.style.display = 'none';
        Object.assign(tip.style, { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' });
        return;
      }
      const r = target.getBoundingClientRect(), pad = 6;
      Object.assign(hole.style, { display: 'block', left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
      // Place the bubble below, above, left or right of the spotlight, whichever fits.
      tip.style.transform = 'none';
      const tw = tip.offsetWidth, th = tip.offsetHeight, m = 14, W = innerWidth, H = innerHeight;
      let left, top;
      if (r.bottom + m + th < H) { top = r.bottom + m; left = r.left + r.width / 2 - tw / 2; }
      else if (r.top - m - th > 0) { top = r.top - m - th; left = r.left + r.width / 2 - tw / 2; }
      else if (r.left - m - tw > 0) { left = r.left - m - tw; top = r.top + r.height / 2 - th / 2; }
      else { left = r.right + m; top = r.top + r.height / 2 - th / 2; }
      Object.assign(tip.style, { left: `${Math.max(10, Math.min(W - tw - 10, left))}px`, top: `${Math.max(10, Math.min(H - th - 10, top))}px` });
    }
    window.addEventListener('resize', show);
    show();
  });
}

// ---------------- Evolution ----------------
// Anime-style evolution: the Pokémon rises to centre stage, the evolution card merges into it, it turns into a
// glowing silhouette that flickers between the old and new form faster and faster, then a flash reveals the new form.
async function onEvolve({ p, mon, from, to }) {
  if (!animOn()) return;
  const spotEl = document.querySelector(`[data-mon="${mon}"] .top-card`);
  if (!spotEl) return;
  const home = spotEl.getBoundingClientRect();
  const handCard = p === 0 ? document.querySelector(`#hand [data-card="${to.uid}"]`) : document.querySelector('#opp-hand .ocard:last-child img');
  const ov = document.createElement('div');
  ov.className = 'evolve-stage';
  ov.innerHTML = `<div class="ev-rays"></div><div class="ev-glow"></div>
    <div class="ev-card"><img class="ev-old" src="${cardImage(from, true)}" alt=""><img class="ev-new" src="${cardImage(to, true)}" alt=""><i class="ev-sil"></i></div>
    <div class="ev-sparkles"></div>`;
  document.body.append(ov);
  document.body.classList.add('arena-on');
  const card = ov.querySelector('.ev-card');
  const h = Math.min(innerHeight * 0.58, 460), w = h * 0.716;
  const target = { left: innerWidth / 2 - w / 2, top: innerHeight / 2 - h / 2, width: w };
  Object.assign(card.style, { left: `${home.left}px`, top: `${home.top}px`, width: `${home.width}px` });
  spotEl.style.visibility = 'hidden';
  ov.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 250, fill: 'forwards' });
  await moveTo(card, target, 520);
  // The evolution card flies in from the hand and merges into the Pokémon.
  if (handCard) {
    if (p === 0) handCard.style.visibility = 'hidden';
    await fly(handCard, card, { front: p === 0 ? cardImage(to) : null });
  }
  ov.classList.add('glowing');
  // Sparkles drifting up around the card.
  const sp = ov.querySelector('.ev-sparkles');
  for (let i = 0; i < 26; i++) {
    const s = document.createElement('i');
    s.style.left = `${innerWidth / 2 + (Math.random() - 0.5) * w * 1.8}px`;
    s.style.top = `${innerHeight / 2 + (Math.random() - 0.2) * h * 0.9}px`;
    s.style.animationDelay = `${Math.random() * 1.6}s`;
    sp.append(s);
  }
  // Flicker between the two silhouettes, accelerating.
  const oldImg = card.querySelector('.ev-old'), newImg = card.querySelector('.ev-new');
  let showNew = false;
  for (const ms of [300, 260, 220, 180, 150, 120, 95, 75, 60, 50, 42, 36, 32]) {
    showNew = !showNew;
    oldImg.style.opacity = showNew ? 0 : 1;
    newImg.style.opacity = showNew ? 1 : 0;
    card.animate([{ transform: 'scale(1)' }, { transform: `scale(${showNew ? 1.06 : 0.97})` }, { transform: 'scale(1)' }], { duration: ms });
    await sleep(ms);
  }
  oldImg.style.opacity = 0;
  newImg.style.opacity = 1;
  // Flash, then the new form in full colour.
  const flash = document.createElement('div');
  flash.className = 'afx flash';
  document.body.append(flash);
  flash.animate([{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 0 }], { duration: 520, fill: 'forwards' });
  setTimeout(() => flash.remove(), 540);
  await sleep(130);
  ov.classList.remove('glowing');
  ov.classList.add('revealed');
  card.animate([{ transform: 'scale(1.15)' }, { transform: 'scale(.97)', offset: 0.6 }, { transform: 'scale(1)' }], { duration: 480, easing: 'cubic-bezier(.3,.7,.4,1.4)' });
  stamp({ left: innerWidth / 2 - 10, top: innerHeight / 2 + h * 0.36, width: 20, height: 40 }, `${esc(cardName(to))}!`, 'evolve-stamp', { dur: 1500 });
  await sleep(1100);
  // Back to its spot on the mat (the engine then re-renders it as the evolved card).
  ov.querySelector('.ev-rays').style.opacity = 0;
  ov.animate([{ background: 'rgba(3,7,20,.82)' }, { background: 'rgba(3,7,20,0)' }], { duration: 420, fill: 'forwards' });
  const back = document.querySelector(`[data-mon="${mon}"] .top-card`)?.getBoundingClientRect() || home;
  await moveTo(card, back, 420);
  ov.remove();
  document.body.classList.remove('arena-on');
  const s2 = document.querySelector(`[data-mon="${mon}"] .top-card`);
  if (s2) s2.style.visibility = '';
}

// ---------------- Playing cards from the hand ----------------
// Benching: the card flies from the hand into its new Bench slot (Gary's turns face up on the way).
function onBench({ p, card }) {
  if (!animOn()) return;
  const from = p === 0 ? document.querySelector(`#hand [data-card="${card.uid}"]`) : document.querySelector('#opp-hand .ocard:last-child img');
  if (!from) return;
  arrivingCards.add(card.uid);
  if (p === 0) from.style.visibility = 'hidden';
  // Until the engine re-renders, the new Bench slot doesn't exist yet; the flight retargets as soon as it does.
  track(fly(from, () => document.querySelector(`[data-cuid="${card.uid}"]`) || from, { front: cardImage(card), faceUp: p === 0 }).then(() => reveal(card.uid)));
}

// A deck is shuffled (at the start, after a mulligan, by an effect): its pile riffles. Only that it happened is shown.
async function onShuffle({ players }) {
  if (!animOn()) return;
  const piles = players.map((p) => $(`#${p === ME ? 'you' : 'opp'}-piles .stack.deck`)).filter(Boolean);
  piles.forEach((el) => el.classList.remove('shuffling'));
  void document.body.offsetWidth; // restart the animation
  piles.forEach((el) => el.classList.add('shuffling'));
  await sleep(900);
  piles.forEach((el) => el.classList.remove('shuffling'));
}

// Gary's Trainer cards: the card flips face up at centre stage with its printed text, then goes to the discard pile.
async function onTrainer({ p, card }) {
  if (p !== 1 || !animOn()) return;
  inspect(null);
  const from = document.querySelector('#opp-hand .ocard:last-child img');
  const ov = document.createElement('div');
  ov.className = 'trainer-stage';
  ov.innerHTML = `<div class="ts-row"><div class="ts-slot"><img src="${cardImage(card, true)}" alt=""></div>
    <div class="ts-text"><small>${icon(card.stadium ? 'landmark' : TTYPE_ICON[card.ttype] ?? 'backpack')} ${esc(t('ui.oppTrainer', { P: { $pl: 1 } }))}</small>
      <b>${esc(cardName(card))}</b><p>${esc(card.texts?.card ?? '')}</p></div></div>`;
  document.body.append(ov);
  const slot = ov.querySelector('.ts-slot');
  ov.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, fill: 'forwards' });
  if (from) await fly(from, slot, { front: cardImage(card) });
  slot.classList.add('shown');
  ov.classList.add('revealed');
  // Stay long enough to read; a click moves on sooner.
  await Promise.race([sleep(2600), new Promise((r) => ov.addEventListener('pointerdown', r, { once: true }))]);
  const pile = document.querySelector('#opp-piles [data-pile="discard"]');
  ov.classList.add('leaving');
  if (pile && !card.stadium && !card.tool) {
    slot.style.visibility = 'hidden';
    const done = fly(slot, pile, { front: cardImage(card), faceUp: true });
    ov.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: 'forwards' });
    await done;
  } else {
    // A hidden page pauses animations, so never wait on one forever (the game would stop until you come back).
    const fade = ov.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: 'forwards' });
    await Promise.race([fade.finished, sleep(450)]);
  }
  ov.remove();
}

// ---------------- Attaching cards ----------------
// Card animations still playing; Gary waits for them before his next move so a re-render can't cut them off.
const pendingAnims = new Set();
const track = (promise) => { pendingAnims.add(promise); promise.finally(() => pendingAnims.delete(promise)); return promise; };

async function onAttach({ p, mon, card }) {
  if (!animOn()) return;
  const dropped = p === 0 && lastDrop && Date.now() - lastDrop.at < 1500 ? lastDrop.rect : null;
  lastDrop = null;
  const handCard = p === 0 ? document.querySelector(`#hand [data-card="${card.uid}"]`) : document.querySelector('#opp-hand .ocard:last-child img');
  // A card you just dragged starts its flight where you released it, not back in the hand.
  const from = dropped ? { getBoundingClientRect: () => dropped } : handCard;
  const monEl = document.querySelector(`[data-mon="${mon}"]`);
  if (!from || !monEl) return;
  arrivingCards.add(card.uid);
  if (p === 0 && handCard) handCard.style.visibility = 'hidden';
  // Phase 1: fly to just past the Pokémon on the side where the tucked strip shows (below on your side,
  // above on Gary's), so the flying card never covers the Pokémon.
  const dir = p === 0 ? 1 : -1;
  const cardH = monEl.querySelector('.top-card')?.offsetHeight || 120;
  const approach = dir * cardH * 0.85;
  const tucked = () => document.querySelector(`[data-cuid="${card.uid}"]`);
  track(fly(from, () => tucked() || monEl.querySelector('.top-card'), { front: cardImage(card), offsetY: approach }).then(() => {
    // Phase 2: hand over to the real tucked card, which sits behind the Pokémon: the Pokémon lifts a little,
    // the card slides in underneath, then the Pokémon settles back and closes over it.
    const tk = tucked();
    const top = document.querySelector(`[data-mon="${mon}"] .top-card`);
    reveal(card.uid);
    if (!tk) return;
    const base = getComputedStyle(tk).transform;
    const baseT = base === 'none' ? '' : base;
    tk.animate([
      { transform: `${baseT} translateY(${approach}px)`, offset: 0 },
      { transform: `${baseT} translateY(${approach * 0.35}px)`, offset: 0.45, easing: 'cubic-bezier(.3,.6,.3,1)' },
      { transform: baseT || 'none', offset: 1 },
    ], { duration: 520, easing: 'cubic-bezier(.4,0,.2,1)' });
    top?.animate([
      { transform: 'none' },
      { transform: `translateY(${-dir * 7}px) rotate(${dir * -1.2}deg)`, offset: 0.35, easing: 'ease-out' },
      { transform: `translateY(${-dir * 7}px) rotate(${dir * -1.2}deg)`, offset: 0.6, easing: 'ease-in' },
      { transform: `translateY(${dir * 1.5}px)`, offset: 0.88 },
      { transform: 'none' },
    ], { duration: 560 });
    return sleep(580);
  }));
  await sleep(80); // let the flight start from the hand before the hand re-renders
}

// ---------------- Decision engine (Settings) ----------------
// A backend (api.js) owns the engine choice and the local model process; the page polls its state. Without one the
// built-in CPU engine plays, and the other engines show as waiting for the new decision engine.
let engine = null;
let engineUsable = false; // Gary plays with the chosen backend engine (otherwise the CPU engine)
let enginePoll = null;
const GB = (b) => (b / 1e9).toFixed(1);

function engineLabel(e = engine) {
  if (!e) return '…';
  if (e.engine === 'cpu') return t('eng.badge.cpu');
  if (e.engine === 'jev') return t(online() ? 'eng.badge.jev' : 'eng.badge.offline');
  const m = e.models.find((x) => x.id === e.model);
  if (e.local.status === 'ready') return t('eng.badge.local', { m: m?.name });
  return t('eng.badge.loading', { m: m?.name, s: engineStatusText(e) });
}

function engineStatusText(e = engine) {
  const L = e.local;
  if (L.status === 'downloading' && L.totalBytes) return t('eng.status.downloading', { p: `${Math.min(100, Math.round((100 * L.downloadedBytes) / L.totalBytes))}%` });
  if (L.status === 'downloading') return t('eng.status.downloading', { p: `${GB(L.downloadedBytes)} GB` });
  return t('eng.status.' + L.status, { e: L.error });
}

function applyEngine(e) {
  engine = e;
  // Gary uses the model only once it is ready; until then the CPU engine plays.
  // Jev is hosted: offline, the CPU engine plays until the connection is back (local models work offline).
  engineUsable = e.engine === 'jev' ? e.jevKeySet && online() : e.engine === 'local' ? e.local.status === 'ready' : false;
  $('#engine-badge').textContent = engineLabel(e);
  $('#engine-badge').classList.toggle('busy', e.engine === 'local' && e.local.status !== 'ready');
  const m = e.models.find((x) => x.id === e.model);
  const host = $('#start-engine');
  if (!host.querySelector('#start-engine-change')) {
    host.innerHTML = '<small></small><span><b></b> <button class="linkish" id="start-engine-change"></button></span>';
    $('#start-engine-change').onclick = openSettings;
  }
  host.querySelector('small').textContent = t('ui.engineLabel');
  host.querySelector('b').textContent = engineLabel(e);
  $('#start-engine-change').textContent = t('ui.change');
  if (!$('#settings').hidden) renderEngineBox();
  const busy = e.engine === 'local' && ['installing', 'downloading', 'starting'].includes(e.local.status);
  clearTimeout(enginePoll);
  enginePoll = setTimeout(refreshEngine, busy || !$('#settings').hidden ? 1500 : 15000);
}

async function refreshEngine() {
  try { applyEngine(await (await api('/api/engine')).json()); }
  catch { clearTimeout(enginePoll); enginePoll = setTimeout(refreshEngine, 5000); }
}

async function setEngine(body) {
  const r = await api('/api/engine', { method: 'POST', body });
  applyEngine(await r.json());
}

// The engine section of Settings: one engine picked from three words, and only that engine's details below it
// (its key, or the local models as a plain list). Re-rendered while Settings is open (download progress), so a key
// being typed survives, and nothing is redrawn when nothing changed.
let engineBoxHtml = '';
function renderEngineBox() {
  if (!engine) return;
  const e = engine;
  // No internet: Jev can't be chosen. The web version has only the CPU engine; the others come with the macOS app.
  const off = (id) => (!hasBackend() && id !== 'cpu') || (id === 'jev' && !online());
  const split = (s) => { const m = s.match(/^(.*?)\s*[（(](.*)[)）]\s*$/); return m ? [m[1], m[2]] : [s, '']; }; // "CPU (built in)" → name, note
  const tabs = ['cpu', 'jev', 'local'].map((id) => {
    const [name, printed] = split(t(`eng.${id}.t`));
    const note = !hasBackend() && id !== 'cpu' ? t('eng.pending.tab') : printed;
    const on = e.engine === id;
    return `<label class="eng-tab${on ? ' on' : ''}${off(id) ? ' off' : ''}"><input type="radio" name="engine" value="${id}" ${on ? 'checked' : ''} ${off(id) ? 'disabled' : ''}>
      <b>${esc(name)}</b>${note ? `<small>${esc(note)}</small>` : ''}</label>`;
  }).join('');
  const desc = t(e.engine !== 'cpu' ? `eng.${e.engine}.d` : hasBackend() ? 'eng.cpu.d' : 'eng.cpu.dWeb');
  const notes = [
    hasBackend() && !online() && t('eng.offline'),
    e.engine !== 'cpu' && !engineUsable && (e.engine !== 'jev' || (online() && e.jevKeySet)) && t('eng.fallbackNote', { m: engineLabel(e) }),
  ].filter(Boolean).map((n) => `<p class="eng-warn">${esc(n)}</p>`).join('');

  let body = '';
  if (e.engine === 'jev' && online()) {
    body = `<div class="key-row">
        <input type="password" id="jev-key" placeholder="${esc(t('eng.jev.key'))}" aria-label="${esc(t('eng.jev.key'))}" autocomplete="off" spellcheck="false">
        <button type="button" class="primary" id="jev-save">${esc(t('eng.jev.save'))}</button></div>
      <p class="eng-small">${esc(t(e.jevKeySet ? 'eng.jev.saved' : 'eng.jev.missing'))}</p>`;
  }
  if (e.engine === 'local') {
    const rows = e.models.map((m) => {
      const active = e.model === m.id;
      const running = e.local.model === m.id;
      const busy = running && ['downloading', 'starting', 'installing'].includes(e.local.status);
      const pctDone = e.local.status === 'starting' ? 100 : running && e.local.totalBytes ? Math.min(100, (100 * e.local.downloadedBytes) / e.local.totalBytes) : 0;
      const status = running ? engineStatusText(e) : t(m.installed ? 'eng.installed' : 'eng.notInstalled');
      const inUse = active && running;
      const side = inUse
        ? `<span class="m-state${e.local.status === 'ready' ? ' ok' : ''}">${esc(e.local.status === 'ready' ? t('eng.active') : status)}</span>`
        : `<button type="button" class="m-act" data-model="${m.id}">${esc(t(m.installed ? 'eng.use' : 'eng.download'))}</button>`;
      const meta = [
        m.accuracy && t('eng.acc', { a: `${Math.round(m.accuracy * 100)}%` }),
        t('eng.speed.' + m.speed),
        m.size && `${GB(m.size)} GB`,
        !inUse && status,
      ].filter(Boolean).map(esc).join(' · ');
      return `<li class="m-row${inUse ? ' on' : ''}">
        <div class="m-head"><b>${esc(m.name)}</b>${m.recommended ? `<em>${esc(t('eng.recommended'))}</em>` : ''}<span class="m-meta">${meta}</span></div>
        <div class="m-side">${side}</div>
        <p>${esc(m.description ?? '')}</p>
        ${busy ? `<div class="m-bar"><i style="width:${pctDone}%"></i></div>` : ''}
        ${running && e.local.status === 'error' ? `<p class="m-err">${esc(e.local.error)}</p>` : ''}
      </li>`;
    }).join('');
    body = `<ul class="m-list">${rows}</ul>${e.local.model ? `<button type="button" class="textlink m-stop" id="local-stop">${esc(t('eng.stop'))}</button>` : ''}`;
  }

  if (!hasBackend()) body = `<p class="eng-mac">${esc(t('eng.pending'))}</p>`;
  const html = `<div class="eng-tabs" role="radiogroup" aria-labelledby="eng-title">${tabs}</div>
    <p class="eng-desc">${esc(desc)}</p>${notes}${body}`;
  if (html === engineBoxHtml) return;
  engineBoxHtml = html;
  const box = $('#engine-box');
  const key = $('#jev-key');
  const keep = key && { value: key.value, focused: document.activeElement === key };
  const focusedEngine = document.activeElement?.name === 'engine' && document.activeElement.value;
  box.innerHTML = html;
  if (keep && $('#jev-key')) { $('#jev-key').value = keep.value; if (keep.focused) $('#jev-key').focus(); }
  if (focusedEngine) box.querySelector(`input[name="engine"][value="${focusedEngine}"]`)?.focus();

  box.querySelectorAll('input[name="engine"]').forEach((r) => (r.onchange = () => setEngine({ engine: r.value })));
  box.querySelectorAll('[data-model]').forEach((b) => (b.onclick = () => setEngine({ engine: 'local', model: b.dataset.model })));
  const save = () => {
    const k = $('#jev-key').value.trim();
    if (k) setEngine({ engine: 'jev', jevKey: k });
  };
  if ($('#jev-save')) {
    $('#jev-save').onclick = save;
    $('#jev-key').onkeydown = (ev) => { if (ev.key === 'Enter') save(); };
  }
  const stop = $('#local-stop');
  if (stop) stop.onclick = () => api('/api/engine/stop', { method: 'POST' }).then((r) => r.json()).then(applyEngine);
}

// Going on- or offline changes what Gary can think with (Jev needs the internet).
for (const ev of ['online', 'offline']) window.addEventListener(ev, () => { if (engine) applyEngine(engine); });

function openSettings() {
  if ($('#settings').hidden) settingsFrom = document.activeElement;
  $('#settings').hidden = false;
  $('#settings .dialog').focus();
  engineBoxHtml = '';
  renderEngineBox();
  refreshEngine();
}

// ---------------- Drag and drop from the hand ----------------
// Picking up a hand card highlights only where it can legally go (from the current list of legal moves);
// dropping it there makes that move, exactly like clicking the move's button.
let drag = null;

function dropZones(card) {
  const acts = decision.actions.filter((a) => a.card && a.card.uid === card.uid);
  const zones = new Map();
  const add = (el, a) => { if (!el) return; if (!zones.has(el)) zones.set(el, []); zones.get(el).push(a); };
  for (const a of acts) {
    if (a.target) {
      const el = document.querySelector(`[data-mon="${a.target.id}"]`);
      if (el && a.kind === 'energy' && isOffType(a)) el.classList.add('drop-weak');
      add(el, a);
    }
    else if (a.kind === 'bench') add($('#you-bench'), a);
    else add(playZone(card), a);
  }
  return [...zones].map(([el, actions]) => ({ el, actions }));
}

function playZone(card) {
  let z = $('#play-zone');
  if (!z) {
    z = document.createElement('div');
    z.id = 'play-zone';
    $('#board').append(z);
  }
  z.innerHTML = `${icon('circle-plus')} ${esc(t('drag.play', { c: { $card: card } }))}`;
  z.hidden = false;
  return z;
}

function startDrag(e) {
  const { el, card } = drag;
  drag.started = true;
  drag.zones = dropZones(card);
  inspect(null);
  document.body.classList.add('dragging');
  el.classList.add('drag-src');
  drag.zones.forEach((z) => z.el.classList.add('drop-ok'));
  const g = document.createElement('div');
  g.className = 'drag-ghost' + (drag.zones.length ? '' : ' no');
  const why = drag.zones.length ? '' : `<div class="why">${icon('lightbulb')} ${esc(t(...whyNot(card, game.players[ME])))}</div>`;
  g.innerHTML = `<img src="${cardImage(card)}" alt="">${why}`;
  document.body.append(g);
  drag.ghost = g;
  moveDrag(e);
  // Pick-up: start exactly where the card sits in the fan (its rotation and hover scale), then ease to the pointer.
  const src = el.querySelector('img').getBoundingClientRect();
  const dx = src.left + src.width / 2 - e.clientX, dy = src.top + src.height / 2 - e.clientY;
  const gw = g.offsetWidth, gh = g.offsetHeight;
  const rot0 = parseFloat(el.style.getPropertyValue('--rot')) || 0;
  // The ghost's resting transform is translate(-50%, -60%): convert the card centre into that frame.
  const ox = dx, oy = dy + gh * 0.1;
  g.animate([
    { transform: `translate(calc(-50% + ${ox}px), calc(-60% + ${oy}px)) rotate(${rot0}deg) scale(${src.width / gw})` },
    { transform: 'translate(-50%, -60%) rotate(-5deg) scale(1.08)' },
  ], { duration: 180, easing: 'cubic-bezier(.2,.7,.3,1)' });
}

function moveDrag(e) {
  const g = drag.ghost;
  g.style.transform = `translate3d(${e.clientX}px, ${e.clientY}px, 0) translate(-50%, -60%) rotate(-5deg) scale(1.08)`; // compositor only
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  const zone = hit && drag.zones.find((z) => z.el.contains(hit));
  drag.zones.forEach((z) => z.el.classList.toggle('drop-hover', z === zone));
  drag.over = zone || null;
}

// Where the last dropped card was released, so an attach flight can start from there instead of the hand.
let lastDrop = null;

function endDrag(cancel = false) {
  const d = drag;
  drag = null;
  if (!d?.started) return;
  document.body.classList.remove('dragging');
  d.zones.forEach((z) => z.el.classList.remove('drop-ok', 'drop-hover', 'drop-weak'));
  const pz = $('#play-zone');
  const g = d.ghost;
  const placed = !cancel && d.over && decision;
  if (!placed) {
    // Glide back to its place in the fan.
    const home = d.el.querySelector('img').getBoundingClientRect();
    const r = g.getBoundingClientRect();
    const rot = parseFloat(d.el.style.getPropertyValue('--rot')) || 0;
    const tx = home.left + home.width / 2 - (r.left + r.width / 2), ty = home.top + home.height / 2 - (r.top + r.height / 2);
    g.animate([
      { transform: 'translate(-50%, -60%) rotate(-5deg) scale(1.08)' },
      { transform: `translate(calc(-50% + ${tx}px), calc(-60% + ${ty}px)) rotate(${rot}deg) scale(${home.width / g.offsetWidth})` },
    ], { duration: 220, easing: 'cubic-bezier(.3,.6,.3,1)', fill: 'forwards' });
    setTimeout(() => { g.remove(); d.el.classList.remove('drag-src'); if (pz) pz.hidden = true; }, 220);
    return;
  }
  const acts = d.over.actions;
  const attaches = acts.length === 1 && (acts[0].kind === 'energy' || (acts[0].kind === 'trainer' && acts[0].target));
  if (attaches) {
    lastDrop = { rect: g.querySelector('img').getBoundingClientRect(), at: Date.now() };
    g.remove();
  } else {
    // Settle into the drop zone and fade.
    const z = d.over.el.getBoundingClientRect(), r = g.getBoundingClientRect();
    const tx = z.left + z.width / 2 - (r.left + r.width / 2), ty = z.top + z.height / 2 - (r.top + r.height / 2);
    g.animate([
      { transform: 'translate(-50%, -60%) rotate(-5deg) scale(1.08)', opacity: 1 },
      { transform: `translate(calc(-50% + ${tx}px), calc(-60% + ${ty}px)) rotate(0deg) scale(.85)`, opacity: 0 },
    ], { duration: 200, easing: 'ease-in', fill: 'forwards' });
    setTimeout(() => g.remove(), 200);
  }
  d.el.classList.remove('drag-src');
  if (pz) pz.hidden = true;
  if (acts.length === 1) decision.pick(acts[0]);
  else chooseFromMenu(acts, d.lastX, d.lastY); // e.g. Energy Removal on a Pokémon with two Energy types
}

function chooseFromMenu(actions, x, y) {
  const m = document.createElement('div');
  m.className = 'drop-menu';
  m.innerHTML = `<div class="dm-title">${esc(t('drag.choose'))}</div>` +
    actions.map((a, i) => `<button data-i="${i}">${esc(t(a.label.key, a.label.params))}</button>`).join('');
  Object.assign(m.style, { left: `${Math.min(x, innerWidth - 280)}px`, top: `${Math.min(y, innerHeight - 60 - 40 * actions.length)}px` });
  document.body.append(m);
  const close = () => { m.remove(); document.removeEventListener('pointerdown', outside, true); };
  const outside = (ev) => { if (!m.contains(ev.target)) close(); };
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
  m.querySelectorAll('button').forEach((b) => (b.onclick = () => { close(); decision?.pick(actions[Number(b.dataset.i)]); }));
}

document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('#hand .hcard');
  if (!el || !decision || e.button !== 0) return;
  const card = inspectables.get('c' + el.dataset.card);
  if (!card) return;
  e.preventDefault();
  drag = { el, card, x0: e.clientX, y0: e.clientY, started: false };
});
document.addEventListener('pointermove', (e) => {
  if (!drag) return;
  drag.lastX = e.clientX; drag.lastY = e.clientY;
  if (!drag.started && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 6) startDrag(e);
  else if (drag.started) moveDrag(e);
});
document.addEventListener('pointerup', () => endDrag());
document.addEventListener('pointercancel', () => endDrag(true));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') endDrag(true); });

// ---------------- Coin flips ----------------
const coinFace = (side) => (side === 'h'
  ? '<div class="face heads"><div class="pokeball"></div></div>'
  : `<div class="face tails">${icon('star')}</div>`);

// A coin built in CSS 3D: two faces and a ridged rim made of thin segments arranged in a circle.
const RIM_SEGMENTS = 36;
const coin3d = () => `<div class="coin-shadow"></div><div class="coin-toss"><div class="coin3d">
  ${coinFace('h')}${coinFace('t')}
  <div class="rim">${Array.from({ length: RIM_SEGMENTS }, (_, i) => `<span style="--a:${(360 / RIM_SEGMENTS) * i}deg"></span>`).join('')}</div>
</div></div>`;

// The coin stage: a dark vignette with a big 3D coin resting on a felt spot. Calling heads/tails and the toss
// itself use the same stage, so after you call, the very same coin is tossed.
let callStage = null; // stage element kept open between the call and the first toss

const miniFace = (side) => `<span class="mini-face ${side}">${coinFace(side)}</span>`;

function stageShell(title, sub) {
  const el = document.createElement('div');
  el.className = 'overlay coin-ov stage';
  el.innerHTML = `<div class="coin-stage">
    <div class="cs-title">${icon('coins')} <span>${esc(title)}</span></div>
    <div class="cs-sub">${esc(sub)}</div>
    <div class="cs-row">
      <div class="cs-side h"></div>
      <div class="coin-scene"><div class="rays"></div><div class="felt"></div>${coin3d()}</div>
      <div class="cs-side t"></div>
    </div>
    <div class="coin-result">&nbsp;</div>
    <div class="coin-tally"></div>
    <button class="cs-continue" hidden>${esc(t('ui.continue'))}</button>
  </div>`;
  document.body.append(el);
  return el;
}

function showCoin(ctx) {
  if (!animOn()) { callStage?.remove(); callStage = null; return Promise.resolve(); }
  return new Promise((resolve) => {
    const title = t('coin.why.' + ctx.why, ctx.params);
    const sub = ctx.why === 'first' ? t('ui.youCalled', { c: ctx.params.call }) : t('ui.coinSub');
    let el = callStage;
    callStage = null;
    if (el) {
      el.querySelector('.cs-title span').textContent = title;
      el.querySelector('.cs-sub').textContent = sub;
      el.classList.remove('calling');
    } else el = stageShell(title, sub);
    const side = (o, cls, label) => (o
      ? `${miniFace(cls)}<div class="cs-label">${esc(label)}</div><div class="cs-out">${esc(t(o.key, o.params))}</div>`
      : `${miniFace(cls)}<div class="cs-label">${esc(label)}</div>`);
    el.querySelector('.cs-side.h').innerHTML = side(ctx.heads, 'h', t('ui.heads'));
    el.querySelector('.cs-side.t').innerHTML = side(ctx.tails, 't', t('ui.tails'));
    el.querySelectorAll('.cs-side').forEach((s) => s.classList.remove('win', 'lose', 'pick'));
    const btn = el.querySelector('.cs-continue');
    let done = false;
    const finish = () => { if (done) return; done = true; el.classList.add('closing'); setTimeout(() => el.remove(), 220); resolve(); };

    // Toss: up and down under gravity, tumbling end over end, then a small bounce and wobble on landing.
    const end = 360 * 6 + (ctx.h ? 0 : 180);
    const height = el.querySelector('.coin-scene').offsetHeight * 0.9;
    const T = 1500;
    const coinEl = el.querySelector('.coin3d');
    coinEl.getAnimations().forEach((a) => a.cancel());
    coinEl.classList.add('spinning');
    el.querySelector('.coin-toss').animate([
      { transform: 'translateY(0)', easing: 'cubic-bezier(.2,.65,.45,1)' },
      { transform: `translateY(${-height}px)`, offset: 0.45, easing: 'cubic-bezier(.55,0,.8,.35)' },
      { transform: 'translateY(0)', offset: 0.86, easing: 'ease-out' },
      { transform: `translateY(${-height * 0.08}px)`, offset: 0.93, easing: 'ease-in' },
      { transform: 'translateY(0)' },
    ], { duration: T, fill: 'forwards' });
    coinEl.animate([
      { transform: 'rotateY(18deg) rotateX(0deg)', easing: 'cubic-bezier(.25,.6,.5,1)' },
      { transform: `rotateY(4deg) rotateX(${end - 8}deg)`, offset: 0.86 },
      { transform: `rotateY(-3deg) rotateX(${end + 6}deg)`, offset: 0.93 },
      { transform: `rotateY(0deg) rotateX(${end}deg)` },
    ], { duration: T, fill: 'forwards' });
    el.querySelector('.coin-shadow').animate([
      { transform: 'translateX(-50%) scale(1)', opacity: 0.55 },
      { transform: 'translateX(-50%) scale(.4)', opacity: 0.15, offset: 0.45 },
      { transform: 'translateX(-50%) scale(1)', opacity: 0.55, offset: 0.86 },
      { transform: 'translateX(-50%) scale(.9)', opacity: 0.45, offset: 0.93 },
      { transform: 'translateX(-50%) scale(1)', opacity: 0.55 },
    ], { duration: T, fill: 'forwards' });
    setTimeout(() => coinEl.classList.remove('spinning'), T * 0.86);
    setTimeout(() => {
      el.classList.add('landed', ctx.h ? 'is-h' : 'is-t');
      const res = el.querySelector('.coin-result');
      res.textContent = t('ui.result', { h: t(ctx.h ? 'ui.heads' : 'ui.tails') });
      res.classList.add(ctx.h ? 'h' : 't');
      el.querySelector(`.cs-side.${ctx.h ? 'h' : 't'}`).classList.add('win');
      el.querySelector(`.cs-side.${ctx.h ? 't' : 'h'}`).classList.add('lose');
      if (ctx.why === 'multi') el.querySelector('.coin-tally').textContent = t('ui.headsSoFar', { n: ctx.params.so + (ctx.h ? 1 : 0) });
      btn.hidden = false;
      btn.onclick = finish;
      el.onclick = (e) => { if (e.target === el) finish(); };
      setTimeout(finish, 2400);
    }, 1550);
  });
}

// Before the game: call heads or tails on the same stage (H / T keys work too).
function callCoinStage() {
  return new Promise((resolve) => {
    const el = stageShell(t('ui.callIt'), t('ui.callText'));
    el.classList.add('calling');
    const pick = (call) => {
      if (!el.isConnected || !el.classList.contains('calling')) return;
      document.removeEventListener('keydown', onKey);
      el.querySelector(`.cs-side.${call === 'heads' ? 'h' : 't'}`).classList.add('pick');
      el.classList.remove('calling');
      callStage = el;
      resolve(call);
    };
    const onKey = (e) => { if (e.key === 'h' || e.key === 'H') pick('heads'); if (e.key === 't' || e.key === 'T') pick('tails'); };
    document.addEventListener('keydown', onKey);
    for (const [cls, call, label] of [['h', 'heads', t('ui.heads')], ['t', 'tails', t('ui.tails')]]) {
      const s = el.querySelector(`.cs-side.${cls}`);
      s.innerHTML = `<button class="call-btn" data-call="${call}">${miniFace(cls)}<span class="cs-label">${esc(label)}</span><span class="cs-key">${call === 'heads' ? 'H' : 'T'}</span></button>`;
      s.querySelector('button').onclick = () => pick(call);
    }
  });
}

function prizesHtml(p) {
  const slots = Array.from({ length: PRIZES }, (_, i) => (i < p.prizes.length ? backImg() : '<div class="slot"></div>')).join('');
  return `${slots}<div class="cap">${esc(t('ui.prizes'))}: ${p.prizes.length}</div>`;
}

function pilesHtml(p) {
  const top = p.discard.at(-1);
  if (top) inspectables.set('d' + p.idx, top);
  // Seen from above: the top card back, a few slightly misaligned cards peeking out from under it,
  // and a shadow that grows with the number of cards left (a thicker deck casts a bigger shadow).
  const under = p.deck.length > 1 ? Math.min(4, 1 + Math.floor(p.deck.length / 15)) : 0;
  const jitter = (i, k) => (Math.sin((p.idx + 1) * 12.9898 + i * 78.233 + k * 37.719) * 43758.5453) % 1;
  const deck = p.deck.length
    ? `<div class="stack deck" style="--sh:${(2 + p.deck.length / 6).toFixed(1)}">${Array.from({ length: under }, (_, i) =>
        `<img class="under" src="${cardBack()}" alt="" draggable="false" style="transform: translate(${(jitter(i, 1) * 2.2).toFixed(2)}px, ${(jitter(i, 2) * 2.2).toFixed(2)}px) rotate(${(jitter(i, 3) * 2.6).toFixed(2)}deg)">`).join('')}<img class="top" src="${cardBack()}" alt="" draggable="false"></div>`
    : '<div class="empty"></div>';
  const tilt = (c) => ((c.uid * 37) % 15) - 7;
  const discard = top
    ? `<div class="stack discard" data-inspect="d${p.idx}">${p.discard.slice(-3).map((c) =>
        `<img src="${cardImage(c)}" alt="" style="transform: rotate(${tilt(c)}deg)">`).join('')}</div>`
    : '<div class="empty"></div>';
  return `<div class="pile" data-pile="deck">${deck}<span class="count">${p.deck.length}</span><div>${esc(t('ui.deck'))}</div></div>
    <div class="pile" data-pile="discard">${discard}<span class="count">${p.discard.length}</span><div>${esc(t('ui.discard'))}</div></div>`;
}

// ---------------- Hand layout and draw animation ----------------
let seenHand = new Set();          // your hand card uids at the last render
let seenOppHand = 0;
let oppPrizeTaken = false;         // Gary just took a Prize card: his new hand card comes from his Prize cards
let animateDraws = false;          // off while restoring a saved game
const arrivingCards = new Set();   // uids still flying into your hand

// Overlap hand cards when they don't fit, instead of scrolling.
function layoutHand() {
  const hand = $('#hand');
  const cards = [...hand.children];
  if (!cards.length) return;
  // Measuring forces a style pass, so setting margin/rotation afterwards would otherwise *transition*
  // every card from 0 into place on each re-render. Lay out instantly; re-enable transitions next frame.
  hand.classList.add('instant');
  requestAnimationFrame(() => requestAnimationFrame(() => hand.classList.remove('instant')));
  const w = cards[0].getBoundingClientRect().width;
  const avail = hand.clientWidth;
  const gap = 8;
  const step = cards.length > 1 ? Math.min(w + gap, (avail - w) / (cards.length - 1)) : 0;
  // Hold the cards in a gentle arc, like a real hand: each card rotates a little and the outer ones sit lower.
  const n = cards.length, mid = (n - 1) / 2, spread = Math.min(3.2, 26 / Math.max(n, 1));
  cards.forEach((el, i) => {
    el.style.marginLeft = i ? `${step - w}px` : '0';
    el.style.zIndex = i;
    const off = i - mid;
    el.style.setProperty('--rot', `${(off * spread).toFixed(2)}deg`);
    el.style.setProperty('--lift', `${(off * off * 0.9).toFixed(1)}px`);
  });
}
window.addEventListener('resize', layoutHand);

// The largest card-shaped box (5:7) centred in a rect, so flights never distort the card image.
function cardBox(r) {
  const ratio = 1.396;
  let w = r.width, h = r.width * ratio;
  if (h > r.height && r.height > 0) { h = r.height; w = h / ratio; }
  return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h };
}

// A card flies from `from` to `to`. Your cards turn face up on the way; the opponent's stay face down.
// The un-rotated box of an element (its layout size around its on-screen centre), for rotated hand cards.
function layoutBox(el) {
  const r = el.getBoundingClientRect();
  if (!el.offsetWidth) return cardBox(r);
  const w = el.offsetWidth, h = el.offsetHeight, cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  return cardBox({ left: cx - w / 2, top: cy - h / 2, width: w, height: h });
}

// A card flies from `from` to `to` (an element, or a function returning the current target element).
// The flight is driven frame by frame and re-reads the target's position every frame, so if the hand
// re-arranges while the card is in the air (another card played, a card added), it still lands exactly
// on its card. Your cards flip face up on the way; Gary's stay face down.
function fly(from, to, { front = null, delay = 0, rot = 0, offsetY = 0, faceUp = false, spin = 0 } = {}) {
  const getTarget = typeof to === 'function' ? to : () => to;
  let tEl = getTarget();
  if (!from || !tEl) return Promise.resolve();
  const a = cardBox(from.getBoundingClientRect());
  let b = layoutBox(tEl);
  const w = b.width, h = b.height;
  const el = document.createElement('div');
  el.className = 'fly';
  Object.assign(el.style, { left: '0px', top: '0px', width: `${w}px`, height: `${h}px`, transformOrigin: '50% 50%', visibility: 'hidden' });
  el.innerHTML = `<div class="fly-inner ${front ? '' : 'back-only'}">${front ? `<img class="ff" src="${front}" alt="">` : ''}<img class="fb" src="${cardBack()}" alt=""></div>`;
  document.body.append(el);
  const inner = el.firstChild;
  const D = 760, s0 = a.width / w;
  const A = { x: a.left + a.width / 2, y: a.top + a.height / 2 };
  const t0 = performance.now() + delay;
  const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; el.remove(); resolve(); };
    const frame = (now) => {
      if (done) return;
      const p = Math.min(1, Math.max(0, (now - t0) / D));
      const cur = getTarget();
      if (cur?.isConnected) { tEl = cur; b = layoutBox(cur); }
      const rotEnd = parseFloat(tEl?.style?.getPropertyValue('--rot')) || rot;
      const B = { x: b.left + b.width / 2, y: b.top + b.height / 2 + offsetY };
      const e = ease(p), arc = Math.sin(Math.PI * e);
      const pickUp = p < 0.14 ? Math.sin((p / 0.14) * Math.PI / 2) : 1; // lifted off the pile first
      const lift = Math.min(70, 30 + Math.abs(B.x - A.x) * 0.08);
      const x = A.x + (B.x - A.x) * e;
      const y = A.y + (B.y - A.y) * e - lift * arc - 10 * pickUp * (1 - e);
      const scale = (s0 + (1 - s0) * e) * (1 + 0.08 * arc);
      const r = rotEnd * e - 7 * arc + spin * (1 - e);
      el.style.visibility = 'visible';
      el.style.transform = `translate(${x - w / 2}px, ${y - h / 2}px) rotate(${r}deg) scale(${scale})`;
      if (front && !faceUp) inner.style.transform = `rotateY(${p < 0.18 ? 180 : p > 0.7 ? 0 : 180 * (1 - (p - 0.18) / 0.52)}deg)`;
      if (p < 1) requestAnimationFrame(frame); else finish();
    };
    requestAnimationFrame(frame);
    // Safety net for background tabs, where animation frames are paused.
    setTimeout(finish, delay + D + 600);
  });
}

// Where a card currently is on screen: in your hand, or on the board (top of a Pokémon or tucked under one).
const cardEl = (uid) => document.querySelector(`#hand [data-card="${uid}"]`) || document.querySelector(`[data-cuid="${uid}"]`);
// Gary's cards still flying into his hand (by position in the fan, 1-based), hidden until they land.
const oppArriving = new Set();

function reveal(uid) {
  arrivingCards.delete(uid);
  document.querySelectorAll(`[data-card="${uid}"], [data-cuid="${uid}"]`).forEach((e) => e.classList.remove('arriving'));
}

function flyNewCards(you, opp, newCards) {
  const anim = animateDraws && animOn();
  if (anim) {
    newCards.forEach((c, i) => {
      arrivingCards.add(c.uid);
      const staged = prizeFrom?.uid === c.uid && prizeFrom.el.isConnected ? prizeFrom.el : null;
      const from = staged || $('#you-piles .deck img.top') || $('#you-piles [data-pile="deck"]');
      const target = () => cardEl(c.uid);
      if (!from || !target()) { arrivingCards.delete(c.uid); return; }
      const stage = staged && prizeFrom.stage;
      fly(from, target, { front: cardImage(c), delay: i * 120, faceUp: !!staged }).then(() => reveal(c.uid));
      if (stage) closePrizeStage(stage);
    });
    const extra = opp.hand.length - seenOppHand;
    const prizeTaken = oppPrizeTaken;
    for (let i = 0; i < Math.min(extra, 10); i++) {
      const k = seenOppHand + i + 1;
      oppArriving.add(k);
      document.querySelector(`#opp-hand .ocard:nth-child(${k})`)?.classList.add('arriving');
      const target = () => document.querySelector(`#opp-hand .ocard:nth-child(${k}) img`) || $('#opp-hand .ocard:last-child img');
      // Fly to just below Gary's hand, then the real card slides up into the fan, behind the board's top edge.
      const slide = (target()?.offsetHeight || 60) * 0.7;
      track(fly(prizeTaken ? $('#opp-prizes img') || $('#opp-prizes') : $('#opp-piles .deck img.top') || $('#opp-piles [data-pile="deck"]'),
        target, { delay: i * 120, offsetY: slide, spin: prizeTaken ? -360 : 0 }).then(() => {
        oppArriving.delete(k);
        const oc = document.querySelector(`#opp-hand .ocard:nth-child(${k})`);
        if (!oc) return;
        oc.classList.remove('arriving');
        const base = getComputedStyle(oc).transform;
        const b0 = base === 'none' ? '' : base;
        oc.animate([{ transform: `translateY(${slide}px) ${b0}` }, { transform: b0 || 'none' }], { duration: 320, easing: 'cubic-bezier(.3,.7,.3,1)' });
        return sleep(320);
      }));
    }
  } else {
    newCards.forEach((c) => arrivingCards.delete(c.uid));
    document.querySelectorAll('#hand .arriving').forEach((el) => el.classList.remove('arriving'));
  }
  seenHand = new Set(you.hand.map((c) => c.uid));
  seenOppHand = opp.hand.length;
  oppPrizeTaken = false;
}

// A zone is rewritten only when its markup changed: unchanged cards keep their (decoded) images and nothing re-lays out.
function put(el, html) {
  if (el._html === html && el.childElementCount) return;
  el._html = html;
  el.innerHTML = html;
}

function render() {
  if (!game) return;
  inspectables = new Map();
  const [you, opp] = game.players;
  for (const [p, key] of [[you, 'you'], [opp, 'opp']]) {
    put($(`#${key}-prizes`), prizesHtml(p));
    put($(`#${key}-piles`), pilesHtml(p));
    put($(`#${key}-active`), p.active ? monTile(p.active, { active: true, owner: p }) : `<div class="empty-slot">${esc(t('ui.activeSpot'))}</div>`);
    const empty = Array.from({ length: Math.max(0, (p.benchLimit ?? 5) - p.bench.length) }, () => `<div class="empty-slot">${esc(t('ui.bench'))}</div>`).join('');
    put($(`#${key}-bench`), p.bench.map((m) => monTile(m, { owner: p })).join('') + empty);
  }
  // the opponent's hand: card backs held upside down along the top edge, fanned like a real hand seen from across the table.
  const n = opp.hand.length, mid = (n - 1) / 2;
  $('#opp-hand').innerHTML = `<div class="ofan">${opp.hand.map((_, i) =>
    `<div class="ocard ${oppArriving.has(i + 1) ? 'arriving' : ''}" style="--r:${((i - mid) * Math.min(4, 24 / Math.max(n, 1))).toFixed(2)}deg;--y:${(Math.abs(i - mid) * 1.5).toFixed(1)}px">${backImg()}</div>`).join('')}</div>
    <span class="ocount" title="${esc(t('ui.handCount'))}">${n}</span>`;

  const newCards = you.hand.filter((c) => !seenHand.has(c.uid));
  $('#hand').innerHTML = you.hand.map((c) => {
    inspectables.set('c' + c.uid, c);
    const arriving = arrivingCards.has(c.uid) || (animateDraws && newCards.includes(c)) ? 'arriving' : '';
    return `<div class="hcard ${arriving}" data-inspect="c${c.uid}" data-card="${c.uid}"><img src="${cardImage(c)}" alt="${esc(cardName(c))}" draggable="false"></div>`;
  }).join('');
  layoutHand();
  markPlayable();
  dropStalePreview();
  flyNewCards(you, opp, newCards);

  const cur = game.current;
  // The game's record number: what to quote when reporting a problem with this game (or the replay being watched).
  const matchId = REPLAY ?? recorder?.id;
  const chip = `<span class="rules-chip" title="${esc(t('ui.rulesChipTitle'))}">${esc(t('format.' + (game.format?.id ?? 'open')))}</span>`
    + (matchId ? ` <span class="match-chip" title="${esc(t(REPLAY ? 'ui.replayChipTitle' : 'ui.matchChipTitle'))}">#${esc(matchId)}</span>` : '');
  $('#turn-info').innerHTML = game.phase === 'setup' ? esc(t('ui.setup'))
    : game.winner ? esc(t('ui.gameOver'))
    : `${esc(t('ui.turn', { n: game.turn }))}${cur ? ` · <span class="${cur.idx ? 'opp' : 'you'}">${esc(t(cur.idx ? 'ui.oppTurn' : 'ui.yourTurn'))}</span>` : ''} ${chip}`;
  // The Stadium in play sits between the two players.
  const st = game.stadium?.card;
  if (st) inspectables.set('s' + st.uid, st);
  $('#stadium').hidden = !st;
  $('#stadium').innerHTML = st ? `<img src="${cardImage(st)}" alt="" data-inspect="s${st.uid}"><span><small>${icon('landmark')} ${esc(t('ui.stadium'))}</small><b data-inspect="s${st.uid}">${esc(cardName(st))}</b></span>` : '';
}

// Hovering a card shows a large floating preview next to it. It never takes space in the layout, so nothing jumps.
function inspect(card, reason = null, anchor = null) {
  const pv = $('#preview');
  previewAnchor = card ? anchor : null;
  if (!card) { pv.hidden = true; return; }
  // Hovering a Pokémon in play also explains its current state.
  const key = anchor?.dataset.inspect || '';
  const mon = key.startsWith('m') ? monById(Number(key.slice(1))) : null;
  const why = reason ? `<div class="why">${icon('lightbulb')} ${esc(t(reason[0], reason[1]))}</div>` : '';
  pv.innerHTML = `<img src="${cardImage(card, true)}" alt="${esc(cardName(card))}"><div class="explain">
    <h3 class="pv-name">${esc(cardName(card))}</h3><p class="image-language">${esc(card.setCode ? `${card.setCode} ${card.number}${card.mark ? ` · ${t('ui.mark', { m: card.mark })}` : ''}` : '')}</p>
    ${why}${explainCard(card, mon)}<p class="card-attribution">${esc(t('ui.cardAttribution'))}</p></div>`;
  pv.hidden = false;
  if (anchor) placePreview(anchor);
}

// ---------------- Card explanations ----------------
// The printed text transcribed from the reviewed card image (the release's presentation data), with the facts the
// kernel plays by. Nothing here is a second rules engine: whether a move is possible comes from the legal moves.
const STAGE_TEXT = { basic: '基础宝可梦', stage1: '1阶进化', stage2: '2阶进化' };
const TTYPE_TEXT = { item: '物品', supporter: '支援者', stadium: '竞技场', tool: '宝可梦道具' };

function costText(cost) {
  if (!cost.length) return esc(t('ex.free'));
  const counts = {};
  for (const c of cost) counts[c] = (counts[c] || 0) + 1;
  return Object.entries(counts).map(([k, n]) => `${n} ${energyIcon(k)} ${esc(t('type.' + k))}`).join(' + ');
}

// A text with a type in it: {t} becomes the type's icon and name.
const typed = (key, type, value) => esc(t(key, { t: '@@', v: value })).replace('@@', `${energyIcon(type)} <b>${esc(t('type.' + type))}</b>`);

function explainCard(card, mon = null) {
  const L = (k, p) => esc(t(k, p));
  const text = card.texts ?? {};
  const rules = ['rule', 'tera'].filter((k) => text[k]).map((k) => `<p class="muted">${esc(text[k])}</p>`).join('');
  if (card.kind === 'energy') {
    const what = card.special ? esc(text.card ?? '') : typed('ex.energy', card.energyType);
    return `<h4>${icon('info')} ${L(card.special ? 'ex.specialEnergy' : 'ex.basicEnergy')}</h4><p>${what}</p>${rules}`;
  }
  if (card.kind === 'trainer') {
    return `<p class="ttype">${icon(TTYPE_ICON[card.ttype] ?? 'backpack')} ${esc(TTYPE_TEXT[card.ttype] ?? '')}${card.aceSpec ? ' · ACE SPEC' : ''}</p>
      <h4>${icon('info')} ${L('ex.what')}</h4><p>${esc(text.card ?? '')}</p>${rules}`;
  }
  if (card.kind !== 'pokemon') return `<p>${L('ex.unknown')}</p>`;
  const facts = [
    card.stage === 0 ? L('ex.basic') : L('ex.stage', { s: STAGE_TEXT[card.stageKey] ?? '', from: card.evolvesFrom }),
    ...(card.prizes > 1 ? [L('ex.prizes', { n: card.prizes })] : []),
    L('ex.hp', { hp: card.hp, n: card.hp / 10 }),
    card.weakness ? typed('ex.weak', card.weakness.type, card.weakness.operation === 'multiply' ? `×${card.weakness.value}` : `+${card.weakness.value}`) : L('ex.noWeak'),
    card.resistance ? typed('ex.res', card.resistance.type, `-${card.resistance.value}`) : L('ex.noRes'),
    card.retreat ? L('ex.retreat', { n: card.retreat }) : L('ex.retreat0'),
  ];
  // Your Active Pokémon on your turn: which attacks the kernel offers right now.
  const mine = mon && decision && game.players[ME].active === mon;
  const usable = new Set(mine ? decision.actions.filter((a) => a.kind === 'attack').map((a) => a.cmd.attackId) : []);
  const attacks = card.attacks.map((a) => {
    const ready = mine ? (usable.has(a.id)
      ? `<div class="ready yes">${icon('circle-check')} ${L('now.ready')}</div>`
      : `<div class="ready no">${icon('x')} ${L('now.notReady')}</div>`) : '';
    return `<div class="atk-ex"><div class="atk-name"><b>${esc(a.name)}</b>${a.damage ? `<span class="atk-dmg">${esc(a.damage)}</span>` : ''}</div>
      <div class="atk-cost">${L('ex.cost')} ${costText(a.cost)}</div>
      ${text[a.slug] ? `<div class="fx">${esc(text[a.slug])}</div>` : `<div class="fx muted">${L('ex.noFx')}</div>`}${ready}</div>`;
  }).join('');
  const abilities = (card.abilities ?? []).map((a) => `<h4>${icon('sparkles')} ${L('ex.ability')}：${esc(a.name)}</h4><p>${esc(text[a.slug] ?? '')}</p>`).join('');
  let now = '';
  if (mon) {
    const owner = game.players.find((p) => game.allMons(p).includes(mon));
    const counts = {};
    mon.energyTypes.forEach((e) => { counts[e] = (counts[e] || 0) + 1; });
    const energy = mon.energy.length
      ? L('now.energy') + ' ' + Object.entries(counts).map(([k, n]) => `${n} ${energyIcon(k)} ${esc(t('type.' + k))}`).join(' + ')
      : L('now.noEnergy');
    const conds = mon.conditions().map((x) => stx(x)).join(', ');
    now = `<div class="now"><h4>${icon('info')} ${L(owner?.idx === 1 ? 'now.titleOpp' : 'now.title')}</h4>
      <div>${L('now.hp', { a: mon.hpLeft, b: mon.maxHp })}</div><div>${energy}</div>${conds ? `<div>${L('now.status')} ${conds}</div>` : ''}</div>`;
  }
  return `${now}<h4>${icon('info')} ${L('ex.what')}</h4><ul class="facts">${facts.map((f) => `<li>${f}</li>`).join('')}</ul>${rules}${abilities}
    ${attacks ? `<h4>${icon('swords')} ${L('ex.attacks')}</h4>${attacks}` : ''}`;
}

const stx = (s) => [].concat(s).map((x) => `<b>${esc(t('st.' + x))}</b> <span class="muted">${esc(t('stx.' + x))}</span>`).join(' + ');

function placePreview(anchor) {
  const pv = $('#preview'), r = anchor.getBoundingClientRect(), m = 14;
  const w = pv.offsetWidth, h = pv.offsetHeight;
  // Beside the card if there is room (right first), otherwise above it.
  let left = r.right + m, top = r.top + r.height / 2 - h / 2;
  if (left + w > innerWidth - 8) left = r.left - m - w;
  if (left < 8) {
    left = r.left + r.width / 2 - w / 2; top = r.top - m - h;
    if (top < 8) top = r.bottom + m; // no room above: below it, so at worst it covers the card's lower half, not its name
  }
  pv.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, left))}px`;
  pv.style.top = `${Math.max(8, Math.min(innerHeight - h - 8, top))}px`;
}

document.addEventListener('mouseover', (e) => {
  const el = e.target.closest('[data-inspect]');
  if (!el || !inspectables.has(el.dataset.inspect)) return;
  const card = inspectables.get(el.dataset.inspect);
  const reason = el.classList.contains('unplayable') && game ? whyNot(card, game.players[0]) : null;
  inspect(card, reason, el);
  // The image loads asynchronously; re-place once its size is known.
  $('#preview img')?.addEventListener('load', () => !$('#preview').hidden && placePreview(el), { once: true });
});
// Card images show a card-shaped skeleton (reserved at the exact card size) until they load.
document.addEventListener('load', (e) => { if (e.target.tagName === 'IMG') e.target.classList.add('loaded'); }, true);
// A card image missing from this copy of the site (npm run cn:images not run) shows the card back instead.
document.addEventListener('error', (e) => {
  if (e.target.tagName !== 'IMG' || e.target.src.endsWith(CARD_BACK)) return;
  e.target.src = CARD_BACK;
  e.target.dataset.fallback = '1';
}, true);

// The preview must never outlive the card it belongs to: hide it on any click, when the page loses the mouse,
// and whenever the hovered card is re-rendered or removed (e.g. a choice window closing).
let previewAnchor = null;
document.addEventListener('pointerdown', () => inspect(null), true);
document.addEventListener('mouseleave', () => inspect(null));
window.addEventListener('blur', () => inspect(null));
function dropStalePreview() { if (previewAnchor && !previewAnchor.isConnected) inspect(null); }
document.addEventListener('mouseout', (e) => {
  const el = e.target.closest('[data-inspect]');
  if (el && !el.contains(e.relatedTarget)) inspect(null);
});

// ---------------- Log, status, coach ----------------
// A log entry is either kernel event text ({text}) or interface text ({key, params}).
function logLine(e) {
  const el = document.createElement('div');
  el.className = e.kind;
  el.textContent = e.text ?? t(e.key, e.params);
  return el;
}
function log(e) {
  logEntries.push(e);
  $('#log').append(logLine(e));
  $('#log').scrollTop = $('#log').scrollHeight;
}
function renderLog() {
  $('#log').replaceChildren(...logEntries.map(logLine));
  $('#log').scrollTop = $('#log').scrollHeight;
}

function oppStatus(key = '', params = {}, thinking = false) {
  oppState = { key, params, thinking };
  renderOppStatus();
}
function renderOppStatus() {
  $('#opp-status').innerHTML = oppState.key ? (oppState.key === 'ui.aiError' ? icon('triangle-alert') : '') + esc(t(oppState.key, oppState.params)) : '';
  $('#opp-status').classList.toggle('thinking', oppState.thinking);
}

function coachMsg(key, params = {}, cls = '') {
  coachState = { key, params, cls };
  renderCoach();
}
function renderCoach() {
  const ic = { good: 'circle-check', meh: 'thumbs-up', bad: 'lightbulb' }[coachState.cls];
  // The Professor (your coach) speaks here; Gary is only the opponent.
  $('#coach-msg').innerHTML = `<b class="coach-who">${esc(t('ui.coachName'))}</b> ` + (ic ? icon(ic) : '') + esc(t(coachState.key, coachState.params));
  $('#coach-msg').className = coachState.cls;
}

function showWin(win) {
  winState = win;
  $('#win-meter').hidden = false;
  $('#win-fill').style.width = `${(win.score / 4) * 100}%`;
  $('#win-label').textContent = t('win.' + Math.max(0, Math.min(4, Math.round(win.score))));
}

// ---------------- Human player ----------------
function turnTips(p, actions) {
  const kinds = new Set(actions.map((a) => a.kind));
  // The situation first (only the first tip shows until the list is unfolded), then what you can do, then how.
  const tips = [];
  if (game.turn === 1 && game.first === ME) tips.push(['tip.firstTurn']);
  if (p.active?.status.confused) tips.push(['tip.confused', { m: p.active.name }]);
  if (!kinds.has('attack') && !(game.turn === 1 && game.first === ME) && p.active) {
    const st = p.active.conditions().find((s) => s === 'asleep' || s === 'paralyzed');
    tips.push(st ? ['tip.cantStatus', { m: p.active.name, s: { $st: st } }] : ['tip.noEnergy', { m: p.active.name }]);
  }
  if (onlyEndLeft(actions)) tips.push(['tip.onlyEnd']);
  if (kinds.has('attack')) tips.push(['tip.attack']);
  if (kinds.has('bench')) tips.push(['tip.bench']);
  if (kinds.has('evolve')) tips.push(['tip.evolve']);
  if (kinds.has('energy')) tips.push(['tip.energy']);
  if (!onlyEndLeft(actions)) {
    if (actions.some((a) => a.card)) tips.push(['tip.drag']);
    else tips.push(['tip.hoverHand']);
  }
  return tips;
}

// Nothing useful left: only ending the turn (or an optional retreat) remains.
const onlyEndLeft = (actions) => actions.every((a) => a.kind === 'end' || a.kind === 'retreat');

// Why a hand card has no legal play right now, shown when hovering a dimmed card. The kernel only says which moves
// exist; these are the usual reasons for the card's kind, checked against the board and this turn's events.
const TRAINER_ACTION = { item: 'playItem', supporter: 'playSupporter', tool: 'playTool', stadium: 'playStadium' };
function whyNot(c, p) {
  if (game.current !== p || game.phase !== 'main' || !decision) return ['why.notYourTurn'];
  const mons = game.allMons(p);
  if (c.kind === 'energy') return ['why.energyUsed'];
  if (c.kind === 'pokemon') {
    if (c.stage === 0) return ['why.benchFull'];
    if (p.turns <= 1) return ['why.firstTurns'];
    if (!mons.some((m) => m.name === c.evolvesFrom)) return ['why.noBase', { from: c.evolvesFrom }];
    return ['why.justPlayed', { from: c.evolvesFrom }];
  }
  if (c.kind === 'trainer') {
    if (game.lockedFrom(ME, TRAINER_ACTION[c.ttype])) return ['why.locked'];
    if (c.ttype === 'supporter' && game.turn === 1 && game.first === ME) return ['why.firstSupporter'];
    if (c.ttype === 'supporter' && game.playedThisTurn(ME, 'supporter')) return ['why.supporterUsed'];
    if (c.ttype === 'stadium' && game.stadium?.card.name === c.name) return ['why.stadiumSame'];
    if (c.ttype === 'stadium' && game.playedThisTurn(ME, 'stadium')) return ['why.stadiumUsed'];
    if (c.ttype === 'tool') return ['why.toolNoTarget'];
    // A card that would change nothing cannot be played (e.g. 奥琳博士的气魄 with no Basic Energy in the discard pile:
    // what comes after 然后 happens only if some of what comes before it did, II.E-19).
    if (/然后/.test(c.texts?.card ?? '')) return ['why.noEffectThen'];
    return ['why.noEffect'];
  }
  return ['why.generic'];
}

// Dim hand cards that have no legal play in the current decision.
function markPlayable() {
  const playable = new Set(decision ? decision.actions.filter((a) => a.card).map((a) => a.card.uid) : []);
  document.querySelectorAll('#hand .hcard').forEach((el) => el.classList.toggle('unplayable', !!decision && !playable.has(Number(el.dataset.card))));
  document.querySelector('#end-slot .k-end')?.classList.toggle('go', !!decision && onlyEndLeft(decision.actions));
}

function highlight(act, on) {
  const sels = [];
  if (act.card) sels.push(`[data-card="${act.card.uid}"]`);
  if (act.target) sels.push(`[data-mon="${act.target.id}"]`);
  if (act.kind === 'attack' || act.kind === 'retreat') sels.push('#you-active .mon');
  for (const sel of sels) document.querySelectorAll(sel).forEach((el) => el.classList.toggle('hl', on));
}

let tipsOpen = false;
function renderDecision() {
  if (!decision) return;
  const { actions, ranking, p } = decision;
  // The most relevant tip shows; the rest fold away so the moves keep the room.
  const tips = turnTips(p, actions);
  $('#tips').classList.toggle('open', tipsOpen);
  const more = () => t(tipsOpen ? 'ui.lessTips' : tips.length === 2 ? 'ui.moreTip' : 'ui.moreTips', { n: tips.length - 1 });
  $('#tips').innerHTML = tips.map(([k, prm]) => `<li>${esc(t(k, prm))}</li>`).join('')
    + (tips.length > 1 ? `<li class="tips-more"><button class="linkish" aria-controls="tips" aria-expanded="${tipsOpen}">${esc(more())}</button></li>` : '');
  const tb = $('#tips .tips-more button');
  tb?.addEventListener('click', () => {
    tipsOpen = !tipsOpen;
    $('#tips').classList.toggle('open', tipsOpen);
    tb.setAttribute('aria-expanded', String(tipsOpen));
    tb.textContent = more();
  });
  const box = $('#actions');
  box.innerHTML = '';
  $('#end-slot').innerHTML = '';
  const button = (a) => {
    const b = document.createElement('button');
    b.className = `act k-${a.kind}`;
    b.dataset.kind = a.kind;
    b.dataset.action = JSON.stringify(a.cmd);
    const prob = ranking && $('#opt-hints').checked ? ranking.probabilities[a.key] ?? 0 : null;
    const best = prob != null && a.key === ranking.choice;
    if (best) b.classList.add('best');
    const offType = a.kind === 'energy' && isOffType(a);
    const note = offType ? `<span class="note" title="${esc(t('tip.offType'))}">${esc(t('ui.onlyColorless'))}</span>` : '';
    const rate = prob != null ? `<span class="pct">${pct(prob)}</span><span class="track"><i style="width:${Math.round(prob * 100)}%"></i></span>` : '';
    const pick = best ? `<span class="pick">${esc(t('ui.profPick'))}</span>` : '';
    b.innerHTML = `${actLead(a, p)}<span class="lbl"><span class="txt">${esc(t(a.label.key, a.label.params))}</span>${note}${pick}</span>${rate}`;
    b.onmouseenter = () => highlight(a, true);
    b.onmouseleave = () => highlight(a, false);
    b.onclick = () => decision.pick(a);
    return b;
  };
  for (const kind of KIND_ORDER) {
    const group = actions.filter((a) => a.kind === kind);
    if (!group.length) continue;
    const g = document.createElement('div');
    g.className = 'act-group';
    g.innerHTML = `<div class="act-head">${esc(t(kind === 'power' ? 'group.ability' : 'group.' + kind))}</div>`;
    group.forEach((a) => g.append(button(a)));
    box.append(g);
  }
  const end = actions.find((a) => a.kind === 'end');
  $('#end-slot').insertAdjacentHTML('beforeend', undoButton());
  $('#undo-btn')?.addEventListener('click', undoLast);
  if (end) $('#end-slot').append(endButton(end, ranking));
  markPlayable();
}

// The end of the turn: a big button on the table, at the end of the bar between the two mats.
function endButton(a, ranking) {
  const b = document.createElement('button');
  b.className = 'act k-end';
  b.dataset.kind = 'end';
  b.dataset.action = JSON.stringify(a.cmd);
  b.title = t(a.label.key, a.label.params);
  const prob = ranking && $('#opt-hints').checked ? ranking.probabilities[a.key] ?? 0 : null;
  if (prob != null && a.key === ranking.choice) b.classList.add('best');
  b.innerHTML = `${icon('skip-forward')}<span class="txt">${esc(t('ui.endTurn'))}</span>${prob != null ? `<span class="pct">${pct(prob)}</span>` : ''}`;
  b.onclick = () => decision.pick(a);
  return b;
}

// What leads each move: the Energy symbol, the attacker's type, or a small picture of the card the move is about.
function actLead(a, p) {
  if (a.kind === 'energy') return `<span class="lead">${energyIcon(a.card.energyType)}</span>`;
  if (a.kind === 'attack') return `<span class="lead">${energyIcon(p.active?.card.type || 'Colorless')}</span>`;
  const c = a.card || (a.kind === 'stadium' ? game.stadium?.card : a.kind === 'power' || a.kind === 'retreat' ? a.target?.card : null);
  return c?.img ? `<span class="lead thumb"><img src="${cardImage(c)}" alt="" loading="lazy"></span>` : '<span class="lead"></span>';
}

// An Energy that none of the target's attacks asks for by type: legal, but it only pays for ★ (Colorless) costs.
const isOffType = (a) => a.card.energyType !== 'Colorless' && !a.card.special && !a.target.card.attacks.some((x) => x.cost.includes(a.card.energyType));

const TTYPE_ICON = { item: 'backpack', supporter: 'user', stadium: 'landmark', tool: 'wrench' };
const KIND_ORDER = ['attack', 'energy', 'evolve', 'bench', 'power', 'trainer', 'stadium', 'retreat'];

function clearActions(html = '') {
  $('#actions').innerHTML = html;
  $('#end-slot').innerHTML = '';
}

// 自动代打: the built-in CPU engine makes your moves too (from your own view only).
const autoOn = () => $('#opt-auto').checked;
function autoMove(g) {
  const cmd = release.decisions.cpu(g.game.view(ME), ME);
  return cmd;
}

class HumanController {
  constructor(myGame) { this.myGame = myGame; this.n = 0; this.lastWinTurn = -1; }

  async chooseAction(g, p, actions) {
    if (this.myGame !== gameId) return stale();
    if (autoOn()) {
      await sleep(400);
      if (this.myGame !== gameId) return stale();
      const cmd = JSON.stringify(autoMove(g));
      const a = actions.find((x) => JSON.stringify(x.cmd) === cmd && !x.follow) ?? actions.find((x) => JSON.stringify(x.cmd) === cmd);
      if (a) { undoStack = []; return a; }
    }
    if (!tourDone() && !FAST) await runTour();
    const id = ++this.n;
    return new Promise((resolve) => {
      decision = {
        actions, p, ranking: null,
        pick: (a) => {
          highlight(a, false);
          rememberForUndo(g, a);
          const ranking = decision.ranking;
          decision = null;
          if (drag) endDrag(true);
          markPlayable();
          this.n++;
          clearActions('<div class="waiting">…</div>');
          $('#tips').innerHTML = '';
          if ($('#opt-coach').checked) this.feedback(a, actions, ranking);
          resolve(a);
        },
      };
      renderDecision();

      if (!$('#opt-coach').checked && !$('#opt-hints').checked) return;
      const withWin = this.lastWinTurn !== g.turn;
      coachMsg('coach.thinking');
      release.decisions.rate(g.game.view(ME), ME, actions).then((r) => {
        if (id !== this.n || this.myGame !== gameId || !decision) return;
        if (!r) { coachMsg('coach.pending'); return; }
        if (withWin && r.win) { this.lastWinTurn = g.turn; showWin(r.win); }
        decision.ranking = r.ranking;
        renderDecision();
        if ($('#opt-hints').checked) {
          const best = actions.find((a) => a.key === r.ranking.choice);
          coachMsg('coach.suggests', { a: { $t: best.label }, p: pct(r.ranking.probabilities[r.ranking.choice] ?? 0) });
        } else coachMsg('coach.ready');
      }).catch((err) => coachMsg('coach.unavailable', { e: err.message }, 'bad'));
    });
  }

  feedback(chosen, actions, ranking) {
    if (!ranking) return;
    const best = actions.find((a) => a.key === ranking.choice);
    const pc = ranking.probabilities[chosen.key] ?? 0, pb = ranking.probabilities[ranking.choice] ?? 0;
    let key, cls;
    if (chosen.key === ranking.choice) { key = 'coach.agree'; cls = 'good'; }
    else if (pc >= pb * 0.5) { key = 'coach.ok'; cls = 'meh'; }
    else { key = 'coach.bad'; cls = 'bad'; }
    const params = { a: { $t: chosen.label }, b: { $t: best.label }, pb: pct(pb), pc: pct(pc) };
    coachMsg(key, params, cls);
    log({ key: 'coach.prefix', params: { m: { $t: { key, params } } }, kind: 'coach' });
  }

  // Answers: one option id, a list of ids, or {allocations} for counters placed in any way.
  async choose(g, p, prompt) {
    if (this.myGame !== gameId) return stale();
    if (autoOn()) {
      await sleep(300);
      if (this.myGame !== gameId) return stale();
      const cmd = autoMove(g);
      return cmd.type === 'allocateCounters' ? { allocations: cmd.allocations } : cmd.selected;
    }
    if (prompt.kind === 'prize') return choosePrize(prompt);
    if (prompt.kind === 'setup-active' && prompt.options.every((o) => o.card)) return chooseActiveStage(prompt);
    if (prompt.kind === 'setup-bench' && prompt.options.every((o) => o.card)) {
      const uids = await chooseBenchStage(prompt.options.map((o) => o.card), prompt.max);
      return prompt.options.filter((o) => uids.includes(o.card.uid)).map((o) => o.id);
    }
    if (prompt.alloc) return chooseAllocation(prompt);
    return chooseOptions(prompt);
  }
}

// What a choice is about: the card whose effect asks it, and how many to pick.
function promptText(prompt) {
  const parts = [];
  if (prompt.source) parts.push(t('prompt.from', { c: prompt.source.name }));
  if (prompt.max > 1 || prompt.min !== 1) parts.push(prompt.min === prompt.max ? t('prompt.pickN', { n: prompt.max }) : t('prompt.pickRange', { a: prompt.min, b: prompt.max }));
  return parts.join(' · ');
}

// The general choice window: cards and Pokémon are shown as themselves, word answers ("执行", "2张") as buttons.
// One pick answers at once; a choice of several (or of none) is confirmed with a button.
function chooseOptions(prompt) {
  const single = prompt.min === 1 && prompt.max === 1 && !prompt.allowZero;
  const picked = [];
  return new Promise((resolve) => {
    openModal(() => {
      const small = prompt.options.length > 8;
      prompt.options.forEach((o) => o.card && inspectables.set('c' + o.card.uid, o.card));
      prompt.lookedAt.forEach((c) => inspectables.set('c' + c.uid, c));
      const pictured = prompt.options.filter((o) => !o.label);
      const words = prompt.options.filter((o) => o.label);
      const sel = (o) => (picked.includes(o.id) ? ' sel' : '');
      const pic = (o) => {
        if (o.back) return `<button data-id="${esc(o.id)}" class="pick-card${sel(o)}">${backImg()}</button>`;
        if (o.mon) return `<button data-id="${esc(o.id)}" class="pick-card${sel(o)}" data-inspect="c${o.mon.card.uid}"><img src="${cardImage(o.mon.card)}" alt="${esc(cardName(o.mon.card))}"><span class="sub">${esc(cardName(o.mon.card))} · ${o.mon.hpLeft}/${o.mon.maxHp} ${t('ui.hp')}</span></button>`;
        return `<button data-id="${esc(o.id)}" class="pick-card${sel(o)}" data-inspect="c${o.card.uid}"><img src="${cardImage(o.card)}" alt="${esc(cardName(o.card))}"><span class="sub">${esc(cardName(o.card))}</span></button>`;
      };
      const word = (o) => `<button data-id="${esc(o.id)}" class="${pictured.length ? 'textlink' : o.id === 'perform' || o.id === 'first' ? 'primary' : 'opt-word'}${sel(o)}">${esc(o.label)}</button>`;
      const looked = prompt.lookedAt.length ? `<div class="choice-grid small looked">${prompt.lookedAt.map((c) =>
        `<div class="pick-card" data-inspect="c${c.uid}"><img src="${cardImage(c)}" alt="${esc(cardName(c))}"><span class="sub">${esc(cardName(c))}</span></div>`).join('')}</div>` : '';
      const ok = single ? '' : `<div class="row"><button class="primary" id="choice-ok">${icon('circle-check')} ${esc(picked.length ? t('ui.confirmN', { n: picked.length }) : prompt.min === 0 || prompt.allowZero ? t('ui.pickNone') : t('ui.confirm'))}</button></div>`;
      return `<h2>${esc(prompt.title)}</h2><p>${esc(promptText(prompt))}</p>${looked}
        ${pictured.length ? `<div class="choice-grid ${small ? 'small' : ''}">${pictured.map(pic).join('')}</div>` : ''}
        ${words.length ? `<div class="choice-words ${pictured.length ? 'aside' : ''}">${words.map(word).join('')}</div>` : ''}${ok}`;
    }, (body) => {
      const valid = () => (picked.length === 0 ? prompt.min === 0 || prompt.allowZero : picked.length >= prompt.min && picked.length <= prompt.max);
      body.querySelectorAll('[data-id]').forEach((b) => (b.onclick = () => {
        if (single) { closeModal(); resolve(b.dataset.id); return; }
        const i = picked.indexOf(b.dataset.id);
        if (i >= 0) picked.splice(i, 1); else if (picked.length < prompt.max) picked.push(b.dataset.id);
        rerenderModal();
      }));
      const ok = body.querySelector('#choice-ok');
      if (ok) {
        ok.disabled = !valid();
        ok.onclick = () => { if (!valid()) return; closeModal(); resolve([...picked]); };
      }
    }, 'sheet');
  });
}

// 「以任意方式放置」: every counter is placed; each Pokémon gets a count, raised and lowered with + and −.
function chooseAllocation(prompt) {
  const { total, targets } = prompt.alloc, counts = {};
  const placed = () => Object.values(counts).reduce((n, c) => n + c, 0);
  return new Promise((resolve) => {
    openModal(() => `<h2>${esc(prompt.title)}</h2><p>${esc(promptText(prompt))}</p>
      <div class="alloc-grid">${targets.map(({ id, mon }) => `<div class="alloc" data-option="${esc(id)}">
        ${mon ? `<img src="${cardImage(mon.card)}" alt="" data-inspect="c${mon.card.uid}"><span class="sub">${esc(cardName(mon.card))} · ${mon.hpLeft}/${mon.maxHp} ${t('ui.hp')}</span>` : ''}
        <div class="alloc-step"><button class="step" data-d="-1" aria-label="−">−</button><b>${counts[id] ?? 0}</b><button class="step" data-d="1" aria-label="+">＋</button></div></div>`).join('')}</div>
      <div class="row"><button class="primary" id="choice-ok">${esc(t('ui.allocConfirm', { a: placed(), b: total }))}</button></div>`,
    (body) => {
      targets.forEach(({ id, mon }) => mon && inspectables.set('c' + mon.card.uid, mon.card));
      body.querySelectorAll('.alloc').forEach((row) => row.querySelectorAll('.step').forEach((b) => (b.onclick = () => {
        const id = row.dataset.option, next = (counts[id] ?? 0) + Number(b.dataset.d);
        if (next < 0 || placed() + Number(b.dataset.d) > total) return;
        counts[id] = next;
        rerenderModal();
      })));
      const ok = body.querySelector('#choice-ok');
      ok.disabled = placed() !== total;
      ok.onclick = () => {
        if (placed() !== total) return;
        closeModal();
        resolve({ allocations: Object.entries(counts).filter(([, n]) => n > 0).map(([pokemonId, count]) => ({ pokemonId, count })) });
      };
    }, 'sheet');
  });
}

function openModal(html, bind, cls = '') {
  inspect(null);
  modalRenderer = { html, bind };
  $('#modal-body').className = `dialog ${cls}`.trim(); // 'sheet': a choice in the game, drawn like the card stages
  $('#modal-body').innerHTML = html();
  bind?.($('#modal-body'));
  $('#modal').hidden = false;
}
function closeModal() {
  inspect(null);
  modalRenderer = null;
  $('#modal').hidden = true;
}
function rerenderModal() {
  if (!modalRenderer) return;
  $('#modal-body').innerHTML = modalRenderer.html();
  modalRenderer.bind?.($('#modal-body'));
}

// ---------------- Prize cards ----------------
// The prize stage: your face-down Prize cards fan out, you pick one, it rises to the centre, spins and flips
// to reveal itself, then glides into your hand (flyNewCards picks it up from here).
let prizeStage = null, prizeFrom = null;

function choosePrize(prompt) {
  inspect(null);
  prizeStage?.remove();
  const el = prizeStage = document.createElement('div');
  el.className = 'overlay prize-ov';
  const n = prompt.options.length;
  el.innerHTML = `<div class="prize-stage">
    <div class="cs-title">${icon('trophy')} <span>${esc(t('prompt.prize.title'))}</span></div>
    <div class="cs-sub">${esc(t('prompt.prize.text'))}</div>
    <div class="pz-row" style="--n:${n}">${prompt.options.map((o, i) => `<button class="pz-card" data-id="${esc(o.id)}" style="--i:${i};--o:${(i - (n - 1) / 2).toFixed(2)}">
      <span class="pz-flip"><img class="pz-back" src="${cardBack()}" alt=""><img class="pz-front" alt=""></span></button>`).join('')}</div>
    <div class="pz-caption"><b class="pz-name"></b><span class="pz-note"></span></div>
    <div class="pz-left">${esc(t('ui.prizesLeft', { n }))}</div>
  </div>`;
  document.body.append(el);
  return new Promise((resolve) => {
    el.querySelectorAll('.pz-card').forEach((b) => (b.onclick = () => {
      if (el.classList.contains('picked')) return;
      el.classList.add('picked');
      b.classList.add('chosen');
      resolve(b.dataset.id);
    }));
  });
}

async function onPrize(p, card, remaining) {
  if (p.idx !== 0) return;
  const el = prizeStage, c = el?.querySelector('.pz-card.chosen');
  if (!c) return;
  const front = c.querySelector('.pz-front');
  front.src = cardImage(card);
  await Promise.race([front.decode?.().catch(() => {}), sleep(1200)]);
  const anim = animOn();
  // Lift the chosen card out of the row to the centre of the screen, bigger.
  // Measure the card's untransformed layout box (offsets ignore its fan rotation / hover lift).
  const st = c.offsetParent.getBoundingClientRect();
  const cx = st.left + c.offsetLeft + c.offsetWidth / 2, cy = st.top + c.offsetTop + c.offsetHeight / 2;
  const h = Math.min(innerHeight * 0.5, 400), w = h * 0.716;
  const dx = innerWidth / 2 - cx, dy = innerHeight * 0.47 - cy, s = w / c.offsetWidth;
  const flip = c.querySelector('.pz-flip');
  if (anim) {
    c.animate([{ transform: c.style.transform || getComputedStyle(c).transform }, { transform: `translate(${dx}px, ${dy}px) scale(${s})` }],
      { duration: 520, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'forwards' });
    await sleep(380);
    el.classList.add('revealing');
    // Spin while flipping face up, settling with a little overshoot.
    flip.animate([
      { transform: 'rotateY(0) rotateZ(0)' },
      { transform: 'rotateY(-200deg) rotateZ(-8deg)', offset: 0.75 },
      { transform: 'rotateY(-180deg) rotateZ(0)' },
    ], { duration: 900, easing: 'cubic-bezier(.4,.1,.3,1)', fill: 'forwards' });
    await sleep(820);
  } else {
    c.style.transform = `translate(${dx}px, ${dy}px) scale(${s})`;
    flip.style.transform = 'rotateY(-180deg)';
  }
  el.classList.add('revealed');
  el.querySelector('.pz-name').textContent = cardName(card);
  el.querySelector('.pz-note').textContent = `${t('ui.prizeToHand')} · ${t('ui.prizesLeft', { n: remaining })}`;
  await sleep(anim ? 1500 : 900);
  // The engine re-renders next; the card then flies from here into your hand.
  prizeFrom = { uid: card.uid, el: front, stage: el };
  setTimeout(() => closePrizeStage(el), 1200); // in case nothing picks it up (animations off)
}

// ---------------- Opening: who chooses to go first ----------------
// 进阶玩家向规则指南 Ver.3.1.0 Ⅰ G 2：「通过猜拳等方式决定先攻后攻。胜利的玩家选择先攻还是后攻。」 The kernel draws
// the winner (from its seeded random, saved with the game). The table shows that draw as rock-paper-scissors (rps.js)
// or as a coin toss, as picked in Settings: your throw or call is yours, and Gary's throw (or the face the coin lands
// on) follows the kernel's draw, so either of you wins half the time, as at a real table.
const RPS_KINDS = ['rock', 'paper', 'scissors'];
const RPS_BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
const anyOf = (list) => list[Math.floor(Math.random() * list.length)];
const autoDelay = () => (FAST ? 30 : 700);

let rpsStage = null;
function rpsEl() {
  if (!rpsStage?.isConnected) {
    rpsStage = document.createElement('div');
    rpsStage.hidden = true;
    document.body.append(rpsStage);
  }
  rpsStage.classList.toggle('rps-reduced', !animOn()); // animations off: quick fades only
  return rpsStage;
}
function rpsText() {
  return {
    dialog: t('rps.dialog'), title: t('rps.title'), sub: t('rps.sub'), hint: t('rps.hint'),
    names: { rock: t('opt.rock'), paper: t('opt.paper'), scissors: t('opt.scissors') },
    chant: [t('rps.chant1'), t('rps.chant2'), t('rps.chant3')],
    you: t('rps.you'), gary: t('rps.gary'), youLabel: t('rps.youLabel'),
    win: t('rps.win'), winSub: t('rps.winSub'), lose: t('rps.lose'), loseSub: t('rps.loseSub'),
    tie: t('rps.tie'), tieSub: t('rps.tieSub'), cont: t('ui.continue'),
  };
}

async function showOpening({ winner }) {
  inspect(null);
  if (openingStyle === 'coin') return coinOpening(winner);
  try {
    await rpsOpening(winner);
  } catch (e) {
    if (e === RPS_CANCEL) return stale();
    throw e;
  }
}

async function rpsOpening(winner) {
  const el = rpsEl(), text = rpsText();
  // A tie is thrown again, as at the table (a third of the rounds); the kernel's draw settles the last round.
  for (let round = 0; ; round++) {
    const you = await chooseThrow(el, text, autoOn() ? { autoPick: anyOf(RPS_KINDS), autoDelay: autoDelay() } : undefined);
    const tie = round < 3 && Math.random() < 1 / 3;
    const gary = tie ? you : winner === ME ? RPS_BEATS[you] : RPS_KINDS.find((k) => RPS_BEATS[k] === you);
    await showdown(el, { you, gary, result: tie ? 'tie' : winner === ME ? 'win' : 'lose', text, autoCloseMs: FAST ? 30 : 3200 });
    if (!tie) break;
    text.sub = t('rps.again');
  }
  await rpsClose(el);
}

async function coinOpening(winner) {
  const call = await callCoinStage();
  const you = { key: 'coin.o.decide.you' }, opp = { key: 'coin.o.decide.opp' };
  await showCoin({ h: (winner === ME) === (call === 'heads'), why: 'first', params: { call: { $coin: call === 'heads' } },
    heads: call === 'heads' ? you : opp, tails: call === 'heads' ? opp : you });
}

// ---------------- Setup: your Active Pokémon and your Bench ----------------
// The same stage as the Prize cards: your Basic Pokémon fan out face up. The Active Pokémon you pick rises to
// the centre and lights up; Bench picks lift out of the fan and fly up when you confirm.
function setupStage(mode, title, sub, cards, extra = '') {
  inspect(null);
  const el = document.createElement('div');
  el.className = `overlay prize-ov setup-ov st-${mode}`;
  const n = cards.length;
  el.innerHTML = `<div class="prize-stage">
    <div class="cs-title">${icon(mode === 'bench' ? 'layers' : 'user')} <span>${esc(title)}</span></div>
    <div class="cs-sub">${esc(sub)}</div>
    <div class="pz-row" style="--n:${n}">${cards.map((c, i) => `<button class="pz-card st-card" data-uid="${c.uid}" style="--i:${i};--o:${(i - (n - 1) / 2).toFixed(2)}" aria-label="${esc(cardName(c))}">
      <img src="${cardImage(c)}" alt="" draggable="false"><span class="st-check">${icon('circle-check')}</span></button>`).join('')}</div>
    <div class="st-info">${esc(t(matchMedia('(hover: none)').matches ? (mode === 'bench' ? 'ui.setupTapBench' : 'ui.setupTap') : 'ui.setupHover'))}</div>${extra}
    <div class="pz-caption"><b class="pz-name"></b><span class="pz-note"></span></div>
  </div>`;
  document.body.append(el);
  // Each card shows what it does (HP, Weakness, attacks…) in the same tooltip as the cards on the board.
  const live = () => !el.classList.contains('picked') && !el.classList.contains('done');
  el.querySelectorAll('.st-card').forEach((b) => {
    const c = cards.find((x) => String(x.uid) === b.dataset.uid);
    inspectables.set('c' + c.uid, c);
    b.showInfo = () => {
      if (!live()) return;
      inspect(c, null, b);
      placePreview(b);
    };
    b.onmouseenter = b.showInfo;
    b.onfocus = () => b.matches(':focus-visible') && b.showInfo();
    b.onmouseleave = b.onblur = () => inspect(null);
    b.addEventListener('pointerdown', (e) => { b.touched = e.pointerType !== 'mouse'; });
  });
  return el;
}

// Lift a card out of its fan to the centre of the screen, bigger (as a revealed Prize card does).
function liftToCentre(c, anim) {
  const st = c.offsetParent.getBoundingClientRect();
  const cx = st.left + c.offsetLeft + c.offsetWidth / 2, cy = st.top + c.offsetTop + c.offsetHeight / 2;
  const h = Math.min(innerHeight * 0.5, 400), w = h * 0.716;
  const to = `translate(${innerWidth / 2 - cx}px, ${innerHeight * 0.47 - cy}px) scale(${w / c.offsetWidth})`;
  if (anim) c.animate([{ transform: getComputedStyle(c).transform }, { transform: to }], { duration: 520, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'forwards' });
  else c.style.transform = to;
}

function chooseActiveStage(prompt) {
  const cards = prompt.options.map((o) => o.card);
  const el = setupStage('active', prompt.title, t('prompt.active.text'), cards);
  return new Promise((resolve) => {
    el.querySelectorAll('.st-card').forEach((b) => (b.onclick = async () => {
      if (el.classList.contains('picked')) return;
      if (b.touched && !b.classList.contains('armed')) {
        el.querySelectorAll('.armed').forEach((x) => x.classList.remove('armed'));
        b.classList.add('armed');
        b.showInfo();
        return;
      }
      inspect(null);
      const card = cards.find((x) => String(x.uid) === b.dataset.uid);
      const anim = animOn();
      el.classList.add('picked');
      b.classList.add('chosen');
      liftToCentre(b, anim);
      await sleep(anim ? 420 : 0);
      el.classList.add('revealing', 'revealed');
      el.querySelector('.pz-name').textContent = cardName(card);
      el.querySelector('.pz-note').textContent = t('ui.activeNote');
      await sleep(anim ? 1300 : 500);
      closePrizeStage(el);
      resolve(prompt.options.find((o) => o.card === card).id);
    }));
  });
}

// The kernel asks right after the Active Pokémon is chosen, and again after any extra cards drawn for the
// opponent's mulligans (up to the Bench's 5 places, `max`).
function chooseBenchStage(basics, max) {
  const picked = new Set(basics.slice(0, max).map((c) => c.uid));
  const el = setupStage('bench', t('ui.benchTitle'), t('ui.benchText', { n: max }), basics,
    `<div class="st-actions"><span class="st-count"></span><button class="primary st-ok">${icon('circle-check')} ${esc(t('ui.confirm'))}</button></div>`);
  const count = () => { el.querySelector('.st-count').textContent = t('ui.benchCount', { n: picked.size, max }); };
  el.querySelectorAll('.st-card').forEach((b) => {
    b.classList.toggle('sel', picked.has(Number(b.dataset.uid)));
    b.onclick = () => {
      const uid = Number(b.dataset.uid);
      if (picked.has(uid)) picked.delete(uid);
      else if (picked.size < max) picked.add(uid);
      b.classList.toggle('sel', picked.has(uid));
      count();
      b.showInfo(); // a click hides the tooltip; keep showing the card it was about
    };
  });
  count();
  return new Promise((resolve) => {
    el.querySelector('.st-ok').onclick = async () => {
      if (el.classList.contains('done')) return;
      el.classList.add('done');
      inspect(null);
      await sleep(animOn() ? 520 : 0);
      closePrizeStage(el);
      resolve([...picked]);
    };
  });
}

// Close one particular prize stage. With several Prize cards to take, the next stage may already be open,
// and a late close for the previous card must never close it (that left the pick unanswered and froze the game).
function closePrizeStage(el) {
  if (!el || el.classList.contains('closing')) return;
  if (prizeStage === el) prizeStage = null;
  if (prizeFrom?.stage === el) prizeFrom = null;
  el.classList.add('closing');
  setTimeout(() => el.remove(), 260);
}

// ---------------- Game lifecycle ----------------
// Gary decides from his own player view only: with the CPU engine (cn/ai.js), or with a backend engine when one is
// connected and ready. A backend that fails hands the move to the CPU engine and says so.
function makeAIController(myGame) {
  return {
    async decide(view, player) {
      if (myGame !== gameId) return stale();
      clearActions(`<div class="waiting">${esc(t('ui.waitingOpp'))}</div>`);
      if (pendingAnims.size) await Promise.all([...pendingAnims]);
      $('#tips').innerHTML = '';
      oppStatus('ui.thinking', {}, true);
      await sleep(450);
      let answer;
      try {
        answer = await release.decisions.decide(view, player, engineUsable ? engine : null);
      } catch (err) {
        if (myGame !== gameId) return stale();
        const key = err.status === 402 ? 'ui.aiCredits' : 'ui.aiError';
        const short = String(err.message).slice(0, 120);
        log({ key, params: { e: short }, kind: 'warn' });
        answer = { action: release.decisions.cpu(view, player) };
      }
      if (myGame !== gameId) return stale();
      if (answer.confidence != null) oppStatus('ui.oppConfidence', { p: pct(answer.confidence) });
      else if (oppState.thinking) oppStatus();
      await sleep(550);
      return myGame === gameId ? answer.action : stale();
    },
  };
}

// The table on a kernel game: you are kernel player 0, Gary player 1.
function newMatch(kernel, catalog, decks, myGame) {
  release.decisions = createDecisions(catalog);
  return new Match({ game: kernel, catalog, presentation: release.meta.cards, decks,
    controllers: [new HumanController(myGame), makeAIController(myGame)], hooks: gameHooks(myGame) });
}

// ---------------- Saved game (localStorage) ----------------
// The game is saved before every decision, so a reload resumes at the latest move. The kernel snapshot is restored
// only through the same reviewed release. Each player on this browser has their own save; it also carries the game's
// record id and the steps not sent yet. Watching a replay never touches it.
const saveKey = () => `cn-table-save-v1:${user.id}`;
function saveGame(g) {
  if (REPLAY) return;
  try {
    localStorage.setItem(saveKey(), JSON.stringify({
      releaseId: CN_RELEASE_ID, decks: g.decks, snapshot: g.snapshot(),
      log: logEntries.filter((e) => !e.key?.startsWith('ui.restored')).slice(-400), coach: coachState, win: winState,
      record: recorder?.saved() ?? null,
    }));
  } catch { /* storage full or unavailable: keep playing without saving */ }
}
function clearSave() {
  if (REPLAY) return;
  try { localStorage.removeItem(saveKey()); } catch { /* ignore */ }
}
function loadSave() {
  try {
    const s = JSON.parse(localStorage.getItem(saveKey()));
    return s?.releaseId === CN_RELEASE_ID && s.snapshot ? s : null;
  } catch { return null; }
}

function resetTable() {
  game?.stop();
  lastDamage.clear();
  arrivingCards.clear();
  seenHand = new Set();
  seenOppHand = 0;
  oppPrizeTaken = false;
  decision = null;
  winState = null;
  $('#win-meter').hidden = true;
  $('#start').hidden = true;
  $('#table').hidden = false;
  coachMsg('ui.coachIdle');
  oppStatus();
  inspect(null);
}

function gameHooks(myGame) {
  const live = (fn) => (...args) => (myGame === gameId ? fn(...args) : stale());
  return {
    onOpening: live(showOpening),
    onLog: (e) => myGame === gameId && log(e),
    onUpdate: () => myGame === gameId && render(),
    onCoin: live(showCoin),
    onAttack: live(arenaOpen),
    onAttach: live(onAttach),
    onEvolve: live(onEvolve),
    onBench: (info) => (myGame === gameId ? onBench(info) : undefined),
    onTrainer: live(onTrainer),
    onShuffle: live(onShuffle),
    onHit: live(onHit),
    onAttackEnd: live(arenaClose),
    onKnockout: () => { if (myGame === gameId) koStamp(); },
    onPrize: live(onPrize),
    onOppPrize: () => { if (myGame === gameId) oppPrizeTaken = true; },
    onMoveDone: ({ quiet }) => { if (myGame === gameId && !quiet) undoStack = []; },
    onDispatch: ({ player, revision, action }) => {
      if (myGame === gameId) recorder?.add({ type: 'action', player, revision, action, hash: stateHash(game.game.snapshot()) });
    },
    onError: (err, player, { revision, action }) => {
      if (myGame !== gameId) return;
      log({ key: 'ui.rejected', params: { e: err.message }, kind: 'warn' });
      recorder?.add({ type: 'rejected', player, revision, action, error: { code: err.code ?? null, message: err.message } });
    },
    onCheckpoint: (g) => {
      if (myGame !== gameId) return;
      saveGame(g);
      recorder?.flush({ turn: g.turn });
    },
    onGameOver: (g) => {
      if (myGame !== gameId) return;
      clearSave();
      const result = g.view.result;
      recorder?.add({ type: 'snapshot', revision: g.view.revision, state: g.snapshot() });
      recorder?.add({ type: 'end', result });
      recorder?.flush({ status: 'over', result, turn: g.turn });
      gameOver(g);
    },
  };
}

const deckList = (deck) => deck.cards.flatMap(([id, n]) => Array(n).fill(id));

async function startGame(deckId) {
  const myGame = ++gameId;
  const mine = release.decks[deckId];
  const others = Object.values(release.decks).filter((d) => d.id !== deckId);
  const opp = oppChoice !== 'random' && oppChoice !== deckId && release.decks[oppChoice] ? release.decks[oppChoice] : anyOf(others);
  // Every game is shuffled from a fresh random seed. ?seed=a,b,c,d (tests) fixes the first game's only: a new game in
  // the same page must not deal the same decks again.
  const seedParam = params.get('seed');
  if (seedParam) {
    params.delete('seed');
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}${location.hash}`);
  }
  const seed = seedParam ? seedParam.split(',').map(Number) : [...crypto.getRandomValues(new Uint32Array(4))];
  // Both decks must be legal in the pool played: a Standard deck and an Open deck meet in Open.
  const format = mine.format.id === opp.format.id ? mine.format : { ...mine.format, id: 'open' };
  const decks = [mine, opp].map((d) => ({ id: d.id, name: d.name, cards: deckList(d) }));
  // The record on the server starts with everything the kernel needs to play this game again (replay.js).
  const [{ game: kernel, catalog }, record] = await Promise.all([
    createReviewedGame({ json: release.json, trustedReleases: TRUSTED_RELEASES, decks: decks.map((d) => d.cards), seed, format, matchMode: 'normal' }),
    MatchRecorder.start({ releaseId: CN_RELEASE_ID, seed, format, matchMode: 'normal', decks }),
  ]);
  if (myGame !== gameId) return;
  clearSave();
  undoStack = [];
  logEntries = [];
  renderLog();
  resetTable();
  animateDraws = true;
  recorder = record;
  game = newMatch(kernel, catalog, [mine.id, opp.id], myGame);
  log({ key: 'log.decks', params: { a: mine.name, b: opp.name }, kind: 'sys' });
  log(recorder ? { key: 'log.match', params: { id: recorder.id }, kind: 'sys' } : { key: 'log.noRecord', params: {}, kind: 'warn' });
  render();
  await game.run();
}

// A saved game picks up again after a reload (reason 'reload') or one of your moves is taken back ('undo'); its record
// notes the revision the game went back to.
async function resumeGame(save, { note = { key: 'ui.restored', params: {} }, reason = 'reload' } = {}) {
  const myGame = ++gameId;
  const { game: kernel, catalog } = await restoreReviewedGame({ json: release.json, trustedReleases: TRUSTED_RELEASES, snapshot: save.snapshot });
  if (myGame !== gameId) return;
  if (save.record?.id && save.record.id !== recorder?.id) recorder = new MatchRecorder(save.record);
  recorder?.add({ type: 'rewind', revision: save.snapshot.revision, reason });
  logEntries = (save.log || []).filter((e) => !e.key?.startsWith('ui.restored'));
  resetTable();
  game = newMatch(kernel, catalog, save.decks, myGame);
  log({ ...note, kind: 'sys' });
  renderLog();
  if (save.coach) coachMsg(save.coach.key, save.coach.params, save.coach.cls);
  if (save.win) showWin(save.win);
  render();            // restored hand appears in place, without the draw animation
  animateDraws = true;
  await game.run({ resume: true });
}

// A game saved before the site was updated: a re-issued release cannot take the old snapshot, so the game's record is
// played again on this kernel up to the saved move, and the game goes on from there.
async function resumeFromRecord(save) {
  const { match, steps } = await apiJSON(`/api/matches/${save.record.id}`);
  const replay = await replayMatch({ json: release.json, trustedReleases: TRUSTED_RELEASES, setup: match.setup,
    steps: mergeSteps(steps, save.record.pending) });
  const snapshot = replay.game.snapshot();
  if (replay.failed || snapshot.revision !== save.snapshot.revision) throw new Error('the record does not reach the saved game');
  const same = stateHash(snapshot) === stateHash(save.snapshot);
  await resumeGame({ ...save, snapshot }, { note: { key: same ? 'ui.restoredRecord' : 'ui.restoredRecordChanged', params: {} } });
}

// ---------------- Replay (?replay=<match id>) ----------------
// A recorded game played again on the kernel from its setup and its moves (replay.js), with the table's animations and
// from the side of the table its player saw. Play, pause or go one move at a time; nothing is saved or recorded.
const replayCtl = { paused: false, step: false, wake: null, delay: 700 };
async function replayGate() {
  await sleep(replayCtl.delay);
  while (replayCtl.paused && !replayCtl.step) await new Promise((r) => { replayCtl.wake = r; });
  replayCtl.step = false;
}
function replayWake() { replayCtl.wake?.(); replayCtl.wake = null; }

function replayBar(match, total) {
  $('#actions-panel h2').textContent = t('replay.panel', { id: match.id });
  $('#tips').innerHTML = `<li>${esc(t('replay.who', { u: match.username, d: new Date(match.createdAt).toLocaleString('zh-CN') }))}</li>`;
  clearActions(`<div class="replay-bar">
    <div class="replay-progress" id="rp-progress"></div>
    <div class="row">
      <button class="primary" id="rp-play"></button>
      <button id="rp-step">${icon('skip-forward')} ${esc(t('replay.step'))}</button>
      <select id="rp-speed" aria-label="${esc(t('replay.speed'))}">${[[1600, 'replay.slow'], [700, 'replay.normal'], [150, 'replay.fast']]
        .map(([ms, k]) => `<option value="${ms}" ${ms === replayCtl.delay ? 'selected' : ''}>${esc(t(k))}</option>`).join('')}</select>
    </div>
    <a class="replay-exit" href="./">${esc(t('replay.exit'))}</a>
  </div>`);
  const play = () => { $('#rp-play').innerHTML = `${icon(replayCtl.paused ? 'play' : 'pause')} ${esc(t(replayCtl.paused ? 'replay.play' : 'replay.pause'))}`; };
  $('#rp-play').onclick = () => { replayCtl.paused = !replayCtl.paused; play(); replayWake(); };
  $('#rp-step').onclick = () => { replayCtl.paused = true; replayCtl.step = true; play(); replayWake(); };
  $('#rp-speed').onchange = (e) => { replayCtl.delay = Number(e.target.value); };
  play();
  return (done) => { $('#rp-progress').textContent = t('replay.progress', { n: done, total }); };
}

async function watchReplay(id) {
  const myGame = ++gameId;
  const { match, steps } = await apiJSON(`/api/matches/${encodeURIComponent(id)}`);
  const setup = match.setup;
  if (setup.releaseId !== CN_RELEASE_ID) throw new Error(t('replay.release', { r: setup.releaseId }));
  const { moves, problems } = effectiveMoves(steps);
  const { game: kernel, catalog } = await newGame({ json: release.json, trustedReleases: TRUSTED_RELEASES, setup });
  if (myGame !== gameId) return;
  logEntries = [];
  renderLog();
  resetTable();
  animateDraws = true;
  const quiet = { onDispatch: null, onError: null, onCheckpoint: null, onGameOver: null, onMoveDone: null };
  game = new Match({ game: kernel, catalog, presentation: release.meta.cards, decks: setup.decks.map((d) => d.id), controllers: [],
    hooks: { ...gameHooks(myGame), ...quiet } });
  log({ key: 'log.decks', params: { a: setup.decks[0].name, b: setup.decks[1].name }, kind: 'sys' });
  log({ text: START_SHUFFLE, kind: 'sys' });
  for (const e of kernel.view(ME).events) { const text = game.eventLine(e); if (text) log({ text, kind: 'sys' }); }
  if (problems.length) log({ key: 'replay.problems', params: { n: problems.length }, kind: 'warn' });
  render();
  const progress = replayBar(match, moves.length);
  progress(0);
  let diverged = false;
  for (const [i, m] of moves.entries()) {
    await replayGate();
    if (myGame !== gameId) return;
    try {
      await game.apply(m.player, m.revision, m.action);
    } catch { /* refused: reported below */ }
    if (kernel.view(ME).revision !== m.revision + 1) {
      log({ key: 'replay.failed', params: { n: i + 1 }, kind: 'warn' });
      return;
    }
    if (m.hash && !diverged && stateHash(kernel.snapshot()) !== m.hash) {
      diverged = true;
      log({ key: 'replay.diverged', params: { n: i + 1 }, kind: 'warn' });
    }
    progress(i + 1);
  }
  if (game.winner) log({ text: game.winReason.text, kind: 'win' });
  log({ key: 'replay.end', params: {}, kind: 'sys' });
}

// ---------------- Undo ----------------
// A learning aid (real games have no take-backs): you can undo your own moves within the current turn, as long as
// they revealed nothing new — putting a Pokémon on the Bench, evolving, attaching Energy. The kernel says which
// moves were quiet (match.js); any other move clears the list.
let undoStack = [];

function rememberForUndo(g, a) {
  if (!['energy', 'bench', 'evolve'].includes(a.kind)) { undoStack = []; return; }
  if (undoStack.length && undoStack.at(-1).turn !== g.turn) undoStack = [];
  undoStack.push({ snap: JSON.stringify(g.snapshot()), logLen: logEntries.length, label: a.label, turn: g.turn, coach: coachState, win: winState });
}

function undoLast() {
  const u = undoStack.pop();
  if (!u || !game || game.current?.idx !== ME) return;
  resumeGame({ decks: game.decks, snapshot: JSON.parse(u.snap), log: logEntries.slice(0, u.logLen), coach: u.coach, win: u.win },
    { note: { key: 'log.undo', params: { a: { $t: u.label } } }, reason: 'undo' });
}

function undoButton() {
  const u = undoStack.at(-1);
  if (!u || !game || u.turn !== game.turn || game.current?.idx !== ME) return '';
  return `<button class="undo-btn" id="undo-btn" title="${esc(`${t('ui.undo', { a: { $t: u.label } })}\n${t('tip.undo')}`)}">${icon('rotate-ccw')} ${esc(t('ui.undoShort'))}</button>`;
}

function gameOver(g) {
  decision = null;
  clearActions();
  $('#tips').innerHTML = '';
  oppStatus();
  openModal(() => {
    const [ic, title] = g.winner === 'draw' ? ['handshake', t('ui.drawGame')] : g.winner.idx === ME ? ['trophy', t('ui.youWin')] : ['frown', t('ui.oppWins')];
    return `<p class="over-title">${icon(ic)} ${esc(title)}</p><p>${esc(g.winReason.text)}</p>
      <p>${esc(t('ui.overText'))}</p>${recorder ? `<p class="over-match">${esc(t('ui.overMatch', { id: recorder.id }))}</p>` : ''}
      <div class="row"><button id="over-close">${esc(t('ui.lookBoard'))}</button><button class="primary" id="over-new">${esc(t('ui.new'))}</button></div>`;
  }, () => {
    $('#over-close').onclick = closeModal;
    $('#over-new').onclick = () => { closeModal(); openStart(); };
  });
}

// ---------------- Deck chooser ----------------
// The decks of the reviewed release (decks.json): each is a printed list — an official product or a tournament
// winner's list — with every card an exact Simplified Chinese printing. Tiles show the deck's colours, the Pokémon it
// is built around, a short description and its make-up; the list's source is linked below the tiles.
// Above them, 我的卡组: the player's own legal decks from the account server (built on decks.html), ids user:<n>.
let oppChoice = 'random';
const STAGE_RANK = { basic: 0, stage1: 1, stage2: 2 };
const FORMAT_ORDER = ['standard', 'open'];

function describeDeck(d, catalog) {
  const stats = { pokemon: 0, trainer: 0, energy: 0 }, types = new Map(), mons = [];
  for (const [id, n] of d.cards) {
    const def = catalog.definitionFor(id), m = def.mechanics;
    stats[def.kind] += n;
    if (def.kind !== 'pokemon') continue;
    types.set(m.types[0], (types.get(m.types[0]) ?? 0) + n);
    mons.push({ id, name: def.name, rank: (m.ruleBox ? 100 : 0) + STAGE_RANK[m.stage] * 10 + n });
  }
  // The Pokémon the deck is built around: rule-box Pokémon and higher stages first, then the most copies; one per name.
  const featured = [...new Map(mons.sort((a, b) => b.rank - a.rank).map((m) => [m.name, m.id])).values()].slice(0, 3);
  return { ...d, stats, featured, types: [...types].sort((a, b) => b[1] - a[1]).map(([x]) => x).slice(0, 2) };
}

const printingImage = (id) => cardImage({ img: release.meta.cards[id]?.image });

function deckTile(d) {
  const s = d.stats;
  const [c1, c2 = c1] = d.types;
  const chips = d.types.map((x) => `<span class="chip">${energyIcon(x)}${esc(t('type.' + x))}</span>`).join('');
  return `<button class="deck ${d.id === selectedDeck ? 'sel' : ''}" data-deck="${d.id}" aria-pressed="${d.id === selectedDeck}" style="--c1:var(--${c1});--c2:var(--${c2})">
    <div class="deck-art"><div class="fan">${d.featured.map((id) => `<img src="${printingImage(id)}" alt="" loading="lazy">`).join('')}</div></div>
    <div class="deck-body">
      <div class="d-name">${esc(d.name)}</div>
      <div class="d-sub">${esc(d.description)}</div>
      <div class="d-types">${chips}</div>
      <div class="d-stats"><span><b>${s.pokemon}</b> ${esc(t('ui.pokemon'))}</span><span><b>${s.trainer}</b> ${esc(t('ui.trainers'))}</span><span><b>${s.energy}</b> ${esc(t('ui.energies'))}</span></div>
    </div>
  </button>`;
}

// Where a deck list comes from, linked where the source has a page.
function sourceLabel(s) {
  if (s.kind === 'official-product') return t('src.product');
  if (s.kind === 'tournament-deck-list') {
    const [place, players] = s.placing.split('/');
    return t('src.tournament', { e: s.event, d: s.eventDate, p: place, n: players });
  }
  return s.revision ? t('src.wiki', { title: s.title, r: s.revision }) : s.title;
}
function deckSource(d) {
  if (!d) return '';
  if (d.user) return `${esc(t('src.mine', { d: d.name }))}<a href="decks.html?id=${d.user}">${esc(t('src.mineEdit'))}</a>`;
  return `${esc(t('src.title', { d: d.name }))}${d.sources.map((s, i) => `${i ? '；' : ''}${s.url
    ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(sourceLabel(s))}</a>` : esc(sourceLabel(s))}`).join('')}`;
}

function renderDeckChoices() {
  const decks = Object.values(release.decks), mine = decks.filter((d) => d.user);
  const newTile = `<a class="deck-new" href="decks.html"><i class="ic ic-circle-plus"></i>${esc(t('mine.new'))}<small>${esc(t('mine.newSub'))}</small></a>`;
  $('#deck-choices').innerHTML = `
    <section class="deck-section">
      <div class="deck-group"><span>${esc(t('deckgroup.mine'))}</span><small>${esc(t('deckgroup.mine.sub'))}</small><a href="decks.html">${esc(t('deckgroup.mine.manage'))} →</a></div>
      <div class="deck-grid">${mine.map(deckTile).join('')}${newTile}</div>
      ${release.drafts ? `<p class="deck-source">${esc(t('mine.drafts', { n: release.drafts }))}</p>` : ''}
    </section>`
    + FORMAT_ORDER.map((f) => [f, decks.filter((d) => !d.user && d.format.id === f)]).filter(([, l]) => l.length).map(([f, l]) => `
    <section class="deck-section">
      <div class="deck-group"><span>${esc(t('deckgroup.' + f))}</span><small>${esc(t('deckgroup.' + f + '.sub'))}</small></div>
      <div class="deck-grid">${l.map(deckTile).join('')}</div>
    </section>`).join('');
  document.querySelectorAll('.deck').forEach((b) => (b.onclick = () => {
    selectedDeck = b.dataset.deck;
    document.querySelectorAll('.deck').forEach((x) => { x.classList.toggle('sel', x === b); x.setAttribute('aria-pressed', String(x === b)); });
    renderStartBar();
  }));
  renderStartBar();
}

function renderStartBar() {
  if (oppChoice === selectedDeck) oppChoice = 'random';
  const option = (v, l) => `<option value="${v}" ${v === oppChoice ? 'selected' : ''}>${esc(l)}</option>`;
  $('#opt-opp').innerHTML = option('random', t('ui.oppRandom'))
    + Object.values(release.decks).filter((d) => d.id !== selectedDeck).map((d) => option(d.id, d.name)).join('');
  const mine = selectedDeck ? release.decks[selectedDeck].name : t('ui.pickFirst');
  const theirs = oppChoice === 'random' ? t('ui.oppRandom') : release.decks[oppChoice].name;
  $('#match-you').innerHTML = `<small>${esc(t('pl.0'))}</small><b>${esc(mine)}</b>`;
  $('#match-you').classList.toggle('empty', !selectedDeck);
  $('#opt-opp').title = theirs;
  $('#deck-source').innerHTML = deckSource(release.decks[selectedDeck]);
  $('#btn-start').disabled = !selectedDeck;
  $('#btn-start').innerHTML = selectedDeck ? esc(t('ui.start')) : esc(t('ui.pickFirst'));
}

function openStart() {
  // ?deck=<id> (我的卡组 → 对战) picks that deck.
  if (!selectedDeck && release.decks[params.get('deck')]) selectedDeck = params.get('deck');
  renderDeckChoices();
  $('#start').hidden = false;
}

$('#opt-hints').onchange = renderDecision;
document.querySelectorAll('.dice-pick .die-slot').forEach((el) => { el.innerHTML = dieFace(5, el.dataset.die); });
document.querySelectorAll('input[name="dice"]').forEach((r) => (r.onchange = () => {
  diceStyle = r.value;
  try { localStorage.setItem('diceStyle', diceStyle); } catch { /* storage unavailable */ }
  render();
  applyStaticText();
}));
document.querySelectorAll('input[name="opening"]').forEach((r) => (r.onchange = () => {
  openingStyle = r.value;
  try { localStorage.setItem('opening', openingStyle); } catch { /* storage unavailable */ }
}));
// 自动代打 (?auto=1): the CPU engine makes your moves from your own view, starting with the decision on the table.
if (params.get('auto') === '1') $('#opt-auto').checked = true;
$('#opt-auto').onchange = () => {
  if (!autoOn() || !decision || !game) return;
  const cmd = JSON.stringify(autoMove(game));
  const a = decision.actions.find((x) => JSON.stringify(x.cmd) === cmd);
  if (a) decision.pick(a);
};
$('#btn-start').onclick = () => startGame(selectedDeck).catch((err) => {
  log({ key: 'ui.rejected', params: { e: err.message }, kind: 'warn' });
  abandonGame();
});
$('#opt-opp').onchange = (e) => { oppChoice = e.target.value; renderStartBar(); };
$('#btn-new').onclick = () => {
  if (REPLAY) { location.href = './'; return; } // leave the replay; your own saved game is still there
  const inProgress = game && !game.winner && !$('#table').hidden;
  if (!inProgress) { closeModal(); openStart(); return; }
  openModal(() => `<h2>${icon('rotate-ccw')} ${esc(t('ui.newConfirm.title'))}</h2><p>${esc(t('ui.newConfirm.text'))}</p>
    <div class="row"><button id="new-cancel">${esc(t('ui.cancel'))}</button><button class="primary danger" id="new-ok">${esc(t('ui.newConfirm.ok'))}</button></div>`,
  () => {
    $('#new-cancel').onclick = closeModal;
    $('#new-ok').onclick = abandonGame;
  });
};

// Cancel the current game: its async turn loop goes stale, overlays close and the saved state is deleted.
function abandonGame() {
  gameId++;
  game?.stop();
  if (game && !game.winner) recorder?.flush({ status: 'abandoned' });
  recorder = null;
  game = null;
  decision = null;
  undoStack = [];
  if (drag) endDrag(true);
  callStage?.remove();
  callStage = null;
  document.querySelectorAll('.coin-ov, .prize-ov, .arena, .fly, .tumble, .float-dmg, .burst, .drop-menu').forEach((x) => x.remove());
  prizeStage = null;
  prizeFrom = null;
  if (rpsStage) { rpsReset(rpsStage); rpsStage.remove(); rpsStage = null; }
  arena = null;
  document.body.classList.remove('arena-on');
  clearSave();
  closeModal();
  clearActions();
  oppStatus();
  $('#table').hidden = true;
  openStart();
}
$('#btn-tour').onclick = () => runTour();
$('#btn-settings').onclick = openSettings;
$('#engine-badge').onclick = openSettings;
let settingsFrom = null; // where focus goes back to when Settings closes
function closeSettings() {
  $('#settings').hidden = true;
  settingsFrom?.focus?.();
  settingsFrom = null;
}
$('#settings-close').onclick = closeSettings;
$('#settings').onclick = (e) => { if (e.target.id === 'settings') closeSettings(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#settings').hidden) closeSettings(); });
// Remember the settings between visits.
for (const id of ['opt-coach', 'opt-hints', 'opt-anim']) {
  try { const v = localStorage.getItem(id); if (v != null) $('#' + id).checked = v === '1'; } catch { /* storage unavailable */ }
  $('#' + id).addEventListener('change', (e) => { try { localStorage.setItem(id, e.target.checked ? '1' : '0'); } catch { /* ignore */ } });
}
$('#btn-rules').onclick = $('#start-rules').onclick = () => { $('#rules').hidden = false; };
$('#rules-close').onclick = () => { $('#rules').hidden = true; };
$('#rules').onclick = (e) => { if (e.target.id === 'rules') $('#rules').hidden = true; };

// For browser tests: your own player view, exactly what the table may show you (never the full game state).
window.__cnTable = { view: () => game?.game.view(ME) ?? null, release: () => release?.meta.releaseId ?? null, saveKey,
  matchId: () => recorder?.id ?? null };

// A browser error during a game goes into its record; what is still unsent goes out when the page closes.
const recordError = (message, stack) => recorder?.add({ type: 'error', message: String(message).slice(0, 1000), stack: String(stack ?? '').slice(0, 4000) });
window.addEventListener('error', (e) => recordError(e.message, e.error?.stack));
window.addEventListener('unhandledrejection', (e) => recordError(e.reason?.message ?? e.reason, e.reason?.stack));
window.addEventListener('pagehide', () => recorder?.flushOnExit());

// ---------------- Startup ----------------
// The reviewed release is verified against the installed trust pin before anything is shown (WebCrypto, which needs
// HTTPS or localhost).
async function loadRelease() {
  const [json, meta] = await Promise.all([fetch(DATA + 'release.json').then((r) => r.text()), fetch(DATA + 'decks.json').then((r) => r.json())]);
  if (meta.releaseId !== CN_RELEASE_ID) throw new Error(t('ui.releaseMismatch'));
  const catalog = await loadReviewedCatalogRelease({ json, trustedReleases: TRUSTED_RELEASES });
  release = { json, meta, catalog, decisions: createDecisions(catalog),
    decks: Object.fromEntries(meta.decks.map((d) => [d.id, describeDeck(d, catalog)])) };
  // The player's saved decks; the server checked them with the same deck-check.js, and only legal ones can be played.
  const mine = (await apiJSON('/api/decks')).decks;
  for (const d of mine.filter((x) => x.legal)) {
    const id = `user:${d.id}`, saved = new Date(d.updatedAt).toLocaleDateString('zh-CN');
    release.decks[id] = describeDeck({ id, user: d.id, name: d.name, format: formatRef(catalog, d.format), sources: [], cards: d.cards,
      description: t('mine.desc', { f: t('deckgroup.' + d.format), d: saved }) }, catalog);
  }
  release.drafts = mine.length - mine.filter((x) => x.legal).length;
}

applyStaticText();
inspect(null);
try {
  // Everything here needs a signed-in player (the server also refuses the page and its data otherwise).
  user = await requireUser();
  mountNav($('#site-nav'), user, 'play');
  mountNav($('#start-nav'), user, 'play');
  await loadRelease();
  applyStaticText();
  // Know which engine Gary uses before a saved game picks up again (until then he uses the CPU engine).
  await Promise.race([refreshEngine(), new Promise((r) => setTimeout(r, 1500))]);
  const saved = loadSave();
  if (REPLAY) watchReplay(REPLAY).catch((err) => {
    $('#table').hidden = true;
    $('#start').hidden = false;
    $('#deck-choices').innerHTML = `<p class="load-error">${esc(t('replay.loadFailed', { e: err.message }))} <a href="./">${esc(t('replay.exit'))}</a></p>`;
  });
  else if (saved) resumeGame(saved)
    .catch((err) => (err?.code === 'incompatible-state' && saved.record?.id ? resumeFromRecord(saved) : Promise.reject(err)))
    .catch(() => { clearSave(); openStart(); });
  else openStart();
} catch (err) {
  const secure = window.isSecureContext && crypto?.subtle;
  $('#deck-choices').innerHTML = `<p class="load-error">${esc(t(secure ? 'ui.loadFailed' : 'ui.insecure', { e: err.message }))}</p>`;
  $('#btn-start').disabled = true;
  $('#btn-start').textContent = t('ui.pickFirst');
}
