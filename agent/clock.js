// The agent stops time while it thinks. Injected into the game page before any of its code runs,
// this shim takes over the browser's clocks (requestAnimationFrame, performance.now, Date.now,
// setTimeout/setInterval), so the game only moves when the agent calls __clock.advance(frames).
// Works on any HTML5 game driven by requestAnimationFrame; no hooks in the game are needed.
export const CLOCK_SHIM = `(() => {
  if (window.__clock) return;
  const FRAME = 1000 / 60, start = Date.now();
  let t = 0, nextId = 1, raf = [], timers = [];
  const realNow = performance.now.bind(performance);
  window.requestAnimationFrame = cb => { const id = nextId++; raf.push({ id, cb }); return id; };
  window.cancelAnimationFrame = id => { raf = raf.filter(r => r.id !== id); };
  performance.now = () => t;
  Date.now = () => start + t;
  const addTimer = (cb, ms, every, args) => { const id = nextId++; timers.push({ id, cb, at: t + Math.max(0, +ms || 0), every, args }); return id; };
  window.setTimeout = (cb, ms, ...args) => addTimer(cb, ms, 0, args);
  window.setInterval = (cb, ms, ...args) => addTimer(cb, ms, Math.max(1, +ms || 1), args);
  window.clearTimeout = window.clearInterval = id => { timers = timers.filter(x => x.id !== id); };
  window.__clock = {
    errors: [],
    now: () => t,
    advance(frames) {
      for (let f = 0; f < frames; f++) {
        t += FRAME;
        for (const x of timers.filter(x => x.at <= t)) {
          try { typeof x.cb === 'function' ? x.cb(...(x.args || [])) : 0; } catch (e) { this.errors.push(String(e.message || e)); }
          if (x.every) x.at += x.every; else timers = timers.filter(y => y !== x);
        }
        const due = raf; raf = [];
        for (const r of due) { try { r.cb(t); } catch (e) { this.errors.push(String(e.message || e)); } }
      }
      return { t, errors: this.errors.length };
    },
  };
  addEventListener('error', e => window.__clock.errors.push(String(e.message || e.error)));
})();`;
