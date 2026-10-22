// Actual committed v2 files through the browser/Node host adapters. No external
// network, NAS, paid model results or real tournament lists are synthesized.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCNRelease, responseBytes } from '../public/cn-release.js';
import { loadRelease, ROOT } from '../server/catalog.mjs';
import { loadLibrary } from '../server/library.mjs';
import { loadPool } from '../public/library.js';
import { indexedDeckHints, checkIndexedDeck } from '../public/deck-check.js';
import { implementationSummaryFromIndex, implementationSummary } from '../public/card-quality.js';
import { catalogReleaseReceipt } from '../public/rules/catalog-release.js';
import { releaseIdentity } from '../public/release-identity.js';
import { newGame, replayMatch } from '../public/replay.js';
import { createReviewedGame } from '../public/rules/reviewed-game.js';

const publicRoot = new URL('../public/', import.meta.url);
const meta = JSON.parse(await readFile(new URL('data/cn/V20261019/decks.json', publicRoot), 'utf8'));
const preset = meta.decks[0], cards = preset.cards;
const nodeRelease = await loadRelease(), index = await nodeRelease.index();
function transport(change = async (bytes) => bytes) {
  const reads = [];
  return { reads, fetcher: async (url, options) => {
    reads.push({ url, options });
    const bytes = await readFile(new URL(url, publicRoot));
    return new Response(await change(bytes, url), { headers: { 'Content-Type': 'application/json' } });
  } };
}

test('response transport is bounded while streaming, preserves exact bytes and rejects HTTP/missing bodies', async () => {
  assert.deepEqual(await responseBytes(new Response(new Uint8Array([1, 2, 255])), 3), new Uint8Array([1, 2, 255]));
  assert.equal((await responseBytes(new Response(''), 1)).length, 0);
  await assert.rejects(responseBytes(new Response('', { status: 404 }), 10), /HTTP 404/);
  await assert.rejects(responseBytes(new Response(null), 10), /no readable body/);
  let canceled = false;
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(5)); c.enqueue(new Uint8Array(6)); }, cancel() { canceled = true; } });
  await assert.rejects(responseBytes(new Response(stream), 10), /byte budget/);
  assert.equal(canceled, true);
});

test('browser startup reads only manifest/index; concurrent game subsets share only their needed shard downloads', async () => {
  const t = transport(), release = await openCNRelease(t);
  assert.deepEqual(t.reads.map((r) => r.url), ['data/cn/V20261019/manifest.json']);
  assert.equal(t.reads[0].options.cache, 'no-cache');
  const [a, b] = await Promise.all([release.index(), release.index()]);
  assert.equal(a, b);
  assert.equal(t.reads.length, 2);
  const ids = cards.map(([id]) => id), [x, y] = await Promise.all([release.catalogFor(ids), release.catalogFor([...ids].reverse())]);
  assert.equal(x.id, y.id);
  assert.equal(t.reads.length, 2 + catalogReleaseReceipt(x).shards.length);
  assert.ok(t.reads.filter((r) => /\/shards\//.test(r.url)).length < 20);
  assert.ok(t.reads.every((r) => r.options.credentials === 'same-origin'));
  assert.ok(!t.reads.some((r) => r.url.endsWith('release.json')));
});

test('download failures, excessive bytes, bad UTF-8 and tampered trusted data never produce a usable catalog', async () => {
  await assert.rejects(openCNRelease({ fetcher: async () => new Response(null, { status: 503 }) }), /HTTP 503/);
  await assert.rejects(openCNRelease({ fetcher: async () => new Response('x'.repeat(1024 * 1024 + 1)) }), /byte budget/);
  await assert.rejects(openCNRelease({ fetcher: async () => new Response(new Uint8Array([255])) }), /encoded data|encoding/i);
  const unpinned = transport(async (bytes, url) => {
    if (!url.endsWith('manifest.json')) return bytes;
    const data = JSON.parse(bytes.toString()); data.releaseId += '-unapproved';
    return JSON.stringify(data);
  });
  await assert.rejects(openCNRelease(unpinned), /independently installed approval/);
  const tampered = transport(async (bytes, url) => {
    if (!url.includes('/shards/')) return bytes;
    const copy = new Uint8Array(bytes); copy[copy.length - 1] ^= 1; return copy;
  });
  await assert.rejects((await openCNRelease(tampered)).catalogFor(cards.map(([id]) => id)), /SHA-256/);
});

test('the Node host reader enforces manifest budgets and explicit tier policy without full-pool startup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cn-release-budget-'));
  try {
    await writeFile(join(dir, 'manifest.json'), 'x'.repeat(1024 * 1024 + 1));
    await assert.rejects(loadRelease({ directory: dir }), /byte budget/);
    await writeFile(join(dir, 'manifest.json'), new Uint8Array([255]));
    await assert.rejects(loadRelease({ directory: dir }), /encoded data|encoding/i);
  } finally { await rm(dir, { recursive: true }); }
  const reviewed = await loadRelease({ tiers: ['reviewed'] });
  await assert.rejects(reviewed.catalogFor(['zh-Hans:151C:013/151']), /does not admit machine/);
  assert.equal((await reviewed.index()).entries.length, index.entries.length);
});

test('browsing uses signed index facts and quality, retaining library art metadata without loading any shard', async () => {
  const raw = await loadLibrary({ index, presentation: meta.cards, dir: join(ROOT, 'tests/fixtures/card-library') });
  const stale = structuredClone(raw.cards), pikachu = stale.find((c) => c.id === 'zh-Hans:CSVH1C:008/059');
  Object.assign(pikachu, { name: 'not the checked name', hp: 9999, types: ['Fire'], attacks: [], implementation: 'machine' });
  const t = transport(), original = globalThis.fetch;
  globalThis.fetch = (url, options) => url === '/api/library' ? Promise.resolve(Response.json({ cards: stale })) : t.fetcher(url, options);
  try {
    const pool = await loadPool(), card = pool.byId.get(pikachu.id);
    assert.equal(card.hp, 190); assert.equal(card.name, '皮卡丘ex');
    assert.deepEqual(card.types, ['Lightning']);
    assert.equal(card.implementation, 'reviewed');
    assert.equal(card.image, pikachu.image);
    assert.ok(card.attacks.some((a) => a.name === '强劲伏特'));
    assert.equal(pool.catalog, undefined);
    assert.ok(!t.reads.some((r) => r.url.includes('/shards/')));
    assert.equal(pool.cards.filter((c) => c.implemented).length, index.entries.length);
  } finally { globalThis.fetch = original; }
});

test('index hints do no I/O; final deck checks require a branded release and actual executable subset', async () => {
  const t = transport(), release = await openCNRelease(t), idx = await release.index();
  assert.equal(indexedDeckHints(idx, cards, preset.format.id).legal, true);
  assert.equal(t.reads.length, 2);
  assert.equal((await checkIndexedDeck(release, idx, [], 'open')).legal, false);
  assert.equal(t.reads.length, 2);
  const valid = await checkIndexedDeck(release, idx, cards, preset.format.id);
  assert.deepEqual(valid, { count: 60, issues: [], legal: true });
  assert.ok(t.reads.some((r) => r.url.includes('/shards/')));
  const fake = await checkIndexedDeck({ catalogFor: release.catalogFor }, idx, cards, preset.format.id);
  assert.equal(fake.legal, false);
  assert.match(fake.issues[0], /pinned v2 release session/);
});

test('forged index hints cannot bypass same-name limits or official format checks; input is detached before async admission', async () => {
  const idx = structuredClone(index), id = 'zh-Hans:CSVH1C:008/059';
  idx.entries.find((e) => e.printingId === id).card.deckLimits.sameName = null;
  const over = [[id, 5], ['zh-Hans:CSVE1C:LIG', 55]];
  assert.equal(indexedDeckHints(idx, over, 'open').legal, true);
  const checked = await checkIndexedDeck(nodeRelease, idx, over, 'open');
  assert.equal(checked.legal, false); assert.match(checked.issues[0], /Too many copies/);
  const input = structuredClone(cards), pending = checkIndexedDeck(nodeRelease, index, input, preset.format.id);
  input[0][1] = 60;
  assert.equal((await pending).legal, true);
  assert.deepEqual((await checkIndexedDeck(nodeRelease, index, [], 'expanded')).issues, ['未知的赛制。']);
  const broken = transport(async (bytes, url) => url.includes('/shards/') ? new Uint8Array(bytes.length + 1) : bytes);
  const failed = await checkIndexedDeck(await openCNRelease(broken), index, cards, preset.format.id);
  assert.equal(failed.legal, false); assert.match(failed.issues[0], /byte budget/);
});

test('indexed record quality matches executable definitions and never promotes machine reprints', async () => {
  const ids = ['zh-Hans:151C:013/151', 'zh-Hans:CSVH1C:008/059', 'missing'];
  const catalog = await nodeRelease.catalogFor(ids.slice(0, 2));
  assert.deepEqual(implementationSummaryFromIndex(index, ids), implementationSummary(catalog, ids));
  assert.deepEqual(implementationSummaryFromIndex(index, []), { tiers: [], machinePrintings: [], unimplementedPrintings: [] });
});

test('compact saved identity is detached from full provenance and replay rejects missing/foreign/mismatched approvals', async () => {
  const deck = cards.flatMap(([id, n]) => Array(n).fill(id));
  const created = await createReviewedGame({ release: nodeRelease, decks: [deck, deck], seed: [1, 2, 3, 4],
    format: preset.format, matchMode: 'normal' });
  const identity = releaseIdentity(created.approval);
  assert.equal('reviews' in identity, false);
  assert.ok(JSON.stringify(identity).length < 10_000);
  const setup = { releaseId: nodeRelease.releaseId, approval: identity, decks: [0, 1].map((i) => ({
    id: `fixture:${i}`, name: 'mechanism fixture', cards: deck,
  })), seed: [1, 2, 3, 4], format: preset.format, matchMode: 'normal' };
  const replay = await replayMatch({ release: nodeRelease, setup, steps: [] });
  assert.equal(replay.catalog.id, created.catalog.id);
  assert.deepEqual(replay.compatibility, { manifestChanged: false });
  await assert.rejects(async () => newGame({ release: nodeRelease, setup: { ...setup, releaseId: 'old-v1' } }), /original build/);
  await assert.rejects(async () => newGame({ release: nodeRelease, setup: { ...setup, approval: null } }), /no approved subset/);
  await assert.rejects(newGame({ release: nodeRelease, setup: { ...setup, approval: { ...identity, catalogId: 'f'.repeat(64) } } }),
    /Recorded catalogId differs/);
  const moved = await newGame({ release: nodeRelease, setup: { ...setup, approval: { ...identity, manifestSha256: 'f'.repeat(64) } } });
  assert.deepEqual(moved.compatibility, { manifestChanged: true });
  identity.shards[0].sha256 = 'changed';
  assert.notEqual(created.approval.shards[0].sha256, 'changed');
});
