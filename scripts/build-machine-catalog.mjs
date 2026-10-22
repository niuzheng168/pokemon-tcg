// The machine tier of the CN/V20261019 catalog: CardDefinitions (implementation.tier 'machine') and CardPrintings
// (identityReview 'machine') for the card library's cards whose card face the machine card review accepted field by
// field (scripts/card_review.py compare → .data/card-review/review.jsonl) and whose complete effects have independent
// semantic certificates (scripts/build-effect-candidates.mjs). A printing whose card face reads exactly as
// a hand-reviewed card's binds that reviewed definition; printings that play the same share one machine definition.
// Cards without an image use a same-name reprint only when every field of their source equals its accepted fields.
//   node scripts/build-machine-catalog.mjs [--out .data/machine-catalog] [--publish]
// Writes definitions.json, printings.json, presentation.json and report.json. --publish also writes the inspected
// snapshot under catalog/.../library/machine/, so clean clones can build/check the release without local model caches.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import * as pool from '../catalog/zh-CN/V20261019/index.mjs';
import { RULESET, ruleBoxOf } from '../catalog/zh-CN/V20261019/common.mjs';
import { glyph, costGlyphs, libraryEvidence, machinePokemon, machineBasicEnergy, machineTrainer, machineSpecialEnergy, machinePrinting, fingerprint }
  from '../catalog/zh-CN/V20261019/machine.mjs';
import { createCardCatalog, canonicalJSON } from '../public/rules/catalog.js';
import { canonicalDefinition, canonicalPrinting, assertExecutableDefinition } from '../public/rules/card-schema.js';
import { createCoreHandlers } from '../public/rules/handlers.js';
import { normalizedFaceText as norm, stageOf, matchesReprintFields } from './machine-reprint.mjs';
import { unitOf } from './effect-units.mjs';
import { certifyCandidate } from './effect-certificates.mjs';
import { check as checkEffect } from './effect-validate.mjs';
import { checkMachineRuleBox, applyRuleBoxOverride } from './machine-rule-boxes.mjs';
import { reviewedProgramEvidence } from './reviewed-effect-certificates.mjs';
import { buildStage1Parents } from './machine-ancestry.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values: opt } = parseArgs({ options: {
  out: { type: 'string', default: join(ROOT, '.data', 'machine-catalog') }, publish: { type: 'boolean', default: false },
  effects: { type: 'string', default: join(ROOT, 'catalog/zh-CN/V20261019/library/machine/effects.json') },
} });
const json = async (p) => JSON.parse(await readFile(p, 'utf8'));
const index = await json(join(ROOT, '.data/card-library/index.json'));
const review = new Map((await readFile(join(ROOT, '.data/card-review/review.jsonl'), 'utf8')).split('\n').filter(Boolean)
  .map((l) => JSON.parse(l)).map((r) => [r.id, r]));
const nameKeys = await json(join(ROOT, 'catalog/zh-CN/V20261019/library/name-keys.json'));
const libraryBase = join(index.library, index.language);
const entries = new Map(index.entries.map((e) => [e.id, e]));
const effectText = await readFile(opt.effects, 'utf8');
const certified = JSON.parse(effectText), effects = new Map();
const ruleOverrides = await json(join(ROOT, 'catalog/zh-CN/V20261019/library/machine/rule-box-overrides.json'));
if (certified.schema !== 'cn-certified-effects/1') throw new Error('Unknown effect certificate schema.');
for (const row of certified.units) {
  const { uid, ...identity } = row.unit;
  if (uid !== unitOf(identity).uid || effects.has(uid)) throw new Error(`Invalid/duplicate certified unit: ${uid}`);
  const proof = certifyCandidate(row.unit, row.result, row.result, row.result.usage?.key);
  if (!proof || proof.family !== row.family || canonicalJSON(proof.reviewed ?? null) !== canonicalJSON(row.reviewed ?? null)
    || !checkEffect(row.unit, row.result).valid)
    throw new Error(`Invalid semantic certificate: ${uid}`);
  effects.set(uid, row);
}
const translation = (unit) => effects.get(unitOf(unit).uid)?.result ?? null;
const ruleReads = new Map(), ruleAudit = new Map();
async function ruleBoxReview(e, f) {
  const image = e.image?.sha256;
  if (!image) return { valid: false, reason: 'missing full-image rule-box readings' };
  if (!ruleReads.has(image)) ruleReads.set(image, await Promise.all(['astra', 'sol'].map(async (model) => {
    const raw = await readFile(join(ROOT, '.data/card-review/reads', `${model}-full`, `${image.slice(0, 16)}.json`), 'utf8');
    const row = JSON.parse(raw);
    if (row.card?.image !== image) throw new Error(`Rule-box image identity differs: ${e.id}/${model}`);
    return { reading: row.reading, sha256: createHash('sha256').update(raw).digest('hex') };
  })));
  const rows = ruleReads.get(image), override = ruleOverrides[image];
  const verdict = checkMachineRuleBox({ ...f, aceSpec: e.mechanic === 'ACE SPEC' }, applyRuleBoxOverride(image, rows, override));
  if (verdict.valid) ruleAudit.set(e.cardId, { image, reads: rows.map((r) => r.sha256), ...(override ? { override } : {}) });
  return verdict;
}
function printedDamage(value) {
  if (value === '') return null;
  const m = /^(\d+)([+×x-])?$/.exec(value);
  if (!m) throw new TypeError(`Unsupported printed damage: ${value}`);
  return m[2] ? { value: Number(m[1]), operator: { '+': 'plus', '×': 'times', x: 'times', '-': 'minus' }[m[2]] } : Number(m[1]);
}

// ---- card-face text as the card review compares it (scripts/card_review.py norm_text) ----
const bare = (name) => String(name ?? '').replace(/\s+/g, '');
const keyOf = (name) => nameKeys[bare(name)] ?? null;
const SERIES = { 'scarlet-violet': 'scarlet-violet', 'sword-shield': 'sword-shield', 'sun-moon': 'sun-moon', '30th': 'anniversary-30', mega: 'other' };
// Library labels that are card tags other cards select by (「连击」「古代」…); the Tera rule box is an effect, not yet built.
const TAGS = new Set(['Rapid Strike', 'Single Strike', 'Fusion Strike', 'Ultra Beast', 'Ancient', 'Future']);

// ---- the accepted card face of one library card ----
async function pages(e) {
  const m = await json(join(libraryBase, e.dir, 'metadata.merged.json'));
  return { wikiId: m.sources?.find((s) => s.kind === '52poke')?.id ?? null, official: m.sources?.find((s) => s.kind === 'official')?.url ?? null };
}
// The fields a card plays by: accepted values as written (review.jsonl `accepted`).
function face(e, accepted) {
  const v = (f) => accepted[f]?.value;
  const name = keyOf(v('name') ?? e.name)?.name ?? null;
  if (e.kind !== 'pokemon') return { kind: e.kind, name, category: v('category') ?? e.category, text: v('card_text') ?? '' };
  const attacks = Array.from({ length: Number(v('attack.count') ?? 0) }, (_, i) => ({
    name: v(`attack.${i}.name`), cost: costGlyphs(v(`attack.${i}.cost`)), damage: String(v(`attack.${i}.damage`) ?? '').normalize('NFKC').trim(),
    text: v(`attack.${i}.text`) ?? '',
  }));
  const abilities = Array.from({ length: Number(v('ability.count') ?? 0) }, (_, i) => ({ name: v(`ability.${i}.name`), text: v(`ability.${i}.text`) ?? '' }));
  return { kind: 'pokemon', name, stage: stageOf(v('stage'), name ?? ''), hp: Number(v('hp')), type: glyph(v('type')),
    evolvesFrom: v('evolves_from') || null, weakness: v('weakness') ?? null, resistance: v('resistance') ?? null,
    retreat: Number(v('retreat') ?? 0), attacks, abilities };
}

// ---- reviewed card faces: a printing reading exactly as one binds the reviewed definition ----
const reviewedDefs = new Map(pool.DEFINITIONS.map((d) => [d.definitionId, d]));
const slug = (id) => id.split(':').at(-1);
const PRINTED_DAMAGE = { fixed: '', plus: '+', minus: '-', times: '×' };
function reviewedFace(p) {
  const d = reviewedDefs.get(p.definitionBindings[0].definitionId), t = pool.PRESENTATION[p.printingId]?.texts ?? {};
  const m = d.mechanics, name = d.name;
  if (d.kind !== 'pokemon') return { kind: d.kind, name, category: m.category, text: norm(t.card ?? '') };
  const G = { Grass: '草', Fire: '火', Water: '水', Lightning: '雷', Psychic: '超', Fighting: '斗', Darkness: '恶', Metal: '钢', Fairy: '妖', Dragon: '龙', Colorless: '无' };
  return { kind: 'pokemon', name, stage: m.stage, hp: m.hp, type: G[m.types[0]], evolvesFrom: m.evolvesFrom, retreat: m.retreatCost,
    weakness: m.weakness && `${G[m.weakness.type]}${m.weakness.operation === 'multiply' ? '×' : '+'}${m.weakness.value}`,
    resistance: m.resistance && `${G[m.resistance.type]}-${m.resistance.value}`,
    attacks: m.attacks.map((a) => ({ name: norm(a.name), cost: a.cost.map((c) => G[c]).join(''),
      damage: a.printedDamage ? `${a.printedDamage.value}${PRINTED_DAMAGE[a.printedDamage.operator]}` : '', text: norm(t[slug(a.attackId)] ?? '') })),
    abilities: m.abilities.map((a) => ({ name: norm(a.name), text: norm(t[slug(a.abilityId)] ?? '') })) };
}
// The same shape from an accepted machine face (evolves-from as a name key, Weakness / Resistance as printed text).
function comparable(f) {
  if (f.kind !== 'pokemon') return { ...f, text: norm(f.text) };
  const wr = (x, sign) => x && `${glyph(x.type ?? x.energy)}${String(x.value ?? '').normalize('NFKC').replace(/\s/g, '').replace(/^[xX]/, '×')}`;
  return { kind: 'pokemon', name: f.name, stage: f.stage, hp: f.hp, type: f.type, evolvesFrom: f.evolvesFrom ? keyOf(f.evolvesFrom)?.key ?? '?' : null,
    retreat: f.retreat, weakness: wr(f.weakness), resistance: wr(f.resistance),
    attacks: f.attacks.map((a) => ({ name: norm(a.name), cost: a.cost, damage: a.damage, text: norm(a.text) })),
    abilities: f.abilities.map((a) => ({ name: norm(a.name), text: norm(a.text) })) };
}
const faceKey = (f) => JSON.stringify(f);
const reviewedByFace = new Map();
for (const p of pool.PRINTINGS) reviewedByFace.set(faceKey(reviewedFace(p)), p.definitionBindings[0].definitionId);

// ---- Stage 2 Basic ancestry from the whole library: the Stage 1 a Stage 2 evolves from, and what that evolves from ----
const stage1Parents = buildStage1Parents(index, review, (name) => keyOf(name)?.key);

// ---- cards without an image: a same-name reprint whose accepted fields equal every field of this card's source ----
const acceptedByName = new Map();
for (const r of review.values()) {
  if (!r.image || r.conflicts.length) continue;
  const list = acceptedByName.get(`${r.kind}|${bare(r.name)}`) ?? [];
  list.push(r); acceptedByName.set(`${r.kind}|${bare(r.name)}`, list);
}
async function reprintFor(e, r) {
  const m = await json(join(libraryBase, e.dir, 'metadata.merged.json')), c = m.card;
  for (const peer of acceptedByName.get(`${r.kind}|${bare(r.name)}`) ?? []) {
    if (matchesReprintFields(c, e, peer.accepted, entries.get(peer.id).category)) return peer;
  }
  return null;
}

// ---- build ----
const report = { schema: 'cn-machine-catalog/1', pipeline: 'certified-effect-programs-strict-reprints-v4', reviewedOn: '2026-10-22',
  reviewSha256: createHash('sha256').update(await readFile(join(ROOT, '.data/card-review/review.jsonl'))).digest('hex'),
  effectsSha256: createHash('sha256').update(effectText).digest('hex'), certifiedUnits: effects.size,
  cards: 0, reviewedPrintings: 0, bound: { reviewed: 0, machine: 0 }, skipped: {} };
let currentEntry;
const exclusions = [], skip = (why) => {
  report.skipped[why] = (report.skipped[why] ?? 0) + 1;
  exclusions.push({ printingId: currentEntry.cardId, dir: currentEntry.dir, name: currentEntry.name, reason: why });
  return null;
};
const machineDefs = new Map(), printings = [], presentation = {}, reviewedIds = new Set(pool.PRINTINGS.map((p) => p.printingId));
const byFingerprint = new Map([...reviewedDefs.values()].map((d) => [fingerprint(d), d.definitionId]));

for (const e of index.entries) {
  if (e.duplicateOf) continue;
  currentEntry = e;
  report.cards++;
  if (e.printingId || reviewedIds.has(e.cardId)) { report.reviewedPrintings++; continue; }
  const r = review.get(e.id);
  let accepted = r?.accepted, via = null;
  if (!r) { skip('not in the card review'); continue; }
  if (r.conflicts.length) {
    const peer = !r.image ? await reprintFor(e, r) : null;
    if (!peer) { skip(r.image ? 'card review: fields in conflict' : 'no image and no identical reviewed reprint'); continue; }
    accepted = { ...peer.accepted, mark: { value: e.mark } }; via = peer.id;
  }
  const f = face(e, accepted);
  if (!f.name) { skip('name without a name key'); continue; }
  const nk = keyOf(f.name);
  const evidence = libraryEvidence({ dir: e.dir, mik: r.mik, ...(r.mik ? {} : await pages(e)) });
  if (via) evidence[0].locator += `；本卡无卡图，各字段与已核对的同名重印 ${via} 逐字段一致`;
  let definitionId = reviewedByFace.get(faceKey(comparable(f)));
  if (!definitionId) {
    let def, build;
    // These mechanics add rules beyond a translated effect unit. Do not silently omit them on Trainers/Energy either.
    if (e.mechanic === 'Prism Star') { skip('Prism Star not built yet'); continue; }
    if (f.kind === 'energy' && e.category === 'basic') {
      if (!e.types[0]) { skip('basic Energy without a type'); continue; }
      const t = { Grass: '草', Fire: '火', Water: '水', Lightning: '雷', Psychic: '超', Fighting: '斗', Darkness: '恶', Metal: '钢', Fairy: '妖' }[e.types[0]];
      build = (id) => machineBasicEnergy(id, { name: nk.name, nameKey: nk.key, type: t }, evidence);
    } else if (f.kind === 'pokemon') {
      if (!f.stage) { skip(`stage not played yet (${e.stage ?? accepted.stage?.value ?? '?'})`); continue; }
      const rb = ruleBoxOf(f.name);
      if (['GX', 'TAG TEAM', 'VSTAR'].includes(rb)) { skip(`${rb}: special attacks not built yet`); continue; }
      const card = { name: f.name, kind: f.kind, stage: f.stage, hp: f.hp, category: e.category };
      const attacks = f.attacks.map((a) => ({ ...a, translation: a.text
        ? translation({ kind: 'attack', text: a.text, card, attack: { name: a.name, cost: a.cost, damage: a.damage } }) : null }));
      const abilities = f.abilities.map((a) => ({ ...a, translation: translation({ kind: 'ability', text: a.text, card,
        ability: { name: a.name } }) }));
      if (attacks.some((a) => a.text && !a.translation || !a.text && !/^\d*$/.test(a.damage))
        || abilities.some((a) => !a.translation)) { skip('effects: awaiting semantic certification'); continue; }
      if (f.hp % 10 || !f.hp) { skip('HP not a multiple of 10'); continue; }
      let evolvesFrom = null, basicAncestor;
      if (f.stage !== 'basic') {
        evolvesFrom = keyOf(f.evolvesFrom)?.key;
        if (!evolvesFrom) { skip('evolves from a name without a name key'); continue; }
      }
      if (f.stage === 'stage2') {
        const parents = stage1Parents.get(evolvesFrom);
        if (parents?.size !== 1) { skip('Stage 2 without one Basic ancestor in the library'); continue; }
        basicAncestor = [...parents][0];
        if (!basicAncestor) { skip('Stage 2 ancestor without a name key'); continue; }
      }
      try {
        const face = { name: nk.name, nameKey: nk.key, stage: f.stage, evolvesFrom, basicAncestor, hp: f.hp, type: f.type,
          resolveNameKey: (name) => keyOf(name)?.key, resolveProgramEvidence: reviewedProgramEvidence,
          weakness: f.weakness, resistance: f.resistance, retreat: f.retreat, ruleBox: rb, tags: e.labels.filter((l) => TAGS.has(l)),
          attacks: attacks.map((a) => ({ ...a, damage: printedDamage(a.damage) })), abilities };
        build = (id, features) => machinePokemon(id, { ...face, ...features }, evidence);
      } catch (error) { skip(`unbuildable: ${error.message.replace(/:.*/, '')}`); continue; }
    } else {
      const result = translation({ kind: f.kind === 'trainer' ? 'trainer' : 'energy', text: f.text,
        card: { name: f.name, kind: f.kind, category: f.category } });
      if (!result) { skip(`${f.kind === 'trainer' ? 'Trainer' : 'Special Energy'}: awaiting semantic certification`); continue; }
      const face = { name: nk.name, nameKey: nk.key, category: f.category, translation: result,
        resolveNameKey: (name) => keyOf(name)?.key, resolveProgramEvidence: reviewedProgramEvidence,
        tags: e.labels.filter((l) => TAGS.has(l) || l === 'TAG TEAM'), aceSpec: e.mechanic === 'ACE SPEC' };
      build = (id) => (f.kind === 'trainer' ? machineTrainer : machineSpecialEnergy)(id, face, evidence);
    }
    const ruleReview = await ruleBoxReview(e, f);
    if (!ruleReview.valid) { skip(`rule box: ${ruleReview.reason}`); continue; }
    if (e.labels.includes('Tera') && !ruleReview.features?.tera) { skip('rule box: Tera metadata contradicts the image readings'); continue; }
    try { def = build('DRAFT', ruleReview.features); }
    catch (error) { skip(`unbuildable: ${error.message.replace(/:.*/, '')}`); continue; }
    const fp = fingerprint(def);
    definitionId = byFingerprint.get(fp);
    if (!definitionId) {
      definitionId = `cn:machine:${def.kind}:${def.nameKey}:${fp.slice(0, 8)}`;
      if (machineDefs.has(definitionId) || reviewedDefs.has(definitionId))
        throw new Error(`Short definition fingerprint collision: ${definitionId}`);
      byFingerprint.set(fp, definitionId);
      const final = build(definitionId, ruleReview.features);
      machineDefs.set(definitionId, final);
    }
  }
  report.bound[reviewedDefs.has(definitionId) ? 'reviewed' : 'machine']++;
  const printing = machinePrinting({ printingId: e.cardId, setCode: e.set, number: e.number ?? e.cardId.split(':').slice(2).join(':'), mark: accepted.mark?.value ?? null,
    series: SERIES[e.series] ?? null, releasedOn: e.releasedOn, dir: e.dir, imageSha256: e.image?.sha256 }, definitionId, evidence);
  printings.push(printing);
  const definition = reviewedDefs.get(definitionId) ?? machineDefs.get(definitionId), texts = {};
  if (definition.kind === 'pokemon') {
    definition.mechanics.attacks.forEach((a, i) => { texts[slug(a.attackId)] = accepted[`attack.${i}.text`]?.value ?? ''; });
    definition.mechanics.abilities.forEach((a, i) => { texts[slug(a.abilityId)] = accepted[`ability.${i}.text`]?.value ?? ''; });
  } else texts.card = accepted.card_text?.value ?? '';
  if (e.rule) texts.rule = e.rule;
  if (definition.implementation.tier === 'machine' && definition.mechanics.tags?.includes('Tera') && !texts.rule?.includes('太晶'))
    texts.tera = '太晶：只要这只宝可梦，处于备战区，就不会受到招式的伤害。';
  presentation[printing.printingId] = { name: f.name, setCode: printing.setCode, number: printing.number,
    mark: printing.regulationMark, texts, textReview: via ? 'machine-reprint' : 'machine-image-checked',
    image: e.image ? `library/image/${e.image.sha256.slice(0, 16)}` : null };
}

// ---- the kernel's own checks, with the reviewed pool ----
const definitions = [...pool.DEFINITIONS, ...machineDefs.values()];
const allPrintings = [...pool.PRINTINGS, ...printings];
const handlers = createCoreHandlers(), approvedDefinitions = new Map(definitions.map((d) => [d.definitionId, canonicalDefinition(d)]));
for (const definition of machineDefs.values()) {
  try { assertExecutableDefinition(definition, { ruleset: RULESET, approvedDefinitions, handlers }); }
  catch (error) { error.message = `${definition.definitionId}: ${error.message}`; throw error; }
}
await createCardCatalog({ ruleset: RULESET, definitions, printings: allPrintings,
  approvedDefinitions, approvedPrintings: new Map(allPrintings.map((p) => [p.printingId, canonicalPrinting(p)])), handlers });

report.definitions = machineDefs.size;
report.printings = printings.length;
report.ruleReviewSha256 = createHash('sha256').update(JSON.stringify([...ruleAudit].sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
const ancestry = [...stage1Parents].map(([nameKey, parents]) => [nameKey, [...parents].sort()])
  .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
report.ancestrySha256 = createHash('sha256').update(canonicalJSON(ancestry)).digest('hex');
report.inputSha256 = createHash('sha256').update(`${report.reviewSha256}\n${report.effectsSha256}\n${report.ruleReviewSha256}\n${report.ancestrySha256}\n`).digest('hex');
const sorted = (list, key) => [...list].sort((a, b) => (a[key] < b[key] ? -1 : 1));
const files = {
  'definitions.json': JSON.stringify(sorted([...machineDefs.values()], 'definitionId')) + '\n',
  'printings.json': JSON.stringify(sorted(printings, 'printingId')) + '\n',
  'presentation.json': JSON.stringify(Object.fromEntries(Object.entries(presentation).sort(([a], [b]) => a < b ? -1 : 1))) + '\n',
  'report.json': JSON.stringify(report, null, 1) + '\n',
  'exclusions.json': JSON.stringify(sorted(exclusions, 'printingId')) + '\n',
};
for (const dir of new Set([opt.out, ...(opt.publish ? [join(ROOT, 'catalog/zh-CN/V20261019/library/machine')] : [])])) {
  await mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
}
console.log(`${printings.length} machine printings (${report.bound.reviewed} on reviewed definitions, ${report.bound.machine} on ` +
  `${machineDefs.size} machine definitions) of ${report.cards} cards; ${report.reviewedPrintings} reviewed; skipped: ` +
  Object.entries(report.skipped).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', '));
