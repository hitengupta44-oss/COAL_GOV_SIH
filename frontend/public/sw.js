// Service worker for the Coal Mine Governance platform.
//
// Two jobs: keep the interface usable without a signal, and make sure a
// record written underground is not lost before it reaches the database.
//
// Coal mines are the case where offline support is not a nicety. An
// inspector standing at a district face has no connectivity, and that is
// exactly the moment a finding needs recording. Asking them to remember
// it until they resurface is how field observations get lost or
// reconstructed from memory hours later.

const VERSION = "v1";
const SHELL = `shell-${VERSION}`;
const DATA = `data-${VERSION}`;

// The pages a field user might open with no signal. Assets are cached as
// they are fetched rather than listed here, because Next.js fingerprints
// its chunk filenames on every build and a hardcoded list goes stale.
const SHELL_URLS = [
  "/",
  "/dashboard",
  "/dashboard/inspector",
  "/dashboard/worker",
  "/dashboard/manager",
  "/login",
  "/offline",
  "/manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL).then((c) =>
      // Individually, so one 404 does not fail the whole install.
      Promise.allSettled(SHELL_URLS.map((u) => c.add(u)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Never cache authentication or the backend API. A stale token check or
  // a cached "you have no alerts" would be worse than an honest failure.
  if (url.pathname.includes("/auth/") || url.hostname.endsWith("hf.space")) return;

  // Supabase reads: network first, fall back to the last good copy so a
  // dashboard still shows yesterday's compliance list rather than an
  // error page. The staleness is signalled in the interface.
  if (url.hostname.endsWith("supabase.co")) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(DATA).then((c) => c.put(request, copy));
          return res;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Everything else -- pages, scripts, styles, fonts, map tiles -- is
  // served from cache when present and fetched otherwise.
  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request)
        .then((res) => {
          if (res.ok && (url.origin === self.location.origin || url.hostname.includes("tile."))) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => {
          // A navigation with nothing cached gets a page explaining the
          // situation rather than the browser's dinosaur.
          if (request.mode === "navigate") return caches.match("/offline");
          return new Response("", { status: 504, statusText: "Offline" });
        });
    })
  );
});

// The app asks the worker to retry the queue once the browser reports a
// connection. The queue itself lives in IndexedDB on the page side --
// the worker only needs to prompt.
self.addEventListener("message", (event) => {
  if (event.data === "sync-queue") {
    self.clients.matchAll().then((cs) => cs.forEach((c) => c.postMessage("sync-queue")));
  }
});
