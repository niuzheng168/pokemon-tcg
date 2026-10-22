// Synthetic definitions only. 「如果…的话，则这个招式失败」 (II.D-01 让自己的招式失败): a printed board, zone or
// history condition judged when the attack is used; and 「若希望，可…。在这种情况下，追加造成N伤害」 optional
// before-damage costs (II.E-10; II.B-02). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, assertSupportedDefinition } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const lit = (value) => ({ kind: 'literal', value });
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();
const undamagedFoe = { kind: 'compare', left: { kind: 'pokemon', who: 'opponentActive', field: 'damageCounters' }, relation: 'eq', right: lit(0) };
const failing = (predicate, effects = []) => (defs) => {
  for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 500; d.mechanics.weakness = null; d.mechanics.resistance = null; }
  for (const id of ['base', 'other']) {
    const a = def(defs, id).mechanics.attacks[0];
    a.printedDamage = { value: 60, operator: 'fixed' }; a.effects = effects; a.failureCheck = { predicate, sourceOfTruth: EVIDENCE };
  }
};
const strike = (g, attackId = 'base:strike') => command(g, { type: 'attack', attackId });

test('「如果对手的战斗宝可梦身上没有放置伤害指示物的话，则这个招式失败」: judged when used; a failed attack is still used', async () => {
  const f = await fixture(failing(undamagedFoe));
  for (const hurt of [0, 2]) {
    const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); s.players[1].active.counters = hurt; });
    const turn = g.snapshot().turn;
    strike(g); settle(g);
    const s = g.snapshot(), check = s.events.find((e) => e.ruleId === 'attack.failure.self');
    assert.deepEqual(check.data.receipt, { kind: 'predicate', passed: hurt > 0 });
    assert.equal(s.players[1].active.counters, hurt + (hurt ? 6 : 0));
    assert.equal(s.turn, turn + 1, 'Used either way: the turn ends.');
  }
});

test('a passed condition survives restore during the body; a forged receipt does not', async () => {
  const f = await fixture(failing(undamagedFoe, [binding('cn.switch@1', { side: 'own', chooser: 'self', affected: 'active' }, 'retreat')]));
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); s.players[1].active.counters = 1; bench(s, 0, 'other'); bench(s, 0, 'base'); });
  strike(g);
  const s = g.snapshot();
  assert.equal(s.pending.kind, 'effect-target');
  assert.deepEqual(OfficialGame.restore(clone(s), { catalog: f.catalog }).snapshot(), s);
  const forged = clone(s); forged.attack.execution.failureReceipt = { kind: 'predicate', passed: false };
  assert.throws(() => OfficialGame.restore(forged, { catalog: f.catalog }), (e) => e.code === 'invalid-attack-failure');
  answer(g, [s.pending.options[0]]); settle(g);
});

test('「在这个回合，如果这只宝可梦没有从备战区被放于战斗场上的话，则这个招式失败」 reads this Pokémon\'s own history', async () => {
  const f = await fixture(failing({ kind: 'not', condition: { kind: 'historyFact', fact: 'movedToActive' } }));
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); const m = bench(s, 0, 'other'); attached(s, 0, m, 'water'); });
  strike(g); settle(g);
  assert.equal(g.snapshot().events.find((e) => e.ruleId === 'attack.failure.self').data.receipt.passed, false);
  const h = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); const m = bench(s, 0, 'other'); attached(s, 0, m, 'water'); });
  command(h, { type: 'retreat' });
  settle(h, (q) => q.kind === 'retreat-target' ? [q.options[0]] : q.options.slice(0, Math.max(q.minimum, 1)));
  strike(h, 'other:strike'); settle(h);
  assert.equal(h.snapshot().events.find((e) => e.ruleId === 'attack.failure.self').data.receipt.passed, true);
});

test('load guard: only facts that exist when the attack is used', async () => {
  const catalog = { handler: (id) => handlers.get(id) };
  const f = await fixture();
  const mon = clone(def(f.definitions, 'base'));
  for (const predicate of [{ kind: 'compare', left: { kind: 'coin', key: 'x', field: 'heads' }, relation: 'eq', right: lit(0) },
    { kind: 'compare', left: { kind: 'pokemon', who: 'target', field: 'damageCounters' }, relation: 'eq', right: lit(0) },
    { kind: 'compare', left: { kind: 'prizes', side: 'own' }, relation: 'eq', right: lit(0) }]) {
    mon.mechanics.attacks[0].failureCheck = { predicate, sourceOfTruth: EVIDENCE };
    assert.throws(() => assertSupportedDefinition(catalog, mon), (e) => e.code === 'unsupported-condition');
  }
  mon.mechanics.attacks[0].failureCheck = { predicate: { kind: 'not', condition: { kind: 'stadiumInPlay', owner: 'any' } }, sourceOfTruth: EVIDENCE };
  assert.doesNotThrow(() => assertSupportedDefinition(catalog, mon));
});

// 「若希望，可…。在这种情况下，追加造成N伤害」 (II.E-10; II.B-02): an optional before-damage cost whose moved cards feed the damage.
const counted = (effect) => binding('cn.optionalCounted@1', { effect }, 'cost');
const bonus = (amount) => binding('cn.damageValue@1', { expression: { kind: 'add', terms: [lit(50), { kind: 'choose',
  condition: { kind: 'compare', left: { kind: 'effectCards', effectId: 'fixture:cost' }, relation: 'gt', right: lit(0) },
  ifTrue: lit(amount), ifFalse: lit(0) }] } }, 'formula');
const selfEnergy = (op, quantity, extra = {}) => ({ handlerId: 'cn.attachedEnergy@1', parameters: { op, side: 'own', from: 'self',
  selector: { kind: 'energy' }, providedTypes: null, measure: 'cards', quantity, chooser: 'source', ...extra } });
async function costly(effects) {
  return fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 500; d.mechanics.weakness = null; d.mechanics.resistance = null; }
    const a = defs[0].mechanics.attacks[0]; a.printedDamage = null; a.effects = effects;
  });
}
function paid(f, mutate, perform) {
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); mutate(s); });
  const from = g.snapshot().events.length;
  strike(g);
  settle(g, (q) => q.kind === 'optional-effect' ? [perform ? 'perform' : 'skip'] : q.allowZero && !perform ? [] : q.options.slice(0, Math.max(q.minimum, 1)));
  OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  return { g, damage: g.snapshot().events.slice(from).filter((e) => e.ruleId === 'attack.order' && Object.hasOwn(e.data, 'damage'))
    .reduce((n, e) => n + e.data.damage, 0) };
}

test('「若希望，可将附着于这只宝可梦身上的能量，全部放于弃牌区。在这种情况下，追加造成150」; returning them to hand counts too', async () => {
  const all = await costly([counted(selfEnergy('discardEnergy', { kind: 'all' })), bonus(150)]);
  const two = (s) => attached(s, 0, s.players[0].active, 'water');
  const yes = paid(all, two, true), no = paid(all, two, false);
  assert.deepEqual([yes.damage, yes.g.snapshot().players[0].active.energy.length], [200, 0]);
  assert.deepEqual([no.damage, no.g.snapshot().players[0].active.energy.length], [50, 2]);
  const back = await costly([counted(selfEnergy('returnEnergy', { kind: 'all' }, { to: 'hand' })), bonus(80)]);
  const r = paid(back, two, true);
  assert.deepEqual([r.damage, r.g.snapshot().players[0].active.energy.length], [130, 0]);
});

test('「若希望，可将场上的竞技场放于弃牌区…」 and 「若希望，选择自己的1张手牌，放于弃牌区…」 before damage', async () => {
  const stadium = await costly([counted({ handlerId: 'cn.discardStadium@1', parameters: { op: 'discardStadium', side: 'either',
    selector: { kind: 'trainer', categories: ['stadium'] } } }), bonus(120)]);
  const put = (s) => { const p = s.players[1]; const id = p.deck.find((c) => s.cards[c].definitionId === 'stadium'); p.deck.splice(p.deck.indexOf(id), 1); s.stadium = id; };
  const done = paid(stadium, put, true);
  assert.deepEqual([done.damage, done.g.snapshot().stadium], [170, null]);
  assert.equal(paid(stadium, () => {}, true).damage, 50, 'No Stadium in play: nothing moved, an explicit zero.');
  const handCost = await costly([counted({ handlerId: 'cn.cards@1', parameters: { from: 'hand', to: 'discard', selector: { kind: 'any' },
    quantity: { kind: 'exact', count: 1 }, reveal: false, lookTop: null, shuffleAfter: false } }), bonus(70)]);
  assert.deepEqual([paid(handCost, () => {}, true).damage, paid(handCost, () => {}, false).damage], [120, 50]);
});

test('optional counted costs: only the user\'s own movable things, only an attack\'s before-damage step', async () => {
  const h = handlers.get('cn.optionalCounted@1');
  assert(h.validateParameters({ effect: { handlerId: 'cn.discardTools@1', parameters: { side: 'own', target: 'self', quantity: { kind: 'all' } } } }));
  for (const effect of [selfEnergy('discardEnergy', { kind: 'all' }, { side: 'opponent' }), selfEnergy('moveEnergy', { kind: 'all' }),
    { handlerId: 'cn.cards@1', parameters: { from: 'discard', to: 'deck', selector: { kind: 'any' }, quantity: { kind: 'any' }, reveal: false,
      lookTop: null, shuffleAfter: true } }, { handlerId: 'cn.draw@1', parameters: { count: 1 } }])
    assert(!h.validateParameters(clone({ effect })), JSON.stringify(effect));
  const catalog = { handler: (id) => handlers.get(id) };
  const f = await fixture();
  const item = clone(def(f.definitions, 'potion'));
  item.mechanics.effects = [counted(selfEnergy('discardEnergy', { kind: 'all' }))];
  assert.throws(() => assertSupportedDefinition(catalog, item), (e) => e.code === 'unsupported-effect-count');
});
