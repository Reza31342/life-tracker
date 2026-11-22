import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, fromV1, dedupe } from '../store.js';
import { MemStorage } from './helpers.js';
import { logicalDay } from '../schema.js';

const v1 = {
  tasks: [
    { id: 'a', title: 'Pay rent', tags: ['paper', 'claude-decides'], importance: null, claudeDecides: true, status: 'open', deadline: '', createdAt: '2026-11-10T08:00:00.000Z', updatedAt: '2026-11-10T08:00:00.000Z' },
    { id: 'b', title: 'Read chapter', tags: ['uni'], importance: 'High', claudeDecides: false, status: 'done', deadline: '2026-11-18', createdAt: '2026-11-11T08:00:00.000Z', updatedAt: '2026-11-12T08:00:00.000Z' },
  ],
  days: {
    '2026-11-16': { sleep: '23:30-7:15 +15-16', walkingMin: 25, gymType: 'none', gymMin: 5, energy: 4, mood: null, note: '', updatedAt: '2026-11-16T07:00:00.000Z' },
  },
  cigs: [{ id: 'c1', at: '2026-11-18T02:30:00.000Z' }],
  picks: [
    { id: 'p1', kind: 'paper', title: 'Real pick', status: 'saved', rank: 1, week: '2026-W47', createdAt: '2026-11-16T10:00:00.000Z' },
    { id: 'sample-paper', kind: 'paper', title: 'Sample paper', source: 'sample', status: 'active' },
  ],
  settings: { sheetId: 'SHEET123', profile: 'old text' },
};

test('the prototype data migrates into the outbox with the sheet shapes', () => {
  const { ops, sheetId } = fromV1(v1, '2026-11-17T00:00:00.000Z');
  assert.equal(sheetId, 'SHEET123');
  const byTab = (t) => ops.filter(([tab]) => tab === t).map(([, r]) => r);

  const [pay, read] = byTab('tasks');
  assert.deepEqual(pay.tags, ['paper'], 'claude-decides tag is removed; the flag carries it');
  assert.equal(pay.claudeDecides, true);
  assert.equal(pay.importance, '');
  assert.equal(read.doneAt, '2026-11-12T08:00:00.000Z');

  const [day] = byTab('days');
  assert.equal(day.gymType, 'none');
  assert.equal(day.gymMin, null, 'gym minutes are blank when there is no gym');
  assert.equal(day.mood, null);

  const [tap] = byTab('cigs');
  // 02:30 UTC is 03:30 in Berlin on 18 Nov, so it counts toward the 17th.
  assert.equal(tap.day, '2026-11-17');
  assert.equal(tap.deletedAt, '');

  const picks = byTab('picks');
  assert.equal(picks.length, 1, 'sample picks are not migrated');
  assert.equal(picks[0].status, 'useful', 'saved becomes useful');
});

test('opening the store twice migrates only once', () => {
  const storage = new MemStorage();
  storage.setItem('life-tracker.v1', JSON.stringify(v1));
  const first = new Store(storage);
  const count = first.data.outbox.length;
  assert.ok(count > 0);
  const second = new Store(storage);
  assert.equal(second.data.outbox.length, count);
  assert.equal(second.data.migratedFrom, 'v1');
});

test('a second edit to the same record replaces the first one in the outbox', () => {
  const store = new Store(new MemStorage());
  const rec = { id: 't', title: 'one', tags: [], claudeDecides: false, importance: 'Low', status: 'open', updatedAt: '2026-11-17T08:00:00.000Z' };
  store.enqueue('tasks', rec);
  store.enqueue('tasks', { ...rec, title: 'two', updatedAt: '2026-11-17T08:01:00.000Z' });
  assert.equal(store.data.outbox.length, 1);
  assert.equal(store.data.outbox[0].rec.title, 'two');
});

test('the screen shows queued edits on top of the last copy from the sheet', () => {
  const store = new Store(new MemStorage());
  store.setCache({ tasks: [{ id: 't', title: 'old', _row: 4, updatedAt: '2026-11-17T07:00:00.000Z' }], days: [], cigs: [], picks: [], settings: [] });
  store.enqueue('tasks', { id: 't', title: 'new', updatedAt: '2026-11-17T08:00:00.000Z' });
  const [row] = store.rows('tasks');
  assert.equal(row.title, 'new');
  assert.equal(row._row, 4, 'the sheet row is kept so the next write updates it in place');
});

test('duplicate keys resolve to the newest copy', () => {
  const map = dedupe([
    { date: '2026-11-17', energy: 2, updatedAt: '2026-11-17T08:00:00Z', _row: 3 },
    { date: '2026-11-17', energy: 5, updatedAt: '2026-11-17T09:00:00Z', _row: 9 },
    { date: '2026-11-17', energy: 1, updatedAt: '2026-11-17T07:00:00Z', _row: 4 },
  ], 'date');
  assert.equal(map.get('2026-11-17').energy, 5);
  assert.equal(map.get('2026-11-17')._row, 9);
});

test('the rollover hour from the settings tab applies to later reads', () => {
  const store = new Store(new MemStorage());
  const at = new Date('2026-11-18T04:30:00Z'); // 05:30 in Berlin
  store.setCache({ tasks: [], days: [], cigs: [], picks: [], settings: [
    { key: 'timezone', value: 'Europe/Berlin' },
    { key: 'day_rollover_hour', value: '6' },
  ] });
  assert.equal(logicalDay(at), '2026-11-17', 'with a 06:00 rollover, 05:30 is still the 17th');
  store.setCache({ tasks: [], days: [], cigs: [], picks: [], settings: [
    { key: 'timezone', value: 'Europe/Berlin' },
    { key: 'day_rollover_hour', value: '4' },
  ] });
  assert.equal(logicalDay(at), '2026-11-18');
});

test('a device saved by the Google sign-in version drops its client and sheet ids and their old error', () => {
  const storage = new MemStorage();
  storage.setItem('life-tracker.v2', JSON.stringify({
    v: 2, cache: {}, outbox: [], seq: 0,
    device: { clientId: 'x.apps.googleusercontent.com', sheetId: 'S', lastSyncAt: '2026-11-22T20:00:00Z', lastError: 'Sign in to Google again in Settings' },
  }));
  const store = new Store(storage);
  assert.deepEqual(store.data.device, { bridgeUrl: '', bridgeKey: '', lastSyncAt: '2026-11-22T20:00:00Z', lastError: '' });
});
