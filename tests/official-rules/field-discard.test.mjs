// Synthetic definitions only. 「将…宝可梦，以及放于其身上的所有卡牌，放于弃牌区」 (II.C-01): a Pokémon in play and all its
// cards to their owner's discard pile; this is not a Knock Out, so no Prize card is taken. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();
const discarding = (extra = {}) => ({ op: 'returnPokemon', side: 'own', target: 'bench', selector: { kind: 'pokemon' },
  quantity: { kind: 'exact', count: 1 }, to: 'discard', attachments: 'discard', chooser: 'source',
  promotion: { timing: 'afterAction', sourceOfTruth: EVIDENCE }, ...extra });
const valid = (p) => handlers.get('cn.fieldReturn@1').validateParameters(clone(p));
const sturdy = (defs) => { for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 500; d.mechanics.weakness = null; d.mechanics.resistance = null; } };

test('schema and rule: every card goes to the discard pile, attachments too', () => {
  assert(requireRule(CN_V20261019, 'effects.field-return').sourceOfTruth.some((s) => s.section.includes('II.C-01')));
  assert(valid(discarding()));
  assert(valid(discarding({ side: 'opponent', target: 'active' })));
  assert(!valid(discarding({ attachments: 'return' })));
  assert(!valid(discarding({ to: 'lost' })));
});

test('「选择自己备战区中的1只宝可梦，将被选择的宝可梦，以及放于其身上的卡牌，全部放于弃牌区」', async () => {
  const f = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.fieldReturn@1', discarding(), 'discard')]; });
  let card, mon, water, tool;
  const g = board(f, (s) => {
    card = hand(s, 0, 'potion'); mon = bench(s, 0, 'other'); bench(s, 0, 'base');
    water = attached(s, 0, mon, 'water'); tool = hand(s, 0, 'tool'); s.players[0].hand.pop(); mon.tools.push(tool); mon.counters = 3;
  });
  const prizes = g.snapshot().players.map((p) => p.prizes.length);
  command(g, { type: 'playTrainer', cardId: card });
  assert.equal(g.view(0).pending.kind, 'return-pokemon');
  OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  answer(g, [mon.id]); settle(g);
  const s = g.snapshot();
  assert(!s.players[0].bench.some((m) => m.id === mon.id));
  for (const id of [...mon.stack, water, tool]) assert(s.players[0].discard.includes(id), id);
  assert.deepEqual(s.players.map((p) => p.prizes.length), prizes, 'Not a Knock Out: no Prize card.');
  assert(s.events.some((e) => e.ruleId === 'effects.field-return' && e.data.to === 'discard'));
});

test('「将对手的战斗宝可梦，以及放于其身上的所有卡牌，放于弃牌区」: the opponent promotes; with no other Pokémon, they lose', async () => {
  const f = await fixture((defs) => { sturdy(defs);
    def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.fieldReturn@1', discarding({ side: 'opponent', target: 'active' }), 'banish')]; });
  let spare;
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); spare = bench(s, 1, 'other'); });
  const gone = g.snapshot().players[1].active, prizes = g.snapshot().players[0].prizes.length;
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  const s = g.snapshot();
  assert.equal(s.players[1].active.id, spare.id);
  assert(gone.stack.every((id) => s.players[1].discard.includes(id)));
  assert.equal(s.players[0].prizes.length, prizes);
  const h = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); });
  command(h, { type: 'attack', attackId: 'base:strike' }); settle(h);
  assert.equal(h.snapshot().result?.winner, 0);
});
