// STAGED PREVIEW, not a website cutover. No NAS, model calls or secret files.
// Writes to ignored .data/release-v2-preview by default. Its separate reviewer
// pin is not imported by the active website; production remains on v1 for now.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCNReleaseV2 } from './cn-release-v2.mjs';
import { openReviewedRelease, catalogReleaseReceipt } from '../public/rules/catalog-release.js';
import { canonicalJSON, sha256 } from '../public/rules/catalog.js';
import { validateFormatDeck } from '../public/rules/formats.js';
import * as reviewed from '../catalog/zh-CN/V20261019/index.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2), outAt = args.indexOf('--out');
if (args.some((a, i) => !['--out', '--check'].includes(a) && !(outAt !== -1 && i === outAt + 1)) ||
    args.filter((a) => a === '--out').length > 1 || args.filter((a) => a === '--check').length > 1 ||
    outAt !== -1 && (!args[outAt + 1] || args[outAt + 1].startsWith('--')))
  throw new Error('Usage: node scripts/build-cn-release-v2.mjs [--check] [--out DIR]');
const out = resolve(root, outAt === -1 ? '.data/release-v2-preview' : args[outAt + 1]);
const built = await buildCNReleaseV2();
const manifestSha256 = await sha256(canonicalJSON(built.manifest));
// This script is the explicit reviewer step, like the existing v1 builder.
const trust = new Map([[built.manifest.releaseId, manifestSha256]]);
const release = await openReviewedRelease({ manifestJson: built.manifestJson, trustedReleases: trust,
  readShard: async (d) => built.files.get(d.file) });
const index = await release.index();
const catalog = await release.catalogFor(index.entries.map((e) => e.printingId));
if (catalog.id !== built.catalog.id) throw new Error('v2 roundtrip changed executable data or provenance.');
for (const deck of Object.values(reviewed.DECKS)) {
  const subset = await release.catalogFor(reviewed.deckList(deck.id));
  validateFormatDeck(subset, reviewed.deckList(deck.id), deck.format);
  if (!catalogReleaseReceipt(subset).manifestSha256) throw new Error('Missing v2 subset receipt.');
}
const pin = `// STAGED reviewer pin, NOT installed in the active v1 website.\n` +
  `export const TRUSTED_RELEASES = new Map([['${built.manifest.releaseId}', '${manifestSha256}']]);\n`;
const outputs = new Map([...built.files, ['manifest.json', new TextEncoder().encode(built.manifestJson)],
  ['trusted-releases.js', new TextEncoder().encode(pin)]]);
for (const [file, bytes] of outputs) {
  const path = join(out, file);
  if (args.includes('--check')) {
    const actual = await readFile(path).catch(() => null);
    if (!actual || !actual.equals(Buffer.from(bytes))) throw new Error(`Stale v2 preview: ${path}`);
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
}
const shardBytes = built.manifest.shards.reduce((n, s) => n + s.bytes, 0);
console.log(`${args.includes('--check') ? 'Checked' : 'Wrote'} v2 preview at ${out}: ${index.entries.length} printings, ` +
  `${built.manifest.shards.length} shards (${shardBytes} B; max ${Math.max(...built.manifest.shards.map((s) => s.bytes))} B), ` +
  `index ${built.manifest.index.bytes} B, manifest ${Buffer.byteLength(built.manifestJson)} B. ` +
  `Full roundtrip and all ${Object.keys(reviewed.DECKS).length} decks verified; active website unchanged.`);
