// Synthetic definitions only. 「将任意数量的自己的备战宝可梦放于弃牌区，追加造成被放于弃牌区的备战宝可梦数量×40点伤害。」,
// 「将自己备战区中任意数量的「刺梭鱼」放于弃牌区，造成其张数×60点伤害。」, 「将自己备战区中，最多与对手场上宝可梦数量相同数量的「多龙梅西亚」放于
// 弃牌区，选择与放于弃牌区数量相同数量的对手宝可梦。然后，给所有被选择的宝可梦，在不计算弱点、抗性的前提下，各造成100点伤害。」 and
// 「选择自己备战区中的1只「三蜜蜂」，将那只宝可梦，以及放于其身上的所有卡牌，放回牌库并重洗牌库。如果无法放回牌库的话，则这个招式失败。」
// (damage.bench-count; JP official Q&A アマージョV「クイーンオーダー」, ウッウ「れんぞくうのミサイル」, ドラパルト「ドラゴンランチャー」).
// No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, EngineError } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, bench, attached, hand } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const lit = (value) => ({ kind: 'literal', value });
const handler = createCoreHandlers().get('cn.countedFieldReturn@1');
const discardBench = (selector = { kind: 'pokemon' }, extra = {}) => ({ op: 'returnPokemon', side: 'own', target: 'bench', selector,
  quantity: { kind: 'any' }, to: 'discard', attachments: 'discard', chooser: 'source', ...extra });
const times = (n, base = 0) => binding('cn.damageValue@1', { expression: { kind: 'add', terms: [lit(base),
  { kind: 'multiply', left: lit(n), right: { kind: 'effectCards', effectId: 'fixture:order' } }] } }, 'damage');
// The attacking 'base' (Water, no Weakness here) uses 「女王的指令」 (printed 20+); every Pokémon has 300 HP.
// Test-only deck shape: four of each Basic, two Stage 1 and a Fire Energy.
const queen = async (transform = () => {}, parameters = discardBench(), formula = times(40, 20)) => {
  const f = await fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 300; d.mechanics.weakness = null; }
    const a = def(defs, 'base').mechanics.attacks[0];
    a.printedDamage = { value: 20, operator: 'plus' };
    a.effects = [binding('cn.countedFieldReturn@1', parameters, 'order'), formula];
    transform(defs);
  });
  f.deck.splice(20, 6, 'printing:base', 'printing:base', 'printing:other', 'printing:other', 'printing:evolution', 'printing:fire');
  return f;
};
const evolved = (s, owner) => {
  const m = bench(s, owner, 'base'); m.stack.push(hand(s, owner, 'evolution')); s.players[owner].hand.pop(); return m;
};
const strike = (g) => command(g, { type: 'attack', attackId: 'base:strike' });
const counts = (g) => g.snapshot().events.filter((e) => e.ruleId === 'damage.effect-count').map((e) => e.data.cards.length);

test('handler: CN sources, before-damage timing, own Benched Pokémon only', () => {
  assert.equal(handler.timing, 'beforeDamage'); assert.deepEqual(handler.operations, ['returnPokemon']);
  assert(handler.capabilities.includes('effect-card-count'));
  for (const id of ['damage.bench-count', 'damage.effect-count', 'effects.field-return'])
    for (const source of requireRule(CN_V20261019, id).sourceOfTruth) assert(handler.sourceOfTruth.includes(source));
  assert(handler.validateParameters(discardBench()));
  assert(handler.validateParameters(discardBench({ kind: 'pokemon', nameKeys: ['other'] }, { quantity: { kind: 'exact', count: 1 },
    to: 'deckShuffle', attachments: 'return' })));
  for (const bad of [{ side: 'opponent' }, { target: 'any', promotion: { timing: 'afterRelatedResolution', sourceOfTruth: EVIDENCE } },
    { attachments: 'return' }, { extra: true }])
    assert(!handler.validateParameters(discardBench(undefined, bad)));
});

test('any number of own Benched Pokémon, each with all its cards, before damage; an evolved one counts once; not a Knock Out', async () => {
  const f = await queen();
  let mons;
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water');
    mons = [bench(s, 0, 'other'), evolved(s, 0), bench(s, 0, 'base')];
    attached(s, 0, mons[1], 'water');
  });
  strike(g);
  const q = g.snapshot().pending;
  assert.equal(q.kind, 'return-pokemon'); assert.deepEqual(q.options, mons.map((m) => m.id));
  assert.equal(q.minimum, 0); assert.equal(q.maximum, 3);
  restore(g, f);
  const cards = [...mons[0].stack, ...mons[1].stack, ...mons[1].energy];
  answer(g, [mons[0].id, mons[1].id]); settle(g);
  const s = g.snapshot();
  assert.deepEqual(s.players[0].bench.map((m) => m.id), [mons[2].id]);
  assert(cards.every((id) => s.players[0].discard.includes(id)), 'Every card of both Pokémon to the discard pile.');
  assert.deepEqual(counts(g), [2], 'Two Pokémon, though three Pokémon cards.');
  assert.equal(s.players[1].active.counters, 10, '20 + 2×40.');
  assert.equal(s.players[1].prizes.length, 6, 'Discarded, not Knocked Out: no Prize card.');
  assert(!s.events.some((e) => e.ruleId === 'ko.boundary' && e.data.owner === 0));
  restore(g, f);
});

test('none chosen, or no Benched Pokémon at all, records an explicit zero', async () => {
  const f = await queen();
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); bench(s, 0, 'other'); });
  strike(g); answer(g, []); settle(g);
  assert.deepEqual(counts(g), [0]); assert.equal(g.snapshot().players[0].bench.length, 1);
  assert.equal(g.snapshot().players[1].active.counters, 2);
  const h = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); });
  strike(h); assert.equal(h.snapshot().pending, null); settle(h);
  assert.deepEqual(counts(h), [0]); assert.equal(h.snapshot().players[1].active.counters, 2);
});

test('discarded before damage: a Benched Pokémon\'s own damage boost no longer applies (JP Q&A レジストシェード)', async () => {
  const f = await queen((defs) => {
    def(defs, 'other').mechanics.effects = [binding('cn.modifier@1', { field: 'attackDamage', amount: 30, scope: 'own',
      targetSide: 'opponent', targetPosition: 'active' }, 'boost')];
  });
  let booster;
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); booster = bench(s, 0, 'other'); });
  const kept = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  strike(g); answer(g, [booster.id]); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 6, '20 + 40; the +30 left with it.');
  strike(kept); answer(kept, []); settle(kept);
  assert.equal(kept.snapshot().players[1].active.counters, 5, '20 + 30 while it stays.');
});

test('「将自己备战区中任意数量的「X」放于弃牌区，造成其张数×60」: only Benched Pokémon now named X, not one under an evolution', async () => {
  const f = await queen(() => {}, discardBench({ kind: 'pokemon', nameKeys: ['base'] }), times(60));
  let mons;
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); mons = [bench(s, 0, 'base'), evolved(s, 0), bench(s, 0, 'base')]; });
  strike(g);
  assert.deepEqual(g.snapshot().pending.options, [mons[0].id, mons[2].id], 'The Basic under the evolved Pokémon is not a Benched 「X」.');
  answer(g, [mons[0].id, mons[2].id]); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 12);
  assert.deepEqual(g.snapshot().players[0].bench.map((m) => m.id), [mons[1].id]);
});

// 「蜂女王」: printed 120; the failure condition is judged when the attack is used, the return comes before damage.
const queenBee = () => queen((defs) => {
  const a = def(defs, 'base').mechanics.attacks[0];
  a.printedDamage = { value: 120, operator: 'fixed' };
  a.effects = [a.effects[0]];
  a.failureCheck = { predicate: { kind: 'compare', left: { kind: 'pokemonCount', side: 'own', zone: 'bench',
    selector: { kind: 'pokemon', nameKeys: ['other'] } }, relation: 'eq', right: lit(0) }, sourceOfTruth: EVIDENCE };
}, discardBench({ kind: 'pokemon', nameKeys: ['other'] }, { quantity: { kind: 'exact', count: 1 }, to: 'deckShuffle', attachments: 'return' }));

test('「选择自己备战区中的1只「X」…放回牌库并重洗牌库。如果无法放回牌库的话，则这个招式失败」: one must go back, then the damage', async () => {
  const f = await queenBee();
  let mons, energy;
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water');
    mons = [bench(s, 0, 'other'), bench(s, 0, 'other'), bench(s, 0, 'base')];
    energy = attached(s, 0, mons[1], 'fire');
  });
  const deck = g.snapshot().players[0].deck.length;
  strike(g);
  const q = g.snapshot().pending;
  assert.deepEqual(q.options, [mons[0].id, mons[1].id]); assert.equal(q.minimum, 1); assert.equal(q.maximum, 1);
  answer(g, [mons[1].id]); settle(g);
  const s = g.snapshot();
  assert.equal(s.players[0].deck.length, deck + 2); assert(s.players[0].deck.includes(energy));
  assert(s.events.some((e) => e.ruleId === 'effects.field-return' && e.data.pokemonId === mons[1].id && e.data.to === 'deckShuffle'));
  assert.equal(s.players[1].active.counters, 12); assert.deepEqual(counts(g), [1]);
  restore(g, f);
});

test('no 「X」 on the Bench: the attack fails, nothing is dealt and the turn ends', async () => {
  const f = await queenBee();
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); bench(s, 0, 'base'); });
  strike(g); settle(g);
  const s = g.snapshot();
  assert.equal(s.players[1].active.counters, 0); assert.equal(s.current, 1);
  assert(s.events.some((e) => e.ruleId === 'attack.failure.self' && e.data.receipt.passed === false));
  assert.deepEqual(counts(g), []);
});

test('placement: only an attack before damage; a coin failure check with it stays unsupported', async () => {
  const f = await queen((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.countedFieldReturn@1', discardBench(), 'order')]; });
  assert.throws(() => board(f), (e) => e instanceof EngineError && e.code === 'unsupported-effect-count');
  const c = await queen((defs) => {
    def(defs, 'base').mechanics.attacks[0].failureCheck = { coin: { mode: 'fixed', count: 1, minimumHeads: 1 }, sourceOfTruth: EVIDENCE };
  });
  assert.throws(() => board(c), (e) => e instanceof EngineError && e.code === 'unsupported-failure-timing');
});

// 「多龙巴鲁托」: up to as many 「X」 ('other') as the opponent has Pokémon, then that many different opponent's Pokémon, 100 each.
const upToTheirs = discardBench({ kind: 'pokemon', nameKeys: ['other'] }, { quantity: { kind: 'upTo',
  count: { kind: 'pokemonCount', side: 'opponent', zone: 'field' } } });
const launch = { side: 'opponent', target: 'any', amount: 100, selection: { kind: 'exact', count: { kind: 'effectCards', effectId: 'fixture:order' } },
  options: { ignoreWeakness: true, ignoreResistance: true } };
const launcher = () => queen((defs) => {
  const a = def(defs, 'base').mechanics.attacks[0];
  a.printedDamage = null;
  def(defs, 'base').mechanics.weakness = { type: 'Water', operation: 'multiply', value: 2 };
}, upToTheirs, binding('cn.damage@1', launch, 'launch'));
const damaged = (g) => [g.snapshot().players[1].active, ...g.snapshot().players[1].bench].map((m) => m.counters);

test('schemas: a computed maximum only for the counted departure, a computed number of targets only for damage to others', () => {
  const handlers = createCoreHandlers(), damage = handlers.get('cn.damage@1').validateParameters;
  assert(handler.validateParameters(upToTheirs)); assert(damage(launch));
  assert(!handlers.get('cn.fieldReturn@1').validateParameters(upToTheirs), 'A plain departure has a printed number.');
  assert(!handler.validateParameters({ ...upToTheirs, quantity: { kind: 'exact', count: upToTheirs.quantity.count } }));
  assert(!handlers.get('cn.recoilDamage@1').validateParameters({ ...launch, side: 'own', target: 'self' }));
  assert(!damage({ ...launch, selection: { kind: 'upTo', count: launch.selection.count } }));
  assert(damage({ ...launch, selection: { kind: 'exact', count: 2 } }));
});

test('「最多与对手场上宝可梦数量相同数量的「X」…选择与放于弃牌区数量相同数量的对手宝可梦」: 1 to their count, then that many different targets (JP Q&A)', async () => {
  const f = await launcher();
  let mons, theirs;
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water');
    mons = [bench(s, 0, 'other'), bench(s, 0, 'other'), bench(s, 0, 'other'), bench(s, 0, 'base')];
    theirs = [bench(s, 1, 'base'), bench(s, 1, 'other')];
  });
  strike(g);
  const q = g.snapshot().pending;
  assert.equal(q.kind, 'return-pokemon'); assert.deepEqual(q.options, mons.slice(0, 3).map((m) => m.id));
  assert.equal(q.minimum, 1); assert.equal(q.maximum, 3, 'Three opponent\'s Pokémon: up to three, and only one is fine.');
  restore(g, f);
  answer(g, [mons[0].id]);
  const t = g.snapshot().pending;
  assert.equal(t.kind, 'damage-targets'); assert.equal(t.minimum, 1); assert.equal(t.maximum, 1); assert.equal(t.options.length, 3);
  restore(g, f);
  answer(g, [theirs[1].id]); settle(g);
  assert.deepEqual(damaged(g), [0, 0, 10]); assert.deepEqual(counts(g), [1]);
  restore(g, f);
  // Every one of their Pokémon chosen: each takes 100, Weakness not applied to the Active.
  const h = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); mons = [bench(s, 0, 'other'), bench(s, 0, 'other')]; bench(s, 1, 'base'); });
  strike(h); answer(h, mons.map((m) => m.id)); settle(h);
  assert.deepEqual(damaged(h), [10, 10]); assert.equal(h.snapshot().players[0].bench.length, 0);
});

test('only one opponent\'s Pokémon: at most one 「X」; one Pokémon of two cards is one target; none on the Bench deals nothing (JP Q&A ドラパルト)', async () => {
  const f = await launcher();
  let mons;
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water');
    const m = bench(s, 0, 'base'); m.stack.push(hand(s, 0, 'other')); s.players[0].hand.pop();
    mons = [m, bench(s, 0, 'other')];
  });
  strike(g);
  assert.deepEqual(g.snapshot().pending.options, mons.map((m) => m.id)); assert.equal(g.snapshot().pending.maximum, 1);
  answer(g, [mons[0].id]); settle(g);
  assert.deepEqual(damaged(g), [10]); assert.deepEqual(counts(g), [1], 'Two cards, one Pokémon.');
  assert(mons[0].stack.every((id) => g.snapshot().players[0].discard.includes(id)));
  const none = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); bench(s, 0, 'base'); });
  strike(none); settle(none);
  assert.deepEqual(damaged(none), [0]); assert.deepEqual(counts(none), [0]);
  assert.equal(none.snapshot().players[0].bench.length, 1); assert.equal(none.snapshot().current, 1);
  restore(none, f);
});

test('the computed maximum and number of targets are receipts: a forged count is rejected on restore', async () => {
  const f = await launcher();
  let mons;
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); mons = [bench(s, 0, 'other'), bench(s, 0, 'other')]; bench(s, 1, 'base'); });
  const forge = (handlerId, edit) => {
    const forged = clone(g.snapshot());
    edit(forged.events.find((e) => e.ruleId === 'effects.execution' && e.data.kind === 'opened' && e.data.binding.handlerId === handlerId).data.program[0]);
    assert.throws(() => OfficialGame.restore(forged, { catalog: f.catalog }), (e) => e.code === 'invalid-effect-execution');
  };
  strike(g);
  forge('cn.countedFieldReturn@1', (a) => { a.quantity.count = 5; });
  answer(g, [mons[0].id]);
  assert.equal(g.snapshot().pending.kind, 'damage-targets');
  restore(g, f);
  forge('cn.damage@1', (a) => { a.selection.count = 2; });
  forge('cn.damage@1', (a) => { a.amount = 200; });
});
