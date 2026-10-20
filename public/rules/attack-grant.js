import { copyCandidates } from './attack-copy.js';
import { matchesInPlaySelector } from './in-play-selection.js';

export const ATTACK_GRANT_RULE_IDS = Object.freeze(['attack.grant', 'attack.owned', 'energy.requirement']);

/** Permission origins are relative to the actual user, not a shared provider's holder. */
export function grantReferences(ctx, spec, owner, mon) {
  const source = ctx.source, def = ctx.definitions[ctx.state.cards[mon.stack.at(-1)].definitionId];
  if ((spec.scope === 'self' && source.pokemonId !== mon.id) ||
      (spec.scope === 'own' && source.owner !== owner) || (spec.scope === 'opponent' && source.owner === owner) ||
      (spec.activeOnly && ctx.state.players[owner].active?.id !== mon.id) ||
      (spec.sourceActive && ctx.state.players[source.owner].active?.id !== source.pokemonId) ||
      !matchesInPlaySelector(def, spec.targetSelector, ctx.effectivePokemon[mon.id].types)) return [];
  return copyCandidates({ ...ctx, source: { owner, pokemonId: mon.id } }, spec);
}
