// Synthetic definitions only. 「在自己的回合，当将这张卡牌从手牌使出放于备战区时，可使用1次。选择自己牌库中的1张「宝可梦道具」，放于这只宝可梦身上。
// 并重洗牌库。」 (effects.tool-attach, I.B-02, I.H, tools.capacity): a Tool put on this Pokémon by the effect, not played from the hand.
// No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();
const shoulder = { from: 'deck', to: 'self', selector: { kind: 'trainer', categories: ['tool'] }, quantity: { kind: 'exact', count: 1 },
  reveal: false, lookTop: null, shuffleAfter: true };
const onBench = { abilityId: 'fixture:shoulder', name: '测试登场背负', mode: 'triggered', usage: null, sourceOfTruth: EVIDENCE,
  trigger: { event: 'bench', origin: 'hand', subject: 'self', turn: 'own', scope: 'global', choiceOwner: 'source', optional: true },
  effects: [binding('cn.cards@1', shoulder, 'shoulder')] };

test('schema: one Tool from the deck (or discard pile) onto this Pokémon', () => {
  const v = (p) => handlers.get('cn.cards@1').validateParameters(clone(p));
  assert(requireRule(CN_V20261019, 'effects.tool-attach').sourceOfTruth.some((x) => x.documentId === 'JP-official-qa'));
  assert(v(shoulder)); assert(v({ ...shoulder, from: 'discard', shuffleAfter: false }));
  for (const p of [{ ...shoulder, selector: { kind: 'trainer' } }, { ...shoulder, selector: { kind: 'energy' } }, { ...shoulder, quantity: { kind: 'upTo', count: 2 } },
    { ...shoulder, from: 'hand', shuffleAfter: false }, { ...shoulder, from: 'discard', shuffleAfter: true }, { ...shoulder, side: 'opponent' },
    { ...shoulder, shuffleAfter: false }])
    assert(!v(p), JSON.stringify(p));
});

test('「当将这张卡牌从手牌使出放于备战区时…选择自己牌库中的1张「宝可梦道具」，放于这只宝可梦身上。并重洗牌库」', async () => {
  const f = await fixture((defs) => { def(defs, 'other').mechanics.abilities = [onBench]; });
  let card;
  // Both Tools in the deck.
  const g = board(f, (s) => { card = hand(s, 0, 'other'); for (const n of ['tool', 'hp-tool']) s.players[0].deck.unshift(hand(s, 0, n)), s.players[0].hand.pop(); });
  command(g, { type: 'bench', cardId: card });
  if (g.snapshot().pending?.kind !== 'inspect-deck' && g.snapshot().pending?.options.includes('perform')) answer(g, ['perform']);
  let q = g.snapshot().pending;
  assert.equal(q.kind, 'select-cards');
  const tools = q.options.map((id) => g.snapshot().cards[id].definitionId).sort();
  assert.deepEqual(tools, ['hp-tool', 'tool'], 'Only Tool cards.');
  restore(g, f);
  const hp = q.options.find((id) => g.snapshot().cards[id].definitionId === 'hp-tool');
  answer(g, [hp]); settle(g);
  const s = g.snapshot(), mon = s.players[0].bench.find((m) => m.stack[0] === card);
  assert.deepEqual(mon.tools, [hp]);
  assert.equal(mon.facts.toolFromHandTurn, undefined, 'Not played from the hand.');
  assert.equal(g.view(0).players[0].bench.find((m) => m.id === mon.id).effective.maxHp, 150);
  assert(s.events.some((e) => e.ruleId === 'effects.tool-attach' && e.data.cardId === hp));
  assert(s.events.some((e) => e.ruleId === 'effects.shuffle' && e.data.player === 0));
  // Nothing chosen: nothing attached, the deck still shuffled.
  const h = board(f, (s) => { card = hand(s, 0, 'other'); });
  command(h, { type: 'bench', cardId: card });
  settle(h, (q) => q.options.includes('perform') ? ['perform'] : q.kind === 'select-cards' ? [] : q.options.slice(0, q.minimum));
  assert.deepEqual(h.snapshot().players[0].bench[0].tools, []);
});

test('no room for a Tool on this Pokémon: nothing is looked through; a capacity of 2 leaves room', async () => {
  const attack = (extra = []) => fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 500; d.mechanics.weakness = null; d.mechanics.resistance = null; }
    defs[0].mechanics.attacks[0].effects = [binding('cn.cards@1', shoulder, 'shoulder')];
    defs[0].mechanics.abilities = extra;
  });
  const hold = (s) => { const t = hand(s, 0, 'tool'); s.players[0].hand.pop(); s.players[0].active.tools.push(t); const e = hand(s, 0, 'water'); s.players[0].hand.pop(); s.players[0].active.energy.push(e); };
  const full = await attack();
  const g = board(full, hold);
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  assert(g.snapshot().events.some((e) => e.ruleId === 'effects.tool-attach' && e.data.skipped === 'no-room'));
  assert(!g.snapshot().events.some((e) => e.ruleId === 'effects.search' && e.data.from === 'deck'));
  const roomy = await attack([{ abilityId: 'fixture:pack', name: '测试多道具', mode: 'continuous', usage: null, sourceOfTruth: EVIDENCE,
    effects: [binding('cn.toolCapacity@1', { effect: { op: 'toolCapacity', scope: 'self', count: 2 } }, 'pack')] }]);
  const h = board(roomy, hold);
  command(h, { type: 'attack', attackId: 'base:strike' });
  settle(h, (q) => q.kind === 'select-cards' ? q.options.slice(0, 1) : q.options.slice(0, q.minimum));
  assert.equal(h.snapshot().players[0].active.tools.length, 2);
  // The handler's own eligibility reads the host's answer.
  const c = handlers.get('cn.cards@1');
  const ctx = (room) => ({ source: { owner: 0, pokemonId: 'm1', category: 'ability' }, state: { players: [{ deck: ['x'], bench: [] }, { deck: [], bench: [] }] },
    benchLimits: [5, 5], ...(room === undefined ? {} : { sourceToolRoom: room }) });
  assert.deepEqual([true, false, undefined].map((room) => c.canUse(ctx(room), shoulder)), [true, false, false]);
  assert.equal(c.canUseWithCosts({ ...ctx(false), activation: { player: 0 } }, shoulder, []), false);
});
