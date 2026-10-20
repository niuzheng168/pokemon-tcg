import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createCardCatalog, canonicalJSON, sha256 } from '../../public/rules/catalog.js';
import { canonicalDefinition, canonicalPrinting, assertPrintingApproval, assertPrintingBinding } from '../../public/rules/card-schema.js';
import { catalogCandidateFacts, loadReviewedCatalogRelease, catalogReleaseReceipt, CatalogReleaseError } from '../../public/rules/catalog-release.js';
import { createReviewedGame, restoreReviewedGame } from '../../public/rules/reviewed-game.js';
import { KERNEL_BUILD } from '../../public/rules/kernel-build.js';
import { fixture, RULESET, EVIDENCE, settle, command } from './fixtures.mjs';

// Synthetic specification fixtures ONLY. No production allowlist is created.
const exec = promisify(execFile);
const root = new URL('../../', import.meta.url);
const code = (expected) => (error) => error instanceof CatalogReleaseError && error.code === expected;
async function bundle(f = null) {
  f ??= await fixture();
  const definitions = structuredClone(f.definitions), printings = structuredClone(f.catalog.printings());
  const facts = await catalogCandidateFacts({ ruleset: RULESET, definitions, printings, handlers: f.handlers });
  const manifest = { schemaVersion: '1.0.0', releaseId: 'TEST-NOT-A-REAL-RELEASE', ...facts, review: {
    reviewId: 'fixture:review', reviewerId: 'fixture:not-an-official-reviewer', reviewedOn: '2026-10-20',
    testIds: ['fixture:catalog-release'], sourceOfTruth: EVIDENCE,
  } };
  return { f, data: structuredClone({ manifest, definitions, printings }) };
}
async function load(data, handlers, options = {}) {
  const trustedReleases = new Map([[data.manifest.releaseId, await sha256(canonicalJSON(data.manifest))]]);
  return loadReviewedCatalogRelease({ json: JSON.stringify(data), trustedReleases, handlers, ...options });
}
const low = (f, printings, approvals = null) => createCardCatalog({
  ruleset: RULESET, definitions: f.definitions, printings, handlers: f.handlers,
  approvedDefinitions: new Map(f.definitions.map((d) => [d.definitionId, canonicalDefinition(d)])),
  ...(approvals ? { approvedPrintings: approvals } : {}),
});

test('verified metadata never substitutes for independent content-bound printing and definition-binding approval', async () => {
  const f = await fixture(), p = structuredClone(f.catalog.printings()[0]);
  await assert.rejects(low(f, [p]), /Printing has no independent approval/);
  assert.throws(() => assertPrintingApproval(p), /independent approval/);
  const approved = new Map([[p.printingId, canonicalPrinting(p)]]);
  await low(f, [p], approved);
  for (const mutate of [
    (p) => { p.number = '999/999'; }, (p) => { p.setCode = 'another-product'; },
    (p) => { p.regulationMark = 'J'; }, (p) => { p.printingId = 'printing:impersonation'; },
    (p) => { p.definitionBindings[0].definitionId = 'other'; },
    (p) => { p.definitionBindings[0].sourceOfTruth[0].locator = 'changed binding evidence'; },
    (p) => { p.metadataRefs.push({ provider: '52poke', id: 'changed-wiki-record' }); },
  ]) {
    const changed = structuredClone(p); mutate(changed);
    await assert.rejects(low(f, [changed], approved), /independent approval|changed since review/);
  }
  const general = structuredClone(p); general.definitionBindings[0].sourceOfTruth[0].kind = 'official-rule';
  assert.throws(() => assertPrintingBinding(general, f.catalog.definition('base'), RULESET), /card-specific evidence/);
  const pocket = { ...p, game: 'pocket' };
  await assert.rejects(low(f, [pocket], new Map([[pocket.printingId, canonicalPrinting(pocket)]])), /physical-TCG/);
});

test('candidate facts are detached review input only and cannot mint a release approval', async () => {
  const { f, data } = await bundle();
  assert(Object.isFrozen(data) === false);
  const facts = await catalogCandidateFacts({ ruleset: RULESET, definitions: f.definitions, printings: f.catalog.printings(), handlers: f.handlers });
  assert(Object.isFrozen(facts) && Object.isFrozen(facts.definitions));
  assert.equal(facts.kernelSha256, KERNEL_BUILD.kernelSha256); assert.equal(facts.schemaSha256, KERNEL_BUILD.schemaSha256);
  assert(!Object.hasOwn(facts, 'review')); assert(!Object.hasOwn(facts, 'trustedReleases'));
  await assert.rejects(loadReviewedCatalogRelease({ json: JSON.stringify(data), handlers: f.handlers }), code('unapproved-release'));
  assert.throws(() => catalogReleaseReceipt(f.catalog), code('unapproved-release-catalog'));
  await assert.rejects(catalogCandidateFacts({ ruleset: RULESET, definitions: [f.definitions[0], f.definitions[0]],
    printings: f.catalog.printings(), handlers: f.handlers }), code('duplicate-release-id'));
  await assert.rejects(catalogCandidateFacts({ ruleset: RULESET, definitions: f.definitions,
    printings: [data.printings[0], data.printings[0]], handlers: f.handlers }), code('duplicate-release-id'));
});

test('independently pinned manifests admit only exact data and produce an immutable, unforgeable-by-data release receipt', async () => {
  const { f, data } = await bundle(), catalog = await load(data, f.handlers), receipt = catalogReleaseReceipt(catalog);
  assert.equal(catalog.id, f.catalog.id); assert.equal(receipt.catalogId, catalog.id);
  assert.equal(receipt.sha256, await sha256(canonicalJSON(data.manifest))); assert.equal(receipt.releaseId, data.manifest.releaseId);
  assert(Object.isFrozen(receipt) && Object.isFrozen(receipt.review)); assert.throws(() => { receipt.review.reviewId = 'changed'; }, TypeError);
  data.definitions[0].mechanics.hp = 500; data.printings[0].number = 'changed';
  assert.equal(catalog.definition('base').mechanics.hp, 100); assert.notEqual(catalog.printing('printing:base').number, 'changed');
  assert.throws(() => catalogReleaseReceipt({ ...catalog, approval: receipt }), code('unapproved-release-catalog'));
});

test('property order and payload array order do not change normalized content; reviewed manifest bytes are still independently pinned', async () => {
  const { f, data } = await bundle(), a = await load(data, f.handlers);
  const reorder = (v) => Array.isArray(v) ? v.map(reorder) : v && typeof v === 'object' ?
    Object.fromEntries(Object.entries(v).reverse().map(([k, value]) => [k, reorder(value)])) : v;
  const other = reorder(data); other.definitions.reverse(); other.printings.reverse();
  const b = await load(other, new Map([...f.handlers].reverse()));
  assert.equal(a.id, b.id); assert.equal(catalogReleaseReceipt(a).sha256, catalogReleaseReceipt(b).sha256);
});

test('tampered data cannot become approved by recomputing its own manifest or setting a review flag', async () => {
  const { f, data } = await bundle();
  const pin = new Map([[data.manifest.releaseId, await sha256(canonicalJSON(data.manifest))]]);
  const changed = structuredClone(data); changed.definitions[0].mechanics.hp = 110;
  await assert.rejects(loadReviewedCatalogRelease({ json: JSON.stringify(changed), trustedReleases: pin, handlers: f.handlers }), code('release-content-mismatch'));
  const refreshed = await catalogCandidateFacts({ ruleset: RULESET, definitions: changed.definitions, printings: changed.printings, handlers: f.handlers });
  Object.assign(changed.manifest, refreshed); changed.manifest.review.reviewId = 'self-approved-new-digest';
  await assert.rejects(loadReviewedCatalogRelease({ json: JSON.stringify(changed), trustedReleases: pin, handlers: f.handlers }), code('unapproved-release'));
  const claimed = structuredClone(data); claimed.approvedPrintings = Object.fromEntries(claimed.printings.map((p) => [p.printingId, canonicalPrinting(p)]));
  await assert.rejects(load(claimed, f.handlers), code('invalid-release-shape'));
});

test('definition/printing set changes, swapped bindings and provenance changes fail exact set/content verification', async () => {
  const { f, data } = await bundle();
  for (const mutate of [
    (d) => { d.definitions.pop(); }, (d) => { d.printings.pop(); },
    (d) => { d.definitions[0].mechanics.attacks[0].printedDamage.value += 10; },
    (d) => { d.printings[0].number = 'wrong/number'; },
    (d) => { d.printings[0].definitionBindings[0].definitionId = 'other'; },
    (d) => { d.printings[0].metadataRefs.push({ provider: '52poke', id: 'unreviewed-revision', revision: 'new' }); },
  ]) {
    const changed = structuredClone(data); mutate(changed);
    await assert.rejects(load(changed, f.handlers), code('release-content-mismatch'));
  }
  for (const part of ['definitions', 'printings', 'handlers']) {
    const changed = structuredClone(data); changed.manifest[part].push(structuredClone(changed.manifest[part][0]));
    await assert.rejects(load(changed, f.handlers), code('duplicate-release-id'));
  }
});

test('an approval for another engine, schema, rules snapshot, language or incomplete implementation cannot override admission rules', async () => {
  const { f, data } = await bundle();
  for (const field of ['kernelSha256', 'schemaSha256', 'rulesSha256']) {
    const changed = structuredClone(data); changed.manifest[field] = '0'.repeat(64);
    await assert.rejects(load(changed, f.handlers), code(field === 'rulesSha256' ? 'incompatible-release-rules' : 'incompatible-release-build'));
  }
  const future = structuredClone(data); future.manifest.ruleset.version = 'V20270101';
  await assert.rejects(load(future, f.handlers), /Unsupported ruleset/);
  const partial = structuredClone(data); partial.definitions[0].implementation.status = 'partial';
  Object.assign(partial.manifest, await catalogCandidateFacts({ ruleset: RULESET, ...partial, handlers: f.handlers }));
  await assert.rejects(load(partial, f.handlers), /partial cards/);
  const foreign = structuredClone(data); foreign.printings[0].language = 'zh-Hant';
  Object.assign(foreign.manifest, await catalogCandidateFacts({ ruleset: RULESET, ...foreign, handlers: f.handlers }));
  await assert.rejects(load(foreign, f.handlers), /simplified-Chinese printing/);
});

test('installed registry set, version, validation schema, evidence, and function-body drift are all content-bound', async () => {
  const { f, data } = await bundle();
  for (const mutate of [
    (m) => { m.delete('cn.draw@1'); },
    (m) => { m.set('fixture:extra', { ...m.get('cn.draw@1'), implementationVersion: 'fixture' }); },
    (m) => { m.set('cn.draw@1', { ...m.get('cn.draw@1'), implementationVersion: '2' }); },
    (m) => { m.set('cn.draw@1', { ...m.get('cn.draw@1'), parameterSchemaRef: 'urn:other' }); },
    (m) => { m.set('cn.draw@1', { ...m.get('cn.draw@1'), sourceOfTruth: EVIDENCE }); },
    (m) => { m.set('cn.draw@1', { ...m.get('cn.draw@1'), execute: () => [{ op: 'draw', count: 999 }] }); },
    (m) => { m.set('cn.damageValue@1', { ...m.get('cn.damageValue@1'), damageRollVersion: '2' }); },
    (m) => { m.set('cn.damageValue@1', { ...m.get('cn.damageValue@1'), damageRolls: () => [] }); },
  ]) {
    const registry = new Map(f.handlers); mutate(registry);
    await assert.rejects(load(data, registry), code('release-content-mismatch'));
  }
  for (const change of [
    { implementationVersion: '' }, { parameterSchemaRef: '' }, { execute: null }, { validateParameters: null },
  ]) {
    const registry = new Map(f.handlers); registry.set('cn.draw@1', { ...registry.get('cn.draw@1'), ...change });
    await assert.rejects(load(data, registry), code('unversioned-release-handler'));
  }
  const configured = new Map(f.handlers); configured.set('cn.draw@1', { ...configured.get('cn.draw@1'), hiddenConfiguration: 50 });
  await assert.rejects(load(data, configured), code('unknown-release-handler-metadata'));
  await assert.rejects(load(data, {}), code('invalid-handler-registry'));
});

test('JSON ingestion has no code loader, enforces host byte limits, and rejects malformed/extra fields before admission', async () => {
  const { f, data } = await bundle(), json = JSON.stringify(data);
  for (const options of [{ json: data }, { json, maximumBytes: 0 }, { json, maximumBytes: Infinity },
    { json, maximumBytes: json.length }, { json: undefined }])
    await assert.rejects(loadReviewedCatalogRelease({ handlers: f.handlers, ...options }), code('invalid-release-input'));
  await assert.rejects(loadReviewedCatalogRelease({ json, trustedReleases: {}, handlers: f.handlers }), code('invalid-release-trust'));
  await assert.rejects(loadReviewedCatalogRelease({ json: '{bad json', handlers: f.handlers }), code('invalid-release-json'));
  for (const input of [null, [], { manifest: data.manifest }, { ...data, scripts: ['https://untrusted.example/execute.js'] }])
    await assert.rejects(loadReviewedCatalogRelease({ json: JSON.stringify(input), handlers: f.handlers }), code('invalid-release-shape'));
  const wrongPin = new Map([[data.manifest.releaseId, 'f'.repeat(64)]]);
  await assert.rejects(loadReviewedCatalogRelease({ json, trustedReleases: wrongPin, handlers: f.handlers }), code('unapproved-release'));
  const changed = structuredClone(data); changed.manifest.review.reviewerId = 'different-reviewer';
  await assert.rejects(loadReviewedCatalogRelease({ json: JSON.stringify(changed), trustedReleases:
    new Map([[data.manifest.releaseId, await sha256(canonicalJSON(data.manifest))]]), handlers: f.handlers }), code('unapproved-release'));
});

test('non-JSON handler configuration cannot be normalized into an accidentally approved null/empty hash value', async () => {
  const { f, data } = await bundle(), cycle = {}; cycle.self = cycle;
  const symbolic = { [Symbol('hidden')]: 1 }, hidden = Object.defineProperty({}, 'hidden', { value: 1 });
  const getter = Object.defineProperty({}, 'get', { enumerable: true, get: () => 1 });
  for (const usage of [new Date('2026-10-20'), { count: NaN }, { limit: Infinity }, { missing: undefined }, cycle,
    { function: () => 1 }, symbolic, hidden, getter, Array(1)]) {
    const registry = new Map(f.handlers); registry.set('cn.draw@1', { ...registry.get('cn.draw@1'), usage });
    await assert.rejects(load(data, registry), code('invalid-handler-contract'));
  }
  const empty = new Map(f.handlers); empty.set('cn.draw@1', null);
  await assert.rejects(load(data, empty), code('unversioned-release-handler'));
});

test('release verification detaches untrusted input, trust-root Map and installed registry before async hashing', async () => {
  const { f, data } = await bundle(), manifestDigest = await sha256(canonicalJSON(data.manifest));
  const roots = new Map([[data.manifest.releaseId, manifestDigest]]), registry = new Map(f.handlers);
  const promise = loadReviewedCatalogRelease({ json: JSON.stringify(data), trustedReleases: roots, handlers: registry });
  roots.clear(); registry.clear(); data.manifest.review.reviewId = 'changed'; data.definitions[0].mechanics.hp = 900;
  const catalog = await promise;
  assert.equal(catalog.definition('base').mechanics.hp, 100);
  assert.notEqual(catalogReleaseReceipt(catalog).review.reviewId, 'changed');
});

test('review-bound creation/restoration validates release authority and kernel-bound catalog identity, not downloaded flags', async () => {
  const f = await fixture(), printings = f.catalog.printings().map((p) => ({
    ...structuredClone(p), series: 'scarlet-violet', releasedOn: '2026-09-16',
  }));
  f.catalog = await low(f, printings, new Map(printings.map((p) => [p.printingId, canonicalPrinting(p)])));
  const { data } = await bundle(f), json = JSON.stringify(data), format = { ...RULESET, id: 'standard' };
  const trustedReleases = new Map([[data.manifest.releaseId, await sha256(canonicalJSON(data.manifest))]]);
  const opened = await createReviewedGame({ json, trustedReleases, handlers: f.handlers, decks: [f.deck, f.deck], seed: f.seed, format });
  assert(Object.isFrozen(opened)); settle(opened.game);
  command(opened.game, { type: 'endTurn' }); settle(opened.game);
  const snapshot = opened.game.snapshot(), restored = await restoreReviewedGame({ json, trustedReleases, handlers: f.handlers, snapshot });
  assert.deepEqual(restored.game.view(0), opened.game.view(0));
  assert.equal(opened.approval.kernelSha256, KERNEL_BUILD.kernelSha256);
  await assert.rejects(createReviewedGame({ json, handlers: f.handlers, decks: [f.deck, f.deck], seed: f.seed }), code('unapproved-release'));
  const stale = structuredClone(snapshot); stale.catalogId = '0'.repeat(64);
  await assert.rejects(restoreReviewedGame({ json, trustedReleases, handlers: f.handlers, snapshot: stale }), /catalog or rules version/);
});

test('build stamp is deterministic, includes code/schema/approval boundary, and the offline --check does not regenerate it', async () => {
  const target = new URL('public/rules/kernel-build.js', root), before = await readFile(target, 'utf8');
  const result = await exec(process.execPath, ['scripts/build-rules-kernel.mjs', '--check'], { cwd: root });
  assert.match(result.stdout, /build stamp matches/); assert.equal(await readFile(target, 'utf8'), before);
  const paths = KERNEL_BUILD.files.map((r) => r.path);
  assert(paths.includes('public/rules/game.js') && paths.includes('public/rules/catalog-release.js') && paths.includes('public/rules/schema-validators.js'));
  assert(!paths.includes('public/rules/kernel-build.js'));
  assert.deepEqual(paths, [...paths].sort());
});
