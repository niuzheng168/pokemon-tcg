// Synthetic definitions only. II.C-11 「选择…中的N张（【X】）宝可梦，放于备战区」: putting Pokémon onto the Bench from the deck or
// discard pile means Basic Pokémon unless the card names it or its stage. II.D-04 「选择弃牌区中的N张…能量，附着于…」 without
// 「最多」: exactly N, or all there are if fewer. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { matchesDeploySelector, matchesCardsMove } from '../../public/rules/card-selection.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, board, command, answer, settle, hand, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();
const deploy = (selector) => ({ from: 'discard', to: 'bench', selector, quantity: { kind: 'upTo', count: 2 }, reveal: false,
  lookTop: null, shuffleAfter: false });
const attach = (extra) => ({ type: 'Water', count: 2, benchOnly: false, optional: false, ...extra });
function toDiscard(s, owner, id) { const c = hand(s, owner, id); s.players[owner].hand.pop(); s.players[owner].discard.push(c); return c; }
const playable = (g, card) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card);

test('II.C-11: the shared Bench test; the rule cites C-11 and D-04', async () => {
  assert(requireRule(CN_V20261019, 'effects.deploy').sourceOfTruth.some((s) => s.section.includes('II.C-11')));
  assert(requireRule(CN_V20261019, 'selection.exact').sourceOfTruth.some((s) => s.section.includes('II.D-04')));
  const f = await fixture();
  const basic = def(f.definitions, 'base'), stage1 = def(f.definitions, 'evolution'), item = def(f.definitions, 'potion');
  const water = { kind: 'pokemon', types: ['Water'] };
  assert.deepEqual([basic, stage1, item].map((d) => matchesDeploySelector(d, water)), [true, false, false]);
  assert.equal(matchesDeploySelector(stage1, { kind: 'pokemon', nameKeys: ['evolution'] }), true, 'A named card as printed.');
  assert.equal(matchesDeploySelector(stage1, { kind: 'pokemon', stages: ['stage1'] }), true, 'A printed stage as printed.');
  assert.equal(matchesDeploySelector(stage1, { anyOf: [{ kind: 'pokemon', nameKeys: ['other'] }, { kind: 'pokemon', types: ['Water'] }] }), false);
  assert.equal(matchesDeploySelector(item, { kind: 'any' }), false, 'Only Pokémon go onto the Bench.');
  assert.equal(matchesCardsMove(stage1, { to: 'hand', selector: water }), true, 'Other destinations keep the printed selector.');
  assert.throws(() => matchesDeploySelector(basic, { kind: 'nothing' }), TypeError);
  // 「3张【火】属性的「宝可梦GX・EX」，放于备战区」: printed Pokémon alternatives; never a non-Pokémon alternative.
  const valid = (selector) => handlers.get('cn.cards@1').validateParameters({ ...deploy(selector), quantity: { kind: 'exact', count: 3 } });
  assert.equal(valid({ anyOf: [{ kind: 'pokemon', types: ['Fire'], tagsAll: ['GX'] }, { kind: 'pokemon', types: ['Fire'], tagsAll: ['EX'] }] }), true);
  assert.equal(valid({ anyOf: [{ kind: 'pokemon' }, { kind: 'energy' }] }), false);
  assert.equal(valid({ kind: 'any' }), false);
});

test('「选择自己弃牌区中最多2张【水】宝可梦，放于备战区」 offers Basic Pokémon only; with none it cannot be played', async () => {
  const f = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.cards@1', deploy({ kind: 'pokemon', types: ['Water'] }), 'deploy')]; });
  let card, basic, stage1;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); basic = toDiscard(s, 0, 'other'); stage1 = toDiscard(s, 0, 'evolution'); });
  assert(playable(g, card));
  command(g, { type: 'playTrainer', cardId: card });
  assert.deepEqual(g.view(0).pending.options, [basic]);
  OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  answer(g, [basic]); settle(g);
  const p = g.snapshot().players[0];
  assert(p.bench.some((m) => m.stack.includes(basic)) && p.discard.includes(stage1));
  const h = board(f, (s) => { card = hand(s, 0, 'potion'); toDiscard(s, 0, 'evolution'); });
  assert(!playable(h, card), 'Only a Stage 1 Pokémon in the discard pile.');
  const ctx = (s) => ({ state: s, definitions: Object.fromEntries(f.definitions.map((d) => [d.definitionId, d])),
    source: { owner: 0, category: 'trainer', instanceId: card }, benchLimits: [5, 5] });
  assert.equal(handlers.get('cn.cards@1').canUse(ctx(h.snapshot()), deploy({ kind: 'pokemon', types: ['Water'] })), false);
  assert.equal(handlers.get('cn.cards@1').canUse(ctx(h.snapshot()), deploy({ kind: 'pokemon', nameKeys: ['evolution'] })), true);
});

test('II.D-04: 「选择自己弃牌区中的2张基本【水】能量，附着于这只宝可梦身上」 takes exactly 2, or all there are', async () => {
  const valid = (p) => handlers.get('cn.attachDiscard@1').validateParameters(clone(p));
  assert(valid(attach({ exact: true, target: 'self' })));
  assert(!valid(attach({ exact: true, optional: true })), 'Exactly N is not optional.');
  assert(!valid(attach({ exact: false })));
  const f = await fixture((defs) => { def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.attachDiscard@1', attach({ exact: true, target: 'self' }), 'recover')]; });
  for (const discarded of [3, 1]) {
    let energies;
    const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); energies = Array.from({ length: discarded }, () => toDiscard(s, 0, 'water')); });
    command(g, { type: 'attack', attackId: 'base:strike' });
    const q = g.view(0).pending;
    assert.deepEqual([q.minimum, q.maximum], [Math.min(2, discarded), Math.min(2, discarded)]);
    if (q.minimum > 1) assert.throws(() => answer(g, energies.slice(0, 1)), 'Fewer than printed cannot be chosen.');
    answer(g, energies.slice(0, q.minimum)); settle(g);
    assert.equal(g.snapshot().players[0].active.energy.length, 1 + Math.min(2, discarded));
  }
  const upTo = await fixture((defs) => { def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.attachDiscard@1', attach({ target: 'self' }), 'recover')]; });
  const g = board(upTo, (s) => { attached(s, 0, s.players[0].active, 'water'); toDiscard(s, 0, 'water'); toDiscard(s, 0, 'water'); });
  command(g, { type: 'attack', attackId: 'base:strike' });
  assert.deepEqual([g.view(0).pending.minimum, g.view(0).pending.maximum], [1, 2], 'II.D-05 「最多2张」.');
});
