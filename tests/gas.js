// A small stand-in for the Apps Script services Code.gs uses, so tests run the real script.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

const CODE = readFileSync(fileURLToPath(new URL('../apps-script/Code.gs', import.meta.url)), 'utf8');

const blank = (v) => v === '' || v === null || v === undefined;
const shown = (v) => (v === true ? 'TRUE' : v === false ? 'FALSE' : blank(v) ? '' : String(v));

export class FakeSheet {
  constructor(name, rows = [], maxRows = 1000) {
    this.name = name;
    this.cells = rows.map((r) => [...r]);
    this.formats = [];
    this.maxRows = Math.max(maxRows, rows.length);
  }

  getName() { return this.name; }
  getMaxRows() { return this.maxRows; }

  // Like Sheets: the last row with any value, FALSE included.
  getLastRow() {
    for (let i = this.cells.length - 1; i >= 0; i -= 1) {
      if ((this.cells[i] || []).some((v) => !blank(v))) return i + 1;
    }
    return 0;
  }

  insertRowsAfter(after, n) {
    if (after !== this.maxRows) throw new Error('fake: only inserts at the end are supported');
    this.maxRows += n;
  }

  get(r, c) { return (this.cells[r - 1] || [])[c - 1]; }

  set(r, c, v) {
    while (this.cells.length < r) this.cells.push([]);
    const row = this.cells[r - 1];
    while (row.length < c) row.push('');
    row[c - 1] = v;
  }

  getRange(r, c, nr = 1, nc = 1) {
    if (r < 1 || c < 1 || nr < 1 || nc < 1) throw new Error('fake: bad range');
    if (r + nr - 1 > this.maxRows) throw new Error('Range exceeds grid limits');
    const sheet = this;
    const grid = (fn) => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (__, j) => fn(r + i, c + j)));
    return {
      getValues: () => grid((y, x) => (blank(sheet.get(y, x)) ? '' : sheet.get(y, x))),
      getDisplayValues: () => grid((y, x) => shown(sheet.get(y, x))),
      getDisplayValue: () => shown(sheet.get(r, c)),
      getNumberFormats: () => grid((y, x) => (sheet.formats[y - 1] || [])[x - 1] || 'General'),
      setNumberFormats: (f) => f.forEach((row, i) => row.forEach((v, j) => {
        const y = r + i - 1;
        sheet.formats[y] = sheet.formats[y] || [];
        sheet.formats[y][c + j - 1] = v;
      })),
      setValues: (vals) => {
        if (vals.length !== nr || vals.some((x) => x.length !== nc)) throw new Error('fake: size mismatch');
        vals.forEach((row, i) => row.forEach((v, j) => sheet.set(r + i, c + j, v)));
      },
    };
  }

  // Rows with trailing blanks removed, for assertions.
  rows() {
    return this.cells.map((row) => {
      const out = [...row];
      while (out.length && blank(out[out.length - 1])) out.pop();
      return out;
    });
  }
}

export const TEST_KEY = 'k'.repeat(64);

export function loadScript({ sheets = {}, key = TEST_KEY, title = 'Life Tracker' } = {}) {
  const props = new Map(key ? [['APP_KEY', key]] : []);
  const logs = [];
  let locked = false;
  const ss = { getName: () => title, getSheetByName: (n) => sheets[n] || null };
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush() {} },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => { props.set(k, String(v)); },
      }),
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => { if (locked) return false; locked = true; return true; },
        releaseLock: () => { locked = false; },
      }),
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (s) => {
        const out = { content: String(s), mime: 'text/plain' };
        out.setMimeType = (m) => { out.mime = m; return out; };
        out.getContent = () => out.content;
        return out;
      },
    },
    Utilities: { getUuid: () => randomUUID() },
    Logger: { log: (s) => logs.push(String(s)) },
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx, { filename: 'Code.gs' });
  const post = (body) => {
    const contents = typeof body === 'string' ? body : JSON.stringify(body);
    return JSON.parse(ctx.doPost({ postData: { contents } }).getContent());
  };
  return { ctx, post, props, logs, sheets, lock: { get held() { return locked; }, set held(v) { locked = v; } } };
}

// A fetch that delivers the app's requests to the script, the way the deployed web app would.
export function scriptFetch(script, hooks = {}) {
  return async (url, init) => {
    if (hooks.before) await hooks.before(JSON.parse(init.body));
    const text = script.ctx.doPost({ postData: { contents: init.body } }).getContent();
    return { ok: true, status: 200, text: async () => text };
  };
}
