import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toRow, fromRow, checkHeaders, SchemaError, logicalDay, shiftDay, dayDiff, ms, setZone, TABS } from '../schema.js';

test('a task survives a round trip with its types intact', () => {
  const task = {
    id: 't1', title: 'Hand in form', description: '', tags: ['uni', 'design'],
    importance: 'MUST DO', deadline: '2026-11-20', status: 'open', claudeDecides: false,
    sourcePick: '', createdAt: '2026-11-17T08:00:00.000Z', updatedAt: '2026-11-17T08:00:00.000Z',
    updatedBy: 'app', doneAt: '', deletedAt: '',
  };
  const row = toRow('tasks', task);
  assert.equal(row[7], false, 'claude_decides is a real boolean');
  assert.equal(row[3], 'uni, design', 'tags go out comma-separated');
  const back = fromRow('tasks', row, 2);
  assert.deepEqual(back.tags, ['uni', 'design']);
  assert.equal(back.claudeDecides, false);
  assert.equal(back._row, 2);
});

test('a claude-decides task keeps the flag as a boolean and the importance blank', () => {
  const row = toRow('tasks', { id: 't2', title: 'x', claudeDecides: true, importance: '' });
  assert.equal(row[7], true);
  assert.equal(row[4], '');
  assert.equal(fromRow('tasks', ['t2', 'x', '', '', '', '', 'open', 'TRUE'], 3).claudeDecides, true);
});

test('empty numbers stay blank, they are not written as zero', () => {
  const col = (name) => TABS.days.cols.findIndex((c) => c[0] === name);
  const row = toRow('days', { date: '2026-11-17', walkingMin: null, gymMin: undefined, energy: 4, studyMin: 0 });
  assert.equal(row[col('walking_min')], '');
  assert.equal(row[col('gym_min')], '');
  assert.equal(row[col('sleep_quality')], '');
  assert.equal(row[col('energy')], 4);
  assert.equal(row[col('study_min')], 0, 'zero is kept as zero');
  const raw = Array(TABS.days.cols.length).fill('');
  raw[col('date')] = '2026-11-17';
  raw[col('energy')] = 4;
  raw[col('work')] = '9-12:30 14-18';
  const back = fromRow('days', raw, 2);
  assert.equal(back.walkingMin, null);
  assert.equal(back.energy, 4);
  assert.equal(back.work, '9-12:30 14-18');
});

test('a renamed or moved column stops the sync instead of writing to the wrong place', () => {
  const header = TABS.tasks.cols.map((c) => c[0]);
  checkHeaders('tasks', header);
  const renamed = [...header];
  renamed[3] = 'categories';
  assert.throws(() => checkHeaders('tasks', renamed), SchemaError);
  const short = header.slice(0, 5);
  assert.throws(() => checkHeaders('tasks', short), SchemaError);
});

test('logical day switches at the 04:00 Berlin rollover', () => {
  setZone({ timezone: 'Europe/Berlin', rollover: 4 });
  // 03:30 Berlin on 18 Nov (CET, UTC+1) still belongs to 17 Nov.
  assert.equal(logicalDay(new Date('2026-11-18T02:30:00Z')), '2026-11-17');
  // 04:30 Berlin on 18 Nov is the 18th.
  assert.equal(logicalDay(new Date('2026-11-18T03:30:00Z')), '2026-11-18');
  // Summer time (CEST, UTC+2): 03:30 Berlin on 1 Jul belongs to 30 Jun.
  assert.equal(logicalDay(new Date('2026-07-01T01:30:00Z')), '2026-06-30');
});

test('calendar arithmetic crosses month and year boundaries', () => {
  assert.equal(shiftDay('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftDay('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftDay('2026-12-31', 1), '2027-01-01');
  assert.equal(dayDiff('2026-11-17', '2026-11-20'), 3);
  assert.equal(dayDiff('2026-11-17', '2026-11-16'), -1);
});

test('timestamps compare as times, not as text', () => {
  const a = '2026-11-17T09:12:00Z';
  const b = '2026-11-17T09:12:00.500Z';
  assert.ok(ms(b) > ms(a));
  assert.ok(ms(undefined) === -Infinity);
});
