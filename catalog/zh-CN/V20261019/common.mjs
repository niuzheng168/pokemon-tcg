// Shared builders for reviewed CN/V20261019 card data. These produce plain
// CardDefinition / CardPrinting JSON; approval happens only through the release
// manifest and the separately installed trust pin (see scripts/build-cn-release.mjs).
export const RULESET = Object.freeze({ region: 'CN', version: 'V20261019' });
export const OPEN_FORMAT = Object.freeze({ region: 'CN', version: 'V20261019', id: 'open' });
export const REVIEWED_ON = '2026-10-21';
// Local stores used for the face review (read-only NAS). A few cards exist only
// in the MIK archive, not yet in library_v1; the record names its actual store.
export const IMAGE_STORES = Object.freeze({
  library_v1: '/nas/share/Pokemon/library_v1',
  'mik-full-20261019': '/nas/share/Pokemon/archives/pokemon-cards-mik-20261019/mik-full-20261019',
});

const TYPES = { 草: 'Grass', 火: 'Fire', 水: 'Water', 雷: 'Lightning', 超: 'Psychic', 斗: 'Fighting', 恶: 'Darkness', 钢: 'Metal', 妖: 'Fairy', 龙: 'Dragon', 无: 'Colorless' };
export const type = (glyph) => {
  if (!Object.hasOwn(TYPES, glyph)) throw new TypeError(`Unknown printed type glyph: ${glyph}`);
  return TYPES[glyph];
};
export const cost = (glyphs) => [...glyphs].map(type);

/**
 * One card-face evidence entry. The official page fixes the product and its
 * release; the printed text itself was read from the fingerprinted local image.
 */
export function cardEvidence(product, card) {
  return [{
    sourceId: `cn-card-face:${card.setCode}:${card.number.replace('/', '-')}`,
    kind: 'official-card',
    url: product.url,
    locator: `${product.name} ${card.setCode} ${card.number} ${card.name}：卡面文字逐项核对本机卡图 ` +
      `${card.image.store}/${card.image.path}（SHA-256 ${card.image.sha256}，图源 ${card.image.origin}）及同目录 metadata.json；` +
      `官方商品页确认所属商品「${product.name}」与发售日 ${product.releasedOn}。`,
    observedOn: REVIEWED_ON,
  }];
}

export function definitionBuilder(product, testIds) {
  const base = (card, id, kind, mechanics, deckLimits = { sameName: 4, groups: [] }) => {
    const sourceOfTruth = cardEvidence(product, card);
    return {
      schemaVersion: '1.0.0', definitionId: id, ruleset: { ...RULESET }, name: card.name, nameKey: card.nameKey, kind,
      sourceOfTruth, implementation: { status: 'verified', testIds: [...testIds] }, deckLimits, mechanics,
    };
  };
  const bind = (id, card) => (key, handlerId, parameters) => ({
    effectId: `${id}:${key}`, handlerId, parameters, sourceOfTruth: cardEvidence(product, card),
  });
  return {
    pokemon(card, id, m) {
      const b = bind(id, card), ev = cardEvidence(product, card);
      return base(card, id, 'pokemon', {
        stage: m.stage, evolvesFrom: m.evolvesFrom ?? null, hp: m.hp, types: [type(m.type)],
        weakness: m.weakness ? { type: type(m.weakness), operation: 'multiply', value: 2 } : null,
        resistance: m.resistance ? { type: type(m.resistance[0]), value: m.resistance[1] } : null,
        retreatCost: m.retreat,
        attacks: m.attacks.map((a) => ({
          attackId: `${id}:${a.key}`, name: a.name, cost: cost(a.cost),
          printedDamage: a.damage === null ? null : { value: a.damage, operator: 'fixed' },
          effects: (a.effects ?? []).map(([key, handlerId, parameters]) => b(`${a.key}:${key}`, handlerId, parameters)),
          sourceOfTruth: ev,
        })),
        abilities: (m.abilities ?? []).map((a) => ({
          abilityId: `${id}:${a.key}`, name: a.name, mode: a.mode, usage: a.usage,
          effects: a.effects.map(([key, handlerId, parameters]) => b(`${a.key}:${key}`, handlerId, parameters)),
          sourceOfTruth: ev,
        })),
        ruleBox: !!m.ex, prizeCount: m.ex ? 2 : 1, tags: m.ex ? ['ex'] : [], effects: [],
      });
    },
    trainer(card, id, category, effects, playCosts = null) {
      const b = bind(id, card);
      return base(card, id, 'trainer', {
        category, effects: effects.map(([key, handlerId, parameters]) => b(key, handlerId, parameters)),
        ...(playCosts ? { playCosts: playCosts.map((c) => ({ ...c, sourceOfTruth: cardEvidence(product, card) })) } : {}),
      });
    },
    basicEnergy(card, id, energyType) {
      return base(card, id, 'energy', { category: 'basic', baseUnits: [[type(energyType)]], effects: [] },
        { sameName: null, groups: [] });
    },
  };
}

export function printing(product, card, definitionId) {
  return {
    schemaVersion: '1.0.0', printingId: `zh-Hans:${card.setCode}:${card.number}`, game: 'tcg', language: 'zh-Hans',
    setCode: card.setCode, number: card.number, regulationMark: card.mark, series: product.series,
    releasedOn: product.releasedOn, identityReview: 'verified',
    definitionBindings: [{ ruleset: { ...RULESET }, definitionId, sourceOfTruth: cardEvidence(product, card) }],
    metadataRefs: [{ provider: 'other', id: `${card.image.store}:${card.image.path.replace(/\/[^/]+$/, '')}`,
      revision: `image-sha256:${card.image.sha256}` }],
  };
}
