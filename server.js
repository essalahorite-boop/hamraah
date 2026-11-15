const express = require('express');
const { createClient } = require('@libsql/client');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';      // lets you edit/delete/unhide any post
const REPORTS_TO_HIDE = 3;                          // distinct reports before a post is hidden
const KEEP_DAYS = 60;                               // older posts are deleted

// Turso in production; a local SQLite file when TURSO_DATABASE_URL isn't set.
let dbUrl = process.env.TURSO_DATABASE_URL;
if (!dbUrl) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  dbUrl = 'file:' + path.join(__dirname, 'data', 'hamraah.db');
}
const db = createClient({ url: dbUrl, authToken: process.env.TURSO_AUTH_TOKEN });

const KINDS = ['rides', 'requests'];
const SEAT = ['single', 'female', 'family', 'group'];
const LUG = ['none', 'light', 'medium', 'heavy'];
const FLEX = ['exact', '1h', '3h', 'any'];

async function setup() {
  for (const t of KINDS) {
    await db.execute(`CREATE TABLE IF NOT EXISTS ${t} (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      data TEXT NOT NULL,
      reports TEXT NOT NULL DEFAULT '[]',
      hidden INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL
    )`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_${t}_date ON ${t}(date)`);
  }
}

/* ---------- cache: lists are read from the DB only after something changes ---------- */
const cache = { rides: null, requests: null };
const sinceDate = () => new Date(Date.now() - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
async function list(kind) {
  if (!cache[kind]) {
    const { rows } = await db.execute({
      sql: `SELECT id, date, status, data, createdAt FROM ${kind} WHERE hidden = 0 AND date >= ? ORDER BY date, createdAt`,
      args: [sinceDate()],
    });
    cache[kind] = JSON.stringify(rows.map(r => ({ ...JSON.parse(r.data), id: r.id, status: r.status, date: r.date, createdAt: Number(r.createdAt) })));
  }
  return cache[kind];
}
const invalidate = kind => { cache[kind] = null; };

/* ---------- validation ---------- */
const str = (v, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const title = s => s.replace(/\s+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const phoneOk = p => /^(\+92|0092|92|0)?3\d{9}$/.test(String(p || '').replace(/[\s\-()]/g, ''));
const num = (v, min, max) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : null; };
const optNum = v => (v === null || v === undefined || v === '' ? null : num(v, 0, 50000));

// Returns the cleaned post, or an error code the front end translates.
function validate(kind, b) {
  const d = {
    from: title(str(b.from, 40)), to: title(str(b.to, 40)),
    fromArea: str(b.fromArea, 80), toArea: str(b.toArea, 80),
    date: str(b.date, 10), time: str(b.time, 5),
    seats: num(b.seats, 1, 15),
    luggage: LUG.includes(b.luggage) ? b.luggage : (kind === 'rides' ? 'medium' : 'light'),
    name: str(b.name, 50), phone: str(b.phone, 20), notes: str(b.notes, 300),
  };
  if (!d.from || !d.to) return 'cities';
  if (d.from.toLowerCase() === d.to.toLowerCase()) return 'same';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date) || !/^\d{2}:\d{2}$/.test(d.time)) return 'datetime';
  // Times are Pakistan time (UTC+5) no matter where the server runs.
  if (new Date(`${d.date}T${d.time}:00+05:00`).getTime() < Date.now() - 2 * 3600e3) return 'past';
  if (d.seats === null) return 'seats';
  if (!d.name) return 'name';
  if (!phoneOk(d.phone)) return 'phone';
  if (kind === 'rides') {
    d.via = str(b.via, 120);
    d.car = str(b.car, 40);
    d.fare = optNum(b.fare);
    d.allows = Array.isArray(b.allows) ? [...new Set(b.allows.filter(a => SEAT.includes(a)))] : [];
    if (!d.allows.length) return 'allows';
  } else {
    d.flex = FLEX.includes(b.flex) ? b.flex : '1h';
    d.seatType = SEAT.includes(b.seatType) ? b.seatType : null;
    if (!d.seatType) return 'seattype';
    d.budget = optNum(b.budget);
  }
  return d;
}

/* ---------- app ---------- */
const app = express();
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  });
  next();
});
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const fail = (res, status, code) => res.status(status).json({ code });
const clientId = req => { const c = req.get('x-client-id') || ''; return /^[a-z0-9]{8,40}$/i.test(c) ? c : ''; };

// Two limits on posting: a loose one per connection (mobile networks share IPs)
// and a strict one per browser.
const ipLimiter = rateLimit({ windowMs: 3600e3, limit: 100, handler: (req, res) => fail(res, 429, 'rate') });
const browserLimiter = rateLimit({
  windowMs: 3600e3, limit: 5,
  keyGenerator: req => clientId(req) || 'ip:' + req.ip,
  handler: (req, res) => fail(res, 429, 'rate'),
});
const reportLimiter = rateLimit({ windowMs: 3600e3, limit: 20, handler: (req, res) => fail(res, 429, 'rate') });

const kindOk = (req, res, next) => (KINDS.includes(req.params.kind) ? next() : fail(res, 404, 'notfound'));
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); fail(res, 500, 'generic'); });

app.get('/api/:kind', kindOk, wrap(async (req, res) => {
  res.type('json').send(await list(req.params.kind));
}));

app.post('/api/:kind', kindOk, ipLimiter, browserLimiter, wrap(async (req, res) => {
  const d = validate(req.params.kind, req.body || {});
  if (typeof d === 'string') return fail(res, 400, d);
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(18).toString('hex');
  await db.execute({
    sql: `INSERT INTO ${req.params.kind} (id, token, date, data, createdAt) VALUES (?, ?, ?, ?, ?)`,
    args: [id, token, d.date, JSON.stringify(d), Date.now()],
  });
  invalidate(req.params.kind);
  res.status(201).json({ id, token });
}));

async function authorize(req, res) {
  const { rows } = await db.execute({ sql: `SELECT * FROM ${req.params.kind} WHERE id = ?`, args: [req.params.id] });
  const row = rows[0];
  if (!row) { fail(res, 404, 'notfound'); return null; }
  const key = req.get('x-edit-token') || '';
  const admin = !!ADMIN_KEY && key === ADMIN_KEY;
  if (key !== row.token && !admin) { fail(res, 403, 'forbidden'); return null; }
  return { row, admin };
}

// Owners can change status and seats; the admin can also unhide a reported post.
app.patch('/api/:kind/:id', kindOk, wrap(async (req, res) => {
  const auth = await authorize(req, res); if (!auth) return;
  const { row, admin } = auth;
  const data = JSON.parse(row.data);
  const b = req.body || {};
  let status = row.status, hidden = Number(row.hidden), reports = row.reports;
  if (['open', 'closed'].includes(b.status)) status = b.status;
  if (b.seats !== undefined && req.params.kind === 'rides') {
    const s = num(b.seats, 0, 15);
    if (s === null) return fail(res, 400, 'seats');
    data.seats = s;
  }
  if (admin && b.hidden === false) { hidden = 0; reports = '[]'; }
  await db.execute({
    sql: `UPDATE ${req.params.kind} SET status = ?, data = ?, hidden = ?, reports = ? WHERE id = ?`,
    args: [status, JSON.stringify(data), hidden, reports, row.id],
  });
  invalidate(req.params.kind);
  res.json({ ok: true });
}));

app.delete('/api/:kind/:id', kindOk, wrap(async (req, res) => {
  const auth = await authorize(req, res); if (!auth) return;
  await db.execute({ sql: `DELETE FROM ${req.params.kind} WHERE id = ?`, args: [auth.row.id] });
  invalidate(req.params.kind);
  res.json({ ok: true });
}));

// Anyone can report a post; it's hidden after REPORTS_TO_HIDE different browsers report it.
app.post('/api/:kind/:id/report', kindOk, reportLimiter, wrap(async (req, res) => {
  const cid = clientId(req);
  if (!cid) return fail(res, 400, 'generic');
  const { rows } = await db.execute({ sql: `SELECT id, reports FROM ${req.params.kind} WHERE id = ?`, args: [req.params.id] });
  if (!rows[0]) return fail(res, 404, 'notfound');
  const reporter = crypto.createHash('sha256').update(cid).digest('hex').slice(0, 16);
  const reports = JSON.parse(rows[0].reports);
  if (!reports.includes(reporter)) reports.push(reporter);
  const hidden = reports.length >= REPORTS_TO_HIDE ? 1 : 0;
  await db.execute({
    sql: `UPDATE ${req.params.kind} SET reports = ?, hidden = ? WHERE id = ?`,
    args: [JSON.stringify(reports), hidden, rows[0].id],
  });
  if (hidden) invalidate(req.params.kind);
  res.json({ ok: true });
}));

// Admin: see hidden (reported) posts so you can delete or restore them.
app.get('/api/admin/hidden', wrap(async (req, res) => {
  if (!ADMIN_KEY || req.get('x-edit-token') !== ADMIN_KEY) return fail(res, 403, 'forbidden');
  const out = {};
  for (const t of KINDS) {
    const { rows } = await db.execute(`SELECT id, data, reports FROM ${t} WHERE hidden = 1`);
    out[t] = rows.map(r => ({ id: r.id, reports: JSON.parse(r.reports).length, ...JSON.parse(r.data) }));
  }
  res.json(out);
}));

async function cleanup() {
  for (const t of KINDS) await db.execute({ sql: `DELETE FROM ${t} WHERE date < ?`, args: [sinceDate()] });
  KINDS.forEach(invalidate);
}

setup().then(async () => {
  await cleanup();
  setInterval(() => cleanup().catch(console.error), 24 * 3600e3).unref();
  app.listen(PORT, () => console.log(`Hamraah running on http://localhost:${PORT}`));
}).catch(e => { console.error('Database setup failed:', e); process.exit(1); });
