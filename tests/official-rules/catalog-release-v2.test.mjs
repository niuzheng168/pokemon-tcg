import test from 'node:test';
import assert from 'node:assert/strict';
import { openReviewedRelease, assertReviewedRelease, catalogReleaseReceipt, CatalogReleaseError } from '../../public/rules/catalog-release.js';
import { canonicalJSON, sha256 } from '../../public/rules/catalog.js';
import { CardSchemaError } from '../../public/rules/card-schema.js';
import { EvidenceReferenceError } from '../../public/rules/release-evidence.js';
import { buildReleaseV2 } from '../../scripts/release-v2.mjs';
import { createReviewedGame, restoreReviewedGame } from '../../public/rules/reviewed-game.js';
import { bundle, open, rewrite, jsonFile } from './release-v2-fixtures.mjs';
import { RULESET } from './fixtures.mjs';

const initial = await bundle();
const copy = () => ({ ...initial, manifest: structuredClone(initial.manifest),
  files: new Map([...initial.files].map(([file, bytes]) => [file, new Uint8Array(bytes)])) });
const code = (expected) => (e) => e instanceof CatalogReleaseError && e.code === expected;
const shard = (b, id = 'ALPHA') => b.manifest.shards.find((s) => s.shardId === id);
const changeIndex = (b, change) => { const data = jsonFile(b, b.manifest.index); change(data); rewrite(b, b.manifest.index, data); };
const changeShard = (b, id, change) => { const d = shard(b, id), data = jsonFile(b, d); change(data); rewrite(b, d, data); };

test('v2 opening authenticates only the manifest; subsets load just their needed sets, not the whole pool', async () => {
  const b = copy(), reads = [];
  const release = await open(b, { readShard: async (d) => { reads.push(d.file); assert(Object.isFrozen(d)); return b.files.get(d.file); } });
  assert.equal(reads.length, 0);
  assertReviewedRelease(release);
  assert(Object.isFrozen(release) && Object.isFrozen(release.ruleset) && Object.isFrozen(release.tiers));
  assert.throws(() => assertReviewedRelease({ ...release }), code('unapproved-release-session'));
  const [index, a, c] = await Promise.all([release.index(), release.catalogFor(['printing:base']), release.catalogFor(['printing:base'])]);
  assert.equal(reads.length, 2);
  assert.equal(new Set(reads).size, reads.length);
  assert.equal(index.entries.length, 14);
  assert(Object.isFrozen(index) && Object.isFrozen(index.entries[0].card.deckLimits.groups));
  assert.throws(() => { index.entries[0].tier = 'reviewed'; }, TypeError);
  assert.deepEqual(a.printings().map((p) => p.printingId), ['printing:base']);
  assert.deepEqual(a.definitions().map((d) => d.definitionId), ['base']);
  assert.equal(a.id, c.id);
  const receipt = catalogReleaseReceipt(a);
  assert.equal(receipt.schemaVersion, '2.0.0');
  assert.equal(receipt.manifestSha256, release.manifestSha256);
  assert.equal(receipt.sha256, receipt.manifestSha256);
  assert.equal(receipt.catalogId, a.id);
  assert.deepEqual(receipt.tiers, ['reviewed']);
  assert.deepEqual(receipt.shards, [{ shardId: 'ALPHA', sha256: shard(b).sha256 }]);
  assert.deepEqual(receipt.printingIds, ['printing:base']);
  assert(Object.isFrozen(receipt.reviews[0].review.sourceOfTruth));
  assert.throws(() => catalogReleaseReceipt(initial.fullCatalog), code('unapproved-release-catalog'));
  assert.throws(() => catalogReleaseReceipt({ ...a }), code('unapproved-release-catalog'));
});

test('full v2 roundtrip is identical to whole-pool admission, while input order and duplicate selections do not affect subset identity', async () => {
  const b = copy(), release = await open(b);
  const all = await release.catalogFor((await release.index()).entries.map((e) => e.printingId));
  assert.equal(all.id, b.fullCatalog.id);
  assert.deepEqual(catalogReleaseReceipt(all).tiers, ['reviewed', 'machine']);
  assert.equal(catalogReleaseReceipt(all).shards.length, 3);
  const a = await release.catalogFor(['printing:base', 'printing:reprint', 'printing:base']);
  b.manifest.shards.reverse(); b.manifest.handlers.reverse(); b.manifest.reviews.reverse();
  const c = await (await open(b)).catalogFor(['printing:reprint', 'printing:base']);
  assert.equal(c.id, a.id);
  assert.notEqual(catalogReleaseReceipt(c).manifestSha256, catalogReleaseReceipt(a).manifestSha256);
  assert.equal(a.printings().length, 2);
  assert.equal(a.definitions().length, 1, 'reprints share their resolved definition');
});

test('unrelated shard/review updates do not invalidate a game subset; changing resolved provenance does', async () => {
  const b = copy(), a = await (await open(b)).catalogFor(['printing:base']);
  b.manifest.reviews[0].review.reviewedOn = '2026-10-21';
  changeShard(b, 'BETA', (data) => { data.sources[Object.keys(data.sources)[0]].locator += ' unrelated revision'; });
  const c = await (await open(b)).catalogFor(['printing:base']);
  assert.equal(c.id, a.id);
  assert.notEqual(catalogReleaseReceipt(c).manifestSha256, catalogReleaseReceipt(a).manifestSha256);
  changeShard(b, 'ALPHA', (data) => { data.sources[Object.keys(data.sources)[0]].locator += ' selected provenance revision'; });
  const d = await (await open(b)).catalogFor(['printing:base']);
  assert.notEqual(d.id, a.id);
  assert.equal(d.definition('base').mechanics.hp, a.definition('base').mechanics.hp);
});

test('latest-text anchors are included transitively and deterministically, including cyclic reviews', async () => {
  const b = copy(), release = await open(b), a = await release.catalogFor(['printing:old']);
  assert.deepEqual(catalogReleaseReceipt(a).printingIds, ['printing:base', 'printing:old']);
  assert.deepEqual(catalogReleaseReceipt(a).shards.map((s) => s.shardId), ['ALPHA', 'OLD']);
  assert.equal((await release.catalogFor(['printing:old', 'printing:base', 'printing:old'])).id, a.id);
  changeShard(b, 'ALPHA', (data) => {
    data.printings.find((p) => p.printingId === 'printing:base').formatReviews = [{
      format: { ...RULESET, id: 'open' }, latestPrintingId: 'printing:old',
      sourceOfTruth: [data.definitions[0].sourceOfTruth[0]],
    }];
  });
  changeIndex(b, (data) => { data.entries.find((e) => e.printingId === 'printing:base').latestPrintingIds = ['printing:old']; });
  const cycle = await (await open(b)).catalogFor(['printing:old']);
  assert.equal(cycle.printings().length, 2);
});

test('tier policy applies to definitions, machine reprints of reviewed cards, and required anchors, but not unrelated shard records', async () => {
  const b = copy(), reviewed = await open(b, { tiers: ['reviewed'] });
  await reviewed.catalogFor(['printing:base']); // ALPHA also contains a machine definition.
  for (const id of ['printing:other', 'printing:reprint'])
    await assert.rejects(reviewed.catalogFor([id]), code('release-tier-denied'));
  await assert.rejects((await open(b, { tiers: ['machine'] })).catalogFor(['printing:base']), code('release-tier-denied'));
  changeShard(b, 'OLD', (data) => { data.printings[0].formatReviews[0].latestPrintingId = 'printing:reprint'; });
  changeIndex(b, (data) => { data.entries.find((e) => e.printingId === 'printing:old').latestPrintingIds = ['printing:reprint']; });
  await assert.rejects((await open(b, { tiers: ['reviewed'] })).catalogFor(['printing:old']), code('release-tier-denied'));
});

test('host trust, handlers, tier policy and selections are detached before asynchronous work', async () => {
  const b = copy(), trust = new Map([[b.manifest.releaseId, await sha256(canonicalJSON(b.manifest))]]);
  const handlers = new Map(b.f.handlers), tiers = ['reviewed'];
  const task = openReviewedRelease({ manifestJson: JSON.stringify(b.manifest), trustedReleases: trust, handlers, tiers,
    readShard: async (d) => b.files.get(d.file) });
  trust.clear(); handlers.clear(); tiers.push('machine');
  const release = await task, ids = ['printing:base'], pending = release.catalogFor(ids);
  ids[0] = 'printing:other';
  assert.deepEqual((await pending).printings().map((p) => p.printingId), ['printing:base']);
  await assert.rejects(release.catalogFor(['printing:other']), code('release-tier-denied'));
  const all = await (await open(b)).catalogFor(['printing:base', 'printing:other']);
  b.files.forEach((bytes) => bytes.fill(0)); b.manifest.releaseId = 'changed';
  assert.equal(all.printing('printing:base').printingId, 'printing:base');
});

test('malformed host inputs, byte budgets, tier selections and unpinned manifests fail before I/O', async () => {
  const b = copy(), defaults = { manifestJson: JSON.stringify(b.manifest), readShard: async () => { throw new Error('NO IO'); } };
  for (const options of [
    { manifestJson: undefined }, { maximumManifestBytes: 1 }, { maximumManifestBytes: 0 },
    { maximumShardBytes: 1.5 }, { maximumIndexBytes: Infinity },
  ]) await assert.rejects(openReviewedRelease({ ...defaults, ...options }), code('invalid-release-input'));
  await assert.rejects(openReviewedRelease({ ...defaults, trustedReleases: {} }), code('invalid-release-trust'));
  await assert.rejects(openReviewedRelease({ ...defaults, readShard: undefined }), code('invalid-release-reader'));
  for (const tiers of [null, [], ['unknown'], ['reviewed', 'reviewed'], Array(1), ['machine', undefined]])
    await assert.rejects(openReviewedRelease({ ...defaults, tiers }), code('invalid-release-tiers'));
  await assert.rejects(openReviewedRelease({ ...defaults, manifestJson: '{' }), code('invalid-release-json'));
  await assert.rejects(openReviewedRelease({ ...defaults, manifestJson: '{}' }), code('invalid-release-shape'));
  await assert.rejects(openReviewedRelease(defaults), code('unapproved-release'));
  await assert.rejects(openReviewedRelease({ ...defaults, trustedReleases: new Map([[b.manifest.releaseId, 'f'.repeat(64)]]) }),
    code('unapproved-release'));
});

test('manifest build, rules and installed function contracts remain independently pinned', async () => {
  for (const field of ['kernelSha256', 'schemaSha256', 'rulesSha256']) {
    const b = copy(); b.manifest[field] = 'f'.repeat(64);
    await assert.rejects(open(b), code(field === 'rulesSha256' ? 'incompatible-release-rules' : 'incompatible-release-build'));
  }
  const b = copy(); b.manifest.handlers[0].sha256 = 'f'.repeat(64);
  await assert.rejects(open(b), code('release-content-mismatch'));
  const c = copy(); c.manifest.handlers.push(c.manifest.handlers[0]);
  await assert.rejects(open(c), code('duplicate-release-id'));
  const handlers = new Map(b.f.handlers), [id, h] = [...handlers][0];
  handlers.set(id, { ...h, execute() { return []; } });
  await assert.rejects(open(copy(), { handlers }), code('release-content-mismatch'));
  await assert.rejects(open(copy(), { handlers: {} }), code('invalid-handler-registry'));
});

test('manifest descriptor naming, per-tier reviews and totals cannot be self-inconsistent even under a fixture approval', async () => {
  for (const mutate of [
    (b) => { shard(b).file = 'shards/ALPHA.aaaaaaaaaaaaaaaa.json'; },
    (b) => { shard(b).setCode = 'DIFFERENT'; },
    (b) => { shard(b).printings = { reviewed: 0, machine: 0 }; },
    (b) => { b.manifest.index.file = 'pool-index.aaaaaaaaaaaaaaaa.json'; },
    (b) => { b.manifest.index.printings++; },
  ]) {
    const b = copy(); mutate(b); await assert.rejects(open(b), code('invalid-release-descriptor'));
  }
  for (const mutate of [
    (b) => { b.manifest.shards.push(b.manifest.shards[0]); },
    (b) => { b.manifest.reviews[1] = structuredClone(b.manifest.reviews[0]); },
  ]) {
    const b = copy(); mutate(b); await assert.rejects(open(b), code('duplicate-release-id'));
  }
  const b = copy(); b.manifest.reviews = [b.manifest.reviews[0]];
  await assert.rejects(open(b), code('invalid-release-review'));
  const c = copy(); c.manifest.reviews[1].pipeline.gold.matched = 2;
  await assert.rejects(open(c), code('invalid-release-review'));
  const d = copy(); delete d.manifest.reviews[1].pipeline;
  await assert.rejects(open(d), code('invalid-release-shape'));
  const e = copy(); shard(e).file = '../escape.json';
  await assert.rejects(open(e), code('invalid-release-shape'));
});

test('invalid selections and unknown printings never trigger shard downloads', async () => {
  const b = copy(), reads = [], release = await open(b, { readShard: async (d) => { reads.push(d.file); return b.files.get(d.file); } });
  for (const ids of [null, [], 'printing:base', [1], Array(1)])
    await assert.rejects(release.catalogFor(ids), code('invalid-release-selection'));
  assert.equal(reads.length, 0);
  await assert.rejects(release.catalogFor(['unimplemented']), code('unknown-release-printing'));
  assert.deepEqual(reads, [b.manifest.index.file]);
});

test('file byte budgets and exact binary result contracts are enforced before parsing', async () => {
  const b = copy();
  await assert.rejects((await open(b, { maximumIndexBytes: 1 })).index(), code('release-file-budget'));
  await assert.rejects((await open(b, { maximumShardBytes: 1 })).catalogFor(['printing:base']), code('release-file-budget'));
  for (const readShard of [async () => '{}', async () => new Uint8Array(0)])
    await assert.rejects((await open(b, { readShard })).index(), code('invalid-release-file'));
});

test('raw byte digests precede JSON/UTF-8 parsing; reformatting requires a new independently pinned descriptor', async () => {
  const b = copy(), bad = new Uint8Array(b.files.get(b.manifest.index.file)); bad[0] = 255;
  await assert.rejects((await open(b, { readShard: async () => bad })).index(), code('release-file-digest'));
  for (const bytes of [new Uint8Array([255]), new TextEncoder().encode('{'), new Uint8Array([239, 187, 191, 123, 125])]) {
    const c = copy(); rewrite(c, c.manifest.index, bytes, true);
    await assert.rejects((await open(c)).index(), code('invalid-release-file-json'));
  }
  const c = copy(), descriptor = shard(c), data = jsonFile(c, descriptor);
  const before = await (await open(c)).catalogFor(['printing:base']);
  const formatted = new TextEncoder().encode(JSON.stringify(data, null, 2));
  // Same JSON, different bytes: the unchanged descriptor must reject it.
  const replacement = new Uint8Array(descriptor.bytes); replacement.set(c.files.get(descriptor.file)); replacement[0] = 32;
  c.files.set(descriptor.file, replacement);
  await assert.rejects((await open(c)).catalogFor(['printing:base']), code('release-file-digest'));
  rewrite(c, descriptor, formatted, true);
  assert.equal((await (await open(c)).catalogFor(['printing:base'])).id, before.id);
});

test('downloaded bytes are copied before asynchronous hashing; mutation of the reader buffer cannot change authenticated data', async () => {
  const b = copy(), original = crypto.subtle.digest, returned = [];
  crypto.subtle.digest = function (algorithm, bytes) {
    // Runs after the loader's byte snapshot but before the actual async hash.
    returned.forEach((buffer) => buffer.fill(0));
    return original.call(this, algorithm, bytes);
  };
  try {
    const release = await open(b, { readShard: async (d) => {
      const buffer = new Uint8Array(b.files.get(d.file)); returned.push(buffer); return buffer;
    } });
    const c = await release.catalogFor(['printing:base']);
    assert.equal(c.definition('base').name, '测试宝可梦base');
    assert(returned.every((bytes) => bytes.every((v) => v === 0)));
  } finally { crypto.subtle.digest = original; }
});

test('concurrent reads share verified cache entries; transient rejection evicts only the failed entry and allows retry', async () => {
  const b = copy(), counts = new Map();
  const release = await open(b, { readShard: async (d) => {
    const n = (counts.get(d.file) || 0) + 1; counts.set(d.file, n);
    if (n === 1) throw new Error('transient fixture I/O failure');
    return b.files.get(d.file);
  } });
  const failed = await Promise.allSettled([release.index(), release.index()]);
  assert(failed.every((r) => r.status === 'rejected' && /transient/.test(r.reason.message)));
  await release.index();
  await assert.rejects(release.catalogFor(['printing:base']), /transient/);
  const [a, c] = await Promise.all([release.catalogFor(['printing:base']), release.catalogFor(['printing:base'])]);
  assert.equal(a.id, c.id);
  assert.equal(counts.get(b.manifest.index.file), 2);
  assert.equal(counts.get(shard(b).file), 2);
  const isolated = await open(b, { readShard: async () => { throw new Error('another session'); } });
  await assert.rejects(isolated.index(), /another session/);
});

test('the pinned index must be schema-valid, unique, complete, correctly routed and consistent in tier counts', async () => {
  const cases = [
    [(data) => { data.extra = true; }, 'invalid-release-index'],
    [(data) => { data.ruleset.version = 'V20261018'; }, 'invalid-release-index'],
    [(data) => { data.entries.pop(); }, 'invalid-release-index'],
    [(data) => { data.entries[1] = structuredClone(data.entries[0]); }, 'duplicate-release-id'],
    [(data) => { data.entries[0].shardId = 'UNKNOWN'; }, 'invalid-release-index'],
    [(data) => { data.entries[0].printing.setCode = 'UNKNOWN'; }, 'invalid-release-index'],
    [(data) => { data.entries[0].latestPrintingIds = ['missing-anchor']; }, 'invalid-release-index'],
    [(data) => { data.entries.find((e) => e.tier === 'machine').tier = 'reviewed'; }, 'invalid-release-index'],
  ];
  for (const [mutate, expected] of cases) {
    const b = copy(); changeIndex(b, mutate);
    await assert.rejects((await open(b)).index(), code(expected));
  }
});

test('shard envelope, complete evidence, full card shape, uniqueness and self-contained bindings are all checked', async () => {
  const cases = [
    [(data) => { data.extra = true; }, code('invalid-release-shard')],
    [(data) => { data.shardId = 'WRONG'; }, code('invalid-release-shard')],
    [(data) => { data.setCode = 'WRONG'; }, code('invalid-release-shard')],
    [(data) => { data.sources[Object.keys(data.sources)[0]].url = 'https://evil.example/'; }, code('invalid-release-shard')],
    [(data) => { data.definitions[0].sourceOfTruth[0].sourceId = 'unknown'; }, (e) => e instanceof EvidenceReferenceError],
    [(data) => { data.definitions[0].kind = 'guessed'; }, (e) => e instanceof CardSchemaError],
    [(data) => { data.printings[0].language = 'guess'; }, (e) => e instanceof CardSchemaError],
    [(data) => { data.definitions.push(data.definitions[0]); }, code('duplicate-release-id')],
    [(data) => { data.printings.push(data.printings[0]); }, code('duplicate-release-id')],
    [(data) => { data.printings[0].setCode = 'WRONG'; }, code('release-shard-binding')],
    [(data) => { data.printings[0].definitionBindings = []; }, code('release-shard-binding')],
    [(data) => { data.printings[0].definitionBindings[0].definitionId = 'missing'; }, code('release-shard-binding')],
    [(data) => { data.printings[0].definitionBindings.push(data.printings[0].definitionBindings[0]); }, code('release-shard-binding')],
    [(data) => { data.printings[0].identityReview = 'unreviewed'; }, (e) => e instanceof CardSchemaError],
    [(data) => { data.printings.find((p) => p.printingId === 'printing:base').identityReview = 'machine'; }, code('release-shard-counts')],
  ];
  for (const [mutate, expected] of cases) {
    const b = copy(); changeShard(b, 'ALPHA', mutate);
    await assert.rejects((await open(b)).catalogFor(['printing:base']), expected);
  }
  const b = copy(); shard(b).definitions++;
  await assert.rejects((await open(b)).catalogFor(['printing:base']), code('release-shard-counts'));
  const c = copy(), extra = jsonFile(c, shard(c, 'BETA')).definitions.find((d) => d.definitionId === 'research');
  changeShard(c, 'ALPHA', (data) => { data.definitions.push(extra); });
  shard(c).definitions++;
  await assert.rejects((await open(c)).catalogFor(['printing:base']), code('release-shard-counts'));
});

test('loaded shards cannot disagree about a shared reprint definition, or substitute indexed printings', async () => {
  const b = copy();
  changeShard(b, 'BETA', (data) => { data.definitions.find((d) => d.definitionId === 'base').mechanics.hp = 110; });
  await assert.rejects((await open(b)).catalogFor(['printing:base', 'printing:reprint']), code('release-definition-conflict'));
  for (const printingId of ['unknown-printing', 'printing:research']) {
    const c = copy(); changeShard(c, 'ALPHA', (data) => { data.printings[0].printingId = printingId; });
    await assert.rejects((await open(c)).catalogFor(['printing:base']), code('release-index-mismatch'));
  }
});

test('selected index hints cannot override executable identity, card facts, quality, bindings or anchors', async () => {
  for (const mutate of [
    (entry) => { entry.card.name = 'false identity'; },
    (entry) => { entry.definitionId = 'other'; },
    (entry) => { entry.card.deckLimits.sameName = null; },
    (entry) => { entry.formats[0].legal = !entry.formats[0].legal; },
    (entry) => { entry.latestPrintingIds = ['printing:other']; },
  ]) {
    const b = copy(); changeIndex(b, (data) => mutate(data.entries.find((e) => e.printingId === 'printing:base')));
    await assert.rejects((await open(b)).catalogFor(['printing:base']), code('release-index-mismatch'));
  }
  const b = copy();
  changeIndex(b, (data) => {
    data.entries.find((e) => e.printingId === 'printing:other').tier = 'reviewed';
    data.entries.find((e) => e.printingId === 'printing:base').tier = 'machine'; // Keep per-shard counts unchanged.
  });
  await assert.rejects((await open(b, { tiers: ['reviewed'] })).catalogFor(['printing:other']), code('release-index-mismatch'));
});

test('subset admission still rejects unimplemented cards and whole-pool building checks global invariants', async () => {
  const b = copy();
  changeShard(b, 'ALPHA', (data) => { data.definitions.find((d) => d.definitionId === 'base').implementation.status = 'partial'; });
  await assert.rejects((await open(b)).catalogFor(['printing:base']), /Unimplemented\/partial/);
  const input = structuredClone(initial.input), defs = input.definitions;
  defs[1].name = defs[0].name;
  await assert.rejects(buildReleaseV2({ releaseId: 'fixture:global', ruleset: RULESET, ...input,
    reviews: initial.manifest.reviews, handlers: initial.f.handlers }), /conflicting name identities/);
  const unused = structuredClone(initial.input); unused.definitions[0].definitionId = 'unused';
  // Keep the original base available too: the otherwise valid definition is never printed.
  unused.definitions.push(structuredClone(initial.input.definitions[0]));
  await assert.rejects(buildReleaseV2({ releaseId: 'fixture:unused', ruleset: RULESET, ...unused,
    reviews: initial.manifest.reviews, handlers: initial.f.handlers }), /unused definitions/);
});

test('reviewed game creation and restoration accept only branded v2 sessions and reproducibly rebuild the deck subset', async () => {
  const b = copy(), release = await open(b), setup = { release, decks: [b.f.deck, b.f.deck],
    seed: b.f.seed, format: { ...RULESET, id: 'standard' }, matchMode: 'normal' };
  const created = await createReviewedGame(setup), snapshot = created.game.snapshot();
  assert.equal(created.catalog.hasPrinting('printing:fire'), false, 'unselected definitions do not enter a game');
  const restored = await restoreReviewedGame({ release: await open(b), snapshot });
  assert.deepEqual(restored.game.snapshot(), snapshot);
  assert.equal(restored.approval.catalogId, created.approval.catalogId);
  assert.equal(restored.approval.manifestSha256, created.approval.manifestSha256);
  await assert.rejects(createReviewedGame({ ...setup, release: { ...release } }), code('unapproved-release-session'));
  await assert.rejects(restoreReviewedGame({ release: { ...release }, snapshot }), code('unapproved-release-session'));
  await assert.rejects(createReviewedGame({ ...setup, json: '{}' }), /OR v1/);
  await assert.rejects(restoreReviewedGame({ release, snapshot, trustedReleases: new Map() }), /OR v1/);
  const altered = structuredClone(snapshot); altered.catalogId = 'f'.repeat(64);
  await assert.rejects(restoreReviewedGame({ release, snapshot: altered }), /catalog/i);
});

test('missing printing-date facts remain explicit null hints and cannot bypass official format admission', async () => {
  const input = structuredClone(initial.input), p = input.printings.find((row) => row.printingId === 'printing:base');
  delete p.series; delete p.releasedOn;
  const built = await buildReleaseV2({ releaseId: 'fixture:missing-date', ruleset: RULESET, ...input,
    reviews: initial.manifest.reviews, handlers: initial.f.handlers });
  const release = await open({ ...initial, manifest: built.manifest, files: built.files });
  const entry = (await release.index()).entries.find((e) => e.printingId === p.printingId);
  assert.equal(entry.printing.series, null); assert.equal(entry.printing.releasedOn, null);
  assert(entry.formats.every((f) => !f.legal && f.reason === 'printing-review-required'));
  await release.catalogFor([p.printingId]);
  await assert.rejects(createReviewedGame({ release, decks: [initial.f.deck, initial.f.deck], seed: initial.f.seed,
    format: { ...RULESET, id: 'standard' }, matchMode: 'normal' }), /reviewed series and valid release date/);
});
