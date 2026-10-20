// Deterministic CPU opponent for CN/V20261019 official mode. It reads ONLY its
// own player view (no hidden cards, RNG or snapshot) plus the approved catalog
// and returns one command action. Strategy is heuristic; rules come from the engine.

const ATTACKER_PRIORITY = ['raging-bolt-ex', 'pikachu-ex', 'dragapult-ex', 'teal-mask-ogerpon-ex', 'raging-bolt', 'iron-leaves-ex',
  'bloodmoon-ursaluna-ex', 'latias-ex', 'dusknoir', 'slither-wing', 'chien-pao', 'lanturn', 'thundurus', 'zeraora', 'fezandipiti-ex',
  'munkidori', 'mew-ex', 'drakloak', 'flaaffy', 'emolga', 'mareep', 'squawkabilly-ex', 'hawlucha', 'dusclops', 'chatot', 'chinchou',
  'shaymin', 'dreepy', 'duskull', 'budew', 'ditto'];
const CARD_VALUE = {
  'pikachu-ex': 100, flaaffy: 70, lanturn: 60, mareep: 55, thundurus: 50, zeraora: 50, chinchou: 45, emolga: 40, chatot: 35,
  'professors-research': 60, nemona: 50, 'ultra-ball': 50, 'nest-ball': 45, 'electric-generator': 45, youngster: 45,
  'cynthias-resolve': 40, 'pokemon-catcher': 40, switch: 35, 'trekking-shoes': 35, judge: 30, 'vitality-band': 30,
  'energy-search': 30, 'basic-lightning-energy': 25,
  'raging-bolt-ex': 110, 'teal-mask-ogerpon-ex': 90, 'raging-bolt': 60, 'iron-leaves-ex': 55, 'latias-ex': 50, 'mew-ex': 50,
  'fezandipiti-ex': 45, 'slither-wing': 40, 'chien-pao': 35, 'squawkabilly-ex': 30, ditto: 10,
  'professor-sadas-vitality': 75, 'earthen-vessel': 55, crispin: 55, 'bosss-orders': 50, 'prime-catcher': 50,
  'pokegear-3-0': 35, 'night-stretcher': 35, 'superior-energy-retrieval': 30, 'pal-pad': 15, 'area-zero-underdepths': 25,
  'basic-grass-energy': 20, 'basic-fighting-energy': 25,
  'dragapult-ex': 110, drakloak: 70, dreepy: 60, dusknoir: 60, dusclops: 50, duskull: 40, 'bloodmoon-ursaluna-ex': 55, munkidori: 45,
  hawlucha: 35, shaymin: 30, budew: 30, 'buddy-buddy-poffin': 45, 'poke-pad': 45, 'counter-catcher': 40, iono: 45,
  'lillies-determination': 60, 'jamming-tower': 20, 'luminous-energy': 40, 'neo-upper-energy': 45, 'basic-fire-energy': 30,
  'basic-psychic-energy': 30,
};
const DRAW_SUPPORTERS = ['lillies-determination', 'professors-research', 'youngster', 'nemona', 'iono', 'cynthias-resolve', 'judge'];

export function createAI(catalog) {
  const def = (card) => catalog.definition(card.definitionId);
  const key = (card) => def(card).nameKey;
  const value = (card) => card ? CARD_VALUE[key(card)] ?? 20 : 0;
  const top = (mon) => mon.stack.at(-1);
  const units = (mon) => mon.energy.length;
  const attacks = (mon) => def(top(mon)).mechanics.attacks ?? [];
  const isBasicEnergy = (card) => def(card).kind === 'energy' && def(card).mechanics.category === 'basic';
  const energyType = (card) => def(card).mechanics.baseUnits?.[0]?.[0];
  const tags = (mon) => def(top(mon)).mechanics.tags ?? [];
  const mons = (p) => [p.active, ...p.bench].filter((m) => m && !m.faceDown);
  // Rough damage estimate from the printed column and the board, for ranking only.
  const estimate = (attack, mon, view, me) => {
    const mine = view.players[me], foe = view.players[1 - me];
    const field = mons(mine).reduce((n, m) => n + m.energy.filter(isBasicEnergy).length, 0);
    const pd = attack.printedDamage;
    if (attack.attackId.endsWith(':bellowing-thunder')) return 70 * field;
    if (attack.attackId.endsWith(':myriad-leaf-shower')) return 30 + 30 * (units(mon) + (foe.active ? units(foe.active) : 0));
    if (attack.attackId.endsWith(':thundering-bolt')) return 30 * units(mon);
    if (attack.attackId.endsWith(':cruel-arrow')) return 100;
    if (attack.attackId.endsWith(':genome-hacking') && foe.active)
      return Math.max(0, ...attacks(foe.active).filter((a) => !a.attackId.endsWith(':genome-hacking')).map((a) => estimate(a, foe.active, view, me)));
    return pd?.value ?? 0;
  };
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
    const energyCards = (q.energy ?? []).map((e) => e.card);
    const cardOf = (id) => [...(mine.hand || []), ...(q.cards || []), ...(q.lookedAt || []), ...mine.discard, ...energyCards]
      .find((c) => c.instanceId === id);
    const count = q.minimum;
    const effect = q.effect?.effectId ?? '';
    switch (q.kind) {
      case 'choose-order': return pick(['second']);
      case 'mulligan-bonus': return pick([q.options.at(-1)]);
      case 'setup-active': {
        const ranked = [...q.options].sort((a, b) => {
          const da = def(cardOf(a)), db = def(cardOf(b));
          const score = (d) => (d.nameKey === 'ditto' ? 400 : 0) + d.mechanics.hp - (d.mechanics.ruleBox ? 150 : 0) - d.mechanics.retreatCost * 10;
          return score(db) - score(da);
        });
        return pick([ranked[0]]);
      }
      case 'setup-bench': return pick(q.options.filter((id) => key(cardOf(id)) !== 'ditto').slice(0, q.maximum));
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
      case 'bench-trim': {
        const ranked = q.options.map((id) => findMon(view, id).mon).sort((a, b) => value(top(a)) - value(top(b)));
        return pick(ranked.slice(0, count).map((m) => m.id));
      }
      case 'counter-allocation': {
        // Knock Out the cheapest targets first; leftovers go to the most damaged one.
        const targets = q.counterAllocation.targets.map((t) => findMon(view, t.pokemonId).mon)
          .sort((a, b) => a.effective.currentHp - b.effective.currentHp);
        let left = q.counterAllocation.total;
        const allocations = [];
        for (const mon of targets) {
          const need = Math.ceil(mon.effective.currentHp / 10);
          if (need <= left) { allocations.push({ pokemonId: mon.id, count: need }); left -= need; }
        }
        if (left > 0) {
          const rest = targets.find((mon) => !allocations.some((a) => a.pokemonId === mon.id));
          if (rest) allocations.push({ pokemonId: rest.id, count: left });
          else allocations.at(-1).count += left;
        }
        return { type: 'allocateCounters', requestId: q.id, allocations };
      }
      case 'counter-count': return pick([q.options.at(-1)]);
      case 'counter-origin': {
        const ranked = q.options.map((id) => findMon(view, id).mon).sort((a, b) => b.counters - a.counters);
        return pick([ranked[0].id]);
      }
      case 'counter-destination': {
        const ranked = q.options.map((id) => findMon(view, id).mon).sort((a, b) => a.effective.currentHp - b.effective.currentHp);
        return pick([ranked[0].id]);
      }
      case 'copy-attack': {
        const ranked = [...(q.attacks ?? [])].sort((a, b) => (b.printedDamage?.value ?? 0) - (a.printedDamage?.value ?? 0));
        return pick([ranked[0]?.optionId ?? q.options[0]]);
      }
      case 'effect-target': case 'damage-targets': {
        const found = q.options.map((id) => findMon(view, id)).filter(Boolean);
        if (found.length && found[0].owner !== me) {
          // Bring up / hit the opposing Pokémon that is easiest to Knock Out.
          found.sort((a, b) => a.mon.effective.currentHp - b.mon.effective.currentHp);
          return pick(found.slice(0, Math.max(count, 1)).map((m) => m.mon.id));
        }
        found.sort((a, b) => byBestAttacker(a.mon, b.mon));
        return pick(found.slice(0, Math.max(count, 1)).map((m) => m.mon.id));
      }
      case 'select-cards': {
        const fromHand = q.options.every((id) => handIds.has(id));
        const ranked = [...q.options].sort((a, b) => value(cardOf(b)) - value(cardOf(a)));
        if (fromHand) return pick(ranked.reverse().slice(0, count));
        return pick(ranked.slice(0, Math.max(count, q.maximum)));
      }
      case 'inspect-deck': {
        if (!effect.includes('trainer:crispin')) return pick(q.options.slice(0, q.maximum));
        // 赤松 requires Basic Energy cards of different types.
        const chosen = [], seen = new Set();
        const ranked = [...q.options].sort((a, b) => value(cardOf(b)) - value(cardOf(a)));
        for (const id of ranked) {
          const card = cardOf(id), type = card && isBasicEnergy(card) ? energyType(card) : id;
          if (chosen.length < q.maximum && !seen.has(type)) { chosen.push(id); seen.add(type); }
        }
        return pick(chosen.length >= q.minimum ? chosen : q.options.slice(0, q.minimum));
      }
      case 'hand-energy': case 'discard-energy': {
        const ranked = [...q.options].sort((a, b) => value(cardOf(b)) - value(cardOf(a)));
        return pick(ranked.slice(0, q.maximum));
      }
      case 'attached-energy': {
        const pool = q.energy ?? [];
        const onActive = (e) => e.originId === mine.active?.id;
        if (q.effect?.op === 'discardEnergy' && opponent.active) {
          // Counted discard: just enough Basic Energy for a Knock Out, Bench first.
          const neededCards = Math.ceil(opponent.active.effective.currentHp / 70);
          const ordered = [...pool].sort((a, b) => Number(onActive(a)) - Number(onActive(b)));
          return pick(ordered.slice(0, Math.max(q.minimum, Math.min(neededCards, q.maximum))).map((e) => e.card.instanceId));
        }
        if (q.effect?.op === 'moveEnergy') return pick(pool.slice(0, Math.min(q.maximum, 3)).map((e) => e.card.instanceId));
        return pick(q.options.slice(0, Math.max(count, Math.min(q.maximum, 1))));
      }
      case 'energy-recipient': case 'deck-energy-recipient': case 'incoming-energy-recipient': {
        if (q.options.length === 1) return pick([q.options[0]]);
        const candidates = q.options.filter((id) => id !== '@hand').map((id) => findMon(view, id).mon)
          .sort((a, b) => priority(a) - priority(b) || need(b) - need(a));
        return pick([candidates[0].id]);
      }
      case 'trigger-optional': {
        // Do not discard our own Stadium; only take the Active Spot when the Active cannot attack.
        const trigger = q.triggers?.[0];
        if (trigger?.abilityId?.endsWith(':snow-sink')) return pick([view.stadium && view.stadium.owner !== me ? 'perform' : 'skip']);
        if (trigger?.abilityId?.endsWith(':rapid-vernier'))
          return pick([mine.active && mine.active.effective.attackRequirements.some((r) => r.routes.length) ? 'skip' : 'perform']);
        return pick([q.options[0]]);
      }
      case 'optional-effect': case 'before-hand-optional': return pick([q.options[0]]);
      case 'view-cards': return pick(['confirm']);
      default: return pick(q.options.slice(0, Math.max(count, Math.min(q.maximum, 1))));
    }
  }

  function mainAction(view, me) {
    const legal = view.legalActions, mine = view.players[me], opponent = view.players[1 - me];
    const hand = new Map(mine.hand.map((c) => [c.instanceId, c]));
    const find = (type, test = () => true) => legal.filter((a) => a.type === type && test(a));
    const trainer = (nameKey) => find('playTrainer', (a) => key(hand.get(a.cardId)) === nameKey)[0];
    const inPlay = mons(mine);
    const activeDamage = bestDamage(mine.active);
    const benchReady = mine.bench.filter((m) => bestDamage(m) > activeDamage);
    const ability = (suffix) => find('useAbility', (a) => a.abilityId.endsWith(suffix))[0];
    const handOf = (test) => [...hand.values()].filter(test);
    // Stop optional drawing well before the deck runs out (the deck-out loss is real).
    const thin = mine.deckCount <= 10 || hand.size >= 8;

    const transform = ability(':transformative-start');
    if (transform) return transform;
    const evolve = find('evolve')[0];
    if (evolve) return evolve;
    const bench = find('bench', (a) => key(hand.get(a.cardId)) !== 'ditto')
      .sort((a, b) => value(hand.get(b.cardId)) - value(hand.get(a.cardId)))[0];
    if (bench) return bench;
    if (mine.bench.length < mine.benchLimit - 1) for (const nameKey of ['nest-ball', 'buddy-buddy-poffin'])
      if (trainer(nameKey)) return trainer(nameKey);
    for (const nameKey of ['trekking-shoes', 'electric-generator']) if (trainer(nameKey)) return trainer(nameKey);
    const tera = inPlay.some((m) => tags(m).includes('Tera'));
    const zero = trainer('area-zero-underdepths');
    if (zero && tera && (!view.stadium || view.stadium.owner !== me)) return zero;
    const squawk = ability(':squawk-and-seize');
    if (squawk && hand.size <= 4 && !thin) return squawk;
    const dance = ability(':teal-dance');
    if (dance && mine.deckCount > 6) return dance;
    if (ability(':flip-the-script') && !thin) return ability(':flip-the-script');
    const pokemonInHand = handOf((c) => def(c).kind === 'pokemon').length;
    const ultra = trainer('ultra-ball');
    if (ultra && pokemonInHand < 2 && hand.size >= 4) return ultra;
    const pad = trainer('poke-pad');
    if (pad && pokemonInHand < 2) return pad;
    const recon = ability(':recon-directive');
    if (recon && mine.deckCount > 6) return recon;
    // 咒怨炸弹 Knocks Out its user: only when it Knocks Out something and cannot hand the opponent the game.
    for (const blast of find('useAbility', (a) => a.abilityId.endsWith(':cursed-blast'))) {
      const user = mons(mine).find((m) => m.id === blast.pokemonId), damage = key(top(user)) === 'dusknoir' ? 130 : 50;
      const given = def(top(user)).mechanics.prizeCount;
      if (mons(mine).length > 1 && opponent.prizes.count > given &&
          mons(opponent).some((m) => m.effective.currentHp > 0 && m.effective.currentHp <= damage)) return blast;
    }
    const brain = ability(':adrena-brain');
    if (brain && mons(mine).some((m) => m.counters > 0)) return brain;
    const energyInHand = handOf((c) => def(c).kind === 'energy').length;
    for (const nameKey of ['earthen-vessel', 'energy-search']) {
      const a = trainer(nameKey);
      if (a && energyInHand < 2 && hand.size >= (nameKey === 'earthen-vessel' ? 2 : 1)) return a;
    }
    const ancientNeeding = inPlay.some((m) => tags(m).includes('Ancient'));
    const discardEnergy = mine.discard.filter(isBasicEnergy).length;
    if (find('playTrainer', (a) => def(hand.get(a.cardId)).mechanics.category === 'supporter').length) {
      const sada = trainer('professor-sadas-vitality');
      if (sada && ancientNeeding && discardEnergy > 0) return sada;
      const crispin = trainer('crispin');
      if (crispin && energyInHand < 2) return crispin;
    }
    const gear = trainer('pokegear-3-0');
    if (gear && !handOf((c) => def(c).kind === 'trainer' && def(c).mechanics.category === 'supporter').length) return gear;
    const retrieval = trainer('superior-energy-retrieval');
    if (retrieval && discardEnergy >= 3 && hand.size >= 5) return retrieval;
    const stretcher = trainer('night-stretcher');
    if (stretcher && pokemonInHand === 0 && mine.discard.some((c) => def(c).kind === 'pokemon')) return stretcher;
    const restart = ability(':restart');
    if (restart && !thin) return restart;
    const other = find('useAbility', (a) =>
      !/:(squawk-and-seize|restart|flip-the-script|teal-dance|cursed-blast|adrena-brain|recon-directive)$/.test(a.abilityId))[0];
    if (other) return other;
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
    const tower = trainer('jamming-tower');
    if (tower && (!view.stadium || view.stadium.owner !== me)) return tower;
    const supporterOrder = thin ? [] : hand.size <= 4 ? DRAW_SUPPORTERS :
      ['nemona', 'cynthias-resolve', 'youngster', 'judge'];
    for (const nameKey of supporterOrder) {
      const a = trainer(nameKey);
      if (a && (nameKey !== 'cynthias-resolve' || mons(opponent).length >= 3)) return a;
    }
    const attack = find('attack').map((a) => {
      const printed = attacks(mine.active).find((x) => x.attackId === a.attackId);
      return { a, damage: printed ? estimate(printed, mine.active, view, me) : 0 };
    }).sort((x, y) => y.damage - x.damage)[0];
    if (!attack && benchReady.length) {
      const swap = trainer('switch') ?? find('retreat')[0];
      if (swap) return swap;
    }
    if (attack && attack.damage === 0 && thin) return { type: 'endTurn' };
    if (attack) {
      const weak = opponent.bench.some((m) => m.effective.currentHp <= attack.damage && m.effective.currentHp < opponent.active.effective.currentHp);
      for (const nameKey of ['bosss-orders', 'prime-catcher', 'counter-catcher', 'pokemon-catcher']) {
        const gust = trainer(nameKey);
        if (gust && weak && (nameKey !== 'prime-catcher' || mine.bench.length)) return gust;
      }
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
