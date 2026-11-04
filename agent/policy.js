// Shared by the Node server and the Cloudflare Worker: the milestones' acceptance tests
// (telemetry only, never trusted for payment) and the hands' policy.
export const MILESTONES = [
  { n: 1, title: 'Movement + level 1', test: 'Clear all slimes and walk through the door',
    pass: s => s.scene !== 'level1' && !s.gameOver },
  { n: 2, title: 'Boss phases 1-2', test: 'Push the boss through phases 1 and 2 (HP 10 or lower)',
    pass: s => !!s.boss && s.boss.hp <= 10 && !s.gameOver },
  { n: 3, title: 'Boss phase 3 + ending', test: 'Beat phase 3 and reach the ending screen',
    pass: s => s.ending === true },
];

// The policy: what a careful player does, decided from the current game state each step.
export function policy(s) {
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
