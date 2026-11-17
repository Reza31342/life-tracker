import { TABS, APP_TABS, toRow } from '../schema.js';

export class MemStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}

// Builds the { tab: [header, ...rows] } shape that pullAll returns.
export function buildRaw(recs = {}) {
  const settings = recs.settings ?? [
    { key: 'schema_version', value: '1', updatedAt: '2026-11-17T02:25:00Z' },
    { key: 'timezone', value: 'Europe/Berlin', updatedAt: '2026-11-17T02:25:00Z' },
    { key: 'day_rollover_hour', value: '4', updatedAt: '2026-11-17T02:25:00Z' },
  ];
  const raw = {};
  for (const tab of APP_TABS) {
    const header = TABS[tab].cols.map((c) => c[0]);
    const list = tab === 'settings' ? settings : (recs[tab] || []);
    raw[tab] = [header, ...list.map((r) => toRow(tab, r))];
  }
  return raw;
}

// Records every write and assigns append row numbers the way the sheet would.
export function fakeApi(raw) {
  const calls = { pulls: 0, writes: [], appends: [] };
  const api = {
    async pullAll() { calls.pulls += 1; return structuredClone(raw); },
    async writeRows(_id, _tok, data) {
      if (api.failWrites) throw new Error('write failed');
      calls.writes.push(data);
    },
    async appendRows(_id, _tok, tab, rows) {
      if (api.failAppends) throw new Error('append failed');
      const start = raw[tab].length + 1;
      raw[tab].push(...rows);
      calls.appends.push({ tab, rows, start });
      return start;
    },
  };
  return { api, calls, raw };
}
