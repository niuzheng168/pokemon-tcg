// Auth is enforced by app.mjs BEFORE this handler, even on a 304. All caching
// is private; content-named files are immutable, manifests remain revalidated.
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';

const RELEASE_FILE = /^\/play\/data\/cn\/V\d{8}\/(manifest\.json|decks\.json|pool-index\.[a-f0-9]{16}\.json|shards\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.[a-f0-9]{16}\.json)$/;
const accepts = (header, encoding) => String(header).split(',').some((entry) => {
  const [name, ...params] = entry.trim().split(';');
  return name === encoding && !params.some((p) => /^\s*q\s*=\s*0(?:\.0*)?\s*$/i.test(p));
});

export function releaseFiles() {
  const cache = new Map();
  return async (req, res, file, urlPath) => {
    const match = RELEASE_FILE.exec(urlPath);
    if (!match) return false;
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return false;
    let entry = cache.get(file);
    if (!entry || entry.size !== info.size || entry.mtime !== info.mtimeMs || entry.ctime !== info.ctimeMs) {
      const bytes = await readFile(file);
      entry = { size: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs, bytes,
        etag: `W/"${createHash('sha256').update(bytes).digest('hex')}"`,
        br: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }), gzip: gzipSync(bytes, { level: 6 }) };
      cache.delete(file);
      cache.set(file, entry);
      if (cache.size > 128) cache.delete(cache.keys().next().value);
    }
    const encoding = ['br', 'gzip'].find((name) => accepts(req.headers['accept-encoding'] ?? '', name));
    const headers = { 'Content-Type': 'application/json; charset=utf-8', ETag: entry.etag, Vary: 'Accept-Encoding',
      'Cache-Control': /^manifest|^decks/.test(match[1]) ? 'private, no-cache' : 'private, max-age=31536000, immutable' };
    if (encoding) headers['Content-Encoding'] = encoding;
    if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304, headers).end(); return true; }
    res.writeHead(200, headers).end(req.method === 'HEAD' ? undefined : encoding ? entry[encoding] : entry.bytes);
    return true;
  };
}
