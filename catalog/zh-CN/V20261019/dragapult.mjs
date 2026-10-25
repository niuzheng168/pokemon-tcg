// 多龙巴鲁托ex / 黑夜魔灵 tournament deck (OmniTCG deck 676815, see decks.mjs): every
// distinct printing of that 60-card list not already reviewed in csvh1c.mjs or raging-bolt.mjs.
// Review standard (2026-10-21): every printed field below was read from the
// fingerprinted local card image and cross-checked with the same directory's
// metadata.json; disagreements resolve to the image. Face tags and rule boxes
// missing from the metadata blocks (太晶 on 多龙巴鲁托ex, ex rules, ACE SPEC) come from the image.
// Printed glyphs: 草 Grass, 火 Fire, 超 Psychic, 斗 Fighting, 恶 Darkness, 龙 Dragon,
// 无 Colorless. All weaknesses are ×2, all resistances -30.
import { definitionBuilder, printing, ALL_ENERGY_TYPES } from './common.mjs';
import { PRODUCTS as EARLIER } from './raging-bolt.mjs';

const page = (bytes, sha256) => ({ retrievedOn: '2026-10-21', bytes, sha256 });
// Code-to-product links: the 52poke dump (`alt` field) and the MIK set metadata
// agree with each official page's name and release date.
export const PRODUCTS = Object.freeze({
  ...EARLIER,
  'CSV9.5C': { id: 'CSV9.5', name: '补充包 太晶盛聚', url: 'https://www.pokemon.cn/tcg/product/21997.html',
    series: 'scarlet-violet', releasedOn: '2026-06-12', pageObservation: page(65507, '41b19ecdb1e2e714e7cb25bf5e2da052567612943c70af073b38d243a37fdef2') },
  CSV10C: { id: 'CSV10', name: '补充包 共逐荣光', url: 'https://www.pokemon.cn/tcg/product/20012.html',
    series: 'scarlet-violet', releasedOn: '2026-07-16', pageObservation: page(70810, 'c7b5f4410c0b8b485da323c81cc078b22eecc5341670feff92ff60a5e6bddb43') },
});
export const PRODUCT = null;
export const TEST_IDS = Object.freeze(['tests/cn-cards/dragapult.test.mjs']);

const MIK = 'https://tcg.mik.moe/static/img/';
const lib = (set, dir, sha256, n = dir.split('_')[0]) => ({ store: 'library_prod', path: `zh-Hans/${set}/${dir}/${set}_${dir}.png`, sha256,
  origin: `${MIK}${set}/${n}.png` });
const card = (set, number, name, nameKey, mark, image) => ({ product: PRODUCTS[set], setCode: set, number, name, nameKey, mark, image });

export const CARDS = Object.freeze({
  dreepy: card('CSV8C', '157/207', '多龙梅西亚', 'dreepy', 'H',
    lib('CSV8C', '157_207', '4768708f69f68ef773ba480feca33c7f598b3d5ee12313e5ed734e56e4456b11')),
  drakloak: card('CSV8C', '158/207', '多龙奇', 'drakloak', 'H',
    lib('CSV8C', '158_207', '591c87c53c5b49db2fb8a0cf0a08d91a44699187a273a41f550bf3544d1d5ff2')),
  dragapultEx: card('CSV8C', '159/207', '多龙巴鲁托ex', 'dragapult-ex', 'H',
    lib('CSV8C', '159_207', 'd568d153cf32f4681ef8e59ba4a7ac1df91d818aeb84f4410ccbc17ccfdc32f7')),
  duskull: card('CSV8C', '081/207', '夜巡灵', 'duskull', 'H',
    lib('CSV8C', '081_207', '9c21b072e419fa9d9ff5c11f57b766e964c48bd3ec62bf646d3c58f4ce06c47b')),
  dusclops: card('CSV8C', '082/207', '彷徨夜灵', 'dusclops', 'H',
    lib('CSV8C', '082_207', '2a6e490a6046940a8f927724bdd7ff2dba0002c9c8b6e44970cd8f87cf738804')),
  dusknoir: card('CSV8C', '083/207', '黑夜魔灵', 'dusknoir', 'H',
    lib('CSV8C', '083_207', '9f7e235ca42fede1bd1d2d9096d533d53b8daf22c39990eef3ba11db7eee65d4')),
  budew: card('CSV9.5C', '004/208', '含羞苞', 'budew', 'H',
    lib('CSV9.5C', '004_208', '6456010d864013a445970ac1518a3288971a28bcd8455e6110abd06bdaba2af7')),
  munkidori: card('CSV8C', '094/207', '愿增猿', 'munkidori', 'H',
    lib('CSV8C', '094_207', 'a5629d8789fb360336dc2f816c259bd93eca6e1d138b2c897fae69f576e210f3')),
  hawlucha: card('CSV1C', '079/127', '摔角鹰人', 'hawlucha', 'G',
    lib('CSV1C', '079_127', '556392ee5e6ddbed691f916a4b91915970d2ac6593e63b6999485ea2b97f315b')),
  ursalunaEx: card('CSV8C', '172/207', '月月熊 赫月ex', 'bloodmoon-ursaluna-ex', 'H',
    lib('CSV8C', '172_207', 'fe2ec7907cf14e0ba087c902e0d9875361d4663f84cdee6557399ce678f56649')),
  shaymin: card('CSV10C', '007/222', '谢米', 'shaymin', 'I',
    lib('CSV10C', '007_222', 'aa281bea31b733192b2789714cb31172c09e7f59cafbe608cffd43a01d9fb25a')),
  poffin: card('CSV7C', '177/204', '友好宝芬', 'buddy-buddy-poffin', 'H',
    lib('CSV7C', '177_204', '1c270c146665abe659f7b215f0d31bcefd37d35c16f81909bee26c2b7275857c')),
  pokePad: card('30thC', '102/103', '宝可平板', 'poke-pad', 'J',
    lib('30thC', '102_103', '11eafaf8444e14daa52e3dcfbfbc3d09e32e8b34370365d3d1aae53d460f09a6')),
  counterCatcher: card('CSV6C', '114/128', '反击捕捉器', 'counter-catcher', 'G',
    lib('CSV6C', '114_128', '2e758f63a1af671431d177ba67ecd13a472bff24677fd4cd1310d334e8d30ce3')),
  // The library holds this face under CSV3C/123 (no 123_130 directory); the card prints 123/130.
  iono: card('CSV3C', '123/130', '奇树', 'iono', 'G',
    { store: 'library_prod', path: 'zh-Hans/CSV3C/123/CSV3C_123.png',
      sha256: 'c49f116a36b826abd7e75fc4a9e67da145c0de3d4654b62f0641d65889fccb3e', origin: `${MIK}CSV3C/123.png` }),
  lillie: card('30thDC', '040/040', '莉莉艾的决心', 'lillies-determination', 'I',
    lib('30thDC', '040_040', '8c4e4fafc8383963ba2c6fa7325f6ccbfa5744314dfd3abde012f4179eaf1e33')),
  jammingTower: card('CSV8C', '203/207', '阻碍之塔', 'jamming-tower', 'H',
    lib('CSV8C', '203_207', 'f4825d1511043f230685e4f673e6a003e2d37cf8e78fb9d6bb23dad8cbd1cb8d')),
  luminous: card('CSV1C', '127/127', '夜光能量', 'luminous-energy', 'G',
    lib('CSV1C', '127_127', '924d40cbfc02fe6985de9e503dc9d1cee2b881b8792f6b18100115446d36df3a')),
  // CSV7C/203_204 holds only a garbled wiki record and no image; the face is under CSV7C/203.
  neoUpper: card('CSV7C', '203/204', '新冲天能量', 'neo-upper-energy', 'H',
    { store: 'library_prod', path: 'zh-Hans/CSV7C/203/CSV7C_203.png',
      sha256: '2a413e76304c831a2e719e687456d64b2aaafb1dc0a0bf3ddb9c5ed5e77174c7', origin: `${MIK}CSV7C/203.png` }),
  // Footer tokens FIR/PSY are the only identifiers printed on these Basic Energy cards.
  fireEnergy: card('CSVE1C', 'FIR', '基本火能量', 'basic-fire-energy', null,
    lib('CSVE1C', 'FIR', '4b41c56e5172916aeb677102723122509fe0711efa06be35374aef0ca4bc4ca7')),
  psychicEnergy: card('CSVE1C', 'PSY', '基本超能量', 'basic-psychic-energy', null,
    lib('CSVE1C', 'PSY', '72b2ca2ca79619f6ec12e5af4b0d467d2db20177e94d9aa5ed811c1b47476b85')),
});

const EX_RULE = 'ex规则：当宝可梦ex昏厥时，对手将拿取2张奖赏卡。';
const CURSED_BLAST = (n) => `在自己的回合可以使用1次，如果使用了，则令这只宝可梦昏厥。给对手的1只宝可梦身上，放置${n}个伤害指示物。`;
// Printed rules text, transcribed from the reviewed images for presentation
// only. Execution comes from the reviewed handler bindings, never from text.
export const TEXTS = Object.freeze({
  drakloak: { 'recon-directive': '在自己的回合可以使用1次。查看自己牌库上方2张卡牌，选择其中1张卡牌，加入手牌。将剩余的卡牌，放回牌库下方。' },
  dragapultEx: { tera: '太晶：只要这只宝可梦，处于备战区，就不会受到招式的伤害。',
    'phantom-dive': '将6个伤害指示物，以任意方式放置于对手的备战宝可梦身上。', rule: EX_RULE },
  duskull: { 'come-and-get-you': '选择自己弃牌区中最多3张「夜巡灵」，放于备战区。' },
  dusclops: { 'cursed-blast': CURSED_BLAST(5) },
  dusknoir: { 'cursed-blast': CURSED_BLAST(13), 'shadow-bind': '在下一个对手的回合，受到这个招式影响的宝可梦，无法撤退。' },
  budew: { 'itchy-pollen': '在下一个对手的回合，对手无法从手牌使出物品。' },
  munkidori: { 'adrena-brain': '如果这只宝可梦身上附着了【恶】能量的话，则在自己的回合可以使用1次。选择自己场上1只宝可梦身上放置的最多3个伤害指示物，转放于对手场上1只宝可梦身上。',
    'mind-bend': '令对手的战斗宝可梦陷入混乱状态。' },
  hawlucha: { 'flying-entry': '在自己的回合，当将这张卡牌从手牌使出放于备战区时，可使用1次。给对手的2只备战宝可梦身上，各放置1个伤害指示物。' },
  ursalunaEx: { 'seasoned-skill': '这只宝可梦使用「血月」所需能量会减少与对手已经获得的奖赏卡张数相同数量的【无】能量。',
    'blood-moon': '在下一个自己的回合，这只宝可梦无法使用招式。', rule: EX_RULE },
  shaymin: { 'flower-curtain': '只要这只宝可梦在场上，自己所有备战宝可梦（除「拥有规则的宝可梦」外）不会受到对手招式的伤害。' },
  poffin: { card: '选择自己牌库中，最多2张HP在「70」及以下的基础宝可梦，放于备战区。并重洗牌库。' },
  pokePad: { card: '选择自己牌库中的1张宝可梦（除「拥有规则的宝可梦」外），在给对手看过之后加入手牌。并重洗牌库。' },
  counterCatcher: { card: '这张卡牌，只有在自己的剩余奖赏卡张数，比对手的剩余奖赏卡张数多时才可使用。选择对手的1只备战宝可梦，将其与战斗宝可梦互换。' },
  iono: { card: '双方玩家，各将自己所有的手牌反面朝上重洗，放回牌库下方。然后，各从牌库上方抽取与自己剩余奖赏卡张数相同数量的卡牌。' },
  lillie: { card: '将自己的手牌全部放回牌库并重洗牌库。然后，从牌库上方抽取6张卡牌。如果自己的剩余奖赏卡张数为6张的话，则抽取的张数变为8张。' },
  jammingTower: { card: '双方所有宝可梦身上放有的「宝可梦道具」的效果，全部消除。' },
  luminous: { card: '只要这张卡牌，被附着于宝可梦身上，就被视作1个所有属性的能量。如果身上附着了这张卡牌的宝可梦，身上还附着了除这张卡牌以外的特殊能量的话，则这张卡牌被视作1个【无】能量。' },
  neoUpper: { card: '只要这张卡牌，被附着于宝可梦身上，就被视作1个【无】能量。如果被附着于2阶进化宝可梦身上的话，则被视作2个所有属性的能量。',
    rule: 'ACE SPEC：在1副卡组中只能放入1张ACE SPEC卡。' },
});

const d = definitionBuilder(null, TEST_IDS);
const id = (slug) => `cn:${slug}`;
const fromHand = { event: 'bench', origin: 'hand', subject: 'self', turn: 'own', scope: 'global', choiceOwner: 'source', optional: true };
const once = (key) => ({ period: 'turn', scope: 'pokemon', key: `cn:ability:${key}`, limit: 1 });
const lockNextTurn = ['lock', 'cn.lasting@1', { side: 'own', target: 'self', effect: { op: 'restriction', scope: 'all', actions: ['attack'] },
  duration: 'nextOwnTurn', clearOnBench: true, clearOnEvolution: true }];
const tera = ['tera', 'cn.protection@1', { effect: { op: 'protection', channel: 'damage', useRule: 'ordinary', scope: 'self', from: 'all',
  categories: ['attack'], benchOnly: true } }];
const cursedBlast = (count) => ({ key: 'cursed-blast', name: '咒怨炸弹', mode: 'activated', usage: once('cursed-blast'), effects: [
  ['knock-out', 'cn.knockOut@1', { target: 'self' }],
  ['counters', 'cn.counters@1', { side: 'opponent', target: 'any', count }],
] });
const special = { kind: 'energy', category: 'special' };
const DEF = Object.freeze({
  dreepy: id('pokemon:dreepy:csv8c-157'), drakloak: id('pokemon:drakloak:csv8c-158'), dragapultEx: id('pokemon:dragapult-ex:csv8c-159'),
  duskull: id('pokemon:duskull:csv8c-081'), dusclops: id('pokemon:dusclops:csv8c-082'), dusknoir: id('pokemon:dusknoir:csv8c-083'),
  budew: id('pokemon:budew:csv9-5c-004'), munkidori: id('pokemon:munkidori:csv8c-094'), hawlucha: id('pokemon:hawlucha:csv1c-079'),
  ursalunaEx: id('pokemon:bloodmoon-ursaluna-ex:csv8c-172'), shaymin: id('pokemon:shaymin:csv10c-007'),
});

export const DEFINITIONS = Object.freeze([
  // 基础 HP70 龙；小哀怨[超]10；咬住[火超]40。弱点 无；抗性 无；撤退 1。
  d.pokemon(CARDS.dreepy, DEF.dreepy, {
    stage: 'basic', hp: 70, type: '龙', retreat: 1, attacks: [
      { key: 'petty-grudge', name: '小哀怨', cost: '超', damage: 10 },
      { key: 'bite', name: '咬住', cost: '火超', damage: 40 },
    ],
  }),
  // 1阶进化（从多龙梅西亚进化）HP90 龙；特性 侦察指令：在自己的回合可以使用1次。查看自己牌库上方2张卡牌，选择其中1张卡牌，加入手牌。
  // 将剩余的卡牌，放回牌库下方。龙之头击[火超]70。弱点 无；抗性 无；撤退 1。
  d.pokemon(CARDS.drakloak, DEF.drakloak, {
    stage: 'stage1', evolvesFrom: 'dreepy', hp: 90, type: '龙', retreat: 1,
    abilities: [{ key: 'recon-directive', name: '侦察指令', mode: 'activated', usage: once('recon-directive'), effects: [
      ['look', 'cn.inspectDeck@1', { op: 'inspectDeck', lookTop: 2, selector: { kind: 'any' }, quantity: { kind: 'exact', count: 1 },
        revealSelected: false, remainder: { mode: 'shuffleToBottom' } }],
    ] }],
    attacks: [{ key: 'dragon-headbutt', name: '龙之头击', cost: '火超', damage: 70 }],
  }),
  // 2阶进化（从多龙奇进化）HP320 龙 太晶 ex；太晶：只要这只宝可梦，处于备战区，就不会受到招式的伤害。喷射头击[无]70；
  // 幻影潜袭[火超]200 将6个伤害指示物，以任意方式放置于对手的备战宝可梦身上。弱点 无；抗性 无；撤退 1。
  d.pokemon(CARDS.dragapultEx, DEF.dragapultEx, {
    stage: 'stage2', evolvesFrom: 'drakloak', basicAncestor: 'dreepy', hp: 320, type: '龙', retreat: 1, ex: true, tags: ['Tera'],
    rules: [tera],
    attacks: [
      { key: 'jet-headbutt', name: '喷射头击', cost: '无', damage: 70 },
      { key: 'phantom-dive', name: '幻影潜袭', cost: '火超', damage: 200, effects: [['spread', 'cn.distributeCounters@1', {
        op: 'distributeCounters', side: 'opponent', target: 'bench', selector: { kind: 'pokemon' }, count: 6 }]] },
    ],
  }),
  // 基础 HP60 超；渡魂[超] 选择自己弃牌区中最多3张「夜巡灵」，放于备战区。喃喃自语[超超]30。弱点 恶×2；抗性 斗-30；撤退 1。
  d.pokemon(CARDS.duskull, DEF.duskull, {
    stage: 'basic', hp: 60, type: '超', weakness: '恶', resistance: ['斗', 30], retreat: 1, attacks: [
      { key: 'come-and-get-you', name: '渡魂', cost: '超', damage: null, effects: [['bench', 'cn.cards@1', { from: 'discard', to: 'bench',
        selector: { kind: 'pokemon', nameKeys: ['duskull'] }, quantity: { kind: 'upTo', count: 3 }, reveal: false, lookTop: null, shuffleAfter: false }]] },
      { key: 'mumble', name: '喃喃自语', cost: '超超', damage: 30 },
    ],
  }),
  // 1阶进化（从夜巡灵进化）HP90 超；特性 咒怨炸弹：在自己的回合可以使用1次，如果使用了，则令这只宝可梦昏厥。
  // 给对手的1只宝可梦身上，放置5个伤害指示物。磷火[超超]50。弱点 恶×2；抗性 斗-30；撤退 2。
  d.pokemon(CARDS.dusclops, DEF.dusclops, {
    stage: 'stage1', evolvesFrom: 'duskull', hp: 90, type: '超', weakness: '恶', resistance: ['斗', 30], retreat: 2,
    abilities: [cursedBlast(5)], attacks: [{ key: 'will-o-wisp', name: '磷火', cost: '超超', damage: 50 }],
  }),
  // 2阶进化（从彷徨夜灵进化）HP160 超；特性 咒怨炸弹（13个）；影子束缚[超超无]150 在下一个对手的回合，受到这个招式影响的宝可梦，
  // 无法撤退。弱点 恶×2；抗性 斗-30；撤退 3。
  d.pokemon(CARDS.dusknoir, DEF.dusknoir, {
    stage: 'stage2', evolvesFrom: 'dusclops', basicAncestor: 'duskull', hp: 160, type: '超', weakness: '恶', resistance: ['斗', 30], retreat: 3,
    abilities: [cursedBlast(13)],
    attacks: [{ key: 'shadow-bind', name: '影子束缚', cost: '超超无', damage: 150, effects: [['bind', 'cn.lasting@1', {
      side: 'opponent', target: 'active', effect: { op: 'restriction', scope: 'all', actions: ['retreat'] },
      duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true }]] }],
  }),
  // 基础 HP30 草；痒痒花粉（不需要能量）10 在下一个对手的回合，对手无法从手牌使出物品。弱点 火×2；撤退 0。
  d.pokemon(CARDS.budew, DEF.budew, {
    stage: 'basic', hp: 30, type: '草', weakness: '火', retreat: 0, attacks: [
      { key: 'itchy-pollen', name: '痒痒花粉', cost: '', damage: 10, effects: [['item-lock', 'cn.lastingPlayer@1', {
        side: 'opponent', effect: { op: 'playerRestriction', scope: 'all', actions: ['playItem'] }, duration: 'nextOpponentTurn' }]] },
    ],
  }),
  // 基础 HP110 超；特性 亢奋脑力：如果这只宝可梦身上附着了【恶】能量的话，则在自己的回合可以使用1次。选择自己场上1只宝可梦身上
  // 放置的最多3个伤害指示物，转放于对手场上1只宝可梦身上。精神幻觉[超无]60 令对手的战斗宝可梦陷入混乱状态。
  // 弱点 恶×2；抗性 斗-30；撤退 1。
  d.pokemon(CARDS.munkidori, DEF.munkidori, {
    stage: 'basic', hp: 110, type: '超', weakness: '恶', resistance: ['斗', 30], retreat: 1,
    abilities: [{ key: 'adrena-brain', name: '亢奋脑力', mode: 'activated', usage: once('adrena-brain'),
      condition: { attachedEnergyType: 'Darkness' }, effects: [['move', 'cn.transferCounters@1', {
        count: 3, from: 'any', side: 'opponent', target: 'any', quantity: 'upTo' }]] }],
    attacks: [{ key: 'mind-bend', name: '精神幻觉', cost: '超无', damage: 60, effects: [
      ['confuse', 'cn.condition@1', { side: 'opponent', condition: 'confused' }]] }],
  }),
  // 基础 HP70 斗；特性 飞身入场：在自己的回合，当将这张卡牌从手牌使出放于备战区时，可使用1次。给对手的2只备战宝可梦身上，
  // 各放置1个伤害指示物。翅膀攻击[斗无无]70。弱点 超×2；撤退 1。
  d.pokemon(CARDS.hawlucha, DEF.hawlucha, {
    stage: 'basic', hp: 70, type: '斗', weakness: '超', retreat: 1,
    abilities: [{ key: 'flying-entry', name: '飞身入场', mode: 'triggered', usage: null, trigger: fromHand, effects: [
      ['counters', 'cn.counters@1', { side: 'opponent', target: 'bench', count: 1, targets: 2 }]] }],
    attacks: [{ key: 'wing-attack', name: '翅膀攻击', cost: '斗无无', damage: 70 }],
  }),
  // 基础 HP260 无 ex；特性 老练招式：这只宝可梦使用「血月」所需能量会减少与对手已经获得的奖赏卡张数相同数量的【无】能量。
  // 血月[无无无无无]240 在下一个自己的回合，这只宝可梦无法使用招式。弱点 斗×2；撤退 3。
  d.pokemon(CARDS.ursalunaEx, DEF.ursalunaEx, {
    stage: 'basic', hp: 260, type: '无', weakness: '斗', retreat: 3, ex: true,
    abilities: [{ key: 'seasoned-skill', name: '老练招式', mode: 'continuous', usage: null, effects: [['cost', 'cn.energyRequirement@1', {
      effect: { op: 'energyRequirement', action: 'attack', mode: 'adjust', scope: 'self', energyType: 'Colorless', amount: -1,
        perPrizesTaken: 'opponent', attackIds: [`${DEF.ursalunaEx}:blood-moon`] } }]] }],
    attacks: [{ key: 'blood-moon', name: '血月', cost: '无无无无无', damage: 240, effects: [lockNextTurn] }],
  }),
  // 基础 HP80 草；特性 花之纱幔：只要这只宝可梦在场上，自己所有备战宝可梦（除「拥有规则的宝可梦」外）不会受到对手招式的伤害。
  // 踢飞[无无]30。弱点 火×2；撤退 1。
  d.pokemon(CARDS.shaymin, DEF.shaymin, {
    stage: 'basic', hp: 80, type: '草', weakness: '火', retreat: 1,
    abilities: [{ key: 'flower-curtain', name: '花之纱幔', mode: 'continuous', usage: null, effects: [['curtain', 'cn.protection@1', {
      effect: { op: 'protection', channel: 'damage', useRule: 'ordinary', scope: 'own', from: 'opponent', categories: ['attack'],
        benchOnly: true, ruleBox: false } }]] }],
    attacks: [{ key: 'smash-kick', name: '踢飞', cost: '无无', damage: 30 }],
  }),
  // 物品：选择自己牌库中，最多2张HP在「70」及以下的基础宝可梦，放于备战区。并重洗牌库。
  d.trainer(CARDS.poffin, id('trainer:buddy-buddy-poffin'), 'item', [
    ['search', 'cn.cards@1', { from: 'deck', to: 'bench', selector: { kind: 'pokemon', stages: ['basic'], printedHpAtMost: 70 },
      quantity: { kind: 'upTo', count: 2 }, reveal: false, lookTop: null, shuffleAfter: true }],
  ]),
  // 物品：选择自己牌库中的1张宝可梦（除「拥有规则的宝可梦」外），在给对手看过之后加入手牌。并重洗牌库。
  d.trainer(CARDS.pokePad, id('trainer:poke-pad'), 'item', [
    ['search', 'cn.cards@1', { from: 'deck', to: 'hand', selector: { kind: 'pokemon', ruleBox: false },
      quantity: { kind: 'exact', count: 1 }, reveal: true, lookTop: null, shuffleAfter: true }],
  ]),
  // 物品：这张卡牌，只有在自己的剩余奖赏卡张数，比对手的剩余奖赏卡张数多时才可使用。选择对手的1只备战宝可梦，将其与战斗宝可梦互换。
  d.trainer(CARDS.counterCatcher, id('trainer:counter-catcher'), 'item', [
    ['gust', 'cn.switch@1', { side: 'opponent', chooser: 'self', affected: 'selected' }],
  ], null, { condition: { prizesRemaining: 'moreThanOpponent' } }),
  // 支援者：双方玩家，各将自己所有的手牌反面朝上重洗，放回牌库下方。然后，各从牌库上方抽取与自己剩余奖赏卡张数相同数量的卡牌。
  d.trainer(CARDS.iono, id('trainer:iono'), 'supporter', [
    ['hand-bottom-draw', 'cn.handBottomDraw@1', { side: 'both', ownDraw: { kind: 'remainingPrizes' }, opponentDraw: { kind: 'remainingPrizes' } }],
  ]),
  // 支援者：将自己的手牌全部放回牌库并重洗牌库。然后，从牌库上方抽取6张卡牌。如果自己的剩余奖赏卡张数为6张的话，则抽取的张数变为8张。
  d.trainer(CARDS.lillie, id('trainer:lillies-determination'), 'supporter', [
    ['hand-deck-draw', 'cn.handDeckDraw@1', { side: 'own', ownDraw: { kind: 'ifRemainingPrizes', equals: 6, then: 8, otherwise: 6 }, opponentDraw: 0 }],
  ]),
  // 竞技场：双方所有宝可梦身上放有的「宝可梦道具」的效果，全部消除。
  d.trainer(CARDS.jammingTower, id('trainer:jamming-tower'), 'stadium', [
    ['tools', 'cn.suppression@1', { effect: { op: 'suppression', channel: 'tools', scope: 'all' } }],
  ]),
  // 特殊能量：被视作1个所有属性的能量；身上还附着了除这张卡牌以外的特殊能量时，被视作1个【无】能量。
  d.specialEnergy(CARDS.luminous, id('energy:luminous'), [ALL_ENERGY_TYPES], [
    ['provision', 'cn.energyProvision@1', { effect: { op: 'energyProvision', scope: 'self', selector: special, cardSelf: true,
      units: [['Colorless']], otherAttached: special } }],
  ]),
  // 特殊能量 ACE SPEC：被视作1个【无】能量；附着于2阶进化宝可梦身上时，被视作2个所有属性的能量。
  d.specialEnergy(CARDS.neoUpper, id('energy:neo-upper'), [['Colorless']], [
    ['provision', 'cn.energyProvision@1', { effect: { op: 'energyProvision', scope: 'self', selector: special, cardSelf: true,
      units: [ALL_ENERGY_TYPES, ALL_ENERGY_TYPES], stages: ['stage2'] } }],
  ], { aceSpec: true }),
  d.basicEnergy(CARDS.fireEnergy, id('energy:basic-fire'), '火'),
  d.basicEnergy(CARDS.psychicEnergy, id('energy:basic-psychic'), '超'),
]);

const definitionFor = new Map(Object.entries(CARDS).map(([key, c]) => {
  const found = DEFINITIONS.find((x) => x.nameKey === c.nameKey);
  if (!found || found.name !== c.name) throw new Error(`No reviewed definition for ${c.setCode} ${c.number}`);
  return [key, found.definitionId];
}));
export const PRINTINGS = Object.freeze(Object.entries(CARDS).map(([key, c]) => printing(null, c, definitionFor.get(key))));
export const PRINTING = Object.freeze(Object.fromEntries(Object.entries(CARDS).map(([key, c]) => [key, `zh-Hans:${c.setCode}:${c.number}`])));
