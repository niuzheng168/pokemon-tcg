// Original source bytes remain in the ignored cache, not in the MIT bundle.
// Hashes are pinned to reviewed bytes; never accept a changed download as "latest".
import { createHash } from 'node:crypto';
import { readFile, mkdir, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CN_V20261019 } from '../public/rules/zh-CN/V20261019.js';
import { approvedSourceHosts } from '../public/rules/registry.js';

export const defaultSourceCache = fileURLToPath(new URL('../.cache/rules/sources/', import.meta.url));

function sourceMedia(document) {
  const mediaType = document.mediaType ?? 'application/pdf';
  if (!['application/pdf', 'text/html'].includes(mediaType)) throw new Error(`Unsupported source media: ${document.id}`);
  return mediaType;
}

export function verifySourceBytes(document, bytes) {
  if (document.evidence?.binaryVerification !== 'verified' || !/^[a-f0-9]{64}$/.test(document.sha256) ||
      !Number.isSafeInteger(document.byteLength) || document.byteLength < 1)
    throw new Error(`Source is not binary-pinned: ${document.id}`);
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Source bytes must be a byte array.');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const header = Buffer.from(bytes.subarray(0, 32)).toString('ascii');
  const isExpectedMedia = sourceMedia(document) === 'application/pdf' ? header.startsWith('%PDF-') : /^<!doctype html>/i.test(header);
  if (bytes.length !== document.byteLength || digest !== document.sha256 ||
      !isExpectedMedia)
    throw new Error(`Official source bytes do not match the reviewed snapshot: ${document.id}`);
  return { documentId: document.id, sha256: digest, byteLength: bytes.length };
}

export function sourceCachePath(document, directory = defaultSourceCache) {
  if (!/^[a-f0-9]{64}$/.test(document.sha256)) throw new Error('A pinned fingerprint is required for the cache path.');
  return join(directory, `${encodeURIComponent(document.id)}-${document.sha256}.${sourceMedia(document) === 'application/pdf' ? 'pdf' : 'html'}`);
}

export async function checkRuleSources({
  ruleset = CN_V20261019, directory = defaultSourceCache, download = false, fetcher = fetch,
} = {}) {
  const receipts = [];
  for (const document of ruleset.documents.filter((d) => d.evidence.binaryVerification === 'verified')) {
    const path = sourceCachePath(document, directory);
    let bytes;
    try { bytes = await readFile(path); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      if (!download) throw new Error(`Missing pinned source ${document.id}; run npm run rules:sources:download.`);
      const url = new URL(document.url);
      if (url.protocol !== 'https:' || !approvedSourceHosts(document).includes(url.hostname) || url.username || url.password || url.port)
        throw new Error(`Refusing a non-official source URL: ${document.id}`);
      const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Official source download failed (${response.status}): ${document.id}`);
      bytes = new Uint8Array(await response.arrayBuffer());
      verifySourceBytes(document, bytes);
      await mkdir(directory, { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, path); }
      finally { await unlink(temporary).catch((e) => { if (e.code !== 'ENOENT') throw e; }); }
    }
    receipts.push(verifySourceBytes(document, bytes));
  }
  return receipts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== '--download')) throw new Error('Usage: node scripts/check-rules-sources.mjs [--download]');
  const receipts = await checkRuleSources({ download: args.includes('--download') });
  for (const r of receipts) console.log(`${r.documentId}: ${r.byteLength} bytes, SHA-256 ${r.sha256}`);
  console.log(`Verified ${receipts.length} pinned original sources (PDF/HTML). Unpinned pages remain unverified; changed dynamic HTML is never auto-approved.`);
}
