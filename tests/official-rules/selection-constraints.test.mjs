// Synthetic definitions only. 「每次从手牌将【水】能量附着于这只宝可梦身上时」 (a trigger on the attached card's printed identity);
// 「属性各不相同的…」「名字各不同的…」 (cards); 「【火】或【雷】属性中的1种属性的…基本能量」「1只宝可梦身上附着的最多2个能量」
// 「「TAG TEAM」宝可梦身上」「所有宝可梦身上的能量各1个」 (attached Energy). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { distinctCards } from '../../public/rules/card-selection.js';
import { validateTriggerDescriptor } from '../../public/rules/schema-validators.js';
import { attachedEnergyChoice } from '../../public/rules/energy-selection.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();
const energy = (extra) => ({ op: 'discardEnergy', side: 'own', from: 'self', selector: { kind: 'energy', category: 'basic', types: ['Water', 'Fire'] },
  providedTypes: null, measure: 'cards', quantity: { kind: 'any' }, chooser: 'source', ...extra });

test('schemas', () => {
  const trigger = (extra) => ({ event: 'energyAttached', subject: 'self', origin: 'hand', optional: false, choiceOwner: 'source', scope: 'global', ...extra });
  const water = { kind: 'energy', category: 'basic', types: ['Water'] };
  assert(validateTriggerDescriptor(trigger({ cardSelector: water })));
  assert(!validateTriggerDescriptor(trigger({ event: 'attackDamage', origin: undefined, cardSelector: water })), 'No card in a damage event.');
  const valid = (p) => handlers.get('cn.attachedEnergy@1').validateParameters(clone(p));
  assert(valid(energy({ sameType: true })));
  assert(!valid(energy({ sameType: true, selector: { kind: 'energy' } })), 'One Basic Energy type.');
  assert(!valid(energy({ sameType: true, measure: 'units' })));
  assert(valid(energy({ perPokemon: true, side: 'opponent', from: 'any', selector: { kind: 'energy' }, quantity: { kind: 'all' } })));
  assert(!valid(energy({ perPokemon: true, quantity: { kind: 'any' } })));
  assert(!valid(energy({ perPokemon: true, quantity: { kind: 'all' }, singleOrigin: true })));
  assert(valid({ op: 'moveEnergy', side: 'own', from: 'any', selector: { kind: 'energy' }, providedTypes: null, measure: 'units',
    quantity: { kind: 'upTo', count: 2 }, chooser: 'source', recipient: { position: 'any', selector: { kind: 'pokemon' } },
    distribution: 'singleRecipient', singleOrigin: true, originSelector: { kind: 'pokemon', tagsAll: ['TAG TEAM'] } }));
  const cards = (p) => handlers.get('cn.cards@1').validateParameters(clone(p));
  assert(cards({ from: 'deck', to: 'bench', selector: { kind: 'pokemon', stages: ['basic'] }, quantity: { kind: 'upTo', count: 3 },
    reveal: false, lookTop: null, shuffleAfter: true, distinct: 'types' }));
  assert(!cards({ from: 'deck', to: 'hand', selector: { kind: 'any' }, quantity: { kind: 'upTo', count: 3 }, reveal: true, lookTop: null, shuffleAfter: true, distinct: 'kinds' }));
  const d = (kind, extra) => ({ kind, nameKey: extra.nameKey ?? 'x', mechanics: extra });
  assert(distinctCards([d('pokemon', { types: ['Water'] }), d('pokemon', { types: ['Fire', 'Psychic'] })], 'types'));
  assert(!distinctCards([d('pokemon', { types: ['Water'] }), d('pokemon', { types: ['Fire', 'Water'] })], 'types'));
  assert(!distinctCards([d('energy', { category: 'basic', baseUnits: [['Fire']] }), d('pokemon', { types: ['Fire'] })], 'types'));
  assert(distinctCards([d('energy', { category: 'special', baseUnits: [['Colorless']] }), d('trainer', {})], 'types'));
  assert(!distinctCards([d('trainer', { nameKey: 'ball' }), d('trainer', { nameKey: 'ball' })], 'names'));
});

test('a trigger reads the attached Energy card: 「每次从手牌将【水】能量附着于这只宝可梦身上时，回复这只宝可梦「30」点HP」', async () => {
  const f = await fixture((defs) => {
    def(defs, 'base').mechanics.abilities = [{ abilityId: 'fixture:spring', name: '测试水泉', mode: 'triggered', sourceOfTruth: EVIDENCE,
      trigger: { event: 'energyAttached', subject: 'self', origin: 'hand', turn: 'own', optional: false, choiceOwner: 'source', scope: 'global',
        cardSelector: { kind: 'energy', category: 'basic', types: ['Water'] } }, usage: null,
      effects: [binding('cn.heal@1', { target: 'self', amount: 30 }, 'spring')] }];
  });
  for (const [card, healed] of [['water', true], ['double', false]]) {
    let id;
    const g = board(f, (s) => { s.players[0].active.counters = 5; id = hand(s, 0, card); });
    command(g, { type: 'attachEnergy', cardId: id, pokemonId: g.snapshot().players[0].active.id }); settle(g);
    assert.equal(g.snapshot().players[0].active.counters, healed ? 2 : 5, card);
    assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  }
});

test('「属性各不同的【基础】宝可梦最多3张，放于备战区」「名字各不同的物品最多3张」', async () => {
  const f = await fixture((defs) => {
    Object.assign(def(defs, 'evolution').mechanics, { stage: 'basic', evolvesFrom: null, types: ['Fire'] });
    def(defs, 'potion').mechanics.effects = [binding('cn.cards@1', { from: 'deck', to: 'bench', selector: { kind: 'pokemon', stages: ['basic'] },
      quantity: { kind: 'upTo', count: 3 }, reveal: false, lookTop: null, shuffleAfter: true, distinct: 'types' }, 'call')];
    def(defs, 'poison').mechanics.effects = [binding('cn.cards@1', { from: 'deck', to: 'hand', selector: { kind: 'any' },
      quantity: { kind: 'upTo', count: 3 }, reveal: true, lookTop: null, shuffleAfter: true, distinct: 'names' }, 'pick')];
  });
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); });
  command(g, { type: 'playTrainer', cardId: card });
  const s = g.snapshot(), of = (name) => s.pending.options.filter((id) => s.cards[id].definitionId === name);
  assert.throws(() => answer(g, [of('base')[0], of('other')[0]]), 'Two Water Pokémon.');
  answer(g, [of('other')[0], of('evolution')[0]]); settle(g);
  assert.equal(g.snapshot().players[0].bench.length, 2);
  const h = board(f, (s) => { card = hand(s, 0, 'poison'); });
  command(h, { type: 'playTrainer', cardId: card });
  const t = h.snapshot(), waters = t.pending.options.filter((id) => t.cards[id].definitionId === 'water');
  assert.throws(() => answer(h, waters.slice(0, 2)), 'Same name twice.');
  answer(h, [waters[0], t.pending.options.find((id) => t.cards[id].definitionId !== 'water')]); settle(h);
  assert.deepEqual(restore(h, f).snapshot(), h.snapshot());
});

test('「【火】或【水】属性中的1种属性的任意数量的基本能量」, one holder, a holder kind, and one card from each Pokémon', async () => {
  const f = await fixture((defs) => {
    // A Basic Fire Energy in the fixture deck.
    def(defs, 'double').mechanics = { category: 'basic', baseUnits: [['Fire']], effects: [] }; def(defs, 'double').deckLimits.sameName = null;
    const a = def(defs, 'base').mechanics.attacks[0];
    a.effects = [binding('cn.attachedEnergy@1', energy({ sameType: true }), 'shed')];
    def(defs, 'potion').mechanics.effects = [binding('cn.attachedEnergy@1', { op: 'moveEnergy', side: 'own', from: 'any', selector: { kind: 'energy' },
      providedTypes: null, measure: 'cards', quantity: { kind: 'upTo', count: 2 }, chooser: 'source', recipient: { position: 'any', selector: { kind: 'pokemon' } },
      distribution: 'singleRecipient', singleOrigin: true, originSelector: { kind: 'pokemon', nameKeys: ['other'] } }, 'shift')];
    def(defs, 'poison').mechanics.effects = [binding('cn.attachedEnergy@1', { op: 'discardEnergy', side: 'opponent', from: 'any', selector: { kind: 'energy' },
      providedTypes: null, measure: 'cards', quantity: { kind: 'all' }, chooser: 'source', perPokemon: true }, 'strip')];
  });
  let water, fire;
  const g = board(f, (s) => { water = attached(s, 0, s.players[0].active, 'water'); fire = attached(s, 0, s.players[0].active, 'double'); });
  command(g, { type: 'attack', attackId: 'base:strike' });
  assert.throws(() => answer(g, [water, fire]), 'Both types at once.');
  answer(g, [fire]); settle(g);
  assert(g.snapshot().players[0].discard.includes(fire) && g.snapshot().players[0].active.energy.includes(water));
  let card, a, b, c, mons;
  const m = board(f, (s) => {
    card = hand(s, 0, 'potion');
    const one = bench(s, 0, 'other'), two = bench(s, 0, 'other');
    a = attached(s, 0, one, 'water'); b = attached(s, 0, two, 'water'); c = attached(s, 0, s.players[0].active, 'water');
    mons = [one.id, two.id];
  });
  command(m, { type: 'playTrainer', cardId: card });
  assert.deepEqual([...m.snapshot().pending.options].sort(), [a, b].sort(), 'Only the named holders.');
  assert.throws(() => answer(m, [a, b]), 'Two holders.');
  answer(m, [a]); settle(m);
  assert(m.snapshot().players[0].bench.find((x) => x.id === mons[0]).energy.length === 0);
  let p, q1, q2, r;
  const k = board(f, (s) => {
    card = hand(s, 0, 'poison');
    q1 = attached(s, 1, s.players[1].active, 'water'); q2 = attached(s, 1, s.players[1].active, 'water');
    r = attached(s, 1, bench(s, 1, 'other'), 'water'); bench(s, 1, 'other');
  });
  command(k, { type: 'playTrainer', cardId: card });
  p = k.snapshot().pending;
  assert.deepEqual([p.minimum, p.maximum], [2, 2], 'Two Pokémon hold Energy.');
  assert.throws(() => answer(k, [q1, q2]), 'Two from one Pokémon.');
  assert.throws(() => answer(k, [q1]));
  answer(k, [q2, r]); settle(k);
  const s = k.snapshot();
  assert(s.players[1].discard.includes(q2) && s.players[1].discard.includes(r) && s.players[1].active.energy.includes(q1));
  assert.deepEqual(restore(k, f).snapshot(), s);
  assert.equal(attachedEnergyChoice([{ instanceId: 'x', originId: 'm' }], { perPokemon: true }, ['y'], () => null).valid, false);
});

test('「选择自己牌库中的1张能量，附着于自己的宝可梦身上。并重洗牌库。然后，在被附着的宝可梦身上放置2个伤害指示物」', async () => {
  const attach = (recipientEffect) => ({ op: 'attachDeckEnergy', lookTop: null, selector: { kind: 'energy', category: 'basic' },
    quantity: { kind: 'exact', count: 1 }, recipient: { position: 'any', selector: { kind: 'pokemon' } }, distribution: 'singleRecipient',
    remainder: 'shuffleDeck', reveal: false, recipientEffect });
  const f = await fixture((defs) => {
    def(defs, 'potion').mechanics.effects = [binding('cn.attachDeckEnergy@1', attach({ counters: 2 }), 'charge')];
    def(defs, 'poison').mechanics.effects = [binding('cn.attachDeckEnergy@1', attach({ heal: 30 }), 'soothe')];
  });
  for (const [name, counters] of [['potion', 2], ['poison', 0]]) {
    let card, mon;
    const g = board(f, (s) => { card = hand(s, 0, name); mon = bench(s, 0, 'other'); mon.counters = name === 'poison' ? 3 : 0; });
    command(g, { type: 'playTrainer', cardId: card });
    settle(g, (q) => q.options.includes(mon.id) ? [mon.id] : q.options.slice(0, Math.max(1, q.minimum)));
    const s = g.snapshot(), m = s.players[0].bench[0];
    assert.equal(m.energy.length, 1);
    assert.equal(m.counters, counters, name);
    const shuffled = s.events.findIndex((e) => e.ruleId === 'effects.shuffle'), placed = s.events.findLastIndex((e) => e.ruleId === 'damage.counters');
    if (counters) assert(placed > shuffled, 'After the shuffle.');
    assert.deepEqual(restore(g, f).snapshot(), s);
  }
  assert(!handlers.get('cn.attachDeckEnergy@1').validateParameters(attach({ counters: 2, heal: 30 })));
});
