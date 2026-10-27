import { validateSuppressionEffect } from './schema-validators.js';
import { cloneValue } from './registry.js';
import { checking } from './trust.js';
import { matchesCardSelector } from './card-selection.js';

// effects.remove-content-loop is a PROVISIONAL rule (临时规则（待官方裁定）), not an official one: see resolveSuppression.
export const REMOVAL_LOOP_RULE_ID = 'effects.remove-content-loop';
export const SUPPRESSION_RULE_IDS = Object.freeze(['effects.remove-content', REMOVAL_LOOP_RULE_ID]);

export class SuppressionError extends TypeError {
  constructor(code, message, details = {}) {
    super(message); this.name = 'SuppressionError'; this.code = code; this.details = structuredClone(details);
  }
}

// Also exported for an outOfPlay entry against a card in the hand or discard pile (target pokemonId null, never active).
export function suppressionApplies(entry, source, target, ignoreType = false) { return applies(entry, source, target, ignoreType); }
// effects.remove-self-knockout: a cn.knockOut@1 of 「这只宝可梦」 anywhere in an Ability's effects (also inside a coin, then or condition).
const knocksOutItself = (value) => Array.isArray(value) ? value.some(knocksOutItself) : !!value && typeof value === 'object' &&
  (value.handlerId === 'cn.knockOut@1' && value.parameters.target === 'self' || Object.values(value).some(knocksOutItself));
function applies(entry, source, target, ignoreType = false) {
  const s = entry.spec;
  const kind = { abilities: 'ability', tools: 'tool', specialEnergy: 'energy' }[s.channel];
  if (target.kind !== kind || kind === 'energy' && !target.special) return false;
  if (entry.targetId && target.pokemonId !== entry.targetId) return false;
  // effects.player-ability-removal: the Active Pokémon protected when the player effect began.
  if (entry.exemptId && target.pokemonId === entry.exemptId) return false;
  if (s.scope === 'self' && source.pokemonId !== target.pokemonId ||
      s.scope === 'own' && source.owner !== target.owner ||
      s.scope === 'opponent' && source.owner === target.owner) return false;
  // 「只要这只宝可梦在备战区」 / 「双方备战区中所有…」 (effects.remove-bench); a Stadium is no Pokémon on a Bench.
  if (s.activeOnly && !target.active || s.sourceActive && !source.active ||
      s.sourceBench && (source.active || !source.pokemonId) || s.benchOnly && target.active) return false;
  // The printed Ability: one an effect gave (ability.granted) has no printed name or effects on the card.
  const printed = () => target.granted ? null : target.mechanics.abilities.find((a) => a.abilityId === target.key);
  if (!ignoreType && s.type && !target.mechanics.types.includes(s.type) ||
      s.stage && target.mechanics.stage !== s.stage ||
      Object.hasOwn(s, 'ruleBox') && target.mechanics.ruleBox !== s.ruleBox ||
      s.tag && !target.mechanics.tags.includes(s.tag) || s.excludeTags?.some((tag) => target.mechanics.tags.includes(tag)) ||
      s.damaged && !target.damaged || s.targetCard && !matchesCardSelector(target.definition, s.targetCard) ||
      s.selfKnockOut && !knocksOutItself(printed()?.effects ?? [])) return false;
  // 「（除「X」外）」 names an Ability printed on any card.
  return !(s.exceptAbilityIds?.includes(target.key) || s.exceptToolNameKeys?.includes(target.key) ||
    s.exceptAbilityNames?.includes(printed()?.name));
}

/**
 * Only live source nodes are removed. Already-established duration effects have
 * independent fixed nodes, so deleting their original Ability does not undo them.
 * Resolve dependencies, never JSON iteration order or an arbitrary iteration cap.
 * A cycle is not settled by a guessed timestamp priority: resolveSuppression
 * takes the card texts' only consistent outcome, else the provisional
 * effects.remove-content-loop until a CN ruling exists.
 */
export function sourceSuppressionGraph(nodes, entries, ignoreType = false) {
  if (!Array.isArray(nodes) || !Array.isArray(entries))
    throw new SuppressionError('invalid-source-graph', 'Source nodes and suppression entries must be arrays.');
  // A simulation's graph is the engine's own (trust.js): only checked play checks its identities.
  const byId = new Map(), blockers = new Map(), check = checking();
  for (const n of nodes) {
    if (check && (!n.id || byId.has(n.id) || !['ability', 'tool', 'stadium', 'rule', 'energy', 'fixed'].includes(n.kind) ||
        ![0, 1].includes(n.owner) || (['ability', 'tool'].includes(n.kind) &&
          (!n.pokemonId || !n.key || !n.mechanics || !Array.isArray(n.mechanics.types) || !Array.isArray(n.mechanics.tags)))))
      throw new SuppressionError('invalid-source-graph', 'Invalid or duplicate effect source identity.');
    byId.set(n.id, n); blockers.set(n.id, []);
  }
  const ids = new Set();
  for (const e of entries) {
    if (check && (!e.id || ids.has(e.id) || !byId.has(e.sourceNodeId) || !e.source?.instanceId ||
        !e.sourceOfTruth?.length || !validateSuppressionEffect(e.spec)))
      throw new SuppressionError('invalid-suppression', 'Suppression needs a unique identity, existing source and reviewed specification.');
    ids.add(e.id);
    for (const n of nodes) if (applies(e, byId.get(e.sourceNodeId), n, ignoreType)) blockers.get(n.id).push(e);
  }
  return { byId, blockers };
}

/**
 * A source is enabled when no enabled source removes it, disabled when an enabled source does.
 *
 * When that stalls (removals that depend on each other in a loop), the card texts decide first: the stuck sources split into
 * parts no removal links, and a part whose texts allow exactly one consistent outcome takes it (effects.remove-content;
 * not provisional). See stuckParts / onlyOutcome.
 *
 * PROVISIONAL RULE (effects.remove-content-loop, 临时规则（待官方裁定）): for a part whose texts allow no consistent outcome
 * or several, the simplified-Chinese documents give no ruling (II.D-13; docs/rules/zh-CN/V20261019/STATUS.md §6). Until one
 * exists, each first loop of that part (firstLoops) is removed by its own effects: every source in it is disabled, and its
 * removedBy lists the removals it was still waiting on, under that rule id with provisional: true. What depends on the loop
 * then resolves as usual. When the official ruling arrives, replace the step marked PROVISIONAL below (and in
 * source-traits.js), and the rule entry effects.remove-content-loop in public/rules/zh-CN/V20261019.js.
 */
export function resolveSuppression(nodes, entries) {
  const { blockers } = sourceSuppressionGraph(nodes, entries), statuses = new Map(), loops = new Map();
  const settle = () => {
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
  };
  settle();
  while (statuses.size !== nodes.length) {
    // A stuck source waits on its removers that are stuck too (an enabled remover would have settled it).
    const open = nodes.filter((n) => !statuses.has(n.id)).map((n) => n.id);
    const waits = new Map(open.map((id) => [id, blockers.get(id).filter((e) => !statuses.has(e.sourceNodeId))]));
    const deps = new Map(open.map((id) => [id, new Set(waits.get(id).map((e) => e.sourceNodeId))])), undecided = [];
    for (const part of stuckParts(open, deps)) {
      const outcome = onlyOutcome(part, (o) => part.every((id) => o.get(id) === !waits.get(id).some((e) => o.get(e.sourceNodeId))));
      if (outcome) for (const [id, enabled] of outcome) statuses.set(id, enabled);
      else undecided.push(...part);
    }
    // PROVISIONAL (effects.remove-content-loop): the texts leave these open.
    for (const id of firstLoops(undecided, deps)) { statuses.set(id, false); loops.set(id, waits.get(id)); }
    settle();
  }
  const receipt = (e, ruleId) => ({ effectId: e.id, sourceId: e.source.instanceId, sourceOfTruth: cloneValue(e.sourceOfTruth), ruleId });
  return new Map(nodes.map((n) => [n.id, {
    enabled: statuses.get(n.id),
    removedBy: loops.has(n.id) ? loops.get(n.id).map((e) => ({ ...receipt(e, REMOVAL_LOOP_RULE_ID), provisional: true }))
      : blockers.get(n.id).filter((e) => statuses.get(e.sourceNodeId)).map((e) => receipt(e, 'effects.remove-content')),
  }]));
}

// Shared with source-traits.js. `deps` maps each stuck source to the stuck sources it waits on; every stuck source waits on at
// least one (otherwise it would have settled), so the stuck sources always contain loops. Sets, not enumeration order,
// decide every result here.

// The parts of the stuck sources that nothing links: `links` (id -> ids) count in either direction.
export function stuckParts(open, links) {
  const near = new Map(open.map((id) => [id, new Set()])), seen = new Set(), parts = [];
  for (const [id, others] of links) for (const other of others) { near.get(id).add(other); near.get(other).add(id); }
  for (const id of open) {
    if (seen.has(id)) continue;
    const part = [], stack = [id];
    seen.add(id);
    while (stack.length) {
      const v = stack.pop(); part.push(v);
      for (const w of near.get(v)) if (!seen.has(w)) { seen.add(w); stack.push(w); }
    }
    parts.push(part);
  }
  return parts;
}

// Card texts first: the one outcome (id -> enabled) of a part that `consistent` accepts, or null when the texts allow none or
// several. A part of more than MAX_ENUMERATED_SOURCES sources is not enumerated (2^n outcomes) and gets null, so it falls to
// the provisional rule even where its texts would decide it.
export const MAX_ENUMERATED_SOURCES = 12;
export function onlyOutcome(part, consistent) {
  if (part.length > MAX_ENUMERATED_SOURCES) return null;
  let found = null;
  for (let mask = 0; mask < 2 ** part.length; mask++) {
    const outcome = new Map(part.map((id, i) => [id, (mask & (1 << i)) !== 0]));
    if (!consistent(outcome)) continue;
    if (found) return null;
    found = outcome;
  }
  return found;
}

// PROVISIONAL (effects.remove-content-loop): the sources on the first loops of the stuck graph, those nothing outside their
// loop still decides: every stuck source they wait on, directly or not, waits on them in turn (first strongly connected parts).
export function firstLoops(open, deps) {
  const before = new Map(open.map((id) => {
    const seen = new Set(), stack = [...deps.get(id)];
    while (stack.length) { const v = stack.pop(); if (!seen.has(v)) { seen.add(v); stack.push(...deps.get(v)); } }
    return [id, seen];
  }));
  return open.filter((id) => [...before.get(id)].every((other) => before.get(other).has(id)));
}
