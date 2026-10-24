import { matchesInPlaySelector, matchesPokemonState } from './in-play-selection.js';
import { currentCard } from './card-selection.js';

export const FIELD_RETURN_RULE_IDS = Object.freeze(['effects.field-return', 'effects.field-return-promotion', 'energy.return', 'ability.reentry',
  'effects.field-return-deck', 'effects.attached-return']);

export function fieldReturnTargets(ctx, action) {
  const owner = action.side === 'own' ? ctx.source.owner : 1 - ctx.source.owner, p = ctx.state.players[owner];
  return [p.active, ...p.bench].filter(Boolean).filter((m) =>
    (action.target !== 'active' || p.active?.id === m.id) &&
    (action.target !== 'bench' || p.active?.id !== m.id) &&
    (action.target !== 'self' || ctx.source.pokemonId === m.id) &&
    (action.target !== 'event' || ctx.event?.subjectId === m.id) &&
    (action.target !== 'attacker' || ctx.event?.cause.source?.pokemonId === m.id) &&
    matchesInPlaySelector(ctx.definitions[ctx.state.cards[m.stack.at(-1)].definitionId],
      action.selector, ctx.effectivePokemon[m.id].types) &&
    (!action.state || matchesPokemonState(m, ctx.effectivePokemon[m.id], action.state,
      (id) => currentCard(ctx.state, ctx.definitions[ctx.state.cards[id].definitionId], id))));
}
// effects.attached-return 「将放于双方战斗宝可梦身上的所有卡牌…」: the printed sides' Active Pokémon holding attached cards, the user's first.
export function attachedReturnHolders(ctx, action) {
  const own = ctx.source.owner, sides = action.side === 'both' ? [own, 1 - own] : [action.side === 'own' ? own : 1 - own];
  return sides.map((owner) => ({ owner, m: ctx.state.players[owner].active }))
    .filter(({ m }) => m && m.energy.length + m.tools.length > 0);
}
