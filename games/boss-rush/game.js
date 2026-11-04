// Boss Rush: a tiny demo game with milestone builds, selected by ?build=m1|m2|m3|m3-broken.
// It exposes window.__game so the playtest agent can read the state and drive inputs in fixed steps.
(() => {
  const BUILD = new URLSearchParams(location.search).get('build') || 'm3';
  const HAS_BOSS = BUILD !== 'm1';
  const HAS_PHASE3 = BUILD === 'm3' || BUILD === 'm3-broken' || BUILD === 'm3-liar';
  // m3-liar: phase 3 is unfinished, but the build's self-report claims the ending was reached.
  const LIAR = BUILD === 'm3-liar';
  const W = 720, H = 240, FLOOR = 200, DOOR = 640;
  const cv = document.getElementById('c'), ctx = cv.getContext('2d');

  const g = {
    build: BUILD, tick: 0, scene: 'level1', errors: [],
    player: { x: 20, y: FLOOR, vy: 0, hp: 5, cd: 0, inv: 0 },
    slimes: [{ x: 220, hp: 2 }, { x: 380, hp: 2 }, { x: 520, hp: 2 }],
    boss: null, shots: [], ending: false, gameOver: false,
  };

  function startBoss() {
    g.scene = 'boss'; g.player.x = 20; g.shots = [];
    g.boss = { x: 560, hp: 30, phase: 1, cd: 60 };
  }

  function step(keys = {}) {
    if (g.ending || g.gameOver) return snapshot();
    g.tick++;
    const p = g.player;
    if (keys.left) p.x = Math.max(0, p.x - 3);
    if (keys.right) p.x = Math.min(W - 20, p.x + 3);
    if (keys.jump && p.y >= FLOOR) p.vy = -9;
    p.vy += 0.6; p.y = Math.min(FLOOR, p.y + p.vy); if (p.y >= FLOOR) p.vy = 0;
    if (p.cd > 0) p.cd--; if (p.inv > 0) p.inv--;
    const attacking = keys.attack && p.cd === 0; if (attacking) p.cd = 12;

    if (g.scene === 'level1') {
      for (const s of g.slimes) {
        if (s.hp <= 0) continue;
        if (attacking && s.x - p.x > 0 && s.x - p.x < 40) s.hp--;
        if (Math.abs(s.x - p.x) < 14 && p.y > FLOOR - 10) hurt();
      }
      if (p.x >= DOOR && g.slimes.every(s => s.hp <= 0)) {
        if (HAS_BOSS) startBoss(); else g.scene = 'level1-clear';
      }
      if (p.x >= DOOR - 20 && g.slimes.some(s => s.hp > 0)) p.x = DOOR - 20; // locked door
    } else if (g.scene === 'boss') {
      const b = g.boss;
      const floorHp = HAS_PHASE3 ? 0 : 10; // m2 build: boss can't be pushed past phase 2
      if (attacking && b.x - p.x > 0 && b.x - p.x < 50) b.hp = Math.max(floorHp, b.hp - 1);
      b.phase = b.hp > 20 ? 1 : b.hp > 10 ? 2 : 3;
      if (b.phase === 3 && BUILD === 'm3-broken') {
        // The planted regression: phase 3 reads an attack table that was never added.
        const pattern = undefined; pattern.next();
      }
      if (--b.cd <= 0) { g.shots.push({ x: b.x - 10, vx: -(3 + b.phase), y: FLOOR }); b.cd = 70 - b.phase * 15; }
      for (const s of g.shots) s.x += s.vx;
      g.shots = g.shots.filter(s => s.x > -10);
      for (const s of g.shots) if (Math.abs(s.x - p.x) < 10 && p.y > FLOOR - 12) { hurt(); s.x = -99; }
      if (Math.abs(b.x - p.x) < 20) { hurt(); p.x = Math.max(0, p.x - 30); }
      if (LIAR) b.hp = Math.max(10, b.hp); // phase 3 never actually finishes
      if (b.hp <= 0) g.ending = true;
    }
    if (p.hp <= 0) g.gameOver = true;
    return snapshot();
  }
  function hurt() { const p = g.player; if (p.inv === 0) { p.hp--; p.inv = 40; } }

  function snapshot() {
    const p = g.player, b = g.boss;
    return {
      build: g.build, tick: g.tick, scene: g.scene, ending: g.ending || (LIAR && !!b && b.phase === 3), gameOver: g.gameOver,
      player: { x: p.x, y: p.y, hp: p.hp, canAttack: p.cd === 0 },
      slimes: g.slimes.filter(s => s.hp > 0).map(s => ({ x: s.x })),
      boss: b && { x: b.x, hp: b.hp, phase: b.phase },
      shots: g.shots.map(s => ({ x: s.x, vx: s.vx })), errors: g.errors.slice(),
    };
  }

  function draw() {
    ctx.fillStyle = '#12101c'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#3a3550'; ctx.fillRect(0, FLOOR + 20, W, H);
    const p = g.player;
    ctx.fillStyle = p.inv % 6 < 3 ? '#7ee0c3' : '#fff'; ctx.fillRect(p.x, p.y, 20, 20);
    if (g.scene === 'level1') {
      ctx.fillStyle = '#8bd450'; for (const s of g.slimes) if (s.hp > 0) ctx.fillRect(s.x, FLOOR + 8, 18, 12);
      ctx.fillStyle = g.slimes.every(s => s.hp <= 0) ? '#f5c542' : '#6b5d3a'; ctx.fillRect(DOOR, FLOOR - 20, 20, 40);
    }
    if (g.boss) {
      const b = g.boss; ctx.fillStyle = ['#e0607e', '#e08a3c', '#c04cf0'][b.phase - 1]; ctx.fillRect(b.x, FLOOR - 40, 40, 60);
      ctx.fillStyle = '#fff'; ctx.fillRect(b.x, FLOOR - 50, (b.hp / 30) * 40, 4);
      ctx.fillStyle = '#ff5'; for (const s of g.shots) ctx.fillRect(s.x, FLOOR + 6, 10, 6);
    }
    ctx.fillStyle = '#ddd'; ctx.font = '14px monospace';
    ctx.fillText(`build ${g.build}  hp ${p.hp}  ${g.scene}${g.boss ? '  boss ' + g.boss.hp + ' (phase ' + g.boss.phase + ')' : ''}`, 10, 20);
    if (g.ending) ctx.fillText('THE END: thanks for backing!', 260, 110);
    if (g.gameOver) ctx.fillText('GAME OVER', 320, 110);
  }

  // Human play: keyboard plus requestAnimationFrame. Agent play: window.__game.step().
  const held = {}; let human = false;
  addEventListener('keydown', e => { human = true; held[e.key] = true; });
  addEventListener('keyup', e => { held[e.key] = false; });
  function loop() {
    if (human) { try { step({ left: held.ArrowLeft, right: held.ArrowRight, jump: held.ArrowUp || held[' '], attack: held.z || held.x }); } catch (e) { g.errors.push(String(e)); } }
    draw(); requestAnimationFrame(loop);
  }
  window.__game = {
    step(keys) { try { return step(keys); } catch (e) { g.errors.push(String(e.message || e)); throw e; } finally { draw(); } },
    state: snapshot,
  };
  loop();
})();
