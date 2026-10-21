// The gold set for scripts/effect_translate.py: every effect text of the hand-reviewed CN/V20261019 pool with the
// effect entries the reviewed catalog gives it, in the authoring form the translators produce.
//   node scripts/effect-gold.mjs   → .data/effect-translation/gold.jsonl
// One line per unit: {uid, unit: {kind, text, …context}, expected: {status: 'ok', effects, …}}. Ids inside parameters
// are written with the DEF placeholder (this card's definition id) and nameKeys as NAME:<printed name>.
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pool from '../catalog/zh-CN/V20261019/index.mjs';
import { damageText } from '../public/match.js';
import { unitOf } from './effect-units.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CN = { Grass: '草', Fire: '火', Water: '水', Lightning: '雷', Psychic: '超', Fighting: '斗', Darkness: '恶', Metal: '钢', Dragon: '龙', Fairy: '妖', Colorless: '无' };
const slug = (id) => id.split(':').at(-1);
const names = new Map(pool.DEFINITIONS.map((d) => [d.nameKey, d.name]));

// Reviewed parameters → placeholders: this definition's id → DEF, nameKeys → NAME:<name>, evidence → CARD_EVIDENCE.
function placeholders(value, defId) {
  if (Array.isArray(value)) return value.map((x) => placeholders(x, defId));
  if (value && typeof value === 'object') {
    if (Array.isArray(value) === false && value.sourceId && value.kind === 'official-card') return 'CARD_EVIDENCE';
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k,
      k === 'sourceOfTruth' ? 'CARD_EVIDENCE'
        : ['nameKeys', 'excludeNameKeys', 'exceptToolNameKeys'].includes(k) ? v.map((n) => `NAME:${names.get(n) ?? n}`)
          : placeholders(v, defId)]));
  }
  return typeof value === 'string' && value.startsWith(defId + ':') ? 'DEF' + value.slice(defId.length) : value;
}
const entries = (effects, prefix, defId) => effects.map((e) => [e.effectId.slice(prefix.length + 1), e.handlerId, placeholders(e.parameters, defId)]);

const lines = [];
for (const set of pool.SETS) {
  for (const [key, card] of Object.entries(set.CARDS)) {
    const printingId = `zh-Hans:${card.setCode}:${card.number}`;
    const printing = pool.PRINTINGS.find((p) => p.printingId === printingId);
    const d = pool.DEFINITIONS.find((x) => x.definitionId === printing.definitionBindings[0].definitionId), m = d.mechanics;
    const texts = set.TEXTS[key] ?? {}, id = d.definitionId;
    const cardInfo = { name: d.name, kind: d.kind, stage: m.stage ?? null, hp: m.hp ?? null, category: m.category ?? null };
    const push = (unit, expected) => lines.push({ uid: unit.uid, card: printingId, unit, expected });
    if (d.kind === 'pokemon') {
      for (const a of m.attacks) {
        const text = texts[slug(a.attackId)] ?? '';
        if (!text && !a.effects.length) continue;
        push(unitOf({ kind: 'attack', text, card: cardInfo, attack: { name: a.name, cost: a.cost.map((c) => CN[c]).join(''), damage: damageText(a.printedDamage) } }),
          { status: 'ok', effects: entries(a.effects, a.attackId, id) });
      }
      for (const a of m.abilities) {
        push(unitOf({ kind: 'ability', text: texts[slug(a.abilityId)] ?? '', card: cardInfo, ability: { name: a.name } }),
          { status: 'ok', mode: a.mode, usage: placeholders(a.usage, id), ...(a.trigger ? { trigger: a.trigger } : {}),
            ...(a.condition ? { condition: a.condition } : {}), effects: entries(a.effects, a.abilityId, id) });
      }
      if (m.effects.length) push(unitOf({ kind: 'rule', text: [texts.tera, texts.rule].filter(Boolean).join('\n'), card: cardInfo }),
        { status: 'ok', rules: entries(m.effects, `${id}:rule`, id) });
    } else if (d.kind === 'trainer') {
      push(unitOf({ kind: 'trainer', text: texts.card ?? '', card: cardInfo }),
        { status: 'ok', effects: entries(m.effects, id, id), ...(m.playCosts ? { playCosts: m.playCosts.map(({ sourceOfTruth, ...c }) => placeholders(c, id)) } : {}),
          ...(m.condition ? { condition: m.condition } : {}) });
    } else if (m.category === 'special') {
      push(unitOf({ kind: 'energy', text: texts.card ?? '', card: cardInfo }), { status: 'ok', baseUnits: m.baseUnits, effects: entries(m.effects, id, id) });
    }
  }
}
const unique = [...new Map(lines.map((l) => [l.uid, l])).values()];
await mkdir(join(ROOT, '.data/effect-translation'), { recursive: true });
await writeFile(join(ROOT, '.data/effect-translation/gold.jsonl'), unique.map((l) => JSON.stringify(l)).join('\n') + '\n');
console.log(`Wrote ${unique.length} gold units (${lines.length} texts) to .data/effect-translation/gold.jsonl`);
