import { test } from 'node:test';
import assert from 'node:assert/strict';
import { typed, longDate, weekdayOf, keyOf } from '../dates.js';
import { UndoHistory } from '../undo.js';

test('dates show day first', () => {
  assert.equal(typed('2026-11-24'), '24.11.2026');
  assert.equal(longDate('2026-11-24'), 'Tue 24 Nov 2026');
  assert.equal(weekdayOf('2026-11-23'), 1);
  assert.equal(keyOf(2026, 3, 5), '2026-03-05');
  assert.equal(typed('nope'), '');
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
