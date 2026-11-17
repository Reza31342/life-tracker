// Thin client for the Google Sheets REST API. Browser-only: it calls fetch with the user's
// OAuth token. Every request goes through call(), which retries rate limits and server errors
// and refreshes an expired token once.
import { APP_TABS, lastCol } from './schema.js';

const API = 'https://sheets.googleapis.com/v4/spreadsheets';

export class SheetsError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'SheetsError';
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(url, { method = 'GET', body, getToken }) {
  let forceRefresh = false;
  let backoff = 800;
  for (let attempt = 1; ; attempt++) {
    const token = await getToken({ force: forceRefresh });
    forceRefresh = false;
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new SheetsError('No connection to Google', 0);
    }
    if (res.ok) return res.json();
    const payload = await res.json().catch(() => ({}));
    const message = payload?.error?.message || res.statusText || `HTTP ${res.status}`;
    if (res.status === 401 && attempt === 1) {
      forceRefresh = true;
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(backoff);
      backoff *= 2;
      continue;
    }
    throw new SheetsError(message, res.status);
  }
}

// Reads every app tab in one request. Returns { tab: rows }, each row an array, header first.
// UNFORMATTED_VALUE keeps numbers and booleans as typed values.
export async function pullAll(sheetId, getToken) {
  const params = new URLSearchParams({ valueRenderOption: 'UNFORMATTED_VALUE', majorDimension: 'ROWS' });
  for (const tab of APP_TABS) params.append('ranges', `${tab}!A:${lastCol(tab)}`);
  const url = `${API}/${encodeURIComponent(sheetId)}/values:batchGet?${params}`;
  const json = await call(url, { getToken });
  const ranges = json.valueRanges || [];
  if (ranges.length !== APP_TABS.length) {
    throw new SheetsError(`Expected ${APP_TABS.length} tabs from the sheet, got ${ranges.length}`, 0);
  }
  const out = {};
  APP_TABS.forEach((tab, i) => {
    out[tab] = ranges[i].values || [];
  });
  return out;
}

// Overwrites exact rows in one request. data: [{ range: 'tasks!A5:N5', values: [...] }].
export async function writeRows(sheetId, getToken, data) {
  if (!data.length) return;
  const body = {
    valueInputOption: 'RAW',
    data: data.map((d) => ({ range: d.range, values: [d.values] })),
  };
  await call(`${API}/${encodeURIComponent(sheetId)}/values:batchUpdate`, { method: 'POST', body, getToken });
}

// Appends rows to the end of a tab. Returns the sheet row number of the first appended row.
export async function appendRows(sheetId, getToken, tab, rows) {
  const params = new URLSearchParams({ valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' });
  const range = encodeURIComponent(`${tab}!A1`);
  const url = `${API}/${encodeURIComponent(sheetId)}/values/${range}:append?${params}`;
  const res = await call(url, { method: 'POST', body: { values: rows }, getToken });
  const m = /!A(\d+):/.exec(res.updates?.updatedRange || '');
  if (!m) throw new SheetsError(`Could not find where the rows landed in "${tab}"`, 0);
  return Number(m[1]);
}

// Confirms the sheet exists and this account can open it. Returns its title.
export async function sheetTitle(sheetId, getToken) {
  const json = await call(`${API}/${encodeURIComponent(sheetId)}?fields=properties.title`, { getToken });
  return json.properties?.title || '';
}

export function rowRange(tab, row) {
  return `${tab}!A${row}:${lastCol(tab)}${row}`;
}
