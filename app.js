/* ============================================================
   SmartPlan — логика приложения (vanilla JS)
   ============================================================ */
(function () {
  'use strict';
  var D = window.SP;
  var DB = window.SP_DB;
  var OBJECTS = D.OBJECTS, WORK_TREE = D.WORK_TREE,
      WORK_MAP = D.WORK_MAP, OBJ_MAP = D.OBJ_MAP;

  // Мастера/бригады берутся из БД пользователей (роль master/smaster)
  function getMasters() { return DB.getMasters(); }

  // Описание ролей и участков
  var ROLE_INFO = {
    admin:   { label: 'Администратор',     cls: 'navy' },
    nach:    { label: 'Начальник участка', cls: 'blue' },
    smaster: { label: 'Старший мастер',    cls: 'purple' },
    master:  { label: 'Мастер',            cls: 'teal' }
  };
  var AREAS = ['ПУГС №1', 'ПУГС№2', 'ПУГС №3', 'ГРП', 'ПРОМГАЗ', 'УБиРОГС', 'РВРиКС', 'ГООГС'];

  /* ---------- УТИЛИТЫ ДАТ ---------- */
  var TODAY = new Date(); TODAY.setHours(0, 0, 0, 0);
  var WD = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  var WD_FULL = ['воскресенье','понедельник','вторник','среда','четверг','пятница','суббота'];
  var MON = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function offToDate(off) { return addDays(TODAY, off); }
  function key(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function sameDay(a, b) { return key(a) === key(b); }
  function dateToOff(d) { return Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - TODAY) / 86400000); }
  function mondayOf(d) { var x = new Date(d); var day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); return x; }
  function fmt(d) { return d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear(); }
  function fmtShort(off) { var d = offToDate(off); return d.getDate() + ' ' + MON[d.getMonth()]; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmtH(h) { return (Math.round(h * 10) / 10).toString().replace('.', ','); }
  function initials(name) {
    if (!name) return '?';
    var p = name.replace(/[^А-Яа-яA-Za-z\s.]/g, '').split(/\s+/).filter(Boolean);
    return ((p[0] || '')[0] || '') + ((p[1] || '')[0] || '');
  }

  /* ---------- СОСТОЯНИЕ ---------- */
  var S = {
    screen: 'dashboard',
    user: null,           // вошедший пользователь
    role: 'master',       // admin | nach | smaster | master
    curMaster: 'm1',
    calMode: 'week',      // week | month | day
    weekShift: 0, monthShift: 0, dayShift: 0,
    mapOff: 0,
    mapSel: {},
    refsTab: 'tree',
    userModalMode: 'new', userModalUid: null,
    tasks: D.TASK_SEED.map(function (t, i) { return Object.assign({ id: 't' + (i + 1) }, t); })
  };

  var CAP = 8; // ФРВ: рабочий день = 8 ч

  /* ---------- ПРАВА ДОСТУПА (иерархия) ----------
     admin   — видит и редактирует ВСЁ (все участки)
     nach    — видит и редактирует только мастеров СВОЕГО участка
     smaster — то же, что nach: только мастеров своего участка
     master  — видит и редактирует ТОЛЬКО СЕБЯ
  */
  // Создание планов и запуск оптимизатора — админ / нач. участка / ст. мастер
  function canPlan() { return S.role === 'admin' || S.role === 'nach' || S.role === 'smaster'; }
  function canApprove() { return S.role === 'admin' || S.role === 'nach'; }
  // Может ли пользователь редактировать конкретную задачу
  function canEditTask(t) {
    if (!t) return false;
    if (S.role === 'admin') return true;                       // всё
    if (S.role === 'master') return t.m === S.user.id;         // только себя
    var m = masterById(t.m);                                   // nach / smaster — свой участок
    return !!m && m.area === S.user.area;
  }
  // Может ли пользователь перетаскивать задачи на строку этого мастера
  function canDropOn(masterId) {
    if (S.role === 'admin') return true;
    if (S.role === 'master') return masterId === S.user.id;
    var m = masterById(masterId);
    return !!m && m.area === S.user.area;                       // nach / smaster
  }
  function visibleMasters() {
    var all = getMasters();
    if (S.role === 'admin') return all;
    if (S.role === 'master') return all.filter(function (m) { return m.id === S.user.id; });
    return all.filter(function (m) { return m.area === S.user.area; }); // nach, smaster
  }
  function visibleTasks() {
    var ids = {}; visibleMasters().forEach(function (m) { ids[m.id] = 1; });
    return S.tasks.filter(function (t) { return ids[t.m]; });
  }
  function masterById(id) { var u = DB.getUser(id); return u ? Object.assign({}, u, { name: u.full_name }) : null; }

  /* ---------- ЛОГИКА ЗАДАЧ ---------- */
  function taskHours(t) {
    var w = WORK_MAP[t.w], o = OBJ_MAP[t.o];
    if (!w) return 0;
    var h = w.norm;
    if (w.unit === 'ЗУ' && o) h = w.norm * (o.zu || 1);
    if (w.unit === 'км') h = w.norm * (t.km || 1);
    return h;
  }
  function taskColor(t) {
    if (t.status === 'done' || t.s === 'done') return 'done';
    if (t.d < 0) return 'red';
    if (t.dl < 0) return 'red';
    if (t.dl <= 2) return 'yellow';
    return 'green';
  }
  function statusLabel(t) {
    var s = t.s || t.status;
    return s === 'done' ? 'Выполнено' : s === 'progress' ? 'В работе' : 'В плане';
  }
  function isDone(t) { return (t.s || t.status) === 'done'; }
  function loadForDay(masterId, off) {
    var sum = 0;
    S.tasks.forEach(function (t) { if (t.m === masterId && t.d === off && !isDone(t)) sum += taskHours(t); });
    return sum;
  }

  /* ---------- DOM ---------- */
  var view = document.getElementById('view');
  var tip = document.getElementById('tip');
  var overlay = document.getElementById('overlay');
  var modal = document.getElementById('modal');

  var TITLES = {
    dashboard: ['Дашборд', 'Рабочий стол'],
    calendar: ['Планирование / Календарь', 'Перетаскивайте карточки: влево/вправо — смена даты, вверх/вниз — смена мастера'],
    map: ['Карта маршрутов', 'Оптимизация пути между объектами (экономия ГСМ)'],
    refs: ['Справочники', 'Виды работ, нормы времени, объекты газоснабжения'],
    users: ['Пользователи', 'Учётные записи, роли и доступ к системе'],
    reports: ['Отчёты', 'Печатные формы для подписи у руководства']
  };

  /* ---------- ИКОНКИ ---------- */
  var IC = {
    warn: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h7l-1 8 10-12h-7z"/></svg>',
    route: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18H15a3.5 3.5 0 000-7H9a3.5 3.5 0 010-7h6.5"/></svg>',
    info: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>'
  };

  /* =====================================================================
     РЕНДЕР: ДАШБОРД
     ===================================================================== */
  function renderDashboard() {
    var vt = visibleTasks();
    var today = vt.filter(function (t) { return t.d === 0; });
    var redzone = vt.filter(function (t) { return !isDone(t) && (t.dl <= 2 || t.d < 0); }).sort(function (a, b) { return a.dl - b.dl; });

    var mastersToday = visibleMasters();
    var overloads = mastersToday.filter(function (m) { return loadForDay(m.id, 0) > CAP; }).length;
    var doneMonth = 0, totalMonth = 0;
    vt.forEach(function (t) {
      var d = offToDate(t.d);
      if (d.getMonth() === TODAY.getMonth() && d.getFullYear() === TODAY.getFullYear()) { totalMonth++; if (isDone(t)) doneMonth++; }
    });
    var pct = totalMonth ? Math.round(doneMonth / totalMonth * 100) : 0;

    var areas = {};
    vt.forEach(function (t) {
      var d = offToDate(t.d);
      if (d.getMonth() !== TODAY.getMonth() || d.getFullYear() !== TODAY.getFullYear()) return;
      var m = masterById(t.m); if (!m) return;
      areas[m.area] = areas[m.area] || { done: 0, total: 0 };
      areas[m.area].total++; if (isDone(t)) areas[m.area].done++;
    });

    var html = '<div class="kpi-row">';
    html += kpi(today.length, 'Задач на сегодня', 'по ' + mastersToday.length + ' мастера(ам)', '#2563eb');
    html += kpi(overloads, 'Перегрузок сегодня', 'превышение ФРВ ' + CAP + ' ч', '#dc2626');
    html += kpi(redzone.length, 'Красная зона', 'дедлайн ≤ 2 дней / просрочка', '#ca8a04');
    html += kpi(pct + '%', 'Выполнено за месяц', doneMonth + ' из ' + totalMonth + ' работ', '#16a34a');
    html += '</div>';

    html += '<div class="dash-grid">';
    html += '<div class="card"><div class="card-h"><h2>Сегодня</h2><span class="sub">' + fmt(TODAY) + '</span><div class="spacer"></div><span class="badge tag ' + (overloads ? 'over' : 'ok') + '">' + (overloads ? 'Есть перегрузки' : 'Без перегрузок') + '</span></div><div class="card-b">';
    if (!today.length) html += '<div class="empty">На сегодня задач нет</div>';
    mastersToday.forEach(function (m) {
      var mt = today.filter(function (t) { return t.m === m.id; });
      var load = mt.reduce(function (s, t) { return s + (isDone(t) ? 0 : taskHours(t)); }, 0);
      var over = load > CAP;
      html += '<div class="today-mstr"><span class="dot" style="background:' + m.color + '"></span><div><div class="nm">' + esc(m.name) + '</div><div class="ar">' + esc(m.area) + '</div></div><div class="meta"><div class="h" style="color:' + (over ? 'var(--red)' : 'var(--ink)') + '">' + fmtH(load) + ' ч / ' + CAP + ' ч</div><span class="tag ' + (over ? 'over' : 'ok') + '">' + (over ? '⚠ Перегрузка +' + fmtH(load - CAP) + ' ч' : mt.length + ' заданий') + '</span></div></div>';
      mt.slice(0, 4).forEach(function (t) {
        var o = OBJ_MAP[t.o], w = WORK_MAP[t.w];
        html += '<div class="taskline"><span class="pill">' + esc(w ? w.name : '?') + '</span><span>' + esc(o ? o.addr : '?') + '</span><span style="margin-left:auto;color:var(--muted)">' + fmtH(taskHours(t)) + ' ч</span></div>';
      });
      if (mt.length > 4) html += '<div class="taskline" style="color:var(--muted)">и ещё ' + (mt.length - 4) + '…</div>';
    });
    html += '</div></div>';

    html += '<div class="card"><div class="card-h"><h2>Красная зона</h2><span class="sub">предельный срок истекает</span></div><div class="card-b">';
    if (!redzone.length) html += '<div class="empty">Просрочек нет 🎉</div>';
    redzone.forEach(function (t) {
      var o = OBJ_MAP[t.o], w = WORK_MAP[t.w], m = masterById(t.m);
      var col = taskColor(t);
      html += '<div class="rz-item"><div class="rz-bar" style="background:' + (col === 'red' ? 'var(--red)' : 'var(--yellow)') + '"></div><div class="rz-main"><div class="rz-t">' + esc(w ? w.name : '?') + ' — ' + esc(o ? o.addr : '?') + '</div><div class="rz-s">' + esc(m ? m.name : '?') + ' · ' + esc(m ? m.area : '') + ' · ' + statusLabel(t) + '</div></div><div class="rz-dl ' + (col === 'red' ? 'red' : 'yel') + '">' + (t.dl < 0 ? 'просрочка ' + (-t.dl) + ' дн' : t.dl === 0 ? 'сегодня!' : 'осталось ' + t.dl + ' дн') + '</div></div>';
    });
    html += '</div></div></div>';

    html += '<div class="card"><div class="card-h"><h2>Прогресс месяца</h2><span class="sub">' + MON[TODAY.getMonth()] + ' ' + TODAY.getFullYear() + ' · по участкам</span><div class="spacer"></div>' + ringHTML(pct, 64, 8, true) + '<div style="text-align:center;margin-left:6px"><div style="font-size:11px;color:var(--muted)">Итого</div><div style="font-weight:800;color:var(--ink)">' + pct + '%</div></div></div><div class="card-b"><div class="rings">';
    Object.keys(areas).forEach(function (a) {
      var x = areas[a]; var p = x.total ? Math.round(x.done / x.total * 100) : 0;
      html += '<div class="ring">' + ringHTML(p, 70, 9) + '<div class="ar">' + esc(a) + ' · ' + x.done + '/' + x.total + '</div></div>';
    });
    html += '</div></div></div>';

    view.innerHTML = html;
    document.getElementById('rz-badge').textContent = redzone.length;
  }

  function kpi(val, lab, hint, color) {
    return '<div class="kpi"><div class="acc" style="background:' + color + '"></div><div class="lab">' + lab + '</div><div class="val">' + val + '</div><div class="hint">' + hint + '</div></div>';
  }
  function ringHTML(pct, size, stroke, small) {
    var r = (size - stroke) / 2, c = 2 * Math.PI * r, off = c * (1 - pct / 100);
    var col = pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--yellow)' : 'var(--red)';
    var fs = small ? 13 : 16;
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '"><circle cx="' + (size / 2) + '" cy="' + (size / 2) + '" r="' + r + '" fill="none" stroke="#e2e8f0" stroke-width="' + stroke + '"/><circle cx="' + (size / 2) + '" cy="' + (size / 2) + '" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="' + stroke + '" stroke-linecap="round" stroke-dasharray="' + c + '" stroke-dashoffset="' + off + '" transform="rotate(-90 ' + (size / 2) + ' ' + (size / 2) + ')"/><text x="50%" y="54%" text-anchor="middle" font-size="' + fs + '" font-weight="800" fill="#1f2937">' + pct + '%</text></svg>';
  }

  /* =====================================================================
     РЕНДЕР: КАЛЕНДАРЬ
     ===================================================================== */
  function renderCalendar() {
    var html = '<div class="cal-head"><div class="seg">';
    html += segBtn('week', 'Неделя') + segBtn('month', 'Месяц') + segBtn('day', 'День');
    html += '</div>';
    html += '<button class="btn sm" data-action="cal-prev">‹</button>';
    html += '<span class="cal-title" id="cal-title"></span>';
    html += '<button class="btn sm" data-action="cal-next">›</button>';
    if (S.calMode !== 'day' || S.dayShift !== 0) html += '<button class="btn sm" data-action="cal-today">Сегодня</button>';
    if (canPlan()) html += '<button class="btn sm" data-action="new-task">' + IC.plus + ' План</button>';
    html += '<div class="legend"><span><i style="background:var(--green-l);border:1px solid var(--green)"></i>В норме</span><span><i style="background:var(--yellow-l);border:1px solid var(--yellow)"></i>Мало времени</span><span><i style="background:var(--red-l);border:1px solid var(--red)"></i>Просрочка</span><span><i style="background:#f1f5f9;border:1px solid #94a3b8"></i>Выполнено</span></div>';
    html += '</div>';
    if (S.role === 'master') {
      html += '<div class="calc" style="margin-bottom:12px">' + IC.info + ' Ваш личный график. Перетаскивайте карточки, чтобы менять дату выполнения.</div>';
    } else if (S.role !== 'admin') {
      html += '<div class="calc" style="margin-bottom:12px">' + IC.info + ' Участок <b>' + esc(S.user.area) + '</b>: доступны только мастера этого участка.</div>';
    }
    html += '<div class="cal-scroll"><div class="cal-grid ' + S.calMode + '" id="cal-grid"></div></div>';
    view.innerHTML = html;
    drawCalendarGrid();
  }
  function segBtn(mode, label) {
    return '<button class="' + (S.calMode === mode ? 'on' : '') + '" data-action="cal-mode" data-mode="' + mode + '">' + label + '</button>';
  }
  function drawCalendarGrid() {
    var grid = document.getElementById('cal-grid');
    var masters = visibleMasters();
    var days = buildDayWindow();
    document.getElementById('cal-title').textContent = windowTitle(days);

    if (!masters.length) {
      grid.style.gridTemplateColumns = '1fr';
      grid.innerHTML = '<div style="padding:44px 20px;text-align:center;color:var(--muted)"><div style="font-size:38px;margin-bottom:12px">👥</div><div style="color:var(--ink);font-size:15px;font-weight:700">Нет мастеров для планирования</div><div style="margin-top:8px;font-size:12.5px;max-width:420px;margin-left:auto;margin-right:auto">Добавьте пользователей с ролью «Мастер» или «Старший мастер» в разделе «Пользователи» — они автоматически появятся здесь как строки календаря.</div></div>';
      return;
    }

    grid.style.gridTemplateColumns = '170px repeat(' + days.length + ', minmax(74px,1fr))';
    var html = '';
    html += '<div class="col-head gh corner" style="grid-column:1;grid-row:1">Мастер / Бригада</div>';
    days.forEach(function (d, i) {
      var we = (d.getDay() === 0 || d.getDay() === 6);
      var cls = 'col-head gh' + (sameDay(d, TODAY) ? ' today' : '') + (we ? ' we' : '');
      html += '<div class="' + cls + '" style="grid-column:' + (i + 2) + ';grid-row:1"><div class="dn">' + d.getDate() + '</div><div class="wd">' + WD[d.getDay()] + '</div></div>';
    });
    masters.forEach(function (m, ri) {
      var rn = ri + 2;
      html += '<div class="mname" style="grid-column:1;grid-row:' + rn + '"><span class="dot" style="background:' + m.color + '"></span><div><div class="nm">' + esc(m.name) + '</div><div class="ar">' + esc(m.area) + '</div></div></div>';
      days.forEach(function (d, ci) {
        var off = dateToOff(d);
        var load = loadForDay(m.id, off);
        var over = load > CAP;
        var we = (d.getDay() === 0 || d.getDay() === 6);
        var cls = 'cell' + (sameDay(d, TODAY) ? ' today' : '') + (we ? ' we' : '') + (over ? ' overload' : '');
        html += '<div class="' + cls + '" style="grid-column:' + (ci + 2) + ';grid-row:' + rn + '" data-master="' + m.id + '" data-off="' + off + '"' + (over ? ' title="Перегрузка: ' + fmtH(load) + ' ч"' : '') + '>';
        if (over) html += '<span class="ov-warn">' + fmtH(load) + 'ч</span>';
        S.tasks.forEach(function (t) {
          if (t.m === m.id && t.d === off) {
            var col = taskColor(t);
            var o = OBJ_MAP[t.o], w = WORK_MAP[t.w];
            var draggable = (!isDone(t) && canEditTask(t)) ? 'true' : 'false';
            html += '<div class="tile t-' + col + '" draggable="' + draggable + '" data-tid="' + t.id + '"><span class="tw">' + esc(w ? w.name : '?') + (o && o.type === 'ШРП' && w && w.unit === 'ЗУ' ? ' ×' + (o.zu || 1) : '') + '</span><span class="th">' + esc(o ? o.addr : '?') + ' · ' + fmtH(taskHours(t)) + 'ч</span>' + (isDone(t) ? '<span class="chk">' + IC.check + '</span>' : '') + '</div>';
          }
        });
        html += '</div>';
      });
    });
    grid.innerHTML = html;
    attachCalDnD();
  }
  function buildDayWindow() {
    var arr = [];
    if (S.calMode === 'week') {
      var start = addDays(mondayOf(TODAY), S.weekShift * 7);
      for (var i = 0; i < 7; i++) arr.push(addDays(start, i));
    } else if (S.calMode === 'day') {
      arr.push(addDays(TODAY, S.dayShift));
    } else {
      var base = new Date(TODAY.getFullYear(), TODAY.getMonth() + S.monthShift, 1);
      var n = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
      for (var j = 1; j <= n; j++) arr.push(new Date(base.getFullYear(), base.getMonth(), j));
    }
    return arr;
  }
  function windowTitle(days) {
    if (S.calMode === 'day') return fmt(days[0]) + ' · ' + WD_FULL[days[0].getDay()];
    if (S.calMode === 'week') return fmt(days[0]) + ' — ' + fmt(days[6]);
    return MON[days[0].getMonth()] + ' ' + days[0].getFullYear();
  }

  /* ---------- DRAG & DROP ---------- */
  var dragId = null;
  function attachCalDnD() {
    var grid = document.getElementById('cal-grid'); if (!grid) return;
    grid.addEventListener('dragstart', function (e) {
      var tile = e.target.closest('.tile'); if (!tile) return;
      dragId = tile.dataset.tid; tile.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', dragId); } catch (err) {}
    });
    grid.addEventListener('dragend', function () {
      document.querySelectorAll('.tile.dragging').forEach(function (t) { t.classList.remove('dragging'); });
      document.querySelectorAll('.cell.drop-on').forEach(function (c) { c.classList.remove('drop-on'); });
      dragId = null;
    });
    grid.addEventListener('dragover', function (e) {
      if (!dragId) return;
      var cell = e.target.closest('.cell'); if (!cell) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      document.querySelectorAll('.cell.drop-on').forEach(function (c) { if (c !== cell) c.classList.remove('drop-on'); });
      cell.classList.add('drop-on');
    });
    grid.addEventListener('drop', function (e) {
      if (!dragId) return;
      var cell = e.target.closest('.cell'); if (!cell) return;
      e.preventDefault();
      var id = dragId || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
      cell.classList.remove('drop-on');
      var t = findTask(id); if (!t) return;
      if (!canEditTask(t)) { toast('err', 'Нет прав на редактирование этой задачи'); return; }
      var newMaster = cell.dataset.master, newOff = parseInt(cell.dataset.off, 10);
      // мастер — только своя строка; nach/smaster — только свой участок
      if (!canDropOn(newMaster)) { toast('err', 'Этот мастер вне вашего доступа'); return; }
      var target = masterById(newMaster);
      var moved = [];
      if (t.m !== newMaster) { t.m = newMaster; moved.push('мастер → ' + (target ? target.name : '?')); }
      if (t.d !== newOff) { t.d = newOff; moved.push('дата → ' + fmtShort(newOff)); }
      if (moved.length) {
        drawCalendarGrid();
        var load = loadForDay(newMaster, newOff);
        if (load > CAP) toast('warn', '⚠ Перенесено: ' + moved.join(', ') + '. Перегрузка: ' + fmtH(load) + ' ч / ' + CAP + ' ч.');
        else toast('ok', 'Перенесено: ' + moved.join(', '));
      }
    });
    grid.addEventListener('mousemove', tipHandler);
    grid.addEventListener('mouseleave', function () { tip.style.display = 'none'; });
  }
  function tipHandler(e) {
    var tile = e.target.closest('.tile');
    if (!tile) { tip.style.display = 'none'; return; }
    var t = findTask(tile.dataset.tid); if (!t) return;
    var o = OBJ_MAP[t.o], w = WORK_MAP[t.w], m = masterById(t.m);
    var dlTxt = t.dl < 0 ? '<b style="color:#fca5a5">просрочка ' + (-t.dl) + ' дн</b>' : t.dl === 0 ? '<b style="color:#fde047">дедлайн сегодня</b>' : 'дедлайн: ' + fmtShort(t.dl);
    tip.innerHTML = '<b>' + esc(w ? w.name : '?') + '</b><br>' + esc(o ? o.addr : '?') + ' · ' + esc(o ? o.type : '') + (w && w.unit === 'ЗУ' && o ? ' (' + (o.zu || 1) + ' ЗУ)' : '') + '<br>Состав: ' + esc(w ? w.name : '') + (w && w.unit === 'км' ? ' ' + (t.km || 1) + ' км' : '') + ' — ' + fmtH(taskHours(t)) + ' ч<br>Мастер: ' + esc(m ? m.name : '?') + ' · ' + statusLabel(t) + '<br>' + dlTxt + ' · план: ' + fmtShort(t.d);
    tip.style.display = 'block';
    var x = e.clientX + 14, y = e.clientY + 14;
    if (x + 270 > window.innerWidth) x = e.clientX - 270;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  function findTask(id) { for (var i = 0; i < S.tasks.length; i++) if (S.tasks[i].id === id) return S.tasks[i]; return null; }

  /* =====================================================================
     ЯДРО: "ОПТИМИЗАТОР"
     ===================================================================== */
  function checkOverload() {
    var fixes = 0;
    visibleMasters().forEach(function (m) {
      for (var off = -7; off <= 14; off++) {
        var load = loadForDay(m.id, off);
        while (load > CAP) {
          var dayTasks = S.tasks.filter(function (t) { return t.m === m.id && t.d === off && !isDone(t); }).sort(function (a, b) { return b.dl - a.dl; });
          if (!dayTasks.length) break;
          dayTasks[0].d = off + 1; fixes++;
          load = loadForDay(m.id, off);
        }
      }
    });
    if (fixes) toast('ok', 'Контроль ФРВ: снято перегрузок — ' + fixes + '.');
    else toast('ok', 'Контроль ФРВ: перегрузок не обнаружено.');
    refresh();
  }
  function optimizeRoutes() {
    var edits = 0;
    visibleMasters().forEach(function (m) {
      [-1, 0, 1].forEach(function (off) {
        var dayTasks = S.tasks.filter(function (t) { return t.m === m.id && t.d === off && !isDone(t); });
        if (dayTasks.length < 3) return;
        dayTasks.forEach(function (t) {
          var o = OBJ_MAP[t.o]; if (!o) return;
          for (var delta = 1; delta <= 2; delta++) {
            [off + delta, off - delta].forEach(function (adj) {
              var near = S.tasks.filter(function (x) {
                if (x.m !== m.id || x.d !== adj || isDone(x)) return false;
                var ob = OBJ_MAP[x.o]; if (!ob) return false;
                var dd = Math.sqrt(Math.pow(o.lat - ob.lat, 2) + Math.pow(o.lng - ob.lng, 2));
                return dd < 0.012;
              });
              if (near.length && adj !== off) {
                var load = loadForDay(m.id, adj);
                if (load + taskHours(t) <= CAP) { t.d = adj; edits++; }
              }
            });
          }
        });
      });
    });
    toast('ok', 'Маршруты оптимизированы: сгруппировано ' + edits + ' задач по близким адресам.');
    refresh();
  }
  function autoSchedule() {
    var pool = visibleTasks().filter(function (t) { return !isDone(t); }).sort(function (a, b) { return a.dl - b.dl; });
    var placed = 0, warnings = 0;
    pool.forEach(function (t) {
      var m = masterById(t.m) || visibleMasters()[0];
      var h = taskHours(t);
      var best = null, bestScore = -Infinity;
      for (var off = Math.max(0, t.d); off <= Math.max(t.dl, t.d) + 6; off++) {
        var load = loadForDay(m.id, off);
        if (load + h > CAP) continue;
        var geo = 0; var o = OBJ_MAP[t.o];
        if (o) {
          S.tasks.forEach(function (x) {
            if (x.m === m.id && x.d === off) { var ob = OBJ_MAP[x.o]; if (ob) { var dd = Math.sqrt(Math.pow(o.lat - ob.lat, 2) + Math.pow(o.lng - ob.lng, 2)); if (dd < 0.02) geo += 1; } }
          });
        }
        var score = geo * 10 - off;
        if (score > bestScore) { bestScore = score; best = off; }
      }
      if (best === null) { best = t.d; warnings++; }
      if (t.d !== best) { t.d = best; placed++; }
    });
    toast(warnings ? 'warn' : 'ok', 'График сформирован: распределено ' + placed + ' задач по приоритету дедлайна и географии.' + (warnings ? ' Внимание: ' + warnings + ' задач не вместить без перегрузки.' : ''));
    refresh();
  }

  /* =====================================================================
     РЕНДЕР: КАРТА МАРШРУТОВ
     ===================================================================== */
  var ymState = { token: 0, loaded: false, loading: false, waiting: [], ymap: null, pts: [], route: null };
  function renderMap() {
    var off = S.mapOff;
    var list = visibleTasks().filter(function (t) { return t.d === off; });
    var pts = list.map(function (t) {
      var o = OBJ_MAP[t.o], m = masterById(t.m), w = WORK_MAP[t.w];
      return { id: t.id, lat: o.lat, lng: o.lng, addr: o.addr, type: o.type, work: w.name, master: m.name, mcol: m.color, hours: taskHours(t) };
    });

    var html = '<div class="cal-head"><div class="seg">' +
      '<button class="' + (off === -1 ? 'on' : '') + '" data-action="map-off" data-off="-1">Вчера</button>' +
      '<button class="' + (off === 0 ? 'on' : '') + '" data-action="map-off" data-off="0">Сегодня</button>' +
      '<button class="' + (off === 1 ? 'on' : '') + '" data-action="map-off" data-off="1">Завтра</button></div>' +
      '<span class="cal-title">' + fmt(offToDate(off)) + '</span>' +
      '<div class="spacer"></div>' +
      '<button class="btn primary" data-action="build-route">' + IC.route + ' Построить маршрут</button></div>';

    html += '<div class="map-wrap"><div><div class="card"><div class="card-h"><h2>Задания на день</h2><span class="sub">' + pts.length + ' объектов</span></div><div class="card-b mlist" id="mlist">';
    if (!pts.length) html += '<div class="empty">На этот день заданий нет</div>';
    pts.forEach(function (p, i) {
      html += '<div class="mtask sel" data-mid="' + p.id + '"><div class="pin" style="background:' + p.mcol + '">' + (i + 1) + '</div><div><div class="mt-t">' + esc(p.work) + ' — ' + esc(p.addr) + '</div><div class="mt-s">' + esc(p.master) + ' · ' + fmtH(p.hours) + ' ч · ' + esc(p.type) + '</div></div></div>';
    });
    html += '</div></div></div>';

    html += '<div><div class="map-box" id="mapbox"><div class="map-stats" id="map-stats"><span>Точек: <b>' + pts.length + '</b></span><span id="route-info">Маршрут ещё не построен — нажмите «Построить маршрут»</span><span style="margin-left:auto;color:var(--muted)">Координаты: ГИС «Панорама»</span></div><div id="map-canvas" style="width:100%;height:480px"></div><div class="map-note" id="map-note"></div></div></div></div>';

    view.innerHTML = html;
    S.mapSel = {}; pts.forEach(function (p) { S.mapSel[p.id] = true; });

    document.getElementById('mlist').addEventListener('click', function (e) {
      var el = e.target.closest('.mtask'); if (!el) return;
      var id = el.dataset.mid;
      S.mapSel[id] = !S.mapSel[id];
      el.classList.toggle('sel', S.mapSel[id]);
      drawMap(pts);
    });

    drawMap(pts);
  }
  function drawMap(pts) {
    var sel = pts.filter(function (p) { return S.mapSel[p.id]; });
    var canvas = document.getElementById('map-canvas');
    var note = document.getElementById('map-note');
    if (!canvas) return;
    ymState.pts = sel; ymState.ymap = null; ymState.route = null;
    canvas.innerHTML = '';
    setRouteInfo(null);
    if (!sel.length) {
      if (note) { note.style.display = 'block'; note.textContent = 'Выберите задания слева, чтобы увидеть маршрут.'; }
      return;
    }
    drawSVGMap(sel, false);
    var token = ++ymState.token;
    ensureYandex(function () {
      if (token !== ymState.token) return;
      drawYandex(sel);
      if (note) note.style.display = 'none';
    }, function () {
      if (token !== ymState.token) return;
      if (note) {
        note.style.display = 'block';
        note.innerHTML = 'Режим предпросмотра: Яндекс.Карты недоступны (нет сети в песочнице).<br>Скачайте файл — кнопка «Построить маршрут» проложит путь по реальным дорогам.';
      }
    });
  }
  function ensureYandex(then, fail) {
    if (ymState.loaded && window.ymaps) { window.ymaps.ready(function () { then(); }); return; }
    if (ymState.loading) { ymState.waiting.push({ then: then, fail: fail }); return; }
    ymState.loading = true; ymState.waiting = [{ then: then, fail: fail }];
    var s = document.createElement('script');
    s.src = 'https://api-maps.yandex.ru/2.1/?lang=ru_RU';
    s.onload = function () {
      if (window.ymaps) {
        window.ymaps.ready(function () {
          ymState.loaded = true; ymState.loading = false;
          ymState.waiting.forEach(function (w) { w.then(); });
          ymState.waiting = [];
        });
      }
    };
    s.onerror = function () {
      ymState.loading = false;
      ymState.waiting.forEach(function (w) { w.fail(); });
      ymState.waiting = [];
    };
    document.head.appendChild(s);
    setTimeout(function () {
      if (!ymState.loaded) {
        ymState.waiting.forEach(function (w) { w.fail(); });
        ymState.waiting = [];
      }
    }, 1500);
  }
  function drawYandex(pts) {
    var order = optimizeOrder(pts);
    var center = order[0] ? [order[0].lat, order[0].lng] : [53.902, 27.561];
    var map = new window.ymaps.Map('map-canvas', { center: center, zoom: 13, controls: ['zoomControl', 'fullscreenControl'] });
    ymState.ymap = map;
    order.forEach(function (p, i) {
      map.geoObjects.add(new window.ymaps.Placemark([p.lat, p.lng], {
        iconCaption: (i + 1) + '. ' + p.work,
        balloonContentHeader: p.work,
        balloonContentBody: p.addr + '<br>' + p.master + ' · ' + fmtH(p.hours) + ' ч<br>Тип: ' + p.type,
        balloonContentFooter: 'Точка №' + (i + 1)
      }, { preset: 'islands#circleIcon', iconColor: p.mcol }));
    });
    var ref = order.map(function (p) { return [p.lat, p.lng]; });
    if (ref.length > 1) {
      map.geoObjects.add(new window.ymaps.Polyline(ref, { hintContent: 'Предварительный порядок обхода' }, { strokeColor: '#2563eb', strokeStyle: 'dash', strokeWidth: 3, opacity: 0.55 }));
    }
    map.setBounds(map.geoObjects.getBounds(), { checkZoomRange: true, zoomMargin: 40 });
  }
  function drawSVGMap(pts, built) {
    var order = optimizeOrder(pts);
    var W = 820, H = 480, pad = 46;
    var lats = pts.map(function (p) { return p.lat; }), lngs = pts.map(function (p) { return p.lng; });
    var minLat = Math.min.apply(null, lats), maxLat = Math.max.apply(null, lats);
    var minLng = Math.min.apply(null, lngs), maxLng = Math.max.apply(null, lngs);
    var spanLat = Math.max(maxLat - minLat, 0.01), spanLng = Math.max(maxLng - minLng, 0.01);
    function proj(p) { return { x: pad + ((p.lng - minLng) / spanLng) * (W - 2 * pad), y: pad + ((maxLat - p.lat) / spanLat) * (H - 2 * pad) }; }
    var pp = order.map(function (p, i) { var c = proj(p); return Object.assign({ idx: i, p: p }, c); });

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:100%;display:block;background:#dbe4ec">';
    svg += '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#e8eef3"/>';
    for (var gx = 0; gx <= W; gx += 60) svg += '<line x1="' + gx + '" y1="0" x2="' + gx + '" y2="' + H + '" stroke="#d4dde6" stroke-width="1"/>';
    for (var gy = 0; gy <= H; gy += 60) svg += '<line x1="0" y1="' + gy + '" x2="' + W + '" y2="' + gy + '" stroke="#d4dde6" stroke-width="1"/>';
    svg += '<path d="M0,' + (H * 0.62) + ' Q' + (W * 0.3) + ',' + (H * 0.5) + ' ' + (W * 0.55) + ',' + (H * 0.66) + ' T' + W + ',' + (H * 0.6) + '" stroke="#bfdbf3" stroke-width="26" fill="none" stroke-linecap="round"/>';
    var d = pp.map(function (c, i) { return (i ? 'L' : 'M') + c.x.toFixed(0) + ' ' + c.y.toFixed(0); }).join(' ');
    if (built) {
      svg += '<path d="' + d + '" stroke="#2563eb" stroke-width="6" fill="none" stroke-linejoin="round" stroke-linecap="round" opacity="0.95"/>';
      svg += '<path d="' + d + '" stroke="#bfdbfe" stroke-width="2.5" stroke-dasharray="1 12" fill="none" stroke-linecap="round" opacity="0.95"><animate attributeName="stroke-dashoffset" from="26" to="0" dur="0.8s" repeatCount="indefinite"/></path>';
      for (var s = 1; s < pp.length; s++) {
        var mx = (pp[s - 1].x + pp[s].x) / 2, my = (pp[s - 1].y + pp[s].y) / 2;
        var ang = Math.atan2(pp[s].y - pp[s - 1].y, pp[s].x - pp[s - 1].x) * 180 / Math.PI;
        svg += '<polygon points="0,-5 9,0 0,5" fill="#1d4ed8" transform="translate(' + mx.toFixed(0) + ' ' + my.toFixed(0) + ') rotate(' + ang.toFixed(0) + ')"/>';
      }
    } else {
      svg += '<path d="' + d + '" stroke="#2563eb" stroke-width="3.5" stroke-dasharray="6 6" fill="none" stroke-linejoin="round" stroke-linecap="round" opacity="0.6"/>';
    }
    pp.forEach(function (c) {
      svg += '<circle cx="' + c.x.toFixed(0) + '" cy="' + c.y.toFixed(0) + '" r="13" fill="' + c.p.mcol + '" stroke="#fff" stroke-width="2.5"/>';
      svg += '<text x="' + c.x.toFixed(0) + '" y="' + (c.y + 4).toFixed(0) + '" text-anchor="middle" font-size="12" font-weight="800" fill="#fff">' + (c.idx + 1) + '</text>';
    });
    if (built && pp.length > 1) {
      svg += '<rect x="' + (pp[0].x - 22) + '" y="' + (pp[0].y + 14) + '" width="44" height="14" rx="4" fill="#16a34a"/>';
      svg += '<text x="' + pp[0].x.toFixed(0) + '" y="' + (pp[0].y + 24).toFixed(0) + '" text-anchor="middle" font-size="9" font-weight="700" fill="#fff">СТАРТ</text>';
      var L = pp[pp.length - 1];
      svg += '<rect x="' + (L.x - 26) + '" y="' + (L.y + 14) + '" width="52" height="14" rx="4" fill="#dc2626"/>';
      svg += '<text x="' + L.x.toFixed(0) + '" y="' + (L.y + 24).toFixed(0) + '" text-anchor="middle" font-size="9" font-weight="700" fill="#fff">ФИНИШ</text>';
    }
    svg += '</svg>';
    document.getElementById('map-canvas').innerHTML = svg;
  }
  function optimizeOrder(pts) {
    if (pts.length < 2) return pts.slice();
    var order = [pts[0]], rem = pts.slice(1), cur = pts[0];
    while (rem.length) {
      var bi = 0, bd = Infinity;
      for (var i = 0; i < rem.length; i++) {
        var d = Math.pow(rem[i].lat - cur.lat, 2) + Math.pow(rem[i].lng - cur.lng, 2);
        if (d < bd) { bd = d; bi = i; }
      }
      cur = rem.splice(bi, 1)[0]; order.push(cur);
    }
    return order;
  }
  function distKm(a, b) {
    var R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
    var la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function routeDistKm(order) { var t = 0; for (var i = 1; i < order.length; i++) t += distKm(order[i - 1], order[i]); return t; }

  function buildYandexRoute() {
    var pts = ymState.pts;
    if (!pts || pts.length < 2) { toast('warn', 'Выберите минимум 2 объекта, чтобы построить маршрут.'); return; }
    var order = optimizeOrder(pts);
    if (!window.ymaps || !ymState.ymap) {
      var dkm = routeDistKm(order);
      drawSVGMap(order, true);
      setRouteInfo({ km: dkm, preview: true, count: order.length });
      toast('warn', 'Маршрут построен по схеме (предпросмотр): ' + order.length + ' точек, ≈ ' + fmtH(dkm) + ' км по прямой. Скачайте файл — Яндекс.Карты построят путь по дорогам.');
      return;
    }
    var map = ymState.ymap;
    map.geoObjects.removeAll();
    var ref = order.map(function (p) { return [p.lat, p.lng]; });
    setRouteInfo({ building: true, count: order.length });
    window.ymaps.route(ref, { routingMode: 'auto', multiRoute: false }).then(function (route) {
      try { route.getWayPoints().options.set('visible', false); } catch (e) {}
      try { route.getViaPoints().options.set('visible', false); } catch (e) {}
      route.getPaths().options.set({ strokeColor: '#2563eb', strokeWidth: 6, opacity: 0.9 });
      map.geoObjects.add(route);
      order.forEach(function (p, i) {
        map.geoObjects.add(new window.ymaps.Placemark([p.lat, p.lng], {
          iconCaption: String(i + 1), balloonContentHeader: p.work,
          balloonContentBody: p.addr + '<br>' + p.master + ' · ' + fmtH(p.hours) + ' ч · ' + p.type + '<br>Точка №' + (i + 1)
        }, { preset: 'islands#circleIcon', iconColor: p.mcol }));
      });
      var km = route.getLength() / 1000, min = Math.round(route.getTime() / 60);
      map.setBounds(map.geoObjects.getBounds(), { checkZoomRange: true, zoomMargin: 40 });
      setRouteInfo({ km: km, min: min, count: order.length });
      toast('ok', '✓ Маршрут построен: ' + order.length + ' точек · ' + fmtH(km) + ' км · ≈ ' + min + ' мин в пути.');
    }, function (err) {
      setRouteInfo({ error: true, count: order.length });
      toast('err', 'Не удалось построить маршрут: ' + (err && err.message ? err.message : 'ошибка сервиса маршрутизации.'));
    });
  }
  function setRouteInfo(info) {
    var el = document.getElementById('route-info'); if (!el) return;
    if (!info) { el.innerHTML = 'Маршрут ещё не построен — нажмите «Построить маршрут»'; el.style.color = 'var(--muted)'; }
    else if (info.building) { el.innerHTML = '⏳ Строю маршрут по дорогам (' + info.count + ' точек)…'; el.style.color = 'var(--blue)'; }
    else if (info.error) { el.innerHTML = '⚠ Ошибка построения маршрута'; el.style.color = 'var(--red)'; }
    else if (info.preview) { el.innerHTML = '📍 Маршрут (' + info.count + ' точек) · длина по прямой ≈ <b>' + fmtH(info.km) + ' км</b> · <span style="color:var(--yellow)">предпросмотр</span>'; el.style.color = 'var(--ink)'; }
    else if (info.km != null) { el.innerHTML = '🚗 Маршрут по дорогам (' + info.count + ' точек) · <b>' + fmtH(info.km) + ' км</b> · в пути <b>≈ ' + info.min + ' мин</b>'; el.style.color = 'var(--green)'; }
  }

  /* =====================================================================
     РЕНДЕР: СПРАВОЧНИКИ
     ===================================================================== */
  function renderRefs() {
    var tab = S.refsTab;
    var html = '<div class="tabs">' + tabBtn('tree', 'Виды работ') + tabBtn('norms', 'Нормы времени') + tabBtn('objects', 'Объекты') + tabBtn('import', 'Импорт из Excel') + '</div>';
    if (tab === 'tree') {
      html += '<div class="card"><div class="card-b"><div class="tree">';
      WORK_TREE.forEach(function (g) {
        html += '<ul style="padding-left:0"><li><div class="grp" data-action="toggle-tree"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>' + esc(g.name) + '</div><ul>';
        g.children.forEach(function (w) { html += '<li class="w"><span style="color:var(--blue)">▪</span><span>' + esc(w.name) + '</span><span class="norm">Норма: <b>' + fmtH(w.norm) + ' ч</b> / ' + esc(w.unit) + '</span></li>'; });
        html += '</ul></li></ul>';
      });
      html += '</div></div></div>';
    } else if (tab === 'norms') {
      html += '<div class="card"><table class="dt"><thead><tr><th>Работа</th><th>Группа</th><th>Норма, ч</th><th>Ед. изм.</th><th>Авто-расчёт</th></tr></thead><tbody>';
      WORK_TREE.forEach(function (g) { g.children.forEach(function (w) { html += '<tr><td><b>' + esc(w.name) + '</b></td><td>' + esc(g.name) + '</td><td>' + fmtH(w.norm) + '</td><td>' + esc(w.unit) + '</td><td>' + (w.unit === 'ЗУ' ? '× кол-во ЗУ' : w.unit === 'км' ? '× км' : '—') + '</td></tr>'; }); });
      html += '</tbody></table></div>';
    } else if (tab === 'objects') {
      html += '<div class="card"><table class="dt"><thead><tr><th>Адрес</th><th>Тип</th><th>Координаты (X, Y)</th><th>ЗУ</th><th>Источник</th></tr></thead><tbody>';
      OBJECTS.forEach(function (o) { html += '<tr><td><b>' + esc(o.addr) + '</b></td><td><span class="chip ' + o.type + '">' + o.type + '</span></td><td style="font-family:monospace">' + o.lat + ', ' + o.lng + '</td><td>' + (o.zu || '—') + '</td><td style="color:var(--muted)">Панорама</td></tr>'; });
      html += '</tbody></table></div>';
    } else {
      html += '<div class="card"><div class="card-b"><div class="imp-box"><div class="ic">📊</div><h3>Загрузка норм из Excel-шаблона</h3><p>Перетащите файл <code>norms.xlsx</code> сюда или нажмите кнопку.<br>Шаблон: <b>Группа | Работа | Норма_ч | Ед_изм</b></p><div style="margin-top:14px"><button class="btn primary" data-action="do-import">' + IC.bolt + ' Загрузить шаблон (демо)</button></div></div></div></div>';
    }
    view.innerHTML = html;
  }
  function tabBtn(t, label) { return '<button class="' + (S.refsTab === t ? 'on' : '') + '" data-action="refs-tab" data-tab="' + t + '">' + label + '</button>'; }

  /* =====================================================================
     РЕНДЕР: ПОЛЬЗОВАТЕЛИ (только администратор)
     ===================================================================== */
  function renderUsers() {
    var users = DB.getUsers();
    var html = '<div class="card"><div class="card-h"><h2>Пользователи системы</h2><span class="sub">' + users.length + ' учётных записей</span><div class="spacer"></div><button class="btn primary" data-action="new-user">' + IC.plus + ' Добавить пользователя</button></div><div class="card-b">';
    html += '<div class="calc" style="margin-bottom:14px">' + IC.warn + ' Раздел доступен только администратору. Роли: <b>Начальник участка</b>, <b>Старший мастер</b>, <b>Мастер</b>. Мастера и старшие мастера автоматически становятся строками в календаре.</div>';
    html += '<table class="dt"><thead><tr><th>ФИО</th><th>Логин</th><th>Роль</th><th>Участок</th><th>Статус</th><th style="text-align:right">Действия</th></tr></thead><tbody>';
    users.forEach(function (u) {
      var me = u.id === S.user.id ? ' <span style="color:var(--green);font-size:11px">(вы)</span>' : '';
      var delBtn = (u.role === 'admin' && DB.countAdmins() <= 1) ? '' : '<button class="btn sm" data-action="del-user" data-uid="' + u.id + '" style="color:var(--red)">Удалить</button>';
      html += '<tr><td><b>' + esc(u.full_name) + '</b>' + me + '</td><td style="font-family:monospace">' + esc(u.login) + '</td><td>' + roleChip(u.role) + '</td><td>' + esc(u.area || '—') + '</td><td>' + (u.active ? '<span class="chip" style="background:#dcfce7;color:#15803d">активен</span>' : '<span class="chip" style="background:#fee2e2;color:#b91c1c">отключён</span>') + '</td><td style="white-space:nowrap;text-align:right"><button class="btn sm" data-action="edit-user" data-uid="' + u.id + '">Изменить</button> <button class="btn sm" data-action="pwd-user" data-uid="' + u.id + '">Пароль</button> ' + delBtn + '</td></tr>';
    });
    html += '</tbody></table></div></div>';
    view.innerHTML = html;
  }
  function openUserModal(mode, uid) {
    S.userModalMode = mode; S.userModalUid = uid;
    var u = mode !== 'new' ? DB.getUser(uid) : null;
    var title = mode === 'new' ? 'Новый пользователь' : mode === 'pwd' ? 'Смена пароля' : 'Редактирование пользователя';
    var h = '<div class="modal-h"><h3>' + title + '</h3><button class="x" data-action="close-modal">×</button></div><div class="modal-b">';
    if (mode === 'pwd') {
      h += '<div class="fld"><label>Пользователь</label><input value="' + esc(u.full_name) + ' (' + esc(u.login) + ')" disabled></div>';
      h += '<div class="fld"><label>Новый пароль</label><input id="um-pass" type="password" placeholder="••••••"></div>';
      h += '<div class="fld"><label>Повторите пароль</label><input id="um-pass2" type="password" placeholder="••••••"></div>';
    } else {
      h += '<div class="fld"><label>ФИО</label><input id="um-name" value="' + (u ? esc(u.full_name) : '') + '" placeholder="Иванов И.И."></div>';
      h += '<div class="fld"><label>Логин</label><input id="um-login" value="' + (u ? esc(u.login) : '') + '" placeholder="ivanov"></div>';
      h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px"><div class="fld"><label>Роль</label><select id="um-role">';
      Object.keys(ROLE_INFO).forEach(function (r) { h += '<option value="' + r + '"' + (u && u.role === r ? ' selected' : '') + '>' + ROLE_INFO[r].label + '</option>'; });
      h += '</select></div><div class="fld"><label>Участок</label><select id="um-area">';
      AREAS.forEach(function (a) { h += '<option value="' + a + '"' + (u && u.area === a ? ' selected' : '') + '>' + a + '</option>'; });
      h += '</select></div></div>';
      if (mode === 'new') h += '<div class="fld"><label>Пароль</label><input id="um-pass" type="password" placeholder="••••••"></div>';
      h += '<div class="fld"><label class="cb"><input type="checkbox" id="um-active" ' + (u ? (u.active ? 'checked' : '') : 'checked') + '> Учётная запись активна</label></div>';
    }
    h += '</div><div class="modal-f"><button class="btn" data-action="close-modal">Отмена</button><button class="btn primary" data-action="save-user">Сохранить</button></div>';
    modal.innerHTML = h; overlay.classList.add('show');
  }
  function saveUser() {
    var mode = S.userModalMode, uid = S.userModalUid;
    function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }
    if (mode === 'pwd') {
      var p = val('um-pass'), p2 = val('um-pass2');
      if (!p) { toast('err', 'Введите новый пароль'); return; }
      if (p !== p2) { toast('err', 'Пароли не совпадают'); return; }
      DB.updateUser(uid, { password: p }).then(function () { overlay.classList.remove('show'); toast('ok', 'Пароль изменён'); refresh(); }, function (e) { toast('err', e.message); });
      return;
    }
    var full_name = val('um-name'), login = val('um-login'), role = val('um-role'), area = val('um-area');
    var active = document.getElementById('um-active') ? document.getElementById('um-active').checked : true;
    if (!full_name || !login) { toast('err', 'Заполните ФИО и логин'); return; }
    var op;
    if (mode === 'new') {
      var pw = val('um-pass');
      if (!pw) { toast('err', 'Укажите пароль'); return; }
      op = DB.addUser({ full_name: full_name, login: login, password: pw, role: role, area: area, active: active });
    } else {
      op = DB.updateUser(uid, { full_name: full_name, login: login, role: role, area: area, active: active });
    }
    op.then(function () {
      overlay.classList.remove('show');
      toast('ok', mode === 'new' ? 'Пользователь добавлен' : 'Пользователь обновлён');
      if (uid === S.user.id) { S.user = DB.getUser(uid); applyUser(); }
      refresh();
    }, function (e) { toast('err', e.message); });
  }
  function delUser(uid) {
    var u = DB.getUser(uid); if (!u) return;
    if (!window.confirm('Удалить пользователя «' + u.full_name + '»?')) return;
    try { DB.deleteUser(uid); toast('ok', 'Пользователь удалён'); refresh(); }
    catch (e) { toast('err', e.message); }
  }

  /* =====================================================================
     РЕНДЕР: ОТЧЁТЫ
     ===================================================================== */
  function renderReports() {
    var html = '<div class="card"><div class="card-h"><h2>Формирование печатных форм</h2><span class="sub">Период: ' + MON[TODAY.getMonth()] + ' ' + TODAY.getFullYear() + '</span><div class="spacer"></div><button class="btn primary" data-action="gen-pdf">' + IC.bolt + ' Сформировать PDF</button></div><div class="card-b">';
    html += '<div class="dash-grid" style="grid-template-columns:1fr 1fr">';
    html += '<div><h3 style="margin:0 0 8px;color:var(--ink)">Отчёт №1. План-график по мастеру</h3><table class="dt"><thead><tr><th>Дата</th><th>Адрес</th><th>Работа</th><th>ч</th></tr></thead><tbody>';
    visibleTasks().filter(function (t) { var d = offToDate(t.d); return d.getMonth() === TODAY.getMonth(); }).slice(0, 9).forEach(function (t) {
      var o = OBJ_MAP[t.o], w = WORK_MAP[t.w];
      html += '<tr><td>' + offToDate(t.d).getDate() + '.' + String(TODAY.getMonth() + 1).padStart(2, '0') + '</td><td>' + esc(o.addr) + '</td><td>' + esc(w.name) + '</td><td>' + fmtH(taskHours(t)) + '</td></tr>';
    });
    html += '</tbody></table></div>';
    html += '<div><h3 style="margin:0 0 8px;color:var(--ink)">Отчёт №2. Анализ выполнения (план/факт)</h3><table class="dt"><thead><tr><th>Участок</th><th>План</th><th>Факт</th><th>%</th></tr></thead><tbody>';
    var areas = {};
    visibleTasks().forEach(function (t) { var d = offToDate(t.d); if (d.getMonth() !== TODAY.getMonth()) return; var m = masterById(t.m); if (!m) return; areas[m.area] = areas[m.area] || { p: 0, f: 0 }; areas[m.area].p++; if (isDone(t)) areas[m.area].f++; });
    Object.keys(areas).forEach(function (a) { var x = areas[a]; html += '<tr><td>' + esc(a) + '</td><td>' + x.p + '</td><td>' + x.f + '</td><td><b>' + (x.p ? Math.round(x.f / x.p * 100) : 0) + '%</b></td></tr>'; });
    html += '</tbody></table><div class="calc" style="margin-top:10px">Все формы имеют строгий «бухгалтерский» вид и готовы к подписи.</div></div>';
    html += '</div></div></div>';
    view.innerHTML = html;
  }

  /* =====================================================================
     МОДАЛ: НОВАЯ ЗАДАЧА
     ===================================================================== */
  function openTaskModal() {
    var masters = visibleMasters();
    var html = '<div class="modal-h"><h3>Внесение плана</h3><button class="x" data-action="close-modal">×</button></div><div class="modal-b">';
    html += '<div class="fld"><label>Объект (умный поиск по адресу)</label><input id="f-obj" list="obj-list" placeholder="Начните вводить адрес…"><datalist id="obj-list">';
    OBJECTS.forEach(function (o) { html += '<option value="' + esc(o.addr) + '">' + esc(o.type) + (o.zu ? ' · ' + o.zu + ' ЗУ' : '') + '</option>'; });
    html += '</datalist></div>';
    html += '<div class="fld"><label>Вид работы</label><select id="f-work">';
    WORK_TREE.forEach(function (g) { g.children.forEach(function (w) { html += '<option value="' + w.id + '">' + esc(g.name) + ' → ' + esc(w.name) + ' (' + fmtH(w.norm) + ' ч/' + esc(w.unit) + ')</option>'; }); });
    html += '</select></div>';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px"><div class="fld"><label>Плановая дата (смещ. дней)</label><input id="f-day" type="number" value="1" min="0"></div>';
    html += '<div class="fld"><label>Дедлайн (через дней)</label><input id="f-dl" type="number" value="7" min="0"></div></div>';
    html += '<div class="fld"><label>Мастер / Бригада</label><select id="f-master">';
    masters.forEach(function (m) { html += '<option value="' + m.id + '">' + esc(m.name) + ' (' + esc(m.area) + ')</option>'; });
    html += '</select></div>';
    html += '<div class="calc" id="f-calc">Выберите объект и работу — система рассчитает трудозатраты автоматически.</div>';
    html += '</div><div class="modal-f"><button class="btn" data-action="close-modal">Отмена</button><button class="btn primary" data-action="save-task">Добавить в план</button></div>';
    modal.innerHTML = html;
    overlay.classList.add('show');
    function recalc() {
      var addr = document.getElementById('f-obj').value;
      var wid = document.getElementById('f-work').value;
      var o = null; for (var i = 0; i < OBJECTS.length; i++) if (OBJECTS[i].addr === addr) { o = OBJECTS[i]; break; }
      var w = WORK_MAP[wid];
      var h = w ? w.norm : 0, note = '';
      if (w && o) {
        if (w.unit === 'ЗУ') { h = w.norm * (o.zu || 1); note = ' · объект имеет ' + (o.zu || 1) + ' ЗУ → ' + fmtH(w.norm) + ' × ' + (o.zu || 1); }
        if (w.unit === 'км') { h = w.norm; note = ' · укажите км при необходимости'; }
      }
      document.getElementById('f-calc').innerHTML = (o && w ? '📏 <b>' + fmtH(h) + ' чел/ч</b>' + note : 'Выберите объект и работу.');
    }
    document.getElementById('f-obj').addEventListener('input', recalc);
    document.getElementById('f-work').addEventListener('change', recalc);
  }
  function saveTask() {
    var addr = document.getElementById('f-obj').value;
    var o = null; for (var i = 0; i < OBJECTS.length; i++) if (OBJECTS[i].addr === addr) { o = OBJECTS[i]; break; }
    var wid = document.getElementById('f-work').value;
    if (!o) { toast('err', 'Выберите существующий объект из списка'); return; }
    var t = { id: 't' + Date.now(), o: o.id, w: wid, m: document.getElementById('f-master').value, d: parseInt(document.getElementById('f-day').value || '1', 10), dl: parseInt(document.getElementById('f-dl').value || '7', 10), s: 'plan', status: 'plan' };
    S.tasks.push(t);
    overlay.classList.remove('show');
    toast('ok', 'Задача добавлена в план: ' + WORK_MAP[wid].name + ' — ' + o.addr + ' (' + fmtH(taskHours(t)) + ' ч)');
    refresh();
  }

  /* ---------- TOAST ---------- */
  function toast(type, msg) {
    var box = document.getElementById('toasts');
    var el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.innerHTML = msg;
    box.appendChild(el);
    setTimeout(function () { el.style.opacity = '0'; el.style.transition = '.3s'; setTimeout(function () { el.remove(); }, 300); }, 4200);
  }

  /* ---------- РОЛИ ---------- */
  function roleLabel() { return (ROLE_INFO[S.role] || { label: S.role }).label; }
  function roleChip(role) { var i = ROLE_INFO[role] || { label: role, cls: '' }; return '<span class="chip ' + i.cls + '">' + i.label + '</span>'; }
  function applyUser() {
    var u = S.user; if (!u) return;
    var info = ROLE_INFO[u.role] || { label: u.role };
    document.getElementById('av').textContent = initials(u.full_name);
    document.getElementById('un').textContent = u.full_name;
    document.getElementById('ur').textContent = info.label + (u.role === 'admin' ? '' : ' · ' + u.area);
    var ua = document.querySelector('a[data-screen="users"]');
    if (ua) ua.style.display = (u.role === 'admin' ? '' : 'none');
    var ob = document.querySelector('button[data-action="optimize"]');
    if (ob) ob.style.display = (canPlan() ? 'inline-flex' : 'none');
  }

  /* ---------- ВХОД / СЕССИЯ ---------- */
  function onLoginSubmit(e) {
    e.preventDefault();
    var login = document.getElementById('li-login').value.trim();
    var pass = document.getElementById('li-pass').value;
    var err = document.getElementById('li-err');
    var btn = document.getElementById('li-btn');
    err.textContent = ''; btn.disabled = true; btn.textContent = 'Вход…';
    DB.authenticate(login, pass).then(function (u) {
      btn.disabled = false; btn.textContent = 'Войти';
      if (u) { DB.setSession(u.id); enterApp(u); }
      else { err.textContent = 'Неверный логин или пароль'; }
    });
  }
  function enterApp(u) {
    S.user = u; S.role = u.role; S.curMaster = u.id;
    document.body.classList.add('logged-in');
    applyUser();
    setScreen('dashboard');
    setTimeout(function () {
      var info = ROLE_INFO[u.role] || { label: u.role };
      toast('ok', 'Добро пожаловать, ' + u.full_name + '! Роль: ' + info.label + (u.role === 'admin' ? ' — доступ ко всем участкам.' : ' · участок ' + u.area + '.'));
    }, 400);
  }
  function showLoginScreen() {
    document.body.classList.remove('logged-in');
    var f = document.getElementById('login-form'); if (f) f.reset();
    var err = document.getElementById('li-err'); if (err) err.textContent = '';
  }

  /* ---------- НАВИГАЦИЯ ---------- */
  function setScreen(name) {
    S.screen = name;
    document.querySelectorAll('#nav a').forEach(function (a) { a.classList.toggle('active', a.dataset.screen === name); });
    document.getElementById('screen-title').textContent = (TITLES[name] || ['', ''])[0];
    document.getElementById('screen-crumb').textContent = (TITLES[name] || ['', ''])[1];
    document.getElementById('sidebar').classList.remove('open');
    refresh();
  }
  function refresh() {
    if (S.screen === 'dashboard') renderDashboard();
    else if (S.screen === 'calendar') renderCalendar();
    else if (S.screen === 'map') renderMap();
    else if (S.screen === 'refs') renderRefs();
    else if (S.screen === 'users') renderUsers();
    else if (S.screen === 'reports') renderReports();
  }

  document.getElementById('nav').addEventListener('click', function (e) {
    var a = e.target.closest('a[data-screen]'); if (!a) return;
    if (a.dataset.screen === 'users' && S.role !== 'admin') { toast('err', 'Доступ только для администратора'); return; }
    setScreen(a.dataset.screen);
  });
  document.getElementById('burger').addEventListener('click', function () { document.getElementById('sidebar').classList.toggle('open'); });
  overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.classList.remove('show'); });

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]'); if (!el) return;
    var a = el.dataset.action;
    if (a === 'cal-mode') { S.calMode = el.dataset.mode; renderCalendar(); }
    else if (a === 'cal-prev') { shiftCal(-1); }
    else if (a === 'cal-next') { shiftCal(1); }
    else if (a === 'cal-today') { S.weekShift = 0; S.monthShift = 0; S.dayShift = 0; renderCalendar(); }
    else if (a === 'new-task') { openTaskModal(); }
    else if (a === 'save-task') { saveTask(); }
    else if (a === 'close-modal') { overlay.classList.remove('show'); }
    else if (a === 'new-user') { openUserModal('new'); }
    else if (a === 'edit-user') { openUserModal('edit', el.dataset.uid); }
    else if (a === 'pwd-user') { openUserModal('pwd', el.dataset.uid); }
    else if (a === 'save-user') { saveUser(); }
    else if (a === 'del-user') { delUser(el.dataset.uid); }
    else if (a === 'logout') { DB.clearSession(); showLoginScreen(); }
    else if (a === 'optimize') { autoSchedule(); }
    else if (a === 'build-route') { buildYandexRoute(); }
    else if (a === 'map-off') { S.mapOff = parseInt(el.dataset.off, 10); renderMap(); }
    else if (a === 'refs-tab') { S.refsTab = el.dataset.tab; renderRefs(); }
    else if (a === 'toggle-tree') { var ul = el.nextElementSibling; if (ul) ul.style.display = (ul.style.display === 'none' ? '' : 'none'); }
    else if (a === 'do-import') { toast('ok', 'Импорт выполнен: загружено 7 норм из norms.xlsx.'); }
    else if (a === 'gen-pdf') { toast('ok', 'PDF сформирован. (В продакшене — генерация на сервере через WeasyPrint/ReportLab.)'); }
  });
  function shiftCal(dir) {
    if (S.calMode === 'week') S.weekShift += dir;
    else if (S.calMode === 'month') S.monthShift += dir;
    else S.dayShift += dir;
    renderCalendar();
  }

  /* ---------- СТАРТ ---------- */
  document.getElementById('login-form').addEventListener('submit', onLoginSubmit);
  DB.ensureSeed().then(function () {
    var u = DB.getSession();
    if (u) enterApp(u); else showLoginScreen();
  }).catch(function (err) {
    console.error('SmartPlan init error:', err);
    showLoginScreen();
  });
})();
