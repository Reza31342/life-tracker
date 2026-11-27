import { Store, newId } from './store.js';
import {
  APP_TABS, PICK_STATUSES, SchemaError, ms, isDateKey, dayDiff, shiftDay,
  logicalDay, clockAt, minutesAt,
} from './schema.js';
import { createBridge, isBridgeUrl, BridgeError } from './bridge.js';
import { syncOnce } from './sync.js';
import { typed, longDate, weekdayOf } from './dates.js';
import { parseRanges, rangesTotal, parseDuration, fmtHM } from './time.js';
import { UndoHistory } from './undo.js';
import { BOARD_KEY, BOARD_MAX, parseBoard, serializeBoard, mountBoard } from './board.js';


const store = new Store(localStorage);
const undo = new UndoHistory();
// logDay: the day shown in the Today card ('' = today, follows the date when it changes).
const ui = { pickTab: 'current', pickKind: 'paper', openPick: null, taskTag: 'all', logSaved: '', logDay: '' };

// Look and task sort order: per device, not synced.
const PREFS_KEY = 'life-tracker.prefs';
const prefs = (() => {
  const base = { theme: 'light', accent: 'ink', sort: 'urgency', taskLayout: 'list', boardView: { x: 40, y: 40, z: 1 } };
  try { return { ...base, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return base; }
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
// The cigarette counter on Home is off unless the sheet's settings tab says show_cigarettes = on.
// Off hides it only; the cigs tab and its data stay as they are.
const CIGS_KEY = 'show_cigarettes';
const cigsOnHome = () => /^(on|true|yes|1)$/i.test(store.setting(CIGS_KEY, 'off').trim());
const cigsOn = (key) => liveCigs().filter((c) => c.day === key).sort((a, b) => ms(a.at) - ms(b.at));
const lastDays = (n) => Array.from({ length: n }, (_, i) => shiftDay(today(), i - (n - 1)));

/* ---------- sleep ---------- */

// Sleep blocks, read leniently (time.js). The longest block is the main sleep.
const parseSleep = (text) => parseRanges(text).blocks;

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

const PENCIL = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M13.6 3.6a1.8 1.8 0 0 1 2.6 2.6L7.4 15 4 16l1-3.4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M12.2 5l2.8 2.8" stroke="currentColor" stroke-width="1.5"/></svg>';
const SPARKLE = '<svg class="spark" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l1.4 4.1L13.5 7 9.4 8.4 8 12.5 6.6 8.4 2.5 7l4.1-1.4z"/><path d="M13 11.2l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z"/></svg>';

function taskRow(t, opts) {
  const done = t.status === 'done';
  const must = !done && t.importance === 'MUST DO' && !t.claudeDecides;
  const overdue = !done && urgency(t) === 0;
  const hide = opts?.hideTag;
  const tags = (t.tags || []).filter((x) => x !== hide).map((x) => `<span class="tag">#${esc(x)}</span>`).join('');
  const imp = t.claudeDecides
    ? `<span class="imp pending" title="Waiting for Claude to decide">${SPARKLE}Claude decides</span>`
    : `<span class="imp">${esc(t.importance || '')}</span>`;
  return `<li class="task${done ? ' done' : ''}${must ? ' must' : ''}${overdue ? ' overdue' : ''}">
    <input type="checkbox" data-done="${esc(t.id)}"${done ? ' checked' : ''} aria-label="Done: ${esc(t.title)}">
    <div><div class="ttl" data-act="edit-task" data-id="${esc(t.id)}">${esc(t.title)}</div>
      <div class="tm">${done ? '' : dueChip(t.deadline)}${tags}</div></div>
    ${imp}
    <button class="ed" type="button" data-act="edit-task" data-id="${esc(t.id)}" aria-label="Edit task">${PENCIL}</button>
    <button class="x" type="button" data-del="${esc(t.id)}" aria-label="Delete task">×</button>
  </li>`;
}

const CAL_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4.5" width="14" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3 8.5h14M7 2.8v3.4M13 2.8v3.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

// Deadline: a button that opens a small month calendar (Monday first). Dates show day first,
// for example "Tue 24.11.2026". The hidden input holds the date the form submits (YYYY-MM-DD).
const WD_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dateLabel = (key) => (isDateKey(key) ? `${WD_SHORT[weekdayOf(key)]} ${typed(key)}` : 'No deadline');

function dateField(name = 'deadline', label = 'Deadline', value = '') {
  const v = isDateKey(value) ? value : '';
  return `<div class="datef" data-datef>
    <span class="lbl">${label}</span>
    <div class="date-row">
      <button type="button" class="date-btn${v ? '' : ' empty'}" data-act="cal-toggle" aria-haspopup="dialog" aria-expanded="false">${CAL_ICON}<span class="date-val">${dateLabel(v)}</span></button>
      <button type="button" class="date-clear" data-act="cal-clear" aria-label="Remove deadline"${v ? '' : ' hidden'}>×</button>
    </div>
    <input type="hidden" name="${name}" value="${v}">
    <div class="cal-pop" role="dialog" aria-label="Choose a date" hidden></div>
  </div>`;
}

function setDate(field, key) {
  const v = isDateKey(key) ? key : '';
  field.querySelector('input[type=hidden]').value = v;
  field.querySelector('.date-val').textContent = dateLabel(v);
  field.querySelector('.date-btn').classList.toggle('empty', !v);
  field.querySelector('.date-clear').hidden = !v;
  closeCal(field);
}

function calGrid(field) {
  const sel = field.querySelector('input[type=hidden]').value;
  const month = field.dataset.month;
  const [y, m] = month.split('-').map(Number);
  const first = `${month}-01`;
  const lead = (weekdayOf(first) + 6) % 7; // Monday first
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const t = today();
  const cells = Array.from({ length: lead }, () => '<span></span>');
  for (let d = 1; d <= days; d += 1) {
    const key = `${month}-${pad(d)}`;
    const cls = [key === t && 'today', key === sel && 'sel', key < t && 'past'].filter(Boolean).join(' ');
    cells.push(`<button type="button" class="${cls}" data-act="cal-day" data-key="${key}" aria-label="${dateLabel(key)}"${key === sel ? ' aria-pressed="true"' : ''}>${d}</button>`);
  }
  return `<div class="cal-head">
      <button type="button" data-act="cal-prev" aria-label="Previous month">‹</button>
      <span>${MONTH_NAMES[m - 1]} ${y}</span>
      <button type="button" data-act="cal-next" aria-label="Next month">›</button>
    </div>
    <div class="cal-wd">${['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((w) => `<span>${w}</span>`).join('')}</div>
    <div class="cal-days">${cells.join('')}</div>
    <div class="cal-foot">
      <button type="button" data-act="cal-day" data-key="${t}">Today</button>
      <button type="button" data-act="cal-day" data-key="${shiftDay(t, 1)}">Tomorrow</button>
      <button type="button" data-act="cal-clear">No deadline</button>
    </div>`;
}

function openCal(field) {
  closeAllCals();
  const sel = field.querySelector('input[type=hidden]').value;
  field.dataset.month = (sel || today()).slice(0, 7);
  const pop = field.querySelector('.cal-pop');
  pop.innerHTML = calGrid(field);
  pop.hidden = false;
  field.querySelector('.date-btn').setAttribute('aria-expanded', 'true');
  pop.scrollIntoView?.({ block: 'nearest' });
}

function moveCal(field, n) {
  const [y, m] = field.dataset.month.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  field.dataset.month = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}`;
  field.querySelector('.cal-pop').innerHTML = calGrid(field);
}

function closeCal(field) {
  const pop = field.querySelector('.cal-pop');
  if (!pop || pop.hidden) return;
  pop.hidden = true;
  pop.innerHTML = '';
  field.querySelector('.date-btn').setAttribute('aria-expanded', 'false');
}

const closeAllCals = () => document.querySelectorAll('[data-datef]').forEach(closeCal);

function importanceSelect(current = 'Medium') {
  return `<label class="impf"><span class="lbl">Importance</span><select name="importance">${IMP.map((i) =>
    `<option${i === current ? ' selected' : ''}>${i}</option>`).join('')}<option value="${CLAUDE}"${current === CLAUDE ? ' selected' : ''}>✨ Let Claude decide</option></select></label>`;
}

// Tags: type a new one (Enter or comma adds it), or tap one you used before. All of them are
// listed under the box; typing narrows the list, which helps avoid spelling variants.
function tagField(selected = []) {
  const known = [...new Set([...knownTags(), ...selected])];
  return `<div class="tagf" data-tagf>
    <span class="lbl">Tags</span>
    <input class="tag-new" data-tag-new placeholder="${known.length ? 'type a new tag, or tap one below' : 'type a tag, e.g. study, then Enter'}" autocomplete="off" spellcheck="false" aria-label="New tag">
    <div class="tag-pick">${known.map((g) =>
      `<button type="button" class="tchip" data-act="tag-toggle" data-tag="${esc(g)}" aria-pressed="${selected.includes(g)}">#${esc(g)}</button>`).join('')}</div>
    <input type="hidden" name="tags" value="${esc(selected.join(', '))}">
  </div>`;
}

function syncTags(field) {
  const on = [...field.querySelectorAll('.tchip[aria-pressed=true]')].map((b) => b.dataset.tag);
  field.querySelector('input[name=tags]').value = on.join(', ');
}

// Adds what is typed in the new-tag box as a selected chip, or selects the matching existing one.
function commitTag(field) {
  const box = field.querySelector('[data-tag-new]');
  const list = field.querySelector('.tag-pick');
  for (const tag of parseTags(box.value)) {
    let chip = [...field.querySelectorAll('.tchip')].find((b) => b.dataset.tag === tag);
    if (!chip) {
      chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tchip';
      chip.dataset.act = 'tag-toggle';
      chip.dataset.tag = tag;
      chip.textContent = `#${tag}`;
      list.append(chip);
    }
    chip.setAttribute('aria-pressed', 'true');
  }
  box.value = '';
  filterTags(field, '');
  syncTags(field);
}

function filterTags(field, text) {
  const q = parseTags(text)[0] || '';
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

const formDeadline = (form) => {
  const v = form.querySelector('[data-datef] input[type=hidden]')?.value || '';
  return isDateKey(v) ? v : '';
};

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

function newTaskFrom(form) {
  const f = new FormData(form);
  const title = String(f.get('title') || '').trim();
  if (!title) return null;
  return {
    id: newId(),
    title: title.slice(0, 300),
    description: String(f.get('description') || '').trim(),
    tags: formTags(form),
    ...formImportance(form),
    deadline: formDeadline(form),
    status: 'open',
    sourcePick: '',
    createdAt: nowIso(),
    doneAt: '',
    deletedAt: '',
  };
}

function addTask(form) {
  const rec = newTaskFrom(form);
  if (!rec) return;
  const title = rec.title;
  write('tasks', rec, 'Added task');
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
  const byTag = prefs.taskLayout === 'tags';
  const layout = `<div class="seg-tabs layout-switch" role="group" aria-label="Layout">${[['list', 'List'], ['tags', 'By tag']].map(([v, l]) =>
    `<button type="button" data-act="task-layout" data-v="${v}" aria-pressed="${(byTag ? 'tags' : 'list') === v}">${l}</button>`).join('')}</div>`;
  const listHtml = byTag
    ? tagBoxes(list, filt)
    : `<section class="card" style="padding:6px 20px">
      <ul class="tasks">${list.map(taskRow).join('') || '<li class="empty">Nothing here.</li>'}</ul>
    </section>`;
  return `
  <div class="tasks-page${byTag ? ' by-tag' : ''}">
    <header class="page-head"><h1>Tasks</h1><div class="head-side"><span class="muted">${open.length} open</span>${layout}</div></header>
    <section class="card">
      ${quickForm({ open: true })}
    </section>
    <div class="list-bar">
      <div class="filters">${chips.map((f) =>
        `<button type="button" data-act="task-filter" data-tag="${esc(f)}" aria-pressed="${filt === f}">${chipLabel(f)}</button>`).join('')}</div>
      ${sortControl()}
    </div>
    ${listHtml}
    <details class="card" style="margin-top:16px">
      <summary style="cursor:pointer">Completed (${done.length})</summary>
      <ul class="tasks" style="margin-top:8px">${done.map(taskRow).join('')}</ul>
    </details>
  </div>`;
}

// "By tag" layout: one box per tag (a task with two tags shows in both), plus "No tag".
// Every box follows the page's sort and filter; its + opens a new task with that tag.
const TAG_HUES = [18, 38, 82, 142, 172, 198, 222, 256, 288, 332];
const tagHue = (tag) => {
  let h = 0;
  for (const ch of tag) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return TAG_HUES[h % TAG_HUES.length];
};

function tagBoxes(list, filt) {
  const groups = new Map();
  for (const t of list) {
    const own = t.tags?.length ? t.tags : [''];
    for (const g of own) {
      if (filt !== 'all' && filt !== 'urgent' && filt !== '~claude' && g !== filt) continue;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(t);
    }
  }
  const keys = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
  if (!keys.length) return '<section class="card"><p class="empty" style="margin:0">Nothing here.</p></section>';
  return `<div class="tag-boxes">${keys.map((g, i) => {
    const items = groups.get(g);
    const name = g ? `#${esc(g)}` : 'No tag';
    const style = g ? ` style="--tint:hsl(${tagHue(g)} 55% 50%)"` : '';
    return `<section class="card tag-box${g ? '' : ' untagged'}" data-i="${i}"${style}>
      <div class="tb-head"><h3>${name}</h3><span class="tb-n">${items.length}</span>
        <button type="button" class="tb-add" data-act="new-in-tag" data-tag="${esc(g)}" aria-label="New task in ${name}" title="New task in ${name}">+</button></div>
      <ul class="tasks">${items.map((t) => taskRow(t, { hideTag: g })).join('')}</ul>
    </section>`;
  }).join('')}</div>`;
}

// Spreads the boxes over as many columns as fit (each at least 320px wide). In alphabetical order,
// each box goes under the column that is shortest so far, so there are no gaps and the columns
// end up close in height. Runs after every render and when the window size changes.
function layoutTagBoxes() {
  const wrap = document.querySelector('.tag-boxes');
  if (!wrap) return;
  const boxes = [...wrap.querySelectorAll('.tag-box')].sort((a, b) => a.dataset.i - b.dataset.i);
  const gap = 16;
  const n = Math.max(1, Math.floor((wrap.clientWidth + gap) / (320 + gap)));
  const cols = Array.from({ length: n }, () => Object.assign(document.createElement('div'), { className: 'tb-col' }));
  wrap.style.setProperty('--n', n);
  wrap.replaceChildren(...cols);
  const heights = new Array(n).fill(0);
  for (const box of boxes) {
    const i = heights.indexOf(Math.min(...heights));
    cols[i].append(box);
    heights[i] += box.offsetHeight + gap;
  }
}

/* ---------- home ---------- */

const DURATIONS = [['studyMin', 'Study'], ['choresMin', 'Chores'], ['walkingMin', 'Walk'], ['gymMin', 'Gym']];

// The total next to sleep or work. Parts that can't be read are still saved as typed, and get a
// small "?" that explains this on hover or tap.
function rangeTotalHtml(text, opts) {
  const { blocks, bad } = parseRanges(text, opts);
  const tot = blocks.reduce((sum, b) => sum + b.dur, 0);
  return `${blocks.length ? fmtDur(tot) : ''}${bad ? `<span class="warn" title="Part of this isn't a from-to time. It's saved as typed; Claude can tidy it later.">?</span>` : ''}`;
}

// The day the Today card shows and edits. Never later than today.
const logDay = () => (ui.logDay && ui.logDay < today() ? ui.logDay : today());

function dayTitle(key) {
  const t = today();
  if (key === t) return 'Today';
  if (key === shiftDay(t, -1)) return 'Yesterday';
  return `${WD_SHORT[weekdayOf(key)]} ${Number(key.slice(8, 10))}.${Number(key.slice(5, 7))}.${key.slice(0, 4) === t.slice(0, 4) ? '' : key.slice(0, 4)}`;
}

function logCard() {
  const key = logDay();
  const isToday = key === today();
  const r = dayMap().get(key) || {};
  const radios = (name, cur, max = 5) => Array.from({ length: max }, (_, i) => i + 1).map((n) =>
    `<label><input type="radio" name="${name}" value="${n}"${cur === n ? ' checked' : ''}><span>${n}</span></label>`).join('');
  const dur = ([name, label]) => `<div class="trow dur">
      <label for="f-${name}">${label}</label>
      <input id="f-${name}" name="${name}" inputmode="decimal" placeholder="h:mm" value="${fmtHM(r[name] ?? null)}" autocomplete="off" spellcheck="false">
      <button type="button" class="step" data-act="dur-add" data-name="${name}" data-add="15" aria-label="Add 15 minutes to ${label}">+15m</button>
      <button type="button" class="step" data-act="dur-add" data-name="${name}" data-add="60" aria-label="Add one hour to ${label}">+1h</button>
    </div>`;
  return `<form class="card log${isToday ? '' : ' past'}" id="log" autocomplete="off" data-day="${key}">
    <div class="card-head">
      <div class="day-nav">
        <button type="button" class="dn" data-act="day-prev" aria-label="Previous day">‹</button>
        <h2 title="${longDate(key)}">${dayTitle(key)}</h2>
        <button type="button" class="dn" data-act="day-next" aria-label="Next day"${isToday ? ' disabled' : ''}>›</button>
      </div>
      <span class="log-side">${isToday ? '' : '<button type="button" class="to-today" data-act="day-today">Back to today</button>'}<span class="muted small" id="log-state">${esc(ui.logSaved)}</span></span>
    </div>
    <section class="sec">
      <div class="sec-h"><h3>Sleep</h3><span class="tot" id="sleep-tot">${rangeTotalHtml(r.sleep)}</span></div>
      <input name="sleep" value="${esc(r.sleep)}" placeholder="23:30-7:15, 14-15" spellcheck="false" aria-label="Sleep, from-to">
      <div class="scale"><span>Quality</span><div class="dots">${radios('sleepQuality', r.sleepQuality)}</div></div>
    </section>
    <section class="sec">
      <div class="sec-h"><h3>Time</h3><span class="muted small">h:mm</span></div>
      <div class="trow work"><label for="f-work">Work</label><input id="f-work" name="work" value="${esc(r.work)}" placeholder="9-12:30, 13:30-18" spellcheck="false"><span class="tot" id="work-tot">${rangeTotalHtml(r.work, { daytime: true })}</span></div>
      ${DURATIONS.map(dur).join('')}
    </section>
    <section class="sec">
      <div class="sec-h"><h3>Feeling</h3></div>
      <div class="scale"><span>Energy</span><div class="dots">${radios('energy', r.energy)}</div></div>
      <div class="scale ten"><span>Mood</span><div class="dots ten">${radios('mood', r.mood, 10)}</div></div>
    </section>
    <section class="sec note">
      <div class="sec-h"><h3>Note</h3></div>
      <textarea name="note" rows="3" aria-label="Note" placeholder="Anything. Enter starts a new line.">${esc(r.note)}</textarea>
    </section>
  </form>`;
}

// Saves the whole day on every change. Sleep and work are saved exactly as typed; a duration
// that can't be read keeps its last value until it can.
const FIELD_NAMES = { sleep: 'sleep', sleepQuality: 'sleep quality', work: 'work', studyMin: 'study', choresMin: 'chores', walkingMin: 'walk', gymMin: 'gym', energy: 'energy', mood: 'mood', note: 'note' };

// field: the input that changed. Typing in one field merges into one undo step; another field
// or another day starts a new step.
function onLog(form, field = '') {
  const f = new FormData(form);
  const key = isDateKey(form.dataset.day) ? form.dataset.day : logDay();
  const prev = dayMap().get(key) || {};
  const sleep = String(f.get('sleep') || '').trim();
  const work = String(f.get('work') || '').trim();
  let unreadable = 0;
  const durations = Object.fromEntries(DURATIONS.map(([name]) => {
    const r = parseDuration(f.get(name));
    form.querySelector(`[name=${name}]`)?.classList.toggle('bad', !!r.error);
    if (r.error) unreadable += 1;
    return [name, r.error ? (prev[name] ?? null) : r.min];
  }));
  write('days', {
    ...prev,
    date: key,
    sleep,
    sleepQuality: wholeNum(f.get('sleepQuality'), 1, 5),
    work,
    ...durations,
    gymType: prev.gymType || '',
    energy: wholeNum(f.get('energy'), 1, 5),
    mood: wholeNum(f.get('mood'), 1, 10),
    note: String(f.get('note') || '').replace(/\s+$/, ''),
  }, `${key === today() ? 'Edited Today' : `Edited ${dayTitle(key)}`}${FIELD_NAMES[field] ? ` (${FIELD_NAMES[field]})` : ''}`);
  ui.logSaved = unreadable ? 'times: use h:mm, e.g. 2:45' : `saved ${clockAt(new Date())}`;
  const st = document.getElementById('log-state');
  if (st) st.textContent = ui.logSaved;
  const s = document.getElementById('sleep-tot');
  if (s) s.innerHTML = rangeTotalHtml(sleep);
  const w = document.getElementById('work-tot');
  if (w) w.innerHTML = rangeTotalHtml(work, { daytime: true });
}

// Reserved space on Home: a sentence or a small picture, to be decided.
// The Home card shows a sentence and/or a small picture from the sheet's settings tab
// (home_sentence, home_image), so each person's own sheet decides what it says. The picture is
// a small data:image/…;base64 value kept in the cell itself (private, it travels with the sheet),
// or an https:// link. Anything else is ignored.
const HOME_IMG = /^(data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+=*|https:\/\/[^\s"'<>]+)$/i;
const homeImage = () => {
  const v = store.setting('home_image').replace(/\s+/g, '');
  return HOME_IMG.test(v) ? v : '';
};

function spotCard() {
  const text = store.setting('home_sentence').trim();
  const img = homeImage();
  if (!text && !img) {
    return `<section class="card spot" id="spot" aria-label="Home card">
    <p>A sentence or a small picture goes here.</p>
    <span class="muted small">set home_sentence and home_image in the sheet's settings tab</span>
  </section>`;
  }
  const kind = img && text ? '' : img ? ' img-only' : ' text-only';
  return `<section class="card home-note${kind}" id="spot">
    ${img ? `<button type="button" class="home-pic" data-act="photo-open" aria-label="Open the picture"><img src="${esc(img)}" alt="" decoding="async"></button>` : ''}
    ${text ? `<p>${esc(text)}</p>` : ''}
  </section>`;
}

// The Home card's picture, large, in a pop-up. Closes with ×, Esc, or a tap outside the picture.
function openPhoto() {
  const img = homeImage();
  if (!img) return;
  let dlg = $('#photo');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'photo';
    dlg.className = 'photo-dialog';
    dlg.setAttribute('aria-label', 'Picture');
    document.body.append(dlg);
  }
  const text = store.setting('home_sentence').trim();
  dlg.innerHTML = `<button type="button" class="photo-x" data-act="photo-close" aria-label="Close">×</button>
    <img src="${esc(img)}" alt="">
    ${text ? `<p>${esc(text)}</p>` : ''}`;
  dlg.showModal();
}
function closePhoto() {
  const dlg = $('#photo');
  if (dlg?.open) dlg.close();
}

// The counter follows the day chosen in the Today card. A cigarette added later for a past day
// keeps the moment it was entered in `at`, so it has no real clock time: it is counted for that
// day but shown as "added later" and left out of the first-of-day time.
const addedLater = (c) => logicalDay(new Date(c.at)) > c.day;

function cigInner() {
  const key = logDay();
  const isToday = key === today();
  const list = cigsOn(key);
  const timed = list.filter((c) => !addedLater(c));
  const later = list.length - timed.length;
  const sl = sleepSummary(dayMap().get(key)?.sleep);
  const first = timed[0];
  let wake = '';
  if (first && sl) wake = ` · ${fmtDur((minutesAt(first.at) - sl.main.end + 1440) % 1440)} after waking`;
  const chips = timed.slice(-6).map((c) => `<span>${clockAt(c.at)}</span>`);
  if (later) chips.push(`<span>${later} added later</span>`);
  const times = chips.join('') || `<span>${isToday ? 'none yet' : 'none'}</span>`;
  const day = isToday ? '' : ` · <span class="cig-day">${esc(dayTitle(key))}</span>`;
  return `<div class="card-head"><h2>Cigarettes${day}</h2><span class="big-n">${list.length}</span></div>
    <div class="cig-row">
      <button class="tap" type="button" data-act="cig-add" aria-label="Log one cigarette${isToday ? '' : ` for ${esc(dayTitle(key))}`}">+1</button>
      <div class="times">${times}</div>
      <button class="ghost" type="button" data-act="cig-undo"${list.length ? '' : ' disabled'}>undo</button>
    </div>
    <p class="muted small" style="margin:12px 0 0">${first ? `first at ${clockAt(first.at)}${wake}` : 'first at —'} · week ${weekStats().cigsPerDay}/day</p>`;
}

const cigCard = () => `<section class="card cig${logDay() === today() ? '' : ' past'}" id="cigs">${cigInner()}</section>`;
function paintCigs() {
  const el = document.getElementById('cigs');
  if (el) el.outerHTML = cigCard();
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

const KIND_ONE = { paper: 'Paper', podcast: 'Podcast', event: 'Event', job: 'Job' };

function miniPick(p) {
  const url = safeUrl(p.url);
  const meta = [p.source, p.date && `on ${p.date}`, p.deadline && `apply by ${p.deadline}`].filter(Boolean).map(esc).join(' · ');
  const title = url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(p.title)}</a>` : esc(p.title);
  return `<li class="mp">
    <span class="kbadge k-${esc(p.kind)}">${esc(KIND_ONE[p.kind] || p.kind)}</span>
    <div class="mp-body"><div class="mp-title">${title}</div>${meta ? `<div class="mp-meta">${meta}</div>` : ''}</div>
  </li>`;
}

function viewHome() {
  const open = liveTasks().filter((t) => t.status !== 'done');
  const sorted = sortTasks(open);
  const part = minutesAt(new Date()) < 720 ? 'morning' : minutesAt(new Date()) < 1080 ? 'afternoon' : 'evening';
  const picks = livePicks().filter(isCurrent).sort(byRank).slice(0, 4);
  return `
  <header class="hero">
    <p class="eyebrow">${parseDay(today()).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
    <h1>Good ${part}<em>.</em></h1>
  </header>
  <div class="home">
    <div class="side${cigsOnHome() ? ' with-cigs' : ''}">
      ${logCard()}
      ${cigsOnHome() ? cigCard() : ''}
      ${spotCard()}
      <section class="card picks-card">
        <div class="card-head"><h2>Picks</h2><a class="link" href="#picks">open →</a></div>
        <ol class="mini-picks">${picks.map(miniPick).join('') || '<li class="muted">No current picks.</li>'}</ol>
      </section>
    </div>
    <section class="card focus">
      <div class="card-head"><h2>Tasks</h2>${sortControl()}<a class="link" href="#tasks">all →</a></div>
      <ul class="tasks">${sorted.slice(0, 12).map(taskRow).join('') || '<li class="empty">Nothing open.</li>'}</ul>
      ${sorted.length > 12 ? `<a class="more" href="#tasks">+${sorted.length - 12} more</a>` : ''}
      ${quickForm()}
    </section>
  </div>`;
}

// Overdue, due today and open, in the top bar on every page.
function paintCounts() {
  const el = $('#counts');
  if (!el) return;
  const open = liveTasks().filter((t) => t.status !== 'done');
  const overdue = open.filter((t) => urgency(t) === 0).length;
  const dueToday = open.filter((t) => urgency(t) === 1).length;
  el.innerHTML = `<span class="${overdue ? 'hot' : ''}"><b>${overdue}</b> overdue</span><span><b>${dueToday}</b> due today</span><span><b>${open.length}</b> open</span>`;
}

/* ---------- edit a task ---------- */

// A pop-up with every field of one task. It lives outside the page view, so a sync that
// redraws the page does not close it.
function openEdit(id) {
  const t = liveTasks().find((x) => x.id === id);
  const dlg = $('#edit');
  if (!t || !dlg) return;
  const imp = t.claudeDecides ? CLAUDE : (IMP.includes(t.importance) ? t.importance : 'Medium');
  dlg.innerHTML = `<form id="edit-form" class="quick open always edit-form" data-id="${esc(t.id)}" autocomplete="off">
    <div class="edit-head"><h2 id="edit-title">Edit task</h2><button type="button" class="x" data-act="edit-close" aria-label="Close">×</button></div>
    <label class="ef"><span class="lbl">Title</span><input name="title" required maxlength="300" value="${esc(t.title)}"></label>
    <label class="ef"><span class="lbl">Description</span><textarea name="description" rows="3" placeholder="Optional">${esc(t.description)}</textarea></label>
    <div class="q-more">${dateField('deadline', 'Deadline', t.deadline)}${importanceSelect(imp)}${tagField(t.tags || [])}</div>
    <label class="ef done-check"><input type="checkbox" name="done"${t.status === 'done' ? ' checked' : ''}> Done</label>
    <div class="edit-foot">
      <button type="button" class="ghost danger" data-act="edit-delete">Delete</button>
      <span class="grow"></span>
      <button type="button" class="ghost" data-act="edit-close">Cancel</button>
      <button type="submit" class="primary">Save</button>
    </div>
  </form>`;
  dlg.showModal();
  if (window.matchMedia?.('(min-width: 901px)').matches) dlg.querySelector('input[name=title]').focus();
}

function openNewTask(tag = '') {
  const dlg = $('#edit');
  if (!dlg) return;
  const where = tag ? ` in #${esc(tag)}` : '';
  dlg.innerHTML = `<form id="edit-form" class="quick open always edit-form" data-new="1" autocomplete="off">
    <div class="edit-head"><h2 id="edit-title">New task${where}</h2><button type="button" class="x" data-act="edit-close" aria-label="Close">×</button></div>
    <label class="ef"><span class="lbl">Title</span><input name="title" required maxlength="300" placeholder="New task…"></label>
    <label class="ef"><span class="lbl">Description</span><textarea name="description" rows="2" placeholder="Optional"></textarea></label>
    <div class="q-more">${dateField()}${importanceSelect()}${tagField(tag ? [tag] : [])}</div>
    <div class="edit-foot">
      <span class="grow"></span>
      <button type="button" class="ghost" data-act="edit-close">Cancel</button>
      <button type="submit" class="primary">Add</button>
    </div>
  </form>`;
  dlg.showModal();
  dlg.querySelector('input[name=title]').focus();
}

function addFromDialog(form) {
  const rec = newTaskFrom(form);
  if (!rec) return;
  write('tasks', rec, 'Added task');
  closeEdit();
  render();
  toast(`Added “${rec.title.slice(0, 40)}”`, { undo: true });
}

function closeEdit() {
  const dlg = $('#edit');
  if (dlg?.open) dlg.close();
}

function saveEdit(form) {
  const t = store.rows('tasks').find((x) => x.id === form.dataset.id);
  if (!t) return closeEdit();
  const f = new FormData(form);
  const title = String(f.get('title') || '').trim();
  if (!title) return;
  const done = f.get('done') === 'on';
  write('tasks', {
    ...t,
    title: title.slice(0, 300),
    description: String(f.get('description') || '').trim(),
    deadline: formDeadline(form),
    ...formImportance(form),
    tags: formTags(form),
    status: done ? 'done' : 'open',
    doneAt: done ? (t.doneAt || nowIso()) : '',
  }, 'Edited task');
  closeEdit();
  render();
  toast('Task saved', { undo: true });
}

function deleteFromEdit() {
  const id = $('#edit-form')?.dataset.id;
  const t = store.rows('tasks').find((x) => x.id === id);
  closeEdit();
  if (!t) return;
  write('tasks', { ...t, deletedAt: nowIso() }, 'Deleted task');
  render();
  toast(`Deleted “${t.title.slice(0, 40)}”`, { undo: true });
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
  const sleepH = days.map((k) => { const s = sleepSummary(dm.get(k)?.sleep); return s ? +(s.total / 60).toFixed(1) : null; });
  const series = [
    { n: 'Energy', u: '/5', v: rec.map((r) => r?.energy ?? null), max: 5, c: 'var(--clay)', dec: 1, lowerBetter: false },
    { n: 'Walking', u: ' min', v: rec.map((r) => r?.walkingMin ?? null), max: null, c: 'var(--sage)', dec: 0, lowerBetter: false },
    { n: 'Study', u: ' h', v: rec.map((r) => (typeof r?.studyMin === 'number' ? +(r.studyMin / 60).toFixed(1) : null)), max: null, c: 'var(--ink)', dec: 1, lowerBetter: false },
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
  paintCounts();
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
      <section class="card home-prefs" style="display:grid;gap:14px">
        <h2>Home</h2>
        <div class="pref-row"><span class="lbl wide">Cigarette counter</span><div class="seg-tabs">${[['off', 'Off'], ['on', 'On']].map(([v, l]) =>
          `<button type="button" data-act="cigs-home" data-v="${v}" aria-pressed="${(cigsOnHome() ? 'on' : 'off') === v}">${l}</button>`).join('')}</div></div>
        <p class="muted small" style="margin:0">Saved in the sheet, so it's the same on all your devices. Off only hides the counter; past counts stay in the sheet.</p>
        <p class="muted small" style="margin:0">The sentence and picture on Home come from the sheet's settings tab (home_sentence, home_image). Ask Claude to change them.</p>
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

/* ---------- task whiteboard ---------- */

const readBoard = () => parseBoard(store.setting(BOARD_KEY, ''));
let boardCtl = null;

function boardItemHtml(it, tasks = taskMap()) {
  const pos = `left:${it.x}px;top:${it.y}px`;
  const bar = (btns) => `<div class="bi-bar">${btns.map(([a, l, t]) => `<button type="button" data-bact="${a}" title="${t}">${l}</button>`).join('')}</div>`;
  const handle = '<span class="bi-handle" title="Drag onto another card to draw an arrow"></span>';
  if (it.type === 'task') {
    const t = tasks.get(it.task);
    if (!t) return ''; // deleted task: its card (and arrows) stay saved but hidden
    const done = t.status === 'done';
    const tint = t.tags?.length ? ` style="${pos};--tint:hsl(${tagHue(t.tags[0])} 55% 50%)"` : ` style="${pos}"`;
    const imp = t.claudeDecides ? 'Claude decides' : t.importance === 'MUST DO' ? 'MUST DO' : '';
    return `<div class="bi bi-task${done ? ' done' : ''}${!done && urgency(t) === 0 ? ' overdue' : ''}" data-id="${esc(it.id)}"${tint}>
      ${bar([['edit', it.note ? 'Edit note' : 'Note', 'Write a note on this card'], ['open', 'Open', 'Open the task'], ['delete', 'Remove', 'Take it off the board (the task stays)']])}
      <input type="checkbox" data-done="${esc(t.id)}"${done ? ' checked' : ''} aria-label="Done: ${esc(t.title)}">
      <div class="bi-body"><div class="bi-title">${esc(t.title)}</div>
        <div class="bi-meta">${done ? '' : dueChip(t.deadline)}${imp ? `<span class="bi-imp">${esc(imp)}</span>` : ''}</div>
        ${it.note ? `<div class="bi-note">${esc(it.note)}</div>` : ''}</div>
      ${handle}
    </div>`;
  }
  const cls = it.type === 'note' ? 'bi-sticky' : 'bi-label';
  return `<div class="bi ${cls}" data-id="${esc(it.id)}" style="${pos}">
    ${bar([['edit', 'Edit', 'Edit the text'], ['delete', 'Delete', 'Delete']])}
    <div class="bi-body"><div class="bi-text">${esc(it.text || '')}</div></div>
    ${handle}
  </div>`;
}

const taskMap = () => new Map(liveTasks().map((t) => [t.id, t]));

function viewBoard() {
  const tasks = taskMap();
  const board = readBoard();
  const placed = new Set(board.items.filter((it) => it.type === 'task').map((it) => it.task));
  const open = sortTasks(liveTasks().filter((t) => t.status !== 'done'));
  const groups = new Map();
  for (const t of open) for (const g of (t.tags?.length ? t.tags : [''])) {
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
  const side = keys.map((g) => `<section class="bs-group"${g ? ` style="--tint:hsl(${tagHue(g)} 55% 50%)"` : ''}>
      <h3>${g ? `#${esc(g)}` : 'No tag'}</h3>
      <ul>${groups.get(g).map((t) => `<li class="bs-chip" data-task="${esc(t.id)}"${placed.has(t.id) ? ' data-placed' : ''} title="${esc(t.title)}">
        <span class="bs-t">${esc(t.title)}</span>${dueChip(t.deadline)}</li>`).join('')}</ul>
    </section>`).join('') || '<p class="muted small">No open tasks.</p>';
  const sideOpen = ui.boardSide ?? true;
  return `<div class="board-page">
    <details class="bs"${sideOpen ? ' open' : ''}>
      <summary><span>Tasks</span><span class="bs-n">${open.length}</span></summary>
      <div class="bs-groups">${side}</div>
      <p class="bs-hint">Drag a task onto the board, or tap it to drop it in the middle.</p>
    </details>
    <div class="board-wrap">
      <div class="board-tools" role="toolbar" aria-label="Board">
        <button type="button" data-btool="note">+ Note</button>
        <button type="button" data-btool="text">+ Text</button>
        <span class="bt-sep"></span>
        <button type="button" data-btool="zoom-out" aria-label="Zoom out">−</button>
        <span class="bt-zoom" data-bzoom-label>100%</span>
        <button type="button" data-btool="zoom-in" aria-label="Zoom in">+</button>
        <button type="button" data-btool="fit">Fit</button>
      </div>
      <div class="board" id="board">
        <div class="board-world">
          <svg class="board-links" aria-hidden="true"><defs>
            <marker id="bArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker>
            <marker id="bArrowSel" class="sel" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker>
          </defs><g data-links></g></svg>
          ${board.items.map((it) => boardItemHtml(it, tasks)).join('')}
          <button type="button" class="bl-del" hidden aria-label="Delete arrow">×</button>
        </div>
        ${board.items.length ? '' : `<div class="board-empty"><p>Drag tasks here from the list.</p><p class="muted small">Move them around, add notes and text, and draw arrows from a card's dot to another card. Drag the background to move, pinch or Ctrl + scroll to zoom.</p></div>`}
      </div>
    </div>
  </div>`;
}

let viewSaveTimer = 0;
function mountBoardPage() {
  const root = document.querySelector('.board-page');
  if (!root) { boardCtl = null; return; }
  root.querySelector('details.bs')?.addEventListener('toggle', (e) => { ui.boardSide = e.target.open; });
  boardCtl = mountBoard(root, {
    board: readBoard(),
    view: prefs.boardView || { x: 40, y: 40, z: 1 },
    save(next, label) {
      const json = serializeBoard(next);
      if (json.length > BOARD_MAX) {
        toast('The board is full. Remove a few notes or cards to add more.');
        return false;
      }
      write('settings', { key: BOARD_KEY, value: json }, label);
      undo.seal();
      root.querySelector('.board-empty')?.remove();
      return true;
    },
    saveView(v) {
      prefs.boardView = { x: Math.round(v.x), y: Math.round(v.y), z: +v.z.toFixed(3) };
      clearTimeout(viewSaveTimer);
      viewSaveTimer = setTimeout(savePrefs, 400);
    },
    openTask: (id) => openEdit(id),
    renderItem: (it) => boardItemHtml(it),
    markPlaced(set) {
      root.querySelectorAll('.bs-chip').forEach((c) => c.toggleAttribute('data-placed', set.has(c.dataset.task)));
    },
    idle() {
      if (deferredRender) setTimeout(() => { if (!editingInView()) render(); }, 60);
    },
  });
}

/* ---------- shell ---------- */

const VIEWS = { home: viewHome, tasks: viewTasks, board: viewBoard, picks: viewPicks, trends: viewTrends, settings: viewSettings };

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
  return inForm || hasDraft() || !!boardCtl?.busy();
};
let deferredRender = false;

// A new task's fields survive a re-render of the same page (sort change, filter, sync).
function saveDrafts() {
  return [...document.querySelectorAll('#view form.quick[data-form=quick]')].map((f) => ({
    open: f.classList.contains('open'),
    title: f.querySelector('input[name=title]')?.value || '',
    date: f.querySelector('[data-datef] input[type=hidden]')?.value || '',
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
    if (field && d.date) setDate(field, d.date);
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
  paintCounts();
  fitHomeNote();
  layoutTagBoxes();
  mountBoardPage();
}

// Keeps the Home card's sentence on the lines it was written in: the font shrinks (down to 11px)
// until the longest line fits beside the picture. Only a line too long even then wraps.
function fitHomeNote() {
  const p = document.querySelector('.home-note:not(.text-only) p');
  if (!p) return;
  p.style.fontSize = '';
  p.classList.add('fit');
  let size = parseFloat(getComputedStyle(p).fontSize);
  while (p.scrollWidth > p.clientWidth + 0.5 && size > 11) {
    size -= 0.5;
    p.style.fontSize = `${size}px`;
  }
  if (p.scrollWidth > p.clientWidth + 0.5) p.classList.remove('fit');
}
let fitFrame = 0;
const refit = () => {
  cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(() => { fitHomeNote(); layoutTagBoxes(); });
};
window.addEventListener('resize', refit);
if (document.fonts) {
  document.fonts.ready.then(refit);
  document.fonts.addEventListener?.('loadingdone', refit);
}

function renderSoft() {
  if (editingInView()) {
    deferredRender = true;
    return;
  }
  render();
}

document.addEventListener('focusout', () => {
  if (!deferredRender) return;
  setTimeout(() => { if (!editingInView()) render(); }, 60);
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.cal-pop') && !e.target.closest('[data-act=cal-toggle]')) closeAllCals();
  if (e.target.id === 'edit') return closeEdit(); // a click on the dimmed backdrop
  if (e.target.id === 'photo') return closePhoto();
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
  if (act === 'task-layout') { prefs.taskLayout = el.dataset.v === 'tags' ? 'tags' : 'list'; savePrefs(); return render(); }
  if (act === 'new-in-tag') return openNewTask(el.dataset.tag || '');
  if (act === 'photo-open') return openPhoto();
  if (act === 'photo-close') return closePhoto();
  if (act === 'cigs-home') {
    const on = el.dataset.v === 'on';
    if (on === cigsOnHome()) return;
    write('settings', { key: CIGS_KEY, value: on ? 'on' : 'off' }, on ? 'Showed cigarettes on Home' : 'Hid cigarettes from Home');
    render();
    return toast(on ? 'Cigarette counter is on Home' : 'Cigarette counter hidden', { undo: true });
  }
  if (act === 'theme' || act === 'accent') {
    prefs[act] = el.dataset.v;
    savePrefs();
    applyLook();
    return render();
  }
  if (act.startsWith('cal-')) {
    const field = el.closest('[data-datef]');
    if (act === 'cal-toggle') return field.querySelector('.cal-pop').hidden ? openCal(field) : closeCal(field);
    if (act === 'cal-prev') return moveCal(field, -1);
    if (act === 'cal-next') return moveCal(field, 1);
    if (act === 'cal-day') return setDate(field, el.dataset.key);
    if (act === 'cal-clear') return setDate(field, '');
  }
  if (act === 'day-prev' || act === 'day-next' || act === 'day-today') {
    const next = act === 'day-today' ? '' : shiftDay(logDay(), act === 'day-prev' ? -1 : 1);
    ui.logDay = next && next < today() ? next : '';
    ui.logSaved = '';
    undo.seal();
    const card = $('#log');
    if (card) card.outerHTML = logCard();
    paintCigs();
    return;
  }
  if (act === 'dur-add') {
    const form = el.closest('form');
    const box = form.querySelector(`[name=${el.dataset.name}]`);
    const cur = parseDuration(box.value).min || 0;
    box.value = fmtHM(Math.min(1440, cur + Number(el.dataset.add)));
    return onLog(form, el.dataset.name);
  }
  if (act === 'edit-task') return openEdit(id);
  if (act === 'edit-close') return closeEdit();
  if (act === 'edit-delete') return deleteFromEdit();
  if (act === 'tag-toggle') {
    el.setAttribute('aria-pressed', String(el.getAttribute('aria-pressed') !== 'true'));
    return syncTags(el.closest('[data-tagf]'));
  }
  if (act === 'cig-add') {
    // day: the day shown in the Today card (today, or a past day being filled in)
    store.enqueue('cigs', { id: newId(), at: nowIso(), day: logDay(), deletedAt: '' });
    scheduleSync();
    return paintCigs();
  }
  if (act === 'cig-undo') {
    const last = cigsOn(logDay()).pop();
    if (!last) return;
    store.enqueue('cigs', { ...last, deletedAt: nowIso() });
    scheduleSync();
    return paintCigs();
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
  // A duration is shown back as h:mm once you leave the box, so "2.5h" becomes "2:30".
  if (t.form?.id === 'log' && DURATIONS.some(([n]) => n === t.name)) {
    const r = parseDuration(t.value);
    if (!r.error) t.value = fmtHM(r.min);
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
  if (t.form && t.form.id === 'log') onLog(t.form, t.name);
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.matches?.('[data-tag-new]')) {
    const field = t.closest('[data-tagf]');
    if (/[,;]/.test(t.value)) return commitTag(field);
    return filterTags(field, t.value);
  }
  if (t.name === 'title' && t.form?.matches('form.quick')) t.form.classList.add('open');
  if (t.form && t.form.id === 'log') onLog(t.form, t.name);
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
  if (e.key === 'Escape' && document.querySelector('.cal-pop:not([hidden])')) {
    e.preventDefault();
    return closeAllCals();
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
  if (form.id === 'edit-form') return form.dataset.new ? addFromDialog(form) : saveEdit(form);
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

$('#edit')?.addEventListener('close', () => { $('#edit').innerHTML = ''; });

if (!location.hash) location.hash = '#home';
window.addEventListener('hashchange', render);
render();
boot();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
