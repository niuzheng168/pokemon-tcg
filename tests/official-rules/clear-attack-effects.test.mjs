// Synthetic definitions only. 「这张卡牌的持有者，以及自己所有宝可梦身上招式的效果，全部消除。」 (effects.clear-attack-effects;
// II.C-03 lists Special Conditions and attack effects apart). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, assertSupportedDefinition } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { attackEffectsOn } from '../../public/rules/ongoing.js';
import { attackOptionId } from '../../public/rules/attack-copy.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { fixture, binding, EVIDENCE, board, command, settle, hand, bench, attached, fixtureClock } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();
const lasting = (side, target, effect, duration) => ({ side, target, effect, duration, clearOnBench: true, clearOnEvolution: true });
const noAttack = { op: 'restriction', scope: 'all', actions: ['attack'] };
const noRetreat = { op: 'restriction', scope: 'all', actions: ['retreat'] };
const itemLock = { side: 'opponent', effect: { op: 'playerRestriction', scope: 'all', actions: ['playItem'] }, duration: 'nextOpponentTurn' };
const sturdy = (defs) => { for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 500; d.mechanics.weakness = null; } };
const channeler = (defs) => { def(defs, 'research').mechanics.effects = [binding('cn.clearAttackEffects@1', {}, 'channel')]; };
const legal = (g, type) => g.view(g.snapshot().current).legalActions.filter((a) => a.type === type);
const playable = (g, card) => legal(g, 'playTrainer').some((a) => a.cardId === card);
// Player 1's Active is 「other」 with its own attack.
function opponentOther(s) {
  const p = s.players[1], old = p.active;
  p.hand.push(...old.stack); p.active = bench(s, 1, 'other'); p.bench.pop();
  attached(s, 1, p.active, 'water');
}

test('the rule cites II.C-03; the handler takes no parameters and is usable only while such an effect is there', () => {
  assert(requireRule(CN_V20261019, 'effects.clear-attack-effects').sourceOfTruth.some((s) => s.section.includes('II.C-03')));
  const h = handlers.get('cn.clearAttackEffects@1');
  assert(h.validateParameters({}));
  assert(!h.validateParameters({ side: 'own' }));
  assert.deepEqual(h.execute({}, {}), [{ op: 'clearAttackEffects' }]);
});

test('「全部消除」: own and the opponent\'s attack effects on the user and the user\'s Pokémon; not those on the opponent, not Special Conditions', async () => {
  const f = await fixture((defs) => {
    sturdy(defs); channeler(defs);
    // The user's own attack: 「在下一个自己的回合，这只宝可梦无法使用招式」.
    defs[0].mechanics.attacks[0].effects = [binding('cn.lasting@1', lasting('own', 'self', noAttack, 'nextOwnTurn'), 'rest')];
    // The opponent's attack: the Defending Pokémon cannot retreat, the player cannot play Items, it is Poisoned, and the
    // attacker itself cannot attack during its owner's next turn.
    defs[1].mechanics.attacks[0].effects = [binding('cn.lasting@1', lasting('opponent', 'active', noRetreat, 'nextOpponentTurn'), 'trap'),
      binding('cn.lastingPlayer@1', itemLock, 'lock'), binding('cn.condition@1', { side: 'opponent', condition: 'poisoned', poisonCounters: 1 }, 'poison'),
      binding('cn.lasting@1', lasting('own', 'self', noAttack, 'nextOwnTurn'), 'tired')];
  });
  let card, potion;
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water'); attached(s, 0, s.players[0].active, 'water'); bench(s, 0, 'other');
    opponentOther(s);
    card = hand(s, 0, 'research'); potion = hand(s, 0, 'potion');
  });
  assert(!playable(g, card), 'Nothing to remove yet.');
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  command(g, { type: 'attack', attackId: 'other:strike' }); settle(g);
  let s = g.snapshot();
  const mine = s.players[0].active.id, theirs = s.players[1].active.id;
  assert.equal(s.current, 0);
  assert.deepEqual([legal(g, 'attack').length, legal(g, 'retreat').length, playable(g, potion)], [0, 0, false]);
  assert.equal(s.ongoing.length, 3);
  assert.deepEqual(attackEffectsOn(s, 0).length, 3);
  assert(playable(g, card));
  const counters = s.players[0].active.counters;
  command(g, { type: 'playTrainer', cardId: card }); settle(g);
  s = g.snapshot();
  assert.deepEqual(s.ongoing.map((e) => e.targetId), [theirs], 'The opponent\'s own Pokémon keeps its attack effect.');
  assert.deepEqual(s.playerOngoing, []);
  assert.equal(s.players[0].active.id, mine);
  assert.notEqual(s.players[0].active.conditions.poison, null, 'A Special Condition is not an attack effect.');
  assert.deepEqual([s.players[0].active.counters > 0, s.players[0].active.counters], [true, counters], 'Damage counters stay.');
  assert(legal(g, 'attack').length > 0 && legal(g, 'retreat').length > 0 && playable(g, potion));
  const cleared = s.events.find((e) => e.ruleId === 'effects.clear-attack-effects');
  assert.deepEqual([cleared.data.player, cleared.data.effects.length], [0, 3]);
  restore(g, f);
});

test('player effects: the user\'s own boosts and the opponent\'s effects on the user\'s Pokémon go; the user\'s effects on the opponent stay', () => {
  const entry = (id, owner, category, effect, extra = {}) => ({ id, source: { owner, category }, effect, ...extra });
  const boost = (scope) => ({ op: 'modifier', field: 'attackDamage', amount: 30, scope });
  const state = {
    players: [{ active: { id: 'a0' }, bench: [{ id: 'b0' }] }, { active: { id: 'a1' }, bench: [] }],
    ongoing: [entry('on-a0', 1, 'attack', noRetreat, { targetId: 'a0' }), entry('on-b0', 0, 'ability', noAttack, { targetId: 'b0' }),
      entry('on-a1', 0, 'attack', noRetreat, { targetId: 'a1' })],
    playerOngoing: [entry('own-boost', 0, 'attack', boost('own'), { player: 0 }), entry('their-weaken', 1, 'attack', boost('opponent'), { player: 1 }),
      entry('my-weaken', 0, 'attack', boost('opponent'), { player: 0 }), entry('locked', 1, 'attack', itemLock.effect, { player: 0 }),
      entry('their-lock', 0, 'attack', itemLock.effect, { player: 1 }), entry('trainer-boost', 0, 'trainer', boost('own'), { player: 0 })],
  };
  assert.deepEqual(attackEffectsOn(state, 0), ['on-a0', 'own-boost', 'their-weaken', 'locked']);
  assert.deepEqual(attackEffectsOn(state, 1), ['on-a1', 'my-weaken', 'their-lock']);
  const ctx = (player) => ({ state, source: { owner: player } });
  assert(handlers.get('cn.clearAttackEffects@1').canUse(ctx(0), {}));
  assert(!handlers.get('cn.clearAttackEffects@1').canUse({ state: { ...state, ongoing: [], playerOngoing: [] }, source: { owner: 0 } }, {}));
});

test('an owned attack lock on the user\'s Pokémon is removed too, and its clearing is verified on restore', async () => {
  const seal = { op: 'disableOwnedAttack', side: 'opponent', target: 'active', duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true };
  const f = await fixture((defs) => {
    sturdy(defs); channeler(defs);
    defs[1].mechanics.attacks[0].effects = [binding('cn.disableOwnedAttack@1', seal, 'seal')];
  });
  let card;
  const g = board(f, (s) => {
    fixtureClock(s, [0, 1, 0, 1]);
    attached(s, 0, s.players[0].active, 'water'); opponentOther(s);
    card = hand(s, 0, 'research');
  });
  command(g, { type: 'attack', attackId: 'other:strike' });
  const s0 = g.snapshot();
  assert.equal(s0.pending.kind, 'owned-attack');
  settle(g, (q) => q.kind === 'owned-attack' ? [attackOptionId({ instanceId: s0.players[0].active.stack.at(-1), attackId: 'base:strike' })] : []);
  assert.equal(g.snapshot().current, 0);
  assert.equal(legal(g, 'attack').length, 0);
  command(g, { type: 'playTrainer', cardId: card }); settle(g);
  const s = g.snapshot();
  assert.deepEqual(s.ongoing, []);
  const clearing = s.events.findLast((e) => e.ruleId === 'attack.owned-lock' && e.data.kind === 'cleared');
  assert.deepEqual([clearing.data.reason, clearing.data.historyIndex], ['removed', null]);
  assert(legal(g, 'attack').length > 0);
  restore(g, f);
  // The clearing record must name the lock it removed.
  const tampered = clone(s);
  tampered.events.findLast((e) => e.ruleId === 'effects.clear-attack-effects').data.effects = [];
  assert.throws(() => OfficialGame.restore(tampered, { catalog: f.catalog }), (e) => e.code === 'invalid-owned-attack-lock');
  // Without the clearing record right after, the removal is not verified either.
  const missing = clone(s);
  missing.events = missing.events.filter((e) => e.ruleId !== 'effects.clear-attack-effects');
  assert.throws(() => OfficialGame.restore(missing, { catalog: f.catalog }), (e) => e.code === 'invalid-owned-attack-lock');
});

test('load: the Supporter\'s text compiles; nothing to remove means it cannot be played', async () => {
  const f = await fixture(channeler);
  assert.doesNotThrow(() => assertSupportedDefinition({ handler: (id) => handlers.get(id) }, f.catalog.definition('research')));
  let card;
  const g = board(f, (s) => { card = hand(s, 0, 'research'); });
  assert(!playable(g, card));
  assert.equal(EVIDENCE.length, 1);
});
