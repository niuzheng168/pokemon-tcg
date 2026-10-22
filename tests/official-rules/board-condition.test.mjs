// Synthetic definitions only. 「如果〈条件〉（的话），则A」 and 「如果不是，则B」 for non-damage instructions: judged on the
// board at the moment the instruction is reached, in the printed order. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, assertSupportedDefinition } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { advanceEffectExecution } from '../../public/rules/effect-execution.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const lit = (value) => ({ kind: 'literal', value });
const handlers = createCoreHandlers();
const valid = (id, p) => handlers.get(id).validateParameters(clone(p));
const leaf = (handlerId, parameters) => ({ handlerId, parameters });
const draw = (count) => leaf('cn.draw@1', { count });
const stadium = { kind: 'stadiumInPlay', owner: 'any' };
const statused = { kind: 'pokemonIs', who: 'opponentActive', state: { conditions: ['poisoned'] } };
const playable = (g, card) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card);
const judged = (g) => g.snapshot().events.filter((e) => e.ruleId === 'effects.condition').map((e) => e.data.met);
function putStadium(s, owner) { const id = hand(s, owner, 'stadium'); s.players[owner].hand.pop(); s.stadium = id; }
const sturdy = (defs) => { for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 500; d.mechanics.weakness = null; d.mechanics.resistance = null; } };

test('schemas and rule: a condition, one or several results, the other result', () => {
  assert(requireRule(CN_V20261019, 'effects.condition'));
  for (const p of [{ condition: stadium, effect: draw(3) }, { condition: statused, effects: [draw(1), leaf('cn.condition@1', { side: 'opponent', condition: 'paralyzed' })] },
    { condition: { kind: 'not', condition: stadium }, effect: draw(1), otherwise: draw(2) },
    { condition: { kind: 'compare', left: { kind: 'zoneCount', side: 'own', zone: 'prizes' }, relation: 'lte', right: lit(3) }, effect: draw(2) }])
    assert(valid('cn.when@1', p), JSON.stringify(p));
  for (const p of [{ condition: stadium }, { condition: stadium, effect: draw(1), effects: [draw(1), draw(2)] }, { condition: stadium, effects: [draw(1)] },
    { condition: stadium, effect: draw(0) }, { condition: stadium, effect: draw(1), otherwise: leaf('cn.damage@1', { amount: 10 }) },
    { condition: { kind: 'stadiumInPlay' }, effect: draw(1) }])
    assert(!valid('cn.when@1', p), JSON.stringify(p));
});

test('load guard: only facts that exist when the instruction is reached; a Trainer has no 「这只宝可梦」', async () => {
  const f = await fixture();
  const catalog = { handler: (id) => handlers.get(id) };
  const item = clone(def(f.definitions, 'potion')), mon = clone(def(f.definitions, 'base'));
  const when = (condition) => [binding('cn.when@1', { condition, effect: draw(1) }, 'when')];
  const selfDamaged = { kind: 'pokemonIs', who: 'self', state: { damaged: true } };
  for (const condition of [selfDamaged, { kind: 'historyFact', fact: 'movedToActive' }]) {
    item.mechanics.effects = when(condition);
    assert.throws(() => assertSupportedDefinition(catalog, item), (e) => e.code === 'unsupported-condition');
  }
  for (const condition of [{ kind: 'compare', left: { kind: 'prizes', side: 'own' }, relation: 'gt', right: lit(2) },
    { kind: 'compare', left: { kind: 'coin', key: 'flip', field: 'heads' }, relation: 'gt', right: lit(0) },
    { kind: 'compare', left: { kind: 'pokemon', who: 'target', field: 'damageCounters' }, relation: 'gt', right: lit(0) }]) {
    mon.mechanics.attacks[0].effects = when(condition);
    assert.throws(() => assertSupportedDefinition(catalog, mon), (e) => e.code === 'unsupported-condition', JSON.stringify(condition));
  }
  item.mechanics.effects = when(statused);
  assert.doesNotThrow(() => assertSupportedDefinition(catalog, item));
  mon.mechanics.attacks[0].effects = when(selfDamaged);
  assert.doesNotThrow(() => assertSupportedDefinition(catalog, mon));
});

test('「如果场上有竞技场，则…」 on a Trainer: usable only for a result it could perform; the other result when unmet', async () => {
  const f = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.when@1', { condition: stadium, effect: draw(3) }, 'if')]; });
  let card;
  const none = board(f, (s) => { card = hand(s, 0, 'potion'); });
  assert(!playable(none, card), 'Nothing would change.');
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); putStadium(s, 1); });
  assert(playable(g, card));
  const before = g.snapshot().players[0].hand.length;
  command(g, { type: 'playTrainer', cardId: card }); settle(g);
  assert.equal(g.snapshot().players[0].hand.length, before - 1 + 3);
  assert.deepEqual(judged(g), [true]);
  restore(g, f);
  const either = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.when@1', { condition: stadium, effect: draw(3),
    otherwise: draw(1) }, 'if')]; });
  const h = board(either, (s) => { card = hand(s, 0, 'potion'); });
  assert(playable(h, card));
  const size = h.snapshot().players[0].hand.length;
  command(h, { type: 'playTrainer', cardId: card }); settle(h);
  assert.deepEqual([h.snapshot().players[0].hand.length, judged(h)], [size - 1 + 1, [false]]);
});

test('judged when reached: an earlier instruction of the same attack can make it true; several results in order', async () => {
  const f = await fixture((defs) => { sturdy(defs);
    def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.condition@1', { side: 'opponent', condition: 'poisoned' }, 'poison'),
      binding('cn.when@1', { condition: statused, effects: [leaf('cn.condition@1', { side: 'opponent', condition: 'paralyzed' }), draw(2)] }, 'if')]; });
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); });
  const before = g.snapshot().players[0].hand.length;
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  const foe = g.snapshot().players[1].active.conditions;
  assert.deepEqual([foe.poison !== null, foe.rotation, judged(g)], [true, 'paralyzed', [true]]);
  assert.equal(g.snapshot().players[0].hand.length, before + 2);
  // Reversed printed order: not poisoned yet when judged.
  const late = await fixture((defs) => { sturdy(defs);
    def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.when@1', { condition: statused,
      effect: leaf('cn.condition@1', { side: 'opponent', condition: 'paralyzed' }) }, 'if'),
    binding('cn.condition@1', { side: 'opponent', condition: 'poisoned' }, 'poison')]; });
  const h = board(late, (s) => { attached(s, 0, s.players[0].active, 'water'); });
  command(h, { type: 'attack', attackId: 'base:strike' }); settle(h);
  assert.deepEqual([h.snapshot().players[1].active.conditions.rotation, judged(h)], [null, [false]]);
});

test('an Ability reading 「这只宝可梦」: usable only when met; a choice inside survives restore', async () => {
  const hasFire = { kind: 'compare', left: { kind: 'pokemonSum', field: 'energyCards', who: 'self', energy: { providedTypes: ['Fire'] } },
    relation: 'gt', right: lit(0) };
  const recover = leaf('cn.cards@1', { from: 'discard', to: 'hand', selector: { kind: 'any' }, quantity: { kind: 'upTo', count: 1 },
    reveal: true, lookTop: null, shuffleAfter: false });
  const built = await fixture((defs) => {
    def(defs, 'other').mechanics.abilities = [{ abilityId: 'fixture:kindle', name: '测试余烬', mode: 'activated', sourceOfTruth: EVIDENCE,
      usage: { period: 'turn', scope: 'pokemon', key: 'fixture:kindle', limit: 1 },
      effects: [binding('cn.when@1', { condition: hasFire, effect: recover }, 'kindle')] }];
  });
  const f = { ...built, deck: [...built.deck.slice(0, 59), 'printing:fire'] };
  const usable = (g) => g.view(0).legalActions.some((a) => a.type === 'useAbility' && a.abilityId === 'fixture:kindle');
  let mon, card;
  const discardPotion = (s) => { card = hand(s, 0, 'potion'); s.players[0].hand.pop(); s.players[0].discard.push(card); };
  assert(!usable(board(f, (s) => { mon = bench(s, 0, 'other'); discardPotion(s); })));
  const g = board(f, (s) => { mon = bench(s, 0, 'other'); attached(s, 0, mon, 'fire'); discardPotion(s); });
  assert(usable(g));
  command(g, { type: 'useAbility', pokemonId: mon.id, abilityId: 'fixture:kindle' });
  assert.deepEqual(g.view(0).pending.options, [card]);
  const r = restore(g, f);
  answer(r, [card]); settle(r);
  assert(r.snapshot().players[0].hand.includes(card));
  // A forged other result for a condition with none cannot be restored.
  const forged = clone(g.snapshot());
  const advance = forged.events.findLast((e) => e.ruleId === 'effects.execution' && e.data.mode === 'optional');
  advance.data.mode = 'otherwise';
  assert.throws(() => OfficialGame.restore(forged, { catalog: f.catalog }));
});

test('the execution journal opens otherwise only for a condition with another printed result', () => {
  const step = { op: 'sequence', steps: [{ op: 'draw', count: 1 }] };
  const cursor = (action) => ({ id: 'p', index: 0, step: { action, frames: [] } });
  const advance = (mode) => ({ ruleId: 'effects.execution', visibility: 'private', data: { kind: 'advance', id: 'p', index: 0, mode, performed: true } });
  const when = { op: 'when', condition: stadium, effect: step };
  assert.deepEqual(advanceEffectExecution(cursor(when), advance('optional')).step.action, step);
  assert.deepEqual(advanceEffectExecution(cursor({ ...when, otherwise: step }), advance('otherwise')).step.action, step);
  assert.throws(() => advanceEffectExecution(cursor(when), advance('otherwise')), (e) => e.code === 'invalid-execution-transition');
});
