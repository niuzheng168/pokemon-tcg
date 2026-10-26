// The learned position value's inputs (value-model.mjs): what `me` can see of a position, as numbers. Each side's board
// (mine, then theirs), my hand (theirs is only a count), and the turn. Like board.mjs, every feature comes from the
// cards' definitions (handlers, parameters, HP, Prize value), never their names.
import { boardReader, mons, top } from './board.mjs';

/** One side's features, for me and then for them. */
export const SIDE_FEATURES = Object.freeze([
  'prizesLeft',      // Prize cards left to take
  'deck',            // cards in the deck, per 10
  'deckLow',         // deck cards short of 6
  'hand',            // cards in hand (up to 12)
  'discardEnergy',   // Energy cards in the discard pile (up to 10)
  'discardPokemon',  // Pokémon in the discard pile (up to 10)
  'lost',            // cards in the Lost Zone (up to 10)
  'activeHp',        // the Active's HP left, per 100
  'activeHpShare',   // the Active's HP left, as a share of its maximum
  'activePrizes',    // Prizes a Knock Out of the Active gives
  'activeEnergy',    // Energy units on the Active
  'activeMissing',   // Energy units the Active's strongest attack still needs (up to 4)
  'activeReach',     // the most damage the Active does to the other Active now, per its HP left (up to 2)
  'activeKo',        // the Active can Knock Out the other Active now
  'activeThreat',    // ... with one more Energy at most
  'activeStuck',     // Retreat Cost the attached Energy does not cover
  'activeCondition', // Special Conditions on the Active
  'activeEvolved',   // the Active is evolved
  'activeAbility',   // the Active has an Ability
  'bench',           // Benched Pokémon
  'benchSpace',      // free Bench places
  'benchHp',         // the Bench's HP left, per 100
  'benchEnergy',     // Energy units on the Bench
  'benchEvolved',    // evolved Benched Pokémon
  'benchReady',      // Benched Pokémon that could attack the other Active now
  'benchThreat',     // Benched Pokémon that could Knock Out the other Active with one more Energy at most
  'benchPrizes',     // Prizes the Bench would give
  'multiPrize',      // Pokémon in play worth two Prizes or more
  'damage',          // damage counters in play, per 10
  'tools',           // Pokémon Tools in play
  'abilities',       // Pokémon in play with an Ability
  'noBench',         // nothing on the Bench (a Knock Out of the Active ends the game)
  'vstarUsed',       // the VSTAR Power is used
]);
/** My hand, by what the cards do. */
export const HAND_FEATURES = Object.freeze([
  'handEnergy', 'handBasic', 'handEvolution',
  'handEvolvable',   // Evolution cards that evolve a Pokémon in play
  'handSupporter', 'handItem', 'handTool', 'handStadium',
  'handDraw', 'handFetch', 'handGust', 'handSwitch',
]);
export const GLOBAL_FEATURES = Object.freeze(['turn', 'toMove', 'first', 'stadiumMine', 'stadiumTheirs']);
export const FEATURE_NAMES = Object.freeze([...SIDE_FEATURES.map((f) => `my.${f}`), ...SIDE_FEATURES.map((f) => `their.${f}`),
  ...HAND_FEATURES, ...GLOBAL_FEATURES]);

const cap = (n, max) => Math.min(max, n);
const count = (zone) => (Array.isArray(zone) ? zone.length : zone?.count ?? 0);

export function featureReader(catalog) {
  const { facts, attached, bestDamage, deficit, threatens } = boardReader(catalog);
  const prizes = (m) => facts(top(m).definitionId).prizes;
  const hasAbility = (m) => (m.effective.abilities ?? []).some((a) => a.present);
  const condition = (m) => Number(!!m.conditions?.rotation) + Number(!!m.conditions?.poison) + Number(!!m.conditions?.burned);
  const kind = (cards, test) => cards.filter((c) => test(facts(c.definitionId))).length;

  function side(view, i, out) {
    const p = view.players[i], a = p.active && !p.active.faceDown ? p.active : null, foe = view.players[1 - i].active;
    const d = foe && !foe.faceDown ? foe : null, board = mons(p), bench = board.filter((m) => m !== a);
    const discard = Array.isArray(p.discard) ? p.discard : [];
    const damage = a && d ? bestDamage(a, d) : 0;
    out.push(
      count(p.prizes), p.deckCount / 10, Math.max(0, 6 - p.deckCount), cap(count(p.hand), 12),
      cap(kind(discard, (f) => f.kind === 'energy'), 10), cap(kind(discard, (f) => f.kind === 'pokemon'), 10), cap(count(p.lost), 10),
      a ? a.effective.currentHp / 100 : 0, a ? a.effective.currentHp / Math.max(10, a.effective.maxHp) : 0, a ? prizes(a) : 0,
      a ? attached(a) : 0, a ? cap(deficit(a), 4) : 0, d ? cap(damage / Math.max(10, d.effective.currentHp), 2) : 0,
      d && damage >= d.effective.currentHp ? 1 : 0, threatens(a, d) ? 1 : 0,
      a ? Math.max(0, (a.effective.retreatCost ?? 0) - attached(a)) : 0, a ? condition(a) : 0,
      a && a.stack.length > 1 ? 1 : 0, a && hasAbility(a) ? 1 : 0,
      bench.length, Math.max(0, (p.benchLimit ?? 5) - p.bench.length), bench.reduce((n, m) => n + m.effective.currentHp, 0) / 100,
      bench.reduce((n, m) => n + attached(m), 0), bench.filter((m) => m.stack.length > 1).length,
      d ? bench.filter((m) => bestDamage(m, d) > 0).length : 0, bench.filter((m) => threatens(m, d)).length,
      bench.reduce((n, m) => n + prizes(m), 0), board.filter((m) => prizes(m) >= 2).length,
      board.reduce((n, m) => n + (m.counters ?? 0), 0) / 10, board.reduce((n, m) => n + (m.tools?.length ?? 0), 0),
      board.filter(hasAbility).length, p.bench.length === 0 ? 1 : 0, p.vstarUsed ? 1 : 0,
    );
  }

  function hand(view, me, out) {
    const p = view.players[me], cards = Array.isArray(p.hand) ? p.hand : [];
    const inPlay = new Set(mons(p).map((m) => facts(top(m).definitionId).d.nameKey));
    const all = cards.map((c) => facts(c.definitionId));
    const n = (test) => all.filter(test).length;
    out.push(
      n((f) => f.kind === 'energy'), n((f) => f.kind === 'pokemon' && f.stage === 'basic'),
      n((f) => f.kind === 'pokemon' && f.stage !== 'basic'), n((f) => f.kind === 'pokemon' && inPlay.has(f.d.mechanics.evolvesFrom)),
      n((f) => f.kind === 'trainer' && f.category === 'supporter'), n((f) => f.kind === 'trainer' && f.category === 'item'),
      n((f) => f.kind === 'trainer' && f.category === 'tool'), n((f) => f.kind === 'trainer' && f.category === 'stadium'),
      n((f) => f.kind === 'trainer' && f.draws), n((f) => f.kind === 'trainer' && f.fetches),
      n((f) => f.gust), n((f) => f.switchOwn),
    );
  }

  /** The features of `view` (`me`'s player view), in the order of FEATURE_NAMES. */
  return function features(view, me) {
    const out = [];
    side(view, me, out);
    side(view, 1 - me, out);
    hand(view, me, out);
    const owner = view.stadium?.owner;
    out.push(view.turn / 10, view.current === me ? 1 : 0, view.first === me ? 1 : 0, owner === me ? 1 : 0, owner === 1 - me ? 1 : 0);
    return out;
  };
}
