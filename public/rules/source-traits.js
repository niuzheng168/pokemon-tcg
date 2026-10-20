// Joint logical dependency evaluation; never iteration-order/timestamp priority.
// Cycles whose truth cannot be established from CN-backed descriptions remain
// unsupported. Printed mechanics are inputs, not mutable derived-state caches.
import { sourceSuppressionGraph, SuppressionError } from './suppression.js';
import { assertPokemonTypesEffect, resolvePokemonTypes } from './pokemon-types.js';

const typeKey = (types) => JSON.stringify([...types].sort());

export function resolveSourceTraits(nodes, suppression, typeEntries, subjects) {
  const { byId, blockers } = sourceSuppressionGraph(nodes, suppression, true);
  if (!Array.isArray(typeEntries) || !Array.isArray(subjects))
    throw new SuppressionError('invalid-source-traits', 'Type descriptions and live subjects must be arrays.');
  const mons = new Map(), entries = new Map(), statuses = new Map(), knownTypes = new Map(), domains = new Map();
  for (const subject of subjects) {
    if (!subject.id || mons.has(subject.id))
      throw new SuppressionError('invalid-source-traits', 'Live Pokémon need unique identities.');
    resolvePokemonTypes(subject.printedTypes, []);
    mons.set(subject.id, subject); entries.set(subject.id, []);
  }
  const ids = new Set();
  for (const entry of typeEntries) {
    assertPokemonTypesEffect(entry.spec);
    if (!entry.id || ids.has(entry.id) || !byId.has(entry.sourceNodeId) ||
        !Array.isArray(entry.targets) || new Set(entry.targets).size !== entry.targets.length ||
        entry.targets.some((id) => !mons.has(id)) || !entry.sourceOfTruth?.length)
      throw new SuppressionError('invalid-source-traits', 'Type providers need unique IDs, real sources, targets and evidence.');
    ids.add(entry.id);
    for (const target of entry.targets) entries.get(target).push(entry);
  }
  for (const node of nodes) if (['ability', 'tool'].includes(node.kind) && !mons.has(node.pokemonId))
    throw new SuppressionError('invalid-source-traits', 'Every typed effect node must belong to a live Pokémon.');

  // Unknown is not false. Only establish a value when every still-possible
  // blocker/provider agrees with it. Each successful pass adds known facts;
  // finite input size, not an arbitrary retry limit, bounds termination.
  let changed = true;
  while (changed) {
    changed = false;
    for (const subject of subjects) {
      if (knownTypes.has(subject.id)) continue;
      const providers = entries.get(subject.id);
      const active = providers.filter((e) => statuses.get(e.sourceNodeId) === true);
      const pending = providers.filter((e) => !statuses.has(e.sourceNodeId));
      const resolved = resolvePokemonTypes(subject.printedTypes, active.map((e) =>
        ({ id: e.id, types: e.spec.types, sourceOfTruth: e.sourceOfTruth })));
      domains.set(subject.id, [resolved.types, ...pending.map((e) => e.spec.types)]);
      if (pending.every((e) => typeKey(e.spec.types) === typeKey(resolved.types))) {
        knownTypes.set(subject.id, resolved.types); changed = true;
      }
    }
    for (const node of nodes) {
      if (statuses.has(node.id)) continue;
      const incoming = blockers.get(node.id);
      const states = incoming.map((e) => {
        if (statuses.get(e.sourceNodeId) === false) return false;
        if (e.spec.type) {
          const possible = knownTypes.has(node.pokemonId) ? [knownTypes.get(node.pokemonId)] : domains.get(node.pokemonId);
          if (possible.every((types) => !types.includes(e.spec.type))) return false;
          if (!possible.every((types) => types.includes(e.spec.type))) return null;
        }
        return statuses.has(e.sourceNodeId) ? true : null;
      });
      if (states.includes(true)) { statuses.set(node.id, false); changed = true; }
      else if (states.every((value) => value === false)) { statuses.set(node.id, true); changed = true; }
    }
  }
  if (statuses.size !== nodes.length || knownTypes.size !== subjects.length)
    throw new SuppressionError('unresolved-type-source-cycle', 'Type changes and content removal have an unresolved dependency; no CN timestamp ruling is inferred.',
      { sources: nodes.filter((n) => !statuses.has(n.id)).map((n) => n.id),
        pokemon: subjects.filter((m) => !knownTypes.has(m.id)).map((m) => m.id) });
  const availability = new Map(nodes.map((node) => [node.id, {
    enabled: statuses.get(node.id),
    removedBy: blockers.get(node.id).filter((e) => statuses.get(e.sourceNodeId) &&
      (!e.spec.type || knownTypes.get(node.pokemonId).includes(e.spec.type))).map((e) => ({
      effectId: e.id, sourceId: e.source.instanceId, sourceOfTruth: structuredClone(e.sourceOfTruth),
      ruleId: 'effects.remove-content',
    })),
  }]));
  const pokemonTypes = new Map(subjects.map((subject) => [subject.id,
    resolvePokemonTypes(subject.printedTypes, entries.get(subject.id).filter((e) =>
      statuses.get(e.sourceNodeId)).map((e) => ({ id: e.id, types: e.spec.types, sourceOfTruth: e.sourceOfTruth }))),
  ]));
  return { availability, pokemonTypes };
}
