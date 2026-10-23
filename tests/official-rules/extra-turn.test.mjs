// Synthetic definitions only. 「当这个回合结束时，自己的回合会再开始1次」 (turn.extra): the turn ends with its checkup as usual,
// then the same player takes the next turn; 「这个招式，如果……的话，则仅需……便可使用」 (energy.requirement.alternative).
// No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, board, command, settle, attached, bench } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();

test('the same player takes the next turn after the checkup; turn-relative effects count each player\'s own turns', async () => {
  assert(handlers.get('cn.extraTurn@1').validateParameters({}));
  assert(!handlers.get('cn.extraTurn@1').validateParameters({ count: 1 }));
  const own = (current) => handlers.get('cn.extraTurn@1').canUse({ state: { current }, source: { owner: 0 } }, {});
  assert.deepEqual([own(0), own(1)], [true, false], 'Only on its user\'s own turn.');
  const f = await fixture((defs) => {
    def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.extraTurn@1', {}, 'again'),
      binding('cn.lasting@1', { side: 'own', target: 'self', duration: 'nextOwnTurn', clearOnBench: true, clearOnEvolution: true,
        effect: { op: 'restriction', scope: 'all', actions: ['attack'] } }, 'rest')];
  });
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); s.players[0].active.conditions.poison = 1; });
  const before = g.snapshot(), hand = before.players[0].hand.length;
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  const s = g.snapshot();
  assert.equal(s.current, 0, 'Still player 0.');
  assert.deepEqual([s.turn, s.players[0].turns, s.players[1].turns], [before.turn + 1, before.players[0].turns + 1, before.players[1].turns]);
  assert.equal(s.players[0].hand.length, hand + 1, 'The extra turn draws as usual.');
  assert.equal(s.players[0].active.counters, 1, 'The checkup ran between the turns.');
  assert(s.events.some((e) => e.ruleId === 'turn.extra'));
  assert(!g.view(0).legalActions.some((a) => a.type === 'attack'), '「在下一个自己的回合」 is the extra turn.');
  assert.deepEqual(OfficialGame.restore(clone(s), { catalog: f.catalog }).snapshot(), s);
  command(g, { type: 'endTurn' }); settle(g);
  assert.equal(g.snapshot().current, 1, 'Then the opponent.');
});

test('a double Knock Out during the extra-turn attack: the player keeping the turn places first (I.D)', async () => {
  const run = async (extra) => {
    const f = await fixture((defs) => {
      for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.weakness = null;
      def(defs, 'base').mechanics.attacks[0].printedDamage = { value: 100, operator: 'fixed' };
      def(defs, 'base').mechanics.attacks[0].effects = [...(extra ? [binding('cn.extraTurn@1', {}, 'again')] : []),
        binding('cn.recoilDamage@1', { side: 'own', target: 'self', amount: 100, selection: { kind: 'all' }, options: {} }, 'recoil')];
    });
    const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); bench(s, 0, 'other'); bench(s, 1, 'other'); });
    command(g, { type: 'attack', attackId: 'base:strike' });
    const promoted = [];
    settle(g, (q) => { if (q.kind === 'promote') promoted.push(q.player); return q.options.slice(0, Math.max(q.minimum, q.allowZero ? 0 : 1)); });
    return [promoted, g.snapshot().current];
  };
  assert.deepEqual(await run(true), [[0, 1], 0], 'Player 0 takes the next turn, so places first.');
  assert.deepEqual(await run(false), [[1, 0], 1]);
});

test('「这个招式，如果自己没有手牌的话，则仅需1个【水】能量便可使用」: an alternative cost under a printed condition', async () => {
  const { assertSupportedDefinition } = await import('../../public/rules/game.js');
  const empty = { kind: 'compare', left: { kind: 'zoneCount', side: 'own', zone: 'hand' }, relation: 'eq', right: { kind: 'literal', value: 0 } };
  const f = await fixture((defs) => {
    const a = def(defs, 'base').mechanics.attacks[0];
    a.cost = ['Water', 'Water', 'Water'];
    a.effects = [binding('cn.energyOptions@1', { cost: ['Water'], condition: empty }, 'cheap')];
  });
  const usable = (keep) => {
    const g = board(f, (s) => {
      attached(s, 0, s.players[0].active, 'water');
      const p = s.players[0]; p.discard.push(...p.hand.splice(keep));
    });
    return g.view(0).legalActions.some((a) => a.type === 'attack' && a.attackId === 'base:strike');
  };
  assert.deepEqual([usable(0), usable(1)], [true, false]);
  const catalog = { handler: (id) => handlers.get(id) };
  const coin = clone(def(f.definitions, 'base'));
  coin.mechanics.attacks[0].effects = [binding('cn.energyOptions@1', { cost: ['Water'], condition: { kind: 'compare',
    left: { kind: 'coin', key: 'x', field: 'heads' }, relation: 'gt', right: { kind: 'literal', value: 0 } } }, 'cheap')];
  assert.throws(() => assertSupportedDefinition(catalog, coin), (e) => e.code === 'unsupported-condition');
});
