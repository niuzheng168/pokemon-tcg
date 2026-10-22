// The units of effect translation for the whole card library: every distinct printed effect (scripts/effect-units.mjs)
// with the cards that print it. Texts are the card review's accepted wording (scripts/card_review.py compare →
// .data/card-review/review.jsonl), else the library's, marked unreviewed.
//   node scripts/effect-corpus.mjs   → .data/effect-translation/corpus.jsonl
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unitOf } from './effect-units.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CN = { Grass: '草', Fire: '火', Water: '水', Lightning: '雷', Psychic: '超', Fighting: '斗', Darkness: '恶', Metal: '钢', Dragon: '龙', Fairy: '妖', Colorless: '无' };
const index = JSON.parse(await readFile(join(ROOT, '.data/card-library/index.json'), 'utf8'));
const review = new Map((await readFile(join(ROOT, '.data/card-review/review.jsonl'), 'utf8')).split('\n').filter(Boolean)
  .map((l) => JSON.parse(l)).map((r) => [r.id, r]));

const units = new Map();
let cards = 0;
for (const e of index.entries.filter((x) => !x.duplicateOf)) {
  const r = review.get(e.id), accepted = r?.accepted ?? {};
  // The accepted value of a field as written, else the library's, with whether it was accepted.
  const field = (f, fallback) => (f in accepted ? [accepted[f].value ?? '', true] : [fallback ?? '', false]);
  const card = { name: e.name, kind: e.kind, stage: e.stage, hp: e.hp, category: accepted.category?.value ?? e.category };
  const add = (u, reviewed) => {
    if (!u.text) return;
    const unit = unitOf(u), have = units.get(unit.uid);
    if (have) { have.uses.push(e.cardId); have.reviewed ||= reviewed; return; }
    units.set(unit.uid, { ...unit, uses: [e.cardId], reviewed });
  };
  cards++;
  if (e.kind === 'pokemon') {
    e.attacks.forEach((a, i) => {
      const [text, ok] = field(`attack.${i}.text`, a.text);
      const [dmg] = field(`attack.${i}.damage`, a.damage);
      add({ kind: 'attack', text, card, attack: { name: a.name, cost: a.cost.map((c) => CN[c]).join(''), damage: String(dmg ?? '') } }, ok);
    });
    e.abilities.forEach((a, i) => {
      const [text, ok] = field(`ability.${i}.text`, a.text);
      add({ kind: 'ability', text, card, ability: { name: a.name } }, ok);
    });
  } else if (e.kind === 'trainer') {
    const [text, ok] = field('card_text', e.text);
    add({ kind: 'trainer', text, card }, ok);
  } else if (e.category === 'special') {
    const [text, ok] = field('card_text', e.text);
    add({ kind: 'energy', text, card }, ok);
  }
}
const list = [...units.values()].sort((a, b) => b.uses.length - a.uses.length || a.uid.localeCompare(b.uid));
await mkdir(join(ROOT, '.data/effect-translation'), { recursive: true });
await writeFile(join(ROOT, '.data/effect-translation/corpus.jsonl'), list.map((u) => JSON.stringify(u)).join('\n') + '\n');
const by = Object.groupBy(list, (u) => u.kind);
console.log(`${list.length} units from ${cards} cards (${Object.entries(by).map(([k, v]) => `${k} ${v.length}`).join(', ')}; `
  + `${list.filter((u) => !u.reviewed).length} with unreviewed text) → .data/effect-translation/corpus.jsonl`);
