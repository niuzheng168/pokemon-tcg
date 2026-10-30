// A model's answer, one JSON object, through the Responses API: on Azure AI Foundry (gpt-6-astra by default, the model the
// user chose for writing deck strategies and reviewing games) or on this machine's Codey gateway to GitHub Copilot. The
// AI scripts and the website's language-model levels and coach use it; the key comes from an env file outside the repo
// and is never printed: FOUNDRY_ASTRA_ENV (default /home/zhn/pokemon-tcg/.env.foundry2, the resource with gpt-6-astra)
// or `env` (FOUNDRY_SOL_ENV, /home/zhn/pokemon-tcg/.env.foundry, has the gpt-6.1-sol deployments). An env file with
// CODEY_MODEL_API_KEY (~/.config/codey-machine/copilot.env) is the Codey gateway instead (http://127.0.0.1:4141:
// gpt-6.1-sol, gpt-6-astra and others by their own names). Usage is reported in the chat completions' terms.
import { readFileSync } from 'node:fs';

const envs = new Map();
const load = (file = process.env.FOUNDRY_ASTRA_ENV ?? '/home/zhn/pokemon-tcg/.env.foundry2') => {
  if (!envs.has(file)) envs.set(file, Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).replace(/^export\s+/, '').trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^(["'])(.*)\1$/, '$2')])));
  return envs.get(file);
};

/** `system` and `user` texts → { json, usage, items }; retried on throttling, server errors and timeouts, not on a
 * refused key. `model`: the deployment's name; `env`: the env file of its service; `timeoutMs`: how long one try may
 * take; `signal`: aborts the question (no more tries; the website's coach, when the player has moved on). `user` may be a conversation instead: the input items so far (user messages { role: 'user', content } and the
 * model's earlier output items); `items` is the model's output to append before the next question, with its reasoning
 * encrypted, so the model goes on from what it thought. Neither service keeps the conversation (the gateway refuses
 * `store` and `previous_response_id`): the whole of it is sent every time, its unchanged start read from the cache. */
export async function askJSON(system, user, { model = 'gpt-6-astra', effort = 'high', maxTokens = 32000, env = undefined, tries = 5, cacheKey = undefined,
  timeoutMs = 900000, signal = undefined } = {}) {
  const vars = load(env), conversation = typeof user !== 'string';
  const body = { model, input: [{ role: 'system', content: system }, ...(conversation ? user : [{ role: 'user', content: user }])], reasoning: { effort },
    text: { format: { type: 'json_object' } }, max_output_tokens: maxTokens,
    // Questions sharing a long start (a deck's strategy and card texts) under one key reuse it, cached: a tenth of the
    // input price (without a key the cache was written every time and never read).
    ...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
    ...(conversation ? { store: false, include: ['reasoning.encrypted_content'] } : {}) };
  const service = vars.CODEY_MODEL_API_KEY
    ? { name: 'The Codey gateway', url: `http://127.0.0.1:${process.env.CODEY_COPILOT_PORT || 4141}/v1/responses`, headers: { authorization: `Bearer ${vars.CODEY_MODEL_API_KEY}` },
      // (Copilot refused gpt-6.1-sol for a while once, 「no access to the organization」, then served it again: waited out.)
      refused: async (i) => { if (i === tries - 1) throw new Error('The Codey gateway answered 401.'); await sleep(60000); } }
    : { name: 'Foundry', url: `${vars.AOAI_ENDPOINT.replace(/\/$/, '')}/responses`, headers: { 'api-key': vars.FOUNDRY_KEY },
      refused: () => { throw new Error('Foundry answered 401 (the key may have rotated).'); } };
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(service.url, { method: 'POST', headers: { ...service.headers, 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
      if (r.status === 401) { await service.refused(i); continue; }
      if ([408, 429, 500, 502, 503, 504].includes(r.status)) { if (i < tries - 1) await sleep(Math.min(60000, 5000 * 2 ** i), signal); continue; }
      if (!r.ok) throw new Error(`${service.name} HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
      const data = await r.json(), u = data.usage ?? {};
      const text = data.output_text ?? (data.output ?? []).flatMap((o) => o.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
      return { json: JSON.parse(text), usage: { prompt_tokens: u.input_tokens, prompt_tokens_details: u.input_tokens_details, completion_tokens: u.output_tokens,
        completion_tokens_details: u.output_tokens_details, total_tokens: u.total_tokens },
        items: (data.output ?? []).filter((o) => o.type === 'reasoning' || o.type === 'message') };
    } catch (error) {
      if (signal?.aborted || String(error.message).includes('401') || i === tries - 1) throw error;
      await sleep(5000 * (i + 1), signal);
    }
  }
  throw new Error(`${service.name} did not answer.`);
}
// (Cut short when the question is aborted: the next try fails at once.)
const sleep = (ms, signal) => new Promise((ok) => {
  const t = setTimeout(ok, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); ok(); }, { once: true });
});
