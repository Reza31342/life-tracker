import { Store, newId } from './store.js';
import {
  APP_TABS, PICK_STATUSES, GYM_TYPES, SchemaError, ms, isDateKey, dayDiff, shiftDay,
  logicalDay, clockAt, minutesAt,
} from './schema.js';
import { getToken, signOut, hasGrant, AuthError } from './auth.js';
import { sheetTitle, SheetsError } from './sheets.js';
import { syncOnce } from './sync.js';

const store = new Store(localStorage);
const ui = { pickTab: 'current', pickKind: 'paper', openPick: null, taskTag: 'all', logSaved: '' };
const PROFILE_KEYS = ['profile_papers', 'profile_podcasts', 'profile_events', 'profile_jobs', 'profile_avoid'];
const PROFILE_LABELS = {
  profile_papers: 'Papers',
  profile_podcasts: 'Podcasts',
  profile_events: 'Events',
  profile_jobs: 'Jobs',
  profile_avoid: 'Avoid',
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = (n) => String(n).padStart(2, '0');
const nowIso = () => new Date().toISOString();
const today = () => logicalDay();
const fmtDur = (m) => `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const fmt = (v, d = 0) => (v == null ? '—' : v.toFixed(d));
const KINDS = [['paper', 'Papers'], ['podcast', 'Podcasts'], ['event', 'Events'], ['job', 'Jobs']];
const kindLabel = (k) => (KINDS.find((x) => x[0] === k) || [k, k])[1];
const IMP = ['MUST DO', 'High', 'Medium', 'Low'];
const IMP_RANK = { 'MUST DO': 0, High: 1, Medium: 2, Low: 3 };

const safeUrl = (u) => { try { const x = new URL(String(u)); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; } };
const parseDay = (s) => { if (!isDateKey(s)) return null; const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const daysTo = (s) => (isDateKey(s) ? dayDiff(today(), s) : null);
const parseTags = (s) => String(s || '').split(/[\s,]+/).map((t) => t.replace(/^#/, '').trim().toLowerCase()).filter(Boolean);
const weekOf = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - y0) / 864e5 + 1) / 7);
};
const wholeNum = (v, min, max) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};
const validSleep = (text) => !text || text.split(/\s+/).every((t) => /^\+?\d{1,2}(:\d{2})?-\d{1,2}(:\d{2})?$/.test(t));

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
}

// All writes go through here: stamp the change, queue it, and sync soon.
function write(tab, rec) {
  store.enqueue(tab, { ...rec, updatedAt: nowIso(), updatedBy: 'app' });
  scheduleSync();
}

const liveTasks = () => store.rows('tasks').filter((t) => !t.deletedAt);
const livePicks = () => store.rows('picks');
const dayMap = () => new Map(store.rows('days').map((d) => [d.date, d]));
const liveCigs = () => store.rows('cigs').filter((c) => !c.deletedAt);
const cigsOn = (key) => liveCigs().filter((c) => c.day === key).sort((a, b) => ms(a.at) - ms(b.at));
const lastDays = (n) => Array.from({ length: n }, (_, i) => shiftDay(today(), i - (n - 1)));

/* ---------- sleep ---------- */

// "23:30-7:15 +15-16": "+" marks a nap; the longest block is the main sleep.
function parseSleep(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).map((raw) => {
    const nap = raw.startsWith('+');
    const m = raw.replace(/^\+/, '').match(/^(\d{1,2}(?::\d{2})?)-(\d{1,2}(?::\d{2})?)$/);
    if (!m) return null;
    const toMin = (t) => { const [h, mm = 0] = t.split(':').map(Number); return h * 60 + mm; };
    const start = toMin(m[1]);
    const end = toMin(m[2]);
    return { start, end, dur: (end - start + 1440) % 1440, nap };
  }).filter(Boolean);
}

function sleepSummary(text) {
  const blocks = parseSleep(text);
  if (!blocks.length) return null;
  const total = blocks.reduce((s, b) => s + b.dur, 0);
  const main = blocks.reduce((a, b) => (b.dur > a.dur ? b : a));
  return { total, main, naps: blocks.filter((b) => b !== main).length };
}

/* ---------- stats ---------- */

function weekStats() {
  const days = dayMap();
  const keys = lastDays(7);
  const recs = keys.map((k) => days.get(k)).filter(Boolean);
  const nums = (f) => recs.map((r) => r[f]).filter((v) => typeof v === 'number');
  const sleepMins = keys.map((k) => sleepSummary(days.get(k)?.sleep)?.total).filter((v) => typeof v === 'number');
  const cigs = keys.reduce((n, k) => n + cigsOn(k).length, 0);
  return {
    energy: mean(nums('energy')),
    walk: mean(nums('walkingMin')),
    sleepH: sleepMins.length ? (mean(sleepMins) / 60).toFixed(1) : '—',
    cigsPerDay: (cigs / 7).toFixed(1),
  };
}

/* ---------- tasks ---------- */

function urgency(t) {
  if (t.status === 'done') return 9;
  const n = daysTo(t.deadline);
  if (n !== null && n < 0) return 0; // overdue
  if (n === 0) return 1; // due today
  if (t.importance === 'MUST DO' && !t.claudeDecides) return 2;
  if (n !== null && n <= 3) return 3; // next three days
  return 4;
}

const sortTasks = (list) => list.slice().sort((a, b) =>
  urgency(a) - urgency(b) ||
  (IMP_RANK[a.importance] ?? 4) - (IMP_RANK[b.importance] ?? 4) ||
  (a.deadline || '9999').localeCompare(b.deadline || '9999') ||
  (a.createdAt || '').localeCompare(b.createdAt || ''));

function dueChip(s) {
  const n = daysTo(s);
  if (n === null) return '';
  const cls = n <= 0 ? 'hot' : n <= 3 ? 'warm' : '';
  const label = n < 0 ? `${-n}d overdue` : n === 0 ? 'today' : n === 1 ? 'tomorrow' : n <= 6 ? `in ${n}d` : parseDay(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return `<span class="due ${cls}">${label}</span>`;
}

function taskRow(t) {
  const done = t.status === 'done';
  const must = !done && t.importance === 'MUST DO' && !t.claudeDecides;
  const overdue = !done && urgency(t) === 0;
  const imp = t.claudeDecides ? 'claude decides' : (t.importance || '');
  const tags = (t.tags || []).map((x) => `<span class="tag">#${esc(x)}</span>`).join('');
  return `<li class="task${done ? ' done' : ''}${must ? ' must' : ''}${overdue ? ' overdue' : ''}">
    <input type="checkbox" data-done="${esc(t.id)}"${done ? ' checked' : ''} aria-label="Done: ${esc(t.title)}">
    <div><div class="ttl">${esc(t.title)}</div>
      <div class="tm">${done ? '' : dueChip(t.deadline)}${tags}${t.claudeDecides ? '<span class="tag claude">claude decides</span>' : ''}</div></div>
    <span class="imp">${esc(imp)}</span>
    <button class="x" type="button" data-del="${esc(t.id)}" aria-label="Delete task">×</button>
  </li>`;
}

function quickForm() {
  return `<form class="quick" data-form="quick" autocomplete="off">
    <input name="title" placeholder="New task…" required aria-label="New task">
    <input name="deadline" type="date" aria-label="Deadline">
    <select name="importance" aria-label="Importance">${IMP.map((i) => `<option${i === 'Medium' ? ' selected' : ''}>${i}</option>`).join('')}</select>
    <input name="tags" placeholder="#tags" aria-label="Tags">
    <button type="submit">Add</button>
  </form>`;
}

function addTask(form) {
  const f = new FormData(form);
  const title = String(f.get('title') || '').trim();
  if (!title) return;
  const importance = IMP.includes(f.get('importance')) ? String(f.get('importance')) : 'Medium';
  write('tasks', {
    id: newId(),
    title: title.slice(0, 300),
    description: '',
    tags: parseTags(f.get('tags')),
    importance,
    deadline: isDateKey(f.get('deadline')) ? String(f.get('deadline')) : '',
    status: 'open',
    claudeDecides: false,
    sourcePick: '',
    createdAt: nowIso(),
    doneAt: '',
    deletedAt: '',
  });
  render();
  document.querySelector('form.quick input[name=title]')?.focus();
}

function viewTasks() {
  const all = liveTasks();
  const open = all.filter((t) => t.status !== 'done');
  const tags = [...new Set(open.flatMap((t) => t.tags || []))].sort();
  const filt = ui.taskTag;
  const list = sortTasks(open.filter((t) =>
    filt === 'all' ? true : filt === 'urgent' ? urgency(t) <= 1 : (t.tags || []).includes(filt)));
  const done = all
    .filter((t) => t.status === 'done')
    .sort((a, b) => ms(b.doneAt || b.updatedAt) - ms(a.doneAt || a.updatedAt))
    .slice(0, 40);
  const chips = ['all', 'urgent', ...tags];
  return `
  <div class="tasks-page">
    <header class="page-head"><h1>Tasks</h1><span class="muted">${open.length} open</span></header>
    <section class="card">
      ${quickForm()}
    </section>
    <div class="filters" style="margin:18px 0 10px">${chips.map((f) =>
      `<button type="button" data-act="task-filter" data-tag="${esc(f)}" aria-pressed="${filt === f}">${f === 'all' ? 'All' : f === 'urgent' ? 'Urgent' : '#' + esc(f)}</button>`).join('')}</div>
    <section class="card" style="padding:6px 20px">
      <ul class="tasks">${list.map(taskRow).join('') || '<li class="empty">Nothing here.</li>'}</ul>
    </section>
    <details class="card" style="margin-top:16px">
      <summary style="cursor:pointer">Completed (${done.length})</summary>
      <ul class="tasks" style="margin-top:8px">${done.map(taskRow).join('')}</ul>
    </details>
  </div>`;
}

/* ---------- home ---------- */

function logCard() {
  const r = dayMap().get(today()) || {};
  const radios = (name, cur) => [1, 2, 3, 4, 5].map((n) =>
    `<label><input type="radio" name="${name}" value="${n}"${cur === n ? ' checked' : ''}><span>${n}</span></label>`).join('');
  const gym = r.gymType || 'none';
  return `<form class="card log" id="log" autocomplete="off">
    <div class="card-head"><h2>Today</h2><span class="muted small" id="log-state">${esc(ui.logSaved)}</span></div>
    <div class="grid2">
      <label>Sleep<input name="sleep" value="${esc(r.sleep)}" placeholder="23:30-7:15"></label>
      <label>Walk, min<input name="walkingMin" type="number" min="0" inputmode="numeric" value="${r.walkingMin ?? ''}"></label>
      <label>Gym<select name="gymType">${GYM_TYPES.map((t) => `<option${gym === t ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
      <label>Gym, min<input name="gymMin" type="number" min="0" inputmode="numeric" value="${r.gymMin ?? ''}"></label>
    </div>
    <div class="scale"><span>Energy</span><div class="dots">${radios('energy', r.energy)}</div></div>
    <div class="scale"><span>Mood</span><div class="dots">${radios('mood', r.mood)}</div></div>
    <label>Note<input name="note" value="${esc(r.note)}" placeholder="alcohol, anything"></label>
  </form>`;
}

function onLog(form) {
  const f = new FormData(form);
  const key = today();
  const prev = dayMap().get(key) || {};
  const gymType = GYM_TYPES.includes(f.get('gymType')) ? String(f.get('gymType')) : 'none';
  const sleepIn = String(f.get('sleep') || '').trim();
  const sleepOk = validSleep(sleepIn);
  write('days', {
    ...prev,
    date: key,
    sleep: sleepOk ? sleepIn : (prev.sleep || ''),
    walkingMin: wholeNum(f.get('walkingMin'), 0, 1440),
    gymType,
    gymMin: gymType === 'none' ? null : wholeNum(f.get('gymMin'), 0, 1440),
    energy: wholeNum(f.get('energy'), 1, 5),
    mood: wholeNum(f.get('mood'), 1, 5),
    note: String(f.get('note') || '').trim(),
  });
  ui.logSaved = sleepOk ? `saved ${clockAt(new Date())}` : 'sleep: use 23:30-7:15 +15-16';
  const st = document.getElementById('log-state');
  if (st) st.textContent = ui.logSaved;
  renderPartial('week', weekInner);
}

function cigInner() {
  const todays = cigsOn(today());
  const sl = sleepSummary(dayMap().get(today())?.sleep);
  const first = todays[0];
  let wake = '';
  if (first && sl) wake = ` · ${fmtDur((minutesAt(first.at) - sl.main.end + 1440) % 1440)} after waking`;
  const times = todays.slice(-6).map((c) => `<span>${clockAt(c.at)}</span>`).join('') || '<span>none yet</span>';
  return `<div class="card-head"><h2>Cigarettes</h2><span class="big-n">${todays.length}</span></div>
    <div class="cig-row">
      <button class="tap" type="button" data-act="cig-add" aria-label="Log one cigarette">+1</button>
      <div class="times">${times}</div>
      <button class="ghost" type="button" data-act="cig-undo"${todays.length ? '' : ' disabled'}>undo</button>
    </div>
    <p class="muted small" style="margin:12px 0 0">${first ? `first at ${clockAt(first.at)}${wake}` : 'first at —'} · week ${weekStats().cigsPerDay}/day</p>`;
}

function weekInner() {
  const w = weekStats();
  return `<div class="card-head"><h2>This week</h2><span class="muted small">7-day average</span></div>
    <dl class="week-kpi">
      <div><dt>energy</dt><dd>${fmt(w.energy, 1)}</dd></div>
      <div><dt>walk, min</dt><dd>${fmt(w.walk)}</dd></div>
      <div><dt>sleep</dt><dd>${w.sleepH}</dd></div>
      <div><dt>cig/day</dt><dd>${w.cigsPerDay}</dd></div>
    </dl>`;
}

// Picks: "Current" is not dismissed or done, and its event date or job deadline has not passed.
const isSaved = (p) => p.status === 'useful' || p.status === 'tasked';
const isCurrent = (p) => ['new', 'useful', 'tasked'].includes(p.status)
  && (!p.date || p.date >= today())
  && (!p.deadline || p.deadline >= today());
const byRank = (a, b) => (a.rank ?? 99) - (b.rank ?? 99);

function viewHome() {
  const open = liveTasks().filter((t) => t.status !== 'done');
  const sorted = sortTasks(open);
  const overdue = open.filter((t) => urgency(t) === 0).length;
  const dueToday = open.filter((t) => urgency(t) === 1).length;
  const part = minutesAt(new Date()) < 720 ? 'morning' : minutesAt(new Date()) < 1080 ? 'afternoon' : 'evening';
  const picks = livePicks().filter(isCurrent).sort(byRank).slice(0, 4);
  return `
  <header class="hero">
    <div>
      <p class="eyebrow">KW ${weekOf(today())} · ${parseDay(today()).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
      <h1>Good ${part}<em>.</em></h1>
    </div>
    <dl class="kpis">
      <div><dt>overdue</dt><dd class="${overdue ? 'hot' : ''}">${overdue}</dd></div>
      <div><dt>due today</dt><dd>${dueToday}</dd></div>
      <div><dt>open</dt><dd>${open.length}</dd></div>
    </dl>
  </header>
  <div class="home">
    <section class="card focus">
      <div class="card-head"><h2>Focus</h2><a class="link" href="#tasks">all tasks →</a></div>
      <ul class="tasks">${sorted.slice(0, 8).map(taskRow).join('') || '<li class="empty">Nothing open.</li>'}</ul>
      ${sorted.length > 8 ? `<a class="more" href="#tasks">+${sorted.length - 8} more</a>` : ''}
      ${quickForm()}
    </section>
    <div class="side">
      ${logCard()}
      <section class="card cig" id="cigs">${cigInner()}</section>
      <section class="card picks-card">
        <div class="card-head"><h2>Picks</h2><a class="link" href="#picks">open →</a></div>
        <ol class="mini-picks">${picks.map((p) => {
          const url = safeUrl(p.url);
          return `<li><span class="kind">${esc(kindLabel(p.kind))}</span>${url
            ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(p.title)}</a>`
            : `<span class="ttl">${esc(p.title)}</span>`}</li>`;
        }).join('') || '<li class="muted">No current picks.</li>'}</ol>
      </section>
      <section class="card" id="week">${weekInner()}</section>
    </div>
  </div>`;
}

/* ---------- picks ---------- */

const pickTaskForm = (p) => `<form class="inline" data-pick="${esc(p.id)}">
    <label>Deadline<input type="date" name="deadline"></label>
    <label>Importance<select name="importance">${IMP.map((i) => `<option${i === 'Medium' ? ' selected' : ''}>${i}</option>`).join('')}</select></label>
    <label class="check"><input type="checkbox" name="auto"> Claude decides both</label>
    <button class="primary" type="submit">Create task</button>
  </form>`;

function pickRow(p) {
  const saved = isSaved(p);
  const url = safeUrl(p.url);
  const meta = [p.source, p.meta, p.date && `on ${p.date}`, p.deadline && `deadline ${p.deadline}`].filter(Boolean).map(esc).join(' · ');
  return `<li class="pick">
    <div>
      <span class="kind">${esc(kindLabel(p.kind))}</span>
      <div class="ttl">${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(p.title)}</a>` : esc(p.title)}</div>
      ${meta ? `<div class="meta">${meta}</div>` : ''}
      ${p.why ? `<p class="why">${esc(p.why)}</p>` : ''}
      ${ui.openPick === p.id ? pickTaskForm(p) : ''}
    </div>
    <div class="pa">
      ${p.status === 'tasked'
        ? '<span class="muted small">in tasks</span>'
        : `<button class="ghost" type="button" data-act="pick-save" data-id="${esc(p.id)}">${saved ? 'Unsave' : 'Save'}</button>`}
      <button class="ghost" type="button" data-act="pick-task" data-id="${esc(p.id)}">+ Task</button>
      <button class="ghost" type="button" data-act="pick-dismiss" data-id="${esc(p.id)}">Dismiss</button>
    </div>
  </li>`;
}

function taskFromPick(form, id) {
  const p = livePicks().find((x) => x.id === id);
  if (!p) return;
  const f = new FormData(form);
  // One flag covers both fields: "Claude decides both" clears deadline and importance.
  const auto = f.get('auto') === 'on';
  write('tasks', {
    id: newId(),
    title: p.title.slice(0, 300),
    description: p.why || '',
    tags: p.kind ? [p.kind] : [],
    importance: auto ? '' : (IMP.includes(f.get('importance')) ? String(f.get('importance')) : 'Medium'),
    deadline: !auto && isDateKey(f.get('deadline')) ? String(f.get('deadline')) : '',
    status: 'open',
    claudeDecides: auto,
    sourcePick: p.id,
    createdAt: nowIso(),
    doneAt: '',
    deletedAt: '',
  });
  write('picks', { ...p, status: 'tasked' });
  ui.openPick = null;
  toast('Task added');
  render();
}

function viewPicks() {
  const pool = livePicks().filter((p) => (ui.pickTab === 'saved' ? isSaved(p) : isCurrent(p)));
  const list = pool.filter((p) => p.kind === ui.pickKind).sort(byRank);
  return `
  <div class="tasks-page">
    <header class="page-head">
      <h1>Picks</h1>
      <div class="seg-tabs">
        <button type="button" data-act="pick-tab" data-tab="current" aria-pressed="${ui.pickTab === 'current'}">Current</button>
        <button type="button" data-act="pick-tab" data-tab="saved" aria-pressed="${ui.pickTab === 'saved'}">Saved</button>
      </div>
    </header>
    <div class="kind-tabs">${KINDS.map(([k, l]) => `<button type="button" data-act="pick-kind" data-kind="${k}" aria-pressed="${ui.pickKind === k}">${l}<span>${pool.filter((p) => p.kind === k).length}</span></button>`).join('')}</div>
    <section class="card" style="margin-top:14px;padding:4px 20px">
      <ul class="picks">${list.map(pickRow).join('') || '<li class="empty">Nothing here yet.</li>'}</ul>
    </section>
  </div>`;
}

function importPicks(form) {
  let data;
  try {
    data = JSON.parse(String(new FormData(form).get('json') || ''));
  } catch {
    return toast('That is not valid JSON');
  }
  const items = Array.isArray(data) ? data : (data && (data.feed || data.picks)) || [];
  if (!Array.isArray(items) || !items.length) return toast('No picks found');
  let count = 0;
  for (const raw of items) {
    if (!raw || !raw.title) continue;
    // "active" was the prototype's word for new.
    let status = raw.status === 'active' || !raw.status ? 'new' : raw.status === 'saved' ? 'useful' : raw.status;
    if (!PICK_STATUSES.includes(status)) status = 'new';
    write('picks', {
      id: raw.id ? String(raw.id) : newId(),
      kind: ['paper', 'podcast', 'event', 'job'].includes(raw.kind) ? raw.kind : 'paper',
      title: String(raw.title).slice(0, 300),
      source: String(raw.source || ''),
      meta: String(raw.meta || ''),
      url: safeUrl(raw.url),
      why: String(raw.why || ''),
      rank: Number.isFinite(Number(raw.rank)) ? Number(raw.rank) : null,
      week: String(raw.week || ''),
      status,
      date: isDateKey(raw.date) ? raw.date : '',
      deadline: isDateKey(raw.deadline) ? raw.deadline : '',
      createdAt: raw.createdAt || nowIso(),
    });
    count += 1;
  }
  toast(count ? `${count} picks imported` : 'No picks found');
  render();
}

/* ---------- trends ---------- */

const avgNums = (arr) => { const v = arr.filter((x) => typeof x === 'number'); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };

function bars(vals, max, color) {
  const W = 260, H = 70, n = vals.length, g = 3, bw = (W - g * (n - 1)) / n;
  const top = max || Math.max(1, ...vals.filter((v) => v != null));
  let s = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">`;
  vals.forEach((v, i) => {
    const x = (i * (bw + g)).toFixed(1);
    if (v == null) { s += `<rect x="${x}" y="${H - 2}" width="${bw.toFixed(1)}" height="2" fill="var(--line)"/>`; return; }
    const h = Math.max(3, (v / top) * (H - 6));
    s += `<rect x="${x}" y="${(H - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${color}" opacity="${i === n - 1 ? 1 : 0.5}"/>`;
  });
  return s + '</svg>';
}

function viewTrends() {
  const days = lastDays(14);
  const dm = dayMap();
  const rec = days.map((k) => dm.get(k) || null);
  const cigs = days.map((k) => cigsOn(k).length);
  const sleepH = days.map((k) => { const s = sleepSummary(dm.get(k)?.sleep); return s ? +(s.total / 60).toFixed(1) : null; });
  const series = [
    { n: 'Energy', u: '/5', v: rec.map((r) => r?.energy ?? null), max: 5, c: 'var(--clay)', dec: 1, lowerBetter: false },
    { n: 'Walking', u: ' min', v: rec.map((r) => r?.walkingMin ?? null), max: null, c: 'var(--sage)', dec: 0, lowerBetter: false },
    { n: 'Cigarettes', u: '/day', v: cigs, max: null, c: 'var(--ink)', dec: 1, lowerBetter: true },
    { n: 'Sleep', u: ' h', v: sleepH, max: 10, c: 'var(--gold)', dec: 1, lowerBetter: false },
  ];
  const cards = series.map((s) => {
    const a = avgNums(s.v.slice(7));
    const b = avgNums(s.v.slice(0, 7));
    let delta = { txt: 'no earlier week yet', cls: '' };
    if (a != null && b != null) {
      const d = a - b;
      const good = s.lowerBetter ? d < 0 : d > 0;
      delta = { txt: `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(s.dec)} vs previous week`, cls: Math.abs(d) < 1e-9 ? '' : good ? 'good' : 'bad' };
    }
    return `<article class="card metric">
      <div class="card-head"><h2>${s.n}</h2><span class="big-n">${fmt(a, s.dec)}<small class="muted small"> ${s.u.trim()}</small></span></div>
      ${bars(s.v, s.max, s.c)}
      <p class="delta ${delta.cls}">${delta.txt}</p>
    </article>`;
  }).join('');
  const pairs = rec.filter((r) => r && typeof r.energy === 'number' && typeof r.walkingMin === 'number');
  const act = pairs.filter((r) => r.walkingMin >= 20);
  const rest = pairs.filter((r) => r.walkingMin < 20);
  const insight = act.length >= 3 && rest.length >= 3
    ? `On days with 20+ min walking, average energy is <b>${mean(act.map((r) => r.energy)).toFixed(1)}</b> vs <b>${mean(rest.map((r) => r.energy)).toFixed(1)}</b> on other days (${pairs.length} logged days). A pattern, not proof.`
    : `Once you have 3 active days (20+ min walking) and 3 quieter days in the last 14, this compares your energy on each. Logged so far: ${pairs.length}.`;
  return `
  <div class="tasks-page">
    <header class="page-head"><h1>Trends</h1><span class="muted">last 14 days</span></header>
    <div class="trends">${cards}</div>
    <section class="card insight-card" style="margin-top:16px"><p class="insight" style="margin:0">${insight}</p></section>
  </div>`;
}

/* ---------- settings and sync ---------- */

function syncLabel() {
  const d = store.data.device;
  if (!d.clientId || !d.sheetId) return 'Not connected · saved on this device';
  const waiting = store.pendingCount();
  if (syncing) return 'Syncing…';
  if (!navigator.onLine) return `Offline${waiting ? ` · ${waiting} waiting` : ''}`;
  if (connectionLost) return `Offline · ${waiting} waiting`;
  if (d.lastError) return d.lastError;
  if (!hasGrant()) return `Sign in to Google in Settings to sync${waiting ? ` · ${waiting} waiting` : ''}`;
  if (waiting) return `${waiting} waiting to sync`;
  return d.lastSyncAt ? `Synced ${clockAt(d.lastSyncAt)}` : 'Not synced yet';
}

function paintSync() {
  const label = syncLabel();
  const el = $('#sync');
  if (el) el.textContent = label;
  const detail = $('#sync-detail');
  if (detail) detail.textContent = label;
}

function viewSettings() {
  const d = store.data.device;
  const pf = (key) => `<label>${PROFILE_LABELS[key]}<textarea name="${key}" rows="2">${esc(store.setting(key))}</textarea></label>`;
  return `
  <div class="tasks-page">
    <header class="page-head"><h1>Settings</h1><span class="muted" id="sync-detail">${esc(syncLabel())}</span></header>
    <div class="settings">
      <form class="card" id="connect-form" style="display:grid;gap:14px">
        <h2>Google Sheet</h2>
        <label>Google client ID<input name="clientId" value="${esc(d.clientId)}" placeholder="…apps.googleusercontent.com" autocomplete="off"></label>
        <label>Sheet ID<input name="sheetId" value="${esc(d.sheetId)}" placeholder="the long id in the sheet's link" autocomplete="off"></label>
        <p class="muted small" style="margin:0">Both are kept on this device only. The repo holds no IDs or tokens.</p>
        <div class="row" style="flex-wrap:wrap;gap:8px">
          <button class="primary" type="submit">Save and connect</button>
          <button class="ghost" type="button" data-act="sync-now">Sync now</button>
          <button class="ghost" type="button" data-act="sign-out">Sign out of Google</button>
        </div>
      </form>
      <form class="card" id="profile-form" style="display:grid;gap:14px">
        <h2>What Claude looks for</h2>
        <p class="muted small" style="margin:0">Stored in the sheet's settings tab. Last weekly run: ${esc(store.setting('last_run_at', 'never'))}</p>
        ${PROFILE_KEYS.map(pf).join('')}
        <div class="row"><button class="primary" type="submit">Save</button></div>
      </form>
      <form class="card" id="import-form" style="display:grid;gap:14px">
        <h2>Import picks</h2>
        <p class="muted small" style="margin:0">Paste the weekly picks JSON. Same ids are replaced.</p>
        <label>JSON<textarea name="json" rows="4"></textarea></label>
        <div class="row"><button class="primary" type="submit">Import</button></div>
      </form>
      <section class="card" style="display:grid;gap:12px">
        <h2>Backup</h2>
        <div class="row"><button class="ghost" type="button" data-act="export">Download everything (JSON)</button></div>
      </section>
    </div>
  </div>`;
}

function friendlyError(err) {
  if (err instanceof SchemaError) return err.message;
  if (err instanceof AuthError) {
    if (err.code === 'no_client_id') return 'Add your Google client ID in Settings';
    if (err.code === 'no_script') return err.message;
    if (err.code === 'popup' || err.code === 'access_denied') {
      return 'Sign-in was cancelled or blocked. Press "Save and connect" to try again.';
    }
    return 'Sign in to Google again in Settings';
  }
  if (err instanceof SheetsError) {
    if (err.status === 0) return 'No connection. Changes wait and sync when you are back online.';
    if (err.status === 401) return 'Sign in to Google again in Settings';
    if (err.status === 403) return "Google won't let this account open the sheet. Share the sheet with this account and enable the Google Sheets API.";
    if (err.status === 404) return 'Sheet not found. Check the Sheet ID in Settings.';
    return `Google error: ${err.message}`;
  }
  return String(err?.message || err);
}

const tokenFor = (clientId) => (opts = {}) => getToken({ ...opts, clientId });

let syncing = false;
let syncQueued = false;
let syncTimer = null;
let connectionLost = false;

function scheduleSync(delay = 1500) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => runSync(), delay);
}

async function runSync() {
  const d = store.data.device;
  if (!d.clientId || !d.sheetId) return paintSync();
  if (syncing) {
    syncQueued = true;
    return;
  }
  if (!navigator.onLine || !hasGrant()) return paintSync();
  syncing = true;
  paintSync();
  try {
    const result = await syncOnce(store, { sheetId: d.sheetId, getToken: tokenFor(d.clientId) });
    d.lastSyncAt = nowIso();
    d.lastError = '';
    connectionLost = false;
    if (result.superseded) {
      toast(`${result.superseded} older edit${result.superseded > 1 ? 's were' : ' was'} replaced by newer changes`);
    }
  } catch (err) {
    // No connection is not an error to show: the edits are safe in the outbox and sync retries.
    connectionLost = err instanceof SheetsError && err.status === 0;
    d.lastError = connectionLost ? '' : friendlyError(err);
    console.warn('Sync failed', err);
  } finally {
    syncing = false;
    store.save();
    paintSync();
    renderSoft();
    if (syncQueued) {
      syncQueued = false;
      runSync();
    }
  }
}

async function connect() {
  const d = store.data.device;
  if (!d.clientId || !d.sheetId) {
    toast('Enter the client ID and the Sheet ID');
    return;
  }
  try {
    // Opens Google's sign-in window, so this must run from a click.
    await getToken({ clientId: d.clientId, interactive: true });
    const title = await sheetTitle(d.sheetId, tokenFor(d.clientId));
    d.lastError = '';
    store.save();
    toast(`Connected to "${title}"`);
  } catch (err) {
    d.lastError = friendlyError(err);
    store.save();
    paintSync();
    return;
  }
  await runSync();
  render();
}

function saveConnection(form) {
  const f = new FormData(form);
  const d = store.data.device;
  d.clientId = String(f.get('clientId') || '').trim();
  d.sheetId = String(f.get('sheetId') || '').trim();
  store.save();
  connect();
}

function saveProfile(form) {
  const f = new FormData(form);
  let changed = 0;
  for (const key of PROFILE_KEYS) {
    const value = String(f.get(key) || '').trim();
    if (value === store.setting(key)) continue;
    store.enqueue('settings', { key, value, updatedAt: nowIso() });
    changed += 1;
  }
  if (changed) scheduleSync();
  toast(changed ? 'Saved' : 'Nothing changed');
}

function disconnectGoogle() {
  signOut();
  store.data.device.lastError = 'Signed out. Changes stay on this device until you connect again.';
  store.save();
  paintSync();
  toast('Signed out of Google');
}

function exportBackup() {
  const data = Object.fromEntries(APP_TABS.map((t) => [t, store.rows(t).map(({ _row, ...r }) => r)]));
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `life-tracker-${today()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- shell ---------- */

const VIEWS = { home: viewHome, tasks: viewTasks, picks: viewPicks, trends: viewTrends, settings: viewSettings };

function currentRoute() {
  const h = location.hash.slice(1);
  return VIEWS[h] ? h : 'home';
}

// Background syncs must not wipe a half-typed form, so they wait until focus leaves the view.
const editingInView = () => {
  const a = document.activeElement;
  return !!a && !!a.closest?.('#view') && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
};
let deferredRender = false;

function render() {
  const r = currentRoute();
  document.body.dataset.route = r;
  document.querySelectorAll('[data-route]').forEach((a) => {
    const on = a.dataset.route === r;
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  deferredRender = false;
  $('#view').innerHTML = VIEWS[r]();
  paintSync();
}

function renderSoft() {
  if (editingInView()) {
    deferredRender = true;
    return;
  }
  render();
}

function renderPartial(id, fn) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = fn();
}

document.addEventListener('focusout', () => {
  if (!deferredRender) return;
  setTimeout(() => { if (!editingInView()) render(); }, 60);
});

document.addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    const t = store.rows('tasks').find((x) => x.id === del.dataset.del);
    if (t) write('tasks', { ...t, deletedAt: nowIso() });
    return render();
  }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const { act, id } = el.dataset;
  if (act === 'cig-add') {
    const at = nowIso();
    store.enqueue('cigs', { id: newId(), at, day: logicalDay(new Date(at)), deletedAt: '' });
    scheduleSync();
    return renderPartial('cigs', cigInner);
  }
  if (act === 'cig-undo') {
    const last = cigsOn(today()).pop();
    if (!last) return;
    store.enqueue('cigs', { ...last, deletedAt: nowIso() });
    scheduleSync();
    return renderPartial('cigs', cigInner);
  }
  if (act === 'task-filter') { ui.taskTag = el.dataset.tag; return render(); }
  if (act === 'pick-tab') { ui.pickTab = el.dataset.tab; return render(); }
  if (act === 'pick-kind') { ui.pickKind = el.dataset.kind; return render(); }
  if (act === 'pick-save') {
    const p = livePicks().find((x) => x.id === id);
    if (!p || p.status === 'tasked') return;
    write('picks', { ...p, status: isSaved(p) ? 'new' : 'useful' });
    return render();
  }
  if (act === 'pick-dismiss') {
    const p = livePicks().find((x) => x.id === id);
    if (!p) return;
    write('picks', { ...p, status: 'dismissed' });
    return render();
  }
  if (act === 'pick-task') { ui.openPick = ui.openPick === id ? null : id; return render(); }
  if (act === 'sync-now') return runSync();
  if (act === 'sign-out') return disconnectGoogle();
  if (act === 'export') return exportBackup();
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset && t.dataset.done) {
    const task = store.rows('tasks').find((x) => x.id === t.dataset.done);
    if (task) {
      write('tasks', { ...task, status: t.checked ? 'done' : 'open', doneAt: t.checked ? nowIso() : '' });
      render();
    }
    return;
  }
  if (t.form && t.form.id === 'log') onLog(t.form);
});

document.addEventListener('input', (e) => {
  if (e.target.form && e.target.form.id === 'log') onLog(e.target.form);
});

document.addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  if (form.dataset.pick) return taskFromPick(form, form.dataset.pick);
  if (form.dataset.form === 'quick') return addTask(form);
  if (form.id === 'connect-form') return saveConnection(form);
  if (form.id === 'profile-form') return saveProfile(form);
  if (form.id === 'import-form') return importPicks(form);
});

function boot() {
  paintSync();
  // Reconnect silently when the browser still has a Google session. Otherwise the user presses Connect.
  if (store.data.device.clientId && store.data.device.sheetId && hasGrant()) runSync();
  window.addEventListener('online', () => runSync());
  window.addEventListener('offline', () => paintSync());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) runSync(); });
  setInterval(() => runSync(), 5 * 60 * 1000);
}

if (!location.hash) location.hash = '#home';
window.addEventListener('hashchange', render);
render();
boot();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
