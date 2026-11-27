import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBoard, serializeBoard, emptyBoard, removeItem, addLink, zoomAt, toWorld, clampZoom,
  edgePoint, fitView, ZOOM_MIN, ZOOM_MAX,
} from '../board.js';

const sample = {
  v: 1,
  items: [
    { id: 'c1', type: 'task', task: 't1', x: 10.4, y: 20.6, note: 'call first' },
    { id: 'n1', type: 'note', x: 300, y: 40, text: 'Idea\nsecond line' },
    { id: 'x1', type: 'text', x: -50, y: -80, text: 'Week plan' },
  ],
  links: [{ id: 'l1', from: 'c1', to: 'n1' }],
};

test('round trip keeps items, notes and arrows; coordinates become whole numbers', () => {
  const b = parseBoard(serializeBoard(parseBoard(JSON.stringify(sample))));
  assert.equal(b.items.length, 3);
  assert.deepEqual(b.items[0], { id: 'c1', type: 'task', task: 't1', x: 10, y: 21, note: 'call first' });
  assert.equal(b.items[1].text, 'Idea\nsecond line');
  assert.deepEqual(b.links, [{ id: 'l1', from: 'c1', to: 'n1' }]);
});

test('broken or empty text gives an empty board', () => {
  assert.deepEqual(parseBoard(''), emptyBoard());
  assert.deepEqual(parseBoard('{not json'), emptyBoard());
  assert.deepEqual(parseBoard('42'), emptyBoard());
});

test('unknown types, task cards without a task, duplicate ids and dangling arrows are dropped', () => {
  const b = parseBoard(JSON.stringify({
    items: [
      { id: 'a', type: 'note', x: 0, y: 0, text: 'ok' },
      { id: 'a', type: 'note', x: 1, y: 1, text: 'dup' },
      { id: 'b', type: 'circle', x: 0, y: 0 },
      { id: 'c', type: 'task', x: 0, y: 0 },
      { id: 'd', type: 'text', x: 'nope', y: 5, text: 'x' },
    ],
    links: [{ id: 'l', from: 'a', to: 'zzz' }, { id: 'm', from: 'a', to: 'a' }, { id: 'n', from: 'a', to: 'd' }, { id: 'o', from: 'a', to: 'd' }],
  }));
  assert.deepEqual(b.items.map((i) => i.id), ['a', 'd']);
  assert.equal(b.items[1].x, 0);
  assert.deepEqual(b.links.map((l) => l.id), ['n']);
});

test('removing an item removes its arrows; arrows are not duplicated or self-pointing', () => {
  const b = parseBoard(JSON.stringify(sample));
  const r = removeItem(b, 'n1');
  assert.equal(r.items.length, 2);
  assert.equal(r.links.length, 0);
  assert.equal(addLink(b, 'c1', 'n1'), b);
  assert.equal(addLink(b, 'c1', 'c1'), b);
  assert.equal(addLink(b, 'n1', 'c1').links.length, 2);
});

test('zooming keeps the point under the cursor in place, within limits', () => {
  const v = { x: 100, y: 50, z: 1 };
  const before = toWorld(v, 400, 300);
  const v2 = zoomAt(v, 2, 400, 300);
  const after = toWorld(v2, 400, 300);
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9);
  assert.equal(zoomAt(v, 100, 0, 0).z, ZOOM_MAX);
  assert.equal(zoomAt(v, 0.001, 0, 0).z, ZOOM_MIN);
  assert.equal(clampZoom(1.3), 1.3);
});

test('arrow ends sit on the card edge, pointing at the other card', () => {
  const r = { x: 0, y: 0, w: 200, h: 100 };
  assert.deepEqual(edgePoint(r, 500, 50), { x: 200, y: 50 });
  assert.deepEqual(edgePoint(r, 100, -400), { x: 100, y: 0 });
  const g = edgePoint(r, 500, 50, 6);
  assert.equal(g.x, 206);
});

test('fit shows every card at most at 100%', () => {
  const rects = [{ x: -500, y: -200, w: 190, h: 60 }, { x: 1500, y: 900, w: 190, h: 60 }];
  const v = fitView(rects, 1000, 700);
  assert.ok(v.z <= 1 && v.z >= ZOOM_MIN);
  for (const r of rects) {
    const sx = r.x * v.z + v.x;
    const sy = r.y * v.z + v.y;
    assert.ok(sx >= 0 && sx + r.w * v.z <= 1000 && sy >= 0 && sy + r.h * v.z <= 700);
  }
  assert.deepEqual(fitView([], 800, 600), { x: 40, y: 40, z: 1 });
});

import { parseInk, serializeInk, simplify, encodePoints, decodePoints, strokePath, strokeBox, PALETTE } from '../board.js';

test('notes and text keep a known colour and a sensible size; unknown ones are dropped', () => {
  const b = parseBoard(JSON.stringify({ items: [
    { id: 'a', type: 'note', x: 0, y: 0, text: 'x', color: 'pink', size: 20 },
    { id: 'b', type: 'text', x: 0, y: 0, text: 'y', color: 'neon', size: 500 },
    { id: 'c', type: 'task', task: 't', x: 0, y: 0, color: 'pink', size: 20 },
  ] }));
  assert.equal(b.items[0].color, 'pink');
  assert.equal(b.items[0].size, 20);
  assert.equal(b.items[1].color, undefined);
  assert.equal(b.items[1].size, undefined);
  assert.equal(b.items[2].color, undefined);
  const again = parseBoard(serializeBoard(b));
  assert.deepEqual(again.items[0], b.items[0]);
  assert.ok(Object.keys(PALETTE).includes('ink'));
});

test('a stroke is stored as whole-number steps and read back as the same points', () => {
  const pts = [{ x: 10.2, y: 20.7 }, { x: 15, y: 25 }, { x: 15.2, y: 25.1 }, { x: 40, y: 30 }];
  const p = encodePoints(pts);
  assert.deepEqual(p, [10, 21, 5, 4, 25, 5]); // the repeated point is skipped
  assert.deepEqual(decodePoints(p), [{ x: 10, y: 21 }, { x: 15, y: 25 }, { x: 40, y: 30 }]);
  assert.deepEqual(encodePoints([{ x: 3, y: 4 }]), [3, 4, 1, 0]); // a dot becomes a tiny line
});

test('simplify keeps corners and drops points on a straight line', () => {
  const line = Array.from({ length: 50 }, (_, i) => ({ x: i, y: i * 2 }));
  assert.equal(simplify(line, 0.5).length, 2);
  const corner = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 10, y: 10 }];
  assert.deepEqual(simplify(corner, 0.5), [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
});

test('drawings: broken strokes are dropped, the rest round-trips', () => {
  const ink = parseInk(JSON.stringify({ strokes: [
    { id: 's1', c: 'blue', w: 8, p: [0, 0, 5, 5] },
    { id: 's2', c: 'nope', w: 3, p: [1, 2, 3, 4] },
    { id: 's3', p: [1, 2, 3] },
    { id: 's4', p: [1.5, 2, 3, 4] },
    { id: 's1', p: [0, 0, 1, 1] },
  ] }));
  assert.deepEqual(ink.strokes.map((s) => [s.id, s.c, s.w]), [['s1', 'blue', 8], ['s2', 'ink', 4]]);
  assert.deepEqual(parseInk(serializeInk(ink)), ink);
  assert.deepEqual(parseInk('oops'), { v: 1, strokes: [] });
});

test('stroke path and box', () => {
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 5 }, { x: 20, y: 0 }];
  assert.ok(strokePath(pts).startsWith('M0 0Q10 5'));
  assert.deepEqual(strokeBox(pts), { x: 0, y: 0, w: 20, h: 5 });
});
