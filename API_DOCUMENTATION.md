# Lasers Drawbridge WebApp API Documentation

## Обзор

Это API для управления лазерными устройствами с поддержкой real-time коммуникации через long-polling. Система позволяет отправлять команды устройствам и получать события в реальном времени.

### Основные возможности
- Отправка команд устройствам
- Long-polling для получения событий в реальном времени
- Автоматические макросы (например, последовательность выключения)
- Хранение истории событий в SQLite
- Аутентификация для административных функций

### Базовый URL
```
http://localhost:8080/api/v1
```

### Аутентификация
Поддерживаются два режима:

1. Legacy токен (совместимость):
```
Authorization: Bearer <AUTH_TOKEN>
```
2. JWT токен (рекомендуется):
```
Authorization: Bearer <JWT_TOKEN>
```

JWT выдаётся через эндпоинт `/api/v1/auth/login` и содержит: `userId`, `username`, `email`, `role`. Срок действия по умолчанию 24 часа (`JWT_EXPIRES_IN`).

---

## Эндпоинты API

### 1. Long-Polling для получения событий

**GET** `/api/v1/poll`

Получение событий от устройства в режиме реального времени с использованием long-polling.

#### Параметры запроса:
- `device` (обязательный) - ID устройства
- `cursor` (опционально) - ID последнего полученного события (по умолчанию: 0)
- `wait` (опционально) - время ожидания в секундах (от 5 до 60, по умолчанию: 25)

#### Пример запроса:
```
GET /api/v1/poll?device=laser001&cursor=123&wait=30
```

#### Ответы:
**200 OK** - Есть новые события:
```json
{
  "events": [
    {
      "id": 124,
      "ts": "2025-09-30T10:30:00.000Z",
      "cmd": "SCENE 1",
      "val": 1
    }
  ],
  "cursor": "124"
}
```

**204 No Content** - Нет новых событий в течение времени ожидания

**400 Bad Request** - Ошибка параметров:
```json
{
  "ok": false,
  "error": "device required"
}
```

---

### 2. Отправка команд устройству

**POST** `/api/v1/cmd` 🔒 *Требует аутентификации*

Отправка команды или набора команд устройству.

#### Параметры запроса:
- `device` (обязательный) - ID устройства

#### Тело запроса:
Можно отправить:
1. Одну команду как объект
2. Массив команд
3. Объект с полем `events`, содержащим массив команд

#### Структура команды:
```json
{
  "cmd": "НАЗВАНИЕ_КОМАНДЫ",
  "args": "дополнительные аргументы (опционально)",
  "val": "значение (опционально)", 
  "num": "числовое значение (опционально)",
  "raw": "сырые данные (опционально)"
}
```

#### Примеры запросов:

**Одна команда:**
```json
{
  "cmd": "SCENE 1",
  "val": 1
}
```

**Несколько команд:**
```json
{
  "events": [
    {
      "cmd": "SCENE 1",
      "val": 1
    },
    {
      "cmd": "RAW",
      "raw": "40 0"
    }
  ]
}
```

**Массив команд напрямую:**
```json
[
  {
    "cmd": "SCENE 2",
    "val": 2
  },
  {
    "cmd": "OFF"
  }
]
```

#### Специальные команды:

##### OFF - Макрос выключения
Команда `OFF` запускает автоматическую последовательность выключения:
1. **t=0s**: `SCENE 1` (val: 1)
2. **t=20s**: RAW `1 0`
3. **t=40s**: RAW `40 0` 
4. **t=60s**: RAW `50 0`
5. **t=80s**: `OFF`

#### Ответ:
**200 OK**:
```json
{
  "ok": true,
  "added": [
    {
      "id": 125,
      "ts": "2025-09-30T10:35:00.000Z",
      "cmd": "SCENE 1",
      "val": 1
    }
  ],
  "macro": "OFF_SEQUENCE"
}
```

**400 Bad Request**:
```json
{
  "ok": false,
  "error": "device required"
}
```

**401 Unauthorized**:
```json
{
  "ok": false,
  "error": "unauthorized"
}
```

---

### 2.2 Приём статуса лазера от устройства

**POST** `/api/v1/device/:id/state`

Этот эндпоинт используется устройством для отправки своего текущего состояния. Аутентификация по умолчанию не требуется (можно включить позже при необходимости).

#### Параметры пути:
- `id` — идентификатор устройства

#### Тело запроса:
```json
{
  "state": "OK" | "DEVIATION",
  "deviation": 0.0
}
```

Поле `deviation` опционально. Если `state` = `DEVIATION`, рекомендуется передавать числовое значение отклонения.

#### Успешный ответ:
```json
{
  "ok": true,
  "event": {
    "id": 321,
    "ts": "2025-10-06T10:15:00.000Z",
    "cmd": "STATUS",
    "state": "OK",
    "deviation": 0
  }
}
```

#### Ошибки:
- `400` — отсутствует `device` или `state`, либо неверное значение `state`
- `500` — внутренняя ошибка сервера

---

### 2.1 Упрощённые (convenience) эндпоинты команд

Для типовых операций добавлены короткие маршруты:

| Метод | Путь | Назначение |
|-------|------|------------|
| POST | /api/v1/device/:id/off | Запустить OFF макрос (SCENE 1 → RAW 1 0 → RAW 40 0 → RAW 50 0 → OFF) |
| POST | /api/v1/device/:id/scene/1 | Отправить SCENE 1 |
| POST | /api/v1/device/:id/scene/2 | Отправить SCENE 2 |
| POST | /api/v1/device/:id/custom | Отправить одну произвольную команду |

#### Примеры:

```bash
curl -X POST -H "Authorization: Bearer <TOKEN>" \
  http://localhost:8080/api/v1/device/laser001/off

curl -X POST -H "Authorization: Bearer <TOKEN>" \
  http://localhost:8080/api/v1/device/laser001/scene/1

curl -X POST -H "Authorization: Bearer <TOKEN>" -H 'Content-Type: application/json' \
  -d '{"cmd":"SCENE","val":2}' \
  http://localhost:8080/api/v1/device/laser001/custom
```

Когда `cmd=OFF` отправляется через `/custom`, система перенаправит это в макрос OFF.

---

### 3. Список устройств

**GET** `/api/v1/devices` 🔒 *Требует аутентификации*

Получение списка всех устройств с их статистикой.

#### Ответ:
```json
{
  "devices": [
    {
      "id": "laser001",
      "lastSeenAt": 1727692200000,
      "queueLen": 5,
      "lastId": 150,
      "lastEventAt": "2025-09-30T10:30:00.000Z",
      "scheduleHas": true,
      "scheduleActive": false
    },
    {
      "id": "laser002", 
      "lastSeenAt": 1727692100000,
      "queueLen": 2,
      "lastId": 89,
      "lastEventAt": "2025-09-30T10:28:00.000Z",
      "scheduleHas": false,
      "scheduleActive": false
    }
  ]
}
```

#### Поля ответа:
- `id` - ID устройства
- `lastSeenAt` - время последнего обращения в миллисекундах (timestamp)
- `queueLen` - размер очереди событий в памяти
- `lastId` - ID последнего события
- `lastEventAt` - время последнего события (ISO string)
- `scheduleHas` - есть ли хотя бы одно правило расписания (в т.ч. wildcard)
- `scheduleActive` - устройство сейчас находится в активном окне (какая-либо SCENE будет поддерживаться)
- (при расширении через Device модель можно обогащать координатами — см. раздел "Устройства с координатами")

---

### 4. История событий устройства

**GET** `/api/v1/events` 🔒 *Требует аутентификации*

Получение истории событий для конкретного устройства.

#### Параметры запроса:
- `device` (обязательный) - ID устройства
- `cursor` (опционально) - ID события, после которого получать события (по умолчанию: 0)
- `limit` (опционально) - количество событий (от 1 до 500, по умолчанию: 100)

#### Пример запроса:
```
GET /api/v1/events?device=laser001&cursor=100&limit=50
```

#### Ответ:
```json
{
  "events": [
    {
      "id": 101,
      "ts": "2025-09-30T10:25:00.000Z",
      "cmd": "SCENE 1",
      "val": 1
    },
    {
      "id": 102,
      "ts": "2025-09-30T10:26:00.000Z", 
      "cmd": "RAW",
      "raw": "40 0"
    }
  ],
  "cursor": "102"
}
```

---

### 5. Аутентификация пользователя (JWT)

**POST** `/api/v1/auth/login`

Авторизация по `username`/`email` и паролю. Возвращает JWT токен.

#### Тело запроса:
```json
{
  "login": "admin", // username или email
  "password": "secret123"
}
```

#### Успешный ответ:
```json
{
  "ok": true,
  "token": "<JWT_TOKEN>",
  "user": {
    "id": 1,
    "username": "admin",
    "email": "admin@example.com",
    "role": "superadmin"
  }
}
```

#### Ошибки:
`400` — отсутствуют поля; `401` — неверные учетные данные

### 6. Текущий пользователь

**GET** `/api/v1/auth/me` 🔒

Возвращает данные текущего авторизованного пользователя по JWT.

#### Пример ответа:
```json
{
  "ok": true,
  "user": {
    "id": 1,
    "username": "admin",
    "email": "admin@example.com",
    "role": "superadmin",
    "lastLoginAt": "2025-09-30T07:20:11.000Z"
  }
}
```

### 7. Создание пользователя

**POST** `/api/v1/users` 🔒 *(требуется авторизация — создаёт админ / супер-админ)*

#### Тело запроса:
```json
{
  "username": "user1",
  "email": "user1@example.com",
  "password": "Passw0rd!",
  "role": "admin" // или "superadmin"
}
```

#### Ответ:
```json
{
  "ok": true,
  "user": {
    "id": 2,
    "username": "user1",
    "email": "user1@example.com",
    "role": "admin",
    "isActive": true,
    "createdAt": "2025-09-30T07:30:00.000Z"
  }
}
```

### 8. Список пользователей

**GET** `/api/v1/users?includeInactive=true` 🔒

Возвращает массив пользователей. Если `includeInactive=true` — включает деактивированных.

### 9. Получение одного пользователя

**GET** `/api/v1/users/:id` 🔒

### 10. Обновление пользователя

**PUT** `/api/v1/users/:id` 🔒

#### Пример тела:
```json
{ "email": "new@example.com", "role": "admin", "isActive": true }
```

### 11. Смена пароля

**POST** `/api/v1/users/:id/change-password` 🔒
```json
{ "currentPassword": "oldPass1", "newPassword": "NewPass2" }
```
Пользователь может менять только свой пароль, кроме роли `superadmin`.

### 12. Деактивация пользователя

**DELETE** `/api/v1/users/:id` 🔒
Soft delete — пользователь помечается `isActive=false`.

---

### 13. Управление устройствами (координаты)

Prisma модель `Device` (актуальная):
```prisma
model Device {
  id         String   @id
  lat        Float?
  lon        Float?
  lastSeenAt DateTime @default(now())
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
  events     Event[]
}
```

Реализованные эндпоинты:

| Метод | Путь | Назначение |
|-------|------|------------|
| GET | /api/v1/devices | Список устройств + последняя активность + координаты |
| GET | /api/v1/device/:id | Получить сведения об устройстве (lat/lon, lastSeenAt, lastEvent) |
| PUT | /api/v1/device/:id | Создать/обновить координаты (lat, lon) |
| GET | /api/v1/devices/coords | Упрощённый список (id, lat, lon, lastSeenAt) для карт |

Тело PUT запроса:
```json
{ "lat": 55.751244, "lon": 37.618423 }
```

Ответ:
```json
{
  "ok": true,
  "device": {
    "id": "laser001",
    "lat": 55.751244,
    "lon": 37.618423,
    "lastSeenAt": "2025-09-30T10:40:00.000Z",
    "createdAt": "2025-09-30T09:00:00.000Z",
    "updatedAt": "2025-09-30T10:40:05.000Z",
    "scheduleHas": true,
    "scheduleActive": true
  }
}
```

Замечания:
- Поля `x,y,z` устарели и заменены на `lat, lon`.
- `lastSeenAt` автоматически обновляется при `poll`.
- При отсутствии устройства при `PUT` оно будет создано.

---

## Коды ошибок

| Код | Описание |
|-----|----------|
| 200 | Успешный запрос |
| 204 | Нет контента (для long-polling) |
| 400 | Неверные параметры запроса |
| 401 | Неавторизованный доступ |
| 500 | Внутренняя ошибка сервера |

---

## Примеры использования

### JavaScript Client для Long-Polling

```javascript
class LaserClient {
  constructor(baseUrl, authToken = null) {
    this.baseUrl = baseUrl;
    this.authToken = authToken;
  }

  // Отправка команды
  async sendCommand(device, command) {
    const response = await fetch(`${this.baseUrl}/api/v1/cmd?device=${device}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.authToken && { 'Authorization': `Bearer ${this.authToken}` })
      },
      body: JSON.stringify(command)
    });
    return await response.json();
  }

  // Long-polling для получения событий
  async pollEvents(device, cursor = 0, onEvent = null) {
    while (true) {
      try {
        const response = await fetch(
          `${this.baseUrl}/api/v1/poll?device=${device}&cursor=${cursor}&wait=30`
        );
        
        if (response.status === 204) {
          // Нет новых событий, повторяем запрос
          continue;
        }
        
        if (response.ok) {
          const data = await response.json();
          cursor = data.cursor;
          
          if (onEvent) {
            data.events.forEach(onEvent);
          }
        }
      } catch (error) {
        console.error('Polling error:', error);
        // Ждём перед повтором
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }
}

// Использование
const client = new LaserClient('http://localhost:8080', 'your-auth-token');

// Отправка команды
client.sendCommand('laser001', { cmd: 'SCENE 1', val: 1 });

// Запуск макроса выключения
client.sendCommand('laser001', { cmd: 'OFF' });

// Прослушивание событий
client.pollEvents('laser001', 0, (event) => {
  console.log('Новое событие:', event);
});
```

### cURL примеры

**Отправка команды:**
```bash
curl -X POST "http://localhost:8080/api/v1/cmd?device=laser001" \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"cmd": "SCENE 1", "val": 1}'
```

**Long-polling:**
```bash
curl "http://localhost:8080/api/v1/poll?device=laser001&cursor=0&wait=30"
```

**Получение списка устройств:**
```bash
curl -H "Authorization: Bearer your-token" \
  "http://localhost:8080/api/v1/devices"
```

---

## Конфигурация

### Переменные окружения

| Переменная | Описание | По умолчанию |
|------------|----------|--------------|
| `PORT` | Порт сервера | 8080 |
| `DB_PATH` | Путь к файлу базы данных SQLite | `./events.db` |
| `AUTH_TOKEN` | Legacy токен (опционально) | не установлен |
| `JWT_SECRET` | Секрет для подписи JWT | обязательно в проде |
| `JWT_EXPIRES_IN` | TTL токена (например 24h) | 24h |

### Пример .env файла
```bash
PORT=8080
DB_PATH=./events.db
AUTH_TOKEN=legacy-token-if-needed
JWT_SECRET=your-jwt-secret
JWT_EXPIRES_IN=24h
SCHEDULE_ENABLED=true
SCHEDULE_SCENE_WINDOW=23:00-04:00
SCHEDULE_SCENE_CMD="SCENE 1"
SCHEDULE_OFF_MODE=OFF
SCHEDULE_DEVICES=*
```

---

## Плановое расписание (DB-based Scheduler)

Расписания теперь хранятся в таблице `DeviceSchedule` (Prisma модель) и управляются через API. Это позволяет редактировать окна без рестарта приложения.

### Модель DeviceSchedule
```prisma
model DeviceSchedule {
  id          Int      @id @default(autoincrement())
  deviceId    String?  // null => правило для всех устройств (wildcard)
  windowStart Int      // минуты от полуночи 0..1439
  windowEnd   Int      // минуты от полуночи 0..1439 (<= start => окно через полночь)
  sceneCmd    String   @default("SCENE 1")
  offMode     String   @default("OFF")   // OFF | SCENE_OFF
  priority    Int      @default(0)        // больше = важнее
  enabled     Boolean  @default(true)
  startTime   String?  // HH:MM (если задано — используется вместо windowStart)
  endTime     String?  // HH:MM (если задано — используется вместо windowEnd)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

### Алгоритм выбора
1. Каждую минуту загружаются все `enabled` правила отсортированные по `priority desc`.
2. Для каждого устройства собирается список подходящих правил (совпадение `deviceId` или `deviceId=null`).
3. Первое правило по приоритету чьё окно активно (минуты попадают в интервал) даёт состояние SCENE.
4. Если ни одно окно активно — применяется OFF (используя первое по приоритету правило как источник настроек `offMode`).
5. Команда отправляется только при смене состояния (кэшировано в памяти).

### Интерпретация окна
`windowStart=1380 (23:00)`, `windowEnd=240 (04:00)` => ночное окно через полночь (активно если `time >= 1380 || time < 240`).

### API (только superadmin для модификации)
| Метод | Путь | Описание |
|-------|------|----------|
| GET | /api/v1/device-schedules | Список правил |
| POST | /api/v1/device-schedules | Создать правило |
| PUT | /api/v1/device-schedules/:id | Обновить правило |
| DELETE | /api/v1/device-schedules/:id | Удалить правило |

### Поля создания / обновления
```json
{
  "deviceId": "laser001",   // опционально, null или пропуск = для всех
  "windowStart": 1380,       // минуты (23*60) — fallback если нет startTime
  "windowEnd": 240,          // минуты (4*60) — fallback если нет endTime
  "startTime": "23:00",     // опционально HH:MM (перекрывает windowStart)
  "endTime": "04:00",       // опционально HH:MM (перекрывает windowEnd)
  "sceneCmd": "SCENE 1",    // строка
  "offMode": "OFF",         // OFF | SCENE_OFF
  "priority": 10,            // целое число (больше = важнее)
  "enabled": true
}
```

### Пример сценария
1. Общая ночная SCENE 1 для всех устройств (через HH:MM):
```json
POST /api/v1/device-schedules
{ "startTime": "23:00", "endTime": "04:00", "sceneCmd": "SCENE 1", "priority": 1 }
```
2. Для устройства `laser007` своя SCENE 2 с приоритетом выше:
```json
POST /api/v1/device-schedules
{ "deviceId": "laser007", "startTime": "23:00", "endTime": "04:00", "sceneCmd": "SCENE 2", "priority": 5 }
```
3. Дневное окно выключения мгновенно (SCENE_OFF не использовать макрос):
```json
POST /api/v1/device-schedules
{ "startTime": "08:00", "endTime": "17:00", "sceneCmd": "SCENE 1", "offMode": "SCENE_OFF", "priority": 2 }
```

### Поведение OFF
- `OFF`: запускается полный OFF макрос (последовательность).
- `SCENE_OFF`: одна команда OFF без макроса.

### Ограничения
- Нет пока эндпоинта просмотра текущего вычисленного состояния (можно добавить при необходимости).
- Нет аудита применённых переходов (только логи сервера `[schedule-db]`).

### Возможные расширения
- API: `GET /api/v1/device-schedules/status` с текущим состоянием каждого устройства.
- История применения в БД.
- Несколько активных команд (композиция) — не поддерживается.

---

## Особенности реализации

### Long-Polling
- Клиенты могут ждать новые события до 60 секунд
- При появлении новых событий соединения сразу возвращают ответ
- Поддерживается множественные подключения к одному устройству

### Макросы
- Команда `OFF` автоматически запускает последовательность выключения
- Любая новая команда (кроме `GET`) отменяет текущий макрос
- Макросы выполняются асинхронно с заданными задержками

### Производительность
- События кэшируются в памяти (до 500 последних событий на устройство)
- Используется SQLite с WAL режимом для быстрого доступа
- Подготовленные SQL запросы для оптимальной производительности

### Безопасность
#### JWT
- Всегда используйте HTTPS в продакшене
- Регулярно ротируйте `JWT_SECRET`
- Не храните токен в открытом виде в логах

#### Пароли
- Хранятся в виде bcrypt hash (12 rounds)
- Минимум 8 символов, минимум 1 буква и 1 цифра

#### Роли
- `admin` — базовые операции
- `superadmin` — может управлять пользователями и их паролями
- Административные функции защищены Bearer токеном
- CORS включен для кросс-доменных запросов
- Ограничение размера JSON payload (256KB)