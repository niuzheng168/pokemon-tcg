// A fast general player: the moves of a simulation's later turns, and the lower difficulty levels. It reads only its
// player's view and the card definitions (cost, damage, HP, which effects a card has), never card names, so a new card
// needs no new code here. `noise` (0–1) blurs its preferences; 1 is close to choosing at random.
import { randomIndex } from '../public/rules/random.js';
import { boardReader, mons, top } from './board.mjs';

export function createPolicy(catalog, { noise = 0, seed = [9, 7, 5, 3] } = {}) {
  const { facts, damageTo, bestDamage, copyDamage, readyDamage, deficit, energyGain, missingFor, needsType, strength } = boardReader(catalog);
  const rng = [...seed];
  const jitter = () => noise ? noise * randomIndex(rng, 1000) / 10 : 0;
  const best = (items, score) => items.map((x) => [x, score(x) + jitter()]).sort((a, b) => b[1] - a[1])[0]?.[0];
  const pickN = (items, n, score) => items.map((x) => [x, score(x) + jitter()]).sort((a, b) => b[1] - a[1]).slice(0, n).map(([x]) => x);
  /** How much a card is worth keeping, to this player now (high: keep or fetch; low: discard). */
  const value = (card, mine) => {
    const f = facts(card.definitionId);
    if (f.kind === 'pokemon') {
      const evolves = f.stage !== 'basic' && mons(mine).some((m) => facts(top(m).definitionId).d.nameKey === f.d.mechanics.evolvesFrom);
      return 30 + (f.stage === 'basic' ? 0 : 15) + Math.max(0, ...f.attacks.map((a) => a.damage)) / 10 + (evolves ? 30 : 0);
    }
    if (f.kind === 'energy') return f.energyType ? 25 + (mons(mine).some((m) => needsType(m, f.energyType)) ? 15 : 0) : 35;
    return { supporter: 45, item: 35, tool: 25, stadium: 20 }[f.category] + (f.draws || f.fetches ? 10 : 0) + (f.gust ? 10 : 0);
  };

  function findMon(view, id) {
    for (const [owner, p] of view.players.entries()) for (const m of mons(p)) if (m.id === id) return { owner, mon: m };
    return null;
  }

  // How much the policy likes each main-phase move now (no noise).
  function scorer(view, me) {
    const mine = view.players[me], foe = view.players[1 - me], legal = view.legalActions.filter((a) => a.type !== 'concede');
    const hand = new Map((mine.hand ?? []).map((c) => [c.instanceId, c]));
    const attacks = legal.filter((a) => a.type === 'attack');
    const myDamage = mine.active ? bestDamage(mine.active, foe.active) : 0;
    const canAttack = attacks.length > 0;
    // A deck too thin to draw from freely: about two cards a turn for the turns the game may still last.
    const thin = mine.deckCount <= Math.max(8, 4 + 2 * (mine.prizes.count ?? mine.prizes.length ?? 0));
    const koActive = !!foe.active && foe.active.effective.currentHp <= myDamage;
    const koTarget = !koActive && foe.bench.some((m) => !m.faceDown && m.effective.currentHp <= myDamage);
    // A Benched Pokémon that can attack for more than the Active (switching to it is worth a move).
    const better = mine.bench.some((m) => readyDamage(m, mine, foe) > myDamage);
    const score = (a) => {
      const card = a.cardId && hand.get(a.cardId), f = card && facts(card.definitionId);
      switch (a.type) {
        case 'endTurn': return 0;
        case 'evolve': return 90;
        case 'bench': return mine.bench.length < mine.benchLimit - 1 ? 80 : 15;
        case 'useAbility': {
          const user = facts(top(findMon(view, a.pokemonId)?.mon ?? mine.active).definitionId);
          if (user.thinsDeck && thin) return -1;
          // Switching my Active, like a switch card: only for a Benched Pokémon that attacks for more.
          if (user.switchOwn) return !canAttack && better ? 60 : -1;
          return f?.selfKnockOut || user.selfKnockOut ? 3 : 70;
        }
        case 'useStadium': return 40;
        case 'vUnion': case 'recallCard': return 30;
        case 'attachEnergy': {
          const target = findMon(view, a.pokemonId)?.mon;
          if (!target || !f?.units) return 10;
          // Energy that brings an attack closer, most of all one that makes it ready (an attack that copies others
          // counts); the Active first.
          const gain = energyGain(target, f.units);
          const ready = facts(top(target).definitionId).attacks.some((x) => (x.damage > 0 || x.copies) && missingFor(target, x.attackId) > 0 &&
            missingFor(target, x.attackId, f.units) === 0);
          // Basic Energy is the damage of an attack that discards it from the hand: attached only to make an attack ready.
          if (f.energyType && !ready && mons(mine).some((m) => facts(top(m).definitionId).handAmmo)) return -1;
          return (gain ? 45 + 10 * gain : 20) + (ready ? 20 : 0) + (target === mine.active ? 8 : 0) + strength(target, foe.active) / 40;
        }
        case 'playTrainer': {
          if (!f) return 20;
          if (f.gust) return koTarget && canAttack ? 75 : 4;
          if (f.switchOwn) return !canAttack && better ? 60 : 3;
          if (f.heals) return mons(mine).some((m) => m.counters >= 5) ? 45 : 2;
          // Not at all from a thin deck (below ending the turn): decking out loses the game.
          if (f.thinsDeck && thin) return -1;
          if (f.discardsHand) return hand.size <= 4 ? 50 : 12;
          if (f.category === 'supporter') return f.draws ? 55 - hand.size : 40;
          if (f.category === 'tool') return 35;
          if (f.category === 'stadium') return !view.stadium || view.stadium.owner !== me ? 30 : 0;
          return f.draws || f.fetches || f.attaches ? 60 : 45;
        }
        case 'retreat': {
          const ready = mine.bench.map((m) => readyDamage(m, mine, foe));
          // To a Pokémon that can attack when the Active cannot, or that Knocks Out when the Active cannot.
          if (!canAttack) return ready.some((d) => d > 0) ? 50 : 0;
          return foe.active && !koActive && ready.some((d) => d >= foe.active.effective.currentHp) ? 50 : 0;
        }
        case 'attack': {
          const at = facts(top(mine.active).definitionId).attacks.find((x) => x.attackId === a.attackId);
          // An attack that copies, with nothing to copy but other copying attacks, would only ask the same again.
          const copied = at?.copies ? copyDamage(mine.active, at, mine, foe, foe.active) : null;
          if (copied === 0) return -1;
          const damage = copied ?? (at ? damageTo(at, mine.active, foe.active) : 0);
          return 10 + Math.min(damage, 300) / 30 + (foe.active && damage >= foe.active.effective.currentHp ? 15 : 0);
        }
        default: return 1;
      }
    };
    return { legal, attacks, score };
  }

  function main(view, me, steps) {
    const { legal, attacks, score } = scorer(view, me);
    if (steps > 40) return attacks[0] ?? { type: 'endTurn' };
    return best(legal, score) ?? { type: 'endTurn' };
  }

  function answer(view, me) {
    const q = view.pending, mine = view.players[me], foe = view.players[1 - me];
    const pick = (ids) => ({ type: 'answer', requestId: q.id, selected: ids });
    const cards = [...(mine.hand ?? []), ...(q.cards ?? []), ...(q.lookedAt ?? []), ...mine.discard, ...(q.energy ?? []).map((e) => e.card)];
    const cardOf = (id) => cards.find((c) => c.instanceId === id);
    const valueOf = (id) => { const c = cardOf(id); return c ? value(c, mine) : 0; };
    const monOf = (id) => findMon(view, id);
    const some = Math.max(q.minimum, Math.min(q.maximum ?? q.minimum, 1));
    const fromHand = q.options.every((id) => (mine.hand ?? []).some((c) => c.instanceId === id));
    // Cards an attack of mine counts for its damage: enough to Knock Out the defender, the least useful first.
    const per = q.effect?.category === 'attack' && q.options.length && mine.active ? facts(top(mine.active).definitionId).perCard.get(q.effect.effectId) : 0;
    if (per > 0) {
      const need = Math.ceil((foe.active?.effective.currentHp ?? per) / per);
      return pick(pickN(q.options, Math.max(q.minimum, Math.min(q.maximum ?? q.options.length, q.options.length, need)), (id) => -valueOf(id)));
    }
    switch (q.kind) {
      case 'choose-order': return pick([q.options.includes('second') ? 'second' : q.options[0]]);
      case 'mulligan-bonus': return pick([q.options.at(-1)]);
      case 'setup-active': return pick([best(q.options, (id) => { const f = facts(cardOf(id).definitionId);
        return f.hp + Math.max(0, ...f.attacks.map((a) => a.damage)) - (f.d.mechanics.ruleBox ? 100 : 0) - f.d.mechanics.retreatCost * 10; })]);
      case 'setup-bench': return pick(pickN(q.options, Math.min(q.maximum, Math.max(q.minimum, 3)), valueOf));
      // The Pokémon that can attack now, the hardest-hitting first; then the closest to attacking.
      case 'promote': case 'retreat-target': return pick([best(q.options, (id) => { const m = monOf(id)?.mon;
        if (!m) return 0;
        const now = readyDamage(m, mine, foe);
        return (now > 0 ? 1000 + now : 0) + strength(m, foe.active) / 4 - deficit(m) * 60; })]);
      case 'retreat-energy': return pick(q.options.slice(0, Math.max(q.minimum, mine.active?.effective.retreatCost ?? 0)));
      case 'activation-cost': {
        const choices = (q.payment?.groups ?? []).flatMap((g) => g.choices);
        return pick(choices.sort((a, b) => value(a.card, mine) - value(b.card, mine)).slice(0, q.minimum).map((c) => c.optionId));
      }
      case 'bench-trim': return pick(pickN(q.options, q.minimum, (id) => { const m = monOf(id)?.mon; return m ? -strength(m) : 0; }));
      case 'counter-allocation': {
        const targets = q.counterAllocation.targets.map((t) => monOf(t.pokemonId).mon).sort((a, b) => a.effective.currentHp - b.effective.currentHp);
        let left = q.counterAllocation.total;
        const allocations = [];
        for (const mon of targets) {
          const need = Math.ceil(mon.effective.currentHp / 10);
          if (need <= left) { allocations.push({ pokemonId: mon.id, count: need }); left -= need; }
        }
        if (left > 0) {
          const rest = targets.find((mon) => !allocations.some((a) => a.pokemonId === mon.id));
          if (rest) allocations.push({ pokemonId: rest.id, count: left }); else allocations.at(-1).count += left;
        }
        return { type: 'allocateCounters', requestId: q.id, allocations };
      }
      case 'counter-count': return pick([q.options.at(-1)]);
      case 'counter-origin': return pick([best(q.options, (id) => monOf(id)?.mon.counters ?? 0)]);
      case 'counter-destination': return pick([best(q.options, (id) => -(monOf(id)?.mon.effective.currentHp ?? 999))]);
      // An attack that copies an attack would only ask the same again: the last choice.
      case 'copy-attack': return pick([best(q.attacks ?? [], (a) => facts(a.card.definitionId).attacks.find((x) => x.attackId === a.attackId)?.copies
        ? -1000 : a.printedDamage?.value ?? 0)?.optionId ?? q.options[0]]);
      case 'effect-target': case 'damage-targets': {
        const found = q.options.map(monOf).filter(Boolean);
        if (!found.length) return pick(q.options.slice(0, some));
        // An opposing Pokémon: the easiest to Knock Out, worth the most Prizes. An own one: the strongest.
        const score = (x) => x.owner !== me ? facts(top(x.mon).definitionId).prizes * 100 - x.mon.effective.currentHp : strength(x.mon, foe.active);
        return pick(pickN(found, some, score).map((x) => x.mon.id));
      }
      case 'select-cards': case 'inspect-deck': case 'hand-energy': case 'discard-energy': {
        // From the hand (usually a cost or a discard): the least useful; from elsewhere: the most useful.
        if (fromHand && q.kind === 'select-cards') return pick(pickN(q.options, q.minimum, (id) => -valueOf(id)));
        return pick(pickN(q.options, q.maximum, valueOf));
      }
      case 'attached-energy': {
        if (q.effect?.op === 'discardEnergy' && foe.active) {
          const pool = [...(q.energy ?? [])].sort((a, b) => Number(a.originId === mine.active?.id) - Number(b.originId === mine.active?.id));
          return pick(pool.slice(0, Math.max(q.minimum, Math.min(Math.ceil(foe.active.effective.currentHp / 70), q.maximum))).map((e) => e.card.instanceId));
        }
        return pick(q.options.slice(0, some));
      }
      case 'energy-recipient': case 'deck-energy-recipient': case 'incoming-energy-recipient': {
        const targets = q.options.filter((id) => id !== '@hand');
        if (!targets.length) return pick([q.options[0]]);
        return pick([best(targets, (id) => { const m = monOf(id)?.mon; return m ? deficit(m) * 10 + strength(m, foe.active) / 10 + (m === mine.active ? 5 : 0) : 0; })]);
      }
      case 'tool-target': return pick([q.options.includes(mine.active?.id) ? mine.active.id : q.options[0]]);
      case 'view-cards': return pick(['confirm']);
      case 'janken': return pick([q.options[randomIndex(rng, q.options.length)]]);
      case 'guess-answer': {
        const seen = [...mons(foe).flatMap((m) => m.stack), ...foe.discard].map((c) => facts(c.definitionId)).filter((f) => f.kind === 'pokemon');
        // Nothing of theirs seen yet: a Pokémon of its own is still a real answer of the asked kind.
        const { question } = q.guess, told = (seen[0] ?? facts(top(mine.active).definitionId)).d;
        const answer = question === 'hp' ? { hp: told.mechanics.hp } : question === 'name' ? { name: told.nameKey } : { type: told.mechanics.types[0] };
        return { type: 'guessAnswer', requestId: q.id, answer };
      }
      case 'coin-face': return pick(['heads']);
      case 'coin-reflip': return pick([q.coins?.results.includes('heads') ? 'keep' : q.options.at(-1)]);
      default: return pick(q.options.slice(0, some));
    }
  }

  /** The move for `me` from its view; `steps` counts this player's moves so far this turn (a guard against loops). */
  function decide(view, me, steps = 0) {
    if (view.result) return null;
    if (view.pending) return answer(view, me);
    return view.legalActions.length ? main(view, me, steps) : null;
  }
  /** The main-phase moves, the ones the policy likes most first (a search's shortlist). */
  decide.rank = (view, me) => {
    const { legal, score } = scorer(view, me);
    return legal.map((a) => [a, score(a)]).sort((x, y) => y[1] - x[1]).map(([a]) => a);
  };
  return decide;
}
