// Machine-tier card data for CN/V20261019: CardDefinitions with implementation.tier 'machine' and CardPrintings with
// identityReview 'machine', built from the machine card review of the card library (scripts/card_review.py →
// .data/card-review/review.jsonl) by scripts/build-machine-catalog.mjs — not from a hand review of each card. Their
// evidence is the library record: its MIK card page, else its 52Poké page. Kept apart from the reviewed modules.
import { createHash } from 'node:crypto';
import { RULESET, type, ruleBoxMechanics } from './common.mjs';

export const MACHINE_TEST_IDS = Object.freeze(['tests/cn-cards/machine.test.mjs']);
const LOCATOR = '卡面各字段由两个视觉模型读本机卡图，与 MIK、52Poké 文字逐字段核对（机器实现，未经人工逐张审核）';

// The library's and the readers' type spellings → the printed glyph: MIK letters, 52Poké and older names.
const GLYPHS = { G: '草', R: '火', W: '水', L: '雷', P: '超', F: '斗', D: '恶', M: '钢', N: '龙', Y: '妖', C: '无',
  电: '雷', 闘: '斗', 悪: '恶', 妖精: '妖', 无色: '无', 一般: '无' };
export const glyph = (t) => {
  const g = String(t ?? '').replace(/[【】]/g, '');
  return GLYPHS[g] ?? g;
};
export const energyType = (t) => type(glyph(t));
export const costGlyphs = (cost) => (typeof cost === 'string' ? [...cost].filter((c) => c !== '0') : cost ?? [])
  .filter((c) => c !== '+').map(glyph).join('');

// One library record's evidence: { dir: 'CSV1C/107_127', mik: 'CSV1C/107' | null, wikiId: '21712' | null, official: product
// page URL | null } — its MIK card page, else its 52Poké page, else (four promos) the official product page it cites.
export function libraryEvidence({ dir, mik, wikiId, official }) {
  const locator = `library_v1 zh-Hans/${dir}：${LOCATOR}`;
  if (mik || wikiId) return [{ sourceId: `library:${dir}`, kind: 'card-library', locator,
    url: mik ? `https://tcg.mik.moe/cards/${mik}` : `https://wiki.52poke.com/index.php?curid=${wikiId}` }];
  if (official) return [{ sourceId: `library:${dir}`, kind: 'official-card', url: official, locator }];
  throw new TypeError(`${dir}: no MIK, 52Poké or official page to cite.`);
}

// 「×2」 multiplies, 「+20」 adds (older printings).
export function weakness(w) {
  if (!w || !(w.type || w.energy)) return null;
  const v = String(w.value ?? '').normalize('NFKC').replace(/\s/g, '');
  const m = /^[×xX](\d+)$/.exec(v) ?? /^(\+)(\d+)$/.exec(v);
  if (!m) throw new TypeError(`Unreadable Weakness value: ${w.value}`);
  return m[1] === '+' ? { type: energyType(w.type ?? w.energy), operation: 'add', value: Number(m[2]) }
    : { type: energyType(w.type ?? w.energy), operation: 'multiply', value: Number(m[1]) };
}
export function resistance(r) {
  if (!r || !(r.type || r.energy)) return null;
  const m = /^-(\d+)$/.exec(String(r.value ?? '').normalize('NFKC').replace(/\s/g, ''));
  if (!m) throw new TypeError(`Unreadable Resistance value: ${r.value}`);
  return { type: energyType(r.type ?? r.energy), value: Number(m[1]) };
}

const definition = (id, face, kind, evidence, mechanics, deckLimits = { sameName: 4, groups: [] }) => ({
  schemaVersion: '1.0.0', definitionId: id, ruleset: { ...RULESET }, name: face.name, nameKey: face.nameKey, kind,
  sourceOfTruth: evidence, implementation: { status: 'verified', testIds: [...MACHINE_TEST_IDS], tier: 'machine' }, deckLimits, mechanics,
});
const RADIANT_GROUP = 'cn-radiant';

// face: { name, nameKey, stage ('basic'|'stage1'|'stage2'|'VMAX'|'VSTAR'), evolvesFrom (name key|null), basicAncestor (name
// key, Stage 2 only), hp, type (glyph), weakness, resistance (as printed), retreat, ruleBox (RULE_BOXES key|null), tags,
// attacks: [{ name, cost (glyphs), damage (number|null) }] } — Pokémon whose attacks only deal their printed damage.
export function machinePokemon(id, face, evidence) {
  const groups = face.ruleBox === 'Radiant' ? [{ key: RADIANT_GROUP, maximum: 1, sourceOfTruth: evidence }] : [];
  return definition(id, face, 'pokemon', evidence, {
    stage: face.stage, evolvesFrom: face.evolvesFrom ?? null,
    ...(face.basicAncestor ? { basicAncestor: { nameKey: face.basicAncestor, sourceOfTruth: evidence } } : {}),
    hp: face.hp, types: [type(face.type)], weakness: weakness(face.weakness), resistance: resistance(face.resistance),
    retreatCost: face.retreat,
    attacks: face.attacks.map((a, i) => ({
      attackId: `${id}:a${i + 1}`, name: a.name, cost: [...a.cost].map(type),
      printedDamage: a.damage === null ? null : { value: a.damage, operator: 'fixed' }, effects: [], sourceOfTruth: evidence,
    })),
    abilities: [], ...ruleBoxMechanics(face.ruleBox, face.tags), effects: [],
  }, { sameName: 4, groups });
}

export function machineBasicEnergy(id, face, evidence) {
  return definition(id, face, 'energy', evidence, { category: 'basic', baseUnits: [[type(face.type)]], effects: [] },
    { sameName: null, groups: [] });
}

// card: { printingId, setCode, number, mark, series, releasedOn, dir, imageSha256 }.
export function machinePrinting(card, definitionId, evidence) {
  return {
    schemaVersion: '1.0.0', printingId: card.printingId, game: 'tcg', language: 'zh-Hans', setCode: card.setCode,
    number: card.number, regulationMark: card.mark ?? null, ...(card.series ? { series: card.series } : {}),
    ...(card.releasedOn ? { releasedOn: card.releasedOn } : {}), identityReview: 'machine',
    definitionBindings: [{ ruleset: { ...RULESET }, definitionId, sourceOfTruth: evidence }],
    metadataRefs: [{ provider: 'other', id: `library_v1:zh-Hans/${card.dir}`,
      ...(card.imageSha256 ? { revision: `image-sha256:${card.imageSha256}` } : {}) }],
  };
}

// What a definition says, without its identities and evidence: two cards with the same fingerprint play the same, so
// their printings share one definition (a reviewed one if it exists).
const bare = (s) => String(s).normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '');
export function fingerprint(def) {
  const strip = (v, key) => {
    if (Array.isArray(v)) return v.map((x) => strip(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v)
      .filter(([k]) => !['definitionId', 'sourceOfTruth', 'attackId', 'abilityId', 'effectId', 'implementation', 'metadataRefs'].includes(k))
      .map(([k, x]) => [k, strip(x, k)]).sort(([a], [b]) => (a < b ? -1 : 1)));
    return key === 'name' ? bare(v) : v;
  };
  return createHash('sha256').update(JSON.stringify(strip(def))).digest('hex');
}
