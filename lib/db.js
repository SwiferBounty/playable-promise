import { DatabaseSync } from 'node:sqlite';
export const db = new DatabaseSync(process.env.DB_PATH || 'playable-promise.db');
db.exec(`
CREATE TABLE IF NOT EXISTS milestones (n INTEGER PRIMARY KEY, title TEXT, test TEXT, amount TEXT,
  status TEXT DEFAULT 'pending', build TEXT, run_json TEXT, verified_at TEXT, due TEXT);
CREATE TABLE IF NOT EXISTS backers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT,
  setup_token TEXT, vault_id TEXT, payer_email TEXT, status TEXT DEFAULT 'awaiting_approval', created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  cap TEXT, deadline_days INTEGER, walked_reason TEXT);
CREATE TABLE IF NOT EXISTS charges (id INTEGER PRIMARY KEY AUTOINCREMENT, backer_id INTEGER, milestone INTEGER, amount TEXT,
  order_id TEXT, capture_id TEXT, status TEXT, run_id TEXT, error TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(backer_id, milestone));
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, milestone INTEGER, build TEXT, passed INTEGER, verdict TEXT,
  json TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, backer_id INTEGER, milestone INTEGER,
  action TEXT, reason TEXT, run_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS payouts (milestone INTEGER PRIMARY KEY, amount TEXT, batch_id TEXT, status TEXT, run_id TEXT, error TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS clock (id INTEGER PRIMARY KEY CHECK (id = 1), offset_days INTEGER DEFAULT 0);
INSERT OR IGNORE INTO clock (id, offset_days) VALUES (1, 0);
`);
export const all = (sql, ...a) => db.prepare(sql).all(...a);
export const get = (sql, ...a) => db.prepare(sql).get(...a);
export const run = (sql, ...a) => db.prepare(sql).run(...a);
