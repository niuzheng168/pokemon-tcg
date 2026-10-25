// Milestone 3, batch 2: the most-played Trainer cards of recent CN city leagues
// not yet in the pool (survey in docs/rules/zh-CN/V20261019/cards/STAPLES-REVIEW.md).
// Review standard (2026-10-21): every printed field below was read from the
// fingerprinted local card image and cross-checked with the same directory's
// metadata.json; disagreements resolve to the image.
import { definitionBuilder, printing } from './common.mjs';
import { PRODUCT as CSVH1C } from './csvh1c.mjs';
import { PRODUCTS as EARLIER } from './dragapult.mjs';

const page = (bytes, sha256) => ({ retrievedOn: '2026-10-21', bytes, sha256 });
export const PRODUCTS = Object.freeze({
  ...EARLIER, CSVH1C,
  // 52poke `alt = CSVH6C` and the MIK set record agree with this page (four 60-card decks, 2026-10-16).
  CSVH6C: { id: 'CSVH6', name: '宝可梦卡牌 嗨皮组合 训练家的宝可梦', url: 'https://www.pokemon.cn/tcg/product/23939.html',
    series: 'scarlet-violet', releasedOn: '2026-10-16', pageObservation: page(71205, '58afb87083e3c0eed16ec31ede159b7b02635331d26d817d8193de9a916d67df') },
});
export const PRODUCT = null;
export const TEST_IDS = Object.freeze(['tests/cn-cards/staples.test.mjs']);

const MIK = 'https://tcg.mik.moe/static/img/';
const lib = (set, dir, sha256, n = dir.split('_')[0]) => ({ store: 'library_prod', path: `zh-Hans/${set}/${dir}/${set}_${dir}.png`, sha256,
  origin: `${MIK}${set}/${n}.png` });
const card = (set, number, name, nameKey, mark, image) => ({ product: PRODUCTS[set], setCode: set, number, name, nameKey, mark, image });

export const CARDS = Object.freeze({
  rareCandy: card('CSVH1C', '045/059', '神奇糖果', 'rare-candy', 'G',
    lib('CSVH1C', '045_059', '48cfc6f360358de339cd5a2a7426c33742149f14a0cdd9f3056e1caf51503500')),
  arven: card('CSV1C', '123/127', '派帕', 'arven', 'G',
    lib('CSV1C', '123_127', '1e0a81775b424f3af227d4289c4ff288c2c86700624d9d742b86e0b6968e4f7b')),
  braveryCharm: card('CSV1C', '118/127', '勇气护符', 'bravery-charm', 'G',
    lib('CSV1C', '118_127', '57fcf6b06def16761c81dd9ecbcfce744c752c76ea281c506a53d1ed35d4a2b0')),
  secretBox: card('CSV8C', '176/207', '秘密箱', 'secret-box', 'H',
    lib('CSV8C', '176_207', '87c56831ca87911634c1ef8cea4324078d00e34474504331a2451111dc25e2c9')),
  // The face is under CSV1C/109 (109_127 holds only an unconverted wiki record).
  superRod: card('CSV1C', '109/127', '厉害钓竿', 'super-rod', 'G', lib('CSV1C', '109',
    'c609c22acef6e718fd53f45c55d4bf2ce40036374d29745ff88fbd7576722ced')),
  // Subtitle 奥琳博士 is not name identity; same text as CSVH1C 056 博士的研究.
  professorsResearch: card('CSV1C', '121/127', '博士的研究', 'professors-research', 'G',
    lib('CSV1C', '121_127', 'b47e95bf4943fbf21a4cd8749733a8fc836b34613f6becad924a5624249fe539')),
  // The image shows mark I (metadata says J; 101/103 beside it is I as well).
  switch: card('30thC', '103/103', '宝可梦交替', 'switch', 'I',
    lib('30thC', '103_103', '0ff0621e6381de7e4413923f3a42c4fe0f5b2f9f346b9147294569945c2777e5')),
  energySwitch: card('CSVH6C', '031/054', '能量转移', 'energy-switch', 'I', lib('CSVH6C', '031',
    'b1341faa315f40aabbc4c30210e7105032328bf0e205b98c0bd5ad9aeb15d5d8')),
  artazon: card('CSV2C', '127/128', '深钵镇', 'artazon', 'G',
    lib('CSV2C', '127_128', 'db62cf795faed6998d00b8149e154c93c3e2cb11c58caada0dc2da570b4e1a01')),
  gravityMountain: card('CSV7C', '201/204', '重力山', 'gravity-mountain', 'H',
    lib('CSV7C', '201_204', '77ecbacbbdedc0cef565d7466d7c6737ca6b150053f13b6afaeeb6533ed25a4c')),
  energyRetrieval: card('CSVH1C', '034/059', '能量回收', 'energy-retrieval', 'G', lib('CSVH1C', '034',
    '5b36616d6ef28bf817891619361d9eb9090ac4d646838d8e5c13de26bc9c9500')),
  // CSV9C/198_208 is a wiki record that drops 「ex」; the face and MIK record are under CSV9C/198.
  cyrano: card('CSV9C', '198/208', '席蓝', 'cyrano', 'H', lib('CSV9C', '198',
    '465846599e6478260e9c2e388f9cae53191c667251ff266c110471de09ed69ab')),
  picnicBasket: card('CSV3C', '117/130', '野餐篮', 'picnic-basket', 'G',
    lib('CSV3C', '117_130', 'f7a27bd68b54725c7e63a95c544d7c1a8103f32a9fabefdf6605a4209717912e')),
});

// Printed rules text, transcribed from the reviewed images for presentation only.
export const TEXTS = Object.freeze({
  rareCandy: { card: '选择自己手牌中的1张2阶进化宝可梦，放于自己场上能够进化成该宝可梦的基础宝可梦身上，跳过1阶进化进行进化。（在自己最初的回合，以及对这个回合刚出场的宝可梦无法使用。）' },
  arven: { card: '选择自己牌库中「物品」和「宝可梦道具」各1张，在给对手看过之后，加入手牌。并重洗牌库。' },
  braveryCharm: { card: '身上放有这张卡牌的基础宝可梦的最大HP「+50」。' },
  secretBox: { card: '这张卡牌，只有将自己的3张手牌放于弃牌区后才可使用。选择自己牌库中「物品」「宝可梦道具」「支援者」「竞技场」各1张，在给对手看过之后，加入手牌。并重洗牌库。',
    rule: 'ACE SPEC：在1副卡组中只能放入1张ACE SPEC卡。' },
  superRod: { card: '选择自己弃牌区中的宝可梦和基本能量合计最多3张，在给对手看过之后，放回牌库并重洗牌库。' },
  professorsResearch: { card: '将自己的手牌全部放于弃牌区，从牌库上方抽取7张卡牌。' },
  switch: { card: '将自己的战斗宝可梦与备战宝可梦互换。' },
  energySwitch: { card: '选择自己场上的宝可梦身上附着的1个基本能量，转附于自己的其他宝可梦身上。' },
  artazon: { card: '双方玩家，每次在自己的回合有1次机会，可选择自己牌库中的1张基础宝可梦（除「拥有规则的宝可梦」外），放于备战区。并重洗牌库。' },
  gravityMountain: { card: '双方场上的所有2阶进化宝可梦的最大HP，各「-30」。' },
  energyRetrieval: { card: '选择自己弃牌区中最多2张基本能量，在给对手看过之后，加入手牌。' },
  cyrano: { card: '选择自己牌库中最多3张「宝可梦ex」，在给对手看过之后，加入手牌。并重洗牌库。' },
  picnicBasket: { card: '将双方所有宝可梦的HP，各回复「30」。' },
});

const d = definitionBuilder(null, TEST_IDS);
const id = (slug) => `cn:${slug}`;
const trainer = (category) => ({ kind: 'trainer', categories: [category] });
const search = (categories) => ({ from: 'deck', to: 'hand', selector: { anyOf: categories.map(trainer) },
  quantity: { kind: 'exact', count: categories.length }, onePerAlternative: true, reveal: true, lookTop: null, shuffleAfter: true });
const heal = (side) => ({ op: 'healPokemon', side, target: 'any', selector: { kind: 'pokemon' }, selection: { kind: 'all' }, amount: 30,
  discardHealedEnergy: false });

export const DEFINITIONS = Object.freeze([
  // 物品：选择自己手牌中的1张【2阶进化】宝可梦，放于自己场上能够进化成该宝可梦的【基础】宝可梦身上，跳过【1阶进化】进行进化。
  // （在自己最初的回合，以及对这个回合刚出场的宝可梦无法使用。）
  d.trainer(CARDS.rareCandy, id('trainer:rare-candy'), 'item', [
    ['evolve', 'cn.pokemonTransition@1', { op: 'evolvePokemon', target: 'any', targetSelector: { kind: 'pokemon', stages: ['basic'] },
      from: 'hand', selector: { kind: 'pokemon', stages: ['stage2'] }, relation: 'skipStage1',
      timing: { firstOwnTurn: 'forbid', enteredThisTurn: 'forbid', evolvedThisTurn: 'allow' }, shuffleAfter: false }],
  ]),
  // 支援者：选择自己牌库中「物品」和「宝可梦道具」各1张，在给对手看过之后，加入手牌。并重洗牌库。
  d.trainer(CARDS.arven, id('trainer:arven'), 'supporter', [['search', 'cn.cards@1', search(['item', 'tool'])]]),
  // 宝可梦道具：身上放有这张卡牌的【基础】宝可梦的最大HP「+50」。
  d.trainer(CARDS.braveryCharm, id('trainer:bravery-charm'), 'tool', [
    ['hp', 'cn.modifier@1', { field: 'hp', amount: 50, scope: 'self', stages: ['basic'] }],
  ]),
  // 物品 ACE SPEC：只有将自己的3张手牌放于弃牌区后才可使用。选择自己牌库中「物品」「宝可梦道具」「支援者」「竞技场」各1张，
  // 在给对手看过之后，加入手牌。并重洗牌库。
  d.trainer(CARDS.secretBox, id('trainer:secret-box'), 'item', [['search', 'cn.cards@1', search(['item', 'tool', 'supporter', 'stadium'])]],
    [{ costId: 'discard-3', kind: 'discardHand', count: 3, selector: { kind: 'any' } }], { aceSpec: true }),
  // 物品：选择自己弃牌区中的宝可梦和基本能量合计最多3张，在给对手看过之后，放回牌库并重洗牌库。
  d.trainer(CARDS.superRod, id('trainer:super-rod'), 'item', [
    ['return', 'cn.cards@1', { from: 'discard', to: 'deck', selector: { anyOf: [{ kind: 'pokemon' }, { kind: 'energy', category: 'basic' }] },
      quantity: { kind: 'upTo', count: 3 }, reveal: true, lookTop: null, shuffleAfter: true }],
  ]),
  // 物品：选择自己场上的宝可梦身上附着的1个基本能量，转附于自己的其他宝可梦身上。
  d.trainer(CARDS.energySwitch, id('trainer:energy-switch'), 'item', [
    ['move', 'cn.attachedEnergy@1', { op: 'moveEnergy', side: 'own', from: 'any', selector: { kind: 'energy', category: 'basic' },
      providedTypes: null, measure: 'cards', quantity: { kind: 'exact', count: 1 }, chooser: 'source',
      recipient: { position: 'any', selector: { kind: 'pokemon' } }, distribution: 'singleRecipient' }],
  ]),
  // 竞技场：双方玩家，每次在自己的回合有1次机会，可选择自己牌库中的1张【基础】宝可梦（除「拥有规则的宝可梦」外），放于备战区。并重洗牌库。
  d.trainer(CARDS.artazon, id('trainer:artazon'), 'stadium', [
    ['use', 'cn.stadiumUse@1', { key: 'cn:stadium-use:artazon', effect: { handlerId: 'cn.cards@1', parameters: { from: 'deck', to: 'bench',
      selector: { kind: 'pokemon', stages: ['basic'], ruleBox: false }, quantity: { kind: 'exact', count: 1 }, reveal: false, lookTop: null,
      shuffleAfter: true } } }],
  ]),
  // 竞技场：双方场上的所有【2阶进化】宝可梦的最大HP，各「-30」。
  d.trainer(CARDS.gravityMountain, id('trainer:gravity-mountain'), 'stadium', [
    ['hp', 'cn.modifier@1', { field: 'hp', amount: -30, scope: 'all', stages: ['stage2'] }],
  ]),
  // 物品：选择自己弃牌区中最多2张基本能量，在给对手看过之后，加入手牌。
  d.trainer(CARDS.energyRetrieval, id('trainer:energy-retrieval'), 'item', [
    ['recover', 'cn.cards@1', { from: 'discard', to: 'hand', selector: { kind: 'energy', category: 'basic' }, quantity: { kind: 'upTo', count: 2 },
      reveal: true, lookTop: null, shuffleAfter: false }],
  ]),
  // 支援者：选择自己牌库中最多3张「宝可梦ex」，在给对手看过之后，加入手牌。并重洗牌库。
  d.trainer(CARDS.cyrano, id('trainer:cyrano'), 'supporter', [
    ['search', 'cn.cards@1', { from: 'deck', to: 'hand', selector: { kind: 'pokemon', tagsAll: ['ex'] }, quantity: { kind: 'upTo', count: 3 },
      reveal: true, lookTop: null, shuffleAfter: true }],
  ]),
  // 物品：将双方所有宝可梦的HP，各回复「30」。（两个回复步骤之间没有可插入的效果，与同时回复相同。）
  d.trainer(CARDS.picnicBasket, id('trainer:picnic-basket'), 'item', [
    ['heal-own', 'cn.healPokemon@1', heal('own')], ['heal-opponent', 'cn.healPokemon@1', heal('opponent')],
  ]),
]);

// Printings of names already defined in csvh1c.mjs bind those definitions.
const SHARED = Object.freeze({ professorsResearch: id('trainer:professors-research'), switch: id('trainer:switch') });
const definitionFor = new Map(Object.entries(CARDS).map(([key, c]) => {
  if (SHARED[key]) return [key, SHARED[key]];
  const found = DEFINITIONS.find((x) => x.nameKey === c.nameKey);
  if (!found || found.name !== c.name) throw new Error(`No reviewed definition for ${c.setCode} ${c.number}`);
  return [key, found.definitionId];
}));
export const PRINTINGS = Object.freeze(Object.entries(CARDS).map(([key, c]) => printing(null, c, definitionFor.get(key))));
export const PRINTING = Object.freeze(Object.fromEntries(Object.entries(CARDS).map(([key, c]) => [key, `zh-Hans:${c.setCode}:${c.number}`])));
