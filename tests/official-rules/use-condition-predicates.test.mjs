// Synthetic definitions only. Printed use conditions 「只有在……时才可使用」 (I.B-01/03) and activated-Ability conditions
// read board, zone and history facts at the time the card or Ability could be used. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, assertSupportedDefinition } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, EVIDENCE, board, command, settle, bench, hand, fixtureClock, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const lit = (value) => ({ kind: 'literal', value });
const cmp = (left, relation, right) => ({ kind: 'compare', left, relation, right });
const zone = (side, z) => ({ kind: 'zoneCount', side, zone: z });
const potionCondition = (condition) => (defs) => { defs.find((d) => d.definitionId === 'potion').mechanics.condition = condition; };
const playable = (g, card) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card);
const ability = (condition) => (defs) => {
  defs.find((d) => d.definitionId === 'other').mechanics.abilities = [{ abilityId: 'fixture:conditioned', name: '测试条件特性',
    mode: 'activated', usage: { period: 'turn', scope: 'pokemon', key: 'fixture:conditioned', limit: 1 },
    effects: [binding('cn.draw@1', { count: 1 }, 'conditioned')], sourceOfTruth: EVIDENCE, condition }];
};
const uses = (g) => g.view(0).legalActions.filter((a) => a.type === 'useAbility');
const damaged = (s) => { s.players[0].active.counters = 1; };

test('I.B-01/03: 「只有在自己的手牌只剩这1张时才可使用」 counts the card itself, still in hand', async () => {
  const f = await fixture(potionCondition({ predicate: cmp(zone('own', 'hand'), 'eq', lit(1)) }));
  let card;
  const crowded = board(f, (s) => { card = hand(s, 0, 'potion'); damaged(s); });
  assert(crowded.snapshot().players[0].hand.length > 1);
  assert(!playable(crowded, card));
  const alone = board(f, (s) => {
    card = hand(s, 0, 'potion'); damaged(s);
    const p = s.players[0]; p.deck.push(...p.hand.filter((id) => id !== card)); p.hand = [card];
  });
  assert(playable(alone, card));
  command(alone, { type: 'playTrainer', cardId: card }); settle(alone);
  assert.equal(alone.snapshot().players[0].active.counters, 0);
  OfficialGame.restore(clone(alone.snapshot()), { catalog: f.catalog });
});

test('a printed condition on the opposing Active, and both printed conditions together', async () => {
  const stage1 = { kind: 'pokemonIs', who: 'opponentActive', selector: { kind: 'pokemon', stages: ['stage1'] } };
  const f = await fixture(potionCondition({ prizesRemaining: 'moreThanOpponent', predicate: stage1 }));
  const evolved = (s) => { const p = s.players[1]; p.hand.push(...p.active.stack); p.active = bench(s, 1, 'evolution'); p.bench.pop(); };
  const ahead = (s) => { s.players[1].hand.push(s.players[1].prizes.pop()); };
  let card;
  const cases = [[[evolved, ahead], true], [[evolved], false], [[ahead], false]];
  for (const [mutations, expected] of cases) {
    const g = board(f, (s) => { card = hand(s, 0, 'potion'); damaged(s); mutations.forEach((m) => m(s)); });
    assert.equal(playable(g, card), expected);
  }
});

test('II.E-11 as a Trainer condition: 「上一个对手的回合，自己的宝可梦【昏厥】时才可使用」', async () => {
  const f = await fixture(potionCondition({ predicate: { kind: 'historyFact', fact: 'previousOpponentKnockout', cause: 'any' } }));
  let card, next;
  const g = board(f, (s) => {
    fixtureClock(s, [0, 1, 0, 1]);
    s.players[0].active.counters = 9; next = bench(s, 0, 'base'); next.counters = 1; card = hand(s, 0, 'potion');
    attached(s, 1, s.players[1].active, 'water');
  });
  command(g, { type: 'attack', attackId: 'base:strike' }, 1);
  settle(g, (q) => q.kind === 'promote' ? [next.id] : q.options.slice(0, q.minimum));
  assert.equal(g.snapshot().current, 0);
  assert(playable(g, card));
  const quiet = board(f, (s) => { card = hand(s, 0, 'potion'); damaged(s); });
  assert(!playable(quiet, card));
});

test('an activated Ability\'s board condition joins its other printed conditions', async () => {
  const fewPrizes = cmp(zone('opponent', 'prizes'), 'lte', lit(4));
  const f = await fixture(ability({ predicate: fewPrizes }));
  const taken = (n) => (s) => { for (let i = 0; i < n; i++) s.players[1].hand.push(s.players[1].prizes.pop()); };
  let mon;
  const early = board(f, (s) => { mon = bench(s, 0, 'other'); taken(1)(s); });
  assert.deepEqual(uses(early), []);
  const late = board(f, (s) => { mon = bench(s, 0, 'other'); taken(2)(s); });
  assert.deepEqual(uses(late).map((a) => a.pokemonId), [mon.id]);
  const selfTest = await fixture(ability({ sourceActive: true, predicate: { kind: 'pokemonIs', who: 'self', state: { damaged: true } } }));
  const benched = board(selfTest, (s) => { bench(s, 0, 'other').counters = 1; });
  assert.deepEqual(uses(benched), [], 'Every listed condition must hold.');
  const active = board(selfTest, (s) => {
    const p = s.players[0]; p.hand.push(...p.active.stack); p.active = bench(s, 0, 'other'); p.bench.pop(); p.active.counters = 1;
  });
  assert.equal(uses(active).length, 1);
});

test('load guard: a use condition reads only facts that exist when the card or Ability could be used', async () => {
  const handlers = createCoreHandlers(), catalog = { handler: (id) => handlers.get(id) };
  const f = await fixture();
  const def = (id) => clone(f.definitions.find((d) => d.definitionId === id));
  const trainer = (predicate) => { const d = def('potion'); d.mechanics.condition = { predicate }; return d; };
  const withAbility = (predicate) => { const d = def('other'); ability({ predicate })([d]); return d; };
  const self = { kind: 'pokemonIs', who: 'self', state: { damaged: true } };
  const bad = [
    trainer(self), trainer({ kind: 'exists', who: 'target' }), trainer(cmp({ kind: 'coin', key: 'k', field: 'heads' }, 'gt', lit(0))),
    trainer(cmp({ kind: 'prizes', side: 'own' }, 'gt', lit(0))), trainer({ kind: 'historyFact', fact: 'healed' }),
    trainer(cmp({ kind: 'pokemonCount', side: 'own', zone: 'field', excludeSelf: true }, 'gt', lit(0))),
    withAbility({ kind: 'pokemonIs', who: 'target', state: { damaged: true } }),
    withAbility(cmp({ kind: 'effectCards', effectId: 'e' }, 'gt', lit(0))),
  ];
  for (const d of bad) assert.throws(() => assertSupportedDefinition(catalog, d), (e) => e.code === 'unsupported-condition');
  for (const d of [trainer({ kind: 'not', condition: { kind: 'stadiumInPlay', owner: 'any' } }), withAbility(self),
    withAbility({ kind: 'historyFact', fact: 'movedToActive' })])
    assert.doesNotThrow(() => assertSupportedDefinition(catalog, d));
  await assert.rejects(fixture(potionCondition({})), /definition/i);
});
