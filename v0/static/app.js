// Stride - plain JavaScript, talks to the Go REST API.
// Every API reply carries the SQL that ran, which is shown in the Live SQL drawer.

const FOOD_TYPES = ['Breakfast', 'Grain', 'Protein', 'Dairy', 'Fruit', 'Vegetable', 'Snack', 'Beverage', 'Dessert', 'Fast Food'];
const BURN_TYPES = ['Cardio', 'Strength', 'Flexibility', 'Sports', 'Outdoor'];

const state = {
  role: null, account: null,
  users: [], userId: null, today: null, date: null,
  foods: [], burns: [], foodFilter: 'All', burnFilter: 'All', days: 28,
};
const charts = {};

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kcal = (n) => Math.round(Number(n) || 0).toLocaleString('en-IN');
const canWrite = () => state.role !== 'viewer';
const initials = (name) => String(name || '?').replace(/[^a-zA-Z0-9]/g, ' ').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('') || '?';

// ------------------------------------------------------------------ API
async function api(method, path, body) {
  const res = await fetch('/api/' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (res.status === 401 && path !== 'login') {
    showLogin();
    throw new Error(json.error);
  }
  showSQL(method + ' /api/' + path, json.sql || [], json.error);
  if (json.error) {
    toast(json.error, 'bad');
    throw new Error(json.error);
  }
  return json.data;
}

// ------------------------------------------------------------------ SQL drawer
const drawer = { calls: [], count: 0 };

function highlight(sql) {
  return esc(sql)
    .replace(/(&#39;.*?&#39;)/g, '<span class="s">$1</span>')
    .replace(/\b(SELECT|FROM|WHERE|AND|OR|JOIN|LEFT|ON|GROUP BY|ORDER BY|LIMIT|INSERT INTO|VALUES|UPDATE|SET|DELETE|AS|SUM|COUNT|AVG|ROUND|COALESCE|DISTINCT|DESC|ASC|INTERVAL|DAY|CURDATE|DUPLICATE KEY|OVER|RANK|LAG|POW|TIMESTAMPDIFF|YEAR|DATE_SUB|WEEKDAY|NULL|IN|NOT|IS|CASE|WHEN|THEN|ELSE|END|HAVING|WITH|SHOW|TABLES|DESCRIBE|CREATE|VIEW|DROP|TABLE)\b/g, '<span class="k">$1</span>')
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
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', opts);
}
function mondayOf(iso) {
  const d = new Date(iso + 'T00:00:00');
  return addDays(iso, -((d.getDay() + 6) % 7));
}

// ------------------------------------------------------------------ routing
function route() {
  const view = (location.hash || '#today').slice(1);
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  if (!state.userId && view !== 'athletes' && view !== 'sql') return;
  if (view === 'today') loadToday();
  if (view === 'progress') loadProgress();
  if (view === 'catalogue') loadCatalogue();
  if (view === 'athletes') loadAthletes();
  if (view === 'sql') loadHistory();
}
window.addEventListener('hashchange', route);

// ------------------------------------------------------------------ users
async function loadUsers() {
  state.users = await api('GET', 'users');
  const saved = Number(localStorageGet('stride-user'));
  if (!state.users.some((u) => u.user_id === state.userId)) {
    state.userId = state.users.some((u) => u.user_id === saved) ? saved : state.users[0]?.user_id ?? null;
  }
  $('#user-select').innerHTML = state.users.map((u) =>
    `<option value="${u.user_id}" ${u.user_id === state.userId ? 'selected' : ''}>${esc(u.username)}</option>`).join('');
  const me = currentUser();
  $('#me-avatar').textContent = me ? initials(me.username) : '?';
}
const currentUser = () => state.users.find((u) => u.user_id === state.userId);

function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

$('#user-select').addEventListener('change', (e) => {
  state.userId = Number(e.target.value);
  localStorageSet('stride-user', state.userId);
  $('#me-avatar').textContent = initials(currentUser().username);
  route();
});

// ------------------------------------------------------------------ TODAY
async function loadToday() {
  const me = currentUser();
  $('#ath-avatar').textContent = initials(me.username);
  $('#ath-name').textContent = me.username;
  $('#ath-meta').textContent = [me.age != null ? me.age + ' years' : null, me.user_contact].filter(Boolean).join(', ');

  $('#day-date').value = state.date;
  $('#day-date').max = state.today;
  $('#day-next').disabled = state.date >= state.today;
  $('#day-label').textContent = state.date === state.today ? 'Today' : state.date === addDays(state.today, -1) ? 'Yesterday' : prettyDate(state.date);

  if (!state.foods.length) await loadCatalogLists();
  fillPickers();

  await loadDay();
  loadStats();
  loadStreak();
  loadLeaderboard();
  loadMiniWeight();
}

async function loadCatalogLists() {
  state.foods = await api('GET', 'foods');
  state.burns = await api('GET', 'burns');
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
  const day = await api('GET', `day?user_id=${state.userId}&date=${state.date}`);
  state.day = day;

  const net = Number(day.net_calories);
  $('#bal-net').textContent = (net > 0 ? '+' : '') + kcal(net);
  $('#bal-in').textContent = kcal(day.calories_in);
  $('#bal-out').textContent = kcal(day.calories_out);
  $('#tug-in').style.flexGrow = Number(day.calories_in) || (day.calories_out ? 0 : 1);
  $('#tug-out').style.flexGrow = Number(day.calories_out) || 0;
  $('#food-total').textContent = kcal(day.calories_in) + ' kcal';
  $('#burn-total').textContent = kcal(day.calories_out) + ' kcal';
  $('#bal-note').textContent = !day.daily_id
    ? 'Nothing logged for this day yet. Adding the first food or workout creates the day\'s record.'
    : net < 0
      ? `You burnt ${kcal(-net)} kcal more than you ate.`
      : `You ate ${kcal(net)} kcal more than you burnt.`;

  $('#food-entries').innerHTML = day.foods.length ? day.foods.map((f) => `
    <li>
      <span class="entry-name">${esc(f.name)}<span class="entry-type">${f.food_type}, ${f.calories_per_serving} kcal per serving</span></span>
      <input class="entry-qty" type="number" min="0.25" step="0.25" value="${f.servings}" data-food="${f.food_id}" aria-label="Servings of ${esc(f.name)}" ${canWrite() ? '' : 'disabled'}>
      <span class="entry-kcal">${kcal(f.calories)}</span>
      <button class="x-btn can-write" data-del-food="${f.food_id}" aria-label="Remove ${esc(f.name)}">✕</button>
    </li>`).join('') : '<li class="empty">No meals logged. Pick a food below.</li>';

  $('#burn-entries').innerHTML = day.burns.length ? day.burns.map((b) => `
    <li>
      <span class="entry-name">${esc(b.burn_name)}<span class="entry-type">${b.burn_type}, ${b.calories_per_min} kcal per minute</span></span>
      <input class="entry-qty" type="number" min="1" step="1" value="${b.duration_min}" data-burn="${b.burn_id}" aria-label="Minutes of ${esc(b.burn_name)}" ${canWrite() ? '' : 'disabled'}>
      <span class="entry-kcal">${kcal(b.calories)}</span>
      <button class="x-btn can-write" data-del-burn="${b.burn_id}" aria-label="Remove ${esc(b.burn_name)}">✕</button>
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
  await api('POST', 'day/food', { user_id: state.userId, date: state.date, food_id: f.get('food_id'), servings: f.get('servings') });
  toast('Food added', 'good');
  refreshDay();
});
$('#burn-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  await api('POST', 'day/burn', { user_id: state.userId, date: state.date, burn_id: f.get('burn_id'), duration_min: f.get('duration_min') });
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
  const s = await api('GET', 'stats?user_id=' + state.userId);
  $('#st-days').textContent = s.totals.days_logged;
  $('#st-workouts').textContent = s.totals.workouts;
  $('#st-minutes').textContent = kcal(s.totals.active_minutes);
  const list = (items, label, value, unit) => items.length
    ? items.map((i) => `<li>${esc(i[label])}<span>${i[value]} ${unit}</span></li>`).join('')
    : '<li>Nothing yet</li>';
  $('#top-foods').innerHTML = list(s.top_foods, 'name', 'total_servings', 'serv.');
  $('#top-burns').innerHTML = list(s.top_burns, 'burn_name', 'total_minutes', 'min');
  $('#top-foods').classList.toggle('empty', !s.top_foods.length);
  $('#top-burns').classList.toggle('empty', !s.top_burns.length);
}

async function loadStreak() {
  const rows = await api('GET', `summary?user_id=${state.userId}&days=14`);
  const byDate = Object.fromEntries(rows.map((r) => [r.record_date, r]));
  const max = Math.max(300, ...rows.map((r) => r.calories_out));
  let html = '';
  for (let i = 13; i >= 0; i--) {
    const d = addDays(state.today, -i);
    const r = byDate[d];
    const size = r ? (r.calories_out ? 10 + 18 * (r.calories_out / max) : 10) : 26;
    const cls = !r ? 'none' : r.calories_out ? '' : 'rest';
    const title = r ? `${prettyDate(d)}: ${kcal(r.calories_in)} in, ${kcal(r.calories_out)} out` : `${prettyDate(d)}: no record`;
    html += `<div class="streak-day ${d === state.date ? 'is-today' : ''}" title="${title}">
      <span class="streak-ring ${cls}"><i style="width:${size}px;height:${size}px"></i></span>
      ${new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'narrow' })}</div>`;
  }
  $('#streak').innerHTML = html;
}

async function loadLeaderboard() {
  const rows = await api('GET', 'leaderboard');
  $('#leaderboard').innerHTML = rows.map((r) => `
    <li class="${r.user_id === state.userId ? 'me' : ''}">
      <span class="pos">${r.position}</span>
      <span class="avatar">${esc(initials(r.username))}</span>
      <span class="who">${esc(r.username)}<small>${kcal(r.minutes)} min active</small></span>
      <span class="kcal">${kcal(r.calories_burnt)}</span>
    </li>`).join('');
}

// ------------------------------------------------------------------ charts
const ink = '#7C6E62';
function baseChartOptions() {
  return {
    responsive: true, maintainAspectRatio: false,
    animation: matchMedia('(prefers-reduced-motion: reduce)').matches ? false : { duration: 500 },
    plugins: { legend: { display: false }, tooltip: { backgroundColor: '#26201B', padding: 10, titleFont: { family: 'Barlow', weight: '700' }, bodyFont: { family: 'Barlow' } } },
    scales: {
      x: { grid: { display: false }, ticks: { color: ink, font: { family: 'Barlow' } }, border: { color: '#DCCDBE' } },
      y: { grid: { color: '#F0E8DF' }, ticks: { color: ink, font: { family: 'Barlow' } }, border: { display: false } },
    },
  };
}
function drawChart(id, config) {
  if (!window.Chart) return;
  charts[id]?.destroy();
  charts[id] = new Chart(document.getElementById(id), config);
}

async function loadMiniWeight() {
  const rows = await api('GET', 'weekly?user_id=' + state.userId);
  const opts = baseChartOptions();
  opts.scales.x.display = false;
  drawChart('mini-weight', {
    type: 'line',
    data: {
      labels: rows.map((r) => prettyDate(r.week_start_date, { day: 'numeric', month: 'short' })),
      datasets: [{ data: rows.map((r) => r.weight_kg), borderColor: '#1E7A4C', backgroundColor: 'rgba(124,192,122,.18)', fill: true, tension: .35, pointRadius: 3, pointBackgroundColor: '#1E7A4C' }],
    },
    options: opts,
  });
}

// ------------------------------------------------------------------ PROGRESS
async function loadProgress() {
  document.querySelectorAll('#range-seg button').forEach((b) => b.classList.toggle('on', Number(b.dataset.days) === state.days));
  const rows = await api('GET', `summary?user_id=${state.userId}&days=${state.days}`);
  const opts = baseChartOptions();
  opts.plugins.legend = { display: true, position: 'top', align: 'end', labels: { usePointStyle: true, boxWidth: 8, font: { family: 'Barlow', weight: '600' }, color: '#26201B' } };
  drawChart('chart-balance', {
    data: {
      labels: rows.map((r) => prettyDate(r.record_date, { day: 'numeric', month: 'short' })),
      datasets: [
        { type: 'bar', label: 'Eaten', data: rows.map((r) => r.calories_in), backgroundColor: '#EC5A13', borderRadius: 4, maxBarThickness: 22 },
        { type: 'bar', label: 'Burnt', data: rows.map((r) => r.calories_out), backgroundColor: '#1E7A4C', borderRadius: 4, maxBarThickness: 22 },
        { type: 'line', label: 'Net', data: rows.map((r) => r.net_calories), borderColor: '#F5A524', backgroundColor: '#F5A524', tension: .3, pointRadius: 2 },
      ],
    },
    options: opts,
  });

  const avg = await api('GET', 'weekly-average?user_id=' + state.userId);
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
  const rows = await api('GET', 'weekly?user_id=' + state.userId);
  const form = $('#weekly-form');
  form.week_start_date.value = mondayOf(state.today);
  form.week_start_date.max = state.today;
  if (rows.length) form.height_cm.value = rows[rows.length - 1].height_cm;

  const opts = baseChartOptions();
  drawChart('chart-weight', {
    type: 'line',
    data: {
      labels: rows.map((r) => prettyDate(r.week_start_date, { day: 'numeric', month: 'short' })),
      datasets: [{ label: 'Weight (kg)', data: rows.map((r) => r.weight_kg), borderColor: '#1E7A4C', backgroundColor: 'rgba(124,192,122,.2)', fill: true, tension: .35, pointRadius: 4, pointBackgroundColor: '#1E7A4C' }],
    },
    options: opts,
  });

  $('#weekly-table').innerHTML = `
    <thead><tr><th>Week of</th><th class="num">Height</th><th class="num">Weight</th><th class="num">Change</th><th class="num">BMI</th><th></th></tr></thead>
    <tbody>${rows.slice().reverse().map((r) => {
      const ch = r.change_kg;
      const chText = ch == null ? '—' : (ch > 0 ? '+' : '') + Number(ch).toFixed(2) + ' kg';
      return `<tr><td>${prettyDate(r.week_start_date, { day: 'numeric', month: 'short', year: 'numeric' })}</td>
        <td class="num">${r.height_cm} cm</td><td class="num">${r.weight_kg} kg</td>
        <td class="num ${ch > 0 ? 'up' : ch < 0 ? 'down' : ''}">${chText}</td><td class="num">${Number(r.bmi).toFixed(1)}</td>
        <td><button class="x-btn can-write" data-del-week="${r.week_id}" aria-label="Delete check-in">✕</button></td></tr>`;
    }).join('') || '<tr><td colspan="6">No check-ins yet. Add this week\'s above.</td></tr>'}</tbody>`;
}

$('#weekly-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  await api('POST', 'weekly', { ...f, user_id: state.userId });
  toast('Check-in saved', 'good');
  e.target.weight_kg.value = '';
  loadWeekly();
});
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del-week]');
  if (!b) return;
  await api('DELETE', 'weekly/' + b.dataset.delWeek);
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

  const foods = state.foods.filter((f) => state.foodFilter === 'All' || f.food_type === state.foodFilter);
  $('#food-grid').innerHTML = foods.map((f) => `
    <div class="tile">
      <span class="tile-type">${f.food_type}</span>
      <span class="tile-name">${esc(f.name)}</span>
      <span class="tile-kcal">${f.calories_per_serving} <small>kcal per serving</small></span>
      <span class="tile-foot">Logged ${f.times_logged} times</span>
      <span class="tile-actions admin-only"><button data-edit-food="${f.food_id}">Edit</button><button class="del" data-delete-food="${f.food_id}">Delete</button></span>
    </div>`).join('');

  const burns = state.burns.filter((b) => state.burnFilter === 'All' || b.burn_type === state.burnFilter);
  $('#burn-grid').innerHTML = burns.map((b) => `
    <div class="tile">
      <span class="tile-type">${b.burn_type}</span>
      <span class="tile-name">${esc(b.burn_name)}</span>
      <span class="tile-kcal">${b.calories_per_min} <small>kcal per minute</small></span>
      <span class="tile-foot">Logged ${b.times_logged} times</span>
      <span class="tile-actions admin-only"><button data-edit-burn="${b.burn_id}">Edit</button><button class="del" data-delete-burn="${b.burn_id}">Delete</button></span>
    </div>`).join('');
}

document.querySelectorAll('#cat-seg button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#cat-seg button').forEach((x) => x.classList.toggle('on', x === b));
  $('#cat-food').hidden = b.dataset.cat !== 'food';
  $('#cat-burn').hidden = b.dataset.cat !== 'burn';
}));

// add / edit forms share one handler per catalogue; a hidden id switches to UPDATE
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

// ------------------------------------------------------------------ ATHLETES
async function loadAthletes() {
  await loadUsers();
  $('#user-form [name=dob]').max = state.today;
  $('#athlete-grid').innerHTML = state.users.map((u) => `
    <div class="tile">
      <span class="avatar">${esc(initials(u.username))}</span>
      <div>
        <div class="tile-name">${esc(u.username)}</div>
        <div class="muted small">${[u.age != null ? u.age + ' years' : null, u.user_contact].filter(Boolean).map(esc).join(', ') || 'No details'}</div>
        <div class="muted small">${u.dob ? 'Born ' + prettyDate(u.dob, { day: 'numeric', month: 'long', year: 'numeric' }) : ''}</div>
      </div>
      <span class="tile-actions admin-only"><button data-edit-user="${u.user_id}">Edit</button><button class="del" data-delete-user="${u.user_id}">Delete</button></span>
    </div>`).join('') || '<p class="muted">No athletes yet. Add the first one above.</p>';
}

const userForm = $('#user-form');
userForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(userForm));
  if (data.user_id) await api('PUT', 'users/' + data.user_id, data);
  else {
    const r = await api('POST', 'users', data);
    if (!state.userId) state.userId = r.user_id;
  }
  toast(data.user_id ? 'Athlete updated' : 'Athlete added', 'good');
  userForm.reset();
  loadAthletes();
});
userForm.addEventListener('reset', () => setTimeout(() => {
  userForm.user_id.value = '';
  userForm.querySelector('.btn-ember').textContent = 'Add athlete';
  userForm.querySelector('[type=reset]').hidden = true;
}));

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.editUser) {
    const u = state.users.find((x) => x.user_id == b.dataset.editUser);
    userForm.user_id.value = u.user_id;
    userForm.username.value = u.username;
    userForm.user_contact.value = u.user_contact || '';
    userForm.dob.value = u.dob || '';
    userForm.querySelector('.btn-ember').textContent = 'Save changes';
    userForm.querySelector('[type=reset]').hidden = false;
    userForm.username.focus();
  }
  if (b.dataset.deleteUser) {
    const u = state.users.find((x) => x.user_id == b.dataset.deleteUser);
    if (b.dataset.confirm !== 'yes') {
      b.dataset.confirm = 'yes';
      b.textContent = 'Delete all data?';
      toast(`Deleting ${u.username} also deletes every day and check-in they logged (ON DELETE CASCADE). Click again to confirm.`);
      return;
    }
    await api('DELETE', 'users/' + u.user_id);
    toast(`${u.username} and their logs were deleted`, 'good');
    if (state.userId === u.user_id) state.userId = null;
    loadAthletes();
  }
});

// ------------------------------------------------------------------ SQL playground
const PRESETS = {
  'Daily summary view': 'SELECT * FROM vw_daily_summary ORDER BY record_date DESC LIMIT 15;',
  'Weekly averages': 'SELECT * FROM vw_weekly_average ORDER BY week_start DESC, username;',
  'Ages': 'SELECT * FROM vw_user_profile;',
  'My privileges': 'SHOW GRANTS;',
  'Tables': 'SHOW TABLES;',
  'Describe Daily_Food': 'DESCRIBE Daily_Food;',
  'Top foods overall': `SELECT f.name, f.food_type, SUM(df.servings) AS servings_eaten,
       SUM(df.servings * f.calories_per_serving) AS total_kcal
FROM Daily_Food df JOIN Food f ON f.food_id = df.food_id
GROUP BY f.food_id, f.name, f.food_type
ORDER BY total_kcal DESC LIMIT 10;`,
  'Try a future date': "INSERT INTO Daily_Record (user_id, record_date) VALUES (1, CURDATE() + INTERVAL 1 DAY);",
  'Try negative servings': 'INSERT INTO Daily_Food (daily_id, food_id, servings) VALUES (1, 3, -2);',
  'Try renaming a food': "UPDATE Food SET name = 'Poha (renamed)' WHERE name = 'Poha';",
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
  const res = await fetch('/api/sqllog');
  if (!res.ok) return;
  const rows = await res.json();
  $('#sql-history').innerHTML = (rows || []).slice().reverse().slice(0, 80).map((r) => `
    <div class="history-item"><time>${r.time}<span class="who">${esc(r.account)}</span></time><div><pre class="sql">${highlight(r.query)};</pre>
    ${r.error ? `<div class="err">${esc(r.error)}</div>` : ''}</div></div>`).join('') || '<p class="muted">No queries yet.</p>';
}
$('#log-refresh').addEventListener('click', loadHistory);

// API errors are already shown as a toast
window.addEventListener('unhandledrejection', (e) => e.preventDefault());

// ------------------------------------------------------------------ sign in
const ROLE_NOTES = {
  clerk: 'Clerk: you can log meals, workouts and check-ins. Foods, exercises and athletes are read only for this MySQL account.',
  viewer: 'Viewer: read only. This MySQL account only has SELECT, so any change is refused by MySQL.',
};

function showLogin() {
  $('#login').hidden = false;
  $('#login-form').password.focus();
}

function setAccount(me) {
  state.role = me.role;
  state.account = me.account;
  document.body.dataset.role = me.role;
  $('#role-pill').textContent = me.account;
  $('#sql-account').textContent = me.account;
  $('#role-note').textContent = ROLE_NOTES[me.role] || '';
  $('#role-note').hidden = !ROLE_NOTES[me.role];
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const err = $('#login-error');
  try {
    const me = await api('POST', 'login', f);
    err.hidden = true;
    e.target.password.value = '';
    $('#login').hidden = true;
    toast('Signed in as ' + me.account, 'good');
    boot(me);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('POST', 'logout').catch(() => {});
  delete document.body.dataset.role;
  state.role = null;
  showLogin();
});

// ------------------------------------------------------------------ start
async function boot(me) {
  setAccount(me);
  state.foods = [];
  const t = await api('GET', 'today');
  state.today = t.today;
  state.date = t.today;
  await loadUsers();
  if (!state.userId && !['#athletes', '#sql'].includes(location.hash)) location.hash = '#athletes';
  route();
}

(async function start() {
  renderDrawer();
  const me = await api('GET', 'me').catch(() => null);
  if (me) boot(me);
})();
