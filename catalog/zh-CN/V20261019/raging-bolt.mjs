// 猛雷鼓ex tournament deck (OmniTCG deck 679141, see decks.mjs): every distinct
// printing of that 60-card list not already reviewed in csvh1c.mjs.
// Review standard (2026-10-21): every printed field below was read from the
// fingerprinted local card image and cross-checked with the same directory's
// metadata.json; disagreements resolve to the image. Tags printed on the face
// but absent from the metadata blocks (古代/未来/太晶, ACE SPEC) come from the image.
// Printed glyphs: 草 Grass, 水 Water, 雷 Lightning, 超 Psychic, 斗 Fighting, 恶 Darkness,
// 钢 Metal, 龙 Dragon, 无 Colorless. All weaknesses are ×2, all resistances -30.
import { definitionBuilder, printing, cardEvidence } from './common.mjs';

const page = (bytes, sha256) => ({ retrievedOn: '2026-10-21', bytes, sha256 });
// Official product pages fix each set's product and first release date. The
// pages never print set codes; each code-to-product link comes from the 52poke
// dump cross-checked with the MIK archive's set metadata (they agree for every code).
export const PRODUCTS = Object.freeze({
  CSV1C: { id: 'CSV1', name: '补充包「亘古开来」', url: 'https://www.pokemon.cn/tcg/product/15585.html',
    series: 'scarlet-violet', releasedOn: '2025-01-17', pageObservation: page(79820, 'e781de33fde5ee8485b909672816cdb9f7456f2ee2e674f71ca9d055a99c964e') },
  CSV2C: { id: 'CSV2', name: '补充包 奇迹启程', url: 'https://www.pokemon.cn/tcg/product/15556.html',
    series: 'scarlet-violet', releasedOn: '2025-03-21', pageObservation: page(59852, '2f626828c106d6f4ba8eb5c770ad0e857ecac2cfc67caf770332b0a9b7870ae0') },
  CSV3C: { id: 'CSV3', name: '补充包 无畏太晶', url: 'https://www.pokemon.cn/tcg/product/15519.html',
    series: 'scarlet-violet', releasedOn: '2025-05-16', pageObservation: page(59019, 'acb23133cd97f57e72006a3421a89b328deb978340ee6a2d113fd167c7497772') },
  CSV6C: { id: 'CSV6', name: '补充包 真实玄虚', url: 'https://www.pokemon.cn/tcg/17555.html',
    series: 'scarlet-violet', releasedOn: '2025-11-07', pageObservation: page(54712, 'c92ece63b0462851b9ec827fafb703b42ed7fc5bfff6d60e09c539e3aff4a05d') },
  CSV7C: { id: 'CSV7', name: '补充包 利刃猛醒', url: 'https://www.pokemon.cn/tcg/product/19812.html',
    series: 'scarlet-violet', releasedOn: '2026-01-16', pageObservation: page(61219, '0d0aa716a07d30123620a2208be11acedf1180e1ac5a17a2ad6c5f385453d4b1') },
  CSV8C: { id: 'CSV8', name: '补充包 璀璨诡幻', url: 'https://www.pokemon.cn/tcg/product/20627.html',
    series: 'scarlet-violet', releasedOn: '2026-03-13', pageObservation: page(63354, 'b372779baad03ae3c860f05d07e4329ababe15efdcbc3cc4a288c5b52a0ce588') },
  CSV9C: { id: 'CSV9', name: '补充包 星彩晶璃', url: 'https://www.pokemon.cn/tcg/product/21383.html',
    series: 'scarlet-violet', releasedOn: '2026-05-15', pageObservation: page(53181, '5fa078b879f7e95d8076e60706f701e824c110c5146a8b16d6c73d01ffed81ee') },
  '151C': { id: '151C', name: '补充包「收集啦151 旅」', url: 'https://www.pokemon.cn/tcg/product/15688.html',
    series: 'scarlet-violet', releasedOn: '2025-01-17', pageObservation: page(53899, '0a4da4a0a6df16bced8f3ff44cc35d639445c371055419ded4a7f03b68a915c9') },
  '30thC': { id: '30thC', name: '宝可梦集换式卡牌游戏 补充包 30周年庆典', url: 'https://www.pokemon.cn/tcg/product/22237.html',
    series: 'anniversary-30', releasedOn: '2026-09-16', pageObservation: page(64694, '4668ed3a6ab47cec314e8d4c325947f0da7fd487da6cd1f1ffcac725f97af4ba') },
  '30thDC': { id: '30thDC', name: '宝可梦集换式卡牌游戏 30周年庆典 豪华卡组套装', url: 'https://www.pokemon.cn/tcg/product/21608.html',
    series: 'anniversary-30', releasedOn: '2026-09-16', pageObservation: page(76906, 'cd5e4a210fba459de93c6a1814afcace56d9033dc2e6b756a85b2d3f6a723649') },
  // 对战派对 共梦 上 (event-only product, 2025-02-28). Its official deck guide
  // (tcg/product/15551.html) lists Basic Energy in those decks; no official page
  // shows the CSVE1C mark itself, and MIK records a blanket 2025-04-18 (共梦 下).
  CSVE1C: { id: 'CSVE1', name: '宝可梦集换式卡牌游戏 朱&紫 对战派对 共梦 上', url: 'https://www.pokemon.cn/tcg/event/15558.html',
    series: 'scarlet-violet', releasedOn: '2025-02-28', pageObservation: page(52712, 'ba845aae2412d45b85170d1e9585fcea66e9462fb8b21b816f2b75731218ffbc') },
});
export const PRODUCT = null;
export const TEST_IDS = Object.freeze(['tests/cn-cards/raging-bolt.test.mjs']);

const MIK = 'https://tcg.mik.moe/static/img/';
const lib = (set, dir, sha256, n = dir.split('_')[0]) => ({ store: 'library_v1', path: `zh-Hans/${set}/${dir}/${set}_${dir}.png`, sha256,
  origin: `${MIK}${set}/${n}.png` });
const card = (set, number, name, nameKey, mark, image) => ({ product: PRODUCTS[set], setCode: set, number, name, nameKey, mark, image });

export const CARDS = Object.freeze({
  ragingBoltEx: card('CSV7C', '154/204', '猛雷鼓ex', 'raging-bolt-ex', 'H',
    lib('CSV7C', '154_204', '9fc87ea894c0afaaccb18e177df824febb7bd031c23d0e90692bb736b25b68a5')),
  ragingBolt: card('CSV8C', '161/207', '猛雷鼓', 'raging-bolt', 'H',
    lib('CSV8C', '161_207', '6605b69bb1bd45f9680b7e26776b2378468477a00be1d90e1a66e16725b6d7ab')),
  ogerponEx: card('CSV8C', '028/207', '厄诡椪 碧草面具ex', 'teal-mask-ogerpon-ex', 'H',
    lib('CSV8C', '028_207', '34077d42aa6a78ecde74a642df44cc038a7bc252562fac18b7d3c54a425656f4')),
  mewEx: card('151C', '151/151', '梦幻ex', 'mew-ex', 'G',
    lib('151C', '151_151', '87c655a8c8d81d4c043d76e0144d43dd2592141666bf1babb1a2b18421ca8e6f')),
  squawkabillyEx: card('CSV2C', '105/128', '怒鹦哥ex', 'squawkabilly-ex', 'G',
    lib('CSV2C', '105_128', 'ca54f39ceb0e3b0ad05692ed919b58e8fb632899bd485da6323ffea069f081fa')),
  ironLeavesEx: card('CSV7C', '033/204', '铁斑叶ex', 'iron-leaves-ex', 'H',
    lib('CSV7C', '033_204', '1fd44a2a07c18b4fff88196bc45a5152edcfdf51950946dac88d522b7d7e9fc8')),
  chienPao: card('CSV9C', '053/208', '古剑豹', 'chien-pao', 'H',
    lib('CSV9C', '053_208', '877f439597236e27ee1338ee7782bdbb6506f99271bb8158f079c263ba81f929')),
  fezandipitiEx: card('CSV8C', '135/207', '吉雉鸡ex', 'fezandipiti-ex', 'H',
    lib('CSV8C', '135_207', '6cf40688905224c9308bbfca07a684cce2967462cc9cbf2258e91afbfc2b4e61')),
  latiasEx: card('CSV9C', '078/208', '拉帝亚斯ex', 'latias-ex', 'H',
    lib('CSV9C', '078_208', '747d55de54943c02c73ed9d910ff1ed0581ba9d0997c88e0b22e43287f20acd9')),
  slitherWing: card('CSV6C', '082/128', '爬地翅', 'slither-wing', 'G',
    lib('CSV6C', '082_128', '0c5133a293c4ca150cd1c3a4939337ac893d9b9563a44ab4f22898c1e4a709b6')),
  ditto: card('151C', '132/151', '百变怪', 'ditto', 'G',
    lib('151C', '132_151', '04c9113df7c1579561d68ffca5eda0c727fa2ecd3e776a12fbeb2e31271553b7')),
  // Same name as CSVH1C 044 高级球; this 30thC face words the condition
  // differently with identical meaning, so it binds the existing definition.
  ultraBall: card('30thC', '101/103', '高级球', 'ultra-ball', 'I',
    lib('30thC', '101_103', 'd88f2a29f8e44c805ace1efca70247a559f5a348590dd1374aea5f68f65a607e')),
  earthenVessel: card('CSV6C', '115/128', '大地容器', 'earthen-vessel', 'G',
    lib('CSV6C', '115_128', '65db669be3b1011bea7c0325620ae43d7ac3568c7af8880d0abf94e13cb01cc7')),
  nightStretcher: card('CSV8C', '183/207', '夜间担架', 'night-stretcher', 'H',
    lib('CSV8C', '183_207', 'bdc868ab62f01bc31527ddc8a13dde5331f246719a4ea863d8c52626cde4eb76')),
  // The library holds this face under CSV2C/113 (113_128 has no image); the card prints 113/128.
  pokegear: card('CSV2C', '113/128', '宝可装置3.0', 'pokegear-3-0', 'G',
    { store: 'library_v1', path: 'zh-Hans/CSV2C/113/CSV2C_113.png',
      sha256: 'ef15b6f5adda3e076c339f92c329e91933bb0ea726582e992951ad0abc137269', origin: `${MIK}CSV2C/113.png` }),
  palPad: card('CSV1C', '111/127', '朋友手册', 'pal-pad', 'G',
    lib('CSV1C', '111_127', '286ff5ad6fb6630fecc0c6b32d831f8074dbed50f8653566b36cece17e57dcc0')),
  superiorEnergyRetrieval: card('CSV3C', '115/130', '超级能量回收', 'superior-energy-retrieval', 'G',
    lib('CSV3C', '115_130', '22bb55ff3411f1ef2e21d49e91171ea9384ebd0ebb5a62802f8c41331fb58457')),
  primeCatcher: card('CSV7C', '180/204', '顶尖捕捉器', 'prime-catcher', 'H',
    lib('CSV7C', '180_204', '73ccf532a1bb3e9914d283a8c0dd5209f571f654214910005b32290a7c1d72db')),
  sadasVitality: card('CSV6C', '121/128', '奥琳博士的气魄', 'professor-sadas-vitality', 'G',
    lib('CSV6C', '121_128', '66a6a338899e005d08e0dcb76900b42f2eb3505fda139556d8c36bc8a80bff2e')),
  crispin: card('CSV9C', '196/208', '赤松', 'crispin', 'H',
    lib('CSV9C', '196_208', '5ae0d42ce5c17b201a5579363ea32ac7cb02505d501f6215ebc0ca70e203136f')),
  // The printed name is 老大的指令; the 乌羽 subtitle is not name identity (CN format page).
  bossOrders: card('30thDC', '039/040', '老大的指令', 'bosss-orders', 'I',
    lib('30thDC', '039_040', '6f727064c19bd9e74cb42895e2dadfae637471a928fe5737dd3db70d8deb5fb1')),
  // Same name and meaning as CSVH1C 051 裁判 (slightly different wording); binds that definition.
  judge: card('30thDC', '037/040', '裁判', 'judge', 'J',
    lib('30thDC', '037_040', '0c65b27cbd9de3aed047ce579f73f611cf767e82b52be20fbda6528ae5d11781')),
  areaZero: card('CSV9C', '207/208', '零之大空洞', 'area-zero-underdepths', 'H',
    lib('CSV9C', '207_208', '2514d5e7e130106a51010f09999c39fd52d4de27787da4206144b3f3124ebd14')),
  // Footer tokens GRA/LIG/FIG are the only identifiers printed on these Basic Energy cards.
  grassEnergy: card('CSVE1C', 'GRA', '基本草能量', 'basic-grass-energy', null,
    lib('CSVE1C', 'GRA', 'e52e65162fcbe9b096de7eb8c85fe5e5ee4d038b4396199ae8d1d0a5ac133b0e')),
  lightningEnergy: card('CSVE1C', 'LIG', '基本雷能量', 'basic-lightning-energy', null,
    lib('CSVE1C', 'LIG', '37d89d2c17230db033d23ede36ae6c95937cdf8bdc44e46742bd9214165bd40c')),
  fightingEnergy: card('CSVE1C', 'FIG', '基本斗能量', 'basic-fighting-energy', null,
    lib('CSVE1C', 'FIG', '908b99821d9229e353ef5b26ea32fa6a203000462e8fcf8898d0d4861a081c1c')),
});

const EX_RULE = 'ex规则：当宝可梦ex昏厥时，对手将拿取2张奖赏卡。';
// Printed rules text, transcribed from the reviewed images for presentation
// only. Execution comes from the reviewed handler bindings, never from text.
export const TEXTS = Object.freeze({
  ragingBoltEx: { 'bursting-roar': '将自己的手牌全部放于弃牌区，从牌库上方抽取6张卡牌。',
    'bellowing-thunder': '将自己场上宝可梦身上附着的任意数量的基本能量放于弃牌区，造成其张数×70伤害。', rule: EX_RULE },
  ragingBolt: { 'thundering-bolt': '给对手的1只宝可梦，造成这只宝可梦身上附着的能量数量×30伤害。[备战宝可梦不计算弱点、抗性。]' },
  ogerponEx: { 'teal-dance': '在自己的回合可以使用1次。选择自己手牌中的1张「基本【草】能量」，附着于这只宝可梦身上。然后，从自己牌库上方抽取1张卡牌。',
    'myriad-leaf-shower': '追加造成双方战斗宝可梦身上附着的能量数量×30伤害。',
    tera: '太晶：只要这只宝可梦，处于备战区，就不会受到招式的伤害。', rule: EX_RULE },
  mewEx: { restart: '在自己的回合可以使用1次。从牌库上方抽取卡牌，直到自己的手牌变为3张为止。',
    'genome-hacking': '选择对手战斗宝可梦所拥有的1个招式，作为这个招式使用。', rule: EX_RULE },
  squawkabillyEx: { 'squawk-and-seize': '只有在最初的自己的回合可以使用1次。将自己的手牌全部放于弃牌区，从牌库上方抽取6张卡牌。在这个回合，如果已经使用了其他的「英武重抽」的话，则无法使用这个特性。',
    'motivate': '选择自己弃牌区中最多2张基本能量，附着于1只备战宝可梦身上。', rule: EX_RULE },
  ironLeavesEx: { 'rapid-vernier': '在自己的回合，当将这张卡牌从手牌使出放于备战区时，可使用1次。将这只宝可梦与战斗宝可梦互换。如果成功执行互换了的话，则选择任意数量的自己场上宝可梦身上附着的能量，转附于这只宝可梦身上。',
    'prism-edge': '在下一个自己的回合，这只宝可梦无法使用招式。', rule: EX_RULE },
  chienPao: { 'snow-sink': '在自己的回合，当将这张卡牌从手牌使出放于备战区时，可使用1次。将场上的竞技场放于弃牌区。',
    'hail-blade': '选择这只宝可梦身上附着的1个能量，放回手牌。' },
  fezandipitiEx: { 'flip-the-script': '在上一个对手的回合，如果自己的宝可梦【昏厥】的话，则在自己的回合可以使用1次。从自己牌库上方抽取3张卡牌。在这个回合，如果已经使用了其他的「化危为吉」的话，则无法使用这个特性。',
    'cruel-arrow': '给对手的1只宝可梦，造成100伤害。[备战宝可梦不计算弱点、抗性。]', rule: EX_RULE },
  latiasEx: { skyliner: '只要这只宝可梦在场上，自己所有【基础】宝可梦【撤退】所需能量，全部消除。',
    'eon-blade': '在下一个自己的回合，这只宝可梦无法使用招式。', rule: EX_RULE },
  slitherWing: { stomp: '将对手牌库上方1张卡牌放于弃牌区。', 'burning-turbulence': '给这只宝可梦也造成90伤害。令对手的战斗宝可梦陷入【灼伤】状态。' },
  ditto: { 'transformative-start': '如果这只宝可梦在战斗场上的话，则仅在最初的自己的回合可以使用1次。选择自己牌库中的1张【基础】宝可梦（除「百变怪」外）。然后，将这只宝可梦，以及放于其身上的所有卡牌放于弃牌区，将被选择的宝可梦放于这只宝可梦原先的位置。并重洗牌库。' },
  ultraBall: { card: '只有将自己的2张手牌放于弃牌区后才可以使用这张卡牌。选择自己牌库中的1张宝可梦，在给对手看过之后加入手牌。并重洗牌库。' },
  earthenVessel: { card: '这张卡牌，只有将自己的1张手牌放于弃牌区后才可使用。选择自己牌库中最多2张基本能量，在给对手看过之后，加入手牌。并重洗牌库。' },
  nightStretcher: { card: '选择自己弃牌区中的1张宝可梦或1张基本能量，在给对手看过之后，加入手牌。' },
  pokegear: { card: '查看自己牌库上方7张卡牌，选择其中1张支援者，在给对手看过之后，加入手牌。将剩余的卡牌放回牌库并重洗牌库。' },
  palPad: { card: '选择自己弃牌区中最多2张支援者，在给对手看过之后，放回牌库并重洗牌库。' },
  superiorEnergyRetrieval: { card: '这张卡牌，只有将自己的2张手牌放于弃牌区后才可使用。选择自己弃牌区中最多4张基本能量，在给对手看过之后，加入手牌。（无法选择因为这张卡牌的效果而被放于弃牌区的能量。）' },
  primeCatcher: { card: '选择对手的1只备战宝可梦，将其与战斗宝可梦互换。然后，将自己的战斗宝可梦与备战宝可梦互换。',
    rule: 'ACE SPEC：在1副卡组中只能放入1张ACE SPEC卡。' },
  sadasVitality: { card: '选择自己最多2只「古代」宝可梦，各附着1张弃牌区中的基本能量。然后，从自己牌库上方抽取3张卡牌。' },
  crispin: { card: '选择自己牌库中，属性各不相同的基本能量最多2张，在给对手看过之后，将其中1张加入手牌，将剩余的能量附着于自己的宝可梦身上。并重洗牌库。' },
  bossOrders: { card: '选择对手的1只备战宝可梦，将其与战斗宝可梦互换。' },
  judge: { card: '双方玩家各将手牌全部放回牌库并重洗牌库。然后，各从牌库上方抽取4张卡牌。' },
  areaZero: { card: '自己场上有「太晶」宝可梦的玩家，可以放于备战区的宝可梦数量变为8只。（当这张卡牌被放于弃牌区，或者自己场上没有「太晶」宝可梦时，将备战宝可梦放于弃牌区，直到备战宝可梦的数量变为5只为止。双方都要将备战宝可梦放于弃牌区的话，则由这张卡牌的持有者开始执行。）' },
});

const d = definitionBuilder(null, TEST_IDS);
const id = (slug) => `cn:${slug}`;
const lit = (value) => ({ kind: 'literal', value });
const times = (n, value) => ({ kind: 'multiply', left: lit(n), right: value });
const units = (who) => ({ kind: 'pokemon', who, field: 'energyUnits' });
const discardFee = (count) => [{ costId: `discard-${count}`, kind: 'discardHand', count, selector: { kind: 'any' } }];
const fromHand = { event: 'bench', origin: 'hand', subject: 'self', turn: 'own', scope: 'global', choiceOwner: 'source', optional: true };
const lockNextTurn = ['lock', 'cn.lasting@1', { side: 'own', target: 'self', effect: { op: 'restriction', scope: 'all', actions: ['attack'] },
  duration: 'nextOwnTurn', clearOnBench: true, clearOnEvolution: true }];
const gust = { handlerId: 'cn.switch@1', parameters: { side: 'opponent', chooser: 'self', affected: 'selected' } };
const ownSwitch = { handlerId: 'cn.switch@1', parameters: { side: 'own', chooser: 'self', affected: 'active' } };
const DEF = Object.freeze({
  ragingBoltEx: id('pokemon:raging-bolt-ex:csv7c-154'), ragingBolt: id('pokemon:raging-bolt:csv8c-161'),
  ogerponEx: id('pokemon:teal-mask-ogerpon-ex:csv8c-028'), mewEx: id('pokemon:mew-ex:151c-151'),
  squawkabillyEx: id('pokemon:squawkabilly-ex:csv2c-105'), ironLeavesEx: id('pokemon:iron-leaves-ex:csv7c-033'),
  chienPao: id('pokemon:chien-pao:csv9c-053'), fezandipitiEx: id('pokemon:fezandipiti-ex:csv8c-135'),
  latiasEx: id('pokemon:latias-ex:csv9c-078'), slitherWing: id('pokemon:slither-wing:csv6c-082'), ditto: id('pokemon:ditto:151c-132'),
});

export const DEFINITIONS = Object.freeze([
  // 基础 HP240 龙 古代；飞溅咆哮[无] 将自己的手牌全部放于弃牌区，从牌库上方抽取6张卡牌（无「然后」：两项分别执行）。
  // 极雷轰[雷斗]70× 将自己场上宝可梦身上附着的任意数量的基本能量放于弃牌区，造成其张数×70伤害。弱点 无；抗性 无；撤退 3。
  d.pokemon(CARDS.ragingBoltEx, DEF.ragingBoltEx, {
    stage: 'basic', hp: 240, type: '龙', retreat: 3, ex: true, tags: ['Ancient'], attacks: [
      { key: 'bursting-roar', name: '飞溅咆哮', cost: '无', damage: null, effects: [
        ['discard-hand', 'cn.discardHand@1', {}], ['draw', 'cn.draw@1', { count: 6 }],
      ] },
      { key: 'bellowing-thunder', name: '极雷轰', cost: '雷斗', damage: { value: 70, operator: 'times' }, effects: [
        ['discard', 'cn.countedEnergyDiscard@1', { op: 'discardEnergy', side: 'own', from: 'any', selector: { kind: 'energy', category: 'basic' },
          providedTypes: null, measure: 'cards', quantity: { kind: 'any' }, chooser: 'source' }],
        ['damage', 'cn.damageValue@1', { expression: times(70, { kind: 'effectCards', effectId: `${DEF.ragingBoltEx}:bellowing-thunder:discard` }) }],
      ] },
    ],
  }),
  // 基础 HP130 龙 古代；落雷风暴[雷斗] 给对手的1只宝可梦，造成这只宝可梦身上附着的能量数量×30伤害（备战不计弱点抗性）。
  // 龙之头击[雷斗无]130。弱点 无；抗性 无；撤退 3。
  d.pokemon(CARDS.ragingBolt, DEF.ragingBolt, {
    stage: 'basic', hp: 130, type: '龙', retreat: 3, tags: ['Ancient'], attacks: [
      { key: 'thundering-bolt', name: '落雷风暴', cost: '雷斗', damage: null, effects: [['damage', 'cn.damage@1', {
        side: 'opponent', target: 'any', amount: times(30, units('self')), selection: { kind: 'exact', count: 1 }, options: {},
      }]] },
      { key: 'dragon-headbutt', name: '龙之头击', cost: '雷斗无', damage: 130 },
    ],
  }),
  // 基础 HP210 草 太晶；太晶规则：只要这只宝可梦，处于备战区，就不会受到招式的伤害。特性 碧草之舞：在自己的回合可以使用1次。
  // 选择自己手牌中的1张「基本【草】能量」，附着于这只宝可梦身上。然后，从自己牌库上方抽取1张卡牌。
  // 万叶阵雨[草草草]30+ 追加造成双方战斗宝可梦身上附着的能量数量×30伤害。弱点 火×2；撤退 1。
  d.pokemon(CARDS.ogerponEx, DEF.ogerponEx, {
    stage: 'basic', hp: 210, type: '草', weakness: '火', retreat: 1, ex: true, tags: ['Tera'],
    rules: [['tera', 'cn.protection@1', { effect: { op: 'protection', channel: 'damage', useRule: 'ordinary', scope: 'self', from: 'all',
      categories: ['attack'], benchOnly: true } }]],
    abilities: [{ key: 'teal-dance', name: '碧草之舞', mode: 'activated',
      usage: { period: 'turn', scope: 'pokemon', key: 'cn:ability:teal-dance', limit: 1 },
      effects: [['attach', 'cn.attachThenDraw@1', { from: 'hand', draw: 1,
        attach: { type: 'Grass', count: 1, benchOnly: false, optional: false, target: 'self' } }]] }],
    attacks: [{ key: 'myriad-leaf-shower', name: '万叶阵雨', cost: '草草草', damage: { value: 30, operator: 'plus' }, effects: [
      ['damage', 'cn.damageValue@1', { expression: { kind: 'add', terms: [lit(30),
        times(30, { kind: 'add', terms: [units('ownActive'), units('opponentActive')] })] } }],
    ] }],
  }),
  // 基础 HP180 超；特性 再起动：在自己的回合可以使用1次。从牌库上方抽取卡牌，直到自己的手牌变为3张为止。
  // 基因侵入[无无无] 选择对手战斗宝可梦所拥有的1个招式，作为这个招式使用。弱点 恶×2；抗性 斗-30；撤退 0。
  d.pokemon(CARDS.mewEx, DEF.mewEx, {
    stage: 'basic', hp: 180, type: '超', weakness: '恶', resistance: ['斗', 30], retreat: 0, ex: true,
    abilities: [{ key: 'restart', name: '再起动', mode: 'activated',
      usage: { period: 'turn', scope: 'pokemon', key: 'cn:ability:restart', limit: 1 },
      effects: [['draw', 'cn.drawUntil@1', { count: 3 }]] }],
    attacks: [{ key: 'genome-hacking', name: '基因侵入', cost: '无无无', damage: null, effects: [['copy', 'cn.copyAttack@1', {
      op: 'copyAttack', origins: [{ side: 'opponent', zone: 'active', selector: { kind: 'pokemon' } }], excludeUser: false,
      coin: 'none', energy: 'ignore', special: { mode: 'needsRuling', sourceOfTruth: cardEvidence(null, CARDS.mewEx) },
    }]] }],
  }),
  // 基础 HP160 无；特性 英武重抽：只有在最初的自己的回合可以使用1次。将自己的手牌全部放于弃牌区，从牌库上方抽取6张卡牌。
  // 在这个回合，如果已经使用了其他的「英武重抽」的话，则无法使用这个特性。鼓足干劲[无]20 选择自己弃牌区中最多2张基本能量，
  // 附着于1只备战宝可梦身上。弱点 雷×2；抗性 斗-30；撤退 1。
  d.pokemon(CARDS.squawkabillyEx, DEF.squawkabillyEx, {
    stage: 'basic', hp: 160, type: '无', weakness: '雷', resistance: ['斗', 30], retreat: 1, ex: true,
    abilities: [{ key: 'squawk-and-seize', name: '英武重抽', mode: 'activated', condition: { firstOwnTurn: true },
      usage: { period: 'turn', scope: 'player', key: 'cn:ability:squawk-and-seize', limit: 1 },
      effects: [['discard-hand', 'cn.discardHand@1', {}], ['draw', 'cn.draw@1', { count: 6 }]] }],
    attacks: [{ key: 'motivate', name: '鼓足干劲', cost: '无', damage: 20, effects: [['attach', 'cn.attachDiscard@1', {
      type: null, count: 2, benchOnly: true, optional: false, distribution: 'singleRecipient' }]] }],
  }),
  // 基础 HP220 草 未来；特性 快速游标：在自己的回合，当将这张卡牌从手牌使出放于备战区时，可使用1次。将这只宝可梦与战斗宝可梦互换。
  // 如果成功执行互换了的话，则选择任意数量的自己场上宝可梦身上附着的能量，转附于这只宝可梦身上。
  // 棱镜利刃[草草无]180 在下一个自己的回合，这只宝可梦无法使用招式。弱点 火×2；撤退 1。
  d.pokemon(CARDS.ironLeavesEx, DEF.ironLeavesEx, {
    stage: 'basic', hp: 220, type: '草', weakness: '火', retreat: 1, ex: true, tags: ['Future'],
    abilities: [{ key: 'rapid-vernier', name: '快速游标', mode: 'triggered', usage: null, trigger: fromHand,
      effects: [['switch-then-move', 'cn.then@1', {
        first: { handlerId: 'cn.switch@1', parameters: { side: 'own', chooser: 'self', affected: 'source' } },
        next: { handlerId: 'cn.attachedEnergy@1', parameters: { op: 'moveEnergy', side: 'own', from: 'any', selector: { kind: 'energy' },
          providedTypes: null, measure: 'cards', quantity: { kind: 'any' }, chooser: 'source',
          recipient: { position: 'self', selector: { kind: 'pokemon' } }, distribution: 'singleRecipient' } },
      }]] }],
    attacks: [{ key: 'prism-edge', name: '棱镜利刃', cost: '草草无', damage: 180, effects: [lockNextTurn] }],
  }),
  // 基础 HP120 水；特性 埋入雪中：在自己的回合，当将这张卡牌从手牌使出放于备战区时，可使用1次。将场上的竞技场放于弃牌区。
  // 冰柱环[水水无]120 选择这只宝可梦身上附着的1个能量，放回手牌。弱点 钢×2；撤退 1。
  d.pokemon(CARDS.chienPao, DEF.chienPao, {
    stage: 'basic', hp: 120, type: '水', weakness: '钢', retreat: 1,
    abilities: [{ key: 'snow-sink', name: '埋入雪中', mode: 'triggered', usage: null, trigger: fromHand,
      effects: [['stadium', 'cn.discardStadium@1', { op: 'discardStadium', side: 'either', selector: { kind: 'trainer', categories: ['stadium'] } }]] }],
    attacks: [{ key: 'hail-blade', name: '冰柱环', cost: '水水无', damage: 120, effects: [['return', 'cn.attachedEnergy@1', {
      op: 'returnEnergy', side: 'own', from: 'self', selector: { kind: 'energy' }, providedTypes: null, measure: 'units',
      quantity: { kind: 'exact', count: 1 }, chooser: 'source', to: 'hand' }]] }],
  }),
  // 基础 HP210 恶；特性 化危为吉：在上一个对手的回合，如果自己的宝可梦昏厥的话，则在自己的回合可以使用1次。
  // 从自己牌库上方抽取3张卡牌。在这个回合，如果已经使用了其他的「化危为吉」的话，则无法使用这个特性。
  // 残忍箭矢[无无无] 给对手的1只宝可梦，造成100伤害（备战不计弱点抗性）。弱点 斗×2；撤退 1。
  d.pokemon(CARDS.fezandipitiEx, DEF.fezandipitiEx, {
    stage: 'basic', hp: 210, type: '恶', weakness: '斗', retreat: 1, ex: true,
    abilities: [{ key: 'flip-the-script', name: '化危为吉', mode: 'activated', condition: { previousOpponentKnockout: true },
      usage: { period: 'turn', scope: 'player', key: 'cn:ability:flip-the-script', limit: 1 },
      effects: [['draw', 'cn.draw@1', { count: 3 }]] }],
    attacks: [{ key: 'cruel-arrow', name: '残忍箭矢', cost: '无无无', damage: null, effects: [['damage', 'cn.damage@1', {
      side: 'opponent', target: 'any', amount: 100, selection: { kind: 'exact', count: 1 }, options: {} }]] }],
  }),
  // 基础 HP210 超；特性 天际线：只要这只宝可梦在场上，自己所有【基础】宝可梦【撤退】所需能量，全部消除。
  // 无限之刃[超超无]200 在下一个自己的回合，这只宝可梦无法使用招式。弱点 恶×2；抗性 斗-30；撤退 2。
  d.pokemon(CARDS.latiasEx, DEF.latiasEx, {
    stage: 'basic', hp: 210, type: '超', weakness: '恶', resistance: ['斗', 30], retreat: 2, ex: true,
    abilities: [{ key: 'skyliner', name: '天际线', mode: 'continuous', usage: null,
      effects: [['retreat', 'cn.energyRequirement@1', { effect: { op: 'energyRequirement', action: 'retreat', mode: 'erase',
        scope: 'own', stages: ['basic'] } }]] }],
    attacks: [{ key: 'eon-blade', name: '无限之刃', cost: '超超无', damage: 200, effects: [lockNextTurn] }],
  }),
  // 基础 HP140 斗 古代；踏平[斗] 将对手牌库上方1张卡牌放于弃牌区。烫伤怒涛[斗斗]120 给这只宝可梦也造成90伤害。
  // 令对手的战斗宝可梦陷入灼伤状态。弱点 超×2；撤退 3。
  d.pokemon(CARDS.slitherWing, DEF.slitherWing, {
    stage: 'basic', hp: 140, type: '斗', weakness: '超', retreat: 3, tags: ['Ancient'], attacks: [
      { key: 'stomp', name: '踏平', cost: '斗', damage: null, effects: [['mill', 'cn.discardDeckTop@1', { side: 'opponent', count: 1 }]] },
      { key: 'burning-turbulence', name: '烫伤怒涛', cost: '斗斗', damage: 120, effects: [
        ['recoil', 'cn.recoilDamage@1', { side: 'own', target: 'self', amount: 90, selection: { kind: 'all' }, options: {} }],
        ['burn', 'cn.condition@1', { side: 'opponent', condition: 'burned' }],
      ] },
    ],
  }),
  // 基础 HP60 无；特性 变身启动：如果这只宝可梦在战斗场上的话，则仅在最初的自己的回合可以使用1次。选择自己牌库中的1张
  // 【基础】宝可梦（除「百变怪」外）。然后，将这只宝可梦，以及放于其身上的所有卡牌放于弃牌区，将被选择的宝可梦放于这只
  // 宝可梦原先的位置。并重洗牌库。粘粑粑[无]10。弱点 斗×2；撤退 1。
  d.pokemon(CARDS.ditto, DEF.ditto, {
    stage: 'basic', hp: 60, type: '无', weakness: '斗', retreat: 1,
    abilities: [{ key: 'transformative-start', name: '变身启动', mode: 'activated', condition: { firstOwnTurn: true, sourceActive: true },
      usage: { period: 'turn', scope: 'pokemon', key: 'cn:ability:transformative-start', limit: 1 },
      effects: [['transform', 'cn.replacePokemon@1', { op: 'replacePokemon', target: 'self', from: 'deck', shuffleAfter: true,
        selector: { kind: 'pokemon', stages: ['basic'], excludeNameKeys: ['ditto'] } }]] }],
    attacks: [{ key: 'sticky-bind', name: '粘粑粑', cost: '无', damage: 10 }],
  }),
  // 物品（古代）：这张卡牌，只有将自己的1张手牌放于弃牌区后才可使用。选择自己牌库中最多2张基本能量，在给对手看过之后，加入手牌。并重洗牌库。
  d.trainer(CARDS.earthenVessel, id('trainer:earthen-vessel'), 'item', [
    ['search', 'cn.cards@1', { from: 'deck', to: 'hand', selector: { kind: 'energy', category: 'basic' }, quantity: { kind: 'upTo', count: 2 },
      reveal: true, lookTop: null, shuffleAfter: true }],
  ], discardFee(1), { tags: ['Ancient'] }),
  // 物品：选择自己弃牌区中的1张宝可梦或1张基本能量，在给对手看过之后，加入手牌。
  d.trainer(CARDS.nightStretcher, id('trainer:night-stretcher'), 'item', [
    ['recover', 'cn.cards@1', { from: 'discard', to: 'hand', selector: { anyOf: [{ kind: 'pokemon' }, { kind: 'energy', category: 'basic' }] },
      quantity: { kind: 'exact', count: 1 }, reveal: true, lookTop: null, shuffleAfter: false }],
  ]),
  // 物品：查看自己牌库上方7张卡牌，选择其中1张支援者，在给对手看过之后，加入手牌。将剩余的卡牌放回牌库并重洗牌库。
  d.trainer(CARDS.pokegear, id('trainer:pokegear-3-0'), 'item', [
    ['look', 'cn.cards@1', { from: 'deck', to: 'hand', selector: { kind: 'trainer', categories: ['supporter'] },
      quantity: { kind: 'exact', count: 1 }, reveal: true, lookTop: 7, shuffleAfter: true }],
  ]),
  // 物品：选择自己弃牌区中最多2张支援者，在给对手看过之后，放回牌库并重洗牌库。
  d.trainer(CARDS.palPad, id('trainer:pal-pad'), 'item', [
    ['return', 'cn.cards@1', { from: 'discard', to: 'deck', selector: { kind: 'trainer', categories: ['supporter'] },
      quantity: { kind: 'upTo', count: 2 }, reveal: true, lookTop: null, shuffleAfter: true }],
  ]),
  // 物品：这张卡牌，只有将自己的2张手牌放于弃牌区后才可使用。选择自己弃牌区中最多4张基本能量，在给对手看过之后，加入手牌。
  // （无法选择因为这张卡牌的效果而被放于弃牌区的能量。）
  d.trainer(CARDS.superiorEnergyRetrieval, id('trainer:superior-energy-retrieval'), 'item', [
    ['recover', 'cn.cards@1', { from: 'discard', to: 'hand', selector: { kind: 'energy', category: 'basic' }, quantity: { kind: 'upTo', count: 4 },
      reveal: true, lookTop: null, shuffleAfter: false, excludePaid: true }],
  ], discardFee(2)),
  // 物品 ACE SPEC：选择对手的1只备战宝可梦，将其与战斗宝可梦互换。然后，将自己的战斗宝可梦与备战宝可梦互换。
  d.trainer(CARDS.primeCatcher, id('trainer:prime-catcher'), 'item', [
    ['catch', 'cn.then@1', { first: gust, next: ownSwitch }],
  ], null, { aceSpec: true }),
  // 支援者：选择自己最多2只「古代」宝可梦，各附着1张弃牌区中的基本能量。然后，从自己牌库上方抽取3张卡牌。
  d.trainer(CARDS.sadasVitality, id('trainer:professor-sadas-vitality'), 'supporter', [
    ['vitality', 'cn.attachThenDraw@1', { from: 'discard', draw: 3, attach: { type: null, count: 2, benchOnly: false, optional: false,
      recipient: { kind: 'pokemon', tagsAll: ['Ancient'] }, distribution: 'separateRecipients' } }],
  ]),
  // 支援者：选择自己牌库中，属性各不相同的基本能量最多2张，在给对手看过之后，将其中1张加入手牌，将剩余的能量附着于自己的宝可梦身上。并重洗牌库。
  d.trainer(CARDS.crispin, id('trainer:crispin'), 'supporter', [
    ['split', 'cn.attachDeckEnergy@1', { op: 'attachDeckEnergy', lookTop: null, selector: { kind: 'energy', category: 'basic' },
      quantity: { kind: 'upTo', count: 2 }, recipient: { position: 'any', selector: { kind: 'pokemon' } }, distribution: 'separateRecipients',
      remainder: 'shuffleDeck', reveal: true, distinctTypes: true, toHand: 1 }],
  ]),
  // 支援者：选择对手的1只备战宝可梦，将其与战斗宝可梦互换。
  d.trainer(CARDS.bossOrders, id('trainer:bosss-orders'), 'supporter', [['gust', gust.handlerId, gust.parameters]]),
  // 竞技场：自己场上有「太晶」宝可梦的玩家，可以放于备战区的宝可梦数量变为8只。（离场或失去太晶宝可梦时弃置至5只，持有者先执行。）
  d.trainer(CARDS.areaZero, id('trainer:area-zero-underdepths'), 'stadium', [
    ['bench', 'cn.benchLimit@1', { effect: { op: 'benchLimit', scope: 'all', limit: 8, requires: { kind: 'pokemon', tagsAll: ['Tera'] } } }],
  ]),
  d.basicEnergy(CARDS.grassEnergy, id('energy:basic-grass'), '草'),
  d.basicEnergy(CARDS.fightingEnergy, id('energy:basic-fighting'), '斗'),
]);

// Printings of names already defined in csvh1c.mjs bind those definitions.
const SHARED = Object.freeze({ ultraBall: id('trainer:ultra-ball'), judge: id('trainer:judge'), lightningEnergy: id('energy:basic-lightning') });
const definitionFor = new Map(Object.entries(CARDS).map(([key, c]) => {
  if (SHARED[key]) return [key, SHARED[key]];
  const found = DEFINITIONS.find((x) => x.nameKey === c.nameKey);
  if (!found || found.name !== c.name) throw new Error(`No reviewed definition for ${c.setCode} ${c.number}`);
  return [key, found.definitionId];
}));
export const PRINTINGS = Object.freeze(Object.entries(CARDS).map(([key, c]) => printing(null, c, definitionFor.get(key))));
export const PRINTING = Object.freeze(Object.fromEntries(Object.entries(CARDS).map(([key, c]) => [key, `zh-Hans:${c.setCode}:${c.number}`])));
