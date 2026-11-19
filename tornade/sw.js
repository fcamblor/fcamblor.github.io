// Service worker of the hosted PWA launcher (ADR 0003): serves the app files downloaded from the
// primary from Cache Storage (./app/<instance>/<build>/), and shows Web Push notifications.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

const APP = new URL("./app/", self.location).href;
// Forwards service worker events to the pages' device log (debug mode, devlog.js).
const devlog = (msg) =>
  self.clients.matchAll({ includeUncontrolled: true }).then((cs) => cs.forEach((c) => c.postMessage({ type: "devlog", msg })));
self.addEventListener("activate", () => devlog("service worker activated"));
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || !e.request.url.startsWith(APP)) return;
  const url = e.request.url.split(/[?#]/)[0];
  e.respondWith(
    caches.match(url).then((r) => {
      if (r) return r;
      devlog(`not in cache: ${url}`);
      return new Response(`not in cache: ${url}`, { status: 404 });
    })
  );
});

self.addEventListener("push", (e) => {
  if (!e.data) return;
  let msg;
  try { msg = e.data.json(); } catch { msg = { title: "Tornade", body: e.data.text() }; }
  e.waitUntil(self.registration.showNotification(msg.title ?? "Tornade", { body: msg.body, tag: msg.tag, icon: msg.icon ?? "icon-192.png", badge: msg.badge }));
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
