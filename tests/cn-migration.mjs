import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditCnMigration, stableReportJSON } from '../scripts/audit-cn-migration.mjs';
import { catalogCandidateFacts, loadReviewedCatalogRelease } from '../public/rules/catalog-release.js';
import { fixture as ruleFixture, RULESET, EVIDENCE } from './official-rules/fixtures.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const cli = join(root, 'scripts/audit-cn-migration.mjs');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const SNAPSHOT = 'tools/52poke-cards/snapshots/2026.10.18';

async function put(folder, name, data) {
  const path = join(folder, name);
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, typeof data === 'object' && !Buffer.isBuffer(data) ? JSON.stringify(data) : data);
}

async function snapshot(folder, pages) {
  const files = {};
  for (const [name, rows] of [['cards.jsonl.gz', pages], ['display-zh-hans.jsonl.gz', pages.map((p) => ({ id: p.id }))]]) {
    const text = rows.map((p) => JSON.stringify(p) + '\n').join(''), bytes = gzipSync(text, { mtime: 0 });
    files[name] = { records: rows.length, gzip_bytes: bytes.length, gzip_sha256: hash(bytes),
      published_uncompressed_bytes: Buffer.byteLength(text), published_uncompressed_sha256: hash(text) };
    if (name === 'cards.jsonl.gz') Object.assign(files[name], {
      printing_rows: pages.reduce((sum, p) => sum + p.printings.length, 0),
      game_page_counts: { tcg: pages.filter((p) => p.games.includes('tcg')).length,
        pocket: pages.filter((p) => p.games.includes('pocket')).length },
    });
    await put(folder, `${SNAPSHOT}/${name}`, bytes);
  }
  await put(folder, `${SNAPSHOT}/manifest.json`, { archive_release: '2026.10.18', files });
}

async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'cn-migration-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const cards = [
    { id: 'legacy-a-7', set: 'legacy-a', name: 'A', count: 4, kind: 'pokemon', hp: 100,
      attacks: [{ name: 'One', cost: ['Water'], damage: '20+', text: 'Legacy semantics',
        effect: { flipBonus: 20, status: 'poisoned' } }], power: { kind: 'oldPower' } },
    { id: 'legacy-b-3', set: 'legacy-b', name: 'B', count: 4, kind: 'trainer', trainer: 'drawThree' },
    { id: 'legacy-c-009', set: 'legacy-c', name: 'C', count: 52, kind: 'energy', energyType: 'Water' },
  ];
  await put(folder, 'public/data/decks/index.json', { decks: ['first'], modern: [] });
  await put(folder, 'public/data/decks/first/cards.json', { name: 'First', cards });
  const pages = [
    { id: '52poke:1', games: ['tcg'], revision_id: 10, source_wikitext_sha256: 'a'.repeat(64),
      card_blocks: [{ game: 'tcg', kind: 'pokemon', hp: 70, source_template_index: 3, attacks: [{ damage: '30' }] }],
      printings: [
        { language: 'zh-Hans', set_code: 'SV-P', number: '0007/SV-P', series: '朱&紫',
          regulation_mark: 'G', release_date: '2025-01-01', source_template_index: 7 },
        { language: 'zh-Hans', set_code: 'SetCase', number: '10 02/04', series: null, regulation_mark: null },
        { language: 'zh-Hans', set_code: 'Other', number: 'DAR', series: null, regulation_mark: null },
        { language: 'zh-Hant', set_code: 'TC', number: '001/151', series: '朱&紫', regulation_mark: 'G' },
      ] },
    { id: '52poke:2', games: ['pocket'], revision_id: 20, source_wikitext_sha256: 'b'.repeat(64),
      card_blocks: [{ game: 'pocket', kind: 'trainer' }],
      printings: [{ language: 'zh-Hans', set_code: 'POCKET', number: '001/001' }] },
  ];
  await snapshot(folder, pages);
  await put(folder, 'public/data/locales/zh-CN.js', '// Presentation only.\nexport default ' + JSON.stringify({
    cards: { 'legacy-a-7': { source: '52poke:1', name: '甲', scan: {
      image_language: 'zh-Hant', printings: [{ language: 'zh-Hant', number: '001/151' }] } },
    'legacy-b-3': { source: '52poke:2' } },
    sources: { '52poke:1': { revision: 10, raw_sha256: 'a'.repeat(64) },
      '52poke:2': { revision: 20, raw_sha256: 'b'.repeat(64) } },
  }) + ';\n');
  await put(folder, 'public/ui.js', "import { Game } from './engine.js';\nnew Game({}); Game.restore({});\n");
  await put(folder, 'public/rules/handlers.js', "const ids = ['cn.draw@1', 'cn.heal@1', 'cn.draw@1'];");
  return { folder, cards, pages };
}

async function treeBytes(folder, prefix = '') {
  const rows = [];
  for (const e of await readdir(join(folder, prefix), { withFileTypes: true })) {
    const path = join(prefix, e.name);
    if (e.isDirectory()) rows.push(...await treeBytes(folder, path));
    else {
      const info = await stat(join(folder, path));
      rows.push({ path, size: info.size, mtimeMs: info.mtimeMs, sha256: hash(await readFile(join(folder, path))) });
    }
  }
  return rows.sort((a, b) => a.path < b.path ? -1 : 1);
}

test('identical offline inputs yield byte-identical reports independent of cwd, with no source mutation', async (t) => {
  const { folder } = await fixture(t), before = await treeBytes(folder);
  const run = (cwd) => spawnSync(process.execPath, [cli, '--json', '--root', folder], { encoding: 'utf8', cwd });
  const a = run(root), b = run(tmpdir());
  assert.equal(a.status, 2, a.stderr); assert.equal(b.status, 2, b.stderr);
  assert.equal(a.stderr, ''); assert.equal(a.stdout, b.stdout);
  assert.equal(JSON.parse(a.stdout).officialAdmission, false);
  assert.equal(a.stdout.includes(folder), false);
  assert.deepEqual(await treeBytes(folder), before);
});

test('scan all catalogs before filtering, including unindexed cards and conflicting definitions', async (t) => {
  const { folder, cards } = await fixture(t);
  await put(folder, 'public/data/decks/orphan/cards.json', { cards: [
    { ...cards[0], count: 1, hp: 250 }, { ...cards[2], count: 59 },
    { id: 'orphan-only', set: 'OR', name: 'Orphan', kind: 'trainer', trainer: 'newLegacy', count: 1 },
  ] });
  const r = await auditCnMigration({ root: folder, deck: 'first' });
  assert.equal(r.summary.decks, 2); assert.equal(r.summary.uniqueLegacyCards, 4);
  assert.equal(r.summary.unindexedDecks, 1); assert.equal(r.summary.conflictingLegacyIds, 1);
  assert.equal(r.queue.total, 3); assert.equal(r.queue.cards.some((c) => c.legacyId === 'orphan-only'), false);
  assert(r.queue.cards.find((c) => c.legacyId === 'legacy-a-7').gaps.includes('conflicting-legacy-definitions'));
  assert(r.decks.find((d) => d.key === 'orphan').structuralIssues.includes('not-60-cards'));
});

test('a stale classic bundle or incomplete bundle key set cannot hide the runtime catalog', async (t) => {
  const { folder, cards } = await fixture(t), deck = { name: 'First', cards };
  await put(folder, 'public/data/decks/index.json', { decks: ['first'], modern: [], classicBundle: 'classic.json' });
  await put(folder, 'public/data/decks/classic.json', { first: deck });
  const r = await auditCnMigration({ root: folder });
  assert.equal(r.summary.uniqueLegacyCards, 3);
  await put(folder, 'public/data/decks/classic.json', { first: { ...deck, cards: [
    ...cards, { id: 'bundle-only', kind: 'trainer', count: 1 },
  ] } });
  await assert.rejects(auditCnMigration({ root: folder }), /bundle diverges/);
  await put(folder, 'public/data/decks/classic.json', {});
  await assert.rejects(auditCnMigration({ root: folder }), /keys do not exactly match/);
  await put(folder, 'public/data/decks/index.json', { decks: ['first'], modern: [], classicBundle: '../../secrets.json' });
  await assert.rejects(auditCnMigration({ root: folder }), /Invalid classic bundle path/);
});

test('do not infer identity from old id, translate a printing, lose leading zeros or change opaque numbers', async (t) => {
  const { folder } = await fixture(t), r = await auditCnMigration({ root: folder });
  const a = r.queue.cards.find((c) => c.legacyId === 'legacy-a-7');
  assert.deepEqual(a.legacyIdentity, { setCode: 'legacy-a', number: null, game: null, language: null, inferredFields: [] });
  assert.deepEqual(a.metadata.printings.filter((p) => p.language === 'zh-Hans').map((p) => p.number).sort(),
    ['0007/SV-P', '10 02/04', 'DAR'].sort());
  assert(a.metadata.printings.some((p) => p.setCode === 'SetCase'));
  assert.equal(a.metadata.scan.language, 'zh-Hant');
  assert.equal(r.summary.presentationScanLanguages['zh-Hant'], 1);
});

test('explicit legacy values and self-declared verified fields cannot become content or release approval', async (t) => {
  const { folder, cards } = await fixture(t);
  cards[0] = { ...cards[0], number: '007/999', game: 'tcg', language: 'zh-Hans',
    identityReview: 'verified', implementation: { status: 'verified' }, trustedReleases: { fake: 'self-approved' } };
  await put(folder, 'public/data/decks/first/cards.json', { cards });
  const r = await auditCnMigration({ root: folder }), a = r.queue.cards.find((c) => c.legacyId === 'legacy-a-7');
  assert.equal(a.legacyIdentity.number, '007/999');
  for (const row of r.queue.cards) {
    assert.equal(row.admitted, false);
    for (const gap of ['source-language-unreviewed', 'official-card-erratum-binding-missing',
      'cn-handler-equivalence-unreviewed', 'definition-approval-missing', 'printing-approval-missing', 'trusted-release-missing'])
      assert(row.gaps.includes(gap));
  }
  assert.equal(r.summary.admittedCards, 0); assert.equal(r.summary.approvedDefinitions, 0);
  assert.equal(Object.hasOwn(r, 'trustedReleases'), false);
  await assert.rejects(loadReviewedCatalogRelease({ json: stableReportJSON(r) }),
    (error) => error.code === 'invalid-release-shape');
});

test('even a schema-valid release with reviewed claims and exact candidate digests is denied without independent trust', async () => {
  // Existing synthetic conformance fixtures, not real card approvals.
  const f = await ruleFixture(), definitions = structuredClone(f.definitions), printings = structuredClone(f.catalog.printings());
  const facts = await catalogCandidateFacts({ ruleset: RULESET, definitions, printings, handlers: f.handlers });
  const json = JSON.stringify({ definitions, printings, manifest: {
    schemaVersion: '1.0.0', releaseId: 'migration-test:NOT-PRODUCTION', ...facts,
    review: { reviewId: 'migration-test:claim', reviewerId: 'migration-test:fixture', reviewedOn: '2026-10-20',
      testIds: ['migration-test:no-self-approval'], sourceOfTruth: EVIDENCE },
  } });
  await assert.rejects(loadReviewedCatalogRelease({ json, handlers: f.handlers }),
    (error) => error.code === 'unapproved-release');
});

test('Pocket and ambiguous mixed-game pages never yield physical TCG candidates', async (t) => {
  const { folder, pages } = await fixture(t);
  pages[1].games = ['tcg', 'pocket']; await snapshot(folder, pages);
  const r = await auditCnMigration({ root: folder }), b = r.queue.cards.find((c) => c.legacyId === 'legacy-b-3');
  assert.equal(b.metadata.cnPrintingCandidates, 0); assert.deepEqual(b.metadata.printings, []);
  assert(b.gaps.includes('pocket-or-ambiguous-page-excluded'));
});

test('the exact linked source revision is checked; a changed revision is a queue blocker, not silently remapped', async (t) => {
  const { folder, pages } = await fixture(t);
  pages[0].revision_id = 11; await snapshot(folder, pages);
  const r = await auditCnMigration({ root: folder }), a = r.queue.cards.find((c) => c.legacyId === 'legacy-a-7');
  assert.equal(a.metadata.provenanceMatches, false); assert(a.gaps.includes('presentation-provenance-mismatch'));
  assert.equal(r.summary.linkedProvenanceMismatches, 1);
});

test('compressed and decompressed snapshot integrity failures cannot return partial candidate reports', async (t) => {
  const { folder } = await fixture(t), path = join(folder, SNAPSHOT, 'cards.jsonl.gz');
  const original = await readFile(path);
  await writeFile(path, Buffer.concat([original, Buffer.from('tamper')]));
  await assert.rejects(auditCnMigration({ root: folder }), /compressed hash\/size mismatch/);
  await writeFile(path, original);
  const mf = join(folder, SNAPSHOT, 'manifest.json'), m = JSON.parse(await readFile(mf, 'utf8'));
  m.files['cards.jsonl.gz'].published_uncompressed_sha256 = '0'.repeat(64);
  await writeFile(mf, JSON.stringify(m));
  const result = spawnSync(process.execPath, [cli, '--json', '--root', folder], { encoding: 'utf8' });
  assert.equal(result.status, 1); const r = JSON.parse(result.stdout);
  assert.equal(r.status, 'invalid-input'); assert.equal(r.officialAdmission, false);
  assert.equal(Object.hasOwn(r, 'queue'), false);
});

test('invalid gzip with a matching compressed receipt terminates with an input error, never an incomplete report', async (t) => {
  const { folder } = await fixture(t), bytes = Buffer.from('not a gzip file');
  await put(folder, `${SNAPSHOT}/cards.jsonl.gz`, bytes);
  const path = join(folder, SNAPSHOT, 'manifest.json'), m = JSON.parse(await readFile(path, 'utf8'));
  m.files['cards.jsonl.gz'].gzip_sha256 = hash(bytes); m.files['cards.jsonl.gz'].gzip_bytes = bytes.length;
  await writeFile(path, JSON.stringify(m));
  const r = spawnSync(process.execPath, [cli, '--json', '--root', folder], { encoding: 'utf8', timeout: 5000 });
  assert.equal(r.error, undefined); assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).officialAdmission, false);
});

test('optional library only joins exact opaque printing identities, retains mismatches, and never promotes human-review flags', async (t) => {
  const { folder } = await fixture(t), library = join(folder, 'local-library');
  const id = 'tcg:zh-Hans:SV-P:0007/SV-P';
  await put(library, 'index.jsonl', JSON.stringify({ id, printing_language: 'zh-Hans', metadata_file: 'one/metadata.json' }) + '\n');
  await put(library, 'one/metadata.json', { id, game: 'pocket', printing_language: 'zh-Hans',
    set_id: 'SV-P', number: '7/SV-P', human_reviewed: true, source_pages: [] });
  const before = await treeBytes(library), r = await auditCnMigration({ root: folder, library });
  const a = r.queue.cards.find((c) => c.legacyId === 'legacy-a-7');
  assert.equal(r.reusableEvidence.local.library.linkedMetadata, 1);
  assert.equal(a.metadata.localMetadata[0].indexIdentityMatches, false);
  assert.equal(a.metadata.localMetadata[0].number, '7/SV-P'); assert.equal(a.metadata.localMetadata[0].admitted, false);
  assert(a.gaps.includes('local-metadata-identity-mismatch')); assert.deepEqual(await treeBytes(library), before);
  await put(library, 'index.jsonl', JSON.stringify({ id, printing_language: 'zh-Hans', metadata_file: '../outside.json' }) + '\n');
  await assert.rejects(auditCnMigration({ root: folder, library }), /escapes/);
});

test('frozen MIK observations require the same actual image hash and cannot be approvals', async (t) => {
  const { folder } = await fixture(t), mikSource = join(folder, 'mik'), image = Buffer.from('original bytes');
  await put(folder, 'tools/52poke-cards/mik_merge/example-card-face-observations.json', { observations: [
    { mik_id: 'ABC/DAR', printed_number: 'DAR', image_sha256: hash(image),
      evidence: 'cards/ABC/DAR/image.png', human_reviewed: false },
  ] });
  await put(mikSource, 'index.jsonl', JSON.stringify({ source_card: { setCode: 'ABC', cardIndex: 'DAR' },
    metadata_state: 'done', image_state: 'done' }) + '\n');
  await put(mikSource, 'cards/ABC/DAR/image.png', image);
  const a = await auditCnMigration({ root: folder, mikSource });
  assert.equal(a.reusableEvidence.local.mik.indexedCards, 1);
  assert.equal(a.reusableEvidence.frozenMikObservations[0].imageHashMatchesObservation, true);
  assert.equal(a.reusableEvidence.frozenMikObservations[0].printedNumber, 'DAR');
  assert.equal(a.reusableEvidence.frozenMikObservations[0].admitted, false);
  await put(mikSource, 'cards/ABC/DAR/image.png', Buffer.from('different'));
  const b = await auditCnMigration({ root: folder, mikSource });
  assert.equal(b.reusableEvidence.frozenMikObservations[0].imageHashMatchesObservation, false);
  assert.equal(b.officialAdmission, false);
});

test('sample image bytes are checked independently of human-reviewed claims', async (t) => {
  const { folder } = await fixture(t), original = Buffer.from('image bytes');
  await put(folder, 'tools/52poke-cards/samples/manifest.json', { samples: [{
    id: 'tcg:zh-Hans:ABC:001/001', game: 'tcg', printing_language: 'zh-Hans',
    set_id: 'ABC', number: '001/001', file: 'images/card.png', sha256: hash(original), bytes: original.length,
    human_reviewed: true,
  }] });
  await put(folder, 'tools/52poke-cards/samples/images/card.png', original);
  const a = await auditCnMigration({ root: folder });
  assert.equal(a.reusableEvidence.samples[0].byteHashMatchesManifest, true);
  assert.equal(a.reusableEvidence.samples[0].admitted, false);
  await put(folder, 'tools/52poke-cards/samples/images/card.png', 'other');
  const b = await auditCnMigration({ root: folder });
  assert.equal(b.reusableEvidence.samples[0].byteHashMatchesManifest, false);
  assert(b.evidenceIssues.some((i) => i.code === 'sample-image-hash-mismatch'));
});

test('precise legacy handler arguments are inventoried, but installed primitives do not prove semantic equivalence', async (t) => {
  const { folder } = await fixture(t), r = await auditCnMigration({ root: folder });
  assert.deepEqual(r.installedHandlerIds, ['cn.draw@1', 'cn.heal@1']);
  const a = r.queue.cards.find((c) => c.legacyId === 'legacy-a-7');
  assert.deepEqual(a.variants[0].semantics.attacks[0].effect, { flipBonus: 20, status: 'poisoned' });
  assert.deepEqual(a.variants[0].effectTokens, ['attack.effect.flipBonus', 'attack.effect.status', 'power:oldPower']);
  assert(a.gaps.includes('cn-handler-equivalence-unreviewed')); assert.equal(a.metadata.wikiBlockShapes[0].hp, 70);
  assert.equal(r.website.legacyGameImported, true); assert.equal(r.website.legacyGameConstructed, true);
  assert.equal(r.website.legacySaveRestored, true); assert.equal(r.website.reviewedGameEntryReferenced, false);
});

test('pagination is exact, disjoint and stable; nonexistent filters cannot produce a misleading empty success', async (t) => {
  const { folder } = await fixture(t), full = await auditCnMigration({ root: folder });
  const a = await auditCnMigration({ root: folder, limit: 2 }), b = await auditCnMigration({ root: folder, offset: 2, limit: 2 });
  assert.equal(a.queue.total, 3); assert.equal(a.queue.nextOffset, 2); assert.equal(b.queue.nextOffset, null);
  assert.deepEqual([...a.queue.cards, ...b.queue.cards], full.queue.cards);
  assert.deepEqual(a.summary, full.summary);
  await assert.rejects(auditCnMigration({ root: folder, deck: 'typo' }), /Unknown deck/);
  await assert.rejects(auditCnMigration({ root: folder, card: 'typo' }), /Unknown card/);
  await assert.rejects(auditCnMigration({ root: folder, limit: 0 }), /limit must be positive/);
});

test('malformed legacy counts, executable locale data and path-escaping deck keys fail closed without evaluation', async (t) => {
  const { folder, cards } = await fixture(t);
  await put(folder, 'public/data/decks/index.json', { decks: ['../secret'], modern: [] });
  await assert.rejects(auditCnMigration({ root: folder }), /Invalid or duplicate deck key/);
  await put(folder, 'public/data/decks/index.json', { decks: ['first'], modern: [] });
  cards[0].count = -1; await put(folder, 'public/data/decks/first/cards.json', { cards });
  await assert.rejects(auditCnMigration({ root: folder }), /Malformed legacy card\/count/);
  cards[0].count = 4; await put(folder, 'public/data/decks/first/cards.json', { cards });
  await put(folder, 'public/data/locales/zh-CN.js', 'export default (globalThis.compromised = true, {});');
  await assert.rejects(auditCnMigration({ root: folder }));
  assert.equal(globalThis.compromised, undefined);
});

test('an unfamiliar on-disk catalog name cannot be silently excluded from a successful audit', async (t) => {
  const { folder, cards } = await fixture(t);
  await put(folder, 'public/data/decks/unusual.name/cards.json', { cards });
  await assert.rejects(auditCnMigration({ root: folder }), /cannot omit catalog/);
});

test('CLI never has write, approval or permissive-exit options', () => {
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /never approves/);
  for (const args of [['--write'], ['--approve'], ['--trust-pins'], ['--allow-blocked'], ['--limit', '1e3'],
    ['--limit', '0'], ['--limit', '9007199254740992'], ['--root'], ['--deck', 'x', '--deck', 'y']]) {
    const r = spawnSync(process.execPath, [cli, '--json', ...args], { encoding: 'utf8' });
    assert.equal(r.status, 1); assert.equal(JSON.parse(r.stdout).officialAdmission, false);
  }
});

test('actual repository inventory covers every indexed and on-disk catalog, and no audit object is a release', async () => {
  const report = await auditCnMigration({ root }), index = JSON.parse(await readFile(join(root, 'public/data/decks/index.json')));
  const indexed = [...index.decks, ...index.modern.map((d) => d.key)], actual = new Set();
  for (const deck of report.decks) {
    const file = JSON.parse(await readFile(join(root, `public/data/decks/${deck.key}/cards.json`)));
    for (const c of file.cards) actual.add(c.id);
    assert.equal(deck.admitted, false);
  }
  assert.equal(report.summary.indexedDecks, indexed.length);
  assert.deepEqual(new Set(report.queue.cards.map((c) => c.legacyId)), actual);
  assert.equal(report.summary.uniqueLegacyCards, actual.size);
  assert.equal(report.metadataSnapshot.integrityChecked, true);
  assert.equal(report.reusableEvidence.samples.every((s) => s.byteHashMatchesManifest), true);
  assert.equal(report.officialAdmission, false);
  await assert.rejects(loadReviewedCatalogRelease({ json: stableReportJSON(report) }),
    (error) => ['invalid-release-shape', 'invalid-release-input'].includes(error.code));
});
