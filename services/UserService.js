const { PrismaClient } = require('@prisma/client');
const AuthUtils = require('../utils/auth');

class UserService {
  constructor(prisma) {
    this.prisma = prisma;
  }

  async createUser(userData, createdById = null) {
    const { username, email, password, role = 'admin' } = userData;

    // Валидация
    if (!username || username.length < 3) {
      throw new Error('Имя пользователя должно содержать минимум 3 символа');
    }

    if (!AuthUtils.validateEmail(email)) {
      throw new Error('Некорректный email адрес');
    }

    const passwordValidation = AuthUtils.validatePassword(password);
    if (!passwordValidation.valid) {
      throw new Error(passwordValidation.message);
    }

    // Проверка уникальности
    const existingUser = await this.prisma.user.findFirst({
      where: {
        OR: [
          { username },
          { email }
        ]
      }
    });

    if (existingUser) {
      if (existingUser.username === username) {
        throw new Error('Пользователь с таким именем уже существует');
      }
      if (existingUser.email === email) {
        throw new Error('Пользователь с таким email уже существует');
      }
    }

    // Создание пользователя
    const passwordHash = await AuthUtils.hashPassword(password);
    
    return await this.prisma.user.create({
      data: {
        username,
        email,
        passwordHash,
        role,
        createdById
      },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        isActive: true,
        createdAt: true,
        lastLoginAt: true
      }
    });
  }

  async authenticateUser(login, password) {
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { username: login },
          { email: login }
        ],
        isActive: true
      }
    });

    if (!user) {
      throw new Error('Неверные учетные данные');
    }

    const isPasswordValid = await AuthUtils.comparePassword(password, user.passwordHash);
    if (!isPasswordValid) {
      throw new Error('Неверные учетные данные');
    }

    // Обновляем время последнего входа
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() }
    });

    return {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      isActive: user.isActive,
      lastLoginAt: new Date()
    };
  }

  async getUserById(id) {
    return await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        lastLoginAt: true,
        createdBy: {
          select: {
            id: true,
            username: true
          }
        }
      }
    });
  }

  async getAllUsers(includeInactive = false) {
    const where = includeInactive ? {} : { isActive: true };
    
    return await this.prisma.user.findMany({
      where,
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        isActive: true,
        createdAt: true,
        lastLoginAt: true,
        createdBy: {
          select: {
            id: true,
            username: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  async updateUser(id, updateData, updatedById) {
    const { username, email, role, isActive } = updateData;
    
    const updateFields = {};
    
    if (username !== undefined) {
      if (username.length < 3) {
        throw new Error('Имя пользователя должно содержать минимум 3 символа');
      }
      
      const existingUser = await this.prisma.user.findFirst({
        where: { username, NOT: { id } }
      });
      
      if (existingUser) {
        throw new Error('Пользователь с таким именем уже существует');
      }
      
      updateFields.username = username;
    }

    if (email !== undefined) {
      if (!AuthUtils.validateEmail(email)) {
        throw new Error('Некорректный email адрес');
      }
      
      const existingUser = await this.prisma.user.findFirst({
        where: { email, NOT: { id } }
      });
      
      if (existingUser) {
        throw new Error('Пользователь с таким email уже существует');
      }
      
      updateFields.email = email;
    }

    if (role !== undefined) {
      updateFields.role = role;
    }

    if (isActive !== undefined) {
      updateFields.isActive = isActive;
    }

    return await this.prisma.user.update({
      where: { id },
      data: updateFields,
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        isActive: true,
        updatedAt: true
      }
    });
  }

  async changePassword(id, currentPassword, newPassword) {
    const user = await this.prisma.user.findUnique({
      where: { id }
    });

    if (!user) {
      throw new Error('Пользователь не найден');
    }

    const isCurrentPasswordValid = await AuthUtils.comparePassword(currentPassword, user.passwordHash);
    if (!isCurrentPasswordValid) {
      throw new Error('Неверный текущий пароль');
    }

    const passwordValidation = AuthUtils.validatePassword(newPassword);
    if (!passwordValidation.valid) {
      throw new Error(passwordValidation.message);
    }

    const newPasswordHash = await AuthUtils.hashPassword(newPassword);
    
    await this.prisma.user.update({
      where: { id },
      data: { passwordHash: newPasswordHash }
    });

    return true;
  }

  async deleteUser(id) {
    // Soft delete - просто деактивируем пользователя
    return await this.prisma.user.update({
      where: { id },
      data: { isActive: false },
      select: {
        id: true,
        username: true,
        isActive: true
      }
    });
  }
}

module.exports = UserService;