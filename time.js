// Reading times the way people type them. Entry should be easy, so sleep and work are saved
// exactly as typed; these readers only work out totals. Claude can tidy odd formats in the sheet.

// One clock time: 7, 7:15, 7.15, 7h15, 0715, 7am, 11:30pm → minutes after midnight, or null.
function clock(h, m, ap) {
  let hh = Number(h);
  const mm = m == null ? 0 : Number(m);
  if (mm > 59) return null;
  if (ap) {
    if (hh < 1 || hh > 12) return null;
    hh = (hh % 12) + (ap === 'pm' ? 12 : 0);
  }
  if (hh > 24 || (hh === 24 && mm)) return null;
  return (hh % 24) * 60 + mm;
}

const RANGE = /^(\+)?(\d{1,2})(?:[:.h]?(\d{2}))?(am|pm)?-(\d{1,2})(?:[:.h]?(\d{2}))?(am|pm)?$/;

// "23:30-7:15, 14-15" (also "23.30 - 7.15", "11pm to 7am", "2330-0715", "+14-15" for a nap).
// Returns the readable blocks and how many parts could not be read.
// daytime: for work hours, an end before the start that makes sense in the afternoon is read
// as pm, so "9-5" is 9 to 17. A real night range like "22-6" still crosses midnight.
export function parseRanges(text, { daytime = false } = {}) {
  const s = String(text || '').toLowerCase()
    .replace(/[–—~]/g, '-')
    .replace(/\s+to\s+/g, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+(am|pm)\b/g, '$1');
  const parts = s.split(/[\s,;&/]+|\band\b/).filter(Boolean);
  const blocks = [];
  let bad = 0;
  for (const p of parts) {
    const m = p.match(RANGE);
    const start = m && clock(m[2], m[3], m[4]);
    const end = m && clock(m[5], m[6], m[7]);
    if (!m || start == null || end == null) { bad += 1; continue; }
    let e = end;
    if (daytime && !m[7] && e < start && e < 720 && e + 720 > start) e += 720;
    blocks.push({ start, end: e, dur: (e - start + 1440) % 1440, nap: !!m[1] });
  }
  return { blocks, bad };
}

export const rangesTotal = (text, opts) => parseRanges(text, opts).blocks.reduce((s, b) => s + b.dur, 0);

// Durations in hours and minutes: "2:45", "2.45" (two digits = minutes), "1.5" or "1.5h"
// (decimal hours), "2h45", "2h", "90m", "45" (a bare number up to 12 is hours, above is minutes).
// Returns { min } (null when empty) or { min: null, error }.
export function parseDuration(text) {
  const s = String(text || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return { min: null };
  const fail = { min: null, error: 'Use h:mm, for example 2:45' };
  let min = null;
  let m;
  if ((m = s.match(/^(\d{1,2})[:.,](\d{2})$/))) min = Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : null;
  else if ((m = s.match(/^(\d{1,2})[.,](\d)h?$/))) min = Math.round((Number(m[1]) + Number(m[2]) / 10) * 60);
  else if ((m = s.match(/^(\d{1,2}(?:[.,]\d+)?)h(?:(\d{1,2})m?)?$/))) {
    const extra = m[2] == null ? 0 : Number(m[2]);
    min = extra < 60 ? Math.round(Number(m[1].replace(',', '.')) * 60) + extra : null;
  } else if ((m = s.match(/^(\d{1,4})m(in)?$/))) min = Number(m[1]);
  else if ((m = s.match(/^(\d{1,4})$/))) min = Number(m[1]) <= 12 ? Number(m[1]) * 60 : Number(m[1]);
  if (min == null || min > 1440) return fail;
  return { min };
}

// 165 → "2:45": what a duration field shows.
export const fmtHM = (min) => (min == null ? '' : `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`);
