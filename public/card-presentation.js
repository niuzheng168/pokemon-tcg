// Presentation only. Never write translated names into engine cards, effects or saves.
import catalog from './data/locales/zh-CN.js';

export const CHINESE_CARDS = catalog.cards;
export const CARD_ATTRIBUTION = catalog.attribution;
const normalize = (value) => String(value ?? '').normalize('NFKC').replaceAll('’', "'").replaceAll('é', 'e').toLowerCase().trim().replace(/\s+/g, ' ');
const escapeRE = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = { ...catalog.words };
// A card called "Set" is not the English word for every expansion. Likewise,
// TAG TEAM is a printed rule label, not a similarly named card's translation.
delete words.set;
words['tag team'] = 'TAG TEAM';
const cache = new Map();
// Longest term first, with ASCII boundaries: "Mew" must not change "Mewtwo".
const terms = Object.keys(words).filter((key) => key.length > 1).sort((a, b) => b.length - a.length);
const pattern = new RegExp(terms.map((term) => escapeRE(term).replaceAll('e', '[eé]').replaceAll("'", "['’]")).join('|'), 'gi');

export function chineseTerm(value) {
  const text = String(value ?? '');
  const key = normalize(text);
  if (words[key]) return words[key];
  if (cache.has(text)) return cache.get(text);
  const result = text.split(/(<[^>]*>)/g).map((part) => part.startsWith('<') ? part
    : part.replace(pattern, (match, offset, input) => {
      if (/[a-z0-9]/i.test(input[offset - 1] || '') || /[a-z0-9]/i.test(input[offset + match.length] || '')) return match;
      return words[normalize(match)] || match;
    })).join('');
  if (cache.size > 4096) cache.clear();
  cache.set(text, result);
  return result;
}

export function chineseCardName(card) {
  return catalog.cards[card.id]?.name || chineseTerm(card.name);
}

export function chineseAttackName(card, index) {
  return catalog.cards[card.id]?.attacks[index]?.name || chineseTerm(card.attacks?.[index]?.name);
}

export function chinesePowerName(card) {
  return catalog.cards[card.id]?.power || chineseTerm(card.power?.name);
}

const CLASSIC_DECKS = {
  ash: '小智的卡组', brock: '小刚的卡组', misty: '小霞的卡组',
  brushfire: '烈火草原', overgrowth: '繁茂生长', zap: '电光闪动', blackout: '黑暗降临',
  'water-blast': '水流冲击', 'power-reserve': '能量储备', lockdown: '封锁',
  bodyguard: '护卫', 'grass-chopper': '草木斩击', 'hot-water': '火热水流',
  'lightning-bug': '雷电虫群', 'psych-out': '精神战术', thunderstorm: '雷暴',
  devastation: '火箭队·破坏', trouble: '火箭队·麻烦',
  'gym-brock': '小刚道馆', 'gym-misty': '小霞道馆', 'lt-surge': '马志士道馆',
  erika: '莉佳道馆', sabrina: '娜姿道馆', koga: '阿桔道馆', blaine: '夏伯道馆', giovanni: '坂木道馆',
};
// These are UI labels for the practice decks, not official localized product titles.
export function chineseDeckName(key, deck) {
  if (CLASSIC_DECKS[key]) return CLASSIC_DECKS[key];
  if (key.startsWith('sm-')) {
    const featured = deck.featured?.[0];
    return (catalog.cards[featured]?.name || '太阳＆月亮') + '练习卡组';
  }
  return chineseTerm(deck.name)
    .replace(/\bLeague\b/g, '联盟对战卡组').replace(/\bBattle Deck\b/g, '对战卡组')
    .replace(/\bTheme\b/g, '主题卡组');
}

export function cardScan(card) { return catalog.cards[card.id]?.scan || null; }
const researchScans = new Map();
const unavailableResearch = new Set();
export function configureResearchScans(manifest) {
  if (manifest?.local_only !== true || manifest?.redistribution_permitted !== false) return false;
  for (const [id, entry] of Object.entries(manifest.cards || {})) {
    if (catalog.cards[id] && entry.language === 'zh-Hans'
        && /^\/api\/research-card\/[a-f0-9]{64}\.png$/.test(entry.url)) researchScans.set(id, entry);
  }
  return true;
}
export async function loadResearchScans() {
  // No private manifest or request in ordinary/public builds (or Node tests).
  if (typeof document === 'undefined' || document.querySelector('meta[name="tcg-private-research"]')?.content !== '1') return;
  try {
    const response = await fetch('/api/research-scans', { signal: AbortSignal.timeout(3000) });
    if (response.ok) configureResearchScans(await response.json());
  } catch { /* A missing private cache leaves normal public pictures and labelled learning faces intact. */ }
}
const unavailableScans = new Set();
const scanFilename = (url) => String(url).split('/').at(-1);
export function chineseCardImage(card) {
  const scan = cardScan(card);
  if (scan && !unavailableScans.has(scanFilename(scan.url))) return scan.url;
  const research = researchScans.get(card.id);
  return research && !unavailableResearch.has(scanFilename(research.url))
    ? research.url : `img/zh-learning/${encodeURIComponent(card.id)}.svg`;
}
export function chineseImageLabel(card) {
  const scan = cardScan(card);
  const research = researchScans.get(card.id);
  if ((!scan || unavailableScans.has(scanFilename(scan.url))) && research && !unavailableResearch.has(scanFilename(research.url))) {
    return '简体卡图（仅本地研究）';
  }
  return scan && unavailableScans.has(scanFilename(scan.url))
    ? '中文练习卡面（原图缓存缺失，非官方扫描）'
    : scan?.label || '中文练习卡面（非官方扫描）';
}
const scanFallbacks = new Map(Object.entries(catalog.cards).filter(([, card]) => card.scan)
  .map(([id, card]) => [card.scan.url.split('/').at(-1), `img/zh-learning/${encodeURIComponent(id)}.svg`]));
export function missingScanFallback(url) {
  return scanFallbacks.get(scanFilename(url)) || null;
}
export function registerMissingScan(url) {
  if (String(url).includes('/api/research-card/')) {
    unavailableResearch.add(scanFilename(url));
    const id = [...researchScans].find(([, entry]) => scanFilename(entry.url) === scanFilename(url))?.[0];
    return id ? chineseCardImage({ id }) : null;
  }
  const fallback = missingScanFallback(url);
  if (fallback) unavailableScans.add(scanFilename(url));
  return fallback;
}
