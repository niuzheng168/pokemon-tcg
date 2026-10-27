// A chat completion from a model on Azure AI Foundry (gpt-6-astra by default, the model the user chose for writing deck
// strategies and reviewing games), answering one JSON object. Only the AI scripts use it; the key comes from
// FOUNDRY_ASTRA_ENV (default /home/zhn/pokemon-tcg/.env.foundry2) and is never printed.
import { readFileSync } from 'node:fs';

let env = null;
const load = () => (env ??= Object.fromEntries(readFileSync(process.env.FOUNDRY_ASTRA_ENV ?? '/home/zhn/pokemon-tcg/.env.foundry2', 'utf8')
  .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])));

/** `system` and `user` texts → { json, usage }; retried on throttling and server errors, not on a refused key. */
export async function askJSON(system, user, { model = 'gpt-6-astra', effort = 'high', maxTokens = 32000 } = {}) {
  const { AOAI_ENDPOINT, FOUNDRY_KEY } = load();
  const body = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], reasoning_effort: effort,
    response_format: { type: 'json_object' }, max_completion_tokens: maxTokens };
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(`${AOAI_ENDPOINT.replace(/\/$/, '')}/chat/completions`, { method: 'POST',
        headers: { 'api-key': FOUNDRY_KEY, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(900000) });
      if (r.status === 401) throw new Error('Foundry answered 401 (the astra key may have rotated).');
      if ([408, 429, 500, 502, 503, 504].includes(r.status)) { await new Promise((ok) => setTimeout(ok, 5000 * 2 ** i)); continue; }
      if (!r.ok) throw new Error(`Foundry HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
      const data = await r.json();
      return { json: JSON.parse(data.choices[0].message.content), usage: data.usage };
    } catch (error) {
      if (String(error.message).includes('401') || i === 4) throw error;
      await new Promise((ok) => setTimeout(ok, 5000 * (i + 1)));
    }
  }
  throw new Error('Foundry did not answer.');
}
