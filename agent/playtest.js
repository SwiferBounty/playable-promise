// The playtest agent in Node: local Chromium (playwright) drives agent/run.js.
// CLI: node agent/playtest.js <build|url> <milestone> [ai|script]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runPlaytest } from './run.js';
import { geminiEnabled } from '../lib/gemini.js';
export { MILESTONES } from './policy.js';

export async function playtest(buildUrl, milestone, { outDir = 'runs', ...opts } = {}) {
  const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH === '' ? {} : { executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' }) });
  try {
    const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const page = {
      inject: src => p.addInitScript(src),
      goto: url => p.goto(url),
      evaluate: (fn, arg) => p.evaluate(fn, arg),
      shot: async clip => (await p.screenshot(clip ? { clip } : {})).toString('base64'),
      down: k => p.keyboard.down(k), up: k => p.keyboard.up(k),
    };
    const aiRequired = geminiEnabled() && !!(process.env.GEMINI_API_KEY || process.env.GEMINI_PROXY_URL);
    const r = await runPlaytest(page, { buildUrl, milestone, key: process.env.GEMINI_API_KEY || (aiRequired ? 'proxy' : null), aiRequired, ...opts });
    mkdirSync(`${outDir}/${r.runId}`, { recursive: true });
    for (const f of r.frames) { writeFileSync(f.file.replace(/^runs/, outDir), Buffer.from(f.png, 'base64')); }
    return { ...r, frames: r.frames.map(({ png, ...f }) => f) };
  } finally { await browser.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [build = 'm3', m = '3', mode = 'ai'] = process.argv.slice(2);
  const url = build.startsWith('http') ? build : pathToFileURL('public/games/boss-rush/index.html').href + `?build=${build}`;
  const r = await playtest(url, Number(m), { mode, onEvent: e => e.type === 'think' ? console.error(`[pilot ${e.turn} ${e.ms}ms] ME: ${e.me} | SEE: ${e.see} -> ${e.plan.map(s => (s.keys.join('+') || 'wait') + 'x' + s.frames).join(' ')}${e.done ? ' DONE' : ''}`) : e.type === 'log' ? console.error('[log]', e.text) : 0 });
  console.log(JSON.stringify({ passed: r.passed, tamper: r.tamper, verdict: r.verdict, ai: r.ai, telemetry: r.telemetry, log: r.log, frames: r.frames, ms: r.ms }, null, 2));
}
