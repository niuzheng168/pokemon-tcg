// Synthetic definitions only. 「将自己牌库上方N张卡牌翻到正面，造成其中能量张数×N伤害。将正面朝上的能量放于弃牌区，剩余的卡牌放回牌库并
// 重洗牌库」「将自己弃牌区中的所有基本能量给对手查看，造成其张数×N伤害。然后，将给对手查看过的能量放回牌库并重洗牌库」 (effects.reveal);
// 「将弃牌区中任意数量的…放于放逐区」「双方各将牌库上方1张卡牌放于弃牌区」「给这只宝可梦身上放置最多N个伤害指示物」 counted before damage
// (damage.effect-count); 「与…数量相同数量」 (effects.count-value); 「双方玩家，各将自己的手牌翻到正面，互相展示」. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, assertSupportedDefinition } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const lit = (value) => ({ kind: 'literal', value });
const handlers = createCoreHandlers();
const valid = (id, p) => handlers.get(id).validateParameters(clone(p));
const playable = (g, card) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card);
const REVEAL = 'fixture:reveal', COUNT = 'fixture:count';
const formula = (expression) => binding('cn.damageValue@1', { expression }, 'formula');
const route = (p) => binding('cn.revealedCards@1', { effectId: REVEAL, ...p }, 'route');
const pile = (s, owner, zone, ids) => ids.map((id) => { const c = hand(s, owner, id); s.players[owner].hand.pop(); s.players[owner][zone].push(c); return c; });
async function attackWith(effects) {
  return fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 500; d.mechanics.weakness = null; d.mechanics.resistance = null; }
    const a = defs[0].mechanics.attacks[0]; a.printedDamage = null; a.effects = effects;
  });
}
function dealt(f, mutate, policy) {
  const g = board(f, (s) => { mutate(s); attached(s, 0, s.players[0].active, 'water'); });
  const from = g.snapshot().events.length;
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g, policy);
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  const events = g.snapshot().events.slice(from);
  return { g, events, damage: events.filter((e) => e.ruleId === 'attack.order' && Object.hasOwn(e.data, 'damage')).reduce((n, e) => n + e.data.damage, 0) };
}

test('schemas: reveals, their follow-up, both decks, own counters, both hands and computed counts', () => {
  for (const p of [{ from: 'deck', lookTop: 5 }, { from: 'discard', selector: { kind: 'energy', category: 'basic' } },
    { from: 'hand', selector: { kind: 'energy' }, quantity: { kind: 'any' } }, { from: 'hand', selector: { kind: 'energy' }, quantity: { kind: 'upTo', count: 2 } }])
    assert(valid('cn.countedReveal@1', p), JSON.stringify(p));
  for (const p of [{ from: 'deck', lookTop: 5, selector: { kind: 'energy' } }, { from: 'discard' }, { from: 'hand', selector: { kind: 'energy' }, quantity: { kind: 'all' } },
    { from: 'prizes', lookTop: 1 }]) assert(!valid('cn.countedReveal@1', p), JSON.stringify(p));
  assert(valid('cn.revealedCards@1', { effectId: REVEAL, to: 'discard', selector: { kind: 'energy' }, rest: 'deck' }));
  assert(valid('cn.revealedCards@1', { effectId: REVEAL, to: 'deck' }));
  assert(!valid('cn.revealedCards@1', { effectId: REVEAL, to: 'discard', rest: 'deck' }), 'The rest is what a selector leaves.');
  assert(!valid('cn.revealedCards@1', { effectId: REVEAL, to: 'lost' }));
  assert(valid('cn.countedDeckTop@1', { side: 'both', count: 1 }));
  assert(!valid('cn.countedDeckTop@1', { side: 'either', count: 1 }));
  assert(!valid('cn.discardDeckTop@1', { side: 'both', count: 1 }));
  assert(valid('cn.countedSelfCounters@1', { maximum: 12 }));
  assert(!valid('cn.countedSelfCounters@1', { maximum: 0 }));
  assert(valid('cn.revealHands@1', { side: 'both' }));
  assert(!valid('cn.revealHands@1', { side: 'own' }));
  assert(valid('cn.countedCards@1', { from: 'discard', to: 'lost', selector: { kind: 'trainer', categories: ['tool'] }, quantity: { kind: 'any' },
    reveal: false, lookTop: null, shuffleAfter: false }));
  assert(!valid('cn.countedCards@1', { from: 'discard', to: 'hand', selector: { kind: 'any' }, quantity: { kind: 'any' }, reveal: false, lookTop: null, shuffleAfter: false }));
  const n = { kind: 'pokemonCount', side: 'opponent', zone: 'field', selector: { kind: 'pokemon' } };
  const value = (effect) => valid('cn.countValue@1', { effect, count: n });
  assert(value({ handlerId: 'cn.distributeCounters@1', parameters: { op: 'distributeCounters', side: 'opponent', target: 'any', selector: { kind: 'pokemon' }, count: 1 } }));
  assert(value({ handlerId: 'cn.discardDeckTop@1', parameters: { side: 'opponent', count: 1 } }));
  assert(value({ handlerId: 'cn.cards@1', parameters: { from: 'deck', to: 'hand', selector: { kind: 'any' }, quantity: { kind: 'upTo', count: 1 },
    reveal: false, lookTop: null, shuffleAfter: true } }));
  for (const bad of [{ handlerId: 'cn.discardDeckTop@1', parameters: { side: 'opponent', count: 2 } },
    { handlerId: 'cn.cards@1', parameters: { from: 'deck', to: 'hand', selector: { kind: 'any' }, quantity: { kind: 'any' }, reveal: false, lookTop: null, shuffleAfter: true } },
    { handlerId: 'cn.cards@1', parameters: { from: 'deck', to: 'hand', selector: { kind: 'any' }, quantity: { kind: 'upTo', count: 2 }, reveal: false, lookTop: null, shuffleAfter: true } },
    { handlerId: 'cn.draw@1', parameters: { count: 1 } }, { handlerId: 'cn.discardDeckTop@1', parameters: { side: 'nobody', count: 1 } }])
    assert(!value(bad), JSON.stringify(bad));
});

test('「将牌库上方3张卡牌翻到正面，造成其中能量张数×80。将正面朝上的能量放于弃牌区，剩余的卡牌放回牌库并重洗牌库」', async () => {
  const f = await attackWith([binding('cn.countedReveal@1', { from: 'deck', lookTop: 3 }, 'reveal'),
    formula({ kind: 'multiply', left: lit(80), right: { kind: 'movedCards', effectId: REVEAL, selector: { kind: 'energy' } } }),
    route({ to: 'discard', selector: { kind: 'energy' }, rest: 'deck' })]);
  let top;
  const { g, events, damage } = dealt(f, (s) => { top = pile(s, 0, 'deck', ['potion', 'water', 'double']); });
  assert.equal(damage, 160);
  const s = g.snapshot(), shown = events.find((e) => e.ruleId === 'effects.reveal');
  assert.equal(shown.visibility, 'public');
  assert.deepEqual(shown.data.cardIds, [...top].reverse(), 'All three, top first, shown to both players.');
  assert.deepEqual(shown.data.cards.map((c) => c.definitionId), ['double', 'water', 'potion']);
  const damageAt = events.findIndex((e) => e.ruleId === 'attack.order' && Object.hasOwn(e.data, 'damage'));
  assert(events.findIndex((e) => e.ruleId === 'effects.reveal' && e.data.moved) > damageAt, 'The cards move on after damage.');
  assert(s.players[0].discard.includes(top[1]) && s.players[0].discard.includes(top[2]));
  assert(s.players[0].deck.includes(top[0]) && s.events.some((e) => e.ruleId === 'effects.shuffle'));
  // 「将正面朝上的【超】宝可梦放回牌库并重洗牌库。将剩余的卡牌放于弃牌区」: the chosen kind back into the deck, the rest discarded.
  const back = await attackWith([binding('cn.countedReveal@1', { from: 'deck', lookTop: 3 }, 'reveal'),
    formula({ kind: 'multiply', left: lit(60), right: { kind: 'movedCards', effectId: REVEAL, selector: { kind: 'pokemon' } } }),
    route({ to: 'deck', selector: { kind: 'pokemon' }, rest: 'discard' })]);
  const r = dealt(back, (s) => { top = pile(s, 0, 'deck', ['other', 'water', 'potion']); });
  assert.equal(r.damage, 60);
  const t = r.g.snapshot();
  assert(t.players[0].deck.includes(top[0]) && t.players[0].discard.includes(top[1]) && t.players[0].discard.includes(top[2]));
  // An empty deck shows nothing and nothing follows.
  const empty = dealt(f, (s) => { s.players[0].discard.push(...s.players[0].deck.splice(0)); });
  assert.equal(empty.damage, 0);
  assert(!empty.events.some((e) => e.ruleId === 'effects.reveal'));
});

test('「将弃牌区中的所有基本能量给对手查看，造成其张数×20。然后，将给对手查看过的能量放回牌库并重洗牌库」; shown hand cards', async () => {
  const f = await attackWith([binding('cn.countedReveal@1', { from: 'discard', selector: { kind: 'energy', category: 'basic' } }, 'reveal'),
    formula({ kind: 'multiply', left: lit(20), right: { kind: 'effectCards', effectId: REVEAL } }), route({ to: 'deck' })]);
  let waters, others;
  const { g, damage } = dealt(f, (s) => { waters = pile(s, 0, 'discard', ['water', 'water', 'water']); others = pile(s, 0, 'discard', ['double', 'potion']); });
  assert.equal(damage, 60);
  const s = g.snapshot();
  assert(waters.every((id) => s.players[0].deck.includes(id)) && others.every((id) => s.players[0].discard.includes(id)));
  // 「将自己手牌中任意数量的X给对手查看，造成其张数×60」: the cards shown stay in the hand.
  const show = await attackWith([binding('cn.countedReveal@1', { from: 'hand', selector: { kind: 'energy', category: 'basic' }, quantity: { kind: 'any' } }, 'reveal'),
    formula({ kind: 'multiply', left: lit(60), right: { kind: 'effectCards', effectId: REVEAL } })]);
  let picked;
  const pick = (q) => q.kind === 'select-cards' ? (picked = q.options.slice(0, 2)) : q.options.slice(0, q.minimum);
  const r = dealt(show, (s) => { hand(s, 0, 'water'); hand(s, 0, 'water'); hand(s, 0, 'water'); }, pick);
  assert.equal(r.damage, 120);
  assert(picked.every((id) => r.g.snapshot().players[0].hand.includes(id)));
  assert.equal(dealt(show, (s) => { hand(s, 0, 'water'); }).damage, 0, '「任意数量」: none shown.');
  assert.equal(dealt(show, () => {}).damage, 0, 'Nothing to show: an explicit zero.');
  // 「然后，将给对手查看过的「连击」卡放回牌库并重洗牌库」.
  const back = await attackWith([binding('cn.countedReveal@1', { from: 'hand', selector: { kind: 'energy' }, quantity: { kind: 'upTo', count: 2 } }, 'reveal'),
    formula({ kind: 'multiply', left: lit(40), right: { kind: 'effectCards', effectId: REVEAL } }), route({ to: 'deck' })]);
  const t = dealt(back, (s) => { hand(s, 0, 'water'); hand(s, 0, 'double'); }, pick);
  assert.equal(t.damage, 80);
  assert(picked.every((id) => t.g.snapshot().players[0].deck.includes(id)));
  // A forged choice of a card that does not match is refused.
  const g2 = board(show, (s) => { hand(s, 0, 'water'); hand(s, 0, 'potion'); attached(s, 0, s.players[0].active, 'water'); });
  command(g2, { type: 'attack', attackId: 'base:strike' });
  const potion = g2.snapshot().players[0].hand.find((id) => g2.snapshot().cards[id].definitionId === 'potion');
  assert.throws(() => answer(g2, [potion]));
});

test('counted Lost Zone moves, both decks and the user\'s own counters', async () => {
  const lost = await attackWith([binding('cn.countedCards@1', { from: 'discard', to: 'lost', selector: { kind: 'trainer', categories: ['tool'] },
    quantity: { kind: 'any' }, reveal: false, lookTop: null, shuffleAfter: false }, 'count'),
    formula({ kind: 'add', terms: [lit(10), { kind: 'multiply', left: lit(40), right: { kind: 'effectCards', effectId: COUNT } }] })]);
  let tools;
  const l = dealt(lost, (s) => { tools = pile(s, 0, 'discard', ['tool', 'hp-tool']); }, (q) => q.kind === 'select-cards' ? [...q.options] : q.options.slice(0, q.minimum));
  assert.equal(l.damage, 90);
  assert.deepEqual([...l.g.snapshot().players[0].lost].sort(), [...tools].sort());
  const both = await attackWith([binding('cn.countedDeckTop@1', { side: 'both', count: 1 }, 'count'),
    formula({ kind: 'multiply', left: lit(100), right: { kind: 'movedCards', effectId: COUNT, selector: { kind: 'energy' } } })]);
  let mine, theirs;
  const b = dealt(both, (s) => { [mine] = pile(s, 0, 'deck', ['water']); [theirs] = pile(s, 1, 'deck', ['potion']); });
  assert.equal(b.damage, 100);
  const s = b.g.snapshot();
  assert(s.players[0].discard.includes(mine) && s.players[1].discard.includes(theirs));
  assert.deepEqual(s.events.filter((e) => e.ruleId === 'damage.effect-count').at(-1).data.cards, [mine, theirs], 'The user\'s card first.');
  const self = await attackWith([binding('cn.countedSelfCounters@1', { maximum: 3 }, 'count'),
    formula({ kind: 'multiply', left: lit(20), right: { kind: 'effectCards', effectId: COUNT } }),
    binding('cn.counters@1', { side: 'opponent', target: 'any', count: 1 }, 'after')]);
  const g = board(self, (s) => { attached(s, 0, s.players[0].active, 'water'); });
  command(g, { type: 'attack', attackId: 'base:strike' });
  const q = g.snapshot().pending;
  assert.equal(q.kind, 'counter-place-count'); assert.deepEqual(q.options, ['1', '2', '3'], '「最多3个」: 1 to 3 (II.D-05).');
  answer(g, ['2']);
  const middle = g.snapshot();
  assert.equal(middle.players[0].active.counters, 2, 'Placed before damage.');
  assert.deepEqual(middle.attack.execution.effectCards, [{ effectId: COUNT, cards: [], count: 2 }]);
  for (const forge of [(x) => { x.attack.execution.effectCards[0].cards = [x.players[0].active.stack[0]]; },
    (x) => { delete x.attack.execution.effectCards[0].count; }]) {
    const forged = clone(middle); forge(forged);
    forged.events.findLast((e) => e.ruleId === 'damage.effect-count').data = { ...forged.events.findLast((e) => e.ruleId === 'damage.effect-count').data,
      ...forged.attack.execution.effectCards[0], ...(Object.hasOwn(forged.attack.execution.effectCards[0], 'count') ? {} : { count: undefined }) };
    assert.throws(() => OfficialGame.restore(JSON.parse(JSON.stringify(forged)), { catalog: self.catalog }), (e) => e.code === 'invalid-effect-count');
  }
  settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 5);
  assert.deepEqual(restore(g, self).snapshot(), g.snapshot());
  // A card-kind count cannot read a number of counters.
  const wrong = await attackWith([binding('cn.countedSelfCounters@1', { maximum: 3 }, 'count'),
    formula({ kind: 'multiply', left: lit(20), right: { kind: 'movedCards', effectId: COUNT, selector: { kind: 'any' } } })]);
  const w = board(wrong, (s) => { attached(s, 0, s.players[0].active, 'water'); });
  command(w, { type: 'attack', attackId: 'base:strike' });
  assert.throws(() => answer(w, ['1']));
});

test('「双方玩家，各将自己的手牌翻到正面，互相展示。从自己的牌库上方抽取3张卡牌」', async () => {
  const f = await fixture((defs) => {
    def(defs, 'potion').mechanics.effects = [binding('cn.revealHands@1', { side: 'both' }, 'show'), binding('cn.draw@1', { count: 3 }, 'draw')];
  });
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); hand(s, 0, 'water'); hand(s, 1, 'tool'); });
  const before = g.snapshot().players[0].hand.length;
  command(g, { type: 'playTrainer', cardId: card }); settle(g);
  const s = g.snapshot(), shown = s.events.filter((e) => e.ruleId === 'effects.reveal');
  assert.deepEqual(shown.map((e) => [e.data.player, e.visibility]), [[0, 'public'], [1, 'public']]);
  assert.deepEqual(shown[1].data.cardIds, s.players[1].hand);
  assert.equal(s.players[0].hand.length, before - 1 + 3);
  const h = handlers.get('cn.revealHands@1');
  const ctx = (hands) => ({ source: { owner: 0, instanceId: 'card' }, state: { players: hands.map((hand) => ({ hand })) } });
  assert.deepEqual([h.canUse(ctx([['card'], []])), h.canUse(ctx([['card'], ['x']])), h.canUse(ctx([['card', 'y'], []]))], [false, true, true]);
  const empty = board(f, (s) => { card = hand(s, 0, 'potion'); s.players[1].discard.push(...s.players[1].hand.splice(0)); });
  command(empty, { type: 'playTrainer', cardId: card }); settle(empty);
  assert.equal(empty.snapshot().events.filter((e) => e.ruleId === 'effects.reveal').length, 1, 'An empty hand shows nothing.');
});

test('「与对手场上宝可梦数量相同数量」: counts read when the effect resolves; zero does nothing', async () => {
  const opponentField = { kind: 'pokemonCount', side: 'opponent', zone: 'field', selector: { kind: 'pokemon' } };
  const ownBench = { kind: 'pokemonCount', side: 'own', zone: 'bench', selector: { kind: 'pokemon' } };
  const value = (effect, count) => binding('cn.countValue@1', { effect, count }, 'value');
  const f = await fixture((defs) => {
    def(defs, 'potion').mechanics.effects = [value({ handlerId: 'cn.distributeCounters@1', parameters: { op: 'distributeCounters', side: 'opponent',
      target: 'any', selector: { kind: 'pokemon' }, count: 1 } }, opponentField)];
    def(defs, 'poison').mechanics.effects = [value({ handlerId: 'cn.cards@1', parameters: { from: 'deck', to: 'hand', selector: { kind: 'any' },
      quantity: { kind: 'upTo', count: 1 }, reveal: false, lookTop: null, shuffleAfter: true } }, ownBench)];
    def(defs, 'research').mechanics.effects = [value({ handlerId: 'cn.counters@1', parameters: { side: 'opponent', target: 'any', all: true, count: 1 } }, ownBench)];
    def(defs, 'base').mechanics.attacks[0].effects = [value({ handlerId: 'cn.discardDeckTop@1', parameters: { side: 'opponent', count: 1 } },
      { kind: 'pokemonSum', who: 'self', field: 'energyCards' })];
  });
  let card;
  let g = board(f, (s) => { card = hand(s, 0, 'potion'); bench(s, 1, 'other'); });
  command(g, { type: 'playTrainer', cardId: card });
  assert.equal(g.view(0).pending.counterAllocation.total, 2, 'Two opponent Pokémon: two counters.');
  g = board(f, (s) => { card = hand(s, 0, 'poison'); bench(s, 0, 'other'); bench(s, 0, 'other'); });
  command(g, { type: 'playTrainer', cardId: card });
  assert.equal(g.snapshot().pending.maximum, 2, '「最多与自己备战宝可梦数量相同张数」.');
  settle(g);
  assert(!playable(board(f, (s) => { card = hand(s, 0, 'poison'); }), card), 'No Bench: nothing to take.');
  g = board(f, (s) => { card = hand(s, 0, 'research'); bench(s, 0, 'other'); bench(s, 0, 'other'); bench(s, 1, 'other'); });
  command(g, { type: 'playTrainer', cardId: card }); settle(g);
  const s = g.snapshot();
  assert.deepEqual([s.players[1].active.counters, s.players[1].bench[0].counters], [2, 2]);
  const deck = (n) => {
    const a = board(f, (s) => { for (let i = 0; i < n; i++) attached(s, 0, s.players[0].active, 'water'); });
    const before = a.snapshot().players[1].discard.length;
    command(a, { type: 'attack', attackId: 'base:strike' }); settle(a);
    return a.snapshot().players[1].discard.length - before;
  };
  assert.deepEqual([deck(1), deck(3)], [1, 3], 'One card per attached Energy.');
});

test('load guard: a reveal follow-up belongs to the same attack and moves the cards out of where they were shown', async () => {
  const catalog = { handler: (id) => handlers.get(id) };
  const f = await fixture();
  const reveal = (p) => binding('cn.countedReveal@1', p, 'reveal');
  const attack = (effects) => {
    const d = clone(def(f.definitions, 'base'));
    d.mechanics.attacks[0].effects = effects;
    return d;
  };
  assertSupportedDefinition(catalog, attack([reveal({ from: 'deck', lookTop: 3 }), route({ to: 'deck', selector: { kind: 'pokemon' }, rest: 'discard' })]));
  for (const effects of [[route({ to: 'deck' })], [reveal({ from: 'discard', selector: { kind: 'energy' } }), route({ to: 'discard' })],
    [reveal({ from: 'discard', selector: { kind: 'energy' } }), route({ to: 'deck', selector: { kind: 'energy' }, rest: 'discard' })],
    [reveal({ from: 'deck', lookTop: 3 }), route({ to: 'deck', selector: { kind: 'energy' }, rest: 'deck' })],
    [reveal({ from: 'hand', selector: { kind: 'energy' }, quantity: { kind: 'any' } }), route({ to: 'hand' })]])
    assert.throws(() => assertSupportedDefinition(catalog, attack(effects)), (e) => e.code === 'unsupported-effect-count', JSON.stringify(effects));
  const item = clone(def(f.definitions, 'potion'));
  item.mechanics.effects = [route({ to: 'deck' })];
  assert.throws(() => assertSupportedDefinition(catalog, item), (e) => e.code === 'unsupported-handler');
});
