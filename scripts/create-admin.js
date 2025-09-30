#!/usr/bin/env node

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const UserService = require('../services/UserService');
const AuthUtils = require('../utils/auth');
const readline = require('readline');

const prisma = new PrismaClient();
const userService = new UserService(prisma);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function askQuestion(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function createFirstAdmin() {
  console.log('🚀 Создание первого администратора\n');

  try {
    // Проверяем, есть ли уже пользователи
    const existingUsers = await userService.getAllUsers(true);
    
    if (existingUsers.length > 0) {
      console.log('❌ В системе уже есть пользователи:');
      existingUsers.forEach(user => {
        console.log(`   - ${user.username} (${user.email}) - ${user.role} - ${user.isActive ? 'активен' : 'неактивен'}`);
      });
      console.log('\nДля создания нового пользователя используйте API или веб-интерфейс.');
      return;
    }

    let username, email, password;

    // Получаем данные пользователя
    while (!username || username.length < 3) {
      username = await askQuestion('Имя пользователя (минимум 3 символа): ');
      if (!username || username.length < 3) {
        console.log('❌ Имя пользователя должно содержать минимум 3 символа');
      }
    }

    while (!email || !AuthUtils.validateEmail(email)) {
      email = await askQuestion('Email: ');
      if (!AuthUtils.validateEmail(email)) {
        console.log('❌ Некорректный email адрес');
      }
    }

    while (true) {
      password = await askQuestion('Пароль (минимум 8 символов, буквы и цифры): ');
      const validation = AuthUtils.validatePassword(password);
      if (validation.valid) {
        break;
      } else {
        console.log(`❌ ${validation.message}`);
      }
    }

    // Создаем пользователя
    const user = await userService.createUser({
      username,
      email,
      password,
      role: 'superadmin'
    });

    console.log('\n✅ Первый администратор создан успешно!');
    console.log(`   Имя пользователя: ${user.username}`);
    console.log(`   Email: ${user.email}`);
    console.log(`   Роль: ${user.role}`);
    console.log(`   ID: ${user.id}`);
    
    // Генерируем тестовый токен
    const token = AuthUtils.generateToken(user);
    console.log('\n🔑 JWT токен для тестирования API:');
    console.log(token);
    
    console.log('\n📝 Пример использования:');
    console.log(`curl -H "Authorization: Bearer ${token}" "http://localhost:8080/api/v1/auth/me"`);

  } catch (error) {
    console.error('❌ Ошибка:', error.message);
  } finally {
    await prisma.$disconnect();
    rl.close();
  }
}

// Запуск скрипта
if (require.main === module) {
  createFirstAdmin().catch(console.error);
}

module.exports = { createFirstAdmin };