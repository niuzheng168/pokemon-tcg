// Translation lookup. Simplified Chinese is the default for this learning-site fork.
// Templates use {param}; special params ($card, $pl, …) are resolved here in t().
// Chinese card display identities are independent of engine identities.

import * as en from './i18n/en.js';
import * as tr from './i18n/tr.js';
import * as ja from './i18n/ja.js';
import * as es from './i18n/es.js';
import * as zhCN from './i18n/zh-CN.js';
import {
  chineseTerm, chineseCardName, chineseAttackName, chinesePowerName,
  chineseDeckName, chineseCardImage, chineseImageLabel,
} from './card-presentation.js';

const EN = en.STRINGS;
export const LANGS = ['zh-CN', 'en', 'tr', 'ja', 'es'];
export const DEFAULT_LANG = 'zh-CN';
export const CARD_TEXT_TR = tr.CARD_TEXT;
export const RULES_HTML = { 'zh-CN': zhCN.RULES, en: en.RULES, tr: tr.RULES, ja: ja.RULES, es: es.RULES };

const DICT = { 'zh-CN': zhCN.STRINGS, en: EN, tr: tr.STRINGS, ja: ja.STRINGS, es: es.STRINGS };
export function normalizeLanguage(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toLowerCase().replaceAll('_', '-');
  if (/^zh(?:-|$)/.test(code)) return 'zh-CN'; // this site currently has one Chinese text locale
  return LANGS.find((l) => code === l || code.startsWith(l + '-')) || null;
}
// Respect an explicit saved choice; a first visit and unavailable storage use Chinese.
let lang = DEFAULT_LANG;
try {
  lang = normalizeLanguage(localStorage.getItem('lang')) || DEFAULT_LANG;
} catch { /* storage unavailable */ }

export const getLang = () => lang;
export function setLang(l) {
  const next = normalizeLanguage(l);
  if (!next) return false;
  lang = next;
  try { localStorage.setItem('lang', lang); } catch { /* storage unavailable */ }
  return true;
}

export function cardName(c) {
  if (c.kind === 'energy' && !c.special) return t('energy', { t: t('type.' + c.energyType) });
  return lang === 'zh-CN' ? chineseCardName(c) : c.name;
}
export const displayText = (value) => lang === 'zh-CN' ? chineseTerm(value) : value;
export const attackName = (card, index) => lang === 'zh-CN' ? chineseAttackName(card, index) : card.attacks[index].name;
export const powerName = (card) => lang === 'zh-CN' ? chinesePowerName(card) : card.power?.name;
export const deckName = (key, deck) => lang === 'zh-CN' ? chineseDeckName(key, deck) : deck.name;
export const cardImage = (card, large = false) => lang === 'zh-CN' ? chineseCardImage(card) : (large ? card.imgLarge || card.img : card.img);
export const imageLabel = (card) => lang === 'zh-CN' ? chineseImageLabel(card) : 'Original card image';

function resolve(v) {
  if (v == null) return '';
  if (typeof v !== 'object') return typeof v === 'string' ? displayText(v) : v;
  if (v.$t) return t(v.$t.key, v.$t.params);
  if (v.$card) return cardName(v.$card);
  if (v.$deck) return deckName(v.$deck, v);
  if ('$pl' in v) return t('pl.' + v.$pl);
  if (v.$st) return t('st.' + v.$st);
  if ('$coin' in v) return t(v.$coin ? 'coin.h' : 'coin.t');
  if (v.$type) return t('type.' + v.$type);
  if (v.$slot) return t('slot.' + v.$slot[0], { n: v.$slot[1] });
  if (v.$hidden) return t('hidden');
  if (Array.isArray(v)) return v.length ? ` (${v.map((n) => t('note.' + n.$note)).join(', ')})` : '';
  return String(v);
}

// Spanish Energy names agree with "Energía" (feminine), unlike the type names on their own ("tipo Psíquico").
const ENERGY_ES = [[/Energía Psíquico/g, 'Energía Psíquica'], [/Energía Oscuridad/g, 'Energía Oscura'], [/Energía Metal\b/g, 'Energía Metálica'], [/Energía Incoloro/g, 'Energía Incolora']];

export function t(key, params = {}) {
  const s = (DICT[lang][key] ?? EN[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => resolve(params[k]));
  return lang === 'es' ? ENERGY_ES.reduce((x, [re, to]) => x.replace(re, to), s) : displayText(s);
}
