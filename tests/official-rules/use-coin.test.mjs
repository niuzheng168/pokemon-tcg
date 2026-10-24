// Synthetic definitions only. 「只要这只宝可梦在战斗场上，当对手从手牌将能量附着于宝可梦身上时，在附着能量之前对手抛掷1次硬币。如果为反面，
// 则无法将该能量附着于宝可梦身上，并将该能量放于弃牌区。」 (effects.attach-coin); 「在下一个对手的回合，每当对手从手牌使出训练家时，在使用前
// 抛掷1次硬币。如果为反面，则那张卡牌不视作被使用过，将其放于弃牌区。」 (effects.trainer-coin); the interception point both share
// (effects.use-coin). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, assertSupportedDefinition } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { paymentOptionId } from '../../public/rules/activation-cost.js';
import { randomIndex } from '../../public/rules/random.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached, fixtureClock } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const handlers = createCoreHandlers(), catalog = { handler: (id) => handlers.get(id) };
const valid = (id, p) => handlers.get(id).validateParameters(clone(p));
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  for (const viewer of [0, 1]) assert.deepEqual(r.view(viewer), g.view(viewer));
  return r;
};
// A private RNG whose next coins show these faces (a test board, never a production seed).
const seedFor = (faces) => {
  for (let i = 1; i <= 8192; i++) {
    const seed = [Math.imul(i, 8000009) >>> 0, Math.imul(i, 333333331) >>> 0, Math.imul(i, 17) >>> 0, Math.imul(i, 37) >>> 0], rng = [...seed];
    if (faces.every((face) => (randomIndex(rng, 2) === 0) === (face === 'heads'))) return seed;
  }
  throw new Error(`No fixture seed for ${faces}`);
};
const ROOM = { op: 'useCoin', scope: 'opponent', actions: ['attachFromHand'], sourceActive: true };
const QUAKE = { op: 'useCoin', actions: ['playItem', 'playSupporter', 'playTool', 'playStadium'] };
const lasting = (key, effect) => ({ attackId: `other:${key}`, name: `测试${key}`, cost: [], printedDamage: null,
  effects: [binding('cn.lastingPlayer@1', { side: 'opponent', duration: 'nextOpponentTurn', effect }, key)], sourceOfTruth: EVIDENCE });
const fee = (count, costId = 'fee') => ({ costId, kind: 'discardHand', count, selector: { kind: 'any' }, sourceOfTruth: EVIDENCE });
const item = (defs, id, effects, extra = {}) => {
  const d = clone(def(defs, 'potion'));
  Object.assign(d, { definitionId: id, name: `测试${id}`, nameKey: id }); d.mechanics.effects = effects; Object.assign(d.mechanics, extra);
  defs.push(d);
};
const welder = (attach = {}) => binding('cn.attachThenDraw@1', { from: 'hand', draw: 3,
  attach: { type: 'Fire', count: 2, benchOnly: false, optional: false, ...attach } }, 'welder');
// 'other' is the Ability's Pokémon (and the attacks' user); 'base' gets a counter 「每当从手牌将能量附着于这只宝可梦身上时」.
async function make(transform = () => {}) {
  const f = await fixture((defs) => {
    const other = def(defs, 'other').mechanics;
    other.abilities = [{ abilityId: 'other:room', name: '测试粘滑屋', mode: 'continuous', usage: null,
      effects: [binding('cn.useCoin@1', { effect: ROOM }, 'room')], sourceOfTruth: EVIDENCE }];
    other.attacks.push(lasting('quake', QUAKE), lasting('slime', { op: 'useCoin', actions: ['attachFromHand'] }),
      lasting('headache', { op: 'coinFace', face: 'tails' }));
    const base = def(defs, 'base').mechanics;
    base.effects = [{ ...binding('cn.counters@1', { side: 'own', target: 'event', count: 1 }, 'sun'),
      trigger: { event: 'energyAttached', origin: 'hand', subject: 'self', optional: false, choiceOwner: 'source', scope: 'subject' } }];
    base.abilities = [{ abilityId: 'base:dance', name: '测试舞', mode: 'activated', usage: { period: 'turn', scope: 'pokemon', key: 'dance', limit: 1 },
      effects: [binding('cn.attachThenDraw@1', { from: 'hand', draw: 1, attach: { type: 'Water', count: 1, benchOnly: false, optional: false, target: 'self' } },
        'dance')], sourceOfTruth: EVIDENCE }];
    def(defs, 'research').mechanics.effects = [binding('cn.draw@1', { count: 2 }, 'research')];
    item(defs, 'choice', [binding('cn.lastingPlayer@1', { side: 'own', duration: 'thisTurn', effect: { op: 'coinChoice' } }, 'choice')]);
    item(defs, 'welder', [welder()], { category: 'supporter' });
    item(defs, 'ball', [binding('cn.draw@1', { count: 1 }, 'ball')], { playCosts: [fee(2)] });
    item(defs, 'pair', [binding('cn.draw@1', { count: 1 }, 'pair:one'), { ...binding('cn.draw@1', { count: 2 }, 'pair:two'), playCount: 2 }]);
    item(defs, 'arena', clone(def(defs, 'stadium').mechanics.effects), { category: 'stadium' });
    defs.push({ ...clone(def(defs, 'base')), definitionId: 'fossil', name: '测试化石', nameKey: 'fossil' });
    Object.assign(def(defs, 'fossil').mechanics, { hp: 60, types: ['Colorless'], weakness: null, retreatCost: 0, attacks: [], abilities: [], effects: [],
      itemCard: { leave: { from: 'field', to: 'discard' }, sourceOfTruth: EVIDENCE } });
    def(defs, 'double').mechanics.attachCosts = [fee(1)];
    transform(defs);
  });
  f.deck.splice(20, 16, ...['fire', 'fire', 'fire', 'research', 'research', 'choice', 'welder', 'ball', 'pair', 'pair', 'arena', 'arena',
    'fossil', 'potion', 'potion', 'double'].map((id) => `printing:${id}`));
  return f;
}
// The player's hand is exactly these cards (the rest goes to the discard pile).
const setHand = (s, owner, definitions) => {
  const p = s.players[owner]; p.discard.push(...p.hand.splice(0));
  const ids = definitions.map((d) => { const id = hand(s, owner, d); p.hand.pop(); return id; });
  p.hand.push(...ids);
  return ids;
};
// Player 1's Active Pokémon is the one with the Ability.
const room = (s) => { const o = bench(s, 1, 'other'), p = s.players[1]; p.bench = [p.active]; p.active = o; return o.stack[0]; };
// Player 1 uses one of its attacks; player 0's next turn follows (fixture turns 0,1,0,1 then this attack).
const afterAttack = (f, attackId, mutate) => {
  const g = board(f, (s) => { fixtureClock(s, [0, 1, 0, 1]); room(s); mutate(s); });
  command(g, { type: 'attack', attackId }); settle(g);
  assert.equal(g.snapshot().current, 0);
  return g;
};
const card = (g, id, owner = 0) => g.snapshot().players[owner].hand.find((c) => g.snapshot().cards[c].definitionId === id);
const play = (g, id) => command(g, { type: 'playTrainer', cardId: card(g, id) });
const coins = (g, ruleId) => g.snapshot().events.filter((e) => e.ruleId === ruleId).map((e) => e.data.results);
const pay = (g, ids) => answer(g, ids.map((id) => paymentOptionId('fee', id)));

test('schemas, rules and load guards: a Pokémon\'s own continuous Ability, or the opponent\'s next turn', async () => {
  for (const id of ['effects.use-coin', 'effects.attach-coin', 'effects.trainer-coin'])
    assert(requireRule(CN_V20261019, id).sourceOfTruth.some((s) => s.documentId === 'JP-official-qa'));
  assert(valid('cn.useCoin@1', { effect: ROOM }));
  for (const bad of [{ ...ROOM, scope: 'own' }, { ...ROOM, sourceActive: false }, { ...ROOM, actions: [] }, { ...ROOM, actions: ['attack'] },
    { op: 'useCoin', actions: ['attachFromHand'] }]) assert(!valid('cn.useCoin@1', { effect: bad }), JSON.stringify(bad));
  assert(valid('cn.lastingPlayer@1', { side: 'opponent', duration: 'nextOpponentTurn', effect: QUAKE }));
  for (const [side, duration] of [['own', 'nextOpponentTurn'], ['opponent', 'thisTurn'], ['opponent', 'game']])
    assert(!valid('cn.lastingPlayer@1', { side, duration, effect: QUAKE }), `${side} ${duration}`);
  assert(!valid('cn.lastingPlayer@1', { side: 'opponent', duration: 'nextOpponentTurn', effect: ROOM }));
  const f = await make();
  for (const id of ['other', 'base', 'welder', 'pair', 'fossil']) assertSupportedDefinition(catalog, def(f.definitions, id));
  // 「只要这只宝可梦在战斗场上」: a Pokémon's own text, never a Trainer's or an Energy's.
  for (const id of ['stadium', 'tool', 'double']) {
    const d = clone(def(f.definitions, id)); d.mechanics.effects = [binding('cn.useCoin@1', { effect: ROOM }, 'x')];
    assert.throws(() => assertSupportedDefinition(catalog, d), (e) => e.code === 'unsupported-handler', id);
  }
});

test('「在附着能量之前对手抛掷1次硬币。如果为反面，则无法将该能量附着…放于弃牌区」: the turn\'s attachment, coin first; tails leaves it unspent', async () => {
  const f = await make();
  let ids, source;
  let g = board(f, (s) => { source = room(s); ids = setHand(s, 0, ['water', 'water', 'water']); s.rng = seedFor(['tails', 'heads']); });
  const me = g.snapshot().players[0].active.id;
  command(g, { type: 'attachEnergy', cardId: ids[0], pokemonId: me });
  let s = g.snapshot();
  // Not attached, into the discard pile; no 「当附着能量时」, and the turn's attachment is not spent (JP Q&A ヌメルゴン).
  assert.deepEqual(s.players[0].active.energy, []); assert(s.players[0].discard.includes(ids[0])); assert.equal(s.players[0].flags.energy, false);
  assert.equal(s.players[0].active.counters, 0);
  assert(!s.events.some((e) => e.ruleId === 'turn.energy'));
  const event = s.events.findLast((e) => e.ruleId === 'effects.attach-coin');
  assert.deepEqual({ ...event.data, effectId: null, revealed: event.data.revealed.map((c) => c.definitionId) },
    { player: 0, effectId: null, sourceId: source, cards: [ids[0]], targets: [me], results: ['tails'], revealed: ['water'] });
  // The opponent sees the card, the coin and where it went.
  assert(g.view(1).events.some((e) => e.ruleId === 'effects.attach-coin' && e.data.revealed[0].definitionId === 'water'));
  assert(g.view(1).players[0].discard.some((c) => c.instanceId === ids[0]));
  assert(g.view(0).legalActions.some((a) => a.type === 'attachEnergy' && a.cardId === ids[1]));
  g = restore(g, f);
  command(g, { type: 'attachEnergy', cardId: ids[1], pokemonId: me });
  s = g.snapshot();
  assert.deepEqual(s.players[0].active.energy, [ids[1]]); assert.equal(s.players[0].flags.energy, true); assert.equal(s.players[0].active.counters, 1);
  assert(!g.view(0).legalActions.some((a) => a.type === 'attachEnergy'));
  assert.deepEqual(coins(g, 'effects.attach-coin'), [['tails'], ['heads']]);
  // Its owner's own attachments, and the opponent's while it is on the Bench: no coin.
  for (const mutate of [(s) => { room(s); fixtureClock(s, [0, 1, 0, 1]); }, (s) => { bench(s, 1, 'other'); }]) {
    g = board(f, (s) => { mutate(s); setHand(s, s.current, ['water']); });
    const p = g.snapshot().current, w = card(g, 'water', p);
    command(g, { type: 'attachEnergy', cardId: w, pokemonId: g.snapshot().players[p].active.id });
    assert.deepEqual(g.snapshot().players[p].active.energy, [w]); assert.deepEqual(coins(g, 'effects.attach-coin'), []);
  }
});

test('the coin before an attachment\'s cost; a chosen first coin pauses it; a forced face reads no RNG; corrupt waits are refused', async () => {
  const f = await make();
  // 「从手牌附着时，必须将1张手牌放于弃牌区」: tails, no cost is asked (JP Q&A オーロラエネルギー × ヌメルゴン).
  let ids;
  let g = board(f, (s) => { room(s); ids = setHand(s, 0, ['double', 'water']); s.rng = seedFor(['tails']); });
  const me = g.snapshot().players[0].active.id;
  command(g, { type: 'attachEnergy', cardId: ids[0], pokemonId: me });
  let s = g.snapshot();
  assert.equal(s.pending, null); assert.deepEqual(s.players[0].hand, [ids[1]]); assert(s.players[0].discard.includes(ids[0]));
  g = board(f, (s) => { room(s); ids = setHand(s, 0, ['double', 'water']); s.rng = seedFor(['heads']); });
  command(g, { type: 'attachEnergy', cardId: ids[0], pokemonId: me });
  assert.equal(g.snapshot().pending.kind, 'activation-cost'); assert.deepEqual(coins(g, 'effects.attach-coin'), [['heads']]);
  pay(g, [ids[1]]); settle(g);
  assert.deepEqual(g.snapshot().players[0].active.energy, [ids[0]]);
  // 一树 used first: the attachment's coin is the next flip of an effect (an Ability's), its face chosen.
  g = board(f, (s) => { room(s); ids = setHand(s, 0, ['choice', 'water']); });
  play(g, 'choice');
  command(g, { type: 'attachEnergy', cardId: ids[1], pokemonId: me });
  s = g.snapshot();
  assert.equal(s.pending.kind, 'coin-face'); assert.equal(s.pending.resume, 'use-coin'); assert.deepEqual(s.players[0].hand, [ids[1]]);
  assert.deepEqual(g.view(0).pending.coins, { flipper: 0, results: [] });
  for (const [mutate, message] of [
    [(x) => { x.pending.data.player = 1; }, /flip before a play/],
    [(x) => { x.pending.data.play.cardId = ids[0]; }, /flip before a play/],
    [(x) => { x.pending.data.play = { type: 'bench', cardId: ids[1] }; }, /flip before a play/],
    [(x) => { x.pending.data.play.type = 'evolve'; }, /Corrupt effect/],
  ]) {
    const bad = g.snapshot(); mutate(bad);
    assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }), message);
  }
  g = restore(g, f); answer(g, ['tails']);
  s = g.snapshot();
  assert.deepEqual(s.events.findLast((e) => e.ruleId === 'effects.coin-choice').data.face, 'tails');
  assert(s.players[0].discard.includes(ids[1])); assert(!s.playerOngoing.some((e) => e.effect.op === 'coinChoice'));
  // 「将对手抛掷的硬币的结果，全部视作反面」: tails, no RNG read.
  g = afterAttack(f, 'other:headache', (s) => { setHand(s, 0, ['water']); });
  const rng = g.snapshot().rng;
  command(g, { type: 'attachEnergy', cardId: card(g, 'water'), pokemonId: me });
  assert.deepEqual(coins(g, 'effects.attach-coin'), [['tails']]); assert.deepEqual(g.snapshot().rng, rng);
});

test('an effect attaching several cards from the hand: every recipient first, then one coin per card; 「然后」 needs one attached', async () => {
  const f = await make();
  let ids, side;
  const welding = (faces) => {
    const g = board(f, (s) => { room(s); side = bench(s, 0, 'base').id; ids = setHand(s, 0, ['welder', 'fire', 'fire', 'water']); s.rng = seedFor(faces); });
    play(g, 'welder');
    assert.equal(g.snapshot().pending.kind, 'hand-energy'); answer(g, [ids[1], ids[2]]);
    return g;
  };
  let g = welding(['heads', 'tails']);
  const me = g.snapshot().players[0].active.id;
  assert.equal(g.snapshot().pending.kind, 'energy-recipient'); answer(g, [me]);
  // The first card waits in the hand, chosen for the Active Pokémon (JP Q&A マホイップ × ヌメルゴン).
  let s = g.snapshot();
  assert.equal(s.pending.kind, 'energy-recipient'); assert(s.players[0].hand.includes(ids[1])); assert.deepEqual(coins(g, 'effects.attach-coin'), []);
  g = restore(g, f); answer(g, [side]);
  s = g.snapshot();
  const event = s.events.findLast((e) => e.ruleId === 'effects.attach-coin').data;
  assert.deepEqual([event.cards, event.targets, event.results, event.byEffect], [[ids[1], ids[2]], [me, side], ['heads', 'tails'], 'fixture:welder']);
  // Heads attached (its 「当附着能量时」 too), tails discarded; 「然后，从自己牌库上方抽取3张」 (JP Q&A 溶接工 × ヌメルゴン).
  assert.deepEqual(s.players[0].active.energy, [ids[1]]); assert.equal(s.players[0].active.counters, 1);
  assert.deepEqual(s.players[0].bench.find((m) => m.id === side).energy, []); assert(s.players[0].discard.includes(ids[2]));
  assert.equal(s.players[0].hand.length, 1 + 3); assert(s.players[0].hand.includes(ids[3]));
  // Both tails: nothing attached, no draw; the Supporter itself was played.
  g = welding(['tails', 'tails']); answer(g, [me]); answer(g, [me]);
  s = g.snapshot();
  assert.deepEqual(s.players[0].active.energy, []); assert.deepEqual(s.players[0].hand, [ids[3]]);
  assert.equal(s.players[0].flags.supporter, true); assert(s.players[0].discard.includes(ids[0]));
  assert.deepEqual(coins(g, 'effects.attach-coin'), [['tails', 'tails']]);
  // A chosen first coin pauses the coins; restored, the planned cards stay planned.
  g = board(f, (s) => { room(s); ids = setHand(s, 0, ['choice', 'welder', 'fire']); });
  play(g, 'choice'); play(g, 'welder'); answer(g, [ids[2]]); answer(g, [me]);
  s = g.snapshot();
  assert.equal(s.pending.kind, 'coin-face'); assert.deepEqual(s.pending.data.planned, [{ cardId: ids[2], pokemonId: me }]);
  assert.deepEqual(g.view(0).pending.coins, { flipper: 0, results: [] });
  for (const [mutate, message] of [
    [(x) => { x.pending.data.planned[0].cardId = ids[0]; }, /Planned attachments/],
    [(x) => { x.pending.data.planned[0].pokemonId = x.players[1].active.id; }, /Planned attachments/],
    [(x) => { delete x.pending.data.planned; }, /Corrupt effect/],
  ]) {
    const bad = g.snapshot(); mutate(bad);
    assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }), message);
  }
  g = restore(g, f); answer(g, ['heads']);
  assert.deepEqual(g.snapshot().players[0].active.energy, [ids[2]]);
});

test('an Ability attaching from the hand: tails, no draw and the Ability is used; 「对会被【昏厥】的宝可梦」 counts the planned cards', async () => {
  const f = await make((defs) => {
    item(defs, 'boost', [binding('cn.attachHand@1', { type: 'Water', count: 2, benchOnly: false, optional: false,
      recipientEffect: { counters: 2 }, spareKnockOut: true }, 'boost')]);
    def(defs, 'base').mechanics.effects = [];
  });
  f.deck.splice(36, 1, 'printing:boost');
  let ids;
  let g = board(f, (s) => { room(s); ids = setHand(s, 0, ['water', 'water']); s.rng = seedFor(['tails']); });
  const me = g.snapshot().players[0].active.id;
  command(g, { type: 'useAbility', pokemonId: me, abilityId: 'base:dance' }); answer(g, [ids[0]]);
  let s = g.snapshot();
  // JP Q&A オーガポン みどりのめんex／ネイティオ／ラティアス × ヌメルゴン.
  assert.deepEqual(s.players[0].active.energy, []); assert.deepEqual(s.players[0].hand, [ids[1]]); assert(s.players[0].discard.includes(ids[0]));
  assert(!g.view(0).legalActions.some((a) => a.type === 'useAbility'));
  // 「然后，在被附着的宝可梦身上放置2个伤害指示物。（对会被【昏厥】的宝可梦，…）」: the second card cannot go where both would Knock Out.
  let side;
  g = board(f, (s) => { room(s); side = bench(s, 0, 'base').id; s.players[0].active.counters = 6; ids = setHand(s, 0, ['boost', 'water', 'water']);
    s.rng = seedFor(['heads', 'heads']); });
  play(g, 'boost'); answer(g, [ids[1], ids[2]]);
  assert.deepEqual(g.snapshot().pending.options, [me, side]); answer(g, [me]);
  assert.deepEqual(g.snapshot().pending.options, [side]); answer(g, [side]);
  s = g.snapshot();
  assert.deepEqual([s.players[0].active.energy, s.players[0].active.counters], [[ids[1]], 8]);
  assert.deepEqual(s.players[0].bench.find((m) => m.id === side).counters, 2);
});

test('two such effects: each flips in turn, only for what is still there; a tails ends the play', async () => {
  const f = await make();
  let ids;
  // The Ability and 「在下一个对手的回合…」 on the same player: the turn's attachment flips twice.
  let g = afterAttack(f, 'other:slime', (s) => { ids = setHand(s, 0, ['water', 'welder', 'fire', 'fire']); s.rng = seedFor(['heads', 'tails']); });
  const me = g.snapshot().players[0].active.id;
  command(g, { type: 'attachEnergy', cardId: ids[0], pokemonId: me });
  let s = g.snapshot();
  const events = s.events.filter((e) => e.ruleId === 'effects.attach-coin');
  assert.deepEqual(events.map((e) => e.data.results), [['heads'], ['tails']]); assert.notEqual(events[0].data.effectId, events[1].data.effectId);
  assert(s.players[0].discard.includes(ids[0])); assert.equal(s.players[0].flags.energy, false);
  assert.equal(g.view(0).playerOngoing.find((e) => e.effect.op === 'useCoin').rule.ruleId, 'effects.use-coin');
  // Several cards: the second effect flips only for the cards the first left; none left, no coin.
  for (const [faces, results] of [[['heads', 'tails', 'tails'], [['heads', 'tails'], ['tails']]], [['tails', 'tails'], [['tails', 'tails']]]]) {
    g = afterAttack(f, 'other:slime', (s) => { ids = setHand(s, 0, ['welder', 'fire', 'fire', 'water']); s.rng = seedFor(faces); });
    play(g, 'welder'); answer(g, [ids[1], ids[2]]); answer(g, [me]); answer(g, [me]);
    s = g.snapshot();
    assert.deepEqual(coins(g, 'effects.attach-coin'), results); assert.deepEqual(s.players[0].active.energy, []);
    assert(s.players[0].hand.includes(ids[3])); assert(ids.slice(1, 3).every((id) => s.players[0].discard.includes(id)));
  }
});

test('「每当对手从手牌使出训练家时，在使用前抛掷1次硬币。如果为反面，则那张卡牌不视作被使用过」: Items and Supporters', async () => {
  const f = await make();
  let ids;
  let g = afterAttack(f, 'other:quake', (s) => {
    ids = setHand(s, 0, ['potion', 'research', 'research', 'water']); s.players[0].active.counters = 3; s.rng = seedFor(['tails', 'tails', 'heads']);
  });
  const opened = (g) => g.snapshot().events.filter((e) => e.ruleId === 'turn.trainer' && e.data.kind === 'trainer-open').length;
  command(g, { type: 'playTrainer', cardId: ids[0] });
  let s = g.snapshot();
  assert.equal(s.players[0].active.counters, 3); assert(s.players[0].discard.includes(ids[0])); assert.equal(opened(g), 0);
  const event = s.events.findLast((e) => e.ruleId === 'effects.trainer-coin');
  assert.deepEqual([event.data.cards, event.data.results, event.data.revealed[0].definitionId, event.data.targets],
    [[ids[0]], ['tails'], 'potion', undefined]);
  assert(g.view(1).events.some((e) => e.ruleId === 'effects.trainer-coin'));
  // A Supporter: not played (JP Q&A ガマゲロゲ × ガイ／タラゴン), so another may be played, flipping again.
  g = restore(g, f); command(g, { type: 'playTrainer', cardId: ids[1] });
  s = g.snapshot();
  assert.equal(s.players[0].flags.supporter, false); assert(!s.battleHistory.events.some((e) => e.kind === 'supporterPlayed'));
  assert(g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === ids[2]));
  command(g, { type: 'playTrainer', cardId: ids[2] }); settle(g);
  s = g.snapshot();
  assert.equal(s.players[0].flags.supporter, true); assert.equal(s.battleHistory.events.filter((e) => e.kind === 'supporterPlayed').length, 1);
  assert.deepEqual(coins(g, 'effects.trainer-coin'), [['tails'], ['tails'], ['heads']]);
  assert.equal(s.players[0].hand.length, 1 + 1 + 2); assert.equal(opened(g), 1);
  // A paid Item: the coin before its cost (JP Q&A ガマゲロゲ × ハイパーボール).
  for (const face of ['tails', 'heads']) {
    g = afterAttack(f, 'other:quake', (s) => { ids = setHand(s, 0, ['ball', 'water', 'water']); s.rng = seedFor([face]); });
    command(g, { type: 'playTrainer', cardId: ids[0] });
    s = g.snapshot();
    if (face === 'tails') { assert.equal(s.pending, null); assert(ids.slice(1).every((id) => s.players[0].hand.includes(id))); } else {
      assert.equal(s.pending.kind, 'activation-cost'); pay(g, [ids[1], ids[2]]); settle(g);
      assert.equal(g.snapshot().players[0].hand.length, 1 + 1);
    }
  }
  // 一树 played under it (its own coin first): the next Trainer's coin is the one chosen.
  g = afterAttack(f, 'other:quake', (s) => { ids = setHand(s, 0, ['choice', 'potion']); s.players[0].active.counters = 3; s.rng = seedFor(['heads']); });
  command(g, { type: 'playTrainer', cardId: ids[0] });
  assert(g.snapshot().playerOngoing.some((e) => e.effect.op === 'coinChoice'));
  command(g, { type: 'playTrainer', cardId: ids[1] });
  assert.equal(g.snapshot().pending.kind, 'coin-face'); assert.deepEqual(g.snapshot().pending.data.play, { type: 'playTrainer', cardId: ids[1] });
  g = restore(g, f); answer(g, ['heads']); settle(g);
  assert.equal(g.snapshot().players[0].active.counters, 0);
});

test('Stadiums, Tools, cards played together and an Item-card Pokémon: one coin each use, before anything of it', async () => {
  const f = await make();
  let ids, theirs;
  // A Stadium: tails, the one in play stays and another (the same name too) may be played (JP Q&A ガマゲロゲ × ミアレシティ／プリズムタワー).
  let g = afterAttack(f, 'other:quake', (s) => {
    ids = setHand(s, 0, ['arena', 'arena']); theirs = hand(s, 1, 'stadium'); s.players[1].hand.pop(); s.stadium = theirs; s.rng = seedFor(['tails', 'heads']);
  });
  command(g, { type: 'playTrainer', cardId: ids[0] });
  let s = g.snapshot();
  assert.equal(s.stadium, theirs); assert(s.players[0].discard.includes(ids[0])); assert.equal(s.players[0].flags.stadium, false);
  command(g, { type: 'playTrainer', cardId: ids[1] }); settle(g);
  s = g.snapshot();
  assert.equal(s.stadium, ids[1]); assert(s.players[1].discard.includes(theirs));
  // A Tool: tails, no Pokémon is chosen for it; heads, it is.
  for (const face of ['tails', 'heads']) {
    g = afterAttack(f, 'other:quake', (s) => { ids = setHand(s, 0, ['tool']); s.rng = seedFor([face]); });
    command(g, { type: 'playTrainer', cardId: ids[0] });
    s = g.snapshot();
    if (face === 'tails') { assert.equal(s.pending, null); assert(s.players[0].discard.includes(ids[0])); } else assert.equal(s.pending.kind, 'tool-target');
  }
  // 「同时使用2张」: one coin; tails, both go to the discard pile (JP Q&A ガマゲロゲ × 変化の書).
  for (const face of ['tails', 'heads']) {
    g = afterAttack(f, 'other:quake', (s) => { ids = setHand(s, 0, ['pair', 'pair']); s.rng = seedFor([face]); });
    const joint = g.view(0).legalActions.find((a) => a.type === 'playTrainer' && a.jointCardIds), before = g.snapshot().players[0].hand.length;
    command(g, joint); settle(g);
    s = g.snapshot();
    const event = s.events.findLast((e) => e.ruleId === 'effects.trainer-coin').data;
    assert.deepEqual([event.cards, event.results], [[joint.cardId, ...joint.jointCardIds], [face]]);
    assert(ids.every((id) => s.players[0].discard.includes(id)));
    assert.equal(s.players[0].hand.length, before - 2 + (face === 'heads' ? 2 : 0));
  }
  // An Item-card Pokémon put onto the Bench is an Item used (pokemon.item-card).
  for (const face of ['tails', 'heads']) {
    g = afterAttack(f, 'other:quake', (s) => { ids = setHand(s, 0, ['fossil']); s.rng = seedFor([face]); });
    command(g, { type: 'bench', cardId: ids[0] });
    s = g.snapshot();
    assert.equal(s.players[0].bench.some((m) => m.stack.includes(ids[0])), face === 'heads');
    assert.equal(s.players[0].discard.includes(ids[0]), face === 'tails');
    assert.deepEqual(coins(g, 'effects.trainer-coin'), [[face]]);
  }
  // A Basic Pokémon is no Trainer: no coin.
  g = afterAttack(f, 'other:quake', (s) => { ids = setHand(s, 0, ['base']); });
  command(g, { type: 'bench', cardId: ids[0] });
  assert(g.snapshot().players[0].bench.some((m) => m.stack.includes(ids[0]))); assert.deepEqual(coins(g, 'effects.trainer-coin'), []);
});
