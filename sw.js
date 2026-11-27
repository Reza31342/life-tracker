// Offline shell cache. Requests to the sheet script are cross-origin and never cached here.
const CACHE = 'life-tracker-v16';
const ASSETS = [
  './', './index.html', './styles.css', './manifest.webmanifest', './icon.svg',
  './app.js', './store.js', './schema.js', './bridge.js', './sync.js', './dates.js', './undo.js', './time.js',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's HTTP cache, so a new version never stores old files.
  const fresh = ASSETS.map((a) => new Request(a, { cache: 'reload' }));
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(fresh)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Network first, so each reload picks up the latest code; cache only when offline.
  // GitHub Pages lets browsers reuse files for 10 minutes; 'no-cache' asks the server each time
  // (a cheap "not modified" when nothing changed), so a refresh right after an update shows it.
  // Page loads keep their own request (a redirect must stay a redirect there).
  const req = e.request.mode === 'navigate'
    ? e.request
    : new Request(e.request.url, { cache: 'no-cache', credentials: 'same-origin' });
  e.respondWith(
    fetch(req)
      .then((res) => {
        // Copy before handing the response to the page: the page reads the body right away.
        if (res.ok) {
          const copy = res.clone();
          e.waitUntil(caches.open(CACHE).then((c) => c.put(e.request, copy)));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
