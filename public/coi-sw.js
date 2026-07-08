// Cross-origin-isolation service worker for static hosts (GitHub Pages etc.)
// that cannot send COOP/COEP response headers themselves. OPFS-backed SQLite
// (sqlocal) requires crossOriginIsolated; this worker stamps the headers onto
// every same-scope response. Registered from index.html only when the page
// loads without isolation.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.status === 0) return res;
        const headers = new Headers(res.headers);
        headers.set('Cross-Origin-Opener-Policy', 'same-origin');
        headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
      })
      .catch((e) => new Response(String(e), { status: 502 })),
  );
});
