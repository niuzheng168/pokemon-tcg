// Synthetic definitions only. 「在上一个对手的回合，如果对手的宝可梦使用了招式（除GX招式外）的话，则将该招式作为这个招式使用。」
// (attack.copy-previous: the attacks the opponent's Pokémon actually used during the latest opponent turn — the declared attack, a Tool's
// attack included; the user picks one of two; no Energy needed — JP Q&A ミミッキュ「まねっこ」). No actual card is approved here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { copyCandidates } from '../../public/rules/attack-copy.js';
import { requireRule } from '../../public/rules/registry.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { createBattleHistory, recordBattleTurn, recordBattleEvent, attacksInPreviousOpponentTurn } from '../../public/rules/battle-history.js';
import { fixture, binding, EVIDENCE, board, command, settle, answer, bench, attached, hand } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const handlers = createCoreHandlers();
const PREVIOUS = { side: 'opponent', zone: 'previousTurn', selector: { kind: 'pokemon' } };
const copycat = (extra = {}) => ({ op: 'copyAttack', origins: [PREVIOUS], excludeUser: false, coin: 'none', energy: 'ignore',
  excludeSpecialRules: ['GX'], special: { mode: 'consumeUserQuota', sourceOfTruth: EVIDENCE }, ...extra });
const attack = (attackId, damage, extra = {}) => ({ attackId, name: `测试${attackId}`, cost: ['Water'],
  printedDamage: damage === null ? null : { value: damage, operator: 'fixed' }, effects: [], sourceOfTruth: EVIDENCE, ...extra });
async function make() {
  return fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 500; d.mechanics.weakness = null; }
    def(defs, 'base').mechanics.attacks.push(attack('base:copycat', null, { effects: [binding('cn.copyAttack@1', copycat(), 'copycat')] }));
    def(defs, 'other').mechanics.attacks.push(attack('other:gx', 100, { specialRule: 'GX' }),
      attack('other:big', 60, { cost: ['Water', 'Water', 'Water'] }),
      // 「选择对手战斗宝可梦所拥有的1个招式，作为这个招式使用」: itself a copying attack.
      attack('other:mimic', null, { effects: [binding('cn.copyAttack@1', { op: 'copyAttack', excludeUser: false, coin: 'none', energy: 'ignore',
        origins: [{ side: 'opponent', zone: 'active', selector: { kind: 'pokemon' } }], special: { mode: 'consumeUserQuota', sourceOfTruth: EVIDENCE } }, 'mimic')] }));
    def(defs, 'tool').mechanics.effects = [];
    def(defs, 'tool').mechanics.grantedAttacks = [attack('tool:blast', 40)];
  });
}
const restore = (g, f) => {
  const r = OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), g.snapshot());
  return r;
};
// Player 1's Active is 「测试宝可梦other」 with three Water Energy (and a Tool with an attack); player 0's Active has one Water Energy.
function setup(f, mutate = () => {}) {
  return board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water');
    const p = s.players[1];
    p.hand.push(...p.active.stack); p.active = bench(s, 1, 'other'); p.bench.pop();
    for (let i = 0; i < 3; i++) attached(s, 1, p.active, 'water');
    const tool = hand(s, 1, 'tool'); p.hand.pop(); p.active.tools.push(tool);
    mutate(s);
  });
}
// The copy prompt's options by attackId, or null when there is none.
const offered = (g) => g.snapshot().pending?.kind === 'copy-attack' ? g.view(0).pending.attacks.map((a) => a.attackId) : null;
const choose = (g, attackId) => answer(g, [g.view(g.snapshot().pending.player).pending.attacks.find((a) => a.attackId === attackId).optionId]);
const dealt = (g, from) => g.snapshot().events.slice(from).filter((e) => e.ruleId === 'attack.order' && Object.hasOwn(e.data, 'damage'))
  .reduce((n, e) => n + e.data.damage, 0);
// Player 0 ends turn 5, player 1 uses `theirs` (or just ends turn 6); player 0 then uses 「仿效」 in turn 7.
function afterTheirs(f, theirs) {
  const g = setup(f);
  command(g, { type: 'endTurn' }); settle(g);
  command(g, theirs ? { type: 'attack', attackId: theirs } : { type: 'endTurn' }, 1); settle(g);
  const r = restore(g, f), from = r.snapshot().events.length;
  command(r, { type: 'attack', attackId: 'base:copycat' });
  return { g: r, from };
}

test('schema, rule and the pure ledger: the attacks used, with their printed content', () => {
  assert(requireRule(CN_V20261019, 'attack.copy-previous').sourceOfTruth.some((s) => s.section === 'II.C-18'));
  const valid = (p) => handlers.get('cn.copyAttack@1').validateParameters(clone(p));
  assert(valid(copycat()));
  assert(!valid(copycat({ origins: [{ ...PREVIOUS, side: 'own' }] })), 'Only the opponent\'s previous turn.');
  const grant = (origin) => handlers.get('cn.attackGrant@1').validateParameters({ op: 'attackGrant', scope: 'self', targetSelector: { kind: 'pokemon' },
    origins: [origin], excludeUser: false });
  assert(grant({ side: 'own', zone: 'evolution', subject: 'user', selector: { kind: 'pokemon' } }));
  assert(!grant(PREVIOUS), 'A permission is over attacks owned now.');
  let h = recordBattleTurn(createBattleHistory(), { turn: 1, player: 1 });
  const used = { kind: 'attackUsed', turn: 1, during: 1, owner: 1, pokemonId: 'm1', cardId: 'c1', attackName: 'X' };
  for (const reference of [{ instanceId: 'c1' }, { instanceId: '', attackId: 'a' }, { instanceId: 'c1', attackId: 'a', extra: 1 }])
    assert.throws(() => recordBattleEvent(h, { ...used, reference }, { turn: 1, during: 1 }), (e) => e.code === 'invalid-history-event');
  h = recordBattleEvent(h, { ...used, reference: { instanceId: 'c1', attackId: 'a' } }, { turn: 1, during: 1 });
  h = recordBattleTurn(h, { turn: 2, player: 0 });
  assert.deepEqual(attacksInPreviousOpponentTurn(h, { turn: 2, during: 0 }, 0).map((e) => e.reference), [{ instanceId: 'c1', attackId: 'a' }]);
  assert.deepEqual(attacksInPreviousOpponentTurn(h, { turn: 2, during: 0 }, 1), []);
});

test('「将该招式作为这个招式使用」: the attack used last turn, without its Energy', async () => {
  const f = await make();
  const strike = afterTheirs(f, 'other:strike');
  assert.deepEqual(offered(strike.g), ['other:strike']);
  choose(strike.g, 'other:strike'); settle(strike.g);
  assert.equal(dealt(strike.g, strike.from), 20);
  restore(strike.g, f);
  // JP Q&A: Energy for the copied attack is not needed (player 0 has one Water Energy).
  const big = afterTheirs(f, 'other:big');
  choose(big.g, 'other:big'); settle(big.g);
  assert.equal(dealt(big.g, big.from), 60);
  // JP Q&A パワーメモリ／れんげきの巻物: a Tool's attack that was used is copied too.
  const tool = afterTheirs(f, 'tool:blast');
  assert.deepEqual(offered(tool.g), ['tool:blast']);
  choose(tool.g, 'tool:blast'); settle(tool.g);
  assert.equal(dealt(tool.g, tool.from), 40);
});

test('「（除GX招式外）」, no attack last turn, and only the latest opponent turn', async () => {
  const f = await make();
  for (const theirs of ['other:gx', null]) {
    const { g, from } = afterTheirs(f, theirs);
    assert.equal(offered(g), null, String(theirs)); settle(g);
    assert.equal(dealt(g, from), 0);
    assert.equal(g.snapshot().current, 1, 'The attack ended without doing anything.');
  }
  const g = setup(f);
  command(g, { type: 'endTurn' }); settle(g);
  command(g, { type: 'attack', attackId: 'other:strike' }, 1); settle(g);
  command(g, { type: 'endTurn' }); settle(g); command(g, { type: 'endTurn' }, 1); settle(g);
  command(g, { type: 'attack', attackId: 'base:copycat' });
  assert.equal(offered(g), null, 'Turn 6\'s attack is not from the latest opponent turn (turn 8).');
});

test('JP Q&A おもいだす／イカサマ: a copying attack that was used is copied as itself, then chooses again', async () => {
  const f = await make();
  const { g, from } = afterTheirs(f, 'other:mimic');
  assert.deepEqual(offered(g), ['other:mimic'], 'Not the attack it copied.');
  choose(g, 'other:mimic');
  assert.deepEqual(offered(g).sort(), ['other:big', 'other:mimic', 'other:strike', 'other:gx'].sort(),
    'As this attack, it chooses among the opponent\'s Active Pokémon\'s attacks.');
  choose(g, 'other:strike'); settle(g);
  assert.equal(dealt(g, from), 20);
});

test('two attacks last turn: the user chooses one; a recorded attack keeps its printed content', async () => {
  const f = await make();
  const used = (s, attackId, reference) => ({ kind: 'attackUsed', turn: 4, during: 1, owner: 1, pokemonId: s.players[1].active.id,
    cardId: s.players[1].active.stack[0], attackName: f.catalog.definition('other').mechanics.attacks.find((a) => a.attackId === attackId).name, reference });
  const g = setup(f, (s) => {
    const card = s.players[1].active.stack[0];
    s.battleHistory.events.push(used(s, 'other:strike', { instanceId: card, attackId: 'other:strike' }),
      used(s, 'other:big', { instanceId: card, attackId: 'other:big' }));
  });
  command(g, { type: 'attack', attackId: 'base:copycat' });
  assert.deepEqual(offered(g), ['other:strike', 'other:big']);
  const from = g.snapshot().events.length;
  choose(g, 'other:big'); settle(g);
  assert.equal(dealt(g, from), 60);
  const s = setup(f).snapshot();
  for (const reference of [undefined, { instanceId: s.players[1].active.stack[0], attackId: 'other:gx' }]) {
    const bad = clone(s), event = used(bad, 'other:strike', reference);
    if (!reference) delete event.reference;
    bad.battleHistory.events.push(event);
    assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }), (e) => e.code === 'invalid-history-source');
  }
  // The pure candidate list reads the same record: selector by the user's top card then, and the printed attackIds filter.
  const ctx = (state) => ({ source: { owner: 0, pokemonId: state.players[0].active.id }, definitions: f.catalog.definitionRecord(), state });
  const card = s.players[1].active.stack[0], recorded = clone(s);
  recorded.battleHistory.events.push(used(recorded, 'other:strike', { instanceId: card, attackId: 'other:strike' }));
  assert.equal(copyCandidates(ctx(recorded), copycat()).length, 1);
  assert.deepEqual(copyCandidates(ctx(recorded), copycat({ origins: [{ ...PREVIOUS, selector: { kind: 'pokemon', nameKeys: ['base'] } }] })), []);
  assert.deepEqual(copyCandidates(ctx(recorded), copycat({ attackIds: ['other:big'] })), []);
});

test('copying the same previous-turn attack inside its own copy has no ruling and is refused', async () => {
  const f = await make();
  // Player 1's 「仿效」 was used in turn 4; player 0's 「仿效」 copies it, and as this attack it would copy itself again.
  const g = setup(f, (s) => {
    const p = s.players[1], m = bench(s, 1, 'base');
    p.bench = [p.active]; p.active = m; attached(s, 1, m, 'water');
    s.battleHistory.events.push({ kind: 'attackUsed', turn: 4, during: 1, owner: 1, pokemonId: m.id, cardId: m.stack[0],
      attackName: '测试base:copycat', reference: { instanceId: m.stack[0], attackId: 'base:copycat' } });
  });
  command(g, { type: 'attack', attackId: 'base:copycat' });
  choose(g, 'base:copycat');
  assert.deepEqual(offered(g), ['base:copycat']);
  const before = g.snapshot();
  assert.throws(() => choose(g, 'base:copycat'), (e) => e.code === 'unresolved-copy-loop');
  assert.deepEqual(g.snapshot(), before);
});
