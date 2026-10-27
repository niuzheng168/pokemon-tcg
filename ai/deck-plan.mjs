// A deck's plan (套路, docs/ai/STATUS.md M7): what each of its Pokémon is for, read from the card effects (never card
// names), and the board it wants to build. Roles:
// - attacker: does the most damage the deck's Energy can pay for (an attack counting discarded Energy counts several);
// - energy: an Ability that attaches Energy (an engine that powers the attackers up faster);
// - draw / search: an Ability that draws, or that takes cards from the deck;
// and the goal board: the main attacker twice (or as often as the list plays it), each other attacker, the Energy
// engines twice, one of each draw or search engine, with the Pokémon each evolves from. It also says whether the deck's
// damage counts Energy discarded from the field or the hand (then every Energy in play or in hand is damage), and which
// metagame archetype (ai/archetypes.json) the list is closest to. The AI knows its own list, so it may plan with it.
import { readFileSync, existsSync } from 'node:fs';

const DRAW = new Set(['cn.draw@1', 'cn.drawUntil@1', 'cn.cardsThenDraw@1', 'cn.handDeckDraw@1', 'cn.drawValue@1', 'cn.drawPlayers@1',
  'cn.drawPokemonCount@1', 'cn.attachThenDraw@1', 'cn.handBottomDraw@1']);
const ATTACH = new Set(['cn.attachDeckEnergy@1', 'cn.attachDiscard@1', 'cn.attachHand@1', 'cn.attachThenDraw@1']);
// Damage counting Energy cards discarded: from these places of its own side.
const COUNTED = new Set(['cn.countedEnergyDiscard@1', 'cn.discardEnergy@1', 'cn.cards@1']);

let archetypes = null, tuned = null, strategies = null;
const loadArchetypes = () => (archetypes ??= JSON.parse(readFileSync(new URL('./archetypes.json', import.meta.url), 'utf8')).archetypes);
// The strategies a language model wrote from the card texts (scripts/ai-deck-strategy.mjs); AI_DECK_STRATEGIES names
// another file to test.
const STRATEGIES = process.env.AI_DECK_STRATEGIES ?? new URL('./deck-strategies.json', import.meta.url);
const loadStrategies = () => (strategies ??= existsSync(STRATEGIES) ? Object.values(JSON.parse(readFileSync(STRATEGIES, 'utf8')).decks) : []);
// The decks tuned by scripts/ai-deck-tune.mjs (none until it has run); AI_DECK_WEIGHTS names another file to test.
const TUNED = process.env.AI_DECK_WEIGHTS ?? new URL('./deck-weights.json', import.meta.url);
const loadTuned = () => (tuned ??= existsSync(TUNED) ? Object.values(JSON.parse(readFileSync(TUNED, 'utf8')).decks) : []);
// A list's own tuned rule weights, or those of a tuned list of the same archetype (both clearly of it), or null.
function tunedWeights(cards, archetype) {
  const key = cards.map(([p, n]) => `${p}×${n}`).sort().join(), all = loadTuned();
  const own = all.find((t) => t.list === key);
  if (own) return own.weights;
  const same = (archetype?.similarity ?? 0) >= 0.85 && all.find((t) => t.archetype?.name === archetype.name && t.archetype.similarity >= 0.85);
  return same ? same.weights : null;
}

const bindingsOf = (v, out = []) => {
  if (Array.isArray(v)) v.forEach((x) => bindingsOf(x, out));
  else if (v && typeof v === 'object') { if (typeof v.handlerId === 'string') out.push(v); Object.values(v).forEach((x) => bindingsOf(x, out)); }
  return out;
};
// An attack's damage multiplier per card an earlier effect of it moved (「每…张，造成70伤害」), with that effect.
function counted(attack) {
  const effects = bindingsOf(attack.effects ?? []);
  let found = null;
  (function walk(v) {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (v.kind === 'multiply') {
        const n = [v.left, v.right].find((x) => x?.kind === 'literal'), cards = [v.left, v.right].find((x) => x?.kind === 'effectCards');
        const source = cards && effects.find((b) => b.effectId === cards.effectId);
        if (n && source && COUNTED.has(source.handlerId)) found = { per: n.value, from: source.parameters?.from ?? null, energy: source.parameters?.op === 'discardEnergy' || source.handlerId === 'cn.countedEnergyDiscard@1' };
      }
      Object.values(v).forEach(walk);
    }
  })(attack.effects ?? []);
  return found;
}

/** `cards`: the list as [[printingId, copies]]; `catalog` must have its printings. */
export function deckPlan(catalog, cards) {
  const byName = new Map();
  for (const [printingId, n] of cards) {
    const d = catalog.definitionFor(printingId), e = byName.get(d.nameKey) ?? { d, copies: 0 };
    e.copies += n; byName.set(d.nameKey, e);
  }
  const all = [...byName.values()], pokemon = all.filter((e) => e.d.kind === 'pokemon');
  // The Energy types the deck can provide (basic Energy, and special Energy's units).
  const types = new Set(all.filter((e) => e.d.kind === 'energy').flatMap((e) => (e.d.mechanics.baseUnits ?? []).flat()));
  const payable = (cost) => cost.every((t) => t === 'Colorless' || types.has(t) || types.has('Any'));
  const evolvesInto = (nameKey) => pokemon.filter((e) => e.d.mechanics.evolvesFrom === nameKey);
  const lineOf = (e) => { const line = [e]; for (let x = e; x?.d.mechanics.evolvesFrom;) { x = byName.get(x.d.mechanics.evolvesFrom); if (x) line.unshift(x); } return line; };

  const facts = pokemon.map((e) => {
    const m = e.d.mechanics, abilities = bindingsOf((m.abilities ?? []).map((a) => a.effects));
    const attacks = (m.attacks ?? []).map((a) => {
      const c = counted(a), base = a.printedDamage?.value ?? 0, op = a.printedDamage?.operator;
      // An attack counting cards (or anything else, 「×」): as if it counted four; 「+」: thirty more; damage counters it
      // puts on the opponent's Pokémon count ten each.
      const spread = bindingsOf(a.effects ?? []).filter((b) => b.handlerId === 'cn.counters@1' && b.parameters?.side === 'opponent')
        .reduce((n, b) => n + 10 * (b.parameters.count ?? 0), 0);
      const damage = (c ? c.per * 4 : op === 'times' ? base * 4 : op === 'plus' ? base + 30 : base) + spread;
      // (Copying the own side's attacks; copying the opponent's depends on the opponent.)
      const copies = bindingsOf(a.effects ?? []).some((b) => b.handlerId === 'cn.copyAttack@1' && (b.parameters?.origins ?? []).every((o) => o.side === 'own'));
      return { name: a.name, damage, copies, payable: payable(a.cost), ammo: c?.energy ? c.from : null };
    });
    const best = Math.max(0, ...attacks.filter((a) => a.payable && !a.copies).map((a) => a.damage));
    return { e, copier: attacks.some((a) => a.payable && a.copies), final: !evolvesInto(e.d.nameKey).length, best, ammo: attacks.find((a) => a.ammo && a.payable)?.ammo ?? null,
      energy: abilities.some((b) => ATTACH.has(b.handlerId)), draw: abilities.some((b) => DRAW.has(b.handlerId)),
      search: abilities.some((b) => b.handlerId === 'cn.cards@1' && b.parameters?.from === 'deck') };
  });
  // An attack that copies the deck's other attacks: as strong as the best of those.
  const copied = Math.max(0, ...facts.map((f) => f.best));
  for (const f of facts) if (f.copier) f.best = Math.max(f.best, copied);
  // Attackers: the hardest hitters, a list playing more copies of one counting for more (the main attacker is the one
  // the deck is built around).
  const strength = (f) => Math.min(f.best, 330) + 40 * Math.min(f.e.copies, 3);
  const top = Math.max(0, ...facts.filter((f) => f.final).map(strength));
  const attackers = facts.filter((f) => f.final && f.best > 0 && strength(f) >= 0.7 * top).sort((a, b) => strength(b) - strength(a)).slice(0, 3);
  const archetype = matchArchetype(byName);
  // An engine is part of the plan when the list plays two or more, or (a single copy) the archetype's lists nearly all do.
  const core = new Set((archetype?.similarity ?? 0) >= 0.8 ? loadArchetypes().find((a) => a.name === archetype.name).cards
    .filter((c) => c.share >= 0.9).map((c) => c.nameKey) : []);
  // (An Energy engine that also draws is an Energy engine; the archetype's core first, then the most copies.)
  const engines = (key) => facts.filter((f) => f[key] && f.final && !attackers.includes(f) && (key === 'energy' || !f.energy) &&
    (f.e.copies >= 2 || core.has(f.e.d.nameKey))).sort((a, b) => core.has(b.e.d.nameKey) - core.has(a.e.d.nameKey) || b.e.copies - a.e.copies);
  // The goal board, in the order it is built: the main attacker, an Energy engine, a search engine, the second main
  // attacker, the second Energy engine, a draw engine, the other attackers; one Spot per line, six Spots in all.
  const goal = new Map(), lines = new Set();
  const want = (f, n) => {
    const line = lineOf(f.e), key = f.e.d.nameKey, have = goal.get(key) ?? 0;
    if (!f || have >= Math.min(n, f.e.copies) || [...lines].length >= 6) return;
    lines.add(`${key}#${have}`);
    for (const x of line) goal.set(x.d.nameKey, Math.max(goal.get(x.d.nameKey) ?? 0, have + 1));
  };
  const [main, ...others] = attackers, energy = engines('energy'), search = engines('search'), draw = engines('draw');
  for (const [f, n] of [[main, 1], [energy[0], 1], [search[0], 1], [main, 2], [energy[0], 2], [draw[0], 1], ...others.map((o) => [o, 1]),
    ...energy.slice(1).map((o) => [o, 1]), ...search.slice(1).map((o) => [o, 1])]) if (f) want(f, n);
  const role = (f) => (attackers.includes(f) ? 'attacker' : f.energy ? 'energy' : f.search ? 'search' : f.draw ? 'draw' : null);
  return {
    archetype,
    attackers: attackers.map((f) => f.e.d.nameKey),
    roles: Object.fromEntries(facts.filter((f) => role(f)).map((f) => [f.e.d.nameKey, role(f)])),
    goal: [...goal].map(([nameKey, count]) => ({ nameKey, count })),
    // Where the main attacker's damage comes from: Energy discarded from anywhere in play ('any'), itself, or the hand.
    ammo: attackers[0]?.ammo ?? null,
    // The main attacker's damage (as deckPlan counts it: an attack counting cards as if four).
    topDamage: attackers[0]?.best ?? 0,
    // The Energy types the deck's cards provide ('Any' for a special Energy providing every type).
    energyTypes: [...types],
    // Its own scores for the policy's plan rules (scripts/ai-deck-tune.mjs), when tuned.
    weights: tunedWeights(cards, archetype),
    // The language model's strategy for the list (or for a list of the same archetype), when written.
    strategy: strategyOf(cards, archetype, byName, lineOf),
    names: Object.fromEntries(all.map((e) => [e.d.nameKey, e.d.name])),
  };
}

// A written strategy (scripts/ai-deck-strategy.mjs) in the plan's terms: its main attackers, the board it
// wants by turn 2 as the goal board (with the Pokémon each evolves from), where the damage's Energy comes from, and its
// orders as a score per name (1 for the first, down to 1/n for the last of n; 0 for a name not in the order). Names the
// list does not play are left out.
function strategyOf(cards, archetype, byName, lineOf) {
  const key = cards.map(([p, n]) => `${p}×${n}`).sort().join(), all = loadStrategies();
  const s = (all.find((x) => x.list === key) ?? ((archetype?.similarity ?? 0) >= 0.85 &&
    all.find((x) => x.archetype?.name === archetype.name && x.archetype.similarity >= 0.85)))?.strategy;
  if (!s) return null;
  const keys = new Map([...byName.values()].map((e) => [e.d.name, e.d.nameKey]));
  const order = (names = []) => {
    const known = [...new Set(names.map((n) => keys.get(n)).filter(Boolean))];
    return Object.fromEntries(known.map((k, i) => [k, (known.length - i) / known.length]));
  };
  const goal = new Map();
  for (const { name, count } of s.turn2Board ?? []) {
    const e = byName.get(keys.get(name));
    if (e) for (const x of lineOf(e)) goal.set(x.d.nameKey, Math.max(goal.get(x.d.nameKey) ?? 0, Math.min(count, e.copies)));
  }
  return {
    attackers: [...new Set((s.attackers ?? []).filter((a) => a.role === 'main').map((a) => keys.get(a.name)).filter(Boolean))],
    goal: [...goal].map(([nameKey, count]) => ({ nameKey, count })),
    ammo: { field: 'any', hand: 'hand' }[s.energy?.ammo] ?? null,
    opening: order(s.openingActive), bench: order(s.benchPriority), search: order(s.searchPriority), keep: order(s.keep),
    discard: order(s.discardFirst), promote: order(s.promotePriority), attach: order((s.energy?.attach ?? []).map((a) => a.name)),
  };
}

// The archetype whose average list is closest (cosine over copies per name, each weighted by how many lists play it).
function matchArchetype(byName) {
  let best = null;
  for (const a of loadArchetypes()) {
    let dot = 0, mine = 0, theirs = 0;
    const avg = new Map(a.cards.map((c) => [c.nameKey, c.share * c.copies]));
    for (const [key, e] of byName) { dot += e.copies * (avg.get(key) ?? 0); mine += e.copies ** 2; }
    for (const v of avg.values()) theirs += v ** 2;
    const similarity = dot / Math.sqrt(mine * theirs || 1);
    if (!best || similarity > best.similarity) best = { name: a.name, lists: a.lists, similarity: +similarity.toFixed(3) };
  }
  return best;
}

/** A plan in a few lines of Chinese (names from the card data). */
export function describePlan(plan) {
  const n = (key) => plan.names[key] ?? key;
  const by = (role) => Object.entries(plan.roles).filter(([, r]) => r === role).map(([k]) => n(k)).join('、') || '无';
  return [
    `最接近的套路：${plan.archetype ? `${plan.archetype.name}（相似度 ${plan.archetype.similarity}，${plan.archetype.lists} 份赛事卡表）` : '无'}`,
    `攻击手：${plan.attackers.map(n).join('、') || '无'}${plan.ammo ? `（伤害按丢弃的能量计：${{ any: '场上任意宝可梦身上的', self: '自身的', hand: '手牌中的' }[plan.ammo] ?? plan.ammo}）` : ''}`,
    `填能引擎：${by('energy')}；过牌：${by('draw')}；检索：${by('search')}`,
    `目标场面：${plan.goal.map((g) => `${n(g.nameKey)}×${g.count}`).join('、')}`,
  ].join('\n');
}

const cache = new WeakMap();
/**
 * The plan of `player`'s cards in `state` (every card it owns: its own list, which a player knows; in a search's world the
 * opponent's cards are the guessed ones), worked out once per catalog and list.
 */
export function planFor(catalog, state, player) {
  if (!cache.has(catalog)) cache.set(catalog, new Map());
  const counts = new Map();
  for (const c of Object.values(state.cards)) if (c.owner === player) counts.set(c.printingId, (counts.get(c.printingId) ?? 0) + 1);
  const cards = [...counts].sort(([a], [b]) => (a < b ? -1 : 1)), key = JSON.stringify(cards), plans = cache.get(catalog);
  if (!plans.has(key)) {
    if (plans.size > 200) plans.clear();
    plans.set(key, deckPlan(catalog, cards));
  }
  return plans.get(key);
}
