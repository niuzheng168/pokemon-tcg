// Indexes the local card library (library_prod, Simplified Chinese: ~14,000 printings) for the website's 卡牌库 and
// deck builder: one normalized entry per card directory, read from its generated metadata.merged.json
// (npm run cn:merged), each with its best image, then small WebP thumbnails (scripts/card-images.py, Pillow).
//   node scripts/build-card-library.mjs [--library /nas/share/Pokemon/library_prod] [--out .data/card-library] [--no-thumbs]
// Writes <out>/index.json, <out>/thumbs/<sha256 prefix>.webp and <out>/faces.json (image comparisons, reused by the
// next build and committed by npm run library:snapshot); the server (server/main.mjs --card-library <out>) loads the index at start. Card texts are the
// library's (machine-collected) unless the card is bound to a reviewed CN/V20261019 printing, whose card-face
// transcription replaces them; only those cards are implemented by the kernel.
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DECISIONS = JSON.parse(readFileSync(join(ROOT, 'catalog/zh-CN/V20261019/library/review/user-decisions.json'), 'utf8'));
const SAME_CARD = DECISIONS.sameCard ?? [];
export const DEFAULT_LIBRARY = process.env.CARD_LIBRARY || '/nas/share/Pokemon/library_prod';
export const MIK_ARCHIVE = process.env.MIK_ARCHIVE || '/nas/share/Pokemon/archives/pokemon-cards-mik-20261019/mik-full-20261019/cards';
export const DEFAULT_OUT = join(ROOT, '.data', 'card-library');
export const LANGUAGE = 'zh-Hans';
const RULESET = 'CN/V20261019';

const TYPE = { 草: 'Grass', 火: 'Fire', 水: 'Water', 雷: 'Lightning', 电: 'Lightning', 超: 'Psychic', 斗: 'Fighting', 闘: 'Fighting',
  恶: 'Darkness', 悪: 'Darkness', 钢: 'Metal', 龙: 'Dragon', 妖: 'Fairy', 妖精: 'Fairy', 无: 'Colorless', 无色: 'Colorless', 一般: 'Colorless' };
const STAGE = { 基础: 'basic', '1阶进化': 'stage1', '2阶进化': 'stage2', VMAX: 'vmax', VSTAR: 'vstar', 'V-UNION': 'v-union',
  BREAK: 'break', 传说: 'legend', 升级: 'levelup', M进化: 'mega' };
const CATEGORY = { 物品卡: 'item', 支援者卡: 'supporter', 竞技场卡: 'stadium', 宝可梦道具: 'tool' };
const MIK_CATEGORY = { Item: 'item', Supporter: 'supporter', Stadium: 'stadium', Tool: 'tool' };
const SERIES = { '朱&紫': 'scarlet-violet', '剑&盾': 'sword-shield', '太阳&月亮': 'sun-moon', '30周年庆典': '30th', 超级进化: 'mega' };
const slug = (id) => id.split(':').at(-1);
const CARD_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/; // schemas/card-definition.schema.json $defs/id
const type = (t) => TYPE[t] ?? null;
// A text as the library records it → the printed text: 52Poké's language-conversion markup -{zh-hans:简;zh-hant:繁}-
// keeps the Simplified side, a literal 「\n」 is a line break, and leftover template parameters (「|jeffect=…|eeffect=…」,
// the Japanese and English texts) are cut off (as scripts/card_review.py source_text).
export const sourceText = (s) => (s ?? '').split(/\|[je]effect=/)[0]
  .replace(/-\{zh-hans:([\s\S]*?);zh-hant:[\s\S]*?\}-/g, '$1').replaceAll('\\n', '\n');

// The record's MIK card, for what some library records leave out: a Trainer's category, a release date.
function mikRecord(m) {
  const id = m.sources?.find((s) => s.kind === 'mik')?.id;
  if (!id) return null;
  try { return JSON.parse(readFileSync(join(MIK_ARCHIVE, id, 'metadata.json'), 'utf8')); } catch { return null; }
}
// MIK release instants are UTC midnights of Beijing time (「2025-01-16T16:00:00Z」 → 2025-01-17).
const beijingDate = (iso) => (iso ? new Date(Date.parse(iso) + 8 * 3600_000).toISOString().slice(0, 10) : null);

function stageOf(card) {
  // A few VMAX / VSTAR records carry the stage "V".
  if (card.stage === 'V') return /VMAX$/.test(card.name) ? 'vmax' : /VSTAR$/.test(card.name) ? 'vstar' : 'basic';
  return STAGE[card.stage] ?? null;
}

// One library record → one entry. `dir` is the record's directory under zh-Hans/ (set/storage key).
export function normalize(m, dir) {
  const c = m.card, p = m.printing, reviewed = m.rules?.[RULESET] ?? null;
  // A few Special Energy records carry the kind 「trainer」 with the type 「特殊能量」 / 「能量卡」.
  const kind = c.kind === 'trainer' && /能量/.test(c.type ?? '') ? 'energy' : c.kind;
  const mik = (kind === 'trainer' && !CATEGORY[c.type]) || !p.releasedOn ? mikRecord(m) : null;
  const e = { id: m.id, dir, name: c.name, kind, set: p.setCode, setName: p.setName ?? null, number: p.number ?? null,
    sourceId: p.sourceCardId ?? null, series: SERIES[p.series] ?? null, seriesInferred: false, releasedOn: p.releasedOn ?? beijingDate(mik?.releaseDate),
    mark: p.regulationMark ?? null, rarity: p.rarity && p.rarity !== '—' ? p.rarity : null, illustrator: p.illustrator ?? null,
    stage: null, types: [], hp: null, evolvesFrom: c.evolvesFrom ?? null, weakness: null, resistance: null, retreat: null,
    attacks: [], abilities: [], text: '', rule: '', category: null,
    // A few ACE SPEC Special Energy records leave `mechanic` and the rarity empty; their MIK record names it.
    mechanic: c.mechanic ?? (kind === 'pokemon' ? null : (mik ?? mikRecord(m))?.mechanic ?? null), labels: [...(c.labels ?? [])],
    image: null, images: [], review: m.review?.level ?? 'machine', printingId: null, cardId: null, duplicateOf: null };
  // The primary image first; pickCover may replace it with a larger image of the same face.
  e.images = (m.images ?? []).map((i) => ({ file: i.file, sha256: i.sha256, width: i.width ?? null, height: i.height ?? null,
    sources: i.sources ?? [] }));
  if (e.images.length) e.image = e.images[0];
  const attack = (a) => ({ name: a.name, cost: (a.cost ?? []).map(type).filter(Boolean), damage: a.damage ?? '', text: sourceText(a.text) });
  if (kind === 'pokemon') {
    Object.assign(e, { stage: stageOf(c), types: [type(c.type)].filter(Boolean), hp: c.hp ?? null, retreat: c.retreat ?? null,
      weakness: c.weakness?.type ? { type: type(c.weakness.type), value: c.weakness.value ?? '' } : null,
      resistance: c.resistance?.type ? { type: type(c.resistance.type), value: c.resistance.value ?? '' } : null,
      attacks: (c.attacks ?? []).map(attack), abilities: (c.abilities ?? []).map((a) => ({ name: a.name, text: sourceText(a.text) })) });
  } else if (kind === 'trainer') {
    Object.assign(e, { category: CATEGORY[c.type] ?? MIK_CATEGORY[mik?.cardType] ?? null, attacks: (c.attacks ?? []).map(attack) });
  } else if (kind === 'energy') {
    const basic = /^基本.+能量$/.test(c.name);
    Object.assign(e, { category: basic ? 'basic' : 'special', types: basic ? [type(c.type)].filter(Boolean) : [] });
  }
  e.text = sourceText(Array.isArray(c.text) ? c.text.join('\n') : c.text);
  if (reviewed) {
    // The reviewed card face wins: its number, mark and transcribed texts, and the definition's tags.
    const d = reviewed.definition, t = reviewed.text ?? {};
    e.printingId = reviewed.printingId;
    e.number = reviewed.printing?.number ?? e.number;
    if (reviewed.printing && 'regulationMark' in reviewed.printing) e.mark = reviewed.printing.regulationMark;
    const texts = (list, defs) => list.forEach((x) => { const def = defs.find((y) => y.name === x.name); if (def && t[slug(def.attackId ?? def.abilityId)]) x.text = t[slug(def.attackId ?? def.abilityId)]; });
    texts(e.attacks, [...(d.mechanics.attacks ?? []), ...(d.mechanics.grantedAttacks ?? [])]);
    texts(e.abilities, d.mechanics.abilities ?? []);
    if (t.card) e.text = t.card;
    e.rule = [t.tera, t.rule].filter(Boolean).join('\n');
    for (const tag of d.mechanics.tags ?? []) if (tag !== 'ex' && !e.labels.includes(tag)) e.labels.push(tag);
  }
  // The card's id on the site and in saved decks: the printing id the catalog gives (or will give) this printing, in the
  // kernel's id alphabet (the CBB decks' numbers 「01 01/09」 have a space).
  e.cardId = e.printingId ?? `${LANGUAGE}:${e.set}:${(e.number ?? m.id.split('/').at(-1)).replace(/\s+/g, '-')}`;
  if (!CARD_ID.test(e.cardId)) throw new Error(`${dir}: ${e.cardId} is not a valid printing id.`);
  return e;
}

// What a whole set says fills gaps of single records: the series and release date of sibling records, else the set
// code's family. Inferred values are marked.
function fillFromSet(entries) {
  const bySet = Map.groupBy(entries, (e) => e.set);
  for (const [set, list] of bySet) {
    const count = (pick) => [...Map.groupBy(list.map(pick).filter(Boolean), (x) => x)].sort((a, b) => b[1].length - a[1].length)[0]?.[0] ?? null;
    const series = count((e) => e.series) ?? (/^(CSV|CBB|SV)/.test(set) ? 'scarlet-violet' : /^(CSM|SM)/.test(set) ? 'sun-moon'
      : /^30th/.test(set) ? '30th' : /^M-?P$/.test(set) ? 'mega' : /^(CS|S)/.test(set) ? 'sword-shield' : null);
    const dates = list.map((e) => e.releasedOn).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? '')).sort();
    const setName = count((e) => e.setName);
    for (const e of list) {
      if (!e.series && series) Object.assign(e, { series, seriesInferred: true });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(e.releasedOn ?? '')) e.releasedOn = dates[0] ?? null;
      e.setName ??= setName;
    }
  }
}

// A MIK source-id record (CSV8C/005) that repeats a full-number record of the same card (CSV8C 005/207) is a duplicate.
// When only the duplicate has the card images, the card takes them (image.dir names the duplicate's directory).
function markDuplicates(entries) {
  const full = new Map();
  for (const e of entries) if (e.id.startsWith('tcg:') && e.number) full.set(`${e.set}|${e.number.split('/')[0]}|${e.name}`, e);
  for (const e of entries) {
    if (e.id.startsWith('tcg:')) continue;
    const twin = full.get(`${e.set}|${e.id.split('/').at(-1)}|${e.name}`);
    if (!twin) continue;
    e.duplicateOf = twin.id;
    if (!twin.image && e.image) {
      twin.images = e.images.map((i) => ({ ...i, dir: e.dir }));
      twin.image = twin.images[0];
    }
  }
  // The user's decision (review/user-decisions.json sameCard): a full-number record without an image whose name the
  // same set and number's image-backed MIK record contradicts (「陈旧的…化石」 / 「古老的…化石」) repeats that record.
  const byId = new Map(entries.map((e) => [e.id, e]));
  for (const { id, sameAs, name } of SAME_CARD) {
    const e = byId.get(id), twin = byId.get(sameAs);
    if (!e || !twin || e.image || !twin.image || twin.name !== name || twin.duplicateOf) throw new Error(`Stale same-card decision: ${id}`);
    e.duplicateOf = twin.id;
  }
}

// A printing's images come from several sources (MIK ~300 px wide, the official site 520-1833 px, the wiki), and a
// few directories also hold images that are not this face: 精灵球／大师球 mirror foils of the same number, now and then
// another card. The cover is the largest image that looks like the primary one (card-images.py compare, under
// SAME_FACE), the official one first among equals; else the primary. distance(a, b) → number, or null if unknown.
export const SAME_FACE = 6;
const area = (i) => (i.width ?? 0) * (i.height ?? 0);
export function pickCover(images, distance) {
  const [primary] = images;
  const larger = images.slice(1).filter((i) => area(i) > area(primary))
    .sort((a, b) => area(b) - area(a) || b.sources.includes('official') - a.sources.includes('official'));
  return larger.find((i) => (distance(primary, i) ?? Infinity) < SAME_FACE) ?? primary ?? null;
}

// The user's decisions (review/user-decisions.json coverFaces), from looking at both images, on whether an image shows
// the same face as a record's primary image: they replace the comparison, whose colour difference cannot tell a whole
// card in another tone from a 精灵球／大师球 mirror foil. → Map `${id}|${primary sha256}|${image sha256}` → bool
export function coverDecisions(entries, decisions = DECISIONS.coverFaces ?? []) {
  const byId = new Map(entries.map((e) => [e.id, e])), decided = new Map();
  for (const { id, primary, image, sameFace } of decisions) {
    const e = byId.get(id);
    if (!e || e.images[0]?.sha256 !== primary || !e.images.some((i) => i.sha256 === image) || typeof sameFace !== 'boolean')
      throw new Error(`Stale cover decision: ${id}`);
    decided.set(`${id}|${primary}|${image}`, sameFace);
  }
  return decided;
}

// Sets every entry's image to its cover. Comparisons are by content: the committed ones (npm run library:snapshot), then
// <out>/faces.json, which keeps both for the next build and the next snapshot.
export const COMMITTED_FACES = join(ROOT, 'catalog/zh-CN/V20261019/library/snapshot/faces.json');
async function chooseCovers(entries, library, out) {
  const file = join(out, 'faces.json'), key = (a, b) => `${a.sha256.slice(0, 16)}:${b.sha256.slice(0, 16)}`;
  const read = async (f) => JSON.parse(await readFile(f, 'utf8').catch(() => '{}'));
  const local = await read(file), known = { ...await read(COMMITTED_FACES), ...local };
  // A decided pair is not compared: the same face measures 0, another face null (never the cover).
  const decided = coverDecisions(entries);
  const distance = (e, a, b) => {
    const d = decided.get(`${e.id}|${a.sha256}|${b.sha256}`);
    return d === undefined ? known[key(a, b)] : d ? 0 : null;
  };
  const asked = new Map();
  for (const e of entries) pickCover(e.images, (a, b) => {
    const d = distance(e, a, b);
    if (d === undefined) asked.set(key(a, b), [a, b].map((i) => join(library, LANGUAGE, i.dir ?? e.dir, i.file)));
    return d;
  });
  if (asked.size) {
    const r = spawnSync('python3', [join(ROOT, 'scripts', 'card-images.py'), 'compare'],
      { input: JSON.stringify([...asked.values()]), maxBuffer: 64 << 20, stdio: ['pipe', 'pipe', 'inherit'] });
    if (r.status !== 0) throw new Error('Comparing card images failed (python3 with Pillow is needed).');
    const distances = JSON.parse(r.stdout);
    [...asked.keys()].forEach((k, i) => { known[k] = distances[i]; });
  }
  if (Object.keys(known).length > Object.keys(local).length) await writeFile(file, JSON.stringify(known));
  let better = 0;
  for (const e of entries) {
    e.image = pickCover(e.images, (a, b) => distance(e, a, b));
    if (e.images.length > 1 && e.image !== e.images[0]) better++;
  }
  return { compared: asked.size, better };
}

export async function buildIndex(library, { language = LANGUAGE } = {}) {
  const base = join(library, language), dirs = [];
  for (const set of (await readdir(base, { withFileTypes: true })).filter((d) => d.isDirectory()))
    for (const key of (await readdir(join(base, set.name), { withFileTypes: true })).filter((d) => d.isDirectory())) dirs.push(`${set.name}/${key.name}`);
  const entries = [];
  let next = 0, missing = 0;
  await Promise.all(Array.from({ length: 48 }, async () => {
    while (next < dirs.length) {
      const dir = dirs[next++];
      const text = await readFile(join(base, dir, 'metadata.merged.json'), 'utf8').catch(() => null);
      if (text) entries.push(normalize(JSON.parse(text), dir)); else missing++;
    }
  }));
  entries.sort((a, b) => a.dir.localeCompare(b.dir));
  fillFromSet(entries);
  markDuplicates(entries);
  const ids = new Map();
  for (const e of entries.filter((x) => !x.duplicateOf)) {
    if (ids.has(e.cardId)) throw new Error(`Two cards would share the id ${e.cardId}: ${ids.get(e.cardId)} and ${e.id}.`);
    ids.set(e.cardId, e.id);
  }
  return { entries, missing };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values: opt } = parseArgs({ options: {
    library: { type: 'string', default: DEFAULT_LIBRARY }, out: { type: 'string', default: DEFAULT_OUT },
    'no-thumbs': { type: 'boolean', default: false },
  } });
  const started = Date.now();
  const { entries, missing } = await buildIndex(opt.library);
  if (!entries.length) throw new Error(`No ${LANGUAGE} card records with metadata.merged.json under ${opt.library} (npm run cn:merged).`);
  await mkdir(opt.out, { recursive: true });
  const covers = await chooseCovers(entries, opt.library, opt.out);
  const index = { schema: 'card-library-index/1', builtAt: new Date().toISOString(), library: opt.library, language: LANGUAGE,
    entries: entries.map(({ images, ...e }) => e) };
  await writeFile(join(opt.out, 'index.json'), JSON.stringify(index));
  const dupes = entries.filter((e) => e.duplicateOf).length, reviewed = entries.filter((e) => e.printingId).length;
  console.log(`Indexed ${entries.length} cards (${entries.length - dupes} unique, ${reviewed} bound to reviewed printings, `
    + `${entries.filter((e) => !e.image).length} without image, ${covers.better} with a larger image than the primary one`
    + `${missing ? `, ${missing} directories without metadata.merged.json` : ''}; ${covers.compared} image pairs compared) `
    + `in ${((Date.now() - started) / 1000).toFixed(1)} s → ${join(opt.out, 'index.json')}`);
  if (!opt['no-thumbs']) {
    const r = spawnSync('python3', [join(ROOT, 'scripts', 'card-images.py'), 'thumbs', opt.out], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('Thumbnails failed (python3 with Pillow is needed); the site falls back to the full images.');
  }
}
