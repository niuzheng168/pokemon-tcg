// A chat completion from a model on Azure AI Foundry (gpt-6-astra by default, the model the user chose for writing deck
// strategies and reviewing games), answering one JSON object. Only the AI scripts use it; the key comes from an env file
// outside the repo and is never printed: FOUNDRY_ASTRA_ENV (default /home/zhn/pokemon-tcg/.env.foundry2, the resource
// with gpt-6-astra) or `env` (FOUNDRY_SOL_ENV, /home/zhn/pokemon-tcg/.env.foundry, has the gpt-6.1-sol deployments).
// An env file with CODEY_MODEL_API_KEY (~/.config/codey-machine/copilot.env) is this machine's Codey gateway to GitHub
// Copilot instead (http://127.0.0.1:4141, the Responses API: gpt-6.1-sol, gpt-6-astra and others by their own names);
// its usage is reported in the chat completions' terms.
import { readFileSync } from 'node:fs';

const envs = new Map();
const load = (file = process.env.FOUNDRY_ASTRA_ENV ?? '/home/zhn/pokemon-tcg/.env.foundry2') => {
  if (!envs.has(file)) envs.set(file, Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).replace(/^export\s+/, '').trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^(["'])(.*)\1$/, '$2')])));
  return envs.get(file);
};

/** `system` and `user` texts → { json, usage, items }; retried on throttling and server errors, not on a refused key.
 * `model`: the deployment's name; `env`: the env file of its resource. `user` may be a conversation instead: the input
 * items so far (user messages { role: 'user', content } and the model's earlier output items); `items` is the model's
 * output to append before the next question (on the Codey gateway with its reasoning, encrypted, so the model goes on
 * from what it thought; Azure's chat completions keep only the answers). The service keeps no conversation: the whole
 * of it is sent every time, its unchanged start read from the cache. */
export async function askJSON(system, user, { model = 'gpt-6-astra', effort = 'high', maxTokens = 32000, env = undefined, tries = 5, cacheKey = undefined } = {}) {
  const vars = load(env), turns = typeof user === 'string' ? [{ role: 'user', content: user }] : user, conversation = typeof user !== 'string';
  if (vars.CODEY_MODEL_API_KEY) return askCopilot(system, turns, { model, effort, maxTokens, key: vars.CODEY_MODEL_API_KEY, port: process.env.CODEY_COPILOT_PORT || 4141, tries, cacheKey, conversation });
  const { AOAI_ENDPOINT, FOUNDRY_KEY } = vars;
  const chat = (item) => (item.role === 'user' ? [{ role: 'user', content: item.content }]
    : item.type === 'message' ? [{ role: 'assistant', content: item.content.map((c) => c.text ?? '').join('') }] : []);
  const body = { model, messages: [{ role: 'system', content: system }, ...turns.flatMap(chat)], reasoning_effort: effort,
    response_format: { type: 'json_object' }, max_completion_tokens: maxTokens,
    // Questions sharing a long start (a deck's strategy and card texts) under one key reuse it, cached: a tenth of the
    // input price (without a key the cache was written every time and never read).
    ...(cacheKey ? { prompt_cache_key: cacheKey } : {}) };
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${AOAI_ENDPOINT.replace(/\/$/, '')}/chat/completions`, { method: 'POST',
        headers: { 'api-key': FOUNDRY_KEY, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(900000) });
      if (r.status === 401) throw new Error('Foundry answered 401 (the astra key may have rotated).');
      if ([408, 429, 500, 502, 503, 504].includes(r.status)) { await new Promise((ok) => setTimeout(ok, Math.min(60000, 5000 * 2 ** i))); continue; }
      if (!r.ok) throw new Error(`Foundry HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
      const data = await r.json(), text = data.choices[0].message.content;
      return { json: JSON.parse(text), usage: data.usage, items: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] };
    } catch (error) {
      if (String(error.message).includes('401') || i === tries - 1) throw error;
      await new Promise((ok) => setTimeout(ok, 5000 * (i + 1)));
    }
  }
  throw new Error('Foundry did not answer.');
}

// The Codey gateway to Copilot (Responses API), with the same retries.
// (It keeps nothing between calls, store and previous_response_id are refused: a conversation is sent whole.)
async function askCopilot(system, turns, { model, effort, maxTokens, key, port, tries, cacheKey, conversation }) {
  const body = { model, input: [{ role: 'system', content: system }, ...turns], reasoning: { effort },
    text: { format: { type: 'json_object' } }, max_output_tokens: maxTokens, ...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
    ...(conversation ? { store: false, include: ['reasoning.encrypted_content'] } : {}) };
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(900000) });
      // (Copilot refused gpt-6.1-sol for a while once, 「no access to the organization」, then served it again: waited out.)
      if (r.status === 401) { if (i === tries - 1) throw new Error('The Codey gateway answered 401.'); await new Promise((ok) => setTimeout(ok, 60000)); continue; }
      if ([408, 429, 500, 502, 503, 504].includes(r.status)) { await new Promise((ok) => setTimeout(ok, Math.min(60000, 5000 * 2 ** i))); continue; }
      if (!r.ok) throw new Error(`Codey gateway HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
      const data = await r.json(), u = data.usage ?? {};
      const text = data.output_text ?? (data.output ?? []).flatMap((o) => o.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
      return { json: JSON.parse(text), usage: { prompt_tokens: u.input_tokens, prompt_tokens_details: u.input_tokens_details, completion_tokens: u.output_tokens,
        completion_tokens_details: u.output_tokens_details, total_tokens: u.total_tokens },
        items: (data.output ?? []).filter((o) => o.type === 'reasoning' || o.type === 'message') };
    } catch (error) {
      if (i === tries - 1) throw error;
      await new Promise((ok) => setTimeout(ok, 5000 * (i + 1)));
    }
  }
  throw new Error('The Codey gateway did not answer.');
}
