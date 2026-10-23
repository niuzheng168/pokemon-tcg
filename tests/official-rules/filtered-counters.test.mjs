// Synthetic definitions only. 「给身上放置有伤害指示物的对手所有的宝可梦身上，各放置2个伤害指示物」 and 「只要这只宝可梦在场上，每当宝可梦检查时，
// 给双方所有拥有特性的宝可梦（除「X」外）身上，各放置1个伤害指示物」: counters on every Pokémon of a printed kind or state, and a checkup trigger
// filtered by the event Pokémon. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, EVIDENCE, board, command, settle, bench, hand, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const valid = (p) => createCoreHandlers().get('cn.counters@1').validateParameters(clone(p));

test('「所有…各放置」 with a kind or state: schema', () => {
  assert(valid({ side: 'opponent', target: 'any', count: 2, all: true, targetState: { damaged: true } }));
  assert(valid({ side: 'opponent', target: 'bench', count: 1, targets: 2, targetSelector: { kind: 'pokemon', stages: ['basic'] } }));
  for (const bad of [{ side: 'opponent', target: 'self', count: 2, all: true }, { side: 'opponent', target: 'any', count: 2, all: true, targets: 2 },
    { side: 'opponent', target: 'event', count: 1, targetState: { damaged: true } }]) assert(!valid(bad), JSON.stringify(bad));
});

test('every damaged opponent Pokémon gets counters; none is chosen', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.counters@1',
      { side: 'opponent', target: 'any', count: 2, all: true, targetState: { damaged: true } }, 'all')];
  });
  let card, hurt, fresh;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); hurt = bench(s, 1, 'other'); hurt.counters = 1; fresh = bench(s, 1, 'base'); });
  assert(!board(f, (s) => { card = hand(s, 0, 'potion'); bench(s, 1, 'other'); }).view(0).legalActions
    .some((a) => a.type === 'playTrainer' && a.cardId === card), 'No damaged Pokémon: nothing to do.');
  command(g, { type: 'playTrainer', cardId: card });
  assert.equal(g.snapshot().pending, null);
  const s = g.snapshot();
  assert.equal(s.players[1].bench.find((m) => m.id === hurt.id).counters, 3);
  assert.equal(s.players[1].bench.find((m) => m.id === fresh.id).counters, 0);
  assert.equal(s.players[1].active.counters, 0);
});

test('a checkup trigger on every Pokémon with an Ability, except one name, on both sides', async () => {
  const ability = (id) => ({ abilityId: `fixture:${id}`, name: '测试特性', mode: 'activated',
    usage: { period: 'turn', scope: 'pokemon', key: `fixture:${id}`, limit: 1 }, sourceOfTruth: EVIDENCE,
    effects: [binding('cn.draw@1', { count: 1 }, `${id}-draw`)] });
  const trigger = { event: 'checkup', subject: 'all', optional: false, choiceOwner: 'source', scope: 'subject',
    subjectState: { hasAbility: true }, subjectSelector: { kind: 'pokemon', excludeNameKeys: ['base'] } };
  const energized = { ...trigger, subjectState: { energy: { selector: { kind: 'energy', category: 'basic' } } }, subjectSelector: undefined };
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'base').mechanics.abilities = [ability('base')];
    defs.find((d) => d.definitionId === 'evolution').mechanics.abilities = [ability('evo')];
    defs.find((d) => d.definitionId === 'other').mechanics.abilities = [{ abilityId: 'fixture:snow', name: '测试', mode: 'triggered', usage: null,
      trigger, sourceOfTruth: EVIDENCE, effects: [binding('cn.counters@1', { side: 'event', target: 'event', count: 1 }, 'both')] }];
  });
  assert(!createCoreHandlers().get('cn.counters@1').validateParameters({ side: 'event', target: 'any', count: 1 }));
  let mine, theirs;
  const g = board(f, (s) => { mine = bench(s, 0, 'other'); theirs = bench(s, 1, 'evolution'); });
  command(g, { type: 'endTurn' }); settle(g);
  const s = g.snapshot();
  assert.deepEqual(OfficialGame.restore(clone(s), { catalog: f.catalog }).snapshot(), s);
  const at = (owner, id) => [s.players[owner].active, ...s.players[owner].bench].find((m) => m.id === id).counters;
  assert.equal(s.players[0].active.counters, 0, 'The excluded name (an Ability, but excluded) gets none.');
  assert.equal(at(0, mine.id), 1, 'The Ability holder itself has an Ability.');
  assert.equal(at(1, theirs.id), 1, "The opponent's Pokémon with an Ability.");
  // 「身上附有基本能量的宝可梦」 as the trigger's and the counters' filter.
  const g2 = board(await fixture((defs) => {
    defs.find((d) => d.definitionId === 'other').mechanics.abilities = [{ abilityId: 'fixture:snow', name: '测试', mode: 'triggered', usage: null,
      trigger: JSON.parse(JSON.stringify(energized)), sourceOfTruth: EVIDENCE, effects: [binding('cn.counters@1', { side: 'event', target: 'event', count: 1 }, 'both')] }];
    // Inside a condition, the leaf's own usability check reads the same filter.
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('cn.when@1', { condition: { kind: 'stadiumInPlay', owner: 'any' },
      otherwise: { handlerId: 'cn.counters@1', parameters: { side: 'opponent', target: 'any', count: 1, all: true,
        targetState: { energy: { selector: { kind: 'energy', category: 'basic' } } } } },
      effect: { handlerId: 'cn.draw@1', parameters: { count: 1 } } }, 'all')];
  }), (s) => { mine = bench(s, 0, 'other'); attached(s, 1, s.players[1].active, 'water'); hand(s, 0, 'potion'); });
  const potion = g2.snapshot().players[0].hand.find((id) => g2.snapshot().cards[id].definitionId === 'potion');
  command(g2, { type: 'playTrainer', cardId: potion }); settle(g2);
  command(g2, { type: 'endTurn' }); settle(g2);
  const s2 = g2.snapshot();
  assert.equal(s2.players[1].active.counters, 2, 'The Item, then the checkup.'); assert.equal(s2.players[0].active.counters, 0);
});
