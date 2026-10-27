// Joint logical dependency evaluation; never iteration-order/timestamp priority.
// Where it stalls, the card texts decide first; what they leave open falls to the
// PROVISIONAL effects.remove-content-loop (see below and suppression.js).
// Printed mechanics are inputs, not mutable derived-state caches.
import { sourceSuppressionGraph, SuppressionError, REMOVAL_LOOP_RULE_ID, stuckParts, onlyOutcome, firstLoops } from './suppression.js';
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
  // Whether a typed removal reaches a node: true/false when every type its Pokémon may still have agrees, else null.
  const typeReaches = (node, type) => {
    const possible = knownTypes.has(node.pokemonId) ? [knownTypes.get(node.pokemonId)] : domains.get(node.pokemonId);
    return possible.every((types) => !types.includes(type)) ? false : possible.every((types) => types.includes(type)) ? true : null;
  };
  const state = (node, e) => {
    if (statuses.get(e.sourceNodeId) === false) return false;
    const reaches = e.spec.type ? typeReaches(node, e.spec.type) : true;
    return reaches === false ? false : reaches === null ? null : statuses.has(e.sourceNodeId) ? true : null;
  };
  const settle = () => {
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
        const states = blockers.get(node.id).map((e) => state(node, e));
        if (states.includes(true)) { statuses.set(node.id, false); changed = true; }
        else if (states.every((value) => value === false)) { statuses.set(node.id, true); changed = true; }
      }
    }
  };
  settle();
  const loops = new Map();
  while (statuses.size !== nodes.length) {
    // A stuck source waits on its undecided removals: on their stuck sources, and, where its Pokémon's types leave a typed
    // removal open, on the stuck type providers of that Pokémon. A Pokémon's stuck providers are linked too: in force
    // together, their replacements must agree.
    const open = nodes.filter((n) => !statuses.has(n.id)), waits = new Map(), deps = new Map();
    for (const n of open) {
      const undecided = blockers.get(n.id).filter((e) => state(n, e) === null), on = new Set();
      for (const e of undecided) {
        if (!statuses.has(e.sourceNodeId)) on.add(e.sourceNodeId);
        if (e.spec.type && typeReaches(n, e.spec.type) === null)
          for (const p of entries.get(n.pokemonId)) if (!statuses.has(p.sourceNodeId)) on.add(p.sourceNodeId);
      }
      waits.set(n.id, undecided); deps.set(n.id, on);
    }
    const links = new Map([...deps].map(([id, on]) => [id, new Set(on)]));
    for (const subject of subjects) {
      const stuck = [...new Set(entries.get(subject.id).map((e) => e.sourceNodeId).filter((id) => !statuses.has(id)))];
      for (const id of stuck.slice(1)) links.get(stuck[0]).add(id);
    }
    const undecided = [];
    for (const part of stuckParts(open.map((n) => n.id), links)) {
      // Card texts first: a source is disabled iff an enabled source removes it, typed removals reading the types its
      // enabled providers give (which must agree). Exactly one such outcome decides the part; not provisional.
      const outcome = onlyOutcome(part, (o) => {
        const on = (id) => statuses.get(id) ?? o.get(id) ?? false, types = new Map();
        const typesOf = (pokemonId) => {
          if (!types.has(pokemonId)) {
            const given = [...new Set(entries.get(pokemonId).filter((e) => on(e.sourceNodeId)).map((e) => typeKey(e.spec.types)))];
            types.set(pokemonId, given.length > 1 ? null : given.length ? JSON.parse(given[0]) : mons.get(pokemonId).printedTypes);
          }
          return types.get(pokemonId);
        };
        return subjects.every((subject) => typesOf(subject.id)) && part.every((id) => on(id) === !blockers.get(id).some((e) =>
          on(e.sourceNodeId) && (!e.spec.type || typesOf(byId.get(id).pokemonId).includes(e.spec.type))));
      });
      if (outcome) for (const [id, enabled] of outcome) statuses.set(id, enabled);
      else undecided.push(...part);
    }
    // PROVISIONAL (effects.remove-content-loop, 临时规则（待官方裁定）): where the texts allow no consistent outcome or several,
    // every source on a first loop takes no effect, neither removing nor changing types; what depends on it then resolves.
    for (const id of firstLoops(undecided, deps)) { statuses.set(id, false); loops.set(id, waits.get(id)); }
    settle();
  }
  const availability = new Map(nodes.map((node) => [node.id, {
    enabled: statuses.get(node.id),
    removedBy: loops.has(node.id) ? loops.get(node.id).map((e) => ({ effectId: e.id, sourceId: e.source.instanceId,
      sourceOfTruth: structuredClone(e.sourceOfTruth), ruleId: REMOVAL_LOOP_RULE_ID, provisional: true }))
      : blockers.get(node.id).filter((e) => statuses.get(e.sourceNodeId) &&
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
