import { matchesCardSelector } from './card-selection.js';
import { matchesInPlaySelector } from './in-play-selection.js';
import { matchingEnergyUnits } from './energy-mechanics.js';

const mons = (p) => [p.active, ...p.bench].filter(Boolean);
function at(ctx, position, owner, mon) {
  if (position === 'active') return ctx.state.players[owner].active?.id === mon.id;
  if (position === 'bench') return ctx.state.players[owner].active?.id !== mon.id;
  if (position === 'self') return mon.id === ctx.source.pokemonId;
  if (position === 'event') return mon.id === ctx.event?.subjectId;
  if (position === 'attacker') return mon.id === ctx.event?.cause.source?.pokemonId;
  return true;
}
const definition = (ctx, id) => ctx.definitions[ctx.state.cards[id].definitionId];
export function energyRecipients(ctx, action, chosen = []) {
  const owner = action.side === 'own' ? ctx.source.owner : 1 - ctx.source.owner;
  return mons(ctx.state.players[owner]).filter((m) => !chosen.some((c) => c.originId === m.id) &&
    at(ctx, action.recipient.position, owner, m) &&
    matchesInPlaySelector(definition(ctx, m.stack.at(-1)), action.recipient.selector, ctx.effectivePokemon[m.id].types));
}
export function attachedEnergyPool(ctx, action) {
  const owner = action.side === 'own' ? ctx.source.owner : 1 - ctx.source.owner;
  return mons(ctx.state.players[owner]).filter((m) => at(ctx, action.from, owner, m)).flatMap((m) =>
    m.energy.filter((id) => matchesCardSelector(definition(ctx, id), action.selector)).map((instanceId) => {
      const units = ctx.effectivePokemon[m.id].energies.find((e) => e.instanceId === instanceId).units;
      return { owner, originId: m.id, instanceId, units,
        amount: action.measure === 'cards' ? 1 : matchingEnergyUnits(units, action.providedTypes) };
    }).filter((c) => c.amount > 0 && (action.providedTypes === null || matchingEnergyUnits(c.units, action.providedTypes) > 0) &&
      (action.op !== 'moveEnergy' || energyRecipients(ctx, action, [c]).length > 0)));
}
export function canUseAttachedEnergy(ctx, action) {
  const pool = attachedEnergyPool(ctx, action);
  if (!pool.length) return false;
  if (action.op !== 'moveEnergy' || action.distribution !== 'singleRecipient' || ['upTo', 'any'].includes(action.quantity.kind)) return true;
  if (action.quantity.kind === 'all') return energyRecipients(ctx, action, pool).length > 0;
  const needed = Math.min(action.quantity.count, pool.reduce((n, c) => n + c.amount, 0));
  return energyRecipients(ctx, action).some((m) => pool.filter((c) => c.originId !== m.id).reduce((n, c) => n + c.amount, 0) >= needed);
}
