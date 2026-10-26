// Kev training records (docs/ai/STATUS.md, M4) from search self-play (scripts/ai-selfplay.mjs --kev): every position where
// the search compared two moves or more becomes a choice question over those moves, in kev.train's --data shape
// ({ state, questions: { move: { type: 'choice', instructions, criteria, label, target } } }). The target is a softmax
// over the search's win chances at --temperature (moves the search barely tells apart share the weight); the label is
// the best move. The search lists its moves best first, so the options are shuffled (by a hash of the game, turn and
// record, the same every run). Games with a number ending in 0 go to the held-out file.
//   node scripts/ai-kev-data.mjs <dir|kev-*.jsonl.gz>… --out <dir> [--temperature 0.03]
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: opt, positionals } = parseArgs({ allowPositionals: true, options: {
  out: { type: 'string' }, temperature: { type: 'string', default: '0.03' } } });
if (!opt.out || !positionals.length) throw new Error('Usage: node scripts/ai-kev-data.mjs <dir|file>… --out <dir> [--temperature 0.03]');
const temperature = Number(opt.temperature);
const INSTRUCTIONS = '你是正在行动的一方。下面哪个走法最有可能让你赢下这局？';

const files = positionals.flatMap((p) => statSync(p).isDirectory()
  ? readdirSync(p).filter((f) => /^kev-.*\.jsonl\.gz$/.test(f)).sort().map((f) => join(p, f)) : [p]);
const out = { train: [], heldout: [] };
let skipped = 0, record = 0;
// A small seeded generator (mulberry32) for the shuffles.
const generator = (seed) => () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
};
for (const file of files) {
  for (const line of gunzipSync(readFileSync(file)).toString('utf8').split('\n')) {
    if (!line) continue;
    const e = JSON.parse(line);
    // Moves that read the same (two copies of a card on different Pokémon may) are one option.
    const moves = [...new Map(e.moves.map((m) => [m.text, m])).values()];
    if (moves.length < 2) { skipped++; continue; }
    const random = generator(Math.imul(e.g + 1, 0x9e3779b1) ^ Math.imul(e.turn + 1, 0x85ebca77) ^ record++);
    for (let i = moves.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [moves[i], moves[j]] = [moves[j], moves[i]]; }
    const top = Math.max(...moves.map((m) => m.value)), weights = moves.map((m) => Math.exp((m.value - top) / temperature));
    const sum = weights.reduce((a, b) => a + b, 0), keys = moves.map((_, i) => `m${i}`);
    const best = moves.findIndex((m) => m.value === top);
    out[e.g % 10 === 0 ? 'heldout' : 'train'].push(JSON.stringify({ state: e.state, questions: { move: {
      type: 'choice', instructions: INSTRUCTIONS, criteria: Object.fromEntries(moves.map((m, i) => [keys[i], m.text])),
      label: keys[best], target: Object.fromEntries(weights.map((w, i) => [keys[i], Math.round((w / sum) * 1e4) / 1e4])) } },
      _meta: { group_id: `game/${e.g}` } }));
  }
}
mkdirSync(opt.out, { recursive: true });
for (const [name, lines] of Object.entries(out)) writeFileSync(join(opt.out, `${name}.jsonl`), lines.length ? `${lines.join('\n')}\n` : '');
console.log(`${files.length} files: ${out.train.length} training and ${out.heldout.length} held-out records, ${skipped} positions with one distinct move left out`);
