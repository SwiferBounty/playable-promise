// Gemini (vision) over plain REST. The key comes from GEMINI_API_KEY, or a proxy that injects it.
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

export const geminiEnabled = () => process.env.GEMINI_DISABLED !== '1';

// parts: strings and { png: Buffer } images. Returns parsed JSON from the model.
export async function askJSON(parts, schema) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.GEMINI_API_KEY) headers['x-goog-api-key'] = process.env.GEMINI_API_KEY;
  const body = {
    contents: [{ role: 'user', parts: parts.map(p => typeof p === 'string' ? { text: p }
      : { inline_data: { mime_type: 'image/png', data: p.png.toString('base64') } }) }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: schema },
  };
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(URL, { method: 'POST', headers, body: JSON.stringify(body) });
    if (r.status === 429 || r.status >= 500) { if (attempt < 3) { await new Promise(s => setTimeout(s, 2000 * (attempt + 1))); continue; } }
    const j = await r.json();
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${j.error?.message}`);
    return JSON.parse(j.candidates[0].content.parts.map(p => p.text || '').join(''));
  }
}
