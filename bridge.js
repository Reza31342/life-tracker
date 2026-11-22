// The app's link to the Google Sheet: a small script that lives inside the sheet
// (apps-script/Code.gs), reached at its web app URL. Every request carries this device's key.
// The URL and the key are kept on this device only; neither is part of the repo.
// The key travels in the request body over HTTPS, never in the URL.
import { TABS, APP_TABS } from './schema.js';

export class BridgeError extends Error {
  constructor(message, code = 'error', status = 0) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.status = status;
  }
}

const URL_RE = /^https:\/\/script\.google\.com\/(?:a\/macros\/[^/\s]+|macros)\/s\/[A-Za-z0-9_-]{20,}\/exec$/;
export const isBridgeUrl = (u) => URL_RE.test(String(u || '').trim());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Both are safe to repeat: the script's writes are keyed, so a repeat updates the same rows.
const RETRY = new Set(['busy', 'server']);

export function createBridge({ url, key, fetch: fetchImpl = (...a) => globalThis.fetch(...a) }) {
  async function once(body) {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        // text/plain keeps this a simple request: Apps Script can't answer a CORS preflight.
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ ...body, key }),
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'follow',
      });
    } catch {
      throw new BridgeError('No connection to the sheet', 'offline', 0);
    }
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON, handled below */ }
    if (!json || typeof json !== 'object') {
      if (res.status === 404) throw new BridgeError('Script link not found', 'not_found', 404);
      if (res.status === 429 || res.status >= 500) {
        throw new BridgeError(`The sheet script failed (HTTP ${res.status})`, 'server', res.status);
      }
      throw new BridgeError('The link did not answer like the Life Tracker script', 'not_json', res.status);
    }
    if (!json.ok) throw new BridgeError(json.error || 'The sheet script refused the request', json.code || 'error', res.status);
    return json;
  }

  async function post(body) {
    let wait = 800;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await once(body);
      } catch (err) {
        if (err instanceof BridgeError && RETRY.has(err.code) && attempt < 3) {
          await sleep(wait);
          wait *= 2;
          continue;
        }
        throw err;
      }
    }
  }

  return {
    // Confirms the link and key work. Returns the spreadsheet's title.
    async ping() {
      return (await post({ action: 'ping' })).title || '';
    },
    // Every app tab, header row first: { tab: rows }.
    async pull() {
      const widths = Object.fromEntries(APP_TABS.map((t) => [t, TABS[t].cols.length]));
      const tabs = (await post({ action: 'pull', widths })).tabs || {};
      for (const t of APP_TABS) {
        if (!Array.isArray(tabs[t])) throw new BridgeError(`The sheet script sent no "${t}" tab`, 'bad_reply');
      }
      return tabs;
    },
    // updates: [{ tab, row, key, values }], appends: [{ tab, rows }].
    // Returns { updated: [row per update], appended: { tab: [row per appended row] } }.
    async write({ updates = [], appends = [] }) {
      const json = await post({ action: 'write', updates, appends });
      return { updated: json.updated || [], appended: json.appended || {} };
    },
  };
}
