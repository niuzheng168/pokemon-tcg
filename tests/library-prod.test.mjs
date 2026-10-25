// library_prod (scripts/build-library-prod.mjs): the Simplified Chinese records of library_raw with their metadata and
// listed images, nothing else; verified copies, kept on rebuild, pruned when raw no longer lists them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { buildLibraryProd, checkLibraryProd } from '../scripts/build-library-prod.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const put = async (root, path, body) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), body); return body; };

// A raw library: two zh-Hans records (one with an extra image under images/ and receipts), a ja record, provenance.
async function rawLibrary(root) {
  const index = [];
  const record = async (language, dir, images, extra = {}) => {
    const listed = [];
    for (const [file, body] of images) listed.push({ file, sha256: sha(await put(root, `${language}/${dir}/${file}`, body)), bytes: Buffer.byteLength(body) });
    const metadata = JSON.stringify({ id: `${language}:${dir}`, images: listed });
    await put(root, `${language}/${dir}/metadata.json`, metadata);
    for (const [file, body] of Object.entries(extra)) await put(root, `${language}/${dir}/${file}`, body);
    index.push({ printing_language: language, metadata_file: `${language}/${dir}/metadata.json`, metadata_sha256: sha(metadata) });
  };
  await record('zh-Hans', 'S1/001', [['S1_001.png', 'mik face'], ['images/S1_001.official.png', 'official face, larger']],
    { 'source-response.json': '{}', 'image-receipt.json': '{}', 'metadata.merged.json': '{"stale":true}' });
  await record('zh-Hans', 'S1/002', [['S1_002.png', 'another face']]);
  await record('ja', 'S1/001', [['S1_001.png', 'japanese face']]);
  await put(root, '_provenance/report.json', '{}');
  await put(root, '_review/official-unassociated/x.png', 'pending');
  await put(root, 'all-records.jsonl', '{}\n');
  await put(root, 'files-manifest.json', '{"files":{}}');
  await put(root, 'index.jsonl', index.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return index;
}

const files = async (root, dir = '') => (await readdir(join(root, dir), { withFileTypes: true, recursive: true }))
  .filter((d) => d.isFile()).map((d) => join(d.parentPath ?? d.path, d.name).slice(root.length + 1)).sort();

test('library_prod holds the zh-Hans records, their metadata and listed images, and nothing else', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'library-prod-')), raw = join(tmp, 'raw'), out = join(tmp, 'prod');
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const index = await rawLibrary(raw);

  assert.deepEqual(await buildLibraryProd({ raw, out }),
    { records: 2, files: 5, bytes: ['mik face', 'official face, larger', 'another face'].reduce((n, x) => n + x.length, 0)
      + (await readFile(join(raw, 'zh-Hans/S1/001/metadata.json'))).length + (await readFile(join(raw, 'zh-Hans/S1/002/metadata.json'))).length,
      copied: 5, kept: 0, removed: 0 });
  assert.deepEqual(await files(out), ['index.jsonl', 'manifest.json', 'zh-Hans/S1/001/S1_001.png', 'zh-Hans/S1/001/images/S1_001.official.png',
    'zh-Hans/S1/001/metadata.json', 'zh-Hans/S1/002/S1_002.png', 'zh-Hans/S1/002/metadata.json']);
  assert.equal(await readFile(join(out, 'zh-Hans/S1/001/images/S1_001.official.png'), 'utf8'), 'official face, larger');
  assert.deepEqual((await readFile(join(out, 'index.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l).metadata_file),
    index.filter((r) => r.printing_language === 'zh-Hans').map((r) => r.metadata_file));
  const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.rawManifestSha256, sha('{"files":{}}'));
  assert.deepEqual(await checkLibraryProd({ out }), { checked: 5, missing: [], changed: [], extra: [] });

  // Rebuilding keeps what is in place and leaves the generated merged view alone; stray files go.
  await put(out, 'zh-Hans/S1/001/metadata.merged.json', '{}');
  await put(out, 'zh-Hans/S1/003/old.png', 'no longer listed');
  const again = await buildLibraryProd({ raw, out });
  assert.deepEqual([again.copied, again.kept, again.removed], [0, 5, 1]);
  assert.ok((await files(out)).includes('zh-Hans/S1/001/metadata.merged.json'));
  assert.ok(!(await files(out)).some((p) => p.startsWith('zh-Hans/S1/003')));

  // The check finds a missing, a changed and an extra file; a rebuild restores the first two.
  await unlink(join(out, 'zh-Hans/S1/002/S1_002.png'));
  await writeFile(join(out, 'zh-Hans/S1/001/S1_001.png'), 'MIK FACE'); // same size, other bytes
  await put(out, 'zh-Hans/S1/002/receipt.json', '{}');
  assert.deepEqual(await checkLibraryProd({ out }), { checked: 5, missing: ['zh-Hans/S1/002/S1_002.png'],
    changed: ['zh-Hans/S1/001/S1_001.png'], extra: ['zh-Hans/S1/002/receipt.json'] });
  await writeFile(join(out, 'manifest.json'), JSON.stringify({ ...manifest, files: { ...manifest.files, 'zh-Hans/S1/001/S1_001.png': { sha256: 'old', bytes: 8 } } }));
  await buildLibraryProd({ raw, out });
  assert.deepEqual(await checkLibraryProd({ out }), { checked: 5, missing: [], changed: [], extra: [] });

  // A raw image that does not match its record is not copied.
  await writeFile(join(raw, 'zh-Hans/S1/002/S1_002.png'), 'tampered');
  await rm(join(out, 'zh-Hans/S1/002/S1_002.png'));
  await assert.rejects(buildLibraryProd({ raw, out }), /S1_002\.png in .* does not match the hash its record gives/);
  await assert.rejects(buildLibraryProd({ raw, out: raw }), /another directory/);
});
