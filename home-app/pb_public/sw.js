// Opens the app instantly and offline: the app files are served from this cache and
// refreshed in the background (a new version applies the next time the app opens).
// Task data never goes through here; it lives in data.js and PocketBase.
const CACHE = 'tasks-v1';
const SHELL = ['./', 'index.html', 'data.js', 'pocketbase.umd.js', 'manifest.webmanifest', 'icon-192.png', 'apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (/^\/(api|cal|_)\//.test(url.pathname)) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request)
      .then(res => { if (res.ok) cache.put(e.request, res.clone()); return res; })
      .catch(() => hit || Response.error());
    if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
    return fresh;
  }));
});
