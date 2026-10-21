// Writes metadata.merged.json beside every card metadata.json of one printing language in
// the NAS card library (schemas/card-metadata-merged.schema.json): the library's
// multi-source record reduced to what a reader needs, plus each reviewed rules binding
// (the CardDefinition verbatim, pinned by the installed trust of its release).
// The merged file is a generated, read-only VIEW. Edit metadata.json (library pipeline)
// or catalog/ (rules) and regenerate. metadata.json, index.jsonl and the library
// manifests are never written.
//   node scripts/build-merged-metadata.mjs [--library DIR] [--language zh-Hans]   write changed files
//   node scripts/build-merged-metadata.mjs --check                              fail if any is stale
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { loadReviewedCatalogRelease } from '../public/rules/catalog-release.js';
import { canonicalDefinition, canonicalPrinting } from '../public/rules/card-schema.js';
import { sha256 } from '../public/rules/catalog.js';
import { TRUSTED_RELEASES } from '../public/cn/trusted-releases.js';
import { PRESENTATION, REVIEW_RECORDS, IMAGE_STORES } from '../catalog/zh-CN/V20261019/index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MERGED_FILE = 'metadata.merged.json';
export const DEFAULT_LIBRARY = IMAGE_STORES.library_v1;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const present = (v) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length);
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => present(v)));
const paragraphs = (text) => typeof text === 'string' ? text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean) : [];
const unique = (values) => [...new Set(values)].sort();
// Comparison only: whitespace and the 【】 keyword marks the library keeps are not printed text differences.
const norm = (text) => (text ?? '').replace(/[\s【】]/g, '');

function inside(base, path) {
  const out = resolve(base, path), rel = relative(base, out);
  if (isAbsolute(path) || !rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`Library path escapes the library: ${path}`);
  return out;
}

function face(block) {
  const d = block.display ?? {}, foot = block.footers?.[0]?.display ?? {};
  const typed = (type, value) => present(type) ? compact({ type, value }) : undefined;
  const retreat = present(foot.retreat) ? /^\d+$/.test(foot.retreat) ? Number(foot.retreat) : foot.retreat : undefined;
  return compact({
    kind: block.kind, type: d.type, stage: d.stage, hp: d.hp, evolvesFrom: d.evolves_from,
    // Empty wiki template slots (no name and no text, null cost cells) are not printed content.
    abilities: (block.abilities ?? []).map((a) => compact({ name: a.display?.name, text: a.display?.effect })).filter((a) => a.name || a.text),
    attacks: (block.attacks ?? []).map((a) => compact({ name: a.display?.name, cost: (a.display?.energy_cost ?? []).filter(present),
      damage: a.display?.damage, text: a.display?.effect })).filter((a) => a.name || a.text),
    text: (block.effects ?? []).flatMap((e) => paragraphs(e.display?.effect)),
    weakness: typed(foot.weakness, foot.weaknessnumber), resistance: typed(foot.resistance, foot.resistancenumber), retreat,
  });
}

function printingOf(m) {
  const listed = (m.source_printings ?? []).map((s) => s.printing).filter(Boolean);
  // A source page lists every printing of the card; take the one this directory is, or the
  // page's own row when the directory is keyed by a source card ID.
  const row = listed.find((p) => p.number === m.number && p.language === m.printing_language) ?? (m.number === null ? listed[0] : null) ?? {};
  return { ...compact({ game: m.game, language: m.printing_language, setCode: m.set_id }), number: m.number ?? null,
    ...compact({ sourceCardId: m.number === null ? m.id : undefined, setName: row.set_name ?? m.set_names_zh_hans?.[0],
      series: row.series, releasedOn: row.release_date, rarity: row.rarity, illustrator: row.illustrator, regulationMark: row.regulation_mark }) };
}

function reviewOf(m) {
  const level = m.human_review?.scope === 'listed_fields_only' ? 'human-fields' : m.human_reviewed ? 'human'
    : m.visual_verification?.all_checks_passed ? 'machine-image-checked' : 'machine';
  return compact({ level, fields: level === 'human-fields' ? m.human_review.field_paths : undefined,
    warnings: unique([...(m.text_review?.warnings ?? []), ...(m.review_flags ?? [])]) });
}

/** The library record reduced to identity, printed content, images, sources and review level. */
export function simplify(m, metadataSha256) {
  const mik = (m.external_source_records ?? []).find((e) => e.source === 'mik');
  const blocks = m.blocks ?? [];
  const primary = Math.min(mik?.rule_block ?? m.primary_rule_block_index ?? 0, Math.max(blocks.length - 1, 0));
  const card = { name: m.name, ...(blocks[primary] ? face(blocks[primary]) : {}),
    ...compact({ mechanic: mik?.mechanic, labels: mik?.labels }) };
  const others = blocks.filter((_, i) => i !== primary).map(face);
  const images = [...(m.images ?? [])].sort((a, b) => (b.file === m.primary_image) - (a.file === m.primary_image))
    .map((i) => compact({ file: i.file, sha256: i.sha256, sources: unique([i.source, ...(i.additional_sources ?? []).map((s) => s.source)].filter(present)),
      width: i.width, height: i.height }));
  const sources = [
    ...(m.source_pages ?? []).map((p) => compact({ kind: '52poke', id: String(p.page_id), revisionId: p.revision_id, url: p.revision_url })),
    ...(m.external_source_records ?? []).map((e) => compact({ kind: e.source, id: e.id,
      url: e.source === 'mik' ? `https://tcg.mik.moe/cards/${e.id}` : e.source_pages?.[0] })),
  ];
  const rights = m.attribution ? compact({ source: m.attribution.source, license: m.attribution.license, notice: m.attribution.rights_notice })
    : m.data_rights?.Wiki_reference_license ? { source: m.data_rights.Wiki_reference_attribution, license: m.data_rights.Wiki_reference_license } : undefined;
  return {
    schema: 'pokemon-card-merged/1', id: m.id, generatedFrom: { metadata: { file: 'metadata.json', sha256: metadataSha256 } },
    printing: printingOf(m), card: compact(card), ...(others.length ? { otherVersions: others } : {}),
    images, sources, review: reviewOf(m), ...(rights ? { license: rights } : {}), rules: {},
  };
}

/** Fields the card-face review settled differently from (or found missing in) the library record. */
export function differences(merged, binding) {
  const out = [], { card, printing } = merged, mech = binding.definition.mechanics, texts = binding.text;
  const check = (field, metadata, reviewed) => { if (norm(metadata) !== norm(reviewed)) out.push({ field, metadata: metadata ?? null, reviewed: reviewed ?? null }); };
  check('name', card.name, binding.definition.name);
  if (printing.number !== null) check('number', printing.number, binding.printing.number);
  check('regulationMark', printing.regulationMark, binding.printing.regulationMark);
  for (const [list, items] of [['attacks', [...(mech.attacks ?? []), ...(mech.grantedAttacks ?? [])]], ['abilities', mech.abilities ?? []]]) {
    for (const item of items) {
      const slug = (item.attackId ?? item.abilityId).split(':').pop();
      const printed = (card[list] ?? []).find((x) => x.name === item.name);
      if (!printed) out.push({ field: `${list}.${item.name}`, metadata: null, reviewed: texts[slug] ?? item.name });
      else if (slug in texts) check(`${list}.${item.name}.text`, printed.text, texts[slug]);
    }
  }
  const body = (card.text ?? []).join('');
  if ('card' in texts) check('text', body || undefined, texts.card);
  if ('tera' in texts && !norm(body).includes(norm(texts.tera).replace(/^太晶：/, ''))) out.push({ field: 'tera', metadata: null, reviewed: texts.tera });
  return out;
}

/** Every reviewed binding of every trusted release, keyed by printing ID. */
export async function reviewedBindings() {
  const json = await readFile(join(ROOT, 'public/data/cn/V20261019/release.json'), 'utf8');
  await loadReviewedCatalogRelease({ json, trustedReleases: TRUSTED_RELEASES });
  const { manifest, definitions, printings } = JSON.parse(json);
  const release = { id: manifest.releaseId, sha256: TRUSTED_RELEASES.get(manifest.releaseId) };
  const pins = (rows) => new Map(rows.map((r) => [r.id, r.sha256]));
  const definitionPins = pins(manifest.definitions), printingPins = pins(manifest.printings);
  const key = `${manifest.ruleset.region}/${manifest.ruleset.version}`;
  return new Map(await Promise.all(printings.map(async (p) => {
    const bound = p.definitionBindings.find((b) => b.ruleset.region === manifest.ruleset.region && b.ruleset.version === manifest.ruleset.version);
    const definition = definitions.find((d) => d.definitionId === bound.definitionId);
    if (await sha256(canonicalDefinition(definition)) !== definitionPins.get(definition.definitionId)
      || await sha256(canonicalPrinting(p)) !== printingPins.get(p.printingId)) throw new Error(`Release pin mismatch for ${p.printingId}`);
    const review = REVIEW_RECORDS.find((r) => r.printingId === p.printingId);
    return [p.printingId, { key, image: review.image, binding: {
      release, printingId: p.printingId, printingSha256: printingPins.get(p.printingId), identityReview: p.identityReview,
      printing: { number: p.number, regulationMark: p.regulationMark, ...compact({ series: p.series, releasedOn: p.releasedOn }) },
      definitionId: definition.definitionId, definitionSha256: definitionPins.get(definition.definitionId),
      text: PRESENTATION[p.printingId].texts, image: { store: review.image.store, path: review.image.path, sha256: review.image.sha256 },
      differences: [], definition,
    } }];
  })));
}

// A reviewed printing belongs to the directory whose record ID is that printing, and to the
// directory of the same set holding the exact image the review fingerprinted (or its MIK source card).
function directoriesOf(printingId, image, records) {
  const setCode = printingId.split(':')[1];
  const mikId = image.store === 'mik-full-20261019' ? image.path.match(/^cards\/(.+)\/[^/]+$/)?.[1] : null;
  return records.filter(({ index, metadata }) => index.id === `tcg:${printingId}` || (metadata.set_id === setCode
    && ((metadata.images ?? []).some((i) => i.sha256 === image.sha256) || (mikId && (index.mik_id === mikId || index.id === mikId)))));
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

export async function mergedValidator() {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const { readdir } = await import('node:fs/promises');
  for (const file of (await readdir(join(ROOT, 'schemas'))).filter((f) => f.endsWith('.schema.json')).sort())
    ajv.addSchema(JSON.parse(await readFile(join(ROOT, 'schemas', file), 'utf8')));
  return ajv.getSchema('urn:pokemon-tcg:card-metadata-merged:1.0.0');
}

/**
 * Every indexed card of one language as an in-memory merged view, schema-validated.
 * requireAllBindings: every reviewed printing must land in at least one directory.
 */
export async function mergeLibrary({ library = DEFAULT_LIBRARY, language = 'zh-Hans', requireAllBindings = true, bindings } = {}) {
  const lines = (await readFile(join(library, 'index.jsonl'), 'utf8')).split('\n').filter(Boolean);
  const indexed = lines.map((line) => JSON.parse(line)).filter((r) => r.printing_language === language);
  const records = await mapLimit(indexed, 32, async (index) => {
    const file = inside(library, index.metadata_file);
    const bytes = await readFile(file);
    return { index, file, bytes, metadata: JSON.parse(bytes.toString('utf8')) };
  });
  const views = new Map(records.map((r) => [r.file, simplify(r.metadata, digest(r.bytes))]));
  const unbound = [];
  for (const [printingId, { key, image, binding }] of bindings ?? await reviewedBindings()) {
    const dirs = directoriesOf(printingId, image, records);
    if (!dirs.length) unbound.push(printingId);
    for (const { file } of dirs) {
      const view = views.get(file);
      if (view.rules[key]) throw new Error(`${file} is bound twice in ${key}`);
      view.rules[key] = { ...binding, differences: differences(view, binding) };
    }
  }
  if (requireAllBindings && unbound.length) throw new Error(`Reviewed printings without a library directory: ${unbound.join(', ')}`);
  const validate = await mergedValidator();
  const invalid = new Map();
  for (const [file, view] of views) for (const e of validate(view) ? [] : validate.errors) {
    const kind = `${e.instancePath.replace(/\/\d+/g, '/*')} ${e.message}`;
    invalid.set(kind, [...(invalid.get(kind) ?? []), relative(library, file)]);
  }
  if (invalid.size) throw new Error(`Merged view schema errors:\n${[...invalid].map(([kind, files]) =>
    `${kind} (${files.length}): ${files.slice(0, 3).join(', ')}`).join('\n')}`);
  return { records, views, unbound };
}

/** Write (or with check, only compare) metadata.merged.json beside every card of one language. */
export async function buildMergedMetadata({ library = DEFAULT_LIBRARY, language = 'zh-Hans', check = false, ...options } = {}) {
  const { records, views: merged, unbound } = await mergeLibrary({ library, language, ...options });
  const summary = { language, records: records.length, bound: 0, differences: 0, written: 0, unchanged: 0, stale: [], unbound,
    metadataBytes: 0, mergedBytes: 0 };
  await mapLimit(records, 32, async ({ file, bytes }) => {
    const view = merged.get(file), text = `${JSON.stringify(view, null, 2)}\n`, target = join(dirname(file), MERGED_FILE);
    summary.metadataBytes += bytes.length; summary.mergedBytes += Buffer.byteLength(text);
    if (Object.keys(view.rules).length) summary.bound++;
    summary.differences += Object.values(view.rules).reduce((n, b) => n + b.differences.length, 0);
    if (await readFile(target, 'utf8').catch(() => null) === text) { summary.unchanged++; return; }
    if (check) summary.stale.push(relative(library, target));
    else { await writeFile(target, text); summary.written++; }
  });
  summary.stale.sort();
  return summary;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
  const summary = await buildMergedMetadata({ library: arg('--library') ?? DEFAULT_LIBRARY, language: arg('--language') ?? 'zh-Hans',
    check: process.argv.includes('--check') });
  const { stale, ...rest } = summary;
  console.log(JSON.stringify({ ...rest, stale: stale.length }, null, 1));
  if (stale.length) {
    console.error(`Stale ${MERGED_FILE} files (run node scripts/build-merged-metadata.mjs):\n${stale.slice(0, 20).join('\n')}`);
    process.exitCode = 1;
  }
}
