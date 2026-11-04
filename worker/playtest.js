// The playtest agent on Cloudflare: the same hands and eyes as agent/playtest.js, but the
// browser is Cloudflare Browser Rendering and frames stay base64 (no filesystem on Workers).
import puppeteer from '@cloudflare/puppeteer';
import { MILESTONES, policy } from '../agent/policy.js';
import { planChecks, judgeFrames } from '../agent/judge.js';

// Free plan limits how fast new browsers start; wait and retry instead of failing the run.
async function launch(env) {
  for (let attempt = 0; ; attempt++) {
    try { return await puppeteer.launch(env.BROWSER); }
    catch (e) { if (!/429|rate limit/i.test(e.message) || attempt >= 4) throw e; await new Promise(r => setTimeout(r, 15000)); }
  }
}

export async function playtest(env, buildUrl, milestone, { maxSteps = 4000, promises } = {}) {
  const runId = `m${milestone}-${Date.now()}`;
  const browser = await launch(env);
  const log = [], frames = [];
  const t0 = Date.now();
  let state, crashed = null;
  const passedAt = {}; // telemetry: what the build SAYS happened (never trusted for payment)
  let page;
  const snap = async label => {
    if (frames.length >= 8) frames.shift();
    const png = await page.screenshot({ encoding: 'base64' }).catch(() => null);
    if (png) frames.push({ tick: state?.tick ?? 0, label, png });
  };
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 760, height: 320 });
    await page.goto(buildUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__game);
    state = await page.evaluate(() => window.__game.state());
    await snap('start');
    const targets = MILESTONES.filter(m => m.n <= milestone);
    let lastScene = state.scene, lastPhase = null;
    for (let i = 0; i < maxSteps; i += 20) {
      const r = await page.evaluate((src, n) => {
        const policy = new Function('return (' + src + ')')();
        let s = window.__game.state();
        try { for (let j = 0; j < n && !s.ending && !s.gameOver; j++) s = window.__game.step(policy(s)); }
        catch (e) { return { s: window.__game.state(), err: String(e.message || e) }; }
        return { s };
      }, policy.toString(), 20);
      state = r.s;
      if (state.scene !== lastScene) { log.push(`tick ${state.tick}: entered ${state.scene}`); lastScene = state.scene; await snap(`entered ${state.scene}`); }
      if (state.boss && state.boss.phase !== lastPhase) { log.push(`tick ${state.tick}: boss phase ${state.boss.phase}`); lastPhase = state.boss.phase; await snap(`boss phase ${state.boss.phase}`); }
      for (const m of MILESTONES) if (m.n <= milestone && !passedAt[m.n] && m.pass(state)) { passedAt[m.n] = state.tick; log.push(`tick ${state.tick}: build reports M${m.n} done`); }
      if (r.err) { crashed = r.err; log.push(`tick ${state.tick}: CRASH ${r.err}`); break; }
      if (state.ending || state.gameOver || targets.every(m => passedAt[m.n])) break;
    }
    if (!crashed) await page.evaluate(() => { for (let j = 0; j < 30; j++) try { window.__game.step({}); } catch {} });
  } catch (e) { crashed = crashed || String(e.message || e); }
  if (page) await snap(crashed ? 'after crash' : 'final screen');
  await browser.close().catch(() => {});
  frames.forEach((f, i) => { f.i = i + 1; f.file = `runs/${runId}/f${f.i}.png`; });

  const telemetry = MILESTONES.filter(m => m.n <= milestone).map(m => ({ milestone: m.n, reported: !!passedAt[m.n] }));
  const telemetryPass = telemetry.every(t => t.reported) && !crashed;

  // Judge this milestone's promise. Earlier milestones were already verified from their own runs;
  // here the agent replays them only to reach this one (a crash on the way still fails the run).
  const list = promises || MILESTONES;
  const current = list.find(m => m.n === milestone);
  const promise = `M${milestone}: ${current.test}` + (milestone > 1
    ? ` (Earlier milestones, already verified separately, are replayed first to reach this point: ${list.filter(m => m.n < milestone).map(m => `M${m.n}: ${m.test}`).join('; ')}. Judge only M${milestone}; enemies or scenes from later stages are expected.)` : '');
  let ai = null, aiError = null;
  if (env.GEMINI_API_KEY && env.GEMINI_DISABLED !== '1') {
    try {
      const opts = { key: env.GEMINI_API_KEY };
      const checks = await planChecks(promise, opts);
      const j = await judgeFrames(promise, checks, frames, opts);
      ai = { checks: checks.map(c => ({ ...c, ...(j.checks.find(x => x.id === c.id) || { met: false, why: 'not judged' }) })), kept: j.kept, summary: j.summary };
    } catch (e) { aiError = e.message; log.push(`AI judge unavailable: ${e.message}`); }
  } else aiError = 'GEMINI_API_KEY not set';
  // With the AI judge configured but unreachable, never pay on the build's word: hold until it can look.
  const aiRequired = !!env.GEMINI_API_KEY && env.GEMINI_DISABLED !== '1';
  const passed = ai ? ai.kept && !crashed : (!aiRequired && telemetryPass);
  const tamper = ai && telemetryPass && !ai.kept;
  const verdict = crashed
    ? `Promise broken: the build crashed at tick ${state?.tick} (${crashed}). Backers are not charged.`
    : tamper
      ? `Promise NOT kept. The build reported success, but the screen shows otherwise: ${ai.summary} Backers are not charged.`
      : passed
        ? `Promise kept: ${ai ? ai.summary : 'all acceptance tests passed (AI judge offline, telemetry only).'}`
        : !ai && aiRequired ? `On hold: the AI judge could not look at this build (${aiError}). Nobody is charged on the build's own word. Submit it again.`
        : `Promise not kept: ${ai ? ai.summary : 'acceptance tests failed.'} Backers are not charged.`;
  return { runId, buildUrl, milestone, promise, passed, tamper: !!tamper, verdict, ai, aiError, telemetry, log, crashed,
    frames, screenshot: frames.at(-1)?.file, finalState: state, ms: Date.now() - t0 };
}
