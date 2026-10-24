// Synthetic definitions only. Abilities removed or given with special conditions and durations:
// 「只要这只宝可梦在备战区，双方备战区中所有【2阶进化】宝可梦的特性，全部消除。」 and
// 「只要这只宝可梦在备战区，双方场上的◇（棱镜之星）宝可梦，就无法使用招式，特性也全部消除。」 (effects.remove-bench);
// 「只要这只宝可梦在场上，就将双方所有宝可梦的令自身【昏厥】的效果的特性全部消除。」 (effects.remove-self-knockout);
// 「在这个回合结束前，对手战斗宝可梦的特性，全部消除。（也包括新被放于战斗场的宝可梦。）」 (effects.player-ability-removal);
// 「受到这个招式影响的宝可梦，使用招式所需能量增加2个【无】能量，且无法撤退。这个效果，一直持续到这只「八爪武师」离开战斗场，且无法叠加。」
// (effects.duration.user-leaves-active); 「这只宝可梦，在离开场上之前都拥有效果为「对手场上所有宝可梦的弱点，变为【超】属性。」的特性。」 and
// 「…拥有效果为「对手场上的『宝可梦V』（除『化石翼龙VSTAR』外）的特性，全部消除。」的特性。」 (ability.granted, effects.duration.leave-play);
// 「这张卡牌，可被视作1个【无】能量。只要这张卡牌，被附着于【2阶进化】宝可梦身上，就可被视作1个所有属性的能量。如果在自己场上有3只以上
// （包含3只）【2阶进化】宝可梦的话，则可被视作4个所有属性的能量。」 (energy.provision-conditions). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { validateSuppressionEffect } from '../../public/rules/schema-validators.js';
import { ENERGY_TYPES } from '../../public/rules/damage.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, board, command, settle, hand, bench, attached } from './fixtures.mjs';

const handlers = createCoreHandlers();
const clone = (value) => JSON.parse(JSON.stringify(value));
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const valid = (id, p) => handlers.get(id).validateParameters(clone(p));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const forged = (g, f, mutate) => { const s = clone(g.snapshot()); mutate(s); return () => OfficialGame.restore(s, { catalog: f.catalog }); };
const ability = (id, effects, mode = 'continuous', extra = {}) => ({ abilityId: id, name: `测试${id}`, mode, usage: null, effects,
  sourceOfTruth: EVIDENCE, ...extra });
const hpBoost = (id) => ability(id, [binding('cn.modifier@1', { field: 'hp', amount: 50, scope: 'self' }, id)]);
const removal = (extra) => binding('cn.suppression@1', { effect: { op: 'suppression', channel: 'abilities', scope: 'all', ...extra } }, 'removal');
const mon = (g, owner, id) => { const p = g.view(owner).players[owner]; return [p.active, ...p.bench].find((m) => m.id === id); };
const present = (g, owner, id) => mon(g, owner, id).effective.abilities.map((a) => a.present);
const swap = (s, owner, m) => { const p = s.players[owner]; p.bench = [p.active, ...p.bench.filter((b) => b !== m)]; p.active = m; };
// 'evolution' read as a Stage 2 Pokémon (its printed stage).
const stage2 = (defs, abilities = []) => Object.assign(def(defs, 'evolution').mechanics, { stage: 'stage2', abilities,
  basicAncestor: { nameKey: 'base', sourceOfTruth: EVIDENCE } });
const gust = (side = 'opponent') => binding('cn.switch@1', { side, chooser: 'self', affected: 'selected' }, `gust-${side}`);

test('schemas: the Bench, printed-card and self-Knock-Out filters of a removal', () => {
  const spec = (extra) => ({ op: 'suppression', channel: 'abilities', scope: 'all', ...extra });
  for (const extra of [{ sourceBench: true, benchOnly: true, stage: 'stage2' }, { targetCard: { kind: 'pokemon', prismStar: true } },
    { targetCard: { kind: 'pokemon', tagsAll: ['V'], excludeNameKeys: ['x'] } }, { selfKnockOut: true }, { sourceBench: true, sourceActive: false }])
    assert(validateSuppressionEffect(spec(extra)), JSON.stringify(extra));
  for (const extra of [{ sourceBench: true, sourceActive: true }, { benchOnly: true, activeOnly: true }, { benchOnly: true, outOfPlay: true },
    { sourceBench: false }, { benchOnly: false }, { selfKnockOut: true, channel: 'tools' }, { targetCard: { kind: 'pokemon', types: ['Water'] } },
    { targetCard: { kind: 'trainer' } }])
    assert(!validateSuppressionEffect(spec(extra)), JSON.stringify(extra));
  for (const id of ['effects.remove-bench', 'effects.remove-self-knockout', 'effects.player-ability-removal', 'effects.duration.leave-play', 'ability.granted'])
    assert(requireRule(CN_V20261019, id).sourceOfTruth.some((s) => s.documentId === 'JP-official-qa'), id);
});

// 「只要这只宝可梦在备战区，双方备战区中所有【2阶进化】宝可梦的特性，全部消除」: 'other' is the source, 'evolution' a Stage 2 here.
const sticky = async () => {
  const f = await fixture((defs) => {
    def(defs, 'other').mechanics.abilities = [ability('other:bind', [removal({ stage: 'stage2', sourceBench: true, benchOnly: true })])];
    stage2(defs, [hpBoost('evolution:boost')]);
  });
  f.deck.splice(20, 2, 'printing:evolution', 'printing:evolution');
  return f;
};

test('「只要这只宝可梦在备战区，双方备战区中所有【2阶进化】宝可梦的特性」: only while the source is Benched, only Benched Stage 2', async () => {
  const f = await sticky();
  let source, own, theirs, active;
  const g = board(f, (s) => {
    source = bench(s, 0, 'other'); own = bench(s, 0, 'evolution'); theirs = bench(s, 1, 'evolution');
    active = bench(s, 1, 'evolution'); swap(s, 1, active);
  });
  assert.deepEqual([present(g, 0, own.id), present(g, 1, theirs.id), present(g, 1, active.id)], [[false], [false], [true]],
    'Both Benches; the Active Stage 2 keeps its Ability.');
  assert.deepEqual(mon(g, 1, theirs.id).effective.maxHp, 150);
  restore(g, f);
  const h = board(f, (s) => { source = bench(s, 0, 'other'); own = bench(s, 0, 'evolution'); swap(s, 0, source); });
  assert.deepEqual(present(h, 0, own.id), [true], 'The source in the Active Spot removes nothing.');
  const stadium = await fixture((defs) => { def(defs, 'stadium').mechanics.effects = [removal({ sourceBench: true })];
    def(defs, 'base').mechanics.abilities = [hpBoost('base:boost')]; });
  const k = board(stadium, (s) => { s.stadium = hand(s, 0, 'stadium'); s.players[0].hand.pop(); });
  assert.deepEqual(present(k, 0, k.snapshot().players[0].active.id), [true], 'A Stadium is no Pokémon on a Bench.');
});

// 「只要这只宝可梦在备战区，双方场上的◇（棱镜之星）宝可梦，就无法使用招式，特性也全部消除」: two entries, one removal and one restriction.
const shade = () => fixture((defs) => {
  def(defs, 'other').mechanics.abilities = [ability('other:shade', [
    removal({ sourceBench: true, targetCard: { kind: 'pokemon', prismStar: true } }),
    binding('cn.restriction@1', { effect: { op: 'restriction', scope: 'all', actions: ['attack'],
      targetSelector: { kind: 'pokemon', prismStar: true }, condition: { kind: 'pokemonIs', who: 'self', position: 'bench' } } }, 'shade-lock')])];
  const star = def(defs, 'base');
  star.prismStar = { sourceOfTruth: clone(EVIDENCE) }; star.deckLimits.sameName = 1; star.mechanics.ruleBox = true;
  star.mechanics.abilities = [hpBoost('base:boost')];
});

test('「双方场上的◇（棱镜之星）宝可梦，就无法使用招式，特性也全部消除」 while the source is on the Bench', async () => {
  const f = await shade();
  f.deck = f.deck.map((id, i) => id === 'printing:base' && f.deck.indexOf(id) !== i ? 'printing:water' : id);
  const run = (benched) => board(f, (s) => {
    for (const p of s.players) p.hand.push(...p.active.stack);
    s.players[0].active = null; s.players[1].active = null;
    s.players[0].active = bench(s, 0, 'base'); s.players[0].bench.pop();
    s.players[1].active = bench(s, 1, benched ? 'evolution' : 'other'); s.players[1].bench.pop();
    if (benched) bench(s, 1, 'other');
    attached(s, 0, s.players[0].active, 'water');
  });
  const g = run(true), star = g.snapshot().players[0].active;
  assert.deepEqual(present(g, 0, star.id), [false]);
  assert(!g.view(0).legalActions.some((a) => a.type === 'attack'), 'The Prism Star Pokémon cannot attack.');
  restore(g, f);
  const h = run(false);
  assert.deepEqual(present(h, 0, h.snapshot().players[0].active.id), [true], 'The source in the Active Spot.');
  assert(h.view(0).legalActions.some((a) => a.type === 'attack'));
});

// 「…令自身【昏厥】的效果的特性全部消除」: 'evolution' Knocks itself Out inside a coin; 'base' has an ordinary activated Ability.
const damp = () => fixture((defs) => {
  def(defs, 'other').mechanics.abilities = [ability('other:damp', [removal({ selfKnockOut: true })])];
  const usage = (key) => ({ period: 'turn', scope: 'pokemon', key, limit: 1 });
  def(defs, 'evolution').mechanics.abilities = [ability('evolution:blast', [binding('cn.coin@1', { outcome: 'heads',
    effect: { handlerId: 'cn.knockOut@1', parameters: { target: 'self' } } }, 'blast'), binding('cn.draw@1', { count: 1 }, 'blast-draw')],
  'activated', { usage: usage('blast') })];
  def(defs, 'base').mechanics.abilities = [ability('base:dig', [binding('cn.draw@1', { count: 1 }, 'dig')], 'activated', { usage: usage('dig') }),
    ability('base:pop', [binding('cn.knockOut@1', { target: 'self' }, 'pop'), binding('cn.draw@1', { count: 2 }, 'pop-draw')],
      'activated', { usage: usage('pop') })];
});

test('「双方所有宝可梦的令自身【昏厥】的效果的特性全部消除」: only Abilities that Knock Out their own Pokémon', async () => {
  const f = await damp();
  let blaster;
  const g = board(f, (s) => { blaster = bench(s, 0, 'evolution'); bench(s, 1, 'other'); });
  const active = g.snapshot().players[0].active.id;
  assert.deepEqual([present(g, 0, blaster.id), present(g, 0, active)], [[false], [true, false]]);
  const abilities = g.view(0).legalActions.filter((a) => a.type === 'useAbility').map((a) => a.abilityId);
  assert.deepEqual(abilities, ['base:dig'], 'Damp-like removal: the self-Knock-Out Abilities cannot be used, others can.');
  restore(g, f);
  const h = board(f, (s) => { blaster = bench(s, 0, 'evolution'); });
  assert.deepEqual(present(h, 0, blaster.id), [true], 'Without the source.');
});

// 「在这个回合结束前，对手战斗宝可梦的特性，全部消除。（也包括新被放于战斗场的宝可梦。）」 on an Item ('potion'); 'poison' is a gust here.
const cologneEffect = { op: 'suppression', channel: 'abilities', scope: 'opponent', activeOnly: true };
const cologne = { side: 'own', duration: 'thisTurn', effect: cologneEffect };
// 「这只宝可梦，不会受到对手的物品…的效果影响」 as an own Ability (キバゴ「きんちょうかん」 in the JP ruling).
const tension = ability('base:tension', [binding('cn.protection@1', { effect: { op: 'protection', channel: 'effects', useRule: 'CN.E29',
  scope: 'self', from: 'opponent', categories: ['trainer'], trainerCategories: ['item'], trainerOrigins: ['hand'] } }, 'tension')]);
const perfume = async (baseAbilities = [hpBoost('base:boost')]) => {
  const f = await fixture((defs) => {
    def(defs, 'potion').mechanics.effects = [binding('cn.lastingPlayer@1', cologne, 'cologne')];
    def(defs, 'poison').mechanics.effects = [gust()];
    def(defs, 'research').mechanics.effects = [gust()];
    def(defs, 'base').mechanics.abilities = baseAbilities;
    def(defs, 'other').mechanics.abilities = [hpBoost('other:boost')];
  });
  f.deck.splice(20, 3, 'printing:potion', 'printing:poison', 'printing:poison');
  return f;
};
const play = (g, card) => { command(g, { type: 'playTrainer', cardId: card }); settle(g); };
const playable = (g, card) => g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card);

test('schemas: a player removal of the opponent\'s Active Pokémon\'s Abilities is an Item\'s, this turn only', async () => {
  assert(valid('cn.lastingPlayer@1', cologne));
  for (const p of [{ ...cologne, side: 'opponent' }, { ...cologne, duration: 'nextOpponentTurn' }, { ...cologne, clearOnLeaveActive: true },
    { ...cologne, effect: { ...cologneEffect, scope: 'all' } }, { ...cologne, effect: { ...cologneEffect, activeOnly: false } },
    { ...cologne, effect: { ...cologneEffect, sourceActive: true } }, { ...cologne, effect: { ...cologneEffect, channel: 'tools' } }])
    assert(!valid('cn.lastingPlayer@1', p), JSON.stringify(p));
  const supporter = await fixture((defs) => { def(defs, 'research').mechanics.effects = [binding('cn.lastingPlayer@1', cologne, 'cologne')]; });
  assert.throws(() => board(supporter), (e) => e.code === 'unsupported-handler', 'Its protection ruling is about an Item.');
});

test('「对手战斗宝可梦的特性，全部消除（也包括新被放于战斗场的宝可梦）」 until this turn ends; not again in the same turn', async () => {
  const f = await perfume();
  let item, again, pull, benched;
  const g = board(f, (s) => { item = hand(s, 0, 'potion'); again = hand(s, 0, 'potion'); pull = hand(s, 0, 'poison'); benched = bench(s, 1, 'other'); });
  const active = g.snapshot().players[1].active.id;
  play(g, item);
  assert.deepEqual([present(g, 1, active), present(g, 1, benched.id)], [[false], [true]], 'The Active Pokémon only.');
  assert.deepEqual([g.snapshot().playerOngoing[0].exemptId, g.view(1).playerOngoing[0].rule.ruleId], [undefined, 'effects.player-ability-removal']);
  assert(!playable(g, again), 'The same removal is already in force this turn (JP Q&A キャンセルコロン).');
  restore(g, f);
  play(g, pull);
  assert.deepEqual([present(g, 1, active), present(g, 1, benched.id)], [[true], [false]], 'The Pokémon newly put into the Active Spot.');
  command(g, { type: 'endTurn' }); settle(g);
  assert.deepEqual([g.snapshot().playerOngoing.length, present(g, 1, benched.id)], [0, [true]], 'Gone when this turn ends.');
});

test('the Active Pokémon protected from the Item when it is played keeps its Abilities only while it stays there', async () => {
  const f = await perfume([tension, hpBoost('base:boost')]);
  let item, pull, back, benched;
  const g = board(f, (s) => { item = hand(s, 0, 'potion'); pull = hand(s, 0, 'poison'); back = hand(s, 0, 'research'); benched = bench(s, 1, 'other'); });
  const active = g.snapshot().players[1].active.id;
  play(g, item);
  assert.deepEqual(present(g, 1, active), [true, true], 'Protected from Item effects when the effect began (JP Q&A キバゴ).');
  assert.equal(g.snapshot().playerOngoing[0].exemptId, active);
  assert(g.snapshot().events.some((e) => e.ruleId === 'effects.protection' && e.data.targetId === active));
  restore(g, f);
  assert.throws(forged(g, f, (s) => { s.playerOngoing[0].exemptId = benched.id; }), (e) => e.code === 'invalid-player-effect');
  assert.throws(forged(g, f, (s) => { s.playerOngoing[0].effect.op = 'restriction'; }), (e) => e.code !== undefined);
  play(g, pull);
  assert.equal(g.snapshot().playerOngoing[0].exemptId, undefined, 'It left the Active Spot.');
  assert.deepEqual([present(g, 1, active), present(g, 1, benched.id)], [[true, true], [false]]);
  play(g, back);
  assert.equal(g.snapshot().players[1].active.id, active, 'A Supporter brings it back (its Ability protects from Items only).');
  assert.deepEqual(present(g, 1, active), [false, false], 'Back in the Active Spot: its protecting Ability is already removed.');
  restore(g, f);
});

// 「受到这个招式影响的宝可梦，使用招式所需能量增加2个【无】能量，且无法撤退。这个效果，一直持续到这只「八爪武师」离开战斗场，且无法叠加。」
// ('base' plays 八爪武师): a user that is not that card (a copy) gives no effect, so both entries sit under its name.
const octoLasting = (effect) => ({ handlerId: 'cn.lasting@1', parameters: { side: 'opponent', target: 'active', effect,
  duration: 'untilLeavesActive', clearOnBench: true, clearOnEvolution: true, clearOnLeaveActive: true } });
const octolock = binding('cn.when@1', { condition: { kind: 'pokemonIs', who: 'self', selector: { kind: 'pokemon', nameKeys: ['base'] } }, effects: [
  octoLasting({ op: 'energyRequirement', action: 'attack', mode: 'adjust', scope: 'all', energyType: 'Colorless', amount: 2, group: '八爪武师' }),
  octoLasting({ op: 'restriction', scope: 'all', actions: ['retreat'] })] }, 'octolock');
const octopus = async () => {
  const f = await fixture((defs) => {
    for (const id of ['base', 'other']) def(defs, id).mechanics.attacks.push({ attackId: `${id}:octolock`, name: '测试蛸固', cost: ['Water'],
      printedDamage: null, effects: [octolock], sourceOfTruth: EVIDENCE });
    def(defs, 'potion').mechanics.effects = [gust()];
    def(defs, 'poison').mechanics.effects = [binding('cn.switch@1', { side: 'own', chooser: 'self', affected: 'selected' }, 'switch')];
  });
  f.deck.splice(20, 2, 'printing:potion', 'printing:poison');
  return f;
};
const cost = (g, owner) => g.view(owner).players[owner].active.effective.attackRequirements.find((r) => r.attackId.endsWith(':strike')).routes[0].counts;
const retreatable = (g, owner) => g.view(owner).legalActions.some((a) => a.type === 'retreat');

test('schemas: 「一直持续到这只「X」离开战斗场」 is a lasting effect\'s own end, begun only by the Active Pokémon', async () => {
  for (const n of octolock.parameters.effects) assert(valid('cn.lasting@1', n.parameters));
  assert(!valid('cn.lasting@1', { ...octolock.parameters.effects[1].parameters, clearOnLeaveActive: false }));
  const f = await fixture((defs) => { def(defs, 'research').mechanics.effects = [binding('cn.lasting@1', octolock.parameters.effects[1].parameters, 'lock')]; });
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'research'); });
  assert.throws(() => play(g, card), (e) => e.code === 'unsupported-leave-active', 'A Trainer has no user in the Active Spot.');
});

test('「使用招式所需能量增加2个【无】能量，且无法撤退…一直持续到这只「八爪武师」离开战斗场，且无法叠加」', async () => {
  const f = await octopus();
  let pull;
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water'); pull = hand(s, 1, 'potion');
    for (const owner of [0, 1]) bench(s, owner, 'other');
    attached(s, 1, s.players[1].active, 'water');
  });
  const user = g.snapshot().players[0].active.id, target = g.snapshot().players[1].active.id;
  command(g, { type: 'attack', attackId: 'base:octolock' }); settle(g);
  assert.equal(g.snapshot().ongoing.length, 2);
  assert.deepEqual([cost(g, 1).Colorless, cost(g, 1).Water, retreatable(g, 1)], [2, 1, false]);
  restore(g, f);
  assert.throws(forged(g, f, (s) => { const p = s.players[0]; [p.active, p.bench[0]] = [p.bench[0], p.active]; }),
    (e) => e.code === 'invalid-ongoing' && /leaves the Active Spot/.test(e.message));
  command(g, { type: 'endTurn' }, 1); settle(g);
  command(g, { type: 'attack', attackId: 'base:octolock' }); settle(g);
  assert.deepEqual([g.snapshot().ongoing.length, cost(g, 1).Colorless], [4, 2], 'A second use does not add up.');
  play(g, pull);
  const s = g.snapshot();
  assert.notEqual(s.players[0].active.id, user);
  assert.deepEqual([s.ongoing.length, cost(g, 1).Colorless, retreatable(g, 1)], [0, 0, true], 'Its user left the Active Spot.');
  assert(s.events.some((e) => e.ruleId === 'effects.duration.user-leaves-active' && e.data.targetId === target && e.data.pokemonId === user));
});

test('「这只「八爪武师」」: the effect ends with the affected Pokémon on the Bench too, and a copy by another Pokémon gives none', async () => {
  const f = await octopus();
  let own;
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); bench(s, 1, 'other'); own = hand(s, 1, 'poison'); });
  command(g, { type: 'attack', attackId: 'base:octolock' }); settle(g);
  assert.equal(g.snapshot().ongoing.length, 2);
  play(g, own);
  assert.equal(g.snapshot().ongoing.length, 0, 'A switching Item moves it to the Bench (II.C-14).');
  const h = board(f, (s) => {
    const p = s.players[0]; p.hand.push(...p.active.stack); p.active = bench(s, 0, 'other'); p.bench.pop();
    attached(s, 0, p.active, 'water');
  });
  command(h, { type: 'attack', attackId: 'other:octolock' }); settle(h);
  assert.equal(h.snapshot().ongoing.length, 0, 'Its user is not that card (JP Q&A オトスパス × メタモン).');
});

// 「这只宝可梦，在离开场上之前都拥有效果为「对手场上所有宝可梦的弱点，变为【超】属性。」的特性。［弱点按「×2」计算。］」 ('base' attack).
const PSYCHIC = { type: 'Psychic', operation: 'multiply', value: 2 };
const grant = (effects) => ({ side: 'own', target: 'self', effect: { op: 'abilityGrant', scope: 'all', effects }, duration: 'untilLeavesPlay',
  clearOnBench: false, clearOnEvolution: false });
const cipher = grant([{ handlerId: 'cn.property@1', parameters: { effect: { op: 'property', field: 'weakness', value: PSYCHIC, scope: 'opponent' } } }]);
// 「…拥有效果为「对手场上的『宝可梦V』（除『化石翼龙VSTAR』外）的特性，全部消除。」的特性」 ('base' plays the excepted name).
const ancient = grant([{ handlerId: 'cn.suppression@1', parameters: { effect: { op: 'suppression', channel: 'abilities', scope: 'opponent',
  targetCard: { kind: 'pokemon', tagsAll: ['V'], excludeNameKeys: ['base'] } } } }]);
const granter = async (transform = () => {}) => {
  const f = await fixture((defs) => {
    def(defs, 'base').mechanics.attacks.push(...[['cipher', cipher], ['ancient', ancient]].map(([key, p]) => ({ attackId: `base:${key}`,
      name: `测试${key}`, cost: ['Water'], printedDamage: null, effects: [binding('cn.lasting@1', p, key)], sourceOfTruth: EVIDENCE })));
    def(defs, 'potion').mechanics.effects = [binding('cn.knockOut@1', { side: 'opponent', target: 'active' }, 'ko')];
    def(defs, 'poison').mechanics.effects = [binding('cn.switch@1', { side: 'own', chooser: 'self', affected: 'selected' }, 'switch')];
    transform(defs);
  });
  f.deck.splice(20, 2, 'printing:potion', 'printing:poison');
  return f;
};
const weakness = (g, owner, id) => mon(g, owner, id).effective.weakness;

test('schemas: a granted Ability holds reviewed continuous entries, lasts until its Pokémon leaves play and is that Pokémon\'s own', () => {
  assert(valid('cn.lasting@1', cipher)); assert(valid('cn.lasting@1', ancient));
  const leaf = (handlerId, parameters) => grant([{ handlerId, parameters }]);
  for (const p of [{ ...cipher, duration: 'untilLeavesActive', clearOnBench: true, clearOnEvolution: true }, { ...cipher, clearOnBench: true },
    { ...cipher, target: 'active' }, { ...cipher, side: 'opponent' }, { ...cipher, clearOnLeaveActive: true }, { ...cipher, ifDamageKnockedOut: true },
    { ...cipher, duration: 'nextOwnTurn' }, leaf('cn.property@1', { effect: { op: 'property', field: 'weakness', value: PSYCHIC } }),
    leaf('cn.draw@1', { count: 1 }), leaf('cn.suppression@1', { effect: { op: 'suppression', channel: 'abilities', scope: 'opponent', extra: 1 } }),
    { side: 'own', target: 'self', effect: { op: 'restriction', scope: 'all', actions: ['attack'] }, duration: 'untilLeavesPlay', clearOnBench: false,
      clearOnEvolution: false }])
    assert(!valid('cn.lasting@1', p), JSON.stringify(p));
  for (const [handlerId, parameters] of [['cn.modifier@1', { field: 'hp', amount: 30, scope: 'self' }],
    ['cn.restriction@1', { effect: { op: 'restriction', scope: 'opponent', actions: ['retreat'], activeOnly: true, sourceActive: true } }],
    ['cn.protection@1', { effect: { op: 'protection', channel: 'damage', useRule: 'ordinary', scope: 'self', from: 'opponent', categories: ['attack'] } }],
    ['cn.energyRequirement@1', { effect: { op: 'energyRequirement', action: 'retreat', mode: 'erase', scope: 'self' } }]])
    assert(valid('cn.lasting@1', leaf(handlerId, parameters)), handlerId);
});

test('「在离开场上之前都拥有效果为「对手场上所有宝可梦的弱点，变为【超】属性。」的特性」: on the Bench and evolved, until it leaves play', async () => {
  const f = await granter();
  let own, evolution, benched;
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water'); benched = bench(s, 1, 'other'); bench(s, 0, 'other');
    own = hand(s, 0, 'poison'); evolution = hand(s, 0, 'evolution');
  });
  const user = g.snapshot().players[0].active.id, active = g.snapshot().players[1].active.id;
  assert.equal(weakness(g, 1, active).type, 'Fire');
  command(g, { type: 'attack', attackId: 'base:cipher' }); settle(g);
  assert.deepEqual([weakness(g, 1, active), weakness(g, 1, benched.id), weakness(g, 0, user).type], [PSYCHIC, PSYCHIC, 'Fire']);
  const granted = g.snapshot().ongoing[0];
  assert.deepEqual([granted.duration, granted.ruleId, mon(g, 0, user).effective.abilities], ['untilLeavesPlay', 'effects.duration.leave-play',
    [{ abilityId: granted.id, present: true, removedBy: [] }]]);
  restore(g, f);
  assert.throws(forged(g, f, (s) => { s.ongoing[0].effect.effects[0].parameters.effect.field = 'resistance'; }), (e) => e.code === 'invalid-ongoing');
  command(g, { type: 'endTurn' }, 1); settle(g);
  command(g, { type: 'evolve', cardId: evolution, pokemonId: user }); settle(g);
  play(g, own);
  assert.notEqual(g.snapshot().players[0].active.id, user);
  assert.deepEqual([g.snapshot().ongoing.length, weakness(g, 1, active)], [1, PSYCHIC],
    'Evolved and moved to the Bench, it still has the Ability (JP Q&A アンノーンVSTAR).');
  restore(g, f);
});

test('the granted Ability ends when its Pokémon leaves play', async () => {
  const f = await granter();
  let ko;
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); bench(s, 0, 'other'); ko = hand(s, 1, 'potion'); });
  const active = g.snapshot().players[1].active.id;
  command(g, { type: 'attack', attackId: 'base:cipher' }); settle(g);
  play(g, ko);
  assert.deepEqual([g.snapshot().ongoing.length, weakness(g, 1, active).type], [0, 'Fire']);
});

test('a granted Ability is removed by 「特性，全部消除」 like a printed one and counts as an Ability; 『宝可梦V』（除「X」外）', async () => {
  // 'other' (the opponent's) removes the opponent's Abilities, except an Ability printed 「测试锁」; a self-Knock-Out removal spares it.
  const make = (extra) => granter((defs) => {
    def(defs, 'other').mechanics.abilities = [ability('other:lock', [removal({ scope: 'opponent', ...extra })])];
    def(defs, 'other').mechanics.tags = ['V'];
  });
  const run = (f, attackId, benchOther) => {
    const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); if (benchOther) bench(s, 1, 'other'); });
    command(g, { type: 'attack', attackId }); settle(g);
    return g;
  };
  const user = (g) => g.snapshot().players[0].active.id, active = (g) => g.snapshot().players[1].active.id;
  let g = run(await make({ exceptAbilityNames: ['测试锁'] }), 'base:cipher', true);
  assert.deepEqual([present(g, 0, user(g)), weakness(g, 1, active(g)).type], [[false], 'Fire'], 'A granted Ability has no printed name.');
  assert(mon(g, 0, user(g)).effective.abilities[0].removedBy.length);
  g = run(await make({ selfKnockOut: true }), 'base:cipher', true);
  assert.deepEqual([present(g, 0, user(g)), weakness(g, 1, active(g))], [[true], PSYCHIC]);
  g = run(await make({ selfKnockOut: true }), 'base:ancient', true);
  const benched = g.snapshot().players[1].bench[0].id;
  assert.deepEqual(present(g, 1, benched), [false], 'An opponent\'s 「宝可梦V」.');
  const f = await granter((defs) => { def(defs, 'base').mechanics.tags = ['V']; def(defs, 'base').mechanics.abilities = [hpBoost('base:boost')]; });
  g = run(f, 'base:ancient', false);
  assert.deepEqual([present(g, 1, active(g)), present(g, 0, user(g))], [[true], [true, true]], '（除「X」外）: the excepted name keeps its Ability.');
  restore(g, f);
});

// 「这张卡牌，可被视作1个【无】能量。只要…被附着于【2阶进化】宝可梦身上，就可被视作1个所有属性的能量。如果在自己场上有3只以上（包含3只）
// 【2阶进化】宝可梦的话，则可被视作4个所有属性的能量」: two entries with complementary pokemonCount conditions (JP Q&A: on a Stage 2 only).
const boostEnergy = () => {
  const stage2s = { kind: 'pokemonCount', side: 'own', zone: 'field', selector: { kind: 'pokemon', stages: ['stage2'] } };
  const entry = (units, relation, key) => binding('cn.energyProvision@1', { effect: { op: 'energyProvision', scope: 'self',
    selector: { kind: 'energy', category: 'special' }, cardSelf: true, units, stages: ['stage2'],
    condition: { kind: 'compare', left: stage2s, relation, right: { kind: 'literal', value: 3 } } } }, key);
  return fixture((defs) => {
    stage2(defs);
    Object.assign(def(defs, 'double').mechanics, { baseUnits: [['Colorless']],
      effects: [entry([ENERGY_TYPES], 'lt', 'one'), entry([ENERGY_TYPES, ENERGY_TYPES, ENERGY_TYPES, ENERGY_TYPES], 'gte', 'four')] });
  });
};

test('「如果在自己场上有3只以上（包含3只）【2阶进化】宝可梦的话，则可被视作4个所有属性的能量」: a Stage 2 holder, counted in play', async () => {
  const f = await boostEnergy();
  f.deck.splice(20, 4, 'printing:evolution', 'printing:evolution', 'printing:evolution', 'printing:double');
  const units = (count, holder = 'evolution') => {
    let m;
    const g = board(f, (s) => {
      m = holder === 'evolution' ? bench(s, 0, 'evolution') : s.players[0].active;
      for (let i = holder === 'evolution' ? 1 : 0; i < count; i++) bench(s, 0, 'evolution');
      bench(s, 1, 'evolution');
      attached(s, 0, m, 'double');
    });
    return mon(g, 0, m.id).effective.energies[0].units.length === 1 ? mon(g, 0, m.id).effective.energies[0].units
      : mon(g, 0, m.id).effective.energies[0].units.length;
  };
  assert.deepEqual(units(1), [ENERGY_TYPES]);
  assert.deepEqual(units(2), [ENERGY_TYPES], 'The opponent\'s Stage 2 Pokémon do not count.');
  assert.equal(units(3), 4);
  assert.deepEqual(units(3, 'base'), [['Colorless']], 'Not on a Basic Pokémon, however many Stage 2 Pokémon there are.');
  // The count reads the Pokémon's kind only: a state or Retreat Cost may itself read Energy.
  for (const extra of [{ state: { damaged: true } }, { retreatCost: 1 }]) {
    const bad = await fixture((defs) => { def(defs, 'double').mechanics.effects = [binding('cn.energyProvision@1', { effect: { op: 'energyProvision',
      scope: 'self', selector: { kind: 'energy', category: 'special' }, cardSelf: true, units: [ENERGY_TYPES], condition: { kind: 'compare',
        left: { kind: 'pokemonCount', side: 'own', zone: 'field', ...extra }, relation: 'gte', right: { kind: 'literal', value: 1 } } } }, 'bad')]; });
    assert.throws(() => board(bad), (e) => e.code === 'unsupported-condition', JSON.stringify(extra));
  }
});
