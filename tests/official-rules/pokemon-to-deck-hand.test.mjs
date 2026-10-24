// Synthetic definitions only. 「将自己牌库下方1张卡牌放于弃牌区。然后，将放于这只宝可梦身上的卡牌全部放于弃牌区，将这只宝可梦放回牌库上方」,
// 「若希望，可以将这只宝可梦以及放于其身上的所有卡牌以任意顺序重新排列，放回自己的牌库下方」, 「将对手的战斗宝可梦与备战宝可梦互换。（放于战斗场的
// 宝可梦由对手选择。）然后，将放于这只宝可梦身上的卡牌全部放于弃牌区，将这只宝可梦放回牌库下方」, 「抛掷1次硬币如果为正面，则将对手的战斗宝可梦，
// 以及放于其身上的所有卡牌，反面朝上重洗，放回对手的牌库下方」 (effects.field-return-deck); 「若希望，可将放于双方战斗宝可梦身上的所有卡牌，各放回
// 牌库并重洗牌库」 (effects.attached-return); 「当这只宝可梦，受到对手宝可梦的招式的伤害而【昏厥】时，不放于弃牌区，而是放回手牌。（除宝可梦以外的
// 卡牌，全部放于弃牌区。）」 (ko.hand); 「选择自己弃牌区中的1张【1阶进化】宝可梦（除「X」外）。然后，将这只宝可梦，以及放于其身上的所有卡牌，放于
// 弃牌区，将被选择的宝可梦放于这只宝可梦原先的位置」 and 「选择自己牌库中的1张「X」。然后，将这只宝可梦，以及放于其身上的所有卡牌，放于放逐区，
// 将被选择的「X」，放于这只宝可梦先前的位置。并重洗牌库」 (effects.replace-zones). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, EngineError } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { randomIndex } from '../../public/rules/random.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, bench, attached, hand } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const handlers = createCoreHandlers();
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const PROMOTION = { timing: 'afterRelatedResolution', sourceOfTruth: EVIDENCE };
const returning = (extra = {}) => ({ op: 'returnPokemon', side: 'own', target: 'self', selector: { kind: 'pokemon' },
  quantity: { kind: 'exact', count: 1 }, to: 'deckBottom', attachments: 'return', chooser: 'source', promotion: PROMOTION, ...extra });
const attachedReturn = (side = 'both') => ({ op: 'returnAttached', side, target: 'active', to: 'deckShuffle' });
const nested = (handlerId, parameters) => ({ handlerId, parameters });
const ability = (key, effects, extra = {}) => ({
  abilityId: `fixture:${key}`, name: `测试${key}`, mode: 'activated',
  usage: { period: 'turn', scope: 'pokemon', key: `fixture:${key}`, limit: 1 }, effects, sourceOfTruth: EVIDENCE, ...extra,
});
const ONBENCH = { predicate: { kind: 'pokemonIs', who: 'self', position: 'bench' } };
const uses = (g, player = 0) => g.view(player).legalActions.filter((a) => a.type === 'useAbility');
const use = (g, pokemonId, abilityId) => command(g, { type: 'useAbility', pokemonId, abilityId });
const attack = (g) => command(g, { type: 'attack', attackId: 'base:strike' });
const put = (s, owner, id, zone) => { const card = hand(s, owner, id); s.players[owner].hand.pop(); s.players[owner][zone].push(card); return card; };
const tool = (s, owner, m, id = 'tool') => { const card = hand(s, owner, id); s.players[owner].hand.pop(); m.tools.push(card); return card; };
const evolve = (s, owner, m) => { const card = hand(s, owner, 'evolution'); s.players[owner].hand.pop(); m.stack.push(card); return card; };
const seedFor = (coins) => {
  for (let i = 1; i <= 8192; i++) {
    const seed = [Math.imul(i, 8000009) >>> 0, Math.imul(i, 333333331) >>> 0, Math.imul(i, 17) >>> 0, Math.imul(i, 37) >>> 0], rng = [...seed];
    if (coins.every((heads) => (randomIndex(rng, 2) === 0) === heads)) return seed;
  }
  throw new Error('No fixture seed.');
};

test('schemas: deck ends, the attached-only return, the hand Knock Out and both replacement zones; CN sources', () => {
  for (const id of ['effects.field-return-deck', 'effects.attached-return', 'ko.hand', 'effects.replace-zones', 'effects.deck-bottom-discard'])
    assert(requireRule(CN_V20261019, id).sourceOfTruth.length > 0);
  const field = handlers.get('cn.fieldReturn@1');
  for (const id of ['effects.field-return-deck', 'effects.attached-return'])
    for (const source of requireRule(CN_V20261019, id).sourceOfTruth) assert(field.sourceOfTruth.includes(source));
  const valid = (p) => field.validateParameters(clone(p));
  for (const to of ['deckTop', 'deckBottom', 'shuffleBottom']) assert(valid(returning({ to })), to);
  assert(valid(returning({ to: 'deckTop', attachments: 'discard' })));
  assert(valid(returning({ side: 'opponent', target: 'active', to: 'shuffleBottom' })));
  assert(!valid(returning({ side: 'opponent', target: 'active', to: 'deckBottom' })), 'Who orders the opponent\'s cards is not printed.');
  for (const side of ['own', 'opponent', 'both']) assert(valid(attachedReturn(side)));
  for (const bad of [{ ...attachedReturn(), target: 'any' }, { ...attachedReturn(), to: 'hand' }, { ...attachedReturn(), selector: { kind: 'pokemon' } }])
    assert(!valid(bad));
  assert(!valid({ ...returning(), side: 'both' }));
  const zone = (effect) => handlers.get('cn.knockoutZone@1').validateParameters({ effect });
  const toHand = { op: 'knockoutZone', scope: 'self', cards: 'pokemon', to: 'hand', byOpponentAttack: true };
  assert(zone(toHand)); assert(zone({ ...toHand, scope: 'own' }));
  assert(!zone({ ...toHand, cards: 'all' })); assert(!zone({ ...toHand, to: 'lost' }));
  const { to: _to, ...lostSelf } = toHand;
  assert(!zone(lostSelf), 'This Pokémon alone: only the printed hand destination.');
  assert(!zone({ ...toHand, byOwnAttack: true }));
  const replace = handlers.get('cn.replacePokemon@1').validateParameters;
  const p = { op: 'replacePokemon', target: 'self', from: 'discard', shuffleAfter: false, selector: { kind: 'pokemon', stages: ['stage1'] } };
  assert(replace(p)); assert(replace({ ...p, to: 'lost' })); assert(replace({ ...p, from: 'deck', shuffleAfter: true, to: 'lost' }));
  assert(!replace({ ...p, shuffleAfter: true })); assert(!replace({ ...p, to: 'discard' })); assert(!replace({ ...p, from: 'hand' }));
  const mill = handlers.get('cn.discardDeckTop@1');
  assert(mill.validateParameters({ side: 'own', count: 1, from: 'bottom' })); assert(!mill.validateParameters({ side: 'own', count: 1, from: 'top' }));
  for (const source of requireRule(CN_V20261019, 'effects.deck-bottom-discard').sourceOfTruth) assert(mill.sourceOfTruth.includes(source));
});

test('「将自己牌库下方1张卡牌放于弃牌区。然后，将放于这只宝可梦身上的卡牌全部放于弃牌区，将这只宝可梦放回牌库上方」', async () => {
  const jump = nested('cn.then@1', { first: nested('cn.discardDeckTop@1', { side: 'own', count: 1, from: 'bottom' }),
    next: nested('cn.fieldReturn@1', returning({ to: 'deckTop', attachments: 'discard' })) });
  const f = await fixture((defs) => { def(defs, 'evolution').mechanics.abilities = [ability('jump', [binding(jump.handlerId, jump.parameters, 'jump')],
    { condition: ONBENCH })]; });
  let mon, basic, evolution, water, held;
  const g = board(f, (s) => {
    mon = bench(s, 0, 'base'); basic = mon.stack[0]; evolution = evolve(s, 0, mon);
    water = attached(s, 0, mon, 'water'); held = tool(s, 0, mon); mon.counters = 2;
  });
  const bottom = g.snapshot().players[0].deck[0];
  assert.deepEqual(uses(g).map((a) => a.pokemonId), [mon.id], 'Only while on the Bench.');
  use(g, mon.id, 'fixture:jump'); answer(g, [mon.id]);
  const q = g.view(0).pending;
  assert.equal(q.kind, 'order-cards'); assert.deepEqual([...q.options].sort(), [basic, evolution].sort());
  const r = restore(g, f);
  for (const game of [g, r]) { answer(game, [evolution, basic]); settle(game); }
  assert.deepEqual(r.snapshot(), g.snapshot());
  const s = g.snapshot(), p = s.players[0];
  assert(p.discard.includes(bottom) && !p.deck.includes(bottom), 'The bottom card first.');
  assert.deepEqual(p.deck.slice(-2), [basic, evolution], 'The first chosen ends uppermost.');
  assert(p.discard.includes(water) && p.discard.includes(held));
  assert(!p.bench.some((m) => m.id === mon.id));
  assert(s.events.some((e) => e.ruleId === 'effects.deck-bottom-discard' && e.data.cards[0].instanceId === bottom));
  assert(s.events.some((e) => e.ruleId === 'effects.deck-order' && e.data.to === 'deckTop' && e.data.count === 2));
  // A Basic alone has one order; an empty deck cannot use it (JP Q&A カスミのコダック).
  const single = await fixture((defs) => { def(defs, 'other').mechanics.abilities = [ability('jump', [binding(jump.handlerId, jump.parameters, 'jump')],
    { condition: ONBENCH })]; });
  let lone;
  const h = board(single, (s) => { lone = bench(s, 0, 'other'); });
  use(h, lone.id, 'fixture:jump'); settle(h);
  assert.equal(h.snapshot().players[0].deck.at(-1), lone.stack[0]);
  const empty = board(single, (s) => { bench(s, 0, 'other'); s.players[0].discard.push(...s.players[0].deck.splice(0)); });
  assert.deepEqual(uses(empty), []);
});

test('「若希望，可以将这只宝可梦以及放于其身上的所有卡牌以任意顺序重新排列，放回自己的牌库下方」: after the damage, then a new Active', async () => {
  const f = await fixture((defs) => { def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.optional@1',
    { effect: nested('cn.fieldReturn@1', returning()) }, 'restore')]; });
  let water, held, spare;
  const setup = () => board(f, (s) => {
    water = attached(s, 0, s.players[0].active, 'water'); held = tool(s, 0, s.players[0].active); spare = bench(s, 0, 'other');
  });
  const g = setup(), old = g.snapshot().players[0].active, foe = g.snapshot().players[1].active.counters;
  attack(g);
  assert.equal(g.snapshot().players[1].active.counters, foe + 5, 'The damage (with the +30 Tool) comes first.');
  answer(g, ['perform']); answer(g, [old.id]);
  assert.equal(g.view(0).pending.kind, 'order-cards');
  const r = restore(g, f);
  for (const game of [g, r]) { answer(game, [held, old.stack[0], water]); settle(game); }
  assert.deepEqual(r.snapshot(), g.snapshot());
  const s = g.snapshot(), p = s.players[0];
  assert.deepEqual(p.deck.slice(0, 3), [water, old.stack[0], held], 'The first chosen is uppermost of the three, under the rest.');
  assert.equal(p.active.id, spare.id, 'The holder replaced the Active (JP Q&A ユクシー).');
  assert.equal(s.players[1].prizes.length, 6, 'Not a Knock Out.');
  // Declined: nothing moves.
  const kept = setup();
  attack(kept); answer(kept, ['skip']); settle(kept);
  assert.equal(kept.snapshot().players[0].active.id, old.id);
  // A forged board between the order prompt and the answer cannot change which cards go back.
  const forged = setup();
  attack(forged); answer(forged, ['perform']); answer(forged, [old.id]);
  const snap = clone(forged.snapshot()), a = snap.players[0].active;
  snap.players[0].hand.push(...a.tools.splice(0));
  const replay = OfficialGame.restore(snap, { catalog: f.catalog });
  assert.throws(() => answer(replay, [held, old.stack[0], water]), (e) => e instanceof EngineError && e.code === 'invalid-card-selection');
});

test('「将对手的战斗宝可梦与备战宝可梦互换。（…由对手选择。）然后，…将这只宝可梦放回牌库下方」: only once the switch happened', async () => {
  const pull = nested('cn.then@1', { first: nested('cn.switch@1', { side: 'opponent', chooser: 'opponent', affected: 'active' }),
    next: nested('cn.fieldReturn@1', returning({ attachments: 'discard' })) });
  const f = await fixture((defs) => {
    def(defs, 'other').mechanics.abilities = [ability('pull', [binding(pull.handlerId, pull.parameters, 'pull')], { condition: ONBENCH })];
    // Player 1's 'evolution' is protected from the effects of the opponent's Abilities (隠密フード in the JP Q&A).
    def(defs, 'evolution').mechanics.effects.push(binding('cn.protection@1', { effect: { op: 'protection', useRule: 'ordinary', channel: 'effects',
      scope: 'self', from: 'opponent', categories: ['ability'] } }, 'hood'));
  });
  let mon, water, foeBench;
  const g = board(f, (s) => { mon = bench(s, 0, 'other'); water = attached(s, 0, mon, 'water'); foeBench = bench(s, 1, 'other'); });
  use(g, mon.id, 'fixture:pull');
  assert.equal(g.snapshot().pending.player, 1, 'The opponent chooses the Pokémon put onto the Active Spot.');
  settle(g);
  const s = g.snapshot(), p = s.players[0];
  assert.equal(s.players[1].active.id, foeBench.id);
  assert.equal(p.deck[0], mon.stack[0], 'Under the deck.');
  assert(p.discard.includes(water));
  const lonely = board(f, (s) => { mon = bench(s, 0, 'other'); });
  assert.deepEqual(uses(lonely), [], 'No opposing Bench: it cannot be used (JP Q&A フィオネ).');
  const hooded = board(f, (s) => { mon = bench(s, 0, 'other'); evolve(s, 1, s.players[1].active); bench(s, 1, 'other'); });
  use(hooded, mon.id, 'fixture:pull'); settle(hooded);
  assert(hooded.snapshot().events.some((e) => e.ruleId === 'effects.protection'), 'It can be used; the protected Active stays.');
  assert(hooded.snapshot().players[0].bench.some((m) => m.id === mon.id), 'No switch, so it stays.');
});

test('「抛掷1次硬币如果为正面，则将对手的战斗宝可梦，以及放于其身上的所有卡牌，反面朝上重洗，放回对手的牌库下方」', async () => {
  const carry = returning({ side: 'opponent', target: 'active', to: 'shuffleBottom' });
  const f = await fixture((defs) => { def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.coin@1',
    { outcome: 'heads', effect: nested('cn.fieldReturn@1', carry) }, 'carry')]; });
  const setup = (heads) => board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water'); const foe = s.players[1].active;
    evolve(s, 1, foe); attached(s, 1, foe, 'double'); tool(s, 1, foe); bench(s, 1, 'other'); s.rng = seedFor([heads]);
  });
  const g = setup(true), foe = g.snapshot().players[1].active, cards = [...foe.stack, ...foe.energy, ...foe.tools];
  attack(g); settle(g);
  const s = g.snapshot();
  assert.deepEqual([...s.players[1].deck.slice(0, 4)].sort(), [...cards].sort(), 'All four under the deck, nowhere else.');
  assert.notEqual(s.players[1].active.id, foe.id);
  assert(s.events.some((e) => e.ruleId === 'effects.deck-order' && e.data.to === 'shuffleBottom' && e.data.count === 4));
  const miss = setup(false);
  attack(miss); settle(miss);
  assert.equal(miss.snapshot().players[1].active.id, foe.id);
});

test('「若希望，可将放于双方战斗宝可梦身上的所有卡牌，各放回牌库并重洗牌库」: not the evolution cards; before the Knock Out', async () => {
  const f = await fixture((defs) => {
    def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.optional@1', { effect: nested('cn.fieldReturn@1', attachedReturn()) }, 'downburst')];
    def(defs, 'evolution').mechanics.effects.push(binding('cn.protection@1', { effect: { op: 'protection', useRule: 'ordinary', channel: 'effects',
      scope: 'self', from: 'opponent', categories: ['attack'] } }, 'shield'));
    def(defs, 'potion').mechanics.effects = [binding('cn.fieldReturn@1', attachedReturn('own'), 'potion')];
  });
  let own, foe;
  const setup = (counters = 0) => board(f, (s) => {
    const a = s.players[0].active, b = s.players[1].active;
    own = [attached(s, 0, a, 'water'), tool(s, 0, a, 'hp-tool')];
    foe = [attached(s, 1, b, 'double'), tool(s, 1, b)]; b.counters = counters; bench(s, 1, 'other');
  });
  const g = setup(), base = g.snapshot().players[1].active.stack;
  attack(g); answer(g, ['perform']); settle(g);
  const s = g.snapshot();
  for (const id of own) assert(s.players[0].deck.includes(id));
  for (const id of foe) assert(s.players[1].deck.includes(id));
  assert.deepEqual(s.players[1].active.stack, base, 'The Pokémon stays.');
  assert.deepEqual([s.players[0].active.energy, s.players[0].active.tools, s.players[1].active.energy, s.players[1].active.tools], [[], [], [], []]);
  assert.deepEqual(s.events.filter((e) => e.ruleId === 'effects.shuffle').map((e) => e.data.player), [0, 1]);
  // The Tool of a Pokémon this attack Knocks Out goes back before the Knock Out (JP Q&A ケンホロウ×ねがいのバトン).
  const ko = setup(9);
  attack(ko); answer(ko, ['perform']); settle(ko);
  const k = ko.snapshot();
  for (const id of foe) assert(k.players[1].deck.includes(id));
  assert.equal(k.players[0].prizes.length, 5);
  // A protected opponent keeps its cards; the evolution cards beneath are never moved.
  const shielded = board(f, (s) => {
    const a = s.players[0].active, b = s.players[1].active;
    own = [attached(s, 0, a, 'water')]; evolve(s, 1, b); foe = [attached(s, 1, b, 'double')];
  });
  attack(shielded); answer(shielded, ['perform']); settle(shielded);
  const t = shielded.snapshot();
  assert(t.players[0].deck.includes(own[0])); assert.deepEqual(t.players[1].active.energy, foe);
  assert.deepEqual(t.events.filter((e) => e.ruleId === 'effects.shuffle').map((e) => e.data.player), [0]);
  // Nothing attached on the printed side: a Trainer cannot be played; the opponent's side alone shuffles nothing of the user's.
  let potion;
  const bare = board(f, (s) => { potion = hand(s, 0, 'potion'); });
  assert(!bare.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === potion));
  const loaded = board(f, (s) => { potion = hand(s, 0, 'potion'); attached(s, 0, s.players[0].active, 'water'); });
  command(loaded, { type: 'playTrainer', cardId: potion }); settle(loaded);
  assert.deepEqual(loaded.snapshot().players[0].active.energy, []);
  const theirs = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.fieldReturn@1', attachedReturn('opponent'), 'potion')]; });
  const plain = board(theirs, (s) => { potion = hand(s, 0, 'potion'); attached(s, 0, s.players[0].active, 'water'); });
  assert(!plain.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === potion), 'Only the printed side counts.');
  const charged = board(theirs, (s) => { potion = hand(s, 0, 'potion'); foe = [attached(s, 1, s.players[1].active, 'double')]; });
  command(charged, { type: 'playTrainer', cardId: potion }); settle(charged);
  assert(charged.snapshot().players[1].deck.includes(foe[0]));
});

test('「受到对手宝可梦的招式的伤害而【昏厥】时，不放于弃牌区，而是放回手牌」: still a Knock Out; with a Lost Zone effect the owner chooses', async () => {
  const immortal = binding('cn.knockoutZone@1', { effect: { op: 'knockoutZone', scope: 'self', cards: 'pokemon', to: 'hand', byOpponentAttack: true } }, 'immortal');
  const lostCity = binding('cn.knockoutZone@1', { effect: { op: 'knockoutZone', scope: 'all', cards: 'pokemon' } }, 'lost-city');
  const f = await fixture((defs) => {
    def(defs, 'evolution').mechanics.abilities = [{ abilityId: 'evolution:immortal', name: '测试不朽', mode: 'continuous', usage: null,
      effects: [immortal], sourceOfTruth: EVIDENCE }];
    def(defs, 'stadium').mechanics.effects = [lostCity];
  });
  let water, held, basic, evolution;
  const setup = (stadium = false) => board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water');
    const foe = s.players[1].active; basic = foe.stack[0]; evolution = evolve(s, 1, foe); foe.counters = 14;
    water = attached(s, 1, foe, 'water'); held = tool(s, 1, foe); s.players[1].discard.splice(0); bench(s, 1, 'other');
    if (stadium) { s.stadium = hand(s, 1, 'stadium'); s.players[1].hand.pop(); }
  });
  const g = setup();
  attack(g); settle(g);
  const s = g.snapshot();
  assert(s.players[1].hand.includes(basic) && s.players[1].hand.includes(evolution), 'The evolution cards beneath too.');
  assert(s.players[1].discard.includes(water) && s.players[1].discard.includes(held));
  assert.equal(s.players[0].prizes.length, 5, 'Prize cards are taken as usual.');
  assert(s.events.some((e) => e.ruleId === 'ko.hand'));
  // Both apply: the Knocked Out Pokémon's owner chooses which comes first (JP Q&A ギルガルド×ロストシティ).
  for (const choice of ['hand', 'lost']) {
    const both = setup(true);
    attack(both);
    const q = both.snapshot().pending;
    assert.deepEqual([q.kind, q.player, q.options], ['ko-zone', 1, ['hand', 'lost']]);
    const r = restore(both, f);
    for (const game of [both, r]) { answer(game, [choice]); settle(game); }
    assert.deepEqual(r.snapshot(), both.snapshot());
    const t = both.snapshot();
    assert.equal(t.players[1][choice].includes(evolution), true, choice);
    assert.equal(t.players[0].prizes.length, 5);
    if (choice === 'lost') assert(t.players[1].discard.includes(water));
  }
  // A forged chooser, other options, or a board where only one applies is rejected on restore.
  const forged = setup(true);
  attack(forged);
  for (const forge of [(snap) => { snap.pending.player = 0; }, (snap) => { snap.pending.options = ['lost', 'hand']; },
    (snap) => { snap.players[1].discard.push(snap.stadium); snap.stadium = null; }]) {
    const snap = clone(forged.snapshot()); forge(snap);
    assert.throws(() => OfficialGame.restore(snap, { catalog: f.catalog }), (e) => e instanceof EngineError && e.code === 'invalid-ko-zone');
  }
  // Without a record of earlier choices (receipt included), none has been made yet.
  const unrecorded = clone(forged.snapshot()); delete unrecorded.pending.data.zones;
  delete unrecorded.events.find((e) => e.ruleId === 'selection.request' && e.data.request?.id === unrecorded.pending.id).data.request.data.zones;
  assert.equal(OfficialGame.restore(unrecorded, { catalog: f.catalog }).snapshot().pending.kind, 'ko-zone', 'No choice made yet.');
  // Not by an attack's damage (Poison at the checkup): the discard pile as usual.
  const poison = board(f, (s) => { const foe = s.players[1].active; evolution = evolve(s, 1, foe); foe.counters = 14; foe.conditions.poison = 1;
    s.players[1].discard.splice(0); bench(s, 1, 'other'); });
  command(poison, { type: 'endTurn' }); settle(poison);
  assert(poison.snapshot().players[1].discard.includes(evolution));
});

test('「选择自己弃牌区中的1张【1阶进化】宝可梦（除「X」外）。然后，…放于弃牌区，将被选择的宝可梦放于这只宝可梦原先的位置」', async () => {
  const phantom = (selector) => (defs) => { def(defs, 'base').mechanics.abilities = [ability('phantom', [binding('cn.replacePokemon@1',
    { op: 'replacePokemon', target: 'self', from: 'discard', shuffleAfter: false, selector }, 'phantom')])]; };
  const stage1 = { kind: 'pokemon', stages: ['stage1'], excludeNameKeys: ['base'] };
  const f = await fixture(phantom(stage1));
  let target, water;
  const g = board(f, (s) => {
    target = put(s, 0, 'evolution', 'discard'); water = attached(s, 0, s.players[0].active, 'water'); s.players[0].active.counters = 3;
  });
  const old = g.snapshot().players[0].active, rng = g.snapshot().rng;
  use(g, old.id, 'fixture:phantom');
  const q = g.view(0).pending;
  assert.deepEqual([q.kind, q.options, q.minimum], ['select-cards', [target], 1]);
  const r = restore(g, f);
  for (const game of [g, r]) { answer(game, [target]); settle(game); }
  assert.deepEqual(r.snapshot(), g.snapshot());
  const s = g.snapshot(), fresh = s.players[0].active;
  assert.deepEqual([fresh.stack, fresh.counters, fresh.enteredTurn], [[target], 0, s.turn], 'A new Pokémon, just put into play.');
  for (const id of [...old.stack, water]) assert(s.players[0].discard.includes(id));
  assert.deepEqual(s.rng, rng, 'No shuffle.');
  assert.equal(s.players[1].prizes.length, 6);
  // No matching card in the discard pile: it cannot be used.
  const none = await fixture(phantom({ ...stage1, excludeNameKeys: ['evolution'] }));
  assert.deepEqual(uses(board(none, (s) => { put(s, 0, 'evolution', 'discard'); })), []);
  // Only a card that cannot be put into play this way: usable, nothing changes.
  const sealed = await fixture((defs) => { phantom(stage1)(defs); def(defs, 'evolution').mechanics.abilities = [{ abilityId: 'evolution:only',
    name: '测试限定', mode: 'continuous', usage: null, sourceOfTruth: EVIDENCE,
    effects: [binding('cn.enterOnlyBy@1', { abilityName: '测试其他', nameKeys: ['other'] }, 'only')] }]; });
  const h = board(sealed, (s) => { put(s, 0, 'evolution', 'discard'); });
  const before = h.snapshot().players[0].active;
  use(h, before.id, 'fixture:phantom'); settle(h);
  assert.equal(h.snapshot().players[0].active.id, before.id);
  assert.deepEqual(uses(h), [], 'The Ability was used.');
  // A forged discard pile between the choice and the answer is rejected.
  const k = board(f, (s) => { put(s, 0, 'evolution', 'discard'); put(s, 0, 'potion', 'discard'); });
  use(k, k.snapshot().players[0].active.id, 'fixture:phantom');
  const snap = clone(k.snapshot()); snap.players[0].discard.reverse();
  const replay = OfficialGame.restore(snap, { catalog: f.catalog });
  assert.throws(() => answer(replay, [replay.view(0).pending.options[0]]), (e) => e instanceof EngineError && e.code === 'invalid-pokemon-replacement');
});

test('「选择自己牌库中的1张「X」。然后，将这只宝可梦，以及放于其身上的所有卡牌，放于放逐区，将被选择的「X」，放于这只宝可梦先前的位置。并重洗牌库」', async () => {
  const f = await fixture((defs) => { def(defs, 'evolution').mechanics.abilities = [ability('sky', [binding('cn.replacePokemon@1',
    { op: 'replacePokemon', target: 'self', from: 'deck', shuffleAfter: true, to: 'lost', selector: { kind: 'pokemon', nameKeys: ['other'] } }, 'sky')])]; });
  let mon, water;
  const g = board(f, (s) => { mon = s.players[0].active; evolve(s, 0, mon); water = attached(s, 0, mon, 'water'); mon.counters = 4; });
  use(g, mon.id, 'fixture:sky');
  const [pick] = g.view(0).pending.options;
  answer(g, [pick]); settle(g);
  const s = g.snapshot(), fresh = s.players[0].active;
  for (const id of [...mon.stack, water]) assert(s.players[0].lost.includes(id), 'The Basic beneath too (JP Q&A ポポッコ).');
  assert.deepEqual([fresh.stack, fresh.counters], [[pick], 0], 'The damage counters are not moved over.');
  assert(s.events.some((e) => e.ruleId === 'effects.replace' && e.data.lost.length === 3));
  assert(s.events.some((e) => e.ruleId === 'effects.shuffle' && e.data.player === 0));
  // None found: it stays where it is and the deck is shuffled.
  const miss = board(f, (s) => { mon = s.players[0].active; evolve(s, 0, mon); });
  use(miss, mon.id, 'fixture:sky'); answer(miss, []); settle(miss);
  assert.equal(miss.snapshot().players[0].active.id, mon.id); assert.deepEqual(miss.snapshot().players[0].lost, []);
});
