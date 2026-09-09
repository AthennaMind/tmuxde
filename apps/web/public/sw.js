/*
 * The smallest service worker that does its two jobs and nothing else.
 *
 * Job one is installability: Chrome will not fire `beforeinstallprompt`
 * without a registered worker that has a fetch handler. Job two is an honest
 * offline navigation.
 *
 * What it deliberately does NOT do is cache the app shell. An earlier version
 * precached `/` and served it for every offline navigation, which failed three
 * ways at once: none of the `/_next/static` chunks that document references
 * were cached, so it rendered the server output of `(terminal)/layout.tsx` —
 * a loading spinner — and hung there forever; every route in scope got that
 * same document under the wrong URL; and because the cache name was a literal
 * no build step ever changed, the copy taken on a user's first visit was
 * pinned for the lifetime of the install.
 *
 * Precaching exactly one self-contained static page removes all three. It also
 * removes the need to version the cache from the build: `offline.html` refers
 * to nothing that changes between deploys, so a stale copy is still a correct
 * copy. Bump CACHE_NAME by hand if that page's contents ever change.
 */
const CACHE_NAME = "mtmux-offline-v2";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        // `cache: "reload"` so a refreshed page is picked up even when the HTTP
        // cache still holds the old one. Guarded on `ok` and wrapped, because
        // `cache.add` rejects on any non-2xx and a rejected `waitUntil` FAILS
        // THE INSTALL — one flaky first load would otherwise leave the user
        // with no worker at all, and so no install prompt, until they cleared
        // the site.
        const response = await fetch(OFFLINE_URL, { cache: "reload" });
        if (response.ok) await cache.put(OFFLINE_URL, response);
      } catch {
        // Offline on first load. The worker still activates; the fetch handler
        // falls through to a synthesized response until the next install.
      }
    })(),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Without this every navigation waits for the worker to boot before its
      // network request even starts — a round trip added to the hosted path in
      // exchange for a fallback that is only reached when the network is down.
      if (self.registration.navigationPreload) {
        try {
          await self.registration.navigationPreload.enable();
        } catch {
          // Not supported (Safari). The fetch below still works.
        }
      }
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  // Navigations only. Everything else — `/_next/*`, API calls, and above all
  // the `/_relay` WebSocket upgrade — goes straight to the network untouched.
  if (event.request.mode !== "navigate") return;

  event.respondWith(
    (async () => {
      try {
        const preloaded = await event.preloadResponse;
        if (preloaded) return preloaded;
        return await fetch(event.request);
      } catch {
        const cached = await caches.match(OFFLINE_URL);
        if (cached) return cached;
        return new Response(
          "<!doctype html><meta charset=utf-8><title>Offline</title><p>You're offline.",
          {
            status: 503,
            // Without an explicit type the browser sniffs, and may offer the
            // body as a download rather than rendering it.
            headers: { "Content-Type": "text/html; charset=utf-8" },
          },
        );
      }
    })(),
  );
});
