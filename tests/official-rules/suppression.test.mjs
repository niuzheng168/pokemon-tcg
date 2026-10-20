import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSuppression, SuppressionError, SUPPRESSION_RULE_IDS } from '../../public/rules/suppression.js';
import { validateSuppressionEffect, validateSuppressionParameters, validateLastingParameters } from '../../public/rules/schema-validators.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { OfficialGame } from '../../public/rules/game.js';
import { fixture, binding, EVIDENCE, board, start, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const spec = (extra = {}) => ({ op: 'suppression', channel: 'abilities', scope: 'all', ...extra });
const remove = (extra = {}, id = 'remove') => binding('cn.suppression@1', { effect: spec(extra) }, id);
const ability = (id, effects, extra = {}) => ({
  abilityId: id, name: `测试特性${id}`, mode: 'continuous', usage: null, effects, sourceOfTruth: EVIDENCE, ...extra,
});
const drawAbility = () => ability('draw', [binding('cn.draw@1', { count: 1 })], {
  mode: 'activated', usage: { period: 'turn', scope: 'pokemon', key: 'draw', limit: 1 },
});
const boost = () => ability('hp', [binding('cn.modifier@1', { field: 'hp', amount: 50, scope: 'self' })]);
const trigger = (event, extra = {}) => ({
  event, subject: 'self', optional: false, choiceOwner: 'source', scope: 'global', ...extra,
});
const react = (id, count, extra = {}) => ability(id, [binding('cn.counters@1', {
  side: 'opponent', target: 'attacker', count,
}, id)], { mode: 'triggered', trigger: trigger('attackDamage'), ...extra });
const restore = (g, f) => OfficialGame.restore(JSON.parse(JSON.stringify(g.snapshot())), { catalog: f.catalog });
const end = (g) => { command(g, { type: 'endTurn' }); settle(g); };
const use = (g, id) => command(g, { type: 'useAbility', pokemonId: g.snapshot().players[0].active.id, abilityId: id });
const attack = (g) => command(g, { type: 'attack', attackId: 'base:strike' });
const play = (g, id, owner = g.snapshot().current) => command(g, g.view(owner).legalActions.find((a) =>
  a.type === 'playTrainer' && g.snapshot().cards[a.cardId].definitionId === id), owner);
const hasAbility = (g, id) => g.view(g.snapshot().current).legalActions.some((a) => a.type === 'useAbility' && a.abilityId === id);
const effective = (g, owner = 0) => g.view(owner).players[owner].active.effective;
const swap = (s, owner) => {
  const p = s.players[owner], old = p.active; p.active = p.bench.shift(); p.bench.push(old);
};

const node = (id, extra = {}) => ({ id, kind: 'ability', owner: 0, pokemonId: `mon:${id}`, key: id, active: true,
  mechanics: { types: ['Water'], tags: [], ruleBox: false, stage: 'basic' }, ...extra });
const edge = (from, to, extra = {}) => ({
  id: `${from}->${to}`, sourceNodeId: from, targetId: `mon:${to}`, source: { instanceId: `card:${from}` },
  spec: spec(), sourceOfTruth: EVIDENCE, ...extra,
});

test('D-13 source dependencies agree with an exhaustive truth-assignment oracle, independent of node/entry order', () => {
  for (const id of [...SUPPRESSION_RULE_IDS, 'pokemon.effective-hp']) assert(requireRule(CN_V20261019, id).sourceOfTruth.length);
  assert.deepEqual(resolveSuppression([], []), new Map());
  const permutations = [[0, 1, 2], [2, 1, 0], [1, 2, 0]];
  let resolved = 0, cyclic = 0;
  for (let mask = 0; mask < 512; mask++) {
    const edges = [];
    for (let from = 0; from < 3; from++) for (let to = 0; to < 3; to++)
      if (mask & (1 << (from * 3 + to))) edges.push(edge(String(from), String(to)));
    const solutions = Array.from({ length: 8 }, (_, bits) => [0, 1, 2].map((i) => !!(bits & (1 << i)))).filter((assignment) =>
      assignment.every((enabled, target) => enabled === !edges.some((e) => e.targetId === `mon:${target}` && assignment[Number(e.sourceNodeId)])));
    const results = [];
    for (const order of permutations) {
      const nodes = order.map((id) => node(String(id))), entries = [...edges].reverse(), before = structuredClone({ nodes, entries });
      try {
        const result = resolveSuppression(nodes, entries), values = [0, 1, 2].map((id) => result.get(String(id)).enabled);
        assert.equal(solutions.length, 1);
        assert.deepEqual(values, solutions[0]);
        results.push(values); resolved++;
      } catch (e) {
        assert(e instanceof SuppressionError && e.code === 'unresolved-suppression-cycle');
        assert(e.details.unresolved.length > 0); results.push('needs-CN-ruling'); cyclic++;
      }
      assert.deepEqual({ nodes, entries }, before, 'Derivation cannot edit the board or its descriptors.');
    }
    assert.deepEqual(results[0], results[1]); assert.deepEqual(results[1], results[2]);
  }
  assert(resolved > 0 && cyclic > 0);
});

test('strict suppression descriptors distinguish Abilities, Tools, source conditions, target filters and exceptions', () => {
  assert(validateSuppressionEffect(spec()));
  assert(validateSuppressionParameters({ effect: spec() }));
  assert(validateLastingParameters({ side: 'opponent', target: 'active', effect: spec(), duration: 'nextOpponentTurn',
    clearOnBench: true, clearOnEvolution: true }));
  for (const invalid of [spec({ channel: 'attacks' }), spec({ channel: 'tools', exceptAbilityIds: ['lock'] }),
    spec({ exceptToolNameKeys: ['jammer'] }), spec({ exceptAbilityIds: [] }), spec({ silentlyIgnore: true }),
    { op: 'suppression', scope: 'all' }]) assert(!validateSuppressionEffect(invalid));
  for (const extra of [{ scope: 'own' }, { scope: 'self' }, { scope: 'opponent' }, { scope: 'all' },
    { activeOnly: true }, { sourceActive: true }, { type: 'Fire' }, { stage: 'stage1' }, { ruleBox: true }, { tag: 'RapidStrike' }]) {
    const root = node('source', { kind: 'stadium', pokemonId: 'mon:target', owner: 1, active: true });
    const target = node('target', { owner: 0, active: false });
    const result = resolveSuppression([root, target], [edge('source', 'target', { spec: spec(extra) })]);
    const expectedRemoval = ['all', 'self', 'opponent'].includes(extra.scope) || extra.sourceActive === true;
    assert.equal(result.get('target').enabled, !expectedRemoval, JSON.stringify(extra));
  }
  for (const channel of ['abilities', 'tools']) {
    const root = node('source', { kind: 'stadium', active: false }), target = node('target', {
      kind: channel === 'tools' ? 'tool' : 'ability', key: 'exception',
    });
    const exception = channel === 'tools' ? { exceptToolNameKeys: ['exception'] } : { exceptAbilityIds: ['exception'] };
    assert(resolveSuppression([root, target], [edge('source', 'target', { spec: spec({ channel, ...exception }) })]).get('target').enabled);
    assert(resolveSuppression([root, target], [edge('source', 'target', { spec: spec({ channel, sourceActive: true }) })]).get('target').enabled);
    assert(resolveSuppression([root, target], [edge('source', 'elsewhere', { spec: spec({ channel }) })]).get('target').enabled);
  }
});

test('malformed graph inputs and unsourced/missing/duplicate entries fail closed', () => {
  for (const args of [[null, []], [[], null], [[node('a'), node('a')], []], [[node('', {})], []],
    [[node('a', { kind: 'unknown' })], []], [[node('a', { owner: 2 })], []],
    [[node('a', { key: null })], []], [[node('a', { pokemonId: null })], []],
    [[node('a', { mechanics: null })], []], [[node('a', { mechanics: { types: null } })], []],
    [[node('a', { mechanics: { types: [], tags: null } })], []]]) assert.throws(() => resolveSuppression(...args), /Source|source/);
  const nodes = [node('a'), node('b')];
  for (const mutate of [
    (e) => { e.id = ''; }, (e) => { e.sourceNodeId = 'missing'; }, (e) => { e.sourceOfTruth = []; },
    (e) => { e.source = null; }, (e) => { e.spec.channel = 'unknown'; },
  ]) { const e = edge('a', 'b'); mutate(e); assert.throws(() => resolveSuppression(nodes, [e]), /Suppression needs/); }
  assert.throws(() => resolveSuppression(nodes, [edge('a', 'b'), edge('a', 'b')]), /Suppression needs/);
});

test('D-13 Mischievous-Lock example: removed Basic Abilities are not counted, while explicit exceptions remain', async () => {
  const formula = {
    rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE, timing: 'formula', operations: [],
    capabilities: ['resolve-attack-damage'], validateParameters: (p) => Object.keys(p).length === 0, execute: () => [],
    damageFormula: (ctx) => [ctx.state.players[1].active, ...ctx.state.players[1].bench].filter((m) =>
      ctx.effectivePokemon[m.id].abilities.some((a) => a.present)).length * 50,
  };
  const f = await fixture((defs) => {
    defs[0].mechanics.abilities = [drawAbility(), boost()];
    defs[0].mechanics.attacks[0].printedDamage = { value: 50, operator: 'times' };
    defs[0].mechanics.attacks[0].effects = [binding('fixture:count-abilities', {})];
    defs[1].mechanics.abilities = [ability('lock', [remove({
      stage: 'basic', sourceActive: true, exceptAbilityIds: ['lock'],
    })])];
  }, new Map([['fixture:count-abilities', formula]]));
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water'); bench(s, 1, 'other'); swap(s, 1);
    bench(s, 1, 'base');
  });
  assert(!hasAbility(g, 'draw')); assert.equal(effective(g).maxHp, 100);
  assert.equal(effective(g, 1).abilities.filter((a) => a.present).length, 1);
  for (const mon of g.view(0).players[1].bench) assert(mon.effective.abilities.every((a) => !a.present));
  attack(g); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 5, 'Count Pokémon with remaining Abilities, not printed texts or Ability quantity.');
  assert.equal(f.catalog.definition('base').mechanics.abilities.length, 2, 'The approved definition still has its printed Abilities.');
});

test('removal follows stage and live Active source, restores automatically, and never resets an already-used Ability', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.abilities = [drawAbility()];
    defs[2].mechanics.abilities = [drawAbility()];
    defs[1].mechanics.abilities = [ability('lock', [remove({
      scope: 'opponent', stage: 'basic', sourceActive: true,
    })])];
  });
  let g = board(f, (s) => { bench(s, 1, 'other'); hand(s, 0, 'evolution'); });
  use(g, 'draw'); assert(!hasAbility(g, 'draw'));
  let s = g.snapshot(); swap(s, 1); g = OfficialGame.restore(s, { catalog: f.catalog });
  assert.equal(effective(g).abilities[0].present, false);
  s = g.snapshot(); swap(s, 1); g = OfficialGame.restore(s, { catalog: f.catalog });
  assert.equal(effective(g).abilities[0].present, true);
  assert(!hasAbility(g, 'draw'), 'Restoring the text does not create a fresh use.');
  s = g.snapshot(); swap(s, 1); g = OfficialGame.restore(s, { catalog: f.catalog });
  command(g, g.view(0).legalActions.find((a) => a.type === 'evolve'));
  assert.equal(effective(g).abilities[0].present, true, 'Basic-only removal does not remove the evolved top card Ability.');
  assert(!hasAbility(g, 'draw'), 'The explicit same-key usage remains on the same in-play Pokémon.');
  end(g); end(g); assert(hasAbility(g, 'draw'));
});

test('Path-like Rule-Box removal affects live Ability HP, not Rule-Box rules, printed HP, Tools or counters', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.ruleBox = true; defs[0].mechanics.prizeCount = 2;
    defs[0].mechanics.abilities = [boost(), drawAbility()];
    defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [remove({ ruleBox: true })];
    const replacement = defs.find((d) => d.definitionId === 'potion');
    replacement.mechanics = { category: 'stadium', effects: [] };
  });
  const g = board(f, (s) => {
    hand(s, 0, 'hp-tool'); hand(s, 0, 'stadium'); hand(s, 0, 'potion'); s.players[0].active.counters = 11;
  });
  play(g, 'hp-tool'); settle(g);
  assert.equal(effective(g).maxHp, 200); assert.equal(effective(g).currentHp, 90);
  play(g, 'stadium'); settle(g);
  assert.equal(effective(g).maxHp, 150); assert.equal(effective(g).currentHp, 40);
  assert.equal(g.snapshot().players[0].active.counters, 11);
  assert(effective(g).abilities.every((a) => !a.present));
  assert(effective(g).toolEffects[0].enabled);
  assert.equal(f.catalog.definition('base').mechanics.prizeCount, 2);
  assert.equal(f.catalog.definition('base').mechanics.hp, 100);
  end(g); end(g); play(g, 'potion'); settle(g);
  assert.equal(effective(g).maxHp, 200); assert(effective(g).abilities.every((a) => a.present));
  assert.equal(g.snapshot().players[0].active.counters, 11);
});

test('Tool-Jammer-like removal retains attachment/slot and its own explicit exception; moving the source restores effects', async () => {
  const f = await fixture((defs) => defs.find((d) => d.definitionId === 'tool').mechanics.effects = [
    remove({ channel: 'tools', scope: 'opponent', activeOnly: true, sourceActive: true, exceptToolNameKeys: ['tool'] }),
  ]);
  const g = board(f, (s) => {
    hand(s, 0, 'tool'); hand(s, 1, 'hp-tool'); bench(s, 0, 'other'); attached(s, 0, s.players[0].active, 'water');
  });
  end(g); play(g, 'hp-tool'); settle(g); assert.equal(effective(g, 1).maxHp, 150);
  end(g); play(g, 'tool'); settle(g);
  assert.equal(effective(g, 1).maxHp, 100);
  assert.equal(g.snapshot().players[1].active.tools.length, 1, 'Effect removal is not discarding an attached Tool.');
  assert.equal(effective(g, 1).toolEffects[0].enabled, false);
  assert(effective(g, 1).toolEffects[0].removedBy[0].sourceOfTruth.length);
  command(g, { type: 'retreat' }); settle(g);
  assert.equal(effective(g, 1).maxHp, 150);
  const copy = restore(g, f); assert.deepEqual(copy.view(0), g.view(0));

  const both = board(f, (s) => {
    for (const owner of [0, 1]) { const id = hand(s, owner, 'tool'); s.players[owner].hand.pop(); s.players[owner].active.tools.push(id); }
  });
  assert(effective(both).toolEffects[0].enabled && effective(both, 1).toolEffects[0].enabled,
    'Explicit same-name exception is not an unsourced first-in-play priority.');
});

test('suppressed Tool-granted attack disappears while the Pokémon printed attack remains legal', async () => {
  const f = await fixture((defs) => {
    const tool = defs.find((d) => d.definitionId === 'tool');
    tool.mechanics.effects = []; tool.mechanics.grantedAttacks = [{
      attackId: 'tool:attack', name: '测试额外招式', cost: ['Water'], printedDamage: { value: 50, operator: 'fixed' },
      effects: [], sourceOfTruth: EVIDENCE,
    }];
    defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [remove({ channel: 'tools' })];
  });
  const g = board(f, (s) => { hand(s, 0, 'tool'); hand(s, 0, 'stadium'); attached(s, 0, s.players[0].active, 'water'); });
  play(g, 'tool'); settle(g); assert(g.view(0).legalActions.some((a) => a.attackId === 'tool:attack'));
  play(g, 'stadium'); settle(g);
  assert(!g.view(0).legalActions.some((a) => a.attackId === 'tool:attack'));
  assert(g.view(0).legalActions.some((a) => a.attackId === 'base:strike'));
  const s = g.snapshot();
  assert.throws(() => command(g, { type: 'attack', attackId: 'tool:attack' }), /not legal/);
  assert.deepEqual(g.snapshot(), s);
});

test('an external removal disables an Ability remover before its Tool victims, regardless of source enumeration', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.abilities = [ability('tool-lock', [remove({ channel: 'tools' })])];
    defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [remove()];
  });
  const g = board(f, (s) => { hand(s, 0, 'hp-tool'); hand(s, 0, 'stadium'); });
  play(g, 'hp-tool'); settle(g); assert.equal(effective(g).maxHp, 100);
  play(g, 'stadium'); settle(g);
  assert.equal(effective(g).maxHp, 150, 'The removed Ability is no longer an active removal source.');
  assert(effective(g).toolEffects[0].enabled);
  assert(!effective(g).abilities[0].present);
});

test('removing Ability text does not cancel an effect it already established or refund its uses', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.abilities = [ability('establish', [binding('cn.lasting@1', {
      side: 'own', target: 'self', duration: 'untilNextOwnTurnEnd', clearOnBench: true, clearOnEvolution: true,
      effect: { op: 'modifier', field: 'attackDamage', amount: 30, scope: 'all' },
    })], { mode: 'activated', usage: { period: 'turn', scope: 'pokemon', key: 'establish', limit: 1 } })];
    defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [remove()];
  });
  const g = board(f, (s) => { hand(s, 0, 'stadium'); attached(s, 0, s.players[0].active, 'water'); });
  use(g, 'establish'); settle(g); play(g, 'stadium'); settle(g);
  assert(!effective(g).abilities[0].present);
  assert.equal(g.snapshot().ongoing.length, 1);
  attack(g); settle(g); assert.equal(g.snapshot().players[1].active.counters, 5);
  assert.equal(g.snapshot().players[0].active.used.establish.length, 1);
});

test('timed removal remains fixed on the affected Pokémon and clears by its own expiry/evolution policies', async () => {
  const f = await fixture((defs) => {
    defs[1].mechanics.abilities = [drawAbility()];
    defs[0].mechanics.attacks[0].effects = [binding('cn.lasting@1', {
      side: 'opponent', target: 'active', effect: spec(), duration: 'nextOpponentTurn',
      clearOnBench: true, clearOnEvolution: true,
    })];
  });
  const g = board(f, (s) => { bench(s, 1, 'other'); swap(s, 1); attached(s, 0, s.players[0].active, 'water'); });
  attack(g); settle(g);
  assert(!effective(g, 1).abilities[0].present);
  assert(!hasAbility(g, 'draw'));
  const saved = restore(g, f); assert.deepEqual(saved.view(1), g.view(1));
  end(g); assert.equal(g.snapshot().ongoing.length, 0);
  end(g); assert(hasAbility(g, 'draw'));
});

test('removed native damage/KO/Tool reactions do not activate, and HP loss still reaches the normal KO boundary', async () => {
  for (const channel of ['abilities', 'tools']) {
    const f = await fixture((defs) => {
      defs[1].mechanics.abilities = [react('retaliate', 2)];
      defs.find((d) => d.definitionId === 'tool').mechanics.effects = [{
        ...binding('cn.counters@1', { side: 'opponent', target: 'attacker', count: 3 }),
        trigger: trigger('attackDamage'),
      }];
      defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [remove({ channel })];
    });
    const g = board(f, (s) => {
      bench(s, 1, 'other'); swap(s, 1);
      const tool = hand(s, 1, 'tool'); s.players[1].hand.pop(); s.players[1].active.tools.push(tool);
      hand(s, 0, 'stadium'); attached(s, 0, s.players[0].active, 'water');
    });
    play(g, 'stadium'); settle(g); attack(g); settle(g);
    assert.equal(g.snapshot().players[0].active.counters, channel === 'abilities' ? 3 : 2);
    assert.equal(g.snapshot().events.filter((e) => e.ruleId === 'trigger.damage' && e.data.performed).length, 1);
  }
  const f = await fixture((defs) => {
    defs[0].mechanics.abilities = [boost(), react('ko-react', 8, { trigger: trigger('knockout') })];
    defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [remove()];
  });
  const g = board(f, (s) => { hand(s, 0, 'stadium'); s.players[0].active.counters = 12; });
  play(g, 'stadium'); settle(g);
  assert.equal(g.snapshot().result.winner, 1);
  assert(!g.snapshot().events.some((e) => e.ruleId === 'trigger.knockout' && e.data.performed));
});

test('pending native trigger rechecks removal before declaration, but a declared Ability completes its written effects', async () => {
  const lastingRemoval = binding('cn.lasting@1', {
    side: 'own', target: 'event', effect: spec(), duration: 'untilNextOwnTurnEnd',
    clearOnBench: true, clearOnEvolution: true,
  });
  const f = await fixture((defs) => defs[0].mechanics.abilities = [
    ability('remove-first', [lastingRemoval, binding('cn.draw@1', { count: 1 })], {
      mode: 'triggered', trigger: trigger('turnEnd', { turn: 'own', endingPlayer: 'own' }),
    }),
    ability('later', [binding('cn.draw@1', { count: 2 }, 'later')], {
      mode: 'triggered', trigger: trigger('turnEnd', { turn: 'own', endingPlayer: 'own' }),
    }),
  ]);
  let g = board(f), before = g.snapshot();
  command(g, { type: 'endTurn' }); assert.equal(g.snapshot().pending.kind, 'trigger-order');
  const first = g.snapshot().pending.data.units.find((u) => u.abilityId === 'remove-first');
  g = restore(g, f); answer(g, [first.id]); settle(g);
  assert.equal(g.snapshot().players[0].hand.length, before.players[0].hand.length + 1,
    'Do finish the accepted Ability, but do not declare the now-removed second Ability.');
  assert.equal(g.snapshot().events.filter((e) => e.ruleId === 'trigger.turn-end' && e.data.performed).length, 1);
});

test('introducing a still-unresolved mutual removal rejects atomically rather than guessing a player/timestamp priority', async () => {
  const f = await fixture((defs) => {
    defs[0].mechanics.abilities = [drawAbility()];
    defs[1].mechanics.abilities = [ability('opponent-lock', [remove({ scope: 'opponent' })])];
  });
  const g = board(f, (s) => { bench(s, 0, 'other'); hand(s, 1, 'other'); });
  end(g);
  const before = g.snapshot(), next = g.view(1).legalActions.find((a) => a.type === 'bench' && before.cards[a.cardId].definitionId === 'other');
  assert.throws(() => command(g, next), (e) => e.code === 'unresolved-suppression-cycle');
  assert.deepEqual(g.snapshot(), before);
});

test('setup projections do not let hidden opponent Abilities modify or leak the prepared player stats', async () => {
  const f = await fixture((defs) => defs[0].mechanics.abilities = [
    ability('hp-for-all', [binding('cn.modifier@1', { field: 'hp', amount: 50, scope: 'all' })]),
    ability('remove-other', [remove({ exceptAbilityIds: ['remove-other'] })]),
  ]);
  const g = new OfficialGame({ ruleset: f.ruleset, catalog: f.catalog, decks: [f.deck, f.deck], seed: f.seed });
  while (g.snapshot().phase === 'setup' && !g.snapshot().players[0].active) {
    const q = g.snapshot().pending;
    answer(g, q.options.slice(0, q.minimum));
  }
  assert.equal(g.snapshot().phase, 'setup');
  assert.equal(g.view(0).players[0].active.effective.maxHp, 100);
  assert(g.view(0).players[0].active.effective.abilities.every((a) => a.present));
  for (const m of [g.view(0).players[1].active, ...g.view(0).players[1].bench].filter(Boolean))
    assert.deepEqual(m, { faceDown: true });
});

test('suppression source predicates see raw facts only, and malformed descriptors/timings cannot silently run', async () => {
  for (const result of [null, [{ op: 'draw', count: 1 }], [{ op: 'suppression', channel: 'abilities', scope: 'all', ignored: true }]]) {
    const h = { rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE, timing: 'suppression', operations: ['suppression'],
      validateParameters: (p) => Object.keys(p).length === 0, execute: (ctx) => {
        assert(!Object.hasOwn(ctx, 'effectivePokemon')); assert(Object.isFrozen(ctx.state));
        return structuredClone(result);
      } };
    const f = await fixture((defs) => defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [binding('fixture:suppression', {})],
      new Map([['fixture:suppression', h]]));
    const g = board(f, (s) => hand(s, 0, 'stadium')), before = g.snapshot();
    assert.throws(() => play(g, 'stadium'), /Suppression handlers return|Invalid or undeclared suppression/);
    assert.deepEqual(g.snapshot(), before);
  }
  for (const configuration of [
    { timing: 'resolve', operations: ['suppression'] },
    { timing: 'suppression', operations: ['draw'] },
  ]) {
    const h = { rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE, ...configuration,
      validateParameters: (p) => Object.keys(p).length === 0, execute: () => [] };
    const f = await fixture((defs) => defs[0].mechanics.abilities = [ability('bad', [binding('fixture:timing', {})])],
      new Map([['fixture:timing', h]]));
    assert.throws(() => start(f), /Unimplemented or undeclared handler/);
  }
});
