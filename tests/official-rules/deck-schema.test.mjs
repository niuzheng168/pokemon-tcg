import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreHandlers } from '../../public/rules/handlers.js';
import { validateDeckInspectionAction, validateDeckInspectionPlan, validateDeckEnergyAction,
  validateDeckEnergyPlan, validateEffectProgram, validateEffectResolution } from '../../public/rules/schema-validators.js';
import { inspectDeckWindow } from '../../public/rules/deck-window.js';
import { deckEnergyWindow } from '../../public/rules/deck-energy.js';
import { fixture, board } from './fixtures.mjs';

const inspect = { op: 'inspectDeck', lookTop: 4, selector: { kind: 'any' },
  quantity: { kind: 'exact', count: 2 }, revealSelected: false, remainder: { mode: 'shuffleToBottom' } };
const attach = { op: 'attachDeckEnergy', lookTop: 5,
  selector: { kind: 'energy', category: 'basic', types: ['Fire'] }, quantity: { kind: 'upTo', count: 2 },
  recipient: { position: 'any', selector: { kind: 'pokemon', types: ['Water'] } },
  distribution: 'separateRecipients', remainder: 'shuffleDeck', reveal: true };
const context = (f, s) => ({ state: s, source: { owner: 0, pokemonId: s.players[0].active.id },
  definitions: Object.fromEntries(f.catalog.definitions().map((d) => [d.definitionId, d])),
  // This explicit synthetic fixture has no type-changing providers.
  effectivePokemon: Object.fromEntries(s.players.flatMap((p) => [p.active, ...p.bench].filter(Boolean))
    .map((m) => [m.id, { types: [...f.catalog.definition(s.cards[m.stack.at(-1)].definitionId).mechanics.types] }])) });

test('generated offline deck-operation contracts are exact, and plans never become executable card definitions', () => {
  assert(validateDeckInspectionAction(inspect)); assert(validateDeckEnergyAction(attach));
  assert(validateEffectProgram([inspect, attach]));
  for (const [action, validate] of [[inspect, validateDeckInspectionAction], [attach, validateDeckEnergyAction]]) {
    const { op, ...missingOp } = action;
    assert(!validate(missingOp)); assert(!validate({ ...action, approval: true }));
    assert(!validate({ ...action, lookTop: 0 }));
    assert(!validate({ ...action, lookTop: Number.MAX_SAFE_INTEGER + 1 }));
    assert(!validate({ ...action, quantity: { kind: 'all' } }));
  }
  assert(validateDeckInspectionPlan({ window: ['a'], selected: [], remainder: ['a'] }));
  assert(!validateDeckInspectionPlan({ window: ['a', 'a'], selected: [], remainder: [] }));
  assert(!validateDeckInspectionPlan({ window: [], selected: [], remainder: [], trusted: true }));
  assert(validateDeckEnergyPlan({ owner: 0, lookedAt: ['a'], chosen: ['a'],
    assignments: [{ instanceId: 'a', targetId: 'p' }], remainder: [], shuffleDeck: false }));
  assert(!validateDeckEnergyPlan({ owner: 0, lookedAt: [], chosen: [], assignments: [], remainder: [] }));
});

test('native handlers bind explicit deck schemas, reviewed rule sources and a hand-cost-independent availability contract', async () => {
  const f = await fixture(), s = board(f).snapshot(), ctx = context(f, s), handlers = createCoreHandlers();
  for (const [id, action, operation] of [['cn.inspectDeck@1', inspect, 'inspectDeck'],
    ['cn.attachDeckEnergy@1', attach, 'attachDeckEnergy']]) {
    const h = handlers.get(id), before = structuredClone(action);
    assert(Object.isFrozen(h)); assert.equal(h.timing, 'resolve'); assert.deepEqual(h.operations, [operation]);
    assert.equal(h.parameterSchemaRef, `urn:pokemon-tcg:core-handler-parameters:1.0.0#/$defs/${operation}`);
    assert(h.sourceOfTruth.every((e) => e.documentId === 'CN-advanced-3.1.0' && e.pdfPages.length));
    assert(h.validateParameters(action)); assert(!h.validateParameters({ ...action, undeclared: 1 }));
    assert.deepEqual(h.execute(ctx, action), [action]); assert.deepEqual(action, before);
    assert.equal(h.costCheckVersion, '1');
    assert.equal(h.canUse(ctx, action), true);
    assert.equal(h.canUseWithCosts(ctx, action, []), true);
    const empty = structuredClone(ctx); empty.state.players[0].deck = [];
    assert.equal(h.canUse(empty, action), false);
    assert.equal(h.canUseWithCosts(empty, action, []), false);
  }
  // There is no Fire card in this hidden deck, yet availability cannot reveal it.
  assert.equal(deckEnergyWindow(ctx, attach).candidates.length, 0);
  assert(inspectDeckWindow(ctx, inspect).eligible.length > 0);
  const noReceiver = { ...attach, recipient: { ...attach.recipient, position: 'bench' } };
  assert.equal(handlers.get('cn.attachDeckEnergy@1').canUse(ctx, noReceiver), false,
    'This is a declared software boundary, not evidence of a CN no-recipient ruling.');
  assert.equal(deckEnergyWindow(ctx, noReceiver).status, 'needsRuling');
});

test('private deck continuation shape cannot masquerade as old escrow or another operation stage', () => {
  const source = { instanceId: 'card', owner: 0, category: 'ability', pokemonId: 'p',
    attackId: null, effectId: 'effect', sourceOfTruth: [{
      sourceId: 'TEST-ONLY', kind: 'official-card', url: 'https://www.pokemon.cn/',
      locator: 'Synthetic shape test, not a real card',
    }] };
  const d = { action: inspect, frames: [], source, stage: 'inspect-select',
    deckChoice: { id: 'deck1', turn: 1, deck: ['a'], window: ['a'], chosen: [], assignments: [] } };
  assert(validateEffectResolution(d));
  for (const extra of [{ lookedAt: [] }, { chosen: [] }, { index: 0 }, { performed: false },
    { energyPlan: { chosen: [], assignments: [] } }, { stage: 'cards-select' }])
    assert(!validateEffectResolution({ ...d, ...extra }));
  const { deckChoice, ...missing } = d; assert(!validateEffectResolution(missing));
});
