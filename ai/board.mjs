// Reading a player view for the AI: what each card does (from its effect handlers and parameters, never its name), how
// much damage a Pokémon's attacks do to a defender, and how far it is from attacking. Shared by the policy and the
// position evaluation.
const DRAW = new Set(['cn.draw@1', 'cn.drawUntil@1', 'cn.cardsThenDraw@1', 'cn.handDeckDraw@1', 'cn.drawValue@1', 'cn.drawPlayers@1',
  'cn.drawPokemonCount@1', 'cn.attachThenDraw@1', 'cn.handBottomDraw@1']);
const ATTACH = new Set(['cn.attachDeckEnergy@1', 'cn.attachDiscard@1', 'cn.attachHand@1', 'cn.attachThenDraw@1']);
const HEAL = new Set(['cn.heal@1', 'cn.healPokemon@1']);

export const mons = (p) => [p.active, ...p.bench].filter((m) => m && !m.faceDown);
export const top = (m) => m.stack.at(-1);

const readers = new WeakMap();

/** One reader per catalog: what each definition does is worked out once. */
export function boardReader(catalog) {
  if (!readers.has(catalog)) readers.set(catalog, makeReader(catalog));
  return readers.get(catalog);
}

// Damage an attack's effect adds per card it selects (「每…张，造成50伤害」: a damage expression that multiplies the number of
// cards an earlier effect of the attack moved), by that effect's id.
function perCard(attacks) {
  const out = new Map();
  (function walk(v) {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (v.kind === 'multiply') {
        const n = [v.left, v.right].find((x) => x?.kind === 'literal'), cards = [v.left, v.right].find((x) => x?.kind === 'effectCards');
        if (n && cards) out.set(cards.effectId, n.value);
      }
      Object.values(v).forEach(walk);
    }
  })(attacks.map((a) => a.effects));
  return out;
}

function makeReader(catalog) {
  const cache = new Map();
  /** What a definition does; worked out once per definition. */
  const facts = (definitionId) => {
    if (cache.has(definitionId)) return cache.get(definitionId);
    const d = catalog.definition(definitionId), m = d.mechanics;
    const bindings = [];
    (function walk(v) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') { if (typeof v.handlerId === 'string') bindings.push(v); Object.values(v).forEach(walk); }
    })([m.effects ?? [], (m.abilities ?? []).map((a) => a.effects)]);
    const has = (set) => bindings.some((b) => set.has(b.handlerId));
    const handlers = (v, out = []) => {
      if (Array.isArray(v)) v.forEach((x) => handlers(x, out));
      else if (v && typeof v === 'object') { if (typeof v.handlerId === 'string') out.push(v.handlerId); Object.values(v).forEach((x) => handlers(x, out)); }
      return out;
    };
    const switchOf = (side) => bindings.some((b) => b.handlerId === 'cn.switch@1' && b.parameters?.side === side);
    const f = {
      d, kind: d.kind, category: m.category ?? null, stage: m.stage ?? null, hp: m.hp ?? 0, prizes: m.prizeCount ?? 1,
      attacks: (m.attacks ?? []).map((a) => ({ attackId: a.attackId, cost: a.cost, damage: a.printedDamage?.value ?? 0,
        copies: handlers(a.effects).includes('cn.copyAttack@1') })),
      perCard: perCard(m.attacks ?? []),
      draws: has(DRAW), attaches: has(ATTACH), heals: has(HEAL), gust: switchOf('opponent'), switchOwn: switchOf('own'),
      discardsHand: bindings.some((b) => b.handlerId === 'cn.discardHand@1'),
      fetches: bindings.some((b) => b.handlerId === 'cn.cards@1' && ['deck', 'discard'].includes(b.parameters?.from) &&
        ['hand', 'bench'].includes(b.parameters?.to)),
      selfKnockOut: bindings.some((b) => b.handlerId === 'cn.knockOut@1'),
      energyType: d.kind === 'energy' && m.category === 'basic' ? m.baseUnits[0][0] : null,
      units: d.kind === 'energy' ? m.baseUnits : null,
    };
    cache.set(definitionId, f);
    return f;
  };
  const attached = (mon) => mon.effective.energies?.length ?? mon.energy.length;
  const types = (mon) => mon.effective.types ?? [];
  const attacksOf = (mon) => facts(top(mon).definitionId).attacks;
  const unitsOf = (mon) => (mon.effective.energies ?? []).flatMap((e) => e.units);
  /** Energy units still missing for an attack (its cheapest payment route, as the engine works it out), given the units
   * attached plus `extra` (a card about to be attached). Types are matched: a unit pays a typed cost if it can provide
   * that type, and anything left over pays Colorless. */
  const missingFor = (mon, attackId, extra = []) => {
    const requirement = mon.effective.attackRequirements?.find((r) => r.attackId === attackId);
    const routes = requirement?.routes ?? [];
    if (!routes.length) return requirement ? Infinity : 0;
    const units = [...unitsOf(mon), ...extra];
    return Math.min(...routes.map(({ counts }) => {
      const need = { ...counts }, colorless = need.Colorless ?? 0;
      delete need.Colorless;
      let spare = 0;
      for (const unit of [...units].sort((a, b) => a.length - b.length)) {
        const type = unit.find((t) => need[t] > 0);
        if (type) need[type]--; else spare++;
      }
      return Object.values(need).reduce((n, k) => n + k, 0) + Math.max(0, colorless - spare);
    }));
  };
  // A printed attack's damage to a defender: the printed number (per unit for 「×」 attacks, counted once), Weakness and Resistance.
  const damageTo = (attack, mon, defender) => {
    let n = attack.damage;
    if (!defender || !n) return n;
    const w = defender.effective.weakness, r = defender.effective.resistance;
    if (w && types(mon).includes(w.type)) n = w.operation === 'multiply' ? n * w.value : n + w.value;
    if (r && types(mon).includes(r.type)) n += r.value;
    return Math.max(0, n);
  };
  /** The most damage `mon` can do to `defender` with what is attached (plus `extra` units). */
  const bestDamage = (mon, defender, extra = []) =>
    Math.max(0, ...attacksOf(mon).filter((a) => missingFor(mon, a.attackId, extra) === 0).map((a) => damageTo(a, mon, defender)));
  /** The most damage any of its attacks could do, attached Energy aside. */
  const potential = (mon, defender) => Math.max(0, ...attacksOf(mon).map((a) => damageTo(a, mon, defender)));
  /** Units missing for its strongest attack (0: ready). */
  const deficit = (mon) => {
    const list = attacksOf(mon);
    if (!list.length) return 0;
    const top = list.reduce((a, b) => (b.damage > a.damage ? b : a));
    return Math.min(9, missingFor(mon, top.attackId));
  };
  /** How many units an Energy card would bring closer the strongest attack it helps (0: it helps none). */
  const energyGain = (mon, units) => Math.max(0, ...attacksOf(mon).map((a) => missingFor(mon, a.attackId) - missingFor(mon, a.attackId, units)));
  const needsType = (mon, type) => attacksOf(mon).some((a) => a.cost.includes(type));
  const strength = (mon, defender) => potential(mon, defender) + mon.effective.currentHp / 4 +
    (facts(top(mon).definitionId).stage === 'basic' ? 0 : 20);
  /** Whether `mon` could Knock Out `defender` on its next attack, with at most one more Energy attached. */
  const threatens = (mon, defender) => !!mon && !!defender && attacksOf(mon).some((a) =>
    missingFor(mon, a.attackId) <= 1 && damageTo(a, mon, defender) >= defender.effective.currentHp);
  return { facts, attached, missingFor, damageTo, bestDamage, potential, deficit, energyGain, needsType, strength, threatens };
}
