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

// II.D-08 「所有属性的能量」: the ten Energy types (no Dragon), as the kernel defines them.
export { ENERGY_TYPES as ALL_ENERGY_TYPES } from '../../../public/rules/damage.js';
import { ACE_SPEC_GROUP } from '../../../public/rules/card-selection.js';

const TYPES = { 草: 'Grass', 火: 'Fire', 水: 'Water', 雷: 'Lightning', 超: 'Psychic', 斗: 'Fighting', 恶: 'Darkness', 钢: 'Metal', 妖: 'Fairy', 龙: 'Dragon', 无: 'Colorless' };
export const type = (glyph) => {
  if (!Object.hasOwn(TYPES, glyph)) throw new TypeError(`Unknown printed type glyph: ${glyph}`);
  return TYPES[glyph];
};
export const cost = (glyphs) => [...glyphs].map(type);

/**
 * One card-face evidence entry. The official page fixes the product and its
 * release; the printed text itself was read from the fingerprinted local image.
 * A card may name its own product (modules spanning several sets).
 */
export function cardEvidence(fallback, card) {
  const product = card.product ?? fallback;
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

// Rule-box Pokémon by their printed name suffix: the Prize cards the opponent takes when one is Knocked Out and the tags
// card text selects them by (「宝可梦V」 includes VMAX and VSTAR). Printed rule boxes: ex 2, EX 2, V 2, VSTAR 2, VMAX 3,
// GX 2, TAG TEAM (a GX with 「&」) 3; a Radiant Pokémon has a rule box but gives 1 Prize card.
export const RULE_BOXES = Object.freeze({
  ex: { prizeCount: 2, tags: ['ex'] }, EX: { prizeCount: 2, tags: ['EX'] }, V: { prizeCount: 2, tags: ['V'] },
  VSTAR: { prizeCount: 2, tags: ['V', 'VSTAR'] }, VMAX: { prizeCount: 3, tags: ['V', 'VMAX'] }, GX: { prizeCount: 2, tags: ['GX'] },
  'TAG TEAM': { prizeCount: 3, tags: ['GX', 'TAG TEAM'] }, Radiant: { prizeCount: 1, tags: ['Radiant'] },
  // 「V-UNION规则：当宝可梦 V-UNION 昏厥时，对手将拿取3张奖赏卡。」 under the printed V mark.
  'V-UNION': { prizeCount: 3, tags: ['V', 'V-UNION'] },
});
export function ruleBoxMechanics(ruleBox, tags = []) {
  const r = ruleBox ? RULE_BOXES[ruleBox] : null;
  if (ruleBox && !r) throw new TypeError(`Unknown rule box: ${ruleBox}`);
  return { ruleBox: !!r, prizeCount: r?.prizeCount ?? 1, tags: [...new Set([...(r?.tags ?? []), ...tags])] };
}
export function ruleBoxOf(name) {
  if (/^光辉/.test(name)) return 'Radiant';
  if (/GX$/.test(name)) return name.includes('&') ? 'TAG TEAM' : 'GX';
  if (/V-UNION$/.test(name)) return 'V-UNION';
  return /(VMAX|VSTAR|ex|EX|V)$/.exec(name)?.[1] ?? null;
}

// Printed damage column: a number is fixed; 「70×」/「30+」 carry their operator.
const printedDamage = (damage) => damage === null ? null :
  typeof damage === 'number' ? { value: damage, operator: 'fixed' } : { ...damage };
// ACE SPEC rule box: 「在1副卡组中只能放入1张ACE SPEC卡」 (printed on the card; the low-resolution
// local scans read 能 rather than 可 with moderate confidence). Trainer and Energy cards share one group, the one
// the kernel's 「【ACE SPEC】」 card selector reads.
export { ACE_SPEC_GROUP };

export function definitionBuilder(product, testIds) {
  const base = (card, id, kind, mechanics, deckLimits = { sameName: 4, groups: [] }) => {
    const sourceOfTruth = cardEvidence(product, card);
    return {
      schemaVersion: '1.0.0', definitionId: id, ruleset: { ...RULESET }, name: card.name, nameKey: card.nameKey, kind,
      sourceOfTruth, implementation: { status: 'verified', testIds: [...testIds] }, deckLimits, mechanics,
    };
  };
  // An entry is [key, handlerId, parameters] or, for an in-play/before-hand binding of its own, [key, handlerId,
  // parameters, { trigger?, activationCosts? }] (Tool, Special Energy, Stadium triggers; an Item's beforeHand).
  const bind = (id, card) => (key, handlerId, parameters, own = {}) => ({
    effectId: `${id}:${key}`, handlerId, parameters,
    ...(own.trigger ? { trigger: own.trigger } : {}),
    ...(own.activationCosts ? { activationCosts: own.activationCosts.map((c) => ({ ...c, sourceOfTruth: cardEvidence(product, card) })) } : {}),
    // 「如果同时使用N张，则…」: the entry of N cards of this Item played together (trainer.joint-play).
    ...(own.playCount ? { playCount: own.playCount } : {}),
    sourceOfTruth: cardEvidence(product, card),
  });
  return {
    pokemon(card, id, m) {
      const b = bind(id, card), ev = cardEvidence(product, card);
      return base(card, id, 'pokemon', {
        stage: m.stage, evolvesFrom: m.evolvesFrom ?? null,
        ...(m.basicAncestor ? { basicAncestor: { nameKey: m.basicAncestor, sourceOfTruth: ev } } : {}),
        hp: m.hp, types: [type(m.type)],
        weakness: m.weakness ? { type: type(m.weakness), operation: 'multiply', value: 2 } : null,
        resistance: m.resistance ? { type: type(m.resistance[0]), value: m.resistance[1] } : null,
        retreatCost: m.retreat,
        attacks: m.attacks.map((a) => ({
          attackId: `${id}:${a.key}`, name: a.name, cost: cost(a.cost),
          printedDamage: printedDamage(a.damage),
          effects: (a.effects ?? []).map(([key, handlerId, parameters, own]) => b(`${a.key}:${key}`, handlerId, parameters, own)),
          ...(a.failureCheck ? { failureCheck: { ...a.failureCheck, sourceOfTruth: ev } } : {}),
          ...(a.condition ? { condition: a.condition } : {}), ...(a.specialRule ? { specialRule: a.specialRule } : {}), ...(a.benchUse ? { benchUse: true } : {}),
          sourceOfTruth: ev,
        })),
        abilities: (m.abilities ?? []).map((a) => ({
          abilityId: `${id}:${a.key}`, name: a.name, mode: a.mode, usage: a.usage, ...(a.specialRule ? { specialRule: a.specialRule } : {}),
          ...(a.trigger ? { trigger: a.trigger } : {}), ...(a.condition ? { condition: a.condition } : {}),
          ...(a.endsTurn ? { endsTurn: true } : {}), ...(a.zone ? { zone: a.zone } : {}), ...(a.costs ? { costs: a.costs.map((c) => ({ ...c, sourceOfTruth: ev })) } : {}),
          effects: a.effects.map(([key, handlerId, parameters, own]) => b(`${a.key}:${key}`, handlerId, parameters, own)),
          sourceOfTruth: ev,
        })),
        ...ruleBoxMechanics(m.ex ? 'ex' : m.ruleBox ?? null, m.tags), ...(m.noPrizes ? { prizeCount: 0 } : {}),
        effects: (m.rules ?? []).map(([key, handlerId, parameters, own]) => b(`rule:${key}`, handlerId, parameters, own)),
        // pokemon.item-card: printed as an Item, played as this Basic Pokémon.
        ...(m.itemCard ? { itemCard: { leave: { ...m.itemCard.leave }, ...(m.itemCard.setupOnly ? { setupOnly: true } : {}), sourceOfTruth: ev } } : {}),
      });
    },
    trainer(card, id, category, effects, playCosts = null, extra = {}) {
      const b = bind(id, card), ev = cardEvidence(product, card);
      return base(card, id, 'trainer', {
        category, ...(extra.tags ? { tags: extra.tags } : {}), ...(extra.condition ? { condition: extra.condition } : {}),
        ...(extra.firstTurnUse ? { firstTurnUse: true } : {}), ...(extra.endsTurn ? { endsTurn: true } : {}),
        // 「可以使用这张卡牌上的招式」: the attack printed on a Tool, keyed g.
        ...(extra.grantedAttacks ? { grantedAttacks: extra.grantedAttacks.map((a) => ({
          attackId: `${id}:${a.key}`, name: a.name, cost: cost(a.cost), printedDamage: printedDamage(a.damage),
          effects: (a.effects ?? []).map(([key, handlerId, parameters, own]) => b(`${a.key}:${key}`, handlerId, parameters, own)),
          ...(a.failureCheck ? { failureCheck: { ...a.failureCheck, sourceOfTruth: ev } } : {}),
          ...(a.condition ? { condition: a.condition } : {}), ...(a.specialRule ? { specialRule: a.specialRule } : {}),
          sourceOfTruth: ev,
        })) } : {}),
        ...(extra.grantedAttackHolder ? { grantedAttackHolder: extra.grantedAttackHolder } : {}),
        // 「身上放有这张卡牌的「宝可梦V」，可以使用这个【VSTAR】力量」: the Ability printed on a Tool, keyed b.
        ...(extra.grantedAbilities ? { grantedAbilities: extra.grantedAbilities.map((a) => ({
          abilityId: `${id}:${a.key}`, name: a.name, mode: a.mode, usage: a.usage, ...(a.specialRule ? { specialRule: a.specialRule } : {}),
          ...(a.trigger ? { trigger: a.trigger } : {}), ...(a.condition ? { condition: a.condition } : {}), ...(a.endsTurn ? { endsTurn: true } : {}),
          ...(a.zone ? { zone: a.zone } : {}), ...(a.costs ? { costs: a.costs.map((c) => ({ ...c, sourceOfTruth: ev })) } : {}),
          effects: a.effects.map(([key, handlerId, parameters, own]) => b(`${a.key}:${key}`, handlerId, parameters, own)),
          sourceOfTruth: ev,
        })) } : {}),
        ...(extra.grantedAbilityHolder ? { grantedAbilityHolder: extra.grantedAbilityHolder } : {}),
        ...(extra.turnEndDiscard ? { turnEndDiscard: true } : {}), ...(extra.opponentTurnEndDiscard ? { opponentTurnEndDiscard: true } : {}),
        ...(extra.handAttachExcept ? { handAttachExcept: extra.handAttachExcept } : {}),
        // 「这张卡牌，只要在弃牌区，就无法加入手牌，也无法放回牌库」.
        ...(extra.discardPileLock ? { discardPileLock: { to: [...extra.discardPileLock.to] } } : {}),
        effects: effects.map(([key, handlerId, parameters, own]) => b(key, handlerId, parameters, own)),
        ...(playCosts ? { playCosts: playCosts.map((c) => ({ ...c, sourceOfTruth: cardEvidence(product, card) })) } : {}),
        // 「另外，当使用这张卡牌时，可将N张自己的手牌放于弃牌区。在这种情况下，…」.
        ...(extra.optionalPlayCosts ? { optionalPlayCosts: extra.optionalPlayCosts.map((c) => ({ ...c, sourceOfTruth: ev })) } : {}),
        // 「如果将2张自己的手牌（除「X」外）放于弃牌区的话，则将这张「X」从弃牌区…加入手牌」.
        ...(extra.discardRecall ? { discardRecall: { costs: extra.discardRecall.costs.map((c) => ({ ...c, sourceOfTruth: ev })) } } : {}),
      }, extra.aceSpec ? { sameName: 4, groups: [{ key: ACE_SPEC_GROUP, maximum: 1, sourceOfTruth: cardEvidence(product, card) }] } :
        undefined);
    },
    basicEnergy(card, id, energyType) {
      return base(card, id, 'energy', { category: 'basic', baseUnits: [[type(energyType)]], effects: [] },
        { sameName: null, groups: [] });
    },
    specialEnergy(card, id, baseUnits, effects, extra = {}) {
      const b = bind(id, card);
      return base(card, id, 'energy', {
        category: 'special', baseUnits, effects: effects.map(([key, handlerId, parameters, own]) => b(key, handlerId, parameters, own)),
        // 「当要将这张卡牌，从手牌附着于宝可梦身上时，必须…」「这张卡牌只能附着于X身上，…之外…则将其放于弃牌区」.
        ...(extra.attachCosts ? { attachCosts: extra.attachCosts.map((c) => ({ ...c, sourceOfTruth: cardEvidence(product, card) })) } : {}),
        ...(extra.handAttachTo ? { handAttachTo: extra.handAttachTo } : {}), ...(extra.remainOn ? { remainOn: extra.remainOn } : {}),
      }, { sameName: 4, groups: extra.aceSpec ? [{ key: ACE_SPEC_GROUP, maximum: 1, sourceOfTruth: cardEvidence(product, card) }] : [] });
    },
  };
}

export function printing(fallback, card, definitionId) {
  const product = card.product ?? fallback;
  return {
    schemaVersion: '1.0.0', printingId: `zh-Hans:${card.setCode}:${card.number}`, game: 'tcg', language: 'zh-Hans',
    setCode: card.setCode, number: card.number, regulationMark: card.mark, series: product.series,
    releasedOn: product.releasedOn, identityReview: 'verified',
    definitionBindings: [{ ruleset: { ...RULESET }, definitionId, sourceOfTruth: cardEvidence(product, card) }],
    metadataRefs: [{ provider: 'other', id: `${card.image.store}:${card.image.path.replace(/\/[^/]+$/, '')}`,
      revision: `image-sha256:${card.image.sha256}` }],
  };
}
