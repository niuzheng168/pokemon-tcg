import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { hadKnockoutInPreviousOpponentTurn, wasMovedFromBenchToActiveThisTurn,
  wasSupporterPlayedFromHandThisTurn, wasHealedThisTurn } from '../../public/rules/battle-history.js';
import { fixture, binding, EVIDENCE, board, command, settle, hand, bench, attached } from './fixtures.mjs';

// SYNTHETIC reviewed card handlers demonstrate that real attack arithmetic uses
// the observed ledger, not client flags, a current discard pile or printed text.
async function historyCard(kind, cause = 'any', transform = () => {}) {
  const observed = [];
  const h = { rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE, timing: 'formula',
    operations: [], capabilities: ['resolve-attack-damage'],
    validateParameters: (p) => Object.keys(p).length === 2 && p.kind === kind && p.cause === cause,
    execute: () => [],
    damageFormula: (ctx, p) => {
      const clock = { turn: ctx.state.turn, during: ctx.state.current }, owner = ctx.source.owner;
      assert(Object.isFrozen(ctx.state.battleHistory));
      const passed = p.kind === 'previousKO' ?
        hadKnockoutInPreviousOpponentTurn(ctx.state.battleHistory, clock, { owner, cause: p.cause }) :
        p.kind === 'moved' ? wasMovedFromBenchToActiveThisTurn(ctx.state.battleHistory, clock, owner, ctx.source.pokemonId) :
        p.kind === 'supporter' ? wasSupporterPlayedFromHandThisTurn(ctx.state.battleHistory, clock, owner) :
        wasHealedThisTurn(ctx.state.battleHistory, clock, owner, ctx.source.pokemonId);
      observed.push({ passed, pokemonId: ctx.source.pokemonId, owner });
      return 20 + (passed ? 90 : 0);
    } };
  const f = await fixture((ds) => {
    const m = ds[1].mechanics; m.hp = 300;
    m.attacks[0].printedDamage.operator = 'plus';
    m.attacks[0].effects = [binding('fixture:history-bonus', { kind, cause })];
    transform(ds);
  }, new Map([['fixture:history-bonus', h]]));
  return { ...f, observed };
}
function replaceActive(s, owner, definitionId) {
  const p = s.players[owner], old = p.active;
  p.hand.push(...old.stack, ...old.energy, ...old.tools);
  p.active = bench(s, owner, definitionId); p.bench.pop();
  return p.active;
}
const end = (g) => { command(g, { type: 'endTurn' }); settle(g); };
const strike = (g) => { command(g, { type: 'attack', attackId: 'other:strike' }); settle(g); };

test('E-11 conditional attack damage uses the actual previous opposing turn and requested KO cause', async () => {
  for (const cause of ['any', 'attackDamage']) for (const scenario of ['attackDamage', 'effect', 'checkup']) {
    const f = await historyCard('previousKO', cause, (ds) => {
      if (scenario === 'effect') {
        ds[0].mechanics.attacks[0].printedDamage = null;
        ds[0].mechanics.attacks[0].effects = [binding('cn.counters@1', { side: 'opponent', target: 'active', count: 2 })];
      }
      ds.find((d) => d.definitionId === 'poison').mechanics.effects[0].parameters.poisonCounters = 2;
    });
    let actor;
    const g = board(f, (s) => {
      actor = bench(s, 0, 'other'); attached(s, 0, actor, 'water');
      s.players[0].active.counters = 8;
      attached(s, 1, s.players[1].active, 'water');
      bench(s, 1, 'other');
      const hpTool = hand(s, 1, 'hp-tool'); s.players[1].hand.pop(); s.players[1].active.tools.push(hpTool);
      if (scenario === 'checkup') hand(s, 1, 'poison');
    });
    end(g); // Actual opposing turn 6.
    if (scenario !== 'checkup') {
      command(g, { type: 'attack', attackId: 'base:strike' }); settle(g);
    } else {
      const poison = g.view(1).legalActions.find((a) => a.type === 'playTrainer' && g.snapshot().cards[a.cardId].definitionId === 'poison');
      command(g, poison); settle(g); end(g);
    }
    assert.equal(g.snapshot().current, 0); assert.equal(g.snapshot().turn, 7);
    const expected = scenario === 'attackDamage' || scenario === 'effect' && cause === 'any';
    strike(g);
    assert.equal(g.snapshot().players[1].active.counters, expected ? 11 : 2);
    assert.deepEqual(f.observed, [{ passed: expected, pokemonId: actor.id, owner: 0 }]);
    assert.deepEqual(OfficialGame.restore(g.snapshot(), { catalog: f.catalog }).snapshot(), g.snapshot());
  }
});

test('E-24/25/26 conditional attack handlers consume real actions, not mutable card definitions or usage flags', async () => {
  for (const kind of ['moved', 'supporter', 'healed']) for (const performed of [false, true]) {
    const f = await historyCard(kind); let actor, supporter, potion;
    const g = board(f, (s) => {
      actor = kind === 'moved' && performed ? bench(s, 0, 'other') : replaceActive(s, 0, 'other');
      attached(s, 0, actor, 'water');
      replaceActive(s, 1, 'other');
      if (kind === 'moved' && performed) attached(s, 0, s.players[0].active, 'double');
      if (kind === 'supporter') {
        supporter = hand(s, 0, 'research');
        if (!performed) {
          s.players[0].hand.splice(s.players[0].hand.indexOf(supporter), 1);
          s.players[0].discard.push(supporter); s.players[0].flags.supporter = true;
        }
      }
      if (kind === 'healed') { actor.counters = 2; potion = hand(s, 0, 'potion'); }
    });
    if (kind === 'moved') {
      if (performed) { command(g, { type: 'retreat' }); settle(g); }
    } else if (performed) {
      command(g, { type: 'playTrainer', cardId: kind === 'supporter' ? supporter : potion }); settle(g);
    }
    const definition = structuredClone(f.catalog.definition('other'));
    strike(g);
    assert.equal(g.snapshot().players[1].active.counters, performed ? 11 : 2);
    assert.deepEqual(f.observed, [{ passed: performed, pokemonId: actor.id, owner: 0 }]);
    assert.deepEqual(f.catalog.definition('other'), definition);
  }
});
