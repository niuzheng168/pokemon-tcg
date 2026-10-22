// The card library the 卡牌库 and the deck builder browse: the index scripts/build-card-library.mjs builds from
// library_v1 (one entry per card, ~13,700), or, without one, the reviewed release's own printings. Joined with the
// rules catalog (public/card-pool.js) it is also the pool the server checks saved decks against.
//   GET /api/library                    → {cards: [library entry]}  (compressed once, revalidated by ETag)
//   GET /play/library/thumb/<sha16>     → the card's WebP thumbnail, else its full image
//   GET /play/library/image/<sha16>     → the card image
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, extname } from 'node:path';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { buildPool } from '../public/card-pool.js';
import { printingLegality } from '../public/deck-check.js';
import { damageText } from '../public/match.js';
import { implementationTier } from '../public/card-quality.js';

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const SHA16 = /^[0-9a-f]{16}$/;
const slug = (id) => id.split(':').at(-1);

// An index entry → a library entry. Cards bound to a reviewed printing keep that printing's id; the others get the id
// the same printing will have once implemented (zh-Hans:<set>:<number>, or the archive's key for unnumbered records).
function fromIndex(e) {
  const sha = e.image?.sha256.slice(0, 16) ?? null;
  return { id: e.cardId, name: e.name, kind: e.kind, setCode: e.set, setName: e.setName, number: e.number, series: e.series,
    releasedOn: e.releasedOn, mark: e.mark, rarity: e.rarity, illustrator: e.illustrator, stage: e.stage, types: e.types, hp: e.hp,
    evolvesFrom: e.evolvesFrom, weakness: e.weakness, resistance: e.resistance, retreat: e.retreat, attacks: e.attacks,
    abilities: e.abilities, text: e.text, rule: e.rule, category: e.category, mechanic: e.mechanic, labels: e.labels,
    review: e.printingId ? 'reviewed' : e.review, image: sha && `library/image/${sha}`, thumb: sha && `library/thumb/${sha}` };
}

// Without an index: the release's printings, with the card-face texts and images of decks.json.
function fromCatalog(catalog, presentation) {
  const defs = catalog.definitions();
  return catalog.printings().map((p) => {
    const d = catalog.definitionFor(p.printingId), m = d.mechanics, info = presentation[p.printingId] ?? {}, texts = info.texts ?? {};
    const attack = (a) => ({ name: a.name, cost: a.cost, damage: damageText(a.printedDamage), text: texts[slug(a.attackId)] ?? '' });
    const c = { id: p.printingId, name: d.name, kind: d.kind, setCode: p.setCode, setName: null, number: p.number, series: p.series,
      releasedOn: p.releasedOn, mark: p.regulationMark, rarity: null, illustrator: null, stage: null, types: [], hp: null,
      evolvesFrom: null, weakness: null, resistance: null, retreat: null, attacks: [], abilities: [], text: texts.card ?? '',
      rule: [texts.tera, texts.rule].filter(Boolean).join('\n'), category: null, mechanic: m.tags?.includes('ex') ? 'ex' : null,
      labels: (m.tags ?? []).filter((x) => x !== 'ex'),
      review: implementationTier(catalog, p.printingId) === 'reviewed' ? 'reviewed' : info.textReview ?? 'machine-image-checked',
      image: info.image ?? null, thumb: info.image ?? null };
    if (d.kind === 'pokemon') {
      Object.assign(c, { stage: m.stage.toLowerCase(), types: m.types, hp: m.hp, retreat: m.retreatCost,
        weakness: m.weakness && { type: m.weakness.type, value: `${m.weakness.operation === 'multiply' ? '×' : '+'}${m.weakness.value}` },
        resistance: m.resistance && { type: m.resistance.type, value: `-${m.resistance.value}` },
        evolvesFrom: m.evolvesFrom ? defs.find((x) => x.nameKey === m.evolvesFrom)?.name ?? m.evolvesFrom : null,
        attacks: m.attacks.map(attack), abilities: m.abilities.map((a) => ({ name: a.name, text: texts[slug(a.abilityId)] ?? '' })) });
    } else if (d.kind === 'trainer') {
      Object.assign(c, { category: m.category, attacks: (m.grantedAttacks ?? []).map(attack) });
    } else {
      Object.assign(c, { category: m.category, types: m.category === 'basic' ? m.baseUnits[0] : [] });
    }
    return c;
  });
}

/**
 * `dir`: a built index (index.json, thumbs/), or null for the release's printings only.
 * → {cards, pool, source, send(req, res), sendImage(req, res, kind, sha16)}
 */
export async function loadLibrary({ dir = null, catalog, presentation }) {
  let cards, images = new Map(), thumbs = null, source;
  if (dir) {
    const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'));
    if (index.schema !== 'card-library-index/1') throw new Error(`${dir}/index.json: unknown schema ${index.schema}`);
    const entries = index.entries.filter((e) => !e.duplicateOf);
    if (entries.some((e) => !e.cardId)) throw new Error(`${dir}/index.json has no card ids: rebuild it (node scripts/build-card-library.mjs).`);
    cards = entries.map(fromIndex);
    for (const e of entries) if (e.image) images.set(e.image.sha256.slice(0, 16), join(index.library, index.language, e.image.dir ?? e.dir, e.image.file));
    thumbs = join(dir, 'thumbs');
    source = `${index.library} (${index.language}, built ${index.builtAt})`;
  } else {
    cards = fromCatalog(catalog, presentation);
    source = 'reviewed release';
  }
  // Executable facts/text come from the checked release, not stale machine-collected metadata. Keep the index's
  // exact image, set title and art metadata. Cards of the release the index does not have are still offered.
  const known = new Set(cards.map((c) => c.id));
  if (dir) {
    const executable = fromCatalog(catalog, presentation), byId = new Map(executable.map((c) => [c.id, c]));
    cards = cards.map((c) => {
      const checked = byId.get(c.id);
      return checked ? { ...c, ...checked, setName: c.setName, rarity: c.rarity, illustrator: c.illustrator,
        image: c.image ?? checked.image, thumb: c.thumb ?? checked.thumb,
        mechanic: c.mechanic ?? checked.mechanic, labels: [...new Set([...c.labels, ...checked.labels])] } : c;
    });
    for (const c of executable) if (!known.has(c.id)) cards.push(c);
  }
  const pool = buildPool(cards, catalog, printingLegality(catalog));

  const raw = Buffer.from(JSON.stringify({ cards }));
  const etag = `"${createHash('sha256').update(raw).digest('base64url').slice(0, 27)}"`;
  const encoded = { br: brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }), gzip: gzipSync(raw, { level: 9 }) };

  function send(req, res) {
    const headers = { 'Cache-Control': 'private, no-cache', ETag: etag, Vary: 'Accept-Encoding' };
    if (req.headers['if-none-match'] === etag) return res.writeHead(304, headers).end();
    headers['Content-Type'] = 'application/json; charset=utf-8';
    const accept = req.headers['accept-encoding'] ?? '';
    const encoding = ['br', 'gzip'].find((x) => new RegExp(`\\b${x}\\b`).test(accept));
    if (encoding) headers['Content-Encoding'] = encoding;
    res.writeHead(200, headers).end(req.method === 'HEAD' ? undefined : encoding ? encoded[encoding] : raw);
  }

  // Images are named by their content, so they never change.
  async function sendImage(req, res, kind, sha) {
    let file = SHA16.test(sha) ? images.get(sha) : null;
    const thumb = file && kind === 'thumb' && join(thumbs, `${sha}.webp`);
    if (thumb && existsSync(thumb)) file = thumb;
    const body = file && await readFile(file).catch(() => null);
    if (!body) return res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    res.writeHead(200, { 'Content-Type': IMAGE_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'private, max-age=31536000, immutable' });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  return { cards, pool, source, send, sendImage };
}
