// Offline fallback for the GitHub-Pages copy of the T&C Power Interface.
//
// The tool controls a LOCAL operator (the generator server on this machine, :8010). If the internet
// drops, the remote Pages page can't load at all — a browser error, with the perfectly healthy local
// operator one click away. This worker pre-caches ONE self-contained styled page (offline.html) and
// serves it ONLY when a top-level NAVIGATION request fails. It deliberately never caches the app
// shell, /api, or /ws: a cached SPA shell goes stale after deploys (the operator's own server has the
// same "never cache index.html" rule), and API/WebSocket traffic must always be live.
//
// SHARED-ORIGIN SAFETY: this app and the FLIR tool are both served from mattlmccoy.github.io under
// different paths, and CacheStorage is shared per-ORIGIN (not per-scope). So the activate cleanup
// must delete only OUR OWN caches (the CACHE_PREFIX), never every non-matching cache — a bare
// `k !== CACHE` filter deleted the FLIR tool's offline cache (and FLIR's deleted ours), so whichever
// tool was opened last left the other with no offline page.
const CACHE_PREFIX = "tcp-offline-";
const CACHE = CACHE_PREFIX + "v2";
const OFFLINE_URL = new URL("offline.html", self.registration.scope).href;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.add(OFFLINE_URL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  // Drop only OUR OWN older caches (CACHE_PREFIX), never another app's on this shared origin.
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return; // page loads only — never assets, /api, or /ws
  event.respondWith(
    fetch(event.request).catch(() =>
      caches.match(OFFLINE_URL).then((cached) => cached ?? Response.error()),
    ),
  );
});
