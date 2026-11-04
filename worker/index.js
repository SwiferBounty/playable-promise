// Playable Promise on Cloudflare Workers: D1 for the ledger, Browser Rendering for the
// playtest agent, static assets for the UI and the game. Same API as server.js (Node).
import { makePayPal } from '../lib/paypal.js';
import { MILESTONES } from '../agent/policy.js';
import { decide, overdue } from '../lib/backer-agent.js';
import { playtest } from './playtest.js';
import { serveStatic } from './static.js';
import { chat, checkConditions } from '../lib/agent-chat.js';

const DUE_DAYS = [14, 28, 42];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function ctx(env, url) {
  const D = env.DB;
  const q = (sql, a) => D.prepare(sql).bind(...a);
  const all = async (sql, ...a) => (await q(sql, a).all()).results;
  const get = (sql, ...a) => q(sql, a).first();
  const run = async (sql, ...a) => { const r = await q(sql, a).run(); return { lastInsertRowid: r.meta.last_row_id }; };
  const PUBLIC_URL = env.PUBLIC_URL || url.origin;
  const c = {
    all, get, run, PUBLIC_URL,
    paypal: makePayPal({ id: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_CLIENT_SECRET, base: env.PAYPAL_API_BASE || undefined }),
    TRANCHE: env.TRANCHE_USD || '10.00',
    CREATOR_EMAIL: env.CREATOR_EMAIL || 'creator@playable-promise.example',
    CREATOR_SHARE: Number(env.CREATOR_SHARE || '0.95'),
    key: env.GEMINI_DISABLED === '1' ? null : env.GEMINI_API_KEY,
  };
  c.day = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
  c.today = async () => c.day((await get(`SELECT offset_days FROM clock`))?.offset_days || 0);
  c.note = (b, n, action, reason, runId = null) =>
    run(`INSERT INTO decisions (backer_id, milestone, action, reason, run_id) VALUES (?, ?, ?, ?, ?)`, b, n, action, reason, runId);
  return c;
}

async function seed(c) {
  await c.run(`INSERT OR IGNORE INTO clock (id, offset_days) VALUES (1, 0)`);
  for (const m of MILESTONES)
    await c.run(`INSERT OR IGNORE INTO milestones (n, title, test, amount, due) VALUES (?, ?, ?, ?, ?)`, m.n, m.title, m.test, c.TRANCHE, c.day(DUE_DAYS[m.n - 1]));
}

async function act(c, b, m, report) {
  if (await c.get(`SELECT 1 FROM charges WHERE backer_id = ? AND milestone = ? AND status = 'COMPLETED'`, b.id, m.n)) return;
  const spent = (await c.get(`SELECT COALESCE(SUM(amount), 0) AS s FROM charges WHERE backer_id = ? AND status = 'COMPLETED'`, b.id)).s;
  let d = decide(b, m, report, Number(spent));
  if (d.action === 'pay' && b.conditions && c.key) {
    try {
      const frames = await c.all(`SELECT i, png FROM frames WHERE run_id = ? ORDER BY i`, report.runId);
      const labels = Object.fromEntries((report.frames || []).map(f => [f.i, f.label]));
      const k = await checkConditions({ conditions: b.conditions, promise: report.promise, key: c.key,
        frames: frames.map(f => ({ i: f.i, png: f.png, label: labels[f.i] || '' })) });
      if (!k.met) d = { action: 'hold', reason: `Held: the creator's promise was kept, but your own condition was not ("${b.conditions}"). ${k.why}` };
      else d = { ...d, reason: `${d.reason} Your condition checks out too: ${k.why}` };
    } catch (e) { d = { action: 'hold', reason: `Held: I could not check your condition ("${b.conditions}") just now (${e.message}). I will not pay until I can.` }; }
  }
  await c.note(b.id, m.n, d.action, d.reason, report.runId);
  if (d.action === 'pay') await chargeBacker(c, b, m, report.runId);
}

async function chargeBacker(c, b, m, runId) {
  try {
    const o = await c.paypal.chargeTranche({ vaultId: b.vault_id, amount: m.amount, milestone: m.n, title: m.title, backerId: b.id, runId });
    const cap = o.purchase_units?.[0]?.payments?.captures?.[0];
    await c.run(`INSERT OR REPLACE INTO charges (backer_id, milestone, amount, order_id, capture_id, status, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      b.id, m.n, m.amount, o.id, cap?.id ?? null, cap?.status ?? o.status, runId);
  } catch (e) {
    await c.run(`INSERT OR REPLACE INTO charges (backer_id, milestone, amount, status, run_id, error) VALUES (?, ?, ?, 'FAILED', ?, ?)`, b.id, m.n, m.amount, runId, e.message);
  }
}

async function payCreator(c, m, runId) {
  const paid = (await c.get(`SELECT COALESCE(SUM(amount), 0) AS s FROM charges WHERE milestone = ? AND status = 'COMPLETED'`, m.n)).s;
  if (!Number(paid) || await c.get(`SELECT 1 FROM payouts WHERE milestone = ? AND status != 'FAILED'`, m.n)) return;
  const amount = (Number(paid) * c.CREATOR_SHARE).toFixed(2);
  try {
    const p = await c.paypal.payoutCreator({ email: c.CREATOR_EMAIL, amount, milestone: m.n, runId });
    await c.run(`INSERT OR REPLACE INTO payouts (milestone, amount, batch_id, status, run_id) VALUES (?, ?, ?, ?, ?)`, m.n, amount, p.batch_header.payout_batch_id, p.batch_header.batch_status, runId);
  } catch (e) { await c.run(`INSERT OR REPLACE INTO payouts (milestone, amount, status, run_id, error) VALUES (?, ?, 'FAILED', ?, ?)`, m.n, amount, runId, e.message); }
}

async function sweep(c) {
  const late = overdue(await c.all(`SELECT * FROM milestones ORDER BY n`), await c.today());
  if (!late) return;
  for (const b of await c.all(`SELECT * FROM backers WHERE status = 'active'`)) {
    try { if (b.vault_id) await c.paypal.deletePaymentToken(b.vault_id); } catch { /* already gone is fine */ }
    const reason = `Walked away: M${late.n} "${late.title}" was due ${late.due} and never shipped a build that worked. I deleted your saved PayPal, so nothing more can be charged.`;
    await c.run(`UPDATE backers SET status = 'walked_away', walked_reason = ? WHERE id = ?`, reason, b.id);
    await c.note(b.id, late.n, 'walk', reason);
  }
}

// Save a finished run: frames go to D1 as base64, the report keeps their labels and URLs.
async function saveRun(c, r, n, build) {
  for (const f of r.frames) await c.run(`INSERT OR REPLACE INTO frames (run_id, i, png) VALUES (?, ?, ?)`, r.runId, f.i, f.png);
  const report = { ...r, frames: r.frames.map(({ png, ...f }) => f) };
  await c.run(`INSERT INTO runs (id, milestone, build, passed, verdict, json) VALUES (?, ?, ?, ?, ?, ?)`, r.runId, n, build, r.passed ? 1 : 0, r.verdict, JSON.stringify(report));
  return report;
}

// Long runs stream newline-delimited JSON events (frames, the pilot's thinking, the verdict) as they happen.
// Clients that don't ask for ?stream=1 just get the final JSON.
function streamed(ctx, url, work) {
  if (url.searchParams.get('stream') !== '1') {
    return (async () => { try { return json(await work(() => {})); } catch (e) { return json({ error: e.message }, 500); } })();
  }
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter(), enc = new TextEncoder();
  const emit = e => w.write(enc.encode(JSON.stringify(e) + '\n')).catch(() => {});
  ctx.waitUntil((async () => {
    try { emit({ type: 'done', ...(await work(emit)) }); }
    catch (e) { emit({ type: 'error', error: e.message }); }
    finally { await w.close().catch(() => {}); }
  })());
  return new Response(readable, { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' } });
}

const routes = [
  ['GET', /^\/api\/dev\/models$/, async (c, req, url, m, env) => {
    if (!env.DEV_TOKEN || req.headers.get('x-dev-token') !== env.DEV_TOKEN) return new Response('Not found', { status: 404 });
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': env.GEMINI_API_KEY } });
    return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json' } });
  }],
  // Dev only: lets a local checkout reach Gemini through this Worker's key. Off unless DEV_TOKEN is set.
  ['POST', /^\/api\/dev\/gemini\/([\w.-]+)$/, async (c, req, url, [model], env) => {
    if (!env.DEV_TOKEN || req.headers.get('x-dev-token') !== env.DEV_TOKEN) return new Response('Not found', { status: 404 });
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY }, body: await req.text() });
    return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json' } });
  }],
  ['GET', /^\/api\/state$/, async c => {
    const runs = await c.all(`SELECT id, milestone, build, passed, verdict, json, created_at FROM runs ORDER BY created_at DESC LIMIT 10`);
    return json({
      milestones: await c.all(`SELECT n, title, test, amount, status, build, verified_at, due FROM milestones ORDER BY n`),
      backers: await c.all(`SELECT id, name, status, created_at FROM backers ORDER BY id`),
      charges: await c.all(`SELECT c.*, b.name FROM charges c JOIN backers b ON b.id = c.backer_id ORDER BY c.id`),
      runs: runs.map(({ json: j, ...r }) => { const x = JSON.parse(j); return { ...r, tamper: x.tamper, ai: x.ai, frames: x.frames, promise: x.promise }; }),
      decisions: await c.all(`SELECT d.*, b.name FROM decisions d JOIN backers b ON b.id = d.backer_id ORDER BY d.id DESC LIMIT 40`),
      payouts: await c.all(`SELECT * FROM payouts ORDER BY milestone`),
      today: await c.today(), creator: c.CREATOR_EMAIL, share: c.CREATOR_SHARE,
    });
  }],
  ['POST', /^\/api\/clock$/, async (c, req) => {
    const body = await req.json().catch(() => ({}));
    await c.run(`UPDATE clock SET offset_days = offset_days + ?`, Number(body.days || 0));
    await sweep(c);
    return json({ today: await c.today() });
  }],
  ['POST', /^\/api\/pledge$/, async (c, req) => {
    try {
      const { name = 'Backer', email = '', cap = '' } = await req.json().catch(() => ({}));
      const { lastInsertRowid: id } = await c.run(`INSERT INTO backers (name, email, cap) VALUES (?, ?, ?)`, String(name).slice(0, 60), email, cap || null);
      const st = await c.paypal.createSetupToken(`${c.PUBLIC_URL}/pledge/return?backer=${id}`, `${c.PUBLIC_URL}/?cancelled=1`);
      await c.run(`UPDATE backers SET setup_token = ? WHERE id = ?`, st.id, id);
      return json({ backerId: Number(id), approveUrl: st.links.find(l => l.rel === 'approve').href });
    } catch (e) { return json({ error: e.message, details: e.details }, 502); }
  }],
  ['GET', /^\/pledge\/return$/, async (c, req, url) => {
    const b = await c.get(`SELECT * FROM backers WHERE id = ?`, url.searchParams.get('backer'));
    if (!b) return new Response('Unknown backer', { status: 404 });
    try {
      const pt = await c.paypal.createPaymentToken(url.searchParams.get('approval_token_id') || b.setup_token);
      await c.run(`UPDATE backers SET vault_id = ?, payer_email = ?, status = 'active' WHERE id = ?`, pt.id, pt.payment_source?.paypal?.email_address ?? null, b.id);
      await c.note(b.id, 0, 'join', `Saved your PayPal. I will only pay when I see each milestone working myself${b.cap ? `, and never more than $${b.cap}` : ''}.`);
      for (const m of await c.all(`SELECT * FROM milestones WHERE status = 'verified'`))
        await act(c, await c.get(`SELECT * FROM backers WHERE id = ?`, b.id), m, JSON.parse(m.run_json));
      return Response.redirect(`${c.PUBLIC_URL}/agent.html?id=${b.id}&pledged=1`, 302);
    } catch (e) { return new Response(`Could not save your PayPal: ${e.message}`, { status: 502 }); }
  }],
  ['POST', /^\/api\/milestones\/(\d+)\/promise$/, async (c, req, url, [n]) => {
    const m = await c.get(`SELECT * FROM milestones WHERE n = ?`, Number(n));
    if (!m || m.status === 'verified') return json({ error: 'Cannot change a verified promise' }, 409);
    if (await c.get(`SELECT 1 FROM backers WHERE status = 'active'`)) return json({ error: 'Backers already pledged against this promise' }, 409);
    const body = await req.json().catch(() => ({}));
    await c.run(`UPDATE milestones SET test = ? WHERE n = ?`, String(body.test || m.test).slice(0, 300), m.n);
    return json(await c.get(`SELECT * FROM milestones WHERE n = ?`, m.n));
  }],
  ['POST', /^\/api\/milestones\/(\d+)\/submit$/, async (c, req, url, [ns], env, ctx) => {
    const n = Number(ns);
    const m = await c.get(`SELECT * FROM milestones WHERE n = ?`, n);
    if (!m) return json({ error: 'No such milestone' }, 404);
    if (m.status === 'verified') return json({ error: 'Already verified and charged' }, 409);
    for (let k = 1; k < n; k++) if ((await c.get(`SELECT status FROM milestones WHERE n = ?`, k)).status !== 'verified')
      return json({ error: `Milestone ${k} must be verified first` }, 409);
    const body = await req.json().catch(() => ({}));
    const build = String(body.build || '');
    const buildUrl = /^https?:\/\//.test(build) ? build : `${url.origin}/games/boss-rush/?build=${encodeURIComponent(build)}`;
    return streamed(ctx, url, async emit => {
      const r = await playtest(env, buildUrl, n, { promises: await c.all(`SELECT n, test FROM milestones ORDER BY n`), mode: body.mode === 'script' ? 'script' : 'ai', onEvent: emit });
      const report = await saveRun(c, r, n, build);
      if (r.passed) await c.run(`UPDATE milestones SET status = 'verified', build = ?, run_json = ?, verified_at = CURRENT_TIMESTAMP WHERE n = ?`, build, JSON.stringify(report), n);
      else await c.run(`UPDATE milestones SET status = 'rejected', build = ? WHERE n = ?`, build, n);
      for (const b of await c.all(`SELECT * FROM backers WHERE status = 'active'`)) await act(c, b, m, report);
      if (r.passed) await payCreator(c, m, r.runId);
      return { run: report, charges: await c.all(`SELECT * FROM charges WHERE milestone = ?`, n), payout: await c.get(`SELECT * FROM payouts WHERE milestone = ?`, n),
        decisions: await c.all(`SELECT d.*, b.name FROM decisions d JOIN backers b ON b.id = d.backer_id WHERE d.run_id = ?`, r.runId) };
    });
  }],
  // Test any web game against any promise. No money moves; it shows what the agent would decide.
  ['POST', /^\/api\/try$/, async (c, req, url, m, env, ctx) => {
    const body = await req.json().catch(() => ({}));
    const game = String(body.url || '').trim(), promise = String(body.promise || '').trim().slice(0, 300);
    if (!/^https:\/\/[^\s]+$/.test(game) || !promise) return json({ error: 'Give an https game URL and a promise' }, 400);
    return streamed(ctx, url, async emit => {
      const r = await playtest(env, game, 1, { promises: [{ n: 1, test: promise }], onEvent: emit, maxTurns: 12 });
      return { run: await saveRun(c, r, 0, game) };
    });
  }],
  ['GET', /^\/api\/runs\/([\w-]+)$/, async (c, req, url, [id]) => {
    const row = await c.get(`SELECT json, build, created_at FROM runs WHERE id = ?`, id);
    return row ? json({ ...JSON.parse(row.json), build: row.build, created_at: row.created_at }) : json({ error: 'No such run' }, 404);
  }],
  ['GET', /^\/api\/agents\/(\d+)$/, async (c, req, url, [id]) => {
    const b = await c.get(`SELECT id, name, status, cap, conditions, walked_reason, payer_email, created_at FROM backers WHERE id = ?`, Number(id));
    if (!b) return json({ error: 'No such agent' }, 404);
    return json({ backer: b,
      decisions: await c.all(`SELECT * FROM decisions WHERE backer_id = ? ORDER BY id DESC LIMIT 50`, b.id),
      charges: await c.all(`SELECT * FROM charges WHERE backer_id = ? ORDER BY milestone`, b.id),
      messages: await c.all(`SELECT role, text, run_id, created_at FROM agent_messages WHERE backer_id = ? ORDER BY id`, b.id),
      milestones: await c.all(`SELECT n, title, test, amount, status, due FROM milestones ORDER BY n`), today: await c.today() });
  }],
  ['POST', /^\/api\/agents\/(\d+)\/chat$/, async (c, req, url, [id]) => {
    const b = await c.get(`SELECT * FROM backers WHERE id = ?`, Number(id));
    if (!b) return json({ error: 'No such agent' }, 404);
    if (!c.key) return json({ error: 'The agent cannot talk right now (AI offline).' }, 503);
    const message = String((await req.json().catch(() => ({}))).message || '').trim().slice(0, 500);
    if (!message) return json({ error: 'Say something' }, 400);
    const decisions = await c.all(`SELECT milestone, action, reason, run_id, created_at FROM decisions WHERE backer_id = ? ORDER BY id DESC LIMIT 20`, b.id);
    const runIds = [...new Set(decisions.map(d => d.run_id).filter(Boolean))].slice(0, 5);
    const runs = [];
    for (const rid of runIds) { const r = await c.get(`SELECT json FROM runs WHERE id = ?`, rid); if (r) { const j = JSON.parse(r.json); runs.push({ id: rid, milestone: j.milestone, verdict: j.verdict, checks: j.ai?.checks }); } }
    const history = (await c.all(`SELECT role, text FROM agent_messages WHERE backer_id = ? ORDER BY id DESC LIMIT 10`, b.id)).reverse();
    let out;
    try { out = await chat({ backer: b, milestones: await c.all(`SELECT n, title, test, amount, status, due FROM milestones ORDER BY n`), decisions, runs, history, message, key: c.key }); }
    catch (e) { return json({ error: `The agent could not answer: ${e.message}` }, 502); }
    const changes = [];
    if (out.cap) { const cap = /none/i.test(out.cap) ? null : (out.cap.match(/\d+(\.\d+)?/) || [])[0] || b.cap; if (cap !== b.cap) { await c.run(`UPDATE backers SET cap = ? WHERE id = ?`, cap, b.id); changes.push(cap ? `cap set to $${cap}` : 'cap removed'); } }
    if (out.conditions) { const cond = /^none$/i.test(out.conditions.trim()) ? null : out.conditions.slice(0, 300); if (cond !== b.conditions) { await c.run(`UPDATE backers SET conditions = ? WHERE id = ?`, cond, b.id); changes.push(cond ? `condition: ${cond}` : 'conditions cleared'); } }
    if (changes.length) await c.note(b.id, 0, 'rule', `New rule from you: ${changes.join('; ')}.`);
    const cite = runIds.includes(out.cite_run) ? out.cite_run : null;
    await c.run(`INSERT INTO agent_messages (backer_id, role, text) VALUES (?, 'backer', ?)`, b.id, message);
    await c.run(`INSERT INTO agent_messages (backer_id, role, text, run_id) VALUES (?, 'agent', ?, ?)`, b.id, out.reply, cite);
    return json({ reply: out.reply, run_id: cite, changes });
  }],
  ['GET', /^\/runs\/([\w-]+)\/f(\d+)\.png$/, async (c, req, url, [id, i]) => {
    const f = await c.get(`SELECT png FROM frames WHERE run_id = ? AND i = ?`, id, Number(i));
    if (!f) return new Response('Not found', { status: 404 });
    return new Response(Uint8Array.from(atob(f.png), ch => ch.charCodeAt(0)), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' } });
  }],
  ['GET', /^\/runs\/([\w-]+)\/?$/, async (c, req, url, [id]) => Response.redirect(`${url.origin}/run.html?id=${encodeURIComponent(id)}`, 302)],
];

let seeded = false;
export default {
  async fetch(req, env, exec) {
    const url = new URL(req.url);
    for (const [method, re, handler] of routes) {
      const m = req.method === method && url.pathname.match(re);
      if (!m) continue;
      const c = ctx(env, url);
      if (!seeded) { await seed(c); seeded = true; }
      try { return await handler(c, req, url, m.slice(1), env, exec); }
      catch (e) { return json({ error: e.message }, 500); }
    }
    return serveStatic(url);
  },
};
