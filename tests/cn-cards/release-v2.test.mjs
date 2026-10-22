// Real committed authoring pool and the active v2 shards, independent of NAS/cache data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCNReleaseV2 } from '../../scripts/cn-release-v2.mjs';
import { buildReleaseV2 } from '../../scripts/release-v2.mjs';
import { openReviewedRelease, catalogReleaseReceipt } from '../../public/rules/catalog-release.js';
import { createReviewedGame, restoreReviewedGame } from '../../public/rules/reviewed-game.js';
import { OfficialGame } from '../../public/rules/game.js';
import { canonicalJSON, sha256 } from '../../public/rules/catalog.js';
import { canonicalDefinition, canonicalPrinting } from '../../public/rules/card-schema.js';
import { validateFormatDeck } from '../../public/rules/formats.js';
import { loadCatalog } from '../../server/catalog.mjs';
import { createAI } from '../../public/cn/ai.js';
import * as reviewed from '../../catalog/zh-CN/V20261019/index.mjs';
import * as released from '../../catalog/zh-CN/V20261019/release-pool.mjs';

const built = await buildCNReleaseV2();
const trust = new Map([[built.manifest.releaseId, await sha256(canonicalJSON(built.manifest))]]);
const open = (options = {}) => openReviewedRelease({ manifestJson: built.manifestJson, trustedReleases: trust,
  readShard: async (d) => built.files.get(d.file), ...options });

test('the real mixed pool roundtrips through self-contained v2 shards without changing any approved card or provenance', async () => {
  const release = await open(), index = await release.index();
  const catalog = await release.catalogFor(index.entries.map((e) => e.printingId));
  const active = await loadCatalog();
  assert.equal(catalog.id, built.catalog.id);
  assert.equal(catalog.id, active.id);
  assert.equal(index.entries.length, released.PRINTINGS.length);
  assert.equal(built.manifest.shards.length, new Set(released.PRINTINGS.map((p) => p.setCode)).size);
  assert.equal(index.entries.filter((e) => e.tier === 'reviewed').length, reviewed.PRINTINGS.length);
  assert.equal(index.entries.filter((e) => e.tier === 'machine').length, released.MACHINE_REPORT.printings);
  for (const d of reviewed.DEFINITIONS) assert.equal(canonicalDefinition(catalog.definition(d.definitionId)), canonicalDefinition(d));
  for (const p of reviewed.PRINTINGS) assert.equal(canonicalPrinting(catalog.printing(p.printingId)), canonicalPrinting(p));
  for (const s of built.manifest.shards) assert.ok(s.bytes <= 4 * 1024 * 1024);
  assert.ok(built.manifest.index.bytes <= 8 * 1024 * 1024);
  assert.ok(Buffer.byteLength(built.manifestJson) <= 1024 * 1024);
});

test('real shard/index outputs are byte-deterministic regardless of authoring record order', async () => {
  const again = await buildReleaseV2({ releaseId: built.manifest.releaseId, ruleset: reviewed.RULESET,
    definitions: [...released.DEFINITIONS].reverse(), printings: [...released.PRINTINGS].reverse(), reviews: built.manifest.reviews });
  assert.equal(again.manifestJson, built.manifestJson);
  assert.deepEqual([...again.files.keys()], [...built.files.keys()]);
  for (const [file, bytes] of built.files) assert.deepEqual(again.files.get(file), bytes, file);
});

test('all three real reviewed deck lists use small v2 subsets, preserve game behavior and restore from their physical card IDs', async () => {
  const active = await loadCatalog();
  for (const deck of Object.values(reviewed.DECKS)) {
    const reads = [], release = await open({ tiers: ['reviewed'], readShard: async (d) => { reads.push(d.file); return built.files.get(d.file); } });
    const list = reviewed.deckList(deck.id), setup = { decks: [list, list], seed: [3, 1, 4, 1], format: deck.format, matchMode: 'normal' };
    const created = await createReviewedGame({ release, ...setup });
    const whole = { game: new OfficialGame({ ...setup, ruleset: reviewed.RULESET, catalog: active }) };
    const subset = created.catalog, receipt = catalogReleaseReceipt(subset);
    validateFormatDeck(subset, list, deck.format);
    assert.deepEqual(receipt.tiers, ['reviewed']);
    assert.ok(subset.printings().length >= new Set(list).size);
    assert.ok(subset.printings().length < active.printings().length / 10);
    assert.ok(receipt.shards.length < built.manifest.shards.length / 5);
    assert.equal(reads.length, receipt.shards.length + 1, 'one index plus exactly the needed shards');
    const shardBytes = reads.filter((file) => file.startsWith('shards/')).reduce((n, file) => n + built.files.get(file).length, 0);
    assert.ok(shardBytes < 2 * 1024 * 1024, `${deck.id} shards fit the per-game budget; the shared index has its own 8 MiB budget`);
    const ai = createAI(subset);
    const normalize = (snapshot) => ({ ...snapshot, catalogId: 'TEST-IGNORE-ONLY-SUBSET-VS-FULL-IDENTITY' });
    assert.deepEqual(normalize(created.game.snapshot()), normalize(whole.game.snapshot()), deck.id);
    for (let step = 0; step < 20 && !created.game.snapshot().result; step++) {
      const s = created.game.snapshot(), player = s.pending ? s.pending.player : s.current;
      const action = ai(created.game.view(player), player);
      const cmd = { player, expectedRevision: s.revision, action };
      created.game.dispatch(cmd); whole.game.dispatch(cmd);
      assert.deepEqual(normalize(created.game.snapshot()), normalize(whole.game.snapshot()), `${deck.id} step ${step}`);
    }
    const restored = await restoreReviewedGame({ release: await open({ tiers: ['reviewed'] }), snapshot: created.game.snapshot(), expectedApproval: receipt });
    assert.deepEqual(restored.game.snapshot(), created.game.snapshot());
    assert.equal(restored.approval.catalogId, receipt.catalogId);
  }
});

test('the real machine reprint remains machine-tier even though its bound definition is reviewed', async () => {
  const entry = (await (await open()).index()).entries.find((e) => e.tier === 'machine' &&
    reviewed.DEFINITIONS.some((d) => d.definitionId === e.definitionId));
  assert.ok(entry);
  await assert.rejects((await open({ tiers: ['reviewed'] })).catalogFor([entry.printingId]), /does not admit machine/);
  const catalog = await (await open()).catalogFor([entry.printingId]);
  assert.notEqual(catalog.definitionFor(entry.printingId).implementation.tier, 'machine');
  assert.deepEqual(catalogReleaseReceipt(catalog).tiers, ['machine']);
});
