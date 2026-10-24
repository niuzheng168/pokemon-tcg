// The machine tier's builders (catalog/zh-CN/V20261019/machine.mjs): rule boxes and Prize cards, printed Weakness /
// Resistance, library evidence, definitions and printings the kernel executes as machine tier, the fingerprint that
// lets printings share a definition, and a whole CPU game with machine-tier vanilla Pokémon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RULESET, OPEN_FORMAT, DEFINITIONS, PRINTINGS } from '../../catalog/zh-CN/V20261019/index.mjs';
import { ruleBoxOf, ruleBoxMechanics } from '../../catalog/zh-CN/V20261019/common.mjs';
import { glyph, costGlyphs, libraryEvidence, weakness, resistance, machinePokemon, machineBasicEnergy, machineSpecialEnergy, machinePrinting,
  fingerprint, machineTrainer, trainerText, resolveMachineValue } from '../../catalog/zh-CN/V20261019/machine.mjs';
import { check as checkEffect } from '../../scripts/effect-validate.mjs';
import { createCardCatalog } from '../../public/rules/catalog.js';
import { canonicalDefinition, canonicalPrinting, isMachineDefinition, assertExecutableDefinition } from '../../public/rules/card-schema.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { OfficialGame, assertSupportedDefinition } from '../../public/rules/game.js';
import { validateFormatDeck } from '../../public/rules/formats.js';
import { createAI } from '../../public/cn/ai.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';

const handlers = createCoreHandlers();
const ev = (dir, mik = dir.replace(/_.*/, '')) => libraryEvidence({ dir, mik });
const mon = (id, face, dir) => machinePokemon(id, { stage: 'basic', type: '雷', weakness: { type: '斗', value: '×2' }, resistance: null,
  retreat: 1, ruleBox: null, tags: [], attacks: [{ name: '撞击', cost: '无', damage: 20 }], ...face }, ev(dir));
const catalogOf = (definitions, printings) => createCardCatalog({ ruleset: RULESET, definitions, printings, handlers,
  approvedDefinitions: new Map(definitions.map((d) => [d.definitionId, canonicalDefinition(d)])),
  approvedPrintings: new Map(printings.map((p) => [p.printingId, canonicalPrinting(p)])) });
const printingOf = (def, setCode, number, dir) => machinePrinting({ printingId: `zh-Hans:${setCode}:${number}`, setCode, number,
  mark: 'G', series: 'scarlet-violet', releasedOn: '2025-01-17', dir, imageSha256: 'a'.repeat(64) }, def.definitionId, ev(dir));

test('rule boxes by printed suffix: Prize cards, rule box and the tags card text selects by', () => {
  assert.deepEqual(['皮卡丘ex', '超梦EX', '叶伊布V', '叶伊布VMAX', '阿尔宙斯VSTAR', '路卡利欧GX', '皮卡丘&捷克罗姆GX', '光辉喷火龙', '皮卡丘']
    .map(ruleBoxOf), ['ex', 'EX', 'V', 'VMAX', 'VSTAR', 'GX', 'TAG TEAM', 'Radiant', null]);
  assert.deepEqual(ruleBoxMechanics('VMAX', ['Rapid Strike']), { ruleBox: true, prizeCount: 3, tags: ['V', 'VMAX', 'Rapid Strike'] });
  assert.deepEqual(ruleBoxMechanics('TAG TEAM'), { ruleBox: true, prizeCount: 3, tags: ['GX', 'TAG TEAM'] });
  assert.deepEqual(ruleBoxMechanics('Radiant'), { ruleBox: true, prizeCount: 1, tags: ['Radiant'] });
  assert.deepEqual(ruleBoxMechanics(null, ['Ancient']), { ruleBox: false, prizeCount: 1, tags: ['Ancient'] });
  assert.throws(() => ruleBoxMechanics('Prism Star'), /Unknown rule box/);
});

test('printed Weakness, Resistance and type spellings of the library and the readers', () => {
  assert.equal(glyph('L'), '雷'); assert.equal(glyph('【超】'), '超'); assert.equal(glyph('电'), '雷'); assert.equal(glyph('火'), '火');
  assert.equal(costGlyphs('LCC'), '雷无无'); assert.equal(costGlyphs(['草', '+', 'C']), '草无'); assert.equal(costGlyphs('0'), '');
  assert.deepEqual(weakness({ energy: 'F', value: '×2' }), { type: 'Fighting', operation: 'multiply', value: 2 });
  assert.deepEqual(weakness({ type: '火', value: '+20' }), { type: 'Fire', operation: 'add', value: 20 });
  assert.deepEqual(resistance({ type: '斗', value: '-30' }), { type: 'Fighting', value: 30 });
  assert.equal(weakness(null), null); assert.equal(resistance({ type: null }), null);
  assert.throws(() => weakness({ type: '火', value: '?' }), /Unreadable Weakness/);
  assert.throws(() => resistance({ type: '火', value: '30' }), /Unreadable Resistance/);
});

test('a printed second type; a Trainer or Special Energy key names only itself; a name list without a card in the pool', () => {
  const steel = mon('cn:test:steel', { name: '测试', type: '雷', types: ['雷', '钢'] }, 'TEST/001');
  assert.deepEqual(steel.mechanics.types, ['Lightning', 'Metal']);
  assert.deepEqual(mon('cn:test:plain', { name: '测试', type: '雷' }, 'TEST/001').mechanics.types, ['Lightning']);
  assert.throws(() => mon('cn:test:other', { name: '测试', type: '雷', types: ['超', '钢'] }, 'TEST/001'), /Two-type rule/);
  const evidence = ev('TEST/001'), keys = { 测试甲: 'ce-shi-jia', 测试乙: 'ce-shi-yi' }, nameKey = (n) => keys[n] ?? null;
  assert.equal(resolveMachineValue('DEF:attach', 'cn:test:energy', null, evidence), 'cn:test:energy:attach');
  assert.throws(() => resolveMachineValue('DEF:attach', 'cn:test:pokemon', 'a1', evidence), /Unresolved cross-unit reference/);
  assert.deepEqual(resolveMachineValue({ nameKeys: ['NAME:测试甲', 'NAME:测试丙'] }, 'cn:test:x', 'b1', evidence, nameKey), { nameKeys: ['ce-shi-jia'] });
  assert.deepEqual(resolveMachineValue(['NAME:测试甲', 'NAME:测试乙'], 'cn:test:x', 'b1', evidence, nameKey), ['ce-shi-jia', 'ce-shi-yi']);
  assert.throws(() => resolveMachineValue(['NAME:测试丙', 'NAME:测试丁'], 'cn:test:x', 'b1', evidence, nameKey), /Unresolved effect name: 测试丙/);
  assert.throws(() => resolveMachineValue(['NAME:测试丙'], 'cn:test:x', 'b1', evidence, nameKey), /Unresolved effect name: 测试丙/);
});

test('「…将这张「X」从弃牌区…加入手牌」: the discard-pile recall costs carry the card\'s evidence and pass every gate', () => {
  const others = { anyOf: [{ kind: 'pokemon' }, { kind: 'trainer', excludeNameKeys: ['NAME:测试支援'] }, { kind: 'energy' }] };
  const translation = { status: 'ok', effects: [['draw', 'cn.draw@1', { count: 2 }]],
    discardRecall: { costs: [{ costId: 'DEF:recall', kind: 'discardHand', count: 2, selector: others }] } };
  const d = machineTrainer('cn:machine:trainer:test-recall:1', { name: '测试支援', nameKey: 'test-recall', category: 'supporter', translation,
    resolveNameKey: (n) => (n === '测试支援' ? 'test-recall' : null) }, ev('CSM2aC/060_070'));
  assert.deepEqual(d.mechanics.discardRecall.costs, [{ costId: 'cn:machine:trainer:test-recall:1:recall', kind: 'discardHand', count: 2,
    selector: { anyOf: [{ kind: 'pokemon' }, { kind: 'trainer', excludeNameKeys: ['test-recall'] }, { kind: 'energy' }] }, sourceOfTruth: d.sourceOfTruth }]);
  assertExecutableDefinition(d, { ruleset: RULESET, approvedDefinitions: new Map([[d.definitionId, canonicalDefinition(d)]]), handlers });
  assert.equal(checkEffect({ kind: 'trainer', text: '测试。', card: { name: '测试支援', kind: 'trainer', category: 'supporter' } }, translation).valid, true);
});

test('「可以使用1张或者2张同时使用」「必须同时使用2张」: an entry\'s playCount reaches the definition only as printed on an Item', () => {
  const text = '「测试捕捉器」，可以使用1张或者2张同时使用，根据使用的张数不同效果也不同。◆如果使用1张，则从牌库上方抽取卡牌，直到自己的手牌变为3张为止。' +
    '◆如果同时使用2张卡牌，则选择对手的1只备战宝可梦，将其与战斗宝可梦互换。（这个效果，2张卡牌只发动1次。）';
  const gust = ['catch', 'cn.switch@1', { side: 'opponent', chooser: 'self', affected: 'selected' }, { playCount: 2 }];
  const translation = { status: 'ok', effects: [['draw', 'cn.drawUntil@1', { count: 3 }], gust] };
  const d = machineTrainer('cn:machine:trainer:test-catcher:1', { name: '测试捕捉器', nameKey: 'test-catcher', category: 'item', text, translation },
    ev('CSM1bC/120'));
  assert.deepEqual(d.mechanics.effects.map((b) => [b.effectId, b.playCount]),
    [['cn:machine:trainer:test-catcher:1:draw', undefined], ['cn:machine:trainer:test-catcher:1:catch', 2]]);
  assertExecutableDefinition(d, { ruleset: RULESET, approvedDefinitions: new Map([[d.definitionId, canonicalDefinition(d)]]), handlers });
  const unit = { kind: 'trainer', text, card: { name: '测试捕捉器', kind: 'trainer', category: 'item' } };
  assert.equal(checkEffect(unit, translation).valid, true);
  assert.equal(checkEffect(unit, { ...translation, effects: [gust] }).valid, false, 'It can be played alone.');
  assert.equal(checkEffect({ ...unit, text: text.replaceAll('2张', '4张') }, translation).valid, false, 'Two cards together, as printed.');
  assert.equal(checkEffect({ ...unit, card: { ...unit.card, category: 'supporter' } }, translation).valid, false);
  const only = { ...unit, text: '「测试切换机」必须同时使用2张。（这个效果，2张卡牌只发动1次。）选择对手的1只备战宝可梦，将其与战斗宝可梦互换。' };
  assert.equal(checkEffect(only, { status: 'ok', effects: [gust] }).valid, true);
  assert.equal(checkEffect(only, translation).valid, false, 'Never one card alone.');
});

test('「（当将这张卡牌从手牌使出放于宝可梦身上时，如果会导致该宝可梦【昏厥】的话，则无法放于该宝可梦身上。）」: a Tool\'s hand-attach exception', () => {
  const vmax = { kind: 'pokemon', nameKeys: ['NAME:测试VMAX'] }, resolveNameKey = (n) => (n === '测试VMAX' ? 'test-vmax' : null);
  const translation = { status: 'ok', effects: [['hp', 'cn.modifier@1', { field: 'hp', amount: -100, scope: 'self', targetSelector: vmax }]],
    handAttachExcept: { selector: vmax, state: { remainingHpAtMost: 100 } } };
  const build = (category) => machineTrainer('cn:machine:trainer:test-medal:1', { name: '测试奖牌', nameKey: 'test-medal', category, translation,
    resolveNameKey }, ev('CS2bC/106_115'));
  const d = build('tool');
  assert.deepEqual(d.mechanics.handAttachExcept, { selector: { kind: 'pokemon', nameKeys: ['test-vmax'] }, state: { remainingHpAtMost: 100 } });
  assertExecutableDefinition(d, { ruleset: RULESET, approvedDefinitions: new Map([[d.definitionId, canonicalDefinition(d)]]), handlers });
  const unit = (category) => ({ kind: 'trainer', text: '测试。', card: { name: '测试奖牌', kind: 'trainer', category } });
  assert.equal(checkEffect(unit('tool'), translation).valid, true);
  assert.equal(checkEffect(unit('item'), translation).valid, false, 'A Tool only.');
});

test('「这张卡牌，可以作为HP为60的【无】属性的【基础】宝可梦，放于场上」: an Item card built as the Basic Pokémon it is played as', () => {
  const text = '这张卡牌，可以作为HP为60的【无】属性的【基础】宝可梦，放于场上。这张卡牌，不会陷入特殊状态，也无法撤退。如果在自己的回合的话，则可将处于场上的这张卡牌放于弃牌区。';
  const translation = { status: 'ok', playAsPokemon: { hp: 60, type: 'Colorless', leave: { from: 'field', to: 'discard' } },
    effects: [['immune', 'cn.conditionImmunity@1', { effect: { op: 'conditionImmunity', scope: 'self' } }],
      ['stay', 'cn.restriction@1', { effect: { op: 'restriction', scope: 'self', actions: ['retreat'] } }]] };
  const face = { name: '测试化石', nameKey: 'test-fossil', category: 'item', text, translation };
  const d = machineTrainer('cn:machine:trainer:test-fossil:1', face, ev('151C/154_165'));
  assert.equal(d.kind, 'pokemon');
  assert.deepEqual([d.mechanics.stage, d.mechanics.hp, d.mechanics.types, d.mechanics.weakness, d.mechanics.retreatCost, d.mechanics.prizeCount],
    ['basic', 60, ['Colorless'], null, 0, 1]);
  assert.deepEqual(d.mechanics.itemCard, { leave: { from: 'field', to: 'discard' }, sourceOfTruth: d.sourceOfTruth });
  assert.deepEqual(d.mechanics.effects.map((b) => b.effectId), ['cn:machine:trainer:test-fossil:1:rule:immune', 'cn:machine:trainer:test-fossil:1:rule:stay']);
  assertExecutableDefinition(d, { ruleset: RULESET, approvedDefinitions: new Map([[d.definitionId, canonicalDefinition(d)]]), handlers });
  const doll = machineTrainer('cn:machine:trainer:test-doll:1', { ...face, text: text.replace('60', '30'), translation: { ...translation,
    playAsPokemon: { hp: 30, type: 'Colorless', leave: { from: 'active', to: 'deckBottom' }, noPrizes: true } } }, ev('CSM2cC/131_150'));
  assert.equal(doll.mechanics.prizeCount, 0);
  assert.throws(() => machineTrainer('x', { ...face, category: 'supporter' }, ev('151C/154_165')), /prints its HP/);
  assert.throws(() => machineTrainer('x', { ...face, text: text.replace('60', '70') }, ev('151C/154_165')), /prints its HP/);
  const unit = { kind: 'trainer', text, card: { name: '测试化石', kind: 'trainer', category: 'item' } };
  assert.equal(checkEffect(unit, translation).valid, true);
  assert.equal(checkEffect({ ...unit, card: { ...unit.card, category: 'supporter' } }, translation).valid, false);
});

test('library evidence cites the MIK card page, else the 52Poké page, else the official product page', () => {
  assert.equal(libraryEvidence({ dir: 'CSV1C/107_127', mik: 'CSV1C/107' })[0].url, 'https://tcg.mik.moe/cards/CSV1C/107');
  assert.equal(libraryEvidence({ dir: 'SV-P/001', wikiId: '21712' })[0].url, 'https://wiki.52poke.com/index.php?curid=21712');
  const official = libraryEvidence({ dir: 'SV-P/355_SV-P', official: 'https://www.pokemon.cn/tcg/product/22850.html' })[0];
  assert.equal(official.kind, 'official-card');
  assert.throws(() => libraryEvidence({ dir: 'X/1' }), /no MIK, 52Poké or official page/);
});

test('machine definitions execute as the machine tier; VMAX gives 3 Prize cards; a Radiant Pokémon is one per deck', () => {
  const vmax = mon('cn:machine:pokemon:test-vmax:1', { name: '测试VMAX', nameKey: 'test-vmax', stage: 'VMAX', evolvesFrom: 'test-v', hp: 320,
    ruleBox: 'VMAX', attacks: [{ name: '极巨冲击', cost: '雷无无', damage: 200 }] }, 'CSV1C/001_127');
  assert.equal(isMachineDefinition(vmax), true);
  assert.deepEqual([vmax.mechanics.prizeCount, vmax.mechanics.ruleBox, vmax.mechanics.tags], [3, true, ['V', 'VMAX']]);
  assertExecutableDefinition(vmax, { ruleset: RULESET, approvedDefinitions: new Map([[vmax.definitionId, canonicalDefinition(vmax)]]), handlers });
  const radiant = mon('cn:machine:pokemon:test-radiant:1', { name: '光辉测试', nameKey: 'test-radiant', ruleBox: 'Radiant' }, 'CSV1C/002_127');
  assert.deepEqual(radiant.deckLimits.groups.map((g) => [g.key, g.maximum]), [['cn-radiant', 1]]);
  const energy = machineBasicEnergy('cn:machine:energy:test-fairy:1', { name: '基本妖能量', nameKey: 'test-fairy', type: '妖' }, ev('CSV1C/FAI'));
  assert.deepEqual([energy.deckLimits.sameName, energy.mechanics.baseUnits], [null, [['Fairy']]]);
});

test('a Prism Star card: one of the same name per deck, a Pokémon one has a rule box, and it goes to the Lost Zone', async () => {
  const prism = mon('cn:machine:pokemon:test-prism:1', { name: '测试◇', nameKey: 'test-prism', hp: 160, prismStar: true }, 'CSM1.5C/019');
  assert.deepEqual([prism.deckLimits.sameName, prism.mechanics.ruleBox, prism.mechanics.prizeCount], [1, true, 1]);
  assert.deepEqual(prism.prismStar.sourceOfTruth, prism.sourceOfTruth);
  assertExecutableDefinition(prism, { ruleset: RULESET, approvedDefinitions: new Map([[prism.definitionId, canonicalDefinition(prism)]]), handlers });
  assert.notEqual(fingerprint(prism), fingerprint(mon('cn:machine:pokemon:test-prism:2', { name: '测试', nameKey: 'test-prism', hp: 160 }, 'CSM1.5C/019')));
  const energy = machineSpecialEnergy('cn:machine:energy:test-prism-energy:1', { name: '测试能量◇', nameKey: 'test-prism-energy', prismStar: true,
    translation: { status: 'ok', baseUnits: [['Colorless']], effects: [] } }, ev('CSM1aC/150_151'));
  assert.equal(energy.deckLimits.sameName, 1);
  assertExecutableDefinition(energy, { ruleset: RULESET, approvedDefinitions: new Map([[energy.definitionId, canonicalDefinition(energy)]]), handlers });
  const catalog = await catalogOf([prism], [printingOf(prism, 'CSM1.5C', '019', 'CSM1.5C/019')]);
  assert.equal(catalog.definitionFor('zh-Hans:CSM1.5C:019').prismStar.sourceOfTruth[0].kind, 'card-library');
});

test('a printed failure check, an Ability cost and a binding trigger carry the card\'s own evidence and pass every gate', () => {
  const failure = { coin: { mode: 'fixed', count: 1, minimumHeads: 1 } };
  const costs = [{ costId: 'DEF:b:discard', kind: 'discardHand', count: 1, selector: { kind: 'any' } }];
  const ability = { status: 'ok', mode: 'activated', usage: { period: 'turn', scope: 'pokemon', key: 'cn:ability:test-draw', limit: 1 },
    costs, effects: [['draw', 'cn.draw@1', { count: 2 }]] };
  const d = mon('cn:machine:pokemon:test-cost:1', { name: '测试', nameKey: 'test-cost', hp: 70,
    attacks: [{ name: '偷袭', cost: '无', damage: 30, translation: { status: 'ok', effects: [], failureCheck: failure } }],
    abilities: [{ name: '测试抽牌', translation: ability }] }, 'CSV1C/004_127');
  const evidence = d.sourceOfTruth;
  assert.deepEqual(d.mechanics.attacks[0].failureCheck, { ...failure, sourceOfTruth: evidence });
  assert.deepEqual(d.mechanics.abilities[0].costs, [{ ...costs[0], costId: 'cn:machine:pokemon:test-cost:1:b1:discard', sourceOfTruth: evidence }]);
  assertExecutableDefinition(d, { ruleset: RULESET, approvedDefinitions: new Map([[d.definitionId, canonicalDefinition(d)]]), handlers });
  assertSupportedDefinition({ handler: (id) => handlers.get(id) }, d);
  const plain = mon('cn:machine:pokemon:test-cost:2', { name: '测试', nameKey: 'test-cost', hp: 70,
    attacks: [{ name: '偷袭', cost: '无', damage: 30, translation: { status: 'ok', effects: [] } }],
    abilities: [{ name: '测试抽牌', translation: { ...ability, costs: undefined } }] }, 'CSV1C/005_127');
  assert.notEqual(fingerprint(d), fingerprint(plain), 'a failure check or a cost is part of how the card plays');
  // The same results pass the translation check, which also applies the game-load guard.
  const unit = (kind, extra) => ({ kind, text: '测试。', card: { name: '测试', kind: 'pokemon', stage: 'basic', hp: 70 }, ...extra });
  assert.equal(checkEffect(unit('attack', { attack: { name: '偷袭', cost: '无', damage: '30' } }), { status: 'ok', effects: [], failureCheck: failure }).valid, true);
  assert.equal(checkEffect(unit('ability', { ability: { name: '测试抽牌' } }), ability).valid, true);
  // A cost on an Ability whose effect has no reviewed post-cost eligibility proof passes the schema but not the game.
  const conditionCost = { ...ability, effects: [['sleep', 'cn.condition@1', { side: 'opponent', condition: 'asleep' }]] };
  assert.match(checkEffect(unit('ability', { ability: { name: '测试抽牌' } }), conditionCost).error, /post-cost eligibility/);
  // A Special Energy binding keeps its own trigger.
  const trigger = { event: 'energyAttached', subject: 'self', origin: 'hand', cardIsSource: true, optional: false, choiceOwner: 'source', scope: 'global' };
  const energy = machineSpecialEnergy('cn:machine:energy:test-special:1', { name: '测试能量', nameKey: 'test-special',
    translation: { baseUnits: [['Colorless']], effects: [['heal', 'cn.counters@1', { side: 'own', target: 'event', count: 2 }, { trigger }]] } },
  ev('CSV1C/006_127'));
  assert.deepEqual(energy.mechanics.effects[0].trigger, trigger);
  assertExecutableDefinition(energy, { ruleset: RULESET, approvedDefinitions: new Map([[energy.definitionId, canonicalDefinition(energy)]]), handlers });
  assertSupportedDefinition({ handler: (id) => handlers.get(id) }, energy);
});

test('「[对战中，己方的GX招式只能使用1次。]」 and a VSTAR Power: carried from the translation, only with their printed rule box', () => {
  const gx = mon('cn:machine:pokemon:test-gx:1', { name: '测试GX', nameKey: 'test-gx', hp: 190, ruleBox: 'GX', attacks: [
    { name: '撞击', cost: '无', damage: 20 }, { name: '测试GX', cost: '雷', damage: null, translation: { status: 'ok', specialRule: 'GX',
      effects: [['draw', 'cn.draw@1', { count: 3 }]] } }] }, 'CSV1C/007_127');
  assert.deepEqual(gx.mechanics.attacks.map((a) => a.specialRule ?? null), [null, 'GX']);
  assert(requireRule(CN_V20261019, 'attack.special-rule').sourceOfTruth.some((s) => s.section === '混乱'));
  assertExecutableDefinition(gx, { ruleset: RULESET, approvedDefinitions: new Map([[gx.definitionId, canonicalDefinition(gx)]]), handlers });
  const power = { status: 'ok', mode: 'activated', usage: { period: 'turn', scope: 'pokemon', key: 'cn:ability:test-star', limit: 1 },
    specialRule: 'VSTAR', effects: [['draw', 'cn.draw@1', { count: 2 }]] };
  const star = mon('cn:machine:pokemon:test-star:1', { name: '测试VSTAR', nameKey: 'test-star', stage: 'VSTAR', evolvesFrom: 'test-v', hp: 270,
    ruleBox: 'VSTAR', abilities: [{ name: '测试星耀', translation: power }] }, 'CSV1C/008_127');
  assert.equal(star.mechanics.abilities[0].specialRule, 'VSTAR');
  assertSupportedDefinition({ handler: (id) => handlers.get(id) }, star);
  const gxAttack = { name: '测试GX', cost: '雷', damage: 50, translation: { status: 'ok', specialRule: 'GX', effects: [] } };
  for (const face of [{ ruleBox: 'V', attacks: [gxAttack] }, { ruleBox: 'GX', abilities: [{ name: '测试星耀', translation: power }] },
    { ruleBox: 'VSTAR', attacks: [{ ...gxAttack, translation: { ...gxAttack.translation, specialRule: 'VSTAR' } }],
      abilities: [{ name: '测试星耀', translation: power }] }])
    assert.throws(() => mon('cn:machine:pokemon:test-bad:1', { name: '测试', nameKey: 'test-bad', ...face }, 'CSV1C/009_127'), /rule box/);
  // A source that dropped the reminder: a 「…GX」 attack without its rule, a Pokémon VSTAR without a VSTAR Power.
  for (const face of [{ ruleBox: 'GX', attacks: [{ ...gxAttack, translation: { status: 'ok', effects: [] } }] },
    { ruleBox: 'TAG TEAM', attacks: [{ ...gxAttack, translation: undefined }] },
    { ruleBox: 'VSTAR', stage: 'VSTAR', evolvesFrom: 'test-v', abilities: [{ name: '测试星耀', translation: { ...power, specialRule: undefined } }] }])
    assert.throws(() => mon('cn:machine:pokemon:test-bad:1', { name: '测试', nameKey: 'test-bad', ...face }, 'CSV1C/009_127'), /once-per-game/);
  // The translation check puts the result on a stand-in with that rule box; the rule must match the printed reminder.
  const unit = (kind, extra, text) => ({ kind, text, card: { name: '测试', kind: 'pokemon', stage: 'basic', hp: 70 }, ...extra });
  const gxText = '测试。[对战中，己方的GX招式只能使用1次。]', starText = '测试。（对战中，己方的VSTAR力量只可使用1次。）';
  assert.equal(checkEffect(unit('attack', { attack: { name: '测试GX', cost: '雷', damage: '' } }, gxText), gxAttack.translation).valid, true);
  assert.equal(checkEffect(unit('ability', { ability: { name: '测试星耀' } }, starText), power).valid, true);
  assert.equal(checkEffect(unit('ability', { ability: { name: '测试星耀' } }, starText), { ...power, specialRule: 'GX' }).valid, false);
  assert.equal(checkEffect(unit('ability', { ability: { name: '测试星耀' } }, '测试。'), power).valid, false, 'No reminder printed.');
  const { specialRule: _rule, ...unlimited } = power;
  assert.equal(checkEffect(unit('ability', { ability: { name: '测试星耀' } }, starText), unlimited).valid, false, 'Reminder printed, no rule.');
});

test('a Tool\'s attack: its name, cost, damage and GX reminder must be printed in the checked text; the holder kind and the turn-end discard', () => {
  const rule = '身上放有这张卡牌的，拥有招式「龙爪」的宝可梦，可以使用这张卡牌上的GX招式。[需要满足使用招式所需能量。]';
  const text = trainerText(rule, [{ name: '巨龙燃烧GX', cost: ['无', '无', '无'], damage: '80×',
    text: '将附着于这只宝可梦身上的基本能量，全部放于弃牌区，造成其张数×80点伤害。[对战中，己方的GX招式只能使用1次。]' }]);
  assert.equal(text, `${rule}\n\n【无】【无】【无】 巨龙燃烧GX 80×\n将附着于这只宝可梦身上的基本能量，全部放于弃牌区，造成其张数×80点伤害。[对战中，己方的GX招式只能使用1次。]`);
  const attack = { name: '巨龙燃烧GX', cost: '无无无', damage: { value: 80, operator: 'times' }, specialRule: 'GX', effects: [
    ['burn', 'cn.countedEnergyDiscard@1', { op: 'discardEnergy', side: 'own', from: 'self', selector: { kind: 'energy', category: 'basic' },
      providedTypes: null, measure: 'cards', quantity: { kind: 'all' }, chooser: 'source' }],
    ['damage', 'cn.damageValue@1', { expression: { kind: 'multiply', left: { kind: 'literal', value: 80 }, right: { kind: 'effectCards', effectId: 'DEF:g:burn' } } }]] };
  const translation = { status: 'ok', effects: [], grantedAttackHolder: { kind: 'pokemon', attackNames: ['龙爪'] }, turnEndDiscard: true, grantedAttacks: [attack] };
  const build = (face) => machineTrainer('cn:machine:trainer:test-z:1', { name: '龙Z', nameKey: 'test-z', category: 'tool', text, translation, ...face },
    ev('CSM2aC/135'));
  const d = build({});
  assert.equal(d.mechanics.grantedAttacks[0].attackId, 'cn:machine:trainer:test-z:1:g');
  assert.equal(d.mechanics.grantedAttacks[0].effects[1].parameters.expression.right.effectId, 'cn:machine:trainer:test-z:1:g:burn');
  assert.deepEqual(d.mechanics.grantedAttackHolder, { kind: 'pokemon', attackNames: ['龙爪'] }); assert.equal(d.mechanics.turnEndDiscard, true);
  assertExecutableDefinition(d, { ruleset: RULESET, approvedDefinitions: new Map([[d.definitionId, canonicalDefinition(d)]]), handlers });
  assertSupportedDefinition({ handler: (id) => handlers.get(id) }, d);
  for (const wrong of [{ name: '巨龙燃烧' + 'X' }, { cost: '无无' + '草' }, { damage: 90 }])
    assert.throws(() => build({ translation: { ...translation, grantedAttacks: [{ ...attack, ...wrong }] } }), /printed in the checked card text/);
  assert.throws(() => build({ text: rule + '\n\n【无】【无】【无】 巨龙燃烧GX 80×\n将…', }), /printed in the checked card text/, 'No GX reminder printed.');
  assert.throws(() => build({ category: 'item' }), /one attack printed on a Tool/);
  assert.throws(() => build({ translation: { ...translation, grantedAttacks: [attack, attack] } }), /one attack printed on a Tool/);
});

test('「这个招式，只有在……时才可使用」 is carried from the translation and passes every gate', () => {
  const condition = { predicate: { kind: 'historyFact', fact: 'secondPlayerFirstTurn' } };
  const d = mon('cn:machine:pokemon:test-cond:1', { name: '测试', nameKey: 'test-cond', hp: 70,
    attacks: [{ name: '先手', cost: '无', damage: 10, translation: { status: 'ok', condition, effects: [] } }] }, 'CSV1C/010_127');
  assert.deepEqual(d.mechanics.attacks[0].condition, condition);
  assertExecutableDefinition(d, { ruleset: RULESET, approvedDefinitions: new Map([[d.definitionId, canonicalDefinition(d)]]), handlers });
  assertSupportedDefinition({ handler: (id) => handlers.get(id) }, d);
  const unit = { kind: 'attack', text: '测试。', card: { name: '测试', kind: 'pokemon', stage: 'basic', hp: 70 }, attack: { name: '先手', cost: '无', damage: '10' } };
  assert.equal(checkEffect(unit, { status: 'ok', condition, effects: [] }).valid, true);
});

test('a fingerprint ignores identities and evidence: same card, same definition; another HP, another one', () => {
  const a = mon('cn:machine:pokemon:test-a:1', { name: '测试', nameKey: 'test-a', hp: 70 }, 'CSV1C/003_127');
  const b = mon('cn:machine:pokemon:test-a:2', { name: '测试', nameKey: 'test-a', hp: 70, attacks: [{ name: '撞 击', cost: '无', damage: 20 }] }, 'CSV2C/009_128');
  const c = mon('cn:machine:pokemon:test-a:3', { name: '测试', nameKey: 'test-a', hp: 80 }, 'CSV2C/010_128');
  assert.equal(fingerprint(a), fingerprint(b));
  assert.notEqual(fingerprint(a), fingerprint(c));
});

test('a CPU game to the end with machine-tier vanilla Pokémon and machine printings of reviewed basic Energy', async () => {
  const basics = [['电击兽测试', 'test-elec', 90, 30], ['小拉达测试', 'test-rat', 60, 20], ['波波测试', 'test-bird', 50, 10]]
    .map(([name, nameKey, hp, damage], i) => mon(`cn:machine:pokemon:${nameKey}:1`, { name, nameKey, hp,
      attacks: [{ name: '撞击', cost: '无', damage }, { name: '电击', cost: '雷无', damage: damage + 30 }] }, `TST/00${i + 1}_010`));
  const stage1 = mon('cn:machine:pokemon:test-elec-2:1', { name: '电击魔兽测试', nameKey: 'test-elec-2', stage: 'stage1', evolvesFrom: 'test-elec',
    hp: 130, attacks: [{ name: '雷电拳', cost: '雷雷无', damage: 90 }] }, 'TST/004_010');
  const lightning = DEFINITIONS.find((d) => d.definitionId === 'cn:energy:basic-lightning');
  const reprint = machinePrinting({ printingId: 'zh-Hans:TST:LIG', setCode: 'TST', number: 'LIG', mark: null, series: 'scarlet-violet',
    releasedOn: '2025-01-17', dir: 'TST/LIG' }, lightning.definitionId, ev('TST/LIG'));
  const mine = [...basics, stage1];
  const printings = [...mine.map((d, i) => printingOf(d, 'TST', `00${i + 1}/010`, `TST/00${i + 1}_010`)), reprint];
  const catalog = await catalogOf([...DEFINITIONS, ...mine], [...PRINTINGS, ...printings]);
  assert.equal(catalog.definitionFor('zh-Hans:TST:LIG').definitionId, 'cn:energy:basic-lightning');
  const deck = [...printings.slice(0, 4).flatMap((p) => Array(4).fill(p.printingId)), ...Array(44).fill('zh-Hans:TST:LIG')];
  validateFormatDeck(catalog, deck, OPEN_FORMAT);
  const game = new OfficialGame({ decks: [deck, deck], seed: [3, 1, 4, 1], format: OPEN_FORMAT, matchMode: 'normal', ruleset: { ...RULESET }, catalog });
  const ai = createAI(catalog);
  for (let steps = 0; !game.snapshot().result; steps++) {
    if (steps > 3000) assert.fail('The CPU game must terminate.');
    const s = game.snapshot(), player = s.pending ? s.pending.player : s.current, view = game.view(player);
    game.dispatch({ player, expectedRevision: view.revision, action: ai(view, player) });
  }
  assert.ok(game.snapshot().result.winner === 0 || game.snapshot().result.winner === 1 || game.snapshot().result.draw);
});
