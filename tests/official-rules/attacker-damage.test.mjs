// Synthetic definitions only. Reactions and protections that depend on who attacked or how much damage:
// 「身上放有这张卡牌的宝可梦，受到对手【龙】宝可梦的招式的伤害时，那个伤害「-60」，将这张卡牌放于弃牌区。」 (tools.damage-discard);
// 「当这只宝可梦，在战斗场上受到对手「宝可梦VMAX」的招式的伤害时，将与受到的伤害数值相同的伤害指示物，放置于使用了招式的宝可梦身上。」;
// 「在下一个自己的回合，受到这个招式影响的宝可梦，受到「连击」宝可梦的招式的伤害便会【昏厥】。」;
// 「身上放有这张卡牌的宝可梦，在战斗场上受到对手宝可梦的「180」点以上（包含180）的招式的伤害时，给使用了招式的宝可梦身上放置10个伤害指示物。」
// (trigger.damage-filters); 「这只宝可梦，不会受到对手宝可梦的「200」及以上的招式的伤害。」 and 「这只宝可梦不会受到对手宝可梦的伤害为
// 「20、40、60、80、100、120、140、160、180、200、220、240、260」的招式的伤害。」 (damage.prevention-values); 「在下一个对手的回合，自己所有的
// 「未来」宝可梦，不会受到「宝可梦ex」的招式的伤害。如果这只宝可梦离开战斗场的话，则这个效果消除。」 (effects.duration.user-leaves-active).
// No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { calculateAttackDamage } from '../../public/rules/damage.js';
import { triggerMatches } from '../../public/rules/triggers.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { fixture, binding, EVIDENCE, board, command, settle, hand, bench, attached } from './fixtures.mjs';

const handlers = createCoreHandlers();
const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const continuous = (abilityId, effects) => ({ abilityId, name: '测试特性', mode: 'continuous', usage: null, effects, sourceOfTruth: EVIDENCE });
const strike = (s, owner = 0) => attached(s, owner, s.players[owner].active, 'water');
const attack = (g, attackId = 'base:strike') => { command(g, { type: 'attack', attackId }); settle(g); };
const equip = (s, owner, m, id = 'tool') => { const card = hand(s, owner, id); s.players[owner].hand.pop(); m.tools.push(card); return card; };
const promote = (s, owner, id) => { const m = bench(s, owner, id), p = s.players[owner]; p.bench = [p.active]; p.active = m; return m; };
const damage = (defs, id, value) => { def(defs, id).mechanics.attacks[0].printedDamage = { value, operator: 'fixed' }; };
const shield = (extra) => ({ effect: { op: 'protection', channel: 'damage', useRule: 'ordinary', scope: 'self', from: 'opponent', categories: ['attack'], ...extra } });
const DISCARDS = (s) => s.events.filter((e) => e.ruleId === 'tools.damage-discard');

// 「…受到对手【水】宝可梦的招式的伤害时，那个伤害「-60」，将这张卡牌放于弃牌区」 (the fixture Pokémon are Water).
const berry = (types = ['Water']) => binding('cn.modifier@1', { field: 'defenseDamage', amount: -60, scope: 'self', damageFrom: 'opponent',
  otherSelector: { kind: 'pokemon', types }, discardCard: true }, `berry-${types.join('-')}`);
const berried = (transform = () => {}, types) => fixture((defs) => { def(defs, 'tool').mechanics.effects = [berry(types)]; transform(defs); });

test('berry schema: a holder\'s own damage change only, and only a Tool discards itself', async () => {
  const valid = handlers.get('cn.modifier@1').validateParameters, { parameters } = berry(), { damageFrom: _from, ...dealt } = parameters;
  assert(valid(parameters)); assert(valid(dealt));
  assert(!valid({ ...dealt, field: 'attackDamage' }));
  assert(!valid({ ...parameters, scope: 'own' }));
  assert(!valid({ ...parameters, discardCard: false }));
  assert(!handlers.get('cn.lasting@1').validateParameters({ side: 'own', target: 'self', duration: 'nextOpponentTurn', clearOnBench: true,
    clearOnEvolution: true, effect: { op: 'modifier', field: 'defenseDamage', amount: -60, scope: 'all', discardCard: true } }));
  const misplaced = await fixture((defs) => { def(defs, 'base').mechanics.abilities = [continuous('base:berry', [berry()])]; });
  assert.throws(() => board(misplaced), (e) => e.code === 'unsupported-handler', 'An Ability has no 「这张卡牌」 to discard.');
  const stadium = await fixture((defs) => { def(defs, 'stadium').mechanics.effects = [berry()]; });
  assert.throws(() => board(stadium), (e) => e.code === 'unsupported-handler');
});

test('「那个伤害「-60」，将这张卡牌放于弃牌区」: -60, and the Tool goes even when the damage becomes 0', async () => {
  for (const [value, counters] of [[80, 2], [20, 0]]) {
    const f = await berried((defs) => damage(defs, 'base', value));
    let card;
    const g = board(f, (s) => { strike(s); card = equip(s, 1, s.players[1].active); });
    attack(g);
    const s = g.snapshot();
    assert.equal(s.players[1].active.counters, counters, `${value} - 60`);
    assert.deepEqual(s.players[1].active.tools, []);
    assert(s.players[1].discard.includes(card));
    assert.deepEqual(DISCARDS(s).map((e) => e.data), [{ player: 1, pokemonId: s.players[1].active.id, cardId: card }]);
    restore(g, f);
  }
  // Another type's attack: no change and the Tool stays.
  const f = await berried(() => {}, ['Dragon']);
  let card;
  const g = board(f, (s) => { strike(s); card = equip(s, 1, s.players[1].active); });
  attack(g);
  assert.equal(g.snapshot().players[1].active.counters, 2);
  assert.deepEqual(g.snapshot().players[1].active.tools, [card]);
});

test('JP Q&A ウタンのみ: not discarded when the attacker\'s effect or Resistance already made the damage 0', async () => {
  const weak = await berried((defs) => {
    def(defs, 'hp-tool').mechanics.effects = [binding('cn.modifier@1', { field: 'attackDamage', amount: -20, scope: 'self' }, 'weak')];
  });
  const resisted = await berried((defs) => { def(defs, 'base').mechanics.resistance = { type: 'Water', value: 30 }; });
  for (const [f, mutate] of [[weak, (s) => equip(s, 0, s.players[0].active, 'hp-tool')], [resisted, () => {}]]) {
    let card;
    const g = board(f, (s) => { strike(s); mutate(s); card = equip(s, 1, s.players[1].active); });
    attack(g);
    const s = g.snapshot();
    assert.equal(s.players[1].active.counters, 0);
    assert.deepEqual(s.players[1].active.tools, [card], 'The damage never reached the defender\'s step.');
    assert.deepEqual(DISCARDS(s), []);
  }
});

test('JP Q&A オッカのみ／ウタンのみ: discarded when the damage is prevented or the attack ignores the defender\'s effects', async () => {
  const veiled = await berried((defs) => {
    def(defs, 'other').mechanics.abilities = [continuous('other:veil', [binding('cn.protection@1', shield({}), 'veil')])];
  });
  const crushing = await berried((defs) => {
    def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.damageOptions@1', { ignoreDefenderEffects: true }, 'crush')];
  });
  for (const [f, counters] of [[veiled, 0], [crushing, 2]]) {
    let card;
    const g = board(f, (s) => { strike(s); card = equip(s, 1, promote(s, 1, 'other')); });
    attack(g);
    const s = g.snapshot();
    assert.equal(s.players[1].active.counters, counters);
    assert(s.players[1].discard.includes(card));
    assert.equal(DISCARDS(s).length, 1);
  }
  // A Tool whose effects are removed neither changes the damage nor goes.
  const jammed = await berried((defs) => {
    def(defs, 'stadium').mechanics.effects = [binding('cn.suppression@1', { effect: { op: 'suppression', channel: 'tools', scope: 'all' } }, 'jam')];
  });
  let card;
  const g = board(jammed, (s) => { strike(s); s.stadium = hand(s, 1, 'stadium'); s.players[1].hand.pop(); card = equip(s, 1, s.players[1].active); });
  attack(g);
  assert.equal(g.snapshot().players[1].active.counters, 2);
  assert.deepEqual(g.snapshot().players[1].active.tools, [card]);
});

test('JP Q&A ブロロロームex: every such Tool on the Pokémon goes; a second packet of the same attack is not reduced again', async () => {
  const f = await berried((defs) => {
    def(defs, 'hp-tool').mechanics.effects = [berry()];
    def(defs, 'other').mechanics.hp = 300;
    def(defs, 'other').mechanics.abilities = [continuous('other:rack', [binding('cn.toolCapacity@1', { effect: { op: 'toolCapacity', scope: 'self', count: 2 } }, 'rack')])];
  });
  let cards;
  const g = board(f, (s) => { strike(s); const m = promote(s, 1, 'other'); cards = [equip(s, 1, m), equip(s, 1, m, 'hp-tool')]; });
  attack(g);
  const s = g.snapshot();
  assert.equal(s.players[1].active.counters, 0, '20 - 60 - 60.');
  assert.deepEqual(DISCARDS(s).map((e) => e.data.cardId).sort(), [...cards].sort());
  assert.deepEqual(s.players[1].active.tools, []);
  const twice = await berried((defs) => {
    def(defs, 'other').mechanics.hp = 300;
    def(defs, 'base').mechanics.attacks[0].effects = [binding('cn.damage@1', { side: 'opponent', target: 'active', amount: 100,
      selection: { kind: 'exact', count: 1 }, options: {} }, 'again')];
  });
  const h = board(twice, (s) => { strike(s); equip(s, 1, promote(s, 1, 'other')); });
  attack(h);
  assert.equal(h.snapshot().players[1].active.counters, 10, '20 - 60 = 0, then the full 100: the Tool is already gone.');
  assert.equal(DISCARDS(h.snapshot()).length, 1);
});

// 「当这只宝可梦，在战斗场上受到对手「宝可梦GX・EX」的招式的伤害时，将与受到的伤害数值相同的伤害指示物，放置于使用了招式的宝可梦身上」.
const GX_EX = { anyOf: [{ kind: 'pokemon', tagsAll: ['GX'] }, { kind: 'pokemon', tagsAll: ['EX'] }] };
const mirror = (optional = false) => ({ abilityId: 'other:mirror', name: '测试镜面', mode: 'triggered', usage: null,
  trigger: { event: 'attackDamage', subject: 'self', optional, choiceOwner: 'source', scope: 'global', cause: 'opponentAttackDamage',
    activeOnly: true, attackerSelector: GX_EX },
  effects: [binding('cn.countersFromDamage@1', { side: 'opponent', target: 'attacker' }, 'mirror')], sourceOfTruth: EVIDENCE });

test('trigger schema: attackerSelector and damageAtLeast are attack-damage filters', () => {
  const ability = (trigger) => handlers.get('cn.delayedReaction@1').validateParameters({ side: 'own', target: 'self', duration: 'nextOpponentTurn',
    clearOnBench: true, clearOnEvolution: true, program: [{ op: 'counters', side: 'opponent', target: 'attacker', count: 1 }],
    trigger: { event: 'attackDamage', subject: 'self', optional: false, choiceOwner: 'source', scope: 'global', ...trigger } });
  assert(ability({ attackerSelector: GX_EX })); assert(ability({ damageAtLeast: 180 }));
  assert(!ability({ damageAtLeast: 185 })); assert(!ability({ damageAtLeast: 0 }));
  assert(!ability({ event: 'knockout', attackerSelector: GX_EX })); assert(!ability({ event: 'turnEnd', damageAtLeast: 180 }));
});

test('「受到对手「宝可梦GX・EX」的招式的伤害时」: the attacking Pokémon as it was when it dealt the damage', async () => {
  for (const [tags, back] of [[['GX'], 2], [['EX'], 2], [[], 0]]) {
    const f = await fixture((defs) => { def(defs, 'other').mechanics.abilities = [mirror()]; def(defs, 'base').mechanics.tags = tags; });
    const g = board(f, (s) => { strike(s); promote(s, 1, 'other'); });
    attack(g);
    const s = g.snapshot();
    assert.equal(s.players[0].active.counters, back, tags.join() || 'no tag');
    const receipt = s.events.find((e) => e.ruleId === 'pokemon.types' && e.data.attacker);
    assert.deepEqual(receipt.data.attacker, { cardId: s.players[0].active.stack[0], types: ['Water'] });
  }
  // A pending reaction keeps the attacker of its event through a restore, and a changed receipt is refused.
  const f = await fixture((defs) => { def(defs, 'other').mechanics.abilities = [mirror(true)]; def(defs, 'base').mechanics.tags = ['GX']; });
  const g = board(f, (s) => { strike(s); promote(s, 1, 'other'); });
  command(g, { type: 'attack', attackId: 'base:strike' });
  assert.equal(g.snapshot().pending.kind, 'trigger-optional');
  restore(g, f);
  const forged = clone(g.snapshot());
  forged.pending.data.unit.event.attacker.types = ['Fire'];
  assert.throws(() => OfficialGame.restore(forged, { catalog: f.catalog }), (e) => e.code === 'invalid-trigger-types');
  settle(g, (q) => q.kind === 'trigger-optional' ? ['perform'] : q.options.slice(0, q.minimum));
  assert.equal(g.snapshot().players[0].active.counters, 2);
});

test('triggerMatches: an event without its attacker matches no attacker filter; damageAtLeast is inclusive', async () => {
  const f = await fixture(), s = board(f).snapshot(), mon = s.players[0].active, foe = s.players[1].active;
  const source = { instanceId: mon.stack[0], owner: 0, category: 'ability', pokemonId: mon.id, attackId: null, effectId: 'test', sourceOfTruth: EVIDENCE };
  const attacker = { ...source, owner: 1, pokemonId: foe.id, category: 'attack' };
  const event = { id: 'event', kind: 'attackDamage', turn: s.turn, during: 1, endingPlayer: null, subjectId: mon.id, owner: 0, wasActive: true,
    origin: null, cardId: null, damage: 180, cause: { kind: 'attackDamage', source: attacker }, snapshot: mon, definitionId: 'base', effectiveTypes: ['Water'],
    attacker: { cardId: foe.stack[0], types: ['Water'] } };
  const context = { sourceActive: true, definition: f.catalog.definition('base'), definitionOf: (id) => f.catalog.definition(s.cards[id].definitionId) };
  const trigger = (extra) => ({ event: 'attackDamage', subject: 'self', optional: false, choiceOwner: 'source', scope: 'global', ...extra });
  const water = { kind: 'pokemon', types: ['Water'] };
  assert(triggerMatches(trigger({ attackerSelector: water, damageAtLeast: 180 }), event, source, context));
  assert(!triggerMatches(trigger({ attackerSelector: { kind: 'pokemon', types: ['Fire'] } }), event, source, context));
  assert(!triggerMatches(trigger({ damageAtLeast: 190 }), event, source, context));
  const { attacker: _attacker, ...bare } = event;
  assert(!triggerMatches(trigger({ attackerSelector: water }), bare, source, context));
  assert.throws(() => triggerMatches(trigger({}), { ...event, kind: 'turnEnd' }, source, context), /Invalid trigger/);
});

test('「受到…「180」点以上（包含180）的招式的伤害时」: the damage received, after Weakness', async () => {
  const bomb = { ...binding('cn.counters@1', { side: 'opponent', target: 'attacker', count: 10 }, 'bomb'),
    trigger: { event: 'attackDamage', subject: 'self', optional: false, choiceOwner: 'source', scope: 'global', cause: 'opponentAttackDamage',
      activeOnly: true, damageAtLeast: 180 } };
  for (const [value, counters] of [[90, 10], [80, 0]]) {
    const f = await fixture((defs) => {
      def(defs, 'tool').mechanics.effects = [bomb];
      Object.assign(def(defs, 'base').mechanics, { types: ['Fire'], hp: 200 });
      damage(defs, 'base', value);
      def(defs, 'other').mechanics.hp = 300;
    });
    const g = board(f, (s) => { strike(s); equip(s, 1, promote(s, 1, 'other')); });
    attack(g);
    const s = g.snapshot();
    assert.equal(s.players[1].active.counters, value * 2 / 10, 'Weakness ×2.');
    assert.equal(s.players[0].active.counters, counters, `${value * 2} damage`);
    restore(g, f);
  }
});

// 「在下一个自己的回合，受到这个招式影响的宝可梦，受到「连击」宝可梦的招式的伤害便会【昏厥】」.
const finish = { side: 'opponent', target: 'active', duration: 'nextOwnTurn', clearOnBench: true, clearOnEvolution: true,
  trigger: { event: 'attackDamage', subject: 'self', optional: false, choiceOwner: 'affected', scope: 'subject', cause: 'attackDamage',
    attackerSelector: { kind: 'pokemon', tagsAll: ['Rapid Strike'] } },
  program: [{ op: 'knockOut', side: 'opponent', target: 'event' }] };

test('「受到「连击」宝可梦的招式的伤害便会【昏厥】」: Knocked Out by the effect, or still by the damage that already did it', async () => {
  assert(handlers.get('cn.delayedReaction@1').validateParameters(clone(finish)));
  const make = (tags) => fixture((defs) => {
    const base = def(defs, 'base').mechanics;
    base.tags = tags;
    base.attacks.push({ attackId: 'base:finish', name: '测试终结', cost: ['Water'], printedDamage: null,
      effects: [binding('cn.delayedReaction@1', finish, 'finish')], sourceOfTruth: EVIDENCE });
  });
  for (const [tags, counters, cause] of [[['Rapid Strike'], 0, 'effect'], [['Rapid Strike'], 9, 'attackDamage'], [[], 0, null]]) {
    const f = await make(tags);
    const g = board(f, (s) => { strike(s); bench(s, 1, 'other'); s.players[1].active.counters = counters; });
    const target = g.snapshot().players[1].active.id;
    attack(g, 'base:finish');
    restore(g, f);
    command(g, { type: 'endTurn' }); settle(g);
    attack(g);
    const s = g.snapshot(), ko = s.battleHistory.events.filter((e) => e.kind === 'ko' && e.pokemonId === target);
    assert.deepEqual(ko.map((e) => e.cause.kind), cause ? [cause] : [], `${tags.join() || 'no tag'} / ${counters}`);
    if (!cause) assert.equal(s.players[1].active.counters, 2);
  }
});

// 「这只宝可梦，不会受到对手宝可梦的「200」及以上的招式的伤害」 / 「…伤害为「20、40、…260」的招式的伤害」.
const EVEN = [20, 40, 60, 80, 100, 120, 140, 160, 180, 200, 220, 240, 260];

test('protection schema and damage step: at least N, or exactly one of the listed values, at the final damage', () => {
  const valid = handlers.get('cn.protection@1').validateParameters;
  assert(valid(shield({ damageAtLeast: 200 }))); assert(valid(shield({ damageValues: EVEN })));
  for (const bad of [{ damageAtLeast: 200, coin: true }, { damageAtLeast: 200, damageAtMost: 60 }, { damageValues: EVEN, damageAtLeast: 200 },
    { damageValues: [] }, { damageValues: [20, 20] }, { damageValues: [25] }, { damageAtLeast: 200, channel: 'effects' },
    { damageAtLeast: 200, categories: ['attack', 'ability'] }]) assert(!valid(shield(bad)), JSON.stringify(bad));
  const packet = { ruleset: CN_V20261019, amount: 100, attackerTypes: ['Fire'], weakness: { type: 'Fire', operation: 'multiply', value: 2 } };
  const prevented = (p, extra = {}) => calculateAttackDamage({ ...packet, ...extra, preventions: [{ id: 'p', sourceOfTruth: EVIDENCE, ...p }] }).damage;
  assert.equal(prevented({ atLeast: 200 }), 0, 'Weakness first: 200.');
  assert.equal(prevented({ atLeast: 210 }), 200);
  assert.equal(prevented({ values: EVEN }), 0);
  assert.equal(prevented({ values: EVEN }, { amount: 70 }), 140 - 140);
  assert.equal(prevented({ values: [20, 40] }, { amount: 70 }), 140);
  assert.throws(() => prevented({ atLeast: 205 }), TypeError);
  assert.throws(() => prevented({ values: [20, 45] }), TypeError);
});

test('「「200」及以上」 and 「伤害为「20、40…」」 on the board: Weakness, the attacker\'s and the defender\'s effects come first', async () => {
  const shell = await fixture((defs) => {
    Object.assign(def(defs, 'other').mechanics, { hp: 300, abilities: [continuous('other:shell', [binding('cn.protection@1', shield({ damageAtLeast: 200 }), 'shell')])] });
    Object.assign(def(defs, 'base').mechanics, { types: ['Fire'] });
    damage(defs, 'base', 100);
  });
  for (const [stadium, counters] of [[false, 0], [true, 18]]) {
    const g = board(shell, (s) => { strike(s); promote(s, 1, 'other'); if (stadium) { s.stadium = hand(s, 1, 'stadium'); s.players[1].hand.pop(); } });
    attack(g);
    assert.equal(g.snapshot().players[1].active.counters, counters, stadium ? '200 - 20 = 180 is taken.' : '100 ×2 = 200 is prevented.');
    restore(g, shell);
  }
  for (const [value, tool, counters] of [[20, false, 0], [20, true, 5], [30, true, 0]]) {
    const f = await fixture((defs) => {
      def(defs, 'other').mechanics.abilities = [continuous('other:even', [binding('cn.protection@1', shield({ damageValues: EVEN }), 'even')])];
      damage(defs, 'base', value);
    });
    const g = board(f, (s) => { strike(s); promote(s, 1, 'other'); if (tool) equip(s, 0, s.players[0].active); });
    attack(g);
    assert.equal(g.snapshot().players[1].active.counters, counters, `${value}${tool ? ' + 30' : ''}`);
  }
});

// 「在下一个对手的回合，自己所有的「未来」宝可梦，不会受到「宝可梦ex」的招式的伤害。如果这只宝可梦离开战斗场的话，则这个效果消除」.
const code = { side: 'own', duration: 'nextOpponentTurn', clearOnLeaveActive: true, effect: { op: 'protection', channel: 'damage', useRule: 'ordinary',
  scope: 'own', from: 'opponent', categories: ['attack'], targetSelector: { kind: 'pokemon', tagsAll: ['Future'] },
  otherSelector: { kind: 'pokemon', tagsAll: ['ex'] } } };
const miraidon = () => fixture((defs) => {
  const base = def(defs, 'base').mechanics;
  base.tags = ['Future'];
  base.attacks.push({ attackId: 'base:code', name: '测试编码', cost: ['Water'], printedDamage: null,
    effects: [binding('cn.lastingPlayer@1', code, 'code')], sourceOfTruth: EVIDENCE });
  def(defs, 'other').mechanics.tags = ['ex'];
  def(defs, 'potion').mechanics.effects = [binding('cn.switch@1', { side: 'opponent', chooser: 'self', affected: 'selected' }, 'gust')];
});

test('「如果这只宝可梦离开战斗场的话，则这个效果消除」: schema and its user', async () => {
  const valid = handlers.get('cn.lastingPlayer@1').validateParameters;
  assert(valid(clone(code))); assert(!valid({ ...clone(code), clearOnLeaveActive: false }));
  const f = await fixture((defs) => { def(defs, 'research').mechanics.effects = [binding('cn.lastingPlayer@1', code, 'code')]; });
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'research'); });
  assert.throws(() => { command(g, { type: 'playTrainer', cardId: card }); settle(g); }, (e) => e.code === 'unsupported-leave-active');
});

test('「不会受到「宝可梦ex」的招式的伤害」 for every own 「未来」 Pokémon, until the user leaves the Active Spot', async () => {
  const f = await miraidon();
  for (const [attacker, gust, counters] of [['other', false, 0], ['base', false, 2], ['other', true, 2]]) {
    let card;
    const g = board(f, (s) => {
      strike(s); bench(s, 0, 'base');
      if (attacker === 'other') promote(s, 1, 'other');
      strike(s, 1); card = hand(s, 1, 'potion');
    });
    const user = g.snapshot().players[0].active.id;
    attack(g, 'base:code');
    assert.equal(g.snapshot().playerOngoing.length, 1);
    restore(g, f);
    const forged = clone(g.snapshot()), p = forged.players[0];
    [p.active, p.bench[0]] = [p.bench[0], p.active];
    assert.throws(() => OfficialGame.restore(forged, { catalog: f.catalog }), (e) => e.code === 'invalid-player-effect' && /leaves the Active Spot/.test(e.message));
    if (gust) {
      command(g, { type: 'playTrainer', cardId: card }); settle(g);
      const s = g.snapshot();
      assert.notEqual(s.players[0].active.id, user);
      assert.deepEqual(s.playerOngoing, [], 'Its user went to the Bench: the effect is gone.');
      assert(s.events.some((e) => e.ruleId === 'effects.duration.user-leaves-active' && e.data.pokemonId === user));
    }
    attack(g, `${attacker}:strike`);
    assert.equal(g.snapshot().players[0].active.counters, counters, `${attacker}${gust ? ' after the switch' : ''}`);
  }
});
