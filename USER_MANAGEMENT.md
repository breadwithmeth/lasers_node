# 🔐 Система пользователей-администраторов

## Обзор

В приложение **Lasers Drawbridge WebApp** добавлена полноценная система управления пользователями-администраторами с JWT аутентификацией.

## ✨ Возможности

- 🔐 **JWT аутентификация** вместо простых токенов
- 👥 **Управление пользователями** (создание, редактирование, деактивация)
- 🛡️ **Роли пользователей** (admin, superadmin)
- 🔒 **Безопасное хранение паролей** (bcrypt хеширование)
- 📊 **Веб-интерфейс** для управления пользователями
- 🔄 **Обратная совместимость** с legacy AUTH_TOKEN

## 🗄️ Схема базы данных

```prisma
model User {
  id          Int      @id @default(autoincrement())
  username    String   @unique
  email       String   @unique  
  passwordHash String
  role        String   @default("admin") // admin, superadmin
  isActive    Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  lastLoginAt DateTime?
  createdById Int?     // кто создал пользователя
  createdBy   User?    @relation("UserCreatedBy", fields: [createdById], references: [id])
  createdUsers User[]  @relation("UserCreatedBy")
}
```

## 🚀 Быстрый старт

### 1. Создание первого администратора

```bash
npm run create-admin
```

Скрипт проведет через интерактивное создание первого супер-администратора.

### 2. Доступ к админ-панели

Откройте в браузере: `http://localhost:8080/admin.html`

### 3. Использование API

Все API эндпоинты теперь поддерживают JWT аутентификацию.

## 🔌 API Эндпоинты

### Аутентификация

#### POST `/api/v1/auth/login`
Авторизация пользователя

**Запрос:**
```json
{
  "login": "admin", 
  "password": "mypassword"
}
```

**Ответ:**
```json
{
  "ok": true,
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": 1,
    "username": "admin",
    "email": "admin@example.com",
    "role": "superadmin"
  }
}
```

#### GET `/api/v1/auth/me`
Получение информации о текущем пользователе

**Заголовки:**
```
Authorization: Bearer <jwt_token>
```

**Ответ:**
```json
{
  "ok": true,
  "user": {
    "id": 1,
    "username": "admin",
    "email": "admin@example.com", 
    "role": "superadmin",
    "lastLoginAt": "2025-09-30T07:15:00.000Z"
  }
}
```

### Управление пользователями

#### POST `/api/v1/users` 🔒
Создание нового пользователя

**Запрос:**
```json
{
  "username": "newuser",
  "email": "newuser@example.com",
  "password": "securepass123",
  "role": "admin"
}
```

#### GET `/api/v1/users` 🔒
Получение списка пользователей

**Параметры:**
- `includeInactive=true` - включить неактивных пользователей

#### GET `/api/v1/users/:id` 🔒  
Получение информации о пользователе

#### PUT `/api/v1/users/:id` 🔒
Обновление пользователя

**Запрос:**
```json
{
  "username": "newusername",
  "email": "newemail@example.com",
  "role": "admin",
  "isActive": true
}
```

#### POST `/api/v1/users/:id/change-password` 🔒
Смена пароля

**Запрос:**
```json
{
  "currentPassword": "oldpass",
  "newPassword": "newpass123"
}
```

#### DELETE `/api/v1/users/:id` 🔒
Деактивация пользователя (soft delete)

## 🔐 Система безопасности

### JWT Токены
- **Время жизни:** 24 часа (настраивается в `JWT_EXPIRES_IN`)
- **Секретный ключ:** настраивается в `JWT_SECRET`
- **Полезная нагрузка:** userId, username, email, role

### Хеширование паролей
- **Алгоритм:** bcrypt
- **Salt rounds:** 12
- **Требования к паролю:**
  - Минимум 8 символов
  - Хотя бы одна буква
  - Хотя бы одна цифра

### Роли пользователей
- **admin** - базовая административная роль
- **superadmin** - полные права (может менять пароли других пользователей)

## 🔧 Настройка

### Переменные окружения

```bash
# JWT Configuration  
JWT_SECRET=your-super-secret-jwt-key-change-in-production
JWT_EXPIRES_IN=24h

# Legacy (для обратной совместимости)
AUTH_TOKEN=your-secret-token-here
```

### Обратная совместимость
Система поддерживает старые API токены через `AUTH_TOKEN`. Если JWT аутентификация не проходит, система автоматически проверяет legacy токен.

## 📊 Веб-интерфейс

### Доступ
- **URL:** `http://localhost:8080/admin.html`
- **Функции:**
  - Авторизация
  - Просмотр профиля
  - Список пользователей
  - Создание новых пользователей
  - Активация/деактивация пользователей

### Особенности
- Автоматическое сохранение токена в localStorage
- Проверка токена при загрузке страницы
- Responsive дизайн
- Валидация форм

## 🛠️ Команды разработки

```bash
# Создание первого администратора
npm run create-admin

# Открытие Prisma Studio для управления данными
npm run db:studio

# Создание миграции после изменений схемы
npx prisma migrate dev --name "migration_name"
```

## 📝 Примеры использования

### cURL примеры

**Авторизация:**
```bash
curl -X POST "http://localhost:8080/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"login": "admin", "password": "mypassword"}'
```

**Создание пользователя:**
```bash
curl -X POST "http://localhost:8080/api/v1/users" \
  -H "Authorization: Bearer <jwt_token>" \
  -H "Content-Type: application/json" \
  -d '{"username": "newuser", "email": "user@example.com", "password": "pass123", "role": "admin"}'
```

**Получение списка пользователей:**
```bash
curl -H "Authorization: Bearer <jwt_token>" \
  "http://localhost:8080/api/v1/users"
```

### JavaScript клиент

```javascript
class AdminAPI {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.token = localStorage.getItem('adminToken');
  }

  async login(login, password) {
    const response = await fetch(`${this.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login, password })
    });
    
    const data = await response.json();
    if (data.ok) {
      this.token = data.token;
      localStorage.setItem('adminToken', this.token);
      return data.user;
    }
    throw new Error(data.error);
  }

  async getUsers() {
    const response = await fetch(`${this.baseUrl}/api/v1/users`, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
    
    const data = await response.json();
    if (data.ok) return data.users;
    throw new Error(data.error);
  }

  async createUser(userData) {
    const response = await fetch(`${this.baseUrl}/api/v1/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`
      },
      body: JSON.stringify(userData)
    });
    
    const data = await response.json();
    if (data.ok) return data.user;
    throw new Error(data.error);
  }
}

// Использование
const admin = new AdminAPI('http://localhost:8080');
await admin.login('admin', 'password');
const users = await admin.getUsers();
```

## 🔄 Миграция

Если у вас уже есть система с `AUTH_TOKEN`, новая система полностью совместима:

1. Добавьте JWT переменные в `.env`
2. Создайте первого администратора: `npm run create-admin`  
3. Постепенно переходите на JWT токены
4. Старые API токены продолжат работать

## ⚠️ Безопасность

### Рекомендации для продакшена:
1. **Смените JWT_SECRET** на криптостойкий ключ
2. **Используйте HTTPS** для всех запросов
3. **Настройте CORS** правильно
4. **Ограничьте время жизни токенов**
5. **Регулярно аудируйте пользователей**
6. **Используйте сильные пароли**

### Важные замечания:
- Пользователь не может удалить сам себя
- Пароли нельзя восстановить, только сменить
- Деактивация = soft delete (данные сохраняются)
- Все изменения логируются через createdBy связи

## 🎉 Заключение

Система пользователей готова к использованию! Теперь у вас есть полноценная JWT аутентификация с веб-интерфейсом для управления администраторами лазерной системы.