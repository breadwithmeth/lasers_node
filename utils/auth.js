const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

class AuthUtils {
  static generateToken(user) {
    const payload = {
      userId: user.id,
      username: user.username,
      email: user.email,
      role: user.role
    };
    
    return jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '24h'
    });
  }

  static verifyToken(token) {
    try {
      return jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      return null;
    }
  }

  static async hashPassword(password) {
    const saltRounds = 12;
    return await bcrypt.hash(password, saltRounds);
  }

  static async comparePassword(password, hash) {
    return await bcrypt.compare(password, hash);
  }

  static validatePassword(password) {
    // Минимум 8 символов, хотя бы одна цифра и одна буква
    const minLength = 8;
    const hasNumber = /\d/.test(password);
    const hasLetter = /[a-zA-Z]/.test(password);
    
    if (password.length < minLength) {
      return { valid: false, message: `Пароль должен содержать минимум ${minLength} символов` };
    }
    
    if (!hasNumber) {
      return { valid: false, message: 'Пароль должен содержать хотя бы одну цифру' };
    }
    
    if (!hasLetter) {
      return { valid: false, message: 'Пароль должен содержать хотя бы одну букву' };
    }
    
    return { valid: true };
  }

  static validateEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  static generateRandomPassword(length = 12) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }
}

module.exports = AuthUtils;