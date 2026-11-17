import { load, save, uid } from './store.js';

let state = load();
let pickTab = 'current';
let openPickForm = null;

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = (n) => String(n).padStart(2, '0');
const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clockOf = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const hhmm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const toMin = (t) => { const [h, m = 0] = t.split(':').map(Number); return h * 60 + m; };
const fmtDur = (min) => `${Math.floor(min / 60)}h ${pad(min % 60)}m`;
const avg = (a, d = 0) => (a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(d) : '—');
const persist = () => save(state);
const IMPORTANCE = ['MUST DO', 'High', 'Medium', 'Low'];

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 1800);
}

// Sleep text like "23:30-7:15 +15-16": "+" marks a nap; the longest block is the main sleep.
function parseSleep(text) {
  return String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => {
      const nap = raw.startsWith('+');
      const m = raw.replace(/^\+/, '').match(/^(\d{1,2}(?::\d{2})?)-(\d{1,2}(?::\d{2})?)$/);
      if (!m) return null;
      const start = toMin(m[1]);
      const end = toMin(m[2]);
      return { start, end, dur: (end - start + 1440) % 1440, nap };
    })
    .filter(Boolean);
}

function sleepSummary(text) {
  const blocks = parseSleep(text);
  if (!blocks.length) return null;
  const total = blocks.reduce((sum, b) => sum + b.dur, 0);
  const main = blocks.reduce((a, b) => (b.dur > a.dur ? b : a));
  return { total, main, naps: blocks.filter((b) => b !== main).length };
}

const todayRec = () => state.days[dateKey()] || {};
const cigsOn = (key) => state.cigs.filter((c) => dateKey(new Date(c.at)) === key).sort((a, b) => a.at.localeCompare(b.at));
const isCurrent = (p, today) => (!p.date || p.date >= today) && (!p.deadline || p.deadline >= today);

function lastDays(n) {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - i);
    return dateKey(d);
  });
}

function weekStats() {
  const keys = lastDays(7);
  const recs = keys.map((k) => state.days[k]).filter(Boolean);
  const nums = (f) => recs.map((r) => r[f]).filter((v) => typeof v === 'number');
  const cigs = keys.reduce((n, k) => n + cigsOn(k).length, 0);
  return { walk: nums('walkingMin'), energy: nums('energy'), cigsPerDay: (cigs / 7).toFixed(1) };
}

const stat = (label, value, sub) => `<div class="stat"><span class="label">${label}</span><strong>${value}</strong><span class="muted">${sub}</span></div>`;
const radio = (name, value, checked) => `<label class="chip"><input type="radio" name="${name}" value="${value}"${checked ? ' checked' : ''}><span>${value}</span></label>`;
const importanceSelect = (name, selected, extra = '') =>
  `<select name="${name}">${IMPORTANCE.map((i) => `<option${i === selected ? ' selected' : ''}>${i}</option>`).join('')}${extra}</select>`;

/* ---------- Today ---------- */

function viewToday() {
  const key = dateKey();
  const today = new Date();
  const r = todayRec();
  const sl = sleepSummary(r.sleep);
  const cigs = cigsOn(key);
  const w = weekStats();
  const first = cigs[0] ? new Date(cigs[0].at) : null;
  let afterWake = '';
  if (first && sl) afterWake = ` · ${fmtDur((first.getHours() * 60 + first.getMinutes() - sl.main.end + 1440) % 1440)} after waking`;
  const gymType = r.gymType || 'none';

  return `
  <header class="page-head">
    <p class="eyebrow">${today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
    <h1>Today</h1>
    <p class="muted">Entry takes under 30 seconds</p>
  </header>
  <div class="stats">
    ${stat('Sleep', sl ? fmtDur(sl.total) : '—', sl ? `main ${hhmm(sl.main.start)} to ${hhmm(sl.main.end)}${sl.naps ? ` · ${sl.naps} nap${sl.naps > 1 ? 's' : ''}` : ''}` : 'not logged yet')}
    ${stat('Cigarettes', cigs.length, first ? `first at ${clockOf(first)}` : 'none yet')}
    ${stat('Walking', r.walkingMin ?? '—', `week avg ${avg(w.walk)} min`)}
    ${stat('Energy', r.energy ? `${r.energy} / 5` : '—', `week avg ${avg(w.energy, 1)}`)}
  </div>
  <section class="card cig">
    <div>
      <h2>Cigarettes</h2>
      <p class="muted">${cigs.length} today · ${w.cigsPerDay} per day this week${afterWake}</p>
    </div>
    <div class="cig-actions">
      <button class="big" type="button" data-act="cig-add">+1 cigarette</button>
      <button class="ghost" type="button" data-act="cig-undo"${cigs.length ? '' : ' disabled'}>Undo last</button>
    </div>
  </section>
  <form class="card" id="log-form">
    <h2>Daily log</h2>
    <label class="field">Sleep
      <input name="sleep" required value="${esc(r.sleep)}" placeholder="23:30-7:15 (nap: +15-16)">
    </label>
    <label class="field">Walking (min)
      <input name="walkingMin" type="number" min="0" required inputmode="numeric" value="${r.walkingMin ?? ''}">
    </label>
    <fieldset class="field">
      <legend>Gym</legend>
      <div class="seg">${['none', 'strength', 'cardio', 'other'].map((t) => radio('gymType', t, gymType === t)).join('')}</div>
      <label class="field inline">Minutes <input name="gymMin" type="number" min="0" inputmode="numeric" value="${r.gymMin ?? ''}"></label>
    </fieldset>
    <fieldset class="field">
      <legend>Energy</legend>
      <div class="seg">${[1, 2, 3, 4, 5].map((n) => radio('energy', n, r.energy === n)).join('')}</div>
    </fieldset>
    <fieldset class="field">
      <legend>Mood (optional)</legend>
      <div class="seg">${[1, 2, 3, 4, 5].map((n) => radio('mood', n, r.mood === n)).join('')}</div>
    </fieldset>
    <label class="field">Note (optional)
      <textarea name="note" rows="2" placeholder="Alcohol goes here">${esc(r.note)}</textarea>
    </label>
    <button class="primary" type="submit">Save today</button>
  </form>`;
}

function saveLog(form) {
  const f = new FormData(form);
  const key = dateKey();
  const prev = state.days[key] || {};
  const num = (v) => (v === null || v === '' ? null : Number(v));
  const gymType = f.get('gymType') || 'none';
  const energy = num(f.get('energy'));
  const sleep = String(f.get('sleep') || '').trim();
  if (!parseSleep(sleep).length) return toast('Check the sleep format, e.g. 23:30-7:15');
  if (energy === null) return toast('Pick an energy level');
  state.days[key] = {
    ...prev,
    sleep,
    walkingMin: num(f.get('walkingMin')),
    gymType,
    gymMin: gymType === 'none' ? null : num(f.get('gymMin')),
    energy,
    mood: num(f.get('mood')),
    note: String(f.get('note') || '').trim(),
    updatedAt: new Date().toISOString(),
  };
  persist();
  toast('Saved');
  render();
}

/* ---------- Tasks ---------- */

const importanceRank = (t) => (t.claudeDecides || !t.importance ? 4 : IMPORTANCE.indexOf(t.importance));
const parseTags = (s) => String(s || '').split(/[\s,]+/).map((t) => t.replace(/^#/, '').trim().toLowerCase()).filter(Boolean);

function taskCard(t) {
  const must = t.importance === 'MUST DO' && !t.claudeDecides;
  const label = t.claudeDecides ? 'Claude decides' : t.importance;
  const tags = (t.tags || []).map((x) => `<span class="tag">#${esc(x)}</span>`).join('');
  const done = t.status === 'done';
  return `<article class="task${must ? ' must' : ''}${done ? ' done' : ''}">
    <div>
      <span class="badge">${esc(label)}</span>
      <h3>${esc(t.title)}</h3>
      ${t.description ? `<p class="muted">${esc(t.description)}</p>` : ''}
      <div class="meta">${t.deadline ? `<span>due ${esc(t.deadline)}</span>` : ''}${tags}</div>
    </div>
    <div class="task-actions">
      <button class="ghost" type="button" data-act="task-toggle" data-id="${t.id}">${done ? 'Reopen' : 'Done'}</button>
      <button class="ghost danger" type="button" data-act="task-delete" data-id="${t.id}">Delete</button>
    </div>
  </article>`;
}

function viewTasks() {
  const open = state.tasks
    .filter((t) => t.status !== 'done')
    .sort((a, b) => importanceRank(a) - importanceRank(b) || (a.deadline || '9999').localeCompare(b.deadline || '9999'));
  const done = state.tasks.filter((t) => t.status === 'done');
  return `
  <header class="page-head">
    <p class="eyebrow">${open.length} open</p>
    <h1>Tasks</h1>
  </header>
  <form class="card" id="task-form">
    <h2>Add task</h2>
    <label class="field">Title <input name="title" required></label>
    <label class="field">Description (optional) <textarea name="description" rows="2"></textarea></label>
    <label class="field">Tags <input name="tags" placeholder="#uni #design #job"></label>
    <div class="row2">
      <label class="field">Importance ${importanceSelect('importance', 'Medium')}</label>
      <label class="field">Deadline <input type="date" name="deadline"></label>
    </div>
    <label class="check"><input type="checkbox" name="claudeDecides"> Claude decides deadline and importance</label>
    <button class="primary" type="submit">Add task</button>
  </form>
  <section class="task-list">${open.map(taskCard).join('') || '<p class="muted">No open tasks.</p>'}</section>
  ${done.length ? `<details class="card"><summary>Done (${done.length})</summary><div class="task-list">${done.map(taskCard).join('')}</div></details>` : ''}`;
}

function addTask(form) {
  const f = new FormData(form);
  const title = String(f.get('title') || '').trim();
  if (!title) return toast('Give the task a title');
  const claudeDecides = f.get('claudeDecides') === 'on';
  const now = new Date().toISOString();
  state.tasks.push({
    id: uid(),
    title,
    description: String(f.get('description') || '').trim(),
    tags: parseTags(f.get('tags')),
    importance: claudeDecides ? null : f.get('importance'),
    deadline: claudeDecides ? '' : String(f.get('deadline') || ''),
    status: 'open',
    sourcePick: null,
    claudeDecides,
    createdAt: now,
    updatedAt: now,
  });
  persist();
  toast('Task added');
  render();
}

/* ---------- Picks ---------- */

function pickCard(p) {
  const saved = p.status === 'saved';
  const meta = [p.source, p.meta, p.date && `on ${p.date}`, p.deadline && `deadline ${p.deadline}`].filter(Boolean).join(' · ');
  const title = p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>` : esc(p.title);
  return `<article class="card pick">
    <span class="kind">${esc(p.kind)}</span>
    <h3>${title}</h3>
    <p class="muted">${esc(meta)}</p>
    ${p.why ? `<p>${esc(p.why)}</p>` : ''}
    <div class="actions">
      <button class="ghost" type="button" data-act="pick-save" data-id="${p.id}">${saved ? 'Unsave' : 'Save'}</button>
      <button class="ghost" type="button" data-act="pick-dismiss" data-id="${p.id}">Dismiss</button>
      <button class="primary small" type="button" data-act="pick-task" data-id="${p.id}">Add to task</button>
    </div>
    ${openPickForm === p.id ? pickTaskForm(p) : ''}
  </article>`;
}

const pickTaskForm = (p) => `<form class="inline-form" data-pick="${p.id}">
    <label class="field">Deadline <input type="date" name="deadline"></label>
    <label class="check"><input type="checkbox" name="deadlineAuto"> Claude decides deadline</label>
    <label class="field">Importance ${importanceSelect('importance', 'Medium', '<option value="auto">Claude decides</option>')}</label>
    <button class="primary small" type="submit">Create task</button>
  </form>`;

function taskFromPick(form, id) {
  const p = state.picks.find((x) => x.id === id);
  if (!p) return;
  const f = new FormData(form);
  const importanceAuto = f.get('importance') === 'auto';
  const deadlineAuto = f.get('deadlineAuto') === 'on';
  const claudeDecides = importanceAuto || deadlineAuto;
  const now = new Date().toISOString();
  state.tasks.push({
    id: uid(),
    title: p.title,
    description: p.why || '',
    tags: [p.kind, ...(claudeDecides ? ['claude-decides'] : [])],
    importance: importanceAuto ? null : f.get('importance'),
    deadline: deadlineAuto ? '' : String(f.get('deadline') || ''),
    status: 'open',
    sourcePick: p.id,
    claudeDecides,
    createdAt: now,
    updatedAt: now,
  });
  openPickForm = null;
  persist();
  toast('Task added');
  render();
}

function viewPicks() {
  const today = dateKey();
  const list = state.picks.filter((p) =>
    pickTab === 'saved' ? p.status === 'saved' : p.status === 'active' && isCurrent(p, today)
  );
  return `
  <header class="page-head">
    <p class="eyebrow">${list.length} shown</p>
    <h1>Picks</h1>
  </header>
  <div class="seg tabs" role="group" aria-label="Picks view">
    <button type="button" data-act="pick-tab" data-tab="current" aria-pressed="${pickTab === 'current'}">Current</button>
    <button type="button" data-act="pick-tab" data-tab="saved" aria-pressed="${pickTab === 'saved'}">Saved</button>
  </div>
  <section class="pick-list">${list.map(pickCard).join('') || '<p class="muted">Nothing here.</p>'}</section>`;
}

function importPicks(form) {
  let data;
  try {
    data = JSON.parse(String(new FormData(form).get('json') || ''));
  } catch {
    return toast('That is not valid JSON');
  }
  const items = Array.isArray(data) ? data : (data && (data.feed || data.picks)) || [];
  if (!Array.isArray(items) || !items.length) return toast('No picks found in that JSON');
  const now = new Date().toISOString();
  for (const raw of items) {
    if (!raw || !raw.title) continue;
    const id = raw.id || uid();
    const pick = {
      id,
      kind: raw.kind || 'paper',
      title: String(raw.title),
      source: raw.source || '',
      meta: raw.meta || '',
      url: /^https?:\/\//.test(raw.url || '') ? raw.url : '',
      why: raw.why || '',
      rank: raw.rank ?? null,
      week: raw.week || '',
      status: raw.status || 'active',
      date: raw.date || '',
      deadline: raw.deadline || '',
      createdAt: raw.createdAt || now,
    };
    const i = state.picks.findIndex((p) => p.id === id);
    if (i >= 0) state.picks[i] = pick;
    else state.picks.push(pick);
  }
  persist();
  toast('Picks imported');
  render();
}

/* ---------- Settings ---------- */

function viewSettings() {
  const s = state.settings;
  return `
  <header class="page-head">
    <p class="eyebrow">On this device</p>
    <h1>Settings</h1>
  </header>
  <form class="card" id="settings-form">
    <h2>Storage</h2>
    <label class="field">Google Sheet ID <input name="sheetId" value="${esc(s.sheetId)}" placeholder="stored on this device only"></label>
    <p class="muted">Google sign-in and sync are not connected yet. Data stays on this device for now.</p>
    <h2>What Claude looks for</h2>
    <label class="field">Profile <textarea name="profile" rows="5">${esc(s.profile)}</textarea></label>
    <p class="muted">Last run: ${esc(s.lastRun || 'never')}</p>
    <button class="primary" type="submit">Save settings</button>
  </form>
  <form class="card" id="import-form">
    <h2>Import picks</h2>
    <p class="muted">Paste the weekly picks JSON. Items with the same id are replaced.</p>
    <label class="field">JSON <textarea name="json" rows="4"></textarea></label>
    <button class="ghost" type="submit">Import</button>
  </form>
  <section class="card">
    <h2>Backup</h2>
    <p class="muted">Download everything as one JSON file.</p>
    <button class="ghost" type="button" data-act="export">Download backup</button>
  </section>`;
}

function saveSettings(form) {
  const f = new FormData(form);
  state.settings = {
    ...state.settings,
    sheetId: String(f.get('sheetId') || '').trim(),
    profile: String(f.get('profile') || '').trim(),
  };
  persist();
  toast('Settings saved');
  render();
}

function exportBackup() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `life-tracker-${dateKey()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- Shell ---------- */

const views = { today: viewToday, tasks: viewTasks, picks: viewPicks, settings: viewSettings };

function render() {
  const hash = location.hash.slice(1);
  const route = views[hash] ? hash : 'today';
  document.querySelectorAll('[data-route]').forEach((a) => {
    const on = a.dataset.route === route;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  $('#view').innerHTML = views[route]();
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const { act, id, tab } = el.dataset;
  if (act === 'export') return exportBackup();
  if (act === 'cig-add') {
    state.cigs.push({ id: uid(), at: new Date().toISOString() });
  } else if (act === 'cig-undo') {
    const today = cigsOn(dateKey());
    if (!today.length) return;
    const last = today[today.length - 1];
    state.cigs = state.cigs.filter((c) => c.id !== last.id);
  } else if (act === 'pick-tab') {
    pickTab = tab;
  } else if (act === 'task-toggle') {
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;
    t.status = t.status === 'done' ? 'open' : 'done';
    t.updatedAt = new Date().toISOString();
  } else if (act === 'task-delete') {
    if (!confirm('Delete this task?')) return;
    state.tasks = state.tasks.filter((x) => x.id !== id);
  } else if (act === 'pick-save' || act === 'pick-dismiss') {
    const p = state.picks.find((x) => x.id === id);
    if (!p) return;
    p.status = act === 'pick-dismiss' ? 'dismissed' : p.status === 'saved' ? 'active' : 'saved';
  } else if (act === 'pick-task') {
    openPickForm = openPickForm === id ? null : id;
  } else {
    return;
  }
  persist();
  render();
});

document.addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  if (form.dataset.pick) return taskFromPick(form, form.dataset.pick);
  const handlers = { 'log-form': saveLog, 'task-form': addTask, 'settings-form': saveSettings, 'import-form': importPicks };
  handlers[form.id]?.(form);
});

window.addEventListener('hashchange', render);
if (!location.hash) location.hash = '#today';
render();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
