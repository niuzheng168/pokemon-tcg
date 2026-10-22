// Deck legality for player-built decks, shared by the deck builder and the account server.
// Lists every problem of a list in words a player reads; the kernel's own validateFormatDeck has the last word,
// so a list counts as legal only when the kernel would start a game with it.
import { printingFormatStatus, validateFormatDeck } from './rules/formats.js';
import { GROUP_NAMES } from './card-pool.js';

export const DECK_SIZE = 60;
export const FORMAT_IDS = ['standard', 'open'];
export const FORMAT_NAMES = { standard: '标准赛', open: '开放赛' };

export const formatRef = (catalog, id) => ({ region: catalog.ruleset.region, version: catalog.ruleset.version, id });
export const deckList = (cards) => cards.flatMap(([id, n]) => Array(n).fill(id));
export const deckCount = (cards) => cards.reduce((sum, [, n]) => sum + n, 0);

// Ask the kernel's per-printing policy directly. Do not build and validate a 60-card shell for every printing;
// deck construction limits and the required Basic Pokémon are checked only when checking an actual deck.
const legalityCache = new WeakMap();
export function printingLegality(catalog) {
  if (legalityCache.has(catalog)) return legalityCache.get(catalog);
  const result = new Map(catalog.printings().map((p) => [p.printingId, Object.fromEntries(FORMAT_IDS.map((f) =>
    [f, printingFormatStatus(catalog, p.printingId, formatRef(catalog, f)).legal]))]));
  legalityCache.set(catalog, result);
  return result;
}

// A printing of the catalog, as the deck check reads a card of the pool (card-pool.js).
function catalogCard(catalog, legality, id) {
  let d;
  try { d = catalog.definitionFor(id); } catch { return null; }
  const p = catalog.printing(id);
  return { id, name: d.name, nameKey: d.nameKey, kind: d.kind, stage: d.mechanics.stage ?? null, setCode: p.setCode, number: p.number,
    limit: d.deckLimits.sameName, groups: d.deckLimits.groups, implemented: true, legal: legality.get(id) };
}

const MISSING_SHOWN = 5;

/**
 * { count, issues: [text], legal } for a list [[printingId, count], …] in format 'standard' | 'open'. With a `pool`
 * (card-pool.js buildPool) the list may hold library cards that are not implemented yet: such a list can be saved but
 * is not legal to play.
 */
export function checkDeck(catalog, cards, formatId, pool = null) {
  const issues = [], count = deckCount(cards);
  if (!FORMAT_IDS.includes(formatId)) return { count, issues: ['未知的赛制。'], legal: false };
  if (count !== DECK_SIZE) issues.push(`卡组需要正好 ${DECK_SIZE} 张卡，现在是 ${count} 张。`);
  const legality = printingLegality(catalog);
  const names = new Map(), groups = new Map(), missing = new Map(), outside = [];
  let basic = false;
  for (const [id, n] of cards) {
    const c = pool ? pool.byId.get(id) : catalogCard(catalog, legality, id);
    if (!c) { issues.push(`卡池里没有这张卡：${id}。`); continue; }
    if (c.kind === 'pokemon' && c.stage === 'basic') basic = true;
    const same = names.get(c.nameKey) ?? { name: c.name, limit: c.limit, n: 0 };
    same.n += n;
    names.set(c.nameKey, same);
    for (const g of c.groups) groups.set(g.key, { max: g.maximum, n: (groups.get(g.key)?.n ?? 0) + n });
    if (!c.implemented) missing.set(c.nameKey, c.name);
    if (!c.legal[formatId]) outside.push(`「${c.name}」（${[c.setCode, c.number].filter(Boolean).join(' ')}）不能在${FORMAT_NAMES[formatId]}使用。`);
  }
  if (missing.size) {
    const shown = [...missing.values()].slice(0, MISSING_SHOWN).map((x) => `「${x}」`).join('');
    issues.push(`${shown}${missing.size > MISSING_SHOWN ? `等 ${missing.size} 种卡` : ''}还没有实现对战规则，暂时不能用于对战。`);
  }
  issues.push(...outside);
  if (count && !basic) issues.push('卡组里至少要有 1 张基础宝可梦。');
  for (const s of names.values()) if (s.limit !== null && s.n > s.limit) issues.push(`同名卡「${s.name}」最多放 ${s.limit} 张，现在有 ${s.n} 张。`);
  for (const [key, g] of groups) if (g.n > g.max) issues.push(`${GROUP_NAMES[key] ?? key}整副卡组最多放 ${g.max} 张，现在有 ${g.n} 张。`);
  if (!issues.length) {
    try {
      validateFormatDeck(catalog, deckList(cards), formatRef(catalog, formatId));
    } catch (error) {
      issues.push(`规则内核不接受这副卡组：${error.message}`);
    }
  }
  return { count, issues, legal: issues.length === 0 };
}
