// Synthetic definitions only. Coins a card changes — 「在下一个对手的回合，将对手抛掷的硬币的结果，全部视作反面。」 (effects.coin-face);
// 「在这个回合，使用了这张卡牌后，首次由于招式、特性、训练家的效果自己抛掷硬币时，其第一次的结果，可由自己决定是正面还是反面。」 (effects.coin-choice);
// 「双方玩家，在自己的回合有1次机会，因自己宝可梦的招式而抛掷硬币时，可无视这次抛掷硬币的所有结果，重新抛掷硬币。」 and 「在自己的回合，因自己宝可梦的
// 招式而抛掷硬币时，可使用1次。无视这次抛掷硬币的所有结果，重新抛掷硬币。不论有多少只「比克提尼」，在自己的回合只能使用1次「胜利之星」。」 (effects.coin-reflip);
// 「当身上放有这张卡牌的宝可梦使用招式时，因招式的伤害或效果自己抛掷硬币而出现反面的话，则在自己的回合结束时，从自己的牌库上方抽取3张卡牌。」
// (tools.attack-tails); 「抛掷2次硬币，将与出现正面次数相同数量的附着于对手战斗宝可梦身上的能量放于弃牌区。如果全是反面，则这个招式失败。」.
// No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, assertSupportedDefinition } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { randomIndex } from '../../public/rules/random.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached, fixtureClock } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const handlers = createCoreHandlers(), catalog = { handler: (id) => handlers.get(id) };
const valid = (id, p) => handlers.get(id).validateParameters(clone(p));
const leaf = (handlerId, parameters) => ({ handlerId, parameters });
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const lit = (value) => ({ kind: 'literal', value });
const draw = (count) => leaf('cn.draw@1', { count });
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  for (const viewer of [0, 1]) assert.deepEqual(r.view(viewer), g.view(viewer));
  return r;
};
// A private RNG whose next coins show these faces (a test board, never a production seed).
const seedFor = (faces) => {
  for (let i = 1; i <= 8192; i++) {
    const seed = [Math.imul(i, 8000009) >>> 0, Math.imul(i, 333333331) >>> 0, Math.imul(i, 17) >>> 0, Math.imul(i, 37) >>> 0], rng = [...seed];
    if (faces.every((face) => (randomIndex(rng, 2) === 0) === (face === 'heads'))) return seed;
  }
  throw new Error(`No fixture seed for ${faces}`);
};
const attack = (g, attackId, player = g.snapshot().current) => command(g, { type: 'attack', attackId }, player);
const end = (g) => { command(g, { type: 'endTurn' }); settle(g); };
const coinEvents = (g) => g.snapshot().events.filter((e) => e.ruleId === 'effects.coin').map((e) => e.data.result);
const hold = (s, owner, m, definitionId) => { const id = hand(s, owner, definitionId); s.players[owner].hand.pop(); m.tools.push(id); return id; };
const coin = (key, effect = draw(1)) => binding('cn.coin@1', { outcome: 'heads', effect }, key);
const twoHeads = { kind: 'multiply', left: lit(30), right: { kind: 'coin', key: 'r', field: 'heads' } };
const STAR = 'cn:ability:fixture-star', FOREST = 'cn:stadium:fixture-forest';
// One synthetic Pokémon with every attack these texts need; Trainers carry the coin effects.
const attacks = (extra) => [
  ['flip', null, [coin('flip')]],
  ['flip2', null, [coin('one'), coin('two')]],
  ['roll', { value: 30, operator: 'times' }, [binding('cn.damageValue@1', { expression: twoHeads, rolls: [{ key: 'r', spec: { kind: 'fixed', count: 2 } }] }, 'roll'),
    binding('cn.optional@1', { effect: draw(1) }, 'after')]],
  ['zero', { value: 30, operator: 'times' }, [binding('cn.damageValue@1', { expression: twoHeads,
    rolls: [{ key: 'r', spec: { kind: 'fixed', count: { kind: 'pokemon', who: 'self', field: 'damageCounters' } } }] }, 'zero'), coin('later')]],
  ['check', { value: 20, operator: 'fixed' }, [], { failureCheck: { coin: { mode: 'fixed', count: 1, minimumHeads: 1 }, sourceOfTruth: EVIDENCE } }],
  ['coins', null, [binding('cn.coins@1', { flips: { kind: 'fixed', count: 2 }, face: 'heads', apply: { kind: 'scale' }, effect: draw(1) }, 'coins')]],
  ['headache', null, [binding('cn.lastingPlayer@1', { side: 'opponent', duration: 'nextOpponentTurn', effect: { op: 'coinFace', face: 'tails' } }, 'headache')]],
  ['smoke', null, [binding('cn.lasting@1', { side: 'opponent', target: 'active', duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true,
    effect: { op: 'attackCheck', scope: 'all', coin: { mode: 'fixed', count: 1, minimumHeads: 1 } } }, 'smoke')]],
  ['recoil', { value: 20, operator: 'fixed' }, [binding('cn.recoilDamage@1', { side: 'own', target: 'self', amount: 10, selection: { kind: 'all' }, options: {} }, 'recoil')]],
  ['twister', { value: 30, operator: 'fixed' }, [binding('cn.coins@1', { flips: { kind: 'failureCheck' }, face: 'heads', apply: { kind: 'scale' },
    effect: leaf('cn.attachedEnergy@1', { op: 'discardEnergy', side: 'opponent', from: 'active', selector: { kind: 'energy' }, providedTypes: null,
      measure: 'units', quantity: { kind: 'exact', count: 1 }, chooser: 'source' }) }, 'twister')],
  { failureCheck: { coin: { mode: 'fixed', count: 2, minimumHeads: 1 }, sourceOfTruth: EVIDENCE } }],
  ['copy', null, [binding('cn.copyAttack@1', { op: 'copyAttack', origins: [{ side: 'opponent', zone: 'active', selector: { kind: 'pokemon' } }],
    excludeUser: false, coin: 'heads', energy: 'ignore', special: { mode: 'needsRuling', sourceOfTruth: EVIDENCE } }, 'copy')]],
  ...extra,
].map(([key, printedDamage, effects, more = {}]) => ({ attackId: `base:${key}`, name: `测试${key}`, cost: [], printedDamage, effects, sourceOfTruth: EVIDENCE, ...more }));
const make = (extra = [], transform = () => {}) => fixture((defs) => {
  for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.weakness = null; d.mechanics.hp = 300; }
  def(defs, 'base').mechanics.attacks.push(...attacks(extra));
  def(defs, 'research').mechanics.effects = [binding('cn.lastingPlayer@1', { side: 'own', duration: 'thisTurn', effect: { op: 'coinChoice' } }, 'will')];
  def(defs, 'potion').mechanics.effects = [coin('potion')];
  def(defs, 'stadium').mechanics.effects = [binding('cn.coinReflip@1', { scope: 'all', key: FOREST }, 'forest')];
  def(defs, 'tool').mechanics.effects = [binding('cn.turnEndEffect@1', { on: 'attackTails', effect: draw(3) }, 'policy')];
  def(defs, 'other').mechanics.abilities = [{ abilityId: 'other:star', name: '测试胜利之星', mode: 'continuous', usage: null,
    effects: [binding('cn.coinReflip@1', { scope: 'own', key: STAR }, 'star')], sourceOfTruth: EVIDENCE }];
  transform(defs);
});
const play = (g, id) => { const card = g.snapshot().players[0].hand.find((c) => g.snapshot().cards[c].definitionId === id); command(g, { type: 'playTrainer', cardId: card }); };

test('schemas, rules and load guards', async () => {
  for (const id of ['effects.coin-face', 'effects.coin-choice', 'effects.coin-reflip', 'tools.attack-tails'])
    assert(requireRule(CN_V20261019, id).sourceOfTruth.some((s) => s.documentId === 'JP-official-qa'));
  assert(valid('cn.lastingPlayer@1', { side: 'opponent', duration: 'nextOpponentTurn', effect: { op: 'coinFace', face: 'tails' } }));
  assert(!valid('cn.lastingPlayer@1', { side: 'opponent', duration: 'nextOpponentTurn', effect: { op: 'coinFace', face: 'heads' } }));
  assert(valid('cn.lastingPlayer@1', { side: 'own', duration: 'thisTurn', effect: { op: 'coinChoice' } }));
  assert(!valid('cn.lastingPlayer@1', { side: 'opponent', duration: 'thisTurn', effect: { op: 'coinChoice' } }));
  assert(!valid('cn.lastingPlayer@1', { side: 'own', duration: 'nextOwnTurn', effect: { op: 'coinChoice' } }));
  for (const [side, duration] of [['own', 'nextOpponentTurn'], ['opponent', 'game'], ['opponent', 'thisTurn']])
    assert(!valid('cn.lastingPlayer@1', { side, duration, effect: { op: 'coinFace', face: 'tails' } }), `${side} ${duration}`);
  assert(valid('cn.coinReflip@1', { scope: 'all', key: FOREST }));
  assert(!valid('cn.coinReflip@1', { scope: 'opponent', key: FOREST }));
  assert(valid('cn.turnEndEffect@1', { on: 'attackTails', effect: draw(3) }));
  assert(!valid('cn.turnEndEffect@1', { on: 'attackHeads', effect: draw(3) }));
  assert(valid('cn.coins@1', { flips: { kind: 'failureCheck' }, face: 'heads', apply: { kind: 'scale' }, effect: draw(1) }));
  const f = await make();
  for (const id of ['base', 'stadium', 'tool', 'other', 'research']) assertSupportedDefinition(catalog, def(f.definitions, id));
  const rejects = (id, mutate, code) => {
    const d = clone(def(f.definitions, id)); mutate(d.mechanics);
    assert.throws(() => assertSupportedDefinition(catalog, d), (e) => e.code === code, `${id} ${code}`);
  };
  // A reflip is a Stadium's or an Ability's; a holder-only Tool reflip is another mechanism.
  rejects('tool', (m) => { m.effects = [binding('cn.coinReflip@1', { scope: 'own', key: STAR }, 'tool-reflip')]; }, 'unsupported-handler');
  rejects('base', (m) => { m.effects = [binding('cn.coinReflip@1', { scope: 'own', key: STAR }, 'rule-reflip')]; }, 'unsupported-handler');
  // The attack-tails form is a Tool's; the card-use form an Item's or Supporter's.
  rejects('potion', (m) => { m.effects = [binding('cn.turnEndEffect@1', { on: 'attackTails', effect: draw(3) }, 'item-policy')]; }, 'unsupported-handler');
  rejects('tool', (m) => { m.effects = [binding('cn.turnEndEffect@1', { effect: draw(3) }, 'tool-end')]; }, 'unsupported-handler');
  // Only an attack with a printed coin failure check reads its coins again.
  rejects('base', (m) => { delete m.attacks.find((a) => a.attackId === 'base:twister').failureCheck; }, 'unsupported-condition');
  rejects('potion', (m) => { m.effects = [binding('cn.coins@1', { flips: { kind: 'failureCheck' }, face: 'heads', apply: { kind: 'scale' }, effect: draw(1) }, 'x')]; },
    'unsupported-condition');
});

test('「在下一个对手的回合，将对手抛掷的硬币的结果，全部视作反面」: every coin that player flips then, Confusion included; no RNG is read', async () => {
  const f = await make([], (defs) => {
    // Player 0's Active protects itself on heads: a coin player 0 flips in the opponent's turn stays random.
    def(defs, 'base').mechanics.effects = [binding('cn.protection@1', { effect: { op: 'protection', useRule: 'ordinary', channel: 'damage',
      scope: 'self', from: 'opponent', categories: ['attack'], coin: true } }, 'shield')];
  });
  const lock = (mutate = () => {}) => {
    const g = board(f, (s) => { attached(s, 1, s.players[1].active, 'water'); mutate(s); });
    attack(g, 'base:headache'); settle(g);
    const s = g.snapshot();
    assert.equal(s.current, 1);
    assert.deepEqual(s.playerOngoing.filter((e) => e.effect.op === 'coinFace').map((e) => [e.player, e.effect.face]), [[1, 'tails']]);
    assert.equal(g.view(1).playerOngoing.find((e) => e.effect.op === 'coinFace').rule.ruleId, 'effects.coin-face');
    return { g, rng: s.rng };
  };
  // Damage coins show tails without the RNG; the paused attack restores its replay under the same effect.
  let { g, rng } = lock();
  attack(g, 'base:roll');
  let s = g.snapshot();
  assert.equal(s.pending.kind, 'optional-effect');
  assert.deepEqual(s.events.filter((e) => e.ruleId === 'damage.coins' && e.data.kind === 'rolled').map((e) => e.data.receipt.results), [['tails', 'tails']]);
  assert.deepEqual(s.rng, rng); assert.equal(s.players[0].active.counters, 0);
  restore(g, f);
  // A coin and counted coins: tails, nothing drawn, no RNG.
  for (const id of ['base:flip', 'base:coins']) {
    ({ g, rng } = lock());
    const before = g.snapshot().players[1].hand.length;
    attack(g, id);
    s = g.snapshot();
    assert.deepEqual(s.rng, rng); assert.equal(s.players[1].hand.length, before);
    assert(s.events.some((e) => e.ruleId === 'effects.coin' && (e.data.result === 'tails' || e.data.receipt?.heads === 0)));
  }
  // Its own failure check and Confusion fail the attack.
  ({ g } = lock());
  attack(g, 'base:check');
  assert.deepEqual(g.snapshot().events.findLast((e) => e.ruleId === 'attack.failure.self').data.receipt.results, ['tails']);
  ({ g } = lock((s) => { s.players[1].active.conditions.rotation = 'confused'; }));
  attack(g, 'base:strike');
  s = g.snapshot();
  assert.equal(s.events.findLast((e) => e.ruleId === 'status.confusion' && 'heads' in e.data).data.heads, false);
  assert.equal(s.players[1].active.counters, 3);
  // 一树 under it: nothing to choose, the choice is spent, the coin is tails.
  ({ g } = lock((s) => { hand(s, 1, 'research'); }));
  command(g, { type: 'playTrainer', cardId: g.snapshot().players[1].hand.find((c) => g.snapshot().cards[c].definitionId === 'research') });
  attack(g, 'base:flip');
  s = g.snapshot();
  assert.deepEqual(s.events.findLast((e) => e.ruleId === 'effects.coin-choice').data.face, null);
  assert(!s.playerOngoing.some((e) => e.effect.op === 'coinChoice'));
  // The opponent's own coin in this turn (its protection) is random; so is the Checkup after the turn.
  ({ g, rng } = lock());
  attack(g, 'base:strike');
  const shield = g.snapshot().events.find((e) => e.ruleId === 'damage.prevention-coin');
  assert.equal(shield.data.player, 0); assert.equal(shield.data.result, randomIndex([...rng], 2) === 0 ? 'heads' : 'tails');
  ({ g, rng } = lock((s) => { s.players[1].active.conditions.rotation = 'asleep'; }));
  end(g);
  const sleep = g.snapshot().events.findLast((e) => e.ruleId === 'status.sleep' && 'heads' in e.data);
  assert.equal(sleep.data.heads, randomIndex([...rng], 2) === 0);
});

test('「…首次由于招式、特性、训练家的效果自己抛掷硬币时，其第一次的结果，可由自己决定」: the next such flips\' first coin, then spent', async () => {
  const f = await make();
  const willBoard = (mutate = () => {}) => {
    const g = board(f, (s) => { hand(s, 0, 'research'); hand(s, 0, 'potion'); attached(s, 0, s.players[0].active, 'water'); mutate(s); });
    play(g, 'research');
    assert.deepEqual(g.snapshot().playerOngoing.filter((e) => e.effect.op === 'coinChoice').map((e) => e.player), [0]);
    return g;
  };
  const face = (g, choice) => {
    const s = g.snapshot();
    assert.equal(s.pending.kind, 'coin-face'); assert.equal(s.pending.player, 0); assert.deepEqual(s.pending.options, ['heads', 'tails']);
    assert.deepEqual(g.view(0).pending.coins, { flipper: 0, results: [] });
    restore(g, f); answer(g, [choice]);
    assert(!g.snapshot().playerOngoing.some((e) => e.effect.op === 'coinChoice'));
    assert.equal(g.snapshot().events.findLast((e) => e.ruleId === 'effects.coin-choice').data.face, choice);
  };
  // An Item's coin: the chosen face; a later flip in the same turn is random again.
  let g = willBoard(), hand0 = g.snapshot().players[0].hand.length;
  play(g, 'potion'); face(g, 'heads');
  assert.deepEqual(coinEvents(g), ['heads']); assert.equal(g.snapshot().players[0].hand.length, hand0);
  attack(g, 'base:flip');
  assert.equal(coinEvents(g).length, 2); assert.notEqual(g.snapshot().pending?.kind, 'coin-face');
  // Damage coins: only the first coin is chosen; the paused preparation keeps its RNG boundary and replays on restore.
  g = willBoard((s) => { s.rng = seedFor(['heads']); });
  attack(g, 'base:roll');
  assert.equal(g.snapshot().attack.execution.damageCoins, null);
  face(g, 'tails');
  let s = g.snapshot();
  const entry = s.attack.execution.damageCoins.entries[0];
  assert.deepEqual([entry.firstFace, entry.receipt.results], ['tails', ['tails', 'heads']]);
  assert.equal(s.players[1].active.counters, 3);
  restore(g, f);
  const bad = clone(s); bad.attack.execution.damageCoins.entries[0].firstFace = 'heads';
  bad.events.find((e) => e.ruleId === 'damage.coins' && e.data.kind === 'prepared').data.data.entries[0].firstFace = 'heads';
  assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }), (e) => e.code === 'invalid-damage-coins');
  // The attack's own failure check, waiting before its body.
  g = willBoard(); attack(g, 'base:check');
  s = g.snapshot();
  assert.equal(s.attack.execution.phase, 'failure-check');
  const early = clone(s); early.attack.execution.failureReceipt = { results: ['heads'], heads: 1, tails: 0, passed: true };
  assert.throws(() => OfficialGame.restore(early, { catalog: f.catalog }), (e) => e.code === 'invalid-attack-failure');
  face(g, 'heads'); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 2);
  // Counted coins and a copy's coin are the attack's own flips too.
  g = willBoard((s) => { s.rng = seedFor(['tails']); }); hand0 = g.snapshot().players[0].hand.length;
  attack(g, 'base:coins'); face(g, 'heads');
  assert.equal(g.snapshot().players[0].hand.length, hand0 + 1, 'heads, then a random tails: one card');
  g = willBoard(); attack(g, 'base:copy'); face(g, 'heads');
  assert.equal(g.snapshot().pending.kind, 'copy-attack');
  // No Pokémon to flip for: zero damage coins leave it unspent for the attack's next coin.
  g = willBoard(); attack(g, 'base:zero');
  assert.equal(g.snapshot().events.filter((e) => e.ruleId === 'damage.coins' && e.data.kind === 'rolled').length, 1);
  face(g, 'tails');
  // Confusion is not a card effect: its coin is random and the choice waits for the attack's coin.
  g = willBoard((s) => { s.players[0].active.conditions.rotation = 'confused'; s.rng = seedFor(['heads']); });
  attack(g, 'base:flip');
  assert.equal(g.snapshot().events.findLast((e) => e.ruleId === 'status.confusion' && 'heads' in e.data).data.heads, true);
  face(g, 'tails');
});

test('一树 on an opponent\'s attack check before Confusion; never inside damage processing', async () => {
  const shield = binding('cn.protection@1', { effect: { op: 'protection', useRule: 'ordinary', channel: 'damage',
    scope: 'self', from: 'all', categories: ['attack'], coin: true } }, 'shield');
  const f = await make([], (defs) => {
    const other = def(defs, 'other').mechanics;
    other.effects = [shield];
    other.attacks.push({ ...clone(def(defs, 'base').mechanics.attacks.find((a) => a.attackId === 'base:recoil')), attackId: 'other:recoil' });
  });
  // Player 0 leaves 「…如果受到这个招式影响的宝可梦使用招式，则抛掷1次硬币。如果为反面，则那个招式失败」 on player 1's Active.
  const g = board(f, (s) => { hand(s, 1, 'research'); attached(s, 1, s.players[1].active, 'water'); s.players[1].active.conditions.rotation = 'confused'; });
  attack(g, 'base:smoke'); settle(g);
  assert.equal(g.snapshot().current, 1);
  command(g, { type: 'playTrainer', cardId: g.snapshot().players[1].hand.find((c) => g.snapshot().cards[c].definitionId === 'research') });
  attack(g, 'base:strike');
  let s = g.snapshot();
  assert.equal(s.pending.kind, 'coin-face'); assert.equal(s.pending.player, 1); assert.equal(s.pending.resume, 'attack');
  restore(g, f); answer(g, ['heads']);
  s = g.snapshot();
  assert.deepEqual(s.events.findLast((e) => e.ruleId === 'attack.failure.imposed').data.receipt.results, ['heads']);
  assert(s.events.some((e) => e.ruleId === 'effects.coin-choice' && e.data.face === 'heads'));
  assert(s.events.some((e) => e.ruleId === 'status.confusion' && 'heads' in e.data), 'Confusion flips after the imposed check, at random.');
  // A protection coin of the attacking player's own Pokémon, inside its own attack's damage, cannot pause for the choice.
  const h = board(f, (s) => {
    const p = s.players[0]; p.hand.push(...p.active.stack); p.active = bench(s, 0, 'other'); p.bench.pop();
    hand(s, 0, 'research');
  });
  play(h, 'research');
  assert.throws(() => attack(h, 'other:recoil'), (e) => e.code === 'unsupported-coin-choice');
});

test('「在自己的回合有1次机会，因自己宝可梦的招式而抛掷硬币时，可无视这次抛掷硬币的所有结果，重新抛掷硬币」: after the results, once a turn per card', async () => {
  const f = await make();
  let stadiumId, starId;
  const reflipBoard = ({ stadium = true, star = 0, mutate = () => {} } = {}) => board(f, (s) => {
    if (stadium) { stadiumId = hand(s, 1, 'stadium'); s.players[1].hand.pop(); s.stadium = stadiumId; }
    if (star !== null) starId = bench(s, star, 'other').stack[0];
    attached(s, 0, s.players[0].active, 'water'); mutate(s);
  });
  const reflip = (g, choice, options) => {
    const s = g.snapshot();
    assert.equal(s.pending.kind, 'coin-reflip'); assert.equal(s.pending.player, 0); assert.deepEqual(s.pending.options, options);
    const view = g.view(0).pending.coins;
    assert.equal(view.flipper, 0); assert.equal(view.results.length, s.pending.data.coinOccasion.receipt.flips);
    restore(g, f); answer(g, [choice]);
    return view;
  };
  // Either player's Stadium and the attacker's own Ability: two separate chances; the Stadium's is spent on the first coin.
  let g = reflipBoard({ mutate: (s) => { s.rng = seedFor(['tails', 'heads', 'tails', 'tails']); } });
  attack(g, 'base:flip2');
  const view = reflip(g, FOREST, ['keep', STAR, FOREST]);
  assert.deepEqual(view, { flipper: 0, results: ['tails'], reflip: { [FOREST]: stadiumId, [STAR]: starId } });
  let event = g.snapshot().events.findLast((e) => e.ruleId === 'effects.coin-reflip');
  assert.deepEqual([event.data.player, event.data.key, event.data.discarded], [0, FOREST, ['tails']]);
  assert.deepEqual(coinEvents(g), ['heads']);
  reflip(g, 'keep', ['keep', STAR]);
  assert.deepEqual(coinEvents(g), ['heads', 'tails']);
  assert.equal(g.snapshot().pending, null);
  // An opponent's Victini is not the attacker's; under a forced face and for an Item's coin there is nothing to offer.
  g = reflipBoard({ stadium: false, star: 1 }); attack(g, 'base:flip');
  assert.equal(g.snapshot().pending, null);
  g = reflipBoard({ mutate: (s) => { hand(s, 0, 'potion'); } }); play(g, 'potion');
  assert.equal(g.snapshot().pending, null);
  g = reflipBoard({ mutate: (s) => { fixtureClock(s, [0, 1, 0, 1]); } });
  attack(g, 'base:headache'); settle(g);
  attack(g, 'base:flip');
  assert.equal(g.snapshot().pending, null); assert.deepEqual(coinEvents(g), ['tails']);
  // Damage coins: the reflipped results replace the first ones; the restored game replays both from the private RNG.
  g = reflipBoard({ star: null, mutate: (s) => { s.rng = seedFor(['tails', 'tails', 'heads', 'heads']); } });
  attack(g, 'base:roll');
  assert.equal(g.snapshot().attack.execution.damageCoins, null);
  reflip(g, FOREST, ['keep', FOREST]);
  let s = g.snapshot();
  const entry = s.attack.execution.damageCoins.entries[0];
  assert.deepEqual([entry.discarded.results, entry.receipt.results, entry.reflip], [['tails', 'tails'], ['heads', 'heads'], FOREST]);
  assert.equal(s.players[1].active.counters, 6);
  restore(g, f);
  for (const edit of [(x) => { x.discarded.results = ['heads', 'tails']; x.discarded.heads = 1; x.discarded.tails = 1; }, (x) => { x.reflip = STAR; }]) {
    const bad = clone(s); edit(bad.attack.execution.damageCoins.entries[0]);
    bad.events.find((e) => e.ruleId === 'damage.coins' && e.data.kind === 'prepared').data.data = bad.attack.execution.damageCoins;
    assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }), (e) => e.code === 'invalid-damage-coins');
  }
  // Its own failure check: a reflip may pass it.
  g = reflipBoard({ star: null, mutate: (s) => { s.rng = seedFor(['tails', 'heads']); } });
  attack(g, 'base:check'); reflip(g, FOREST, ['keep', FOREST]); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 2);
  // Confusion and an opponent's imposed check are not the attack's coins.
  g = reflipBoard({ star: null, mutate: (s) => { s.players[0].active.conditions.rotation = 'confused'; s.rng = seedFor(['heads']); } });
  attack(g, 'base:strike');
  assert.equal(g.snapshot().pending, null); assert.equal(g.snapshot().players[1].active.counters, 2);
  g = reflipBoard({ star: null, mutate: (s) => { attached(s, 1, s.players[1].active, 'water'); } });
  attack(g, 'base:smoke'); settle(g);
  attack(g, 'base:strike');
  s = g.snapshot();
  assert(s.events.some((e) => e.ruleId === 'attack.failure.imposed')); assert.notEqual(s.pending?.kind, 'coin-reflip');
});

test('「…因招式的伤害或效果自己抛掷硬币而出现反面的话，则在自己的回合结束时…抽取3张卡牌」: once a turn, at that turn\'s end', async () => {
  const f = await make();
  let toolId;
  const policy = (faces, attackId, { stadium = false, mutate = () => {} } = {}) => {
    const g = board(f, (s) => {
      toolId = hold(s, 0, s.players[0].active, 'tool'); attached(s, 0, s.players[0].active, 'water'); s.rng = seedFor(faces);
      if (stadium) { const id = hand(s, 1, 'stadium'); s.players[1].hand.pop(); s.stadium = id; }
      mutate(s);
    });
    return { g, before: g.snapshot().players[0].hand.length };
  };
  const drawn = (g, before) => g.snapshot().players[0].hand.length - before;
  // A tails: recorded at once, drawn at the end of the attacker's turn.
  let { g, before } = policy(['tails'], 'base:flip');
  attack(g, 'base:flip');
  let s = g.snapshot();
  assert.equal(s.current, 1); assert.equal(drawn(g, before), 3);
  const recorded = s.events.find((e) => e.ruleId === 'tools.attack-tails');
  assert.deepEqual([recorded.data.player, recorded.data.cardId], [0, toolId]);
  restore(g, f);
  // Heads: nothing.
  ({ g, before } = policy(['heads'], 'base:flip')); attack(g, 'base:flip');
  assert.equal(drawn(g, before), 1, 'The coin effect\'s card only.'); assert(!g.snapshot().events.some((e) => e.ruleId === 'tools.attack-tails'));
  // Two tails in one attack: still 3 cards.
  ({ g, before } = policy(['tails', 'tails'], 'base:flip2')); attack(g, 'base:flip2');
  assert.equal(drawn(g, before), 3); assert.equal(g.snapshot().events.filter((e) => e.ruleId === 'tools.attack-tails').length, 1);
  // The attack's own failure check: it fails and still draws; damage coins count too.
  ({ g, before } = policy(['tails'], 'base:check')); attack(g, 'base:check');
  s = g.snapshot();
  assert.equal(s.players[1].active.counters, 0); assert.equal(drawn(g, before), 3);
  ({ g, before } = policy(['heads', 'tails'], 'base:roll')); attack(g, 'base:roll'); answer(g, ['skip']);
  assert.equal(drawn(g, before), 3);
  // A tails reflipped to heads is no tails; a kept tails is.
  ({ g, before } = policy(['tails', 'heads'], 'base:flip', { stadium: true })); attack(g, 'base:flip');
  answer(g, [FOREST]);
  assert.equal(drawn(g, before), 1, 'The reflipped heads draws the coin effect\'s card only.');
  ({ g, before } = policy(['tails'], 'base:flip', { stadium: true })); attack(g, 'base:flip');
  answer(g, ['keep']);
  assert.equal(drawn(g, before), 3);
  // Confusion is no attack's damage or effect.
  ({ g, before } = policy(['tails'], 'base:strike', { mutate: (s) => { s.players[0].active.conditions.rotation = 'confused'; } }));
  attack(g, 'base:strike');
  assert.equal(drawn(g, before), 0);
  // Attaching the Tool runs nothing; a Pokémon without it records nothing.
  ({ g, before } = policy(['tails'], 'base:flip', { mutate: (s) => { const p = s.players[0]; p.hand.push(p.active.tools.pop()); } }));
  play(g, 'tool'); answer(g, [g.snapshot().pending.options[0]]);
  assert.equal(g.snapshot().playerOngoing.length, 0);
  ({ g, before } = policy(['tails'], 'base:flip', { mutate: (s) => { const p = s.players[0]; p.hand.push(p.active.tools.pop()); } }));
  attack(g, 'base:flip');
  assert.equal(drawn(g, before), 0);
});

test('「抛掷2次硬币，将与出现正面次数相同数量的…能量放于弃牌区。如果全是反面，则这个招式失败」: one pair of coins for both', async () => {
  const f = await make();
  for (const [faces, counters, discarded] of [[['tails', 'tails'], 0, 0], [['heads', 'tails'], 3, 1], [['heads', 'heads'], 3, 2]]) {
    const g = board(f, (s) => {
      attached(s, 1, s.players[1].active, 'water'); attached(s, 1, s.players[1].active, 'water'); attached(s, 1, s.players[1].active, 'water');
      s.rng = seedFor(faces);
    });
    const rng = g.snapshot().rng;
    attack(g, 'base:twister');
    const q = g.snapshot().pending;
    if (discarded) { assert.equal(q.player, 0); answer(g, q.options.slice(0, discarded)); }
    assert.equal(g.snapshot().pending, null);
    const s = g.snapshot();
    assert.equal(s.players[1].active.counters, counters); assert.equal(s.players[1].active.energy.length, 3 - discarded);
    const failure = s.events.findLast((e) => e.ruleId === 'attack.failure.self').data.receipt;
    assert.deepEqual(failure.results, faces);
    const read = s.events.filter((e) => e.ruleId === 'effects.coin' && e.data.effectId?.endsWith('twister'));
    assert.deepEqual(read.map((e) => e.data.receipt.results), counters ? [faces] : []);
    // Only two coins were ever flipped.
    const replay = [...rng]; randomIndex(replay, 2); randomIndex(replay, 2);
    assert.deepEqual(s.rng, replay);
    if (counters) restore(g, f);
  }
});
