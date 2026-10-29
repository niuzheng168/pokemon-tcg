// A simplified-Chinese tournament list on OmniTCG, ready to add to the deck pool: mapped to the release's printings
// (set code + number, the name checked), with its implementation tiers and any card the release lacks. Prints the entry
// for ai/training-decks.json and the one for catalog/zh-CN/V20261019/pool-decks.mjs (the release's preset decks); the
// deck-playbook skill (.claude/skills/deck-playbook) says where they go. Find a list with scripts/ai-meta-archetypes.mjs
// (its champions give deck and tournament ids).
//   node scripts/omni-deck.mjs <deck id> <slug> [tournament id]     e.g. 702955 gholdengo-dudunsparce 3748
import { loadRelease } from '../server/catalog.mjs';

const API = 'https://omnitcg.top/api/v1/jz';
const [deckId, slug, tour] = process.argv.slice(2);
if (!deckId || !slug) throw new Error('Usage: node scripts/omni-deck.mjs <deck id> <slug> [tournament id]');
const get = async (path) => {
  const r = await fetch(`${API}/${path}`, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`OmniTCG ${path}: HTTP ${r.status}`);
  return r.json();
};

const release = await loadRelease(), index = await release.index();
const byKey = new Map(), tierOf = new Map(index.entries.map((e) => [e.printingId, e.tier]));
for (const e of index.entries) {
  const [, set, number] = e.printingId.split(':'), k = `${set}:${number.split('/')[0]}`;
  if (!byKey.has(k)) byKey.set(k, e);
}
const d = await get(`deck/${deckId}`), event = tour ? (await get(`tournaments/${tour}/rankings?limit=1`)).tournament : null;
const counts = new Map(), missing = [];
for (const c of d.deck_structure) {
  const e = byKey.get(`${c.setCode}:${c.cardIndex}`);
  if (!e || e.card.name !== c.cardName) missing.push(`${c.cardName} ${c.setCode} ${c.cardIndex} ×${c.count}`);
  else counts.set(e.printingId, (counts.get(e.printingId) ?? 0) + c.count);
}
const cards = [...counts], total = cards.reduce((n, [, k]) => n + k, 0);
const tiers = cards.reduce((t, [p, n]) => ({ ...t, [tierOf.get(p)]: (t[tierOf.get(p)] ?? 0) + n }), {});
const id = `${slug}-${deckId}`, date = d.event_date.slice(0, 10), retrievedOn = new Date().toISOString().slice(0, 10);
const city = event?.location ?? d.location ?? '', [series, host = ''] = d.event_name.split(' - ');
const place = d.ranking === 1 ? '冠军' : `第${d.ranking}名`, kind = series.includes('城市赛') ? '城市赛' : series;
const source = { url: `${API}/deck/${deckId}`, retrievedOn, deckCode: d.official_deck_code, placing: `${d.ranking}/${d.participants_count}`,
  eventDate: date, event: d.event_name, ...(tour ? { rankings: `${API}/tournaments/${tour}/rankings` } : {}), regulation: d.regulation };

console.log(`${d.deck_name}: ${d.event_name}（${city}）${date}，${place}（${d.participants_count}人）；${total} 张，${JSON.stringify(tiers)}`);
if (missing.length) console.log(`✗ 发布包里没有（不能加入）：\n  ${missing.join('\n  ')}`);
if (total !== 60) console.log(`✗ 只映射到 ${total} 张`);
console.log('\n// ai/training-decks.json（锦标赛卡表放在最后一副 tournament 之后）');
console.log(JSON.stringify({ id, name: d.deck_name, kind: 'tournament', format: d.format_type === 'standard' ? 'standard' : 'open', source, cards }, null, 1));
const q = (s) => `'${String(s).replace(/'/g, "\\'")}'`;
console.log('\n// catalog/zh-CN/V20261019/pool-decks.mjs（POOL_DECKS 里同样的位置）');
console.log(`  ${q(id)}: {
    id: ${q(id)},
    name: ${q(`${d.deck_name}（${series} ${city} ${place}卡表）`)},
    description: ${q(`${city}${kind}（${date}，${d.participants_count}人）${place}的卡表，经 OmniTCG 汇总。`)},
    format: ${d.format_type === 'standard' ? 'STANDARD_FORMAT' : 'OPEN_FORMAT'},
    sources: [
      { kind: 'tournament-deck-list', url: ${q(source.url)}, retrievedOn: ${q(retrievedOn)}, event: ${q(`${series} – ${host}（${city}）`)}, eventDate: ${q(date)}, placing: ${q(source.placing)}, player: ${q(d.player_name)}, deckCode: ${q(d.official_deck_code)}, regulation: ${q(d.regulation)}${tour ? `, rankings: ${q(source.rankings)}` : ''}, note: 'OmniTCG 汇总的简中城市赛结果（名次、玩家与赛事取自该场赛事的排名）；卡表经第三方整理，印刷版本可能经其规范化。' },
    ],
    cards: [
${Array.from({ length: Math.ceil(cards.length / 4) }, (_, i) => `      ${cards.slice(4 * i, 4 * i + 4).map(([p, n]) => `[${q(p)}, ${n}]`).join(', ')},`).join('\n')}
    ],
  },`);
