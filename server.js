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
  await db.execute(`CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    rideId TEXT NOT NULL,
    token TEXT NOT NULL,
    client TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    cancelReq TEXT,
    seats INTEGER NOT NULL,
    whole INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_bookings_ride ON bookings(rideId)`);
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
    d.wholeFare = optNum(b.wholeFare);
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
  if (req.params.kind === 'rides') {
    await db.execute({ sql: `UPDATE bookings SET status = 'ride_deleted', cancelReq = NULL, updatedAt = ? WHERE rideId = ? AND status IN ('pending','confirmed')`, args: [Date.now(), auth.row.id] });
  }
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


/* ---------- bookings ---------- */
// Seat changes go through one queue so two accepts can't both take the last seat.
let chain = Promise.resolve();
const serial = fn => (chain = chain.then(fn, fn));

const bookLimiter = rateLimit({ windowMs: 3600e3, limit: 10, keyGenerator: req => clientId(req) || 'ip:' + req.ip, handler: (req, res) => fail(res, 429, 'rate') });
const hashClient = c => crypto.createHash('sha256').update(c).digest('hex').slice(0, 16);
const rideStarted = d => new Date(`${d.date}T${d.time || '23:59'}:00+05:00`).getTime() < Date.now();

async function getRide(id) {
  const { rows } = await db.execute({ sql: `SELECT * FROM rides WHERE id = ?`, args: [id] });
  return rows[0] || null;
}
async function saveRideSeats(row, data, status) {
  await db.execute({ sql: `UPDATE rides SET data = ?, status = ? WHERE id = ?`, args: [JSON.stringify(data), status, row.id] });
  invalidate('rides');
}
const pubBooking = (b, ride) => ({
  id: b.id, rideId: b.rideId, status: b.status, cancelReq: b.cancelReq || null, seats: Number(b.seats), whole: !!Number(b.whole),
  name: b.name, phone: b.phone, note: b.note, createdAt: Number(b.createdAt), updatedAt: Number(b.updatedAt),
  ride: ride ? (() => { const d = JSON.parse(ride.data); return { from: d.from, to: d.to, date: ride.date, time: d.time, name: d.name, phone: d.phone, fare: d.fare, wholeFare: d.wholeFare, status: ride.status }; })() : null,
});

// Passenger asks for seats (or the whole car).
app.post('/api/rides/:id/bookings', ipLimiter, bookLimiter, wrap(async (req, res) => {
  const cid = clientId(req); if (!cid) return fail(res, 400, 'generic');
  const b = req.body || {};
  const name = str(b.name, 50), phone = str(b.phone, 20), note = str(b.note, 200);
  if (!name) return fail(res, 400, 'name');
  if (!phoneOk(phone)) return fail(res, 400, 'phone');
  const out = await serial(async () => {
    const ride = await getRide(req.params.id);
    if (!ride || Number(ride.hidden)) return [404, 'notfound'];
    const d = JSON.parse(ride.data);
    if (ride.status !== 'open' || rideStarted({ date: ride.date, time: d.time })) return [400, 'closed'];
    const whole = !!b.whole && !!d.wholeFare;
    const seats = whole ? Number(d.seats) : num(b.seats, 1, 15);
    if (!seats) return [400, 'seats'];
    if (seats > Number(d.seats)) return [400, 'full'];
    const client = hashClient(cid);
    const dup = await db.execute({ sql: `SELECT id FROM bookings WHERE rideId = ? AND client = ? AND status IN ('pending','confirmed')`, args: [ride.id, client] });
    if (dup.rows.length) return [400, 'dup'];
    const id = crypto.randomUUID(), token = crypto.randomBytes(18).toString('hex'), now = Date.now();
    await db.execute({
      sql: `INSERT INTO bookings (id, rideId, token, client, seats, whole, name, phone, note, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      args: [id, ride.id, token, client, seats, whole ? 1 : 0, name, phone, note, now, now],
    });
    return [201, { id, token }];
  });
  if (typeof out[1] === 'string') return fail(res, out[0], out[1]);
  res.status(201).json(out[1]);
}));

// Everything one browser is involved in: bookings on its rides (as driver) and its own bookings (as passenger).
app.post('/api/bookings/mine', wrap(async (req, res) => {
  const rides = Array.isArray(req.body?.rides) ? req.body.rides.slice(0, 50) : [];
  const mine = Array.isArray(req.body?.bookings) ? req.body.bookings.slice(0, 100) : [];
  const driver = {};
  for (const r of rides) {
    const ride = await getRide(String(r.id || ''));
    if (!ride || (r.token !== ride.token && !(ADMIN_KEY && r.token === ADMIN_KEY))) continue;
    const { rows } = await db.execute({ sql: `SELECT * FROM bookings WHERE rideId = ? ORDER BY createdAt`, args: [ride.id] });
    driver[ride.id] = rows.map(b => pubBooking(b, null));
  }
  const passenger = [];
  for (const m of mine) {
    const { rows } = await db.execute({ sql: `SELECT * FROM bookings WHERE id = ?`, args: [String(m.id || '')] });
    const b = rows[0];
    if (!b || b.token !== m.token) continue;
    passenger.push(pubBooking(b, await getRide(b.rideId)));
  }
  res.json({ driver, passenger });
}));

// Accept, decline, withdraw, and the two-sided cancellation.
// Driver uses the ride's edit key; passenger uses the booking's key.
const PASSENGER_ACTIONS = ['withdraw', 'request_cancel', 'approve_cancel', 'reject_cancel', 'undo_cancel'];
const DRIVER_ACTIONS = ['accept', 'decline', 'request_cancel', 'approve_cancel', 'reject_cancel', 'undo_cancel'];
app.post('/api/bookings/:id/action', wrap(async (req, res) => {
  const key = req.get('x-edit-token') || '', action = String(req.body?.action || '');
  const out = await serial(async () => {
    const { rows } = await db.execute({ sql: `SELECT * FROM bookings WHERE id = ?`, args: [req.params.id] });
    const bk = rows[0]; if (!bk) return [404, 'notfound'];
    const ride = await getRide(bk.rideId);
    let role = null;
    if (key && key === bk.token) role = 'passenger';
    else if (ride && key && (key === ride.token || (ADMIN_KEY && key === ADMIN_KEY))) role = 'driver';
    if (!role) return [403, 'forbidden'];
    if (!(role === 'driver' ? DRIVER_ACTIONS : PASSENGER_ACTIONS).includes(action)) return [400, 'state'];
    const other = role === 'driver' ? 'passenger' : 'driver';
    let status = bk.status, cancelReq = bk.cancelReq || null, seatDelta = 0;

    if (action === 'accept') {
      if (status !== 'pending' || !ride) return [400, 'state'];
      const d = JSON.parse(ride.data);
      if (Number(bk.seats) > Number(d.seats)) return [400, 'full'];
      status = 'confirmed'; seatDelta = -Number(bk.seats);
    } else if (action === 'decline') {
      if (status !== 'pending') return [400, 'state'];
      status = 'declined';
    } else if (action === 'withdraw') {
      if (status !== 'pending') return [400, 'state'];
      status = 'withdrawn';
    } else if (action === 'request_cancel') {
      if (status !== 'confirmed' || cancelReq) return [400, 'state'];
      cancelReq = role;
    } else if (action === 'undo_cancel') {
      if (status !== 'confirmed' || cancelReq !== role) return [400, 'state'];
      cancelReq = null;
    } else if (action === 'approve_cancel') {
      // Only the side that did NOT ask can agree, so both have agreed.
      if (status !== 'confirmed' || cancelReq !== other) return [400, 'state'];
      status = 'cancelled'; cancelReq = null; seatDelta = Number(bk.seats);
    } else if (action === 'reject_cancel') {
      if (status !== 'confirmed' || cancelReq !== other) return [400, 'state'];
      cancelReq = null;
    }

    if (seatDelta && ride) {
      const d = JSON.parse(ride.data);
      d.seats = Math.max(0, Number(d.seats) + seatDelta);
      let rs = ride.status;
      if (d.seats === 0) { rs = 'closed'; d.autoFull = true; }
      else if (seatDelta > 0 && d.autoFull) { rs = 'open'; d.autoFull = false; }
      await saveRideSeats(ride, d, rs);
    }
    await db.execute({ sql: `UPDATE bookings SET status = ?, cancelReq = ?, updatedAt = ? WHERE id = ?`, args: [status, cancelReq, Date.now(), bk.id] });
    return [200, { ok: true, status, cancelReq }];
  });
  if (typeof out[1] === 'string') return fail(res, out[0], out[1]);
  res.json(out[1]);
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
  await db.execute({ sql: `DELETE FROM bookings WHERE createdAt < ?`, args: [Date.now() - KEEP_DAYS * 864e5] });
  KINDS.forEach(invalidate);
}

setup().then(async () => {
  await cleanup();
  setInterval(() => cleanup().catch(console.error), 24 * 3600e3).unref();
  app.listen(PORT, () => console.log(`Hamraah running on http://localhost:${PORT}`));
}).catch(e => { console.error('Database setup failed:', e); process.exit(1); });
