// Deck legality for player-built decks, shared by the deck builder and the account server.
// Lists every problem of a list in words a player reads; the kernel's own validateFormatDeck has the last word,
// so a list counts as legal only when the kernel would start a game with it.
import { validateFormatDeck } from './rules/formats.js';

export const DECK_SIZE = 60;
export const FORMAT_IDS = ['standard', 'open'];
export const FORMAT_NAMES = { standard: '标准赛', open: '开放赛' };
const GROUP_NAMES = { 'cn-ace-spec': 'ACE SPEC' };

export const formatRef = (catalog, id) => ({ region: catalog.ruleset.region, version: catalog.ruleset.version, id });
export const deckList = (cards) => cards.flatMap(([id, n]) => Array(n).fill(id));
export const deckCount = (cards) => cards.reduce((sum, [, n]) => sum + n, 0);

function kernelAccepts(catalog, printingIds, formatId) {
  try {
    validateFormatDeck(catalog, printingIds, formatRef(catalog, formatId));
    return true;
  } catch {
    return false;
  }
}

// Which formats each printing may be played in, asked of the kernel itself: the printing is put into a shell deck
// (one Basic Pokémon and basic Energy) that is legal on its own, so only the printing can make it fail.
const legalityCache = new WeakMap();
export function printingLegality(catalog) {
  if (legalityCache.has(catalog)) return legalityCache.get(catalog);
  const printings = catalog.printings(), def = (p) => catalog.definitionFor(p.printingId);
  const energy = printings.filter((p) => def(p).kind === 'energy' && def(p).mechanics.category === 'basic');
  const basics = printings.filter((p) => def(p).kind === 'pokemon' && def(p).mechanics.stage === 'basic');
  const result = new Map(printings.map((p) => [p.printingId, {}]));
  for (const f of FORMAT_IDS) {
    let shell = null;
    for (const e of energy) {
      const b = basics.find((x) => kernelAccepts(catalog, [x.printingId, ...Array(59).fill(e.printingId)], f));
      if (b) { shell = [b.printingId, ...Array(58).fill(e.printingId)]; break; }
    }
    for (const p of printings) result.get(p.printingId)[f] = !!shell && kernelAccepts(catalog, [p.printingId, ...shell], f);
  }
  legalityCache.set(catalog, result);
  return result;
}

const known = (catalog, id) => {
  try { return catalog.definitionFor(id); } catch { return null; }
};

// { count, issues: [text], legal } for a list [[printingId, count], …] in format 'standard' | 'open'.
export function checkDeck(catalog, cards, formatId) {
  const issues = [], count = deckCount(cards);
  if (!FORMAT_IDS.includes(formatId)) return { count, issues: ['未知的赛制。'], legal: false };
  if (count !== DECK_SIZE) issues.push(`卡组需要正好 ${DECK_SIZE} 张卡，现在是 ${count} 张。`);
  const legality = printingLegality(catalog);
  const names = new Map(), groups = new Map();
  let basic = false;
  for (const [id, n] of cards) {
    const d = known(catalog, id);
    if (!d) { issues.push(`卡池里没有这张卡：${id}。`); continue; }
    if (d.kind === 'pokemon' && d.mechanics.stage === 'basic') basic = true;
    const same = names.get(d.nameKey) ?? { name: d.name, limit: d.deckLimits.sameName, n: 0 };
    same.n += n;
    names.set(d.nameKey, same);
    for (const g of d.deckLimits.groups) groups.set(g.key, { max: g.maximum, n: (groups.get(g.key)?.n ?? 0) + n });
    if (!legality.get(id)?.[formatId]) {
      const p = catalog.printing(id);
      issues.push(`「${d.name}」（${p.setCode} ${p.number}）不能在${FORMAT_NAMES[formatId]}使用。`);
    }
  }
  if (count && !basic) issues.push('卡组里至少要有 1 张基础宝可梦。');
  for (const s of names.values()) if (s.limit !== null && s.n > s.limit) issues.push(`同名卡「${s.name}」最多放 ${s.limit} 张，现在有 ${s.n} 张。`);
  for (const [key, g] of groups) if (g.n > g.max) issues.push(`${GROUP_NAMES[key] ?? key} 卡整副卡组最多放 ${g.max} 张，现在有 ${g.n} 张。`);
  if (!issues.length) {
    try {
      validateFormatDeck(catalog, deckList(cards), formatRef(catalog, formatId));
    } catch (error) {
      issues.push(`规则内核不接受这副卡组：${error.message}`);
    }
  }
  return { count, issues, legal: issues.length === 0 };
}
