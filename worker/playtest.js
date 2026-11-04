// The playtest agent on Cloudflare: Browser Run (puppeteer) drives agent/run.js.
import puppeteer from '@cloudflare/puppeteer';
import { runPlaytest } from '../agent/run.js';

// Free plan limits how fast new browsers start; wait and retry instead of failing the run.
async function launch(env) {
  for (let attempt = 0; ; attempt++) {
    try { return await puppeteer.launch(env.BROWSER); }
    catch (e) { if (!/429|rate limit/i.test(e.message) || attempt >= 4) throw e; await new Promise(r => setTimeout(r, 15000)); }
  }
}

export async function playtest(env, buildUrl, milestone, opts = {}) {
  const browser = await launch(env);
  try {
    const p = await browser.newPage();
    await p.setViewport({ width: 1280, height: 720 });
    const page = {
      inject: src => p.evaluateOnNewDocument(src),
      goto: url => p.goto(url, { waitUntil: 'load' }),
      evaluate: (fn, arg) => p.evaluate(fn, arg),
      shot: clip => p.screenshot({ encoding: 'base64', ...(clip ? { clip } : {}) }),
      down: k => p.keyboard.down(k), up: k => p.keyboard.up(k),
    };
    const aiRequired = !!env.GEMINI_API_KEY && env.GEMINI_DISABLED !== '1';
    return await runPlaytest(page, { buildUrl, milestone, key: aiRequired ? env.GEMINI_API_KEY : null, aiRequired, ...opts });
  } finally { await browser.close().catch(() => {}); }
}
