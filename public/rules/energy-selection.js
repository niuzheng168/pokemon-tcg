import { matchesCardSelector, currentCard } from './card-selection.js';
import { matchesInPlaySelector } from './in-play-selection.js';
import { matchingEnergyUnits, attachedEnergySelection } from './energy-mechanics.js';

const mons = (p) => [p.active, ...p.bench].filter(Boolean);
function at(ctx, position, owner, mon) {
  if (position === 'active') return ctx.state.players[owner].active?.id === mon.id;
  if (position === 'bench') return ctx.state.players[owner].active?.id !== mon.id;
  if (position === 'self') return mon.id === ctx.source.pokemonId;
  if (position === 'event') return mon.id === ctx.event?.subjectId;
  if (position === 'attacker') return mon.id === ctx.event?.cause.source?.pokemonId;
  return true;
}
// pokemon.attached-card: an attached card is the card it is attached as.
const definition = (ctx, id) => currentCard(ctx.state, ctx.definitions[ctx.state.cards[id].definitionId], id);
// An Energy card an effect may attach from a zone (II.C-09): Basic Energy (of the printed type), 「能量」 (any) or
// 「特殊能量」. A card with its own attach cost from hand needs a card-specific ruling, so an effect does not offer it.
export function effectAttachable(def, p, zone) {
  if (def.kind !== 'energy' || zone === 'hand' && def.mechanics.attachCosts?.length) return false;
  // 「选择自己手牌中的1张「治疗能量」」: only Energy of the printed names.
  if (p.nameKeys && !p.nameKeys.includes(def.nameKey)) return false;
  if (p.category === 'any') return true;
  if (p.category === 'special') return def.mechanics.category === 'special';
  return def.mechanics.category === 'basic' && (p.types ? p.types.includes(def.mechanics.baseUnits[0][0]) :
    p.type === null || def.mechanics.baseUnits[0][0] === p.type);
}
// boundPokemon: a thenMoved's bound Pokémon — the holders a discard or return takes from, and the recipients of a move, unless
// boundOrigin (「被换入备战区的宝可梦身上附着的…能量，转附于新的战斗宝可梦身上」) makes them the holders a move takes from.
export function energyRecipients(ctx, action, chosen = []) {
  const owner = action.side === 'own' ? ctx.source.owner : 1 - ctx.source.owner;
  return mons(ctx.state.players[owner]).filter((m) => !chosen.some((c) => c.originId === m.id) &&
    at(ctx, action.recipient.position, owner, m) && (!action.boundPokemon || action.boundOrigin || action.boundPokemon.includes(m.id)) &&
    matchesInPlaySelector(definition(ctx, m.stack.at(-1)), action.recipient.selector, ctx.effectivePokemon[m.id].types));
}
export function attachedEnergyPool(ctx, action) {
  const owner = action.side === 'own' ? ctx.source.owner : 1 - ctx.source.owner;
  return mons(ctx.state.players[owner]).filter((m) => at(ctx, action.from, owner, m) &&
    (!action.boundPokemon || action.op === 'moveEnergy' && !action.boundOrigin || action.boundPokemon.includes(m.id)) &&
    (!action.originSelector || matchesInPlaySelector(definition(ctx, m.stack.at(-1)), action.originSelector, ctx.effectivePokemon[m.id].types))).flatMap((m) =>
    m.energy.filter((id) => matchesCardSelector(definition(ctx, id), action.selector)).map((instanceId) => {
      const units = ctx.effectivePokemon[m.id].energies.find((e) => e.instanceId === instanceId).units;
      return { owner, originId: m.id, instanceId, units,
        amount: action.measure === 'cards' ? 1 : matchingEnergyUnits(units, action.providedTypes) };
    }).filter((c) => c.amount > 0 && (action.providedTypes === null || matchingEnergyUnits(c.units, action.providedTypes) > 0) &&
      (action.op !== 'moveEnergy' || energyRecipients(ctx, action, [c]).length > 0)));
}
// 「各1个」: one card from each Pokémon holding one; 「1只宝可梦身上的」: one holder; 「1种属性的」: one Basic Energy type (typeOf).
export function attachedEnergyChoice(pool, action, ids, typeOf) {
  if (action.perPokemon) {
    const origins = ids.map((id) => pool.find((c) => c.instanceId === id)?.originId);
    return { valid: origins.every(Boolean) && new Set(ids).size === ids.length && new Set(origins).size === ids.length &&
      ids.length === new Set(pool.map((c) => c.originId)).size, unsupported: false };
  }
  const verdict = attachedEnergySelection(pool, action, ids);
  if (!verdict.valid) return verdict;
  const chosen = ids.map((id) => pool.find((c) => c.instanceId === id));
  return { ...verdict, valid: !(action.singleOrigin && new Set(chosen.map((c) => c.originId)).size > 1 ||
    action.sameType && new Set(ids.map(typeOf)).size > 1) };
}
export function canUseAttachedEnergy(ctx, action) {
  const pool = attachedEnergyPool(ctx, action);
  if (!pool.length) return false;
  if (action.op !== 'moveEnergy' || action.distribution !== 'singleRecipient' || ['upTo', 'any'].includes(action.quantity.kind)) return true;
  if (action.quantity.kind === 'all') return energyRecipients(ctx, action, pool).length > 0;
  const needed = Math.min(action.quantity.count, pool.reduce((n, c) => n + c.amount, 0));
  return energyRecipients(ctx, action).some((m) => pool.filter((c) => c.originId !== m.id).reduce((n, c) => n + c.amount, 0) >= needed);
}
