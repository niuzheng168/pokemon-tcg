// Preconstructed Simplified-Chinese decks for CN/V20261019 play. Every entry is
// an exact CN printing (set + number); totals are checked to be 60 cards.
import { OPEN_FORMAT } from './common.mjs';
import { PRODUCT, PRINTING as P } from './csvh1c.mjs';

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
});

export function deckList(id) {
  const deck = DECKS[id];
  if (!deck) throw new RangeError(`Unknown CN deck: ${id}`);
  const list = deck.cards.flatMap(([printingId, count]) => Array(count).fill(printingId));
  if (list.length !== 60) throw new Error(`${id} must have exactly 60 cards, found ${list.length}.`);
  return list;
}
