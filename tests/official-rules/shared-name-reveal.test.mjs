// Synthetic definitions only. 「双方互相展示手牌，如果对手手牌中有和自己手牌中同名的卡牌，则追加造成90点伤害。」 (printed 「30+」;
// effects.reveal, effects.shared-name: both whole hands shown before damage, card names compared). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, assertSupportedDefinition } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { requireRule } from '../../public/rules/registry.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { fixture, binding, board, command, settle, hand, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const lit = (value) => ({ kind: 'literal', value });
const handlers = createCoreHandlers();
const valid = (id, p) => handlers.get(id).validateParameters(clone(p));
const SHOW = 'fixture:show';
const shared = (extra = {}) => ({ kind: 'movedCards', effectId: SHOW, selector: { kind: 'any' }, sharedName: true, ...extra });
const formula = (count = shared()) => binding('cn.damageValue@1', { expression: { kind: 'choose',
  condition: { kind: 'compare', left: count, relation: 'gt', right: lit(0) }, ifTrue: lit(120), ifFalse: lit(30) } }, 'formula');
const reveal = binding('cn.countedReveal@1', { from: 'bothHands' }, 'show');
async function attackWith(effects, transform = () => {}) {
  return fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 500; d.mechanics.weakness = null; }
    const a = def(defs, 'base').mechanics.attacks[0]; a.printedDamage = null; a.effects = effects;
    transform(defs);
  });
}
// Player 0 attacks with exactly `own` in hand; player 1 holds exactly `theirs`.
function dealt(f, own, theirs) {
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water');
    for (const p of s.players) p.deck.push(...p.hand.splice(0));
    for (const id of own) hand(s, 0, id);
    for (const id of theirs) hand(s, 1, id);
  });
  const from = g.snapshot().events.length;
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  const events = g.snapshot().events.slice(from);
  return { events, damage: events.filter((e) => e.ruleId === 'attack.order' && Object.hasOwn(e.data, 'damage')).reduce((n, e) => n + e.data.damage, 0) };
}

test('schema and rule: a both-hands reveal and a shared-name count', () => {
  assert(requireRule(CN_V20261019, 'effects.shared-name').sourceOfTruth.length);
  assert(valid('cn.countedReveal@1', { from: 'bothHands' }));
  assert(!valid('cn.countedReveal@1', { from: 'bothHands', selector: { kind: 'any' } }));
  const formulaOf = (count) => valid('cn.damageValue@1', formula(count).parameters);
  assert(formulaOf(shared()));
  assert(formulaOf(shared({ selector: { kind: 'trainer' } })));
  assert(!formulaOf(shared({ sharedName: false })));
  assert(!formulaOf(shared({ distinct: 'types' })));
});

test('「如果对手手牌中有和自己手牌中同名的卡牌，则追加造成90点伤害」', async () => {
  const f = await attackWith([reveal, formula()]);
  const same = dealt(f, ['potion', 'research'], ['tool', 'potion']);
  assert.equal(same.damage, 120);
  const shown = same.events.filter((e) => e.ruleId === 'effects.reveal');
  assert.deepEqual(shown.map((e) => [e.data.player, e.data.cards.map((c) => c.definitionId)]), [[0, ['potion', 'research']], [1, ['tool', 'potion']]],
    'Both hands are shown to both players, the user\'s first.');
  assert(shown.every((e) => e.visibility === 'public'));
  const damageAt = same.events.findIndex((e) => e.ruleId === 'attack.order' && Object.hasOwn(e.data, 'damage'));
  assert(same.events.findIndex((e) => e.ruleId === 'effects.reveal') < damageAt, 'Shown before the damage.');
  assert.equal(dealt(f, ['potion'], ['research', 'tool']).damage, 30, 'No card of the same name.');
  assert.equal(dealt(f, ['water'], ['water']).damage, 120, 'Basic Energy of one name.');
  assert.equal(dealt(f, [], ['potion']).damage, 30, 'The user has no hand.');
  assert.equal(dealt(f, ['potion'], []).damage, 30, 'The opponent has no hand.');
  assert.equal(dealt(f, ['potion', 'potion'], ['research']).damage, 30, 'Two of the same name in the user\'s own hand do not count.');
});

test('the same name, not the same card definition; a printed kind narrows the opponent\'s cards', async () => {
  // Another definition printed with the name 「测试伤药」 (one name identity, as for deck limits).
  const f = await attackWith([reveal, formula()], (defs) => {
    defs.push({ ...clone(def(defs, 'potion')), definitionId: 'potion-reprint' });
  });
  assert.equal(f.catalog.definition('potion-reprint').nameKey, 'potion');
  f.deck[f.deck.indexOf('printing:water')] = 'printing:potion-reprint';
  assert.equal(dealt(f, ['potion'], ['potion-reprint']).damage, 120);
  const trainers = await attackWith([reveal, formula(shared({ selector: { kind: 'energy' } }))]);
  assert.equal(dealt(trainers, ['potion'], ['potion']).damage, 30, 'Only matching Energy cards count.');
  assert.equal(dealt(trainers, ['water'], ['water']).damage, 120);
});

test('load guards: the names come from this attack\'s own both-hands reveal, which nothing moves on', async () => {
  const f = await attackWith([binding('cn.countedReveal@1', { from: 'deck', lookTop: 1 }, 'show'), formula()]);
  const d = f.catalog.definition('base');
  assert.throws(() => assertSupportedDefinition(f.catalog, d), (e) => e.code === 'unsupported-effect-count');
  const moved = await attackWith([reveal, formula(), binding('cn.revealedCards@1', { effectId: SHOW, to: 'discard' }, 'route')]);
  assert.throws(() => assertSupportedDefinition(moved.catalog, moved.catalog.definition('base')), (e) => e.code === 'unsupported-effect-count');
});
