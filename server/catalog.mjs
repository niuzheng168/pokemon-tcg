// The reviewed card release the server checks saved decks against: the same file and installed trust pin the
// website loads, verified the same way.
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadReviewedCatalogRelease } from '../public/rules/catalog-release.js';
import { TRUSTED_RELEASES } from '../public/cn/trusted-releases.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function loadCatalog() {
  const json = await readFile(join(ROOT, 'public/data/cn/V20261019/release.json'), 'utf8');
  return loadReviewedCatalogRelease({ json, trustedReleases: TRUSTED_RELEASES });
}
