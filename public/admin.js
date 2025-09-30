// Админ панель JavaScript

let currentToken = localStorage.getItem('adminToken');
let currentUser = null;

// Проверяем токен при загрузке страницы
document.addEventListener('DOMContentLoaded', function() {
    if (currentToken) {
        checkToken();
    }
});

// Проверка действительности токена
async function checkToken() {
    try {
        const response = await fetch('/api/v1/auth/me', {
            headers: {
                'Authorization': `Bearer ${currentToken}`
            }
        });

        if (response.ok) {
            const data = await response.json();
            currentUser = data.user;
            showAdminPanel();
        } else {
            localStorage.removeItem('adminToken');
            currentToken = null;
            showLoginForm();
        }
    } catch (error) {
        console.error('Ошибка проверки токена:', error);
        showLoginForm();
    }
}

// Авторизация пользователя
async function loginUser() {
    const login = document.getElementById('login').value.trim();
    const password = document.getElementById('password').value;
    const errorDiv = document.getElementById('loginError');

    if (!login || !password) {
        showError(errorDiv, 'Введите логин и пароль');
        return;
    }

    try {
        const response = await fetch('/api/v1/auth/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ login, password })
        });

        const data = await response.json();

        if (data.ok) {
            currentToken = data.token;
            currentUser = data.user;
            localStorage.setItem('adminToken', currentToken);
            showAdminPanel();
            hideError(errorDiv);
        } else {
            showError(errorDiv, data.error || 'Ошибка авторизации');
        }
    } catch (error) {
        console.error('Ошибка авторизации:', error);
        showError(errorDiv, 'Ошибка подключения к серверу');
    }
}

// Показать панель админа
function showAdminPanel() {
    document.getElementById('loginForm').classList.add('hidden');
    document.getElementById('adminPanel').classList.remove('hidden');
    
    // Показываем информацию о пользователе
    displayUserInfo();
    
    // Загружаем список пользователей
    loadUsers();
}

// Показать форму входа
function showLoginForm() {
    document.getElementById('loginForm').classList.remove('hidden');
    document.getElementById('adminPanel').classList.add('hidden');
    
    // Очищаем поля
    document.getElementById('login').value = '';
    document.getElementById('password').value = '';
}

// Отображение информации о текущем пользователе
function displayUserInfo() {
    const userInfoDiv = document.getElementById('userInfo');
    if (currentUser) {
        userInfoDiv.innerHTML = `
            <div class="user-item">
                <strong>Имя:</strong> ${currentUser.username}<br>
                <strong>Email:</strong> ${currentUser.email}<br>
                <strong>Роль:</strong> ${currentUser.role}<br>
                <strong>Последний вход:</strong> ${currentUser.lastLoginAt ? new Date(currentUser.lastLoginAt).toLocaleString('ru') : 'Первый вход'}
            </div>
        `;
    }
}

// Загрузка списка пользователей
async function loadUsers() {
    const usersListDiv = document.getElementById('usersList');
    
    try {
        const response = await fetch('/api/v1/users?includeInactive=true', {
            headers: {
                'Authorization': `Bearer ${currentToken}`
            }
        });

        const data = await response.json();

        if (data.ok) {
            if (data.users.length === 0) {
                usersListDiv.innerHTML = '<p>Пользователи не найдены</p>';
                return;
            }

            let html = '';
            data.users.forEach(user => {
                const lastLogin = user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString('ru') : 'Не входил';
                const createdAt = new Date(user.createdAt).toLocaleString('ru');
                const createdBy = user.createdBy ? user.createdBy.username : 'Система';
                const statusColor = user.isActive ? '#28a745' : '#dc3545';
                const statusText = user.isActive ? 'Активен' : 'Неактивен';

                html += `
                    <div class="user-item">
                        <strong>${user.username}</strong> (${user.email})<br>
                        <small>Роль: ${user.role} | 
                        Статус: <span style="color: ${statusColor}">${statusText}</span><br>
                        Создан: ${createdAt} (${createdBy})<br>
                        Последний вход: ${lastLogin}</small>
                        ${user.id !== currentUser.id ? `
                            <br><button onclick="toggleUserStatus(${user.id}, ${user.isActive})" style="margin-top: 5px; padding: 5px 10px; font-size: 12px;">
                                ${user.isActive ? 'Деактивировать' : 'Активировать'}
                            </button>
                        ` : ''}
                    </div>
                `;
            });
            
            usersListDiv.innerHTML = html;
        } else {
            usersListDiv.innerHTML = `<p style="color: red;">Ошибка: ${data.error}</p>`;
        }
    } catch (error) {
        console.error('Ошибка загрузки пользователей:', error);
        usersListDiv.innerHTML = '<p style="color: red;">Ошибка подключения к серверу</p>';
    }
}

// Создание нового пользователя
async function createUser() {
    const username = document.getElementById('newUsername').value.trim();
    const email = document.getElementById('newEmail').value.trim();
    const password = document.getElementById('newPassword').value;
    const role = document.getElementById('newRole').value;
    
    const errorDiv = document.getElementById('createError');
    const successDiv = document.getElementById('createSuccess');
    
    hideError(errorDiv);
    hideError(successDiv);

    if (!username || !email || !password) {
        showError(errorDiv, 'Заполните все поля');
        return;
    }

    try {
        const response = await fetch('/api/v1/users', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ username, email, password, role })
        });

        const data = await response.json();

        if (data.ok) {
            showError(successDiv, `Пользователь ${data.user.username} создан успешно!`);
            
            // Очищаем поля
            document.getElementById('newUsername').value = '';
            document.getElementById('newEmail').value = '';
            document.getElementById('newPassword').value = '';
            document.getElementById('newRole').value = 'admin';
            
            // Обновляем список пользователей если мы на той вкладке
            if (document.getElementById('usersTab').classList.contains('active')) {
                loadUsers();
            }
        } else {
            showError(errorDiv, data.error || 'Ошибка создания пользователя');
        }
    } catch (error) {
        console.error('Ошибка создания пользователя:', error);
        showError(errorDiv, 'Ошибка подключения к серверу');
    }
}

// Переключение статуса пользователя
async function toggleUserStatus(userId, isCurrentlyActive) {
    const action = isCurrentlyActive ? 'деактивировать' : 'активировать';
    
    if (!confirm(`Вы уверены, что хотите ${action} этого пользователя?`)) {
        return;
    }
    
    try {
        let response;
        
        if (isCurrentlyActive) {
            // Деактивация
            response = await fetch(`/api/v1/users/${userId}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${currentToken}`
                }
            });
        } else {
            // Активация
            response = await fetch(`/api/v1/users/${userId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${currentToken}`
                },
                body: JSON.stringify({ isActive: true })
            });
        }

        const data = await response.json();

        if (data.ok) {
            loadUsers(); // Обновляем список
        } else {
            alert(`Ошибка: ${data.error}`);
        }
    } catch (error) {
        console.error('Ошибка изменения статуса пользователя:', error);
        alert('Ошибка подключения к серверу');
    }
}

// Переключение вкладок
function showTab(tabName) {
    // Убираем активность со всех вкладок
    document.querySelectorAll('.tab').forEach(tab => {
        tab.classList.remove('active');
    });
    
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    
    // Активируем нужную вкладку
    event.target.classList.add('active');
    document.getElementById(tabName + 'Tab').classList.add('active');
    
    // Загружаем данные если нужно
    if (tabName === 'users') {
        loadUsers();
    }
}

// Выход из системы
function logout() {
    localStorage.removeItem('adminToken');
    currentToken = null;
    currentUser = null;
    showLoginForm();
}

// Утилиты для работы с ошибками
function showError(element, message) {
    element.textContent = message;
    element.classList.remove('hidden');
}

function hideError(element) {
    element.classList.add('hidden');
}

// Обработка Enter в полях ввода
document.addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
        if (!document.getElementById('loginForm').classList.contains('hidden')) {
            loginUser();
        }
    }
});