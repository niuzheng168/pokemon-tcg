import { createCardCatalog, canonicalJSON, sha256, handlerContract } from './catalog.js';
import { canonicalDefinition, canonicalPrinting, assertDefinitionShape, assertPrintingShape, assertPrintingBinding } from './card-schema.js';
import { validateCatalogRelease, validateCatalogManifest, validateCatalogShard, validateCatalogIndex } from './schema-validators.js';
import { getRuleset } from './index.js';
import { createCoreHandlers } from './handlers.js';
import { deepFreeze } from './registry.js';
import { KERNEL_BUILD } from './kernel-build.js';
import { resolveEvidenceRefs } from './release-evidence.js';
import { releaseIndexEntry, decodeReleaseIndex } from './release-index.js';
import jsonEqual from './json-equal.js';

const approvedReleases = new WeakMap();
const releaseSessions = new WeakSet();
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

/** Explicit v1 development/test compatibility only; the CN app installs no v1 pin or bundle. No automatic fallback. */
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

/** Compare recorded identity with fresh independent admission, never use a saved receipt as authority. */
export function checkCatalogReleaseReceipt(catalog, recorded) {
  const current = catalogReleaseReceipt(catalog);
  if (!recorded || !jsonEqual(recorded, recorded) ||
      !['releaseId', 'manifestSha256', 'catalogId', 'kernelSha256', 'schemaSha256', 'rulesSha256']
        .every((key) => typeof recorded[key] === 'string' && (key === 'releaseId' ? recorded[key].length > 0 : /^[a-f0-9]{64}$/.test(recorded[key]))))
    fail('invalid-recorded-release', 'Missing or malformed recorded v2 release identity.');
  for (const key of ['releaseId', 'catalogId', 'kernelSha256', 'schemaSha256', 'rulesSha256'])
    if (current[key] !== recorded[key])
      fail('incompatible-recorded-release', `Recorded ${key} differs from the independently admitted subset; use its original build/release.`);
  // Unrelated pool updates may change the manifest without changing this
  // subset. Report that distinction explicitly instead of invalidating saves.
  return Object.freeze({ manifestChanged: current.manifestSha256 !== recorded.manifestSha256 });
}

function assertBudget(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail('invalid-release-input', 'Release byte budgets must be positive safe integers.');
}

/** Parsed only AFTER hashing the exact downloaded bytes, not a reserialized JSON value. */
async function readReleaseFile(descriptor, maximumBytes, readShard) {
  if (descriptor.bytes > maximumBytes) fail('release-file-budget', 'The pinned file exceeds the installed host byte budget.');
  const downloaded = await readShard(descriptor);
  if (!(downloaded instanceof Uint8Array) || downloaded.byteLength !== descriptor.bytes)
    fail('invalid-release-file', 'Release readers must return exactly the pinned number of raw bytes as a Uint8Array.');
  // Detach before the async digest: a host-owned Buffer must not change what is
  // parsed after the bytes have been authenticated.
  const bytes = new Uint8Array(downloaded);
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((n) => n.toString(16).padStart(2, '0')).join('');
  if (digest !== descriptor.sha256) fail('release-file-digest', 'Raw release file bytes do not match the pinned SHA-256.');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch { fail('invalid-release-file-json', 'Release files must be strict UTF-8 JSON.'); }
  return value;
}

function shardRecords(wire, descriptor, ruleset) {
  if (!validateCatalogShard(wire) || wire.shardId !== descriptor.shardId || wire.setCode !== descriptor.setCode)
    fail('invalid-release-shard', 'Shard envelope or identity does not match the manifest.');
  const records = resolveEvidenceRefs([...wire.definitions, ...wire.printings], wire.sources);
  const definitions = records.slice(0, wire.definitions.length), printings = records.slice(wire.definitions.length);
  const defs = new Map(), prints = new Map(), used = new Set(), counts = { reviewed: 0, machine: 0 };
  for (const d of definitions) {
    assertDefinitionShape(d);
    if (defs.has(d.definitionId)) fail('duplicate-release-id', 'Duplicate definition in shard.');
    defs.set(d.definitionId, d);
  }
  for (const p of printings) {
    assertPrintingShape(p);
    const bindings = p.definitionBindings.filter((b) => canonicalJSON(b.ruleset) === canonicalJSON(ruleset));
    if (prints.has(p.printingId)) fail('duplicate-release-id', 'Duplicate printing in shard.');
    if (p.setCode !== descriptor.setCode || bindings.length !== 1 || !defs.has(bindings[0].definitionId))
      fail('release-shard-binding', 'Every shard printing must belong to its set and bind one self-contained definition.');
    const d = defs.get(bindings[0].definitionId);
    assertPrintingBinding(p, d, ruleset);
    used.add(d.definitionId);
    counts[p.identityReview === 'machine' || d.implementation.tier === 'machine' ? 'machine' : 'reviewed']++;
    prints.set(p.printingId, p);
  }
  if (defs.size !== descriptor.definitions || used.size !== defs.size ||
      canonicalJSON(counts) !== canonicalJSON(descriptor.printings))
    fail('release-shard-counts', 'Shard counts, tiers or unused definitions disagree with the manifest.');
  return deepFreeze({ definitions, printings });
}

/**
 * v2 application admission. The separate v1 helper remains for explicit
 * development/security fixtures; it is not a downloaded-format fallback.
 * readShard is installed host I/O for BOTH index and shard descriptors; DATA
 * cannot install readers/handlers or script URLs. index() returns pinned hints,
 * catalogFor() alone admits complete executable cards under the tier policy.
 */
export async function openReviewedRelease({
  manifestJson, trustedReleases = new Map(), handlers = createCoreHandlers(), readShard,
  tiers = ['reviewed', 'machine'],
  maximumManifestBytes = 1024 * 1024, maximumShardBytes = 4 * 1024 * 1024, maximumIndexBytes = 8 * 1024 * 1024,
}) {
  for (const budget of [maximumManifestBytes, maximumShardBytes, maximumIndexBytes]) assertBudget(budget);
  if (typeof manifestJson !== 'string' || new TextEncoder().encode(manifestJson).length > maximumManifestBytes)
    fail('invalid-release-input', 'The v2 manifest must be JSON text within the installed host byte budget.');
  if (!(trustedReleases instanceof Map)) fail('invalid-release-trust', 'Release approval must come from the host’s independent Map.');
  if (typeof readShard !== 'function') fail('invalid-release-reader', 'An installed raw-byte file reader is required.');
  if (!Array.isArray(tiers) || !jsonEqual(tiers, tiers) || !tiers.length || new Set(tiers).size !== tiers.length ||
      tiers.some((t) => !['reviewed', 'machine'].includes(t)))
    fail('invalid-release-tiers', 'The host must explicitly select reviewed and/or machine tiers without duplicates.');
  const trust = new Map(trustedReleases), installed = detachHandlers(handlers), policy = new Set(tiers);
  let manifest;
  try { manifest = JSON.parse(manifestJson); } catch { fail('invalid-release-json', 'Malformed v2 manifest JSON.'); }
  if (!validateCatalogManifest(manifest)) fail('invalid-release-shape', 'v2 manifest schema mismatch.');
  deepFreeze(manifest);
  const digest = await sha256(canonicalJSON(manifest));
  if (trust.get(manifest.releaseId) !== digest) fail('unapproved-release', 'No independently installed approval for this exact v2 manifest.');
  if (manifest.kernelSha256 !== KERNEL_BUILD.kernelSha256 || manifest.schemaSha256 !== KERNEL_BUILD.schemaSha256)
    fail('incompatible-release-build', 'Reviewed release targets another installed kernel or schema build.');
  const facts = await catalogCandidateFacts({ ruleset: manifest.ruleset, definitions: [], printings: [], handlers: installed });
  if (manifest.rulesSha256 !== facts.rulesSha256) fail('incompatible-release-rules', 'Reviewed rules/source snapshot changed.');
  if (canonicalJSON(unique(structuredClone(manifest.handlers), 'handler')) !== canonicalJSON(facts.handlers))
    fail('release-content-mismatch', 'The installed handler registry differs from the v2 manifest pins.');

  const descriptors = new Map(), totals = { reviewed: 0, machine: 0 };
  for (const s of manifest.shards) {
    if (descriptors.has(s.shardId)) fail('duplicate-release-id', 'Duplicate manifest shard.');
    if (s.shardId !== s.setCode || s.file !== `shards/${s.setCode}.${s.sha256.slice(0, 16)}.json` ||
        s.printings.reviewed + s.printings.machine < 1)
      fail('invalid-release-descriptor', 'Each set has one nonempty, content-addressed shard.');
    descriptors.set(s.shardId, s);
    for (const tier of ['reviewed', 'machine']) totals[tier] += s.printings[tier];
  }
  if (manifest.index.file !== `pool-index.${manifest.index.sha256.slice(0, 16)}.json` ||
      manifest.index.printings !== totals.reviewed + totals.machine)
    fail('invalid-release-descriptor', 'Index identity and total printing count must match the manifest.');
  const reviewedTiers = new Set();
  for (const r of manifest.reviews) {
    if (reviewedTiers.has(r.tier)) fail('duplicate-release-id', 'Duplicate tier review.');
    if (r.pipeline && r.pipeline.gold.matched > r.pipeline.gold.total)
      fail('invalid-release-review', 'A pipeline gold result cannot exceed its sample count.');
    reviewedTiers.add(r.tier);
  }
  if (Object.entries(totals).some(([tier, n]) => n && !reviewedTiers.has(tier)))
    fail('invalid-release-review', 'Every included tier needs its own pinned review/provenance.');

  const cache = new Map();
  function cached(key, load) {
    if (!cache.has(key)) {
      const task = load().catch((error) => { cache.delete(key); throw error; });
      cache.set(key, task);
    }
    return cache.get(key);
  }
  function loadIndex() {
    return cached('index', async () => {
      const wire = await readReleaseFile(manifest.index, maximumIndexBytes, readShard);
      if (!validateCatalogIndex(wire) || canonicalJSON(wire.ruleset) !== canonicalJSON(manifest.ruleset) ||
          wire.entries.length !== manifest.index.printings)
        fail('invalid-release-index', 'Index schema, ruleset or count disagrees with the manifest.');
      let data;
      try { data = decodeReleaseIndex(wire); } catch (error) { fail('invalid-release-index', error.message); }
      const byId = new Map(), counts = new Map([...descriptors.keys()].map((id) => [id, { reviewed: 0, machine: 0 }]));
      for (const entry of data.entries) {
        if (byId.has(entry.printingId)) fail('duplicate-release-id', 'Duplicate index printing.');
        if (!descriptors.has(entry.shardId) || entry.printing.setCode !== descriptors.get(entry.shardId).setCode)
          fail('invalid-release-index', 'Index entries must route to their own pinned set shard.');
        byId.set(entry.printingId, entry);
        counts.get(entry.shardId)[entry.tier]++;
      }
      for (const entry of data.entries)
        if (entry.latestPrintingIds.some((id) => !byId.has(id)))
          fail('invalid-release-index', 'Latest-text anchors must exist in the pinned index.');
      for (const [id, count] of counts)
        if (canonicalJSON(count) !== canonicalJSON(descriptors.get(id).printings))
          fail('invalid-release-index', 'Index per-shard tier counts disagree with the manifest.');
      return { data: deepFreeze(data), byId };
    });
  }
  function loadShard(descriptor) {
    return cached(`shard:${descriptor.shardId}`, async () =>
      shardRecords(await readReleaseFile(descriptor, maximumShardBytes, readShard), descriptor, manifest.ruleset));
  }
  async function catalogFor(printingIds) {
    // Detach caller selection before any asynchronous I/O.
    if (!Array.isArray(printingIds) || !jsonEqual(printingIds, printingIds) || !printingIds.length ||
        printingIds.some((id) => typeof id !== 'string'))
      fail('invalid-release-selection', 'A nonempty array of printing IDs is required.');
    const selected = new Set(printingIds), { byId } = await loadIndex(), needed = new Set();
    // Set iteration visits newly added anchors, giving a deterministic finite
    // transitive closure even for cycles/self-reviews. Never load unrelated sets.
    for (const id of selected) {
      const entry = byId.get(id);
      if (!entry) fail('unknown-release-printing', `Printing is not in the pinned release: ${id}`);
      if (!policy.has(entry.tier)) fail('release-tier-denied', `The installed host policy does not admit ${entry.tier} cards.`);
      needed.add(entry.shardId);
      entry.latestPrintingIds.forEach((anchor) => selected.add(anchor));
    }
    const shardIds = [...needed].sort(), rows = await Promise.all(shardIds.map((id) => loadShard(descriptors.get(id))));
    const defs = new Map(), prints = new Map();
    for (let i = 0; i < rows.length; i++) {
      for (const d of rows[i].definitions) {
        if (defs.has(d.definitionId) && canonicalDefinition(defs.get(d.definitionId)) !== canonicalDefinition(d))
          fail('release-definition-conflict', 'Reprint definitions in loaded shards must be identical.');
        defs.set(d.definitionId, d);
      }
      for (const p of rows[i].printings) {
        if (!byId.has(p.printingId) || byId.get(p.printingId).shardId !== shardIds[i])
          fail('release-index-mismatch', 'Shard printings disagree with the pinned routing index.');
        prints.set(p.printingId, p);
      }
    }
    // Unique per-shard printings, equal counts and exact index routing establish
    // a bijection: every selected ID is now present, with no unindexed extras.
    const printings = [...selected].sort().map((id) => prints.get(id));
    const definitionIds = new Set(printings.map((p) =>
      p.definitionBindings.find((b) => canonicalJSON(b.ruleset) === canonicalJSON(manifest.ruleset)).definitionId));
    const definitions = [...definitionIds].sort().map((id) => defs.get(id));
    const catalog = await createCardCatalog({ ruleset: manifest.ruleset, definitions, printings, handlers: installed,
      approvedDefinitions: new Map(definitions.map((d) => [d.definitionId, canonicalDefinition(d)])),
      approvedPrintings: new Map(printings.map((p) => [p.printingId, canonicalPrinting(p)])) });
    for (const p of printings)
      if (canonicalJSON(releaseIndexEntry(catalog, p.printingId, byId.get(p.printingId).shardId)) !== canonicalJSON(byId.get(p.printingId)))
        fail('release-index-mismatch', 'Indexed identity, definition, quality, anchors or deck facts disagree with executable cards.');
    const usedTiers = ['reviewed', 'machine'].filter((t) => printings.some((p) => byId.get(p.printingId).tier === t));
    approvedReleases.set(catalog, deepFreeze({ schemaVersion: '2.0.0', releaseId: manifest.releaseId,
      sha256: digest, manifestSha256: digest, catalogId: catalog.id, kernelSha256: manifest.kernelSha256,
      schemaSha256: manifest.schemaSha256, rulesSha256: manifest.rulesSha256, tiers: usedTiers,
      shards: shardIds.map((id) => ({ shardId: id, sha256: descriptors.get(id).sha256 })),
      reviews: manifest.reviews.filter((r) => usedTiers.includes(r.tier)), printingIds: printings.map((p) => p.printingId) }));
    return catalog;
  }
  const release = Object.freeze({ releaseId: manifest.releaseId, manifestSha256: digest,
    ruleset: manifest.ruleset, tiers: Object.freeze([...policy].sort()),
    index: async () => (await loadIndex()).data, catalogFor });
  releaseSessions.add(release);
  return release;
}

export function assertReviewedRelease(release) {
  if (!releaseSessions.has(release)) fail('unapproved-release-session', 'An independently pinned v2 release session is required.');
}
