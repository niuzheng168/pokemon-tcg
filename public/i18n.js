// Interface text. The table speaks Simplified Chinese only; card names and texts come from the reviewed release.
// Templates use {param}; special params ($t, $card, $pl, …) are resolved here in t().
import { STRINGS, RULES } from './i18n/zh-CN.js';

export const RULES_HTML = RULES;
export const getLang = () => 'zh-CN';
export const cardName = (c) => c?.name ?? '';
export const displayText = (value) => value;
// The reviewed card image (npm run cn:images); the card back when a card is unknown or has no image.
export const CARD_BACK = 'img/card-back-zh.svg';
export const cardImage = (card) => card?.img || CARD_BACK;

function resolve(v) {
  if (v == null) return '';
  if (typeof v !== 'object') return v;
  if (v.$t) return t(v.$t.key, v.$t.params);
  if (v.$card) return cardName(v.$card);
  if ('$pl' in v) return t('pl.' + v.$pl);
  if (v.$st) return t('st.' + v.$st);
  if ('$coin' in v) return t(v.$coin ? 'coin.h' : 'coin.t');
  if (v.$type) return t('type.' + v.$type);
  return String(v);
}

export function t(key, params = {}) {
  return (STRINGS[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => resolve(params[k]));
}
