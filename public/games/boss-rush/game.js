// Boss Rush: a tiny demo game with milestone builds, selected by ?build=m1|m2|m3|m3-broken|m3-liar.
// It exposes window.__game so the playtest agent can read the state and drive inputs in fixed steps.
// Gameplay (step/snapshot) is deterministic and tick-driven. Everything below draw() is presentation
// only: it reads g, never writes it, and its animation runs off g.tick (or the rAF frame counter on
// frozen end screens), so a controlled clock still works.
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
        if (attacking && s.x - p.x > -16 && s.x - p.x < 44) s.hp--;
        if (Math.abs(s.x - p.x) < 14 && p.y > FLOOR - 10) hurt();
      }
      if (p.x >= DOOR && g.slimes.every(s => s.hp <= 0)) {
        if (HAS_BOSS) startBoss(); else g.scene = 'level1-clear';
      }
      if (p.x >= DOOR - 20 && g.slimes.some(s => s.hp > 0)) p.x = DOOR - 20; // locked door
    } else if (g.scene === 'boss') {
      const b = g.boss;
      const floorHp = HAS_PHASE3 ? 0 : 10; // m2 build: boss can't be pushed past phase 2
      if (attacking && b.x - p.x > -20 && b.x - p.x < 56) b.hp = Math.max(floorHp, b.hp - 1);
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

  // ───────────────────────────── Presentation ─────────────────────────────
  ctx.imageSmoothingEnabled = false;
  const GROUND = FLOOR + 20; // top of the floor surface (player feet)

  // Deterministic RNG for decoration and particles (never wall-clock).
  function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  // Pixel sprites: one char per pixel, '.' is transparent.
  const HERO = [
    '...RR.....',
    '..KKKKK...',
    '.KHHHHHK..',
    '.KHHVVVK..',
    '.KhHHHHK..',
    'CCKBBBBK..',
    'CCBBBGBbK.',
    '.CKBBBbK..',
  ];
  const HERO_LEGS = [
    ['..KLK.KLK.', '..KK...KK.'],
    ['..KLKKLK..', '...KK.KK..'],
    ['.KLK...KLK', '.KK.....KK'],
  ];
  const HERO_PAL = { K: '#1a1426', H: '#dfe7f2', h: '#8794ab', V: '#2a2440', C: '#e0475b', B: '#3fc6a0', b: '#24806a', G: '#ffd35a', L: '#4a4266', R: '#ff6b7d' };

  const SLIME = [
    '...KKK...',
    '..KGGGK..',
    '.KGwGGwK.',
    'KGGpGGpGK',
    'KGGGGGGgK',
    '.KKKKKKK.',
  ];
  const SLIME_PAL = { K: '#16241a', G: '#86d64f', g: '#4f9a2c', w: '#f4ffe8', p: '#1a2a12' };

  const BOSS = [
    '....................',
    '....................',
    '......G..G..G.......',
    '......GGGGGGG.......',
    '.....KGRGGGRGK......',
    '....KDDDDDDDDDK.....',
    '....KDEEDDDEEDK.....',
    '....KDDDDDDDDDK.....',
    '....KDDDMMMDDDK.....',
    '.....KDDDDDDDK......',
    '...KKAAAKKKAAAKK....',
    '..KAAAAAAAAAAAAAK...',
    '.KAAaAAAAAAAAAaAAK..',
    'KAAaaAAAGGGAAAaaAAK.',
    'KAAaKAAAGEGAAAKaAAK.',
    'KAAaKAAAGGGAAAKaAAK.',
    'KAAaKAAAAAAAAAKaAAK.',
    'KCCaKAAAAAAAAAKaCCK.',
    'KCCCKAaaaaaaaAKCCCK.',
    'KCCCKAAAAAAAAAKCCCK.',
    'KCCC.KDDDDDDDK.CCCK.',
    'KCCC.KAAAAAAAK.CCCK.',
    '.KCC.KAAKKKAAK.CCK..',
    '.KCC.KAAK.KAAK.CCK..',
    '..KC.KAAK.KAAK.CK...',
    '..KC.KAAK.KAAK.CK...',
    '...K.KaaK.KaaK.K....',
    '.....KaaK.KaaK......',
    '....KAAAK.KAAAK.....',
    '....KKKKK.KKKKK.....',
  ];
  const PHASES = [
    { name: 'PHASE 1', A: '#b8324a', a: '#701c30', C: '#3b1430', E: '#ffd23f', D: '#1c1222', glow: '#ff4d6a', shot: ['#fff4a8', '#ffb03a', '#e0402a'], sky: ['#1a0c16', '#3a1020', '#6a1a2a'], tint: 'rgba(255,60,80,0.10)' },
    { name: 'PHASE 2', A: '#e07a2c', a: '#94461a', C: '#4a1f12', E: '#fff36b', D: '#1f140e', glow: '#ff9a3c', shot: ['#ffffff', '#ffe06b', '#ff7a1a'], sky: ['#1c0e08', '#4a1c0a', '#a0401a'], tint: 'rgba(255,140,40,0.12)' },
    { name: 'PHASE 3', A: '#8a3cf0', a: '#4d1c9a', C: '#160c2e', E: '#6ff7ff', D: '#0c0818', glow: '#b45cff', shot: ['#ffffff', '#9ffcff', '#a040ff'], sky: ['#06030f', '#1a0838', '#3c1070'], tint: 'rgba(150,70,255,0.16)' },
  ];

  const HEART = ['.KK.KK.', 'KRRKRWK', 'KRRRRRK', '.KRRRK.', '..KRK..', '...K...'];

  function sprite(rows, pal, x, y, s, flip, solid) {
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r], n = row.length;
      for (let c = 0; c < n; c++) {
        const ch = row[c]; if (ch === '.') continue;
        ctx.fillStyle = solid || pal[ch] || '#f0f';
        ctx.fillRect(Math.round(x + (flip ? n - 1 - c : c) * s), Math.round(y + r * s), s, s);
      }
    }
  }

  function text(str, x, y, { size = 12, color = '#fff', align = 'left', outline = '#0b0a12', bold = true } = {}) {
    ctx.font = `${bold ? 'bold ' : ''}${size}px "DejaVu Sans Mono", "Courier New", monospace`;
    ctx.textAlign = align; ctx.textBaseline = 'middle';
    if (outline) { ctx.fillStyle = outline; for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2], [-1, -1], [1, 1], [-1, 1], [1, -1]]) ctx.fillText(str, x + dx, y + dy); }
    ctx.fillStyle = color; ctx.fillText(str, x, y);
  }

  // ── Pre-rendered parallax layers (procedural, no assets) ──
  function layer(w, h, paint) { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.imageSmoothingEnabled = false; paint(x, w, h); return c; }
  const LW = W + 200;
  function ridge(x, w, base, amp, seed, color, step = 4) {
    const r = rng(seed), k = [r() * 6, r() * 6, r() * 6];
    x.fillStyle = color; x.beginPath(); x.moveTo(0, H);
    for (let i = 0; i <= w; i += step) {
      const yy = base - amp * (0.55 * Math.sin(i / 97 + k[0]) + 0.3 * Math.sin(i / 41 + k[1]) + 0.15 * Math.sin(i / 17 + k[2]));
      x.lineTo(i, Math.round(yy / 2) * 2);
    }
    x.lineTo(w, H); x.closePath(); x.fill();
  }
  const L1 = {
    sky: layer(W, H, (x) => {
      const gr = x.createLinearGradient(0, 0, 0, GROUND);
      gr.addColorStop(0, '#120c26'); gr.addColorStop(0.45, '#2c1a4a'); gr.addColorStop(0.8, '#7a3a6a'); gr.addColorStop(1, '#e0806a');
      x.fillStyle = gr; x.fillRect(0, 0, W, H);
      // dithered bands for a pixel-art sky
      const r = rng(7);
      for (let i = 0; i < 140; i++) { x.fillStyle = r() < 0.5 ? '#ffffff' : '#ffe9b0'; x.globalAlpha = 0.35 + r() * 0.65; const s = r() < 0.12 ? 2 : 1; x.fillRect(Math.floor(r() * W), Math.floor(r() * 120), s, s); }
      x.globalAlpha = 1;
    }),
    far: layer(LW, H, (x, w) => { ridge(x, w, 150, 45, 11, '#3d2658'); ridge(x, w, 168, 26, 12, '#33204c'); }),
    mid: layer(LW, H, (x, w) => {
      ridge(x, w, 190, 14, 21, '#241838');
      const r = rng(22);
      for (let tx = 0; tx < w; tx += 14 + Math.floor(r() * 18)) { // pine silhouettes
        const th = 26 + Math.floor(r() * 30), by = 196 - Math.floor(r() * 8);
        x.fillStyle = '#1c1230';
        for (let k = 0; k < th; k += 2) { const ww = Math.max(2, Math.floor((k / th) * 14)); x.fillRect(tx - ww / 2, by - th + k, ww, 2); }
        x.fillRect(tx - 1, by, 2, 6);
      }
    }),
    near: layer(LW, H, (x, w) => {
      const r = rng(31);
      for (let tx = 0; tx < w; tx += 30 + Math.floor(r() * 50)) {
        const th = 40 + Math.floor(r() * 40);
        x.fillStyle = '#120b20';
        for (let k = 0; k < th; k += 2) { const ww = Math.max(2, Math.floor((k / th) * 22)); x.fillRect(tx - ww / 2, GROUND - th + k, ww, 2); }
      }
      x.fillRect(0, GROUND - 6, w, 6);
    }),
  };
  const L2 = {
    wall: layer(LW, H, (x, w) => {
      x.fillStyle = '#1e1826'; x.fillRect(0, 0, w, H);
      const r = rng(41);
      for (let row = 0, y = 0; y < GROUND; row++, y += 12) {
        for (let bx = (row % 2) * -12; bx < w; bx += 24) {
          const v = Math.floor(r() * 3); x.fillStyle = ['#2a2234', '#2f2639', '#262030'][v];
          x.fillRect(bx + 1, y + 1, 22, 10); x.fillStyle = '#3a3046'; x.fillRect(bx + 1, y + 1, 22, 1);
        }
      }
      // tall arched windows (filled per phase at draw time; cut out here)
      for (let wx = 70; wx < w; wx += 180) { x.clearRect(wx, 46, 36, 96); x.save(); x.globalCompositeOperation = 'destination-out'; x.beginPath(); x.arc(wx + 18, 46, 18, Math.PI, 0); x.fill(); x.restore(); }
    }),
    pillars: layer(LW, H, (x, w) => {
      for (let px = 20; px < w; px += 180) {
        x.fillStyle = '#14101c'; x.fillRect(px, 20, 26, GROUND - 20);
        x.fillStyle = '#2c2438'; x.fillRect(px + 2, 20, 4, GROUND - 20);
        x.fillStyle = '#0c0912'; x.fillRect(px + 20, 20, 6, GROUND - 20);
        x.fillStyle = '#241c30'; x.fillRect(px - 4, 16, 34, 8); x.fillRect(px - 4, GROUND - 10, 34, 10);
        // banner
        x.fillStyle = '#5a1630'; x.fillRect(px + 34, 30, 22, 54);
        x.beginPath(); x.moveTo(px + 34, 84); x.lineTo(px + 45, 76); x.lineTo(px + 56, 84); x.closePath(); x.fillStyle = '#1e1826'; x.fill();
        x.fillStyle = '#d4a63a'; x.fillRect(px + 34, 30, 22, 3); x.fillRect(px + 41, 44, 8, 8); x.fillRect(px + 43, 54, 4, 12);
      }
    }),
  };

  // ── Visual-only effect state, advanced from g.tick deltas ──
  const fx = { lastTick: 0, frame: 0, parts: [], flash: 0, flashColor: '#ff3050', shake: 0, bossHit: 0, banner: null, face: 1, lastX: g.player.x, moving: 0,
    prevHp: g.player.hp, prevSlimes: g.slimes.map(s => s.hp), prevBossHp: null, prevPhase: null, prevScene: g.scene, rnd: rng(1337), dead: [] };

  function burst(x, y, n, colors, spd = 2.5, up = 1.5, size = 2, life = 26) {
    for (let i = 0; i < n; i++) {
      const a = fx.rnd() * Math.PI * 2, v = 0.6 + fx.rnd() * spd;
      fx.parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - up, life: life * (0.6 + fx.rnd() * 0.6), max: life, c: colors[Math.floor(fx.rnd() * colors.length)], s: size });
    }
  }
  function floater(x, y, str, color) { fx.parts.push({ x, y, vx: 0, vy: -0.8, life: 34, max: 34, c: color, txt: str }); }

  function advanceFx() {
    const dt = g.tick - fx.lastTick;
    if (dt <= 0) return;
    fx.lastTick = g.tick;
    const p = g.player;
    // events (diffs of game state)
    if (p.x !== fx.lastX) { fx.face = p.x > fx.lastX ? 1 : -1; fx.moving = 6; }
    fx.lastX = p.x;
    if (p.cd > 0) fx.face = 1; // attacks always swing right
    if (p.hp < fx.prevHp) { fx.flash = 10; fx.flashColor = '#ff2a48'; fx.shake = 8; burst(p.x + 10, p.y + 8, 14, ['#ff5a6e', '#ffffff', '#ffd35a'], 2.6, 1.2); floater(p.x + 10, p.y - 6, '-1', '#ff6b7d'); }
    fx.prevHp = p.hp;
    g.slimes.forEach((s, i) => {
      if (s.hp < fx.prevSlimes[i]) {
        burst(s.x + 9, GROUND - 8, s.hp <= 0 ? 26 : 10, ['#a6f06a', '#5fbf4a', '#e8ffd0'], s.hp <= 0 ? 3.2 : 2, 1.8);
        if (s.hp <= 0) { fx.dead.push({ x: s.x, t: g.tick }); floater(s.x + 9, GROUND - 22, 'POP!', '#c8ff8a'); fx.shake = Math.max(fx.shake, 3); }
      }
      fx.prevSlimes[i] = s.hp;
    });
    if (g.scene !== fx.prevScene) {
      if (g.scene === 'boss') { fx.banner = { t: 110, big: 'BOSS FIGHT', small: 'THE HOLLOW KING awakens' }; fx.flash = 12; fx.flashColor = '#ffffff'; }
      if (g.scene === 'level1-clear') { burst(DOOR + 10, GROUND - 20, 40, ['#ffd35a', '#fff4a8', '#ffffff'], 3.5, 2); }
      fx.prevScene = g.scene;
    }
    const b = g.boss;
    if (b) {
      if (fx.prevBossHp !== null && b.hp < fx.prevBossHp) {
        const ph = PHASES[b.phase - 1];
        fx.bossHit = 8; fx.shake = Math.max(fx.shake, 3);
        burst(b.x + 6, FLOOR - 4 + fx.rnd() * 30, 12, [ph.A, ph.glow, '#ffffff'], 2.8, 1);
        floater(b.x + 10, FLOOR - 52, '-' + (fx.prevBossHp - b.hp), '#ffffff');
      }
      if (fx.prevPhase !== null && b.phase !== fx.prevPhase) {
        fx.flash = 14; fx.flashColor = '#ffffff'; fx.shake = 10;
        fx.banner = { t: 90, big: 'PHASE ' + b.phase, small: b.phase === 3 ? 'The King unleashes the void!' : 'The King grows furious!' };
        burst(b.x + 20, FLOOR - 10, 40, [PHASES[b.phase - 1].glow, '#ffffff', PHASES[b.phase - 1].A], 4, 1.5, 3);
      }
      if (b.hp <= 0 && fx.prevBossHp > 0) { burst(b.x + 20, FLOOR - 10, 80, ['#ffffff', '#ffd35a', '#b45cff', '#6ff7ff'], 5, 2, 3, 50); }
      fx.prevBossHp = b.hp; fx.prevPhase = b.phase;
      if (b.phase >= 2) for (let i = 0; i < dt; i++) if (fx.rnd() < (b.phase === 3 ? 0.5 : 0.25)) // embers / void motes
        fx.parts.push({ x: fx.rnd() * W, y: GROUND, vx: (fx.rnd() - 0.5) * 0.4, vy: -0.6 - fx.rnd() * 1.2, life: 90, max: 90, c: b.phase === 3 ? '#b45cff' : '#ff9a3c', s: 2, float: true });
    }
    for (let i = 0; i < Math.min(dt, 60); i++) {
      for (const q of fx.parts) { q.x += q.vx; q.y += q.vy; if (!q.txt && !q.float) q.vy += 0.15; if (!q.float && q.y > GROUND - 1 && !q.txt) { q.y = GROUND - 1; q.vy *= -0.3; q.vx *= 0.7; } q.life--; }
      fx.parts = fx.parts.filter(q => q.life > 0);
      if (fx.flash > 0) fx.flash--; if (fx.shake > 0) fx.shake--; if (fx.bossHit > 0) fx.bossHit--; if (fx.moving > 0) fx.moving--;
      if (fx.banner && --fx.banner.t <= 0) fx.banner = null;
    }
    if (fx.parts.length > 400) fx.parts.splice(0, fx.parts.length - 400);
  }

  // ── Scene painters ──
  function drawLevelBg(t, px) {
    ctx.drawImage(L1.sky, 0, 0);
    // twinkles
    for (let i = 0; i < 12; i++) { const sx = (i * 137 + 31) % W, sy = (i * 53 + 11) % 110; if (((t >> 3) + i * 5) % 9 < 2) { ctx.fillStyle = '#ffffff'; ctx.fillRect(sx - 1, sy, 3, 1); ctx.fillRect(sx, sy - 1, 1, 3); } }
    // moon
    const mx = 560 - px * 0.02;
    ctx.fillStyle = 'rgba(255,230,190,0.12)'; ctx.beginPath(); ctx.arc(mx, 52, 30, 0, 7); ctx.fill();
    ctx.fillStyle = '#ffeccc'; ctx.beginPath(); ctx.arc(mx, 52, 18, 0, 7); ctx.fill();
    ctx.fillStyle = '#e8cfaa'; ctx.fillRect(mx - 8, 46, 5, 4); ctx.fillRect(mx + 4, 56, 4, 3); ctx.fillRect(mx - 2, 60, 3, 2);
    // drifting clouds
    ctx.fillStyle = 'rgba(160,110,170,0.35)';
    for (let i = 0; i < 4; i++) { const cx = ((i * 230 + t * (0.15 + i * 0.05)) % (W + 160)) - 80, cy = 30 + i * 18; ctx.fillRect(cx, cy, 70, 6); ctx.fillRect(cx + 12, cy - 4, 40, 4); ctx.fillRect(cx + 20, cy + 6, 50, 3); }
    ctx.drawImage(L1.far, -Math.round(px * 0.05) - 20, 0);
    ctx.drawImage(L1.mid, -Math.round(px * 0.15) - 40, 0);
    ctx.drawImage(L1.near, -Math.round(px * 0.3) - 60, 0);
    // fireflies
    for (let i = 0; i < 10; i++) {
      const fxp = (i * 71 + Math.sin(t / 40 + i) * 30 + 40) % W, fyp = 150 + Math.sin(t / 25 + i * 2) * 20 + (i % 3) * 8;
      if ((t + i * 13) % 50 < 34) { ctx.fillStyle = 'rgba(220,255,140,0.35)'; ctx.fillRect(fxp - 2, fyp - 2, 5, 5); ctx.fillStyle = '#eaffb0'; ctx.fillRect(fxp, fyp, 2, 2); }
    }
    drawGround('#5fbf4a', '#3b8a3a', '#3b2a3f', '#2a1e30');
  }

  function drawGround(top, top2, dirt, dirt2) {
    ctx.fillStyle = dirt; ctx.fillRect(0, GROUND, W, H - GROUND);
    ctx.fillStyle = dirt2; for (let x = 0; x < W; x += 16) { ctx.fillRect(x + ((x * 7) % 11), GROUND + 8 + ((x * 3) % 7), 4, 2); ctx.fillRect(x, GROUND + 18, 16, 2); }
    ctx.fillStyle = top; ctx.fillRect(0, GROUND, W, 3);
    ctx.fillStyle = top2; for (let x = 0; x < W; x += 6) ctx.fillRect(x, GROUND + 3, 3, (x % 12) ? 2 : 3);
    ctx.fillStyle = top; for (let x = 3; x < W; x += 10) ctx.fillRect(x, GROUND - 2, 2, 2);
  }

  function drawBossBg(t, px, phase) {
    const ph = PHASES[phase - 1];
    const gr = ctx.createLinearGradient(0, 0, 0, GROUND);
    gr.addColorStop(0, ph.sky[0]); gr.addColorStop(0.6, ph.sky[1]); gr.addColorStop(1, ph.sky[2]);
    ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
    // lightning in phase 3, seen through windows
    const bolt = phase === 3 && (t % 150) < 8;
    if (bolt) { ctx.fillStyle = 'rgba(200,170,255,0.6)'; ctx.fillRect(0, 0, W, GROUND); }
    ctx.drawImage(L2.wall, -Math.round(px * 0.08) - 20, 0);
    ctx.fillStyle = ph.tint; ctx.fillRect(0, 0, W, GROUND);
    ctx.drawImage(L2.pillars, -Math.round(px * 0.25) - 60, 0);
    // torches on pillars
    for (let i = 0; i < 6; i++) {
      const tx = 20 + i * 180 - Math.round(px * 0.25) - 60 + 13, ty = 110;
      if (tx < -20 || tx > W + 20) continue;
      const fl = ((t >> 2) + i) % 3;
      ctx.fillStyle = 'rgba(255,170,60,0.12)'; ctx.beginPath(); ctx.arc(tx, ty - 4, 26 + fl * 2, 0, 7); ctx.fill();
      ctx.fillStyle = '#3a2a20'; ctx.fillRect(tx - 3, ty, 6, 8);
      ctx.fillStyle = phase === 3 ? '#8a5cff' : '#ff7a1a'; ctx.fillRect(tx - 3, ty - 6 - fl, 6, 6 + fl);
      ctx.fillStyle = phase === 3 ? '#cfe8ff' : '#ffe06b'; ctx.fillRect(tx - 1, ty - 4 - fl, 2, 4);
    }
    if (phase === 3) { // glowing floor cracks
      ctx.fillStyle = `rgba(180,92,255,${0.5 + 0.3 * Math.sin(t / 8)})`;
      for (let x = 30; x < W; x += 90) { ctx.fillRect(x, GROUND + 4, 18, 2); ctx.fillRect(x + 16, GROUND + 6, 2, 8); ctx.fillRect(x + 16, GROUND + 12, 14, 2); }
    }
    drawGround(phase === 3 ? '#6a4a9a' : '#6a5a72', '#4a3e54', '#2a2232', '#1c1624');
    if (phase === 3) { ctx.fillStyle = `rgba(180,92,255,${0.5 + 0.3 * Math.sin(t / 8)})`; for (let x = 30; x < W; x += 90) { ctx.fillRect(x, GROUND + 4, 18, 2); ctx.fillRect(x + 16, GROUND + 6, 2, 8); } }
  }

  function drawDoor(open, t) {
    const x = DOOR, y = FLOOR - 20;
    // stone arch
    ctx.fillStyle = '#4a4058'; ctx.fillRect(x - 8, y - 6, 36, 46);
    ctx.fillStyle = '#5e5470'; for (let i = 0; i < 46; i += 8) { ctx.fillRect(x - 8, y - 6 + i, 6, 6); ctx.fillRect(x + 22, y - 2 + i, 6, 6); }
    ctx.fillRect(x - 6, y - 10, 32, 6);
    if (open) {
      const pulse = 0.5 + 0.5 * Math.sin(t / 6);
      ctx.fillStyle = `rgba(255,211,90,${0.18 + 0.12 * pulse})`; ctx.beginPath(); ctx.arc(x + 10, y + 18, 34, 0, 7); ctx.fill();
      const gr = ctx.createLinearGradient(0, y, 0, y + 40); gr.addColorStop(0, '#fff4c0'); gr.addColorStop(1, '#ffb83a');
      ctx.fillStyle = gr; ctx.fillRect(x, y, 20, 40);
      ctx.fillStyle = '#ffffff'; ctx.fillRect(x + 4 + ((t >> 2) % 12), y + 6 + ((t >> 1) % 28), 2, 2);
      text('OPEN', x + 10, y - 20, { size: 11, color: '#ffd35a' });
      const ay = y - 34 + Math.round(Math.sin(t / 5) * 2);
      ctx.fillStyle = '#ffd35a'; ctx.fillRect(x + 8, ay - 6, 4, 6); ctx.fillRect(x + 5, ay, 10, 2); ctx.fillRect(x + 7, ay + 2, 6, 2); ctx.fillRect(x + 9, ay + 4, 2, 2);
    } else {
      ctx.fillStyle = '#5a3a24'; ctx.fillRect(x, y, 20, 40);
      ctx.fillStyle = '#7a5032'; for (let i = 0; i < 20; i += 5) ctx.fillRect(x + i, y, 3, 40);
      ctx.fillStyle = '#2a2a34'; ctx.fillRect(x, y + 8, 20, 3); ctx.fillRect(x, y + 28, 20, 3);
      // chains + padlock
      ctx.fillStyle = '#9aa0b4'; for (let i = 0; i < 20; i += 4) { ctx.fillRect(x + i, y + 10 + (i % 8 ? 1 : 0), 3, 2); ctx.fillRect(x + i, y + 30 - (i % 8 ? 1 : 0), 3, 2); }
      ctx.fillStyle = '#ffd35a'; ctx.fillRect(x + 5, y + 16, 10, 8); ctx.strokeStyle = '#ffd35a'; ctx.lineWidth = 2; ctx.strokeRect(x + 7, y + 12, 6, 5);
      ctx.fillStyle = '#1a1426'; ctx.fillRect(x + 9, y + 18, 2, 3);
      text('LOCKED', x + 10, y - 20, { size: 11, color: '#ff6b7d' });
    }
  }

  function drawPlayer(t) {
    const p = g.player;
    if (g.gameOver) { // fallen hero
      ctx.save(); ctx.translate(p.x + 10, GROUND - 4); ctx.rotate(-Math.PI / 2); sprite(HERO, HERO_PAL, -10, -10, 2, false); ctx.restore(); return;
    }
    if (p.inv > 0 && (p.inv % 6) >= 3) return; // invulnerability blink
    const x = p.x, y = p.y;
    // shadow
    const air = GROUND - (y + 20);
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(x + 2 + Math.min(4, air / 12), GROUND - 1, 16 - Math.min(8, air / 6), 2);
    const flip = fx.face < 0;
    const legs = y < FLOOR ? HERO_LEGS[2] : (fx.moving > 0 ? HERO_LEGS[(t >> 3) % 2] : HERO_LEGS[0]);
    const bob = y >= FLOOR && fx.moving > 0 && ((t >> 3) % 2) ? 1 : 0;
    sprite(HERO, HERO_PAL, x, y + bob, 2, flip);
    sprite(legs, HERO_PAL, x, y + 16, 2, flip);
    // sword
    const atk = p.cd > 0 ? 12 - p.cd : -1; // frames since the swing started
    if (atk >= 0 && atk < 7) {
      const a0 = -1.3 + atk * 0.42;
      ctx.save(); ctx.translate(x + 16, y + 11);
      ctx.strokeStyle = `rgba(255,255,255,${0.9 - atk * 0.11})`; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(0, 0, 24, -1.3, a0, false); ctx.stroke();
      ctx.strokeStyle = `rgba(126,224,195,${0.7 - atk * 0.09})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, 30, -1.1, a0 - 0.1, false); ctx.stroke();
      ctx.rotate(a0); ctx.fillStyle = '#e8eef8'; ctx.fillRect(2, -2, 20, 4); ctx.fillStyle = '#ffd35a'; ctx.fillRect(0, -4, 3, 8); ctx.restore();
    } else {
      const sx = flip ? x - 2 : x + 18; ctx.fillStyle = '#e8eef8'; ctx.fillRect(sx, y + 2 + bob, 2, 12); ctx.fillStyle = '#ffd35a'; ctx.fillRect(sx - 2, y + 12 + bob, 6, 2);
    }
  }

  function drawSlimes(t) {
    g.slimes.forEach((s, i) => {
      if (s.hp <= 0) return;
      const sq = Math.sin(t / 7 + i * 2), hy = Math.max(0, sq) * 3;
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(s.x + 1, GROUND - 1, 16, 2);
      const hurt = s.hp < 2;
      sprite(SLIME, hurt ? { ...SLIME_PAL, G: '#c8e35a', g: '#8a9a2c' } : SLIME_PAL, s.x, FLOOR + 8 - hy, 2, false);
      if (hurt) { ctx.fillStyle = '#ffffff'; ctx.fillRect(s.x + 4, FLOOR + 6 - hy, 2, 2); }
    });
    for (const d of fx.dead) { const age = g.tick - d.t; if (age < 120) { ctx.fillStyle = `rgba(95,191,74,${0.6 * (1 - age / 120)})`; ctx.fillRect(d.x, GROUND - 2, 18, 2); } }
  }

  function drawBoss(t) {
    const b = g.boss, ph = PHASES[b.phase - 1];
    const dead = b.hp <= 0;
    const bx = b.x, by = FLOOR - 40;
    const breathe = dead ? 0 : Math.round(Math.sin(t / 12));
    ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fillRect(bx - 2, GROUND - 2, 44, 3);
    if (b.phase === 3 && !dead) { // void aura
      const r = 34 + Math.sin(t / 5) * 4;
      ctx.fillStyle = 'rgba(180,92,255,0.18)'; ctx.beginPath(); ctx.arc(bx + 20, by + 28, r, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(111,247,255,0.10)'; ctx.beginPath(); ctx.arc(bx + 20, by + 28, r * 0.7, 0, 7); ctx.fill();
    } else if (b.phase === 2 && !dead) {
      ctx.fillStyle = `rgba(255,154,60,${0.12 + 0.06 * Math.sin(t / 6)})`; ctx.beginPath(); ctx.arc(bx + 20, by + 28, 32, 0, 7); ctx.fill();
    }
    // scythe (behind, held toward the hero)
    ctx.fillStyle = '#3a2a20'; ctx.fillRect(bx - 4, by - 2 + breathe, 3, 62);
    ctx.fillStyle = dead ? '#555' : ph.glow; ctx.beginPath(); ctx.moveTo(bx - 3, by - 2 + breathe); ctx.quadraticCurveTo(bx - 26, by - 4 + breathe, bx - 30, by + 16 + breathe); ctx.quadraticCurveTo(bx - 20, by + 4 + breathe, bx - 3, by + 6 + breathe); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.globalAlpha = 0.6; ctx.fillRect(bx - 22, by + 1 + breathe, 8, 2); ctx.globalAlpha = 1;
    const pal = { K: '#0c0810', G: '#ffd35a', R: '#ff3a5a', D: ph.D, E: ph.E, M: '#ff3a5a', A: ph.A, a: ph.a, C: ph.C };
    if (dead) ctx.globalAlpha = 0.5;
    sprite(BOSS, pal, bx, by - 2 + breathe, 2, false, fx.bossHit > 4 ? '#ffffff' : null);
    ctx.globalAlpha = 1;
    // glowing eyes
    if (!dead) { ctx.fillStyle = ph.E; ctx.globalAlpha = 0.35 + 0.25 * Math.sin(t / 4); ctx.fillRect(bx + 8, by + 8 + breathe, 22, 8); ctx.globalAlpha = 1; }
    // charge-up telegraph before each shot
    if (!dead && b.cd < 18) {
      const k = (18 - b.cd) / 18;
      ctx.fillStyle = ph.shot[2]; ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.arc(bx - 8, FLOOR + 9, 3 + k * 6, 0, 7); ctx.fill();
      ctx.globalAlpha = 1; ctx.fillStyle = ph.shot[0]; ctx.beginPath(); ctx.arc(bx - 8, FLOOR + 9, 1 + k * 3, 0, 7); ctx.fill();
    }
  }

  function drawShots(t) {
    if (!g.boss) return;
    const ph = PHASES[g.boss.phase - 1];
    for (const s of g.shots) {
      if (s.x < -20) continue;
      const cx = s.x + 5, cy = FLOOR + 9;
      for (let k = 1; k <= 4; k++) { ctx.fillStyle = ph.shot[2]; ctx.globalAlpha = 0.5 - k * 0.1; ctx.fillRect(cx + k * 5, cy - 3 + (k % 2), 6 - k, 6 - k); }
      ctx.globalAlpha = 1;
      ctx.fillStyle = ph.shot[2]; ctx.fillRect(cx - 6, cy - 4, 12, 8);
      ctx.fillStyle = ph.shot[1]; ctx.fillRect(cx - 5, cy - 3, 9, 6);
      ctx.fillStyle = ph.shot[0]; ctx.fillRect(cx - 4, cy - 2, 5, 4);
      if ((t + s.x) % 4 < 2) { ctx.fillStyle = ph.shot[1]; ctx.fillRect(cx - 8, cy - 1, 2, 2); }
    }
  }

  function drawParticles() {
    for (const q of fx.parts) {
      const a = Math.max(0, Math.min(1, q.life / (q.max * 0.5)));
      ctx.globalAlpha = a;
      if (q.txt) text(q.txt, q.x, q.y, { size: 12, color: q.c });
      else { ctx.fillStyle = q.c; ctx.fillRect(Math.round(q.x), Math.round(q.y), q.s, q.s); }
    }
    ctx.globalAlpha = 1;
  }

  const SCENE_NAMES = { level1: 'LEVEL 1 · SLIME WOODS', boss: 'BOSS · THRONE OF THE HOLLOW KING', 'level1-clear': 'LEVEL 1 · CLEAR!' };

  function drawHud(t) {
    const p = g.player;
    ctx.fillStyle = 'rgba(8,6,14,0.72)'; ctx.fillRect(0, 0, W, 24); ctx.fillStyle = '#3a3050'; ctx.fillRect(0, 24, W, 1);
    // hearts
    for (let i = 0; i < 5; i++) {
      const full = i < p.hp, beat = full && i === p.hp - 1 && p.hp <= 2 && (t >> 3) % 2;
      sprite(HEART, full ? { K: '#1a0810', R: '#ff3a5a', W: '#ffd0d8' } : { K: '#1a0810', R: '#3a2a3a', W: '#4a3a4a' }, 8 + i * 17, 6 - (beat ? 1 : 0), 2, false);
    }
    text(`HP ${Math.max(0, p.hp)}/5`, 98, 12, { size: 11, color: '#ffb0bc' });
    text(SCENE_NAMES[g.scene] || g.scene.toUpperCase(), W / 2, 12, { size: 13, color: '#ffe6a8', align: 'center' });
    text(`BUILD ${g.build.toUpperCase()}`, W - 8, 12, { size: 10, color: '#8a84a8', align: 'right' });
    if (g.scene === 'level1') {
      const left = g.slimes.filter(s => s.hp > 0).length;
      text(left ? `SLIMES LEFT ${left}  ·  DOOR LOCKED` : 'DOOR OPEN  ·  GO RIGHT ►', W / 2, 36, { size: 11, color: left ? '#c8ff8a' : '#ffd35a', align: 'center' });
    }
    const b = g.boss;
    if (b) {
      const ph = PHASES[b.phase - 1], bw = 300, bx = (W - bw) / 2, by = 30;
      text('THE HOLLOW KING', bx - 8, by + 7, { size: 11, color: '#ffffff', align: 'right' });
      ctx.fillStyle = '#0b0a12'; ctx.fillRect(bx - 2, by - 2, bw + 4, 18);
      ctx.fillStyle = '#2a2234'; ctx.fillRect(bx, by, bw, 14);
      // phase divisions at 20 and 10 HP
      const fill = Math.max(0, b.hp) / 30 * bw;
      const gr = ctx.createLinearGradient(0, by, 0, by + 14); gr.addColorStop(0, ph.glow); gr.addColorStop(1, ph.a);
      ctx.fillStyle = gr; ctx.fillRect(bx, by, fill, 14);
      ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(bx, by, fill, 2);
      if (fx.bossHit > 0) { ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.fillRect(bx + fill, by, 6, 14); }
      ctx.fillStyle = '#0b0a12'; ctx.fillRect(bx + bw / 3, by, 2, 14); ctx.fillRect(bx + 2 * bw / 3, by, 2, 14);
      text(`HP ${Math.max(0, b.hp)}/30`, W / 2, by + 7, { size: 11, color: '#ffffff', align: 'center' });
      text(ph.name, bx + bw + 8, by + 7, { size: 12, color: ph.glow, align: 'left' });
    }
  }

  function drawBanner() {
    if (!fx.banner || g.ending || g.gameOver) return;
    const bn = fx.banner, a = Math.min(1, bn.t / 20);
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(8,6,14,0.7)'; ctx.fillRect(0, 84, W, 50);
    ctx.fillStyle = '#ffd35a'; ctx.fillRect(0, 84, W, 2); ctx.fillRect(0, 132, W, 2);
    text(bn.big, W / 2, 102, { size: 22, color: '#ffffff', align: 'center' });
    text(bn.small, W / 2, 123, { size: 11, color: '#ffd35a', align: 'center' });
    ctx.globalAlpha = 1;
  }

  function drawEnding() {
    const f = fx.frame;
    ctx.fillStyle = 'rgba(6,4,16,0.82)'; ctx.fillRect(0, 0, W, H);
    // confetti, animated by the rAF frame counter (the game clock is frozen on the end screen)
    const cols = ['#ffd35a', '#ff6b7d', '#7ee0c3', '#b45cff', '#6ff7ff', '#ffffff'];
    for (let i = 0; i < 70; i++) {
      const x = (i * 97 + Math.sin((f + i * 20) / 30) * 12) % W, y = ((i * 53 + f * (0.6 + (i % 5) * 0.2)) % (H + 20)) - 10;
      ctx.fillStyle = cols[i % cols.length]; ctx.fillRect(Math.round(x), Math.round(y), (i % 3) + 2, 2 + (i % 2) * 2);
    }
    ctx.fillStyle = '#ffd35a'; ctx.fillRect(60, 70, W - 120, 2); ctx.fillRect(60, 170, W - 120, 2);
    text('BOSS DEFEATED', W / 2, 88, { size: 13, color: '#7ee0c3', align: 'center' });
    text('THE END — thanks for backing!', W / 2, 120, { size: 28, color: '#ffe08a', align: 'center', outline: '#3a1a08' });
    text('You beat the Hollow King. Thanks for playing Boss Rush.', W / 2, 152, { size: 11, color: '#d8d0f0', align: 'center' });
    sprite(HERO, HERO_PAL, W / 2 - 10, 186, 2, false); sprite(HERO_LEGS[0], HERO_PAL, W / 2 - 10, 202, 2, false);
    ctx.fillStyle = '#e8eef8'; ctx.fillRect(W / 2 + 10, 172, 2, 18); ctx.fillStyle = '#ffd35a'; ctx.fillRect(W / 2 + 7, 188, 8, 2);
  }

  function drawGameOver() {
    ctx.fillStyle = 'rgba(30,0,10,0.72)'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#ff3a5a'; ctx.fillRect(140, 82, W - 280, 2); ctx.fillRect(140, 150, W - 280, 2);
    text('GAME OVER', W / 2, 110, { size: 40, color: '#ff3a5a', align: 'center', outline: '#1a0008' });
    text('The hero has fallen.', W / 2, 138, { size: 12, color: '#ffd0d8', align: 'center' });
  }

  function drawClearBanner(t) {
    ctx.fillStyle = 'rgba(8,6,14,0.6)'; ctx.fillRect(0, 80, W, 58);
    ctx.fillStyle = '#ffd35a'; ctx.fillRect(0, 80, W, 2); ctx.fillRect(0, 136, W, 2);
    text('LEVEL 1 CLEAR!', W / 2, 102, { size: 26, color: '#ffe08a', align: 'center' });
    text('All slimes defeated · you walked through the door', W / 2, 126, { size: 11, color: '#c8ff8a', align: 'center' });
  }

  function draw() {
    advanceFx();
    const t = g.tick, p = g.player;
    ctx.save();
    if (fx.shake > 0 && !g.ending) { const s = Math.ceil(fx.shake / 3); ctx.translate(((t * 7) % 3 - 1) * s, ((t * 5) % 3 - 1) * s); }
    if (g.scene === 'boss' && g.boss) drawBossBg(t, p.x, g.boss.phase);
    else drawLevelBg(t, p.x);
    if (g.scene !== 'boss') drawDoor(g.slimes.every(s => s.hp <= 0), t);
    if (g.scene === 'level1') drawSlimes(t);
    if (g.boss) { drawBoss(t); drawShots(t); }
    if (g.scene !== 'level1-clear') drawPlayer(t);
    drawParticles();
    ctx.restore();
    if (g.scene === 'level1-clear') drawClearBanner(t);
    drawBanner();
    if (fx.flash > 0 && !g.ending) { ctx.globalAlpha = fx.flash / 22; ctx.fillStyle = fx.flashColor; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; }
    // vignette
    const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.6, W / 2, H / 2, W * 0.62);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.45)'); ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
    drawHud(t);
    if (g.ending) drawEnding();
    if (g.gameOver) drawGameOver();
  }

  // Human play: keyboard plus requestAnimationFrame. Agent play: window.__game.step().
  const held = {}; let human = false;
  addEventListener('keydown', e => { human = true; held[e.key] = true; if (e.key.startsWith('Arrow') || e.key === ' ') e.preventDefault(); });
  addEventListener('keyup', e => { held[e.key] = false; });
  function loop() {
    if (human) { try { step({ left: held.ArrowLeft, right: held.ArrowRight, jump: held.ArrowUp || held[' '], attack: held.z || held.x }); } catch (e) { g.errors.push(String(e)); } }
    fx.frame++; draw(); requestAnimationFrame(loop);
  }
  window.__game = {
    step(keys) { try { return step(keys); } catch (e) { g.errors.push(String(e.message || e)); throw e; } finally { draw(); } },
    state: snapshot,
  };
  loop();
})();
