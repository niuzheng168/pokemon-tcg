// The card pool a player browses and builds decks from: every card of the card library (library_v1, ~13,700
// Simplified Chinese cards, served by the account server at /api/library), joined with the rules catalog. A card the
// catalog has a printing for can be played; the others are shown and can be put in a saved list, but a deck can only
// be played once every card in it is implemented. Shared by the pages (library.js, decks.js) and the server.
//   library entry (server/library.mjs): {id, name, kind, setCode, setName, number, series, releasedOn, mark, rarity,
//     illustrator, stage, types, hp, evolvesFrom, weakness, resistance, retreat, attacks, abilities, text, rule,
//     category, mechanic, labels, review, image, thumb}
// A card's id is its printing id (zh-Hans:<set>:<number>), the id the catalog gives the same printing.
import { CN_FORMATS_V20261019 } from './rules/zh-CN/formats/V20261019.js';
import { implementationTier } from './card-quality.js';

export const ACE_SPEC = 'cn-ace-spec';
export const RADIANT = 'cn-radiant';
export const GROUP_NAMES = { [ACE_SPEC]: 'ACE SPEC 卡', [RADIANT]: '光辉宝可梦' };
const FORMATS = Object.fromEntries(CN_FORMATS_V20261019.map((f) => [f.id, f]));
const OLD_SERIES = ['sun-moon', 'sword-shield'];

// The same-name rule compares printed names.
export const nameKeyOf = (name) => name.replace(/\s+/g, '');
const basicEnergy = (c) => c.kind === 'energy' && c.category === 'basic';

// Deck limits of a card the catalog does not have yet, from its printed rules: ACE SPEC and Radiant Pokémon are 1 per
// deck, a Prism Star card 1 per name, basic Energy unlimited.
function printedLimits(c) {
  const groups = [];
  if (c.mechanic === 'ACE SPEC' || /ACE SPEC/.test(c.rule)) groups.push({ key: ACE_SPEC, maximum: 1 });
  if (c.mechanic === 'Radiant') groups.push({ key: RADIANT, maximum: 1 });
  return { limit: basicEnergy(c) ? null : c.mechanic === 'Prism Star' ? 1 : 4, groups };
}

// Which formats a card the catalog does not have yet would be legal in, by the format's printed pool rules (the kernel's
// formats.js inBasePool and banned list); a hint only — the kernel decides once the card is implemented.
export function printedLegality(c) {
  const out = {};
  for (const [id, f] of Object.entries(FORMATS)) {
    const dated = /^\d{4}-\d{2}-\d{2}$/.test(c.releasedOn ?? '') && c.releasedOn <= f.snapshotOn;
    const banned = (f.bannedCards ?? []).some((b) => b.kind === c.kind && b.name === c.name
      && (!b.abilityName || c.abilities.some((a) => a.name === b.abilityName)));
    let inPool;
    if (basicEnergy(c)) inPool = c.types.some((x) => f.basicEnergyTypes.includes(x));
    else if (id === 'standard') inPool = f.regulationMarks.includes(c.mark) || (OLD_SERIES.includes(c.series) && f.latestTextNames.includes(c.name));
    else inPool = f.series.includes(c.series) || (c.setCode === '30thC' && c.mark !== null) || c.setCode === '30thDC';
    out[id] = (basicEnergy(c) || dated) && inPool && !banned;
  }
  return out;
}

export const FEATURES = {
  ex: '宝可梦ex', V: '宝可梦V', GX: 'GX', 'TAG TEAM': 'TAG TEAM', EX: '宝可梦EX', Radiant: '光辉', 'Prism Star': '棱镜之星◇',
  acespec: 'ACE SPEC', ability: '有特性', Ancient: '古代', Future: '未来', Tera: '太晶', 'Single Strike': '一击',
  'Rapid Strike': '连击', 'Fusion Strike': '融合', 'Ultra Beast': '究极异兽',
};

function featuresOf(c) {
  const labels = new Set([...c.labels, c.mechanic].filter(Boolean));
  return Object.keys(FEATURES).filter((f) => (f === 'acespec' ? c.groups.some((g) => g.key === ACE_SPEC)
    : f === 'ability' ? c.abilities.length > 0 : f === 'Tera' ? labels.has('Tera') || /太晶/.test(c.rule) : labels.has(f)));
}

/**
 * The pool: one card per library entry, joined with the catalog: {...entry, nameKey, implemented, limit, groups,
 * legal: {standard, open}, features, skills, search (lower case)}. `legality` is deck-check.js printingLegality(catalog), the
 * kernel's own answer for the printings it has.
 */
export function buildPool(library, catalog, legality) {
  const printings = new Set(catalog.printings().map((p) => p.printingId));
  const cards = library.map((e) => {
    const c = { ...e, nameKey: nameKeyOf(e.name), implemented: printings.has(e.id), implementation: implementationTier(catalog, e.id) };
    if (c.implemented) {
      const d = catalog.definitionFor(e.id);
      Object.assign(c, { limit: d.deckLimits.sameName, groups: d.deckLimits.groups.map(({ key, maximum }) => ({ key, maximum })),
        legal: { ...legality.get(e.id) } });
      if (d.kind === 'pokemon' && d.mechanics.tags?.includes('ex') && !c.labels.includes('ex') && c.mechanic !== 'ex') c.mechanic = 'ex';
    } else {
      Object.assign(c, printedLimits(c), { legal: printedLegality(c) });
    }
    c.features = featuresOf(c);
    c.skills = [...c.abilities.map((a) => ({ ...a, ability: true })), ...c.attacks];
    c.search = [c.name, ...c.skills.flatMap((s) => [s.name, s.text]), c.text, c.rule, c.setCode, c.setName, c.number].join('\n').toLowerCase();
    return c;
  });
  return { cards, byId: new Map(cards.map((c) => [c.id, c])) };
}
