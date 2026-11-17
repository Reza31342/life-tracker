// Google sign-in for the browser (Google Identity Services token model). The access token lives
// in memory only and is never stored. Google's token model has no refresh token, so after about
// an hour the app asks again silently, which needs no click when the browser still has a Google session.
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const GRANTED_KEY = 'life-tracker.granted';

export class AuthError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

let gisPromise = null;
export function loadGis() {
  if (globalThis.google?.accounts?.oauth2) return Promise.resolve(true);
  if (!gisPromise) {
    gisPromise = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve(true);
      s.onerror = () => {
        gisPromise = null;
        resolve(false);
      };
      document.head.appendChild(s);
    });
  }
  return gisPromise;
}

let client = null;
let clientKey = '';
let token = '';
let tokenExp = 0;
let waiter = null;

const granted = () => {
  try { return localStorage.getItem(GRANTED_KEY) === '1'; } catch { return false; }
};

function settle(ok, value) {
  const w = waiter;
  waiter = null;
  if (!w) return;
  if (ok) w.resolve(value);
  else w.reject(value);
}

function ensureClient(clientId) {
  if (client && clientKey === clientId) return client;
  client = globalThis.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPE,
    callback: (resp) => {
      if (resp.error) {
        settle(false, new AuthError(resp.error_description || resp.error, resp.error));
        return;
      }
      token = resp.access_token;
      tokenExp = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
      try { localStorage.setItem(GRANTED_KEY, '1'); } catch { /* private mode */ }
      settle(true, token);
    },
    error_callback: (err) => {
      settle(false, new AuthError(err?.message || 'Sign-in was closed or blocked by the browser', err?.type || 'popup'));
    },
  });
  clientKey = clientId;
  return client;
}

// Returns a valid access token. interactive: true may open Google's sign-in window, so call it
// from a click. Silent calls never open a window and fail with AuthError when Google needs a person.
export async function getToken({ clientId, interactive = false, force = false } = {}) {
  if (!force && token && Date.now() < tokenExp - 60_000) return token;
  if (!clientId) throw new AuthError('Enter your Google client ID in Settings first.', 'no_client_id');
  if (!(await loadGis())) throw new AuthError('Could not load Google sign-in. Check your connection.', 'no_script');
  if (waiter) return waiter.promise;
  const c = ensureClient(clientId);
  waiter = {};
  const pending = new Promise((resolve, reject) => {
    waiter.resolve = resolve;
    waiter.reject = reject;
  });
  waiter.promise = pending;
  const prompt = interactive ? (granted() ? '' : 'consent') : 'none';
  try {
    c.requestAccessToken({ prompt });
  } catch (err) {
    settle(false, new AuthError(String(err?.message || err), 'request'));
  }
  return pending;
}

export function hasGrant() {
  return granted();
}

export function signOut() {
  if (token && globalThis.google?.accounts?.oauth2) {
    globalThis.google.accounts.oauth2.revoke(token, () => {});
  }
  token = '';
  tokenExp = 0;
  try { localStorage.removeItem(GRANTED_KEY); } catch { /* private mode */ }
}
