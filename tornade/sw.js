// Minimal service worker that enables PWA installation. No caching: the app follows
// Caching the shell only; cached instance state would be misleading offline.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
