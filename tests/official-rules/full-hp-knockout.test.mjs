// Synthetic definitions only. 「这只宝可梦在HP为全满的状态下，受到对手宝可梦的招式的伤害而【昏厥】时，给使用了招式的宝可梦身上放置8个伤害指示物。」
// and the Tool 「身上放有这张卡牌的「宝可梦V」在HP为全满的状态下，受到对手宝可梦的招式的伤害而【昏厥】时，给使用了招式的宝可梦身上放置8个伤害指示物。」
// (trigger.full-hp-knockout, II.D-14 全满: no damage counters on it before that damage). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { validateTriggerDescriptor } from '../../public/rules/schema-validators.js';
import { requireRule } from '../../public/rules/registry.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { fixture, binding, EVIDENCE, board, command, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
const TRIGGER = { event: 'knockout', subject: 'self', optional: false, choiceOwner: 'source', scope: 'global', cause: 'opponentAttackDamage', fromFullHp: true };
const curse = () => binding('cn.counters@1', { side: 'opponent', target: 'attacker', count: 8 }, 'curse');
// Player 0's 「测试宝可梦base」 attacks player 1's Active 「测试宝可梦other」 (HP 100) for `damage`, after `extra` effects of the attack.
async function make({ damage = 100, trigger = TRIGGER, extra = [], tool = false } = {}) {
  return fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) d.mechanics.weakness = null;
    def(defs, 'base').mechanics.attacks[0].printedDamage = damage === null ? null : { value: damage, operator: 'fixed' };
    def(defs, 'base').mechanics.attacks[0].effects = extra;
    if (tool) def(defs, 'tool').mechanics.effects = [{ ...curse(), trigger: { ...trigger,
      subjectSelector: { kind: 'pokemon', nameKeys: ['other'] } } }];
    else def(defs, 'other').mechanics.abilities = [{ abilityId: 'other:curse', name: '测试怨恨符咒', mode: 'triggered', usage: null,
      trigger, effects: [curse()], sourceOfTruth: EVIDENCE }];
  });
}
function play(f, mutate = () => {}) {
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water');
    const m = bench(s, 1, 'other'), p = s.players[1];
    p.bench = [p.active]; p.active = m;
    mutate(s, m);
  });
  command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
  restore(g, f);
  return g.snapshot();
}
const attackerCounters = (s) => s.players[0].active.counters;
const knockedOut = (s, id) => s.battleHistory.events.some((e) => e.kind === 'ko' && e.pokemonId === id);

test('schema and rule: fromFullHp is a Knock Out trigger filter', () => {
  assert(requireRule(CN_V20261019, 'trigger.full-hp-knockout').sourceOfTruth.some((s) => s.section === 'II.D-14'));
  assert(validateTriggerDescriptor(TRIGGER));
  assert(!validateTriggerDescriptor({ ...TRIGGER, fromFullHp: false }));
  assert(!validateTriggerDescriptor({ ...TRIGGER, event: 'attackDamage' }));
});

test('「在HP为全满的状态下，受到对手宝可梦的招式的伤害而【昏厥】时」: 8 counters on the attacking Pokémon', async () => {
  const f = await make();
  let id;
  const s = play(f, (_s, m) => { id = m.id; });
  assert(knockedOut(s, id));
  assert.equal(attackerCounters(s), 8);
});

test('not at full HP before that damage, or Knocked Out by something other than the attack damage: nothing', async () => {
  const f = await make();
  let id;
  const damaged = play(f, (_s, m) => { m.counters = 1; id = m.id; });
  assert(knockedOut(damaged, id), 'Knocked Out by the attack, but it was not at full HP.');
  assert.equal(attackerCounters(damaged), 0);
  // Damage that is not lethal from full HP, then the attack's counters Knock it Out: the Knock Out is the effect's.
  const effect = await make({ damage: 50, trigger: { ...TRIGGER, cause: 'any' },
    extra: [binding('cn.counters@1', { side: 'opponent', target: 'active', count: 5 }, 'finish')] });
  const s = play(effect, (_s, m) => { id = m.id; });
  assert(knockedOut(s, id));
  assert.equal(attackerCounters(s), 0);
  // Counters alone from full HP (no attack damage at all) never satisfy it either.
  const counters = await make({ damage: null, trigger: { ...TRIGGER, cause: 'any' },
    extra: [binding('cn.counters@1', { side: 'opponent', target: 'active', count: 10 }, 'counters')] });
  assert.equal(attackerCounters(play(counters)), 0);
});

test('the Tool 「身上放有这张卡牌的…」 reads its holder the same way', async () => {
  const f = await make({ tool: true });
  const full = play(f, (s, m) => { const card = hand(s, 1, 'tool'); s.players[1].hand.pop(); m.tools.push(card); });
  assert.equal(attackerCounters(full), 8);
  const damaged = play(f, (s, m) => { const card = hand(s, 1, 'tool'); s.players[1].hand.pop(); m.tools.push(card); m.counters = 2; });
  assert.equal(attackerCounters(damaged), 0);
});
