import { assertDefinitionShape, assertExecutableDefinition, assertPrintingShape, assertPrintingBinding,
  assertPrintingApproval, CardSchemaError } from './card-schema.js';
import { getRuleset } from './index.js';
import { deepFreeze, violation } from './registry.js';
import { KERNEL_BUILD } from './kernel-build.js';

const catalogs = new WeakSet();
export const canonicalJSON = (value) => JSON.stringify(
  (function sort(v) {
    return Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ?
      Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v;
  })(value),
);
export async function sha256(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map((n) => n.toString(16).padStart(2, '0')).join('');
}

export function handlerContract(id, h) {
  return { handlerId: id, rulesetId: h.rulesetId, implementationVersion: h.implementationVersion ?? id,
    timing: h.timing ?? 'resolve', usage: h.usage ?? null, capabilities: h.capabilities ?? [],
    operations: h.operations ?? null, embeddedOperations: h.embeddedOperations ?? [], costCheckVersion: h.costCheckVersion ?? null,
    damageRollVersion: h.damageRollVersion ?? null,
    parameterSchemaRef: h.parameterSchemaRef ?? null, sourceOfTruth: h.sourceOfTruth ?? [],
    functionSources: Object.fromEntries(Object.entries(h).filter(([, value]) => typeof value === 'function')
      .map(([key, fn]) => [key, Function.prototype.toString.call(fn)])) };
}

export async function createCardCatalog({ ruleset, definitions, printings, approvedDefinitions, approvedPrintings = new Map(), handlers = new Map() }) {
  const profile = getRuleset(ruleset), defs = new Map(), prints = new Map();
  handlers = new Map([...handlers].map(([id, handler]) => [id, Object.freeze(Object.fromEntries(
    Object.entries(handler).map(([key, value]) => [key, typeof value === 'function' ? value : deepFreeze(structuredClone(value))]),
  ))]));
  for (const definition of definitions) {
    assertDefinitionShape(definition);
    if (defs.has(definition.definitionId)) throw new CardSchemaError('Duplicate definition identity.');
    defs.set(definition.definitionId, assertExecutableDefinition(definition, { ruleset, approvedDefinitions, handlers }));
  }
  const names = new Map(), keys = new Map();
  for (const d of defs.values()) {
    if ((names.has(d.name) && names.get(d.name) !== d.nameKey) || (keys.has(d.nameKey) && keys.get(d.nameKey) !== d.name))
      throw new CardSchemaError('Same-name deck limits/evolution cannot use conflicting name identities.');
    names.set(d.name, d.nameKey); keys.set(d.nameKey, d.name);
  }
  for (const d of defs.values()) if (d.kind === 'pokemon' && d.mechanics.stage === 'stage2') {
    const parents = [...defs.values()].filter((p) => p.kind === 'pokemon' && p.mechanics.stage === 'stage1' &&
      p.nameKey === d.mechanics.evolvesFrom);
    if (parents.some((p) => p.mechanics.evolvesFrom !== d.mechanics.basicAncestor.nameKey))
      throw new CardSchemaError('Reviewed Stage 2 Basic ancestry contradicts an included Stage 1 prerequisite.');
  }
  for (const printing of printings) {
    assertPrintingShape(printing);
    if (prints.has(printing.printingId)) throw new CardSchemaError('Duplicate printing identity.');
    const matches = printing.definitionBindings.filter((b) => `${b.ruleset.region}/${b.ruleset.version}` === profile.id);
    const definition = defs.get(matches[0]?.definitionId);
    if (!definition) throw new CardSchemaError('Printing has no executable definition.');
    assertPrintingBinding(printing, definition, ruleset);
    assertPrintingApproval(printing, approvedPrintings);
    prints.set(printing.printingId, deepFreeze(structuredClone(printing)));
  }
  const id = await sha256(canonicalJSON({
    ruleset,
    kernelSha256: KERNEL_BUILD.kernelSha256, schemaSha256: KERNEL_BUILD.schemaSha256,
    definitions: [...defs.values()].sort((a, b) => a.definitionId < b.definitionId ? -1 : 1),
    printings: [...prints.values()].sort((a, b) => a.printingId < b.printingId ? -1 : 1),
    handlers: [...handlers].sort(([a], [b]) => a < b ? -1 : 1).map(([id, h]) => handlerContract(id, h)),
  }));
  const catalog = Object.freeze({
    id, ruleset: profile,
    definitions: () => [...defs.values()], printings: () => [...prints.values()],
    definition: (id) => {
      if (!defs.has(id)) throw new CardSchemaError(`Unknown executable definition: ${id}`);
      return defs.get(id);
    },
    printing: (id) => {
      if (!prints.has(id)) throw new CardSchemaError(`Unknown printing: ${id}`);
      return prints.get(id);
    },
    definitionFor: (id) => {
      const printing = prints.get(id);
      if (!printing) throw new CardSchemaError(`Unknown printing: ${id}`);
      const binding = printing.definitionBindings.find((b) => `${b.ruleset.region}/${b.ruleset.version}` === profile.id);
      return defs.get(binding.definitionId);
    },
    handler: (id) => {
      if (!handlers.has(id)) throw new CardSchemaError(`Unknown handler: ${id}`);
      return handlers.get(id);
    },
  });
  catalogs.add(catalog);
  return catalog;
}

export function assertCatalog(catalog) {
  if (!catalogs.has(catalog)) throw new TypeError('An independently approved card catalog is required.');
}

export function validateDeck(catalog, printingIds) {
  assertCatalog(catalog);
  const fail = (message) => { throw violation(catalog.ruleset, 'deck.construction', message); };
  if (!Array.isArray(printingIds) || printingIds.length !== 60) fail('A normal deck needs exactly 60 cards.');
  const definitions = printingIds.map((id) => catalog.definitionFor(id));
  if (!definitions.some((d) => d.kind === 'pokemon' && d.mechanics.stage === 'basic')) fail('A deck needs a Basic Pokémon.');
  const counts = new Map(), limits = new Map(), groups = new Map(), groupLimits = new Map();
  for (const d of definitions) {
    counts.set(d.nameKey, (counts.get(d.nameKey) || 0) + 1);
    const limit = d.deckLimits.sameName;
    if (limits.has(d.nameKey) && limits.get(d.nameKey) !== limit) fail('Conflicting limits for the same card name.');
    limits.set(d.nameKey, limit);
    for (const group of d.deckLimits.groups) {
      if (groupLimits.has(group.key) && groupLimits.get(group.key) !== group.maximum) fail('Conflicting grouped deck limits.');
      groupLimits.set(group.key, group.maximum);
      groups.set(group.key, (groups.get(group.key) || 0) + 1);
    }
  }
  for (const [key, count] of counts) if (limits.get(key) !== null && count > limits.get(key)) fail(`Too many copies: ${key}`);
  for (const [key, count] of groups) if (count > groupLimits.get(key)) fail(`Grouped deck limit exceeded: ${key}`);
  return definitions;
}
