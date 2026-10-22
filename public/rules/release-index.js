import { listFormats, printingFormatStatus } from './formats.js';
import { canonicalJSON } from './catalog.js';

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

// Wire form (catalog-index 3.0.0): one copy of each definition's card facts, member IDs relative to their definition,
// one legality reason per format, no empty anchor list, and the shard implied by the set. Both directions are exact:
// decodeReleaseIndex(encodeReleaseIndex(x)) deep-equals x, or encoding throws.
const members = (card, id, map) => ({ ...card,
  attacks: card.attacks.map((a) => ({ ...a, attackId: map(a.attackId, id) })),
  abilities: card.abilities.map((a) => ({ ...a, abilityId: map(a.abilityId, id) })) });
const relative = (member, id) => member.startsWith(`${id}:`) && /^[A-Za-z0-9]/.test(member.slice(id.length + 1))
  ? member.slice(id.length) : member;
const absolute = (member, id) => member.startsWith(':') ? `${id}${member}` : member;

export function encodeReleaseIndex({ ruleset, entries }) {
  const formats = entries[0].formats.map((f) => f.format), cards = {};
  const out = entries.map((e) => {
    if (e.shardId !== e.printing.setCode) throw new TypeError(`Index entry is not routed to its own set: ${e.printingId}`);
    if (canonicalJSON(e.formats.map((f) => f.format)) !== canonicalJSON(formats) || e.formats.some((f) => f.legal !== (f.reason === null)))
      throw new TypeError(`Index formats are not one shared list of reasons: ${e.printingId}`);
    const card = members(e.card, e.definitionId, relative);
    if (cards[e.definitionId] && canonicalJSON(cards[e.definitionId]) !== canonicalJSON(card))
      throw new TypeError(`One definition with two sets of card facts: ${e.definitionId}`);
    cards[e.definitionId] = card;
    return { printingId: e.printingId, definitionId: e.definitionId, tier: e.tier,
      ...(e.latestPrintingIds.length ? { latestPrintingIds: [...e.latestPrintingIds] } : {}),
      printing: structuredClone(e.printing), legality: e.formats.map((f) => f.reason) };
  });
  return { schemaVersion: '3.0.0', ruleset: structuredClone(ruleset), formats: structuredClone(formats), cards, entries: out };
}

/** Expand a schema-valid wire index; throws TypeError on facts that cannot be expanded exactly. */
export function decodeReleaseIndex(wire) {
  const used = new Set();
  const entries = wire.entries.map((e) => {
    const card = Object.hasOwn(wire.cards, e.definitionId) ? wire.cards[e.definitionId] : null;
    if (!card || e.legality.length !== wire.formats.length)
      throw new TypeError(`Index entry without card facts or one reason per format: ${e.printingId}`);
    used.add(e.definitionId);
    return { printingId: e.printingId, shardId: e.printing.setCode, definitionId: e.definitionId, tier: e.tier,
      latestPrintingIds: [...(e.latestPrintingIds ?? [])], card: members(structuredClone(card), e.definitionId, absolute),
      printing: structuredClone(e.printing),
      formats: wire.formats.map((format, i) => ({ format: structuredClone(format), legal: e.legality[i] === null, reason: e.legality[i] })) };
  });
  if (used.size !== Object.keys(wire.cards).length) throw new TypeError('Index card facts no printing uses.');
  return { schemaVersion: wire.schemaVersion, ruleset: structuredClone(wire.ruleset), entries };
}
