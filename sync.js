// Sync: read the whole sheet, check it still has the expected layout, then push the outbox.
// Rules:
//  - Last write wins per row, by updated_at. A queued edit older than the sheet's copy is dropped
//    and counted as superseded, so the screen never reverts someone else's newer edit.
//  - An edit identical to the sheet's copy is dropped as a no-op.
//  - All writes go to the sheet script in one request: existing rows are updated in place, new
//    rows are added under the last row with a key. The script's writes are keyed, so a retry
//    after a lost reply never makes duplicates.
//  - Cigarette taps have no updated_at column: a tap is written once, and an undo is an update.
// api: { pull(), write({ updates, appends }) }, see bridge.js.
import { TABS, APP_TABS, toRow, fromRow, checkHeaders, SchemaError, SCHEMA_VERSION, ms } from './schema.js';

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

const rowOr = (r, fallback) => (Number.isInteger(r) && r > 1 ? r : fallback);

export async function execute(store, plan, api) {
  const updates = plan.updates.map((u) => ({ tab: u.op.tab, row: u.row, key: String(u.op.key), values: u.values }));
  const appends = [...plan.appends].map(([tab, items]) => ({ tab, rows: items.map((i) => i.values) }));
  try {
    if (!updates.length && !appends.length) return;
    const res = await api.write({ updates, appends });
    plan.updates.forEach((u, i) => {
      store.applyRemote(u.op.tab, u.op.rec, rowOr(res.updated[i], u.row));
      plan.done.add(u.op.seq);
    });
    for (const [tab, items] of plan.appends) {
      const rows = res.appended[tab] || [];
      items.forEach((it, i) => {
        store.applyRemote(tab, it.op.rec, rowOr(rows[i], undefined));
        plan.done.add(it.op.seq);
      });
    }
  } finally {
    store.dropOps(plan.done);
  }
}

export async function syncOnce(store, { api }) {
  const raw = await api.pull();
  const parsed = parseSnapshot(raw);
  store.setCache(parsed);
  const plan = planWrites(store);
  const pushed = plan.updates.length + [...plan.appends.values()].reduce((n, a) => n + a.length, 0);
  try {
    await execute(store, plan, api);
  } finally {
    store.save();
  }
  return { pushed, superseded: plan.superseded };
}
