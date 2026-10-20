// Offline, read-only REVIEW QUEUE. Never imports legacy data as code, constructs
// CardDefinitions, sets verified flags, approves a release, or writes trust pins.
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = 'tools/52poke-cards';
const SNAPSHOT = `${TOOL}/snapshots/2026.10.18`;
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sorted = (values) => [...values].sort(cmp);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const array = (v) => Array.isArray(v) ? v : [];
const value = (v) => v === undefined ? null : v;
const canonical = (v) => JSON.stringify(v, (_key, item) => object(item) ?
  Object.fromEntries(sorted(Object.keys(item)).map((key) => [key, item[key]])) : item);
const countBy = (values) => Object.fromEntries(sorted(new Set(values)).map((key) =>
  [key, values.filter((v) => v === key).length]));
const REQUIRED = Object.freeze([
  'source-language-unreviewed', 'physical-game-unreviewed', 'printing-number-unreviewed',
  'series-mark-release-unreviewed', 'official-card-erratum-binding-missing',
  'cn-handler-equivalence-unreviewed', 'definition-approval-missing',
  'printing-approval-missing', 'trusted-release-missing',
]);

function inside(base, path) {
  if (typeof path !== 'string' || !path || isAbsolute(path)) throw new Error('Expected a relative evidence path.');
  const out = resolve(base, path), rel = relative(base, out);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Evidence path escapes its input directory.');
  return out;
}

async function exists(path) {
  try { return (await stat(path)).isFile(); } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function legacySemantics(card) {
  return {
    printedFields: Object.fromEntries(['hp', 'type', 'stage', 'evolvesFrom', 'weakness', 'resistance',
      'retreat', 'energyType'].filter((k) => Object.hasOwn(card, k)).map((k) => [k, card[k]])),
    attacks: array(card.attacks).map((a, slot) => ({
      slot, name: value(a.name), cost: value(a.cost), damage: value(a.damage),
      effect: value(a.effect), textSha256: typeof a.text === 'string' ? digest(a.text) : null,
    })),
    power: value(card.power), trainer: value(card.trainer), trainerType: value(card.ttype),
    tool: value(card.tool), stadium: value(card.stadium), specialEnergy: value(card.special),
    ruleFields: Object.fromEntries(['prizes', 'ruleBox', 'aceSpec', 'tera', 'tags', 'attackNeedsTag', 'needsTag', 'provides']
      .filter((k) => Object.hasOwn(card, k)).map((k) => [k, card[k]])),
  };
}

function effectTokens(card) {
  return sorted(new Set([
    ...array(card.attacks).flatMap((a) => Object.keys(a.effect || {}).map((k) => `attack.effect.${k}`)),
    ...['power', 'trainer', 'tool', 'stadium', 'special'].flatMap((k) => {
      const v = k === 'power' ? card.power?.kind : card[k];
      return typeof v === 'string' ? [`${k}:${v}`] : [];
    }),
  ]));
}

/** All returned entries remain blocked, including inputs claiming verified. */
export async function auditCnMigration({
  root = ROOT, deck = null, card = null, offset = 0, limit = null, library = null, mikSource = null,
} = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || limit !== null && (!Number.isSafeInteger(limit) || limit < 1))
    throw new Error('offset must be nonnegative and limit must be positive safe integers.');
  root = resolve(root);
  const inputs = [], evidenceIssues = [], inputNames = new Set();
  async function bytes(path, label) {
    const buffer = await readFile(path);
    if (!inputNames.has(label)) {
      inputs.push({ path: label, bytes: buffer.length, sha256: digest(buffer) }); inputNames.add(label);
    }
    return buffer;
  }
  const text = async (label) => (await bytes(inside(root, label), label)).toString('utf8');
  const json = async (label) => JSON.parse(await text(label));
  const optionalJSON = async (label) => await exists(inside(root, label)) ? json(label) : null;
  const index = await json('public/data/decks/index.json');
  if (!Array.isArray(index.decks) || index.modern !== undefined && !Array.isArray(index.modern))
    throw new Error('Unsupported legacy deck index shape.');
  const indexedKeys = [...index.decks, ...array(index.modern).map((d) => d.key)];
  const safeKey = (k) => typeof k === 'string' && /^[a-zA-Z0-9_-]+$/.test(k);
  if (indexedKeys.some((k) => !safeKey(k)) || new Set(indexedKeys).size !== indexedKeys.length)
    throw new Error('Invalid or duplicate deck key.');
  const deckFolder = inside(root, 'public/data/decks');
  const diskKeys = [];
  for (const entry of await readdir(deckFolder, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (!await exists(inside(root, `public/data/decks/${entry.name}/cards.json`))) continue;
    if (!safeKey(entry.name)) throw new Error(`Unsupported deck directory name; cannot omit catalog: ${entry.name}`);
    diskKeys.push(entry.name);
  }
  if (index.classicBundle !== undefined && (typeof index.classicBundle !== 'string' ||
      !/^[a-zA-Z0-9_-]+\.json$/.test(index.classicBundle)))
    throw new Error('Invalid classic bundle path.');
  const bundle = index.classicBundle ? await json(`public/data/decks/${index.classicBundle}`) : {};
  if (!object(bundle) || index.classicBundle &&
      (index.decks.some((k) => !Object.hasOwn(bundle, k)) || Object.keys(bundle).some((k) => !index.decks.includes(k))))
    throw new Error('Classic bundle keys do not exactly match the indexed classic decks.');
  const keys = sorted(new Set([...indexedKeys, ...diskKeys.filter((k) => !indexedKeys.includes(k))]));
  const records = new Map(), decks = [], variantTotal = [];
  for (const key of keys) {
    const path = `public/data/decks/${key}/cards.json`;
    const onDisk = await exists(inside(root, path));
    if (!onDisk && !indexedKeys.includes(key)) continue; // Other directories are not deck catalogs.
    const file = onDisk ? await json(path) : bundle[key];
    if (!object(file) || !Array.isArray(file.cards) || !file.cards.length)
      throw new Error(`Missing or malformed deck: ${key}`);
    if (onDisk && Object.hasOwn(bundle, key) && canonical(file) !== canonical(bundle[key]))
      throw new Error(`Classic bundle diverges from the source catalog: ${key}; a complete inventory cannot choose one silently.`);
    const deckIds = [], duplicateIds = new Set(), seenIds = new Set();
    let copies = 0;
    file.cards.forEach((c, row) => {
      if (!object(c) || typeof c.id !== 'string' || !c.id ||
          !['pokemon', 'trainer', 'energy'].includes(c.kind) || !Number.isSafeInteger(c.count) || c.count < 1)
        throw new Error(`Malformed legacy card/count: ${key} row ${row}`);
      copies += c.count;
      if (!Number.isSafeInteger(copies)) throw new Error(`Unsafe deck count: ${key}`);
      if (seenIds.has(c.id)) duplicateIds.add(c.id);
      seenIds.add(c.id); deckIds.push(c.id);
      const definition = Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'count'));
      const signature = canonical(definition), sha256 = digest(signature);
      if (!records.has(c.id)) records.set(c.id, { variants: new Map(), uses: [] });
      const record = records.get(c.id);
      if (!record.variants.has(sha256)) record.variants.set(sha256, definition);
      record.uses.push({ deck: key, row, count: c.count, definitionSha256: sha256 });
      variantTotal.push(sha256);
    });
    decks.push({ key, name: value(file.name), indexed: indexedKeys.includes(key),
      path: onDisk ? path : `public/data/decks/${index.classicBundle}#${key}`,
      copies, distinctCards: new Set(deckIds).size, cardIds: sorted(new Set(deckIds)),
      structuralIssues: [
        ...(copies === 60 ? [] : ['not-60-cards']),
        ...(duplicateIds.size ? ['duplicate-card-id-rows'] : []),
        ...(indexedKeys.includes(key) ? [] : ['unindexed-deck']),
      ] });
  }
  if (deck !== null && !decks.some((d) => d.key === deck)) throw new Error(`Unknown deck filter: ${deck}`);
  if (card !== null && !records.has(card)) throw new Error(`Unknown card filter: ${card}`);

  // Parse only the known JSON export, never evaluate/import a locale module.
  const localePath = 'public/data/locales/zh-CN.js';
  let locale = { cards: {}, sources: {} };
  if (await exists(inside(root, localePath))) {
    const source = await text(localePath), match = /^(?:\s*\/\/[^\n]*\n)*\s*export default ([\s\S]*?);?\s*$/.exec(source);
    if (!match) throw new Error('Locale must be a literal JSON export, not executable JavaScript.');
    locale = JSON.parse(match[1].replace(/;\s*$/, ''));
    if (!object(locale.cards) || !object(locale.sources)) throw new Error('Malformed presentation-only locale.');
  } else evidenceIssues.push({ code: 'presentation-catalog-missing' });
  const wantedPages = new Set([...records.keys()].map((id) => locale.cards[id]?.source).filter((s) => typeof s === 'string'));
  const pages = new Map(), snapshotStats = { records: 0, tcgPages: 0, pocketPages: 0,
    printingRows: 0, printingLanguages: {}, incompleteNumberRows: 0, missingSeriesRows: 0, missingMarkRows: 0 };
  const manifest = await optionalJSON(`${SNAPSHOT}/manifest.json`);
  async function lines(path, label, callback, expected = null) {
    // Compressed bytes AND decompressed bytes/counts are checked before the
    // report can return. A bad stream cannot yield a partially "good" report.
    const raw = await bytes(path, label);
    if (expected && (raw.length !== expected.gzip_bytes || digest(raw) !== expected.gzip_sha256))
      throw new Error(`Snapshot compressed hash/size mismatch: ${label}`);
    const source = createReadStream(path);
    const decoded = label.endsWith('.gz') ? source.pipe(createGunzip()) : source;
    const hash = createHash('sha256'); let size = 0, count = 0;
    decoded.on('data', (chunk) => { size += chunk.length; hash.update(chunk); });
    const reader = createInterface({ input: decoded, crlfDelay: Infinity });
    // Forward stream errors to the async iterator; never silently skip broken JSONL.
    let streamError = null;
    const onError = (error) => { streamError = error; reader.close(); };
    source.on('error', onError); decoded.on('error', onError);
    try {
      for await (const line of reader) {
        if (!line.trim()) throw new Error(`Blank JSONL record: ${label}:${count + 1}`);
        count++;
        if (count > 200_000) throw new Error(`Audit input exceeds 200000 records: ${label}`);
        callback(JSON.parse(line), count);
      }
      if (streamError) throw streamError;
    } finally { source.destroy(); decoded.destroy(); reader.close(); }
    const sha256 = hash.digest('hex');
    if (expected && (size !== expected.published_uncompressed_bytes ||
        sha256 !== expected.published_uncompressed_sha256 || count !== expected.records))
      throw new Error(`Snapshot decompressed hash/size/count mismatch: ${label}`);
    return { records: count, decodedBytes: size, decodedSha256: sha256 };
  }
  if (manifest) {
    if (manifest.archive_release !== '2026.10.18') throw new Error('Wrong metadata snapshot.');
    const label = `${SNAPSHOT}/cards.jsonl.gz`, expected = manifest.files?.['cards.jsonl.gz'];
    if (!object(expected)) throw new Error('Missing card snapshot integrity receipt.');
    await lines(inside(root, label), label, (p) => {
      if (typeof p.id !== 'string' || !Array.isArray(p.games) || !Array.isArray(p.printings) || !Array.isArray(p.card_blocks))
        throw new Error('Malformed Wiki record.');
      snapshotStats.records++;
      if (p.games.includes('tcg')) snapshotStats.tcgPages++;
      if (p.games.includes('pocket')) snapshotStats.pocketPages++;
      for (const printing of p.printings) {
        snapshotStats.printingRows++;
        const language = printing.language ?? 'unknown';
        snapshotStats.printingLanguages[language] = (snapshotStats.printingLanguages[language] || 0) + 1;
        if (typeof printing.number !== 'string' || !printing.number.trim() || printing.number === '—')
          snapshotStats.incompleteNumberRows++;
        if (!printing.series) snapshotStats.missingSeriesRows++;
        if (!printing.regulation_mark) snapshotStats.missingMarkRows++;
      }
      if (wantedPages.has(p.id)) {
        if (pages.has(p.id)) throw new Error(`Duplicate Wiki page: ${p.id}`);
        pages.set(p.id, p);
      }
    }, expected);
    if (manifest.files['cards.jsonl.gz'].printing_rows !== snapshotStats.printingRows ||
        manifest.files['cards.jsonl.gz'].game_page_counts?.tcg !== snapshotStats.tcgPages ||
        manifest.files['cards.jsonl.gz'].game_page_counts?.pocket !== snapshotStats.pocketPages)
      throw new Error('Snapshot game/printing count mismatch.');
    const displayLabel = `${SNAPSHOT}/display-zh-hans.jsonl.gz`;
    const displayExpected = manifest.files?.['display-zh-hans.jsonl.gz'];
    if (!object(displayExpected)) throw new Error('Missing display snapshot integrity receipt.');
    await lines(inside(root, displayLabel), displayLabel, (p) => {
      if (typeof p.id !== 'string') throw new Error('Malformed display metadata record.');
    }, displayExpected);
  } else evidenceIssues.push({ code: 'wiki-snapshot-missing' });

  const samples = [], sampleManifest = await optionalJSON(`${TOOL}/samples/manifest.json`);
  for (const sample of array(sampleManifest?.samples)) {
    const label = `${TOOL}/samples/${sample.file}`;
    const buffer = await bytes(inside(inside(root, `${TOOL}/samples`), sample.file), label);
    samples.push({ id: sample.id, game: sample.game, language: sample.printing_language,
      setCode: sample.set_id, number: sample.number, path: label,
      byteHashMatchesManifest: digest(buffer) === sample.sha256 && buffer.length === sample.bytes,
      sourcePage: value(sample.source_page_url), sourcePages: array(sample.source_pages).map((p) => p.id).sort(cmp),
      humanReviewedClaim: sample.human_reviewed === true, admitted: false,
      engineVersionMapping: false });
  }
  if (samples.some((s) => !s.byteHashMatchesManifest)) evidenceIssues.push({ code: 'sample-image-hash-mismatch' });

  // Optional machine-local inputs: indexes only, plus explicitly referenced
  // candidate metadata / the twenty frozen observations. No NAS tree traversal.
  const localEvidence = { library: null, mik: null };
  const libraryByIdentity = new Map();
  if (library) {
    library = resolve(library);
    const label = '@library/index.jsonl';
    const summary = { records: 0, languages: {}, linkedMetadata: 0 };
    await lines(inside(library, 'index.jsonl'), label, (row) => {
      if (typeof row.id !== 'string' || typeof row.metadata_file !== 'string') throw new Error('Malformed local library index.');
      if (libraryByIdentity.has(row.id)) throw new Error(`Duplicate local printing identity: ${row.id}`);
      libraryByIdentity.set(row.id, row); summary.records++;
      const lang = row.printing_language ?? 'unknown';
      summary.languages[lang] = (summary.languages[lang] || 0) + 1;
    });
    localEvidence.library = summary;
  }
  const observationsPath = `${TOOL}/mik_merge/example-card-face-observations.json`;
  const observations = await optionalJSON(observationsPath);
  const observedPrintings = array(observations?.observations).map((o) => ({
    sourceId: o.mik_id, printedNumber: o.printed_number, imageSha256: o.image_sha256,
    humanReviewedClaim: o.human_reviewed === true, imageHashCheckedLocally: false, admitted: false,
  }));
  if (mikSource) {
    mikSource = resolve(mikSource);
    const summary = { indexedCards: 0, metadataDone: 0, imagesDone: 0, observations: observedPrintings };
    await lines(inside(mikSource, 'index.jsonl'), '@mik/index.jsonl', (row) => {
      if (!object(row.source_card)) throw new Error('Malformed MIK index.');
      summary.indexedCards++;
      if (row.metadata_state === 'done') summary.metadataDone++;
      if (row.image_state === 'done') summary.imagesDone++;
    });
    for (let i = 0; i < observedPrintings.length; i++) {
      const o = observations.observations[i], label = `@mik/${o.evidence}`;
      if (await exists(inside(mikSource, o.evidence))) {
        observedPrintings[i].imageHashCheckedLocally = true;
        observedPrintings[i].imageHashMatchesObservation = digest(await bytes(inside(mikSource, o.evidence), label)) === o.image_sha256;
      }
    }
    localEvidence.mik = summary;
  }

  const code = {};
  for (const path of ['public/ui.js', 'public/cards.js', 'public/card-presentation.js',
    'public/rules/catalog-release.js', 'public/rules/reviewed-game.js', 'public/rules/handlers.js']) {
    code[path] = await exists(inside(root, path)) ? await text(path) : '';
  }
  const rows = [];
  for (const id of sorted(records.keys())) {
    const record = records.get(id);
    const variantRows = [...record.variants].sort(([a], [b]) => cmp(a, b));
    const legacy = variantRows[0][1], presentation = locale.cards[id] || {}, page = pages.get(presentation.source);
    const sourceRef = locale.sources[presentation.source];
    const provenanceMatches = !!page && !!sourceRef && sourceRef.revision === page.revision_id &&
      sourceRef.raw_sha256 === page.source_wikitext_sha256;
    const tcgPage = page?.games.includes('tcg') && !page.games.includes('pocket');
    const printings = tcgPage ? page.printings.map((p) => ({
      // Do not parse, pad, truncate, normalize case or derive a number from ID.
      pageId: page.id, templateIndex: value(p.source_template_index), game: 'tcg',
      language: value(p.language), setCode: value(p.set_code), number: value(p.number),
      series: value(p.series), regulationMark: value(p.regulation_mark), releasedOn: value(p.release_date),
      identityIssues: [
        ...(p.language === 'zh-Hans' ? [] : ['non-cn-printing-language']),
        ...(typeof p.set_code === 'string' && p.set_code ? [] : ['product-id-not-recorded']),
        ...(typeof p.number !== 'string' || !p.number.trim() || p.number === '—' ?
          ['full-number-not-recorded'] : p.number.includes('/') ? [] : ['opaque-number-needs-card-face-review']),
        ...(p.series ? [] : ['series-not-recorded']),
        ...(p.regulation_mark ? [] : ['mark-not-recorded-needs-blank-or-mark-review']),
        ...(p.release_date ? [] : ['release-date-not-recorded']),
      ],
      authority: 'wiki-metadata-candidate-only', admitted: false,
    })) : [];
    printings.sort((a, b) => cmp(canonical(a), canonical(b)));
    const localMetadata = [];
    for (const p of printings) {
      const identity = `tcg:${p.language}:${p.setCode}:${p.number}`;
      const row = libraryByIdentity.get(identity);
      if (!row || localMetadata.some((m) => m.identity === identity)) continue;
      const label = `@library/${row.metadata_file}`;
      const metadata = JSON.parse((await bytes(inside(library, row.metadata_file), label)).toString('utf8'));
      localMetadata.push({ identity, path: label, game: value(metadata.game),
        language: value(metadata.printing_language), setCode: value(metadata.set_id), number: value(metadata.number),
        indexIdentityMatches: metadata.id === identity && metadata.game === 'tcg' &&
          metadata.printing_language === p.language && metadata.set_id === p.setCode && metadata.number === p.number,
        sourcePageLinked: array(metadata.source_pages).some((s) => s.id === page.id &&
          s.revision_id === page.revision_id && s.source_wikitext_sha256 === page.source_wikitext_sha256),
        humanReviewedClaim: metadata.human_reviewed === true, admitted: false });
    }
    const scan = presentation.scan;
    const gaps = [...REQUIRED];
    if (record.variants.size > 1) gaps.push('conflicting-legacy-definitions');
    if (!page) gaps.push('linked-wiki-page-missing');
    else if (!tcgPage) gaps.push('pocket-or-ambiguous-page-excluded');
    if (page && !provenanceMatches) gaps.push('presentation-provenance-mismatch');
    if (!printings.some((p) => p.language === 'zh-Hans')) gaps.push('no-linked-cn-wiki-printing-candidate');
    if (localMetadata.some((m) => !m.indexIdentityMatches || !m.sourcePageLinked)) gaps.push('local-metadata-identity-mismatch');
    rows.push({ legacyId: id, legacyName: value(legacy.name), kind: legacy.kind,
      status: 'blocked', admitted: false,
      legacyIdentity: { setCode: value(legacy.set), number: value(legacy.number),
        language: value(legacy.language), game: value(legacy.game), inferredFields: [] },
      variants: variantRows.map(([sha256, definition]) => ({
        sha256, identity: { setCode: value(definition.set), number: value(definition.number),
          language: value(definition.language), game: value(definition.game) },
        semantics: legacySemantics(definition), effectTokens: effectTokens(definition),
      })),
      uses: record.uses.sort((a, b) => cmp(a.deck, b.deck) || a.row - b.row),
      metadata: { pageId: value(presentation.source), revision: value(page?.revision_id),
        provenanceMatches, pageGames: value(page?.games), printings,
        localMetadata, cnPrintingCandidates: printings.filter((p) => p.language === 'zh-Hans').length,
        wikiBlockShapes: array(page?.card_blocks).map((b) => ({ game: b.game, kind: b.kind,
          templateIndex: value(b.source_template_index), hp: value(b.hp),
          attackDamage: array(b.attacks).map((a) => value(a.damage)),
          notAnEquivalenceProof: true })),
        scan: scan ? { language: value(scan.image_language), sha256: value(scan.sha256),
          sourcePage: value(scan.source_page_url), printings: array(scan.printings),
          presentationOnly: true } : null },
      gaps: sorted(gaps),
    });
  }
  if (localEvidence.library)
    localEvidence.library.linkedMetadata = new Set(rows.flatMap((r) => r.metadata.localMetadata.map((m) => m.path))).size;
  const byId = new Map(rows.map((r) => [r.legacyId, r]));
  for (const d of decks) {
    d.blockedCards = d.distinctCards;
    d.missingCnCandidateIds = d.cardIds.filter((id) => byId.get(id).metadata.cnPrintingCandidates === 0);
    d.cnScanEvidenceIds = d.cardIds.filter((id) => byId.get(id).metadata.scan?.language === 'zh-Hans');
    d.legacyEffectTokenCount = new Set(d.cardIds.flatMap((id) =>
      byId.get(id).variants.flatMap((v) => v.effectTokens))).size;
    d.admitted = false;
  }
  const matches = rows.filter((r) => (deck === null || r.uses.some((u) => u.deck === deck)) &&
    (card === null || r.legacyId === card));
  const pageRows = matches.slice(offset, limit === null ? undefined : offset + limit);
  return {
    schema: 'cn-migration-audit-v1', ruleset: { region: 'CN', version: 'V20261019' },
    status: 'blocked', officialAdmission: false,
    policy: { readOnly: true, offline: true, generatesApprovals: false, generatesTrustPins: false,
      legacyIdsAreNotCnPrintingIds: true, sameNameIsNotEquivalence: true,
      unknownFieldsAreNeverVerified: true, auditIsNotARelease: true },
    summary: {
      decks: decks.length, indexedDecks: decks.filter((d) => d.indexed).length,
      unindexedDecks: decks.filter((d) => !d.indexed).length,
      uniqueLegacyCards: rows.length, legacyCardRows: variantTotal.length,
      kinds: countBy(rows.map((r) => r.kind)), conflictingLegacyIds: rows.filter((r) => r.variants.length > 1).length,
      withLinkedCnCandidates: rows.filter((r) => r.metadata.cnPrintingCandidates > 0).length,
      withPresentationScans: rows.filter((r) => r.metadata.scan).length,
      presentationScanLanguages: countBy(rows.flatMap((r) => r.metadata.scan ? [r.metadata.scan.language ?? 'unknown'] : [])),
      linkedProvenanceMismatches: rows.filter((r) => r.metadata.revision && !r.metadata.provenanceMatches).length,
      approvedDefinitions: 0, approvedPrintings: 0, admittedCards: 0,
      approvalScope: 'This audit performs no admission and imports no independent approval configuration.',
      gapCounts: countBy(rows.flatMap((r) => r.gaps)),
    },
    website: {
      legacyGameImported: /import\s*\{[^}]*\bGame\b[^}]*\}\s*from\s*['"]\.\/engine\.js['"]/.test(code['public/ui.js']),
      legacyGameConstructed: /\bnew Game\s*\(/.test(code['public/ui.js']),
      legacySaveRestored: /\bGame\.restore\s*\(/.test(code['public/ui.js']),
      reviewedGameEntryReferenced: /\bcreateReviewedGame\b/.test(code['public/ui.js']),
      lowLevelReleaseLoaderPresent: /export async function loadReviewedCatalogRelease\b/.test(code['public/rules/catalog-release.js']),
      reviewedGameWrapperPresent: /export async function createReviewedGame\b/.test(code['public/rules/reviewed-game.js']),
      findingsAreStaticInspectionNotRuntimeProof: true,
    },
    installedHandlerIds: sorted(new Set([...code['public/rules/handlers.js'].matchAll(/['"](cn\.[\w.]+@\d+)['"]/g)].map((m) => m[1]))),
    metadataSnapshot: manifest ? { release: manifest.archive_release, integrityChecked: true, ...snapshotStats } : null,
    reusableEvidence: { samples, frozenMikObservations: observedPrintings, local: localEvidence,
      notAnEngineMappingOrApproval: true,
      license: '52poke-derived metadata: CC-BY-NC-SA-3.0; images retain their owners’ rights; not MIT.' },
    evidenceIssues: evidenceIssues.sort((a, b) => cmp(canonical(a), canonical(b))),
    decks,
    deckReviewOrder: [...decks].sort((a, b) => a.missingCnCandidateIds.length - b.missingCnCandidateIds.length ||
      a.distinctCards - b.distinctCards || a.legacyEffectTokenCount - b.legacyEffectTokenCount || cmp(a.key, b.key))
      .map((d) => ({ key: d.key, cardsToReview: d.distinctCards, missingCnCandidates: d.missingCnCandidateIds.length,
        cnScanEvidence: d.cnScanEvidenceIds.length, legacyEffectTokens: d.legacyEffectTokenCount,
        notAFormatLegalityCheck: true,
        command: `node scripts/audit-cn-migration.mjs --json --deck ${d.key}` })),
    queue: { filter: { deck, card }, total: matches.length, offset, returned: pageRows.length,
      nextOffset: offset + pageRows.length < matches.length ? offset + pageRows.length : null, cards: pageRows },
    inputs: inputs.sort((a, b) => cmp(a.path, b.path)),
  };
}

export function stableReportJSON(report) { return JSON.stringify(JSON.parse(canonical(report)), null, 2) + '\n'; }

const HELP = `Offline CN/V20261019 migration REVIEW QUEUE (never approves cards)
Usage: node scripts/audit-cn-migration.mjs [--json] [--root DIR]
       [--deck KEY] [--card LEGACY_ID] [--offset N] [--limit N]
       [--library DIR] [--mik-source DIR]
All legacy deck catalogs are inspected before filtering. Optional local inputs
are read only; no downloads, bootstrap, image conversion, release or trust pins.
Exit 0: help; 1: invalid input/integrity failure; 2: audited, official admission blocked.
`;

export async function main(argv = process.argv.slice(2)) {
  let asJSON = false;
  try {
    const options = {}, flags = new Map([['--root', 'root'], ['--deck', 'deck'], ['--card', 'card'],
      ['--offset', 'offset'], ['--limit', 'limit'], ['--library', 'library'], ['--mik-source', 'mikSource']]);
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--help') { process.stdout.write(HELP); return 0; }
      if (argv[i] === '--json') { asJSON = true; continue; }
      const key = flags.get(argv[i]);
      if (!key || i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`Invalid argument: ${argv[i]}`);
      if (Object.hasOwn(options, key)) throw new Error(`Duplicate option: ${argv[i]}`);
      const input = argv[++i];
      if (['offset', 'limit'].includes(key) && !/^\d+$/.test(input)) throw new Error(`Invalid integer: ${input}`);
      options[key] = ['offset', 'limit'].includes(key) ? Number(input) : input;
    }
    const report = await auditCnMigration(options);
    if (asJSON) process.stdout.write(stableReportJSON(report));
    else process.stdout.write(`CN/V20261019 migration: BLOCKED (review queue only)\n` +
      `${report.summary.decks} decks; ${report.summary.uniqueLegacyCards} legacy cards; 0 admitted.\n` +
      `${report.summary.withLinkedCnCandidates} have linked CN metadata candidates; these are not approvals.\n` +
      `Queue: ${report.queue.returned}/${report.queue.total}; offset=${report.queue.offset}; next=${report.queue.nextOffset ?? 'none'}.\n` +
      report.queue.cards.map((r) => `${r.legacyId}: ${r.gaps.join(', ')}\n`).join('') +
      `Use --json for exact printings, legacy handlers, provenance, deck ranking and input hashes.\n`);
    return 2;
  } catch (error) {
    const result = { schema: 'cn-migration-audit-v1', status: 'invalid-input', officialAdmission: false, error: error.message };
    if (asJSON) process.stdout.write(stableReportJSON(result));
    else process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await main();
