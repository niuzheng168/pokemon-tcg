import { matchesCardSelector } from './card-selection.js';
import { matchesInPlaySelector } from './in-play-selection.js';

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
    next.mechanics.basicAncestor.nameKey === current.nameKey;
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

export function transitionCards(ctx, action, mon) {
  const current = definition(ctx, mon.stack.at(-1));
  return ctx.state.players[ctx.source.owner][action.from].filter((id) => {
    const next = definition(ctx, id);
    return matchesCardSelector(next, action.selector) && (action.op === 'evolvePokemon' ?
      evolutionRelation(current, next, action.relation) : action.relation === 'any' || next.nameKey === current.nameKey);
  });
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
      // Searching a deck may fail to find. Do not leak deck contents by removing
      // a public action/target solely because no matching evolution is inside.
      if (action.from === 'deck') return ctx.state.players[ctx.source.owner].deck.length > 0;
    }
    return transitionCards(ctx, action, m).length > 0;
  });
}
