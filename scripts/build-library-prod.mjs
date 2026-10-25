// Builds library_prod, the part of the card library the website and its build read, from library_raw (the whole card
// library as the library tools keep it: every language, provenance, review queues, per-card receipts):
//   index.jsonl                          the raw index's records of one printing language (zh-Hans), verbatim
//   zh-Hans/<set>/<key>/metadata.json    each of those records' metadata, byte for byte
//   zh-Hans/<set>/<key>/<image>          every image the record lists (cover choice compares them; the site serves one)
//   manifest.json                        every file above with its SHA-256 and size, and the raw manifest it came from
// Then npm run cn:merged writes metadata.merged.json beside each metadata.json, and scripts/build-card-library.mjs the
// 卡牌库 index. A copied file must have the SHA-256 the raw index or record gives it; a file already in place with the
// size and hash the last build recorded is kept. Anything else under <language>/ except metadata.merged.json is
// removed. library_raw is only read.
//   node scripts/build-library-prod.mjs [--raw /nas/share/Pokemon/library_raw] [--out /nas/share/Pokemon/library_prod]
//   node scripts/build-library-prod.mjs --check     verify every file of library_prod against its manifest; write nothing
import { readFile, writeFile, readdir, mkdir, rename, rm, stat, rmdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname, normalize, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const DEFAULT_RAW = process.env.LIBRARY_RAW || '/nas/share/Pokemon/library_raw';
export const DEFAULT_PROD = process.env.LIBRARY_PROD || '/nas/share/Pokemon/library_prod';
export const LANGUAGE = 'zh-Hans';
export const MANIFEST = 'manifest.json';
const GENERATED = 'metadata.merged.json';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

// A path the raw library gives, kept inside the language directory.
function inside(language, path) {
  const p = normalize(path);
  if (isAbsolute(p) || !p.startsWith(language + sep) || p.split(sep).includes('..')) throw new Error(`${path} is not inside ${language}/`);
  return p;
}

async function pool(items, limit, work) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

// The files library_prod holds: [{path, sha256, bytes}], from the raw index and each listed record's metadata.
async function plan(raw, language) {
  const lines = (await readFile(join(raw, 'index.jsonl'), 'utf8')).split('\n').filter(Boolean);
  const kept = lines.filter((line) => JSON.parse(line).printing_language === language);
  const files = new Map();
  const add = (path, sha256, bytes) => {
    const known = files.get(path);
    if (known && known.sha256 !== sha256) throw new Error(`${path} is listed with two different hashes`);
    files.set(path, { path, sha256, bytes });
  };
  await pool(kept, 32, async (line) => {
    const r = JSON.parse(line), file = inside(language, r.metadata_file);
    const bytes = await readFile(join(raw, file));
    if (digest(bytes) !== r.metadata_sha256) throw new Error(`${file} does not match its index hash`);
    add(file, r.metadata_sha256, bytes.length);
    for (const i of JSON.parse(bytes.toString('utf8')).images ?? []) add(inside(language, join(dirname(file), i.file)), i.sha256, i.bytes ?? null);
  });
  return { index: kept.map((line) => line + '\n').join(''), files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

// Every file under dir, relative to root.
async function walk(root, dir, out = []) {
  for (const d of await readdir(join(root, dir), { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, d.name);
    if (d.isDirectory()) await walk(root, p, out); else out.push(p);
  }
  return out;
}

async function prune(root, dir) {
  for (const d of await readdir(join(root, dir), { withFileTypes: true }).catch(() => []))
    if (d.isDirectory()) await prune(root, join(dir, d.name));
  if (dir && !(await readdir(join(root, dir))).length) await rmdir(join(root, dir));
}

export async function buildLibraryProd({ raw = DEFAULT_RAW, out = DEFAULT_PROD, language = LANGUAGE } = {}) {
  if (resolve(raw) === resolve(out)) throw new Error('library_prod must be another directory than library_raw');
  const { index, files } = await plan(raw, language);
  // A file stays when the last build recorded the same hash for it and it still has that size.
  const before = JSON.parse(await readFile(join(out, MANIFEST), 'utf8').catch(() => '{}')).files ?? {};
  const summary = { records: index.split('\n').filter(Boolean).length, files: files.length, bytes: 0, copied: 0, kept: 0, removed: 0 };
  await pool(files, 16, async (f) => {
    const target = join(out, f.path);
    const have = await stat(target).catch(() => null);
    if (have && before[f.path]?.sha256 === f.sha256 && have.size === before[f.path].bytes) { summary.kept++; return; }
    const bytes = await readFile(join(raw, f.path));
    if (digest(bytes) !== f.sha256) throw new Error(`${f.path} in ${raw} does not match the hash its record gives`);
    f.bytes ??= bytes.length;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target + '.tmp', bytes);
    await rename(target + '.tmp', target);
    summary.copied++;
  });
  summary.bytes = files.reduce((n, f) => n + f.bytes, 0);
  const wanted = new Set(files.map((f) => f.path));
  for (const p of await walk(out, language)) {
    if (wanted.has(p) || p.endsWith(sep + GENERATED)) continue;
    await rm(join(out, p));
    summary.removed++;
  }
  await prune(out, language);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'index.jsonl'), index);
  const rawManifest = await readFile(join(raw, 'files-manifest.json')).catch(() => null);
  await writeFile(join(out, MANIFEST), JSON.stringify({
    schema: 'card-library-prod/1', builtAt: new Date().toISOString(), raw: resolve(raw), language,
    rawManifestSha256: rawManifest && digest(rawManifest), index: { sha256: digest(Buffer.from(index)), records: summary.records },
    files: Object.fromEntries(files.map((f) => [f.path, { sha256: f.sha256, bytes: f.bytes }])),
  }, null, 1) + '\n');
  return summary;
}

// → {checked, missing: [path], changed: [path], extra: [path]} against library_prod's own manifest.
export async function checkLibraryProd({ out = DEFAULT_PROD } = {}) {
  const m = JSON.parse(await readFile(join(out, MANIFEST), 'utf8'));
  const result = { checked: 0, missing: [], changed: [], extra: [] };
  if (digest(await readFile(join(out, 'index.jsonl'))) !== m.index.sha256) result.changed.push('index.jsonl');
  const paths = Object.keys(m.files);
  await pool(paths, 16, async (p) => {
    const bytes = await readFile(join(out, p)).catch(() => null);
    if (!bytes) result.missing.push(p);
    else if (digest(bytes) !== m.files[p].sha256) result.changed.push(p);
    result.checked++;
  });
  for (const p of await walk(out, m.language)) if (!(p in m.files) && !p.endsWith(sep + GENERATED)) result.extra.push(p);
  for (const list of [result.missing, result.changed, result.extra]) list.sort();
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values: opt } = parseArgs({ options: {
    raw: { type: 'string', default: DEFAULT_RAW }, out: { type: 'string', default: DEFAULT_PROD }, check: { type: 'boolean', default: false },
  } });
  const started = Date.now();
  if (opt.check) {
    const r = await checkLibraryProd({ out: opt.out });
    console.log(JSON.stringify({ checked: r.checked, missing: r.missing.length, changed: r.changed.length, extra: r.extra.length }));
    for (const [kind, list] of Object.entries({ missing: r.missing, changed: r.changed, extra: r.extra }))
      for (const p of list.slice(0, 20)) console.error(`${kind}: ${p}`);
    if (r.missing.length || r.changed.length || r.extra.length) process.exitCode = 1;
  } else {
    const s = await buildLibraryProd({ raw: opt.raw, out: opt.out });
    console.log(`library_prod ${opt.out}: ${s.records} records, ${s.files} files (${(s.bytes / 2 ** 30).toFixed(2)} GB); `
      + `${s.copied} copied, ${s.kept} kept, ${s.removed} removed, in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  }
}
