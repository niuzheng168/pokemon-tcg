// Synthetic definitions only. Discarding attached Pokémon Tools (I.B-02; II.D-03 文例1) and counted before-damage discards
// of Tools and of hand/deck cards whose actual cards feed the damage (II.B-02). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, assertSupportedDefinition } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, board, command, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const lit = (value) => ({ kind: 'literal', value });
const handlers = createCoreHandlers();
const playable = (g, card) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card);
function hold(s, owner, mon, name) { const id = hand(s, owner, name); s.players[owner].hand.pop(); mon.tools.push(id); return id; }
const scrap = (extra) => ({ side: 'opponent', target: 'any', quantity: { kind: 'upTo', count: 2 }, ...extra });
const COUNT = 'fixture:count';
const formula = (expression) => binding('cn.damageValue@1', { expression }, 'formula');
async function attackWith(effects, transform = () => {}) {
  return fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 500; d.mechanics.weakness = null; d.mechanics.resistance = null; }
    const a = defs[0].mechanics.attacks[0]; a.printedDamage = null; a.effects = effects;
    // A Tool that does not change damage, so only the counts move the numbers.
    def(defs, 'tool').mechanics.effects = [binding('cn.modifier@1', { field: 'hp', amount: 10, scope: 'self' }, 'quiet-tool')];
    transform(defs);
  });
}
function dealt(f, mutate, policy) {
  const g = board(f, (s) => { mutate(s); attached(s, 0, s.players[0].active, 'water'); });
  const from = g.snapshot().events.length;
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g, policy);
  restore(g, f);
  return { g, damage: g.snapshot().events.slice(from).filter((e) => e.ruleId === 'attack.order' && Object.hasOwn(e.data, 'damage'))
    .reduce((n, e) => n + e.data.damage, 0) };
}

test('a Trainer discards up to two of the opponent\'s Tools to their owner\'s discard; none to choose, not playable', async () => {
  assert(requireRule(CN_V20261019, 'effects.tool-discard').sourceOfTruth.some((s) => s.section.includes('II.D-03')));
  const h = handlers.get('cn.discardTools@1');
  assert(h.validateParameters(scrap({ selector: { kind: 'trainer', nameKeys: ['tool'] } })));
  for (const bad of [scrap({ target: 'event' }), scrap({ selector: { kind: 'energy' } }), scrap({ side: 'either' })]) assert(!h.validateParameters(bad));
  const f = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.discardTools@1', scrap(), 'scrap')]; });
  let card, a, b;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); a = hold(s, 1, s.players[1].active, 'hp-tool'); b = hold(s, 1, bench(s, 1, 'other'), 'tool'); });
  assert.equal(g.view(1).players[1].active.effective.maxHp, 150);
  assert(playable(g, card));
  command(g, { type: 'playTrainer', cardId: card });
  assert.deepEqual([...g.view(0).pending.options].sort(), [a, b].sort());
  settle(g, () => [a]);
  const s = g.snapshot();
  assert(s.players[1].discard.includes(a) && !s.players[1].active.tools.length && s.players[1].bench[0].tools.includes(b));
  assert.equal(g.view(1).players[1].active.effective.maxHp, 100);
  restore(g, f);
  assert(!playable(board(f, (s) => { card = hand(s, 0, 'potion'); }), card));
  // The handler's own eligibility (where no native proof runs): the printed side, holders and kind of Tool.
  const mon = (id, tools) => ({ id, tools });
  const ctx = { source: { owner: 0, pokemonId: 'mine' }, definitions: Object.fromEntries(f.definitions.map((d) => [d.definitionId, d])),
    state: { cards: { t1: { definitionId: 'tool' }, t2: { definitionId: 'hp-tool' } },
      players: [{ active: mon('mine', ['t1']), bench: [] }, { active: mon('x', []), bench: [mon('y', ['t2'])] }] } };
  assert.deepEqual(['any', 'active', 'bench'].map((target) => h.canUse(ctx, scrap({ target }))), [true, false, true]);
  assert.deepEqual([h.canUse(ctx, scrap({ side: 'own', target: 'self' })), h.canUse(ctx, scrap({ selector: { kind: 'trainer', nameKeys: ['tool'] } }))],
    [true, false]);
});

test('Tools on a Pokémon protected from the effect cannot be chosen; that alone makes the Trainer unplayable', async () => {
  const f = await fixture((defs) => {
    def(defs, 'potion').mechanics.effects = [binding('cn.discardTools@1', scrap(), 'scrap')];
    def(defs, 'other').mechanics.abilities = [{ abilityId: 'fixture:veil', name: '测试防护', mode: 'continuous', usage: null, sourceOfTruth: EVIDENCE,
      effects: [binding('cn.protection@1', { effect: { op: 'protection', channel: 'effects', scope: 'self', from: 'opponent',
        categories: ['trainer'], useRule: 'ordinary' } }, 'veil')] }];
  });
  let card, open;
  assert(!playable(board(f, (s) => { card = hand(s, 0, 'potion'); hold(s, 1, bench(s, 1, 'other'), 'tool'); }), card));
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); hold(s, 1, bench(s, 1, 'other'), 'tool'); open = hold(s, 1, s.players[1].active, 'hp-tool'); });
  command(g, { type: 'playTrainer', cardId: card });
  assert.deepEqual(g.view(0).pending.options, [open]);
  settle(g, () => [open]);
});

test('II.B-02: before damage, the Tools actually discarded feed 「追加造成其张数×40」 and 「如果成功…则追加造成70」', async () => {
  const counted = (params) => binding('cn.countedToolDiscard@1', params, 'count');
  const f = await attackWith([counted({ side: 'own', target: 'any', quantity: { kind: 'any' } }),
    formula({ kind: 'add', terms: [lit(10), { kind: 'multiply', left: lit(40), right: { kind: 'effectCards', effectId: COUNT } }] })]);
  const two = (s) => { hold(s, 0, s.players[0].active, 'tool'); hold(s, 0, bench(s, 0, 'other'), 'hp-tool'); };
  assert.equal(dealt(f, two, (q) => q.kind === 'select-cards' ? [...q.options] : q.options.slice(0, q.minimum)).damage, 90);
  assert.equal(dealt(f, two, (q) => q.kind === 'select-cards' ? [] : q.options.slice(0, q.minimum)).damage, 10);
  assert.equal(dealt(f, () => {}).damage, 10, 'No Tools: an explicit zero.');
  const ifDone = await attackWith([counted({ side: 'opponent', target: 'active', quantity: { kind: 'all' } }),
    formula({ kind: 'choose', condition: { kind: 'compare', left: { kind: 'effectCards', effectId: COUNT }, relation: 'gt', right: lit(0) },
      ifTrue: lit(90), ifFalse: lit(20) })]);
  const { g, damage } = dealt(ifDone, (s) => { hold(s, 1, s.players[1].active, 'tool'); });
  assert.equal(damage, 90);
  assert.equal(g.snapshot().players[1].active.tools.length, 0);
  assert.equal(dealt(ifDone, () => {}).damage, 20);
});

test('II.B-02: hand and deck-top discards count all moved cards or those of a printed kind', async () => {
  const f = await attackWith([binding('cn.countedCards@1', { from: 'hand', to: 'discard', selector: { kind: 'energy', category: 'basic' },
    quantity: { kind: 'any' }, reveal: false, lookTop: null, shuffleAfter: false }, 'count'),
    formula({ kind: 'multiply', left: lit(60), right: { kind: 'effectCards', effectId: COUNT } })]);
  let picked;
  const pick = (q) => { if (q.kind !== 'select-cards') return q.options.slice(0, q.minimum); picked = q.options.slice(0, 2); return picked; };
  const { g, damage } = dealt(f, (s) => { hand(s, 0, 'water'); hand(s, 0, 'water'); }, pick);
  assert.equal(damage, 120);
  assert(picked.every((id) => g.snapshot().players[0].discard.includes(id)));
  const top = await attackWith([binding('cn.countedCards@1', { from: 'deck', to: 'discard', selector: { kind: 'any' },
    quantity: { kind: 'all' }, reveal: false, lookTop: 3, shuffleAfter: false }, 'count'),
    formula({ kind: 'multiply', left: lit(100), right: { kind: 'movedCards', effectId: COUNT, selector: { kind: 'energy' } } })]);
  const stack = (s) => { const p = s.players[0]; for (const id of ['potion', 'water', 'double']) { const c = hand(s, 0, id); p.hand.pop(); p.deck.push(c); } };
  const r = dealt(top, stack);
  assert.equal(r.damage, 200);
  assert.equal(r.g.snapshot().players[0].discard.length, 3);
  assert(handlers.get('cn.countedCards@1').validateParameters({ from: 'deck', to: 'discard', selector: { kind: 'any' }, quantity: { kind: 'all' },
    reveal: false, lookTop: 3, shuffleAfter: false }));
  assert(!handlers.get('cn.countedCards@1').validateParameters({ from: 'deck', to: 'hand', selector: { kind: 'any' }, quantity: { kind: 'all' },
    reveal: false, lookTop: 3, shuffleAfter: false }));
});

test('load guard: counted discards only in an attack\'s before-damage step; moved-card counts never in a use condition', async () => {
  const catalog = { handler: (id) => handlers.get(id) };
  const f = await fixture();
  const item = clone(def(f.definitions, 'potion'));
  item.mechanics.effects = [binding('cn.countedToolDiscard@1', scrap(), 'c')];
  assert.throws(() => assertSupportedDefinition(catalog, item), (e) => e.code === 'unsupported-effect-count');
  const conditioned = clone(def(f.definitions, 'potion'));
  conditioned.mechanics.condition = { predicate: { kind: 'compare', left: { kind: 'movedCards', effectId: 'x', selector: { kind: 'any' } },
    relation: 'gt', right: lit(0) } };
  assert.throws(() => assertSupportedDefinition(catalog, conditioned), (e) => e.code === 'unsupported-condition');
});
