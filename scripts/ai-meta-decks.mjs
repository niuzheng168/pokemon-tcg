// The metagame the AI may know (ai/meta-decks.json): the top lists of recent simplified-Chinese individual tournaments
// on OmniTCG, mapped to the reviewed release's printings. The search guesses an opponent's unseen cards from these
// lists and the opponent's public cards (ai/meta.mjs); it never reads the opponent's own list (docs/ai/STATUS.md, user
// decision 2026-10-27). Cards the release does not have are left out and counted. Responses are cached in --cache.
//   node scripts/ai-meta-decks.mjs [--first 3560] [--last 3800] [--top 8] [--since 2026-09-12] [--cache /tmp/omni-cache]
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadRelease } from '../server/catalog.mjs';

const API = 'https://omnitcg.top/api/v1/jz';
const { values } = parseArgs({ options: { first: { type: 'string', default: '3560' }, last: { type: 'string', default: '3800' },
  top: { type: 'string', default: '8' }, since: { type: 'string', default: '2026-09-12' }, cache: { type: 'string', default: '/tmp/omni-cache' } } });
mkdirSync(values.cache, { recursive: true });

// A response, from the cache or fetched (politely, with retries); null when the API has nothing there.
async function get(path) {
  const file = join(values.cache, `${path.replace(/[^a-z0-9]+/gi, '_')}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise((r) => setTimeout(r, 200 + attempt * 2000));
    try {
      const response = await fetch(`${API}/${path}`, { signal: AbortSignal.timeout(20000) });
      if (response.status === 404) { writeFileSync(file, 'null'); return null; }
      if (!response.ok) continue;
      const body = await response.json();
      writeFileSync(file, JSON.stringify(body));
      return body;
    } catch { /* again */ }
  }
  return null;
}

const release = await loadRelease(), index = await release.index();
const byKey = new Map();
for (const e of index.entries) {
  const [, set, number] = e.printingId.split(':');
  if (!byKey.has(`${set}:${number.split('/')[0]}`)) byKey.set(`${set}:${number.split('/')[0]}`, e);
}
const wanted = [];
for (let t = Number(values.first); t <= Number(values.last); t++) {
  const r = await get(`tournaments/${t}/rankings`), info = r?.tournament;
  if (!info || info.status !== 'ended' || info.is_team || info.event_date.slice(0, 10) < values.since) continue;
  for (const x of r.rankings ?? []) if (x.deck_id && x.ranking <= Number(values.top))
    wanted.push({ deckId: x.deck_id, tournament: String(t), date: info.event_date.slice(0, 10), placing: `${x.ranking}/${info.participants_count}`, name: x.deck_name });
}
const printings = [], slot = new Map(), decks = [];
let unmappedCards = 0;
for (const w of wanted) {
  const d = await get(`deck/${w.deckId}`);
  if (!d?.deck_structure) continue;
  const cards = new Map();
  let unmapped = 0;
  for (const c of d.deck_structure) {
    const e = byKey.get(`${c.setCode}:${c.cardIndex}`);
    if (!e || e.card.name !== c.cardName) { unmapped += c.count; continue; }
    if (!slot.has(e.printingId)) { slot.set(e.printingId, printings.length); printings.push(e.printingId); }
    cards.set(slot.get(e.printingId), (cards.get(slot.get(e.printingId)) ?? 0) + c.count);
  }
  unmappedCards += unmapped;
  decks.push({ id: w.deckId, name: w.name, tournament: w.tournament, date: w.date, placing: w.placing, unmapped, cards: [...cards] });
}
const out = { source: `${API} (top ${values.top} of individual tournaments ${values.first}–${values.last} since ${values.since})`,
  retrievedOn: new Date().toISOString().slice(0, 10), releaseId: release.releaseId, printings, decks };
writeFileSync(new URL('../ai/meta-decks.json', import.meta.url), `${JSON.stringify(out)}\n`);
console.log(`${decks.length} lists (${wanted.length} placings), ${printings.length} printings, ${unmappedCards} cards not in the release ` +
  `(${(unmappedCards / Math.max(1, decks.length)).toFixed(1)} a list)`);
