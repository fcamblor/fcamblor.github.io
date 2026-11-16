// Minimal service worker that enables PWA installation. No caching: the app follows
// Caching the shell only; cached instance state would be misleading offline.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});

// Web Push: display notifications received from the primary.
self.addEventListener("push", (e) => {
  if (!e.data) return;
  try {
    const { title, body, icon, badge, tag } = e.data.json();
    e.waitUntil(
      self.registration.showNotification(title, { body, icon, badge, tag, requireInteraction: true })
    );
  } catch {
    // Fallback: server sent plain text, not JSON.
    e.waitUntil(self.registration.showNotification("Tornade", { body: e.data.text() }));
  }
});

// User clicked a notification: focus or open the app window.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url === new URL("./", self.location).href && "focus" in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow("./");
      }
    })
  );
});
