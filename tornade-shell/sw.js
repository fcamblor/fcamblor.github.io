// SPIKE (ADR 0003): shell service worker. Same push handling as frontend/pwa/sw.js, plus the app
// files downloaded from the primary, served from Cache Storage under ./app/<instance>/<build>/.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

const APP = new URL("./app/", self.location).href;
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || !e.request.url.startsWith(APP)) return;
  const url = e.request.url.split(/[?#]/)[0];
  e.respondWith(
    caches.match(url).then((r) => r ?? new Response(`not in cache: ${url}`, { status: 404 }))
  );
});

self.addEventListener("push", (e) => {
  if (!e.data) return;
  let msg;
  try { msg = e.data.json(); } catch { msg = { title: "Tornade", body: e.data.text() }; }
  e.waitUntil(self.registration.showNotification(msg.title ?? "Tornade", { body: msg.body, tag: msg.tag }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const home = new URL("./", self.location).href;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const c = list.find((c) => c.url.startsWith(home));
      return c ? c.focus() : self.clients.openWindow("./");
    })
  );
});
