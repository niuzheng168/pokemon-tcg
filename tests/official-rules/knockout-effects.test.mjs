// Synthetic definitions only. Knocking out a Pokémon other than the user by an effect (I.D; basic guide 「宝可梦的“昏厥”」):
// 「令对手的战斗宝可梦【昏厥】」, 「选择对手备战区中的N只…宝可梦，令其【昏厥】」, 「令使用了招式的宝可梦【昏厥】」, under a coin or a
// condition, and not on a Pokémon protected from that effect (II.C-17). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();
const valid = (p) => handlers.get('cn.knockOut@1').validateParameters(clone(p));
const basic = { kind: 'pokemon', stages: ['basic'] };
const sturdy = (defs) => { for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 500; d.mechanics.weakness = null; d.mechanics.resistance = null; } };
const withAttack = (effects) => (defs) => { sturdy(defs); const a = def(defs, 'base').mechanics.attacks[0]; a.printedDamage = null; a.effects = effects; };
const knocked = (g, from) => g.snapshot().events.slice(from).filter((e) => e.ruleId === 'effects.knockout').map((e) => e.data.pokemonId);
function attack(g) { const from = g.snapshot().events.length; command(g, { type: 'attack', attackId: 'base:strike' }); return from; }

test('schemas and rule: this Pokémon, an Active, the attacker, or N chosen Pokémon of a kind', () => {
  assert(requireRule(CN_V20261019, 'effects.knockout').sourceOfTruth.some((s) => s.documentId === 'CN-basic-guide'));
  for (const p of [{ target: 'self' }, { target: 'active', side: 'opponent' }, { target: 'active', side: 'own' },
    { target: 'active', side: 'opponent', selector: basic }, { target: 'bench', side: 'opponent', count: 2, selector: basic },
    { target: 'any', side: 'opponent', count: 1, state: { damaged: true } }, { target: 'attacker', side: 'opponent' }])
    assert(valid(p), JSON.stringify(p));
  for (const p of [{ target: 'opponent' }, { target: 'self', side: 'own' }, { target: 'active' }, { target: 'bench', side: 'opponent' },
    { target: 'active', side: 'opponent', count: 1 }, { target: 'bench', side: 'opponent', count: 9 }, { target: 'self', selector: basic }])
    assert(!valid(p), JSON.stringify(p));
  assert(handlers.get('cn.when@1').validateParameters({ condition: { kind: 'stadiumInPlay', owner: 'any' },
    effect: { handlerId: 'cn.knockOut@1', parameters: { target: 'active', side: 'opponent' } } }));
});

test('「令对手的战斗宝可梦【昏厥】」: confirmed at the end of the attack, regardless of HP; the attacker takes the Prize card', async () => {
  const f = await fixture(withAttack([binding('cn.knockOut@1', { target: 'active', side: 'opponent' }, 'ko')]));
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); bench(s, 1, 'other'); });
  const target = g.snapshot().players[1].active.id, prizes = g.snapshot().players[0].prizes.length;
  const from = attack(g); settle(g);
  assert.deepEqual(knocked(g, from), [target]);
  assert.equal(g.snapshot().players[0].prizes.length, prizes - 1);
  assert.notEqual(g.snapshot().players[1].active.id, target);
  // 「使双方的战斗宝可梦【昏厥】」: each player takes one Prize card.
  const both = await fixture(withAttack([binding('cn.knockOut@1', { target: 'active', side: 'own' }, 'mine'),
    binding('cn.knockOut@1', { target: 'active', side: 'opponent' }, 'theirs')]));
  const h = board(both, (s) => { attached(s, 0, s.players[0].active, 'water'); bench(s, 0, 'other'); bench(s, 1, 'other'); });
  const counts = h.snapshot().players.map((p) => p.prizes.length);
  const start = attack(h); settle(h);
  assert.equal(knocked(h, start).length, 2);
  assert.deepEqual(h.snapshot().players.map((p) => p.prizes.length), counts.map((n) => n - 1));
});

test('only the printed kind; 「选择对手备战区中的1只【基础】宝可梦」 is the user\'s choice and survives restore', async () => {
  const f = await fixture(withAttack([binding('cn.knockOut@1', { target: 'active', side: 'opponent', selector: { kind: 'pokemon', stages: ['stage1'] } }, 'ko')]));
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); bench(s, 1, 'other'); });
  const from = attack(g); settle(g);
  assert.deepEqual(knocked(g, from), [], 'A Basic Active is not a Stage 1 Pokémon.');
  const pick = await fixture(withAttack([binding('cn.knockOut@1', { target: 'bench', side: 'opponent', count: 1, selector: basic }, 'pick')]));
  let one, two;
  const h = board(pick, (s) => { attached(s, 0, s.players[0].active, 'water'); one = bench(s, 1, 'other'); two = bench(s, 1, 'base'); bench(s, 1, 'evolution'); });
  attack(h);
  const q = h.view(0).pending;
  assert.deepEqual([q.kind, q.options, q.minimum, q.maximum], ['effect-target', [one.id, two.id], 1, 1]);
  const r = restore(h, pick);
  answer(r, [two.id]); settle(r);
  assert.deepEqual([r.snapshot().players[1].bench.map((m) => m.id).includes(two.id), r.snapshot().players[1].bench.length], [false, 2]);
  // A pending effect Knock Out cannot be forged onto a snapshot without an unfinished effect.
  const forged = clone(r.snapshot());
  forged.players[1].bench[0].facts.forcedKnockout = { kind: 'effect', source: clone(h.snapshot().attack.source) };
  assert.throws(() => OfficialGame.restore(forged, { catalog: pick.catalog }), (e) => e.code === 'invalid-knockout');
});

test('II.C-17: a Pokémon not affected by the opponent\'s attack effects is not Knocked Out by one', async () => {
  const f = await fixture((defs) => {
    withAttack([binding('cn.knockOut@1', { target: 'active', side: 'opponent' }, 'ko')])(defs);
    def(defs, 'other').mechanics.effects.push(binding('cn.protection@1', { effect: {
      op: 'protection', useRule: 'ordinary', scope: 'self', channel: 'effects', from: 'opponent', categories: ['attack'] } }, 'guard'));
  });
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water'); bench(s, 1, 'base');
    const p = s.players[1], guard = bench(s, 1, 'other'); p.bench.splice(p.bench.indexOf(guard), 1); p.hand.push(...p.active.stack); p.active = guard;
  });
  const from = attack(g); settle(g);
  assert.deepEqual(knocked(g, from), []);
  assert(g.snapshot().events.slice(from).some((e) => e.ruleId === 'effects.protection'));
});

test('a coin, a condition, and an Ability\'s 「令使用了招式的宝可梦【昏厥】」', async () => {
  const SEEDS = Array.from({ length: 12 }, (_, i) => [3 * i + 1, 3 * i + 2, 3 * i + 3, 7]);
  const coin = await fixture(withAttack([binding('cn.coin@1', { outcome: 'heads',
    effect: { handlerId: 'cn.knockOut@1', parameters: { target: 'active', side: 'opponent', selector: basic } } }, 'coin')]));
  const seen = SEEDS.map((seed) => {
    const g = board({ ...coin, seed }, (s) => { attached(s, 0, s.players[0].active, 'water'); bench(s, 1, 'other'); });
    const from = attack(g); settle(g);
    const heads = g.snapshot().events.slice(from).find((e) => e.ruleId === 'effects.coin').data.result === 'heads';
    assert.equal(knocked(g, from).length, heads ? 1 : 0);
    return heads;
  });
  assert.deepEqual(new Set(seen), new Set([true, false]));
  const when = await fixture(withAttack([binding('cn.when@1', { condition: { kind: 'pokemonIs', who: 'opponentActive', state: { damaged: true } },
    effect: { handlerId: 'cn.knockOut@1', parameters: { target: 'active', side: 'opponent' } } }, 'if')]));
  for (const counters of [0, 3]) {
    const g = board(when, (s) => { attached(s, 0, s.players[0].active, 'water'); bench(s, 1, 'other'); s.players[1].active.counters = counters; });
    const from = attack(g); settle(g);
    assert.equal(knocked(g, from).length, counters ? 1 : 0);
  }
  const react = await fixture((defs) => {
    withAttack([])(defs);
    def(defs, 'base').mechanics.attacks[0].printedDamage = { value: 10, operator: 'fixed' };
    def(defs, 'other').mechanics.abilities = [{ abilityId: 'fixture:curse', name: '测试诅咒', mode: 'triggered', usage: null, sourceOfTruth: EVIDENCE,
      trigger: { event: 'attackDamage', subject: 'self', cause: 'opponentAttackDamage', optional: false, choiceOwner: 'source', scope: 'global' },
      effects: [binding('cn.knockOut@1', { target: 'attacker', side: 'opponent' }, 'curse')] }];
  });
  const g = board(react, (s) => {
    attached(s, 0, s.players[0].active, 'water'); bench(s, 0, 'other');
    const p = s.players[1], cursed = bench(s, 1, 'other'); p.bench.splice(p.bench.indexOf(cursed), 1); p.hand.push(...p.active.stack); p.active = cursed;
    bench(s, 1, 'base');
  });
  const attacker = g.snapshot().players[0].active.id;
  const from = attack(g); settle(g);
  assert.deepEqual(knocked(g, from), [attacker]);
});
