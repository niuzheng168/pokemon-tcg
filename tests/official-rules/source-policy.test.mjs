import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CN_OFFICIAL_SOURCE_HOSTS, CN_OFFICIAL_EVIDENCE_URL_PATTERN, createRuleset } from '../../public/rules/registry.js';
import { assertDefinitionShape } from '../../public/rules/card-schema.js';
import { createCardCatalog } from '../../public/rules/catalog.js';
import { normalizeKnockoutEvent } from '../../public/rules/battle-history.js';
import { resolveBurnCounters } from '../../public/rules/checkup-effects.js';
import { checkRuleSources } from '../../scripts/check-rules-sources.mjs';
import { fixture, EVIDENCE } from './fixtures.mjs';

const evidence = (url) => [{ ...EVIDENCE[0], url }];
const doc = (url) => ({ id: 'TEST-HOST', title: 'Synthetic URL-policy test, not an actual document',
  authority: 'TEST ONLY', url, sha256: null, evidence: { binaryVerification: 'pending' } });
const ruleset = (url) => ({ region: 'CN', version: 'V20261019', reviewedOn: '2026-10-20',
  documents: [doc(url)], rules: [{ id: 'test-only', summary: 'Synthetic admission test',
    sourceOfTruth: [{ documentId: 'TEST-HOST', section: 'TEST ONLY' }] }] });
const source = (url) => ({ instanceId: 'test-card', owner: 0, category: 'attack',
  pokemonId: 'test-pokemon', attackId: 'test-attack', effectId: 'attack:test-attack', sourceOfTruth: evidence(url) });

test('exact reviewed official hosts agree across card schemas, history, checkup and the document registry', async () => {
  assert.deepEqual(CN_OFFICIAL_SOURCE_HOSTS, ['www.pokemon.cn', 'image.pokemon.com.cn', 'special.pokemon.cn']);
  assert(Object.isFrozen(CN_OFFICIAL_SOURCE_HOSTS));
  for (const name of ['card-definition', 'checkup-effects']) {
    const schema = JSON.parse(await readFile(new URL(`../../schemas/${name}.schema.json`, import.meta.url)));
    assert.equal(schema.$defs.evidence.properties.url.pattern, CN_OFFICIAL_EVIDENCE_URL_PATTERN);
  }
  const f = await fixture();
  for (const host of CN_OFFICIAL_SOURCE_HOSTS) {
    const url = `https://${host}/TEST-NOT-A-REAL-CARD`;
    const d = structuredClone(f.definitions[0]); d.sourceOfTruth = evidence(url);
    assertDefinitionShape(d); createRuleset(ruleset(url));
    assert.equal(normalizeKnockoutEvent({ kind: 'ko', turn: 1, during: 0, owner: 1,
      pokemonId: 'victim', cause: { kind: 'attackDamage', source: source(url) } }).cause.source.owner, 0);
    assert.equal(resolveBurnCounters([{ id: 'test', count: 6, sourceOfTruth: evidence(url) }]).count, 6);
  }
});

test('an official campaign hostname permits evidence syntax, never self-approval of a downloaded card', async () => {
  const f = await fixture((ds) => { ds[0].sourceOfTruth = evidence('https://special.pokemon.cn/TEST-NOT-A-REAL-CARD'); });
  await assert.rejects(createCardCatalog({ ruleset: f.ruleset, definitions: f.definitions,
    printings: f.catalog.printings(), handlers: f.handlers }), /independent approval/);
});

test('lookalike hosts, credentials, HTTP and unrelated official regions cannot widen CN evidence admission', async () => {
  const f = await fixture();
  for (const url of ['http://special.pokemon.cn/a', 'https://special.pokemon.cn.evil.example/a',
    'https://evil.example/special.pokemon.cn/a', 'https://user:pass@special.pokemon.cn/a',
    'https://special.pokemon.cn:8443/a', 'https://asia.pokemon-card.com/a']) {
    const d = structuredClone(f.definitions[0]); d.sourceOfTruth = evidence(url);
    assert.throws(() => assertDefinitionShape(d));
    assert.throws(() => createRuleset(ruleset(url)), /Not an approved/);
    assert.throws(() => normalizeKnockoutEvent({ kind: 'ko', turn: 1, during: 0, owner: 1,
      pokemonId: 'victim', cause: { kind: 'attackDamage', source: source(url) } }));
    assert.throws(() => resolveBurnCounters([{ id: 'test', count: 6, sourceOfTruth: evidence(url) }]));
  }
});

test('source downloader accepts a separately pinned campaign HTML receipt without accepting redirects or unreviewed bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cn-source-policy-'));
  try {
    const bytes = Buffer.from('<!DOCTYPE html><p>SYNTHETIC host fixture, not an official card</p>');
    const document = { ...doc('https://special.pokemon.cn/TEST-NOT-A-REAL-PAGE'), mediaType: 'text/html',
      sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length,
      evidence: { binaryVerification: 'verified' } };
    const receipts = await checkRuleSources({ directory, ruleset: { documents: [document] }, download: true,
      fetcher: async (url, options) => {
        assert.equal(url.hostname, 'special.pokemon.cn'); assert.equal(options.redirect, 'error');
        return new Response(bytes);
      } });
    assert.equal(receipts[0].sha256, document.sha256);
    await assert.rejects(checkRuleSources({ directory, ruleset: { documents: [{
      ...document, id: 'different', url: 'https://special.pokemon.cn:8443/a',
    }] }, download: true }), /non-official source/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
