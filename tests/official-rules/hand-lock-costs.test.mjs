// Synthetic definitions only. 「自己的所有宝可梦，不受对手宝可梦所使用的GX招式的伤害和效果影响」; 「对手选择对手自己场上的宝可梦所拥有的1个
// 招式」 (attack.copy); 「【撤退】所需能量为4个的宝可梦」; 「…【昏厥】时，自己抛掷1次硬币。如果为正面，则对手拿取的奖赏卡将减少1张」
// (ko.prize-modifier-coin); 「这只宝可梦的「X」的伤害变为「100」」 (damage.base-set); 「…所需能量，变为1个【无】能量」
// (energy.requirement.replace); 「对手无法从手牌使出卡牌」 (effects.player-lock); 「这个招式，即使这只宝可梦在备战区也能使用」 (attack.bench);
// 「对手场上、手牌中、弃牌区中的…特性…全部消除」 (effects.remove-content). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const handlers = createCoreHandlers();
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const continuous = (abilityId, effects) => ({ abilityId, name: '测试特性', mode: 'continuous', usage: null, effects, sourceOfTruth: EVIDENCE });
const strike = (s, owner = 0) => attached(s, owner, s.players[owner].active, 'water');
const endTurn = (g) => { command(g, { type: 'endTurn' }); settle(g); };
const view = (g, owner, id) => { const p = g.view(owner).players[owner]; return [p.active, ...p.bench].find((m) => m.id === id); };
const gxAttack = { attackId: 'base:gx', name: '测试GX', cost: ['Water'], specialRule: 'GX', printedDamage: { value: 50, operator: 'fixed' },
  effects: [], sourceOfTruth: EVIDENCE };

test('「不受对手宝可梦所使用的GX招式的伤害和效果影响」: only an attack used as a GX attack', async () => {
  const shield = (channel) => ({ op: 'protection', channel, useRule: 'ordinary', scope: 'own', from: 'opponent', categories: ['attack'],
    sourceActive: true, specialRules: ['GX'] });
  const valid = handlers.get('cn.protection@1').validateParameters;
  assert(valid({ effect: shield('damage') })); assert(!valid({ effect: { ...shield('effects'), categories: ['attack', 'ability'] } }));
  const f = await fixture((defs) => {
    def(defs, 'base').mechanics.attacks.push(clone(gxAttack));
    def(defs, 'other').mechanics.abilities = [continuous('other:guard', [binding('cn.protection@1', { effect: shield('damage') }, 'guard')])];
  });
  for (const [attackId, counters] of [['base:gx', 0], ['base:strike', 2]]) {
    const g = board(f, (s) => { strike(s); const o = bench(s, 1, 'other'), p = s.players[1]; p.bench = [p.active]; p.active = o; });
    command(g, { type: 'attack', attackId }); settle(g);
    assert.equal(g.snapshot().players[1].active.counters, counters, attackId);
  }
});

test('「对手选择对手自己场上的宝可梦所拥有的1个招式。将被选择的招式作为这个招式使用」: the opponent chooses', async () => {
  const copy = { op: 'copyAttack', origins: [{ side: 'opponent', zone: 'field', selector: { kind: 'pokemon' } }], excludeUser: false,
    coin: 'none', energy: 'ignore', special: { mode: 'needsRuling', sourceOfTruth: EVIDENCE }, chooser: 'opponent' };
  const valid = handlers.get('cn.copyAttack@1').validateParameters;
  assert(valid(copy)); assert(!valid({ ...copy, origins: [{ side: 'own', zone: 'field', selector: { kind: 'pokemon' } }] }));
  const f = await fixture((defs) => {
    const a = def(defs, 'base').mechanics.attacks[0]; a.printedDamage = null; a.effects = [binding('cn.copyAttack@1', copy, 'mime')];
    def(defs, 'other').mechanics.attacks[0].printedDamage = { value: 40, operator: 'fixed' };
  });
  const g = board(f, (s) => { strike(s); bench(s, 1, 'other'); });
  command(g, { type: 'attack', attackId: 'base:strike' });
  const q = g.snapshot().pending;
  assert.equal(q.kind, 'copy-attack'); assert.equal(q.player, 1);
  const option = g.view(1).pending.attacks.find((x) => x.attackId === 'other:strike');
  restore(g, f); answer(g, [option.optionId]); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 4);
});

test('「【撤退】所需能量为4个的宝可梦」: counted and modified by the current Retreat Cost', async () => {
  const count = { kind: 'pokemonCount', side: 'own', zone: 'field', retreatCost: 2 };
  assert(handlers.get('cn.drawValue@1').validateParameters({ count }));
  assert(!handlers.get('cn.drawValue@1').validateParameters({ count: { ...count, retreatCost: 11 } }));
  const knee = { field: 'hp', amount: 50, scope: 'self', targetRetreatCost: 2 };
  const valid = handlers.get('cn.modifier@1').validateParameters;
  assert(valid(knee)); assert(!valid({ ...knee, field: 'retreat', amount: -1 }));
  const f = await fixture((defs) => {
    def(defs, 'other').mechanics.retreatCost = 2;
    def(defs, 'potion').mechanics.effects = [binding('cn.drawValue@1', { count }, 'count')];
    def(defs, 'hp-tool').mechanics.effects = [binding('cn.modifier@1', knee, 'knee')];
    def(defs, 'tool').mechanics.effects = [binding('cn.modifier@1', { field: 'retreat', amount: 1, scope: 'self' }, 'heavy')];
  });
  let card, a, b, c;
  const g = board(f, (s) => {
    card = hand(s, 0, 'potion'); a = bench(s, 0, 'other'); b = bench(s, 0, 'other'); c = s.players[0].active;
    for (const [m, id] of [[a, 'hp-tool'], [c, 'tool']]) { const t = hand(s, 0, id); s.players[0].hand.pop(); m.tools.push(t); }
  });
  assert.equal(view(g, 0, a.id).effective.maxHp, 150);
  const before = g.snapshot().players[0].hand.length;
  command(g, { type: 'playTrainer', cardId: card }); settle(g);
  assert.equal(g.snapshot().players[0].hand.length, before - 1 + 3, 'Two printed 2 and one raised to 2 by its Tool.');
  // A Retreat Cost change read through Retreat Costs has no defined answer.
  const loop = await fixture((defs) => {
    def(defs, 'stadium').mechanics.effects = [binding('cn.modifier@1', { field: 'retreat', amount: -1, scope: 'all',
      condition: { kind: 'compare', left: { kind: 'pokemonCount', side: 'own', zone: 'field', retreatCost: 1 }, relation: 'gte',
        right: { kind: 'literal', value: 1 } } }, 'loop')];
  });
  assert.throws(() => board(loop, (s) => { s.stadium = hand(s, 1, 'stadium'); s.players[1].hand.pop(); }).view(0), /Retreat Cost/);
});

test('「…【昏厥】时，自己抛掷1次硬币。如果为正面，则…减少1张」「…多拿取1张」 and 「不会叠加」', async () => {
  const valid = handlers.get('cn.prizeModifier@1').validateParameters;
  const less = { op: 'prizeModifier', scope: 'self', amount: -1, activeOnly: true, coin: true };
  const more = { op: 'prizeModifier', scope: 'opponent', amount: 1, activeOnly: true, coin: true, group: 'togekiss' };
  assert(valid({ effect: less })); assert(valid({ effect: more })); assert(valid({ effect: { op: 'prizeModifier', scope: 'self', none: true, coin: true } }));
  const ko = async (who, effect) => fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.weakness = null;
    def(defs, 'base').mechanics.attacks[0].printedDamage = { value: 100, operator: 'fixed' };
    def(defs, who).mechanics.abilities = [continuous(`${who}:prize`, [binding('cn.prizeModifier@1', { effect }, 'prize')])];
  });
  const self = await ko('other', less), bonus = await ko('other', more);
  const results = new Set();
  for (const seed of [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16]]) {
    const g = board({ ...self, seed }, (s) => { strike(s); const o = bench(s, 1, 'other'), p = s.players[1]; p.bench = [p.active]; p.active = o; });
    command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
    const s = g.snapshot(), flips = s.events.filter((e) => e.ruleId === 'effects.coin');
    assert.equal(flips.length, 1); assert.equal(flips[0].data.player, 1);
    results.add(flips[0].data.result);
    assert.equal(6 - s.players[0].prizes.length, flips[0].data.result === 'heads' ? 0 : 1);
    const h = board({ ...bonus, seed }, (s) => { strike(s); bench(s, 1, 'evolution'); bench(s, 0, 'other'); bench(s, 0, 'other'); });
    command(h, { type: 'attack', attackId: 'base:strike' }); settle(h);
    const t = h.snapshot(), coins = t.events.filter((e) => e.ruleId === 'effects.coin');
    assert.equal(coins.length, 1, 'Two of them: one coin.'); assert.equal(coins[0].data.player, 0);
    assert.equal(6 - t.players[0].prizes.length, coins[0].data.result === 'heads' ? 2 : 1);
  }
  assert.equal(results.size, 2);
});

test('「在下一个自己的回合，这只宝可梦的「X」的伤害变为「60」」 and 「…所需能量，变为1个【无】能量」', async () => {
  const set = { op: 'property', field: 'attackBaseDamage', value: { attackIds: ['base:strike'], damage: 60 }, scope: 'all' };
  const lasting = { side: 'own', target: 'self', effect: set, duration: 'nextOwnTurn', clearOnBench: true, clearOnEvolution: true };
  assert(handlers.get('cn.lasting@1').validateParameters(lasting));
  assert(!handlers.get('cn.lasting@1').validateParameters({ ...lasting, effect: { ...set, value: { attackIds: ['base:strike'], damage: 65 } } }));
  const replace = { op: 'energyRequirement', action: 'attack', mode: 'replace', scope: 'self', cost: ['Colorless'], attackIds: ['base:big'] };
  const valid = handlers.get('cn.energyRequirement@1').validateParameters;
  assert(valid({ effect: replace })); assert(!valid({ effect: { ...replace, attackIds: undefined } }));
  assert(!valid({ effect: { op: 'energyRequirement', action: 'attack', mode: 'erase', scope: 'self', cost: [] } }));
  const f = await fixture((defs) => {
    const m = def(defs, 'base').mechanics;
    m.attacks[0].effects = [binding('cn.lasting@1', lasting, 'focus')];
    m.attacks.push({ attackId: 'base:big', name: '测试大招', cost: ['Water', 'Water', 'Water'], printedDamage: { value: 90, operator: 'fixed' },
      effects: [], sourceOfTruth: EVIDENCE });
    def(defs, 'evolution').mechanics.abilities = [continuous('evolution:frost', [binding('cn.energyRequirement@1', { effect: replace }, 'frost')])];
  });
  const g = board(f, (s) => strike(s));
  const hit = () => { command(g, { type: 'attack', attackId: 'base:strike' }); settle(g); return g.snapshot().players[1].active.counters; };
  assert.equal(hit(), 2);
  endTurn(g); g.snapshot();
  const s1 = g.snapshot(); assert.equal(s1.current, 0);
  assert.equal(hit() - 2, 6, '60 on the next own turn.');
  assert(g.snapshot().events.some((e) => e.ruleId === 'damage.base-set'));
  restore(g, f);
  const big = (evolved) => board(f, (s) => { strike(s); if (evolved) { const e = hand(s, 0, 'evolution'); s.players[0].hand.pop(); s.players[0].active.stack.push(e); } });
  const usable = (g) => g.view(0).legalActions.some((a) => a.type === 'attack' && a.attackId === 'base:big');
  assert(!usable(big(false)));
  const twice = await fixture((defs) => {
    def(defs, 'evolution').mechanics.attacks.push({ attackId: 'base:big', name: '测试大招', cost: ['Water', 'Water', 'Water'],
      printedDamage: { value: 90, operator: 'fixed' }, effects: [], sourceOfTruth: EVIDENCE });
    def(defs, 'evolution').mechanics.abilities = [continuous('evolution:frost', [binding('cn.energyRequirement@1', { effect: replace }, 'frost')])];
  });
  const e = board(twice, (s) => { strike(s); const c = hand(s, 0, 'evolution'); s.players[0].hand.pop(); s.players[0].active.stack.push(c); });
  assert(usable(e), 'One Water pays the replaced cost.');
});

test('「在下一个对手的回合，对手无法从手牌使出卡牌」: nothing from the hand into play, attacks and Retreat still allowed', async () => {
  const lock = { side: 'opponent', duration: 'nextOpponentTurn', effect: { op: 'playerRestriction', scope: 'all', actions: ['playFromHand'] } };
  assert(handlers.get('cn.lastingPlayer@1').validateParameters(lock));
  const f = await fixture((defs) => {
    def(defs, 'potion').mechanics.effects = [binding('cn.lastingPlayer@1', lock, 'horror')];
    def(defs, 'base').mechanics.attacks[0].effects = [
      binding('cn.attachHand@1', { type: 'Water', count: 1, benchOnly: false, optional: false }, 'wave'),
      binding('cn.cards@1', { from: 'hand', to: 'bench', selector: { kind: 'pokemon', stages: ['basic'] }, quantity: { kind: 'upTo', count: 1 },
        reveal: false, lookTop: null, shuffleAfter: false }, 'call')];
  });
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'potion'); for (const id of ['base', 'water', 'research', 'evolution']) hand(s, 1, id); strike(s, 1); bench(s, 1, 'other'); });
  command(g, { type: 'playTrainer', cardId: card }); settle(g);
  endTurn(g);
  const types = new Set(g.view(1).legalActions.map((a) => a.type));
  assert.deepEqual([...types].sort(), ['attack', 'endTurn', 'retreat']);
  const before = g.snapshot().players[1];
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g, (q) => q.options.slice(0, q.maximum));
  const after = g.snapshot().players[1];
  assert.deepEqual([after.bench.length, after.active.energy.length], [before.bench.length, before.active.energy.length], 'Neither effect brings a hand card into play.');
  assert(g.snapshot().events.some((e) => e.ruleId === 'effects.player-lock' && e.data.skipped === 'hand'));
  restore(g, f);
  endTurn(g);
  assert(g.view(1).legalActions.some((a) => a.type === 'bench'), 'Only the next turn.');
});

test('「这个招式，即使这只宝可梦在备战区也能使用」: the Benched Pokémon attacks, under the other attack rules', async () => {
  const f = await fixture((defs) => {
    const m = def(defs, 'other').mechanics;
    m.types = ['Fire']; Object.assign(m.attacks[0], { cost: ['Fire'], benchUse: true });
  });
  f.deck.splice(20, 1, 'printing:fire');
  let other;
  const g = board(f, (s) => { other = bench(s, 0, 'other'); attached(s, 0, other, 'fire'); s.players[0].active.conditions.rotation = 'asleep'; });
  const legal = g.view(0).legalActions.filter((a) => a.type === 'attack');
  assert.deepEqual(legal, [{ type: 'attack', attackId: 'other:strike', pokemonId: other.id }], 'The Asleep Active Pokémon does not stop it.');
  command(g, { type: 'attack', attackId: 'other:strike', pokemonId: other.id }); settle(g);
  const s = g.snapshot();
  assert.equal(s.players[1].active.counters, 4, 'Weakness as usual.');
  assert.equal(s.current, 1, 'The turn ended.');
  restore(g, f);
  // The Pokémon's own attack rules: without its Energy, or another Benched Pokémon, nothing.
  const dry = board(f, (s) => { other = bench(s, 0, 'other'); attached(s, 0, s.players[0].active, 'water'); });
  assert(!dry.view(0).legalActions.some((a) => a.type === 'attack' && a.pokemonId));
  assert.throws(() => command(dry, { type: 'attack', attackId: 'other:strike', pokemonId: other.id }), /not legal/);
});

test('「对手场上、手牌中、弃牌区中的所有「宝可梦GX」的特性（除「冻结之瞳」外），全部消除」: also a discard card\'s Ability', async () => {
  const gaze = { op: 'suppression', channel: 'abilities', scope: 'opponent', sourceActive: true, tag: 'GX', outOfPlay: true, exceptAbilityNames: ['冻结之瞳'] };
  const valid = handlers.get('cn.suppression@1').validateParameters;
  assert(valid({ effect: gaze })); assert(!valid({ effect: { ...gaze, channel: 'tools', exceptAbilityNames: undefined } }));
  const rise = { abilityId: 'other:rise', name: '测试复苏', mode: 'activated', zone: 'discard', usage: { period: 'turn', scope: 'pokemon', key: 'rise', limit: 1 },
    effects: [binding('cn.deploySelf@1', {}, 'rise')], sourceOfTruth: EVIDENCE };
  const f = await fixture((defs) => {
    Object.assign(def(defs, 'other').mechanics, { tags: ['GX'], abilities: [rise] });
    def(defs, 'evolution').mechanics.abilities = [continuous('evolution:gaze', [binding('cn.suppression@1', { effect: gaze }, 'gaze')])];
  });
  const usable = (active) => {
    let card;
    const g = board(f, (s) => {
      card = hand(s, 0, 'other'); s.players[0].hand.pop(); s.players[0].discard.push(card);
      if (active) { const e = hand(s, 1, 'evolution'); s.players[1].hand.pop(); s.players[1].active.stack.push(e); }
    });
    return g.view(0).legalActions.some((a) => a.type === 'useAbility' && a.cardId === card);
  };
  assert(usable(false)); assert(!usable(true));
  const named = await fixture((defs) => {
    Object.assign(def(defs, 'other').mechanics, { tags: ['GX'], abilities: [{ ...rise, name: '冻结之瞳' }] });
    def(defs, 'evolution').mechanics.abilities = [continuous('evolution:gaze', [binding('cn.suppression@1', { effect: gaze }, 'gaze')])];
  });
  let card;
  const g = board(named, (s) => { card = hand(s, 0, 'other'); s.players[0].hand.pop(); s.players[0].discard.push(card);
    const e = hand(s, 1, 'evolution'); s.players[1].hand.pop(); s.players[1].active.stack.push(e); });
  assert(g.view(0).legalActions.some((a) => a.type === 'useAbility' && a.cardId === card), 'Its own name is excepted.');
});

test('「如果因为这个招式对手的宝可梦【昏厥】的话，则当这个回合结束时，自己的回合会再开始1次」 and 「双方玩家各…抽取卡牌，直到手牌变为7张为止」', async () => {
  const valid = handlers.get('cn.extraTurn@1').validateParameters;
  assert(valid({})); assert(valid({ ifKnockedOut: true })); assert(!valid({ ifKnockedOut: false }));
  const f = await fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.weakness = null;
    const a = def(defs, 'base').mechanics.attacks[0]; a.printedDamage = null;
    a.effects = [binding('cn.counters@1', { side: 'opponent', target: 'any', count: 2 }, 'put'), binding('cn.extraTurn@1', { ifKnockedOut: true }, 'again')];
  });
  for (const [counters, again] of [[8, true], [0, false]]) {
    const g = board(f, (s) => { strike(s); bench(s, 1, 'other'); s.players[1].active.counters = counters; });
    command(g, { type: 'attack', attackId: 'base:strike' }); settle(g, (q) => q.kind === 'effect-target' ? [g.snapshot().players[1].active.id] : q.options.slice(0, Math.max(1, q.minimum)));
    assert.equal(g.snapshot().current, again ? 0 : 1, `counters ${counters}`);
    restore(g, f);
  }
  await assert.rejects(fixture((defs) => { def(defs, 'research').mechanics.effects = [binding('cn.extraTurn@1', { ifKnockedOut: true })]; })
    .then((x) => board(x)), /因为这个招式/);
  const both = { own: 7, opponent: 7, until: true };
  assert(handlers.get('cn.drawPlayers@1').validateParameters(both));
  const h = await fixture((defs) => { def(defs, 'research').mechanics.effects = [binding('cn.drawPlayers@1', both, 'both')]; });
  let card;
  const g = board(h, (s) => { card = hand(s, 0, 'research'); s.players[1].deck.push(...s.players[1].hand.splice(2)); });
  command(g, { type: 'playTrainer', cardId: card }); settle(g);
  assert.deepEqual(g.snapshot().players.map((p) => p.hand.length), [7, 7]);
  const full = board(h, (s) => { card = hand(s, 0, 'research'); s.players[0].deck.push(...s.players[0].hand.splice(7)); });
  assert(full.snapshot().players[1].hand.length >= 7 && full.snapshot().players[0].hand.length === 7);
  assert(!full.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === card), 'Nobody would draw.');
});

test('「如果追加附有1个【超】能量的话，则双方玩家各从牌库上方抽取卡牌，直到手牌变为7张为止」: both players\' draws inside a condition', async () => {
  const both = { handlerId: 'cn.drawPlayers@1', parameters: { own: 7, opponent: 7, until: true } };
  const when = { condition: { kind: 'compare', left: { kind: 'extraEnergy', energyType: 'Fire' }, relation: 'gte', right: { kind: 'literal', value: 1 } },
    effect: both };
  assert(handlers.get('cn.when@1').validateParameters(when));
  assert(!handlers.get('cn.then@1').validateParameters({ first: both, next: both }), 'Not a part of a then.');
  const f = await fixture((defs) => {
    const a = def(defs, 'base').mechanics.attacks[0]; a.printedDamage = null; a.effects = [binding('cn.when@1', when, 'gx')];
  });
  f.deck.splice(20, 1, 'printing:fire');
  for (const [extra, hands] of [[true, [7, 8]], [false, null]]) {
    const g = board(f, (s) => {
      strike(s); if (extra) attached(s, 0, s.players[0].active, 'fire');
      for (const p of s.players) p.deck.push(...p.hand.splice(2));
    });
    const before = g.snapshot().players.map((p) => p.hand.length);
    command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
    const after = g.snapshot().players.map((p) => p.hand.length);
    assert.deepEqual(after, hands ?? [before[0], before[1] + 1], extra ? 'with the extra Energy (then the opponent\'s turn draw)' : 'without: only the turn draw');
    restore(g, f);
  }
});
