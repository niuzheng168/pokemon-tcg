// Synthetic definitions only. Ability and Trainer use costs, hand-zone Abilities and opponent-involving choices:
// 「在自己的回合，如果将自己的1张手牌放回牌库下方的话，则可使用1次。从牌库上方抽取卡牌，直到自己的手牌变为5张为止。」;
// 「在自己的回合，如果将这只宝可梦身上附着的1个「基本【雷】能量」放于弃牌区的话，则可以使用1次。从牌库上方抽取卡牌，直到自己的手牌变为6张为止。」
// (effects.activation-cost, II.E-30). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, assertSupportedDefinition } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { assertActivationCosts, paymentOptionId } from '../../public/rules/activation-cost.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, attached, bench } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers(), catalog = { handler: (id) => handlers.get(id) };
const cost = (kind, count = 1, selector = { kind: 'any' }, costId = 'fee') => ({ costId, kind, count, selector, sourceOfTruth: EVIDENCE });
const ability = (effects, costs, extra = {}) => ({ abilityId: 'paid', name: '测试使用条件', mode: 'activated',
  usage: { period: 'turn', scope: 'pokemon', key: 'paid', limit: 1 }, costs, effects, sourceOfTruth: EVIDENCE, ...extra });
const use = (g) => command(g, { type: 'useAbility', abilityId: 'paid', pokemonId: g.snapshot().players[0].active.id });
const usable = (g) => g.view(0).legalActions.some((a) => a.abilityId === 'paid');
// The hand holds exactly these cards (the rest of the old hand goes to the discard pile).
const setHand = (s, owner, ids) => {
  const p = s.players[owner]; p.discard.push(...p.hand.splice(0));
  return ids.map((id) => hand(s, owner, id));
};
const BASIC_WATER = { kind: 'energy', category: 'basic', types: ['Water'] };

test('「如果将自己的1张手牌放回牌库下方的话，则可使用1次。…直到自己的手牌变为5张为止」: paid to the deck bottom first', async () => {
  const f = await fixture((defs) => { defs[0].mechanics.abilities = [ability([binding('cn.drawUntil@1', { count: 5 })], [cost('bottomHand')])]; });
  let ids;
  let g = board(f, (s) => { ids = setHand(s, 0, ['water', 'potion', 'other', 'water', 'tool']); });
  assert(usable(g));
  use(g);
  const q = g.view(0).pending;
  assert.equal(q.kind, 'activation-cost'); assert.equal(q.payment.groups[0].kind, 'bottomHand');
  assert.deepEqual(q.payment.groups[0].choices.map((c) => c.card.instanceId), ids);
  g = restore(g, f);
  answer(g, [paymentOptionId('fee', ids[1])]); settle(g);
  const p = g.snapshot().players[0];
  assert.equal(p.hand.length, 5, 'Four after paying, then one drawn.');
  assert(!p.hand.includes(ids[1]) || p.deck.length === 0);
  assert.equal(g.snapshot().events.find((e) => e.ruleId === 'effects.activation-cost').data.payment.groups[0].cardIds[0], ids[1]);
  // Six in hand: five after paying, nothing to draw.
  const full = board(f, (s) => { setHand(s, 0, ['water', 'water', 'water', 'water', 'water', 'water']); });
  assert(!usable(full));
  // An empty deck: the paid card is the deck, and it is drawn again.
  let only;
  const empty = board(f, (s) => { [only] = setHand(s, 0, ['potion']); s.players[0].discard.push(...s.players[0].deck.splice(0)); });
  assert(usable(empty));
  use(empty); answer(empty, [paymentOptionId('fee', only)]); settle(empty);
  assert.deepEqual(empty.snapshot().players[0].hand, [only]); assert.equal(empty.snapshot().players[0].deck.length, 0);
});

test('「放回牌库下方」 costs of several cards: the last chosen lowest; other effects cannot prove such a cost', async () => {
  const f = await fixture((defs) => { defs[0].mechanics.abilities = [ability([binding('cn.draw@1', { count: 1 })], [cost('bottomHand', 2)])]; });
  let ids;
  const g = board(f, (s) => { ids = setHand(s, 0, ['water', 'potion', 'other']); });
  const deck = g.snapshot().players[0].deck.length;
  use(g); answer(g, [paymentOptionId('fee', ids[0]), paymentOptionId('fee', ids[1])]);
  const p = g.snapshot().players[0];
  assert.deepEqual(p.deck.slice(0, 2), [ids[1], ids[0]]); assert.equal(p.deck.length, deck + 2 - 1);
  // The draw counts the paid cards: an empty deck still draws.
  let two;
  const empty = board(f, (s) => { two = setHand(s, 0, ['water', 'tool']); s.players[0].discard.push(...s.players[0].deck.splice(0)); });
  assert(usable(empty)); use(empty); answer(empty, two.map((id) => paymentOptionId('fee', id))); settle(empty);
  assert.deepEqual(empty.snapshot().players[0].hand, [two[0]]);
  const healing = clone(f.definitions[0]);
  healing.mechanics.abilities = [ability([binding('cn.heal@1', { target: 'any', amount: 30 })], [cost('bottomHand')])];
  assert.throws(() => assertSupportedDefinition(catalog, healing), (e) => e.code === 'unsupported-cost-check');
  healing.mechanics.abilities[0].costs = [cost('discardHand')];
  assertSupportedDefinition(catalog, healing);
});

test('「如果将这只宝可梦身上附着的1个「基本【雷】能量」放于弃牌区的话，则可以使用1次。…直到自己的手牌变为6张为止」', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.abilities = [ability([binding('cn.drawUntil@1', { count: 6 })], [cost('discardAttached', 1, BASIC_WATER)])];
  });
  let water, fire, cards;
  let g = board(f, (s) => {
    const m = s.players[0].active; fire = attached(s, 0, m, 'double'); water = attached(s, 0, m, 'water');
    cards = setHand(s, 0, ['potion', 'water', 'water', 'water', 'water']);
  });
  assert(usable(g));
  use(g);
  const q = g.view(0).pending;
  assert.equal(q.payment.groups[0].kind, 'discardAttached');
  assert.deepEqual(q.payment.groups[0].choices.map((c) => c.card.instanceId), [water], 'Only its own attached Basic Energy of that type.');
  assert.throws(() => answer(g, [paymentOptionId('fee', cards[1])]), /Invalid selection/);
  g = restore(g, f); answer(g, [paymentOptionId('fee', water)]); settle(g);
  const p = g.snapshot().players[0];
  assert.deepEqual(p.active.energy, [fire]); assert(p.discard.includes(water));
  assert.equal(p.hand.length, 6, 'The hand keeps its five cards; one is drawn.');
  for (const setup of [
    (s) => { attached(s, 0, s.players[0].active, 'double'); setHand(s, 0, ['potion']); },
    (s) => { attached(s, 0, s.players[0].active, 'water'); setHand(s, 0, ['water', 'water', 'water', 'water', 'water', 'water']); },
    (s) => { setHand(s, 0, []); attached(s, 1, s.players[1].active, 'water'); },
  ]) assert(!usable(board(f, setup)));
});

test('attached-card costs: only an in-play Pokémon\'s activated Ability, never with hand costs', async () => {
  assert.throws(() => assertActivationCosts([cost('discardAttached', 1, BASIC_WATER), cost('discardHand', 1, { kind: 'any' }, 'b')]),
    /Attached-card costs/);
  const reject = (transform) => assert.rejects(fixture(transform), /in-play Pokémon/);
  await reject((defs) => { def(defs, 'potion').mechanics.playCosts = [cost('discardAttached', 1, BASIC_WATER)]; });
  await reject((defs) => { def(defs, 'research').mechanics.discardRecall = { costs: [cost('discardAttached', 1, BASIC_WATER)] }; });
  await reject((defs) => {
    defs[0].mechanics.abilities = [ability([binding('cn.draw@1', { count: 1 })], [cost('discardAttached', 1, BASIC_WATER)], {
      mode: 'triggered', usage: null, trigger: { event: 'bench', subject: 'self', optional: true, choiceOwner: 'source', scope: 'global', origin: 'hand', turn: 'own' } })];
  });
});

// 「如果这张卡牌在手牌中的话，则在自己的回合可以使用1次。将这张卡牌放回牌库下方。然后，从自己牌库上方抽取1张卡牌。在这个回合，如果已经使用了其他的
// 「拳海参投掷」的话，则无法使用这个特性。」 and 「如果这张卡牌在手牌的话，在自己的回合可以使用1次，如果使用了的话，则将这张卡牌放于放逐区。查看对手牌库
// 上方1张卡牌，再放回原处。如果那张卡牌是支援者的话，若希望，则可将其放于放逐区。」 (ability.zone).
const leaf = (handlerId, parameters) => ({ handlerId, parameters });
const zoneAbility = (effects, usage) => ({ abilityId: 'other:throw', name: '测试投掷', mode: 'activated', zone: 'hand', usage, effects, sourceOfTruth: EVIDENCE });
const cardUses = (g, cardId) => g.view(0).legalActions.filter((a) => a.type === 'useAbility' && a.cardId === cardId);
const throwCard = (g, cardId) => command(g, { type: 'useAbility', cardId, abilityId: 'other:throw' });
const onTop = (s, owner, id) => { const card = hand(s, owner, id); s.players[owner].hand.pop(); s.players[owner].deck.push(card); return card; };

test('「将这张卡牌放回牌库下方。然后，从自己牌库上方抽取1张卡牌」 from the hand, once per turn for the player', async () => {
  const valid = handlers.get('cn.deploySelf@1').validateParameters;
  assert(valid({ to: 'lost' })); assert(valid({ to: 'deckBottom', next: leaf('cn.draw@1', { count: 1 }) }));
  assert(!valid({ to: 'bench' })); assert(!valid({ to: 'deckBottom', next: leaf('cn.counters@1', { side: 'own', target: 'self', count: 3 }) }));
  assert(valid({ next: leaf('cn.counters@1', { side: 'own', target: 'self', count: 3 }) }));
  const shared = { period: 'turn', scope: 'player', key: 'cn:ability:throw', limit: 1 };
  const f = await fixture((defs) => {
    def(defs, 'other').mechanics.abilities = [zoneAbility([binding('cn.deploySelf@1', { to: 'deckBottom', next: leaf('cn.draw@1', { count: 1 }) }, 'throw')], shared)];
  });
  let a, b;
  let g = board(f, (s) => { [a, b] = setHand(s, 0, ['other', 'other', 'water']); });
  const top = g.snapshot().players[0].deck.at(-1);
  assert.equal(cardUses(g, a).length, 1);
  throwCard(g, a); settle(g);
  const p = g.snapshot().players[0];
  assert.equal(p.deck[0], a); assert(p.hand.includes(top)); assert.equal(p.hand.length, 3);
  assert(g.snapshot().events.some((e) => e.ruleId === 'ability.zone' && e.data.to === 'deckBottom' && e.data.cardId === a));
  g = restore(g, f);
  assert.deepEqual(cardUses(g, b), [], 'Another 「拳海参投掷」 was used this turn.');
  // An empty deck: this card is the deck, and it is drawn again.
  let only;
  const empty = board(f, (s) => { [only] = setHand(s, 0, ['other']); s.players[0].discard.push(...s.players[0].deck.splice(0)); });
  throwCard(empty, only); settle(empty);
  assert.deepEqual(empty.snapshot().players[0].hand, [only]);
});

test('「将这张卡牌放于放逐区。查看对手牌库上方1张卡牌，再放回原处。如果那张卡牌是支援者的话，若希望，则可将其放于放逐区」', async () => {
  const peek = { from: 'deck', to: 'lost', side: 'opponent', selector: { kind: 'trainer', categories: ['supporter'] },
    quantity: { kind: 'upTo', count: 1 }, reveal: false, lookTop: 1, shuffleAfter: false };
  const once = { period: 'turn', scope: 'pokemon', key: 'cn:ability:mountain', limit: 1 };
  const f = await fixture((defs) => {
    def(defs, 'other').mechanics.abilities = [zoneAbility([binding('cn.deploySelf@1', { to: 'lost' }, 'leave'),
      binding('cn.deploySelf@1', { to: 'lost' }, 'again'), binding('cn.cards@1', peek, 'peek')], once)];
  });
  for (const take of [true, false]) {
    let card, supporter;
    let g = board(f, (s) => { [card] = setHand(s, 0, ['other']); supporter = onTop(s, 1, 'research'); });
    throwCard(g, card);
    const q = g.snapshot().pending;
    assert.equal(q.kind, 'select-cards'); assert.equal(q.player, 0); assert.deepEqual(q.options, [supporter]); assert.equal(q.minimum, 0);
    assert.deepEqual(g.snapshot().players[0].lost, [card], 'Into the Lost Zone first; the second move finds nothing.');
    g = restore(g, f); answer(g, take ? [supporter] : []); settle(g);
    const foe = g.snapshot().players[1];
    assert.equal(foe.lost.includes(supporter), take); assert.equal(foe.deck.at(-1) === supporter, !take);
  }
  let card, water;
  const g = board(f, (s) => { [card] = setHand(s, 0, ['other']); water = onTop(s, 1, 'water'); });
  throwCard(g, card);
  assert.equal(g.snapshot().pending.kind, 'view-cards'); settle(g);
  assert.equal(g.snapshot().players[1].deck.at(-1), water);
});

// 「这张卡牌，只有将自己手牌中的1张物品放于弃牌区后才可使用。抛掷1次硬币如果为正面，则选择自己牌库中任意1张卡牌，加入手牌。并重洗牌库。」
test('「只有将自己手牌中的1张物品放于弃牌区后才可使用。抛掷1次硬币如果为正面，则选择自己牌库中任意1张卡牌，加入手牌」', async () => {
  const search = { from: 'deck', to: 'hand', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 1 }, reveal: false, lookTop: null, shuffleAfter: true };
  const flip = { outcome: 'heads', effect: leaf('cn.cards@1', search) };
  const valid = handlers.get('cn.coin@1');
  assert(valid.costCheckApplies(flip)); assert(!valid.costCheckApplies({ outcome: 'heads', effect: leaf('cn.discardDeckTop@1', { side: 'own', count: 1 }) }));
  const f = await fixture((defs) => {
    const d = def(defs, 'potion');
    d.mechanics.playCosts = [cost('discardHand', 1, { kind: 'trainer', categories: ['item'] }, 'item')];
    d.mechanics.effects = [binding('cn.coin@1', flip, 'flip')];
  });
  const faces = new Set();
  for (const seed of [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16]]) {
    let card, item;
    let g = board({ ...f, seed }, (s) => { [card, item] = setHand(s, 0, ['potion', 'poison', 'water']); });
    command(g, { type: 'playTrainer', cardId: card });
    assert.deepEqual(g.snapshot().pending.options, [paymentOptionId('item', item)]);
    g = restore(g, f); answer(g, [paymentOptionId('item', item)]);
    const coin = g.snapshot().events.find((e) => e.ruleId === 'effects.coin');
    faces.add(coin.data.result);
    const before = g.snapshot().players[0].hand.length;
    settle(g);
    assert(g.snapshot().players[0].discard.includes(item));
    assert.equal(g.snapshot().players[0].hand.length, before + (coin.data.result === 'heads' ? 1 : 0));
  }
  assert.equal(faces.size, 2);
  const playable = (setup) => {
    const g = board(f, setup);
    return g.view(0).legalActions.some((a) => a.type === 'playTrainer' && g.snapshot().cards[a.cardId].definitionId === 'potion');
  };
  assert(!playable((s) => { setHand(s, 0, ['potion', 'water']); }), 'No Item to pay.');
  assert(!playable((s) => { setHand(s, 0, ['potion', 'poison']); s.players[0].discard.push(...s.players[0].deck.splice(0)); }), 'Nothing to search.');
});

// 「在不看正面的前提下选择对手1张手牌，查看其正面。如果该卡牌是支援者的话，则放于弃牌区。如果不是支援者的话，则放回手牌。」
test('「在不看正面的前提下选择对手1张手牌，查看其正面。如果该卡牌是支援者的话，则放于弃牌区。如果不是…则放回手牌」', async () => {
  const spray = { mode: 'faceDown', selector: { kind: 'trainer', categories: ['supporter'] }, quantity: { kind: 'exact', count: 1 }, to: 'discard' };
  const valid = handlers.get('cn.opponentHand@1').validateParameters;
  assert(valid(spray)); assert(!valid({ ...spray, quantity: { kind: 'upTo', count: 1 } }));
  const f = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.opponentHand@1', spray, 'spray')]; });
  const seen = new Set();
  for (const seed of [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]]) {
    let card, supporter, water;
    const g = board({ ...f, seed }, (s) => { [card] = setHand(s, 0, ['potion']); [supporter, water] = setHand(s, 1, ['research', 'water']); });
    command(g, { type: 'playTrainer', cardId: card }); settle(g);
    const s = g.snapshot(), [picked] = s.events.find((e) => e.ruleId === 'effects.opponent-hand' && e.data.picked).data.picked;
    seen.add(s.cards[picked].definitionId);
    assert.deepEqual(s.players[1].hand, picked === supporter ? [water] : [supporter, water]);
    assert.equal(s.players[1].discard.includes(supporter), picked === supporter);
  }
  assert.equal(seen.size, 2);
  const g = board(f, (s) => { setHand(s, 0, ['potion']); setHand(s, 1, []); });
  assert(!g.view(0).legalActions.some((a) => a.type === 'playTrainer'), 'An empty hand: nothing to pick.');
});

// 「从自己的牌库上方抽取4张卡牌。在使用了这张卡牌的回合结束时，如果自己的手牌数量为3张以上（包含3张）的话，则将手牌放回牌库，直到手牌剩余2张为止并重洗牌库。」
test('「在使用了这张卡牌的回合结束时，如果自己的手牌数量为3张以上…则将手牌放回牌库，直到手牌剩余2张为止并重洗牌库」', async () => {
  const back = { from: 'hand', to: 'deck', selector: { kind: 'any' }, quantity: { kind: 'leave', count: 2 }, reveal: false, lookTop: null, shuffleAfter: true };
  const plan = { effect: leaf('cn.cards@1', back),
    condition: { kind: 'compare', left: { kind: 'zoneCount', side: 'own', zone: 'hand' }, relation: 'gte', right: { kind: 'literal', value: 3 } } };
  const valid = handlers.get('cn.turnEndEffect@1').validateParameters;
  assert(valid(plan)); assert(!valid({ effect: leaf('cn.cards@1', { ...back, quantity: { kind: 'exact', count: 2 } }) }));
  assert(!valid({ effect: leaf('cn.cards@1', { ...back, shuffleAfter: false }) }));
  const f = await fixture((defs) => {
    def(defs, 'research').mechanics.effects = [binding('cn.draw@1', { count: 4 }, 'draw'), binding('cn.turnEndEffect@1', plan, 'tidy')];
  });
  let card, kept;
  let g = board(f, (s) => { [card, ...kept] = setHand(s, 0, ['research', 'water', 'potion']); });
  command(g, { type: 'playTrainer', cardId: card }); settle(g);
  assert.equal(g.snapshot().players[0].hand.length, 6);
  const deck = g.snapshot().players[0].deck.length;
  command(g, { type: 'endTurn' });
  const q = g.snapshot().pending;
  assert.equal(q.kind, 'select-cards'); assert.equal(q.player, 0); assert.equal(q.minimum, 4); assert.equal(q.maximum, 4);
  g = restore(g, f);
  answer(g, q.options.filter((id) => !kept.includes(id))); settle(g);
  const s = g.snapshot();
  assert.deepEqual(s.players[0].hand.sort(), [...kept].sort()); assert.equal(s.players[0].deck.length, deck + 4);
  assert(s.events.some((e) => e.ruleId === 'effects.shuffle' && e.data.player === 0 && e.data.zone === 'deck'));
  // Two or fewer at the end of the turn: nothing goes back.
  const only = await fixture((defs) => { def(defs, 'research').mechanics.effects = [binding('cn.turnEndEffect@1', plan, 'tidy')]; });
  const h = board(only, (s) => { [card] = setHand(s, 0, ['research', 'water', 'potion']); });
  command(h, { type: 'playTrainer', cardId: card }); settle(h);
  command(h, { type: 'endTurn' });
  assert.notEqual(h.snapshot().pending?.kind, 'select-cards');
  settle(h);
  assert.equal(h.snapshot().players[0].hand.length, 2);
});

// 「当身上放有这张卡牌的宝可梦在HP为全满状态下，受到对手宝可梦的招式的伤害而【昏厥】时，那只宝可梦不会【昏厥】，而是以剩余HP为「10」的状态留在场上。
// 然后，将这张卡牌放于弃牌区。」 (damage.survive).
test('「HP为全满状态下，受到对手宝可梦的招式的伤害而【昏厥】时…以剩余HP为「10」的状态留在场上。然后，将这张卡牌放于弃牌区」', async () => {
  const brace = { op: 'koSurvive', scope: 'self', fullHp: true, from: 'opponent', discardCard: true };
  assert(handlers.get('cn.koSurvive@1').validateParameters({ effect: brace }));
  const big = (defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.weakness = null;
    def(defs, 'base').mechanics.attacks[0].printedDamage = { value: 120, operator: 'fixed' };
    def(defs, 'tool').mechanics.effects = [binding('cn.koSurvive@1', { effect: brace }, 'brace')];
  };
  const f = await fixture(big);
  const holding = (s, owner) => { const t = hand(s, owner, 'tool'); s.players[owner].hand.pop(); s.players[owner].active.tools.push(t); return t; };
  let tool;
  let g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); tool = holding(s, 1); });
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  let s = g.snapshot();
  assert.equal(s.players[1].active.counters, 9); assert.deepEqual(s.players[1].active.tools, []); assert(s.players[1].discard.includes(tool));
  assert(s.events.some((e) => e.ruleId === 'damage.survive' && e.data.discarded && e.data.cardId === tool));
  assert.deepEqual(restore(g, f).snapshot(), s);
  // Not at full HP: Knocked Out (the Tool goes with it).
  g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); tool = holding(s, 1); s.players[1].active.counters = 1; bench(s, 1, 'other'); });
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  assert(!g.snapshot().events.some((e) => e.ruleId === 'damage.survive'));
  // Its holder's own attack (recoil) is not the opponent's.
  const recoil = await fixture((defs) => {
    big(defs);
    def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.recoilDamage@1', { side: 'own', target: 'self', amount: 120, selection: { kind: 'all' }, options: {} }, 'recoil')];
  });
  g = board(recoil, (s) => { attached(s, 0, s.players[0].active, 'water'); holding(s, 0); bench(s, 0, 'other'); s.players[1].active.counters = 0; });
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  s = g.snapshot();
  assert(!s.events.some((e) => e.ruleId === 'damage.survive'), 'The holder\'s own attack is not the opponent\'s.');
  const any = await fixture((defs) => {
    big(defs); const { from: _from, ...all } = brace;
    def(defs, 'tool').mechanics.effects = [binding('cn.koSurvive@1', { effect: all }, 'brace')];
    def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.recoilDamage@1', { side: 'own', target: 'self', amount: 120, selection: { kind: 'all' }, options: {} }, 'recoil')];
  });
  g = board(any, (s) => { attached(s, 0, s.players[0].active, 'water'); holding(s, 0); bench(s, 0, 'other'); });
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  assert.equal(g.snapshot().players[0].active.counters, 9, 'Without 「对手宝可梦的」 its own recoil is survived too.');
  // With another survival effect the holder would choose the order (JP Q&A); not offered during damage.
  const both = await fixture((defs) => {
    big(defs);
    def(defs, 'base').mechanics.effects.push(binding('cn.koSurvive@1', { effect: { op: 'koSurvive', scope: 'self', coin: true } }, 'sturdy'));
  });
  g = board(both, (s) => { attached(s, 0, s.players[0].active, 'water'); holding(s, 1); });
  assert.throws(() => { command(g, { type: 'attack', attackId: 'base:strike' }); settle(g); }, /unresolved-survive-order|orders a self-discarding/);
  // Only a Tool's own survival discards it.
  const loose = clone(f.definitions[0]);
  loose.mechanics.effects = [binding('cn.koSurvive@1', { effect: brace }, 'brace')];
  assert.throws(() => assertSupportedDefinition(catalog, loose), /Only a Tool discards itself/);
});

// 「如果双方的战斗宝可梦在【撤退】时，放于弃牌区的能量是基本能量的话，则不将该能量放于弃牌区，而是放回自己的手牌。」 (retreat.rules).
test('Stadium 「双方的战斗宝可梦在【撤退】时，放于弃牌区的能量是基本能量的话…放回自己的手牌」', async () => {
  const park = { op: 'retreatRule', scope: 'all', energyToHand: true, energySelector: { kind: 'energy', category: 'basic' } };
  const valid = handlers.get('cn.retreatRule@1').validateParameters;
  assert(valid({ effect: park })); assert(!valid({ effect: { op: 'retreatRule', scope: 'all', energySelector: park.energySelector, ignoreConditions: true } }));
  const f = await fixture((defs) => { def(defs, 'stadium').mechanics.effects = [binding('cn.retreatRule@1', { effect: park }, 'park')]; });
  for (const [owner, id] of [[0, 'water'], [0, 'double'], [1, 'water']]) {
    let energy;
    const g = board(f, (s) => {
      s.stadium = hand(s, 0, 'stadium'); s.players[0].hand.pop();
      energy = attached(s, owner, s.players[owner].active, id); bench(s, owner, 'other');
    });
    if (owner === 1) { command(g, { type: 'endTurn' }); settle(g); }
    command(g, { type: 'retreat' }); settle(g);
    const s = g.snapshot(), p = s.players[owner];
    assert.equal(p.hand.includes(energy), id === 'water'); assert.equal(p.discard.includes(energy), id !== 'water');
    assert.equal(s.events.some((e) => e.ruleId === 'retreat.rules'), id === 'water');
  }
  // A Stadium's rule is about both players' Pokémon; a Tool's about its holder.
  for (const [card, scope] of [['stadium', 'self'], ['tool', 'all']]) {
    const wrong = clone(f.definitions.find((d) => d.definitionId === card));
    wrong.mechanics.effects = [binding('cn.retreatRule@1', { effect: { ...park, scope } }, 'park')];
    assert.throws(() => assertSupportedDefinition(catalog, wrong), /retreat rule/);
  }
});

// 「将自己牌库上方5张卡牌翻成正面，让对手选择其中2张卡牌。自己将被选择的卡牌放于弃牌区，将剩余的卡牌加入手牌。」 (effects.reveal).
test('「将自己牌库上方5张卡牌翻成正面，让对手选择其中2张卡牌。自己将被选择的卡牌放于弃牌区，将剩余的卡牌加入手牌」', async () => {
  const cards = { from: 'deck', to: 'discard', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 2 }, reveal: true, lookTop: 5,
    shuffleAfter: false, remainder: 'hand', chooser: 'opponent' };
  const valid = handlers.get('cn.cards@1').validateParameters;
  const { remainder: _rest, ...plain } = cards;
  assert(valid(cards)); assert(valid(plain)); assert(!valid({ ...cards, reveal: false })); assert(!valid({ ...plain, side: 'opponent' }));
  assert(!valid({ ...plain, from: 'discard', lookTop: null, to: 'hand' }));
  const f = await fixture((defs) => { def(defs, 'research').mechanics.effects = [binding('cn.cards@1', cards, 'ask')]; });
  for (const size of [8, 3]) {
    let card;
    let g = board(f, (s) => { [card] = setHand(s, 0, ['research']); s.players[0].discard.push(...s.players[0].deck.splice(0, s.players[0].deck.length - size)); });
    const top = g.snapshot().players[0].deck.slice(-5);
    command(g, { type: 'playTrainer', cardId: card });
    const q = g.snapshot().pending;
    assert.equal(q.player, 1); assert.equal(q.minimum, 2); assert.equal(q.maximum, 2); assert.deepEqual([...q.options].sort(), [...top].sort());
    assert.deepEqual(g.view(1).pending.lookedAt.map((c) => c.instanceId).sort(), [...top].sort(), 'The opponent sees the face-up cards.');
    assert(g.snapshot().events.some((e) => e.ruleId === 'effects.reveal' && e.data.cardIds.length === top.length));
    g = restore(g, f);
    const chosen = q.options.slice(0, 2);
    answer(g, chosen); settle(g);
    const p = g.snapshot().players[0];
    assert(chosen.every((id) => p.discard.includes(id)));
    assert.deepEqual(p.hand.filter((id) => top.includes(id)).sort(), top.filter((id) => !chosen.includes(id)).sort());
  }
});

// 「身上放有这张卡牌的「太晶」宝可梦使用招式时，使用那个招式所需能量，减少1个。（减少的可以是任意属性的能量。）」 (energy.requirement.reduce-any).
test('「…「太晶」宝可梦使用招式时，使用那个招式所需能量，减少1个。（减少的可以是任意属性的能量。）」', async () => {
  const crystal = { op: 'energyRequirement', action: 'attack', mode: 'reduceAny', scope: 'self', count: 1,
    targetSelector: { kind: 'pokemon', tagsAll: ['Tera'] } };
  const valid = handlers.get('cn.energyRequirement@1').validateParameters;
  assert(valid({ effect: crystal })); assert(!valid({ effect: { ...crystal, action: 'retreat' } }));
  assert(!valid({ effect: { ...crystal, energyType: 'Water' } })); assert(!valid({ effect: { ...crystal, mode: 'adjust', amount: -1, energyType: 'Water' } }));
  const { count: _count, ...noCount } = crystal; assert(!valid({ effect: noCount }));
  const build = (cost, extra = () => {}) => fixture((defs) => {
    const base = def(defs, 'base'); base.mechanics.tags = ['Tera']; base.mechanics.attacks[0].cost = cost;
    def(defs, 'tool').mechanics.effects = [binding('cn.energyRequirement@1', { effect: crystal }, 'crystal')];
    extra(defs);
  });
  const ready = (f, energies, tool = true, tera = true) => {
    const g = board(f, (s) => {
      const m = s.players[0].active;
      for (const id of energies) attached(s, 0, m, id);
      if (tool) { const t = hand(s, 0, 'tool'); s.players[0].hand.pop(); m.tools.push(t); }
      if (!tera) { const o = hand(s, 0, 'other'); s.players[0].hand.pop(); s.players[0].hand.push(...m.stack); m.stack = [o]; }
    });
    return g.view(0).legalActions.some((a) => a.type === 'attack' && a.attackId === (tera ? 'base:strike' : 'other:strike'));
  };
  const two = await build(['Water', 'Fire']);
  assert(ready(two, ['water', 'double']), 'Fire removed: one Water and anything.');
  assert(!ready(two, ['water', 'double'], false), 'Without the Tool both types are needed.');
  assert(!ready(two, ['double']), 'One of the two types is still needed.');
  assert(!ready(two, [], true, false), 'Not a 「太晶」 Pokémon: its one-Water attack needs its Water.');
  const jet = await build(['Colorless']);
  assert(ready(jet, []), 'A one-Energy attack needs none (JP Q&A ドラパルトex「ジェットヘッド」).');
  // Another change first: the stadium's +1 Colorless, then any one removed (JP Q&A 夜の鉱山).
  const mine = await build(['Water', 'Fire'], (defs) => { def(defs, 'stadium').mechanics.effects = [binding('cn.energyRequirement@1',
    { effect: { op: 'energyRequirement', action: 'attack', mode: 'adjust', scope: 'all', energyType: 'Colorless', amount: 1 } }, 'mine')]; });
  const inMine = (energies) => {
    const g = board(mine, (s) => {
      s.stadium = hand(s, 1, 'stadium'); s.players[1].hand.pop();
      const m = s.players[0].active; for (const id of energies) attached(s, 0, m, id);
      const t = hand(s, 0, 'tool'); s.players[0].hand.pop(); m.tools.push(t);
    });
    return [g, g.view(0).legalActions.some((a) => a.type === 'attack' && a.attackId === 'base:strike')];
  };
  assert(inMine(['water', 'water'])[1]); assert(!inMine(['water'])[1]); assert(!inMine(['double'])[1]);
  const [g] = inMine(['water', 'double']);
  const routes = g.view(0).players[0].active.effective.attackRequirements[0].routes;
  assert.equal(routes.length, 3);
  assert(routes.every((r) => r.total === 2 && r.trace.some((t) => t.ruleId === 'energy.requirement.reduce-any')));
});
