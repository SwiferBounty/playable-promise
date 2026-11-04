// Playtest agent: hands + eyes. The hands (a fast policy) play the build in a real headless browser;
// the eyes (Gemini vision, agent/judge.js) decide from screenshots alone whether the promise was kept.
// The build's own self-report is logged as telemetry but never trusted for payment.
// Originally: opens a milestone build in a real headless browser, plays it with a
// perception-action loop (read the game state, choose inputs, step), and checks the
// milestone's acceptance tests. Milestone N must pass tests 1..N (no regressions).
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { planChecks, judgeFrames } from './judge.js';
import { geminiEnabled } from '../lib/gemini.js';
import { pathToFileURL } from 'node:url';
import { MILESTONES, policy } from './policy.js';
export { MILESTONES };

export async function playtest(buildUrl, milestone, { maxSteps = 4000, outDir = 'runs', promises } = {}) {
  const runId = `m${milestone}-${Date.now()}`;
  const dir = `${outDir}/${runId}`;
  mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH === '' ? {} : { executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' }) });
  const page = await browser.newPage({ viewport: { width: 760, height: 320 } });
  const log = [], frames = [];
  const t0 = Date.now();
  let state, crashed = null;
  const passedAt = {}; // telemetry: what the build SAYS happened (never trusted for payment)
  const snap = async label => {
    if (frames.length >= 8) frames.shift(); // keep the latest evidence
    const png = await page.screenshot().catch(() => null);
    if (png) frames.push({ tick: state?.tick ?? 0, label, png });
  };
  try {
    await page.goto(buildUrl);
    await page.waitForFunction(() => !!window.__game);
    state = await page.evaluate(() => window.__game.state());
    await snap('start');
    const targets = MILESTONES.filter(m => m.n <= milestone);
    let lastScene = state.scene, lastPhase = null;
    for (let i = 0; i < maxSteps; i += 20) {
      // The hands: 20 inputs per round trip, chosen fresh each step.
      const r = await page.evaluate(([src, n]) => {
        const policy = new Function('return (' + src + ')')();
        let s = window.__game.state();
        try { for (let j = 0; j < n && !s.ending && !s.gameOver; j++) s = window.__game.step(policy(s)); }
        catch (e) { return { s: window.__game.state(), err: String(e.message || e) }; }
        return { s };
      }, [policy.toString(), 20]);
      state = r.s;
      if (state.scene !== lastScene) { log.push(`tick ${state.tick}: entered ${state.scene}`); lastScene = state.scene; await snap(`entered ${state.scene}`); }
      if (state.boss && state.boss.phase !== lastPhase) { log.push(`tick ${state.tick}: boss phase ${state.boss.phase}`); lastPhase = state.boss.phase; await snap(`boss phase ${state.boss.phase}`); }
      for (const m of MILESTONES) if (m.n <= milestone && !passedAt[m.n] && m.pass(state)) { passedAt[m.n] = state.tick; log.push(`tick ${state.tick}: build reports M${m.n} done`); }
      if (r.err) { crashed = r.err; log.push(`tick ${state.tick}: CRASH ${r.err}`); break; }
      if (state.ending || state.gameOver || targets.every(m => passedAt[m.n])) break;
    }
    // Keep playing briefly so the screen settles on what really happened.
    if (!crashed) { await page.evaluate(() => { for (let j = 0; j < 30; j++) try { window.__game.step({}); } catch {} }); }
  } catch (e) { crashed = crashed || String(e.message || e); }
  await snap(crashed ? 'after crash' : 'final screen');
  await browser.close();
  frames.forEach((f, i) => { f.i = i + 1; f.file = `${dir}/f${f.i}.png`; writeFileSync(f.file, f.png); });

  const telemetry = MILESTONES.filter(m => m.n <= milestone).map(m => ({ milestone: m.n, reported: !!passedAt[m.n] }));
  const telemetryPass = telemetry.every(t => t.reported) && !crashed;

  // The eyes: the AI judges the promise from the screenshots alone.
  // Judge this milestone's promise. Earlier milestones were already verified from their own runs;
  // here the agent replays them only to reach this one (a crash on the way still fails the run).
  const list = promises || MILESTONES;
  const current = list.find(m => m.n === milestone);
  const promise = `M${milestone}: ${current.test}` + (milestone > 1
    ? ` (Earlier milestones, already verified separately, are replayed first to reach this point: ${list.filter(m => m.n < milestone).map(m => `M${m.n}: ${m.test}`).join('; ')}. Judge only M${milestone}; enemies or scenes from later stages are expected.)` : '');
  let ai = null, aiError = null;
  if (geminiEnabled()) {
    try {
      const checks = await planChecks(promise);
      const j = await judgeFrames(promise, checks, frames);
      ai = { checks: checks.map(c => ({ ...c, ...(j.checks.find(x => x.id === c.id) || { met: false, why: 'not judged' }) })), kept: j.kept, summary: j.summary };
    } catch (e) { aiError = e.message; log.push(`AI judge unavailable: ${e.message}`); }
  }
  const passed = ai ? ai.kept && !crashed : telemetryPass;
  const tamper = ai && telemetryPass && !ai.kept;
  const verdict = crashed
    ? `Promise broken: the build crashed at tick ${state?.tick} (${crashed}). Backers are not charged.`
    : tamper
      ? `Promise NOT kept. The build reported success, but the screen shows otherwise: ${ai.summary} Backers are not charged.`
      : passed
        ? `Promise kept: ${ai ? ai.summary : 'all acceptance tests passed (AI judge offline, telemetry only).'}`
        : `Promise not kept: ${ai ? ai.summary : 'acceptance tests failed.'} Backers are not charged.`;
  return { runId, buildUrl, milestone, promise, passed, tamper: !!tamper, verdict, ai, aiError, telemetry, log, crashed,
    frames: frames.map(({ i, tick, label, file }) => ({ i, tick, label, file })), screenshot: frames.at(-1)?.file,
    finalState: state, ms: Date.now() - t0 };
}

// CLI: node agent/playtest.js <build> <milestone>
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [build = 'm3', m = '3'] = process.argv.slice(2);
  const url = build.startsWith('http') ? build : pathToFileURL('public/games/boss-rush/index.html').href + `?build=${build}`;
  const r = await playtest(url, Number(m));
  console.log(JSON.stringify({ passed: r.passed, tamper: r.tamper, verdict: r.verdict, ai: r.ai, telemetry: r.telemetry, log: r.log, frames: r.frames, ms: r.ms }, null, 2));
}
