// The Google Sheet layout, in one place. Keep in step with the sheet's _schema tab.
// Each column is [sheet header, app field, type]. Types: text, int, bool, tags.
// Rows are read and written by header name, never by position.

// 2 (2026-11-22): days gained sleep_quality, work, study_min, chores_min after sleep.
export const SCHEMA_VERSION = 2;

const config = { timezone: 'Europe/Berlin', rollover: 4 };

// Called after the settings tab is read, so the sheet's values win over the defaults.
export function setZone({ timezone, rollover } = {}) {
  if (timezone) config.timezone = String(timezone);
  const r = Number(rollover);
  if (Number.isInteger(r) && r >= 0 && r < 24) config.rollover = r;
}

export const TABS = {
  tasks: {
    key: 'id',
    cols: [
      ['id', 'id', 'text'],
      ['title', 'title', 'text'],
      ['description', 'description', 'text'],
      ['tags', 'tags', 'tags'],
      ['importance', 'importance', 'text'],
      ['deadline', 'deadline', 'text'],
      ['status', 'status', 'text'],
      ['claude_decides', 'claudeDecides', 'bool'],
      ['source_pick', 'sourcePick', 'text'],
      ['created_at', 'createdAt', 'text'],
      ['updated_at', 'updatedAt', 'text'],
      ['updated_by', 'updatedBy', 'text'],
      ['done_at', 'doneAt', 'text'],
      ['deleted_at', 'deletedAt', 'text'],
    ],
  },
  days: {
    key: 'date',
    cols: [
      ['date', 'date', 'text'],
      ['sleep', 'sleep', 'text'],
      ['sleep_quality', 'sleepQuality', 'int'],
      ['work', 'work', 'text'],
      ['study_min', 'studyMin', 'int'],
      ['chores_min', 'choresMin', 'int'],
      ['walking_min', 'walkingMin', 'int'],
      // Kept for older rows. The app no longer asks for it and leaves it as it was.
      ['gym_type', 'gymType', 'text'],
      ['gym_min', 'gymMin', 'int'],
      ['energy', 'energy', 'int'],
      ['mood', 'mood', 'int'],
      ['note', 'note', 'text'],
      ['updated_at', 'updatedAt', 'text'],
      ['updated_by', 'updatedBy', 'text'],
    ],
  },
  cigs: {
    key: 'id',
    cols: [
      ['id', 'id', 'text'],
      ['at', 'at', 'text'],
      ['day', 'day', 'text'],
      ['deleted_at', 'deletedAt', 'text'],
    ],
  },
  picks: {
    key: 'id',
    cols: [
      ['id', 'id', 'text'],
      ['kind', 'kind', 'text'],
      ['title', 'title', 'text'],
      ['source', 'source', 'text'],
      ['meta', 'meta', 'text'],
      ['url', 'url', 'text'],
      ['why', 'why', 'text'],
      ['rank', 'rank', 'int'],
      ['week', 'week', 'text'],
      ['status', 'status', 'text'],
      ['date', 'date', 'text'],
      ['deadline', 'deadline', 'text'],
      ['created_at', 'createdAt', 'text'],
      ['updated_at', 'updatedAt', 'text'],
      ['updated_by', 'updatedBy', 'text'],
    ],
  },
  settings: {
    key: 'key',
    cols: [
      ['key', 'key', 'text'],
      ['value', 'value', 'text'],
      ['updated_at', 'updatedAt', 'text'],
    ],
  },
};

// Screentime is written by Claude only and is not shown in the app, so the app does not sync it.
export const APP_TABS = Object.keys(TABS);
export const PICK_KINDS = ['paper', 'podcast', 'event', 'job'];
export const PICK_STATUSES = ['new', 'useful', 'tasked', 'done', 'dismissed'];
export const GYM_TYPES = ['none', 'strength', 'cardio', 'other'];

export class SchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SchemaError';
  }
}

export const colLetter = (n) => String.fromCharCode(64 + n);
export const lastCol = (tab) => colLetter(TABS[tab].cols.length);

function encodeCell(v, type) {
  if (type === 'bool') return v === true || String(v ?? '').trim().toUpperCase() === 'TRUE';
  if (v === undefined || v === null) return '';
  if (type === 'int') {
    if (v === '') return '';
    const n = Number(v);
    return Number.isFinite(n) ? n : '';
  }
  if (type === 'tags') return Array.isArray(v) ? v.join(', ') : String(v);
  return String(v);
}

function decodeCell(raw, type) {
  if (type === 'bool') return raw === true || String(raw ?? '').trim().toUpperCase() === 'TRUE';
  if (type === 'int') {
    if (raw === '' || raw === null || raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'tags') {
    return String(raw ?? '')
      .split(/[\s,]+/)
      .map((t) => t.replace(/^#/, '').trim().toLowerCase())
      .filter(Boolean);
  }
  return raw === null || raw === undefined ? '' : String(raw);
}

// App record -> sheet row, in column order. Booleans go out as booleans and numbers as numbers,
// so the sheet stores them with the right type even when the write is RAW.
export function toRow(tab, rec) {
  return TABS[tab].cols.map(([, field, type]) => encodeCell(rec[field], type));
}

// Sheet row -> app record. rowNumber is the 1-based row in the sheet, kept for later updates.
export function fromRow(tab, row, rowNumber) {
  const rec = {};
  TABS[tab].cols.forEach(([, field, type], i) => {
    rec[field] = decodeCell(row[i], type);
  });
  rec._row = rowNumber;
  return rec;
}

// Stops sync when someone has renamed, moved or removed a column. Writing into the wrong
// column would corrupt data silently, so this fails loudly instead.
export function checkHeaders(tab, header = []) {
  const want = TABS[tab].cols.map((c) => c[0]);
  const bad = want.findIndex((name, i) => String(header[i] ?? '').trim() !== name);
  if (bad !== -1) {
    throw new SchemaError(
      `Sheet tab "${tab}" column ${bad + 1} should be "${want[bad]}" but is "${String(header[bad] ?? '')}". Sync stopped so nothing is written to the wrong column.`,
    );
  }
}

// Timestamp -> milliseconds for comparisons. Compare parsed values, never strings,
// because "...00Z" and "...00.500Z" do not sort correctly as text.
export const ms = (iso) => {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : -Infinity;
};

export const pad = (n) => String(n).padStart(2, '0');
export const isDateKey = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

const formatters = new Map();
function zoneParts(at) {
  const tz = config.timezone;
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), min: Number(p.minute) };
}

// Adds n days to a YYYY-MM-DD key (calendar arithmetic, no time zone involved).
export function shiftDay(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

// Days from a to b (b - a).
export function dayDiff(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 864e5);
}

// The logical day for an instant: the Berlin calendar date, shifted back before the rollover hour.
// A tap at 01:30 on the 18th belongs to the 17th when the rollover is 04:00.
export function logicalDay(at = new Date()) {
  const { y, m, d, h } = zoneParts(at);
  const key = `${y}-${pad(m)}-${pad(d)}`;
  return h < config.rollover ? shiftDay(key, -1) : key;
}

export function clockAt(at) {
  const { h, min } = zoneParts(at);
  return `${pad(h)}:${pad(min)}`;
}

export function minutesAt(at) {
  const { h, min } = zoneParts(at);
  return h * 60 + min;
}

export function zone() {
  return { ...config };
}
