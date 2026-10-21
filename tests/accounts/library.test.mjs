// The card library's entries and filters (public/library.js) and the deck builder's checks (public/deck-check.js),
// on the real reviewed release.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadCatalog, ROOT } from '../../server/catalog.mjs';
import { cardEntries, filterCards, emptyFilters } from '../../public/library.js';
import { checkDeck, printingLegality } from '../../public/deck-check.js';

const catalog = await loadCatalog();
const meta = JSON.parse(await readFile(join(ROOT, 'public/data/cn/V20261019/decks.json'), 'utf8'));
const cards = cardEntries(catalog, meta.cards);
const find = (f) => filterCards(cards, { ...emptyFilters(), ...f });
const names = (list) => new Set(list.map((c) => c.name));

test('every reviewed printing is one library entry with its card-face text and image', () => {
  assert.equal(cards.length, catalog.printings().length);
  const pikachu = cards.find((c) => c.id === 'zh-Hans:CSVH1C:008/059');
  assert.equal(pikachu.name, '皮卡丘ex');
  assert.deepEqual([pikachu.kind, pikachu.stage, pikachu.hp, pikachu.types], ['pokemon', 'basic', 190, ['Lightning']]);
  assert.ok(pikachu.features.includes('ex'));
  assert.ok(pikachu.attacks.some((a) => a.name === '强劲伏特' && a.text.length > 0));
  assert.match(pikachu.rule, /ex规则/);
  assert.equal(pikachu.image, 'img/cn-cards/CSVH1C/008-059.png');
  const flaaffy = cards.find((c) => c.id === 'zh-Hans:CSVH1C:012/059');
  assert.deepEqual([flaaffy.evolvesFrom, flaaffy.abilities[0].name], ['咩利羊', '电气发电机']);
  assert.deepEqual(flaaffy.legal, { standard: false, open: true });
  assert.ok(cards.every((c) => c.image && c.legal.open !== undefined));
});

test('filters: name, skill, kind, type, stage, category, features, HP, weakness, retreat, format, set and mark', () => {
  assert.ok(find({ name: '皮卡丘' }).every((c) => c.name.includes('皮卡丘')));
  assert.ok(names(find({ name: '皮卡丘' })).has('皮卡丘ex'));
  // A skill matches attack and Ability names and texts.
  assert.ok(names(find({ skill: '电气发电机' })).has('茸茸羊'));
  const counters = find({ skill: '伤害指示物' });
  assert.ok(counters.length > 0 && counters.every((c) => c.skills.some((s) => `${s.name}${s.text}`.includes('伤害指示物'))));
  assert.ok(find({ q: '强劲伏特' }).some((c) => c.name === '皮卡丘ex'));
  assert.ok(find({ kind: 'trainer', category: 'supporter' }).every((c) => c.kind === 'trainer' && c.category === 'supporter'));
  assert.ok(find({ types: ['Lightning'] }).every((c) => c.types.includes('Lightning')));
  assert.ok(find({ types: ['Lightning', 'Dragon'] }).some((c) => c.types.includes('Dragon')));
  assert.ok(find({ stage: 'stage2' }).every((c) => c.stage === 'stage2'));
  const ex = find({ features: ['ex', 'ability'] });
  assert.ok(ex.length > 0 && ex.every((c) => c.tags.includes('ex') && c.abilities.length));
  assert.equal(find({ features: ['acespec'] }).every((c) => c.aceSpec), true);
  const big = find({ hpMin: '200', sort: 'hp' });
  assert.ok(big.every((c) => c.hp >= 200));
  assert.ok(big.every((c, i) => !i || big[i - 1].hp >= c.hp));
  assert.ok(find({ hpMax: '60' }).every((c) => c.kind === 'pokemon' && c.hp <= 60));
  assert.ok(find({ weakness: 'Fighting' }).every((c) => c.weakness.type === 'Fighting'));
  assert.ok(find({ retreat: '0' }).every((c) => c.retreat === 0));
  assert.ok(find({ format: 'standard' }).every((c) => c.legal.standard));
  assert.equal(find({ format: 'open' }).length, cards.length);
  assert.ok(find({ set: 'CSV8C' }).every((c) => c.setCode === 'CSV8C'));
  assert.ok(find({ mark: '-' }).every((c) => c.mark === null));
  assert.deepEqual(find({ name: '不存在的卡' }), []);
  // The default order: Pokémon, then Trainers, then Energy.
  const kinds = find({}).map((c) => c.kind);
  assert.deepEqual([...new Set(kinds)], ['pokemon', 'trainer', 'energy']);
});

test('deck checks list every problem in words, and agree with the kernel on the preconstructed decks', () => {
  const legality = printingLegality(catalog);
  assert.equal([...legality.values()].filter((l) => l.open).length, catalog.printings().length);
  for (const d of meta.decks) assert.deepEqual(checkDeck(catalog, d.cards, d.format.id), { count: 60, issues: [], legal: true }, d.id);
  const bolt = meta.decks.find((d) => d.id === 'raging-bolt-679141').cards;
  const tooMany = bolt.map(([id, n], i) => [id, i === 0 ? 5 : n]);
  const r = checkDeck(catalog, tooMany, 'standard');
  assert.equal(r.legal, false);
  assert.deepEqual(r.issues, ['卡组需要正好 60 张卡，现在是 62 张。', '同名卡「猛雷鼓ex」最多放 4 张，现在有 5 张。']);
  const ace = cards.filter((c) => c.aceSpec).slice(0, 2).map((c) => [c.id, 1]);
  assert.ok(checkDeck(catalog, ace, 'open').issues.some((x) => /ACE SPEC 卡整副卡组最多放 1 张，现在有 2 张/.test(x)));
  assert.ok(checkDeck(catalog, [['zh-Hans:CSVE1C:LIG', 60]], 'open').issues.includes('卡组里至少要有 1 张基础宝可梦。'));
  assert.deepEqual(checkDeck(catalog, [], 'expanded').issues, ['未知的赛制。']);
});
