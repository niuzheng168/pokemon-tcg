// Synthetic definitions only. One choice among attached cards and the Stadium (effects.tool-discard, II.D-04 文例4):
// 「这张卡牌，只有将自己手牌中的1张【恶】宝可梦放于弃牌区后才可使用。将放于对手场上宝可梦身上的「宝可梦道具」「特殊能量」以及放于场上的「竞技场」中的1张卡牌，
// 放于弃牌区。」, 「选择放于对手场上宝可梦身上的「宝可梦道具」「特殊能量」以及场上的「竞技场」中的1张卡牌，放于放逐区。」,
// 「选择对手的1只宝可梦，将放于那只宝可梦身上的「宝可梦道具」和「特殊能量」各1张放于弃牌区。」, and Tools back to the hand (effects.tool-return):
// 「双方玩家，在自己的回合有1次机会，可选择放于自己场上宝可梦身上的1张「宝可梦道具」，放回手牌。」,
// 「在自己的回合可以使用1次。将放于自己场上宝可梦身上的1张「宝可梦道具」，放回手牌。」 No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { paymentOptionId } from '../../public/rules/activation-cost.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();
const valid = (p) => handlers.get('cn.discardTools@1').validateParameters(p);
const playable = (g, card) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card);
const hold = (s, owner, mon, name) => { const id = hand(s, owner, name); s.players[owner].hand.pop(); mon.tools.push(id); return id; };
const one = { kind: 'exact', count: 1 };
const drill = { side: 'opponent', target: 'any', quantity: one, specialEnergy: true, stadium: true };
const faba = { ...drill, to: 'lost' };
const brother = { side: 'opponent', target: 'any', quantity: one, specialEnergy: true, singleHolder: true };
const toHand = { side: 'own', target: 'any', quantity: one, to: 'hand' };
const item = async (effects, extra = () => {}) => {
  const f = await fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.weakness = null; d.mechanics.resistance = null; }
    def(defs, 'potion').mechanics.effects = effects; extra(defs);
  });
  f.deck.splice(-3, 3, 'printing:double', 'printing:double', 'printing:double');
  return f;
};

test('schema: Special Energy joins a Tool choice; the Stadium also with the opponent\'s side; one holder; Tools to the hand', () => {
  assert(requireRule(CN_V20261019, 'effects.tool-discard').sourceOfTruth.some((s) => s.section.includes('II.D-04 文例4')));
  assert(requireRule(CN_V20261019, 'effects.tool-return').sourceOfTruth.some((s) => s.documentId === 'JP-official-qa'));
  for (const p of [drill, faba, brother, toHand, { ...drill, side: 'both' }, { ...brother, side: 'own' }, { ...toHand, side: 'opponent' }]) assert(valid(p), JSON.stringify(p));
  for (const p of [{ ...drill, side: 'own' }, { ...drill, target: 'bench' }, { ...brother, specialEnergy: undefined }, { ...brother, side: 'both' },
    { ...brother, quantity: { kind: 'upTo', count: 1 } }, { ...brother, stadium: true }, { ...brother, to: 'lost' },
    { ...toHand, stadium: true, side: 'both' }, { ...toHand, specialEnergy: true }, { ...toHand, to: 'deck' }]) assert(!valid(clone(p)), JSON.stringify(p));
  // The counted forms count Tools only.
  assert(!handlers.get('cn.countedToolDiscard@1').validateParameters({ side: 'opponent', target: 'any', quantity: { kind: 'all' }, specialEnergy: true }));
  assert(!handlers.get('cn.optionalCounted@1').validateParameters({ effect: { handlerId: 'cn.discardTools@1',
    parameters: { side: 'opponent', target: 'any', quantity: { kind: 'all' }, specialEnergy: true } } }));
});

// Player 1's Active holds a Tool and a Special Energy (and a Basic Energy, never offered); player 0 holds the same and the Stadium is player 0's.
const field = (f, { tool = true, special = true, stadium = true, mutate = () => {} } = {}) => {
  const ids = {};
  const g = board(f, (s) => {
    ids.card = hand(s, 0, 'potion');
    const foe = s.players[1].active, mine = s.players[0].active;
    attached(s, 1, foe, 'water'); hold(s, 0, mine, 'tool'); attached(s, 0, mine, 'double');
    if (tool) ids.tool = hold(s, 1, foe, 'tool');
    if (special) ids.special = attached(s, 1, foe, 'double');
    if (stadium) { ids.stadium = hand(s, 0, 'stadium'); s.players[0].hand.pop(); s.stadium = ids.stadium; }
    mutate(s, ids);
  });
  return { g, ...ids };
};

test('「只有将自己手牌中的1张【恶】宝可梦放于弃牌区后才可使用」 then one of the opponent\'s Tools, Special Energy or the Stadium', async () => {
  const fee = { costId: 'fee', kind: 'discardHand', count: 1, selector: { kind: 'pokemon', types: ['Darkness'] }, sourceOfTruth: EVIDENCE };
  const f = await item([binding('cn.discardTools@1', drill, 'drill')], (defs) => {
    def(defs, 'potion').mechanics.playCosts = [fee]; def(defs, 'other').mechanics.types = ['Darkness'];
  });
  for (const pick of ['tool', 'special', 'stadium']) {
    const x = field(f, { mutate: (s, ids) => { ids.dark = hand(s, 0, 'other'); } });
    command(x.g, { type: 'playTrainer', cardId: x.card });
    answer(x.g, [paymentOptionId('fee', x.dark)]);
    const q = x.g.snapshot().pending;
    assert.equal(q.kind, 'select-cards');
    assert.deepEqual(q.options, [x.tool, x.special, x.stadium], 'The user\'s own Tool and Special Energy and any Basic Energy are not offered.');
    assert.deepEqual([q.minimum, q.maximum], [1, 1]);
    assert.deepEqual(restore(x.g, f).snapshot(), x.g.snapshot());
    answer(x.g, [x[pick]]); settle(x.g);
    const s = x.g.snapshot();
    assert(s.players[pick === 'stadium' ? 0 : 1].discard.includes(x[pick]), pick);
    assert.equal(s.players[1].active.tools.length, pick === 'tool' ? 0 : 1);
    assert.equal(s.players[1].active.energy.length, pick === 'special' ? 1 : 2);
    assert.equal(s.stadium, pick === 'stadium' ? null : x.stadium);
    if (pick === 'special') assert(s.events.some((e) => e.ruleId === 'effects.tool-discard' && e.data.cards[0] === x.special));
    assert(s.players[0].discard.includes(x.dark));
  }
  // Without a Darkness Pokémon to pay with, or with nothing to choose, it cannot be played.
  const unpaid = field(f);
  assert.equal(playable(unpaid.g, unpaid.card), false);
  const lone = field(f, { tool: false, stadium: false, mutate: (s, ids) => { ids.dark = hand(s, 0, 'other'); } });
  assert(playable(lone.g, lone.card), 'A Special Energy alone is enough.');
  const none = field(f, { tool: false, special: false, stadium: false, mutate: (s, ids) => { ids.dark = hand(s, 0, 'other'); } });
  assert.equal(playable(none.g, none.card), false, 'The user\'s own attached cards are never chosen.');
});

test('「…中的1张卡牌，放于放逐区」: a Special Energy to its owner\'s Lost Zone; the user\'s own Stadium may be chosen (JP Q&A ザオボー)', async () => {
  const f = await item([binding('cn.discardTools@1', faba, 'faba')]);
  const x = field(f);
  command(x.g, { type: 'playTrainer', cardId: x.card });
  answer(x.g, [x.special]); settle(x.g);
  let s = x.g.snapshot();
  assert(s.players[1].lost.includes(x.special) && !s.players[1].discard.includes(x.special));
  assert(s.events.some((e) => e.ruleId === 'effects.tool-discard' && e.data.to === 'lost'));
  const y = field(f);
  command(y.g, { type: 'playTrainer', cardId: y.card }); answer(y.g, [y.stadium]); settle(y.g);
  s = y.g.snapshot();
  assert(s.players[0].lost.includes(y.stadium)); assert.equal(s.stadium, null);
});

test('「选择对手的1只宝可梦，将…「宝可梦道具」和「特殊能量」各1张放于弃牌区」: one Pokémon, one of each kind it holds', async () => {
  const f = await item([binding('cn.discardTools@1', brother, 'brother')]);
  const x = field(f, { stadium: false, mutate: (s, ids) => {
    const other = bench(s, 1, 'other'); ids.lone = attached(s, 1, other, 'double'); attached(s, 1, other, 'water');
    ids.second = attached(s, 1, s.players[1].active, 'double');
  } });
  command(x.g, { type: 'playTrainer', cardId: x.card });
  const q = x.g.snapshot().pending;
  assert.deepEqual(q.options, [x.tool, x.special, x.second, x.lone]); assert.deepEqual([q.minimum, q.maximum], [1, 2]);
  const refuse = (selected) => assert.throws(() => answer(restore(x.g, f), selected), /quantity/, JSON.stringify(selected));
  refuse([x.tool]); refuse([x.special]); refuse([x.tool, x.lone]); refuse([x.special, x.second]); refuse([]);
  answer(x.g, [x.tool, x.second]); settle(x.g);
  let s = x.g.snapshot();
  assert(s.players[1].discard.includes(x.tool) && s.players[1].discard.includes(x.second));
  assert.deepEqual(s.players[1].active.tools, []); assert(s.players[1].active.energy.includes(x.special));
  assert(s.players[1].bench[0].energy.includes(x.lone));
  // A Pokémon with only one kind: only that one.
  const y = field(f, { stadium: false, mutate: (s, ids) => { ids.lone = attached(s, 1, bench(s, 1, 'other'), 'double'); } });
  command(y.g, { type: 'playTrainer', cardId: y.card }); answer(y.g, [y.lone]); settle(y.g);
  s = y.g.snapshot();
  assert(s.players[1].discard.includes(y.lone)); assert.equal(s.players[1].active.energy.length, 2);
  const none = field(f, { tool: false, special: false, stadium: false });
  assert.equal(playable(none.g, none.card), false);
});

test('a Stadium use 「选择放于自己场上宝可梦身上的1张「宝可梦道具」，放回手牌」: an HP Tool leaving Knocks the Pokémon Out (JP Q&A マギアナ「きせかえ」)', async () => {
  const f = await fixture((defs) => {
    def(defs, 'stadium').mechanics.effects = [binding('cn.stadiumUse@1', { key: 'fixture:mall', effect: { handlerId: 'cn.discardTools@1', parameters: toHand } }, 'mall')];
  });
  let tool, mon;
  const g = board(f, (s) => {
    const stadium = hand(s, 1, 'stadium'); s.players[1].hand.pop(); s.stadium = stadium;
    mon = bench(s, 0, 'other'); tool = hold(s, 0, mon, 'hp-tool'); mon.counters = 12; hold(s, 1, s.players[1].active, 'tool');
  });
  const canUse = () => g.view(0).legalActions.some((a) => a.type === 'useStadium');
  assert(canUse());
  const prizes = g.snapshot().players[1].prizes.length;
  command(g, { type: 'useStadium' });
  assert.deepEqual(g.snapshot().pending.options, [tool], 'Only the user\'s own Tools.');
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  answer(g, [tool]); settle(g);
  const s = g.snapshot();
  assert(s.players[0].hand.includes(tool) && !s.players[0].discard.includes(tool), 'Back in the hand, not discarded.');
  assert(!s.players[0].bench.some((m) => m.id === mon.id), 'Its remaining HP is gone: Knocked Out.');
  assert.equal(s.players[1].prizes.length, prizes - 1);
  assert(s.events.some((e) => e.ruleId === 'effects.tool-return' && e.data.to === 'hand'));
  assert(!canUse(), 'Once this turn, and no other Tool of the user\'s.');
});

test('an Ability 「将放于自己场上宝可梦身上的1张「宝可梦道具」，放回手牌」 needs a Tool of the user\'s', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.abilities = [{ abilityId: 'dress', name: '测试变装', mode: 'activated',
      usage: { period: 'turn', scope: 'pokemon', key: 'dress', limit: 1 }, effects: [binding('cn.discardTools@1', toHand, 'dress')], sourceOfTruth: EVIDENCE }];
  });
  const use = (g) => command(g, { type: 'useAbility', pokemonId: g.snapshot().players[0].active.id, abilityId: 'dress' }, 0);
  const usable = (g) => g.view(0).legalActions.some((a) => a.abilityId === 'dress');
  let tool;
  const g = board(f, (s) => { tool = hold(s, 0, s.players[0].active, 'tool'); hold(s, 1, s.players[1].active, 'tool'); });
  assert(usable(g));
  use(g); answer(g, [tool]); settle(g);
  assert(g.snapshot().players[0].hand.includes(tool)); assert.deepEqual(g.snapshot().players[0].active.tools, []);
  assert(!usable(board(f, (s) => { hold(s, 1, s.players[1].active, 'tool'); })), 'The opponent\'s Tools are not the user\'s.');
});
