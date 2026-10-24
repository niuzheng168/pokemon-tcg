// Synthetic definitions only. Trigger events and conditions:
// 「在自己的回合，当将这张卡牌从手牌使出并进行进化时，以及这只宝可梦在战斗场上受到对手的招式的伤害而【昏厥】时，各可使用1次。在不看对手手牌
// 正面的前提下，选择其中1张放于弃牌区。」 and 「在自己的回合，每当从自己的手牌中将拥有「蘑菇孢子」招式的宝可梦放于场上时，可以使用1次。使对手的战斗
// 宝可梦陷入【中毒】和【睡眠】状态。」 (trigger.alternatives); 「在自己的回合，每当从自己的手牌中将名字中带有「妖精坠饰」的「宝可梦道具」，放于这只
// 宝可梦身上时，可使用1次。使对手的战斗宝可梦陷入【混乱】状态。」 (trigger.tool); 「如果自己场上有「正电拍拍」的话，则能生效。只要这只宝可梦在场上，
// 每当对手从手牌将能量附着于宝可梦身上时，给那只宝可梦身上放置2个伤害指示物。这个效果，无论拥有这个特性的宝可梦有多少只，都不会叠加。」 and 「只要
// 这只宝可梦在场上，每当对手从手牌使出宝可梦并进行进化时，就给那只宝可梦身上放置4个伤害指示物。无论拥有这个特性的宝可梦有多少只，这个效果都不会
// 重复。」 (trigger.condition, trigger.group); 「在下一个对手的回合，如果对手从手牌将能量附着于受到这个招式影响的宝可梦身上的话，对手的回合结束。」
// (effects.end-turn-reaction). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { causeMatches } from '../../public/rules/triggers.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, attached, bench, fixtureClock } from './fixtures.mjs';

const handlers = createCoreHandlers();
const clone = (value) => JSON.parse(JSON.stringify(value));
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
// Every pending choice survives a JSON round trip and resumes identically.
function settleRestoring(g, f, policy = (q) => q.options.slice(0, q.minimum)) {
  while (g.snapshot().pending) {
    const q = g.snapshot().pending, r = restore(g, f), selected = policy(q);
    answer(g, selected); answer(r, selected);
    assert.deepEqual(r.snapshot(), g.snapshot());
  }
}
const perform = (q) => q.kind === 'trigger-optional' ? ['perform'] : q.options.slice(0, q.minimum);
// 「附着」 choices from the hand may stop at zero; these tests attach what they can.
const attachAll = (q) => q.options.slice(0, q.kind === 'hand-energy' ? q.maximum : q.minimum);
const performed = (g, ruleId) => g.snapshot().events.filter((e) => e.ruleId === ruleId && e.data.performed);
const triggered = (abilityId, trigger, effects, extra = {}) => ({ abilityId, name: `测试${abilityId}`, mode: 'triggered', usage: null,
  trigger, effects, sourceOfTruth: EVIDENCE, ...extra });
const global = (event, extra = {}) => ({ event, subject: 'self', optional: true, choiceOwner: 'source', scope: 'global', ...extra });

// 「当将这张卡牌从手牌使出并进行进化时，以及这只宝可梦在战斗场上受到对手的招式的伤害而【昏厥】时，各可使用1次」.
const BULLY = [global('evolve', { origin: 'hand', turn: 'own' }),
  global('knockout', { cause: 'opponentAttackDamage', activeOnly: true })];
const snatch = binding('cn.opponentHand@1', { mode: 'faceDown', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 1 }, to: 'discard' }, 'snatch');
const bully = () => fixture((defs) => { def(defs, 'evolution').mechanics.abilities = [triggered('evolution:bully', clone(BULLY), [snatch])]; });

test('trigger.alternatives schema: two to four global descriptors, on an Ability only', async () => {
  const f = await bully();
  const reject = (mutate) => assert.rejects(fixture((defs) => {
    def(defs, 'evolution').mechanics.abilities = [triggered('evolution:bully', clone(BULLY), [snatch])];
    mutate(defs);
  }), /Invalid normalized card definition/);
  assert.deepEqual(f.catalog.definition('evolution').mechanics.abilities[0].trigger, BULLY);
  await reject((defs) => { def(defs, 'evolution').mechanics.abilities[0].trigger = [BULLY[0]]; });
  await reject((defs) => { def(defs, 'evolution').mechanics.abilities[0].trigger[1].scope = 'subject'; });
  await reject((defs) => { def(defs, 'evolution').mechanics.abilities[0].trigger.push({ event: 'beforeHand', origin: 'draw', turn: 'own',
    drawReason: 'any', optional: true, afterUse: 'hand' }); });
  await reject((defs) => { def(defs, 'tool').mechanics.effects = [{ ...snatch, trigger: clone(BULLY) }]; });
});

test('「从手牌使出并进行进化时，以及…受到对手的招式的伤害而【昏厥】时，各可使用1次」: either event, each once', async () => {
  const f = await bully();
  // Evolving from the hand on one's own turn.
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'evolution'); hand(s, 1, 'potion'); hand(s, 1, 'potion'); });
  const before = g.snapshot().players[1].hand.length;
  command(g, { type: 'evolve', cardId: card, pokemonId: g.snapshot().players[0].active.id });
  assert.equal(g.snapshot().pending.kind, 'trigger-optional');
  assert.deepEqual(g.snapshot().pending.data.unit.trigger, BULLY[0]);
  settleRestoring(g, f, perform);
  assert.equal(g.snapshot().players[1].hand.length, before - 1);
  assert.equal(performed(g, 'trigger.evolve').length, 1);
  // Knocked Out in the Active Spot by the opponent's attack, on the opponent's turn (JP Q&A ムーランド): the same Ability again.
  const h = board(f, (s) => {
    fixtureClock(s, [0, 1, 0, 1]);
    const p = s.players[0]; p.hand.push(...p.active.stack); p.active = bench(s, 0, 'evolution'); p.bench.pop(); p.active.counters = 14;
    bench(s, 0, 'other'); attached(s, 1, s.players[1].active, 'water'); hand(s, 1, 'potion');
  });
  const foeDiscard = h.snapshot().players[1].discard.length;
  command(h, { type: 'attack', attackId: 'base:strike' });
  assert.equal(h.snapshot().pending.kind, 'trigger-optional');
  assert.deepEqual(h.snapshot().pending.data.unit.trigger, BULLY[1]);
  // A pending unit keeps one of its Ability's own alternatives; any other descriptor is refused.
  const forged = clone(h.snapshot());
  forged.pending.data.unit.trigger = { ...BULLY[1], activeOnly: false };
  assert.throws(() => OfficialGame.restore(forged, { catalog: f.catalog }), (e) => e.code === 'invalid-trigger-binding');
  settleRestoring(h, f, perform);
  assert.equal(h.snapshot().players[1].discard.length, foeDiscard + 1, 'One card of the attacking player\'s hand.');
  assert.equal(performed(h, 'trigger.knockout').length, 1);
  // Neither: evolving on the Bench by an effect from the deck, or a Knock Out by the checkup.
  const k = board(f, (s) => {
    const p = s.players[0]; p.hand.push(...p.active.stack); p.active = bench(s, 0, 'evolution'); p.bench.pop();
    p.active.counters = 14; p.active.conditions.poison = 1; bench(s, 0, 'other');
  });
  command(k, { type: 'endTurn' }); settleRestoring(k, f, perform);
  assert.equal(performed(k, 'trigger.knockout').length, 0);
});

// 「每当从自己的手牌中将拥有「蘑菇孢子」招式的宝可梦放于场上时，可以使用1次」: Bench or evolution, by the card's printed attack.
const SPORE = { kind: 'pokemon', attackNames: ['测试孢子'] };
const spores = () => fixture((defs) => {
  for (const id of ['base', 'evolution']) def(defs, id).mechanics.attacks[0].name = '测试孢子';
  def(defs, 'other').mechanics.abilities = [triggered('other:spore', [
    global('bench', { subject: 'own', origin: 'hand', turn: 'own', cardSelector: SPORE }),
    global('evolve', { subject: 'own', origin: 'hand', turn: 'own', cardSelector: SPORE }),
  ], [binding('cn.condition@1', { side: 'opponent', condition: 'poisoned' }, 'poison'), binding('cn.condition@1', { side: 'opponent', condition: 'asleep' }, 'sleep')])];
});

test('「从自己的手牌中将…宝可梦放于场上时」: put onto the Bench or evolving from the hand, a matching card only', async () => {
  const f = await spores();
  for (const [play, cardId, fires] of [['bench', 'base', true], ['evolve', 'evolution', true], ['bench', 'other', false]]) {
    let card;
    const g = board(f, (s) => { bench(s, 0, 'other'); card = hand(s, 0, cardId); });
    command(g, play === 'bench' ? { type: 'bench', cardId: card } : { type: 'evolve', cardId: card, pokemonId: g.snapshot().players[0].active.id });
    settleRestoring(g, f, perform);
    const foe = g.snapshot().players[1].active.conditions;
    assert.deepEqual([foe.poison, foe.rotation], fires ? [1, 'asleep'] : [null, null], `${play} ${cardId}`);
  }
});

// 「每当从自己的手牌中将名字中带有「妖精坠饰」的「宝可梦道具」，放于这只宝可梦身上时，可使用1次」.
const CHARM = global('toolAttached', { origin: 'hand', turn: 'own', cardSelector: { kind: 'trainer', categories: ['tool'], nameContains: '增伤' } });
const charm = () => fixture((defs) => {
  def(defs, 'base').mechanics.abilities = [triggered('base:charm', CHARM, [binding('cn.condition@1', { side: 'opponent', condition: 'confused' }, 'confuse')])];
});

test('trigger.tool: a Tool played from the hand onto this Pokémon, by its printed name', async () => {
  assert(handlers.get('cn.delayedReaction@1').validateParameters({ side: 'own', target: 'self', trigger: { ...CHARM, subject: 'self' },
    program: [{ op: 'draw', count: 1 }], duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true }));
  assert(!handlers.get('cn.delayedReaction@1').validateParameters({ side: 'own', target: 'self', trigger: { ...CHARM, event: 'knockout' },
    program: [{ op: 'draw', count: 1 }], duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true }), 'cardSelector needs a card event.');
  const f = await charm();
  for (const [tool, onActive, confused] of [['tool', true, true], ['hp-tool', true, false], ['tool', false, false]]) {
    let card, benched;
    const g = board(f, (s) => { card = hand(s, 0, tool); benched = bench(s, 0, 'other'); });
    command(g, { type: 'playTrainer', cardId: card });
    const target = onActive ? g.snapshot().players[0].active.id : benched.id;
    answer(g, [target]);
    if (confused) assert.equal(g.snapshot().pending.kind, 'trigger-optional');
    settleRestoring(g, f, perform);
    assert.equal(g.snapshot().players[1].active.conditions.rotation, confused ? 'confused' : null, `${tool} ${onActive}`);
    assert.equal(performed(g, 'trigger.tool').length, Number(confused));
  }
});

// 「如果自己场上有「正电拍拍」的话，则能生效。…每当对手从手牌将能量附着于宝可梦身上时，给那只宝可梦身上放置2个伤害指示物。…都不会叠加」.
const PARTNER = { kind: 'compare', left: { kind: 'pokemonCount', side: 'own', zone: 'field', selector: { kind: 'pokemon', nameKeys: ['evolution'] } },
  relation: 'gt', right: { kind: 'literal', value: 0 } };
const pulse = (extra = {}) => ({ event: 'energyAttached', subject: 'opponent', origin: 'hand', optional: false, choiceOwner: 'source', scope: 'subject',
  condition: PARTNER, group: '测试负电', ...extra });
const minun = (extra) => fixture((defs) => {
  def(defs, 'other').mechanics.abilities = [triggered('other:pulse', pulse(extra), [binding('cn.counters@1', { side: 'opponent', target: 'event', count: 2 }, 'pulse')])];
});

test('trigger.condition / trigger.group schema: not on a delayed reaction', () => {
  const valid = handlers.get('cn.delayedReaction@1').validateParameters;
  const reaction = (trigger) => ({ side: 'opponent', target: 'active', duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true,
    trigger: { event: 'energyAttached', subject: 'self', optional: false, choiceOwner: 'affected', scope: 'global', ...trigger },
    program: [{ op: 'endTurn', side: 'opponent' }] });
  assert(valid(reaction({})));
  assert(!valid(reaction({ group: 'x' }))); assert(!valid(reaction({ condition: PARTNER })));
  assert(!valid({ ...reaction({}), program: [{ op: 'endTurn' }] }));
});

test('「如果自己场上有「X」的话，则能生效…不会叠加」: one placement however many, none without the partner', async () => {
  const f = await minun();
  for (const [partner, count] of [[true, 2], [false, 0]]) {
    let energy;
    const g = board(f, (s) => {
      bench(s, 1, 'other'); bench(s, 1, 'other'); if (partner) bench(s, 1, 'evolution');
      energy = hand(s, 0, 'water');
    });
    command(g, { type: 'attachEnergy', cardId: energy, pokemonId: g.snapshot().players[0].active.id });
    settleRestoring(g, f);
    assert.equal(g.snapshot().players[0].active.counters, count, partner ? 'Two such Pokémon, one effect.' : 'No partner.');
    assert.equal(performed(g, 'trigger.energy').length, count / 2);
  }
  // Each event starts one: two Energy cards attached by one effect from the hand, two placements.
  const two = await fixture((defs) => {
    def(defs, 'other').mechanics.abilities = [triggered('other:pulse', pulse(), [binding('cn.counters@1', { side: 'opponent', target: 'event', count: 2 }, 'pulse')])];
    def(defs, 'potion').mechanics.effects = [binding('cn.attachHand@1', { type: 'Water', count: 2, benchOnly: false, optional: false, target: 'active', exact: true }, 'attach')];
  });
  let item;
  const g = board(two, (s) => { bench(s, 1, 'other'); bench(s, 1, 'other'); bench(s, 1, 'evolution'); hand(s, 0, 'water'); hand(s, 0, 'water'); item = hand(s, 0, 'potion'); });
  command(g, { type: 'playTrainer', cardId: item });
  settleRestoring(g, two, attachAll);
  assert.equal(g.snapshot().players[0].active.counters, 4);
});

test('trigger.condition is judged again when the effect would start', async () => {
  // The attaching player's own effect of the same event, ordered first, removes the condition (the opponent's hand empties).
  const f = await fixture((defs) => {
    def(defs, 'other').mechanics.abilities = [triggered('other:pulse', pulse({ condition: { kind: 'compare',
      left: { kind: 'zoneCount', side: 'opponent', zone: 'hand' }, relation: 'gt', right: { kind: 'literal', value: 0 } } }),
    [binding('cn.counters@1', { side: 'opponent', target: 'event', count: 2 }, 'pulse')])];
    def(defs, 'base').mechanics.abilities = [triggered('base:dump', global('energyAttached', { origin: 'hand', optional: false }),
      [binding('cn.discardHand@1', {}, 'dump')])];
  });
  for (const first of ['base:dump', 'other:pulse']) {
    let energy;
    const g = board(f, (s) => { bench(s, 1, 'other'); energy = hand(s, 0, 'water'); hand(s, 0, 'potion'); });
    command(g, { type: 'attachEnergy', cardId: energy, pokemonId: g.snapshot().players[0].active.id });
    const q = g.snapshot().pending;
    assert.equal(q.kind, 'trigger-order'); assert.equal(q.player, 0, 'The attaching player orders both.');
    settleRestoring(g, f, (q) => q.kind === 'trigger-order' ? [q.options.find((id) => q.data.units.find((u) => u.id === id).abilityId === first)] :
      q.options.slice(0, q.minimum));
    assert.equal(g.snapshot().players[0].active.counters, first === 'base:dump' ? 0 : 2, first);
  }
});

// 「只要这只宝可梦在场上，每当对手从手牌使出宝可梦并进行进化时，就给那只宝可梦身上放置4个伤害指示物。…不会重复」.
test('「每当对手从手牌使出宝可梦并进行进化时…不会重复」: once however many, on the evolved Pokémon', async () => {
  const f = await fixture((defs) => {
    def(defs, 'other').mechanics.abilities = [triggered('other:impulse', { event: 'evolve', subject: 'opponent', origin: 'hand', optional: false,
      choiceOwner: 'source', scope: 'subject', group: '测试电龙' }, [binding('cn.counters@1', { side: 'opponent', target: 'event', count: 4 }, 'impulse')])];
  });
  let card;
  const g = board(f, (s) => { bench(s, 1, 'other'); bench(s, 1, 'other'); card = hand(s, 0, 'evolution'); });
  command(g, { type: 'evolve', cardId: card, pokemonId: g.snapshot().players[0].active.id });
  settleRestoring(g, f);
  assert.equal(g.snapshot().players[0].active.counters, 4);
});

// 「在下一个对手的回合，如果对手从手牌将能量附着于受到这个招式影响的宝可梦身上的话，对手的回合结束」.
const DAYDREAM = { side: 'opponent', target: 'active', duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true,
  trigger: { event: 'energyAttached', subject: 'self', origin: 'hand', optional: false, choiceOwner: 'affected', scope: 'global' },
  program: [{ op: 'endTurn', side: 'opponent' }] };
const daydream = (transform = () => {}, reaction = DAYDREAM) => fixture((defs) => {
  def(defs, 'base').mechanics.attacks.push({ attackId: 'base:daydream', name: '测试白日梦', cost: ['Water'], printedDamage: null,
    effects: [binding('cn.delayedReaction@1', clone(reaction), 'daydream')], sourceOfTruth: EVIDENCE });
  transform(defs);
});
// Player 0 uses the attack; player 1's turn starts.
function dream(f, mutate = () => {}) {
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); mutate(s); });
  command(g, { type: 'attack', attackId: 'base:daydream' }); settle(g);
  assert.equal(g.snapshot().current, 1);
  return restore(g, f);
}

test('effects.end-turn-reaction: Energy from the hand to the affected Pokémon ends that turn; elsewhere it does not', async () => {
  const f = await daydream();
  for (const [onActive, ends] of [[true, true], [false, false]]) {
    const g = dream(f, (s) => { bench(s, 1, 'other'); hand(s, 1, 'water'); });
    const s = g.snapshot(), energy = s.players[1].hand.find((id) => s.cards[id].definitionId === 'water');
    command(g, { type: 'attachEnergy', cardId: energy, pokemonId: onActive ? s.players[1].active.id : s.players[1].bench[0].id });
    settleRestoring(g, f);
    assert.equal(g.snapshot().current, ends ? 0 : 1, onActive ? 'The turn ended.' : 'Not the affected Pokémon.');
    assert.equal(g.snapshot().events.filter((e) => e.ruleId === 'effects.end-turn-reaction').length, Number(ends));
    if (ends) assert(g.snapshot().events.some((e) => e.ruleId === 'turn.end' && e.data.player === 1));
  }
});

test('effects.end-turn-reaction: the effect that attached it finishes first, and the turn ends once (JP Q&A サーフゴー／オーガポン)', async () => {
  const f = await daydream((defs) => {
    def(defs, 'research').mechanics.effects = [binding('cn.attachHand@1', { type: 'Water', count: 2, benchOnly: false, optional: false, target: 'active', exact: true }, 'weld'),
      binding('cn.draw@1', { count: 3 }, 'draw')];
  });
  let supporter;
  const g = dream(f, (s) => { supporter = hand(s, 1, 'research'); hand(s, 1, 'water'); hand(s, 1, 'water'); });
  const before = g.snapshot().players[1];
  command(g, { type: 'playTrainer', cardId: supporter });
  settleRestoring(g, f, attachAll);
  const s = g.snapshot();
  assert.equal(s.players[1].active.energy.length, 2, 'Both chosen Energy cards were attached.');
  assert.equal(s.players[1].hand.length, before.hand.length - 3 + 3, 'Then 3 cards were drawn.');
  assert(s.players[1].discard.includes(supporter), 'The Supporter finished.');
  assert.equal(s.current, 0);
  assert.deepEqual(s.events.filter((e) => e.ruleId === 'effects.end-turn-reaction').map((e) => e.data.ends), [true, false]);
  assert.equal(s.events.filter((e) => e.ruleId === 'turn.end' && e.data.player === 1).length, 1);
  assert.equal(s.players[0].turns, 4, 'Player 0 has their next turn, once.');
});

test('effects.end-turn-reaction: the Pokémon switched to the Bench by the same event still ends the turn (JP Q&A ワープエネルギー)', async () => {
  const warp = { ...binding('cn.switch@1', { side: 'own', chooser: 'self', affected: 'active' }, 'warp'),
    trigger: { event: 'energyAttached', subject: 'self', origin: 'hand', cardIsSource: true, optional: false, choiceOwner: 'source', scope: 'global' } };
  const f = await daydream((defs) => { def(defs, 'double').mechanics.effects = [warp]; });
  for (const first of ['warp', 'reaction']) {
    let energy;
    const g = dream(f, (s) => { bench(s, 1, 'other'); energy = hand(s, 1, 'double'); });
    const affected = g.snapshot().players[1].active.id;
    command(g, { type: 'attachEnergy', cardId: energy, pokemonId: affected });
    const q = g.snapshot().pending;
    assert.equal(q.kind, 'trigger-order');
    answer(g, [q.options.find((id) => !!q.data.units.find((u) => u.id === id).reaction === (first === 'reaction'))]);
    settleRestoring(g, f);
    const s = g.snapshot();
    assert.equal(s.current, 0, first);
    assert(s.players[1].bench.some((m) => m.id === affected), 'It was switched to the Bench.');
  }
});

test('effects.end-turn-reaction: during the opponent\'s attack the attack ends the turn, once; side own is not that turn', async () => {
  const f = await daydream((defs) => {
    def(defs, 'base').mechanics.attacks.push({ attackId: 'base:charge', name: '测试充能', cost: [], printedDamage: null,
      effects: [binding('cn.attachHand@1', { type: 'Water', count: 1, benchOnly: false, optional: false, target: 'self' }, 'charge')], sourceOfTruth: EVIDENCE });
  });
  const g = dream(f, (s) => { hand(s, 1, 'water'); });
  command(g, { type: 'attack', attackId: 'base:charge' });
  settleRestoring(g, f, attachAll);
  const s = g.snapshot();
  assert.equal(s.current, 0); assert.equal(s.players[0].turns, 4);
  assert.equal(s.events.filter((e) => e.ruleId === 'turn.end' && e.data.player === 1).length, 1);
  assert.deepEqual(s.events.filter((e) => e.ruleId === 'effects.end-turn-reaction').map((e) => e.data.ends), [true]);
  // 「自己的回合结束」 placed for the opponent's turn: not the current player's turn, nothing ends.
  const own = await daydream(() => {}, { ...DAYDREAM, program: [{ op: 'endTurn', side: 'own' }] });
  const h = dream(own, (s) => { hand(s, 1, 'water'); });
  const t = h.snapshot(), energy = t.players[1].hand.find((id) => t.cards[id].definitionId === 'water');
  command(h, { type: 'attachEnergy', cardId: energy, pokemonId: t.players[1].active.id });
  settleRestoring(h, own);
  assert.equal(h.snapshot().current, 1);
  assert.deepEqual(h.snapshot().events.filter((e) => e.ruleId === 'effects.end-turn-reaction').map((e) => e.data), [{ player: 0, effectId: 'fixture:daydream', ends: false }]);
});

// 「当双方的玩家，将自己处于【中毒】状态的战斗宝可梦因训练家的效果而与备战宝可梦互换时，新出场的宝可梦，会继承其【中毒】状态。（如果因该【中毒】
// 而放置的伤害指示物数量有所增加的话，则也同样继承其数量。）」 (trigger.cause, status.inherit).
const TRAINERS = ['item', 'supporter', 'stadium', 'tool'];
const DUST = { event: 'movedToBench', subject: 'all', optional: false, choiceOwner: 'affected', scope: 'global',
  subjectState: { conditions: ['poisoned'] }, causeSource: { side: 'own', categories: TRAINERS } };
const inherit = binding('cn.condition@1', { side: 'event', target: 'active', condition: 'poisoned', inherit: true }, 'dust');
const dust = (trigger = DUST, transform = () => {}) => fixture((defs) => {
  def(defs, 'stadium').mechanics.effects = [{ ...inherit, trigger }];
  def(defs, 'potion').mechanics.effects = [binding('cn.switch@1', { side: 'own', chooser: 'self', affected: 'active' }, 'switch')];
  def(defs, 'research').mechanics.effects = [binding('cn.switch@1', { side: 'opponent', chooser: 'opponent', affected: 'active' }, 'repel')];
  def(defs, 'base').mechanics.attacks.push({ attackId: 'base:shift', name: '测试换位', cost: [], printedDamage: null,
    effects: [binding('cn.switch@1', { side: 'own', chooser: 'self', affected: 'active' }, 'shift')], sourceOfTruth: EVIDENCE });
  transform(defs);
});
const stadium = (s, owner = 1) => { s.stadium = hand(s, owner, 'stadium'); s.players[owner].hand.pop(); };

test('status.inherit schema: the event Pokémon\'s own Poison, for its owner\'s Active', () => {
  const valid = handlers.get('cn.condition@1').validateParameters;
  assert(valid(inherit.parameters)); assert(valid({ side: 'event', target: 'event', condition: 'burned' }));
  for (const bad of [{ side: 'own', target: 'active', condition: 'poisoned', inherit: true }, { side: 'event', condition: 'poisoned' },
    { side: 'event', target: 'self', condition: 'poisoned' }, { ...inherit.parameters, condition: 'burned' }, { ...inherit.parameters, poisonCounters: 2 },
    { ...inherit.parameters, inherit: false }]) assert(!valid(bad), JSON.stringify(bad));
});

test('「因训练家的效果而与备战宝可梦互换时…会继承其【中毒】状态」: one\'s own Trainer only, with its counters (JP Q&A ダストアイランド)', async () => {
  const f = await dust();
  for (const [how, inherited] of [['item', 4], ['retreat', null], ['opponent', null], ['clean', null]]) {
    let card;
    const g = board(f, (s) => {
      stadium(s);
      const p = s.players[0];
      if (how !== 'clean') p.active.conditions.poison = 4;
      bench(s, 0, 'other');
      if (how === 'retreat') attached(s, 0, p.active, 'water');
      if (how === 'opponent') { fixtureClock(s, [0, 1, 0, 1]); card = hand(s, 1, 'research'); }
      else card = hand(s, 0, 'potion');
    });
    const first = g.snapshot().players[0].active.id;
    command(g, how === 'retreat' ? { type: 'retreat' } : { type: 'playTrainer', cardId: card });
    settleRestoring(g, f, (q) => q.options.slice(0, Math.max(q.minimum, 1)));
    const s = g.snapshot(), p = s.players[0];
    assert.notEqual(p.active.id, first, how);
    assert.equal(p.active.conditions.poison, inherited, how);
    assert.equal(p.bench.find((m) => m.id === first).conditions.poison, null, 'The Pokémon on the Bench recovered as usual.');
  }
});

test('status.inherit: an attack\'s switch does not inherit; an immune new Active is not Poisoned; no Poison, nothing to inherit', async () => {
  const f = await dust();
  const g = board(f, (s) => { stadium(s); s.players[0].active.conditions.poison = 2; bench(s, 0, 'other'); });
  command(g, { type: 'attack', attackId: 'base:shift' });
  settleRestoring(g, f, (q) => q.options.slice(0, Math.max(q.minimum, 1)));
  assert(!g.snapshot().events.some((e) => e.ruleId === 'status.poison' && e.data.effectId === 'fixture:dust'));
  const immune = await dust(DUST, (defs) => {
    def(defs, 'other').mechanics.abilities = [{ abilityId: 'other:immune', name: '测试免疫', mode: 'continuous', usage: null, sourceOfTruth: EVIDENCE,
      effects: [binding('cn.conditionImmunity@1', { effect: { op: 'conditionImmunity', scope: 'self' } }, 'immune')] }];
  });
  let card;
  const h = board(immune, (s) => { stadium(s); s.players[0].active.conditions.poison = 2; bench(s, 0, 'other'); card = hand(s, 0, 'potion'); });
  command(h, { type: 'playTrainer', cardId: card });
  settleRestoring(h, immune, (q) => q.options.slice(0, Math.max(q.minimum, 1)));
  assert.equal(h.snapshot().players[0].active.conditions.poison, null);
  assert(h.snapshot().events.some((e) => e.ruleId === 'status.immunity' && e.data.effectId === 'fixture:dust'));
  // Without the printed Poison filter, a Pokémon that was not Poisoned passes nothing on.
  const { subjectState: _state, ...bare } = DUST;
  const plain = await dust(bare);
  const k = board(plain, (s) => { stadium(s); bench(s, 0, 'other'); card = hand(s, 0, 'potion'); });
  command(k, { type: 'playTrainer', cardId: card });
  settleRestoring(k, plain, (q) => q.options.slice(0, Math.max(q.minimum, 1)));
  assert.equal(k.snapshot().players[0].active.conditions.poison, null);
  assert.equal(k.snapshot().events.filter((e) => e.ruleId === 'effects.partial' && e.data.effectId === 'fixture:dust').map((e) => e.data.performed).join(), 'false');
});

// 「当双方玩家，从手牌使出别的名字的竞技场时，将这张竞技场放于弃牌区之后，那张竞技场也会被放于弃牌区。（新出场的竞技场的效果不产生作用。）」.
const SWELL = binding('cn.stadiumReplacement@1', { effect: { op: 'stadiumReplacement', scope: 'self', incoming: 'discard' } }, 'swell');
const swell = () => fixture((defs) => {
  def(defs, 'stadium').mechanics.effects = [SWELL];
  // The incoming Stadium: 「双方玩家可以放于备战区的宝可梦数量，变为3只」.
  def(defs, 'hp-tool').mechanics = { category: 'stadium', effects: [binding('cn.benchLimit@1', { effect: { op: 'benchLimit', scope: 'all', limit: 3 } }, 'collapse')] };
  def(defs, 'tool').mechanics.category = 'stadium';
});

test('effects.stadium-replacement: schema, on a Stadium only', async () => {
  const valid = handlers.get('cn.stadiumReplacement@1').validateParameters;
  assert(valid(SWELL.parameters));
  assert(!valid({ effect: { ...SWELL.parameters.effect, scope: 'all' } })); assert(!valid({ effect: { op: 'stadiumReplacement', scope: 'self' } }));
  const misplaced = await fixture((defs) => { def(defs, 'tool').mechanics.effects = [SWELL]; });
  assert.throws(() => board(misplaced), (e) => e.code === 'unsupported-handler');
});

test('「那张竞技场也会被放于弃牌区（新出场的竞技场的效果不产生作用）」: both go; no Bench trim; no second Stadium this turn (JP Q&A 混沌のうねり)', async () => {
  const f = await swell();
  let card, old, other;
  const g = board(f, (s) => {
    stadium(s); old = s.stadium;
    for (const id of ['base', 'other', 'other', 'evolution']) bench(s, 0, id);
    card = hand(s, 0, 'hp-tool'); other = hand(s, 0, 'tool');
  });
  assert(g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === other));
  command(g, { type: 'playTrainer', cardId: card });
  settleRestoring(g, f);
  const s = g.snapshot();
  assert.equal(s.stadium, null);
  assert(s.players[1].discard.includes(old)); assert(s.players[0].discard.includes(card));
  assert.equal(s.players[0].bench.length, 4, 'The new Stadium\'s Bench limit never applied.');
  assert.deepEqual(s.events.filter((e) => e.ruleId === 'effects.stadium-replacement').map((e) => e.data),
    [{ player: 0, cardId: card, by: old, effectId: s.events.find((e) => e.ruleId === 'effects.stadium-replacement').data.effectId }]);
  assert(!g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === other), 'A Stadium was played this turn.');
  // Without it in play, the new Stadium stays as usual.
  const plain = await fixture((defs) => {
    def(defs, 'hp-tool').mechanics = { category: 'stadium', effects: [binding('cn.benchLimit@1', { effect: { op: 'benchLimit', scope: 'all', limit: 3 } }, 'collapse')] };
  });
  const h = board(plain, (s) => { stadium(s); card = hand(s, 0, 'hp-tool'); });
  command(h, { type: 'playTrainer', cardId: card });
  settleRestoring(h, plain);
  assert.equal(h.snapshot().stadium, card);
});

// 「在自己的回合，当这张卡牌因为「霍米加」的效果而被放于弃牌区时，可使用1次。给对手的所有宝可梦身上，各放置1个伤害指示物。(放置伤害指示物的
// 时间点在「霍米加」的效果之后。)」 and 「当这只宝可梦，因为「坂木的放逐」的效果而被放于弃牌区时，对手从牌库上方将1张卡牌放于弃牌区。」
// (trigger.discarded): the fixture Supporter 'research' and Item 'potion' stand for 「X」.
const BOMB = { event: 'discarded', from: 'hand', optional: true,
  causeSource: { side: 'own', categories: ['supporter'], card: { kind: 'trainer', nameKeys: ['research'] } } };
const UNDERGROUND = { event: 'discarded', from: 'field', optional: false,
  causeSource: { side: 'own', categories: ['item'], card: { kind: 'trainer', nameKeys: ['potion'] } } };
const bomb = (trigger = BOMB, extra = {}) => triggered('other:bomb', trigger,
  [binding('cn.counters@1', { side: 'opponent', target: 'any', count: 1, all: true }, 'bomb')], extra);
const exile = binding('cn.fieldReturn@1', { op: 'returnPokemon', side: 'own', target: 'bench', selector: { kind: 'pokemon' },
  quantity: { kind: 'upTo', count: 2 }, to: 'discard', attachments: 'discard', chooser: 'source' }, 'exile');
const STURDY = { abilityId: 'other:sturdy', name: '测试坚硬', mode: 'continuous', usage: null, sourceOfTruth: EVIDENCE,
  effects: [binding('cn.modifier@1', { field: 'hp', amount: 10, scope: 'self' }, 'sturdy')] };
const gas = (transform = () => {}) => fixture((defs) => {
  def(defs, 'other').mechanics.abilities = [STURDY, bomb()];
  // 「从自己的手牌将最多2张宝可梦放于弃牌区」, then a search that pauses the Supporter before it finishes, then a draw.
  def(defs, 'research').mechanics.effects = [
    binding('cn.cards@1', { from: 'hand', to: 'discard', selector: { kind: 'pokemon' }, quantity: { kind: 'upTo', count: 2 }, reveal: false, lookTop: null, shuffleAfter: false }, 'roxie'),
    binding('cn.cards@1', { from: 'deck', to: 'hand', selector: { kind: 'any' }, quantity: { kind: 'exact', count: 1 }, reveal: false, lookTop: null, shuffleAfter: true }, 'search'),
    binding('cn.draw@1', { count: 1 }, 'draw')];
  def(defs, 'base').mechanics.abilities = [triggered('base:underground', UNDERGROUND,
    [binding('cn.discardDeckTop@1', { side: 'opponent', count: 1 }, 'underground')])];
  def(defs, 'potion').mechanics.effects = [exile];
  transform(defs);
});

test('trigger.cause: the causing effect\'s player, kind and printed card', async () => {
  const f = await gas(), s = board(f).snapshot(), definitionOf = (id) => f.catalog.definition(s.cards[id].definitionId);
  const card = (owner, id) => Object.keys(s.cards).find((c) => s.cards[c].definitionId === id && s.cards[c].owner === owner);
  const source = (owner, category, id) => ({ instanceId: card(owner, id), owner, category, pokemonId: null, attackId: null, effectId: 'x', sourceOfTruth: EVIDENCE });
  const by = (src) => ({ kind: 'effect', source: src }), research = source(0, 'trainer', 'research'), strike = source(1, 'attack', 'base');
  assert(causeMatches({ categories: ['supporter'] }, by(research), 0, definitionOf));
  assert(causeMatches({ side: 'own', card: { kind: 'trainer', nameKeys: ['research'] } }, by(research), 0, definitionOf));
  assert(!causeMatches({ side: 'opponent' }, by(research), 0, definitionOf));
  assert(causeMatches({ side: 'opponent', categories: ['attack', 'ability'] }, by(strike), 0, definitionOf));
  assert(!causeMatches({ categories: ['item'] }, by(research), 0, definitionOf));
  assert(!causeMatches({ card: { kind: 'trainer', nameKeys: ['potion'] } }, by(research), 0, definitionOf));
  assert(!causeMatches({ side: 'own' }, { kind: 'effect', source: null }, 0, definitionOf));
  assert(!causeMatches({ side: 'own' }, { kind: 'rule', source: null }, 0, definitionOf));
});

test('trigger.discarded schema: a Pokémon\'s own Ability, once per discard, caused by its owner\'s Item or Supporter', async () => {
  await gas();
  const reject = (mutate, pattern = /Invalid normalized card definition/) => assert.rejects(gas(mutate), pattern);
  await reject((defs) => { def(defs, 'other').mechanics.abilities = [bomb(BOMB, { usage: { period: 'turn', scope: 'pokemon', key: 'x', limit: 1 } })]; });
  await reject((defs) => { def(defs, 'other').mechanics.abilities = [bomb(BOMB, { costs: [{ costId: 'x', kind: 'discardHand', count: 1, selector: { kind: 'any' } }] })]; });
  await reject((defs) => { def(defs, 'other').mechanics.abilities = [bomb({ ...BOMB, causeSource: { ...BOMB.causeSource, side: 'opponent' } })]; });
  await reject((defs) => { def(defs, 'other').mechanics.abilities = [bomb({ ...BOMB, causeSource: { side: 'own', categories: ['attack'] } })]; });
  await reject((defs) => { def(defs, 'other').mechanics.abilities = [bomb([BOMB, { ...BOMB, from: 'field' }])]; });
  const misplaced = await gas((defs) => { def(defs, 'tool').mechanics.effects = [{ ...binding('cn.draw@1', { count: 1 }, 'x'), trigger: BOMB }]; });
  assert.throws(() => board(misplaced), (e) => e.code === 'unsupported-trigger-zone');
});

test('「当这张卡牌因为「X」的效果而被放于弃牌区时」: after X\'s whole effect, in the owner\'s order, Knock Outs after both (JP Q&A マタドガス)', async () => {
  const f = await gas();
  let supporter, first, second;
  const g = board(f, (s) => {
    supporter = hand(s, 0, 'research'); first = hand(s, 0, 'other'); second = hand(s, 0, 'other');
    s.players[1].active.counters = 9; bench(s, 1, 'base');
  });
  command(g, { type: 'playTrainer', cardId: supporter });
  // Both Pokémon go; the Supporter then searches (it has not finished yet).
  assert.equal(g.snapshot().pending.kind, 'select-cards');
  answer(g, [first, second]);
  assert.equal(g.snapshot().pending.kind, 'select-cards');
  const finish = g.snapshot().queue.find((t) => t.op === 'finish-trainer');
  assert.deepEqual(finish.data.discarded.map((u) => u.cardId), [first, second]);
  restore(g, f);
  const forged = clone(g.snapshot());
  forged.queue.find((t) => t.op === 'finish-trainer').data.discarded[0].abilityId = 'other:sturdy';
  assert.throws(() => OfficialGame.restore(forged, { catalog: f.catalog }), (e) => e.code === 'invalid-discard-trigger');
  answer(g, g.snapshot().pending.options.slice(0, 1));
  const q = g.snapshot().pending;
  assert.equal(q.kind, 'trigger-order'); assert.equal(q.player, 0);
  const events = g.snapshot().events;
  assert(events.findIndex((e) => e.ruleId === 'effects.draw') < events.findIndex((e) => e.ruleId === 'turn.trainer' && e.data.kind === 'trainer-finished'),
    'The Supporter finished first.');
  settleRestoring(g, f, perform);
  const s = g.snapshot();
  assert.equal(s.events.filter((e) => e.ruleId === 'trigger.discarded' && e.data.kind === 'used' && e.data.performed).length, 2);
  assert.equal(s.players[1].bench.length, 0, 'The Active was Knocked Out after both; its Bench Pokémon took 2 and was promoted.');
  assert.equal(s.players[1].active.counters, 2);
  assert.equal(s.players[0].prizes.length, 5);
});

test('trigger.discarded: optional, the wrong card or a returned card does nothing; an untimed discard fails closed', async () => {
  const f = await gas();
  let supporter, card;
  const g = board(f, (s) => { supporter = hand(s, 0, 'research'); card = hand(s, 0, 'other'); });
  command(g, { type: 'playTrainer', cardId: supporter });
  answer(g, [card]); answer(g, g.snapshot().pending.options.slice(0, 1));
  assert.equal(g.snapshot().pending.kind, 'trigger-optional');
  restore(g, f);
  const forged = clone(g.snapshot());
  forged.pending.data.unit.cardId = supporter;
  assert.throws(() => OfficialGame.restore(forged, { catalog: f.catalog }), (e) => e.code === 'invalid-discard-trigger');
  const moved = clone(g.snapshot()), p = moved.players[0];
  p.discard.splice(p.discard.indexOf(card), 1); p.hand.push(card);
  assert.throws(() => OfficialGame.restore(moved, { catalog: f.catalog }), (e) => e.code === 'invalid-discard-trigger' && /still in the discard pile/.test(e.message));
  answer(g, ['skip']);
  assert.equal(g.snapshot().players[1].active.counters, 0);
  assert.deepEqual(g.snapshot().events.filter((e) => e.ruleId === 'trigger.discarded' && e.data.kind === 'used').map((e) => e.data.performed), [false]);
  // Another Supporter's effect, or a card that triggers only from the field: no trigger.
  const other = await gas((defs) => {
    def(defs, 'other').mechanics.abilities = [bomb({ ...BOMB, causeSource: { ...BOMB.causeSource, card: { kind: 'trainer', nameKeys: ['potion'] } } })];
  });
  let digger;
  const h = board(other, (s) => { supporter = hand(s, 0, 'research'); card = hand(s, 0, 'other'); digger = hand(s, 0, 'base'); });
  command(h, { type: 'playTrainer', cardId: supporter });
  answer(h, [card, digger]); settleRestoring(h, other);
  assert(h.snapshot().players[0].discard.includes(digger));
  assert(!h.snapshot().events.some((e) => e.ruleId === 'trigger.discarded'));
  // The same Supporter's later part takes the card back from the discard pile before it finishes: nothing to use.
  const back = await gas((defs) => {
    def(defs, 'research').mechanics.effects.splice(1, 1, binding('cn.cards@1', { from: 'discard', to: 'hand', selector: { kind: 'pokemon' },
      quantity: { kind: 'exact', count: 1 }, reveal: true, lookTop: null, shuffleAfter: false }, 'recover'));
  });
  const k = board(back, (s) => { supporter = hand(s, 0, 'research'); card = hand(s, 0, 'other'); });
  command(k, { type: 'playTrainer', cardId: supporter });
  answer(k, [card]); settleRestoring(k, back, (q) => q.options.includes(card) ? [card] : q.options.slice(0, q.minimum));
  assert(k.snapshot().players[0].hand.includes(card));
  assert(!k.snapshot().events.some((e) => e.ruleId === 'trigger.discarded' && e.data.kind === 'used'));
  // 「使用了这张卡牌的回合结束时，将手牌全部放于弃牌区」: the Item has long finished; no sourced timing.
  const late = await gas((defs) => {
    def(defs, 'other').mechanics.abilities = [bomb({ ...BOMB, causeSource: { side: 'own', categories: ['item'] } })];
    def(defs, 'poison').mechanics.effects = [binding('cn.turnEndEffect@1', { effect: { handlerId: 'cn.discardHand@1', parameters: {} } }, 'later')];
  });
  let item;
  const m = board(late, (s) => { item = hand(s, 0, 'poison'); hand(s, 0, 'other'); });
  command(m, { type: 'playTrainer', cardId: item }); settle(m);
  assert.throws(() => command(m, { type: 'endTurn' }), (e) => e.code === 'unresolved-discard-trigger');
});

test('「当这只宝可梦，因为「X」的效果而被放于弃牌区时」: from the Bench, its Ability judged before any leaves (JP Q&A ディグダ)', async () => {
  const BASIC_GAS = { abilityId: 'evolution:gas', name: '测试化学之力', mode: 'continuous', usage: null, sourceOfTruth: EVIDENCE,
    effects: [binding('cn.suppression@1', { effect: { op: 'suppression', channel: 'abilities', scope: 'all', stage: 'basic' } }, 'gas')] };
  for (const [suppressor, to, works] of [[false, 'discard', true], [true, 'discard', false], [false, 'hand', false]]) {
    const f = await gas((defs) => {
      if (suppressor) def(defs, 'evolution').mechanics.abilities = [BASIC_GAS];
      def(defs, 'potion').mechanics.effects = [{ ...exile, parameters: { ...exile.parameters, to } }];
    });
    let item, digger;
    const g = board(f, (s) => { item = hand(s, 0, 'potion'); digger = bench(s, 0, 'base'); if (suppressor) bench(s, 0, 'evolution'); });
    const deck = g.snapshot().players[1].deck.length;
    command(g, { type: 'playTrainer', cardId: item });
    settleRestoring(g, f, (q) => q.kind === 'effect-target' || q.kind === 'select-pokemon' ? q.options.slice(0, q.maximum) : q.options.slice(0, q.minimum));
    const s = g.snapshot();
    assert(!s.players[0].bench.some((m) => m.id === digger.id), 'It left play.');
    assert.equal(s.players[1].deck.length, deck - Number(works), `${suppressor ? 'with' : 'without'} the suppressor, to ${to}`);
  }
});
