// What a subagent writing or reviewing a deck's 打法要点 reads (the deck-playbook skill, .claude/skills/deck-playbook),
// written to a work directory: per deck <id>.md (its list and the CN card texts the language model reads, ai/describe.mjs),
// <id>-guides.json (its guide points, ai/deck-guides.json, when there are any) and <id>-playbook.json (its playbook, when
// it has one); and opponents.md (the lists and card texts of the pool's tournament decks), meta.md (the archetypes'
// results, from scripts/ai-meta-archetypes.mjs --out) and example-playbook.json (an accepted playbook to follow).
//   node scripts/playbook-materials.mjs <deck id>… [--out /tmp/playbook] [--meta /tmp/playbook/meta.json] [--example raging-bolt-679141]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createReviewedGame } from '../public/rules/engine.js';
import { loadRelease } from '../server/catalog.mjs';
import { RULESET } from '../catalog/zh-CN/V20261019/index.mjs';
import { DECK_POOL, poolDeckList } from '../ai/decks.mjs';
import { describer } from '../ai/describe.mjs';

const { values, positionals: ids } = parseArgs({ allowPositionals: true, options: { out: { type: 'string', default: '/tmp/playbook' },
  meta: { type: 'string' }, example: { type: 'string', default: 'raging-bolt-679141' } } });
const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
for (const id of ids) if (!DECK_POOL[id]) throw new Error(`${id} is not a deck of the pool (ai/decks.mjs DECK_POOL)`);
mkdirSync(values.out, { recursive: true });
const release = await loadRelease();

// A deck's list and every card's text as the model reads it.
async function sheet(id) {
  const list = poolDeckList(id);
  const { game, catalog } = await createReviewedGame({ release, decks: [list, list], seed: [1, 2, 3, 4], format: { ...RULESET, id: 'open' }, matchMode: 'normal' });
  const say = describer(catalog), counts = new Map(), first = new Map();
  for (const c of Object.values(game.snapshot().cards).filter((x) => x.owner === 0)) {
    const name = catalog.definition(c.definitionId).name;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (!first.has(name)) first.set(name, c);
  }
  return `# ${DECK_POOL[id].name}（${id}）\n\n卡表（60 张）：${[...counts].map(([n, k]) => `${n}×${k}`).join('、')}\n\n`
    + `每张卡的国服卡面（模型看到的文字）：\n${[...first.values()].map((c) => `- ${say.cardText(c)}`).join('\n')}\n`;
}

const guides = read('../ai/deck-guides.json').decks, playbooks = read('../ai/deck-playbooks.json').decks;
for (const id of ids) {
  writeFileSync(join(values.out, `${id}.md`), await sheet(id));
  if (guides[id]) writeFileSync(join(values.out, `${id}-guides.json`), `${JSON.stringify(guides[id], null, 1)}\n`);
  if (playbooks[id]) writeFileSync(join(values.out, `${id}-playbook.json`), `${JSON.stringify({ deck: id, ...playbooks[id] }, null, 1)}\n`);
}
// The opponents: the pool's tournament lists (a training list that is a preset again goes by the preset's id).
const listKey = (cards) => cards.map(([p, n]) => `${p}×${n}`).sort().join();
const poolIdOf = (d) => (DECK_POOL[d.id] ? d.id : Object.values(DECK_POOL).find((p) => listKey(p.cards) === listKey(d.cards))?.id);
const opponents = read('./../ai/training-decks.json').decks.filter((d) => d.kind === 'tournament').map(poolIdOf).filter(Boolean);
const sheets = [];
for (const id of new Set(opponents)) sheets.push(await sheet(id));
writeFileSync(join(values.out, 'opponents.md'), sheets.join('\n\n'));
if (values.meta && existsSync(values.meta)) {
  const m = JSON.parse(readFileSync(values.meta, 'utf8')), first = m.events[0]?.date, last = m.events.at(-1)?.date;
  const players = m.archetypes.reduce((n, a) => n + a.players, 0);
  writeFileSync(join(values.out, 'meta.md'), `简中个人赛（OmniTCG，${first} 到 ${last}，${m.events.length} 场标准赛，${players} 人）各卡组成绩：人数、占比、`
    + '进前 8 次数和相对使用率的倍数（×1 为平均）、冠军次数和倍数、平均名次分位（50 为中游）。\n\n'
    + m.archetypes.filter((a) => a.players >= 40).map((a) => `- ${a.name}：${a.players} 人（${(100 * a.share).toFixed(1)}%），前8 ${a.top8} 次 ×${a.top8Ratio.toFixed(2)}，`
      + `冠军 ${a.wins} 次 ×${a.winRatio.toFixed(2)}，名次分位 ${(100 * a.percentile).toFixed(1)}`).join('\n') + '\n');
}
writeFileSync(join(values.out, 'example-playbook.json'), `${JSON.stringify({ [values.example]: playbooks[values.example] }, null, 1)}\n`);
console.log(`${values.out}: ${ids.length} decks, ${new Set(opponents).size} opponents${values.meta ? ', meta' : ''}, example ${values.example}`);
