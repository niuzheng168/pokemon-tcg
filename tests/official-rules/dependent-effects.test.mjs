// Synthetic definitions only. Shapes follow printed CN instructions:
// 「A。然后，B」 / 「如果成功执行互换了的话，则…」 (II.E-19), attaching to this
// Pokémon or to distinct tagged Pokémon, discarding the opponent's top deck card,
// excluding cost-discarded Energy, and a deck split of distinct Basic Energy
// types (one to hand, the rest attached). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, EngineError } from '../../public/rules/game.js';
import { createCoreHandlers, validateThenEffect } from '../../public/rules/handlers.js';
import { paymentOptionId } from '../../public/rules/activation-cost.js';
import { DECK_ENERGY_HAND, deckEnergyDestinations, assertDeckEnergyAction } from '../../public/rules/deck-energy.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const nested = (handlerId, parameters) => ({ handlerId, parameters });
// Test-only deck shape: a few Basic Fire Energy cards beside the Water ones.
const withFire = async (transform) => {
  const f = await fixture(transform);
  for (let i = 0; i < 6; i++) f.deck[f.deck.lastIndexOf('printing:water')] = 'printing:fire';
  return f;
};
const play = (g, cardId) => command(g, { type: 'playTrainer', cardId });
const playable = (g, cardId) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === cardId);
const item = (effects, extra = {}) => (defs) => {
  const potion = defs.find((d) => d.definitionId === 'potion');
  potion.mechanics = { category: 'item', effects, ...extra };
};
const catcher = [binding('cn.then@1', {
  first: nested('cn.switch@1', { side: 'opponent', chooser: 'self', affected: 'selected' }),
  next: nested('cn.switch@1', { side: 'own', chooser: 'self', affected: 'active' }),
}, 'catcher')];

test('then handler: CN sources, nested leaves only, and the first part decides usability', () => {
  const h = createCoreHandlers().get('cn.then@1');
  for (const source of requireRule(CN_V20261019, 'effects.partial').sourceOfTruth) assert(h.sourceOfTruth.includes(source));
  const p = catcher[0].parameters;
  assert(validateThenEffect(p));
  for (const bad of [{ ...p, next: nested('cn.condition@1', { side: 'opponent', condition: 'burned' }) },
    { ...p, first: nested('cn.switch@1', { side: 'opponent' }) }, { first: p.first }])
    assert(!validateThenEffect(bad));
  assert.equal(h.validateParameters, validateThenEffect);
});

test('II.E-19: 「选择对手的1只备战宝可梦…互换。然后，将自己的战斗宝可梦与备战宝可梦互换」 runs both, in order', async () => {
  const f = await fixture(item(catcher));
  let card, theirs, mine;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); theirs = bench(s, 1, 'other'); mine = bench(s, 0, 'other'); });
  play(g, card);
  assert.deepEqual(g.view(0).pending.options, [theirs.id]);
  answer(g, [theirs.id]);
  assert.deepEqual(g.view(0).pending.options, [mine.id]);
  restore(g, f);
  answer(g, [mine.id]); settle(g);
  const s = g.snapshot();
  assert.deepEqual([s.players[1].active.id, s.players[0].active.id], [theirs.id, mine.id]);
});

test('II.E-19 FAQ2: no opponent Bench means nothing changes, so the card cannot be played; an empty own Bench skips only the second part', async () => {
  const f = await fixture(item(catcher));
  let card, theirs;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); bench(s, 0, 'other'); });
  assert.equal(playable(g, card), false);
  const h = board(f, (s) => { card = hand(s, 0, 'potion'); theirs = bench(s, 1, 'other'); });
  play(h, card); answer(h, [theirs.id]); settle(h);
  assert.equal(h.snapshot().players[1].active.id, theirs.id);
  assert.equal(h.snapshot().pending, null);
});

const quickTrigger = [binding('cn.then@1', {
  first: nested('cn.switch@1', { side: 'own', chooser: 'self', affected: 'source' }),
  next: nested('cn.attachedEnergy@1', { op: 'moveEnergy', side: 'own', from: 'any', selector: { kind: 'energy' }, providedTypes: null,
    measure: 'cards', quantity: { kind: 'any' }, chooser: 'source',
    recipient: { position: 'self', selector: { kind: 'pokemon' } }, distribution: 'singleRecipient' }),
}, 'quick')];
const quick = (defs) => {
  defs.find((d) => d.definitionId === 'other').mechanics.abilities = [{
    abilityId: 'fixture:quick', name: '测试快速游标', mode: 'triggered', usage: null, sourceOfTruth: EVIDENCE,
    trigger: { event: 'bench', origin: 'hand', subject: 'self', scope: 'global', choiceOwner: 'source', optional: true },
    effects: quickTrigger.map((b) => ({ ...b })),
  }];
};

test('「将这只宝可梦与战斗宝可梦互换。如果成功执行互换了的话，则…能量转附于这只宝可梦」: a self switch, then any number moved to it', async () => {
  const f = await fixture(quick);
  let card, energy, other;
  const g = board(f, (s) => {
    card = hand(s, 0, 'other'); energy = attached(s, 0, s.players[0].active, 'water');
    other = bench(s, 0, 'base'); attached(s, 0, other, 'water');
  });
  const formerActive = g.snapshot().players[0].active.id;
  command(g, { type: 'bench', cardId: card });
  assert.equal(g.view(0).pending.kind, 'trigger-optional');
  answer(g, ['perform']);
  const s = g.snapshot(), newcomer = s.players[0].active;
  assert.equal(newcomer.stack[0], card, 'Only this Benched Pokémon can become Active; no choice is offered.');
  const q = g.view(0).pending;
  assert.equal(q.kind, 'attached-energy'); assert.equal(q.minimum, 0);
  answer(g, [energy]); settle(g);
  const after = g.snapshot();
  assert.deepEqual(after.players[0].active.energy, [energy]);
  assert(after.players[0].bench.some((m) => m.id === formerActive));
  const h = createCoreHandlers().get('cn.switch@1');
  const ctx = { source: { owner: 0, pokemonId: 'absent' }, state: after };
  assert.equal(h.canUse(ctx, { side: 'own', chooser: 'self', affected: 'source' }), false, 'Not on the Bench: nothing to switch.');
  assert(!h.validateParameters({ side: 'opponent', chooser: 'self', affected: 'source' }));
});

test('an activated 「将这只宝可梦与战斗宝可梦互换」 is offered only while this Pokémon is Benched', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'other').mechanics.abilities = [{
      abilityId: 'fixture:step-in', name: '测试换上场', mode: 'activated', sourceOfTruth: EVIDENCE,
      usage: { period: 'turn', scope: 'pokemon', key: 'fixture:step-in', limit: 1 },
      effects: [binding('cn.switch@1', { side: 'own', chooser: 'self', affected: 'source' }, 'step-in')],
    }];
  });
  let benched;
  const g = board(f, (s) => { benched = bench(s, 0, 'other'); bench(s, 0, 'base'); });
  const offered = () => g.view(0).legalActions.filter((a) => a.type === 'useAbility').map((a) => a.pokemonId);
  assert.deepEqual(offered(), [benched.id]);
  command(g, { type: 'useAbility', pokemonId: benched.id, abilityId: 'fixture:step-in' }); settle(g);
  assert.equal(g.snapshot().players[0].active.id, benched.id);
  assert.deepEqual(offered(), []);
});

const ogerpon = (defs) => {
  defs.find((d) => d.definitionId === 'other').mechanics.abilities = [{
    abilityId: 'fixture:dance', name: '测试碧草之舞', mode: 'activated', sourceOfTruth: EVIDENCE,
    usage: { period: 'turn', scope: 'pokemon', key: 'fixture:dance', limit: 1 },
    effects: [binding('cn.attachThenDraw@1', { from: 'hand', draw: 1,
      attach: { type: 'Water', count: 1, benchOnly: false, optional: false, target: 'self' } }, 'dance')],
  }];
};

test('「选择手牌中的1张基本能量，附着于这只宝可梦身上。然后，抽取1张」: only this Pokémon receives it, and the draw depends on it', async () => {
  const f = await withFire(ogerpon);
  let user, energy;
  const g = board(f, (s) => { user = bench(s, 0, 'other'); s.players[0].discard.push(...s.players[0].hand.splice(0)); energy = hand(s, 0, 'water'); });
  const handSize = g.snapshot().players[0].hand.length;
  command(g, { type: 'useAbility', pokemonId: user.id, abilityId: 'fixture:dance' });
  assert.equal(g.view(0).pending.kind, 'hand-energy');
  answer(g, [energy]); settle(g);
  const s = g.snapshot();
  assert.deepEqual(s.players[0].bench.find((m) => m.id === user.id).energy, [energy]);
  assert.equal(s.players[0].hand.length, handSize, 'One card left the hand, one was drawn.');
  // Choosing none attaches nothing, so the dependent draw does not happen.
  const h = board(f, (s) => { user = bench(s, 0, 'other'); s.players[0].discard.push(...s.players[0].hand.splice(0)); hand(s, 0, 'water'); });
  command(h, { type: 'useAbility', pokemonId: user.id, abilityId: 'fixture:dance' });
  answer(h, []); settle(h);
  assert.equal(h.snapshot().players[0].hand.length, 1);
  const none = board(f, (s) => { user = bench(s, 0, 'other'); s.players[0].discard.push(...s.players[0].hand.splice(0)); hand(s, 0, 'fire'); });
  assert(!none.view(0).legalActions.some((a) => a.type === 'useAbility'), 'No matching Energy in hand: nothing changes.');
});

test('「选择自己最多2只「古代」宝可梦，各附着1张弃牌区中的基本能量。然后，抽取3张」: distinct tagged recipients, any Basic type', async () => {
  const f = await withFire((defs) => {
    defs.find((d) => d.definitionId === 'other').mechanics.tags = ['Ancient'];
    item([binding('cn.attachThenDraw@1', { from: 'discard', draw: 3, attach: { type: null, count: 2, benchOnly: false, optional: false,
      recipient: { kind: 'pokemon', tagsAll: ['Ancient'] }, distribution: 'separateRecipients' } }, 'vigor')])(defs);
    defs.find((d) => d.definitionId === 'potion').mechanics.category = 'supporter';
  });
  let card, a, b, energies;
  const g = board(f, (s) => {
    card = hand(s, 0, 'potion'); a = bench(s, 0, 'other'); b = bench(s, 0, 'other'); bench(s, 0, 'base');
    energies = [hand(s, 0, 'water'), hand(s, 0, 'fire'), hand(s, 0, 'water')];
    for (const id of energies) { s.players[0].hand.splice(s.players[0].hand.indexOf(id), 1); s.players[0].discard.push(id); }
  });
  const handSize = g.snapshot().players[0].hand.length;
  play(g, card);
  const q = g.view(0).pending;
  assert.equal(q.kind, 'discard-energy'); assert.equal(q.maximum, 2);
  assert.deepEqual([...q.options].sort(), [...energies].sort(), 'Any Basic Energy type.');
  answer(g, [energies[0], energies[1]]);
  assert.deepEqual([...g.view(0).pending.options].sort(), [a.id, b.id].sort(), 'Only tagged Pokémon.');
  answer(g, [a.id]);
  assert.deepEqual(g.view(0).pending.options, [b.id], 'Each Pokémon receives at most one.');
  restore(g, f);
  answer(g, [b.id]); settle(g);
  const s = g.snapshot();
  assert.equal(s.players[0].hand.length, handSize - 1 + 3);
  const none = board(f, (s) => { card = hand(s, 0, 'potion'); bench(s, 0, 'base'); });
  assert.equal(playable(none, card), false, 'No tagged Pokémon: nothing can be attached, so nothing changes.');
});

test('「选择弃牌区中最多2张基本能量，附着于1只备战宝可梦身上」 sends every chosen card to one Benched Pokémon', async () => {
  const f = await withFire((defs) => {
    defs.find((d) => d.definitionId === 'base').mechanics.attacks[0].effects = [binding('cn.attachDiscard@1',
      { type: null, count: 2, benchOnly: true, optional: false, distribution: 'singleRecipient' }, 'rally')];
  });
  let one, energies;
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water');
    one = bench(s, 0, 'other'); bench(s, 0, 'other');
    energies = [hand(s, 0, 'water'), hand(s, 0, 'fire')];
    for (const id of energies) { s.players[0].hand.splice(s.players[0].hand.indexOf(id), 1); s.players[0].discard.push(id); }
  });
  command(g, { type: 'attack', attackId: 'base:strike' });
  answer(g, energies); answer(g, [one.id]);
  settle(g);
  const s = g.snapshot();
  assert.deepEqual([...s.players[0].bench.find((m) => m.id === one.id).energy].sort(), [...energies].sort());
});

test('「将对手牌库上方1张卡牌放于弃牌区」 moves the opponent\'s top card to that player\'s discard pile, publicly', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'base').mechanics.attacks[0].effects = [binding('cn.discardDeckTop@1', { side: 'opponent', count: 1 }, 'mill')];
  });
  const g = board(f, (s) => attached(s, 0, s.players[0].active, 'water'));
  const top = g.snapshot().players[1].deck.at(-1);
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  const s = g.snapshot();
  assert(s.players[1].discard.includes(top));
  const record = s.events.find((e) => e.ruleId === 'effects.deck-top-discard');
  assert.deepEqual([record.visibility, record.data.player, record.data.cards.map((c) => c.instanceId)], ['public', 1, [top]]);
  // An empty deck performs nothing; the handler is then unusable for activations.
  const h = createCoreHandlers().get('cn.discardDeckTop@1');
  assert.equal(h.canUse({ source: { owner: 0 }, state: { players: [{ deck: [] }, { deck: [] }] } }, { side: 'opponent', count: 1 }), false);
  assert.equal(h.canUse({ source: { owner: 0 }, state: { players: [{ deck: ['x'] }, { deck: [] }] } }, { side: 'own', count: 2 }), true);
  const empty = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); s.players[1].discard.push(...s.players[1].deck.splice(0)); });
  command(empty, { type: 'attack', attackId: 'base:strike' }); settle(empty);
  assert.deepEqual(empty.snapshot().events.find((e) => e.ruleId === 'effects.deck-top-discard').data.cards, []);
});

test('「无法选择因为这张卡牌的效果而被放于弃牌区的能量」: Energy discarded as this card\'s cost is not eligible', async () => {
  const fee = [{ costId: 'fee', kind: 'discardHand', count: 2, selector: { kind: 'any' }, sourceOfTruth: EVIDENCE }];
  const f = await withFire(item([binding('cn.cards@1', { from: 'discard', to: 'hand', selector: { kind: 'energy', category: 'basic' },
    quantity: { kind: 'upTo', count: 4 }, reveal: true, lookTop: null, shuffleAfter: false, excludePaid: true }, 'retrieval')],
  { playCosts: fee }));
  let card, paid, old;
  const g = board(f, (s) => {
    s.players[0].discard.push(...s.players[0].hand.splice(0));
    const basic = s.players[0].discard.filter((id) => ['water', 'fire'].includes(s.cards[id].definitionId));
    s.players[0].discard = s.players[0].discard.filter((id) => !basic.includes(id)); s.players[0].deck.unshift(...basic);
    card = hand(s, 0, 'potion'); paid = [hand(s, 0, 'water'), hand(s, 0, 'fire')];
  });
  assert.equal(playable(g, card), false, 'Only the cost Energy would be in the discard pile.');
  const h = board(f, (s) => {
    s.players[0].discard.push(...s.players[0].hand.splice(0));
    card = hand(s, 0, 'potion'); paid = [hand(s, 0, 'water'), hand(s, 0, 'fire')];
    old = s.players[0].discard.filter((id) => s.cards[id].definitionId === 'water');
  });
  play(h, card);
  answer(h, paid.map((id) => paymentOptionId('fee', id)));
  const q = h.view(0).pending;
  assert.equal(q.kind, 'select-cards');
  assert(paid.every((id) => !q.options.includes(id)));
  assert.deepEqual([...q.options].sort(), [...old].sort());
  assert(!createCoreHandlers().get('cn.cards@1').validateParameters({ from: 'deck', to: 'hand', selector: { kind: 'any' },
    quantity: { kind: 'any' }, reveal: false, lookTop: null, shuffleAfter: true, excludePaid: true }));
});

const crispin = {
  op: 'attachDeckEnergy', lookTop: null, selector: { kind: 'energy', category: 'basic' }, quantity: { kind: 'upTo', count: 2 },
  recipient: { position: 'any', selector: { kind: 'pokemon' } }, distribution: 'separateRecipients', remainder: 'shuffleDeck', reveal: true,
  distinctTypes: true, toHand: 1,
};

test('「属性各不相同的基本能量最多2张…将其中1张加入手牌，将剩余的能量附着」: distinct types, one to hand, the rest attached', async () => {
  const f = await withFire(item([binding('cn.attachDeckEnergy@1', crispin, 'split')]));
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); });
  play(g, card);
  const deck = g.snapshot().players[0].deck, cards = g.snapshot().cards;
  const water = deck.filter((id) => cards[id].definitionId === 'water'), fire = deck.find((id) => cards[id].definitionId === 'fire');
  assert.throws(() => answer(g, water.slice(0, 2)), (e) => e instanceof EngineError || e.code === 'invalid-deck-energy-selection');
  answer(g, [water[0], fire]);
  const q = g.view(0).pending;
  assert.equal(q.kind, 'deck-energy-recipient');
  assert(q.options.includes(DECK_ENERGY_HAND) && q.options.includes(g.snapshot().players[0].active.id));
  answer(g, [DECK_ENERGY_HAND]);
  assert.deepEqual(g.view(0).pending.options, [g.snapshot().players[0].active.id], 'The hand slot is used: the rest is attached.');
  restore(g, f);
  answer(g, [g.snapshot().players[0].active.id]); settle(g);
  const s = g.snapshot();
  assert(s.players[0].hand.includes(water[0]));
  assert.deepEqual(s.players[0].active.energy, [fire]);
  assert(s.events.some((e) => e.ruleId === 'effects.search' && e.data.kind === 'to-hand' && e.visibility === 'public'));
  // One chosen card must go to hand.
  const h = board(f, (s) => { card = hand(s, 0, 'potion'); });
  play(h, card);
  answer(h, [h.snapshot().players[0].deck.find((id) => h.snapshot().cards[id].definitionId === 'fire')]);
  assert.deepEqual(h.view(0).pending.options, [DECK_ENERGY_HAND]);
  answer(h, [DECK_ENERGY_HAND]); settle(h);
  assert.equal(h.snapshot().players[0].active.energy.length, 0);
});

test('deck split action shape: only exact distinct-type / one-to-hand forms, and destinations follow the remaining hand slot', () => {
  assert.equal(assertDeckEnergyAction(crispin), crispin);
  for (const bad of [{ ...crispin, toHand: 2 }, { ...crispin, distribution: 'singleRecipient' }, { ...crispin, distinctTypes: false },
    { ...crispin, selector: { kind: 'energy' } }])
    assert.throws(() => assertDeckEnergyAction(bad), /exact printed shape|Distinct/);
  const { toHand, ...plain } = crispin;
  const ctx = { source: { owner: 0, pokemonId: null }, state: { players: [{ active: { id: 'm1', stack: ['p'] }, bench: [], deck: [] }, {}],
    cards: { p: { instanceId: 'p', owner: 0, definitionId: 'pk' } } },
  definitions: { pk: { kind: 'pokemon', mechanics: { types: ['Water'] } } }, effectivePokemon: { m1: { types: ['Water'] } } };
  assert.deepEqual(deckEnergyDestinations(ctx, plain, [], []), ['m1']);
  assert.deepEqual(deckEnergyDestinations(ctx, crispin, [], []), ['m1'], 'Nothing chosen: no hand slot to fill.');
});
