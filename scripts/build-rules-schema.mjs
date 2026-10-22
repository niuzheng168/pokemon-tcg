// Compile at build time; runtime validation is offline and does not use eval/Ajv.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import standalone from 'ajv/dist/standalone/index.js';
import { transform, build } from 'esbuild';
import { CN_OFFICIAL_EVIDENCE_URL_PATTERN, CN_CARD_LIBRARY_EVIDENCE_URL_PATTERN } from '../public/rules/registry.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['card-definition', 'card-printing', 'game-command', 'game-state', 'handler-parameters', 'effect-program', 'trigger', 'card-selector', 'activation-cost', 'energy-mechanics', 'evolution', 'field-return', 'attack-copy', 'attack-grant', 'catalog-release', 'format', 'attack-failure', 'battle-history', 'checkup-effects', 'attack-commitments', 'deck-window', 'deck-energy', 'pokemon-types', 'prize-count', 'battle-value', 'battle-predicate', 'damage-coins', 'prize-exchange', 'hand-bottom', 'healing', 'effect-execution', 'counter-distribution', 'selection-request', 'field-cards', 'owned-attack-lock', 'catalog-manifest', 'catalog-shard', 'catalog-index'];
const schemas = await Promise.all(files.map(async (name) =>
  JSON.parse(await readFile(new URL(`../schemas/${name}.schema.json`, import.meta.url), 'utf8'))));
// Every evidence list refers to card-definition's official and library evidence (checkup effects and Pokémon types too).
if (schemas[0].$defs.evidence.properties.url.pattern !== CN_OFFICIAL_EVIDENCE_URL_PATTERN ||
    schemas[0].$defs.libraryEvidence.properties.url.pattern !== CN_CARD_LIBRARY_EVIDENCE_URL_PATTERN)
  throw new Error('Evidence URL schemas must match the reviewed exact-host policy.');
const ajv = new Ajv2020({ strict: true, allErrors: true, inlineRefs: false, code: { source: true, esm: true } });
schemas.forEach((schema) => ajv.addSchema(schema));
const exports = {
  validateCounterDistributionAction: schemas[31].$id,
  validateCounterAllocation: `${schemas[31].$id}#/$defs/allocations`,
  validateCounterChoice: `${schemas[3].$id}#/$defs/counterChoice`,
  validatePokemonHealingAction: schemas[29].$id,
  validateHealingChoice: `${schemas[3].$id}#/$defs/healingChoice`,
  validatePrizeExchangeAction: schemas[27].$id,
  validatePrizeExchangeEvent: `${schemas[27].$id}#/$defs/event`,
  validateHandBottomAction: schemas[28].$id,
  validateTrainerFinish: `${schemas[3].$id}#/$defs/trainerFinish`,
  validateDamageCoinSpec: schemas[26].$id,
  validateDamageCoinReceipt: `${schemas[26].$id}#/$defs/receipt`,
  validateDamageRollPlans: `${schemas[5].$id}#/$defs/damageRollPlans`,
  validateBattleValue: schemas[24].$id,
  validateBattlePredicate: schemas[25].$id,
  validatePrizeCountQuery: schemas[23].$id,
  validatePrizeCountResult: `${schemas[23].$id}#/$defs/result`,
  validatePokemonTypesEffect: schemas[22].$id,
  validateDeckInspectionAction: schemas[20].$id,
  validateDeckInspectionPlan: `${schemas[20].$id}#/$defs/plan`,
  validateDeckEnergyAction: schemas[21].$id,
  validateDeckEnergyPlan: `${schemas[21].$id}#/$defs/plan`,
  validateAttackPaymentChoice: `${schemas[16].$id}#/$defs/paymentChoice`,
  validateAttackPaymentReceipt: `${schemas[16].$id}#/$defs/paymentReceipt`,
  validateBattleHistory: schemas[17].$id,
  validateFailureCoin: `${schemas[16].$id}#/$defs/coin`,
  validateFailureReceipt: `${schemas[16].$id}#/$defs/receipt`,
  validateFormatReference: schemas[15].$id,
  validateCardSelector: schemas[7].$id,
  validateActivationCosts: schemas[8].$id,
  validatePaymentReceipt: `${schemas[8].$id}#/$defs/receipt`,
  validateEnergyRequirementEffect: `${schemas[9].$id}#/$defs/requirement`,
  validateEnergyProvisionEffect: `${schemas[9].$id}#/$defs/provision`,
  validateEnergyOption: `${schemas[9].$id}#/$defs/option`,
  validateAttackGrantEffect: schemas[13].$id,
  validateCatalogRelease: schemas[14].$id,
  // Emit the recursive program root before its dependents. With Ajv 8 standalone
  // emission a dependent-first traversal can emit the recursive root twice.
  validateEffectProgram: schemas[5].$id,
  validateOwnedAttackLockAction: schemas[34].$id,
  validateOwnedAttackChoice: `${schemas[3].$id}#/$defs/ownedAttackChoice`,
  validateOwnedAttackLockEvent: `${schemas[3].$id}#/$defs/ownedAttackLockEvent`,
  validateOwnedAttackLockClearEvent: `${schemas[3].$id}#/$defs/ownedAttackLockClearEvent`,
  validateEffectExecutionEvent: schemas[30].$id,
  validateSelectionRequestEvent: schemas[32].$id,
  validateDiscardStadiumAction: schemas[33].$id,
  validateStadiumProtection: `${schemas[33].$id}#/$defs/protection`,
  validatePrismStarRule: `${schemas[0].$id}#/$defs/prismStarRule`,
  validateCardDefinition: schemas[0].$id,
  validateAbilityUsage: `${schemas[0].$id}#/$defs/ability/properties/usage`,
  validateCardPrinting: schemas[1].$id,
  validateGameCommand: schemas[2].$id,
  validateGameState: schemas[3].$id,
  validateEffectStep: `${schemas[5].$id}#/$defs/step`,
  validateEffectResolution: `${schemas[5].$id}#/$defs/resolution`,
  validateContinuousEffect: `${schemas[5].$id}#/$defs/continuous`,
  validateOngoingEffect: `${schemas[5].$id}#/$defs/ongoing`,
  validatePlayerOngoingEffect: `${schemas[5].$id}#/$defs/playerOngoing`,
  validateSuppressionEffect: `${schemas[5].$id}#/$defs/suppression`,
  validateEntryContext: `${schemas[3].$id}#/$defs/entryContext`,
  validateEntryWindow: `${schemas[3].$id}#/$defs/entryWindow`,
  validateEntryUse: `${schemas[3].$id}#/$defs/entryUse`,
  validateEntryFinish: `${schemas[3].$id}#/$defs/entryFinish`,
  validateDrawTask: `${schemas[3].$id}#/$defs/drawTask`,
  validateActivationRequest: `${schemas[3].$id}#/$defs/activationRequest`,
  validateActivationChoice: `${schemas[3].$id}#/$defs/activationChoice`,
  validatePromotionChoice: `${schemas[3].$id}#/$defs/promotionChoice`,
  validateTriggerDescriptor: `${schemas[6].$id}#/$defs/descriptor`,
  validateAcquisitionDescriptor: `${schemas[6].$id}#/$defs/acquisitionDescriptor`,
  validateTriggerEvent: `${schemas[6].$id}#/$defs/event`,
  validateTriggerUnit: `${schemas[6].$id}#/$defs/unit`,
  validateTriggerWindow: `${schemas[6].$id}#/$defs/window`,
  validateTriggerActivation: `${schemas[6].$id}#/$defs/activation`,
  validateCheckupPlan: `${schemas[6].$id}#/$defs/checkupPlan`,
};
for (const name of ['draw', 'empty', 'counters', 'heal', 'condition', 'modifier', 'permissions', 'attachDiscard',
  'protection', 'property', 'damageOptions', 'transferCounters', 'lasting', 'damage', 'restriction', 'playerRestriction', 'lastingPlayer', 'delayedReaction', 'suppression', 'cards', 'shuffle', 'attachIncoming', 'energyRequirement', 'energyProvision', 'energyOptions', 'attachedEnergy', 'pokemonTransition', 'fieldReturn', 'copyAttack', 'attackGrant', 'burnCounters', 'switch', 'inspectDeck', 'attachDeckEnergy', 'pokemonTypes', 'prizeDamage', 'damageValue', 'prizeExchange', 'shuffleHandToBottom', 'handBottomDraw', 'handDeckDraw', 'drawPokemonCount', 'drawValue', 'cardsThenDraw', 'countedEnergyDiscard', 'discardTools', 'countedCards', 'opponentHand', 'opponentHandLook', 'arrangeDeck', 'cure', 'optionalCounted', 'coins', 'coinResult', 'when', 'coin', 'optional', 'orElse', 'then', 'discardDeckTop', 'attachThenDraw', 'replacePokemon', 'benchLimit', 'knockOut', 'stadiumUse', 'pokemonHealing', 'counterDistribution', 'discardStadium', 'stadiumProtection', 'ownedAttackLock'])
  exports[`validate${name[0].toUpperCase()}${name.slice(1)}Parameters`] = `${schemas[4].$id}#/$defs/${name}`;
// Append new transport validators: preserve the established runtime validator
// traversal order to avoid needless generated-code churn.
Object.assign(exports, {
  validateEvidenceRef: `${schemas[0].$id}#/$defs/evidenceRef`,
  validateCardEvidence: `${schemas[0].$id}#/$defs/cardEvidenceList/items`,
  validateCatalogManifest: schemas[35].$id,
  validateCatalogShard: schemas[36].$id,
  validateCatalogIndex: schemas[37].$id,
});
const code = standalone(ajv, exports);
// Bundle runtime helpers so browser/offline modules need no node_modules.
// Ajv's default equality helper compares JS constructors and invokes valueOf;
// the JSON protocol instead needs own-data structural equality, including
// null-prototype copies made by the strict descriptor validators.
const bundled = await build({
  stdin: { contents: code, resolveDir: root, sourcefile: 'rules-schema-generated.js' },
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', minify: true,
  plugins: [{
    name: 'strict-json-const-equality',
    setup(build) {
      build.onResolve({ filter: /^ajv\/dist\/runtime\/equal$/ }, () => ({
        path: join(root, 'public/rules/json-equal.js'),
      }));
    },
  }],
  legalComments: 'inline', logLevel: 'silent',
});
const formatted = await transform(bundled.outputFiles[0].text, { format: 'esm', target: 'es2022' });
const hash = createHash('sha256').update(JSON.stringify(schemas)).digest('hex');
const output = `// Generated by scripts/build-rules-schema.mjs. Do not edit.\n// Schema SHA-256: ${hash}\n// Runtime helper licenses: ./THIRD_PARTY_NOTICES.txt\n${formatted.code}`;
const target = new URL('../public/rules/schema-validators.js', import.meta.url);
const require = createRequire(import.meta.url);
const ajvDirectory = dirname(require.resolve('ajv/package.json'));
const equalDirectory = dirname(require.resolve('fast-deep-equal/package.json', { paths: [ajvDirectory] }));
const notices = `Schema validator dependencies:\n\nAjv (bundled runtime helpers and build-time compiler)\n${await readFile(join(ajvDirectory, 'LICENSE'), 'utf8')}\n\nfast-deep-equal (Ajv build dependency; runtime JSON equality is the project's json-equal.js)\n${await readFile(join(equalDirectory, 'LICENSE'), 'utf8')}`;
const noticeTarget = new URL('../public/rules/THIRD_PARTY_NOTICES.txt', import.meta.url);
if (process.argv.includes('--check')) {
  if (await readFile(target, 'utf8').catch(() => '') !== output ||
      await readFile(noticeTarget, 'utf8').catch(() => '') !== notices)
    throw new Error('Schema validators are stale. Run npm run rules:schema.');
  console.log(`Official card schema validators match ${hash}.`);
} else {
  await writeFile(target, output);
  await writeFile(noticeTarget, notices);
  console.log(`Generated offline card schema validators (${hash}).`);
}
