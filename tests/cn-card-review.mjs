// Independent review artifact checks / read-only queue. No real card approvals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createCoreHandlers } from '../public/rules/handlers.js';
import { assertExecutableDefinition } from '../public/rules/card-schema.js';
import { CN_OFFICIAL_EVIDENCE_URL_PATTERN } from '../public/rules/registry.js';
import { planDeckInspection } from '../public/rules/deck-window.js';
import { assertDeckEnergyAction, deckEnergyWindow } from '../public/rules/deck-energy.js';
import { validateCardDefinition, validateCardPrinting, validateCardsParameters,
  validateAttachedEnergyParameters, validateTriggerDescriptor } from '../public/rules/schema-validators.js';
import { loadReviewedCatalogRelease } from '../public/rules/catalog-release.js';
import { fixture, binding, board, command, hand, settle } from './official-rules/fixtures.mjs';

const root = new URL('../', import.meta.url);
const reportURL = new URL('docs/rules/zh-CN/V20261019/cards/sv-miraidon-review.json', root);
const reportBytes = await readFile(reportURL);
const report = JSON.parse(reportBytes);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const canonical = (v) => JSON.stringify(v, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ?
  Object.fromEntries(Object.keys(item).sort().map((k) => [k, item[k]])) : item);
const card = (id) => report.cards.find((c) => c.legacyId === id);
const baseCards = {
  from: 'deck', to: 'hand', selector: { kind: 'pokemon' }, quantity: { kind: 'exact', count: 1 },
  reveal: true, lookTop: null, shuffleAfter: true,
};
const switchGap = 'production-core-switch-handler-with-eligibility-contract';
const hostGap = 'official-evidence-url-schema-excludes-special.pokemon.cn';
const windowGap = 'retain-looked-at-remainder-randomize-and-place-bottom';
const energyGaps = [
  'bounded-deck-window-energy-distribution-to-filtered-bench',
  'deck-search-direct-energy-attachment-to-actor',
];
const resolvedEngineGaps = [switchGap, windowGap, ...energyGaps];
const args = process.argv.slice(2);

if (args.length) {
  // Exactly seventeen JSONL rows by default; filtering never changes admission.
  if (args[0] !== '--queue' || !(args.length === 1 || args.length === 3 && args[1] === '--card') ||
      args.length === 3 && !card(args[2])) {
    process.stderr.write('Usage: node tests/cn-card-review.mjs --queue [--card LEGACY_ID]\n');
    process.exitCode = 1;
  } else {
    for (const c of report.cards.filter((c) => args.length === 1 || c.legacyId === args[2]))
      process.stdout.write(JSON.stringify({ ordinal: c.ordinal, legacyId: c.legacyId,
        copies: c.legacyCopies, printing: c.candidatePrinting,
        reviewStatus: c.reviewStatus, admitted: false,
        engineGaps: c.implementationReview.engineCapabilityGaps,
        schemaGaps: c.implementationReview.schemaAdmissionGaps,
        missingEvidence: c.missingEvidence, nextStep: c.nextStep }) + '\n');
    process.exitCode = 2; // Review queue, never a playable/approved release.
  }
} else {
  // The legacy sv-miraidon deck file was removed with the teaching mode (2026-10-21); the
  // review keeps its pinned SHA-256 and per-definition digests as the historical record.
  test('review accounts for all seventeen sv-miraidon definitions and sixty copies', () => {
    assert.match(report.legacyDeck.source.sha256, /^[a-f0-9]{64}$/);
    assert.equal(report.cards.length, 17);
    assert.equal(new Set(report.cards.map((c) => c.legacyId)).size, 17);
    assert.equal(report.cards.reduce((n, c) => n + c.legacyCopies, 0), 60);
    report.cards.forEach((row, i) => {
      assert.equal(row.ordinal, i + 1);
      assert.match(row.legacyDefinitionSha256, /^[a-f0-9]{64}$/);
    });
  });

  test('the integration follow-up preserves original kernel receipts, primary observations and all card identity facts', () => {
    const originalKernelSha = '0dc9493ef5b739a827979cf9d77ef09e1e5ceb188c2d34349b74a054c8d72094';
    assert.equal(sha(canonical(report.kernelReview)), originalKernelSha,
      'Historical sourceReceipts and *AtReview findings must not be rewritten to match current code.');
    assert.equal(report.integrationReview.historicalKernelReviewSha256, originalKernelSha);
    assert.equal(report.integrationReview.historicalReviewRef, 'kernelReview');
    // The third-party receipts later gained committed or archived locations (sv-miraidon-evidence/README.md) and their
    // working path became `readFrom`; with only that undone, the sources are the reviewed ones.
    const reviewed = ({ readFrom, snapshot, localArchiveRef, ...r }) => ({ path: readFrom, ...r });
    const reviewedSources = Object.fromEntries(Object.entries(report.sources).map(([id, s]) => [id, { ...s,
      ...s.files && { files: Object.fromEntries(Object.entries(s.files).map(([k, f]) => [k, reviewed(f)])) },
      ...s.libraryMetadata && { libraryMetadata: reviewed(s.libraryMetadata) },
      ...s.mikMetadata && { mikMetadata: reviewed(s.mikMetadata) } }]));
    assert.equal(sha(canonical(reviewedSources)), '0bfdeacfc603634627e611397b6923de738b6d176c4b8eded61b1aba26441692');
    assert.equal(sha(canonical(report.cards.map(({ implementationReview, nextStep, ...facts }) => facts))),
      '8c2ae7cdfebab1a30fa1f145bb652da1afb6704e0c678f0afecbfaeb30d46979',
      'Primitive/URL re-evaluation cannot change card metadata, observations, missing evidence or approvals.');
    assert.equal(sha(canonical(report.policy)), '4f4bb00d3df1c5454a940d2e4452ca0b377c392914ff3750595c2ef0ffaff8ad');
    assert.equal(report.integrationReview.networkAcquisition, false);
  });

  test('the bounded generic gaps are resolved, without resolving no-recipient semantics or granting whole-card admission', async () => {
    const followUp = report.integrationReview;
    assert.deepEqual(report.summary.engineGaps, []);
    assert.deepEqual(followUp.remainingEngineGaps, []);
    assert(report.cards.every((c) => c.implementationReview.engineCapabilityGaps.length === 0));
    assert.deepEqual(report.summary.schemaAdmissionGaps, []);
    assert.deepEqual(followUp.remainingSchemaAdmissionGaps, []);
    assert(report.cards.every((c) => c.implementationReview.schemaAdmissionGaps.length === 0 &&
      !c.implementationReview.engineCapabilityGaps.includes(switchGap)));
    assert.deepEqual(report.summary.resolvedEngineGaps, resolvedEngineGaps);
    assert.deepEqual(followUp.resolvedEngineGaps, resolvedEngineGaps);
    assert.deepEqual(report.summary.resolvedSchemaAdmissionGaps, [hostGap]);
    assert.deepEqual(followUp.resolvedSchemaAdmissionGaps, [hostGap]);
    assert.equal(followUp.remainingGapStatus, 'generic-capabilities-verified-unresolved-boundary-and-card-review-remain');
    assert.deepEqual(report.summary.unresolvedBoundaries, ['deck-energy-no-recipient-look-attach-shuffle']);
    assert.deepEqual(followUp.unresolvedBoundaries.map((b) => b.id), report.summary.unresolvedBoundaries);
    assert.equal(followUp.completeCardSupportClaim, false);
    for (const review of [report.summary, followUp]) assert.equal(review.admittedCards, 0);
    assert.equal(followUp.productionApprovalsIssued, 0); assert.equal(followUp.trustPinsIssued, 0);
    for (const path of followUp.testEvidencePaths) assert.equal((await stat(new URL(path, root))).isFile(), true);
    assert(!card('sv1-194').nextStep.action.includes(switchGap));
    assert(!card('sv4-172').nextStep.action.includes(windowGap));
    for (const id of ['sv3pt5-25', 'sv4pt5-19'])
      assert(!card(id).nextStep.action.includes('显式审核并支持官方专题域名'));
  });

  test('unknowns and review claims cannot become executable definitions, printings or release approvals', async () => {
    assert.equal(report.policy.executableCatalog, false);
    assert.equal(report.policy.productionApprovalsIssued, 0); assert.equal(report.policy.trustPinsIssued, 0);
    for (const c of report.cards) {
      assert.equal(c.admitted, false); assert.equal(c.independentProductionApproval, false);
      assert.equal(c.implementationReview.completeCardSupportClaim, false);
      assert(c.missingEvidence.includes('independent-definition-approval'));
      assert(c.missingEvidence.includes('independent-printing-approval'));
      assert(c.missingEvidence.includes('production-release-approval'));
      assert(c.missingEvidence.includes('snapshot-specific-errata-review'));
      assert.equal(validateCardDefinition(c), false); assert.equal(validateCardPrinting(c), false);
      assert.equal(c.candidatePrinting.identityReviewStatus, 'not-issued');
      assert.equal(c.candidatePrinting.numberInferredFromLegacyId, false);
    }
    await assert.rejects(loadReviewedCatalogRelease({ json: reportBytes.toString('utf8') }),
      (error) => error.code === 'invalid-release-shape');
    assert.equal(report.boundedErrataReview.status, 'unknown');
    assert.equal(report.boundedErrataReview.noErrataClaim, false);
  });

  test('primary observations only cite separately fetched official bodies; third-party files remain hints', () => {
    for (const c of report.cards) {
      const hint = report.sources[c.staticCardFace.metadataHint.sourceId];
      assert.equal(hint.classification, 'third-party-metadata-and-image-hint');
      assert.equal(hint.approvalAuthority, false);
      assert.equal(hint.responseReceiptMatchesBytes, true); assert.equal(hint.imageReceiptMatchesBytes, true);
      assert.match(hint.files.metadata.sha256, /^[a-f0-9]{64}$/);
      const observed = c.staticCardFace.officialObservation;
      if (!observed) continue;
      const source = report.sources[observed.sourceId];
      assert.equal(source.classification, 'official-primary-image-bytes');
      assert.match(source.url, /^https:\/\/(?:image\.pokemon\.com\.cn|special\.pokemon\.cn)\//);
      assert.match(source.sha256, /^[a-f0-9]{64}$/);
      assert.equal(observed.humanApproval, false);
      assert.equal(source.rawBodyRedistributed, false);
    }
    assert.equal(report.cards.filter((c) => c.staticCardFace.officialObservation?.candidateIdentityObserved).length, 5);
    assert.equal(report.summary.exactPrimaryCardFacesObserved, 5);
    assert.equal(report.summary.metadataHintOnly, 10);
    assert.equal(reportBytes.includes(Buffer.from('auth_key=')), false, 'Do not persist ephemeral signed image query tokens.');
    assert.equal(report.sources['primary:csvh2-release'].sha256, null,
      'A reader result is not an original HTML byte hash.');
  });

  test('the bounded queue never treats a product release, rule example or generic energy image as whole-card proof', () => {
    assert.equal(report.policy.workQueueBound, 17);
    assert.equal(report.policy.networkAcquisitionStatus, 'closed-for-this-bounded-review');
    assert.equal(report.policy.productReleaseIsNotWholeCardFaceProof, true);
    for (const c of report.cards) {
      const exact = c.primaryEvidence.filter((e) => e.scope === 'exact-card-face');
      const observed = c.staticCardFace.officialObservation;
      if (c.reviewStatus === 'primary-face-observed') {
        assert.equal(exact.length, 1);
        assert.equal(exact[0].sourceId, observed.sourceId);
        assert.equal(observed.candidateIdentityObserved, true);
        assert.equal(report.sources[exact[0].sourceId].classification, 'official-primary-image-bytes');
      } else {
        assert.equal(exact.length, 0);
        assert(c.missingEvidence.includes('official-exact-printing-card-face'));
      }
      for (const e of c.primaryEvidence.filter((e) => e.sourceId.endsWith('-release')))
        assert.notEqual(e.scope, 'exact-card-face');
    }
  });

  test('original bodies and third-party receipts reproduce their pinned hashes from committed snapshots and archives, without network', async (t) => {
    const archived = (r) => `.cache/rules/card-review/V20261019/sv-miraidon/${r.sha256}.bin`;
    const snapshots = 'docs/rules/zh-CN/V20261019/cards/sv-miraidon-evidence/';
    const inputs = [];
    for (const [id, s] of Object.entries(report.sources)) {
      if (s.path && s.sha256) inputs.push({ path: new URL(s.path, root), ...s });
      if (s.cacheHint && s.sha256) inputs.push({ ...s, path: s.cacheHint });
      if (s.localArchiveRef) {
        assert.equal(s.localArchiveRef, archived(s));
        assert(s.classification.startsWith('official-primary'));
        inputs.push({ ...s, path: new URL(s.localArchiveRef, root) });
      }
      // Third-party receipts. `readFrom` (tools/52poke-cards/, git-ignored and built or linked per machine, so the same
      // path holds other bytes elsewhere) is provenance and never read: the 52Poké library metadata is committed by
      // hash (CC BY-NC-SA, sv-miraidon-evidence/README.md) and checked on every clone; the MIK exports, which may not
      // be committed, are checked in the hash-named local archive when it is present.
      for (const r of [...Object.values(s.files ?? {}), s.libraryMetadata, s.mikMetadata].filter(Boolean)) {
        assert.match(r.sha256, /^[a-f0-9]{64}$/, id); assert(Number.isInteger(r.bytes) && r.bytes > 0, id);
        assert.equal(r.path, undefined, id); assert.match(r.readFrom, /^tools\/52poke-cards\/(library|exports)\//, id);
        if (r === s.libraryMetadata) {
          assert.equal(r.snapshot, `${snapshots}${r.sha256}.json`, id); assert.equal(r.localArchiveRef, undefined, id);
          inputs.push({ ...r, path: r.snapshot, committed: true });
        } else {
          assert.equal(r.localArchiveRef, archived(r), id); assert.equal(r.snapshot, undefined, id);
          inputs.push({ ...r, path: r.localArchiveRef });
        }
      }
    }
    let checked = 0, committed = 0, absentOptionalCaches = 0;
    for (const r of inputs) {
      const path = r.path instanceof URL || String(r.path).startsWith('/') ? r.path : new URL(r.path, root);
      let bytes;
      try { bytes = await readFile(path); } catch (error) {
        if (error.code !== 'ENOENT' || r.committed) throw error;
        absentOptionalCaches++; continue; // Clean clones do not ship private/local caches.
      }
      assert.equal(sha(bytes), r.sha256, `Changed evidence requires renewed review: ${String(r.path)}`);
      assert.equal(bytes.length, r.bytes); checked++; if (r.committed) committed++;
    }
    // Every committed snapshot is a pinned receipt and nothing else sits beside them.
    const pinned = [...new Set(inputs.filter((r) => r.committed).map((r) => `${r.sha256}.json`))].sort();
    assert.equal(committed, 18); assert.equal(pinned.length, 18);
    assert.deepEqual((await readdir(new URL(snapshots, root))).filter((name) => name !== 'README.md').sort(), pinned);
    // The legacy presentation file public/data/locales/zh-CN.js was removed with the teaching mode (2026-10-21) and
    // keeps its pinned SHA-256 as the historical record.
    assert.match(report.sources['legacy:display'].sha256, /^[a-f0-9]{64}$/);
    t.diagnostic(`${checked} pinned inputs checked (${committed} committed snapshots); ${absentOptionalCaches} optional local caches absent.`);
  });

  test('Raichu corrects the actual conflicting display association instead of promoting a same-name card', () => {
    const c = card('sv4pt5-19'), a = c.associationReview, f = c.staticCardFace.officialObservation;
    assert.equal(a.oldSourcePageId, '52poke:131134');
    assert.equal(a.oldCandidate.setCode, 'CSM1bC'); assert.equal(a.oldCandidate.number, '045/151');
    assert.equal(a.replacementWikiPageId, '52poke:304465');
    assert.equal(c.candidatePrinting.fullNumberHint, '026/151');
    assert.equal(c.candidatePrinting.catalogCodeHint, '151C');
    assert.equal(f.fields.printedHp, 120); assert.equal(f.fields.abilitiesObserved[0].name, '引雷');
    assert.equal(f.fields.attacks[0].damageOnFace, 180); assert.equal(f.fields.resistance, null);
    assert.equal(f.printedIdentity.regulationMark, 'G');
    assert.equal(a.didNotModifyLegacyLocale, true);
    assert.equal(report.sources[a.oldCandidate.sourceId].classification, 'third-party-conflicting-version-hint');
  });

  test('Pikachu blank damage is not invented zero and only printed static HP is recorded', () => {
    const f = card('sv3pt5-25').staticCardFace.officialObservation;
    assert.equal(f.printedIdentity.number, '025/151'); assert.equal(f.fields.printedHp, 60);
    assert.equal(f.fields.attacks[0].damageOnFace, null);
    assert.equal(f.fields.attacks[0].damageFieldAppearance, 'blank');
    assert.deepEqual(f.fields.attacks[1].cost, ['Lightning', 'Lightning', 'Colorless']);
    assert.equal(f.fields.attacks[1].damageOnFace, 50);
    for (const c of report.cards) for (const key of ['currentHp', 'counters', 'used', 'conditions', 'nextTurnAttackLock'])
      assert.equal(Object.hasOwn(c.staticCardFace, key), false);
  });

  test('official generic energy art cannot prove the old full printing number or turn the MIK G claim into fact', () => {
    const c = card('sve-4'), f = c.staticCardFace.officialObservation;
    assert.equal(c.candidatePrinting.fullNumberHint, '135/052');
    assert.equal(c.candidatePrinting.catalogCodeHint, 'csvL2C');
    assert.equal(c.staticCardFace.metadataHint.regulationMarkClaim, 'G');
    assert.equal(f.candidateIdentityObserved, false); assert.equal(f.printedIdentity, null);
    assert.equal(f.fields.visibleFooterIdentifier, 'LIG');
    assert(f.cannotProve.includes('135/052')); assert(f.cannotProve.includes('candidate-regulation-mark'));
    assert(c.missingEvidence.includes('official-exact-printing-card-face'));
  });

  test('exact campaign hosts now admit evidence syntax without rewriting the historical gap or approving either real card', async () => {
    const schema = JSON.parse(await readFile(new URL('schemas/card-definition.schema.json', root)));
    const pattern = schema.$defs.evidence.properties.url.pattern, followUp = report.integrationReview;
    assert.equal(pattern, CN_OFFICIAL_EVIDENCE_URL_PATTERN);
    assert.equal(followUp.officialEvidenceURLPattern, pattern);
    assert.equal(report.kernelReview.schemaAllowsSpecialCampaignHostAtReview, false);
    assert.equal(followUp.schemaAllowsSpecialCampaignHost, true);
    assert.notEqual(report.kernelReview.officialEvidenceURLPatternAtReview, pattern);
    assert.deepEqual(followUp.sourceHostEvidenceIds, ['primary:pikachu', 'primary:raichu']);
    const fxt = await fixture(), probe = structuredClone(fxt.definitions[0]);
    for (const id of ['sv3pt5-25', 'sv4pt5-19']) {
      const c = card(id), s = report.sources[c.staticCardFace.officialObservation.sourceId];
      assert.equal(new RegExp(report.kernelReview.officialEvidenceURLPatternAtReview).test(s.url), false);
      assert.equal(new RegExp(pattern).test(s.url), true);
      // Only a SYNTHETIC definition probes the syntax; the actual observed card
      // metadata/approval is not converted into an executable definition.
      probe.sourceOfTruth = [{ ...fxt.definitions[0].sourceOfTruth[0], url: s.url }];
      assert.equal(validateCardDefinition(probe), true);
      assert.throws(() => assertExecutableDefinition(probe, { ruleset: report.ruleset, handlers: fxt.handlers }), /independent approval/);
      assert.deepEqual(c.implementationReview.schemaAdmissionGaps, []);
      assert.equal(c.admitted, false); assert.equal(c.independentProductionApproval, false);
    }
    for (const url of ['http://special.pokemon.cn/a', 'https://special.pokemon.cn.evil.example/a',
      'https://evil.example/special.pokemon.cn/a', 'https://user:pass@special.pokemon.cn/a',
      'https://special.pokemon.cn:8443/a', 'https://asia.pokemon-card.com/a']) {
      probe.sourceOfTruth = [{ ...fxt.definitions[0].sourceOfTruth[0], url }];
      assert.equal(new RegExp(pattern).test(url), false);
      assert.equal(validateCardDefinition(probe), false, 'Exact-host admission must not become a suffix or credentials loophole.');
    }
  });

  test('Nemona has an actual observed printing and a supported draw-3 proposal, not a production definition', async () => {
    const c = card('sv1-180'), f = c.staticCardFace.officialObservation, p = c.normalizedCandidateFields;
    assert.equal(f.printedIdentity.number, '055/058'); assert.equal(f.printedIdentity.printedProductToken, 'csvH2C');
    assert.equal(f.fields.drawCount, 3); assert.equal(p.handlerBindingProposal.handlerId, 'cn.draw@1');
    assert.deepEqual(p.handlerBindingProposal.parameters, { count: 3 });
    const handler = createCoreHandlers().get('cn.draw@1');
    assert.equal(handler.validateParameters(p.handlerBindingProposal.parameters), true);
    assert.deepEqual(handler.execute({}, p.handlerBindingProposal.parameters), [{ op: 'draw', count: 3 }]);
    // Existing synthetic fixture probes the primitive. It does NOT approve Nemona.
    const fxt = await fixture((defs) => {
      defs.find((d) => d.definitionId === 'research').mechanics.effects = [binding('cn.draw@1', { count: 3 })];
    });
    let id; const g = board(fxt, (s) => { id = hand(s, 0, 'research'); });
    const before = g.snapshot(), n = before.players[0].hand.length;
    command(g, { type: 'playTrainer', cardId: id }); settle(g);
    assert.equal(g.snapshot().players[0].hand.length, n - 1 + 3);
    assert.equal(g.snapshot().players[0].deck.length, before.players[0].deck.length - 3);
    assert.equal(g.view(0).legalActions.some((a) => a.type === 'playTrainer' && a.cardId === id), false);
    assert.equal(p.intentionallyNotSupplied.includes('implementation-status'), true);
    assert.equal(validateCardDefinition(p), false); assert.equal(c.admitted, false);
  });

  test('Jacq, Great Ball and Nest Ball requirements fit existing typed card-selection parameters', () => {
    const cases = [
      ['sv1-175', { ...baseCards, selector: { kind: 'pokemon', stages: ['stage1', 'stage2'] },
        quantity: { kind: 'upTo', count: 2 } }],
      ['sv2-183', { ...baseCards, lookTop: 7 }],
      ['sv1-181', { ...baseCards, to: 'bench', selector: { kind: 'pokemon', stages: ['basic'] }, reveal: false }],
    ];
    for (const [id, p] of cases) {
      assert.equal(validateCardsParameters(p), true);
      assert(card(id).implementationReview.installedPrimitiveIds.includes('cn.cards@1'));
      assert.equal(card(id).implementationReview.completeCardSupportClaim, false);
    }
  });

  test('obsolete hand/deck approximations stay invalid after dedicated generic window/attachment paths are installed', () => {
    const attach = { ...baseCards, selector: { kind: 'energy', category: 'basic', types: ['Lightning'] },
      to: 'attachedEnergy' };
    assert.equal(validateCardsParameters(attach), false);
    assert.equal(validateCardsParameters({ ...baseCards, lookTop: 4, quantity: { kind: 'exact', count: 2 },
      reveal: false, shuffleAfter: false, remainder: 'randomizeThenDeckBottom' }), false);
    for (const id of ['sv3pt5-25', 'sv1-170'])
      assert(card(id).implementationReview.installedPrimitiveIds.includes('cn.attachDeckEnergy@1'));
    assert(card('sv4-172').implementationReview.installedPrimitiveIds.includes('cn.inspectDeck@1'));
  });

  test('Rika-shaped remainder placement cites actual runtime restoration tests and the pure window module, not whole-card approval', async () => {
    const review = report.integrationReview.deckInspectionRuntimeReview, c = card('sv4-172');
    const handler = createCoreHandlers().get(review.handlerId), parameters = review.parameters;
    assert.equal(review.handlerId, 'cn.inspectDeck@1');
    assert.equal(review.parameterSchemaRef, handler.parameterSchemaRef);
    assert.deepEqual(handler.operations, ['inspectDeck']); assert.equal(handler.validateParameters(parameters), true);
    assert.deepEqual(handler.execute({}, parameters), [parameters]);
    assert.deepEqual(parameters, { op: 'inspectDeck', lookTop: 4, selector: { kind: 'any' },
      quantity: { kind: 'exact', count: 2 }, revealSelected: false, remainder: { mode: 'shuffleToBottom' } });
    assert.equal(review.primarySourceId, c.staticCardFace.officialObservation.sourceId);
    assert.equal(review.runtimeTestPath, 'tests/official-rules/deck-inspection-runtime.test.mjs');
    assert.equal(review.runtimeTestsPassedAtFollowUp, 61);
    assert.equal(review.pureTestPath, 'tests/official-rules/deck-window.test.mjs');
    assert.equal(review.pureModulePath, 'public/rules/deck-window.js');
    assert.deepEqual(review.pureCoverageAtFollowUp, { lines: 100, functions: 100, branches: 100 });
    const fxt = await fixture(), state = board(fxt).snapshot(), before = structuredClone(state);
    const top = state.players[0].deck.slice(-4).reverse(), selected = top.slice(0, 2);
    const plan = planDeckInspection({ state, source: { owner: 0 },
      definitions: Object.fromEntries(fxt.definitions.map((d) => [d.definitionId, d])) }, parameters, selected);
    assert.deepEqual(plan, { window: top, selected, remainder: top.slice(2) }); assert.deepEqual(state, before);
    assert.deepEqual(c.implementationReview.engineCapabilityGaps, []);
    assert.equal(c.implementationReview.status, 'primitives-present-card-integration-unproven');
    assert.equal(c.implementationReview.completeCardSupportClaim, false); assert.equal(c.admitted, false);
    assert.equal(review.notAnApprovedCardBinding, true);
    assert(c.missingEvidence.includes('real-card-semantic-regression-tests'));
  });

  test('tested Generator/Charge paths do not open the officially unresolved no-recipient look/attach/shuffle boundary', async () => {
    const review = report.integrationReview.deckEnergyRuntimeReview, handler = createCoreHandlers().get(review.handlerId);
    assert.equal(review.handlerId, 'cn.attachDeckEnergy@1');
    assert.equal(review.parameterSchemaRef, handler.parameterSchemaRef); assert.deepEqual(handler.operations, ['attachDeckEnergy']);
    assert.equal(review.runtimeTestPath, 'tests/official-rules/deck-energy-runtime.test.mjs');
    assert.equal(review.runtimeTestsPassedAtFollowUp, 11);
    assert.equal(review.pureTestPath, 'tests/official-rules/deck-energy.test.mjs');
    assert.equal(review.pureModulePath, 'public/rules/deck-energy.js');
    assert.deepEqual(review.primarySourceIds, ['primary:electric-generator', 'primary:pikachu']);
    for (const p of [review.generatorParameters, review.chargeParameters]) {
      assert.doesNotThrow(() => assertDeckEnergyAction(p));
      assert.equal(handler.validateParameters(p), true); assert.deepEqual(handler.execute({}, p), [p]);
    }
    const generator = review.generatorParameters, charge = review.chargeParameters;
    assert.equal(generator.lookTop, 5); assert.deepEqual(generator.quantity, { kind: 'upTo', count: 2 });
    assert.deepEqual(generator.recipient, { position: 'bench', selector: { kind: 'pokemon', types: ['Lightning'] } });
    assert.equal(generator.distribution, 'separateRecipients');
    assert.equal(charge.lookTop, null); assert.deepEqual(charge.quantity, { kind: 'exact', count: 1 });
    assert.deepEqual(charge.recipient, { position: 'self', selector: { kind: 'pokemon' } });
    assert.equal(charge.distribution, 'singleRecipient');
    const boundary = report.integrationReview.unresolvedBoundaries[0];
    assert.equal(boundary.officialCNBasisStatus, 'unresolved'); assert.equal(boundary.handlerOpensPath, false);
    assert.equal(boundary.notAnOfficialIllegalityRuling, true);
    assert.equal(boundary.runtimeErrorCode, 'unresolved-deck-energy-receiver'); assert.equal(boundary.pureStatus, 'needsRuling');
    const fxt = await fixture(), state = board(fxt).snapshot(), before = structuredClone(state);
    assert(state.players[0].deck.length > 0); assert.deepEqual(state.players[0].bench, []);
    const ctx = { state, source: { owner: 0, pokemonId: state.players[0].active.id },
      definitions: Object.fromEntries(fxt.definitions.map((d) => [d.definitionId, d])) };
    const window = deckEnergyWindow(ctx, generator);
    assert.equal(window.status, boundary.pureStatus); assert.deepEqual(window.lookedAt, []); assert.deepEqual(window.candidates, []);
    assert.equal(handler.canUse(ctx, generator), false); assert.equal(handler.canUseWithCosts(ctx, generator, []), false);
    assert.deepEqual(state, before, 'The unresolved boundary cannot inspect, attach, shuffle or change RNG.');
    assert.equal(review.notAnApprovedCardBinding, true);
    for (const id of ['sv3pt5-25', 'sv1-170']) {
      const c = card(id); assert.equal(c.implementationReview.completeCardSupportClaim, false);
      assert.equal(c.admitted, false); assert(c.missingEvidence.includes('real-card-semantic-regression-tests'));
    }
  });

  test('the production switch contract is installed, but its real printing, regressions and approvals remain pending', () => {
    const handler = createCoreHandlers().get('cn.switch@1'), c = card('sv1-194');
    const followUp = report.integrationReview, contract = followUp.switchHandlerContract;
    assert.equal(report.kernelReview.coreSwitchHandlerPresentAtReview, false);
    assert.equal(followUp.coreSwitchHandlerPresent, true); assert(handler);
    assert.equal(contract.handlerId, handler.id); assert.equal(contract.implementationVersion, handler.implementationVersion);
    assert.equal(contract.parameterSchemaRef, handler.parameterSchemaRef);
    assert.deepEqual(contract.operations, ['switch']); assert.deepEqual(handler.operations, contract.operations);
    assert.equal(handler.costCheckVersion, contract.costCheckVersion);
    assert.equal(typeof handler.canUse, 'function'); assert.equal(typeof handler.canUseWithCosts, 'function');
    assert.equal(handler.validateParameters(contract.parameters), true);
    assert.deepEqual(handler.execute({}, contract.parameters), [{ op: 'switch', ...contract.parameters }]);
    const ctx = { source: { owner: 0 }, state: { players: [
      { active: { id: 'synthetic-active' }, bench: [{ id: 'synthetic-bench' }] },
    ] } };
    assert.equal(handler.canUse(ctx, contract.parameters), true);
    assert.equal(handler.canUseWithCosts(ctx, contract.parameters, []), true);
    ctx.state.players[0].bench = [];
    assert.equal(handler.canUse(ctx, contract.parameters), false);
    assert.equal(handler.canUseWithCosts(ctx, contract.parameters, []), false);
    assert.equal(contract.notAnApprovedCardBinding, true);
    assert.deepEqual(c.implementationReview.installedPrimitiveIds, ['cn.switch@1']);
    assert.deepEqual(c.implementationReview.engineCapabilityGaps, []);
    assert.equal(c.implementationReview.status, 'primitives-present-evidence-and-card-tests-pending');
    assert.equal(c.staticCardFace.officialObservation, null);
    assert(c.primaryEvidence.some((e) => e.sourceId === 'primary:advanced-pdf'));
    assert(c.missingEvidence.includes('official-exact-printing-card-face'));
    assert(c.missingEvidence.includes('real-card-semantic-regression-tests'));
    assert.equal(c.implementationReview.completeCardSupportClaim, false); assert.equal(c.admitted, false);
  });

  test('Raichu transfer uses one card, not one energy unit or Basic-only discard recovery; real-card integration stays pending', () => {
    const parameters = { op: 'moveEnergy', side: 'own', from: 'event',
      selector: { kind: 'energy' }, providedTypes: ['Lightning'], measure: 'cards',
      quantity: { kind: 'exact', count: 1 }, chooser: 'source',
      recipient: { position: 'self', selector: { kind: 'pokemon' } }, distribution: 'singleRecipient' };
    assert.equal(validateAttachedEnergyParameters(parameters), true);
    assert.equal(validateTriggerDescriptor({ event: 'knockout', subject: 'own', optional: true,
      choiceOwner: 'source', scope: 'global', cause: 'opponentAttackDamage' }), true);
    assert.equal(card('sv4pt5-19').implementationReview.status, 'primitives-present-card-integration-unproven');
    assert.equal(card('sv4pt5-19').implementationReview.completeCardSupportClaim, false);
    const discard = { op: 'discardEnergy', side: 'own', from: 'self', selector: { kind: 'energy' },
      providedTypes: ['Lightning'], measure: 'units', quantity: { kind: 'exact', count: 1 }, chooser: 'source' };
    assert.equal(validateAttachedEnergyParameters(discard), true,
      'Kilowattrel uses one Lightning energy, unlike Raichu’s one Energy card.');
  });

  test('read-only queue has exactly seventeen JSONL rows, explicit next actions, stable filtering and exit 2', async () => {
    const path = fileURLToPath(import.meta.url), before = (await stat(reportURL)).mtimeMs;
    const a = spawnSync(process.execPath, [path, '--queue'], { cwd: tmpdir(), encoding: 'utf8' });
    const b = spawnSync(process.execPath, [path, '--queue'], { cwd: fileURLToPath(root), encoding: 'utf8' });
    assert.equal(a.status, 2, a.stderr); assert.equal(b.status, 2, b.stderr); assert.equal(a.stdout, b.stdout);
    const lines = a.stdout.trim().split('\n').map((s) => JSON.parse(s));
    assert.equal(lines.length, 17); assert.deepEqual(lines.map((l) => l.legacyId), report.cards.map((c) => c.legacyId));
    assert(lines.every((l) => !l.admitted && l.nextStep.action && l.nextStep.inspectCommand));
    assert.deepEqual(lines.find((l) => l.legacyId === 'sv1-194').engineGaps, []);
    assert(lines.every((l) => !l.engineGaps.includes(switchGap) && !l.schemaGaps.includes(hostGap)));
    assert(lines.every((l) => l.engineGaps.length === 0 && l.schemaGaps.length === 0 && l.missingEvidence.length > 0));
    const c = spawnSync(process.execPath, [path, '--queue', '--card', 'sv1-180'], { encoding: 'utf8' });
    assert.equal(c.status, 2); assert.equal(c.stdout.trim().split('\n').length, 1);
    assert.equal(JSON.parse(c.stdout).legacyId, 'sv1-180');
    const unknown = spawnSync(process.execPath, [path, '--queue', '--card', 'not-a-card'], { encoding: 'utf8' });
    assert.equal(unknown.status, 1);
    assert.deepEqual(await readFile(reportURL), reportBytes); assert.equal((await stat(reportURL)).mtimeMs, before);
  });

  test('card review: a reading confirms a text source only when both quote the same names (scripts/card_review.py same_meaning, decide_text)', () => {
    // 振翼发 CSV7C 109/204: 52Poké's text names 「暗夜羽击」; the card and both whole-card readings print 「暗夜振翼」.
    const zhenyi = '只要这只宝可梦在战斗场上，对手战斗宝可梦的特性（除「暗夜振翼」外），全部消除。';
    const yuji = '只要这只宝可梦在战斗场上，对手的战斗宝可梦的特性（「暗夜羽击」除外）全部消除。';
    const reworded = '只要这只宝可梦在战斗场上，对手的战斗宝可梦的特性（「暗夜振翼」除外）全部消除。';
    const heal = '选择自己牌库中的1张卡牌，加入手牌。回复这只宝可梦「20」HP。';
    const spike = '在下一个自己的回合，这只宝可梦的「旋压尖刺」的伤害「+100」。';
    const songs = '在这个回合，如果从手牌使出了「小菘」的话，则追加造成130点伤害。';
    const meaning = [
      [yuji, zhenyi, false], // another name inside 「」
      [reworded, zhenyi, true], // other wording, the same name
      [heal, heal.replace('「20」', '20'), true], // a number quoted or not
      [spike, spike.replace('「旋压尖刺」', '“旋压尖刺”').replace('「+100」', '+100'), true], // curly quotes, an unquoted number
      [spike, spike.replace('「旋压尖刺」', '“施压尖刺”'), false],
      [heal, heal.replace('20', '30'), false], // numbers are still compared
      // MIK quotes a term the card prints plainly: the name is there, quoted or not.
      ['对手场上的【基础】宝可梦（除「拥有规则的宝可梦」外）的特性，全部消除。', '对手场上的基础宝可梦（除拥有规则的宝可梦外）的特性，全部消除。', true],
      [songs, songs.replace('小菘', '小霞'), false],
      ['如果将自己手牌中的1张「祭典乐舞」放于弃牌区的话，则可使用1次。', '如果将自己手牌中的1张「祭典□舞」放于弃牌区的话，则可使用1次。', false], // unreadable
    ];
    // decide_text(source, astra, sol): one reading equal to the source confirms it only if the other quotes the same names.
    const decide = [
      [songs, songs, songs.replace('小菘', '小霞'), [false, null]],
      [songs, songs, songs.replace('点伤害', '伤害'), [true, 'text-confirmed-by-astra']],
      [yuji, zhenyi, zhenyi, [false, null]],
      [reworded, zhenyi, zhenyi, [true, 'text-same-meaning']],
    ];
    const py = 'import json, sys; sys.path.insert(0, "scripts"); import card_review as c\n'
      + 'm, d = json.load(sys.stdin)\n'
      + 'n = c.norm_text\n'
      + 'print(json.dumps([[[c.same_meaning(a, b), c.same_meaning(b, a)] for a, b, _ in m],\n'
      + '  [list(c.decide_text({"astra-full": n(x), "sol-full": n(y)}, n(r), {"ref": r, "astra-full": x, "sol-full": y})) for r, x, y, _ in d]]))';
    const run = spawnSync('python3', ['-c', py], { cwd: root, input: JSON.stringify([meaning, decide]), encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const [same, decided] = JSON.parse(run.stdout);
    assert.deepEqual(same, meaning.map(([, , want]) => [want, want]));
    assert.deepEqual(decided, decide.map(([, , , want]) => want));
  });
}
