# Миграция на Prisma - Руководство разработчика

## 🎯 Что изменилось

Приложение **Lasers Drawbridge WebApp** успешно мигрировано с `better-sqlite3` на **Prisma ORM**. Это обеспечивает:

- ✅ Типобезопасность запросов
- ✅ Автоматическая генерация типов TypeScript
- ✅ Простые миграции базы данных
- ✅ Удобная работа с базой данных через Prisma Studio
- ✅ Лучшая производительность и оптимизация запросов

## 📊 Схема базы данных

```prisma
model Event {
  id      Int    @id @default(autoincrement())
  device  String
  ts      String
  payload String

  @@index([device, id])
}
```

## 🔧 Новые команды разработки

Добавлены новые npm скрипты для работы с Prisma:

```bash
# Запуск приложения
npm start

# Разработка
npm run dev

# Генерация Prisma Client (после изменений схемы)
npm run db:generate

# Синхронизация схемы с БД (для прототипирования)
npm run db:push

# Открытие Prisma Studio (GUI для работы с БД)
npm run db:studio
```

## 🗄️ Работа с базой данных

### Миграции

Для создания новых миграций используйте:
```bash
npx prisma migrate dev --name название_миграции
```

Для применения миграций в продакшене:
```bash
npx prisma migrate deploy
```

### Prisma Studio

Откройте веб-интерфейс для управления данными:
```bash
npm run db:studio
```
Откроется по адресу: `http://localhost:5555`

## 🔄 Изменения в коде

### Было (better-sqlite3):
```javascript
const Database = require('better-sqlite3');
const db = new Database(DB_PATH);

const qIns = db.prepare('INSERT INTO events (device, ts, payload) VALUES (?,?,?)');
const info = qIns.run(device, ts, JSON.stringify(row));
```

### Стало (Prisma):
```javascript
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const event = await prisma.event.create({
  data: {
    device,
    ts,
    payload: JSON.stringify(row)
  }
});
```

## 📝 Основные изменения в API

Все API эндпоинты остались **без изменений** для клиентов, но внутренне используют Prisma:

### 1. Long-Polling (`GET /api/v1/poll`)
- ✅ Async/await для всех DB операций
- ✅ Prisma запросы вместо подготовленных SQL
- ✅ Типобезопасность

### 2. Отправка команд (`POST /api/v1/cmd`)
- ✅ Массовая вставка через циклы с Prisma
- ✅ Обработка ошибок

### 3. Список устройств (`GET /api/v1/devices`)
- ✅ Группировка данных через Prisma `groupBy`
- ✅ Агрегатные функции (`_max`, `_count`)

### 4. История событий (`GET /api/v1/events`)
- ✅ Пагинация через `take` и `skip`
- ✅ Фильтрация через `where`

## ⚠️ Важные изменения

### Graceful Shutdown
Добавлен корректный shutdown для Prisma:

```javascript
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  await prisma.$disconnect();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
```

### Переменные окружения
Обновлен `.env` файл:
```bash
# Server configuration
PORT=8080
DB_PATH=./events.db
AUTH_TOKEN=your-secret-token-here

# Database (новая переменная для Prisma)
DATABASE_URL="file:./events.db"
```

## 🚀 Производительность

### Оптимизации Prisma:
- Подготовленные запросы автоматически
- Connection pooling
- Оптимизация запросов
- Кеширование на уровне ORM

### Индексы:
```prisma
@@index([device, id])
```
Индекс по полям `device` и `id` для быстрого поиска событий устройства.

## 🔍 Отладка и мониторинг

### Включить логи Prisma:
```bash
DEBUG="prisma:*" npm start
```

### Посмотреть сгенерированные SQL запросы:
```javascript
const prisma = new PrismaClient({
  log: ['query', 'info', 'warn', 'error'],
});
```

## 📦 Зависимости

### Удалены:
- `better-sqlite3` - заменен на Prisma

### Добавлены:
- `prisma` - CLI и инструменты разработки
- `@prisma/client` - клиент для выполнения запросов

## 🔧 Разработка и деплой

### Локальная разработка:
1. `npm install` - установка зависимостей
2. `npm run db:push` - синхронизация схемы
3. `npm start` - запуск сервера

### Продакшен деплой:
1. `npm install --production`
2. `npx prisma generate` - генерация клиента
3. `npx prisma migrate deploy` - применение миграций
4. `npm start`

## 🎉 Результат

Миграция завершена успешно! Приложение теперь использует современный Prisma ORM с сохранением полной функциональности API и улучшенной архитектурой кода.