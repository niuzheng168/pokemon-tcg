// Synthetic definitions only. 「选择自己弃牌区中的1张【水】宝可梦，放于备战区。然后，…附着于该宝可梦身上」「回复自己1只宝可梦「60」HP。然后，
// 选择回复了HP的宝可梦身上附着的1个能量，放于弃牌区」「…放于备战区。若希望，可将该宝可梦与战斗宝可梦互换」「…转附于对手其他宝可梦身上。然后，在获得能量
// 的宝可梦身上放置3个伤害指示物」: a thenMoved with use pokemon binds its next part to the Pokémon the first part affected (II.E-19).
// No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { bindMovedEffect, completionMovedUse, expandEffectStep, completeEffectStep } from '../../public/rules/effects.js';
import { advanceEffectExecution } from '../../public/rules/effect-execution.js';
import { fixture, binding, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();
const valid = (p) => handlers.get('cn.thenMoved@1').validateParameters(clone(p));
const cards = (parameters) => ({ handlerId: 'cn.cards@1', parameters: { reveal: false, lookTop: null, shuffleAfter: false, ...parameters } });
const recover = cards({ from: 'discard', to: 'bench', selector: { kind: 'pokemon', types: ['Water'] }, quantity: { kind: 'exact', count: 1 } });
const call = cards({ from: 'deck', to: 'bench', selector: { kind: 'pokemon', stages: ['basic'] }, quantity: { kind: 'exact', count: 1 }, shuffleAfter: true });
const attachThree = { handlerId: 'cn.attachDiscard@1', parameters: { type: 'Water', count: 3, benchOnly: false, optional: false } };
const heal = { handlerId: 'cn.heal@1', parameters: { target: 'any', amount: 60 } };
const energy = (extra) => ({ handlerId: 'cn.attachedEnergy@1', parameters: { side: 'own', from: 'any', selector: { kind: 'energy' }, providedTypes: null,
  measure: 'cards', quantity: { kind: 'exact', count: 1 }, chooser: 'source', ...extra } });
const swap = (side) => ({ handlerId: 'cn.switch@1', parameters: { side, chooser: 'self', affected: side === 'own' ? 'active' : 'selected' } });
const play = (f, card, mutate) => {
  let id;
  const g = board(f, (s) => { id = hand(s, 0, card); mutate(s); });
  command(g, { type: 'playTrainer', cardId: id });
  return g;
};

test('schema: which first parts report Pokémon and which next parts can act on them', () => {
  assert(valid({ first: recover, next: attachThree, use: 'pokemon' }));
  assert(valid({ first: heal, next: energy({ op: 'discardEnergy' }), use: 'pokemon' }));
  assert(valid({ first: call, next: swap('own'), use: 'pokemon', optional: true }));
  for (const bad of [{ first: { handlerId: 'cn.draw@1', parameters: { count: 1 } }, next: attachThree, use: 'pokemon' },
    { first: recover, next: { handlerId: 'cn.draw@1', parameters: { count: 1 } }, use: 'pokemon' },
    { first: cards({ from: 'discard', to: 'hand', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 1 } }), next: attachThree, use: 'pokemon' },
    { first: energy({ op: 'discardEnergy' }), next: attachThree, use: 'pokemon' },
    { first: { handlerId: 'cn.cards@1', parameters: { ...call.parameters } }, next: { handlerId: 'cn.draw@1', parameters: { count: 1 } }, use: 'count', optional: true }])
    assert(!valid(bad), JSON.stringify(bad));
});

test('the step machine: a bound next part, transparent to completion, optional when printed', () => {
  const frame = { kind: 'thenMoved', next: { op: 'heal', side: 'own', target: 'any', count: 2 }, use: 'pokemon' };
  assert.deepEqual(bindMovedEffect(frame, ['m1']), { op: 'bound', pokemon: ['m1'], effect: frame.next });
  assert.equal(bindMovedEffect({ ...frame, optional: true }, ['m1']).op, 'optional');
  const step = { action: { op: 'bound', pokemon: ['m1'], effect: { op: 'draw', count: 1 } }, frames: [] };
  const inner = expandEffectStep(step);
  assert.deepEqual(inner.frames.at(-1), { kind: 'bound', pokemon: ['m1'] });
  assert.equal(completionMovedUse(inner), null);
  assert.equal(completionMovedUse({ action: { op: 'draw', count: 1 }, frames: [{ kind: 'thenMoved', ...frame }, { kind: 'bound', pokemon: ['m1'] }] }), 'pokemon');
  assert.equal(completeEffectStep(inner, true), null);
  assert.deepEqual(advanceEffectExecution({ id: 'program1', index: 0, step }, { ruleId: 'effects.execution', visibility: 'private',
    data: { kind: 'advance', id: 'program1', index: 0, mode: 'expand', performed: null } }).step, inner);
});

test('「放于备战区。然后，选择…最多3张【水】能量，附着于该宝可梦身上」 and 「回复…HP。然后，选择回复了HP的宝可梦身上附着的1个能量，放于弃牌区」', async () => {
  const f = await fixture((defs) => {
    def(defs, 'potion').mechanics.effects = [binding('cn.thenMoved@1', { first: recover, next: attachThree, use: 'pokemon' }, 'revive')];
    def(defs, 'poison').mechanics.effects = [binding('cn.thenMoved@1', { first: heal, next: energy({ op: 'discardEnergy' }), use: 'pokemon' }, 'mend')];
  });
  let waters, other;
  const g = play(f, 'potion', (s) => {
    const p = s.players[0];
    other = bench(s, 0, 'other');
    for (const id of ['other', 'water', 'water', 'water']) { const c = hand(s, 0, id); p.hand.pop(); p.discard.push(c); }
    waters = p.discard.filter((id) => s.cards[id].definitionId === 'water');
  });
  settle(g, (q) => q.kind === 'discard-energy' ? q.options.slice(0, 3) : q.options.slice(0, Math.max(1, q.minimum)));
  let s = g.snapshot();
  const fresh = s.players[0].bench.find((m) => m.id !== other.id);
  assert.deepEqual([...fresh.energy].sort(), waters.slice(0, 3).sort(), 'All three on the Pokémon just put onto the Bench.');
  assert.equal(s.players[0].bench.find((m) => m.id === other.id).energy.length, 0);
  assert.deepEqual(restore(g, f).snapshot(), s);
  let mine, spare;
  const h = play(f, 'poison', (s) => {
    s.players[0].active.counters = 3; mine = attached(s, 0, s.players[0].active, 'water');
    spare = attached(s, 0, bench(s, 0, 'other'), 'water');
  });
  const q = h.snapshot().pending;
  assert.deepEqual(q.options, [h.snapshot().players[0].active.id], 'Only the damaged Pokémon can be healed.');
  answer(h, q.options);
  assert.deepEqual(h.snapshot().pending.options, [mine], 'Only Energy on the healed Pokémon.');
  settle(h, (q) => q.options.slice(0, Math.max(1, q.minimum)));
  s = h.snapshot();
  assert(s.players[0].discard.includes(mine) && s.players[0].bench[0].energy.includes(spare));
  assert.equal(s.players[0].active.counters, 0);
});

test('「若希望，可将该宝可梦与战斗宝可梦互换」, the opponent\'s new Benched Pokémon, and the Pokémon that received Energy', async () => {
  const f = await fixture((defs) => {
    def(defs, 'potion').mechanics.effects = [binding('cn.thenMoved@1', { first: call, next: swap('own'), use: 'pokemon', optional: true }, 'call')];
    def(defs, 'poison').mechanics.effects = [binding('cn.thenMoved@1', { first: { handlerId: 'cn.opponentHand@1', parameters: { mode: 'look',
      selector: { kind: 'pokemon', stages: ['basic'] }, quantity: { kind: 'exact', count: 1 }, to: 'bench' } }, next: swap('opponent'), use: 'pokemon' }, 'lure')];
    def(defs, 'research').mechanics.effects = [binding('cn.thenMoved@1', { first: energy({ op: 'moveEnergy', side: 'opponent',
      recipient: { position: 'any', selector: { kind: 'pokemon' } }, distribution: 'singleRecipient' }),
    next: { handlerId: 'cn.counters@1', parameters: { side: 'opponent', target: 'any', count: 3 } }, use: 'pokemon' }, 'shift')];
  });
  for (const perform of [true, false]) {
    let resident;
    const g = play(f, 'potion', (s) => { resident = bench(s, 0, 'other'); });
    const active = g.snapshot().players[0].active.id;
    settle(g, (q) => q.kind === 'optional-effect' ? [perform ? 'perform' : 'skip'] : q.options.slice(0, Math.max(1, q.minimum)));
    const s = g.snapshot(), fresh = [s.players[0].active, ...s.players[0].bench].find((m) => m.id !== active && m.id !== resident.id);
    assert.equal(s.players[0].active.id === fresh.id, perform, `perform ${perform}`);
    assert(s.players[0].active.id !== resident.id, 'Never the other Benched Pokémon.');
  }
  let theirs;
  const g = play(f, 'poison', (s) => { theirs = hand(s, 1, 'other'); bench(s, 1, 'base'); });
  settle(g, (q) => q.options.includes(theirs) ? [theirs] : q.options.slice(0, Math.max(1, q.minimum)));
  assert.deepEqual(g.snapshot().players[1].active.stack, [theirs], 'The Pokémon just put onto their Bench is switched in.');
  let from, to, unrelated;
  const k = play(f, 'research', (s) => {
    from = attached(s, 1, s.players[1].active, 'water'); to = bench(s, 1, 'other'); unrelated = bench(s, 1, 'other');
  });
  settle(k, (q) => q.kind === 'energy-destination' ? [to.id] : q.options.slice(0, Math.max(1, q.minimum)));
  const s = k.snapshot(), recipient = s.players[1].bench.find((m) => m.id === to.id);
  assert(recipient.energy.includes(from));
  assert.deepEqual([recipient.counters, s.players[1].bench.find((m) => m.id === unrelated.id).counters, s.players[1].active.counters], [3, 0, 0]);
  assert.deepEqual(restore(k, f).snapshot(), s);
});
