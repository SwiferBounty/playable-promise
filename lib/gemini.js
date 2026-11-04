// Gemini-family models (vision) over plain REST. The key comes from GEMINI_API_KEY, or a dev proxy that injects it.
// Each role has a chain of models. Free-tier quotas are per model, so when one is out of quota or
// overloaded, the next one takes over.
const env = globalThis.process?.env || {};
export const MODELS = {
  judge: ['gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-flash-latest', 'gemini-2.5-flash', 'gemma-4-31b-it'],
  pilot: [...(env.PILOT_MODEL ? [env.PILOT_MODEL] : []), 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemma-4-31b-it', 'gemini-robotics-er-2-preview'],
};
const urlFor = m => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;
export const geminiEnabled = () => env.GEMINI_DISABLED !== '1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// parts: strings and { png } images (a Buffer or a base64 string).
export async function askJSON(parts, schema, { key = env.GEMINI_API_KEY, role = 'judge' } = {}) {
  const chain = MODELS[role] || MODELS.judge;
  const contents = parts.map(p => typeof p === 'string' ? { text: p }
    : { inline_data: { mime_type: 'image/png', data: typeof p.png === 'string' ? p.png : p.png.toString('base64') } });
  let lastErr; const errs = [];
  for (const model of chain) {
    const gemma = model.startsWith('gemma');
    // Gemma has no JSON-schema mode: ask for the shape in words and parse the reply.
    const body = {
      contents: [{ role: 'user', parts: gemma ? [...contents, { text: `Reply with only a JSON object (no prose, no code fence) matching this schema: ${JSON.stringify(schema)}` }] : contents }],
      generationConfig: gemma ? { temperature: 0 } : { temperature: 0, responseMimeType: 'application/json', responseSchema: schema },
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = { 'Content-Type': 'application/json' };
      let url = urlFor(model);
      if (env.GEMINI_PROXY_URL) { url = `${env.GEMINI_PROXY_URL}/${model}`; headers['x-dev-token'] = env.GEMINI_PROXY_TOKEN; }
      else if (key) headers['x-goog-api-key'] = key;
      let r, j;
      try { r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) }); j = await r.json(); }
      catch (e) { lastErr = new Error(`${model}: ${e.message}`); await sleep(1500); continue; }
      if (r.ok) {
        const text = (j.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
        try { return JSON.parse(gemma ? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1) : text); }
        catch { lastErr = new Error(`${model}: reply was not JSON`); continue; }
      }
      lastErr = new Error(`Gemini ${r.status} (${model}): ${String(j.error?.message || '').split('\n')[0].slice(0, 160)}`);
      errs.push(`${model} ${r.status}${/per day|PerDay/i.test(j.error?.message || '') ? ' daily quota' : ''}`);
      const daily = /per day|PerDay/i.test(j.error?.message || '');
      if (r.status === 429 && !daily && attempt === 0) { await sleep(8000); continue; } // per-minute limit: wait once
      if (r.status >= 500 && attempt === 0) { await sleep(4000); continue; }
      break; // daily quota, not found, or still failing: next model
    }
  }
  throw new Error(errs.length ? `all models busy or out of free quota (${errs.join(', ')})` : lastErr?.message);
}
