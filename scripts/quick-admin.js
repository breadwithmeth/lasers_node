require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const AuthUtils = require('../utils/auth');

async function createFirstAdmin() {
  const prisma = new PrismaClient();
  
  try {
    // Проверяем, есть ли уже пользователи
    const existingUsers = await prisma.user.findMany();
    
    if (existingUsers.length > 0) {
      console.log('✅ В системе уже есть пользователи:');
      existingUsers.forEach(user => {
        console.log(`   - ${user.username} (${user.email}) - ${user.role}`);
      });
      return;
    }

    // Создаем первого админа
    const passwordHash = await AuthUtils.hashPassword('admin123');
    
    const user = await prisma.user.create({
      data: {
        username: 'admin',
        email: 'admin@lasers.local',
        passwordHash,
        role: 'superadmin'
      }
    });

    console.log('🎉 Первый администратор создан:');
    console.log(`   Username: ${user.username}`);
    console.log(`   Email: ${user.email}`);
    console.log(`   Password: admin123`);
    console.log(`   Role: ${user.role}`);
    
    // Генерируем тестовый токен
    const token = AuthUtils.generateToken(user);
    console.log('\n🔑 JWT токен для тестирования:');
    console.log(token);
    console.log('\n📋 Тест авторизации:');
    console.log(`curl -X POST "http://localhost:3000/api/v1/auth/login" -H "Content-Type: application/json" -d '{"login": "admin", "password": "admin123"}'`);

  } catch (error) {
    console.error('❌ Ошибка:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

createFirstAdmin();