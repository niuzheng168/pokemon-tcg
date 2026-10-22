import { listFormats, printingFormatStatus } from './formats.js';

// The same deterministic projection is used by the full-pool builder and by
// subset admission. Index hints never replace the kernel's final deck checks.
export function releaseIndexEntry(catalog, printingId, shardId) {
  const p = catalog.printing(printingId), d = catalog.definitionFor(printingId), m = d.mechanics;
  return {
    printingId, shardId, definitionId: d.definitionId,
    tier: p.identityReview === 'machine' || d.implementation.tier === 'machine' ? 'machine' : 'reviewed',
    latestPrintingIds: [...new Set((p.formatReviews || []).map((r) => r.latestPrintingId))].sort(),
    card: { name: d.name, nameKey: d.nameKey, kind: d.kind, deckLimits: structuredClone(d.deckLimits),
      stage: m.stage ?? null, category: m.category ?? null,
      types: [...new Set(d.kind === 'energy' ? m.baseUnits.flat() : m.types || [])], tags: [...(m.tags || [])],
      hp: m.hp ?? null, evolvesFrom: m.evolvesFrom ?? null, weakness: m.weakness ?? null,
      resistance: m.resistance ?? null, retreatCost: m.retreatCost ?? null, ruleBox: m.ruleBox ?? false,
      attacks: (m.attacks || m.grantedAttacks || []).map((a) => ({
        attackId: a.attackId, name: a.name, cost: [...a.cost], printedDamage: a.printedDamage ?? null,
      })),
      abilities: (m.abilities || []).map((a) => ({ abilityId: a.abilityId, name: a.name })) },
    printing: { setCode: p.setCode, number: p.number, regulationMark: p.regulationMark,
      series: p.series ?? null, releasedOn: p.releasedOn ?? null },
    formats: listFormats().filter((f) => `${f.region}/${f.version}` === catalog.ruleset.id).map((f) => {
      const format = { region: f.region, version: f.version, id: f.id };
      return { format, ...printingFormatStatus(catalog, printingId, format) };
    }),
  };
}
