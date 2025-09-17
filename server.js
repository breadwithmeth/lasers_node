require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '256kb' }));
app.use(cors());

// --- SQLite ---
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'events.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device TEXT NOT NULL,
  ts     TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_device_id ON events(device, id);
`);
const qIns   = db.prepare('INSERT INTO events (device, ts, payload) VALUES (?,?,?)');
const qAfter = db.prepare('SELECT id, ts, payload FROM events WHERE device=? AND id>? ORDER BY id LIMIT ?');
const qLast  = db.prepare('SELECT COALESCE(MAX(id),0) AS lastId FROM events WHERE device=?');
const qRecentDevices = db.prepare('SELECT device, MAX(id) AS lastId, MAX(ts) AS lastTs, COUNT(*) AS cnt FROM events GROUP BY device ORDER BY lastTs DESC LIMIT ?');
// после остальных prepare:
const qLastRow = db.prepare('SELECT id, ts, payload FROM events WHERE device=? ORDER BY id DESC LIMIT 1');
// ДОБАВЬ рядом с остальными prepare:
const qAfterAct = db.prepare(`
  SELECT id, ts, payload FROM events
  WHERE device=? AND id>? AND json_extract(payload,'$.cmd')!='GET'
  ORDER BY id LIMIT ?
`);
const qLastAct = db.prepare(`
  SELECT id, ts, payload FROM events
  WHERE device=? AND json_extract(payload,'$.cmd')!='GET'
  ORDER BY id DESC LIMIT 1
`);

function lastActionablePayload(device) {
  const anyLast = qLast.get(device).lastId;                // общий последний id (включая GET)
  const r = qLastAct.get(device);                          // последний НЕ-GET
  if (!r) return { events: [], cursor: String(anyLast) };
  const ev = { id: r.id, ts: r.ts, ...JSON.parse(r.payload) };
  return { events: [ev], cursor: String(anyLast) };
}

function lastEventPayload(device) {
  const r = qLastRow.get(device);
  if (!r) return { events: [], cursor: '0' };
  const ev = { id: r.id, ts: r.ts, ...JSON.parse(r.payload) };
  return { events: [ev], cursor: String(r.id) };
}

// --- In-memory runtime state (waiters & cache) ---
// deviceId -> { queue: [], lastId: number, lastSeenAt: number(ms), waiters: Set<res>, maxQueue: 500 }
const devices = new Map();
function nowMs() { return Date.now(); }
function getDevice(id) {
  if (!devices.has(id)) {
    const lastId = qLast.get(id).lastId;
    devices.set(id, { queue: [], lastId, lastSeenAt: 0, waiters: new Set(), maxQueue: 500 });
  }
  return devices.get(id);
}

function authAdmin(req, res, next) {
  const need = process.env.AUTH_TOKEN;
  if (!need) return next();
  const hdr = req.get('Authorization') || '';
  const ok = hdr === `Bearer ${need}`;
  if (!ok) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}


function pendingFromQueue(d, cursor) {
  if (!d.queue.length) return [];
  // бинарный поиск по id
  let lo = 0, hi = d.queue.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; (d.queue[mid].id <= cursor) ? lo = mid + 1 : hi = mid; }
  // ⚠️ убираем GET
  return d.queue.slice(lo).filter(ev => ev.cmd !== 'GET');
}



// ---- helpers: единообразный пуш в память + оповещение waiters (+SSE если есть) ----
function flushToClients(deviceState, deviceId, added) {
  // память
  deviceState.queue.push(...added);
  if (deviceState.queue.length > deviceState.maxQueue) {
    deviceState.queue = deviceState.queue.slice(-deviceState.maxQueue);
  }
  deviceState.lastId = added[added.length - 1].id;

  // HTTP long-poll waiters
  if (deviceState.waiters.size && added.length) {
    const payload = { events: added, cursor: String(deviceState.lastId) };
    for (const waiter of Array.from(deviceState.waiters)) {
      try { waiter.json(payload); } catch {}
      deviceState.waiters.delete(waiter);
    }
  }

  // SSE (если добавлял раньше — будет работать; если нет, можно не трогать)
  if (deviceState.sse?.size && added.length) {
    const line = `event: push\ndata:${JSON.stringify({ events: added, cursor: String(deviceState.lastId) })}\n\n`;
    for (const client of Array.from(deviceState.sse)) {
      try { client.write(line); } catch { deviceState.sse.delete(client); }
    }
  }
}

// ---- OFF2 macro scheduler ----
const macroJobs = new Map(); // device -> { interval, stopTimer, idx, startedAt, stepMs, durationMs }

function stopOff2(device) {
  const job = macroJobs.get(device);
  if (!job) return;
  clearInterval(job.interval);
  clearTimeout(job.stopTimer);
  macroJobs.delete(device);
}

function startOff2(device, durationMs = 30000, stepMs = 3000) {
  stopOff2(device); // если уже шёл — перезапустим

  const d = getDevice(device);
  const pattern = [
    { cmd: 'RAW', raw: '1 0'  },
    { cmd: 'RAW', raw: '50 0' },
    { cmd: 'RAW', raw: '40 0' },
  ];
  let idx = 0;
  const startedAt = Date.now();

  const tick = () => {
    const nowIso = new Date().toISOString();
    const row = pattern[idx];
    idx = (idx + 1) % pattern.length;

    // вставляем одну команду
    const info = qIns.run(device, nowIso, JSON.stringify(row));
    const added = [{ id: info.lastInsertRowid, ts: nowIso, ...row }];

    // отдать сразу всем слушателям
    flushToClients(d, device, added);
  };

  // первый выстрел немедленно
  tick();

  // дальше по расписанию
  const interval = setInterval(() => {
    if (Date.now() - startedAt >= durationMs) return; // перестраховка, основная остановка ниже
    tick();
  }, stepMs);

  const stopTimer = setTimeout(() => {
    stopOff2(device);
  }, durationMs);

  macroJobs.set(device, { interval, stopTimer, idx, startedAt, stepMs, durationMs });

  return {
    startedAt: new Date(startedAt).toISOString(),
    durationSec: Math.round(durationMs / 1000),
    stepSec: Math.round(stepMs / 1000),
  };
}



// POST /api/v1/macro/off2?device=ID&duration=30&step=3
app.post('/api/v1/macro/off2', authAdmin, (req, res) => {
  const device = String(req.query.device || '').trim();
  if (!device) return res.status(400).json({ ok: false, error: 'device required' });

  const durationSec = Number(req.query.duration ?? req.body?.duration ?? 30);
  const stepSec     = Number(req.query.step     ?? req.body?.step     ?? 3);

  const durationMs = Math.max(3, Math.min(600, durationSec)) * 1000; // 3..600 c
  const stepMs     = Math.max(1, Math.min(60,  stepSec))     * 1000; // 1..60  c

  const info = startOff2(device, durationMs, stepMs);
  return res.json({ ok: true, macro: 'OFF2', device, ...info });
});

// DELETE /api/v1/macro/off2?device=ID
app.delete('/api/v1/macro/off2', authAdmin, (req, res) => {
  const device = String(req.query.device || '').trim();
  if (!device) return res.status(400).json({ ok: false, error: 'device required' });
  stopOff2(device);
  res.json({ ok: true, stopped: true, macro: 'OFF2', device });
});


// --- Long-poll API ---
// GET /api/v1/poll?device=ID&cursor=123&wait=25
// Response 200: { events:[...], cursor:"<lastId>" }  OR 204 if no events within wait seconds
app.get('/api/v1/poll', (req, res) => {
  const device = String(req.query.device || '').trim();
  if (!device) return res.status(400).json({ ok:false, error:'device required' });
  const wait = Math.max(5, Math.min(60, parseInt(req.query.wait || '25', 10)));
  const cursor = parseInt(String(req.query.cursor || '0'), 10) || 0;

  const d = getDevice(device);
  d.lastSeenAt = nowMs();

  // 1) быстрый путь из памяти (без GET)
  const mem = pendingFromQueue(d, cursor);
  if (mem.length) {
    // cursor возвращаем как общий последний id (даже если это был GET)
    const anyLast = qLast.get(device).lastId;
    return res.json({ events: mem, cursor: String(anyLast) });
  }

  // 2) БД (без GET)
  const fromDb = qAfterAct.all(device, cursor, 200).map(r => ({ id:r.id, ts:r.ts, ...JSON.parse(r.payload) }));
  if (fromDb.length) {
    d.queue.push(...fromDb);
    if (d.queue.length > d.maxQueue) d.queue = d.queue.slice(-d.maxQueue);
    // d.lastId оставь как есть — он обновляется при вставках /cmd
    const anyLast = qLast.get(device).lastId;
    return res.json({ events: fromDb, cursor: String(anyLast) });
  }

  // 3) Таймаут: вернуть последнюю НЕ-GET
  let finished = false;
  const timer = setTimeout(() => {
    finished = true; d.waiters.delete(res);
    const payload = lastActionablePayload(device);
    res.json(payload); // никогда не 204
  }, wait * 1000);

  req.on('close', () => { if (!finished) { clearTimeout(timer); d.waiters.delete(res); } });
  d.waiters.add(res);
});


// Push events (admin) — POST /api/v1/cmd?device=ID
// Body: single event {cmd,...} OR {events:[...]}
app.post('/api/v1/cmd', authAdmin, (req, res) => {
  const device = String(req.query.device || '').trim();
  if (!device) return res.status(400).json({ ok: false, error: 'device required' });
  const d = getDevice(device);

  const body = req.body || {};
  let incoming = [];
  if (Array.isArray(body)) incoming = body;
  else if (Array.isArray(body.events)) incoming = body.events;
  else if (body && typeof body === 'object') incoming = [body];
  if (!incoming.length) return res.status(400).json({ ok: false, error: 'no events' });

  const nowIso = new Date().toISOString();
  const added = incoming.map(ev => {
    const row = {
      cmd: String(ev.cmd || '').toUpperCase(),
      args: ev.args ?? undefined,
      val: ev.val ?? undefined,
      num: ev.num ?? undefined,
      raw: ev.raw ?? undefined
    };
    const info = qIns.run(device, nowIso, JSON.stringify(row));
    return { id: info.lastInsertRowid, ts: nowIso, ...row };
  });

  // memory tail cache
  d.queue.push(...added);
if (d.queue.length > d.maxQueue) d.queue = d.queue.slice(-d.maxQueue);
d.lastId = added[added.length - 1].id;

// отдать только actionable
const actionable = added.filter(ev => ev.cmd !== 'GET');

// flush http waiters
if (d.waiters.size && actionable.length) {
  const payload = { events: actionable, cursor: String(qLast.get(device).lastId) };
  for (const waiter of Array.from(d.waiters)) { try { waiter.json(payload); } catch {} d.waiters.delete(waiter); }
}

  res.json({ ok: true, added });
});

// Simple device list (from DB + runtime lastSeen)
app.get('/api/v1/devices', authAdmin, (_req, res) => {
  const rows = qRecentDevices.all(200);
  const list = rows.map(r => ({
    id: r.device,
    lastSeenAt: devices.get(r.device)?.lastSeenAt || 0,
    queueLen: devices.get(r.device)?.queue.length || 0,
    lastId: r.lastId,
    lastEventAt: r.lastTs
  }));
  res.json({ devices: list });
});

// Recent events for a device (DB)
app.get('/api/v1/events', authAdmin, (req, res) => {
  const device = String(req.query.device || '').trim();
  if (!device) return res.status(400).json({ ok: false, error: 'device required' });
  const cursor = parseInt(String(req.query.cursor || '0'), 10) || 0;
  const limit = Math.max(1, Math.min(500, parseInt(String(req.query.limit || '100'), 10)));
  const rows = qAfter.all(device, cursor, limit).map(r => ({ id: r.id, ts: r.ts, ...JSON.parse(r.payload) }));
  const lastId = rows.length ? rows[rows.length - 1].id : qLast.get(device).lastId;
  res.json({ events: rows, cursor: String(lastId) });
});

// Serve the frontend
app.use('/', express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`lasers app running on :${PORT} (DB: ${DB_PATH})`);
});