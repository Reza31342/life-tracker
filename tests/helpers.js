import { TABS, APP_TABS, toRow, SCHEMA_VERSION } from '../schema.js';
import { createBridge } from '../bridge.js';
import { FakeSheet, loadScript, scriptFetch, TEST_KEY } from './gas.js';

export class MemStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}

// Builds { tab: [header, ...rows] }, the shape a pull returns.
export function buildRaw(recs = {}) {
  const settings = recs.settings ?? [
    { key: 'schema_version', value: String(SCHEMA_VERSION), updatedAt: '2026-11-17T02:25:00Z' },
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

export const BRIDGE_URL = 'https://script.google.com/macros/s/AKfycbTESTdeploymentIdForTests000/exec';

// The real bridge client talking to the real sheet script over fake sheets.
// Set api.failWrites to make write requests fail like a dropped connection.
export function fakeApi(raw, { maxRows = 1000 } = {}) {
  const sheets = Object.fromEntries(Object.entries(raw).map(([tab, rows]) => [tab, new FakeSheet(tab, rows, maxRows)]));
  const script = loadScript({ sheets });
  const calls = { pulls: 0, writes: [] };
  const api = createBridge({
    url: BRIDGE_URL,
    key: TEST_KEY,
    fetch: scriptFetch(script, {
      before: (req) => {
        if (req.action === 'pull') calls.pulls += 1;
        if (req.action === 'write') {
          if (api.failWrites) throw new TypeError('Failed to fetch');
          calls.writes.push({ updates: req.updates, appends: req.appends });
        }
      },
    }),
  });
  return { api, calls, sheets, script };
}
