import test from 'node:test';
import assert from 'node:assert/strict';
import { getFormat, listFormats, validateFormatDeck, assertMatchFormat, formatTrace } from '../../public/rules/formats.js';
import { createCardCatalog, canonicalJSON, sha256 } from '../../public/rules/catalog.js';
import { canonicalDefinition, canonicalPrinting, assertPrintingShape } from '../../public/rules/card-schema.js';
import { OfficialGame } from '../../public/rules/game.js';
import { catalogCandidateFacts } from '../../public/rules/catalog-release.js';
import { createReviewedGame, restoreReviewedGame } from '../../public/rules/reviewed-game.js';
import { fixture, RULESET, EVIDENCE, binding, settle } from './fixtures.mjs';

// All cards, printings, dates, evidence and approvals here are SYNTHETIC.
// The tests exercise pool policy, not a review/approval of any production card.
const STANDARD = { ...RULESET, id: 'standard' }, OPEN = { ...RULESET, id: 'open' };
// Independent policy oracles transcribed from the reviewed official article.
const BASIC_TYPES = ['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal', 'Fairy'];
const OPEN_SERIES = ['sun-moon', 'sword-shield', 'scarlet-violet'];
const STANDARD_NAMES = [
  '宝可梦捕捉器', '宝可梦交替', '宝可装置3.0', '宝可梦中心的姐姐', '博士的研究', '裁判',
  '超级球', '巢穴球', '反击捕捉器', '反击增幅器', '粉碎之锤', '改造之锤', '高级球',
  '活力头带', '讲究腰带', '精灵球', '老大的指令', '能量回收', '能量输送', '能量再利用',
  '能量转移', '朋友手册', '伤药', '神奇糖果', '西餐厨师', '学习装置',
];
const ruleOnly = [{ ...EVIDENCE[0], kind: 'official-rule' }];
const rejected = (reason) => (e) => e.name === 'RuleViolation' && e.details.reason === reason && e.sourceOfTruth.length > 0;
async function poolFixture(transform = () => {}) {
  const f = await fixture(transform);
  return reprint(f);
}
async function reprint(f, mutate = () => {}) {
  const printings = structuredClone(f.catalog.printings());
  for (const p of printings) {
    p.series ??= 'scarlet-violet'; p.releasedOn ??= '2026-09-16';
  }
  mutate(printings);
  const catalog = await createCardCatalog({
    ruleset: RULESET, definitions: f.definitions, printings, handlers: f.handlers,
    approvedDefinitions: new Map(f.definitions.map((d) => [d.definitionId, canonicalDefinition(d)])),
    approvedPrintings: new Map(printings.map((p) => [p.printingId, canonicalPrinting(p)])),
  });
  return { ...f, catalog };
}
const printing = (ps, id = 'base') => ps.find((p) => p.printingId === `printing:${id}`);
const check = (f, ref = STANDARD) => validateFormatDeck(f.catalog, f.deck, ref);
const game = (f, format = STANDARD, matchMode = 'normal') => new OfficialGame({
  ruleset: RULESET, catalog: f.catalog, decks: [f.deck, f.deck], seed: f.seed, format, matchMode,
});
const review = (format = STANDARD, latestPrintingId = 'printing:potion', sourceOfTruth = EVIDENCE) => ({
  format, latestPrintingId, sourceOfTruth,
});
async function oldPotion(f, mutate = () => {}) {
  const next = await reprint(f, (ps) => {
    const old = { ...structuredClone(printing(ps, 'potion')), printingId: 'printing:old-potion', series: 'sun-moon',
      releasedOn: '2022-10-28', regulationMark: 'C', formatReviews: [review()] };
    ps.push(old); mutate(old, ps);
  });
  return { ...next, deck: f.deck.map((id) => id === 'printing:potion' ? 'printing:old-potion' : id) };
}

test('format snapshots require exact region/version/id, remain immutable, and retain the actual official name lists', () => {
  assert.deepEqual(listFormats().map((f) => f.id), ['standard', 'open']);
  const standard = getFormat(STANDARD), open = getFormat(OPEN);
  assert.equal(standard.snapshotOn, '2026-10-19'); assert.equal(standard.reviewedOn, '2026-10-20');
  assert.equal(standard.effectiveOn, '2026-09-16'); assert.equal(standard.deckSize, 60);
  assert.deepEqual(standard.regulationMarks, ['G', 'H', 'I', 'J']);
  assert.equal(standard.latestTextNames.length, 26); assert.equal(open.latestTextNames.length, 32);
  assert.deepEqual([...standard.latestTextNames].sort(), [...STANDARD_NAMES].sort());
  assert.deepEqual([...open.latestTextNames].sort(), [
    ...STANDARD_NAMES, '捕虫少年', '离洞绳', '谜之化石', '模仿少女', '能量签', '千金小姐',
  ].sort());
  assert.deepEqual(standard.basicEnergyTypes, BASIC_TYPES.slice(0, 8));
  assert.deepEqual(open.basicEnergyTypes, BASIC_TYPES); assert.deepEqual(open.series, OPEN_SERIES);
  assert.deepEqual(open.bannedCards, [
    { kind: 'pokemon', name: '玛夏多', abilityName: '破罐破摔' },
    { kind: 'trainer', name: '阿塞萝拉' }, { kind: 'trainer', name: '全满药' },
  ]);
  assert(standard.latestTextNames.includes('宝可装置3.0') && standard.latestTextNames.includes('老大的指令'));
  assert(!standard.latestTextNames.includes('吧喔基斯') && !standard.latestTextNames.includes('博士的研究（大木博士）'));
  assert(open.latestTextNames.includes('离洞绳') && !standard.latestTextNames.includes('离洞绳'));
  assert.throws(() => { standard.regulationMarks.push('K'); }, TypeError);
  listFormats().pop(); assert.equal(listFormats().length, 2);
  for (const r of [null, {}, 'standard', { ...STANDARD, version: 'latest' }, { ...STANDARD, region: 'TW' },
    { ...STANDARD, version: 'V20261020' }, { ...STANDARD, locale: 'zh-CN' }, { ...STANDARD, id: 'expanded' }])
    assert.throws(() => getFormat(r), /Unsupported format/);
});

test('development pools are not official pools, and prize match mode cannot silently replace pool admission', async () => {
  const f = await fixture();
  assertMatchFormat(f.catalog, 'casual60', 'normal');
  assertMatchFormat(f.catalog, 'tiebreak60', 'tiebreak');
  assert.throws(() => assertMatchFormat(f.catalog, 'tiebreak60', 'normal'), /match mode/);
  assert.throws(() => assertMatchFormat(f.catalog, STANDARD, 'guess'), /match mode/);
  assert.throws(() => assertMatchFormat(f.catalog, { ...STANDARD, region: 'US' }, 'normal'), /incompatible/);
  assert.equal(validateFormatDeck(f.catalog, f.deck, 'casual60').length, 60);
  assert.equal(formatTrace(f.catalog, 'casual60'), null);
  assert.throws(() => check(f), rejected('printing-review-required'));
  assert.throws(() => validateFormatDeck({}, f.deck, STANDARD), /independently approved/);
});

test('official pools need reviewed series and an actual release date within the fixed snapshot, not a guessed prefix or import time', async () => {
  const f = await poolFixture(); check(f);
  for (const mutate of [
    (p) => { delete p.series; p.setCode = 'CS1aC'; },
    (p) => { delete p.releasedOn; }, (p) => { p.releasedOn = '2026-02-30'; },
    (p) => { p.releasedOn = '2026-13-01'; }, (p) => { p.releasedOn = '2026-10-20'; },
  ]) {
    const changed = await reprint(f, (ps) => mutate(printing(ps)));
    assert.throws(() => check(changed), rejected('printing-review-required'));
  }
  const edge = await reprint(f, (ps) => { printing(ps).releasedOn = '2026-10-19'; }); check(edge);
  for (const mutate of [(p) => { p.series = 'CS-prefix'; }, (p) => { p.releasedOn = 20261019; },
    (p) => { p.formatReviews = [{ ...review(), allow: true }]; }, (p) => { p.formatReviews = [{ ...review(), format: 'standard' }]; }]) {
    const p = structuredClone(f.catalog.printing('printing:base')); mutate(p);
    assert.throws(() => assertPrintingShape(p), /Invalid card printing/);
  }
});

test('Standard uses exactly G/H/I/J for ordinary cards, not any alphabetic mark or a UI label', async () => {
  const f = await poolFixture();
  for (const mark of ['G', 'H', 'I', 'J', 'A', 'B', 'C', 'D', 'E', 'F', 'K', null]) {
    const changed = await reprint(f, (ps) => { printing(ps).regulationMark = mark; });
    if (['G', 'H', 'I', 'J'].includes(mark)) check(changed);
    else assert.throws(() => check(changed), rejected('outside-pool'));
  }
});

test('the eight Standard Basic Energies and nine Open Basic Energies are independent of regulation marks and runtime provision effects', async () => {
  for (const type of BASIC_TYPES) {
    const f = await poolFixture((ds) => { ds.find((d) => d.definitionId === 'water').mechanics.baseUnits = [[type]]; });
    const unmarked = await reprint(f, (ps) => { printing(ps, 'water').regulationMark = null; });
    check(unmarked, OPEN);
    if (type === 'Fairy') {
      assert.throws(() => check(unmarked), rejected('outside-pool'));
      assert.throws(() => check(f), rejected('outside-pool'), 'A fake G mark must not bypass the Fairy exclusion.');
    } else check(unmarked);
  }
});

test('listed old printings need explicit latest-text equivalence, not a shared card name', async () => {
  const f = await poolFixture((ds) => { ds.find((d) => d.definitionId === 'potion').name = '伤药'; });
  const old = await oldPotion(f); check(old);
  assert(!old.deck.includes('printing:potion'), 'The anchor is approved catalog content, not a forced deck inclusion.');
  const latest = old.catalog.definitionFor('printing:old-potion');
  assert.equal(latest, old.catalog.definitionFor('printing:potion'));
  for (const reviews of [undefined, [], [review(OPEN)], [review({ ...STANDARD, version: 'V20261018' })],
    [review(), review()], [review(STANDARD, 'printing:potion', ruleOnly)]]) {
    const changed = await oldPotion(f, (p) => { if (reviews) p.formatReviews = reviews; else delete p.formatReviews; });
    assert.throws(() => check(changed), rejected('latest-text-review-required'));
  }
  const notListed = await poolFixture((ds) => { ds.find((d) => d.definitionId === 'potion').name = '吧喔基斯'; });
  const notListedOld = await oldPotion(notListed);
  assert.throws(() => check(notListedOld), rejected('outside-pool'));
});

test('latest-text anchors must exist, be admitted and bind the identical reviewed current definition', async () => {
  const f = await poolFixture((ds) => { ds.find((d) => d.definitionId === 'potion').name = '伤药'; });
  for (const [anchor, reason] of [['printing:absent', 'latest-printing-missing'], ['printing:other', 'latest-printing-mismatch']]) {
    const changed = await oldPotion(f, (p) => { p.formatReviews = [review(STANDARD, anchor)]; });
    assert.throws(() => check(changed), rejected(reason));
  }
  const rotatedAnchor = await oldPotion(f, (_, ps) => { printing(ps, 'potion').regulationMark = 'F'; });
  assert.throws(() => check(rotatedAnchor), rejected('latest-printing-mismatch'));
  const futureAnchor = await oldPotion(f, (_, ps) => { printing(ps, 'potion').releasedOn = '2026-11-01'; });
  assert.throws(() => check(futureAnchor), rejected('printing-review-required'));
});

test('professor/boss card names remain canonical, while different artwork/characters do not bypass same-name deck limits', async () => {
  for (const name of ['博士的研究', '老大的指令']) {
    const f = await poolFixture((ds) => { ds.find((d) => d.definitionId === 'potion').name = name; });
    const old = await oldPotion(f); check(old);
    const over = [...old.deck];
    for (let n = 0; n < 4; n++) over[over.lastIndexOf('printing:water')] = 'printing:potion';
    assert.throws(() => validateFormatDeck(old.catalog, over, STANDARD), /Too many copies/);
  }
});

test('Open admits the three reviewed series, not arbitrary series with a plausible set prefix', async () => {
  const f = await poolFixture();
  for (const series of ['sun-moon', 'sword-shield', 'scarlet-violet', 'anniversary-30', 'promo', 'other']) {
    const changed = await reprint(f, (ps) => { const p = printing(ps); p.series = series; p.regulationMark = null; p.setCode = 'CS1aC'; });
    if (OPEN_SERIES.includes(series)) check(changed, OPEN);
    else assert.throws(() => check(changed, OPEN), rejected('outside-pool'));
  }
});

test('Open anniversary/promotional exceptions use exact product/number identities and distinguish marked 30thC from all 30thDC cards', async () => {
  const f = await poolFixture();
  const cases = [
    ['30thC', '001/001', 'A', true], ['30thC', '001/001', null, false],
    ['30thDC', '001/001', null, true], ['30thDC', '001/001', 'J', true],
    ['PROMO', '001/30th-P', null, true], ['PROMO', '999/30th-P', null, true],
    ['PROMO', '01/30th-P', 'G', false], ['PROMO', '001/S-P', 'G', false],
    ['PROMO', '001/30th-Px', 'G', false], ['30thC-extra', '001/001', 'G', false],
  ];
  for (const [setCode, number, mark, allowed] of cases) {
    const changed = await reprint(f, (ps) => Object.assign(printing(ps), { series: 'anniversary-30', setCode, number, regulationMark: mark }));
    if (allowed) check(changed, OPEN); else assert.throws(() => check(changed, OPEN), rejected('outside-pool'));
  }
});

test('Open banned Pokémon is identified by printed name AND Ability, not all Marshadow or a runtime-suppressed Ability', async () => {
  for (const [name, abilityName, banned] of [['玛夏多', '破罐破摔', true], ['玛夏多', '其他特性', false], ['其他宝可梦', '破罐破摔', false]]) {
    const f = await poolFixture((ds) => {
      const d = ds.find((d) => d.definitionId === 'base'); d.name = name;
      d.mechanics.abilities = [{ abilityId: 'fixture:ability', name: abilityName, mode: 'continuous', usage: null,
        effects: [binding('cn.modifier@1', { field: 'hp', amount: 10, scope: 'self' })], sourceOfTruth: EVIDENCE }];
    });
    if (banned) {
      assert.throws(() => check(f, OPEN), rejected('banned'));
      check(f, STANDARD); // Independent pools: do not apply Open's list everywhere.
    } else check(f, OPEN);
  }
});

test('Open trainer exclusions cannot be evaded by a newer mark, different art/printing or Basic Energy exceptions', async () => {
  for (const name of ['阿塞萝拉', '全满药']) {
    const f = await poolFixture((ds) => { ds.find((d) => d.definitionId === 'potion').name = name; });
    for (const mark of ['G', 'J']) {
      const changed = await reprint(f, (ps) => { printing(ps, 'potion').regulationMark = mark; printing(ps, 'potion').number = '999/999'; });
      assert.throws(() => check(changed, OPEN), rejected('banned'));
    }
  }
});

test('Open has its own larger latest-text list, including cases that cannot use the Standard reprint exception', async () => {
  const f = await poolFixture((ds) => { ds.find((d) => d.definitionId === 'potion').name = '离洞绳'; });
  const old = await oldPotion(f, (p) => { p.formatReviews = [review(OPEN)]; });
  check(old, OPEN); assert.throws(() => check(old), rejected('outside-pool'));
  const unreviewed = await oldPotion(f, (p) => { delete p.formatReviews; });
  assert.throws(() => check(unreviewed, OPEN), rejected('latest-text-review-required'));
  const sameLatest = await oldPotion(f, (p) => { p.formatReviews = [review(OPEN, p.printingId)]; });
  check(sameLatest, OPEN); // An explicit review may confirm the old text is still latest.
});

test('created/restored matches and both player views bind the exact pool and independent prize mode', async () => {
  const f = await poolFixture(), ref = { ...STANDARD }, g = game(f, ref);
  ref.id = 'open';
  assert.equal(g.snapshot().format.id, 'standard'); settle(g);
  assert(g.snapshot().players.every((p) => p.prizes.length === 6));
  for (const viewer of [0, 1]) {
    const v = g.view(viewer); assert.deepEqual(v.format, STANDARD); assert.equal(v.matchMode, 'normal');
    assert.equal(v.formatRule.ruleId, 'deck.format.standard'); assert(v.formatRule.sourceOfTruth.length);
    assert(Object.isFrozen(v.format));
  }
  const restored = OfficialGame.restore(JSON.parse(JSON.stringify(g.snapshot())), { catalog: f.catalog });
  assert.deepEqual(restored.view(0), g.view(0));
  const tie = game(f, STANDARD, 'tiebreak'); settle(tie);
  assert.equal(tie.view(0).matchMode, 'tiebreak'); assert.deepEqual(tie.view(0).format, STANDARD);
  assert(tie.snapshot().players.every((p) => p.prizes.length === 1));
  const oldProtocol = g.snapshot(); oldProtocol.protocol = 'CN-game-dev-12';
  assert.throws(() => OfficialGame.restore(oldProtocol, { catalog: f.catalog }), /schema mismatch/);
});

test('snapshot restore rechecks all original owned printings and deck limits, including discarded/lost cards', async () => {
  const f = await poolFixture((ds) => { ds.find((d) => d.definitionId === 'fire').mechanics.baseUnits = [['Fairy']]; });
  const legacy = game(f, 'casual60'); settle(legacy); const s = legacy.snapshot();
  const id = s.players[0].deck.find((id) => s.cards[id].definitionId === 'water');
  s.players[0].deck.splice(s.players[0].deck.indexOf(id), 1); s.players[0].lost.push(id);
  s.cards[id].printingId = 'printing:fire'; s.cards[id].definitionId = 'fire';
  s.format = STANDARD;
  assert.throws(() => OfficialGame.restore(s, { catalog: f.catalog }), rejected('outside-pool'));
  s.format = OPEN;
  OfficialGame.restore(s, { catalog: f.catalog });
  const limit = game(f).snapshot(), ids = limit.players[0].deck.filter((id) => limit.cards[id].definitionId === 'water').slice(0, 5);
  for (const id of ids) { limit.cards[id].printingId = 'printing:base'; limit.cards[id].definitionId = 'base'; }
  assert.throws(() => OfficialGame.restore(limit, { catalog: f.catalog }), /Too many copies/);
  const wrongVersion = game(f).snapshot(); wrongVersion.format.version = 'V20261018';
  assert.throws(() => OfficialGame.restore(wrongVersion, { catalog: f.catalog }), /incompatible/);
  const mismatch = game(f, 'tiebreak60', 'tiebreak').snapshot(); mismatch.matchMode = 'normal';
  assert.throws(() => OfficialGame.restore(mismatch, { catalog: f.catalog }), /match mode/);
});

test('release admission forwards format/match mode, while printing review edits invalidate independent approvals and release content pins', async () => {
  const f = await poolFixture(), printings = f.catalog.printings();
  const facts = await catalogCandidateFacts({ ruleset: RULESET, definitions: f.definitions, printings, handlers: f.handlers });
  const manifest = { schemaVersion: '1.0.0', releaseId: 'TEST-POOL-RELEASE', ...facts, review: {
    reviewId: 'fixture:review', reviewerId: 'fixture:not-production', reviewedOn: '2026-10-20',
    testIds: ['fixture:format-release'], sourceOfTruth: EVIDENCE,
  } };
  const data = { manifest, definitions: f.definitions, printings }, json = JSON.stringify(data);
  const trustedReleases = new Map([[manifest.releaseId, await sha256(canonicalJSON(manifest))]]);
  const opened = await createReviewedGame({
    json, trustedReleases, handlers: f.handlers, decks: [f.deck, f.deck], seed: f.seed, format: STANDARD, matchMode: 'tiebreak',
  });
  settle(opened.game); assert.equal(opened.game.view(0).matchMode, 'tiebreak');
  const restored = await restoreReviewedGame({ json, trustedReleases, handlers: f.handlers, snapshot: opened.game.snapshot() });
  assert.deepEqual(restored.game.view(0), opened.game.view(0));
  for (const format of [undefined, 'casual60', 'tiebreak60', 'standard']) {
    await assert.rejects(createReviewedGame({
      json, trustedReleases, handlers: f.handlers, decks: [f.deck, f.deck], seed: f.seed, format,
    }), /Unsupported format/);
  }
  for (const snapshot of [null, game(f, 'casual60').snapshot(), game(f, 'tiebreak60', 'tiebreak').snapshot()]) {
    await assert.rejects(restoreReviewedGame({ json, trustedReleases, handlers: f.handlers, snapshot }), /Unsupported format/);
  }
  const request = { json, trustedReleases, handlers: f.handlers, decks: [f.deck, f.deck].map((d) => [...d]), seed: [...f.seed], format: { ...STANDARD } };
  const pending = createReviewedGame(request);
  request.decks[0].pop(); request.seed.fill(0); request.format.id = 'open';
  const isolated = await pending;
  assert.deepEqual(isolated.game.view(0).format, STANDARD);
  const saved = isolated.game.snapshot(), pendingRestore = restoreReviewedGame({ json, trustedReleases, handlers: f.handlers, snapshot: saved });
  saved.format = 'casual60';
  assert.deepEqual((await pendingRestore).game.view(0).format, STANDARD);
  const changed = structuredClone(data); changed.printings[0].series = 'sun-moon';
  await assert.rejects(createReviewedGame({
    json: JSON.stringify(changed), trustedReleases, handlers: f.handlers, decks: [f.deck, f.deck], seed: f.seed, format: STANDARD,
  }), /fingerprint|content|pins/i);
  const p = structuredClone(printings[0]); p.releasedOn = '2026-10-19';
  await assert.rejects(createCardCatalog({
    ruleset: RULESET, definitions: f.definitions, printings: [p], handlers: f.handlers,
    approvedDefinitions: new Map(f.definitions.map((d) => [d.definitionId, canonicalDefinition(d)])),
    approvedPrintings: new Map(printings.map((p) => [p.printingId, canonicalPrinting(p)])),
  }), /independent approval/);
});
