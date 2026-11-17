import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncOnce, parseSnapshot } from '../sync.js';
import { Store } from '../store.js';
import { SchemaError, TABS } from '../schema.js';
import { MemStorage, buildRaw, fakeApi } from './helpers.js';

const token = async () => 'test-token';
const task = (over = {}) => ({
  id: 't1', title: 'Task', description: '', tags: [], importance: 'Medium', deadline: '',
  status: 'open', claudeDecides: false, sourcePick: '', createdAt: '2026-11-17T08:00:00Z',
  updatedAt: '2026-11-17T08:00:00Z', updatedBy: 'app', doneAt: '', deletedAt: '', ...over,
});
const newStore = () => new Store(new MemStorage());
const run = (store, api) => syncOnce(store, { sheetId: 'S', getToken: token, api });

test('a task made offline is appended to the sheet and then visible from the cache', async () => {
  const { api, calls, raw } = fakeApi(buildRaw({}));
  const store = newStore();
  store.enqueue('tasks', task({ id: 'n1', title: 'New task' }));
  const result = await run(store, api);
  assert.equal(result.pushed, 1);
  assert.equal(calls.appends.length, 1);
  assert.equal(calls.appends[0].tab, 'tasks');
  assert.equal(calls.appends[0].start, 2, 'first data row is row 2');
  assert.equal(store.data.outbox.length, 0);
  assert.equal(raw.tasks.length, 2);
  const [row] = store.rows('tasks');
  assert.equal(row.title, 'New task');
  assert.equal(row._row, 2);
});

test('an edit to a row that exists updates that row in place', async () => {
  const base = buildRaw({ tasks: [task({ id: 't1', title: 'Old' })] });
  const { api, calls } = fakeApi(base);
  const store = newStore();
  store.enqueue('tasks', task({ id: 't1', title: 'New', updatedAt: '2026-11-17T09:00:00Z' }));
  await run(store, api);
  assert.equal(calls.appends.length, 0);
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0][0].range, 'tasks!A2:N2');
  assert.equal(calls.writes[0][0].values[1], 'New');
});

test('a newer edit on another device is kept, and the older queued edit is dropped', async () => {
  const base = buildRaw({ tasks: [task({ id: 't1', title: 'Claude wrote this', updatedAt: '2026-11-17T10:00:00Z', updatedBy: 'claude' })] });
  const { api, calls } = fakeApi(base);
  const store = newStore();
  store.enqueue('tasks', task({ id: 't1', title: 'My older phone edit', updatedAt: '2026-11-17T09:00:00Z' }));
  const result = await run(store, api);
  assert.equal(result.superseded, 1);
  assert.equal(calls.writes.length, 0);
  assert.equal(calls.appends.length, 0);
  assert.equal(store.data.outbox.length, 0);
  assert.equal(store.rows('tasks')[0].title, 'Claude wrote this');
});

test('an edit identical to the sheet is not written again', async () => {
  const same = task({ id: 't1', title: 'Same' });
  const { api, calls } = fakeApi(buildRaw({ tasks: [same] }));
  const store = newStore();
  store.enqueue('tasks', same);
  const result = await run(store, api);
  assert.equal(result.pushed, 0);
  assert.equal(calls.writes.length, 0);
  assert.equal(store.data.outbox.length, 0);
});

test('a renamed column stops the sync before anything is written', async () => {
  const raw = buildRaw({ tasks: [task({ id: 't1' })] });
  raw.tasks[0][3] = 'categories';
  const { api, calls } = fakeApi(raw);
  const store = newStore();
  store.enqueue('tasks', task({ id: 'n1', title: 'Queued' }));
  await assert.rejects(run(store, api), SchemaError);
  assert.equal(calls.writes.length, 0);
  assert.equal(calls.appends.length, 0);
  assert.equal(store.data.outbox.length, 1, 'the edit waits for the next try');
});

test('a sheet on another schema version is refused', () => {
  const raw = buildRaw({ settings: [{ key: 'schema_version', value: '2', updatedAt: '2026-11-17T00:00:00Z' }] });
  assert.throws(() => parseSnapshot(raw), SchemaError);
});

test('a failed write keeps the change queued and it goes out on the next try', async () => {
  const { api, calls } = fakeApi(buildRaw({ tasks: [task({ id: 't1', title: 'Old' })] }));
  const store = newStore();
  store.enqueue('tasks', task({ id: 't1', title: 'Important', updatedAt: '2026-11-17T09:00:00Z' }));
  api.failWrites = true;
  await assert.rejects(run(store, api), /write failed/);
  assert.equal(store.data.outbox.length, 1);
  api.failWrites = false;
  await run(store, api);
  assert.equal(store.data.outbox.length, 0);
  assert.equal(calls.writes.length, 1);
});

test('a cigarette tap is appended once and an undo updates that same row', async () => {
  const { api, calls } = fakeApi(buildRaw({}));
  const store = newStore();
  const tap = { id: 'c1', at: '2026-11-17T09:00:00.000Z', day: '2026-11-17', deletedAt: '' };
  store.enqueue('cigs', tap);
  await run(store, api);
  assert.equal(calls.appends[0].tab, 'cigs');
  store.enqueue('cigs', { ...tap, deletedAt: '2026-11-17T09:05:00.000Z' });
  await run(store, api);
  assert.equal(calls.writes[0][0].range, 'cigs!A2:D2');
  assert.equal(calls.writes[0][0].values[3], '2026-11-17T09:05:00.000Z');
});

test('blank rows in the sheet do not shift the row numbers used for updates', async () => {
  const raw = buildRaw({ tasks: [task({ id: 'a' }), task({ id: 'b', title: 'Second' })] });
  raw.tasks.splice(2, 0, []);
  const { api, calls } = fakeApi(raw);
  const store = newStore();
  store.enqueue('tasks', task({ id: 'b', title: 'Second, edited', updatedAt: '2026-11-17T09:00:00Z' }));
  await run(store, api);
  assert.equal(calls.writes[0][0].range, 'tasks!A4:N4');
  const parsed = parseSnapshot(buildRaw({ tasks: [task({ id: 'x' })] }));
  assert.equal(parsed.tasks[0]._row, 2);
  assert.equal(TABS.tasks.key, 'id');
});
