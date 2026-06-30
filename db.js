/* ============================================================
   SmartPlan — МОДУЛЬ БАЗЫ ДАННЫХ (localStorage)
   ------------------------------------------------------------
   Хранит пользователей с ролями и обеспечивает вход по логину/паролю.
   Пароли НЕ хранятся в открытом виде — только SHA-256 хэш (salt+hash)
   через Web Crypto API (с синхронным запасным алгоритмом для file://).
   Данные сохраняются в localStorage и живут между запусками.

   В продакшене (Django/.NET + PostgreSQL) эти функции заменяются
   REST-запросами к серверу, а хэширование — на bcrypt/argon2.
   ============================================================ */
window.SP_DB = (function () {
  'use strict';
  var KEY = 'smartplan_db_v2';     // хранилище пользователей
  var SESS = 'smartplan_session_v2'; // id вошедшего пользователя
  var SALT = 'SP$2026#УП-МИНГАЗ#';

  var PALETTE = ['#2563eb', '#0d9488', '#7c3aed', '#db2777', '#ca8a04', '#0891b2', '#c026d3', '#ea580c', '#4f46e5', '#16a34a'];

  /* ---------- ХЭШИРОВАНИЕ ПАРОЛЯ ---------- */
  function hash(pw) {
    var salted = SALT + pw + '#end';
    if (window.crypto && window.crypto.subtle && window.crypto.subtle.digest) {
      try {
        return window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(salted)).then(function (buf) {
          return [].map.call(new Uint8Array(buf), function (b) { return ('00' + b.toString(16)).slice(-2); }).join('');
        }, function () { return fnv(salted); }).catch(function () { return fnv(salted); });
      } catch (e) { return Promise.resolve(fnv(salted)); }
    }
    // запасной синхронный алгоритм (многораундовый FNV-1a) — для file:// без crypto.subtle
    return Promise.resolve(fnv(salted));
  }
  function fnv(s) {
    var h = 2166136261 >>> 0, str = s;
    for (var r = 0; r < 7; r++) {
      for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
      str = h.toString(16);
    }
    return str;
  }

  /* ---------- ХРАНИЛИЩЕ ---------- */
  // memoryDB — кэш в памяти. Нужен, чтобы база жила в течение сессии страницы
  // даже если localStorage недоступен (превью в песочнице без allow-same-origin,
  // режим инкогнито и т.п.). save() всегда обновляет и кэш, и localStorage.
  var memoryDB = null;
  function load() {
    if (memoryDB) return memoryDB;
    try { var raw = localStorage.getItem(KEY); if (raw) memoryDB = JSON.parse(raw); } catch (e) {}
    return memoryDB;
  }
  function save(db) {
    memoryDB = db;
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {}
  }
  function init() {
    var db = load();
    if (!db) { db = { users: [], created: Date.now() }; memoryDB = db; save(db); }
    return memoryDB;
  }

  /* ---------- ПЕРВОНАЧАЛЬНОЕ НАПОЛНЕНИЕ ---------- */
  // В системе остаётся ТОЛЬКО администратор.
  // Остальных пользователей (нач. участка, мастеров и т.д.) добавляет
  // администратор через раздел «Пользователи».
  function ensureSeed() {
    var db = init();
    var have = {}; db.users.forEach(function (u) { have[u.id] = 1; });
    function add(u) { if (!have[u.id]) { db.users.push(u); have[u.id] = 1; } }

    return Promise.resolve()
      .then(function () { return hash('admin123'); }).then(function (h) {
        add({ id: 'u_admin', login: 'admin', password: h, full_name: 'Администратор системы', role: 'admin', area: 'Все участки', color: '#0f2740', active: true, seed: true });
      })
      .then(function () { save(db); return db; });
  }

  /* ---------- ЧТЕНИЕ ---------- */
  function getUsers() { return init().users.slice(); }
  function getUser(id) { var db = init(); for (var i = 0; i < db.users.length; i++) if (db.users[i].id === id) return db.users[i]; return null; }
  function getUserByLogin(login) {
    var db = init(); login = (login || '').toLowerCase();
    for (var i = 0; i < db.users.length; i++) if (db.users[i].login.toLowerCase() === login) return db.users[i];
    return null;
  }
  // Мастера/старшие мастера — это строки календаря (планируемый ресурс)
  function getMasters() {
    return init().users
      .filter(function (u) { return (u.role === 'master' || u.role === 'smaster') && u.active; })
      .map(function (u) { return Object.assign({}, u, { name: u.full_name }); });
  }
  function countAdmins() { return init().users.filter(function (u) { return u.role === 'admin' && u.active; }).length; }

  /* ---------- ЗАПИСЬ ---------- */
  function nextColor() {
    var db = init(), used = {};
    db.users.forEach(function (u) { used[u.color] = 1; });
    for (var i = 0; i < PALETTE.length; i++) if (!used[PALETTE[i]]) return PALETTE[i];
    return PALETTE[db.users.length % PALETTE.length];
  }
  function addUser(data) {
    var db = init();
    if (getUserByLogin(data.login)) return Promise.reject(new Error('Логин «' + data.login + '» уже занят'));
    return hash(data.password).then(function (h) {
      var u = {
        id: 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), // гарантированно уникальный
        login: data.login, password: h,
        full_name: data.full_name, role: data.role, area: data.area || '',
        color: data.color || nextColor(), active: data.active !== false, created: Date.now()
      };
      db.users.push(u); save(db); return u;
    });
  }
  function updateUser(id, data) {
    var db = init(), u = null;
    for (var i = 0; i < db.users.length; i++) if (db.users[i].id === id) { u = db.users[i]; break; }
    if (!u) return Promise.reject(new Error('Пользователь не найден'));
    if (data.login && data.login !== u.login) {
      if (getUserByLogin(data.login)) return Promise.reject(new Error('Логин уже занят'));
      u.login = data.login;
    }
    if (data.full_name !== undefined) u.full_name = data.full_name;
    if (data.role) u.role = data.role;
    if (data.area !== undefined) u.area = data.area;
    if (data.active !== undefined) u.active = data.active;
    function commit() { save(db); return u; }
    if (data.password) return hash(data.password).then(function (h) { u.password = h; return commit(); });
    return Promise.resolve(commit());
  }
  function deleteUser(id) {
    var db = init(), u = getUser(id);
    if (u && u.role === 'admin' && countAdmins() <= 1) throw new Error('Нельзя удалить последнего администратора');
    db.users = db.users.filter(function (x) { return x.id !== id; });
    save(db);
  }

  /* ---------- АУТЕНТИФИКАЦИЯ ---------- */
  function authenticate(login, password) {
    var u = getUserByLogin(login);
    if (!u || !u.active) return Promise.resolve(null);
    return hash(password).then(function (h) { return h === u.password ? u : null; });
  }

  /* ---------- СЕССИЯ ---------- */
  function setSession(id) { try { localStorage.setItem(SESS, id); } catch (e) {} }
  function getSession() { var id; try { id = localStorage.getItem(SESS); } catch (e) { return null; } return id ? getUser(id) : null; }
  function clearSession() { try { localStorage.removeItem(SESS); } catch (e) {} }

  return {
    ensureSeed: ensureSeed, getUsers: getUsers, getUser: getUser, getUserByLogin: getUserByLogin,
    getMasters: getMasters, countAdmins: countAdmins,
    addUser: addUser, updateUser: updateUser, deleteUser: deleteUser,
    authenticate: authenticate, setSession: setSession, getSession: getSession, clearSession: clearSession,
    hash: hash
  };
})();
