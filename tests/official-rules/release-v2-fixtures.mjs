// Synthetic release/adversarial fixtures ONLY, never production approvals.
import { createHash } from 'node:crypto';
import { buildReleaseV2 } from '../../scripts/release-v2.mjs';
import { openReviewedRelease } from '../../public/rules/catalog-release.js';
import { canonicalJSON, sha256 } from '../../public/rules/catalog.js';
import { fixture, RULESET, EVIDENCE } from './fixtures.mjs';

export const review = (tier) => ({
  tier, review: { reviewId: `fixture:${tier}`, reviewerId: 'fixture:NOT-A-REAL-REVIEW',
    reviewedOn: '2026-10-22', testIds: ['fixture:release-v2'], sourceOfTruth: EVIDENCE },
  ...(tier === 'machine' ? { pipeline: { id: 'fixture:pipeline', inputSha256: 'a'.repeat(64), models: ['fixture:model'],
    gold: { scope: 'synthetic fixture', total: 1, matched: 1 } } } : {}),
});

export async function bundle() {
  const f = await fixture((defs) => { defs[1].implementation.tier = 'machine'; });
  const definitions = structuredClone(f.definitions);
  const printings = structuredClone(f.catalog.printings()).map((p, i) => ({
    ...p, setCode: i < 6 ? 'ALPHA' : 'BETA', series: 'scarlet-violet', releasedOn: '2026-10-01',
  }));
  const reprint = { ...structuredClone(printings[0]), printingId: 'printing:reprint', setCode: 'BETA',
    number: '99/999', identityReview: 'machine' };
  const old = { ...structuredClone(printings[0]), printingId: 'printing:old', setCode: 'OLD',
    number: '98/999', series: 'sun-moon', regulationMark: 'D',
    formatReviews: [{ format: { ...RULESET, id: 'open' }, latestPrintingId: 'printing:base', sourceOfTruth: EVIDENCE }] };
  printings.push(reprint, old);
  const built = await buildReleaseV2({ releaseId: 'fixture:NOT-A-REAL-V2-RELEASE', ruleset: RULESET,
    definitions, printings, handlers: f.handlers, reviews: [review('reviewed'), review('machine')] });
  return { f, input: { definitions, printings }, manifest: structuredClone(built.manifest),
    files: new Map([...built.files].map(([file, bytes]) => [file, new Uint8Array(bytes)])), fullCatalog: built.catalog };
}

export async function open(b, options = {}) {
  return openReviewedRelease({ manifestJson: JSON.stringify(b.manifest), handlers: b.f.handlers,
    trustedReleases: new Map([[b.manifest.releaseId, await sha256(canonicalJSON(b.manifest))]]),
    readShard: async (d) => b.files.get(d.file), ...options });
}

export function rewrite(b, descriptor, value, raw = false) {
  const oldFile = descriptor.file, bytes = raw ? new Uint8Array(value) : new TextEncoder().encode(JSON.stringify(value));
  descriptor.sha256 = createHash('sha256').update(bytes).digest('hex');
  descriptor.bytes = bytes.length;
  descriptor.file = descriptor.shardId ? `shards/${descriptor.setCode}.${descriptor.sha256.slice(0, 16)}.json`
    : `pool-index.${descriptor.sha256.slice(0, 16)}.json`;
  b.files.delete(oldFile);
  b.files.set(descriptor.file, bytes);
}
export const jsonFile = (b, descriptor) => JSON.parse(new TextDecoder().decode(b.files.get(descriptor.file)));
