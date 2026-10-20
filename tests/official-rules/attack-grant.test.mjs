import test from 'node:test';
import assert from 'node:assert/strict';
import { grantReferences, ATTACK_GRANT_RULE_IDS } from '../../public/rules/attack-grant.js';
import { validateAttackGrantEffect, validateAttackGrantParameters, validateGameCommand } from '../../public/rules/schema-validators.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { OfficialGame } from '../../public/rules/game.js';
import { fixture, fixtureClock, binding, EVIDENCE, board, start, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const grant = (extra = {}) => ({ op: 'attackGrant', scope: 'self', targetSelector: { kind: 'pokemon' },
  origins: [
    { side: 'own', zone: 'bench', selector: { kind: 'pokemon', nameKeys: ['other'] } },
    { side: 'own', zone: 'discard', selector: { kind: 'pokemon', nameKeys: ['other'] } },
  ], excludeUser: false, ...extra });
const ability = (effects, extra = {}) => ({ abilityId: 'grant', name: '测试可用招式', mode: 'continuous', usage: null,
  effects, sourceOfTruth: EVIDENCE, ...extra });
const give = (defs, spec = grant()) => { defs[0].mechanics.abilities = [ability([binding('cn.attackGrant@1', spec)])]; };
const restore = (g, f) => OfficialGame.restore(JSON.parse(JSON.stringify(g.snapshot())), { catalog: f.catalog });
const move = (g, id = 'other:strike', player = g.snapshot().current) => g.view(player).legalActions.find((a) => a.type === 'attack' && a.attackId === id);
const attack = (g, id = 'other:strike') => { assert(move(g, id), `Missing granted action ${id}`); return command(g, move(g, id)); };
const end = (g) => { command(g, { type: 'endTurn' }); settle(g); };
const put = (s, owner, id, zone) => {
  const card = hand(s, owner, id); s.players[owner].hand.pop(); s.players[owner][zone].push(card); return card;
};
const held = (s, owner, mon, definition = 'tool') => {
  const card = hand(s, owner, definition); s.players[owner].hand.pop(); mon.tools.push(card); return card;
};
const stack = (s, owner, mon) => {
  const card = hand(s, owner, 'evolution'); s.players[owner].hand.pop(); mon.stack.push(card); return card;
};
const stadium = (s, owner = 0) => {
  const card = hand(s, owner, 'stadium'); s.players[owner].hand.pop(); s.stadium = card; return card;
};
const reviewed = (extra) => ({ rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE,
  validateParameters: (p) => Object.keys(p).length === 0, ...extra });

test('D-06/D-09/E-37 grants have strict source-backed descriptors, not permanent mutation or a copy instruction', () => {
  for (const id of ATTACK_GRANT_RULE_IDS) assert(requireRule(CN_V20261019, id).sourceOfTruth.length);
  assert(validateAttackGrantEffect(grant())); assert(validateAttackGrantParameters(grant()));
  for (const s of [grant({ op: 'copyAttack' }), grant({ targetSelector: { kind: 'any' } }), grant({ cost: [] }),
    grant({ origins: [] }), grant({ origins: [{ side: 'own', zone: 'hand', selector: { kind: 'pokemon' } }] }),
    grant({ origins: [{ side: 'own', zone: 'discard', subject: 'user', selector: { kind: 'pokemon' } }] })])
    assert(!validateAttackGrantEffect(s));
  assert(validateGameCommand({ player: 0, expectedRevision: 1, action: { type: 'attack', attackId: 'a', referenceId: 'source:a' } }));
  assert(!validateGameCommand({ player: 0, expectedRevision: 1, action: { type: 'attack', attackId: 'a', grantId: 'forged' } }));
});

test('directly granted content uses its declared identity, actual user’s stats/self-effects and real Energy requirements', async () => {
  const f = await fixture((defs) => {
    give(defs); defs[1].mechanics.hp = 200; defs[1].mechanics.types = ['Fire'];
    defs[1].mechanics.attacks[0].cost = ['Colorless', 'Colorless'];
    defs[1].mechanics.attacks[0].printedDamage.value = 40;
    defs[1].mechanics.attacks[0].effects = [binding('cn.heal@1', { target: 'self', amount: 30 }), binding('cn.draw@1', { count: 1 })];
  });
  let template, energy;
  const g = board(f, (s) => {
    template = put(s, 0, 'other', 'discard'); energy = attached(s, 0, s.players[0].active, 'double');
    held(s, 0, s.players[0].active); s.players[0].active.counters = 4;
  });
  const before = g.snapshot(), printed = structuredClone(f.catalog.definition('base'));
  assert(move(g)); assert(!printed.mechanics.attacks.some((a) => a.attackId === 'other:strike'));
  attack(g); assert.equal(g.snapshot().pending.kind, 'effect-target'); assert.deepEqual(restore(g, f).view(0), g.view(0));
  answer(g, [g.snapshot().players[0].active.id]); settle(g);
  const s = g.snapshot(), receipt = s.events.find((e) => e.ruleId === 'attack.grant' && e.data.kind === 'used');
  assert.equal(s.players[1].active.counters, 7, 'Actual Water user: 40 + its own Tool 30, without borrowed Fire Weakness.');
  assert.equal(s.players[0].active.counters, 1); assert.deepEqual(s.players[0].active.energy, [energy]);
  assert.equal(s.players[0].hand.length, before.players[0].hand.length + 1);
  assert.equal(s.players[0].active.facts.lastUsedAttack.attackId, 'other:strike');
  assert.equal(receipt.data.reference.instanceId, template); assert.equal(receipt.data.source.instanceId, before.players[0].active.stack[0]);
  assert.equal(receipt.data.source.owner, 0); assert.equal(receipt.data.source.attackId, 'other:strike');
  assert.deepEqual(f.catalog.definition('base'), printed);
  assert(!s.events.some((e) => e.ruleId === 'attack.copy'), 'Permission is not implemented by a hidden copy.');
  const poor = board(f, (s) => { put(s, 0, 'other', 'discard'); attached(s, 0, s.players[0].active, 'water'); });
  assert(!move(poor), 'A directly used attack does not inherit C-18 free-Energy semantics.');
});

test('a directly used named Heavy-Impact restriction blocks that granted attack on the next own turn', async () => {
  const f = await fixture((defs) => {
    give(defs); defs[1].mechanics.attacks[0].effects = [binding('cn.lasting@1', {
      side: 'own', target: 'self', effect: { op: 'restriction', scope: 'all', actions: ['attack'], attackIds: ['other:strike'] },
      duration: 'nextOwnTurn', clearOnBench: true, clearOnEvolution: true,
    })];
  });
  const g = board(f, (s) => { put(s, 0, 'other', 'discard'); attached(s, 0, s.players[0].active, 'water'); });
  attack(g); settle(g); assert.deepEqual(restore(g, f).view(0), g.view(0)); end(g);
  assert(!move(g)); assert(move(g, 'base:strike'));
  assert.equal(g.snapshot().ongoing[0].source.grantId.startsWith('grant'), true);
  assert.equal(g.snapshot().ongoing[0].source.attackId, 'other:strike');
});

test('Memory-Capsule-like permission reads only the user’s actual lower evolution cards and disappears under Tool suppression', async () => {
  const spec = grant({ origins: [{ side: 'own', zone: 'evolution', subject: 'user', selector: { kind: 'pokemon' } }] });
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'tool').mechanics.effects = [binding('cn.attackGrant@1', spec)];
    defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [binding('cn.suppression@1', {
      effect: { op: 'suppression', channel: 'tools', scope: 'all' },
    })];
  });
  const g = board(f, (s) => { stack(s, 0, s.players[0].active); held(s, 0, s.players[0].active); attached(s, 0, s.players[0].active, 'water'); });
  assert(move(g, 'base:strike')); assert(move(g, 'evolution:strike'));
  const extra = g.view(0).players[0].active.effective.attackRequirements.find((a) => a.attackId === 'base:strike');
  assert.equal(extra.contentSource.instanceId, g.snapshot().players[0].active.stack[0]);
  const s = g.snapshot(); stadium(s, 1);
  const suppressed = OfficialGame.restore(s, { catalog: f.catalog });
  assert(!move(suppressed, 'base:strike')); assert(move(suppressed, 'evolution:strike'));
  attack(g, 'base:strike'); settle(g); assert.equal(g.snapshot().players[1].active.counters, 2);
  assert.equal(g.snapshot().players[0].active.facts.lastUsedAttack.attackId, 'base:strike');
});

test('Ability removal disables extra usable moves but does not change printed owned attacks or their definitions', async () => {
  const f = await fixture((defs) => {
    give(defs); defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [binding('cn.suppression@1', {
      effect: { op: 'suppression', channel: 'abilities', scope: 'all' },
    })];
  });
  const g = board(f, (s) => { bench(s, 0, 'other'); attached(s, 0, s.players[0].active, 'water'); });
  assert(move(g)); const s = g.snapshot(); stadium(s);
  const removed = OfficialGame.restore(s, { catalog: f.catalog });
  assert(!move(removed)); assert(move(removed, 'base:strike'));
  const cleared = removed.snapshot(); cleared.players[0].discard.push(cleared.stadium); cleared.stadium = null;
  assert(move(OfficialGame.restore(cleared, { catalog: f.catalog })));
  assert.equal(f.catalog.definition('base').mechanics.attacks.length, 1);
});

test('a shared provider’s own/opponent permission origins are interpreted for each actual user, and quotas belong to that user', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [binding('cn.attackGrant@1', grant({ scope: 'all' }))];
    defs[1].mechanics.attacks[0].specialRule = 'VSTAR'; defs[1].mechanics.ruleBox = true; defs[1].mechanics.prizeCount = 2;
  });
  let own, other, provider;
  const g = board(f, (s) => {
    own = put(s, 0, 'other', 'discard'); other = put(s, 1, 'other', 'discard'); provider = stadium(s, 1);
    attached(s, 0, s.players[0].active, 'water'); attached(s, 1, s.players[1].active, 'water');
  });
  attack(g); settle(g); assert.equal(g.snapshot().players[0].vstarUsed, true); assert.equal(g.snapshot().players[1].vstarUsed, false);
  const first = g.snapshot().events.find((e) => e.ruleId === 'attack.grant');
  assert.equal(first.data.provider.source.instanceId, provider); assert.equal(first.data.provider.source.owner, 1);
  assert.equal(first.data.source.owner, 0); assert.equal(first.data.reference.instanceId, own);
  attack(g); settle(g); assert.equal(g.snapshot().players[1].vstarUsed, true);
  const second = g.snapshot().events.filter((e) => e.ruleId === 'attack.grant')[1];
  assert.equal(second.data.source.owner, 1); assert.equal(second.data.reference.instanceId, other);
});

test('multiple equal attack IDs require a real source reference, rather than choosing an arbitrary printed card', async () => {
  const f = await fixture((defs) => give(defs));
  let fromBench, fromDiscard;
  const g = board(f, (s) => {
    fromBench = bench(s, 0, 'other').stack[0]; fromDiscard = put(s, 0, 'other', 'discard'); attached(s, 0, s.players[0].active, 'water');
  });
  const choices = g.view(0).legalActions.filter((a) => a.type === 'attack' && a.attackId === 'other:strike');
  assert.equal(choices.length, 2); assert(choices.every((a) => a.referenceId));
  const before = g.snapshot(); assert.throws(() => command(g, { type: 'attack', attackId: 'other:strike' }), /not legal/);
  assert.deepEqual(g.snapshot(), before);
  assert.throws(() => command(g, { type: 'attack', attackId: 'other:strike', referenceId: 'forged' }), /not legal/);
  const source = g.view(0).players[0].active.effective.attackRequirements.find((a) => a.contentSource?.instanceId === fromDiscard);
  command(g, choices.find((a) => a.referenceId === source.referenceId)); settle(g);
  const used = g.snapshot().events.find((e) => e.ruleId === 'attack.grant');
  assert.equal(used.data.reference.instanceId, fromDiscard); assert.notEqual(used.data.reference.instanceId, fromBench);
});

test('an unambiguous attack may also carry its exact reference, but a forged reference never becomes an implicit fallback', async () => {
  const f = await fixture((defs) => give(defs));
  const g = board(f, (s) => { put(s, 0, 'other', 'discard'); attached(s, 0, s.players[0].active, 'water'); });
  const before = g.snapshot();
  assert.throws(() => command(g, { type: 'attack', attackId: 'other:strike', referenceId: 'forged' }), /not legal/);
  assert.deepEqual(g.snapshot(), before);
  const ref = g.view(0).players[0].active.effective.attackRequirements.find((a) => a.attackId === 'other:strike').referenceId;
  command(g, { type: 'attack', attackId: 'other:strike', referenceId: ref }); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 2);
});

test('native and printed Tool attacks sharing an ID are independently selectable without changing that actual use identity', async () => {
  const f = await fixture((defs) => {
    const d = defs.find((d) => d.definitionId === 'tool'); d.mechanics.effects = [];
    d.mechanics.grantedAttacks = [{ ...structuredClone(defs[0].mechanics.attacks[0]), printedDamage: { value: 60, operator: 'fixed' } }];
  });
  for (const kind of ['native', 'tool']) {
    const g = board(f, (s) => { held(s, 0, s.players[0].active); attached(s, 0, s.players[0].active, 'water'); });
    const a = g.view(0).legalActions.find((a) => a.type === 'attack' && a.referenceId && JSON.parse(a.referenceId)[0] === kind);
    assert(a); command(g, a); settle(g);
    assert.equal(g.snapshot().players[1].active.counters, kind === 'native' ? 2 : 6);
    assert.equal(g.snapshot().players[0].active.facts.lastUsedAttack.attackId, 'base:strike');
  }
});

test('a legally declared granted attack completes after its granting Ability is suppressed, without keeping a future permission', async () => {
  const f = await fixture((defs) => {
    give(defs); defs[1].mechanics.attacks[0].effects = [binding('fixture:suppress-grant', {}), binding('fixture:optional-draw', {})];
  }, new Map([
    ['fixture:suppress-grant', reviewed({ timing: 'beforeDamage', operations: ['lasting'], execute: () => [{
      op: 'lasting', side: 'own', target: 'self', effect: { op: 'suppression', channel: 'abilities', scope: 'all' },
      duration: 'untilNextOwnTurnEnd', clearOnBench: true, clearOnEvolution: true,
    }] })],
    ['fixture:optional-draw', reviewed({ operations: ['optional', 'draw'], execute: () => [{ op: 'optional', effect: { op: 'draw', count: 1 } }] })],
  ]));
  const g = board(f, (s) => { put(s, 0, 'other', 'discard'); attached(s, 0, s.players[0].active, 'water'); });
  attack(g); answer(g, [g.snapshot().players[0].active.id]);
  assert.equal(g.snapshot().pending.kind, 'optional-effect');
  assert(!g.view(0).players[0].active.effective.attackRequirements.some((a) => a.attackId === 'other:strike'));
  const r = restore(g, f); answer(g, ['perform']); answer(r, ['perform']); settle(g); settle(r);
  assert.deepEqual(r.snapshot(), g.snapshot()); assert.equal(g.snapshot().players[1].active.counters, 2);
});

test('a direct grant may supply a copying attack; the copied body preserves the directly declared name and the permission chain', async () => {
  const copy = { op: 'copyAttack', origins: [{ side: 'opponent', zone: 'active', selector: { kind: 'pokemon' } }],
    excludeUser: false, coin: 'none', energy: 'ignore', special: { mode: 'needsRuling', sourceOfTruth: EVIDENCE } };
  const f = await fixture((defs) => {
    give(defs); defs[1].mechanics.attacks[0].printedDamage = null;
    defs[1].mechanics.attacks[0].effects = [binding('cn.copyAttack@1', copy)];
  });
  const g = board(f, (s) => { put(s, 0, 'other', 'discard'); attached(s, 0, s.players[0].active, 'water'); });
  attack(g); assert.equal(g.snapshot().pending.kind, 'copy-attack'); assert.deepEqual(restore(g, f).view(0), g.view(0));
  const c = g.view(0).pending.attacks.find((a) => a.attackId === 'base:strike'); answer(g, [c.optionId]); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 2);
  assert.equal(g.snapshot().players[0].active.facts.lastUsedAttack.attackId, 'other:strike');
  const selected = g.snapshot().events.find((e) => e.ruleId === 'attack.copy' && e.data.kind === 'selected');
  assert(selected.data.source.grantId); assert.equal(selected.data.source.attackId, 'other:strike');
});

test('grant sources and used permissions remain verifiable for delayed effects after the provider leaves play', async () => {
  const trigger = { event: 'attackDamage', subject: 'self', optional: true, choiceOwner: 'source', scope: 'global', cause: 'opponentAttackDamage' };
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'stadium').mechanics.effects = [binding('cn.attackGrant@1', grant({ scope: 'all' }))];
    defs[1].mechanics.attacks[0].effects = [binding('cn.delayedReaction@1', {
      side: 'own', target: 'self', trigger, program: [{ op: 'counters', side: 'opponent', target: 'attacker', count: 1 }],
      duration: 'untilNextOpponentTurnEnd', clearOnBench: true, clearOnEvolution: true,
    })];
  });
  let g = board(f, (s) => {
    put(s, 0, 'other', 'discard'); stadium(s, 1);
    attached(s, 0, s.players[0].active, 'water'); attached(s, 1, s.players[1].active, 'water');
  });
  attack(g); answer(g, [g.snapshot().players[0].active.id]); settle(g);
  assert(g.snapshot().ongoing[0].source.grantId); assert.deepEqual(restore(g, f).view(0), g.view(0));
  const removed = g.snapshot(); removed.players[1].discard.push(removed.stadium); removed.stadium = null;
  g = OfficialGame.restore(removed, { catalog: f.catalog });
  assert(!g.view(0).players[0].active.effective.attackRequirements.some((a) => a.attackId === 'other:strike'));
  for (const mutate of [
    (s, rec) => { delete rec.provider; },
    (s, rec) => { rec.provider.source.category = 'attack'; },
    (s, rec) => { rec.provider.source.effectId = 'missing'; },
    (s, rec) => { rec.provider.specification.op = 'copyAttack'; },
    (s, rec) => { s.events.push(structuredClone(s.events.find((e) => e.ruleId === 'attack.grant'))); },
  ]) {
    const s = g.snapshot(), rec = s.events.find((e) => e.ruleId === 'attack.grant').data; mutate(s, rec);
    assert.throws(() => OfficialGame.restore(s, { catalog: f.catalog }), /source|valid|Source|Invalid/);
  }
  command(g, { type: 'attack', attackId: 'base:strike' }); assert.equal(g.snapshot().pending.kind, 'trigger-optional');
  const r = restore(g, f); answer(g, ['perform']); answer(r, ['perform']); settle(g); settle(r);
  assert.deepEqual(r.snapshot(), g.snapshot()); assert.equal(g.snapshot().players[1].active.counters, 3);
});

test('setup does not evaluate hidden grant sources or expose their private candidates', async () => {
  let calls = 0;
  const f = await fixture((defs) => defs[0].mechanics.abilities = [ability([binding('fixture:setup-grant', {})])],
    new Map([['fixture:setup-grant', reviewed({ timing: 'attackGrant', operations: ['attackGrant'], execute: (ctx) => {
      assert.notEqual(ctx.state.phase, 'setup'); calls++; return [grant()];
    } })]]));
  const g = new OfficialGame({ ruleset: f.ruleset, catalog: f.catalog, decks: [f.deck, f.deck], seed: f.seed });
  while (!g.snapshot().players[0].active) answer(g, g.snapshot().pending.options.slice(0, g.snapshot().pending.minimum));
  assert.equal(calls, 0); assert.equal(g.view(0).players[0].active.effective.attackRequirements.length, 1);
  settle(g); assert(calls > 0);
});

test('unknown grant timing, mismatched declared operations and malformed descriptors cannot silently act as ordinary attacks', async () => {
  for (const result of [undefined, {}, [{ ...grant(), targetSelector: { kind: 'any' } }], [{ op: 'draw', count: 1 }]]) {
    const f = await fixture((defs) => defs[0].mechanics.abilities = [ability([binding('fixture:bad-grant', {})])],
      new Map([['fixture:bad-grant', reviewed({ timing: 'attackGrant', operations: ['attackGrant'], execute: () => result })]]));
    assert.throws(() => board(f), /grant|Grant|Non-serializable/);
  }
  for (const config of [{ timing: 'resolve', operations: ['attackGrant'] }, { timing: 'attackGrant', operations: ['draw'] }]) {
    const f = await fixture((defs) => defs[0].mechanics.abilities = [ability([binding('fixture:bad-grant', {})])],
      new Map([['fixture:bad-grant', reviewed({ ...config, execute: () => [] })]]));
    assert.throws(() => start(f), /Unimplemented or undeclared/);
  }
});

test('pure grant predicates distinguish receiver, provider, source position, origin holder and actual user’s evolution stack', async () => {
  const f = await fixture(), definitions = Object.fromEntries(f.definitions.map((d) => [d.definitionId, d]));
  const actor = { id: 'a', stack: ['base', 'evolution'] }, benchMon = { id: 'b', stack: ['other'] };
  const ctx = { source: { owner: 1, pokemonId: 'c' }, definitions,
    effectivePokemon: { a: { types: ['Water'] }, b: { types: ['Water'] }, c: { types: ['Water'] } }, state: {
    players: [{ active: actor, bench: [benchMon], discard: ['discard0'] },
      { active: { id: 'c', stack: ['base1'] }, bench: [], discard: ['discard1'] }],
    cards: { base: { definitionId: 'base' }, evolution: { definitionId: 'evolution' }, other: { definitionId: 'other' },
      base1: { definitionId: 'base' }, discard0: { definitionId: 'other' }, discard1: { definitionId: 'base' } },
  } };
  assert(grantReferences(ctx, grant({ scope: 'all' }), 0, actor).some((r) => r.instanceId === 'discard0'));
  assert(!grantReferences(ctx, grant({ scope: 'all' }), 0, actor).some((r) => r.instanceId === 'discard1'));
  assert.deepEqual(grantReferences(ctx, grant({ scope: 'self' }), 0, actor), []);
  assert.deepEqual(grantReferences(ctx, grant({ scope: 'own' }), 0, actor), []);
  assert(grantReferences(ctx, grant({ scope: 'opponent' }), 0, actor).length);
  assert.deepEqual(grantReferences(ctx, grant({ scope: 'opponent' }), 1, ctx.state.players[1].active), []);
  assert.deepEqual(grantReferences(ctx, grant({ scope: 'all', activeOnly: true }), 0, benchMon), []);
  assert.deepEqual(grantReferences({ ...ctx, source: { owner: 1, pokemonId: 'missing' } }, grant({ scope: 'all', sourceActive: true }), 0, actor), []);
  assert(grantReferences(ctx, grant({ scope: 'all', sourceActive: true }), 0, actor).length);
  assert.deepEqual(grantReferences(ctx, grant({ scope: 'all', targetSelector: { kind: 'pokemon', ruleBox: true } }), 0, actor), []);
  assert.deepEqual(grantReferences(ctx, grant({ scope: 'all', origins: [{
    side: 'own', zone: 'evolution', subject: 'user', selector: { kind: 'pokemon' },
  }] }), 0, actor), [{ instanceId: 'base', attackId: 'base:strike' }]);
});

test('grant recipient types come from the actual user model while discard and lower-evolution attack identities stay printed', async () => {
  const f = await fixture(), definitions = Object.fromEntries(f.definitions.map((d) => [d.definitionId, d]));
  const actor = { id: 'a', stack: ['base', 'evolution'] };
  const ctx = {
    source: { owner: 1, pokemonId: 'provider' }, definitions,
    effectivePokemon: { a: { types: ['Lightning', 'Metal'] }, provider: { types: ['Fire'] } },
    state: { players: [
      { active: actor, bench: [], discard: ['template'] },
      { active: { id: 'provider', stack: ['other'] }, bench: [], discard: [] },
    ], cards: { base: { definitionId: 'base' }, evolution: { definitionId: 'evolution' },
      other: { definitionId: 'other' }, template: { definitionId: 'other' } } },
  };
  const before = structuredClone(ctx);
  const spec = grant({ scope: 'all', origins: [
    { side: 'own', zone: 'discard', selector: { kind: 'pokemon', types: ['Water'] } },
  ] });
  for (const [types, expected] of [[['Lightning'], true], [['Metal'], true], [['Water'], false], [['Fire'], false], [['Fire', 'Metal'], true]]) {
    const refs = grantReferences(ctx, { ...spec, targetSelector: { kind: 'pokemon', types } }, 0, actor);
    assert.deepEqual(refs, expected ? [{ instanceId: 'template', attackId: 'other:strike' }] : []);
  }
  assert.deepEqual(grantReferences(ctx, { ...spec, targetSelector: { kind: 'pokemon', types: ['Lightning'], stages: ['basic'] } }, 0, actor), []);
  assert.deepEqual(grantReferences(ctx, { ...spec, targetSelector: {
    kind: 'pokemon', types: ['Lightning'], stages: ['stage1'], nameKeys: ['evolution'],
  }, origins: [{ side: 'own', zone: 'evolution', subject: 'user', selector: { kind: 'pokemon', types: ['Water'] } }] }, 0, actor),
  [{ instanceId: 'base', attackId: 'base:strike' }]);
  assert.deepEqual(ctx, before);
  for (const mutate of [
    (c) => { delete c.effectivePokemon; }, (c) => { c.effectivePokemon = {}; },
    (c) => { delete c.effectivePokemon.a.types; }, (c) => { c.effectivePokemon.a.types = null; },
    (c) => { c.effectivePokemon.a.types = []; }, (c) => { c.effectivePokemon.a.types = ['Fake']; },
    (c) => { c.effectivePokemon.a.types = ['Water', 'Water']; },
  ]) {
    const invalid = structuredClone(ctx); mutate(invalid);
    assert.throws(() => grantReferences(invalid, spec, 0, invalid.state.players[0].active), TypeError,
      'Even an untyped permission must not silently read the recipient’s printed types.');
  }
});

test('a granted move keeps its own first-turn permission and actual-user conditional cost, not the receiver’s printed move properties', async () => {
  const observed = [];
  const f = await fixture((defs) => {
    give(defs); defs[1].mechanics.attacks[0].cost = ['Fire', 'Fire', 'Fire'];
    defs[1].mechanics.attacks[0].effects = [binding('cn.attackPermissions@1', { permissions: ['first-turn-attack'] }),
      binding('fixture:granted-cost', {})];
  }, new Map([['fixture:granted-cost', reviewed({ timing: 'energyOptions', operations: [], execute: () => [],
    energyOptions: (ctx) => {
      const m = [ctx.state.players[ctx.source.owner].active, ...ctx.state.players[ctx.source.owner].bench].find((m) => m.id === ctx.source.pokemonId);
      if (ctx.source.grantId) observed.push(ctx.source);
      return m.counters > 0 ? { cost: ['Water'] } : null;
    } })]]));
  for (const counters of [0, 1]) {
    const g = board(f, (s) => {
      put(s, 0, 'other', 'discard'); attached(s, 0, s.players[0].active, 'water'); s.players[0].active.counters = counters;
      fixtureClock(s, [0]);
    });
    assert(!move(g, 'base:strike')); assert.equal(Boolean(move(g)), counters > 0);
    if (counters) { attack(g); settle(g); assert.equal(g.snapshot().players[1].active.counters, 2); }
  }
  assert(observed.length); assert(observed.every((s) => s.attackId === 'other:strike' && !s.copyId && s.contentSource.attackId === 'other:strike'));
});

test('direct-use permission never changes what a copier can select as the receiver’s printed owned moves', async () => {
  const copy = { op: 'copyAttack', origins: [{ side: 'opponent', zone: 'field', selector: { kind: 'pokemon' } }],
    excludeUser: false, coin: 'none', energy: 'ignore', special: { mode: 'needsRuling', sourceOfTruth: EVIDENCE } };
  const f = await fixture((defs) => {
    give(defs); defs[1].mechanics.attacks[0].printedDamage = null; defs[1].mechanics.attacks[0].effects = [binding('cn.copyAttack@1', copy)];
  });
  const g = board(f, (s) => {
    put(s, 0, 'other', 'discard'); attached(s, 0, s.players[0].active, 'water');
    const p = s.players[1], m = bench(s, 1, 'other'); p.bench.pop(); p.bench.push(p.active); p.active = m; attached(s, 1, m, 'water');
  });
  assert(move(g)); end(g); command(g, { type: 'attack', attackId: 'other:strike' });
  assert.deepEqual(g.view(1).pending.attacks.map((a) => a.attackId), ['base:strike']);
  answer(g, [g.view(1).pending.attacks[0].optionId]); settle(g);
  assert.equal(g.snapshot().players[0].active.counters, 2);
});

test('used printed content remains executable after recovery out of its original discard permission area', async () => {
  const f = await fixture((defs) => {
    give(defs); defs[1].mechanics.attacks[0].effects = [
      binding('cn.cards@1', { from: 'discard', to: 'hand', selector: { kind: 'pokemon', nameKeys: ['other'] },
        quantity: { kind: 'exact', count: 1 }, reveal: true, lookTop: null, shuffleAfter: false }),
      binding('fixture:optional-draw', {}),
    ];
  }, new Map([['fixture:optional-draw', reviewed({ operations: ['optional', 'draw'],
    execute: () => [{ op: 'optional', effect: { op: 'draw', count: 1 } }] })]]));
  let content;
  const g = board(f, (s) => { content = put(s, 0, 'other', 'discard'); attached(s, 0, s.players[0].active, 'water'); });
  attack(g); answer(g, [content]); assert(g.snapshot().players[0].hand.includes(content));
  assert.equal(g.snapshot().pending.kind, 'optional-effect');
  assert(!g.view(0).players[0].active.effective.attackRequirements.some((a) => a.attackId === 'other:strike'));
  const r = restore(g, f); answer(g, ['perform']); answer(r, ['perform']); settle(g); settle(r);
  assert.deepEqual(r.snapshot(), g.snapshot()); assert.equal(g.snapshot().players[1].active.counters, 2);
});

test('Energy and intrinsic-rule providers have separate provenance; removing Energy removes future permission, not personal battle state', async () => {
  for (const kind of ['energy', 'rule']) {
    const f = await fixture((defs) => {
      if (kind === 'energy') {
        defs.find((d) => d.definitionId === 'double').mechanics.effects = [binding('cn.attackGrant@1', grant())];
        defs[0].mechanics.abilities = [{
          abilityId: 'return', name: '测试返回特殊能量', mode: 'activated',
          usage: { period: 'unlimited', scope: 'pokemon', key: 'return', limit: null }, sourceOfTruth: EVIDENCE,
          effects: [binding('cn.attachedEnergy@1', { op: 'returnEnergy', side: 'own', from: 'self',
            selector: { kind: 'energy', category: 'special' }, measure: 'cards', providedTypes: null,
            quantity: { kind: 'all' }, chooser: 'source', to: 'hand' })],
        }];
      } else defs[0].mechanics.effects = [binding('cn.attackGrant@1', grant())];
    });
    const g = board(f, (s) => {
      put(s, 0, 'other', 'discard'); attached(s, 0, s.players[0].active, 'water');
      if (kind === 'energy') attached(s, 0, s.players[0].active, 'double');
    });
    assert(move(g));
    if (kind === 'energy') {
      const s = g.snapshot(), returned = s.players[0].active.energy.find((id) => s.cards[id].definitionId === 'double');
      command(g, { type: 'useAbility', abilityId: 'return', pokemonId: s.players[0].active.id }); answer(g, [returned]); settle(g);
      assert(!move(g)); assert.equal(g.snapshot().players[0].active.id, s.players[0].active.id);
    } else {
      attack(g); settle(g); assert.equal(g.snapshot().events.find((e) => e.ruleId === 'attack.grant').data.provider.source.category, 'rule');
    }
  }
});

test('a copied future effect validates its entire direct-grant ancestry and rejects cycles or truncated permission proof', async () => {
  const copy = { op: 'copyAttack', origins: [{ side: 'opponent', zone: 'active', selector: { kind: 'pokemon' } }],
    excludeUser: false, coin: 'none', energy: 'ignore', special: { mode: 'needsRuling', sourceOfTruth: EVIDENCE } };
  const f = await fixture((defs) => {
    give(defs); defs[1].mechanics.attacks[0].printedDamage = null; defs[1].mechanics.attacks[0].effects = [binding('cn.copyAttack@1', copy)];
    defs[0].mechanics.attacks[0].effects = [binding('cn.lasting@1', {
      side: 'own', target: 'self', effect: { op: 'modifier', field: 'defenseDamage', amount: -10, scope: 'all' },
      duration: 'untilNextOpponentTurnEnd', clearOnBench: true, clearOnEvolution: true,
    })];
  });
  const g = board(f, (s) => { put(s, 0, 'other', 'discard'); attached(s, 0, s.players[0].active, 'water'); });
  attack(g); answer(g, [g.view(0).pending.attacks[0].optionId]); answer(g, [g.snapshot().players[0].active.id]); settle(g);
  assert(g.snapshot().ongoing[0].source.copyId); assert.deepEqual(restore(g, f).view(0), g.view(0));
  const bad = g.snapshot();
  bad.events.find((e) => e.ruleId === 'attack.grant').data.provider.source.effectId = 'missing';
  assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }), /source|valid/);
  const cycle = g.snapshot(), rec = cycle.events.find((e) => e.ruleId === 'attack.copy' && e.data.kind === 'selected').data;
  rec.source = structuredClone(cycle.ongoing[0].source);
  assert.throws(() => OfficialGame.restore(cycle, { catalog: f.catalog }), /source|valid/);
});
