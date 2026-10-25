// The card library's data in the repository (scripts/library-snapshot.mjs): merged views, cover comparisons and the
// library_prod lock, written in a stable line-per-entry form; the committed copy matches library_prod where it is mounted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { snapshotFiles, writeSnapshot, checkSnapshot, SNAPSHOT, DEFAULT_FACES } from '../scripts/library-snapshot.mjs';
import { DEFAULT_PROD } from '../scripts/build-library-prod.mjs';

const put = async (path, body) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, body); };

test('the snapshot: one merged view per line by directory, comparisons and lock one entry per line, no build time', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'library-snapshot-')), prod = join(tmp, 'prod'), out = join(tmp, 'snapshot');
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const files = { 'zh-Hans/S2/001/metadata.json': { sha256: 'b'.repeat(64), bytes: 2 }, 'zh-Hans/S1/001/metadata.json': { sha256: 'a'.repeat(64), bytes: 3 } };
  await put(join(prod, 'manifest.json'), JSON.stringify({ schema: 'card-library-prod/1', builtAt: '2026-10-25T00:00:00Z', raw: '/raw',
    language: 'zh-Hans', index: { sha256: 'c'.repeat(64), records: 2 }, files }));
  await put(join(prod, 'index.jsonl'), ['S2/001', 'S1/001'].map((d) => JSON.stringify({ metadata_file: `zh-Hans/${d}/metadata.json` })).join('\n') + '\n');
  await put(join(prod, 'zh-Hans/S1/001/metadata.merged.json'), JSON.stringify({ id: 'one', card: { name: '甲' } }, null, 2));
  await put(join(prod, 'zh-Hans/S2/001/metadata.merged.json'), JSON.stringify({ id: 'two', card: { name: '乙' } }, null, 2));
  const faces = join(tmp, 'faces.json');
  await put(faces, JSON.stringify({ 'b:c': 7.5, 'a:b': 1.2 }));

  const written = await writeSnapshot({ prod, faces }, out);
  assert.equal(written['merged.jsonl'], '{"dir":"S1/001","view":{"id":"one","card":{"name":"甲"}}}\n{"dir":"S2/001","view":{"id":"two","card":{"name":"乙"}}}\n');
  assert.equal(written['faces.json'], '{\n "a:b": 1.2,\n "b:c": 7.5\n}\n');
  const lock = await readFile(join(out, 'lock.json'), 'utf8');
  assert.doesNotMatch(lock, /builtAt/);
  assert.deepEqual(JSON.parse(lock), { schema: 'card-library-prod/1', raw: '/raw', language: 'zh-Hans', index: { sha256: 'c'.repeat(64), records: 2 },
    files: { 'zh-Hans/S1/001/metadata.json': files['zh-Hans/S1/001/metadata.json'], 'zh-Hans/S2/001/metadata.json': files['zh-Hans/S2/001/metadata.json'] } });
  assert.match(lock, /\n  "zh-Hans\/S1\/001\/metadata.json": \{"sha256":"a{64}","bytes":3\},\n  "zh-Hans\/S2/);
  assert.deepEqual(await checkSnapshot({ prod, faces }, out), { stale: [], skipped: [] });

  // A rebuilt manifest (new build time only) is no change; a changed card text, a new comparison or file are.
  await put(join(prod, 'manifest.json'), JSON.stringify({ ...JSON.parse(await readFile(join(prod, 'manifest.json'), 'utf8')), builtAt: '2026-10-26T00:00:00Z' }));
  assert.deepEqual(await checkSnapshot({ prod, faces }, out), { stale: [], skipped: [] });
  await put(join(prod, 'zh-Hans/S2/001/metadata.merged.json'), JSON.stringify({ id: 'two', card: { name: '丙' } }));
  await put(faces, JSON.stringify({ 'b:c': 7.5, 'a:b': 1.2, 'c:d': 0.4 }));
  assert.deepEqual(await checkSnapshot({ prod, faces }, out), { stale: ['merged.jsonl', 'faces.json'], skipped: [] });
  assert.deepEqual(await checkSnapshot({ prod, faces: join(tmp, 'none.json') }, out), { stale: ['merged.jsonl'], skipped: ['faces.json'] });
  await rm(join(prod, 'zh-Hans/S1/001/metadata.merged.json'));
  await assert.rejects(snapshotFiles({ prod, faces }), /S1\/001\/metadata\.merged\.json is missing/);
});

test('the committed snapshot is the mounted library_prod\'s, and holds every comparison of the local build',
  { skip: !existsSync(join(DEFAULT_PROD, 'manifest.json')) && 'library_prod is not mounted here' }, async () => {
    // The local build's comparisons count only when it was built from this library_prod (another machine's may differ).
    const local = JSON.parse(await readFile(join(dirname(DEFAULT_FACES), 'index.json'), 'utf8').catch(() => '{}'));
    const faces = local.library === DEFAULT_PROD ? DEFAULT_FACES : join(SNAPSHOT, 'faces.json');
    assert.deepEqual((await checkSnapshot({ faces })).stale, [], 'run npm run library:snapshot and commit the result');
  });
