import { matchesCardSelector } from './card-selection.js';
import { matchesInPlaySelector } from './in-play-selection.js';
import { attacksInPreviousOpponentTurn } from './battle-history.js';

export const ATTACK_COPY_RULE_IDS = Object.freeze(['attack.copy', 'attack.owned', 'attack.copy-special-rule', 'attack.copy-previous', 'attack.copy-revealed']);
export const attackOptionId = (ref) => JSON.stringify([ref.instanceId, ref.attackId]);

/** Only printed attacks are "owned"; extra attacks supplied by Tools/Abilities are not. `revealed`: a deck origin's face-up cards. */
export function copyCandidates(ctx, action, revealed = null) {
  const result = new Map(), actor = ctx.source.owner;
  for (const origin of action.origins) {
    // attack.copy-previous 「在上一个对手的回合，如果对手的宝可梦使用了招式…，则将该招式作为这个招式使用」: each attack the opponent's
    // Pokémon actually used then (its declared content, a Tool's attack included), by the user's printed top card then.
    if (origin.zone === 'previousTurn') {
      for (const used of attacksInPreviousOpponentTurn(ctx.state.battleHistory, { turn: ctx.state.turn, during: ctx.state.current }, actor)) {
        const ref = used.reference, definition = ctx.definitions[ctx.state.cards[ref.instanceId].definitionId];
        const attack = [...definition.mechanics.attacks ?? [], ...definition.mechanics.grantedAttacks ?? []].find((a) => a.attackId === ref.attackId);
        if (matchesCardSelector(ctx.definitions[ctx.state.cards[used.cardId].definitionId], origin.selector) &&
            (!action.attackIds || action.attackIds.includes(ref.attackId)) && !action.excludeSpecialRules?.includes(attack.specialRule))
          result.set(attackOptionId(ref), { instanceId: ref.instanceId, attackId: ref.attackId });
      }
      continue;
    }
    const owners = origin.side === 'either' ? [actor, 1 - actor] : [origin.side === 'own' ? actor : 1 - actor];
    for (const owner of owners) {
      const p = ctx.state.players[owner], mons = [p.active, ...p.bench].filter(Boolean);
      // pokemon.v-union: a piece out of play, or under the top piece, is no Pokémon with attacks of its own.
      const piece = (instanceId) => !!ctx.definitions[ctx.state.cards[instanceId].definitionId].mechanics.vUnion;
      // 「那只宝可梦所拥有的…」 after a move: the moved cards of that player, even one a rule put into the Lost Zone instead.
      // attack.copy-revealed 「将对手牌库上方10张卡牌翻到正面。…选择其中的宝可梦所拥有的1个招式」: only those face-up cards.
      const out = origin.zone === 'deck' ? revealed : action.among ? action.among.filter((id) => ctx.state.cards[id].owner === owner) : p.discard;
      const refs = ['discard', 'deck'].includes(origin.zone) ? out.filter((id) => !piece(id)).map((instanceId) => ({ instanceId, pokemonId: null })) :
        mons.filter((m) => (!origin.subject || m.id === ctx.source.pokemonId) &&
          (origin.zone !== 'active' || p.active?.id === m.id) &&
          (origin.zone !== 'bench' || p.active?.id !== m.id)).flatMap((m) =>
          (origin.zone === 'evolution' ? m.stack.slice(0, -1).filter((id) => !piece(id)) : [m.stack.at(-1)])
            .map((instanceId) => ({ instanceId, pokemonId: m.id })));
      for (const { instanceId, pokemonId } of refs) {
        const definition = ctx.definitions[ctx.state.cards[instanceId].definitionId];
        const matching = ['discard', 'deck', 'evolution'].includes(origin.zone) ?
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
