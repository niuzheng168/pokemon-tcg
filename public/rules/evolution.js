import { matchesCardSelector } from './card-selection.js';
import { matchesInPlaySelector, enterLocked } from './in-play-selection.js';
import { resolveContextSelector } from './context-selection.js';

export const EVOLUTION_RULE_IDS = Object.freeze([
  'turn.evolve', 'effects.evolve', 'effects.devolve', 'effects.inherit', 'evolution.history',
]);
const evolutionStages = ['stage1', 'stage2', 'VSTAR', 'VMAX'];
const mons = (p) => [p.active, ...p.bench].filter(Boolean);
const definition = (ctx, id) => ctx.definitions[ctx.state.cards[id].definitionId];

export function evolutionRelation(current, next, relation) {
  if (current.kind !== 'pokemon' || next.kind !== 'pokemon' || !evolutionStages.includes(next.mechanics.stage)) return false;
  if (relation === 'ordinary') return next.mechanics.evolvesFrom === current.nameKey;
  if (relation === 'skipStage1') return current.mechanics.stage === 'basic' && next.mechanics.stage === 'stage2' &&
    [next.mechanics.basicAncestor.nameKey, ...(next.mechanics.basicAncestor.otherNameKeys ?? [])].includes(current.nameKey);
  if (relation === 'anyStage1') return current.mechanics.stage === 'basic' && next.mechanics.stage === 'stage1';
  throw new TypeError('Unknown reviewed evolution relation.');
}

export function evolutionTiming(state, owner, mon, timing) {
  if ((timing.firstOwnTurn === 'forbid' && state.current === owner && state.players[owner].turns <= 1) ||
      (timing.enteredThisTurn === 'forbid' && mon.enteredTurn === state.turn) ||
      (timing.evolvedThisTurn === 'forbid' && mon.evolvedTurn === state.turn))
    return { allowed: false, needsRuling: false };
  const needsRuling = timing.evolvedThisTurn === 'needsRuling' && mon.evolvedTurn === state.turn;
  return { allowed: !needsRuling, needsRuling };
}

export function transitionTargets(ctx, action) {
  const owner = action.side === 'opponent' ? 1 - ctx.source.owner : ctx.source.owner;
  return mons(ctx.state.players[owner]).filter((m) => {
    const position = action.target;
    return (position !== 'active' || ctx.state.players[owner].active?.id === m.id) &&
      (position !== 'bench' || ctx.state.players[owner].active?.id !== m.id) &&
      (position !== 'self' || ctx.source.pokemonId === m.id) &&
      (position !== 'event' || ctx.event?.subjectId === m.id) &&
      (position !== 'attacker' || ctx.event?.cause.source?.pokemonId === m.id) &&
      matchesInPlaySelector(definition(ctx, m.stack.at(-1)), action.targetSelector, ctx.effectivePokemon[m.id].types);
  });
}

// effects.enter-lock: a card its owner may not put into play now is never put on top (ctx.enterLocks); effects.player-lock-cards: nor a
// hand card its owner may not put into play from the hand (ctx.handLocks).
// selection.context 「将与被附着的能量相同属性的…卡牌」: the selector's types read now (nothing to read: no card).
export function transitionCards(ctx, action, mon) {
  const current = definition(ctx, mon.stack.at(-1)), selector = resolveContextSelector(action.selector, ctx);
  return ctx.state.players[ctx.source.owner][action.from].filter((id) => {
    const next = definition(ctx, id);
    return !!selector && matchesCardSelector(next, selector) && (action.op === 'evolvePokemon' ?
      evolutionRelation(current, next, action.relation) : action.relation === 'any' || next.nameKey === current.nameKey) &&
      !enterLocked(next, ctx.enterLocks[ctx.source.owner]) &&
      (action.from !== 'hand' || !ctx.handLocks[ctx.source.owner].some((locked) => matchesCardSelector(next, locked)));
  });
}

// 「如果自己场上有可以进化为「X」…的宝可梦的话」 (evolvableTarget; JP Q&A やみのいし: ヒトツキ is none): whether some card of the
// approved pool (public, never the hidden deck) matching the selector, read now, could evolve this Pokémon by the relation.
export function poolCouldEvolve(ctx, action, mon) {
  const current = definition(ctx, mon.stack.at(-1)), selector = resolveContextSelector(action.selector, ctx);
  return !!selector && Object.values(ctx.definitions).some((next) => evolutionRelation(current, next, action.relation) && matchesCardSelector(next, selector));
}

export function devolutionDepth(ctx, mon) {
  let count = 0;
  for (let i = mon.stack.length - 1; i > 0 && evolutionStages.includes(definition(ctx, mon.stack[i]).mechanics.stage); i--) count++;
  return count;
}

export function canUsePokemonTransition(ctx, action) {
  const targets = transitionTargets(ctx, action);
  if (action.op === 'devolvePokemon') return targets.some((m) => devolutionDepth(ctx, m) > 0);
  return targets.some((m) => {
    if (action.op === 'evolvePokemon') {
      const timing = evolutionTiming(ctx.state, ctx.source.owner, m, action.timing);
      if (!timing.allowed && !timing.needsRuling) return false;
    }
    // Searching a deck may fail to find. Do not leak deck contents by removing
    // a public action/target solely because no matching card is inside.
    if (action.from === 'deck') return ctx.state.players[ctx.source.owner].deck.length > 0 && (!action.evolvableTarget || poolCouldEvolve(ctx, action, m));
    return transitionCards(ctx, action, m).length > 0;
  });
}
