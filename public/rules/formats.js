import { validateFormatReference } from './schema-validators.js';
import { assertCatalog, validateDeck } from './catalog.js';
import { violation, ruleTrace } from './registry.js';
import { CN_FORMATS_V20261019 } from './zh-CN/formats/V20261019.js';

const key = ({ region, version, id }) => `${region}/${version}/${id}`;
const formats = new Map(CN_FORMATS_V20261019.map((f) => [key(f), f]));
const oldSeries = ['sun-moon', 'sword-shield'];
const basicEnergy = (d) => d.kind === 'energy' && d.mechanics.category === 'basic';
const dateIsValid = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) &&
  new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;

export function getFormat(reference) {
  if (!validateFormatReference(reference) || !formats.has(key(reference)))
    throw new RangeError('Unsupported format: an exact region/version/id is required; no latest or locale fallback.');
  return formats.get(key(reference));
}

export function listFormats() {
  return [...formats.values()];
}

export function assertMatchFormat(catalog, reference, matchMode) {
  assertCatalog(catalog);
  if (!['normal', 'tiebreak'].includes(matchMode) || (reference === 'tiebreak60' && matchMode !== 'tiebreak'))
    throw new RangeError('Unsupported format / match mode combination.');
  // Compatibility aliases are explicitly developer pools, NOT official Standard/Open.
  if (reference === 'casual60' || reference === 'tiebreak60') return null;
  if (`${reference?.region}/${reference?.version}` !== catalog.ruleset.id)
    throw new RangeError('The selected format is incompatible with this rules version.');
  return getFormat(reference);
}

function isBanned(format, definition) {
  return (format.bannedCards || []).some((b) => definition.kind === b.kind && definition.name === b.name &&
    (!b.abilityName || definition.mechanics.abilities.some((a) => a.name === b.abilityName)));
}

function inBasePool(format, printing, definition) {
  // Standard's eight-type exception must not accidentally admit Fairy via a mark.
  if (basicEnergy(definition)) return format.basicEnergyTypes.includes(definition.mechanics.baseUnits[0][0]);
  if (format.id === 'standard') return format.regulationMarks.includes(printing.regulationMark);
  return format.series.includes(printing.series) ||
    (printing.setCode === '30thC' && printing.regulationMark !== null) ||
    printing.setCode === '30thDC' ||
    (printing.setCode === 'PROMO' && /^\d{3}\/30th-P$/.test(printing.number));
}

/** A supported pool is NOT a complete production catalog or an official certification. */
export function validateFormatDeck(catalog, printingIds, reference, matchMode = 'normal') {
  const format = assertMatchFormat(catalog, reference, matchMode);
  const definitions = validateDeck(catalog, printingIds);
  if (!format) return definitions;
  const fail = (printing, reason, message) => {
    throw violation(catalog.ruleset, format.ruleId, message, { format: key(format), printingId: printing.printingId, reason });
  };
  const reviewPrinting = (printing) => {
    if (!printing.series || !dateIsValid(printing.releasedOn) || printing.releasedOn > format.snapshotOn)
      fail(printing, 'printing-review-required', 'Official pool admission needs a reviewed series and valid release date within this fixed snapshot.');
  };
  printingIds.forEach((id, index) => {
    const printing = catalog.printing(id), d = definitions[index];
    reviewPrinting(printing);
    if (isBanned(format, d)) fail(printing, 'banned', 'This card/printed Ability combination is excluded from the selected official pool.');
    const latestText = !basicEnergy(d) && oldSeries.includes(printing.series) && format.latestTextNames.includes(d.name);
    if (!inBasePool(format, printing, d) && !(format.id === 'standard' && latestText))
      fail(printing, 'outside-pool', 'Printing is outside the selected versioned card pool.');
    if (!latestText) return;
    const reviews = (printing.formatReviews || []).filter((r) => key(r.format) === key(format));
    if (reviews.length !== 1 || !reviews[0].sourceOfTruth.some((s) => ['official-card', 'official-erratum'].includes(s.kind)))
      fail(printing, 'latest-text-review-required', 'Old-series listed cards need one independently approved, card-specific latest-text equivalence review.');
    const anchor = catalog.printings().find((p) => p.printingId === reviews[0].latestPrintingId);
    if (!anchor) fail(printing, 'latest-printing-missing', 'The reviewed latest printing must be included in the approved catalog, not necessarily the deck.');
    reviewPrinting(anchor);
    const current = catalog.definitionFor(anchor.printingId);
    if (current.definitionId !== d.definitionId || !inBasePool(format, anchor, current) || isBanned(format, current))
      fail(printing, 'latest-printing-mismatch', 'Old and latest printings must resolve to the same reviewed current definition and a legal anchor printing.');
  });
  return definitions;
}

export function formatTrace(catalog, reference, matchMode = 'normal') {
  const format = assertMatchFormat(catalog, reference, matchMode);
  return format ? ruleTrace(catalog.ruleset, format.ruleId, { formatId: key(format) }) : null;
}
