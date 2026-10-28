// One turn of a recorded position played again (the trio work, docs/ai/STATUS.md M7): a turn the review found a
// mistake in (scripts/ai-review.mjs --snapshots), played by an agent from the position at its start, with every move,
// and for a planning agent the first moves it compared and their values. To see whether a change finds the better move.
//   node scripts/ai-puzzle.mjs <lost-….states.json> --turn 6 [--agent level:4] [--runs 2] [--seed 1] [--moves 6]
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Simulation, createReviewedGame } from '../public/rules/engine.js';
import { loadRelease } from '../server/catalog.mjs';
import { RULESET } from '../catalog/zh-CN/V20261019/index.mjs';
import { poolDeckList } from '../ai/decks.mjs';
import { makeAgent } from '../ai/agents.mjs';
import { playSafely, stepCounter, TURN_STEP_LIMIT } from '../ai/play.mjs';
import { describer } from '../ai/describe.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { turn: { type: 'string' }, agent: { type: 'string', default: 'level:4' },
  runs: { type: 'string', default: '1' }, seed: { type: 'string', default: '1' }, moves: { type: 'string', default: '6' } } });
const file = JSON.parse(readFileSync(positionals[0], 'utf8'));
const at = file.states.find((s) => s.turn === Number(values.turn)) ?? file.states[0];
const release = await loadRelease();
const { catalog } = await createReviewedGame({ release, decks: file.decks.map(poolDeckList), seed: [1, 3, 5, 7],
  format: Object.freeze({ ...RULESET, id: 'open' }), matchMode: 'normal' });
const say = describer(catalog), me = file.focal;
console.log(`第${at.turn}回合，${file.decks[me]} 对 ${file.decks[1 - me]}（turns: ${file.states.map((s) => s.turn).join(' ')}）`);
console.log(say.state(new Simulation(at.state, catalog).view(me), me).split('\n卡牌说明：')[0]);
for (let run = 0; run < Number(values.runs); run++) {
  const sim = new Simulation(structuredClone(at.state), catalog), count = stepCounter(), rng = [Number(values.seed) + run, 9, 9, 9];
  const agent = makeAgent(values.agent, catalog, [Number(values.seed) + run, 2, 3, 4]);
  console.log(`\n-- ${values.agent}，第 ${run + 1} 次 --`);
  for (let p; (p = sim.actor) !== null && sim.state.turn === at.turn && !sim.state.result;) {
    const n = count(sim, p);
    if (n >= TURN_STEP_LIMIT) break;
    const view = sim.view(p), t0 = performance.now();
    const action = (p === me ? agent : makeAgent('policy:0', catalog)).decide(sim, p, n);
    const ms = performance.now() - t0, played = playSafely(sim, p, action, rng);
    const text = played.type === 'answer' ? say.answer(view, view.pending, played.selected) : say.move(view, p, played);
    // (A move the rules refused, replaced by playSafely.)
    const refused = JSON.stringify(played) !== JSON.stringify(action) ? `（${action.type === 'answer' ? say.answer(view, view.pending, action.selected) : say.move(view, p, action)} 被拒绝）` : '';
    console.log(`${p === me ? '' : '（对手）'}${text}${refused}  ${ms > 50 ? `${(ms / 1000).toFixed(1)}s` : ''}`);
    const moves = p === me ? agent.last?.moves : null;
    if (moves?.length) for (const m of moves.slice(0, Number(values.moves))) {
      const shown = m.action.type === 'answer' ? say.answer(view, view.pending ?? {}, m.action.selected) : say.move(view, p, m.action);
      console.log(`    ${m.value.toFixed(3)}  ${shown}`);
    }
  }
}
process.exit(0);
