// Stride v1 - plain JavaScript front end for the Django REST API.
// Signing in returns two JWTs: a short-lived access token sent as
// "Authorization: Bearer ..." on every call, and a refresh token used to get
// a new access token when the old one expires. Both are kept in localStorage.
// Staff also get the SQL behind each call, shown in the Live SQL drawer.

const FOOD_TYPES = ['Breakfast', 'Grain', 'Protein', 'Dairy', 'Fruit', 'Vegetable', 'Snack', 'Beverage', 'Dessert', 'Fast Food'];
const BURN_TYPES = ['Cardio', 'Strength', 'Flexibility', 'Sports', 'Outdoor'];
const PUBLIC_PATHS = ['login', 'register', 'token/refresh'];
const VIEWS = ['today', 'progress', 'catalogue', 'account', 'sql'];

const state = {
  me: null, today: null, date: null, day: null,
  foods: [], burns: [], foodFilter: 'All', burnFilter: 'All', search: '', days: 28,
};
const charts = {};

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kcal = (n) => Math.round(Number(n) || 0).toLocaleString('en-IN');
const initials = (name) => String(name || '?').replace(/[^a-zA-Z0-9]/g, ' ').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('') || '?';
const isStaff = () => !!state.me?.is_staff;

// ------------------------------------------------------------------ tokens
function store(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } }
function load(k) { try { return localStorage.getItem(k); } catch { return null; } }

const tokens = {
  get access() { return load('stride-access'); },
  get refresh() { return load('stride-refresh'); },
  save(t) { if (t.access) store('stride-access', t.access); if (t.refresh) store('stride-refresh', t.refresh); },
  clear() { store('stride-access', null); store('stride-refresh', null); },
};

let refreshing = null;
async function refreshAccess() {
  if (!tokens.refresh) return false;
  // several calls may expire at once; they share one refresh request
  refreshing ??= fetch('/api/token/refresh', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh: tokens.refresh }),
  }).then(async (res) => {
    if (!res.ok) return false;
    tokens.save((await res.json()).data);
    return true;
  }).catch(() => false).finally(() => { refreshing = null; });
  return refreshing;
}

// ------------------------------------------------------------------ API
async function api(method, path, body, retry = true) {
  const isPublic = PUBLIC_PATHS.includes(path);
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (!isPublic && tokens.access) headers.Authorization = 'Bearer ' + tokens.access;

  let res;
  try {
    res = await fetch('/api/' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    toast('Can\'t reach the Stride server. Is it running?', 'bad');
    throw new Error('offline');
  }
  const json = await res.json().catch(() => ({ error: `Server error (${res.status})` }));

  if (res.status === 401 && !isPublic) {
    if (retry && await refreshAccess()) return api(method, path, body, false);
    signedOut('Your session has ended. Please sign in again.');
    throw new Error(json.error);
  }
  if (json.sql) showSQL(method + ' /api/' + path, json.sql, json.error);
  if (!res.ok) {
    if (!isPublic) toast(json.error, 'bad');
    throw new Error(json.error);
  }
  return json.data;
}

// API errors are already shown as a toast
window.addEventListener('unhandledrejection', (e) => e.preventDefault());

// ------------------------------------------------------------------ SQL drawer (staff)
const drawer = { calls: [], count: 0 };

function highlight(sql) {
  return esc(sql)
    .replace(/(&#39;.*?&#39;)/g, '<span class="s">$1</span>')
    .replace(/\b(SELECT|FROM|WHERE|AND|OR|JOIN|INNER|LEFT|ON|GROUP BY|ORDER BY|LIMIT|INSERT INTO|VALUES|UPDATE|SET|DELETE|AS|SUM|COUNT|AVG|ROUND|COALESCE|DISTINCT|DESC|ASC|INTERVAL|DAY|CURDATE|DUPLICATE KEY|OVER|RANK|LAG|POW|TIMESTAMPDIFF|YEAR|DATE_SUB|WEEKDAY|NULL|IN|NOT|IS|CASE|WHEN|THEN|ELSE|END|HAVING|WITH|SHOW|TABLES|DESCRIBE|CREATE|VIEW|DROP|TABLE)\b/g, '<span class="k">$1</span>')
    .replace(/(^|[\s(,=])(-?\d+(?:\.\d+)?)(?=[\s),;]|$)/g, '$1<span class="n">$2</span>');
}

function showSQL(call, statements, error) {
  if (!statements.length) return;
  drawer.calls.unshift({ call, statements, error });
  drawer.calls = drawer.calls.slice(0, 12);
  drawer.count += statements.length;
  const badge = $('#drawer-count');
  badge.textContent = drawer.count;
  badge.classList.remove('bump'); void badge.offsetWidth; badge.classList.add('bump');
  renderDrawer();
}

function renderDrawer() {
  const body = $('#drawer-body');
  if (!drawer.calls.length) { body.innerHTML = '<p class="empty">Use the app and the SQL behind each action shows up here.</p>'; return; }
  body.innerHTML = drawer.calls.map((c) => `
    <p class="call ${c.error ? 'bad' : ''}">${esc(c.call)}${c.error ? ' — ' + esc(c.error) : ''}</p>
    ${c.statements.map((s) => `<pre class="sql">${highlight(s)};</pre>`).join('')}`).join('');
}

$('#drawer-toggle').addEventListener('click', () => {
  const d = $('#drawer');
  const open = d.dataset.open !== 'true';
  d.dataset.open = open;
  $('#drawer-toggle').setAttribute('aria-expanded', open);
});

let toastTimer;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast ' + kind), kind === 'bad' ? 6000 : 2600);
}

// ------------------------------------------------------------------ dates
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function prettyDate(iso, opts = { weekday: 'long', day: 'numeric', month: 'short' }) {
  return new Date(String(iso).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-GB', opts);
}
function mondayOf(iso) {
  const d = new Date(iso + 'T00:00:00');
  return addDays(iso, -((d.getDay() + 6) % 7));
}

// ------------------------------------------------------------------ routing
// signed out: landing page, #login / #signup open the dialog
// signed in: #today #progress #catalogue #account (#sql for staff)
function route() {
  const hash = (location.hash || '').slice(1);
  if (!state.me) {
    $('#public').hidden = false;
    $('#private').hidden = true;
    const mode = hash === 'login' || hash === 'signup' ? hash : null;
    $('#auth').hidden = !mode;
    if (mode) {
      $('#auth').dataset.mode = mode;
      document.querySelectorAll('.auth-seg a').forEach((a) => a.classList.toggle('on', a.dataset.auth === mode));
      $(`#${mode}-form`).querySelector('input').focus();
    }
    return;
  }
  $('#public').hidden = true;
  $('#auth').hidden = true;
  $('#private').hidden = false;

  let view = VIEWS.includes(hash) ? hash : 'today';
  if (view === 'sql' && !isStaff()) view = 'today';
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  if (view === 'today') loadToday();
  if (view === 'progress') loadProgress();
  if (view === 'catalogue') loadCatalogue();
  if (view === 'account') loadAccount();
  if (view === 'sql') loadHistory();
}
window.addEventListener('hashchange', route);

// coming back to the tab (e.g. from MySQL Workbench) reloads the page's data from
// the database, unless the person is in the middle of filling in a form
window.addEventListener('focus', () => {
  if (state.me && !document.activeElement?.closest('form')) route();
});

// ------------------------------------------------------------------ sign in / sign up
function formError(form, msg) {
  const p = form.querySelector('.form-err');
  p.textContent = msg || '';
  p.hidden = !msg;
}

async function busy(button, fn) {
  button.disabled = true;
  try { return await fn(); } finally { button.disabled = false; }
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const f = Object.fromEntries(new FormData(form));
  try {
    const r = await busy(form.querySelector('button'), () => api('POST', 'login', f));
    formError(form);
    form.reset();
    signedIn(r, 'Welcome back, ' + r.user.username);
  } catch (err) {
    formError(form, err.message);
  }
});

$('#signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const f = Object.fromEntries(new FormData(form));
  if (f.password !== f.password2) return formError(form, 'The two passwords do not match.');
  delete f.password2;
  try {
    const r = await busy(form.querySelector('button'), () => api('POST', 'register', f));
    formError(form);
    form.reset();
    signedIn(r, 'Account created. Welcome to Stride, ' + r.user.username + '!');
  } catch (err) {
    formError(form, err.message);
  }
});

function signedIn(r, message) {
  tokens.save(r);
  history.replaceState(null, '', '#today');  // no hashchange: boot() routes once the date is known
  boot(r.user);
  toast(message, 'good');
}

function signedOut(message) {
  tokens.clear();
  state.me = null;
  Object.assign(state, { foodFilter: 'All', burnFilter: 'All', search: '', days: 28 });
  $('#cat-search').value = '';
  document.body.classList.remove('is-staff');
  Object.values(charts).forEach((c) => c.destroy());
  history.replaceState(null, '', message ? '#login' : location.pathname);
  route();
  if (message) toast(message, 'bad');
}

$('#logout').addEventListener('click', async () => {
  await api('POST', 'logout').catch(() => {});
  signedOut();
  toast('Signed out', 'good');
});

// ------------------------------------------------------------------ start
function setMe(me) {
  state.me = me;
  document.body.classList.toggle('is-staff', me.is_staff);
  $('#me-avatar').textContent = initials(me.username);
  $('#me-name').textContent = me.username;
}

async function boot(me) {
  setMe(me);
  state.foods = [];
  const t = await api('GET', 'today');
  state.today = t.today;
  state.date = t.today;
  route();
}

(async function start() {
  renderDrawer();
  $('#signup-form [name=dob]').max = new Date().toISOString().slice(0, 10);
  if (!tokens.access && !tokens.refresh) return route();
  const me = await api('GET', 'me').catch(() => null);
  if (me) boot(me); else route();
})();

// ------------------------------------------------------------------ TODAY
async function loadToday() {
  setMe(await api('GET', 'me'));  // fresh from Users, so edits made in the database show here
  const me = state.me;
  $('#ath-avatar').textContent = initials(me.username);
  $('#ath-name').textContent = me.username;
  $('#ath-meta').textContent = [me.age != null ? me.age + ' years' : null, me.user_contact].filter(Boolean).join(', ') || 'Member since ' + prettyDate(me.date_joined, { month: 'long', year: 'numeric' });

  $('#day-date').value = state.date;
  $('#day-date').max = state.today;
  $('#day-next').disabled = state.date >= state.today;
  $('#day-label').textContent = state.date === state.today ? 'Today' : state.date === addDays(state.today, -1) ? 'Yesterday' : prettyDate(state.date);

  await loadCatalogLists();  // every time, so foods added in the database show up here too
  fillPickers();

  await loadDay();
  loadStats();
  loadStreak();
  loadLeaderboard();
  loadMiniWeight();
}

async function loadCatalogLists() {
  [state.foods, state.burns] = await Promise.all([api('GET', 'foods'), api('GET', 'burns')]);
}

function fillPickers() {
  const group = (items, typeKey, idKey, label, unit, types) => types.map((t) => {
    const list = items.filter((i) => i[typeKey] === t);
    return list.length ? `<optgroup label="${t}">${list.map((i) =>
      `<option value="${i[idKey]}">${esc(i[label])} (${i[unit]} kcal)</option>`).join('')}</optgroup>` : '';
  }).join('');
  $('#food-form [name=food_id]').innerHTML = group(state.foods, 'food_type', 'food_id', 'name', 'calories_per_serving', FOOD_TYPES);
  $('#burn-form [name=burn_id]').innerHTML = group(state.burns, 'burn_type', 'burn_id', 'burn_name', 'calories_per_min', BURN_TYPES);
}

async function loadDay() {
  const day = await api('GET', 'day?date=' + state.date);
  state.day = day;

  const net = Number(day.net_calories);
  $('#bal-net').textContent = (net > 0 ? '+' : '') + kcal(net);
  $('#bal-in').textContent = kcal(day.calories_in);
  $('#bal-out').textContent = kcal(day.calories_out);
  // the longer lane runs the full width, the other in proportion
  const longest = Math.max(Number(day.calories_in), Number(day.calories_out), 1);
  $('#tug-in').style.setProperty('--w', (100 * day.calories_in / longest) + '%');
  $('#tug-out').style.setProperty('--w', (100 * day.calories_out / longest) + '%');
  $('#food-total').textContent = kcal(day.calories_in) + ' kcal';
  $('#burn-total').textContent = kcal(day.calories_out) + ' kcal';
  $('#bal-note').textContent = !day.daily_id
    ? 'Nothing logged on this day yet. Add a meal or a workout below.'
    : net < 0
      ? `You burnt ${kcal(-net)} kcal more than you ate.`
      : `You ate ${kcal(net)} kcal more than you burnt.`;

  $('#food-entries').innerHTML = day.foods.length ? day.foods.map((f) => `
    <li>
      <span class="entry-name">${esc(f.name)}<span class="entry-type">${f.food_type}, ${f.calories_per_serving} kcal per serving</span></span>
      <input class="entry-qty" type="number" min="0.25" step="0.25" value="${f.servings}" data-food="${f.food_id}" aria-label="Servings of ${esc(f.name)}">
      <span class="entry-kcal">${kcal(f.calories)}</span>
      <button class="x-btn" data-del-food="${f.food_id}" aria-label="Remove ${esc(f.name)}">✕</button>
    </li>`).join('') : '<li class="empty">No meals logged. Pick a food below.</li>';

  $('#burn-entries').innerHTML = day.burns.length ? day.burns.map((b) => `
    <li>
      <span class="entry-name">${esc(b.burn_name)}<span class="entry-type">${b.burn_type}, ${b.calories_per_min} kcal per minute</span></span>
      <input class="entry-qty" type="number" min="1" step="1" value="${b.duration_min}" data-burn="${b.burn_id}" aria-label="Minutes of ${esc(b.burn_name)}">
      <span class="entry-kcal">${kcal(b.calories)}</span>
      <button class="x-btn" data-del-burn="${b.burn_id}" aria-label="Remove ${esc(b.burn_name)}">✕</button>
    </li>`).join('') : '<li class="empty">No workouts yet. Rest days count too.</li>';
}

async function refreshDay() {
  await loadDay();
  loadStats();
  loadStreak();
  loadLeaderboard();
}

$('#food-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  await api('POST', 'day/food', { date: state.date, food_id: f.get('food_id'), servings: f.get('servings') });
  toast('Meal added', 'good');
  refreshDay();
});
$('#burn-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  await api('POST', 'day/burn', { date: state.date, burn_id: f.get('burn_id'), duration_min: f.get('duration_min') });
  toast('Workout added', 'good');
  refreshDay();
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset.food) {
    await api('PUT', 'day/food', { daily_id: state.day.daily_id, food_id: t.dataset.food, servings: t.value }).catch(() => {});
    refreshDay();
  }
  if (t.dataset.burn) {
    await api('PUT', 'day/burn', { daily_id: state.day.daily_id, burn_id: t.dataset.burn, duration_min: t.value }).catch(() => {});
    refreshDay();
  }
});

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.delFood) {
    await api('DELETE', `day/food?daily_id=${state.day.daily_id}&food_id=${t.dataset.delFood}`);
    refreshDay();
  }
  if (t.dataset.delBurn) {
    await api('DELETE', `day/burn?daily_id=${state.day.daily_id}&burn_id=${t.dataset.delBurn}`);
    refreshDay();
  }
});

function goDay(iso) {
  if (!iso || iso > state.today) return;
  state.date = iso;
  loadToday();
}
$('#day-prev').addEventListener('click', () => goDay(addDays(state.date, -1)));
$('#day-next').addEventListener('click', () => goDay(addDays(state.date, 1)));
$('#day-date').addEventListener('change', (e) => goDay(e.target.value));

async function loadStats() {
  const s = await api('GET', 'stats');
  $('#st-days').textContent = s.totals.days_logged;
  $('#st-workouts').textContent = s.totals.workouts;
  $('#st-minutes').textContent = kcal(s.totals.active_minutes);
  const list = (items, label, value, unit) => items.length
    ? items.map((i) => `<li>${esc(i[label])}<span>${Number(i[value])} ${unit}</span></li>`).join('')
    : '<li>Nothing yet</li>';
  $('#top-foods').innerHTML = list(s.top_foods, 'name', 'total_servings', 'serv.');
  $('#top-burns').innerHTML = list(s.top_burns, 'burn_name', 'total_minutes', 'min');
  $('#top-foods').classList.toggle('empty', !s.top_foods.length);
  $('#top-burns').classList.toggle('empty', !s.top_burns.length);
}

async function loadStreak() {
  const rows = await api('GET', 'summary?days=14');
  const byDate = Object.fromEntries(rows.map((r) => [r.record_date, r]));
  const max = Math.max(300, ...rows.map((r) => r.calories_out));
  let html = '';
  for (let i = 13; i >= 0; i--) {
    const d = addDays(state.today, -i);
    const r = byDate[d];
    const size = r ? (r.calories_out ? 10 + 18 * (r.calories_out / max) : 10) : 26;
    const cls = !r ? 'none' : r.calories_out ? '' : 'rest';
    const title = r ? `${prettyDate(d)}: ${kcal(r.calories_in)} in, ${kcal(r.calories_out)} out` : `${prettyDate(d)}: nothing logged`;
    html += `<div class="streak-day ${d === state.date ? 'is-today' : ''}" title="${title}">
      <span class="streak-ring ${cls}"><i style="width:${size}px;height:${size}px"></i></span>
      ${new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'narrow' })}</div>`;
  }
  $('#streak').innerHTML = html;
}

async function loadLeaderboard() {
  const rows = await api('GET', 'leaderboard');
  $('#leaderboard').innerHTML = rows.map((r) => `
    <li class="${r.user_id === state.me.user_id ? 'me' : ''}">
      <span class="pos">${r.position}</span>
      <span class="avatar">${esc(initials(r.username))}</span>
      <span class="who">${esc(r.username)}${r.user_id === state.me.user_id ? ' (you)' : ''}<small>${kcal(r.minutes)} min active</small></span>
      <span class="kcal">${kcal(r.calories_burnt)}</span>
    </li>`).join('') || '<li class="muted">No athletes yet.</li>';
}

// ------------------------------------------------------------------ charts
const ink = '#7A6555';
const C = { food: '#D4A017', move: '#9C4221', ink: '#4A3326', grid: '#F0E3D0', axis: '#D9C3A5' };
function baseChartOptions() {
  return {
    responsive: true, maintainAspectRatio: false,
    animation: matchMedia('(prefers-reduced-motion: reduce)').matches ? false : { duration: 500 },
    plugins: { legend: { display: false }, tooltip: { backgroundColor: C.ink, padding: 10, titleFont: { family: 'Archivo', weight: '700' }, bodyFont: { family: 'Archivo' } } },
    scales: {
      x: { grid: { display: false }, ticks: { color: ink, font: { family: 'Archivo' } }, border: { color: C.axis } },
      y: { grid: { color: C.grid }, ticks: { color: ink, font: { family: 'Archivo' } }, border: { display: false } },
    },
  };
}
function drawChart(id, config) {
  if (!window.Chart) return;
  charts[id]?.destroy();
  charts[id] = new Chart(document.getElementById(id), config);
}

async function loadMiniWeight() {
  const rows = await api('GET', 'weekly');
  $('#mini-weight-empty').hidden = rows.length > 0;
  $('#mini-weight').parentElement.hidden = !rows.length;
  const opts = baseChartOptions();
  opts.scales.x.display = false;
  drawChart('mini-weight', {
    type: 'line',
    data: {
      labels: rows.map((r) => prettyDate(r.week_start_date, { day: 'numeric', month: 'short' })),
      datasets: [{ data: rows.map((r) => r.weight_kg), borderColor: C.move, backgroundColor: 'rgba(156,66,33,.12)', fill: true, tension: .35, pointRadius: 3, pointBackgroundColor: C.move }],
    },
    options: opts,
  });
}

// ------------------------------------------------------------------ PROGRESS
async function loadProgress() {
  document.querySelectorAll('#range-seg button').forEach((b) => b.classList.toggle('on', Number(b.dataset.days) === state.days));
  const rows = await api('GET', 'summary?days=' + state.days);
  const opts = baseChartOptions();
  opts.plugins.legend = { display: true, position: 'top', align: 'end', labels: { usePointStyle: true, boxWidth: 8, font: { family: 'Archivo', weight: '600' }, color: C.ink } };
  drawChart('chart-balance', {
    data: {
      labels: rows.map((r) => prettyDate(r.record_date, { day: 'numeric', month: 'short' })),
      datasets: [
        { type: 'bar', label: 'Eaten', data: rows.map((r) => r.calories_in), backgroundColor: C.food, borderRadius: 3, maxBarThickness: 22 },
        { type: 'bar', label: 'Burnt', data: rows.map((r) => r.calories_out), backgroundColor: C.move, borderRadius: 3, maxBarThickness: 22 },
        { type: 'line', label: 'Net', data: rows.map((r) => r.net_calories), borderColor: C.ink, backgroundColor: C.ink, borderWidth: 2, tension: .3, pointRadius: 2 },
      ],
    },
    options: opts,
  });

  const avg = await api('GET', 'weekly-average');
  $('#weekly-avg-table').innerHTML = `
    <thead><tr><th>Week of</th><th class="num">Days</th><th class="num">Avg in</th><th class="num">Avg out</th><th class="num">Avg net</th></tr></thead>
    <tbody>${avg.map((r) => `<tr><td>${prettyDate(r.week_start, { day: 'numeric', month: 'short', year: 'numeric' })}</td>
      <td class="num">${r.days_logged}</td><td class="num">${kcal(r.avg_in)}</td><td class="num">${kcal(r.avg_out)}</td>
      <td class="num">${kcal(r.avg_net)}</td></tr>`).join('') || '<tr><td colspan="5">No days logged yet.</td></tr>'}</tbody>`;

  await loadWeekly();
}

document.querySelectorAll('#range-seg button').forEach((b) => b.addEventListener('click', () => {
  state.days = Number(b.dataset.days);
  loadProgress();
}));

async function loadWeekly() {
  const rows = await api('GET', 'weekly');
  const form = $('#weekly-form');
  form.week_start_date.value = mondayOf(state.today);
  form.week_start_date.max = state.today;
  if (rows.length) form.height_cm.value = rows[rows.length - 1].height_cm;

  drawChart('chart-weight', {
    type: 'line',
    data: {
      labels: rows.map((r) => prettyDate(r.week_start_date, { day: 'numeric', month: 'short' })),
      datasets: [{ label: 'Weight (kg)', data: rows.map((r) => r.weight_kg), borderColor: C.move, backgroundColor: 'rgba(156,66,33,.12)', fill: true, tension: .35, pointRadius: 4, pointBackgroundColor: C.move }],
    },
    options: baseChartOptions(),
  });

  $('#weekly-table').innerHTML = `
    <thead><tr><th>Week of</th><th class="num">Height</th><th class="num">Weight</th><th class="num">Change</th><th class="num">BMI</th><th></th></tr></thead>
    <tbody>${rows.slice().reverse().map((r) => {
      const ch = r.change_kg;
      const chText = ch == null ? '—' : (ch > 0 ? '+' : '') + Number(ch).toFixed(2) + ' kg';
      return `<tr><td>${prettyDate(r.week_start_date, { day: 'numeric', month: 'short', year: 'numeric' })}</td>
        <td class="num">${r.height_cm} cm</td><td class="num">${r.weight_kg} kg</td>
        <td class="num ${ch > 0 ? 'up' : ch < 0 ? 'down' : ''}">${chText}</td><td class="num">${Number(r.bmi).toFixed(1)}</td>
        <td><button class="x-btn" data-del-week="${r.week_id}" aria-label="Delete check-in">✕</button></td></tr>`;
    }).join('') || '<tr><td colspan="6">No check-ins yet. Add this week\'s above.</td></tr>'}</tbody>`;
}

$('#weekly-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  await api('POST', 'weekly', f);
  toast('Check-in saved', 'good');
  e.target.weight_kg.value = '';
  loadWeekly();
});
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del-week]');
  if (!b) return;
  await api('DELETE', 'weekly/' + b.dataset.delWeek);
  toast('Check-in deleted', 'good');
  loadWeekly();
});

// ------------------------------------------------------------------ CATALOGUE
$('#add-food-form [name=food_type]').innerHTML = FOOD_TYPES.map((t) => `<option>${t}</option>`).join('');
$('#add-burn-form [name=burn_type]').innerHTML = BURN_TYPES.map((t) => `<option>${t}</option>`).join('');

async function loadCatalogue() {
  await loadCatalogLists();
  renderCatalogue();
}

function renderCatalogue() {
  const chips = (types, active, key) => ['All', ...types].map((t) =>
    `<button class="chip ${t === active ? 'on' : ''}" data-${key}="${t}">${t}</button>`).join('');
  $('#food-chips').innerHTML = chips(FOOD_TYPES, state.foodFilter, 'food-chip');
  $('#burn-chips').innerHTML = chips(BURN_TYPES, state.burnFilter, 'burn-chip');
  const q = state.search.toLowerCase();
  const staffActions = (kind, id) => `<span class="tile-actions staff-only"><button data-edit-${kind}="${id}">Edit</button><button class="del" data-delete-${kind}="${id}">Delete</button></span>`;

  const foods = state.foods.filter((f) => (state.foodFilter === 'All' || f.food_type === state.foodFilter) && f.name.toLowerCase().includes(q));
  $('#food-grid').innerHTML = foods.map((f) => `
    <div class="tile">
      <span class="tile-type">${f.food_type}</span>
      <span class="tile-name">${esc(f.name)}</span>
      <span class="tile-kcal">${f.calories_per_serving} <small>kcal per serving</small></span>
      <button class="tile-log" data-quick-food="${f.food_id}">Add 1 serving to today</button>
      <span class="tile-foot">Logged ${f.times_logged} times</span>
      ${staffActions('food', f.food_id)}
    </div>`).join('') || '<p class="muted">No foods match.</p>';

  const burns = state.burns.filter((b) => (state.burnFilter === 'All' || b.burn_type === state.burnFilter) && b.burn_name.toLowerCase().includes(q));
  $('#burn-grid').innerHTML = burns.map((b) => `
    <div class="tile">
      <span class="tile-type">${b.burn_type}</span>
      <span class="tile-name">${esc(b.burn_name)}</span>
      <span class="tile-kcal">${b.calories_per_min} <small>kcal per minute</small></span>
      <button class="tile-log" data-quick-burn="${b.burn_id}">Add 30 min to today</button>
      <span class="tile-foot">Logged ${b.times_logged} times</span>
      ${staffActions('burn', b.burn_id)}
    </div>`).join('') || '<p class="muted">No exercises match.</p>';
}

$('#cat-search').addEventListener('input', (e) => { state.search = e.target.value; renderCatalogue(); });

document.querySelectorAll('#cat-seg button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#cat-seg button').forEach((x) => x.classList.toggle('on', x === b));
  $('#cat-food').hidden = b.dataset.cat !== 'food';
  $('#cat-burn').hidden = b.dataset.cat !== 'burn';
}));

// add / edit forms share one handler per catalogue; a hidden id switches to PUT
function catalogueForm(formSel, idName, path, addLabel, noun) {
  const form = $(formSel);
  const submit = form.querySelector('button:not([type=reset])');
  const cancel = form.querySelector('[type=reset]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const id = data[idName];
    if (id) await api('PUT', `${path}/${id}`, data);
    else await api('POST', path, data);
    toast(id ? `${noun} updated` : `${noun} added`, 'good');
    form.reset();
    await loadCatalogue();
    fillPickers();
  });
  form.addEventListener('reset', () => {
    setTimeout(() => { form[idName].value = ''; submit.textContent = addLabel; cancel.hidden = true; });
  });
  return (item) => {
    for (const [k, v] of Object.entries(item)) if (form[k]) form[k].value = v;
    submit.textContent = 'Save changes';
    cancel.hidden = false;
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    form.querySelector('input:not([type=hidden])').focus();
  };
}
const editFood = catalogueForm('#add-food-form', 'food_id', 'foods', 'Add food', 'Food');
const editBurn = catalogueForm('#add-burn-form', 'burn_id', 'burns', 'Add exercise', 'Exercise');

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.foodChip) { state.foodFilter = b.dataset.foodChip; renderCatalogue(); }
  if (b.dataset.burnChip) { state.burnFilter = b.dataset.burnChip; renderCatalogue(); }
  if (b.dataset.quickFood) {
    await api('POST', 'day/food', { date: state.today, food_id: b.dataset.quickFood, servings: 1 });
    toast('Added to today\'s meals', 'good');
    loadCatalogue();
  }
  if (b.dataset.quickBurn) {
    await api('POST', 'day/burn', { date: state.today, burn_id: b.dataset.quickBurn, duration_min: 30 });
    toast('Added to today\'s workouts', 'good');
    loadCatalogue();
  }
  if (b.dataset.editFood) editFood(state.foods.find((f) => f.food_id == b.dataset.editFood));
  if (b.dataset.editBurn) editBurn(state.burns.find((x) => x.burn_id == b.dataset.editBurn));
  if (b.dataset.deleteFood) {
    await api('DELETE', 'foods/' + b.dataset.deleteFood);
    toast('Food deleted', 'good');
    loadCatalogue();
  }
  if (b.dataset.deleteBurn) {
    await api('DELETE', 'burns/' + b.dataset.deleteBurn);
    toast('Exercise deleted', 'good');
    loadCatalogue();
  }
});

// ------------------------------------------------------------------ ACCOUNT
async function loadAccount() {
  const me = await api('GET', 'me');
  setMe(me);
  $('#acc-title').textContent = me.username;
  $('#acc-avatar').textContent = initials(me.username);
  $('#acc-sub').textContent = [
    me.is_staff ? 'Staff account' : 'Member',
    'joined ' + prettyDate(me.date_joined, { day: 'numeric', month: 'long', year: 'numeric' }),
    me.last_login ? 'last sign-in ' + prettyDate(me.last_login, { day: 'numeric', month: 'short' }) + ' at ' + String(me.last_login).slice(11, 16) : null,
  ].filter(Boolean).join(', ');
  const form = $('#profile-form');
  form.username.value = me.username;
  form.user_contact.value = me.user_contact || '';
  form.dob.value = me.dob || '';
  form.dob.max = state.today;
}

$('#profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const me = await api('PUT', 'me', Object.fromEntries(new FormData(e.target)));
  setMe(me);
  toast('Profile saved', 'good');
  loadAccount();
});

$('#password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  if (f.new_password !== f.new_password2) return toast('The two new passwords do not match.', 'bad');
  await api('POST', 'me/password', { current_password: f.current_password, new_password: f.new_password });
  e.target.reset();
  toast('Password changed', 'good');
});

$('#delete-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const b = e.target.querySelector('button');
  if (b.dataset.confirm !== 'yes') {
    b.dataset.confirm = 'yes';
    b.textContent = 'Yes, delete everything';
    return;
  }
  await api('DELETE', 'me', Object.fromEntries(new FormData(e.target))).catch(() => {
    b.dataset.confirm = '';
    b.textContent = 'Delete my account';
    throw new Error('not deleted');
  });
  signedOut();
  toast('Your account and all your logs were deleted', 'good');
});

// ------------------------------------------------------------------ SQL playground (staff)
const PRESETS = {
  'Daily summary view': 'SELECT * FROM vw_daily_summary ORDER BY record_date DESC LIMIT 15;',
  'Weekly averages': 'SELECT * FROM vw_weekly_average ORDER BY week_start DESC, username;',
  'Accounts': 'SELECT user_id, username, is_staff, is_active, date_joined, last_login, LEFT(password, 30) AS password_hash FROM Users;',
  'Food log view': 'SELECT * FROM vw_food_log ORDER BY record_date DESC LIMIT 20;',
  'Tables': 'SHOW FULL TABLES;',
  'Describe Users': 'DESCRIBE Users;',
  'Top foods overall': `SELECT f.name, f.food_type, SUM(df.servings) AS servings_eaten,
       SUM(df.servings * f.calories_per_serving) AS total_kcal
FROM Daily_Food df JOIN Food f ON f.food_id = df.food_id
GROUP BY f.food_id, f.name, f.food_type
ORDER BY total_kcal DESC LIMIT 10;`,
  'Try a future date': 'INSERT INTO Daily_Record (user_id, record_date) VALUES (1, CURDATE() + INTERVAL 1 DAY);',
  'Try negative servings': 'INSERT INTO Daily_Food (daily_id, food_id, servings) VALUES (1, 3, -2);',
  'Try deleting Poha': "DELETE FROM Food WHERE name = 'Poha';",
};
$('#presets').innerHTML = Object.keys(PRESETS).map((k) => `<button data-preset="${esc(k)}">${esc(k)}</button>`).join('');
$('#presets').addEventListener('click', (e) => {
  const k = e.target.dataset.preset;
  if (k) { $('#sql-input').value = PRESETS[k]; runPlayground(); }
});

async function runPlayground() {
  const out = $('#sql-result');
  try {
    const r = await api('POST', 'sql', { query: $('#sql-input').value });
    if (r.columns) {
      out.innerHTML = `<p class="sql-ok">${r.rows.length} row${r.rows.length === 1 ? '' : 's'}</p>
        <div class="table-wrap"><table><thead><tr>${r.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>${r.rows.map((row) => `<tr>${row.map((v) => `<td class="${typeof v === 'number' ? 'num' : ''}">${v === null ? '<span class="muted">NULL</span>' : esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    } else {
      out.innerHTML = `<p class="sql-ok">Done. ${r.rows_affected} row${r.rows_affected === 1 ? '' : 's'} affected.</p>`;
      state.foods = [];
    }
  } catch (err) {
    out.innerHTML = `<p class="sql-err">${esc(err.message)}</p>`;
  }
  loadHistory();
}
$('#sql-run').addEventListener('click', runPlayground);
$('#sql-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) runPlayground(); });

async function loadHistory() {
  const rows = await api('GET', 'sqllog').catch(() => []);
  $('#sql-history').innerHTML = rows.slice().reverse().slice(0, 80).map((r) => `
    <div class="history-item"><time>${r.time}<span class="who">${esc(r.account)}</span></time><div><pre class="sql">${highlight(r.query)};</pre>
    ${r.error ? `<div class="err">${esc(r.error)}</div>` : ''}</div></div>`).join('') || '<p class="muted">No queries yet.</p>';
}
$('#log-refresh').addEventListener('click', loadHistory);
