import express from 'express';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { all, get, run } from './lib/db.js';
import * as paypal from './lib/paypal.js';
import { playtest, MILESTONES } from './agent/playtest.js';
import { decide, overdue } from './lib/backer-agent.js';

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const TRANCHE = process.env.TRANCHE_USD || '10.00'; // $30 game = three $10 milestones

const CREATOR_EMAIL = process.env.CREATOR_EMAIL || 'creator@playable-promise.example';
const CREATOR_SHARE = Number(process.env.CREATOR_SHARE || '0.95'); // 5% platform fee
const DUE_DAYS = [14, 28, 42]; // each milestone's deadline, in days from launch
const day = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
for (const m of MILESTONES)
  run(`INSERT OR IGNORE INTO milestones (n, title, test, amount, due) VALUES (?, ?, ?, ?, ?)`, m.n, m.title, m.test, TRANCHE, day(DUE_DAYS[m.n - 1]));
const today = () => day(get(`SELECT offset_days FROM clock`).offset_days);
const note = (backerId, n, action, reason, runId = null) =>
  run(`INSERT INTO decisions (backer_id, milestone, action, reason, run_id) VALUES (?, ?, ?, ?, ?)`, backerId, n, action, reason, runId);

const app = express();
app.use(express.json());
app.use(express.static('public'));
app.use('/games', express.static('games'));
// Evidence page for one playtest run: the promise, the AI's checks, and every frame it judged.
app.get('/runs/:id/', (req, res) => {
  const row = get(`SELECT json FROM runs WHERE id = ?`, req.params.id);
  if (!row) return res.status(404).send('No such run');
  const r = JSON.parse(row.json), esc = t => String(t ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  res.send(`<!doctype html><meta charset="utf-8"><title>Run ${esc(r.runId)}</title><body style="font:15px system-ui;background:#0f0e17;color:#e8e6f0;padding:24px">
<h2>Playtest run ${esc(r.runId)}</h2><p><b>Promise:</b> ${esc(r.promise)}</p><p><b>Verdict:</b> ${esc(r.verdict)}</p>
${(r.ai?.checks || []).map(c => `<div>${c.met ? '✔' : '✘'} ${esc(c.look_for)}: <i>${esc(c.why)}</i></div>`).join('')}
<div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:16px">${r.frames.map(f => `<figure style="margin:0"><img src="/${esc(f.file)}" width="380"><figcaption>tick ${f.tick}: ${esc(f.label)}</figcaption></figure>`).join('')}</div>`);
});
app.use('/runs', express.static('runs'));

app.get('/api/state', (_req, res) => res.json({
  milestones: all(`SELECT n, title, test, amount, status, build, verified_at, due FROM milestones ORDER BY n`),
  backers: all(`SELECT id, name, status, created_at FROM backers ORDER BY id`),
  charges: all(`SELECT c.*, b.name FROM charges c JOIN backers b ON b.id = c.backer_id ORDER BY c.id`),
  runs: all(`SELECT id, milestone, build, passed, verdict, json, created_at FROM runs ORDER BY created_at DESC LIMIT 10`)
    .map(({ json, ...r }) => { const j = JSON.parse(json); return { ...r, tamper: j.tamper, ai: j.ai, frames: j.frames, promise: j.promise }; }),
  decisions: all(`SELECT d.*, b.name FROM decisions d JOIN backers b ON b.id = d.backer_id ORDER BY d.id DESC LIMIT 40`),
  payouts: all(`SELECT * FROM payouts ORDER BY milestone`),
  today: today(), creator: CREATOR_EMAIL, share: CREATOR_SHARE,
}));

// Demo time machine: jump the clock forward so overdue milestones trigger the backers' agents.
app.post('/api/clock', (req, res) => {
  run(`UPDATE clock SET offset_days = offset_days + ?`, Number(req.body?.days || 0));
  sweep().then(() => res.json({ today: today() }), e => res.status(500).json({ error: e.message }));
});

async function sweep() {
  const late = overdue(all(`SELECT * FROM milestones ORDER BY n`), today());
  if (!late) return;
  for (const b of all(`SELECT * FROM backers WHERE status = 'active'`)) {
    try { if (b.vault_id) await paypal.deletePaymentToken(b.vault_id); } catch (e) { /* already gone is fine */ }
    const reason = `Walked away: M${late.n} "${late.title}" was due ${late.due} and never shipped a build that worked. I deleted your saved PayPal, so nothing more can be charged.`;
    run(`UPDATE backers SET status = 'walked_away', walked_reason = ? WHERE id = ?`, reason, b.id);
    note(b.id, late.n, 'walk', reason);
  }
}

// 1. Pre-order: save the backer's PayPal, charge nothing.
app.post('/api/pledge', async (req, res) => {
  try {
    const { name = 'Backer', email = '', cap = '' } = req.body || {};
    const { lastInsertRowid: id } = run(`INSERT INTO backers (name, email, cap) VALUES (?, ?, ?)`, name, email, cap || null);
    const st = await paypal.createSetupToken(`${PUBLIC_URL}/pledge/return?backer=${id}`, `${PUBLIC_URL}/?cancelled=1`);
    run(`UPDATE backers SET setup_token = ? WHERE id = ?`, st.id, id);
    res.json({ backerId: Number(id), approveUrl: st.links.find(l => l.rel === 'approve').href });
  } catch (e) { res.status(502).json({ error: e.message, details: e.details }); }
});

// The creator writes each promise in plain English; the agent turns it into checks itself.
app.post('/api/milestones/:n/promise', (req, res) => {
  const m = get(`SELECT * FROM milestones WHERE n = ?`, Number(req.params.n));
  if (!m || m.status === 'verified') return res.status(409).json({ error: 'Cannot change a verified promise' });
  if (get(`SELECT 1 FROM backers WHERE status = 'active'`)) return res.status(409).json({ error: 'Backers already pledged against this promise' });
  run(`UPDATE milestones SET test = ? WHERE n = ?`, String(req.body?.test || m.test).slice(0, 300), m.n);
  res.json(get(`SELECT * FROM milestones WHERE n = ?`, m.n));
});

app.get('/pledge/return', async (req, res) => {
  const b = get(`SELECT * FROM backers WHERE id = ?`, req.query.backer);
  if (!b) return res.status(404).send('Unknown backer');
  try {
    const pt = await paypal.createPaymentToken(req.query.approval_token_id || b.setup_token);
    run(`UPDATE backers SET vault_id = ?, payer_email = ?, status = 'active' WHERE id = ?`,
      pt.id, pt.payment_source?.paypal?.email_address ?? null, b.id);
    // A backer who joins late pays for milestones that already shipped.
    note(b.id, 0, 'join', `Saved your PayPal. I will only pay when I see each milestone working myself${b.cap ? `, and never more than $${b.cap}` : ''}.`);
    for (const m of all(`SELECT * FROM milestones WHERE status = 'verified'`)) await act(get(`SELECT * FROM backers WHERE id = ?`, b.id), m, JSON.parse(m.run_json));
    res.redirect('/?pledged=1');
  } catch (e) { res.status(502).send(`Could not save your PayPal: ${e.message}`); }
});

// The backer's agent looks at the playtest report and decides for its backer.
async function act(b, m, report) {
  if (get(`SELECT 1 FROM charges WHERE backer_id = ? AND milestone = ? AND status = 'COMPLETED'`, b.id, m.n)) return;
  const spent = get(`SELECT COALESCE(SUM(amount), 0) AS s FROM charges WHERE backer_id = ? AND status = 'COMPLETED'`, b.id).s;
  const d = decide(b, m, report, Number(spent));
  note(b.id, m.n, d.action, d.reason, report.runId);
  if (d.action === 'pay') await chargeBacker(b, m, report.runId);
}

async function payCreator(m, runId) {
  const paid = get(`SELECT COALESCE(SUM(amount), 0) AS s FROM charges WHERE milestone = ? AND status = 'COMPLETED'`, m.n).s;
  if (!paid || get(`SELECT 1 FROM payouts WHERE milestone = ? AND status != 'FAILED'`, m.n)) return;
  const amount = (Number(paid) * CREATOR_SHARE).toFixed(2);
  try {
    const p = await paypal.payoutCreator({ email: CREATOR_EMAIL, amount, milestone: m.n, runId });
    run(`INSERT OR REPLACE INTO payouts (milestone, amount, batch_id, status, run_id) VALUES (?, ?, ?, ?, ?)`, m.n, amount, p.batch_header.payout_batch_id, p.batch_header.batch_status, runId);
  } catch (e) { run(`INSERT OR REPLACE INTO payouts (milestone, amount, status, run_id, error) VALUES (?, ?, 'FAILED', ?, ?)`, m.n, amount, runId, e.message); }
}

async function chargeBacker(b, m, runId) {
  if (get(`SELECT 1 FROM charges WHERE backer_id = ? AND milestone = ? AND status = 'COMPLETED'`, b.id, m.n)) return;
  try {
    const o = await paypal.chargeTranche({ vaultId: b.vault_id, amount: m.amount, milestone: m.n, title: m.title, backerId: b.id, runId });
    const cap = o.purchase_units?.[0]?.payments?.captures?.[0];
    run(`INSERT OR REPLACE INTO charges (backer_id, milestone, amount, order_id, capture_id, status, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      b.id, m.n, m.amount, o.id, cap?.id ?? null, cap?.status ?? o.status, runId);
  } catch (e) {
    run(`INSERT OR REPLACE INTO charges (backer_id, milestone, amount, status, run_id, error) VALUES (?, ?, ?, 'FAILED', ?, ?)`,
      b.id, m.n, m.amount, runId, e.message);
  }
}

// 2. Creator ships a milestone build: the agent plays it; only a pass charges backers.
app.post('/api/milestones/:n/submit', async (req, res) => {
  const n = Number(req.params.n);
  const m = get(`SELECT * FROM milestones WHERE n = ?`, n);
  if (!m) return res.status(404).json({ error: 'No such milestone' });
  if (m.status === 'verified') return res.status(409).json({ error: 'Already verified and charged' });
  for (let k = 1; k < n; k++) if (get(`SELECT status FROM milestones WHERE n = ?`, k).status !== 'verified')
    return res.status(409).json({ error: `Milestone ${k} must be verified first` });
  const build = String(req.body?.build || '');
  const url = /^https?:\/\//.test(build) ? build : pathToFileURL(resolve('games/boss-rush/index.html')).href + `?build=${encodeURIComponent(build)}`;
  const r = await playtest(url, n, { promises: all(`SELECT n, test FROM milestones ORDER BY n`) });
  run(`INSERT INTO runs (id, milestone, build, passed, verdict, json) VALUES (?, ?, ?, ?, ?, ?)`, r.runId, n, build, r.passed ? 1 : 0, r.verdict, JSON.stringify(r));
  if (r.passed) {
    run(`UPDATE milestones SET status = 'verified', build = ?, run_json = ?, verified_at = CURRENT_TIMESTAMP WHERE n = ?`, build, JSON.stringify(r), n);
  } else run(`UPDATE milestones SET status = 'rejected', build = ? WHERE n = ?`, build, n);
  for (const b of all(`SELECT * FROM backers WHERE status = 'active'`)) await act(b, m, r);
  if (r.passed) await payCreator(m, r.runId);
  res.json({ run: r, charges: all(`SELECT * FROM charges WHERE milestone = ?`, n), payout: get(`SELECT * FROM payouts WHERE milestone = ?`, n) });
});

app.listen(PORT, () => console.log(`Playable Promise on ${PUBLIC_URL}`));
