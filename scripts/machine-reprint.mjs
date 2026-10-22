// Pure comparisons for image-less cards. Inheriting a checked reprint requires the source to carry every playing
// field, not merely the same name/HP/attacks. In particular, a Weakness type without its multiplier is incomplete.
import { glyph, costGlyphs } from '../catalog/zh-CN/V20261019/machine.mjs';

const REMINDERS = [/[[［【(（]?在?(对战|战斗)中[^。\]］】)）]*?(GX|VSTAR)[^。\]］】)）]*?(只|仅)(能够|能|可以|可)使用1次[。\]］】)）]?/g,
  /[[［【(（]?在?(对战|战斗)中[^。\]］】)）]*?(只|仅)(能够|能|可以|可)使用1次(GX招式|VSTAR力量)[。\]］】)）]?/g];
export const normalizedFaceText = (s) => [...REMINDERS.reduce((t, r) => t.replace(r, ''), String(s ?? '').normalize('NFKC').trim())]
  .filter((c) => (!/\s/u.test(c) && !/[\p{P}\p{S}]/u.test(c)) || '×+-□'.includes(c)).join('');
const STAGES = { 基础: 'basic', 基礎: 'basic', 基础宝可梦: 'basic', basic: 'basic', Basic: 'basic', '1阶进化': 'stage1', 'Stage 1': 'stage1',
  Stage1: 'stage1', stage1: 'stage1', '2阶进化': 'stage2', 'Stage 2': 'stage2', Stage2: 'stage2', stage2: 'stage2', VMAX: 'VMAX', VSTAR: 'VSTAR' };
export const stageOf = (raw, name) => STAGES[raw] ?? ((raw === 'V进化' || raw === 'V')
  ? (/VMAX$/.test(name) ? 'VMAX' : /VSTAR$/.test(name) ? 'VSTAR' : null) : null);
const sourceText = (s) => String(s ?? '').split(/\|[je]effect=/)[0]
  .replace(/-\{zh-hans:([\s\S]*?);zh-hant:[\s\S]*?\}-/g, '$1').replaceAll('\\n', '\n');
const number = (v) => v === undefined || v === null || v === '' ? null : Number(v);
const wr = (v) => v == null ? null : {
  type: glyph(v.type ?? v.energy), value: String(v.value ?? '').normalize('NFKC').replace(/\s/g, '').replace(/^[xX]/, '×'),
};

function playingFields(get, kind, category) {
  const name = normalizedFaceText(get('name'));
  if (kind !== 'pokemon') return { name, kind, category, text: normalizedFaceText(get('card_text')) };
  return {
    name, kind, hp: number(get('hp')), type: glyph(get('type')), stage: stageOf(get('stage'), name),
    evolvesFrom: normalizedFaceText(get('evolves_from')), weakness: wr(get('weakness')), resistance: wr(get('resistance')),
    retreat: number(get('retreat')),
    attacks: Array.from({ length: number(get('attack.count')) ?? 0 }, (_, i) => [
      normalizedFaceText(get(`attack.${i}.name`)), costGlyphs(get(`attack.${i}.cost`)),
      String(get(`attack.${i}.damage`) ?? '').normalize('NFKC').trim(), normalizedFaceText(get(`attack.${i}.text`)),
    ]),
    abilities: Array.from({ length: number(get('ability.count')) ?? 0 }, (_, i) => [
      normalizedFaceText(get(`ability.${i}.name`)), normalizedFaceText(get(`ability.${i}.text`)),
    ]),
  };
}

export function matchesReprintFields(card, { kind, category }, accepted, peerCategory) {
  const source = {
    name: card.name, hp: card.hp, type: card.type, stage: card.stage, evolves_from: card.evolvesFrom,
    weakness: card.weakness ?? null, resistance: card.resistance ?? null, retreat: card.retreat,
    card_text: sourceText(Array.isArray(card.text) ? card.text.join('\n') : card.text),
    'attack.count': (card.attacks ?? []).length, 'ability.count': (card.abilities ?? []).length,
  };
  for (const [group, items] of [['attack', card.attacks ?? []], ['ability', card.abilities ?? []]])
    items.forEach((item, i) => {
      for (const key of group === 'attack' ? ['name', 'cost', 'damage', 'text'] : ['name', 'text'])
        source[`${group}.${i}.${key}`] = key === 'text' ? sourceText(item[key]) : item[key];
    });
  return JSON.stringify(playingFields((f) => source[f], kind, category))
    === JSON.stringify(playingFields((f) => accepted[f]?.value, kind, peerCategory));
}
