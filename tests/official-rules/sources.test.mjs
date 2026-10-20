import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkRuleSources, sourceCachePath, verifySourceBytes } from '../../scripts/check-rules-sources.mjs';
import { CN_V20261019 } from '../../public/rules/index.js';
import { createRuleset } from '../../public/rules/registry.js';

const bytes = Buffer.from('%PDF-1.6\nSYNTHETIC fixture, NOT an official document.\n');
const document = () => ({
  id: 'fixture-source', url: 'https://image.pokemon.com.cn/fixture-not-a-real-document.pdf',
  evidence: { binaryVerification: 'verified' }, byteLength: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
});

test('official PDF receipts are pinned to actual downloaded byte counts and fingerprints, not empty proof declarations', () => {
  const pinned = CN_V20261019.documents.filter((d) => d.evidence.binaryVerification === 'verified' && !d.mediaType);
  assert.deepEqual(pinned.map((d) => [d.id, d.byteLength, d.pages]), [
    ['CN-advanced-3.1.0', 910379, 76], ['CN-tournament-3.1.0', 334035, 22],
  ]);
  for (const d of pinned) {
    assert.equal(new URL(d.url).hostname, 'image.pokemon.com.cn');
    assert.equal(new URL(d.entryUrl).hostname, 'www.pokemon.cn');
    assert.match(d.sha256, /^[a-f0-9]{64}$/);
  }
  for (const mutate of [
    (d) => { d.sha256 = null; }, (d) => { delete d.byteLength; }, (d) => { d.byteLength = -1; },
  ]) {
    const data = structuredClone(CN_V20261019); data.rules = Object.values(data.rules);
    mutate(data.documents.find((d) => d.evidence.binaryVerification === 'verified'));
    assert.throws(() => createRuleset(data), /Verified document needs/);
  }
});

test('advanced stable-URL proof records the complete 2026-10-20 byte-equivalent download without moving the snapshot or primary pin', () => {
  const advanced = CN_V20261019.documents.find((d) => d.id === 'CN-advanced-3.1.0');
  const proof = advanced.evidence.stableUrlVerification;
  assert.deepEqual(proof, {
    retrievedOn: '2026-10-20',
    url: 'https://www.pokemon.cn/tcg/pdf/basic_rules08.pdf',
    finalUrl: 'https://image.pokemon.com.cn/wp-content/uploads/2025/12/20251204153741105.pdf',
    byteLength: 910379,
    pages: 76,
    sha256: '27bda43d8cb78ed800891c6793e5efd945ac64d94a83ceff8adaed10e8f67419',
    equivalent: true,
  });
  assert.equal(proof.url, advanced.historicalStableUrl);
  assert.equal(proof.finalUrl, advanced.url);
  assert.equal(proof.byteLength, advanced.byteLength);
  assert.equal(proof.pages, advanced.pages);
  assert.equal(proof.sha256, advanced.sha256);
  assert.equal(advanced.version, '3.1.0');
  assert.equal(advanced.entryUpdatedOn, '2025-03-21');
  assert.equal(advanced.evidence.retrievedOn, '2026-10-19');
  assert.doesNotMatch(advanced.evidence.note, /remains unverified/i);
  assert.match(advanced.evidence.note, /2026-10-20/);
  assert(Object.isFrozen(proof));
  assert.equal(CN_V20261019.id, 'CN/V20261019');
  assert.equal(CN_V20261019.reviewedOn, '2026-10-19');
});

test('tournament stable URL still yields 3.0.0, recorded only as non-equivalent evidence and never admitted as the 3.1.0 primary source', () => {
  const tournament = CN_V20261019.documents.find((d) => d.id === 'CN-tournament-3.1.0');
  const proof = tournament.evidence.stableUrlVerification;
  assert.deepEqual(proof, {
    retrievedOn: '2026-10-20',
    url: 'https://www.pokemon.cn/tcg/pdf/basic_rules09.pdf',
    finalUrl: 'https://image.pokemon.com.cn/wp-content/uploads/2025/11/20251121172108283.pdf',
    byteLength: 389144,
    pages: 21,
    sha256: 'bff14750195fe0a1d3d0cc91135ee0241a0430dd1e17c602f79b1f9a0c62cd69',
    equivalent: false,
    version: '3.0.0',
    updatedOn: '2024-07-08',
  });
  assert.deepEqual([tournament.version, tournament.entryUpdatedOn, tournament.evidence.retrievedOn],
    ['3.1.0', '2026-04-02', '2026-10-19']);
  assert.equal(tournament.url, 'https://image.pokemon.com.cn/wp-content/uploads/2026/04/e3491fcdf7a6b5e486f770772cbcfa82.pdf');
  assert.equal(tournament.byteLength, 334035);
  assert.equal(tournament.pages, 22);
  assert.equal(tournament.sha256, 'b5f0c8b87d928f5ca640f1f021863eb78aafcc8216067883e7b2075a25ab1ac6');
  for (const key of ['url', 'byteLength', 'pages', 'sha256', 'version']) assert.notEqual(proof[key], tournament[key]);
  assert(Object.isFrozen(proof));
  assert(!CN_V20261019.documents.some((d) => d.url === proof.url || d.url === proof.finalUrl ||
    d.id === 'CN-tournament-3.0.0'));
  assert.deepEqual(CN_V20261019.documents.filter((d) => d.evidence.binaryVerification === 'verified').map((d) => d.id), [
    'CN-formats-20260916', 'CN-standard-adjustment-20240519', 'CN-formats-extra',
    'CN-basic-conditions', 'CN-basic-guide', 'CN-advanced-3.1.0', 'CN-basic-play', 'CN-tournament-3.1.0',
  ], 'Only the two reviewed PDFs and six reviewed HTML captures are primary sources; the old 09 comparison adds none.');
  assert.equal(CN_V20261019.documents.length, 8);
  assert.equal(CN_V20261019.id, 'CN/V20261019');
  assert.equal(CN_V20261019.reviewedOn, '2026-10-19');
});

test('reviewed HTML is pinned to original bytes, media and retrieval date; dynamic changes cannot silently update the snapshot', () => {
  const html = Buffer.from('<!DOCTYPE html>\n<p>SYNTHETIC official-page fixture</p>');
  const d = { ...document(), mediaType: 'text/html', byteLength: html.length,
    sha256: createHash('sha256').update(html).digest('hex') };
  assert.equal(verifySourceBytes(d, html).byteLength, html.length);
  assert.match(sourceCachePath(d), /\.html$/);
  assert.throws(() => verifySourceBytes({ ...d, mediaType: 'application/pdf' }, html), /do not match/);
  assert.throws(() => verifySourceBytes({ ...d, mediaType: 'application/octet-stream' }, html), /Unsupported source media/);
  assert.throws(() => sourceCachePath({ ...d, mediaType: 'image/png' }), /Unsupported source media/);
  const changed = Buffer.from('<!DOCTYPE html>\n<p>changed dynamic template</p>');
  assert.throws(() => verifySourceBytes(d, changed), /do not match/);
  const pinned = CN_V20261019.documents.filter((d) => d.mediaType === 'text/html');
  assert.equal(pinned.length, 6);
  assert.deepEqual(pinned.map((d) => [d.id, d.byteLength]), [
    ['CN-formats-20260916', 38888], ['CN-standard-adjustment-20240519', 44039], ['CN-formats-extra', 46920],
    ['CN-basic-conditions', 48463], ['CN-basic-guide', 76924], ['CN-basic-play', 47096],
  ]);
  assert(pinned.every((d) => d.evidence.retrievedOn === '2026-10-20' && d.evidence.binaryVerification === 'verified'));
});

test('basic-page receipts freeze the exact approved current captures, without backdating or promising byte-stable URLs', () => {
  const expected = [
    ['CN-basic-conditions', 'https://www.pokemon.cn/tcg-rules-howtoplay?pageName=basic_rules07%2F', 48463,
      '4c2344ddf107efc11aeed5e70f1f5a6caa2ea986b21e2d231e2ad2c2a36f3576'],
    ['CN-basic-guide', 'https://www.pokemon.cn/tcg-about', 76924,
      'cdca11d0c4be931eb3e934570a738c1c60990ad3b8354666a39bd2ca0d46ceb8'],
    ['CN-basic-play', 'https://www.pokemon.cn/tcg-rules-howtoplay?pageName=basic_rules05%2F', 47096,
      '05b87095fbeda5616cfd7be3a66de8afcaac331c1b5158e5f29a06078927d600'],
  ];
  for (const [id, url, byteLength, sha256] of expected) {
    const d = CN_V20261019.documents.find((entry) => entry.id === id);
    assert.deepEqual({
      id: d.id, url: d.url, byteLength: d.byteLength, sha256: d.sha256,
      mediaType: d.mediaType, version: d.version,
      method: d.evidence.method, retrievedOn: d.evidence.retrievedOn,
      binaryVerification: d.evidence.binaryVerification,
    }, {
      id, url, byteLength, sha256, mediaType: 'text/html', version: null,
      method: 'official-html-download-and-local-article-review', retrievedOn: '2026-10-20',
      binaryVerification: 'verified',
    });
    assert(sourceCachePath(d).endsWith(`${encodeURIComponent(id)}-${sha256}.html`));
    assert.match(d.evidence.note, /no historical byte-equivalence proof for the October 19 snapshot/);
    assert.match(d.evidence.note, /auth_key tokens may change bytes/);
    assert.match(d.evidence.note, /does not claim an unchanging URL/);
    assert(Object.isFrozen(d));
    assert(Object.isFrozen(d.evidence));
    assert.throws(() => { d.sha256 = null; }, TypeError);
    assert.throws(() => { d.evidence.retrievedOn = '2026-10-19'; }, TypeError);
  }
  const conditions = CN_V20261019.documents.find((d) => d.id === 'CN-basic-conditions');
  const play = CN_V20261019.documents.find((d) => d.id === 'CN-basic-play');
  assert.equal(new URL(conditions.url).searchParams.get('pageName'), 'basic_rules07/');
  assert.equal(new URL(play.url).searchParams.get('pageName'), 'basic_rules05/');
  assert.equal(new URL(conditions.url).pathname, new URL(play.url).pathname);
  assert.notEqual(conditions.url, play.url);
  assert.notEqual(conditions.sha256, play.sha256);
  for (const d of [conditions, play]) {
    assert.match(d.evidence.note, /Keep pageName=basic_rules0[57]%2F/);
    assert.match(d.evidence.note, /query-free canonical.*is not the source identity/);
  }
  assert.equal(CN_V20261019.reviewedOn, '2026-10-19');
  assert.equal(CN_V20261019.id, 'CN/V20261019');
});

test('basic-page evidence stays within visible clauses, retaining precise frozen locators and separate advanced authority', () => {
  const conditions = CN_V20261019.documents.find((d) => d.id === 'CN-basic-conditions');
  const guide = CN_V20261019.documents.find((d) => d.id === 'CN-basic-guide');
  const play = CN_V20261019.documents.find((d) => d.id === 'CN-basic-play');
  assert.match(conditions.evidence.note,
    /devolution, replacement Poison and maximum Burn quantities still require the cited advanced clauses/);
  assert.match(guide.evidence.note, /card-specific quantity limits still require their separate sources/);
  assert.match(guide.evidence.note, /does not claim an unchanging URL or approve any card/);
  assert.match(play.evidence.note, /not a separate rule for resolving insufficient-deck draw effects/);
  const expected = {
    'status.exclusive': [{ documentId: 'CN-basic-conditions', section: '睡眠；麻痹；混乱' }],
    'status.clear': [
      { documentId: 'CN-basic-conditions', section: '如何恢复特殊状态' },
      { documentId: 'CN-advanced-3.1.0', section: 'II.C-13', pdfPages: [35] },
    ],
    'status.poison': [
      { documentId: 'CN-basic-conditions', section: '中毒' },
      { documentId: 'CN-advanced-3.1.0', section: 'II.E-16', pdfPages: [61] },
    ],
    'status.burn': [
      { documentId: 'CN-basic-conditions', section: '灼伤' },
      { documentId: 'CN-advanced-3.1.0', section: 'II.E-28', pdfPages: [68] },
    ],
  };
  for (const [id, references] of Object.entries(expected)) {
    const entry = CN_V20261019.rules[id];
    assert.deepEqual(entry.sourceOfTruth, references);
    assert(Object.isFrozen(entry));
    assert(Object.isFrozen(entry.sourceOfTruth));
    for (const reference of entry.sourceOfTruth) {
      assert(Object.isFrozen(reference));
      assert.throws(() => { reference.section = '什么是特殊状态'; }, TypeError);
    }
  }
});

test('source bytes verifier rejects corruption, truncation, fake PDF bodies, missing pins and text inputs', () => {
  assert.equal(verifySourceBytes(document(), bytes).byteLength, bytes.length);
  assert.throws(() => verifySourceBytes(document(), bytes.subarray(1)), /do not match/);
  const corrupt = Buffer.from(bytes); corrupt[10] ^= 1;
  assert.throws(() => verifySourceBytes(document(), corrupt), /do not match/);
  const noHeader = Buffer.from(bytes); noHeader[0] = 0;
  const d = { ...document(), sha256: createHash('sha256').update(noHeader).digest('hex') };
  assert.throws(() => verifySourceBytes(d, noHeader), /do not match/);
  assert.throws(() => verifySourceBytes(document(), 'text'), /byte array/);
  for (const change of [{ sha256: null }, { byteLength: 0 }, { evidence: {} }])
    assert.throws(() => verifySourceBytes({ ...document(), ...change }, bytes), /not binary-pinned/);
  assert.throws(() => sourceCachePath({ ...document(), sha256: 'not-a-hash' }), /pinned fingerprint/);
});

test('offline source verification never fetches; download verifies before atomic storage and never accepts changed bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cn-source-cache-'));
  try {
    const d = document(), ruleset = { documents: [d, { evidence: { binaryVerification: 'pending' } }] };
    let fetches = 0;
    const fetcher = async (url, options) => {
      fetches++; assert.equal(url.hostname, 'image.pokemon.com.cn'); assert.equal(options.redirect, 'error');
      return new Response(bytes, { status: 200 });
    };
    await assert.rejects(checkRuleSources({ directory, ruleset, fetcher }), /Missing pinned source/);
    assert.equal(fetches, 0);
    const receipts = await checkRuleSources({ directory, ruleset, download: true, fetcher });
    assert.equal(fetches, 1); assert.equal(receipts.length, 1);
    assert.deepEqual(await readFile(sourceCachePath(d, directory)), bytes);
    assert.deepEqual(await checkRuleSources({ directory, ruleset, download: true, fetcher }), receipts);
    assert.equal(fetches, 1, 'An already verified cache entry must not be re-downloaded.');
    await writeFile(sourceCachePath(d, directory), Buffer.from('corrupt'));
    await assert.rejects(checkRuleSources({ directory, ruleset, download: true, fetcher }), /do not match/);
    assert.equal(fetches, 1, 'Do not quietly refresh a corrupt entry or accept new hashes.');
  } finally { await rm(directory, { force: true, recursive: true }); }
});

test('HTML download/cache checks preserve the original receipt and refuse dynamic template drift without writing new evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cn-html-source-'));
  try {
    const html = Buffer.from('<!DOCTYPE html>\n<p>SYNTHETIC reviewed page</p>');
    const d = { ...document(), mediaType: 'text/html', url: 'https://www.pokemon.cn/fixture',
      byteLength: html.length, sha256: createHash('sha256').update(html).digest('hex') };
    const ruleset = { documents: [d] };
    let fetches = 0;
    const fetcher = async () => { fetches++; return new Response(html); };
    await checkRuleSources({ ruleset, directory, download: true, fetcher });
    assert.deepEqual(await readFile(sourceCachePath(d, directory)), html);
    await checkRuleSources({ ruleset, directory, download: true, fetcher });
    assert.equal(fetches, 1);
    await rm(sourceCachePath(d, directory));
    await assert.rejects(checkRuleSources({ ruleset, directory, download: true,
      fetcher: async () => new Response('<!DOCTYPE html>\n<p>new dynamic nonce</p>') }), /do not match/);
    await assert.rejects(readFile(sourceCachePath(d, directory)), { code: 'ENOENT' });
  } finally { await rm(directory, { force: true, recursive: true }); }
});

test('source download refuses non-official hosts/credentials and does not cache failed responses or mismatched content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cn-source-failed-'));
  try {
    for (const url of ['http://image.pokemon.com.cn/a.pdf', 'https://evil.example/a.pdf', 'https://user:pass@www.pokemon.cn/a.pdf']) {
      const ruleset = { documents: [{ ...document(), url }] };
      await assert.rejects(checkRuleSources({ ruleset, directory, download: true }), /non-official source/);
    }
    const ruleset = { documents: [document()] };
    await assert.rejects(checkRuleSources({ ruleset, directory, download: true,
      fetcher: async () => new Response('Forbidden', { status: 403 }) }), /download failed \(403\)/);
    await assert.rejects(checkRuleSources({ ruleset, directory, download: true,
      fetcher: async () => new Response('not the reviewed PDF') }), /do not match/);
    await assert.rejects(readFile(sourceCachePath(document(), directory)), { code: 'ENOENT' });
  } finally { await rm(directory, { force: true, recursive: true }); }
});
