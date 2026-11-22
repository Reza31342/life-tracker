import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRanges, rangesTotal, parseDuration, fmtHM } from '../time.js';

test('sleep and work ranges in many spellings give the same total', () => {
  for (const s of ['23:30-7:15, 14-15', '23:30-7:15 14-15', '23.30 - 7.15; 14-15', '23h30-7h15 and 14-15',
    '2330-0715, 1400-1500', '11:30pm-7:15am, 2pm-3pm', '23:30 to 7:15, 14 to 15', '23:30–7:15 +14-15']) {
    assert.equal(rangesTotal(s), 465 + 60, s);
  }
  assert.equal(rangesTotal('9-12:30, 13:30-18'), 210 + 270);
});

test('parts that are not time ranges are counted, not guessed', () => {
  const r = parseRanges('23:30-7:15, slept badly');
  assert.equal(r.blocks.length, 1);
  assert.equal(r.bad, 2);
  assert.equal(parseRanges('25-3').bad, 1);
  assert.equal(parseRanges('').blocks.length, 0);
});

test('work hours: an afternoon end without am/pm counts as pm', () => {
  const w = (t) => rangesTotal(t, { daytime: true });
  assert.equal(w('9-5'), 480);
  assert.equal(w('about 9 to 5'), 480);
  assert.equal(w('9-12:30, 1:30-6'), 210 + 270);
  assert.equal(w('22-6'), 480, 'a night shift still crosses midnight');
  assert.equal(w('9am-5am'), 1200, 'explicit am is respected');
  assert.equal(rangesTotal('23-7'), 480, 'sleep is unchanged');
});

test('a leading + still marks a nap', () => {
  const r = parseRanges('23-7 +14-15');
  assert.deepEqual(r.blocks.map((b) => b.nap), [false, true]);
});

test('durations in hours and minutes', () => {
  const m = (s) => parseDuration(s).min;
  assert.equal(m('2:45'), 165);
  assert.equal(m('2.45'), 165, 'two digits after the dot are minutes');
  assert.equal(m('2,45'), 165);
  assert.equal(m('1.5'), 90, 'one digit after the dot is a decimal hour');
  assert.equal(m('1.5h'), 90);
  assert.equal(m('2h45'), 165);
  assert.equal(m('2h 45m'), 165);
  assert.equal(m('2h'), 120);
  assert.equal(m('90m'), 90);
  assert.equal(m('2'), 120, 'a small bare number is hours');
  assert.equal(m('45'), 45, 'a larger bare number is minutes');
  assert.equal(m('0:20'), 20);
  assert.equal(m(''), null);
  for (const bad of ['2:75', 'abc', '30h', '2:4']) assert.ok(parseDuration(bad).error, bad);
});

test('durations show as h:mm', () => {
  assert.equal(fmtHM(165), '2:45');
  assert.equal(fmtHM(45), '0:45');
  assert.equal(fmtHM(0), '0:00');
  assert.equal(fmtHM(null), '');
});
