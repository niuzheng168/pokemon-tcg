// The units of effect translation for the whole card library: every distinct printed effect (scripts/effect-units.mjs)
// with the cards that print it. Texts are the card review's accepted wording (scripts/card_review.py compare →
// catalog/zh-CN/V20261019/library/review/review.jsonl), else the library's, marked unreviewed.
//   node scripts/effect-corpus.mjs   → .data/effect-translation/corpus.jsonl
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { unitOf } from './effect-units.mjs';
import { costGlyphs } from '../catalog/zh-CN/V20261019/machine.mjs';
import { stageOf } from './machine-reprint.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CN = { Grass: '草', Fire: '火', Water: '水', Lightning: '雷', Psychic: '超', Fighting: '斗', Darkness: '恶', Metal: '钢', Dragon: '龙', Fairy: '妖', Colorless: '无' };
// Pure authoring step: no files or paid APIs. Prefer every accepted field, including counts, names, costs and card
// identity; iterating only metadata's old attack/Ability arrays can omit a newly checked effect or translate a ghost.
export function buildEffectCorpus(index, reviewRows = []) {
  const review = new Map(reviewRows.map((r) => [r.id, r])), units = new Map();
  let cards = 0;
  for (const e of index.entries.filter((x) => !x.duplicateOf)) {
    const accepted = review.get(e.id)?.accepted ?? {};
    // `reviewed` below describes the unit's TEXT, not a human review or admission of the whole printing.
    const field = (f, fallback) => (f in accepted ? [accepted[f].value, true] : [fallback, false]);
    const value = (f, fallback) => field(f, fallback)[0];
    const name = value('name', e.name), rawStage = value('stage', e.stage), rawHp = value('hp', e.hp);
    const card = { name, kind: e.kind, stage: stageOf(rawStage, name) ?? rawStage,
      hp: rawHp == null ? null : Number(rawHp), category: value('category', e.category) };
    const add = (u, reviewed) => {
      if (!u.text) return;
      const unit = unitOf(u), have = units.get(unit.uid);
      if (have) {
        if (!have.uses.includes(e.cardId)) have.uses.push(e.cardId);
        have.reviewed ||= reviewed;
        return;
      }
      units.set(unit.uid, { ...unit, uses: [e.cardId], reviewed });
    };
    const count = (kind, fallback) => {
      const n = Number(value(`${kind}.count`, fallback));
      if (!Number.isSafeInteger(n) || n < 0) throw new TypeError(`${e.id}: invalid ${kind} count.`);
      return n;
    };
    const cost = (v) => costGlyphs(Array.isArray(v) ? v.map((c) => CN[c] ?? c) : v).replace(/\s/g, '');
    cards++;
    if (e.kind === 'pokemon') {
      for (let i = 0; i < count('attack', e.attacks.length); i++) {
        const a = e.attacks[i] ?? {}, [text, ok] = field(`attack.${i}.text`, a.text);
        add({ kind: 'attack', text: text ?? '', card, attack: {
          name: value(`attack.${i}.name`, a.name) ?? '', cost: cost(value(`attack.${i}.cost`, a.cost)),
          damage: String(value(`attack.${i}.damage`, a.damage) ?? ''),
        } }, ok);
      }
      for (let i = 0; i < count('ability', e.abilities.length); i++) {
        const a = e.abilities[i] ?? {}, [text, ok] = field(`ability.${i}.text`, a.text);
        add({ kind: 'ability', text: text ?? '', card, ability: { name: value(`ability.${i}.name`, a.name) ?? '' } }, ok);
      }
    } else if (e.kind === 'trainer') {
      const [text, ok] = field('card_text', e.text);
      add({ kind: 'trainer', text: text ?? '', card }, ok);
    } else if (e.category === 'special') {
      const [text, ok] = field('card_text', e.text);
      add({ kind: 'energy', text: text ?? '', card }, ok);
    }
  }
  return { units: [...units.values()].sort((a, b) => b.uses.length - a.uses.length || a.uid.localeCompare(b.uid)), cards };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { out: { type: 'string', default: join(ROOT, '.data/effect-translation/corpus.jsonl') } } });
  const index = JSON.parse(await readFile(join(ROOT, '.data/card-library/index.json'), 'utf8'));
  const review = (await readFile(join(ROOT, 'catalog/zh-CN/V20261019/library/review/review.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const { units: list, cards } = buildEffectCorpus(index, review);
  await mkdir(dirname(values.out), { recursive: true });
  await writeFile(values.out, list.map((u) => JSON.stringify(u)).join('\n') + '\n');
  const by = Object.groupBy(list, (u) => u.kind);
  console.log(`${list.length} units from ${cards} cards (${Object.entries(by).map(([k, v]) => `${k} ${v.length}`).join(', ')}; `
    + `${list.filter((u) => !u.reviewed).length} with unreviewed text) → ${values.out}`);
}
