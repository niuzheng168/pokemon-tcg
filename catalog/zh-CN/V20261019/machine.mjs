// Machine-tier card data for CN/V20261019: CardDefinitions with implementation.tier 'machine' and CardPrintings with
// identityReview 'machine', built from the machine card review of the card library (scripts/card_review.py →
// .data/card-review/review.jsonl) by scripts/build-machine-catalog.mjs — not from a hand review of each card. Their
// evidence is the library record: its MIK card page, else its 52Poké page. Kept apart from the reviewed modules.
import { createHash } from 'node:crypto';
import { RULESET, type, ruleBoxMechanics, ACE_SPEC_GROUP } from './common.mjs';

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
  sourceOfTruth: evidence, implementation: { status: 'verified', testIds: [...MACHINE_TEST_IDS,
    ...(kind === 'trainer' || mechanics.category === 'special' || mechanics.abilities?.length
      || mechanics.effects?.length || mechanics.attacks?.some((a) => a.effects.length) ? ['tests/cn-cards/machine-effects.test.mjs'] : [])], tier: 'machine' }, deckLimits, mechanics,
});
const RADIANT_GROUP = 'cn-radiant';

// Resolve only explicitly supported authoring placeholders, never manufacture name keys. A unit's a/b namespace is
// local: the second attack's DEF:a must become a2, not accidentally point to a1. Cross-attack references need a
// separate whole-card binding review and are intentionally rejected by the current semantic certificate templates.
export function resolveMachineValue(value, id, scope, evidence, nameKey = () => null, attackByName = () => null,
  programEvidence = () => null) {
  const fill = (v) => {
    if (v === 'CARD_EVIDENCE') return structuredClone(evidence);
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    if (typeof v !== 'string') return v;
    if (v.startsWith('REVIEWED_EVIDENCE:')) {
      const policy = programEvidence(v.slice(18));
      if (!policy?.length) throw new TypeError(`Unresolved reviewed policy evidence: ${v.slice(18)}`);
      return structuredClone(policy);
    }
    if (v.startsWith('ATTACK:')) {
      const target = attackByName(v.slice(7));
      if (!target) throw new TypeError(`Unresolved named attack: ${v.slice(7)}`);
      return target;
    }
    if (v.startsWith('NAME:')) {
      const key = nameKey(v.slice(5));
      if (!key) throw new TypeError(`Unresolved effect name: ${v.slice(5)}`);
      return key;
    }
    if (v === 'DEF') return id;
    if (v.startsWith('DEF:')) {
      const expected = scope?.startsWith('a') ? 'a' : scope?.startsWith('b') ? 'b' : null;
      if (!expected || !new RegExp(`^DEF:${expected}(?::|$)`).test(v)) throw new TypeError(`Unresolved cross-unit reference: ${v}`);
      return `${id}:${scope}${v.slice(5)}`;
    }
    return v;
  };
  return fill(value);
}
// Card-specific evidence on a printed cost or failure condition is this card's own record.
const withEvidence = (value, evidence) => ({ ...value, sourceOfTruth: structuredClone(evidence) });
export function bindMachineEffects(id, scope, result, evidence, nameKey, attackByName, programEvidence) {
  const resolve = (v) => resolveMachineValue(v, id, scope, evidence, nameKey, attackByName, programEvidence);
  return (result?.effects ?? []).map(([key, handlerId, parameters, own = {}]) => ({
    effectId: `${id}:${scope ? `${scope}:` : ''}${key}`, handlerId, parameters: resolve(parameters),
    ...(own.trigger ? { trigger: resolve(own.trigger) } : {}),
    ...(own.activationCosts ? { activationCosts: own.activationCosts.map((c) => withEvidence(resolve(c), evidence)) } : {}),
    sourceOfTruth: evidence,
  }));
}

const damage = (v) => v === null ? null : typeof v === 'number' ? { value: v, operator: 'fixed' } : { ...v };

// face: { name, nameKey, stage ('basic'|'stage1'|'stage2'|'VMAX'|'VSTAR'), evolvesFrom (name key|null), basicAncestor (name
// key, Stage 2 only), hp, type (glyph), weakness, resistance (as printed), retreat, ruleBox (RULE_BOXES key|null), tags,
// attacks: [{ name, cost (glyphs), damage (number|printedDamage|null), translation? }], abilities? }. Every translation
// is a separately certified complete unit; the builder is not itself an approval or a permissive model-output parser.
export function machinePokemon(id, face, evidence) {
  if (face.tera && face.ruleBox !== 'ex') throw new TypeError('Tera needs a separately checked supported ex rule box.');
  const groups = face.ruleBox === 'Radiant' ? [{ key: RADIANT_GROUP, maximum: 1, sourceOfTruth: evidence }] : [];
  const namedAttack = (name) => {
    const clean = (s) => String(s).normalize('NFKC').replace(/\s/g, '');
    const indices = face.attacks.flatMap((a, i) => clean(a.name) === clean(name) ? [i] : []);
    return indices.length === 1 ? `${id}:a${indices[0] + 1}` : null;
  };
  return definition(id, face, 'pokemon', evidence, {
    stage: face.stage, evolvesFrom: face.evolvesFrom ?? null,
    ...(face.basicAncestor ? { basicAncestor: { nameKey: face.basicAncestor, sourceOfTruth: evidence } } : {}),
    hp: face.hp, types: [type(face.type)], weakness: weakness(face.weakness), resistance: resistance(face.resistance),
    retreatCost: face.retreat,
    attacks: face.attacks.map((a, i) => ({
      attackId: `${id}:a${i + 1}`, name: a.name, cost: [...a.cost].map(type),
      printedDamage: damage(a.damage), effects: bindMachineEffects(id, `a${i + 1}`, a.translation, evidence,
        face.resolveNameKey, namedAttack, face.resolveProgramEvidence),
      ...(a.translation?.failureCheck ? { failureCheck: withEvidence(resolveMachineValue(a.translation.failureCheck, id, `a${i + 1}`,
        evidence, face.resolveNameKey, namedAttack, face.resolveProgramEvidence), evidence) } : {}),
      sourceOfTruth: evidence,
    })),
    abilities: (face.abilities ?? []).map((a, i) => ({
      abilityId: `${id}:b${i + 1}`, name: a.name, mode: a.translation.mode, usage: a.translation.usage,
      ...(a.translation.condition ? { condition: a.translation.condition } : {}),
      ...(a.translation.trigger ? { trigger: a.translation.trigger } : {}),
      ...(a.translation.costs ? { costs: a.translation.costs.map((c) => withEvidence(resolveMachineValue(c, id, `b${i + 1}`, evidence,
        face.resolveNameKey, namedAttack, face.resolveProgramEvidence), evidence)) } : {}),
      effects: bindMachineEffects(id, `b${i + 1}`, a.translation, evidence,
        face.resolveNameKey, namedAttack, face.resolveProgramEvidence), sourceOfTruth: evidence,
    })), ...ruleBoxMechanics(face.ruleBox, [...(face.tags ?? []), ...(face.tera ? ['Tera'] : [])]),
    effects: face.tera ? bindMachineEffects(id, 'rule', { effects: [['tera', 'cn.protection@1', {
      effect: { op: 'protection', channel: 'damage', useRule: 'ordinary', scope: 'self', from: 'all', categories: ['attack'], benchOnly: true },
    }]] }, evidence) : [],
  }, { sameName: 4, groups });
}

export function machineTrainer(id, face, evidence) {
  const r = face.translation;
  return definition(id, face, 'trainer', evidence, { category: face.category,
    ...(face.tags?.length ? { tags: [...face.tags] } : {}), ...(r.condition ? { condition: r.condition } : {}),
    effects: bindMachineEffects(id, null, r, evidence, face.resolveNameKey, undefined, face.resolveProgramEvidence),
    ...(r.playCosts ? { playCosts: r.playCosts.map((c) => ({
      ...resolveMachineValue(c, id, null, evidence, face.resolveNameKey, undefined, face.resolveProgramEvidence), sourceOfTruth: evidence,
    })) } : {}),
  }, { sameName: 4, groups: face.aceSpec ? [{ key: ACE_SPEC_GROUP, maximum: 1, sourceOfTruth: evidence }] : [] });
}

export function machineSpecialEnergy(id, face, evidence) {
  return definition(id, face, 'energy', evidence, { category: 'special', baseUnits: structuredClone(face.translation.baseUnits),
    effects: bindMachineEffects(id, null, face.translation, evidence, face.resolveNameKey, undefined, face.resolveProgramEvidence),
  }, { sameName: 4, groups: face.aceSpec ? [{ key: ACE_SPEC_GROUP, maximum: 1, sourceOfTruth: evidence }] : [] });
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
  const ids = new Map([[def.definitionId, 'DEF']]);
  const record = (effects, prefix) => (effects ?? []).forEach((e, i) => ids.set(e.effectId, `${prefix}:e${i}`));
  const attacks = (list, prefix) => (list ?? []).forEach((a, i) => {
    const scope = `${prefix}:a${i}`; ids.set(a.attackId, scope); record(a.effects, scope);
  });
  attacks(def.mechanics.attacks, 'DEF'); attacks(def.mechanics.grantedAttacks, 'DEF:grant');
  (def.mechanics.abilities ?? []).forEach((a, i) => {
    const scope = `DEF:b${i}`; ids.set(a.abilityId, scope); record(a.effects, scope);
  });
  record(def.mechanics.effects, 'DEF');
  const strip = (v, key) => {
    if (Array.isArray(v)) return v.map((x) => strip(x));
    if (v && typeof v === 'object') {
      const identity = v === def ? 'definitionId' : v.handlerId && v.parameters ? 'effectId'
        : v.attackId && v.effects ? 'attackId' : v.abilityId && v.effects ? 'abilityId' : null;
      return Object.fromEntries(Object.entries(v)
        .filter(([k]) => k !== identity && !['sourceOfTruth', 'implementation', 'metadataRefs'].includes(k))
        .map(([k, x]) => [k, strip(x, k)]).sort(([a], [b]) => (a < b ? -1 : 1)));
    }
    return key === 'name' ? bare(v) : ids.get(v) ?? v;
  };
  return createHash('sha256').update(JSON.stringify(strip(def))).digest('hex');
}
