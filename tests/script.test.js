import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSheet, loadScript, TEST_KEY } from './gas.js';
import { buildRaw } from './helpers.js';
import { TABS, APP_TABS } from '../schema.js';

const widths = Object.fromEntries(APP_TABS.map((t) => [t, TABS[t].cols.length]));
const sheetsFrom = (raw, maxRows) => Object.fromEntries(Object.entries(raw).map(([t, rows]) => [t, new FakeSheet(t, rows, maxRows)]));
const taskRow = (id, title = 'T') => [id, title, '', '', 'Medium', '', 'open', false, '', '2026-11-22T10:00:00Z', '2026-11-22T10:00:00Z', 'app', '', ''];

test('every request without the right key is refused and reveals nothing', () => {
  const s = loadScript({ sheets: sheetsFrom(buildRaw({})) });
  for (const body of [{ action: 'pull', widths }, { key: 'wrong', action: 'pull', widths }, { key: TEST_KEY.slice(1), action: 'ping' }]) {
    const res = s.post(body);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'bad_key');
    assert.equal(res.tabs, undefined);
    assert.equal(res.title, undefined);
  }
  assert.equal(s.post('not json').code, 'bad_request');
});

test('before setup the script refuses everything', () => {
  const s = loadScript({ sheets: sheetsFrom(buildRaw({})), key: null });
  assert.equal(s.post({ key: '', action: 'ping' }).code, 'not_set_up');
});

test('setup makes a long random key, stores it, and only that key works afterwards', () => {
  const s = loadScript({ sheets: sheetsFrom(buildRaw({})), key: null });
  s.ctx.setup();
  const key = s.props.get('APP_KEY');
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.ok(s.logs.some((l) => l === key), 'the key is shown in the log for the owner to copy');
  assert.equal(s.post({ key, action: 'ping' }).title, 'Life Tracker');
  s.ctx.setup();
  assert.notEqual(s.props.get('APP_KEY'), key, 'running setup again replaces the key');
  assert.equal(s.post({ key, action: 'ping' }).code, 'bad_key', 'the old key stops working');
});

test('the link opened in a browser shows a plain message and no data', () => {
  const s = loadScript({ sheets: sheetsFrom(buildRaw({})) });
  assert.match(s.ctx.doGet().getContent(), /link works/);
});

test('pull returns only the app tabs, header first, typed values kept', () => {
  const raw = buildRaw({});
  raw.tasks.push(taskRow('a'));
  const sheets = sheetsFrom(raw);
  sheets.screentime = new FakeSheet('screentime', [['date', 'minutes'], ['2026-11-22', 120]]);
  const s = loadScript({ sheets });
  const res = s.post({ key: TEST_KEY, action: 'pull', widths });
  assert.equal(res.ok, true);
  assert.deepEqual(Object.keys(res.tabs).sort(), [...APP_TABS].sort());
  assert.equal(res.tabs.tasks[0][0], 'id');
  assert.equal(res.tabs.tasks[1][7], false);
});

test('writes to tabs outside the app list are refused', () => {
  const sheets = sheetsFrom(buildRaw({}));
  sheets._schema = new FakeSheet('_schema', [['rule']]);
  const s = loadScript({ sheets });
  const res = s.post({ key: TEST_KEY, action: 'write', appends: [{ tab: '_schema', rows: [['x']] }] });
  assert.equal(res.ok, false);
  assert.equal(sheets._schema.rows().length, 1);
});

test('an update whose row moved finds the row by its key', () => {
  const raw = buildRaw({});
  raw.tasks.push(taskRow('a', 'A'), taskRow('b', 'B'));
  const sheets = sheetsFrom(raw);
  const s = loadScript({ sheets });
  // The app last saw "b" at row 3; someone has since moved it to row 2.
  sheets.tasks.cells.splice(1, 1);
  const res = s.post({ key: TEST_KEY, action: 'write', updates: [{ tab: 'tasks', row: 3, key: 'b', values: taskRow('b', 'B edited') }] });
  assert.deepEqual(res.updated, [2]);
  assert.equal(sheets.tasks.get(2, 2), 'B edited');
  assert.equal(sheets.tasks.getLastRow(), 2, 'nothing written to the old row');
});

test('an update for a row that was deleted adds it back instead of overwriting another row', () => {
  const raw = buildRaw({});
  raw.tasks.push(taskRow('a', 'A'));
  const sheets = sheetsFrom(raw);
  const s = loadScript({ sheets });
  const res = s.post({ key: TEST_KEY, action: 'write', updates: [{ tab: 'tasks', row: 2, key: 'gone', values: taskRow('gone', 'Back') }] });
  assert.deepEqual(res.updated, [3]);
  assert.equal(sheets.tasks.get(2, 1), 'a');
  assert.equal(sheets.tasks.get(3, 1), 'gone');
});

test('a row whose key does not match its values is refused', () => {
  const s = loadScript({ sheets: sheetsFrom(buildRaw({})) });
  const res = s.post({ key: TEST_KEY, action: 'write', updates: [{ tab: 'tasks', row: 2, key: 'x', values: taskRow('y') }] });
  assert.equal(res.code, 'bad_request');
});

test('text stays text: dates, naps and formula-like titles are stored as plain text', () => {
  const sheets = sheetsFrom(buildRaw({}));
  const s = loadScript({ sheets });
  const day = ['2026-11-22', '+15-16', 30, 'none', '', 4, '', '=1+1', '2026-11-22T10:00:00Z', 'app'];
  s.post({ key: TEST_KEY, action: 'write', appends: [{ tab: 'days', rows: [day] }] });
  const f = sheets.days.formats[1];
  assert.equal(f[0], '@');
  assert.equal(f[1], '@');
  assert.equal(f[7], '@');
  assert.notEqual(f[2], '@', 'numbers keep their number format');
  assert.notEqual(f[4], '@', 'empty cells keep their format');
  assert.equal(sheets.days.get(2, 3), 30);
});

test('when the grid is full, rows are added to it', () => {
  const raw = buildRaw({});
  raw.cigs.push(['c1', '2026-11-22T10:00:00Z', '2026-11-22', '']);
  const sheets = sheetsFrom(raw, 2);
  const s = loadScript({ sheets });
  const res = s.post({ key: TEST_KEY, action: 'write', appends: [{ tab: 'cigs', rows: [['c2', 'x', 'y', ''], ['c3', 'x', 'y', '']] }] });
  assert.deepEqual(res.appended.cigs, [3, 4]);
  assert.equal(sheets.cigs.getMaxRows(), 4);
});

test('a busy sheet is reported as busy and nothing is written', () => {
  const sheets = sheetsFrom(buildRaw({}));
  const s = loadScript({ sheets });
  s.lock.held = true;
  const res = s.post({ key: TEST_KEY, action: 'write', appends: [{ tab: 'tasks', rows: [taskRow('a')] }] });
  assert.equal(res.code, 'busy');
  assert.equal(sheets.tasks.getLastRow(), 1);
});
