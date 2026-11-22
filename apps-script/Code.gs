/**
 * Life Tracker: the app's private link to this sheet.
 *
 * Setup, once:
 *  1. In the sheet: Extensions > Apps Script. Replace the code there with this file and save.
 *  2. Pick the function "setup" in the toolbar and press Run. Allow access when Google asks.
 *     The execution log then shows your key. Keep it private.
 *  3. Deploy > New deployment > type "Web app". Execute as: Me. Who has access: Anyone.
 *     Copy the web app URL (it ends with /exec).
 *  4. In the app: Settings > paste the URL and the key > Save and connect.
 *
 * Every request must carry the key; without it the link returns nothing.
 * To lock out every device, run "setup" again. It makes a new key, and the old one stops working.
 * After changing this code: Deploy > Manage deployments > edit > Version: New version > Deploy.
 *
 * This script can only open this one spreadsheet.
 * @OnlyCurrentDoc
 */

const TABS = ['tasks', 'days', 'cigs', 'picks', 'settings'];
const MAX_COLS = 26;
const KEY_PROP = 'APP_KEY';

function setup() {
  const key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty(KEY_PROP, key);
  SpreadsheetApp.getActiveSpreadsheet().getName(); // asks for sheet access now, not on the first sync
  Logger.log('Your Life Tracker key. Paste it into the app (Settings) and keep it private:');
  Logger.log(key);
}

function doGet() {
  return ContentService.createTextOutput('The Life Tracker link works. Use it from the app.');
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '');
  } catch (err) {
    return reply_({ ok: false, code: 'bad_request', error: 'The request was not readable.' });
  }
  const expected = PropertiesService.getScriptProperties().getProperty(KEY_PROP);
  if (!expected) {
    return reply_({ ok: false, code: 'not_set_up', error: 'The sheet script has no key yet. Run "setup" in Apps Script.' });
  }
  if (!req || typeof req.key !== 'string' || !same_(req.key, expected)) {
    return reply_({ ok: false, code: 'bad_key', error: 'The key does not match.' });
  }
  try {
    if (req.action === 'ping') return reply_({ ok: true, title: SpreadsheetApp.getActiveSpreadsheet().getName() });
    if (req.action === 'pull') return reply_({ ok: true, tabs: pull_(req.widths) });
    if (req.action === 'write') {
      const res = write_(req);
      return reply_({ ok: true, updated: res.updated, appended: res.appended });
    }
    return reply_({ ok: false, code: 'bad_request', error: 'Unknown action.' });
  } catch (err) {
    return reply_({ ok: false, code: err.code || 'error', error: String((err && err.message) || err) });
  }
}

// Every app tab, header first, up to the last row with anything in it. Typed values
// (numbers, booleans) stay typed; a real date cell is sent as it is shown.
function pull_(widths) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const out = {};
  TABS.forEach(function (tab) {
    const width = width_(widths && widths[tab]);
    const sheet = sheet_(ss, tab);
    const last = sheet.getLastRow();
    if (last < 1) {
      out[tab] = [];
      return;
    }
    const range = sheet.getRange(1, 1, last, width);
    const values = range.getValues();
    const shown = range.getDisplayValues();
    out[tab] = values.map(function (row, i) {
      return row.map(function (v, j) {
        return Object.prototype.toString.call(v) === '[object Date]' ? shown[i][j] : v;
      });
    });
  });
  return out;
}

// updates: [{ tab, row, key, values }]: the row the app saw when it read the sheet. If that row
//   no longer holds the key (rows moved), the key is looked up; if it is gone, the row is added.
// appends: [{ tab, rows }]: a row whose key is already in the tab updates that row (so a repeated
//   request never makes duplicates). Other rows go directly under the last row that has a key in
//   column A, so stray values lower down (an unticked checkbox) never push data to the bottom.
// The key is always column A. Returns the sheet row of each update and of each appended row.
function write_(req) {
  const updates = Array.isArray(req.updates) ? req.updates : [];
  const appends = Array.isArray(req.appends) ? req.appends : [];
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw fail_('busy', 'The sheet is busy. Sync will try again.');
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const updated = updates.map(function (u) {
      const sheet = sheet_(ss, u.tab);
      const values = row_(u.values);
      const key = String(u.key == null ? '' : u.key).trim();
      if (!key || String(values[0]).trim() !== key) throw fail_('bad_request', 'A row does not match its key.');
      let row = Number(u.row);
      if (!(row >= 2 && Math.floor(row) === row) || keyAt_(sheet, row) !== key) row = findKey_(sheet, key);
      if (!row) row = nextRow_(sheet);
      put_(sheet, row, [values]);
      return row;
    });
    const appended = {};
    appends.forEach(function (a) {
      const sheet = sheet_(ss, a.tab);
      const rows = (Array.isArray(a.rows) ? a.rows : []).map(row_);
      if (!rows.length) return;
      const keys = keys_(sheet);
      const at = [];
      const fresh = [];
      rows.forEach(function (r, i) {
        const key = String(r[0]).trim();
        if (!key) throw fail_('bad_request', 'A new row has no key.');
        const found = keys.lastIndexOf(key);
        if (found >= 0) {
          put_(sheet, found + 2, [r]);
          at[i] = found + 2;
        } else {
          fresh.push(i);
        }
      });
      if (fresh.length) {
        const start = nextRow_(sheet);
        put_(sheet, start, fresh.map(function (i) { return rows[i]; }));
        fresh.forEach(function (i, n) { at[i] = start + n; });
      }
      appended[a.tab] = at;
    });
    SpreadsheetApp.flush();
    return { updated: updated, appended: appended };
  } finally {
    lock.releaseLock();
  }
}

// Writes rows starting at a sheet row, adding grid rows when needed. Text cells are set to plain
// text first, so "2026-11-22" or "+15-16" stay text instead of turning into a date or a formula.
function put_(sheet, row, rows) {
  const width = rows[0].length;
  rows.forEach(function (r) {
    if (r.length !== width) throw fail_('bad_request', 'Rows have different lengths.');
  });
  const need = row + rows.length - 1;
  const max = sheet.getMaxRows();
  if (need > max) sheet.insertRowsAfter(max, need - max);
  const range = sheet.getRange(row, 1, rows.length, width);
  const formats = range.getNumberFormats();
  rows.forEach(function (r, i) {
    r.forEach(function (v, j) {
      if (typeof v === 'string' && v !== '') formats[i][j] = '@';
    });
  });
  range.setNumberFormats(formats);
  range.setValues(rows);
}

function keys_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, 1).getDisplayValues().map(function (r) {
    return String(r[0]).trim();
  });
}

function keyAt_(sheet, row) {
  if (row > sheet.getMaxRows()) return '';
  return String(sheet.getRange(row, 1).getDisplayValue()).trim();
}

function findKey_(sheet, key) {
  const i = keys_(sheet).lastIndexOf(key);
  return i >= 0 ? i + 2 : 0;
}

function nextRow_(sheet) {
  const keys = keys_(sheet);
  let i = keys.length - 1;
  while (i >= 0 && !keys[i]) i -= 1;
  return i + 3;
}

function row_(values) {
  if (!Array.isArray(values) || !values.length || values.length > MAX_COLS) {
    throw fail_('bad_request', 'A row has the wrong number of cells.');
  }
  return values.map(function (v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
    throw fail_('bad_request', 'A cell has an unsupported value.');
  });
}

function width_(n) {
  const w = Number(n);
  if (!(w >= 1 && w <= MAX_COLS && Math.floor(w) === w)) throw fail_('bad_request', 'Bad column count.');
  return w;
}

function sheet_(ss, tab) {
  if (TABS.indexOf(tab) < 0) throw fail_('bad_request', 'Unknown tab.');
  const sheet = ss.getSheetByName(tab);
  if (!sheet) throw fail_('missing_tab', 'The sheet has no "' + tab + '" tab.');
  return sheet;
}

function same_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function fail_(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
