// The gold set for scripts/card_review.py: the hand-reviewed CN/V20261019 printings (card faces checked against the
// local images, docs/rules/zh-CN/V20261019/cards/) written as the fields the image readers produce.
//   node scripts/card-review-gold.mjs   → .data/card-review/gold.json
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../server/catalog.mjs';
import { damageText } from '../public/match.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CN = { Grass: '草', Fire: '火', Water: '水', Lightning: '雷', Psychic: '超', Fighting: '斗', Darkness: '恶', Metal: '钢', Dragon: '龙', Fairy: '妖', Colorless: '无' };
const slug = (id) => id.split(':').at(-1);
const meta = JSON.parse(await readFile(join(ROOT, 'public/data/cn/V20261019/decks.json'), 'utf8'));
const catalog = await loadCatalog();
const gold = {};
for (const p of catalog.printings()) {
  const d = catalog.definitionFor(p.printingId), m = d.mechanics, t = meta.cards[p.printingId]?.texts ?? {};
  const g = { kind: d.kind, name: d.name, number: p.number, mark: p.regulationMark };
  if (d.kind === 'pokemon') {
    const evolvesFrom = m.evolvesFrom && catalog.definitions().find((x) => x.nameKey === m.evolvesFrom)?.name;
    Object.assign(g, { hp: m.hp, type: CN[m.types[0]], stage: m.stage, evolves_from: evolvesFrom ?? null, retreat: m.retreatCost,
      weakness: m.weakness ? { type: CN[m.weakness.type], value: `×${m.weakness.value}` } : null,
      resistance: m.resistance ? { type: CN[m.resistance.type], value: `-${m.resistance.value}` } : null,
      abilities: m.abilities.map((a) => ({ name: a.name, text: t[slug(a.abilityId)] ?? '' })),
      attacks: m.attacks.map((a) => ({ name: a.name, cost: a.cost.map((x) => CN[x]), damage: damageText(a.printedDamage), text: t[slug(a.attackId)] ?? '' })) });
  } else {
    g.card_text = t.card ?? '';
  }
  gold[p.printingId] = g;
}
await mkdir(join(ROOT, '.data/card-review'), { recursive: true });
await writeFile(join(ROOT, '.data/card-review/gold.json'), JSON.stringify(gold, null, 1));
console.log(`Wrote ${Object.keys(gold).length} gold printings to .data/card-review/gold.json`);
