// Device-side data: the last copy read from the sheet (cache), the changes not yet written
// (outbox), and this device's connection settings. The screen shows the cache with the outbox
// applied on top, so edits show at once, offline too.
import { TABS, ms, isDateKey, logicalDay, setZone, PICK_KINDS, PICK_STATUSES, APP_TABS } from './schema.js';

const V2 = 'life-tracker.v2';
const V1 = 'life-tracker.v1';

export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export function emptyData() {
  return {
    v: 2,
    cache: Object.fromEntries(APP_TABS.map((t) => [t, []])),
    pulledAt: '',
    outbox: [],
    seq: 0,
    device: { clientId: '', sheetId: '', lastSyncAt: '', lastError: '' },
    migratedFrom: '',
  };
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Converts the prototype's local data (v1) into records for the outbox. Nothing is lost:
// the v1 key is left in place. Sample picks are dropped, and cigarette days are recomputed
// with the Berlin rollover.
export function fromV1(v1, now = new Date().toISOString()) {
  const ops = [];
  for (const t of v1.tasks || []) {
    if (!t || !t.title) continue;
    const claudeDecides = !!t.claudeDecides;
    ops.push(['tasks', {
      id: t.id || newId(),
      title: String(t.title).slice(0, 300),
      description: String(t.description || ''),
      tags: (t.tags || []).filter((x) => x !== 'claude-decides'),
      importance: claudeDecides ? '' : String(t.importance || ''),
      deadline: isDateKey(t.deadline) ? t.deadline : '',
      status: t.status === 'done' ? 'done' : 'open',
      claudeDecides,
      sourcePick: String(t.sourcePick || ''),
      createdAt: t.createdAt || now,
      updatedAt: t.updatedAt || t.createdAt || now,
      updatedBy: 'app',
      doneAt: t.status === 'done' ? (t.updatedAt || now) : '',
      deletedAt: '',
    }]);
  }
  for (const [date, d] of Object.entries(v1.days || {})) {
    if (!isDateKey(date) || !d) continue;
    const gymType = d.gymType || 'none';
    ops.push(['days', {
      date,
      sleep: String(d.sleep || ''),
      walkingMin: num(d.walkingMin),
      gymType,
      gymMin: gymType === 'none' ? null : num(d.gymMin),
      energy: num(d.energy),
      mood: num(d.mood),
      note: String(d.note || ''),
      updatedAt: d.updatedAt || now,
      updatedBy: 'app',
    }]);
  }
  for (const c of v1.cigs || []) {
    const at = new Date(c && c.at);
    if (!Number.isFinite(at.getTime())) continue;
    ops.push(['cigs', { id: c.id || newId(), at: at.toISOString(), day: logicalDay(at), deletedAt: '' }]);
  }
  for (const p of v1.picks || []) {
    if (!p || !p.title || p.source === 'sample' || String(p.id || '').startsWith('sample-')) continue;
    let status = p.status === 'saved' ? 'useful' : (!p.status || p.status === 'active') ? 'new' : p.status;
    if (!PICK_STATUSES.includes(status)) status = 'new';
    ops.push(['picks', {
      id: p.id || newId(),
      kind: PICK_KINDS.includes(p.kind) ? p.kind : 'paper',
      title: String(p.title),
      source: String(p.source || ''),
      meta: String(p.meta || ''),
      url: String(p.url || ''),
      why: String(p.why || ''),
      rank: num(p.rank),
      week: String(p.week || ''),
      status,
      date: isDateKey(p.date) ? p.date : '',
      deadline: isDateKey(p.deadline) ? p.deadline : '',
      createdAt: p.createdAt || now,
      updatedAt: p.createdAt || now,
      updatedBy: 'app',
    }]);
  }
  return { ops, sheetId: String(v1.settings?.sheetId || '') };
}

// One record per key. If the sheet has duplicate keys (two devices appended the same day),
// the newest updatedAt wins; ties go to the later row.
export function dedupe(rows, key) {
  const map = new Map();
  for (const r of rows) {
    const prev = map.get(r[key]);
    if (!prev || ms(r.updatedAt) >= ms(prev.updatedAt)) map.set(r[key], r);
  }
  return map;
}

export class Store {
  constructor(storage) {
    this.storage = storage;
    this.saveError = '';
    this.data = this.open();
  }

  read(k) {
    try {
      return this.storage.getItem(k);
    } catch {
      return null;
    }
  }

  open() {
    const raw = this.read(V2);
    if (raw !== null) {
      try {
        return { ...emptyData(), ...JSON.parse(raw) };
      } catch {
        // Keep the unreadable copy so nothing is lost, then start clean.
        try { this.storage.setItem(`${V2}.corrupt`, raw); } catch { /* storage full */ }
      }
    }
    const data = emptyData();
    const v1 = this.read(V1);
    if (v1 !== null) {
      try {
        const { ops, sheetId } = fromV1(JSON.parse(v1));
        data.migratedFrom = 'v1';
        data.device.sheetId = sheetId;
        for (const [tab, rec] of ops) {
          data.seq += 1;
          data.outbox.push({ seq: data.seq, tab, key: rec[TABS[tab].key], rec });
        }
      } catch (err) {
        console.warn('Could not migrate the earlier local data', err);
      }
    }
    this.data = data;
    this.save();
    return data;
  }

  save() {
    try {
      this.storage.setItem(V2, JSON.stringify(this.data));
      this.saveError = '';
    } catch (err) {
      this.saveError = 'This device is out of local storage. Export a backup in Settings.';
      console.warn('Could not save data', err);
    }
    return !this.saveError;
  }

  // Queues the full record. A later edit to the same key replaces the queued one, so a fast
  // series of log edits becomes one write.
  enqueue(tab, rec) {
    const key = TABS[tab].key;
    const { _row, ...clean } = rec;
    if (!clean[key]) throw new Error(`Record for ${tab} has no ${key}`);
    this.data.outbox = this.data.outbox.filter((o) => !(o.tab === tab && o.key === clean[key]));
    this.data.seq += 1;
    this.data.outbox.push({ seq: this.data.seq, tab, key: clean[key], rec: clean });
    this.save();
  }

  // What the screen shows: the cache with the outbox applied on top.
  rows(tab) {
    const key = TABS[tab].key;
    const byKey = dedupe(this.data.cache[tab] || [], key);
    for (const op of this.data.outbox) {
      if (op.tab !== tab) continue;
      const prev = byKey.get(op.key);
      byKey.set(op.key, { ...op.rec, _row: prev ? prev._row : undefined });
    }
    return [...byKey.values()];
  }

  remoteMap(tab) {
    return dedupe(this.data.cache[tab] || [], TABS[tab].key);
  }

  setting(key, fallback = '') {
    const r = this.rows('settings').find((s) => s.key === key);
    return r && r.value !== undefined && r.value !== null && r.value !== '' ? String(r.value) : fallback;
  }

  pendingCount() {
    return this.data.outbox.length;
  }

  // Replaces the cache with a fresh read from the sheet and applies the sheet's time settings.
  setCache(parsed) {
    this.data.cache = parsed;
    this.data.pulledAt = new Date().toISOString();
    const map = dedupe(parsed.settings || [], 'key');
    const val = (k) => (map.get(k) || {}).value;
    setZone({ timezone: val('timezone'), rollover: val('day_rollover_hour') });
  }

  // After a successful write, the record is part of the cache, so it stays visible
  // even if the next read fails.
  applyRemote(tab, rec, row) {
    const key = TABS[tab].key;
    const { _row, ...clean } = rec;
    const list = (this.data.cache[tab] || []).filter((r) => r[key] !== clean[key]);
    list.push({ ...clean, _row: row });
    this.data.cache[tab] = list;
  }

  dropOps(seqs) {
    this.data.outbox = this.data.outbox.filter((o) => !seqs.has(o.seq));
  }
}
