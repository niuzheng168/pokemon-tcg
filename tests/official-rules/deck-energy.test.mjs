import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  DeckEnergyError, DECK_ENERGY_RULE_IDS, DECK_ENERGY_SOURCES, assertDeckEnergyAction,
  deckEnergyWindow, deckEnergyRecipients, validateDeckEnergyPlan, assertDeckEnergyPlan,
} from '../../public/rules/deck-energy.js';
import { selectionBounds, canSelectCount } from '../../public/rules/selection.js';
import { CN_V20261019 } from '../../public/rules/zh-CN/V20261019.js';
import { requireRule } from '../../public/rules/registry.js';

// Synthetic normalized mechanics only, never production card/printing approval.
const pokemon = (nameKey, types = ['Lightning']) => ({
  definitionId: nameKey, nameKey, name: nameKey, kind: 'pokemon',
  mechanics: { stage: 'basic', hp: 60, types, ruleBox: false, tags: [], attacks: [], abilities: [] },
});
const energy = (nameKey, category, baseUnits) => ({
  definitionId: nameKey, nameKey, name: nameKey, kind: 'energy', mechanics: { category, baseUnits },
});
const trainer = { definitionId: 'item', nameKey: 'item', name: 'item', kind: 'trainer', mechanics: { category: 'item' } };
const mon = (id, cardId) => ({ id, stack: [cardId], energy: [], tools: [], counters: 0, facts: {}, used: {} });
function context() {
  const definitions = {
    pika: pokemon('pika'), miraidon: pokemon('miraidon'), waterMon: pokemon('waterMon', ['Water']),
    lightning: energy('lightning', 'basic', [['Lightning']]), water: energy('water', 'basic', [['Water']]),
    grass: energy('grass', 'basic', [['Grass']]),
    double: energy('double', 'special', [['Lightning', 'Water'], ['Lightning', 'Water']]),
    item: structuredClone(trainer),
  };
  definitions.double.mechanics.handAttachTo = { kind: 'pokemon', types: ['Fire'] };
  definitions.double.mechanics.remainOn = { kind: 'pokemon', types: ['Fire'] };
  const cards = {};
  for (const [instanceId, definitionId, owner] of [
    ['AP', 'pika', 0], ['BP', 'miraidon', 0], ['CP', 'waterMon', 0], ['DP', 'miraidon', 0],
    ['OP', 'pika', 1], ['OBP', 'miraidon', 1], ['foeL', 'lightning', 1],
    ['outsideL', 'lightning', 0], ['outsideL2', 'lightning', 0], ['G', 'grass', 0],
    ['L1', 'lightning', 0], ['T', 'item', 0], ['X', 'double', 0], ['W', 'water', 0], ['L2', 'lightning', 0],
    ['handL', 'lightning', 0], ['discardL', 'lightning', 0],
  ]) cards[instanceId] = { instanceId, definitionId, owner };
  return {
    source: { instanceId: 'AP', owner: 0, cardOwner: 0, pokemonId: 'A', category: 'attack' },
    definitions, effectivePokemon: {
      A: { types: ['Lightning'], energies: [] }, B: { types: ['Lightning'], energies: [] },
      C: { types: ['Water'], energies: [] }, D: { types: ['Lightning'], energies: [] },
      O: { types: ['Lightning'], energies: [] }, OB: { types: ['Lightning'], energies: [] },
    },
    state: {
      ruleset: { region: 'CN', version: 'V20261019' }, cards, rng: [1, 2, 3, 4],
      players: [
        { active: mon('A', 'AP'), bench: [mon('B', 'BP'), mon('C', 'CP'), mon('D', 'DP')],
          deck: ['outsideL', 'outsideL2', 'G', 'L1', 'T', 'X', 'W', 'L2'],
          hand: ['handL'], discard: ['discardL'], lost: [], prizes: [], resolving: [], flags: { energy: true } },
        { active: mon('O', 'OP'), bench: [mon('OB', 'OBP')], deck: ['foeL'], hand: [], discard: [], flags: { energy: false } },
      ],
    },
  };
}
const generator = (extra = {}) => ({
  op: 'attachDeckEnergy', lookTop: 5,
  selector: { kind: 'energy', category: 'basic', types: ['Lightning'] },
  quantity: { kind: 'upTo', count: 2 },
  recipient: { position: 'bench', selector: { kind: 'pokemon', types: ['Lightning'] } },
  distribution: 'separateRecipients', remainder: 'shuffleDeck', reveal: false, ...extra,
});
const charge = (extra = {}) => generator({
  lookTop: null, quantity: { kind: 'exact', count: 1 },
  recipient: { position: 'self', selector: { kind: 'pokemon' } }, distribution: 'singleRecipient', ...extra,
});
const allocation = (chosen, targets) => chosen.map((instanceId, i) => ({ instanceId, targetId: targets[i] }));
const reject = (fn, code) => assert.throws(fn, (error) => {
  assert(error instanceof DeckEnergyError); assert(error instanceof TypeError); assert.equal(error.name, 'DeckEnergyError');
  if (code) assert.equal(error.code, code);
  return true;
});
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('review receipts bind the two actually read Chinese primary faces, not legacy/English metadata or production approval', async () => {
  const report = JSON.parse(await readFile(new URL('../../docs/rules/zh-CN/V20261019/cards/sv-miraidon-review.json', import.meta.url), 'utf8'));
  for (const [sourceId, sha256] of [
    ['primary:electric-generator', 'b45331a573825776e0046a925a20e7777018fc7d6776ef6168d7d2cbe5543493'],
    ['primary:pikachu', 'b7daabc12bebbfc35ac49fa665595bc379bce11a34bbcb1513e00e9eabd1b647'],
  ]) {
    const receipt = report.sources[sourceId];
    assert.equal(receipt.sha256, sha256); assert.equal(receipt.classification, 'official-primary-image-bytes');
    assert.equal(receipt.rawBodyRedistributed, false); assert.equal(receipt.approvalAuthority, false);
    const card = report.cards.find((entry) => entry.staticCardFace?.officialObservation?.sourceId === sourceId);
    assert.equal(card.reviewStatus, 'primary-face-observed'); assert.equal(card.admitted, false);
    assert.equal(card.independentProductionApproval, false);
  }
  for (const ruleId of DECK_ENERGY_RULE_IDS) assert(requireRule(CN_V20261019, ruleId).sourceOfTruth.length);
  assert(Object.isFrozen(DECK_ENERGY_RULE_IDS)); assert(Object.isFrozen(DECK_ENERGY_SOURCES));
  for (const ref of DECK_ENERGY_SOURCES) {
    assert.equal(ref.documentId, 'CN-advanced-3.1.0');
    assert(Object.isFrozen(ref)); assert(Object.isFrozen(ref.pdfPages));
  }
  assert(DECK_ENERGY_SOURCES.some((ref) => ref.section === 'II.C-09' && ref.pdfPages.includes(31) && ref.pdfPages.includes(32)));
  assert(DECK_ENERGY_SOURCES.some((ref) => ref.section === 'II.E-39' && ref.pdfPages.includes(76)));
});

test('Generator inspects exactly the own top five, counts physical Basic Lightning cards and never opens the lower deck', () => {
  const ctx = freeze(context()), action = freeze(generator()), before = JSON.stringify(ctx);
  const window = deckEnergyWindow(ctx, action);
  assert.equal(window.status, 'ready'); assert.equal(window.owner, 0);
  assert.deepEqual(window.lookedAt, ['L1', 'T', 'X', 'W', 'L2']);
  assert.deepEqual(window.candidates, ['L1', 'L2']);
  assert.deepEqual(window.recipientIds, ['B', 'D']);
  assert.equal(window.bounds.minimum, 0); assert.equal(window.bounds.maximum, 2); assert.equal(window.bounds.allowZero, true);
  assert(window.bounds.trace.some((entry) => entry.ruleId === 'selection.hidden'));
  assert.equal(JSON.stringify(ctx), before);
  window.lookedAt.pop(); window.candidates.pop(); window.recipientIds.push('forged');
  assert.equal(JSON.stringify(ctx), before, 'Private result arrays cannot mutate the source context.');
  reject(() => validateDeckEnergyPlan(ctx, action, ['outsideL'], allocation(['outsideL'], ['B'])), 'invalid-deck-energy-selection');
  reject(() => validateDeckEnergyPlan(ctx, action, ['X'], allocation(['X'], ['B'])), 'invalid-deck-energy-selection');
  reject(() => validateDeckEnergyPlan(ctx, action, ['handL'], allocation(['handL'], ['B'])), 'invalid-deck-energy-selection');
  reject(() => validateDeckEnergyPlan(ctx, action, ['discardL'], allocation(['discardL'], ['B'])), 'invalid-deck-energy-selection');
  reject(() => validateDeckEnergyPlan(ctx, action, ['foeL'], allocation(['foeL'], ['B'])), 'invalid-deck-energy-selection');
});

test('arbitrary distribution allows same/different own Lightning Bench recipients; singleRecipient is a different contract', () => {
  const ctx = context(), chosen = ['L1', 'L2'];
  for (const targets of [['B', 'B'], ['B', 'D'], ['D', 'B'], ['D', 'D']]) {
    const assignments = allocation(chosen, targets);
    const plan = validateDeckEnergyPlan(ctx, generator(), chosen, assignments);
    assert.deepEqual(plan.assignments, assignments);
    assert.deepEqual(plan.remainder, ['T', 'X', 'W']); assert.equal(plan.shuffleDeck, true);
    assert.equal(assertDeckEnergyPlan(ctx, generator(), plan), plan);
  }
  const single = generator({ distribution: 'singleRecipient' });
  reject(() => validateDeckEnergyPlan(ctx, single, chosen, allocation(chosen, ['B', 'D'])), 'invalid-deck-energy-assignment');
  assert.equal(validateDeckEnergyPlan(ctx, single, chosen, allocation(chosen, ['D', 'D'])).assignments.length, 2);
  const reversed = validateDeckEnergyPlan(ctx, generator(), chosen, allocation(chosen, ['B', 'D']).reverse());
  assert.deepEqual(reversed.assignments, allocation(chosen, ['B', 'D']), 'Canonical assignments follow the explicit chosen-card order.');
});

test('recipient filters use actual own battle IDs and positions, never a copied content holder or physical-card owner', () => {
  const ctx = context();
  assert.deepEqual(deckEnergyRecipients(ctx, generator()), ['B', 'D']);
  assert.deepEqual(deckEnergyRecipients(ctx, generator(), ['L1']), ['B', 'D']);
  assert.deepEqual(deckEnergyRecipients(ctx, charge()), ['A']);
  assert.deepEqual(deckEnergyRecipients(ctx, charge({ recipient: { position: 'active', selector: { kind: 'pokemon' } } })), ['A']);
  assert.deepEqual(deckEnergyRecipients(ctx, charge({ recipient: { position: 'any', selector: { kind: 'pokemon' } } })), ['A', 'B', 'C', 'D']);
  ctx.source.contentSource = { instanceId: 'OP', attackId: 'other:charge' };
  assert.deepEqual(deckEnergyRecipients(ctx, charge()), ['A']);
  const shared = context();
  shared.definitions.stadium = { ...structuredClone(trainer), definitionId: 'stadium', nameKey: 'stadium', mechanics: { category: 'stadium' } };
  shared.state.cards.stadium = { instanceId: 'stadium', definitionId: 'stadium', owner: 1 };
  shared.source = { instanceId: 'stadium', owner: 0, cardOwner: 1, pokemonId: null, category: 'trainer', origin: 'field' };
  assert.equal(deckEnergyWindow(shared, generator()).owner, 0, 'The actual reference player, not the physical/shared provider holder, owns the searched deck.');
  for (const targetId of ['A', 'C', 'O', 'OB', 'BP', 'missing']) {
    reject(() => validateDeckEnergyPlan(ctx, generator(), ['L1'], [{ instanceId: 'L1', targetId }]), 'invalid-deck-energy-assignment');
  }
  ctx.state.players[0].active = null;
  assert.deepEqual(deckEnergyRecipients(ctx, charge()), []);
  assert.equal(deckEnergyWindow(ctx, charge()).status, 'needsRuling');
});

test('deck attachment recipients use explicit live types while hidden Basic Energy filtering remains printed', () => {
  const ctx = context();
  ctx.effectivePokemon.B.types = ['Water'];
  ctx.effectivePokemon.C.types = ['Lightning', 'Metal'];
  ctx.effectivePokemon.D.types = ['Lightning', 'Dragon'];
  ctx.effectivePokemon.L1 = { types: ['Water'], energies: [] };
  const before = structuredClone(ctx);
  for (const [types, expected] of [
    [['Water'], ['B']], [['Lightning'], ['C', 'D']], [['Metal'], ['C']], [['Dragon'], ['D']], [['Fire'], []],
  ]) assert.deepEqual(deckEnergyRecipients(ctx, generator({ recipient: { position: 'bench', selector: { kind: 'pokemon', types } } })), expected);
  const window = deckEnergyWindow(ctx, generator());
  assert.deepEqual(window.recipientIds, ['C', 'D']);
  assert.deepEqual(window.candidates, ['L1', 'L2'], 'A live Pokémon/type model cannot change physical Basic Lightning Energy identity.');
  const plan = validateDeckEnergyPlan(ctx, generator(), ['L1'], allocation(['L1'], ['C']));
  assert.equal(assertDeckEnergyPlan(ctx, generator(), JSON.parse(JSON.stringify(plan))).assignments[0].targetId, 'C');
  reject(() => validateDeckEnergyPlan(ctx, generator(), ['L1'], allocation(['L1'], ['B'])), 'invalid-deck-energy-assignment');
  assert.deepEqual(deckEnergyRecipients(ctx, generator({ recipient: {
    position: 'bench', selector: { kind: 'pokemon', types: ['Lightning'], nameKeys: ['miraidon'] },
  } })), ['D'], 'The newly Lightning Water Pokémon retains its printed name.');
  const changed = structuredClone(ctx); changed.effectivePokemon.C.types = ['Water'];
  reject(() => assertDeckEnergyPlan(changed, generator(), plan), 'invalid-deck-energy-assignment');
  assert.deepEqual(ctx, before);
  for (const mutate of [
    (c) => { delete c.effectivePokemon; }, (c) => { c.effectivePokemon = {}; },
    (c) => { delete c.effectivePokemon.A.types; }, (c) => { c.effectivePokemon.A.types = null; },
    (c) => { c.effectivePokemon.A.types = []; }, (c) => { c.effectivePokemon.A.types = ['Fake']; },
    (c) => { c.effectivePokemon.A.types = ['Lightning', 'Lightning']; },
  ]) {
    const invalid = structuredClone(ctx); mutate(invalid);
    assert.throws(() => deckEnergyRecipients(invalid, charge()), TypeError, 'No printed fallback, even for the untyped self selector.');
  }
});

test('public target lookup and bounded windows never inspect hidden definitions outside their permitted scope', () => {
  const ctx = context();
  let inspectedEnergy = 0, inspectedLower = 0;
  Object.defineProperty(ctx.state.cards.L1, 'definitionId', {
    enumerable: true, get() { inspectedEnergy++; return 'lightning'; },
  });
  Object.defineProperty(ctx.state.cards.outsideL, 'definitionId', {
    enumerable: true, get() { inspectedLower++; return 'lightning'; },
  });
  assert.deepEqual(deckEnergyRecipients(ctx, generator()), ['B', 'D']);
  assert.equal(inspectedEnergy, 0); assert.equal(inspectedLower, 0);
  assert.deepEqual(deckEnergyWindow(ctx, generator()).candidates, ['L1', 'L2']);
  assert(inspectedEnergy > 0); assert.equal(inspectedLower, 0);
  inspectedEnergy = 0; ctx.state.players[0].bench = [mon('C', 'CP')];
  assert.equal(deckEnergyWindow(ctx, generator()).status, 'needsRuling');
  assert.equal(inspectedEnergy, 0); assert.equal(inspectedLower, 0);
});

test('Pikachu Charge searches the whole deck and attaches only to the actual user, with hidden-search zero permitted', () => {
  const ctx = freeze(context()), action = freeze(charge()), before = JSON.stringify(ctx);
  const window = deckEnergyWindow(ctx, action);
  assert.deepEqual(window.lookedAt, ctx.state.players[0].deck);
  assert.deepEqual(window.candidates, ['outsideL', 'outsideL2', 'L1', 'L2']);
  const plan = validateDeckEnergyPlan(ctx, action, ['outsideL'], [{ instanceId: 'outsideL', targetId: 'A' }]);
  assert.deepEqual(plan.chosen, ['outsideL']);
  assert.equal(plan.shuffleDeck, true);
  const miss = validateDeckEnergyPlan(ctx, action, [], []);
  assert.deepEqual(miss.remainder, ctx.state.players[0].deck); assert.equal(miss.shuffleDeck, true);
  assert.equal(JSON.stringify(ctx), before, 'No Energy enters hand and the already-spent turn Energy flag/RNG stay unchanged.');
  reject(() => validateDeckEnergyPlan(ctx, action, ['L1'], [{ instanceId: 'L1', targetId: 'B' }]), 'invalid-deck-energy-assignment');
});

test('filtered deck exact/upTo may choose zero/fewer, any-number is not arbitrary-card selection, and limits remain physical', () => {
  const ctx = context();
  for (const quantity of [{ kind: 'exact', count: 2 }, { kind: 'upTo', count: 2 }, { kind: 'any' }]) {
    const action = generator({ quantity });
    for (const chosen of [[], ['L1'], ['L1', 'L2']])
      assert.equal(validateDeckEnergyPlan(ctx, action, chosen, allocation(chosen, chosen.map(() => 'B'))).chosen.length, chosen.length);
  }
  reject(() => validateDeckEnergyPlan(ctx, generator({ quantity: { kind: 'upTo', count: 1 } }),
    ['L1', 'L2'], allocation(['L1', 'L2'], ['B', 'B'])), 'invalid-deck-energy-selection');
  reject(() => assertDeckEnergyAction(generator({ selector: { kind: 'any' } })), 'invalid-deck-energy-action');
  const arbitrary = selectionBounds({ kind: 'upTo', count: 2, available: 3, zone: 'deck', filter: 'anyCard' });
  assert.equal(canSelectCount(arbitrary, 0), false, 'No attachment API may import fail-to-find for an arbitrary-card instruction.');
  const arbitraryExact = selectionBounds({ kind: 'exact', count: 2, available: 3, zone: 'deck', filter: 'anyCard' });
  assert.equal(canSelectCount(arbitraryExact, 1), false);
});

test('E39 printed Basic identity and physical cards are independent of attached units, hand-only limits and later retention', () => {
  const ctx = context(), action = generator({ selector: { kind: 'energy' }, quantity: { kind: 'upTo', count: 1 } });
  ctx.state.players[0].deck = ['X'];
  ctx.effectivePokemon.B.energies.push({ instanceId: 'X', units: [['Lightning'], ['Lightning'], ['Lightning']] });
  const window = deckEnergyWindow(ctx, action);
  assert.deepEqual(window.candidates, ['X']); assert.equal(window.bounds.maximum, 1);
  const plan = validateDeckEnergyPlan(ctx, action, ['X'], [{ instanceId: 'X', targetId: 'B' }]);
  assert.equal(plan.chosen.length, 1);
  assert.equal(plan.shuffleDeck, false);
  assert.equal(ctx.state.cards.X.owner, 0);
  assert.deepEqual(ctx.state.players[0].bench[0].energy, [], 'Special retention is not evaluated or applied by the planner.');
  reject(() => validateDeckEnergyPlan(ctx, action, ['X', 'X'], allocation(['X', 'X'], ['B', 'D'])), 'invalid-deck-energy-selection');
  assert.deepEqual(deckEnergyWindow(ctx, generator()).candidates, [], 'A Special card providing Lightning is not named Basic Lightning Energy.');
  ctx.state.players[0].deck = ['L1'];
  ctx.effectivePokemon.A.energies.push({ instanceId: 'L1', units: [['Water'], ['Water']] });
  assert.deepEqual(deckEnergyWindow(ctx, generator()).candidates, ['L1'], 'Runtime provision does not change out-of-play Basic identity.');
});

test('no-match, short, one-card and empty windows preserve shuffle semantics without invoking RNG', () => {
  for (const deck of [[], ['L1'], ['W'], ['W', 'L1'], ['L1', 'W', 'L2']]) {
    const ctx = context(); ctx.state.players[0].deck = [...deck];
    const before = JSON.stringify(ctx), window = deckEnergyWindow(ctx, generator());
    assert.deepEqual(window.lookedAt, deck);
    assert.equal(window.status, deck.length ? 'ready' : 'emptyDeck');
    const noSelection = validateDeckEnergyPlan(ctx, generator(), [], []);
    assert.deepEqual(noSelection.remainder, deck);
    assert.equal(noSelection.shuffleDeck, deck.length > 0);
    assert.equal(JSON.stringify(ctx), before);
  }
  const ctx = context(); ctx.state.players[0].deck = ['W', 'L1'];
  const allWindow = generator({ lookTop: 1 });
  const plan = validateDeckEnergyPlan(ctx, allWindow, ['L1'], [{ instanceId: 'L1', targetId: 'B' }]);
  assert.deepEqual(plan.remainder, []);
  assert.equal(plan.shuffleDeck, true, 'Uninspected lower cards still belong to the deck that must be shuffled.');
  ctx.state.players[0].deck = ['L1'];
  assert.equal(validateDeckEnergyPlan(ctx, charge(), ['L1'], [{ instanceId: 'L1', targetId: 'A' }]).shuffleDeck, false);
});

test('without a public legal receiver, availability is explicit needsRuling and no hidden deck window leaks', () => {
  for (const deck of [['L1', 'L2'], ['W', 'T']]) {
    const ctx = context(); ctx.state.players[0].deck = deck; ctx.state.players[0].bench = [mon('C', 'CP')];
    const before = JSON.stringify(ctx), window = deckEnergyWindow(ctx, generator());
    assert.equal(window.status, 'needsRuling'); assert.equal(window.owner, 0);
    assert.deepEqual(window.lookedAt, []); assert.deepEqual(window.candidates, []); assert.deepEqual(window.recipientIds, []);
    assert.equal(window.bounds, null); assert.deepEqual(deckEnergyRecipients(ctx, generator()), []);
    assert.throws(() => validateDeckEnergyPlan(ctx, generator(), [], []),
      (error) => error instanceof DeckEnergyError && error.code === 'needs-ruling' && error.needsRuling === true);
    reject(() => deckEnergyRecipients(ctx, generator(), ['L1']), 'needs-ruling');
    assert.equal(JSON.stringify(ctx), before);
  }
  const a = context(), b = context(); b.state.players[0].deck = ['W', 'T'];
  assert.equal(deckEnergyWindow(a, generator()).status, deckEnergyWindow(b, generator()).status,
    'Public availability cannot disclose whether hidden Basic Lightning cards actually exist.');
  const empty = context(); empty.state.players[0].deck = []; empty.state.players[0].bench = [];
  assert.equal(deckEnergyWindow(empty, generator()).status, 'emptyDeck');
  assert.equal(validateDeckEnergyPlan(empty, generator(), [], []).shuffleDeck, false);
});

test('bad selections/allocations are rejected atomically: duplicate cards, missing/extra cards, foreign/invalid recipients and forged amounts', () => {
  const ctx = freeze(context()), action = freeze(generator()), chosen = ['L1', 'L2'], before = JSON.stringify(ctx);
  for (const invalid of [
    null, 'L1', [null], ['L1', 'L1'], ['L1', 'L2', 'outsideL'], ['outsideL'], ['T'], ['W'], ['missing'],
  ]) reject(() => validateDeckEnergyPlan(ctx, action, invalid, []), 'invalid-deck-energy-selection');
  for (const assignments of [
    null, {}, [], [{ instanceId: 'L1', targetId: 'B' }],
    [{ instanceId: 'L1', targetId: 'B' }, { instanceId: 'L1', targetId: 'D' }],
    [{ instanceId: 'L1', targetId: 'B' }, { instanceId: 'L2', targetId: 'C' }],
    [{ instanceId: 'L1', targetId: 'B' }, { instanceId: 'L2', targetId: 'OB' }],
    [{ instanceId: 'L1', targetId: 'B' }, { instanceId: 'outsideL', targetId: 'D' }],
    [{ instanceId: '', targetId: 'B' }], [{ instanceId: 'L1', targetId: '' }],
    [{ instanceId: 'L1', targetId: 'B', units: 2 }],
  ]) {
    reject(() => validateDeckEnergyPlan(ctx, action, chosen, assignments), 'invalid-deck-energy-assignment');
    assert.equal(JSON.stringify(ctx), before);
  }
  reject(() => deckEnergyRecipients(ctx, action, ['L1', 'L1']), 'invalid-deck-energy-selection');
  reject(() => deckEnergyRecipients(ctx, action, ['outsideL']), 'invalid-deck-energy-selection');
});

test('strict action shape does not accept legacy hand transitions, units, opponent side, implicit defaults or unknown selectors', () => {
  const good = generator();
  assert.equal(assertDeckEnergyAction(good), good);
  for (const mutate of [
    (a) => { a.op = 'attachHand'; }, (a) => { delete a.reveal; }, (a) => { a.reveal = 'false'; },
    (a) => { a.side = 'opponent'; }, (a) => { a.from = 'hand'; }, (a) => { a.measure = 'units'; },
    (a) => { a.lookTop = 0; }, (a) => { a.lookTop = -1; }, (a) => { a.lookTop = 1.5; },
    (a) => { a.lookTop = Number.MAX_SAFE_INTEGER + 1; }, (a) => { a.lookTop = '5'; },
    (a) => { a.distribution = 'distinctTargets'; }, (a) => { a.remainder = 'discard'; },
    (a) => { a.recipient.position = 'opponent'; }, (a) => { a.recipient.optional = true; },
    (a) => { a.selector = { kind: 'any' }; }, (a) => { a.selector = { kind: 'pokemon' }; },
    (a) => { a.selector = { anyOf: [{ kind: 'energy' }, { kind: 'trainer' }] }; },
    (a) => { a.selector.types = ['Fake']; }, (a) => { a.selector.category = 'special'; },
    (a) => { a.recipient.selector = { kind: 'energy' }; }, (a) => { a.recipient.selector = null; },
    (a) => { a.recipient.selector.extra = true; }, (a) => { a.quantity = null; },
    (a) => { a.quantity = { kind: 'any', count: 2 }; }, (a) => { a.quantity.kind = 'all'; },
    (a) => { a.quantity.count = 0; }, (a) => { a.quantity.count = -1; },
    (a) => { a.quantity.count = Number.MAX_SAFE_INTEGER + 1; }, (a) => { a.quantity.count = '2'; },
  ]) { const a = structuredClone(good); mutate(a); reject(() => assertDeckEnergyAction(a), 'invalid-deck-energy-action'); }
  for (const invalid of [null, [], {}, false]) reject(() => assertDeckEnergyAction(invalid), 'invalid-deck-energy-action');
  assert.equal(assertDeckEnergyAction(generator({ lookTop: Number.MAX_SAFE_INTEGER })).lookTop, Number.MAX_SAFE_INTEGER);
});

test('missing/corrupt own-deck or recipient ownership/definitions cannot produce an apparently valid plan', () => {
  for (const mutate of [
    (ctx) => { ctx.source = null; }, (ctx) => { ctx.source.owner = 2; }, (ctx) => { ctx.state = null; },
    (ctx) => { ctx.state.players = []; }, (ctx) => { ctx.state.cards = null; }, (ctx) => { ctx.definitions = null; },
    (ctx) => { ctx.state.players[0] = null; }, (ctx) => { ctx.state.players[0].deck = null; },
    (ctx) => { ctx.state.players[0].bench = null; }, (ctx) => { ctx.state.players[0].active = false; },
    (ctx) => { ctx.state.players[0].bench.push(null); }, (ctx) => { ctx.state.players[0].deck.push('L1'); },
    (ctx) => { ctx.state.players[0].deck.push(1); }, (ctx) => { ctx.state.players[0].bench[0].id = 'A'; },
    (ctx) => { ctx.state.players[0].bench[0].stack = []; }, (ctx) => { ctx.state.players[0].bench[0].stack = null; },
    (ctx) => { ctx.state.cards.BP.owner = 1; }, (ctx) => { ctx.state.cards.BP.instanceId = 'forged'; },
    (ctx) => { ctx.state.cards.BP.definitionId = 'missing'; },
    (ctx) => { ctx.state.cards.BP.definitionId = 'item'; }, (ctx) => { ctx.state.cards.L1.owner = 1; },
    (ctx) => { delete ctx.state.cards.L1; }, (ctx) => { ctx.definitions.lightning.kind = 'missing'; },
    (ctx) => { ctx.definitions.lightning.mechanics = null; },
  ]) {
    const ctx = context(); mutate(ctx);
    reject(() => deckEnergyWindow(ctx, generator()), 'invalid-deck-energy-context');
  }
  reject(() => deckEnergyWindow(null, generator()), 'invalid-deck-energy-context');
  const ctx = context(); Object.assign(ctx.source, { owner: 1, cardOwner: 1, pokemonId: 'O', instanceId: 'OP' });
  const plan = validateDeckEnergyPlan(ctx, charge(), ['foeL'], [{ instanceId: 'foeL', targetId: 'O' }]);
  assert.equal(plan.owner, 1); assert.equal(plan.shuffleDeck, false);
  assert.deepEqual(deckEnergyRecipients(ctx, generator()), ['OB']);
});

test('saved plans survive JSON and property-order changes but reject stale windows, forged fields/allocations and partial-mutation contexts', () => {
  const ctx = freeze(context()), action = freeze(generator());
  const plan = validateDeckEnergyPlan(ctx, action, ['L1', 'L2'], allocation(['L1', 'L2'], ['B', 'D']));
  const serialized = JSON.parse(JSON.stringify(plan));
  assert.equal(assertDeckEnergyPlan(ctx, action, serialized), serialized);
  const reordered = Object.fromEntries(Object.entries(serialized).reverse());
  assert.equal(assertDeckEnergyPlan(ctx, action, reordered), reordered);
  for (const mutate of [
    (p) => { p.owner = 1; }, (p) => { p.shuffleDeck = false; }, (p) => { p.shuffleDeck = 1; },
    (p) => { p.lookedAt.reverse(); }, (p) => { p.lookedAt.push('outsideL'); },
    (p) => { p.remainder.reverse(); }, (p) => { p.remainder.pop(); },
    (p) => { p.chosen.push('L1'); }, (p) => { p.assignments.reverse(); },
    (p) => { p.assignments[1].targetId = 'O'; }, (p) => { p.assignments[1].instanceId = 'L1'; },
    (p) => { p.remainder = [null]; }, (p) => { p.side = 'opponent'; }, (p) => { delete p.chosen; },
  ]) {
    const bad = structuredClone(plan); mutate(bad);
    reject(() => assertDeckEnergyPlan(ctx, action, bad));
  }
  const changed = structuredClone(ctx); changed.state.players[0].deck.reverse();
  reject(() => assertDeckEnergyPlan(changed, action, plan));
  const partiallyApplied = structuredClone(ctx); partiallyApplied.state.players[0].deck.splice(3, 1);
  reject(() => assertDeckEnergyPlan(partiallyApplied, action, plan), 'invalid-deck-energy-selection');
  const deadReceiver = structuredClone(ctx); deadReceiver.state.players[0].bench.splice(2, 1);
  reject(() => assertDeckEnergyPlan(deadReceiver, action, plan), 'invalid-deck-energy-assignment');
  const detached = structuredClone(plan); detached.lookedAt.pop();
  assert.equal(plan.lookedAt.length, 5);
});

test('all plans are finite plain JSON: no hidden/accessor/symbol/cyclic/configuration data disappears during validation', () => {
  const values = [undefined, NaN, Infinity, 1n, () => true, new Date(), new Map(),
    new (class Custom {})(), Object.create(Array.prototype)];
  const cycle = {}; cycle.self = cycle; values.push(cycle);
  values.push(Array(1));
  const extended = []; extended.extra = 1; values.push(extended);
  const fakeIndex = [1]; delete fakeIndex[0]; fakeIndex['00'] = 1; values.push(fakeIndex);
  const hidden = {}; Object.defineProperty(hidden, 'secret', { value: 1 }); values.push(hidden);
  const symbolic = {}; symbolic[Symbol('secret')] = true; values.push(symbolic);
  let reads = 0;
  const accessor = {}; Object.defineProperty(accessor, 'secret', { enumerable: true, get() { reads++; return true; } }); values.push(accessor);
  const changedPrototype = []; Object.setPrototypeOf(changedPrototype, null); values.push(changedPrototype);
  for (const invalid of values) {
    const a = generator(); a.extra = invalid;
    reject(() => assertDeckEnergyAction(a), 'invalid-deck-energy-json');
    reject(() => validateDeckEnergyPlan(context(), generator(), [], invalid), 'invalid-deck-energy-json');
  }
  assert.equal(reads, 0);
  const nullPrototype = Object.assign(Object.create(null), generator());
  assert.equal(assertDeckEnergyAction(nullPrototype), nullPrototype);
  const shared = generator(), names = ['fixture:name'];
  shared.selector.nameKeys = names; shared.recipient.selector.nameKeys = names;
  assert.equal(assertDeckEnergyAction(shared), shared);
});

test('independent small-deck oracle covers full/top windows, exact/upTo/any quantities and same/split physical-card allocations', () => {
  let checks = 0;
  const decks = [[], ['L1'], ['W'], ['X', 'L1'], ['L2', 'W', 'X', 'L1'], context().state.players[0].deck];
  for (const deck of decks) for (const lookTop of [null, 1, 3, 99]) {
    for (const quantity of [{ kind: 'exact', count: 1 }, { kind: 'exact', count: 2 }, { kind: 'upTo', count: 1 }, { kind: 'upTo', count: 2 }, { kind: 'any' }]) {
      const ctx = context(); ctx.state.players[0].deck = [...deck];
      const action = generator({ lookTop, quantity }), threshold = lookTop === null ? 0 : Math.max(0, deck.length - lookTop);
      const expectedWindow = deck.filter((_id, index) => index >= threshold);
      const expectedCandidates = expectedWindow.filter((id) => ['L1', 'L2', 'outsideL', 'outsideL2'].includes(id));
      const window = deckEnergyWindow(ctx, action);
      assert.deepEqual(window.lookedAt, expectedWindow); assert.deepEqual(window.candidates, expectedCandidates);
      for (let mask = 0; mask < 2 ** expectedCandidates.length; mask++) {
        const selected = expectedCandidates.filter((_id, i) => mask >> i & 1);
        const maximum = quantity.kind === 'any' ? expectedCandidates.length : Math.min(quantity.count, expectedCandidates.length);
        const assignments = selected.map((instanceId, i) => ({ instanceId, targetId: i % 2 ? 'D' : 'B' }));
        if (selected.length > maximum)
          reject(() => validateDeckEnergyPlan(ctx, action, selected, assignments), 'invalid-deck-energy-selection');
        else {
          const plan = validateDeckEnergyPlan(ctx, action, selected, assignments);
          assert.equal(plan.chosen.length, selected.length);
          assert.deepEqual(plan.remainder, expectedWindow.filter((id) => !selected.includes(id)));
          assert.equal(plan.shuffleDeck, deck.length > selected.length);
          assertDeckEnergyPlan(ctx, action, JSON.parse(JSON.stringify(plan)));
        }
        checks++;
      }
    }
  }
  assert(checks > 200);
});

test('strict action/SerializablePlan schemas compile independently and defer contextual proof to pure validation', async () => {
  const root = new URL('../../schemas/', import.meta.url), ajv = new Ajv2020({ strict: true, allErrors: true });
  for (const filename of await readdir(root)) if (filename.endsWith('.schema.json'))
    ajv.addSchema(JSON.parse(await readFile(new URL(filename, root), 'utf8')));
  const action = ajv.getSchema('urn:pokemon-tcg:deck-energy:1.0.0#/$defs/action');
  const plan = ajv.getSchema('urn:pokemon-tcg:deck-energy:1.0.0#/$defs/plan');
  assert(action(generator()), JSON.stringify(action.errors)); assert(action(charge()));
  const ctx = context(), good = validateDeckEnergyPlan(ctx, generator(), ['L1'], [{ instanceId: 'L1', targetId: 'B' }]);
  assert(plan(good), JSON.stringify(plan.errors));
  assert(plan(validateDeckEnergyPlan(ctx, generator(), [], [])));
  for (const bad of [
    generator({ side: 'opponent' }), generator({ lookTop: 0 }), generator({ lookTop: 1.5 }),
    generator({ selector: { kind: 'any' } }), generator({ quantity: { kind: 'all' } }),
    generator({ quantity: { kind: 'any', count: 1 } }), generator({ reveal: null }),
    generator({ recipient: { position: 'other', selector: { kind: 'pokemon' } } }),
  ]) assert.equal(action(bad), false);
  for (const bad of [{ ...good, extra: true }, { ...good, chosen: ['L1', 'L1'] },
    { ...good, shuffleDeck: 1 }, { ...good, assignments: [{ instanceId: 'L1', targetId: 'B', units: 2 }] }])
    assert.equal(plan(bad), false);
  const forged = { ...good, assignments: [{ instanceId: 'L1', targetId: 'O' }] };
  assert.equal(plan(forged), true, 'Schema shape alone cannot prove recipient ownership or the original window.');
  reject(() => assertDeckEnergyPlan(ctx, generator(), forged), 'invalid-deck-energy-assignment');
});
