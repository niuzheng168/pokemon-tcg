// Synthetic definitions only. 「身上放有这张卡牌的宝可梦，即使处于【睡眠】或【麻痹】状态，也可使用招式。」 (attack.ignore-conditions);
// 「身上放有这张卡牌的宝可梦使用招式的伤害，在计算对手战斗宝可梦的弱点时，其弱点按照「×3」计算。」 (damage.weakness-multiplier);
// 「在下一个对手的回合，身上附着的能量在2个及以下的所有宝可梦，无法使用招式。（也包括新出场的宝可梦。）」 (effects.energy-units-filter,
// effects.player-pokemon-exempt). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, assertSupportedDefinition } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { assertPlayerOngoingEffect } from '../../public/rules/ongoing.js';
import { applyCondition } from '../../public/rules/conditions.js';
import { fixture, binding, EVIDENCE, board, command, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers(), catalog = { handler: (id) => handlers.get(id) };
const canAttack = (g) => g.view(g.snapshot().current).legalActions.some((a) => a.type === 'attack');
const strike = (g) => { command(g, { type: 'attack', attackId: 'base:strike' }); settle(g); };
const endTurn = (g) => { command(g, { type: 'endTurn' }); settle(g); };
const tool = (s, owner, m) => { const id = hand(s, owner, 'tool'); s.players[owner].hand.pop(); m.tools.push(id); return id; };
const swapActive = (s, owner, id) => { const p = s.players[owner], m = bench(s, owner, id); p.bench.pop(); p.bench.push(p.active); p.active = m; return m; };

const arm = binding('cn.attackRule@1', { effect: { op: 'attackRule', scope: 'self', ignoreConditions: true } }, 'arm');

test('schema: 「即使处于【睡眠】或【麻痹】状态，也可使用招式」 is the holder\'s own attack rule', async () => {
  const valid = handlers.get('cn.attackRule@1').validateParameters;
  assert(valid(arm.parameters));
  for (const effect of [{ op: 'attackRule', scope: 'self' }, { op: 'attackRule', scope: 'all', ignoreConditions: true },
    { op: 'attackRule', scope: 'self', ignoreConditions: false }, { op: 'retreatRule', scope: 'self', ignoreConditions: true }])
    assert(!valid({ effect }), JSON.stringify(effect));
  // A Stadium has no Pokémon of its own; a Tool's holder has.
  const f = await fixture();
  for (const [id, error] of [['stadium', /Stadium has no Pokémon of its own/], ['tool', null]]) {
    const card = clone(def(f.definitions, id));
    card.mechanics.effects = [arm];
    if (error) assert.throws(() => assertSupportedDefinition(catalog, card), error); else assertSupportedDefinition(catalog, card);
  }
});

test('「身上放有这张卡牌的宝可梦，即使处于【睡眠】或【麻痹】状态，也可使用招式」', async () => {
  const f = await fixture((defs) => {
    def(defs, 'tool').mechanics.effects = [arm];
    // 「对手的处于【睡眠】状态的宝可梦无法使用招式」: another effect still stops it (JP Q&A からくりアーム × エルフーンV「おじゃまなわたげ」).
    def(defs, 'other').mechanics.abilities = [{ abilityId: 'other:drowse', name: '测试催眠锁', mode: 'continuous', usage: null, sourceOfTruth: EVIDENCE,
      effects: [binding('cn.restriction@1', { effect: { op: 'restriction', scope: 'opponent', actions: ['attack'], targetState: { conditions: ['asleep'] } } }, 'drowse')] }];
  });
  const plain = await fixture();
  const sleepy = (fx, rotation, { where = 'active', lock = false } = {}) => board(fx, (s) => {
    const p = s.players[0];
    attached(s, 0, p.active, 'water');
    tool(s, 0, where === 'active' ? p.active : bench(s, 0, 'other'));
    p.active.conditions = applyCondition(p.active.conditions, rotation, { ownerTurn: p.turns }).conditions;
    if (lock) swapActive(s, 1, 'other');
  });
  for (const rotation of ['asleep', 'paralyzed']) {
    assert(canAttack(sleepy(f, rotation)), rotation);
    assert(!canAttack(sleepy(plain, rotation)), 'Without it, step 1b applies.');
    assert(!canAttack(sleepy(f, rotation, { where: 'bench' })), 'Only its holder.');
  }
  assert(!canAttack(sleepy(f, 'asleep', { lock: true })), 'An effect stopping Asleep Pokémon still applies.');
  assert(canAttack(sleepy(f, 'paralyzed', { lock: true })));
  const g = sleepy(f, 'asleep');
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  strike(g);
  const s = g.snapshot();
  assert.equal(s.players[1].active.counters, 2, 'The Asleep holder attacked.');
  assert.deepEqual(restore(g, f).snapshot(), s);
});

const glasses = { effect: { op: 'attackDamageOptions', scope: 'self', weaknessMultiplier: 3 } };

test('schema: 「其弱点按照「×3」计算」 is an option of the holder\'s own attacks', () => {
  const valid = handlers.get('cn.attackDamageOptions@1').validateParameters;
  assert(valid(glasses));
  assert(valid({ effect: { ...glasses.effect, targetSelector: { kind: 'pokemon', types: ['Water'] } } }));
  for (const effect of [{ ...glasses.effect, weaknessMultiplier: 4 }, { ...glasses.effect, received: true },
    { ...glasses.effect, scope: 'all', received: true, ignoreWeakness: true }])
    assert(!valid({ effect }), JSON.stringify(effect));
  const player = handlers.get('cn.lastingPlayer@1').validateParameters;
  assert(player({ side: 'own', duration: 'thisTurn', effect: { op: 'attackDamageOptions', scope: 'own', ignoreDefenderEffects: true } }));
  assert(!player({ side: 'own', duration: 'thisTurn', effect: { op: 'attackDamageOptions', scope: 'own', weaknessMultiplier: 3 } }));
});

test('「身上放有这张卡牌的宝可梦使用招式的伤害，在计算对手战斗宝可梦的弱点时，其弱点按照「×3」计算」', async () => {
  const make = (weakness) => fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.weakness = weakness;
    def(defs, 'tool').mechanics.effects = [binding('cn.attackDamageOptions@1', glasses, 'glasses')];
    // 「双方所有宝可梦的弱点，均以「×4」计算伤害」
    def(defs, 'stadium').mechanics.effects = [binding('cn.property@1', { effect: { op: 'property', field: 'weaknessMultiplier', value: 4, scope: 'all' } }, 'times')];
  });
  const times = await make({ type: 'Water', operation: 'multiply', value: 2 }), plus = await make({ type: 'Water', operation: 'add', value: 20 });
  const run = (f, { holder = null, stadium = false } = {}) => {
    const g = board(f, (s) => {
      const p = s.players[0];
      attached(s, 0, p.active, 'water');
      if (holder) tool(s, 0, holder === 'active' ? p.active : bench(s, 0, 'other'));
      if (stadium) s.stadium = s.players[1].deck.splice(s.players[1].deck.findIndex((id) => s.cards[id].definitionId === 'stadium'), 1)[0];
    });
    strike(g);
    assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
    return g.snapshot().players[1].active.counters * 10;
  };
  assert.equal(run(times), 40);
  assert.equal(run(times, { holder: 'active' }), 60);
  assert.equal(run(times, { holder: 'bench' }), 40, 'Only the holder\'s attacks.');
  // The damaged Pokémon's own 「×4」 is used instead (JP Q&A ばつぐんグラス × ユクシー「ひみつのテリトリー」).
  assert.equal(run(times, { holder: 'active', stadium: true }), 80);
  assert.equal(run(times, { stadium: true }), 80);
  // A 「+20」 Weakness is calculated ×3 / ×4 too (JP Q&A ラフレシア「アレルギーパニック」).
  assert.equal(run(plus), 40);
  assert.equal(run(plus, { holder: 'active' }), 60);
  assert.equal(run(plus, { stadium: true }), 80);
  assert.equal(run(plus, { holder: 'active', stadium: true }), 80);
});

const freeze = { side: 'own', effect: { op: 'restriction', scope: 'opponent', actions: ['attack'], targetEnergyUnitsAtMost: 2 }, duration: 'nextOpponentTurn' };

test('schema: 「身上附着的能量在2个及以下的所有宝可梦，无法使用招式」', () => {
  const valid = handlers.get('cn.lastingPlayer@1').validateParameters;
  assert(valid(freeze));
  assert(valid({ ...freeze, effect: { ...freeze.effect, targetEnergyUnitsAtMost: 0, targetSelector: { kind: 'pokemon', stages: ['basic'] } } }));
  for (const units of [-1, 61, 1.5]) assert(!valid({ ...freeze, effect: { ...freeze.effect, targetEnergyUnitsAtMost: units } }), String(units));
  assert(handlers.get('cn.restriction@1').validateParameters({ effect: { op: 'restriction', scope: 'all', actions: ['attack'], targetEnergyUnitsAtMost: 2 } }));
});

test('「在下一个对手的回合，身上附着的能量在2个及以下的所有宝可梦，无法使用招式。（也包括新出场的宝可梦。）」', async () => {
  const make = (effect) => fixture((defs) => {
    def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.lastingPlayer@1', { ...freeze, effect }, 'freeze')];
    def(defs, 'other').mechanics.attacks[0].cost = [];
  });
  const f = await make(freeze.effect), typed = await make({ ...freeze.effect, targetSelector: { kind: 'pokemon', types: ['Water'] } });
  for (const fx of [f, typed]) {
    const theirs = (...energy) => {
      const g = board(fx, (s) => { attached(s, 0, s.players[0].active, 'water'); for (const id of energy) attached(s, 1, s.players[1].active, id); });
      strike(g);
      assert.equal(g.snapshot().current, 1);
      return g;
    };
    assert(!canAttack(theirs('water')), '1 Energy.');
    assert(!canAttack(theirs('water', 'water')), '2 Energy.');
    assert(canAttack(theirs('water', 'water', 'water')), '3 Energy.');
    // 「被视作2个能量」: one card counts 2 (II.C-01 FAQ).
    assert(canAttack(theirs('water', 'double')), '2 cards, 3 Energy.');
  }
  // Read when attacking: the turn's attachment frees it. Then a Pokémon put into play later is included: benched now, moved up by
  // Retreat, 0 Energy and a free attack (without the effect it could attack).
  const later = (fx) => {
    const g = board(fx, (s) => {
      attached(s, 0, s.players[0].active, 'water');
      for (let i = 0; i < 2; i++) attached(s, 1, s.players[1].active, 'water');
      hand(s, 1, 'water'); hand(s, 1, 'other');
    });
    strike(g);
    const locked = !canAttack(g);
    assert.deepEqual(restore(g, fx).snapshot(), g.snapshot());
    const water = g.snapshot().players[1].hand.find((id) => g.snapshot().cards[id].definitionId === 'water');
    command(g, { type: 'attachEnergy', cardId: water, pokemonId: g.snapshot().players[1].active.id }); settle(g);
    assert(canAttack(g), 'Now 3 Energy.');
    const other = g.snapshot().players[1].hand.find((id) => g.snapshot().cards[id].definitionId === 'other');
    command(g, { type: 'bench', cardId: other }); settle(g);
    command(g, { type: 'retreat' }); settle(g);
    const s = g.snapshot();
    assert.equal(s.cards[s.players[1].active.stack[0]].definitionId, 'other');
    return { g, locked, newcomer: !canAttack(g) };
  };
  assert.deepEqual((({ locked, newcomer }) => ({ locked, newcomer }))(later(await fixture((defs) => { def(defs, 'other').mechanics.attacks[0].cost = []; }))),
    { locked: false, newcomer: false });
  const { g, locked, newcomer } = later(f);
  assert(locked, '2 Energy.');
  assert(newcomer, 'The new Active Pokémon has no Energy.');
  endTurn(g);
  assert.equal(g.snapshot().current, 0);
  assert(!g.snapshot().playerOngoing.some((e) => e.effect.op === 'restriction'), 'Over with that turn.');
});

test('a Pokémon protected from the attack\'s effects when it is used is not affected; protection gained later does not help', async () => {
  const f = await fixture((defs) => {
    def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.lastingPlayer@1', freeze, 'freeze')];
    def(defs, 'other').mechanics.attacks[0].cost = [];
    // 「身上附着了这张卡牌（放有这张卡牌）的宝可梦，不会受到对手宝可梦所使用招式的效果影响」 (like ミストエネルギー; the Energy is still 2 Energy).
    const mist = binding('cn.protection@1', { effect: { op: 'protection', channel: 'effects', useRule: 'ordinary', scope: 'self', from: 'opponent',
      categories: ['attack'] } }, 'mist');
    def(defs, 'double').mechanics.effects = [mist];
    def(defs, 'hp-tool').mechanics.effects = [mist];
  });
  let shielded, bare;
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water');
    shielded = swapActive(s, 1, 'other'); attached(s, 1, shielded, 'water');
    const id = hand(s, 1, 'hp-tool'); s.players[1].hand.pop(); shielded.tools.push(id);
    bare = bench(s, 1, 'other'); hand(s, 1, 'double');
  });
  strike(g);
  const entry = g.snapshot().playerOngoing.find((e) => e.effect.op === 'restriction');
  assert.deepEqual(entry.exemptIds, [shielded.id]);
  assert(g.snapshot().events.some((e) => e.ruleId === 'effects.protection' && e.data.targetId === shielded.id));
  assert(canAttack(g), 'Protected when the attack was used (JP Q&A トドゼルガ × ミストエネルギー).');
  assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  for (const forged of [{ ...entry, effect: { op: 'coinChoice' } }, { ...entry, exemptIds: [] }])
    assert.throws(() => assertPlayerOngoingEffect(forged, g.snapshot()), /Invalid player ongoing effect/);
  // The Benched one was not protected: switched in and given the protecting Energy now, it still cannot attack.
  command(g, { type: 'retreat' }); settle(g, (q) => q.options.includes(bare.id) ? [bare.id] : q.options.slice(0, q.minimum));
  assert.equal(g.snapshot().players[1].active.id, bare.id);
  const double = g.snapshot().players[1].hand.find((id) => g.snapshot().cards[id].definitionId === 'double');
  command(g, { type: 'attachEnergy', cardId: double, pokemonId: bare.id }); settle(g);
  assert(!canAttack(g), 'Effects already received do not end (II.C-17; JP Q&A トドゼルガ × ミストエネルギー).');
});
