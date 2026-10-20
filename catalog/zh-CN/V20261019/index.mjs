// Reviewed CN/V20261019 card pool and decks. The release builder turns this
// authoring data into public/data/cn/V20261019/release.json plus a trust pin.
import * as csvh1c from './csvh1c.mjs';
import * as ragingBolt from './raging-bolt.mjs';
export { RULESET, OPEN_FORMAT, REVIEWED_ON, IMAGE_STORES } from './common.mjs';
export { DECKS, deckList } from './decks.mjs';

export const SETS = Object.freeze([csvh1c, ragingBolt]);
export const DEFINITIONS = Object.freeze(SETS.flatMap((set) => set.DEFINITIONS));
export const PRINTINGS = Object.freeze(SETS.flatMap((set) => set.PRINTINGS));
export const REVIEW_RECORDS = Object.freeze(SETS.flatMap((set) => Object.values(set.CARDS).map((card) => ({
  printingId: `zh-Hans:${card.setCode}:${card.number}`, name: card.name, image: card.image, product: (card.product ?? set.PRODUCT).url,
}))));
// Presentation data for the website: names, transcribed text and local image paths.
export const PRESENTATION = Object.freeze(Object.fromEntries(SETS.flatMap((set) => Object.entries(set.CARDS).map(([key, card]) => [
  `zh-Hans:${card.setCode}:${card.number}`,
  { name: card.name, setCode: card.setCode, number: card.number, mark: card.mark, texts: set.TEXTS[key] ?? {},
    image: `img/cn-cards/${card.setCode}/${card.number.replace('/', '-')}.png` },
]))));
// Every official product page cited by a reviewed printing, once each.
export const PRODUCTS = Object.freeze([...new Map(SETS.flatMap((set) => Object.values(set.CARDS)
  .map((card) => card.product ?? set.PRODUCT)).map((product) => [product.id, product])).values()]);
export const TEST_IDS = Object.freeze([...new Set(SETS.flatMap((set) => set.TEST_IDS))]);
