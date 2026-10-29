// The website's language-model levels for 小茂 and its coach (ai/llm-player.mjs; docs/ai/STATUS.md, the three levels
// the user chose: the rule AI, gpt-6.1-sol at low effort, gpt-6-astra at medium; the coach always gpt-6-astra at
// medium, the user's choice too). A level names its model by role
// (`sol`, `astra`); the server's config file (server/main.mjs --llm, kept outside the repo next to the keys) says which
// deployment that is and the env file of its service (Azure AI Foundry, or the machine's Codey gateway to Copilot):
//   { "models": { "sol": { "model": "gpt-6.1-sol", "env": "/home/me/.config/codey-machine/copilot.env" },
//                 "astra": { "model": "gpt-6-astra", "env": "/home/me/.config/codey-machine/copilot.env" } },
//     "coach": { "model": "astra", "effort": "medium" } }         (coach: optional, this is the default)
// A level whose model the config does not name is not offered.
import { readFileSync } from 'node:fs';

/** The rule AI level offered with them (ai/agents.mjs LEVELS: 道馆馆主, the policy, fast). */
export const RULE_LEVEL = 3;
export const LLM_LEVELS = Object.freeze([
  Object.freeze({ level: 6, name: '冠军', model: 'sol', effort: 'low' }),
  Object.freeze({ level: 7, name: '宝可梦大师', model: 'astra', effort: 'medium' }),
]);
export const LLM_COACH = Object.freeze({ model: 'astra', effort: 'medium' });

/**
 * A config ({ models, coach? }, or the path of its JSON file) → { levels: [{ level, name, model, effort, env }], coach:
 * { model, effort, env } | null }: the deployments the levels and the coach use.
 */
export function llmConfig(config) {
  const c = typeof config === 'string' ? JSON.parse(readFileSync(config, 'utf8')) : config ?? {};
  const models = c.models ?? {};
  const resolve = (spec) => {
    const m = models[spec.model];
    return m?.model && m.env ? { ...spec, model: m.model, env: m.env } : null;
  };
  return { levels: LLM_LEVELS.map(resolve).filter(Boolean), coach: resolve({ ...LLM_COACH, ...c.coach }) };
}
