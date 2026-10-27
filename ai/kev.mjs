// Kev (the language model fine-tuned on search choices, docs/ai/STATUS.md M4) as an arena player, to measure how well it
// plays: in its own main phase it reads the position and the policy's favourite moves in words (describe.mjs), the same
// question as its training records, and plays the move it rates highest. Requests, and a turn with one distinct move,
// are the policy's. The model is served by `kev.serve` (its System One API) at `url`; games are played synchronously, so
// the call is too (curl). A failed call throws: the arena counts that game as an error, never as the policy's game.
import { execFileSync } from 'node:child_process';
import { randomIndex } from '../public/rules/random.js';
import { createPolicy } from './policy.mjs';
import { describer, MOVE_QUESTION } from './describe.mjs';
import { moveKey, shortlistOf } from './search.mjs';

export function kevAgent(catalog, { url, shortlist = 8, seed = [3, 1, 4, 1], name = `kev(${url})` } = {}) {
  if (!url) throw new TypeError('A Kev player needs the URL of its server.');
  const policy = createPolicy(catalog, { seed }), said = describer(catalog), rng = [...seed].reverse();
  const ask = (state, criteria) => {
    const body = JSON.stringify({ state, questions: { move: { type: 'choice', instructions: MOVE_QUESTION, criteria } } });
    const out = JSON.parse(execFileSync('curl', ['-sS', '--fail', '--max-time', '300', '-H', 'content-type: application/json',
      '--data-binary', '@-', `${url.replace(/\/$/, '')}/v1/systemone`], { input: body, maxBuffer: 1 << 24 }).toString('utf8'));
    return (out.answers ?? out).move.probabilities;
  };
  const agent = { name, asked: 0, decide: (sim, me, steps) => {
    const view = sim.view(me);
    if (view.result || view.pending || sim.state.phase !== 'main' || steps > 40) return policy(view, me, steps);
    const legal = [...new Map(view.legalActions.filter((a) => a.type !== 'concede').map((a) => [moveKey(sim.state, a), a])).values()];
    // Moves that read the same are one option, as in the training records.
    const byText = new Map();
    for (const a of shortlistOf(policy, view, me, sim.state, legal, shortlist)) { const t = said.move(view, me, a); if (!byText.has(t)) byText.set(t, a); }
    if (byText.size <= 1) return policy(view, me, steps);
    // In a random order, as in training: the policy's favourite is not always the first option.
    const moves = [...byText];
    for (let i = moves.length - 1; i > 0; i--) { const j = randomIndex(rng, i + 1); [moves[i], moves[j]] = [moves[j], moves[i]]; }
    const p = ask(said.state(view, me), Object.fromEntries(moves.map(([t], i) => [`m${i}`, t])));
    agent.asked++;
    return moves[moves.reduce((b, _, i) => ((p[`m${i}`] ?? 0) > (p[`m${b}`] ?? 0) ? i : b), 0)][1];
  } };
  return agent;
}
