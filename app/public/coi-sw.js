// Service worker for hosts that cannot set response headers (GitHub Pages): adds
// the cross-origin isolation headers the multi-threaded solver needs. Registered
// only by the Pages build (src/platform/coi.ts). Every asset is same-origin, so
// other requests are left alone.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request).then((response) => {
      const headers = new Headers(response.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      headers.set('Cross-Origin-Resource-Policy', 'same-origin');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }),
  );
});
