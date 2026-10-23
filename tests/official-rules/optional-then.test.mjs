// Synthetic definitions only. 「若希望，可选择附着于这只宝可梦身上的1个能量，放于弃牌区。在这种情况下，选择附着于对手战斗宝可梦身上的1个能量，
// 放于弃牌区。」: II.E-10 the user may decline the whole instruction, and the second part needs the first performed (II.E-19).
// No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const discard = (side, from) => ({ handlerId: 'cn.attachedEnergy@1', parameters: { op: 'discardEnergy', side, from, selector: { kind: 'energy' },
  providedTypes: null, measure: 'units', quantity: { kind: 'exact', count: 1 }, chooser: 'source' } });
const optionalThen = { effect: { handlerId: 'cn.then@1', parameters: { first: discard('own', 'self'), next: discard('opponent', 'active') } } };

test('「若希望，可A。在这种情况下，B」: schema', () => {
  const valid = (p) => createCoreHandlers().get('cn.optional@1').validateParameters(clone(p));
  assert(valid(optionalThen));
  assert(!valid({ effect: { handlerId: 'cn.then@1', parameters: { first: discard('own', 'self') } } }));
  assert(!valid({ effect: { handlerId: 'cn.then@1', parameters: { first: optionalThen.effect, next: discard('own', 'self') } } }), 'No then inside then.');
  assert(!createCoreHandlers().get('cn.coin@1').validateParameters(clone({ effect: optionalThen.effect })), 'Only an optional takes a then.');
});

test('declined: nothing; performed: both, the second only after the first', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'base').mechanics.attacks.push({ attackId: 'base:trade', name: '测试交换', cost: ['Water'],
      printedDamage: null, effects: [binding('cn.optional@1', optionalThen, 'trade')], sourceOfTruth: EVIDENCE });
  });
  const run = (choice, mine = 2) => {
    const g = board(f, (s) => {
      for (let i = 0; i < mine; i++) attached(s, 0, s.players[0].active, 'water');
      attached(s, 1, s.players[1].active, 'water');
    });
    command(g, { type: 'attack', attackId: 'base:trade' });
    if (g.snapshot().pending?.kind === 'optional-effect') {
      assert.deepEqual(OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog }).view(0), g.view(0));
      answer(g, [choice]);
    }
    settle(g, (q) => q.options.slice(0, Math.max(q.minimum, 1)));
    return g.snapshot();
  };
  let s = run('skip');
  assert.equal(s.players[0].active.energy.length, 2); assert.equal(s.players[1].active.energy.length, 1);
  s = run('perform');
  assert.equal(s.players[0].active.energy.length, 1); assert.equal(s.players[1].active.energy.length, 0);
});
