import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDateInput, typed, longDate, quickDates, nextWeekday } from '../dates.js';
import { UndoHistory } from '../undo.js';

const T = '2026-11-22'; // a Sunday
const p = (s, today = T) => parseDateInput(s, today).key;

test('day first, year optional', () => {
  assert.equal(p('24.11'), '2026-11-24');
  assert.equal(p('24/11'), '2026-11-24');
  assert.equal(p('24-11'), '2026-11-24');
  assert.equal(p('24 11'), '2026-11-24');
  assert.equal(p('24.11.2026'), '2026-11-24');
  assert.equal(p('24.11.27'), '2027-11-24');
  assert.equal(p('3.12'), '2026-12-03');
  assert.equal(p('2026-11-24'), '2026-11-24');
});

test('a day alone means this month, or next month once it has passed', () => {
  assert.equal(p('28'), '2026-11-28');
  assert.equal(p('5'), '2026-12-05');
  assert.equal(p('5', '2026-12-20'), '2027-01-05');
});

test('without a year, a date long gone means next year; a recent one stays this year', () => {
  assert.equal(p('15.01'), '2027-01-15');
  assert.equal(p('20.11'), '2026-11-20', 'two days ago stays, so an overdue date can be entered');
});

test('words, weekdays, months and offsets', () => {
  assert.equal(p('today'), T);
  assert.equal(p('tomorrow'), '2026-11-23');
  assert.equal(p('tmr'), '2026-11-23');
  assert.equal(p('fri'), '2026-11-27');
  assert.equal(p('friday'), '2026-11-27');
  assert.equal(p('sun'), T, 'the same weekday is today');
  assert.equal(p('next sun'), '2026-11-29');
  assert.equal(p('+3'), '2026-11-25');
  assert.equal(p('+2w'), '2026-12-06');
  assert.equal(p('10d'), '2026-12-02');
  assert.equal(p('24 nov'), '2026-11-24');
  assert.equal(p('3 jan'), '2027-01-03');
  assert.equal(p('24 december 2026'), '2026-12-24');
});

test('impossible or unreadable dates are refused, never guessed', () => {
  for (const s of ['31.02', '0001-02-12', '32', '12.13', 'soon', '24.11.1999', '2.3.4.5']) {
    const r = parseDateInput(s, T);
    assert.equal(r.key, '', s);
    assert.ok(r.error, s);
  }
  assert.deepEqual(parseDateInput('  ', T), { key: '' });
});

test('display helpers and quick picks', () => {
  assert.equal(typed('2026-11-24'), '24.11.2026');
  assert.equal(longDate('2026-11-24'), 'Tue 24 Nov 2026');
  const q = Object.fromEntries(quickDates(T));
  assert.equal(q.Today, T);
  assert.equal(q.Tomorrow, '2026-11-23');
  assert.equal(q.Sat, '2026-11-28');
  assert.equal(q['Next Mon'], '2026-11-23');
  assert.equal(nextWeekday('2026-11-23', 1, { after: true }), '2026-11-30');
});

test('undo keeps one entry per action, newest first, within a limit', () => {
  const u = new UndoHistory({ limit: 3 });
  u.record('Added task', 'tasks', 'a', null);
  u.record('Deleted task', 'tasks', 'b', { id: 'b', title: 'B' });
  assert.equal(u.size, 2);
  const e = u.pop();
  assert.equal(e.label, 'Deleted task');
  assert.deepEqual(e.items[0].before, { id: 'b', title: 'B' });
  for (const k of ['c', 'd', 'e', 'f']) u.record('Added task', 'tasks', k, null);
  assert.equal(u.size, 3);
  assert.equal(u.last.items[0].key, 'f');
});

test('typing in the same field merges into one undo step that goes back to the first version', () => {
  let now = 0;
  const u = new UndoHistory({ mergeMs: 5000, now: () => now });
  u.record('Edited today', 'days', '2026-11-22', { note: '' });
  now = 2000;
  u.record('Edited today', 'days', '2026-11-22', { note: 'h' });
  now = 4000;
  u.record('Edited today', 'days', '2026-11-22', { note: 'he' });
  assert.equal(u.size, 1);
  assert.deepEqual(u.last.items[0].before, { note: '' });
  now = 20000;
  u.record('Edited today', 'days', '2026-11-22', { note: 'hello' });
  assert.equal(u.size, 2, 'a pause starts a new step');
});

test('a grouped action is undone as one step', () => {
  const u = new UndoHistory();
  u.group('Task from pick', () => {
    u.record('x', 'tasks', 'n1', null);
    u.record('x', 'picks', 'p1', { id: 'p1', status: 'new' });
  });
  assert.equal(u.size, 1);
  assert.equal(u.last.items.length, 2);
  assert.equal(u.last.label, 'Task from pick');
});

test('the saved version is a copy, so later edits do not change it', () => {
  const u = new UndoHistory();
  const rec = { id: 'a', tags: ['x'] };
  u.record('Edit', 'tasks', 'a', rec);
  rec.tags.push('y');
  assert.deepEqual(u.last.items[0].before.tags, ['x']);
});
