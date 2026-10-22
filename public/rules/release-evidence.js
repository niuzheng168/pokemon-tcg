// Transport compression only, NOT approval. All runtime evidence schemas stay
// strict: callers must validate the expanded cards before admitting execution.
import { validateEvidenceRef, validateCardEvidence } from './schema-validators.js';
import { canonicalJSON } from './catalog.js';
import jsonEqual from './json-equal.js';

export class EvidenceReferenceError extends TypeError {
  constructor(message) { super(message); this.name = 'EvidenceReferenceError'; }
}
const fail = (message) => { throw new EvidenceReferenceError(message); };

function assertRecords(records) {
  if (!Array.isArray(records) || !jsonEqual(records, records) ||
      records.some((r) => !r || typeof r !== 'object' || Array.isArray(r)))
    fail('Evidence records must be an array of finite, acyclic plain JSON objects.');
}

// sourceOfTruth is the reserved evidence-list field throughout the card
// schemas (including handler parameters). Do not reinterpret evidence-shaped
// ordinary data at other keys, nor replace sourceId fields indiscriminately.
function transform(value, entry) {
  if (Array.isArray(value)) return value.map((v) => transform(v, entry));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (key !== 'sourceOfTruth') return [key, transform(child, entry)];
    if (!Array.isArray(child) || !child.length) fail('sourceOfTruth must be a nonempty evidence list.');
    return [key, child.map(entry)];
  }));
}

/** Deterministic, detached wire records and source table; conflicting source IDs fail closed. */
export function encodeEvidenceRefs(records) {
  assertRecords(records);
  const sources = new Map();
  const encoded = transform(records, (source) => {
    if (!validateCardEvidence(source)) fail('Only complete, exact-host evidence can be compressed.');
    if (sources.has(source.sourceId) && canonicalJSON(sources.get(source.sourceId)) !== canonicalJSON(source))
      fail(`Conflicting content for evidence source ID: ${source.sourceId}`);
    sources.set(source.sourceId, structuredClone(source));
    return { sourceId: source.sourceId, kind: source.kind };
  });
  return { records: encoded, sources: Object.fromEntries([...sources].sort(([a], [b]) => a < b ? -1 : 1)) };
}

/** Expand wire references before existing card/executable validation. Never invent missing evidence. */
export function resolveEvidenceRefs(records, sources) {
  assertRecords(records);
  if (!sources || typeof sources !== 'object' || Array.isArray(sources) || !jsonEqual(sources, sources))
    fail('The evidence source table must be a plain JSON object.');
  const table = new Map(Object.entries(sources)), used = new Set();
  for (const [id, source] of table)
    if (!validateCardEvidence(source) || id !== source.sourceId)
      fail('Every source-table key must equal its complete, exact-host evidence source ID.');
  const expanded = transform(records, (ref) => {
    if (!validateEvidenceRef(ref)) fail('Wire evidence must be an exact sourceId/kind reference.');
    const source = table.get(ref.sourceId);
    if (!source) fail(`Unresolved evidence reference: ${ref.sourceId}`);
    if (ref.kind !== source.kind) fail(`Evidence reference kind mismatch: ${ref.sourceId}`);
    used.add(ref.sourceId);
    return structuredClone(source);
  });
  if (used.size !== table.size) fail('Unreferenced evidence in the source table.');
  return expanded;
}
