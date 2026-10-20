import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { resolveSourceTraits } from '../../public/rules/source-traits.js';

// Reproduce without generators:
// node --test tests/official-rules/source-traits-oracle.test.mjs
//
// This is a Boolean soundness oracle for the supported joint-source semantics,
// NOT a new CN ruling or proof that the production solver finds every fixed point.
// It deliberately imports no production graph builder, type resolver, selector,
// partial-domain helper or fixture that could compute its expected answers.
//
// Two sources / two subjects; printed Water and Psychic. Each source has ten
// provider choices: absent, or one of three nonempty target subsets crossed with
// Water / Psychic / both. Each of the four directed source→subject pairs,
// INCLUDING self-edges, has four choices: absent / untyped / Water / Psychic.
// Thus 10² × 4⁴ = 25,600 graphs, each checked in four enumeration orders.
const TYPE_NAMES = ['Water', 'Psychic'];
const PRINTED = [1, 2];
const PROVIDER_CHOICES = [
  null,
  ...[[0], [1], [0, 1]].flatMap((targets) =>
    [1, 2, 3].map((mask) => ({ targets, mask }))),
];
const EXPECTED_GRAPHS = 25_600;
const EXPECTED_CALLS = 102_400;
const REJECTION_CODES = new Set(['unresolved-type-source-cycle', 'needs-ruling']);
const EVIDENCE = [{
  sourceId: 'audit:source-traits-oracle',
  kind: 'official-rule',
  url: 'https://www.pokemon.cn/',
  locator: 'Synthetic Boolean audit input only; not independent card approval or a CN ruling.',
}];
const edgeId = ({ src, dst }) => `e${src}-${dst}`;
const typeNames = (mask) => TYPE_NAMES.filter((_name, bit) => mask & (1 << bit));

function problemAt(providerConfig, suppressionGraph) {
  const providers = [
    PROVIDER_CHOICES[providerConfig % 10],
    PROVIDER_CHOICES[Math.floor(providerConfig / 10)],
  ];
  const edges = [];
  let remaining = suppressionGraph;
  for (let src = 0; src < 2; src++) {
    for (let dst = 0; dst < 2; dst++) {
      const mode = remaining % 4;
      remaining = Math.floor(remaining / 4);
      if (mode) edges.push({ src, dst, mask: mode === 1 ? 0 : mode === 2 ? 1 : 2 });
    }
  }
  return { providers, edges };
}

/**
 * Enumerate ALL complete assignments, not an iteration from false/true.
 * Providers replace the entire set; inconsistent active sets invalidate an
 * assignment. A source is enabled iff no enabled, type-applicable source removes
 * it. Type filtering uses the target's derived set, never its printed set.
 */
function completeModels({ providers, edges }) {
  const models = [];
  for (let bits = 0; bits < 4; bits++) {
    const enabled = [Boolean(bits & 1), Boolean(bits & 2)];
    const types = [...PRINTED];
    let compatible = true;
    for (let dst = 0; dst < 2; dst++) {
      let replacement;
      for (let src = 0; src < 2; src++) {
        const provider = providers[src];
        if (!enabled[src] || !provider || !provider.targets.includes(dst)) continue;
        if (replacement !== undefined && replacement !== provider.mask) {
          compatible = false;
          break;
        }
        replacement = provider.mask;
      }
      if (!compatible) break;
      if (replacement !== undefined) types[dst] = replacement;
    }
    if (!compatible) continue;
    const satisfiesEveryEquation = enabled.every((value, dst) => {
      const removed = edges.some((edge) =>
        edge.dst === dst && enabled[edge.src] &&
        (edge.mask === 0 || (types[dst] & edge.mask) !== 0));
      return value === !removed;
    });
    if (satisfiesEveryEquation) models.push({ enabled, types });
  }
  return models;
}

function freezeData(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeData);
    Object.freeze(value);
  }
  return value;
}

// Encoding the independently enumerated problem for the system under test does
// not participate in computing completeModels().
function solverInput({ providers, edges }) {
  const nodes = [0, 1].map((i) => ({
    id: `n${i}`, kind: 'ability', instanceId: `c${i}`, pokemonId: `p${i}`,
    owner: i, key: `n${i}`, active: true,
    mechanics: { types: typeNames(PRINTED[i]), tags: [], stage: 'basic', ruleBox: false },
  }));
  const suppression = edges.map((edge) => ({
    id: edgeId(edge), sourceNodeId: `n${edge.src}`, targetId: `p${edge.dst}`,
    source: { instanceId: `c${edge.src}` },
    spec: {
      op: 'suppression', channel: 'abilities', scope: 'all',
      ...(edge.mask ? { type: typeNames(edge.mask)[0] } : {}),
    },
    sourceOfTruth: EVIDENCE,
  }));
  const typeEntries = providers.flatMap((provider, src) => provider ? [{
    id: `t${src}`, sourceNodeId: `n${src}`,
    spec: { op: 'pokemonTypes', scope: 'all', types: typeNames(provider.mask) },
    targets: provider.targets.map((dst) => `p${dst}`), sourceOfTruth: EVIDENCE,
  }] : []);
  const subjects = [0, 1].map((i) => ({ id: `p${i}`, printedTypes: typeNames(PRINTED[i]) }));
  return freezeData([nodes, suppression, typeEntries, subjects]);
}

function enumerationOrders([nodes, suppression, typeEntries, subjects]) {
  return [
    ['original', [nodes, suppression, typeEntries, subjects]],
    ['nodes-reversed', [[...nodes].reverse(), suppression, typeEntries, subjects]],
    ['providers-and-subjects-reversed', [nodes, suppression, [...typeEntries].reverse(), [...subjects].reverse()]],
    ['edges-reversed', [nodes, [...suppression].reverse(), typeEntries, subjects]],
  ].map(([name, input]) => [name, freezeData(input)]);
}

function typeMask(types, context) {
  assert.ok(Array.isArray(types), `${context}: effective types must be an array`);
  assert.ok(types.length > 0, `${context}: empty effective type set`);
  assert.equal(new Set(types).size, types.length, `${context}: duplicate effective type`);
  let mask = 0;
  for (const type of types) {
    const bit = TYPE_NAMES.indexOf(type);
    assert.notEqual(bit, -1, `${context}: unexpected type ${String(type)}`);
    mask |= 1 << bit;
  }
  return mask;
}

function assertAcceptedResult(result, model, problem, context) {
  assert.ok(result.availability instanceof Map, `${context}: missing availability Map`);
  assert.ok(result.pokemonTypes instanceof Map, `${context}: missing Pokémon types Map`);
  assert.deepEqual([...result.availability.keys()].sort(), ['n0', 'n1'], context);
  assert.deepEqual([...result.pokemonTypes.keys()].sort(), ['p0', 'p1'], context);
  const actual = { enabled: [], types: [] };
  for (let dst = 0; dst < 2; dst++) {
    const source = result.availability.get(`n${dst}`);
    const pokemon = result.pokemonTypes.get(`p${dst}`);
    assert.equal(typeof source.enabled, 'boolean', `${context}: availability must be Boolean`);
    actual.enabled.push(source.enabled);
    actual.types.push(typeMask(pokemon.types, context));

    // The logical model also determines every actual remover and active provider;
    // a correct final type alone must not hide a silently ignored live source.
    const expectedRemovers = problem.edges.filter((edge) =>
      edge.dst === dst && model.enabled[edge.src] &&
      (edge.mask === 0 || (model.types[dst] & edge.mask) !== 0)).map((edge) => ({
      effectId: edgeId(edge), sourceId: `c${edge.src}`,
      sourceOfTruth: EVIDENCE, ruleId: 'effects.remove-content',
    }));
    assert.ok(Array.isArray(source.removedBy), `${context}: missing removal receipts`);
    assert.deepEqual(
      [...source.removedBy].sort((a, b) => a.effectId.localeCompare(b.effectId)),
      expectedRemovers.sort((a, b) => a.effectId.localeCompare(b.effectId)),
      `${context}: actual removal receipts disagree with the complete model`,
    );

    const expectedProviders = problem.providers.flatMap((provider, src) =>
      provider && model.enabled[src] && provider.targets.includes(dst)
        ? [{ id: `t${src}`, mask: provider.mask, sourceOfTruth: EVIDENCE }]
        : []);
    assert.ok(Array.isArray(pokemon.trace), `${context}: missing type trace`);
    const typeTraces = pokemon.trace.filter((trace) => trace.ruleId === 'pokemon.types');
    assert.equal(typeTraces.length, 1, `${context}: expected one effective-type receipt`);
    const trace = typeTraces[0];
    assert.equal(typeMask(trace.printedTypes, context), PRINTED[dst], `${context}: printed types changed`);
    assert.equal(typeMask(trace.types, context), model.types[dst], `${context}: trace/result disagree`);
    assert.equal(trace.usedPrinted, expectedProviders.length === 0, `${context}: fallback provenance`);
    assert.ok(Array.isArray(trace.replacements), `${context}: missing provider receipts`);
    const actualProviders = trace.replacements.map((entry) => ({
      id: entry.id, mask: typeMask(entry.types, context), sourceOfTruth: entry.sourceOfTruth,
    })).sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(actualProviders, expectedProviders, `${context}: missing or spurious live provider`);
  }
  assert.deepEqual(actual, model, `${context}: accepted result is not the unique complete model`);
  return actual;
}

function evaluate(input, models, problem, context) {
  const before = JSON.stringify(input);
  let result;
  let rejected = false;
  try {
    // Only the SUT call is caught: assertion failures below cannot masquerade as
    // an expected needs-ruling/unresolved rejection.
    result = resolveSourceTraits(...input);
  } catch (error) {
    assert.ok(REJECTION_CODES.has(error?.code),
      `${context}: unexpected rejection ${error?.code ?? error?.name}: ${error?.message}`);
    rejected = true;
  } finally {
    // Frozen JSON input also makes transient writes/deletes/reorders throw in
    // the ESM solver; the snapshot checks every accepted AND rejected call.
    assert.equal(JSON.stringify(input), before, `${context}: solver mutated input`);
  }
  if (rejected) return { accepted: false };
  assert.equal(models.length, 1,
    `${context}: accepted ${models.length === 0 ? 'a contradiction' : 'an ambiguous graph'}`);
  return { accepted: true, model: assertAcceptedResult(result, models[0], problem, context) };
}

test('independent complete-assignment oracle distinguishes absence, uniqueness, ambiguity and provider conflicts', () => {
  const plain = [null, null];
  assert.deepEqual(completeModels({ providers: plain, edges: [] }), [
    { enabled: [true, true], types: [1, 2] },
  ]);
  assert.deepEqual(completeModels({
    providers: plain, edges: [{ src: 0, dst: 0, mask: 0 }],
  }), []);
  assert.deepEqual(completeModels({
    providers: plain, edges: [{ src: 0, dst: 1, mask: 0 }, { src: 1, dst: 0, mask: 0 }],
  }), [
    { enabled: [true, false], types: [1, 2] },
    { enabled: [false, true], types: [1, 2] },
  ]);
  const conflicting = [{ targets: [0], mask: 1 }, { targets: [0], mask: 2 }];
  assert.deepEqual(completeModels({ providers: conflicting, edges: [] }), []);
  assert.deepEqual(completeModels({
    providers: conflicting, edges: [{ src: 0, dst: 1, mask: 0 }],
  }), [{ enabled: [true, false], types: [1, 2] }]);
  const psychicProvider = [{ targets: [0], mask: 2 }, null];
  assert.deepEqual(completeModels({
    providers: psychicProvider, edges: [{ src: 1, dst: 0, mask: 1 }],
  }), [
    { enabled: [false, true], types: [1, 2] },
    { enabled: [true, true], types: [2, 2] },
  ]);
  assert.deepEqual(completeModels({
    providers: psychicProvider, edges: [{ src: 1, dst: 0, mask: 2 }],
  }), []);
  assert.deepEqual(completeModels({
    providers: [{ targets: [0], mask: 3 }, null], edges: [{ src: 1, dst: 0, mask: 1 }],
  }), [{ enabled: [false, true], types: [1, 2] }]);
});

test('full source-traits oracle: 25,600 graphs × four orders = 102,400 immutable solver calls', (t) => {
  const started = performance.now();
  const counts = {
    graphs: 0, calls: 0, accepted: 0, rejected: 0,
    oracleNoModel: 0, oracleUnique: 0, oracleMultiple: 0,
    conservativeUniqueRejected: 0, ambiguousRejected: 0, contradictoryRejected: 0,
  };
  for (let providerConfig = 0; providerConfig < 100; providerConfig++) {
    for (let suppressionGraph = 0; suppressionGraph < 256; suppressionGraph++) {
      const problem = problemAt(providerConfig, suppressionGraph);
      const models = completeModels(problem);
      if (models.length === 0) counts.oracleNoModel++;
      else if (models.length === 1) counts.oracleUnique++;
      else counts.oracleMultiple++;
      const input = solverInput(problem);
      let baseline;
      for (const [name, args] of enumerationOrders(input)) {
        const context = `providerConfig=${providerConfig}, suppressionGraph=${suppressionGraph}, order=${name}`;
        const outcome = evaluate(args, models, problem, context);
        // A readily determined nonconflicting graph must not pass vacuously by
        // rejecting everything. More difficult unique models MAY be rejected.
        if (problem.edges.length === 0 && models.length === 1)
          assert.equal(outcome.accepted, true, `${context}: rejected an unblocked, compatible graph`);
        if (baseline === undefined) {
          baseline = outcome;
          if (outcome.accepted) counts.accepted++;
          else {
            counts.rejected++;
            if (models.length === 0) counts.contradictoryRejected++;
            else if (models.length === 1) counts.conservativeUniqueRejected++;
            else counts.ambiguousRejected++;
          }
        } else {
          // Compare acceptance and semantic sets, not Map/trace enumeration or
          // which unsupported-condition error happens to be reported first.
          assert.deepEqual(outcome, baseline, `${context}: enumeration order chose an outcome`);
        }
        counts.calls++;
      }
      counts.graphs++;
    }
  }
  assert.equal(counts.graphs, EXPECTED_GRAPHS);
  assert.equal(counts.calls, EXPECTED_CALLS);
  // These are properties of the independent finite domain, NOT acceptance quotas.
  assert.equal(counts.oracleNoModel, 14_096);
  assert.equal(counts.oracleUnique, 9_907);
  assert.equal(counts.oracleMultiple, 1_597);
  assert.equal(counts.contradictoryRejected, counts.oracleNoModel);
  assert.equal(counts.ambiguousRejected, counts.oracleMultiple);
  assert.equal(counts.accepted + counts.conservativeUniqueRejected, counts.oracleUnique);
  assert.equal(counts.accepted + counts.rejected, EXPECTED_GRAPHS);
  assert.ok(counts.accepted > 0, 'soundness must not be vacuous');

  t.diagnostic(JSON.stringify({ ...counts, elapsedMs: Math.round(performance.now() - started) }));
  t.diagnostic(
    'Soundness/order/immutability checked over the whole domain; NOT fixed-point completeness. ' +
    'The initial audit conservatively rejected 6,232 unique-model graphs. That is a diagnostic ' +
    'baseline, not an expected-rejection assertion; future sound resolution may reduce it.',
  );
});
