// Rule identity is independent of UI language, card language and tournament format.
// Entries are snapshots of a reviewed ruleset, never aliases for a changing "latest".
// The official 151 campaign serves original CN card faces on its own subdomain.
// Host admission permits citing evidence; it never approves a card or printing.
export const CN_OFFICIAL_SOURCE_HOSTS = Object.freeze(['www.pokemon.cn', 'image.pokemon.com.cn', 'special.pokemon.cn']);
// Rulings of the same game by its Japanese publisher (株式会社ポケモン), cited only where the simplified-Chinese
// documents are silent (documents marked supplementary). Never card evidence.
export const SUPPLEMENTARY_RULING_SOURCE_HOSTS = Object.freeze(['www.pokemon-card.com']);
export const CN_OFFICIAL_EVIDENCE_URL_PATTERN = `^https://(${CN_OFFICIAL_SOURCE_HOSTS.map((host) => host.replaceAll('.', '\\.')).join('|')})/`;
// A machine-implemented card's own record (card-definition.schema.json $defs/libraryEvidence): its MIK, else 52Poké page.
export const CN_CARD_LIBRARY_EVIDENCE_URL_PATTERN = '^https://(tcg\\.mik\\.moe|wiki\\.52poke\\.com)/';

export const approvedSourceHosts = (document) => document.supplementary === true ? SUPPLEMENTARY_RULING_SOURCE_HOSTS : CN_OFFICIAL_SOURCE_HOSTS;

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

export class RuleViolation extends Error {
  constructor(rule, message, details = {}) {
    super(message);
    this.name = 'RuleViolation';
    this.ruleId = rule.id;
    this.sourceOfTruth = rule.sourceOfTruth;
    this.details = details;
  }
}

export function createRuleset({ region, version, reviewedOn, documents, rules }) {
  if (!/^[A-Z]{2}$/.test(region) || !/^V\d{8}$/.test(version))
    throw new TypeError('A ruleset needs an explicit region and dated version.');
  const documentIds = new Set();
  for (const document of documents) {
    if (documentIds.has(document.id)) throw new TypeError(`Duplicate document: ${document.id}`);
    documentIds.add(document.id);
    if (!document.title || !document.url || !document.authority || !document.evidence)
      throw new TypeError(`Incomplete source of truth: ${document.id}`);
    const url = new URL(document.url);
    if (Object.hasOwn(document, 'supplementary') && document.supplementary !== true)
      throw new TypeError(`Supplementary is an explicit true marker: ${document.id}`);
    if (url.protocol !== 'https:' || !approvedSourceHosts(document).includes(url.hostname) || url.username || url.password || url.port)
      throw new TypeError(`Not an approved ${document.supplementary ? 'supplementary official ruling' : 'simplified-Chinese official'} source: ${document.url}`);
    if (document.sha256 !== null && !/^[a-f0-9]{64}$/.test(document.sha256))
      throw new TypeError(`Invalid document fingerprint: ${document.id}`);
    if (document.evidence.binaryVerification === 'verified' &&
        (!document.sha256 || !Number.isSafeInteger(document.byteLength) || document.byteLength < 1))
      throw new TypeError(`Verified document needs its actual fingerprint and byte length: ${document.id}`);
  }
  const byId = Object.create(null);
  for (const rule of rules) {
    if (byId[rule.id]) throw new TypeError(`Duplicate rule: ${rule.id}`);
    if (!rule.summary || !rule.sourceOfTruth?.length) throw new TypeError(`Unsourced rule: ${rule.id}`);
    for (const reference of rule.sourceOfTruth) {
      if (!documentIds.has(reference.documentId) || !reference.section)
        throw new TypeError(`Unknown source or section: ${rule.id}`);
      const document = documents.find((d) => d.id === reference.documentId);
      if (reference.pdfPages && (!Number.isInteger(document.pages) || !reference.pdfPages.length || reference.pdfPages.some(
        (page) => !Number.isInteger(page) || page < 1 ||
          page > document.pages,
      ))) throw new TypeError(`Invalid PDF page reference: ${rule.id}`);
    }
    // A supplementary ruling only settles what a cited simplified-Chinese clause leaves open; it is never the sole source.
    if (rule.sourceOfTruth.every((reference) => documents.find((d) => d.id === reference.documentId).supplementary === true))
      throw new TypeError(`Rule needs a simplified-Chinese primary source: ${rule.id}`);
    byId[rule.id] = rule;
  }
  return deepFreeze(structuredClone({ id: `${region}/${version}`, region, version, reviewedOn, documents, rules: byId }));
}

export function requireRule(ruleset, id) {
  if (!Object.hasOwn(ruleset.rules, id)) throw new TypeError(`Unknown rule: ${ruleset.id}/${id}`);
  return ruleset.rules[id];
}

export function violation(ruleset, id, message, details) {
  return new RuleViolation(requireRule(ruleset, id), message, details);
}

export function ruleTrace(ruleset, id, details = {}) {
  const rule = requireRule(ruleset, id);
  return deepFreeze({ ...structuredClone(details), rulesetId: ruleset.id, ruleId: id, sourceOfTruth: rule.sourceOfTruth });
}
