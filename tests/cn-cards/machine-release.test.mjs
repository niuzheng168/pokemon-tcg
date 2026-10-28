// The actual mixed-tier release, not just synthetic builder fixtures. Test decks below are mechanism fixtures,
// not claimed tournament/preconstructed lists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadCatalog, loadRelease } from '../../server/catalog.mjs';
import * as reviewed from '../../catalog/zh-CN/V20261019/index.mjs';
import { MACHINE_REPORT } from '../../catalog/zh-CN/V20261019/release-pool.mjs';
import { canonicalDefinition, canonicalPrinting } from '../../public/rules/card-schema.js';
import { openReviewedRelease } from '../../public/rules/catalog-release.js';
import { createReviewedGame, restoreReviewedGame } from '../../public/rules/reviewed-game.js';
import { TRUSTED_RELEASES } from '../../public/cn/trusted-releases.js';
import { validateFormatDeck } from '../../public/rules/formats.js';
import { createAI } from '../../public/cn/ai.js';
import { implementationTier, implementationSummary } from '../../public/card-quality.js';
import { cardDetailHTML, playBadge } from '../../public/library.js';
import { loadLibrary } from '../../server/library.mjs';
import { Match } from '../../public/match.js';
import { reviewedBindings } from '../../scripts/build-merged-metadata.mjs';
import exclusions from '../../catalog/zh-CN/V20261019/library/machine/exclusions.json' with { type: 'json' };

const catalog = await loadCatalog();
const release = await loadRelease();
const manifestJson = await readFile(new URL('../../public/data/cn/V20261019/manifest.json', import.meta.url), 'utf8');
const meta = JSON.parse(await readFile(new URL('../../public/data/cn/V20261019/decks.json', import.meta.url), 'utf8'));
const SAMPLE = 'zh-Hans:151C:013/151';
const BASIC_ENERGY = 'zh-Hans:CSVE1C:LIG';
const MANUAL = 'zh-Hans:CSVH1C:008/059';

test('every library printing is accounted for as implemented or an explicit unresolved exclusion, never silently dropped', async () => {
  // 13,706 unique cards, less the records the user decided repeat another record of the same card (sameCard, 2026-10-24).
  const sameCard = JSON.parse(await readFile(new URL('../../catalog/zh-CN/V20261019/library/review/user-decisions.json', import.meta.url), 'utf8')).sameCard;
  assert.equal(sameCard.length, 5);
  assert.equal(MACHINE_REPORT.cards, 13706 - sameCard.length, 'The original full-pool target must not shrink to the implemented subset.');
  assert.equal(new Set(exclusions.map((e) => e.printingId)).size, exclusions.length);
  assert.equal(exclusions.length + catalog.printings().length, MACHINE_REPORT.cards);
  const counts = {};
  for (const e of exclusions) {
    assert.equal(catalog.hasPrinting(e.printingId), false, e.printingId);
    assert.ok(e.dir && e.name && e.reason);
    counts[e.reason] = (counts[e.reason] ?? 0) + 1;
  }
  assert.deepEqual(counts, MACHINE_REPORT.skipped);
  assert.deepEqual(exclusions.map((e) => e.printingId), exclusions.map((e) => e.printingId).sort());
});

test('the committed machine snapshot is pinned with the reviewed pool, within the v2 per-file byte budgets', () => {
  const manifest = JSON.parse(manifestJson);
  assert.ok(Buffer.byteLength(manifestJson) <= 1024 * 1024);
  assert.ok(manifest.index.bytes <= 8 * 1024 * 1024);
  assert.ok(manifest.shards.every((s) => s.bytes <= 4 * 1024 * 1024));
  assert.equal(catalog.printings().length, reviewed.PRINTINGS.length + MACHINE_REPORT.printings);
  assert.equal(catalog.definitions().length, reviewed.DEFINITIONS.length + MACHINE_REPORT.definitions);
  assert.equal(catalog.printings().filter((p) => p.identityReview === 'machine').length, MACHINE_REPORT.printings);
  assert.equal(catalog.definitions().filter((d) => d.implementation.tier === 'machine').length, MACHINE_REPORT.definitions);
  for (const d of reviewed.DEFINITIONS) assert.equal(canonicalDefinition(catalog.definition(d.definitionId)), canonicalDefinition(d));
  for (const p of reviewed.PRINTINGS) assert.equal(canonicalPrinting(catalog.printing(p.printingId)), canonicalPrinting(p));
  assert.equal(catalog.definitionFor(SAMPLE).name, '独角虫');
  assert.equal(implementationTier(catalog, SAMPLE), 'machine');
  for (const id of ['zh-Hans:30th-P:010/30th-P', 'zh-Hans:SV-P:033/SV-P', 'zh-Hans:CSM1bC:091/324'])
    assert.equal(catalog.hasPrinting(id), false, `${id}: incomplete source Weakness/Resistance must not inherit a reprint`);
});

test('「…的特性（除「X」外），全部消除」 names an Ability printed in the release, as the card prints it', () => {
  // A misread name spares nothing: 振翼发 CSV7C 109/204 once carried the 52Poké text's 「暗夜羽击」 (its Ability is 「暗夜振翼」).
  const printed = new Set(catalog.definitions().flatMap((d) => (d.mechanics.abilities ?? []).map((a) => a.name)));
  const named = [];
  const walk = (v, d) => Array.isArray(v) ? v.forEach((x) => walk(x, d)) : v && typeof v === 'object' &&
    (Array.isArray(v.exceptAbilityNames) && named.push([d.definitionId, ...v.exceptAbilityNames]), Object.values(v).forEach((x) => walk(x, d)));
  for (const d of catalog.definitions()) walk(d.mechanics, d);
  assert.ok(named.length >= 6);
  assert.deepEqual(named.filter(([, ...names]) => names.some((n) => !printed.has(n))), []);
  for (const id of ['zh-Hans:CSV7C:109/204', 'zh-Hans:CSV9.5C:079/208'])
    assert.equal(meta.cards[id].texts.b1, '只要这只宝可梦在战斗场上，对手战斗宝可梦的特性（除「暗夜振翼」外），全部消除。');
});

test('a Tool that grants an attack prints it in every printing\'s card text: cost, name and damage, then what it does', () => {
  // Nine 招式学习器 printings once showed only the rule sentence: the card review accepted their attack as attack.* fields
  // apart from card_text, and the machine builder left those out of texts.card (the definition and its unit had them).
  const G = { Grass: '草', Fire: '火', Water: '水', Lightning: '雷', Psychic: '超', Fighting: '斗', Darkness: '恶', Metal: '钢', Fairy: '妖',
    Dragon: '龙', Colorless: '无' };
  const flat = (s) => String(s ?? '').replace(/\s/g, '');
  const granting = catalog.printings().filter((p) => catalog.definitionFor(p.printingId).mechanics.grantedAttacks?.length);
  assert.ok(granting.length >= 29);
  for (const p of granting) for (const a of catalog.definitionFor(p.printingId).mechanics.grantedAttacks) {
    const d = a.printedDamage, damage = d == null ? '' : `${d.value}${{ plus: '+', minus: '-', times: '×' }[d.operator] ?? ''}`;
    assert.ok(flat(meta.cards[p.printingId].texts.card).includes(flat(`${a.cost.map((c) => `【${G[c]}】`).join('')}${a.name}${damage}`)),
      `${p.printingId}: ${a.name}`);
  }
  const printed = {
    能量涡轮: '【无】 能量涡轮\n选择自己牌库中最多2张基本能量，以任意方式附着于备战宝可梦身上。并重洗牌库。',
    暗中奇袭: '【无】【无】【无】 暗中奇袭\n给身上放置有伤害指示物的1只对手的宝可梦，造成100伤害。［备战宝可梦不计算弱点、抗性。]',
    进化: '【无】 进化\n选择自己最多2只备战宝可梦，从自己牌库中选择从该宝可梦进化而来的卡牌各1张，各放于其身上进行进化。并重洗牌库。',
    退化: '【无】 退化\n从对手所有已经进化的宝可梦身上，各移除1张「进化卡」使其退化。将被移除的卡牌，放回对手的手牌。',
    萤石: '【草】【水】【超】 萤石\n将这只宝可梦身上附着的所有能量放于弃牌区，将自己所有「太晶」宝可梦的HP，全部回复。',
  };
  for (const [id, attack] of [['CSV4C:119/129', '能量涡轮'], ['CSVH4aC:016/023', '能量涡轮'], ['CSV4C:120/129', '暗中奇袭'],
    ['CSVH4aC:017/023', '暗中奇袭'], ['CSV5C:119/129', '进化'], ['CSVM1bC:025/033', '进化'], ['CSV5C:120/129', '退化'],
    ['CSVM1aC:024/033', '退化'], ['CSV9C:195/208', '萤石'], ['CSV9.5C:180', '进化'], ['CSV9.5C:181', '退化']]) {
    const text = meta.cards[`zh-Hans:${id}`].texts.card;
    assert.match(text, /^身上放有这张卡牌的宝可梦，可以使用这张卡牌上的招式。/, id);
    assert.ok(text.endsWith(`。\n\n${printed[attack]}`), id);
  }
});

test('machine printings of reviewed definitions stay machine quality; match summaries do not trust presentation claims', () => {
  const reprint = catalog.printings().find((p) => p.identityReview === 'machine'
    && catalog.definitionFor(p.printingId).implementation.tier !== 'machine');
  assert.ok(reprint);
  assert.equal(implementationTier(catalog, reprint.printingId), 'machine');
  assert.equal(implementationTier(catalog, MANUAL), 'reviewed');
  assert.equal(implementationTier(catalog, 'missing'), null);
  assert.deepEqual(implementationSummary(catalog, [SAMPLE, SAMPLE, MANUAL, 'missing']), {
    tiers: ['reviewed', 'machine', 'unimplemented'], machinePrintings: [SAMPLE], unimplementedPrintings: ['missing'],
  });
  assert.deepEqual(implementationSummary(catalog, []), { tiers: [], machinePrintings: [], unimplementedPrintings: [] });
});

test('merged metadata remains bound to the hand-reviewed records only, even when the release includes machine printings', async () => {
  const bindings = await reviewedBindings();
  assert.deepEqual([...bindings.keys()].sort(), reviewed.PRINTINGS.map((p) => p.printingId).sort());
  assert.equal(bindings.has(SAMPLE), false);
});

test('machine cards and reprints are shown distinctly in library details and on the table', async () => {
  const library = await loadLibrary({ catalog, presentation: meta.cards });
  const sample = library.pool.byId.get(SAMPLE);
  assert.equal(sample.implemented, true);
  assert.equal(sample.implementation, 'machine');
  assert.equal(sample.review, 'machine-image-checked');
  assert.match(playBadge(sample), /机器实现/);
  assert.match(cardDetailHTML(sample), /未经人工逐张审核/);
  assert.match(playBadge(library.pool.byId.get(MANUAL)), /人工审核/);
  assert.equal(library.pool.cards.filter((c) => c.implementation === 'machine').length, MACHINE_REPORT.printings);
});

test('altering a machine printing quality/binding cannot survive the installed release pins', async () => {
  const changed = await openReviewedRelease({ manifestJson, trustedReleases: TRUSTED_RELEASES, readShard: async (d) => {
    const bytes = await readFile(new URL('../../public/data/cn/V20261019/' + d.file, import.meta.url));
    if (!d.shardId) return bytes;
    const wire = JSON.parse(bytes.toString('utf8'));
    wire.printings.find((p) => p.printingId === SAMPLE).identityReview = 'verified';
    return Buffer.from(JSON.stringify(wire));
  } });
  await assert.rejects(changed.catalogFor([SAMPLE]), /pinned|SHA-256/i);
});

test('a real released machine card deck plays against the CPU, restores, and projects its quality without exposing hidden cards', async () => {
  // A deliberately simple fixture deck: reviewed basic Lightning Energy plus three machine Basic Pokémon whose
  // attacks accept Lightning/Colorless. This is not a published or invented tournament decklist.
  const basics = catalog.printings().filter((p) => {
    const d = catalog.definitionFor(p.printingId), m = d.mechanics;
    return d.implementation.tier === 'machine' && d.kind === 'pokemon' && m.stage === 'basic' && !m.ruleBox
      && m.attacks.some((a) => a.printedDamage?.value > 0 && a.cost.length <= 2 && a.cost.every((t) => ['Lightning', 'Colorless'].includes(t)));
  }).filter((p, i, ps) => ps.findIndex((q) => catalog.definitionFor(q.printingId).nameKey === catalog.definitionFor(p.printingId).nameKey) === i).slice(0, 3);
  assert.equal(basics.length, 3);
  const deck = [...basics.flatMap((p) => Array(4).fill(p.printingId)), ...Array(48).fill(BASIC_ENERGY)];
  validateFormatDeck(catalog, deck, reviewed.OPEN_FORMAT);
  const { game, catalog: admitted } = await createReviewedGame({ release,
    decks: [deck, deck], seed: [3, 1, 4, 1], format: reviewed.OPEN_FORMAT, matchMode: 'normal' });
  const ai = createAI(admitted);
  for (let steps = 0; !game.snapshot().result; steps++) {
    assert.ok(steps < 3000, 'the released machine-card CPU game terminates');
    const s = game.snapshot(), player = s.pending ? s.pending.player : s.current, view = game.view(player);
    assert.equal(Array.isArray(view.players[1 - player].hand), false);
    game.dispatch({ player, expectedRevision: view.revision, action: ai(view, player) });
    if (steps === 20) {
      const restored = await restoreReviewedGame({ release, snapshot: game.snapshot() });
      assert.deepEqual(restored.game.view(player), game.view(player));
      const match = new Match({ game: restored.game, catalog: restored.catalog, presentation: meta.cards, controllers: [] });
      const cards = [...match.cards.values()];
      assert.ok(cards.some((c) => c.implementation === 'machine' && c.img && c.setCode && c.number));
    }
  }
  assert.ok(game.snapshot().result);
});
