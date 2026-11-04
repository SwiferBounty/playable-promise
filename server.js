import express from 'express';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { all, get, run } from './lib/db.js';
import * as paypal from './lib/paypal.js';
import { playtest, MILESTONES } from './agent/playtest.js';

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const TRANCHE = process.env.TRANCHE_USD || '10.00'; // $30 game = three $10 milestones

for (const m of MILESTONES)
  run(`INSERT OR IGNORE INTO milestones (n, title, test, amount) VALUES (?, ?, ?, ?)`, m.n, m.title, m.test, TRANCHE);

const app = express();
app.use(express.json());
app.use(express.static('public'));
app.use('/games', express.static('games'));
app.use('/runs', express.static('runs'));

app.get('/api/state', (_req, res) => res.json({
  milestones: all(`SELECT n, title, test, amount, status, build, verified_at FROM milestones ORDER BY n`),
  backers: all(`SELECT id, name, status, created_at FROM backers ORDER BY id`),
  charges: all(`SELECT c.*, b.name FROM charges c JOIN backers b ON b.id = c.backer_id ORDER BY c.id`),
  runs: all(`SELECT id, milestone, build, passed, verdict, created_at FROM runs ORDER BY created_at DESC LIMIT 20`),
}));

// 1. Pre-order: save the backer's PayPal, charge nothing.
app.post('/api/pledge', async (req, res) => {
  try {
    const { name = 'Backer', email = '' } = req.body || {};
    const { lastInsertRowid: id } = run(`INSERT INTO backers (name, email) VALUES (?, ?)`, name, email);
    const st = await paypal.createSetupToken(`${PUBLIC_URL}/pledge/return?backer=${id}`, `${PUBLIC_URL}/?cancelled=1`);
    run(`UPDATE backers SET setup_token = ? WHERE id = ?`, st.id, id);
    res.json({ backerId: Number(id), approveUrl: st.links.find(l => l.rel === 'approve').href });
  } catch (e) { res.status(502).json({ error: e.message, details: e.details }); }
});

app.get('/pledge/return', async (req, res) => {
  const b = get(`SELECT * FROM backers WHERE id = ?`, req.query.backer);
  if (!b) return res.status(404).send('Unknown backer');
  try {
    const pt = await paypal.createPaymentToken(req.query.approval_token_id || b.setup_token);
    run(`UPDATE backers SET vault_id = ?, payer_email = ?, status = 'active' WHERE id = ?`,
      pt.id, pt.payment_source?.paypal?.email_address ?? null, b.id);
    // A backer who joins late pays for milestones that already shipped.
    for (const m of all(`SELECT * FROM milestones WHERE status = 'verified'`)) await chargeBacker(get(`SELECT * FROM backers WHERE id = ?`, b.id), m, JSON.parse(m.run_json).runId);
    res.redirect('/?pledged=1');
  } catch (e) { res.status(502).send(`Could not save your PayPal: ${e.message}`); }
});

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
  const r = await playtest(url, n);
  run(`INSERT INTO runs (id, milestone, build, passed, verdict, json) VALUES (?, ?, ?, ?, ?, ?)`, r.runId, n, build, r.passed ? 1 : 0, r.verdict, JSON.stringify(r));
  if (r.passed) {
    run(`UPDATE milestones SET status = 'verified', build = ?, run_json = ?, verified_at = CURRENT_TIMESTAMP WHERE n = ?`, build, JSON.stringify(r), n);
    for (const b of all(`SELECT * FROM backers WHERE status = 'active'`)) await chargeBacker(b, { ...m, n }, r.runId);
  } else run(`UPDATE milestones SET status = 'rejected', build = ? WHERE n = ?`, build, n);
  res.json({ run: r, charges: all(`SELECT * FROM charges WHERE milestone = ?`, n) });
});

app.listen(PORT, () => console.log(`Playable Promise on ${PUBLIC_URL}`));
