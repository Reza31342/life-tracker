// Date display helpers. Dates are stored as YYYY-MM-DD and shown day first.
import { isDateKey, pad } from './schema.js';

const parts = (key) => key.split('-').map(Number);
export const keyOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
export const weekdayOf = (key) => { const [y, m, d] = parts(key); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };

// "24.11.2026"
export const typed = (key) => (isDateKey(key) ? `${key.slice(8, 10)}.${key.slice(5, 7)}.${key.slice(0, 4)}` : '');

// "Tue 24 Nov 2026"
export function longDate(key) {
  if (!isDateKey(key)) return '';
  const [y, m, d] = parts(key);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weekdayOf(key)];
  return `${wd} ${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
}
