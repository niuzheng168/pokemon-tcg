// Synthetic definitions only. 「将场上最多2张「宝可梦道具」或「竞技场」，放于弃牌区」 (effects.tool-discard, effects.stadium-discard) and
// 「这张卡牌，只有将自己的1张手牌，放于放逐区后才可使用。选择放于双方场上宝可梦身上的「宝可梦道具」以及场上的「竞技场」中的1张，放于放逐区」
// (effects.activation-cost, zones.lost-zone). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { paymentOptionId } from '../../public/rules/activation-cost.js';
import { fixture, binding, board, command, answer, settle, hand, EVIDENCE } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const handlers = createCoreHandlers();
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const blower = { side: 'both', target: 'any', quantity: { kind: 'upTo', count: 2 }, stadium: true };
const vacuum = { side: 'both', target: 'any', quantity: { kind: 'exact', count: 1 }, stadium: true, to: 'lost' };
const fee = (kind = 'lostHand') => ({ costId: 'fee', kind, count: 1, selector: { kind: 'any' }, sourceOfTruth: EVIDENCE });
const item = (effects, costs = null, transform = () => {}) => fixture((defs) => {
  const d = def(defs, 'potion'); d.mechanics.effects = effects;
  if (costs) d.mechanics.playCosts = costs;
  transform(defs);
});
// Player 1's Active holds a Tool; player 0's Stadium is in play.
const field = (f, { tool = true, stadium = true, mutate = () => {} } = {}) => {
  let card, toolId = null, stadiumId = null;
  const g = board(f, (s) => {
    card = hand(s, 0, 'potion');
    if (tool) { toolId = hand(s, 1, 'tool'); s.players[1].hand.pop(); s.players[1].active.tools.push(toolId); }
    if (stadium) { stadiumId = hand(s, 0, 'stadium'); s.players[0].hand.pop(); s.stadium = stadiumId; }
    mutate(s);
  });
  return { g, card, toolId, stadiumId };
};
const playable = (g, card) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card);

test('schema: the Stadium joins only an either-side or opponent-side, any-Pokémon Tool choice; counted forms stay Tools only', () => {
  const valid = (p) => handlers.get('cn.discardTools@1').validateParameters(p);
  assert(valid(blower)); assert(valid(vacuum)); assert(valid({ side: 'opponent', target: 'any', quantity: { kind: 'all' }, to: 'lost' }));
  assert(valid({ ...blower, side: 'opponent' })); assert(!valid({ ...blower, side: 'own' }));
  assert(!valid({ ...blower, target: 'active' })); assert(!valid({ ...blower, stadium: false }));
  assert(!valid({ ...blower, to: 'discard' }));
  assert(!handlers.get('cn.countedToolDiscard@1').validateParameters(blower));
  assert(handlers.get('cn.countedToolDiscard@1').validateParameters({ side: 'opponent', target: 'any', quantity: { kind: 'all' } }));
  const counted = (e) => handlers.get('cn.optionalCounted@1').validateParameters({ effect: { handlerId: 'cn.discardTools@1', parameters: e } });
  assert(counted({ side: 'opponent', target: 'any', quantity: { kind: 'all' } })); assert(!counted(blower));
  assert(!counted({ side: 'opponent', target: 'any', quantity: { kind: 'all' }, to: 'lost' }));
});

test('「最多2张「宝可梦道具」或「竞技场」」: one choice over both; the Stadium goes to its owner\'s discard pile', async () => {
  const f = await item([binding('cn.discardTools@1', blower, 'blow')]);
  const { g, card, toolId, stadiumId } = field(f);
  command(g, { type: 'playTrainer', cardId: card });
  const q = g.snapshot().pending;
  assert.equal(q.kind, 'select-cards'); assert.deepEqual(q.options, [toolId, stadiumId]); assert.equal(q.maximum, 2);
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  answer(g, [toolId, stadiumId]); settle(g);
  const s = g.snapshot();
  assert.equal(s.stadium, null); assert(s.players[0].discard.includes(stadiumId)); assert(s.players[1].discard.includes(toolId));
  assert.deepEqual(s.players[1].active.tools, []);
  assert(s.events.some((e) => e.ruleId === 'effects.stadium-discard' && e.data.destination === 'discard'));
  assert(s.events.some((e) => e.ruleId === 'effects.tool-discard' && e.data.cards[0] === toolId));
  // Only the Stadium is chosen: no Tool record.
  const only = field(f);
  command(only.g, { type: 'playTrainer', cardId: only.card }); answer(only.g, [only.stadiumId]); settle(only.g);
  assert(!only.g.snapshot().events.some((e) => e.ruleId === 'effects.tool-discard'));
  assert.equal(only.g.snapshot().players[1].active.tools.length, 1);
  // A Stadium alone (or a Tool alone) is enough to play it; neither: not playable.
  const lone = field(f, { tool: false });
  assert(playable(lone.g, lone.card));
  const none = field(f, { tool: false, stadium: false });
  assert.equal(playable(none.g, none.card), false);
});

test('a Stadium protected from this effect is not offered', async () => {
  const shield = { op: 'stadiumProtection', scope: 'self', channel: 'effects', useRule: 'ordinary', from: 'all', categories: ['trainer'],
    trainerCategories: ['item'], trainerOrigins: ['hand'] };
  const f = await item([binding('cn.discardTools@1', blower, 'blow')], null, (defs) => {
    def(defs, 'stadium').mechanics.effects = [binding('cn.stadiumProtection@1', { effect: shield }, 'self-shield')];
  });
  const { g, card, toolId } = field(f);
  command(g, { type: 'playTrainer', cardId: card });
  assert.deepEqual(g.snapshot().pending.options, [toolId]);
  const lone = field(f, { tool: false });
  assert.equal(playable(lone.g, lone.card), false, 'Nothing it could choose.');
});

test('「只有将自己的1张手牌，放于放逐区后才可使用」 then a Tool or the Stadium into the Lost Zone', async () => {
  const f = await item([binding('cn.discardTools@1', vacuum, 'vacuum')], [fee()]);
  for (const pick of ['tool', 'stadium']) {
    const { g, card, toolId, stadiumId } = field(f);
    const paid = g.snapshot().players[0].hand.find((id) => id !== card);
    command(g, { type: 'playTrainer', cardId: card });
    const q = g.view(0).pending;
    assert.equal(q.kind, 'activation-cost'); assert.equal(q.payment.groups[0].kind, 'lostHand');
    answer(g, [paymentOptionId('fee', paid)]);
    let s = g.snapshot();
    assert(s.players[0].lost.includes(paid)); assert(!s.players[0].discard.includes(paid));
    assert.deepEqual(restore(g, f).snapshot(), s);
    const target = pick === 'tool' ? toolId : stadiumId;
    answer(g, [target]); settle(g);
    s = g.snapshot();
    assert(s.players[pick === 'tool' ? 1 : 0].lost.includes(target));
    assert(s.players[0].discard.includes(card), 'The used Item itself is discarded as usual.');
    if (pick === 'stadium') assert(s.events.some((e) => e.ruleId === 'effects.stadium-discard' && e.data.destination === 'lost'));
    else assert(s.events.some((e) => e.ruleId === 'effects.tool-discard' && e.data.to === 'lost'));
  }
  const empty = field(f, { tool: false, stadium: false });
  assert.equal(playable(empty.g, empty.card), false);
});

test('a card paid into the Lost Zone is never in the discard pile for the effect that follows', async () => {
  const fromDiscard = binding('cn.cards@1', { from: 'discard', to: 'hand', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 1 },
    reveal: true, lookTop: null, shuffleAfter: false }, 'recover');
  const attachDiscard = binding('cn.attachDiscard@1', { type: 'Water', count: 1, benchOnly: false, optional: false }, 'attach');
  for (const effect of [fromDiscard, attachDiscard]) {
    for (const kind of ['lostHand', 'discardHand']) {
      const f = await item([effect], [fee(kind)]);
      const { g, card } = field(f, { tool: false, stadium: false, mutate: (s) => {
        const p = s.players[0]; p.deck.unshift(...p.discard.splice(0));
        const w = p.deck.findIndex((id) => s.cards[id].definitionId === 'water'); p.hand.push(p.deck.splice(w, 1)[0]);
      } });
      assert.equal(playable(g, card), kind === 'discardHand', `${effect.effectId} ${kind}`);
    }
  }
});
