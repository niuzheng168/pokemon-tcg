// Synthetic definitions only. 「只要这只宝可梦在场上，对手弃牌区中的卡牌，就无法因为对手的特性或训练家的效果，被加入对手的手牌。」
// 「只要这只宝可梦在场上，对手场上的宝可梦，以及放于其身上的所有卡牌，都无法被放回手牌。」「只要这只宝可梦在场上，身上放置有伤害指示物的对手的
// 宝可梦，以及放于其身上的所有卡牌，都无法被放回手牌。」「只要这只宝可梦在场上，对手弃牌区中的训练家，就无法因为对手的物品或支援者的效果，被放回
// 牌库。」「只要这只宝可梦在备战区，自己的牌库，就不会受到因对手的招式、特性、物品、支援者而导致的将牌库的卡牌放于弃牌区的效果影响。」「只要身上放有
// 这张卡牌的宝可梦在战斗场上，自己的牌库，就不会受到因对手的招式、特性、物品、宝可梦道具、支援者而导致的将牌库的卡牌放于弃牌区的效果影响。」「这张
// 卡牌，只要在弃牌区，就无法加入手牌，也无法放回牌库。」「只要这只宝可梦在场上，附着于自己备战宝可梦身上的基本能量，不会受到因对手的物品或支援者而
// 造成的放于弃牌区的效果影响。」「只要这只宝可梦在场上，附着于自己宝可梦身上的能量，不会受到因对手的物品或支援者而造成的放于弃牌区的效果以及放回手牌
// 和牌库的效果影响。」 (effects.move-lock). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, assertSupportedDefinition } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached, fixtureClock } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const handlers = createCoreHandlers();
const valid = (spec) => handlers.get('cn.moveLock@1').validateParameters(clone({ effect: spec }));
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const nested = (handlerId, parameters) => ({ handlerId, parameters });
const continuous = (key, effects) => ({ abilityId: `fixture:${key}`, name: `测试${key}`, mode: 'continuous', usage: null, effects, sourceOfTruth: EVIDENCE });
const ability = (key, effects) => ({ abilityId: `fixture:${key}`, name: `测试${key}`, mode: 'activated',
  usage: { period: 'turn', scope: 'pokemon', key: `fixture:${key}`, limit: 1 }, effects, sourceOfTruth: EVIDENCE });
const lock = (effect, key = 'lock') => binding('cn.moveLock@1', { effect }, key);
const cards = (p) => ({ reveal: false, lookTop: null, shuffleAfter: false, ...p });
const energy = (p) => ({ side: 'opponent', from: 'any', selector: { kind: 'energy' }, providedTypes: null, measure: 'cards',
  quantity: { kind: 'exact', count: 1 }, chooser: 'source', ...p });
const PROMOTION = { timing: 'afterRelatedResolution', sourceOfTruth: EVIDENCE };
const returning = (p) => ({ op: 'returnPokemon', side: 'own', target: 'self', selector: { kind: 'pokemon' }, quantity: { kind: 'exact', count: 1 },
  to: 'hand', attachments: 'return', chooser: 'source', promotion: PROMOTION, ...p });
const put = (s, owner, id, zone) => { const card = hand(s, owner, id); s.players[owner].hand.pop(); s.players[owner][zone].push(card); return card; };
const tool = (s, owner, m, id = 'tool') => { const card = hand(s, owner, id); s.players[owner].hand.pop(); m.tools.push(card); return card; };
const swapIn = (s, owner, m) => { const p = s.players[owner]; p.bench = [p.active, ...p.bench.filter((b) => b !== m)]; p.active = m; };
const locked = (g, from = 0) => g.snapshot().events.slice(from).filter((e) => e.ruleId === 'effects.move-lock').map((e) => e.data);
const use = (g, pokemonId, key) => command(g, { type: 'useAbility', pokemonId, abilityId: `fixture:${key}` });
const attack = (g) => command(g, { type: 'attack', attackId: 'base:strike' });
const opponentTurn = (s) => fixtureClock(s, [0, 1, 0, 1, 0, 1]);

const TOEDSCRUEL = { op: 'moveLock', zone: 'discard', to: ['hand'], scope: 'opponent', from: 'opponent', categories: ['ability', 'trainer'] };
const MILOTIC = { op: 'moveLock', zone: 'field', to: ['hand'], scope: 'opponent' };
const MIME = { ...MILOTIC, targetState: { damaged: true } };
const SANDSHREW = { op: 'moveLock', zone: 'discard', to: ['deck'], scope: 'opponent', cards: { kind: 'trainer' }, from: 'opponent',
  categories: ['trainer'], trainerCategories: ['item', 'supporter'] };
const ONBENCH = { kind: 'pokemonIs', who: 'self', position: 'bench' };
const BIBAREL = { op: 'moveLock', zone: 'deck', to: ['discard'], scope: 'own', from: 'opponent', categories: ['attack', 'ability', 'trainer'],
  trainerCategories: ['item', 'supporter'], condition: ONBENCH };
const PATROL = { op: 'moveLock', zone: 'deck', to: ['discard'], scope: 'own', from: 'opponent', categories: ['attack', 'ability', 'trainer'],
  trainerCategories: ['item', 'tool', 'supporter'], sourceActive: true };
const HOOTHOOT = { op: 'moveLock', zone: 'field', to: ['discard'], scope: 'own', cards: { kind: 'energy', category: 'basic' }, benchOnly: true,
  from: 'opponent', categories: ['trainer'], trainerCategories: ['item', 'supporter'] };
const GREEDENT = { op: 'moveLock', zone: 'field', to: ['discard', 'hand', 'deck'], scope: 'own', cards: { kind: 'energy' }, from: 'opponent',
  categories: ['trainer'], trainerCategories: ['item', 'supporter'] };

test('schema: the zone, destinations, cards and moving effects of a lock; CN sources', async () => {
  for (const spec of [TOEDSCRUEL, MILOTIC, MIME, SANDSHREW, BIBAREL, PATROL, HOOTHOOT, GREEDENT]) assert(valid(spec), JSON.stringify(spec));
  for (const bad of [{ ...TOEDSCRUEL, to: ['discard'] }, { ...TOEDSCRUEL, benchOnly: true }, { ...TOEDSCRUEL, from: 'all' },
    { ...BIBAREL, cards: { kind: 'any' } }, { ...BIBAREL, scope: 'opponent' }, { ...BIBAREL, to: ['hand'] }, { ...BIBAREL, from: 'own' },
    { ...MILOTIC, to: ['hand', 'deck'] }, { ...GREEDENT, cards: { kind: 'trainer' } }, { ...HOOTHOOT, from: undefined },
    { ...SANDSHREW, categories: ['ability'] }, { ...SANDSHREW, categories: undefined }, { ...TOEDSCRUEL, zone: 'hand' }])
    assert(!valid(JSON.parse(JSON.stringify(bad))), JSON.stringify(bad));
  const rule = requireRule(CN_V20261019, 'effects.move-lock');
  assert(rule.sourceOfTruth.some((s) => s.documentId === 'CN-advanced-3.1.0' && s.section === 'II.E-29'));
  assert(rule.sourceOfTruth.some((s) => s.documentId === 'JP-official-qa' && s.section.includes('「ねんきんコロニー」') && s.section.includes('ネモのリュック')));
  for (const source of rule.sourceOfTruth) assert(handlers.get('cn.moveLock@1').sourceOfTruth.includes(source));
  assert.equal(handlers.get('cn.moveLock@1').timing, 'continuous');
  await assert.rejects(fixture((defs) => { def(defs, 'poison').mechanics.discardPileLock = { to: ['discard'] }; }));
  const item = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [lock(MILOTIC)]; });
  assert.throws(() => assertSupportedDefinition(item.catalog, item.catalog.definition('potion')), /handler timing/, 'A lock is continuous: not an Item.');
});

test('「对手弃牌区中的卡牌，就无法因为对手的特性或训练家的效果，被加入对手的手牌」: chosen, but it stays', async () => {
  const recover = cards({ from: 'discard', to: 'hand', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 1 }, reveal: true });
  const f = await fixture((defs) => {
    def(defs, 'other').mechanics.abilities = [continuous('slime', [lock(TOEDSCRUEL)])];
    def(defs, 'potion').mechanics.effects = [binding('cn.then@1', { first: nested('cn.cards@1', recover), next: nested('cn.draw@1', { count: 1 }) }, 'recover')];
    def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.cards@1', recover, 'recover')];
    def(defs, 'base').mechanics.abilities = [ability('dig', [binding('cn.cards@1', recover, 'dig')])];
    def(defs, 'research').mechanics.discardRecall = { costs: [{ costId: 'research:recall', kind: 'discardHand', count: 2,
      selector: { kind: 'energy' }, sourceOfTruth: EVIDENCE }] };
  });
  let potion, water, grant, a, b;
  const g = board(f, (s) => {
    potion = hand(s, 0, 'potion'); water = put(s, 0, 'water', 'discard'); grant = put(s, 0, 'research', 'discard');
    a = hand(s, 0, 'water'); b = hand(s, 0, 'water'); bench(s, 1, 'other');
  });
  const size = g.snapshot().players[0].hand.length;
  command(g, { type: 'playTrainer', cardId: potion });
  const q = g.snapshot().pending;
  assert.equal(q.kind, 'select-cards'); assert(q.options.includes(water), 'Still a choice (JP Q&A リククラゲ × スーパーエネルギー回収).');
  const r = restore(g, f);
  for (const game of [g, r]) { answer(game, [water]); settle(game); }
  assert.deepEqual(r.snapshot(), g.snapshot());
  let s = g.snapshot();
  assert(s.players[0].discard.includes(water) && s.players[0].discard.includes(potion));
  assert.equal(s.players[0].hand.length, size - 1, 'Nothing came back, so 「然后」 drew nothing.');
  assert.deepEqual(locked(g).map((l) => [l.player, l.zone, l.to, l.cards, l.locks.length]), [[0, 'discard', 'hand', [water], 1]]);
  // trainer.discard-recall is that Supporter's own effect: paid, and it stays.
  const from = g.snapshot().events.length;
  command(g, { type: 'recallCard', cardId: grant });
  answer(g, g.snapshot().pending.options.filter((o) => [a, b].includes(JSON.parse(o)[1]))); settle(g);
  s = g.snapshot();
  assert(s.players[0].discard.includes(grant) && s.players[0].discard.includes(a) && s.players[0].discard.includes(b));
  assert(!s.events.slice(from).some((e) => e.ruleId === 'trainer.discard-recall'));
  assert.deepEqual(locked(g, from).map((l) => [l.cards, l.effectId]), [[[grant], null]]);
  assert.deepEqual(restore(g, f).snapshot(), s);
  // An Ability is locked too; an attack is neither; the lock's own player is not its opponent.
  let dug;
  const h = board(f, (s) => { dug = put(s, 0, 'water', 'discard'); bench(s, 1, 'other'); });
  use(h, h.snapshot().players[0].active.id, 'dig'); answer(h, [dug]); settle(h);
  assert(h.snapshot().players[0].discard.includes(dug));
  const k = board(f, (s) => { dug = put(s, 0, 'water', 'discard'); attached(s, 0, s.players[0].active, 'water'); bench(s, 1, 'other'); });
  attack(k); answer(k, [dug]); settle(k);
  assert(k.snapshot().players[0].hand.includes(dug), 'An attack is not 「特性或训练家」.');
  const own = board(f, (s) => { opponentTurn(s); potion = hand(s, 1, 'potion'); dug = put(s, 1, 'water', 'discard'); bench(s, 1, 'other'); });
  command(own, { type: 'playTrainer', cardId: potion }); answer(own, [dug]); settle(own);
  assert(own.snapshot().players[1].hand.includes(dug));
  assert.deepEqual(locked(own), []);
});

test('「这张卡牌，只要在弃牌区，就无法加入手牌，也无法放回牌库」: any effect; the other chosen cards still move', async () => {
  const any = { selector: { kind: 'any' }, quantity: { kind: 'upTo', count: 3 } };
  const f = await fixture((defs) => {
    def(defs, 'poison').mechanics.discardPileLock = { to: ['hand', 'deck'] };
    def(defs, 'stadium').mechanics.discardPileLock = { to: ['hand'] };
    def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.cards@1', cards({ from: 'discard', to: 'hand', ...any }), 'back')];
    def(defs, 'other').mechanics.attacks[0].effects = [binding('cn.cards@1', cards({ from: 'discard', to: 'deck', shuffleAfter: true, ...any }), 'in')];
    def(defs, 'evolution').mechanics.attacks[0] = { ...def(defs, 'evolution').mechanics.attacks[0], printedDamage: null, effects: [
      binding('cn.countedReveal@1', { from: 'discard', selector: { kind: 'trainer' } }, 'reveal'),
      binding('cn.revealedCards@1', { effectId: 'fixture:reveal', to: 'deck' }, 'route')] };
  });
  for (const [attacker, moved, stayed] of [['base', ['water'], ['poison', 'stadium']], ['other', ['water', 'stadium'], ['poison']],
    ['evolution', ['stadium'], ['poison']]]) {
    let pile;
    const g = board(f, (s) => {
      pile = Object.fromEntries(['poison', 'stadium', 'water'].map((id) => [id, put(s, 0, id, 'discard')]));
      const m = bench(s, 0, attacker); swapIn(s, 0, m); attached(s, 0, m, 'water');
    });
    command(g, { type: 'attack', attackId: `${attacker}:strike` });
    if (attacker !== 'evolution') answer(g, Object.values(pile));
    settle(g);
    const s = g.snapshot(), p = s.players[0];
    for (const id of stayed) assert(p.discard.includes(pile[id]), `${attacker}: ${id} stays`);
    for (const id of moved) assert(!p.discard.includes(pile[id]), `${attacker}: ${id} moves`);
    assert.deepEqual(locked(g).map((l) => l.cards), [stayed.map((id) => pile[id])]);
    assert.deepEqual(restore(g, f).snapshot(), s);
  }
});

test('「对手弃牌区中的训练家，就无法因为对手的物品或支援者的效果，被放回牌库」: Trainers only, Items and Supporters only', async () => {
  const back = binding('cn.cards@1', cards({ from: 'discard', to: 'deck', selector: { kind: 'any' }, quantity: { kind: 'upTo', count: 2 }, shuffleAfter: true }), 'back');
  const make = (spec) => fixture((defs) => {
    def(defs, 'other').mechanics.abilities = [continuous('sand', [lock(spec)])];
    for (const id of ['research', 'potion']) def(defs, id).mechanics.effects = [back];
    def(defs, 'base').mechanics.attacks[0].effects = [back];
  });
  const f = await make(SANDSHREW), item = await make({ ...SANDSHREW, trainerCategories: ['supporter'] });
  const run = (game, play) => {
    let used, held, water;
    const g = board(game, (s) => {
      if (play !== 'attack') used = hand(s, 0, play);
      held = put(s, 0, 'tool', 'discard'); water = put(s, 0, 'water', 'discard');
      attached(s, 0, s.players[0].active, 'water'); bench(s, 1, 'other');
    });
    if (play === 'attack') attack(g); else command(g, { type: 'playTrainer', cardId: used });
    answer(g, [held, water]); settle(g);
    const p = g.snapshot().players[0];
    assert(p.deck.includes(water));
    return { g, held: p.deck.includes(held), kept: locked(g) };
  };
  const supporter = run(f, 'research');
  assert.equal(supporter.held, false); assert.equal(supporter.kept.length, 1);
  assert.deepEqual(restore(supporter.g, f).snapshot(), supporter.g.snapshot());
  assert.equal(run(f, 'attack').held, true, 'An attack is not 「物品或支援者」.');
  assert.equal(run(item, 'potion').held, true, 'Only the printed Trainer kinds.');
  assert.equal(run(item, 'research').held, false);
});

test('「对手场上的宝可梦，以及放于其身上的所有卡牌，都无法被放回手牌」: every player\'s effect, the whole Pokémon', async () => {
  const scoop = binding('cn.then@1', { first: nested('cn.fieldReturn@1', returning()), next: nested('cn.draw@1', { count: 1 }) }, 'scoop');
  const make = (spec, extra = () => {}) => fixture((defs) => {
    def(defs, 'other').mechanics.abilities = [continuous('haven', [lock(spec)])];
    def(defs, 'base').mechanics.abilities = [ability('scoop', [scoop]),
      ability('unload', [binding('cn.attachedEnergy@1', energy({ op: 'returnEnergy', side: 'own', from: 'self', quantity: { kind: 'all' }, to: 'hand' }), 'unload')]),
      ability('swap', [binding('cn.pokemonTransition@1', { op: 'inheritPokemon', target: 'self', targetSelector: { kind: 'pokemon' }, from: 'hand',
        selector: { kind: 'pokemon', nameKeys: ['base'] }, relation: 'any', to: 'hand' }, 'swap')])];
    extra(defs);
  });
  const f = await make(MILOTIC);
  let mon, water;
  const g = board(f, (s) => { mon = bench(s, 0, 'base'); water = attached(s, 0, mon, 'water'); bench(s, 1, 'other'); });
  const size = g.snapshot().players[0].hand.length;
  use(g, mon.id, 'scoop'); answer(g, [mon.id]);
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  settle(g);
  let s = g.snapshot();
  assert(s.players[0].bench.some((m) => m.id === mon.id && m.energy.includes(water)), 'It and its cards stay (JP Q&A ミロカロス × フトゥー博士のシナリオ).');
  assert.equal(s.players[0].hand.length, size, '「然后」 had nothing returned.');
  assert.deepEqual(locked(g).map((l) => [l.zone, l.to, l.cards]), [['field', 'hand', mon.stack]]);
  use(g, mon.id, 'unload'); settle(g);
  assert(g.snapshot().players[0].bench.find((m) => m.id === mon.id).energy.includes(water), 'Its Energy stays too.');
  // An inherited replacement would put the old top card into the hand.
  let spare;
  const swap = board(f, (s) => { spare = hand(s, 0, 'base'); bench(s, 1, 'other'); });
  const top = swap.snapshot().players[0].active.stack[0];
  use(swap, swap.snapshot().players[0].active.id, 'swap'); settle(swap);
  s = swap.snapshot();
  assert.deepEqual(s.players[0].active.stack, [top]); assert(s.players[0].hand.includes(spare));
  // A Pokémon not affected by the opponent's Abilities is not locked (JP Q&A バリヤード × メガジュカインEX「θストップ」).
  const theta = await make(MILOTIC, (defs) => { def(defs, 'base').mechanics.abilities.push(continuous('theta', [binding('cn.protection@1',
    { effect: { op: 'protection', channel: 'effects', useRule: 'ordinary', scope: 'self', from: 'opponent', categories: ['ability'] } }, 'theta')])); });
  const free = board(theta, (s) => { mon = bench(s, 0, 'base'); bench(s, 1, 'other'); });
  use(free, mon.id, 'scoop'); answer(free, [mon.id]); settle(free);
  assert(free.snapshot().players[0].hand.includes(mon.stack[0]));
  // 「身上放置有伤害指示物的对手的宝可梦」: only while it has damage counters, read at the move.
  const mime = await make(MIME);
  for (const counters of [0, 1]) {
    const m = board(mime, (s) => { mon = bench(s, 0, 'base'); mon.counters = counters; bench(s, 1, 'other'); });
    use(m, mon.id, 'scoop'); answer(m, [mon.id]); settle(m);
    assert.equal(m.snapshot().players[0].hand.includes(mon.stack[0]), counters === 0);
  }
});

test('the lock\'s own player\'s effects, devolution, a Knock Out, a Retreat and a discard-to-hand card', async () => {
  const devolve = { op: 'devolvePokemon', side: 'opponent', target: 'any', targetSelector: { kind: 'pokemon' }, selection: { kind: 'exact', count: 1 },
    layers: { kind: 'exact', count: 1 }, to: 'hand', chooser: 'source' };
  const f = await fixture((defs) => {
    def(defs, 'other').mechanics.abilities = [continuous('haven', [lock(MILOTIC)])];
    def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.pokemonTransition@1', devolve, 'devolve'),
      binding('cn.fieldReturn@1', returning({ side: 'opponent', target: 'active' }), 'charisma')];
    def(defs, 'evolution').mechanics.abilities = [continuous('blade', [binding('cn.knockoutZone@1',
      { effect: { op: 'knockoutZone', scope: 'self', cards: 'pokemon', to: 'hand', byOpponentAttack: true } }, 'blade')])];
    def(defs, 'tool').mechanics.effects = [binding('cn.retreatRule@1', { effect: { op: 'retreatRule', scope: 'self', energyToHand: true } }, 'pouch')];
    def(defs, 'double').mechanics.effects = [binding('cn.discardToHand@1', {}, 'u-turn')];
    def(defs, 'potion').mechanics.effects = [binding('cn.attachedEnergy@1', energy({ op: 'discardEnergy', side: 'own', from: 'active',
      selector: { kind: 'energy', category: 'special' } }), 'scrap')];
  });
  // The lock's own player's attack: the evolution card and the Active stay (JP Q&A バリヤード × カイロス).
  let evolved, top;
  const g = board(f, (s) => {
    opponentTurn(s); attached(s, 1, s.players[1].active, 'water'); bench(s, 1, 'other');
    evolved = bench(s, 0, 'base'); top = hand(s, 0, 'evolution'); s.players[0].hand.pop(); evolved.stack.push(top);
  });
  const active = g.snapshot().players[0].active;
  attack(g); settle(g);
  let s = g.snapshot();
  assert.equal(s.players[0].active.id, active.id); assert.deepEqual(s.players[0].bench[0].stack.at(-1), top);
  assert.deepEqual(locked(g).map((l) => l.cards), [[top], active.stack]);
  assert.deepEqual(restore(g, f).snapshot(), s);
  // ko.hand: it cannot go to the hand, so it goes to the discard pile (JP Q&A バリヤード × ギルガルド「くちないつるぎ」).
  let blade;
  const ko = board(f, (s) => {
    opponentTurn(s); const haven = bench(s, 1, 'other'); swapIn(s, 1, haven); attached(s, 1, haven, 'water');
    blade = bench(s, 0, 'evolution'); swapIn(s, 0, blade); blade.counters = 14;
  });
  const koFrom = ko.snapshot().events.length;
  command(ko, { type: 'attack', attackId: 'other:strike' }); settle(ko);
  s = ko.snapshot();
  assert(s.players[0].discard.includes(blade.stack[0])); assert(!s.players[0].hand.includes(blade.stack[0]));
  assert(!s.events.slice(koFrom).some((e) => e.ruleId === 'ko.hand'));
  assert.equal(locked(ko, koFrom).filter((l) => l.cards.includes(blade.stack[0])).length, 1, 'Logged once, at the Knock Out.');
  // retreat.rules 「…放回手牌」: discarded as usual (JP Q&A バリヤード × スケーターズパーク).
  let water;
  const back = board(f, (s) => { water = attached(s, 0, s.players[0].active, 'water'); tool(s, 0, s.players[0].active); bench(s, 0, 'base'); bench(s, 1, 'other'); });
  command(back, { type: 'retreat' }); settle(back);
  s = back.snapshot();
  assert(s.players[0].discard.includes(water)); assert(!s.events.some((e) => e.ruleId === 'retreat.rules'));
  // effects.discard-to-hand: discarded after all.
  let double, potion;
  const turn = board(f, (s) => { double = attached(s, 0, s.players[0].active, 'double'); potion = hand(s, 0, 'potion'); bench(s, 1, 'other'); });
  command(turn, { type: 'playTrainer', cardId: potion }); settle(turn);
  assert(turn.snapshot().players[0].discard.includes(double));
  assert(!turn.snapshot().events.some((e) => e.ruleId === 'effects.discard-to-hand'));
});

test('「自己的牌库，就不会受到…将牌库的卡牌放于弃牌区的效果影响」: no look, no discard; on the Bench / in the Active Spot', async () => {
  const f = await fixture((defs) => {
    def(defs, 'other').mechanics.abilities = [continuous('dam', [lock(BIBAREL)])];
    def(defs, 'tool').mechanics.effects = [lock(PATROL, 'cap')];
    def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.discardDeckTop@1', { side: 'opponent', count: 2 }, 'mill')];
    def(defs, 'evolution').mechanics.attacks[0].effects = [binding('cn.countedDeckTop@1', { side: 'both', count: 1 }, 'both')];
    def(defs, 'research').mechanics.effects = [binding('cn.cards@1', cards({ side: 'opponent', from: 'deck', to: 'discard', selector: { kind: 'any' },
      quantity: { kind: 'upTo', count: 3 }, lookTop: 3 }), 'sisters')];
    def(defs, 'potion').mechanics.effects = [binding('cn.discardDeckTop@1', { side: 'opponent', count: 1, to: 'lost' }, 'lost')];
  });
  let research, potion;
  const g = board(f, (s) => { research = hand(s, 0, 'research'); potion = hand(s, 0, 'potion'); attached(s, 0, s.players[0].active, 'water'); bench(s, 1, 'other'); });
  const deck = [...g.snapshot().players[1].deck], pile = g.snapshot().players[1].discard.length;
  command(g, { type: 'playTrainer', cardId: research });
  assert.equal(g.snapshot().pending, null, 'Not even a look (JP Q&A ビーダル × ミルホッグ「しなさだめ」).');
  command(g, { type: 'playTrainer', cardId: potion }); settle(g);
  attack(g); settle(g);
  const s = g.snapshot();
  assert.equal(s.players[1].discard.length, pile);
  assert.deepEqual(s.players[1].lost, [deck.at(-1)], 'The Lost Zone is not the discard pile.');
  assert.deepEqual(locked(g).map((l) => [l.player, l.zone, l.to]), [[1, 'deck', 'discard'], [1, 'deck', 'discard']]);
  assert.deepEqual(restore(g, f).snapshot(), s);
  const discarded = (mutate, attacker = 'base') => {
    const h = board(f, (s) => { const m = bench(s, 0, attacker); swapIn(s, 0, m); attached(s, 0, m, 'water'); mutate(s); });
    const before = h.snapshot().players.map((p) => p.discard.length);
    command(h, { type: 'attack', attackId: `${attacker}:strike` }); settle(h);
    return h.snapshot().players.map((p, i) => p.discard.length - before[i]);
  };
  assert.deepEqual(discarded((s) => { swapIn(s, 1, bench(s, 1, 'other')); }), [0, 2], 'Only while it is on the Bench.');
  assert.deepEqual(discarded((s) => { bench(s, 1, 'other'); }, 'evolution'), [1, 0], '「双方」: the user\'s own deck still.');
  assert.deepEqual(discarded((s) => { tool(s, 1, s.players[1].active); }), [0, 0], 'A Tool on the Active Pokémon.');
  assert.deepEqual(discarded((s) => { tool(s, 1, bench(s, 1, 'base')); }), [0, 2], 'Not on the Bench.');
});

test('「附着于自己备战宝可梦身上的基本能量，不会受到因对手的物品或支援者而造成的放于弃牌区的效果影响」: chosen, it stays', async () => {
  const scrap = binding('cn.attachedEnergy@1', energy({ op: 'discardEnergy' }), 'hammer');
  const f = await fixture((defs) => {
    def(defs, 'other').mechanics.abilities = [continuous('watch', [lock(HOOTHOOT)])];
    def(defs, 'potion').mechanics.effects = [scrap];
    def(defs, 'base').mechanics.attacks[0].effects = [scrap];
    def(defs, 'research').mechanics.effects = [binding('cn.healPokemon@1', { op: 'healPokemon', side: 'opponent', target: 'bench', selector: { kind: 'pokemon' },
      selection: { kind: 'exact', count: 1 }, amount: 30, discardHealedEnergy: true }, 'heal')];
    const { promotion: _none, ...scoop } = returning({ side: 'opponent', target: 'bench', attachments: 'discard' });
    def(defs, 'poison').mechanics.effects = [binding('cn.fieldReturn@1', scoop, 'scoop')];
  });
  let owl, basic, double, front, potion;
  const setup = (mutate = () => {}) => board(f, (s) => {
    owl = bench(s, 1, 'other'); basic = attached(s, 1, owl, 'water'); double = attached(s, 1, owl, 'double');
    front = attached(s, 1, s.players[1].active, 'water'); potion = hand(s, 0, 'potion'); mutate(s);
  });
  for (const [pick, stays] of [['basic', true], ['front', false], ['double', false]]) {
    const g = setup(), id = { basic, front, double }[pick];
    command(g, { type: 'playTrainer', cardId: potion });
    assert(g.snapshot().pending.options.includes(basic), 'It may be chosen (JP Q&A ホーホー × クラッシュハンマー).');
    restore(g, f); answer(g, [id]); settle(g);
    const s = g.snapshot();
    assert.equal(!s.players[1].discard.includes(id), stays, pick);
    assert(s.players[0].discard.includes(potion));
    assert.equal(locked(g).length, stays ? 1 : 0);
  }
  const k = setup((s) => attached(s, 0, s.players[0].active, 'water'));
  attack(k); answer(k, [basic]); settle(k);
  assert(k.snapshot().players[1].discard.includes(basic), 'An attack is not 「物品或支援者」.');
  // 「…并将那只宝可梦身上附着的能量全部放于弃牌区」: the Basic Energy stays.
  let research;
  const h = setup((s) => { owl.counters = 2; research = hand(s, 0, 'research'); });
  command(h, { type: 'playTrainer', cardId: research }); settle(h);
  const s = h.snapshot(), healed = s.players[1].bench.find((m) => m.id === owl.id);
  assert.equal(healed.counters, 0); assert.deepEqual(healed.energy, [basic]); assert(s.players[1].discard.includes(double));
  // The Pokémon leaving with a locked attached card has no ruling: the engine refuses to guess.
  let poison;
  const r = setup((s) => { poison = hand(s, 0, 'poison'); });
  command(r, { type: 'playTrainer', cardId: poison });
  assert.throws(() => answer(r, [owl.id]), /CN ruling/);
});

test('「附着于自己宝可梦身上的能量，不会受到因对手的物品或支援者而造成的…放回手牌和牌库的效果影响」', async () => {
  const f = await fixture((defs) => {
    def(defs, 'other').mechanics.abilities = [continuous('tail', [lock(GREEDENT)])];
    def(defs, 'potion').mechanics.effects = [binding('cn.attachedEnergy@1', energy({ op: 'returnEnergy', from: 'active', to: 'hand' }), 'grunt')];
    def(defs, 'research').mechanics.effects = [binding('cn.fieldReturn@1', { op: 'returnAttached', side: 'both', target: 'active', to: 'deckShuffle' }, 'wind')];
    def(defs, 'base').mechanics.abilities = [ability('pull', [binding('cn.attachedEnergy@1', energy({ op: 'returnEnergy', from: 'active', to: 'hand' }), 'pull')])];
  });
  let water, held, mine, potion, research;
  const setup = () => board(f, (s) => {
    const p = s.players[1]; swapIn(s, 1, bench(s, 1, 'other'));
    water = attached(s, 1, p.active, 'water'); held = tool(s, 1, p.active);
    mine = attached(s, 0, s.players[0].active, 'water'); potion = hand(s, 0, 'potion'); research = hand(s, 0, 'research');
  });
  const g = setup();
  command(g, { type: 'playTrainer', cardId: potion }); settle(g);
  assert(g.snapshot().players[1].active.energy.includes(water), 'JP Q&A ヨクバリス × エール団のしたっぱ.');
  command(g, { type: 'playTrainer', cardId: research }); settle(g);
  const s = g.snapshot();
  assert.deepEqual(s.players[1].active.energy, [water]); assert(s.players[1].deck.includes(held), 'A Tool is not an Energy.');
  assert(s.players[0].deck.includes(mine));
  assert.deepEqual(locked(g).map((l) => [l.player, l.to, l.cards]), [[1, 'hand', [water]], [1, 'deck', [water]]]);
  assert.deepEqual(restore(g, f).snapshot(), s);
  const h = setup();
  use(h, h.snapshot().players[0].active.id, 'pull'); settle(h);
  assert(h.snapshot().players[1].hand.includes(water), 'An Ability is not 「物品或支援者」.');
});

test('a lock for both discard piles while its Pokémon is Active; a lock on the own player\'s effects', async () => {
  const recover = binding('cn.cards@1', cards({ from: 'discard', to: 'hand', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 1 } }), 'recover');
  const make = (spec) => fixture((defs) => {
    def(defs, 'other').mechanics.abilities = [continuous('seal', [lock(spec)])];
    def(defs, 'potion').mechanics.effects = [recover];
  });
  const back = async (spec, active, player = 0) => {
    const f = await make(spec);
    let water, potion;
    const g = board(f, (s) => {
      if (player) opponentTurn(s);
      potion = hand(s, player, 'potion'); water = put(s, player, 'water', 'discard');
      const m = bench(s, 1, 'other'); if (active) swapIn(s, 1, m);
    });
    command(g, { type: 'playTrainer', cardId: potion }); answer(g, [water]); settle(g);
    return g.snapshot().players[player].hand.includes(water);
  };
  const all = { op: 'moveLock', zone: 'discard', to: ['hand'], scope: 'all', sourceActive: true };
  assert(valid(all));
  assert.equal(await back(all, false), true); assert.equal(await back(all, true), false); assert.equal(await back(all, true, 1), false);
  const self = { op: 'moveLock', zone: 'discard', to: ['hand'], scope: 'all', from: 'own' };
  assert.equal(await back(self, false), true); assert.equal(await back(self, false, 1), false);
});
