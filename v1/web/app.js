// Stride v1 - plain JavaScript front end for the Django REST API.
// Signing in returns two JWTs: a short-lived access token sent as
// "Authorization: Bearer ..." on every call, and a refresh token used to get
// a new access token when the old one expires. Both are kept in localStorage.
// Admins also get the SQL behind each call, shown in the Live SQL drawer.

const FOOD_TYPES = ['Breakfast', 'Grain', 'Protein', 'Dairy', 'Fruit', 'Vegetable', 'Snack', 'Beverage', 'Dessert', 'Fast Food'];
const BURN_TYPES = ['Cardio', 'Strength', 'Flexibility', 'Sports', 'Outdoor'];
const PUBLIC_PATHS = ['login', 'register', 'token/refresh'];
const VIEWS = ['today', 'progress', 'catalogue', 'account', 'sql'];

const state = {
  me: null, today: null, date: null, day: null,
  foods: [], burns: [], days: 28,
  // Food & exercise page
  catMode: 'food', catFilter: { food: 'All', burn: 'All' }, pick: { food: null, burn: null }, amount: { food: 1, burn: 30 }, search: '',
  logDate: null, logDay: null,  // the day the Food & exercise page adds to
};
const charts = {};

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kcal = (n) => Math.round(Number(n) || 0).toLocaleString('en-IN');
const initials = (name) => String(name || '?').replace(/[^a-zA-Z0-9]/g, ' ').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('') || '?';
const isAdmin = () => !!state.me?.is_admin;

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

// ------------------------------------------------------------------ SQL drawer (admins)
const drawer = { calls: [] };

const SQL_WORDS = new Set(('SELECT FROM WHERE AND OR NOT JOIN INNER LEFT RIGHT FULL OUTER CROSS ON USING GROUP BY ORDER LIMIT ' +
  'INSERT INTO VALUES UPDATE SET DELETE AS SUM COUNT AVG MIN MAX ROUND COALESCE DISTINCT DESC ASC INTERVAL DAY MONTH ' +
  'CURDATE NOW DUPLICATE KEY OVER PARTITION RANK LAG POW TIMESTAMPDIFF DATEDIFF DATE_ADD DATE_SUB DAYNAME DATE_FORMAT ' +
  'YEAR WEEKDAY NULL IN IS LIKE BETWEEN EXISTS ANY ALL CASE WHEN THEN ELSE END HAVING WITH UNION SHOW TABLES DESCRIBE ' +
  'EXPLAIN CREATE ALTER DROP TRUNCATE RENAME TABLE VIEW TRIGGER BEFORE AFTER EACH ROW BEGIN IF SIGNAL SQLSTATE ' +
  'MESSAGE_TEXT REPLACE ADD COLUMN MODIFY CONSTRAINT PRIMARY FOREIGN REFERENCES CASCADE RESTRICT CHECK UNIQUE DEFAULT ' +
  'START TRANSACTION COMMIT ROLLBACK SAVEPOINT RELEASE TO GRANT REVOKE PRIVILEGES DELIMITER DIV MOD').split(' '));

function highlight(sql) {
  return String(sql).replace(/(--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^'\\]|\\.)*'?)|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_]+)\b|([\s\S])/g,
    (m, comment, str, num, word) => {
      if (comment) return `<span class="c">${esc(comment)}</span>`;
      if (str) return `<span class="s">${esc(str)}</span>`;
      if (num) return `<span class="n">${num}</span>`;
      if (word && SQL_WORDS.has(word.toUpperCase())) return `<span class="k">${word}</span>`;
      return esc(m);
    });
}

// Django's one-line SQL, laid out to read: no backticks, no "Table." in front of
// every column when there is only one table, a new line before each clause
function prettySQL(sql) {
  if (sql.includes('\n')) return sql;  // written by hand, already laid out
  let s = sql.replace(/`/g, '');
  const table = !/\bJOIN\b/i.test(s) && (s.match(/\b(?:FROM|UPDATE|INTO)\s+(\w+)/i) || [])[1];
  if (table) s = s.replace(new RegExp('\\b' + table + '\\.', 'g'), '');
  return s.replace(/(?<!=)\s+(FROM|WHERE|INNER JOIN|LEFT OUTER JOIN|LEFT JOIN|GROUP BY|ORDER BY|HAVING|LIMIT|VALUES|SET|ON DUPLICATE KEY UPDATE)\b/g, '\n$1');
}

// every API call first loads the signed-in user from the token; that lookup is the same each time
const isTokenLookup = (sql) => /^SELECT .* FROM `Users` WHERE `Users`.`user_id` = \d+ LIMIT 21$/.test(sql);

function showSQL(call, statements, error) {
  const shown = statements.filter((s) => !isTokenLookup(s));
  if (!shown.length && !error) return;
  drawer.calls.unshift({ call, statements: shown, error });
  drawer.calls = drawer.calls.slice(0, 8);
  const badge = $('#drawer-count');
  badge.textContent = Number(badge.textContent) + 1;
  badge.classList.remove('bump'); void badge.offsetWidth; badge.classList.add('bump');
  renderDrawer();
}

function renderDrawer() {
  const body = $('#drawer-body');
  if (!drawer.calls.length) { body.innerHTML = '<p class="empty">Use the site and the SQL behind each click shows up here, newest first.</p>'; return; }
  body.innerHTML = drawer.calls.map((c) => `
    <section class="call ${c.error ? 'bad' : ''}">
      <h4>${esc(c.call)}<span>${c.statements.length} quer${c.statements.length === 1 ? 'y' : 'ies'}</span></h4>
      ${c.error ? `<p class="call-err">${esc(c.error)}</p>` : ''}
      ${c.statements.map((s) => `<pre class="sql">${highlight(prettySQL(s))}</pre>`).join('')}
    </section>`).join('');
}

$('#drawer-toggle').addEventListener('click', () => {
  const d = $('#drawer');
  const open = d.dataset.open !== 'true';
  d.dataset.open = open;
  $('#drawer-toggle').setAttribute('aria-expanded', open);
  if (!drawer.calls.length) renderDrawer();
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
  if (view === 'sql' && !isAdmin()) view = 'today';
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  if (view === 'today') loadToday();
  if (view === 'progress') loadProgress();
  if (view === 'catalogue') loadCatalogue();
  if (view === 'account') loadAccount();
  if (view === 'sql') loadInspector();
}
window.addEventListener('hashchange', route);

// coming back to the tab (e.g. from MySQL Workbench) reloads the page's data from
// the database, unless the person is in the middle of filling in a form
window.addEventListener('focus', () => {
  if (state.me && !document.activeElement?.closest('form') && !hasUnsaved()) route();
});

// ------------------------------------------------------------------ sign in / sign up
function formError(form, msg) {
  const p = form.querySelector('.form-err');
  p.textContent = msg || '';
  p.hidden = !msg;
}

async function busy(button, fn) {
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try { return await fn(); } finally { button.disabled = false; button.removeAttribute('aria-busy'); }
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
  Object.assign(state, {
    days: 28, catMode: 'food', catFilter: { food: 'All', burn: 'All' }, pick: { food: null, burn: null }, amount: { food: 1, burn: 30 }, search: '',
    logDate: null, logDay: null,
  });
  $('#cat-search').value = '';
  document.body.classList.remove('is-staff', 'is-admin');
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
  document.body.classList.toggle('is-admin', me.is_admin);
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

  renderEntries('food');
  renderEntries('burn');
}

// the list as saved in the database (also what "Discard" goes back to)
function renderEntries(kind) {
  const day = state.day;
  $(`#${kind}-entries`).innerHTML = kind === 'food'
    ? day.foods.map((f) => entryRow('food', f.food_id, f.servings)).join('') || '<li class="empty">No meals logged. Pick a food below.</li>'
    : day.burns.map((b) => entryRow('burn', b.burn_id, b.duration_min)).join('') || '<li class="empty">No workouts yet. Rest days count too.</li>';
  updateSaveBar(kind);
}

// one row of the Meals / Workouts list; orig is what the database holds (0 = not saved yet)
function entryRow(kind, id, qty, orig = qty) {
  const food = kind === 'food';
  const item = food ? state.foods.find((f) => f.food_id == id) : state.burns.find((b) => b.burn_id == id);
  const name = food ? item.name : item.burn_name;
  const per = Number(food ? item.calories_per_serving : item.calories_per_min);
  return `
    <li class="${Number(orig) ? '' : 'dirty added'}">
      <span class="entry-name">${esc(name)}${Number(orig) ? '' : '<em class="new-tag">not saved</em>'}<span class="entry-type">${food ? item.food_type : item.burn_type}, ${food ? per + ' kcal per serving' : fmt1(per) + ' kcal per minute'}</span></span>
      <input class="entry-qty" type="number" min="${food ? 0.25 : 1}" step="${food ? 0.25 : 1}" value="${Number(qty)}" data-${kind}="${id}" data-orig="${Number(orig)}" data-per="${per}" aria-label="${food ? 'Servings' : 'Minutes'} of ${esc(name)}">
      <span class="entry-kcal">${kcal(qty * per)}</span>
      <button class="x-btn" data-remove="${kind}" aria-label="Remove ${esc(name)}">✕</button>
    </li>`;
}

async function refreshDay() {
  await loadDay();
  loadStats();
  loadStreak();
  loadLeaderboard();
}

// Adding, changing and removing entries only edits the list on screen; "Save changes"
// then writes all of it to the database (INSERT / UPDATE / DELETE per row).
const hasUnsaved = () => !!document.querySelector('.entries li.dirty');

function stageEntry(kind, id, qty) {
  if (!(qty > 0)) return toast(kind === 'food' ? 'Servings must be more than 0' : 'Minutes must be more than 0', 'bad');
  const list = $(`#${kind}-entries`);
  const input = list.querySelector(`.entry-qty[data-${kind}="${id}"]`);
  if (input) {
    // already in the list: add to it (the database adds the same way)
    const li = input.closest('li');
    if (li.classList.contains('removed')) toggleRemoved(li);
    input.value = Number(input.value) + qty;
    markRow(input);
    li.classList.remove('flash'); void li.offsetWidth; li.classList.add('flash');
  } else {
    list.querySelector('.empty')?.remove();
    list.insertAdjacentHTML('beforeend', entryRow(kind, id, qty, 0));
  }
  updateSaveBar(kind);
}
$('#food-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  stageEntry('food', f.get('food_id'), Number(f.get('servings')));
});
$('#burn-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  stageEntry('burn', f.get('burn_id'), Number(f.get('duration_min')));
});

function markRow(input) {
  const li = input.closest('li');
  li.classList.toggle('dirty', li.classList.contains('removed') || Number(input.value) !== Number(input.dataset.orig));
  li.querySelector('.entry-kcal').textContent = kcal(Number(input.value) * Number(input.dataset.per));
}
function toggleRemoved(li) {
  const btn = li.querySelector('[data-remove]');
  const removed = li.classList.toggle('removed');
  li.querySelector('.entry-qty').disabled = removed;
  btn.textContent = removed ? '↺' : '✕';
  btn.setAttribute('aria-label', (removed ? 'Keep ' : 'Remove ') + li.querySelector('.entry-name').firstChild.textContent);
  markRow(li.querySelector('.entry-qty'));
}

document.addEventListener('input', (e) => {
  const t = e.target;
  if (!t.classList.contains('entry-qty')) return;
  markRow(t);
  updateSaveBar(t.dataset.food ? 'food' : 'burn');
});

// always on screen while there are entries: says whether the list matches the database
function updateSaveBar(kind) {
  const bar = $(`.save-bar[data-bar=${kind}]`);
  const dirty = document.querySelectorAll(`#${kind}-entries li.dirty`).length;
  bar.classList.toggle('pending', dirty > 0);
  bar.querySelector('.save-state').textContent = dirty
    ? `${dirty} unsaved ${dirty === 1 ? 'change' : 'changes'}`
    : `All saved. Add, change or remove ${kind === 'food' ? 'meals' : 'workouts'}, then save.`;
  bar.querySelector('[data-save]').disabled = !dirty;
  bar.querySelector('[data-discard]').hidden = !dirty;
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.classList.contains('entry-qty')) return;
  $(`[data-save=${e.target.dataset.food ? 'food' : 'burn'}]`).click();
});

// saves the pending changes of both lists (reloading the day would lose the other list's otherwise)
async function saveEntries() {
  const rows = [...document.querySelectorAll('.entries li.dirty')];
  const bad = rows.find((li) => !li.classList.contains('removed') && !(Number(li.querySelector('.entry-qty').value) > 0));
  if (bad) { bad.querySelector('.entry-qty').focus(); return toast(bad.querySelector('[data-food]') ? 'Servings must be more than 0' : 'Minutes must be more than 0', 'bad'); }
  try {
    for (const li of rows) {
      const kind = li.querySelector('[data-food]') ? 'food' : 'burn';
      const [path, idKey, qtyKey] = kind === 'food' ? ['day/food', 'food_id', 'servings'] : ['day/burn', 'burn_id', 'duration_min'];
      const input = li.querySelector('.entry-qty');
      const id = input.dataset[kind];
      const isNew = Number(input.dataset.orig) === 0;
      if (li.classList.contains('removed')) {
        if (!isNew) await api('DELETE', `${path}?daily_id=${state.day.daily_id}&${idKey}=${id}`);
      } else if (isNew) {
        await api('POST', path, { date: state.date, [idKey]: id, [qtyKey]: input.value });  // creates the day if needed
      } else {
        await api('PUT', path, { daily_id: state.day.daily_id, [idKey]: id, [qtyKey]: input.value });
      }
    }
    toast('Changes saved', 'good');
  } finally {
    refreshDay();
  }
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.save) saveEntries();
  if (t.hasAttribute('data-discard')) renderEntries(t.closest('.save-bar').dataset.bar);
  if (t.dataset.remove) {
    const li = t.closest('li');
    if (li.classList.contains('added')) li.remove();  // never saved: just drop it
    else toggleRemoved(li);
    const list = $(`#${t.dataset.remove}-entries`);
    if (!list.children.length) list.innerHTML = '<li class="empty">Nothing here. Add one below.</li>';
    updateSaveBar(t.dataset.remove);
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
  const since = s.totals.days_since_last_log;
  $('#st-last').textContent = since == null ? 'Nothing logged yet' : since === 0 ? 'Last logged today' : `Last logged ${since} day${since === 1 ? '' : 's'} ago`;
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
  // legend keeps the dataset order (Eaten, Burnt, Net), not the drawing order
  opts.plugins.legend = { display: true, position: 'top', align: 'end', labels: { usePointStyle: true, boxWidth: 8, font: { family: 'Archivo', weight: '600' }, color: C.ink, sort: (a, b) => a.datasetIndex - b.datasetIndex } };
  drawChart('chart-balance', {
    data: {
      labels: rows.map((r) => prettyDate(r.record_date, { day: 'numeric', month: 'short' })),
      datasets: [
        { type: 'bar', label: 'Eaten', data: rows.map((r) => r.calories_in), backgroundColor: C.food, borderRadius: 3, maxBarThickness: 22, order: 2 },
        { type: 'bar', label: 'Burnt', data: rows.map((r) => r.calories_out), backgroundColor: C.move, borderRadius: 3, maxBarThickness: 22, order: 2 },
        // order 1 draws the net line in front of the bars
        { type: 'line', label: 'Net', data: rows.map((r) => r.net_calories), borderColor: C.ink, backgroundColor: C.ink, borderWidth: 2, tension: .3, pointRadius: 2, order: 1 },
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
// A calorie guide rather than a second place to log (Today does that): pick a
// food to see how long each exercise takes to burn it off, or an exercise to
// see what a workout pays for. Admins add, edit and delete items here.
$('#add-food-form [name=food_type]').innerHTML = FOOD_TYPES.map((t) => `<option>${t}</option>`).join('');
$('#add-burn-form [name=burn_type]').innerHTML = BURN_TYPES.map((t) => `<option>${t}</option>`).join('');

const CAT = {
  food: {
    items: () => state.foods, id: 'food_id', name: 'name', type: 'food_type', value: 'calories_per_serving',
    types: FOOD_TYPES, noun: 'food', unit: 'kcal per serving', form: '#add-food-form',
    lede: 'Pick a food to see what it costs and how long it takes to burn off, then add it to your day.',
  },
  burn: {
    items: () => state.burns, id: 'burn_id', name: 'burn_name', type: 'burn_type', value: 'calories_per_min',
    types: BURN_TYPES, noun: 'exercise', unit: 'kcal per minute', form: '#add-burn-form',
    lede: 'Pick an exercise to see how hard it burns and what it pays for, then add it to your day.',
  },
};
const fmt1 = (n) => (Math.round(n * 10) / 10).toLocaleString('en-IN');

async function loadCatalogue() {
  state.logDate ??= state.today;
  await Promise.all([loadCatalogLists(), loadLogDay()]);
  renderCatalogue();
}
async function loadLogDay() {
  state.logDay = await api('GET', 'day?date=' + state.logDate);
}
const logDayName = () => state.logDate === state.today ? 'today' : prettyDate(state.logDate);
// how much of an item the chosen day already has (servings or minutes), or 0
function alreadyLogged(mode, id) {
  const day = state.logDay;
  if (!day) return 0;
  const hit = mode === 'food' ? day.foods.find((f) => f.food_id == id) : day.burns.find((b) => b.burn_id == id);
  return hit ? Number(mode === 'food' ? hit.servings : hit.duration_min) : 0;
}

function renderCatalogue() {
  const mode = state.catMode, c = CAT[mode];
  $('#guide').dataset.mode = mode;
  document.querySelectorAll('#cat-seg button').forEach((x) => x.classList.toggle('on', x.dataset.cat === mode));
  $('#cat-lede').textContent = c.lede;
  $('#cat-search').placeholder = `Search ${c.noun === 'food' ? 'foods' : 'exercises'}`;
  $('#rank-what').textContent = c.noun === 'food' ? 'Food' : 'Exercise';
  $('#rank-unit').textContent = c.unit;
  $('#add-food-form').hidden = mode !== 'food';
  $('#add-burn-form').hidden = mode !== 'burn';
  $('#cat-add').textContent = mode === 'food' ? 'Add a food' : 'Add an exercise';
  formTitle();

  const filter = state.catFilter[mode];
  $('#cat-chips').innerHTML = ['All', ...c.types].map((t) =>
    `<button class="chip ${t === filter ? 'on' : ''}" data-cat-chip="${t}">${t}</button>`).join('');

  const q = state.search.trim().toLowerCase();
  const all = c.items();
  const rows = all
    .filter((i) => (filter === 'All' || i[c.type] === filter) && i[c.name].toLowerCase().includes(q))
    .sort((x, y) => y[c.value] - x[c.value] || x[c.name].localeCompare(y[c.name]));
  if (!all.some((i) => i[c.id] == state.pick[mode])) state.pick[mode] = rows[0]?.[c.id] ?? null;
  const max = Math.max(1, ...all.map((i) => Number(i[c.value])));
  $('#cat-count').textContent = `${rows.length} of ${all.length}`;
  $('#cat-list').innerHTML = rows.map((i) => `
    <li><button class="rank-row ${i[c.id] == state.pick[mode] ? 'on' : ''}" data-pick="${i[c.id]}">
      <span class="rank-name">${esc(i[c.name])}<small>${i[c.type]}${alreadyLogged(mode, i[c.id]) ? `<em class="logged-tag">logged ${logDayName() === 'today' ? 'today' : 'that day'}</em>` : ''}</small></span>
      <span class="rank-bar"><i style="--w:${(100 * i[c.value] / max).toFixed(1)}%"></i></span>
      <b>${fmt1(i[c.value])}</b>
    </button></li>`).join('') || '<li class="empty">Nothing matches. Try another type or search.</li>';
  renderDetail();
}

function renderDetail() {
  const mode = state.catMode, c = CAT[mode];
  const item = c.items().find((i) => i[c.id] == state.pick[mode]);
  if (!item) { $('#cat-detail').innerHTML = '<p class="muted">Pick something from the list.</p>'; return; }
  const food = mode === 'food';
  $('#cat-detail').innerHTML = `
    <span class="detail-type">${item[c.type]}</span>
    <h2>${esc(item[c.name])}</h2>
    <p class="muted">${fmt1(item[c.value])} ${c.unit}. ${item.times_logged ? `Logged ${item.times_logged === 1 ? 'once' : item.times_logged + ' times'} across all athletes.` : 'Nobody has logged it yet.'}</p>
    <form class="log-box" id="cat-log">
      <h3>Add to your log</h3>
      <div class="log-fields">
        <label class="amount">
          <input type="number" id="cat-amount" min="${food ? 0.25 : 1}" step="${food ? 0.25 : 5}" value="${state.amount[mode]}" required aria-label="${food ? 'Servings' : 'Minutes'}">
          <span>${food ? 'serving(s)' : 'minutes'} = <b id="cat-total"></b></span>
        </label>
        <label class="log-day">Day <input type="date" id="cat-day" value="${state.logDate}" max="${state.today}" required></label>
      </div>
      <button class="btn ${food ? 'btn-food' : 'btn-move'} log-go" id="cat-log-btn"></button>
      <p class="log-impact" id="cat-impact"></p>
    </form>
    <h3 class="effects-title">${food ? 'Fastest ways to burn it off' : 'Burns about as much as'}</h3>
    ${food ? `<p class="muted small">Click Log to add one of these workouts to ${logDayName()}.</p>` : ''}
    <ol class="effects ${food ? 'with-log' : ''}" id="cat-effects"></ol>
    <div class="detail-actions admin-only">
      <button class="btn btn-ghost btn-sm" data-edit-${mode}="${item[c.id]}">Edit</button>
      <button class="btn btn-ghost btn-sm del" data-delete-${mode}="${item[c.id]}">Delete</button>
    </div>`;
  renderEffects(item);
}

// the part that changes as the amount is typed (keeps focus in the input)
function renderEffects(item) {
  const mode = state.catMode, c = CAT[mode];
  const amount = Number(state.amount[mode]) || 0;
  const total = Number(item[c.value]) * amount;
  $('#cat-total').textContent = kcal(total) + ' kcal';

  // what adding it does to the chosen day
  const food = mode === 'food';
  const dayName = logDayName();
  const whose = dayName === 'today' ? "today's" : dayName + "'s";
  $('#cat-log-btn').textContent = food
    ? `Add ${fmt1(amount)} serving${amount === 1 ? '' : 's'} to ${whose} meals`
    : `Add ${fmt1(amount)} min to ${whose} workouts`;
  const day = state.logDay || { calories_in: 0, calories_out: 0 };
  const before = Number(food ? day.calories_in : day.calories_out);
  const have = alreadyLogged(mode, item[c.id]);
  $('#cat-impact').innerHTML = `${dayName === 'today' ? 'Today' : 'On ' + dayName} you've ${food ? 'eaten' : 'burnt'} <b>${kcal(before)} kcal</b>. This makes it <b>${kcal(before + total)} kcal</b>.`
    + (have ? ` Already logged: ${fmt1(have)} ${food ? 'serving(s)' : 'min'}, so this adds to it.` : '');
  const rows = mode === 'food'
    ? state.burns.map((b) => ({ id: b.burn_id, name: b.burn_name, type: b.burn_type, v: total / Number(b.calories_per_min), unit: 'min' }))
      .sort((x, y) => x.v - y.v).slice(0, 8)
    // the most logged real meals (a 5 kcal black coffee would dwarf every other bar)
    : state.foods.filter((f) => f.calories_per_serving >= 50).sort((x, y) => y.times_logged - x.times_logged).slice(0, 8)
      .map((f) => ({ name: f.name, type: f.food_type, v: total / Number(f.calories_per_serving), unit: 'serv.' }));
  const max = Math.max(1, ...rows.map((r) => r.v));
  $('#cat-effects').innerHTML = rows.map((r) => `
    <li>
      <span class="rank-name">${esc(r.name)}<small>${r.type}</small></span>
      <span class="rank-bar"><i style="--w:${(100 * r.v / max).toFixed(1)}%"></i></span>
      <b>${r.unit === 'min' ? kcal(r.v) : fmt1(r.v)}<small> ${r.unit}</small></b>
      ${r.id ? `<button class="row-log" data-log-burn="${r.id}" data-min="${Math.max(1, Math.round(r.v))}" aria-label="Log ${Math.max(1, Math.round(r.v))} min of ${esc(r.name)}">Log</button>` : ''}
    </li>`).join('');
}

$('#cat-search').addEventListener('input', (e) => { state.search = e.target.value; renderCatalogue(); });
document.addEventListener('change', async (e) => {
  if (e.target.id !== 'cat-day' || !e.target.value || e.target.value > state.today) return;
  state.logDate = e.target.value;
  await loadLogDay();
  renderCatalogue();
});
document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'cat-log') return;
  e.preventDefault();
  const mode = state.catMode, c = CAT[mode];
  const item = c.items().find((i) => i[c.id] == state.pick[mode]);
  const amount = Number(state.amount[mode]);
  if (!(amount > 0)) return toast(mode === 'food' ? 'Servings must be more than 0' : 'Minutes must be more than 0', 'bad');
  if (mode === 'food') await api('POST', 'day/food', { date: state.logDate, food_id: item.food_id, servings: amount });
  else await api('POST', 'day/burn', { date: state.logDate, burn_id: item.burn_id, duration_min: Math.round(amount) });
  toast(`Added ${fmt1(amount)} ${mode === 'food' ? '×' : 'min of'} ${item[c.name]} to ${logDayName()}`, 'good');
  await loadCatalogue();
});
document.addEventListener('input', (e) => {
  if (e.target.id !== 'cat-amount') return;
  state.amount[state.catMode] = e.target.value;
  const c = CAT[state.catMode];
  renderEffects(c.items().find((i) => i[c.id] == state.pick[state.catMode]));
});

document.querySelectorAll('#cat-seg button').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.cat === state.catMode) return;
  $(CAT[state.catMode].form).reset();
  state.catMode = b.dataset.cat;
  state.search = '';
  $('#cat-search').value = '';
  renderCatalogue();
  const guide = $('#guide');  // replay the fade for the new list
  guide.classList.remove('switched');
  void guide.offsetWidth;
  guide.classList.add('switched');
}));

function formTitle() {
  const c = CAT[state.catMode];
  const editing = $(c.form)[c.id].value;
  $('#cat-form-title').textContent = editing ? `Edit ${c.noun}` : c.noun === 'food' ? 'Add a food' : 'Add an exercise';
}

// add / edit forms share one handler per catalogue; a hidden id switches to PUT
function catalogueForm(formSel, idName, path, addLabel, noun) {
  const form = $(formSel);
  const submit = form.querySelector('button:not([type=reset])');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const id = data[idName];
    const saved = id ? await api('PUT', `${path}/${id}`, data) : await api('POST', path, data);
    toast(id ? `${noun} updated` : `${noun} added`, 'good');
    state.pick[state.catMode] = saved[idName];
    form.reset();
    await loadCatalogue();
    fillPickers();
  });
  form.addEventListener('reset', () => {
    setTimeout(() => { form[idName].value = ''; submit.textContent = addLabel; $('#cat-editor').hidden = true; formTitle(); });
  });
  return (item) => {
    for (const [k, v] of Object.entries(item)) if (form[k]) form[k].value = v;
    submit.textContent = 'Save changes';
    openEditor();
  };
}
function openEditor() {
  $('#cat-editor').hidden = false;
  formTitle();
  $('#cat-editor').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $(CAT[state.catMode].form).querySelector('input:not([type=hidden])').focus();
}
$('#cat-add').addEventListener('click', () => { $(CAT[state.catMode].form).reset(); setTimeout(openEditor); });

const editFood = catalogueForm('#add-food-form', 'food_id', 'foods', 'Add food', 'Food');
const editBurn = catalogueForm('#add-burn-form', 'burn_id', 'burns', 'Add exercise', 'Exercise');

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.logBurn) {
    const burn = state.burns.find((x) => x.burn_id == b.dataset.logBurn);
    await api('POST', 'day/burn', { date: state.logDate, burn_id: burn.burn_id, duration_min: b.dataset.min });
    toast(`Added ${b.dataset.min} min of ${burn.burn_name} to ${logDayName()}`, 'good');
    await loadCatalogue();
  }
  if (b.dataset.catChip) { state.catFilter[state.catMode] = b.dataset.catChip; renderCatalogue(); }
  if (b.dataset.pick) {
    state.pick[state.catMode] = b.dataset.pick;
    renderCatalogue();
    if (matchMedia('(max-width: 1080px)').matches) $('#cat-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  if (b.dataset.editFood) editFood(state.foods.find((f) => f.food_id == b.dataset.editFood));
  if (b.dataset.editBurn) editBurn(state.burns.find((x) => x.burn_id == b.dataset.editBurn));
  if (b.dataset.deleteFood) {
    await api('DELETE', 'foods/' + b.dataset.deleteFood);
    toast('Food deleted', 'good');
    await loadCatalogue();
    fillPickers();
  }
  if (b.dataset.deleteBurn) {
    await api('DELETE', 'burns/' + b.dataset.deleteBurn);
    toast('Exercise deleted', 'good');
    await loadCatalogue();
    fillPickers();
  }
});

// ------------------------------------------------------------------ ACCOUNT
async function loadAccount() {
  const me = await api('GET', 'me');
  setMe(me);
  $('#acc-title').textContent = me.username;
  $('#acc-avatar').textContent = initials(me.username);
  $('#acc-sub').textContent = [
    { admin: 'Admin account', clerk: 'Clerk account' }[me.role] || 'Member',
    'joined ' + prettyDate(me.date_joined, { day: 'numeric', month: 'long', year: 'numeric' }),
    me.last_login ? 'last sign-in ' + prettyDate(me.last_login, { day: 'numeric', month: 'short' }) + ' at ' + String(me.last_login).slice(11, 16) : null,
  ].filter(Boolean).join(', ');
  const form = $('#profile-form');
  form.username.value = me.username;
  form.user_contact.value = me.user_contact || '';
  form.dob.value = me.dob || '';
  form.dob.max = state.today;
  loadStartingBody();
}

// the first weekly check-in, shown read only (new check-ins are added on Progress)
async function loadStartingBody() {
  const weeks = await api('GET', 'weekly');
  const first = weeks[0];
  $('#body-start').hidden = !first;
  if (!first) { $('#body-empty').hidden = false; return; }
  $('#body-empty').hidden = true;
  $('#body-height').textContent = Number(first.height_cm) + ' cm';
  $('#body-weight').textContent = Number(first.weight_kg) + ' kg';
  $('#body-bmi').textContent = first.bmi;
  $('#body-date').textContent = 'From your first check-in, week of ' + prettyDate(first.week_start_date, { day: 'numeric', month: 'long', year: 'numeric' }) + '.';
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

// ------------------------------------------------------------------ SQL page (admins)
// Three tabs: "How it's built" shows the project's own SQL (GET /api/source),
// "Run SQL" runs scripts on their own MySQL connection as stride_app
// (POST /api/sql, examples from db/concepts.sql via GET /api/concepts), and
// "History" lists every statement the API ran. Data itself is edited in the admin panel.
const insp = { tab: 'source', source: null, picked: 0, lessons: null };

function dataTable(columns, rows) {
  return `<div class="table-wrap"><table><thead><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((row) => `<tr>${row.map((v) => `<td class="${typeof v === 'number' ? 'num' : ''}">${v === null ? '<span class="muted">NULL</span>' : esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function loadInspector() {
  showTab(insp.tab);
}

function showTab(tab) {
  insp.tab = tab;
  document.querySelectorAll('#sql-tabs button').forEach((b) => {
    b.classList.toggle('on', b.dataset.tab === tab);
    b.setAttribute('aria-selected', b.dataset.tab === tab);
  });
  document.querySelectorAll('.sql-pane').forEach((p) => (p.hidden = p.id !== 'pane-' + tab));
  if (tab === 'source' && !insp.source) loadSource();
  if (tab === 'run' && !insp.lessons) loadLessons();
  if (tab === 'history') loadHistory();
}
$('#sql-tabs').addEventListener('click', (e) => { if (e.target.dataset.tab) showTab(e.target.dataset.tab); });

// ---- How it's built
async function loadSource() {
  insp.source = await api('GET', 'source').catch(() => null);
  if (!insp.source) return;
  const groups = [...new Set(insp.source.map((i) => i.group))];
  $('#src-list').innerHTML = groups.map((g) => `<h4>${esc(g)}</h4>
    <ul>${insp.source.map((i, n) => i.group === g ? `<li><button data-n="${n}">${esc(i.name)}</button></li>` : '').join('')}</ul>`).join('');
  showSource(insp.picked);
}

function showSource(n) {
  const item = insp.source[n];
  if (!item) return;
  insp.picked = n;
  document.querySelectorAll('#src-list button').forEach((b) => b.classList.toggle('on', Number(b.dataset.n) === n));
  $('#src-view').innerHTML = `
    <div class="src-head">
      <div><h3>${esc(item.name)}</h3><span class="muted small">${esc(item.group)} · <code>${esc(item.file)}</code> line ${item.line}</span></div>
      <div class="acts">
        ${item.try ? `<button class="btn btn-ghost btn-sm" data-try="${n}">Run it</button>` : ''}
        ${item.admin ? `<a class="btn btn-ghost btn-sm" href="${esc(item.admin)}" target="_blank" rel="noopener">Open in admin panel</a>` : ''}
      </div>
    </div>
    <pre class="sql code">${highlight(item.code)}</pre>`;
}

$('#src-list').addEventListener('click', (e) => { if (e.target.dataset.n) showSource(Number(e.target.dataset.n)); });
$('#src-view').addEventListener('click', (e) => {
  const item = insp.source?.[e.target.dataset.try];
  if (!item) return;
  showTab('run');
  $('#sql-input').value = item.try;
  runScript(item.try);
});

// ---- Run SQL
async function loadLessons() {
  insp.lessons = await api('GET', 'concepts').catch(() => null);
  if (!insp.lessons) return;
  const groups = [...new Set(insp.lessons.map((l) => l.group))];
  $('#lesson').innerHTML = '<option value="">Pick an example…</option>' + groups.map((g) => `<optgroup label="${esc(g)}">${
    insp.lessons.map((l, i) => l.group === g ? `<option value="${i}">${esc(l.title)}</option>` : '').join('')}</optgroup>`).join('');
}

$('#lesson').addEventListener('change', (e) => {
  const l = insp.lessons?.[e.target.value];
  if (!l) return;
  $('#sql-input').value = l.sql;
  $('#keep-going').checked = l.keep_going;
  $('#lesson-notes').textContent = l.notes || '';
  $('#sql-result').innerHTML = '';
});

function selectedOrAll() {
  const ta = $('#sql-input');
  const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
  return sel.trim() ? sel : ta.value;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function renderResult(r) {
  const summary = r.error ? 'failed'
    : r.columns ? plural(r.rows.length, 'row') + (r.truncated ? ' (first 500)' : '')
    : r.rows_affected > 0 ? plural(r.rows_affected, 'row') + ' changed' : 'done';
  const tx = r.tx?.open ? `<span class="tx">in transaction${r.tx.savepoints.length ? ', savepoints ' + r.tx.savepoints.map(esc).join(', ') : ''}</span>` : '';
  return `<div class="stmt ${r.error ? 'bad' : ''}">
    <div class="stmt-head"><span class="kind kind-${r.kind}" title="${KIND_NAMES[r.kind] || ''}">${r.kind}</span>
      <b>${summary}</b>${tx}<span class="ms">${r.ms} ms</span></div>
    <pre class="sql">${highlight(r.sql)}</pre>
    ${r.error ? `<p class="stmt-err">${esc(r.error)}</p>` : ''}
    ${r.columns ? dataTable(r.columns, r.rows) : ''}
    ${(r.warnings || []).map((w) => `<p class="warn">${esc(w)}</p>`).join('')}</div>`;
}
const KIND_NAMES = { DDL: 'Data definition', DML: 'Data manipulation', DQL: 'Query', TCL: 'Transaction control', DCL: 'Access control' };

async function runScript(script) {
  const out = $('#sql-result');
  out.innerHTML = '<p class="muted">Running…</p>';
  try {
    const r = await api('POST', 'sql', { script, keep_going: $('#keep-going').checked });
    out.innerHTML = r.results.map(renderResult).join('')
      + (r.notes.length ? `<div class="run-notes">${r.notes.map((n) => `<p>${esc(n)}</p>`).join('')}</div>` : '');
    state.foods = [];
  } catch (err) {
    out.innerHTML = `<p class="sql-err">${esc(err.message)}</p>`;
  }
}

$('#sql-run').addEventListener('click', () => runScript(selectedOrAll()));
$('#sql-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runScript(selectedOrAll()); }
  if (e.key === 'Tab' && !e.shiftKey) {  // indent instead of leaving the box
    e.preventDefault();
    e.target.setRangeText('    ', e.target.selectionStart, e.target.selectionEnd, 'end');
  }
});

// ---- History
async function loadHistory() {
  const rows = await api('GET', 'sqllog').catch(() => []);
  $('#sql-history').innerHTML = rows.slice().reverse().filter((r) => !isTokenLookup(r.query)).slice(0, 80).map((r) => `
    <div class="history-item"><time>${r.time}<span class="who">${esc(r.account)}</span></time>
      <div><pre class="sql">${highlight(prettySQL(r.query))}</pre>${r.error ? `<p class="err">${esc(r.error)}</p>` : ''}</div></div>`).join('')
    || '<p class="muted">No queries yet.</p>';
}
$('#log-refresh').addEventListener('click', loadHistory);
