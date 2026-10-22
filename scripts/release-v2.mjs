// Deterministic reviewer INPUTS only. This module does not install trust pins.
// The installed application's allowlist must remain independent of downloads.
import { createHash } from 'node:crypto';
import { createCardCatalog, canonicalJSON } from '../public/rules/catalog.js';
import { canonicalDefinition, canonicalPrinting } from '../public/rules/card-schema.js';
import { catalogCandidateFacts } from '../public/rules/catalog-release.js';
import { createCoreHandlers } from '../public/rules/handlers.js';
import { encodeEvidenceRefs } from '../public/rules/release-evidence.js';
import { releaseIndexEntry, encodeReleaseIndex } from '../public/rules/release-index.js';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const encode = (value) => new TextEncoder().encode(`${canonicalJSON(value)}\n`);
const sortId = (key) => (a, b) => a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0;

export async function buildReleaseV2({ releaseId, ruleset, definitions, printings, reviews, handlers = createCoreHandlers() }) {
  const input = structuredClone({ releaseId, ruleset, definitions, printings, reviews });
  const facts = await catalogCandidateFacts({ ...input, handlers });
  // Whole-pool admission is deliberate here. Subset loaders cannot establish
  // global name identity or evolution ancestry across unrelated shards.
  const catalog = await createCardCatalog({ ...input, handlers,
    approvedDefinitions: new Map(input.definitions.map((d) => [d.definitionId, canonicalDefinition(d)])),
    approvedPrintings: new Map(input.printings.map((p) => [p.printingId, canonicalPrinting(p)])) });
  const groups = new Map(), used = new Set(), files = new Map(), shards = [];
  for (const p of catalog.printings().sort(sortId('printingId'))) {
    if (!groups.has(p.setCode)) groups.set(p.setCode, []);
    groups.get(p.setCode).push(p);
    used.add(catalog.definitionFor(p.printingId).definitionId);
  }
  if (used.size !== catalog.definitions().length) throw new Error('A release cannot silently omit unused definitions.');
  for (const [setCode, prints] of [...groups].sort(([a], [b]) => a < b ? -1 : 1)) {
    const defs = [...new Map(prints.map((p) => {
      const d = catalog.definitionFor(p.printingId); return [d.definitionId, d];
    })).values()].sort(sortId('definitionId'));
    const compressed = encodeEvidenceRefs([...defs, ...prints]);
    const wire = { schemaVersion: '2.0.0', shardId: setCode, setCode, sources: compressed.sources,
      definitions: compressed.records.slice(0, defs.length), printings: compressed.records.slice(defs.length) };
    const bytes = encode(wire), sha256 = digest(bytes), file = `shards/${setCode}.${sha256.slice(0, 16)}.json`;
    const counts = { reviewed: 0, machine: 0 };
    for (const p of prints) counts[releaseIndexEntry(catalog, p.printingId, setCode).tier]++;
    files.set(file, bytes);
    shards.push({ shardId: setCode, setCode, file, sha256, bytes: bytes.length, definitions: defs.length, printings: counts });
  }
  const index = encodeReleaseIndex({ ruleset: input.ruleset,
    entries: catalog.printings().sort(sortId('printingId')).map((p) => releaseIndexEntry(catalog, p.printingId, p.setCode)) });
  const indexBytes = encode(index), indexDigest = digest(indexBytes), indexFile = `pool-index.${indexDigest.slice(0, 16)}.json`;
  files.set(indexFile, indexBytes);
  const manifest = { schemaVersion: '2.0.0', releaseId: input.releaseId, ruleset: input.ruleset,
    kernelSha256: facts.kernelSha256, schemaSha256: facts.schemaSha256, rulesSha256: facts.rulesSha256,
    handlers: facts.handlers, shards,
    index: { file: indexFile, sha256: indexDigest, bytes: indexBytes.length, printings: index.entries.length },
    reviews: input.reviews };
  return { manifest, manifestJson: `${canonicalJSON(manifest)}\n`, files, catalog };
}
