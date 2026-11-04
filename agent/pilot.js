// The pilot: Gemini plays a game it has never seen, from pixels alone.
// Each turn: look at the frozen screen, plan a few inputs (keys held for N frames), run them,
// look again. Time is stopped while it thinks (agent/clock.js), so slow thinking never kills it.
// The pilot only plays. A separate, skeptical judge (agent/judge.js) decides whether the promise was kept.
import { askJSON } from '../lib/gemini.js';

const S = { type: 'STRING' }, B = { type: 'BOOLEAN' }, I = { type: 'INTEGER' };
export const KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'z', 'x', 'Enter'];

const PLAN = { type: 'OBJECT', required: ['me', 'see', 'plan', 'done'], properties: {
  me: S,             // your character's x position on the ruler, and how far it moved since the last screen
  progress: S,       // did your last plan get closer to the promise? what will you do differently?
  see: S,            // what is on screen right now, in a sentence
  goal: S,           // what it is trying next
  done: B,           // stop playing: the promise is visibly kept, or the game is over
  outcome: { type: 'STRING', enum: ['playing', 'kept', 'game_over', 'stuck'] },
  plan: { type: 'ARRAY', items: { type: 'OBJECT', required: ['keys', 'frames'], properties: {
    keys: { type: 'ARRAY', items: { type: 'STRING', enum: KEYS } }, frames: I } } },
} };

function prompt({ promise, controls, history, turn, maxTurns }) {
  return `You are playing a web game to test whether its creator kept a promise to backers.\n` +
    `Promise to test: "${promise}"\n` +
    `Controls shown on the page: ${controls || 'unknown: try arrow keys, Space, z, x, Enter'}\n` +
    `Time is frozen while you think. The game runs at 60 frames per second only while your plan executes.\n` +
    `Plan 1 to 5 steps. Each step holds the listed keys for that many frames (1-60), then releases them. An empty keys list waits. Holding an attack key repeats the attack.\n` +
    `The screen has a ruler: numbered vertical lines every 50 pixels. Use it to measure positions and distances. Compare the two screens to learn how many pixels you move per frame, then plan exact frame counts.\n` +
    `Melee attacks only reach a short distance in the direction you face. Stop just before an enemy, attack until it is gone, then move on. If an enemy is behind you or on top of you, step back past it and face it before attacking. Touching enemies hurts, so keep a small gap. Jump over projectiles just before they reach you. You can combine keys in one step (for example jump + attack) to dodge and attack at once.\n` +
    `Play to make the promise come true if the game allows it; do not give up early. Set done=true only when the screen clearly shows the promise kept (outcome kept), or the game is over (outcome game_over) or frozen (outcome stuck).\n` +
    `Read the HUD text on screen (health, counters, labels) and use it. First locate YOUR character: it is the one that moved in response to your last inputs (compare the two screens). Enemies touching you hurt you, so attack them from just out of reach instead of walking through them.\n` +
    `Turn ${turn} of ${maxTurns}. Your recent turns:\n${history.slice(-6).join('\n') || '(none yet)'}\n`;
}

// driver: { shot(): base64 png, rulerShot(): base64 png with a measuring overlay (pilot only), hold(keys, frames), text(): visible page text, errors(): string[] }
export async function pilot(driver, { promise, key, maxTurns = 24, onEvent = () => {}, snap, lessons = [] }) {
  const controls = (await driver.text()).replace(/\s+/g, ' ').slice(0, 300);
  const history = lessons.map(l => `LESSON from an earlier attempt that ended badly: ${l}`);
  let prev = null, stuck = 0, lastSee = '';
  let turns = 0, done = false, plans = 0, outcome = 'playing', lastSeen = '';
  for (let turn = 1; turn <= maxTurns && !done; turn++) {
    const png = driver.rulerShot ? await driver.rulerShot() : await driver.shot();
    const parts = [prompt({ promise, controls, history, turn, maxTurns })];
    // Stuck detector: the same reading three turns running means the plan isn't working.
    if (stuck >= 2) parts.push(`WARNING: your last ${stuck + 1} turns changed nothing on screen. Your approach is not working. Reposition (move away and come back, turn around, jump) and try something different.`);
    if (prev) parts.push('The screen BEFORE your last plan ran:', { png: prev });
    parts.push('The screen NOW:', { png });
    const t = Date.now();
    const p = await askJSON(parts, PLAN, { key, role: 'pilot' }); // a fast model for the hands
    p.ms = Date.now() - t;
    prev = png;
    const reading = `${p.me} ${p.see}`.match(/\d+/g)?.join(',') || ''; // the numbers it reads: positions, HP, counters
    stuck = reading && reading === lastSee ? stuck + 1 : 0; lastSee = reading;
    turns = turn;
    const steps = (p.plan || []).slice(0, 5).map(s => ({ keys: (s.keys || []).filter(k => KEYS.includes(k)), frames: Math.min(60, Math.max(1, s.frames | 0)) }));
    const said = `turn ${turn}: me: ${p.me}; progress: ${p.progress}; saw "${p.see}"; ${p.done ? 'stopped' : `did ${steps.map(s => `${s.keys.join('+') || 'wait'}x${s.frames}`).join(', ')}`}`;
    history.push(said);
    onEvent({ type: 'think', turn, ms: p.ms, me: p.me, see: p.see, goal: p.goal, plan: steps, done: !!p.done });
    lastSeen = `${p.see} ${p.progress || ''}`.slice(0, 300);
    if (p.done) { done = true; outcome = p.outcome || 'kept'; break; }
    for (const s of steps) await driver.hold(s.keys, s.frames);
    plans += steps.length;
    if (snap) await snap(`turn ${turn}: ${p.goal || p.see}`.slice(0, 90));
    if ((await driver.errors()).length) { onEvent({ type: 'log', text: `page error: ${(await driver.errors())[0]}` }); }
  }
  return { turns, steps: plans, stoppedByAgent: done, outcome, lastSeen, history: history.filter(h => !h.startsWith('LESSON')) };
}
