// Synthetic definitions only. 「选择4次对手的宝可梦，给被选择的所有宝可梦，造成被选择次数×30伤害。（同1只宝可梦可以选择多次。）」 (repeat
// damage picks); 「回复自己1只宝可梦「60」HP。然后，将附着于该宝可梦身上的1个能量放于弃牌区」 with cn.healPokemon@1 as the first part;
// 「对身上没有附有2个能量的宝可梦无法使用」 (targetState energyUnitsAtLeast). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const handlers = createCoreHandlers();
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const repeat = (options = {}) => ({ side: 'opponent', target: 'any', amount: 30, selection: { kind: 'repeat', count: 4 }, options });
const heal = (extra = {}) => ({ handlerId: 'cn.healPokemon@1', parameters: { op: 'healPokemon', side: 'own', target: 'any', selector: { kind: 'pokemon' },
  selection: { kind: 'exact', count: 1 }, amount: 60, discardHealedEnergy: false, ...extra } });
const discardOne = { handlerId: 'cn.attachedEnergy@1', parameters: { op: 'discardEnergy', side: 'own', from: 'any', selector: { kind: 'energy' },
  providedTypes: null, measure: 'cards', quantity: { kind: 'exact', count: 1 }, chooser: 'source' } };

test('schema: repeat picks take a fixed amount and at least two picks', () => {
  const valid = handlers.get('cn.damage@1').validateParameters;
  assert(valid(repeat())); assert(valid(repeat({ ignoreWeakness: true, ignoreResistance: true })));
  assert(!valid({ ...repeat(), selection: { kind: 'repeat', count: 1 } }));
  assert(!valid({ ...repeat(), selection: { kind: 'repeat' } }));
  assert(!valid({ ...repeat(), amount: { kind: 'count', perUnit: 30, value: { kind: 'literal', value: 2 } } }));
});

test('「选择4次对手的宝可梦…造成被选择次数×30伤害（同1只宝可梦可以选择多次）」: one packet per picked Pokémon', async () => {
  for (const [options, counters] of [[{}, 6], [{ ignoreResistance: true }, 9]]) {
    const f = await fixture((defs) => {
      const m = def(defs, 'base').mechanics;
      m.attacks[0].printedDamage = null; m.attacks[0].effects = [binding('cn.damage@1', repeat(options), 'picks')];
      def(defs, 'other').mechanics.resistance = { type: 'Water', value: 30 };
    });
    let foe, b;
    const g = board(f, (s) => {
      attached(s, 0, s.players[0].active, 'water');
      foe = bench(s, 1, 'other'); const p = s.players[1]; p.bench = [p.active]; p.active = foe; b = p.bench[0];
    });
    command(g, { type: 'attack', attackId: 'base:strike' });
    for (const id of [foe.id, b.id, foe.id, foe.id]) {
      const q = g.snapshot().pending;
      assert.equal(q.kind, 'damage-targets'); assert.deepEqual([q.minimum, q.maximum], [1, 1]);
      assert.deepEqual([...q.options].sort(), [foe.id, b.id].sort(), 'Either may be picked again.');
      restore(g, f); answer(g, [id]);
    }
    settle(g);
    const s = g.snapshot();
    assert.equal(s.players[1].active.counters, counters, 'Resistance once against 3 × 30, not three times.');
    assert.equal(s.players[1].bench[0].counters, 3, 'A Benched Pokémon: no Weakness or Resistance.');
  }
});

test('「回复…「60」HP。然后，将附着于该宝可梦身上的1个能量放于弃牌区」: cn.healPokemon@1 reports the healed Pokémon', async () => {
  const valid = handlers.get('cn.thenMoved@1').validateParameters;
  assert(valid(clone({ first: heal(), next: discardOne, use: 'pokemon' })));
  assert(!valid(clone({ first: heal({ discardHealedEnergy: true }), next: discardOne, use: 'pokemon' })),
    'Its own discard of the healed Pokémon\'s Energy is a different text.');
  const f = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.thenMoved@1', { first: heal(), next: discardOne, use: 'pokemon' }, 'mend')]; });
  let card, mine, spare;
  const g = board(f, (s) => {
    card = hand(s, 0, 'potion'); s.players[0].active.counters = 3; mine = attached(s, 0, s.players[0].active, 'water');
    spare = attached(s, 0, bench(s, 0, 'other'), 'water');
  });
  command(g, { type: 'playTrainer', cardId: card });
  settle(g, (q) => q.kind === 'discard-energy' ? (assert.deepEqual(q.options, [mine], 'Only Energy on the healed Pokémon.'), q.options) :
    q.options.slice(0, Math.max(1, q.minimum)));
  const s = g.snapshot();
  assert.equal(s.players[0].active.counters, 0);
  assert(s.players[0].discard.includes(mine) && s.players[0].bench[0].energy.includes(spare));
  restore(g, f);
});

test('「对身上没有附有2个能量的宝可梦无法使用」: counted in Energy units attached now', async () => {
  const valid = handlers.get('cn.healPokemon@1').validateParameters;
  const two = heal({ state: { energyUnitsAtLeast: 2 } }).parameters;
  assert(valid(two)); assert(!valid({ ...two, state: { energyUnitsAtLeast: 0 } })); assert(!valid({ ...two, state: { energyUnitsAtLeast: 61 } }));
  assert(valid({ ...two, state: { energyUnitsAtLeast: 2, damaged: true } }));
  const f = await fixture((defs) => { def(defs, 'potion').mechanics.effects = [binding('cn.healPokemon@1', two, 'two')]; });
  let card, one, double;
  const g = board(f, (s) => {
    card = hand(s, 0, 'potion');
    one = s.players[0].active; one.counters = 3; attached(s, 0, one, 'water');
    double = bench(s, 0, 'other'); double.counters = 3; attached(s, 0, double, 'double');
  });
  command(g, { type: 'playTrainer', cardId: card }); settle(g);
  const s = g.snapshot();
  assert.deepEqual([s.players[0].active.counters, s.players[0].bench[0].counters], [3, 0], 'A Special Energy providing 2 counts as 2.');
  const none = board(f, (s) => { card = hand(s, 0, 'potion'); s.players[0].active.counters = 3; attached(s, 0, s.players[0].active, 'water'); });
  assert(!none.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card));
});
