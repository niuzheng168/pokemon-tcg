// Synthetic definitions only. 「选择自己手牌中的1张基本能量，附着于备战宝可梦身上。然后，回复被附着能量的宝可梦的全部HP」 (cn.healPokemon@1 as a
// thenMoved next part); 「选择对手的1只身上放置有6个伤害指示物的宝可梦，令那只宝可梦【昏厥】」 (TargetState damageCounters); a choice of
// nine options 「从【草】【火】…【龙】中选择1种属性」; 「当这只宝可梦从战斗场被放回备战区时」 (trigger.moved-to-bench) with an inherit from
// the deck; 「这张卡牌，只有通过…的特性…的效果才能被放于场上」 (pokemon.enter-only-by). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, EVIDENCE, board, command, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const handlers = createCoreHandlers();
const def = (defs, id) => defs.find((d) => d.definitionId === id);

test('「…附着于备战宝可梦身上。然后，回复被附着能量的宝可梦的全部HP」: only the Pokémon that got the Energy', async () => {
  const attach = { handlerId: 'cn.attachHand@1', parameters: { type: 'Water', count: 1, benchOnly: true, optional: false } };
  const heal = { handlerId: 'cn.healPokemon@1', parameters: { op: 'healPokemon', side: 'own', target: 'any', selector: { kind: 'pokemon' },
    selection: { kind: 'all' }, amount: 'all', discardHealedEnergy: false } };
  const mend = { first: attach, next: heal, use: 'pokemon' };
  assert(handlers.get('cn.thenMoved@1').validateParameters(clone(mend)));
  const f = await fixture((defs) => { def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.thenMoved@1', mend, 'leaf')]; });
  let a, b;
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water'); hand(s, 0, 'water');
    s.players[0].active.counters = 2; a = bench(s, 0, 'other'); b = bench(s, 0, 'other'); a.counters = 5; b.counters = 4;
  });
  command(g, { type: 'attack', attackId: 'base:strike' });
  settle(g, (q) => q.options.includes(a.id) ? [a.id] : q.options.slice(0, Math.max(1, q.minimum)));
  const s = g.snapshot(), counters = (m) => s.players[0].bench.find((x) => x.id === m.id).counters;
  assert.deepEqual([counters(a), counters(b), s.players[0].active.counters], [0, 4, 2]);
  restore(g, f);
});

test('「身上放置有6个伤害指示物的宝可梦」: exactly six', async () => {
  const ko = { side: 'opponent', target: 'any', count: 1, state: { damageCounters: 6 } };
  const valid = handlers.get('cn.knockOut@1').validateParameters;
  assert(valid(ko)); assert(!valid({ ...ko, state: { damageCounters: 0 } }));
  assert(handlers.get('cn.healPokemon@1').validateParameters({ op: 'healPokemon', side: 'own', target: 'any', selector: { kind: 'pokemon' },
    selection: { kind: 'exact', count: 1 }, amount: 30, discardHealedEnergy: false, state: { damageCounters: 6 } }));
  const f = await fixture((defs) => { const a = def(defs, 'base').mechanics.attacks[0]; a.printedDamage = null; a.effects = [binding('cn.knockOut@1', ko, 'gem')]; });
  let six, seven;
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); six = bench(s, 1, 'other'); seven = bench(s, 1, 'other'); six.counters = 6; seven.counters = 7; });
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  const s = g.snapshot();
  assert(!s.players[1].bench.some((m) => m.id === six.id), 'Knocked Out.');
  assert(s.players[1].bench.some((m) => m.id === seven.id));
});

test('「从【草】【火】【水】【雷】【超】【斗】【恶】【钢】【龙】中选择1种属性」: up to ten options', () => {
  const types = ['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal', 'Dragon'];
  const option = (type) => ({ handlerId: 'cn.lasting@1', parameters: { side: 'opponent', target: 'active', duration: 'untilLeavesActive',
    clearOnBench: true, clearOnEvolution: true, effect: { op: 'property', field: 'weakness', value: { type, operation: 'multiply', value: 2 }, scope: 'all' } } });
  const valid = handlers.get('cn.chooseOne@1').validateParameters;
  assert(valid({ options: types.map(option) }));
  assert(!valid({ options: [...types, 'Fairy', 'Colorless'].map(option) }));
});

test('「当这只宝可梦从战斗场被放回备战区时…选择自己牌库中的1张「X ex」，与这张卡牌互换（继承…）」 and 「只有通过…「全能变身」的效果才能被放于场上」', async () => {
  const inherit = { op: 'inheritPokemon', target: 'self', targetSelector: { kind: 'pokemon' }, from: 'deck',
    selector: { kind: 'pokemon', nameKeys: ['evolution'] }, relation: 'any', to: 'deckShuffle' };
  const valid = handlers.get('cn.pokemonTransition@1').validateParameters;
  assert(valid(inherit)); assert(!valid({ ...inherit, to: 'discard' })); assert(!valid({ ...inherit, from: 'hand', to: 'deckShuffle' }));
  const hero = { abilityId: 'other:hero', name: '测试全能变身', mode: 'triggered', usage: { period: 'turn', scope: 'pokemon', key: 'other:hero', limit: 1 },
    effects: [binding('cn.pokemonTransition@1', inherit, 'hero')], sourceOfTruth: EVIDENCE,
    trigger: { event: 'movedToBench', subject: 'self', turn: 'own', scope: 'global', choiceOwner: 'source', optional: true } };
  const spirit = { abilityId: 'evolution:spirit', name: '测试全能之魂', mode: 'continuous', usage: null, sourceOfTruth: EVIDENCE,
    effects: [binding('cn.enterOnlyBy@1', { abilityName: '测试全能变身', nameKeys: ['other'] }, 'spirit')] };
  assert(handlers.get('cn.enterOnlyBy@1').validateParameters({ abilityName: '测试全能变身', nameKeys: ['other'] }));
  const f = await fixture((defs) => { def(defs, 'other').mechanics.abilities = [hero]; def(defs, 'evolution').mechanics.abilities = [spirit]; });
  let palafin;
  const g = board(f, (s) => {
    const p = s.players[0]; palafin = bench(s, 0, 'other'); p.bench = [p.active]; p.active = palafin;
    attached(s, 0, palafin, 'water'); palafin.counters = 3;
  });
  command(g, { type: 'retreat' });
  settle(g, (q) => q.kind === 'trigger-optional' ? ['perform'] : q.options.slice(0, Math.max(q.minimum, 1)));
  const s = g.snapshot(), moved = s.players[0].bench.find((m) => m.id === palafin.id);
  assert.equal(s.cards[moved.stack.at(-1)].definitionId, 'evolution', 'Switched with the ex, on the Bench.');
  assert.equal(moved.counters, 3, 'Its damage counters stay.');
  assert(s.players[0].deck.some((id) => s.cards[id].definitionId === 'other'), 'The card went back into the deck.');
  assert(s.events.some((e) => e.ruleId === 'trigger.moved-to-bench'));
  restore(g, f);
  // From the hand the ex cannot evolve, and nothing else may put it into play.
  let card;
  const h = board(f, (s) => { card = hand(s, 0, 'evolution'); });
  assert(!h.view(0).legalActions.some((a) => a.cardId === card));
  await assert.rejects(fixture((defs) => { def(defs, 'tool').mechanics.effects = [binding('cn.enterOnlyBy@1', { abilityName: 'x', nameKeys: ['other'] })]; })
    .then((x) => board(x)), /own printed rule/);
});

test('「可以从手牌使出从「X」进化而来的卡牌，放于其身上进行进化…在进化前，将这只宝可梦的HP，全部回复」', async () => {
  const permit = { fromName: 'base', healBefore: true };
  const valid = handlers.get('cn.evolutionPermission@1').validateParameters;
  assert(valid(permit)); assert(!valid({ firstTurn: true, healBefore: true }));
  const f = await fixture((defs) => { def(defs, 'other').mechanics.abilities = [{ abilityId: 'other:gx', name: '测试进化', mode: 'continuous', usage: null,
    effects: [binding('cn.evolutionPermission@1', permit, 'gx')], sourceOfTruth: EVIDENCE }]; });
  let mon, card, plain;
  const g = board(f, (s) => { card = hand(s, 0, 'evolution'); mon = bench(s, 0, 'other'); mon.counters = 4; plain = s.players[0].active; plain.counters = 2; });
  command(g, { type: 'evolve', cardId: card, pokemonId: mon.id }); settle(g);
  let s = g.snapshot(), m = s.players[0].bench.find((x) => x.id === mon.id);
  assert.deepEqual([s.cards[m.stack.at(-1)].definitionId, m.counters], ['evolution', 0]);
  const h = board(f, (s) => { card = hand(s, 0, 'evolution'); mon = bench(s, 0, 'other'); plain = s.players[0].active; plain.counters = 2; });
  command(h, { type: 'evolve', cardId: card, pokemonId: plain.id }); settle(h);
  s = h.snapshot();
  assert.equal(s.players[0].active.counters, 2, 'An ordinary evolution is not healed.');
});
