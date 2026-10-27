// Deck-building advice from the metagame (M7): a list against the tournament lists of its closest archetype
// (ai/archetypes.json). What nearly every list of the archetype plays that this one lacks or plays fewer of, and what this
// list plays that the archetype rarely does. It is what the tournament players chose, not a simulated result (testing
// a suggested change by playing it is the next step, docs/ai/STATUS.md M7).
import { readFileSync } from 'node:fs';
import { deckPlan } from './deck-plan.mjs';

let archetypes = null;
const load = () => (archetypes ??= JSON.parse(readFileSync(new URL('./archetypes.json', import.meta.url), 'utf8')).archetypes);

/**
 * `cards`: [[printingId, copies]]; `catalog` must have its printings. A list is compared with an archetype only when it
 * clearly is one (`similar`; a starter deck is close to none of them).
 */
export function deckAdvice(catalog, cards, { core = 0.9, rare = 0.1, similar = 0.85 } = {}) {
  const plan = deckPlan(catalog, cards), archetype = plan.archetype && load().find((a) => a.name === plan.archetype.name);
  if (!archetype || plan.archetype.similarity < similar) return { archetype: null, closest: plan.archetype, missing: [], fewer: [], rare: [] };
  const mine = new Map();
  for (const [printingId, n] of cards) {
    const d = catalog.definitionFor(printingId), e = mine.get(d.nameKey) ?? { name: d.name, copies: 0 };
    e.copies += n; mine.set(d.nameKey, e);
  }
  const stats = new Map(archetype.cards.map((c) => [c.nameKey, c]));
  // Typical copies, rounded: what most of those lists play.
  const typical = (c) => Math.max(1, Math.round(c.copies));
  return {
    archetype: { ...plan.archetype },
    // Cards almost every list plays, missing here.
    missing: archetype.cards.filter((c) => c.share >= core && !mine.has(c.nameKey))
      .map((c) => ({ nameKey: c.nameKey, name: c.name, share: c.share, typical: typical(c) })),
    // Played here, but fewer than most lists play.
    fewer: archetype.cards.filter((c) => c.share >= core && mine.has(c.nameKey) && mine.get(c.nameKey).copies < typical(c))
      .map((c) => ({ nameKey: c.nameKey, name: c.name, share: c.share, typical: typical(c), mine: mine.get(c.nameKey).copies })),
    // Played here, but by few of the archetype's lists (or none).
    rare: [...mine].filter(([key]) => (stats.get(key)?.share ?? 0) < rare)
      .map(([key, e]) => ({ nameKey: key, name: e.name, mine: e.copies, share: stats.get(key)?.share ?? 0 })),
  };
}

/** The advice in a few lines of Chinese. */
export function describeAdvice(advice) {
  if (!advice.archetype) return `没有可比较的赛事套路${advice.closest ? `（最接近的是${advice.closest.name}，相似度只有 ${advice.closest.similarity}）` : ''}。`;
  const pct = (x) => `${Math.round(100 * x)}%`;
  return [
    `对照套路：${advice.archetype.name}（${advice.archetype.lists} 份赛事卡表，相似度 ${advice.archetype.similarity}）`,
    `几乎都带、你没带：${advice.missing.map((c) => `${c.name}（${pct(c.share)}，通常 ${c.typical} 张）`).join('、') || '无'}`,
    `你带得较少：${advice.fewer.map((c) => `${c.name}（你 ${c.mine} 张，通常 ${c.typical} 张）`).join('、') || '无'}`,
    `同套路很少带：${advice.rare.map((c) => `${c.name}×${c.mine}（${pct(c.share)}）`).join('、') || '无'}`,
  ].join('\n');
}
