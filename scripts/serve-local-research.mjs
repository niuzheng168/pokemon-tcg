// Restricted research pictures are deliberately outside public/ and site/.
// This server is loopback-only and never starts a local/cloud decision model.
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const site = resolve(process.env.RESEARCH_SITE_ROOT || resolve(repo, 'site'));
const currentManifest = resolve(repo, 'tools/52poke-cards/data/local-research/academy-private-scans.json');
const legacyManifest = resolve(repo, '../52poke-cards/data/local-research/academy-private-scans.json');
const manifestPath = resolve(process.env.TCG_RESEARCH_MANIFEST
  || (existsSync(currentManifest) ? currentManifest : existsSync(legacyManifest) ? legacyManifest : currentManifest));
const port = Number(process.env.PORT || 8795);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

function localRequest(req) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return false;
  let host;
  try { host = new URL('http://' + req.headers.host); } catch { return false; }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (req.headers.origin && req.headers.origin !== host.origin) return false;
  return true;
}

async function manifest() {
  const result = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (result.version !== 1 || result.local_only !== true || result.redistribution_permitted !== false) {
    throw new Error('An explicit local-only research manifest is required.');
  }
  return result;
}

createServer(async (req, res) => {
  try {
    if (!localRequest(req)) return send(res, 403, { error: 'Local research access only.' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Read only.' });
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/research-scans') {
      const data = await manifest();
      const cards = {};
      for (const [id, card] of Object.entries(data.cards)) {
        if (!/^[a-f0-9]{64}$/.test(card.asset) || !data.assets[card.asset] || card.language !== 'zh-Hans') continue;
        cards[id] = { url: `/api/research-card/${card.asset}.png`, label: '简体卡图（仅本地研究）', language: 'zh-Hans' };
      }
      return send(res, 200, { local_only: true, redistribution_permitted: false, cards });
    }
    if (url.pathname.startsWith('/api/research-card/')) {
      const key = /^\/api\/research-card\/([a-f0-9]{64})\.png$/.exec(url.pathname)?.[1];
      const data = await manifest(), asset = key && data.assets[key];
      if (!asset || !/^img\/\d+\/\d+\.png$/.test(asset.relative_path)) return send(res, 404, { error: 'Unknown research image.' });
      const base = await realpath(data.base_dir), path = await realpath(resolve(base, asset.relative_path));
      if (!path.startsWith(base + sep)) return send(res, 403, { error: 'Image is outside its research cache.' });
      const body = await readFile(path);
      if (body.length !== asset.bytes || sha256(body) !== key || !body.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
        return send(res, 409, { error: 'Research image integrity check failed.' });
      }
      return send(res, 200, req.method === 'HEAD' ? '' : body, 'image/png');
    }
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const path = resolve(site, '.' + pathname);
    if (!path.startsWith(site + sep)) return send(res, 403, { error: 'Forbidden.' });
    let body = await readFile(path);
    if (pathname === '/play/index.html') {
      // Keep tcg-build=web: the normal CPU-only static game still makes every decision.
      body = Buffer.from(body.toString().replace('</head>', '<meta name="tcg-private-research" content="1">\n</head>'));
    }
    return send(res, 200, req.method === 'HEAD' ? '' : body, mime[extname(path)] || 'application/octet-stream');
  } catch {
    return send(res, 404, { error: 'Local resource unavailable; prepare the research cache first.' });
  }
}).listen(port, '127.0.0.1', function () {
  console.log(`Local research preview: http://127.0.0.1:${this.address().port}/play/`);
  console.log('Local-only, non-commercial research pictures. They are not included in public website builds.');
});
