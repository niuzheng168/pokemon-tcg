// Synthetic definitions only. Selectors and conditions that compare with something known only at play time, and printed name/kind
// selectors (selection.context, selection.printed-traits, effects.player-lock-cards, pokemon.hp-set, pokemon.maximum-hp-count,
// pokemon.ability-name, damage.received-options):
// 「将自己牌库中，与对手场上宝可梦相同属性的1张宝可梦，在给对手看过之后，加入手牌。并重洗牌库。」
// 「选择自己牌库中，与对手场上宝可梦名字相同的1张宝可梦，在给对手看过之后，加入手牌。并重洗牌库。」
// 「选择自己牌库中，与自己弃牌区中的宝可梦名字相同的1张宝可梦，在给对手看过之后，加入手牌。并重洗牌库。」
// 「选择自己牌库中，与这只宝可梦身上附着的基本能量相同属性的宝可梦合计最多5张，在给对手看过之后，加入手牌。并重洗牌库。」
// 「在自己的回合，从自己的手牌将基本能量附着于这只宝可梦身上时，可使用1次。将与被附着的能量相同属性的，从这只宝可梦进化而来的卡牌，
// 从自己的牌库中选择1张，放于这只宝可梦身上进行进化。并重洗牌库。」
// 「如果从手牌将「火」「水」「超」中任意1种「基本能量卡」附着于这只宝可梦身上的话，则在那个回合结束前，这只宝可梦的「属性」变为和附着的
// 「基本能量卡」相同。」
// 「这只宝可梦，会变为与这只宝可梦身上附有的基本能量相同的属性。（如果附有2种以上（包含2种）属性的基本能量的话，则同时变为各种对应的属性。）」
// 「造成自己最大HP为「30」的备战宝可梦数量×30伤害。」 「选择自己牌库中，抗性为【斗】属性的宝可梦最多2张，在给对手看过之后，加入手牌。并重洗牌库。」
// 「如果这只宝可梦身上放有「宝可梦道具」的话，则对手无法从手牌使出「【ACE SPEC】」卡牌。」
// 「只要这只宝可梦在战斗场上，对手无法从手牌将拥有特性的宝可梦（除「火箭队的宝可梦」外）放于场上。」
// 「如果自己场上有可以进化为「梦妖魔」「乌鸦头头」「水晶灯火灵」「坚盾剑怪」（包含GX）的宝可梦的话，则从自己的牌库中，选择1张其进化卡，放于该宝可梦
// 身上进行进化。并重洗牌库。（在自己最初的回合可以使用，对刚被放出的宝可梦也可使用。）」
// 「如果自己的战斗宝可梦是拥有特性「祭典乐舞」的宝可梦的话，则在自己的回合可以使用1次。选择自己牌库中任意1张卡牌，加入手牌。并重洗牌库。」
// 「如果对手的剩余奖赏卡张数在3张以下（包含3张），则这只宝可梦的最大HP变为「200」。」
// 「只要这只宝可梦在场上，当双方场上拥有【超】属性弱点的宝可梦，受到招式的伤害时，不计算弱点。」 No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, assertSupportedDefinition } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { matchesCardSelector, ACE_SPEC_GROUP } from '../../public/rules/card-selection.js';
import { matchesInPlaySelector, matchesPokemonState } from '../../public/rules/in-play-selection.js';
import { resolveContextSelector, contextSearchPossible, readTypes } from '../../public/rules/context-selection.js';
import { assertBattleValue, assertPokemonState } from '../../public/rules/battle-value.js';
import { validateCardSelector } from '../../public/rules/schema-validators.js';
import { ACE_SPEC_GROUP as CATALOG_ACE_SPEC_GROUP } from '../../catalog/zh-CN/V20261019/common.mjs';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const handlers = createCoreHandlers();
const valid = (id, p) => handlers.get(id).validateParameters(JSON.parse(JSON.stringify(p)));
const clone = (v) => JSON.parse(JSON.stringify(v));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const def = (defs, id) => defs.find((d) => d.definitionId === id);
// A synthetic Basic Pokémon cloned from the fixture's.
const mon = (defs, id, mechanics = {}) => {
  const d = structuredClone(def(defs, 'base'));
  Object.assign(d, { definitionId: id, nameKey: id, name: `测试宝可梦${id}` });
  Object.assign(d.mechanics, { attacks: [], abilities: [], ...mechanics });
  defs.push(d); return d;
};
const include = (f, ...ids) => { f.deck.splice(-ids.length, ids.length, ...ids.map((id) => `printing:${id}`)); return f; };
const put = (s, owner, id, zone) => { const card = hand(s, owner, id); s.players[owner].hand.pop(); s.players[owner][zone].push(card); return card; };
const activate = (s, owner, id) => { const p = s.players[owner], m = bench(s, owner, id); p.bench.splice(p.bench.indexOf(m), 1); p.bench.push(p.active); p.active = m; return m; };
const continuous = (abilityId, effects, extra = {}) => ({ abilityId, name: `测试特性${abilityId}`, mode: 'continuous', usage: null, effects, sourceOfTruth: EVIDENCE, ...extra });
const search = (selector, extra = {}) => ({ from: 'deck', to: 'hand', selector, quantity: { kind: 'exact', count: 1 }, reveal: true, lookTop: null, shuffleAfter: true, ...extra });
const playable = (g, cardId) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === cardId);
const ace = (d) => { d.deckLimits = { sameName: 4, groups: [{ key: ACE_SPEC_GROUP, maximum: 1, sourceOfTruth: EVIDENCE }] }; return d; };
const supported = (f, d) => assertSupportedDefinition({ handler: (id) => handlers.get(id) }, d);

test('schemas: context, Resistance, name-exclusion and ACE SPEC selectors; selective hand locks; received damage options; HP set', () => {
  for (const selector of [{ kind: 'pokemon', typesFrom: 'opponentField' }, { kind: 'pokemon', namesFrom: 'ownDiscard', stages: ['basic'] },
    { kind: 'pokemon', resistanceTypes: ['Fighting'] }, { kind: 'pokemon', printedAbility: true, excludeNameContains: '火箭队的' },
    { anyOf: [{ kind: 'trainer', aceSpec: true }, { kind: 'energy', aceSpec: true }] }])
    assert(validateCardSelector(selector), JSON.stringify(selector));
  for (const selector of [{ kind: 'pokemon', typesFrom: 'opponentField', types: ['Water'] }, { kind: 'pokemon', namesFrom: 'ownDiscard', nameKeys: ['base'] },
    { kind: 'pokemon', typesFrom: 'hand' }, { kind: 'trainer', typesFrom: 'opponentField' }, { kind: 'pokemon', aceSpec: true }])
    assert(!validateCardSelector(selector), JSON.stringify(selector));
  assert.equal(ACE_SPEC_GROUP, CATALOG_ACE_SPEC_GROUP, 'The catalog builds ACE SPEC cards with the group the selector reads.');
  const lock = { op: 'playerRestriction', scope: 'opponent', actions: ['playFromHand'], cardSelector: { kind: 'trainer', aceSpec: true } };
  assert(valid('cn.playerRestriction@1', { effect: lock }));
  for (const effect of [{ ...lock, actions: ['playFromHand', 'playItem'] }, { ...lock, actions: ['playItem'] },
    { ...lock, actions: ['enterPlay'] }]) assert(!valid('cn.playerRestriction@1', { effect }), JSON.stringify(effect));
  assert(!valid('cn.lastingPlayer@1', { side: 'opponent', duration: 'nextOpponentTurn', effect: { ...lock, scope: 'all' } }));
  const zone = { op: 'attackDamageOptions', scope: 'all', received: true, ignoreWeakness: true, targetWeakness: 'Psychic' };
  assert(valid('cn.attackDamageOptions@1', { effect: zone }));
  assert(valid('cn.attackDamageOptions@1', { effect: { op: 'attackDamageOptions', scope: 'self', ignoreWeakness: true } }));
  for (const effect of [{ ...zone, ignoreDefenderEffects: true }, { ...zone, received: undefined },
    { op: 'attackDamageOptions', scope: 'own', ignoreWeakness: true, targetWeakness: 'Psychic' }])
    assert(!valid('cn.attackDamageOptions@1', { effect }), JSON.stringify(effect));
  const shift = { op: 'pokemonTypes', typesFrom: 'attachedBasicEnergy', scope: 'self' };
  assert(valid('cn.pokemonTypes@1', { effect: shift }));
  for (const effect of [{ ...shift, typesFrom: 'eventEnergy' }, { ...shift, scope: 'all' }, { ...shift, types: ['Water'] }])
    assert(!valid('cn.pokemonTypes@1', { effect }), JSON.stringify(effect));
  const crystal = { side: 'own', target: 'self', effect: { op: 'pokemonTypes', typesFrom: 'eventEnergy', scope: 'all' }, duration: 'thisTurn',
    clearOnBench: false, clearOnEvolution: false };
  assert(valid('cn.lasting@1', crystal));
  assert(!valid('cn.lasting@1', { ...crystal, effect: { op: 'pokemonTypes', typesFrom: 'attachedBasicEnergy', scope: 'all' } }));
  const fence = { op: 'property', field: 'hp', value: 200, scope: 'self' };
  assert(valid('cn.property@1', { effect: fence }));
  assert(!valid('cn.property@1', { effect: { ...fence, value: 205 } })); assert(!valid('cn.property@1', { effect: { ...fence, value: 0 } }));
  const dusk = { op: 'evolvePokemon', target: 'any', targetSelector: { kind: 'pokemon' }, from: 'deck', selector: { kind: 'pokemon', nameKeys: ['evolution'] },
    relation: 'ordinary', timing: { firstOwnTurn: 'allow', enteredThisTurn: 'allow', evolvedThisTurn: 'forbid' }, shuffleAfter: true, evolvableTarget: true };
  assert(valid('cn.pokemonTransition@1', dusk));
  assert(!valid('cn.pokemonTransition@1', { ...dusk, from: 'hand', shuffleAfter: false }));
  assert(!valid('cn.pokemonTransition@1', { ...dusk, each: true }));
  const count = { kind: 'pokemonCount', side: 'own', zone: 'bench', maximumHp: 30 };
  assert.doesNotThrow(() => assertBattleValue(count)); assert(valid('cn.drawValue@1', { count }));
  for (const maximumHp of [35, 0, '30']) assert.throws(() => assertBattleValue({ ...count, maximumHp }), /maximum HP/);
  assert.doesNotThrow(() => assertPokemonState({ abilityNames: ['测试祭典'] }));
  for (const abilityNames of [[], ['x', 'x'], [1], [''], 'x']) assert.throws(() => assertPokemonState({ abilityNames }), /Ability names/);
});

test('selection.context: the values read from the effect\'s own context; nothing to read, no card; names the deck cannot hold', () => {
  const card = (definitionId, owner) => ({ definitionId, owner });
  const definitions = {
    water: { kind: 'energy', nameKey: 'water', deckLimits: { sameName: null, groups: [] }, mechanics: { category: 'basic', baseUnits: [['Water']] } },
    fire: { kind: 'energy', nameKey: 'fire', deckLimits: { sameName: null, groups: [] }, mechanics: { category: 'basic', baseUnits: [['Fire']] } },
    double: { kind: 'energy', nameKey: 'double', deckLimits: { sameName: 4, groups: [] }, mechanics: { category: 'special', baseUnits: [['Colorless'], ['Colorless']] } },
    pika: { kind: 'pokemon', nameKey: 'pika', deckLimits: { sameName: 4, groups: [] }, mechanics: { types: ['Lightning'] } },
    shine: { kind: 'pokemon', nameKey: 'shine', deckLimits: { sameName: 4, groups: [{ key: 'cn-radiant', maximum: 1 }] }, mechanics: { types: ['Fire'] } },
    glow: { kind: 'pokemon', nameKey: 'glow', deckLimits: { sameName: 4, groups: [{ key: 'cn-radiant', maximum: 1 }] }, mechanics: { types: ['Water'] } },
    doll: { kind: 'pokemon', nameKey: 'doll', deckLimits: { sameName: 4, groups: [] }, mechanics: { types: ['Colorless'], itemCard: { leave: {} } } },
  };
  const mon = (id, top, energy = []) => ({ id, stack: [top], energy, tools: [] });
  const state = {
    cards: { a: card('pika', 1), b: card('shine', 1), e1: card('water', 0), e2: card('fire', 0), e3: card('double', 0), s: card('pika', 0),
      d1: card('doll', 0), d2: card('glow', 0), h1: card('pika', 0), h2: card('pika', 0), h3: card('pika', 0), loose: card('fire', 0) },
    players: [
      { active: mon('m0', 's', ['e1', 'e2', 'e3']), bench: [], hand: [], discard: ['d1'], lost: [], resolving: [], deck: [] },
      { active: mon('m1', 'a'), bench: [mon('m2', 'b')], hand: [], discard: [], lost: [], resolving: [], deck: [] },
    ],
  };
  const effectivePokemon = { m0: { types: ['Lightning'], energies: [{ instanceId: 'e1', units: [['Water'], ['Water']] },
    { instanceId: 'e2', units: [['Fire']] }, { instanceId: 'e3', units: [['Colorless'], ['Colorless']] }] },
  m1: { types: ['Lightning', 'Metal'], energies: [] }, m2: { types: ['Fire'], energies: [] } };
  const ctx = (extra = {}) => ({ state, definitions, effectivePokemon, source: { owner: 0, pokemonId: 'm0' }, event: null, ...extra });
  assert.deepEqual(readTypes(ctx(), 'opponentField'), ['Lightning', 'Metal', 'Fire']);
  assert.deepEqual(readTypes(ctx(), 'attachedBasicEnergy'), ['Water', 'Fire'], 'Basic Energy only; each type once.');
  assert.deepEqual(readTypes(ctx({ event: { cardId: 'e1' } }), 'eventEnergy'), ['Water']);
  assert.deepEqual(readTypes(ctx({ event: { cardId: 'loose' } }), 'eventEnergy'), ['Fire'], 'A card no longer attached shows its printed type.');
  const named = { kind: 'pokemon', namesFrom: 'opponentField', stages: ['basic'] };
  assert.deepEqual(resolveContextSelector(named, ctx()), { kind: 'pokemon', stages: ['basic'], nameKeys: ['pika', 'shine'] });
  assert.deepEqual(resolveContextSelector({ kind: 'pokemon', namesFrom: 'ownDiscard' }, ctx()), null, 'A card printed as an Item is no Pokémon name.');
  state.players[0].discard.push('d2');
  assert.deepEqual(resolveContextSelector({ kind: 'pokemon', namesFrom: 'ownDiscard' }, ctx()), { kind: 'pokemon', nameKeys: ['glow'] });
  assert.equal(resolveContextSelector({ kind: 'any' }, ctx()).kind, 'any');
  assert.throws(() => matchesCardSelector(definitions.pika, named), /resolves/);
  // JP Q&A ラブラブボール: 4 of a name seen outside the deck, or a Radiant of the user's own, leave no possible card of that name.
  assert(contextSearchPossible(ctx(), named, 0));
  assert(contextSearchPossible(ctx(), { kind: 'pokemon', typesFrom: 'attachedBasicEnergy' }, 0));
  assert(contextSearchPossible(ctx(), { kind: 'pokemon' }, 0));
  state.players[0].hand.push('h1', 'h2'); state.players[0].faceUpPrizes = ['h3'];
  state.players[0].discard.splice(state.players[0].discard.indexOf('d2'), 1); state.players[0].bench.push(mon('m3', 'd2'));
  assert(!contextSearchPossible(ctx(), named, 0), 'Four pika seen and the user\'s own Radiant in play.');
  delete state.players[0].faceUpPrizes;
  assert(contextSearchPossible(ctx(), named, 0));
  state.players[1].active = mon('m1', 'b'); state.players[1].bench = [];
  assert(!contextSearchPossible(ctx(), { kind: 'pokemon', namesFrom: 'opponentField' }, 0), 'Only a Radiant left, and the user has one.');
  state.players[0].discard = [];
  assert(!contextSearchPossible(ctx(), { kind: 'pokemon', namesFrom: 'ownDiscard' }, 0), 'No Pokémon in the discard pile: nothing to read.');
});

test('printed traits: Resistance (never a V-UNION card out of play, never in play), excluded name text, ACE SPEC', async () => {
  const f = await fixture();
  const base = f.definitions.find((d) => d.definitionId === 'base');
  const with_ = (mechanics, extra = {}) => ({ ...base, ...extra, mechanics: { ...base.mechanics, ...mechanics } });
  const fighting = { kind: 'pokemon', resistanceTypes: ['Fighting'] };
  assert(matchesCardSelector(with_({ resistance: { type: 'Fighting', value: 30 } }), fighting));
  assert(!matchesCardSelector(with_({ resistance: { type: 'Water', value: 30 } }), fighting));
  assert(!matchesCardSelector(base, fighting), 'No Resistance.');
  assert(!matchesCardSelector(with_({ stage: 'V-UNION', resistance: { type: 'Fighting', value: 30 } }), fighting), 'JP Q&A マメパト「とりぶえ」.');
  assert.throws(() => matchesInPlaySelector(base, fighting, ['Water']), /Resistance/);
  const rocket = { kind: 'pokemon', excludeNameContains: '火箭队的' };
  assert(matchesCardSelector(base, rocket)); assert(!matchesCardSelector({ ...base, name: '火箭队的测试' }, rocket));
  const item = f.definitions.find((d) => d.definitionId === 'potion'), aceItem = { ...item, deckLimits: { sameName: 4, groups: [{ key: ACE_SPEC_GROUP, maximum: 1 }] } };
  assert(matchesCardSelector(aceItem, { kind: 'trainer', aceSpec: true })); assert(!matchesCardSelector(item, { kind: 'trainer', aceSpec: true }));
  assert(matchesCardSelector(item, { kind: 'trainer', aceSpec: false })); assert(!matchesCardSelector(aceItem, { kind: 'trainer', aceSpec: false }));
});

// The deck's Pokémon cards (by id) whose printed card passes the test.
const deckPokemon = (f, s, owner, test) => s.players[owner].deck.filter((id) => { const d = f.catalog.definition(s.cards[id].definitionId); return d.kind === 'pokemon' && test(d); });
// The opponent's Active replaced by a fresh one of this card (the old one's cards back into the hand).
const swapActive = (s, owner, id) => { const p = s.players[owner]; p.hand.push(...p.active.stack, ...p.active.energy, ...p.active.tools); p.active = bench(s, owner, id); p.bench.pop(); return p.active; };
// Every card of this definition the player has in the hand or Prize cards put into the deck (a Prize replaced from the deck).
const gather = (s, owner, id) => {
  const p = s.players[owner], mine = (c) => s.cards[c].definitionId === id;
  p.hand.filter(mine).forEach((c) => { p.hand.splice(p.hand.indexOf(c), 1); p.deck.unshift(c); });
  p.prizes.forEach((c, i) => { if (mine(c)) { p.prizes[i] = p.deck.findLast((x) => !mine(x)); p.deck.splice(p.deck.lastIndexOf(p.prizes[i]), 1); p.deck.unshift(c); } });
};
const trainerOf = (f, s, owner, id) => s.players[owner].hand.find((c) => s.cards[c].definitionId === id);

async function searchFixture() {
  return include(await fixture((defs) => {
    def(defs, 'other').mechanics.types = ['Grass'];
    mon(defs, 'fireMon', { types: ['Fire'] }); mon(defs, 'psyMon', { types: ['Psychic'] });
    const tool = structuredClone(def(defs, 'tool'));
    defs.push(Object.assign(tool, { definitionId: 'tint', nameKey: 'tint', name: '测试变色道具' }));
    tool.mechanics.effects = [binding('cn.pokemonTypes@1', { effect: { op: 'pokemonTypes', types: ['Fire', 'Psychic'], scope: 'self' } }, 'tint')];
    for (const [id, selector] of [['friend', { kind: 'pokemon', typesFrom: 'opponentField' }], ['sweet', { kind: 'pokemon', namesFrom: 'opponentField' }],
      ['bell', { kind: 'pokemon', namesFrom: 'ownDiscard' }]]) {
      const d = structuredClone(def(defs, 'potion'));
      defs.push(Object.assign(d, { definitionId: id, nameKey: id, name: `测试${id}` }));
      d.mechanics.effects = [binding('cn.cards@1', search(selector), id)];
    }
  }), 'friend', 'sweet', 'bell', 'fireMon', 'fireMon', 'fireMon', 'fireMon', 'psyMon', 'evolution', 'tint');
}

test('「与对手场上宝可梦相同属性的1张宝可梦」: the opponent\'s Pokémon\'s current types, either of a dual type', async () => {
  const f = await searchFixture();
  let g = board(f, (s) => hand(s, 0, 'friend'));
  const s0 = g.snapshot(), friend = trainerOf(f, s0, 0, 'friend');
  command(g, { type: 'playTrainer', cardId: friend });
  let s = g.snapshot();
  assert.equal(s.pending.kind, 'select-cards');
  assert.deepEqual([...s.pending.options].sort(), deckPokemon(f, s, 0, (d) => d.mechanics.types.includes('Water')).sort());
  g = restore(g, f); answer(g, [s.pending.options[0]]); settle(g);
  assert(g.snapshot().players[0].hand.includes(s.pending.options[0]));
  // JP Q&A フレンドボール: a type an effect gave it is its type (here a Tool's type change to Fire and Psychic).
  g = board(f, (s) => { hand(s, 0, 'friend'); const t = hand(s, 1, 'tint'); s.players[1].hand.pop(); s.players[1].active.tools.push(t); });
  assert.deepEqual(g.view(0).players[1].active.effective.types, ['Fire', 'Psychic']);
  command(g, { type: 'playTrainer', cardId: trainerOf(f, g.snapshot(), 0, 'friend') });
  s = g.snapshot();
  const expected = deckPokemon(f, s, 0, (d) => d.mechanics.types.some((t) => ['Fire', 'Psychic'].includes(t)));
  assert(expected.length > 0); assert.deepEqual([...s.pending.options].sort(), expected.sort());
});

test('「与对手场上宝可梦名字相同的1张宝可梦」 and 「与自己弃牌区中的宝可梦名字相同的」: names read now; a name the deck cannot hold offers nothing', async () => {
  const f = await searchFixture();
  let g = board(f, (s) => { hand(s, 0, 'sweet'); bench(s, 1, 'fireMon'); });
  let s = g.snapshot();
  command(g, { type: 'playTrainer', cardId: trainerOf(f, s, 0, 'sweet') });
  s = g.snapshot();
  assert.deepEqual([...s.pending.options].sort(), deckPokemon(f, s, 0, (d) => ['base', 'fireMon'].includes(d.nameKey)).sort());
  restore(g, f);
  // JP Q&A ラブラブボール: the opponent has only that name and the user's four of it are all outside the deck.
  const only = (seen) => board(f, (s) => { hand(s, 0, 'sweet'); swapActive(s, 1, 'fireMon'); for (let i = 0; i < seen; i++) bench(s, 0, 'fireMon'); });
  g = only(3); assert(playable(g, trainerOf(f, g.snapshot(), 0, 'sweet')));
  g = only(4); assert(!playable(g, trainerOf(f, g.snapshot(), 0, 'sweet')));
  // Own discard pile: no Pokémon there, nothing to read.
  g = board(f, (s) => hand(s, 0, 'bell'));
  assert(!playable(g, trainerOf(f, g.snapshot(), 0, 'bell')));
  g = board(f, (s) => { hand(s, 0, 'bell'); put(s, 0, 'evolution', 'discard'); put(s, 0, 'potion', 'discard'); });
  command(g, { type: 'playTrainer', cardId: trainerOf(f, g.snapshot(), 0, 'bell') });
  s = g.snapshot();
  assert.deepEqual(s.pending.options, deckPokemon(f, s, 0, (d) => d.nameKey === 'evolution'));
  assert.equal(s.pending.options.length, 1);
  restore(g, f);
});

test('「与这只宝可梦身上附着的基本能量相同属性的宝可梦合计最多5张」: the attached Basic Energy cards\' types now', async () => {
  const f = include(await fixture((defs) => {
    def(defs, 'other').mechanics.types = ['Grass'];
    mon(defs, 'fireMon', { types: ['Fire'] });
    def(defs, 'base').mechanics.attacks.push({ attackId: 'base:sweets', name: '测试彩色甜点', cost: [], printedDamage: null,
      effects: [binding('cn.cards@1', search({ kind: 'pokemon', typesFrom: 'attachedBasicEnergy' }, { quantity: { kind: 'upTo', count: 5 } }), 'sweets')],
      sourceOfTruth: EVIDENCE });
  }), 'fireMon', 'fireMon', 'fire');
  const run = (...energy) => {
    const g = board(f, (s) => { for (const id of energy) attached(s, 0, s.players[0].active, id); });
    command(g, { type: 'attack', attackId: 'base:sweets' });
    return g;
  };
  let g = run('water', 'fire', 'double'), s = g.snapshot();
  assert.deepEqual([...s.pending.options].sort(), deckPokemon(f, s, 0, (d) => ['Water', 'Fire'].some((t) => d.mechanics.types.includes(t))).sort());
  assert(!s.pending.options.some((id) => s.cards[id].definitionId === 'other'));
  restore(g, f);
  g = run('fire'); s = g.snapshot();
  assert.deepEqual([...s.pending.options].sort(), deckPokemon(f, s, 0, (d) => d.mechanics.types.includes('Fire')).sort());
  // Only a Special Energy attached: no Basic Energy type to read, so no card can be chosen.
  g = run('double'); s = g.snapshot();
  assert(!s.pending || !s.pending.options.some((id) => s.players[0].deck.includes(id) && f.catalog.definition(s.cards[id].definitionId).kind === 'pokemon'));
  const hand0 = s.players[0].hand.length; settle(g);
  assert.equal(g.snapshot().players[0].hand.length, hand0);
});

async function attachFixture() {
  return include(await fixture((defs) => {
    for (const [id, type] of [['fireEvo', 'Fire'], ['psyEvo', 'Psychic']])
      Object.assign(mon(defs, id, { types: [type], stage: 'stage1', evolvesFrom: 'base' }), { nameKey: id });
    def(defs, 'base').mechanics.abilities = [{ abilityId: 'base:energy-evolve', name: '测试能量进化', mode: 'triggered', usage: null,
      trigger: { event: 'energyAttached', subject: 'self', origin: 'hand', turn: 'own', scope: 'global', choiceOwner: 'source', optional: true,
        cardSelector: { kind: 'energy', category: 'basic' } },
      effects: [binding('cn.pokemonTransition@1', { op: 'evolvePokemon', target: 'self', targetSelector: { kind: 'pokemon' }, from: 'deck',
        selector: { kind: 'pokemon', typesFrom: 'eventEnergy' }, relation: 'ordinary',
        timing: { firstOwnTurn: 'allow', enteredThisTurn: 'allow', evolvedThisTurn: 'forbid' }, shuffleAfter: true }, 'energy-evolve')],
      sourceOfTruth: EVIDENCE }];
    const other = def(defs, 'other');
    other.mechanics.types = ['Colorless'];
    other.mechanics.abilities = [{ abilityId: 'other:crystal', name: '测试水晶', mode: 'triggered', usage: null,
      trigger: { event: 'energyAttached', subject: 'self', origin: 'hand', turn: 'own', scope: 'global', choiceOwner: 'source', optional: false,
        cardSelector: { kind: 'energy', category: 'basic', types: ['Fire', 'Water', 'Psychic'] } },
      effects: [binding('cn.lasting@1', { side: 'own', target: 'self', effect: { op: 'pokemonTypes', typesFrom: 'eventEnergy', scope: 'all' },
        duration: 'thisTurn', clearOnBench: false, clearOnEvolution: false }, 'crystal')], sourceOfTruth: EVIDENCE }];
    def(defs, 'potion').mechanics.effects = [binding('cn.attachHand@1', { type: 'Water', count: 1, benchOnly: false, optional: false }, 'charge')];
  }), 'fireEvo', 'psyEvo', 'fire');
}

test('「将与被附着的能量相同属性的，从这只宝可梦进化而来的卡牌…进行进化」: the attached Energy\'s type, read when the Ability resolves', async () => {
  const f = await attachFixture();
  for (const [energy, evolution] of [['fire', 'fireEvo'], ['water', 'evolution']]) {
    let g = board(f, (s) => hand(s, 0, energy));
    const s0 = g.snapshot(), cardId = s0.players[0].hand.at(-1), active = s0.players[0].active.id;
    command(g, { type: 'attachEnergy', cardId, pokemonId: active });
    assert.equal(g.snapshot().pending.kind, 'trigger-optional');
    g = restore(g, f); answer(g, ['perform']);
    assert.equal(g.snapshot().pending.kind, 'transition-target'); answer(g, [active]);
    const s = g.snapshot();
    assert.deepEqual(s.pending.options.map((id) => s.cards[id].definitionId), [evolution]);
    g = restore(g, f); settle(g, (q) => q.options.slice(0, 1));
    assert.equal(g.snapshot().cards[g.snapshot().players[0].active.stack.at(-1)].definitionId, evolution);
  }
  // A Special Energy is not 「基本能量」: no trigger.
  const g = board(f, (s) => hand(s, 0, 'double'));
  command(g, { type: 'attachEnergy', cardId: g.snapshot().players[0].hand.at(-1), pokemonId: g.snapshot().players[0].active.id });
  assert.equal(g.snapshot().pending, null);
});

test('「在那个回合结束前，这只宝可梦的属性变为和附着的基本能量卡相同」: each attachment\'s type replaces the last; the turn\'s end restores', async () => {
  const f = await attachFixture();
  let g = board(f, (s) => { activate(s, 0, 'other'); hand(s, 0, 'fire'); hand(s, 0, 'potion'); hand(s, 0, 'water'); });
  const types = () => g.view(0).players[0].active.effective.types, s0 = g.snapshot(), p0 = s0.players[0];
  assert.deepEqual(types(), ['Colorless']);
  command(g, { type: 'attachEnergy', cardId: p0.hand.find((id) => s0.cards[id].definitionId === 'fire'), pokemonId: p0.active.id }); settle(g);
  assert.deepEqual(types(), ['Fire']);
  g = restore(g, f);
  command(g, { type: 'playTrainer', cardId: trainerOf(f, g.snapshot(), 0, 'potion') });
  settle(g, (q) => q.options.filter((id) => id === p0.active.id || g.snapshot().cards[id]?.definitionId === 'water').slice(0, 1));
  assert.deepEqual(types(), ['Water']);
  assert.equal(g.snapshot().ongoing.filter((e) => e.effect.op === 'pokemonTypes').length, 1);
  g = restore(g, f); command(g, { type: 'endTurn' }); settle(g);
  assert.deepEqual(g.view(0).players[0].active.effective.types, ['Colorless']);
});

test('「会变为与这只宝可梦身上附有的基本能量相同的属性（附有2种以上…同时变为各种对应的属性）」: the attached Basic Energy cards\' types', async () => {
  const f = include(await fixture((defs) => {
    const other = def(defs, 'other');
    other.mechanics.types = ['Colorless'];
    other.mechanics.abilities = [continuous('other:shift', [binding('cn.pokemonTypes@1', { effect: { op: 'pokemonTypes', typesFrom: 'attachedBasicEnergy', scope: 'self' } }, 'shift')])];
    for (const [id, units] of [['toFire', [['Fire']]], ['twice', [['Water'], ['Water']]]])
      mon(defs, id, { abilities: [continuous(`${id}:provision`, [binding('cn.energyProvision@1', { effect: { op: 'energyProvision', scope: 'own', cardSelf: false,
        selector: { kind: 'energy', category: 'basic', types: ['Water'] }, units } }, id)])] });
  }), 'fire', 'toFire', 'twice');
  const shifted = (energy, mutate = () => {}) => {
    const g = board(f, (s) => { const m = activate(s, 0, 'other'); for (const id of energy) attached(s, 0, m, id); mutate(s); });
    return g;
  };
  assert.deepEqual(shifted([]).view(0).players[0].active.effective.types, ['Colorless'], 'No Basic Energy: its printed type.');
  assert.deepEqual(shifted(['double']).view(0).players[0].active.effective.types, ['Colorless']);
  const g = shifted(['water', 'fire', 'double']);
  assert.deepEqual([...g.view(0).players[0].active.effective.types].sort(), ['Fire', 'Water']);
  restore(g, f);
  assert.deepEqual(g.view(0).players[1].active.effective.types, ['Water'], 'Only this Pokémon.');
  // A Water Energy card providing Fire (a later layer): the two layers disagree and need a CN ruling.
  assert.throws(() => shifted(['water'], (s) => bench(s, 0, 'toFire')).view(0), (e) => e.code === 'unsupported-type-provision');
  assert.deepEqual(shifted(['water'], (s) => bench(s, 0, 'twice')).view(0).players[0].active.effective.types, ['Water'],
    'Providing its own type twice is still that type.');
});

test('「造成自己最大HP为「30」的备战宝可梦数量×30伤害」: the current maximum HP, exactly', async () => {
  const f = include(await fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.weakness = null;
    mon(defs, 'tiny', { hp: 30 });
    const a = def(defs, 'base').mechanics.attacks[0]; a.printedDamage = null;
    a.effects = [binding('cn.damageValue@1', { expression: { kind: 'multiply', left: { kind: 'literal', value: 30 },
      right: { kind: 'pokemonCount', side: 'own', zone: 'bench', maximumHp: 30 } } }, 'count')];
  }), 'tiny', 'tiny', 'tiny');
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water');
    bench(s, 0, 'tiny'); bench(s, 0, 'tiny'); bench(s, 0, 'other');
    const raised = bench(s, 0, 'tiny'), tool = hand(s, 0, 'hp-tool'); s.players[0].hand.pop(); raised.tools.push(tool);
    bench(s, 1, 'tiny');
  });
  assert.deepEqual(g.view(0).players[0].bench.map((m) => m.effective.maxHp), [30, 30, 100, 80]);
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  assert.equal(restore(g, f).snapshot().players[1].active.counters, 6);
});

test('「抗性为【斗】属性的宝可梦」: the printed Resistance of cards in the deck', async () => {
  const f = include(await fixture((defs) => {
    mon(defs, 'tough', { resistance: { type: 'Fighting', value: 30 } }); mon(defs, 'wet', { resistance: { type: 'Water', value: 30 } });
    def(defs, 'potion').mechanics.effects = [binding('cn.cards@1', search({ kind: 'pokemon', resistanceTypes: ['Fighting'] }, { quantity: { kind: 'upTo', count: 2 } }), 'bird')];
  }), 'tough', 'tough', 'wet');
  const g = board(f, (s) => hand(s, 0, 'potion'));
  command(g, { type: 'playTrainer', cardId: trainerOf(f, g.snapshot(), 0, 'potion') });
  const s = g.snapshot();
  assert.deepEqual([...s.pending.options].sort(), deckPokemon(f, s, 0, (d) => d.definitionId === 'tough').sort());
  assert(s.pending.options.length > 0); restore(g, f);
});

test('「如果对手的剩余奖赏卡张数在3张以下（包含3张），则这只宝可梦的最大HP变为「200」」: set first, then +N', async () => {
  const f = await fixture((defs) => {
    def(defs, 'other').mechanics.abilities = [continuous('other:fence', [binding('cn.property@1', { effect: { op: 'property', field: 'hp', value: 200,
      scope: 'self', condition: { kind: 'compare', left: { kind: 'zoneCount', side: 'opponent', zone: 'prizes' }, relation: 'lte', right: { kind: 'literal', value: 3 } } } }, 'fence')])];
  });
  const hpOf = (prizes, tool = false) => {
    const g = board(f, (s) => {
      const m = activate(s, 0, 'other'), p = s.players[1];
      p.discard.push(...p.prizes.splice(prizes));
      if (tool) { const id = hand(s, 0, 'hp-tool'); s.players[0].hand.pop(); m.tools.push(id); }
    });
    return restore(g, f).view(0).players[0].active.effective.maxHp;
  };
  assert.equal(hpOf(4), 100); assert.equal(hpOf(3), 200); assert.equal(hpOf(1), 200);
  assert.equal(hpOf(3, true), 250, 'JP Q&A ソルロック「サンライト」: the HP set first, +50 on top.');
  assert.equal(hpOf(4, true), 150);
});

test('「当双方场上拥有【超】属性弱点的宝可梦，受到招式的伤害时，不计算弱点」: the damaged Pokémon\'s current Weakness, whoever attacks', async () => {
  const f = await fixture((defs) => {
    const base = def(defs, 'base');
    base.mechanics.types = ['Psychic', 'Fire']; base.mechanics.weakness = { type: 'Psychic', operation: 'multiply', value: 2 };
    def(defs, 'other').mechanics.abilities = [continuous('other:field', [binding('cn.attackDamageOptions@1', { effect: { op: 'attackDamageOptions',
      scope: 'all', received: true, ignoreWeakness: true, targetWeakness: 'Psychic' } }, 'field')])];
    def(defs, 'tool').mechanics.effects = [binding('cn.property@1', { effect: { op: 'property', field: 'weakness', value: { type: 'Fire', operation: 'multiply', value: 2 }, scope: 'self' } }, 'fire-weak')];
    def(defs, 'evolution').mechanics.types = ['Psychic'];
    def(defs, 'evolution').mechanics.abilities = [continuous('evolution:pierce', [binding('cn.attackDamageOptions@1', { effect: { op: 'attackDamageOptions',
      scope: 'self', ignoreDefenderEffects: true } }, 'pierce')])];
  });
  const dealt = (mutate, attackId = 'base:strike') => {
    const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); mutate(s); });
    command(g, { type: 'attack', attackId }); settle(g);
    return restore(g, f).snapshot().players[1].active.counters * 10;
  };
  assert.equal(dealt(() => {}), 40, 'Weakness ×2 without it.');
  assert.equal(dealt((s) => bench(s, 1, 'other')), 20, 'On the opponent\'s field.');
  assert.equal(dealt((s) => bench(s, 0, 'other')), 20, 'On the attacker\'s field.');
  const fireWeak = (s) => { const id = hand(s, 1, 'tool'); s.players[1].hand.pop(); s.players[1].active.tools.push(id); };
  assert.equal(dealt((s) => { bench(s, 1, 'other'); fireWeak(s); }), 40, 'Its Weakness is now Fire: the Fire attacker\'s Weakness applies.');
  // JP Q&A ジラーチGX: an attack ignoring effects on the defender does not ignore this.
  const pierce = (s) => { const p = s.players[0], e = hand(s, 0, 'evolution'); p.hand.pop(); p.active.stack.push(e); };
  assert.equal(dealt((s) => pierce(s), 'evolution:strike'), 40);
  assert.equal(dealt((s) => { bench(s, 1, 'other'); pierce(s); }, 'evolution:strike'), 20);
});

const lockOf = (cardSelector, extra = {}) => binding('cn.playerRestriction@1', { effect: { op: 'playerRestriction', scope: 'opponent', actions: ['playFromHand'], cardSelector, ...extra } }, 'lock');
const aceLock = lockOf({ anyOf: [{ kind: 'trainer', aceSpec: true }, { kind: 'energy', aceSpec: true }] }, { condition: { kind: 'pokemonIs', who: 'self', state: { hasTool: true } } });

test('「如果这只宝可梦身上放有「宝可梦道具」的话，则对手无法从手牌使出「【ACE SPEC】」卡牌」: only those cards, only from the hand', async () => {
  const f = include(await fixture((defs) => {
    def(defs, 'other').mechanics.abilities = [continuous('other:lock', [aceLock])];
    const d = ace(structuredClone(def(defs, 'potion')));
    defs.push(Object.assign(d, { definitionId: 'acePotion', nameKey: 'acePotion', name: '测试ACE伤药' }));
  }), 'acePotion');
  const g = (tool) => board(f, (s) => {
    hand(s, 0, 'acePotion'); hand(s, 0, 'potion');
    const m = activate(s, 1, 'other');
    if (tool) { const id = hand(s, 1, 'tool'); s.players[1].hand.pop(); m.tools.push(id); }
    s.players[0].active.counters = 3;
  });
  const locked = g(true), s = locked.snapshot();
  assert(!playable(locked, trainerOf(f, s, 0, 'acePotion')));
  assert(playable(locked, trainerOf(f, s, 0, 'potion')), 'Not an ACE SPEC card.');
  assert.throws(() => command(locked, { type: 'playTrainer', cardId: trainerOf(f, s, 0, 'acePotion') }), (e) => e.code === 'illegal-action');
  restore(locked, f);
  const open = g(false);
  assert(playable(open, trainerOf(f, open.snapshot(), 0, 'acePotion')), 'No Tool on it.');
});

test('「无法从手牌使出【ACE SPEC】卡牌」 also stops an ACE SPEC Energy attached from the hand, by hand or by an effect', async () => {
  const f = include(await fixture((defs) => {
    def(defs, 'other').mechanics.abilities = [continuous('other:lock', [aceLock])];
    const d = ace(structuredClone(def(defs, 'double')));
    defs.push(Object.assign(d, { definitionId: 'aceEnergy', nameKey: 'aceEnergy', name: '测试ACE能量' }));
    def(defs, 'potion').mechanics.effects = [binding('cn.attachHand@1', { type: null, category: 'special', count: 1, benchOnly: false, optional: false }, 'attach')];
  }), 'aceEnergy');
  let ids;
  const g = board(f, (s) => {
    ids = { ace: hand(s, 0, 'aceEnergy'), plain: hand(s, 0, 'double'), item: hand(s, 0, 'potion') };
    const m = activate(s, 1, 'other'), t = hand(s, 1, 'tool'); s.players[1].hand.pop(); m.tools.push(t);
  });
  const attaches = g.view(0).legalActions.filter((a) => a.type === 'attachEnergy').map((a) => a.cardId);
  assert(!attaches.includes(ids.ace)); assert(attaches.includes(ids.plain));
  command(g, { type: 'playTrainer', cardId: ids.item });
  const q = g.snapshot().pending;
  assert.equal(q.kind, 'hand-energy'); assert(!q.options.includes(ids.ace)); assert(q.options.includes(ids.plain));
  restore(g, f);
  // Only the ACE SPEC Energy to attach: the effect could attach nothing, so the card cannot be used.
  const only = (tool) => board(f, (s) => {
    gather(s, 0, 'double'); ids = { ace: hand(s, 0, 'aceEnergy'), item: hand(s, 0, 'potion') };
    const m = activate(s, 1, 'other');
    if (tool) { const t = hand(s, 1, 'tool'); s.players[1].hand.pop(); m.tools.push(t); }
  });
  assert(!playable(only(true), ids.item)); assert(playable(only(false), ids.item));
});

test('「只要这只宝可梦在战斗场上，对手无法从手牌将拥有特性的宝可梦（除「火箭队的宝可梦」外）放于场上」', async () => {
  const rise = (id) => ({ abilityId: `${id}:rise`, name: '测试登场', mode: 'activated', zone: 'hand', sourceOfTruth: EVIDENCE,
    usage: { period: 'turn', scope: 'pokemon', key: `${id}:rise`, limit: 1 }, effects: [binding('cn.deploySelf@1', {}, `${id}-rise`)] });
  const peek = { abilityId: 'abil:peek', name: '测试窥视', mode: 'activated', zone: 'hand', sourceOfTruth: EVIDENCE,
    usage: { period: 'turn', scope: 'pokemon', key: 'abil:peek', limit: 1 }, effects: [binding('cn.draw@1', { count: 1 }, 'peek')] };
  const f = include(await fixture((defs) => {
    def(defs, 'other').mechanics.abilities = [continuous('other:glare', [lockOf({ kind: 'pokemon', printedAbility: true, excludeNameContains: '火箭队的' }, { sourceActive: true })])];
    mon(defs, 'abil', { abilities: [rise('abil'), peek] });
    Object.assign(mon(defs, 'rocket', { abilities: [rise('rocket')] }), { name: '火箭队的测试宝可梦' });
    Object.assign(mon(defs, 'abilEvo', { stage: 'stage1', evolvesFrom: 'base', abilities: [rise('abilEvo')] }), {});
    def(defs, 'potion').mechanics.effects = [binding('cn.cards@1', { from: 'hand', to: 'bench', selector: { kind: 'pokemon', stages: ['basic'] },
      quantity: { kind: 'upTo', count: 2 }, reveal: false, lookTop: null, shuffleAfter: false }, 'deploy')];
    def(defs, 'poison').mechanics.effects = [binding('cn.pokemonTransition@1', { op: 'evolvePokemon', target: 'any', targetSelector: { kind: 'pokemon' }, from: 'hand',
      selector: { kind: 'pokemon' }, relation: 'ordinary', timing: { firstOwnTurn: 'allow', enteredThisTurn: 'allow', evolvedThisTurn: 'forbid' }, shuffleAfter: false }, 'candy')];
    def(defs, 'research').mechanics.effects = [binding('cn.cards@1', { from: 'deck', to: 'bench', selector: { kind: 'pokemon', nameKeys: ['abil'] },
      quantity: { kind: 'upTo', count: 1 }, reveal: false, lookTop: null, shuffleAfter: true }, 'call')];
  }), 'abil', 'abil', 'abil', 'rocket', 'abilEvo');
  let ids;
  const make = (active = true) => board(f, (s) => {
    gather(s, 0, 'abil');
    ids = { abil: hand(s, 0, 'abil'), rocket: hand(s, 0, 'rocket'), evo: hand(s, 0, 'abilEvo'), base: hand(s, 0, 'base'),
      item: hand(s, 0, 'potion'), call: hand(s, 0, 'research') };
    if (active) activate(s, 1, 'other'); else bench(s, 1, 'other');
  });
  const g = make(), legal = g.view(0).legalActions;
  const has = (type, cardId, abilityId) => legal.some((a) => a.type === type && a.cardId === cardId && (!abilityId || a.abilityId === abilityId));
  assert(!has('bench', ids.abil)); assert(!has('evolve', ids.evo)); assert(!has('useAbility', ids.abil, 'abil:rise'));
  assert(has('bench', ids.rocket), 'A Team Rocket\'s Pokémon.'); assert(has('useAbility', ids.rocket, 'rocket:rise'));
  assert(has('bench', ids.base), 'No Ability.');
  assert(has('useAbility', ids.abil, 'abil:peek'), 'An Ability that does not put the card into play.');
  // An effect putting cards from the hand onto the Bench offers only the cards not locked; from the deck is not from the hand.
  command(g, { type: 'playTrainer', cardId: ids.item });
  const q = g.snapshot().pending;
  assert(!q.options.includes(ids.abil)); assert(q.options.includes(ids.rocket)); assert(q.options.includes(ids.base));
  restore(g, f);
  const d = make();
  command(d, { type: 'playTrainer', cardId: ids.call });
  assert(d.snapshot().pending.options.length > 0 && d.snapshot().pending.options.every((id) => d.snapshot().cards[id].definitionId === 'abil'));
  const benched = make(false).view(0).legalActions;
  assert(benched.some((a) => a.type === 'bench' && a.cardId === ids.abil), 'Not in the Active Spot: no lock.');
  // Only locked cards for an effect to put into play from the hand: it cannot be used; with another card it offers only that one.
  let candy, deploy;
  const lockedOnly = (evolution) => board(f, (s) => {
    for (const id of ['base', 'other', 'evolution', 'rocket']) gather(s, 0, id);
    hand(s, 0, 'abil'); hand(s, 0, 'abilEvo'); candy = hand(s, 0, 'poison'); deploy = hand(s, 0, 'potion');
    if (evolution) hand(s, 0, 'evolution');
    activate(s, 1, 'other');
  });
  let h = lockedOnly(false);
  assert(!playable(h, candy)); assert(!playable(h, deploy));
  h = lockedOnly(true);
  assert(playable(h, candy));
  command(h, { type: 'playTrainer', cardId: candy });
  const target = h.snapshot().pending;
  assert.equal(target.kind, 'transition-target'); answer(h, [h.snapshot().players[0].active.id]);
  const cardsOffered = h.snapshot().pending.options.map((id) => h.snapshot().cards[id].definitionId);
  assert.deepEqual(cardsOffered, ['evolution']);
});

test('「如果自己的战斗宝可梦是拥有特性「祭典乐舞」的宝可梦的话」: an Ability of that name in effect now', async () => {
  const f = include(await fixture((defs) => {
    const dancer = mon(defs, 'dancer', { types: ['Psychic'] });
    dancer.mechanics.abilities = [{ abilityId: 'dancer:dance', name: '测试祭典', mode: 'activated', sourceOfTruth: EVIDENCE,
      usage: { period: 'turn', scope: 'pokemon', key: 'dance', limit: 1 }, effects: [binding('cn.draw@1', { count: 1 }, 'dance')] }];
    mon(defs, 'impostor', { types: ['Psychic'], abilities: [{ ...dancer.mechanics.abilities[0], abilityId: 'impostor:dance', name: '测试别的舞' }] });
    def(defs, 'other').mechanics.abilities = [{ abilityId: 'other:drum', name: '测试鼓', mode: 'activated', sourceOfTruth: EVIDENCE,
      usage: { period: 'turn', scope: 'pokemon', key: 'drum', limit: 1 },
      condition: { predicate: { kind: 'pokemonIs', who: 'ownActive', state: { abilityNames: ['测试祭典'] } } },
      effects: [binding('cn.cards@1', { from: 'deck', to: 'hand', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 1 }, reveal: false, lookTop: null, shuffleAfter: true }, 'drum')] }];
    def(defs, 'stadium').mechanics.effects = [binding('cn.suppression@1', { effect: { op: 'suppression', channel: 'abilities', scope: 'all', type: 'Psychic' } }, 'quiet')];
  }), 'dancer', 'impostor');
  const usable = (active, mutate = () => {}) => {
    let drummer;
    const g = board(f, (s) => { activate(s, 0, active); drummer = bench(s, 0, 'other').id; mutate(s); });
    return g.view(0).legalActions.some((a) => a.type === 'useAbility' && a.abilityId === 'other:drum' && a.pokemonId === drummer);
  };
  assert(usable('dancer')); assert(!usable('impostor'), 'Another Ability name.'); assert(!usable('base'), 'No Ability.');
  assert(!usable('dancer', (s) => { const id = hand(s, 1, 'stadium'); s.players[1].hand.pop(); s.stadium = id; }), 'JP Q&A バチンキー: an Ability without effect does not count.');
  assert.throws(() => matchesPokemonState({ conditions: { rotation: null, poison: null, burned: false }, stack: ['x'] }, { abilities: [{ abilityId: 'a', present: true }] },
    { abilityNames: ['测试祭典'] }), /card definition/);
});

test('「如果自己场上有可以进化为「X」的宝可梦的话，则…选择1张其进化卡」: a Pokémon some approved card of those names evolves', async () => {
  const stone = (evolvableTarget) => ({ op: 'evolvePokemon', target: 'any', targetSelector: { kind: 'pokemon' }, from: 'deck', selector: { kind: 'pokemon', nameKeys: ['evolution'] },
    relation: 'ordinary', timing: { firstOwnTurn: 'allow', enteredThisTurn: 'allow', evolvedThisTurn: 'forbid' }, shuffleAfter: true, ...(evolvableTarget ? { evolvableTarget } : {}) });
  for (const evolvableTarget of [true, false]) {
    const f = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.pokemonTransition@1', stone(evolvableTarget), 'stone')]; });
    const none = board(f, (s) => { hand(s, 0, 'potion'); swapActive(s, 0, 'other'); });
    assert.equal(playable(none, trainerOf(f, none.snapshot(), 0, 'potion')), !evolvableTarget, 'JP Q&A やみのいし: no Pokémon that card evolves.');
    if (!evolvableTarget) continue;
    const g = board(f, (s) => { hand(s, 0, 'potion'); bench(s, 0, 'other'); bench(s, 0, 'base'); });
    command(g, { type: 'playTrainer', cardId: trainerOf(f, g.snapshot(), 0, 'potion') });
    const s = g.snapshot();
    assert.equal(s.pending.kind, 'transition-target');
    assert.deepEqual(s.pending.options.map((id) => [s.players[0].active, ...s.players[0].bench].find((m) => m.id === id)).map((m) => s.cards[m.stack[0]].definitionId), ['base', 'base']);
    restore(g, f);
  }
});

test('selection.context guards: a board read only where its host resolves it', async () => {
  const f = await fixture();
  const trainer = (effects) => ({ ...def(f.definitions, 'potion'), mechanics: { ...def(f.definitions, 'potion').mechanics, effects } });
  const cards = (selector, extra = {}) => binding('cn.cards@1', search(selector, extra));
  assert.doesNotThrow(() => supported(f, trainer([cards({ kind: 'pokemon', typesFrom: 'opponentField' })])));
  const rejected = [
    trainer([cards({ kind: 'pokemon', typesFrom: 'opponentField' }, { from: 'discard', reveal: false, shuffleAfter: false })]),
    trainer([cards({ anyOf: [{ kind: 'pokemon', typesFrom: 'opponentField' }, { kind: 'trainer' }] })]),
    trainer([cards({ kind: 'pokemon', typesFrom: 'eventEnergy' })]),
    trainer([cards({ kind: 'pokemon', typesFrom: 'attachedBasicEnergy' })]),
    { ...def(f.definitions, 'tool'), mechanics: { ...def(f.definitions, 'tool').mechanics,
      effects: [binding('cn.pokemonTypes@1', { effect: { op: 'pokemonTypes', typesFrom: 'attachedBasicEnergy', scope: 'self' } })] } },
    trainer([binding('cn.heal@1', { target: 'any', amount: 30, targetSelector: { kind: 'pokemon', typesFrom: 'opponentField' } })]),
  ];
  for (const d of rejected) assert.throws(() => supported(f, d), (e) => e.code === 'unsupported-condition', JSON.stringify(d.mechanics.effects));
  const base = def(f.definitions, 'base');
  const withAbility = (ability) => ({ ...base, mechanics: { ...base.mechanics, abilities: [ability] } });
  assert.doesNotThrow(() => supported(f, withAbility(continuous('shift', [binding('cn.pokemonTypes@1', { effect: { op: 'pokemonTypes', typesFrom: 'attachedBasicEnergy', scope: 'self' } })]))));
  const hpCount = { kind: 'compare', left: { kind: 'pokemonCount', side: 'own', zone: 'bench', maximumHp: 30 }, relation: 'gte', right: { kind: 'literal', value: 1 } };
  assert.throws(() => supported(f, withAbility(continuous('fence', [binding('cn.modifier@1', { field: 'hp', amount: 30, scope: 'self', condition: hpCount })]))));
});
