// How each archetype does in recent simplified-Chinese individual tournaments on OmniTCG: the full standings of every
// event whose players all have a deck name, so an archetype's results are counted against everyone who played it (the
// site's own /meta counts only the lists it has, mostly the top cut). Per archetype: players, share, top 8 (and against
// its share: ×1 is as often as its players would by chance), wins (likewise) and the mean placing percentile (50 is
// the middle of the field). Responses are cached in --cache.
//   node scripts/ai-meta-archetypes.mjs [--first 3600] [--last 3950] [--since 2026-09-29] [--min 40] [--out file.json]
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const API = 'https://omnitcg.top/api/v1/jz';
const { values } = parseArgs({ options: { first: { type: 'string', default: '3600' }, last: { type: 'string', default: '3950' },
  since: { type: 'string', default: '2026-09-29' }, min: { type: 'string', default: '40' }, out: { type: 'string' },
  cache: { type: 'string', default: '/tmp/omni-full' } } });
mkdirSync(values.cache, { recursive: true });

// A response, from the cache or fetched (politely, with retries); null when the API has nothing there.
async function get(path) {
  const file = join(values.cache, `${path.replace(/[^a-z0-9]+/gi, '_')}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise((r) => setTimeout(r, 150 + attempt * 2000));
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

// The events: ended, individual, the current regulation, every player's deck named (a page holds at most 200).
const events = [];
for (let t = Number(values.first), misses = 0; t <= Number(values.last) && misses <= 40; t++) {
  const r = await get(`tournaments/${t}/rankings?limit=200`), info = r?.tournament;
  if (!info) { misses++; continue; }
  misses = 0;
  if (info.status !== 'ended' || info.is_team || info.event_date.slice(0, 10) < values.since || info.regulation !== 'GHIJ') continue;
  const rows = [...(r.rankings ?? [])];
  for (let more = r.has_more, offset = 200; more; offset += 200) {
    const page = await get(`tournaments/${t}/rankings?limit=200&offset=${offset}`);
    rows.push(...(page?.rankings ?? []));
    more = page?.has_more;
  }
  if (rows.length >= 16 && rows.filter((x) => x.deck_name).length >= 0.95 * rows.length) events.push({ t, date: info.event_date.slice(0, 10), n: rows.length, rows });
}

const byName = new Map();
for (const e of events) for (const x of e.rows) {
  if (!x.deck_name) continue;
  const a = byName.get(x.deck_name) ?? { players: 0, top8: 0, expected8: 0, wins: 0, percentile: 0, champions: [] };
  a.players++;
  a.expected8 += Math.min(8, e.n) / e.n;
  a.percentile += 1 - (x.ranking - 1) / (e.n - 1);
  if (x.ranking <= 8) a.top8++;
  if (x.ranking === 1) { a.wins++; a.champions.push({ tournament: e.t, deck: x.deck_id, players: e.n, date: e.date }); }
  byName.set(x.deck_name, a);
}
const total = [...byName.values()].reduce((s, a) => s + a.players, 0);
const archetypes = [...byName].map(([name, a]) => ({ name, players: a.players, share: a.players / total, top8: a.top8,
  top8Ratio: a.top8 / a.expected8, wins: a.wins, winRatio: a.wins / ((a.players / total) * events.length), percentile: a.percentile / a.players,
  champions: a.champions })).sort((x, y) => y.players - x.players);
console.log(`${events.length} events ${events[0]?.date}–${events.at(-1)?.date}, ${total} players`);
for (const a of archetypes.filter((x) => x.players >= Number(values.min))) {
  console.log(`${a.name.padEnd(20)} ${String(a.players).padStart(5)} ${(100 * a.share).toFixed(1).padStart(5)}%  top 8 ${String(a.top8).padStart(3)} ×${a.top8Ratio.toFixed(2)}`
    + `  wins ${String(a.wins).padStart(3)} ×${a.winRatio.toFixed(2)}  percentile ${(100 * a.percentile).toFixed(1)}`);
}
if (values.out) writeFileSync(values.out, `${JSON.stringify({ source: API, retrievedOn: new Date().toISOString().slice(0, 10),
  events: events.map(({ rows, ...e }) => e), archetypes }, null, 1)}\n`);
