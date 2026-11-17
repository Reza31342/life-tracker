import { load, save, uid } from './store.js';

let state = load();
const ui = { pickTab: 'current', pickKind: 'paper', openPick: null, taskTag: 'all', logSaved: '' };

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = (n) => String(n).padStart(2, '0');
const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clockOf = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const hhmm = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const fmtDur = (m) => `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const fmt = (v, d = 0) => (v == null ? '—' : v.toFixed(d));
const persist = () => save(state);
const KINDS = [['paper', 'Papers'], ['podcast', 'Podcasts'], ['event', 'Events'], ['job', 'Jobs']];
const kindLabel = (k) => (KINDS.find((x) => x[0] === k) || [k, k])[1];
const IMP = ['MUST DO', 'High', 'Medium', 'Low'];
const IMP_RANK = { 'MUST DO': 0, High: 1, Medium: 2, Low: 3 };

const safeUrl = (u) => { try { const x = new URL(String(u)); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; } };
const parseDay = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
const daysTo = (s) => { const d = parseDay(s); if (!d) return null; const t = new Date(); t.setHours(0, 0, 0, 0); return Math.round((d - t) / 864e5); };
const parseTags = (s) => String(s || '').split(/[\s,]+/).map((t) => t.replace(/^#/, '').trim().toLowerCase()).filter(Boolean);
const isoWeek = (d) => {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - y) / 864e5 + 1) / 7);
};

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 1600);
}

/* ---------- sleep, days, cigarettes ---------- */

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

const todayRec = () => state.days[dateKey()] || {};
const cigsOn = (key) => state.cigs.filter((c) => dateKey(new Date(c.at)) === key).sort((a, b) => a.at.localeCompare(b.at));

function lastDays(n) {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (n - 1 - i));
    return dateKey(d);
  });
}

function weekStats() {
  const keys = lastDays(7);
  const recs = keys.map((k) => state.days[k]).filter(Boolean);
  const nums = (f) => recs.map((r) => r[f]).filter((v) => typeof v === 'number');
  const sleepMins = keys.map((k) => sleepSummary(state.days[k]?.sleep)?.total).filter((v) => typeof v === 'number');
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
  const now = new Date().toISOString();
  state.tasks.push({
    id: uid(),
    title: title.slice(0, 300),
    description: '',
    tags: parseTags(f.get('tags')),
    importance: String(f.get('importance') || 'Medium'),
    deadline: String(f.get('deadline') || ''),
    status: 'open',
    sourcePick: null,
    claudeDecides: false,
    createdAt: now,
    updatedAt: now,
  });
  persist();
  render();
  document.querySelector('form.quick input[name=title]')?.focus();
}

function viewTasks() {
  const open = state.tasks.filter((t) => t.status !== 'done');
  const tags = [...new Set(open.flatMap((t) => t.tags || []))].sort();
  const filt = ui.taskTag;
  const list = sortTasks(open.filter((t) =>
    filt === 'all' ? true : filt === 'urgent' ? urgency(t) <= 1 : (t.tags || []).includes(filt)));
  const done = state.tasks
    .filter((t) => t.status === 'done')
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
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
  const r = todayRec();
  const radios = (name, cur) => [1, 2, 3, 4, 5].map((n) =>
    `<label><input type="radio" name="${name}" value="${n}"${cur === n ? ' checked' : ''}><span>${n}</span></label>`).join('');
  const gym = r.gymType || 'none';
  return `<form class="card log" id="log" autocomplete="off">
    <div class="card-head"><h2>Today</h2><span class="muted small" id="log-state">${esc(ui.logSaved)}</span></div>
    <div class="grid2">
      <label>Sleep<input name="sleep" value="${esc(r.sleep)}" placeholder="23:30-7:15"></label>
      <label>Walk, min<input name="walkingMin" type="number" min="0" inputmode="numeric" value="${r.walkingMin ?? ''}"></label>
      <label>Gym<select name="gymType">${['none', 'strength', 'cardio', 'other'].map((t) => `<option${gym === t ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
      <label>Gym, min<input name="gymMin" type="number" min="0" inputmode="numeric" value="${r.gymMin ?? ''}"></label>
    </div>
    <div class="scale"><span>Energy</span><div class="dots">${radios('energy', r.energy)}</div></div>
    <div class="scale"><span>Mood</span><div class="dots">${radios('mood', r.mood)}</div></div>
    <label>Note<input name="note" value="${esc(r.note)}" placeholder="alcohol, anything"></label>
  </form>`;
}

function onLog(form) {
  const f = new FormData(form);
  const key = dateKey();
  const prev = state.days[key] || {};
  const num = (v) => (v === null || v === '' ? null : Number(v));
  const gymType = f.get('gymType') || 'none';
  state.days[key] = {
    ...prev,
    sleep: String(f.get('sleep') || '').trim(),
    walkingMin: num(f.get('walkingMin')),
    gymType,
    gymMin: gymType === 'none' ? null : num(f.get('gymMin')),
    energy: num(f.get('energy')),
    mood: num(f.get('mood')),
    note: String(f.get('note') || '').trim(),
    updatedAt: new Date().toISOString(),
  };
  persist();
  ui.logSaved = `saved ${clockOf(new Date())}`;
  const st = document.getElementById('log-state');
  if (st) st.textContent = ui.logSaved;
  renderPartial('week', weekInner);
}

function cigInner() {
  const today = cigsOn(dateKey());
  const sl = sleepSummary(todayRec().sleep);
  const first = today[0] ? new Date(today[0].at) : null;
  let wake = '';
  if (first && sl) wake = ` · ${fmtDur((first.getHours() * 60 + first.getMinutes() - sl.main.end + 1440) % 1440)} after waking`;
  const times = today.slice(-6).map((c) => `<span>${clockOf(new Date(c.at))}</span>`).join('') || '<span>none yet</span>';
  return `<div class="card-head"><h2>Cigarettes</h2><span class="big-n">${today.length}</span></div>
    <div class="cig-row">
      <button class="tap" type="button" data-act="cig-add" aria-label="Log one cigarette">+1</button>
      <div class="times">${times}</div>
      <button class="ghost" type="button" data-act="cig-undo"${today.length ? '' : ' disabled'}>undo</button>
    </div>
    <p class="muted small" style="margin:12px 0 0">${first ? `first at ${clockOf(first)}${wake}` : 'first at —'} · week ${weekStats().cigsPerDay}/day</p>`;
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

function currentPicks() {
  const today = dateKey();
  return state.picks
    .filter((p) => p.status === 'active' && (!p.date || p.date >= today) && (!p.deadline || p.deadline >= today))
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
}

function viewHome() {
  const now = new Date();
  const open = state.tasks.filter((t) => t.status !== 'done');
  const sorted = sortTasks(open);
  const overdue = open.filter((t) => urgency(t) === 0).length;
  const dueToday = open.filter((t) => urgency(t) === 1).length;
  const h = now.getHours();
  const part = h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
  const picks = currentPicks().slice(0, 4);
  return `
  <header class="hero">
    <div>
      <p class="eyebrow">KW ${isoWeek(now)} · ${now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
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
    <label class="check"><input type="checkbox" name="deadlineAuto"> Claude decides</label>
    <label>Importance<select name="importance">${IMP.map((i) => `<option${i === 'Medium' ? ' selected' : ''}>${i}</option>`).join('')}<option value="auto">Claude decides</option></select></label>
    <button class="primary" type="submit">Create task</button>
  </form>`;

function pickRow(p) {
  const saved = p.status === 'saved';
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
      <button class="ghost" type="button" data-act="pick-save" data-id="${esc(p.id)}">${saved ? 'Unsave' : 'Save'}</button>
      <button class="ghost" type="button" data-act="pick-task" data-id="${esc(p.id)}">+ Task</button>
      <button class="ghost" type="button" data-act="pick-dismiss" data-id="${esc(p.id)}">Dismiss</button>
    </div>
  </li>`;
}

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
    importance: importanceAuto ? null : String(f.get('importance') || 'Medium'),
    deadline: deadlineAuto ? '' : String(f.get('deadline') || ''),
    status: 'open',
    sourcePick: p.id,
    claudeDecides,
    createdAt: now,
    updatedAt: now,
  });
  ui.openPick = null;
  persist();
  toast('Task added');
  render();
}

function viewPicks() {
  const today = dateKey();
  const pool = state.picks.filter((p) => ui.pickTab === 'saved'
    ? p.status === 'saved'
    : p.status === 'active' && (!p.date || p.date >= today) && (!p.deadline || p.deadline >= today));
  const list = pool.filter((p) => p.kind === ui.pickKind).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
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
      url: safeUrl(raw.url),
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
  const rec = days.map((k) => state.days[k] || null);
  const cigs = days.map((k) => cigsOn(k).length);
  const sleepH = days.map((k) => { const s = sleepSummary(state.days[k]?.sleep); return s ? +(s.total / 60).toFixed(1) : null; });
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

/* ---------- settings ---------- */

function viewSettings() {
  const s = state.settings;
  return `
  <div class="tasks-page">
    <header class="page-head"><h1>Settings</h1><span class="muted">on this device</span></header>
    <div class="settings">
      <form class="card" id="settings-form" style="display:grid;gap:14px">
        <h2>Storage</h2>
        <label>Google Sheet ID<input name="sheetId" value="${esc(s.sheetId)}" placeholder="stored on this device only"></label>
        <p class="muted small" style="margin:0">Sign-in and Sheets sync are not connected yet.</p>
        <h2>What Claude looks for</h2>
        <label>Profile<textarea name="profile" rows="5">${esc(s.profile)}</textarea></label>
        <div class="row"><button class="primary" type="submit">Save</button><span class="muted small">last run: ${esc(s.lastRun || 'never')}</span></div>
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

function saveSettings(form) {
  const f = new FormData(form);
  state.settings = {
    ...state.settings,
    sheetId: String(f.get('sheetId') || '').trim(),
    profile: String(f.get('profile') || '').trim(),
  };
  persist();
  toast('Saved');
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

/* ---------- shell ---------- */

const VIEWS = { home: viewHome, tasks: viewTasks, picks: viewPicks, trends: viewTrends, settings: viewSettings };

function currentRoute() {
  const h = location.hash.slice(1);
  return VIEWS[h] ? h : 'home';
}

function render() {
  const r = currentRoute();
  document.body.dataset.route = r;
  document.querySelectorAll('[data-route]').forEach((a) => {
    const on = a.dataset.route === r;
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  $('#view').innerHTML = VIEWS[r]();
}

function renderPartial(id, fn) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = fn();
}

document.addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    state.tasks = state.tasks.filter((t) => t.id !== del.dataset.del);
    persist();
    return render();
  }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const { act, id } = el.dataset;
  if (act === 'cig-add') {
    state.cigs.push({ id: uid(), at: new Date().toISOString() });
    persist();
    return renderPartial('cigs', cigInner);
  }
  if (act === 'cig-undo') {
    const today = cigsOn(dateKey());
    if (!today.length) return;
    const last = today[today.length - 1];
    state.cigs = state.cigs.filter((c) => c.id !== last.id);
    persist();
    return renderPartial('cigs', cigInner);
  }
  if (act === 'task-filter') { ui.taskTag = el.dataset.tag; return render(); }
  if (act === 'pick-tab') { ui.pickTab = el.dataset.tab; return render(); }
  if (act === 'pick-kind') { ui.pickKind = el.dataset.kind; return render(); }
  if (act === 'pick-save' || act === 'pick-dismiss') {
    const p = state.picks.find((x) => x.id === id);
    if (!p) return;
    p.status = act === 'pick-dismiss' ? 'dismissed' : p.status === 'saved' ? 'active' : 'saved';
    persist();
    return render();
  }
  if (act === 'pick-task') { ui.openPick = ui.openPick === id ? null : id; return render(); }
  if (act === 'export') return exportBackup();
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset && t.dataset.done) {
    const task = state.tasks.find((x) => x.id === t.dataset.done);
    if (task) {
      task.status = t.checked ? 'done' : 'open';
      task.updatedAt = new Date().toISOString();
      persist();
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
  if (form.id === 'settings-form') return saveSettings(form);
  if (form.id === 'import-form') return importPicks(form);
});

if (!location.hash) location.hash = '#home';
window.addEventListener('hashchange', render);
render();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
