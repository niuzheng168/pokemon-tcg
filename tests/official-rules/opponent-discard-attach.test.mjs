// Synthetic definitions only. 「选择对手弃牌区中最多3张能量，以任意方式附着于对手的宝可梦身上。」 (effects.attach, II.C-09; II.D-05) as an
// attack and as 「在自己的回合，当将这张卡牌从手牌使出并进行进化时，可使用1次。…」: the opponent's cards onto the opponent's Pokémon, the user
// choosing; a Pokémon protected from the effect cannot receive them. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();
const prank = { type: null, category: 'any', count: 3, benchOnly: false, optional: false, side: 'opponent' };
const toDiscard = (s, owner, id) => { const card = hand(s, owner, id); s.players[owner].hand.pop(); s.players[owner].discard.push(card); return card; };
const veil = { abilityId: 'fixture:veil', name: '测试防护', mode: 'continuous', usage: null, sourceOfTruth: EVIDENCE,
  effects: [binding('cn.protection@1', { effect: { op: 'protection', channel: 'effects', scope: 'self', from: 'opponent',
    categories: ['attack', 'ability'], useRule: 'ordinary' } }, 'veil')] };
// Two Fire Energy cards in each deck.
const decked = (f) => { f.deck.splice(-2, 2, 'printing:fire', 'printing:fire'); return f; };
const sturdy = (defs) => { for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 500; d.mechanics.weakness = null; d.mechanics.resistance = null; } };

test('schema: the opponent\'s side is cn.attachDiscard@1\'s, without this Pokémon, recipient effects or a bound next part', () => {
  const v = (id, p) => handlers.get(id).validateParameters(clone(p));
  assert(v('cn.attachDiscard@1', prank)); assert(v('cn.attachDiscard@1', { ...prank, benchOnly: true }));
  assert(!v('cn.attachHand@1', prank));
  assert(!v('cn.attachDiscard@1', { ...prank, target: 'self' })); assert(!v('cn.attachDiscard@1', { ...prank, recipientEffect: { heal: 30 } }));
  assert(!v('cn.attachDiscard@1', { ...prank, side: 'own' }));
  assert(!v('cn.attachThenDraw@1', { from: 'discard', attach: prank, draw: 1 }));
  const first = { handlerId: 'cn.cards@1', parameters: { from: 'discard', to: 'bench', selector: { kind: 'pokemon' }, quantity: { kind: 'exact', count: 1 },
    reveal: false, lookTop: null, shuffleAfter: false } };
  const next = { handlerId: 'cn.attachDiscard@1', parameters: prank };
  assert(!v('cn.thenMoved@1', { first, next, use: 'pokemon' }));
  assert(!v('cn.thenMoved@1', { first: next, next: { handlerId: 'cn.heal@1', parameters: { target: 'any', amount: 30 } }, use: 'pokemon' }));
  assert(!v('cn.thenMoved@1', { first: { handlerId: 'cn.discardDeckTop@1', parameters: { side: 'own', count: 3 } }, next, use: 'cards' }));
  assert(v('cn.thenMoved@1', { first: { handlerId: 'cn.discardDeckTop@1', parameters: { side: 'own', count: 1 } }, next: { ...next, parameters: { ...prank, count: 1 } }, use: 'count' }));
});

test('an attack: up to 3 Energy cards of the opponent\'s discard pile, freely onto the opponent\'s Pokémon not protected from it', async () => {
  const f = decked(await fixture((defs) => {
    sturdy(defs); defs[0].mechanics.attacks[0].effects = [binding('cn.attachDiscard@1', prank, 'prank')];
    def(defs, 'other').mechanics.abilities = [veil];
  }));
  let water, fire, double, own, shielded, open;
  const g = board(f, (s) => {
    water = toDiscard(s, 1, 'water'); fire = toDiscard(s, 1, 'fire'); double = toDiscard(s, 1, 'double'); own = toDiscard(s, 0, 'water');
    toDiscard(s, 1, 'potion'); shielded = bench(s, 1, 'other'); open = bench(s, 1, 'base');
    const e = hand(s, 0, 'water'); s.players[0].hand.pop(); s.players[0].active.energy.push(e);
  });
  command(g, { type: 'attack', attackId: 'base:strike' });
  let q = g.snapshot().pending;
  assert.equal(q.kind, 'discard-energy'); assert.equal(q.player, 0);
  assert.deepEqual(q.options, [water, fire, double], 'Only the opponent\'s Energy cards; never the user\'s own.');
  assert.deepEqual([q.minimum, q.maximum], [1, 3]);
  assert(!q.options.includes(own));
  answer(g, [water, double]);
  q = g.snapshot().pending;
  assert.equal(q.kind, 'energy-recipient');
  const foe = g.snapshot().players[1];
  assert.deepEqual(q.options, [foe.active.id, open.id], 'A Pokémon protected from the attack\'s effects cannot receive them.');
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  answer(g, [open.id]); answer(g, [foe.active.id]); settle(g);
  const s = g.snapshot();
  assert.deepEqual(s.players[1].bench.find((m) => m.id === open.id).energy, [water]);
  assert(s.players[1].active.energy.includes(double));
  assert.deepEqual(s.players[1].bench.find((m) => m.id === shielded.id).energy, []);
  assert.deepEqual(s.players[1].discard.filter((id) => s.cards[id].definitionId !== 'potion'), [fire]);
  assert(s.players[0].discard.includes(own));
});

test('「当将这张卡牌从手牌使出并进行进化时，可使用1次」: the evolving user attaches the opponent\'s Energy to the opponent\'s Pokémon', async () => {
  const f = decked(await fixture((defs) => {
    sturdy(defs);
    def(defs, 'evolution').mechanics.abilities = [{ abilityId: 'fixture:jam', name: '测试干扰附着', mode: 'triggered', usage: null, sourceOfTruth: EVIDENCE,
      trigger: { event: 'evolve', origin: 'hand', subject: 'self', turn: 'own', scope: 'global', choiceOwner: 'source', optional: true },
      effects: [binding('cn.attachDiscard@1', prank, 'jam')] }];
  }));
  let card, fire;
  const g = board(f, (s) => { card = hand(s, 0, 'evolution'); fire = toDiscard(s, 1, 'fire'); s.players[0].active.enteredTurn = 1; });
  command(g, g.view(0).legalActions.find((a) => a.type === 'evolve' && a.cardId === card));
  settle(g, (q) => q.options.includes('use') ? ['use'] : q.kind === 'discard-energy' ? [fire] : q.options.slice(0, Math.max(1, q.minimum)));
  const s = g.snapshot();
  assert.deepEqual(s.players[1].active.energy, [fire]);
  assert.deepEqual(s.players[0].active.energy, []);
  // Nothing in the opponent's discard pile: nothing is offered.
  const h = board(f, (s) => { card = hand(s, 0, 'evolution'); s.players[0].active.enteredTurn = 1; });
  command(h, h.view(0).legalActions.find((a) => a.type === 'evolve' && a.cardId === card));
  assert.equal(h.snapshot().pending, null);
});
