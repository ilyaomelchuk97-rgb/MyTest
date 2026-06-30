-- ============================================================
-- SmartPlan — СХЕМА БАЗЫ ДАННЫХ PostgreSQL (продакшен)
-- УП «МИНГАЗ» · Планирование СЭОГС
-- ------------------------------------------------------------
-- Этот файл — структура БД для серверной версии (Django/.NET + PostgreSQL).
-- В браузерном прототипе та же модель хранится в localStorage (db.js).
-- Запуск: psql -U postgres -f schema.sql
-- ============================================================

-- Роли пользователей системы
CREATE TYPE user_role AS ENUM ('admin', 'nach', 'smaster', 'master');
-- admin   — Администратор (видит всё, управляет пользователями)
-- nach    — Начальник участка (полный доступ к планированию своего участка)
-- smaster — Старший мастер (планирование/отметка по своему участку)
-- master  — Мастер (только свои задачи, отметка «Выполнено»)

CREATE TYPE object_type AS ENUM ('ГРП', 'ШРП', 'Трасса');
CREATE TYPE task_status AS ENUM ('plan', 'progress', 'done');

-- ---------- ПОЛЬЗОВАТЕЛИ ----------
CREATE TABLE users (
    id            BIGSERIAL PRIMARY KEY,
    login         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,                 -- bcrypt/argon2 на сервере (НЕ открытый пароль)
    full_name     TEXT NOT NULL,
    role          user_role NOT NULL DEFAULT 'master',
    area          TEXT,                           -- участок: ПУ-1, ПУ-2, ГРП, УБиРОГС (NULL = все)
    color         TEXT DEFAULT '#2563eb',         -- цвет плиток/меток в интерфейсе
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- ОБЪЕКТЫ ГАЗОСНАБЖЕНИЯ ----------
CREATE TABLE objects (
    id        BIGSERIAL PRIMARY KEY,
    address   TEXT NOT NULL,
    obj_type  object_type NOT NULL,
    zu_count  SMALLINT NOT NULL DEFAULT 0,        -- кол-во ЗУ (для авто-расчёта нормы «ТО ЗУ»)
    lat       DOUBLE PRECISION,
    lng       DOUBLE PRECISION,
    geom      geography(Point, 4326),             -- PostGIS: координаты для гео-запросов/маршрутов
    source    TEXT DEFAULT 'Панорама',            -- источник (импорт из ГИС «Панорама»)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_objects_geom ON objects USING GIST (geom);

-- ---------- СПРАВОЧНИК РАБОТ (древовидный) ----------
CREATE TABLE work_catalog (
    id          BIGSERIAL PRIMARY KEY,
    parent_id   BIGINT REFERENCES work_catalog(id) ON DELETE CASCADE,  -- NULL = группа верхнего уровня
    name        TEXT NOT NULL,
    norm_hours  NUMERIC(6,2) NOT NULL DEFAULT 0,  -- норма времени, чел/час
    unit        TEXT NOT NULL DEFAULT 'объект'    -- объект | ЗУ | км
);

-- ---------- ПЛАН РАБОТ ----------
CREATE TABLE plan_tasks (
    id           BIGSERIAL PRIMARY KEY,
    object_id    BIGINT NOT NULL REFERENCES objects(id),
    work_id      BIGINT NOT NULL REFERENCES work_catalog(id),
    master_id    BIGINT REFERENCES users(id),     -- кому назначено (мастер/старший мастер)
    planned_date DATE,                            -- плановая дата выполнения
    deadline     DATE,                            -- предельный срок
    status       task_status NOT NULL DEFAULT 'plan',
    hours        NUMERIC(6,2),                    -- расчётные трудозатраты (кэш)
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_plan_master_date ON plan_tasks (master_id, planned_date);
CREATE INDEX idx_plan_status ON plan_tasks (status);

-- ---------- МАРШРУТЫ (история для отчётов по топливу/ГСМ) ----------
CREATE TABLE routes (
    id           BIGSERIAL PRIMARY KEY,
    master_id    BIGINT NOT NULL REFERENCES users(id),
    route_date   DATE NOT NULL,
    path         geography(LineString, 4326),     -- оптимизированный маршрут
    distance_km  NUMERIC(8,2),
    duration_min INTEGER,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- СЕССИИ / ТОКЕНЫ (при серверной аутентификации) ----------
CREATE TABLE sessions (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token      TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- НАЧАЛЬНЫЙ АДМИНИСТРАТОР ----------
-- ВНИМАНИЕ: замените хэш на реальный bcrypt-хэш пароля!
-- Сгенерировать в Python: from passlib.hash import bcrypt; print(bcrypt.using(rounds=12).hash('ваш_пароль'))
INSERT INTO users (login, password_hash, full_name, role, area, color)
VALUES ('admin', '$2b$12$ЗАМЕНИТЕ_НА_BCRYPT_ХЭШ', 'Администратор системы', 'admin', NULL, '#0f2740');
