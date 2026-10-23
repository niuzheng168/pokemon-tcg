import test from 'node:test';
import assert from 'node:assert/strict';
import { copyCandidates, attackOptionId, ATTACK_COPY_RULE_IDS } from '../../public/rules/attack-copy.js';
import { validateCopyAttackParameters } from '../../public/rules/schema-validators.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import { randomIndex } from '../../public/rules/random.js';
import { OfficialGame } from '../../public/rules/game.js';
import { fixture, binding, EVIDENCE, board, start, command, answer, settle, hand, bench, attached } from './fixtures.mjs';

const spec = (extra = {}) => ({ op: 'copyAttack',
  origins: [{ side: 'opponent', zone: 'field', selector: { kind: 'pokemon', nameKeys: ['other'] } }],
  excludeUser: false, coin: 'none', energy: 'ignore',
  special: { mode: 'needsRuling', sourceOfTruth: EVIDENCE }, ...extra });
const copier = (defs, action = spec(), extraEffects = []) => {
  defs[0].mechanics.attacks[0].printedDamage = null;
  defs[0].mechanics.attacks[0].effects = [binding('cn.copyAttack@1', action), ...extraEffects];
};
const opponent = (s) => {
  const p = s.players[1], m = bench(s, 1, 'other'); p.bench.pop(); p.bench.push(p.active); p.active = m; return m;
};
const restore = (g, f) => OfficialGame.restore(JSON.parse(JSON.stringify(g.snapshot())), { catalog: f.catalog });
const attack = (g) => command(g, { type: 'attack', attackId: 'base:strike' });
const choose = (g, id = 'other:strike') => {
  const choice = g.view(0).pending.attacks.find((a) => a.attackId === id);
  assert(choice, `Missing copy option ${id}`); answer(g, [choice.optionId]);
};
const end = (g) => { command(g, { type: 'endTurn' }); settle(g); };
const reviewed = (extra) => ({ rulesetId: 'CN/V20261019', sourceOfTruth: EVIDENCE,
  validateParameters: (p) => Object.keys(p).length === 0, ...extra });
const ability = (id, effects, extra = {}) => ({ abilityId: id, name: `测试复制${id}`, mode: 'activated',
  usage: { period: 'unlimited', scope: 'pokemon', key: id, limit: null }, effects, sourceOfTruth: EVIDENCE, ...extra });
const holdTool = (s, owner, m) => {
  const card = hand(s, owner, 'tool'); s.players[owner].hand.pop(); m.tools.push(card); return card;
};

test('C-18 and D-06 copying have explicit sources and a strict reviewed descriptor, not arbitrary attack JSON', async () => {
  for (const id of ATTACK_COPY_RULE_IDS) assert(requireRule(CN_V20261019, id).sourceOfTruth.length);
  assert(validateCopyAttackParameters(spec()));
  for (const a of [spec({ origins: [] }), spec({ coin: 'automaticHeads' }), spec({ energy: 'free' }),
    spec({ special: { mode: 'consumeUserQuota', sourceOfTruth: [] } }), spec({ attack: { printedDamage: 999 } }),
    spec({ origins: [{ side: 'opponent', zone: 'hand', selector: { kind: 'pokemon' } }] }),
    spec({ origins: [{ side: 'opponent', zone: 'field', selector: { kind: 'any' } }] })])
    assert(!validateCopyAttackParameters(a));
  for (const placement of ['ability', 'item', 'beforeDamage', 'damage']) {
    const h = reviewed({ timing: placement === 'ability' || placement === 'item' ? 'resolve' : placement,
      operations: ['copyAttack'], execute: () => [spec()] });
    const f = await fixture((defs) => {
      if (placement === 'ability') defs[0].mechanics.abilities = [ability('copy', [binding('fixture:copy', {})])];
      else if (placement === 'item') defs.find((d) => d.definitionId === 'potion').mechanics.effects = [binding('fixture:copy', {})];
      else defs[0].mechanics.attacks[0].effects = [binding('fixture:copy', {})];
    }, new Map([['fixture:copy', h]]));
    assert.throws(() => start(f), /Unimplemented or undeclared/);
  }
});

test('C-18 uses the actual user’s types, modifiers, Energy, self-effects and hand; copied content keeps separate provenance', async () => {
  const f = await fixture((defs) => {
    copier(defs); const m = defs[1].mechanics;
    m.hp = 200; m.types = ['Fire']; m.attacks[0].cost = ['Fire', 'Fire', 'Fire']; m.attacks[0].printedDamage.value = 40;
    m.attacks[0].effects = [
      binding('cn.attachedEnergy@1', { op: 'discardEnergy', side: 'own', from: 'self', selector: { kind: 'energy' },
        providedTypes: ['Fire'], measure: 'units', quantity: { kind: 'all' }, chooser: 'source' }),
      binding('cn.heal@1', { target: 'self', amount: 30 }),
      binding('cn.draw@1', { count: 2 }),
    ];
  });
  let borrowed, energy;
  const g = board(f, (s) => {
    borrowed = opponent(s).stack[0]; energy = attached(s, 0, s.players[0].active, 'water');
    holdTool(s, 0, s.players[0].active); s.players[0].active.counters = 4;
  });
  const before = g.snapshot(), actor = before.players[0].active.stack[0], definitions = structuredClone(f.definitions);
  attack(g); assert.equal(g.snapshot().pending.kind, 'copy-attack');
  assert.equal(g.view(1).pending, null); assert.deepEqual(g.view(0).pending.attacks[0].cost, ['Fire', 'Fire', 'Fire']);
  choose(g); settle(g);
  const s = g.snapshot();
  assert.equal(s.players[1].active.counters, 7, 'Water user + own Tool = 70, not the borrowed Fire Pokémon’s Weakness bonus.');
  assert.equal(s.players[0].active.counters, 1, 'Heal the actual user, not the content holder.');
  assert.deepEqual(s.players[0].active.energy, [energy], 'Ignoring selected Energy does not discard declaration Energy.');
  assert.equal(s.players[0].hand.length, before.players[0].hand.length + 2);
  assert.equal(s.players[1].hand.length, before.players[1].hand.length + 1, 'Only their next-turn draw occurs.');
  assert.equal(s.players[0].active.facts.lastUsedAttack.attackId, 'base:strike');
  const damage = s.events.find((e) => e.ruleId === 'attack.order' && e.data.damage === 70);
  assert(damage);
  const chosen = s.events.find((e) => e.ruleId === 'attack.copy' && e.data.kind === 'selected');
  assert.equal(chosen.data.source.instanceId, actor); assert.equal(chosen.data.source.owner, 0);
  assert.equal(chosen.data.reference.instanceId, borrowed);
  assert.equal(damage.data.copyId, chosen.data.id); assert.deepEqual(damage.data.contentSource, chosen.data.reference);
  assert.deepEqual(damage.data.contentSourceOfTruth, f.catalog.definition('other').mechanics.attacks[0].sourceOfTruth);
  assert.deepEqual(f.definitions, definitions);
  assert.equal(f.catalog.definition('other').mechanics.attacks[0].cost.length, 3);
});

test('D-06 printed attack selection excludes granted Tool attacks and deduplicates overlapping public source areas', async () => {
  const f = await fixture((defs) => {
    defs.find((d) => d.definitionId === 'tool').mechanics.grantedAttacks = [{
      ...structuredClone(defs[0].mechanics.attacks[0]), attackId: 'tool:extra',
    }];
  });
  const definitions = Object.fromEntries(f.definitions.map((d) => [d.definitionId, d]));
  const ctx = { source: { owner: 0, pokemonId: 'a' }, definitions,
    effectivePokemon: { a: { types: ['Water'] }, b: { types: ['Water'] }, c: { types: ['Water'] } }, state: {
    players: [
      { active: { id: 'a', stack: ['base', 'evo'], tools: ['tool'] }, bench: [{ id: 'b', stack: ['other'] }], discard: ['discard', 'water'] },
      { active: { id: 'c', stack: ['opponent'] }, bench: [], discard: [] },
    ], cards: { base: { definitionId: 'base' }, evo: { definitionId: 'evolution' }, other: { definitionId: 'other' },
      opponent: { definitionId: 'base' }, discard: { definitionId: 'other' }, water: { definitionId: 'water' }, tool: { definitionId: 'tool' } },
  } };
  const origin = (zone, side = 'own') => ({ side, zone, selector: { kind: 'pokemon' } });
  const field = copyCandidates(ctx, spec({ origins: [origin('field'), origin('active')] }));
  assert.deepEqual(field.map((r) => r.instanceId), ['evo', 'other']);
  assert(!field.some((r) => r.attackId === 'base:strike' || r.attackId === 'tool:extra'));
  assert.deepEqual(copyCandidates(ctx, spec({ origins: [origin('evolution')] })), [{ instanceId: 'base', attackId: 'base:strike' }]);
  assert.deepEqual(copyCandidates(ctx, spec({ origins: [origin('discard')] })), [{ instanceId: 'discard', attackId: 'other:strike' }]);
  assert.deepEqual(copyCandidates(ctx, spec({ origins: [origin('bench')] })), [{ instanceId: 'other', attackId: 'other:strike' }]);
  assert.equal(copyCandidates(ctx, spec({ origins: [origin('field', 'either')] })).length, 3);
  assert.deepEqual(copyCandidates(ctx, spec({ origins: [origin('field')], excludeUser: true })).map((r) => r.instanceId), ['other']);
  assert.deepEqual(copyCandidates(ctx, spec({ origins: [origin('field')], attackIds: ['missing'] })), []);
  ctx.state.players[1].active = null;
  assert.deepEqual(copyCandidates(ctx, spec({ origins: [origin('field', 'opponent')] })), []);
});

test('copy coin gates use the actual seeded RNG exactly once, persist through restore, and cannot be selected by the player', async () => {
  const outcomes = new Map();
  for (let i = 1; outcomes.size < 2 && i < 200; i++) {
    const seed = [i * 8000009 >>> 0, i * 333333331 >>> 0, i * 17 >>> 0, i * 37 >>> 0], next = [...seed];
    outcomes.set(randomIndex(next, 2) === 0 ? 'heads' : 'tails', seed);
  }
  assert.equal(outcomes.size, 2);
  for (const [result, seed] of outcomes) for (const required of ['heads', 'tails']) {
    const f = await fixture((defs) => copier(defs, spec({ coin: required })));
    const g = board(f, (s) => { opponent(s); attached(s, 0, s.players[0].active, 'water'); s.rng = seed; });
    const expected = [...seed]; randomIndex(expected, 2); attack(g);
    assert.deepEqual(g.snapshot().rng, expected);
    if (result === required) {
      assert.equal(g.snapshot().pending.data.copyChoice.coin, result);
      const before = g.snapshot(); assert.throws(() => answer(g, ['heads']), /selection|quantity/); assert.deepEqual(g.snapshot(), before);
      const r = restore(g, f); choose(g); choose(r); settle(g); settle(r); assert.deepEqual(r.snapshot(), g.snapshot());
      assert.equal(g.snapshot().players[1].active.counters, 2);
    } else {
      assert.equal(g.snapshot().pending, null); assert.equal(g.snapshot().players[1].active.counters, 0);
    }
    assert.deepEqual(g.snapshot().rng, expected);
    assert.equal(g.snapshot().events.filter((e) => e.ruleId === 'attack.copy' && e.data.kind === 'coin').length, 1);
  }
});

test('ignored, printed and explicitly effective selected Energy requirements are different, but none spends extra cards', async () => {
  for (const energy of ['ignore', 'printed', 'effective']) {
    const f = await fixture((defs) => {
      copier(defs, spec({ energy })); defs[1].mechanics.attacks[0].cost = ['Fire'];
      defs[0].mechanics.effects = [binding('cn.energyRequirement@1', { effect: {
        op: 'energyRequirement', action: 'attack', mode: 'adjust', scope: 'self', energyType: 'Fire', amount: -1,
      } })];
    });
    let attachedId;
    const g = board(f, (s) => { opponent(s); attachedId = attached(s, 0, s.players[0].active, 'water'); });
    attack(g); if (g.snapshot().pending) choose(g); settle(g);
    assert.equal(g.snapshot().players[1].active.counters, energy === 'printed' ? 0 : 2);
    assert.deepEqual(g.snapshot().players[0].active.energy, [attachedId]);
  }
  const f = await fixture((defs) => copier(defs, spec({ energy: 'printed' })));
  const g = board(f, (s) => { opponent(s); attached(s, 0, s.players[0].active, 'water'); });
  attack(g); choose(g); settle(g); assert.equal(g.snapshot().players[1].active.counters, 2);
});

test('copied formula and E-23 conditions see the actual user and actual evolution history, not the content holder’s history', async () => {
  const seen = [];
  const f = await fixture((defs) => {
    copier(defs); defs[1].mechanics.stage = 'stage1'; defs[1].mechanics.evolvesFrom = 'base';
    defs[1].mechanics.attacks[0].printedDamage = { value: 20, operator: 'plus' };
    defs[1].mechanics.attacks[0].effects = [binding('fixture:evolution-formula', {})];
  }, new Map([['fixture:evolution-formula', reviewed({ timing: 'formula', operations: [], capabilities: ['resolve-attack-damage'],
    execute: () => [], damageFormula: (ctx) => {
      seen.push(ctx.source);
      const m = [ctx.state.players[ctx.source.owner].active, ...ctx.state.players[ctx.source.owner].bench].find((m) => m.id === ctx.source.pokemonId);
      return 20 + (m.facts.evolution?.turn === ctx.state.turn ? 90 : 0);
    } })]]));
  let content;
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water'); const m = s.players[1].active, from = m.stack[0];
    content = hand(s, 1, 'other'); s.players[1].hand.pop(); m.stack.push(content); m.evolvedTurn = s.turn;
    m.facts.evolution = { turn: s.turn, fromCardId: from, toCardId: content, method: 'ordinary', origin: 'hand' };
  });
  const actor = g.snapshot().players[0].active; attack(g); choose(g); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 2);
  assert.equal(seen.length, 1); assert.equal(seen[0].pokemonId, actor.id); assert.equal(seen[0].instanceId, actor.stack[0]);
  assert.equal(seen[0].contentSource.instanceId, content); assert.equal(seen[0].attackId, 'base:strike');
});

test('C-18 Heavy-Impact named restriction does not rename the copier; a general cannot-attack restriction still applies', async () => {
  for (const named of [true, false]) {
    const f = await fixture((defs) => {
      copier(defs);
      defs[0].mechanics.attacks[0].name = '测试灵摆复制';
      defs[1].mechanics.attacks[0].name = '测试终极重锤';
      defs[1].mechanics.attacks[0].effects = [binding('cn.lasting@1', {
        side: 'own', target: 'self', effect: { op: 'restriction', scope: 'all', actions: ['attack'],
          ...(named ? { attackIds: ['other:strike'] } : {}) },
        duration: 'nextOwnTurn', clearOnBench: true, clearOnEvolution: true,
      })];
    });
    const g = board(f, (s) => { opponent(s); attached(s, 0, s.players[0].active, 'water'); });
    attack(g); choose(g); settle(g);
    assert.equal(g.view(0).ongoing[0].source.attackId, 'base:strike');
    assert.equal(g.snapshot().ongoing[0].source.contentSource.attackId, 'other:strike');
    assert.deepEqual(restore(g, f).view(0), g.view(0)); end(g);
    assert.equal(g.view(0).legalActions.some((a) => a.attackId === 'base:strike'), named);
  }
});

test('reviewed named locks can cover the actual user’s same-named attack across different printed attack identities', async () => {
  for (const sameName of [false, true]) {
    const f = await fixture((defs) => {
      copier(defs); defs[0].mechanics.attacks[0].name = sameName ? '测试终极重锤' : '测试灵摆复制';
      defs[1].mechanics.attacks[0].name = '测试终极重锤';
      defs[1].mechanics.attacks[0].effects = [binding('fixture:reviewed-named-lock', {})];
    }, new Map([['fixture:reviewed-named-lock', reviewed({ operations: ['lasting'], execute: (ctx) => [{
      op: 'lasting', side: 'own', target: 'self', duration: 'nextOwnTurn', clearOnBench: true, clearOnEvolution: true,
      effect: { op: 'restriction', scope: 'all', actions: ['attack'], attackIds: [...new Set(Object.values(ctx.definitions)
        .flatMap((d) => [...(d.mechanics.attacks ?? []), ...(d.mechanics.grantedAttacks ?? [])])
        .filter((a) => a.name === '测试终极重锤').map((a) => a.attackId))] },
    }] })]]));
    const g = board(f, (s) => { opponent(s); attached(s, 0, s.players[0].active, 'water'); });
    attack(g); choose(g); settle(g); end(g);
    assert.equal(g.view(0).legalActions.some((a) => a.attackId === 'base:strike'), !sameName);
  }
});

test('nested and cyclic copy choices yield after every selection, restore an explicit stack and end the original turn only once', async () => {
  const f = await fixture((defs) => {
    copier(defs, spec({ origins: [{ side: 'opponent', zone: 'active', selector: { kind: 'pokemon' } }] }));
    defs[0].mechanics.attacks.push({ ...structuredClone(defs[1].mechanics.attacks[0]), attackId: 'base:finish' });
    defs[0].mechanics.hp = 300;
  });
  let g = board(f, (s) => attached(s, 0, s.players[0].active, 'water'));
  const before = g.snapshot(); attack(g);
  for (let i = 0; i < 24; i++) {
    choose(g, 'base:strike');
    assert.equal(g.snapshot().pending.kind, 'copy-attack'); assert.equal(g.snapshot().attack.copies.length, i + 1);
    if (i % 5 === 0) g = restore(g, f);
  }
  choose(g, 'base:finish'); settle(g);
  const s = g.snapshot(); assert.equal(s.current, 1); assert.equal(s.turn, before.turn + 1);
  assert.equal(s.players[1].active.counters, 2); assert.equal(s.attack, null);
  assert.equal(s.events.filter((e) => e.ruleId === 'turn.end').length - before.events.filter((e) => e.ruleId === 'turn.end').length, 1);
  assert.equal(s.players[0].active.facts.lastUsedAttack.attackId, 'base:strike');
});

test('copied before-damage steps, extra packets and ignore options execute in their own damage scope', async () => {
  const f = await fixture((defs) => {
    copier(defs); defs[1].mechanics.attacks[0].printedDamage.value = 40;
    defs[1].mechanics.attacks[0].effects = [
      binding('fixture:before', {}), binding('cn.damageOptions@1', { ignoreDefenderEffects: true }),
      binding('cn.damage@1', { side: 'opponent', target: 'bench', amount: 10, selection: { kind: 'all' }, options: {} }),
    ];
    defs[1].mechanics.effects = [binding('cn.modifier@1', { field: 'defenseDamage', amount: -20, scope: 'self' })];
  }, new Map([['fixture:before', reviewed({ timing: 'beforeDamage', operations: ['counters'],
    execute: () => [{ op: 'counters', side: 'own', target: 'self', count: 1 }] })]]));
  const g = board(f, (s) => { opponent(s); attached(s, 0, s.players[0].active, 'water'); });
  attack(g); choose(g); settle(g);
  assert.equal(g.snapshot().players[0].active.counters, 1);
  assert.equal(g.snapshot().players[1].active.counters, 4, 'Child ignore option affects its primary damage.');
  assert.equal(g.snapshot().players[1].bench[0].counters, 1);
});

test('copied GX/VSTAR handling requires evidence and charges only the actual user under an explicit quota policy', async () => {
  for (const specialRule of ['GX', 'VSTAR']) for (const mode of ['needsRuling', 'consumeUserQuota', 'declaredOnly']) {
    const f = await fixture((defs) => {
      copier(defs, spec({ special: { mode, sourceOfTruth: EVIDENCE } }));
      defs[1].mechanics.attacks[0].specialRule = specialRule; defs[1].mechanics.ruleBox = true; defs[1].mechanics.prizeCount = 2;
    });
    const g = board(f, (s) => { opponent(s); attached(s, 0, s.players[0].active, 'water'); });
    attack(g);
    if (mode === 'needsRuling') {
      const before = g.snapshot(); assert.throws(() => choose(g), (e) => e.code === 'unresolved-copy-special-rule');
      assert.deepEqual(g.snapshot(), before);
    } else {
      choose(g); settle(g); const flag = specialRule === 'GX' ? 'gxUsed' : 'vstarUsed';
      assert.equal(g.snapshot().players[0][flag], mode === 'consumeUserQuota'); assert.equal(g.snapshot().players[1][flag], false);
    }
  }
});

test('quota checks distinguish an earlier used resource from one already consumed by the current declared GX copy attack', async () => {
  for (const declaredGX of [false, true]) {
    const f = await fixture((defs) => {
      copier(defs, spec({ special: { mode: 'consumeUserQuota', sourceOfTruth: EVIDENCE } }));
      defs[1].mechanics.attacks[0].specialRule = 'GX';
      if (declaredGX) defs[0].mechanics.attacks[0].specialRule = 'GX';
    });
    const g = board(f, (s) => { opponent(s); attached(s, 0, s.players[0].active, 'water'); s.players[0].gxUsed = !declaredGX; });
    attack(g);
    if (declaredGX) { choose(g); settle(g); assert.equal(g.snapshot().players[1].active.counters, 2); }
    // スリーパー「ふりこであやつる」: 自分はすでにVSTARパワーを使っているため…えらぶことができません。The only candidate
    // is gone, so the copy does nothing.
    else { settle(g); assert.equal(g.snapshot().players[1].active.counters, 0); assert.equal(g.snapshot().current, 1); }
  }
});

test('copied delayed reaction retains borrowed text and actual owner across restore and a later damage window', async () => {
  const trigger = { event: 'attackDamage', subject: 'self', cause: 'opponentAttackDamage', optional: true, choiceOwner: 'source', scope: 'global' };
  const f = await fixture((defs) => {
    copier(defs); defs[1].mechanics.attacks[0].effects = [binding('cn.delayedReaction@1', {
      side: 'own', target: 'self', trigger, program: [{ op: 'counters', side: 'opponent', target: 'attacker', count: 2 }],
      duration: 'untilNextOpponentTurnEnd', clearOnBench: true, clearOnEvolution: true,
    })];
  });
  const g = board(f, (s) => { const m = opponent(s); attached(s, 1, m, 'water'); attached(s, 0, s.players[0].active, 'water'); });
  attack(g); choose(g); settle(g);
  const ledger = g.snapshot().ongoing[0];
  assert.equal(ledger.source.owner, 0); assert.equal(ledger.source.contentSource.attackId, 'other:strike');
  assert.deepEqual(restore(g, f).view(0), g.view(0));
  for (const mutate of [
    (s) => { s.ongoing[0].source.copyId = 'missing'; },
    (s) => { s.ongoing[0].source.contentSource.attackId = 'missing'; },
    (s) => { delete s.events.find((e) => e.ruleId === 'attack.copy' && e.data.kind === 'selected').data.source; },
    (s) => { s.events.push(structuredClone(s.events.find((e) => e.ruleId === 'attack.copy' && e.data.kind === 'selected'))); },
  ]) {
    const s = g.snapshot(); mutate(s); assert.throws(() => OfficialGame.restore(s, { catalog: f.catalog }), /source|reference|printed|unique|valid/);
  }
  command(g, { type: 'attack', attackId: 'other:strike' }); answer(g, [g.snapshot().players[1].active.id]);
  assert.equal(g.snapshot().pending.kind, 'trigger-optional');
  const r = restore(g, f); answer(g, ['perform']); answer(r, ['perform']); settle(g); settle(r);
  assert.deepEqual(r.snapshot(), g.snapshot());
  assert.equal(g.snapshot().players[0].active.counters, 2); assert.equal(g.snapshot().players[1].active.counters, 4);
});

test('copy choices and suspended scopes reject changed candidates, coin gates, actor identities and forged original content', async () => {
  const f = await fixture((defs) => copier(defs));
  const g = board(f, (s) => { opponent(s); attached(s, 0, s.players[0].active, 'water'); }); attack(g);
  for (const mutate of [
    (s) => { s.pending.data.copyChoice.coin = 'heads'; }, (s) => { s.pending.data.copyChoice.candidates[0].attackId = 'missing'; },
    (s) => { s.pending.data.copyChoice.id = 'missing'; }, (s) => { s.pending.data.source.owner = 1; },
    (s) => { s.attack.attack.name = 'changed'; }, (s) => { s.attack.execution.copyId = 'missing'; },
    (s) => { s.attack.source.category = 'trainer'; }, (s) => { s.attack.source.effectId = 'wrong'; },
    (s) => { s.attack.source.sourceOfTruth = [{ ...EVIDENCE[0], locator: 'changed' }]; },
    (s) => { s.attack.usedSpecialRules = ['GX']; },
    (s) => { delete s.pending.data.stage; }, (s) => { s.queue[0].data.player = 1; },
  ]) {
    const s = g.snapshot(); mutate(s);
    assert.throws(() => OfficialGame.restore(s, { catalog: f.catalog }), (e) => e.name === 'EngineError' && e.code.startsWith('invalid-'));
  }
  const recursive = await fixture((defs) => copier(defs, spec({ origins: [{ side: 'opponent', zone: 'active', selector: { kind: 'pokemon' } }] })));
  const h = board(recursive, (s) => attached(s, 0, s.players[0].active, 'water')); attack(h); choose(h, 'base:strike');
  for (const mutate of [
    (s) => { s.attack.copies[0].execution.reference = s.attack.execution.reference; s.attack.copies[0].execution.copyId = s.attack.execution.copyId; },
    (s) => { s.attack.copies[0].continuation.copyChoice.id = 'missing'; },
    (s) => { s.attack.execution.reference.attackId = 'missing'; },
    (s) => { s.attack.execution.copyId = 'missing'; },
  ]) {
    const s = h.snapshot(); mutate(s);
    assert.throws(() => OfficialGame.restore(s, { catalog: recursive.catalog }), (e) => e.name === 'EngineError' && e.code.startsWith('invalid-'));
  }
  assert.deepEqual(restore(h, recursive).view(0), h.view(0));
});

test('no matching public attack performs no copied damage, and a copied no-op does not unlock an effect then', async () => {
  const f = await fixture((defs) => copier(defs, spec({ attackIds: ['missing'] })));
  const g = board(f, (s) => { opponent(s); attached(s, 0, s.players[0].active, 'water'); });
  attack(g); settle(g); assert.equal(g.snapshot().players[1].active.counters, 0);
  const program = [{ op: 'then', first: spec(), next: { op: 'draw', count: 2 } }];
  const n = await fixture((defs) => {
    copier(defs); defs[0].mechanics.attacks[0].effects = [binding('fixture:copy-then', {})];
    defs[1].mechanics.attacks[0].printedDamage = null;
  }, new Map([['fixture:copy-then', reviewed({ operations: ['then', 'copyAttack', 'draw'], execute: () => program })]]));
  const h = board(n, (s) => { opponent(s); attached(s, 0, s.players[0].active, 'water'); }), before = h.snapshot().players[0].hand.length;
  attack(h); choose(h); settle(h);
  assert.equal(h.snapshot().players[0].hand.length, before); assert.equal(h.snapshot().players[1].active.counters, 0);
});

test('a coin performed inside selected content counts as partial execution, without pretending that its unfulfilled inner copy occurred', async () => {
  const outer = [{ op: 'then', first: spec(), next: { op: 'draw', count: 1 } }];
  const f = await fixture((defs) => {
    copier(defs); defs[0].mechanics.attacks[0].effects = [binding('fixture:outer-copy', {})];
    defs[1].mechanics.attacks[0].printedDamage = null;
    defs[1].mechanics.attacks[0].effects = [binding('cn.copyAttack@1', spec({ coin: 'heads', attackIds: ['missing'] }))];
  }, new Map([['fixture:outer-copy', reviewed({ operations: ['then', 'copyAttack', 'draw'], execute: () => outer })]]));
  const g = board(f, (s) => { opponent(s); attached(s, 0, s.players[0].active, 'water'); });
  const handCount = g.snapshot().players[0].hand.length;
  attack(g); choose(g); settle(g);
  assert.equal(g.snapshot().players[0].hand.length, handCount + 1, 'The chosen attack actually executed its coin instruction.');
  assert.equal(g.snapshot().events.filter((e) => e.ruleId === 'attack.copy' && e.data.kind === 'selected').length, 1,
    'There was no successful inner copy or fabricated second selection.');
  assert.equal(g.snapshot().players[1].active.counters, 0);
});

test('a Tool-granted copying attack retains the Tool declaration source, while the actual Pokémon uses borrowed printed content', async () => {
  const f = await fixture((defs) => {
    const granted = { ...structuredClone(defs[0].mechanics.attacks[0]), attackId: 'tool:copy', printedDamage: null,
      effects: [binding('cn.copyAttack@1', spec())] };
    defs.find((d) => d.definitionId === 'tool').mechanics.grantedAttacks = [granted];
    defs.find((d) => d.definitionId === 'tool').mechanics.effects = [];
    defs[1].mechanics.effects = [binding('cn.restriction@1', { effect: {
      op: 'restriction', scope: 'self', actions: ['attack'],
    } })];
  });
  let physicalTool;
  const g = board(f, (s) => { opponent(s); attached(s, 0, s.players[0].active, 'water'); physicalTool = holdTool(s, 0, s.players[0].active); });
  command(g, { type: 'attack', attackId: 'tool:copy' }); assert.deepEqual(restore(g, f).view(0), g.view(0));
  choose(g); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 2, 'The content holder’s personal attack lock is not the actual user’s lock.');
  const receipt = g.snapshot().events.find((e) => e.ruleId === 'attack.copy' && e.data.kind === 'selected');
  assert.equal(receipt.data.source.instanceId, physicalTool); assert.equal(receipt.data.source.attackId, 'tool:copy');
  assert.equal(g.snapshot().players[0].active.facts.lastUsedAttack.attackId, 'tool:copy');
});

test('effective selected-cost options use actual-user conditions and separate proposed content provenance', async () => {
  const observed = [];
  const f = await fixture((defs) => {
    copier(defs, spec({ energy: 'effective' })); defs[1].mechanics.attacks[0].cost = ['Fire', 'Fire', 'Fire'];
    defs[1].mechanics.attacks[0].effects = [binding('fixture:selected-cost', {})];
  }, new Map([['fixture:selected-cost', reviewed({ timing: 'energyOptions', operations: [], execute: () => [],
    energyOptions: (ctx) => {
      if (!ctx.source.contentSource) return null;
      observed.push(ctx.source);
      const m = ctx.state.players[ctx.source.owner].active;
      return m.counters > 0 ? { cost: [] } : null;
    } })]]));
  for (const counters of [0, 1]) {
    const g = board(f, (s) => { opponent(s); attached(s, 0, s.players[0].active, 'water'); s.players[0].active.counters = counters; });
    attack(g);
    if (counters) { choose(g); settle(g); assert.equal(g.snapshot().players[1].active.counters, 2); }
    else assert.equal(g.snapshot().players[1].active.counters, 0);
  }
  assert(observed.length); assert(observed.every((s) => s.owner === 0 && s.attackId === 'base:strike' && s.contentSource.attackId === 'other:strike'));
});

test('Confusion is checked only for the original declaration, never again for nested copied content', async () => {
  const f = await fixture((defs) => {
    copier(defs, spec({ origins: [{ side: 'opponent', zone: 'active', selector: { kind: 'pokemon' } }] }));
    defs[0].mechanics.attacks.push({ ...structuredClone(defs[1].mechanics.attacks[0]), attackId: 'base:finish' });
  });
  let seed;
  for (let i = 1; i < 100; i++) {
    const testSeed = [i * 8000009 >>> 0, i * 333333331 >>> 0, i * 17 >>> 0, i * 37 >>> 0];
    if (randomIndex([...testSeed], 2) === 0) { seed = testSeed; break; }
  }
  assert(seed);
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); s.players[0].active.conditions.rotation = 'confused'; s.rng = seed; });
  const expected = [...seed]; randomIndex(expected, 2);
  attack(g); choose(g, 'base:strike'); choose(g, 'base:strike'); choose(g, 'base:finish'); settle(g);
  assert.deepEqual(g.snapshot().rng, expected); assert.equal(g.snapshot().players[0].active.counters, 0);
  assert.equal(g.snapshot().players[1].active.counters, 2);
});

test('selected printed content remains valid after its holder leaves play; a suspended caller resumes without re-searching that old zone', async () => {
  const optional = reviewed({ operations: ['optional', 'draw'], execute: () => [{ op: 'optional', effect: { op: 'draw', count: 1 } }] });
  const f = await fixture((defs) => {
    copier(defs);
    defs[1].mechanics.attacks[0].effects = [
      binding('cn.fieldReturn@1', { op: 'returnPokemon', side: 'opponent', target: 'active', selector: { kind: 'pokemon' },
        quantity: { kind: 'exact', count: 1 }, to: 'hand', attachments: 'return', chooser: 'source',
        promotion: { timing: 'afterRelatedResolution', sourceOfTruth: EVIDENCE } }),
      binding('fixture:optional-draw', {}),
    ];
  }, new Map([['fixture:optional-draw', optional]]));
  let reference;
  const g = board(f, (s) => { reference = opponent(s).stack[0]; attached(s, 0, s.players[0].active, 'water'); });
  const ownHand = g.snapshot().players[0].hand.length;
  attack(g); choose(g); answer(g, [g.snapshot().players[1].active.id]);
  assert(g.snapshot().players[1].hand.includes(reference)); assert.equal(g.snapshot().pending.kind, 'optional-effect');
  const r = restore(g, f);
  for (const h of [g, r]) { answer(h, ['perform']); settle(h); }
  assert.deepEqual(g.snapshot(), r.snapshot()); assert.equal(g.snapshot().players[0].hand.length, ownHand + 1);
  assert.equal(g.snapshot().current, 1); assert.equal(g.snapshot().attack, null);
});

test('copying cannot silently replace an empty opposing Active with a Bench target after an unresolved departure schedule', async () => {
  const f = await fixture((defs) => {
    copier(defs, spec({ origins: [{ side: 'own', zone: 'bench', selector: { kind: 'pokemon', nameKeys: ['other'] } }] }));
    defs[0].mechanics.attacks[0].effects.unshift(binding('cn.fieldReturn@1', {
      op: 'returnPokemon', side: 'opponent', target: 'active', selector: { kind: 'pokemon' },
      quantity: { kind: 'exact', count: 1 }, to: 'hand', attachments: 'return', chooser: 'source',
      promotion: { timing: 'afterRelatedResolution', sourceOfTruth: EVIDENCE },
    }));
  });
  const g = board(f, (s) => { opponent(s); bench(s, 0, 'other'); attached(s, 0, s.players[0].active, 'water'); });
  attack(g); answer(g, [g.snapshot().players[1].active.id]);
  assert.equal(g.snapshot().pending.kind, 'copy-attack'); const before = g.snapshot();
  assert.throws(() => choose(g), (e) => e.code === 'unsupported-attack-transition');
  assert.deepEqual(g.snapshot(), before);
});

test('the second player uses its own copy controller, declaration identity and special-resource quota, not the content holder’s', async () => {
  const f = await fixture((defs) => {
    copier(defs, spec({ special: { mode: 'consumeUserQuota', sourceOfTruth: EVIDENCE } }));
    defs[1].mechanics.attacks[0].specialRule = 'GX'; defs[1].mechanics.ruleBox = true; defs[1].mechanics.prizeCount = 2;
  });
  const g = board(f, (s) => {
    const p = s.players[0], m = bench(s, 0, 'other'); p.bench.pop(); p.bench.push(p.active); p.active = m;
    attached(s, 1, s.players[1].active, 'water');
  });
  end(g); command(g, { type: 'attack', attackId: 'base:strike' });
  assert.equal(g.snapshot().pending.player, 1); assert.equal(g.view(0).pending, null);
  answer(g, [g.view(1).pending.attacks.find((a) => a.attackId === 'other:strike').optionId]); settle(g);
  assert.equal(g.snapshot().players[0].active.counters, 2);
  assert.equal(g.snapshot().players[1].gxUsed, true); assert.equal(g.snapshot().players[0].gxUsed, false);
  const receipt = g.snapshot().events.find((e) => e.ruleId === 'attack.copy' && e.data.kind === 'selected');
  assert.equal(receipt.data.source.owner, 1); assert.equal(receipt.data.source.attackId, 'base:strike');
  assert.equal(g.snapshot().cards[receipt.data.reference.instanceId].owner, 0);
});
