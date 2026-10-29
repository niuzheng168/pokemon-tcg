// The table: board, animations, drag and drop, choices and the start screen. A game is played on the server
// (remote-game.js, /api/play): the table sends the player's commands and shows the player's own view, driven by
// match.js. A replay plays a finished game's record on the CN/V20261019 official kernel in the browser, loaded only from
// the reviewed release through the installed trust pin. This file draws what the kernel decides and never judges a rule.
import { OfficialGame } from './rules/engine.js';
import { CN_RELEASE_ID } from './cn/trusted-releases.js';
import { openCNRelease } from './cn-release.js';
import { Match, ME, OPP, START_SHUFFLE } from './match.js';
import { RemoteGame } from './remote-game.js';
import { preloadImages, preloadState } from './image-preload.js';
import { createAI } from './cn/ai.js';
import { RPS_CANCEL, chooseThrow, showdown, rpsReset, rpsClose } from './rps.js';
import { api, BUILTIN_ENGINE } from './api.js';
import { t, cardName, RULES_HTML, displayText, cardImage, CARD_BACK } from './i18n.js';
import { requireUser, mountNav, apiJSON, dialog, confirmDialog } from './account.js';
import { formatRef } from './deck-check.js';
import { MatchRecorder } from './recorder.js';
import { stateHash, effectiveMoves, newGame, applyEdit } from './replay.js';
import { IMPLEMENTATION_NAMES, implementationSummary } from './card-quality.js';
import { runCommand } from './debug-console.js';
import { mountDebugPanel } from './debug-panel.js';

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
let recorder = null;              // the browser's errors during the game, for its record on the server (recorder.js)
const REPLAY = params.get('replay'); // ?replay=<match id>[&at=<move>]: watch a recorded game (replay.js); nothing is saved or recorded
let release = null;               // {session, index, meta, decks: {id → deck}, cpu (the CPU engine on the catalog cpuFor), drafts}
let user = null;                  // the signed-in player (account.js)
let gameId = 0;
let inspectables = new Map(); // element key → card, for the inspector panel
let logEntries = [];
let decision = null;          // current human decision: {actions, p, pick, llm}
let oppState = { key: '', params: {}, thinking: false };
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
const qualityBadge = (card) => card.implementation === 'machine'
  ? '<span class="card-quality-badge" title="机器核对／实现，未经人工逐张审核">机器实现</span>' : '';

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
        ${qualityBadge(m.card)}
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

// ---------------- 小茂的难度 (Settings and the start bar) ----------------
// The server plays 小茂 at the difficulty levels it offers (GET /api/engine): the rule AI (api.js) and the language-model
// levels. The level is chosen before a game and kept with it (a new choice starts with the next game). With none offered
// the built-in CPU engine plays.
let engine = null;     // GET /api/engine: {engine, ready, where, coach, levels: [{level, name, offered, llm?}]}
let aiLevel = 3;       // the level chosen for a new game
let matchLevel = null; // the level of the game on the table (null: the built-in CPU engine plays 小茂)
try { const v = Number(localStorage.getItem('ai-level')); if (Number.isInteger(v) && v >= 1) aiLevel = v; } catch { /* storage unavailable */ }

const offeredLevels = () => (engine?.levels ?? []).filter((l) => l.offered);
// The level a new game starts with: the one chosen when it is offered, else the rule AI's, else the first offered.
const newLevel = () => { const o = offeredLevels(); return (o.find((l) => l.level === aiLevel) ?? o.find((l) => l.level === 3) ?? o[0])?.level ?? null; };
const levelName = (level) => engine?.levels.find((l) => l.level === level)?.name ?? '';
function engineLabel() {
  if (!engine) return '…';
  const level = !$('#table').hidden ? matchLevel : newLevel();
  return level ? t('eng.badge.level', { n: levelName(level) }) : t('eng.badge.cpu');
}

function applyEngine(e) {
  engine = e;
  $('#llm-coach-row').hidden = !engine.coach;
  $('#engine-badge').textContent = engineLabel();
  renderLevelPick();
  if (!$('#settings').hidden) renderEngineBox();
}

async function refreshEngine() {
  try { applyEngine(await (await api('/api/engine')).json()); }
  catch { applyEngine(BUILTIN_ENGINE); }
}

function setLevel(level) {
  aiLevel = level;
  try { localStorage.setItem('ai-level', String(level)); } catch { /* storage unavailable */ }
  applyEngine(engine);
}

// The start bar: 小茂's level for the next game, and Settings (the opening and the rest are picked there).
function renderLevelPick() {
  const host = $('#start-engine'), level = newLevel();
  const settings = `<button class="linkish" id="start-engine-change">${esc(t('ui.settings'))}</button>`;
  if (!level) host.innerHTML = `<small>${esc(t('ui.levelLabel'))}</small><span><b>${esc(t('eng.badge.cpu'))}</b> ${settings}</span>`;
  else {
    host.innerHTML = `<small>${esc(t('ui.levelLabel'))}</small><span><select id="opt-level" title="${esc(t(`lvl.${level}.d`))}"
      aria-label="${esc(t('ui.levelLabel'))}">${offeredLevels().map((l) =>
      `<option value="${l.level}" ${l.level === level ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select> ${settings}</span>`;
    $('#opt-level').onchange = (ev) => setLevel(Number(ev.target.value));
  }
  $('#start-engine-change').onclick = openSettings;
}

// Settings: the levels offered, what each one does, and where it thinks.
function renderEngineBox() {
  const box = $('#engine-box'), level = newLevel();
  if (!engine) return;
  if (!level) {
    box.innerHTML = `<p class="eng-desc">${esc(t('eng.cpu.d'))}</p><p class="eng-warn">${esc(t('eng.off'))}</p>`;
    return;
  }
  const tabs = offeredLevels().map((l, i) => `<label class="eng-tab${l.level === level ? ' on' : ''}"><input type="radio" name="ai-level"
    value="${l.level}" ${l.level === level ? 'checked' : ''}><b>${esc(l.name)}</b><small>${esc(t('lvl.stars', { n: i + 1 }))}</small></label>`).join('');
  const later = game && matchLevel && matchLevel !== level ? `<p class="eng-small">${esc(t('eng.nextGame', { n: levelName(matchLevel) }))}</p>` : '';
  const where = engine.levels.find((l) => l.level === level)?.llm ? 'eng.where.llm' : engine.where === 'remote' ? 'eng.where.remote' : 'eng.where.local';
  box.innerHTML = `<div class="eng-tabs levels" role="radiogroup" aria-labelledby="eng-title">${tabs}</div>
    <p class="eng-desc">${esc(t(`lvl.${level}.d`))}</p>${later}<p class="eng-small">${esc(t(where))}</p>`;
  box.querySelectorAll('input[name="ai-level"]').forEach((r) => (r.onchange = () => setLevel(Number(r.value))));
}

function openSettings() {
  if ($('#settings').hidden) settingsFrom = document.activeElement;
  $('#settings').hidden = false;
  $('#settings .dialog').focus();
  renderEngineBox();
  refreshEngine();
}

// ---------------- Moves on the table ----------------
// Every move starts from a card on the table: the hand card it plays, the Pokémon that attacks, uses an Ability or
// retreats, the Stadium, the discard pile (an Ability used from there, a card put back into play from there). Clicking
// that card opens a menu of its moves beside it; a hand card's targets light up as well and can be clicked instead, the
// same places dragging the card lights up. A move with no card on the table to start from goes under 其他操作, beside
// 结束回合, so no legal move is ever out of reach.
let menu = null;       // the open menu: {el, armed: [{el, actions}]} (armed: the lit targets of a hand card)
let dragEnded = false; // the click that ends a drag is not a click on a card

// Where a move starts: 'hand:<uid>', 'mon:<id>', 'stadium', 'discard', 'end' or 'more' (also for a card not on view).
function anchorOf(a) {
  if (a.kind === 'end') return 'end';
  const me = game.players[ME];
  const key = a.card && me.hand.some((c) => c?.uid === a.card.uid) ? 'hand:' + a.card.uid
    : a.card && me.discard.some((c) => c.uid === a.card.uid) ? 'discard'
    : a.target ? 'mon:' + a.target.id : a.kind === 'stadium' ? 'stadium' : 'more';
  return key === 'more' || anchorEl(key) ? key : 'more';
}
const anchorEl = (key) => (key.startsWith('hand:') ? $(`#hand [data-card="${key.slice(5)}"]`)
  : key.startsWith('mon:') ? $(`[data-mon="${key.slice(4)}"]`) : key === 'stadium' ? $('#stadium')
  : key === 'discard' ? $('#you-piles .pile[data-pile="discard"]') : key === 'more' ? $('#more-acts') : null);
// The anchor a click lands on, {anchor, el} (the discard pile opens its list, showDiscard, with its moves).
function anchorAt(el) {
  const hand = el.closest('#hand .hcard');
  if (hand) return { anchor: 'hand:' + hand.dataset.card, el: hand };
  const mon = el.closest('[data-mon]');
  if (mon) return { anchor: 'mon:' + mon.dataset.mon, el: mon };
  for (const [sel, anchor] of [['#stadium', 'stadium'], ['#more-acts', 'more']]) if (el.closest(sel)) return { anchor, el: el.closest(sel) };
  // The coach's word in the bar: the menu of the move it picks, with its reason (on a touch screen the only way to read
  // its reason for 结束回合, which a mouse finds on the button).
  const pick = el.closest('#llm-coach-msg') && coachPick();
  if (pick) return { anchor: anchorOf(pick), el: el.closest('#llm-coach-msg') };
  return null;
}
const movesAt = (key) => (decision ? decision.actions.filter((a) => anchorOf(a) === key) : []);

// Where a hand card can go, as when dragging it: the Pokémon its moves target, the Bench for a Basic Pokémon.
function targetZones(card) {
  const zones = new Map();
  for (const a of decision.actions.filter((x) => x.card?.uid === card.uid)) {
    const el = a.target ? document.querySelector(`[data-mon="${a.target.id}"]`) : a.kind === 'bench' ? $('#you-bench') : null;
    if (!el) continue;
    if (a.kind === 'energy' && isOffType(a)) el.classList.add('drop-weak');
    if (!zones.has(el)) zones.set(el, []);
    zones.get(el).push(a);
  }
  return [...zones].map(([el, actions]) => ({ el, actions }));
}

// One row of a menu: what the move does and the coach's word on it.
function moveRow(a) {
  const b = document.createElement('button');
  b.className = `act k-${a.kind}`;
  b.dataset.kind = a.kind;
  b.dataset.action = JSON.stringify(a.cmd);
  b.setAttribute('role', 'menuitem');
  const { p } = decision;
  const note = a.kind === 'energy' && isOffType(a) ? `<span class="note" title="${esc(t('tip.offType'))}">${esc(t('ui.onlyColorless'))}</span>` : '';
  const cost = a.kind === 'attack' && a.atk ? `<span class="cost">${costIcons(a.atk.cost)}</span>` : '';
  const judged = coachOn() ? decision.llm?.moves?.[a.key] : null;
  if (judged?.choose) b.classList.add('coach-pick');
  const said = judged ? `${judged.choose ? `<span class="pick coach">${icon('sparkles')} ${esc(t('llm.pick'))}</span>` : ''}${judged.reason
    ? `<span class="why coach-why"><b>${esc(t('llm.who'))}</b> ${esc(judged.reason)}</span>` : ''}` : '';
  b.innerHTML = `${actLead(a, p)}<span class="lbl"><span class="txt">${esc(t(a.label.key, a.label.params))}</span>${cost}${note}${said}</span>`;
  b.onmouseenter = () => highlight(a, true);
  b.onmouseleave = () => highlight(a, false);
  b.onclick = () => { closeMenu(); decision?.pick(a); };
  return b;
}
const costIcons = (cost) => (cost.length ? cost.map((x) => energyIcon(x)).join('') : esc(t('ex.free')));

// A menu of moves beside its card (above a hand card), grouped by kind when there are several kinds. off: rows shown
// but not playable now (the Active's other attacks); note: a line under the title (why nothing can be done).
function openMenu(el, actions, { title = '', note = '', off = [], armed = [], above = false, at = null, focus = false } = {}) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'act-menu';
  m.setAttribute('role', 'menu');
  // 详情: the card's preview, for a finger (a mouse has it by pointing at the card).
  const info = el?.dataset.inspect ? `<button class="am-info" aria-label="${esc(t('ui.cardDetails'))}">${icon('info')} ${esc(t('ui.cardDetails'))}</button>` : '';
  m.innerHTML = `${title ? `<div class="am-title"><span>${esc(title)}</span>${info}</div>` : ''}${note ? `<div class="am-note">${icon('lightbulb')} ${esc(note)}</div>` : ''}${actions.length ? coachLine() : ''}`;
  const kinds = [...new Set([...(off.length ? ['attack'] : []), ...actions.map((a) => a.kind)])]
    .sort((a, b) => (KIND_ORDER.indexOf(a) + 1 || 99) - (KIND_ORDER.indexOf(b) + 1 || 99));
  for (const kind of kinds) {
    if (kinds.length > 1) m.insertAdjacentHTML('beforeend', `<div class="am-head">${esc(t(kind === 'power' ? 'group.ability' : 'group.' + kind))}</div>`);
    actions.filter((a) => a.kind === kind).forEach((a) => m.append(moveRow(a)));
    if (kind === 'attack') m.insertAdjacentHTML('beforeend', off.map(offRow).join(''));
  }
  document.body.append(m);
  m.querySelector('.am-info')?.addEventListener('click', () => { closeMenu(); previewOf(el); });
  armed.forEach((z) => z.el.classList.add('drop-ok'));
  if (armed.length) document.body.classList.add('arming');
  el?.classList.add('menu-src');
  menu = { el: m, src: el, armed };
  const r = at ? { left: at.x, right: at.x, top: at.y, bottom: at.y, width: 0, height: 0 } : el.getBoundingClientRect();
  const w = m.offsetWidth, h = m.offsetHeight, gap = 10;
  let left, top;
  if (above) {
    left = r.left + r.width / 2 - w / 2; top = r.top - gap - h;
    if (top < 8) top = r.bottom + gap;
  } else {
    left = r.right + gap; top = r.top;
    if (left + w > innerWidth - 8) left = r.left - gap - w;
  }
  m.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, left))}px`;
  m.style.top = `${Math.max(8, Math.min(innerHeight - h - 8, top))}px`;
  if (focus) m.querySelector('button')?.focus({ preventScroll: true }); // opened from the keyboard
}
// The coach in a menu while it thinks, or why it cannot answer (its word on each move is on the move's row).
function coachLine() {
  const c = coachOn() ? decision?.llm : null;
  if (c?.state === 'thinking') return `<div class="am-coach">${icon('loader')} ${esc(t('llm.thinking'))}</div>`;
  if (c?.state === 'error') return `<div class="am-coach">${icon('triangle-alert')} ${esc(t('llm.error', { e: c.error }))}</div>`;
  return '';
}
const offRow = (atk) => `<div class="act k-attack off" aria-disabled="true"><span class="lead">${icon('swords')}</span><span class="lbl"><span class="txt">${
  esc(t(atk.damage ? 'act.attackDmg' : 'act.attack', { a: atk.name, d: atk.damage }))}</span><span class="cost">${costIcons(atk.cost)}</span><span class="note">${esc(t('now.notReady'))}</span></span></div>`;

function closeMenu() {
  if (!menu) return;
  menu.el.remove();
  menu.src?.classList.remove('menu-src');
  menu.armed.forEach((z) => z.el.classList.remove('drop-ok', 'drop-hover', 'drop-weak'));
  document.body.classList.remove('arming');
  document.querySelectorAll('.hl').forEach((x) => x.classList.remove('hl'));
  menu = null;
}

// The moves of a clicked card. A hand card that cannot be played says why; your Active lists its attacks that cannot be
// used now as well, so a click on it always answers "can I attack?". focus: opened from the keyboard.
function openMoves(at, focus = false) {
  openMovesAt(at, focus);
  if (menu) menu.at = at;
}
function openMovesAt({ anchor: key, el }, focus) {
  const acts = movesAt(key);
  if (key.startsWith('hand:')) {
    const card = inspectables.get('c' + key.slice(5));
    if (!card) return;
    if (!acts.length) openMenu(el, [], { title: cardName(card), note: t(...whyNot(card, game.players[ME])), above: true, focus });
    else openMenu(el, acts, { title: cardName(card), above: true, armed: targetZones(card), focus });
    return;
  }
  if (key.startsWith('mon:')) {
    const mon = monById(Number(key.slice(4))), me = game.players[ME];
    const legal = new Set(acts.filter((a) => a.kind === 'attack').map((a) => a.cmd.attackId));
    const off = mon && mon === me.active ? mon.card.attacks.filter((x) => !legal.has(x.id)) : [];
    if (!mon || (!acts.length && !off.length)) { closeMenu(); return; }
    const why = !legal.size && off.length ? whyNoAttack(me) : null;
    openMenu(el, acts, { title: cardName(mon.card), off, note: why ? t(...why) : '', focus });
    return;
  }
  if (!acts.length) { closeMenu(); return; }
  openMenu(el, acts, { title: key === 'stadium' ? cardName(game.stadium?.card) : key === 'end' ? t('ui.endTurn') : t('ui.moreActions', { n: acts.length }), focus });
}
// Several moves on one target (e.g. Energy Removal on a Pokémon with two Energy types): a menu where it was chosen.
function pickFrom(actions, x, y) {
  if (actions.length === 1) { closeMenu(); decision.pick(actions[0]); return; }
  openMenu(null, actions, { title: t('drag.choose'), at: { x, y } });
}

document.addEventListener('click', (e) => {
  if (dragEnded || !game || e.target.closest('.act-menu')) return;
  const zone = menu?.armed.find((z) => z.el.contains(e.target));
  if (zone && decision) { pickFrom(zone.actions, e.clientX, e.clientY); return; }
  const at = decision && anchorAt(e.target);
  if (at && at.el !== menu?.src) openMoves(at);
  else closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeMenu(); return; }
  if ((e.key === 'Enter' || e.key === ' ') && decision && e.target.matches?.('#hand .hcard, [data-mon].can-act, #stadium.can-act')) {
    e.preventDefault();
    openMoves(anchorAt(e.target), true);
  }
});
window.addEventListener('resize', closeMenu);

// ---------------- Drag and drop from the hand ----------------
// Picking up a hand card highlights only where it can legally go (from the current list of legal moves);
// dropping it there makes that move, exactly like choosing it from the card's menu.
let drag = null;

function dropZones(card) {
  const zones = targetZones(card);
  const rest = decision.actions.filter((a) => a.card?.uid === card.uid && !zones.some((z) => z.actions.includes(a)));
  if (rest.length) zones.push({ el: playZone(card), actions: rest });
  return zones;
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
  closeMenu();
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
  dragEnded = true;
  setTimeout(() => { dragEnded = false; });
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
  pickFrom(acts, d.lastX, d.lastY);
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
  // A face-up Prize shows its card; an effect may place more than six.
  const slots = Array.from({ length: Math.max(PRIZES, p.prizes.length) }, (_, i) => (i >= p.prizes.length ? '<div class="slot"></div>' :
    p.prizes[i] ? `<img src="${cardImage(p.prizes[i])}" alt="${esc(cardName(p.prizes[i]))}" draggable="false">` : backImg())).join('');
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
  // A discard pile with cards opens their list (showDiscard).
  const open = top ? ` role="button" tabindex="0" aria-label="${esc(t('ui.discardTitle', { p: { $pl: p.idx }, n: p.discard.length }))}"` : '';
  return `<div class="pile" data-pile="deck">${deck}<span class="count">${p.deck.length}</span><div>${esc(t('ui.deck'))}</div></div>
    <div class="pile" data-pile="discard" data-owner="${p.idx}"${open}>${discard}<span class="count">${p.discard.length}</span><div>${esc(t('ui.discard'))}</div></div>`;
}

// ---------------- Discard piles ----------------
// Both discard piles are face up and either player may look through them (CN 竞赛规则 3.1.0 §2.2 lets a player check the
// opponent's discard pile, with their consent before touching the cards; the player view shows both in full). Clicking a
// pile lists its cards, the last one put there first; the list follows the game while it is open. Your own pile also lists
// the moves that start there (an Ability used from the discard pile, a card put back into play from it).
let pileShown = null; // whose discard pile the open window lists
function showDiscard(idx) {
  openModal(() => {
    const cards = [...(game?.players[idx].discard ?? [])].reverse();
    cards.forEach((c) => inspectables.set('c' + c.uid, c));
    return `<h2>${icon('layers')} ${esc(t('ui.discardTitle', { p: { $pl: idx }, n: cards.length }))}</h2>
      <p>${esc(t(cards.length ? 'ui.discardNote' : 'ui.discardEmpty'))}</p><div class="pile-moves" hidden></div>
      ${cards.length ? `<div class="choice-grid pile-list ${cards.length > 20 ? 'tiny' : 'small'}">${cards.map((c) =>
        `<div class="pick-card" data-inspect="c${c.uid}"><img src="${cardImage(c)}" alt="${esc(cardName(c))}"><span class="sub">${esc(cardName(c))}</span></div>`).join('')}</div>` : ''}
      <div class="row"><button class="primary" id="pile-close">${esc(t('ui.close'))}</button></div>`;
  }, (body) => {
    body.classList.toggle('wide', (game?.players[idx].discard.length ?? 0) > 20);
    $('#pile-close').onclick = closeModal;
    const moves = idx === ME ? movesAt('discard') : [];
    const box = body.querySelector('.pile-moves');
    box.hidden = !moves.length;
    box.append(...moves.map((a) => {
      const row = moveRow(a);
      row.onclick = () => { closeModal(); decision?.pick(a); };
      return row;
    }));
  }, 'sheet');
  pileShown = idx;
}
const pileAt = (el) => el?.closest?.('.pile[data-pile="discard"][role="button"]');
document.addEventListener('click', (e) => {
  const pile = pileAt(e.target);
  if (pile && game) showDiscard(Number(pile.dataset.owner));
});
document.addEventListener('keydown', (e) => {
  const pile = (e.key === 'Enter' || e.key === ' ') && pileAt(e.target);
  if (pile && game) { e.preventDefault(); showDiscard(Number(pile.dataset.owner)); }
  else if (e.key === 'Escape' && pileShown !== null) closeModal();
});

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
    // Its places set the size of its cards (style.css .bench): as big as the Active while the width holds them.
    $(`#${key}-bench`).style.setProperty('--bench-n', Math.max(p.benchLimit ?? 5, p.bench.length));
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
    return `<div class="hcard ${arriving}" data-inspect="c${c.uid}" data-card="${c.uid}"><img src="${cardImage(c)}" alt="${esc(cardName(c))}" draggable="false">${qualityBadge(c)}</div>`;
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
  if (pileShown !== null) rerenderModal();
  debugPanel?.refresh();
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
    <p class="card-quality">${esc(IMPLEMENTATION_NAMES[card.implementation] ?? '')}${card.implementation === 'machine' ? '（未经人工逐张审核）' : ''}</p>
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

// The preview of a card on the page (anything with data-inspect), with why it cannot be played or picked.
function previewOf(el) {
  const card = inspectables.get(el.dataset.inspect);
  const reason = el.classList.contains('unplayable') && game ? whyNot(card, game.players[0]) : el.dataset.why ? ['ui.pickWhy', { r: el.dataset.why }] : null;
  inspect(card, reason, el);
  // The image loads asynchronously; re-place once its size is known.
  $('#preview img')?.addEventListener('load', () => !$('#preview').hidden && placePreview(el), { once: true });
}
document.addEventListener('mouseover', (e) => {
  if (touching) return; // a tap is not pointing at a card (touch screens send mouseover for it)
  const el = e.target.closest('[data-inspect]');
  if (el && inspectables.has(el.dataset.inspect)) previewOf(el);
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

// ---------------- Touch screens (iPad) ----------------
// A finger has no hover. A tap must not show the preview: touch browsers send mouseover for it, and on an iPad a tap
// that changes the page that way is not also a click (Safari waits for a second tap). Holding a finger on a card shows
// its preview instead (a mouse shows it by pointing), and the press is then not a tap; the next touch hides it. A card's
// menu has a 详情 button for the same (style.css shows it on touch screens), and choices say to hold a card.
let touching = false; // the last pointer was a finger or a pen, not a mouse
let press = null;     // a finger held on a card: {el, x, y, timer, shown}
let swallowClick = false;
const HOLD_MS = 450;
document.addEventListener('pointerdown', (e) => {
  touching = e.pointerType !== 'mouse';
  clearTimeout(press?.timer);
  press = null;
  swallowClick = false;
  const el = touching && e.target.closest('[data-inspect]');
  if (!el || !inspectables.has(el.dataset.inspect)) return;
  press = { el, x: e.clientX, y: e.clientY, shown: false };
  press.timer = setTimeout(() => { if (press?.el === el && el.isConnected) { press.shown = true; previewOf(el); } }, HOLD_MS);
}, true);
document.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse') touching = false;
  if (press && !press.shown && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) { clearTimeout(press.timer); press = null; }
}, true);
const endPress = () => { if (!press) return; clearTimeout(press.timer); swallowClick = press.shown; press = null; };
document.addEventListener('pointerup', endPress, true);
document.addEventListener('pointercancel', endPress, true);
window.addEventListener('click', (e) => {
  if (!swallowClick) return;
  swallowClick = false;
  e.stopPropagation();
  e.preventDefault();
}, true);
// Holding a finger on a card is not a request for the browser's own menu (save image, select text).
document.addEventListener('contextmenu', (e) => { if (touching && e.target.closest('[data-inspect], #board, .dialog.sheet, .prize-ov, .coin-ov')) e.preventDefault(); });
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
  if (!logOpen) { logUnread++; renderUnread(); }
}
function renderLog() {
  $('#log').replaceChildren(...logEntries.map(logLine));
  $('#log').scrollTop = $('#log').scrollHeight;
  logUnread = 0;
  renderUnread();
}

// The log is a column beside the board, opened from the bar between the mats (closed, the board has the whole width);
// the browser remembers the choice. While it is closed, the button counts the lines added since.
let logOpen = (() => { try { return localStorage.getItem('logOpen') === '1'; } catch { return false; } })();
let logUnread = 0;
function setLog(open) {
  logOpen = open;
  try { localStorage.setItem('logOpen', open ? '1' : '0'); } catch { /* storage unavailable */ }
  document.documentElement.classList.toggle('log-open', open);
  $('#log-panel').hidden = !open;
  $('#btn-log').setAttribute('aria-expanded', String(open));
  if (open) { logUnread = 0; $('#log').scrollTop = $('#log').scrollHeight; }
  renderUnread();
  closeMenu();
  layoutHand(); // the board changed width
}
function renderUnread() {
  $('#log-unread').hidden = !logUnread;
  $('#log-unread').textContent = logUnread > 99 ? '99+' : String(logUnread);
}
$('#btn-log').onclick = () => setLog(!logOpen);
$('#log-close').onclick = () => setLog(false);
setLog(logOpen);

function oppStatus(key = '', params = {}, thinking = false) {
  oppState = { key, params, thinking };
  renderOppStatus();
}
function renderOppStatus() {
  $('#opp-status').innerHTML = oppState.key ? (oppState.key === 'ui.aiError' ? icon('triangle-alert') : '') + esc(t(oppState.key, oppState.params)) : '';
  $('#opp-status').classList.toggle('thinking', oppState.thinking);
}


// ---------------- Human player ----------------
// Why your Active Pokémon cannot attack at all, said in its menu: the first turn, a Special Condition, or Energy.
function whyNoAttack(p) {
  if (game.turn === 1 && game.first === ME) return ['tip.firstTurn'];
  const st = p.active.conditions().find((s) => s === 'asleep' || s === 'paralyzed');
  return st ? ['tip.cantStatus', { m: p.active.name, s: { $st: st } }] : ['tip.noEnergy', { m: p.active.name }];
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

// Show what has moves in the current decision: hand cards without one are dimmed; Pokémon, the Stadium and the discard
// pile with moves glow, a Pokémon with a badge per kind (attack, Ability, retreat); the coach's pick is marked.
const KIND_ICON = { attack: 'swords', power: 'sparkles', retreat: 'arrow-left-right' };
function markPlayable() {
  const keys = new Set(decision ? decision.actions.map(anchorOf) : []);
  document.querySelectorAll('#hand .hcard').forEach((el) => {
    el.classList.toggle('unplayable', !!decision && !keys.has('hand:' + el.dataset.card));
    if (decision) el.tabIndex = 0; else el.removeAttribute('tabindex');
  });
  document.querySelectorAll('.can-act').forEach((el) => el.classList.remove('can-act'));
  document.querySelectorAll('.act-badges').forEach((el) => el.remove());
  document.querySelectorAll('[data-mon][tabindex], #stadium[tabindex]').forEach((el) => { el.removeAttribute('tabindex'); el.removeAttribute('role'); });
  for (const key of keys) {
    const el = !key.startsWith('hand:') && key !== 'end' && anchorEl(key);
    if (!el) continue;
    el.classList.add('can-act');
    if (key.startsWith('mon:') || key === 'stadium') { el.tabIndex = 0; el.setAttribute('role', 'button'); }
    if (!key.startsWith('mon:')) continue;
    const kinds = [...new Set(movesAt(key).map((a) => KIND_ICON[a.kind] ?? 'circle-plus'))];
    el.querySelector('.top-card')?.insertAdjacentHTML('beforeend', `<span class="act-badges">${kinds.map(icon).join('')}</span>`);
  }
  document.querySelectorAll('.coach-move').forEach((el) => el.classList.remove('coach-move'));
  const coached = coachPick();
  if (coached && coached.kind !== 'end') anchorEl(anchorOf(coached))?.classList.add('coach-move');
  document.querySelector('#end-slot .k-end')?.classList.toggle('go', !!decision && onlyEndLeft(decision.actions));
  document.body.classList.toggle('your-move', !!decision);
}

function highlight(act, on) {
  const sels = [];
  if (act.card) sels.push(`[data-card="${act.card.uid}"]`);
  if (act.target) sels.push(`[data-mon="${act.target.id}"]`);
  if (act.kind === 'attack' || act.kind === 'retreat') sels.push('#you-active .mon');
  for (const sel of sels) document.querySelectorAll(sel).forEach((el) => el.classList.toggle('hl', on));
}

// The bar between the mats on your move: the coach's pick; at its end 其他操作 (moves with no card to start from), undo
// and 结束回合.
function renderDecision() {
  if (!decision) return;
  const { actions } = decision;
  renderHint();
  $('#end-slot').innerHTML = '';
  const more = actions.filter((a) => anchorOf(a) === 'more');
  if (more.length) $('#end-slot').insertAdjacentHTML('beforeend', `<button class="mid-btn" id="more-acts">${icon('circle-plus')} ${esc(t('ui.moreActions', { n: more.length }))}</button>`);
  $('#end-slot').insertAdjacentHTML('beforeend', undoButton());
  $('#undo-btn')?.addEventListener('click', undoLast);
  const end = actions.find((a) => a.kind === 'end');
  if (end) $('#end-slot').append(endButton(end));
  markPlayable();
}

// The coach's word in the bar: thinking, then the move it picks (its reasons are on each move's row).
function renderHint() {
  if (rp) return; // a replay's bar holds its controls (replayBar)
  const c = coachOn() ? decision?.llm : null, picked = coachPick();
  const coach = c?.state === 'thinking' ? `${icon('loader')} ${esc(t('llm.thinking'))}`
    : picked ? `${icon('sparkles')} ${esc(t('llm.suggests', { a: t(picked.label.key, picked.label.params) }))}` : '';
  $('#hint').innerHTML = coach ? `<span id="llm-coach-msg"><b class="coach-who">${esc(t('llm.who'))}</b> ${coach}</span>` : '';
}

// The end of the turn: a big button on the table, at the end of the bar between the two mats.
function endButton(a) {
  const b = document.createElement('button');
  b.className = 'act k-end';
  b.dataset.kind = 'end';
  b.dataset.action = JSON.stringify(a.cmd);
  b.title = t(a.label.key, a.label.params);
  const judged = coachOn() ? decision.llm?.moves?.[a.key] : null;
  if (judged?.choose) b.classList.add('coach-pick');
  if (judged?.reason) b.title += ` · ${t('llm.who')}：${judged.reason}`;
  b.innerHTML = `${icon('skip-forward')}<span class="txt">${esc(t('ui.endTurn'))}</span>`;
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

// No move of yours is pending: no menu, nothing at the end of the bar.
function clearActions() {
  closeMenu();
  $('#end-slot').innerHTML = '';
  markPlayable();
  renderHint();
}

// The language-model coach (Settings, when the server has one) and the move it picked on this decision.
const coachOn = () => !!engine?.coach && $('#opt-llm-coach').checked;
const coachPick = () => (coachOn() && decision?.llm?.state === 'ready' ? decision.actions.find((a) => decision.llm.moves[a.key]?.choose) ?? null : null);

// 自动代打: the built-in CPU engine makes your moves too (from your own view only).
const autoOn = () => $('#opt-auto').checked;
function autoMove(g) {
  if (release.cpuFor !== g.catalog) Object.assign(release, { cpu: createAI(g.catalog), cpuFor: g.catalog });
  return release.cpu(g.game.view(ME), ME);
}

class HumanController {
  constructor(myGame) { this.myGame = myGame; this.n = 0; }

  async chooseAction(g, p, actions) {
    if (this.myGame !== gameId) return stale();
    if (autoOn()) {
      await sleep(400);
      if (this.myGame !== gameId) return stale();
      const cmd = JSON.stringify(autoMove(g));
      const a = actions.find((x) => JSON.stringify(x.cmd) === cmd && !x.follow) ?? actions.find((x) => JSON.stringify(x.cmd) === cmd);
      if (a) { undoStack = []; return a; }
    }
    const id = ++this.n;
    return new Promise((resolve) => {
      decision = {
        actions, p,
        pick: (a) => {
          highlight(a, false);
          rememberForUndo(g, a);
          decision = null;
          if (drag) endDrag(true);
          markPlayable();
          this.n++;
          clearActions();
          resolve(a);
        },
      };
      if (coachOn() && g.game.coach) this.askCoach(g, id, actions);
      renderDecision();
    });
  }

  // The language-model coach judges every move of this decision (the server asks it from the player's own view); its
  // word shows on each move's row when a card's menu opens, and the menu open now is opened again with it.
  askCoach(g, id, actions) {
    decision.llm = { state: 'thinking', moves: {} };
    const done = (llm) => {
      if (id !== this.n || this.myGame !== gameId || !decision) return;
      decision.llm = llm;
      renderDecision();
      if (menu?.at) openMoves(menu.at);
    };
    g.game.coach(g.game.status.revision, actions.map((a) => ({ key: a.key, action: a.cmd })))
      .then((r) => done(r.stale ? null : { state: 'ready', moves: r.moves ?? {} }), (err) => done({ state: 'error', error: err.message, moves: {} }));
  }

  // Answers: one option id, a list of ids, or {allocations} for counters placed in any way.
  async choose(g, p, prompt) {
    if (this.myGame !== gameId) return stale();
    if (autoOn()) {
      await sleep(300);
      if (this.myGame !== gameId) return stale();
      const cmd = autoMove(g);
      return cmd.type === 'allocateCounters' ? { allocations: cmd.allocations } : cmd.type === 'guessAnswer' ? { guess: cmd.answer } : cmd.selected;
    }
    if (prompt.kind === 'prize') return choosePrize(prompt);
    if (prompt.kind === 'setup-active' && prompt.options.every((o) => o.card)) return chooseActiveStage(prompt);
    if (prompt.kind === 'setup-bench' && prompt.options.every((o) => o.card)) {
      const uids = await chooseBenchStage(prompt.options.map((o) => o.card), prompt.max);
      return prompt.options.filter((o) => uids.includes(o.card.uid)).map((o) => o.id);
    }
    if (prompt.alloc) return chooseAllocation(prompt);
    if (prompt.kind === 'guess-answer') return chooseGuess(prompt);
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
// One pick answers at once; a choice of several is confirmed with a button, which needs a pick. Choosing none, where
// allowed, is a button of its own: a habitual click on confirm, or a card clicked twice, must not answer "none"
// (碧草之舞 then attaches nothing, so its 「然后」 draw does not happen either).
// When the cards to pick from are among cards the effect looks at (a deck searched, its top cards, a hand), those cards
// are one list: the options are picked right there, and any other card, clicked, says why it cannot be picked
// (「只能选择基础宝可梦」, Match.unpickable).
function chooseOptions(prompt) {
  const single = prompt.min === 1 && prompt.max === 1 && !prompt.allowZero;
  const none = !single && (prompt.min === 0 || prompt.allowZero);
  const picked = [];
  const pictured = prompt.options.filter((o) => !o.label);
  const words = prompt.options.filter((o) => o.label);
  const inline = pictured.length > 0 && pictured.every((o) => o.card && prompt.lookedAt.some((c) => c.uid === o.card.uid));
  const why = (c) => prompt.unpickable?.get(c.uid) ?? t('ui.cannotPick');
  let note = null; // {uid, text}: the card just clicked that cannot be picked, and why
  return new Promise((resolve) => {
    openModal(() => {
      const shown = inline ? prompt.lookedAt.length : prompt.options.length;
      const size = inline && shown > 20 ? 'tiny' : shown > 8 ? 'small' : '';
      prompt.options.forEach((o) => o.card && inspectables.set('c' + o.card.uid, o.card));
      prompt.lookedAt.forEach((c) => inspectables.set('c' + c.uid, c));
      const sel = (o) => (picked.includes(o.id) ? ' sel' : '');
      // Hovering lifts a card just as picking does; only a picked card carries the check mark.
      const mark = (o) => (picked.includes(o.id) ? `<span class="pick-mark">${icon('circle-check')}</span>` : '');
      // A Pokémon shows where it is and what is attached to it, as on the board; a card on a Pokémon, which one.
      const attachedTo = (m) => [...m.energy.map((c) => energyIcon(c.energyType)), ...m.tools.map((x) => `<span class="tag-tool">${esc(cardName(x.card))}</span>`)].join('');
      const pic = (o) => {
        if (o.back) return `<button data-id="${esc(o.id)}" class="pick-card${sel(o)}">${backImg()}${mark(o)}</button>`;
        if (o.mon) return `<button data-id="${esc(o.id)}" class="pick-card${sel(o)}" data-inspect="c${o.mon.card.uid}"><img src="${cardImage(o.mon.card)}" alt="${esc(cardName(o.mon.card))}"><span class="sub">${esc(cardName(o.mon.card))}</span><span class="sub where">${o.place ? `${esc(o.place)} · ` : ''}<span class="hp">${o.mon.hpLeft}/${o.mon.maxHp} ${t('ui.hp')}</span></span>${attachedTo(o.mon) ? `<span class="pick-attached">${attachedTo(o.mon)}</span>` : ''}${mark(o)}</button>`;
        return `<button data-id="${esc(o.id)}" class="pick-card${sel(o)}" data-inspect="c${o.card.uid}"><img src="${cardImage(o.card)}" alt="${esc(cardName(o.card))}"><span class="sub">${esc(cardName(o.card))}</span>${o.on ? `<span class="sub where">${esc(o.on.place)} ${esc(cardName(o.on.mon.card))}</span>` : ''}${mark(o)}</button>`;
      };
      const word = (o) => `<button data-id="${esc(o.id)}" class="${pictured.length ? 'textlink' : o.id === 'perform' || o.id === 'first' ? 'primary' : 'opt-word'}${sel(o)}">${esc(o.label)}</button>`;
      // In the one list, a card that is not an option is dimmed; it still shows its preview.
      const blocked = (c) => `<button class="pick-card off${note?.uid === c.uid ? ' nope' : ''}" data-blocked="${c.uid}" data-why="${esc(why(c))}" data-inspect="c${c.uid}"><img src="${cardImage(c)}" alt="${esc(cardName(c))}"><span class="sub">${esc(cardName(c))}</span></button>`;
      const tiles = inline ? prompt.lookedAt.map((c) => {
        const o = pictured.find((x) => x.card.uid === c.uid);
        return o ? pic(o) : blocked(c);
      }) : pictured.map(pic);
      // Cards chosen from a deck: the ones this choice places are lifted, the others say where they go.
      const where = (c) => (prompt.placed?.has(c.uid) ? ` → ${esc(prompt.placed.get(c.uid))}` : '');
      const looked = !inline && prompt.lookedAt.length ? `<div class="choice-grid small looked">${prompt.lookedAt.map((c) =>
        `<div class="pick-card${prompt.placing?.includes(c.uid) ? ' sel' : ''}" data-inspect="c${c.uid}"><img src="${cardImage(c)}" alt="${esc(cardName(c))}"><span class="sub">${esc(cardName(c))}${where(c)}</span></div>`).join('')}</div>` : '';
      // A choice with nothing to pick (e.g. a hand that cannot pay an attack's cost) has only the 不选择 button.
      const confirm = prompt.options.length && prompt.max > 0
        ? `<button class="primary" id="choice-ok">${icon('circle-check')} ${esc(picked.length ? t('ui.confirmN', { n: picked.length }) : t('ui.confirm'))}</button>` : '';
      const ok = single ? '' : `<div class="row">${none ? `<button class="opt-word" id="choice-none">${esc(t('ui.pickNone'))}</button>` : ''}${confirm}</div>`;
      const foot = inline ? `<p class="pick-note" role="status">${note ? `${icon('info')} ${esc(note.text)}` : ''}</p>${ok}` : ok;
      // A finger has no hover: say how to see a card.
      const head = [promptText(prompt), pictured.length && matchMedia('(hover: none)').matches ? t('ui.holdToView') : ''].filter(Boolean).join(' · ');
      return `<h2>${esc(prompt.title)}</h2><p>${esc(head)}</p>${looked}
        ${tiles.length ? `<div class="choice-grid ${size}${inline ? ' inline' : ''}">${tiles.join('')}</div>` : ''}
        ${words.length ? `<div class="choice-words ${pictured.length ? 'aside' : ''}">${words.map(word).join('')}</div>` : ''}${foot}`;
    }, (body) => {
      body.classList.toggle('wide', inline && prompt.lookedAt.length > 20);
      const valid = () => picked.length > 0 && picked.length >= prompt.min && picked.length <= prompt.max;
      body.querySelectorAll('[data-id]').forEach((b) => (b.onclick = () => {
        note = null;
        if (single) { closeModal(); resolve(b.dataset.id); return; }
        const i = picked.indexOf(b.dataset.id);
        if (i >= 0) picked.splice(i, 1); else if (picked.length < prompt.max) picked.push(b.dataset.id);
        rerenderModal();
      }));
      body.querySelectorAll('[data-blocked]').forEach((b) => (b.onclick = () => {
        note = { uid: Number(b.dataset.blocked), text: b.dataset.why };
        rerenderModal();
      }));
      const ok = body.querySelector('#choice-ok');
      if (ok) {
        ok.disabled = !valid();
        ok.onclick = () => { if (!valid()) return; closeModal(); resolve([...picked]); };
      }
      const skip = body.querySelector('#choice-none');
      if (skip) skip.onclick = () => { closeModal(); resolve([]); };
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

// effects.guess 「由对手回答该宝可梦的HP／名字／属性」: an answer of the asked kind. The HP values and names offered are those of every
// Pokémon in the release (never only the two decks of this game, which would show the opponent's deck).
const GUESS_TYPES = ['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal', 'Fairy', 'Dragon', 'Colorless'];
let guessPool = null;
function guessDomain() {
  if (guessPool) return guessPool;
  const names = new Map(), hps = new Set();
  for (const e of release.index.entries) if (e.card.kind === 'pokemon') {
    names.set(e.card.nameKey, e.card.name);
    if (e.card.hp) hps.add(e.card.hp);
  }
  guessPool = { names, hps: [...hps].sort((a, b) => a - b) };
  return guessPool;
}
function chooseGuess(prompt) {
  const { question, hint } = prompt.guess, { names, hps } = guessDomain();
  const told = hint?.nameKey ? t('guess.toldName', { n: hint.name }) :
    hint ? t('guess.toldAttacks', { a: hint.attackNames.map((a) => `「${a}」`).join('') }) : t('guess.toldNothing');
  const keys = new Map([...names].map(([key, name]) => [name, key]));
  return new Promise((resolve) => {
    openModal(() => {
      const word = (value, label) => `<button class="opt-word" data-v="${esc(value)}">${esc(label)}</button>`;
      const body = question === 'type' ? GUESS_TYPES.map((x) => word(x, t('type.' + x))).join('') :
        question === 'hp' ? hps.map((n) => word(n, `HP ${n}`)).join('') :
        `<input id="guess-name" list="guess-names" autocomplete="off" placeholder="${esc(t('guess.namePlaceholder'))}">
        <datalist id="guess-names">${[...names.values()].map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
        <button class="primary" id="guess-ok" disabled>${esc(t('guess.confirm'))}</button>`;
      return `<h2>${esc(prompt.title)}</h2><p>${esc(told)}</p><div class="choice-words">${body}</div>`;
    }, (body) => {
      body.querySelectorAll('[data-v]').forEach((b) => (b.onclick = () => {
        closeModal(); resolve({ guess: question === 'hp' ? { hp: Number(b.dataset.v) } : { type: b.dataset.v } });
      }));
      const input = body.querySelector('#guess-name'), ok = body.querySelector('#guess-ok');
      if (!input) return;
      input.oninput = () => { ok.disabled = !keys.has(input.value.trim()); };
      ok.onclick = () => {
        const key = keys.get(input.value.trim());
        if (!key) return;
        closeModal(); resolve({ guess: { name: key } });
      };
    }, 'sheet');
  });
}

function openModal(html, bind, cls = '') {
  inspect(null);
  pileShown = null;
  modalRenderer = { html, bind };
  $('#modal-body').className = `dialog ${cls}`.trim(); // 'sheet': a choice in the game, drawn like the card stages
  $('#modal-body').innerHTML = html();
  bind?.($('#modal-body'));
  $('#modal').hidden = false;
}
function closeModal() {
  inspect(null);
  pileShown = null;
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
    ${prompt.why.map((line) => `<div class="pz-why">${line.split(/(?<=：)/).map((part) => `<span>${esc(part)}</span>`).join('')}</div>`).join('')}
    <div class="cs-sub">${esc(t('prompt.prize.text'))}</div>
    <div class="pz-row" style="--n:${n}">${prompt.options.map((o, i) => `<button class="pz-card" data-id="${esc(o.id)}" style="--i:${i};--o:${(i - (n - 1) / 2).toFixed(2)}">
      <span class="pz-flip"><img class="pz-back" src="${o.card ? cardImage(o.card) : cardBack()}" alt=""><img class="pz-front" alt=""></span></button>`).join('')}</div>
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
    b.onmouseenter = () => !touching && b.showInfo();
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
// Gary's moves are made on the server (server/play.mjs): his level's AI, which uses only what he could know, or the CPU
// engine from his own view; an AI that fails hands the move to the CPU engine and the table says so. He takes about a
// second a move, however fast the answer comes.
let thinkingSince = 0;
function makeOpponent(myGame) {
  return {
    async decide() {
      if (myGame !== gameId) return stale();
      clearActions();
      if (pendingAnims.size) await Promise.all([...pendingAnims]);
      oppStatus('ui.thinking', {}, true);
      thinkingSince = performance.now();
      return { type: 'cpu' };
    },
  };
}

// The table on a game played on the server (remote-game.js): you are player 0, Gary player 1.
function newMatch(remote, myGame) {
  // The images of your deck (and of any card already shown), fetched in the background; the opponent's other cards only
  // as they are shown (image-preload.js).
  preloadImages([...remote.printings].map((id) => release.meta.cards[id]?.image));
  return new Match({ game: remote, catalog: remote.catalog, presentation: release.meta.cards, decks: remote.match.decks.map((d) => d.id),
    names: guessDomain().names, controllers: [new HumanController(myGame), makeOpponent(myGame)], hooks: gameHooks(myGame) });
}

// ---------------- Saved table (localStorage) ----------------
// The game itself is kept by the server: a reload asks it for the player's game still on (GET /api/play/current). The
// browser keeps only what the table showed around it — the log — saved before every decision. Each player on this
// browser has their own; watching a replay never touches it.
const saveKey = () => `cn-table-save-v3:${user.id}`;
function saveGame(g) {
  if (REPLAY || !(g.game instanceof RemoteGame)) return;
  try {
    localStorage.setItem(saveKey(), JSON.stringify({ releaseId: CN_RELEASE_ID, matchId: g.game.id,
      log: logEntries.filter((e) => !e.key?.startsWith('ui.restored')).slice(-400) }));
  } catch { /* storage full or unavailable: keep playing without it */ }
}
function clearSave() {
  if (REPLAY) return;
  try { localStorage.removeItem(saveKey()); } catch { /* ignore */ }
}
function loadSave(matchId) {
  try {
    const s = JSON.parse(localStorage.getItem(saveKey()));
    return s?.releaseId === CN_RELEASE_ID && s.matchId === matchId ? s : null;
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
  $('#start').hidden = true;
  $('#table').hidden = false;
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
    // The server records every move; the table shows how sure Gary's AI was, or that it failed.
    onDispatch: async ({ player, result }) => {
      if (myGame !== gameId || player !== OPP) return;
      const ai = result?.ai;
      if (ai?.error) log({ key: 'ui.aiError', params: { e: ai.error.slice(0, 120) }, kind: 'warn' });
      if (ai?.value != null) oppStatus('ui.oppConfidence', { p: pct(ai.value) });
      else if (oppState.thinking) oppStatus();
      await sleep(Math.max(300, 1000 - (performance.now() - thinkingSince)));
    },
    onError: (err) => {
      if (myGame !== gameId) return;
      log({ key: 'ui.rejected', params: { e: err.message }, kind: 'warn' });
    },
    onCheckpoint: (g) => {
      if (myGame !== gameId) return;
      saveGame(g);
      recorder?.flush();
    },
    onGameOver: (g) => {
      if (myGame !== gameId) return;
      clearSave();
      recorder?.flush();
      gameOver(g);
    },
  };
}

const deckList = (deck) => deck.cards.flatMap(([id, n]) => Array(n).fill(id));

// The browser's catalog of a game: the reviewed release's printings it has seen (remote-game.js), from its own deck.
const remoteOptions = { catalogFor: (ids) => release.session.catalogFor(ids),
  own: (match) => (release.decks[match.decks[0]?.id] ? deckList(release.decks[match.decks[0].id]) : []) };

// The game loop on the table. When it stops on an error (the server cannot be reached, say), the table says so; the
// game stays on the server and a reload picks it up again.
function playOn(match, options) {
  return match.run(options).catch((err) => {
    if (match !== game) return;
    log({ key: 'ui.connection', params: { e: err.message }, kind: 'warn' });
    recordError(err.message, err.stack);
  });
}

async function startGame(deckId) {
  const myGame = ++gameId;
  const mine = release.decks[deckId];
  // The server deals every game from a fresh random seed. ?seed=a,b,c,d (tests: administrators, or any player on a test
  // server) fixes the first game's: a new game in the same page must not deal the same decks again.
  const seedParam = params.get('seed');
  if (seedParam) {
    params.delete('seed');
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}${location.hash}`);
  }
  // The deck's cards are checked against the reviewed release before the server deals: a damaged download starts nothing.
  await release.session.catalogFor(deckList(mine));
  const remote = await RemoteGame.start({ deck: deckId, opponent: oppChoice, level: newLevel(),
    ...(seedParam ? { seed: seedParam.split(',').map(Number) } : {}) }, remoteOptions);
  if (myGame !== gameId) return;
  clearSave();
  undoStack = [];
  debugEdits = [];
  logEntries = [];
  renderLog();
  resetTable();
  animateDraws = true;
  recorder = new MatchRecorder({ id: remote.id });
  matchLevel = remote.match.level;
  game = newMatch(remote, myGame);
  applyEngine(engine);
  const [a, b] = remote.match.decks;
  log({ key: 'log.decks', params: { a: a.name, b: b.name }, kind: 'sys' });
  log(matchLevel ? { key: 'log.level', params: { n: levelName(matchLevel) }, kind: 'sys' } : { key: 'log.levelCpu', params: {}, kind: 'sys' });
  const quality = implementationSummary(remote.catalog, deckList(mine));
  if (quality.machinePrintings.length) log({ key: 'log.machineCards', params: { n: quality.machinePrintings.length }, kind: 'warn' });
  log({ key: 'log.match', params: { id: remote.id }, kind: 'sys' });
  render();
  await playOn(game);
}

// The game on the server picks up again: after a reload (its saved log when this browser kept it), after one of your
// moves is taken back, or after an administrator's edit (the view starts again).
async function resumeGame(remote, save = null, { note = { key: 'ui.restored', params: {} } } = {}) {
  const myGame = ++gameId;
  recorder = new MatchRecorder({ id: remote.id });
  // (The Professor's words, kind 'coach', in a log saved before he was retired are dropped.)
  logEntries = (save?.log || []).filter((e) => !e.key?.startsWith('ui.restored') && e.kind !== 'coach');
  resetTable();
  matchLevel = remote.match.level;
  game = newMatch(remote, myGame);
  applyEngine(engine);
  log({ kind: 'sys', ...note });
  renderLog();
  render();            // restored hand appears in place, without the draw animation
  animateDraws = true;
  await playOn(game, { resume: true });
}

// ---------------- Replay (?replay=<match id>[&at=<move>]) ----------------
// A recorded game played again on the kernel from its setup and its moves (replay.js), with the table's animations and
// from the side of the table its player saw. Play or pause, go a move forward or back (← / →), or jump to a move;
// ?at=<n> opens the replay paused at move n. Move n is the game after the record's first n moves (kernel revision n),
// as bug reports and npm run match -- show --at number them. Nothing is saved or recorded, unless the game is taken
// over (takeOver). Going back restores a kept state and plays on from it without animations: every CHECKPOINT-th state
// is kept, and the last RECENT ones reached (late in a game a move takes the kernel 0.1–0.2 s and a state is several
// hundred KB).
const CHECKPOINT = 5, RECENT = 8;
const replayCtl = { paused: false, delay: 700, queue: [], wake: null };
// The replay on the table: the record and its moves, the move on view (pos) and the last one the kernel can reach (end),
// the state hash this build makes after each move, and the kept states (JSON, with the log as it stood there).
let rp = null;

// The next command: one from the controls, or (while playing) the next move once the delay is over.
async function replayCommand() {
  for (;;) {
    if (replayCtl.queue.length) return replayCtl.queue.shift();
    const playing = !replayCtl.paused && rp.pos < rp.end;
    const woken = await new Promise((r) => {
      replayCtl.wake = () => r(true);
      if (playing) sleep(replayCtl.delay).then(() => r(false));
    });
    replayCtl.wake = null;
    if (!woken && !replayCtl.paused && !replayCtl.queue.length) return { step: true };
  }
}
// A command from the controls ({step} a move forward, {back} a move back, {to: n}, {takeover}) pauses the replay. The
// commands run one at a time, each once the move before it is done.
function replaySend(cmd) {
  replayCtl.paused = true;
  replayCtl.queue.push(cmd);
  replayCtl.wake?.();
  replayShow();
}

// The replay's table on a kernel state: the table's animations, no players to ask, nothing recorded.
function replayTable(kernel) {
  resetTable();
  game = new Match({ game: kernel, catalog: rp.catalog, presentation: release.meta.cards, decks: rp.setup.decks.map((d) => d.id),
    controllers: [], names: guessDomain().names,
    hooks: { ...gameHooks(rp.myGame), onDispatch: null, onError: null, onCheckpoint: null, onGameOver: null, onMoveDone: null } });
}

// Plays the move after the one on view; false when the kernel refuses it, which ends the replay there. Each move reached
// notes the state hash this build makes (a record that no longer matches says so once) and may be kept for going back.
async function replayMove() {
  const m = rp.moves[rp.pos], n = rp.pos + 1;
  try {
    if (m.type === 'edit') {
      // An administrator's console edit: the table takes the state it produced (a card may now be another card).
      game.game = applyEdit(game.game, m, game.catalog);
      game.known.clear(); game.cards.clear();
      game.build(game.game.view(ME));
      log({ key: 'replay.edit', params: { n, c: m.command }, kind: 'warn' });
    } else await game.apply(m.player, m.revision, m.action);
  } catch { /* refused: below */ }
  if (rp.myGame !== gameId) return false;
  const snapshot = game.game.snapshot();
  if (snapshot.revision !== m.revision + 1) {
    rp.end = rp.pos;
    log({ key: 'replay.failed', params: { n }, kind: 'warn' });
    return false;
  }
  rp.pos = n;
  rp.hashes[n] = stateHash(snapshot);
  if (m.hash && rp.hashes[n] !== m.hash && rp.diverged === null) {
    rp.diverged = n;
    log({ key: 'replay.diverged', params: { n }, kind: 'warn' });
  }
  if (n === rp.moves.length) {
    if (game.winner) log({ text: game.winReason.text, kind: 'win' });
    log({ key: 'replay.end', params: {}, kind: 'sys' });
  }
  replayKeep(snapshot);
  return true;
}
// The next move, animated (an edit has no animation: the table just shows the state it produced).
async function replayStep() {
  if (rp.pos >= rp.end) return;
  const edit = rp.moves[rp.pos].type === 'edit';
  if (await replayMove() && edit) render();
}
function replayKeep(snapshot) {
  const n = rp.pos, kept = { n, text: JSON.stringify(snapshot), log: logEntries.slice() };
  if (n % CHECKPOINT === 0) rp.kept.set(n, kept);
  else rp.recent = [...rp.recent.filter((r) => r.n !== n), kept].slice(-RECENT);
}

// Jumps to move `target` without animations: from the nearest kept state at or before it when going back (or when that
// is nearer than the move on view), then forward a move at a time. Another command stops it where it got to.
async function replayJump(target) {
  const to = Math.max(0, Math.min(Number.isFinite(target) ? Math.trunc(target) : rp.pos, rp.end));
  if (to === rp.pos) return;
  if (pendingAnims.size) await Promise.all([...pendingAnims]);
  const from = [...rp.kept.values(), ...rp.recent].filter((k) => k.n <= to).reduce((a, b) => (b.n > a.n ? b : a));
  if (to < rp.pos || from.n > rp.pos) {
    replayTable(OfficialGame.restore(JSON.parse(from.text), { catalog: rp.catalog }));
    rp.pos = from.n;
    logEntries = from.log.slice();
    renderLog();
  }
  const hooks = game.hooks;
  game.hooks = { onLog: log }; // the moves' log lines, no animations
  try {
    while (rp.pos < to && rp.myGame === gameId && !replayCtl.queue.length) {
      replayShow(to);
      await sleep(0); // let the page show how far it got
      if (!await replayMove()) break;
    }
  } finally {
    game.hooks = hooks;
  }
  if (rp.myGame !== gameId) return;
  resetTable();
  animateDraws = false; // the board as it stands, no cards flying in
  render();
  animateDraws = true;
}

// jumping: the move a jump is on its way to.
function replayShow(jumping = null) {
  if (!rp || !$('#rp-progress')) return;
  const total = rp.moves.length, at = $('#rp-at');
  $('#rp-progress').textContent = jumping === null ? t('replay.progress', { n: rp.pos, total }) : t('replay.jumping', { n: jumping, at: rp.pos });
  $('#rp-play').innerHTML = `${icon(replayCtl.paused ? 'play' : 'pause')} ${esc(t(replayCtl.paused ? 'replay.play' : 'replay.pause'))}`;
  $('#rp-play').disabled = $('#rp-step').disabled = rp.pos >= rp.end;
  $('#rp-back').disabled = rp.pos === 0;
  $('#rp-takeover').disabled = jumping !== null || !!game?.winner;
  if (document.activeElement !== at) at.value = rp.pos; // a number past the end goes to the last move (replayJump)
  $('#rp-note').textContent = [rp.end < total ? t('replay.stopped', { n: rp.end + 1 }) : '',
    rp.diverged ? t('replay.differs', { n: rp.diverged }) : ''].filter(Boolean).join(' ');
}

const replayWho = () => [t('replay.who', { u: rp.match.username, d: new Date(rp.match.createdAt).toLocaleString('zh-CN') }),
  rp.setup.takeover ? t('replay.from', { id: rp.setup.takeover.match, n: rp.setup.takeover.move }) : ''].filter(Boolean).join(' ');
// The replay's controls sit in the bar between the mats, where your moves' tips are in a game: whose game it is, where
// the replay is, a move back or forward, jumping to a move, taking the game over from here.
function replayBar() {
  const { match, setup } = rp;
  const who = replayWho();
  clearActions();
  $('#hint').innerHTML = `<div class="replay-bar">
    <b class="rp-title" title="${esc(who)}">${esc(t('replay.panel', { id: match.id }))}</b>
    <span class="replay-progress" id="rp-progress"></span>
    <button class="mid-btn" id="rp-back" title="${esc(t('replay.backTitle'))}">${icon('skip-back')} ${esc(t('replay.back'))}</button>
    <button class="mid-btn primary" id="rp-play"></button>
    <button class="mid-btn" id="rp-step" title="${esc(t('replay.stepTitle'))}">${icon('skip-forward')} ${esc(t('replay.step'))}</button>
    <select id="rp-speed" aria-label="${esc(t('replay.speed'))}">${[[1600, 'replay.slow'], [700, 'replay.normal'], [150, 'replay.fast']]
      .map(([ms, k]) => `<option value="${ms}" ${ms === replayCtl.delay ? 'selected' : ''}>${esc(t(k))}</option>`).join('')}</select>
    <form id="rp-jump">
      <label>${esc(t('replay.jumpTo'))} <input type="number" id="rp-at" min="0" step="1" required> ${esc(t('replay.jumpUnit'))}</label>
      <button class="mid-btn">${esc(t('replay.jump'))}</button>
    </form>
    <button class="mid-btn" id="rp-takeover" title="${esc(t('replay.takeoverTitle'))}">${icon('swords')} ${esc(t('replay.takeover'))}</button>
    <a class="replay-exit" href="./">${esc(t('replay.exit'))}</a>
    <span class="replay-note" id="rp-note"></span>
  </div>`;
  $('#rp-play').onclick = () => { replayCtl.paused = !replayCtl.paused; replayShow(); replayCtl.wake?.(); };
  $('#rp-step').onclick = () => replaySend({ step: true });
  $('#rp-back').onclick = () => replaySend({ back: true });
  $('#rp-jump').onsubmit = (e) => { e.preventDefault(); $('#rp-at').blur(); replaySend({ to: Number($('#rp-at').value) }); };
  $('#rp-speed').onchange = (e) => { replayCtl.delay = Number(e.target.value); };
  $('#rp-takeover').onclick = () => replaySend({ takeover: true });
  replayShow();
}
// ← / →: a move back or forward, unless you are typing or a dialog is open.
document.addEventListener('keydown', (e) => {
  if (!rp || e.altKey || e.ctrlKey || e.metaKey || e.target.closest?.('input, textarea, select')
    || [...document.querySelectorAll('.overlay')].some((o) => !o.hidden)) return;
  const button = { ArrowLeft: $('#rp-back'), ArrowRight: $('#rp-step') }[e.key];
  if (button && !button.disabled) { e.preventDefault(); button.click(); }
});

async function watchReplay(id) {
  const myGame = ++gameId;
  const { match, steps } = await apiJSON(`/api/matches/${encodeURIComponent(id)}`);
  const setup = match.setup;
  if (setup.releaseId !== CN_RELEASE_ID) throw new Error(t('replay.release', { r: setup.releaseId }));
  const { moves, problems } = effectiveMoves(steps);
  const { game: kernel, catalog, approval, compatibility } = await newGame({ release: release.session, setup });
  if (myGame !== gameId) return;
  rp = { match, setup, moves, catalog, approval, myGame, pos: 0, end: moves.length, hashes: [], kept: new Map(), recent: [], diverged: null };
  logEntries = [];
  renderLog();
  replayTable(kernel);
  animateDraws = true;
  log({ text: replayWho(), kind: 'sys' });
  log({ key: 'log.decks', params: { a: setup.decks[0].name, b: setup.decks[1].name }, kind: 'sys' });
  log({ text: START_SHUFFLE, kind: 'sys' });
  if (compatibility.manifestChanged) log({ key: 'ui.manifestUpdated', kind: 'sys' });
  for (const e of kernel.view(ME).events) { const text = game.eventLine(e); if (text) log({ text, kind: 'sys' }); }
  if (problems.length) log({ key: 'replay.problems', params: { n: problems.length }, kind: 'warn' });
  if (!moves.length) log({ key: 'replay.end', params: {}, kind: 'sys' });
  render();
  replayKeep(kernel.snapshot());
  const at = params.get('at');
  if (at !== null) replaySend({ to: Number(at) });
  replayBar();
  for (;;) {
    const cmd = await replayCommand();
    if (myGame !== gameId) return;
    if (cmd.takeover) {
      // Taken over, the page goes to the new game: nothing more happens here (not even the address below).
      if (await takeOver().catch((err) => log({ key: 'takeover.failed', params: { e: err.message }, kind: 'warn' }))) return;
    } else if (cmd.step) await replayStep();
    else await replayJump(cmd.back ? rp.pos - 1 : cmd.to);
    if (myGame !== gameId) return;
    if (rp.pos >= rp.end) replayCtl.paused = true;
    replayShow();
    // The address follows the move on view: a reload, or the page a bug report keeps, opens the replay there.
    const url = new URL(location.href);
    url.searchParams.set('at', String(rp.pos));
    history.replaceState(null, '', url);
  }
}

// ---------------- 从这一步接管 ----------------
// The replay on view becomes your game from the move on view: the server plays the moves so far again as a new game (a
// new match number, POST /api/play/takeover), and the table plays on from there — you as player 0, 小茂 as player 1 — so
// a fix can be tried at the very move a problem was reported. The new record notes where it came from (setup.takeover);
// the replayed one is not touched. Your game still on gives way, its record marked abandoned; the page then picks up
// the new game the way it resumes one after a reload. Runs as a replay command, so no move is under way meanwhile;
// true once the page is on its way to the new game.
async function takeOver() {
  const n = rp.pos, moves = rp.moves.slice(0, n);
  if (moves.some((m) => m.type === 'edit') && user.role !== 'admin') throw new Error(t('takeover.edits'));
  if (game.winner) return false;
  const live = await apiJSON('/api/play/current').then((r) => r.match, () => null);
  if (!await confirmDialog(t('takeover.confirm', { id: rp.match.id, n }) + (live ? t('takeover.replaces') : ''), { ok: t('takeover.ok') })) return false;
  $('#rp-takeover').disabled = true;
  // The server plays the record again up to here as your new game (it abandons the one you had going).
  const { match } = await apiJSON('/api/play/takeover', { method: 'POST', body: { match: rp.match.id, move: n } });
  localStorage.setItem(saveKey(), JSON.stringify({ releaseId: CN_RELEASE_ID, matchId: match.id, log: logEntries.slice(-400), coach: null, win: null,
    takeover: { match: rp.match.id, move: n } }));
  location.href = './';
  return true;
}

// ---------------- 报告问题 ----------------
// A problem in the player's words, kept by the server (its bug-report directory) with what is needed to see it again:
// the game's whole record, the move on the table when the button was pressed (the replay's position, or the live game's
// revision: ?replay=<id>&at=<move> shows it again), the kernel state (a live game's from the server) and the log as
// shown. The button stays above the table's own overlays (style.css), so a choice window can be reported while open.
const REPORT_TEXT_MAX = 4000, REPORT_LOG = 400;
function reportBug() {
  if (rp) { replayCtl.paused = true; replayShow(); } // the replay stays where the problem was seen
  // A replay's state is the browser's own (a finished game); a game on the server sends none: the server adds its own.
  const remote = game?.game instanceof RemoteGame ? game.game : null;
  const state = game && !remote ? game.game.snapshot() : null;
  const at = { matchId: rp?.match.id ?? remote?.id ?? null, replay: !!rp, move: remote ? remote.status.revision : state?.revision ?? null,
    turn: game?.turn ?? null, log: logEntries.slice(-REPORT_LOG).map((e) => e.text ?? t(e.key, e.params)), ...(state && { state }) };
  dialog(`<h2>${icon('flag')} ${esc(t('report.title'))}</h2>
    <form class="acct-form report-form">
      <p class="hint">${esc(at.matchId ? t('report.hint', { id: at.matchId, n: at.move }) : t('report.hintNoRecord'))}</p>
      <textarea name="text" rows="6" maxlength="${REPORT_TEXT_MAX}" required aria-label="${esc(t('report.title'))}"
        placeholder="${esc(t('report.placeholder'))}"></textarea>
      <p class="form-error" role="alert"></p>
      <div class="row"><button type="button" data-act="no">${esc(t('ui.cancel'))}</button><button class="primary">${esc(t('report.send'))}</button></div>
    </form>`, (box, close) => {
    const form = box.querySelector('form'), send = form.querySelector('button.primary');
    // Typing goes to the text only, not to the table's own keys (H / T at the coin call, ← / → in a replay).
    form.text.onkeydown = (e) => { if (e.key !== 'Escape') e.stopPropagation(); };
    box.querySelector('[data-act="no"]').onclick = close;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const description = form.text.value.trim();
      if (!description) return;
      send.disabled = true;
      try {
        if (!rp) await recorder?.flush(); // the browser's errors so far go with the record
        const { report } = await apiJSON('/api/bug-reports', { method: 'POST', body: { description, ...at, page: location.href } });
        log({ key: 'log.report', params: { r: report.id }, kind: 'sys' });
        box.innerHTML = `<h2>${icon('flag')} ${esc(t('report.title'))}</h2><p>${esc(t('report.saved', { r: report.id }))}</p>
          <div class="row"><button class="primary" data-act="ok">${esc(t('ui.close'))}</button></div>`;
        box.querySelector('[data-act="ok"]').onclick = close;
        box.querySelector('[data-act="ok"]').focus();
      } catch (err) {
        form.querySelector('.form-error').textContent = err.message;
        send.disabled = false;
      }
    };
  });
}
$('#btn-report').onclick = reportBug;

// ---------------- 调试台 (administrators) ----------------
// Commands that rewrite the game in progress (debug-console.js) and their panel (debug-panel.js). An edit is applied the
// way an undo is: the table restores the new state and play goes on from there. The record keeps the command and the
// full state it produced, so a replay passes through the same edit.
let debugPanel = null;
let debugEdits = []; // {before, after}: the states around each edit, for /revert
// The administrator's copy of the game's whole state (GET /api/play/:id/state), on a kernel in this browser for the
// panel's views; fetched again whenever the game has moved on. An edit is the copy at once, so the next command works
// on it while the server is still taking the edit (debugSending: one at a time, in order).
let debugMirror = null, debugLoading = null, debugSending = Promise.resolve(), debugInFlight = 0;
const mirrorOf = (matchId, snapshot, catalog) => ({ matchId, revision: snapshot.revision, snapshot, catalog,
  game: OfficialGame.restore(structuredClone(snapshot), { catalog }) });
async function loadDebugMirror(remote) {
  const { snapshot } = await apiJSON(`/api/play/${remote.id}/state`);
  const catalog = await release.session.catalogFor([...new Set(Object.values(snapshot.cards).map((c) => c.printingId))].sort());
  if (!debugInFlight) debugMirror = mirrorOf(remote.id, snapshot, catalog);
}
function debugState() {
  const remote = game?.game instanceof RemoteGame && !REPLAY ? game.game : null;
  if (!remote) return null;
  const stale = debugMirror?.matchId !== remote.id || (!debugInFlight && debugMirror.revision !== remote.status.revision);
  if (stale) {
    debugLoading ??= loadDebugMirror(remote).then(() => debugPanel?.refresh(), () => {}).finally(() => { debugLoading = null; });
    if (debugMirror?.matchId !== remote.id) return null;
  }
  const m = debugMirror;
  return { snapshot: m.snapshot, catalog: m.catalog, matchId: m.matchId, view: (p) => m.game.view(p), current: !stale };
}
// A command waits for the copy of the game's state when it is being fetched.
async function runDebug(text) {
  let st = debugState();
  if (!st?.current) {
    await debugLoading;
    st = debugState();
  }
  if (!st) throw new Error('没有进行中的对局。');
  if (!st.current) throw new Error('局面正在更新，请稍后再试。');
  const r = runCommand(text, st);
  if (r.ui === 'export') {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(st.snapshot, null, 1)], { type: 'application/json' }));
    a.download = `match-${st.matchId ?? 'local'}-rev${st.snapshot.revision}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return { lines: [`已下载 ${a.download}（revision ${st.snapshot.revision}）。`] };
  }
  if (r.ui === 'revert') {
    const last = debugEdits.at(-1);
    if (!last) throw new Error('这局还没有调试修改可以撤销。');
    if (last.after !== st.snapshot.revision) throw new Error('上一次修改之后已经有新的操作，不能撤销（可以再用命令改回去）。');
    debugEdits.pop();
    applyDebugState(last.before, st.catalog, text, ['已撤销上一次调试修改。'], { rewind: true });
    return { lines: ['已撤销上一次调试修改。'] };
  }
  if (r.state) {
    debugEdits.push({ before: st.snapshot, after: r.state.revision });
    applyDebugState(r.state, st.catalog, text, r.lines);
  }
  return r;
}
// The server records the edit (rewind: back to an earlier state, /revert, recorded as a rewind) and the table picks the
// game up again from it. One the server refuses (the game had moved on) is dropped: the panel reloads the game's state.
function applyDebugState(state, catalog, command, lines, { rewind = false } = {}) {
  undoStack = [];
  const remote = game.game;
  debugMirror = mirrorOf(remote.id, state, catalog);
  debugInFlight++;
  debugSending = debugSending
    .then(() => apiJSON(`/api/play/${remote.id}/state`, { method: 'POST', body: { state, command, lines, revert: rewind } }))
    .then((r) => remote.absorb(r))
    .then(() => { resumeGame(remote, { log: logEntries }, { note: { key: 'log.debug', params: { c: command }, kind: 'warn' } }); },
      (err) => { debugMirror = null; debugEdits = []; log({ key: 'ui.rejected', params: { e: err.message }, kind: 'warn' }); })
    .finally(() => { debugInFlight--; debugPanel?.refresh(); });
}
function mountDebug() {
  debugPanel = mountDebugPanel({ state: debugState, run: runDebug, imageOf: (id) => cardImage({ img: release.meta.cards[id]?.image }) });
  const b = document.createElement('button');
  b.id = 'btn-debug';
  b.title = t('ui.debugTitle');
  b.innerHTML = `${icon('wrench')} <span>${esc(t('ui.debug'))}</span>`;
  b.onclick = () => debugPanel.toggle();
  $('#btn-report').before(b); // in the header, beside 报告问题
}

// ---------------- Undo ----------------
// A learning aid (real games have no take-backs): you can undo your own moves within the current turn, as long as
// they revealed nothing new — putting a Pokémon on the Bench, evolving, attaching Energy. The server says which moves
// were quiet and takes them back (server/play.mjs); any other move clears the list.
let undoStack = [];

function rememberForUndo(g, a) {
  if (!['energy', 'bench', 'evolve'].includes(a.kind)) { undoStack = []; return; }
  if (undoStack.length && undoStack.at(-1).turn !== g.turn) undoStack = [];
  undoStack.push({ logLen: logEntries.length, label: a.label, turn: g.turn });
}

// The server takes the move back (it allows only your quiet moves of this turn) and the table picks the game up again.
async function undoLast() {
  const u = undoStack.pop();
  if (!u || !game || game.current?.idx !== ME) return;
  const remote = game.game;
  try {
    await remote.undo();
  } catch (err) {
    undoStack = [];
    log({ key: 'ui.rejected', params: { e: err.message }, kind: 'warn' });
    render();
    return;
  }
  resumeGame(remote, { log: logEntries.slice(0, u.logLen) }, { note: { key: 'log.undo', params: { a: { $t: u.label } } } });
}

function undoButton() {
  const u = undoStack.at(-1);
  if (!u || !game || u.turn !== game.turn || game.current?.idx !== ME || !game.game.undoable) return '';
  return `<button class="undo-btn" id="undo-btn" title="${esc(`${t('ui.undo', { a: { $t: u.label } })}\n${t('tip.undo')}`)}">${icon('rotate-ccw')} ${esc(t('ui.undoShort'))}</button>`;
}

function gameOver(g) {
  decision = null;
  clearActions();
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

function describeDeck(d, entries) {
  const stats = { pokemon: 0, trainer: 0, energy: 0 }, types = new Map(), mons = [];
  for (const [id, n] of d.cards) {
    const def = entries.get(id).card, m = def;
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
  // Its 打法要点 (a pool deck's, checked) or 打法说明 (your own deck's): what the language model reads too.
  const book = d.user ? d.strategy : release.playbooks.has(d.id);
  const link = book ? ` <button class="linkish" id="deck-playbook">${icon('book-open')} ${esc(t(d.user ? 'pb.mine' : 'pb.link'))}</button>` : '';
  if (d.user) return `${esc(t('src.mine', { d: d.name }))}<a href="decks.html?id=${d.user}">${esc(t('src.mineEdit'))}</a>${link}`;
  return `${esc(t('src.title', { d: d.name }))}${d.sources.map((s, i) => `${i ? '；' : ''}${s.url
    ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(sourceLabel(s))}</a>` : esc(sourceLabel(s))}`).join('')}${link}`;
}

// A deck's 打法要点: the sections and points the language model reads, each point with its sources; or the 打法说明
// you wrote for a deck of yours.
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
async function openPlaybook(d) {
  $('#playbook-title').textContent = t(d.user ? 'pb.mineTitle' : 'pb.title', { d: d.name });
  $('#playbook').hidden = false;
  $('#playbook .dialog').focus();
  const body = $('#playbook-body');
  if (d.user) {
    body.innerHTML = `<p class="pb-note">${esc(t('pb.mineNote'))}</p><div class="pb-mine">${esc(d.strategy)}</div>`;
    return;
  }
  body.innerHTML = `<p class="pb-note">${esc(t('pb.loading'))}</p>`;
  try {
    const { playbook } = await apiJSON(`/api/playbooks?deck=${encodeURIComponent(d.id)}`);
    body.innerHTML = `<p class="pb-note">${esc(t('pb.note', { c: playbook.checkedOn }))}</p>` + playbook.sections.map((s) => `<section class="pb-sec">
      <h3>${esc(s.title)}</h3><ul>${s.points.map((x) => `<li>${esc(x.text)}${x.src?.length ? ` <span class="pb-src">${x.src.map((u) =>
        `<a href="${esc(u)}" target="_blank" rel="noopener" title="${esc(u)}">${esc(hostOf(u))}</a>`).join('')}</span>` : ''}</li>`).join('')}</ul></section>`).join('');
  } catch (err) {
    body.innerHTML = `<p class="load-error">${esc(t('pb.failed', { e: err.message }))}</p>`;
  }
}
$('#playbook-close').onclick = () => { $('#playbook').hidden = true; };
$('#playbook').onclick = (e) => { if (e.target.id === 'playbook') $('#playbook').hidden = true; };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#playbook').hidden) $('#playbook').hidden = true; });

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
  $('#deck-playbook')?.addEventListener('click', () => openPlaybook(release.decks[selectedDeck]));
  $('#btn-start').disabled = !selectedDeck;
  $('#btn-start').innerHTML = selectedDeck ? esc(t('ui.start')) : esc(t('ui.pickFirst'));
}

function openStart() {
  // ?deck=<id> (我的卡组 → 对战) picks that deck.
  if (!selectedDeck && release.decks[params.get('deck')]) selectedDeck = params.get('deck');
  renderDeckChoices();
  $('#start').hidden = false;
}

$('#opt-llm-coach').onchange = renderDecision;
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
  $('#deck-choices').insertAdjacentHTML('afterbegin', `<p class="load-error">${esc(t('ui.loadFailed', { e: err.message }))}</p>`);
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
  if (game?.game instanceof RemoteGame && !game.winner) game.game.abandon().catch(() => {});
  recorder = null;
  debugEdits = [];
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
for (const id of ['opt-llm-coach', 'opt-anim']) {
  try { const v = localStorage.getItem(id); if (v != null) $('#' + id).checked = v === '1'; } catch { /* storage unavailable */ }
  $('#' + id).addEventListener('change', (e) => { try { localStorage.setItem(id, e.target.checked ? '1' : '0'); } catch { /* ignore */ } });
}
$('#btn-rules').onclick = $('#start-rules').onclick = () => { $('#rules').hidden = false; };
$('#rules-close').onclick = () => { $('#rules').hidden = true; };
$('#rules').onclick = (e) => { if (e.target.id === 'rules') $('#rules').hidden = true; };

// For browser tests: your own player view, exactly what the table may show you (never the full game state).
window.__cnTable = { view: () => game?.game.view(ME) ?? null, release: () => release?.meta.releaseId ?? null, saveKey,
  matchId: () => (game?.game instanceof RemoteGame ? game.game.id : null), replay: () => rp && { id: rp.match.id, pos: rp.pos, end: rp.end, total: rp.moves.length },
  preload: preloadState };

// A browser error during a game goes into its record; what is still unsent goes out when the page closes.
const recordError = (message, stack) => recorder?.add({ type: 'error', message: String(message).slice(0, 1000), stack: String(stack ?? '').slice(0, 4000) });
window.addEventListener('error', (e) => recordError(e.message, e.error?.stack));
window.addEventListener('unhandledrejection', (e) => recordError(e.reason?.message ?? e.reason, e.reason?.stack));
window.addEventListener('pagehide', () => recorder?.flushOnExit());

// ---------------- Startup ----------------
// The reviewed release is verified against the installed trust pin before anything is shown (WebCrypto, which needs
// HTTPS or localhost).
async function loadRelease() {
  const [session, meta] = await Promise.all([openCNRelease(), fetch(DATA + 'decks.json').then((r) => {
    if (!r.ok) throw new Error(`decks.json: HTTP ${r.status}`);
    return r.json();
  })]);
  if (meta.releaseId !== CN_RELEASE_ID) throw new Error(t('ui.releaseMismatch'));
  const index = await session.index(), entries = new Map(index.entries.map((e) => [e.printingId, e]));
  release = { session, index, meta, cpu: null, cpuFor: null,
    decks: Object.fromEntries(meta.decks.map((d) => [d.id, describeDeck(d, entries)])) };
  // The player's saved decks; the server checked them with the same deck-check.js, and only legal ones can be played.
  const mine = (await apiJSON('/api/decks')).decks;
  for (const d of mine.filter((x) => x.legal)) {
    const id = `user:${d.id}`, saved = new Date(d.updatedAt).toLocaleDateString('zh-CN');
    release.decks[id] = describeDeck({ id, user: d.id, name: d.name, format: formatRef(session, d.format), sources: [], cards: d.cards,
      strategy: d.strategy ?? '', description: t('mine.desc', { f: t('deckgroup.' + d.format), d: saved }) }, entries);
  }
  release.drafts = mine.length - mine.filter((x) => x.legal).length;
  // The pool decks with checked 打法要点 (an older server has none).
  release.playbooks = new Set((await apiJSON('/api/playbooks').catch(() => ({ decks: [] }))).decks);
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
  if (user.role === 'admin' && !REPLAY) mountDebug();
  // Know which engine Gary uses before a saved game picks up again (until then he uses the CPU engine).
  await Promise.race([refreshEngine(), new Promise((r) => setTimeout(r, 1500))]);
  if (REPLAY) watchReplay(REPLAY).catch((err) => {
    $('#table').hidden = true;
    $('#start').hidden = false;
    $('#deck-choices').innerHTML = `<p class="load-error">${esc(t('replay.loadFailed', { e: err.message }))} <a href="./">${esc(t('replay.exit'))}</a></p>`;
  });
  // The player's game still on, kept by the server, picks up again (a game just taken over from a replay too).
  else RemoteGame.current(remoteOptions).then((remote) => {
    if (!remote) { openStart(); return; }
    const saved = loadSave(remote.id);
    return resumeGame(remote, saved, saved?.takeover ? { note: { key: 'log.takeover', params: { from: saved.takeover.match, n: saved.takeover.move, id: remote.id } } } : {});
  }).catch((err) => {
    openStart();
    $('#deck-choices').insertAdjacentHTML('afterbegin', `<p class="load-error">${esc(t('ui.resumeFailed', { e: err.message }))}</p>`);
  });
} catch (err) {
  const secure = window.isSecureContext && crypto?.subtle;
  $('#deck-choices').innerHTML = `<p class="load-error">${esc(t(secure ? 'ui.loadFailed' : 'ui.insecure', { e: err.message }))}</p>`;
  $('#btn-start').disabled = true;
  $('#btn-start').textContent = t('ui.pickFirst');
}
