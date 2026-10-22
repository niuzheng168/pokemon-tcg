// Synthetic definitions only. 「选择自己手牌／弃牌区中的1张能量，附着于…」 and 「…1张特殊能量…」 (II.C-09): any Energy card or
// only Special Energy; a Special Energy attached where it cannot stay is discarded (II.C-10 FAQ2). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { effectAttachable } from '../../public/rules/energy-selection.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();
const attach = (extra) => ({ type: null, count: 1, benchOnly: false, optional: false, ...extra });
const valid = (p) => handlers.get('cn.attachHand@1').validateParameters(clone(p));
const item = (handlerId, parameters, mutate = () => {}) => (defs) => { def(defs, 'potion').mechanics.effects = [binding(handlerId, parameters, 'attach')]; mutate(defs); };
const playable = (g, card) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card);
function toDiscard(s, owner, id) { const c = hand(s, owner, id); s.players[owner].hand.pop(); s.players[owner].discard.push(c); return c; }

test('schemas, rule and the shared attachable test', async () => {
  assert(requireRule(CN_V20261019, 'effects.attach').sourceOfTruth.some((s) => s.section.includes('II.C-10 FAQ2')));
  for (const p of [attach(), attach({ category: 'any' }), attach({ category: 'special', target: 'self' }), attach({ type: 'Water' })]) assert(valid(p), JSON.stringify(p));
  for (const p of [attach({ category: 'any', type: 'Water' }), attach({ category: 'basic' })]) assert(!valid(p), JSON.stringify(p));
  const f = await fixture((defs) => { def(defs, 'double').mechanics.attachCosts = [{ costId: 'fixture:fee', kind: 'discardHand', count: 1,
    selector: { kind: 'any' }, sourceOfTruth: EVIDENCE }]; });
  const water = def(f.definitions, 'water'), double = def(f.definitions, 'double'), potion = def(f.definitions, 'potion');
  assert.deepEqual([attach(), attach({ category: 'any' }), attach({ category: 'special' })].map((p) => [water, double, potion].map((d) => effectAttachable(d, p, 'discard'))),
    [[true, false, false], [true, true, false], [false, true, false]]);
  assert.equal(effectAttachable(double, attach({ category: 'any' }), 'hand'), false, 'Its own attach cost from hand needs a card-specific ruling.');
});

test('「选择自己手牌中的1张能量，附着于自己的宝可梦身上」 offers Basic and Special Energy; 「特殊能量」 only Special', async () => {
  const f = await fixture(item('cn.attachHand@1', attach({ category: 'any' })));
  let card, water, double;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); water = hand(s, 0, 'water'); double = hand(s, 0, 'double'); });
  command(g, { type: 'playTrainer', cardId: card });
  const q = g.view(0).pending;
  assert.equal(q.kind, 'hand-energy');
  assert(q.options.includes(water) && q.options.includes(double));
  answer(g, [double]); settle(g);
  assert(g.snapshot().players[0].active.energy.includes(double));
  OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  const special = await fixture(item('cn.attachHand@1', attach({ category: 'special' })));
  assert(!playable(board(special, (s) => { card = hand(s, 0, 'potion'); hand(s, 0, 'water'); }), card), 'No Special Energy in hand.');
  const h = board(special, (s) => { card = hand(s, 0, 'potion'); hand(s, 0, 'water'); double = hand(s, 0, 'double'); });
  assert(playable(h, card));
  command(h, { type: 'playTrainer', cardId: card });
  assert.deepEqual(h.view(0).pending.options, [double]);
});

test('「选择自己弃牌区中的1张能量，附着于这只宝可梦身上」; a Special Energy that cannot stay there is discarded', async () => {
  const f = await fixture((defs) => {
    const a = def(defs, 'base').mechanics.attacks[0];
    a.effects = [binding('cn.attachDiscard@1', attach({ category: 'any', target: 'self' }), 'recover')];
    def(defs, 'double').mechanics.remainOn = { kind: 'pokemon', nameKeys: ['other'] };
  });
  let double;
  const g = board(f, (s) => { const w = hand(s, 0, 'water'); s.players[0].hand.pop(); s.players[0].active.energy.push(w); double = toDiscard(s, 0, 'double'); });
  const from = g.snapshot().events.length;
  command(g, { type: 'attack', attackId: 'base:strike' });
  assert.deepEqual(g.view(0).pending.options, [double]);
  answer(g, [double]); settle(g);
  const s = g.snapshot();
  assert(!s.players[0].active.energy.includes(double) && s.players[0].discard.includes(double));
  assert(s.events.slice(from).some((e) => e.ruleId === 'energy.move' && e.data.energyId === double && e.data.discarded === 'attachment-condition'));
  assert(s.events.slice(from).some((e) => e.ruleId === 'turn.energy' && e.data.cardId === double), 'It was attached first.');
});
