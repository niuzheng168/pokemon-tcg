// Synthetic definitions only. 「令对手的战斗宝可梦【昏厥】。然后，给这只宝可梦造成200伤害。」: the self damage only if the Knock Out
// happened (II.E-19; 日本官方 Q&A 「くるいえぐる」). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, board, command, settle, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const lit = (value) => ({ kind: 'literal', value });
const recoil = binding('cn.recoilDamage@1', { side: 'own', target: 'self', selection: { kind: 'all' }, options: {}, amount: { kind: 'choose',
  condition: { kind: 'compare', left: { kind: 'effectCards', effectId: 'fixture:ko' }, relation: 'gt', right: lit(0) }, ifTrue: lit(200), ifFalse: lit(0) } }, 'recoil');
const moon = (transform = () => {}) => fixture((defs) => {
  for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 300; d.mechanics.weakness = null; }
  const a = def(defs, 'base').mechanics.attacks[0]; a.printedDamage = null;
  a.effects = [binding('cn.countedKnockOut@1', { target: 'active', side: 'opponent' }, 'ko'), recoil];
  transform(defs);
});

test('schema: a counted Knock Out of the opponent\'s Pokémon, never of this one', () => {
  const h = createCoreHandlers().get('cn.countedKnockOut@1');
  assert.equal(h.timing, 'beforeDamage');
  assert(h.validateParameters({ target: 'active', side: 'opponent' })); assert(!h.validateParameters({ target: 'self' }));
});

test('the Knock Out happens, then this Pokémon takes 200', async () => {
  const f = await moon();
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); });
  const foe = g.snapshot().players[1].active.id;
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  const s = g.snapshot();
  assert.notEqual(s.players[1].active?.id, foe, 'Knocked Out.');
  assert.equal(s.players[0].active.counters, 20);
  assert(s.events.some((e) => e.ruleId === 'damage.effect-count' && e.data.effectId.endsWith('ko') && e.data.cards.length === 1));
  assert.deepEqual(restore(g, f).snapshot(), s);
});

test('protected from the effect: no Knock Out and no self damage', async () => {
  const f = await moon((defs) => {
    def(defs, 'base').mechanics.effects.push(binding('cn.protection@1', { effect: { op: 'protection', useRule: 'ordinary', channel: 'effects',
      from: 'opponent', scope: 'self', categories: ['attack'] } }, 'shield'));
  });
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); });
  const foe = g.snapshot().players[1].active.id;
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  const s = g.snapshot();
  assert.equal(s.players[1].active.id, foe);
  assert.equal(s.players[0].active.counters, 0);
});
