// Playtest agent: opens a milestone build in a real headless browser, plays it with a
// perception-action loop (read the game state, choose inputs, step), and checks the
// milestone's acceptance tests. Milestone N must pass tests 1..N (no regressions).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MILESTONES = [
  { n: 1, title: 'Movement + level 1', test: 'Clear all slimes and walk through the door',
    pass: s => s.scene !== 'level1' && !s.gameOver },
  { n: 2, title: 'Boss phases 1-2', test: 'Push the boss through phases 1 and 2 (HP 10 or lower)',
    pass: s => !!s.boss && s.boss.hp <= 10 && !s.gameOver },
  { n: 3, title: 'Boss phase 3 + ending', test: 'Beat phase 3 and reach the ending screen',
    pass: s => s.ending === true },
];

// The policy: what a careful player does, decided from the current game state each step.
function policy(s) {
  const p = s.player, k = {};
  const target = s.scene === 'level1'
    ? (s.slimes.find(e => e.x > p.x - 5) ?? { x: 660, door: true })
    : s.boss ? { x: s.boss.x, boss: true } : null;
  if (!target) return k;
  const d = target.x - p.x;
  const keep = target.door ? -99 : target.boss ? 34 : 26; // stand-off distance
  if (d > keep + 4) k.right = true; else if (d < keep - 4) k.left = true;
  if (!target.door && d > 0 && d < (target.boss ? 50 : 40) && p.canAttack) k.attack = true;
  const threat = s.shots.find(sh => sh.x > p.x && sh.x - p.x < 12 - sh.vx * 4);
  if (threat && p.y >= 200) k.jump = true;
  return k;
}

export async function playtest(buildUrl, milestone, { maxSteps = 4000, outDir = 'runs' } = {}) {
  const runId = `m${milestone}-${Date.now()}`;
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
  const page = await browser.newPage({ viewport: { width: 760, height: 320 } });
  const consoleErrors = [];
  page.on('pageerror', e => consoleErrors.push(e.message));
  const log = [];
  const t0 = Date.now();
  let state, crashed = null;
  const passedAt = {}; // milestone -> tick it was first verified (latched)
  try {
    await page.goto(buildUrl);
    await page.waitForFunction(() => !!window.__game);
    state = await page.evaluate(() => window.__game.state());
    const targets = MILESTONES.filter(m => m.n <= milestone);
    let lastScene = state.scene, lastPhase = null;
    for (let i = 0; i < maxSteps; i += 20) {
      // 20 steps per round trip: the policy runs inside the page on fresh state every step.
      const r = await page.evaluate(([src, n]) => {
        const policy = eval('(' + src + ')');
        let s = window.__game.state();
        try { for (let j = 0; j < n && !s.ending && !s.gameOver; j++) s = window.__game.step(policy(s)); }
        catch (e) { return { s: window.__game.state(), err: String(e.message || e) }; }
        return { s };
      }, [policy.toString(), 20]);
      state = r.s;
      if (state.scene !== lastScene) { log.push(`tick ${state.tick}: entered ${state.scene}`); lastScene = state.scene; }
      if (state.boss && state.boss.phase !== lastPhase) { log.push(`tick ${state.tick}: boss phase ${state.boss.phase} (HP ${state.boss.hp})`); lastPhase = state.boss.phase; }
      for (const m of MILESTONES) if (m.n <= milestone && !passedAt[m.n] && m.pass(state)) { passedAt[m.n] = state.tick; log.push(`tick ${state.tick}: M${m.n} test passed`); }
      if (r.err) { crashed = r.err; log.push(`tick ${state.tick}: CRASH ${r.err}`); break; }
      if (state.ending || state.gameOver || targets.every(m => passedAt[m.n])) break;
    }
  } catch (e) { crashed = crashed || String(e.message || e); }
  const shot = `${outDir}/${runId}.png`;
  await page.screenshot({ path: shot }).catch(() => {});
  await browser.close();

  const results = MILESTONES.filter(m => m.n <= milestone).map(m => ({
    milestone: m.n, title: m.title, test: m.test, passed: !!passedAt[m.n] && !crashed, tick: passedAt[m.n] ?? null,
  }));
  const passed = results.every(r => r.passed);
  const verdict = passed
    ? `Milestone ${milestone} verified: every acceptance test through M${milestone} passed in ${state.tick} ticks with ${state.player.hp} HP left.`
    : crashed
      ? `Milestone ${milestone} rejected: the build crashed at tick ${state?.tick} (${crashed}). Backers are not charged.`
      : `Milestone ${milestone} rejected: ${results.filter(r => !r.passed).map(r => `"${r.test}"`).join(', ')} did not pass. Backers are not charged.`;
  return { runId, buildUrl, milestone, passed, verdict, results, log, crashed, screenshot: shot,
    finalState: state, ms: Date.now() - t0 };
}

// CLI: node agent/playtest.js <build> <milestone>
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [build = 'm3', m = '3'] = process.argv.slice(2);
  const url = build.startsWith('http') ? build : pathToFileURL('games/boss-rush/index.html').href + `?build=${build}`;
  const r = await playtest(url, Number(m));
  console.log(JSON.stringify({ passed: r.passed, verdict: r.verdict, log: r.log, ms: r.ms }, null, 2));
}
