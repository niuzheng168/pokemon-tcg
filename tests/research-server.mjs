import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { request } from 'node:http';

const root = await mkdtemp(join(tmpdir(), 'tcg-local-research-'));
const site = join(root, 'site'), images = join(root, 'dataset');
await mkdir(join(site, 'play'), { recursive: true });
await mkdir(join(images, 'img', '1'), { recursive: true });
await writeFile(join(site, 'play', 'index.html'), '<html><head><meta name="tcg-build" content="web"></head><body>测试</body></html>');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64');
const key = createHash('sha256').update(png).digest('hex');
await writeFile(join(images, 'img', '1', '0.png'), png);
const registry = {
  version: 1, local_only: true, redistribution_permitted: false, base_dir: images,
  assets: { [key]: { relative_path: 'img/1/0.png', bytes: png.length, sha256: key } },
  cards: { 'sample-id': { asset: key, language: 'zh-Hans' } },
};
const manifest = join(root, 'private-manifest.json');
await writeFile(manifest, JSON.stringify(registry));
const server = spawn(process.execPath, ['scripts/serve-local-research.mjs'], {
  cwd: new URL('../', import.meta.url),
  env: { ...process.env, PORT: '0', RESEARCH_SITE_ROOT: site, TCG_RESEARCH_MANIFEST: manifest },
  stdio: ['ignore', 'pipe', 'pipe'],
});
try {
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Research server did not start')), 5000);
    server.stdout.on('data', (data) => {
      const match = String(data).match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    server.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Research server exited ${code}`)); });
  });
  let response = await fetch(base + '/play/');
  const html = await response.text();
  assert(html.includes('tcg-private-research'));
  assert(html.includes('tcg-build" content="web"'), 'Research mode must retain CPU-only behavior.');
  response = await fetch(base + '/api/research-scans');
  const body = await response.text(), data = JSON.parse(body);
  assert(!body.includes(images), 'Never expose local paths.');
  assert(data.local_only && data.redistribution_permitted === false);
  response = await fetch(base + data.cards['sample-id'].url);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  for (const headers of [{ Origin: 'https://example.invalid' }, { Host: 'example.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const status = await new Promise((resolve, reject) => {
      const req = request(base + '/api/research-scans', { headers }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403, JSON.stringify(headers));
  }
  assert.equal((await fetch(base + '/private-manifest.json')).status, 404);
  await writeFile(join(images, 'img', '1', '0.png'), Buffer.from('corrupt'));
  assert.equal((await fetch(base + data.cards['sample-id'].url)).status, 409);
  await rm(join(images, 'img', '1', '0.png'));
  const outside = join(root, 'outside.png');
  await writeFile(outside, png);
  await symlink(outside, join(images, 'img', '1', '0.png'));
  assert.equal((await fetch(base + data.cards['sample-id'].url)).status, 403);
  console.log('Research server checks passed: loopback, same-origin, integrity, path containment, CPU-only and no public data exposure.');
} finally {
  server.kill('SIGTERM');
  await rm(root, { recursive: true, force: true });
}
