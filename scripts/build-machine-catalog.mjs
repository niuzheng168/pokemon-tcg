// The machine tier of the CN/V20261019 catalog: CardDefinitions (implementation.tier 'machine') and CardPrintings
// (identityReview 'machine') for the card library's cards whose card face the machine card review accepted field by
// field (scripts/card_review.py compare → .data/card-review/review.jsonl) and whose printed effects need no handler yet:
// Pokémon whose attacks only deal their printed damage, and basic Energy. A printing whose card face reads exactly as
// a hand-reviewed card's binds that reviewed definition; printings that play the same share one machine definition.
// Cards without an image use a same-name reprint only when every field of their source equals its accepted fields.
//   node scripts/build-machine-catalog.mjs [--out .data/machine-catalog]
// Writes <out>/definitions.json, printings.json and report.json; every definition and printing passes the kernel's own
// catalog checks together with the reviewed pool.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import * as pool from '../catalog/zh-CN/V20261019/index.mjs';
import { RULESET, ruleBoxOf } from '../catalog/zh-CN/V20261019/common.mjs';
import { glyph, costGlyphs, libraryEvidence, machinePokemon, machineBasicEnergy, machinePrinting, fingerprint }
  from '../catalog/zh-CN/V20261019/machine.mjs';
import { createCardCatalog } from '../public/rules/catalog.js';
import { canonicalDefinition, canonicalPrinting } from '../public/rules/card-schema.js';
import { createCoreHandlers } from '../public/rules/handlers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values: opt } = parseArgs({ options: { out: { type: 'string', default: join(ROOT, '.data', 'machine-catalog') } } });
const json = async (p) => JSON.parse(await readFile(p, 'utf8'));
const index = await json(join(ROOT, '.data/card-library/index.json'));
const review = new Map((await readFile(join(ROOT, '.data/card-review/review.jsonl'), 'utf8')).split('\n').filter(Boolean)
  .map((l) => JSON.parse(l)).map((r) => [r.id, r]));
const nameKeys = await json(join(ROOT, 'catalog/zh-CN/V20261019/library/name-keys.json'));
const libraryBase = join(index.library, index.language);

// ---- card-face text as the card review compares it (scripts/card_review.py norm_text) ----
const REMINDERS = [/[[［【(（]?在?(对战|战斗)中[^。\]］】)）]*?(GX|VSTAR)[^。\]］】)）]*?(只|仅)(能够|能|可以|可)使用1次[。\]］】)）]?/g,
  /[[［【(（]?在?(对战|战斗)中[^。\]］】)）]*?(只|仅)(能够|能|可以|可)使用1次(GX招式|VSTAR力量)[。\]］】)）]?/g];
const norm = (s) => [...REMINDERS.reduce((t, r) => t.replace(r, ''), String(s ?? '').normalize('NFKC').trim())]
  .filter((c) => (!/\s/u.test(c) && !/[\p{P}\p{S}]/u.test(c)) || '×+-□'.includes(c)).join('');
const bare = (name) => String(name ?? '').replace(/\s+/g, '');
const keyOf = (name) => nameKeys[bare(name)] ?? null;
const STAGES = { 基础: 'basic', 基礎: 'basic', 基础宝可梦: 'basic', basic: 'basic', Basic: 'basic', '1阶进化': 'stage1', 'Stage 1': 'stage1',
  Stage1: 'stage1', stage1: 'stage1', '2阶进化': 'stage2', 'Stage 2': 'stage2', Stage2: 'stage2', stage2: 'stage2', VMAX: 'VMAX', VSTAR: 'VSTAR' };
const stageOf = (raw, name) => STAGES[raw] ?? ((raw === 'V进化' || raw === 'V') ? (/VMAX$/.test(name) ? 'VMAX' : /VSTAR$/.test(name) ? 'VSTAR' : null) : null);
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
  if (e.kind !== 'pokemon') return { kind: e.kind, name, category: v('category') ?? e.category, text: norm(v('card_text') ?? '') };
  const attacks = Array.from({ length: Number(v('attack.count') ?? 0) }, (_, i) => ({
    name: v(`attack.${i}.name`), cost: costGlyphs(v(`attack.${i}.cost`)), damage: String(v(`attack.${i}.damage`) ?? '').normalize('NFKC').trim(),
    text: norm(v(`attack.${i}.text`) ?? ''),
  }));
  const abilities = Array.from({ length: Number(v('ability.count') ?? 0) }, (_, i) => ({ name: v(`ability.${i}.name`), text: norm(v(`ability.${i}.text`) ?? '') }));
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
  if (f.kind !== 'pokemon') return f;
  const wr = (x, sign) => x && `${glyph(x.type ?? x.energy)}${String(x.value ?? '').normalize('NFKC').replace(/\s/g, '').replace(/^[xX]/, '×')}`;
  return { kind: 'pokemon', name: f.name, stage: f.stage, hp: f.hp, type: f.type, evolvesFrom: f.evolvesFrom ? keyOf(f.evolvesFrom)?.key ?? '?' : null,
    retreat: f.retreat, weakness: wr(f.weakness), resistance: wr(f.resistance),
    attacks: f.attacks.map((a) => ({ name: norm(a.name), cost: a.cost, damage: a.damage, text: a.text })),
    abilities: f.abilities.map((a) => ({ name: norm(a.name), text: a.text })) };
}
const faceKey = (f) => JSON.stringify(f);
const reviewedByFace = new Map();
for (const p of pool.PRINTINGS) reviewedByFace.set(faceKey(reviewedFace(p)), p.definitionBindings[0].definitionId);

// ---- Stage 2 Basic ancestry from the whole library: the Stage 1 a Stage 2 evolves from, and what that evolves from ----
const stage1Parents = new Map();
for (const e of index.entries) {
  if (e.duplicateOf || e.kind !== 'pokemon') continue;
  const a = review.get(e.id)?.accepted ?? {};
  if (stageOf(a.stage?.value, e.name) !== 'stage1' && e.stage !== 'stage1') continue;
  const from = a.evolves_from?.value ?? e.evolvesFrom;
  if (!from) continue;
  const set = stage1Parents.get(bare(e.name)) ?? new Set();
  set.add(bare(from)); stage1Parents.set(bare(e.name), set);
}

// ---- cards without an image: a same-name reprint whose accepted fields equal every field of this card's source ----
const acceptedByName = new Map();
for (const r of review.values()) {
  if (!r.image || r.conflicts.length) continue;
  const list = acceptedByName.get(`${r.kind}|${bare(r.name)}`) ?? [];
  list.push(r); acceptedByName.set(`${r.kind}|${bare(r.name)}`, list);
}
async function reprintFor(e, r) {
  const m = await json(join(libraryBase, e.dir, 'metadata.merged.json')), c = m.card;
  const own = { name: bare(c.name), hp: c.hp ?? null, attacks: (c.attacks ?? []).map((a) => [norm(a.name), costGlyphs(a.cost), String(a.damage ?? ''), norm(a.text)]),
    abilities: (c.abilities ?? []).map((a) => [norm(a.name), norm(a.text)]), text: norm(Array.isArray(c.text) ? c.text.join('\n') : c.text ?? '') };
  for (const peer of acceptedByName.get(`${r.kind}|${bare(r.name)}`) ?? []) {
    const v = (f) => peer.accepted[f]?.value;
    const theirs = { name: bare(v('name')), hp: v('hp') ?? null,
      attacks: Array.from({ length: Number(v('attack.count') ?? 0) }, (_, i) => [norm(v(`attack.${i}.name`)), costGlyphs(v(`attack.${i}.cost`)),
        String(v(`attack.${i}.damage`) ?? ''), norm(v(`attack.${i}.text`) ?? '')]),
      abilities: Array.from({ length: Number(v('ability.count') ?? 0) }, (_, i) => [norm(v(`ability.${i}.name`)), norm(v(`ability.${i}.text`) ?? '')]),
      text: r.kind === 'pokemon' ? own.text : norm(v('card_text') ?? '') };
    if (r.kind === 'pokemon') theirs.hp = theirs.hp === null ? null : Number(theirs.hp), own.hp = own.hp === null ? null : Number(own.hp);
    if (JSON.stringify(own) === JSON.stringify(theirs)) return peer;
  }
  return null;
}

// ---- build ----
const report = { cards: 0, reviewedPrintings: 0, bound: { reviewed: 0, machine: 0 }, skipped: {} };
const skip = (why) => { report.skipped[why] = (report.skipped[why] ?? 0) + 1; return null; };
const machineDefs = new Map(), printings = [], reviewedIds = new Set(pool.PRINTINGS.map((p) => p.printingId));
const byFingerprint = new Map([...reviewedDefs.values()].map((d) => [fingerprint(d), d.definitionId]));
const hash8 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 8);

for (const e of index.entries) {
  if (e.duplicateOf) continue;
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
    let def;
    if (f.kind === 'energy' && e.category === 'basic') {
      if (!e.types[0]) { skip('basic Energy without a type'); continue; }
      const t = { Grass: '草', Fire: '火', Water: '水', Lightning: '雷', Psychic: '超', Fighting: '斗', Darkness: '恶', Metal: '钢', Fairy: '妖' }[e.types[0]];
      def = machineBasicEnergy('DRAFT', { name: nk.name, nameKey: nk.key, type: t }, evidence);
    } else if (f.kind === 'pokemon') {
      if (!f.stage) { skip(`stage not played yet (${e.stage ?? accepted.stage?.value ?? '?'})`); continue; }
      const rb = ruleBoxOf(f.name);
      if (['GX', 'TAG TEAM', 'VSTAR'].includes(rb)) { skip(`${rb}: special attacks not built yet`); continue; }
      if (e.labels.includes('Tera')) { skip('Tera rule box not built yet'); continue; }
      if (e.mechanic === 'Prism Star') { skip('Prism Star not built yet'); continue; }
      if (f.abilities.length || f.attacks.some((a) => a.text || !/^\d*$/.test(a.damage))) { skip('effects: awaiting translation'); continue; }
      if (f.hp % 10 || !f.hp) { skip('HP not a multiple of 10'); continue; }
      let evolvesFrom = null, basicAncestor;
      if (f.stage !== 'basic') {
        evolvesFrom = keyOf(f.evolvesFrom)?.key;
        if (!evolvesFrom) { skip('evolves from a name without a name key'); continue; }
      }
      if (f.stage === 'stage2') {
        const parents = stage1Parents.get(bare(f.evolvesFrom));
        if (parents?.size !== 1) { skip('Stage 2 without one Basic ancestor in the library'); continue; }
        basicAncestor = keyOf([...parents][0])?.key;
        if (!basicAncestor) { skip('Stage 2 ancestor without a name key'); continue; }
      }
      try {
        def = machinePokemon('DRAFT', { name: nk.name, nameKey: nk.key, stage: f.stage, evolvesFrom, basicAncestor, hp: f.hp, type: f.type,
          weakness: f.weakness, resistance: f.resistance, retreat: f.retreat, ruleBox: rb, tags: e.labels.filter((l) => TAGS.has(l)),
          attacks: f.attacks.map((a) => ({ name: a.name, cost: a.cost, damage: a.damage === '' ? null : Number(a.damage) })) }, evidence);
      } catch (error) { skip(`unbuildable: ${error.message.replace(/:.*/, '')}`); continue; }
    } else { skip(`${f.kind === 'trainer' ? 'Trainer' : 'Special Energy'}: awaiting translation`); continue; }
    const fp = fingerprint(def);
    definitionId = byFingerprint.get(fp);
    if (!definitionId) {
      definitionId = `cn:machine:${def.kind}:${def.nameKey}:${fp.slice(0, 8)}`;
      byFingerprint.set(fp, definitionId);
      const final = def.kind === 'pokemon'
        ? machinePokemon(definitionId, { ...face(e, accepted), name: def.name, nameKey: def.nameKey, stage: def.mechanics.stage,
          evolvesFrom: def.mechanics.evolvesFrom, basicAncestor: def.mechanics.basicAncestor?.nameKey, type: f.type, ruleBox: ruleBoxOf(f.name),
          tags: e.labels.filter((l) => TAGS.has(l)), attacks: f.attacks.map((a) => ({ name: a.name, cost: a.cost, damage: a.damage === '' ? null : Number(a.damage) })) }, evidence)
        : machineBasicEnergy(definitionId, { name: def.name, nameKey: def.nameKey, type: Object.entries({ Grass: '草', Fire: '火', Water: '水',
          Lightning: '雷', Psychic: '超', Fighting: '斗', Darkness: '恶', Metal: '钢', Fairy: '妖' }).find(([k]) => k === def.mechanics.baseUnits[0][0])[1] }, evidence);
      machineDefs.set(definitionId, final);
    }
  }
  report.bound[reviewedDefs.has(definitionId) ? 'reviewed' : 'machine']++;
  printings.push(machinePrinting({ printingId: e.cardId, setCode: e.set, number: e.cardId.split(':').slice(2).join(':'), mark: accepted.mark?.value ?? null,
    series: SERIES[e.series] ?? null, releasedOn: e.releasedOn, dir: e.dir, imageSha256: e.image?.sha256 }, definitionId, evidence));
}

// ---- the kernel's own checks, with the reviewed pool ----
const definitions = [...pool.DEFINITIONS, ...machineDefs.values()];
const allPrintings = [...pool.PRINTINGS, ...printings];
await createCardCatalog({ ruleset: RULESET, definitions, printings: allPrintings,
  approvedDefinitions: new Map(definitions.map((d) => [d.definitionId, canonicalDefinition(d)])),
  approvedPrintings: new Map(allPrintings.map((p) => [p.printingId, canonicalPrinting(p)])), handlers: createCoreHandlers() });

report.definitions = machineDefs.size;
report.printings = printings.length;
await mkdir(opt.out, { recursive: true });
const sorted = (list, key) => [...list].sort((a, b) => (a[key] < b[key] ? -1 : 1));
await writeFile(join(opt.out, 'definitions.json'), JSON.stringify(sorted([...machineDefs.values()], 'definitionId')) + '\n');
await writeFile(join(opt.out, 'printings.json'), JSON.stringify(sorted(printings, 'printingId')) + '\n');
await writeFile(join(opt.out, 'report.json'), JSON.stringify(report, null, 1) + '\n');
console.log(`${printings.length} machine printings (${report.bound.reviewed} on reviewed definitions, ${report.bound.machine} on ` +
  `${machineDefs.size} machine definitions) of ${report.cards} cards; ${report.reviewedPrintings} reviewed; skipped: ` +
  Object.entries(report.skipped).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', '));
