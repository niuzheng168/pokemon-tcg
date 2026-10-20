// Preconstructed Simplified-Chinese decks for CN/V20261019 play. Every entry is
// an exact CN printing (set + number); totals are checked to be 60 cards.
import { OPEN_FORMAT, RULESET } from './common.mjs';
import { PRODUCT, PRINTING as P } from './csvh1c.mjs';
import { PRINTING as R } from './raging-bolt.mjs';

const STANDARD_FORMAT = Object.freeze({ ...RULESET, id: 'standard' });

export const DECKS = Object.freeze({
  'csvh1c-pikachu': {
    id: 'csvh1c-pikachu',
    name: '嗨皮组合 皮卡丘卡组',
    description: '皮卡丘ex 以「强劲伏特」为主攻，茸茸羊「电气发电机」从弃牌区为备战宝可梦加速。',
    // E/F marks are outside Standard (G/H/I/J); the unmodified product deck is played in Open.
    format: OPEN_FORMAT,
    sources: [
      { kind: 'official-product', url: PRODUCT.url, note: '官方商品页：嗨皮组合内含皮卡丘卡组（60张），2025-01-17 发售；页面亦描述该卡组的皮卡丘ex／茸茸羊战术。' },
      { kind: 'wiki-deck-list', title: '嗨皮组合 皮卡丘&皮皮&草苗龟&索财灵（TCG）', pageId: 277852, revision: 2553399,
        archive: '/nas/share/Pokemon/archives/52poke-2026.10.18.xml.gz',
        note: '神奇宝贝百科「主题牌组列表」皮卡丘卡组段：带①～㉓标注的条目与无标注条目合计为完整60张。' },
    ],
    cards: [
      [P.pikachuEx, 2], [P.chinchou, 2], [P.lanturn, 2], [P.mareep, 3], [P.flaaffy, 2], [P.emolga, 1],
      [P.thundurus, 1], [P.zeraora, 1], [P.chatot, 1],
      [P.energySearch, 1], [P.electricGenerator, 2], [P.trekkingShoes, 2], [P.nestBall, 2], [P.ultraBall, 4],
      [P.switch, 2], [P.pokemonCatcher, 2], [P.vitalityBand, 2],
      [P.judge, 1], [P.youngster, 3], [P.nemona, 4], [P.professorsResearch, 3], [P.cynthiasResolve, 2],
      [P.lightningEnergy, 15],
    ],
  },
  'raging-bolt-679141': {
    id: 'raging-bolt-679141',
    name: '猛雷鼓ex（2026城市赛第四赛季 上海 冠军卡表）',
    description: '猛雷鼓ex 以「极雷轰」弃置场上基本能量造成张数×70伤害；厄诡椪 碧草面具ex、奥琳博士的气魄与大地容器为其补充能量。',
    format: STANDARD_FORMAT,
    // Third-party aggregation of a CN tournament result; pokemon.cn does not
    // publish deck lists (WeChat mini-program only). Printings follow the
    // aggregator's official deck-code import and were each checked to exist.
    sources: [
      { kind: 'tournament-deck-list', url: 'https://omnitcg.top/api/v1/jz/deck/679141', retrievedOn: '2026-10-20',
        event: '2026城市赛第四赛季 – 赤饱潮玩卡牌（上海）', eventDate: '2026-09-27', placing: '1/256', player: 'Even',
        deckCode: '1YWQN15qdGfUr0xLTT', regulation: 'GHIJ',
        rankings: 'https://omnitcg.top/api/v1/jz/tournaments/3632/rankings',
        note: 'OmniTCG 汇总的简中城市赛结果；同一官方卡组码的卡表共用此记录（页面示例玩家为 Nuts.修王，青岛 2026-10-18）。卡表经第三方整理，印刷版本可能经其规范化。' },
    ],
    cards: [
      [R.ragingBoltEx, 3], [R.ragingBolt, 1], [R.ogerponEx, 3], [R.mewEx, 2], [R.squawkabillyEx, 2], [R.ironLeavesEx, 1],
      [R.chienPao, 1], [R.fezandipitiEx, 1], [R.latiasEx, 1], [R.slitherWing, 1], [R.ditto, 1],
      [R.ultraBall, 4], [P.nestBall, 4], [R.earthenVessel, 4], [R.nightStretcher, 2], [R.pokegear, 1], [R.palPad, 1],
      [R.superiorEnergyRetrieval, 1], [R.primeCatcher, 1], [R.sadasVitality, 4], [R.crispin, 3], [R.bossOrders, 2], [R.judge, 1],
      [R.areaZero, 3],
      [R.grassEnergy, 6], [R.lightningEnergy, 3], [R.fightingEnergy, 3],
    ],
  },
});

export function deckList(id) {
  const deck = DECKS[id];
  if (!deck) throw new RangeError(`Unknown CN deck: ${id}`);
  const list = deck.cards.flatMap(([printingId, count]) => Array(count).fill(printingId));
  if (list.length !== 60) throw new Error(`${id} must have exactly 60 cards, found ${list.length}.`);
  return list;
}
