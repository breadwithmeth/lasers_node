require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const AuthUtils = require('./utils/auth');
const UserService = require('./services/UserService');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '256kb' }));
app.use(cors());

// ================== REQUEST LOGGING ==================
// Включается переменной окружения LOG_REQUESTS=true
// Формат: ISO | ip | method path -> status code (ms) sizeB user=<id|-> extra
// Маскирует чувствительные поля (password, currentPassword, newPassword)
const LOG_REQUESTS = /^true$/i.test(process.env.LOG_REQUESTS || '');
if (LOG_REQUESTS) {
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    const { method } = req;
    const url = req.originalUrl || req.url;
    const ip = req.ip || req.connection?.remoteAddress || '-';
    // Снимок тела (только для JSON и небольшого размера)
    let bodyPreview = null;
    if (req.is('application/json') && req.body && typeof req.body === 'object') {
      const clone = { ...req.body };
      for (const k of ['password','currentPassword','newPassword']) {
        if (k in clone) clone[k] = '***';
      }
      // не логируем длинные payload > 2KB
      const str = JSON.stringify(clone);
      if (str.length < 2048) bodyPreview = str; else bodyPreview = `{"_truncated":${str.length}}`;
    }
    const referer = req.get('referer') || '';
    const ua = req.get('user-agent') || '';
    const chunks = [];
    const origWrite = res.write;
    const origEnd = res.end;
    let bytes = 0;
    res.write = function(chunk, encoding, cb) {
      if (chunk) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding || 'utf8');
        bytes += b.length;
      }
      return origWrite.call(this, chunk, encoding, cb);
    };
    res.end = function(chunk, encoding, cb) {
      if (chunk) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding || 'utf8');
        bytes += b.length;
      }
      return origEnd.call(this, chunk, encoding, cb);
    };
    res.on('finish', () => {
      const ns = process.hrtime.bigint() - started;
      const ms = (Number(ns) / 1e6).toFixed(1);
      const status = res.statusCode;
      const userId = (req.user && req.user.id) ? req.user.id : '-';
      const sched = url.includes('/device-schedules') ? 'sched' : '';
      const device = req.query?.device || req.params?.id || '';
      const extra = [device && `device=${device}`, bodyPreview && `body=${bodyPreview}`, sched, referer && `ref=${referer}`, ua && `ua=${ua}`]
        .filter(Boolean)
        .join(' ');
      console.log(`${new Date().toISOString()} | ${ip} | ${method} ${url} -> ${status} (${ms}ms ${bytes}B) user=${userId}${extra?(' '+extra):''}`);
    });
    next();
  });
  console.log('[request-log] enabled');
}
// ======================================================

// --- Prisma ---
const prisma = new PrismaClient();
const userService = new UserService(prisma);

// --- In-memory runtime state (waiters & cache) ---
// deviceId -> { queue: [], lastId: number, lastSeenAt: number(ms), waiters: Set<res>, maxQueue: 500 }
const devices = new Map();
function nowMs() { return Date.now(); }
async function getDevice(id) {
  if (!devices.has(id)) {
    // Создаём/обновляем запись устройства (upsert: если нет — создаём)
    const deviceRow = await prisma.device.upsert({
      where: { id },
      update: { lastSeenAt: new Date() },
      create: { id }
    });

    const lastEvent = await prisma.event.findFirst({
      where: { device: id },
      orderBy: { id: 'desc' },
      select: { id: true }
    });
    const lastId = lastEvent?.id || 0;
    devices.set(id, { queue: [], lastId, lastSeenAt: deviceRow.lastSeenAt.getTime(), waiters: new Set(), maxQueue: 500 });
  }
  return devices.get(id);
}

// Legacy auth (для обратной совместимости)
function authAdmin(req, res, next) {
  const need = process.env.AUTH_TOKEN;
  if (!need) return authJWT(req, res, next); // Переходим на JWT если токен не настроен
  const hdr = req.get('Authorization') || '';
  const ok = hdr === `Bearer ${need}`;
  if (!ok) return authJWT(req, res, next); // Пробуем JWT если legacy токен не подошел
  next();
}

// JWT аутентификация
async function authJWT(req, res, next) {
  try {
    const authHeader = req.get('Authorization') || '';
    
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ ok: false, error: 'Требуется токен авторизации' });
    }
    
    const token = authHeader.slice(7);
    const decoded = AuthUtils.verifyToken(token);
    
    if (!decoded) {
      return res.status(401).json({ ok: false, error: 'Недействительный токен' });
    }
    
    const user = await userService.getUserById(decoded.userId);
    
    if (!user || !user.isActive) {
      return res.status(401).json({ ok: false, error: 'Пользователь не найден или неактивен' });
    }
    
    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ ok: false, error: 'Ошибка авторизации' });
  }
}

// Проверка роли (для будущего расширения)
function requireRole(roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ ok: false, error: 'Требуется авторизация' });
    }
    
    if (Array.isArray(roles) ? !roles.includes(req.user.role) : req.user.role !== roles) {
      return res.status(403).json({ ok: false, error: 'Недостаточно прав доступа' });
    }
    
    next();
  };
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

async function insertOne(device, row) {
  const d = await getDevice(device);
  const ts = new Date().toISOString();
  const event = await prisma.event.create({
    data: {
      device,
      ts,
      payload: JSON.stringify(row)
    }
  });
  const ev = { id: event.id, ts, ...row };
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
    timers.push(setTimeout(async () => await insertOne(device, s.row), s.delay));
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
app.get('/api/v1/poll', async (req, res) => {
  const device = String(req.query.device || '').trim();
  if (!device) return res.status(400).json({ ok: false, error: 'device required' });

  const wait = Math.max(5, Math.min(60, parseInt(req.query.wait || '25', 10)));
  const cursorRaw = String(req.query.cursor || '').trim();
  const cursor = cursorRaw ? parseInt(cursorRaw, 10) : 0;

  const d = await getDevice(device);
  d.lastSeenAt = nowMs();
  // Обновляем lastSeenAt в БД асинхронно (не блокируем ответ)
  prisma.device.update({
    where: { id: device },
    data: { lastSeenAt: new Date() }
  }).catch(() => {});

  // --- если решите снова использовать память, сразу берём последнюю ---
  // const pending = d.queue.filter(ev => ev.id > cursor);
  // if (pending.length) {
  //   const lastEv = pending[pending.length - 1];
  //   d.lastId = lastEv.id;
  //   return res.json({ events: [lastEv], cursor: String(d.lastId) });
  // }

  // --- DB: берём только последний event c id > cursor ---
  const lastRow = await prisma.event.findFirst({
    where: {
      device
    },
    orderBy: { id: 'desc' }
  });

  if (lastRow) {
    const payload = JSON.parse(lastRow.payload);
    // Преобразуем SCENE val -> args если нужно под формат примера
    if (payload && payload.cmd === 'SCENE' && payload.val != null && payload.args === undefined) {
      payload.args = String(payload.val);
      delete payload.val; // чтобы не дублировать
    }
    const lastEv = { id: lastRow.id, ts: lastRow.ts, ...payload };
    d.queue.push(lastEv);
    if (d.queue.length > d.maxQueue) d.queue = d.queue.slice(-d.maxQueue);
    d.lastId = lastEv.id;
    return res.json({ events: [lastEv], cursor: String(d.lastId) });
  }

  // --- ничего нет — держим соединение (long-poll) ---
  let finished = false;
  const timer = setTimeout(() => {
    finished = true;
    d.waiters.delete(res);
    res.json({ events: [], cursor: String(cursor) });
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
app.post('/api/v1/cmd', authAdmin, async (req, res) => {
  const device = String(req.query.device || '').trim();
  if (!device) return res.status(400).json({ ok: false, error: 'device required' });
  const d = await getDevice(device);

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
  const added = [];
  
  for (const row of normalized) {
    const event = await prisma.event.create({
      data: {
        device,
        ts: nowIso,
        payload: JSON.stringify(row)
      }
    });
    added.push({ id: event.id, ts: nowIso, ...row });
  }

  if (added.length) {
    flushToClients(d, device, added);
  }

  res.json({ ok: true, added, macro: macroTriggered ? 'OFF_SEQUENCE' : undefined });
});

// === Convenience command endpoints ===
// OFF macro trigger
app.post('/api/v1/device/:id/off', authAdmin, async (req, res) => {
  const device = req.params.id.trim();
  if (!device) return res.status(400).json({ ok: false, error: 'device required' });
  // Запускаем макрос (он сам создаст последовательность событий)
  const macro = startOffMacro(device);
  return res.json({ ok: true, macro });
});

// SCENE 1 или SCENE 2 (ограниченно по задаче)
app.post('/api/v1/device/:id/scene/:n', authAdmin, async (req, res) => {
  const device = req.params.id.trim();
  const n = parseInt(req.params.n, 10);
  if (!device) return res.status(400).json({ ok: false, error: 'device required' });
  if (![1, 2].includes(n)) return res.status(400).json({ ok: false, error: 'only SCENE 1 or 2 allowed' });
  // Любая явная команда отменяет OFF-макрос
  cancelOffMacro(device);
  try {
    const ev = await insertOne(device, { cmd: 'SCENE', val: n });
    return res.json({ ok: true, event: ev });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Custom single command (унифицированный, аналог одного элемента POST /api/v1/cmd)
app.post('/api/v1/device/:id/custom', authAdmin, async (req, res) => {
  const device = req.params.id.trim();
  if (!device) return res.status(400).json({ ok: false, error: 'device required' });
  const body = req.body || {};
  if (!body.cmd) return res.status(400).json({ ok: false, error: 'cmd required' });
  const cmd = String(body.cmd).toUpperCase();
  if (cmd === 'OFF') {
    // перенаправляем на макрос, чтобы поведение было идентичным
    const macro = startOffMacro(device);
    return res.json({ ok: true, macro });
  }
  // Отмена OFF если что-то иное
  cancelOffMacro(device);
  const row = {
    cmd,
    args: body.args ?? undefined,
    val: body.val ?? undefined,
    num: body.num ?? undefined,
    raw: body.raw ?? undefined
  };
  try {
    const ev = await insertOne(device, row);
    return res.json({ ok: true, event: ev });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Simple device list (from DB + runtime lastSeen)
app.get('/api/v1/devices', authAdmin, async (_req, res) => {
  // Берём данные об устройствах
  const deviceRows = await prisma.device.findMany({
    orderBy: { lastSeenAt: 'desc' },
    take: 500
  });

  // Агрегируем события (максимальный id и ts) для устройств
  const eventAgg = await prisma.event.groupBy({
    by: ['device'],
    _max: { id: true, ts: true }
  });
  const aggMap = new Map(eventAgg.map(a => [a.device, a]));

  // Загружаем enabled расписания для подсчёта признаков
  const schedRules = await prisma.deviceSchedule.findMany({ where: { enabled: true }, orderBy: { priority: 'desc' } });
  const nowM = (() => { const d=new Date(); return d.getHours()*60 + d.getMinutes(); })();
  function matchInWindow(mins, start, end){ return end <= start ? (mins >= start || mins < end) : (mins >= start && mins < end); }

  const list = deviceRows.map(dv => {
    const agg = aggMap.get(dv.id);
    const runtime = devices.get(dv.id);
    const rulesFor = schedRules.filter(r => !r.deviceId || r.deviceId === dv.id);
    const hasSchedule = rulesFor.length > 0;
    const scheduleActive = hasSchedule && rulesFor.some(r => matchInWindow(nowM, r.windowStart, r.windowEnd));
    return {
      id: dv.id,
      lat: dv.lat,
      lon: dv.lon,
      lastSeenAt: dv.lastSeenAt.getTime(),
      lastId: agg?._max.id || 0,
      lastEventAt: agg?._max.ts || null,
      queueLen: runtime?.queue.length || 0,
      scheduleHas: hasSchedule,
      scheduleActive
    };
  });

  res.json({ devices: list });
});

// Recent events for a device (DB)
app.get('/api/v1/events', authAdmin, async (req, res) => {
  const device = String(req.query.device || '').trim();
  if (!device) return res.status(400).json({ ok: false, error: 'device required' });
  const cursor = parseInt(String(req.query.cursor || '0'), 10) || 0;
  const limit = Math.max(1, Math.min(500, parseInt(String(req.query.limit || '100'), 10)));
  
  const events = await prisma.event.findMany({
    where: {
      device,
      id: { gt: cursor }
    },
    orderBy: { id: 'asc' },
    take: limit
  });
  
  const rows = events.map(r => ({ 
    id: r.id, 
    ts: r.ts, 
    ...JSON.parse(r.payload) 
  }));
  
  const lastEvent = await prisma.event.findFirst({
    where: { device },
    orderBy: { id: 'desc' },
    select: { id: true }
  });
  
  const lastId = rows.length ? rows[rows.length - 1].id : (lastEvent?.id || 0);
  res.json({ events: rows, cursor: String(lastId) });
});

// === USER MANAGEMENT API ===
// === DEVICE MANAGEMENT API ===

// Получить одно устройство
app.get('/api/v1/device/:id', authAdmin, async (req, res) => {
  const id = req.params.id;
  const dev = await prisma.device.findUnique({ where: { id } });
  if (!dev) return res.status(404).json({ ok: false, error: 'device not found' });
  const agg = await prisma.event.findFirst({ where: { device: id }, orderBy: { id: 'desc' }, select: { id: true, ts: true } });
  const schedRules = await prisma.deviceSchedule.findMany({ where: { enabled: true, OR: [ { deviceId: id }, { deviceId: null } ] }, orderBy: { priority: 'desc' } });
  const nowM = (() => { const d=new Date(); return d.getHours()*60 + d.getMinutes(); })();
  function matchInWindow(mins, start, end){ return end <= start ? (mins >= start || mins < end) : (mins >= start && mins < end); }
  const hasSchedule = schedRules.length>0;
  const scheduleActive = hasSchedule && schedRules.some(r => matchInWindow(nowM, r.windowStart, r.windowEnd));
  res.json({
    ok: true,
    device: {
      id: dev.id,
      lat: dev.lat,
      lon: dev.lon,
      lastSeenAt: dev.lastSeenAt.getTime(),
      lastId: agg?.id || 0,
      lastEventAt: agg?.ts || null,
      scheduleHas: hasSchedule,
      scheduleActive
    }
  });
});

// Обновить координаты устройства (partial)
app.put('/api/v1/device/:id', authAdmin, async (req, res) => {
  const id = req.params.id;
  const { lat, lon } = req.body || {};
  try {
    const dev = await prisma.device.upsert({
      where: { id },
      update: { lat, lon },
      create: { id, lat, lon }
    });
    res.json({ ok: true, device: dev });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Список устройств с координатами (пагинация упрощённо)
app.get('/api/v1/device', authAdmin, async (req, res) => {
  const list = await prisma.device.findMany({ orderBy: { lastSeenAt: 'desc' }, take: 500 });
  res.json({ ok: true, devices: list });
});

// Упрощённый список устройств только с координатами (для карт / геоинтерфейсов)
app.get('/api/v1/devices/coords', authAdmin, async (_req, res) => {
  const devicesRows = await prisma.device.findMany({
    orderBy: { lastSeenAt: 'desc' },
    take: 1000,
    select: { id: true, lat: true, lon: true, lastSeenAt: true }
  });
  const schedRules = await prisma.deviceSchedule.findMany({ where: { enabled: true }, orderBy: { priority: 'desc' } });
  const nowM = (() => { const d=new Date(); return d.getHours()*60 + d.getMinutes(); })();
  function matchInWindow(mins, start, end){ return end <= start ? (mins >= start || mins < end) : (mins >= start && mins < end); }
  const mapped = devicesRows.map(d => {
    const rulesFor = schedRules.filter(r => !r.deviceId || r.deviceId === d.id);
    const hasSchedule = rulesFor.length>0;
    const scheduleActive = hasSchedule && rulesFor.some(r => matchInWindow(nowM, r.windowStart, r.windowEnd));
    return {
      id: d.id,
      lat: d.lat,
      lon: d.lon,
      lastSeenAt: d.lastSeenAt.getTime(),
      scheduleHas: hasSchedule,
      scheduleActive
    };
  });
  res.json({ devices: mapped });
});

// Аутентификация пользователя
app.post('/api/v1/auth/login', async (req, res) => {
  try {
    const { login, password } = req.body;
    
    if (!login || !password) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Требуется логин и пароль' 
      });
    }
    
    const user = await userService.authenticateUser(login, password);
    const token = AuthUtils.generateToken(user);
    
    res.json({
      ok: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    res.status(401).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

// Получение информации о текущем пользователе
app.get('/api/v1/auth/me', authJWT, (req, res) => {
  res.json({
    ok: true,
    user: {
      id: req.user.id,
      username: req.user.username,
      email: req.user.email,
      role: req.user.role,
      lastLoginAt: req.user.lastLoginAt
    }
  });
});

// Создание нового пользователя
app.post('/api/v1/users', authJWT, async (req, res) => {
  try {
    const { username, email, password, role } = req.body;
    
    if (!username || !email || !password) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Требуются поля: username, email, password' 
      });
    }
    
    const user = await userService.createUser(
      { username, email, password, role },
      req.user.id
    );
    
    res.status(201).json({
      ok: true,
      user
    });
  } catch (error) {
    res.status(400).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

// Получение списка пользователей
app.get('/api/v1/users', authJWT, async (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === 'true';
    const users = await userService.getAllUsers(includeInactive);
    
    res.json({
      ok: true,
      users
    });
  } catch (error) {
    res.status(500).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

// Получение информации о пользователе
app.get('/api/v1/users/:id', authJWT, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const user = await userService.getUserById(userId);
    
    if (!user) {
      return res.status(404).json({ 
        ok: false, 
        error: 'Пользователь не найден' 
      });
    }
    
    res.json({
      ok: true,
      user
    });
  } catch (error) {
    res.status(500).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

// Обновление пользователя
app.put('/api/v1/users/:id', authJWT, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const updateData = req.body;
    
    const user = await userService.updateUser(userId, updateData, req.user.id);
    
    res.json({
      ok: true,
      user
    });
  } catch (error) {
    res.status(400).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

// Смена пароля
app.post('/api/v1/users/:id/change-password', authJWT, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { currentPassword, newPassword } = req.body;
    
    // Пользователь может менять только свой пароль (или superadmin любой)
    if (req.user.id !== userId && req.user.role !== 'superadmin') {
      return res.status(403).json({ 
        ok: false, 
        error: 'Недостаточно прав для смены пароля' 
      });
    }
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Требуются поля: currentPassword, newPassword' 
      });
    }
    
    await userService.changePassword(userId, currentPassword, newPassword);
    
    res.json({
      ok: true,
      message: 'Пароль успешно изменен'
    });
  } catch (error) {
    res.status(400).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

// Деактивация пользователя
app.delete('/api/v1/users/:id', authJWT, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    
    // Нельзя удалить самого себя
    if (req.user.id === userId) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Нельзя удалить самого себя' 
      });
    }
    
    const user = await userService.deleteUser(userId);
    
    res.json({
      ok: true,
      message: 'Пользователь деактивирован',
      user
    });
  } catch (error) {
    res.status(400).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

// Serve the frontend
app.use('/', express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ================== DEVICE SCHEDULE API ==================
// Роли: только superadmin для модификации
function requireSuperadmin(req, res, next) {
  if (!req.user || req.user.role !== 'superadmin') return res.status(403).json({ ok: false, error: 'forbidden' });
  next();
}

// List schedules
app.get('/api/v1/device-schedules', authJWT, async (_req, res) => {
  try {
    const items = await prisma.deviceSchedule.findMany({ orderBy: [{ priority: 'desc' }, { id: 'asc' }] });
    res.json({ ok: true, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Create schedule
app.post('/api/v1/device-schedules', authJWT, requireSuperadmin, async (req, res) => {
  try {
    const { deviceId, windowStart, windowEnd, sceneCmd, offMode, priority, enabled } = req.body || {};
    if (typeof windowStart !== 'number' || typeof windowEnd !== 'number') {
      return res.status(400).json({ ok: false, error: 'windowStart/windowEnd required (minutes)' });
    }
    const item = await prisma.deviceSchedule.create({
      data: {
        deviceId: deviceId || null,
        windowStart,
        windowEnd,
        sceneCmd: sceneCmd || 'SCENE 1',
        offMode: offMode || 'OFF',
        priority: priority ?? 0,
        enabled: enabled !== false
      }
    });
    res.status(201).json({ ok: true, item });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Update schedule
app.put('/api/v1/device-schedules/:id', authJWT, requireSuperadmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const data = { ...req.body };
    delete data.id;
    const item = await prisma.deviceSchedule.update({ where: { id }, data });
    res.json({ ok: true, item });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Delete schedule
app.delete('/api/v1/device-schedules/:id', authJWT, requireSuperadmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await prisma.deviceSchedule.delete({ where: { id } });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});
// =======================================================================

const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => {
  console.log(`lasers app running on :${PORT} (Prisma connected)`);
});

// Рекомендуется для стабильного long-poll за прокси
server.keepAliveTimeout = 65000;
server.headersTimeout   = 70000;

// ================== SCHEDULER (DB-based) ==================
// Таблица DeviceSchedule управляет расписаниями.
// Поля: deviceId (nullable = * для всех), windowStart, windowEnd (минуты от полуночи), sceneCmd, offMode, priority, enabled.
// Алгоритм:
// 1. Ежemin: читаем все enabled записи.
// 2. Для каждого устройства (из Device + из уникальных deviceId расписаний) находим подходящее правило с max priority,
//    где текущее время попадает в окно (учитывая overnight если end <= start). Если rule.deviceId=null - wildcard fallback.
// 3. Применяем SCENE (sceneCmd) или OFF (offMode) если состояние изменилось.

const scheduleCacheState = new Map(); // deviceId -> 'SCENE' | 'OFF'

function timeMinutesNow() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function matchInWindow(mins, start, end) {
  if (end <= start) { // overnight
    return mins >= start || mins < end;
  }
  return mins >= start && mins < end;
}

function parseSceneCmd(sceneCmd) {
  const parts = sceneCmd.trim().split(/\s+/);
  const base = parts.shift()?.toUpperCase() || 'SCENE';
  const valMaybe = parts[0] && !isNaN(parseInt(parts[0], 10)) ? parseInt(parts[0], 10) : undefined;
  return { base, valMaybe };
}

async function applyScheduleForDevice(deviceId, rule, target) {
  const current = scheduleCacheState.get(deviceId);
  if (current === target) return;
  try {
    if (target === 'SCENE') {
      const { base, valMaybe } = parseSceneCmd(rule.sceneCmd);
      cancelOffMacro(deviceId);
      await insertOne(deviceId, { cmd: base, val: valMaybe });
    } else { // OFF
      if (rule.offMode === 'OFF') {
        startOffMacro(deviceId);
      } else {
        await insertOne(deviceId, { cmd: 'OFF' });
      }
    }
    scheduleCacheState.set(deviceId, target);
    console.log(`[schedule-db] ${deviceId} -> ${target} (rule ${rule.id})`);
  } catch (e) {
    console.warn('[schedule-db] failed for', deviceId, 'rule', rule.id, e.message);
  }
}

async function runDbScheduleTick() {
  const nowM = timeMinutesNow();
  let rules = [];
  try {
    rules = await prisma.deviceSchedule.findMany({ where: { enabled: true }, orderBy: { priority: 'desc' } });
  } catch (e) {
    console.warn('[schedule-db] load error', e.message);
    return;
  }
  if (!rules.length) return;

  // Собрать список устройств: все из Device + явные deviceId правил (если их ещё нет в Device)
  const deviceRows = await prisma.device.findMany({ select: { id: true }, take: 2000 });
  const idSet = new Set(deviceRows.map(d => d.id));
  for (const r of rules) { if (r.deviceId) idSet.add(r.deviceId); }
  const allIds = Array.from(idSet);

  for (const devId of allIds) {
    // фильтруем правила по deviceId совпадающим или null (wildcard)
    const applicable = rules.filter(r => !r.deviceId || r.deviceId === devId);
    if (!applicable.length) continue;
    // найти первое с подходящим окном (они уже отсортированы по priority desc)
    let matched = null;
    for (const r of applicable) {
      if (matchInWindow(nowM, r.windowStart, r.windowEnd)) { matched = r; break; }
    }
    if (!matched) {
      // Вне всех окон — нужно OFF по правилу с наибольшим priority (берём первое applicable как baseline)
      const fallback = applicable[0];
      await applyScheduleForDevice(devId, fallback, 'OFF');
    } else {
      await applyScheduleForDevice(devId, matched, 'SCENE');
    }
  }
}

// Запуск планировщика из БД: каждую минуту + мягкий старт
setTimeout(runDbScheduleTick, 7000);
setInterval(runDbScheduleTick, 60 * 1000);
console.log('[schedule-db] enabled (DB driven)');
// ========================================================================

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  await prisma.$disconnect();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  await prisma.$disconnect();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
