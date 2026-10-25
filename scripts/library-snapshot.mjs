// The card library's data in the repository, apart from its images: what library_prod and the 卡牌库 build hold, so
// card text changes show as diffs and every clone has them.
//   catalog/zh-CN/V20261019/library/snapshot/merged.jsonl   every metadata.merged.json of library_prod (npm run cn:merged),
//       one line per card directory in order: {"dir": "<set>/<key>", "view": {...}}
//   .../faces.json   the cover image comparisons (scripts/build-card-library.mjs), one pair per line; the build starts from
//       them, so the same images give the same covers without being compared again
//   .../lock.json    library_prod's manifest without its build time: the SHA-256 of every file the site reads
//   node scripts/library-snapshot.mjs [--prod DIR] [--faces FILE]   write the three files
//   node scripts/library-snapshot.mjs --check                       fail if one differs from library_prod / the local build
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_PROD, MANIFEST } from './build-library-prod.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SNAPSHOT = join(ROOT, 'catalog/zh-CN/V20261019/library/snapshot');
export const DEFAULT_FACES = join(ROOT, '.data/card-library/faces.json');
const MERGED = 'metadata.merged.json';
const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// An object with one entry per line, keys in order.
const perLine = (o, indent = '') => {
  const keys = Object.keys(o).sort(byKey);
  return keys.length ? `{\n${keys.map((k) => `${indent} ${JSON.stringify(k)}: ${JSON.stringify(o[k])}`).join(',\n')}\n${indent}}` : '{}';
};

async function pool(items, limit, work) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await work(items[i]); }
  }));
  return out;
}

// → { 'merged.jsonl', 'lock.json', 'faces.json' } as text; faces.json is null without a local build's comparisons.
export async function snapshotFiles({ prod = DEFAULT_PROD, faces = DEFAULT_FACES } = {}) {
  const { builtAt, files, ...head } = JSON.parse(await readFile(join(prod, MANIFEST), 'utf8'));
  const dirs = (await readFile(join(prod, 'index.jsonl'), 'utf8')).split('\n').filter(Boolean)
    .map((line) => dirname(JSON.parse(line).metadata_file).slice(head.language.length + 1)).sort(byKey);
  const merged = await pool(dirs, 32, async (dir) => {
    const text = await readFile(join(prod, head.language, dir, MERGED), 'utf8').catch(() => null);
    if (text === null) throw new Error(`${head.language}/${dir}/${MERGED} is missing (npm run cn:merged)`);
    return `${JSON.stringify({ dir, view: JSON.parse(text) })}\n`;
  });
  const lock = `${JSON.stringify(head, null, 1).slice(0, -2)},\n "files": ${perLine(files, ' ')}\n}\n`;
  const comparisons = await readFile(faces, 'utf8').then(JSON.parse, () => null);
  return { 'merged.jsonl': merged.join(''), 'lock.json': lock, 'faces.json': comparisons && `${perLine(comparisons)}\n` };
}

export async function writeSnapshot(options = {}, out = SNAPSHOT) {
  const files = await snapshotFiles(options);
  await mkdir(out, { recursive: true });
  for (const [name, text] of Object.entries(files)) if (text !== null) await writeFile(join(out, name), text);
  return files;
}

// → { stale: [name], skipped: [name] } comparing the committed files with what library_prod and the local build give.
export async function checkSnapshot(options = {}, out = SNAPSHOT) {
  const result = { stale: [], skipped: [] };
  for (const [name, text] of Object.entries(await snapshotFiles(options))) {
    if (text === null) result.skipped.push(name);
    else if (await readFile(join(out, name), 'utf8').catch(() => null) !== text) result.stale.push(name);
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values: opt } = parseArgs({ options: {
    prod: { type: 'string', default: DEFAULT_PROD }, faces: { type: 'string', default: DEFAULT_FACES }, check: { type: 'boolean', default: false },
  } });
  if (opt.check) {
    const { stale, skipped } = await checkSnapshot({ prod: opt.prod, faces: opt.faces });
    for (const name of skipped) console.log(`${name}: no local comparisons (${opt.faces}), not checked`);
    for (const name of stale) console.error(`${name} is stale (npm run library:snapshot)`);
    if (stale.length) process.exitCode = 1; else console.log(`Snapshot in ${SNAPSHOT} matches ${opt.prod}.`);
  } else {
    const files = await writeSnapshot({ prod: opt.prod, faces: opt.faces });
    const size = (t) => (t === null ? 'skipped' : `${(Buffer.byteLength(t) / 2 ** 20).toFixed(1)} MB`);
    console.log(`Wrote ${SNAPSHOT}: ${Object.entries(files).map(([n, t]) => `${n} ${size(t)}`).join(', ')}`);
  }
}
