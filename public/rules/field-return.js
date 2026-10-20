import { matchesInPlaySelector } from './in-play-selection.js';

export const FIELD_RETURN_RULE_IDS = Object.freeze(['effects.field-return', 'energy.return', 'ability.reentry']);

export function fieldReturnTargets(ctx, action) {
  const owner = action.side === 'own' ? ctx.source.owner : 1 - ctx.source.owner, p = ctx.state.players[owner];
  return [p.active, ...p.bench].filter(Boolean).filter((m) =>
    (action.target !== 'active' || p.active?.id === m.id) &&
    (action.target !== 'bench' || p.active?.id !== m.id) &&
    (action.target !== 'self' || ctx.source.pokemonId === m.id) &&
    (action.target !== 'event' || ctx.event?.subjectId === m.id) &&
    (action.target !== 'attacker' || ctx.event?.cause.source?.pokemonId === m.id) &&
    matchesInPlaySelector(ctx.definitions[ctx.state.cards[m.stack.at(-1)].definitionId],
      action.selector, ctx.effectivePokemon[m.id].types));
}
