// metadata.merged.json generator on a synthetic library directory (never the NAS library).
// Card records copy the shape of the card library's metadata; the reviewed bindings are the real
// trusted CN/V20261019 release.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMergedMetadata, mergeLibrary, mergedValidator, reviewedBindings, MERGED_FILE } from '../scripts/build-merged-metadata.mjs';
import { canonicalDefinition } from '../public/rules/card-schema.js';
import { sha256 } from '../public/rules/catalog.js';
import { REVIEW_RECORDS } from '../catalog/zh-CN/V20261019/index.mjs';
import { loadCatalog } from '../server/catalog.mjs';

const KEY = 'CN/V20261019';
const imageOf = (printingId) => REVIEW_RECORDS.find((r) => r.printingId === printingId).image.sha256;
const image = (file, sha256) => ({ file, sha256, asset_id: `sha256:${sha256}`, printing_language: 'zh-Hans', source: 'mik',
  source_url: 'https://tcg.mik.moe/static/img/x.png', width: 300, height: 419, bytes: 1, kind: 'source_card_image', derivation: null,
  verification: { method: 'mik_receipt_sha256_and_complete_decode', human_reviewed: false } });
const block = (kind, display, { attacks = [], abilities = [], effects = [], footer } = {}) => ({ game: 'tcg', kind, source_template_index: 3,
  display: { kind: '宝可梦', hp: null, type: null, stage: null, evolves_from: null, ...display },
  attacks: attacks.map(([name, effect, damage, energy_cost]) => ({ source_template_index: 4, display: { name, effect, damage, energy_cost } })),
  abilities: abilities.map(([name, effect]) => ({ source_template_index: 5, display: { name, effect } })),
  effects: effects.map((effect) => ({ source_template_index: 6, display: { effect } })),
  footers: footer ? [{ source_template_index: 7, display: footer }] : [] });
// The verbose provenance the merged view must leave in metadata.json.
const VERBOSE = { field_provenance: { name: { source: 'mik', human_reviewed: false } }, semantic_equivalence_review: { machine_only: true },
  layout_migration: { new_model_requests: 0 }, derived_normalizations: [{ field: 'blocks.0.stage', old: '2階進化', new: '2阶进化' }],
  rules_engine_implemented: false, not_an_engine_version_mapping: true };
const record = ({ set, number, id = `tcg:zh-Hans:${set}:${number}`, name, blocks, images = [], mark = 'H', mik, language = 'zh-Hans', extra = {} }) => ({
  schema_version: 1, game: 'tcg', printing_language: language, set_id: set, number, number_slug: number?.replace('/', '_') ?? null, id,
  identity_flags: [], metadata_language: 'zh-Hans', name, set_names_zh_hans: ['璀璨诡幻'], display: { name }, blocks,
  text_review: { human_reviewed: false, warnings: ['fallback_text_requires_terminology_review'] }, review_flags: ['card_face_identity_not_independently_checked'],
  human_reviewed: false,
  source_pages: [{ id: '52poke:1', page_id: 1, revision_id: 2, source_url: 'https://wiki.52poke.com/wiki/x', revision_url: 'https://wiki.52poke.com/index.php?oldid=2' }],
  source_printings: [{ page_id: 1, printing: { language: 'zh-Hans', set_name: '璀璨诡幻', set_code: set, series: '朱&紫', release_date: '2026-03-13',
    number: number ?? `${mik?.split('/')[1]}/127`, rarity: 'R', illustrator: 'someone', regulation_mark: mark } }],
  external_source_records: [{ source: 'mik', source_type: 'third-party', id: mik ?? `${set}/${number.split('/')[0]}`, rule_block: extra.ruleBlock ?? 0,
    mechanic: extra.mechanic ?? null, labels: null }],
  attribution: { source: '神奇宝贝百科及其贡献者', license: 'CC-BY-NC-SA-3.0' },
  primary_image: images[0]?.file, images, ...VERBOSE });

const CARDS = {
  'zh-Hans/CSV8C/083_207': record({ set: 'CSV8C', number: '083/207', name: '黑夜魔灵',
    images: [image('CSV8C_083_207.png', imageOf('zh-Hans:CSV8C:083/207'))],
    blocks: [block('pokemon', { hp: 160, type: '超', stage: '2阶进化', evolves_from: '彷徨夜灵' }, {
      abilities: [['咒怨炸弹', '在自己的回合可以使用1次，如果使用了，则令这只宝可梦【昏厥】。给对手的1只宝可梦身上，放置13个伤害指示物。']],
      attacks: [['影子束缚', '在下一个对手的回合，受到这个招式影响的宝可梦，无法撤退。', '150', ['超', '超', '无', null]]],
      footer: { weakness: '恶', weaknessnumber: '×2', resistance: '斗', resistancenumber: '-30', retreat: '3' } })] }),
  // Metadata without the printed Tera rule.
  'zh-Hans/CSV8C/159_207': record({ set: 'CSV8C', number: '159/207', name: '多龙巴鲁托ex', extra: { mechanic: 'ex' },
    images: [image('CSV8C_159_207.png', imageOf('zh-Hans:CSV8C:159/207'))],
    blocks: [block('pokemon', { hp: 320, type: '龙', stage: '2阶进化', evolves_from: '多龙奇' }, {
      attacks: [['喷射头击', '', '70', ['无']], ['幻影潜袭', '将6个伤害指示物，以任意方式放置于对手的备战宝可梦身上。', '200', ['火', '超']]],
      footer: { weakness: null, resistance: null, retreat: '1' } })] }),
  // The reviewed image lives under the MIK source ID; the full-number directory is a wiki record with markup.
  'zh-Hans/CSV1C/109': record({ set: 'CSV1C', number: null, id: 'CSV1C/109', mik: 'CSV1C/109', name: '厉害钓竿', mark: 'G',
    images: [image('CSV1C_109.png', imageOf('zh-Hans:CSV1C:109/127'))],
    blocks: [block('trainer', { kind: '训练家', type: '物品卡' }, { effects: ['选择自己弃牌区中的宝可梦和基本能量合计最多3张，在给对手看过之后，放回牌库并重洗牌库。'] })] }),
  'zh-Hans/CSV1C/109_127': record({ set: 'CSV1C', number: '109/127', name: '厉害钓竿', mark: 'G',
    blocks: [block('trainer', { kind: '训练家', type: '物品卡' }, { effects: ['-{zh-hans:选择自己弃牌区中的宝可梦和基本能量卡 基本能量合计最多3张。}-'] })] }),
  'zh-Hans/30thC/103_103': record({ set: '30thC', number: '103/103', name: '宝可梦交替', mark: 'J',
    images: [image('30thC_103_103.png', imageOf('zh-Hans:30thC:103/103'))],
    blocks: [block('trainer', { kind: '训练家', type: '物品卡' }, { effects: ['将自己的战斗宝可梦与\n \n备战宝可梦互换。'] })] }),
  // Two text versions on one page; MIK selected block 1. Same image bytes as Dusknoir but another set: never bound.
  'zh-Hans/CSV2C/001_128': record({ set: 'CSV2C', number: '001/128', name: '皮卡丘', extra: { ruleBlock: 1 },
    images: [image('b.png', '1'.repeat(64)), image('a.png', imageOf('zh-Hans:CSV8C:083/207'))],
    blocks: [block('pokemon', { hp: 40, type: '雷', stage: '基础' }, { attacks: [['咬', null, '10', ['无色']]] }),
      block('pokemon', { hp: 40, type: '雷', stage: '基础' }, { attacks: [['啃咬', '', '10', ['无']]], abilities: [[null, null]] })] }),
  'zh-Hant/CSV8C/083_207': record({ set: 'CSV8C', number: '083/207', name: '黑夜魔靈', language: 'zh-Hant', blocks: [] }),
};
CARDS['zh-Hans/CSV2C/001_128'].primary_image = 'a.png';

async function library() {
  const dir = await mkdtemp(join(tmpdir(), 'merged-metadata-'));
  const index = [];
  for (const [path, m] of Object.entries(CARDS)) {
    await mkdir(join(dir, path), { recursive: true });
    await writeFile(join(dir, path, 'metadata.json'), JSON.stringify(m, null, 2));
    index.push(JSON.stringify({ id: m.id, name: m.name, printing_language: m.printing_language, set_id: m.set_id, number: m.number,
      metadata_file: `${path}/metadata.json`, ...(m.number ? {} : { mik_id: m.id }) }));
  }
  await writeFile(join(dir, 'index.jsonl'), `${index.join('\n')}\n`);
  return dir;
}
const snapshot = async (dir) => Object.fromEntries(await Promise.all([...Object.keys(CARDS).map((p) => `${p}/metadata.json`), 'index.jsonl']
  .map(async (p) => [p, await readFile(join(dir, p), 'utf8')])));
const merged = async (dir, path) => JSON.parse(await readFile(join(dir, path, MERGED_FILE), 'utf8'));

test('one merged file per indexed card of the language; sources are never written', async () => {
  const dir = await library(), before = await snapshot(dir);
  const summary = await buildMergedMetadata({ library: dir, requireAllBindings: false });
  assert.equal(summary.records, 6);
  assert.equal(summary.written, 6);
  assert.equal(summary.bound, 5, 'Four reviewed printings; one of them in two directories.');
  assert.deepEqual(await snapshot(dir), before, 'metadata.json and index.jsonl are untouched.');
  assert.deepEqual(await readdir(join(dir, 'zh-Hant/CSV8C/083_207')), ['metadata.json'], 'Another language is not merged.');
  // Idempotent; --check notices a changed source record without writing.
  assert.equal((await buildMergedMetadata({ library: dir, requireAllBindings: false })).unchanged, 6);
  const path = join(dir, 'zh-Hans/CSV2C/001_128/metadata.json');
  await writeFile(path, (await readFile(path, 'utf8')).replace('皮卡丘', '雷丘'));
  const check = await buildMergedMetadata({ library: dir, check: true, requireAllBindings: false });
  assert.deepEqual(check.stale, ['zh-Hans/CSV2C/001_128/metadata.merged.json']);
  assert.equal((await merged(dir, 'zh-Hans/CSV2C/001_128')).card.name, '皮卡丘');
  await rm(dir, { recursive: true });
});

test('the library record is reduced to identity, printed content, images, sources and review level', async () => {
  const dir = await library();
  await buildMergedMetadata({ library: dir, requireAllBindings: false });
  const noir = await merged(dir, 'zh-Hans/CSV8C/083_207');
  assert.deepEqual(Object.keys(noir), ['schema', 'id', 'generatedFrom', 'printing', 'card', 'images', 'sources', 'review', 'license', 'rules']);
  assert.deepEqual(noir.printing, { game: 'tcg', language: 'zh-Hans', setCode: 'CSV8C', number: '083/207', setName: '璀璨诡幻',
    series: '朱&紫', releasedOn: '2026-03-13', rarity: 'R', illustrator: 'someone', regulationMark: 'H' });
  assert.deepEqual(noir.card.attacks, [{ name: '影子束缚', cost: ['超', '超', '无'], damage: '150', text: '在下一个对手的回合，受到这个招式影响的宝可梦，无法撤退。' }]);
  assert.deepEqual([noir.card.weakness, noir.card.resistance, noir.card.retreat], [{ type: '恶', value: '×2' }, { type: '斗', value: '-30' }, 3]);
  assert.deepEqual(noir.sources.map((s) => s.kind), ['52poke', 'mik']);
  assert.deepEqual(noir.review, { level: 'machine', warnings: ['card_face_identity_not_independently_checked', 'fallback_text_requires_terminology_review'] });
  const text = JSON.stringify(noir);
  for (const key of Object.keys(VERBOSE)) assert(!text.includes(key), key);
  // MIK-keyed directory: no invented full number.
  const rod = await merged(dir, 'zh-Hans/CSV1C/109');
  assert.equal(rod.printing.number, null);
  assert.equal(rod.printing.sourceCardId, 'CSV1C/109');
  assert.deepEqual(rod.card.text, ['选择自己弃牌区中的宝可梦和基本能量合计最多3张，在给对手看过之后，放回牌库并重洗牌库。']);
  // The source's selected block is the card; the other version is kept, unselected; empty template slots drop.
  const pika = await merged(dir, 'zh-Hans/CSV2C/001_128');
  assert.deepEqual(pika.card.attacks, [{ name: '啃咬', cost: ['无'], damage: '10' }]);
  assert.equal(pika.card.abilities, undefined);
  assert.deepEqual(pika.otherVersions.map((v) => v.attacks[0].name), ['咬']);
  assert.deepEqual(pika.images.map((i) => i.file), ['a.png', 'b.png'], 'Primary image first.');
  assert.deepEqual(pika.rules, {}, 'Identical image bytes in another set do not bind a printing.');
  await rm(dir, { recursive: true });
});

test('reviewed printings carry the trusted release definition verbatim and the differences the review found', async () => {
  const dir = await library();
  await buildMergedMetadata({ library: dir, requireAllBindings: false });
  const catalog = await loadCatalog();
  const noir = (await merged(dir, 'zh-Hans/CSV8C/083_207')).rules[KEY];
  const definition = catalog.definition('cn:pokemon:dusknoir:csv8c-083');
  assert.deepEqual(noir.definition, definition);
  assert.equal(noir.definitionSha256, await sha256(canonicalDefinition(definition)));
  assert.equal(noir.release.sha256, (await reviewedBindings()).get(noir.printingId).binding.release.sha256);
  assert.equal(noir.identityReview, 'verified');
  assert.deepEqual(noir.differences, [], '【】 marks and whitespace are not differences.');
  assert.deepEqual((await merged(dir, 'zh-Hans/CSV8C/159_207')).rules[KEY].differences.map((d) => d.field), ['tera']);
  assert.deepEqual((await merged(dir, 'zh-Hans/30thC/103_103')).rules[KEY].differences,
    [{ field: 'regulationMark', metadata: 'J', reviewed: 'I' }]);
  // Both directories of the same printing are bound; only the wiki record's text differs.
  const [mik, wiki] = [await merged(dir, 'zh-Hans/CSV1C/109'), await merged(dir, 'zh-Hans/CSV1C/109_127')];
  assert.equal(mik.rules[KEY].printingId, 'zh-Hans:CSV1C:109/127');
  assert.equal(wiki.rules[KEY].image.path, 'zh-Hans/CSV1C/109/CSV1C_109.png');
  assert.deepEqual(mik.rules[KEY].differences, []);
  assert.deepEqual(wiki.rules[KEY].differences.map((d) => d.field), ['text']);
  await rm(dir, { recursive: true });
});

test('every reviewed printing must find a library directory; escaping paths and malformed views are refused', async () => {
  const dir = await library();
  await assert.rejects(buildMergedMetadata({ library: dir }), /Reviewed printings without a library directory: .*zh-Hans:CSVH1C:/);
  const bindings = await reviewedBindings();
  assert.equal(bindings.size, REVIEW_RECORDS.length);
  const { unbound } = await mergeLibrary({ library: dir, requireAllBindings: false, bindings });
  assert.equal(unbound.length, REVIEW_RECORDS.length - 4);
  await writeFile(join(dir, 'index.jsonl'), `${JSON.stringify({ id: 'x', printing_language: 'zh-Hans', metadata_file: '../outside/metadata.json' })}\n`);
  await assert.rejects(buildMergedMetadata({ library: dir, requireAllBindings: false }), /escapes the library/);
  const validate = await mergedValidator();
  const view = await merged(dir, 'zh-Hans/CSV8C/083_207').catch(() => null);
  assert.equal(view, null, 'Nothing was written by the refused runs.');
  await rm(dir, { recursive: true });
  const fresh = await library();
  await buildMergedMetadata({ library: fresh, requireAllBindings: false });
  const good = await merged(fresh, 'zh-Hans/CSV8C/083_207');
  assert(validate(good));
  assert(!validate({ ...good, field_provenance: {} }), 'No unreviewed extra fields.');
  assert(!validate({ ...good, rules: { 'CN/latest': good.rules[KEY] } }), 'Rules are keyed REGION/VERSION.');
  assert(!validate({ ...good, rules: { [KEY]: { ...good.rules[KEY], definition: { ...good.rules[KEY].definition, kind: 'item' } } } }),
    'The definition is a CardDefinition.');
  await rm(fresh, { recursive: true });
});
