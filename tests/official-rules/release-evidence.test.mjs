import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeEvidenceRefs, resolveEvidenceRefs, EvidenceReferenceError } from '../../public/rules/release-evidence.js';
import { assertDefinitionShape, assertPrintingShape, assertExecutableDefinition, canonicalDefinition } from '../../public/rules/card-schema.js';
import { canonicalJSON } from '../../public/rules/catalog.js';
import { fixture, EVIDENCE, RULESET } from './fixtures.mjs';

const source = EVIDENCE[0];
const library = { sourceId: 'fixture:library', kind: 'card-library', url: 'https://tcg.mik.moe/cards/fixture',
  locator: 'TEST ONLY, not a real card' };
const ref = (s) => ({ sourceId: s.sourceId, kind: s.kind });
const record = (s = source) => [{ sourceOfTruth: [structuredClone(s)] }];

test('wire compression roundtrips nested complete card evidence without changing canonical runtime content', async () => {
  const f = await fixture(), input = [...f.definitions, ...f.catalog.printings()], before = canonicalJSON(input);
  const { records, sources } = encodeEvidenceRefs(input);
  assert.equal(Object.keys(sources).length, 1);
  assert.equal(canonicalJSON(resolveEvidenceRefs(records, sources)), before);
  assert.equal(canonicalJSON(input), before);
  assert.throws(() => assertDefinitionShape(records[0]), /Invalid normalized/);
  assert.throws(() => assertPrintingShape(records[f.definitions.length]), /Invalid card printing/);
  assert.deepEqual(encodeEvidenceRefs([]), { records: [], sources: {} });
  assert.deepEqual(resolveEvidenceRefs([], {}), []);
});

test('only reserved sourceOfTruth lists are compressed, preserving ordinary JSON and evidence-shaped data', () => {
  const rule = { ...source, sourceId: 'fixture:rule', kind: 'official-rule', textSha256: 'a'.repeat(64), observedOn: '2026-10-22' };
  const erratum = { ...source, sourceId: 'fixture:erratum', kind: 'official-erratum' };
  const input = [{ scalar: null, list: [1, 'x', true, false, null], ordinary: source,
    nested: [{ sourceOfTruth: [source, rule, library, erratum] }] }];
  const wire = encodeEvidenceRefs(input), expanded = resolveEvidenceRefs(wire.records, wire.sources);
  assert.deepEqual(wire.records[0].ordinary, source);
  assert.deepEqual(wire.records[0].nested[0].sourceOfTruth, [source, rule, library, erratum].map(ref));
  assert.deepEqual(expanded, input);
  assert.deepEqual(Object.keys(wire.sources), Object.keys(wire.sources).sort());
  const reversed = Object.fromEntries(Object.entries(source).reverse());
  assert.deepEqual(encodeEvidenceRefs([{ sourceOfTruth: [source, reversed] }]).sources, { [source.sourceId]: source });
  expanded[0].nested[0].sourceOfTruth[0].locator = 'changed';
  assert.notEqual(wire.sources[source.sourceId].locator, 'changed');
  assert.notEqual(input[0].nested[0].sourceOfTruth[0].locator, 'changed');
});

test('strict JSON is checked before inspecting records or source tables, without invoking accessors', () => {
  let calls = 0;
  const getter = Object.defineProperty({}, 'sourceOfTruth', { enumerable: true, get() { calls++; return [source]; } });
  const cyclic = {}; cyclic.loop = cyclic;
  const symbol = { [Symbol('hidden')]: 1 };
  const hidden = Object.defineProperty({}, 'x', { value: 1 });
  const prototype = Object.create({ inherited: source });
  const bad = [undefined, null, {}, [null], [1], [[]], [new Date()], [cyclic], [symbol], [hidden], [prototype], [getter], Array(1),
    [{ number: NaN }], [{ fn() {} }], [{ missing: undefined }]];
  for (const value of bad) {
    assert.throws(() => encodeEvidenceRefs(value), EvidenceReferenceError);
    assert.throws(() => resolveEvidenceRefs(value, {}), EvidenceReferenceError);
  }
  for (const sources of [null, [], 2, new Date(), cyclic, symbol, hidden, getter])
    assert.throws(() => resolveEvidenceRefs([], sources), EvidenceReferenceError);
  assert.equal(calls, 0);
});

test('source compression rejects incomplete evidence, extra authority claims, host spoofing and conflicting source IDs', () => {
  for (const evidence of [
    ref(source), { ...source, url: 'https://www.pokemon.cn.evil.example/' }, { ...source, unsigned: true },
    { ...source, kind: 'imagined' }, { ...library, textSha256: 'a'.repeat(64) }, null,
  ]) assert.throws(() => encodeEvidenceRefs(record(evidence)), /complete, exact-host/);
  for (const changed of [
    { ...source, locator: 'another location' }, { ...source, url: 'https://www.pokemon.cn/changed' },
    { ...source, observedOn: '2026-10-22' }, { ...source, kind: 'official-rule' },
  ]) assert.throws(() => encodeEvidenceRefs([{ sourceOfTruth: [source, changed] }]), /Conflicting content/);
  for (const value of [null, {}, [], 'not evidence'])
    assert.throws(() => encodeEvidenceRefs([{ sourceOfTruth: value }]), /nonempty evidence list/);
});

test('reference expansion fails closed on missing, aliased, mismatched, unused, inline and malformed evidence', () => {
  const wire = [{ sourceOfTruth: [ref(source)] }], table = { [source.sourceId]: source };
  assert.throws(() => resolveEvidenceRefs(wire, {}), /Unresolved/);
  assert.throws(() => resolveEvidenceRefs(wire, { wrong: source }), /key must equal/);
  assert.throws(() => resolveEvidenceRefs(wire, { ...table, [library.sourceId]: library }), /Unreferenced/);
  assert.throws(() => resolveEvidenceRefs(wire, { [source.sourceId]: { ...source, kind: 'official-rule' } }), /kind mismatch/);
  for (const s of [null, ref(source), { ...source, url: 'https://evil.example/' }])
    assert.throws(() => resolveEvidenceRefs(wire, { [source.sourceId]: s }), /key must equal/);
  for (const r of [source, { ...ref(source), url: source.url }, { sourceId: source.sourceId }, { ...ref(source), kind: 'imagined' }])
    assert.throws(() => resolveEvidenceRefs([{ sourceOfTruth: [r] }], table), /exact sourceId\/kind/);
  for (const value of [null, {}, []])
    assert.throws(() => resolveEvidenceRefs([{ sourceOfTruth: value }], table), /nonempty evidence list/);
});

test('prototype-named source IDs are treated as own data, never prototype lookup or mutation', () => {
  const s = { ...source, sourceId: 'constructor' }, input = record(s);
  const wire = encodeEvidenceRefs(input);
  assert(Object.hasOwn(wire.sources, 'constructor'));
  assert.deepEqual(resolveEvidenceRefs(wire.records, wire.sources), input);
  assert.throws(() => resolveEvidenceRefs([{ sourceOfTruth: [{ sourceId: 'toString', kind: source.kind }] }], {}), /Unresolved/);
  const polluted = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(() => resolveEvidenceRefs([], polluted), /key must equal/);
  assert.equal({}.polluted, undefined);
});

test('resolved occurrences are isolated copies, including when source-table objects are null-prototype records', () => {
  const s = Object.assign(Object.create(null), source), table = Object.assign(Object.create(null), { [s.sourceId]: s });
  const expanded = resolveEvidenceRefs([{ sourceOfTruth: [ref(s), ref(s)] }], table);
  expanded[0].sourceOfTruth[0].locator = 'changed';
  assert.equal(expanded[0].sourceOfTruth[1].locator, source.locator);
  assert.equal(table[s.sourceId].locator, source.locator);
});

test('reference resolution does not elevate library evidence to reviewed-card or official-ruling authority', async () => {
  const f = await fixture(), d = structuredClone(f.definitions[0]);
  d.sourceOfTruth = [library];
  const wire = encodeEvidenceRefs([d]), [expanded] = resolveEvidenceRefs(wire.records, wire.sources);
  assertDefinitionShape(expanded);
  assert.throws(() => assertExecutableDefinition(expanded, { ruleset: RULESET, handlers: f.handlers,
    approvedDefinitions: new Map([[d.definitionId, canonicalDefinition(expanded)]]) }), /General game rules/);
  const p = structuredClone(f.catalog.printings()[0]);
  p.formatReviews = [{ format: { ...RULESET, id: 'standard' }, latestPrintingId: p.printingId, sourceOfTruth: [library] }];
  const pw = encodeEvidenceRefs([p]), [resolved] = resolveEvidenceRefs(pw.records, pw.sources);
  assert.throws(() => assertPrintingShape(resolved), /Invalid card printing/);
});
