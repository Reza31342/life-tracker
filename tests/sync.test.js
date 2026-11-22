import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncOnce, parseSnapshot } from '../sync.js';
import { Store } from '../store.js';
import { SchemaError, TABS } from '../schema.js';
import { BridgeError } from '../bridge.js';
import { MemStorage, buildRaw, fakeApi } from './helpers.js';

const task = (over = {}) => ({
  id: 't1', title: 'Task', description: '', tags: [], importance: 'Medium', deadline: '',
  status: 'open', claudeDecides: false, sourcePick: '', createdAt: '2026-11-17T08:00:00Z',
  updatedAt: '2026-11-17T08:00:00Z', updatedBy: 'app', doneAt: '', deletedAt: '', ...over,
});
const newStore = () => new Store(new MemStorage());
const run = (store, api) => syncOnce(store, { api });

test('a task made offline is added to the sheet and then visible from the cache', async () => {
  const { api, calls, sheets } = fakeApi(buildRaw({}));
  const store = newStore();
  store.enqueue('tasks', task({ id: 'n1', title: 'New task' }));
  const result = await run(store, api);
  assert.equal(result.pushed, 1);
  assert.equal(calls.writes.length, 1, 'one write request per sync');
  assert.equal(calls.writes[0].appends[0].tab, 'tasks');
  assert.equal(sheets.tasks.rows()[1][1], 'New task', 'first data row is row 2');
  assert.equal(store.data.outbox.length, 0);
  const [row] = store.rows('tasks');
  assert.equal(row.title, 'New task');
  assert.equal(row._row, 2);
});

test('an edit to a row that exists updates that row in place', async () => {
  const { api, calls, sheets } = fakeApi(buildRaw({ tasks: [task({ id: 't1', title: 'Old' })] }));
  const store = newStore();
  store.enqueue('tasks', task({ id: 't1', title: 'New', updatedAt: '2026-11-17T09:00:00Z' }));
  await run(store, api);
  assert.equal(calls.writes[0].appends.length, 0);
  assert.equal(calls.writes[0].updates[0].row, 2);
  assert.equal(sheets.tasks.rows().length, 2, 'no new row');
  assert.equal(sheets.tasks.rows()[1][1], 'New');
});

test('a newer edit on another device is kept, and the older queued edit is dropped', async () => {
  const base = buildRaw({ tasks: [task({ id: 't1', title: 'Claude wrote this', updatedAt: '2026-11-17T10:00:00Z', updatedBy: 'claude' })] });
  const { api, calls } = fakeApi(base);
  const store = newStore();
  store.enqueue('tasks', task({ id: 't1', title: 'My older phone edit', updatedAt: '2026-11-17T09:00:00Z' }));
  const result = await run(store, api);
  assert.equal(result.superseded, 1);
  assert.equal(calls.writes.length, 0);
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
  assert.equal(store.data.outbox.length, 1, 'the edit waits for the next try');
});

test('a sheet on another schema version is refused', () => {
  const raw = buildRaw({ settings: [{ key: 'schema_version', value: '99', updatedAt: '2026-11-17T00:00:00Z' }] });
  assert.throws(() => parseSnapshot(raw), SchemaError);
});

test('a failed write keeps the change queued and it goes out on the next try', async () => {
  const { api, calls, sheets } = fakeApi(buildRaw({ tasks: [task({ id: 't1', title: 'Old' })] }));
  const store = newStore();
  store.enqueue('tasks', task({ id: 't1', title: 'Important', updatedAt: '2026-11-17T09:00:00Z' }));
  api.failWrites = true;
  await assert.rejects(run(store, api), (err) => err instanceof BridgeError && err.code === 'offline');
  assert.equal(store.data.outbox.length, 1);
  api.failWrites = false;
  await run(store, api);
  assert.equal(store.data.outbox.length, 0);
  assert.equal(calls.writes.length, 1);
  assert.equal(sheets.tasks.rows()[1][1], 'Important');
});

test('a cigarette tap is added once and an undo updates that same row', async () => {
  const { api, sheets } = fakeApi(buildRaw({}));
  const store = newStore();
  const tap = { id: 'c1', at: '2026-11-17T09:00:00.000Z', day: '2026-11-17', deletedAt: '' };
  store.enqueue('cigs', tap);
  await run(store, api);
  store.enqueue('cigs', { ...tap, deletedAt: '2026-11-17T09:05:00.000Z' });
  await run(store, api);
  const rows = sheets.cigs.rows();
  assert.equal(rows.length, 2, 'header and one tap');
  assert.equal(rows[1][3], '2026-11-17T09:05:00.000Z');
});

test('blank rows in the sheet do not shift the row numbers used for updates', async () => {
  const raw = buildRaw({ tasks: [task({ id: 'a' }), task({ id: 'b', title: 'Second' })] });
  raw.tasks.splice(2, 0, []);
  const { api, calls, sheets } = fakeApi(raw);
  const store = newStore();
  store.enqueue('tasks', task({ id: 'b', title: 'Second, edited', updatedAt: '2026-11-17T09:00:00Z' }));
  await run(store, api);
  assert.equal(calls.writes[0].updates[0].row, 4);
  assert.equal(sheets.tasks.rows()[3][1], 'Second, edited');
  const parsed = parseSnapshot(buildRaw({ tasks: [task({ id: 'x' })] }));
  assert.equal(parsed.tasks[0]._row, 2);
  assert.equal(TABS.tasks.key, 'id');
});

test('new rows go right under the last task even when empty rows hold unticked checkboxes', async () => {
  const raw = buildRaw({ tasks: [task({ id: 'a' })] });
  for (let i = 0; i < 50; i += 1) raw.tasks.push(['', '', '', '', '', '', '', false]);
  const { api, sheets } = fakeApi(raw);
  const store = newStore();
  store.enqueue('tasks', task({ id: 'n1', title: 'Goes to row 3' }));
  await run(store, api);
  assert.equal(sheets.tasks.get(3, 1), 'n1');
  assert.equal(store.rows('tasks').find((t) => t.id === 'n1')._row, 3);
  assert.equal(sheets.tasks.getMaxRows(), 1000, 'the grid did not grow');
});

test('a write that reaches the sheet but loses its reply is not duplicated on retry', async () => {
  const { api, sheets, script } = fakeApi(buildRaw({}));
  const store = newStore();
  store.enqueue('tasks', task({ id: 'n1', title: 'Once' }));
  // The script writes, then the reply is lost: the app still has the change queued.
  const original = api.write;
  api.write = async (payload) => { await original(payload); throw new BridgeError('No connection to the sheet', 'offline'); };
  await assert.rejects(run(store, api));
  assert.equal(store.data.outbox.length, 1);
  api.write = original;
  await run(store, api);
  const ids = sheets.tasks.rows().slice(1).map((r) => r[0]);
  assert.deepEqual(ids, ['n1']);
  assert.equal(store.data.outbox.length, 0);
  assert.ok(script);
});

test('the sync key travels in the request body, not in the link', async () => {
  const seen = [];
  const { createBridge } = await import('../bridge.js');
  const api = createBridge({
    url: 'https://script.google.com/macros/s/AKfycbTESTdeploymentIdForTests000/exec',
    key: 'secret-key',
    fetch: async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, text: async () => '{"ok":true,"title":"T"}' }; },
  });
  await api.ping();
  assert.ok(!seen[0].url.includes('secret-key'));
  assert.equal(JSON.parse(seen[0].init.body).key, 'secret-key');
  assert.equal(seen[0].init.credentials, 'omit');
});
