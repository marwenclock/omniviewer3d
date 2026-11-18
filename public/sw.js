// OMNIVIEWER service worker: makes the app work offline after the first visit.
// Pages: network first (always fresh when online), cached copy when offline.
// Hashed assets, engines (libs/) and fonts: cache first, filled as they are used.
const VERSION = 'omniviewer-v1';
const SHELL = ['./', './manifest.webmanifest', './favicon.svg'];
const SHARE = 'omni-share';

// Files shared to the installed app (Android share sheet, manifest share_target): keep them in a cache for the
// Quick Convert page, which reads and deletes them on load. They never leave the device.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'POST' || !url.pathname.endsWith('/convert/') || !url.searchParams.has('share')) return;
  e.respondWith((async () => {
    try {
      const form = await e.request.formData();
      const cache = await caches.open(SHARE);
      const files = form.getAll('files').filter((f) => typeof f === 'object');
      await Promise.all(files.map((f, i) => cache.put(new Request(`${url.origin}/__shared/${Date.now()}-${i}/${encodeURIComponent(f.name || 'model')}`), new Response(f))));
    } catch (err) { /* fall through to the page */ }
    return Response.redirect(url.pathname + '?shared=1', 303);
  })());
});

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== SHARE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (!sameOrigin && !isFont) return; // models from other sites are never cached

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req).then((r) => r || caches.match('./'))),
    );
    return;
  }

  if (isFont || url.pathname.includes('/assets/') || url.pathname.includes('/libs/') || /\.(svg|webmanifest|png)$/.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok || res.type === 'opaque') {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      })),
    );
  }
});
