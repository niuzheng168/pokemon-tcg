import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { resolveSourceTraits } from '../../public/rules/source-traits.js';

// Reproduce without generators:
// node --test tests/official-rules/source-traits-oracle.test.mjs
//
// Two independent oracles, neither a CN ruling. (1) The complete-assignment
// oracle: where the texts allow exactly one consistent outcome, the solver must
// return it, never through the provisional rule. (2) Everywhere else, an
// independent model of the solver's three-valued propagation, of the texts-first
// enumeration where it stalls and of the PROVISIONAL effects.remove-content-loop
// (临时规则（待官方裁定）: the first loops take no effect) must match exactly.
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
// Two different type replacements in force at once still need a CN ruling; a stalled loop never rejects.
const REJECTION_CODES = new Set(['needs-ruling']);
const LOOP_RULE_ID = 'effects.remove-content-loop';
// Of the 15,693 graphs with no consistent outcome or several: resolved through the provisional rule, or rejected because two
// different type replacements end up in force.
const PROVISIONAL_GRAPHS = 15_579, NEEDS_RULING_GRAPHS = 114;
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

const receipt = (edge, ruleId) => ({ effectId: edgeId(edge), sourceId: `c${edge.src}`, sourceOfTruth: EVIDENCE, ruleId,
  ...(ruleId === LOOP_RULE_ID ? { provisional: true } : {}) });
const providersOf = (providers, dst) => [0, 1].filter((src) => providers[src]?.targets.includes(dst));
// The receipts and live providers an outcome implies: actual removers under the derived types, or, for a source taken by the
// provisional rule, the removals it was still waiting on.
function expectation({ providers, edges }, enabled, types, waits = [null, null]) {
  return {
    enabled, types,
    removedBy: [0, 1].map((dst) => waits[dst] ? waits[dst].map((edge) => receipt(edge, LOOP_RULE_ID)) : edges.filter((edge) =>
      edge.dst === dst && enabled[edge.src] && (edge.mask === 0 || (types[dst] & edge.mask) !== 0)).map((edge) => receipt(edge, 'effects.remove-content'))),
    providers: [0, 1].map((dst) => providersOf(providers, dst).filter((src) => enabled[src])
      .map((src) => ({ id: `t${src}`, mask: providers[src].mask, sourceOfTruth: EVIDENCE }))),
  };
}

/**
 * Independent model of the solver for this domain. Three-valued propagation: a
 * Pokémon's possible type sets are its live replacement (or printed set) and each
 * undecided provider's set, known once they all agree; a removal is true, false or
 * open; a source is disabled by a true removal, enabled when all are false. Where
 * that stalls: split the stuck sources into unlinked parts (a removal or type
 * dependency, or providers of one Pokémon), give a part its only consistent
 * assignment, else disable each first loop (closure over the dependencies) with
 * the removals it waits on. Live replacements that disagree reject.
 */
function stalledModel(problem) {
  const { providers, edges } = problem, status = [null, null], known = [null, null], waits = [null, null];
  const live = (dst) => {
    const masks = [...new Set(providersOf(providers, dst).filter((src) => status[src] === true).map((src) => providers[src].mask))];
    if (masks.length > 1) throw new Error('needs-ruling');
    return masks.length ? masks[0] : PRINTED[dst];
  };
  const possible = (dst) => known[dst] !== null ? [known[dst]]
    : [live(dst), ...providersOf(providers, dst).filter((src) => status[src] === null).map((src) => providers[src].mask)];
  const reaches = (edge) => {
    if (!edge.mask) return true;
    const masks = possible(edge.dst);
    return masks.every((m) => !(m & edge.mask)) ? false : masks.every((m) => m & edge.mask) ? true : null;
  };
  const edgeState = (edge) => {
    if (status[edge.src] === false) return false;
    const r = reaches(edge);
    return r === false ? false : r === null ? null : status[edge.src] === true ? true : null;
  };
  try {
    for (;;) {
      for (let changed = true; changed;) {
        changed = false;
        for (const dst of [0, 1]) if (known[dst] === null) {
          const mask = live(dst);
          if (providersOf(providers, dst).every((src) => status[src] !== null || providers[src].mask === mask)) { known[dst] = mask; changed = true; }
        }
        for (const dst of [0, 1]) if (status[dst] === null) {
          const states = edges.filter((edge) => edge.dst === dst).map(edgeState);
          if (states.includes(true)) { status[dst] = false; changed = true; }
          else if (states.every((v) => v === false)) { status[dst] = true; changed = true; }
        }
      }
      const open = [0, 1].filter((i) => status[i] === null);
      if (!open.length) break;
      const undecided = [], dep = [[false, false], [false, false]], waiting = [null, null];
      for (const n of open) {
        waiting[n] = edges.filter((edge) => edge.dst === n && edgeState(edge) === null);
        for (const edge of waiting[n]) {
          if (status[edge.src] === null) dep[edge.src][n] = true;
          if (edge.mask && reaches(edge) === null) for (const src of providersOf(providers, n)) if (status[src] === null) dep[src][n] = true;
        }
      }
      const linked = open.length === 2 && (dep[0][1] || dep[1][0] || [0, 1].some((dst) => providersOf(providers, dst).length === 2));
      for (const part of linked ? [open] : open.map((n) => [n])) {
        const fits = [];
        for (let bits = 0; bits < 2 ** part.length; bits++) {
          const on = (i) => status[i] ?? (part.includes(i) ? !!(bits & (1 << part.indexOf(i))) : false);
          const types = [0, 1].map((dst) => {
            const masks = [...new Set(providersOf(providers, dst).filter(on).map((src) => providers[src].mask))];
            return masks.length > 1 ? null : masks.length ? masks[0] : PRINTED[dst];
          });
          if (types.includes(null)) continue;
          if (part.every((n) => on(n) === !edges.some((edge) => edge.dst === n && on(edge.src) && (!edge.mask || (types[n] & edge.mask)))))
            fits.push(part.map(on));
        }
        if (fits.length === 1) part.forEach((n, i) => { status[n] = fits[0][i]; });
        else undecided.push(...part);
      }
      // Closure of the dependencies among the undecided sources; a first loop's sources are reached back by all that reach them.
      const r = [0, 1].map((a) => [0, 1].map((b) => undecided.includes(a) && undecided.includes(b) && dep[a][b]));
      for (const k of [0, 1]) for (const a of [0, 1]) for (const b of [0, 1]) r[a][b] ||= r[a][k] && r[k][b];
      for (const n of undecided.filter((n) => undecided.every((m) => !r[m][n] || r[n][m]))) { status[n] = false; waits[n] = waiting[n]; }
    }
    return { rejected: false, ...expectation(problem, status, [0, 1].map(live), waits) };
  } catch (error) {
    if (error.message === 'needs-ruling') return { rejected: true };
    throw error;
  }
}

function assertResult(result, expected, context) {
  assert.ok(result.availability instanceof Map, `${context}: missing availability Map`);
  assert.ok(result.pokemonTypes instanceof Map, `${context}: missing Pokémon types Map`);
  assert.deepEqual([...result.availability.keys()].sort(), ['n0', 'n1'], context);
  assert.deepEqual([...result.pokemonTypes.keys()].sort(), ['p0', 'p1'], context);
  const byId = (a, b) => a.effectId.localeCompare(b.effectId);
  for (let dst = 0; dst < 2; dst++) {
    const source = result.availability.get(`n${dst}`), pokemon = result.pokemonTypes.get(`p${dst}`);
    assert.equal(source.enabled, expected.enabled[dst], `${context}: availability`);
    assert.equal(typeMask(pokemon.types, context), expected.types[dst], `${context}: effective types`);
    // The receipts name every actual remover (or, under the provisional rule, the loop's removals); a correct final type
    // alone must not hide a silently ignored live source.
    assert.ok(Array.isArray(source.removedBy), `${context}: missing removal receipts`);
    assert.deepEqual([...source.removedBy].sort(byId), [...expected.removedBy[dst]].sort(byId), `${context}: removal receipts`);
    assert.ok(Array.isArray(pokemon.trace), `${context}: missing type trace`);
    const typeTraces = pokemon.trace.filter((trace) => trace.ruleId === 'pokemon.types');
    assert.equal(typeTraces.length, 1, `${context}: expected one effective-type receipt`);
    const trace = typeTraces[0];
    assert.equal(typeMask(trace.printedTypes, context), PRINTED[dst], `${context}: printed types changed`);
    assert.equal(typeMask(trace.types, context), expected.types[dst], `${context}: trace/result disagree`);
    assert.equal(trace.usedPrinted, expected.providers[dst].length === 0, `${context}: fallback provenance`);
    const actualProviders = trace.replacements.map((entry) => ({
      id: entry.id, mask: typeMask(entry.types, context), sourceOfTruth: entry.sourceOfTruth,
    })).sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(actualProviders, expected.providers[dst], `${context}: missing or spurious live provider`);
  }
  return { enabled: [...expected.enabled], types: [...expected.types] };
}

function evaluate(input, models, model, problem, context) {
  const before = JSON.stringify(input);
  let result;
  let rejected = false;
  try {
    // Only the SUT call is caught: assertion failures below cannot masquerade as
    // an expected needs-ruling rejection.
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
  // (1) Texts first, independent of the model: one consistent outcome is always accepted as exactly that outcome.
  if (models.length === 1) {
    assert.equal(rejected, false, `${context}: rejected the texts' only consistent outcome`);
    const unique = expectation(problem, models[0].enabled, models[0].types);
    assertResult(result, unique, context);
    const { rejected: modelRejected, ...modelOutcome } = model;
    assert.equal(modelRejected, false, `${context}: model rejected a unique outcome`);
    assert.deepEqual(modelOutcome, unique, `${context}: model disagrees with the unique outcome`);
  }
  // (2) Everything else matches the independent stalled-graph model exactly.
  assert.equal(rejected, model.rejected, `${context}: rejection disagrees with the model`);
  if (rejected) return { accepted: false };
  assertResult(result, model, context);
  const provisional = [...result.availability.values()].some((a) => a.removedBy.some((r) => r.provisional));
  assert.equal(provisional, models.length !== 1, `${context}: the provisional rule applies exactly where the texts leave it open`);
  return { accepted: true, provisional, enabled: model.enabled, types: model.types };
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
    graphs: 0, calls: 0, accepted: 0, rejected: 0, provisional: 0,
    oracleNoModel: 0, oracleUnique: 0, oracleMultiple: 0, uniqueAccepted: 0,
  };
  for (let providerConfig = 0; providerConfig < 100; providerConfig++) {
    for (let suppressionGraph = 0; suppressionGraph < 256; suppressionGraph++) {
      const problem = problemAt(providerConfig, suppressionGraph);
      const models = completeModels(problem), model = stalledModel(problem);
      if (models.length === 0) counts.oracleNoModel++;
      else if (models.length === 1) counts.oracleUnique++;
      else counts.oracleMultiple++;
      const input = solverInput(problem);
      let baseline;
      for (const [name, args] of enumerationOrders(input)) {
        const context = `providerConfig=${providerConfig}, suppressionGraph=${suppressionGraph}, order=${name}`;
        const outcome = evaluate(args, models, model, problem, context);
        if (baseline === undefined) {
          baseline = outcome;
          if (!outcome.accepted) counts.rejected++;
          else {
            counts.accepted++;
            if (outcome.provisional) counts.provisional++;
            if (models.length === 1) counts.uniqueAccepted++;
          }
        } else {
          // Compare acceptance and semantic sets, not Map/trace enumeration.
          assert.deepEqual(outcome, baseline, `${context}: enumeration order chose an outcome`);
        }
        counts.calls++;
      }
      counts.graphs++;
    }
  }
  assert.equal(counts.graphs, EXPECTED_GRAPHS);
  assert.equal(counts.calls, EXPECTED_CALLS);
  // Properties of the independent finite domain, not acceptance quotas.
  assert.equal(counts.oracleNoModel, 14_096);
  assert.equal(counts.oracleUnique, 9_907);
  assert.equal(counts.oracleMultiple, 1_597);
  // Every unique outcome is accepted (the earlier solver rejected 6,232 of them). The rest either reject because two
  // different type replacements end up in force (needs-ruling), or resolve through the provisional rule.
  assert.equal(counts.uniqueAccepted, counts.oracleUnique);
  assert.equal(counts.accepted + counts.rejected, EXPECTED_GRAPHS);
  assert.equal(counts.provisional + counts.rejected, counts.oracleNoModel + counts.oracleMultiple);
  assert.deepEqual([counts.provisional, counts.rejected], [PROVISIONAL_GRAPHS, NEEDS_RULING_GRAPHS]);

  t.diagnostic(JSON.stringify({ ...counts, elapsedMs: Math.round(performance.now() - started) }));
});
