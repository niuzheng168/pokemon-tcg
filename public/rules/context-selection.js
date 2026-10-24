/**
 * selection.context: a Pokémon CardSelector whose types or names are printed as those of something on the board —
 * 「与对手场上宝可梦相同属性的」「与这只宝可梦身上附着的基本能量相同属性的」「与被附着的能量相同属性的」「与对手场上宝可梦名字相同的」
 * 「与自己弃牌区中的宝可梦名字相同的」. Its host reads those values from the effect's own context (ctx.state, ctx.effectivePokemon,
 * ctx.source, ctx.event) when the effect resolves; the searched cards' PRINTED types and names are then matched against them.
 * JP Q&A フレンドボール: a dual-type Pokémon offers either of its types, and a type an effect gave it is its type; ラブラブボール: the same
 * name only (ピカチュウex is not ピカチュウ). Only a top-level selector (never an alternative) of a cn.cards@1 or evolve selection.
 */
import { printedCard, CONTEXT_FIELDS } from './card-selection.js';

const mons = (p) => [p.active, ...p.bench].filter(Boolean);
const def = (ctx, id) => ctx.definitions[ctx.state.cards[id].definitionId];
export const hasContextFields = (selector) => CONTEXT_FIELDS.some((k) => Object.hasOwn(selector, k));

// The types an Energy card provides now on its holder (JP Q&A カクレオン「いろいろへんげ」×バクフーン「バーニングエナジー」: a Basic
// Energy working as Fire Energy is Fire); a card no longer attached shows its printed type.
function energyTypes(ctx, id) {
  const holder = ctx.state.players.flatMap(mons).find((m) => m.energy.includes(id));
  return (holder ? ctx.effectivePokemon[holder.id].energies.find((e) => e.instanceId === id).units : def(ctx, id).mechanics.baseUnits).flat();
}
// The printed cards whose names 「名字相同」 reads: the opponent's in-play Pokémon (their top cards), or the Pokémon cards in the user's
// discard pile (a card printed as an Item is an Item there).
function namedCards(ctx, from) {
  const own = ctx.source.owner;
  return from === 'opponentField' ? mons(ctx.state.players[1 - own]).map((m) => def(ctx, m.stack.at(-1))) :
    ctx.state.players[own].discard.map((id) => printedCard(def(ctx, id))).filter((d) => d.kind === 'pokemon');
}
function contextTypes(ctx, from) {
  const own = ctx.source.owner;
  if (from === 'opponentField') return mons(ctx.state.players[1 - own]).flatMap((m) => ctx.effectivePokemon[m.id].types);
  if (from === 'eventEnergy') return energyTypes(ctx, ctx.event.cardId);
  const self = mons(ctx.state.players[own]).find((m) => m.id === ctx.source.pokemonId);
  return self.energy.filter((id) => def(ctx, id).mechanics.category === 'basic').flatMap((id) => energyTypes(ctx, id));
}

/** The distinct types read now from that source of the effect's context. */
export const readTypes = (ctx, from) => [...new Set(contextTypes(ctx, from))];

/** The selector with its context fields replaced by the values read now, or null when there is nothing to read (no card can match). */
export function resolveContextSelector(selector, ctx) {
  if (!hasContextFields(selector)) return selector;
  const resolved = { ...selector };
  for (const key of CONTEXT_FIELDS.filter((k) => Object.hasOwn(selector, k))) {
    const values = key === 'typesFrom' ? readTypes(ctx, selector.typesFrom) : [...new Set(namedCards(ctx, selector.namesFrom).map((d) => d.nameKey))];
    if (!values.length) return null;
    delete resolved[key];
    resolved[key === 'typesFrom' ? 'types' : 'nameKeys'] = values;
  }
  return resolved;
}

// JP Q&A ラブラブボール (相手の場にかがやくゲッコウガのみ・自分の場にかがやくリザードン／相手の場にピカチュウのみ・自分の場にピカチュウ4匹 →
// 使えない): a name the user's deck can no longer hold offers nothing — the user's own cards seen outside the deck (hand, field, discard
// pile, Lost Zone, face-up Prize cards, cards being resolved) already reach its same-name limit or a deck-group limit of that card.
function deckCouldHold(ctx, owner, definition) {
  const p = ctx.state.players[owner];
  const seen = [...p.hand, ...p.discard, ...p.lost, ...p.resolving, ...(p.faceUpPrizes ?? []),
    ...mons(p).flatMap((m) => [...m.stack, ...m.energy, ...m.tools])].map((id) => def(ctx, id));
  const limit = definition.deckLimits.sameName;
  return (limit === null || seen.filter((d) => d.nameKey === definition.nameKey).length < limit) &&
    definition.deckLimits.groups.every((g) => seen.filter((d) => d.deckLimits.groups.some((x) => x.key === g.key)).length < g.maximum);
}
/** Whether a deck search with this selector could find anything by public information: a context value to read and, for names, a name
 * the user's deck may still hold. */
export function contextSearchPossible(ctx, selector, owner) {
  if (!hasContextFields(selector)) return true;
  return !!resolveContextSelector(selector, ctx) &&
    (!selector.namesFrom || namedCards(ctx, selector.namesFrom).some((d) => deckCouldHold(ctx, owner, d)));
}
