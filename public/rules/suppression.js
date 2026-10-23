import { validateSuppressionEffect } from './schema-validators.js';

export const SUPPRESSION_RULE_IDS = Object.freeze(['effects.remove-content']);

export class SuppressionError extends TypeError {
  constructor(code, message, details = {}) {
    super(message); this.name = 'SuppressionError'; this.code = code; this.details = structuredClone(details);
  }
}

function applies(entry, source, target, ignoreType = false) {
  const s = entry.spec;
  if (target.kind !== (s.channel === 'abilities' ? 'ability' : 'tool')) return false;
  if (entry.targetId && target.pokemonId !== entry.targetId) return false;
  if (s.scope === 'self' && source.pokemonId !== target.pokemonId ||
      s.scope === 'own' && source.owner !== target.owner ||
      s.scope === 'opponent' && source.owner === target.owner) return false;
  if (s.activeOnly && !target.active || s.sourceActive && !source.active) return false;
  if (!ignoreType && s.type && !target.mechanics.types.includes(s.type) ||
      s.stage && target.mechanics.stage !== s.stage ||
      Object.hasOwn(s, 'ruleBox') && target.mechanics.ruleBox !== s.ruleBox ||
      s.tag && !target.mechanics.tags.includes(s.tag) || s.excludeTags?.some((tag) => target.mechanics.tags.includes(tag)) ||
      s.damaged && !target.damaged) return false;
  // 「（除「X」外）」 names an Ability printed on any card.
  return !(s.exceptAbilityIds?.includes(target.key) || s.exceptToolNameKeys?.includes(target.key) ||
    s.exceptAbilityNames?.includes(target.mechanics.abilities.find((a) => a.abilityId === target.key).name));
}

/**
 * Only live source nodes are removed. Already-established duration effects have
 * independent fixed nodes, so deleting their original Ability does not undo them.
 * Resolve dependencies, never JSON iteration order or an arbitrary iteration cap.
 * Unresolved cycles require a sourced CN ruling, not a guessed timestamp priority.
 */
export function sourceSuppressionGraph(nodes, entries, ignoreType = false) {
  if (!Array.isArray(nodes) || !Array.isArray(entries))
    throw new SuppressionError('invalid-source-graph', 'Source nodes and suppression entries must be arrays.');
  const byId = new Map(), blockers = new Map();
  for (const n of nodes) {
    if (!n.id || byId.has(n.id) || !['ability', 'tool', 'stadium', 'rule', 'energy', 'fixed'].includes(n.kind) ||
        ![0, 1].includes(n.owner) || (['ability', 'tool'].includes(n.kind) &&
          (!n.pokemonId || !n.key || !n.mechanics || !Array.isArray(n.mechanics.types) || !Array.isArray(n.mechanics.tags))))
      throw new SuppressionError('invalid-source-graph', 'Invalid or duplicate effect source identity.');
    byId.set(n.id, n); blockers.set(n.id, []);
  }
  const ids = new Set();
  for (const e of entries) {
    if (!e.id || ids.has(e.id) || !byId.has(e.sourceNodeId) || !e.source?.instanceId ||
        !e.sourceOfTruth?.length || !validateSuppressionEffect(e.spec))
      throw new SuppressionError('invalid-suppression', 'Suppression needs a unique identity, existing source and reviewed specification.');
    ids.add(e.id);
    for (const n of nodes) if (applies(e, byId.get(e.sourceNodeId), n, ignoreType)) blockers.get(n.id).push(e);
  }
  return { byId, blockers };
}

export function resolveSuppression(nodes, entries) {
  const { blockers } = sourceSuppressionGraph(nodes, entries), statuses = new Map();
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of nodes) {
      if (statuses.has(n.id)) continue;
      const incoming = blockers.get(n.id);
      if (incoming.some((e) => statuses.get(e.sourceNodeId) === true)) {
        statuses.set(n.id, false); changed = true;
      } else if (incoming.every((e) => statuses.get(e.sourceNodeId) === false)) {
        statuses.set(n.id, true); changed = true;
      }
    }
  }
  if (statuses.size !== nodes.length)
    throw new SuppressionError('unresolved-suppression-cycle', 'Interdependent removal requires an explicit sourced CN ruling.',
      { unresolved: nodes.filter((n) => !statuses.has(n.id)).map((n) => n.id) });
  return new Map(nodes.map((n) => [n.id, {
    enabled: statuses.get(n.id),
    removedBy: blockers.get(n.id).filter((e) => statuses.get(e.sourceNodeId)).map((e) => ({
      effectId: e.id, sourceId: e.source.instanceId, sourceOfTruth: structuredClone(e.sourceOfTruth),
      ruleId: 'effects.remove-content',
    })),
  }]));
}
