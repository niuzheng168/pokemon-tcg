// The card library (server/library.mjs over a small index of real library_prod records, tests/fixtures/card-library),
// the pool it makes with the reviewed release (public/card-pool.js), its filters (public/library.js) and the deck
// builder's checks (public/deck-check.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadCatalog, ROOT } from '../../server/catalog.mjs';
import { loadLibrary } from '../../server/library.mjs';
import { filterCards, browseCards, groupPrintings, cardKey, emptyFilters } from '../../public/library.js';
import { checkDeck, printingLegality } from '../../public/deck-check.js';
import { PRINTINGS as REVIEWED_PRINTINGS } from '../../catalog/zh-CN/V20261019/index.mjs';
import { pickCover, coverDecisions } from '../../scripts/build-card-library.mjs';

const FIXTURE = join(ROOT, 'tests/fixtures/card-library');
const catalog = await loadCatalog();
const meta = JSON.parse(await readFile(join(ROOT, 'public/data/cn/V20261019/decks.json'), 'utf8'));
const library = await loadLibrary({ dir: FIXTURE, catalog, presentation: meta.cards });
const { cards, byId } = library.pool;
const find = (f) => filterCards(cards, { ...emptyFilters(), ...f });
const names = (list) => new Set(list.map((c) => c.name));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;

test('the library is every card of the index plus the release, one per printing; the release\'s cards are the playable ones', async () => {
  const index = JSON.parse(await readFile(join(FIXTURE, 'index.json'), 'utf8')).entries;
  const unique = index.filter((e) => !e.duplicateOf);
  assert.ok(unique.length < index.length, 'the fixture has a duplicate record');
  const released = catalog.printings().map((p) => p.printingId);
  assert.equal(cards.length, new Set([...unique.map((e) => e.cardId), ...released]).size);
  assert.equal(new Set(cards.map((c) => c.id)).size, cards.length);
  assert.ok(cards.every((c) => ID.test(c.id)));
  assert.deepEqual(cards.filter((c) => c.implemented).map((c) => c.id).sort(), released.sort());

  // A reviewed card of the index: its reviewed texts, the library's image, the kernel's limits and legality.
  const pikachu = byId.get('zh-Hans:CSVH1C:008/059');
  assert.deepEqual([pikachu.name, pikachu.kind, pikachu.stage, pikachu.hp, pikachu.types, pikachu.implemented, pikachu.review],
    ['皮卡丘ex', 'pokemon', 'basic', 190, ['Lightning'], true, 'reviewed']);
  assert.ok(pikachu.attacks.some((a) => a.name === '强劲伏特' && a.text.startsWith('抛掷1次硬币')));
  assert.ok(pikachu.features.includes('ex'));
  assert.match(pikachu.image, /^library\/image\/[0-9a-f]{16}$/);
  assert.match(pikachu.thumb, /^library\/thumb\/[0-9a-f]{16}$/);
  assert.deepEqual(pikachu.legal, printingLegality(catalog).get(pikachu.id));
  // A release card the index lacks keeps the release's own image.
  const bolt = cards.find((c) => c.name === '猛雷鼓ex');
  assert.ok(bolt.implemented && bolt.image.startsWith('img/cn-cards/'));

  // Cards not implemented yet: limits and legality from what is printed.
  const thievul = byId.get('zh-Hans:CS6bC:103/131');
  assert.deepEqual([thievul.implemented, thievul.features, thievul.limit, thievul.legal], [false, ['ability'], 4, { standard: false, open: true }]);
  assert.deepEqual(byId.get('zh-Hans:CS5.5C:007/066').groups, [{ key: 'cn-radiant', maximum: 1 }]);
  assert.equal(byId.get('zh-Hans:CSM1.5C:019').limit, 1); // Prism Star: 1 per name
  assert.deepEqual(byId.get('zh-Hans:CSV7C:181/204').groups, [{ key: 'cn-ace-spec', maximum: 1 }]);
  const fairy = byId.get('zh-Hans:CSM1DC:FAI');
  assert.deepEqual([fairy.limit, fairy.legal], [null, { standard: false, open: true }]); // no Fairy Energy in Standard
  assert.deepEqual(byId.get('zh-Hans:CSM1aC:060/151').legal, { standard: false, open: false }); // banned with 破罐破摔
  assert.deepEqual(byId.get('zh-Hans:CSV7C:191/204').legal, { standard: true, open: true });
  // The CBB decks' numbers 「20 03/06」 become ids without a space; the number stays as printed.
  assert.equal(byId.get('zh-Hans:CBB3C:20-03/06').number, '20 03/06');
});

test('without an index the library is the release\'s printings, all playable', async () => {
  const own = await loadLibrary({ dir: null, catalog, presentation: meta.cards });
  assert.equal(own.cards.length, catalog.printings().length);
  assert.ok(own.pool.cards.every((c) => c.implemented));
  assert.ok(own.pool.cards.filter((c) => c.implementation === 'reviewed').every((c) => c.image));
  const flaaffy = own.pool.byId.get('zh-Hans:CSVH1C:012/059');
  assert.deepEqual([flaaffy.evolvesFrom, flaaffy.abilities[0].name, flaaffy.legal], ['咩利羊', '电气发电机', { standard: false, open: true }]);
  assert.deepEqual(flaaffy.weakness, { type: 'Fighting', value: '×2' });
  assert.match(own.pool.byId.get('zh-Hans:CSVH1C:008/059').rule, /ex规则/);
});

test('filters: name, skill, kind, playable, type, stage, category, features, HP, weakness, retreat, format, series, set and mark', () => {
  assert.ok(find({ name: '皮卡丘' }).every((c) => c.name.includes('皮卡丘')));
  // The fixture's 皮卡丘 cards, and those the release adds (the release grows as more cards are certified).
  const pikachus = find({ name: '皮卡丘' });
  for (const name of ['皮卡丘ex', '皮卡丘', '皮卡丘V', '冲浪皮卡丘V', '船长 皮卡丘', '冲浪皮卡丘VMAX']) assert.ok(names(pikachus).has(name), name);
  assert.deepEqual(names(pikachus), names([...cards.filter((c) => c.name.includes('皮卡丘'))]));
  assert.ok(names(find({ skill: '电气发电机' })).has('茸茸羊'));
  const counters = find({ skill: '伤害指示物' });
  assert.ok(counters.length > 0 && counters.every((c) => c.skills.some((s) => `${s.name}${s.text}`.includes('伤害指示物'))));
  assert.ok(find({ q: '强劲伏特' }).some((c) => c.id === 'zh-Hans:CSVH1C:008/059'));
  assert.ok(find({ q: 'CS6.5C' }).every((c) => c.setCode === 'CS6.5C'));
  assert.ok(find({ kind: 'trainer', category: 'supporter' }).every((c) => c.kind === 'trainer' && c.category === 'supporter'));
  assert.equal(find({ play: 'yes' }).length, catalog.printings().length);
  assert.ok(find({ play: 'no' }).every((c) => !c.implemented));
  assert.deepEqual(names(find({ name: '皮卡丘ex', play: 'yes' })), new Set(['皮卡丘ex']));
  assert.ok(find({ types: ['Lightning'] }).every((c) => c.types.includes('Lightning')));
  assert.ok(find({ types: ['Fairy'] }).length > 0 && find({ types: ['Fairy'] }).every((c) => c.types.includes('Fairy')));
  assert.ok(find({ types: ['Fairy'] }).some((c) => c.id === 'zh-Hans:CSM1DC:FAI'));
  assert.ok(find({ stage: 'vmax' }).every((c) => c.stage === 'vmax'));
  assert.ok(find({ stage: 'vmax' }).some((c) => c.name === '梦幻VMAX'));
  // Feature filters: the fixture's cards are found, and every card found has the features (the release adds more).
  for (const [features, fixtureNames] of [[['Radiant'], ['光辉喷火龙', '光辉水箭龟']], [['GX', 'TAG TEAM'], ['呆呆兽&可达鸭GX']]]) {
    const found = find({ features });
    for (const name of fixtureNames) assert.ok(names(found).has(name), name);
    assert.ok(found.every((c) => features.every((f) => c.features.includes(f))), features.join());
  }
  const ex = find({ features: ['ex', 'ability'] });
  assert.ok(ex.length > 0 && ex.every((c) => c.features.includes('ex') && c.abilities.length));
  assert.ok(find({ features: ['acespec'] }).every((c) => c.groups.some((g) => g.key === 'cn-ace-spec')));
  const big = find({ hpMin: '200', sort: 'hp' });
  assert.ok(big.every((c) => c.hp >= 200) && big.every((c, i) => !i || big[i - 1].hp >= c.hp));
  assert.ok(find({ hpMax: '60' }).every((c) => c.kind === 'pokemon' && c.hp <= 60));
  assert.ok(find({ weakness: 'Fighting' }).every((c) => c.weakness.type === 'Fighting'));
  assert.ok(find({ retreat: '0' }).every((c) => c.retreat === 0));
  assert.ok(find({ format: 'standard' }).every((c) => c.legal.standard));
  assert.ok(find({ series: 'sun-moon' }).length > 0 && find({ series: 'sun-moon' }).every((c) => c.series === 'sun-moon'));
  assert.ok(find({ set: 'CSV8C' }).every((c) => c.setCode === 'CSV8C'));
  assert.ok(find({ mark: '-' }).every((c) => c.mark === null));
  const newest = find({ sort: 'new' });
  assert.ok(newest.every((c, i) => !i || (newest[i - 1].releasedOn ?? '') >= (c.releasedOn ?? '')));
  assert.deepEqual(find({ name: '不存在的卡' }), []);
  // The default order: Pokémon, then Trainers, then Energy.
  assert.deepEqual([...new Set(find({}).map((c) => c.kind))], ['pokemon', 'trainer', 'energy']);
});

test('printings with the same printed game text are one card; the library shows the printing that matches', () => {
  groupPrintings(cards); // as the pages' loadPool does
  const switches = byId.get('zh-Hans:CSVH1C:046/059').printings;
  assert.equal(switches[0].id, 'zh-Hans:CSVH6C:036');
  assert.ok(['zh-Hans:30thC:103/103', 'zh-Hans:CSVH1C:046/059'].every((id) => switches.includes(byId.get(id))));
  // Playable first, then newest.
  const order = (c) => [c.implemented ? 0 : 1, c.releasedOn ?? ''];
  switches.slice(1).forEach((c, i) => {
    const [a, b] = [order(switches[i]), order(c)];
    assert.ok(a[0] < b[0] || (a[0] === b[0] && a[1] >= b[1]), `${switches[i].id} before ${c.id}`);
  });
  assert.equal(byId.get('zh-Hans:30thC:103/103').printings, switches);
  assert.ok(['zh-Hans:CSVE1C:LIG', 'zh-Hans:CSVH1C:LIG'].every((id) => byId.get('zh-Hans:CSVH1C:LIG').printings.includes(byId.get(id))));
  assert.deepEqual(byId.get('zh-Hans:CS6.5C:013/072').printings.map((c) => c.id), ['zh-Hans:CS6.5C:013/072', 'zh-Hans:CS6.5C:076/072']);
  // Whitespace, 【】 marks and the rule-box text only reviewed printings carry are no difference; printed values are.
  const pikachu = byId.get('zh-Hans:CSVH1C:008/059');
  assert.equal(cardKey({ ...pikachu, rule: '', attacks: pikachu.attacks.map((a) => ({ ...a, text: `【${a.text}】 ` })) }), cardKey(pikachu));
  assert.notEqual(cardKey({ ...pikachu, hp: 200 }), cardKey(pikachu));
  assert.notEqual(cardKey({ ...pikachu, attacks: pikachu.attacks.map((a) => ({ ...a, damage: '999' })) }), cardKey(pikachu));

  const browse = (f) => browseCards(cards, { ...emptyFilters(), ...f });
  const all = browse({});
  assert.equal(all.printings, cards.length);
  assert.equal(all.cards.length, new Set(cards.map((c) => c.printings)).size);
  assert.ok(all.cards.length < cards.length);
  assert.deepEqual(browse({ name: '宝可梦交替' }).cards.map((c) => c.id), ['zh-Hans:CSVH6C:036']);
  const older = browse({ name: '宝可梦交替', set: 'CSVH1C' });
  assert.deepEqual([older.cards.map((c) => c.id), older.printings], [['zh-Hans:CSVH1C:046/059'], 1]);
  assert.deepEqual(browse({ name: '宝可梦交替', q: '046/059' }).cards.map((c) => c.id), ['zh-Hans:CSVH1C:046/059']);
});

test('a printing\'s cover is its largest image of the same face', () => {
  const img = (sha, width, sources = []) => ({ file: `${sha}.png`, sha256: sha.repeat(64), width, height: Math.round(width * 1.4), sources });
  const mik = img('a', 300, ['mik']), wiki = img('b', 868), official = img('c', 868, ['official']), mirror = img('d', 1833, ['official']);
  const looks = { b: 1.2, c: 0.9, d: 9.2 }, distance = (a, b) => looks[b.sha256[0]];
  // The official image first among equal sizes; a mirror foil of the same number is another face.
  assert.equal(pickCover([mik, wiki, official, mirror], distance), official);
  assert.equal(pickCover([mik, mirror], distance), mik);
  assert.equal(pickCover([mik, wiki], () => null), mik); // not compared: the primary image
  assert.equal(pickCover([official, mik], distance), official); // never a smaller one
  assert.equal(pickCover([], distance), null);

  // The user's decisions from looking at both images replace the comparison; one that no longer fits the record fails.
  const record = { id: 'r1', images: [mik, wiki, mirror] };
  const decided = coverDecisions([record], [
    { id: 'r1', primary: mik.sha256, image: wiki.sha256, sameFace: false },
    { id: 'r1', primary: mik.sha256, image: mirror.sha256, sameFace: true }]);
  const decide = (a, b) => { const d = decided.get(`r1|${a.sha256}|${b.sha256}`); return d === undefined ? distance(a, b) : d ? 0 : null; };
  assert.equal(pickCover(record.images, decide), mirror);
  assert.throws(() => coverDecisions([record], [{ id: 'r1', primary: wiki.sha256, image: mirror.sha256, sameFace: true }]), /Stale cover decision: r1/);
  assert.throws(() => coverDecisions([record], [{ id: 'r2', primary: mik.sha256, image: mirror.sha256, sameFace: true }]), /Stale cover decision: r2/);
});

test('deck checks list every problem in words, and agree with the kernel on the preconstructed decks', () => {
  const legality = printingLegality(catalog);
  assert.ok(REVIEWED_PRINTINGS.every((p) => legality.get(p.printingId).open));
  assert.ok([...legality.values()].some((l) => !l.open), 'machine implementation does not bypass format or latest-text review');
  for (const d of meta.decks) {
    assert.deepEqual(checkDeck(catalog, d.cards, d.format.id), { count: 60, issues: [], legal: true }, d.id);
    assert.deepEqual(checkDeck(catalog, d.cards, d.format.id, library.pool), { count: 60, issues: [], legal: true }, d.id);
  }
  const bolt = meta.decks.find((d) => d.id === 'raging-bolt-679141').cards;
  const tooMany = bolt.map(([id, n], i) => [id, i === 0 ? 5 : n]);
  for (const pool of [null, library.pool]) {
    const r = checkDeck(catalog, tooMany, 'standard', pool);
    assert.equal(r.legal, false);
    assert.deepEqual(r.issues, ['卡组需要正好 60 张卡，现在是 62 张。', '同名卡「猛雷鼓ex」最多放 4 张，现在有 5 张。']);
  }
  const ace = catalog.printings().filter((p) => catalog.definitionFor(p.printingId).deckLimits.groups.some((g) => g.key === 'cn-ace-spec'))
    .slice(0, 2).map((p) => [p.printingId, 1]);
  assert.ok(checkDeck(catalog, ace, 'open').issues.some((x) => /ACE SPEC 卡整副卡组最多放 1 张，现在有 2 张/.test(x)));
  assert.ok(checkDeck(catalog, [['zh-Hans:CSVE1C:LIG', 60]], 'open').issues.includes('卡组里至少要有 1 张基础宝可梦。'));
  assert.deepEqual(checkDeck(catalog, [], 'expanded').issues, ['未知的赛制。']);

  // Library cards not implemented yet: the list is checked like any other, and cannot be played.
  assert.equal(bolt[0][1], 3);
  const mixed = [...bolt.slice(1), ['zh-Hans:CS5.5C:007/066', 1], ['zh-Hans:CS5.5C:015/066', 1], ['zh-Hans:CS6bC:103/131', 1]];
  const r = checkDeck(catalog, mixed, 'standard', library.pool);
  assert.deepEqual([r.count, r.legal], [60, false]);
  // Which of them are still unimplemented follows the release (狐大盗 is; the Radiant ones may already play).
  const pending = mixed.slice(-3).map(([id]) => byId.get(id)).filter((c) => !c.implemented).map((c) => `「${c.name}」`).join('');
  assert.ok(pending.includes('「狐大盗」'));
  assert.deepEqual(r.issues, [
    `${pending}还没有实现对战规则，暂时不能用于对战。`,
    '「光辉喷火龙」（CS5.5C 007/066）不能在标准赛使用。',
    '「光辉水箭龟」（CS5.5C 015/066）不能在标准赛使用。',
    '「狐大盗」（CS6bC 103/131）不能在标准赛使用。',
    '光辉宝可梦整副卡组最多放 1 张，现在有 2 张。',
  ]);
  // 夜光能量 CBB3C has no image and no identical reviewed reprint: still not implemented.
  assert.deepEqual(checkDeck(catalog, [['zh-Hans:CBB3C:20-03/06', 60]], 'open', library.pool).issues,
    ['「夜光能量」还没有实现对战规则，暂时不能用于对战。', '卡组里至少要有 1 张基础宝可梦。', '同名卡「夜光能量」最多放 4 张，现在有 60 张。']);
  assert.ok(checkDeck(catalog, [['zh-Hans:NOPE:001/001', 1]], 'open', library.pool).issues.includes('卡池里没有这张卡：zh-Hans:NOPE:001/001。'));
});
