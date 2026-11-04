// Gemini (vision) over plain REST. The key comes from GEMINI_API_KEY, or a proxy that injects it.
const MODEL = globalThis.process?.env?.GEMINI_MODEL || 'gemini-2.5-flash';
const FALLBACK = 'gemini-2.5-flash-lite'; // used when the main model is overloaded
const urlFor = m => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;

const env = globalThis.process?.env || {};
export const geminiEnabled = () => env.GEMINI_DISABLED !== '1';

// parts: strings and { png } images (a Buffer or a base64 string).
export async function askJSON(parts, schema, { key = env.GEMINI_API_KEY } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['x-goog-api-key'] = key;
  const body = {
    contents: [{ role: 'user', parts: parts.map(p => typeof p === 'string' ? { text: p }
      : { inline_data: { mime_type: 'image/png', data: typeof p.png === 'string' ? p.png : p.png.toString('base64') } }) }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: schema },
  };
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(urlFor(attempt >= 2 ? FALLBACK : MODEL), { method: 'POST', headers, body: JSON.stringify(body) });
    if (r.status === 429 || r.status >= 500) { if (attempt < 3) { await new Promise(s => setTimeout(s, 2000 * (attempt + 1))); continue; } }
    const j = await r.json();
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${j.error?.message}`);
    return JSON.parse(j.candidates[0].content.parts.map(p => p.text || '').join(''));
  }
}
