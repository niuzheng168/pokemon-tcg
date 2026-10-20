import { createCardCatalog, canonicalJSON, sha256, handlerContract } from './catalog.js';
import { canonicalDefinition, canonicalPrinting } from './card-schema.js';
import { validateCatalogRelease } from './schema-validators.js';
import { getRuleset } from './index.js';
import { createCoreHandlers } from './handlers.js';
import { deepFreeze } from './registry.js';
import { KERNEL_BUILD } from './kernel-build.js';

const approvedReleases = new WeakMap();
const metadataKeys = new Set(['id', 'rulesetId', 'implementationVersion', 'timing', 'usage', 'capabilities',
  'operations', 'embeddedOperations', 'costCheckVersion', 'damageRollVersion', 'parameterSchemaRef', 'sourceOfTruth']);
export class CatalogReleaseError extends TypeError {
  constructor(code, message) { super(message); this.name = 'CatalogReleaseError'; this.code = code; }
}
const fail = (code, message) => { throw new CatalogReleaseError(code, message); };
const byId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
function assertContractJSON(value, ancestors = new Set()) {
  if (value === null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value)) return;
  const invalid = () => fail('invalid-handler-contract', 'Handler contract metadata must be finite, acyclic plain JSON; configuration cannot disappear during hashing.');
  if (!value || typeof value !== 'object' || ancestors.has(value) ||
      Object.getOwnPropertySymbols(value).length ||
      (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) ||
      Array.isArray(value) && Object.keys(value).length !== value.length)
    invalid();
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') ||
        Array.isArray(value) && (!Number.isSafeInteger(Number(key)) || String(Number(key)) !== key ||
          Number(key) < 0 || Number(key) >= value.length)) invalid();
  }
  ancestors.add(value);
  for (const child of Object.values(value)) assertContractJSON(child, ancestors);
  ancestors.delete(value);
}
function unique(rows, label) {
  if (new Set(rows.map((r) => r.id)).size !== rows.length) fail('duplicate-release-id', `Duplicate ${label} identity.`);
  return rows.sort(byId);
}
function detachHandlers(handlers) {
  if (!(handlers instanceof Map)) fail('invalid-handler-registry', 'Release handlers come from an installed trusted Map, never JSON script paths.');
  return new Map([...handlers].map(([id, h]) => {
    if (!h || typeof h !== 'object' || typeof h.implementationVersion !== 'string' || !h.implementationVersion ||
        typeof h.parameterSchemaRef !== 'string' || !h.parameterSchemaRef ||
        typeof h.execute !== 'function' || typeof h.validateParameters !== 'function')
      fail('unversioned-release-handler', `Release handler needs explicit code version, parameter schema and installed functions: ${id}`);
    if (Object.entries(h).some(([key, value]) => typeof value !== 'function' && !metadataKeys.has(key)))
      fail('unknown-release-handler-metadata', `Handler configuration must be covered by the release contract: ${id}`);
    assertContractJSON(handlerContract(id, h));
    return [id, Object.freeze(Object.fromEntries(Object.entries(h)
      .map(([key, value]) => [key, typeof value === 'function' ? value : deepFreeze(structuredClone(value))])))];
  }));
}

/**
 * Review INPUTS only. This produces no approval, trust root, signature or legal
 * card pool. A reviewer must independently inspect and pin the final manifest.
 */
export async function catalogCandidateFacts({ ruleset, definitions, printings, handlers = createCoreHandlers() }) {
  const selected = structuredClone(ruleset), defs = structuredClone(definitions), prints = structuredClone(printings);
  const installed = detachHandlers(handlers), profile = getRuleset(selected);
  const definitionRows = unique(await Promise.all(defs.map(async (d) =>
    ({ id: d.definitionId, sha256: await sha256(canonicalDefinition(d)) }))), 'definition');
  const printingRows = unique(await Promise.all(prints.map(async (p) =>
    ({ id: p.printingId, sha256: await sha256(canonicalPrinting(p)) }))), 'printing');
  const handlerRows = unique(await Promise.all([...installed].map(async ([id, h]) =>
    ({ id, sha256: await sha256(canonicalJSON(handlerContract(id, h))) }))), 'handler');
  return deepFreeze({ ruleset: selected, kernelSha256: KERNEL_BUILD.kernelSha256, schemaSha256: KERNEL_BUILD.schemaSha256,
    rulesSha256: await sha256(canonicalJSON(profile)), definitions: definitionRows, printings: printingRows, handlers: handlerRows });
}

/** Load untrusted DATA under an independently installed manifest allowlist. No I/O, eval or code loading. */
export async function loadReviewedCatalogRelease({ json, trustedReleases = new Map(), handlers = createCoreHandlers(), maximumBytes = 16 * 1024 * 1024 }) {
  if (typeof json !== 'string' || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 ||
      new TextEncoder().encode(json).length > maximumBytes)
    fail('invalid-release-input', 'Release data must be JSON text within the trusted host byte budget.');
  if (!(trustedReleases instanceof Map)) fail('invalid-release-trust', 'Release approval must come from the host’s independent Map.');
  const trust = new Map(trustedReleases), installed = detachHandlers(handlers);
  let bundle;
  try { bundle = JSON.parse(json); } catch { fail('invalid-release-json', 'Malformed catalog release JSON.'); }
  if (!validateCatalogRelease(bundle)) fail('invalid-release-shape', 'Catalog release schema mismatch.');
  const { manifest, definitions, printings } = bundle;
  const digest = await sha256(canonicalJSON(manifest));
  if (trust.get(manifest.releaseId) !== digest)
    fail('unapproved-release', 'No independently installed approval for this exact manifest; a downloaded reviewed/verified claim is not authority.');
  if (manifest.kernelSha256 !== KERNEL_BUILD.kernelSha256 || manifest.schemaSha256 !== KERNEL_BUILD.schemaSha256)
    fail('incompatible-release-build', 'Reviewed release targets another installed kernel or schema build.');
  const facts = await catalogCandidateFacts({ ruleset: manifest.ruleset, definitions, printings, handlers: installed });
  if (manifest.rulesSha256 !== facts.rulesSha256) fail('incompatible-release-rules', 'Reviewed rules/source snapshot changed.');
  for (const key of ['definitions', 'printings', 'handlers']) {
    const pins = unique(structuredClone(manifest[key]), key);
    if (canonicalJSON(pins) !== canonicalJSON(facts[key]))
      fail('release-content-mismatch', `Reviewed ${key} set/content does not match the provided payload or installed registry.`);
  }
  const approvedDefinitions = new Map(definitions.map((d) => [d.definitionId, canonicalDefinition(d)]));
  const approvedPrintings = new Map(printings.map((p) => [p.printingId, canonicalPrinting(p)]));
  const catalog = await createCardCatalog({ ruleset: manifest.ruleset, definitions, printings,
    approvedDefinitions, approvedPrintings, handlers: installed });
  approvedReleases.set(catalog, deepFreeze({ releaseId: manifest.releaseId, sha256: digest,
    catalogId: catalog.id, kernelSha256: manifest.kernelSha256, schemaSha256: manifest.schemaSha256,
    rulesSha256: manifest.rulesSha256, review: structuredClone(manifest.review) }));
  return catalog;
}

export function catalogReleaseReceipt(catalog) {
  if (!approvedReleases.has(catalog)) fail('unapproved-release-catalog', 'A low-level/development catalog is not an approved release.');
  return approvedReleases.get(catalog);
}
