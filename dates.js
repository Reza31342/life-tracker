// Reading dates the way people type them: day first, year optional.
// "24" → the 24th of this month (or next month if it has passed), "24.11" or "24/11" → this year,
// "24.11.26" or "24.11.2026", "24 nov", "today", "tomorrow", "fri", "+3", "+2w", "2026-11-24".
import { shiftDay, dayDiff, isDateKey, pad } from './schema.js';

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// Without a year, a date more than this many days in the past means next year ("15.01" in November).
const ROLL_DAYS = 60;

const parts = (key) => key.split('-').map(Number);
export const keyOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
export const weekdayOf = (key) => { const [y, m, d] = parts(key); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };

function real(y, m, d) {
  if (!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1)) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

// Next date (today included) that falls on a weekday, 0 = Sunday.
export function nextWeekday(today, wd, { after = false } = {}) {
  let n = (wd - weekdayOf(today) + 7) % 7;
  if (after && n === 0) n = 7;
  return shiftDay(today, n);
}

function withYear(today, m, d) {
  const [ty] = parts(today);
  if (!real(ty, m, d) && !real(ty + 1, m, d)) return null;
  let key = real(ty, m, d) ? keyOf(ty, m, d) : null;
  if (!key || dayDiff(today, key) < -ROLL_DAYS) key = real(ty + 1, m, d) ? keyOf(ty + 1, m, d) : key;
  return key;
}

// Returns { key } with key '' for an empty field, or { key: '', error } when it can't be read.
export function parseDateInput(text, today) {
  const s = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return { key: '' };
  const fail = { key: '', error: 'Try 24.11, 24.11.2026, tomorrow or fri' };

  if (isDateKey(s)) {
    const [y, m, d] = parts(s);
    return real(y, m, d) ? { key: s } : fail;
  }
  if (['today', 'tod', 'tdy', 'now'].includes(s)) return { key: today };
  if (['tomorrow', 'tom', 'tmr', 'tmrw'].includes(s)) return { key: shiftDay(today, 1) };

  let m = s.match(/^\+\s*(\d{1,3})\s*(d|day|days|w|wk|week|weeks)?$/) || s.match(/^(\d{1,3})\s*(d|days|w|wk|weeks)$/);
  if (m) {
    const n = Number(m[1]) * (m[2] && m[2].startsWith('w') ? 7 : 1);
    return { key: shiftDay(today, n) };
  }

  m = s.match(/^(next )?([a-z]{3})[a-z]*$/);
  if (m && WEEKDAYS.includes(m[2])) return { key: nextWeekday(today, WEEKDAYS.indexOf(m[2]), { after: !!m[1] }) };

  // 24 nov, 24 november 2026, 24nov
  m = s.match(/^(\d{1,2})\.? ?([a-z]{3})[a-z]*\.?(?: (\d{2}|\d{4}))?$/);
  if (m && MONTHS.includes(m[2])) {
    const d = Number(m[1]);
    const mo = MONTHS.indexOf(m[2]) + 1;
    if (m[3]) {
      const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      return real(y, mo, d) ? { key: keyOf(y, mo, d) } : fail;
    }
    const key = withYear(today, mo, d);
    return key ? { key } : fail;
  }

  // 24 | 24.11 | 24/11 | 24-11 | 24 11 | 24.11.26 | 24.11.2026
  m = s.match(/^(\d{1,2})(?:[./\- ](\d{1,2}))?(?:[./\- ](\d{2}|\d{4}))?\.?$/);
  if (m) {
    const d = Number(m[1]);
    const [ty, tm] = parts(today);
    if (!m[2]) {
      let key = real(ty, tm, d) ? keyOf(ty, tm, d) : null;
      if (!key || dayDiff(today, key) < 0) {
        const ny = tm === 12 ? ty + 1 : ty;
        const nm = tm === 12 ? 1 : tm + 1;
        key = real(ny, nm, d) ? keyOf(ny, nm, d) : key;
      }
      return key ? { key } : fail;
    }
    const mo = Number(m[2]);
    if (m[3]) {
      const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      return real(y, mo, d) ? { key: keyOf(y, mo, d) } : fail;
    }
    const key = withYear(today, mo, d);
    return key ? { key } : fail;
  }
  return fail;
}

// "24.11.2026": what the date field shows.
export const typed = (key) => (isDateKey(key) ? `${key.slice(8, 10)}.${key.slice(5, 7)}.${key.slice(0, 4)}` : '');

// "Tue 24 Nov 2026": the confirmation under the field.
export function longDate(key) {
  if (!isDateKey(key)) return '';
  const [y, m, d] = parts(key);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weekdayOf(key)];
  return `${wd} ${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
}

// The one-tap choices under the field.
export function quickDates(today) {
  return [
    ['Today', today],
    ['Tomorrow', shiftDay(today, 1)],
    ['Sat', nextWeekday(today, 6)],
    ['Next Mon', nextWeekday(today, 1, { after: true })],
    ['+1 week', shiftDay(today, 7)],
    ['+2 weeks', shiftDay(today, 14)],
  ];
}
