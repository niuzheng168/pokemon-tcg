// Installed CN release / host transport. Evidence URLs are never fetched here.
import { openReviewedRelease } from './rules/catalog-release.js';
import { TRUSTED_RELEASES } from './cn/trusted-releases.js';

export const DATA = 'data/cn/V20261019/';
export async function responseBytes(response, maximumBytes) {
  if (!response.ok) throw new Error(`Release HTTP ${response.status}`);
  if (!response.body) throw new Error('Release response has no readable body.');
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new Error('Release download exceeds its byte budget.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function openCNRelease({ fetcher = globalThis.fetch, base = DATA, tiers } = {}) {
  const bytes = await responseBytes(await fetcher(base + 'manifest.json', { cache: 'no-cache', credentials: 'same-origin' }), 1024 * 1024);
  const manifestJson = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  return openReviewedRelease({ manifestJson, trustedReleases: TRUSTED_RELEASES, tiers,
    readShard: async (d) => responseBytes(await fetcher(base + d.file, { credentials: 'same-origin' }), d.bytes) });
}
