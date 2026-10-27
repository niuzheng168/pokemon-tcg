// The metagame's archetypes (ai/archetypes.json), from the tournament lists of ai/meta-decks.json grouped by the deck name
// OmniTCG gives them: for every card name, in how many of the archetype's lists it is and how many copies they play.
// The cards nearly every list plays are the archetype's core (构筑核心); the deck plans (ai/deck-plan.mjs) and the
// deck-building advice read them. Names are data here, never code.
//   node scripts/ai-archetypes.mjs [--min-lists 3] [--min-share 0.15]
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadRelease } from '../server/catalog.mjs';

const { values } = parseArgs({ options: { 'min-lists': { type: 'string', default: '3' }, 'min-share': { type: 'string', default: '0.15' } } });
const meta = JSON.parse(readFileSync(new URL('../ai/meta-decks.json', import.meta.url), 'utf8'));
const release = await loadRelease(), catalog = await release.catalogFor(meta.printings);
const nameOf = (printingId) => catalog.definitionFor(printingId);
const groups = new Map();
for (const d of meta.decks) groups.set(d.name, [...(groups.get(d.name) ?? []), d]);
const archetypes = [];
for (const [name, lists] of groups) {
  if (lists.length < Number(values['min-lists']) || name === '其他') continue;
  const cards = new Map();
  for (const list of lists) {
    const copies = new Map();
    for (const [i, n] of list.cards) { const d = nameOf(meta.printings[i]); copies.set(d.nameKey, { d, n: (copies.get(d.nameKey)?.n ?? 0) + n }); }
    for (const [key, { d, n }] of copies) {
      const c = cards.get(key) ?? { nameKey: key, name: d.name, kind: d.kind, lists: 0, copies: 0 };
      c.lists++; c.copies += n; cards.set(key, c);
    }
  }
  archetypes.push({ name, lists: lists.length, cards: [...cards.values()].map((c) => ({ nameKey: c.nameKey, name: c.name, kind: c.kind,
    share: +(c.lists / lists.length).toFixed(3), copies: +(c.copies / c.lists).toFixed(2) }))
    .filter((c) => c.share >= Number(values['min-share'])).sort((a, b) => b.share - a.share || b.copies - a.copies) });
}
archetypes.sort((a, b) => b.lists - a.lists);
writeFileSync(new URL('../ai/archetypes.json', import.meta.url), `${JSON.stringify({ source: 'ai/meta-decks.json', retrievedOn: meta.retrievedOn, archetypes })}\n`);
for (const a of archetypes) console.log(`${String(a.lists).padStart(4)}  ${a.name}: core ${a.cards.filter((c) => c.share >= 0.9).map((c) => c.name).join('、')}`);
