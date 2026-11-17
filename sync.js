// Sync: read the whole sheet, check it still has the expected layout, then push the outbox.
// Rules:
//  - Last write wins per row, by updated_at. A queued edit older than the sheet's copy is dropped
//    and counted as superseded, so the screen never reverts someone else's newer edit.
//  - An edit identical to the sheet's copy is dropped as a no-op.
//  - Existing rows are updated in place (one batch). New rows are appended (one request per tab).
//  - Cigarette taps have no updated_at column: a tap is written once, and an undo is an update.
import { TABS, APP_TABS, toRow, fromRow, checkHeaders, SchemaError, SCHEMA_VERSION, ms } from './schema.js';
import { pullAll, writeRows, appendRows, rowRange } from './sheets.js';

const defaultApi = { pullAll, writeRows, appendRows };

export function parseSnapshot(raw) {
  const out = {};
  for (const tab of APP_TABS) {
    const rows = raw[tab] || [];
    if (!rows.length) throw new SchemaError(`The "${tab}" tab is empty or has no header row.`);
    checkHeaders(tab, rows[0]);
    const keyIdx = TABS[tab].cols.findIndex((c) => c[1] === TABS[tab].key);
    out[tab] = [];
    rows.slice(1).forEach((row, i) => {
      if (!row || !String(row[keyIdx] ?? '').trim()) return;
      out[tab].push(fromRow(tab, row, i + 2));
    });
  }
  const sv = out.settings.filter((s) => s.key === 'schema_version').pop();
  if (!sv || Number(sv.value) !== SCHEMA_VERSION) {
    throw new SchemaError(
      `The sheet's schema_version is ${sv ? sv.value : 'missing'}; this app expects ${SCHEMA_VERSION}. Sync stopped.`,
    );
  }
  return out;
}

export function planWrites(store) {
  const plan = { updates: [], appends: new Map(), done: new Set(), superseded: 0 };
  const remote = Object.fromEntries(APP_TABS.map((t) => [t, store.remoteMap(t)]));
  for (const op of store.data.outbox) {
    const existing = remote[op.tab].get(op.key);
    if (existing && ms(existing.updatedAt) > ms(op.rec.updatedAt)) {
      plan.done.add(op.seq);
      plan.superseded += 1;
      continue;
    }
    const values = toRow(op.tab, op.rec);
    if (existing && JSON.stringify(toRow(op.tab, existing)) === JSON.stringify(values)) {
      plan.done.add(op.seq);
      continue;
    }
    if (existing) {
      plan.updates.push({ op, row: existing._row, values });
    } else {
      if (!plan.appends.has(op.tab)) plan.appends.set(op.tab, []);
      plan.appends.get(op.tab).push({ op, values });
    }
  }
  return plan;
}

export async function execute(store, plan, { sheetId, getToken, api = defaultApi }) {
  try {
    if (plan.updates.length) {
      await api.writeRows(
        sheetId,
        getToken,
        plan.updates.map((u) => ({ range: rowRange(u.op.tab, u.row), values: u.values })),
      );
      for (const u of plan.updates) {
        store.applyRemote(u.op.tab, u.op.rec, u.row);
        plan.done.add(u.op.seq);
      }
    }
    for (const [tab, items] of plan.appends) {
      const start = await api.appendRows(sheetId, getToken, tab, items.map((i) => i.values));
      items.forEach((it, i) => {
        store.applyRemote(tab, it.op.rec, start + i);
        plan.done.add(it.op.seq);
      });
    }
  } finally {
    store.dropOps(plan.done);
  }
}

export async function syncOnce(store, { sheetId, getToken, api = defaultApi }) {
  const raw = await api.pullAll(sheetId, getToken);
  const parsed = parseSnapshot(raw);
  store.setCache(parsed);
  const plan = planWrites(store);
  const pushed = plan.updates.length + [...plan.appends.values()].reduce((n, a) => n + a.length, 0);
  try {
    await execute(store, plan, { sheetId, getToken, api });
  } finally {
    store.save();
  }
  return { pushed, superseded: plan.superseded };
}
