// Explicit reviewer step: committed, self-contained v2 shards and an
// INDEPENDENTLY INSTALLED manifest pin. No NAS/model caches except optional
// --verify-images. Never derive application trust from downloaded data.
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCNReleaseV2 } from './cn-release-v2.mjs';
import { openReviewedRelease } from '../public/rules/catalog-release.js';
import { canonicalJSON, sha256 } from '../public/rules/catalog.js';
import { validateFormatDeck } from '../public/rules/formats.js';
import * as pool from '../catalog/zh-CN/V20261019/index.mjs';
import * as released from '../catalog/zh-CN/V20261019/release-pool.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), data = join(root, 'public/data/cn/V20261019');
const built = await buildCNReleaseV2(), releaseId = built.manifest.releaseId;
const digest = await sha256(canonicalJSON(built.manifest));
const release = await openReviewedRelease({ manifestJson: built.manifestJson, trustedReleases: new Map([[releaseId, digest]]),
  readShard: async (d) => built.files.get(d.file) });
const catalog = await release.catalogFor((await release.index()).entries.map((e) => e.printingId));
if (catalog.id !== built.catalog.id) throw new Error('v2 full-pool roundtrip changed executable cards/provenance.');
const decks = Object.values(released.DECKS);
for (const deck of decks) {
  const list = released.deckList(deck.id);
  validateFormatDeck(await release.catalogFor(list), list, deck.format);
}
const pin = `// Generated at the explicit reviewer step by scripts/build-cn-release.mjs.\n` +
  `// INSTALLED trust, never read from the release being downloaded.\n` +
  `export const CN_RELEASE_ID = '${releaseId}';\n` +
  `export const TRUSTED_RELEASES = new Map([[CN_RELEASE_ID, '${digest}']]);\n`;
const outputs = new Map([...built.files].map(([file, bytes]) => [join(data, file), Buffer.from(bytes)]));
outputs.set(join(data, 'decks.json'), Buffer.from(`${JSON.stringify({ releaseId, decks, cards: released.PRESENTATION }, null, 1)}\n`));
outputs.set(join(data, 'manifest.json'), Buffer.from(built.manifestJson));
outputs.set(join(root, 'public/cn/trusted-releases.js'), Buffer.from(pin));
if (process.argv.includes('--verify-images')) {
  for (const record of pool.REVIEW_RECORDS) {
    const bytes = await readFile(join(pool.IMAGE_STORES[record.image.store], record.image.path));
    if (createHash('sha256').update(bytes).digest('hex') !== record.image.sha256)
      throw new Error(`Reviewed card image changed: ${record.printingId}`);
  }
  console.log(`Verified ${pool.REVIEW_RECORDS.length} reviewed card images.`);
}
const legacy = join(data, 'release.json');
if (process.argv.includes('--check')) {
  const stale = [];
  for (const [file, bytes] of outputs) {
    const actual = await readFile(file).catch(() => null);
    if (!actual || !actual.equals(bytes)) stale.push(file);
  }
  if (await readFile(legacy).catch(() => null)) stale.push(legacy);
  if (stale.length) throw new Error(`CN v2 outputs are stale; run npm run cn:release:\n${stale.join('\n')}`);
} else {
  const old = await readFile(join(data, 'manifest.json'), 'utf8').then(JSON.parse).catch(() => null);
  for (const [file, bytes] of outputs) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, bytes); }
  // Remove only previously referenced generated artifacts, not arbitrary files.
  const previous = [old?.index?.file, ...(old?.shards ?? []).map((s) => s.file)];
  for (const file of previous) if (typeof file === 'string' &&
      /^(?:pool-index\.[a-f0-9]{16}|shards\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.[a-f0-9]{16})\.json$/.test(file) &&
      !outputs.has(join(data, file))) await unlink(join(data, file)).catch((e) => { if (e.code !== 'ENOENT') throw e; });
  await unlink(legacy).catch((e) => { if (e.code !== 'ENOENT') throw e; });
}
console.log(`${process.argv.includes('--check') ? 'Checked' : 'Wrote'} CN v2 ${releaseId}: ` +
  `${released.DEFINITIONS.length} definitions, ${released.PRINTINGS.length} printings, ${built.manifest.shards.length} shards, pin ${digest}.`);
