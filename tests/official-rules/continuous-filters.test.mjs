// Synthetic definitions only. Printed filters and conditions of continuous effects (II.A): the affected Pokémon, the
// other Pokémon of an attack, named attacks, and 「如果…的话」 conditions read from the effect's source. No card is approved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, assertSupportedDefinition } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { matchesCardSelector } from '../../public/rules/card-selection.js';
import { fixture, binding, EVIDENCE, board, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const lit = (value) => ({ kind: 'literal', value });
const cmp = (left, relation, right) => ({ kind: 'compare', left, relation, right });
const handlers = createCoreHandlers();
const valid = (id, parameters) => handlers.get(id).validateParameters(JSON.parse(JSON.stringify(parameters)));
const stage1 = { kind: 'pokemon', stages: ['stage1'] };
const ownStadium = { kind: 'stadiumInPlay', owner: 'own' };
const def = (defs, id) => defs.find((d) => d.definitionId === id);
const continuousAbility = (key, effects) => ({ abilityId: `fixture:${key}`, name: `测试${key}`, mode: 'continuous', usage: null,
  effects, sourceOfTruth: EVIDENCE });
function hold(s, owner, mon, name) { const id = hand(s, owner, name); s.players[owner].hand.pop(); mon.tools.push(id); return id; }
function putStadium(s, owner) { const id = hand(s, owner, 'stadium'); s.players[owner].hand.pop(); s.stadium = id; }
function swapActive(s, owner, id) { const p = s.players[owner]; p.hand.push(...p.active.stack); p.active = bench(s, owner, id); p.bench.pop(); return p.active; }
async function make(transform) {
  return fixture((defs) => {
    for (const d of defs.filter((d) => d.kind === 'pokemon')) { d.mechanics.hp = 500; d.mechanics.weakness = null; d.mechanics.resistance = null; }
    transform(defs);
  });
}
// Attack damage dealt by player 0's Active using the given attack.
function dealt(f, mutate, attackId = 'base:strike') {
  const g = board(f, (s) => { mutate(s); attached(s, 0, s.players[0].active, 'water'); });
  const from = g.snapshot().events.length;
  command(g, { type: 'attack', attackId }); settle(g);
  OfficialGame.restore(clone(g.snapshot()), { catalog: f.catalog });
  return g.snapshot().events.slice(from).filter((e) => e.ruleId === 'attack.order' && Object.hasOwn(e.data, 'damage'))
    .reduce((n, e) => n + e.data.damage, 0);
}

test('schemas: filters belong to their effects; damage-only other filters; no condition on a timed effect', () => {
  const mod = (extra) => ({ field: 'attackDamage', amount: 30, scope: 'self', ...extra });
  for (const p of [mod({ otherSelector: { kind: 'pokemon', tagsAll: ['ex'] }, attackIds: ['x:a1'], condition: ownStadium }),
    { field: 'hp', amount: 50, scope: 'own', targetSelector: { kind: 'pokemon', nameContains: '阿响的' }, targetState: { damaged: true } },
    { field: 'defenseDamage', amount: -30, scope: 'self', otherState: { hasAbility: true } }])
    assert(valid('cn.modifier@1', p), JSON.stringify(p));
  for (const p of [{ field: 'hp', amount: 10, scope: 'self', otherSelector: stage1 }, { field: 'defenseDamage', amount: -10, scope: 'self', attackIds: ['a'] },
    { field: 'hp', amount: 10, scope: 'self', targetSelector: { kind: 'energy' } }, mod({ condition: { kind: 'nope' } }), mod({ targetState: {} })])
    assert(!valid('cn.modifier@1', p), JSON.stringify(p));
  const shield = (categories) => ({ effect: { op: 'protection', channel: 'damage', scope: 'self', from: 'opponent', categories,
    useRule: 'ordinary', otherSelector: { kind: 'pokemon', stages: ['basic'] } } });
  assert(valid('cn.protection@1', shield(['attack']))); assert(!valid('cn.protection@1', shield(['attack', 'ability'])));
  const lock = (extra) => ({ side: 'opponent', target: 'active', duration: 'nextOpponentTurn', clearOnBench: true, clearOnEvolution: true,
    effect: { op: 'restriction', scope: 'all', actions: ['attack'], targetSelector: { kind: 'pokemon', stages: ['basic'] }, ...extra } });
  assert(valid('cn.lasting@1', lock({}))); assert(!valid('cn.lasting@1', lock({ condition: ownStadium })));
  assert(!valid('cn.lastingPlayer@1', { side: 'opponent', duration: 'nextOpponentTurn',
    effect: { op: 'playerRestriction', scope: 'all', actions: ['playItem'], condition: ownStadium } }));
  assert(valid('cn.playerRestriction@1', { effect: { op: 'playerRestriction', scope: 'opponent', actions: ['playItem'], condition: ownStadium } }));
  assert(valid('cn.energyRequirement@1', { effect: { op: 'energyRequirement', action: 'retreat', mode: 'erase', scope: 'self',
    targetState: { hasTool: true }, condition: ownStadium } }));
});

test('affected-Pokémon filters: a name fragment and a current state', async () => {
  const f = await make((defs) => { def(defs, 'stadium').mechanics.effects = [binding('cn.modifier@1', { field: 'hp', amount: 50, scope: 'all',
    targetSelector: { kind: 'pokemon', nameContains: '进化' } }, 'named'), binding('cn.modifier@1', { field: 'hp', amount: 10, scope: 'all',
    targetState: { damaged: true } }, 'damaged')]; });
  let evolved;
  const g = board(f, (s) => { evolved = bench(s, 0, 'evolution'); s.players[0].active.counters = 1; bench(s, 0, 'other'); putStadium(s, 1); });
  const p = g.view(0).players[0];
  assert.deepEqual([p.active.effective.maxHp, ...p.bench.map((m) => m.effective.maxHp)], [510, 550, 500]);
  assert.equal(p.bench[0].id, evolved.id);
  assert.equal(matchesCardSelector(def(f.definitions, 'evolution'), { kind: 'pokemon', nameContains: '进化' }), true);
  assert.equal(matchesCardSelector(def(f.definitions, 'base'), { kind: 'pokemon', nameContains: '进化' }), false);
});

test('the other Pokémon of an attack: the damaged one for the attacker, the attacker for the defender; named attacks', async () => {
  const boost = (extra) => (defs) => { def(defs, 'tool').mechanics.effects = [binding('cn.modifier@1',
    { field: 'attackDamage', amount: 30, scope: 'self', ...extra }, 'boost')]; };
  const vsStage1 = await make(boost({ otherSelector: stage1 }));
  assert.equal(dealt(vsStage1, (s) => { hold(s, 0, s.players[0].active, 'tool'); }), 20);
  assert.equal(dealt(vsStage1, (s) => { hold(s, 0, s.players[0].active, 'tool'); swapActive(s, 1, 'evolution'); }), 50);
  for (const [attackIds, expected] of [[['base:strike'], 50], [['base:other-attack'], 20]])
    assert.equal(dealt(await make(boost({ attackIds })), (s) => { hold(s, 0, s.players[0].active, 'tool'); }), expected);
  const guard = await make((defs) => { def(defs, 'hp-tool').mechanics.effects = [binding('cn.modifier@1',
    { field: 'defenseDamage', amount: -10, scope: 'self', otherState: { damaged: true } }, 'guard')]; });
  assert.equal(dealt(guard, (s) => { hold(s, 1, s.players[1].active, 'hp-tool'); }), 20);
  assert.equal(dealt(guard, (s) => { hold(s, 1, s.players[1].active, 'hp-tool'); s.players[0].active.counters = 1; }), 10);
});

test('protection against attacks of a kind of Pokémon reads the attacking Pokémon', async () => {
  const f = await make((defs) => { def(defs, 'other').mechanics.abilities = [continuousAbility('shield', [binding('cn.protection@1', {
    effect: { op: 'protection', channel: 'damage', scope: 'self', from: 'opponent', categories: ['attack'], useRule: 'ordinary',
      otherSelector: stage1 } }, 'shield')])]; });
  const shielded = (s) => { swapActive(s, 1, 'other'); };
  assert.equal(dealt(f, shielded), 20);
  assert.equal(dealt(f, (s) => { shielded(s); swapActive(s, 0, 'evolution'); }, 'evolution:strike'), 0);
});

test('conditions: own Stadium in play; a named Tool on this Pokémon; every listed filter and condition must hold', async () => {
  const f = await make((defs) => {
    def(defs, 'base').mechanics.abilities = [continuousAbility('light', [binding('cn.energyRequirement@1', {
      effect: { op: 'energyRequirement', action: 'retreat', mode: 'erase', scope: 'self', condition: ownStadium } }, 'light'),
      binding('cn.modifier@1', { field: 'hp', amount: 100, scope: 'self', condition: cmp({ kind: 'pokemonSum', who: 'self', field: 'tools',
        tool: { kind: 'trainer', nameKeys: ['tool'] } }, 'gt', lit(0)) }, 'scarf')])];
    def(defs, 'stadium').mechanics.effects = [binding('cn.modifier@1', { field: 'hp', amount: 10, scope: 'all', targetSelector: stage1 }, 'quiet')];
  });
  const view = (mutate) => board(f, mutate).view(0).players[0].active.effective;
  assert.equal(view(() => {}).retreatCost, 1);
  assert.equal(view((s) => putStadium(s, 0)).retreatCost, 0);
  assert.equal(view((s) => putStadium(s, 1)).retreatCost, 1, 'The opponent\'s Stadium is not this player\'s.');
  assert.equal(view((s) => hold(s, 0, s.players[0].active, 'tool')).maxHp, 600);
  assert.equal(view((s) => hold(s, 0, s.players[0].active, 'hp-tool')).maxHp, 550, 'Another Tool: only its own +50.');
});

test('a condition on an absent Active reads false and 0 (between a Knock Out and the promotion)', async () => {
  const damagedFoe = { kind: 'any', conditions: [{ kind: 'pokemonIs', who: 'opponentActive', state: { damaged: true } },
    cmp({ kind: 'pokemonSum', who: 'opponentActive', field: 'damageCounters' }, 'gt', lit(0))] };
  const f = await make((defs) => { def(defs, 'base').mechanics.abilities = [continuousAbility('watch', [binding('cn.modifier@1',
    { field: 'hp', amount: 10, scope: 'self', condition: damagedFoe }, 'watch')])]; });
  const g = board(f, (s) => { s.players[1].active.counters = 49; bench(s, 1, 'other'); attached(s, 0, s.players[0].active, 'water'); });
  assert.equal(g.view(0).players[0].active.effective.maxHp, 510);
  command(g, { type: 'attack', attackId: 'base:strike' });
  while (g.snapshot().pending && g.snapshot().pending.kind !== 'promote') answer(g, g.snapshot().pending.options.slice(0, g.snapshot().pending.minimum));
  assert.equal(g.snapshot().players[1].active, null);
  assert.equal(g.view(0).players[0].active.effective.maxHp, 500);
  settle(g);
});

test('a lock on the affected Pokémon filters by its kind; a load guard limits conditions to answerable facts', async () => {
  const f = await make((defs) => { def(defs, 'stadium').mechanics.effects = [binding('cn.restriction@1', {
    effect: { op: 'restriction', scope: 'all', actions: ['retreat'], targetSelector: { kind: 'pokemon', stages: ['basic'] } } }, 'lock')]; });
  const canRetreat = (mutate) => board(f, (s) => { mutate(s); bench(s, 0, 'other'); attached(s, 0, s.players[0].active, 'water'); putStadium(s, 1); })
    .view(0).legalActions.some((a) => a.type === 'retreat');
  assert.equal(canRetreat(() => {}), false);
  assert.equal(canRetreat((s) => swapActive(s, 0, 'evolution')), true);
  const catalog = { handler: (id) => handlers.get(id) };
  const stadiumWith = (condition) => { const d = clone(def(f.definitions, 'stadium')); d.mechanics.effects = [binding('cn.modifier@1',
    { field: 'hp', amount: 10, scope: 'all', condition }, 'c')]; return d; };
  const abilityWith = (condition) => { const d = clone(def(f.definitions, 'other')); d.mechanics.abilities = [continuousAbility('c',
    [binding('cn.modifier@1', { field: 'hp', amount: 10, scope: 'self', condition }, 'c')])]; return d; };
  const toolWith = (condition) => { const d = clone(def(f.definitions, 'tool')); d.mechanics.effects = [binding('cn.modifier@1',
    { field: 'hp', amount: 10, scope: 'self', condition }, 'c')]; return d; };
  const selfDamaged = { kind: 'pokemonIs', who: 'self', state: { damaged: true } };
  for (const d of [stadiumWith(selfDamaged), abilityWith(cmp({ kind: 'pokemon', who: 'self', field: 'remainingHp' }, 'lt', lit(50))),
    abilityWith({ kind: 'exists', who: 'opponentActive' }), abilityWith(cmp({ kind: 'prizes', side: 'own' }, 'gt', lit(0))),
    abilityWith({ kind: 'pokemonIs', who: 'target', state: { damaged: true } })])
    assert.throws(() => assertSupportedDefinition(catalog, d), (e) => e.code === 'unsupported-condition');
  for (const d of [stadiumWith(ownStadium), abilityWith(selfDamaged), toolWith(selfDamaged)])
    assert.doesNotThrow(() => assertSupportedDefinition(catalog, d));
});
