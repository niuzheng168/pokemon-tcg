// Synthetic definitions only. 「在不看正面的前提下选择对手1张手牌，放于放逐区」「查看对手的手牌，将其中1张卡牌，放于放逐区」
// 「将对手牌库上方的1张卡牌，放于放逐区」 (zones.lost-zone); 「双方玩家可以放于备战区的宝可梦数量，变为4只」「只要这只宝可梦在战斗场上，
// 对手可放于备战区的宝可梦数量就会变为3只」「［关于变更备战宝可梦的数量的效果，优先执行数量更少的效果。］」 (bench.limit);
// 「这只宝可梦身上可以最多放2张「宝可梦道具」。（当这个特性失效时，将其「宝可梦道具」放于弃牌区，直到还剩1张为止。）」 (tools.capacity).
// No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const handlers = createCoreHandlers();
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const ANY = { kind: 'any' };
const withAttack = (effects) => (defs) => {
  for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 500; d.mechanics.weakness = null; d.mechanics.resistance = null; }
  const a = defs[0].mechanics.attacks[0]; a.printedDamage = null; a.effects = effects;
};
const attack = (g) => command(g, { type: 'attack', attackId: 'base:strike' });
const setHand = (s, owner, ids) => { const p = s.players[owner]; p.deck.push(...p.hand); p.hand = []; return ids.map((id) => hand(s, owner, id)); };
const ability = (id, effect) => ({ abilityId: `${id}:passive`, name: '测试特性', mode: 'continuous', usage: null, sourceOfTruth: EVIDENCE, effects: [effect] });
const crowded = async (transform) => {
  const f = await fixture((defs) => { transform(defs); def(defs, 'base').deckLimits.sameName = null; });
  for (let i = 0; i < 14; i++) f.deck[f.deck.lastIndexOf('printing:water')] = 'printing:base';
  return f;
};
const fill = (s, owner, count) => { for (let i = 0; i < count; i++) bench(s, owner, 'base'); };
const lower = (limit, extra = {}) => binding('cn.benchLimit@1', { effect: { op: 'benchLimit', scope: 'all', limit, ...extra } }, `limit-${limit}`);

test('schemas: Lost Zone destinations; lowered and opponent-only Bench limits; a raised Tool capacity', () => {
  const hand = (p) => handlers.get('cn.opponentHand@1').validateParameters(p);
  assert(hand({ mode: 'faceDown', selector: ANY, quantity: { kind: 'exact', count: 1 }, to: 'lost' }));
  assert(hand({ mode: 'look', selector: ANY, quantity: { kind: 'exact', count: 1 }, to: 'lost' }));
  const top = (p) => handlers.get('cn.discardDeckTop@1').validateParameters(p);
  assert(top({ side: 'opponent', count: 1, to: 'lost' })); assert(!top({ side: 'opponent', count: 1, to: 'hand' }));
  assert(!handlers.get('cn.countedDeckTop@1').validateParameters({ side: 'opponent', count: 1, to: 'lost' }));
  const bench = (e) => handlers.get('cn.benchLimit@1').validateParameters({ effect: { op: 'benchLimit', ...e } });
  assert(bench({ scope: 'all', limit: 4 })); assert(bench({ scope: 'opponent', limit: 3, sourceActive: true }));
  assert(!bench({ scope: 'all', limit: 2 })); assert(!bench({ scope: 'self', limit: 4 })); assert(!bench({ scope: 'all', limit: 5 }));
  const cap = (e) => handlers.get('cn.toolCapacity@1').validateParameters({ effect: { op: 'toolCapacity', scope: 'self', ...e } });
  assert(cap({ count: 2 })); assert(cap({ count: 4 })); assert(!cap({ count: 1 })); assert(!cap({ count: 5 }));
  assert(!handlers.get('cn.toolCapacity@1').validateParameters({ effect: { op: 'toolCapacity', scope: 'own', count: 2 } }));
  const rack = { op: 'toolCapacity', scope: 'self', count: 2 };
  assert.deepEqual(handlers.get('cn.toolCapacity@1').execute({}, { effect: rack }), [rack]);
});

test('「…放于放逐区」: a face-down hand pick, a looked-at hand card and the top card of the deck go to the owner\'s Lost Zone', async () => {
  for (const mode of ['faceDown', 'look']) {
    const f = await fixture(withAttack([binding('cn.opponentHand@1', { mode, selector: ANY, quantity: { kind: 'exact', count: 1 }, to: 'lost' }, 'banish')]));
    let theirs;
    const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); theirs = setHand(s, 1, ['research', 'potion']); });
    attack(g); settle(g);
    const s = g.snapshot();
    assert.equal(theirs.filter((id) => s.players[1].lost.includes(id)).length, 1, mode);
    assert.equal(theirs.filter((id) => s.players[1].discard.includes(id)).length, 0);
    assert.deepEqual(restore(g, f).snapshot(), s);
  }
  const f = await fixture(withAttack([binding('cn.discardDeckTop@1', { side: 'opponent', count: 1, to: 'lost' }, 'mill')]));
  let top;
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); top = s.players[1].deck.at(-1); });
  attack(g); settle(g);
  const s = g.snapshot();
  assert.deepEqual(s.players[1].lost, [top]); assert(!s.players[1].discard.includes(top));
  assert(s.events.some((e) => e.ruleId === 'effects.deck-top-discard' && e.data.to === 'lost'));
});

test('「双方玩家…变为4只」: playing the Stadium makes both players discard down to 4, its holder first', async () => {
  const f = await crowded((defs) => { def(defs, 'stadium').mechanics.effects = [lower(4)]; });
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'stadium'); fill(s, 0, 5); fill(s, 1, 5); });
  command(g, { type: 'playTrainer', cardId: card });
  let q = g.snapshot().pending;
  assert.equal(q.kind, 'bench-trim'); assert.equal(q.player, 0); assert.equal(q.minimum, 1);
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  answer(g, [q.options[0]]);
  q = g.snapshot().pending;
  assert.equal(q.kind, 'bench-trim'); assert.equal(q.player, 1);
  answer(g, [q.options[0]]); settle(g);
  const s = g.snapshot();
  assert.deepEqual(s.players.map((p) => p.bench.length), [4, 4]);
  assert(!g.view(0).legalActions.some((a) => a.type === 'bench'), 'No room at 4.');
  // The holder's new lowering Stadium replaces the opponent's: still the new holder first.
  const h = board(f, (s) => { card = hand(s, 0, 'stadium'); const old = hand(s, 1, 'stadium'); s.players[1].hand.pop(); s.stadium = old;
    fill(s, 0, 5); fill(s, 1, 5); });
  assert.equal(h.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card), false, 'Same-name Stadium.');
});

test('「只要这只宝可梦在战斗场上，对手…变为3只」 while Active only; the smaller of two changed limits wins', async () => {
  const f = await crowded((defs) => {
    def(defs, 'other').mechanics.abilities = [ability('other', lower(3, { scope: 'opponent', sourceActive: true }))];
    def(defs, 'stadium').mechanics.effects = [lower(8)];
  });
  const active = (s) => { const p = s.players[0]; p.hand.push(...p.active.stack); p.active.stack = [hand(s, 0, 'other')]; p.hand.pop(); };
  let g = board(f, (s) => { active(s); fill(s, 1, 4); });
  assert.deepEqual([0, 1].map((p) => g.view(0).players[p].benchLimit), [5, 3]);
  command(g, { type: 'endTurn' });
  let q = g.snapshot().pending;
  assert.equal(q.kind, 'bench-trim'); assert.equal(q.player, 1);
  answer(g, [q.options[0]]); settle(g);
  assert.equal(g.snapshot().players[1].bench.length, 3);
  // On the Bench it does nothing.
  g = board(f, (s) => { bench(s, 0, 'other'); fill(s, 1, 4); });
  assert.deepEqual([0, 1].map((p) => g.view(0).players[p].benchLimit), [5, 5]);
  // With an eight-Pokémon Stadium in play: 8 for its holder, 3 for the player the Ability names.
  g = board(f, (s) => { active(s); const id = hand(s, 0, 'stadium'); s.players[0].hand.pop(); s.stadium = id; });
  assert.deepEqual([0, 1].map((p) => g.view(0).players[p].benchLimit), [8, 3]);
});

test('「这只宝可梦身上可以最多放2张「宝可梦道具」」: a second Tool; when the Ability stops, its owner keeps one', async () => {
  const f = await fixture((defs) => {
    def(defs, 'base').mechanics.abilities = [ability('base', binding('cn.toolCapacity@1', { effect: { op: 'toolCapacity', scope: 'self', count: 2 } }, 'rack'))];
    def(defs, 'stadium').mechanics.effects = [binding('cn.suppression@1', { effect: { op: 'suppression', channel: 'abilities', scope: 'all' } }, 'quiet')];
  });
  let tool, hp, stadium;
  const g = board(f, (s) => { tool = hand(s, 0, 'tool'); hp = hand(s, 0, 'hp-tool'); stadium = hand(s, 0, 'stadium'); });
  const me = () => g.snapshot().players[0];
  for (const id of [tool, hp]) {
    command(g, { type: 'playTrainer', cardId: id });
    assert.deepEqual(g.snapshot().pending.options, [me().active.id]);
    answer(g, [me().active.id]); settle(g);
  }
  assert.deepEqual(me().active.tools, [tool, hp]);
  command(g, { type: 'playTrainer', cardId: stadium });
  const q = g.snapshot().pending;
  assert.equal(q.kind, 'tool-trim'); assert.equal(q.player, 0); assert.deepEqual(q.options, [tool, hp]); assert.equal(q.minimum, 1);
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  answer(g, [tool]); settle(g);
  assert.deepEqual(me().active.tools, [hp]); assert(me().discard.includes(tool));
  assert(g.snapshot().events.some((e) => e.ruleId === 'tools.capacity' && e.data.discarded[0] === tool));
  // Without the Ability, one Tool is the limit.
  const plain = await fixture();
  const h = board(plain, (s) => { const t = hand(s, 0, 'tool'); s.players[0].hand.pop(); s.players[0].active.tools.push(t); hp = hand(s, 0, 'hp-tool'); });
  assert(!h.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === hp));
});
