// Deterministic CPU opponent for CN/V20261019 official mode. It reads ONLY its
// own player view (no hidden cards, RNG or snapshot) plus the approved catalog
// and returns one command action. Strategy is heuristic; rules come from the engine.

const ATTACKER_PRIORITY = ['pikachu-ex', 'lanturn', 'thundurus', 'zeraora', 'flaaffy', 'emolga', 'mareep', 'chatot', 'chinchou'];
const CARD_VALUE = {
  'pikachu-ex': 100, flaaffy: 70, lanturn: 60, mareep: 55, thundurus: 50, zeraora: 50, chinchou: 45, emolga: 40, chatot: 35,
  'professors-research': 60, nemona: 50, 'ultra-ball': 50, 'nest-ball': 45, 'electric-generator': 45, youngster: 45,
  'cynthias-resolve': 40, 'pokemon-catcher': 40, switch: 35, 'trekking-shoes': 35, judge: 30, 'vitality-band': 30,
  'energy-search': 30, 'basic-lightning-energy': 25,
};

export function createAI(catalog) {
  const def = (card) => catalog.definition(card.definitionId);
  const key = (card) => def(card).nameKey;
  const value = (card) => CARD_VALUE[key(card)] ?? 20;
  const top = (mon) => mon.stack.at(-1);
  const units = (mon) => mon.energy.length;
  const attacks = (mon) => def(top(mon)).mechanics.attacks ?? [];
  const bestDamage = (mon, energy = units(mon)) => Math.max(0, ...attacks(mon)
    .filter((a) => a.cost.length <= energy).map((a) => a.printedDamage?.value ?? 0));
  const need = (mon) => {
    const costs = attacks(mon).map((a) => a.cost.length);
    return costs.length ? Math.max(0, Math.max(...costs) - units(mon)) : 0;
  };
  const priority = (mon) => {
    const i = ATTACKER_PRIORITY.indexOf(key(top(mon)));
    return i < 0 ? ATTACKER_PRIORITY.length : i;
  };
  const byBestAttacker = (a, b) => bestDamage(b) - bestDamage(a) || priority(a) - priority(b) || units(b) - units(a);

  function findMon(view, id) {
    for (const [owner, p] of view.players.entries())
      for (const mon of [p.active, ...p.bench]) if (mon && !mon.faceDown && mon.id === id) return { owner, mon };
    return null;
  }

  function answerPending(view, me) {
    const q = view.pending, mine = view.players[me], opponent = view.players[1 - me];
    const pick = (ids) => ({ type: 'answer', requestId: q.id, selected: ids });
    const handIds = new Set(Array.isArray(mine.hand) ? mine.hand.map((c) => c.instanceId) : []);
    const cardOf = (id) => [...(mine.hand || []), ...(q.cards || []), ...(q.lookedAt || []), ...mine.discard]
      .find((c) => c.instanceId === id);
    const count = q.minimum;
    switch (q.kind) {
      case 'choose-order': return pick(['second']);
      case 'mulligan-bonus': return pick([q.options.at(-1)]);
      case 'setup-active': {
        const ranked = [...q.options].sort((a, b) => {
          const da = def(cardOf(a)), db = def(cardOf(b));
          const score = (d) => d.mechanics.hp - (d.mechanics.ruleBox ? 150 : 0) - d.mechanics.retreatCost * 10;
          return score(db) - score(da);
        });
        return pick([ranked[0]]);
      }
      case 'setup-bench': return pick(q.options.slice(0, q.maximum));
      case 'promote': case 'retreat-target': {
        const ranked = q.options.map((id) => findMon(view, id).mon).sort(byBestAttacker);
        return pick([ranked[0].id]);
      }
      case 'retreat-energy': return pick(q.options.slice(0, Math.max(count, mine.active.effective.retreatCost)));
      case 'tool-target': return pick([q.options.includes(mine.active?.id) ? mine.active.id : q.options[0]]);
      case 'activation-cost': {
        const choices = q.payment.groups.flatMap((g) => g.choices).sort((a, b) => value(a.card) - value(b.card));
        return pick(choices.slice(0, count).map((c) => c.optionId));
      }
      case 'effect-target': case 'damage-targets': {
        const mons = q.options.map((id) => findMon(view, id)).filter(Boolean);
        if (mons.length && mons[0].owner !== me) {
          // Bring up the opposing Pokémon that is easiest to Knock Out.
          mons.sort((a, b) => a.mon.effective.currentHp - b.mon.effective.currentHp);
          return pick(mons.slice(0, Math.max(count, 1)).map((m) => m.mon.id));
        }
        mons.sort((a, b) => byBestAttacker(a.mon, b.mon));
        return pick(mons.slice(0, Math.max(count, 1)).map((m) => m.mon.id));
      }
      case 'select-cards': {
        const fromHand = q.options.every((id) => handIds.has(id));
        const ranked = [...q.options].sort((a, b) => value(cardOf(b)) - value(cardOf(a)));
        if (fromHand) return pick(ranked.reverse().slice(0, count));
        return pick(ranked.slice(0, Math.max(count, Math.min(q.maximum, 1))));
      }
      case 'inspect-deck': return pick(q.options.slice(0, q.maximum));
      case 'hand-energy': case 'discard-energy': return pick(q.options.slice(0, q.maximum));
      case 'energy-recipient': case 'deck-energy-recipient': case 'incoming-energy-recipient': {
        const mons = q.options.map((id) => findMon(view, id).mon)
          .sort((a, b) => priority(a) - priority(b) || need(b) - need(a));
        return pick([mons[0].id]);
      }
      case 'optional-effect': case 'trigger-optional': case 'before-hand-optional': return pick([q.options[0]]);
      case 'view-cards': return pick(['confirm']);
      default: return pick(q.options.slice(0, Math.max(count, Math.min(q.maximum, 1))));
    }
  }

  function mainAction(view, me) {
    const legal = view.legalActions, mine = view.players[me], opponent = view.players[1 - me];
    const hand = new Map(mine.hand.map((c) => [c.instanceId, c]));
    const find = (type, test = () => true) => legal.filter((a) => a.type === type && test(a));
    const trainer = (nameKey) => find('playTrainer', (a) => key(hand.get(a.cardId)) === nameKey)[0];
    const inPlay = [mine.active, ...mine.bench].filter(Boolean);
    const activeDamage = bestDamage(mine.active);
    const benchReady = mine.bench.filter((m) => bestDamage(m) > activeDamage);

    const evolve = find('evolve')[0];
    if (evolve) return evolve;
    const bench = find('bench').sort((a, b) => value(hand.get(b.cardId)) - value(hand.get(a.cardId)))[0];
    if (bench) return bench;
    for (const nameKey of ['nest-ball', 'trekking-shoes', 'electric-generator']) {
      const a = trainer(nameKey);
      if (a && (nameKey !== 'nest-ball' || mine.bench.length < 4)) return a;
    }
    const pokemonInHand = [...hand.values()].filter((c) => def(c).kind === 'pokemon').length;
    const ultra = trainer('ultra-ball');
    if (ultra && pokemonInHand < 2 && hand.size >= 4) return ultra;
    const energyInHand = [...hand.values()].some((c) => def(c).kind === 'energy');
    const search = trainer('energy-search');
    if (search && !energyInHand) return search;
    const ability = find('useAbility')[0];
    if (ability) return ability;
    const attach = find('attachEnergy');
    if (attach.length) {
      const target = (id) => inPlay.find((m) => m.id === id);
      attach.sort((a, b) => {
        const ma = target(a.pokemonId), mb = target(b.pokemonId);
        const score = (m) => (m === mine.active ? 2 : 0) * (need(m) > 0 ? 1 : 0) + (need(m) > 0 ? 1 : 0) - priority(m) / 10;
        return score(mb) - score(ma);
      });
      return attach[0];
    }
    const band = trainer('vitality-band');
    if (band && !mine.active.tools.length) return band;
    const supporterOrder = hand.size <= 4 ?
      ['professors-research', 'youngster', 'nemona', 'cynthias-resolve', 'judge'] :
      ['nemona', 'cynthias-resolve', 'youngster', 'judge'];
    for (const nameKey of supporterOrder) {
      const a = trainer(nameKey);
      if (a && (nameKey !== 'cynthias-resolve' || [opponent.active, ...opponent.bench].filter(Boolean).length >= 3)) return a;
    }
    const attack = find('attack').map((a) => ({ a, damage: attacks(mine.active).find((x) => x.attackId === a.attackId)?.printedDamage?.value ?? 0 }))
      .sort((x, y) => y.damage - x.damage)[0];
    if (!attack && benchReady.length) {
      const swap = trainer('switch') ?? find('retreat')[0];
      if (swap) return swap;
    }
    if (attack) {
      const catcher = trainer('pokemon-catcher');
      const weak = opponent.bench.some((m) => m.effective.currentHp <= attack.damage && m.effective.currentHp < opponent.active.effective.currentHp);
      if (catcher && weak) return catcher;
      return attack.a;
    }
    return { type: 'endTurn' };
  }

  return function decide(view, me) {
    if (view.result) return null;
    if (view.pending) return answerPending(view, me);
    if (view.legalActions.length) return mainAction(view, me);
    return null;
  };
}
