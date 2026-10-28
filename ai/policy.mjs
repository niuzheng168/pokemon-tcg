// A fast general player: the moves of a simulation's later turns, and the lower difficulty levels. It reads only its
// player's view and the card definitions (cost, damage, HP, which effects a card has), never card names, so a new card
// needs no new code here. `noise` (0–1) blurs its preferences; 1 is close to choosing at random.
import { randomIndex } from '../public/rules/random.js';
import { boardReader, mons, top } from './board.mjs';
import { matchesOnePerAlternative, matchesAlternativeLimits, distinctCards } from '../public/rules/card-selection.js';

/**
 * How much the policy likes each kind of move: the scores below, by name (`weights` overrides some). Set by hand, then
 * tuned by self-play (scripts/ai-tune.mjs --target policy, 20,000 deals; 51.9% ±1.8 against the hand-set ones over
 * 3,000 games, docs/ai/STATUS.md).
 */
export const POLICY_WEIGHTS = Object.freeze({
  evolve: 93.1, bench: 78.0, benchLast: 15.0, ability: 71.4, abilitySelfKnockOut: 3.3, switchUp: 66.3,
  switchIdle: 3.2, useStadium: 39.9, special: 30.2, attachGain: 51.3, attachPerUnit: 10.7, attachNoGain: 22.1,
  attachReady: 20.1, attachActive: 8.7, attachStrength: 0.0242, trainerUnknown: 18.1, gustKnockOut: 72.8,
  gustIdle: 3.9, heal: 48.0, healIdle: 2.1, discardHandSmall: 46.7, discardHandBig: 12.4, supporterDraw: 53.3,
  supporterOther: 35.6, tool: 35.4, stadium: 29.3, itemUseful: 52.7, itemOther: 42.1, retreat: 47.7,
  attackBase: 10.1, attackDamage: 0.0326, attackKnockOut: 14.3,
  // Found by a deep search at the policy's decisions (scripts/ai-mistakes.mjs, 2026-10-27; 52.8% ±1.8 against the
  // rules before over 3,000 games): fetching, less for a Basic with no room on the Bench and an Evolution with nothing
  // to evolve from, more for a Basic whose Evolution is in hand; an Energy to the Pokémon closest to attacking (per unit
  // closer), and how much the old rule's units still missing count (it gave Energy to the Pokémon furthest from
  // attacking).
  fetchNoRoom: 25, fetchNoBase: 15, fetchLineBasic: 20, recipientClose: 10, recipientDeficit: 0,
  // The deck's plan (deck-plan.mjs, M7): fetching or benching a Pokémon its goal board still misses, evolving one, a
  // Pokémon off the plan once the Bench is half full (less), Energy to a planned attacker, any Basic Energy when the
  // attacks count Energy discarded from play (1: on), promoting a planned attacker that can attack. Each helped some
  // decks and hurt others (scripts/ai-deck-tune.mjs: a deck tuned there plays with its own, ai/deck-weights.json);
  // the less-off-plan rule hurt decks that bench Pokémon the plan does not name (N的索罗亚克 −5.7), so it is off here.
  planPiece: 25, planBench: 20, planOffBench: 0, planEvolve: 10, planAttach: 10, planAmmo: 1, planPromote: 200,
  // An attack counting discarded Energy does that many times its printed damage (board.mjs damageTo; 1: on).
  countEnergy: 1,
  // The deck's written strategy (deck-plan.mjs strategyOf, by a language model): `strategy` 1 plays with its attackers,
  // goal board and Energy source in place of the inferred ones; the others weigh its orders (1 for the first name of an
  // order): the opening Active, benching, fetching, keeping, discarding (less), promoting, attaching Energy. Off until
  // the arena shows they help (docs/ai/STATUS.md M7).
  strategy: 0, stratOpening: 0, stratBench: 0, stratSearch: 0, stratKeep: 0, stratDiscard: 0, stratPromote: 0, stratAttach: 0,
  // From the reviews of lost games (scripts/ai-review.mjs, M7): evolving a Pokémon whose Ability can still be used this
  // turn (less: use it first, 多龙奇's 侦察指令); evolving a Basic to its Stage 1 while the hand holds the Stage 2 and an
  // item that skips the Stage 1 (less: that item first, 神奇糖果 to 喷火龙ex).
  abilityBeforeEvolve: 40, candyFirst: 60,
  // From the summary of the reviews (all off until the arena shows they help):
  // - pickLimits 1: a search taking several cards takes them within its printed limits (「物品和宝可梦道具各1张」,
  //   「属性各不相同」), the most useful first; without it 派帕 took two Items, the rules refused, and it took nothing;
  // - handTrigger: less for a Pokémon put onto the Bench straight from the deck whose Ability works only when it is put
  //   there from the hand (快速游标);
  // - refreshLast: the most a move that discards or reshuffles the hand scores while other cards can still be played
  //   (英武重抽 first threw away the Balls and Vessels it could have played);
  // - payableOnly 1: Energy counts only toward attacks the deck's Energy can pay for (not 拉帝亚斯ex's in 猛雷鼓), and
  //   toward an Ability that needs it attached (愿增猿: 玛俐的长毛巨魔 lost 11 points without that);
  // - recipientUnits 1: Energy an effect attaches goes to the Pokémon whose attack that Energy brings closest;
  // - gustKO: more for an opposing Pokémon the Active can Knock Out, when choosing one to switch in or hit;
  // - benchReserve: less for benching a Pokémon off the goal board while two Spots or fewer are left and the goal board
  //   still misses Pokémon in play.
  pickLimits: 1, handTrigger: 30, refreshLast: 0, payableOnly: 1, recipientUnits: 1, gustKO: 0, benchReserve: 0,
  // From the second round of reviews (猛雷鼓): weakAttack, Energy counts toward an attack doing less than this share of
  // the main attacker's damage only on a planned attacker (怒鹦哥ex's 20 took the Energy 猛雷鼓ex needed); keepCost, an
  // attack discarding Energy from play keeps the Active's Energy its attacks need (极雷轰 discarded 猛雷鼓ex's own
  // Lightning and Fighting).
  weakAttack: 0, keepCost: 100, recipientHand: 0,
  // Third round (猛雷鼓 at level 4 with the planner): trimming the Bench to fewer Spots kept Pokémon with no Energy
  // and threw away 梦幻ex and 厄诡椪 with theirs; trimEnergy per Energy attached, trimRole for a Pokémon the plan
  // gives a role (attacker, Energy, draw or search engine), both kept first.
  trimEnergy: 30, trimRole: 40,
  // Fourth round (猛雷鼓 against 多龙): countStrength 1, choosing where Energy goes, an attack counting discarded Energy
  // is as strong as the Energy its side has (赤松 gave 铁斑叶ex the Lightning 猛雷鼓ex needed: 极雷轰 counted as 70).
  countStrength: 0,
});

/**
 * `plans(player)`: that player's deck plan (deck-plan.mjs) or null; a policy without it plays every deck alike.
 */
export function createPolicy(catalog, { noise = 0, seed = [9, 7, 5, 3], weights = {}, plans = () => null } = {}) {
  const { facts, damageTo, bestDamage, copyDamage, readyDamage, deficit, energyGain, missingFor, needsType, strength } = boardReader(catalog);
  // The scores for one player: the defaults, its deck plan's own (tuned for that deck), then `weights` over both. Set per
  // decision (decide and rank), since one policy plays both players inside a search.
  const rng = [...seed], base = { ...POLICY_WEIGHTS, ...weights }, merged = new WeakMap();
  const weightsFor = (me) => {
    const plan = plans(me);
    if (!plan?.weights) return base;
    if (!merged.has(plan)) merged.set(plan, { ...POLICY_WEIGHTS, ...plan.weights, ...weights });
    return merged.get(plan);
  };
  let w = base;
  // The plan the policy plays: with the strategy's attackers, goal board and Energy source when `strategy` is on.
  const played = new WeakMap();
  const planOf = (me) => {
    const plan = plans(me);
    if (!w.strategy || !plan?.strategy) return plan;
    if (!played.has(plan)) played.set(plan, { ...plan, attackers: plan.strategy.attackers, goal: plan.strategy.goal, ammo: plan.strategy.ammo ?? plan.ammo });
    return played.get(plan);
  };
  // Effects by id, for what a request does not spell out (「各1张」, 「属性各不相同」, onto the Bench): read once.
  let effects = null;
  const effectOf = (effectId) => {
    if (!effects) {
      effects = new Map();
      (function walk(v) {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') { if (typeof v.effectId === 'string' && typeof v.handlerId === 'string') effects.set(v.effectId, v); Object.values(v).forEach(walk); }
      })(catalog.definitions().map((d) => d.mechanics));
    }
    return effectId ? effects.get(effectId) ?? null : null;
  };
  // Whether `defs` together keep a card move's printed limits (an engine helper that cannot judge them: yes); with
  // distinctTypes, Basic Energy of different types (赤松: two of one type was refused, and the game took none).
  const typeOf = (d) => (d.kind === 'energy' ? d.mechanics.baseUnits?.[0]?.[0] ?? null : null);
  const withinLimits = (defs, p) => {
    try {
      return !(p.onePerAlternative && !matchesOnePerAlternative(defs, p.selector)) &&
        !(p.alternativeLimits && !matchesAlternativeLimits(defs, p.selector, p.alternativeLimits, !!p.exclusiveAlternatives)) &&
        !(p.distinct && !distinctCards(defs, p.distinct)) &&
        !(p.distinctTypes && new Set(defs.map(typeOf)).size < defs.length);
    } catch { return true; }
  };
  // The attacks `plan`'s Energy can pay for (all of them without a plan); with weakAttack, on a Pokémon (`mon`) the plan
  // does not attack with, only those doing a fair share of the main attacker's damage.
  const payableBy = (plan, mon = null) => {
    const types = plan?.energyTypes;
    if (!w.payableOnly || !types) return null;
    const weak = w.weakAttack && mon && plan.topDamage && !plan.attackers.includes(facts(top(mon).definitionId).d.nameKey);
    return (a) => a.cost.every((t) => t === 'Colorless' || types.includes(t) || types.includes('Any')) &&
      (!weak || a.copies || a.damage >= w.weakAttack * plan.topDamage);
  };
  // A name's place in one of the strategy's orders (0 when not in it, or no strategy).
  const order = (plan, list, nameKey) => plan?.strategy?.[list]?.[nameKey] ?? 0;
  const jitter = () => noise ? noise * randomIndex(rng, 1000) / 10 : 0;
  const best = (items, score) => items.map((x) => [x, score(x) + jitter()]).sort((a, b) => b[1] - a[1])[0]?.[0];
  const pickN = (items, n, score) => items.map((x) => [x, score(x) + jitter()]).sort((a, b) => b[1] - a[1]).slice(0, n).map(([x]) => x);
  // The plan's goal board: how many of a name it wants, and how many `mine` has (in play, a line counting for every name in
  // its stack, and in hand).
  const goalOf = (plan, nameKey) => plan?.goal.find((g) => g.nameKey === nameKey)?.count ?? 0;
  const held = (mine, nameKey, hand = true) => mons(mine).filter((m) => m.stack.some((c) => facts(c.definitionId).d.nameKey === nameKey)).length +
    (hand && Array.isArray(mine.hand) ? mine.hand.filter((c) => facts(c.definitionId).d.nameKey === nameKey).length : 0);
  /**
   * How much a card is worth keeping, to this player now (high: keep or fetch; low: discard). `use`: 'fetch' (from the
   * deck or the discard pile: the strategy's search order counts) or 'discard' (from the hand: its keep and discard
   * orders count). The two differ: 猛雷鼓's strategy discards Lightning and Fighting Energy first, for 奥琳博士的气魄 to
   * attach them from the discard pile, and fetching by that order took the Energy its attack needs least. The search
   * order counts only for a card still missing: fewer in play and in hand than its turn-2 board wants (one at least).
   */
  const value = (card, mine, plan = null, use = null) => {
    const key = facts(card.definitionId).d.nameKey;
    const missing = held(mine, key) - (mine.hand ?? []).some((c) => c === card) < Math.max(1, goalOf(plan?.strategy, key));
    return worth(card, mine, plan) + (use === 'fetch' && missing ? w.stratSearch * order(plan, 'search', key) : 0) +
      (use === 'discard' ? w.stratKeep * order(plan, 'keep', key) - w.stratDiscard * order(plan, 'discard', key) : 0);
  };
  const worth = (card, mine, plan) => {
    const f = facts(card.definitionId);
    if (f.kind === 'pokemon') {
      const missing = plan && goalOf(plan, f.d.nameKey) > held(mine, f.d.nameKey) - (mine.hand ?? []).some((c) => c === card) ? w.planPiece : 0;
      const evolves = f.stage !== 'basic' && mons(mine).some((m) => facts(top(m).definitionId).d.nameKey === f.d.mechanics.evolvesFrom);
      const hand = Array.isArray(mine.hand) ? mine.hand.map((c) => facts(c.definitionId).d) : [];
      // A Basic: none fits on a full Bench; more when an Evolution of it is in hand. An Evolution with nothing in play or
      // in hand to evolve from waits for that first.
      const fit = f.stage !== 'basic' ? 0 : (mine.bench.length >= (mine.benchLimit ?? 5) ? -w.fetchNoRoom : 0) +
        (hand.some((d) => d.mechanics.evolvesFrom === f.d.nameKey) ? w.fetchLineBasic : 0);
      const base = f.stage === 'basic' || evolves || hand.some((d) => d.nameKey === f.d.mechanics.evolvesFrom) ? 0 : -w.fetchNoBase;
      return 30 + (f.stage === 'basic' ? 0 : 15) + Math.max(0, ...f.attacks.map((a) => a.damage)) / 10 + (evolves ? 30 : 0) + fit + base + missing;
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
    const side = w.countEnergy ? mine : null, myDamage = mine.active ? bestDamage(mine.active, foe.active, [], side) : 0;
    const canAttack = attacks.length > 0;
    // A deck too thin to draw from freely: about two cards a turn for the turns the game may still last.
    const thin = mine.deckCount <= Math.max(8, 4 + 2 * (mine.prizes.count ?? mine.prizes.length ?? 0));
    const koActive = !!foe.active && foe.active.effective.currentHp <= myDamage;
    const koTarget = !koActive && foe.bench.some((m) => !m.faceDown && m.effective.currentHp <= myDamage);
    // A Benched Pokémon that can attack for more than the Active (switching to it is worth a move).
    const better = mine.bench.some((m) => readyDamage(m, mine, foe) > myDamage);
    const plan = planOf(me), planned = (f) => !!plan && !!f && goalOf(plan, f.d.nameKey) > held(mine, f.d.nameKey, false);
    // A move that discards or reshuffles the hand, and whether other cards can still be played first.
    const refreshes = (x) => {
      if (x.type === 'playTrainer') { const c = hand.get(x.cardId); return !!c && facts(c.definitionId).refreshesHand; }
      if (x.type === 'useAbility') { const m = findMon(view, x.pokemonId)?.mon ?? mine.active; return !!m && facts(top(m).definitionId).refreshesHand; }
      return false;
    };
    const playable = w.refreshLast > 0 && legal.some((x) => ['bench', 'evolve', 'attachEnergy', 'playTrainer', 'useAbility'].includes(x.type) && !refreshes(x));
    const capped = (a, n) => (playable && refreshes(a) ? Math.min(n, w.refreshLast) : n);
    // The goal board still misses Pokémon in play.
    const short = !!plan && plan.goal.some((g) => held(mine, g.nameKey, false) < g.count);
    const score = (a) => capped(a, rawScore(a));
    const rawScore = (a) => {
      const card = a.cardId && hand.get(a.cardId), f = card && facts(card.definitionId);
      switch (a.type) {
        case 'endTurn': return 0;
        case 'evolve': {
          const unused = w.abilityBeforeEvolve && legal.some((x) => x.type === 'useAbility' && x.pokemonId === a.pokemonId && score(x) > 0);
          const candy = w.candyFirst && f?.stage === 'stage1' && [...hand.values()].some((c) => { const g = facts(c.definitionId);
            return g.stage === 'stage2' && g.d.mechanics.evolvesFrom === f.d.nameKey; }) &&
            legal.some((x) => x.type === 'playTrainer' && hand.get(x.cardId) && facts(hand.get(x.cardId).definitionId).skipsStage);
          return w.evolve + (planned(f) ? w.planEvolve : 0) - (unused ? w.abilityBeforeEvolve : 0) - (candy ? w.candyFirst : 0);
        }
        // A Pokémon the goal board misses first; one off the plan less once the Bench is half full.
        case 'bench': return (mine.bench.length < mine.benchLimit - 1 ? w.bench : w.benchLast) + (planned(f) ? w.planBench :
          plan && mine.bench.length >= (mine.benchLimit ?? 5) / 2 ? -w.planOffBench : 0) + (f ? w.stratBench * order(plan, 'bench', f.d.nameKey) : 0) -
          (w.benchReserve && short && !planned(f) && (mine.benchLimit ?? 5) - mine.bench.length <= 2 ? w.benchReserve : 0);
        case 'useAbility': {
          const user = facts(top(findMon(view, a.pokemonId)?.mon ?? mine.active).definitionId);
          if (user.thinsDeck && thin) return -1;
          // Switching my Active, like a switch card: only for a Benched Pokémon that attacks for more.
          if (user.switchOwn) return !canAttack && better ? w.switchUp : -1;
          return f?.selfKnockOut || user.selfKnockOut ? w.abilitySelfKnockOut : w.ability;
        }
        case 'useStadium': return w.useStadium;
        case 'vUnion': case 'recallCard': return w.special;
        case 'attachEnergy': {
          const target = findMon(view, a.pokemonId)?.mon;
          if (!target || !f?.units) return 10;
          // Energy that brings an attack closer, most of all one that makes it ready (an attack that copies others
          // counts); the Active first.
          // (An Energy an Ability of the target needs, and it has none of: as much as one unit closer to an attack.)
          const has = (t) => (target.effective.energies ?? []).some((e) => e.units.some((u) => u.includes(t)));
          const enables = f.units.some((u) => facts(top(target).definitionId).abilityEnergy.some((t) => (u.includes(t) || u.includes('Any')) && !has(t)));
          const payable = payableBy(plan, target);
          const gain = Math.max(energyGain(target, f.units, payable), payable && enables ? 1 : 0);
          const ready = facts(top(target).definitionId).attacks.some((x) => (x.damage > 0 || x.copies) && (!payable || payable(x)) &&
            missingFor(target, x.attackId) > 0 && missingFor(target, x.attackId, f.units) === 0);
          // Basic Energy is the damage of an attack that discards it from the hand: attached only to make an attack ready.
          if (f.energyType && !ready && mons(mine).some((m) => facts(top(m).definitionId).handAmmo)) return -1;
          // When the plan's attacks count Basic Energy discarded from anywhere in play, every one attached is damage.
          const ammo = w.planAmmo && plan?.ammo === 'any' && f.energyType && !gain;
          const to = facts(top(target).definitionId).d.nameKey;
          const attacker = (plan?.attackers.includes(to) ? w.planAttach : 0) + w.stratAttach * order(plan, 'attach', to);
          return (gain ? w.attachGain + w.attachPerUnit * gain : ammo ? w.attachGain : w.attachNoGain) + (ready ? w.attachReady : 0) +
            (target === mine.active ? w.attachActive : 0) + strength(target, foe.active, w.countStrength ? mine : null) * w.attachStrength + attacker;
        }
        case 'playTrainer': {
          if (!f) return w.trainerUnknown;
          // An item that evolves straight to a Stage 2 in hand: as good as evolving (when the rule is on).
          if (w.candyFirst && f.skipsStage) return w.evolve;
          if (f.gust) return koTarget && canAttack ? w.gustKnockOut : w.gustIdle;
          if (f.switchOwn) return !canAttack && better ? w.switchUp : w.switchIdle;
          if (f.heals) return mons(mine).some((m) => m.counters >= 5) ? w.heal : w.healIdle;
          // Not at all from a thin deck (below ending the turn): decking out loses the game.
          if (f.thinsDeck && thin) return -1;
          if (f.discardsHand) return hand.size <= 4 ? w.discardHandSmall : w.discardHandBig;
          if (f.category === 'supporter') return f.draws ? w.supporterDraw - hand.size : w.supporterOther;
          if (f.category === 'tool') return w.tool;
          if (f.category === 'stadium') return !view.stadium || view.stadium.owner !== me ? w.stadium : 0;
          return f.draws || f.fetches || f.attaches ? w.itemUseful : w.itemOther;
        }
        case 'retreat': {
          const ready = mine.bench.map((m) => readyDamage(m, mine, foe));
          // To a Pokémon that can attack when the Active cannot, or that Knocks Out when the Active cannot. (Retreating to
          // one that hits harder, or to save an Active about to be Knocked Out, made the policy weaker as rules: 50.4% and
          // 48.6% over 3,000 games. The searches always compare retreating instead, search.mjs shortlistOf.)
          if (!canAttack) return ready.some((d) => d > 0) ? w.retreat : 0;
          return foe.active && !koActive && ready.some((d) => d >= foe.active.effective.currentHp) ? w.retreat : 0;
        }
        case 'attack': {
          const at = facts(top(mine.active).definitionId).attacks.find((x) => x.attackId === a.attackId);
          // An attack that copies, with nothing to copy but other copying attacks, would only ask the same again.
          const copied = at?.copies ? copyDamage(mine.active, at, mine, foe, foe.active) : null;
          if (copied === 0) return -1;
          const damage = copied ?? (at ? damageTo(at, mine.active, foe.active, side) : 0);
          return w.attackBase + Math.min(damage, 300) * w.attackDamage + (foe.active && damage >= foe.active.effective.currentHp ? w.attackKnockOut : 0);
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
    const plan = planOf(me), valueOf = (id, use = null) => { const c = cardOf(id); return c ? value(c, mine, plan, use) : 0; };
    const keyOf = (id) => { const c = cardOf(id); return c ? facts(c.definitionId).d.nameKey : null; };
    const monKey = (m) => facts(top(m).definitionId).d.nameKey;
    const monOf = (id) => findMon(view, id);
    const some = Math.max(q.minimum, Math.min(q.maximum ?? q.minimum, 1));
    const fromHand = q.options.every((id) => (mine.hand ?? []).some((c) => c.instanceId === id));
    // Cards an attack of mine counts for its damage: enough to Knock Out the defender, the least useful first.
    const per = q.effect?.category === 'attack' && q.options.length && mine.active ? facts(top(mine.active).definitionId).perCard.get(q.effect.effectId) : 0;
    if (per > 0) {
      const need = Math.ceil((foe.active?.effective.currentHp ?? per) / per);
      // (Not by the strategy's keep and discard orders: those are about the hand, and the Energy an attack discards from
      // play is better taken from what the attackers do not need.)
      // With keepCost: last the Active's Energy of a type its attacks need.
      const cost = new Set(facts(top(mine.active).definitionId).attacks.flatMap((a) => a.cost).filter((t) => t !== 'Colorless'));
      const onActive = new Set((q.energy ?? []).filter((e) => e.originId === mine.active.id).map((e) => e.card.instanceId));
      const kept = (id) => (w.keepCost && onActive.has(id) && cardOf(id) && (facts(cardOf(id).definitionId).units ?? []).some((u) => u.some((t) => cost.has(t))) ? w.keepCost : 0);
      return pick(pickN(q.options, Math.max(q.minimum, Math.min(q.maximum ?? q.options.length, q.options.length, need)), (id) => -valueOf(id) - kept(id)));
    }
    switch (q.kind) {
      case 'choose-order': return pick([q.options.includes('second') ? 'second' : q.options[0]]);
      case 'mulligan-bonus': return pick([q.options.at(-1)]);
      case 'setup-active': return pick([best(q.options, (id) => { const f = facts(cardOf(id).definitionId);
        return f.hp + Math.max(0, ...f.attacks.map((a) => a.damage)) - (f.d.mechanics.ruleBox ? 100 : 0) - f.d.mechanics.retreatCost * 10 +
          w.stratOpening * order(plan, 'opening', f.d.nameKey); })]);
      case 'setup-bench': return pick(pickN(q.options, Math.min(q.maximum, Math.max(q.minimum, 3)), (id) => valueOf(id) + w.stratBench * order(plan, 'bench', keyOf(id))));
      // The Pokémon that can attack now, the hardest-hitting first; then the closest to attacking.
      case 'promote': case 'retreat-target': return pick([best(q.options, (id) => { const m = monOf(id)?.mon;
        if (!m) return 0;
        const now = readyDamage(m, mine, foe), main = plan?.attackers.includes(monKey(m));
        return (now > 0 ? 1000 + now + (main ? w.planPromote : 0) : 0) + strength(m, foe.active) / 4 - deficit(m) * 60 +
          w.stratPromote * order(plan, 'promote', monKey(m)); })]);
      case 'retreat-energy': return pick(q.options.slice(0, Math.max(q.minimum, mine.active?.effective.retreatCost ?? 0)));
      case 'activation-cost': {
        const choices = (q.payment?.groups ?? []).flatMap((g) => g.choices);
        return pick(choices.sort((a, b) => value(a.card, mine, plan, 'discard') - value(b.card, mine, plan, 'discard')).slice(0, q.minimum).map((c) => c.optionId));
      }
      case 'bench-trim': return pick(pickN(q.options, q.minimum, (id) => { const m = monOf(id)?.mon;
        return m ? -strength(m) - w.trimEnergy * m.energy.length - (plan?.roles?.[monKey(m)] ? w.trimRole : 0) : 0; }));
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
        const ko = (m) => w.gustKO && mine.active && bestDamage(mine.active, m, [], w.countEnergy ? mine : null) >= m.effective.currentHp ? w.gustKO : 0;
        const score = (x) => x.owner !== me ? ko(x.mon) + facts(top(x.mon).definitionId).prizes * 100 - x.mon.effective.currentHp : strength(x.mon, foe.active);
        return pick(pickN(found, some, score).map((x) => x.mon.id));
      }
      case 'select-cards': case 'inspect-deck': case 'hand-energy': case 'discard-energy': {
        // From the hand (usually a cost or a discard): the least useful; from elsewhere: the most useful.
        if (fromHand && q.kind === 'select-cards') return pick(pickN(q.options, q.minimum, (id) => -valueOf(id, 'discard')));
        const p = effectOf(q.effect?.effectId)?.parameters ?? null;
        const fetch = (id) => valueOf(id, fromHand ? null : 'fetch') -
          (w.handTrigger && p?.to === 'bench' && cardOf(id) && facts(cardOf(id).definitionId).benchFromHand ? w.handTrigger : 0);
        if (w.pickLimits && p && (p.onePerAlternative || p.alternativeLimits || p.distinct || p.distinctTypes)) {
          // The most useful first, each one only if the cards taken so far still keep the printed limits.
          const chosen = [];
          for (const id of pickN(q.options, q.options.length, fetch)) {
            if (chosen.length >= (q.maximum ?? q.options.length)) break;
            if (cardOf(id) && withinLimits([...chosen, id].map((x) => catalog.definition(cardOf(x).definitionId)), p)) chosen.push(id);
          }
          if (chosen.length >= q.minimum) return pick(chosen);
        }
        return pick(pickN(q.options, q.maximum, fetch));
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
        // The Pokémon closest to attacking (not one already ready), the Active first. With the Energy known (and
        // recipientUnits on): among the attacks the deck can pay for, closest after this Energy, counting only attacks it helps.
        const incoming = q.selected?.[q.assignments?.length ?? 0], units = w.recipientUnits && incoming ? facts(incoming.definitionId).units : null;
        const attacks = (m) => { const payable = payableBy(plan, m); return facts(top(m).definitionId).attacks.filter((a) => (a.damage > 0 || a.copies) && (!payable || payable(a))); };
        const closest = (m) => {
          if (units) {
            const after = Math.min(9, ...attacks(m).filter((a) => missingFor(m, a.attackId, units) < missingFor(m, a.attackId)).map((a) => missingFor(m, a.attackId, units)));
            return after < 9 ? (10 - after) * w.recipientClose : 0;
          }
          const miss = Math.min(9, ...attacks(m).map((a) => missingFor(m, a.attackId)));
          return miss > 0 && miss < 9 ? (10 - miss) * w.recipientClose : 0; };
        // (With recipientHand: the hand, when the effect offers it and this Energy brings no attack closer: 赤松 attached
        // the Grass to 铁斑叶ex and kept the Lightning 猛雷鼓ex needed.)
        if (w.recipientHand && units && q.options.includes('@hand') && targets.every((id) => !monOf(id) || closest(monOf(id).mon) === 0)) return pick(['@hand']);
        return pick([best(targets, (id) => { const m = monOf(id)?.mon; return m ? deficit(m) * w.recipientDeficit + closest(m) + strength(m, foe.active, w.countStrength ? mine : null) / 10 + (m === mine.active ? 5 : 0) +
          w.stratAttach * order(plan, 'attach', monKey(m)) : 0; })]);
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
    w = weightsFor(me);
    if (view.pending) return answer(view, me);
    return view.legalActions.length ? main(view, me, steps) : null;
  }
  /** The main-phase moves, the ones the policy likes most first (a search's shortlist). */
  decide.rank = (view, me) => {
    w = weightsFor(me);
    const { legal, score } = scorer(view, me);
    return legal.map((a) => [a, score(a)]).sort((x, y) => y[1] - x[1]).map(([a]) => a);
  };
  return decide;
}
