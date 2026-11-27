// Task whiteboard: an endless canvas with task cards, sticky notes, text and arrows.
//
// The board is saved as one JSON text in the sheet's settings tab (key "board"), so it syncs like
// any other setting and Undo works. What is saved is a description, not a picture:
//   { v: 1, items: [ {id, type: 'task'|'note'|'text', x, y, task?, text?, note?} ], links: [ {id, from, to} ] }
// Task cards point at a task id, so they always show that task's current title, deadline and state.
// Pan and zoom (the "view") are per device and live in the app's prefs, not in the sheet.

export const BOARD_KEY = 'board';
export const BOARD_MAX = 45000; // a sheet cell holds 50,000 characters
export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 2.5;
const TYPES = new Set(['task', 'note', 'text']);

const num = (v, d = 0) => (Number.isFinite(+v) ? Math.round(+v) : d);
const str = (v, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : '');

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
      : { id: it.id, type: it.type, x: num(it.x), y: num(it.y), text: it.text || '' })),
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

/* ---------- canvas (DOM) ---------- */

// Wires up the board page that app.js rendered. ctx:
//   board        the parsed board
//   view         {x, y, z} for this device
//   tasks        Map of task id -> task (live tasks only)
//   save(board, label)   stores the board (returns false if it is too big)
//   saveView(view)       stores pan/zoom for this device
//   openTask(id)         opens the task's edit pop-up
//   renderItem(item)     HTML for one item
//   idle()               called when a drag ends, so a waiting re-render can run
// Returns { busy() } — true while something is being dragged.
let mounted = null;

export function mountBoard(root, ctx) {
  mounted?.abort();
  const ac = new AbortController();
  mounted = ac;
  const on = (el, type, fn, opts = {}) => el.addEventListener(type, fn, { ...opts, signal: ac.signal });

  const vp = root.querySelector('.board');
  const world = root.querySelector('.board-world');
  const svg = root.querySelector('.board-links');
  const zoomLabel = root.querySelector('[data-bzoom-label]');
  let board = ctx.board;
  let view = { ...ctx.view };
  let selected = null; // item id, or 'link:<id>'
  let drag = null; // {kind: 'pan'|'item'|'link'|'chip'|'pinch', ...}
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

  function applyView() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
    world.style.setProperty('--z', view.z);
    const g = 24 * view.z;
    vp.style.backgroundSize = `${g}px ${g}px`;
    vp.style.backgroundPosition = `${view.x}px ${view.y}px`;
    if (zoomLabel) zoomLabel.textContent = `${Math.round(view.z * 100)}%`;
  }
  let viewTimer = 0;
  const keepView = () => { clearTimeout(viewTimer); viewTimer = setTimeout(() => ctx.saveView(view), 300); };

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
    if (temp) {
      parts.push(`<line class="bl-line bl-temp" x1="${temp.x1}" y1="${temp.y1}" x2="${temp.x2}" y2="${temp.y2}" marker-end="url(#bArrow)"/>`);
    }
    svg.querySelector('[data-links]').innerHTML = parts.join('');
    // The × for a selected arrow sits at its middle, in screen size.
    const x = root.querySelector('.bl-del');
    const s = selected?.startsWith('link:') ? board.links.find((l) => `link:${l.id}` === selected) : null;
    const a = s && rectOf(s.from);
    const b = s && rectOf(s.to);
    if (x) {
      if (a && b) {
        x.hidden = false;
        x.style.left = `${(a.x + a.w / 2 + b.x + b.w / 2) / 2}px`;
        x.style.top = `${(a.y + a.h / 2 + b.y + b.h / 2) / 2}px`;
      } else {
        x.hidden = true;
      }
    }
  }

  function select(id) {
    selected = id;
    world.querySelectorAll('.bi.sel').forEach((n) => n.classList.remove('sel'));
    if (id && !id.startsWith('link:')) el(id)?.classList.add('sel');
    drawLinks();
  }

  function commit(next, label) {
    if (ctx.save(next, label) === false) return false;
    board = next;
    return true;
  }

  function placeNode(it) {
    const node = el(it.id);
    if (node) { node.style.left = `${it.x}px`; node.style.top = `${it.y}px`; }
  }

  function addItem(it, label) {
    const next = { ...board, items: [...board.items, it] };
    if (!commit(next, label)) return null;
    world.insertAdjacentHTML('beforeend', ctx.renderItem(it));
    drawLinks();
    return it;
  }

  function centerWorld() {
    return toWorld(view, vp.clientWidth / 2, vp.clientHeight / 2);
  }

  /* editing text (notes, labels, a task card's note) */
  function startEdit(id) {
    const it = byId(id);
    const node = el(id);
    if (!it || !node) return;
    const target = node.querySelector(it.type === 'task' ? '.bi-note' : '.bi-text');
    const value = it.type === 'task' ? it.note || '' : it.text || '';
    const ta = document.createElement('textarea');
    ta.className = 'bi-edit';
    ta.value = value;
    ta.rows = Math.max(2, value.split('\n').length);
    ta.placeholder = it.type === 'task' ? 'Note for this task' : it.type === 'note' ? 'Write a note' : 'Write something';
    if (target) target.replaceWith(ta);
    else node.querySelector('.bi-body')?.append(ta);
    node.classList.add('editing');
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    const grow = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; drawLinks(); };
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
      const changed = serializeBoard(next) !== serializeBoard(board);
      if (changed) commit(next, cur.type === 'task' ? 'Board: task note' : 'Board: edited text');
      const fresh = byId(id);
      if (fresh) node.outerHTML = ctx.renderItem(fresh);
      else node.remove();
      if (fresh && selected === id) el(id)?.classList.add('sel');
      drawLinks();
      ctx.idle();
    };
    ta.addEventListener('blur', () => finish(true));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ta.blur(); }
      e.stopPropagation();
    });
  }

  /* toolbar */
  on(root, 'click', (e) => {
    const b = e.target.closest('[data-btool]');
    if (!b) return;
    const t = b.dataset.btool;
    if (t === 'note' || t === 'text') {
      const c = centerWorld();
      const it = addItem({ id: boardId('n'), type: t, x: c.x - (t === 'note' ? 90 : 60), y: c.y - 30, text: '' }, t === 'note' ? 'Board: added note' : 'Board: added text');
      if (it) { select(it.id); startEdit(it.id); }
    }
    if (t === 'zoom-in' || t === 'zoom-out') {
      view = zoomAt(view, t === 'zoom-in' ? 1.25 : 0.8, vp.clientWidth / 2, vp.clientHeight / 2);
      applyView(); keepView();
    }
    if (t === 'fit') {
      const rects = board.items.map((it) => rectOf(it.id)).filter(Boolean);
      view = fitView(rects, vp.clientWidth, vp.clientHeight);
      applyView(); keepView();
    }
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
  on(root, 'click', (e) => {
    if (e.target.closest('.bl-del')) deleteSelected(selected);
  });

  function deleteSelected(id = selected) {
    if (!id) return;
    if (id.startsWith('link:')) {
      const lid = id.slice(5);
      commit({ ...board, links: board.links.filter((l) => l.id !== lid) }, 'Board: removed arrow');
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
    if (typing || !selected || !root.isConnected) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
    if (e.key === 'Escape') select(null);
  });

  /* pointer: pan, move, connect, pinch */
  on(vp, 'pointerdown', (e) => {
    if (e.button > 0) return;
    if (e.target.closest('textarea,input,button,.bl-del')) return;
    pointers.set(e.pointerId, vpPoint(e));
    if (pointers.size === 2) {
      // Second finger: switch whatever was going on to a pinch.
      const [a, b] = [...pointers.values()];
      drag = { kind: 'pinch', dist: Math.hypot(a.sx - b.sx, a.sy - b.sy), mid: { sx: (a.sx + b.sx) / 2, sy: (a.sy + b.sy) / 2 }, view: { ...view } };
      return;
    }
    const p = vpPoint(e);
    const handle = e.target.closest('.bi-handle');
    const node = e.target.closest('.bi');
    const line = e.target.closest('.bl');
    vp.setPointerCapture(e.pointerId);
    if (handle && node) {
      drag = { kind: 'link', from: node.dataset.id, id: e.pointerId };
    } else if (node) {
      const it = byId(node.dataset.id);
      drag = { kind: 'item', id: it.id, start: p, orig: { x: it.x, y: it.y }, moved: false, pid: e.pointerId };
    } else if (line) {
      drag = null;
      select(`link:${line.dataset.link}`);
    } else {
      drag = { kind: 'pan', start: p, orig: { ...view }, moved: false, pid: e.pointerId };
    }
  });

  on(vp, 'pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const p = vpPoint(e);
    pointers.set(e.pointerId, p);
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
    if (drag.kind === 'pan') {
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
    if (drag.kind === 'pinch') {
      if (pointers.size === 0) { drag = null; keepView(); ctx.idle(); }
      else drag = { kind: 'none' };
      return;
    }
    const d = drag;
    drag = null;
    if (d.kind === 'pan') {
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
        if (lastTap.id === d.id && now - lastTap.t < 450) { lastTap = { id: '', t: 0 }; startEdit(d.id); }
        else lastTap = { id: d.id, t: now };
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
    if (at) placeTask(d.task, at, !d.moved);
    ctx.idle();
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

  applyView();
  drawLinks();
  // Fonts or late layout can change card sizes; redraw arrows once things settle.
  requestAnimationFrame(() => drawLinks());
  document.fonts?.ready.then(() => { if (!ac.signal.aborted) drawLinks(); });

  return { busy: () => !!drag };
}
