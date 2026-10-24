import { matchesCardSelector } from './card-selection.js';
import { matchesInPlaySelector } from './in-play-selection.js';

export const ATTACK_COPY_RULE_IDS = Object.freeze(['attack.copy', 'attack.owned', 'attack.copy-special-rule']);
export const attackOptionId = (ref) => JSON.stringify([ref.instanceId, ref.attackId]);

/** Only printed attacks are "owned"; extra attacks supplied by Tools/Abilities are not. */
export function copyCandidates(ctx, action) {
  const result = new Map(), actor = ctx.source.owner;
  for (const origin of action.origins) {
    const owners = origin.side === 'either' ? [actor, 1 - actor] : [origin.side === 'own' ? actor : 1 - actor];
    for (const owner of owners) {
      const p = ctx.state.players[owner], mons = [p.active, ...p.bench].filter(Boolean);
      // pokemon.v-union: a piece out of play, or under the top piece, is no Pokémon with attacks of its own.
      const piece = (instanceId) => !!ctx.definitions[ctx.state.cards[instanceId].definitionId].mechanics.vUnion;
      // 「那只宝可梦所拥有的…」 after a move: the moved cards of that player, even one a rule put into the Lost Zone instead.
      const out = action.among ? action.among.filter((id) => ctx.state.cards[id].owner === owner) : p.discard;
      const refs = origin.zone === 'discard' ? out.filter((id) => !piece(id)).map((instanceId) => ({ instanceId, pokemonId: null })) :
        mons.filter((m) => (!origin.subject || m.id === ctx.source.pokemonId) &&
          (origin.zone !== 'active' || p.active?.id === m.id) &&
          (origin.zone !== 'bench' || p.active?.id !== m.id)).flatMap((m) =>
          (origin.zone === 'evolution' ? m.stack.slice(0, -1).filter((id) => !piece(id)) : [m.stack.at(-1)])
            .map((instanceId) => ({ instanceId, pokemonId: m.id })));
      for (const { instanceId, pokemonId } of refs) {
        const definition = ctx.definitions[ctx.state.cards[instanceId].definitionId];
        const matching = origin.zone === 'discard' || origin.zone === 'evolution' ?
          matchesCardSelector(definition, origin.selector) :
          matchesInPlaySelector(definition, origin.selector, ctx.effectivePokemon[pokemonId].types);
        if (action.excludeUser && pokemonId === ctx.source.pokemonId || !matching) continue;
        for (const attack of definition.mechanics.attacks) if ((!action.attackIds || action.attackIds.includes(attack.attackId)) &&
            !action.excludeSpecialRules?.includes(attack.specialRule)) {
          const ref = { instanceId, attackId: attack.attackId };
          result.set(attackOptionId(ref), ref);
        }
      }
    }
  }
  return [...result.values()];
}
