import { Store, newId } from './store.js';
import {
  APP_TABS, PICK_STATUSES, SchemaError, ms, isDateKey, dayDiff, shiftDay,
  logicalDay, clockAt, minutesAt,
} from './schema.js';
import { createBridge, isBridgeUrl, BridgeError } from './bridge.js';
import { syncOnce } from './sync.js';
import { parseDateInput, typed, longDate, quickDates } from './dates.js';
import { UndoHistory } from './undo.js';

// Cigarettes are hidden while Reza quits. The code, the cigs tab and its data stay in place.
const SHOW_CIGS = false;

const store = new Store(localStorage);
const undo = new UndoHistory();
const ui = { pickTab: 'current', pickKind: 'paper', openPick: null, taskTag: 'all', logSaved: '' };

// Look and task sort order: per device, not synced.
const PREFS_KEY = 'life-tracker.prefs';
const prefs = (() => {
  try { return { theme: 'light', accent: 'ink', sort: 'urgency', ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return { theme: 'light', accent: 'ink', sort: 'urgency' }; }
})();
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* storage full */ } };
const THEMES = [['light', 'Light'], ['dark', 'Dark'], ['system', 'System']];
const ACCENTS = [['ink', 'Ink'], ['clay', 'Clay'], ['sage', 'Sage'], ['ocean', 'Ocean'], ['plum', 'Plum']];
const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

// Same logic as the small script in index.html, which applies it before the first paint.
function applyLook() {
  const dark = prefs.theme === 'dark' || (prefs.theme === 'system' && !!darkQuery?.matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.accent = ACCENTS.some(([v]) => v === prefs.accent) ? prefs.accent : 'ink';
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = dark ? '#16130F' : '#F3EEE3';
}
applyLook();
darkQuery?.addEventListener?.('change', () => { if (prefs.theme === 'system') applyLook(); });
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
const CLAUDE = 'claude'; // the importance choice "Let Claude decide"
const impRank = (t) => (t.claudeDecides ? 4 : IMP_RANK[t.importance] ?? 5);

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
// Time ranges, as in sleep and work: "23:30-7:15 +15-16".
const validRanges = (text) => !text || text.split(/\s+/).every((t) => /^\+?\d{1,2}(:\d{2})?-\d{1,2}(:\d{2})?$/.test(t));

// A short message. With { undo: true } it carries an Undo button for the last action.
function toast(msg, { undo: withUndo = false } = {}) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${withUndo ? '<button type="button" data-act="undo">Undo</button>' : ''}`;
  t.classList.toggle('actionable', withUndo);
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show', 'actionable'), withUndo ? 5000 : 2200);
}

const keyField = (tab) => (tab === 'days' ? 'date' : tab === 'settings' ? 'key' : 'id');
const current = (tab, key) => store.rows(tab).find((r) => r[keyField(tab)] === key) || null;

// All writes go through here: remember the row as it was (for undo), stamp the change, queue it,
// and sync soon. label names the action in the undo history.
function write(tab, rec, label = 'Change') {
  const key = rec[keyField(tab)];
  const before = current(tab, key);
  undo.record(label, tab, key, before ? (({ _row, ...r }) => r)(before) : null);
  store.enqueue(tab, { ...rec, updatedAt: nowIso(), updatedBy: 'app' });
  scheduleSync();
  paintUndo();
}

// Puts rows back the way they were before the last action. A row that the action created is
// removed the way that tab allows: tasks are soft-deleted, picks dismissed, a day's values cleared.
function undoLast() {
  const entry = undo.pop();
  if (!entry) return toast('Nothing to undo');
  for (const it of entry.items.slice().reverse()) {
    const now = current(it.tab, it.key);
    let rec;
    if (it.before) rec = it.before;
    else if (!now) continue;
    else if (it.tab === 'tasks' || it.tab === 'cigs') rec = { ...now, deletedAt: nowIso() };
    else if (it.tab === 'picks') rec = { ...now, status: 'dismissed' };
    else if (it.tab === 'settings') rec = { ...now, value: '' };
    else if (it.tab === 'days') rec = { date: now.date, gymType: now.gymType || '' };
    else continue;
    const { _row, ...clean } = rec;
    store.enqueue(it.tab, it.tab === 'cigs' ? clean : { ...clean, updatedAt: nowIso(), updatedBy: 'app' });
  }
  scheduleSync();
  ui.logSaved = '';
  render();
  toast(`Undone: ${entry.label}`);
}

function paintUndo() {
  const b = $('#undo');
  if (!b) return;
  const last = undo.last;
  b.disabled = !last;
  b.title = last ? `Undo: ${last.label} (Ctrl+Z)` : 'Nothing to undo';
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

const byDeadline = (a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999');
const byCreated = (a, b) => (a.createdAt || '').localeCompare(b.createdAt || '');
const SORTS = {
  // Overdue, due today, MUST DO, next three days, then the rest.
  urgency: (a, b) => urgency(a) - urgency(b) || impRank(a) - impRank(b) || byDeadline(a, b) || byCreated(a, b),
  // MUST DO, High, Medium, Low, waiting for Claude, none; then the closest deadline.
  importance: (a, b) => impRank(a) - impRank(b) || byDeadline(a, b) || byCreated(a, b),
  // Closest deadline first, no deadline last; then importance.
  deadline: (a, b) => byDeadline(a, b) || impRank(a) - impRank(b) || byCreated(a, b),
};
const SORT_LABELS = [['urgency', 'Urgent'], ['importance', 'Importance'], ['deadline', 'Deadline']];
const sortTasks = (list, by = prefs.sort) => list.slice().sort(SORTS[by] || SORTS.urgency);

function sortControl() {
  return `<div class="sortby" role="group" aria-label="Sort tasks"><span>Sort</span>${SORT_LABELS.map(([k, l]) =>
    `<button type="button" data-act="sort" data-sort="${k}" aria-pressed="${prefs.sort === k}">${l}</button>`).join('')}</div>`;
}

// Tags used before, most used first, so they can be picked instead of typed.
function knownTags() {
  const count = new Map();
  for (const t of liveTasks()) for (const g of t.tags || []) count.set(g, (count.get(g) || 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([g]) => g);
}

function dueChip(s) {
  const n = daysTo(s);
  if (n === null) return '';
  const cls = n <= 0 ? 'hot' : n <= 3 ? 'warm' : '';
  const label = n < 0 ? `${-n}d overdue` : n === 0 ? 'today' : n === 1 ? 'tomorrow' : n <= 6 ? `in ${n}d` : parseDay(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return `<span class="due ${cls}">${label}</span>`;
}

const SPARKLE = '<svg class="spark" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l1.4 4.1L13.5 7 9.4 8.4 8 12.5 6.6 8.4 2.5 7l4.1-1.4z"/><path d="M13 11.2l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z"/></svg>';

function taskRow(t) {
  const done = t.status === 'done';
  const must = !done && t.importance === 'MUST DO' && !t.claudeDecides;
  const overdue = !done && urgency(t) === 0;
  const tags = (t.tags || []).map((x) => `<span class="tag">#${esc(x)}</span>`).join('');
  const imp = t.claudeDecides
    ? `<span class="imp pending" title="Waiting for Claude to decide">${SPARKLE}Claude decides</span>`
    : `<span class="imp">${esc(t.importance || '')}</span>`;
  return `<li class="task${done ? ' done' : ''}${must ? ' must' : ''}${overdue ? ' overdue' : ''}">
    <input type="checkbox" data-done="${esc(t.id)}"${done ? ' checked' : ''} aria-label="Done: ${esc(t.title)}">
    <div><div class="ttl">${esc(t.title)}</div>
      <div class="tm">${done ? '' : dueChip(t.deadline)}${tags}</div></div>
    ${imp}
    <button class="x" type="button" data-del="${esc(t.id)}" aria-label="Delete task">×</button>
  </li>`;
}

const CAL_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4.5" width="14" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3 8.5h14M7 2.8v3.4M13 2.8v3.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

// Deadline: type it day first ("24.11", "fri", "tomorrow"), tap a quick pick, or open a calendar.
// The hidden input holds the date the form submits.
function dateField(name = 'deadline', label = 'Deadline') {
  return `<div class="datef" data-datef>
    <span class="lbl">${label}</span>
    <div class="date-in">
      <input class="date-text" data-date-text placeholder="dd.mm, fri, tomorrow" autocomplete="off" spellcheck="false" aria-label="${label}: day, month, year">
      <button type="button" class="cal" data-act="date-cal" aria-label="Pick from a calendar">${CAL_ICON}</button>
      <input class="date-native" type="date" data-date-native tabindex="-1" aria-hidden="true" min="2000-01-01" max="2100-12-31">
    </div>
    <input type="hidden" name="${name}" value="">
    <div class="date-chips">${quickDates(today()).map(([l, k]) =>
      `<button type="button" data-act="date-set" data-key="${k}" title="${longDate(k)}">${l}</button>`).join('')}</div>
    <span class="date-hint" aria-live="polite"></span>
  </div>`;
}

function setDate(field, key, { fromText = false, error = '' } = {}) {
  field.querySelector('input[type=hidden]').value = key;
  if (!fromText) field.querySelector('[data-date-text]').value = typed(key);
  const hint = field.querySelector('.date-hint');
  hint.textContent = error || longDate(key);
  hint.classList.toggle('bad', !!error);
  field.querySelectorAll('[data-act=date-set]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.key === key)));
}

function importanceSelect() {
  return `<label class="impf"><span class="lbl">Importance</span><select name="importance">${IMP.map((i) =>
    `<option${i === 'Medium' ? ' selected' : ''}>${i}</option>`).join('')}<option value="${CLAUDE}">✨ Let Claude decide</option></select></label>`;
}

// Tags: tap one you used before, or type a new one (Enter or comma adds it).
function tagField() {
  const known = knownTags();
  return `<div class="tagf" data-tagf>
    <span class="lbl">Tags</span>
    <div class="tag-pick">${known.map((g, i) =>
      `<button type="button" class="tchip${i >= 12 ? ' extra' : ''}" data-act="tag-toggle" data-tag="${esc(g)}" aria-pressed="false">#${esc(g)}</button>`).join('')}
      <input class="tag-new" data-tag-new placeholder="${known.length ? 'new tag' : 'add a tag, e.g. study'}" autocomplete="off" spellcheck="false" aria-label="New tag">
    </div>
    <input type="hidden" name="tags" value="">
  </div>`;
}

function syncTags(field) {
  const on = [...field.querySelectorAll('.tchip[aria-pressed=true]')].map((b) => b.dataset.tag);
  field.querySelector('input[name=tags]').value = on.join(', ');
}

// Adds what is typed in the new-tag box as a selected chip, or selects the matching existing one.
function commitTag(field) {
  const box = field.querySelector('[data-tag-new]');
  for (const tag of parseTags(box.value)) {
    let chip = [...field.querySelectorAll('.tchip')].find((b) => b.dataset.tag === tag);
    if (!chip) {
      chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tchip';
      chip.dataset.act = 'tag-toggle';
      chip.dataset.tag = tag;
      chip.textContent = `#${tag}`;
      box.before(chip);
    }
    chip.setAttribute('aria-pressed', 'true');
  }
  box.value = '';
  filterTags(field, '');
  syncTags(field);
}

function filterTags(field, text) {
  const q = parseTags(text)[0] || '';
  field.classList.toggle('filtering', !!q);
  field.querySelectorAll('.tchip').forEach((b) => {
    b.hidden = !!q && !b.dataset.tag.includes(q) && b.getAttribute('aria-pressed') !== 'true';
  });
}

// open: the extra fields always show (Tasks page). On Home they show once you start a task.
function quickForm({ open = false } = {}) {
  return `<form class="quick${open ? ' open always' : ''}" data-form="quick" autocomplete="off">
    <div class="q-main">
      <input name="title" placeholder="New task…" required aria-label="New task" maxlength="300">
      <button type="submit" class="q-add">Add</button>
    </div>
    <div class="q-more">
      ${dateField()}
      ${importanceSelect()}
      ${tagField()}
    </div>
  </form>`;
}

// Reads the deadline from a form, or explains why it can't. Returns null when the typed date is unreadable.
function formDeadline(form) {
  const field = form.querySelector('[data-datef]');
  if (!field) return '';
  const text = field.querySelector('[data-date-text]').value;
  const r = parseDateInput(text, today());
  if (r.error) {
    setDate(field, '', { fromText: true, error: r.error });
    field.querySelector('[data-date-text]').focus();
    toast("Couldn't read that date");
    return null;
  }
  return r.key;
}

function formImportance(form) {
  const v = String(new FormData(form).get('importance') || '');
  if (v === CLAUDE) return { importance: '', claudeDecides: true };
  return { importance: IMP.includes(v) ? v : 'Medium', claudeDecides: false };
}

function formTags(form) {
  const field = form.querySelector('[data-tagf]');
  if (!field) return [];
  commitTag(field);
  return parseTags(field.querySelector('input[name=tags]').value);
}

function addTask(form) {
  const f = new FormData(form);
  const title = String(f.get('title') || '').trim();
  if (!title) return;
  const deadline = formDeadline(form);
  if (deadline === null) return;
  write('tasks', {
    id: newId(),
    title: title.slice(0, 300),
    description: '',
    tags: formTags(form),
    ...formImportance(form),
    deadline,
    status: 'open',
    sourcePick: '',
    createdAt: nowIso(),
    doneAt: '',
    deletedAt: '',
  }, 'Added task');
  const keepOpen = form.classList.contains('always');
  render({ keepDrafts: false });
  toast(`Added “${title.slice(0, 40)}”`, { undo: true });
  const box = document.querySelector('form.quick input[name=title]');
  if (box && keepOpen) box.focus();
}

function viewTasks() {
  const all = liveTasks();
  const open = all.filter((t) => t.status !== 'done');
  const tags = [...new Set(open.flatMap((t) => t.tags || []))].sort();
  const filt = ui.taskTag;
  const list = sortTasks(open.filter((t) =>
    filt === 'all' ? true : filt === 'urgent' ? urgency(t) <= 1 : filt === '~claude' ? t.claudeDecides : (t.tags || []).includes(filt)));
  const waiting = open.filter((t) => t.claudeDecides).length;
  const done = all
    .filter((t) => t.status === 'done')
    .sort((a, b) => ms(b.doneAt || b.updatedAt) - ms(a.doneAt || a.updatedAt))
    .slice(0, 40);
  const chips = ['all', 'urgent', ...(waiting ? ['~claude'] : []), ...tags];
  const chipLabel = (f) => (f === 'all' ? 'All' : f === 'urgent' ? 'Urgent' : f === '~claude' ? `✨ For Claude (${waiting})` : `#${esc(f)}`);
  return `
  <div class="tasks-page">
    <header class="page-head"><h1>Tasks</h1><span class="muted">${open.length} open</span></header>
    <section class="card">
      ${quickForm({ open: true })}
    </section>
    <div class="list-bar">
      <div class="filters">${chips.map((f) =>
        `<button type="button" data-act="task-filter" data-tag="${esc(f)}" aria-pressed="${filt === f}">${chipLabel(f)}</button>`).join('')}</div>
      ${sortControl()}
    </div>
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

// Total minutes of a set of time ranges, as typed for work: "9-12:30 13:30-18".
const rangesTotal = (text) => parseSleep(text).reduce((s, b) => s + b.dur, 0);

function logCard() {
  const r = dayMap().get(today()) || {};
  const radios = (name, cur) => [1, 2, 3, 4, 5].map((n) =>
    `<label><input type="radio" name="${name}" value="${n}"${cur === n ? ' checked' : ''}><span>${n}</span></label>`).join('');
  const sl = sleepSummary(r.sleep);
  const wk = rangesTotal(r.work);
  const mins = (name, label, v) => `<label><span class="lh">${label}</span><input name="${name}" type="number" min="0" max="1440" inputmode="numeric" placeholder="min" value="${v ?? ''}"></label>`;
  return `<form class="card log" id="log" autocomplete="off">
    <div class="card-head"><h2>Today</h2><span class="muted small" id="log-state">${esc(ui.logSaved)}</span></div>
    <label><span class="lh">Sleep <b class="tot" id="sleep-tot">${sl ? fmtDur(sl.total) : ''}</b></span><input name="sleep" value="${esc(r.sleep)}" placeholder="23:30-7:15 +15-16" spellcheck="false"></label>
    <div class="scale"><span>Sleep quality</span><div class="dots">${radios('sleepQuality', r.sleepQuality)}</div></div>
    <label><span class="lh">Work <b class="tot" id="work-tot">${wk ? fmtDur(wk) : ''}</b></span><input name="work" value="${esc(r.work)}" placeholder="9-12:30 13:30-18" spellcheck="false"></label>
    <div class="grid2">
      ${mins('studyMin', 'Study, min', r.studyMin)}
      ${mins('choresMin', 'Chores, min', r.choresMin)}
      ${mins('walkingMin', 'Walk, min', r.walkingMin)}
      ${mins('gymMin', 'Gym, min', r.gymMin)}
    </div>
    <div class="scale"><span>Energy</span><div class="dots">${radios('energy', r.energy)}</div></div>
    <div class="scale"><span>Mood</span><div class="dots">${radios('mood', r.mood)}</div></div>
    <label class="note"><span class="lh">Note</span><textarea name="note" rows="3" placeholder="Anything. Enter starts a new line.">${esc(r.note)}</textarea></label>
  </form>`;
}

function onLog(form) {
  const f = new FormData(form);
  const key = today();
  const prev = dayMap().get(key) || {};
  const sleepIn = String(f.get('sleep') || '').trim();
  const workIn = String(f.get('work') || '').trim();
  const sleepOk = validRanges(sleepIn);
  const workOk = validRanges(workIn);
  const mins = (name) => wholeNum(f.get(name), 0, 1440);
  write('days', {
    ...prev,
    date: key,
    sleep: sleepOk ? sleepIn : (prev.sleep || ''),
    sleepQuality: wholeNum(f.get('sleepQuality'), 1, 5),
    work: workOk ? workIn : (prev.work || ''),
    studyMin: mins('studyMin'),
    choresMin: mins('choresMin'),
    walkingMin: mins('walkingMin'),
    gymType: prev.gymType || '',
    gymMin: mins('gymMin'),
    energy: wholeNum(f.get('energy'), 1, 5),
    mood: wholeNum(f.get('mood'), 1, 5),
    note: String(f.get('note') || '').replace(/\s+$/, ''),
  }, 'Edited Today');
  ui.logSaved = !sleepOk ? 'sleep: use 23:30-7:15 +15-16' : !workOk ? 'work: use 9-12:30 14-18' : `saved ${clockAt(new Date())}`;
  const st = document.getElementById('log-state');
  if (st) st.textContent = ui.logSaved;
  const sl = sleepOk ? sleepSummary(sleepIn) : null;
  const wk = workOk ? rangesTotal(workIn) : 0;
  const s = document.getElementById('sleep-tot');
  if (s) s.textContent = sl ? fmtDur(sl.total) : '';
  const w = document.getElementById('work-tot');
  if (w) w.textContent = wk ? fmtDur(wk) : '';
}

// Reserved space on Home: a sentence or a small picture, to be decided.
function spotCard() {
  return `<section class="card spot" id="spot" aria-label="Reserved space">
    <p>A sentence or a small picture goes here.</p>
    <span class="muted small">placeholder · to decide later</span>
  </section>`;
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
    <div class="side">
      ${logCard()}
      ${SHOW_CIGS ? `<section class="card cig" id="cigs">${cigInner()}</section>` : ''}
      <section class="card picks-card">
        <div class="card-head"><h2>Picks</h2><a class="link" href="#picks">open →</a></div>
        <ol class="mini-picks">${picks.map((p) => {
          const url = safeUrl(p.url);
          return `<li><span class="kind">${esc(kindLabel(p.kind))}</span>${url
            ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(p.title)}</a>`
            : `<span class="ttl">${esc(p.title)}</span>`}</li>`;
        }).join('') || '<li class="muted">No current picks.</li>'}</ol>
      </section>
      ${spotCard()}
    </div>
    <section class="card focus">
      <div class="card-head"><h2>Tasks</h2>${sortControl()}<a class="link" href="#tasks">all →</a></div>
      <ul class="tasks">${sorted.slice(0, 12).map(taskRow).join('') || '<li class="empty">Nothing open.</li>'}</ul>
      ${sorted.length > 12 ? `<a class="more" href="#tasks">+${sorted.length - 12} more</a>` : ''}
      ${quickForm()}
    </section>
  </div>`;
}

/* ---------- picks ---------- */

const pickTaskForm = (p) => `<form class="inline quick open always" data-pick="${esc(p.id)}" autocomplete="off">
    <div class="q-more">${dateField()}${importanceSelect()}</div>
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
  const deadline = formDeadline(form);
  if (deadline === null) return;
  undo.group('Task from pick', () => {
    write('tasks', {
      id: newId(),
      title: p.title.slice(0, 300),
      description: p.why || '',
      tags: p.kind ? [p.kind] : [],
      ...formImportance(form),
      deadline,
      status: 'open',
      sourcePick: p.id,
      createdAt: nowIso(),
      doneAt: '',
      deletedAt: '',
    });
    write('picks', { ...p, status: 'tasked' });
  });
  paintUndo();
  ui.openPick = null;
  render();
  toast('Task added', { undo: true });
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
  undo.group('Imported picks', () => { for (const raw of items) {
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
  } });
  paintUndo();
  toast(count ? `${count} picks imported` : 'No picks found', { undo: count > 0 });
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
    SHOW_CIGS
      ? { n: 'Cigarettes', u: '/day', v: cigs, max: null, c: 'var(--ink)', dec: 1, lowerBetter: true }
      : { n: 'Study', u: ' h', v: rec.map((r) => (typeof r?.studyMin === 'number' ? +(r.studyMin / 60).toFixed(1) : null)), max: null, c: 'var(--ink)', dec: 1, lowerBetter: false },
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

const connected = () => !!(store.data.device.bridgeUrl && store.data.device.bridgeKey);
const bridge = () => createBridge({ url: store.data.device.bridgeUrl, key: store.data.device.bridgeKey });

function syncLabel() {
  const d = store.data.device;
  if (!connected()) return 'Not connected · saved on this device';
  const waiting = store.pendingCount();
  const tail = waiting ? ` · ${waiting} waiting` : '';
  if (syncing) return 'Syncing…';
  if (!navigator.onLine) return `Offline${tail}`;
  if (connectionLost) return `Can't reach the sheet${tail}`;
  if (d.lastError) return d.lastError;
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
      <form class="card" id="connect-form" style="display:grid;gap:14px" autocomplete="off">
        <h2>Google Sheet</h2>
        <label>Sheet script link<input name="bridgeUrl" value="${esc(d.bridgeUrl)}" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off" spellcheck="false"></label>
        <label>Key<input name="bridgeKey" type="password" value="" placeholder="${d.bridgeKey ? 'Saved on this device. Leave empty to keep it' : 'From the script’s log after you run setup'}" autocomplete="off" spellcheck="false"></label>
        <p class="muted small" style="margin:0">Both stay on this device only. You set them once per device; there is no sign-in to renew. Setup steps are in the <a href="https://github.com/Reza31342/life-tracker#connect-to-the-google-sheet" target="_blank" rel="noopener">README</a>.</p>
        <div class="row" style="flex-wrap:wrap;gap:8px">
          <button class="primary" type="submit">Save and connect</button>
          <button class="ghost" type="button" data-act="sync-now">Sync now</button>
          <button class="ghost" type="button" data-act="forget-link">Remove link from this device</button>
        </div>
      </form>
      <section class="card appearance" style="display:grid;gap:14px">
        <h2>Appearance</h2>
        <div class="pref-row"><span class="lbl">Mode</span><div class="seg-tabs">${THEMES.map(([v, l]) =>
          `<button type="button" data-act="theme" data-v="${v}" aria-pressed="${prefs.theme === v}">${l}</button>`).join('')}</div></div>
        <div class="pref-row"><span class="lbl">Color</span><div class="swatches">${ACCENTS.map(([v, l]) =>
          `<button type="button" class="sw sw-${v}" data-act="accent" data-v="${v}" aria-pressed="${prefs.accent === v}" title="${l}"><span></span>${l}</button>`).join('')}</div></div>
        <p class="muted small" style="margin:0">Saved on this device only.</p>
      </section>
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

const LINK_HELP = 'Check the link in Settings, and that the deployment’s access is set to Anyone.';

function friendlyError(err) {
  if (err instanceof SchemaError) return err.message;
  if (err instanceof BridgeError) {
    if (err.code === 'bad_key') return "The key doesn't match the sheet script. Paste the key again in Settings.";
    if (err.code === 'not_set_up') return 'The sheet script has no key yet. Run "setup" in Apps Script.';
    if (err.code === 'not_found') return 'Sheet script link not found. Check it in Settings (it ends with /exec).';
    if (err.code === 'not_json') return `The link isn't answering like the Life Tracker script. ${LINK_HELP}`;
    if (err.code === 'offline') return `Couldn't reach the sheet script. ${LINK_HELP}`;
    if (err.code === 'busy' || err.code === 'server') return 'The sheet script was busy. Sync will try again.';
    if (err.code === 'missing_tab') return err.message;
    return `Sheet script: ${err.message}`;
  }
  return String(err?.message || err);
}

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
  if (!connected()) return paintSync();
  if (syncing) {
    syncQueued = true;
    return;
  }
  if (!navigator.onLine) return paintSync();
  syncing = true;
  paintSync();
  try {
    const result = await syncOnce(store, { api: bridge() });
    d.lastSyncAt = nowIso();
    d.lastError = '';
    connectionLost = false;
    if (result.superseded) {
      toast(`${result.superseded} older edit${result.superseded > 1 ? 's were' : ' was'} replaced by newer changes`);
    }
  } catch (err) {
    // No connection is not an error to show: the edits are safe in the outbox and sync retries.
    connectionLost = err instanceof BridgeError && err.code === 'offline';
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
  if (!isBridgeUrl(d.bridgeUrl)) {
    d.lastError = 'The link should look like https://script.google.com/macros/s/…/exec';
    store.save();
    paintSync();
    return;
  }
  if (!d.bridgeKey) {
    toast('Paste the key from the sheet script');
    return;
  }
  try {
    const title = await bridge().ping();
    d.lastError = '';
    connectionLost = false;
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
  d.bridgeUrl = String(f.get('bridgeUrl') || '').trim();
  const key = String(f.get('bridgeKey') || '').trim();
  if (key) d.bridgeKey = key;
  store.save();
  connect();
}

function saveProfile(form) {
  const f = new FormData(form);
  let changed = 0;
  undo.group('Saved what Claude looks for', () => {
    for (const key of PROFILE_KEYS) {
      const value = String(f.get(key) || '').trim();
      if (value === store.setting(key)) continue;
      write('settings', { key, value });
      changed += 1;
    }
  });
  paintUndo();
  toast(changed ? 'Saved' : 'Nothing changed', { undo: changed > 0 });
}

// Removes the link and key from this device only. Data and queued changes stay here.
function forgetLink() {
  const d = store.data.device;
  d.bridgeUrl = '';
  d.bridgeKey = '';
  d.lastError = '';
  connectionLost = false;
  store.save();
  render();
  toast('Link and key removed from this device. Your data stays here.');
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

// Background syncs must not wipe a half-typed form, so they wait until focus leaves the view,
// and while a new task has a title typed in.
const hasDraft = () => [...document.querySelectorAll('#view form.quick input[name=title]')].some((i) => i.value.trim());
const editingInView = () => {
  const a = document.activeElement;
  const inForm = !!a && !!a.closest?.('#view') && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || !!a.closest('form'));
  return inForm || hasDraft();
};
let deferredRender = false;

// A new task's fields survive a re-render of the same page (sort change, filter, sync).
function saveDrafts() {
  return [...document.querySelectorAll('#view form.quick[data-form=quick]')].map((f) => ({
    open: f.classList.contains('open'),
    title: f.querySelector('input[name=title]')?.value || '',
    date: f.querySelector('[data-date-text]')?.value || '',
    imp: f.querySelector('select[name=importance]')?.value || '',
    tags: [...f.querySelectorAll('.tchip[aria-pressed=true]')].map((b) => b.dataset.tag),
    newTag: f.querySelector('[data-tag-new]')?.value || '',
  }));
}

function restoreDrafts(drafts) {
  document.querySelectorAll('#view form.quick[data-form=quick]').forEach((f, i) => {
    const d = drafts[i];
    if (!d || !(d.title || d.date || d.tags.length || d.newTag)) return;
    if (d.open) f.classList.add('open');
    f.querySelector('input[name=title]').value = d.title;
    const field = f.querySelector('[data-datef]');
    if (field && d.date) {
      field.querySelector('[data-date-text]').value = d.date;
      const r = parseDateInput(d.date, today());
      setDate(field, r.key, { fromText: true, error: r.error });
    }
    if (d.imp) f.querySelector('select[name=importance]').value = d.imp;
    const tf = f.querySelector('[data-tagf]');
    if (tf) {
      tf.querySelector('[data-tag-new]').value = d.newTag;
      if (d.tags.length) {
        tf.querySelector('[data-tag-new]').value = d.tags.join(', ');
        commitTag(tf);
        tf.querySelector('[data-tag-new]').value = d.newTag;
      }
    }
  });
}

let lastRoute = '';
function render({ keepDrafts = true } = {}) {
  const r = currentRoute();
  document.body.dataset.route = r;
  document.querySelectorAll('[data-route]').forEach((a) => {
    const on = a.dataset.route === r;
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  deferredRender = false;
  const drafts = keepDrafts && r === lastRoute ? saveDrafts() : [];
  lastRoute = r;
  $('#view').innerHTML = VIEWS[r]();
  restoreDrafts(drafts);
  paintSync();
  paintUndo();
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
    if (!t) return;
    write('tasks', { ...t, deletedAt: nowIso() }, 'Deleted task');
    render();
    return toast(`Deleted “${t.title.slice(0, 40)}”`, { undo: true });
  }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const { act, id } = el.dataset;
  if (act === 'undo') return undoLast();
  if (act === 'sort') { prefs.sort = el.dataset.sort; savePrefs(); return render(); }
  if (act === 'theme' || act === 'accent') {
    prefs[act] = el.dataset.v;
    savePrefs();
    applyLook();
    return render();
  }
  if (act === 'date-set') return setDate(el.closest('[data-datef]'), el.dataset.key);
  if (act === 'date-cal') {
    const field = el.closest('[data-datef]');
    const native = field.querySelector('[data-date-native]');
    native.value = field.querySelector('input[type=hidden]').value || today();
    try { native.showPicker(); } catch { native.focus(); native.click(); }
    return;
  }
  if (act === 'tag-toggle') {
    el.setAttribute('aria-pressed', String(el.getAttribute('aria-pressed') !== 'true'));
    return syncTags(el.closest('[data-tagf]'));
  }
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
    write('picks', { ...p, status: isSaved(p) ? 'new' : 'useful' }, isSaved(p) ? 'Unsaved pick' : 'Saved pick');
    return render();
  }
  if (act === 'pick-dismiss') {
    const p = livePicks().find((x) => x.id === id);
    if (!p) return;
    write('picks', { ...p, status: 'dismissed' }, 'Dismissed pick');
    render();
    return toast('Pick dismissed', { undo: true });
  }
  if (act === 'pick-task') { ui.openPick = ui.openPick === id ? null : id; return render(); }
  if (act === 'sync-now') return runSync();
  if (act === 'forget-link') return forgetLink();
  if (act === 'export') return exportBackup();
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.matches?.('[data-date-native]')) {
    if (t.value) setDate(t.closest('[data-datef]'), t.value);
    return;
  }
  if (t.dataset && t.dataset.done) {
    const task = store.rows('tasks').find((x) => x.id === t.dataset.done);
    if (task) {
      write('tasks', { ...task, status: t.checked ? 'done' : 'open', doneAt: t.checked ? nowIso() : '' }, t.checked ? 'Completed task' : 'Reopened task');
      render();
      if (t.checked) toast(`Done: “${task.title.slice(0, 40)}”`, { undo: true });
    }
    return;
  }
  if (t.form && t.form.id === 'log') onLog(t.form);
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.matches?.('[data-date-text]')) {
    const r = parseDateInput(t.value, today());
    return setDate(t.closest('[data-datef]'), r.key, { fromText: true, error: r.error });
  }
  if (t.matches?.('[data-tag-new]')) {
    const field = t.closest('[data-tagf]');
    if (/[,;]/.test(t.value)) return commitTag(field);
    return filterTags(field, t.value);
  }
  if (t.name === 'title' && t.form?.matches('form.quick')) t.form.classList.add('open');
  if (t.form && t.form.id === 'log') onLog(t.form);
});

// On Home the date, importance and tag fields appear once you start a task.
document.addEventListener('focusin', (e) => {
  const f = e.target.closest?.('form.quick');
  if (f && e.target.name === 'title') f.classList.add('open');
});

document.addEventListener('keydown', (e) => {
  const t = e.target;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable;
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z' && !typing) {
    e.preventDefault();
    return undoLast();
  }
  if (t.matches?.('[data-tag-new]') && e.key === 'Enter' && t.value.trim()) {
    e.preventDefault();
    return commitTag(t.closest('[data-tagf]'));
  }
  if (e.key === 'Escape' && t.closest?.('form.quick:not(.always)') && !hasDraft()) {
    t.closest('form.quick').classList.remove('open');
    t.blur();
  }
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
  paintUndo();
  if (connected()) runSync();
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
