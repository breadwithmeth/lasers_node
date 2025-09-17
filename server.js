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

// ---- утилиты рассылки ----
function flushToClients(d, device, added) {
  // в память
  d.queue.push(...added);
  if (d.queue.length > d.maxQueue) d.queue = d.queue.slice(-d.maxQueue);
  d.lastId = added[added.length - 1].id;

  // разослать всем висящим лонг-полл клиентам
  if (d.waiters.size && added.length) {
    const payload = { events: added, cursor: String(d.lastId) };
    for (const waiter of Array.from(d.waiters)) {
      try { waiter.json(payload); } catch (_) {}
      d.waiters.delete(waiter);
    }
  }
}

function insertOne(device, row) {
  const d = getDevice(device);
  const ts = new Date().toISOString();
  const info = qIns.run(device, ts, JSON.stringify(row));
  const ev = { id: info.lastInsertRowid, ts, ...row };
  flushToClients(d, device, [ev]);
  return ev;
}

// ---- OFF-макрос: SCENE 1 -> (20s) 1 0 -> (20s) 40 0 -> (20s) 50 0 -> (20s) OFF ----
const offMacroTimers = new Map(); // device -> Timeout[]

function cancelOffMacro(device) {
  const arr = offMacroTimers.get(device);
  if (arr) { arr.forEach(clearTimeout); offMacroTimers.delete(device); }
}

function startOffMacro(device) {
  cancelOffMacro(device); // перезапуск, если уже шёл

  const timers = [];
  // шаги: t=0, +20с, +40с, +60с, +80с
  const steps = [
    { delay: 0,      row: { cmd: 'SCENE 1', val: 1 } }, // сразу
    { delay: 20000,  row: { cmd: 'RAW',   raw: '1 0' } },
    { delay: 40000,  row: { cmd: 'RAW',   raw: '40 0' } },
    { delay: 60000,  row: { cmd: 'RAW',   raw: '50 0' } },
    { delay: 80000,  row: { cmd: 'OFF' } },           // финальный OFF
  ];

  for (const s of steps) {
    timers.push(setTimeout(() => insertOne(device, s.row), s.delay));
  }
  offMacroTimers.set(device, timers);

  return {
    device,
    startedAt: new Date().toISOString(),
    scheduleSec: steps.map(s => s.delay / 1000)
  };
}

// --- Long-poll API ---
// GET /api/v1/poll?device=ID&cursor=123&wait=25
// Response 200: { events:[...], cursor:"<lastId>" }  OR 204 if no events within wait seconds
app.get('/api/v1/poll', (req, res) => {
  const device = String(req.query.device || '').trim();
  if (!device) return res.status(400).json({ ok: false, error: 'device required' });
  const wait = Math.max(5, Math.min(60, parseInt(req.query.wait || '25', 10)));
  const cursorRaw = String(req.query.cursor || '').trim();
  const cursor = cursorRaw ? parseInt(cursorRaw, 10) : 0;

  const d = getDevice(device);
  d.lastSeenAt = nowMs();

  // try memory cache first (если нужно — раскомментируй)
  // const pending = d.queue.filter(ev => ev.id > cursor);
  // if (pending.length) {
  //   return res.json({ events: pending, cursor: String(d.lastId) });
  // }

  // DB
  const fromDb = qAfter.all(device, cursor, 200).map(r => ({ id: r.id, ts: r.ts, ...JSON.parse(r.payload) }));
  if (fromDb.length) {
    // warm memory cache (tail)
    d.queue.push(...fromDb);
    if (d.queue.length > d.maxQueue) d.queue = d.queue.slice(-d.maxQueue);
    d.lastId = fromDb[fromDb.length - 1].id;
    return res.json({ events: fromDb, cursor: String(d.lastId) });
  }

  // nothing yet — hold the request (long-poll)
  let finished = false;
  const timer = setTimeout(() => {
    finished = true;
    d.waiters.delete(res);
    res.status(204).end();
  }, wait * 1000);

  req.on('close', () => {
    if (!finished) {
      clearTimeout(timer);
      d.waiters.delete(res);
    }
  });

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

  // нормализуем и перехватываем OFF как макрос
  let macroTriggered = false;
  const normalized = [];
  for (const ev of incoming) {
    const cmd = String(ev.cmd || '').toUpperCase();
    const row = {
      cmd,
      args: ev.args ?? undefined,
      val:  ev.val  ?? undefined,
      num:  ev.num  ?? undefined,
      raw:  ev.raw  ?? undefined
    };

    if (cmd === 'OFF') {
      // Запускаем макрос: SCENE 1 -> 1 0 -> 40 0 -> 50 0 -> OFF
      macroTriggered = true;
      startOffMacro(device);
      // сам OFF НЕ пишем в БД сейчас — макрос разошлёт все шаги сам
      continue;
    }

    // Любая другая реальная команда прерывает текущий OFF-макрос
    if (cmd !== 'GET') cancelOffMacro(device);
    normalized.push(row);
  }

  // Записываем оставшиеся команды одной пачкой на один таймстемп
  const nowIso = new Date().toISOString();
  const added = normalized.map(row => {
    const info = qIns.run(device, nowIso, JSON.stringify(row));
    return { id: info.lastInsertRowid, ts: nowIso, ...row };
  });

  if (added.length) {
    flushToClients(d, device, added);
  }

  res.json({ ok: true, added, macro: macroTriggered ? 'OFF_SEQUENCE' : undefined });
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
const server = app.listen(PORT, () => {
  console.log(`lasers app running on :${PORT} (DB: ${DB_PATH})`);
});

// Рекомендуется для стабильного long-poll за прокси
server.keepAliveTimeout = 65000;
server.headersTimeout   = 70000;
