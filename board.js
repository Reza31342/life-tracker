// Task whiteboard: an endless canvas with task cards, sticky notes, text, arrows and pen drawings.
//
// Saved as JSON text in the sheet's settings tab, so it syncs like any other setting and Undo works.
// What is saved is a description, not a picture:
//   board:     { v: 1, items: [ {id, type: 'task'|'note'|'text', x, y, task?, note?, text?, color?, size?} ],
//                links: [ {id, from, to} ] }
//   board_ink: { v: 1, strokes: [ {id, c, w, p: [x0, y0, dx1, dy1, ...]} ] }   (pen drawings)
// Task cards point at a task id, so they always show that task's current title, deadline and state.
// Pan, zoom, the list width and the pen settings are per device and live in the app's prefs.

export const BOARD_KEY = 'board';
export const INK_KEY = 'board_ink';
export const BOARD_MAX = 45000; // a sheet cell holds 50,000 characters
export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 2.5;
export const PALETTE = {
  ink: '', yellow: '#d4a017', orange: '#e07a3f', pink: '#d65b7f', blue: '#3d7fc2', green: '#3f9a5c', purple: '#8b5cc4', gray: '#8a8178',
};
export const SIZES = [11, 12, 14, 16, 20, 26, 34];
export const DEFAULTS = { note: { color: 'yellow', size: 12 }, text: { color: 'ink', size: 16 } };
export const PEN_WIDTHS = [2, 4, 8];
const TYPES = new Set(['task', 'note', 'text']);

const num = (v, d = 0) => (Number.isFinite(+v) ? Math.round(+v) : d);
const str = (v, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : '');
const colorOf = (c) => (typeof c === 'string' && Object.hasOwn(PALETTE, c) ? c : undefined);
const sizeOf = (s) => (Number.isFinite(+s) && +s >= 8 && +s <= 60 ? Math.round(+s) : undefined);

export function emptyBoard() {
  return { v: 1, items: [], links: [] };
}

// Reads the saved text. Anything broken or unknown is dropped instead of failing.
export function parseBoard(text) {
  let raw;
  try { raw = JSON.parse(text || ''); } catch { return emptyBoard(); }
  if (!raw || typeof raw !== 'object') return emptyBoard();
  const seen = new Set();
  const items = (Array.isArray(raw.items) ? raw.items : []).flatMap((it) => {
    if (!it || !TYPES.has(it.type) || typeof it.id !== 'string' || !it.id || seen.has(it.id)) return [];
    if (it.type === 'task' && (typeof it.task !== 'string' || !it.task)) return [];
    seen.add(it.id);
    const out = { id: it.id, type: it.type, x: num(it.x), y: num(it.y) };
    if (it.type === 'task') {
      out.task = it.task;
      out.note = str(it.note);
    } else {
      out.text = str(it.text);
      const c = colorOf(it.color);
      const s = sizeOf(it.size);
      if (c) out.color = c;
      if (s) out.size = s;
    }
    return [out];
  });
  const linkSeen = new Set();
  const links = (Array.isArray(raw.links) ? raw.links : []).flatMap((l) => {
    if (!l || typeof l.id !== 'string' || !seen.has(l.from) || !seen.has(l.to) || l.from === l.to) return [];
    const k = `${l.from}>${l.to}`;
    if (linkSeen.has(k)) return [];
    linkSeen.add(k);
    return [{ id: l.id, from: l.from, to: l.to }];
  });
  return { v: 1, items, links };
}

export function serializeBoard(b) {
  return JSON.stringify({
    v: 1,
    items: b.items.map((it) => (it.type === 'task'
      ? { id: it.id, type: 'task', task: it.task, x: num(it.x), y: num(it.y), ...(it.note ? { note: it.note } : {}) }
      : {
        id: it.id, type: it.type, x: num(it.x), y: num(it.y), text: it.text || '',
        ...(colorOf(it.color) ? { color: it.color } : {}), ...(sizeOf(it.size) ? { size: sizeOf(it.size) } : {}),
      })),
    links: b.links.map((l) => ({ id: l.id, from: l.from, to: l.to })),
  });
}

export const boardId = (prefix) => `${prefix}${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 6)}`;

export function removeItem(b, id) {
  return { ...b, items: b.items.filter((it) => it.id !== id), links: b.links.filter((l) => l.from !== id && l.to !== id) };
}

export function addLink(b, from, to) {
  if (!from || !to || from === to) return b;
  if (b.links.some((l) => (l.from === from && l.to === to))) return b;
  return { ...b, links: [...b.links, { id: boardId('l'), from, to }] };
}

/* ---------- pen drawings (pure) ---------- */

export function emptyInk() {
  return { v: 1, strokes: [] };
}

export function parseInk(text) {
  let raw;
  try { raw = JSON.parse(text || ''); } catch { return emptyInk(); }
  if (!raw || !Array.isArray(raw.strokes)) return emptyInk();
  const seen = new Set();
  const strokes = raw.strokes.flatMap((s) => {
    if (!s || typeof s.id !== 'string' || seen.has(s.id) || !Array.isArray(s.p) || s.p.length < 2 || s.p.length % 2) return [];
    if (!s.p.every((n) => Number.isInteger(n))) return [];
    seen.add(s.id);
    return [{ id: s.id, c: colorOf(s.c) ?? 'ink', w: PEN_WIDTHS.includes(s.w) ? s.w : 4, p: s.p }];
  });
  return { v: 1, strokes };
}

export const serializeInk = (ink) => JSON.stringify({ v: 1, strokes: ink.strokes.map((s) => ({ id: s.id, c: s.c, w: s.w, p: s.p })) });

// Ramer–Douglas–Peucker: drops points that lie within `eps` of the line through their neighbours.
export function simplify(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const dist = (p, a, b) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (!len) return Math.hypot(p.x - a.x, p.y - a.y);
    return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
  };
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let best = -1;
    let at = 0;
    for (let k = i + 1; k < j; k++) {
      const d = dist(pts[k], pts[i], pts[j]);
      if (d > best) { best = d; at = k; }
    }
    if (best > eps) {
      keep[at] = 1;
      stack.push([i, at], [at, j]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}

// Whole numbers: the first point as is, then each step from the one before (short to store).
export function encodePoints(pts) {
  const out = [];
  let px = 0;
  let py = 0;
  pts.forEach((p, i) => {
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    if (i && x === px && y === py) return;
    out.push(i ? x - px : x, i ? y - py : y);
    px = x;
    py = y;
  });
  if (out.length === 2) out.push(1, 0); // a dot still needs a tiny line to show
  return out;
}

export function decodePoints(p) {
  const pts = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i + 1 < p.length; i += 2) {
    x = i ? x + p[i] : p[i];
    y = i ? y + p[i + 1] : p[i + 1];
    pts.push({ x, y });
  }
  return pts;
}

// A smooth path through the points (curves through the midpoints).
export function strokePath(pts) {
  if (!pts.length) return '';
  if (pts.length < 3) return `M${pts[0].x} ${pts[0].y}${pts.slice(1).map((p) => `L${p.x} ${p.y}`).join('')}`;
  let d = `M${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    d += `Q${pts[i].x} ${pts[i].y} ${mx} ${my}`;
  }
  const last = pts[pts.length - 1];
  return `${d}L${last.x} ${last.y}`;
}

export function strokeBox(pts) {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

/* ---------- view math (pure) ---------- */

export const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

export function toWorld(view, sx, sy) {
  return { x: (sx - view.x) / view.z, y: (sy - view.y) / view.z };
}

// Zoom by `factor`, keeping the point (sx, sy) on screen where it is.
export function zoomAt(view, factor, sx, sy) {
  const z = clampZoom(view.z * factor);
  const k = z / view.z;
  return { x: sx - (sx - view.x) * k, y: sy - (sy - view.y) * k, z };
}

// The point where the line from the centre of `r` toward (tx, ty) leaves the rectangle, pushed
// out by `gap` so an arrowhead doesn't sit on the border.
export function edgePoint(r, tx, ty, gap = 0) {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const t = Math.min(dx ? (r.w / 2) / Math.abs(dx) : Infinity, dy ? (r.h / 2) / Math.abs(dy) : Infinity);
  const len = Math.hypot(dx, dy);
  return { x: cx + dx * t + (dx / len) * gap, y: cy + dy * t + (dy / len) * gap };
}

// A view that shows every rectangle, with some margin, at most at 100%.
export function fitView(rects, w, h, pad = 60) {
  if (!rects.length) return { x: 40, y: 40, z: 1 };
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  const z = clampZoom(Math.min(1, (w - pad * 2) / Math.max(1, x1 - x0), (h - pad * 2) / Math.max(1, y1 - y0)));
  return { x: (w - (x1 - x0) * z) / 2 - x0 * z, y: (h - (y1 - y0) * z) / 2 - y0 * z, z };
}

export function inkHtml(s) {
  const d = strokePath(decodePoints(s.p));
  const col = PALETTE[s.c] ? ` style="--c:${PALETTE[s.c]}"` : '';
  return `<g class="ink" data-ink="${s.id}"${col}><path class="ink-hit" d="${d}" stroke-width="${s.w + 14}"/><path class="ink-v" d="${d}" stroke-width="${s.w}"/></g>`;
}

/* ---------- canvas (DOM) ---------- */

// Wires up the board page that app.js rendered. ctx:
//   board, ink            the parsed board and drawings
//   view                  {x, y, z} for this device
//   pen                   {c, w} pen colour and width for this device
//   side                  {w, h} list size for this device, or null
//   save(board, label) / saveInk(ink, label)   store them (return false if too big)
//   saveView(view) / savePen(pen) / saveSide(size|null)   per-device settings
//   openTask(id)          opens the task's edit pop-up
//   renderItem(item)      HTML for one item
//   markPlaced(set)       dims list entries whose task is on the board
//   idle()                called when a drag ends, so a waiting re-render can run
// Returns { busy() } — true while something is being dragged or drawn.
let mounted = null;
let toolMemo = 'select'; // the pen stays on through Undo and background syncs, which redraw the page

export function mountBoard(root, ctx) {
  mounted?.abort();
  const ac = new AbortController();
  mounted = ac;
  const on = (el, type, fn, opts = {}) => el.addEventListener(type, fn, { ...opts, signal: ac.signal });

  const wrap = root.querySelector('.board-wrap');
  const vp = root.querySelector('.board');
  const world = root.querySelector('.board-world');
  const svg = root.querySelector('.board-links');
  const inkLayer = root.querySelector('[data-inks]');
  const liveInk = root.querySelector('.ink-live');
  const delBtn = root.querySelector('.bl-del');
  const stylePanel = root.querySelector('.b-style');
  const penPanel = root.querySelector('.pen-panel');
  const zoomLabel = root.querySelector('[data-bzoom-label]');
  let board = ctx.board;
  let ink = ctx.ink;
  let view = { ...ctx.view };
  let pen = { c: 'ink', w: 4, ...ctx.pen };
  let tool = 'select'; // 'select' | 'pen' | 'eraser'
  let selected = null; // item id, 'link:<id>' or 'ink:<id>'
  let drag = null;
  const pointers = new Map();
  let lastTap = { id: '', t: 0 }; // double tap (or double click) on an item edits its text

  const byId = (id) => board.items.find((it) => it.id === id);
  const el = (id) => world.querySelector(`.bi[data-id="${CSS.escape(id)}"]`);
  const rectOf = (id) => {
    const it = byId(id);
    const node = el(id);
    if (!it || !node) return null;
    return { x: it.x, y: it.y, w: node.offsetWidth, h: node.offsetHeight };
  };
  const vpPoint = (e) => {
    const r = vp.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  };
  const worldPoint = (e) => { const p = vpPoint(e); return toWorld(view, p.sx, p.sy); };

  function applyView() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
    world.style.setProperty('--z', view.z);
    const g = 24 * view.z;
    vp.style.backgroundSize = `${g}px ${g}px`;
    vp.style.backgroundPosition = `${view.x}px ${view.y}px`;
    if (zoomLabel) zoomLabel.textContent = `${Math.round(view.z * 100)}%`;
    placeStyle();
  }
  const keepView = () => ctx.saveView(view);

  /* arrows, and the × for a selected arrow or drawing */
  function drawLinks(temp) {
    const parts = [];
    for (const l of board.links) {
      const a = rectOf(l.from);
      const b = rectOf(l.to);
      if (!a || !b) continue;
      const p1 = edgePoint(a, b.x + b.w / 2, b.y + b.h / 2, 2);
      const p2 = edgePoint(b, a.x + a.w / 2, a.y + a.h / 2, 6);
      const sel = selected === `link:${l.id}`;
      parts.push(`<g class="bl${sel ? ' sel' : ''}" data-link="${l.id}">
        <line class="bl-hit" x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}"/>
        <line class="bl-line" x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" marker-end="url(#bArrow${sel ? 'Sel' : ''})"/>
      </g>`);
    }
    if (temp) parts.push(`<line class="bl-line bl-temp" x1="${temp.x1}" y1="${temp.y1}" x2="${temp.x2}" y2="${temp.y2}" marker-end="url(#bArrow)"/>`);
    svg.querySelector('[data-links]').innerHTML = parts.join('');
    placeDel();
  }

  function placeDel() {
    if (!delBtn) return;
    let at = null;
    if (selected?.startsWith('link:')) {
      const s = board.links.find((l) => `link:${l.id}` === selected);
      const a = s && rectOf(s.from);
      const b = s && rectOf(s.to);
      if (a && b) at = { x: (a.x + a.w / 2 + b.x + b.w / 2) / 2, y: (a.y + a.h / 2 + b.y + b.h / 2) / 2 };
    } else if (selected?.startsWith('ink:')) {
      const s = ink.strokes.find((k) => `ink:${k.id}` === selected);
      if (s) { const bx = strokeBox(decodePoints(s.p)); at = { x: bx.x + bx.w + 10, y: bx.y - 10 }; }
    }
    delBtn.hidden = !at;
    delBtn.setAttribute('aria-label', selected?.startsWith('ink:') ? 'Delete drawing' : 'Delete arrow');
    if (at) { delBtn.style.left = `${at.x}px`; delBtn.style.top = `${at.y}px`; }
  }

  function drawInk() {
    inkLayer.innerHTML = ink.strokes.map(inkHtml).join('');
    if (selected?.startsWith('ink:')) inkLayer.querySelector(`[data-ink="${CSS.escape(selected.slice(4))}"]`)?.classList.add('sel');
  }

  function select(id) {
    selected = id;
    world.querySelectorAll('.bi.sel, .ink.sel').forEach((n) => n.classList.remove('sel'));
    if (id?.startsWith('ink:')) inkLayer.querySelector(`[data-ink="${CSS.escape(id.slice(4))}"]`)?.classList.add('sel');
    else if (id && !id.startsWith('link:')) el(id)?.classList.add('sel');
    drawLinks();
    showStyle();
  }

  function commit(next, label) {
    if (ctx.save(next, label) === false) return false;
    board = next;
    return true;
  }
  function commitInk(next, label) {
    if (ctx.saveInk(next, label) === false) return false;
    ink = next;
    return true;
  }

  function placeNode(it) {
    const node = el(it.id);
    if (node) { node.style.left = `${it.x}px`; node.style.top = `${it.y}px`; }
  }

  function addItem(it, label) {
    if (!commit({ ...board, items: [...board.items, it] }, label)) return null;
    world.querySelector('.board-ink').insertAdjacentHTML('beforebegin', ctx.renderItem(it));
    drawLinks();
    return it;
  }

  const centerWorld = () => toWorld(view, vp.clientWidth / 2, vp.clientHeight / 2);

  /* style panel: colour and size of the selected note or text */
  function showStyle() {
    const it = selected && byId(selected);
    if (!stylePanel) return;
    if (!it || it.type === 'task' || tool !== 'select') { stylePanel.hidden = true; return; }
    const d = DEFAULTS[it.type];
    const c = it.color || d.color;
    const s = it.size || d.size;
    stylePanel.querySelectorAll('[data-style-color]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.styleColor === c)));
    stylePanel.querySelectorAll('[data-style-size]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.styleSize === s)));
    stylePanel.hidden = false;
    placeStyle();
  }
  function placeStyle() {
    if (!stylePanel || stylePanel.hidden || !selected) return;
    const node = el(selected);
    if (!node) { stylePanel.hidden = true; return; }
    const r = node.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    const ph = stylePanel.offsetHeight;
    const pw = stylePanel.offsetWidth;
    let top = r.bottom - w.top + 10;
    if (top + ph > w.height - 6) top = Math.max(6, r.top - w.top - ph - 44);
    const left = Math.min(Math.max(6, r.left - w.left), w.width - pw - 6);
    stylePanel.style.left = `${left}px`;
    stylePanel.style.top = `${top}px`;
  }
  function setStyle(patch) {
    const it = selected && byId(selected);
    if (!it || it.type === 'task') return;
    const next = { ...board, items: board.items.map((x) => (x.id === it.id ? { ...x, ...patch } : x)) };
    if (!commit(next, 'Board: style')) return;
    const fresh = byId(it.id);
    const node = el(it.id);
    const d = DEFAULTS[fresh.type];
    if (node) {
      node.style.setProperty('--c', PALETTE[fresh.color || d.color] || '');
      node.style.setProperty('--fs', `${fresh.size || d.size}px`);
      node.classList.toggle('plain', (fresh.color || d.color) === 'ink');
    }
    showStyle();
    drawLinks();
  }
  if (stylePanel) {
    on(stylePanel, 'pointerdown', (e) => e.preventDefault()); // keeps the text box focused while styling
    on(stylePanel, 'click', (e) => {
      const c = e.target.closest('[data-style-color]');
      const s = e.target.closest('[data-style-size]');
      if (c) setStyle({ color: c.dataset.styleColor });
      if (s) setStyle({ size: +s.dataset.styleSize });
    });
  }

  /* editing text (notes, labels, a task card's note) */
  function startEdit(id) {
    const it = byId(id);
    const node = el(id);
    if (!it || !node || node.classList.contains('editing')) return;
    const target = node.querySelector(it.type === 'task' ? '.bi-note' : '.bi-text');
    const value = it.type === 'task' ? it.note || '' : it.text || '';
    const ta = document.createElement('textarea');
    ta.className = 'bi-edit';
    ta.value = value;
    ta.rows = Math.max(1, value.split('\n').length);
    ta.placeholder = it.type === 'task' ? 'Note for this task' : it.type === 'note' ? 'Write a note' : 'Write something';
    if (target) target.replaceWith(ta);
    else node.querySelector('.bi-body')?.append(ta);
    node.classList.add('editing');
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    const grow = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; drawLinks(); placeStyle(); };
    grow();
    ta.addEventListener('input', grow);
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      const text = keep ? ta.value.replace(/\s+$/, '') : value;
      const cur = byId(id);
      if (!cur) return;
      let next;
      if (cur.type !== 'task' && !text.trim()) next = removeItem(board, id); // an empty note goes away
      else next = { ...board, items: board.items.map((x) => (x.id === id ? (x.type === 'task' ? { ...x, note: text } : { ...x, text }) : x)) };
      if (serializeBoard(next) !== serializeBoard(board)) commit(next, cur.type === 'task' ? 'Board: task note' : 'Board: edited text');
      const fresh = byId(id);
      if (fresh) node.outerHTML = ctx.renderItem(fresh);
      else node.remove();
      if (!fresh && selected === id) selected = null;
      select(selected);
      ctx.idle();
    };
    ta.addEventListener('blur', () => finish(true));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ta.blur(); }
      e.stopPropagation();
    });
  }

  /* tools */
  function setTool(t) {
    tool = t;
    toolMemo = t;
    vp.classList.toggle('pen-on', t === 'pen');
    vp.classList.toggle('erasing', t === 'eraser');
    root.querySelector('[data-btool=pen]')?.setAttribute('aria-pressed', String(t !== 'select'));
    root.querySelector('[data-btool=eraser]')?.setAttribute('aria-pressed', String(t === 'eraser'));
    if (penPanel) penPanel.hidden = t === 'select';
    if (t !== 'select') select(null);
    else showStyle();
  }
  function paintPen() {
    penPanel?.querySelectorAll('[data-pen-color]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.penColor === pen.c && tool === 'pen')));
    penPanel?.querySelectorAll('[data-pen-w]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.penW === pen.w)));
  }

  on(root, 'click', (e) => {
    const b = e.target.closest('[data-btool]');
    if (b) {
      const t = b.dataset.btool;
      if (t === 'note' || t === 'text') {
        setTool('select');
        const c = centerWorld();
        const d = DEFAULTS[t];
        const it = addItem({ id: boardId('n'), type: t, x: c.x - (t === 'note' ? 70 : 50), y: c.y - 20, text: '', color: d.color, size: d.size }, t === 'note' ? 'Board: added note' : 'Board: added text');
        if (it) { select(it.id); startEdit(it.id); }
      }
      if (t === 'pen') setTool(tool === 'select' ? 'pen' : 'select');
      if (t === 'eraser') setTool(tool === 'eraser' ? 'pen' : 'eraser');
      if (t === 'select') setTool('select');
      if (t === 'zoom-in' || t === 'zoom-out') {
        view = zoomAt(view, t === 'zoom-in' ? 1.25 : 0.8, vp.clientWidth / 2, vp.clientHeight / 2);
        applyView(); keepView();
      }
      if (t === 'fit') {
        const rects = board.items.map((it) => rectOf(it.id)).filter(Boolean);
        for (const s of ink.strokes) rects.push(strokeBox(decodePoints(s.p)));
        view = fitView(rects, vp.clientWidth, vp.clientHeight);
        applyView(); keepView();
      }
      paintPen();
      return;
    }
    const pc = e.target.closest('[data-pen-color]');
    const pw = e.target.closest('[data-pen-w]');
    if (pc || pw) {
      if (pc) pen = { ...pen, c: pc.dataset.penColor };
      if (pw) pen = { ...pen, w: +pw.dataset.penW };
      if (tool === 'eraser') setTool('pen');
      ctx.savePen(pen);
      paintPen();
      return;
    }
    if (e.target.closest('.bl-del')) deleteSelected(selected);
  });

  /* item buttons (shown on the selected item) */
  on(world, 'click', (e) => {
    const b = e.target.closest('[data-bact]');
    if (!b) return;
    const id = b.closest('.bi')?.dataset.id;
    const a = b.dataset.bact;
    if (a === 'edit') startEdit(id);
    if (a === 'open') { const it = byId(id); if (it?.task) ctx.openTask(it.task); }
    if (a === 'delete') deleteSelected(id);
  });

  function deleteSelected(id = selected) {
    if (!id) return;
    if (id.startsWith('link:')) {
      const lid = id.slice(5);
      commit({ ...board, links: board.links.filter((l) => l.id !== lid) }, 'Board: removed arrow');
      select(null);
      return;
    }
    if (id.startsWith('ink:')) {
      const sid = id.slice(4);
      if (commitInk({ ...ink, strokes: ink.strokes.filter((s) => s.id !== sid) }, 'Board: erased')) drawInk();
      select(null);
      return;
    }
    const it = byId(id);
    if (!it) return;
    if (commit(removeItem(board, id), it.type === 'task' ? 'Board: removed card' : 'Board: removed note')) {
      el(id)?.remove();
      select(null);
      ctx.markPlaced?.(new Set(board.items.filter((x) => x.type === 'task').map((x) => x.task)));
    }
  }

  on(document, 'keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (typing || !root.isConnected) return;
    if (e.key === 'Escape' && tool !== 'select') { setTool('select'); paintPen(); return; }
    if (!selected) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
    if (e.key === 'Escape') select(null);
  });

  /* drawing */
  function inkLive(pts) {
    liveInk.setAttribute('d', strokePath(pts));
    liveInk.setAttribute('stroke-width', pen.w);
    liveInk.style.setProperty('--c', PALETTE[pen.c] || '');
  }
  function finishStroke(pts) {
    liveInk.setAttribute('d', '');
    if (!pts.length) return;
    const p = encodePoints(simplify(pts, 0.8 / view.z));
    const next = { ...ink, strokes: [...ink.strokes, { id: boardId('s'), c: pen.c, w: pen.w, p }] };
    if (commitInk(next, 'Board: drew')) drawInk();
  }
  function eraseAt(e) {
    const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-ink]');
    if (hit && !drag.erased.has(hit.dataset.ink)) { drag.erased.add(hit.dataset.ink); hit.style.display = 'none'; }
  }

  /* pointer: pan, move, connect, pinch, draw */
  on(vp, 'pointerdown', (e) => {
    if (e.button > 0) return;
    if (e.target.closest('textarea,input,button')) return;
    // With a stylus drawing, touches (a resting palm) are ignored.
    if (tool !== 'select' && e.pointerType === 'touch' && [...pointers.values()].some((p) => p.type === 'pen')) return;
    pointers.set(e.pointerId, { ...vpPoint(e), type: e.pointerType });
    if (pointers.size === 2) {
      if (drag?.kind === 'draw') liveInk.setAttribute('d', '');
      if (drag?.kind === 'erase') drag.erased.forEach((id) => { const n = inkLayer.querySelector(`[data-ink="${CSS.escape(id)}"]`); if (n) n.style.display = ''; });
      const [a, b] = [...pointers.values()];
      drag = { kind: 'pinch', dist: Math.hypot(a.sx - b.sx, a.sy - b.sy), mid: { sx: (a.sx + b.sx) / 2, sy: (a.sy + b.sy) / 2 }, view: { ...view } };
      return;
    }
    const p = vpPoint(e);
    vp.setPointerCapture(e.pointerId);
    if (tool === 'pen') { drag = { kind: 'draw', pts: [worldPoint(e)] }; inkLive(drag.pts); return; }
    if (tool === 'eraser') { drag = { kind: 'erase', erased: new Set() }; eraseAt(e); return; }
    const handle = e.target.closest('.bi-handle');
    const node = e.target.closest('.bi');
    const line = e.target.closest('.bl');
    const stroke = e.target.closest('[data-ink]');
    if (handle && node) {
      drag = { kind: 'link', from: node.dataset.id };
    } else if (stroke) {
      drag = null;
      select(`ink:${stroke.dataset.ink}`);
    } else if (node) {
      const it = byId(node.dataset.id);
      drag = { kind: 'item', id: it.id, start: p, orig: { x: it.x, y: it.y }, moved: false };
    } else if (line) {
      drag = null;
      select(`link:${line.dataset.link}`);
    } else {
      drag = { kind: 'pan', start: p, orig: { ...view }, moved: false };
    }
  });

  on(vp, 'pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const p = vpPoint(e);
    pointers.set(e.pointerId, { ...p, type: e.pointerType });
    if (!drag) return;
    if (drag.kind === 'pinch' && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.sx - b.sx, a.sy - b.sy);
      const mid = { sx: (a.sx + b.sx) / 2, sy: (a.sy + b.sy) / 2 };
      const base = { ...drag.view, x: drag.view.x + (mid.sx - drag.mid.sx), y: drag.view.y + (mid.sy - drag.mid.sy) };
      view = zoomAt(base, dist / Math.max(1, drag.dist), mid.sx, mid.sy);
      applyView();
      return;
    }
    if (drag.kind === 'draw') {
      const w = worldPoint(e);
      const last = drag.pts[drag.pts.length - 1];
      if (Math.hypot(w.x - last.x, w.y - last.y) * view.z >= 1.5) { drag.pts.push(w); inkLive(drag.pts); }
    } else if (drag.kind === 'erase') {
      eraseAt(e);
    } else if (drag.kind === 'pan') {
      const dx = p.sx - drag.start.sx;
      const dy = p.sy - drag.start.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      view = { ...drag.orig, x: drag.orig.x + dx, y: drag.orig.y + dy };
      applyView();
    } else if (drag.kind === 'item') {
      const dx = (p.sx - drag.start.sx) / view.z;
      const dy = (p.sy - drag.start.sy) / view.z;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3 / view.z) return;
      drag.moved = true;
      const it = byId(drag.id);
      it.x = drag.orig.x + dx;
      it.y = drag.orig.y + dy;
      placeNode(it);
      drawLinks();
      placeStyle();
    } else if (drag.kind === 'link') {
      const a = rectOf(drag.from);
      const w = toWorld(view, p.sx, p.sy);
      const s = edgePoint(a, w.x, w.y, 2);
      drawLinks({ x1: s.x, y1: s.y, x2: w.x, y2: w.y });
      world.querySelectorAll('.bi.drop').forEach((n) => n.classList.remove('drop'));
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.bi');
      if (over && over.dataset.id !== drag.from) over.classList.add('drop');
    }
  });

  const endPointer = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (!drag) return;
    if (drag.kind === 'pinch' || drag.kind === 'none') {
      if (pointers.size === 0) { drag = null; keepView(); ctx.idle(); } else drag = { kind: 'none' };
      return;
    }
    const d = drag;
    drag = null;
    const cancelled = e.type === 'pointercancel';
    if (d.kind === 'draw') {
      if (cancelled) liveInk.setAttribute('d', '');
      else finishStroke(d.pts);
    } else if (d.kind === 'erase') {
      if (d.erased.size && !cancelled) {
        if (commitInk({ ...ink, strokes: ink.strokes.filter((s) => !d.erased.has(s.id)) }, 'Board: erased')) drawInk();
      } else drawInk();
    } else if (d.kind === 'pan') {
      if (d.moved) keepView();
      else select(null);
    } else if (d.kind === 'item') {
      if (d.moved) {
        const it = byId(d.id);
        const moved = { x: it.x, y: it.y };
        it.x = d.orig.x; it.y = d.orig.y; // commit from the old state so Undo has it
        const next = { ...board, items: board.items.map((x) => (x.id === d.id ? { ...x, ...moved } : x)) };
        if (!commit(next, 'Board: moved')) { placeNode(it); drawLinks(); }
      }
      select(d.id);
      if (!d.moved) {
        const now = Date.now();
        if (lastTap.id === d.id && now - lastTap.t < 450) { lastTap = { id: '', t: 0 }; startEdit(d.id); } else lastTap = { id: d.id, t: now };
      }
    } else if (d.kind === 'link') {
      world.querySelectorAll('.bi.drop').forEach((n) => n.classList.remove('drop'));
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.bi');
      if (over && over.dataset.id !== d.from) {
        const next = addLink(board, d.from, over.dataset.id);
        if (next !== board) commit(next, 'Board: added arrow');
      }
      drawLinks();
    }
    ctx.idle();
  };
  on(vp, 'pointerup', endPointer);
  on(vp, 'pointercancel', endPointer);

  // Wheel or two-finger scroll pans; pinch on a trackpad (or Ctrl + wheel) zooms.
  on(vp, 'wheel', (e) => {
    e.preventDefault();
    const p = vpPoint(e);
    if (e.ctrlKey || e.metaKey) {
      view = zoomAt(view, Math.exp(-e.deltaY * 0.01), p.sx, p.sy);
    } else {
      const k = e.deltaMode === 1 ? 16 : 1;
      view = { ...view, x: view.x - e.deltaX * k, y: view.y - e.deltaY * k };
    }
    applyView();
    keepView();
  }, { passive: false });

  /* side list: drag a task onto the board, or tap it */
  on(root, 'pointerdown', (e) => {
    const chip = e.target.closest('.bs-chip');
    if (!chip || e.button > 0) return;
    drag = { kind: 'chip', task: chip.dataset.task, start: { x: e.clientX, y: e.clientY }, moved: false, chip, pid: e.pointerId };
  });
  on(document, 'pointermove', (e) => {
    if (!drag || drag.kind !== 'chip' || e.pointerId !== drag.pid) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.start.x, e.clientY - drag.start.y) < 6) return;
    if (!drag.moved) {
      drag.moved = true;
      drag.ghost = Object.assign(document.createElement('div'), { className: 'bs-ghost', textContent: drag.chip.querySelector('.bs-t')?.textContent || '' });
      document.body.append(drag.ghost);
      try { drag.chip.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    }
    drag.ghost.style.left = `${e.clientX + 8}px`;
    drag.ghost.style.top = `${e.clientY + 8}px`;
  });
  const endChip = (e) => {
    if (!drag || drag.kind !== 'chip' || e.pointerId !== drag.pid) return;
    const d = drag;
    drag = null;
    d.ghost?.remove();
    if (e.type === 'pointercancel') return ctx.idle();
    const r = vp.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    let at = null;
    if (d.moved && inside) {
      const w = toWorld(view, e.clientX - r.left, e.clientY - r.top);
      at = { x: w.x - 20, y: w.y - 14 };
    } else if (!d.moved) {
      const c = centerWorld();
      at = { x: c.x - 95, y: c.y - 30 };
    }
    if (at) { setTool('select'); paintPen(); placeTask(d.task, at, !d.moved); }
    return ctx.idle();
  };
  on(document, 'pointerup', endChip);
  on(document, 'pointercancel', endChip);

  function placeTask(taskId, at, tapped) {
    const existing = board.items.find((it) => it.type === 'task' && it.task === taskId);
    if (existing) {
      if (tapped) {
        // Already on the board: bring it into view instead of adding a second card.
        const r = rectOf(existing.id);
        if (r) view = { ...view, x: vp.clientWidth / 2 - (r.x + r.w / 2) * view.z, y: vp.clientHeight / 2 - (r.y + r.h / 2) * view.z };
        applyView(); keepView();
      } else {
        const next = { ...board, items: board.items.map((x) => (x.id === existing.id ? { ...x, x: at.x, y: at.y } : x)) };
        if (commit(next, 'Board: moved')) placeNode(byId(existing.id));
        drawLinks();
      }
      select(existing.id);
      return;
    }
    const it = addItem({ id: boardId('c'), type: 'task', task: taskId, x: at.x, y: at.y, note: '' }, 'Board: added card');
    if (it) {
      select(it.id);
      ctx.markPlaced?.(new Set(board.items.filter((x) => x.type === 'task').map((x) => x.task)));
    }
  }

  /* the divider between the list and the board */
  const split = root.querySelector('.bs-split');
  const side = root.querySelector('.bs');
  const stacked = () => window.matchMedia('(max-width: 900px)').matches;
  let size = ctx.side || null;
  const setSize = (v) => {
    if (stacked()) {
      const h = Math.round(Math.min(Math.max(v, 70), root.clientHeight * 0.75));
      root.style.setProperty('--side-h', `${h}px`);
      size = { ...size, h };
    } else {
      const w = Math.round(Math.min(Math.max(v, 150), Math.min(640, root.clientWidth * 0.6)));
      root.style.setProperty('--side-w', `${w}px`);
      size = { ...size, w };
    }
  };
  if (split && side) {
    on(split, 'pointerdown', (e) => {
      if (!side.open) return;
      e.preventDefault();
      split.setPointerCapture(e.pointerId);
      split.classList.add('dragging');
      const r = side.getBoundingClientRect();
      drag = { kind: 'split', x: e.clientX, y: e.clientY, w: r.width, h: r.height, pid: e.pointerId };
    });
    on(split, 'pointermove', (e) => {
      if (drag?.kind !== 'split' || e.pointerId !== drag.pid) return;
      setSize(stacked() ? drag.h + (e.clientY - drag.y) : drag.w + (e.clientX - drag.x));
      placeStyle();
    });
    const endSplit = (e) => {
      if (drag?.kind !== 'split' || e.pointerId !== drag.pid) return;
      drag = null;
      split.classList.remove('dragging');
      ctx.saveSide(size);
      ctx.idle();
    };
    on(split, 'pointerup', endSplit);
    on(split, 'pointercancel', endSplit);
    on(split, 'dblclick', () => {
      root.style.removeProperty('--side-w');
      root.style.removeProperty('--side-h');
      size = null;
      ctx.saveSide(null);
    });
    on(split, 'keydown', (e) => {
      const step = { ArrowLeft: -16, ArrowRight: 16, ArrowUp: -16, ArrowDown: 16 }[e.key];
      if (!step || !side.open) return;
      e.preventDefault();
      const r = side.getBoundingClientRect();
      setSize((stacked() ? r.height : r.width) + step);
      ctx.saveSide(size);
    });
  }

  applyView();
  drawInk();
  drawLinks();
  if (toolMemo !== 'select') setTool(toolMemo);
  paintPen();
  // Fonts or late layout can change card sizes; redraw arrows once things settle.
  requestAnimationFrame(() => drawLinks());
  document.fonts?.ready.then(() => { if (!ac.signal.aborted) drawLinks(); });

  return { busy: () => !!drag };
}
