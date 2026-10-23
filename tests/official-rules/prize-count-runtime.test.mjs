// Real OfficialGame execution with SYNTHETIC definitions/printings only.
// No fixture, formula probe or successful query approves an actual card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame, assertGameState } from '../../public/rules/game.js';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { validatePrizeDamageParameters } from '../../public/rules/schema-validators.js';
import { PrizeCountError, prizesTakenForPlayer } from '../../public/rules/prize-count.js';
import { CN_V20261019 } from '../../public/rules/index.js';
import { requireRule } from '../../public/rules/registry.js';
import {
  fixture, binding, EVIDENCE, RULESET, board, command, answer, settle, hand, bench, attached, fixtureClock,
} from './fixtures.mjs';

const MAX_DAMAGE = 9007199254740990;
const parameters = (side = 'own', perPrize = 20, base = 10) => ({ side, perPrize, base });
const install = (defs, definitionId, p = parameters(), extra = []) => {
  const a = defs.find((d) => d.definitionId === definitionId).mechanics.attacks[0];
  a.printedDamage = { value: 0, operator: 'plus' };
  a.effects = [binding('cn.prizeDamage@1', p), ...extra]; return a;
};
const make = (p = parameters(), transform = () => {}) => fixture((defs) => {
  defs[0].mechanics.hp = defs[1].mechanics.hp = 500;
  install(defs, 'base', p); transform(defs);
});
const remaining = (s, owner, count) => {
  const p = s.players[owner];
  if (p.prizes.length > count) p.hand.push(...p.prizes.splice(count));
  while (p.prizes.length < count) {
    const id = p.deck.pop(); assert.equal(typeof id, 'string'); p.prizes.push(id);
  }
};
const activeOther = (s, owner = 1) => {
  const p = s.players[owner], old = p.active; p.hand.push(...old.stack, ...old.energy, ...old.tools);
  p.active = bench(s, owner, 'other'); p.bench.pop(); return p.active;
};
const hold = (s, owner, mon) => {
  const id = hand(s, owner, 'tool'); s.players[owner].hand.pop(); mon.tools.push(id); return id;
};
const restore = (g, f) => OfficialGame.restore(JSON.parse(JSON.stringify(g.snapshot())), { catalog: f.catalog });
const attack = (g, id = 'base:strike') => command(g, { type: 'attack', attackId: id });
const damage = (g, from) => g.snapshot().events.slice(from).filter((e) =>
  e.ruleId === 'attack.order' && Object.hasOwn(e.data, 'damage'));
const queryContext = (g, owner = 0) => ({ state: g.snapshot(), source: { owner,
  pokemonId: g.snapshot().players[owner].active.id } });
const ownCards = (s, owner) => Object.values(s.cards).filter((c) => c.owner === owner).length;
const end = (g) => { command(g, { type: 'endTurn' }); settle(g); };
const copySpec = () => ({ op: 'copyAttack',
  origins: [{ side: 'opponent', zone: 'active', selector: { kind: 'pokemon', nameKeys: ['other'] } }],
  excludeUser: false, coin: 'none', energy: 'ignore',
  special: { mode: 'needsRuling', sourceOfTruth: EVIDENCE },
});
const chooseCopy = (g) => {
  const q = g.snapshot().pending; assert.equal(q.kind, 'copy-attack');
  const option = g.view(q.player).pending.attacks.find((a) => a.attackId === 'other:strike'); assert(option);
  return answer(g, [option.optionId]);
};
const assertAtomic = (g, fn, predicate) => {
  const before = g.snapshot(), views = [g.view(0), g.view(1)];
  assert.throws(fn, predicate);
  assert.deepEqual(g.snapshot(), before, 'No partial damage, quota, facts, events, RNG, frame or revision may commit.');
  assert.deepEqual([g.view(0), g.view(1)], views);
};
const needs = (reason) => (e) => {
  assert(e instanceof PrizeCountError); assert.equal(e.code, 'needs-ruling'); assert.equal(e.needsRuling, true);
  assert.equal(e.details.status, 'needsRuling'); assert.equal(e.details.basis, 6); assert.equal(e.details.count, null);
  assert(e.details.reasons.includes(reason)); assert(e.details.sourceOfTruth.length); return true;
};

test('core prizeDamage is a source-backed formula with strict explicit parameters, not an executable game action', async () => {
  const h = createCoreHandlers().get('cn.prizeDamage@1'); assert(h);
  assert.equal(h.rulesetId, 'CN/V20261019'); assert.equal(h.timing, 'formula');
  assert.deepEqual(h.capabilities, ['resolve-attack-damage']); assert.deepEqual(h.operations, []);
  assert.equal(h.parameterSchemaRef, 'urn:pokemon-tcg:core-handler-parameters:1.0.0#/$defs/prizeDamage');
  assert.equal(h.validateParameters, validatePrizeDamageParameters);
  assert.deepEqual(h.sourceOfTruth, requireRule(CN_V20261019, 'prizes.effects-count').sourceOfTruth);
  assert.deepEqual(h.execute({}, parameters()), []);
  for (const side of ['own', 'opponent']) for (const perPrize of [10, MAX_DAMAGE]) for (const base of [0, MAX_DAMAGE])
    assert.equal(h.validateParameters({ side, perPrize, base }), true);
  const invalid = [undefined, null, [], {}, { side: 'own', base: 0 }, { side: 'own', perPrize: 10 },
    { perPrize: 10, base: 0 }, parameters('self'), parameters('current'), parameters('holder'),
    ...[0, -10, 1, 15, 10.5, '10', null, false, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]
      .map((perPrize) => parameters('own', perPrize)),
    ...[-10, 1, 15, 10.5, '0', null, false, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]
      .map((base) => parameters('own', 10, base)),
    ...['deckSize', 'basis', 'initialPrizes', 'remainingPrizes', 'count', 'approved', 'op']
      .map((key) => ({ ...parameters(), [key]: key === 'op' ? 'damage' : 1 }))];
  for (const p of invalid) {
    assert.equal(h.validateParameters(p), false);
    // Bypass the TEST factory's default argument: undefined must remain a
    // missing production parameter, not be replaced by a valid fixture value.
    await assert.rejects(() => fixture((defs) => {
      defs[0].mechanics.attacks[0].printedDamage = { value: 0, operator: 'plus' };
      defs[0].mechanics.attacks[0].effects = [binding('cn.prizeDamage@1', p)];
    }), /Invalid parameters|Invalid normalized card definition/);
  }
});

test('normal60 applies actual 6-minus-remaining formula damage for 1..6 Prizes on either selected side, without KO history', async () => {
  for (const side of ['own', 'opponent']) for (const [remainingCount, expected] of [[1, 110], [2, 90], [3, 70], [4, 50], [5, 30], [6, 10]]) {
    const f = await make(parameters(side)), owner = side === 'own' ? 0 : 1;
    const g = board(f, (s) => {
      attached(s, 0, s.players[0].active, 'water'); remaining(s, owner, remainingCount); remaining(s, 1 - owner, 3);
    }), before = g.snapshot(), definitions = structuredClone(f.definitions);
    assert.equal(before.battleHistory.events.filter((e) => e.kind === 'ko').length, 0);
    assert.equal(ownCards(before, 0), 60); assert.equal(ownCards(before, 1), 60);
    attack(g); settle(g);
    assert.equal(g.snapshot().players[1].active.counters, expected / 10);
    assert.deepEqual(damage(g, before.events.length).map((e) => e.data.damage), [expected]);
    assert.deepEqual(g.snapshot().rng, before.rng); assert.equal(g.snapshot().current, 1);
    assert.deepEqual(g.snapshot().players[0].active.facts.lastUsedAttack, { turn: 5, attackId: 'base:strike' });
    assert.deepEqual(f.definitions, definitions); assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  }
});

test('player1’s own/opponent formulas use source.owner, not an implicit player0 or the attacked card’s holder', async () => {
  for (const [side, expected] of [['own', 30], ['opponent', 90]]) {
    const f = await make(parameters(side));
    const g = board(f, (s) => {
      fixtureClock(s, [0, 1, 0, 1]); attached(s, 1, s.players[1].active, 'water');
      remaining(s, 0, 2); remaining(s, 1, 5);
    }), before = g.snapshot();
    attack(g); settle(g);
    assert.equal(g.snapshot().players[0].active.counters, expected / 10);
    assert.deepEqual(damage(g, before.events.length).map((e) => e.data.damage), [expected]);
    assert.deepEqual(g.snapshot().players[1].active.facts.lastUsedAttack, { turn: 4, attackId: 'base:strike' });
  }
});

test('zero remaining is queried at a naturally reached terminal boundary, never by inventing another legal attack after victory', async () => {
  const f = await make(parameters(), (defs) => { defs[1].mechanics.hp = 100; });
  const g = board(f, (s) => {
    activeOther(s); bench(s, 1, 'base'); attached(s, 0, s.players[0].active, 'water'); remaining(s, 0, 1);
  }), before = g.snapshot();
  attack(g); assert.equal(g.snapshot().pending.kind, 'prize'); settle(g);
  const won = g.snapshot();
  assert.equal(won.players[0].prizes.length, 0); assert.equal(won.phase, 'over');
  assert.equal(won.result.winner, 0); assertGameState(won, f.catalog);
  assert.deepEqual(damage(g, before.events.length).map((e) => e.data.damage), [110]);
  const r = restore(g, f), ctx = queryContext(r);
  assert.equal(prizesTakenForPlayer(ctx, { player: 0, deckSize: 60 }), 6);
  assert.equal(f.catalog.handler('cn.prizeDamage@1').damageFormula(ctx, parameters()), 130);
  assert.deepEqual(r.snapshot(), won, 'The terminal formula query neither applies a second attack nor changes the win.');
  assertAtomic(r, () => attack(r), (e) => e.code === 'game-over');
});

test('the formula derives original deck size from all owned physical cards, regardless of deck/hand/discard/lost distribution', async () => {
  for (const side of ['own', 'opponent']) {
    const f = await make(parameters(side)), counted = side === 'own' ? 0 : 1;
    const g = board(f, (s) => {
      attached(s, 0, s.players[0].active, 'water'); remaining(s, counted, 4);
      for (const [owner, p] of s.players.entries()) {
        const moved = p.deck.splice(0, p.deck.length - 2);
        p.discard.push(...moved.slice(0, 10)); p.lost.push(...moved.slice(10));
        assert(p.hand.length > 0); assert(p.lost.length > 0); assert.equal(ownCards(s, owner), 60);
      }
    }), before = g.snapshot();
    assert.equal(before.players[counted].deck.length, 2);
    attack(g); settle(g); assert.equal(g.snapshot().players[1].active.counters, 5);
    assert.deepEqual(damage(g, before.events.length).map((e) => e.data.damage), [50]);
    assert.equal(ownCards(g.snapshot(), 0), 60); assert.equal(ownCards(g.snapshot(), 1), 60);
  }
});

test('a real two-Prize Knock Out changes D-17 by two, not by the one KO/history entry', async () => {
  const f = await make(parameters(), (defs) => {
    defs[1].mechanics.hp = 10; defs[1].mechanics.ruleBox = true; defs[1].mechanics.prizeCount = 2;
  });
  const g = board(f, (s) => {
    activeOther(s); bench(s, 1, 'base'); attached(s, 0, s.players[0].active, 'water');
  });
  attack(g); settle(g);
  assert.equal(g.snapshot().players[0].prizes.length, 4);
  assert.equal(g.snapshot().battleHistory.events.filter((e) => e.kind === 'ko').length, 1);
  assert.equal(g.snapshot().current, 1); end(g); assert.equal(g.snapshot().current, 0);
  const before = g.snapshot(); attack(g); settle(g);
  assert.deepEqual(damage(g, before.events.length).map((e) => e.data.damage), [50]);
  assert.equal(g.snapshot().players[1].active.counters, 5);
});

test('a zero formula at six remaining is still zero under an attack-damage Tool, rather than resurrected by a bonus', async () => {
  const f = await make(parameters('own', 20, 0));
  const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); hold(s, 0, s.players[0].active); }), before = g.snapshot();
  attack(g); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 0);
  assert.deepEqual(damage(g, before.events.length).map((e) => e.data.damage), [0]);
});

test('prize formula supplies base damage once; the existing attacker, Weakness, Resistance and defender stages still apply', async () => {
  const f = await make(parameters(), (defs) => {
    defs[1].mechanics.weakness = { type: 'Water', operation: 'multiply', value: 2 };
    defs[1].mechanics.resistance = { type: 'Water', value: 20 };
  });
  const g = board(f, (s) => {
    activeOther(s); attached(s, 0, s.players[0].active, 'water'); hold(s, 0, s.players[0].active); remaining(s, 0, 4);
    const id = hand(s, 1, 'stadium'); s.players[1].hand.pop(); s.stadium = id;
  }), before = g.snapshot();
  attack(g); settle(g);
  assert.equal(g.snapshot().players[1].active.counters, 12, '(10 + 2×20 + Tool30) × Weakness2 − Resistance20 − Stadium20.');
  assert.deepEqual(damage(g, before.events.length).map((e) => e.data.damage), [120]);
});

test('real one-Prize tiebreak setup stays needsRuling for both formula sides, atomically preserving a declared GX quota and facts', async () => {
  for (const side of ['own', 'opponent']) {
    const f = await make(parameters(side), (defs) => {
      install(defs, 'other', parameters(side));
      defs[0].mechanics.attacks[0].specialRule = defs[1].mechanics.attacks[0].specialRule = 'GX';
    });
    let g = new OfficialGame({ ruleset: RULESET, catalog: f.catalog, decks: [f.deck, f.deck], seed: f.seed,
      format: 'tiebreak60', matchMode: 'tiebreak' });
    settle(g); end(g); // The first-player first-turn attack prohibition is unrelated.
    const s = g.snapshot(), owner = s.current; attached(s, owner, s.players[owner].active, 'water');
    g = OfficialGame.restore(s, { catalog: f.catalog });
    assert(g.snapshot().players.every((p) => p.prizes.length === 1));
    const setup = g.snapshot().events.filter((e) => e.ruleId === 'setup.prizes');
    assert.equal(setup.length, 2); assert(setup.every((e) => e.data.count === 1));
    const action = g.view(owner).legalActions.find((a) => a.type === 'attack'); assert(action);
    assertAtomic(g, () => command(g, action), needs('tiebreak-scope-unresolved'));
    assert.equal(g.snapshot().players[owner].gxUsed, false);
    assert.equal(g.snapshot().players[owner].active.facts.lastUsedAttack, undefined);
  }
});

test('a physically conserved normal snapshot with seven remaining counts zero taken, never a negative number (JP Q&A)', async () => {
  for (const side of ['own', 'opponent']) {
    const f = await make(parameters(side), (defs) => { defs[0].mechanics.attacks[0].specialRule = 'VSTAR'; });
    const g = board(f, (s) => {
      attached(s, 0, s.players[0].active, 'water'); remaining(s, side === 'own' ? 0 : 1, 7);
    }), before = g.snapshot();
    assertGameState(before, f.catalog);
    attack(g); settle(g);
    assert.deepEqual(damage(g, before.events.length).map((e) => e.data.damage), [10], 'Base 10 + 0 taken × 20.');
    assert.equal(g.snapshot().players[0].vstarUsed, true);
  }
});

test('C-18 own/opponent counts belong to the actual user, not the foreign content holder, and copy prompts survive restore', async () => {
  for (const [side, expected] of [['own', 70], ['opponent', 160]]) {
    const f = await make(parameters(), (defs) => {
      const root = defs[0].mechanics.attacks[0]; root.printedDamage = null;
      root.effects = [binding('cn.copyAttack@1', copySpec())];
      install(defs, 'other', parameters(side, 30, 10)); defs[1].mechanics.types = ['Fire'];
      defs[1].mechanics.attacks[0].cost = ['Fire', 'Fire', 'Fire'];
    });
    let content;
    const g = board(f, (s) => {
      content = activeOther(s).stack[0]; attached(s, 0, s.players[0].active, 'water');
      remaining(s, 0, 4); remaining(s, 1, 1);
    }), before = g.snapshot(), definitions = structuredClone(f.definitions);
    attack(g); const r = restore(g, f);
    chooseCopy(g); chooseCopy(r); settle(g); settle(r);
    const after = g.snapshot(), packet = damage(g, before.events.length).at(-1);
    assert.deepEqual(r.snapshot(), after); assert.equal(after.players[1].active.counters, expected / 10);
    assert.equal(packet.data.damage, expected); assert.equal(packet.data.contentSource.instanceId, content);
    const selected = after.events.findLast((e) => e.ruleId === 'attack.copy' && e.data.kind === 'selected');
    assert.equal(selected.data.source.owner, 0); assert.equal(selected.data.source.pokemonId, before.players[0].active.id);
    assert.equal(selected.data.reference.instanceId, content); assert.equal(packet.data.copyId, selected.data.id);
    assert.deepEqual(after.players[0].active.facts.lastUsedAttack, { turn: 5, attackId: 'base:strike' });
    assert.deepEqual(after.rng, before.rng); assert.deepEqual(f.definitions, definitions);
  }
});

test('an unresolved copied formula rejects only the answering transaction, retaining its committed original declaration and RNG', async () => {
  const f = await make(parameters(), (defs) => {
    const root = defs[0].mechanics.attacks[0]; root.printedDamage = null; root.effects = [binding('cn.copyAttack@1', copySpec())];
    install(defs, 'other', parameters());
  });
  const g = board(f, (s) => { activeOther(s); attached(s, 0, s.players[0].active, 'water'); remaining(s, 0, 1); s.matchMode = 'tiebreak'; });
  attack(g); assert.equal(g.snapshot().pending.kind, 'copy-attack');
  const checkpoint = g.snapshot(); assertAtomic(g, () => chooseCopy(g), needs('tiebreak-scope-unresolved'));
  assert.deepEqual(restore(g, f).snapshot(), checkpoint);
});

test('BigInt prize damage overflow rejects the whole attack transaction without rounding, partial damage or quota consumption', async () => {
  for (const [p, remainingCount] of [[parameters('own', MAX_DAMAGE, 0), 4], [parameters('own', 10, MAX_DAMAGE), 5],
    [parameters('opponent', MAX_DAMAGE, 0), 1], [parameters('opponent', 20, MAX_DAMAGE - 10), 4]]) {
    assert.equal(validatePrizeDamageParameters(p), true);
    const f = await make(p, (defs) => { defs[0].mechanics.attacks[0].specialRule = 'GX'; });
    const g = board(f, (s) => {
      attached(s, 0, s.players[0].active, 'water'); remaining(s, p.side === 'own' ? 0 : 1, remainingCount);
    });
    assertAtomic(g, () => attack(g), (e) => e instanceof RangeError && /Prize-based damage exceeds/.test(e.message));
    assert.equal(g.snapshot().players[0].gxUsed, false);
  }
});

test('the largest exact ten-point damage is representable at the boundary, while zero obtained never multiplies it into overflow', async () => {
  for (const [p, remainingCount, expected] of [
    [parameters('own', MAX_DAMAGE, 0), 5, MAX_DAMAGE],
    [parameters('own', MAX_DAMAGE, 10), 6, 10],
    [parameters('own', 10, MAX_DAMAGE - 10), 5, MAX_DAMAGE],
  ]) {
    const f = await make(p);
    const g = board(f, (s) => { attached(s, 0, s.players[0].active, 'water'); remaining(s, 0, remainingCount); }), before = g.snapshot();
    attack(g); settle(g);
    assert.deepEqual(damage(g, before.events.length).map((e) => e.data.damage), [expected]);
    assert(damage(g, before.events.length).every((e) => Number.isSafeInteger(e.data.damage) && e.data.damage % 10 === 0));
    assert.deepEqual(restore(g, f).snapshot(), g.snapshot());
  }
});

test('player attack commands cannot supply counting/shape overrides, and invalid original-card identity cannot be restored', async () => {
  const f = await make(), g = board(f, (s) => attached(s, 0, s.players[0].active, 'water'));
  for (const extra of [{ deckSize: 30 }, { remainingPrizes: 0 }, { basis: 1 }, { side: 'opponent' },
    { damage: 9990 }, { parameters: parameters('opponent') }])
    assertAtomic(g, () => command(g, { type: 'attack', attackId: 'base:strike', ...extra }), (e) => e.code === 'invalid-command');
  const original = g.snapshot(), id = original.players[0].deck[0];
  for (const mutate of [
    (s) => { delete s.cards[id]; },
    (s) => { s.cards[id].owner = 1; },
    (s) => { s.players[0].deck.splice(s.players[0].deck.indexOf(id), 1); delete s.cards[id]; },
  ]) {
    const bad = structuredClone(original); mutate(bad);
    assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }));
    assert.deepEqual(g.snapshot(), original);
  }
});

test('formula-only bindings cannot become Item/Ability instructions, and multiple damage formulas reject atomically', async () => {
  for (const slot of ['item', 'ability']) {
    const f = await fixture((defs) => {
      const effects = [binding('cn.prizeDamage@1', parameters())];
      if (slot === 'item') defs.find((d) => d.definitionId === 'potion').mechanics.effects = effects;
      else defs[0].mechanics.abilities = [{ abilityId: 'bad-formula', name: '测试错误位置', mode: 'activated',
        usage: { period: 'unlimited', scope: 'pokemon', key: 'bad-formula', limit: null }, effects, sourceOfTruth: EVIDENCE }];
    });
    assert.throws(() => board(f), /Unimplemented or undeclared/);
  }
  const f = await make(parameters(), (defs) => {
    defs[0].mechanics.attacks[0].effects.push(binding('cn.prizeDamage@1', parameters('opponent'), 'second-formula'));
  });
  const g = board(f, (s) => attached(s, 0, s.players[0].active, 'water'));
  assertAtomic(g, () => attack(g), (e) => e.code === 'unsupported-formula');
});

test('post-damage target choice and JSON restore do not rerun the formula or reapply damage', async () => {
  const f = await make(parameters(), (defs) => install(defs, 'base', parameters(), [
    binding('cn.heal@1', { target: 'self', amount: 30 }),
  ]));
  const g = board(f, (s) => {
    attached(s, 0, s.players[0].active, 'water'); s.players[0].active.counters = 3; remaining(s, 0, 4);
  }), before = g.snapshot();
  attack(g); assert.equal(g.snapshot().pending.kind, 'effect-target');
  assert.equal(g.snapshot().players[1].active.counters, 5);
  const checkpoint = g.snapshot(), r = restore(g, f);
  assert.deepEqual(r.snapshot(), checkpoint);
  answer(g, [checkpoint.players[0].active.id]); answer(r, [checkpoint.players[0].active.id]); settle(g); settle(r);
  const after = g.snapshot(); assert.deepEqual(r.snapshot(), after);
  assert.equal(after.players[1].active.counters, 5); assert.equal(after.players[0].active.counters, 0);
  assert.deepEqual(damage(g, before.events.length).map((e) => e.data.damage), [50]);
  assert.deepEqual(after.rng, before.rng);
});
