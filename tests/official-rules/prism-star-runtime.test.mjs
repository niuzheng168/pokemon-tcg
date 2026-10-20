// Synthetic Prism Star rule fixtures, never real-card/printing approvals.
// Expected destinations below are literal physical-card oracles, not results
// obtained from the production discard replacement or Energy-unit helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialGame } from '../../public/rules/game.js';
import { validateDeck } from '../../public/rules/catalog.js';
import { paymentOptionId } from '../../public/rules/activation-cost.js';
import {
  fixture, binding, EVIDENCE, board, fixtureClock, hand, bench, attached, command, answer, settle,
} from './fixtures.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const mons = (s, owner) => [s.players[owner].active, ...s.players[owner].bench].filter(Boolean);
const fee = (costId = 'fee', count = 1, selector = { kind: 'energy' }) => ({
  costId, kind: 'discardHand', count, selector, sourceOfTruth: EVIDENCE,
});
const ability = (id, effects, costs) => ({
  abilityId: id, name: `测试棱镜之星${id}`, mode: 'activated',
  usage: { period: 'turn', scope: 'pokemon', key: id, limit: 1 }, effects, sourceOfTruth: EVIDENCE,
  ...(costs ? { costs } : {}),
});
const cards = (from, to, selector = { kind: 'any' }, count = 1) => ({
  from, to, selector, quantity: { kind: 'exact', count }, reveal: true, lookTop: null, shuffleAfter: false,
});
const energyAction = (extra = {}) => ({
  op: 'discardEnergy', side: 'own', from: 'active', selector: { kind: 'energy' },
  providedTypes: null, measure: 'cards', quantity: { kind: 'exact', count: 1 }, chooser: 'source', ...extra,
});
async function make(stars = [], transform = () => {}) {
  const f = await fixture((defs) => {
    for (const id of stars) {
      const d = defs.find((d) => d.definitionId === id); assert(d);
      d.prismStar = { sourceOfTruth: clone(EVIDENCE) }; d.deckLimits.sameName = 1;
      if (d.kind === 'pokemon') d.mechanics.ruleBox = true;
    }
    transform(defs);
  });
  // The standard fixture deliberately has two base/other copies. Replace
  // surplus flagged copies with existing Basic Water printings, not new IDs.
  const seen = new Set();
  f.deck = f.deck.map((id) => {
    const d = f.catalog.definitionFor(id);
    if (!d.prismStar) return id;
    if (seen.has(d.nameKey)) return 'printing:water';
    seen.add(d.nameKey); return id;
  });
  assert.equal(f.deck.length, 60); validateDeck(f.catalog, f.deck);
  return f;
}
function conservation(s, originalCards) {
  assert.deepEqual(s.cards, originalCards);
  const all = [];
  for (const owner of [0, 1]) {
    const p = s.players[owner], ids = ['deck', 'hand', 'discard', 'lost', 'prizes', 'resolving'].flatMap((z) => p[z]);
    ids.push(...mons(s, owner).flatMap((m) => [...m.stack, ...m.energy, ...m.tools]));
    if (s.stadium && s.cards[s.stadium].owner === owner) ids.push(s.stadium);
    assert.equal(ids.length, 60); assert.equal(new Set(ids).size, 60);
    assert.deepEqual(new Set(ids), new Set(Object.keys(originalCards).filter((id) => originalCards[id].owner === owner)));
    all.push(...ids);
  }
  assert.equal(new Set(all).size, 120);
}
function restore(g, f) {
  const saved = g.snapshot(), r = OfficialGame.restore(clone(saved), { catalog: f.catalog });
  assert.deepEqual(r.snapshot(), saved); assert.deepEqual([r.view(0), r.view(1)], [g.view(0), g.view(1)]);
  conservation(r.snapshot(), saved.cards); return r;
}
function atomic(g, run, label) {
  const saved = g.snapshot(), views = [g.view(0), g.view(1)];
  assert.throws(run, undefined, label);
  assert.deepEqual(g.snapshot(), saved, `${label}: no partial payment, use, movement, history, RNG or revision.`);
  assert.deepEqual([g.view(0), g.view(1)], views); conservation(g.snapshot(), saved.cards);
}
function atDestination(s, id, zone) {
  const owner = s.cards[id].owner;
  assert.equal(s.players[owner][zone].filter((cardId) => cardId === id).length, 1);
  assert(!s.players[owner][zone === 'lost' ? 'discard' : 'lost'].includes(id));
  assert(!s.players[1 - owner].discard.includes(id)); assert(!s.players[1 - owner].lost.includes(id));
}
function exactHand(s, owner, names) {
  const p = s.players[owner], ids = [];
  p.deck.push(...p.hand.splice(0));
  for (const name of names) {
    const id = hand(s, owner, name); p.hand.pop(); p.resolving.push(id); ids.push(id);
  }
  for (const id of ids) { p.resolving.splice(p.resolving.indexOf(id), 1); p.hand.push(id); }
  return ids;
}
function tool(s, owner, mon, name) {
  const id = hand(s, owner, name); s.players[owner].hand.pop(); mon.tools.push(id); return id;
}
function moveFromHand(s, owner, id, zone) {
  const p = s.players[owner]; p.hand.splice(p.hand.indexOf(id), 1); p[zone].push(id);
}
const play = (g, sourceId) => command(g, { type: 'playTrainer', cardId: sourceId });
const use = (g, id) => command(g, { type: 'useAbility', pokemonId: g.snapshot().players[g.snapshot().current].active.id, abilityId: id });

test('root prismStar admission is explicit and evidence-backed; malformed flag, ordinary limit, Evolution, non-Rule-Box Pokémon and Basic Energy cannot enter a catalog', async () => {
  const valid = await make(['base', 'double', 'potion']);
  for (const id of ['base', 'double', 'potion']) {
    assert.deepEqual(valid.catalog.definition(id).prismStar, { sourceOfTruth: EVIDENCE });
    assert.equal(valid.catalog.definition(id).deckLimits.sameName, 1);
  }
  assert.equal(valid.catalog.definition('base').mechanics.stage, 'basic');
  assert.equal(valid.catalog.definition('base').mechanics.ruleBox, true);
  assert.equal(valid.catalog.definition('double').mechanics.category, 'special');
  for (const [stars, mutate] of [
    [['potion'], (ds) => { ds.find((d) => d.definitionId === 'potion').prismStar = null; }],
    [['potion'], (ds) => { ds.find((d) => d.definitionId === 'potion').prismStar.sourceOfTruth = []; }],
    [['potion'], (ds) => { ds.find((d) => d.definitionId === 'potion').prismStar.approved = true; }],
    [['potion'], (ds) => { ds.find((d) => d.definitionId === 'potion').deckLimits.sameName = 4; }],
    [['base'], (ds) => { ds[0].mechanics.ruleBox = false; }],
    [['evolution'], () => {}], [['water'], () => {}],
  ]) await assert.rejects(make(stars, mutate));
});

test('one-per-name Prism Star limits aggregate printings/definitions with the same name but do not impose a one-Prism-per-deck rule', async () => {
  const f = await make(['base', 'double', 'tool'], (defs) => {
    const reprint = clone(defs[0]); reprint.definitionId = 'base-reprint'; defs.push(reprint);
  });
  validateDeck(f.catalog, f.deck);
  const repeated = [...f.deck], index = repeated.indexOf('printing:water');
  repeated[index] = 'printing:base-reprint';
  assert.throws(() => validateDeck(f.catalog, repeated), /Too many copies/);
  const g = board(f); conservation(g.snapshot(), g.snapshot().cards); restore(g, f);
});

test('Prism Item/Supporter stays in resolving through its real effect prompt and JSON restore, then enters Lost once; ordinary controls still discard', async () => {
  for (const starred of [false, true]) for (const source of ['potion', 'research']) {
    const f = await make(starred ? [source] : [], (defs) => {
      defs.find((d) => d.definitionId === source).mechanics.effects = [binding('cn.heal@1',
        { target: 'any', amount: 30 }, `prism:${source}:heal`)];
    });
    let sourceId, target;
    const g = board(f, (s) => {
      fixtureClock(s, [0, 1, 0, 1]); sourceId = hand(s, 1, source);
      s.players[1].active.counters = 4; target = bench(s, 1, 'other'); target.counters = 5;
    }), before = g.snapshot();
    play(g, sourceId);
    assert.equal(g.snapshot().pending.kind, 'effect-target');
    assert(g.snapshot().players[1].resolving.includes(sourceId));
    assert(!g.snapshot().players[1].lost.includes(sourceId)); assert(!g.snapshot().players[1].discard.includes(sourceId));
    const r = restore(restore(g, f), f); answer(r, [target.id]); settle(r);
    atDestination(r.snapshot(), sourceId, starred ? 'lost' : 'discard');
    assert.equal(r.snapshot().players[1].bench.find((m) => m.id === target.id).counters, 2);
    assert.equal(r.snapshot().players[1].flags.supporter, source === 'research');
    assert.deepEqual(r.snapshot().rng, before.rng); conservation(r.snapshot(), before.cards); restore(r, f);
  }
});

test('simultaneous native KOs route every stack/Energy/Tool card independently by immutable flag and its original physical owner', async () => {
  const f = await make(['base', 'double', 'tool'], (defs) => {
    defs.find((d) => d.definitionId === 'potion').mechanics.effects = [
      binding('cn.counters@1', { side: 'own', target: 'active', count: 2 }, 'prism:ko-own'),
      binding('cn.counters@1', { side: 'opponent', target: 'active', count: 2 }, 'prism:ko-opponent'),
    ];
  });
  let sourceId, victimIds, lostIds, discardIds;
  const g = board(f, (s) => {
    const a = s.players[0].active, b = s.players[1].active;
    const evolution = hand(s, 0, 'evolution'); s.players[0].hand.pop(); a.stack.push(evolution);
    sourceId = hand(s, 0, 'potion');
    const aStarEnergy = attached(s, 0, a, 'double'), aWater = attached(s, 0, a, 'water');
    const bStarEnergy = attached(s, 1, b, 'double'), bWater = attached(s, 1, b, 'water');
    const aTool = tool(s, 0, a, 'tool'), bTool = tool(s, 1, b, 'hp-tool');
    a.counters = 14; b.counters = 14;
    bench(s, 0, 'other'); bench(s, 1, 'other');
    victimIds = [a.id, b.id];
    lostIds = [a.stack[0], b.stack[0], aStarEnergy, bStarEnergy, aTool];
    discardIds = [evolution, aWater, bWater, bTool, sourceId];
  }), before = g.snapshot();
  play(g, sourceId); answer(g, [victimIds[0]]);
  const r = restore(g, f); answer(r, [victimIds[1]]); settle(r);
  const after = r.snapshot();
  for (const id of lostIds) atDestination(after, id, 'lost');
  for (const id of discardIds) atDestination(after, id, 'discard');
  assert.equal(after.battleHistory.events.filter((e) => e.kind === 'ko' && victimIds.includes(e.pokemonId)).length, 2);
  for (const owner of [0, 1]) {
    assert(!mons(after, owner).some((m) => victimIds.includes(m.id)));
    assert.equal(after.players[owner].prizes.length, before.players[owner].prizes.length - 1);
  }
  assert.deepEqual(after.rng, before.rng); conservation(after, before.cards); restore(r, f);
});

test('complete mixed cost groups accept a Prism card in Lost as paid, preserve the pending source and exact receipt across restore, and reject overlapping/partial fees atomically', async () => {
  const f = await make(['double', 'potion'], (defs) => {
    const d = defs.find((d) => d.definitionId === 'potion');
    d.mechanics.playCosts = [fee('energy'), fee('any', 1, { kind: 'any' })];
    d.mechanics.effects = [binding('cn.heal@1', { target: 'any', amount: 30 }, 'prism:paid-heal')];
  });
  let ids, target;
  const g = board(f, (s) => {
    ids = exactHand(s, 0, ['potion', 'double', 'water']);
    s.players[0].active.counters = 5; target = bench(s, 0, 'other'); target.counters = 4;
  }), before = g.snapshot();
  play(g, ids[0]); assert.equal(g.snapshot().pending.kind, 'activation-cost');
  const selected = [paymentOptionId('energy', ids[1]), paymentOptionId('any', ids[2])];
  atomic(g, () => answer(g, selected.slice(0, 1)), 'Incomplete fee groups');
  atomic(g, () => answer(g, [paymentOptionId('energy', ids[1]), paymentOptionId('any', ids[1])]), 'One card cannot pay twice');
  let r = restore(g, f); answer(r, selected);
  assert.equal(r.snapshot().pending.kind, 'effect-target'); atDestination(r.snapshot(), ids[1], 'lost'); atDestination(r.snapshot(), ids[2], 'discard');
  assert(r.snapshot().players[0].resolving.includes(ids[0])); assert(!r.snapshot().players[0].lost.includes(ids[0]));
  const receipt = r.snapshot().pending.data.payment;
  assert.deepEqual(receipt.groups, [{ costId: 'energy', cardIds: [ids[1]] }, { costId: 'any', cardIds: [ids[2]] }]);
  r = restore(restore(r, f), f); answer(r, [target.id]); settle(r);
  atDestination(r.snapshot(), ids[0], 'lost');
  assert.equal(r.snapshot().players[0].bench.find((m) => m.id === target.id).counters, 1);
  assert.equal(r.snapshot().events.slice(before.events.length).filter((e) => e.ruleId === 'effects.activation-cost').length, 1);
  assert.deepEqual(r.snapshot().rng, before.rng); conservation(r.snapshot(), before.cards); restore(r, f);
});

test('a two-unit Prism Special Energy is only one physical hand card and cannot pay a two-card activation cost', async () => {
  const f = await make(['double'], (defs) => {
    const d = defs.find((d) => d.definitionId === 'potion');
    d.mechanics.playCosts = [fee('fee', 2)]; d.mechanics.effects = [binding('cn.draw@1', { count: 1 }, 'prism:two-card-result')];
  });
  let ids;
  const g = board(f, (s) => { ids = exactHand(s, 0, ['potion', 'double']); });
  assert.equal(f.catalog.definition('double').mechanics.baseUnits.length, 2);
  assert(!g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === ids[0]));
  atomic(g, () => play(g, ids[0]), 'One physical Prism cannot pay two hand cards');
  restore(g, f);
});

test('routing the payable Prism fee to Lost cannot make a healing-only Item or activated Ability with no useful body available', async () => {
  for (const slot of ['item', 'ability']) {
    const f = await make(['double'], (defs) => {
      const effects = [binding('cn.heal@1', { target: 'any', amount: 30 }, `prism:${slot}:unusable-heal`)];
      if (slot === 'item') {
        const d = defs.find((d) => d.definitionId === 'potion'); d.mechanics.effects = effects; d.mechanics.playCosts = [fee()];
      } else defs[0].mechanics.abilities.push(ability('paid', effects, [fee()]));
    });
    let ids;
    const g = board(f, (s) => { ids = exactHand(s, 0, slot === 'item' ? ['potion', 'double'] : ['double']); });
    const action = slot === 'item' ? { type: 'playTrainer', cardId: ids[0] } :
      { type: 'useAbility', pokemonId: g.snapshot().players[0].active.id, abilityId: 'paid' };
    assert(!g.view(0).legalActions.some((a) => a.type === action.type && (slot === 'item' ? a.cardId === ids[0] : a.abilityId === 'paid')));
    atomic(g, () => command(g, action), `${slot}: a fee entering Lost is not a body result`);
    restore(g, f);
  }
});

test('native discardHand sends just the flagged physical hand cards to Lost, excludes the resolving Supporter and still performs its independent draw', async () => {
  const f = await make(['double', 'tool'], (defs) => {
    defs.find((d) => d.definitionId === 'research').mechanics.effects = [
      binding('cn.discardHand@1', {}, 'prism:discard-hand'), binding('cn.draw@1', { count: 1 }, 'prism:following-draw'),
    ];
  });
  let ids;
  const g = board(f, (s) => { ids = exactHand(s, 0, ['research', 'double', 'tool', 'water', 'other']); }), before = g.snapshot();
  play(g, ids[0]); settle(g);
  for (const id of ids.slice(1, 3)) atDestination(g.snapshot(), id, 'lost');
  for (const id of [ids[0], ...ids.slice(3)]) atDestination(g.snapshot(), id, 'discard');
  assert.deepEqual(g.snapshot().players[0].hand, [before.players[0].deck.at(-1)]);
  assert.equal(g.snapshot().players[0].flags.supporter, true);
  assert.deepEqual(g.snapshot().rng, before.rng); conservation(g.snapshot(), before.cards); restore(g, f);
});

test('native cards from hand or deck to discard applies the same immutable replacement after an explicit selected-card request and JSON restore', async () => {
  for (const from of ['hand', 'deck']) {
    const f = await make(['double'], (defs) => {
      defs.find((d) => d.definitionId === 'potion').mechanics.effects = [
        binding('cn.cards@1', { ...cards(from, 'discard', { kind: 'energy' }, 2),
          ...(from === 'deck' ? { lookTop: 2 } : {}) }, `prism:cards-${from}`),
      ];
    });
    let ids;
    const g = board(f, (s) => {
      ids = exactHand(s, 0, ['potion', 'double', 'water']);
      if (from === 'deck') for (const id of ids.slice(1)) moveFromHand(s, 0, id, 'deck');
    }), before = g.snapshot();
    play(g, ids[0]); assert.equal(g.snapshot().pending.kind, 'select-cards');
    const r = restore(g, f); answer(r, ids.slice(1)); settle(r);
    atDestination(r.snapshot(), ids[1], 'lost'); atDestination(r.snapshot(), ids[2], 'discard');
    atDestination(r.snapshot(), ids[0], 'discard');
    assert.deepEqual(r.snapshot().rng, before.rng); conservation(r.snapshot(), before.cards); restore(r, f);
  }
});

test('attached discard, retention after evolution and Retreat all route Prism Energy to Lost, with opponent-target discard credited to the original card owner', async () => {
  for (const route of ['opponent-discard', 'retention', 'retreat']) {
    const f = await make(['double'], (defs) => {
      if (route === 'opponent-discard') defs[0].mechanics.abilities.push(ability('discard-energy', [
        binding('cn.attachedEnergy@1', energyAction({ side: 'opponent' }), 'prism:opponent-energy'),
      ]));
      if (route === 'retention') defs.find((d) => d.definitionId === 'double').mechanics.remainOn = { kind: 'pokemon', stages: ['basic'] };
      if (route === 'retreat') defs[0].mechanics.retreatCost = 2;
    });
    let id;
    const owner = route === 'opponent-discard' ? 1 : 0;
    const g = board(f, (s) => {
      id = attached(s, owner, s.players[owner].active, 'double');
      if (route === 'retention') hand(s, 0, 'evolution');
      if (route === 'retreat') bench(s, 0, 'other');
    }), before = g.snapshot();
    if (route === 'opponent-discard') {
      use(g, 'discard-energy'); const r = restore(g, f); answer(r, [id]); settle(r);
      atDestination(r.snapshot(), id, 'lost'); assert.equal(r.snapshot().players[1].active.energy.length, 0);
      conservation(r.snapshot(), before.cards); restore(r, f);
    } else if (route === 'retention') {
      const action = g.view(0).legalActions.find((a) => a.type === 'evolve'); assert(action); command(g, action); settle(g);
      atDestination(g.snapshot(), id, 'lost'); assert.equal(g.snapshot().players[0].active.energy.length, 0);
      conservation(g.snapshot(), before.cards); restore(g, f);
    } else {
      command(g, { type: 'retreat' }); assert.equal(g.snapshot().pending.kind, 'retreat-energy');
      let r = restore(g, f); answer(r, [id]);
      assert.equal(r.snapshot().pending.kind, 'retreat-target'); atDestination(r.snapshot(), id, 'lost');
      r = restore(r, f); settle(r);
      assert.equal(r.snapshot().players[0].flags.retreat, true); atDestination(r.snapshot(), id, 'lost');
      conservation(r.snapshot(), before.cards); restore(r, f);
    }
  }
});

test('one-card attack self-payment accepts a two-unit Prism card entering Lost and retains its passed receipt through a subsequent body prompt/restore', async () => {
  const f = await make(['double'], (defs) => {
    const a = defs[0].mechanics.attacks[0];
    a.failureCheck = { handPayment: { op: 'discardHand', count: 1, selector: { kind: 'energy', category: 'special' } },
      sourceOfTruth: EVIDENCE };
    a.effects = [binding('cn.heal@1', { target: 'any', amount: 10 }, 'prism:attack-heal')];
  });
  let feeId;
  const g = board(f, (s) => {
    [feeId] = exactHand(s, 0, ['double']); attached(s, 0, s.players[0].active, 'water');
    s.players[0].active.counters = 2; bench(s, 0, 'other').counters = 1;
  }), before = g.snapshot();
  command(g, { type: 'attack', attackId: 'base:strike' }); assert.equal(g.snapshot().pending.kind, 'attack-payment');
  let r = restore(g, f); answer(r, [feeId]);
  assert.equal(r.snapshot().pending.kind, 'effect-target'); atDestination(r.snapshot(), feeId, 'lost');
  assert.equal(r.snapshot().attack.execution.failureReceipt.passed, true);
  assert.deepEqual(r.snapshot().attack.execution.failureReceipt.selected, [feeId]);
  r = restore(restore(r, f), f); answer(r, [before.players[0].active.id]); settle(r);
  atDestination(r.snapshot(), feeId, 'lost'); assert.equal(r.snapshot().players[0].active.counters, 1);
  assert.equal(r.snapshot().players[1].active.counters, 2);
  assert.deepEqual(r.snapshot().rng, before.rng); conservation(r.snapshot(), before.cards); restore(r, f);
});

test('replacing an opponent-owned Prism Stadium sends that physical Stadium to its original owner’s Lost, never the replacing player’s discard/Lost', async () => {
  for (const starred of [false, true]) {
    const f = await make(starred ? ['stadium'] : [], (defs) => {
      const next = clone(defs.find((d) => d.definitionId === 'stadium'));
      Object.assign(next, { definitionId: 'next-stadium', nameKey: 'next-stadium', name: '测试下一竞技场' });
      delete next.prismStar; next.deckLimits.sameName = 4; defs.push(next);
    });
    f.deck[f.deck.lastIndexOf('printing:water')] = 'printing:next-stadium';
    let previous, next;
    const g = board(f, (s) => {
      previous = hand(s, 1, 'stadium'); s.players[1].hand.pop(); s.stadium = previous;
      next = hand(s, 0, 'next-stadium');
    }), before = g.snapshot();
    play(g, next); settle(g);
    assert.equal(g.snapshot().stadium, next);
    atDestination(g.snapshot(), previous, starred ? 'lost' : 'discard');
    assert.equal(g.snapshot().cards[previous].owner, 1); assert.equal(g.snapshot().players[0].flags.stadium, true);
    assert.deepEqual(g.snapshot().rng, before.rng); conservation(g.snapshot(), before.cards); restore(g, f);
  }
});

test('Lost Prism cards cannot be restored into discard or recovered by ordinary discard selection; a native from-lost binding is not admitted', async () => {
  const f = await make(['double'], (defs) => defs[0].mechanics.abilities.push(ability('recover', [
    binding('cn.cards@1', cards('discard', 'hand', { kind: 'energy' }), 'prism:ordinary-recovery'),
  ])));
  let star, ordinary;
  const g = board(f, (s) => {
    star = hand(s, 0, 'double'); moveFromHand(s, 0, star, 'lost');
    ordinary = hand(s, 0, 'water'); moveFromHand(s, 0, ordinary, 'discard');
  }), before = g.snapshot();
  use(g, 'recover'); assert.equal(g.snapshot().pending.kind, 'select-cards');
  assert(g.snapshot().pending.options.includes(ordinary)); assert(!g.snapshot().pending.options.includes(star));
  atomic(g, () => answer(g, [star]), 'Lost is not the discard-selection source');
  const r = restore(g, f); answer(r, [ordinary]); settle(r);
  assert(r.snapshot().players[0].hand.includes(ordinary)); atDestination(r.snapshot(), star, 'lost');
  const bad = r.snapshot(); bad.players[0].lost.splice(bad.players[0].lost.indexOf(star), 1); bad.players[0].discard.push(star);
  const supplied = clone(bad);
  assert.throws(() => OfficialGame.restore(bad, { catalog: f.catalog }));
  assert.deepEqual(bad, supplied, 'Restore must reject an impossible Prism discard, never repair it into Lost.');
  await assert.rejects(make(['double'], (defs) => defs[0].mechanics.abilities.push(ability('illegal-recover', [
    binding('cn.cards@1', cards('lost', 'hand', { kind: 'energy' }), 'prism:no-lost-recovery'),
  ]))));
  conservation(r.snapshot(), before.cards); restore(r, f);
});
