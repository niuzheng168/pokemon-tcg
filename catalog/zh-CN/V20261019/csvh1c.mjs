// CSVH1C 嗨皮组合 皮卡丘卡组: the 23 distinct printings of that 60-card deck.
// Review standard (2026-10-21): every printed field below was read from the
// fingerprinted local card image (zoomed header and footer) and cross-checked
// with the same directory's metadata.json; disagreements resolve to the image.
// Printed glyphs: 雷 Lightning, 无 Colorless, 斗 Fighting. All weaknesses are ×2.
import { definitionBuilder, printing } from './common.mjs';

export const PRODUCT = Object.freeze({
  id: 'CSVH1',
  name: '宝可梦卡牌 嗨皮组合 皮卡丘&皮皮&草苗龟&索财灵',
  url: 'https://www.pokemon.cn/tcg/product/15585.html',
  // The official page announces the 朱&紫 series products and lists the four
  // 60-card decks of this box (and the single-deck 嗨皮卡组), on sale 2025-01-17.
  series: 'scarlet-violet', releasedOn: '2025-01-17',
  pageObservation: { retrievedOn: '2026-10-21', bytes: 79820,
    sha256: 'e781de33fde5ee8485b909672816cdb9f7456f2ee2e674f71ca9d055a99c964e' },
});
export const TEST_IDS = Object.freeze(['tests/cn-cards/csvh1c-pikachu.test.mjs']);

const MIK = 'https://tcg.mik.moe/static/img/CSVH1C/';
const lib = (dir, file, sha256, n) => ({ store: 'library_v1', path: `zh-Hans/CSVH1C/${dir}/${file}`, sha256, origin: `${MIK}${n}.png` });
const mik = (n, sha256) => ({ store: 'mik-full-20261019', path: `cards/CSVH1C/${n}/image.png`, sha256, origin: `${MIK}${n}.png` });
const card = (number, name, nameKey, mark, image) => ({ setCode: 'CSVH1C', number, name, nameKey, mark, image });

export const CARDS = Object.freeze({
  pikachuEx: card('008/059', '皮卡丘ex', 'pikachu-ex', 'G',
    lib('008', 'CSVH1C_008.png', 'd784d06b3a1f2d8cdbf4db59aec9a223bda35b140421ed7278a3435269d73731', '008')),
  chinchou: card('009/059', '灯笼鱼', 'chinchou', 'E',
    lib('009_059', 'CSVH1C_009_059.png', 'e533e47b5620db63a1666c2e3eb18ec836f498bc89894de5e16a6d2814069da2', '009')),
  lanturn: card('010/059', '电灯怪', 'lanturn', 'E',
    lib('010_059', 'CSVH1C_010_059.png', 'e5d2fd888baaf4633db21bb4010382ea2878ebdb9d38ca495139c5ef3324bc42', '010')),
  mareep: card('011/059', '咩利羊', 'mareep', 'E',
    lib('011_059', 'CSVH1C_011_059.png', '92587cb08bf0e6089fc15e7e9085ca3b042a99828d2fb70b5d8e4b6f4ea0fc27', '011')),
  flaaffy: card('012/059', '茸茸羊', 'flaaffy', 'E',
    lib('012', 'CSVH1C_012.png', '2c2878c2241e45e4ec2587b9bd7d381f8ddc7b40cade30d5c37430b9eb6a94fe', '012')),
  emolga: card('013/059', '电飞鼠', 'emolga', 'E',
    mik('013', '36f773dc9d6af2072f6d339a9a73f1af376f67a53430ca976acf971ec76cd6a3')),
  thundurus: card('014/059', '雷电云', 'thundurus', 'E',
    lib('014', 'CSVH1C_014.png', 'fe21c8376646ce75a1eb6531997a38fe1060194a759be5e100988b98cdf5b553', '014')),
  zeraora: card('015/059', '捷拉奥拉', 'zeraora', 'E',
    mik('015', 'a8cfd0eedd03c5233d2447192e5e78c6d42ba93b17e8170d7a509c2891cc8704')),
  chatot: card('032/059', '聒噪鸟', 'chatot', 'F',
    lib('032', 'CSVH1C_032.png', '95d4e981afed980469d21a8ce5c3f2a13c38b3adfb6ff3d0c6203ad6ea8a781f', '032')),
  energySearch: card('035/059', '能量输送', 'energy-search', 'G',
    lib('035_059', 'CSVH1C_035_059.png', '58a9baf2ae0b02ebfbc823abc3c9e75ab24e83557791e371dd230f9ca82602f2', '035')),
  electricGenerator: card('037/059', '电气发生器', 'electric-generator', 'G',
    lib('037_059', 'CSVH1C_037_059.png', '93ef1d67d2da1555fbb5aaf7021f9a17c521f52f14431d3c6a753b85a2d319b1', '037')),
  trekkingShoes: card('042/059', '健行鞋', 'trekking-shoes', 'F',
    lib('042', 'CSVH1C_042.png', 'c4e9bbfcf6dd9f47e0e5e1448734044fe34c2ba534be762d8938d27942f23542', '042')),
  nestBall: card('043/059', '巢穴球', 'nest-ball', 'G',
    lib('043_059', 'CSVH1C_043_059.png', 'd904b4f263c5c7b7fa99850ca117bcf3e054d09bcefdde75b221eb1c9b5bbb36', '043')),
  ultraBall: card('044/059', '高级球', 'ultra-ball', 'G',
    lib('044_059', 'CSVH1C_044_059.png', '8edcf1ad9bbaa430797de8c45b373e975aa06b6ba410504acab8848be37d0afe', '044')),
  switch: card('046/059', '宝可梦交替', 'switch', 'G',
    lib('046', 'CSVH1C_046.png', 'eac5921eb7513c75b0dc576d4ad1a68748c02753f72ca3a8ab3283fd67887b53', '046')),
  pokemonCatcher: card('047/059', '宝可梦捕捉器', 'pokemon-catcher', 'G',
    lib('047_059', 'CSVH1C_047_059.png', '372a73d453de457c0a9a0f6d61bec6e3d0fa8834b1f116539af6c6f4750cf0ee', '047')),
  vitalityBand: card('050/059', '活力头带', 'vitality-band', 'G',
    lib('050_059', 'CSVH1C_050_059.png', 'e64d3dffeeaa0ec33b2abf024c837f6cf1b635af59a5bac16501d40ef482f08e', '050')),
  judge: card('051/059', '裁判', 'judge', 'G',
    lib('051_059', 'CSVH1C_051_059.png', 'b6faf8371d3206c1aca210173e1881fe8ec0dbdd921537c91a59af162a3f83e6', '051')),
  youngster: card('053/059', '短裤小子', 'youngster', 'G',
    lib('053_059', 'CSVH1C_053_059.png', '839ba2ff40052c3734e0be6cc537046ac2baf939945b589446c2cc02771c4bd3', '053')),
  nemona: card('055/059', '妮莫', 'nemona', 'G',
    lib('055_059', 'CSVH1C_055_059.png', '4466f659b8fa3bc392bb0715bd92a9ae5000f3014d30d81dc72ffe4f42a904ca', '055')),
  // The printed name is 博士的研究; the 奥琳博士 subtitle is not name identity (CN format page).
  professorsResearch: card('056/059', '博士的研究', 'professors-research', 'G',
    lib('056_059', 'CSVH1C_056_059.png', 'b7719cad219a52b6c4dfaf9d85a47ebde3dac71c371919caeade7ceea75f1d0b', '056')),
  cynthiasResolve: card('057/059', '希嘉娜的决心', 'cynthias-resolve', 'E',
    lib('057', 'CSVH1C_057.png', '01f0c7a4692b177d07a71cc11c60336798ed8846315b2df94f61bdc2d0810e72', '057')),
  // Footer token LIG is the only identifier printed on this Basic Energy; no
  // regulation mark is visible. LIG is the deck list's and library's number.
  lightningEnergy: card('LIG', '基本雷能量', 'basic-lightning-energy', null,
    lib('LIG', 'CSVH1C_LIG.png', '37d89d2c17230db033d23ede36ae6c95937cdf8bdc44e46742bd9214165bd40c', 'LIG')),
});

// Printed rules text, transcribed from the reviewed images for presentation
// only. Execution comes from the reviewed handler bindings, never from text.
export const TEXTS = Object.freeze({
  pikachuEx: { 'topaz-bolt': '抛掷1次硬币如果为反面，则将这只宝可梦身上附着的能量，全部放于弃牌区。', rule: 'ex规则：当宝可梦ex昏厥时，对手将拿取2张奖赏卡。' },
  lanturn: { 'dazzling-beam': '在下一个对手的回合，受到这个招式影响的宝可梦在使用招式时，对手将抛掷1次硬币。如果为反面则那个招式失败。' },
  flaaffy: { dynamotor: '在自己的回合可以使用1次。选择自己弃牌区中的1张【雷】能量，附着于备战宝可梦身上。' },
  emolga: { thundershock: '抛掷1次硬币如果为正面，则使对手的战斗宝可梦陷入【麻痹】状态。' },
  thundurus: { 'assisting-flash': '若希望，可选择自己手牌中的1张【雷】能量，附着于备战宝可梦身上。', thunder: '给这只宝可梦也造成30点伤害。' },
  zeraora: { 'wild-volt': '给这只宝可梦也造成20点伤害。' },
  chatot: { 'cycle-draw': '将自己的1张手牌放于弃牌区。然后，从自己牌库上方抽取2张卡牌。' },
  energySearch: { card: '选择自己牌库中的1张基本能量，在给对手看过之后，加入手牌。并重洗牌库。' },
  electricGenerator: { card: '查看自己牌库上方5张卡牌，选择其中最多2张「基本【雷】能量」，以任意方式附着于备战区的【雷】宝可梦身上。将剩余的卡牌放回牌库并重洗牌库。' },
  trekkingShoes: { card: '查看自己牌库上方1张卡牌，将那张卡牌加入手牌。或者，将那张卡牌放于弃牌区，从自己牌库上方抽取1张卡牌。' },
  nestBall: { card: '选择自己牌库中的1张基础宝可梦，放于备战区。并重洗牌库。' },
  ultraBall: { card: '这张卡牌，只有将自己的2张手牌放于弃牌区后才可使用。选择自己牌库中的1张宝可梦，在给对手看过之后，加入手牌。并重洗牌库。' },
  switch: { card: '将自己的战斗宝可梦与备战宝可梦互换。' },
  pokemonCatcher: { card: '抛掷1次硬币如果为正面，则选择对手的1只备战宝可梦，将其与战斗宝可梦互换。' },
  vitalityBand: { card: '身上放有这张卡牌的宝可梦所使用的招式，给对手的战斗宝可梦造成的伤害「+10」。' },
  judge: { card: '双方玩家，各将所有手牌放回牌库并重洗牌库。然后，各从牌库上方抽取4张卡牌。' },
  youngster: { card: '将自己的手牌全部放回牌库并重洗牌库。然后，从牌库上方抽取5张卡牌。' },
  nemona: { card: '从自己牌库上方抽取3张卡牌。' },
  professorsResearch: { card: '将自己的手牌全部放于弃牌区，从牌库上方抽取7张卡牌。' },
  cynthiasResolve: { card: '这张卡牌，只有将自己的2张手牌放于弃牌区后才可使用。从自己的牌库上方抽取与对手场上宝可梦数量相同张数的卡牌。' },
});

const d = definitionBuilder(PRODUCT, TEST_IDS);
const id = (slug) => `cn:${slug}`;
const lightningSearch = (stages) => ({ kind: 'pokemon', ...(stages ? { stages } : {}) });
const ball = (to, selector, reveal) => ({ from: 'deck', to, selector, quantity: { kind: 'exact', count: 1 },
  reveal, lookTop: null, shuffleAfter: true });
const discardTwo = [{ costId: 'discard-2', kind: 'discardHand', count: 2, selector: { kind: 'any' } }];
const recoil = (amount) => ({ side: 'own', target: 'self', amount, selection: { kind: 'all' }, options: {} });

export const DEFINITIONS = Object.freeze([
  // 基础 HP190 雷；皮卡拳[无]30；强劲伏特[雷雷无]220 抛掷1次硬币如果为反面，则将这只宝可梦身上附着的能量，全部放于弃牌区。
  // 弱点 斗×2；抗性 无；撤退 0；宝可梦ex规则。
  d.pokemon(CARDS.pikachuEx, id('pokemon:pikachu-ex:csvh1c-008'), {
    stage: 'basic', hp: 190, type: '雷', weakness: '斗', retreat: 0, ex: true, attacks: [
      { key: 'pika-punch', name: '皮卡拳', cost: '无', damage: 30 },
      { key: 'topaz-bolt', name: '强劲伏特', cost: '雷雷无', damage: 220, effects: [['tails-discard', 'cn.coin@1', {
        outcome: 'tails', effect: { handlerId: 'cn.attachedEnergy@1', parameters: {
          op: 'discardEnergy', side: 'own', from: 'self', selector: { kind: 'energy' }, providedTypes: null,
          measure: 'cards', quantity: { kind: 'all' }, chooser: 'source',
        } },
      }]] },
    ],
  }),
  // 基础 HP70；电球[雷]10；弱点 斗×2；撤退 1。
  d.pokemon(CARDS.chinchou, id('pokemon:chinchou:csvh1c-009'), {
    stage: 'basic', hp: 70, type: '雷', weakness: '斗', retreat: 1,
    attacks: [{ key: 'electro-ball', name: '电球', cost: '雷', damage: 10 }],
  }),
  // 1阶进化（从灯笼鱼进化）HP120；炫目光束[雷无]40 在下一个对手的回合，受到这个招式影响的宝可梦在使用招式时，
  // 对手将抛掷1次硬币。如果为反面则那个招式失败。电球[雷雷无]120；弱点 斗×2；撤退 2。
  d.pokemon(CARDS.lanturn, id('pokemon:lanturn:csvh1c-010'), {
    stage: 'stage1', evolvesFrom: 'chinchou', hp: 120, type: '雷', weakness: '斗', retreat: 2, attacks: [
      { key: 'dazzling-beam', name: '炫目光束', cost: '雷无', damage: 40, effects: [['attack-check', 'cn.lasting@1', {
        side: 'opponent', target: 'active', duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true,
        effect: { op: 'attackCheck', scope: 'all', coin: { mode: 'fixed', count: 1, minimumHeads: 1 } },
      }]] },
      { key: 'electro-ball', name: '电球', cost: '雷雷无', damage: 120 },
    ],
  }),
  // 基础 HP60；后踢[无]10；电球[雷无]30；弱点 斗×2；撤退 1。
  d.pokemon(CARDS.mareep, id('pokemon:mareep:csvh1c-011'), {
    stage: 'basic', hp: 60, type: '雷', weakness: '斗', retreat: 1, attacks: [
      { key: 'back-kick', name: '后踢', cost: '无', damage: 10 },
      { key: 'electro-ball', name: '电球', cost: '雷无', damage: 30 },
    ],
  }),
  // 1阶进化（从咩利羊进化）HP90；特性 电气发电机：在自己的回合可以使用1次。选择自己弃牌区中的1张【雷】能量，
  // 附着于备战宝可梦身上。电球[雷雷无]50；弱点 斗×2；撤退 2。
  d.pokemon(CARDS.flaaffy, id('pokemon:flaaffy:csvh1c-012'), {
    stage: 'stage1', evolvesFrom: 'mareep', hp: 90, type: '雷', weakness: '斗', retreat: 2,
    abilities: [{ key: 'dynamotor', name: '电气发电机', mode: 'activated',
      usage: { period: 'turn', scope: 'pokemon', key: 'cn:flaaffy:dynamotor', limit: 1 },
      effects: [['attach', 'cn.attachDiscard@1', { type: 'Lightning', count: 1, benchOnly: true, optional: false }]] }],
    attacks: [{ key: 'electro-ball', name: '电球', cost: '雷雷无', damage: 50 }],
  }),
  // 基础 HP70；电击[雷]30 抛掷1次硬币如果为正面，则使对手的战斗宝可梦陷入麻痹状态。弱点 斗×2；撤退 0。
  d.pokemon(CARDS.emolga, id('pokemon:emolga:csvh1c-013'), {
    stage: 'basic', hp: 70, type: '雷', weakness: '斗', retreat: 0, attacks: [
      { key: 'thundershock', name: '电击', cost: '雷', damage: 30, effects: [['heads-paralysis', 'cn.coin@1', {
        outcome: 'heads', effect: { handlerId: 'cn.condition@1', parameters: { side: 'opponent', condition: 'paralyzed' } },
      }]] },
    ],
  }),
  // 基础 HP120；辅助电光[雷]30 若希望，可选择自己手牌中的1张【雷】能量，附着于备战宝可梦身上。
  // 打雷[雷雷无]130 给这只宝可梦也造成30点伤害。弱点 斗×2；撤退 1。
  d.pokemon(CARDS.thundurus, id('pokemon:thundurus:csvh1c-014'), {
    stage: 'basic', hp: 120, type: '雷', weakness: '斗', retreat: 1, attacks: [
      { key: 'assisting-flash', name: '辅助电光', cost: '雷', damage: 30,
        effects: [['attach', 'cn.attachHand@1', { type: 'Lightning', count: 1, benchOnly: true, optional: true }]] },
      { key: 'thunder', name: '打雷', cost: '雷雷无', damage: 130, effects: [['recoil', 'cn.recoilDamage@1', recoil(30)]] },
    ],
  }),
  // 基础 HP120；疯狂伏特[雷无]70 给这只宝可梦也造成20点伤害。弱点 斗×2；撤退 1。
  d.pokemon(CARDS.zeraora, id('pokemon:zeraora:csvh1c-015'), {
    stage: 'basic', hp: 120, type: '雷', weakness: '斗', retreat: 1, attacks: [
      { key: 'wild-volt', name: '疯狂伏特', cost: '雷无', damage: 70, effects: [['recoil', 'cn.recoilDamage@1', recoil(20)]] },
    ],
  }),
  // 基础 HP70 无色；循环抽取[无] 将自己的1张手牌放于弃牌区。然后，从自己牌库上方抽取2张卡牌。振翅[无]10；
  // 弱点 雷×2；抗性 斗-30；撤退 0。
  d.pokemon(CARDS.chatot, id('pokemon:chatot:csvh1c-032'), {
    stage: 'basic', hp: 70, type: '无', weakness: '雷', resistance: ['斗', 30], retreat: 0, attacks: [
      { key: 'cycle-draw', name: '循环抽取', cost: '无', damage: null, effects: [['discard-then-draw', 'cn.cardsThenDraw@1', {
        cards: { from: 'hand', to: 'discard', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 1 },
          reveal: false, lookTop: null, shuffleAfter: false },
        draw: 2,
      }]] },
      { key: 'flap', name: '振翅', cost: '无', damage: 10 },
    ],
  }),
  // 物品：选择自己牌库中的1张基本能量，在给对手看过之后，加入手牌。并重洗牌库。
  d.trainer(CARDS.energySearch, id('trainer:energy-search'), 'item', [
    ['search', 'cn.cards@1', ball('hand', { kind: 'energy', category: 'basic' }, true)],
  ]),
  // 物品：查看自己牌库上方5张卡牌，选择其中最多2张「基本【雷】能量」，以任意方式附着于备战区的【雷】宝可梦身上。
  // 将剩余的卡牌放回牌库并重洗牌库。
  d.trainer(CARDS.electricGenerator, id('trainer:electric-generator'), 'item', [
    ['attach', 'cn.attachDeckEnergy@1', {
      op: 'attachDeckEnergy', lookTop: 5, selector: { kind: 'energy', category: 'basic', types: ['Lightning'] },
      quantity: { kind: 'upTo', count: 2 }, recipient: { position: 'bench', selector: { kind: 'pokemon', types: ['Lightning'] } },
      distribution: 'separateRecipients', remainder: 'shuffleDeck', reveal: false,
    }],
  ]),
  // 物品：查看自己牌库上方1张卡牌，将那张卡牌加入手牌。或者，将那张卡牌放于弃牌区，从自己牌库上方抽取1张卡牌。
  d.trainer(CARDS.trekkingShoes, id('trainer:trekking-shoes'), 'item', [
    ['look', 'cn.orElse@1', {
      first: { handlerId: 'cn.cards@1', parameters: { from: 'deck', to: 'hand', selector: { kind: 'any' },
        quantity: { kind: 'any' }, reveal: false, lookTop: 1, shuffleAfter: false } },
      otherwise: { handlerId: 'cn.cardsThenDraw@1', parameters: {
        cards: { from: 'deck', to: 'discard', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 1 },
          reveal: false, lookTop: 1, shuffleAfter: false },
        draw: 1,
      } },
    }],
  ]),
  // 物品：选择自己牌库中的1张基础宝可梦，放于备战区。并重洗牌库。
  d.trainer(CARDS.nestBall, id('trainer:nest-ball'), 'item', [
    ['search', 'cn.cards@1', ball('bench', lightningSearch(['basic']), false)],
  ]),
  // 物品：这张卡牌，只有将自己的2张手牌放于弃牌区后才可使用。选择自己牌库中的1张宝可梦，在给对手看过之后，加入手牌。并重洗牌库。
  d.trainer(CARDS.ultraBall, id('trainer:ultra-ball'), 'item', [
    ['search', 'cn.cards@1', ball('hand', lightningSearch(), true)],
  ], discardTwo),
  // 物品：将自己的战斗宝可梦与备战宝可梦互换。
  d.trainer(CARDS.switch, id('trainer:switch'), 'item', [
    ['switch', 'cn.switch@1', { side: 'own', chooser: 'self', affected: 'active' }],
  ]),
  // 物品：抛掷1次硬币如果为正面，则选择对手的1只备战宝可梦，将其与战斗宝可梦互换。
  d.trainer(CARDS.pokemonCatcher, id('trainer:pokemon-catcher'), 'item', [
    ['gust', 'cn.coin@1', { outcome: 'heads',
      effect: { handlerId: 'cn.switch@1', parameters: { side: 'opponent', chooser: 'self', affected: 'selected' } } }],
  ]),
  // 宝可梦道具：身上放有这张卡牌的宝可梦所使用的招式，给对手的战斗宝可梦造成的伤害「+10」。
  d.trainer(CARDS.vitalityBand, id('trainer:vitality-band'), 'tool', [
    ['damage', 'cn.modifier@1', { field: 'attackDamage', amount: 10, scope: 'self', targetSide: 'opponent', targetPosition: 'active' }],
  ]),
  // 支援者：双方玩家，各将所有手牌放回牌库并重洗牌库。然后，各从牌库上方抽取4张卡牌。
  d.trainer(CARDS.judge, id('trainer:judge'), 'supporter', [
    ['hand-deck-draw', 'cn.handDeckDraw@1', { side: 'both', ownDraw: 4, opponentDraw: 4 }],
  ]),
  // 支援者：将自己的手牌全部放回牌库并重洗牌库。然后，从牌库上方抽取5张卡牌。
  d.trainer(CARDS.youngster, id('trainer:youngster'), 'supporter', [
    ['hand-deck-draw', 'cn.handDeckDraw@1', { side: 'own', ownDraw: 5, opponentDraw: 0 }],
  ]),
  // 支援者：从自己牌库上方抽取3张卡牌。
  d.trainer(CARDS.nemona, id('trainer:nemona'), 'supporter', [['draw', 'cn.draw@1', { count: 3 }]]),
  // 支援者：将自己的手牌全部放于弃牌区，从牌库上方抽取7张卡牌。（无「然后」：两项分别执行。）
  d.trainer(CARDS.professorsResearch, id('trainer:professors-research'), 'supporter', [
    ['discard-hand', 'cn.discardHand@1', {}], ['draw', 'cn.draw@1', { count: 7 }],
  ]),
  // 支援者：这张卡牌，只有将自己的2张手牌放于弃牌区后才可使用。从自己的牌库上方抽取与对手场上宝可梦数量相同张数的卡牌。
  d.trainer(CARDS.cynthiasResolve, id('trainer:cynthias-resolve'), 'supporter', [
    ['draw', 'cn.drawPokemonCount@1', { side: 'opponent' }],
  ], discardTwo),
  d.basicEnergy(CARDS.lightningEnergy, id('energy:basic-lightning'), '雷'),
]);

const definitionFor = new Map(Object.entries(CARDS).map(([key, c], index) => {
  if (DEFINITIONS[index].name !== c.name) throw new Error(`Card/definition order mismatch at ${c.number}`);
  return [key, DEFINITIONS[index].definitionId];
}));
export const PRINTINGS = Object.freeze(Object.entries(CARDS).map(([key, c]) => printing(PRODUCT, c, definitionFor.get(key))));
export const PRINTING = Object.freeze(Object.fromEntries(Object.entries(CARDS).map(([key, c]) => [key, `zh-Hans:${c.setCode}:${c.number}`])));
