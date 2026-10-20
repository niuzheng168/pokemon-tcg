// Synthetic definitions only. Shapes follow printed CN text: 「如果使用了，则令这只宝可梦昏厥。
// 给对手的1只宝可梦身上，放置5个伤害指示物」, 「给对手的2只备战宝可梦身上，各放置1个伤害指示物」 and
// 「如果这只宝可梦身上附着了【恶】能量的话……选择自己场上1只宝可梦身上放置的最多3个伤害指示物，
// 转放于对手场上1只宝可梦身上」. No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { ENERGY_TYPES } from '../../public/rules/damage.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const ability = (key, effects, extra = {}) => ({
  abilityId: `fixture:${key}`, name: `测试${key}`, mode: 'activated',
  usage: { period: 'turn', scope: 'pokemon', key: `fixture:${key}`, limit: 1 }, effects, sourceOfTruth: EVIDENCE, ...extra,
});
const withAbility = (id, a) => (defs) => { defs.find((d) => d.definitionId === id).mechanics.abilities = [a]; };
const uses = (g, player = 0) => g.view(player).legalActions.filter((a) => a.type === 'useAbility');
const use = (g, pokemonId, abilityId) => command(g, { type: 'useAbility', pokemonId, abilityId });
const find = (s, owner, id) => [s.players[owner].active, ...s.players[owner].bench].find((m) => m?.id === id);
const blast = (count) => [binding('cn.knockOut@1', { target: 'self' }, 'self-ko'),
  binding('cn.counters@1', { side: 'opponent', target: 'any', count }, 'blast')];

test('self Knock Out and multi-target counters carry CN sources; malformed parameters are rejected', async () => {
  for (const id of ['effects.knockout', 'damage.counters']) assert(requireRule(CN_V20261019, id).sourceOfTruth.length > 0);
  const handlers = createCoreHandlers();
  assert.throws(() => handlers.get('cn.knockOut@1').validateParameters({ target: 'opponent' }) || (() => { throw new Error('no'); })());
  assert.throws(() => handlers.get('cn.counters@1').validateParameters({ side: 'opponent', target: 'self', count: 1, targets: 2 }) ||
    (() => { throw new Error('no'); })());
  assert.throws(() => handlers.get('cn.transferCounters@1').validateParameters({ count: 3, from: 'any', side: 'opponent', target: 'any',
    quantity: 'all' }) || (() => { throw new Error('no'); })());
  assert.equal(handlers.get('cn.knockOut@1').canUse({ source: { owner: 0, pokemonId: 'gone' },
    state: { players: [{ active: null, bench: [] }, { active: null, bench: [] }] } }, { target: 'self' }), false);
});

test('I.D: 「令这只宝可梦昏厥」 is confirmed with the other Knock Outs at the end of the Ability; the opponent takes its Prize', async () => {
  const f = await fixture(withAbility('other', ability('blast', blast(5))));
  let user, spare;
  const g = board(f, (s) => { user = bench(s, 0, 'other'); spare = bench(s, 1, 'base'); });
  const target = g.snapshot().players[1].active.id;
  use(g, user.id, 'fixture:blast');
  // Mid-effect: the Knock Out waits for the counters; the snapshot restores exactly.
  const mid = g.snapshot();
  assert.equal(mid.pending.kind, 'effect-target');
  assert.deepEqual(find(mid, 0, user.id).facts.forcedKnockout.kind, 'effect');
  restore(g, f);
  for (const edit of [(s) => { s.pending = null; }, (s) => { find(s, 0, user.id).facts.forcedKnockout.source.pokemonId = 'elsewhere'; }]) {
    const forged = clone(mid); edit(forged);
    assert.throws(() => OfficialGame.restore(forged, { catalog: f.catalog }));
  }
  answer(g, [target]); settle(g);
  const s = g.snapshot();
  assert.equal(find(s, 0, user.id), undefined, 'The user is Knocked Out regardless of its HP.');
  assert.equal(find(s, 1, target).counters, 5);
  assert.equal(s.players[1].prizes.length, 5, 'The opponent takes 1 Prize card.');
  assert.equal(s.players[0].prizes.length, 6);
  assert(s.events.some((e) => e.ruleId === 'effects.knockout' && e.data.pokemonId === user.id));
  assert.equal(s.current, 0, 'A Knock Out during an Ability does not end the turn.');

  // Both Knock Outs are confirmed together; each player takes Prize cards and the opponent promotes.
  const both = board(f, (s) => {
    s.players[1].active.counters = 5; spare = bench(s, 1, 'base');
    const p = s.players[0]; p.hand.push(...p.active.stack); p.active = bench(s, 0, 'other'); p.bench.pop(); user = p.active;
    bench(s, 0, 'base');
  });
  use(both, user.id, 'fixture:blast'); answer(both, [both.snapshot().players[1].active.id]);
  settle(both, (q) => q.options.slice(0, 1));
  const after = both.snapshot();
  assert.deepEqual([after.players[0].prizes.length, after.players[1].prizes.length], [5, 5]);
  assert.equal(after.players[1].active.id, spare.id);
  assert.notEqual(after.players[0].active.id, user.id);
});

test('「给对手的2只备战宝可梦身上，各放置1个」 needs distinct targets, takes all when fewer and skips protected ones', async () => {
  const f = await fixture((defs) => {
    withAbility('other', ability('entry', [binding('cn.counters@1', { side: 'opponent', target: 'bench', count: 1, targets: 2 }, 'entry')]))(defs);
    defs.find((d) => d.definitionId === 'evolution').mechanics.effects = [binding('cn.protection@1', { effect: { op: 'protection',
      channel: 'effects', useRule: 'ordinary', scope: 'self', from: 'opponent', categories: ['ability'] } }, 'shield')];
  });
  let user, a, b, c;
  const g = board(f, (s) => { user = bench(s, 0, 'other'); a = bench(s, 1, 'base'); b = bench(s, 1, 'other'); c = bench(s, 1, 'other'); });
  use(g, user.id, 'fixture:entry');
  const q = g.snapshot().pending;
  assert.deepEqual([q.minimum, q.maximum, q.options.length], [2, 2, 3]);
  assert.throws(() => answer(g, [a.id]));
  answer(g, [a.id, c.id]);
  const s = g.snapshot();
  assert.deepEqual([a, b, c].map((m) => find(s, 1, m.id).counters), [1, 0, 1]);

  const one = board(f, (s) => { user = bench(s, 0, 'other'); a = bench(s, 1, 'base'); });
  use(one, user.id, 'fixture:entry');
  assert.deepEqual([one.snapshot().pending.minimum, one.snapshot().pending.maximum], [1, 1]);
  answer(one, [a.id]);
  assert.equal(find(one.snapshot(), 1, a.id).counters, 1);

  assert.deepEqual(uses(board(f, (s) => { bench(s, 0, 'other'); })), [], 'No opposing Bench: nothing could change.');

  // A protected target is still chosen but receives nothing; with only protected targets nothing could change.
  let shielded;
  const guarded = board(f, (s) => { user = bench(s, 0, 'other'); shielded = bench(s, 1, 'evolution'); a = bench(s, 1, 'base'); });
  use(guarded, user.id, 'fixture:entry'); answer(guarded, [shielded.id, a.id]);
  assert.deepEqual([find(guarded.snapshot(), 1, shielded.id).counters, find(guarded.snapshot(), 1, a.id).counters], [0, 1]);
  assert(!guarded.snapshot().events.some((e) => e.ruleId === 'damage.counters' && e.data.targetId === shielded.id));
  assert.deepEqual(uses(board(f, (s) => { bench(s, 0, 'other'); bench(s, 1, 'evolution'); })), []);
});

test('「附着了【X】能量的话」 reads provided types (all-type Energy counts); 「最多3个」 transfers 1 to 3 counters', async () => {
  const f = await fixture((defs) => {
    withAbility('other', ability('brain', [binding('cn.transferCounters@1', { count: 3, from: 'any', side: 'opponent', target: 'any',
      quantity: 'upTo' }, 'brain')], { condition: { attachedEnergyType: 'Fire' } }))(defs);
    defs.find((d) => d.definitionId === 'double').mechanics.baseUnits = [ENERGY_TYPES];
  });
  f.deck.splice(20, 1, 'printing:fire');
  let user;
  const dry = board(f, (s) => { user = bench(s, 0, 'other'); attached(s, 0, user, 'water'); s.players[0].active.counters = 5; });
  assert.deepEqual(uses(dry), [], 'Water Energy does not satisfy a Fire condition.');
  const rainbow = board(f, (s) => { user = bench(s, 0, 'other'); attached(s, 0, user, 'double'); s.players[0].active.counters = 5; });
  assert.deepEqual(uses(rainbow).map((a) => a.pokemonId), [user.id]);

  const g = board(f, (s) => { user = bench(s, 0, 'other'); attached(s, 0, user, 'fire'); s.players[0].active.counters = 5; });
  const origin = g.snapshot().players[0].active.id, target = g.snapshot().players[1].active.id;
  use(g, user.id, 'fixture:brain'); answer(g, [origin]);
  const q = g.snapshot().pending;
  assert.deepEqual([q.kind, q.options], ['counter-count', ['1', '2', '3']]);
  restore(g, f);
  const forged = clone(g.snapshot());
  forged.pending.data.originId = user.id;
  assert.throws(() => OfficialGame.restore(forged, { catalog: f.catalog }), (e) => e.code === 'invalid-counter-transfer');
  answer(g, ['2']); answer(g, [target]);
  const s = g.snapshot();
  assert.deepEqual([find(s, 0, origin).counters, find(s, 1, target).counters], [3, 2]);

  // A single counter needs no count choice.
  const single = board(f, (s) => { user = bench(s, 0, 'other'); attached(s, 0, user, 'fire'); s.players[0].active.counters = 1; });
  use(single, user.id, 'fixture:brain'); answer(single, [single.snapshot().players[0].active.id]);
  assert.equal(single.snapshot().pending.kind, 'counter-destination');
});
