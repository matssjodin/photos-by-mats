/* Sjodin Photos service worker: offline app shell, immutable asset caching,
 * and the Android share-target upload bridge. API requests are never cached. */
const CACHE = "sjodin-photos-v2";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })()
  );
});

async function handleShareTarget(request) {
  try {
    const form = await request.formData();
    const photos = form.getAll("photos").filter((entry) => typeof entry !== "string");
    if (!photos.length) return Response.redirect("/", 303);
    const upload = new FormData();
    for (const photo of photos) upload.append("photos", photo);
    const response = await fetch("/api/assets", { method: "POST", body: upload });
    return Response.redirect(response.ok ? "/?shared=1" : "/?shared=0", 303);
  } catch {
    return Response.redirect("/?shared=0", 303);
  }
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.method === "POST" && url.pathname === "/share-target") {
    event.respondWith(handleShareTarget(event.request));
    return;
  }
  if (event.request.method !== "GET") return;
  if (url.pathname.startsWith("/api/")) return;

  // Vite build assets carry content hashes in their names: cache-first forever.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(event.request);
        if (cached) return cached;
        const response = await fetch(event.request);
        if (response.ok) cache.put(event.request, response.clone());
        return response;
      })()
    );
    return;
  }

  // App navigations: network-first so deploys land, cached shell when offline.
  if (event.request.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const response = await fetch(event.request);
          if (response.ok) cache.put("/", response.clone());
          return response;
        } catch {
          const cached = await cache.match("/");
          return cached ?? Response.error();
        }
      })()
    );
  }
});
