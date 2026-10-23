// Synthetic definitions only. 「将最多2张自己的手牌放于弃牌区，从自己的牌库上方抽取其张数×2张卡牌」 and 「将自己牌库上方3张卡牌放于弃牌区，
// 将其中所有能量，附着于这只宝可梦身上」 (effects.moved-cards, II.D-02 文例1, II.E-19): the next part reads the cards the first part
// actually moved. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { completeEffectStep, completionNeedsMoved, bindMovedEffect } from '../../public/rules/effects.js';
import { advanceEffectExecution } from '../../public/rules/effect-execution.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const handlers = createCoreHandlers();
const valid = (p) => handlers.get('cn.thenMoved@1').validateParameters(clone(p));
const cards = (parameters) => ({ handlerId: 'cn.cards@1', parameters: { reveal: false, lookTop: null, shuffleAfter: false, ...parameters } });
const discardHand = cards({ from: 'hand', to: 'discard', selector: { kind: 'any' }, quantity: { kind: 'upTo', count: 2 } });
const draw = { handlerId: 'cn.draw@1', parameters: { count: 2 } };
const mill = { handlerId: 'cn.discardDeckTop@1', parameters: { side: 'own', count: 3 } };
const attachThose = { handlerId: 'cn.attachDiscard@1', parameters: { type: null, category: 'any', count: 3, exact: true,
  benchOnly: false, optional: false, target: 'self' } };

test('「其张数」「其中的…」: schema', () => {
  assert(valid({ first: discardHand, next: draw, use: 'count' }));
  assert(valid({ first: mill, next: attachThose, use: 'cards' }));
  assert(valid({ first: discardHand, next: cards({ from: 'deck', to: 'hand', selector: { kind: 'pokemon' }, quantity: { kind: 'upTo', count: 1 },
    shuffleAfter: true }), use: 'count' }));
  assert(valid({ first: mill, next: cards({ from: 'discard', to: 'hand', selector: { kind: 'trainer', categories: ['item'] },
    quantity: { kind: 'all' } }), use: 'cards' }));
  assert(valid({ first: { handlerId: 'cn.attachedEnergy@1', parameters: { op: 'discardEnergy', side: 'own', from: 'self',
    selector: { kind: 'energy', category: 'basic', types: ['Fire'] }, providedTypes: null, measure: 'cards', quantity: { kind: 'all' }, chooser: 'source' } },
  next: { handlerId: 'cn.discardDeckTop@1', parameters: { side: 'opponent', count: 1 } }, use: 'count' }));
  assert(handlers.get('cn.attachHand@1').validateParameters({ type: null, types: ['Psychic', 'Metal'], count: 1, benchOnly: false, optional: false }));
  const energy = (op, side, extra = {}) => ({ handlerId: 'cn.attachedEnergy@1', parameters: { op, side, from: 'self', selector: { kind: 'energy' },
    providedTypes: null, measure: 'cards', quantity: { kind: 'all' }, chooser: 'source', ...extra } });
  const attachBack = { handlerId: 'cn.attachHand@1', parameters: { type: null, category: 'any', count: 2, exact: true, benchOnly: true, optional: false } };
  assert(valid({ first: energy('returnEnergy', 'own', { to: 'hand' }), next: attachBack, use: 'cards' }));
  assert(valid({ first: energy('discardEnergy', 'own'), next: attachThose, use: 'cards' }));
  for (const bad of [
    { first: energy('returnEnergy', 'own', { to: 'deckShuffle' }), next: attachBack, use: 'cards' },
    { first: energy('discardEnergy', 'opponent'), next: attachThose, use: 'cards' },
    { first: energy('moveEnergy', 'own', { recipient: { position: 'bench', selector: { kind: 'pokemon' } }, distribution: 'singleRecipient' }), next: draw, use: 'count' },
  ]) assert(!valid(bad), JSON.stringify(bad));
  for (const bad of [
    { first: draw, next: draw, use: 'count' }, // nothing moved
    { first: discardHand, next: { handlerId: 'cn.cure@1', parameters: { side: 'own', target: 'active' } }, use: 'count' }, // no count
    { first: mill, next: cards({ from: 'hand', to: 'discard', selector: { kind: 'any' }, quantity: { kind: 'all' } }), use: 'cards' }, // other zone
    { first: mill, next: { ...attachThose, handlerId: 'cn.attachHand@1' }, use: 'cards' },
    { first: { handlerId: 'cn.discardDeckTop@1', parameters: { side: 'opponent', count: 3 } }, next: attachThose, use: 'cards' }, // not the user's
    { first: cards({ from: 'deck', to: 'hand', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 1 }, lookTop: 3, remainder: 'discard' }),
      next: draw, use: 'count' },
    { first: discardHand, next: draw, use: 'count', among: 'moved' },
    { first: discardHand, next: cards({ from: 'discard', to: 'hand', selector: { kind: 'any' }, quantity: { kind: 'all' }, among: 'moved' }), use: 'cards' },
  ]) assert(!valid(bad), JSON.stringify(bad));
});

test('the step machine binds the next part only to an actual move', () => {
  const step = { action: { op: 'draw', count: 1 }, frames: [{ kind: 'thenMoved', next: { op: 'draw', count: 2 }, use: 'count', path: 'count' }] };
  assert(completionNeedsMoved(step));
  assert.deepEqual(completeEffectStep(step, true, ['a', 'b']).action, { op: 'draw', count: 4 });
  assert.equal(completeEffectStep(step, true, []), null, 'Nothing moved: no next part.');
  assert.equal(completeEffectStep(step, false, []), null);
  assert.throws(() => completeEffectStep(step, true), /moved/);
  assert.throws(() => completeEffectStep(step, true, ['a', 'a']), /moved/);
  assert.throws(() => completeEffectStep({ action: step.action, frames: [] }, true, ['a']), /moved/);
  const pool = { kind: 'thenMoved', next: { op: 'attachDiscard', type: null, count: 1, benchOnly: false, optional: false, among: 'moved' }, use: 'cards' };
  assert.deepEqual(bindMovedEffect(pool, ['x']).among, ['x']);
  assert.throws(() => bindMovedEffect({ ...pool, next: { ...pool.next, among: ['y'] } }, ['x']), /unbound/);
  assert.throws(() => bindMovedEffect({ kind: 'thenMoved', next: { op: 'cure' }, use: 'count', path: 'count' }, ['x']), /count/);
  assert.equal(completionNeedsMoved({ action: step.action, frames: [step.frames[0], { kind: 'sequence', remaining: [{ op: 'draw', count: 1 }], performed: false }] }), false);
  const cursor = { id: 'program1', index: 0, step };
  assert.deepEqual(advanceEffectExecution(cursor, { ruleId: 'effects.execution', visibility: 'private',
    data: { kind: 'advance', id: 'program1', index: 0, mode: 'complete', performed: true, moved: ['a'] } }).step.action, { op: 'draw', count: 2 });
  assert.throws(() => advanceEffectExecution(cursor, { ruleId: 'effects.execution', visibility: 'private',
    data: { kind: 'advance', id: 'program1', index: 0, mode: 'expand', performed: null, moved: ['a'] } }));
});

test('「将最多2张手牌放于弃牌区，抽取其张数×2张」', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.thenMoved@1', { first: discardHand, next: draw, use: 'count' }, 'trade')];
  });
  const run = (picked) => {
    let card;
    const g = board(f, (s) => { card = hand(s, 0, 'potion'); hand(s, 0, 'research'); hand(s, 0, 'tool'); });
    const before = g.snapshot().players[0].hand.length;
    command(g, { type: 'playTrainer', cardId: card });
    const q = g.snapshot().pending;
    assert.deepEqual(OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog }).view(0), g.view(0));
    answer(g, q.options.slice(0, picked)); settle(g);
    const s = g.snapshot();
    assert.deepEqual(OfficialGame.restore(clone(s), { catalog: f.catalog }).snapshot(), s);
    return s.players[0].hand.length - (before - 1 - picked);
  };
  assert.equal(run(2), 4);
  assert.equal(run(1), 2);
  const any = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.thenMoved@1', { first: { ...discardHand,
      parameters: { ...discardHand.parameters, quantity: { kind: 'any' } } }, next: { handlerId: 'cn.draw@1', parameters: { count: 1 } }, use: 'count' }, 'trade')];
  });
  let card;
  const g = board(any, (s) => { card = hand(s, 0, 'potion'); hand(s, 0, 'research'); });
  const before = g.snapshot().players[0].hand.length;
  command(g, { type: 'playTrainer', cardId: card }); answer(g, []); settle(g);
  assert.equal(g.snapshot().players[0].hand.length, before - 1, '「任意数量」 none discarded: nothing drawn.');
});

test('「将牌库上方3张卡牌放于弃牌区，将其中所有能量，附着于这只宝可梦身上」', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'base').mechanics.attacks.push({ attackId: 'base:mill', name: '测试磨牌', cost: [],
      printedDamage: null, effects: [binding('cn.thenMoved@1', { first: mill, next: attachThose, use: 'cards' }, 'mill')], sourceOfTruth: EVIDENCE });
  });
  let old;
  const g = board(f, (s) => {
    const p = s.players[0];
    // Top of the deck: water, potion, water; an older Energy already in the discard pile stays there.
    old = p.deck.find((id) => s.cards[id].definitionId === 'water');
    p.deck.splice(p.deck.indexOf(old), 1); p.discard.push(old);
    const top = ['water', 'potion', 'water'].map((id) => { const i = p.deck.findLastIndex((c) => s.cards[c].definitionId === id); return p.deck.splice(i, 1)[0]; });
    p.deck.push(...top);
    bench(s, 0, 'other');
  });
  const top = g.snapshot().players[0].deck.slice(-3);
  command(g, { type: 'attack', attackId: 'base:mill' }); settle(g, (q) => q.options.slice(0, q.maximum));
  const s = g.snapshot(), active = s.players[0].active;
  const energies = top.filter((id) => s.cards[id].definitionId === 'water');
  assert.deepEqual([...active.energy].sort(), [...energies].sort());
  assert(s.players[0].discard.includes(old), 'Only the cards this attack put there.');
  assert(s.events.some((e) => e.ruleId === 'effects.execution' && e.data.mode === 'complete' && e.data.moved?.length === 3));
  assert.deepEqual(OfficialGame.restore(clone(s), { catalog: f.catalog }).snapshot(), s);
});
