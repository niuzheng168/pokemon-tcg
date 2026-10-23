// Synthetic definitions only. E-20 文例2 「在下一个对手的回合结束时，受到这个招式影响的宝可梦会【昏厥】。」: at the end of the
// opponent's next turn (before Pokémon Checkup) the affected Pokémon is Knocked Out, unless it has left the Active Spot or
// evolved. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, EVIDENCE, board, command, settle, attached, bench } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const doom = { side: 'opponent', target: 'active', duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true,
  trigger: { event: 'turnEnd', subject: 'self', optional: false, choiceOwner: 'affected', scope: 'subject' },
  program: [{ op: 'knockOut', side: 'opponent', target: 'event' }] };

async function make() {
  return fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.weakness = null;
    defs.find((d) => d.definitionId === 'base').mechanics.attacks.push({ attackId: 'base:doom', name: '测试灭亡', cost: ['Water'],
      printedDamage: null, effects: [binding('cn.delayedReaction@1', doom, 'doom')], sourceOfTruth: EVIDENCE });
  });
}
const play = (f, mutate = () => {}) => {
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); bench(s, 1, 'other'); mutate(s); });
  command(g, { type: 'attack', attackId: 'base:doom' }); settle(g);
  return g;
};

test('「在下一个对手的回合结束时，受到这个招式影响的宝可梦会【昏厥】」', async () => {
  assert(createCoreHandlers().get('cn.delayedReaction@1').validateParameters(clone(doom)));
  const f = await make();
  const g = play(f);
  const target = g.snapshot().players[1].active.id, prizes = g.snapshot().players[0].prizes.length;
  assert.equal(g.snapshot().current, 1, 'Not at the end of the attacker\'s own turn.');
  OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  command(g, { type: 'endTurn' }); settle(g);
  const s = g.snapshot();
  assert(s.players[1].discard.some((id) => s.cards[id].definitionId === 'base'), 'The affected Pokémon was Knocked Out.');
  assert.notEqual(s.players[1].active.id, target);
  assert.equal(s.players[0].prizes.length, prizes - 1);
  assert(s.events.some((e) => e.ruleId === 'trigger.turn-end'));
});

test('the effect ends when the affected Pokémon leaves the Active Spot', async () => {
  const f = await make();
  const g = play(f, (s) => { attached(s, 1, s.players[1].active, 'water'); attached(s, 1, s.players[1].active, 'water'); });
  const target = g.snapshot().players[1].active.id;
  command(g, { type: 'retreat' }); settle(g);
  command(g, { type: 'endTurn' }); settle(g);
  const s = g.snapshot();
  assert(s.players[1].bench.some((m) => m.id === target), 'Retreated before the turn ended: not Knocked Out.');
});
