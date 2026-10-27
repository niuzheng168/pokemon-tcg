import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSourceTraits } from '../../public/rules/source-traits.js';
import { EVIDENCE } from './fixtures.mjs';
import { assertSubjectProgram } from '../../public/rules/triggers.js';

const mon = (id, printedTypes) => ({ id, printedTypes });
const node = (id, pokemonId = 'p', owner = 0, types = ['Water']) => ({
  id, kind: 'ability', instanceId: `card-${id}`, pokemonId, owner, key: id, active: true,
  mechanics: { types, tags: [], stage: 'basic', ruleBox: false },
});
const fixed = (id) => ({ id, kind: 'fixed', owner: 0, pokemonId: null });
const replacement = (id, sourceNodeId, types, targets = ['p']) => ({
  id, sourceNodeId, spec: { op: 'pokemonTypes', scope: 'self', types }, targets, sourceOfTruth: EVIDENCE,
});
const remove = (sourceNodeId, extra = {}) => ({
  id: `remove-${sourceNodeId}`, sourceNodeId, source: { instanceId: `card-${sourceNodeId}` },
  spec: { op: 'suppression', channel: 'abilities', scope: 'opponent', ...extra }, sourceOfTruth: EVIDENCE,
});
const subjects = () => [mon('p', ['Water']), mon('q', ['Fire'])];
const run = (nodes, suppressions, replacements, mons = subjects()) =>
  resolveSourceTraits(nodes, suppressions, replacements, mons);

test('joint evaluation derives types after established source removal, preserving printed input and independent nodes', () => {
  const nodes = [node('a'), node('b', 'q', 1, ['Fire']), fixed('r')];
  const entries = [remove('b')], changes = [replacement('types-a', 'a', ['Psychic'])];
  const before = structuredClone({ nodes, entries, changes });
  const result = run(nodes, entries, changes);
  assert.equal(result.availability.get('a').enabled, false);
  assert.deepEqual(result.availability.get('a').removedBy.map((e) => e.sourceId), ['card-b']);
  assert.equal(result.availability.get('b').enabled, true);
  assert.equal(result.availability.get('r').enabled, true);
  assert.deepEqual(result.pokemonTypes.get('p').types, ['Water']);
  assert.deepEqual(result.pokemonTypes.get('q').types, ['Fire']);
  assert.deepEqual({ nodes, entries, changes }, before);
});

test('replacement and removal order is not timestamp priority; equivalent sets share sources and incompatible sets reject', () => {
  for (const reverse of [false, true]) {
    const nodes = [fixed('a'), fixed('b')], changes = [
      replacement('types-a', 'a', ['Darkness', 'Psychic']), replacement('types-b', 'b', ['Psychic', 'Darkness']),
    ];
    if (reverse) { nodes.reverse(); changes.reverse(); }
    const result = run(nodes, [], changes);
    assert.deepEqual(new Set(result.pokemonTypes.get('p').types), new Set(['Darkness', 'Psychic']));
    assert.equal(result.pokemonTypes.get('p').trace[0].replacements.length, 2);
    changes[0].spec.types = ['Fire'];
    assert.throws(() => run(nodes, [], changes), (error) => error.code === 'needs-ruling');
  }
});

test('an irrelevant typed blocker is known false even before exact types settle; an invariant type can prove removal', () => {
  const nodes = [node('a'), node('b', 'q', 1, ['Fire'])];
  let result = run(nodes, [remove('b', { type: 'Dragon' })], [replacement('t', 'a', ['Psychic'])]);
  assert.equal(result.availability.get('a').enabled, true);
  assert.deepEqual(result.pokemonTypes.get('p').types, ['Psychic']);
  result = run(nodes, [remove('b', { type: 'Water' })], [replacement('t', 'a', ['Water', 'Psychic'])]);
  assert.equal(result.availability.get('a').enabled, false);
  assert.deepEqual(result.pokemonTypes.get('p').types, ['Water']);
});

test('texts first: a stalled type loop with exactly one consistent outcome takes it, not the provisional rule', () => {
  // a makes its own Pokémon Psychic and removes the Abilities of Water Pokémon. Enabled, p is Psychic and a is untouched;
  // disabled, p would be Water but nothing removes a. Only「a enabled, p Psychic」is consistent.
  const result = run([node('a')], [remove('a', { scope: 'all', type: 'Water' })], [replacement('t', 'a', ['Psychic'])]);
  assert.deepEqual([result.availability.get('a').enabled, result.availability.get('a').removedBy], [true, []]);
  assert.deepEqual(result.pokemonTypes.get('p').types, ['Psychic']);
});

test('PROVISIONAL effects.remove-content-loop: where the texts allow no consistent outcome or several, the loop takes no effect', () => {
  // 临时规则（待官方裁定）. a would make its Pokémon Psychic; b removes a's Ability while that Pokémon is Water (two
  // consistent outcomes) or Psychic (none). Either way a neither changes types nor stays: p keeps its printed Water.
  const receipts = (result, id) => result.availability.get(id).removedBy.map((r) => [r.sourceId, r.ruleId, r.provisional]);
  const nodes = [node('a'), node('b', 'q', 1, ['Fire'])];
  for (const type of ['Water', 'Psychic']) {
    const result = run(nodes, [remove('b', { type })], [replacement('t', 'a', ['Psychic'])]);
    assert.deepEqual([result.availability.get('a').enabled, result.availability.get('b').enabled], [false, true]);
    assert.deepEqual(receipts(result, 'a'), [['card-b', 'effects.remove-content-loop', true]]);
    assert.deepEqual(result.pokemonTypes.get('p').types, ['Water']);
    assert.equal(result.pokemonTypes.get('p').trace[0].usedPrinted, true);
  }
  // A removal loop beside a resolved type provider: both locks are removed, the provider still gives Grass.
  const result = run([node('a'), node('b', 'q', 1, ['Fire']), fixed('r')], [remove('a'), remove('b')], [replacement('t', 'r', ['Grass'])]);
  assert.deepEqual(['a', 'b', 'r'].map((id) => result.availability.get(id).enabled), [false, false, true]);
  assert.deepEqual([receipts(result, 'a'), receipts(result, 'b')],
    [[['card-b', 'effects.remove-content-loop', true]], [['card-a', 'effects.remove-content-loop', true]]]);
  assert.deepEqual(result.pokemonTypes.get('p').types, ['Grass']);
});

test('disabled potential providers do not affect a known type, and typed sources retain exact actual-node receipts', () => {
  const nodes = [node('a'), node('b', 'q', 1, ['Fire']), fixed('r')];
  const blocked = remove('b');
  const result = run(nodes, [blocked], [replacement('t', 'a', ['Psychic']), replacement('fixed', 'r', ['Grass'])]);
  assert.deepEqual(result.pokemonTypes.get('p').types, ['Grass']);
  assert.equal(result.availability.get('a').removedBy[0].ruleId, 'effects.remove-content');
  const typed = run([node('a'), fixed('r')], [{ ...remove('r', { scope: 'all', type: 'Grass' }) }],
    [replacement('fixed', 'r', ['Grass'])]);
  assert.equal(typed.availability.get('a').enabled, false);
});

test('joint graph rejects nonarrays, duplicate subjects/providers, nonexistent targets or sources and incomplete evidence', () => {
  const nodes = [node('a')], change = replacement('t', 'a', ['Psychic']);
  for (const [changes, mons] of [[null, subjects()], [[], null], [[], [mon('p', [])]],
    [[], [mon('', ['Water'])]], [[], [mon('p', ['Water']), mon('p', ['Fire'])]],
    [[change, structuredClone(change)], subjects()],
    [[{ ...change, sourceNodeId: 'missing' }], subjects()],
    [[{ ...change, targets: null }], subjects()],
    [[{ ...change, targets: ['missing'] }], subjects()],
    [[{ ...change, targets: ['p', 'p'] }], subjects()],
    [[{ ...change, sourceOfTruth: [] }], subjects()],
    [[{ ...change, spec: { ...change.spec, op: 'unknown' } }], subjects()],
  ]) assert.throws(() => run(nodes, [], changes, mons));
  assert.throws(() => run([node('a', 'missing')], [], [], subjects()));
});

test('type changes cannot claim cross-holder commutation merely because their fixed target is local', () => {
  assert.throws(() => assertSubjectProgram([{
    op: 'lasting', target: 'event', side: 'own',
    effect: { op: 'pokemonTypes', scope: 'all', types: ['Psychic'] },
  }], { owner: 0 }, { owner: 0 }), (error) => error.code === 'nonlocal-trigger-program');
});
