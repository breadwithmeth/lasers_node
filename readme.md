# lasers.drawbridge.kz — Simple Web + API for ESP8266 Long‑Polling

A minimal production‑ready Node.js app that:

* Serves a clean web UI to send commands to your WeMos/ESP devices
* Exposes a **long‑poll API** compatible with your firmware (`/api/v1/poll`)
* Tracks devices (last seen, pending requests) in memory
* Supports batch commands and a simple auth token for admin endpoints

> Stack: Node.js (Express), vanilla HTML/CSS/JS. No DB required for a start.

---

## Project layout

```
lasers-app/
  package.json
  server.js
  .env                # optional (PORT, AUTH_TOKEN)
  public/
    index.html
    app.js
    styles.css
```

---

## package.json

```json
{
  "name": "lasers-drawbridge-webapp",
  "version": "0.2.0",
  "private": true,
  "type": "commonjs",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "better-sqlite3": "^11.3.0",
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.19.2"
  }
}
```

---

## .env (optional)

```ini
PORT=8080
DB_PATH=./events.db
# If set, admin endpoints require Authorization: Bearer <AUTH_TOKEN>
AUTH_TOKEN=changeme-super-secret
```

ini
PORT=8080

# If set, admin endpoints require Authorization: Bearer \<AUTH\_TOKEN>

AUTH\_TOKEN=changeme-super-secret

````

---

## server.js
```js
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

  // try memory cache first
  let pending = d.queue.filter(ev => ev.id > cursor);
  if (pending.length) {
    return res.json({ events: pending, cursor: String(d.lastId) });
  }

  // then DB
  const fromDb = qAfter.all(device, cursor, 200).map(r => ({ id: r.id, ts: r.ts, ...JSON.parse(r.payload) }));
  if (fromDb.length) {
    // also warm memory cache (tail only)
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

  // flush all waiters now
  if (d.waiters.size) {
    const payload = { events: added, cursor: String(d.lastId) };
    for (const waiter of Array.from(d.waiters)) {
      try { waiter.json(payload); } catch (_) {}
      d.waiters.delete(waiter);
    }
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
````

---

## public/index.html

```html
<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#0b0b0c" />
  <title>Lasers Control</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <header>
    <h1>Lasers Control</h1>
    <div id="status">—</div>
  </header>

  <main class="grid">
    <section class="card">
      <h2>Устройство</h2>
      <div class="row">
        <label for="device">Device ID</label>
        <input id="device" placeholder="wemos-abc123" />
        <button id="refresh">Обновить список</button>
      </div>
      <div id="devices" class="muted small"></div>
    </section>

    <section class="card">
      <h2>Сцены / DMX</h2>
      <div class="row">
        <label>SCENE N</label>
        <input id="sceneN" type="number" min="1" max="99" value="5" inputmode="numeric" />
        <input id="sceneArgs" placeholder="опц. параметры, напр. 3000 80" />
        <button data-action="scene">Отправить</button>
      </div>
      <div class="row">
        <label>Ширина W</label>
        <input id="wVal" type="number" min="0" max="255" value="180" inputmode="numeric" />
        <button data-action="w">W</button>
        <label>Мин</label>
        <input id="wMin" type="number" min="0" max="255" value="120" inputmode="numeric" />
        <button data-action="wmin">WMIN</button>
        <label>Макс</label>
        <input id="wMax" type="number" min="0" max="255" value="240" inputmode="numeric" />
        <button data-action="wmax">WMAX</button>
      </div>
      <div class="row">
        <button data-action="off">OFF</button>
        <input id="unoRaw" placeholder="RAW к UNO: например 'SCENE 7 500 80'" />
        <button data-action="uno">UNO RAW</button>
      </div>
    </section>

    <section class="card">
      <h2>Звонки</h2>
      <div class="row">
        <input id="phone" placeholder="+7708…" inputmode="tel" />
        <button data-action="call">Позвонить</button>
        <button data-action="hang">Положить</button>
      </div>
    </section>

    <section class="card">
      <h2>SIM808 Питание</h2>
      <div class="row">
        <button data-action="sim_on">SIM ON</button>
        <button data-action="sim_toggle">SIM TOGGLE</button>
        <label>pulse_ms</label>
        <input id="pulse" type="number" min="200" max="5000" value="1800" inputmode="numeric" />
      </div>
    </section>

    <section class="card">
      <h2>Лог отправок</h2>
      <pre id="log" class="log" aria-live="polite"></pre>
    </section>
  </main>

  <footer class="muted small">© lasers.drawbridge.kz</footer>
  <script src="/app.js"></script>
</body>
</html>
```

---

## public/styles.css

```css
:root {
  --bg: #0b0b0c; --card: #121316; --text: #e8e8ea; --muted: #9aa0a6; --accent: #56b;
  --ok: #18a558; --err: #d33; --border: #1f2024; --radius: 16px; --space: 16px;
}

*{box-sizing:border-box}
html{height:100%; -webkit-text-size-adjust:100%}
body{margin:0; height:100%; background:var(--bg); color:var(--text);
  font: clamp(14px, 1.6vw, 16px)/1.45 system-ui, -apple-system, Segoe UI, Roboto, Arial;}
button,input,select{font:inherit}

/* Header */
header{position:sticky; top:0; z-index:10; display:flex; gap:10px; justify-content:space-between; align-items:center;
  padding:12px 16px; border-bottom:1px solid var(--border);
  background:color-mix(in oklab, var(--bg) 92%, black 8%);
  backdrop-filter:saturate(1.2) blur(8px)}
h1{margin:0; font-size:clamp(18px, 2.4vw, 22px)}
#status{color:var(--muted)}

/* Layout */
.grid{display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:16px; padding:16px}
.card{background:var(--card); border:1px solid var(--border); border-radius:var(--radius);
  padding:16px; box-shadow:0 8px 24px rgba(0,0,0,.25)}

/* Form rows */
.row{display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin:10px 0}
label{color:var(--muted)}
input{background:#0e0f12; border:1px solid #2a2b30; color:var(--text); border-radius:12px; padding:10px 12px;
  min-width:0}
input::placeholder{color:#6b7280}

button{background:#10131a; border:1px solid #2a2f3a; color:var(--text); padding:10px 14px; border-radius:12px; cursor:pointer;
  transition:transform .02s ease, border-color .2s, background .2s}
button:hover{border-color:#3b4252}
button:active{transform:scale(.98)}
button.primary{background:linear-gradient(180deg, #152238, #10131a); border-color:#2b3f63}

.muted{color:var(--muted)}
.small{font-size:12px}
.log{background:#0a0b0d; border:1px solid var(--border); border-radius:12px; min-height:180px; padding:10px; overflow:auto}

/* Mobile-first tweaks */
@media (max-width: 720px) {
  .grid{grid-template-columns:1fr; gap:12px; padding:12px}
  .card{padding:14px; border-radius:20px}
  .row{flex-direction:column; align-items:stretch}
  input, button, select { width:100%; min-height:44px; }
  label{font-size:13px}
  header{padding:10px 12px}
}

/* Larger screens */
@media (min-width: 1080px) {
  .grid{grid-template-columns:repeat(2, minmax(380px, 1fr));}
}

/* iOS safe areas */
@supports(padding:max(0px)){
  header{padding-left:max(12px, env(safe-area-inset-left)); padding-right:max(12px, env(safe-area-inset-right));}
  body{padding-bottom:env(safe-area-inset-bottom)}
}
```

---

## public/app.js

```js
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const devicesEl = document.getElementById('devices');
const deviceInput = document.getElementById('device');

// Optional: set your Bearer token here for admin endpoints
const AUTH_TOKEN = '';

function log(line) {
  const ts = new Date().toLocaleTimeString();
  logEl.textContent += `[${ts}] ${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

async function api(path, opts={}){
  const headers = opts.headers || {};
  if (AUTH_TOKEN) headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;
  const res = await fetch(path, { ...opts, headers });
  return res;
}

async function refreshDevices(){
  try{
    const r = await api('/api/v1/devices');
    if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    const rows = j.devices
      .sort((a,b)=>b.lastSeenAt - a.lastSeenAt)
      .map(d=>`<code>${d.id}</code> — lastSeen: ${d.lastSeenAt?new Date(d.lastSeenAt).toLocaleString():'—'} · queue: ${d.queueLen}`)
      .join('<br>');
    devicesEl.innerHTML = rows || '<em>Пока пусто. Устройство появится после первого poll.</em>';
    statusEl.textContent = 'OK';
  } catch(e){
    statusEl.textContent = 'Ошибка устройств';
  }
}

document.getElementById('refresh').addEventListener('click', refreshDevices);

async function sendCmd(event){
  const action = event.target.getAttribute('data-action');
  if (!action) return;
  const dev = deviceInput.value.trim();
  if (!dev) { alert('Укажите Device ID'); return; }

  /** build payload by action **/
  let payload = null;
  if (action === 'off') payload = { cmd: 'OFF' };
  if (action === 'scene') {
    const n = document.getElementById('sceneN').value.trim();
    const a = document.getElementById('sceneArgs').value.trim();
    payload = { cmd: 'SCENE', args: `${n}${a?(' '+a):''}` };
  }
  if (action === 'w')    payload = { cmd: 'W',    val: +document.getElementById('wVal').value };
  if (action === 'wmin') payload = { cmd: 'WMIN', val: +document.getElementById('wMin').value };
  if (action === 'wmax') payload = { cmd: 'WMAX', val: +document.getElementById('wMax').value };
  if (action === 'uno')  payload = { cmd: 'UNO',  raw: document.getElementById('unoRaw').value };
  if (action === 'call') payload = { cmd: 'CALL', num: document.getElementById('phone').value };
  if (action === 'hang') payload = { cmd: 'HANG' };
  if (action === 'sim_on') payload = { cmd: 'SIM_ON' };
  if (action === 'sim_toggle') payload = { cmd: 'SIM_TOGGLE', pulse_ms: +document.getElementById('pulse').value };

  try{
    const r = await api(`/api/v1/cmd?device=${encodeURIComponent(dev)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || r.statusText);
    log(`→ ${dev}: ${JSON.stringify(payload)}`);
  }catch(e){
    log(`× Ошибка: ${e.message}`);
  }
}

document.body.addEventListener('click', sendCmd);
refreshDevices();
```

---

## How to run locally

```bash
mkdir lasers-app && cd lasers-app
# create files as above
npm install
npm start
# App listens on http://localhost:8080
```

## Nginx reverse proxy (snippet)

```nginx
server {
  listen 80;
  server_name lasers.drawbridge.kz;
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

## Command payloads (UI already uses these)

```jsonc
{ "cmd": "OFF" }
{ "cmd": "SCENE", "args": "9 3000" }
{ "cmd": "UNO",   "raw": "SCENE 7 500 80" }
{ "cmd": "W",     "val": 180 }
{ "cmd": "WMIN",  "val": 120 }
{ "cmd": "WMAX",  "val": 240 }
{ "cmd": "CALL",  "num": "+7708…" }
{ "cmd": "HANG" }
{ "cmd": "SIM_ON" }
{ "cmd": "SIM_TOGGLE", "pulse_ms": 1800 }
```

> Готово: фронт находится в `/public`, API — `/api/v1/...`. Формат строго совместим с прошивкой ESP (200 с JSON или 204 при таймауте). При необходимости добавим Redis/SQLite для долговременных очередей и истории событий.
