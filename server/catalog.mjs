// The same independently pinned v2 release as the browser. Startup reads the
// manifest/index; deck admission and record identity load only their subsets.
import { open } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openReviewedRelease } from '../public/rules/catalog-release.js';
import { TRUSTED_RELEASES } from '../public/cn/trusted-releases.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function boundedFile(path, maximumBytes) {
  const file = await open(path, 'r'), bytes = Buffer.alloc(maximumBytes + 1);
  let length = 0;
  try {
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
  } finally { await file.close(); }
  if (length > maximumBytes) throw new Error('Release file exceeds its byte budget.');
  return bytes.subarray(0, length);
}

export async function loadRelease({ directory = join(ROOT, 'public/data/cn/V20261019'), tiers } = {}) {
  const bytes = await boundedFile(join(directory, 'manifest.json'), 1024 * 1024);
  return openReviewedRelease({ manifestJson: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
    trustedReleases: TRUSTED_RELEASES, tiers, readShard: (d) => boundedFile(join(directory, d.file), d.bytes) });
}

/** Whole-pool tooling/tests ONLY; web/server startup and games use loadRelease + catalogFor. */
export async function loadCatalog() {
  const release = await loadRelease();
  return release.catalogFor((await release.index()).entries.map((e) => e.printingId));
}
