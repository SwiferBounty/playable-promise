// One playtest run, shared by the Cloudflare Worker (puppeteer on Browser Run) and Node (playwright).
// Hands: the AI pilot plays from pixels (default), or the fast scripted policy for Boss Rush (mode 'script').
// Eyes: a separate AI judge decides from the screenshots alone. The build's own self-report is telemetry only.
import { MILESTONES, policy } from './policy.js';
import { CLOCK_SHIM } from './clock.js';
import { pilot } from './pilot.js';
import { planChecks, judgeFrames } from './judge.js';

const MAX_FRAMES = 8;

// page adapter: { inject(src), goto(url), evaluate(fn, arg), shot(): base64, down(key), up(key) }
export async function runPlaytest(page, { buildUrl, milestone, promises, key, aiRequired, mode = 'ai', maxTurns, onEvent = () => {} }) {
  const runId = `m${milestone}-${Date.now()}`;
  const t0 = Date.now();
  const log = [], frames = [];
  const emit = e => { try { onEvent(e); } catch {} };
  const say = text => { log.push(text); emit({ type: 'log', text }); };
  let crashed = null, state = null, agent = null;
  const frameNo = { n: 0 };
  // Look at the game, not the page: the largest canvas, if the game has one.
  let clip = null;
  const findClip = async () => {
    clip = await page.evaluate(() => {
      const c = [...document.querySelectorAll('canvas')].map(e => e.getBoundingClientRect()).sort((a, b) => b.width * b.height - a.width * a.height)[0];
      if (!c || c.width < 200) return null;
      const x = Math.max(0, c.left - 8), y = Math.max(0, c.top - 8);
      return { x, y, width: Math.min(innerWidth - x, c.width + 16), height: Math.min(innerHeight - y, c.height + 16) };
    }).catch(() => null);
  };
  const shot = () => page.shot(clip);
  const snap = async label => {
    const png = await shot().catch(() => null);
    if (!png) return;
    const f = { tick: state?.tick ?? frameNo.n, label, png, n: ++frameNo.n };
    frames.push(f);
    if (frames.length > MAX_FRAMES) frames.splice(1, 1); // keep the first frame and the latest ones
    emit({ type: 'frame', label, png, n: f.n });
  };
  const hasGame = () => page.evaluate(() => !!window.__game).catch(() => false);
  const readState = async () => (await hasGame()) ? page.evaluate(() => window.__game.state()) : null;

  // The promise the judge holds the build to: this milestone, with context for earlier ones.
  const list = promises || MILESTONES;
  const current = list.find(m => m.n === milestone) || { test: String(milestone) };
  const promise = `M${milestone}: ${current.test}` + (milestone > 1
    ? ` (Earlier milestones, already verified separately, are replayed first to reach this point: ${list.filter(m => m.n < milestone).map(m => `M${m.n}: ${m.test}`).join('; ')}. Judge only M${milestone}.)` : '');

  try {
    await page.inject(CLOCK_SHIM);
    await page.goto(buildUrl);
    await page.evaluate(() => window.__clock.advance(30)); // let the game boot
    await findClip();
    state = await readState();
    await snap('start');
    if (mode === 'script' && await hasGame()) {
      say('Hands: scripted policy (fast mode)');
      let lastScene = state.scene, lastPhase = null;
      for (let i = 0; i < 4000; i += 20) {
        const r = await page.evaluate(([src, n]) => {
          const policy = new Function('return (' + src + ')')();
          let s = window.__game.state();
          try { for (let j = 0; j < n && !s.ending && !s.gameOver; j++) s = window.__game.step(policy(s)); }
          catch (e) { return { s: window.__game.state(), err: String(e.message || e) }; }
          return { s };
        }, [policy.toString(), 20]);
        state = r.s;
        if (state.scene !== lastScene) { say(`tick ${state.tick}: entered ${state.scene}`); lastScene = state.scene; await snap(`entered ${state.scene}`); }
        if (state.boss && state.boss.phase !== lastPhase) { say(`tick ${state.tick}: boss phase ${state.boss.phase}`); lastPhase = state.boss.phase; await snap(`boss phase ${state.boss.phase}`); }
        if (r.err) { crashed = r.err; say(`tick ${state.tick}: CRASH ${r.err}`); break; }
        const targets = MILESTONES.filter(m => m.n <= milestone);
        if (state.ending || state.gameOver || targets.every(m => m.pass(state))) break;
      }
    } else {
      say('Hands: AI pilot, playing from the screen only');
      const driver = {
        shot,
        // The pilot's own copy of the screen gets a ruler drawn over it; evidence frames never do.
        rulerShot: async () => {
          await page.evaluate(() => {
            const c = document.createElement('canvas'); c.id = '__ruler';
            c.width = innerWidth; c.height = innerHeight;
            Object.assign(c.style, { position: 'fixed', left: 0, top: 0, pointerEvents: 'none', zIndex: 2147483647 });
            const g = c.getContext('2d'); g.font = '11px monospace';
            const box = (document.querySelector('canvas:not(#__ruler)') || document.body).getBoundingClientRect();
            const scale = (document.querySelector('canvas:not(#__ruler)')?.width || box.width) / box.width;
            for (let x = 0; x * (1 / scale) <= box.width; x += 50) {
              const sx = box.left + x / scale;
              g.strokeStyle = 'rgba(255,255,0,.35)'; g.beginPath(); g.moveTo(sx, box.top); g.lineTo(sx, box.bottom); g.stroke();
              g.fillStyle = 'rgba(255,255,0,.9)'; g.fillText(String(x), sx + 2, box.bottom - 3);
            }
            document.body.appendChild(c);
          });
          const png = await shot();
          await page.evaluate(() => document.getElementById('__ruler')?.remove());
          return png;
        },
        text: () => page.evaluate(() => document.body.innerText || ''),
        errors: () => page.evaluate(() => window.__clock.errors.slice()),
        hold: async (keys, n) => {
          for (const k of keys) await page.down(k);
          // Advance in small slices so key events land between frames.
          for (let left = n; left > 0; left -= 10) await page.evaluate(m => window.__clock.advance(m), Math.min(10, left));
          for (const k of keys) await page.up(k);
        },
      };
      // Like a human tester, the pilot gets up to 3 attempts. After a game over it reloads and
      // carries a lesson from how it died into the next attempt. The judge sees the last attempt.
      const lessons = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (attempt > 1) {
          say(`Attempt ${attempt}: reloading the build and trying again`);
          emit({ type: 'attempt', attempt });
          frames.length = 0; frameNo.n = 0;
          await page.goto(buildUrl); await page.evaluate(() => window.__clock.advance(30)); await findClip();
          await snap(`attempt ${attempt} start`);
        }
        agent = await pilot(driver, { promise, key, maxTurns: maxTurns || (10 + milestone * 10), onEvent: e => emit({ ...e, attempt }), snap, lessons });
        say(`Attempt ${attempt}: pilot played ${agent.turns} turns (${agent.steps} moves), ${agent.outcome}`);
        agent.attempts = attempt;
        if (agent.outcome !== 'game_over') break;
        lessons.push(`it ended in game over. Last thing seen: ${agent.lastSeen}`);
      }
      state = await readState();
      const errs = await page.evaluate(() => window.__clock.errors.slice()).catch(() => []);
      if (errs.length) { crashed = errs[0]; say(`page error: ${errs[0]}`); }
    }
    if (!crashed) await page.evaluate(() => window.__clock.advance(30));
  } catch (e) { crashed = crashed || String(e.message || e); say(`run error: ${crashed}`); }
  state = (await readState().catch(() => null)) || state;
  await snap(crashed ? 'after crash' : 'final screen');
  frames.forEach((f, i) => { f.i = i + 1; f.file = `runs/${runId}/f${f.i}.png`; });

  // Telemetry: what the build SAYS happened (Boss Rush exposes it; other games don't). Never trusted for payment.
  const telemetry = state ? MILESTONES.filter(m => m.n <= milestone).map(m => ({ milestone: m.n, reported: !!m.pass(state) })) : [];
  const telemetryPass = telemetry.length > 0 && telemetry.every(t => t.reported) && !crashed;

  let ai = null, aiError = null;
  if (key || !aiRequired) {
    try {
      emit({ type: 'log', text: 'Judge: checking the evidence frames against the promise' });
      const checks = await planChecks(promise, { key });
      const j = await judgeFrames(promise, checks, frames, { key });
      ai = { checks: checks.map(c => ({ ...c, ...(j.checks.find(x => x.id === c.id) || { met: false, why: 'not judged' }) })), kept: j.kept, summary: j.summary };
    } catch (e) { aiError = e.message; say(`AI judge unavailable: ${e.message}`); }
  } else aiError = 'GEMINI_API_KEY not set';
  const passed = ai ? ai.kept && !crashed : (!aiRequired && telemetryPass);
  const tamper = !!(ai && telemetryPass && !ai.kept);
  // The agent lost every attempt before it could see the milestone: that's its own skill, not proof the build is broken.
  const inconclusive = !passed && !tamper && !crashed && agent?.outcome === 'game_over';
  const verdict = crashed
    ? `Promise broken: the build crashed (${crashed}). Backers are not charged.`
    : tamper ? `Promise NOT kept. The build reported success, but the screen shows otherwise: ${ai.summary} Backers are not charged.`
    : inconclusive ? `Not verified yet: my agent lost all ${agent.attempts} attempts before it could see this milestone. That is not proof the build is broken, so nobody is charged and the creator can resubmit.`
    : passed ? `Promise kept: ${ai ? ai.summary : 'all acceptance tests passed (AI judge offline, telemetry only).'}`
    : !ai && aiRequired ? `On hold: the AI judge could not look at this build (${aiError}). Nobody is charged on the build's own word. Submit it again.`
    : `Promise not kept: ${ai ? ai.summary : 'acceptance tests failed.'} Backers are not charged.`;
  const report = { runId, buildUrl, milestone, promise, mode, passed, tamper, inconclusive, verdict, ai, aiError, telemetry, log, crashed, agent,
    frames, screenshot: frames.at(-1)?.file, finalState: state, ms: Date.now() - t0 };
  emit({ type: 'verdict', passed, tamper, verdict });
  return report;
}
